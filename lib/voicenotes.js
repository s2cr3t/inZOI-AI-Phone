'use strict';
// Voice messages from the family: each text of a household member's reply is followed by the same
// words as a voice message, spoken by the local TTS service (lib/tts.js) in that member's own voice.
// Speaking starts as soon as the reply is written, while its texts are still being typed out.
//
// A clip is written to the phone as ui/phone/media/<id>.webm (the only kind of file the game's
// phone can play) and the inbox gets { kind: 'voice', text, voice: { id, seconds } }. Nothing here
// holds up the texts: a voice follows its text when it is ready, and when the TTS service is not
// running or a clip fails there is simply no voice message.
//
// Each member's voice is designed once from their sex and age, and kept by the TTS service under
// zoi-<household tag>-<entity id>; which of a few timbres they get follows from the id, so two
// sisters of an age do not sound alike. Designing takes minutes while the game is running, so
// prepare() designs the household's voices as soon as the household is known, not at the first reply.
const crypto = require('crypto');
const path = require('path');
const fsx = require('./fsx');
const tts = require('./tts');

const CHECK_MS = 30000;
const MAX_QUEUE = 4;
const MAX_CHARS = 150;
// Too young for a phone (world.js NO_PHONE): no voice to prepare.
const NO_PHONE_RE = /^(Baby|Infant|Toddler)$/;

const AGES = [
    { re: /^(Child)$/, words: '十岁左右的', kid: true },
    { re: /^(LowTeen)$/, words: '十三四岁的', kid: true },
    { re: /^(HighTeen|Teen)$/, words: '十六七岁的' },
    { re: /^(Youth|YoungAdult)$/, words: '二十多岁的' },
    { re: /^(Adult)$/, words: '三十多岁的' },
    { re: /^(Old)$/, words: '五十岁左右的' },
    { re: /^(Elderly|Elder)$/, words: '七十岁左右的', old: true }
];
const TIMBRES = {
    female: ['声音温柔，语速自然', '声音清亮干脆，说话利落', '声音略低、有点慵懒，说话随意', '声音甜美明快，说话带笑'],
    male: ['声音温和，语速自然', '声音低沉浑厚，说话稳重', '声音清朗有精神，说话爽快', '声音有点沙哑，说话随意']
};

// How every voice talks: the reference clip a voice is designed with sets the manner of each
// message cloned from it, and a clip read out like a script makes every message sound read out.
// Described as a chat caught on a phone (with the service's off-the-cuff reference line), the
// clip has the false starts, fillers and uneven pace of a person talking, and so do the messages.
// Nothing that would have the designer say more than the reference words (a laugh, a restart):
// the clone needs the clip and its words to match, or it loses the voice.
const CASUAL = '这是手机随手录下的一段日常聊天，不是配音也不是朗读：说话随性自然，语速时快时慢，气息放松，带一点笑意。';

function isMale(m) { return /^m/i.test(String(m && m.gender || '')); }

// The voice in words, for the TTS service's voice design.
function describe(member, seed) {
    const group = String(member && member.age_group || '');
    const age = AGES.find((a) => a.re.test(group)) || AGES[4];
    const male = isMale(member);
    const who = age.kid ? (male ? '小男孩' : '小女孩') : age.old ? (male ? '老爷爷' : '老奶奶') : (male ? '男性' : '女性');
    const list = TIMBRES[male ? 'male' : 'female'];
    let timbre = list[seed % list.length];
    if (age.kid) timbre = '声音稚嫩清脆，说话活泼';
    else if (age.old) timbre = male ? '声音苍老但有精神，语速偏慢' : '声音略带沙哑，语速偏慢，慈祥温和';
    return age.words + who + '，' + timbre + '。' + CASUAL;
}

function voiceIdOf(tag, entityId) {
    return ('zoi-' + (tag || 'x') + '-' + entityId).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
}

function seedOf(id) {
    return crypto.createHash('md5').update(String(id)).digest().readUInt32LE(0);
}

class VoiceNotes {
    constructor({ log }) {
        this.mailbox = null;
        this.phoneDir = '';
        this.log = log;
        this.queue = Promise.resolve();
        this.waiting = 0;
        this.checkedAt = 0;
        this.up = false;
        // voice id -> the description it was designed from; a character who grows up wants another.
        this.ready = new Map();
        this.preparing = false;
    }

    // mailbox: lib/mailbox.js; phoneDir: ui/phone of the phone mod. Both change with the config.
    configure(mailbox, phoneDir) {
        this.mailbox = mailbox;
        this.phoneDir = phoneDir;
    }

    async available() {
        if (Date.now() - this.checkedAt < CHECK_MS) return this.up;
        this.checkedAt = Date.now();
        const was = this.up;
        this.up = await tts.available();
        if (this.up !== was) this.log.info('voice: TTS service ' + (this.up ? 'available at ' + tts.baseUrl() : 'not available'));
        return this.up;
    }

    // Designs the voices of the household's members that the TTS service does not have yet, or
    // has for an age they have grown out of, one after another in the background. Called on every household check: it does nothing while a
    // round is running or once every voice is there, and a round without the service is retried
    // at the next check.
    prepare(tag, members) {
        if (this.preparing || !tag || !Array.isArray(members)) return;
        const todo = members.filter((m) => m && m.entity_id != null && !NO_PHONE_RE.test(String(m.age_group || '')))
            .map((m) => {
                const voice = voiceIdOf(tag, m.entity_id);
                return { member: m, voice, description: describe(m, seedOf(voice)) };
            })
            .filter((t) => this.ready.get(t.voice) !== t.description);
        if (!todo.length) return;
        this.preparing = true;
        this.queue = this.queue
            .then(() => this.design(todo))
            .catch((e) => this.log.warn('voice: preparing voices failed: ' + (e && e.message || e)))
            .then(() => { this.preparing = false; });
    }

    async design(todo) {
        if (!(await this.available())) return;
        const known = await tts.voices();
        if (!known.ok) throw new Error(known.error);
        const have = new Map(known.value.map((v) => [v.id, v.description]));
        for (const t of todo) {
            const description = t.description;
            if (have.get(t.voice) === description) {
                this.ready.set(t.voice, description);
                continue;
            }
            const started = Date.now();
            const made = await tts.ensureVoice(t.voice, { description });
            if (!made.ok) {
                this.log.warn('voice: designing ' + t.voice + ' failed: ' + made.error);
                continue;
            }
            this.ready.set(t.voice, description);
            this.log.info('voice: ' + (have.has(t.voice) ? 'redesigned ' : 'designed ') + t.voice + ' (' + description + ') in ' + (Date.now() - started) + 'ms');
        }
    }

    // Starts speaking a reply the moment its texts are known, before they are typed out: one voice
    // message for the whole reply, its texts said one after another as a person leaves one voice
    // note, not a note per text. It goes into the chat once the last text has (delivered(i,
    // textId) for each), drawn in that text's bubble; typing the texts out takes about as long as
    // speaking them.
    // pair: the world pair (partner is the member who replied); tag: the household's tag; env: a
    // function giving the game's environment state when a voice is posted (for its game time).
    // Returns { delivered(i, textId), cancel() }; never throws, and nothing waits on it. A reply that is
    // never delivered (it failed on the way) is cancelled, and its voice is never posted.
    // spoken: how each bubble is read aloud (the reply's voice lines), or none.
    begin({ key, pair, tag, bubbles, spoken, reAt, env }) {
        const items = [{ said: joinSpoken(bubbles.map((b, i) => speakableLine((spoken && spoken[i]) || b))), clip: null, done: false, shown: false, posted: false }];
        const seen = new Set();
        const handle = { cancelled: false, chain: Promise.resolve(), delivered: () => {}, cancel: () => {} };
        if (!items.some((it) => it.said)) return handle;
        if (this.waiting >= MAX_QUEUE) {
            this.log.info('voice [' + key + '] skipped, ' + this.waiting + ' replies already being spoken');
            return handle;
        }
        const started = Date.now();
        const post = () => {
            for (const it of items) {
                if (handle.cancelled || !it.shown || !it.done) return;
                if (it.posted) continue;
                it.posted = true;
                // One after another: a slow game clock must not let a later voice in first.
                if (it.clip) {
                    handle.chain = handle.chain.then(() => this.post(key, it, reAt, env, started))
                        .catch((e) => this.log.warn('voice [' + key + '] not posted: ' + (e && e.message || e)));
                }
            }
        };
        handle.delivered = (i, textId) => {
            seen.add(i);
            if (i === bubbles.length - 1) items[0].of = textId || null;
            if (seen.size >= bubbles.length) items[0].shown = true;
            post();
        };
        handle.cancel = () => { handle.cancelled = true; };
        this.waiting++;
        this.queue = this.queue
            .then(() => this.speakAll(key, pair, tag, items, handle, post))
            .catch((e) => this.log.warn('voice [' + key + '] failed: ' + (e && e.message || e)))
            .then(() => {
                this.waiting--;
                for (const it of items) it.done = true;
                post();
            });
        return handle;
    }

    async speakAll(key, pair, tag, items, handle, post) {
        if (!this.mailbox || !this.phoneDir || !(await this.available())) return;
        const partner = pair.partner || {};
        const voice = voiceIdOf(tag, String(partner.entity_id || pair.partnerId));
        const description = describe(partner, seedOf(voice));
        if (this.ready.get(voice) !== description) {
            const started = Date.now();
            const made = await tts.ensureVoice(voice, { description });
            if (!made.ok) throw new Error('voice not made: ' + made.error);
            this.ready.set(voice, description);
            if (made.created) this.log.info('voice [' + key + '] designed ' + voice + ' in ' + (Date.now() - started) + 'ms');
        }
        for (const it of items) {
            if (handle.cancelled) return;
            if (it.said) {
                const started = Date.now();
                const r = await tts.speak({ text: it.said, voice, format: 'webm' });
                if (!r.ok) throw new Error(r.error);
                it.clip = { buffer: r.buffer, seconds: r.seconds || 1, text: r.text, ms: Date.now() - started };
            }
            it.done = true;
            post();
        }
    }

    async post(key, it, reAt, env, started) {
        const id = crypto.randomBytes(8).toString('hex');
        fsx.writeAtomic(path.join(this.phoneDir, 'media', id + '.webm'), it.clip.buffer);
        const at = typeof env === 'function' ? await env() : env;
        const voice = { id, seconds: it.clip.seconds };
        if (it.of) voice.of = it.of;
        this.mailbox.append(key, it.clip.text, reAt, 'voice', at, { voice });
        this.log.info('voice [' + key + '] ' + it.clip.seconds + 's spoken in ' + it.clip.ms + 'ms, posted '
            + (Date.now() - started) + 'ms after the reply -> ' + JSON.stringify(it.clip.text));
    }
}

// A reply's lines as one voice note: each runs into the next after a pause (a comma where a line
// has no ending of its own), cut at a pause past MAX_CHARS.
function joinSpoken(lines) {
    const said = lines.filter(Boolean);
    let text = said.map((s, i) => (i < said.length - 1 && !/[。！？!?…，,]$/.test(s) ? s + '，' : s)).join('');
    if (text.length > MAX_CHARS) {
        const cut = text.slice(0, MAX_CHARS);
        const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'), cut.lastIndexOf('，'));
        text = end > MAX_CHARS / 3 ? cut.slice(0, end + 1) : cut;
    }
    return text;
}

// One bubble as it is said ('' when nothing in it can be said). A text without a full stop is
// not given one: chat trails off, and a full stop reads it out like a sentence in a book.
function speakableLine(bubble) {
    return tts.speakable(bubble).slice(0, MAX_CHARS);
}

module.exports = { VoiceNotes, describe, speakableLine };
