'use strict';
// Which household the bridge files belong to.
//
// The game hands out entity ids again in every new world, so a new household can get the
// same ids as one played before. Everything the bridge keeps (memory, diaries, chronicle,
// the phone's texts ...) is filed by those ids. The registry remembers who had which id. When
// the ids of the household now played belong to other people, the files of the household that
// was on are moved into its archive, and those of the household now played come back from
// theirs or start empty. Nothing is deleted; a file that is in the way is moved aside.
//
//   data/households/registry.json            registry, written only here; the copy that counts
//   data/households.json                     the same registry, written after it, for people to read
//   data/households/<tag>/data/<item>        bridge files of a household not being played
//   data/households/<tag>/phone/<dir>/<item> its phone files (texts, moments, persona, portraits, group chats)
//   data/households/switch.json              moves of a switch that has not finished
//   data/households/displaced-<time>/...     files found in the way during a switch
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');

const REGISTRY_VERSION = 1;
const SWITCH_VERSION = 1;
// Bridge files that describe the people and places of one household's world.
const DATA_ITEMS = [
    'memory', 'diary', 'knowhow', 'chronicle',
    'state.json', 'buffs-state.json', 'needs-state.json', 'moments-state.json',
    'scene-timeline.json', 'same-task.json', 'site-objects.json', 'rooms.json', 'groups',
    // A schoolmate courting the played character, the class chats, how far chats moved the game's
    // bonds today (suitor.js, classgroup.js, relsync.js): all about this household's people.
    'suitors.json', 'classgroups.json', 'relsync.json'
];
// Phone folders and which of their entries belong to the household. Requests and
// acknowledgements (sms/clear.cfg, moments/status.cfg ...) stay where they are.
const PHONE_ITEMS = [
    { dir: 'sms', match: /^\d+(-\d+)?$/ },
    { dir: 'moments', match: /^(\d+|feed\.cfg)$/ },
    // Per character: how they talk (personas.js) and the played character's Texts folders (app.js).
    { dir: 'persona', match: /^\d+$/ },
    { dir: 'portraits', match: /^(\d+\.png|index\.cfg)$/ },
    // Group chats are between this household's people; another save has other people under
    // the same ids, so they must not be answered there.
    { dir: 'groups', match: /^(g-[A-Za-z0-9_-]{1,40}|list\.cfg|school\.cfg)$/ },
    // The friend request card a suitor sent (suitor.js).
    { dir: 'suitor', match: /^board\.cfg$/ }
];
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID_RE = /^\d+$/;
const BUSY_CODES = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'];
const MOVE_TRIES = 40;
const MOVE_WAIT_MS = 125;
const TOUCH_EVERY_MS = 10 * 60000;

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function stamp(t) {
    const d = new Date(t);
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

function exists(p) {
    try { fs.lstatSync(p); return true; } catch (e) { return false; }
}

function inside(parent, child) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel !== '' && rel.indexOf('..') !== 0 && !path.isAbsolute(rel);
}

function sameName(a, b) {
    return !!a && !!b && a === b;
}

// { <entityId>: { first, full } } of household_get_members' members.
function rosterOf(members) {
    const roster = {};
    for (const m of members || []) {
        if (!m) continue;
        const id = String(m.entity_id == null ? '' : m.entity_id);
        if (!ID_RE.test(id)) continue;
        const first = String(m.first_name || '').trim();
        const full = (String(m.last_name || '') + String(m.first_name || '')).trim() || String(m.name || '').trim();
        if (!first && !full) continue;
        roster[id] = { first: first, full: full };
    }
    return roster;
}

// How many of the ids two rosters share name the same person, and how many name someone else.
// A married name keeps the first name, so either name matching counts as the same person.
function compare(known, now) {
    let same = 0;
    let diff = 0;
    for (const id of Object.keys(now)) {
        const k = known && known[id];
        if (!k) continue;
        const n = now[id];
        if (sameName(k.first, n.first) || sameName(k.full, n.full)) same += 1;
        else diff += 1;
    }
    return { same: same, diff: diff };
}

// The household is the one the roster describes. A single renamed member of a larger household
// does not make it someone else.
function belongs(c) {
    return c.same > 0 && (c.diff === 0 || (c.same >= 2 && c.same >= c.diff * 2));
}

function describe(entry) {
    if (!entry) return 'nobody';
    const names = Object.keys(entry.roster || {}).map((id) => entry.roster[id].full || entry.roster[id].first);
    return (entry.name ? entry.name + ' ' : '') + '[' + entry.tag + ']' + (names.length ? ' ' + names.join('、') : '');
}

function cleanEntry(tag, raw) {
    const v = raw && typeof raw === 'object' ? raw : {};
    const roster = {};
    const src = v.roster && typeof v.roster === 'object' ? v.roster : {};
    for (const id of Object.keys(src)) {
        if (!ID_RE.test(id) || !src[id] || typeof src[id] !== 'object') continue;
        roster[id] = { first: String(src[id].first || ''), full: String(src[id].full || '') };
    }
    return {
        tag: tag,
        householdId: v.householdId == null ? '' : String(v.householdId),
        name: typeof v.name === 'string' ? v.name : '',
        roster: roster,
        saves: Array.isArray(v.saves) ? v.saves.filter((s) => typeof s === 'string' && s) : [],
        firstSeen: Number(v.firstSeen) || 0,
        lastSeen: Number(v.lastSeen) || 0,
        archivedAt: Number(v.archivedAt) || 0,
        unclaimed: !!v.unclaimed
    };
}

function cleanRegistry(v) {
    const reg = {
        v: REGISTRY_VERSION,
        rev: Math.max(0, Math.floor(Number(v.rev) || 0)),
        savedAt: Number(v.savedAt) || 0,
        current: null,
        households: {}
    };
    for (const tag of Object.keys(v.households)) {
        if (TAG_RE.test(tag)) reg.households[tag] = cleanEntry(tag, v.households[tag]);
    }
    if (typeof v.current === 'string' && reg.households[v.current]) reg.current = v.current;
    return reg;
}

class SwitchError extends Error {}

// { reg } for a usable registry file, { missing: true }, or { error } when its content is not a
// registry. A file that is there but cannot be read now is an error of the start, not damage.
function readRegistry(file) {
    let raw;
    try {
        raw = fsx.readText(file);
    } catch (e) {
        throw new SwitchError('households: cannot read ' + file + ' (' + e.message + ')');
    }
    if (raw === null) return { reg: null, missing: true, error: '' };
    const text = raw.replace(/^\uFEFF/, '');
    let v;
    try {
        v = JSON.parse(text);
    } catch (e) {
        return { reg: null, missing: false, error: text.trim() ? 'invalid JSON: ' + e.message : 'empty file' };
    }
    if (!v || typeof v !== 'object' || !v.households || typeof v.households !== 'object') {
        return { reg: null, missing: false, error: 'not a household registry' };
    }
    return { reg: cleanRegistry(v), missing: false, error: '' };
}

class Households {
    constructor(options) {
        const o = options || {};
        this.dataDir = o.dataDir;
        this.phoneDir = o.phoneDir || '';
        this.log = o.log || { debug() {}, info() {}, warn() {}, error() {} };
        this.root = path.join(this.dataDir, 'households');
        this.file = path.join(this.dataDir, 'households.json');
        this.authFile = path.join(this.root, 'registry.json');
        this.switchFile = path.join(this.root, 'switch.json');
        this.registry = null;
    }

    configure(phoneDir) {
        this.phoneDir = phoneDir || this.phoneDir;
    }

    // ------------------------------------------------------------------ registry
    // Editors, sync clients and restore tools write data/households.json back to an older
    // version. A start that trusted it would take the files on disk for someone else's and move
    // them into the wrong archive. The registry under data/households/ decides; the copy is only
    // brought back in line with it, and a copy that differs is kept aside.
    load() {
        const auth = readRegistry(this.authFile);
        const copy = readRegistry(this.file);
        if (auth.error) this.setAside(this.authFile, 'damaged', auth.error);
        let reg = auth.reg;
        if (!reg && copy.reg) {
            reg = copy.reg;
            if (!auth.missing) this.log.error('households: ' + this.authFile + ' was unreadable, rebuilt from ' + this.file + ' (revision ' + reg.rev + ')');
        }
        if (!reg) {
            if (copy.error) this.setAside(this.file, 'damaged', copy.error);
            reg = { v: REGISTRY_VERSION, rev: 0, savedAt: 0, current: null, households: {} };
        }
        this.registry = reg;
        if (!auth.reg) {
            if (copy.reg) this.writeAuth();
            return reg;
        }
        if (copy.error) {
            this.setAside(this.file, 'damaged', copy.error);
            this.writeCopy();
        } else if (copy.missing) {
            this.writeCopy();
        } else if (JSON.stringify(copy.reg) !== JSON.stringify(reg)) {
            this.log.warn('households: ' + this.file + ' was changed outside the bridge (revision ' + copy.reg.rev + ', current ' + (copy.reg.current || 'none')
                + '; registry revision ' + reg.rev + ', current ' + (reg.current || 'none') + '); the registry under ' + this.root + ' is used');
            this.setAside(this.file, 'outside', 'differs from ' + this.authFile);
            this.writeCopy();
        }
        return reg;
    }

    save() {
        const reg = this.registry;
        reg.v = REGISTRY_VERSION;
        reg.rev = (Number(reg.rev) || 0) + 1;
        reg.savedAt = Date.now();
        this.writeAuth();
        this.writeCopy();
    }

    writeAuth() {
        fsx.ensureDir(this.root);
        fsx.writeJson(this.authFile, this.registry, true);
    }

    // The copy is for reading; a locked or read-only copy does not stop the bridge.
    writeCopy() {
        try {
            fsx.writeJson(this.file, this.registry, true);
        } catch (e) {
            this.log.warn('households: could not update ' + this.file + ' (' + e.message + '); ' + this.authFile + ' is up to date');
        }
    }

    // A registry file that is not used any more is renamed, never deleted.
    setAside(file, why, detail) {
        let aside = file + '.' + why + '-' + stamp(Date.now());
        for (let i = 2; exists(aside); i++) aside = file + '.' + why + '-' + stamp(Date.now()) + '-' + i;
        try {
            this.rename(file, aside);
            this.log.warn('households: ' + file + ' (' + detail + ') kept as ' + aside);
        } catch (e) {
            this.log.error('households: could not keep ' + file + ' aside (' + e.message + ')');
        }
    }

    current() {
        if (!this.registry) this.load();
        return this.registry.current ? this.registry.households[this.registry.current] : null;
    }

    entry(tag) {
        if (!this.registry) this.load();
        return this.registry.households[tag] || null;
    }

    newTag(householdId, now) {
        const base = 'hh-' + (ID_RE.test(String(householdId)) ? householdId + '-' : '') + stamp(now);
        let tag = base;
        for (let i = 2; this.registry.households[tag] || exists(path.join(this.root, tag)); i++) tag = base + '-' + i;
        return tag;
    }

    // What the household now played means for the files on disk:
    //   { kind: 'same', entry }               the files are theirs
    //   { kind: 'first', entry }              nobody was recorded yet; the files are taken as theirs
    //   { kind: 'switch', from, to, fresh }   the files are someone else's
    // null while the game reports no members.
    identify(hh, now) {
        if (!this.registry) this.load();
        const t = now || Date.now();
        const roster = rosterOf(hh && hh.members);
        if (!Object.keys(roster).length) return null;
        const householdId = hh && hh.id != null ? String(hh.id) : '';
        const name = hh && typeof hh.name === 'string' ? hh.name : '';
        const cur = this.current();
        if (cur && !cur.unclaimed && belongs(compare(cur.roster, roster))) return { kind: 'same', entry: cur, roster: roster, name: name, householdId: householdId };
        let best = null;
        let bestScore = null;
        for (const tag of Object.keys(this.registry.households)) {
            const e = this.registry.households[tag];
            if (cur && e.tag === cur.tag) continue;
            const c = compare(e.roster, roster);
            if (!belongs(c)) continue;
            const score = [c.same - c.diff, e.householdId === householdId ? 1 : 0, e.lastSeen];
            if (!bestScore || score[0] > bestScore[0] || (score[0] === bestScore[0] && (score[1] > bestScore[1] || (score[1] === bestScore[1] && score[2] > bestScore[2])))) {
                best = e;
                bestScore = score;
            }
        }
        if (!cur && !best && !Object.keys(this.registry.households).length) {
            return { kind: 'first', entry: cleanEntry(this.newTag(householdId, t), { householdId: householdId, name: name, roster: roster, firstSeen: t, lastSeen: t }), roster: roster, name: name, householdId: householdId };
        }
        const to = best || cleanEntry(this.newTag(householdId, t), { householdId: householdId, name: name, roster: roster, firstSeen: t, lastSeen: t });
        let from = cur;
        if (!from) {
            // Files on disk with no recorded owner: they are kept under a household of their own.
            from = cleanEntry(this.newTag('', t), { name: '', firstSeen: t, lastSeen: t, unclaimed: true });
        }
        return { kind: 'switch', from: from, to: to, fresh: !best, roster: roster, name: name, householdId: householdId };
    }

    // Keeps the record of the household being played up to date. True when it was written.
    touch(entry, roster, name, householdId, now) {
        const t = now || Date.now();
        const e = this.registry.households[entry.tag] || entry;
        this.registry.households[e.tag] = e;
        let changed = false;
        for (const id of Object.keys(roster || {})) {
            const k = e.roster[id];
            const n = roster[id];
            if (!k || k.first !== n.first || k.full !== n.full) {
                if (k) this.log.info('households: ' + id + ' is now ' + n.full + ' (was ' + k.full + ')');
                e.roster[id] = { first: n.first, full: n.full };
                changed = true;
            }
        }
        if (name && e.name !== name) { e.name = name; changed = true; }
        if (householdId && e.householdId !== householdId) { e.householdId = householdId; changed = true; }
        if (!e.firstSeen) { e.firstSeen = t; changed = true; }
        if (this.registry.current !== e.tag) { this.registry.current = e.tag; changed = true; }
        if (changed || t - e.lastSeen > TOUCH_EVERY_MS) {
            e.lastSeen = t;
            this.save();
            return true;
        }
        return false;
    }

    // Records the save folder the household's portraits come from.
    setSaves(tag, saves) {
        const e = this.entry(tag);
        if (!e) return;
        const next = (saves || []).filter(Boolean);
        if (next.join('|') === e.saves.join('|')) return;
        e.saves = next;
        this.save();
    }

    // Save folders whose portraits are this household's, and those that belong to households
    // sharing its ids, whose pictures would show the wrong faces.
    portraitScope(tag) {
        const e = this.entry(tag);
        if (!e) return { prefer: [], avoid: [] };
        const prefer = e.saves.slice();
        const avoid = [];
        const ids = Object.keys(e.roster);
        for (const t of Object.keys(this.registry.households)) {
            if (t === tag) continue;
            const o = this.registry.households[t];
            if (!ids.some((id) => o.roster[id])) continue;
            for (const s of o.saves) {
                if (prefer.indexOf(s) < 0 && avoid.indexOf(s) < 0) avoid.push(s);
            }
        }
        return { prefer: prefer, avoid: avoid };
    }

    // ------------------------------------------------------------------ files
    areas() {
        const list = [{ name: 'data', live: this.dataDir, items: (live) => DATA_ITEMS.filter((n) => exists(path.join(live, n))) }];
        if (this.phoneDir) {
            for (const p of PHONE_ITEMS) {
                list.push({
                    name: 'phone/' + p.dir,
                    live: path.join(this.phoneDir, p.dir),
                    items: (live) => {
                        let names = [];
                        try { names = fs.readdirSync(live); } catch (e) { return []; }
                        return names.filter((n) => p.match.test(n)).sort();
                    }
                });
            }
        }
        return list;
    }

    archiveDir(tag) {
        if (!TAG_RE.test(tag)) throw new SwitchError('invalid household tag ' + tag);
        return path.join(this.root, tag);
    }

    // Every move of a switch, decided before the first one is made.
    plan(from, to) {
        const moves = [];
        const fromDir = this.archiveDir(from.tag);
        const toDir = this.archiveDir(to.tag);
        for (const a of this.areas()) {
            for (const n of a.items(a.live)) {
                moves.push({ src: path.join(a.live, n), dst: path.join(fromDir, a.name, n) });
            }
        }
        for (const a of this.areas()) {
            const kept = path.join(toDir, a.name);
            let names = [];
            try { names = fs.readdirSync(kept); } catch (e) { names = []; }
            for (const n of names.sort()) moves.push({ src: path.join(kept, n), dst: path.join(a.live, n) });
        }
        return moves;
    }

    checkMove(m) {
        const ok = (p) => inside(this.dataDir, p) || (this.phoneDir && inside(this.phoneDir, p));
        if (!ok(m.src) || !ok(m.dst)) throw new SwitchError('refused to move outside the bridge and phone folders: ' + m.src + ' -> ' + m.dst);
    }

    // The game reads the phone files through its own handles; a rename is retried while one is open.
    rename(src, dst) {
        let last = null;
        for (let i = 0; i < MOVE_TRIES; i++) {
            try {
                fs.renameSync(src, dst);
                return;
            } catch (e) {
                last = e;
                if (e && e.code === 'EXDEV') break;
                if (!e || BUSY_CODES.indexOf(e.code) < 0) throw e;
                fsx.sleepSync(MOVE_WAIT_MS);
            }
        }
        if (last && last.code === 'EXDEV') return this.copyAcross(src, dst);
        throw last;
    }

    // The phone folder is on another drive: copied, checked, and only then taken off the source.
    // File by file, with an explicit stack. fs.cpSync and fs.rmSync({recursive}) walk the tree
    // inside the runtime and, on the Node 24 this program ships, that walk ends the process
    // with STATUS_STACK_BUFFER_OVERRUN (exit 3221226505) instead of throwing. A thrown error
    // can be resumed; that exit cannot, so the next start dies in the same place.
    copyAcross(src, dst) {
        this.clearPartials(dst);
        const part = dst + '.partial-' + process.pid;
        let copied;
        try {
            copied = this.copyTree(src, part);
        } catch (e) {
            this.removeTree(part);
            throw e;
        }
        const got = this.tally(part);
        if (copied.files !== got.files || copied.bytes !== got.bytes) {
            this.removeTree(part);
            throw new SwitchError('copy of ' + src + ' is incomplete (' + got.files + '/' + copied.files + ' files, ' + got.bytes + '/' + copied.bytes + ' bytes); kept the original');
        }
        fs.renameSync(part, dst);
        this.removeTree(src);
    }

    // A previous attempt died after creating <dst>.partial-<pid>. Those copies are never a
    // finished move, so they are removed before this attempt starts.
    clearPartials(dst) {
        const parent = path.dirname(dst);
        const prefix = path.basename(dst) + '.partial-';
        let names = [];
        try { names = fs.readdirSync(parent); } catch (e) { return; }
        for (let i = 0; i < names.length; i++) {
            if (names[i].indexOf(prefix) === 0) this.removeTree(path.join(parent, names[i]));
        }
    }

    // Copies src onto dst. dst must not exist yet. Returns the file count and byte count
    // read from the source while copying. Links and anything that is not a file or a
    // directory are refused: following a link cycle is the other way into the same crash.
    copyTree(src, dst) {
        const root = fs.lstatSync(src);
        if (root.isSymbolicLink()) throw new SwitchError('refused to copy a link: ' + src);
        if (root.isFile()) {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
            return { files: 1, bytes: root.size };
        }
        if (!root.isDirectory()) throw new SwitchError('refused to copy a special file: ' + src);
        fs.mkdirSync(dst);
        const pending = [src];
        const seen = new Set();
        let files = 0;
        let bytes = 0;
        while (pending.length) {
            const dir = pending.pop();
            const real = fs.realpathSync(dir);
            if (seen.has(real)) throw new SwitchError('refused to copy a directory cycle: ' + dir);
            seen.add(real);
            const names = fs.readdirSync(dir);
            for (let i = 0; i < names.length; i++) {
                const from = path.join(dir, names[i]);
                const st = fs.lstatSync(from);
                const to = path.join(dst, path.relative(src, from));
                if (st.isSymbolicLink()) throw new SwitchError('refused to copy a link: ' + from);
                if (st.isDirectory()) {
                    fs.mkdirSync(to);
                    pending.push(from);
                } else if (st.isFile()) {
                    fs.copyFileSync(from, to);
                    files += 1;
                    bytes += st.size;
                } else {
                    throw new SwitchError('refused to copy a special file: ' + from);
                }
            }
        }
        return { files: files, bytes: bytes };
    }

    // File count and byte count, walked with a stack. Directories themselves are not counted,
    // matching what copyTree records.
    tally(root) {
        const st = fs.lstatSync(root);
        if (st.isSymbolicLink()) throw new SwitchError('refused to measure a link: ' + root);
        if (st.isFile()) return { files: 1, bytes: st.size };
        if (!st.isDirectory()) throw new SwitchError('refused to measure a special file: ' + root);
        const pending = [root];
        const seen = new Set();
        let files = 0;
        let bytes = 0;
        while (pending.length) {
            const dir = pending.pop();
            const real = fs.realpathSync(dir);
            if (seen.has(real)) throw new SwitchError('refused to measure a directory cycle: ' + dir);
            seen.add(real);
            const names = fs.readdirSync(dir);
            for (let i = 0; i < names.length; i++) {
                const p = path.join(dir, names[i]);
                const child = fs.lstatSync(p);
                if (child.isSymbolicLink()) throw new SwitchError('refused to measure a link: ' + p);
                if (child.isDirectory()) pending.push(p);
                else if (child.isFile()) { files += 1; bytes += child.size; }
                else throw new SwitchError('refused to measure a special file: ' + p);
            }
        }
        return { files: files, bytes: bytes };
    }

    // Deletes a file or a directory. Children go before their parents. A busy file is retried
    // the same way a rename is; the game keeps phone files open for a moment.
    removeTree(root) {
        if (!exists(root)) return;
        const st = fs.lstatSync(root);
        if (st.isSymbolicLink() || !st.isDirectory()) {
            this.unlinkFile(root);
            return;
        }
        const dirs = [root];
        const files = [];
        const pending = [root];
        while (pending.length) {
            const dir = pending.pop();
            const names = fs.readdirSync(dir);
            for (let i = 0; i < names.length; i++) {
                const p = path.join(dir, names[i]);
                const child = fs.lstatSync(p);
                if (child.isSymbolicLink() || !child.isDirectory()) files.push(p);
                else { dirs.push(p); pending.push(p); }
            }
        }
        for (let i = 0; i < files.length; i++) this.unlinkFile(files[i]);
        dirs.sort(function (a, b) { return b.length - a.length; });
        for (let i = 0; i < dirs.length; i++) {
            let last = null;
            for (let t = 0; t < MOVE_TRIES; t++) {
                try { fs.rmdirSync(dirs[i]); last = null; break; }
                catch (e) {
                    last = e;
                    if (!e || BUSY_CODES.indexOf(e.code) < 0) throw e;
                    fsx.sleepSync(MOVE_WAIT_MS);
                }
            }
            if (last) throw last;
        }
    }

    unlinkFile(p) {
        let last = null;
        for (let t = 0; t < MOVE_TRIES; t++) {
            try { fs.unlinkSync(p); return; }
            catch (e) {
                last = e;
                if (e && e.code === 'ENOENT') return;
                if (!e || BUSY_CODES.indexOf(e.code) < 0) throw e;
                fsx.sleepSync(MOVE_WAIT_MS);
            }
        }
        throw last;
    }

    // Something already sits where a file is going: it is kept under displaced-<time>.
    displace(dst, at) {
        const rel = inside(this.dataDir, dst) ? path.join('data', path.relative(this.dataDir, dst)) : path.join('phone', path.relative(this.phoneDir, dst));
        let aside = path.join(this.root, 'displaced-' + stamp(at), rel);
        for (let i = 2; exists(aside); i++) aside = path.join(this.root, 'displaced-' + stamp(at), rel + '-' + i);
        fsx.ensureDir(path.dirname(aside));
        this.rename(dst, aside);
        this.log.warn('households: ' + dst + ' was in the way, kept as ' + aside);
    }

    // Makes the moves still to do. A move whose source is gone was made before an interruption.
    runMoves(job) {
        let moved = 0;
        for (const m of job.moves) {
            this.checkMove(m);
            if (!exists(m.src)) continue;
            // The copy landed and the process died while removing the source. The two trees
            // match, so the source is the leftover, not a second household's files.
            if (exists(m.dst)) {
                const srcTally = this.tally(m.src);
                const dstTally = this.tally(m.dst);
                if (srcTally.files === dstTally.files && srcTally.bytes === dstTally.bytes) {
                    this.removeTree(m.src);
                    moved += 1;
                    continue;
                }
                this.displace(m.dst, job.at);
            }
            fsx.ensureDir(path.dirname(m.dst));
            this.rename(m.src, m.dst);
            moved += 1;
        }
        return moved;
    }

    pruneEmpty(dir) {
        let names;
        try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const d of names) if (d.isDirectory()) this.pruneEmpty(path.join(dir, d.name));
        try {
            if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
        } catch (e) { /* in use or not empty */ }
    }

    // Puts the files of decision.from into its archive and brings those of decision.to back.
    // Must run while nothing else reads or writes these files: the bridge is stopped first.
    switchTo(decision, now) {
        if (!this.registry) this.load();
        const t = now || Date.now();
        const from = decision.from;
        const to = decision.to;
        const job = {
            v: SWITCH_VERSION,
            at: t,
            from: from.tag,
            to: to.tag,
            entries: { from: from, to: to },
            moves: this.plan(from, to)
        };
        for (const m of job.moves) this.checkMove(m);
        fsx.ensureDir(this.root);
        fsx.writeJson(this.switchFile, job, true);
        return this.finish(job, decision);
    }

    // A switch cut off by a crash or a locked file is carried on from where it stopped.
    resume() {
        const r = fsx.readJson(this.switchFile);
        if (r.missing) return null;
        if (!r.ok || !r.value || r.value.v !== SWITCH_VERSION || !Array.isArray(r.value.moves)) {
            throw new SwitchError('households: unfinished switch record is unreadable (' + (r.error || 'bad format') + ') at ' + this.switchFile);
        }
        if (!this.registry) this.load();
        this.log.warn('households: finishing the switch to ' + r.value.to + ' that was interrupted');
        return this.finish(r.value, null);
    }

    finish(job, decision) {
        const moved = this.runMoves(job);
        const reg = this.registry;
        const from = cleanEntry(job.from, reg.households[job.from] || job.entries.from);
        from.archivedAt = job.at;
        reg.households[from.tag] = from;
        const to = cleanEntry(job.to, reg.households[job.to] || job.entries.to);
        if (decision) {
            for (const id of Object.keys(decision.roster || {})) to.roster[id] = decision.roster[id];
            if (decision.name) to.name = decision.name;
            if (decision.householdId) to.householdId = decision.householdId;
        }
        to.lastSeen = job.at;
        to.archivedAt = 0;
        if (!to.firstSeen) to.firstSeen = job.at;
        reg.households[to.tag] = to;
        reg.current = to.tag;
        this.save();
        this.pruneEmpty(this.archiveDir(to.tag));
        try { fs.unlinkSync(this.switchFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        this.log.info('households: ' + moved + ' item(s) moved; ' + describe(from) + ' archived, now playing ' + describe(to));
        return { moved: moved, from: from, to: to };
    }

    pending() {
        return exists(this.switchFile);
    }
}

module.exports = { Households, SwitchError, rosterOf, compare, belongs, describe, DATA_ITEMS, PHONE_ITEMS };
