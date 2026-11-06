'use strict';
// The Texts list in one file. Opening the phone's Texts list used to read six files for every
// one-to-one chat and four for every group, through the game, which lets a UI mod ask for about
// twenty files a second: with a dozen chats the list took seconds and kept the phone's request
// queue full while it polled. This service reads the same files from disk in a few milliseconds,
// so it writes what the list shows — each chat's newest message, its unread count and the
// contact's status — into one file, and the phone reads that instead (app.js loadTexts).
//
//   <phone>/sms/index.cfg  this service: { v, at, player, threads: { <contact id>: row },
//                                          groups: { <group id>: { meta, last, unread } } }
//   row: { last, unread, theirsAt, status }
//
// The rules are the phone's own (app.js loadConversation, cleanList, mergeThread, unreadCount,
// loadGroupSummary), so the list looks exactly as it did. `at` says how fresh the file is: the
// phone falls back to reading every file itself when it is old (the service is not running) or
// written for another played character.
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');

const V = 1;
const PHOTO_TEXT = '[Photo]';
// The file is written again at least this often, so the phone can tell a running service from a
// stopped one, and whenever what it says changes.
const HEARTBEAT_MS = 3000;
const ID_RE = /^\d{1,15}$/;
const GROUP_RE = /^[A-Za-z0-9_-]{1,40}$/;

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return undefined;
    }
}

function imageOf(raw) {
    if (!raw || typeof raw.id !== 'string' || !/^[a-f0-9]{16}$/.test(raw.id)) return null;
    const w = Number(raw.width);
    const h = Number(raw.height);
    if (Math.floor(w) !== w || Math.floor(h) !== h || w <= 0 || h <= 0 || w > 100000 || h > 100000) return null;
    return { id: raw.id, width: w, height: h };
}

function voiceOf(raw) {
    if (!raw || typeof raw.id !== 'string' || !/^[a-f0-9]{16}$/.test(raw.id)) return null;
    const seconds = Number(raw.seconds);
    return Number.isFinite(seconds) && seconds > 0 && seconds < 600 ? { id: raw.id, seconds } : null;
}

// app.js cleanList: the messages of one box the phone would show.
function cleanList(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const m = raw[i];
        if (!m || typeof m.text !== 'string' || typeof m.at !== 'number') continue;
        const image = imageOf(m.image);
        if (!m.text && !image) continue;
        const msg = { id: String(m.id || ('m-' + m.at + '-' + i)), text: m.text || PHOTO_TEXT, at: m.at, game: m.game || null };
        if (image) msg.image = image;
        const voice = voiceOf(m.voice);
        if (voice) msg.voice = voice;
        if (m.kind === 'notice') msg.notice = true;
        out.push(msg);
    }
    return out;
}

function prefixed(list, prefix) {
    return list.map((m) => Object.assign({}, m, { id: prefix + m.id }));
}

// The newest of mine and theirs, in mergeThread's order (by time; mine first on a tie; then id).
function newest(mine, theirs) {
    let best = null;
    const better = (a, b) => {
        if (!b) return true;
        if (a.at !== b.at) return a.at > b.at;
        if (a.side !== b.side) return a.side !== 'mine';
        return a.id > b.id;
    };
    for (const m of mine) {
        const row = { side: 'mine', id: m.id, text: m.text, image: m.image || null, voice: m.voice || null, at: m.at, game: m.game };
        if (better(row, best)) best = row;
    }
    for (const m of theirs) {
        const row = { side: m.notice ? 'notice' : 'theirs', id: m.id, text: m.text, image: m.image || null, voice: m.voice || null, at: m.at, game: m.game };
        if (better(row, best)) best = row;
    }
    return best;
}

// One one-to-one chat as the Texts list shows it (app.js loadConversation).
function threadRow(smsDir, playerId, contactId) {
    const dir = path.join(smsDir, playerId + '-' + contactId);
    const back = path.join(smsDir, contactId + '-' + playerId);
    const box = (d, name) => cleanList(readJson(path.join(d, name + '.cfg')));
    const mine = box(dir, 'outbox').concat(prefixed(box(back, 'inbox').filter((m) => !m.notice), 'r-'));
    const theirs = box(dir, 'inbox').concat(prefixed(box(back, 'outbox'), 'r-'));
    const seen = readJson(path.join(dir, 'seen.cfg'));
    const seenAt = seen && typeof seen.at === 'number' ? seen.at : 0;
    const status = readJson(path.join(dir, 'status.cfg'));
    let unread = 0;
    let theirsAt = 0;
    // The newest of theirs, for the phone's new-message banner (app.js bannerProbe, newestIncoming).
    let lastIn = null;
    for (const m of theirs) {
        if (m.at > seenAt) unread += 1;
        if (m.at > theirsAt) theirsAt = m.at;
        if (!lastIn || m.at > lastIn.at) lastIn = { id: m.id, text: m.text, at: m.at };
    }
    return { last: newest(mine, theirs), unread, theirsAt, lastIn, status: status && typeof status === 'object' ? status : null };
}

// One group as the Texts list shows it (app.js loadGroupSummary); null when it is not shown.
function groupRow(groupsDir, id) {
    const dir = path.join(groupsDir, 'g-' + id);
    const meta = readJson(path.join(dir, 'meta.cfg'));
    if (!meta || typeof meta !== 'object' || !Array.isArray(meta.members) || meta.closed) return null;
    const list = (name) => {
        const v = readJson(path.join(dir, name + '.cfg'));
        return Array.isArray(v) ? v.filter((m) => m && typeof m.text === 'string' && typeof m.at === 'number') : [];
    };
    const inbox = list('inbox');
    const outbox = list('outbox');
    const seen = readJson(path.join(dir, 'seen.cfg'));
    const seenAt = seen && typeof seen.at === 'number' ? seen.at : 0;
    let last = null;
    let theirsAt = 0;
    let unread = 0;
    for (const m of inbox) {
        if (!last || m.at >= last.at) last = { side: 'theirs', at: m.at, text: String(m.text || ''), name: String(m.name || ''), from: String(m.from || '') };
        if (m.at > seenAt) unread += 1;
        if (m.at > theirsAt) theirsAt = m.at;
    }
    for (const m of outbox) {
        if (!last || m.at >= last.at) last = { side: 'mine', at: m.at, text: String(m.text || ''), name: '', from: String(m.from || '') };
    }
    return { meta, last, unread, theirsAt };
}

class SmsIndex {
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.file = '';
        this.smsDir = '';
        this.groupsDir = '';
        this.written = '';
        this.writtenAt = 0;
        this.busy = false;
    }

    configure(smsDir, groupsDir) {
        this.smsDir = smsDir;
        this.groupsDir = groupsDir;
        this.file = path.join(smsDir, 'index.cfg');
        this.written = '';
    }

    // What the list of this player shows, from the files on disk.
    build(playerId) {
        const pid = String(playerId);
        const threads = {};
        let names = [];
        try { names = fs.readdirSync(this.smsDir, { withFileTypes: true }); } catch (e) { names = []; }
        for (const d of names) {
            if (!d.isDirectory()) continue;
            const m = /^(\d+)-(\d+)$/.exec(d.name);
            if (!m || m[1] !== pid || !ID_RE.test(m[2])) continue;
            threads[m[2]] = threadRow(this.smsDir, pid, m[2]);
        }
        const groups = {};
        let dirs = [];
        try { dirs = this.groupsDir ? fs.readdirSync(this.groupsDir, { withFileTypes: true }) : []; } catch (e) { dirs = []; }
        for (const d of dirs) {
            if (!d.isDirectory() || !/^g-/.test(d.name)) continue;
            const id = d.name.slice(2);
            if (!GROUP_RE.test(id)) continue;
            const row = groupRow(this.groupsDir, id);
            if (!row) continue;
            const members = row.meta.members.map((x) => String(x && typeof x === 'object' ? (x.id !== undefined ? x.id : x.entity_id) : x));
            if (String(row.meta.owner) !== pid && members.indexOf(pid) < 0) continue;
            groups[id] = row;
        }
        return { threads, groups };
    }

    // Every second or two, from the daemon.
    async tick() {
        if (!this.file || this.busy) return;
        this.busy = true;
        try {
            const playerId = await this.d.world.possessed().catch(() => null);
            if (!playerId) return;
            const body = this.build(playerId);
            const text = JSON.stringify({ player: String(playerId), threads: body.threads, groups: body.groups });
            const now = Date.now();
            if (text === this.written && now - this.writtenAt < HEARTBEAT_MS) return;
            fsx.writeJson(this.file, { v: V, at: now, player: String(playerId), threads: body.threads, groups: body.groups });
            this.written = text;
            this.writtenAt = now;
        } catch (e) {
            this.log.debug('smsindex: ' + (e && e.message || e));
        } finally {
            this.busy = false;
        }
    }
}

module.exports = { SmsIndex, threadRow, groupRow, cleanList, newest, HEARTBEAT_MS };
