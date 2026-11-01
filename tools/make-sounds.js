#!/usr/bin/env node
'use strict';
// Synthesizes the phone's sound effects and writes them into the phone mod:
//   <phone mod>\ui\phone\sounds\<name>.webm   VP8 + Vorbis, what the game's UI engine plays
//   <phone mod>\ui\phone\sounds\<name>.ogg    Vorbis only
//   <phone mod>\ui\phone\sounds\<name>.wav    16-bit PCM
//
//   node tools/make-sounds.js               mod found under Documents\inZOI\Mods
//   node tools/make-sounds.js --out <dir>   files written to <dir>
//
// Every sound is generated here from oscillators and filtered noise, in the style of the iPhone
// (keyboard clicks, the sent swoosh, the received pop, three text tones). No recording is used,
// so the files can be shipped with the mod. The noise generator is seeded: a rebuild gives the
// same samples.
//
// ffmpeg comes from the FFMPEG environment variable (an absolute path to ffmpeg.exe) or the
// winget install; nothing runs through a shell.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const paths = require('../lib/paths');

const RATE = 48000;
const TAIL_S = 0.08;
const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, 'build', 'sounds');

function out(line) { process.stdout.write(line + '\n'); }

function fail(message) {
    process.stderr.write('make-sounds failed: ' + message + '\n');
    process.exit(1);
}

function isFile(f) {
    try { return fs.statSync(f).isFile(); } catch (e) { return false; }
}

// ------------------------------------------------------------------
// Signal building blocks
// ------------------------------------------------------------------
function buffer(seconds) { return new Float64Array(Math.ceil(seconds * RATE)); }

function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
    };
}

// RBJ cookbook biquad; the coefficients can be recomputed per sample for sweeps.
function Biquad() {
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
}
Biquad.prototype.set = function (type, freq, q) {
    const w = 2 * Math.PI * Math.min(freq, RATE * 0.45) / RATE;
    const cs = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (type === 'bandpass') { b0 = alpha; b1 = 0; b2 = -alpha; }
    else if (type === 'lowpass') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
    else if (type === 'highpass') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
    else throw new Error('unknown filter ' + type);
    const a0 = 1 + alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = (-2 * cs) / a0; this.a2 = (1 - alpha) / a0;
    return this;
};
Biquad.prototype.run = function (x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
};

// Exponentially decaying sine whose pitch glides from f0 to f1 with time constant glide.
function addTone(buf, start, f0, f1, glide, amp, attack, decay, length) {
    const s0 = Math.round(start * RATE);
    const n = Math.min(buf.length - s0, Math.round(length * RATE));
    let phase = 0;
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const f = f1 + (f0 - f1) * Math.exp(-t / glide);
        phase += 2 * Math.PI * f / RATE;
        const env = (attack > 0 ? 1 - Math.exp(-t / attack) : 1) * Math.exp(-t / decay);
        buf[s0 + i] += amp * env * Math.sin(phase);
    }
}

// Struck-bar or bell note from inharmonic partials: [ratio, amplitude, decay seconds].
function addBell(buf, start, freq, amp, partials, attack, length) {
    for (const p of partials) addTone(buf, start, freq * p[0], freq * p[0], 1, amp * p[1], attack, p[2], length);
}

function addNoise(buf, start, length, amp, seed, shape, filterAt) {
    const s0 = Math.round(start * RATE);
    const n = Math.min(buf.length - s0, Math.round(length * RATE));
    const noise = rng(seed);
    const f = new Biquad();
    const f2 = new Biquad();
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const spec = filterAt(t);
        f.set(spec.type, spec.freq, spec.q);
        let y = f.run(noise());
        if (spec.twice) { f2.set(spec.type, spec.freq, spec.q); y = f2.run(y); }
        buf[s0 + i] += amp * shape(t) * y;
    }
}

function finish(buf, peak) {
    const hp = new Biquad().set('highpass', 35, 0.707);
    for (let i = 0; i < buf.length; i++) buf[i] = hp.run(buf[i]);
    const fadeIn = Math.round(0.0008 * RATE);
    const fadeOut = Math.round(0.006 * RATE);
    for (let i = 0; i < fadeIn && i < buf.length; i++) buf[i] *= i / fadeIn;
    for (let i = 0; i < fadeOut && i < buf.length; i++) buf[buf.length - 1 - i] *= i / fadeOut;
    let max = 0;
    for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
    if (peak > 0 && max > 0) for (let i = 0; i < buf.length; i++) buf[i] *= peak / max;
    const padded = new Float64Array(buf.length + Math.round(TAIL_S * RATE));
    padded.set(buf);
    return padded;
}

// ------------------------------------------------------------------
// The sounds. Peaks set their loudness relative to each other; the phone scales them all
// by the volume setting.
// ------------------------------------------------------------------
function click(body, wood, air, seed, bodyDecay, woodDecay, peak) {
    const b = buffer(0.05);
    addNoise(b, 0, 0.006, 1.0, seed, (t) => Math.exp(-t / 0.0011), () => ({ type: 'bandpass', freq: air, q: 1.1 }));
    addTone(b, 0, body * 1.12, body, 0.002, 0.55, 0.0002, bodyDecay, 0.05);
    addTone(b, 0, wood * 1.2, wood, 0.003, 0.45, 0.0003, woodDecay, 0.05);
    return finish(b, peak);
}

function sent() {
    const len = 0.4;
    const b = buffer(len);
    const shape = (t) => {
        if (t < 0.13) return Math.pow(Math.sin((t / 0.13) * Math.PI / 2), 2);
        return Math.max(0, Math.pow(Math.cos(((t - 0.13) / (len - 0.13)) * Math.PI / 2), 1.6));
    };
    addNoise(b, 0, len, 1.0, 7, shape, (t) => ({ type: 'bandpass', freq: 520 * Math.pow(5200 / 520, Math.min(1, t / 0.3)), q: 1.7, twice: true }));
    addNoise(b, 0, len, 0.25, 11, shape, () => ({ type: 'highpass', freq: 5500, q: 0.7 }));
    const s = buffer(len);
    addTone(s, 0.02, 420, 1250, 0.09, 0.06, 0.04, 0.12, 0.3);
    for (let i = 0; i < b.length; i++) b[i] += s[i];
    return finish(b, 0.62);
}

function received() {
    const b = buffer(0.32);
    addTone(b, 0, 760, 1040, 0.018, 0.9, 0.0015, 0.045, 0.2);
    addTone(b, 0, 1520, 2080, 0.018, 0.12, 0.0015, 0.025, 0.2);
    addTone(b, 0.085, 1390, 1390, 1, 0.75, 0.0015, 0.06, 0.24);
    addTone(b, 0.085, 2780, 2780, 1, 0.08, 0.0015, 0.03, 0.24);
    return finish(b, 0.58);
}

const BELL = [[1, 1, 0.42], [2.0, 0.32, 0.22], [3.0, 0.12, 0.12], [4.17, 0.06, 0.07]];
const MARIMBA = [[1, 1, 0.22], [3.93, 0.22, 0.05], [9.2, 0.05, 0.015]];
const GLASS = [[1, 1, 0.9], [2.32, 0.28, 0.42], [4.25, 0.12, 0.2], [6.63, 0.05, 0.1]];

function triTone() {
    const b = buffer(1.15);
    addBell(b, 0.0, 987.77, 0.8, BELL, 0.002, 0.9);
    addBell(b, 0.13, 1318.51, 0.8, BELL, 0.002, 0.9);
    addBell(b, 0.26, 1661.22, 0.9, BELL.map((p) => [p[0], p[1], p[2] * 1.5]), 0.002, 0.88);
    return finish(b, 0.8);
}

function noteTone() {
    const b = buffer(0.8);
    addBell(b, 0.0, 1567.98, 0.85, MARIMBA, 0.0015, 0.6);
    addBell(b, 0.095, 2093.0, 0.95, MARIMBA.map((p) => [p[0], p[1], p[2] * 1.6]), 0.0015, 0.7);
    return finish(b, 0.8);
}

function chimeTone() {
    const b = buffer(1.5);
    addBell(b, 0, 1046.5, 0.7, GLASS, 0.003, 1.5);
    addBell(b, 0, 1049.1, 0.3, GLASS, 0.003, 1.5);
    addBell(b, 0.004, 2093.0 * 1.003, 0.12, [[1, 1, 0.3]], 0.002, 0.8);
    return finish(b, 0.78);
}

// Audible on purpose: the playback check uses this file, and a silent clip cannot show
// whether the game actually produced sound. The video track is padded to 0.8s so the
// player has more than one frame to decode.
function prime() {
    const b = buffer(0.55);
    addTone(b, 0.02, 988, 1319, 0.1, 0.4, 0.006, 0.1, 0.4);
    return finish(b, 0.45);
}

const SOUNDS = {
    tap: () => click(1500, 520, 3200, 3, 0.006, 0.009, 0.5),
    key: () => click(1850, 700, 4200, 5, 0.005, 0.007, 0.42),
    'key-delete': () => click(1250, 430, 2600, 9, 0.006, 0.01, 0.46),
    'key-modifier': () => click(950, 300, 2000, 13, 0.008, 0.012, 0.48),
    sent: sent,
    received: received,
    'tone-tritone': triTone,
    'tone-note': noteTone,
    'tone-chime': chimeTone,
    prime: prime
};

// ------------------------------------------------------------------
// Files
// ------------------------------------------------------------------
function wav(samples) {
    const data = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        data.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
}

function ffmpegPath() {
    const env = process.env.FFMPEG;
    if (env) {
        if (!path.isAbsolute(env) || path.basename(env).toLowerCase() !== 'ffmpeg.exe' || !isFile(env)) {
            fail('FFMPEG must be the absolute path of an existing ffmpeg.exe');
        }
        return env;
    }
    const local = process.env.LOCALAPPDATA || '';
    const link = path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
    if (isFile(link)) return link;
    const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
        for (const d of fs.readdirSync(pkgs).filter((n) => /^Gyan\.FFmpeg/i.test(n)).sort()) {
            for (const sub of fs.readdirSync(path.join(pkgs, d))) {
                const exe = path.join(pkgs, d, sub, 'bin', 'ffmpeg.exe');
                if (isFile(exe)) return exe;
            }
        }
    } catch (e) { /* no winget packages */ }
    fail('ffmpeg was not found; install it (winget install Gyan.FFmpeg) or set FFMPEG to ffmpeg.exe');
    return '';
}

function ffmpeg(exe, args) {
    try {
        execFileSync(exe, ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { stdio: 'inherit', windowsHide: true });
    } catch (e) {
        fail('ffmpeg exited with ' + (e.status === undefined ? e.message : e.status));
    }
}

function args() {
    const a = process.argv.slice(2);
    const o = { out: '' };
    for (let i = 0; i < a.length; i++) {
        if (a[i] === '--out' && a[i + 1]) o.out = path.resolve(a[++i]);
        else fail('unknown argument ' + a[i] + ' (use --out <dir>)');
    }
    return o;
}

function main() {
    if (process.platform !== 'win32') fail('run this on Windows');
    const o = args();
    let dest = o.out;
    if (!dest) {
        const mod = paths.findMod(paths.PHONE_MOD_ID);
        if (!mod) fail('the phone mod ' + paths.PHONE_MOD_ID + ' was not found under Documents\\inZOI\\Mods; use --out <dir>');
        dest = path.join(mod, 'ui', 'phone', 'sounds');
    }
    const exe = ffmpegPath();
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const name of Object.keys(SOUNDS)) {
        const samples = SOUNDS[name]();
        const src = path.join(WORK, name + '.wav');
        fs.writeFileSync(src, wav(samples));
        const seconds = samples.length / RATE;
        // The game's interface plays WebM only, and only with a VP8 picture plus Vorbis.
        // One channel and a clip shorter than a few frames both stall that player, so the
        // picture is stereo-paired and at least 0.8s, with a keyframe on every frame.
        const picture = Math.max(seconds, 0.8);
        ffmpeg(exe, ['-i', src, '-c:a', 'libvorbis', '-q:a', '6', '-ac', '1', '-ar', String(RATE), path.join(WORK, name + '.ogg')]);
        ffmpeg(exe, [
            '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=15:d=' + picture.toFixed(3),
            '-i', src, '-map', '0:v', '-map', '1:a',
            '-c:v', 'libvpx', '-b:v', '32k', '-pix_fmt', 'yuv420p', '-auto-alt-ref', '0', '-g', '15',
            '-c:a', 'libvorbis', '-b:a', '96k', '-ac', '2', '-ar', String(RATE),
            path.join(WORK, name + '.webm')
        ]);
        for (const ext of ['webm', 'ogg', 'wav']) {
            const file = path.join(WORK, name + '.' + ext);
            if (!isFile(file) || fs.statSync(file).size === 0) fail(name + '.' + ext + ' was not written');
            fs.copyFileSync(file, path.join(dest, name + '.' + ext));
        }
        out(name + ': ' + Math.round(seconds * 1000) + ' ms');
    }
    const sums = Object.keys(SOUNDS).map((n) => ['webm', 'ogg', 'wav'].map((ext) => {
        const f = path.join(dest, n + '.' + ext);
        return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16) + '  ' + n + '.' + ext;
    }).join('\n')).join('\n');
    out('written to ' + dest);
    out(sums);
}

main();
