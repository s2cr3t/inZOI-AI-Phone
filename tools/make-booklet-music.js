'use strict';
// Turns the 成长册 songs into what the game's UI engine plays (a WebM with a VP8 picture and
// Vorbis sound, see src/phone/02-sounds.js) and writes them into the phone mod:
//   music\<title>.mp3                                     the songs, named by their title
//   mods\HouseholdBoard_I6IXIO\ui\phone\booklet\songs\<file>.webm   in this repository
//   <installed mod>\ui\phone\booklet\songs\<file>.webm   and in the mod the game loads, if found
// Which title is which file is lib/booklet.js SONGS.
//
//   node tools/make-booklet-music.js
//
// ffmpeg comes from the FFMPEG environment variable (an absolute path to ffmpeg.exe) or the
// winget install; nothing runs through a shell.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SONGS } = require('../lib/booklet');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'music');
const OUT = path.join(ROOT, 'mods', 'HouseholdBoard_I6IXIO', 'ui', 'phone', 'booklet', 'songs');
const RATE = 48000;

function fail(msg) {
    console.error(msg);
    process.exit(1);
}

function isFile(p) {
    try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

function ffmpegPath() {
    const env = process.env.FFMPEG;
    if (env) {
        if (!path.isAbsolute(env) || path.basename(env).toLowerCase() !== 'ffmpeg.exe' || !isFile(env)) fail('FFMPEG must be the absolute path of an existing ffmpeg.exe');
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

function main() {
    const exe = ffmpegPath();
    fs.mkdirSync(OUT, { recursive: true });
    // The mod the game loads, found the way the phone build finds it.
    const mod = require('../lib/paths').modCopies('HouseholdBoard_I6IXIO').dir;
    const INSTALLED = mod ? path.join(mod, 'ui', 'phone', 'booklet', 'songs') : '';
    const installed = !!mod;
    if (installed) fs.mkdirSync(INSTALLED, { recursive: true });
    else console.log('the phone mod is not installed: the songs are written into this repository only');
    for (const key of Object.keys(SONGS)) {
        const song = SONGS[key];
        const src = path.join(SRC, song.title + '.mp3');
        if (!isFile(src)) {
            console.log('missing ' + src + ', skipped');
            continue;
        }
        const out = path.join(OUT, song.file + '.webm');
        // A small black picture as long as the song, at the frame rate of the voice messages that
        // play through (15 fps): the engine moves the sound on with the picture, and at 5 fps a
        // song stopped after a few seconds. A keyframe every second keeps seeking cheap.
        execFileSync(exe, ['-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=15',
            '-i', src, '-map', '0:v', '-map', '1:a', '-shortest',
            '-c:v', 'libvpx', '-b:v', '16k', '-pix_fmt', 'yuv420p', '-auto-alt-ref', '0', '-g', '15',
            '-c:a', 'libvorbis', '-b:a', '128k', '-ac', '2', '-ar', String(RATE),
            out], { stdio: 'inherit', windowsHide: true });
        if (!isFile(out) || fs.statSync(out).size === 0) fail(out + ' was not written');
        if (installed) fs.copyFileSync(out, path.join(INSTALLED, song.file + '.webm'));
        console.log(song.title + ' -> ' + song.file + '.webm (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
    }
}

main();
