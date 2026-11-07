    // ------------------------------------------------------------------
    // Sounds. This game's UI engine plays sound only from a <video> whose file is WebM,
    // VP8 picture plus Vorbis. <audio> never starts, so Ogg and WAV are not tried.
    // The check plays sounds/prime.webm. The picture is drawn, at full opacity, inside the
    // black island: a video the engine is not drawing never moves its playback clock.
    // The outcome is written to ui/phone/saved/sound-check.cfg.
    // The clips are made by sms-bridge/tools/make-sounds.js. Settings: ui/phone/saved/sounds.cfg.
    // ------------------------------------------------------------------
    var SOUND_SECTION = 'ui/phone/saved';
    var SOUND_DIR = 'sounds/';
    var SOUND_BACKENDS = [
        { id: 'webm', tag: 'video', ext: 'webm', label: 'WebM' }
    ];
    var SOUND_PROBE_MS = 4000;
    var SOUND_GAME_POLL_MS = 15000;
    var SOUND_VOLUME_STEP = 10;
    var SOUND_TONES = [
        { id: 'tritone', label: 'Tri-tone' },
        { id: 'note', label: 'Note' },
        { id: 'chime', label: 'Chime' },
        { id: 'none', label: 'None' }
    ];
    var SOUND_DEFAULTS = { enabled: true, volume: 80, taps: true, keyboard: true, messages: true, tone: 'tritone' };
    // group: the setting that silences the clip. gap: shortest time between two plays.
    var SOUND_CLIPS = {
        tap: { file: 'tap', voices: 3, gap: 35, group: 'taps' },
        key: { file: 'key', voices: 4, gap: 20, group: 'keyboard' },
        del: { file: 'key-delete', voices: 3, gap: 20, group: 'keyboard' },
        mod: { file: 'key-modifier', voices: 2, gap: 20, group: 'keyboard' },
        sent: { file: 'sent', voices: 2, gap: 250, group: 'messages' },
        received: { file: 'received', voices: 2, gap: 500, group: 'messages' },
        tritone: { file: 'tone-tritone', voices: 1, gap: 1200, group: 'tone' },
        note: { file: 'tone-note', voices: 1, gap: 1200, group: 'tone' },
        chime: { file: 'tone-chime', voices: 1, gap: 1200, group: 'tone' }
    };

    var soundSettings = soundClean(null);
    var soundState = 'checking';
    var soundBackend = null;
    var soundClock = true;
    var soundResults = [];
    var soundProbing = null;
    var soundHost = null;
    var soundPool = {};
    var soundLast = {};
    var soundGame = 1;
    var soundTapEvent = null;

    function soundClean(v) {
        var d = SOUND_DEFAULTS;
        var s = {};
        v = v && typeof v === 'object' ? v : {};
        s.enabled = typeof v.enabled === 'boolean' ? v.enabled : d.enabled;
        s.taps = typeof v.taps === 'boolean' ? v.taps : d.taps;
        s.keyboard = typeof v.keyboard === 'boolean' ? v.keyboard : d.keyboard;
        s.messages = typeof v.messages === 'boolean' ? v.messages : d.messages;
        var vol = Number(v.volume);
        s.volume = isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol / SOUND_VOLUME_STEP) * SOUND_VOLUME_STEP)) : d.volume;
        s.tone = d.tone;
        for (var i = 0; i < SOUND_TONES.length; i++) {
            if (SOUND_TONES[i].id === v.tone) s.tone = v.tone;
        }
        return s;
    }

    function soundSave() {
        return saveJson('sounds', soundSettings, SOUND_SECTION).then(null, function (err) {
            setNote('Could not save sound settings: ' + errText(err), true);
        });
    }

    function soundSet(field, value) {
        var next = {};
        for (var k in soundSettings) {
            if (soundSettings.hasOwnProperty(k)) next[k] = soundSettings[k];
        }
        next[field] = value;
        soundSettings = soundClean(next);
        soundSave();
    }

    function soundHostEl() {
        if (soundHost && soundHost.parentNode) return soundHost;
        soundHost = node('div', 'ph-sound-host');
        var island = document.querySelector('.ph-island');
        (island || document.body).appendChild(soundHost);
        return soundHost;
    }

    function soundElement(backend, file) {
        var m = document.createElement(backend.tag);
        m.setAttribute('preload', 'auto');
        m.setAttribute('width', '16');
        m.setAttribute('height', '16');
        m.src = SOUND_DIR + file + '.' + backend.ext;
        soundHostEl().appendChild(m);
        return m;
    }

    function soundDrop(m) {
        try { m.pause(); } catch (e) {}
        if (m.parentNode) m.parentNode.removeChild(m);
    }

    function soundStart(m) {
        try {
            var p = m.play();
            if (p && typeof p.then === 'function') p.then(null, function () {});
        } catch (e) {}
    }

    // Plays prime.webm once and records whether the playback clock moves.
    function soundTry(backend) {
        return new Promise(function (resolve) {
            var started = Date.now();
            var seen = [];
            var done = false;
            var m = soundElement(backend, 'prime');
            var timer = 0;
            var poll = 0;
            function finish(ok, why) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                clearInterval(poll);
                var at = 0;
                var duration = 0;
                var paused = null;
                var ready = 0;
                var code = 0;
                try {
                    at = m.currentTime || 0;
                    duration = m.duration || 0;
                    paused = !!m.paused;
                    ready = m.readyState || 0;
                    if (m.error && m.error.code) code = m.error.code;
                } catch (e) {}
                soundDrop(m);
                resolve({
                    id: backend.id, ok: ok, why: why, ms: Date.now() - started, events: seen,
                    position: Math.round(at * 1000), duration: Math.round((isFinite(duration) ? duration : 0) * 1000),
                    paused: paused, ready: ready, errorCode: code, page: soundPageState()
                });
            }
            ['loadstart', 'durationchange', 'play', 'playing', 'ended', 'error', 'cohplaybackstalled', 'cohplaybackresumed'].forEach(function (name) {
                m.addEventListener(name, function () {
                    if (seen.indexOf(name) < 0) seen.push(name);
                    if (name === 'ended' || name === 'cohplaybackresumed') finish(true, name);
                    else if (name === 'error') finish(false, 'error');
                });
            });
            poll = setInterval(function () {
                var at = 0;
                try { at = m.currentTime || 0; } catch (e) {}
                if (at >= 0.2) finish(true, 'played');
            }, 50);
            timer = setTimeout(function () { finish(false, 'timeout'); }, SOUND_PROBE_MS);
            try { m.volume = soundSettings.enabled ? 0.35 : 0; } catch (e) {}
            soundStart(m);
        });
    }

    function soundProbe() {
        if (soundProbing) return soundProbing;
        soundState = 'checking';
        soundBackend = null;
        soundClock = true;
        soundResults = [];
        var i = 0;
        function next() {
            if (i >= SOUND_BACKENDS.length) return Promise.resolve(null);
            var b = SOUND_BACKENDS[i];
            i += 1;
            return soundTry(b).then(function (r) {
                soundResults.push(r);
                return r.ok ? b : next();
            });
        }
        soundProbing = next().then(function (b) {
            // The engine can decode and hand audio to the game while leaving currentTime at 0
            // and never firing ended. A start without an error is still worth using.
            if (!b) {
                for (var n = 0; n < soundResults.length; n++) {
                    var row = soundResults[n];
                    if (!row || row.events.indexOf('playing') < 0 || row.events.indexOf('error') >= 0) continue;
                    for (var k = 0; k < SOUND_BACKENDS.length; k++) {
                        if (SOUND_BACKENDS[k].id === row.id) b = SOUND_BACKENDS[k];
                    }
                    soundClock = false;
                }
            }
            soundBackend = b;
            soundState = b ? 'ready' : 'unavailable';
            if (b) {
                for (var name in SOUND_CLIPS) {
                    if (SOUND_CLIPS.hasOwnProperty(name)) soundVoice(name);
                }
            }
            saveJson('sound-check', {
                at: Date.now(), chosen: b ? b.id : '', clock: soundClock, results: soundResults
            }, SOUND_SECTION).then(null, function () {});
            if (current === 'sounds' || current === 'settings') refresh();
        }).then(function () { soundProbing = null; }, function () { soundProbing = null; });
        return soundProbing;
    }

    // The game's own Master and UI volume, 0..1.
    function soundWatchGame() {
        call('sound.get_volumes', {}).then(function (v) {
            if (!v || typeof v !== 'object') return;
            var master = Number(v.master);
            var ui = Number(v.ui);
            if (!isFinite(master)) master = 1;
            if (!isFinite(ui)) ui = 1;
            if (master > 1) master = master / 100;
            if (ui > 1) ui = ui / 100;
            soundGame = Math.max(0, Math.min(1, master)) * Math.max(0, Math.min(1, ui));
        }, function () {});
    }

    function soundVoice(name) {
        var clip = SOUND_CLIPS[name];
        var pool = soundPool[name] || (soundPool[name] = []);
        var oldest = null;
        for (var i = 0; i < pool.length; i++) {
            var m = pool[i];
            if (m.paused || m.ended) return m;
            if (!oldest || m._soundAt < oldest._soundAt) oldest = m;
        }
        if (pool.length < clip.voices) {
            var fresh = soundElement(soundBackend, clip.file);
            fresh._soundAt = 0;
            pool.push(fresh);
            return fresh;
        }
        return oldest;
    }

    // preview: plays even when that kind of sound is switched off (the settings page).
    function soundPlay(name, preview) {
        var clip = SOUND_CLIPS[name];
        if (!clip || soundState !== 'ready' || !soundSettings.enabled) return;
        if (!preview && clip.group !== 'tone' && !soundSettings[clip.group]) return;
        var now = Date.now();
        if (now - (soundLast[name] || 0) < clip.gap) return;
        var volume = soundSettings.volume / 100 * soundGame;
        if (volume <= 0) return;
        soundLast[name] = now;
        var m = soundVoice(name);
        try {
            m.volume = Math.min(1, volume);
            m.currentTime = 0;
        } catch (e) {}
        m._soundAt = now;
        soundStart(m);
    }

    function soundTone(preview) {
        if (soundSettings.tone !== 'none') soundPlay(soundSettings.tone, preview);
    }

    function tapSilent(elm) {
        if (elm.disabled || elm.getAttribute('aria-disabled') === 'true') return true;
        return /(^|\s)(off|mo-btn-off)(\s|$)/.test(elm.className || '');
    }

    // A click handler with the tap sound. The sound plays on mousedown, so it is heard the
    // moment the button is pressed; nested tappable elements play it once.
    // options.silent: the action plays its own sound (Send).
    function onTap(elm, handler, options) {
        elm.addEventListener('mousedown', function (e) {
            if (e.button) return;
            if (soundTapEvent === e) return;
            soundTapEvent = e;
            if ((options && options.silent) || tapSilent(elm)) return;
            soundPlay('tap');
        });
        elm.addEventListener('click', handler);
        // Kept so a copy of this element can run the same action (see liftHead); the game's UI
        // has no element.click(), and a dispatched click would meet window.js's click guard.
        elm.tapHandler = handler;
        return elm;
    }

    // Outside the phone the game owns the mouse: a button let go out there never reaches this
    // page as mouseup. A drag therefore also ends when the pointer leaves the phone, and when
    // a move reports the left button up (only once a move has reported it down, because
    // e.buttons is not filled in by every build of the UI engine).
    function pressStart(e) {
        return { held: typeof e.buttons === 'number' && (e.buttons & 1) === 1 };
    }

    function outsidePhone(x, y) {
        var root = wf.root;
        if (!root || !root.getBoundingClientRect) return false;
        var r = root.getBoundingClientRect();
        return x <= r.left + 1 || x >= r.right - 1 || y <= r.top + 1 || y >= r.bottom - 1;
    }

    function pressLost(e, press) {
        if (typeof e.buttons === 'number') {
            if (e.buttons & 1) press.held = true;
            else if (press.held) return true;
        }
        return outsidePhone(e.clientX, e.clientY);
    }

    function leftPhone(e) {
        var to = e.relatedTarget;
        if (to && wf.root && wf.root.contains(to)) return false;
        if (to) return true;
        return outsidePhone(e.clientX, e.clientY);
    }

    // Keyboard clicks for every text field in the phone: letters, delete, and the keys
    // around them (space, return, shift, tab), as on the iPhone keyboard.
    // Keys are never cancelled here. Cancelling them left the game's text capture on,
    // so typing died and only leaving the game window gave the keyboard back.
    document.addEventListener('keydown', function (e) {
        var t = e.target;
        var tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
        if (tag !== 'TEXTAREA' && tag !== 'INPUT') return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        var k = e.keyCode;
        if (k === 8 || k === 46) soundPlay('del');
        else if (k === 13 || k === 32 || k === 9 || k === 16 || k === 20) soundPlay('mod');
        else if (k === 229 || (k >= 48 && k <= 90) || (k >= 96 && k <= 111) || (k >= 186 && k <= 222)) soundPlay('key');
    }, true);

    // What the engine was drawing during a check, for sound-check.cfg.
    function soundPageState() {
        var body = document.body;
        return {
            body: body && body.style.visibility === 'hidden' ? 'hidden' : 'shown',
            doc: document.visibilityState || '',
            minimized: !!(wf.root && wf.root._minimized)
        };
    }

    // window.js keeps the page hidden until it has put the window back where it was. A video
    // the engine is not drawing never moves its clock, so the check waits until the page shows.
    function soundWhenShown() {
        return new Promise(function (resolve) {
            var started = Date.now();
            (function wait() {
                var s = soundPageState();
                if ((s.body === 'shown' && s.doc !== 'hidden' && !s.minimized) || Date.now() - started > 8000) {
                    setTimeout(resolve, 300);
                    return;
                }
                setTimeout(wait, 100);
            })();
        });
    }

    function soundInit() {
        cfgValue(SOUND_SECTION, 'sounds').then(function (v) {
            soundSettings = soundClean(v);
        }, function () {}).then(soundWhenShown).then(soundProbe);
        soundWatchGame();
        setInterval(soundWatchGame, SOUND_GAME_POLL_MS);
    }

    function joinWithDots(parent, parts) {
        var first = true;
        for (var i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;
            if (!first) parent.appendChild(node('span', 'ph-dot'));
            parent.appendChild(node('span', null, parts[i]));
            first = false;
        }
        return parent;
    }

    function fullName(m) {
        if (!m) return '';
        var name = (m.last_name || '') + (m.first_name || '');
        return name || m.name || ('#' + m.entity_id);
    }

    function accentFor(id) {
        var n = Math.abs(Number(id) || 0);
        return ACCENTS[n % ACCENTS.length];
    }

    function avatar(m) {
        var a = node('div', 'ph-avatar', (m.first_name || m.last_name || m.name || '?').charAt(0));
        a.style.background = accentFor(m.entity_id);
        return a;
    }

    // Texts and Moments only. The letter stays until the game portrait loads, and comes back
    // if that character has no saved portrait yet.
    function faceAvatar(m) {
        var a = avatar(m);
        var id = String(m.entity_id || '');
        var meta = portraitIndex[id];
        if (!/^\d+$/.test(id) || !meta || typeof meta !== 'object') return a;
        a.className = a.className + ' ph-avatar-photo';
        var img = document.createElement('img');
        img.className = 'ph-avatar-img';
        img.alt = '';
        img.src = 'portraits/' + id + '.png?v=' + (meta.mtime || portraitRev || 1);
        img.addEventListener('load', function () {
            if (a.className.indexOf('ph-avatar-ready') < 0) a.className = a.className + ' ph-avatar-ready';
        });
        img.addEventListener('error', function () {
            if (img.parentNode) img.parentNode.removeChild(img);
        });
        a.appendChild(img);
        return a;
    }

    function moodPill(label) {
        if (!label) return null;
        var cls = label.tendency === 'positive' ? 'mood-pos'
            : label.tendency === 'negative' ? 'mood-neg' : 'mood-mid';
        return node('span', 'ph-pill ' + cls, label.text);
    }

    function card(label) {
        var c = node('div', 'ph-card');
        if (label) c.appendChild(node('div', 'ph-card-label', label));
        return c;
    }

    function bar(percent, color) {
        var b = node('div', 'ph-bar');
        var f = node('div', 'ph-fill');
        f.style.width = clampPct(percent) + '%';
        f.style.background = color;
        b.appendChild(f);
        return b;
    }

    function needsGrid(stats, keys) {
        if (!stats || stats.error || !stats.stats) {
            return node('div', 'ph-empty', 'Needs unavailable');
        }
        var grid = node('div', 'ph-needs');
        var names = stats.stat_names || {};
        keys.forEach(function (key) {
            var s = stats.stats[key];
            if (!s) return;
            var cell = node('div', 'ph-need');
            var top = node('div', 'ph-need-top');
            top.appendChild(node('span', null, names[key] || key));
            top.appendChild(node('span', 'ph-need-val', String(Math.round(clampPct(s.pct)))));
            cell.appendChild(top);
            cell.appendChild(bar(s.pct, NEED_COLORS[key] || '#0A84FF'));
            grid.appendChild(cell);
        });
        return grid;
    }

    function personRow(m, subParts, pill) {
        var row = node('div', 'ph-row');
        row.appendChild(avatar(m));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', fullName(m)));
        who.appendChild(joinWithDots(node('div', 'ph-sub'), subParts));
        row.appendChild(who);
        if (pill) row.appendChild(pill);
        return row;
    }

    // A page with a parent (chat in Texts, the pages of Settings) goes back to it.
    function backTarget(screenId) {
        return screenParent[screenId] || 'home';
    }

    function subHeader(screenId, title) {
        var head = node('div', 'ph-head');
        var back = node('div', 'ph-back', '< Back');
        onTap(back, function (e) {
            e.stopPropagation();
            open(backTarget(screenId));
        });
        head.appendChild(back);
        head.appendChild(node('div', 'ph-title', title || TITLES[screenId] || ''));
        return head;
    }

    function messageView(screenId, text) {
        var wrap = node('div');
        if (screenId !== 'home') wrap.appendChild(subHeader(screenId));
        var c = card();
        c.appendChild(node('div', 'ph-empty', text));
        wrap.appendChild(c);
        return wrap;
    }

    function percentOfDay(m) { return (m / DAY_MIN * 100) + '%'; }

    function segment(track, from, to, color, active) {
        var s = node('div', 'ph-seg');
        s.style.left = percentOfDay(from);
        s.style.width = percentOfDay(to - from);
        s.style.background = color;
        s.style.opacity = active ? '1' : '0.35';
        track.appendChild(s);
    }

    function timeline(sched, env, color, active) {
        var wrap = node('div');
        var track = node('div', 'ph-track');
        if (sched.end > sched.start) {
            segment(track, sched.start, sched.end, color, active);
        } else {
            segment(track, sched.start, DAY_MIN, color, active);
            segment(track, 0, sched.end, color, active);
        }
        var now = envMinutes(env);
        if (now !== null) {
            var marker = node('div', 'ph-now');
            marker.style.left = percentOfDay(now);
            track.appendChild(marker);
        }
        wrap.appendChild(track);

        var ticks = node('div', 'ph-ticks');
        [6, 12, 18].forEach(function (h) {
            var t = node('span', null, pad2(h) + ':00');
            t.style.left = percentOfDay(h * 60);
            ticks.appendChild(t);
        });
        wrap.appendChild(ticks);
        return wrap;
    }

