    // ------------------------------------------------------------------
    // Settings: the list, and its Sounds page
    // ------------------------------------------------------------------
    var SETTINGS_SWITCH_MS = 200;

    function loadSettings() {
        return soft(getEnv()).then(function (env) { return { env: env && !env.error ? env : null }; });
    }

    function settingsRedraw() {
        if (current !== 'sounds') return;
        var top = wf.content.scrollTop;
        show(renderSounds({}));
        wf.content.scrollTop = top;
    }

    function settingsIcon(id) {
        var tile = node('div', 'st-nav-icon st-ic-' + id);
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'st-nav-glyph');
        if (id === 'sounds') {
            glyphPath(svg, 'M4 9.2h3.4L12 5v14l-4.6-4.2H4c-.6 0-1-.4-1-1v-3.6c0-.6.4-1 1-1z');
            glyphPath(svg, 'M15.2 8.4c1 .9 1.6 2.2 1.6 3.6s-.6 2.7-1.6 3.6l-1.1-1.1c.7-.6 1.1-1.5 1.1-2.5s-.4-1.9-1.1-2.5l1.1-1.1zM17.6 6c1.6 1.5 2.6 3.6 2.6 6s-1 4.5-2.6 6l-1.1-1.1c1.3-1.2 2.1-3 2.1-4.9s-.8-3.7-2.1-4.9L17.6 6z');
        } else {
            glyphPath(svg, 'M5.5 4h13c.8 0 1.5.7 1.5 1.5v13c0 .8-.7 1.5-1.5 1.5h-13c-.8 0-1.5-.7-1.5-1.5v-13C4 4.7 4.7 4 5.5 4zM5.6 5.6v10.2l3.6-4.1c.3-.3.8-.3 1.1 0l2.4 2.6 1.6-1.7c.3-.3.8-.3 1.1 0l3 3.1V5.6H5.6z', '#ffffff', 'evenodd');
            glyphShape(svg, 'circle', { cx: '15.4', cy: '8.8', r: '1.6', fill: '#ffffff' });
        }
        tile.appendChild(svg);
        return tile;
    }

    // One line of the Settings list: icon, name, the current value and a chevron.
    function settingsNavRow(id, value, first) {
        var row = node('div', 'st-nav' + (first ? ' first' : ''));
        row.appendChild(settingsIcon(id));
        row.appendChild(node('div', 'st-nav-label', TITLES[id]));
        row.appendChild(node('div', 'st-nav-value', value));
        row.appendChild(node('div', 'st-nav-chev', '>'));
        onTap(row, function (e) {
            e.stopPropagation();
            open(id);
        });
        return row;
    }

    function renderSettings() {
        var wrap = node('div');
        wrap.appendChild(subHeader('settings'));
        var list = card();
        list.className += ' st-nav-card';
        var s = soundSettings;
        list.appendChild(settingsNavRow('sounds', s.enabled ? s.volume + '%' : 'Off', true));
        list.appendChild(settingsNavRow('wallpaper', wallActive().label));
        wrap.appendChild(list);
        return wrap;
    }

    // An iPhone-style switch. It slides in place first, then the page is drawn again so the
    // rows that depend on it follow.
    function settingsSwitch(label, on, enabled, onChange, first) {
        var row = node('div', 'st-row' + (first ? ' first' : '') + (enabled ? '' : ' off'));
        row.appendChild(node('div', 'st-label', label));
        var sw = node('div', 'st-switch' + (on ? ' on' : ''));
        sw.appendChild(node('div', 'st-knob'));
        row.appendChild(sw);
        var value = on;
        onTap(row, function (e) {
            e.stopPropagation();
            if (!enabled) return;
            value = !value;
            sw.className = 'st-switch' + (value ? ' on' : '');
            onChange(value);
            setTimeout(settingsRedraw, SETTINGS_SWITCH_MS);
        });
        return row;
    }

    function settingsVolumeTo(v) {
        var next = Math.max(0, Math.min(100, v));
        if (next === soundSettings.volume) return;
        soundSet('volume', next);
        settingsRedraw();
        soundPlay('received', true);
    }

    function settingsVolume() {
        var on = soundSettings.enabled;
        var row = node('div', 'st-volume' + (on ? '' : ' off'));
        var minus = node('button', 'st-step' + (on && soundSettings.volume > 0 ? '' : ' off'), '\u2212');
        minus.setAttribute('type', 'button');
        minus.setAttribute('title', 'Quieter');
        onTap(minus, function (e) {
            e.stopPropagation();
            if (on) settingsVolumeTo(soundSettings.volume - SOUND_VOLUME_STEP);
        }, { silent: true });
        var hit = node('div', 'st-track-hit');
        var track = node('div', 'st-track');
        var fill = node('div', 'st-fill');
        fill.style.width = soundSettings.volume + '%';
        track.appendChild(fill);
        hit.appendChild(track);
        var downX = null;
        hit.addEventListener('mousedown', function (e) { downX = e.clientX; });
        onTap(hit, function (e) {
            e.stopPropagation();
            var r = track.getBoundingClientRect();
            if (!on || !r.width || downX === null) return;
            var ratio = (downX - r.left) / r.width;
            settingsVolumeTo(Math.round(Math.max(0, Math.min(1, ratio)) * 100 / SOUND_VOLUME_STEP) * SOUND_VOLUME_STEP);
        }, { silent: true });
        var plus = node('button', 'st-step' + (on && soundSettings.volume < 100 ? '' : ' off'), '+');
        plus.setAttribute('type', 'button');
        plus.setAttribute('title', 'Louder');
        onTap(plus, function (e) {
            e.stopPropagation();
            if (on) settingsVolumeTo(soundSettings.volume + SOUND_VOLUME_STEP);
        }, { silent: true });
        row.appendChild(minus);
        row.appendChild(hit);
        row.appendChild(plus);
        row.appendChild(node('div', 'st-value', soundSettings.volume + '%'));
        return row;
    }

    function settingsChip(text, on, enabled, onClick) {
        var c = node('button', 'ph-chip ai-chip' + (on ? ' on' : '') + (enabled ? '' : ' off'));
        c.setAttribute('type', 'button');
        c.appendChild(node('span', null, text));
        onTap(c, function (e) {
            e.stopPropagation();
            if (enabled) onClick();
        }, { silent: true });
        return c;
    }

    function settingsStatus() {
        if (soundState === 'checking') return { cls: 'ai-detail', text: 'Checking how this game plays sound...' };
        if (soundState === 'unavailable') {
            return { cls: 'ai-detail st-err', text: 'This game build did not start WebM playback. That is the only sound format its interface can play, so the phone stays silent.' };
        }
        if (!soundClock) {
            return { cls: 'ai-detail st-warn', text: 'WebM playback started, but this game build did not move the playback clock. Use Listen below to check whether you can hear the phone.' };
        }
        if (soundGame <= 0) return { cls: 'ai-detail st-warn', text: 'The game sound is muted. Turn up Master and UI volume in the game settings to hear the phone.' };
        return { cls: 'ai-detail', text: 'Sound plays through the game as ' + soundBackend.label + '. It follows the game\'s Master and UI volume.' };
    }

    function renderSounds() {
        var s = soundSettings;
        var ready = soundState === 'ready';
        var wrap = node('div');
        wrap.appendChild(subHeader('sounds'));

        var main = card('SOUNDS');
        main.appendChild(settingsSwitch('Sounds', s.enabled, true, function (v) {
            soundSet('enabled', v);
            if (v) soundPlay('tap', true);
        }, true));
        main.appendChild(settingsVolume());
        var status = settingsStatus();
        main.appendChild(node('div', status.cls, status.text));
        if (soundState === 'unavailable') {
            var again = node('div', 'ph-btns');
            var retry = aiButton('Check again', 'on', true, function () {
                soundProbe();
                settingsRedraw();
            });
            retry.className += ' last';
            again.appendChild(retry);
            main.appendChild(again);
        }
        wrap.appendChild(main);

        var kinds = card('PLAY SOUNDS FOR');
        kinds.appendChild(settingsSwitch('Keyboard Clicks', s.keyboard, s.enabled, function (v) { soundSet('keyboard', v); }, true));
        kinds.appendChild(settingsSwitch('Button Taps', s.taps, s.enabled, function (v) { soundSet('taps', v); }));
        kinds.appendChild(settingsSwitch('Sent and Received Texts', s.messages, s.enabled, function (v) { soundSet('messages', v); }));
        wrap.appendChild(kinds);

        var tone = card('TEXT TONE');
        tone.appendChild(node('div', 'ai-hint', 'Plays when a text arrives in a conversation that is not open.'));
        var chips = node('div', 'st-chips');
        SOUND_TONES.forEach(function (t) {
            chips.appendChild(settingsChip(t.label, s.tone === t.id, s.enabled, function () {
                soundSet('tone', t.id);
                settingsRedraw();
                soundTone(true);
            }));
        });
        tone.appendChild(chips);
        wrap.appendChild(tone);

        var listen = card('LISTEN');
        var row = node('div', 'st-chips');
        var can = ready && s.enabled;
        row.appendChild(settingsChip('Tap', false, can, function () { soundPlay('tap', true); }));
        row.appendChild(settingsChip('Keyboard', false, can, function () { soundPlay('key', true); }));
        row.appendChild(settingsChip('Sent', false, can, function () { soundPlay('sent', true); }));
        row.appendChild(settingsChip('Received', false, can, function () { soundPlay('received', true); }));
        row.appendChild(settingsChip('Text Tone', false, can && s.tone !== 'none', function () { soundTone(true); }));
        listen.appendChild(row);
        if (!s.enabled) listen.appendChild(node('div', 'ai-hint', 'Turn on Sounds to listen.'));
        wrap.appendChild(listen);
        return wrap;
    }

    // ------------------------------------------------------------------
    // Settings: Wallpaper
    // Presets are gradients, or pictures in ui/phone/wallpapers/preset-*.jpg. Photos the player
    // adds come from AI Phone Service (sms-bridge/lib/wallpapers.js): it shows the Open dialog
    // on the PC and saves ui/phone/wallpapers/custom/<id>.jpg, listed in index.cfg there.
    // Every picture is already veiled or shaded for its tone, so it is painted as it is: one
    // background layer, sized in pixels the way CSS cover would.
    // Tone: the helper measures each added photo ('light' or 'dark' in index.cfg); presets carry
    // theirs below. A light wallpaper puts theme-light on #app-root, which turns every page,
    // chat bubbles included, to dark text on light surfaces (index.html).
    // The choice is saved/wallpaper.cfg: { v, id, at }, id a preset id or 'c:' + photo id.
    // ------------------------------------------------------------------
    var WALL_CUSTOM_SECTION = 'ui/phone/wallpapers/custom';
    var WALL_DEFAULT = 'midnight';
    var WALL_ID_RE = /^[a-f0-9]{16}$/;
    var WALL_MAX = 24;
    var WALL_NAME_MAX = 40;
    var WALL_SIZE_POLL_MS = 400;
    var WALL_WATCH_MS = 1000;
    // The Open dialog closes itself after 10 minutes (lib/wallpapers.js); its answer follows.
    var WALL_PICK_MS = 11 * 60000;
    var WALL_REMOVE_MS = 60000;
    var WALL_THUMB_W = 76;
    var WALL_THUMB_H = 135;
    var WALL_PREVIEW_W = 72;
    var WALL_PREVIEW_H = 128;
    // Picture tones as the helper measured them (mean brightness: lake 0.44, city 0.13,
    // sakura 0.81, shore 0.43, peaks 0.17; light from 0.56).
    var WALL_PRESETS = [
        { id: 'midnight', label: 'Midnight', tone: 'dark', color: '#10141c', gradient: 'linear-gradient(180deg, #1a2744 0%, #12161f 46%, #0c0c0e 100%)' },
        { id: 'dusk', label: 'Dusk', tone: 'dark', color: '#1a1222', gradient: 'linear-gradient(180deg, #43285c 0%, #251632 48%, #0e0a12 100%)' },
        { id: 'forest', label: 'Forest', tone: 'dark', color: '#0e1a16', gradient: 'linear-gradient(180deg, #1d4a3b 0%, #11261f 50%, #0a0f0d 100%)' },
        { id: 'cloud', label: 'Cloud', tone: 'light', color: '#e9eef5', gradient: 'linear-gradient(180deg, #f6f4f0 0%, #e8edf4 50%, #d9e2ee 100%)' },
        { id: 'blush', label: 'Blush', tone: 'light', color: '#f6e9ea', gradient: 'linear-gradient(180deg, #fbf3ee 0%, #f5e4e6 52%, #e9dbe9 100%)' },
        { id: 'lake', label: 'Lake', tone: 'dark', color: '#38365e', file: 'preset-lake.jpg', width: 720, height: 1280 },
        { id: 'city', label: 'City Night', tone: 'dark', color: '#17112e', file: 'preset-city.jpg', width: 720, height: 1280 },
        { id: 'sakura', label: 'Sakura', tone: 'light', color: '#c9d6ec', file: 'preset-sakura.jpg', width: 720, height: 1280 },
        { id: 'shore', label: 'Shore', tone: 'dark', color: '#4a3236', file: 'preset-shore.jpg', width: 720, height: 1280 },
        { id: 'peaks', label: 'Aurora Peaks', tone: 'dark', color: '#0c1433', file: 'preset-peaks.jpg', width: 720, height: 1280 }
    ];
    var wallChoice = WALL_DEFAULT;
    // Set once the player picks one here, so the saved choice loading late cannot undo it.
    var wallTouched = false;
    var wallCustom = [];
    var wallPending = null;
    var wallResult = null;
    var wallConfirm = '';
    var wallSeq = 0;
    var wallApplied = '';
    var wallWatching = false;
    var wallChecked = {};

    function wallPreset(id) {
        for (var i = 0; i < WALL_PRESETS.length; i++) {
            var p = WALL_PRESETS[i];
            if (p.id !== id) continue;
            return {
                id: p.id, photo: '', label: p.label, tone: p.tone, color: p.color, gradient: p.gradient || '',
                url: p.file ? 'wallpapers/' + p.file : '', width: p.width || 0, height: p.height || 0
            };
        }
        return null;
    }

    function wallPhoto(photoId) {
        for (var i = 0; i < wallCustom.length; i++) {
            var c = wallCustom[i];
            if (c.id !== photoId) continue;
            return {
                id: 'c:' + c.id, photo: c.id, label: c.name || 'Photo', tone: c.tone,
                color: c.tone === 'light' ? '#eef0f4' : '#10141c', gradient: '',
                url: 'wallpapers/custom/' + c.id + '.jpg', width: c.width, height: c.height
            };
        }
        return null;
    }

    function wallFind(id) {
        id = String(id || '');
        return id.indexOf('c:') === 0 ? wallPhoto(id.slice(2)) : wallPreset(id);
    }

    function wallValidId(id) {
        return typeof id === 'string' && (id.indexOf('c:') === 0 ? WALL_ID_RE.test(id.slice(2)) : !!wallPreset(id));
    }

    // The saved choice, or the default while that photo is not (or no longer) on the phone.
    function wallActive() {
        return wallFind(wallChoice) || wallPreset(WALL_DEFAULT);
    }

    // Fills a W x H box with the wallpaper the way CSS cover would, moved by (left, top) so a
    // layer placed there inside #app-root lines up with the root's own background.
    // `view` is for a layer the transition is scaling: s, x and y are its scale and translation,
    // ox and oy the transform origin in its own coordinates, and W and H the window's size. The
    // picture is then drawn 1/s times as large and moved back through the same transform, so it
    // stays on the root's wallpaper while the window grows out of the icon (launch) or shrinks
    // back into it (close), instead of riding the scale and pulling away from the home screen.
    function wallStyle(n, w, W, H, left, top, view) {
        n.style.backgroundColor = w.color;
        n.style.backgroundRepeat = 'no-repeat';
        var sc = view && view.s ? view.s : 1;
        var iw, ih;
        if (w.gradient || !w.url || !w.width || !w.height) {
            n.style.backgroundImage = w.gradient || 'none';
            iw = W;
            ih = H;
        } else {
            var cover = Math.max(W / w.width, H / w.height);
            iw = Math.ceil(w.width * cover);
            ih = Math.ceil(w.height * cover);
            n.style.backgroundImage = 'url("' + w.url + '")';
        }
        var px = Math.floor((W - iw) / 2) - left;
        var py = Math.floor((H - ih) / 2) - top;
        if (sc === 1) {
            n.style.backgroundSize = iw + 'px ' + ih + 'px';
            n.style.backgroundPosition = px + 'px ' + py + 'px';
            return;
        }
        n.style.backgroundSize = (iw / sc) + 'px ' + (ih / sc) + 'px';
        n.style.backgroundPosition = (view.ox + (px - view.x - view.ox) / sc) + 'px ' +
            (view.oy + (py - view.y - view.oy) / sc) + 'px';
    }

    // Runs on a short timer as well: the window can be resized by its corner at any time.
    function wallApply() {
        var root = document.getElementById('app-root');
        if (!root) return;
        var W = root.clientWidth;
        var H = root.clientHeight;
        if (!W || !H) return;
        var w = wallActive();
        var key = w.id + '|' + w.tone + '|' + W + '|' + H;
        if (key === wallApplied) return;
        wallApplied = key;
        wallStyle(root, w, W, H, 0, 0);
        if (w.tone === 'light') root.classList.add('theme-light');
        else root.classList.remove('theme-light');
        wallReport(root, w);
    }

    // What the UI engine made of the first gradient and the first picture it was given, for a
    // tester's report. Same idea as sound-check.cfg.
    function wallReport(root, w) {
        var kind = w.gradient ? 'gradient' : 'picture';
        if (wallChecked[kind]) return;
        var cs = null;
        try { cs = window.getComputedStyle ? window.getComputedStyle(root) : null; } catch (e) {}
        wallChecked[kind] = {
            at: Date.now(),
            id: w.id,
            set: { image: root.style.backgroundImage, size: root.style.backgroundSize, position: root.style.backgroundPosition },
            computed: cs ? { image: cs.backgroundImage, size: cs.backgroundSize, position: cs.backgroundPosition } : null
        };
        saveJson('wallpaper-check', wallChecked, SOUND_SECTION).then(null, function () {});
    }

    function wallLoadCustom() {
        return cfgValue(WALL_CUSTOM_SECTION, 'index').then(function (v) {
            var items = v && Array.isArray(v.items) ? v.items : [];
            var list = [];
            for (var i = 0; i < items.length && list.length < WALL_MAX; i++) {
                var it = items[i];
                if (!it || !WALL_ID_RE.test(String(it.id)) || !(Number(it.width) > 0) || !(Number(it.height) > 0)) continue;
                list.push({
                    id: String(it.id),
                    name: typeof it.name === 'string' ? it.name.slice(0, WALL_NAME_MAX) : '',
                    width: Number(it.width),
                    height: Number(it.height),
                    tone: it.tone === 'light' ? 'light' : 'dark'
                });
            }
            wallCustom = list;
            wallApply();
        });
    }

    function wallInit() {
        wallApply();
        Promise.all([cfgValue(SOUND_SECTION, 'wallpaper'), wallLoadCustom()]).then(function (r) {
            var v = r[0];
            if (!wallTouched && v && wallValidId(v.id)) wallChoice = v.id;
            wallApply();
        }, function () {});
        setInterval(wallApply, WALL_SIZE_POLL_MS);
    }

    function wallSelect(id) {
        if (!wallFind(id)) return;
        wallTouched = true;
        wallConfirm = '';
        wallResult = null;
        if (id !== wallChoice) {
            wallChoice = id;
            wallApply();
            saveJson('wallpaper', { v: 1, id: id, at: Date.now() }, SOUND_SECTION).then(null, function (err) {
                wallResult = { ok: false, text: 'Could not save the wallpaper: ' + errText(err) };
                wallRedraw();
            });
        }
        wallRedraw();
    }

    function wallRedraw() {
        if (current !== 'wallpaper') return;
        var top = wf.content.scrollTop;
        show(renderWallpaper({}));
        wf.content.scrollTop = top;
    }

    function loadWallpaper() {
        return Promise.all([
            soft(getEnv()),
            loadAiService(),
            wallLoadCustom().then(null, function () {})
        ]).then(function (r) {
            aiService = r[1] && typeof r[1] === 'object' ? r[1] : null;
            return wallCheckAnswer().then(function () {
                return { env: r[0] && !r[0].error ? r[0] : null };
            });
        });
    }

    // Shares request.cfg with the AI page, which holds one request at a time.
    function wallRequest(type, photoId) {
        if (wallPending) return;
        if (!aiTakesRequests(aiService)) {
            wallResult = { ok: false, text: aiAlive(aiService) ? AI_NO_GUARDIAN : 'AI Phone Service is not running on this PC.' };
            return wallRedraw();
        }
        if (aiPending || smsPhotoPending) {
            wallResult = { ok: false, text: smsPhotoPending ? 'Finish choosing the Texts photo on the PC first.' : 'The AI page is still waiting for an answer. Try again in a moment.' };
            return wallRedraw();
        }
        wallSeq += 1;
        var id = 'w' + Date.now() + '-' + wallSeq;
        var value = { id: id, type: type };
        if (photoId) value.wallpaper = photoId;
        wallPending = { id: id, type: type, photo: photoId || '', at: Date.now() };
        wallResult = null;
        wallConfirm = '';
        saveJson('request', value, AI_SECTION).then(function () {
            wallWatch();
        }, function (err) {
            wallPending = null;
            wallResult = { ok: false, text: 'Could not send: ' + errText(err) };
            wallRedraw();
        });
        wallRedraw();
    }

    // Waits for the answer on any page: the player may leave while the dialog is open.
    function wallWatch() {
        if (wallWatching) return;
        wallWatching = true;
        var step = function () {
            if (!wallPending) {
                wallWatching = false;
                return;
            }
            loadAiService().then(function (v) {
                if (v && typeof v === 'object') aiService = v;
                return wallCheckAnswer();
            }).then(null, function () {}).then(function () {
                if (wallPending) setTimeout(step, WALL_WATCH_MS);
                else wallWatching = false;
            });
        };
        setTimeout(step, WALL_WATCH_MS);
    }

    function wallCheckAnswer() {
        var asked = wallPending;
        if (!asked) return Promise.resolve();
        var r = aiService && aiService.reply && typeof aiService.reply === 'object' ? aiService.reply : null;
        if (!r || r.id !== asked.id || r.pending) {
            if (Date.now() - asked.at > (asked.type === 'wallpaper_pick' ? WALL_PICK_MS : WALL_REMOVE_MS)) {
                wallPending = null;
                wallResult = { ok: false, text: 'No answer from AI Phone Service. Check that it is running on this PC.' };
                wallRedraw();
            }
            return Promise.resolve();
        }
        wallPending = null;
        var result = { ok: !!r.ok, text: String(r.message || (r.ok ? 'Done.' : 'That did not work.')) };
        return wallLoadCustom().then(null, function () {}).then(function () {
            var item = r.item && typeof r.item === 'object' ? r.item : null;
            if (asked.type === 'wallpaper_pick' && r.ok && item && WALL_ID_RE.test(String(item.id))) {
                var photoId = String(item.id);
                if (!wallPhoto(photoId) && Number(item.width) > 0 && Number(item.height) > 0) {
                    wallCustom.unshift({
                        id: photoId,
                        name: typeof item.name === 'string' ? item.name.slice(0, WALL_NAME_MAX) : '',
                        width: Number(item.width),
                        height: Number(item.height),
                        tone: item.tone === 'light' ? 'light' : 'dark'
                    });
                }
                wallSelect('c:' + photoId);
            } else if (asked.type === 'wallpaper_remove' && r.ok && wallChoice === 'c:' + asked.photo) {
                wallSelect(WALL_DEFAULT);
            }
            wallResult = result;
            wallApply();
            wallRedraw();
            if (current === 'settings') refresh();
        });
    }

    function wallCheckMark() {
        var mark = node('div', 'wp-check');
        var svg = glyphSvg('0 0 24 24');
        svg.removeAttribute('class');
        glyphPath(svg, 'M9.6 16.6L5.2 12.2l1.6-1.6 2.8 2.8 7.6-7.6 1.6 1.6-9.2 9.2z');
        mark.appendChild(svg);
        return mark;
    }

    function wallTile(w, on, onPick) {
        var tile = node('div', 'wp-tile' + (on ? ' on' : ''));
        var thumb = node('div', 'wp-thumb');
        wallStyle(thumb, w, WALL_THUMB_W, WALL_THUMB_H, 0, 0);
        tile.appendChild(thumb);
        if (on) tile.appendChild(wallCheckMark());
        tile.appendChild(node('div', 'wp-name', w.label));
        onTap(tile, function (e) {
            e.stopPropagation();
            onPick();
        });
        return tile;
    }

    function wallAddTile(enabled, waiting) {
        var tile = node('div', 'wp-tile wp-add' + (enabled ? '' : ' off'));
        var box = node('div', 'wp-thumb wp-add-box');
        box.appendChild(node('div', 'wp-add-plus', waiting ? '...' : '+'));
        tile.appendChild(box);
        tile.appendChild(node('div', 'wp-name', waiting ? 'Choosing...' : 'Add Photo'));
        onTap(tile, function (e) {
            e.stopPropagation();
            if (enabled) wallRequest('wallpaper_pick');
        });
        return tile;
    }

    function wallStatusLine(up) {
        var text = '';
        var cls = 'ai-result';
        if (wallPending) {
            text = wallPending.type === 'wallpaper_pick'
                ? 'A window to choose a picture is open on the PC desktop. If the game covers it, press Alt+Tab.'
                : 'Removing the photo...';
        } else if (wallResult) {
            text = wallResult.text;
            cls += wallResult.ok ? ' ok' : ' err';
        } else if (!up) {
            text = 'Adding photos needs AI Phone Service running on this PC. The presets work without it.';
        } else if (wallCustom.length >= WALL_MAX) {
            text = 'The phone holds ' + WALL_MAX + ' of your photos. Remove one to add another.';
        }
        return node('div', cls, text);
    }

    function renderWallpaper() {
        var active = wallActive();
        var up = aiAlive(aiService);
        var wrap = node('div');
        wrap.appendChild(subHeader('wallpaper'));

        var now = card('CURRENT');
        var row = node('div', 'wp-current');
        var shot = node('div', 'wp-preview');
        wallStyle(shot, active, WALL_PREVIEW_W, WALL_PREVIEW_H, 0, 0);
        row.appendChild(shot);
        var about = node('div', 'wp-about');
        about.appendChild(node('div', 'wp-about-name', active.label));
        about.appendChild(node('div', 'ai-hint', active.photo ? 'Your photo' : active.gradient ? 'Preset color' : 'Preset picture'));
        about.appendChild(node('div', 'ai-hint', active.tone === 'light' ? 'Light style' : 'Dark style'));
        row.appendChild(about);
        now.appendChild(row);
        wrap.appendChild(now);

        var presets = card('PRESETS');
        var grid = node('div', 'wp-grid');
        WALL_PRESETS.forEach(function (p) {
            var w = wallPreset(p.id);
            grid.appendChild(wallTile(w, active.id === w.id, function () { wallSelect(w.id); }));
        });
        presets.appendChild(grid);
        wrap.appendChild(presets);

        var mine = card('YOUR PHOTOS');
        var photos = node('div', 'wp-grid');
        var waiting = !!wallPending && wallPending.type === 'wallpaper_pick';
        photos.appendChild(wallAddTile(up && !wallPending && wallCustom.length < WALL_MAX, waiting));
        wallCustom.forEach(function (c) {
            var w = wallPhoto(c.id);
            photos.appendChild(wallTile(w, active.id === w.id, function () { wallSelect(w.id); }));
        });
        mine.appendChild(photos);
        if (active.photo) {
            var btns = node('div', 'ph-btns');
            var asking = wallConfirm === active.photo;
            var remove = aiButton(asking ? 'Tap Again to Remove' : 'Remove This Photo', 'warn', up && !wallPending, function () {
                if (wallConfirm !== active.photo) {
                    wallConfirm = active.photo;
                    return wallRedraw();
                }
                wallRequest('wallpaper_remove', active.photo);
            });
            remove.className += ' last';
            btns.appendChild(remove);
            mine.appendChild(btns);
        }
        mine.appendChild(wallStatusLine(up));
        mine.appendChild(node('div', 'ai-hint', 'JPG, PNG, BMP or GIF from this PC, up to ' + WALL_MAX +
            ' photos. Each is fitted to the phone. A bright photo turns the phone to its light style and is brightened a little; a dark one keeps the dark style and is darkened a little, so text stays readable. The original file is not changed.'));
        wrap.appendChild(mine);
        return wrap;
    }

