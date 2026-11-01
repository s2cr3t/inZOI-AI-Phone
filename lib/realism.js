'use strict';
// What keeps a household from running like clockwork:
//   aftermath  what went wrong today stays on the character's mind until the game day is over
//   bond       how the player has treated the character lately; it wears and mends slowly
//   claims     things only one person can use at a time, and who took the last of a dish
// aftermath and bond live in the pair's state (BridgeState.pair(key)), saved by the caller.
const { gameMinute } = require('./agenda');

const AFTERMATH_MAX = 6;
const AFTERMATH_REAL_MS = 6 * 3600000;
const CLOCK_BACK_MIN = 30;
const TEXT_MAX = 80;

const BOND_START = 70;
const BOND_MENDS_TO = 60;
const BOND_MEND_MS = 3600000;
const BOND_LOG_MAX = 12;
const BOND_WINDOW_MS = 3600000;
const BOND_HOUR_LOSS_MAX = 16;
const BOND_HOUR_GAIN_MAX = 10;
const FELT_POINTS = { '-2': -8, '-1': -4, '1': 3, '2': 6 };
const ORDERS_WINDOW_MS = 2 * 3600000;
const ORDERS_FREE = 6;
const IGNORED_POINTS = -3;
const TOGETHER_POINTS = 1;
const TOGETHER_EVERY_MS = 30 * 60000;
const REASONS_SHOWN = 3;
const REASON_KEEP_MS = 24 * 3600000;

const CLAIM_MS = 2 * 60000;
const TAKEN_KEEP_MS = 3 * 3600000;
const TAKEN_SHOWN = 4;

// Things one person uses at a time. Beds, sofas, tables and the TV are shared on purpose.
const EXCLUSIVE_RE = /马桶|厕所|坐便|淋浴|花洒|浴缸|浴盆|灶|炉|烤箱|微波炉|电脑|计算机|笔记本电脑|跑步机|动感单车|健身器|举重|钢琴|吉他|画架|洗衣机|烘干机|水槽|洗手池|洗碗|单人床|Toilet|Shower|Bathtub|Stove|Oven|Microwave|Computer|Laptop|Treadmill|Piano|Guitar|Easel|Washer|Dryer|Sink|SingleBed/i;

function clean(s, max) {
    return String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max || TEXT_MAX);
}

function agoText(minutes) {
    if (minutes < 1) return '刚才';
    if (minutes < 60) return minutes + ' 分钟前';
    const h = Math.floor(minutes / 60);
    return h + ' 小时前';
}

class Realism {
    constructor(log) {
        this.log = log;
        // objectId -> { actorId, actorName, what, at }
        this.claims = new Map();
        // [{ at, seq, dish, name, by, how }], oldest first
        this.takenList = [];
    }

    // ------------------------------------------------------------ aftermath
    // item: { kind: 'failed' | 'missed' | 'called_off', what, why }
    noteAftermath(st, env, item) {
        if (!item || !item.what) return null;
        if (!Array.isArray(st.aftermath)) st.aftermath = [];
        const day = env && typeof env.day === 'number' ? env.day : null;
        const entry = {
            at: Date.now(),
            day: day,
            gm: gameMinute(env),
            kind: item.kind === 'missed' || item.kind === 'called_off' ? item.kind : 'failed',
            what: clean(item.what, 60),
            why: clean(item.why, TEXT_MAX)
        };
        const same = st.aftermath.find((a) => a.kind === entry.kind && a.what === entry.what && (a.day === entry.day || a.day === null || entry.day === null));
        if (same) {
            same.at = entry.at;
            if (entry.why) same.why = entry.why;
            return null;
        }
        st.aftermath.push(entry);
        if (st.aftermath.length > AFTERMATH_MAX) st.aftermath.splice(0, st.aftermath.length - AFTERMATH_MAX);
        return entry;
    }

    // What still weighs on the character this game day. Entries noted without a clock take the
    // day of the first snapshot that sees them. Returns { list, changed }.
    aftermathToday(st, env) {
        const list = Array.isArray(st.aftermath) ? st.aftermath : [];
        const now = gameMinute(env);
        const today = env && typeof env.day === 'number' ? env.day : null;
        let changed = false;
        const keep = [];
        for (const a of list) {
            if (!a || !a.what) { changed = true; continue; }
            if (today !== null && a.day === null) {
                a.day = today;
                if (a.gm === null || a.gm === undefined) a.gm = now;
                changed = true;
            }
            if (today === null) {
                if (Date.now() - a.at < AFTERMATH_REAL_MS) keep.push(a);
                else changed = true;
                continue;
            }
            if (a.day !== today || (typeof a.gm === 'number' && now !== null && a.gm > now + CLOCK_BACK_MIN)) {
                changed = true;
                continue;
            }
            keep.push(a);
        }
        if (changed) st.aftermath = keep;
        return { list: keep.slice(), changed };
    }

    aftermathLines(list, env, call) {
        const now = gameMinute(env);
        return list.map((a) => {
            const ago = typeof a.gm === 'number' && now !== null ? agoText(Math.max(0, now - a.gm)) : '今天';
            if (a.kind === 'missed') return '- ' + ago + '：和' + call + '约好的「' + a.what + '」到时间没做成，就这么过去了';
            if (a.kind === 'called_off') return '- ' + ago + '：和' + call + '约好的「' + a.what + '」取消了' + (a.why ? '（' + a.why + '）' : '');
            return '- ' + ago + '：你想做「' + a.what + '」，没做成' + (a.why ? '（' + a.why + '）' : '');
        });
    }

    // ------------------------------------------------------------ bond
    bond(st, now) {
        const t = now || Date.now();
        if (!st.bond || typeof st.bond.score !== 'number' || !isFinite(st.bond.score)) {
            st.bond = { score: BOND_START, mendAt: t, log: [], orders: [], ignored: '', nearAt: 0 };
        }
        const b = st.bond;
        if (!Array.isArray(b.log)) b.log = [];
        if (!Array.isArray(b.orders)) b.orders = [];
        // Left alone, hard feelings fade a little every hour, but only back to "fine".
        if (b.score < BOND_MENDS_TO) {
            const steps = Math.floor((t - (b.mendAt || t)) / BOND_MEND_MS);
            if (steps > 0) {
                b.score = Math.min(BOND_MENDS_TO, b.score + steps);
                b.mendAt = (b.mendAt || t) + steps * BOND_MEND_MS;
            }
        } else {
            b.mendAt = t;
        }
        return b;
    }

    // Moves the bond, within what one hour may move it. Returns the points applied.
    shift(st, points, why, now) {
        const t = now || Date.now();
        const b = this.bond(st, t);
        if (!points) return 0;
        const recent = b.log.filter((e) => t - e.at < BOND_WINDOW_MS);
        let room;
        if (points < 0) {
            const lost = recent.reduce((s, e) => s + (e.d < 0 ? -e.d : 0), 0);
            room = Math.max(0, BOND_HOUR_LOSS_MAX - lost);
            points = -Math.min(-points, room);
        } else {
            const gained = recent.reduce((s, e) => s + (e.d > 0 ? e.d : 0), 0);
            room = Math.max(0, BOND_HOUR_GAIN_MAX - gained);
            points = Math.min(points, room);
        }
        const next = Math.max(0, Math.min(100, b.score + points));
        const applied = next - b.score;
        if (!applied) return 0;
        if (b.score >= BOND_MENDS_TO && next < BOND_MENDS_TO) b.mendAt = t;
        b.score = next;
        b.log.push({ at: t, d: applied, why: clean(why, 60) });
        if (b.log.length > BOND_LOG_MAX) b.log.splice(0, b.log.length - BOND_LOG_MAX);
        return applied;
    }

    // The reply's own reading of what the player's texts did to it: -2 .. 2.
    felt(st, level, why, now) {
        const n = Math.round(Number(level));
        if (!isFinite(n) || n === 0) return 0;
        const k = String(Math.max(-2, Math.min(2, n)));
        return this.shift(st, FELT_POINTS[k] || 0, why || (n < 0 ? '聊天里让你不舒服' : '聊天里让你觉得暖心'), now);
    }

    // The player asked for something to be done. Many errands in a short while wear a little.
    ordered(st, now) {
        const t = now || Date.now();
        const b = this.bond(st, t);
        b.orders = b.orders.filter((x) => t - x < ORDERS_WINDOW_MS);
        b.orders.push(t);
        if (b.orders.length <= ORDERS_FREE) return 0;
        return this.shift(st, -1, '一会儿工夫被叫去做了好多事', t);
    }

    // A message the character sent has stayed unanswered as long as it waits for an answer.
    ignored(st, messageId, now) {
        const b = this.bond(st, now);
        if (!messageId || b.ignored === messageId) return 0;
        b.ignored = messageId;
        return this.shift(st, IGNORED_POINTS, '发过去的消息一直没人回', now);
    }

    together(st, now) {
        const t = now || Date.now();
        const b = this.bond(st, t);
        if (t - (b.nearAt || 0) < TOGETHER_EVERY_MS) return 0;
        b.nearAt = t;
        return this.shift(st, TOGETHER_POINTS, '一起待了一会儿', t);
    }

    band(score) {
        if (score >= 80) return 'close';
        if (score >= 55) return 'fine';
        if (score >= 35) return 'cool';
        return 'hurt';
    }

    // How willing the character is to reach out unprompted, against the configured chance.
    reachFactor(st, now) {
        const band = this.band(this.bond(st, now).score);
        return band === 'close' ? 1.25 : band === 'fine' ? 1 : band === 'cool' ? 0.5 : 0.25;
    }

    // For the prompts: { score, band, reasons: [why] } with the latest hurts first.
    bondView(st, now) {
        const t = now || Date.now();
        const b = this.bond(st, t);
        const reasons = [];
        const seen = new Set();
        for (let i = b.log.length - 1; i >= 0 && reasons.length < REASONS_SHOWN; i--) {
            const e = b.log[i];
            if (e.d >= 0 || t - e.at > REASON_KEEP_MS || seen.has(e.why)) continue;
            seen.add(e.why);
            reasons.push(e.why);
        }
        return { score: Math.round(b.score), band: this.band(b.score), reasons };
    }

    // ------------------------------------------------------------ claims
    exclusive(objectName, interaction) {
        const text = [objectName, interaction && interaction.name, interaction && interaction.id].filter(Boolean).join(' ');
        return EXCLUSIVE_RE.test(text);
    }

    claim(objectId, actorId, actorName, what) {
        if (!objectId) return;
        this.claims.set(String(objectId), { actorId: String(actorId), actorName: actorName || '', what: what || '', at: Date.now() });
    }

    // Someone other than actorId who has just started on objectId through the bridge.
    claimedBy(objectId, actorId) {
        const c = this.claims.get(String(objectId || ''));
        if (!c) return null;
        if (Date.now() - c.at > CLAIM_MS) {
            this.claims.delete(String(objectId));
            return null;
        }
        return c.actorId === String(actorId) ? null : c;
    }

    // A dish a character took out of a fridge through the bridge. how: 'eat' | 'table'.
    // how: eat | table | give (served to toId).
    noteTaken(seq, dish, name, byId, how, toId) {
        if (!name || !byId) return;
        const now = Date.now();
        this.takenList = this.takenList.filter((x) => now - x.at < TAKEN_KEEP_MS && x.seq !== String(seq || ''));
        const kind = how === 'table' || how === 'give' ? how : 'eat';
        this.takenList.push({ at: now, seq: String(seq || ''), dish: String(dish || ''), name: clean(name, 30), by: String(byId), how: kind, to: kind === 'give' ? String(toId || '') : '' });
        if (this.takenList.length > TAKEN_SHOWN * 2) this.takenList.splice(0, this.takenList.length - TAKEN_SHOWN * 2);
    }

    // Lines for the prompt of viewerId, newest last. names: id -> name of everyone in the
    // household; dishes taken by people outside it are left out.
    takenLines(names, viewerId) {
        const now = Date.now();
        const out = [];
        for (const x of this.takenList) {
            if (now - x.at >= TAKEN_KEEP_MS || !names.has(x.by)) continue;
            const who = x.by === String(viewerId) ? '你自己' : names.get(x.by);
            let did = '把「' + x.name + '」拿出来吃了';
            if (x.how === 'table') did = '把「' + x.name + '」拿出来摆上了餐桌';
            if (x.how === 'give') {
                const to = x.to === String(viewerId) ? '你' : (names.get(x.to) || '家里人');
                did = '把「' + x.name + '」拿出来端给了' + to;
            }
            out.push('- ' + agoText(Math.round((now - x.at) / 60000)) + '：' + who + did);
        }
        return out.slice(-TAKEN_SHOWN);
    }

    // Another world or save: who holds what no longer means anything.
    reset() {
        this.claims.clear();
        this.takenList = [];
    }
}

module.exports = { Realism, EXCLUSIVE_RE, FELT_POINTS, BOND_START };
