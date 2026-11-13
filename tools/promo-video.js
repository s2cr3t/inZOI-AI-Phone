#!/usr/bin/env node
'use strict';
// A promotional video of the life-stage booklets, made from the mod itself: every style of the
// stage overlay played in the phone preview (tools/phone-preview.js must be running) by a hidden
// Edge, recorded frame by frame, then cut with the stage's own song by ffmpeg.
//   node tools/promo-video.js record [stage ...]   record the segments into promo/work
//   node tools/promo-video.js cut                  cut promo/work into promo/booklets-promo.mp4
// The booklets are the 袁 household's (data/booklet-presets.json), shown for 亚廷 as she grows.
// PREVIEW_URL (default http://localhost:8792/), FFMPEG (default ffmpeg on the PATH).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Booklet, SONGS, STAGE_SONG } = require('../lib/booklet');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'promo');
const WORK = path.join(OUT, 'work');
const URL = process.env.PREVIEW_URL || 'http://localhost:8792/';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FONT = 'C:\\Windows\\Fonts\\msyh.ttc';
const PORT = 9343;
const W = 1920;
const H = 1080;
const FPS = 30;
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
    .find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The segments in order: whose booklet, the stage it ends, the style it is drawn in, how many
// pages are turned, and the caption.
const GIRL = { id: '20526', first: '亚廷', last: '钟', gender: 'Female' };
// The parents, so the pages about the people close to her find them.
const PARENTS = [
    { entity_id: 20522, first_name: '桐济', last_name: '袁', gender: 'Male', age_group: 'Adult' },
    { entity_id: 20524, first_name: '卡特琳', last_name: '埃斯特拉达', gender: 'Female', age_group: 'Adult' }
];
const SEGMENTS = [
    { stage: 'Infant', next: 'Toddler', theme: 'baby', turns: 3, label: '婴儿 → 幼儿' },
    { stage: 'Toddler', next: 'Child', theme: 'crayon', turns: 3, label: '幼儿 → 儿童' },
    { stage: 'Child', next: 'LowTeen', theme: 'child', turns: 3, label: '儿童 → 少年' },
    { stage: 'HighTeen', next: 'Youth', theme: 'teen', turns: 3, label: '青少年 → 青年' },
    { stage: 'Youth', next: 'Adult', theme: 'travel', turns: 3, label: '青年 → 成年' },
    { stage: 'Adult', next: 'Old', theme: 'adult', turns: 3, label: '成年 → 中年' },
    { stage: 'Old', next: 'Elderly', theme: 'elder', turns: 6, label: '中年 → 老年' }
];
const OPEN_MS = { baby: 3200, crayon: 2600, child: 2800, teen: 2600, travel: 3000, adult: 2800, elder: 3600 };
const TURN_MS = { baby: 2800, crayon: 2600, child: 2800, teen: 2700, travel: 2800, adult: 2600, elder: 3200 };

function book(seg) {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'booklet-presets.json'), 'utf8'));
    const pr = r.people[GIRL.id][seg.stage];
    if (!pr) throw new Error('no preset for ' + seg.stage);
    const b = new Booklet({ log: console }).fromPreset({ id: GIRL.id, kind: 'stage', stage: seg.stage, next: seg.next, from: 1000, to: 1010 }, pr);
    b.writtenAt = Date.now();
    return b;
}

// ------------------------------------------------------------ the browser
async function cdpTarget() {
    for (let i = 0; i < 40; i++) {
        try {
            const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
            const page = list.find((t) => t.type === 'page');
            if (page) return page.webSocketDebuggerUrl;
        } catch (e) { /* not up yet */ }
        await sleep(250);
    }
    throw new Error('Edge did not start');
}

function session(wsUrl) {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    const handlers = new Map();
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && waiting.has(msg.id)) {
            const w = waiting.get(msg.id);
            waiting.delete(msg.id);
            if (msg.error) w.reject(new Error(msg.error.message));
            else w.resolve(msg.result);
        } else if (msg.method && handlers.has(msg.method)) {
            handlers.get(msg.method)(msg.params);
        }
    };
    const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    return {
        ready,
        on(method, fn) { handlers.set(method, fn); },
        send(method, params) {
            return new Promise((resolve, reject) => {
                const n = ++id;
                waiting.set(n, { resolve, reject });
                ws.send(JSON.stringify({ id: n, method, params: params || {} }));
            });
        },
        close() { ws.close(); }
    };
}

// The game's answers the overlay needs, given in the page: the household, the booklet board, an
// empty seen list; pause/resume and saves are swallowed.
function inject(b, seg) {
    const member = { entity_id: Number(GIRL.id), first_name: GIRL.first, last_name: GIRL.last, gender: GIRL.gender, age_group: seg.next };
    const board = { v: 1, at: Date.now(), people: { [GIRL.id]: { name: GIRL.last + GIRL.first, stage: seg.next, books: [b] } } };
    const members = [member].concat(PARENTS);
    return `(function () {
  var board = ${JSON.stringify(board)};
  var members = ${JSON.stringify(members)};
  var css = document.createElement('style');
  css.textContent = 'video { opacity: 0 !important; }';
  document.head.appendChild(css);
  var real = inzoi.cli.execute.bind(inzoi.cli);
  inzoi.cli.execute = function (cmd, params) {
    if (cmd === 'environment.pause' || cmd === 'environment.resume' || cmd === 'uimod.cfg_save') return Promise.resolve({ success: true, data: {} });
    if (cmd === 'household.get_members') return Promise.resolve({ success: true, data: { members: members } });
    if (cmd === 'uimod.cfg_load' && params && params.key === 'board' && /booklet/.test(params.section)) return Promise.resolve({ value: JSON.stringify(board) });
    if (cmd === 'uimod.cfg_load' && params && params.key === 'booklet-seen') return Promise.resolve({ value: '' });
    return real(cmd, params);
  };
  var root = document.getElementById('app-root');
  if (root) root.style.visibility = 'hidden';
  document.body.style.visibility = 'visible';
  document.body.style.background = 'radial-gradient(ellipse at 50% 45%, #3a3040 0%, #1a1620 60%, #0d0b10 100%)';
  return 'ready';
})()`;
}

async function recordSegment(s, seg, n) {
    const dir = path.join(WORK, String(n).padStart(2, '0') + '-' + seg.theme);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const b = book(seg);
    await s.send('Page.navigate', { url: URL });
    await sleep(3500);
    const frames = [];
    let k = 0;
    s.on('Page.screencastFrame', (p) => {
        const file = 'f' + String(k++).padStart(5, '0') + '.jpg';
        fs.writeFileSync(path.join(dir, file), Buffer.from(p.data, 'base64'));
        frames.push({ file, t: p.metadata.timestamp });
        s.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    });
    await s.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    await s.send('Runtime.evaluate', { expression: inject(b, seg) });
    const wait = await s.send('Runtime.evaluate', {
        expression: `(async function () { for (var i = 0; i < 600 && !document.querySelector('.bk-th-${seg.theme}'); i++) await new Promise(function (r) { setTimeout(r, 20); }); return document.querySelector('.bk-th-${seg.theme}') ? Date.now() / 1000 : 0; })()`,
        awaitPromise: true, returnByValue: true
    });
    const openAt = wait.result && wait.result.value;
    if (!openAt) throw new Error(seg.theme + ': the overlay did not open');
    await sleep(OPEN_MS[seg.theme]);
    for (let i = 0; i < seg.turns; i++) {
        await s.send('Runtime.evaluate', { expression: "document.querySelectorAll('.bk-stage-turn')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))" });
        await sleep(TURN_MS[seg.theme]);
    }
    await sleep(600);
    const endAt = (await s.send('Runtime.evaluate', { expression: 'Date.now() / 1000', returnByValue: true })).result.value;
    await s.send('Page.stopScreencast');
    await sleep(300);
    s.on('Page.screencastFrame', () => {});
    fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({ seg, openAt, endAt, frames }, null, 1));
    console.log(seg.theme + ': ' + frames.length + ' frames, ' + (endAt - openAt).toFixed(1) + 's');
}

async function record(only) {
    if (!EDGE) throw new Error('Edge not found');
    fs.mkdirSync(WORK, { recursive: true });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-'));
    const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--hide-scrollbars',
        '--autoplay-policy=no-user-gesture-required', '--window-size=' + (W + 20) + ',' + (H + 20), 'about:blank'], { stdio: 'ignore' });
    try {
        const s = session(await cdpTarget());
        await s.ready;
        await s.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await s.send('Page.enable');
        for (let i = 0; i < SEGMENTS.length; i++) {
            if (only.length && only.indexOf(SEGMENTS[i].theme) < 0) continue;
            await recordSegment(s, SEGMENTS[i], i + 1);
        }
        s.close();
    } finally {
        edge.kill();
        await sleep(500);
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Edge may still hold it */ }
    }
}

// ------------------------------------------------------------ the cut
function ff(args, cwd) {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
}

function songFile(title) {
    const f = path.join(ROOT, 'music', title + '.mp3');
    if (!fs.existsSync(f)) throw new Error('song not found: ' + f);
    return f;
}

// The loudest stretch of a song (its chorus, mostly) as long as wanted, from the song's
// per-second loudness.
function chorusAt(file, len) {
    const r = require('child_process').spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-af',
        'aresample=8000,asetnsamples=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level', '-f', 'null', '-'], { encoding: 'utf8' });
    const rms = [];
    const re = /RMS_level=(-?[\d.]+|-inf)/g;
    let m;
    while ((m = re.exec(r.stderr))) rms.push(m[1] === '-inf' ? -90 : Number(m[1]));
    const n = Math.ceil(len);
    if (rms.length < n + 10) return 0;
    let best = 0;
    let bestSum = -Infinity;
    for (let i = 5; i + n < rms.length * 0.85; i++) {
        let sum = 0;
        for (let j = i; j < i + n; j++) sum += rms[j];
        if (sum > bestSum) { bestSum = sum; best = i; }
    }
    return best;
}

function textFile(dir, name, text) {
    fs.writeFileSync(path.join(dir, name), text, 'utf8');
    return name;
}

function cutSegment(dir) {
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
    const start = info.openAt - 0.25;
    const frames = info.frames.filter((f) => f.t >= start - 0.2 && f.t <= info.endAt);
    if (!frames.length) throw new Error(dir + ': no frames');
    const lines = [];
    for (let i = 0; i < frames.length; i++) {
        const t0 = Math.max(frames[i].t, start);
        const t1 = i + 1 < frames.length ? frames[i + 1].t : info.endAt;
        lines.push("file '" + frames[i].file + "'", 'duration ' + Math.max(0.001, t1 - t0).toFixed(4));
    }
    lines.push("file '" + frames[frames.length - 1].file + "'");
    fs.writeFileSync(path.join(dir, 'list.txt'), lines.join('\n') + '\n');
    const len = info.endAt - start;
    const song = SONGS[STAGE_SONG[info.seg.stage]];
    const file = songFile(song.title);
    const at = chorusAt(file, len);
    fs.copyFileSync(FONT, path.join(dir, 'font.ttc'));
    textFile(dir, 'label.txt', info.seg.label);
    const vf = [
        "drawtext=fontfile=font.ttc:textfile=label.txt:x=64:y=52:fontsize=34:fontcolor=white@0.85:shadowcolor=black@0.6:shadowx=2:shadowy=2",
        'fade=t=in:st=0:d=0.4',
        'fade=t=out:st=' + (len - 0.6).toFixed(2) + ':d=0.6',
        'format=yuv420p'
    ].join(',');
    const af = 'afade=t=in:st=0:d=0.8,afade=t=out:st=' + (len - 1.2).toFixed(2) + ':d=1.2';
    ff(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-ss', String(at), '-t', len.toFixed(3), '-i', file,
        '-vf', vf, '-af', af, '-r', String(FPS), '-fps_mode', 'cfr', '-t', len.toFixed(3),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', 'seg.mp4'], dir);
    console.log(path.basename(dir) + ': ' + len.toFixed(1) + 's, ' + song.title + ' from ' + at + 's');
    return path.join(dir, 'seg.mp4');
}

// A card of text on the overlay's backdrop, with a song under it.
function card(name, lines, song, from, len) {
    const dir = path.join(WORK, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(FONT, path.join(dir, 'font.ttc'));
    const sizes = [64, 30, 24];
    const ys = ['h/2-90', 'h/2+10', 'h/2+70'];
    const draws = lines.map((t, i) => 'drawtext=fontfile=font.ttc:textfile=' + textFile(dir, 'l' + i + '.txt', t) +
        ':x=(w-text_w)/2:y=' + ys[i] + ':fontsize=' + sizes[i] + ':fontcolor=' + (i === 0 ? '#f4e6c8' : 'white@0.75') +
        ":alpha='min(1,max(0,(t-" + (0.3 + i * 0.5) + ')/0.8))\'');
    const vf = ['geq=r=\'26+30*exp(-((X-960)^2+(Y-480)^2)/300000)\':g=\'22+26*exp(-((X-960)^2+(Y-480)^2)/300000)\':b=\'32+32*exp(-((X-960)^2+(Y-480)^2)/300000)\'']
        .concat(draws, ['fade=t=in:st=0:d=0.5', 'fade=t=out:st=' + (len - 0.8) + ':d=0.8', 'format=yuv420p']).join(',');
    const af = 'afade=t=in:st=0:d=1,afade=t=out:st=' + (len - 1.5) + ':d=1.5';
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=' + W + 'x' + H + ':r=' + FPS + ':d=' + len, '-ss', String(from), '-t', String(len), '-i', songFile(song),
        '-vf', vf, '-af', af, '-t', String(len), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', 'seg.mp4'], dir);
    return path.join(dir, 'seg.mp4');
}

function cut() {
    const segs = fs.readdirSync(WORK).filter((d) => /^\d\d-/.test(d) && fs.existsSync(path.join(WORK, d, 'frames.json'))).sort();
    if (!segs.length) throw new Error('nothing recorded: run record first');
    const parts = [card('00-title', ['每一个人生阶段，都有一本成长册', 'inZOI AI Phone · 成长册', '长大的那一刻，它会自己翻开'], '第一次睁眼', 0, 5)];
    for (const d of segs) parts.push(cutSegment(path.join(WORK, d)));
    parts.push(card('99-end', ['一棵树、一首歌、一辈子', '每一个阶段，都值得被记住', 'inZOI AI Phone · 免费 MOD'], '谢谢你曾来过我的生命', 60, 6));
    fs.writeFileSync(path.join(WORK, 'parts.txt'), parts.map((p) => "file '" + p.replace(/\\/g, '/') + "'").join('\n') + '\n');
    const out = path.join(OUT, 'booklets-promo.mp4');
    ff(['-f', 'concat', '-safe', '0', '-i', 'parts.txt', '-c', 'copy', '-movflags', '+faststart', out], WORK);
    console.log('saved ' + out);
}

const [cmd, ...rest] = process.argv.slice(2);
(cmd === 'record' ? record(rest) : cmd === 'cut' ? Promise.resolve(cut()) : Promise.reject(new Error('usage: node tools/promo-video.js record [theme ...] | cut')))
    .catch((e) => { console.error(e.message); process.exit(1); });
