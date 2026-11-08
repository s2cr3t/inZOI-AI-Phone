// focus -- 智能对话: a face-to-face talk with the character picked from the game's interaction
// menu. The reply service (sms-bridge lib/focus.js) answers; this page only writes what the
// played character says and shows what it hears. Files, under section ui/focus/talk/<player>-<target>:
//   said     [{id, text, at}]  written only here
//   session  {state: open | closed, at}  written only here
//   heard    [{id, text, at, reAt, face, gesture}]  written by the service
//   status   {state: online | thinking | error, error, at}  written by the service
// What the page went through (loaded, menu picks, script errors), kept in ui/focus/diag.cfg.
var focusDiag = [];
function focusNote(what) {
    var d = new Date();
    focusDiag.push(d.getHours() + ':' + d.getMinutes() + ':' + d.getSeconds() + ' ' + what);
    if (focusDiag.length > 30) focusDiag.shift();
    try { inzoi.cli.execute('uimod.cfg_save', { mod_id: 'HouseholdBoard_I6IXIO', section: 'ui/focus', key: 'diag', value: focusDiag.join(' | ') }); } catch (e) {}
}
window.onerror = function (msg, src, line) { focusNote('error ' + msg + ' @' + line); };
focusNote('loaded');
(function () {
    'use strict';
    var MOD = 'HouseholdBoard_I6IXIO';
    var POLL_MS = 600;
    var TEXT_MAX = 200;
    var SHOWN = 40;
    var TYPE_MS = 45;
    var SERVICE_SILENT_MS = 8000;
    // The camera (HouseholdJournal B1 FocusCamera) turns to the character while the box is open;
    // the request is rewritten this often, and one not rewritten for 15 s counts as closed.
    var CAMERA_REFRESH_MS = 5000;
    var cameraTimer = null;

    var talk = null;          // { player, target, section, name, said: [], heard: [], openedAt }
    var lastTrigger = { key: '', at: 0 };
    var pollTimer = null;
    var polling = false;
    var composing = false;
    var typing = null;        // { id, shown } the answer being typed out
    var typedIds = {};
    var serviceAt = 0;

    // ---- the game ----
    function extractJson(s) {
        if (typeof s !== 'string') return null;
        var i = s.indexOf('{');
        var j = s.indexOf('[');
        var start = i < 0 ? j : (j < 0 ? i : Math.min(i, j));
        if (start < 0) return null;
        try { return JSON.parse(s.slice(start)); } catch (e) { return null; }
    }

    function unwrap(res) {
        var v = res;
        if (typeof v === 'string') v = extractJson(v) || v;
        if (v && typeof v === 'object' && ('success' in v || 'data' in v)) {
            if (v.success === false) throw new Error(v.message || 'failed');
            var d = v.data;
            if (typeof d === 'string') d = extractJson(d);
            if (d && typeof d === 'object') return d;
        }
        return v;
    }

    function cli(cmd, params) {
        return Promise.resolve().then(function () { return inzoi.cli.execute(cmd, params || {}); }).then(unwrap);
    }

    function load(key) {
        return cli('uimod.cfg_load', { mod_id: MOD, section: talk.section, key: key }).then(function (r) {
            var raw = r && typeof r.value === 'string' ? r.value : '';
            if (!raw) return null;
            try { return JSON.parse(raw); } catch (e) { return null; }
        }, function () { return null; });
    }

    function save(section, key, value) {
        return cli('uimod.cfg_save', { mod_id: MOD, section: section, key: key, value: JSON.stringify(value) });
    }

    // ---- the page ----
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    var log = el('div');
    log.id = 'talk-log';
    var state = el('div');
    state.id = 'talk-state';
    var compose = el('div');
    compose.id = 'compose';
    var box = el('textarea');
    box.id = 'talk-box';
    box.setAttribute('maxlength', String(TEXT_MAX));
    box.setAttribute('rows', '1');
    box.setAttribute('placeholder', '想说点什么？');
    var send = el('button', 'off', '说');
    send.id = 'talk-send';
    send.type = 'button';
    var hint = el('span', '', 'Enter 说话 · Esc 结束');
    hint.id = 'talk-hint';
    compose.appendChild(box);
    compose.appendChild(send);
    compose.appendChild(hint);
    wf.content.appendChild(log);
    wf.content.appendChild(state);
    wf.content.appendChild(compose);
    var sub = document.getElementById('title-sub');
    var title = document.getElementById('title-text');

    function setState(text, err) {
        state.textContent = text || '';
        state.className = err ? 'err' : '';
    }

    function syncSend() {
        send.className = box.value.replace(/\s+/g, '') ? '' : 'off';
    }

    function render() {
        if (!talk) return;
        var lines = [];
        var i;
        for (i = 0; i < talk.said.length; i++) lines.push({ side: 'mine', id: talk.said[i].id, text: talk.said[i].text, at: talk.said[i].at });
        for (i = 0; i < talk.heard.length; i++) lines.push({ side: 'theirs', id: talk.heard[i].id, text: talk.heard[i].text, at: talk.heard[i].at });
        lines.sort(function (a, b) { return a.at - b.at; });
        if (lines.length > SHOWN) lines = lines.slice(lines.length - SHOWN);
        while (log.firstChild) log.removeChild(log.firstChild);
        if (!lines.length) log.appendChild(el('div', 'line note', '走到' + talk.name + '面前，开口说点什么吧。'));
        for (i = 0; i < lines.length; i++) {
            var l = lines[i];
            var row = el('div', 'line ' + l.side);
            row.appendChild(el('span', 'who', (l.side === 'mine' ? '你' : talk.name) + '：'));
            var text = l.text;
            if (typing && typing.id === l.id) text = l.text.slice(0, typing.shown);
            row.appendChild(el('span', '', text));
            log.appendChild(row);
        }
        log.scrollTop = log.scrollHeight;
    }

    // A new answer appears a few characters at a time, as if spoken.
    function typeOut() {
        if (typing || !talk) return;
        for (var i = 0; i < talk.heard.length; i++) {
            var h = talk.heard[i];
            if (typedIds[h.id]) continue;
            typedIds[h.id] = true;
            typing = { id: h.id, shown: 0, len: h.text.length };
            var tick = function () {
                if (!typing) return;
                typing.shown += 1;
                if (typing.shown >= typing.len) typing = null;
                render();
                if (typing) setTimeout(tick, TYPE_MS);
                else typeOut();
            };
            setTimeout(tick, TYPE_MS);
            return;
        }
    }

    // ---- the camera ----
    function camera(op, t) {
        return cli('uimod.cfg_save', { mod_id: MOD, section: 'ui/focus', key: 'camera', value: Date.now() + ':' + op + ':' + t.player + ':' + t.target }).then(null, function () {});
    }

    function cameraOn(t) {
        if (cameraTimer) clearInterval(cameraTimer);
        camera('open', t);
        cameraTimer = setInterval(function () { if (talk === t) camera('open', t); }, CAMERA_REFRESH_MS);
    }

    function cameraOff(t) {
        if (cameraTimer) { clearInterval(cameraTimer); cameraTimer = null; }
        camera('close', t);
    }

    // ---- the talk ----
    function closeTalk() {
        if (!talk) return;
        var t = talk;
        talk = null;
        typing = null;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        save(t.section, 'session', { state: 'closed', at: Date.now() });
        cameraOff(t);
        try { box.blur(); } catch (e) {}
    }

    function hide() {
        closeTalk();
        setTimeout(function () {
            try { inzoi.view.hide(); } catch (e) {
                try { engine.call('_uimod_request', JSON.stringify({ type: 'view', action: 'hide', promiseId: 0 })); } catch (e2) {}
            }
        }, 0);
    }

    function openTalk(player, target) {
        if (talk && talk.player === player && talk.target === target) return;
        closeTalk();
        talk = { player: player, target: target, section: 'ui/focus/talk/' + player + '-' + target, name: 'TA', said: [], heard: [], openedAt: Date.now() };
        typedIds = {};
        serviceAt = 0;
        var t = talk;
        sub.textContent = '';
        title.firstChild.nodeValue = 'TA';
        setState('');
        render();
        Promise.all([load('said'), load('heard')]).then(function (r) {
            if (talk !== t) return;
            t.said = r[0] instanceof Array ? r[0] : [];
            t.heard = r[1] instanceof Array ? r[1] : [];
            // What was said before this box opened is shown at once, not typed out again.
            for (var i = 0; i < t.heard.length; i++) typedIds[t.heard[i].id] = true;
            render();
        });
        save(t.section, 'session', { state: 'open', at: t.openedAt });
        cameraOn(t);
        cli('entity.get_character_info', { entity_id: String(target) }).then(function (c) {
            if (talk !== t || !c) return;
            t.name = c.first_name || c.name || 'TA';
            title.firstChild.nodeValue = c.name || t.name;
            sub.textContent = '面对面';
            render();
        }, function () {});
        schedulePoll(0);
        setTimeout(function () { try { box.focus(); } catch (e) {} }, 120);
    }

    function schedulePoll(ms) {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, ms);
    }

    function poll() {
        pollTimer = null;
        if (!talk || polling) { if (talk) schedulePoll(POLL_MS); return; }
        polling = true;
        var t = talk;
        Promise.all([load('heard'), load('status')]).then(function (r) {
            polling = false;
            if (talk !== t) return;
            var heard = r[0] instanceof Array ? r[0] : t.heard;
            if (heard.length !== t.heard.length) {
                t.heard = heard;
                render();
                typeOut();
            }
            var s = r[1];
            if (s && typeof s.at === 'number') serviceAt = Math.max(serviceAt, s.at);
            var waiting = unanswered(t);
            if (s && s.state === 'error') setState(s.error || '出了点问题', true);
            else if (s && s.state === 'thinking') setState(t.name + ' 在想……');
            else if (waiting && Date.now() - waiting > SERVICE_SILENT_MS && serviceAt < waiting) setState('回复服务好像没在运行（sms-bridge）', true);
            else if (waiting) setState('……');
            else setState('');
            schedulePoll(POLL_MS);
        }, function () {
            polling = false;
            schedulePoll(POLL_MS);
        });
    }

    // The time of the oldest line said and not answered yet, or 0.
    function unanswered(t) {
        var answered = 0;
        for (var i = 0; i < t.heard.length; i++) answered = Math.max(answered, typeof t.heard[i].reAt === 'number' ? t.heard[i].reAt : t.heard[i].at);
        for (var j = 0; j < t.said.length; j++) if (t.said[j].at > answered) return t.said[j].at;
        return 0;
    }

    function say() {
        if (!talk) return;
        var text = box.value.replace(/^\s+|\s+$/g, '').slice(0, TEXT_MAX);
        if (!text) return;
        var now = Date.now();
        var last = talk.said.length ? talk.said[talk.said.length - 1].at : 0;
        var at = Math.max(now, last + 1);
        talk.said.push({ id: 's-' + at, text: text, at: at });
        if (talk.said.length > 80) talk.said = talk.said.slice(talk.said.length - 80);
        save(talk.section, 'said', talk.said);
        box.value = '';
        syncSend();
        render();
        setState('……');
    }

    box.addEventListener('input', syncSend);
    box.addEventListener('compositionstart', function () { composing = true; });
    box.addEventListener('compositionend', function () { composing = false; syncSend(); });
    box.addEventListener('keydown', function (e) {
        if (e.keyCode === 13 && !e.shiftKey && !e.isComposing && !composing) {
            if (e.preventDefault) e.preventDefault();
            say();
        } else if (e.keyCode === 27 && !composing) {
            if (e.preventDefault) e.preventDefault();
            hide();
        }
    });
    // Esc with the box not focused, while the talk is open, ends it too.
    document.addEventListener('keydown', function (e) {
        if (e.keyCode === 27 && talk && e.target !== box) hide();
    });
    send.addEventListener('click', function (e) {
        e.stopPropagation();
        say();
        try { box.focus(); } catch (err) {}
    });
    var closeBtn = document.getElementById('close-btn');
    if (closeBtn) closeBtn.addEventListener('click', function () { closeTalk(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) closeTalk(); });
    window.addEventListener('beforeunload', function () { closeTalk(); });

    // The game sends each menu pick twice at once; the second one is the same talk.
    inzoi.trigger.onActivated(function (t) {
        try { focusNote('trigger ' + JSON.stringify(t) + (talk ? ' open=' + talk.player + '-' + talk.target : '')); } catch (e) {}
        if (!t || t.triggerId !== 'focus_chat') return;
        var player = String(t.selfEntityId || '');
        var target = String(t.targetEntityId || '');
        if (!/^\d+$/.test(player) || !/^\d+$/.test(target) || player === target) return;
        var key = player + '-' + target;
        var now = Date.now();
        if (lastTrigger.key === key && now - lastTrigger.at < 1500 && talk) return;
        lastTrigger = { key: key, at: now };
        openTalk(player, target);
    });
})();
