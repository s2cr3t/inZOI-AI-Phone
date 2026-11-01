'use strict';
// How the people of a household feel about each other, the played character included, and the
// specific things they hold against each other. realism.js keeps one number for how the player
// has treated a contact lately, which mends within the hour; this keeps what lasts:
//   warmth    -10..10 per direction (holder -> target), drifting back to 0 by a point a game day
//   grudges   "疙瘩": what it is about, a weight 1..3, when it started; a weight fades by one every
//             fade_days game days, and is eased by an apology, a kind act or the player's help
//
// Where they come from:
//   the game        chronicle events between members (chronicle.js): a quarrel gives the target a
//                   grudge against the one who started it; making up eases it; praise, affection
//                   and care warm and soften the light ones; a turned-down approach stings
//   the chat        the reply's felt: -2 leaves a grudge against the player, +2 eases one; the
//                   answer's "ties" field settles a grudge the exchange really eased
//   friction        someone kept using what the contact wanted (actions' taken)
//   stories         a contact's own story that ran out because the player never noticed
//
// What the contact is told (block): the grudges they hold against the player (they are cooler
// until it is made right), how they feel about each other family member and why (they may tell
// on them, praise them, ask the player to help), and who has been cold to them lately (they sense
// it, not why). The ids let the answer settle them.
//
// data/ties.json: { v, ties: { "<holder>><target>": { warmth, at, grudges: [...] } }, seq, day }
const path = require('path');
const fsx = require('./fsx');

const V = 1;
const WARMTH_MAX = 10;
const GRUDGES_KEEP = 6;
const SHOWN = 3;
// A chronicle event moves warmth by this much (holder's view of the actor).
const KIND_WARMTH = { conflict: -3, rejected: -1, makeup: 2, praise: 1, affection: 1, care: 2, play: 1, deep: 1, outing: 1 };
const WEIGHT_TEXT = { 1: '有点不痛快', 2: '挺生气的', 3: '很受伤，还没消气' };

function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clean(s, max) {
    return String(typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clamp(n) {
    return Math.max(-WARMTH_MAX, Math.min(WARMTH_MAX, n));
}

class Ties {
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.file = '';
        this.data = { v: V, ties: {}, seq: 0, day: null };
        this.saveTimer = null;
    }

    get cfg() {
        return this.d.cfg.ties;
    }

    configure(dataDir) {
        if (this.file) return;
        this.file = path.join(dataDir, 'ties.json');
        const r = fsx.readJson(this.file);
        if (r.ok && isObject(r.value) && r.value.v === V) {
            this.data.ties = isObject(r.value.ties) ? r.value.ties : {};
            this.data.seq = Number(r.value.seq) || 0;
            this.data.day = typeof r.value.day === 'number' ? r.value.day : null;
        }
    }

    // Written a moment later, so a burst of events is one write.
    save() {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.saveNow();
        }, 500);
        if (this.saveTimer.unref) this.saveTimer.unref();
    }

    saveNow() {
        try {
            fsx.writeJson(this.file, this.data, true);
        } catch (e) {
            this.log.warn('ties: not saved: ' + e.message);
        }
    }

    tie(holder, target) {
        const k = String(holder) + '>' + String(target);
        let t = this.data.ties[k];
        if (!isObject(t)) t = this.data.ties[k] = { warmth: 0, at: 0, grudges: [] };
        if (!Array.isArray(t.grudges)) t.grudges = [];
        return t;
    }

    open(holder, target) {
        const t = this.data.ties[String(holder) + '>' + String(target)];
        return t && Array.isArray(t.grudges) ? t.grudges.filter((g) => g.weight > 0) : [];
    }

    // ------------------------------------------------------------ changes
    warm(holder, target, points, why) {
        if (!points || String(holder) === String(target)) return;
        const t = this.tie(holder, target);
        t.warmth = clamp((Number(t.warmth) || 0) + points);
        t.at = Date.now();
        this.save();
        this.log.debug('ties ' + holder + '>' + target + ' warmth ' + (points > 0 ? '+' : '') + points + ' (' + why + ') -> ' + t.warmth);
    }

    grudge(holder, target, about, weight, day, source) {
        if (!this.cfg.enabled || String(holder) === String(target)) return null;
        const t = this.tie(holder, target);
        const text = clean(about, 60);
        if (!text) return null;
        // The same thing again weighs more, it is not a second grudge.
        const same = t.grudges.find((g) => g.weight > 0 && g.about === text);
        if (same) {
            same.weight = Math.min(3, same.weight + 1);
            same.day = day;
            // It fades from now, at its new weight.
            same.start = same.weight;
            this.save();
            this.log.info('ties: ' + holder + ' holds it more against ' + target + ' (' + same.id + ', weight ' + same.weight + '): ' + text);
            return same;
        }
        this.data.seq += 1;
        const g = { id: 'g' + this.data.seq, about: text, weight: Math.max(1, Math.min(3, weight)), day, source, at: Date.now() };
        t.grudges.push(g);
        t.grudges = t.grudges.filter((x) => x.weight > 0 || Date.now() - (x.at || 0) < 86400000).slice(-GRUDGES_KEEP);
        t.warmth = clamp((Number(t.warmth) || 0) - g.weight);
        this.save();
        this.log.info('ties: ' + holder + ' now holds against ' + target + ' (' + g.id + ', weight ' + g.weight + ', ' + source + '): ' + text);
        return g;
    }

    // Eases one grudge holder has against target, the heaviest first, or the one with id.
    ease(holder, target, by, why, id) {
        const list = this.open(holder, target);
        const g = id ? list.find((x) => x.id === id) : list.slice().sort((a, b) => b.weight - a.weight)[0];
        if (!g) return null;
        g.weight = Math.max(0, g.weight - by);
        if (!g.weight) g.endedAt = Date.now();
        this.save();
        this.log.info('ties: ' + holder + "'s grudge against " + target + ' ' + g.id + ' ' + (g.weight ? 'eased to ' + g.weight : 'settled') + (why ? ' (' + clean(why, 60) + ')' : '') + ': ' + g.about);
        return g;
    }

    // ------------------------------------------------------------ inputs
    // A chronicle event (chronicle.add). who = [actor, target].
    onChronicle(e) {
        if (!this.cfg.enabled || !e || !Array.isArray(e.who) || e.who.length < 2) return;
        const actor = String(e.who[0]);
        const target = String(e.who[1]);
        const points = KIND_WARMTH[e.kind];
        if (points === undefined) return;
        const what = clean(String(e.text || '').replace(/^.*?「/, '「'), 30);
        if (e.kind === 'conflict') {
            // The one it was done to minds more than the one who did it.
            this.grudge(target, actor, '对你' + what, 2, e.day, 'game');
            this.warm(actor, target, -1, e.kind);
        } else if (e.kind === 'rejected') {
            // The one turned down feels it.
            this.warm(actor, target, points, e.kind);
        } else if (e.kind === 'makeup') {
            this.warm(target, actor, points, e.kind);
            this.ease(target, actor, 2, '对方' + what);
        } else {
            this.warm(target, actor, points, e.kind);
            if (e.kind === 'care') this.ease(target, actor, 1, '对方' + what);
            else {
                const light = this.open(target, actor).find((g) => g.weight === 1);
                if (light) this.ease(target, actor, 1, '对方' + what, light.id);
            }
        }
    }

    // The reply's felt (how the player's texts made the contact feel), and its "ties" field.
    fromReply(pair, snap, felt, raw) {
        if (!this.cfg.enabled) return;
        const level = isObject(felt) ? Number(felt.level) : Number(felt);
        const why = isObject(felt) ? clean(felt.why, 50) : '';
        const day = snap.env && typeof snap.env.day === 'number' ? snap.env.day : null;
        const me = String(pair.partnerId);
        const you = String(pair.playerId);
        if (level <= -2) this.grudge(me, you, why || '刚才那些话', 2, day, 'chat');
        else if (level === -1) this.warm(me, you, -1, 'felt -1');
        else if (level >= 2) {
            this.warm(me, you, 2, 'felt +2');
            this.ease(me, you, 1, why || '对方说的话让你好受多了');
        } else if (level === 1) this.warm(me, you, 1, 'felt +1');
        for (const s of Array.isArray(raw) ? raw.slice(0, 3) : []) {
            if (!isObject(s) || typeof s.id !== 'string') continue;
            const by = s.how === 'resolved' ? 3 : s.how === 'eased' ? 1 : 0;
            if (!by) continue;
            // Only grudges this contact holds, against the player or against family.
            const owner = Object.keys(this.data.ties).find((k) => k.indexOf(me + '>') === 0 && this.data.ties[k].grudges.some((g) => g.id === s.id && g.weight > 0));
            if (owner) this.ease(me, owner.split('>')[1], by, s.why, s.id);
        }
    }

    // Someone was using what the contact went to use. Once is nothing much; when it keeps
    // happening (warmth already down) it becomes a grudge, and a held one weighs more.
    friction(holder, target, object, day) {
        if (!this.cfg.enabled || !target || String(holder) === String(target)) return;
        const held = this.open(holder, target).find((g) => g.source === 'friction' && g.about.indexOf(object) >= 0);
        this.warm(holder, target, -1, 'was using ' + object);
        const t = this.tie(holder, target);
        if (held || t.warmth <= -2) this.grudge(holder, target, '老占着' + clean(object, 20), 1, day, 'friction');
    }

    // A contact's own story ran out of days unnoticed (stories.js).
    storyMissed(pair, title, day) {
        this.grudge(pair.partnerId, pair.playerId, '「' + clean(title, 20) + '」那件事，你一直没注意到', 1, day, 'story');
    }

    // Once a game day: grudges fade, warmth drifts back to neutral.
    tick(env) {
        if (!this.cfg.enabled || !env || typeof env.day !== 'number') return;
        if (this.data.day === null) {
            this.data.day = env.day;
            this.save();
            return;
        }
        if (env.day <= this.data.day) return;
        const days = env.day - this.data.day;
        this.data.day = env.day;
        for (const k of Object.keys(this.data.ties)) {
            const t = this.data.ties[k];
            const w = Number(t.warmth) || 0;
            t.warmth = w > 0 ? Math.max(0, w - days) : Math.min(0, w + days);
            for (const g of t.grudges) {
                if (g.weight <= 0 || typeof g.day !== 'number') continue;
                const fades = Math.floor((env.day - g.day) / this.cfg.fade_days);
                const left = Math.max(0, (g.start || g.weight) - fades);
                if (g.start === undefined) g.start = g.weight;
                if (left < g.weight) {
                    g.weight = left;
                    if (!left) g.endedAt = Date.now();
                    this.log.info('ties: ' + k + ' ' + g.id + ' faded to ' + left + ': ' + g.about);
                }
            }
        }
        this.save();
    }

    // ------------------------------------------------------------ the prompt
    warmthText(w) {
        if (w >= 6) return '很亲近';
        if (w >= 2) return '挺好的';
        if (w <= -6) return '很不痛快';
        if (w <= -2) return '有点别扭';
        return '';
    }

    // names: id -> name of the household.
    block(pair, snap, names) {
        if (!this.cfg.enabled) return '';
        const me = String(pair.partnerId);
        const you = String(pair.playerId);
        const call = snap.call || '对方';
        const day = snap.env && typeof snap.env.day === 'number' ? snap.env.day : null;
        const ago = (g) => day !== null && typeof g.day === 'number' ? (day - g.day <= 0 ? '今天' : (day - g.day) + ' 天前') : '前阵子';
        const lines = [];
        const mine = this.open(me, you);
        if (mine.length) {
            lines.push('【心里的疙瘩】（你对' + call + '还没过去的事）');
            for (const g of mine.slice(-SHOWN)) lines.push('  ' + g.id + '｜' + ago(g) + '：' + g.about + '（' + WEIGHT_TEXT[g.weight] + '）');
            const heavy = Math.max.apply(null, mine.map((g) => g.weight));
            lines.push(heavy >= 2
                ? '你还在气头上：回' + call + '的话短一点、冷一点，没那么热情，按你的性格可以赌气、不搭理、阴阳怪气或者直说。' +
                    '消气是一步一步的：' + call + '只是装没事，你就继续冷着；' + call + '认真道歉、说清楚了，你会松动一点（语气缓一点，嘴上可能还不饶人，ties 写 eased）；' +
                    call + '再做点什么补偿（陪你、夸你、答应你的事、给你好吃的），才算真的和好（ties 写 resolved）。'
                : '有点小别扭，但不至于不理' + call + '；' + call + '说句软话就差不多过去了（ties 写 resolved）。');
        }
        const others = [];
        for (const [id, name] of names) {
            if (id === me || id === you) continue;
            const t = this.data.ties[me + '>' + id];
            const g = this.open(me, id);
            const back = this.open(id, me).filter((x) => x.weight >= 2);
            const feel = t ? this.warmthText(Number(t.warmth) || 0) : '';
            if (!g.length && !back.length && !feel) continue;
            const bits = [];
            if (feel) bits.push('最近你对' + name + '的感觉：' + feel);
            for (const x of g.slice(-2)) bits.push(x.id + '｜你还在气' + name + '：' + x.about + '（' + ago(x) + '，' + WEIGHT_TEXT[x.weight] + '）');
            if (back.length) bits.push(name + '最近对你好像冷冷的，你不太清楚为什么');
            others.push('  ' + bits.join('；'));
        }
        if (others.length) {
            lines.push('【你和家里其他人】（' + call + '不一定知道）');
            lines.push.apply(lines, others);
            lines.push('可以跟' + call + '说这些：告状、抱怨、夸一句、请' + call + '帮忙说和，按你的性格和年纪；也可以憋着不说。别每次都提。');
        }
        return lines.join('\n');
    }

    // Rule for the answer's "ties" field, or '' when the contact holds nothing.
    rule(pair) {
        if (!this.cfg.enabled) return '';
        const me = String(pair.partnerId) + '>';
        const any = Object.keys(this.data.ties).some((k) => k.indexOf(me) === 0 && this.data.ties[k].grudges.some((g) => g.weight > 0));
        if (!any) return '';
        return '10d. ties：这次聊天让上面某个疙瘩松动了（对方认真道歉、解释清楚），写 {"id":"编号","how":"eased","why":"一句话"}；' +
            '真的解开了（道歉之后又做了补偿，或者帮你和家里人说和了），写 "how":"resolved"。放在数组里，没有就 []。敷衍、装没事不算。' +
            'felt 只看' + '对方这次的话让你感觉怎样，不是你还在不在生气。';
    }

    // Chats cleared: what came from them goes; what happened in the game stays.
    clearChat() {
        let n = 0;
        for (const k of Object.keys(this.data.ties)) {
            const t = this.data.ties[k];
            const before = t.grudges.length;
            t.grudges = t.grudges.filter((g) => g.source !== 'chat' && g.source !== 'story');
            n += before - t.grudges.length;
        }
        if (n) this.saveNow();
        return n;
    }

    // For bridge.js ties: every tie with something in it.
    report(names) {
        const out = [];
        for (const k of Object.keys(this.data.ties)) {
            const t = this.data.ties[k];
            const [h, g] = k.split('>');
            const open = t.grudges.filter((x) => x.weight > 0);
            if (!open.length && !(Number(t.warmth) || 0)) continue;
            out.push({ holder: names.get(h) || h, target: names.get(g) || g, warmth: Number(t.warmth) || 0, grudges: open });
        }
        return out;
    }
}

module.exports = { Ties, KIND_WARMTH };
