'use strict';
// Where the program, its data and the game's folders are.
//
// Installed (inZOI AI Phone setup):
//   <install>\inZOIPhone.exe, <install>\runtime\node.exe, <install>\app\bridge.js ...
//   data in %LOCALAPPDATA%\inZOI AI Phone (config.json, secrets.json, data\, logs\)
// Development copy (bridge.js run straight from its folder): data next to bridge.js.
// INZOI_PHONE_HOME overrides the data folder in both cases.
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const INSTALL_DIR = path.resolve(APP_ROOT, '..');
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

function isFile(f) {
    try { return fs.statSync(f).isFile(); } catch (e) { return false; }
}

function isDir(d) {
    try { return fs.statSync(d).isDirectory(); } catch (e) { return false; }
}

const INSTALLED = isFile(path.join(INSTALL_DIR, 'inZOIPhone.exe')) && isFile(path.join(INSTALL_DIR, 'runtime', 'node.exe'));
const HOME = process.env.INZOI_PHONE_HOME ? path.resolve(process.env.INZOI_PHONE_HOME)
    : INSTALLED ? path.join(LOCAL_APPDATA, 'inZOI AI Phone') : APP_ROOT;
const HELPER = INSTALLED ? path.join(INSTALL_DIR, 'inZOIPhone.exe') : path.join(APP_ROOT, 'bin', 'inZOIPhone.exe');
const ASSETS_DIR = path.join(APP_ROOT, 'assets');

const PHONE_MOD_ID = 'HouseholdBoard_I6IXIO';
const JOURNAL_MOD_ID = 'HouseholdJournal_N4CZ4Z';
const MOD_SEARCH_DEPTH = 3;
const CACHE_MS = 30000;

let docsCache = null;
const modCache = new Map();

function unique(list) {
    const seen = new Set();
    const out = [];
    for (const d of list) {
        if (!d) continue;
        const key = path.resolve(d).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(path.resolve(d));
    }
    return out;
}

// The Documents folder can be moved to another drive or into OneDrive. Windows knows where
// it is; the helper asks it. The usual places are kept as a fallback.
function documentsDirs() {
    if (docsCache && Date.now() - docsCache.at < 10 * 60000) return docsCache.list;
    const list = [];
    try {
        const winsec = require('./winsec');
        const d = winsec.documentsDir();
        if (d) list.push(d);
    } catch (e) { /* helper missing: fall back to the usual places */ }
    const home = os.homedir();
    list.push(path.join(home, 'Documents'));
    if (process.env.OneDrive) list.push(path.join(process.env.OneDrive, 'Documents'));
    if (process.env.OneDriveConsumer) list.push(path.join(process.env.OneDriveConsumer, 'Documents'));
    list.push(path.join(home, 'OneDrive', 'Documents'));
    const result = unique(list).filter(isDir);
    docsCache = { at: Date.now(), list: result };
    return result;
}

function gameDirs(sub) {
    return documentsDirs().map((d) => path.join(d, 'inZOI', sub)).filter(isDir);
}

function modsRoots() { return gameDirs('Mods'); }

function saveGameRoots() { return gameDirs('SaveGames'); }

// The folder of an installed mod: the one holding <modId>.uplugin, at most three levels under
// Documents\inZOI\Mods (Mods\InGame\<modId> for the ModKit, other layouts for mod managers).
// A mod can be there more than once (unpacked by hand and installed by the setup, or by a mod
// manager). The game loads one of them and the service has to use that one, else the phone
// never sees the replies and the service never sees what was typed. modCopies tells which.
function findMod(modId) {
    return modCopies(modId).dir;
}

// { dir, copies: [every folder holding the mod], reason: why dir was chosen ('' for one copy) }
function modCopies(modId) {
    const hit = modCache.get(modId);
    if (hit && Date.now() - hit.at < CACHE_MS && hit.copies.every((d) => isFile(path.join(d, modId + '.uplugin')))) return hit.info;
    const copies = [];
    const roots = modsRoots();
    for (const root of roots) searchCopies(root, modId, 0, copies);
    const info = chooseCopy(modId, unique(copies), roots);
    modCache.set(modId, { at: Date.now(), copies: info.copies, info });
    return info;
}

function searchCopies(dir, modId, depth, out) {
    if (isFile(path.join(dir, modId + '.uplugin'))) {
        out.push(dir);
        return;
    }
    if (depth >= MOD_SEARCH_DEPTH) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
        if (e.isDirectory() && !e.isSymbolicLink()) searchCopies(path.join(dir, e.name), modId, depth + 1, out);
    }
}

// The copy the game loads, by the best evidence there is:
//   1. the Lua log names the folder the game mounted the mod's Lua from (Lua mods only)
//   2. the phone wrote into it most recently (only the phone UI writes those files)
//   3. Mods\InGame\<modId>, where the ModKit and the setup put mods
//   4. the first one found
function chooseCopy(modId, copies, roots) {
    if (copies.length === 0) return { dir: '', copies, reason: '' };
    if (copies.length === 1) return { dir: copies[0], copies, reason: '' };
    const key = (d) => path.resolve(d).toLowerCase();
    const mounted = luaMountedDir(modId);
    if (mounted) {
        const m = copies.find((d) => key(d) === key(mounted));
        if (m) return { dir: m, copies, reason: 'the game loaded it from there (inzoi_lua.log)' };
    }
    let best = '';
    let bestAt = 0;
    for (const d of copies) {
        const at = phoneActivity(d);
        if (at > bestAt) {
            best = d;
            bestAt = at;
        }
    }
    if (best) return { dir: best, copies, reason: 'the phone in the game last wrote there' };
    const rootKeys = roots.map(key);
    const standard = copies.find((d) => path.basename(path.dirname(d)).toLowerCase() === 'ingame' &&
        rootKeys.indexOf(key(path.dirname(path.dirname(d)))) >= 0);
    if (standard) return { dir: standard, copies, reason: 'it is the standard Mods\\InGame folder' };
    return { dir: copies[0], copies, reason: 'it was found first' };
}

// Newest time the phone UI wrote a file of its own in this copy: its settings and checks
// (ui/phone/saved, rewritten each time the phone loads), the AI app's control and request,
// typed texts and read marks, the group chats it made. The service writes none of these.
function phoneActivity(dir) {
    const phone = path.join(dir, 'ui', 'phone');
    let newest = 0;
    const look = (f) => {
        try {
            const t = fs.statSync(f).mtimeMs;
            if (t > newest) newest = t;
        } catch (e) { /* not there */ }
    };
    for (const name of listNames(path.join(phone, 'saved'), false)) {
        if (/\.cfg$/i.test(name)) look(path.join(phone, 'saved', name));
    }
    look(path.join(phone, 'service', 'control.cfg'));
    look(path.join(phone, 'service', 'request.cfg'));
    look(path.join(phone, 'groups', 'list.cfg'));
    for (const sub of ['sms', 'moments', 'groups']) {
        for (const name of listNames(path.join(phone, sub), true)) {
            look(path.join(phone, sub, name, 'outbox.cfg'));
            look(path.join(phone, sub, name, 'seen.cfg'));
            if (sub === 'groups') look(path.join(phone, sub, name, 'meta.cfg'));
        }
    }
    return newest;
}

function listNames(dir, wantDirs) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((e) => (wantDirs ? e.isDirectory() && !e.isSymbolicLink() : e.isFile()))
            .map((e) => e.name);
    } catch (e) {
        return [];
    }
}

const LUA_LOG = path.join(LOCAL_APPDATA, 'BlueClient', 'Saved', 'inzoi_lua.log');
// The game mounts the Lua mods while it starts, near the top of the log.
const LUA_LOG_SCAN = 8 << 20;
const MOUNT_LINE = /(?<![A-Za-z])MountLuaPath: Updated mounted Lua paths\.[^\r\n]*?InputPaths=\[([^\]\r\n]*)\]/g;
let luaLogCache = null;

// The folder the game last mounted modId's Lua from in its current or last session, or ''.
function luaMountedDir(modId) {
    let st;
    try { st = fs.statSync(LUA_LOG); } catch (e) { return ''; }
    const c = luaLogCache;
    const same = c && c.birthtimeMs === st.birthtimeMs && (c.size === st.size || (st.size > c.size && c.size >= LUA_LOG_SCAN));
    if (!same) luaLogCache = { size: st.size, birthtimeMs: st.birthtimeMs, mounts: readMounts() };
    const want = modId.toLowerCase();
    let last = '';
    for (const p of luaLogCache.mounts) {
        if (path.win32.basename(p).toLowerCase() === 'lua' && path.win32.basename(path.win32.dirname(p)).toLowerCase() === want) {
            last = path.win32.dirname(p);
        }
    }
    return last;
}

function readMounts() {
    let text = '';
    let fd = null;
    try {
        fd = fs.openSync(LUA_LOG, 'r');
        const buf = Buffer.alloc(Math.min(LUA_LOG_SCAN, fs.fstatSync(fd).size));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        text = buf.toString('utf8', 0, n);
    } catch (e) {
        return [];
    } finally {
        if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* closed */ }
    }
    const out = [];
    MOUNT_LINE.lastIndex = 0;
    let m;
    while ((m = MOUNT_LINE.exec(text)) !== null) {
        for (const p of m[1].split(',')) {
            const s = p.trim().replace(/\//g, '\\').replace(/\\+$/, '');
            if (s) out.push(s);
        }
    }
    return out;
}

function forgetMods() { modCache.clear(); }

// Where a mod would be when it is not installed yet, for messages and defaults.
function expectedModDir(modId) {
    const docs = documentsDirs()[0] || path.join(os.homedir(), 'Documents');
    return path.join(docs, 'inZOI', 'Mods', 'InGame', modId);
}

module.exports = {
    APP_ROOT, INSTALL_DIR, INSTALLED, HOME, HELPER, ASSETS_DIR, LOCAL_APPDATA,
    PHONE_MOD_ID, JOURNAL_MOD_ID,
    documentsDirs, modsRoots, saveGameRoots, findMod, modCopies, forgetMods, expectedModDir, isFile, isDir
};
