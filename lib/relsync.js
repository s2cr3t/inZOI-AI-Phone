'use strict';
// What is said by text changes the game's own relationship values. Every reply already says how
// the player's words made the contact feel (felt.level, -2..2, persona.js rule 10); here that
// moves the game's bond between the two (relationships_set_value_between), by kind of
// relationship:
//   lovers (spouse, sweetheart, suitor, romance)  Romance, and Friendship by half
//   family (spouse's kin, parents, children ...)   Family, and Friendship by half
//   colleagues                                     Business, and Friendship by half
//   everyone else                                  Friendship
// Small steps (STEP), at most DAY_CAP a stat between two people in one game day, so a chat cannot
// be farmed; a big moment (a confession accepted) moves it once by more (bump). Every tool the
// game has sets a bond both ways at once, so the value written is shared (sharedValue). The game guards
// some stats itself (Romance needs two people it allows to love, Family an existing family tie):
// what it refuses is left alone.
//   data/relsync.json  this service: { v, byPair: { <player>-<contact>: { day, moved: { stat: sum } } } }
const path = require('path');
const fsx = require('./fsx');

const V = 1;
const STEP = { '2': 3, '1': 1.5, '-1': -2, '-2': -4 };
const DAY_CAP = 10;
const MIN = -100;
const MAX = 100;
const LOVERS = { spouse: true, sweetheart: true, suitor: true, romance: true };
const FAMILY = { child: true, parent: true, family: true, relative: true };
const NAMES = { Romance: '爱情', Friendship: '友情', Family: '亲情', Business: '工作' };

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// The stats a felt level moves for this kind of relationship, with the step for each.
function stepsFor(role, level) {
    const step = STEP[String(Math.round(Number(level) || 0))];
    if (!step) return {};
    const half = Math.round(step * 5) / 10;
    if (LOVERS[role]) return { Romance: step, Friendship: half };
    if (FAMILY[role]) return { Family: step, Friendship: half };
    if (role === 'colleague') return { Business: step, Friendship: half };
    return { Friendship: step };
}

// What is left of today's allowance for a stat, given what moved already: the step cut to it.
function capped(step, movedToday, cap) {
    const c = cap === undefined ? DAY_CAP : cap;
    if (step > 0) return Math.max(0, Math.min(step, c - Math.max(0, movedToday)));
    return Math.min(0, Math.max(step, -c - Math.min(0, movedToday)));
}

function round1(n) { return Math.round(n * 10) / 10; }

// The one value both directions get. The game has no tool that sets a bond one way: whatever is
// written lands on both, so the small difference the game keeps between them (a 92.5 / 95.0) cannot
// be kept. The least harm: the middle of the two moved by the step, so each side is off by at most
// half their gap; and nobody moves against the step, so on a warm reply neither side goes down (the
// lower one closes in on the higher), on a cold one neither goes up.
// a: their bond toward the player (what the reply's felt is about); b: the player's toward them.
function sharedValue(a, b, step) {
    const middle = (a + b) / 2 + step;
    if (step > 0) return Math.max(middle, a, b);
    if (step < 0) return Math.min(middle, a, b);
    return middle;
}

class RelSync {
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.file = '';
        this.data = { v: V, byPair: {} };
        // Pair key -> the move in progress: a second one waits for it, nothing is dropped.
        this.chains = new Map();
    }

    get enabled() {
        const c = this.d.cfg && this.d.cfg.relsync;
        return !(isObject(c) && c.enabled === false);
    }

    configure(dataDir) {
        this.file = path.join(dataDir, 'relsync.json');
        const r = fsx.readJson(this.file);
        const v = r.ok && isObject(r.value) && r.value.v === V ? r.value : {};
        this.data = { v: V, byPair: isObject(v.byPair) ? v.byPair : {} };
    }

    save() {
        try {
            fsx.writeJson(this.file, this.data, true);
        } catch (e) {
            this.log.warn('relsync: not saved: ' + e.message);
        }
    }

    today(key, day) {
        let e = this.data.byPair[key];
        if (!isObject(e) || e.day !== day) e = this.data.byPair[key] = { day, moved: {} };
        if (!isObject(e.moved)) e.moved = {};
        return e;
    }

    // After a reply: how the player's words made the contact feel moves their bond in the game.
    fromFelt(pair, snap, felt) {
        if (!this.enabled || !felt || typeof felt !== 'object') return Promise.resolve(null);
        const steps = stepsFor(pair.role, felt.level);
        if (!Object.keys(steps).length) return Promise.resolve(null);
        return this.move(pair, snap, steps, false, String(felt.why || ''));
    }

    // A big moment: moved by more than a reply can, past the day's allowance.
    bump(pair, snap, steps, why) {
        if (!this.enabled) return Promise.resolve(null);
        return this.move(pair, snap, steps, true, why || '');
    }

    move(pair, snap, steps, big, why) {
        const key = String(pair.playerId) + '-' + String(pair.partnerId);
        const prev = this.chains.get(key) || Promise.resolve();
        const run = prev.then(() => this.moveNow(key, pair, snap, steps, big, why));
        const tail = run.catch(() => null);
        this.chains.set(key, tail);
        tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
        return run;
    }

    async moveNow(key, pair, snap, steps, big, why) {
        try {
            const day = snap && snap.env && typeof snap.env.day === 'number' ? snap.env.day : null;
            const e = this.today(key, day);
            const game = this.d.game;
            const theirs = { owner_id: String(pair.partnerId), target_id: String(pair.playerId) };
            const rel = await game.soft('relationships_get_value_between', theirs);
            if (!rel || !rel.stats) return null;
            // The other way round: how the player stands toward them. The game keeps the two a
            // little apart, but every tool that sets a bond sets both ways at once (sharedValue).
            const back = await game.soft('relationships_get_value_between', { owner_id: String(pair.playerId), target_id: String(pair.partnerId) });
            const tried = [];
            for (const stat of Object.keys(steps)) {
                const s = rel.stats[stat];
                if (!s || typeof s.value !== 'number') continue;
                const step = big ? steps[stat] : capped(steps[stat], e.moved[stat] || 0);
                if (!step) continue;
                const b = back && back.stats && back.stats[stat] && typeof back.stats[stat].value === 'number' ? back.stats[stat].value : s.value;
                const value = round1(Math.max(MIN, Math.min(MAX, sharedValue(s.value, b, step))));
                if (value === round1(s.value) && value === round1(b)) continue;
                await game.soft('relationships_set_value_between', {
                    owner_id: String(pair.partnerId), target_id: String(pair.playerId), Value: value,
                    // The stat's name (Friendship), not the id of its level row (friendship6), which the game refuses.
                    relationship_id: stat
                });
                tried.push({ stat, from: round1(s.value) });
            }
            if (!tried.length) return null;
            // What the game made of it: a stat it guards (Romance between two it does not let love,
            // Family without a family tie) stays where it was and does not count.
            const after = await game.soft('relationships_get_value_between', { owner_id: String(pair.partnerId), target_id: String(pair.playerId) });
            const done = [];
            for (const t of tried) {
                const s = after && after.stats && after.stats[t.stat];
                if (!s || typeof s.value !== 'number' || round1(s.value) === t.from) continue;
                const step = round1(s.value - t.from);
                if (!big) e.moved[t.stat] = round1((e.moved[t.stat] || 0) + step);
                done.push({ stat: t.stat, from: t.from, to: round1(s.value), step });
            }
            if (!done.length) {
                this.log.info('relsync [' + key + '] the game kept ' + tried.map((x) => x.stat).join(', ') + ' as it was');
                return null;
            }
            this.save();
            const name = (snap && snap.partner && snap.partner.name) || '';
            this.log.info('relsync [' + key + '] ' + done.map((x) => x.stat + ' ' + x.from + ' -> ' + x.to).join(', ') + (why ? ' (' + why + ')' : ''));
            const main = done[0];
            const text = '与' + name + '的关系 ' + done.map((x) => (NAMES[x.stat] || x.stat) + ' ' + (x.step > 0 ? '+' : '') + x.step).join('，');
            game.soft('toast_show', { Message: text, Lifetime: 4 }).catch(() => {});
            return { done, main };
        } catch (e) {
            this.log.warn('relsync [' + key + ']: ' + (e && e.message || e));
            return null;
        }
    }
}

module.exports = { RelSync, stepsFor, capped, sharedValue, STEP, DAY_CAP };
