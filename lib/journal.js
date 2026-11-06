'use strict';
// Reads the HouseholdJournal Lua mod's lines from the game's Lua log, read-only. The mod prints
// one line per start / finish / cancel / fail of the played household's interactions, with the
// game's own cancel or fail reason, food state reports, and the answers to chat moodlet
// requests. Only bytes appended after the bridge started are read.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TAG = '[HouseholdJournal] ';
const DEFAULT_FILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'BlueClient', 'Saved', 'inzoi_lua.log');
const KEEP_PER_ACTOR = 60;
const ALIVE_MS = 90000;
// The B2 handlers (meals, buffs, freelance, messages, preferences) count as gone once the mod has
// run this long without a W line from them while its own heartbeat still arrives.
const HANDLERS_SILENT_MS = 90000;
const MAX_READ = 1 << 20;
const FOOD_FRESH_MS = 120000;

// One age line, parsed. Module level so a one-shot command can read the last one off the log
// without starting a tailer (see agingFromLog in bridge.js) and get exactly what the reply
// service gets.
function parseAgeReport(body) {
    const entries = [];
    const semi = String(body || '').indexOf(';');
    if (semi < 0) return entries;
    for (const part of String(body).slice(semi + 1).split(';')) {
        const f = part.split(':');
        if (f.length < 3) continue;
        const id = String(f[0] || '').replace(/[^0-9]/g, '');
        if (!id) continue;
        entries.push({
            id,
            step: Number(f[1]) || 0,
            age: Number(f[2]),
            progress: Number(f[3]),
            dead: Number(f[4]),
            born: Number(f[5])
        });
    }
    return entries;
}

class Journal {
    constructor(options) {
        const o = options || {};
        this.file = o.file || DEFAULT_FILE;
        this.log = o.log || null;
        this.offset = null;
        this.partial = '';
        this.byActor = new Map();
        this.beatAt = 0;
        this.boot = '';
        this.bootAt = 0;
        this.handlersAt = 0;
        this.handlersWereDown = false;
        this.members = 0;
        this.features = new Set();
        this.food = null;
        this.foodAt = 0;
        this.stored = null;
        this.storedAt = 0;
        // Counts M reports, so "listed after X happened" does not depend on clock resolution.
        this.storedSeq = 0;
        this.listeners = [];
        this.buffListeners = [];
        this.mealListeners = [];
        this.restartListeners = [];
        this.worldListeners = [];
        this.freelanceListeners = [];
        this.prefListeners = [];
        this.careerListeners = [];
        this.ageListeners = [];
    }

    // fn(entries) for each A line: the played household's ages, in days, as the Bio component
    // holds them (see lib/aging.js). entries = [{ id, step, age, progress, dead, born }].
    onAge(fn) {
        this.ageListeners.push(fn);
    }

    // fn({ at, event, a, b, c, d }) for each world event line (zoi.died, weather.changed ...).
    onWorld(fn) {
        this.worldListeners.push(fn);
    }

    // fn(kind, body) for each freelance line: L / A / P / O (the board) and R (request results),
    // printed by the mod's Zoi.FreelanceServer; see lib/freelance.js.
    onFreelance(fn) {
        this.freelanceListeners.push(fn);
    }

    // fn({ seq, ok, actor, pref, like, detail }) for each K line: a like or dislike the bridge asked for.
    onPref(fn) {
        this.prefListeners.push(fn);
    }

    // fn({ seq, ok, actor, op, detail }) for each C line: an OA request the bridge asked the mod to carry out.
    onCareer(fn) {
        this.careerListeners.push(fn);
    }

    onMeal(fn) {
        this.mealListeners.push(fn);
    }

    // The Lua mod started again: a save was loaded, the game restarted or the mod was remounted.
    // Whatever it was doing for the bridge is gone, and the world may be an older one.
    onRestart(fn) {
        this.restartListeners.push(fn);
    }

    onEvent(fn) {
        this.listeners.push(fn);
    }

    onBuff(fn) {
        this.buffListeners.push(fn);
    }

    alive(now) {
        return !!this.beatAt && (now || Date.now()) - this.beatAt < ALIVE_MS;
    }

    seenWithin(ms) {
        return !!this.beatAt && Date.now() - this.beatAt < ms;
    }

    // Reads whatever was appended since the last call. Returns the new interaction events.
    poll() {
        let st;
        try {
            st = fs.statSync(this.file);
        } catch (e) {
            return [];
        }
        if (this.offset === null || st.size < this.offset) {
            // First look, or the game started a new log: begin at the end, never replay history.
            const fresh = this.offset !== null;
            this.offset = fresh ? 0 : st.size;
            this.partial = '';
            if (!fresh) return [];
        }
        if (st.size === this.offset) return [];
        const length = Math.min(st.size - this.offset, MAX_READ);
        const buf = Buffer.alloc(length);
        let fd = null;
        try {
            fd = fs.openSync(this.file, 'r');
            fs.readSync(fd, buf, 0, length, this.offset);
        } catch (e) {
            return [];
        } finally {
            if (fd !== null) fs.closeSync(fd);
        }
        this.offset += length;
        const text = this.partial + buf.toString('utf8');
        const lines = text.split(/\r?\n/);
        this.partial = lines.pop();
        const out = [];
        for (const line of lines) {
            const at = line.indexOf(TAG);
            if (at < 0) continue;
            const body = line.slice(at + TAG.length).trim();
            if (body.indexOf('H ') === 0) this.heartbeat(body.slice(2));
            else if (body.indexOf('W ') === 0) this.handlersAt = Date.now();
            else if (/^A \d+;/.test(body)) this.ageReport(body.slice(2));
            else if (body.indexOf('F ') === 0) this.foodReport(body.slice(2));
            else if (body.indexOf('B ') === 0) this.buffResult(body.slice(2));
            else if (body.indexOf('M ') === 0) this.storedReport(body.slice(2));
            else if (body.indexOf('T ') === 0) this.mealResult(body.slice(2));
            else if (body.indexOf('E ') === 0) this.worldEvent(body.slice(2));
            else if (body.indexOf('K ') === 0) this.prefResult(body.slice(2));
            else if (body.indexOf('C ') === 0) this.careerResult(body.slice(2));
            else if (/^[LAPOR] /.test(body)) this.freelanceLine(body.charAt(0), body.slice(2));
            else if (body.indexOf('J ') === 0) {
                const ev = this.parse(body.slice(2));
                if (ev) out.push(ev);
            }
        }
        this.checkHandlers();
        for (const ev of out) {
            for (const fn of this.listeners) {
                try { fn(ev); } catch (e) { if (this.log) this.log.warn('journal listener: ' + e.message); }
            }
        }
        return out;
    }

    heartbeat(body) {
        const f = body.split(',');
        this.beatAt = Date.now();
        if (f[0] && f[0] !== this.boot) {
            const restarted = !!this.boot;
            if (restarted && this.log) this.log.info('journal: Lua mod restarted');
            this.boot = f[0];
            this.bootAt = Date.now();
            if (restarted) {
                for (const fn of this.restartListeners) {
                    try { fn(); } catch (e) { if (this.log) this.log.warn('journal restart listener: ' + e.message); }
                }
            }
        }
        this.members = Number(f[1]) || 0;
        // Older versions of the mod print no features field.
        this.features = new Set(String(f[4] || '').split('|').map((s) => s.trim()).filter(Boolean));
    }

    // The mod's age line: <boot>;<id>:<growth>:<age>:<progress>:<death age>:<born day>:<paused>;...
    // Growth is printed as the number behind EB1GrowthStep; lib/aging.js names it.
    ageReport(body) {
        const entries = parseAgeReport(body);
        if (!entries.length) return;
        for (const fn of this.ageListeners) {
            try { fn(entries); } catch (e) { if (this.log) this.log.warn('journal age listener: ' + e.message); }
        }
    }

    // The mod runs, says it beats for its B2 handlers, and they have been silent too long: they
    // were dropped (another Lua mod reloaded) and requests to them would never be answered.
    handlersDown(now) {
        const t = now || Date.now();
        if (!this.can('beat') || !this.bootAt) return false;
        const since = Math.max(this.bootAt, this.handlersAt);
        return t - since > HANDLERS_SILENT_MS;
    }

    // Logs the change once each way.
    checkHandlers() {
        const down = this.handlersDown();
        if (down === this.handlersWereDown) return;
        this.handlersWereDown = down;
        if (!this.log) return;
        if (down) {
            this.log.warn('journal: the HouseholdJournal B2 handlers are down (no W line for ' + Math.round(HANDLERS_SILENT_MS / 1000) +
                's while the mod runs). Meals, moodlets, freelance, game texts and preferences will not be answered. ' +
                'Restart inZOI to load them again; reloading a Lua mod while a save is open drops them and can crash the game.');
        } else {
            this.log.info('journal: the HouseholdJournal B2 handlers are back');
        }
    }

    // The running mod says it can do this (see the H line); false until a heartbeat says so.
    can(feature) {
        return !!(this.alive() && this.features && this.features.has(feature));
    }

    // "<boot>,<walked>,<ms>;<id>:<s|e>:<left>;..." -- every food in the world that needs dealing
    // with. Each report replaces the last; anything not in it is fine or not food.
    foodReport(body) {
        const parts = body.split(';');
        const head = parts.shift().split(',');
        if (head.length < 2 || parts[0] && parts[0].charAt(0) === '!') return;
        const food = new Map();
        for (const p of parts) {
            const f = p.split(':');
            if (!f[0] || (f[1] !== 's' && f[1] !== 'e' && f[1] !== 'f')) continue;
            const left = Number(f[2]);
            food.set(f[0], { spoiled: f[1] === 's', empty: f[1] === 'e', edible: f[1] === 'f', left: isFinite(left) && left >= 0 ? left : null });
        }
        this.food = food;
        this.foodAt = Date.now();
        this.beatAt = this.foodAt;
    }

    // "<boot>,<seq>,<ok|fail>,<target>,<buff id>,<why>" -- the answer to one chat moodlet request.
    buffResult(body) {
        const f = body.split(',');
        if (f.length < 5 || !f[1]) return;
        const res = { seq: f[1], ok: f[2] === 'ok', target: f[3], buff: f[4], why: f.slice(5).join(',') };
        for (const fn of this.buffListeners) {
            try { fn(res); } catch (e) { if (this.log) this.log.warn('journal buff listener: ' + e.message); }
        }
    }

    // "<boot>;<id>:<container>:<object id>:<left>:<servings>:<s|f>;..." -- every family meal kept
    // in a container. Each report replaces the last; an empty list means none anywhere.
    storedReport(body) {
        const parts = body.split(';');
        parts.shift();
        const stored = new Map();
        for (const p of parts) {
            const f = p.split(':');
            if (f.length < 6 || !/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1]) || !f[2]) continue;
            const left = Number(f[3]);
            const total = Number(f[4]);
            const dish = {
                id: f[0],
                container: f[1],
                objectId: f[2],
                left: isFinite(left) && left >= 0 ? left : null,
                total: isFinite(total) && total > 0 ? total : null,
                spoiled: f[5] === 's'
            };
            if (!stored.has(dish.container)) stored.set(dish.container, []);
            stored.get(dish.container).push(dish);
        }
        this.stored = stored;
        this.storedAt = Date.now();
        this.storedSeq += 1;
        this.beatAt = this.storedAt;
    }

    // The container a family meal was listed in by the latest report, '' when it was not.
    storedContainerOf(dishId) {
        if (!this.stored) return '';
        for (const [container, list] of this.stored) {
            if (list.some((d) => d.id === String(dishId))) return container;
        }
        return '';
    }

    // Family meals inside one container, from the latest report. null when nothing recent is known.
    storedIn(containerId, maxAgeMs) {
        if (!this.stored || !this.alive() || Date.now() - this.storedAt > maxAgeMs) return null;
        return this.stored.get(String(containerId)) || [];
    }

    // "<boot>,<seq>,<stage>,<actor>,<dish>,<detail>" -- progress of one family meal request.
    mealResult(body) {
        const f = body.split(',');
        if (f.length < 5) return;
        const res = { seq: f[1], stage: f[2], actor: f[3], dish: f[4], detail: f.slice(5).join(',') };
        for (const fn of this.mealListeners) {
            try { fn(res); } catch (e) { if (this.log) this.log.warn('journal meal listener: ' + e.message); }
        }
    }

    // "<boot>,<seq>,<event>,<a>,<b>,<c>,<d>" -- one world event; what a..d hold depends on the event
    // (see the E line in the mod's Main.lua).
    worldEvent(body) {
        const f = body.split(',');
        if (f.length < 4 || !/^[a-z]+\.[a-z_]+$/.test(f[2] || '')) return;
        const ev = { at: Date.now(), seq: Number(f[1]) || 0, event: f[2], a: f[3] || '', b: f[4] || '', c: f[5] || '', d: f[6] || '' };
        this.beatAt = ev.at;
        for (const fn of this.worldListeners) {
            try { fn(ev); } catch (e) { if (this.log) this.log.warn('journal world listener: ' + e.message); }
        }
    }

    // "<boot>,<seq>,<ok|fail>,<actor>,<preference id>,<1|0>,<detail>" -- see lib/preferences.js.
    prefResult(body) {
        const f = body.split(',');
        if (f.length < 7 || !f[1]) return;
        const res = { seq: f[1], ok: f[2] === 'ok', actor: f[3], pref: f[4], like: f[5] === '1', detail: f.slice(6).join(',') };
        for (const fn of this.prefListeners) {
            try { fn(res); } catch (e) { if (this.log) this.log.warn('journal preference listener: ' + e.message); }
        }
    }

    // <boot>,<seq>,<ok|fail>,<character>,<op>,<detail>
    careerResult(body) {
        const f = body.split(',');
        if (f.length < 6 || !f[1]) return;
        const res = { seq: f[1], ok: f[2] === 'ok', actor: f[3], op: f[4], detail: f.slice(5).join(',') };
        for (const fn of this.careerListeners) {
            try { fn(res); } catch (e) { if (this.log) this.log.warn('journal career listener: ' + e.message); }
        }
    }

    freelanceLine(kind, body) {
        this.beatAt = Date.now();
        for (const fn of this.freelanceListeners) {
            try { fn(kind, body); } catch (e) { if (this.log) this.log.warn('journal freelance listener: ' + e.message); }
        }
    }

    // Spoiled or emptied food, from the latest report while the mod is running.
    foodState(id) {
        if (!this.food || !this.alive() || Date.now() - this.foodAt > FOOD_FRESH_MS) return null;
        return this.food.get(String(id)) || null;
    }

    parse(body) {
        const f = body.split(',');
        if (f.length < 7) return null;
        const ev = {
            at: Date.now(),
            seq: Number(f[1]) || 0,
            kind: f[2],
            actor: f[3],
            bag: f[4],
            target: f[5] && f[5] !== '-1' ? f[5] : '',
            reason: f[6] || ''
        };
        // An event line is as good as a heartbeat; the mod is running.
        this.beatAt = ev.at;
        if (f[0] !== this.boot) this.boot = f[0];
        let list = this.byActor.get(ev.actor);
        if (!list) {
            list = [];
            this.byActor.set(ev.actor, list);
        }
        list.push(ev);
        if (list.length > KEEP_PER_ACTOR) list.splice(0, list.length - KEEP_PER_ACTOR);
        return ev;
    }

    // The last way one of these bags ended for this actor since a moment: finished / canceled /
    // failed, with the game's reason. null when the journal saw no end. A cancel of a bag in
    // `replaced` is the task itself swapping one step for another and is not an end.
    endOf(actorId, bags, since, replaced) {
        const list = this.byActor.get(String(actorId)) || [];
        const want = new Set((bags || []).map(String));
        const swapped = new Set((replaced || []).map(String));
        for (let i = list.length - 1; i >= 0; i--) {
            const ev = list[i];
            if (ev.at < since) break;
            if (ev.kind === 'started' || !want.has(ev.bag)) continue;
            if (ev.kind === 'canceled' && swapped.has(ev.bag)) continue;
            return ev;
        }
        return null;
    }
}

module.exports = { Journal, DEFAULT_FILE, parseAgeReport };
