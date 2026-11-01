'use strict';
// Copies character portraits from the game's save folders into the phone UI.
//
// The game writes one PNG per character at
//   <Documents>/inZOI/SaveGames/<folder>/<slot>/Portrait/<entityId>.png
// Those files are only ever read. The copy lands in ui/phone/portraits/<id>.png
// (temp file, size check, then rename). index.cfg tells the phone which ids exist
// and supplies the cache-busting mtime. Texts and Moments ask for the ids they show;
// nothing else is copied.

const fs = require('fs');
const os = require('os');
const path = require('path');
const fsx = require('./fsx');
const paths = require('./paths');

const ID_RE = /^\d+$/;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_MS = 60 * 1000;

function defaultRoots() {
    const home = os.homedir();
    const listed = paths.saveGameRoots().concat([
        path.join(home, 'Documents', 'inZOI', 'SaveGames'),
        path.join(home, 'OneDrive', 'Documents', 'inZOI', 'SaveGames')
    ]);
    const seen = new Set();
    const out = [];
    for (const dir of listed) {
        let key;
        try { key = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir); }
        catch (e) { key = path.resolve(dir); }
        key = key.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(dir);
    }
    return out;
}

function isPng(buf) {
    if (!buf || buf.length < PNG_SIG.length) return false;
    for (let i = 0; i < PNG_SIG.length; i++) if (buf[i] !== PNG_SIG[i]) return false;
    return true;
}

function inside(parent, child) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (rel.indexOf('..') !== 0 && !path.isAbsolute(rel));
}

class Portraits {
    constructor(log) {
        this.log = log || null;
        this.dir = '';
        this.roots = defaultRoots();
        this.slots = [];
        this.slotsAt = 0;
        this.found = new Map();
        this.missed = new Set();
        this.bad = new Set();
        this.announced = false;
        this.warned = false;
        this.prefer = [];
        this.avoid = [];
    }

    // Save folders of the household being played, and folders of other households that reuse
    // its entity ids: the same file name there is someone else's face.
    scope(prefer, avoid) {
        const p = (prefer || []).map((d) => path.resolve(d));
        const a = (avoid || []).map((d) => path.resolve(d)).filter((d) => p.indexOf(d) < 0);
        if (p.join('|') === this.prefer.join('|') && a.join('|') === this.avoid.join('|')) return;
        this.prefer = p;
        this.avoid = a;
        this.found = new Map();
        this.missed = new Set();
    }

    // Top-level save folders and how many of these ids have a portrait in them.
    saveFolders(ids) {
        this.refreshSlots();
        const want = (ids || []).map(String).filter((id) => ID_RE.test(id));
        const byDir = new Map();
        for (const slot of this.slots) {
            const top = this.topFolder(slot);
            if (!top) continue;
            let f = byDir.get(top);
            if (!f) {
                f = { dir: top, have: new Set(), newest: 0 };
                byDir.set(top, f);
            }
            for (const id of want) {
                let st;
                try { st = fs.statSync(path.join(slot, id + '.png')); }
                catch (e) { continue; }
                if (!st.isFile()) continue;
                f.have.add(id);
                if (st.mtimeMs > f.newest) f.newest = Math.round(st.mtimeMs);
            }
        }
        return Array.from(byDir.values()).map((f) => ({ dir: f.dir, count: f.have.size, newest: f.newest }));
    }

    topFolder(slot) {
        for (const root of this.roots) {
            const rel = path.relative(path.resolve(root), path.resolve(slot));
            if (!rel || rel.indexOf('..') === 0 || path.isAbsolute(rel)) continue;
            return path.join(path.resolve(root), rel.split(path.sep)[0]);
        }
        return '';
    }

    configure(phoneDir, options) {
        const next = path.join(phoneDir, 'portraits');
        const roots = options && options.roots ? options.roots.slice() : defaultRoots();
        if (next === this.dir && roots.join('|') === this.roots.join('|')) return;
        this.dir = next;
        this.roots = roots;
        this.slots = [];
        this.slotsAt = 0;
        this.found = new Map();
        this.missed = new Set();
        this.bad = new Set();
        this.announced = false;
        this.warned = false;
    }

    // ids: entity ids shown on Texts or Moments. Unknown ids keep the letter avatar.
    sync(ids) {
        if (!this.dir) return { copied: 0, known: 0 };
        const want = [];
        const seen = new Set();
        for (const raw of ids || []) {
            const id = String(raw);
            if (!ID_RE.test(id) || seen.has(id)) continue;
            seen.add(id);
            want.push(id);
        }
        if (!want.length) return { copied: 0, known: 0 };
        this.refreshSlots();
        fsx.ensureDir(this.dir);
        this.sweepTmp();
        const files = this.readManifestFiles();
        let copied = 0;
        let known = 0;
        let dirty = false;
        for (const id of want) {
            const src = this.locate(id);
            if (!src) continue;
            known += 1;
            const dest = path.join(this.dir, id + '.png');
            const prev = files[id];
            if (prev && prev.mtime === src.mtime && prev.size === src.size && this.sameSize(dest, src.size)) continue;
            if (!this.copyPng(id, src, dest)) continue;
            files[id] = { mtime: src.mtime, size: src.size };
            copied += 1;
            dirty = true;
            this.say('info', 'portraits: ' + id + ' updated (' + src.size + ' bytes)');
        }
        if (dirty) this.writeManifest(files);
        return { copied: copied, known: known };
    }

    refreshSlots() {
        const now = Date.now();
        if (this.slotsAt && now - this.slotsAt < CACHE_MS) return;
        const slots = [];
        let foundRoot = false;
        for (const root of this.roots) {
            if (!fs.existsSync(root)) continue;
            foundRoot = true;
            this.collectSlots(root, slots);
        }
        this.slots = slots;
        this.slotsAt = now;
        this.found = new Map();
        if (!foundRoot) {
            if (!this.warned) {
                this.warned = true;
                this.say('warn', 'portraits: no SaveGames folder found');
            }
            return;
        }
        if (!this.announced) {
            this.announced = true;
            this.say('info', 'portraits: watching ' + slots.length + ' save slot(s)');
        }
    }

    // SaveGames/<folder>/<slot>/Portrait, and a Portrait sitting directly on the first level.
    collectSlots(root, slots) {
        let entries;
        try { entries = fs.readdirSync(root, { withFileTypes: true }); }
        catch (e) { return; }
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const folder = path.join(root, ent.name);
            this.takeSlot(path.join(folder, 'Portrait'), slots);
            let inner;
            try { inner = fs.readdirSync(folder, { withFileTypes: true }); }
            catch (e) { continue; }
            for (const child of inner) {
                if (!child.isDirectory()) continue;
                this.takeSlot(path.join(folder, child.name, 'Portrait'), slots);
            }
        }
    }

    takeSlot(dir, slots) {
        let st;
        try { st = fs.statSync(dir); }
        catch (e) { return; }
        if (!st.isDirectory()) return;
        if (this.dir && inside(this.dir, dir)) return;
        slots.push(dir);
    }

    locate(id) {
        const now = Date.now();
        const cached = this.found.get(id);
        if (cached && now - cached.at < CACHE_MS) return cached.src;
        const options = [];
        for (const dir of this.slots) {
            const file = path.join(dir, id + '.png');
            if (this.dir && inside(this.dir, file)) continue;
            let st;
            try { st = fs.statSync(file); }
            catch (e) { continue; }
            if (!st.isFile() || st.size < PNG_SIG.length || st.size > MAX_BYTES) continue;
            options.push({ file: file, mtime: Math.round(st.mtimeMs), size: st.size });
        }
        const within = (file, dirs) => dirs.some((d) => inside(d, file));
        const ours = options.filter((o) => within(o.file, this.prefer));
        const pool = ours.length ? ours : options.filter((o) => !within(o.file, this.avoid));
        pool.sort((a, b) => b.mtime - a.mtime || b.size - a.size);
        let best = null;
        for (const item of pool) {
            const mark = item.file + '@' + item.mtime + ':' + item.size;
            if (this.bad.has(mark)) continue;
            if (!this.headOk(item.file)) {
                this.bad.add(mark);
                this.say('warn', 'portraits: ' + id + '.png is not a usable image');
                continue;
            }
            best = item;
            break;
        }
        this.found.set(id, { at: now, src: best });
        if (!best && !this.missed.has(id)) {
            this.missed.add(id);
            this.say('debug', 'portraits: no saved portrait for ' + id);
        }
        return best;
    }

    headOk(file) {
        let fd = null;
        try {
            fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(PNG_SIG.length);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            return n === buf.length && isPng(buf);
        } catch (e) {
            return false;
        } finally {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch (ignored) { /* already closed */ }
            }
        }
    }

    sameSize(file, size) {
        try { return fs.statSync(file).size === size; }
        catch (e) { return false; }
    }

    copyPng(id, src, dest) {
        if (this.dir && !inside(this.dir, dest)) {
            this.say('warn', 'portraits: refused to write outside the phone folder');
            return false;
        }
        let buf;
        try { buf = fs.readFileSync(src.file); }
        catch (e) {
            this.say('warn', 'portraits: cannot read ' + id + '.png: ' + e.message);
            return false;
        }
        if (buf.length !== src.size || !isPng(buf)) {
            this.bad.add(src.file + '@' + src.mtime + ':' + src.size);
            this.found.delete(id);
            this.say('warn', 'portraits: ' + id + '.png is not a usable image');
            return false;
        }
        const tmp = dest + '.' + process.pid + '.' + Date.now() + '.tmp';
        try {
            fs.writeFileSync(tmp, buf);
            const written = fs.statSync(tmp);
            if (written.size !== buf.length) throw new Error('temp file truncated');
            this.replace(tmp, dest);
            const out = fs.statSync(dest);
            if (out.size !== buf.length) throw new Error('copied portrait truncated');
            return true;
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch (ignored) { /* already moved or missing */ }
            this.say('warn', 'portraits: cannot update ' + id + '.png: ' + e.message);
            return false;
        }
    }

    replace(tmp, dest) {
        let last = null;
        for (let i = 0; i < 25; i++) {
            try {
                fs.renameSync(tmp, dest);
                return;
            } catch (e) {
                last = e;
                if (!e || ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].indexOf(e.code) < 0) throw e;
                fsx.sleepSync(40);
            }
        }
        throw last;
    }

    sweepTmp() {
        let names;
        try { names = fs.readdirSync(this.dir); }
        catch (e) { return; }
        for (const name of names) {
            if (!/\.tmp$/i.test(name)) continue;
            try { fs.unlinkSync(path.join(this.dir, name)); } catch (e) { /* in use */ }
        }
    }

    readManifestFiles() {
        const r = fsx.readJson(path.join(this.dir, 'index.cfg'));
        if (!r.ok || !r.value || !r.value.files || typeof r.value.files !== 'object' || Array.isArray(r.value.files)) return {};
        return r.value.files;
    }

    writeManifest(files) {
        fsx.writeJson(path.join(this.dir, 'index.cfg'), { v: 1, updatedAt: Date.now(), files: files }, true);
    }

    say(level, message) {
        if (this.log && typeof this.log[level] === 'function') this.log[level](message);
    }
}

module.exports = { Portraits, defaultRoots };
