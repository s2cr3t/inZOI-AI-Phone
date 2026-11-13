#!/usr/bin/env node
'use strict';
// Fetches what voice input (lib/voice.js) needs into <data>/voice, once:
//   engine\   whisper.cpp for Windows x64, CPU build (its official release on GitHub)
//   models\ggml-small.bin   the speech model (the whisper.cpp model repository on Hugging Face)
//   node tools/setup-voice.js          fetch what is missing
//   node tools/setup-voice.js --check  only say what is there
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../lib/config');
const { ENGINE, MODEL, voiceDir, enginePath, modelPath } = require('../lib/voice');

async function fetchTo(url, file, expectBytes) {
    const tmp = file + '.part';
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(url + ': HTTP ' + res.status);
    const total = Number(res.headers.get('content-length')) || expectBytes || 0;
    const out = fs.createWriteStream(tmp);
    let got = 0;
    let shown = 0;
    for await (const chunk of res.body) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (total && got - shown > total / 10) { shown = got; console.log('  ' + Math.round(got / total * 100) + '%'); }
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    if (expectBytes && got !== expectBytes) throw new Error(path.basename(file) + ': got ' + got + ' bytes, expected ' + expectBytes);
    fs.renameSync(tmp, file);
}

(async () => {
    const dir = voiceDir(config.DATA_DIR);
    const exe = enginePath(config.DATA_DIR);
    const model = modelPath(config.DATA_DIR);
    if (process.argv[2] === '--check') {
        console.log('engine: ' + (exe ? exe : 'missing') + '\nmodel:  ' + (fs.existsSync(model) ? model : 'missing'));
        return;
    }
    fs.mkdirSync(path.join(dir, 'engine'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    if (!exe) {
        const zip = path.join(dir, ENGINE.file);
        console.log('engine: ' + ENGINE.url);
        await fetchTo(ENGINE.url, zip, 0);
        // Windows' own tar reads zip archives (by its full path: another tar may come first on the PATH).
        execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', path.join(dir, 'engine')], { stdio: 'inherit' });
        fs.rmSync(zip, { force: true });
        if (!enginePath(config.DATA_DIR)) throw new Error('the archive held no whisper-server.exe');
    }
    if (!fs.existsSync(model)) {
        console.log('model: ' + MODEL.url);
        await fetchTo(MODEL.url, model, MODEL.bytes);
    }
    console.log('voice input is ready: ' + enginePath(config.DATA_DIR) + ', ' + model);
})().catch((e) => { console.error(e.message); process.exit(1); });
