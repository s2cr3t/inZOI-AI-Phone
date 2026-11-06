'use strict';
// How each colleague sees the player at work (an impression score), and what kind of boss each
// one is (a style). Both feed the boss's and the colleagues' replies, and the phone's OA shows them.
//
// The impression is 0-100 per (player, colleague). It starts from the game's own Business bond
// the colleague has with the player, and then moves with what happens:
//   chat      the reply's felt (-2..2), weighed by the colleague's style
//   OA        a granted request costs a little goodwill, a faked sickness a lot, asking for a
//             promotion the rules do not allow a little (career.js calls onDecision)
//   absence   the game's count of unexcused absences went up: the boss minds (watch)
// The style is one of STYLES, fixed per colleague the first time it is needed.
//
// data/workplace.json (this module only): { v, styles: { <colleague>: style },
//   byPair: { <player>-<colleague>: { score, events: [{ at, day, delta, why }] } }, absent: { <player>: n } }
// <phone>/oa/impressions.cfg (this module only): what the phone shows,
//   { v, at, byPair: { <player>-<colleague>: { score, label, style, styleName, events } } }
const path = require('path');
const fsx = require('./fsx');

const V = 1;
const EVENTS_KEEP = 8;
const EVENTS_SHOWN = 3;
const START_MIN = 25;
const START_MAX = 75;
const ABSENCE_DELTA = -8;

// chat: how much one felt level moves the score; absence: how much more an absence weighs.
const STYLES = {
    strict: {
        name: '严厉型', chat: 2, absence: 2,
        text: '你是严厉型的上级：看重规矩、出勤和结果，说话直接，不爱听客套和奉承。批假前会追问理由，晋升只看硬指标；对方守规矩、肯干，你嘴上不说，心里有数。'
    },
    easygoing: {
        name: '佛系型', chat: 3, absence: 1,
        text: '你是佛系型的上级：好说话，能批就批，不爱管细节，也不爱开会训人；可真到要拍板、要替下属出头的时候，你也不太愿意担责任。'
    },
    blamer: {
        name: '甩锅型', chat: 3, absence: 1.5,
        text: '你是甩锅型的上级：表面客气，出了问题先找别人的原因，功劳喜欢记在自己身上。批事情爱留余地，说话常带「这事你自己看着办」「到时候别说我没提醒你」。'
    },
    promiser: {
        name: '画饼型', chat: 4, absence: 1,
        text: '你是画饼型的上级：嘴上总说看好对方、「好好干，机会肯定有」，批假还算爽快；可一谈到晋升、加薪，你就爱往后拖，说再看看、等明年。'
    },
    mentor: {
        name: '导师型', chat: 3, absence: 1.5,
        text: '你是导师型的上级：愿意带人，会给具体的建议，对上进的人格外照顾，也会直说对方哪里做得不够；最看不惯偷懒和敷衍。'
    }
};
const STYLE_IDS = Object.keys(STYLES);
const LABELS = [[80, '很赏识你'], [65, '印象不错'], [45, '印象一般'], [30, '有点看法'], [0, '很不满意']];

function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clamp(n) {
    return Math.max(0, Math.min(100, Math.round(n)));
}

function labelOf(score) {
    for (const [min, text] of LABELS) if (score >= min) return text;
    return LABELS[LABELS.length - 1][1];
}

// The same colleague always gets the same style, without a call to the game or the model.
function styleFor(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return STYLE_IDS[h % STYLE_IDS.length];
}

class Workplace {
    constructor(daemon) {
        this.d = daemon;
        this.log = daemon.log;
        this.file = '';
        this.boardFile = '';
        this.data = { v: V, styles: {}, byPair: {}, absent: {} };
    }

    configure(dataDir, phoneDir) {
        this.file = path.join(dataDir, 'workplace.json');
        this.boardFile = path.join(phoneDir, 'oa', 'impressions.cfg');
        const r = fsx.readJson(this.file);
        const v = r.ok && isObject(r.value) && r.value.v === V ? r.value : {};
        this.data = {
            v: V,
            styles: isObject(v.styles) ? v.styles : {},
            byPair: isObject(v.byPair) ? v.byPair : {},
            absent: isObject(v.absent) ? v.absent : {}
        };
    }

    save() {
        try {
            fsx.writeJson(this.file, this.data, true);
        } catch (e) {
            this.log.warn('workplace: not saved: ' + e.message);
        }
        this.publish();
    }

    style(colleagueId) {
        const id = String(colleagueId);
        if (!STYLES[this.data.styles[id]]) {
            this.data.styles[id] = styleFor(id);
            this.save();
        }
        return this.data.styles[id];
    }

    // The pair's entry, made from the game's Business bond the first time.
    async entry(playerId, colleagueId) {
        const key = String(playerId) + '-' + String(colleagueId);
        if (isObject(this.data.byPair[key])) return this.data.byPair[key];
        const rel = await this.d.game.soft('relationships_get_value_between', { owner_id: String(colleagueId), target_id: String(playerId) });
        const business = rel && rel.stats && rel.stats.Business && typeof rel.stats.Business.value === 'number' ? rel.stats.Business.value : 0;
        const e = { score: Math.max(START_MIN, Math.min(START_MAX, Math.round(45 + business * 0.3))), events: [] };
        this.data.byPair[key] = e;
        this.save();
        return e;
    }

    score(playerId, colleagueId) {
        const e = this.data.byPair[String(playerId) + '-' + String(colleagueId)];
        return isObject(e) ? e.score : null;
    }

    // name: the colleague's name when the caller has it, for the line in the chat.
    async change(playerId, colleagueId, delta, why, day, name) {
        const d = Math.round(delta);
        if (!d) return;
        const e = await this.entry(playerId, colleagueId);
        const before = e.score;
        e.score = clamp(e.score + d);
        e.events = (Array.isArray(e.events) ? e.events : []).concat([{ at: Date.now(), day: typeof day === 'number' ? day : null, delta: d, why: String(why || '').slice(0, 40) }]).slice(-EVENTS_KEEP);
        this.save();
        this.log.info('workplace: ' + colleagueId + ' on ' + playerId + ' ' + (d > 0 ? '+' : '') + d + ' -> ' + e.score + ' (' + why + ')');
        // The chat with that colleague says so (daemon.impressionNotice), once the score moved.
        if (e.score !== before && typeof this.d.impressionNotice === 'function') {
            try {
                this.d.impressionNotice(String(playerId), String(colleagueId), e.score - before, e.score, labelOf(e.score), String(why || ''), name || '');
            } catch (err) {
                this.log.warn('workplace: notice not written: ' + err.message);
            }
        }
    }

    // The colleague's view of the player, for their reply prompt: { rule } or '' when the contact
    // does not work with the player. role: 'boss' or 'colleague'.
    async rule(pair, call, desk) {
        if (!pair.outsider || !desk) return '';
        const id = String(pair.partnerId);
        const boss = desk.bossId === id;
        if (!boss && desk.team.indexOf(id) < 0) return '';
        const e = await this.entry(pair.playerId, id);
        const lines = [];
        if (boss) {
            const st = STYLES[this.style(id)];
            lines.push('【你和' + call + '在公司】你是' + call + '的直属上级。' + st.text);
        } else {
            lines.push('【你和' + call + '在公司】你们是同一家公司的同事。');
        }
        lines.push('  你对' + call + '的印象：' + e.score + ' 分（满分 100），' + labelOf(e.score) + '。' + this.recentText(e));
        if (boss) {
            lines.push('  印象会影响你怎么回：低于 40 分，你对' + call + '的请求多半不耐烦、要刁难或者不批；高于 70 分，你愿意通融、替' + call + '说话。' +
                '说话方式按你的性格来，但别把分数、性格类型这些说出口。');
        } else {
            lines.push('  印象决定你愿不愿意帮' + call + '、跟' + call + '说多少公司里的事。别把分数说出口。');
        }
        return lines.join('\n');
    }

    recentText(e) {
        const ev = (Array.isArray(e.events) ? e.events : []).slice(-EVENTS_SHOWN);
        if (!ev.length) return '';
        return '最近：' + ev.map((x) => x.why + '（' + (x.delta > 0 ? '+' : '') + x.delta + '）').join('；') + '。';
    }

    // A reply in a chat with a colleague: how the player's words made them feel.
    fromFelt(pair, snap, felt) {
        const level = isObject(felt) ? Math.round(Number(felt.level)) : 0;
        if (!level || !isFinite(level)) return Promise.resolve();
        const st = STYLES[this.style(pair.partnerId)];
        const why = isObject(felt) && typeof felt.why === 'string' && felt.why.trim() ? felt.why.trim() : (level > 0 ? '聊得愉快' : '聊得不愉快');
        // A strict boss is moved less by nice words than by a slight.
        const w = level > 0 ? st.chat : Math.max(st.chat, 3);
        return this.change(pair.playerId, pair.partnerId, level * w, why, snap && snap.env && snap.env.day, snap && snap.partner && snap.partner.name);
    }

    // An OA request the boss decided (career.js). kind as in career.js; status approved | rejected.
    onDecision(playerId, bossId, kind, status, judged, day) {
        let delta = 0;
        let why = '';
        if (status === 'approved' && (kind === 'leave' || kind === 'sick' || kind === 'remote')) {
            delta = -1;
            why = '批了一次' + ({ leave: '假', sick: '病假', remote: '远程' })[kind];
        } else if (status === 'rejected' && kind === 'sick' && judged && !judged.ok) {
            delta = -6;
            why = '装病请假被看穿';
        } else if (status === 'rejected' && kind === 'promote' && judged && !judged.ok) {
            delta = -2;
            why = '条件不够就来要晋升';
        } else if (status === 'approved' && kind === 'promote') {
            delta = 3;
            why = '升职了，算是认可';
        }
        return delta ? this.change(playerId, bossId, delta, why, day) : Promise.resolve();
    }

    // The game counts unexcused absences per member; a new one costs the boss's goodwill.
    async watch(playerId, desk, day) {
        if (!desk || !desk.bossId) return;
        const id = String(playerId);
        const before = this.data.absent[id];
        this.data.absent[id] = desk.unexcused;
        if (typeof before !== 'number') {
            this.save();
            return;
        }
        if (desk.unexcused > before) {
            const st = STYLES[this.style(desk.bossId)];
            await this.change(id, desk.bossId, ABSENCE_DELTA * st.absence * (desk.unexcused - before), '无故旷工', day);
        } else if (desk.unexcused !== before) {
            this.save();
        }
    }

    // What the phone's OA shows.
    publish() {
        if (!this.boardFile) return;
        const byPair = {};
        for (const key of Object.keys(this.data.byPair)) {
            const e = this.data.byPair[key];
            if (!isObject(e)) continue;
            const colleague = key.split('-')[1];
            const style = this.data.styles[colleague];
            byPair[key] = {
                score: e.score, label: labelOf(e.score),
                style: style || '', styleName: STYLES[style] ? STYLES[style].name : '',
                events: (Array.isArray(e.events) ? e.events : []).slice(-EVENTS_SHOWN)
            };
        }
        try {
            fsx.ensureDir(path.dirname(this.boardFile));
            fsx.writeJson(this.boardFile, { v: V, at: Date.now(), byPair }, true);
        } catch (e) {
            this.log.warn('workplace: board not written: ' + e.message);
        }
    }
}

module.exports = { Workplace, STYLES, labelOf, styleFor };
