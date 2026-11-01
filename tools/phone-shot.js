#!/usr/bin/env node
'use strict';
// Screenshots of the phone preview (tools/phone-preview.js must be running), drawn by a hidden
// Edge at twice the pixel density, for checking a screen's look in detail:
//   node tools/phone-shot.js <out.png> [step ...]
// Steps run in order before the shot:
//   tap:<text>         tap the first element whose own text is <text> (as the phone's taps)
//   scroll:<px>        scroll the phone's content to <px>
//   wait:<ms>          wait
//   js:<code>          run code in the page
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
    .find((p) => fs.existsSync(p));
const PORT = 9341;
const URL = process.env.PREVIEW_URL || 'http://localhost:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && waiting.has(msg.id)) {
            const w = waiting.get(msg.id);
            waiting.delete(msg.id);
            if (msg.error) w.reject(new Error(msg.error.message));
            else w.resolve(msg.result);
        }
    };
    const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    return {
        ready,
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

// The phone's taps listen to mousedown + mouseup (window.js turns them into a click).
const TAP = 'function (text) {' +
    ' var all = Array.prototype.slice.call(document.querySelectorAll("#app-root *"));' +
    ' var hit = all.filter(function (e) { return e.childNodes.length && Array.prototype.every.call(e.childNodes, function (c) { return c.nodeType === 3; }) && e.textContent.trim() === text; })[0];' +
    ' if (!hit) return "no element with text " + text;' +
    ' var r = hit.getBoundingClientRect(); var o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1 };' +
    ' hit.dispatchEvent(new MouseEvent("mousedown", o)); o.buttons = 0; hit.dispatchEvent(new MouseEvent("mouseup", o)); hit.dispatchEvent(new MouseEvent("click", o));' +
    ' return "tapped " + text; }';

(async () => {
    const [out, ...steps] = process.argv.slice(2);
    if (!out) throw new Error('usage: node tools/phone-shot.js <out.png> [step ...]');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-shot-'));
    const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--hide-scrollbars',
        '--window-size=460,880', 'about:blank'], { stdio: 'ignore' });
    try {
        const s = session(await cdpTarget());
        await s.ready;
        await s.send('Emulation.setDeviceMetricsOverride', { width: 440, height: 860, deviceScaleFactor: 2, mobile: false });
        await s.send('Page.enable');
        await s.send('Page.navigate', { url: URL });
        await sleep(3500);
        await s.send('Runtime.evaluate', { expression: 'var r = document.getElementById("app-root"); r.style.left = "10px"; r.style.top = "10px"; r.style.width = "420px"; r.style.height = "840px"; document.body.style.visibility = "visible";' });
        for (const step of steps) {
            const [kind, ...rest] = step.split(':');
            const arg = rest.join(':');
            let expr = '';
            if (kind === 'tap') expr = '(' + TAP + ')(' + JSON.stringify(arg) + ')';
            else if (kind === 'scroll') expr = 'document.getElementById("content").scrollTop = ' + Number(arg) + '; "scrolled"';
            else if (kind === 'js') expr = arg;
            if (kind === 'wait') { await sleep(Number(arg) || 500); continue; }
            const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
            console.log(step + ' -> ' + JSON.stringify(r.result && r.result.value));
            await sleep(kind === 'tap' ? 2500 : 600);
        }
        await sleep(800);
        const shot = await s.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 440, height: 860, scale: 1 } });
        fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
        console.log('saved ' + out);
        s.close();
    } finally {
        edge.kill();
        await sleep(500);
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Edge may still hold it */ }
    }
})().catch((e) => { console.error(e.message); process.exit(1); });
