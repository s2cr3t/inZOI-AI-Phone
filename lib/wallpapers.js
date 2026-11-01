'use strict';
// Pictures the player adds as phone wallpapers, in ui/phone/wallpapers/custom.
//
// inZOIPhone.exe --pick-wallpaper shows the Open dialog on the desktop and saves the chosen
// picture there as a temp file: turned upright, scaled down, re-encoded as JPEG, which also
// leaves its EXIF data (camera, GPS position) behind. The original is only read. The helper
// measures how bright the picture is: a light one gets a white veil and tone "light" (the phone
// switches to its light style), a dark one a black shade and tone "dark". A temp file that
// starts like a JPEG and is not too large is renamed to <hash>.jpg; the same picture added twice
// stays one file. index.cfg lists them, newest first. The phone keeps its choice in
// saved/wallpaper.cfg and never writes here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fsx = require('./fsx');
const winsec = require('./winsec');

const ID_RE = /^[a-f0-9]{16}$/;
const FILE_RE = /^([a-f0-9]{16})\.jpg$/;
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 24;
const MAX_NAME = 40;
// The player is choosing a file on the desktop; the dialog closes itself after this.
const PICK_TIMEOUT_MS = 10 * 60000;

const PICK_MESSAGES = {
    cancelled: 'No picture was chosen.',
    unreadable: 'That file is not a picture the phone can use. Choose a JPG, PNG, BMP or GIF.',
    too_large: 'That picture is too large (over 64 MB or 120 megapixels).',
    too_small: 'That picture is too small for a wallpaper (it needs at least 320 pixels on each side).'
};

function inside(parent, child) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel !== '' && rel.indexOf('..') !== 0 && !path.isAbsolute(rel);
}

function isJpeg(buf) {
    if (!buf || buf.length < JPEG_SIG.length) return false;
    for (let i = 0; i < JPEG_SIG.length; i++) if (buf[i] !== JPEG_SIG[i]) return false;
    return true;
}

function cleanName(raw) {
    return String(typeof raw === 'string' ? raw : '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '').trim().slice(0, MAX_NAME);
}

function whole(n) {
    return Number.isInteger(n) && n > 0 && n < 100000 ? n : 0;
}

// Photos added before the phone had a light style were all shaded dark.
function cleanTone(raw) {
    return raw === 'light' ? 'light' : 'dark';
}

function cleanLuma(raw) {
    return typeof raw === 'number' && raw >= 0 && raw <= 1 ? Math.round(raw * 1000) / 1000 : null;
}

// The answer goes into service.cfg, which a diagnostics package includes: no file name in it.
function answerItem(item) {
    return { id: item.id, width: item.width, height: item.height, tone: item.tone };
}

class Wallpapers {
    constructor(phoneDir, log) {
        this.dir = path.join(phoneDir, 'wallpapers', 'custom');
        this.index = path.join(this.dir, 'index.cfg');
        this.log = log || null;
    }

    // Entries whose file is still there, newest first.
    list() {
        const r = fsx.readJson(this.index);
        const raw = r.ok && r.value && Array.isArray(r.value.items) ? r.value.items : [];
        const out = [];
        const seen = new Set();
        for (const v of raw) {
            if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !ID_RE.test(v.id) || seen.has(v.id)) continue;
            let st;
            try { st = fs.statSync(path.join(this.dir, v.id + '.jpg')); } catch (e) { continue; }
            if (!st.isFile()) continue;
            seen.add(v.id);
            out.push({
                id: v.id,
                file: v.id + '.jpg',
                width: whole(v.width),
                height: whole(v.height),
                bytes: st.size,
                tone: cleanTone(v.tone),
                luma: cleanLuma(v.luma),
                name: cleanName(v.name),
                at: Number.isFinite(v.at) ? v.at : Math.round(st.mtimeMs)
            });
        }
        return out;
    }

    async pick() {
        fsx.ensureDir(this.dir);
        const items = this.list();
        this.sweep(items);
        if (items.length >= MAX_ITEMS) {
            return { ok: false, code: 'full', message: 'The phone holds ' + MAX_ITEMS + ' of your photos already. Remove one first.' };
        }
        const tmp = path.join(this.dir, 'pick-' + process.pid + '-' + Date.now() + '.tmp');
        let r;
        try {
            r = await winsec.pickWallpaper(tmp, PICK_TIMEOUT_MS);
        } catch (e) {
            this.discard(tmp);
            if (e && e.code === 'timeout') return { ok: false, code: 'timeout', message: 'The picture window was open too long and has been closed.' };
            throw e;
        }
        if (!r.ok) {
            this.discard(tmp);
            const code = PICK_MESSAGES[r.reason] ? r.reason : 'unreadable';
            return { ok: false, code, message: PICK_MESSAGES[code] };
        }
        let buf;
        try { buf = fs.readFileSync(tmp); } catch (e) { buf = null; }
        if (!buf || buf.length !== r.bytes || buf.length > MAX_BYTES || !isJpeg(buf)) {
            this.discard(tmp);
            this.say('warn', 'wallpapers: the converted picture was not usable (' + (buf ? buf.length : 0) + ' bytes)');
            return { ok: false, code: 'unreadable', message: PICK_MESSAGES.unreadable };
        }
        const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
        const known = items.find((i) => i.id === id);
        if (known) {
            this.discard(tmp);
            return { ok: true, code: 'duplicate', item: answerItem(known), message: 'This photo is already on the phone.' };
        }
        const dest = path.join(this.dir, id + '.jpg');
        if (!inside(this.dir, dest)) {
            this.discard(tmp);
            throw new Error('wallpaper target outside its folder');
        }
        try {
            this.replace(tmp, dest);
            if (fs.statSync(dest).size !== buf.length) throw new Error('saved wallpaper truncated');
        } catch (e) {
            this.discard(tmp);
            this.discard(dest);
            throw e;
        }
        const item = {
            id,
            file: id + '.jpg',
            width: whole(r.width),
            height: whole(r.height),
            bytes: buf.length,
            tone: cleanTone(r.tone),
            luma: cleanLuma(r.luma),
            name: cleanName(r.name),
            at: Date.now()
        };
        this.writeIndex([item].concat(items));
        this.say('info', 'wallpapers: added ' + id + '.jpg (' + item.width + 'x' + item.height + ', ' + item.bytes + ' bytes, ' + item.tone + ')');
        return { ok: true, code: 'ok', item: answerItem(item), message: 'Photo added.' };
    }

    remove(id) {
        if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, code: 'bad_id', message: 'That photo is not on the phone.' };
        const items = this.list();
        const rest = items.filter((i) => i.id !== id);
        const file = path.join(this.dir, id + '.jpg');
        if (rest.length !== items.length) this.writeIndex(rest);
        const gone = this.discard(file);
        // Not "id": the guardian merges this into a reply whose id is the request's.
        if (rest.length === items.length && !gone) return { ok: true, code: 'gone', photo: id, message: 'That photo was already removed.' };
        this.say('info', 'wallpapers: removed ' + id + '.jpg');
        return { ok: true, code: 'ok', photo: id, message: 'Photo removed.' };
    }

    writeIndex(items) {
        fsx.writeJson(this.index, { v: 1, updatedAt: Date.now(), items }, true);
    }

    // Temp files of an earlier pick, and pictures whose index entry was never written.
    sweep(items) {
        const keep = new Set(items.map((i) => i.file));
        let names;
        try { names = fs.readdirSync(this.dir); } catch (e) { return; }
        for (const name of names) {
            if (/^pick-\d+-\d+\.tmp$/.test(name) || (FILE_RE.test(name) && !keep.has(name))) this.discard(path.join(this.dir, name));
        }
    }

    discard(file) {
        if (!inside(this.dir, file)) return false;
        try {
            fs.unlinkSync(file);
            return true;
        } catch (e) {
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
                if (!e || ['EPERM', 'EBUSY', 'EACCES'].indexOf(e.code) < 0) throw e;
                fsx.sleepSync(40);
            }
        }
        throw last;
    }

    say(level, message) {
        if (this.log && typeof this.log[level] === 'function') this.log[level](message);
    }
}

module.exports = { Wallpapers, PICK_TIMEOUT_MS, MAX_ITEMS };
