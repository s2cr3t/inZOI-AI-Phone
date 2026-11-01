'use strict';
// Phone mailbox on disk, one folder per conversation:
//   <dir>/<playerId>-<contactId>/{outbox,inbox,seen,status}.cfg
//   outbox.cfg  texts typed on the phone by the played character (written only by the phone)
//   inbox.cfg   texts from the contact (written by the bridge / Cursor MCP)
//   seen.cfg    {at} newest inbox message the player has looked at (written by the phone)
//   status.cfg  bridge presence for the phone: online / typing / error (written by the bridge)
// Inbox entries carry reAt = the newest outbox `at` they answer, so a text that arrives while
// a reply is being generated is still treated as unanswered.
// Two characters share one conversation. A-B holds what was written while playing A, B-A what
// was written while playing B; every file keeps its single writer and thread() merges both
// folders from the point of view of the key's player:
//   mine:   A-B/outbox (typed as A)  + B-A/inbox  (replies written for A)
//   theirs: A-B/inbox  (replies by B) + B-A/outbox (typed as B)
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');

const KEY_RE = /^(\d+)-(\d+)$/;

// The game clock when a message was written: { day, min } (game day number, minute of that day).
// The phone shows message times in game time; messages from before this have none.
function gameStamp(env) {
    if (!env || typeof env.day !== 'number' || typeof env.hour !== 'number') return null;
    return { day: env.day, min: env.hour * 60 + (typeof env.minute === 'number' ? env.minute : 0) };
}

function cleanGame(g) {
    return g && typeof g.day === 'number' && typeof g.min === 'number' ? { day: g.day, min: g.min } : null;
}

function cleanImage(raw) {
    if (!raw || typeof raw.id !== 'string' || !/^[a-f0-9]{16}$/.test(raw.id)) return null;
    const width = Number.isInteger(raw.width) && raw.width > 0 && raw.width <= 100000 ? raw.width : 0;
    const height = Number.isInteger(raw.height) && raw.height > 0 && raw.height <= 100000 ? raw.height : 0;
    return width && height ? { id: raw.id, width, height } : null;
}

function cleanMessages(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (let i = 0; i < value.length; i++) {
        const m = value[i];
        if (!m || typeof m.text !== 'string' || typeof m.at !== 'number') continue;
        const image = cleanImage(m.image);
        if (!m.text && !image) continue;
        const msg = { id: String(m.id || ('m-' + m.at + '-' + i)), text: m.text || '[Photo]', at: m.at };
        if (image) msg.image = image;
        if (typeof m.reAt === 'number') msg.reAt = m.reAt;
        if (typeof m.kind === 'string') msg.kind = m.kind;
        const game = cleanGame(m.game);
        if (game) msg.game = game;
        out.push(msg);
    }
    return out;
}

function sanitizeText(text, max) {
    let s = String(text === undefined || text === null ? '' : text);
    s = s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    s = s.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
    if (s.length > max) s = s.slice(0, max);
    return s;
}

function threadKey(playerId, contactId) {
    const key = String(playerId) + '-' + String(contactId);
    if (!KEY_RE.test(key)) throw new Error('invalid thread ' + key);
    return key;
}

function parseKey(key) {
    const m = KEY_RE.exec(String(key));
    if (!m) throw new Error('invalid thread ' + key);
    return { key: String(key), playerId: m[1], contactId: m[2] };
}

class Mailbox {
    constructor(options) {
        const o = options || {};
        this.dir = o.dir;
        this.keep = o.keep || 200;
        this.textMax = o.textMax || 400;
        this.seq = 0;
    }

    threadDir(key) {
        return path.join(this.dir, parseKey(key).key);
    }

    file(key, name) {
        return path.join(this.threadDir(key), name + '.cfg');
    }

    ensure(key) {
        fsx.ensureDir(this.threadDir(key));
    }

    threads() {
        let names = [];
        try { names = fs.readdirSync(this.dir, { withFileTypes: true }); } catch (e) { return []; }
        return names.filter((d) => d.isDirectory() && KEY_RE.test(d.name)).map((d) => parseKey(d.name));
    }

    // Returns an array, or null when the file is mid-write / unreadable (caller retries later).
    readBox(key, name) {
        const r = fsx.readJson(this.file(key, name));
        if (r.ok) return cleanMessages(r.value);
        return r.missing ? [] : null;
    }

    readObject(key, name) {
        const r = fsx.readJson(this.file(key, name));
        return r.ok && r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : null;
    }

    // The shared conversation seen by the key's player. pending = texts typed as the player that
    // the contact has not answered yet, either through a reply here or by typing as the contact.
    thread(key) {
        const k = parseKey(key);
        const reverse = threadKey(k.contactId, k.playerId);
        const outbox = this.readBox(key, 'outbox');
        const inbox = this.readBox(key, 'inbox');
        const reverseOutbox = this.readBox(reverse, 'outbox');
        const reverseInbox = this.readBox(reverse, 'inbox');
        if (outbox === null || inbox === null || reverseOutbox === null || reverseInbox === null) return null;
        const seen = this.readObject(key, 'seen');
        const messages = [];
        for (const m of outbox) messages.push({ side: 'player', id: m.id, text: m.text, image: m.image || null, at: m.at, game: m.game, kind: 'typed' });
        for (const m of reverseInbox) messages.push({ side: 'player', id: 'r-' + m.id, text: m.text, image: m.image || null, at: m.at, game: m.game, kind: m.kind || 'reply' });
        for (const m of inbox) messages.push({ side: 'partner', id: m.id, text: m.text, image: m.image || null, at: m.at, game: m.game, kind: m.kind || 'reply' });
        for (const m of reverseOutbox) messages.push({ side: 'partner', id: 'r-' + m.id, text: m.text, image: m.image || null, at: m.at, game: m.game, kind: 'typed' });
        messages.sort((a, b) => a.at - b.at || (a.side === b.side ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.side === 'player' ? -1 : 1));
        const repliedAt = inbox.reduce((max, m) => Math.max(max, typeof m.reAt === 'number' ? m.reAt : m.at), 0);
        const typedBackAt = reverseOutbox.reduce((max, m) => Math.max(max, m.at), 0);
        const answeredAt = Math.max(repliedAt, typedBackAt);
        const pending = outbox.filter((m) => m.at > answeredAt).sort((a, b) => a.at - b.at);
        return {
            key: k.key,
            reverseKey: reverse,
            playerId: k.playerId,
            contactId: k.contactId,
            outbox,
            inbox,
            reverseOutbox,
            reverseInbox,
            messages,
            pending,
            answeredAt,
            seenAt: seen && typeof seen.at === 'number' ? seen.at : 0
        };
    }

    // Appends one contact message. kind: 'reply' | 'proactive' | 'manual'. env: the game's
    // environment state at that moment, for the game-time stamp (optional).
    append(key, text, reAt, kind, env) {
        const body = sanitizeText(text, this.textMax);
        if (!body) throw new Error('text is empty');
        const file = this.file(key, 'inbox');
        fsx.ensureDir(path.dirname(file));
        return fsx.withLock(file + '.lock', () => {
            const r = fsx.readJson(file);
            if (!r.ok && !r.missing) throw new Error('inbox is unreadable: ' + r.error);
            const inbox = r.ok ? cleanMessages(r.value) : [];
            const lastAt = inbox.reduce((max, m) => Math.max(max, m.at), 0);
            const at = Math.max(Date.now(), lastAt + 1);
            this.seq = (this.seq + 1) % 1000;
            const msg = { id: 'h-' + at + '-' + this.seq, text: body, at, kind: kind || 'reply' };
            if (typeof reAt === 'number' && reAt >= 0) msg.reAt = reAt;
            const game = gameStamp(env);
            if (game) msg.game = game;
            inbox.push(msg);
            const trimmed = inbox.length > this.keep ? inbox.slice(inbox.length - this.keep) : inbox;
            fsx.writeJson(file, trimmed);
            return msg;
        });
    }

    writeStatus(key, status) {
        fsx.writeJson(this.file(key, 'status'), status);
    }

    readStatus(key) {
        return this.readObject(key, 'status');
    }

    // Empties every conversation the phone can show. The phone asks for this by writing
    // clear.cfg. This is the one place the bridge replaces an outbox or a seen file, and it
    // only writes an empty list. status.cfg stays, because it is presence, not the messages.
    clearConversations() {
        const threads = this.threads();
        let messages = 0;
        for (let i = 0; i < threads.length; i++) {
            const key = threads[i].key;
            for (let n = 0; n < 2; n++) {
                const name = n === 0 ? 'outbox' : 'inbox';
                const file = this.file(key, name);
                const before = fsx.readJson(file);
                if (before.ok && Array.isArray(before.value)) messages += before.value.length;
                fsx.withLock(file + '.lock', () => { fsx.writeJson(file, []); });
                const after = fsx.readJson(file);
                const left = after.ok && Array.isArray(after.value) ? after.value.length : -1;
                if (left !== 0) throw new Error(key + ' ' + name + ' still has ' + left);
            }
            const seen = this.file(key, 'seen');
            fsx.withLock(seen + '.lock', () => { fsx.writeJson(seen, { at: 0 }); });
        }
        return messages;
    }

    // Moves a pre-contacts thread folder (<dir>/<playerId>/) to <dir>/<playerId>-<contactId>/.
    migratePlayerDir(playerId, contactId) {
        const from = path.join(this.dir, String(playerId));
        const to = this.threadDir(threadKey(playerId, contactId));
        if (!fs.existsSync(from)) return false;
        if (fs.existsSync(to)) throw new Error(to + ' already exists');
        fs.renameSync(from, to);
        return true;
    }
}

module.exports = { Mailbox, sanitizeText, cleanMessages, gameStamp, threadKey, parseKey };
