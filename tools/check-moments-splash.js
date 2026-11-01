'use strict';
// In-game check for the Moments cover. The preview browser draws it; only cohtml can say whether
// the ring, the photo mark and the two shimmer bars really paint, and whether the veil lifts the
// way it should. Injects a probe into the phone, remounts the UI, holds the cover long enough to
// photograph it, then restores the exact source and remounts again.
const fs = require('fs');
const path = require('path');
const { GameClient } = require('../lib/game');
const phone = path.resolve(__dirname, '../../Mods/InGame/HouseholdBoard_I6IXIO/ui/phone');
const sourcePath = path.join(phone, 'app.js');
const reportPath = path.join(phone, 'diag/moments-splash-check.cfg');
const phasePath = path.join(phone, 'diag/moments-splash-phase.cfg');
const shotBase = path.resolve(__dirname, '../../../build/mo-ingame');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function momentsProbe(runId) {
    var results = [];
    var samples = [];
    var hold = 9000;
    function assert(ok, message) { if (!ok) throw new Error(message); }
    function pause(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
    function until(test, message, ms) {
        var start = Date.now();
        return new Promise(function (resolve, reject) {
            function check() {
                try { if (test()) { resolve(); return; } } catch (e) { reject(e); return; }
                if (Date.now() - start > (ms || 20000)) { reject(new Error(message)); return; }
                setTimeout(check, 50);
            }
            check();
        });
    }
    function save(key, value) {
        soft(call('uimod.cfg_save', { mod_id: SMS_MOD, section: 'ui/phone/diag', key: key, value: value }));
    }
    function sample() {
        var veil = moCurtain && moCurtain.veil;
        samples.push({ at: Date.now(), screen: current, phase: moCurtain ? moCurtain.phase : '',
            opacity: veil ? Number(veil.style.opacity) : 0,
            arc: !!(veil && veil.querySelector('.mo-cover-arc')),
            photo: !!(veil && veil.querySelector('.mo-cover-photo .ph-glyph')),
            bars: veil ? veil.querySelectorAll('.mo-cover-bar').length : 0,
            label: (veil && veil.querySelector('.mo-cover-label') ? veil.querySelector('.mo-cover-label').textContent : '') });
        if (samples.length > 1500) samples.splice(0, samples.length - 1500);
        nextFrame(sample);
    }
    function finish(err) {
        var report = { runId: runId, ok: !err, error: err ? String(err.stack || err) : '',
            results: results, frames: samples, current: current };
        save('moments-splash-check', JSON.stringify(report));
    }
    // The open that must have finished: the page is current, the veil is gone and the feed is there.
    function arrived() { return current === 'moments' && !moCurtain && !!document.getElementById('mo-screen'); }
    nextFrame(sample);
    until(function () { return current === 'home' && !busy; }, 'Phone did not initialize')
        .then(function () {
            MO_SPLASH_MIN_MS = hold;
            open('moments');
            return until(function () { return moCurtain && moCurtain.phase === 'loading'; }, 'Cover never reached the loading phase');
        })
        .then(function () {
            return until(function () { return Number(moCurtain.veil.style.opacity) === 1; }, 'Cover never turned opaque');
        })
        .then(function () {
            var veil = moCurtain.veil;
            save('moments-splash-phase', 'up');
            assert(!!veil.querySelector('.mo-cover-arc'), 'No story ring on the cover');
            assert(!!veil.querySelector('.mo-cover-photo .ph-glyph'), 'No photo mark inside the ring');
            assert(veil.querySelectorAll('.mo-cover-bar').length === 2, 'Feed bars missing');
            assert((veil.querySelector('.mo-cover-label') || {}).textContent === 'Laying out your feed', 'Wrong label');
            // The feed is painted under the veil on purpose; what matters is that the veil is the
            // last child of the root, i.e. the thing on top of it.
            assert(veil.parentNode === document.getElementById('app-root'), 'Veil not on the root');
            results.push({ check: 'cover up: ring, photo, two bars, label' });
            return pause(1500);
        })
        .then(function () { return until(arrived, 'Cover never lifted onto the feed', 25000); })
        .then(function () {
            var opaque = samples.some(function (s) { return s.opacity === 1; });
            var partial = samples.some(function (s) { return s.phase === 'revealing' && s.opacity > 0 && s.opacity < 1; });
            assert(opaque, 'Cover never reached full opacity');
            assert(partial, 'No intermediate frames on the way out');
            assert(!document.querySelector('.mo-cover'), 'Veil left in the document');
            assert(!hasClass(document.getElementById('app-root'), 'mo-covering'), 'Cover class left behind');
            assert(!document.querySelector('.mo-cover-arc'), 'Ring survived the veil');
            var posts = document.querySelectorAll('#mo-screen .mo-post').length;
            assert(posts > 0, 'No posts under the cover');
            results.push({ check: 'reveal animated, veil and class gone, feed on screen', posts: posts });
        })
        .then(function () {
            save('moments-splash-phase', 'down');
            // Second entry, at the real duration, to prove the veil is not a one-shot.
            MO_SPLASH_MIN_MS = 900;
            open('home');
            return until(function () { return current === 'home' && !moCurtain; }, 'Did not return home');
        })
        .then(function () {
            var from = samples.length;
            open('moments');
            return until(function () { return moCurtain && moCurtain.phase === 'loading'; }, 'Second cover never opened')
                .then(function () { return until(arrived, 'Second cover never lifted', 25000); })
                .then(function () {
                    var first = null, last = null;
                    for (var i = from; i < samples.length; i++) {
                        if (samples[i].phase && !first) first = samples[i].at;
                        if (samples[i].phase) last = samples[i].at;
                    }
                    assert(first && last, 'Second cover not sampled');
                    var ms = last - first;
                    assert(ms > 800 && ms < 2600, 'Second cover lasted ' + ms + 'ms');
                    results.push({ check: 'second entry covered again', ms: ms });
                });
        })
        .then(function () { finish(null); }, finish);
}

(async () => {
    const original = fs.readFileSync(sourcePath, 'utf8');
    const end = original.lastIndexOf('})();');
    if (end < 0) throw new Error('Phone closure not found');
    const runId = String(Date.now());
    const injected = original.slice(0, end) + '\n(' + momentsProbe.toString() + ')(' + JSON.stringify(runId) + ');\n' + original.slice(end);
    const game = new GameClient({ timeoutMs: 15000 });
    let report = null;
    try { fs.unlinkSync(reportPath); } catch (_) { /* first run */ }
    try { fs.unlinkSync(phasePath); } catch (_) { /* first run */ }
    fs.writeFileSync(sourcePath, injected);
    try {
        await game.call('uimod_remount', { mod_id: 'HouseholdBoard_I6IXIO' });
        // Wait for the cover to be up, then photograph it while it is held.
        let up = false;
        for (let i = 0; i < 120 && !up; i++) {
            await sleep(500);
            try { up = fs.readFileSync(phasePath, 'utf8').indexOf('up') >= 0; } catch (_) { /* not yet */ }
        }
        if (!up) throw new Error('The cover never reported itself up');
        await sleep(300);
        const png = shotBase + '.png';
        if (fs.existsSync(png)) fs.unlinkSync(png);
        await game.soft('screenshot_capture', { Filename: shotBase.replace(/\\/g, '/'), unique_suffix: false });
        for (let i = 0; i < 40 && !fs.existsSync(png); i++) await sleep(150);
        console.log(fs.existsSync(png) ? 'screenshot ' + png : 'screenshot missing');
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline && !report) {
            await sleep(500);
            try {
                const value = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
                if (value.runId === runId) report = value;
            } catch (_) { /* still writing */ }
        }
        if (!report) throw new Error('Probe did not report within 90 seconds');
        console.log(JSON.stringify({ ok: report.ok, error: report.error, results: report.results,
            frames: report.frames.length }, null, 2));
        if (!report.ok) process.exitCode = 1;
    } finally {
        if (fs.readFileSync(sourcePath, 'utf8') !== injected) throw new Error('Source changed during the check; refusing to overwrite it');
        fs.writeFileSync(sourcePath, original);
        await game.call('uimod_remount', { mod_id: 'HouseholdBoard_I6IXIO' });
        console.log('Production source restored and remounted.');
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
