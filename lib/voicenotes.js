'use strict';
// Voice messages from the family: after a household member texts a reply, the same words follow
// as a voice message, spoken by the local TTS service (lib/tts.js) in that member's own voice.
//
// The clip is written to the phone as ui/phone/media/<id>.webm (the only kind of file the game's
// phone can play) and the inbox gets { kind: 'voice', text, voice: { id, seconds } }. Nothing here
// holds up the text: the texts go out first, the voice follows when it is ready, and when the TTS
// service is not running or a clip fails there is simply no voice message.
//
// Each member's voice is designed once from their sex and age, and kept by the TTS service under
// zoi-<household tag>-<entity id>; which of a few timbres they get follows from the id, so two
// sisters of an age do not sound alike. Designing takes minutes while the game is running, so
// prepare() designs the household's voices as soon as the household is known, not at the first reply.
const crypto = require('crypto');
const path = require('path');
const tts = require('./tts');

const CHECK_MS = 30000;
const MAX_QUEUE = 4;
const MAX_CHARS = 120;
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
    return age.words + who + '，' + timbre + '。';
}

function voiceIdOf(tag, entityId) {
    return ('zoi-' + (tag || 'x') + '-' + entityId).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
}

function seedOf(id) {
    return crypto.createHash('md5').update(String(id)).digest().readUInt32LE(0);
}

// The texts of one reply as one thing to say: each bubble becomes a sentence.
function joinBubbles(bubbles) {
    const said = bubbles.map((b) => tts.speakable(b)).filter(Boolean)
        .map((s) => (/[。！？!?…~～]$/.test(s) ? s : s + '。'));
    let text = said.join('');
    if (text.length > MAX_CHARS) {
        const cut = text.slice(0, MAX_CHARS);
        const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
        text = end > MAX_CHARS / 3 ? cut.slice(0, end + 1) : cut;
    }
    return text;
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
        this.ready = new Set();
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

    // Designs the voices of the household's members that the TTS service does not have yet, one
    // after another in the background. Called on every household check: it does nothing while a
    // round is running or once every voice is there, and a round without the service is retried
    // at the next check.
    prepare(tag, members) {
        if (this.preparing || !tag || !Array.isArray(members)) return;
        const todo = members.filter((m) => m && m.entity_id != null && !NO_PHONE_RE.test(String(m.age_group || '')))
            .map((m) => ({ member: m, voice: voiceIdOf(tag, m.entity_id) }))
            .filter((t) => !this.ready.has(t.voice));
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
        const have = new Set(known.value.map((v) => v.id));
        for (const t of todo) {
            if (have.has(t.voice)) {
                this.ready.add(t.voice);
                continue;
            }
            const started = Date.now();
            const description = describe(t.member, seedOf(t.voice));
            const made = await tts.ensureVoice(t.voice, { description });
            if (!made.ok) {
                this.log.warn('voice: designing ' + t.voice + ' failed: ' + made.error);
                continue;
            }
            this.ready.add(t.voice);
            this.log.info('voice: designed ' + t.voice + ' (' + description + ') in ' + (Date.now() - started) + 'ms');
        }
    }

    // Queues the voice message that follows a reply. Never throws and never waits for the clip.
    // pair: the world pair (partner is the member who replied); tag: the household's tag; env: the
    // game's environment state, or a function giving it when the clip is ready (for its game time).
    follow({ key, pair, tag, bubbles, reAt, env }) {
        if (this.waiting >= MAX_QUEUE) {
            this.log.info('voice [' + key + '] skipped, ' + this.waiting + ' clips already waiting');
            return;
        }
        this.waiting++;
        this.queue = this.queue
            .then(() => this.send({ key, pair, tag, bubbles, reAt, env }))
            .catch((e) => this.log.warn('voice [' + key + '] failed: ' + (e && e.message || e)))
            .then(() => { this.waiting--; });
    }

    async send({ key, pair, tag, bubbles, reAt, env }) {
        if (!this.mailbox || !this.phoneDir || !(await this.available())) return null;
        const text = joinBubbles(bubbles);
        if (!text) return null;
        const partner = pair.partner || {};
        const id = String(partner.entity_id || pair.partnerId);
        const voice = voiceIdOf(tag, id);
        const started = Date.now();
        const made = await tts.ensureVoice(voice, { description: describe(partner, seedOf(voice)) });
        if (!made.ok) throw new Error('voice not made: ' + made.error);
        this.ready.add(voice);
        if (made.created) this.log.info('voice [' + key + '] designed ' + voice + ' in ' + (Date.now() - started) + 'ms');
        const clip = crypto.randomBytes(8).toString('hex');
        const out = path.join(this.phoneDir, 'media', clip + '.webm');
        const r = await tts.speak({ text, voice, out, format: 'webm' });
        if (!r.ok) throw new Error(r.error);
        const at = typeof env === 'function' ? await env() : env;
        const msg = this.mailbox.append(key, r.text, reAt, 'voice', at, { voice: { id: clip, seconds: r.seconds || 1 } });
        this.log.info('voice [' + key + '] ' + (r.seconds || '?') + 's in ' + (Date.now() - started) + 'ms -> ' + JSON.stringify(r.text));
        return msg;
    }
}

module.exports = { VoiceNotes, describe, joinBubbles };
