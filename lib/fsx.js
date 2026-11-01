'use strict';
// Small, synchronous file helpers. The game reads and writes the same cfg files through
// its own file API, so every write is atomic (temp file + rename) and retried while the
// game briefly holds a handle open.
const fs = require('fs');
const path = require('path');

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
    Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

function retrying(fn, attempts, delayMs) {
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
        try {
            return fn();
        } catch (e) {
            lastError = e;
            if (!e || ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].indexOf(e.code) < 0) throw e;
            sleepSync(delayMs);
        }
    }
    throw lastError;
}

function readText(file) {
    try {
        return retrying(() => fs.readFileSync(file, 'utf8'), 5, 20);
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
}

// Returns { ok: true, value } or { ok: false, missing: bool, error }.
function readJson(file) {
    let raw;
    try {
        raw = readText(file);
    } catch (e) {
        return { ok: false, missing: false, error: e.message };
    }
    if (raw === null) return { ok: false, missing: true, error: 'missing' };
    const text = raw.replace(/^\uFEFF/, '');
    if (!text.trim()) return { ok: true, value: null };
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch (e) {
        return { ok: false, missing: false, error: 'invalid JSON: ' + e.message };
    }
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function writeAtomic(file, text) {
    ensureDir(path.dirname(file));
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    try {
        retrying(() => fs.renameSync(tmp, file), 25, 40);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (ignored) { /* best effort */ }
        throw e;
    }
}

function writeJson(file, value, pretty) {
    writeAtomic(file, pretty ? JSON.stringify(value, null, 2) + '\n' : JSON.stringify(value));
}

// Cross-process mutex based on mkdir, which is atomic on NTFS. A lock older than
// staleMs is considered abandoned by a crashed process and is taken over.
function withLock(lockDir, fn, options) {
    const o = options || {};
    const staleMs = o.staleMs || 10000;
    const waitMs = o.waitMs || 5000;
    const started = Date.now();
    for (;;) {
        try {
            fs.mkdirSync(lockDir);
            break;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            let age = 0;
            try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch (ignored) { continue; }
            if (age > staleMs) {
                try { fs.rmdirSync(lockDir); } catch (ignored) { /* another process got there first */ }
                continue;
            }
            if (Date.now() - started > waitMs) throw new Error('timed out waiting for lock ' + lockDir);
            sleepSync(25);
        }
    }
    try {
        return fn();
    } finally {
        try { fs.rmdirSync(lockDir); } catch (ignored) { /* already released */ }
    }
}

function isProcessAlive(pid) {
    if (!pid || typeof pid !== 'number') return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

module.exports = { sleepSync, readText, readJson, writeAtomic, writeJson, ensureDir, withLock, isProcessAlive };
