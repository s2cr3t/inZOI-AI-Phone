    // ------------------------------------------------------------------
    // Incoming text banner. One card at a time, under the status bar. A click opens that
    // conversation. A short upward drag dismisses it. Texts already stored before this
    // view loaded are not announced again.
    // ------------------------------------------------------------------
    function bannerKey(meId, contactId) { return String(meId) + '-' + String(contactId); }

    function bannerMinimized() { return !!(wf.root && wf.root._minimized); }

    function newestIncoming(list) {
        var best = null;
        for (var i = 0; i < list.length; i++) {
            if (!list[i] || typeof list[i].at !== 'number') continue;
            if (!best || list[i].at > best.at) best = list[i];
        }
        return best;
    }

    function bannerPreview(text) {
        var s = String(text || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
        if (s.length > 80) s = s.slice(0, 80) + '...';
        return s;
    }

    function dropQueuedBanner(contactId) {
        var id = String(contactId);
        var next = [];
        for (var i = 0; i < bannerQueue.length; i++) {
            if (bannerQueue[i].contactId !== id) next.push(bannerQueue[i]);
        }
        bannerQueue = next;
    }

    function silenceOpenChatBanner() {
        if (current !== 'chat' || !smsContactId) return;
        var id = String(smsContactId);
        dropQueuedBanner(id);
        if (bannerItem && bannerItem.contactId === id) hideBanner(true);
    }

    function syncBannerBox() {
        if (!bannerMinimized()) return;
        if (wf.root && typeof wf.root._applyMinimize === 'function') wf.root._applyMinimize(true);
    }

    function layoutBanner() {
        if (!bannerEl || bannerEl.className.indexOf('show') < 0) return;
        var dock = bannerMinimized();
        var has = bannerEl.className.indexOf('dock') >= 0;
        if (dock === has) return;
        bannerEl.className = dock ? 'ph-banner show dock' : 'ph-banner show';
        if (bannerHiding) bannerEl.className = bannerEl.className + ' leave';
        if (dock) syncBannerBox();
    }

    // cohtml does not replay a CSS animation that already ran while the banner was hidden.
    // Clearing it and forcing layout makes each appearance slide in again.
    function playBannerMotion(name, ms, ease) {
        var card = document.getElementById('ph-banner-card');
        if (!card) return;
        card.style.webkitAnimation = 'none';
        card.style.animation = 'none';
        void card.offsetWidth;
        var value = name + ' ' + ms + 'ms ' + ease;
        card.style.webkitAnimation = value;
        card.style.animation = value;
    }

    function paintBanner(item) {
        var av = document.getElementById('ph-banner-av');
        var name = document.getElementById('ph-banner-name');
        var text = document.getElementById('ph-banner-text');
        var card = document.getElementById('ph-banner-card');
        if (!av || !name || !text) return;
        var label = item.name || fullName(item.contact);
        var app = document.getElementById('ph-banner-app');
        if (app) app.textContent = item.app || 'Texts';
        clear(av);
        if (item.contact) {
            av.appendChild(faceAvatar(item.contact));
        } else {
            // A system sender of the game's messages: a letter, like in the Messages list.
            var letter = node('div', 'ph-avatar', (label || '?').charAt(0));
            letter.style.background = '#636366';
            av.appendChild(letter);
        }
        name.textContent = label;
        text.textContent = bannerPreview(item.text);
        if (card) {
            card.setAttribute('title', label + ': ' + bannerPreview(item.text));
            setTransform(card, '');
        }
    }

    function ensureBanner() {
        if (bannerEl) return bannerEl;
        bannerEl = node('div', 'ph-banner');
        var card = node('div', 'ph-banner-card');
        card.id = 'ph-banner-card';
        var av = node('div', 'ph-banner-av');
        av.id = 'ph-banner-av';
        var body = node('div', 'ph-banner-body');
        var top = node('div', 'ph-banner-top');
        var appLabel = node('div', 'ph-banner-app', 'Texts');
        appLabel.id = 'ph-banner-app';
        top.appendChild(appLabel);
        var time = node('div', 'ph-banner-time', 'now');
        time.id = 'ph-banner-time';
        top.appendChild(time);
        var name = node('div', 'ph-banner-name');
        name.id = 'ph-banner-name';
        var text = node('div', 'ph-banner-text');
        text.id = 'ph-banner-text';
        body.appendChild(top);
        body.appendChild(name);
        body.appendChild(text);
        card.appendChild(av);
        card.appendChild(body);
        bannerEl.appendChild(card);
        wf.root.appendChild(bannerEl);
        bannerEl.addEventListener('mousedown', function (e) {
            if (e.button && e.button !== 0) return;
            bannerDownY = e.clientY;
            bannerDragY = 0;
            bannerPress = pressStart(e);
        });
        onTap(bannerEl, function () {
            if (bannerDragY < -BANNER_SWIPE_PX) return;
            if (bannerItem) openBannerChat(bannerItem);
        });
        document.addEventListener('mousemove', function (e) {
            if (bannerDownY === null || !bannerItem) return;
            if (pressLost(e, bannerPress)) {
                bannerRelease();
                return;
            }
            var dy = e.clientY - bannerDownY;
            if (dy > 0) dy = 0;
            bannerDragY = dy;
            var live = document.getElementById('ph-banner-card');
            if (live) setTransform(live, 'translateY(' + dy + 'px)');
        });
        document.addEventListener('mouseup', bannerRelease);
        document.addEventListener('mouseout', function (e) {
            if (bannerDownY !== null && leftPhone(e)) bannerRelease();
        });
        window.addEventListener('blur', bannerRelease);
        return bannerEl;
    }

    function bannerRelease() {
        if (bannerDownY === null) return;
        var dy = bannerDragY;
        bannerDownY = null;
        bannerDragY = 0;
        bannerPress = null;
        var live = document.getElementById('ph-banner-card');
        if (live) setTransform(live, '');
        if (dy < -BANNER_SWIPE_PX) hideBanner(false);
    }

    function armBannerTimer() {
        if (bannerTimer) clearTimeout(bannerTimer);
        bannerTimer = setTimeout(function () {
            bannerTimer = 0;
            if (bannerDownY !== null) {
                armBannerTimer();
                return;
            }
            hideBanner(false);
        }, BANNER_HOLD_MS);
    }

    function presentBanner(item) {
        ensureBanner();
        bannerItem = item;
        bannerHiding = false;
        paintBanner(item);
        bannerEl.className = 'ph-banner show' + (bannerMinimized() ? ' dock' : '');
        playBannerMotion('ph-banner-in', 280, 'ease-out');
        armBannerTimer();
        syncBannerBox();
    }

    function showNextBanner() {
        if (bannerItem || bannerHiding) return;
        if (playedYoung) { bannerQueue.length = 0; return; }
        while (bannerQueue.length) {
            var item = bannerQueue.shift();
            if (current === 'chat' && String(smsContactId) === item.contactId) continue;
            if (item.gmKey && current === 'messages' && gmOpenKey === item.gmKey) continue;
            presentBanner(item);
            return;
        }
    }

    function dismissBannerNow() {
        if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = 0; }
        bannerItem = null;
        bannerHiding = false;
        bannerDownY = null;
        bannerDragY = 0;
        if (!bannerEl) return;
        bannerEl.className = 'ph-banner';
        var card = document.getElementById('ph-banner-card');
        if (card) setTransform(card, '');
    }

    function hideBanner(immediate) {
        if (!bannerEl || (bannerEl.className.indexOf('show') < 0 && !bannerItem)) {
            showNextBanner();
            return;
        }
        if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = 0; }
        bannerItem = null;
        if (immediate) {
            bannerHiding = false;
            bannerEl.className = 'ph-banner';
            syncBannerBox();
            showNextBanner();
            return;
        }
        if (bannerHiding) return;
        bannerHiding = true;
        bannerEl.className = 'ph-banner show leave' + (bannerMinimized() ? ' dock' : '');
        playBannerMotion('ph-banner-out', 220, 'ease-in');
        setTimeout(function () {
            if (!bannerHiding) return;
            bannerHiding = false;
            if (bannerItem) return;
            if (bannerEl) bannerEl.className = 'ph-banner';
            syncBannerBox();
            showNextBanner();
        }, 220);
    }

    function clearBannerQueue() {
        bannerQueue = [];
        dismissBannerNow();
        syncBannerBox();
    }

    function openBannerChat(item) {
        if (!item) return;
        dropQueuedBanner(item.contactId);
        dismissBannerNow();
        if (wf.root && wf.root._minimized && typeof wf.root._applyMinimize === 'function') {
            wf.root._applyMinimize(false);
            if (typeof wf.root._saveWindowState === 'function') wf.root._saveWindowState();
        }
        if (item.gmKey) {
            gmOpenKey = item.gmKey;
            open('messages');
        } else {
            smsContactId = item.contactId;
            open('chat');
        }
        showNextBanner();
    }

    function offerBanner(item) {
        if (bannerItem && bannerItem.key === item.key && !bannerHiding) {
            bannerItem = item;
            paintBanner(item);
            armBannerTimer();
            return;
        }
        for (var i = 0; i < bannerQueue.length; i++) {
            if (bannerQueue[i].key === item.key) {
                bannerQueue[i] = item;
                return;
            }
        }
        bannerQueue.push(item);
        if (!bannerItem && !bannerHiding) showNextBanner();
    }

    // One sound per check: the text tone when a banner is offered, otherwise the received
    // pop for a text in the conversation that is open.
    function applyBannerRows(me, rows) {
        var first = !bannerReady[me];
        var toned = false;
        var popped = false;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!row || !row.msg) continue;
            var id = String(row.contact.entity_id);
            var key = bannerKey(me, id);
            var prev = bannerAt[key] || 0;
            if (row.msg.at <= prev) continue;
            var fresh = row.msg.at >= bannerBorn - BANNER_GRACE_MS;
            bannerAt[key] = row.msg.at;
            if (first && !fresh) continue;
            if (current === 'chat' && String(smsContactId) === id) {
                dropQueuedBanner(id);
                if (bannerItem && bannerItem.contactId === id) hideBanner(true);
                popped = true;
                continue;
            }
            offerBanner({
                key: key,
                contactId: id,
                contact: row.contact,
                text: row.msg.text,
                at: row.msg.at
            });
            toned = true;
        }
        bannerReady[me] = true;
        if (toned) soundTone(false);
        else if (popped) soundPlay('received');
    }

    // Only the two files that can hold the contact's words. seen/status/outbox are not needed
    // to decide whether a banner should appear.
    function bannerProbe(me, contact) {
        var id = contact.entity_id;
        return Promise.all([
            loadBox('inbox', smsSection(me, id)),
            loadBox('outbox', smsSection(id, me))
        ]).then(function (d) {
            return { contact: contact, msg: newestIncoming(d[0].concat(prefixIds(d[1], 'r-'))) };
        }, function () { return null; });
    }

    // Banners for the game's own phone messages (the Messages app). gmBannerAt keeps, per played
    // character, the newest incoming message already handled; the first look only notes it, so
    // the history already in the phone is not announced.
    var GM_BANNER_POLL_MS = 4000;
    var gmBannerAt = {};
    var gmBannerBusy = false;

    function gmBannerItems(me, comp) {
        var threads = gmThreads(comp);
        var newest = '';
        var fresh = [];
        threads.forEach(function (t) {
            var last = null;
            t.messages.forEach(function (m) {
                if (m.sent) return;
                if (m.at > newest) newest = m.at;
                if (!last || m.at > last.at) last = m;
            });
            if (last && gmBannerAt[me] !== undefined && last.at > gmBannerAt[me]) fresh.push({ thread: t, msg: last });
        });
        var first = gmBannerAt[me] === undefined;
        if (first || newest > gmBannerAt[me]) gmBannerAt[me] = newest;
        return first ? [] : fresh;
    }

    function watchGmBanner() {
        if (gmBannerBusy || cliBacklogged() || !playedId || playedYoung || !appInstalled('messages')) return;
        gmBannerBusy = true;
        var me = String(playedId);
        var items = [];
        gmLoadComponent(me).then(function (comp) {
            items = gmBannerItems(me, comp);
            if (!items.length) return null;
            var keys = [];
            var systems = [];
            items.forEach(function (it) {
                if (!it.msg.plain && it.msg.key) keys.push(it.msg.key);
                if (it.thread.kind === 's') systems.push(it.thread.target.split(';')[0]);
            });
            return Promise.all([
                flRows(gmSystemRows, 'MobileMessageSystem', systems),
                Promise.all(items.filter(function (it) { return it.thread.kind === 'p'; }).map(function (it) { return flName(it.thread.target); }))
            ]).then(function () {
                systems.forEach(function (id) {
                    var row = gmSystemRows[id];
                    (row && Array.isArray(row.systems) ? row.systems : []).forEach(function (s) { keys.push(s.displayNameTextId); });
                });
                return localize(keys);
            });
        }).then(function (text) {
            if (!items.length || String(me) !== String(playedId)) return;
            var view = { text: text || l10nCache };
            var toned = false;
            items.forEach(function (it) {
                var t = it.thread;
                if (current === 'messages' && gmOpenKey === t.key) return;
                var name = gmTitle(view, t);
                offerBanner({
                    key: 'gm-' + me + '-' + t.key,
                    contactId: 'gm:' + t.key,
                    gmKey: t.key,
                    app: 'Messages',
                    name: name,
                    contact: t.kind === 'p' ? { entity_id: t.target, name: name, first_name: name } : null,
                    text: gmText(view, it.msg).replace(/\s+/g, ' '),
                    at: Date.now()
                });
                toned = true;
            });
            if (toned) soundTone(false);
        }).then(null, function (err) {
            console.error('[HouseholdBoard/phone] message banner: ' + errText(err));
        }).then(function () {
            gmBannerBusy = false;
        });
    }

    function watchBanner() {
        if (bannerBusy || cliBacklogged() || !playedId || playedYoung || smsClearingAt || !appInstalled('texts')) return;
        bannerBusy = true;
        var me = playedId;
        getMembers().then(function (members) {
            return Promise.all([loadPortraitIndex(), loadSmsIndex(me)]).then(function (r) {
                var contacts = textContacts(me, members);
                var idx = r[1];
                // The index already holds every chat's newest incoming line (lib/smsindex.js).
                if (idx) {
                    return contacts.map(function (c) {
                        var row = idx.threads[String(c.entity_id)];
                        var m = row && row.lastIn && typeof row.lastIn.at === 'number' && typeof row.lastIn.text === 'string' ? row.lastIn : null;
                        return { contact: c, msg: m };
                    });
                }
                var jobs = [];
                for (var i = 0; i < contacts.length; i++) jobs.push(bannerProbe(me, contacts[i]));
                return Promise.all(jobs);
            });
        }).then(function (rows) {
            try {
                if (rows && String(me) === String(playedId)) applyBannerRows(me, rows);
            } catch (err) {
                console.error('[HouseholdBoard/phone] banner: ' + errText(err));
            }
        }, function () {}).then(function () {
            bannerBusy = false;
        }, function () {
            bannerBusy = false;
        });
    }

    soundInit();
    wallInit();
    appsLoad();
    loadOutside();
    open('home');
    setInterval(watchPlayed, POSSESS_POLL_MS);
    setInterval(watchBanner, BANNER_POLL_MS);
    setInterval(watchGmBanner, GM_BANNER_POLL_MS);
    // The browser preview (tools/phone-preview.js) cannot reach anything inside this closure.
    window.__phoneDebug = {
        open: open,
        openGroup: openGroup,
        screen: function () { return current; },
        stats: function () { return { ms: lastRefreshMs, busy: busy, started: refreshStartedAt, now: Date.now() }; },
        grp: function () {
            return {
                shownId: grpShownId,
                shown: grpShown ? Object.keys(grpShown).length : -1,
                key: grpRenderedKey,
                rows: document.querySelectorAll ? document.querySelectorAll('.sms-grow').length : -1
            };
        }
    };
    try {
        call('uimod.cfg_save', { mod_id: SMS_MOD, section: 'ui/phone/groups', key: 'build', value: JSON.stringify({ v: SMS_BUILD, at: Date.now() }) })
            .then(function () {}, function () {});
    } catch (e) {}
    setInterval(function () {
        // If a refresh never settled (a page that threw, an engine hiccup), the page would stop
        // updating for good: unstick it rather than leave the phone frozen.
        if (busy && refreshStartedAt && Date.now() - refreshStartedAt > 10000) {
            busy = false;
            pending = false;
        }
        var due = current === 'texts' || current === 'chat' || current === 'group' || current === 'groupNew' ||
            current === 'moments' || current === 'ai' ? TEXTS_POLL_MS : POLL_MS;
        if (Date.now() - lastRefreshAt >= due) refresh();
    }, 1000);
})();
