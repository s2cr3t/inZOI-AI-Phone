'use strict';
// Photos chosen for Texts, stored as content-addressed JPEGs in ui/phone/media.
// The mailbox keeps only { id, width, height }; the phone resolves id to media/<id>.jpg.
// Files are retained with their conversations so old messages never lose their pictures.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fsx = require('./fsx');
const winsec = require('./winsec');

const ID_RE = /^[a-f0-9]{16}$/;
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const MAX_BYTES = 8 * 1024 * 1024;
const PICK_TIMEOUT_MS = 10 * 60000;

const PICK_MESSAGES = {
    cancelled: 'No photo was chosen.',
    unreadable: 'That file is not a picture the phone can use. Choose a JPG, PNG, BMP or GIF.',
    too_large: 'That picture is too large (over 32 MB or 60 megapixels).'
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

function whole(n) {
    return Number.isInteger(n) && n > 0 && n <= 100000 ? n : 0;
}

class Photos {
    constructor(phoneDir, log) {
        this.dir = path.join(phoneDir, 'media');
        this.log = log || null;
    }

    async pick() {
        fsx.ensureDir(this.dir);
        this.sweep();
        const tmp = path.join(this.dir, 'pick-' + process.pid + '-' + Date.now() + '.tmp');
        let r;
        try {
            r = await winsec.pickPhoto(tmp, PICK_TIMEOUT_MS);
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
        const width = whole(r.width);
        const height = whole(r.height);
        if (!buf || buf.length !== r.bytes || buf.length > MAX_BYTES || !width || !height || !isJpeg(buf)) {
            this.discard(tmp);
            this.say('warn', 'photos: the converted picture was not usable (' + (buf ? buf.length : 0) + ' bytes)');
            return { ok: false, code: 'unreadable', message: PICK_MESSAGES.unreadable };
        }
        const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
        const dest = path.join(this.dir, id + '.jpg');
        if (!inside(this.dir, dest)) {
            this.discard(tmp);
            throw new Error('photo target outside its folder');
        }
        if (fs.existsSync(dest)) {
            this.discard(tmp);
        } else {
            try {
                fs.renameSync(tmp, dest);
                if (fs.statSync(dest).size !== buf.length) throw new Error('saved photo truncated');
            } catch (e) {
                this.discard(tmp);
                this.discard(dest);
                throw e;
            }
        }
        const item = { id, width, height };
        this.say('info', 'photos: prepared ' + id + '.jpg (' + width + 'x' + height + ', ' + buf.length + ' bytes)');
        return { ok: true, code: 'ok', item, message: 'Photo ready to send.' };
    }

    // Inline JPEG for an OpenAI-compatible vision request. The id comes from the sanitized
    // mailbox entry, so this never follows a caller-supplied path outside ui/phone/media.
    dataUrl(image) {
        if (!image || !ID_RE.test(image.id)) return null;
        const file = path.join(this.dir, image.id + '.jpg');
        if (!inside(this.dir, file)) return null;
        try {
            const buf = fs.readFileSync(file);
            if (!buf.length || buf.length > MAX_BYTES || !isJpeg(buf)) return null;
            return 'data:image/jpeg;base64,' + buf.toString('base64');
        } catch (e) {
            return null;
        }
    }

    sweep() {
        let names;
        try { names = fs.readdirSync(this.dir); } catch (e) { return; }
        for (const name of names) {
            if (/^pick-\d+-\d+\.tmp$/.test(name)) this.discard(path.join(this.dir, name));
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

    say(level, message) {
        if (this.log && typeof this.log[level] === 'function') this.log[level](message);
    }
}

module.exports = { Photos, PICK_TIMEOUT_MS, ID_RE };
