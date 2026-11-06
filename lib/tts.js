'use strict';
// Voice messages: text to speech through the local TTS service (tts/server.py, Qwen3-TTS).
//
// The service is a separate Python program on 127.0.0.1 (default port 8770, INZOI_TTS_URL
// overrides). It keeps one voice per id: a voice is designed once from a description such as
// "二十多岁的女生，声音清亮" and every later message in that voice is cloned from the clip the
// design produced, so a character sounds the same in every message.
//
//   const tts = require('./tts');
//   if (await tts.available()) {
//       await tts.ensureVoice('zoi-123', { description: '...' });
//       const r = await tts.speak({ text: '今天好累啊[叹气]', voice: 'zoi-123', out: 'x.ogg' });
//   }
//
// speak() writes Ogg Vorbis by default; the phone itself plays only WebM (VP8 + Vorbis, through
// a <video>), so voice messages ask for format 'webm' (lib/voicenotes.js).
const fsx = require('./fsx');

const DEFAULT_URL = 'http://127.0.0.1:8770';
const HEALTH_TIMEOUT_MS = 1500;
// The first request after the service starts loads the model, designing a voice loads a second
// one, and while the game is running it holds most of the GPU: a clip can take minutes.
const SPEAK_TIMEOUT_MS = 300000;
const DESIGN_TIMEOUT_MS = 600000;
// Longer text is cut at a sentence end; a voice message is a few sentences, not a speech.
const MAX_CHARS = 200;

// Emoji characters and the joiners and variation selectors that build them (as lib/emoji.js).
const PICTO_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\p{Extended_Pictographic}]*/gu;

function baseUrl() {
    return (process.env.INZOI_TTS_URL || DEFAULT_URL).replace(/\/+$/, '');
}

// The text as it should be spoken: emoji tokens like [偷笑] and emoji characters dropped, links
// dropped, runs of punctuation and laughter shortened, tildes turned into a pause. Returns ''
// when nothing speakable is left.
function speakable(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/https?:\/\/\S+/g, '')
        .replace(/\[[^\[\]\s]{1,6}\]/g, '')
        .replace(PICTO_RE, '')
        .replace(/[\u{FE0F}\u{200D}]/gu, '')
        .replace(/[~～]+/g, '，')
        .replace(/(?:\.{3,}|。{2,}|…+)/g, '…')
        .replace(/([！!？?])[！!？?]+/g, '$1')
        .replace(/([，,])[，,\s]*/g, '$1')
        .replace(/(哈){4,}/g, '哈哈哈')
        .replace(/[hH]{3,}/g, '哈哈哈')
        .replace(/[ \t　]+/g, ' ')
        .replace(/\s*\n+\s*/g, '，')
        .trim()
        .replace(/^[，,、\s]+/, '')
        .replace(/[，,、\s]+$/, '');
    if (!/[\p{L}\p{N}]/u.test(s)) return '';
    if (s.length > MAX_CHARS) {
        const cut = s.slice(0, MAX_CHARS);
        const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'));
        s = end > MAX_CHARS / 2 ? cut.slice(0, end + 1) : cut;
    }
    return s;
}

async function request(method, route, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(baseUrl() + route, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: ctrl.signal
        });
        const type = res.headers.get('content-type') || '';
        if (type.startsWith('application/json')) {
            const value = await res.json();
            return res.ok ? { ok: true, value } : { ok: false, error: (value && value.error) || 'HTTP ' + res.status };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const seconds = Number(res.headers.get('x-audio-seconds'));
        return res.ok ? { ok: true, buffer: buf, type, seconds: seconds > 0 ? seconds : null } : { ok: false, error: 'HTTP ' + res.status };
    } catch (e) {
        return { ok: false, error: e.name === 'AbortError' ? 'timed out' : e.message };
    } finally {
        clearTimeout(timer);
    }
}

// Whether the service is running and has its model ready to load.
async function available() {
    const r = await request('GET', '/health', null, HEALTH_TIMEOUT_MS);
    return r.ok && !!r.value && r.value.ok === true;
}

// The voices the service knows: [{ id, description, created }].
async function voices() {
    const r = await request('GET', '/voices', null, HEALTH_TIMEOUT_MS * 4);
    return r.ok ? { ok: true, value: (r.value && r.value.voices) || [] } : r;
}

// Makes the voice if the service does not have it yet. description is the voice in words
// (age, sex, timbre, manner); a voice once made is kept, and replace: true designs it again.
async function ensureVoice(id, { description, replace = false } = {}) {
    if (!replace) {
        const list = await voices();
        if (list.ok && list.value.some((v) => v.id === id)) return { ok: true, created: false };
    }
    if (!description) return { ok: false, error: 'no description for voice ' + id };
    const r = await request('POST', '/voices', { id, description }, DESIGN_TIMEOUT_MS);
    return r.ok ? { ok: true, created: true } : r;
}

// Speaks text in a voice (format 'ogg', 'wav' or 'webm'). With out, the audio is written there
// and { ok, file, seconds } is returned; without it, { ok, buffer, seconds }. Text with nothing
// speakable gives
// { ok: false, error: 'empty' }.
async function speak({ text, voice, out, format = 'ogg' }) {
    const said = speakable(text);
    if (!said) return { ok: false, error: 'empty' };
    const r = await request('POST', '/speak', { text: said, voice, format }, SPEAK_TIMEOUT_MS);
    if (!r.ok) return r;
    const seconds = r.seconds || audioSeconds(r.buffer, format);
    if (!out) return { ok: true, buffer: r.buffer, seconds, text: said };
    try {
        fsx.writeAtomic(out, r.buffer);
    } catch (e) {
        return { ok: false, error: e.message };
    }
    return { ok: true, file: out, seconds, text: said };
}

// The length of an Ogg Vorbis or WAV buffer in seconds, for the voice bubble; null if unknown.
function audioSeconds(buf, format) {
    try {
        if (format === 'wav') {
            const bytesPerSec = buf.readUInt32LE(28);
            const at = buf.indexOf('data');
            return at > 0 && bytesPerSec ? Math.round((buf.readUInt32LE(at + 4) / bytesPerSec) * 10) / 10 : null;
        }
        // Vorbis: the sample rate is in the identification header, the last page's granule
        // position is the sample count.
        const id = buf.indexOf('\x01vorbis');
        const last = buf.lastIndexOf('OggS');
        if (id < 0 || last < 0) return null;
        const rate = buf.readUInt32LE(id + 12);
        const samples = Number(buf.readBigUInt64LE(last + 6));
        return rate ? Math.round((samples / rate) * 10) / 10 : null;
    } catch (e) {
        return null;
    }
}

module.exports = { DEFAULT_URL, baseUrl, speakable, available, voices, ensureVoice, speak, audioSeconds };
