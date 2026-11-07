    // ------------------------------------------------------------------
    // Dream Car: the game's car dealer (梦中情车) as an app.
    // ------------------------------------------------------------------
    // The catalog, prices and colours are the game's Vehicle table, the names and descriptions its
    // own text. The photos are files in cars/, cropped from the game's car app by
    // sms-bridge/tools/capture-cars.js: cars/<id>.png (first colour) for every vehicle, and
    // cars/<id>/<colour>.png for the colours captured. A purchase goes to the dealer in the simulation
    // (HouseholdJournal's Zoi.VehicleShop), which checks age, home, the one-vehicle rule and money
    // the way the game's dealer does; the game's own phone is never opened. Ownership is read back
    // from each character (ownedVehicle) before the app says the car is theirs.
    var DC_HYUNDAI = { CASPER: 1, GRANDEUR: 1, IONIQ5: 1, STARIA: 1, IONIQ9: 1, NEXO: 1 };
    var DC_KINDS = [
        { id: 'all', label: 'All' },
        { id: 'car', label: 'Cars' },
        { id: 'moto', label: 'Motorbikes' },
        { id: 'scooter', label: 'Scooters' },
        { id: 'bike', label: 'Bikes' }
    ];
    var DC_KIND_LABEL = { car: 'CAR', moto: 'MOTORBIKE', scooter: 'SCOOTER', bike: 'BICYCLE' };
    // Who the game would refuse by age (EB1VehiclePurchaseRejectReason.Underage).
    var DC_TOO_YOUNG = { Infant: 1, Toddler: 1, Child: 1, LowTeen: 1 };
    var dcCatalog = null;
    var dcCatalogLoading = null;
    var dcDoors = {};
    var dcTab = 'showroom';
    var dcFilter = 'all';
    var dcOpenId = null;
    var dcColor = {};
    var dcConfirm = false;
    var dcBuy = null;
    var dcLastData = null;
    var dcPicKnown = {};
    var dcPicLoads = {};
    var dcCurtain = null;

    // A veil fades on frames, but the end of the fade is also guaranteed by a timer: a curtain
    // that is left half-covered because the frame loop stopped strands the open behind it.
    function fadeVeil(veil, target, ms, alive, done) {
        var start = Number(veil.style.opacity) || 0;
        var at = Date.now();
        var fired = false;
        var fallback = setTimeout(finish, ms + 160);
        function finish() {
            if (fired) return;
            fired = true;
            clearTimeout(fallback);
            if (!alive()) return;
            veil.style.opacity = String(target);
            done();
        }
        function step() {
            if (!alive()) { clearTimeout(fallback); fired = true; return; }
            var t = Math.min(1, (Date.now() - at) / ms);
            veil.style.opacity = String(start + (target - start) * (1 - Math.pow(1 - t, 3)));
            if (t < 1) nextFrame(step);
            else nextFrame(finish);
        }
        nextFrame(step);
    }

    // Each veil carries its own Back, because it covers the page header that would otherwise be
    // the way out. Tapping it abandons the open: the veil goes, and if the page had already
    // landed we leave it the usual way. Two things it must not do, and used to: run a second
    // cover (Dream Car faded the whole phone to black again) or slide a page that never finished
    // drawing.
    function splashBack(stop, screenId) {
        openWaiting = '';
        var landed = current === screenId;
        stop();
        if (landed) open('home');
    }

    // The curtain lives outside the moving content/header, so theme changes never leak through.
    function dcFade(c, target, ms, done) {
        fadeVeil(c.veil, target, ms, function () { return dcCurtain === c; }, done);
    }

    function dcStopCurtain() {
        var c = dcCurtain;
        if (!c) return;
        clearTimeout(c.timer);
        if (c.veil.parentNode) c.veil.parentNode.removeChild(c.veil);
        c.root.classList.remove('dc-covering');
        c.root.classList.remove('dc-revealing');
        c.root.classList.remove('dc-reveal-fast');
        dcCurtain = null;
    }

    function dcFailCurtain(c) {
        if (dcCurtain !== c || c.phase === 'revealing') return;
        c.phase = 'failed';
        c.veil.querySelector('.dc-cover-center').style.visibility = 'visible';
        c.label.textContent = 'The showroom is taking too long to load.';
        c.veil.classList.add('dc-cover-failed');
        c.retry.style.display = 'inline-block';
        traceNav('dreamcar loading failed ' + c.screen);
    }

    function dcNavigate(screenId) {
        var opacity = dcCurtain ? dcCurtain.veil.style.opacity : '0';
        dcStopCurtain();
        ++openSeq;
        awaitOpen(screenId);
        var root = document.getElementById('app-root');
        var veil = node('div', 'dc-cover');
        veil.style.opacity = opacity;
        var back = veil.appendChild(node('button', 'dc-cover-back', 'Back'));
        var center = veil.appendChild(node('div', 'dc-cover-center'));
        center.appendChild(node('div', 'dc-cover-brand', 'DREAM CAR'));
        var label = center.appendChild(node('div', 'dc-cover-label', 'Preparing your showroom'));
        label.setAttribute('role', 'status');
        var track = center.appendChild(node('div', 'dc-cover-track'));
        track.appendChild(node('div', 'dc-cover-light'));
        var retry = center.appendChild(node('button', 'dc-cover-retry', 'Retry'));
        retry.style.display = 'none';
        veil.appendChild(node('div', 'dc-cover-home'));
        root.appendChild(veil);
        root.classList.add('dc-covering');
        var c = dcCurtain = { root: root, veil: veil, label: label, retry: retry,
            screen: screenId, phase: 'covering', at: Date.now(), timer: null };
        onTap(back, function () { splashBack(dcStopCurtain, screenId); });
        onTap(retry, function () { dcNavigate(screenId); });
        var entering = appOfScreen(screenId) === 'dreamcar';
        if (!entering) center.style.visibility = 'hidden';
        var pre = entering ? { screenId: screenId, promise: Promise.resolve().then(function () { return screens[screenId].load(); }) } : null;
        if (pre) pre.promise.then(function () {}, function () {});
        c.timer = setTimeout(function () { dcFailCurtain(c); }, 10000);
        traceNav('dreamcar cover ' + current + ' -> ' + screenId);
        dcFade(c, 1, 180, function () {
            if (c.phase === 'failed') return;
            c.phase = 'loading';
            openNow(screenId, pre);
        });
    }

    function dcReadyCurtain() {
        var c = dcCurtain;
        if (!c || c.screen !== current || c.phase !== 'loading') return;
        c.phase = 'preparing';
        // Layout and image decode must settle before revealing the current viewport.
        nextFrame(function () { nextFrame(function () {
            if (dcCurtain !== c) return;
            var bounds = wf.content.getBoundingClientRect();
            var waits = [];
            var wells = el.screen.querySelectorAll('.dc-well');
            for (var i = 0; i < wells.length; i++) {
                var r = wells[i].getBoundingClientRect();
                if (r.bottom > bounds.top && r.top < bounds.bottom && wells[i].dcReady) waits.push(wells[i].dcReady);
            }
            Promise.all(waits).then(function () {
                nextFrame(function () { nextFrame(function () {
                    if (dcCurtain !== c || c.phase !== 'preparing') return;
                    clearTimeout(c.timer);
                    c.phase = 'revealing';
                    c.root.classList.add('dc-revealing');
                    var fast = Date.now() - c.at < 400;
                    if (fast) c.root.classList.add('dc-reveal-fast');
                    traceNav('dreamcar ready ' + c.screen + ' +' + (Date.now() - c.at) + 'ms images ' + waits.length);
                    dcFade(c, 0, fast ? 300 : 500, function () {
                        dcStopCurtain();
                        traceNav('dreamcar revealed ' + current);
                    });
                }); });
            });
        }); });
    }

    // ---- Texts splash ----
    // The threads are already on this PC, so there is nothing to wait for. The veil is only ever on screen while the page behind it paints — long enough to
    // read as the app opening, short enough that a tap never seems to stall.
    var txCurtain = null;
    var TX_SPLASH_MIN_MS = 820;
    var TX_SPLASH_MAX_MS = 1800;

    function txCurtainStop() {
        var c = txCurtain;
        if (!c) return;
        clearTimeout(c.timer);
        clearTimeout(c.waitTimer);
        if (c.veil.parentNode) c.veil.parentNode.removeChild(c.veil);
        c.root.classList.remove('tx-covering');
        txCurtain = null;
        // A veil that comes down before its page is up is a tap that went nowhere; the log says
        // which stage it died in (ui/phone/diag/loadlog.cfg).
        if (c.phase !== 'revealing') traceNav('texts curtain dropped at ' + c.phase + ' for ' + c.screen);
    }

    function txCurtainFade(target, ms, done) {
        var c = txCurtain;
        if (!c) return;
        fadeVeil(c.veil, target, ms, function () { return txCurtain === c; }, done);
    }

    function txCurtainOpen(screenId) {
        txCurtainStop();
        ++openSeq;
        awaitOpen(screenId);
        var root = document.getElementById('app-root');
        var veil = node('div', 'tx-cover');
        veil.style.opacity = '0';
        var back = veil.appendChild(node('button', 'tx-cover-back', 'Back'));
        var center = veil.appendChild(node('div', 'tx-cover-center'));
        var bubble = center.appendChild(node('div', 'tx-cover-bubble'));
        bubble.appendChild(node('span', 'tx-cover-dot'));
        bubble.appendChild(node('span', 'tx-cover-dot'));
        bubble.appendChild(node('span', 'tx-cover-dot'));
        center.appendChild(node('div', 'tx-cover-brand', 'TEXTS'));
        var label = center.appendChild(node('div', 'tx-cover-label', 'Loading your conversations'));
        label.setAttribute('role', 'status');
        veil.appendChild(node('div', 'tx-cover-home'));
        root.appendChild(veil);
        root.classList.add('tx-covering');
        var c = txCurtain = { root: root, veil: veil, screen: screenId, phase: 'covering',
            at: Date.now(), timer: 0, waitTimer: 0, pending: false };
        onTap(back, function () { splashBack(txCurtainStop, screenId); });
        // The threads are read from the phone's own files; if that read is slower than this, the
        // page says so itself, so the veil never stays up past it.
        c.timer = setTimeout(function () {
            if (txCurtain !== c || c.phase === 'revealing') return;
            txSplashReveal();
        }, TX_SPLASH_MAX_MS);
        traceNav('texts cover ' + current + ' -> ' + screenId);
        txCurtainFade(1, 160, function () {
            var k = txCurtain;
            if (!k || k !== c) return;
            k.phase = 'loading';
            openNow(screenId, null);
            if (k.pending) txSplashReveal();
        });
    }

    function txSplashReveal() {
        var c = txCurtain;
        if (!c) return;
        if (c.phase !== 'loading') { c.pending = true; return; }
        var wait = TX_SPLASH_MIN_MS - (Date.now() - c.at);
        if (wait > 0) {
            if (!c.waitTimer) c.waitTimer = setTimeout(function () {
                c.waitTimer = 0;
                txSplashReveal();
            }, wait);
            return;
        }
        c.phase = 'preparing';
        nextFrame(function () { nextFrame(function () {
            var k = txCurtain;
            if (!k || k !== c || k.phase !== 'preparing') return;
            clearTimeout(k.timer);
            k.phase = 'revealing';
            traceNav('texts revealed +' + (Date.now() - k.at) + 'ms');
            txCurtainFade(0, 380, function () { txCurtainStop(); });
        }); });
    }

    function txSplashCheck() {
        var c = txCurtain;
        if (!c) return;
        // During the cover, `current` is still the page being left, and a poll of that page
        // asking here must not take the veil — and the open behind it — down.
        if (c.phase === 'covering') return;
        if (c.screen !== current) { txCurtainStop(); return; }
        if (c.phase !== 'loading') return;
        txSplashReveal();
    }

    // ---- Freelance splash ----
    // The board and the played character's career record come from two different places: the
    // service's board file and the game's own component. Opening Freelance therefore gets a real
    // loading cover in the visual language of a white professional network. It is played on every entry from outside the app,
    // never when an order detail opens inside it.
    var flCurtain = null;
    var FL_SPLASH_MIN_MS = 1040;
    var FL_SPLASH_MAX_MS = 2500;

    function flCoverGlyph() {
        var svg = glyphSvg('0 0 24 24');
        // Three connected people, the network mark of the cover.
        glyphShape(svg, 'path', {
            d: 'M6.5 8.1L17.5 8.1 12 17.3Z', fill: 'none', stroke: '#ffffff',
            'stroke-width': '1.2', 'stroke-linejoin': 'round', opacity: '0.62'
        });
        glyphShape(svg, 'circle', { cx: '6.5', cy: '8.1', r: '2.25', fill: '#ffffff' });
        glyphShape(svg, 'circle', { cx: '17.5', cy: '8.1', r: '2.25', fill: '#ffffff' });
        glyphShape(svg, 'circle', { cx: '12', cy: '17.3', r: '2.25', fill: '#ffffff' });
        return svg;
    }

    function flCoverRow(letter, color, category, second) {
        var row = node('div', 'fl-cover-row ' + (second ? 'second' : 'first'));
        var avatar = row.appendChild(node('div', 'fl-cover-avatar', letter));
        avatar.style.background = color;
        var plan = row.appendChild(node('div', 'fl-cover-plan'));
        plan.appendChild(node('div', 'fl-cover-cat', category));
        plan.appendChild(node('div', 'fl-cover-line wide'));
        plan.appendChild(node('div', 'fl-cover-line short'));
        row.appendChild(node('div', 'fl-cover-node'));
        return row;
    }

    function flCurtainStop() {
        var c = flCurtain;
        if (!c) return;
        clearTimeout(c.timer);
        clearTimeout(c.waitTimer);
        if (c.veil.parentNode) c.veil.parentNode.removeChild(c.veil);
        c.root.classList.remove('fl-covering');
        flCurtain = null;
        if (c.phase !== 'revealing') traceNav('freelance curtain dropped at ' + c.phase + ' for ' + c.screen);
    }

    function flCurtainFade(target, ms, done) {
        var c = flCurtain;
        if (!c) return;
        fadeVeil(c.veil, target, ms, function () { return flCurtain === c; }, done);
    }

    function flCurtainOpen(screenId) {
        flCurtainStop();
        ++openSeq;
        awaitOpen(screenId);
        var root = document.getElementById('app-root');
        var veil = node('div', 'fl-cover');
        veil.style.opacity = '0';
        var back = veil.appendChild(node('button', 'fl-cover-back', 'Back'));
        veil.appendChild(node('div', 'fl-cover-halo'));
        veil.appendChild(node('div', 'fl-cover-ring outer'));
        veil.appendChild(node('div', 'fl-cover-ring'));
        var center = veil.appendChild(node('div', 'fl-cover-center'));
        var card = center.appendChild(node('div', 'fl-cover-card'));
        var top = card.appendChild(node('div', 'fl-cover-top'));
        top.appendChild(node('div', 'fl-cover-mark')).appendChild(flCoverGlyph());
        var names = top.appendChild(node('div', 'fl-cover-names'));
        names.appendChild(node('div', 'fl-cover-brand', 'FREELANCE'));
        names.appendChild(node('div', 'fl-cover-kicker', 'CAREER NETWORK'));
        top.appendChild(node('div', 'fl-cover-live', 'OPEN'));
        card.appendChild(node('div', 'fl-cover-headline', 'Work that finds you.'));
        card.appendChild(node('div', 'fl-cover-sub', 'Matching open briefs to your skills and your day.'));
        var feed = card.appendChild(node('div', 'fl-cover-feed'));
        feed.appendChild(flCoverRow('D', 'linear-gradient(145deg, #2D8BE8 0%, #0A66C2 100%)', 'DELIVERY', false));
        feed.appendChild(flCoverRow('C', 'linear-gradient(145deg, #9A83DF 0%, #6E52BC 100%)', 'CREATIVE', true));
        feed.appendChild(node('div', 'fl-cover-sheen'));
        var status = card.appendChild(node('div', 'fl-cover-status'));
        status.appendChild(node('div', 'fl-cover-pulse'));
        var label = status.appendChild(node('div', 'fl-cover-label', 'Building your opportunity feed'));
        label.setAttribute('role', 'status');
        var steps = status.appendChild(node('div', 'fl-cover-steps'));
        steps.appendChild(node('div', 'fl-cover-step first'));
        steps.appendChild(node('div', 'fl-cover-step second'));
        steps.appendChild(node('div', 'fl-cover-step third'));
        veil.appendChild(node('div', 'fl-cover-home'));
        root.appendChild(veil);
        root.classList.add('fl-covering');
        var c = flCurtain = { root: root, veil: veil, screen: screenId, phase: 'covering',
            at: Date.now(), timer: null, waitTimer: 0, pending: false };
        onTap(back, function () { splashBack(flCurtainStop, screenId); });
        // The page can say on its own that the board is missing; the cover never holds it longer
        // than this while the game is busy or the Lua mod has not reported yet.
        c.timer = setTimeout(function () {
            if (flCurtain !== c || c.phase === 'revealing') return;
            flSplashReveal();
        }, FL_SPLASH_MAX_MS);
        traceNav('freelance cover ' + current + ' -> ' + screenId);
        flCurtainFade(1, 190, function () {
            var k = flCurtain;
            if (!k || k !== c) return;
            k.phase = 'loading';
            openNow(screenId, null);
            if (k.pending) flSplashReveal();
        });
    }

    function flSplashReveal() {
        var c = flCurtain;
        if (!c) return;
        if (c.phase !== 'loading') { c.pending = true; return; }
        var wait = FL_SPLASH_MIN_MS - (Date.now() - c.at);
        if (wait > 0) {
            if (!c.waitTimer) c.waitTimer = setTimeout(function () {
                c.waitTimer = 0;
                flSplashReveal();
            }, wait);
            return;
        }
        c.phase = 'preparing';
        // One paint lets the loaded page settle under the card before it fades away.
        nextFrame(function () { nextFrame(function () {
            var k = flCurtain;
            if (!k || k !== c || k.phase !== 'preparing') return;
            clearTimeout(k.timer);
            k.phase = 'revealing';
            traceNav('freelance revealed +' + (Date.now() - k.at) + 'ms');
            flCurtainFade(0, 420, function () { flCurtainStop(); });
        }); });
    }

    // Called when the page under the veil has drawn. As with Texts, a poll for the
    // page being left must not take this veil down before the open has landed.
    function flSplashCheck() {
        var c = flCurtain;
        if (!c) return;
        if (c.phase === 'covering') return;
        if (c.screen !== current) { flCurtainStop(); return; }
        if (c.phase !== 'loading') return;
        if (appOfScreen(current) !== 'freelance') { flCurtainStop(); return; }
        flSplashReveal();
    }

    // ---- News splash ----
    // Freelance borrows the language of a professional network; News borrows the language of a
    // printed morning edition. A warm paper sheet, a masthead, a front-page picture and ruled
    // type settle into place while the local edition is assembled. It plays on every entry from
    // outside the app, never when a story opens inside it.
    var nwCurtain = null;
    var NW_SPLASH_MIN_MS = 1080;
    var NW_SPLASH_MAX_MS = 2400;

    function nwCoverGlyph() {
        var svg = glyphSvg('0 0 24 24');
        glyphPath(svg, 'M4 4.2h13.2c1.5 0 2.8 1.2 2.8 2.8v12.8H6.8A2.8 2.8 0 0 1 4 17V4.2zm2.2 2.4v8.1h5.6V6.6H6.2zm7.6 0v3.1h3.8V6.6h-3.8zm0 5.2v2.9h3.8v-2.9h-3.8z', '#ffffff', 'evenodd');
        return svg;
    }

    function nwCoverLine(cls) {
        return node('div', 'nw-cover-line ' + (cls || ''));
    }

    function nwCurtainStop() {
        var c = nwCurtain;
        if (!c) return;
        clearTimeout(c.timer);
        clearTimeout(c.waitTimer);
        if (c.veil.parentNode) c.veil.parentNode.removeChild(c.veil);
        c.root.classList.remove('nw-covering');
        nwCurtain = null;
        if (c.phase !== 'revealing') traceNav('news curtain dropped at ' + c.phase + ' for ' + c.screen);
    }

    function nwCurtainFade(target, ms, done) {
        var c = nwCurtain;
        if (!c) return;
        fadeVeil(c.veil, target, ms, function () { return nwCurtain === c; }, done);
    }

    function nwCurtainOpen(screenId) {
        nwCurtainStop();
        ++openSeq;
        awaitOpen(screenId);
        var root = document.getElementById('app-root');
        var veil = node('div', 'nw-cover');
        veil.style.opacity = '0';
        var back = veil.appendChild(node('button', 'nw-cover-back', '< Back'));
        veil.appendChild(node('div', 'nw-cover-disc outer'));
        veil.appendChild(node('div', 'nw-cover-disc'));
        var center = veil.appendChild(node('div', 'nw-cover-center'));
        var paper = center.appendChild(node('div', 'nw-cover-paper'));
        var top = paper.appendChild(node('div', 'nw-cover-top'));
        top.appendChild(node('div', 'nw-cover-mark')).appendChild(nwCoverGlyph());
        var names = top.appendChild(node('div', 'nw-cover-names'));
        names.appendChild(node('div', 'nw-cover-brand', 'THE CITY DESK'));
        names.appendChild(node('div', 'nw-cover-kicker', 'INDEPENDENT MORNING EDITION'));
        top.appendChild(node('div', 'nw-cover-live', 'PREVIEW'));
        paper.appendChild(node('div', 'nw-cover-rule'));
        var edition = paper.appendChild(node('div', 'nw-cover-edition'));
        edition.appendChild(node('div', 'nw-cover-date', 'MORNING EDITION'));
        edition.appendChild(node('div', 'nw-cover-price', 'LOCAL · DAILY'));
        paper.appendChild(node('div', 'nw-cover-headline', 'The city, before it wakes.'));
        paper.appendChild(node('div', 'nw-cover-sub', 'The people, places and small changes shaping tomorrow.'));
        var front = paper.appendChild(node('div', 'nw-cover-front'));
        var art = nwArt({ art: 'city', cat: 'City' }, 'nw-cover-art');
        front.appendChild(art);
        var col = front.appendChild(node('div', 'nw-cover-col'));
        col.appendChild(nwCoverLine('strong'));
        col.appendChild(nwCoverLine('wide'));
        col.appendChild(nwCoverLine('wide'));
        col.appendChild(nwCoverLine('short'));
        col.appendChild(nwCoverLine('wide'));
        col.appendChild(nwCoverLine('mid'));
        paper.appendChild(node('div', 'nw-cover-columns'));
        paper.appendChild(node('div', 'nw-cover-rule thin'));
        var status = paper.appendChild(node('div', 'nw-cover-status'));
        status.appendChild(node('div', 'nw-cover-pulse'));
        var label = status.appendChild(node('div', 'nw-cover-status-label', 'Laying out the morning edition'));
        label.setAttribute('role', 'status');
        var steps = status.appendChild(node('div', 'nw-cover-steps'));
        steps.appendChild(node('div', 'nw-cover-step first'));
        steps.appendChild(node('div', 'nw-cover-step second'));
        steps.appendChild(node('div', 'nw-cover-step third'));
        veil.appendChild(node('div', 'nw-cover-home'));
        root.appendChild(veil);
        root.classList.add('nw-covering');
        var c = nwCurtain = { root: root, veil: veil, screen: screenId, phase: 'covering',
            at: Date.now(), timer: null, waitTimer: 0, pending: false };
        onTap(back, function () { splashBack(nwCurtainStop, screenId); });
        c.timer = setTimeout(function () {
            if (nwCurtain !== c || c.phase === 'revealing') return;
            nwSplashReveal();
        }, NW_SPLASH_MAX_MS);
        traceNav('news cover ' + current + ' -> ' + screenId);
        nwCurtainFade(1, 190, function () {
            var k = nwCurtain;
            if (!k || k !== c) return;
            k.phase = 'loading';
            openNow(screenId, null);
            if (k.pending) nwSplashReveal();
        });
    }

    function nwSplashReveal() {
        var c = nwCurtain;
        if (!c) return;
        if (c.phase !== 'loading') { c.pending = true; return; }
        var wait = NW_SPLASH_MIN_MS - (Date.now() - c.at);
        if (wait > 0) {
            if (!c.waitTimer) c.waitTimer = setTimeout(function () {
                c.waitTimer = 0;
                nwSplashReveal();
            }, wait);
            return;
        }
        c.phase = 'preparing';
        nextFrame(function () { nextFrame(function () {
            var k = nwCurtain;
            if (!k || k !== c || k.phase !== 'preparing') return;
            clearTimeout(k.timer);
            k.phase = 'revealing';
            traceNav('news revealed +' + (Date.now() - k.at) + 'ms');
            nwCurtainFade(0, 420, function () { nwCurtainStop(); });
        }); });
    }

    function nwSplashCheck() {
        var c = nwCurtain;
        if (!c) return;
        if (c.phase === 'covering') return;
        if (c.screen !== current) { nwCurtainStop(); return; }
        if (c.phase !== 'loading') return;
        if (appOfScreen(current) !== 'news') { nwCurtainStop(); return; }
        nwSplashReveal();
    }

    // ---- OA splash ----
    // OA reads the company, its member list and the rank ladder from the game before the
    // workbench can show. Its cover borrows the language of a company's own office suite signing
    // an employee in: the letterhead, the badge being checked, and the three steps of single
    // sign-on ticking off while the workbench loads. It plays on every entry from outside the
    // app, never between OA's own pages, and stays light in either theme.
    var oaCurtain = null;
    var OA_SPLASH_MIN_MS = 1150;
    var OA_SPLASH_MAX_MS = 2600;

    function oaCoverLock() {
        var svg = glyphSvg('0 0 24 24');
        glyphPath(svg, 'M7.5 10V7.6a4.5 4.5 0 0 1 9 0V10h.7c.9 0 1.6.7 1.6 1.6v7.2c0 .9-.7 1.6-1.6 1.6H6.8c-.9 0-1.6-.7-1.6-1.6v-7.2c0-.9.7-1.6 1.6-1.6h.7zm2 0h5V7.6a2.5 2.5 0 0 0-5 0V10z', '#2F6BFF', 'evenodd');
        return svg;
    }

    // One sign-on step: a grey ring while it waits, a turning arc on its turn, a tick once done.
    // Each layer runs one animation of its own (a timed fade in or out, or the turn), nested,
    // rather than one element with several: the game's view runs single animations reliably.
    function oaCoverStep(text, cls) {
        var row = node('div', 'oa-cover-step ' + cls);
        var mark = row.appendChild(node('div', 'oa-cover-tick'));
        mark.appendChild(node('div', 'oa-cover-wait'));
        mark.appendChild(node('div', 'oa-cover-turn-in'))
            .appendChild(node('div', 'oa-cover-turn-out'))
            .appendChild(node('div', 'oa-cover-turn'));
        mark.appendChild(node('div', 'oa-cover-check', '✓'));
        row.appendChild(node('div', 'oa-cover-step-text', text));
        return row;
    }

    function oaCurtainStop() {
        var c = oaCurtain;
        if (!c) return;
        clearTimeout(c.timer);
        clearTimeout(c.waitTimer);
        if (c.veil.parentNode) c.veil.parentNode.removeChild(c.veil);
        c.root.classList.remove('oa-covering');
        oaCurtain = null;
        if (c.phase !== 'revealing') traceNav('oa curtain dropped at ' + c.phase + ' for ' + c.screen);
    }

    function oaCurtainFade(target, ms, done) {
        var c = oaCurtain;
        if (!c) return;
        fadeVeil(c.veil, target, ms, function () { return oaCurtain === c; }, done);
    }

    function oaCurtainOpen(screenId) {
        oaCurtainStop();
        ++openSeq;
        awaitOpen(screenId);
        var root = document.getElementById('app-root');
        var veil = node('div', 'oa-cover');
        veil.style.opacity = '0';
        var back = veil.appendChild(node('button', 'oa-cover-back', '< Back'));
        veil.appendChild(node('div', 'oa-cover-band'));
        var center = veil.appendChild(node('div', 'oa-cover-center'));
        var head = center.appendChild(node('div', 'oa-cover-head'));
        head.appendChild(node('div', 'oa-cover-logo')).appendChild(appGlyph('oa'));
        var names = head.appendChild(node('div', 'oa-cover-names'));
        names.appendChild(node('div', 'oa-cover-brand', 'OA 协同办公'));
        names.appendChild(node('div', 'oa-cover-kicker', 'ENTERPRISE WORKSPACE'));
        var card = center.appendChild(node('div', 'oa-cover-card'));
        var badge = card.appendChild(node('div', 'oa-cover-badge'));
        badge.appendChild(node('div', 'oa-cover-photo'));
        var lines = badge.appendChild(node('div', 'oa-cover-id'));
        lines.appendChild(node('div', 'oa-cover-line name'));
        lines.appendChild(node('div', 'oa-cover-line role'));
        lines.appendChild(node('div', 'oa-cover-line no'));
        badge.appendChild(node('div', 'oa-cover-chip', '员工'));
        badge.appendChild(node('div', 'oa-cover-scan'));
        var steps = card.appendChild(node('div', 'oa-cover-steps'));
        steps.appendChild(oaCoverStep('验证员工身份', 'first'));
        steps.appendChild(oaCoverStep('同步组织架构', 'second'));
        steps.appendChild(oaCoverStep('载入工作台', 'third'));
        var label = card.appendChild(node('div', 'oa-cover-label', '正在为你登录…'));
        label.setAttribute('role', 'status');
        var foot = veil.appendChild(node('div', 'oa-cover-foot'));
        foot.appendChild(node('div', 'oa-cover-lock')).appendChild(oaCoverLock());
        foot.appendChild(node('div', 'oa-cover-secure', '企业级安全登录 · 数据只存在本机'));
        veil.appendChild(node('div', 'oa-cover-home'));
        root.appendChild(veil);
        root.classList.add('oa-covering');
        var c = oaCurtain = { root: root, veil: veil, screen: screenId, phase: 'covering',
            at: Date.now(), timer: null, waitTimer: 0, pending: false };
        onTap(back, function () { splashBack(oaCurtainStop, screenId); });
        // The workbench says on its own when the game cannot be read; the cover never holds it
        // longer than this.
        c.timer = setTimeout(function () {
            if (oaCurtain !== c || c.phase === 'revealing') return;
            oaSplashReveal();
        }, OA_SPLASH_MAX_MS);
        traceNav('oa cover ' + current + ' -> ' + screenId);
        oaCurtainFade(1, 190, function () {
            var k = oaCurtain;
            if (!k || k !== c) return;
            k.phase = 'loading';
            openNow(screenId, null);
            if (k.pending) oaSplashReveal();
        });
    }

    function oaSplashReveal() {
        var c = oaCurtain;
        if (!c) return;
        if (c.phase !== 'loading') { c.pending = true; return; }
        var wait = OA_SPLASH_MIN_MS - (Date.now() - c.at);
        if (wait > 0) {
            if (!c.waitTimer) c.waitTimer = setTimeout(function () {
                c.waitTimer = 0;
                oaSplashReveal();
            }, wait);
            return;
        }
        c.phase = 'preparing';
        // The last step ticks off before the cover lifts, so the sign-in reads as finished.
        c.veil.classList.add('oa-cover-done');
        var label = c.veil.querySelector('.oa-cover-label');
        if (label) label.textContent = '登录成功，欢迎回来';
        setTimeout(function () { nextFrame(function () { nextFrame(function () {
            var k = oaCurtain;
            if (!k || k !== c || k.phase !== 'preparing') return;
            clearTimeout(k.timer);
            k.phase = 'revealing';
            traceNav('oa revealed +' + (Date.now() - k.at) + 'ms');
            oaCurtainFade(0, 420, function () { oaCurtainStop(); });
        }); }); }, 260);
    }

    // Called when the page under the veil has drawn. A poll of the page being left must not take
    // the veil down before the open has landed.
    function oaSplashCheck() {
        var c = oaCurtain;
        if (!c) return;
        if (c.phase === 'covering') return;
        if (c.screen !== current) { oaCurtainStop(); return; }
        if (c.phase !== 'loading') return;
        if (appOfScreen(current) !== 'oa') { oaCurtainStop(); return; }
        oaSplashReveal();
    }

    function dcColorFile(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.png'; }

    function dcKind(row) {
        var id = row._row_name;
        if (row.type === 'Car') return 'car';
        if (row.type === 'Bicycle') return 'bike';
        if (/^ScramblerBike/.test(id)) return 'moto';
        return 'scooter';
    }

    function dcMoney(n) {
        var s = String(Math.round(Number(n) || 0));
        var out = '';
        while (s.length > 3) {
            out = ',' + s.slice(-3) + out;
            s = s.slice(0, -3);
        }
        return '₼' + s + out;
    }

    function dcHex(c) {
        var h = String((c && c.uIHexColor) || '#888888');
        return h.length === 9 ? h.slice(0, 7) : h;
    }

    // Vehicles the game sells (purchasableLevel), cheapest first; read once per session.
    function dcLoadCatalog() {
        if (dcCatalog) return Promise.resolve(dcCatalog);
        if (dcCatalogLoading) return dcCatalogLoading;
        dcCatalogLoading = call('data.table_get_all', { Alias: 'Vehicle' }).then(function (rows) {
            var list = (Array.isArray(rows) ? rows : []).filter(function (r) {
                return r && (r.purchasableLevel || []).length && r.type !== 'Invalid' && r.type !== 'Ship';
            });
            var keys = [];
            list.forEach(function (r) { keys.push(r.displayNameTextId, r.descriptionTextId); });
            return localize(keys).then(function (l10n) {
                var cars = list.map(function (r) {
                    return {
                        id: r._row_name,
                        name: l10n[r.displayNameTextId] || r._row_name,
                        about: l10n[r.descriptionTextId] || '',
                        price: Number(r.price) || 0,
                        type: r.type,
                        kind: dcKind(r),
                        template: r.vehicleTemplateId || '',
                        used: /_Used$/.test(r._row_name),
                        hyundai: !!DC_HYUNDAI[r._row_name],
                        electric: /^IONIQ|^ElectricScooter|^MopedBike/.test(r._row_name),
                        hydrogen: r._row_name === 'NEXO',
                        colors: (r.color || []).map(function (c) { return { id: c.colorId, hex: dcHex(c) }; })
                    };
                });
                cars.sort(function (a, b) { return a.price - b.price; });
                dcCatalog = cars;
                return cars;
            });
        }).then(function (cars) {
            dcCatalogLoading = null;
            return cars;
        }, function (err) {
            dcCatalogLoading = null;
            throw err;
        });
        return dcCatalogLoading;
    }

    function dcCar(id) {
        var list = dcCatalog || [];
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    }

    // Doors, from the vehicle's template (cars only), read when its page first opens.
    function dcLoadDoors(car) {
        if (!car || car.kind !== 'car' || !car.template || car.id in dcDoors) return Promise.resolve();
        return soft(call('data.table_get', { Alias: 'VehicleTemplate', Row: car.template })).then(function (t) {
            var n = 0;
            ((t && t.partList) || []).forEach(function (p) { if (/Door$/.test(String(p.partType || ''))) n++; });
            dcDoors[car.id] = n;
        });
    }

    // What a character owns, from the character itself.
    function dcOwned(id) {
        return soft(call('entity.reflect', { entity_id: String(id) })).then(function (r) {
            var o = r && ((r.vehicleContext && r.vehicleContext.ownedVehicle) || r.ownedVehicle);
            var dt = o && o.vehicleDtId && o.vehicleDtId !== 'None' ? String(o.vehicleDtId) : '';
            return dt ? { id: dt, color: o.colorId && o.colorId !== 'None' ? String(o.colorId) : '' } : null;
        });
    }

    function loadDreamCar() {
        return Promise.all([soft(getEnv()), getPossessedId(), getMembers(), dcLoadCatalog()]).then(function (r) {
            var me = r[1];
            var members = r[2] || [];
            var householdId = '';
            members.forEach(function (m) { if (String(m.entity_id) === me && m.household_id !== undefined) householdId = String(m.household_id); });
            if (!householdId && members[0] && members[0].household_id !== undefined) householdId = String(members[0].household_id);
            return Promise.all([
                householdId ? soft(call('entity.reflect', { entity_id: householdId, Component: 'Currency' })) : Promise.resolve(null),
                Promise.all(members.map(function (m) { return dcOwned(m.entity_id); })),
                dcLoadDoors(dcCar(dcOpenId))
            ]).then(function (d) {
                var money = d[0] && d[0].currencyMap && typeof d[0].currencyMap.mew === 'number' ? d[0].currencyMap.mew : null;
                var owned = {};
                members.forEach(function (m, i) { if (d[1][i]) owned[String(m.entity_id)] = d[1][i]; });
                var self = null;
                members.forEach(function (m) { if (String(m.entity_id) === me) self = m; });
                var data = { env: r[0] && !r[0].error ? r[0] : {}, me: me, self: self, members: members, money: money, owned: owned, cars: r[3] };
                return data;
            });
        });
    }

    // ---- photos ----
    // The photo of a colour when it was captured, else the vehicle's list photo. Which files exist
    // is learned once per file with an Image, so a redraw always draws the same picture.
    function dcPicUrl(car, colorId) {
        var exact = colorId ? 'cars/' + car.id + '/' + dcColorFile(colorId) : '';
        if (exact && dcPicKnown[exact] === true) return exact;
        return 'cars/' + car.id + '.png';
    }

    function dcProbe(url) {
        if (dcPicLoads[url]) return dcPicLoads[url];
        dcPicLoads[url] = new Promise(function (resolve) {
            var img = new Image();
            var settled = false;
            var timer = setTimeout(function () { finish(false); }, 4000);
            function finish(ok) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                dcPicKnown[url] = ok;
                img.onload = img.onerror = null;
                resolve(ok);
            }
            img.onload = function () {
                if (typeof img.decode === 'function') img.decode().then(function () { finish(true); }, function () { finish(true); });
                else finish(true);
            };
            img.onerror = function () { finish(false); };
            img.src = url;
        });
        return dcPicLoads[url];
    }

    // large: a well wider than the list photo, where that photo is drawn near its own size.
    function dcWell(car, colorId, badges, large) {
        var well = node('div', 'dc-well');
        var url = dcPicUrl(car, colorId);
        var pic = node('div', 'dc-pic' + (large && url === 'cars/' + car.id + '.png' ? ' small' : ''));
        if (dcPicKnown[url]) pic.style.backgroundImage = 'url("' + url + '")';
        well.appendChild(pic);
        var exact = colorId ? 'cars/' + car.id + '/' + dcColorFile(colorId) : '';
        var fallback = 'cars/' + car.id + '.png';
        well.dcReady = (exact ? dcProbe(exact) : Promise.resolve(false)).then(function (ok) {
            if (ok) return exact;
            return dcProbe(fallback).then(function (found) { return found ? fallback : ''; });
        }).then(function (readyUrl) {
            if (!readyUrl) {
                well.appendChild(node('div', 'dc-photo-missing', 'Image unavailable'));
                return;
            }
            pic.className = 'dc-pic' + (large && readyUrl === fallback ? ' small' : '');
            var background = 'url("' + readyUrl + '")';
            if (!dcCurtain && pic.style.backgroundImage && pic.style.backgroundImage !== background) {
                var incoming = node('div', pic.className);
                incoming.style.backgroundImage = background;
                incoming.style.opacity = '0';
                well.insertBefore(incoming, pic.nextSibling);
                nextFrame(function () { incoming.style.opacity = '1'; });
                setTimeout(function () { if (pic.parentNode) pic.parentNode.removeChild(pic); }, 300);
            } else pic.style.backgroundImage = background;
        });
        if (badges && badges.length) {
            var row = well.appendChild(node('div', 'dc-badges'));
            badges.forEach(function (b) { row.appendChild(node('div', 'dc-badge' + (b.cls ? ' ' + b.cls : ''), b.text)); });
        }
        return well;
    }

    function dcBadges(car, featured) {
        var out = [];
        if (featured) out.push({ text: 'FEATURED', cls: 'hot' });
        if (car.used) out.push({ text: 'PRE-OWNED', cls: 'used' });
        else if (car.hydrogen) out.push({ text: 'HYDROGEN', cls: 'eco' });
        else if (car.electric) out.push({ text: 'ELECTRIC', cls: 'eco' });
        return out.slice(0, 2);
    }

    function dcRerender() {
        if (dcCurtain) return;
        if (!dcLastData || appOfScreen(current) !== 'dreamcar') return;
        var view = screens[current] && screens[current].render;
        if (!view) return;
        var scrollTop = wf.content.scrollTop;
        show(view(dcLastData));
        wf.content.scrollTop = scrollTop;
    }

    // ---- showroom ----
    function dcHeader(data, title, sub) {
        var frag = node('div');
        var brand = frag.appendChild(node('div', 'dc-brand'));
        brand.appendChild(node('div', 'dc-brand-mark', 'DREAM CAR'));
        var env = data.env || {};
        brand.appendChild(node('div', 'dc-brand-day', [env.day_of_week, env.season].filter(Boolean).join(' · ').toUpperCase()));
        frag.appendChild(node('div', 'dc-hero-title', title));
        if (sub) frag.appendChild(node('div', 'dc-hero-sub', sub));
        return frag;
    }

    function dcSegment() {
        var seg = node('div', 'dc-seg');
        [{ id: 'showroom', label: 'Showroom', screen: 'dreamcar' }, { id: 'garage', label: 'Garage', screen: 'dcgarage' }].forEach(function (t) {
            var item = seg.appendChild(node('div', 'dc-seg-item' + (dcTab === t.id ? ' on' : ''), t.label));
            onTap(item, function (e) {
                e.stopPropagation();
                if (dcTab === t.id) return;
                dcTab = t.id;
                open(t.screen);
            });
        });
        return seg;
    }

    function dcWallet(data) {
        var w = node('div', 'dc-wallet');
        var main = w.appendChild(node('div', 'dc-wallet-main'));
        main.appendChild(node('div', 'dc-wallet-label', 'HOUSEHOLD FUNDS'));
        main.appendChild(node('div', 'dc-wallet-value', data.money === null ? '—' : dcMoney(data.money)));
        var side = w.appendChild(node('div', 'dc-wallet-side'));
        side.appendChild(node('div', 'dc-wallet-who', data.self ? fullName(data.self) : 'You'));
        var mine = data.owned[data.me];
        var car = mine ? dcCar(mine.id) : null;
        side.appendChild(node('div', 'dc-wallet-ride' + (mine ? '' : ' none'), mine ? (car ? car.name : mine.id) : 'No vehicle yet'));
        return w;
    }

    function dcFit(data, car) {
        if (data.money === null) return null;
        var short = car.price - data.money;
        var fit = node('div', 'dc-tile-fit' + (short > 0 ? ' short' : ''));
        fit.appendChild(node('span', 'dc-fit-dot'));
        fit.appendChild(node('span', null, short > 0 ? dcMoney(short) + ' short' : 'In your budget'));
        return fit;
    }

    function dcOpenCar(car) {
        dcOpenId = car.id;
        dcConfirm = false;
        if (dcBuy && dcBuy.carId !== car.id && dcBuy.state !== 'running') dcBuy = null;
        open('dccar');
    }

    // The featured vehicle changes with the game day: one of the licensed models.
    function dcFeatured(cars, env) {
        var picks = cars.filter(function (c) { return c.hyundai; });
        if (!picks.length) picks = cars.filter(function (c) { return c.kind === 'car'; });
        if (!picks.length) return null;
        var day = Number(env && (env.day || env.days || env.total_days)) || 0;
        return picks[Math.abs(day) % picks.length];
    }

    function renderDreamCar(data) {
        dcLastData = data;
        dcTab = 'showroom';
        var wrap = node('div', 'dc');
        wrap.appendChild(subHeader('dreamcar'));
        wrap.appendChild(dcHeader(data, 'Find the one.', data.cars.length + ' vehicles in stock, from bicycles to SUVs.'));
        wrap.appendChild(dcSegment());
        wrap.appendChild(dcWallet(data));

        var feat = dcFeatured(data.cars, data.env);
        if (feat && dcFilter === 'all') {
            var f = node('div', 'dc-feature');
            f.appendChild(dcWell(feat, dcColor[feat.id], dcBadges(feat, true), true));
            var body = f.appendChild(node('div', 'dc-feature-body'));
            var text = body.appendChild(node('div', 'dc-feature-text'));
            text.appendChild(node('div', 'dc-feature-kicker', feat.hyundai ? 'HYUNDAI' : DC_KIND_LABEL[feat.kind]));
            text.appendChild(node('div', 'dc-feature-name', feat.name));
            text.appendChild(node('div', 'dc-feature-price', 'From ' + dcMoney(feat.price) + ' · ' + feat.colors.length + ' colours'));
            body.appendChild(node('div', 'dc-cta', 'Explore'));
            onTap(f, function (e) {
                e.stopPropagation();
                dcOpenCar(feat);
            });
            wrap.appendChild(f);
        }

        var chips = node('div', 'dc-chips');
        DC_KINDS.forEach(function (k) {
            var chip = chips.appendChild(node('div', 'dc-chip' + (dcFilter === k.id ? ' on' : ''), k.label));
            onTap(chip, function (e) {
                e.stopPropagation();
                dcFilter = k.id;
                dcRerender();
            });
        });
        wrap.appendChild(chips);

        var shown = data.cars.filter(function (c) { return dcFilter === 'all' || c.kind === dcFilter; });
        var title = DC_KINDS.filter(function (k) { return k.id === dcFilter; })[0];
        var sec = wrap.appendChild(node('div', 'dc-sec'));
        sec.appendChild(node('div', 'dc-sec-title', dcFilter === 'all' ? 'All vehicles' : title.label));
        sec.appendChild(node('div', 'dc-sec-sub', shown.length + ' · price low to high'));
        var grid = wrap.appendChild(node('div', 'dc-grid'));
        shown.forEach(function (car) {
            var tile = grid.appendChild(node('div', 'dc-tile'));
            tile.appendChild(dcWell(car, dcColor[car.id], dcBadges(car, false).slice(0, 1)));
            var b = tile.appendChild(node('div', 'dc-tile-body'));
            b.appendChild(node('div', 'dc-tile-kind', car.hyundai ? 'HYUNDAI' : DC_KIND_LABEL[car.kind]));
            b.appendChild(node('div', 'dc-tile-name', car.name));
            b.appendChild(node('div', 'dc-tile-price', dcMoney(car.price)));
            var fit = dcFit(data, car);
            if (fit) b.appendChild(fit);
            var sw = b.appendChild(node('div', 'dc-tile-swatches'));
            car.colors.slice(0, 8).forEach(function (c) { sw.appendChild(node('span', 'dc-mini')).style.background = c.hex; });
            onTap(tile, function (e) {
                e.stopPropagation();
                dcOpenCar(car);
            });
        });
        if (!shown.length) wrap.appendChild(node('div', 'dc-empty', 'Nothing in this category right now.'));
        wrap.appendChild(node('div', 'dc-foot', 'Prices and stock from the game’s own car dealer. One vehicle per person; it is delivered to your home.'));
        return wrap;
    }

    // ---- vehicle page ----
    // Why the played character cannot buy this one now, or '' when they can.
    function dcBlocker(data, car) {
        if (data.self && DC_TOO_YOUNG[data.self.age_group]) return { text: 'Too young to buy a vehicle', why: fullName(data.self) + ' is too young. An adult in the family can buy one.' };
        var mine = data.owned[data.me];
        if (mine) {
            var have = dcCar(mine.id);
            if (mine.id === car.id) return { text: 'You own this one', why: 'It is already in your garage.' };
            return { text: 'One vehicle per person', why: 'You already own ' + (have ? have.name : mine.id) + '. The dealer sells one vehicle per person.' };
        }
        if (data.money !== null && car.price > data.money) return { text: 'Not enough funds', why: 'You need ' + dcMoney(car.price - data.money) + ' more.' };
        return null;
    }

    function dcSpec(label, value) {
        var row = node('div', 'dc-spec');
        row.appendChild(node('div', 'dc-spec-label', label));
        row.appendChild(node('div', 'dc-spec-value', value));
        return row;
    }

    function renderDreamCarCar(data) {
        dcLastData = data;
        var wrap = node('div', 'dc');
        var car = dcCar(dcOpenId);
        wrap.appendChild(subHeader('dccar', car ? car.name : 'Vehicle'));
        if (!car) {
            wrap.appendChild(node('div', 'dc-empty', 'This vehicle is no longer for sale.'));
            return wrap;
        }
        var colorId = dcColor[car.id] || (car.colors[0] && car.colors[0].id) || '';
        var stage = wrap.appendChild(node('div', 'dc-stage'));
        stage.appendChild(dcWell(car, colorId, dcBadges(car, false), true));

        var titleRow = wrap.appendChild(node('div', 'dc-title-row'));
        var main = titleRow.appendChild(node('div', 'dc-title-main'));
        main.appendChild(node('div', 'dc-kicker', car.hyundai ? 'HYUNDAI' : DC_KIND_LABEL[car.kind]));
        main.appendChild(node('div', 'dc-name', car.name));
        var tags = main.appendChild(node('div', 'dc-tags'));
        [car.used ? 'Pre-owned' : 'New', car.hydrogen ? 'Hydrogen' : car.electric ? 'Electric' : '', car.colors.length + ' colours']
            .filter(Boolean).forEach(function (t) { tags.appendChild(node('div', 'dc-tag', t)); });
        var priceBlock = titleRow.appendChild(node('div', 'dc-price-block'));
        priceBlock.appendChild(node('div', 'dc-price', dcMoney(car.price)));
        if (data.money !== null) {
            var left = data.money - car.price;
            priceBlock.appendChild(node('div', 'dc-price-note' + (left < 0 ? ' short' : ''), left < 0 ? dcMoney(-left) + ' short' : dcMoney(left) + ' left after'));
        }

        // Colour.
        var paint = wrap.appendChild(node('div', 'dc-panel'));
        var head = paint.appendChild(node('div', 'dc-panel-head'));
        head.appendChild(node('div', 'dc-panel-title', 'COLOUR'));
        head.appendChild(node('div', 'dc-panel-value', colorId));
        var sw = paint.appendChild(node('div', 'dc-swatches'));
        car.colors.forEach(function (c) {
            var s = sw.appendChild(node('div', 'dc-swatch' + (c.id === colorId ? ' on' : '')));
            s.style.background = c.hex;
            onTap(s, function (e) {
                e.stopPropagation();
                if (dcBuy && dcBuy.state === 'running') return;
                dcColor[car.id] = c.id;
                dcConfirm = false;
                dcRerender();
            });
        });

        // About and specs.
        var about = wrap.appendChild(node('div', 'dc-panel'));
        about.appendChild(node('div', 'dc-panel-title', 'ABOUT'));
        about.appendChild(node('div', 'dc-about', car.about || 'A ' + DC_KIND_LABEL[car.kind].toLowerCase() + ' from the city’s dealer.'));
        var specs = wrap.appendChild(node('div', 'dc-panel'));
        specs.appendChild(node('div', 'dc-panel-title', 'AT A GLANCE'));
        specs.appendChild(dcSpec('Type', { car: 'Car', moto: 'Motorbike', scooter: 'Scooter', bike: 'Bicycle' }[car.kind]));
        specs.appendChild(dcSpec('Condition', car.used ? 'Pre-owned' : 'New'));
        if (car.hyundai) specs.appendChild(dcSpec('Make', 'Hyundai'));
        if (dcDoors[car.id]) specs.appendChild(dcSpec('Doors', String(dcDoors[car.id])));
        specs.appendChild(dcSpec('Drive', car.hydrogen ? 'Hydrogen fuel cell' : car.electric ? 'Electric' : car.kind === 'bike' ? 'Pedal power' : 'Petrol'));
        specs.appendChild(dcSpec('Delivery', 'To your home'));

        wrap.appendChild(dcBuyArea(data, car, colorId));
        return wrap;
    }

    // ---- buying ----
    function dcBuyArea(data, car, colorId) {
        var box = node('div');
        var b = dcBuy && dcBuy.carId === car.id ? dcBuy : null;
        if (b && b.state === 'running') {
            var sheet = box.appendChild(node('div', 'dc-sheet'));
            sheet.appendChild(node('div', 'dc-sheet-title', 'Buying ' + car.name + '…'));
            var steps = sheet.appendChild(node('div', 'dc-steps'));
            DC_STEPS.forEach(function (label, i) {
                var st = steps.appendChild(node('div', 'dc-step' + (i < b.step ? ' done' : i === b.step ? ' now' : '')));
                st.appendChild(node('span', 'dc-step-mark'));
                st.appendChild(node('span', null, label));
            });
            box.appendChild(node('div', 'dc-buy-why', 'The city’s dealer opens on the game’s phone for a moment to take your order.'));
            return box;
        }
        if (b && b.state === 'done') {
            var done = box.appendChild(node('div', 'dc-done'));
            done.appendChild(node('div', 'dc-done-title', 'It’s yours.'));
            done.appendChild(node('div', 'dc-done-sub', car.name + ' in ' + (b.color || colorId) + ', paid ' + dcMoney(car.price) + '. It waits for you at home.'));
            var g = box.appendChild(node('div', 'dc-alt', 'See it in your garage'));
            onTap(g, function (e) {
                e.stopPropagation();
                dcBuy = null;
                dcTab = 'garage';
                open('dcgarage');
            });
            return box;
        }
        if (b && b.state === 'failed') {
            var fail = box.appendChild(node('div', 'dc-fail'));
            fail.appendChild(node('div', 'dc-fail-title', 'The purchase did not go through'));
            fail.appendChild(node('div', 'dc-fail-sub', b.why || 'The game did not hand over the vehicle.'));
        }
        var block = dcBlocker(data, car);
        if (block) {
            box.appendChild(node('div', 'dc-buy off', block.text));
            box.appendChild(node('div', 'dc-buy-why', block.why));
            return box;
        }
        if (dcConfirm) {
            var s = box.appendChild(node('div', 'dc-sheet'));
            s.appendChild(node('div', 'dc-sheet-title', 'Confirm your order'));
            var line = function (label, value, cls) {
                var l = s.appendChild(node('div', 'dc-sheet-line' + (cls ? ' ' + cls : '')));
                l.appendChild(node('span', null, label));
                l.appendChild(node('b', null, value));
            };
            line('Vehicle', car.name);
            line('Colour', colorId);
            line('Buyer', data.self ? fullName(data.self) : 'You');
            if (data.money !== null) line('Funds after', dcMoney(data.money - car.price));
            line('Total', dcMoney(car.price), 'total');
            var row = s.appendChild(node('div', 'dc-sheet-row'));
            var cancel = row.appendChild(node('div', 'dc-sheet-btn', 'Cancel'));
            var go = row.appendChild(node('div', 'dc-sheet-btn go', 'Buy now'));
            onTap(cancel, function (e) {
                e.stopPropagation();
                dcConfirm = false;
                dcRerender();
            });
            onTap(go, function (e) {
                e.stopPropagation();
                dcConfirm = false;
                dcStartBuy(data, car, colorId);
            });
            return box;
        }
        var buy = box.appendChild(node('div', 'dc-buy', 'Buy for ' + dcMoney(car.price)));
        onTap(buy, function (e) {
            e.stopPropagation();
            dcConfirm = true;
            dcRerender();
        });
        box.appendChild(node('div', 'dc-buy-why', 'Paid from the household funds. One vehicle per person.'));
        return box;
    }

    // A purchase goes through the game's own dealer: its phone is opened on the car app, the
    // vehicle and colour are picked there and its Buy is confirmed, so the game itself checks the
    // buyer, takes the money and delivers the vehicle (no mod can send the game's purchase request).
    // The game's phone shows for a few seconds while this runs and is closed again afterwards.
    // Clicks call the buttons directly (force), since this phone may lie over the game's.
    var DC_STEPS = ['Opening the dealer', 'Paying', 'Handing over the keys'];
    var DC_POLL_MS = 250;
    var DC_WAIT_MS = 5000;

    function dcSleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    // What the last purchase went through, step by step, kept in vehicle/buylog.cfg.
    var dcTrace = [];
    function dcLog(s) { dcTrace.push(new Date().toISOString().slice(11, 19) + ' ' + s); }

    function dcWalk(n, fn) {
        if (!n || typeof n !== 'object') return;
        fn(n);
        Object.keys(n).forEach(function (k) { if (Array.isArray(n[k])) n[k].forEach(function (c) { dcWalk(c, fn); }); });
    }

    function dcFind(tree, re) {
        var hit = null;
        dcWalk(tree, function (n) { if (!hit && n.ref && re.test(n.ref)) hit = n; });
        return hit;
    }

    function dcAll(tree, re) {
        var out = [];
        dcWalk(tree, function (n) { if (n.ref && re.test(n.ref)) out.push(n); });
        return out;
    }

    function dcClick(ref) { return call('ui.click', { ref: ref, Force: true }); }

    function dcPhoneOpen() {
        return call('ui.list_windows', {}).then(function (w) {
            return ((w && w.windows) || []).some(function (x) { return x.ui_type === 'Smartphone'; });
        });
    }

    function dcPhoneTree() { return soft(call('ui.get_tree', { Window: 'Smartphone', max_nodes: 3000 })); }

    // The first widget matching re on the game's phone, waited for; fails with why.
    function dcWaitFor(re, why, ms) {
        var until = Date.now() + (ms || DC_WAIT_MS);
        return (function poll() {
            return dcPhoneTree().then(function (t) {
                var n = dcFind(t, re);
                if (n) return n;
                if (Date.now() > until) throw new Error(why);
                return dcSleep(DC_POLL_MS).then(poll);
            });
        })();
    }

    // The open game popup whose id passes test, waited for; null when none came.
    function dcWaitPopup(test, ms) {
        var until = Date.now() + (ms || DC_WAIT_MS);
        return (function poll() {
            return soft(call('ui.get_blocking', {})).then(function (b) {
                var hit = null;
                ((b && b.popups) || []).forEach(function (p) { if (!hit && test(p)) hit = p; });
                if (hit) return hit;
                if (Date.now() > until) return null;
                return dcSleep(DC_POLL_MS).then(poll);
            });
        })();
    }

    function dcIsVehiclePopup(p) { return /Vehicle/i.test(String(p.popup_id || '')); }

    // The game's phone, on its car app's Buy tab.
    function dcOpenDealer() {
        return dcPhoneOpen().then(function (isOpen) {
            if (isOpen) return null;
            return call('ui.find', { Window: 'Hud', Name: 'BW_Button_SmartPhone' }).then(function (hits) {
                var btn = (Array.isArray(hits) ? hits : []).filter(function (h) { return h.ref; })[0];
                if (!btn) throw new Error('The game’s phone button is not on screen.');
                return dcClick(btn.ref);
            });
        }).then(function () {
            return dcWaitFor(/(WBP_Mobile_AppIcon_Car\/BW_Button|BW_WBP_CarButton_Buy\/BW_Button_Car|WBP_Mobile_Car_Detail\/BW_Button_Back)$/, 'The game’s phone did not open.');
        }).then(function () {
            return dcPhoneTree();
        }).then(function (t) {
            var back = dcFind(t, /WBP_Mobile_Car_Detail\/BW_Button_Back$/);
            if (back && back.rect) return dcClick(back.ref).then(function () { return dcSleep(600); }).then(dcPhoneTree);
            return t;
        }).then(function (t) {
            var app = dcFind(t, /WBP_Mobile_AppIcon_Car\/BW_Button$/);
            if (app && !dcFind(t, /BW_WBP_CarButton_Buy\/BW_Button_Car$/)) return dcClick(app.ref);
            return null;
        }).then(function () {
            return dcWaitFor(/BW_WBP_CarButton_Buy\/BW_Button_Car$/, 'The game’s car app did not open.');
        }).then(function (tab) {
            return dcClick(tab.ref);
        }).then(function () {
            return dcWaitFor(/BW_TileView_CarSlot$/, 'The game’s car list did not open.');
        });
    }

    // Scrolls the game's car list to the vehicle's card and presses its 购买, which opens the
    // vehicle's own screen. Cards carry the vehicle's display name, the same text as car.name.
    // The list shows three rows of two; it is moved one row at a time, counted here, up to the
    // largest offset the list reports.
    function dcOpenCard(list, car) {
        var listRef = list.ref;
        var offset = 0;
        var max = null;
        return call('ui.scroll', { ref: listRef, To: 'start' }).then(function () {
            return (function look() {
                return dcSleep(400).then(function () {
                    return call('ui.find', { Window: 'Smartphone', Role: 'entry', Text: car.name, Limit: 20 });
                }).then(function (hits) {
                    var card = null;
                    (Array.isArray(hits) ? hits : []).forEach(function (e) {
                        if (!card && e.ref && String(e.text || '').trim() === car.name && e.ref.indexOf(listRef + '/') === 0) card = e;
                    });
                    dcLog('look offset=' + offset + ' max=' + max + ' hits=' + snippet(hits));
                    if (card) return dcClick(card.ref + '/BW_Button_Common/BW_Button');
                    if (max !== null && offset >= max) throw new Error('The game’s dealer does not list ' + car.name + '.');
                    offset += 2;
                    return call('ui.scroll', { ref: listRef, To: 'offset', Offset: offset }).then(function (r) {
                        if (r && typeof r.max === 'number') max = r.max;
                        if (max !== null && offset > max) offset = max;
                        if (max === null && offset > 60) throw new Error('The game’s car list does not scroll.');
                        dcLog('scroll ' + snippet(r));
                    }).then(look);
                });
            })();
        }).then(function () {
            return dcWaitFor(/WBP_Mobile_Car_Detail\/BW_Button_Buy\/BW_Button$/, 'The game’s dealer did not open ' + car.name + '.');
        });
    }

    // Picks the colour on the vehicle's screen: its swatches are in the table's colour order. The
    // swatches are built a moment after the screen's Buy button, so they are waited for.
    function dcPickColor(car, colorId) {
        var idx = -1;
        car.colors.forEach(function (c, i) { if (c.id === colorId) idx = i; });
        if (idx < 0) return Promise.resolve();
        var until = Date.now() + DC_WAIT_MS;
        return (function poll() {
            return dcPhoneTree().then(function (t) {
                var sw = dcAll(t, /WBP_Mobile_Car_Detail\/.*WBP_ColorPalette_Slot02_C_\d+\/BW_Button$/).filter(function (n) { return n.rect; });
                if (sw.length < car.colors.length && Date.now() < until) return dcSleep(DC_POLL_MS).then(poll);
                dcLog('swatches ' + sw.length + '/' + car.colors.length + ' pick ' + idx);
                sw.sort(function (a, b) { return a.rect[0] - b.rect[0]; });
                if (!sw[idx]) throw new Error('The game’s dealer does not offer ' + colorId + ' here.');
                return dcClick(sw[idx].ref).then(function () { return dcSleep(400); });
            });
        })();
    }

    // Buy, then the game's confirmation, then its answer: the success popup, or any other vehicle
    // popup, whose text is the game's reason.
    function dcConfirmOrder(buyRef) {
        return dcClick(buyRef).then(function () {
            return dcWaitPopup(dcIsVehiclePopup);
        }).then(function (p) {
            if (!p) throw new Error('The game’s dealer did not ask to confirm the order.');
            if (p.popup_id !== 'VehiclePurchaseConfirm') return p;
            return call('ui.click_popup_button', { popup_id: p.popup_id, list_key: 'btn0' }).then(function () {
                return dcWaitPopup(function (q) { return dcIsVehiclePopup(q) && q.popup_id !== 'VehiclePurchaseConfirm'; }, 8000);
            });
        }).then(function (p) {
            if (!p) throw new Error('The game’s dealer did not answer.');
            var ok = p.popup_id === 'VehiclePurchaseSuccess';
            var why = String(p.desc || '').split(/\r?\n/)[0];
            return soft(call('ui.click_popup_button', { popup_id: p.popup_id, list_key: 'btn0' })).then(function () {
                if (!ok) throw new Error(why || 'The game’s dealer turned the order down.');
            });
        });
    }

    // Closes the game's phone the way ESC does, and restarts the clock if it ran before.
    function dcCloseDealer(wasRunning) {
        return (function close(n) {
            return soft(dcPhoneOpen()).then(function (isOpen) {
                if (isOpen !== true || n > 4) return null;
                return soft(call('ui.dismiss', { max_steps: 1 })).then(function () { return dcSleep(400); }).then(function () { return close(n + 1); });
            });
        })(0).then(function () {
            if (!wasRunning) return null;
            return soft(call('environment.get_time', {})).then(function (t) {
                if (!t || t.paused !== true) return null;
                return soft(call('ui.find', { Window: 'Hud', Name: 'BW_Button_Speed1' })).then(function (hits) {
                    var btn = (Array.isArray(hits) ? hits : []).filter(function (h) { return h.ref; })[0];
                    return btn ? soft(dcClick(btn.ref)) : null;
                });
            });
        });
    }

    function dcStartBuy(data, car, colorId) {
        if (dcBuy && dcBuy.state === 'running') return;
        var me = data.me;
        var b = dcBuy = { carId: car.id, color: colorId, state: 'running', step: 0, why: '' };
        var wasRunning = false;
        var stepTo = function (n) {
            b.step = n;
            dcRerender();
        };
        dcRerender();
        dcTrace = [];
        dcLog('buy ' + car.id + ' "' + car.name + '" ' + colorId + ' for ' + me);
        soft(call('environment.get_time', {}))
            .then(function (t) {
                wasRunning = !!t && t.paused === false;
                return dcOpenDealer();
            })
            .then(function (list) {
                dcLog('list ' + (list && list.ref));
                return dcOpenCard(list, car);
            })
            .then(function (buy) {
                dcLog('detail ' + (buy && buy.ref));
                return dcPickColor(car, colorId).then(function () {
                    stepTo(1);
                    return dcConfirmOrder(buy.ref);
                });
            })
            .then(function () {
                stepTo(2);
                var until = Date.now() + DC_WAIT_MS;
                return (function wait() {
                    return dcOwned(me).then(function (o) {
                        if (o && o.id === car.id) return o;
                        if (Date.now() > until) throw new Error('The game took the order but did not hand over the vehicle.');
                        return dcSleep(500).then(wait);
                    });
                })();
            })
            .then(function (o) {
                b.state = 'done';
                b.color = o.color || colorId;
                dcLog('done ' + o.id + ' ' + o.color);
            }, function (err) {
                b.state = 'failed';
                b.why = errText(err);
                dcLog('failed ' + b.why);
            })
            .then(function () { return dcCloseDealer(wasRunning); })
            .then(function () {
                return soft(call('uimod.cfg_save', { mod_id: SMS_MOD, section: 'ui/phone/vehicle', key: 'buylog', value: dcTrace.join('\n') }));
            })
            .then(function () {
                if (dcBuy === b) refresh();
            });
    }

    // ---- garage ----
    function renderDreamCarGarage(data) {
        dcLastData = data;
        dcTab = 'garage';
        var wrap = node('div', 'dc');
        wrap.appendChild(subHeader('dcgarage', 'Dream Car'));
        var count = 0;
        data.members.forEach(function (m) { if (data.owned[String(m.entity_id)]) count++; });
        wrap.appendChild(dcHeader(data, 'Your garage', count ? count + (count === 1 ? ' vehicle' : ' vehicles') + ' in the family.' : 'Nobody in the family owns a vehicle yet.'));
        wrap.appendChild(dcSegment());
        if (!count) {
            // An empty garage invites to the showroom, with the dealer's featured vehicle.
            var feat = dcFeatured(data.cars, data.env);
            var invite = wrap.appendChild(node('div', 'dc-feature'));
            if (feat) invite.appendChild(dcWell(feat, dcColor[feat.id], [], true));
            var ib = invite.appendChild(node('div', 'dc-feature-body'));
            var it = ib.appendChild(node('div', 'dc-feature-text'));
            it.appendChild(node('div', 'dc-feature-kicker', 'YOUR FIRST RIDE'));
            it.appendChild(node('div', 'dc-feature-name', 'The garage is empty'));
            it.appendChild(node('div', 'dc-feature-price', 'Bicycles start at ' + dcMoney(data.cars.length ? data.cars[0].price : 0) + '.'));
            ib.appendChild(node('div', 'dc-cta', 'Showroom'));
            onTap(invite, function (e) {
                e.stopPropagation();
                dcTab = 'showroom';
                open('dreamcar');
            });
            wrap.appendChild(node('div', 'dc-sec')).appendChild(node('div', 'dc-sec-title', 'The family'));
        }
        var people = data.members.slice().sort(function (a, b) {
            return (String(b.entity_id) === data.me) - (String(a.entity_id) === data.me);
        });
        people.forEach(function (m) {
            var id = String(m.entity_id);
            var o = data.owned[id];
            var car = o ? dcCar(o.id) : null;
            if (o && car) {
                var c = wrap.appendChild(node('div', 'dc-car'));
                c.appendChild(dcWell(car, o.color, dcBadges(car, false), true));
                var body = c.appendChild(node('div', 'dc-car-body'));
                var text = body.appendChild(node('div', 'dc-car-text'));
                text.appendChild(node('div', 'dc-car-owner', (id === data.me ? 'You · ' : '') + fullName(m)));
                text.appendChild(node('div', 'dc-car-name', car.name));
                var color = null;
                car.colors.forEach(function (x) { if (x.id === o.color) color = x; });
                var line = text.appendChild(node('div', 'dc-car-color'));
                if (color) line.appendChild(node('span', 'dc-mini')).style.background = color.hex;
                line.appendChild(node('span', null, (o.color || 'Factory colour') + ' · bought for ' + dcMoney(car.price)));
                onTap(c, function (e) {
                    e.stopPropagation();
                    dcOpenCar(car);
                });
                return;
            }
            var row = wrap.appendChild(node('div', 'dc-nocar'));
            row.appendChild(node('div', 'dc-nocar-who', (id === data.me ? 'You · ' : '') + fullName(m)));
            row.appendChild(node('div', 'dc-nocar-sub', o ? o.id : DC_TOO_YOUNG[m.age_group] ? 'Too young' : 'No vehicle'));
        });
        wrap.appendChild(node('div', 'dc-foot', 'Each vehicle waits at home and comes along when its owner travels.'));
        return wrap;
    }

    function dreamCarGlyph() {
        var svg = glyphSvg('0 0 24 24');
        glyphPath(svg, 'M5.2 10.4l1.5-3.6c.4-.9 1.2-1.4 2.2-1.4h6.2c1 0 1.8.5 2.2 1.4l1.5 3.6c1 .3 1.7 1.2 1.7 2.3v3.1c0 .5-.4.9-.9.9h-.9a2.3 2.3 0 0 1-4.5 0H9.8a2.3 2.3 0 0 1-4.5 0h-.9a.9.9 0 0 1-.9-.9v-3.1c0-1.1.7-2 1.7-2.3zm2.1-.3h9.4l-1.1-2.7a.9.9 0 0 0-.8-.5H9.2a.9.9 0 0 0-.8.5zM7.6 14.9a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm8.8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', '#ffffff', 'evenodd');
        return svg;
    }

