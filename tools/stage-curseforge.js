'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'mods');
const OUT = path.join(ROOT, 'build', 'curseforge');
const VERSION = readVersion();
const REPO = 'https://github.com/s2cr3t/inZOI-AI-Phone';

const MODS = {
    HouseholdBoard_I6IXIO: {
        FriendlyName: 'inZOI AI Phone',
        Description: 'A smartphone for your Zois: family and friends text back with AI. Needs AI Phone Service: ' + REPO + '/releases/latest'
    },
    HouseholdJournal_N4CZ4Z: {
        FriendlyName: 'inZOI AI Phone - Game Link',
        Description: 'Game-side helper for inZOI AI Phone: lets the phone read the household and carry out what Zois agree to in chat.'
    },
    RoomLights_N4CZ4Z: {
        FriendlyName: 'Room Lights',
        Description: 'Lights turn on in rooms where someone is home and turn off in empty rooms.'
    }
};

function readVersion() {
    const text = fs.readFileSync(path.join(ROOT, 'lib', 'daemon.js'), 'utf8');
    const m = /VERSION\s*=\s*'([^']+)'/.exec(text);
    if (!m) throw new Error('VERSION not found in lib/daemon.js');
    return m[1];
}

function versionNumber(name) {
    const p = name.split('.').map(Number);
    return p[0] * 10000 + p[1] * 100 + p[2];
}

function stage(id, meta) {
    const from = path.join(SOURCE, id);
    const to = path.join(OUT, id);
    if (!fs.existsSync(from)) throw new Error('missing mod folder: ' + from);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });

    const plugin = fs.readdirSync(to).filter((f) => f.endsWith('.uplugin'));
    if (plugin.length !== 1) throw new Error(id + ': expected one .uplugin, found ' + plugin.length);
    const file = path.join(to, plugin[0]);
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    Object.assign(data, meta, {
        Version: versionNumber(VERSION),
        VersionName: VERSION,
        CreatedBy: 's2cr3t',
        CreatedByURL: 'https://github.com/s2cr3t',
        DocsURL: REPO + '#readme',
        SupportURL: REPO + '/issues'
    });
    fs.writeFileSync(file, JSON.stringify(data, null, '\t') + '\n', 'utf8');

    let files = 0;
    let bytes = 0;
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else { files++; bytes += fs.statSync(p).size; }
        }
    })(to);
    console.log(id + '  ' + VERSION + '  files=' + files + '  KB=' + Math.round(bytes / 1024) + '  ' + to);
}

fs.mkdirSync(OUT, { recursive: true });
for (const id of Object.keys(MODS)) stage(id, MODS[id]);
