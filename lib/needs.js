'use strict';
// Needs moved by a text exchange. After a reply the model reads the exchange the way the two
// people lived it and decides whose inner needs it touched: being kept company (Society), being
// seen and valued (Admit), being amused (Fun), and by how much, in either direction. A scolding
// can leave someone feeling less valued; a warm chat can ease loneliness a little. Bodily needs
// stay out of reach: a text does not feed anyone or let them rest.
//
// The change goes through the game's stat_add in small steps, bounded per person, need and hour,
// and is kept in data/needs-state.json so the bound survives restarts.
const path = require('path');
const fsx = require('./fsx');
const persona = require('./persona');
const { NEED_LABELS } = require('./world');

const CONTEXT_MESSAGES = 6;
const KEEP_MS = 3 * 3600000;
const HOUR_MS = 3600000;

const MEANING = {
    Society: '社交：有人陪、有人说话的满足感。低了会孤单',
    Admit: '认可：被看见、被肯定、被需要的满足感。低了会觉得自己不被当回事',
    Fun: '娱乐：开心、好玩、被逗乐。低了会无聊'
};

function listOf(v) {
    return Array.isArray(v) ? v : [];
}

// The needs judgement in parts, so it can be asked alone (needsPrompt) or together with the mood
// judgement in one call (aftermath.js). byRole: the person is named "partner"/"player" as in the
// mood judgement, instead of by name.
function needsParts(input, byRole) {
    const snap = input.snap;
    const names = { partner: snap.partner.name, player: snap.player.name };
    const stats = input.stats;
    const menu = stats.map((s) => s + '：' + (MEANING[s] || NEED_LABELS[s] || s)).join('\n');
    const now = (who) => stats.map((s) => (NEED_LABELS[s] || s) + ' ' + (input.current[who][s] !== undefined ? input.current[who][s] + '%' : '不清楚')).join('，');
    const rules = [
        '下面这些需求在游戏里是 0~100% 的满足度，越高越满足。你的判断会真的加到游戏角色身上：',
        menu,
        '像真实的人那样体会：谁对谁说了什么，读到的人心里是被陪伴了、被肯定了、被逗乐了，还是被冷落、被否定、被泼了冷水。这和两人的关系、读的人原本的状态、话的分量都有关系。',
        '可以往上，也可以往下：被批评、被敷衍、被嫌弃，认可会往下；被夸、被感谢、被需要，认可会往上。隔着手机聊天也算有人说话，但比不上当面相处，社交的变化通常是小的。',
        '日常问事、交代事情，需求不会有明显变化，这时 changes 写空数组。一个人可以有几项变化，每项最多写一次。',
        '程度：1 一点点，2 明显，3 很大。3 很少见，要配得上那段话的分量。',
        '最近已经因为聊天变过的，同样的原因不要再算一次，除非这次的话又往前推了一步。'
    ];
    const whoText = byRole ? 'partner 或 player' : names.partner + ' 或 ' + names.player;
    const format = '"changes":[{"who":"' + whoText + '（心里起变化的那个人）","need":"上面的英文名","direction":"up 或 down","level":1,"why":"一句话，读到哪句话、心里怎么了"}]';
    const recent = listOf(input.recent).map((r) => names[r.who] + ' ' + r.minutesAgo + ' 分钟前因为聊天' + (NEED_LABELS[r.stat] || r.stat) + (r.delta > 0 ? '上升' : '下降') + (r.why ? '（' + r.why + '）' : '')).join('\n');
    const state = [
        names.partner + ' 现在的需求：' + now('partner'),
        names.player + ' 现在的需求：' + now('player')
    ];
    return { rules, format, state, recent: recent ? '最近因为聊天已有的需求变化：\n' + recent : '' };
}

function needsPrompt(input) {
    const snap = input.snap;
    const t = persona.terms(snap);
    const names = { partner: snap.partner.name, player: snap.player.name };
    const n = needsParts(input, false);
    const system = [
        '你读两位家人之间刚发生的一段手机短信，判断这段话会不会让其中一个人心里的需求真的起变化。'
    ].concat(n.rules, [
        '只输出 JSON：{"why":"",' + n.format + '}',
        'why 写在最前面：这段话有没有真正碰到谁心里的什么，一两句话。'
    ]).join('\n');
    const lines = (list) => listOf(list).map((m) => names[m.side] + '：' + m.text).join('\n');
    const user = [names.partner + ' 是 ' + names.player + ' 的' + t.me + '。'].concat(n.state, [
        n.recent,
        input.before && input.before.length ? '\n之前的聊天：\n' + lines(input.before) : '',
        '\n这次的短信：\n' + lines(input.exchange),
        '\n请只输出 JSON。'
    ]).filter(Boolean).join('\n');
    return { system, user };
}

class Needs {
    constructor(daemon) {
        this.d = daemon;
        this.log = daemon.log;
        this.given = [];
        this.stateFile = null;
    }

    get cfg() {
        return this.d.cfg.needs;
    }

    configure(dataDir) {
        if (this.stateFile) return;
        this.stateFile = path.join(dataDir, 'needs-state.json');
        const r = fsx.readJson(this.stateFile);
        if (r.ok && r.value) this.given = listOf(r.value.given).filter((g) => g && g.at && g.stat);
        this.prune(Date.now());
    }

    prune(now) {
        this.given = this.given.filter((g) => now - g.at < KEEP_MS);
    }

    save() {
        fsx.writeJson(this.stateFile, { given: this.given }, true);
    }

    // What is left of this hour's room to move one need of one person in one direction.
    room(target, stat, sign, now) {
        let used = 0;
        for (const g of this.given) {
            if (g.target === target && g.stat === stat && now - g.at < HOUR_MS && Math.sign(g.delta) === sign) used += Math.abs(g.delta);
        }
        return Math.max(0, this.cfg.max_per_hour - used);
    }

    async read(id) {
        const r = await this.d.game.soft('stat_get_all', { entity_id: id });
        return (r && r.stats) || {};
    }

    // Reads what the judgement needs; null when there is nothing to judge.
    async prepare(pair, snap, exchange, before) {
        const cfg = this.cfg;
        if (!cfg.enabled || !exchange.length || !this.d.llm.configured) return null;
        const now = Date.now();
        this.prune(now);
        const people = {
            partner: { id: String(snap.partner.id), name: snap.partner.name },
            player: { id: String(snap.player.id), name: snap.player.name }
        };
        const [pStats, wStats] = await Promise.all([this.read(people.partner.id), this.read(people.player.id)]);
        const raw = { partner: pStats, player: wStats };
        const stats = cfg.stats.filter((s) => pStats[s] && wStats[s]);
        if (!stats.length) {
            this.log.info('needs [' + pair.key + '] skipped: the game reports none of ' + cfg.stats.join(', '));
            return null;
        }
        const current = { partner: {}, player: {} };
        for (const who of ['partner', 'player']) {
            for (const s of stats) if (typeof raw[who][s].pct === 'number') current[who][s] = Math.round(raw[who][s].pct);
        }
        const recent = this.given
            .filter((g) => g.pair === pair.key)
            .map((g) => ({ who: g.target === people.partner.id ? 'partner' : 'player', stat: g.stat, delta: g.delta, why: g.why, minutesAgo: Math.round((now - g.at) / 60000) }));
        return { people, raw, stats, current, input: { snap, stats, current, recent, exchange, before: listOf(before).slice(-CONTEXT_MESSAGES) } };
    }

    async consider(pair, snap, exchange, before) {
        const ctx = await this.prepare(pair, snap, exchange, before);
        if (!ctx) return;
        const p = needsPrompt(ctx.input);
        this.log.debug('needs prompt:\n' + p.system + '\n' + p.user);
        let r;
        try {
            r = await this.d.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0.3, max_tokens: 500, purpose: 'needs' });
        } catch (e) {
            this.log.warn('needs [' + pair.key + '] check failed: ' + (e && e.message || e));
            return;
        }
        await this.apply(pair, ctx, r && r.why, r && r.changes);
    }

    async apply(pair, ctx, thought, list) {
        const cfg = this.cfg;
        const now = Date.now();
        const { people, raw, stats, current } = ctx;
        const changes = listOf(list);
        if (typeof thought === 'string' && thought.trim()) {
            this.log.info('needs [' + pair.key + '] thinks: ' + JSON.stringify(thought.trim().slice(0, 200)) + (changes.length ? '' : ' -> no change'));
        } else if (!changes.length) {
            this.log.info('needs [' + pair.key + '] no change');
        }
        const done = new Set();
        let changed = false;
        for (const c of changes) {
            const named = c && typeof c.who === 'string' ? c.who.trim() : '';
            const who = named === 'partner' || named === people.partner.name ? 'partner' : named === 'player' || named === people.player.name ? 'player' : null;
            const stat = c && stats.indexOf(c.need) >= 0 ? c.need : null;
            const sign = c && c.direction === 'up' ? 1 : c && c.direction === 'down' ? -1 : 0;
            if (!who || !stat || !sign || done.has(who + stat)) continue;
            done.add(who + stat);
            const level = Math.min(3, Math.max(1, Math.round(Number(c.level) || 1)));
            const target = people[who];
            const s = raw[who][stat];
            const toEdge = sign > 0 ? s.max - s.value : s.value - s.min;
            const amount = Math.min(cfg.points[level - 1], this.room(target.id, stat, sign, now), toEdge);
            const why = typeof c.why === 'string' ? c.why.trim().slice(0, 80) : '';
            const label = NEED_LABELS[stat] || stat;
            if (amount < 0.5) {
                this.log.info('needs [' + pair.key + '] ' + target.name + ' ' + label + (sign > 0 ? ' up' : ' down') + ' skipped: ' + (toEdge < 0.5 ? 'already at the edge' : 'hourly limit reached'));
                continue;
            }
            const delta = Math.round(sign * amount * 10) / 10;
            try {
                await this.d.game.call('stat_add', { entity_id: target.id, stat_id: stat, Value: delta });
            } catch (e) {
                this.log.warn('needs [' + pair.key + '] could not change ' + target.name + ' ' + label + ': ' + (e && e.message || e));
                continue;
            }
            this.given.push({ at: Date.now(), pair: pair.key, target: target.id, stat, delta, why });
            changed = true;
            this.log.info('needs [' + pair.key + '] ' + target.name + ' ' + label + ' ' + (delta > 0 ? '+' : '') + delta + ' (was ' + current[who][stat] + '%)' + (why ? ' [' + why + ']' : ''));
        }
        if (changed) this.save();
    }
}

module.exports = { Needs, needsPrompt, needsParts };
