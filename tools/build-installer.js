#!/usr/bin/env node
'use strict';
// Builds the inZOI AI Phone setup:
//   1. the icon (tools/make-icon.js)
//   2. inZOIPhone.exe from native/PhoneHelper.cs with the .NET Framework compiler in Windows
//   3. a staging folder: the helper, runtime\node.exe (the Node.js running this script),
//      Node's license, and app\ with only the files the service needs
//   4. the two game mods' program files (tools/modfiles.js), which the setup copies over the
//      installed mods: build\stage-mods\<modId> always replaced, build\stage-seeds\<modId> only
//      created when missing
//   5. the setup with Inno Setup 6 (ISCC.exe)
//
//   node tools/build-installer.js                 -> build\dist\inZOI-AI-Phone-Setup-<version>.exe
//   node tools/build-installer.js --mods <dir>    mods taken from <dir>\<modId>, not Documents\inZOI\Mods
//   node tools/build-installer.js --helper        -> only steps 1 and 2, for the development copy
//
// Every program is taken from a fixed location; nothing runs through a shell.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const modfiles = require('./modfiles');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const STAGE = path.join(BUILD, 'stage');
const STAGE_MODS = path.join(BUILD, 'stage-mods');
const STAGE_SEEDS = path.join(BUILD, 'stage-seeds');
const DIST = path.join(BUILD, 'dist');
const ICON = path.join(BUILD, 'app.ico');
const HELPER_OUT = path.join(ROOT, 'bin', 'inZOIPhone.exe');
const LICENSE_CACHE = path.join(ROOT, 'installer', 'third-party');

const APP_FILES = ['bridge.js', 'supervisor.js'];
const APP_DIRS = [
    { dir: 'lib', test: (n) => /\.js$/.test(n) || n === 'voice-listen.ps1' },
    { dir: 'assets', test: (n) => n === 'buff-catalog.json' }
];

function out(line) { process.stdout.write(line + '\n'); }

function fail(message) {
    process.stderr.write('build failed: ' + message + '\n');
    process.exit(1);
}

function isFile(f) {
    try { return fs.statSync(f).isFile(); } catch (e) { return false; }
}

function version() {
    const text = fs.readFileSync(path.join(ROOT, 'lib', 'daemon.js'), 'utf8');
    const m = /const VERSION = '(\d+\.\d+\.\d+)';/.exec(text);
    if (!m) fail('VERSION not found in lib/daemon.js');
    return m[1];
}

function run(file, args, label) {
    try {
        execFileSync(file, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    } catch (e) {
        fail(label + ' exited with ' + (e.status === undefined ? e.message : e.status));
    }
}

function compiler() {
    const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
    const csc = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    if (!isFile(csc)) fail('the .NET Framework 4 compiler was not found at ' + csc);
    return csc;
}

function innoCompiler() {
    const candidates = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe')
    ];
    const hit = candidates.find(isFile);
    if (!hit) fail('Inno Setup 6 is not installed (looked in ' + candidates.join(', ') + ')');
    return hit;
}

function buildHelper(ver) {
    const info = path.join(BUILD, 'AssemblyInfo.cs');
    fs.writeFileSync(info, [
        'using System.Reflection;',
        '[assembly: AssemblyTitle("inZOI AI Phone")]',
        '[assembly: AssemblyProduct("inZOI AI Phone")]',
        '[assembly: AssemblyDescription("Background service for the inZOI AI phone mod")]',
        '[assembly: AssemblyVersion("' + ver + '.0")]',
        '[assembly: AssemblyFileVersion("' + ver + '.0")]',
        '[assembly: AssemblyInformationalVersion("' + ver + '")]',
        ''
    ].join('\r\n'), 'utf8');
    fs.mkdirSync(path.dirname(HELPER_OUT), { recursive: true });
    const tmp = HELPER_OUT + '.new';
    run(compiler(), [
        '/nologo', '/target:winexe', '/optimize+', '/codepage:65001',
        '/win32icon:' + ICON, '/out:' + tmp,
        '/r:System.Security.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
        info, path.join(ROOT, 'native', 'PhoneHelper.cs')
    ], 'csc');
    fs.renameSync(tmp, HELPER_OUT);
    out('helper: ' + HELPER_OUT);
}

async function nodeLicense() {
    const ver = process.versions.node;
    const file = path.join(LICENSE_CACHE, 'node-v' + ver + '-LICENSE.txt');
    if (isFile(file)) return file;
    const url = 'https://raw.githubusercontent.com/nodejs/node/v' + ver + '/LICENSE';
    out('downloading the Node.js ' + ver + ' license from ' + url);
    const res = await fetch(url);
    if (!res.ok) fail('Node.js license download failed: HTTP ' + res.status);
    const text = await res.text();
    if (text.indexOf('Node.js is licensed') < 0) fail('the downloaded Node.js license does not look right');
    fs.mkdirSync(LICENSE_CACHE, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    return file;
}

function copy(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

async function stage() {
    fs.rmSync(STAGE, { recursive: true, force: true });
    fs.mkdirSync(STAGE, { recursive: true });
    copy(HELPER_OUT, path.join(STAGE, 'inZOIPhone.exe'));
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 18) fail('build with Node.js 18 or newer; it is bundled as the runtime');
    copy(process.execPath, path.join(STAGE, 'runtime', 'node.exe'));
    copy(await nodeLicense(), path.join(STAGE, 'runtime', 'LICENSE.txt'));
    for (const f of APP_FILES) copy(path.join(ROOT, f), path.join(STAGE, 'app', f));
    for (const d of APP_DIRS) {
        const src = path.join(ROOT, d.dir);
        for (const name of fs.readdirSync(src)) {
            if (d.test(name) && isFile(path.join(src, name))) copy(path.join(src, name), path.join(STAGE, 'app', d.dir, name));
        }
    }
    // The staged program must load on its own, without anything from the development folder.
    run(path.join(STAGE, 'runtime', 'node.exe'), ['--check', path.join(STAGE, 'app', 'supervisor.js')], 'syntax check');
    let files = 0;
    let bytes = 0;
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else { files += 1; bytes += fs.statSync(p).size; }
        }
    };
    walk(STAGE);
    out('staged ' + files + ' files, ' + Math.round(bytes / 1048576) + ' MB in ' + STAGE);
}

function modsArg() {
    const i = process.argv.indexOf('--mods');
    return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : '';
}

function stageMods() {
    for (const d of [STAGE_MODS, STAGE_SEEDS]) {
        fs.rmSync(d, { recursive: true, force: true });
        fs.mkdirSync(d, { recursive: true });
    }
    const from = modsArg();
    for (const mod of modfiles.MODS) {
        const src = modfiles.modSource(mod.id, from, fail);
        const dest = path.join(STAGE_MODS, mod.id);
        const copied = modfiles.stageMod(mod, src, dest, path.join(STAGE_SEEDS, mod.id), fail);
        modfiles.checkComplete(mod, dest, copied, fail);
        out(mod.id + ': ' + copied.size + ' files from ' + src);
    }
    for (const d of [STAGE_MODS, STAGE_SEEDS]) modfiles.checkPrivate(d, modfiles.underPrefix(''), fail);
}

function setup(ver) {
    // ISCC reads a script as UTF-8 only with a byte order mark; the Chinese messages need it.
    const src = fs.readFileSync(path.join(ROOT, 'installer', 'inZOIPhone.iss'), 'utf8').replace(/^\uFEFF/, '');
    const iss = path.join(ROOT, 'installer', 'build.iss');
    fs.writeFileSync(iss, '\uFEFF' + src, 'utf8');
    fs.mkdirSync(DIST, { recursive: true });
    try {
        run(innoCompiler(), [
            '/Q',
            '/DAppVersion=' + ver,
            '/DStageDir=' + STAGE,
            '/DModsDir=' + STAGE_MODS,
            '/DSeedsDir=' + STAGE_SEEDS,
            '/DIconFile=' + ICON,
            '/DOutputDir=' + DIST,
            iss
        ], 'ISCC');
    } finally {
        try { fs.unlinkSync(iss); } catch (e) { /* already gone */ }
    }
    const exe = path.join(DIST, 'inZOI-AI-Phone-Setup-' + ver + '.exe');
    if (!isFile(exe)) fail('ISCC did not produce ' + exe);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
    fs.writeFileSync(exe + '.sha256', sha + '  ' + path.basename(exe) + '\n', 'utf8');
    out('setup: ' + exe + ' (' + Math.round(fs.statSync(exe).size / 1048576) + ' MB)');
    out('sha256: ' + sha);
}

async function main() {
    if (process.platform !== 'win32') fail('the setup can only be built on Windows');
    const ver = version();
    out('inZOI AI Phone ' + ver);
    fs.mkdirSync(BUILD, { recursive: true });
    run(process.execPath, [path.join(__dirname, 'make-icon.js'), ICON], 'make-icon');
    buildHelper(ver);
    if (process.argv.indexOf('--helper') >= 0) return;
    await stage();
    stageMods();
    setup(ver);
}

main().catch((e) => fail(e && e.stack || String(e)));
