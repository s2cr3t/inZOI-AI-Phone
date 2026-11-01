'use strict';
// Windows-only helpers behind inZOIPhone.exe: DPAPI (the key is readable only by this
// Windows user on this PC), reading an API key from the clipboard, the Documents folder, and
// the Open dialog for a phone wallpaper.
// Secrets travel over stdin/stdout only, never on a command line, and are never logged.
const { spawnSync, spawn } = require('child_process');
const paths = require('./paths');

const TIMEOUT_MS = 10000;

class HelperError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'HelperError';
        this.code = code || 'helper';
    }
}

function available() {
    return process.platform === 'win32' && paths.isFile(paths.HELPER);
}

function requireHelper() {
    if (!available()) throw new HelperError('inZOIPhone.exe not found at ' + paths.HELPER, 'missing');
}

function runSync(mode, input) {
    requireHelper();
    const r = spawnSync(paths.HELPER, [mode], {
        input: input === undefined ? '' : input,
        encoding: 'utf8',
        windowsHide: true,
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024
    });
    if (r.error) throw new HelperError('helper ' + mode + ' failed: ' + (r.error.code || r.error.message));
    if (r.status !== 0) throw new HelperError('helper ' + mode + ' exited with ' + r.status + (r.stderr ? ' (' + String(r.stderr).slice(0, 80) + ')' : ''));
    return String(r.stdout || '');
}

// options.shown: the helper opens a window the user works in. A hidden start would make the
// first window it shows start hidden as well.
function runAsync(mode, input, options) {
    const timeoutMs = options && options.timeoutMs || TIMEOUT_MS;
    const shown = !!(options && options.shown);
    return new Promise((resolve, reject) => {
        try { requireHelper(); } catch (e) { reject(e); return; }
        const child = spawn(paths.HELPER, [mode], { windowsHide: !shown, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            try { child.kill(); } catch (e) { /* already gone */ }
            reject(new HelperError('helper ' + mode + ' timed out', 'timeout'));
        }, timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(new HelperError('helper ' + mode + ' failed: ' + (e.code || e.message))); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) reject(new HelperError('helper ' + mode + ' exited with ' + code + (err ? ' (' + err.slice(0, 80) + ')' : '')));
            else resolve(out);
        });
        child.stdin.end(input === undefined ? '' : input, 'utf8');
    });
}

function protect(text) {
    const blob = runSync('--protect', String(text)).trim();
    if (!/^[A-Za-z0-9+/=]{16,}$/.test(blob)) throw new HelperError('helper returned an unreadable blob');
    return blob;
}

function unprotect(blob) {
    return runSync('--unprotect', String(blob));
}

async function protectAsync(text) {
    const blob = (await runAsync('--protect', String(text))).trim();
    if (!/^[A-Za-z0-9+/=]{16,}$/.test(blob)) throw new HelperError('helper returned an unreadable blob');
    return blob;
}

async function unprotectAsync(blob) {
    return runAsync('--unprotect', String(blob));
}

// { ok: true, blob, hint, length } or { ok: false, reason: clipboard_empty | clipboard_invalid | clipboard_busy }
async function clipboardKey() {
    const out = await runAsync('--clipboard-protect');
    let v;
    try { v = JSON.parse(out); } catch (e) { throw new HelperError('helper returned unreadable clipboard result'); }
    if (!v || typeof v.ok !== 'boolean') throw new HelperError('helper returned unreadable clipboard result');
    return v;
}

function documentsDir() {
    if (!available()) return '';
    return runSync('--documents').trim();
}

// Opens the Open dialog on the desktop and saves the chosen picture as JPEG at dest, a file
// that must not exist yet. { ok: true, width, height, bytes, name } or
// { ok: false, reason: cancelled | unreadable | too_large | too_small }.
async function pickPicture(mode, dest, timeoutMs) {
    const out = await runAsync(mode, String(dest), { timeoutMs, shown: true });
    let v;
    try { v = JSON.parse(out); } catch (e) { throw new HelperError('helper returned an unreadable picture result'); }
    if (!v || typeof v.ok !== 'boolean') throw new HelperError('helper returned an unreadable picture result');
    return v;
}

function pickWallpaper(dest, timeoutMs) {
    return pickPicture('--pick-wallpaper', dest, timeoutMs);
}

function pickPhoto(dest, timeoutMs) {
    return pickPicture('--pick-photo', dest, timeoutMs);
}

module.exports = { HelperError, available, protect, unprotect, protectAsync, unprotectAsync, clipboardKey, documentsDir, pickWallpaper, pickPhoto };
