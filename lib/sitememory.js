'use strict';
// What is placed at each site, as last seen by a site-wide scan. The game only scans the site of
// the character being played, so a family member at home while the player is out would otherwise
// see nothing to use. Entries are only a list of candidates: every action on them is still read
// live from the game before it is offered or run, so a stale entry can never start anything.
const fsx = require('./fsx');

const VERSION = 1;
const MAX_SITES = 40;
const MAX_OBJECTS_PER_SITE = 2000;
const SAVE_DELAY_MS = 2000;
// A rescan that changes nothing only refreshes the timestamp; that alone is saved this rarely.
const TOUCH_SAVE_MS = 10 * 60000;

function str(v) {
    return v === undefined || v === null ? '' : String(v).trim();
}

function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
}

function cleanObject(o) {
    const id = str(o && o.id);
    const name = str(o && o.name);
    if (!id || !name) return null;
    const out = { id, name };
    const x = num(o.x);
    const y = num(o.y);
    const z = num(o.z);
    if (x !== null && y !== null) {
        out.x = Math.round(x);
        out.y = Math.round(y);
        if (z !== null) out.z = Math.round(z);
    }
    const useful = num(o.useful);
    if (useful !== null) out.useful = useful;
    return out;
}

function cleanSite(id, s) {
    if (!id || !s || !Array.isArray(s.objects)) return null;
    const objects = [];
    const seen = new Set();
    for (const raw of s.objects) {
        const o = cleanObject(raw);
        if (!o || seen.has(o.id)) continue;
        seen.add(o.id);
        objects.push(o);
        if (objects.length >= MAX_OBJECTS_PER_SITE) break;
    }
    return { name: str(s.name), scannedAt: num(s.scannedAt) || 0, objects };
}

// Same objects, same names, same places to the centimetre.
function sameObjects(a, b) {
    if (a.length !== b.length) return false;
    const byId = new Map(a.map((o) => [o.id, o]));
    for (const o of b) {
        const p = byId.get(o.id);
        if (!p || p.name !== o.name || p.x !== o.x || p.y !== o.y || p.z !== o.z) return false;
    }
    return true;
}

class SiteMemory {
    // file: JSON store. readOnly: load and answer, never write (for one-off CLI commands that run
    // next to the service and must not race its saves).
    constructor(file, log, options) {
        const o = options || {};
        this.file = file;
        this.log = log || { debug() {}, info() {}, warn() {} };
        this.readOnly = !!o.readOnly;
        this.sites = new Map();
        this.owner = new Map();
        this.dirty = false;
        this.timer = null;
        this.savedAt = 0;
        this.load();
    }

    load() {
        const r = fsx.readJson(this.file);
        if (!r.ok) {
            if (!r.missing) this.log.warn('site memory unreadable, starting empty: ' + r.error);
            return;
        }
        const v = r.value;
        if (!v || v.v !== VERSION || !v.sites || typeof v.sites !== 'object') return;
        for (const id of Object.keys(v.sites)) {
            const s = cleanSite(id, v.sites[id]);
            if (s) this.sites.set(id, s);
        }
        this.reindex();
        this.savedAt = Date.now();
    }

    reindex() {
        this.owner.clear();
        for (const [siteId, s] of this.sites) {
            for (const o of s.objects) this.owner.set(o.id, siteId);
        }
    }

    // rows: [{ id, name, x, y, z }] from one complete scan of siteId, world coordinates in cm.
    remember(siteId, siteName, rows) {
        const id = str(siteId);
        if (!id) return false;
        const before = this.sites.get(id);
        const keep = new Map(before ? before.objects.map((o) => [o.id, o.useful]) : []);
        const next = cleanSite(id, { name: siteName, scannedAt: Date.now(), objects: rows || [] });
        if (!next) return false;
        for (const o of next.objects) {
            const useful = keep.get(o.id);
            if (typeof useful === 'number') o.useful = useful;
        }
        const changed = !before || before.name !== next.name || !sameObjects(before.objects, next.objects);
        this.sites.set(id, next);
        this.prune();
        this.reindex();
        if (changed) {
            this.log.info('site memory: ' + (next.name || id) + ' has ' + next.objects.length + ' object(s)' + (before ? ' (was ' + before.objects.length + ')' : ''));
            this.markDirty();
        } else if (Date.now() - this.savedAt > TOUCH_SAVE_MS) {
            this.markDirty();
        }
        return changed;
    }

    // { name, scannedAt, objects } or null.
    recall(siteId) {
        const s = this.sites.get(str(siteId));
        if (!s || !s.objects.length) return null;
        return { name: s.name, scannedAt: s.scannedAt, objects: s.objects.slice() };
    }

    // The best usefulness the game's own action list gave this object, so a site scanned while
    // the player was there can still be offered in a sensible order when no distance is known.
    noteUseful(objectId, score) {
        const id = str(objectId);
        const siteId = this.owner.get(id);
        if (!siteId || typeof score !== 'number') return;
        const s = this.sites.get(siteId);
        const o = s && s.objects.find((x) => x.id === id);
        if (!o || o.useful === score) return;
        o.useful = score;
        this.markDirty();
    }

    prune() {
        if (this.sites.size <= MAX_SITES) return;
        const oldest = Array.from(this.sites.entries()).sort((a, b) => a[1].scannedAt - b[1].scannedAt);
        for (let i = 0; i < oldest.length - MAX_SITES; i++) this.sites.delete(oldest[i][0]);
    }

    markDirty() {
        if (this.readOnly) return;
        this.dirty = true;
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, SAVE_DELAY_MS);
        if (this.timer.unref) this.timer.unref();
    }

    flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.readOnly || !this.dirty) return;
        const sites = {};
        for (const [id, s] of this.sites) sites[id] = s;
        try {
            fsx.writeJson(this.file, { v: VERSION, savedAt: Date.now(), sites });
            this.dirty = false;
            this.savedAt = Date.now();
        } catch (e) {
            this.log.warn('site memory not saved: ' + (e && e.message || e));
        }
    }
}

module.exports = { SiteMemory };
