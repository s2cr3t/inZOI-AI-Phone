#!/usr/bin/env node
'use strict';
// The phone UI in an ordinary browser, on the live game's data, for looking at screens while
// building them:  node tools/phone-preview.js [port]   then open http://localhost:<port>/
//
// The page is the mod's own index.html with the game's two coui:// scripts swapped for a stand-in
// whose inzoi.cli.execute sends each command here; this passes it to the game's MCP server
// (career.list_openings -> career_list_openings) and returns the game's answer. The phone's own
// saves (uimod.cfg_save) are answered without writing anything, so the preview never changes the
// phone in the game. Commands that act in the game (ui.click, interaction.execute ...) do act:
// do not press Buy or Send in the preview unless that is what you mean.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { GameClient } = require('../lib/game');

const PORT = Number(process.argv[2]) || 8765;
const PHONE = path.resolve(__dirname, '..', '..', 'Mods', 'InGame', 'HouseholdBoard_I6IXIO', 'ui', 'phone');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.json': 'application/json' };
const game = new GameClient();

// Stands in for coui://inzoi/cohtml.js and inzoi-sdk.js.
const STUB = [
    '<script>',
    'window.engine = { call: function () { return Promise.resolve(null); }, on: function () {}, trigger: function () {} };',
    'window.inzoi = { view: { hover: function () {}, setContentRect: function () {} },',
    '  saveState: { register: function () {}, onLoad: function () {} },',
    '  cli: { execute: function (cmd, params) {',
    '    return fetch("/cli", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd: cmd, params: params || {} }) })',
    '      .then(function (r) { return r.json(); })',
    '      .then(function (r) { if (r.error) throw new Error(r.error); return r.value; });',
    '  } } };',
    '</script>'
].join('\n');

function page() {
    let html = fs.readFileSync(path.join(PHONE, 'index.html'), 'utf8');
    html = html.replace(/<script src="coui:\/\/inzoi\/cohtml\.js"><\/script>\s*<script src="coui:\/\/inzoi\/mod\/inzoi-sdk\.js"><\/script>/, STUB);
    html = html.replace(/<link rel="stylesheet" href="coui:[^"]*">/g, '<style>:root { --inzoi-font-ui: "Microsoft YaHei UI", "Segoe UI", sans-serif; }</style>');
    return html;
}

async function cli(cmd, params) {
    if (cmd === 'uimod.cfg_save') return { success: true, message: 'preview: not saved' };
    // The phone's window place and size in the game do not fit a browser page: a fresh window.
    if (cmd === 'uimod.cfg_load' && params && params.key === 'window') return { section: params.section, key: 'window', value: '' };
    // Apps named in PREVIEW_APPS (comma-separated) show as installed, without getting them.
    if (cmd === 'uimod.cfg_load' && params && params.key === 'apps' && process.env.PREVIEW_APPS) {
        const r = await game.call('uimod_cfg_load', params).catch(() => null);
        let v = null;
        try { v = JSON.parse((r && r.value) || 'null'); } catch (e) { v = null; }
        if (!v || !Array.isArray(v.installed)) v = { v: 1, installed: [], known: [] };
        for (const id of process.env.PREVIEW_APPS.split(',')) {
            if (v.installed.indexOf(id) < 0) v.installed.push(id);
            if (Array.isArray(v.known) && v.known.indexOf(id) < 0) v.known.push(id);
        }
        return { section: params.section, key: 'apps', value: JSON.stringify(v) };
    }
    const tool = String(cmd).replace('.', '_');
    return game.call(tool, params);
}

http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/cli') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
            let reply;
            try {
                const { cmd, params } = JSON.parse(body || '{}');
                reply = { value: await cli(cmd, params) };
            } catch (e) {
                reply = { error: String(e && e.message || e) };
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(reply));
        });
        return;
    }
    const url = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
        res.end(page());
        return;
    }
    const file = path.resolve(PHONE, '.' + url);
    if (!file.startsWith(PHONE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end();
        return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log('phone preview on http://localhost:' + PORT + '/ (from ' + PHONE + ')'));
