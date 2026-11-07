    // ------------------------------------------------------------------
    // Screen transitions (iPhone style)
    // ------------------------------------------------------------------
    // launch: the app window grows out of its home-screen icon while the home screen zooms
    //         past the viewer and fades.
    // close:  the window shrinks back into the icon; the home screen settles from the zoom.
    // push:   Texts -> Chat. The new page slides in from the right over the old one, which
    //         drifts a third of the way left and dims. pop is the reverse.
    // Pages are animated frame by frame on spring curves (UIKit-like response/damping) with
    // inline transform/opacity, so nothing depends on transitionend support in the game UI.
    // The outgoing page's own DOM is moved into the stage, so it keeps its pictures and
    // scroll positions; ids inside it are removed while it is there so lookups only ever find
    // the live page.
    var CACHED_SCREENS = { home: true, texts: true };     // only navigation clicks: safe to show stale
    var CACHE_TTL_MS = 5 * 60 * 1000;
    var HOME_ZOOM = 1.12;
    var ICON_RADIUS = 14;
    var PUSH_PARALLAX = 0.3;
    var PUSH_DIM = 0.22;
    var PUSH_SHADOW = '-8px 0 24px rgba(0, 0, 0, 0.35)';
    var MOTION = {
        launch: { response: 0.42, damping: 0.88, ms: 560 },
        close: { response: 0.40, damping: 0.92, ms: 520 },
        push: { response: 0.34, damping: 1, ms: 460 },
        pop: { response: 0.34, damping: 1, ms: 460 },
        fade: { response: 0.22, damping: 1, ms: 300 }
    };
    var CONTENT_ANIM_STYLES = ['transform', 'webkitTransform', 'transformOrigin', 'webkitTransformOrigin', 'opacity',
        'backgroundColor', 'backgroundImage', 'backgroundRepeat', 'backgroundSize', 'backgroundPosition',
        'boxShadow', 'borderRadius'];
    var homeIcons = {};
    var launchRects = {};
    var viewCache = {};
    var stage = null;
    var transition = null;

    function nextFrame(fn) {
        if (window.requestAnimationFrame) return window.requestAnimationFrame(fn);
        return setTimeout(fn, 16);
    }

    // Damped spring step response at t seconds, 0 -> 1.
    function springAt(t, response, damping) {
        var w = 2 * Math.PI / response;
        if (damping >= 1) return 1 - (1 + w * t) * Math.exp(-w * t);
        var wd = w * Math.sqrt(1 - damping * damping);
        return 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + (damping * w / wd) * Math.sin(wd * t));
    }

    function lerp(a, b, p) { return a + (b - a) * p; }
    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    function setTransform(n, value) {
        n.style.webkitTransform = value;
        n.style.transform = value;
    }

    function setOrigin(n, value) {
        n.style.webkitTransformOrigin = value;
        n.style.transformOrigin = value;
    }

    // Paints the phone wallpaper on a layer so that it lines up with #app-root's own background.
    // A view carries the window size (measured once, not every frame) while an animation runs.
    function paintWallpaper(n, left, top, view) {
        var w = view && view.window;
        if (!w) {
            var root = document.getElementById('app-root');
            w = { w: root.clientWidth, h: root.clientHeight };
        }
        wallStyle(n, wallActive(), w.w, w.h, left, top, view);
    }

    function ensureStage() {
        if (stage) return stage;
        var root = document.getElementById('app-root');
        var box = node('div', 'ph-stage');
        var page = node('div', 'ph-stage-page');
        var dim = node('div', 'ph-stage-dim');
        box.appendChild(page);
        box.appendChild(dim);
        root.appendChild(box);
        var icon = node('div', 'ph-stage-icon');
        var glyph = node('div', 'ph-stage-glyph');
        icon.appendChild(glyph);
        root.appendChild(icon);
        stage = { box: box, page: page, dim: dim, icon: icon, glyph: glyph };
        return stage;
    }

    function appClass(appId) {
        for (var i = 0; i < APPS.length; i++) {
            if (APPS[i].id === appId) return APPS[i].cls;
        }
        return '';
    }

    function hideStage() {
        if (!stage) return;
        stage.page.style.cssText = '';
        stage.dim.style.cssText = '';
        stage.dim.style.opacity = '0';
        stage.box.style.display = 'none';
        if (stage.icon.parentNode) stage.icon.parentNode.removeChild(stage.icon);
        stage.icon.className = 'ph-stage-icon';
        stage.icon.style.cssText = '';
        clear(stage.glyph);
    }

    // Dresses the icon stand-in as appId and pins it over the #content box.
    function prepareIconDouble(appId, ghost) {
        var s = stage;
        if (!s.icon.parentNode) {
            var root = document.getElementById('app-root');
            if (root) root.appendChild(s.icon);
        }
        appId = iconAppFor(appId);
        s.icon.className = 'ph-icon ph-stage-icon ' + appClass(appId);
        clear(s.glyph);
        s.glyph.appendChild(appGlyph(appId));
        s.icon.style.left = ghost.left + 'px';
        s.icon.style.top = ghost.top + 'px';
        s.icon.style.width = ghost.w + 'px';
        s.icon.style.height = ghost.h + 'px';
        s.icon.style.opacity = '0';
        setOrigin(s.icon, '0 0');
        setOrigin(s.glyph, '50% 50%');
        s.icon.style.display = 'block';
    }

    // The stand-in is the icon at k = 0 (exactly its square) and the whole window at k = 1.
    // Its own scale is per axis; the glyph is counter-scaled so it only ever grows evenly.
    function placeIconDouble(icon, W, H, k, opacity) {
        var s = stage;
        var sx = lerp(icon.w / W, 1, k);
        var sy = lerp(icon.h / H, 1, k);
        if (sx < 0.02) sx = 0.02;
        if (sy < 0.02) sy = 0.02;
        var cx = lerp(icon.x + icon.w / 2, W / 2, k);
        var cy = lerp(icon.y + icon.h / 2, H / 2, k);
        setTransform(s.icon, 'translate(' + (cx - sx * W / 2) + 'px, ' + (cy - sy * H / 2) + 'px) scale(' + sx + ', ' + sy + ')');
        var r = lerp(ICON_RADIUS, 0, clamp01(k));
        s.icon.style.borderRadius = (r / sx) + 'px / ' + (r / sy) + 'px';
        var grow = sx / (icon.w / W);
        setTransform(s.glyph, 'scale(' + (grow / sx) + ', ' + (grow / sy) + ')');
        s.icon.style.opacity = String(clamp01(opacity));
    }

    // Icon rectangle relative to the #content box, or null when that icon is not on screen.
    // Chat lives inside Texts, so it opens from and closes into the Texts icon; the pages of
    // Settings close into the Settings icon.
    function iconAppFor(screenId) {
        return appOfScreen(screenId) || screenId;
    }

    function iconRect(appId) {
        var icon = homeIcons[iconAppFor(appId)];
        if (!icon || !icon.offsetParent) return null;
        var r = icon.getBoundingClientRect();
        var c = wf.content.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        // An icon on another home page is off to the side: there is nothing to grow from.
        if (r.left < c.left - 1 || r.right > c.right + 1) return null;
        return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
    }

    function collectScrolled(n, out) {
        if (n.nodeType !== 1) return;
        if (n.scrollTop || n.scrollLeft) out.push({ node: n, top: n.scrollTop, left: n.scrollLeft });
        for (var c = n.firstChild; c; c = c.nextSibling) collectScrolled(c, out);
    }

    function stripIds(n, out) {
        if (n.nodeType !== 1) return;
        if (n.id) {
            out.push({ node: n, id: n.id });
            n.removeAttribute('id');
        }
        for (var c = n.firstChild; c; c = c.nextSibling) stripIds(c, out);
    }

    // A bubble or the emoji panel still running its own transform, under the page slide,
    // is the other way out of a chat that blanks the phone for a moment.
    function stopMotion(n) {
        if (!n || n.nodeType !== 1) return;
        n.style.webkitAnimation = 'none';
        n.style.animation = 'none';
        for (var c = n.firstChild; c; c = c.nextSibling) stopMotion(c);
    }

    // Moves the page currently in #ph-screen into the stage, pinned where it was on screen.
    function captureOutgoing(screenId) {
        var content = wf.content;
        var boxW = content.offsetWidth;
        var boxH = content.offsetHeight;
        if (!boxW || !boxH) return null;
        // Before anything moves: a focused message box must not ride the slide.
        releaseTextFocus(el.screen, true);
        var s = ensureStage();
        clear(s.page);
        var scrollTop = content.scrollTop;
        var items = [];
        var scrolled = [];
        for (var c = el.screen.firstChild; c; c = c.nextSibling) {
            if (c.nodeType !== 1) continue;
            items.push({ node: c, css: c.style.cssText, left: c.offsetLeft, top: c.offsetTop,
                width: c.offsetWidth, height: c.offsetHeight });
            collectScrolled(c, scrolled);
        }
        // The stage must be laid out before the page moves in: scroll offsets written inside a
        // display:none subtree are dropped, and the chat would snap back to its first message.
        // The stage covers the whole window of the page: its pinned header and the content under it.
        var headH = headHeight();
        var top = content.offsetTop - headH;
        s.box.style.left = content.offsetLeft + 'px';
        s.box.style.top = top + 'px';
        s.box.style.width = boxW + 'px';
        s.box.style.height = (boxH + headH) + 'px';
        s.box.style.display = 'block';
        var headCopy = null;
        if (headH) {
            var hs = window.getComputedStyle ? window.getComputedStyle(el.head) : null;
            headCopy = el.head.cloneNode(true);
            headCopy.removeAttribute('id');
            stripIds(headCopy, []);
            headCopy.style.cssText = '';
            headCopy.style.position = 'absolute';
            headCopy.style.margin = '0';
            headCopy.style.left = (el.head.offsetLeft - content.offsetLeft) + 'px';
            headCopy.style.top = '0px';
            headCopy.style.width = el.head.offsetWidth + 'px';
            headCopy.style.height = headH + 'px';
            if (hs) {
                headCopy.style.paddingTop = hs.paddingTop;
                headCopy.style.paddingRight = hs.paddingRight;
                headCopy.style.paddingBottom = hs.paddingBottom;
                headCopy.style.paddingLeft = hs.paddingLeft;
                headCopy.style.backgroundColor = hs.backgroundColor;
                headCopy.style.boxSizing = hs.boxSizing;
            }
            s.page.appendChild(headCopy);
        }
        var ids = [];
        items.forEach(function (it) {
            var n = it.node;
            n.style.position = 'absolute';
            n.style.margin = '0';
            n.style.left = it.left + 'px';
            n.style.top = (it.top - scrollTop + headH) + 'px';
            n.style.width = it.width + 'px';
            n.style.height = it.height + 'px';
            s.page.appendChild(n);
            stripIds(n, ids);
        });
        scrolled.forEach(function (r) {
            r.node.scrollTop = r.top;
            r.node.scrollLeft = r.left;
        });
        items.forEach(function (it) { stopMotion(it.node); });
        return { screenId: screenId, items: items, ids: ids, scrollTop: scrollTop, headCopy: headCopy,
            left: content.offsetLeft, top: top, w: boxW, h: boxH + headH };
    }

    // The pinned header (#ph-fixed-head) sits right above #content. It is drawn on its next
    // frame, so a header that was just put in may not have its height yet: the last one is used.
    var lastHeadH = 0;

    function headShown() {
        return el.head.style.display !== 'none' && !!el.head.firstChild;
    }

    function headHeight() {
        if (!headShown()) return 0;
        var h = el.head.offsetHeight;
        if (h) lastHeadH = h;
        // A header that was just put in has no height until the next frame; the last
        // measured one (or a typical bar) keeps the window from opening with a hole at the top.
        return h || lastHeadH || 40;
    }

    function clearAnimStyles(n) {
        if (!n) return;
        CONTENT_ANIM_STYLES.forEach(function (k) { n.style[k] = ''; });
    }

    // Icon in the coordinate space of a window whose top is `headH` above #content.
    function iconInWindow(icon, headH) {
        return { x: icon.x, y: icon.y + headH, w: icon.w, h: icon.h };
    }

    // Takes the outgoing page out of the stage; list screens are kept for an instant return.
    function releaseOutgoing(ghost) {
        if (ghost.headCopy && ghost.headCopy.parentNode) ghost.headCopy.parentNode.removeChild(ghost.headCopy);
        var keep = CACHED_SCREENS[ghost.screenId];
        ghost.items.forEach(function (it) {
            it.node.style.cssText = it.css;
            if (it.node.parentNode) it.node.parentNode.removeChild(it.node);
        });
        if (!keep) return;
        ghost.ids.forEach(function (r) { r.node.id = r.id; });
        viewCache[ghost.screenId] = {
            nodes: ghost.items.map(function (it) { return it.node; }),
            scroll: ghost.scrollTop,
            at: Date.now()
        };
    }

    function takeCached(screenId) {
        var c = viewCache[screenId];
        delete viewCache[screenId];
        if (!c || Date.now() - c.at > CACHE_TTL_MS) return null;
        return c;
    }

    function cachedError(nodes) {
        for (var i = 0; i < nodes.length; i++) {
            if ((nodes[i].textContent || '').indexOf('Could not load this page.') >= 0) return true;
        }
        return false;
    }

    function showNodes(nodes) {
        clear(el.screen);
        nodes.forEach(function (n) { el.screen.appendChild(n); });
        shownScreenId = current;
        liftHead();
    }

    function transitionKind(from, to) {
        if (from === to) return null;
        if (wf.content.style.display === 'none') return null;
        if (from === 'home') return 'launch';
        if (to === 'home') return 'close';
        if (screenParent[to]) return 'push';
        if (screenParent[from]) return 'pop';
        return 'fade';
    }

    // Where the app window sits for k = 0 (on the icon) .. 1 (full screen). The scale and the
    // translation come back on their own as well: the window's wallpaper is held in place
    // through them every frame (see wallStyle).
    function cardFrame(icon, W, H, k) {
        var s = lerp(icon.w / W, 1, k);
        var cx = lerp(icon.x + icon.w / 2, W / 2, k);
        var cy = lerp(icon.y + icon.h / 2, H / 2, k);
        if (s < 0.02) s = 0.02;
        var x = cx - s * W / 2;
        var y = cy - s * H / 2;
        return {
            s: s, x: x, y: y,
            transform: 'translate(' + x + 'px, ' + y + 'px) scale(' + s + ')',
            radius: (lerp(ICON_RADIUS, 0, clamp01(k)) / s) + 'px'
        };
    }

    // Frame f of the close animation, eased in from a swipe's lift at p = 0.
    function liftedFrame(lift, f, p) {
        var s = lerp(lift.s, f.s, p);
        var x = lerp(lift.x, f.x, p);
        var y = lerp(lift.y, f.y, p);
        var r = lerp(lift.r * lift.s, parseFloat(f.radius) * f.s, p) / s;
        return { s: s, x: x, y: y, transform: 'translate(' + x + 'px, ' + y + 'px) scale(' + s + ')', radius: r + 'px' };
    }

    function zoomAbout(icon, z) {
        var cx = icon.x + icon.w / 2;
        var cy = icon.y + icon.h / 2;
        return 'translate(' + (cx - z * cx) + 'px, ' + (cy - z * cy) + 'px) scale(' + z + ')';
    }

    // The incoming page's header and content move as one window: both take the same transform,
    // the content's origin lifted by the header height to the window's top left corner.
    function windowTransform(tr, value) {
        setTransform(wf.content, value);
        if (tr.head) setTransform(el.head, value);
    }

    function windowStyle(tr, key, value) {
        wf.content.style[key] = value;
        if (tr.head) el.head.style[key] = value;
    }

    function windowOrigin(tr) {
        if (!tr.head) return;
        var h = el.head.offsetHeight;
        if (h) lastHeadH = h;
        h = h || tr.headH;
        if (h === tr.headH && tr.originSet) return;
        tr.headH = h;
        tr.originSet = true;
        setOrigin(wf.content, '0px ' + (-h) + 'px');
    }

    function applyFrame(tr, p, tl) {
        var content = wf.content;
        var page = stage.page;
        var W = tr.winW;
        var H = tr.winH;
        var icon = tr.winIcon;
        var f, x, v;
        windowOrigin(tr);
        if (tr.kind === 'launch') {
            f = cardFrame(icon, W, H, p);
            windowTransform(tr, f.transform);
            if (tr.head) {
                el.head.style.borderRadius = f.radius + ' ' + f.radius + ' 0px 0px';
                content.style.borderRadius = '0px 0px ' + f.radius + ' ' + f.radius;
            } else {
                content.style.borderRadius = f.radius;
            }
            // The window's wallpaper is put back on the home screen's own every frame, so it
            // holds still while the window grows instead of growing with it: the icon opens
            // onto the picture that is already behind it.
            if (tr.wall) {
                v = { s: f.s, x: f.x, y: f.y, ox: 0, oy: -tr.headH, window: tr.window };
                paintWallpaper(content, tr.wallLeft, tr.contentTop, v);
                if (tr.head) {
                    paintWallpaper(el.head, tr.wallLeft, tr.wallTop,
                        { s: f.s, x: f.x, y: f.y, ox: 0, oy: 0, window: tr.window });
                }
            }
            // The window only shows once its shape is close to the stand-in's, so it never
            // sticks out above or below the growing icon.
            windowStyle(tr, 'opacity', String(clamp01((p - 0.18) / 0.28)));
            if (tr.useStandIn) placeIconDouble(icon, W, H, p, 1 - (p - 0.18) / 0.32);
            // The home screen stays whole behind the growing window, as on iOS; the window covers it.
            setTransform(page, zoomAbout(tr.icon, lerp(1, HOME_ZOOM, p)));
            page.style.opacity = '1';
        } else if (tr.kind === 'close') {
            f = cardFrame(icon, W, H, 1 - p);
            // A swipe home: the page sets off from where the window was let go.
            if (tr.lift) f = liftedFrame(tr.lift, f, p);
            setTransform(page, f.transform);
            if (tr.wall) {
                paintWallpaper(page, tr.wallLeft, tr.wallTop,
                    { s: f.s, x: f.x, y: f.y, ox: 0, oy: 0, window: tr.window });
            }
            page.style.borderRadius = f.radius;
            page.style.opacity = String(clamp01(1 - (p - 0.45) / 0.3));
            // No stand-in on close: the real home icon is already there. Drawing another one
            // on top of it is the second icon that stayed behind after going home.
            // The home screen is there in full from the first frame and settles from the zoom.
            setTransform(content, zoomAbout(tr.icon, lerp(HOME_ZOOM, 1, p)));
            content.style.opacity = '1';
        } else if (tr.kind === 'push') {
            x = lerp(W, 0, p);
            windowTransform(tr, 'translate(' + x + 'px, 0px)');
            if (tr.bar) setTransform(tr.bar, 'translate(' + (-x) + 'px, 0px)');
            setTransform(page, 'translate(' + lerp(0, -PUSH_PARALLAX * W, p) + 'px, 0px)');
            stage.dim.style.opacity = String(PUSH_DIM * clamp01(p));
        } else if (tr.kind === 'pop') {
            x = lerp(-PUSH_PARALLAX * W, 0, p);
            windowTransform(tr, 'translate(' + x + 'px, 0px)');
            if (tr.bar) setTransform(tr.bar, 'translate(' + (-x) + 'px, 0px)');
            setTransform(page, 'translate(' + lerp(0, W, p) + 'px, 0px)');
            stage.dim.style.opacity = String(PUSH_DIM * clamp01(1 - p));
        } else {
            windowStyle(tr, 'opacity', String(clamp01(p)));
            page.style.opacity = String(clamp01(1 - p));
        }
    }

    function startTransition(kind, ghost, from, to) {
        var content = wf.content;
        var s = stage;
        var icon = null;
        if (kind === 'launch') icon = launchRects[to];
        // Closing goes back into the icon it was opened from. Measuring the icon now would read
        // the home screen before the game has laid it out again.
        if (kind === 'close') icon = launchRects[from] || launchRects[iconAppFor(from)] || iconRect(from) || null;
        if ((kind === 'launch' || kind === 'close') && !icon) {
            icon = { x: ghost.w / 2 - 31, y: ghost.h * 0.72, w: 62, h: 62 };
        }
        s.page.style.cssText = '';
        s.dim.style.opacity = '0';
        s.dim.style.display = kind === 'push' || kind === 'pop' ? 'block' : 'none';
        if (kind === 'push') s.box.appendChild(s.dim);
        else s.box.insertBefore(s.dim, s.page);
        s.box.style.zIndex = kind === 'pop' || kind === 'close' ? '3' : '0';
        var headIn = (kind === 'launch' || kind === 'push' || kind === 'pop') ? headHeight() : 0;
        var winW = ghost.w;
        var winH = ghost.h;
        var winIcon = icon;
        if (kind === 'launch') {
            winH = ghost.h + headIn;
            winIcon = iconInWindow(icon, headIn);
            prepareIconDouble(to, { left: ghost.left, top: ghost.top - headIn, w: winW, h: winH });
        } else if (kind === 'close') {
            var extra = Math.max(0, ghost.h - content.offsetHeight);
            winIcon = iconInWindow(icon, extra);
        }
        setOrigin(content, '0px ' + (-headIn) + 'px');
        if (headIn) setOrigin(el.head, '0 0');
        setOrigin(s.page, '0 0');
        if (kind === 'launch' || kind === 'push') {
            if (appOfScreen(to) === 'dreamcar') {
                content.style.backgroundColor = '#0b0b0d';
                if (headIn) el.head.style.backgroundColor = '#0b0b0d';
            } else {
                // The content box starts one header height below the window's top, so its
                // wallpaper is moved up by that much; the header, when there is one, gets its own.
                paintWallpaper(content, ghost.left, ghost.top + headIn);
                if (headIn) paintWallpaper(el.head, ghost.left, ghost.top);
            }
        }
        if (kind === 'close' || kind === 'pop') {
            if (appOfScreen(from) === 'dreamcar') s.page.style.backgroundColor = '#0b0b0d';
            else paintWallpaper(s.page, ghost.left, ghost.top);
        }
        if (kind === 'push') {
            content.style.boxShadow = PUSH_SHADOW;
            if (headIn) el.head.style.boxShadow = PUSH_SHADOW;
        }
        if (kind === 'pop') s.page.style.boxShadow = PUSH_SHADOW;
        var rootEl = document.getElementById('app-root');
        // The bar is root chrome rather than a child of #content now; it still rides the slide.
        var bar = (kind === 'push' || kind === 'pop') && rootEl ? rootEl.querySelector('.ph-home') : null;
        var tr = { kind: kind, ghost: ghost, from: from, to: to, icon: icon, winIcon: winIcon,
            winW: winW, winH: winH, bar: bar, useStandIn: kind === 'launch',
            lift: kind === 'close' ? closeLift : null,
            head: headIn > 0, headH: headIn, originSet: true,
            wall: (kind === 'launch' || kind === 'close') &&
                appOfScreen(kind === 'launch' ? to : from) !== 'dreamcar',
            wallLeft: ghost.left, wallTop: ghost.top, contentTop: ghost.top + headIn,
            window: { w: rootEl ? rootEl.clientWidth : 0, h: rootEl ? rootEl.clientHeight : 0 },
            motion: MOTION[kind], t0: Date.now() };
        transition = tr;
        applyFrame(tr, 0, 0);
        s.box.style.display = 'block';
        var step = function () {
            if (transition !== tr) return;
            var ms = Date.now() - tr.t0;
            if (ms >= tr.motion.ms) {
                finishTransition();
                return;
            }
            applyFrame(tr, springAt(ms / 1000, tr.motion.response, tr.motion.damping), ms / tr.motion.ms);
            nextFrame(step);
        };
        nextFrame(step);
    }

    // Jumps the running transition to its end state and cleans up. Safe to call at any time.
    function finishTransition() {
        var tr = transition;
        if (!tr) return;
        transition = null;
        var content = wf.content;
        clearAnimStyles(content);
        clearAnimStyles(el.head);
        if (tr.bar) setTransform(tr.bar, '');
        releaseOutgoing(tr.ghost);
        hideStage();
        traceNav('animation ' + tr.kind + ' done ' + tr.from + ' -> ' + tr.to);
        if (current === 'home') homeMount();
        if (tr.after) tr.after();
    }

