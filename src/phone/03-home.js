    // ------------------------------------------------------------------
    // Home
    // ------------------------------------------------------------------
    function loadHome() {
        return Promise.all([getEnv(), getEmotionTable(), getPossessedId(), soft(getMembers())]).then(function (r) {
            var id = r[2];
            var members = r[3] && !r[3].error ? r[3] : [];
            var member = null;
            for (var i = 0; i < members.length; i++) {
                if (String(members[i].entity_id) === id) member = members[i];
            }
            var infoP = member ? Promise.resolve(member)
                : soft(call('entity.get_character_info', { entity_id: id }, 'entity_id'));
            return Promise.all([infoP, soft(getEmotion(id)), soft(getStats(id)), totalUnread(id, members), momentsUnread(id),
                loadAiSetup().then(null, function () { return ''; }), storiesNew(id)]).then(function (d) {
                return {
                    env: r[0], table: r[1], id: id, info: d[0], emotion: d[1], stats: d[2],
                    unread: d[3], momentsUnread: d[4], aiSetup: d[5] || '', storiesNew: d[6] || 0
                };
            });
        });
    }

    function svgEl(name) {
        return document.createElementNS('http://www.w3.org/2000/svg', name);
    }

    function glyphSvg(viewBox) {
        var svg = svgEl('svg');
        svg.setAttribute('viewBox', viewBox);
        svg.setAttribute('class', 'ph-glyph');
        return svg;
    }

    function glyphPath(svg, d, fill, rule) {
        var p = svgEl('path');
        p.setAttribute('d', d);
        p.setAttribute('fill', fill || '#ffffff');
        if (rule) p.setAttribute('fill-rule', rule);
        svg.appendChild(p);
    }

    function glyphShape(svg, name, attrs) {
        var el = svgEl(name);
        for (var k in attrs) {
            if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]);
        }
        svg.appendChild(el);
    }

    // White symbols on rounded tiles, in the same visual language as iPhone apps.
    function appGlyph(id) {
        var svg;
        var registered = appRegistry && appRegistry[id];
        if (registered && registered.glyph) return registered.glyph();
        if (id === 'time') return clockGlyph();
        svg = glyphSvg('0 0 24 24');
        if (id === 'family') {
            glyphPath(svg, 'M12 3.1L3.6 10.2V20.4h6.1V14.6h4.6v5.8H20.4V10.2L12 3.1zM10.4 20.4v-4.4h3.2v4.4h-3.2z', '#ffffff', 'evenodd');
        } else if (id === 'bonds') {
            glyphPath(svg, 'M12 20.4s-6.6-4-8.8-7.7C1.5 9.6 2.2 6.2 4.9 5.1c1.8-.7 3.7-.1 4.9 1.6L12 8.8l2.2-2.1c1.2-1.7 3.1-2.3 4.9-1.6 2.7 1.1 3.4 4.5 1.7 7.6-2.2 3.7-8.8 7.7-8.8 7.7z');
        } else if (id === 'oa') {
            glyphPath(svg, 'M4.2 8.2h15.6c.7 0 1.2.5 1.2 1.2v8.6c0 .7-.5 1.2-1.2 1.2H4.2c-.7 0-1.2-.5-1.2-1.2V9.4c0-.7.5-1.2 1.2-1.2zM3 11.6h18v1.5H3v-1.5z', '#ffffff', 'evenodd');
            glyphPath(svg, 'M9 8.2V6.3c0-.7.5-1.2 1.2-1.2h3.6c.7 0 1.2.5 1.2 1.2V8.2H9zM10.3 8.2V6.5c0-.2.2-.4.4-.4h2.6c.2 0 .4.2.4.4V8.2h-3.4z', '#ffffff', 'evenodd');
        } else if (id === 'jobs') {
            glyphShape(svg, 'circle', { cx: '5', cy: '6.2', r: '1.45', fill: '#ffffff' });
            glyphShape(svg, 'rect', { x: '8.2', y: '5.3', width: '11.2', height: '1.8', rx: '0.9', fill: '#ffffff' });
            glyphShape(svg, 'circle', { cx: '5', cy: '12', r: '1.45', fill: '#ffffff' });
            glyphShape(svg, 'rect', { x: '8.2', y: '11.1', width: '11.2', height: '1.8', rx: '0.9', fill: '#ffffff' });
            glyphShape(svg, 'circle', { cx: '5', cy: '17.8', r: '1.45', fill: '#ffffff' });
            glyphShape(svg, 'rect', { x: '8.2', y: '16.9', width: '8.4', height: '1.8', rx: '0.9', fill: '#ffffff' });
        } else if (id === 'messages') {
            glyphPath(svg, 'M4.4 6h15.2c.8 0 1.4.6 1.4 1.4v9.2c0 .8-.6 1.4-1.4 1.4H4.4c-.8 0-1.4-.6-1.4-1.4V7.4C3 6.6 3.6 6 4.4 6zm.6 2.1v.3l7 4.6 7-4.6v-.3l-7 4.4-7-4.4z', '#ffffff', 'evenodd');
        } else if (id === 'freelance') {
            glyphPath(svg, 'M6.2 3.4h8.3l4.3 4.3v12.1c0 .7-.5 1.2-1.2 1.2H6.2c-.7 0-1.2-.5-1.2-1.2V4.6c0-.7.5-1.2 1.2-1.2zM14 4.6v3.6h3.6L14 4.6z', '#ffffff', 'evenodd');
            glyphPath(svg, 'M8.4 14.3l1.3-1.3 1.9 1.9 3.9-3.9 1.3 1.3-5.2 5.2-3.2-3.2z', '#FF9F0A');
        } else if (id === 'moments') {
            glyphShape(svg, 'circle', { cx: '12', cy: '12', r: '8.2', fill: 'none', stroke: '#ffffff', 'stroke-width': '1.9' });
            for (var b = 0; b < 6; b++) {
                glyphShape(svg, 'line', {
                    x1: '12', y1: '12', x2: '12', y2: '3.8',
                    stroke: '#ffffff', 'stroke-width': '1.6', 'stroke-linecap': 'round',
                    transform: 'rotate(' + (b * 60 + 18) + ' 12 12) translate(2.6 0)'
                });
            }
            glyphShape(svg, 'circle', { cx: '12', cy: '12', r: '2.4', fill: '#ffffff' });
        } else if (id === 'news') {
            glyphPath(svg, 'M4.2 4.1h13c1.5 0 2.7 1.2 2.7 2.7v13.1H7c-1.6 0-2.8-1.2-2.8-2.7V4.1z', '#ffffff', 'evenodd');
            glyphPath(svg, 'M6.5 6.7h5.4v5.4H6.5V6.7zm7.4.2h3.5v2.4h-3.5V6.9zm0 3.7h3.5v1.8h-3.5v-1.8zM6.5 14h10.9v1.4H6.5V14zm0 2.7h7.8v1.4H6.5v-1.4z', '#B7362D');
        } else if (id === 'stories') {
            glyphPath(svg, 'M12 3.6c4.9 0 8.6 3 8.6 6.8s-3.7 6.8-8.6 6.8c-.8 0-1.5-.1-2.2-.2l-3.9 2.5c-.4.2-.8-.2-.6-.6l1-2.9C4.6 14.8 3.4 12.7 3.4 10.4c0-3.8 3.7-6.8 8.6-6.8z');
            glyphPath(svg, 'M12 14.2s-3.6-2.2-4.4-4.1c-.6-1.4 0-2.9 1.3-3.2 1-.3 2 .2 2.5 1l.6.9.6-.9c.5-.8 1.5-1.3 2.5-1 1.3.3 1.9 1.8 1.3 3.2-.8 1.9-4.4 4.1-4.4 4.1z', '#AF52DE');
        } else if (id === 'ai') {
            glyphPath(svg, 'M10.4 3.4l1.9 5.3 5.3 1.9-5.3 1.9-1.9 5.3-1.9-5.3-5.3-1.9 5.3-1.9 1.9-5.3z');
            glyphPath(svg, 'M17.6 13.6l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4z');
        } else if (id === 'settings') {
            for (var g = 0; g < 8; g++) {
                glyphShape(svg, 'rect', {
                    x: '10.6', y: '2.6', width: '2.8', height: '4.2', rx: '0.9', fill: '#ffffff',
                    transform: 'rotate(' + (g * 45) + ' 12 12)'
                });
            }
            glyphShape(svg, 'circle', { cx: '12', cy: '12', r: '6.6', fill: 'none', stroke: '#ffffff', 'stroke-width': '3' });
            glyphShape(svg, 'circle', { cx: '12', cy: '12', r: '1.9', fill: '#ffffff' });
        } else {
            glyphPath(svg, 'M12 4.1c4.7 0 8.4 3.1 8.4 6.9s-3.7 6.9-8.4 6.9c-.7 0-1.5-.1-2.1-.3l-3.6 1.9c-.3.2-.7-.2-.5-.5l.9-2.8C4.7 15.1 3.6 13.2 3.6 11 3.6 7.2 7.3 4.1 12 4.1z');
        }
        return svg;
    }

    function clockGlyph() {
        var svg = glyphSvg('0 0 64 64');
        var i, major, w, h, y;
        for (i = 0; i < 12; i++) {
            major = i % 3 === 0;
            w = major ? 2.4 : 1.5;
            h = major ? 7 : 4;
            y = major ? 6 : 8;
            glyphShape(svg, 'rect', {
                x: String(32 - w / 2),
                y: String(y),
                width: String(w),
                height: String(h),
                rx: '0.8',
                fill: '#1c1c1e',
                transform: 'rotate(' + (i * 30) + ' 32 32)'
            });
        }
        glyphShape(svg, 'line', {
            x1: '32', y1: '34', x2: '32', y2: '20',
            stroke: '#1c1c1e', 'stroke-width': '2.8', 'stroke-linecap': 'round',
            transform: 'rotate(-60 32 32)'
        });
        glyphShape(svg, 'line', {
            x1: '32', y1: '34', x2: '32', y2: '13',
            stroke: '#1c1c1e', 'stroke-width': '2.2', 'stroke-linecap': 'round',
            transform: 'rotate(60 32 32)'
        });
        glyphShape(svg, 'line', {
            x1: '32', y1: '38', x2: '32', y2: '12',
            stroke: '#FF3B30', 'stroke-width': '1.15', 'stroke-linecap': 'round',
            transform: 'rotate(200 32 32)'
        });
        glyphShape(svg, 'circle', { cx: '32', cy: '32', r: '2.2', fill: '#1c1c1e' });
        return svg;
    }

    // ------------------------------------------------------------------
    // Home screen pages, as on the iPhone: a widget page on the left (Today), the home page
    // with the clock and the app icons, and as many more icon pages as the window needs.
    // The pages move sideways only: drag them, turn the mouse wheel, or click a page dot.
    // The dock under the pages stays put. Icons that do not fit on a page move to the next
    // one, measured again whenever the window changes size.
    // ------------------------------------------------------------------
    // Installed apps registered with dock: true, kept by the app registry.
    var HOME_DOCK = [];
    var HOME_TODAY = 0;
    var HOME_MAIN = 1;
    var HOME_COLS = 4;
    var HOME_DRAG_START_PX = 8;
    var HOME_FLICK_PX_MS = 0.35;
    var HOME_TURN_SHARE = 0.25;
    var HOME_EDGE_RESIST = 0.35;
    var HOME_SETTLE = { response: 0.32, damping: 1, ms: 420 };
    var HOME_WHEEL_STEP = 60;
    var HOME_WHEEL_IDLE_MS = 180;
    var HOME_WHEEL_LOCK_MS = 450;
    var HOME_CLICK_GUARD_MS = 350;
    var HOME_SIZE_POLL_MS = 400;
    var homePage = HOME_MAIN;
    var homeView = null;
    var homeDrag = null;
    var homeAnim = null;
    var homeDraggedAt = 0;
    // Editing the home screen, as on the iPhone: a long press on any icon makes the icons jiggle,
    // and every app that is not built in (system) shows a remove badge. Done, a tap on empty
    // space, or leaving the home screen ends it.
    var HOME_HOLD_MS = 600;
    var homeEditing = false;
    var homeHold = null;
    var homeAlert = null;
    var homeWheel = { sum: 0, at: 0, lockedUntil: 0 };
    var homeRefreshWanted = false;

    function homeApp(id) {
        for (var i = 0; i < APPS.length; i++) {
            if (APPS[i].id === id) return APPS[i];
        }
        return null;
    }

    function homeBadge(data, id) {
        var app = appRegistry[id];
        return app && app.badge ? (app.badge(data) || 0) : 0;
    }

    // An app icon. The tap sound waits for the click so that dragging the pages is quiet.
    function homeTile(app, data, withLabel) {
        var tile = node('div', 'ph-app');
        var icon = node('div', 'ph-icon ' + app.cls);
        homeIcons[app.id] = icon;
        icon.appendChild(appGlyph(app.id));
        tile.appendChild(icon);
        var badge = homeBadge(data, app.id);
        if (badge > 0) tile.appendChild(node('div', 'ph-badge', badge > 9 ? '9+' : String(badge)));
        if (withLabel) tile.appendChild(node('div', 'ph-app-label', app.label));
        var id = app.id;
        if (!app.system) {
            var del = tile.appendChild(node('div', 'ph-del', '−'));
            del.setAttribute('title', 'Remove ' + app.label);
            onTap(del, function (e) {
                e.stopPropagation();
                if (homeEditing) homeAskRemove(id);
            });
        }
        tile.addEventListener('mousedown', function (e) {
            if (e.button || homeEditing) return;
            homeHoldCancel();
            var hold = homeHold = { x: e.clientX, y: e.clientY, timer: 0 };
            hold.timer = setTimeout(function () {
                if (homeHold !== hold) return;
                homeHold = null;
                if (current !== 'home' || (homeDrag && homeDrag.moved)) return;
                homeEditStart();
            }, HOME_HOLD_MS);
        });
        onTap(tile, function (e) {
            e.stopPropagation();
            // While editing (and for the click that ends the long press) an icon opens nothing.
            if (homeEditing || homeTapBlocked()) return;
            soundPlay('tap');
            open(id);
        }, { silent: true });
        return tile;
    }

    function homeHoldCancel() {
        if (!homeHold) return;
        clearTimeout(homeHold.timer);
        homeHold = null;
    }

    document.addEventListener('mousemove', function (e) {
        var h = homeHold;
        if (h && (Math.abs(e.clientX - h.x) > HOME_DRAG_START_PX || Math.abs(e.clientY - h.y) > HOME_DRAG_START_PX)) homeHoldCancel();
    });
    document.addEventListener('mouseup', homeHoldCancel);

    function homeEditStart() {
        if (homeEditing) return;
        homeEditing = true;
        if (homeView) homeView.wrap.classList.add('hs-editing');
        traceNav('home editing');
    }

    function homeEditStop() {
        homeHoldCancel();
        homeAlertClose();
        if (!homeEditing) return;
        homeEditing = false;
        if (homeView) homeView.wrap.classList.remove('hs-editing');
    }

    function homeAlertClose() {
        var a = homeAlert;
        homeAlert = null;
        if (a && a.parentNode) a.parentNode.removeChild(a);
    }

    // The question before an app goes, as the iPhone asks it. The app is looked up by id when
    // the answer comes: the home screen may have been drawn anew in between.
    function homeAskRemove(id) {
        var app = appRegistry[id];
        if (!app || app.system || !appInstalled(id)) return;
        homeAlertClose();
        var veil = node('div', 'hs-alert-veil');
        var box = veil.appendChild(node('div', 'hs-alert'));
        var icon = box.appendChild(node('div', 'ph-icon hs-alert-icon ' + app.cls));
        icon.appendChild(appGlyph(id));
        box.appendChild(node('div', 'hs-alert-title', 'Remove “' + app.label + '”?'));
        box.appendChild(node('div', 'hs-alert-text', 'It leaves the Home Screen. Get it again from the App Store any time; what it saved stays on the phone.'));
        var yes = box.appendChild(node('div', 'hs-alert-btn danger', 'Delete App'));
        var no = box.appendChild(node('div', 'hs-alert-btn', 'Cancel'));
        onTap(yes, function (e) {
            e.stopPropagation();
            homeAlertClose();
            var a = appRegistry[id];
            if (!a || a.system || !appInstalled(id)) return;
            appRemove(id);
            setNote(a.label + ' removed. Get it again in the App Store.', false);
            if (!APPS.some(function (x) { return !x.system; })) homeEditStop();
            refresh();
        });
        onTap(no, function (e) {
            e.stopPropagation();
            homeAlertClose();
        });
        onTap(veil, function (e) {
            e.stopPropagation();
            if (e.target === veil) homeAlertClose();
        });
        var root = document.getElementById('app-root');
        root.appendChild(veil);
        homeAlert = veil;
    }

    // The Today page: the played character, its mood and needs.
    function homeTodayPage(data) {
        var env = data.env;
        var today = node('div', 'hs-page hs-today');
        today.appendChild(joinWithDots(node('div', 'hs-today-date'), [env.day_of_week, env.season]));
        today.appendChild(node('div', 'hs-today-title', 'Today'));
        var me = card('NOW PLAYING');
        var info = data.info && !data.info.error ? data.info : { entity_id: data.id };
        var subParts = [info.relationship_label || info.age_group_text, info.job_name];
        var row = personRow(info, subParts, moodPill(emotionLabel(data.table, data.emotion)));
        row.style.marginTop = '10px';
        me.appendChild(row);
        me.appendChild(needsGrid(data.stats, HOME_NEEDS));
        today.appendChild(me);
        return today;
    }

    // Greeting, clock, date and weather above the app icons.
    function homeHero(env, aiSetupState) {
        var hero = node('div', 'ph-hero');
        hero.appendChild(node('div', 'ph-greet', greeting(env)));
        hero.appendChild(node('div', 'ph-clock', clockText(env)));
        hero.appendChild(joinWithDots(node('div', 'ph-date'), [env.day_of_week, env.season]));
        var weatherParts = [];
        if (env.weather) weatherParts.push(WEATHER[env.weather] || env.weather);
        if (typeof env.temperature === 'number') weatherParts.push(env.temperature + ' C');
        if (weatherParts.length) hero.appendChild(node('div', 'ph-weather', weatherParts.join('  ')));
        if (aiSetupState) hero.appendChild(homeSetupBanner(aiSetupState));
        return hero;
    }

    // Under the clock while AI Phone Service is not installed or not running; opens the AI page.
    function homeSetupBanner(state) {
        var stopped = state === 'stopped';
        var b = node('div', 'ph-setup' + (stopped ? ' stopped' : ''));
        b.appendChild(node('div', 'ph-setup-title', stopped ? 'AI Phone Service is not running' : 'Finish setting up AI Phone'));
        b.appendChild(node('div', 'ph-setup-sub', stopped ? 'AI 手机服务没有运行，点这里查看怎么启动' : '还差一步：安装 AI 手机服务，点这里查看'));
        onTap(b, function (e) {
            e.stopPropagation();
            if (homeTapBlocked()) return;
            soundPlay('tap');
            open('ai');
        }, { silent: true });
        return b;
    }

    // What the app icons show; the icons are rebuilt (and laid out on pages again) only when it changes.
    function homeTilesKey(data) {
        return APPS.map(function (app) { return app.id + ':' + homeBadge(data, app.id); }).join('|');
    }

    function homeTileIds() {
        return APPS.map(function (app) { return app.id; }).join('|');
    }

    // New unread counts on icons already in place: only the red badges change.
    function homePatchBadges(data) {
        for (var i = 0; i < APPS.length; i++) {
            var icon = homeIcons[APPS[i].id];
            var tile = icon && icon.parentNode;
            if (!tile) return false;
            var n = homeBadge(data, APPS[i].id);
            var text = n > 9 ? '9+' : String(n);
            var badge = null;
            for (var c = tile.firstChild; c; c = c.nextSibling) {
                if (c.nodeType === 1 && hasClass(c, 'ph-badge')) badge = c;
            }
            if (n > 0) {
                if (!badge) tile.insertBefore(node('div', 'ph-badge', text), icon.nextSibling);
                else if (badge.textContent !== text) badge.textContent = text;
            } else if (badge) {
                tile.removeChild(badge);
            }
        }
        return true;
    }

    // The poll's redraw of a home screen already on screen: the clock and the Today page are
    // updated in place, and the icons stay where they are. False when it needs drawing anew.
    function homePatch(data) {
        var v = homeView;
        var why = !v || !v.hero ? 'no view' : !canMorph() ? 'no morph' : shownScreenId !== 'home' ? 'shown ' + shownScreenId :
            v.wrap.parentNode !== el.screen ? 'view detached' : !v.hero.parentNode || !v.today.parentNode ? 'pages detached' : '';
        if (why) { traceNav('home rebuild: ' + why); return false; }
        // The setup banner changes the hero's height, which the icon pages were cut to.
        if (v.aiSetup !== (data.aiSetup || '')) { traceNav('home rebuild: ai setup ' + (data.aiSetup || 'done')); return false; }
        var key = homeTilesKey(data);
        if (v.tilesKey !== key) {
            if (v.tileIds !== homeTileIds() || !homePatchBadges(data)) { traceNav('home rebuild: apps changed'); return false; }
            v.tilesKey = key;
        }
        traceNav('home patched');
        // Children only: the pages carry the sizes the layout gave them.
        morphChildren(v.today, homeTodayPage(data));
        morphChildren(v.hero, homeHero(data.env, data.aiSetup));
        return true;
    }

    function renderHome(data) {
        var env = data.env;
        homeIcons = {};
        var wrap = node('div', 'hs' + (homeEditing ? ' hs-editing' : ''));
        var done = wrap.appendChild(node('div', 'hs-done', 'Done'));
        onTap(done, function (e) {
            e.stopPropagation();
            homeEditStop();
        });
        wrap.addEventListener('click', function (e) {
            if (!homeEditing || homeTapBlocked()) return;
            for (var t = e.target; t && t !== wrap; t = t.parentNode) if (t.nodeType === 1 && hasClass(t, 'ph-app')) return;
            homeEditStop();
        });
        var viewport = node('div', 'hs-viewport');
        var track = node('div', 'hs-track');
        viewport.appendChild(track);
        wrap.appendChild(viewport);

        var today = homeTodayPage(data);

        var main = node('div', 'hs-page');
        var hero = homeHero(env, data.aiSetup);
        main.appendChild(hero);

        var tiles = [];
        APPS.forEach(function (app) {
            if (HOME_DOCK.indexOf(app.id) < 0) tiles.push(homeTile(app, data, true));
        });

        var dots = node('div', 'hs-dots');
        var dock = node('div', 'hs-dock');
        HOME_DOCK.forEach(function (id) {
            var app = homeApp(id);
            if (app) dock.appendChild(homeTile(app, data, false));
        });
        wrap.appendChild(dots);
        wrap.appendChild(dock);

        homeView = { wrap: wrap, viewport: viewport, track: track, dots: dots, today: today, main: main,
            pages: [today, main], tiles: tiles, w: 0, h: 0, hero: hero, tilesKey: homeTilesKey(data), tileIds: homeTileIds(),
            aiSetup: data.aiSetup || '' };
        homeBindGestures(homeView);
        return wrap;
    }

    function homeCount() { return homeView ? homeView.pages.length : 1; }

    function homeClampPage(p) {
        var last = homeCount() - 1;
        return p < 0 ? 0 : p > last ? last : p;
    }

    function homeOffset(px) {
        if (!homeView) return;
        setTransform(homeView.track, 'translate(' + px + 'px, 0px)');
    }

    function homeRest() {
        if (!homeView) return;
        setTransform(homeView.track, 'translate(' + (-homePage * 100) + '%, 0px)');
    }

    function homePaintDots() {
        var v = homeView;
        if (!v) return;
        clear(v.dots);
        v.pages.forEach(function (page, i) {
            var dot = node('div', 'hs-dot' + (i === homePage ? ' on' : '') + (i === HOME_TODAY ? ' today' : ''));
            dot.setAttribute('title', i === HOME_TODAY ? 'Today' : 'Page ' + i);
            onTap(dot, function (e) {
                e.stopPropagation();
                homeGo(i);
            });
            v.dots.appendChild(dot);
        });
    }

    // Puts every icon on the home page, then moves whole rows that run past its bottom to
    // the following pages. Needs the view on screen; a hidden phone keeps its last layout.
    function homePaginate() {
        var v = homeView;
        if (!v) return;
        // The game's UI lays out a page that was just put in only on its next frame; until
        // then it has no size, so the pages are cut on the first frame that has one.
        if (!v.viewport.offsetParent || !v.viewport.clientWidth || !v.viewport.clientHeight) {
            traceNav('home paginate waits for layout');
            homePaginateSoon(v, 0);
            return;
        }
        var w = v.viewport.clientWidth;
        var h = v.viewport.clientHeight;
        v.w = w;
        v.h = h;
        v.pages.slice(2).forEach(function (page) {
            if (page.parentNode) page.parentNode.removeChild(page);
        });
        v.pages = [v.today, v.main];
        if (v.today.parentNode !== v.track) v.track.appendChild(v.today);
        if (v.main.parentNode !== v.track) v.track.appendChild(v.main);
        var grid = v.main.querySelector('.ph-apps');
        if (!grid) {
            grid = node('div', 'ph-apps');
            v.main.appendChild(grid);
        }
        v.tiles.forEach(function (t) { grid.appendChild(t); });
        v.pages.forEach(function (page, i) { page.style.left = (i * 100) + '%'; });

        var limit = v.main.clientHeight;
        var cut = v.tiles.length;
        for (var i = 0; i < v.tiles.length; i++) {
            var t = v.tiles[i];
            if (t.offsetTop + t.offsetHeight > limit) {
                cut = i;
                break;
            }
        }
        if (cut < v.tiles.length) {
            var rowH = homeRowHeight(v.tiles[0]);
            var gs = window.getComputedStyle ? window.getComputedStyle(grid) : null;
            var gridTop = gs ? parseFloat(gs.marginTop) || 0 : 0;
            var rows = Math.floor((limit - gridTop) / rowH);
            var perPage = (rows > 1 ? rows : 1) * HOME_COLS;
            var rest = v.tiles.slice(cut);
            while (rest.length) {
                var page = node('div', 'hs-page');
                var more = node('div', 'ph-apps');
                rest.splice(0, perPage).forEach(function (t) { more.appendChild(t); });
                page.appendChild(more);
                page.style.left = (v.pages.length * 100) + '%';
                v.track.appendChild(page);
                v.pages.push(page);
            }
        }
        homePage = homeClampPage(homePage);
        homeRest();
        homePaintDots();
        traceNav('home paginated ' + w + 'x' + h + ', ' + v.pages.length + ' pages, on page ' + homePage);
    }

    function homePaginateSoon(v, tries) {
        if (v.paginateWait) return;
        v.paginateWait = true;
        nextFrame(function () {
            v.paginateWait = false;
            if (homeView !== v || current !== 'home' || v.wrap.parentNode !== el.screen) return;
            if (transition) {
                if (tries < 30) homePaginateSoon(v, tries + 1);
                return;
            }
            homePaginateIfNeeded();
            if ((!v.viewport.offsetParent || !v.viewport.clientWidth) && tries < 30) homePaginateSoon(v, tries + 1);
        });
    }

    function homeRowHeight(tile) {
        var cs = window.getComputedStyle ? window.getComputedStyle(tile) : null;
        var top = cs ? parseFloat(cs.marginTop) || 0 : 0;
        return (tile.offsetHeight || 80) + top;
    }

    // The home screen fills the window and never scrolls up and down; its pages move sideways.
    function homeSetMode(on) {
        if (on) wf.content.classList.add('home-open');
        else wf.content.classList.remove('home-open');
        if (on) wf.content.scrollTop = 0;
        // Nothing to swipe home from on the home screen; the dock there keeps all its clicks.
        var grab = document.getElementById('ph-home-grab');
        if (grab) grab.style.display = on ? 'none' : '';
    }

    // Called each time the home view is put on screen (rendered or taken from the cache).
    function homeMount() {
        if (!homeView || homeView.wrap.parentNode !== el.screen) { traceNav('home mount skipped'); return; }
        traceNav('home mount, viewport ' + homeView.viewport.clientWidth + 'x' + homeView.viewport.clientHeight +
            (homeView.viewport.offsetParent ? '' : ' not laid out') + (transition ? ' during animation' : ''));
        homeStop(false);
        // Reflowing icons while the close animation is still moving them is what made every
        // tile jump, and what left a second copy sitting where the stand-in landed.
        if (transition) return;
        homePaginateIfNeeded();
    }

    function homePaginateIfNeeded() {
        var v = homeView;
        if (!v || v.wrap.parentNode !== el.screen || current !== 'home') return;
        if (!v.viewport.offsetParent || !v.viewport.clientWidth || !v.viewport.clientHeight) {
            homePaginateSoon(v, 0);
            return;
        }
        if (v.w === v.viewport.clientWidth && v.h === v.viewport.clientHeight) return;
        homePaginate();
    }

    function homeHolding() { return !!(homeDrag || homeAnim); }

    // The click that ends a drag, or the press that caught moving pages, opens nothing.
    // window.js fires the click from mouseup before the drag here is released.
    function homeTapBlocked() {
        if (homeAnim) return true;
        if (homeDrag && (homeDrag.moved || homeDrag.caught)) return true;
        return Date.now() - homeDraggedAt < HOME_CLICK_GUARD_MS;
    }

    function homeAfterMotion() {
        if (!homeRefreshWanted || homeHolding()) return;
        homeRefreshWanted = false;
        if (current === 'home') refresh();
    }

    // Ends a drag or a settle at once. jump: leave the pages where they are on the page that
    // was being moved to; otherwise snap back to the current page.
    function homeStop(jump) {
        if (homeAnim) {
            if (jump) homePage = homeAnim.to;
            homeAnim = null;
        }
        homeDrag = null;
        homeRest();
        homePaintDots();
    }

    function homeGo(target) {
        var v = homeView;
        if (!v) return;
        target = homeClampPage(target);
        var w = v.viewport.clientWidth || v.w;
        if (!w) {
            homePage = target;
            homeRest();
            homePaintDots();
            return;
        }
        var from = homeAnim ? homeAnim.now : homeDrag ? homeDrag.now : -homePage * w;
        homeDrag = null;
        homePage = target;
        homePaintDots();
        var anim = { from: from, to: target, end: -target * w, now: from, t0: Date.now() };
        homeAnim = anim;
        var step = function () {
            if (homeAnim !== anim) return;
            var ms = Date.now() - anim.t0;
            if (ms >= HOME_SETTLE.ms) {
                homeAnim = null;
                homeRest();
                homeAfterMotion();
                return;
            }
            anim.now = lerp(anim.from, anim.end, springAt(ms / 1000, HOME_SETTLE.response, HOME_SETTLE.damping));
            homeOffset(anim.now);
            nextFrame(step);
        };
        nextFrame(step);
    }

    function homeBindGestures(v) {
        v.viewport.addEventListener('mousedown', function (e) {
            if (e.button) return;
            var w = v.viewport.clientWidth;
            if (!w || homeView !== v) return;
            var caught = !!homeAnim;
            var base = caught ? homeAnim.now : -homePage * w;
            homeAnim = null;
            if (caught) homeOffset(base);
            homeDrag = { x: e.clientX, y: e.clientY, base: base, now: base, w: w, moved: false, caught: caught,
                press: pressStart(e), samples: [{ x: e.clientX, t: Date.now() }] };
        });
        v.viewport.addEventListener('wheel', function (e) {
            if (homeView !== v) return;
            var vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
            // A Today page taller than the window scrolls up and down with the wheel first.
            if (vertical && homePage === HOME_TODAY && !homeHolding()) {
                var t = v.today;
                var room = e.deltaY > 0 ? t.scrollHeight - t.clientHeight - t.scrollTop : t.scrollTop;
                if (room > 0) return;
            }
            var d = vertical ? e.deltaY : e.deltaX;
            if (e.deltaMode === 1) d *= 16;
            else if (e.deltaMode === 2) d *= v.viewport.clientWidth || 300;
            if (e.preventDefault) e.preventDefault();
            var now = Date.now();
            if (now < homeWheel.lockedUntil) return;
            if (now - homeWheel.at > HOME_WHEEL_IDLE_MS) homeWheel.sum = 0;
            homeWheel.at = now;
            homeWheel.sum += d;
            if (Math.abs(homeWheel.sum) < HOME_WHEEL_STEP) return;
            var dir = homeWheel.sum > 0 ? 1 : -1;
            homeWheel.sum = 0;
            homeWheel.lockedUntil = now + HOME_WHEEL_LOCK_MS;
            homeGo(homePage + dir);
        }, { passive: false });
    }

    document.addEventListener('mousemove', function (e) {
        var d = homeDrag;
        if (!d || !homeView) return;
        if (pressLost(e, d.press)) {
            homeRelease();
            return;
        }
        var dx = e.clientX - d.x;
        var dy = e.clientY - d.y;
        if (!d.moved) {
            if (Math.abs(dx) < HOME_DRAG_START_PX && Math.abs(dy) < HOME_DRAG_START_PX) return;
            if (Math.abs(dy) > Math.abs(dx)) {
                homeDrag = null;
                homeRest();
                return;
            }
            d.moved = true;
        }
        var pos = d.base + dx;
        var min = -(homeCount() - 1) * d.w;
        if (pos > 0) pos = pos * HOME_EDGE_RESIST;
        else if (pos < min) pos = min + (pos - min) * HOME_EDGE_RESIST;
        d.now = pos;
        homeOffset(pos);
        d.samples.push({ x: e.clientX, t: Date.now() });
        if (d.samples.length > 6) d.samples.shift();
    });

    function homeRelease() {
        var d = homeDrag;
        if (!d) return;
        if (!d.moved) {
            homeDrag = null;
            if (d.caught) {
                homeGo(homePage);
                return;
            }
            homeRest();
            homeAfterMotion();
            return;
        }
        homeDraggedAt = Date.now();
        var first = d.samples[0];
        var last = d.samples[d.samples.length - 1];
        var dt = last.t - first.t;
        var v = dt > 0 ? (last.x - first.x) / dt : 0;
        var travel = d.now - d.base;
        var target = homePage;
        var startPage = Math.round(-d.base / d.w);
        if (v <= -HOME_FLICK_PX_MS || travel <= -d.w * HOME_TURN_SHARE) target = startPage + 1;
        else if (v >= HOME_FLICK_PX_MS || travel >= d.w * HOME_TURN_SHARE) target = startPage - 1;
        else target = startPage;
        homeGo(target);
    }

    document.addEventListener('mouseup', homeRelease);
    document.addEventListener('mouseout', function (e) {
        if (homeDrag && leftPhone(e)) homeRelease();
    });
    window.addEventListener('blur', homeRelease);

    // The window can be resized by its corner at any time; the pages follow.
    setInterval(function () {
        var v = homeView;
        if (current !== 'home' || !v || homeHolding() || transition) return;
        if (!v.viewport.offsetParent) return;
        if (v.viewport.clientWidth !== v.w || v.viewport.clientHeight !== v.h) homePaginate();
    }, HOME_SIZE_POLL_MS);

    // ------------------------------------------------------------------
    // Swipe up from the home indicator, as on the iPhone
    // ------------------------------------------------------------------
    // Pressing on the bar at the bottom of the phone and dragging up lifts the open page: the
    // window (pinned header and content) shrinks and follows the pointer. Let go high enough, or
    // with a flick, and the page closes into its home icon, the close animation starting from
    // where the window was let go (homeLift, used by applyFrame); otherwise it springs back.
    var SWIPE_START_PX = 6;
    var SWIPE_HOME_SHARE = 0.18;     // of the window's height
    var SWIPE_HOME_MIN_PX = 60;
    var SWIPE_FLICK_PX_MS = 0.5;
    var SWIPE_FULL_SHARE = 0.55;     // drag that brings the window to its smallest
    var SWIPE_MIN_SCALE = 0.62;
    var SWIPE_RADIUS = 34;
    var SWIPE_BACK = { response: 0.3, damping: 0.86, ms: 380 };
    var SWIPE_WAIT_MS = 2500;
    var SWIPE_SHADOW = '0 12px 36px rgba(0, 0, 0, 0.35)';
    var swipeDrag = null;
    var swipeBack = null;
    // The window frame a swipe let go at: { s, x, y } in the window's own space, read once by
    // the close transition that follows.
    var homeLift = null;
    var homeLiftAt = 0;
    var closeLift = null;

    function swipeZone() {
        var root = wf.root;
        if (!root) return null;
        var z = document.getElementById('ph-home-grab');
        if (z) return z;
        z = document.createElement('div');
        z.id = 'ph-home-grab';
        root.appendChild(z);
        z.addEventListener('mousedown', swipeStart);
        return z;
    }

    function swipeAllowed() {
        return current !== 'home' && !playedYoung && !transition && !homeLift &&
            !dcCurtain && !txCurtain && !flCurtain && !nwCurtain && !oaCurtain &&
            !(wf.root && wf.root._minimized) && wf.content.style.display !== 'none';
    }

    // The open page's window: the pinned header and the content under it.
    function swipeWindow() {
        var content = wf.content;
        var headH = headShown() ? headHeight() : 0;
        return { w: content.offsetWidth, h: content.offsetHeight + headH, headH: headH };
    }

    // Window frame for a drag of `up` pixels.
    function swipeFrame(win, up) {
        var full = win.h * SWIPE_FULL_SHARE;
        var d = up < 0 ? up * 0.2 : up > full ? full + (up - full) * 0.3 : up;
        var k = clamp01(d / full);
        var s = lerp(1, SWIPE_MIN_SCALE, k);
        var cx = win.w / 2;
        var cy = win.h / 2 - d * 0.85;
        return { s: s, x: cx - s * win.w / 2, y: cy - s * win.h / 2, r: lerp(0, SWIPE_RADIUS, k) / s };
    }

    function swipePaint(win, f) {
        var content = wf.content;
        var t = 'translate(' + f.x + 'px, ' + f.y + 'px) scale(' + f.s + ')';
        var r = f.r + 'px';
        setOrigin(content, '0px ' + (-win.headH) + 'px');
        setTransform(content, t);
        if (win.headH) {
            setOrigin(el.head, '0 0');
            setTransform(el.head, t);
            el.head.style.borderRadius = r + ' ' + r + ' 0px 0px';
            content.style.borderRadius = '0px 0px ' + r + ' ' + r;
        } else {
            content.style.borderRadius = r;
        }
    }

    // The page is see-through onto the phone's wallpaper. While it is lifted it carries its own
    // copy, shrinking with it, and a shadow: a card over the wallpaper rather than a page fading
    // into it.
    function swipeDress(win) {
        var content = wf.content;
        if (appOfScreen(current) === 'dreamcar') {
            content.style.backgroundColor = '#0b0b0d';
            if (win.headH) el.head.style.backgroundColor = '#0b0b0d';
        } else {
            paintWallpaper(content, content.offsetLeft, content.offsetTop);
            if (win.headH) paintWallpaper(el.head, content.offsetLeft, content.offsetTop - win.headH);
        }
        content.style.boxShadow = SWIPE_SHADOW;
    }

    function swipeClear() {
        clearAnimStyles(wf.content);
        clearAnimStyles(el.head);
    }

    function swipeStart(e) {
        if (e.button || !swipeAllowed()) return;
        if (swipeBack) { swipeBack.dead = true; swipeBack = null; swipeClear(); }
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        var win = swipeWindow();
        if (!win.w || !win.h) return;
        swipeDrag = { y: e.clientY, up: 0, win: win, moved: false, press: pressStart(e),
            samples: [{ y: e.clientY, t: Date.now() }] };
    }

    document.addEventListener('mousemove', function (e) {
        var d = swipeDrag;
        if (!d) return;
        if (pressLost(e, d.press)) {
            swipeEnd();
            return;
        }
        var up = d.y - e.clientY;
        if (!d.moved) {
            if (up < SWIPE_START_PX) return;
            if (!swipeAllowed()) { swipeDrag = null; return; }
            d.moved = true;
            // A field being typed into must not ride the window, nor keep the keyboard.
            releaseTextFocus(el.screen, false);
            swipeDress(d.win);
        }
        d.up = up;
        swipePaint(d.win, swipeFrame(d.win, up));
        d.samples.push({ y: e.clientY, t: Date.now() });
        if (d.samples.length > 6) d.samples.shift();
    });

    function swipeEnd() {
        var d = swipeDrag;
        if (!d) return;
        swipeDrag = null;
        if (!d.moved) return;
        var first = d.samples[0];
        var last = d.samples[d.samples.length - 1];
        var dt = last.t - first.t;
        var v = dt > 0 ? (first.y - last.y) / dt : 0;
        var far = d.up >= Math.max(SWIPE_HOME_MIN_PX, d.win.h * SWIPE_HOME_SHARE);
        var flick = v >= SWIPE_FLICK_PX_MS && d.up > SWIPE_START_PX * 3;
        if ((far || flick) && v > -SWIPE_FLICK_PX_MS && swipeAllowed()) {
            homeLift = swipeFrame(d.win, d.up);
            homeLiftAt = Date.now();
            open('home');
            // Going home may wait for the home screen's data; it may also not happen at all
            // (another page took over). The lifted window then settles back.
            swipeWaitHome(d.win);
            return;
        }
        swipeSettle(d.win, swipeFrame(d.win, d.up));
    }

    function swipeWaitHome(win) {
        if (!homeLift) return;
        if (current === 'home' && !transition) { homeLift = null; swipeClear(); return; }
        if (Date.now() - homeLiftAt > SWIPE_WAIT_MS || (!awaiting('home') && current !== 'home')) {
            var f = homeLift;
            homeLift = null;
            swipeSettle(win, f);
            return;
        }
        setTimeout(function () { swipeWaitHome(win); }, 50);
    }

    // Springs the window back to full size from frame f.
    function swipeSettle(win, f) {
        var anim = { t0: Date.now(), dead: false };
        swipeBack = anim;
        var step = function () {
            if (anim.dead) return;
            var ms = Date.now() - anim.t0;
            if (ms >= SWIPE_BACK.ms || transition) {
                swipeBack = null;
                swipeClear();
                return;
            }
            var p = springAt(ms / 1000, SWIPE_BACK.response, SWIPE_BACK.damping);
            swipePaint(win, { s: lerp(f.s, 1, p), x: lerp(f.x, 0, p), y: lerp(f.y, 0, p), r: lerp(f.r * f.s, 0, p) / lerp(f.s, 1, p) });
            nextFrame(step);
        };
        nextFrame(step);
    }

    // The close transition takes the lifted window over on the same frame: the page is copied out
    // of #content and drawn at the lift, so the header and #content go back to rest here.
    function takeHomeLift() {
        var f = homeLift;
        homeLift = null;
        if (f) swipeClear();
        return f;
    }

    document.addEventListener('mouseup', swipeEnd);
    document.addEventListener('mouseout', function (e) {
        if (swipeDrag && leftPhone(e)) swipeEnd();
    });
    window.addEventListener('blur', swipeEnd);
    swipeZone();

