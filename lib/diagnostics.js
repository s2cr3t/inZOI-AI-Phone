'use strict';
// A diagnostics package for a tester to send back: recent logs, settings and status files in
// one zip under Documents\inZOI\AI Phone Diagnostics.
//
// Keys never leave the PC. secrets.json and the phone's request file are not read at all; every
// file that goes in is scrubbed of the stored keys themselves, anything shaped like a key or
// token, long encoded blobs, and the Windows user and computer name. The household's memories,
// diary and chronicle stay out. Chat lines in the logs stay in: they are what a problem report
// is about, and the summary says so.
//
// Files are only read here; the only things written are a new staging folder and the new zip.
// The zip is made by Windows' own tar.exe at its fixed place, with the arguments as a list.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');
const fsx = require('./fsx');
const paths = require('./paths');
const providers = require('./providers');
const winsec = require('./winsec');
const usage = require('./usage');
const journal = require('./journal');

const LOG_DAYS = 3;
const LOG_TAIL_BYTES = 3 * 1024 * 1024;
const LUA_TAIL_BYTES = 1024 * 1024;
const DATA_TAIL_BYTES = 2 * 1024 * 1024;
const RECENT_PROBLEMS = 40;
const TAR_TIMEOUT_MS = 30000;
const OUT_FOLDER = 'AI Phone Diagnostics';

// Small status files from data\. Memories, diary, chronicle and know-how are folders and are
// left out on purpose.
const DATA_FILES = [
    'llm-health.json', 'llm-usage.json', 'llm-quirks.json', 'guardian-state.json', 'bridge.pid.json',
    'state.json', 'buffs-state.json', 'needs-state.json', 'moments-state.json', 'rooms.json', 'same-task.json',
    'households.json', 'households/registry.json', 'households/switch.json'
];
const SENSITIVE_FIELD = /^(api[_-]?key|apikey|llm_api_key|key_value|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|authorization|auth|dpapi|cookie|x-api-key)$/i;

function pad(n) {
    return (n < 10 ? '0' : '') + n;
}

function stampOf(d) {
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------- scrubbing
// An encoded key or blob: one long unbroken run of mixed letters and digits. The game's own ids
// (BP_Interaction_Fridge_01_TakeOut) are short words joined by underscores and stay readable.
function looksEncoded(s) {
    if (s.indexOf('/') >= 0 || s.indexOf(':') >= 0) return false;
    const longest = s.split(/[_\-]/).reduce((n, part) => Math.max(n, part.length), 0);
    return longest >= 32 && /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);
}

// exact: the stored key values, in plain text in this process only.
function makeScrubber(exact) {
    const words = [];
    const keys = (exact || []).filter((k) => typeof k === 'string' && k.length >= 8)
        .sort((a, b) => b.length - a.length);
    let user = '';
    let host = '';
    try { user = os.userInfo().username || ''; } catch (e) { user = process.env.USERNAME || ''; }
    try { host = os.hostname() || ''; } catch (e) { host = process.env.COMPUTERNAME || ''; }
    if (user.length >= 3) words.push({ re: new RegExp('(^|[^A-Za-z0-9])' + escapeRe(user) + '(?=$|[^A-Za-z0-9])', 'gi'), to: '$1<user>' });
    if (host.length >= 3) words.push({ re: new RegExp('(^|[^A-Za-z0-9])' + escapeRe(host) + '(?=$|[^A-Za-z0-9])', 'gi'), to: '$1<pc>' });
    return function scrub(text) {
        let s = String(text);
        for (const k of keys) s = s.split(k).join('***key***');
        s = s
            .replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-***')
            .replace(/(Bearer\s+)[A-Za-z0-9_\-.~+\/=]{6,}/gi, '$1***')
            .replace(/("(?:api[_-]?key|apikey|llm_api_key|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|authorization|dpapi|cookie|x-api-key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"***"')
            .replace(/\b((?:api[_-]?key|access[_-]?token|token|secret|password|authorization)\s*[=:]\s*)[^\s,;&"']{6,}/gi, '$1***')
            .replace(/[A-Za-z0-9+\/_\-]{40,}={0,2}/g, (m) => (looksEncoded(m) ? '***blob***' : m))
            .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, '<email>')
            .replace(/([A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))[^\\\/"'\r\n]+/gi, '$1<user>');
        for (const w of words) s = s.replace(w.re, w.to);
        return s;
    };
}

// Drops sensitive fields from parsed JSON before it is written back as text.
function stripFields(v, depth) {
    if (depth > 30 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => stripFields(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v)) {
        if (SENSITIVE_FIELD.test(k) && (typeof v[k] === 'string' || typeof v[k] === 'number')) {
            out[k] = v[k] === '' ? '' : '***';
            continue;
        }
        out[k] = stripFields(v[k], depth + 1);
    }
    return out;
}

// ---------------------------------------------------------------- reading
// The last `max` bytes of a file, opened for reading only, cut to whole lines.
function tail(file, max) {
    let fd = null;
    try {
        const size = fs.statSync(file).size;
        const start = Math.max(0, size - max);
        const buf = Buffer.alloc(size - start);
        fd = fs.openSync(file, 'r');
        let read = 0;
        while (read < buf.length) {
            const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
            if (!n) break;
            read += n;
        }
        let text = buf.slice(0, read).toString('utf8');
        if (start > 0) {
            const nl = text.indexOf('\n');
            text = '[... first ' + (start + (nl >= 0 ? nl + 1 : 0)) + ' bytes left out ...]\n' + (nl >= 0 ? text.slice(nl + 1) : text);
        }
        return { ok: true, text, size };
    } catch (e) {
        return { ok: false, error: e.code || e.message };
    } finally {
        if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* already closed */ }
    }
}

function readJsonText(file, max) {
    const t = tail(file, max);
    if (!t.ok) return t;
    if (t.text.indexOf('[... first ') === 0) return t;
    try {
        return { ok: true, text: JSON.stringify(stripFields(JSON.parse(t.text.replace(/^\uFEFF/, '')), 0), null, 2), size: t.size };
    } catch (e) {
        return t;
    }
}

function recentLogs(dir, prefix, now) {
    const days = [];
    for (let i = 0; i < LOG_DAYS; i++) {
        const d = new Date(now - i * 86400000);
        days.push(prefix + '-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.log');
    }
    return days.map((n) => path.join(dir, n)).filter((f) => paths.isFile(f));
}

function sizeOf(file) {
    try { return fs.statSync(file).size; } catch (e) { return -1; }
}

function mtimeOf(file) {
    try { return fs.statSync(file).mtimeMs; } catch (e) { return 0; }
}

function when(ms) {
    return ms ? new Date(ms).toLocaleString() : 'never';
}

// The ?v= the phone page loads app.js with: the phone UI build actually installed.
function phoneUiVersion(dir) {
    const t = tail(path.join(dir, 'ui', 'phone', 'index.html'), 256 * 1024);
    const m = t.ok ? /app\.js\?v=([A-Za-z0-9._-]+)/.exec(t.text) : null;
    return m ? m[1] : 'unknown';
}

function newestIn(dir, depth) {
    let best = 0;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) {
            if (depth > 0) best = Math.max(best, newestIn(full, depth - 1));
        } else if (e.isFile()) {
            best = Math.max(best, mtimeOf(full));
        }
    }
    return best;
}

function problemLines(files) {
    const out = [];
    for (const f of files) {
        const t = tail(f, LOG_TAIL_BYTES);
        if (!t.ok) continue;
        for (const line of t.text.split(/\r?\n/)) {
            if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} (WARN|ERROR)/.test(line)) out.push(line.slice(0, 400));
        }
    }
    return out.slice(-RECENT_PROBLEMS);
}

async function gameReachable(url) {
    try {
        const { GameClient } = require('./game');
        const g = new GameClient({ url, timeoutMs: 3000 });
        await g.listTools();
        return true;
    } catch (e) {
        return false;
    }
}

// The stored keys in plain text, only to take them out of the files again.
async function storedKeys(log) {
    const out = [];
    const all = config.keyInfoAll();
    for (const id of Object.keys(all)) {
        if (!all[id].set) continue;
        try {
            const k = await config.apiKeyFor(id);
            if (k) out.push(k);
        } catch (e) {
            if (log) log.debug('diagnostics: key of ' + id + ' not readable for scrubbing: ' + e.message);
        }
    }
    return out;
}

function outputDir() {
    const docs = paths.documentsDirs()[0];
    return docs ? path.join(docs, 'inZOI', OUT_FOLDER) : path.join(config.HOME, 'diagnostics');
}

function tarPath() {
    const windir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    return path.join(windir, 'System32', 'tar.exe');
}

function runTar(zipFile, cwd, name) {
    return new Promise((resolve) => {
        execFile(tarPath(), ['-a', '-c', '-f', zipFile, '-C', cwd, name], { windowsHide: true, timeout: TAR_TIMEOUT_MS }, (err) => {
            resolve(err ? (err.code === undefined ? err.message : 'exit ' + err.code) : '');
        });
    });
}

function removeStaging(dir, root) {
    const rel = path.relative(root, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left in the temp folder */ }
}

// ---------------------------------------------------------------- summary
function summaryText(s) {
    const L = [];
    L.push('inZOI AI Phone diagnostics');
    L.push('Created: ' + new Date(s.now).toLocaleString() + ' (UTC' + (s.offset >= 0 ? '+' : '') + s.offset + ')');
    L.push('');
    L.push('[Program]');
    L.push('Version: ' + s.version);
    L.push('Install: ' + (paths.INSTALLED ? 'installed' : 'development copy'));
    L.push('Data folder: ' + config.HOME);
    L.push('Windows: ' + os.release() + ' ' + os.arch() + ', Node.js ' + process.versions.node);
    L.push('Key helper (inZOIPhone.exe): ' + (winsec.available() ? 'present' : 'MISSING'));
    L.push('Reply service: ' + (s.bridgePid ? 'running (pid ' + s.bridgePid + ')' : 'not running'));
    L.push('');
    L.push('[AI]');
    L.push('Provider: ' + s.cfg.llm.provider + ', model: ' + s.cfg.llm.model + ', deep thinking: ' + s.cfg.llm.thinking);
    L.push('Server address: ' + s.cfg.llm.base_url);
    L.push('Calls per hour cap: ' + (s.cfg.llm.max_calls_per_hour ? s.cfg.llm.max_calls_per_hour : 'none'));
    const stored = Object.keys(s.keys).filter((k) => s.keys[k].set).map((k) => (providers.get(k) ? providers.get(k).label : k));
    L.push('Key stored for: ' + (stored.length ? stored.join(', ') : 'none') + ' (the keys themselves are not in this package)');
    if (s.health) L.push('Last AI request: ' + (s.health.ok ? 'ok' : 'failed (' + (s.health.kind || 'unknown') + ')') + ' at ' + when(s.health.at));
    if (s.usage) {
        const u = s.usage;
        const money = (b) => u.priced ? ', about ' + b.cost.toFixed(3) + ' ' + u.currency : '';
        L.push('Last 60 minutes: ' + u.hour.calls + ' calls (' + u.hour.failed + ' failed), ' + u.hour.prompt + ' in / ' + u.hour.completion + ' out tokens' + money(u.hour));
        L.push('Today: ' + u.today.calls + ' calls (' + u.today.failed + ' failed)' + money(u.today));
        if (u.purposes.length) L.push('By purpose (last 60 minutes): ' + u.purposes.map((p) => p.id + ' ' + p.calls).join(', '));
    }
    L.push('');
    L.push('[Game]');
    L.push('Game connection (MCP): ' + (s.gameUp ? 'reachable' : 'not reachable'));
    L.push('Phone mod: ' + (s.phoneDir ? 'found, UI build ' + phoneUiVersion(s.phoneDir) : 'NOT FOUND'));
    L.push('HouseholdJournal mod: ' + (s.journalDir ? 'found, files changed ' + when(newestIn(s.journalDir, 3)) : 'NOT FOUND'));
    L.push('Lua log: ' + (s.luaSize >= 0 ? s.luaSize + ' bytes, last written ' + when(s.luaTime) : 'not found'));
    for (const m of [s.phoneCopies, s.journalCopies]) {
        if (!m || m.copies.length < 2) continue;
        L.push(m.id + ' is installed ' + m.copies.length + ' times; in use: ' + shownPath(m.dir) + ' (' + m.reason + ')');
        for (const d of m.copies) L.push('  ' + shownPath(d) + ', UI build ' + (m.id === paths.PHONE_MOD_ID ? phoneUiVersion(d) : '-') + ', files changed ' + when(newestIn(d, 3)));
    }
    L.push('');
    L.push('[Settings check]');
    L.push(s.problems.length ? s.problems.map((p) => '- ' + p).join('\n') : 'no problems');
    L.push('');
    L.push('[Recent warnings and errors]');
    L.push(s.recent.length ? s.recent.join('\n') : 'none');
    L.push('');
    L.push('[Files in this package]');
    for (const f of s.files) L.push(f.name + ': ' + (f.ok ? f.bytes + ' bytes' : 'not included (' + f.why + ')'));
    L.push('');
    L.push('API keys are removed from every file. The logs do contain the text messages of the household chat.');
    return L.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- building
// opts: { log, gameUp?, bridgePid?, serviceDir? }. Resolves { ok, file, shown, bytes } or
// { ok: false, message }.
async function build(opts) {
    const o = opts || {};
    const log = o.log || null;
    const now = Date.now();
    const info = config.load({ withKey: false });
    const cfg = info.config;
    const scrub = makeScrubber(await storedKeys(log));
    const name = 'inZOI-AI-Phone-Diagnostics-' + stampOf(new Date(now));
    const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inzoi-phone-diag-'));
    const stage = path.join(stageRoot, name);
    fs.mkdirSync(stage);
    const files = [];
    const put = (rel, r) => {
        if (!r.ok) {
            files.push({ name: rel, ok: false, why: r.error || 'unreadable' });
            return;
        }
        const text = scrub(r.text);
        const full = path.join(stage, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text, { encoding: 'utf8', flag: 'wx' });
        files.push({ name: rel, ok: true, bytes: Buffer.byteLength(text) });
    };
    try {
        put('config.json', paths.isFile(config.CONFIG_FILE) ? readJsonText(config.CONFIG_FILE, DATA_TAIL_BYTES) : { ok: false, error: 'no config.json, defaults in use' });
        const logFiles = recentLogs(config.LOG_DIR, 'bridge', now).concat(recentLogs(config.LOG_DIR, 'guardian', now));
        for (const f of logFiles) put(path.join('logs', path.basename(f)), tail(f, LOG_TAIL_BYTES));
        for (const n of DATA_FILES) {
            const f = path.join(config.DATA_DIR, n);
            if (paths.isFile(f)) put(path.join('data', n), readJsonText(f, DATA_TAIL_BYTES));
        }
        const phoneCopies = Object.assign({ id: paths.PHONE_MOD_ID }, paths.modCopies(paths.PHONE_MOD_ID));
        const journalCopies = Object.assign({ id: paths.JOURNAL_MOD_ID }, paths.modCopies(paths.JOURNAL_MOD_ID));
        const phoneDir = phoneCopies.dir;
        const journalDir = journalCopies.dir;
        const serviceDir = o.serviceDir || (phoneDir ? path.join(phoneDir, 'ui', 'phone', 'service') : '');
        for (const n of ['service.cfg', 'control.cfg']) {
            const f = serviceDir ? path.join(serviceDir, n) : '';
            if (f && paths.isFile(f)) put(path.join('phone', n), readJsonText(f, DATA_TAIL_BYTES));
        }
        // How the phone's UI engine took the wallpaper styles; ids and CSS only, no pictures.
        const wallCheck = serviceDir ? path.join(path.dirname(serviceDir), 'saved', 'wallpaper-check.cfg') : '';
        if (wallCheck && paths.isFile(wallCheck)) put(path.join('phone', 'wallpaper-check.cfg'), readJsonText(wallCheck, DATA_TAIL_BYTES));
        const luaFile = journal.DEFAULT_FILE;
        if (paths.isFile(luaFile)) put('game\\inzoi_lua.log', tail(luaFile, LUA_TAIL_BYTES));
        let usageSummary = null;
        try {
            usageSummary = usage.summarize(usage.readEntries(path.join(config.DATA_DIR, 'llm-usage.json'), now), now, {
                provider: cfg.llm.provider, model: cfg.llm.model, limit: cfg.llm.max_calls_per_hour, custom: cfg.llm.price
            });
            put('data\\usage-summary.json', { ok: true, text: JSON.stringify(usageSummary, null, 2) });
        } catch (e) {
            files.push({ name: 'data\\usage-summary.json', ok: false, why: e.message });
        }
        const health = fsx.readJson(path.join(config.DATA_DIR, 'llm-health.json'));
        let bridgePid = o.bridgePid;
        if (bridgePid === undefined) {
            const pidInfo = fsx.readJson(path.join(config.DATA_DIR, 'bridge.pid.json'));
            const pid = pidInfo.ok && pidInfo.value ? Number(pidInfo.value.pid) : 0;
            bridgePid = pid && fsx.isProcessAlive(pid) ? pid : 0;
        }
        const gameUp = typeof o.gameUp === 'boolean' ? o.gameUp : await gameReachable(cfg.game.url);
        const summary = summaryText({
            now,
            offset: -new Date(now).getTimezoneOffset() / 60,
            version: require('./daemon').VERSION,
            cfg,
            keys: config.keyInfoAll(cfg.llm.provider),
            health: health.ok && health.value ? health.value.last : null,
            usage: usageSummary,
            bridgePid,
            gameUp,
            phoneDir,
            journalDir,
            phoneCopies,
            journalCopies,
            luaSize: sizeOf(luaFile),
            luaTime: mtimeOf(luaFile),
            problems: info.problems,
            recent: problemLines(logFiles.filter((f) => path.basename(f).indexOf('bridge-') === 0).slice(0, 1).concat(logFiles.filter((f) => path.basename(f).indexOf('guardian-') === 0).slice(0, 1))),
            files
        });
        put('summary.txt', { ok: true, text: '\uFEFF' + summary });

        const outDir = outputDir();
        fsx.ensureDir(outDir);
        let zipFile = path.join(outDir, name + '.zip');
        for (let i = 2; paths.isFile(zipFile) || paths.isDir(zipFile.replace(/\.zip$/, '')); i++) zipFile = path.join(outDir, name + '-' + i + '.zip');
        const tarErr = paths.isFile(tarPath()) ? await runTar(zipFile, stageRoot, name) : 'tar.exe not found';
        if (!tarErr && paths.isFile(zipFile)) {
            return { ok: true, file: zipFile, shown: shownPath(zipFile), bytes: sizeOf(zipFile) };
        }
        // No zip: the folder itself is the package.
        const folder = zipFile.replace(/\.zip$/, '');
        try { fs.unlinkSync(zipFile); } catch (e) { /* tar left nothing */ }
        copyTree(stage, folder);
        if (log) log.warn('diagnostics: zip not made (' + tarErr + '), saved as a folder');
        return { ok: true, file: folder, shown: shownPath(folder), bytes: files.reduce((n, f) => n + (f.ok ? f.bytes : 0), 0) };
    } catch (e) {
        if (log) log.error('diagnostics failed: ' + e.message);
        return { ok: false, message: 'The diagnostics package could not be made: ' + e.message };
    } finally {
        removeStaging(stageRoot, os.tmpdir());
    }
}

function copyTree(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const a = path.join(from, e.name);
        const b = path.join(to, e.name);
        if (e.isDirectory()) copyTree(a, b);
        else if (e.isFile()) fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
    }
}

// For the phone: from the inZOI folder on, so the Windows user name is not on screen.
function shownPath(p) {
    const i = p.toLowerCase().indexOf('\\inzoi\\');
    return i >= 0 ? 'Documents' + p.slice(i) : p;
}

module.exports = { build, makeScrubber, stripFields, tail };
