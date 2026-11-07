    // ------------------------------------------------------------------
    // App Store: the apps the registry knows, to get, open or remove, laid out like a phone's
    // app store: a featured card, category chips, grouped lists, and a page for each app.
    // ------------------------------------------------------------------
    var STORE_ALL = 'All';
    var storeFilter = STORE_ALL;
    var storeAppId = null;
    var storeConfirmRemove = null;
    var lastStoreData = null;

    function loadStore() {
        return getEnv().then(function (env) { return { env: env }; });
    }

    function storeIcon(app, cls) {
        var icon = node('div', 'ph-icon as-icon ' + (cls || '') + ' ' + app.cls);
        icon.appendChild(app.glyph ? app.glyph() : appGlyph(app.id));
        return icon;
    }

    function rerenderStore() {
        if (!lastStoreData || (current !== 'store' && current !== 'storeapp')) return;
        var scrollTop = wf.content.scrollTop;
        show((current === 'storeapp' ? renderStoreApp : renderStore)(lastStoreData));
        wf.content.scrollTop = scrollTop;
    }

    function storeOpenApp(id) {
        storeAppId = id;
        storeConfirmRemove = null;
        setNote('', false);
        open('storeapp');
    }

    // Downloads in progress, by app id: { start, wait, dur, knots }. GET first spins a grey
    // "waiting" ring, then a blue ring fills unevenly around a stop square, then OPEN pops in.
    var storeDownloads = {};
    var storeDlDone = {};
    var storeDlTicking = false;
    var DL_R = 13.5;
    var DL_r = 11.2;

    function dlArc(p0, p1) {
        var c = 15;
        if (p1 - p0 >= 0.999) {
            return 'M' + (c - DL_R) + ' ' + c + 'a' + DL_R + ' ' + DL_R + ' 0 1 0 ' + (2 * DL_R) + ' 0a' + DL_R + ' ' + DL_R + ' 0 1 0 ' + (-2 * DL_R) + ' 0Z' +
                'M' + (c - DL_r) + ' ' + c + 'a' + DL_r + ' ' + DL_r + ' 0 1 1 ' + (2 * DL_r) + ' 0a' + DL_r + ' ' + DL_r + ' 0 1 1 ' + (-2 * DL_r) + ' 0Z';
        }
        var a0 = p0 * 2 * Math.PI - Math.PI / 2;
        var a1 = p1 * 2 * Math.PI - Math.PI / 2;
        var big = p1 - p0 > 0.5 ? 1 : 0;
        var pt = function (rad, a) { return (c + rad * Math.cos(a)).toFixed(2) + ' ' + (c + rad * Math.sin(a)).toFixed(2); };
        return 'M' + pt(DL_R, a0) + 'A' + DL_R + ' ' + DL_R + ' 0 ' + big + ' 1 ' + pt(DL_R, a1) +
            'L' + pt(DL_r, a1) + 'A' + DL_r + ' ' + DL_r + ' 0 ' + big + ' 0 ' + pt(DL_r, a0) + 'Z';
    }

    // Progress 0..1 at time t ms: eased between uneven knots, like a real download that stalls a little.
    function dlProgress(dl, t) {
        var x = Math.max(0, Math.min(1, (t - dl.wait) / dl.dur));
        var k = dl.knots;
        for (var i = 1; i < k.length; i++) {
            if (x <= k[i][0]) {
                var f = (x - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
                f = f * f * (3 - 2 * f);
                return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * f;
            }
        }
        return 1;
    }

    function dlStart(app) {
        var knots = [[0, 0]];
        var tx = 0;
        var py = 0;
        for (var i = 0; i < 4; i++) {
            tx += 0.12 + Math.random() * 0.16;
            py += 0.1 + Math.random() * 0.2;
            knots.push([Math.min(tx, 0.92), Math.min(py, 0.95)]);
        }
        knots.push([1, 1]);
        storeDownloads[app.id] = { start: Date.now(), wait: 650 + Math.random() * 500, dur: 1800 + Math.random() * 1600, knots: knots };
        rerenderStore();
        dlTick();
    }

    function dlTick() {
        if (storeDlTicking) return;
        storeDlTicking = true;
        nextFrame(dlFrame);
    }

    function dlFrame() {
        var now = Date.now();
        var finished = [];
        var busy = false;
        Object.keys(storeDownloads).forEach(function (id) {
            var dl = storeDownloads[id];
            if (now - dl.start >= dl.wait + dl.dur + 220) finished.push(id);
            else busy = true;
        });
        var rings = document.querySelectorAll('.as-dl');
        for (var i = 0; i < rings.length; i++) dlPaint(rings[i], now);
        finished.forEach(function (id) {
            delete storeDownloads[id];
            storeDlDone[id] = now;
            appInstall(id);
            var app = appRegistry[id];
            if (app) {
                setNote(app.label + ' is on your home screen.', false);
                noteFromLoad = false;
            }
            if (current === 'home') refresh();
        });
        if (finished.length) rerenderStore();
        storeDlTicking = false;
        if (busy) dlTick();
    }

    function dlPaint(ring, now) {
        var dl = storeDownloads[ring.getAttribute('data-app')];
        if (!dl || !ring.dlArc) return;
        var t = now - dl.start;
        if (t < dl.wait) {
            var spin = (t / 900) % 1;
            ring.dlTrack.setAttribute('fill', 'rgba(142, 142, 147, 0.28)');
            ring.dlArc.setAttribute('fill', '#8e8e93');
            ring.dlArc.setAttribute('d', dlArc(spin, spin + 0.27));
            ring.dlStop.setAttribute('opacity', '0');
        } else {
            ring.dlTrack.setAttribute('fill', 'rgba(120, 120, 128, 0.32)');
            ring.dlArc.setAttribute('fill', '#0A84FF');
            ring.dlArc.setAttribute('d', dlArc(0, Math.max(0.005, dlProgress(dl, t))));
            ring.dlStop.setAttribute('opacity', '1');
        }
    }

    // The ring that stands in for the button while an app downloads; tap it to cancel.
    function dlRing(app, big) {
        var b = node('button', 'as-pill as-dl' + (big ? ' big' : ''));
        b.setAttribute('type', 'button');
        b.setAttribute('data-app', app.id);
        var svg = svgEl('svg');
        svg.setAttribute('viewBox', '0 0 30 30');
        svg.setAttribute('class', 'as-dl-svg');
        var track = svgEl('path');
        track.setAttribute('d', dlArc(0, 1));
        track.setAttribute('fill-rule', 'evenodd');
        var arc = svgEl('path');
        var stop = svgEl('rect');
        stop.setAttribute('x', '11.5');
        stop.setAttribute('y', '11.5');
        stop.setAttribute('width', '7');
        stop.setAttribute('height', '7');
        stop.setAttribute('rx', '1.2');
        stop.setAttribute('fill', '#0A84FF');
        svg.appendChild(track);
        svg.appendChild(arc);
        svg.appendChild(stop);
        b.appendChild(svg);
        b.dlTrack = track;
        b.dlArc = arc;
        b.dlStop = stop;
        dlPaint(b, Date.now());
        onTap(b, function (e) {
            e.stopPropagation();
            delete storeDownloads[app.id];
            rerenderStore();
        });
        return b;
    }

    // The round button of an app: OPEN for one on the phone, GET for one that is not.
    function storePill(app, big) {
        if (storeDownloads[app.id]) return dlRing(app, big);
        var installed = appInstalled(app.id);
        var label = installed ? 'OPEN' : 'GET';
        var pill = node('button', 'as-pill' + (installed ? '' : ' get') + (big ? ' big' : ''), label);
        pill.setAttribute('type', 'button');
        if (installed && app.id === 'store') pill.className += ' off';
        if (installed && storeDlDone[app.id] && Date.now() - storeDlDone[app.id] < 600) pill.className += ' as-pop';
        onTap(pill, function (e) {
            e.stopPropagation();
            if (!installed) {
                dlStart(app);
            } else if (app.id !== 'store') {
                open(app.launch);
            }
        });
        return pill;
    }

    // The app shown on the featured card: one of those that have a headline, turning with the game day.
    function storeFeatured(env) {
        var list = appOrder.map(function (id) { return appRegistry[id]; }).filter(function (a) { return a.featured; });
        if (!list.length) return null;
        var day = env && typeof env.day === 'number' ? env.day : 0;
        return list[day % list.length];
    }

    function storeFeaturedCard(app) {
        var c = node('div', 'as-feature ' + app.cls);
        c.appendChild(node('div', 'as-feature-eyebrow', 'FEATURED'));
        c.appendChild(node('div', 'as-feature-title', app.featured));
        var row = node('div', 'as-feature-row');
        row.appendChild(storeIcon(app, 'as-icon-md'));
        var who = node('div', 'as-feature-who');
        who.appendChild(node('div', 'as-feature-name', app.label));
        who.appendChild(node('div', 'as-feature-sub', app.subtitle));
        row.appendChild(who);
        row.appendChild(storePill(app));
        c.appendChild(row);
        onTap(c, function () { storeOpenApp(app.id); });
        return c;
    }

    function storeChips() {
        var cats = [STORE_ALL];
        appOrder.forEach(function (id) {
            var cat = appRegistry[id].category;
            if (cat && cats.indexOf(cat) < 0) cats.push(cat);
        });
        var row = node('div', 'as-chips');
        cats.forEach(function (cat) {
            var chip = node('div', 'as-chip' + (cat === storeFilter ? ' on' : ''), cat);
            onTap(chip, function (e) {
                e.stopPropagation();
                if (storeFilter === cat) return;
                storeFilter = cat;
                rerenderStore();
            });
            row.appendChild(chip);
        });
        return row;
    }

    function storeRow(app) {
        var row = node('div', 'as-row');
        row.appendChild(storeIcon(app, 'as-icon-sm'));
        var who = node('div', 'as-row-who');
        who.appendChild(node('div', 'as-row-name', app.label));
        who.appendChild(node('div', 'as-row-sub', app.subtitle));
        row.appendChild(who);
        row.appendChild(storePill(app));
        onTap(row, function () { storeOpenApp(app.id); });
        return row;
    }

    function storeGroup(title, apps, empty) {
        var wrap = node('div', 'as-group-wrap');
        var head = node('div', 'as-group-head');
        head.appendChild(node('div', 'as-group-title', title));
        head.appendChild(node('div', 'as-group-count', apps.length ? String(apps.length) : ''));
        wrap.appendChild(head);
        var group = node('div', 'as-group');
        if (!apps.length) group.appendChild(node('div', 'as-empty', empty));
        apps.forEach(function (app) { group.appendChild(storeRow(app)); });
        wrap.appendChild(group);
        return wrap;
    }

    function renderStore(data) {
        lastStoreData = data;
        var wrap = node('div', 'as-screen');
        wrap.appendChild(subHeader('store'));
        var env = data.env || {};
        wrap.appendChild(node('div', 'as-date', [env.day_of_week, env.season].filter(Boolean).join(' · ').toUpperCase()));
        wrap.appendChild(node('div', 'as-hero-title', 'Discover'));
        var feat = storeFeatured(env);
        if (feat && storeFilter === STORE_ALL) wrap.appendChild(storeFeaturedCard(feat));
        wrap.appendChild(storeChips());
        var mine = [];
        var more = [];
        appOrder.forEach(function (id) {
            var app = appRegistry[id];
            if (storeFilter !== STORE_ALL && app.category !== storeFilter) return;
            (appInstalled(id) ? mine : more).push(app);
        });
        wrap.appendChild(storeGroup('On This Phone', mine, 'Nothing from this category on your phone.'));
        wrap.appendChild(storeGroup('More Apps', more, 'You have every app here. Removed apps show up in this list, ready to get again.'));
        return wrap;
    }

    function storeInfo(label, value, sub) {
        var cell = node('div', 'as-info-cell');
        cell.appendChild(node('div', 'as-info-label', label));
        cell.appendChild(node('div', 'as-info-value', value));
        if (sub) cell.appendChild(node('div', 'as-info-sub', sub));
        return cell;
    }

    function renderStoreApp(data) {
        lastStoreData = data;
        var app = storeAppId && appRegistry[storeAppId];
        var wrap = node('div', 'as-screen');
        wrap.appendChild(subHeader('storeapp', app ? app.label : 'App'));
        if (!app) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'This app is no longer in the store.'));
            wrap.appendChild(none);
            return wrap;
        }
        var top = node('div', 'as-detail-top');
        top.appendChild(storeIcon(app, 'as-icon-lg'));
        var who = node('div', 'as-detail-who');
        who.appendChild(node('div', 'as-detail-name', app.label));
        who.appendChild(node('div', 'as-detail-sub', app.subtitle));
        who.appendChild(node('div', 'as-detail-dev', app.developer));
        var actions = node('div', 'as-detail-actions');
        actions.appendChild(storePill(app, true));
        who.appendChild(actions);
        top.appendChild(who);
        wrap.appendChild(top);

        var pages = Object.keys(app.screens).length;
        var info = node('div', 'as-info');
        info.appendChild(storeInfo('CATEGORY', app.category || '—'));
        info.appendChild(storeInfo('TYPE', app.system ? 'Built in' : 'App', app.system ? 'Always on' : 'Removable'));
        info.appendChild(storeInfo('PAGES', String(pages)));
        info.appendChild(storeInfo('VERSION', app.version || '1.0'));
        wrap.appendChild(info);

        if (app.whatsNew) {
            var news = node('div', 'as-section');
            news.appendChild(node('div', 'as-section-title', "What's New"));
            news.appendChild(node('div', 'as-section-sub', 'Version ' + (app.version || '1.0')));
            news.appendChild(node('div', 'as-text', app.whatsNew));
            wrap.appendChild(news);
        }
        var about = node('div', 'as-section');
        about.appendChild(node('div', 'as-section-title', 'About This App'));
        about.appendChild(node('div', 'as-text', app.about));
        wrap.appendChild(about);

        if (appInstalled(app.id) && !app.system) {
            var confirming = storeConfirmRemove === app.id;
            var remove = node('button', 'as-remove' + (confirming ? ' warn' : ''), confirming ? 'Tap Again to Remove' : 'Remove App');
            remove.setAttribute('type', 'button');
            onTap(remove, function (e) {
                e.stopPropagation();
                if (!confirming) {
                    storeConfirmRemove = app.id;
                    setNote('Its data stays on the phone; get it again any time.', false);
                    noteFromLoad = false;
                    rerenderStore();
                    return;
                }
                storeConfirmRemove = null;
                appRemove(app.id);
                setNote(app.label + ' removed.', false);
                rerenderStore();
            });
            wrap.appendChild(remove);
        }
        return wrap;
    }

    function storeGlyph() {
        var svg = glyphSvg('0 0 24 24');
        glyphPath(svg, 'M6.2 7.6h11.6l.9 12.2c.1.7-.5 1.3-1.2 1.3H6.5c-.7 0-1.3-.6-1.2-1.3l.9-12.2z');
        glyphPath(svg, 'M9 8.4V7c0-1.7 1.3-3 3-3s3 1.3 3 3v1.4h-1.5V7c0-.8-.7-1.5-1.5-1.5s-1.5.7-1.5 1.5v1.4H9z');
        return svg;
    }

