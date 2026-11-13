'use strict';
// Voice input: hold a key in the game, say something, let go, and the words land in the talk
// box, or in the phone's text being written, as if typed. All on this PC: nothing that is said leaves it.
//
//   the key and the microphone   lib/voice-listen.ps1, run by Windows PowerShell: while the key is
//                                held with the game in front it records the default microphone,
//                                and hands over a WAV when the key is let go. (A program of our
//                                own was tried first: started from some folders it is not shown
//                                the keyboard's state at all; PowerShell always is.)
//   the recognition              whisper.cpp's own small server (whisper-server.exe) with a model
//                                file, both in <data>/voice (tools/setup-voice.js fetches them);
//                                started at the first key press, stopped after a while unused
//   the words                    <focus>/voice.cfg {seq, state, text, why, at, key, key_en}, which the
//                                focus box shows while a talk is open: listening | thinking | heard |
//                                error (heard carries the text; the box puts it in its input and sends it)
//                                <phone>/voice/state.cfg, the same for the phone's texts, used when
//                                no talk is open and a conversation is (the phone stamps
//                                <phone>/voice/box.cfg {at} every few seconds while one is)
//   the phone's microphone button <phone>/voice/request.cfg {seq, op: start | stop, at}, written by
//                                the phone: passed on to the listener, which records from start to
//                                stop as if the key were held; what it hears goes to the phone
//
// config.json "voice": { enabled, key, language, port, only_in_game }
//   key       the key to hold: a name below (RightAlt, CapsLock, Mouse5 ...) or a virtual-key number
//   language  what is spoken: zh, en ... or auto (told from the sound; slower to go wrong on
//             long sentences, less sure on a few words). During a lesson's English question the
//             language is always told from the sound.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fsx = require('./fsx');
const paths = require('./paths');
const { simplify } = require('./hanzi');

const ENGINE = { file: 'whisper-bin-x64.zip', url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip' };
const MODEL = { file: 'ggml-small.bin', bytes: 487601967, url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin' };
const KEYS = {
    rightalt: 0xA5, leftalt: 0xA4, rightctrl: 0xA3, rightshift: 0xA1, capslock: 0x14, tab: 0x09, '`': 0xC0,
    mouse4: 0x05, mouse5: 0x06, middlemouse: 0x04, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, v: 0x56, t: 0x54
};
const KEY_NAMES_EN = { 0xA5: 'Right Alt', 0xA4: 'Left Alt', 0xA3: 'Right Ctrl', 0xA1: 'Right Shift', 0x14: 'Caps Lock', 0x09: 'Tab', 0x05: 'Mouse 4', 0x06: 'Mouse 5', 0x04: 'Middle mouse' };
// A conversation is open on the phone when its stamp is this fresh.
const PHONE_BOX_FRESH_MS = 12000;
// How often the phone's button is looked for, and how old a press may be to count.
const REQUEST_POLL_MS = 150;
const REQUEST_FRESH_MS = 5000;
const ERRORS = { no_microphone: '没有找到麦克风', record_failed: '录音没有成功', save_failed: '录音没有成功', unclear: '没听清，再说一次', failed: '语音识别没有成功' };
const KEY_NAMES = { 0xA5: '右 Alt', 0xA4: '左 Alt', 0xA3: '右 Ctrl', 0xA1: '右 Shift', 0x14: 'CapsLock', 0x09: 'Tab', 0x05: '鼠标侧键 4', 0x06: '鼠标侧键 5', 0x04: '鼠标中键' };
const DEFAULT_PORT = 8772;
const LISTENER = path.join(__dirname, 'voice-listen.ps1');
const SERVER_START_MS = 30000;
const SERVER_IDLE_MS = 10 * 60000;
const TRANSCRIBE_MS = 45000;
// Quieter than this (root mean square of 16-bit samples) is nobody speaking.
const SILENCE_RMS = 90;
// What the model writes when it heard nothing worth writing (it was trained on subtitles).
const JUNK_RE = /^(谢谢(大家|观看|收看|你)?|感谢(观看|收看|聆听)|请不吝点赞.*|字幕.*|by\s.*|thank you( for watching)?\.?|you|\.+|。+|嗯+|啊+)$/i;
// Leaned on so that Chinese comes out simplified and with punctuation.
const ZH_PROMPT = '以下是普通话的句子，有时夹着 English。';

function voiceDir(dataDir) { return path.join(dataDir, 'voice'); }
function modelPath(dataDir) { return path.join(voiceDir(dataDir), 'models', MODEL.file); }

// whisper-server.exe wherever the archive put it under <data>/voice/engine.
function enginePath(dataDir) {
    const walk = (dir, depth) => {
        let names = [];
        try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return ''; }
        for (const n of names) if (n.isFile() && n.name.toLowerCase() === 'whisper-server.exe') return path.join(dir, n.name);
        if (depth <= 0) return '';
        for (const n of names) {
            if (!n.isDirectory()) continue;
            const hit = walk(path.join(dir, n.name), depth - 1);
            if (hit) return hit;
        }
        return '';
    };
    return walk(path.join(voiceDir(dataDir), 'engine'), 3);
}

function keyCode(key) {
    if (typeof key === 'number' && key > 0 && key < 255) return Math.floor(key);
    const k = KEYS[String(key || '').toLowerCase().replace(/[\s_-]/g, '')];
    return k || KEYS.rightalt;
}

// A WAV file as 16 kHz mono 16-bit, whatever the recorder wrote: { wav: Buffer, rms, ms }.
function normalizeWav(buf) {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
    let fmt = null;
    let data = null;
    for (let p = 12; p + 8 <= buf.length;) {
        const id = buf.toString('ascii', p, p + 4);
        const size = buf.readUInt32LE(p + 4);
        if (id === 'fmt ') fmt = { format: buf.readUInt16LE(p + 8), channels: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
        else if (id === 'data') data = buf.subarray(p + 8, Math.min(buf.length, p + 8 + size));
        p += 8 + size + (size % 2);
    }
    if (!fmt || !data || fmt.format !== 1 || (fmt.bits !== 8 && fmt.bits !== 16) || !fmt.channels || !fmt.rate) throw new Error('a WAV this cannot read');
    const step = fmt.channels * (fmt.bits / 8);
    const frames = Math.floor(data.length / step);
    const mono = new Float64Array(frames);
    for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
            const o = i * step + c * (fmt.bits / 8);
            sum += fmt.bits === 16 ? data.readInt16LE(o) : (data[o] - 128) * 256;
        }
        mono[i] = sum / fmt.channels;
    }
    const n = Math.floor(frames * 16000 / fmt.rate);
    const out = Buffer.alloc(44 + n * 2);
    let sq = 0;
    for (let i = 0; i < n; i++) {
        const x = i * fmt.rate / 16000;
        const a = Math.floor(x);
        const v = a + 1 < frames ? mono[a] + (mono[a + 1] - mono[a]) * (x - a) : mono[Math.min(a, frames - 1)] || 0;
        const s = Math.max(-32768, Math.min(32767, Math.round(v)));
        out.writeInt16LE(s, 44 + i * 2);
        sq += s * s;
    }
    out.write('RIFF', 0, 'ascii');
    out.writeUInt32LE(36 + n * 2, 4);
    out.write('WAVEfmt ', 8, 'ascii');
    out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20);
    out.writeUInt16LE(1, 22);
    out.writeUInt32LE(16000, 24);
    out.writeUInt32LE(32000, 28);
    out.writeUInt16LE(2, 32);
    out.writeUInt16LE(16, 34);
    out.write('data', 36, 'ascii');
    out.writeUInt32LE(n * 2, 40);
    return { wav: out, rms: n ? Math.sqrt(sq / n) : 0, ms: Math.round(n / 16) };
}

// What was recognised, as the line to say: one line, simplified, nothing when it is only the
// model's filler.
function cleanHeard(text) {
    const t = simplify(String(text || '').replace(/\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, ' ').replace(/\s+/g, ' ').trim());
    if (JUNK_RE.test(t)) return '';
    // Next to a Chinese character the model's half-width marks are the full-width ones.
    const marks = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' };
    return t.replace(/([一-鿿])\s*([,?!:;])\s*/g, (m, c, p) => c + marks[p]).slice(0, 200);
}

class Voice {
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.opts = { enabled: false };
        this.helper = null;
        this.server = null;
        this.serverReady = null;
        this.idleTimer = null;
        this.seq = 0;
        this.stopped = false;
    }

    configure(focusDir, dataDir, opts) {
        this.dataDir = dataDir;
        const phoneDir = path.join(path.dirname(focusDir), 'phone', 'voice');
        this.files = { focus: path.join(focusDir, 'voice.cfg'), phone: path.join(phoneDir, 'state.cfg') };
        this.phoneBoxFile = path.join(phoneDir, 'box.cfg');
        this.requestFile = path.join(phoneDir, 'request.cfg');
        this.tmpDir = path.join(voiceDir(dataDir), 'tmp');
        this.opts = Object.assign({ enabled: false, key: 'RightAlt', language: 'zh', port: DEFAULT_PORT, only_in_game: true }, opts || {});
        this.vk = keyCode(this.opts.key);
    }

    // Why voice input cannot run, or ''.
    missing() {
        if (process.platform !== 'win32' || !paths.isFile(LISTENER)) return 'voice-listen.ps1 is missing';
        if (!enginePath(this.dataDir)) return 'the recognition engine is not in ' + path.join(voiceDir(this.dataDir), 'engine') + ' (node tools/setup-voice.js)';
        if (!paths.isFile(modelPath(this.dataDir))) return 'the speech model is not at ' + modelPath(this.dataDir) + ' (node tools/setup-voice.js)';
        return '';
    }

    // where: focus | phone | all. why: an error's code (ERRORS), its words go in text.
    write(where, state, text, why) {
        for (const name of where === 'all' ? ['focus', 'phone'] : [where]) {
            const file = this.files && this.files[name];
            if (!file) continue;
            try {
                fsx.ensureDir(path.dirname(file));
                fsx.writeJson(file, {
                    seq: Date.now() * 10 + (++this.seq % 10), state, text: why ? ERRORS[why] || ERRORS.failed : text || '', why: why || '', at: Date.now(),
                    key: KEY_NAMES[this.vk] || String(this.opts.key), key_en: KEY_NAMES_EN[this.vk] || String(this.opts.key), enabled: !!this.opts.enabled
                });
            } catch (e) {
                this.log.warn('voice: state not written: ' + e.message);
            }
        }
    }

    start() {
        if (!this.opts.enabled || this.helper) return;
        const why = this.missing();
        if (why) {
            this.log.warn('voice: off, ' + why);
            return;
        }
        fsx.ensureDir(this.tmpDir);
        // The listener lives only as long as this process (its stdin closes with it).
        const h = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', LISTENER, String(this.vk), this.tmpDir, this.opts.only_in_game === false ? '' : 'inzoi'],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        this.helper = h;
        let rest = '';
        h.stdout.setEncoding('utf8');
        h.stdout.on('data', (chunk) => {
            rest += chunk;
            for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) {
                const line = rest.slice(0, i).trim();
                rest = rest.slice(i + 1);
                let ev = null;
                try { ev = JSON.parse(line); } catch (e) { ev = null; }
                if (ev) this.event(ev).catch((e) => this.log.warn('voice: ' + (e && e.message || e)));
            }
        });
        h.on('error', (e) => this.log.warn('voice: the key listener did not start: ' + e.message));
        h.on('exit', (code) => {
            if (this.helper === h) this.helper = null;
            if (!this.stopped) this.log.warn('voice: the key listener ended (' + code + ')');
        });
        // Presses of the phone's button from before this start are not acted on.
        const old = fsx.readJson(this.requestFile);
        this.requestSeq = old.ok && old.value && typeof old.value.seq === 'number' ? old.value.seq : 0;
        this.requestMtime = 0;
        this.requestTimer = setInterval(() => this.request(), REQUEST_POLL_MS);
        if (this.requestTimer.unref) this.requestTimer.unref();
        this.write('all', 'idle');
        this.log.info('voice: hold ' + (KEY_NAMES[this.vk] || this.opts.key) + ' in the game to speak (' + MODEL.file + ', language ' + this.opts.language + ')');
    }

    // The phone's microphone button: start or stop a recording.
    request() {
        if (!this.helper) return;
        let st = null;
        try { st = fs.statSync(this.requestFile); } catch (e) { return; }
        if (st.mtimeMs === this.requestMtime) return;
        this.requestMtime = st.mtimeMs;
        const r = fsx.readJson(this.requestFile);
        const q = r.ok && r.value;
        if (!q || typeof q.seq !== 'number' || q.seq <= this.requestSeq) return;
        this.requestSeq = q.seq;
        if ((q.op !== 'start' && q.op !== 'stop') || Date.now() - (q.at || 0) > REQUEST_FRESH_MS) return;
        try { this.helper.stdin.write(q.op + '\n'); } catch (e) { this.log.warn('voice: the listener did not take ' + q.op + ': ' + e.message); }
    }

    stop() {
        this.stopped = true;
        if (this.requestTimer) clearInterval(this.requestTimer);
        if (this.idleTimer) clearTimeout(this.idleTimer);
        if (this.helper) { try { this.helper.stdin.end(); this.helper.kill(); } catch (e) { /* gone */ } }
        this.stopServer();
        if (this.files && this.opts.enabled) this.write('all', 'idle');
    }

    // Where the words go: the face-to-face box when one is open, else the phone's conversation
    // when one is, else nowhere ('').
    target() {
        const f = this.d.focusTalks;
        try { if (f && f.talks().some((t) => t.open)) return 'focus'; } catch (e) { /* no talks */ }
        const r = fsx.readJson(this.phoneBoxFile);
        return r.ok && r.value && typeof r.value.at === 'number' && Date.now() - r.value.at < PHONE_BOX_FRESH_MS ? 'phone' : '';
    }

    async event(ev) {
        if (ev.e === 'down') {
            // The phone's button speaks to the phone; the key, to whatever is open.
            this.heldFor = ev.by === 'button' ? 'phone' : this.target();
            if (!this.heldFor) return;
            // The model is loaded while the player speaks.
            this.server_().catch(() => {});
            this.write(this.heldFor, 'listening');
        } else if (ev.e === 'cancel') {
            if (this.heldFor) this.write(this.heldFor, 'idle');
        } else if (ev.e === 'error') {
            this.log.warn('voice: ' + ev.what);
            if (this.heldFor) this.write(this.heldFor, 'error', '', ev.what);
        } else if (ev.e === 'up' && ev.file) {
            if (!this.heldFor) {
                fs.rm(ev.file, { force: true }, () => {});
                return;
            }
            const where = this.heldFor;
            this.write(where, 'thinking');
            const t0 = Date.now();
            try {
                const text = await this.transcribe(ev.file);
                this.log.info('voice: ' + ev.ms + ' ms heard in ' + (Date.now() - t0) + ' ms for the ' + where + ': ' + JSON.stringify(text));
                if (text) this.write(where, 'heard', text);
                else this.write(where, 'error', '', 'unclear');
            } catch (e) {
                this.log.warn('voice: not recognised: ' + e.message);
                this.write(where, 'error', '', 'failed');
            } finally {
                fs.rm(ev.file, { force: true }, () => {});
            }
        }
    }

    // A lesson's question to be answered in English: the language is told from the sound.
    language() {
        const lesson = this.d.ielts && this.d.ielts.lesson;
        if (lesson && !lesson.closed && lesson.question) return 'auto';
        return String(this.opts.language || 'zh');
    }

    async transcribe(file) {
        const { wav, rms, ms } = normalizeWav(fs.readFileSync(file));
        if (ms < 300 || rms < SILENCE_RMS) return '';
        await this.server_();
        const lang = this.language();
        const form = new FormData();
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'say.wav');
        form.append('response_format', 'json');
        form.append('temperature', '0');
        form.append('language', lang);
        if (lang === 'zh' || lang === 'auto') form.append('prompt', ZH_PROMPT);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TRANSCRIBE_MS);
        try {
            const res = await fetch('http://127.0.0.1:' + this.port() + '/inference', { method: 'POST', body: form, signal: controller.signal });
            if (!res.ok) throw new Error('the engine answered ' + res.status);
            const r = await res.json();
            return cleanHeard(r && r.text);
        } finally {
            clearTimeout(timer);
            this.idle();
        }
    }

    port() { return Number(this.opts.port) || DEFAULT_PORT; }

    idle() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.stopServer(), SERVER_IDLE_MS);
        if (this.idleTimer.unref) this.idleTimer.unref();
    }

    stopServer() {
        const s = this.server;
        this.server = null;
        this.serverReady = null;
        if (s) { try { s.kill(); } catch (e) { /* gone */ } }
    }

    // The recognition server, started when first needed: resolves once it answers.
    server_() {
        if (this.serverReady) return this.serverReady;
        const exe = enginePath(this.dataDir);
        const threads = Math.max(2, Math.min(8, require('os').cpus().length - 2));
        const s = spawn(exe, ['-m', modelPath(this.dataDir), '--host', '127.0.0.1', '--port', String(this.port()), '-t', String(threads), '-l', 'auto'],
            { cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore' });
        this.server = s;
        s.on('error', (e) => this.log.warn('voice: the engine did not start: ' + e.message));
        s.on('exit', () => { if (this.server === s) { this.server = null; this.serverReady = null; } });
        const ready = (async () => {
            const until = Date.now() + SERVER_START_MS;
            while (Date.now() < until) {
                if (this.server !== s) throw new Error('the engine ended while starting');
                try {
                    const res = await fetch('http://127.0.0.1:' + this.port() + '/', { signal: AbortSignal.timeout(1000) });
                    if (res.status < 500) return true;
                } catch (e) { /* not up yet */ }
                await new Promise((r) => setTimeout(r, 250));
            }
            throw new Error('the engine did not answer in ' + SERVER_START_MS / 1000 + ' s');
        })();
        this.serverReady = ready;
        ready.catch(() => { if (this.serverReady === ready) this.stopServer(); });
        this.idle();
        return ready;
    }
}

module.exports = { Voice, ENGINE, MODEL, voiceDir, enginePath, modelPath, keyCode, normalizeWav, cleanHeard };
