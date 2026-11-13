'use strict';
// Face-to-face talks: the "智能对话" box the phone mod's focus app opens on a character picked
// from the game's interaction menu. Kept apart from the texts (mailbox.js) so what was said in
// person never shows up as a text message. One folder per pair, next to the phone's own folder:
//   <dir>/<playerId>-<targetId>/{said,heard,status,session}.cfg
//   said.cfg     [{id, text, at}] what the played character said (written only by the focus app)
//   heard.cfg    [{id, text, at, reAt, face, gesture}] the target's answers (written only here)
//   status.cfg   {state: online | thinking | error | offline, error, at} (written only here)
//   session.cfg  {state: open | closed, at} whether the box is open (written only by the focus app)
// heard entries carry reAt = the newest said `at` they answer, so what is said while an answer is
// being thought out is still answered.
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');
const { sanitizeText, parseKey } = require('./mailbox');

const KEY_RE = /^(\d+)-(\d+)$/;
const FILES = ['said', 'heard', 'status', 'session'];
// The phone's emoji tokens, English or Chinese: [smile], [白眼].
const EMOJI_TOKEN_RE = /\[[^\[\]\s]{1,12}\]/g;

function cleanLines(value, withReply) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (let i = 0; i < value.length; i++) {
        const m = value[i];
        if (!m || typeof m.text !== 'string' || !m.text.trim() || typeof m.at !== 'number') continue;
        const line = { id: String(m.id || ('t-' + m.at + '-' + i)), text: m.text, at: m.at };
        if (withReply) {
            if (typeof m.reAt === 'number') line.reAt = m.reAt;
            if (typeof m.face === 'string') line.face = m.face;
            if (typeof m.gesture === 'string') line.gesture = m.gesture;
        }
        out.push(line);
    }
    return out.sort((a, b) => a.at - b.at);
}

class FocusTalks {
    constructor(options) {
        const o = options || {};
        this.dir = o.dir;
        this.keep = o.keep || 80;
        this.textMax = o.textMax || 200;
        this.seq = 0;
    }

    file(key, name) {
        return path.join(this.dir, parseKey(key).key, name + '.cfg');
    }

    talks() {
        let names = [];
        try { names = fs.readdirSync(this.dir, { withFileTypes: true }); } catch (e) { return []; }
        return names.filter((d) => d.isDirectory() && KEY_RE.test(d.name)).map((d) => parseKey(d.name));
    }

    // Array, or null while the file is mid-write.
    readLines(key, name) {
        const r = fsx.readJson(this.file(key, name));
        if (r.ok) return cleanLines(r.value, name === 'heard');
        return r.missing ? [] : null;
    }

    readObject(key, name) {
        const r = fsx.readJson(this.file(key, name));
        return r.ok && r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : null;
    }

    // The talk as the played character sees it. pending: what was said and not answered yet.
    // messages use the mailbox's sides (player / partner) so the prompt helpers read them alike.
    talk(key) {
        const k = parseKey(key);
        const said = this.readLines(key, 'said');
        const heard = this.readLines(key, 'heard');
        if (said === null || heard === null) return null;
        const session = this.readObject(key, 'session');
        const answeredAt = heard.reduce((max, m) => Math.max(max, typeof m.reAt === 'number' ? m.reAt : m.at), 0);
        const messages = said.map((m) => ({ side: 'player', id: m.id, text: m.text, at: m.at, kind: 'talk' }))
            .concat(heard.map((m) => ({ side: 'partner', id: m.id, text: m.text, at: m.at, kind: 'talk' })))
            .sort((a, b) => a.at - b.at || (a.side === b.side ? 0 : a.side === 'player' ? -1 : 1));
        return {
            key: k.key,
            playerId: k.playerId,
            contactId: k.contactId,
            said,
            heard,
            messages,
            pending: said.filter((m) => m.at > answeredAt),
            answeredAt,
            open: !!(session && session.state === 'open'),
            sessionAt: session && typeof session.at === 'number' ? session.at : 0
        };
    }

    // Appends one answer. face / gesture: what the character's face and body do as it is said.
    append(key, text, reAt, extra) {
        // Said aloud: the phone's emoji tokens ([smile]) mean nothing here.
        const body = sanitizeText(String(text || '').replace(EMOJI_TOKEN_RE, ''), this.textMax);
        if (!body) throw new Error('text is empty');
        const list = this.readLines(key, 'heard') || [];
        const now = Date.now();
        const at = Math.max(now, list.length ? list[list.length - 1].at + 1 : 0);
        const line = { id: 'h-' + at + '-' + (++this.seq), text: body, at };
        if (typeof reAt === 'number') line.reAt = reAt;
        if (extra && extra.face) line.face = String(extra.face);
        if (extra && extra.gesture) line.gesture = String(extra.gesture);
        list.push(line);
        // Over the limit, cut down to three quarters of it, not by one: the box has looked for
        // new lines by the count changing, and a list held at the limit kept the same count with
        // every new line, so a long lesson's teacher went silent on screen.
        const kept = list.length > this.keep ? list.slice(list.length - Math.floor(this.keep * 3 / 4)) : list;
        fsx.writeJson(this.file(key, 'heard'), kept);
        return line;
    }

    writeStatus(key, status) {
        fsx.writeJson(this.file(key, 'status'), Object.assign({ at: Date.now() }, status));
    }
}

module.exports = { FocusTalks, FILES };
