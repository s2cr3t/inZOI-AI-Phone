    // ------------------------------------------------------------------
    // Redrawing in place
    // ------------------------------------------------------------------
    // The poll redraws the open page every few seconds. Swapping the whole page reloads every
    // picture and lays everything out again, which shows as a flash; morph keeps each node whose
    // content did not change and replaces only the ones that did. Nodes kept this way keep their
    // pictures, scroll, focus and typed text.
    var shownScreenId = null;
    var morphOk = null;

    function canMorph() {
        if (morphOk === null) {
            var probe = document.createElement('div');
            probe.className = 'x';
            morphOk = typeof probe.outerHTML === 'string' && probe.outerHTML.indexOf('x') >= 0;
        }
        return morphOk;
    }

    // The node's own tag and attributes, without its children. The class that liftHead adds to a
    // page's own header does not count.
    function shellOf(n) {
        if (n.nodeType !== 1) return n.nodeType + ':' + n.nodeValue;
        return n.cloneNode(false).outerHTML.replace(/\s*ph-head-lifted/g, '');
    }

    function fullOf(n) {
        return n.nodeType === 1 ? n.outerHTML.replace(/\s*ph-head-lifted/g, '') : n.nodeType + ':' + n.nodeValue;
    }

    function morph(oldNode, newNode) {
        if (fullOf(oldNode) === fullOf(newNode)) return;
        // Something that acts on a tap carries the data it was made from; a changed one is
        // replaced whole so its action matches what it shows.
        if (shellOf(oldNode) !== shellOf(newNode) || oldNode.nodeType !== 1 || oldNode.tapHandler || newNode.tapHandler) {
            oldNode.parentNode.replaceChild(newNode, oldNode);
            return;
        }
        morphChildren(oldNode, newNode);
    }

    // The children of newParent into oldParent, leaving oldParent itself as it is.
    function morphChildren(oldParent, newParent) {
        var olds = [];
        var news = [];
        var c;
        for (c = oldParent.firstChild; c; c = c.nextSibling) olds.push(c);
        for (c = newParent.firstChild; c; c = c.nextSibling) news.push(c);
        var n = Math.min(olds.length, news.length);
        for (var i = 0; i < n; i++) morph(olds[i], news[i]);
        for (var j = n; j < olds.length; j++) oldParent.removeChild(olds[j]);
        for (var k = n; k < news.length; k++) oldParent.appendChild(news[k]);
    }

    // The poll's redraw of the page already on screen: in place when it can be.
    function showInPlace(view, screenId) {
        var old = firstElement(el.screen);
        if (!old || shownScreenId !== screenId || !canMorph()) {
            show(view);
            return;
        }
        morph(old, view);
        liftHead();
    }

    function show(view) {
        clear(el.screen);
        el.screen.appendChild(view);
        shownScreenId = current;
        liftHead();
    }

    // The page header node the pinned copy was made from.
    var liftedHead = null;
    var liftedHtml = '';

    function hasClass(n, cls) {
        return !!(n && n.nodeType === 1 && (' ' + n.className + ' ').indexOf(' ' + cls + ' ') >= 0);
    }

    function firstElement(n) {
        for (var c = n ? n.firstChild : null; c; c = c.nextSibling) if (c.nodeType === 1) return c;
        return null;
    }

    // Shows the page's header (the first child of its view, .ph-head) in the fixed slot, so Back
    // stays in reach however far the page is scrolled. The page keeps its header, hidden, so the
    // page transitions and the view cache, which move the page's own nodes, carry it unchanged.
    // The copy's Back runs the original's handler, which knows where to go.
    function liftHead() {
        var head = firstElement(firstElement(el.screen));
        if (!hasClass(head, 'ph-head')) {
            while (el.head.firstChild) el.head.removeChild(el.head.firstChild);
            el.head.style.display = 'none';
            liftedHead = null;
            liftedHtml = '';
            return;
        }
        // The same header as last time, unchanged (the redraw kept it): its copy is still right.
        var html = canMorph() ? fullOf(head) : '';
        if (head === liftedHead && html && html === liftedHtml && el.head.firstChild) return;
        while (el.head.firstChild) el.head.removeChild(el.head.firstChild);
        liftedHead = head;
        liftedHtml = html;
        if (!hasClass(head, 'ph-head-lifted')) head.className += ' ph-head-lifted';
        var copy = head.cloneNode(true);
        copy.className = copy.className.replace(/\s*ph-head-lifted/g, '');
        // Every tappable thing in the header, not just Back: the pinned copy is a clone, so a
        // button added by a page (the plus that opens a new group) would otherwise go dead.
        (function (from, to) {
            var a = from.getElementsByTagName('*');
            var b = to.getElementsByTagName('*');
            for (var i = 0; i < a.length && i < b.length; i++) {
                if (!a[i].tapHandler) continue;
                (function (node, fn) { onTap(node, function (e) { fn(e); }); })(b[i], a[i].tapHandler);
            }
        })(head, copy);
        el.head.appendChild(copy);
        el.head.style.display = '';
    }

    function refresh() {
        refreshStartedAt = Date.now();
        if (dcCurtain && dcCurtain.phase !== 'loading') return;
        if (transition && transition.after) return;
        var pre = preloaded && preloaded.screenId === current ? preloaded : null;
        // A page being opened with its data already on the way does not queue behind the
        // poll of the page it is leaving; that poll's answer is dropped for the old page anyway.
        if (busy && !pre) { pending = true; return; }
        preloaded = null;
        busy = true;
        lastRefreshAt = Date.now();
        var screenId = current;
        var screen = screens[screenId];
        var dcRead = appOfScreen(screenId) === 'dreamcar' || !!dcCurtain;
        var navigation = openSeq;
        refreshDropping = dropPlayedInput;
        dropPlayedInput = false;
        if (screenId === 'chat' || screenId === 'group') {
            if (refreshDropping) {
                smsDraft = '';
                smsFocused = false;
            } else if (screenId === 'chat') {
                rememberSms();
            } else {
                rememberGroup();
            }
        }

        Promise.resolve()
            .then(function () {
                if (playedYoung) return getEnv().then(function (env) { return { young: true, env: env }; }, function () { return { young: true }; });
                if (pre) return pre.promise;
                return screen.load();
            })
            .then(function (data) {
                if (dcRead && navigation !== openSeq) return;
                if (dcCurtain && dcCurtain.phase !== 'loading') return;
                loadFails[screenId] = 0;
                if (data && data.young) {
                    if (screenId !== current) return;
                    if (data.env) el.status.textContent = clockText(data.env);
                    wf.content.classList.remove('sms-open');
                    homeSetMode(false);
                    smsRenderedKey = '';
                    momentsRenderedKey = '';
                    aiRenderedKey = '';
                    personaRenderedKey = '';
                    show(renderTooYoung());
                    dcReadyCurtain();
                    return;
                }
                if (data && data.leave && screenId === 'chat' && current === 'chat') {
                    open('texts');
                    return;
                }
                if (screenId !== current) return;
                if (data && !STALE_UNSAFE[screenId]) lastData[screenId] = { data: data, at: Date.now(), played: playedId };
                if (data && data.env) el.status.textContent = clockText(data.env);
                if (screenId === 'home' && homeHolding()) {
                    homeRefreshWanted = true;
                    return;
                }
                var sameGroup = screenId === 'group' && data && data.meta &&
                    grpRenderedKey && grpRenderedKey === grpKey(data) && document.getElementById('sms-box');
                var sameThread = screenId === 'chat' && data && data.contact &&
                    smsRenderedKey && smsRenderedKey === threadKey(data.messages) + '|' + (data.portraitRev || 0) &&
                    document.getElementById('sms-box');
                var sameMoments = screenId === 'moments' && data && momentsRenderedKey &&
                    momentsRenderedKey === momentsRenderKey(data) && document.getElementById('mo-screen');
                var sameAi = screenId === 'ai' && data && aiRenderedKey &&
                    aiRenderedKey === aiRenderKey(data) && document.getElementById('ai-screen');
                // A draft being typed is never wiped by the poll, even when the files changed.
                var samePersona = screenId === 'persona' && data && document.getElementById('pe-screen') &&
                    ((personaRenderedKey && personaRenderedKey === personaRenderKey(data)) ||
                     (personaDraft && personaDraft.dirty && personaDraft.key === personaKey(data)));
                // Both guards must be tied to the element that is actually on screen. After a
                // rebuild the engine can still report a *removed* field as document.activeElement,
                // and then the guard would block every refresh: the page looks frozen.
                var activeEl = document.activeElement || null;
                var liveBox = document.getElementById('sms-box');
                var liveName = document.querySelector ? document.querySelector('.sms-gname') : null;
                var typingName = (screenId === 'groupName' || screenId === 'groupNew') &&
                    !!activeEl && activeEl === liveName;
                if (typingName) return;
                // Never rebuild the group page under the cursor: this engine drops the key
                // channel for the whole page when a text field is replaced mid-typing, and then
                // nothing but the input method can put text in any field.
                var forceDraw = grpForceDraw;
                grpForceDraw = false;
                var composing = grpComposing && Date.now() - grpComposingAt < 60000;
                var typingGroup = screenId === 'group' && (
                    composing || (!!activeEl && activeEl === liveBox && !!liveBox));
                if (typingGroup && !forceDraw) return;
                if (sameThread || sameGroup || sameMoments || sameAi || samePersona) {
                    if (sameThread) applySmsStatus(data, false);
                    if (sameGroup) wf.content.classList.add('sms-open');
                    if (noteFromLoad) {
                        setNote('', false);
                        noteFromLoad = false;
                    }
                    return;
                }
                // Same conversation, new text: keep the compose box. Rebuilding it while a word
                // is being composed sticks text input for the whole game session.
                if (screenId === 'group' && grpComposing && document.getElementById('sms-box')) return;
                if (screenId === 'group' && data && data.meta && !forceDraw && patchGroup(data)) {
                    if (noteFromLoad) { setNote('', false); noteFromLoad = false; }
                    return;
                }
                var chatLive = screenId === 'chat' && data && data.contact && document.getElementById('sms-box');
                if (chatLive && !refreshDropping && patchChat(data)) {
                    if (noteFromLoad) {
                        setNote('', false);
                        noteFromLoad = false;
                    }
                    return;
                }
                if (chatLive && smsComposing) {
                    if (refreshDropping) dropPlayedInput = true;
                    smsComposeRefresh = true;
                    return;
                }
                if (screenId !== 'chat') smsRenderedKey = '';
                if (screenId !== 'group') grpRenderedKey = '';
                if (screenId !== 'moments') momentsRenderedKey = '';
                if (screenId !== 'ai') aiRenderedKey = '';
                if (screenId !== 'persona') personaRenderedKey = '';
                var chat = screenId === 'chat' && data && data.contact;
                var group = screenId === 'group' && data && data.meta;
                if (chat || group) wf.content.classList.add('sms-open');
                else wf.content.classList.remove('sms-open');
                homeSetMode(screenId === 'home');
                var scrollTop = wf.content.scrollTop;
                if (screenId === 'moments') rememberMoments();
                if (screenId === 'ai') aiRemember();
                if (screenId === 'home') {
                    if (!homePatch(data)) {
                        show(screen.render(data));
                        homeMount();
                        if (transition && transition.kind === 'close' && transition.to === 'home') {
                            var back = iconRect(transition.from);
                            if (back) transition.icon = back;
                        }
                    }
                } else if (chat) {
                    show(screen.render(data));
                    applySmsStatus(data, true);
                    restoreSms();
                } else if (group) {
                    show(screen.render(data));
                    restoreGroup();
                } else {
                    showInPlace(screen.render(data), screenId);
                    if (screenId === 'group') restoreGroup();
                    wf.content.scrollTop = scrollTop;
                    if (screenId === 'moments') restoreMoments();
                    if (screenId === 'ai') aiRestore();
                    if (screenId === 'messages') gmScroll();
                }
                dcReadyCurtain();
                if (txCurtain) txSplashCheck();
                if (flCurtain) flSplashCheck();
                if (nwCurtain) nwSplashCheck();
                if (oaCurtain) oaSplashCheck();
                if (noteFromLoad) {
                    setNote('', false);
                    noteFromLoad = false;
                }
            }, function (err) {
                if (dcRead && navigation !== openSeq) return;
                if (screenId !== current) return;
                var msg = errText(err);
                loadFails[screenId] = (loadFails[screenId] || 0) + 1;
                traceLoad('fail ' + screenId + ' #' + loadFails[screenId] + ' +' + (Date.now() - openedAt) + 'ms ' + msg);
                if (loadFails[screenId] <= LOAD_RETRIES) {
                    console.warn('[HouseholdBoard/phone] ' + screenId + ' read failed, trying again (' + loadFails[screenId] + '): ' + msg);
                    if (loadRetryTimer) clearTimeout(loadRetryTimer);
                    loadRetryTimer = setTimeout(function () {
                        loadRetryTimer = null;
                        if (current === screenId) refresh();
                    }, LOAD_RETRY_MS * loadFails[screenId]);
                    return;
                }
                loadFails[screenId] = 0;
                wf.content.classList.remove('sms-open');
                homeSetMode(false);
                smsRenderedKey = '';
                show(messageView(screenId, 'Could not load this page.'));
                setNote(msg, true);
                noteFromLoad = true;
                if (dcCurtain) dcFailCurtain(dcCurtain);
                if (txCurtain) txSplashCheck();
                if (flCurtain) flSplashCheck();
                if (nwCurtain) nwSplashCheck();
                if (oaCurtain) oaSplashCheck();
                console.error('[HouseholdBoard/phone] ' + msg);
            })
            .then(function () {
                lastRefreshMs = refreshStartedAt ? Date.now() - refreshStartedAt : 0;
                busy = false;
                if (pending) {
                    pending = false;
                    refresh();
                }
            });
    }

    // Opening a page reads its data in the background and the motion starts right away: an icon
    // that dims and sits still for a second or two does not feel like a tap at all. The window
    // that grows out of the icon shows a loading card until the read lands, so nothing is
    // swapped out mid-motion, and the card is replaced in place when the data arrives.
    // A read that takes longer than OPEN_WAIT_MS still opens (on the same card); the wait only
    // lasts OPEN_GRACE_MS when the app is launched from the home screen, which is the tap that
    // has to answer at once. Pages that show one chosen thing (a conversation, a contact, a car)
    // keep the longer wait, since they must never open on another one's data.
    // A page seen before in this session opens at once on what it showed last time, and its
    // fresh data is laid over it in place once the animation has finished, the way a phone app
    // comes back with its last state.
    var OPEN_WAIT_MS = 2500;
    var OPEN_GRACE_MS = 80;
    var LAST_DATA_TTL_MS = 30 * 60 * 1000;
    var STALE_UNSAFE = { chat: true, persona: true, contact: true, storeapp: true, dccar: true, newsdetail: true };
    var OPEN_REPEAT_MS = 600;
    // Long enough for the slowest open (OPEN_WAIT_MS plus a veil), and short enough that a tap
    // lost by a dead open is answered by the next one instead of being swallowed forever.
    var OPEN_BUSY_MS = 3200;
    var openSeq = 0;
    var openWaiting = '';
    var openAskedAt = 0;
    var lastOpenId = '';
    var lastOpenAt = 0;
    var preloaded = null;
    var lastData = {};

    function awaitOpen(screenId) {
        openWaiting = screenId;
        openAskedAt = Date.now();
    }

    // A tap for the page already on its way is dropped, but only while that open is still alive.
    function awaiting(screenId) {
        return screenId === openWaiting && Date.now() - openAskedAt < OPEN_BUSY_MS;
    }

    function cachedUsable(screenId) {
        var c = viewCache[screenId];
        return !!c && Date.now() - c.at <= CACHE_TTL_MS && !cachedError(c.nodes);
    }

    function staleData(screenId) {
        var d = lastData[screenId];
        if (!d || STALE_UNSAFE[screenId] || String(d.played) !== String(playedId)) return null;
        if (Date.now() - d.at > LAST_DATA_TTL_MS) return null;
        return d.data;
    }

    // The window of a page whose content is still on the way: its title bar and nothing else.
    function blankView(screenId) {
        var wrap = node('div');
        if (screenId !== 'home') wrap.appendChild(subHeader(screenId));
        return wrap;
    }

    // Draws a page from earlier data; false when that data no longer fits the page.
    function showStale(screenId, data) {
        try {
            var view = screens[screenId].render(data);
            homeSetMode(screenId === 'home');
            // A conversation paints to the bottom edge and keeps its box in reach, exactly as the
            // read path does (refresh), or the page would stand on screen without its layout.
            if (screenId === 'chat') wf.content.classList.add('sms-open');
            show(view);
            if (screenId === 'chat') {
                applySmsStatus(data, true);
                restoreSms();
            }
            if (screenId === 'home') homeMount();
            return true;
        } catch (e) {
            delete lastData[screenId];
            return false;
        }
    }

    function open(screenId) {
        if (screenId !== 'home') homeEditStop();
        var owner = appOfScreen(screenId);
        if (owner && !appInstalled(owner)) screenId = 'store';
        if (!screens[screenId]) return;
        // One tap on Back can arrive as several clicks (the header and its pinned copy, and the
        // click window.js makes on mouseup); the repeats would cut the animation off and draw
        // the page again. A repeat that comes after that open died is a new tap.
        if (awaiting(screenId)) return;
        if (screenId === current && screenId === lastOpenId && Date.now() - lastOpenAt < OPEN_REPEAT_MS) return;
        if (!playedYoung && (dcCurtain ||
            ((appOfScreen(screenId) === 'dreamcar') !== (appOfScreen(current) === 'dreamcar')))) {
            dcNavigate(screenId);
            return;
        }
        if (txCurtain && screenId !== txCurtain.screen) txCurtainStop();
        if (flCurtain && screenId !== flCurtain.screen) flCurtainStop();
        if (nwCurtain && screenId !== nwCurtain.screen) nwCurtainStop();
        if (oaCurtain && screenId !== oaCurtain.screen) oaCurtainStop();
        // Texts opens on its own quiet veil, in either theme (index.html).
        if (!playedYoung && !dcCurtain && !txCurtain &&
            screenId === 'texts' && appOfScreen(current) !== 'texts') {
            txCurtainOpen(screenId);
            return;
        }
        // Freelance reads the service's board and the game's career record; the white network
        // cover stands in for that wait on every entry, while order details inside it do not.
        if (!playedYoung && !dcCurtain && !txCurtain && !flCurtain &&
            screenId === 'freelance' && appOfScreen(current) !== 'freelance') {
            flCurtainOpen(screenId);
            return;
        }
        // News has its own printed-edition cover, on every entry from outside the app. Opening a
        // story inside it keeps the normal page transition.
        if (!playedYoung && !dcCurtain && !txCurtain && !flCurtain && !nwCurtain &&
            screenId === 'news' && appOfScreen(current) !== 'news') {
            nwCurtainOpen(screenId);
            return;
        }
        // OA signs the employee in on its own office-suite cover, on every entry from outside the
        // app; its form, organisation and pay pages keep the normal page transition.
        if (!playedYoung && !dcCurtain && !txCurtain && !flCurtain && !nwCurtain && !oaCurtain &&
            screenId === 'oa' && appOfScreen(current) !== 'oa') {
            oaCurtainOpen(screenId);
            return;
        }
        var seq = ++openSeq;
        if (screenId === current || playedYoung || dropPlayedInput || cachedUsable(screenId) ||
            !transitionKind(current, screenId)) {
            openNow(screenId, null);
            return;
        }
        // A page whose data is already in hand opens on it: the motion answers the tap and the
        // fresh copy is laid over it once the animation has finished. The texts list has just
        // read every conversation it shows, so a row opens at once instead of re-reading the same
        // six files while the tap sits unanswered.
        if (staleData(screenId) || chatCached(screenId)) {
            openNow(screenId, { screenId: screenId, promise: Promise.resolve().then(function () { return screens[screenId].load(); }) });
            return;
        }
        var fromHome = current === 'home';
        var pre = { screenId: screenId, promise: null, done: false };
        pre.promise = Promise.resolve()
            .then(function () { return screens[screenId].load(); })
            .then(function (data) { pre.done = true; return data; },
                function (err) { pre.done = true; throw err; });
        var waitIcon = fromHome ? homeIcons[iconAppFor(screenId)] : null;
        if (waitIcon) waitIcon.classList.add('ph-icon-wait');
        var started = false;
        awaitOpen(screenId);
        var waitStamp = openAskedAt;
        var go = function () {
            if (waitIcon) waitIcon.classList.remove('ph-icon-wait');
            // This wait is over either way; leaving it behind is what made the page stop
            // answering taps after an open was dropped for a newer one.
            if (openWaiting === screenId && openAskedAt === waitStamp) openWaiting = '';
            if (started || seq !== openSeq) return;
            started = true;
            clearTimeout(timer);
            openNow(screenId, pre);
        };
        // Launched from the home screen the motion answers the tap at once; a page reached from
        // inside an app may still wait for its own data before it slides in.
        var timer = setTimeout(go, fromHome ? OPEN_GRACE_MS : OPEN_WAIT_MS);
        pre.promise.then(go, go);
    }

    function openNow(screenId, pre) {
        openSeq++;
        openWaiting = '';
        lastOpenId = screenId;
        lastOpenAt = Date.now();
        finishTransition();
        if (smsScrollRide) smsScrollRide.dead = true;
        if (emojiFoldTimer) { clearTimeout(emojiFoldTimer); emojiFoldTimer = null; }
        if (loadRetryTimer) { clearTimeout(loadRetryTimer); loadRetryTimer = null; }
        loadFails[screenId] = 0;
        var from = current;
        if (from === 'home') homeStop(true);
        // A swipe home hands its lift to the close animation below (startTransition).
        closeLift = takeHomeLift();
        var kind = transitionKind(from, screenId);
        if (kind === 'launch') {
            launchRects[screenId] = iconRect(screenId);
            if (!launchRects[screenId]) kind = 'fade';
        }
        var ghost = kind ? captureOutgoing(from) : null;
        if (!ghost) kind = null;
        if (dcCurtain || txCurtain || flCurtain) {
            if (ghost) releaseOutgoing(ghost);
            ghost = null;
            kind = null;
        }
        current = screenId;
        smsRenderedKey = '';
        momentsRenderedKey = '';
        aiRenderedKey = '';
        if (from === 'ai' && screenId !== 'ai') aiKeyDraft = '';
        if (from === 'bookread' && screenId !== 'bookread') bkMusicStop('page left');
        if (screenId === 'ai' && from !== 'ai') {
            aiCopyResult = null;
            aiDraft = null;
            aiKeyDraft = '';
            aiConfirmForget = '';
            if (!aiPending && !aiSaving) aiResult = null;
        }
        if (screenId !== 'moments') {
            momentsComposer = null;
            momentsConfirmDelete = null;
            momentsFocus = null;
            momentsComposeOpen = false;
            momentsMenuPost = null;
        }
        var dcRoot = document.getElementById('app-root');
        // Dream Car paints the whole phone as its showroom (index.html).
        if (dcRoot) {
            if (appOfScreen(screenId) === 'dreamcar') dcRoot.classList.add('dc-mode');
            else dcRoot.classList.remove('dc-mode');
        }
        // News holds the whole phone as a sheet of paper, the way Dream Car holds it as a
        // showroom (index.html #app-root.nw-open): the paper has to reach the status bar and
        // the bottom edge, or the wallpaper shows above and below the columns.
        if (appOfScreen(screenId) === 'news') {
            if (dcRoot) dcRoot.classList.add('nw-open');
        } else if (dcRoot) {
            dcRoot.classList.remove('nw-open');
        }
        // A thread opened anew starts on its newest messages again; back from its persona page
        // it keeps what was shown.
        if (screenId === 'chat' && from !== 'chat' && from !== 'persona') smsWindow = { section: '', count: SMS_PAGE };
        if (screenId !== 'chat') {
            wf.content.classList.remove('sms-open');
            smsThread = null;
            smsShownSection = '';
            smsComposeRefresh = false;
        }
        if (screenId !== 'persona') {
            personaDraft = null;
            personaNote = null;
        }
        if (screenId !== 'wallpaper') wallConfirm = '';
        if (screenId === 'wallpaper' && from !== 'wallpaper' && !wallPending) wallResult = null;
        silenceOpenChatBanner();
        openedAt = Date.now();
        var cached = takeCached(screenId);
        if (cached && cachedError(cached.nodes)) {
            traceLoad('cached error page dropped ' + screenId + ' from ' + from);
            cached = null;
        }
        homeSetMode(!!cached && screenId === 'home');
        var stale = null;
        if (cached) {
            showNodes(cached.nodes);
            wf.content.scrollTop = cached.scroll;
            if (screenId === 'home') homeMount();
        } else {
            stale = staleData(screenId) || chatCached(screenId);
            // A conversation opens on the copy the texts list has just read. Nothing of the
            // conversation left behind may come with it: its draft, its last-arrived marks, its
            // scroll position. loadChat makes the same reset once it has read the real one.
            if (stale && screenId === 'chat' && smsThread !== stale.section) {
                smsDraft = '';
                smsArrived = null;
                smsStick = true;
            }
            if (!stale || !showStale(screenId, stale)) {
                stale = null;
                // Data still on its way: say so, instead of an empty page under the header.
                show(pre && pre.done === false ? messageView(screenId, 'Loading…') : blankView(screenId));
            }
            wf.content.scrollTop = 0;
            preloaded = pre;
        }
        traceNav('open ' + screenId + ' from ' + from + ' kind ' + kind + ' via ' + (cached ? 'cache' : stale ? 'last data' : 'blank') +
            (screenId === 'home' && homeView ? ' tiles ' + homeView.tiles.length + ' pages ' + homeView.pages.length : ''));
        if (kind) startTransition(kind, ghost, from, screenId);
        if (dcCurtain && appOfScreen(screenId) !== 'dreamcar' && (cached || stale)) dcReadyCurtain();
        // A page that is already drawn (from the cache or from its earlier data) gets its fresh
        // data after the animation, so it is not rebuilt while it is still moving.
        if (kind && (cached || stale) && transition) {
            transition.after = function () { if (current === screenId) refresh(); };
        } else {
            refresh();
        }
    }

    // The played character changed. Rebuild the open page for that person, and keep a
    // text thread open by turning it around when you switch to the person you were writing to.
    function onPlayedChanged(prev, next) {
        dropPlayedInput = true;
        clearBannerQueue();
        viewCache = {};
        lastData = {};
        chatLast = {};
        forgetReads();
        smsRenderedKey = '';
        momentsRenderedKey = '';
        smsThread = null;
        smsClearAsk = false;
        smsStick = true;
        smsPhotos = {};
        smsPhotoPending = null;
        personaDraft = null;
        personaNote = null;
        jobsMemberId = next;
        jobsConfirmKey = null;
        flOpenId = null;
        flConfirmKey = null;
        gmOpenKey = null;
        momentsComposer = null;
        momentsConfirmDelete = null;
        momentsMenuPost = null;
        momentsComposeOpen = false;
        momentsEmojiFor = null;
        if (current === 'chat' && smsContactId && String(smsContactId) === String(next)) smsContactId = prev;
        refresh();
    }

    function checkPlayedAge(force) {
        if (playedAgeBusy || (!force && Date.now() - playedAgeAt < PLAYED_AGE_POLL_MS)) return;
        playedAgeBusy = true;
        playedAgeAt = Date.now();
        Promise.all([getPossessedId(), getMembers()]).then(function (r) {
            var me = memberById(r[1] || [], String(r[0] || ''));
            if (!me) return;
            var young = !!NO_PHONE_STEPS[me.age_group];
            playedYoungInfo = young ? me : null;
            if (young === playedYoung) return;
            playedYoung = young;
            if (young) hideBanner(true);
            refresh();
        }, function () {}).then(function () {
            playedAgeBusy = false;
        });
    }

    function renderTooYoung() {
        var me = playedYoungInfo || {};
        var wrap = node('div', 'ph-young');
        var badge = node('div', 'ph-young-icon');
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'ph-young-glyph');
        glyphPath(svg, 'M8 2.5h8c1.4 0 2.5 1.1 2.5 2.5v14c0 1.4-1.1 2.5-2.5 2.5H8c-1.4 0-2.5-1.1-2.5-2.5V5c0-1.4 1.1-2.5 2.5-2.5zM8 4.5c-.3 0-.5.2-.5.5v14c0 .3.2.5.5.5h8c.3 0 .5-.2.5-.5V5c0-.3-.2-.5-.5-.5H8zM10.5 17.2h3v1.3h-3z', '#ffffff', 'evenodd');
        glyphPath(svg, 'M12 8.2a2.3 2.3 0 0 1 2.3 2.3v1h.4c.4 0 .7.3.7.7v2.8c0 .4-.3.7-.7.7H9.3a.7.7 0 0 1-.7-.7v-2.8c0-.4.3-.7.7-.7h.4v-1A2.3 2.3 0 0 1 12 8.2zm0 1.2c-.6 0-1.1.5-1.1 1.1v1h2.2v-1c0-.6-.5-1.1-1.1-1.1z', '#ffffff');
        badge.appendChild(svg);
        wrap.appendChild(badge);
        wrap.appendChild(node('div', 'ph-young-title', 'Too Young for a Phone'));
        var who = me.first_name || (me.entity_id ? fullName(me) : 'This Zoi');
        var stage = me.age_group === 'Toddler' ? 'a toddler' : 'a baby';
        wrap.appendChild(node('div', 'ph-young-text', who + ' is ' + stage + ' right now. The phone unlocks once they grow into a child.'));
        return wrap;
    }

    function watchPlayed() {
        layoutBanner();
        checkPlayedAge(false);
        if (possessBusy || cliBacklogged()) return;
        possessBusy = true;
        getPossessedId().then(function (id) {
            id = String(id || '');
            if (!id || id === 'undefined' || id === 'null') return;
            if (!playedId) {
                playedId = id;
                return;
            }
            if (id === playedId) return;
            var prev = playedId;
            playedId = id;
            checkPlayedAge(true);
            onPlayedChanged(prev, id);
        }, function () {}).then(function () {
            possessBusy = false;
        });
    }

