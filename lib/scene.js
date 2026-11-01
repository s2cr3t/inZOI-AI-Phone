'use strict';
// What is actually going on in the household right now, read from the game rather than from the
// chat: the food lying around and where, the family meals kept in the fridge, what everyone else
// is doing, and what the family did lately and how each thing ended. Every prompt that decides
// what someone does reads this, so "I'm hungry" is met with the dinner dad just cooked instead of
// whatever the chat or a stale promise happened to mention.
const path = require('path');
const fsx = require('./fsx');
const { fullName } = require('./world');

const TIMELINE_KEEP = 300;
const TIMELINE_SHOWN = 18;
const TIMELINE_WINDOW_MS = 3 * 3600000;
const FOODS_SHOWN = 12;
const STORED_SHOWN = 8;
const NEAR_CM = 300;
const FRESH_MS = 120000;
const SAVE_DELAY_MS = 3000;
// One started/ended pair is matched within this many later entries of the same person.
const END_SEARCH = 30;

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function clockOf(env) {
    if (!env || typeof env.hour !== 'number') return null;
    return { day: typeof env.day === 'number' ? env.day : null, time: pad2(env.hour) + ':' + pad2(env.minute || 0) };
}

function distanceCm(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = typeof a.z === 'number' && typeof b.z === 'number' ? a.z - b.z : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

class Scene {
    constructor(daemon, dataDir) {
        this.d = daemon;
        this.file = path.join(dataDir, 'scene-timeline.json');
        this.clock = null;
        this.timeline = [];
        this.firstSeen = new Map();
        this.saveTimer = null;
        this.load();
    }

    load() {
        const r = fsx.readJson(this.file);
        if (!r.ok || !r.value) return;
        const v = r.value;
        if (Array.isArray(v.timeline)) {
            this.timeline = v.timeline.filter((e) => e && typeof e.a === 'string' && typeof e.b === 'string' && typeof e.at === 'number').slice(-TIMELINE_KEEP);
        }
        if (v.firstSeen && typeof v.firstSeen === 'object') {
            for (const id of Object.keys(v.firstSeen)) {
                const s = v.firstSeen[id];
                if (s && typeof s.at === 'number') this.firstSeen.set(id, s);
            }
        }
    }

    scheduleSave() {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.save();
        }, SAVE_DELAY_MS);
        if (this.saveTimer.unref) this.saveTimer.unref();
    }

    save() {
        const firstSeen = {};
        for (const [id, s] of this.firstSeen) firstSeen[id] = s;
        try {
            fsx.writeJson(this.file, { timeline: this.timeline, firstSeen });
        } catch (e) {
            this.d.log.warn('scene timeline not saved: ' + (e && e.message || e));
        }
    }

    flush() {
        if (!this.saveTimer) return;
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        this.save();
    }

    // The city clock, sampled by the tracker every few seconds; events are stamped with it.
    noteClock(env) {
        const c = clockOf(env);
        if (c) this.clock = c;
    }

    boot() {
        return this.d.journal ? this.d.journal.boot || '' : '';
    }

    // One start, finish, cancel or fail from the HouseholdJournal Lua mod.
    onEvent(ev) {
        if (!ev || !ev.actor || !ev.bag) return;
        const c = this.clock || {};
        const boot = this.boot();
        if (ev.kind === 'started') {
            this.timeline.push({ a: ev.actor, b: ev.bag, t: ev.target || '', at: ev.at, day: c.day, time: c.time || '', boot, end: '' });
            if (this.timeline.length > TIMELINE_KEEP) this.timeline.splice(0, this.timeline.length - TIMELINE_KEEP);
        } else {
            let seen = 0;
            for (let i = this.timeline.length - 1; i >= 0 && seen < END_SEARCH; i--) {
                const e = this.timeline[i];
                if (e.a !== ev.actor) continue;
                seen += 1;
                if (e.b !== ev.bag || e.end) continue;
                e.end = ev.kind;
                e.endTime = c.time || '';
                if (ev.reason) e.why = String(ev.reason).slice(0, 60);
                break;
            }
        }
        this.d.world.interactionName(ev.bag).catch(() => '');
        this.scheduleSave();
    }

    // The scene for one conversation. Missing pieces are left out; this never throws.
    async build(pair, snap) {
        const out = { site: '', here: false, foods: [], stored: [], people: [], timeline: [], actNames: {} };
        try {
            const names = new Map(pair.members.map((m) => [String(m.entity_id), fullName(m)]));
            const [lot, people, timeline] = await Promise.all([
                this.lot(snap, names).catch((e) => { this.d.log.debug('scene lot: ' + e.message); return null; }),
                this.people(pair).catch((e) => { this.d.log.debug('scene people: ' + e.message); return []; }),
                this.recent(pair).catch((e) => { this.d.log.debug('scene timeline: ' + e.message); return []; })
            ]);
            if (lot) {
                out.site = lot.site;
                out.here = lot.here;
                out.foods = lot.foods;
                out.stored = lot.stored;
            }
            out.people = people;
            out.timeline = timeline;
            out.actNames = await this.actNames(snap);
        } catch (e) {
            this.d.log.warn('scene not built: ' + (e && e.message || e));
        }
        return out;
    }

    // Names of the bags in the person's own diary, so it reads "烤虾" instead of a code.
    async actNames(snap) {
        const names = {};
        if (!snap.env || !this.d.diary) return names;
        const bags = new Set();
        for (const e of this.d.todayDiary(snap.partner.id, snap.env).slice(-15)) {
            if (e.act && e.act !== 'Idle') bags.add(e.act);
        }
        await Promise.all(Array.from(bags).map(async (b) => {
            const n = await this.d.world.interactionName(b).catch(() => '');
            if (n) names[b] = n;
        }));
        return names;
    }

    // Food and kept meals at the site the game can scan: that of the character being played.
    // Shown when it is where the person is, or the person's home.
    async lot(snap, names) {
        const actions = this.d.actions;
        const journal = this.d.journal;
        if (!actions || !journal || !journal.alive()) return null;
        const ref = await actions.possessedSite();
        if (!ref) return null;
        const here = snap.partner.site === ref.name;
        const home = snap.partner.homeSiteName === ref.name;
        if (!here && !home) return null;
        const rows = await actions.scanSite();
        if (!rows || !rows.length) return null;
        const byId = new Map(rows.map((r) => [r.id, r]));
        const fresh = (at) => at && Date.now() - at < FRESH_MS;
        const storedIds = new Set();
        const stored = [];
        if (journal.stored && fresh(journal.storedAt)) {
            for (const [container, list] of journal.stored) {
                const box = byId.get(container);
                if (!box) continue;
                for (const dish of list) {
                    storedIds.add(dish.id);
                    if (stored.length >= STORED_SHOWN) continue;
                    const name = (await this.d.world.foodName(dish.objectId).catch(() => '')) || dish.objectId;
                    stored.push({ id: dish.id, name, container: box.name, containerId: container, left: dish.left, total: dish.total, spoiled: dish.spoiled });
                }
            }
        }
        const foodIds = journal.food && fresh(journal.foodAt) ? Array.from(journal.food.keys()) : [];
        const foodSet = new Set(foodIds);
        const carried = new Map();
        if (this.d.meals) {
            for (const c of this.d.meals.carriedDishes()) carried.set(String(c.dish), c);
        }
        const foods = [];
        let changed = false;
        for (const id of foodIds) {
            if (storedIds.has(id) && !carried.has(id)) continue;
            const row = byId.get(id);
            if (!row && !carried.has(id)) continue;
            let seen = this.firstSeen.get(id);
            if (!seen) {
                seen = { at: Date.now(), day: this.clock ? this.clock.day : null, time: this.clock ? this.clock.time : '', boot: this.boot() };
                this.firstSeen.set(id, seen);
                changed = true;
            }
            const item = { id, name: row ? row.name : carried.get(id).name, state: actions.objectState(id), since: seen.boot === this.boot() ? seen.time : '' };
            if (carried.has(id)) {
                item.carriedBy = names.get(String(carried.get(id).actor)) || '家里人';
            } else if (row && typeof row.x === 'number') {
                let best = null;
                let bestCm = NEAR_CM;
                for (const r of rows) {
                    if (r.id === id || foodSet.has(r.id) || typeof r.x !== 'number') continue;
                    const cm = distanceCm(row, r);
                    if (cm < bestCm) {
                        bestCm = cm;
                        best = r;
                    }
                }
                if (best) item.near = best.name;
            }
            foods.push(item);
            if (foods.length >= FOODS_SHOWN) break;
        }
        if (changed) {
            if (this.firstSeen.size > 400) {
                const keep = Array.from(this.firstSeen.entries()).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
                this.firstSeen = new Map(keep);
            }
            this.scheduleSave();
        }
        return { site: ref.name, here, foods, stored };
    }

    // Everyone else in the household and what they are doing this moment.
    async people(pair) {
        const names = new Map(pair.members.map((m) => [String(m.entity_id), fullName(m)]));
        const others = pair.members.filter((m) => String(m.entity_id) !== pair.partnerId && String(m.entity_id) !== pair.playerId);
        return Promise.all(others.map(async (m) => {
            const id = String(m.entity_id);
            const cur = await this.d.game.soft('interaction_get_current', { entity_id: id });
            const activity = this.d.world.activityOf(cur);
            await this.d.world.nameActivity(activity, names);
            return {
                id,
                name: fullName(m),
                age: m.age_group_text || m.age_group || '',
                site: m.current_site || '',
                activity
            };
        }));
    }

    // What the household did lately in the world now loaded, newest last, in the game's words.
    async recent(pair) {
        const boot = this.boot();
        const members = new Map(pair.members.map((m) => [String(m.entity_id), fullName(m)]));
        const since = Date.now() - TIMELINE_WINDOW_MS;
        const picked = [];
        for (let i = this.timeline.length - 1; i >= 0 && picked.length < TIMELINE_SHOWN * 3; i--) {
            const e = this.timeline[i];
            if (e.at < since) break;
            if (boot && e.boot && e.boot !== boot) continue;
            if (!members.has(e.a)) continue;
            picked.push(e);
        }
        picked.reverse();
        const named = await Promise.all(picked.map(async (e) => {
            const [what, target] = await Promise.all([
                this.d.world.interactionName(e.b).catch(() => ''),
                e.t && e.t !== e.a
                    ? (members.has(e.t) ? Promise.resolve(members.get(e.t)) : this.d.world.objectDisplayName(e.t).catch(() => ''))
                    : Promise.resolve('')
            ]);
            return { who: members.get(e.a), whoId: e.a, what: what || e.b, bag: e.b, target, time: e.time, end: e.end, endTime: e.endTime || '', why: e.why || '' };
        }));
        // The game plays one job as several steps under the same name; one line says it.
        const lines = [];
        for (const n of named) {
            const last = lines.length ? lines[lines.length - 1] : null;
            if (last && last.whoId === n.whoId && last.what === n.what && last.target === n.target) {
                last.end = n.end;
                last.endTime = n.endTime;
                last.why = n.why;
                continue;
            }
            lines.push(n);
        }
        const latest = new Map();
        for (let i = 0; i < lines.length; i++) latest.set(lines[i].whoId, i);
        for (let i = 0; i < lines.length; i++) lines[i].latest = latest.get(lines[i].whoId) === i;
        return lines.slice(-TIMELINE_SHOWN);
    }
}

module.exports = { Scene };
