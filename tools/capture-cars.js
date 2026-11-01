#!/usr/bin/env node
'use strict';
// Builds the pictures of the phone's Dream Car app from the game's own car app.
//
// The game keeps its vehicle icons inside its pak files, where a UI mod cannot load them. This
// opens the game's phone on the car app's Buy tab and crops pictures out of screenshots:
//   cars/<VehicleDtId>.png              every vehicle in its first colour, from the list
//   cars/<VehicleDtId>/<ColorId>.png    every colour, larger, from the vehicle's detail screen
// (under Mods/InGame/HouseholdBoard_I6IXIO/ui/phone). The list card's 购买 only opens the detail
// screen, and only for a vehicle the household can afford; the others keep the list picture.
// The detail screen's own Buy button is never pressed. Run it with the game in a loaded save:
//   node tools/capture-cars.js            capture what is missing
//   node tools/capture-cars.js --all      capture everything again
//   node tools/capture-cars.js IONIQ5     only these vehicles (row names)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { GameClient } = require('../lib/game');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, '..', 'Mods', 'InGame', 'HouseholdBoard_I6IXIO', 'ui', 'phone', 'cars');
const WORK = path.join(ROOT, 'build', 'capture');
const CROP = path.join(__dirname, 'crop-batch.ps1');
// The picture on the detail screen (2560x1440 screen), centred on the vehicle and below the
// screen's round Back button.
const PIC = { x: 1992, y: 255, w: 388, h: 223 };
// The picture inside a list card, inside its rounded corners and above the colour dots.
const CARD_PIC = { dx: 16, dy: 14, w: 186, h: 126 };
const SCROLL_SETTLE_MS = 1500;
const OPEN_SETTLE_MS = 1200;
const COLOR_SETTLE_MS = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const g = new GameClient();

// The file name of a colour ("Carbon Black" -> Carbon_Black); the phone names them the same way.
function colorFile(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.png'; }

function walk(n, fn) {
    if (!n || typeof n !== 'object') return;
    fn(n);
    for (const k of Object.keys(n)) if (Array.isArray(n[k])) n[k].forEach((c) => walk(c, fn));
}

async function tree() { return g.soft('ui_get_tree', { Window: 'Smartphone', Mode: 'interactive' }); }

function refIn(t, re) {
    let hit = null;
    walk(t, (n) => { if (!hit && n.ref && re.test(n.ref)) hit = n; });
    return hit;
}

async function click(ref) { return g.soft('ui_click', { ref }); }

async function openBuyTab() {
    const w = await g.soft('ui_list_windows', {});
    if (!((w && w.windows) || []).some((x) => x.ui_type === 'Smartphone')) {
        const phone = refIn(await g.soft('ui_get_tree', { Window: 'Hud', Mode: 'interactive' }), /BW_Button_SmartPhone$/);
        if (!phone) throw new Error('the HUD phone button is not on screen');
        await click(phone.ref);
        await sleep(OPEN_SETTLE_MS);
    }
    const back = refIn(await tree(), /WBP_Mobile_Car_Detail\/BW_Button_Back$/);
    if (back) { await click(back.ref); await sleep(OPEN_SETTLE_MS); }
    const app = refIn(await tree(), /WBP_Mobile_AppIcon_Car\/BW_Button$/);
    if (app) { await click(app.ref); await sleep(OPEN_SETTLE_MS); }
    const buy = refIn(await tree(), /BW_WBP_CarButton_Buy\/BW_Button_Car$/);
    if (!buy) throw new Error('the car app did not open');
    await click(buy.ref);
    await sleep(OPEN_SETTLE_MS);
}

async function closePhone() {
    for (const re of [/WBP_Mobile_Car_Detail\/BW_Button_Back$/, /WBP_Mobile_Car\/BW_Button_Close$/, /WBP_Mobile\/WBP_Common_CloseButton\/BW_Button$/]) {
        const n = refIn(await tree(), re);
        if (n) { await click(n.ref); await sleep(900); }
    }
}

async function catalog() {
    const rows = await g.soft('data_table_get_all', { Alias: 'Vehicle' });
    const buyable = (rows || []).filter((r) => (r.purchasableLevel || []).length && r.type !== 'Invalid' && r.type !== 'Ship');
    const names = await g.soft('l10n_get', { Keys: JSON.stringify(buyable.map((r) => r.displayNameTextId)) });
    const byName = new Map();
    for (const r of buyable) byName.set(String((names && names[r.displayNameTextId]) || r._row_name).trim(), r);
    return byName;
}

// The played household's money (₼), or null when it cannot be read.
async function householdMoney() {
    const h = await g.soft('household_get_members', {});
    if (!h || !h.household_id) return null;
    const c = await g.soft('entity_reflect', { entity_id: String(h.household_id), Component: 'Currency' });
    const v = c && c.currencyMap ? Number(c.currencyMap.mew) : NaN;
    return isFinite(v) ? v : null;
}

// The list cards wholly on screen now (only those can be clicked).
function visibleCards(t) {
    let list = null;
    walk(t, (n) => { if (!list && n.role === 'list' && /BW_TileView_CarSlot$/.test(n.ref || '')) list = n; });
    if (!list) return { list: null, cards: [] };
    const [lx, ly, lw, lh] = list.rect;
    const cards = [];
    for (const e of list.children || []) {
        if (e.role !== 'entry' || !e.rect) continue;
        const [x, y, w, h] = e.rect;
        if (x < lx - 1 || y < ly - 1 || x + w > lx + lw + 1 || y + h > ly + lh + 1) continue;
        let buy = null;
        walk(e, (n) => { if (!buy && n.ref && /BW_Button_Common\/BW_Button$/.test(n.ref)) buy = n.ref; });
        cards.push({ name: String(e.text || '').trim(), rect: e.rect, buy });
    }
    return { list, cards };
}

async function screenshot(name) {
    const file = path.join(WORK, name);
    const png = file + '.png';
    if (fs.existsSync(png)) fs.unlinkSync(png);
    await g.soft('screenshot_capture', { Filename: file.replace(/\\/g, '/'), unique_suffix: false });
    for (let i = 0; i < 40 && !fs.existsSync(png); i++) await sleep(150);
    await sleep(250);
    if (!fs.existsSync(png)) throw new Error('no screenshot at ' + png);
    return png;
}

function crop(jobs) {
    if (!jobs.length) return;
    const file = path.join(WORK, 'jobs.json');
    fs.writeFileSync(file, JSON.stringify(jobs), 'utf8');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CROP, '-Jobs', file], { stdio: 'inherit' });
}

// Presses the 购买 of the card with this name (it opens the detail screen, nothing is bought) and
// waits for the screen; the card is looked up again each try, since the list rebuilds its cards.
async function openDetail(name) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const card = visibleCards(await tree()).cards.find((c) => c.name === name);
        if (!card || !card.buy) return false;
        await click(card.buy);
        // A vehicle the household cannot afford only shows a toast (您的资金不足).
        for (let i = 0; i < 10; i++) {
            await sleep(200);
            if (refIn(await tree(), /WBP_Mobile_Car_Detail\/BW_Button_Buy$/)) {
                await sleep(400);
                return true;
            }
        }
    }
    return false;
}

// On the detail screen of one vehicle: every colour, one screenshot each.
async function captureColors(row, all) {
    const t = await tree();
    if (!refIn(t, /WBP_Mobile_Car_Detail\/BW_Button_Buy$/)) throw new Error('the detail screen did not open');
    const swatches = [];
    walk(t, (n) => { if (n.ref && /WBP_ColorPalette_Slot02_C_\d+\/BW_Button$/.test(n.ref) && n.rect) swatches.push(n); });
    swatches.sort((a, b) => a.rect[0] - b.rect[0]);
    const colors = row.color || [];
    if (swatches.length !== colors.length) console.log('  ' + row._row_name + ': ' + swatches.length + ' swatches for ' + colors.length + ' colours');
    const jobs = [];
    for (let k = 0; k < Math.min(swatches.length, colors.length); k++) {
        const dst = path.join(OUT, row._row_name, colorFile(colors[k].colorId));
        if (!all && fs.existsSync(dst)) continue;
        await click(swatches[k].ref);
        await sleep(COLOR_SETTLE_MS);
        const png = await screenshot(row._row_name + '_' + k);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        jobs.push({ src: png, dst, x: PIC.x, y: PIC.y, w: PIC.w, h: PIC.h });
    }
    crop(jobs);
    return jobs.length;
}

(async () => {
    const args = process.argv.slice(2);
    const all = args.includes('--all');
    const only = args.filter((a) => !a.startsWith('--'));
    fs.mkdirSync(WORK, { recursive: true });
    fs.mkdirSync(OUT, { recursive: true });
    const byName = await catalog();
    const money = await householdMoney();
    const wanted = new Set(Array.from(byName.entries())
        .filter(([, r]) => !only.length || only.indexOf(r._row_name) >= 0)
        .filter(([, r]) => money === null || Number(r.price) <= money)
        .filter(([, r]) => all || (r.color || []).some((c) => !fs.existsSync(path.join(OUT, r._row_name, colorFile(c.colorId)))))
        .map(([n]) => n));
    const thumbs = Array.from(byName.values()).filter((r) => (!only.length || only.indexOf(r._row_name) >= 0) &&
        (all || !fs.existsSync(path.join(OUT, r._row_name + '.png'))));
    console.log(byName.size + ' vehicles for sale, ' + thumbs.length + ' list picture(s) and ' + wanted.size + ' detail set(s) to capture');
    if (!wanted.size && !thumbs.length) return;
    await openBuyTab();
    const done = new Set();
    const shown = new Set();
    let offset = 0;
    let page = 0;
    try {
        let list = visibleCards(await tree()).list;
        if (!list) throw new Error('the car list is not on screen');
        await g.soft('ui_scroll', { ref: list.ref, To: 'start' });
        await sleep(SCROLL_SETTLE_MS);
        for (;;) {
            const seen = visibleCards(await tree());
            list = seen.list;
            if (!list) throw new Error('the car list is not on screen');
            // The list pictures of the cards wholly on screen, from one screenshot.
            const fresh = seen.cards.filter((c) => byName.has(c.name) && !shown.has(c.name) && thumbs.indexOf(byName.get(c.name)) >= 0);
            if (fresh.length) {
                const png = await screenshot('page' + (page++));
                crop(fresh.map((c) => ({ src: png, dst: path.join(OUT, byName.get(c.name)._row_name + '.png'),
                    x: c.rect[0] + CARD_PIC.dx, y: c.rect[1] + CARD_PIC.dy, w: CARD_PIC.w, h: CARD_PIC.h, flat: '#D9D9D9' })));
                fresh.forEach((c) => shown.add(c.name));
                console.log('list: ' + fresh.map((c) => c.name).join(', '));
            }
            for (const c of seen.cards) {
                if (!wanted.has(c.name) || done.has(c.name) || !c.buy) continue;
                const row = byName.get(c.name);
                if (!await openDetail(c.name)) {
                    console.log(c.name + ': the detail screen did not open, skipped');
                    continue;
                }
                const n = await captureColors(row, all);
                console.log(c.name + ' (' + row._row_name + '): ' + n + ' colour(s)');
                done.add(c.name);
                const back = refIn(await tree(), /WBP_Mobile_Car_Detail\/BW_Button_Back$/);
                if (back) { await click(back.ref); await sleep(OPEN_SETTLE_MS); }
            }
            // One row further down: the list's offset counts cards, two to a row.
            const max = list.scroll && typeof list.scroll.max === 'number' ? list.scroll.max : byName.size;
            if (offset > max) break;
            // The last row is wholly on screen only at the very end.
            offset = offset >= max ? max + 1 : Math.min(offset + 2, max);
            await g.soft('ui_scroll', offset > max ? { ref: list.ref, To: 'end' } : { ref: list.ref, To: 'offset', Offset: offset });
            await sleep(SCROLL_SETTLE_MS);
        }
    } finally {
        await closePhone();
        for (const f of fs.readdirSync(WORK)) if (/\.png$|^jobs\.json$/.test(f)) fs.unlinkSync(path.join(WORK, f));
    }
    const missing = Array.from(wanted).filter((n) => !done.has(n));
    console.log('done: ' + done.size + ' vehicle(s)' + (missing.length ? ', not reached: ' + missing.join(', ') : ''));
})().catch((e) => { console.error('capture failed: ' + (e && e.stack || e)); process.exit(1); });
