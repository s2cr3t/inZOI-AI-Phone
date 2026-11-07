    // ------------------------------------------------------------------
    // Messages: the game's own phone messages (FB2MobileMessageComponent), no AI.
    // ------------------------------------------------------------------
    // The threads are read straight from the game (entity.reflect). Answering a message that
    // waits for one goes through the HouseholdJournal Lua mod, which reads
    //   ui/phone/messages/request.cfg   <seq>:<actor>:p:<partner id>:<type> or
    //                                   <seq>:<actor>:s:<system id>:<type>. Phone only.
    // and gives the game that answer, so the game writes the reply and applies its effects.
    // The game has no call to mark a message read, so what the player has looked at here is kept in
    //   ui/phone/messages/<playerId>/seen.cfg   { <thread key>: <newest timestamp seen> }. Phone only.
    var GM_SECTION = 'ui/phone/messages';
    var GM_WAIT_TRIES = 10;
    // EB1MobileMessageResponseType, in the order the game's phone shows the buttons.
    var GM_ANSWERS = [
        { type: 1, key: 'positive', label: 'Yes' },
        { type: 0, key: 'normal', label: 'Okay' },
        { type: 2, key: 'negative', label: 'No' }
    ];
    var gmOpenKey = null;
    // The thread last drawn and how many messages it had, to tell an opened thread or a new
    // message (scroll to the end) from the poll redrawing the same one (keep the scroll).
    var gmShownKey = null;
    var gmShownCount = 0;
    var gmToEnd = false;
    // Where the list was scrolled when a thread was opened, for Back.
    var gmListScroll = 0;
    var gmBusy = false;
    var gmPoolRows = {};
    var gmSystemRows = {};
    var lastMessagesData = null;

    function gmSeenSection(me) { return GM_SECTION + '/' + me; }

    function gmLoadSeen(me) {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: gmSeenSection(me), key: 'seen' }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
            }, function () { return {}; });
    }

    function gmLoadComponent(me) {
        return call('entity.reflect', { entity_id: String(me), Component: 'FB2MobileMessageComponent' }, 'messageList');
    }

    // "<b>text</>" rich text of system messages, and the bullet images, as plain lines.
    function gmPlain(text) {
        return String(text || '')
            .replace(/<img[^>]*\/>/g, '• ')
            .replace(/<\/?[A-Za-z_]*>/g, '')
            .replace(/\r\n?/g, '\n')
            .replace(/•[ \t]*\n/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/^\s+|\s+$/g, '');
    }

    function gmMessages(list) {
        return (Array.isArray(list) ? list : []).map(function (m, i) {
            var custom = m.customResponse && m.customResponse.dtId && m.customResponse.dtId !== 'None' ? m.customResponse : null;
            return {
                index: i,
                key: m.messageId || '',
                plain: m.bIsPlainText ? gmPlain(m.messageText) : '',
                sent: !!m.bIsSend,
                at: String(m.timestamp || ''),
                need: !!m.bNeedResponse && !m.bIsSend,
                read: !!m.bIsRead,
                ignored: !!m.bIsIgnored,
                wait: !!m.bIsWait,
                pool: m.poolId && m.poolId !== 'None' ? m.poolId : '',
                custom: custom
            };
        });
    }

    // Threads with a person ("(Value=20524)") and with a system sender ("bank;Gangnam_Map").
    function gmThreads(comp) {
        var out = [];
        var people = comp && comp.messageList && comp.messageList.mobileMessageListMap || {};
        Object.keys(people).forEach(function (k) {
            var m = /^\(Value=(\d+)\)$/.exec(k);
            if (!m) return;
            var msgs = gmMessages(people[k].mobileMessageList).filter(function (x) { return !x.wait; });
            if (msgs.length) out.push({ key: 'p:' + m[1], kind: 'p', target: m[1], messages: msgs, custom: people[k].customResponse });
        });
        var systems = comp && comp.messageListBySystem && comp.messageListBySystem.mobileMessageListMap || {};
        Object.keys(systems).forEach(function (k) {
            if (!/^[\w;-]+$/.test(k)) return;
            var msgs = gmMessages(systems[k].mobileMessageList).filter(function (x) { return !x.wait; });
            if (msgs.length) out.push({ key: 's:' + k, kind: 's', target: k, messages: msgs, custom: systems[k].customResponse });
        });
        out.forEach(function (t) { t.last = t.messages[t.messages.length - 1]; });
        out.sort(function (a, b) { return a.last.at < b.last.at ? 1 : a.last.at > b.last.at ? -1 : 0; });
        return out;
    }

    // The answer buttons of the message waiting for one: the event's own answers, or the button
    // labels of the message pool, as the game's phone shows them.
    function gmAnswerKeys(thread) {
        var m = null;
        for (var i = thread.messages.length - 1; i >= 0; i--) {
            if (thread.messages[i].need) { m = thread.messages[i]; break; }
        }
        if (!m) return null;
        var custom = m.custom || (thread.custom && thread.custom.dtId && thread.custom.dtId !== 'None' ? thread.custom : null);
        var row = m.pool ? gmPoolRows[m.pool] : null;
        var keys = {};
        GM_ANSWERS.forEach(function (a) {
            keys[a.key] = custom ? (custom[a.key + 'AnswerStrId'] || '')
                : row ? (row[a.key + 'AnswerButtonStrId'] || '') : '';
        });
        return { message: m, keys: keys, plain: !custom && !row };
    }

    function gmSystemName(data, target) {
        var parts = target.split(';');
        var row = gmSystemRows[parts[0]];
        var list = row && Array.isArray(row.systems) ? row.systems : [];
        var hit = null;
        list.forEach(function (s) { if (s.mapId === parts[1]) hit = s; });
        if (!hit) list.forEach(function (s) { if (!hit && s.mapId === 'Default') hit = s; });
        return (hit && data.text[hit.displayNameTextId]) || parts[0];
    }

    function gmTitle(data, t) {
        return t.kind === 'p' ? (flNames[t.target] || ('#' + t.target)) : gmSystemName(data, t.target);
    }

    function gmText(data, m) {
        if (m.plain) return m.plain;
        var text = data.text[m.key] || '';
        return text ? gmPlain(text) : '…';
    }

    // Unread: from them, newer than what was looked at here, or unread in the game when this
    // thread was never opened here.
    function gmUnread(data, t) {
        var seen = data.seen[t.key];
        var n = 0;
        t.messages.forEach(function (m) {
            if (m.sent) return;
            if (seen ? m.at > seen : !m.read) n += 1;
        });
        return n;
    }

    // "0003.10.02-17.12.00" -> { day: "10/02", time: "17:12" }
    function gmWhen(at) {
        var m = /^(\d+)\.(\d+)\.(\d+)-(\d+)\.(\d+)/.exec(at || '');
        if (!m) return { day: '', time: '' };
        return { day: m[2] + '/' + m[3], time: m[4] + ':' + m[5] };
    }

    function loadMessages() {
        var env, me, comp, seen;
        return Promise.all([getEnv(), getPossessedId(), loadEmojiSet()]).then(function (r) {
            env = r[0];
            me = r[1];
            return Promise.all([gmLoadComponent(me), gmLoadSeen(me)]);
        }).then(function (r) {
            comp = r[0];
            seen = r[1];
            var threads = gmThreads(comp);
            if (gmOpenKey && !threads.some(function (t) { return t.key === gmOpenKey; })) gmOpenKey = null;
            var pools = [];
            var systems = [];
            threads.forEach(function (t) {
                if (t.kind === 's') {
                    var id = t.target.split(';')[0];
                    if (systems.indexOf(id) < 0) systems.push(id);
                }
                t.messages.forEach(function (m) { if (m.need && m.pool && pools.indexOf(m.pool) < 0) pools.push(m.pool); });
            });
            return Promise.all([
                flRows(gmPoolRows, 'MobileMessage', pools),
                flRows(gmSystemRows, 'MobileMessageSystem', systems),
                Promise.all(threads.filter(function (t) { return t.kind === 'p'; }).map(function (t) { return flName(t.target); }))
            ]).then(function () {
                var keys = [];
                threads.forEach(function (t) {
                    // Only the newest message for the list; every message of the open thread.
                    var msgs = t.key === gmOpenKey ? t.messages : [t.last];
                    msgs.forEach(function (m) { if (!m.plain && m.key) keys.push(m.key); });
                    var ans = gmAnswerKeys(t);
                    if (ans) GM_ANSWERS.forEach(function (a) { if (ans.keys[a.key]) keys.push(ans.keys[a.key]); });
                    if (t.kind === 's') {
                        var row = gmSystemRows[t.target.split(';')[0]];
                        (row && Array.isArray(row.systems) ? row.systems : []).forEach(function (s) { keys.push(s.displayNameTextId); });
                    }
                });
                return localize(keys).then(function (text) {
                    return { env: env, me: me, threads: threads, seen: seen, text: text };
                });
            });
        });
    }

    function rerenderMessages() {
        if (!lastMessagesData || current !== 'messages') return;
        var scrollTop = wf.content.scrollTop;
        show(renderMessages(lastMessagesData));
        wf.content.scrollTop = scrollTop;
        gmScroll();
    }

    function gmMarkSeen(data, t) {
        var at = t.last.at;
        if (!at || data.seen[t.key] === at) return;
        data.seen[t.key] = at;
        call('uimod.cfg_save', {
            mod_id: SMS_MOD,
            section: gmSeenSection(data.me),
            key: 'seen',
            value: JSON.stringify(data.seen)
        }).then(null, function () {});
    }

    // Waits until the game shows the answer: the message no longer waits, or new ones came.
    function gmAwait(me, threadKey, count, tries) {
        return gmLoadComponent(me).then(function (comp) {
            var t = gmThreads(comp).filter(function (x) { return x.key === threadKey; })[0];
            if (t && (t.messages.length > count || !gmAnswerKeys(t))) return true;
            if (tries <= 1) return false;
            return wait(800).then(function () { return gmAwait(me, threadKey, count, tries - 1); });
        }, function () {
            if (tries <= 1) return false;
            return wait(800).then(function () { return gmAwait(me, threadKey, count, tries - 1); });
        });
    }

    function gmAnswer(data, t, answer) {
        if (gmBusy) return;
        gmBusy = true;
        noteFromLoad = false;
        setNote('Sending...', false);
        rerenderMessages();
        var seq = String(Date.now());
        call('uimod.cfg_save', {
            mod_id: SMS_MOD,
            section: GM_SECTION,
            key: 'request',
            value: seq + ':' + data.me + ':' + t.kind + ':' + t.target + ':' + answer.type
        })
            .then(function () { return gmAwait(data.me, t.key, t.messages.length, GM_WAIT_TRIES); })
            .then(function (ok) {
                if (!ok) throw new Error('No answer from the game. Is the HouseholdJournal mod installed and on?');
                soundPlay('sent');
                setNote('', false);
            })
            .catch(function (err) { setNote(errText(err), true); })
            .then(function () {
                gmBusy = false;
                refresh();
            });
    }

    function renderGmList(data) {
        var wrap = node('div');
        wrap.appendChild(subHeader('messages'));
        if (!data.threads.length) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'No messages yet.'));
            wrap.appendChild(none);
            return wrap;
        }
        data.threads.forEach(function (t) {
            var c = node('div', 'ph-card sms-contact gm-thread');
            var line = node('div', 'ph-row');
            var pic = node('div', 'sms-pic');
            var title = gmTitle(data, t);
            var av = node('div', 'ph-avatar', title.charAt(0));
            av.style.background = t.kind === 'p' ? accentFor(t.target) : '#636366';
            pic.appendChild(av);
            var unread = gmUnread(data, t);
            if (unread > 0) pic.appendChild(node('div', 'sms-unread', unread > 9 ? '9+' : String(unread)));
            line.appendChild(pic);
            var who = node('div', 'ph-who');
            var top = node('div', 'sms-contact-top');
            top.appendChild(node('div', 'ph-name', title));
            var when = gmWhen(t.last.at);
            top.appendChild(node('div', 'sms-contact-time', when.day + ' ' + when.time));
            who.appendChild(top);
            var preview = (t.last.sent ? 'You: ' : '') + gmText(data, t.last).replace(/\s+/g, ' ');
            who.appendChild(node('div', 'sms-preview' + (unread > 0 ? ' new' : ''), preview));
            if (gmAnswerKeys(t)) who.appendChild(node('div', 'gm-wait', 'Waiting for your answer'));
            line.appendChild(who);
            c.appendChild(line);
            onTap(c, function (e) {
                e.stopPropagation();
                gmOpenKey = t.key;
                gmListScroll = wf.content.scrollTop;
                setNote('', false);
                refresh();
            });
            wrap.appendChild(c);
        });
        return wrap;
    }

    function renderGmThread(data, t) {
        gmMarkSeen(data, t);
        var wrap = node('div');
        var head = node('div', 'ph-head');
        var back = node('div', 'ph-back', '< Messages');
        onTap(back, function (e) {
            e.stopPropagation();
            gmOpenKey = null;
            setNote('', false);
            rerenderMessages();
            wf.content.scrollTop = gmListScroll;
        });
        head.appendChild(back);
        head.appendChild(node('div', 'ph-title gm-title', gmTitle(data, t)));
        wrap.appendChild(head);

        var log = node('div', 'gm-log');
        var lastDay = '';
        t.messages.forEach(function (m) {
            var when = gmWhen(m.at);
            if (when.day && when.day !== lastDay) {
                log.appendChild(node('div', 'sms-stamp', when.day));
                lastDay = when.day;
            }
            var row = node('div', 'sms-row tail ' + (m.sent ? 'mine' : 'theirs'));
            var bubble = node('div', 'sms-bubble gm-bubble');
            emojiFill(bubble, gmText(data, m));
            var time = node('div', 'sms-time', when.time);
            if (m.sent) row.appendChild(time);
            row.appendChild(bubble);
            if (!m.sent) row.appendChild(time);
            log.appendChild(row);
            if (m.ignored) log.appendChild(node('div', 'gm-note', m.sent ? 'No reply' : 'Not answered'));
        });
        wrap.appendChild(log);

        var ans = gmAnswerKeys(t);
        if (ans) {
            var box = node('div', 'gm-answers');
            box.appendChild(node('div', 'ph-card-label', 'YOUR ANSWER'));
            GM_ANSWERS.forEach(function (a) {
                var key = ans.keys[a.key];
                if (!ans.plain && !key) return;
                var label = (key && data.text[key]) || a.label;
                var b = node('div', 'ph-btn gm-answer' + (gmBusy ? ' off' : ''), label);
                onTap(b, function (e) {
                    e.stopPropagation();
                    if (!gmBusy) gmAnswer(data, t, a);
                });
                box.appendChild(b);
            });
            wrap.appendChild(box);
        }
        return wrap;
    }

    function renderMessages(data) {
        lastMessagesData = data;
        var t = gmOpenKey ? data.threads.filter(function (x) { return x.key === gmOpenKey; })[0] : null;
        var key = t ? t.key : null;
        var count = t ? t.messages.length : 0;
        gmToEnd = !!t && (key !== gmShownKey || count > gmShownCount);
        gmShownKey = key;
        gmShownCount = count;
        return t ? renderGmThread(data, t) : renderGmList(data);
    }

    // After the page is drawn and its old scroll put back: an opened thread, or one with new
    // messages, shows its newest message.
    function gmScroll() {
        if (!gmToEnd) return;
        gmToEnd = false;
        wf.content.scrollTop = wf.content.scrollHeight;
    }

