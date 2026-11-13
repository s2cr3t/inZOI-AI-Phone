'use strict';
// The program files of the two game mods, shared by tools/build-installer.js (the setup copies
// them over the installed mods) and tools/build-test-kit.js (the kit's Mods folder).
//
// The installed mods also hold this PC's conversations, Moments, portraits and phone settings. Only the files listed here are copied, and checkPrivate looks again at the result:
// the build stops if anything personal or anything that looks like an API key ends up in it.
//
// Two kinds of files:
//   files/trees  program files; the setup always replaces them
//   seeds        files the game or the service also write later (a window position, the Lua
//                mod's request queues); the setup only creates them when they are missing
const fs = require('fs');
const path = require('path');
const paths = require('../lib/paths');

const UI_FILES = ['app.js', 'index.html', 'uimod_manifest.json', 'window.js'];
const MODS = [
    {
        id: paths.PHONE_MOD_ID,
        files: [
            paths.PHONE_MOD_ID + '.uplugin',
            'mod_manifest.json',
            'ui/uimod_apps.json'
        ].concat(UI_FILES.map((f) => 'ui/board/' + f), UI_FILES.map((f) => 'ui/phone/' + f)),
        trees: [
            // Made by tools/make-sounds.js.
            { dir: 'ui/phone/sounds', test: (n) => /\.(webm|ogg|wav)$/i.test(n) },
            { dir: 'ui/phone/wallpapers', test: (n) => /^preset-[a-z0-9-]+\.jpg$/.test(n) },
            { dir: 'ui/phone/emoji', test: (n) => /\.png$/i.test(n) || n === 'set.cfg' },
            // Dream Car's vehicle photos, made by tools/capture-cars.js.
            { dir: 'ui/phone/cars', test: (n) => /\.png$/i.test(n) },
            // The 成长册 songs, made by tools/make-booklet-music.js; the booklets themselves
            // (ui/phone/booklet/board.cfg) are personal and never ship.
            { dir: 'ui/phone/booklet/songs', test: (n) => /\.webm$/i.test(n) }
        ],
        seeds: ['ui/board/saved/window.cfg'],
        empty: [],
        // Written at run time by the game and the service; personal data of whoever played.
        // ui/phone/music is what the removed Music app left on a development PC (NetEase login QR
        // code, covers) and must never ship.
        privateDirs: ['ui/phone/sms', 'ui/phone/moments', 'ui/phone/portraits', 'ui/phone/service', 'ui/phone/saved', 'ui/phone/persona',
            'ui/phone/wallpapers/custom', 'ui/phone/music', 'ui/phone/freelance', 'ui/phone/messages', 'ui/phone/vehicle',
            'ui/phone/groups', 'ui/phone/media', 'ui/phone/diag', 'ui/phone/stories', 'ui/phone/oa', 'ui/phone/suitor']
    },
    {
        id: paths.JOURNAL_MOD_ID,
        files: [
            paths.JOURNAL_MOD_ID + '.uplugin',
            'mod_manifest.json',
            'lua/lua_manifest.json',
            'lua/.luarc.json',
            'lua/AGENTS.md'
        ],
        trees: [{ dir: 'lua', test: (n) => /\.lua$/i.test(n) }],
        seeds: [],
        // Queues the service fills; the Lua mod expects the files to exist.
        empty: ['bridge/buffs.cfg', 'bridge/meals.cfg'],
        privateDirs: []
    }
];
const PRIVATE_NAMES = /^(secrets|config)\.json$|\.pid$|^outbox|^inbox/i;
const KEY_LIKE = /\b(sk|ak|pk)-[A-Za-z0-9_\-]{16,}|\bBearer\s+[A-Za-z0-9._\-]{16,}/;
const TEXT_EXT = /\.(js|html|json|cfg|lua|md|txt|uplugin)$/i;

function isFile(f) {
    try { return fs.statSync(f).isFile(); } catch (e) { return false; }
}

function isDir(f) {
    try { return fs.statSync(f).isDirectory(); } catch (e) { return false; }
}

function copy(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

function walk(dir, base, list) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const rel = base ? base + '/' + e.name : e.name;
        if (e.isDirectory()) walk(p, rel, list);
        else list.push(rel);
    }
    return list;
}

// The installed mod, or <modsDir>\<id> when a folder of mods is given.
function modSource(modId, modsDir, fail) {
    const dir = modsDir ? path.join(modsDir, modId) : paths.findMod(modId);
    if (!dir || !isFile(path.join(dir, modId + '.uplugin'))) {
        fail('mod ' + modId + ' not found' + (modsDir ? ' in ' + modsDir : ' under Documents\\inZOI\\Mods'));
    }
    return dir;
}

// Copies a mod's program files to dest and its seed files to seedDest (the same folder when
// seedDest is not given). Returns the relative paths copied, seeds included.
function stageMod(mod, src, dest, seedDest, fail) {
    const copied = new Set();
    const seedsTo = seedDest || dest;
    for (const rel of mod.files) {
        const from = path.join(src, rel);
        if (!isFile(from)) fail(mod.id + ': ' + rel + ' is missing in ' + src);
        copy(from, path.join(dest, rel));
        copied.add(rel);
    }
    for (const t of mod.trees) {
        const base = path.join(src, t.dir);
        if (!isDir(base)) fail(mod.id + ': folder ' + t.dir + ' is missing in ' + src);
        for (const rel of walk(base, t.dir, [])) {
            if (!t.test(path.basename(rel))) continue;
            copy(path.join(src, rel), path.join(dest, rel));
            copied.add(rel);
        }
    }
    for (const rel of mod.seeds) {
        const from = path.join(src, rel);
        if (!isFile(from)) fail(mod.id + ': ' + rel + ' is missing in ' + src);
        copy(from, path.join(seedsTo, rel));
        copied.add(rel);
    }
    for (const rel of mod.empty) {
        const to = path.join(seedsTo, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, '');
        copied.add(rel);
    }
    return copied;
}

// Everything the mod declares must be in the package, or the game loads half a mod. dir holds
// the mod's manifests (the program files).
function checkComplete(mod, dir, copied, fail) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mod_manifest.json'), 'utf8'));
    for (const entry of manifest.NonAssets || []) {
        const rel = String(entry).replace(/^\/+/, '');
        if (!copied.has(rel)) fail(mod.id + ': mod_manifest.json lists ' + entry + ' but it is not in the package');
    }
    const lua = path.join(dir, 'lua', 'lua_manifest.json');
    if (!isFile(lua)) return;
    const bindings = JSON.parse(fs.readFileSync(lua, 'utf8')).bindings || {};
    for (const env of Object.keys(bindings)) {
        for (const b of bindings[env] || []) {
            const rel = 'lua/' + env + '/' + String(b.script).split('.').join('/') + '.lua';
            if (!copied.has(rel)) fail(mod.id + ': lua_manifest.json binds ' + b.script + ' but ' + rel + ' is not in the package');
        }
    }
    for (const env of Object.keys(bindings)) {
        const main = 'lua/' + env + '/Main.lua';
        if (isFile(path.join(dir, main)) && !copied.has(main)) fail(mod.id + ': ' + main + ' was not copied');
    }
}

// Looks at every file under root; modDirOf(rel) gives the mod a file belongs to and the path
// inside it, or null.
function checkPrivate(root, modDirOf, fail) {
    const problems = [];
    for (const rel of walk(root, '', [])) {
        const name = path.basename(rel);
        const inMod = modDirOf(rel);
        if (inMod) {
            for (const d of inMod.mod.privateDirs) {
                if (inMod.inner === d || inMod.inner.startsWith(d + '/')) problems.push(rel + ' is personal data');
            }
        }
        if (PRIVATE_NAMES.test(name)) problems.push(rel + ' must not be shared');
        if (TEXT_EXT.test(name)) {
            const text = fs.readFileSync(path.join(root, rel), 'utf8');
            if (KEY_LIKE.test(text)) problems.push(rel + ' contains something that looks like an API key');
        }
    }
    if (problems.length) fail('the package is not safe to share:\n  ' + problems.join('\n  '));
}

// For checkPrivate: files laid out as <prefix><modId>/<inner>.
function underPrefix(prefix) {
    return (rel) => {
        for (const mod of MODS) {
            const p = prefix + mod.id + '/';
            if (rel.startsWith(p)) return { mod, inner: rel.slice(p.length) };
        }
        return null;
    };
}

module.exports = { MODS, modSource, stageMod, checkComplete, checkPrivate, underPrefix, walk, isFile, isDir, copy };
