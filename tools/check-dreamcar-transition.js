'use strict';
// Native cohtml regression check. Temporarily injects the probe, restores the exact source,
// and remounts the production phone even when an assertion fails. Does not buy a vehicle.
const fs = require('fs');
const path = require('path');
const { GameClient } = require('../lib/game');
const phone = path.resolve(__dirname, '../../Mods/InGame/HouseholdBoard_I6IXIO/ui/phone');
const sourcePath = path.join(phone, 'app.js');
const reportPath = path.join(phone, 'diag/dreamcar-transition-check.cfg');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function nativeProbe(runId) {
    var results = [];
    var originalLoad = screens.dreamcar.load;
    var sampling = true;
    var samples = [];
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
    function arrived(id) { return until(function () { return current === id && !dcCurtain && !transition; }, 'Did not arrive: ' + id); }
    function sample() {
        if (!sampling) return;
        if (dcCurtain && samples.length < 1600) samples.push({ at: Date.now(), screen: current,
            phase: dcCurtain.phase, opacity: Number(dcCurtain.veil.style.opacity),
            dark: hasClass(document.getElementById('app-root'), 'dc-mode') });
        nextFrame(sample);
    }
    function visiblePhotos() {
        var b = wf.content.getBoundingClientRect();
        var photos = el.screen.querySelectorAll('.dc-well');
        var count = 0;
        for (var i = 0; i < photos.length; i++) {
            var r = photos[i].getBoundingClientRect();
            if (r.bottom <= b.top || r.top >= b.bottom) continue;
            var pic = photos[i].querySelector('.dc-pic');
            assert(pic && pic.style.backgroundImage, 'Visible photo not ready');
            count++;
        }
        assert(count > 0, 'No visible vehicle photo');
        return count;
    }
    function finish(error) {
        sampling = false;
        screens.dreamcar.load = originalLoad;
        var report = { runId: runId, ok: !error, error: error ? String(error.stack || error) : '',
            results: results, frames: samples, current: current };
        soft(call('uimod.cfg_save', { mod_id: SMS_MOD, section: 'ui/phone/diag',
            key: 'dreamcar-transition-check', value: JSON.stringify(report) }));
    }
    nextFrame(sample);
    until(function () { return appInstalled('dreamcar') && current === 'home' && !busy; }, 'Phone did not initialize')
        .then(function () { open('dreamcar'); return arrived('dreamcar'); })
        .then(function () {
            assert(hasClass(document.getElementById('app-root'), 'dc-mode'), 'Missing dark theme');
            results.push({ check: 'cold entry, decoded visible photos', photos: visiblePhotos() });
            open('home'); return arrived('home');
        })
        .then(function () {
            assert(!hasClass(document.getElementById('app-root'), 'dc-mode'), 'Theme leaked into home');
            open('dreamcar'); return arrived('dreamcar');
        })
        .then(function () {
            results.push({ check: 'warm reentry', photos: visiblePhotos() });
            dcOpenCar(dcFeatured(dcLastData.cars, dcLastData.env));
            return until(function () { return current === 'dccar' && !transition && !busy; }, 'Detail transition stuck');
        })
        .then(function () {
            assert(!wf.content.style.backgroundImage, 'Wallpaper remained on dark detail');
            results.push({ check: 'detail navigation retains dark background' });
            open('home'); return arrived('home');
        })
        .then(function () {
            screens.dreamcar.load = function () { return pause(1800).then(originalLoad); };
            open('dreamcar');
            return until(function () { return dcCurtain && dcCurtain.phase === 'loading'; }, 'Slow load not covered');
        })
        .then(function () {
            assert(Number(dcCurtain.veil.style.opacity) === 1, 'Slow load exposed content');
            dcNavigate('home'); return arrived('home');
        })
        .then(function () { return pause(2100); })
        .then(function () {
            assert(current === 'home' && !dcCurtain, 'Old load reopened the showroom');
            results.push({ check: 'back during slow load cancels old reveal' });
            screens.dreamcar.load = function () { return new Promise(function () {}); };
            open('dreamcar');
            return until(function () { return dcCurtain && dcCurtain.phase === 'failed'; }, 'Missing timeout state', 13000);
        })
        .then(function () {
            assert(dcCurtain.retry.style.display === 'inline-block', 'No retry action');
            results.push({ check: 'timeout exposes retry and back' });
            screens.dreamcar.load = originalLoad;
            dcNavigate('dreamcar'); return arrived('dreamcar');
        })
        .then(function () {
            results.push({ check: 'retry recovers', photos: visiblePhotos() });
            // A theme change must take place while the curtain is fully opaque.
            for (var i = 1; i < samples.length; i++) {
                if (samples[i].dark !== samples[i - 1].dark)
                    assert(samples[i].opacity === 1, 'Theme changed before opaque cover');
            }
            assert(samples.some(function (s) { return s.phase === 'revealing' && s.opacity > 0 && s.opacity < 1; }), 'No intermediate reveal frames');
            results.push({ check: 'opaque theme swap and animated reveal frames' });
            finish(null);
        }).then(null, finish);
}

(async () => {
    const original = fs.readFileSync(sourcePath, 'utf8');
    const end = original.lastIndexOf('})();');
    if (end < 0) throw new Error('Phone closure not found');
    const runId = String(Date.now());
    const injected = original.slice(0, end) + '\n(' + nativeProbe.toString() + ')(' + JSON.stringify(runId) + ');\n' + original.slice(end);
    const game = new GameClient({ timeoutMs: 15000 });
    let report;
    fs.writeFileSync(sourcePath, injected);
    try {
        await game.call('uimod_remount', { mod_id: 'HouseholdBoard_I6IXIO' });
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            await sleep(500);
            try {
                const value = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
                if (value.runId === runId) { report = value; break; }
            } catch (_) { /* first report may still be writing */ }
        }
        if (!report) throw new Error('Native test did not report within 90 seconds');
        console.log(JSON.stringify({ ok: report.ok, results: report.results, frames: report.frames.length, error: report.error }, null, 2));
        if (!report.ok) process.exitCode = 1;
    } finally {
        if (fs.readFileSync(sourcePath, 'utf8') !== injected) throw new Error('Source changed during test; refusing to overwrite it');
        fs.writeFileSync(sourcePath, original);
        await game.call('uimod_remount', { mod_id: 'HouseholdBoard_I6IXIO' });
        console.log('Production source restored and remounted.');
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
