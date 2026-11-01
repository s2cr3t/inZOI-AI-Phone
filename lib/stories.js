'use strict';
// A story of their own for each family member the played character texts: a goal, a secret, some
// trouble or a surprise of the contact's, that unfolds over a few game days through the chat.
//
// One LLM call makes an arc when there is none: what is really going on (only the contact knows),
// three or four stages, each with what the contact lets show in texts and what moves it on, and a
// good and a bad ending. From then on no extra calls: the reply and proactive prompts carry the
// story (block), and the answer's "story" field says when an exchange moved it on or settled it
// (fromReply). The world does not wait for the player: two game days without a move and the story
// moves on by itself, and past its last day it ends badly (tick). An ending is kept as a memory
// fact; a new story starts a game day later.
//
// data/stories/<playerId>-<partnerId>.json: { v, active, ended: [...], nextFrom }
const path = require('path');
const fsx = require('./fsx');
const persona = require('./persona');

const V = 1;
const KINDS = ['目标', '秘密', '麻烦', '惊喜'];
const ENDED_KEEP = 12;
const LOG_KEEP = 12;
// A story moves on at most this often from replies, so one chatty minute does not race through it.
const MOVE_GAP_MS = 8 * 60000;
// Arcs are made one at a time, and not again soon after a failed attempt.
const MAKE_RETRY_MS = 10 * 60000;
// The just-ended story stays in the prompt this many game days, so the contact can bring it up.
const RECENT_DAYS = 2;

function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clean(s, max) {
    return String(typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function dayOf(env) {
    return env && typeof env.day === 'number' ? env.day : null;
}

// The arc the model wrote, checked; null when it cannot be used.
function cleanArc(raw, day) {
    if (!isObject(raw)) return null;
    const beats = (Array.isArray(raw.beats) ? raw.beats : [])
        .map((b) => isObject(b) ? { show: clean(b.show, 160), next: clean(b.next, 120) } : null)
        .filter((b) => b && b.show && b.next)
        .slice(0, 4);
    const title = clean(raw.title, 24);
    const premise = clean(raw.premise, 200);
    if (beats.length < 2 || !title || !premise) return null;
    const days = Math.max(2, Math.min(6, Math.round(Number(raw.days) || 4)));
    return {
        id: 's' + Date.now().toString(36),
        title,
        kind: KINDS.indexOf(raw.kind) >= 0 ? raw.kind : '目标',
        premise,
        want: clean(raw.want, 120),
        beats,
        good: clean(raw.good, 120),
        bad: clean(raw.bad, 120),
        stage: 0,
        startedDay: day,
        lastMoveDay: day,
        endsBy: day === null ? null : day + days,
        movedAt: 0,
        log: []
    };
}

class Stories {
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.dir = '';
        this.making = null;
        this.madeFailAt = 0;
    }

    get cfg() {
        return this.d.cfg.stories;
    }

    configure(dataDir) {
        this.dir = path.join(dataDir, 'stories');
        fsx.ensureDir(this.dir);
    }

    file(key) {
        return path.join(this.dir, key + '.json');
    }

    load(key) {
        const r = fsx.readJson(this.file(key));
        const v = r.ok && isObject(r.value) && r.value.v === V ? r.value : {};
        return {
            v: V,
            active: isObject(v.active) && Array.isArray(v.active.beats) ? v.active : null,
            ended: Array.isArray(v.ended) ? v.ended.filter(isObject).slice(-ENDED_KEEP) : [],
            nextFrom: typeof v.nextFrom === 'number' ? v.nextFrom : null
        };
    }

    save(key, s) {
        try {
            fsx.writeJson(this.file(key), s, true);
        } catch (e) {
            this.log.warn('stories [' + key + '] not saved: ' + e.message);
        }
    }

    // Every pair's file, for bridge.js stories.
    all() {
        let names = [];
        try { names = require('fs').readdirSync(this.dir); } catch (e) { return []; }
        return names.filter((n) => /^\d+-\d+\.json$/.test(n)).map((n) => {
            const key = n.slice(0, -5);
            return Object.assign({ key }, this.load(key));
        });
    }

    clearAll() {
        let names = [];
        try { names = require('fs').readdirSync(this.dir); } catch (e) { return 0; }
        let n = 0;
        for (const name of names) {
            if (!/\.json$/.test(name)) continue;
            try { require('fs').unlinkSync(path.join(this.dir, name)); n += 1; } catch (e) { /* in use */ }
        }
        return n;
    }

    // ------------------------------------------------------------ the prompt
    // The 【你自己的心事】 block for the reply and proactive prompts, or ''.
    block(pair, snap) {
        if (!this.cfg.enabled) return '';
        const s = this.load(pair.key);
        const t = persona.terms(snap);
        const day = dayOf(snap.env);
        const lines = [];
        const a = s.active;
        if (a) {
            const beat = a.beats[Math.min(a.stage, a.beats.length - 1)];
            lines.push('【你自己的心事】（只有你知道，' + t.call + '不知道。是你自己生活里的事，聊天时按你的性格自然流露）');
            lines.push('这件事：「' + a.title + '」（' + a.kind + '）。真实情况：' + a.premise);
            if (a.want) lines.push('你心里希望：' + a.want);
            lines.push('现在是第 ' + (a.stage + 1) + ' 段，共 ' + a.beats.length + ' 段。这一段你会：' + beat.show);
            lines.push('等到这件事发生，才进入下一段：' + beat.next);
            if (a.log.length) lines.push('之前已经发生的：' + a.log.slice(-4).map((x) => x.text).join('；'));
            if (day !== null && a.endsBy !== null) {
                const left = a.endsBy - day;
                lines.push(left > 0 ? '大约还有 ' + left + ' 天就会有结果。' : '今天就会有结果。');
            }
            if (a.bad) lines.push('要是一直没人发现、没人帮：' + a.bad);
            lines.push('怎么说：藏着、暗示、憋不住说漏嘴，都按你这个人来。' + t.call + '没问就别一下子全说出来，问到了才多说一点；' +
                '不要每条消息都提，大约三四次聊天里带出来一次就够；' + t.call + '在说别的急事时先别提。' +
                '能在游戏里做的（练琴、看书、出门、找人），可以真的写进 actions 去做。');
        }
        const recent = s.ended.slice(-1)[0];
        if (recent && day !== null && typeof recent.endedDay === 'number' && day - recent.endedDay <= RECENT_DAYS) {
            lines.push('最近了结的心事：「' + recent.title + '」，' + (recent.good ? '结果挺好：' : '结果不太好：') + clean(recent.outcome, 120) +
                '。想起来可以提，' + t.call + '帮过你的就记着。');
        }
        return lines.join('\n');
    }

    // Rule for the answer's "story" field, or '' without a story.
    rule(pair) {
        if (!this.cfg.enabled || !this.load(pair.key).active) return '';
        return '10c. story：只有【你自己的心事】里「等到这件事发生，才进入下一段」那一条真的发生了（看对方这次说了什么、做了什么，或者游戏里真的发生的事），才写 {"step":"next","why":"发生了什么"}；' +
            '你自己透露了、暗示了这一段的事不算，那只是这一段在进行。事情这次有了结果，写 {"step":"end","good":true 或 false,"why":"结果是怎样"}；否则 {"step":"stay"}。多数时候是 stay。';
    }

    // ------------------------------------------------------------ moving it on
    fromReply(pair, snap, raw) {
        if (!this.cfg.enabled || !isObject(raw)) return;
        const step = raw.step === 'next' || raw.step === 'end' ? raw.step : '';
        if (!step) return;
        const s = this.load(pair.key);
        const a = s.active;
        if (!a) return;
        const day = dayOf(snap.env);
        const why = clean(raw.why, 120);
        if (step === 'end') {
            this.end(pair, s, raw.good === true, why || (raw.good === true ? a.good : a.bad), day, 'in the chat');
            return;
        }
        if (Date.now() - (a.movedAt || 0) < MOVE_GAP_MS) {
            this.log.info('stories [' + pair.key + '] "' + a.title + '": the reply moved it on again too soon, kept at stage ' + (a.stage + 1));
            return;
        }
        this.advance(pair, s, why || a.beats[a.stage].next, day, 'in the chat');
    }

    advance(pair, s, text, day, how) {
        const a = s.active;
        a.log.push({ day, text: clean(text, 120), how });
        a.log = a.log.slice(-LOG_KEEP);
        a.movedAt = Date.now();
        a.lastMoveDay = day;
        if (a.stage + 1 >= a.beats.length) {
            // Past the last stage: it has come to a head. Moved on by the player it went well.
            this.end(pair, s, how === 'in the chat', text, day, how);
            return;
        }
        a.stage += 1;
        this.log.info('stories [' + pair.key + '] "' + a.title + '" moved to stage ' + (a.stage + 1) + '/' + a.beats.length + ' (' + how + '): ' + clean(text, 80));
        this.save(pair.key, s);
    }

    end(pair, s, good, outcome, day, how) {
        const a = s.active;
        const done = { id: a.id, title: a.title, kind: a.kind, good: !!good, outcome: clean(outcome, 160), startedDay: a.startedDay, endedDay: day, how };
        s.ended.push(done);
        s.ended = s.ended.slice(-ENDED_KEEP);
        s.active = null;
        s.nextFrom = day === null ? null : day + this.cfg.gap_days;
        this.save(pair.key, s);
        this.log.info('stories [' + pair.key + '] "' + a.title + '" ended ' + (good ? 'well' : 'badly') + ' (' + how + '): ' + done.outcome);
        const fact = clean(a.title + '：' + (good ? '有了好结果，' : '结果不太好，') + done.outcome, 80);
        try {
            this.d.memory.addFacts(pair.playerId, pair.partnerId, [fact], day);
        } catch (e) {
            this.log.warn('stories [' + pair.key + '] ending not remembered: ' + e.message);
        }
    }

    // The contact grew up (legacy.js): a story made for the child they were ends gently, and one
    // for their new age may start at once.
    grewUp(partnerId, from, to, day) {
        for (const s of this.all()) {
            if (!s.key.endsWith('-' + partnerId)) continue;
            const pair = { key: s.key, playerId: s.key.split('-')[0], partnerId: String(partnerId) };
            if (s.active) {
                this.end(pair, s, true, '长大了，这件事慢慢就过去了，想起来还会笑', day, 'grew up');
            }
            const now = this.load(s.key);
            now.nextFrom = day;
            this.save(s.key, now);
        }
    }

    // The contact died (legacy.js): their stories stop where they were.
    passedAway(partnerId, day, name) {
        for (const s of this.all()) {
            if (!s.key.endsWith('-' + partnerId) || !s.active) continue;
            const pair = { key: s.key, playerId: s.key.split('-')[0], partnerId: String(partnerId) };
            this.end(pair, s, false, (name || '他/她') + '走了，这件事没来得及有结果', day, 'died');
            const now = this.load(s.key);
            now.nextFrom = null;
            this.save(s.key, now);
        }
    }

    // Called with the game day for every pair the tracker sees. No LLM.
    tick(pair, env) {
        if (!this.cfg.enabled) return;
        const day = dayOf(env);
        if (day === null) return;
        const s = this.load(pair.key);
        const a = s.active;
        if (!a) return;
        if (a.startedDay === null) {
            // Made before the game day was known.
            a.startedDay = day;
            a.lastMoveDay = day;
            a.endsBy = day + 4;
            this.save(pair.key, s);
            return;
        }
        if (a.endsBy !== null && day > a.endsBy) {
            this.end(pair, s, false, a.bad || '时间过去了，事情没等到帮忙', day, 'ran out of days');
            // Nobody noticed: that stings a little (ties.js).
            if (this.d.ties) this.d.ties.storyMissed(pair, a.title, day);
        } else if (typeof a.lastMoveDay === 'number' && day - a.lastMoveDay >= this.cfg.drift_days) {
            // What the stage showed, not what would have moved it on: that never happened.
            this.advance(pair, s, '这一段没人察觉，事情自己往下走了（那时：' + clean(a.beats[a.stage].show, 60) + '）', day, 'by itself');
        }
    }

    // ------------------------------------------------------------ making a new one
    // Starts making a story for the pair when it has none and the gap after the last one is over.
    // Never waits for it; the next reply sees it.
    ensure(pair, snap) {
        if (!this.cfg.enabled || this.making || !this.d.llm || !this.d.llm.configured) return;
        if (Date.now() - this.madeFailAt < MAKE_RETRY_MS) return;
        const day = dayOf(snap.env);
        if (day === null) return;
        const s = this.load(pair.key);
        if (s.active || (s.nextFrom !== null && day < s.nextFrom)) return;
        this.making = this.make(pair, snap, s, day).then(() => {
            this.making = null;
        }, (e) => {
            this.making = null;
            this.madeFailAt = Date.now();
            this.log.warn('stories [' + pair.key + '] could not make a story: ' + (e && e.message || e));
        });
    }

    async make(pair, snap, s, day) {
        const p = this.prompt(pair, snap, s);
        this.log.debug('stories prompt:\n' + p.system + '\n' + p.user);
        const raw = await this.d.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0.95, max_tokens: 900, purpose: 'stories' });
        const arc = cleanArc(raw, day);
        if (!arc) throw new Error('the model did not write a usable arc');
        const now = this.load(pair.key);
        if (now.active) return;
        now.active = arc;
        this.save(pair.key, now);
        this.log.info('stories [' + pair.key + '] new for ' + snap.partner.name + ': "' + arc.title + '" (' + arc.kind + ', ' + arc.beats.length +
            ' stages, by day ' + arc.endsBy + '): ' + arc.premise);
    }

    prompt(pair, snap, s) {
        const t = persona.terms(snap);
        const mem = this.d.memory.load(pair.playerId, pair.partnerId);
        const facts = mem.facts.slice(-15).map((f) => '- ' + f.text).join('\n');
        const past = s.ended.slice(-6).map((e) => '「' + e.title + '」').join('、');
        const minor = persona.isMinorGroup(snap.partner.ageGroup);
        const gone = this.d.legacy ? this.d.legacy.storyLines(pair) : [];
        const system = [
            '你给一个生活模拟游戏里的角色写一段属于他/她自己的小故事线，接下来几天会通过角色和' + t.call + '的微信聊天慢慢展开。',
            '要求：',
            '1. 是这个人自己生活里的事：一个想实现的目标、一个藏着的秘密、一个遇到的麻烦，或者在给' + t.call + '准备的惊喜。小而具体，几天之内能有结果。',
            '2. 合乎这个人的年龄、性格、喜好、学校或工作，以及下面记得的事。只用普通生活里有的东西：家、学校、公司、公园、图书馆、朋友、爱好、比赛、钱、身体、家务。' +
                '不要超自然，不要犯罪，不要生病住院、死亡这类大事。' + (minor ? '这是小孩：不写恋爱，不写危险的事。' : ''),
            '3. ' + t.call + '能参与：注意到、问起、帮忙、鼓励、批评，都会让事情不一样；没人管，事情也会自己往坏处走一点。',
            '4. beats 写 3 到 4 段，从隐约的迹象开始，越来越明显，最后一段到达关键时刻。每段 show 写这一段角色在聊天里会透露或表现出什么（不是剧情旁白）；next 写发生了什么才进入下一段（' + t.call + '做了什么，或者事情自己有了什么变化）。',
            '5. 和以前的故事不重样' + (past ? '：' + past : '') + '。',
            gone.length ? '6. 家里以前的人（已经去世），可以但不一定要用进故事里，比如找到他们留下的东西、想学他们拿手的事、在他们的忌日想做点什么：' + gone.join('；') + '。' : '',
            '只输出 JSON：{"title":"不超过十个字","kind":"目标|秘密|麻烦|惊喜","premise":"真实情况，只有角色自己知道","want":"角色心里希望' + t.call + '怎样（可以是希望别发现）",' +
                '"beats":[{"show":"","next":""}],"good":"好结局","bad":"没人帮或搞砸时的结局","days":3}'
        ].join('\n');
        const user = [
            persona.personaBlock(snap, this.d.cfg),
            // 年龄、职业、家里的成员和感情值现在单独一块（为了系统提示词的缓存），这里照旧拼上。
            persona.factsBlock(snap, this.d.cfg),
            '',
            '你此刻：' + persona.activityText(snap.partner.activity) + '。' + persona.workText(snap.partner.work, snap.partner.ageGroup) + '。',
            facts ? '记得的事：\n' + facts : '',
            '',
            '写一段新的故事线。只输出 JSON。'
        ].join('\n');
        return { system, user };
    }
}

module.exports = { Stories, cleanArc };
