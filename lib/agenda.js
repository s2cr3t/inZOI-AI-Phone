'use strict';
// What a character agreed to do later ("周六吃完午饭一起去图书馆", "等我下班带你去跑步"), kept in
// the pair's state until it is done. Times are game time: env.day counts game days and
// env.hour / env.minute the time of day, so a due time is one number of game minutes.
//
//   open    waiting for its time (or for a free moment, when no time was agreed)
//   due     its time has come; the character is reminded to do it and say so
//   done    the character was reminded and acted on it
//   missed  its time passed and it was never acted on; mentioned once in the next message
//   dropped replaced by a newer agreement about the same thing, or too old to matter
const crypto = require('crypto');

const DAY_MIN = 24 * 60;
const KEEP_OPEN = 12;
const KEEP_CLOSED = 12;
const WHAT_MAX = 60;
// No time agreed: it is brought up again after this long, and forgotten after UNTIMED_MAX.
const UNTIMED_NUDGE_MIN = 3 * 60;
const UNTIMED_MAX_MIN = 3 * DAY_MIN;
// A due item still not acted on this long after its time is missed.
const LATE_MAX_MIN = 6 * 60;
const MAX_DAYS_AHEAD = 14;
const CLOCK_BACK_MIN = 30;

function gameMinute(env) {
    if (!env || typeof env.day !== 'number' || typeof env.hour !== 'number') return null;
    return env.day * DAY_MIN + env.hour * 60 + (typeof env.minute === 'number' ? env.minute : 0);
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// "13:30" -> 810; anything else -> null.
function clockMinute(s) {
    const m = /^(\d{1,2})[:：](\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

function clean(s) {
    return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, WHAT_MAX) : '';
}

function key(s) {
    return String(s || '').replace(/[\s，。、！？!?,.;；:："“”'‘’（）()…~～-]+/g, '');
}

// One promise from the model: { do, when: now | after | later, in_days, at }.
// Returns { what, when, due } with due in game minutes (null: no time agreed), or null.
function parsePromise(p, env) {
    if (!p || typeof p !== 'object') return null;
    const what = clean(p.do || p.what || p.text);
    if (!what) return null;
    const when = p.when === 'later' ? 'later' : p.when === 'after' ? 'after' : 'now';
    if (when !== 'later') return { what, when, due: null };
    const now = gameMinute(env);
    let days = Number(p.in_days);
    if (!isFinite(days) || days < 0) days = 0;
    days = Math.min(Math.floor(days), MAX_DAYS_AHEAD);
    const at = clockMinute(p.at);
    let due = null;
    if (now !== null && at !== null) {
        due = (env.day + days) * DAY_MIN + at;
        // "at 13:00" said at 15:00 today means tomorrow.
        if (days === 0 && due <= now) due += DAY_MIN;
    } else if (now !== null && days > 0) {
        // A day without a time: the morning of that day.
        due = (env.day + days) * DAY_MIN + 9 * 60;
    }
    return { what, when, due };
}

function describeDue(due, env) {
    if (due === null || due === undefined) return '没约具体时间';
    const now = gameMinute(env);
    const day = Math.floor(due / DAY_MIN);
    const clock = pad2(Math.floor((due % DAY_MIN) / 60)) + ':' + pad2(due % 60);
    if (now === null) return clock;
    const diff = day - Math.floor(now / DAY_MIN);
    const label = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : diff > 2 ? diff + ' 天后' : (-diff) + ' 天前';
    return label + ' ' + clock;
}

class Agenda {
    // st: the pair's state object (BridgeState.pair(key)); it is saved by the caller.
    constructor(log) {
        this.log = log;
    }

    list(st) {
        if (!Array.isArray(st.agenda)) st.agenda = [];
        return st.agenda;
    }

    open(st) {
        return this.list(st).filter((a) => a.status === 'open' || a.status === 'due');
    }

    // Adds what was agreed for later. The same thing agreed again moves to the new time.
    add(st, item, env, source) {
        const list = this.list(st);
        const k = key(item.what);
        const now = gameMinute(env);
        for (const a of list) {
            if ((a.status === 'open' || a.status === 'due') && key(a.what) === k) {
                a.status = 'dropped';
                a.closedAt = Date.now();
                a.closedWhy = 'agreed again';
            }
        }
        const entry = {
            id: crypto.randomBytes(4).toString('hex'),
            what: item.what,
            due: typeof item.due === 'number' ? item.due : null,
            madeAt: Date.now(),
            madeGame: now,
            source: source || '',
            status: 'open',
            nudgedGame: null
        };
        list.push(entry);
        this.trim(st);
        return entry;
    }

    trim(st) {
        const list = this.list(st);
        const open = list.filter((a) => a.status === 'open' || a.status === 'due').slice(-KEEP_OPEN);
        const closed = list.filter((a) => !(a.status === 'open' || a.status === 'due')).slice(-KEEP_CLOSED);
        st.agenda = closed.concat(open).sort((a, b) => a.madeAt - b.madeAt);
    }

    // Moves items along with the game clock. Returns the items to remind the character of now:
    // [{ item, kind: 'due' | 'nudge' | 'missed' }].
    tick(st, env) {
        const now = gameMinute(env);
        if (now === null) return [];
        const out = [];
        for (const a of this.list(st)) {
            if (a.status !== 'open' && a.status !== 'due') continue;
            // The clock is earlier than when it was agreed: an older save or another world.
            if (typeof a.madeGame === 'number' && now < a.madeGame - CLOCK_BACK_MIN) {
                a.status = 'dropped';
                a.closedAt = Date.now();
                a.closedWhy = 'game clock went back';
                continue;
            }
            if (typeof a.due === 'number') {
                if (now >= a.due + LATE_MAX_MIN) {
                    a.status = 'missed';
                    a.closedAt = Date.now();
                    a.closedWhy = 'time passed';
                    a.toldMissed = false;
                    continue;
                }
                if (now >= a.due) {
                    a.status = 'due';
                    out.push({ item: a, kind: 'due' });
                }
                continue;
            }
            const made = typeof a.madeGame === 'number' ? a.madeGame : now;
            if (now - made >= UNTIMED_MAX_MIN) {
                a.status = 'dropped';
                a.closedAt = Date.now();
                a.closedWhy = 'too old';
                continue;
            }
            const last = typeof a.nudgedGame === 'number' ? a.nudgedGame : made;
            if (now - last >= UNTIMED_NUDGE_MIN) out.push({ item: a, kind: 'nudge' });
        }
        return out;
    }

    // Changes when any item changes status, so a caller knows whether to save.
    signature(st) {
        return this.list(st).map((a) => a.id + a.status).join(',');
    }

    // A message went out from a prompt that listed the missed items, so they have been told.
    toldMissed(st) {
        for (const a of this.list(st)) if (a.status === 'missed' && a.toldMissed === false) a.toldMissed = true;
    }

    // The character was reminded and the reminder went out as a message (with actions or not).
    acted(st, id, env, kind) {
        const a = this.list(st).find((x) => x.id === id);
        if (!a || !(a.status === 'open' || a.status === 'due')) return;
        if (kind === 'nudge') {
            a.nudgedGame = gameMinute(env);
            return;
        }
        a.status = 'done';
        a.closedAt = Date.now();
        a.closedWhy = 'reminded at its time';
    }

    // The player or the character settled it in a reply: done now, or called off.
    close(st, ids, why) {
        const set = new Set(ids || []);
        for (const a of this.list(st)) {
            if (!set.has(a.id) || !(a.status === 'open' || a.status === 'due')) continue;
            a.status = why === 'cancelled' ? 'dropped' : 'done';
            a.closedAt = Date.now();
            a.closedWhy = why || 'settled';
        }
    }

    // Lines for the prompts: what is still agreed, with its id so a reply can settle it.
    lines(st, env) {
        return this.open(st).map((a) => '- [' + a.id + '] 「' + a.what + '」：' + describeDue(a.due, env) + (a.status === 'due' ? '（已经到时间了）' : ''));
    }

    missedLines(st) {
        return this.list(st).filter((a) => a.status === 'missed' && a.toldMissed === false).map((a) => '「' + a.what + '」');
    }
}

module.exports = { Agenda, parsePromise, describeDue, gameMinute, clockMinute, DAY_MIN };
