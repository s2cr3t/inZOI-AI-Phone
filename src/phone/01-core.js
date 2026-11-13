// Built by tools/build-phone.js from the pieces in src/phone: edit those, not this file.
(function () {
    'use strict';

    // Every request to the game goes through here. The game turns away a UI mod that sends
    // too many requests in a short time (RATE_LIMITED, shown as "요청 제한 초과"), and opening
    // the home screen alone asks for a few dozen files. Requests are therefore paced; one that
    // is turned away for that reason waits and goes again instead of failing the page, and the
    // pace drops after each refusal and creeps back up while the game keeps accepting.
    var CLI_MAX_INFLIGHT = 6;
    var CLI_RATE_MAX = 30;
    var CLI_RATE_MIN = 6;
    var CLI_RATE_START = 20;
    var CLI_RETRIES = 4;
    var CLI_BACKOFF_MS = 250;
    var CLI_CALM_MS = 5000;
    var cliRate = CLI_RATE_START;
    var cliQueue = [];
    var cliInflight = 0;
    var cliPauseUntil = 0;
    var cliSentAt = [];
    var cliTimer = null;
    var cliCalmAt = 0;

    function cli(cmd, params) {
        return new Promise(function (resolve, reject) {
            cliQueue.push({ cmd: cmd, params: params, resolve: resolve, reject: reject, tries: 0 });
            cliPump();
        });
    }

    // Background polls skip a round while page requests are waiting or the game has just said no.
    function cliBacklogged() {
        return cliQueue.length > 0 || Date.now() < cliPauseUntil;
    }

    function cliRateLimited(v) {
        if (!v) return false;
        var s;
        if (typeof v === 'string') s = v;
        else if (v instanceof Error) s = v.message + ' ' + (v.code || '');
        else if (typeof v === 'object') {
            if (v.success !== false && !v.error && !v.code) return false;
            try { s = JSON.stringify(v); } catch (e) { s = String(v.message || ''); }
        } else s = String(v);
        return /RATE_LIMITED|요청 제한/.test(s);
    }

    function cliWake(ms) {
        cliTimer = setTimeout(function () {
            cliTimer = null;
            cliPump();
        }, ms < 1 ? 1 : ms);
    }

    function cliPump() {
        if (cliTimer) return;
        while (cliQueue.length && cliInflight < CLI_MAX_INFLIGHT) {
            var now = Date.now();
            if (now < cliPauseUntil) { cliWake(cliPauseUntil - now); return; }
            while (cliSentAt.length && now - cliSentAt[0] >= 1000) cliSentAt.shift();
            if (cliSentAt.length >= Math.floor(cliRate)) { cliWake(1000 - (now - cliSentAt[0]) + 1); return; }
            cliSend(cliQueue.shift(), now);
        }
    }

    function cliSend(job, now) {
        cliInflight++;
        cliSentAt.push(now);
        Promise.resolve()
            .then(function () { return wf.cli(job.cmd, job.params); })
            .then(function (res) {
                cliInflight--;
                if (cliRateLimited(res)) { cliRetry(job, res); return; }
                cliCalm();
                job.resolve(res);
                cliPump();
            }, function (err) {
                cliInflight--;
                if (cliRateLimited(err)) { cliRetry(job, err); return; }
                job.reject(err);
                cliPump();
            });
    }

    function cliRetry(job, why) {
        job.tries++;
        traceLoad('rate limited ' + job.cmd + ' try ' + job.tries + ': ' + cliSentAt.length + ' sent in the last second, pace ' +
            cliRate.toFixed(1) + '/s, ' + cliInflight + ' in flight, ' + cliQueue.length + ' waiting');
        cliRate = Math.max(CLI_RATE_MIN, cliRate * 0.7);
        cliCalmAt = Date.now();
        if (job.tries > CLI_RETRIES) {
            job.reject(why instanceof Error ? why : new Error(job.cmd + ': ' + (why && why.message ? why.message : String(why))));
            cliPump();
            return;
        }
        cliPauseUntil = Math.max(cliPauseUntil, Date.now() + CLI_BACKOFF_MS * Math.pow(2, job.tries - 1));
        cliQueue.unshift(job);
        cliPump();
    }

    function cliCalm() {
        var now = Date.now();
        if (cliRate >= CLI_RATE_MAX || now - cliCalmAt < CLI_CALM_MS) return;
        cliRate = Math.min(CLI_RATE_MAX, cliRate + 1);
        cliCalmAt = now;
    }

    var POLL_MS = 10000;
    var TEXTS_POLL_MS = 2000;
    // Possession is checked on its own. The page poll is too slow for a character switch.
    var POSSESS_POLL_MS = 250;
    // Banners are polled on their own. The page poll is 10s on the home screen, which is
    // too slow for a text that just arrived.
    var BANNER_POLL_MS = 2000;
    var BANNER_HOLD_MS = 5000;
    var BANNER_GRACE_MS = 15000;
    var BANNER_SWIPE_PX = 36;
    var BRIDGE_STALE_MS = 20000;
    var SCHEDULE_TTL_MS = 5 * 60 * 1000;
    var DAY_MIN = 1440;
    var WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    var WEATHER = { Sun: 'Sunny', Cloud: 'Cloudy', Rain: 'Rain', Snow: 'Snow', Fog: 'Fog', Storm: 'Storm' };
    var ACCENTS = ['#0A84FF', '#30D158', '#FF9F0A', '#BF5AF2', '#64D2FF', '#FF375F'];
    var NEED_COLORS = {
        Hunger: '#FF9F0A', Cleanliness: '#64D2FF', Sleep: '#5E5CE6', Toilet: '#5AC8FA',
        Fun: '#FF375F', Society: '#30D158', Admit: '#FFD60A', Energy: '#32D74B'
    };
    var HOME_NEEDS = ['Hunger', 'Sleep', 'Energy', 'Fun', 'Society', 'Cleanliness', 'Toilet', 'Admit'];
    var FAMILY_NEEDS = ['Hunger', 'Sleep', 'Fun', 'Society'];
    var BONDS = [
        { key: 'Friendship', label: 'Friendship', color: '#6fc3ff' },
        { key: 'Romance', label: 'Romance', color: '#ff7eb6' },
        { key: 'Family', label: 'Family', color: '#ffb36b' },
        { key: 'Business', label: 'Business', color: '#a98bff' }
    ];
    // The installed apps in order, kept by the app registry (registerApp, appsRebuild).
    var APPS = [];
    var TITLES = { family: 'Family', bonds: 'Bonds', oa: 'OA', time: 'Time', jobs: 'Jobs', freelance: 'Freelance', texts: 'Texts', messages: 'Messages', chat: 'Chat', persona: 'Persona', moments: 'Moments', ai: 'AI', settings: 'Settings', sounds: 'Sounds', wallpaper: 'Wallpaper', study: '雅思学习', scexam: '雅思考试', booklet: '成长册', bookread: '成长册' };
    // Mailbox on disk, one folder per conversation:
    //   <mod>/ui/phone/sms/<playerId>-<contactId>/{outbox,inbox,seen,status}.cfg
    // The phone writes outbox (the person you are playing) and seen. The contact's replies go
    // in inbox and the reply service publishes its presence in status.
    // Both characters share one conversation: A-B and B-A are always read together (see
    // loadConversation), so switching the played character shows the same chat from the other side.
    var SMS_MOD = 'HouseholdBoard_I6IXIO';
    var SMS_SECTION = 'ui/phone/sms';
    var SMS_TEXT_MAX = 400;
    var SMS_KEEP = 200;
    // A conversation opens on its newest SMS_PAGE messages; scrolling to the top (or the button
    // there) adds SMS_PAGE more. Drawing a whole kept thread (both sides, up to several hundred
    // bubbles) on every open and every new text is what made a tap on a thread hang in game.
    var SMS_PAGE = 40;
    var SMS_EARLIER_PX = 60;
    // How long after the reader's own wheel or scrollbar drag a scroll still counts as theirs.
    var SMS_READER_MS = 1200;
    // A time line goes above a message written this many game minutes after the one before it,
    // or on another game day. Times are game time: each message keeps { day, min } of the game
    // clock when it was written (game). Older messages have none and show no time.
    var SMS_STAMP_GAP_MIN = 60;
    // Emoji are written into the text as tokens like [开心] (the input box and the game font cannot
    // draw emoji) and drawn from ui/phone/emoji/<id>.png. The set, ui/phone/emoji/set.cfg, is
    // shared with the reply service, which tells the AI the same tokens.
    var EMOJI_SECTION = 'ui/phone/emoji';
    var EMOJI_BIG_MAX = 3;
    var emojiSet = null;
    var smsEmojiOpen = false;
    // Where an emoji goes in the message box; null = at the end.
    var smsCaret = null;
    var SMS_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    // Messages from one side this close together are drawn as one run of bubbles.
    var SMS_RUN_GAP_MS = 3 * 60000;
    var SMS_INPUT_MAX_PX = 116;
    // A run of bubbles that arrives together comes in one after another, not all at once.
    var SMS_IN_STAGGER_MS = 70;
    var SMS_IN_STAGGER_MAX = 280;
    var SMS_SCROLL = { response: 0.36, damping: 1, ms: 520 };
    // Moments (see sms-bridge/lib/moments.js):
    //   ui/phone/moments/feed.cfg, status.cfg      written by the reply service
    //   ui/phone/moments/<viewerId>/outbox.cfg     actions of the played character, written here
    //   ui/phone/moments/<viewerId>/seen.cfg       newest item looked at, written here
    // Character settings (see sms-bridge/lib/personas.js), one folder per character:
    //   ui/phone/persona/<id>/profile.cfg   what the player set, written only here
    //   ui/phone/persona/<id>/default.cfg   the built-in style, written by the reply service
    var PERSONA_SECTION = 'ui/phone/persona';
    var PERSONA_STYLE_MAX = 1500;
    var PERSONA_EXTRA_MAX = 800;
    var MOMENTS_SECTION = 'ui/phone/moments';
    var PORTRAIT_SECTION = 'ui/phone/portraits';
    var MOMENTS_POST_MAX = 300;
    var MOMENTS_COMMENT_MAX = 140;
    var MOMENTS_KEEP = 100;
    var SPEEDS = [1, 2, 3];
    var GROWTH_ORDER = { Baby: 0, Infant: 0, Toddler: 1, Child: 2, Teen: 3, Youth: 4, YoungAdult: 4, Adult: 5, Elder: 6 };
    var NON_WORKING_STEPS = { Baby: true, Infant: true, Toddler: true };
    var NO_PHONE_STEPS = { Baby: true, Infant: true, Toddler: true };

    var el = {
        status: document.getElementById('title-text'),
        screen: document.getElementById('ph-screen'),
        note: document.getElementById('ph-note'),
        head: null
    };
    // The fixed slot for the open page's header, between the status bar and the scrolling
    // content (see liftHead).
    el.head = document.createElement('div');
    el.head.id = 'ph-fixed-head';
    el.head.style.display = 'none';
    el.screen.parentNode.parentNode.insertBefore(el.head, el.screen.parentNode);

    var current = 'home';
    var busy = false;
    var refreshStartedAt = 0;
    var lastRefreshMs = 0;
    var pending = false;
    var noteFromLoad = false;
    // Leaving a chat starts the next page's reads while the chat's own reads and its "seen"
    // write are still going through the game, and one of those reads can fail once. A page
    // that fails is read again a few times before the error page replaces it.
    var LOAD_RETRIES = 3;
    var LOAD_RETRY_MS = 450;
    var loadFails = {};
    var loadRetryTimer = null;
    var loadTrace = [];
    var loadTraceTimer = null;
    var openedAt = 0;

    // Page changes with their timing, in ui/phone/diag/loadlog.cfg next to the failed reads.
    function traceNav(line) {
        traceLoad('nav +' + (Date.now() - openedAt) + 'ms ' + line);
    }

    // Failed page reads, kept in ui/phone/diag/loadlog.cfg so a failure that only flashes can be read later.
    function traceLoad(line) {
        var d = new Date();
        loadTrace.push(d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
            pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + ' ' + line);
        if (loadTrace.length > 60) loadTrace.splice(0, loadTrace.length - 60);
        if (loadTraceTimer) return;
        loadTraceTimer = setTimeout(function () {
            loadTraceTimer = null;
            soft(call('uimod.cfg_save', { mod_id: SMS_MOD, section: 'ui/phone/diag', key: 'loadlog', value: loadTrace.join('\n') }));
        }, 800);
    }
    var emotionTable = null;
    var scheduleCache = {};
    var careerRowCache = {};
    var l10nCache = {};
    var jobsMemberId = null;
    var smsDraft = '';
    // { contactId, text } to put in the box when that chat opens next (OA drafts a request).
    var smsPrefill = null;
    var smsFocused = false;
    var smsStick = true;
    var smsScroll = 0;
    var smsSending = false;
    var smsSeq = 0;
    // One ready-to-send photo per conversation; choosing is a PC-side guardian request.
    var smsPhotos = {};
    var smsPhotoPending = null;
    var smsPhotoWatching = false;
    var SMS_PHOTO_TEXT = '[Photo]';
    var SMS_PHOTO_WATCH_MS = 1000;
    var SMS_PHOTO_PICK_MS = 10 * 60000 + 20000;
    var smsRenderedKey = '';
    // Message ids already drawn in the open thread. Null until the thread has been shown once,
    // so opening a chat does not play the entrance on its history.
    var smsArrived = null;
    // How many of the newest messages the open thread shows: { section, count }.
    var smsWindow = { section: '', count: SMS_PAGE };
    var smsEarlierBusy = false;
    var smsReaderAt = 0;
    var smsChatData = null;
    var smsScrollRide = null;
    var smsContactId = null;
    var smsThread = null;
    // The conversation currently drawn. A new text updates that screen in place; the compose
    // box stays the same element, so an input method mid-word is never thrown away.
    var smsShownSection = '';
    // True while an input method is composing in the message box. Removing that box in this
    // state sticks the game's text capture: after that, no field on the phone takes keys,
    // and loading the save again does not clear it.
    var smsComposing = false;
    var smsComposeRefresh = false;
    var playedId = '';
    // The played character is a baby or a toddler (NO_PHONE_STEPS): the phone shows only a
    // locked page, with no apps and no banners. null until the first check answers.
    var playedYoung = null;
    var playedYoungInfo = null;
    var playedAgeAt = 0;
    var playedAgeBusy = false;
    var PLAYED_AGE_POLL_MS = 4000;
    var possessBusy = false;
    // Set for the refresh that follows a character switch, so an unsent draft is not
    // re-read out of the box that still belongs to the previous character.
    var dropPlayedInput = false;
    var refreshDropping = false;
    var smsClearAsk = false;
    var smsClearingAt = 0;
    // Incoming-text banner. bannerAt remembers the newest incoming message already handled
    // for each conversation, so the same text is not announced again. The first look at a
    // character announces a text only when it arrived after this view loaded. BANNER_GRACE_MS
    // keeps a text that lands while the view is starting.
    var bannerAt = {};
    var bannerReady = {};
    var bannerQueue = [];
    var bannerItem = null;
    var bannerEl = null;
    var bannerTimer = 0;
    var bannerBusy = false;
    var bannerHiding = false;
    var bannerDownY = null;
    var bannerDragY = 0;
    var bannerPress = null;
    var bannerPress = null;
    var bannerBorn = Date.now();
    var smsTypingShown = false;
    var momentsFeed = null;
    var momentsComposer = null;
    var momentsDraft = '';
    var momentsPostDraft = '';
    var momentsFocus = null;
    var momentsFocusPending = false;
    var momentsRenderedKey = '';
    var momentsSending = false;
    var momentsSeq = 0;
    var momentsConfirmDelete = null;
    var momentsComposeOpen = false;
    var momentsMenuPost = null;
    var portraitIndex = {};
    var portraitRev = 0;
    var lastRefreshAt = 0;
    var jobsConfirmKey = null;
    var joining = false;

    function setNote(message, isError) {
        el.note.textContent = message || '';
        el.note.className = isError ? 'ph-note err' : 'ph-note';
    }

    function errText(err) { return err && err.message ? err.message : String(err); }

    window.addEventListener('error', function (e) {
        setNote('Script error: ' + (e && e.message ? e.message : 'unknown'), true);
    });

    // ------------------------------------------------------------------
    // CLI replies
    // ------------------------------------------------------------------
    function snippet(value) {
        var s;
        try { s = typeof value === 'string' ? value : JSON.stringify(value); } catch (e) { s = String(value); }
        if (!s) s = String(value);
        return s.length > 160 ? s.slice(0, 160) + '...' : s;
    }

    function extractJson(text) {
        if (typeof text !== 'string') return null;
        var i = text.search(/[\[{]/);
        if (i < 0) return null;
        try { return JSON.parse(text.slice(i)); } catch (e) { return null; }
    }

    function unwrap(cmd, res) {
        var value = res;
        if (typeof value === 'string') value = extractJson(value) || value;
        if (value && typeof value === 'object' &&
            ('success' in value || 'data' in value || 'message' in value)) {
            if (value.success === false) {
                throw new Error(cmd + ': ' + (value.message || 'failed'));
            }
            var data = value.data;
            if (typeof data === 'string') data = extractJson(data);
            if (data && typeof data === 'object') return data;
            var fromMessage = extractJson(value.message);
            if (fromMessage) return fromMessage;
        }
        return value;
    }

    // Every request to the game goes through here. One that never answers would leave the page
    // waiting for ever — the tap then looks dead until something else unsticks it — so each call
    // is given a deadline and fails instead of hanging.
    var CALL_TIMEOUT_MS = 6000;

    function call(cmd, params, requiredKey) {
        return new Promise(function (resolve, reject) {
            var settled = false;
            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                reject(new Error(cmd + ': no answer in ' + CALL_TIMEOUT_MS + 'ms'));
            }, CALL_TIMEOUT_MS);
            function finish(fn, v) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(v);
            }
            Promise.resolve()
                .then(function () { return cli(cmd, params || {}); })
                .then(function (res) {
                    var value = unwrap(cmd, res);
                    if (requiredKey && !(value && typeof value === 'object' && requiredKey in value)) {
                        throw new Error(cmd + ': unexpected reply ' + snippet(res));
                    }
                    return value;
                })
                .then(function (v) { finish(resolve, v); }, function (e) { finish(reject, e); });
        });
    }

    function soft(promise) {
        return promise.then(function (v) { return v; }, function (err) { return { error: errText(err) }; });
    }

    // ------------------------------------------------------------------
    // Time
    // ------------------------------------------------------------------
    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function hhmmToMinutes(v) {
        var n = Number(v) || 0;
        return Math.floor(n / 100) * 60 + (n % 100);
    }

    function minutesToLabel(m) {
        m = ((m % DAY_MIN) + DAY_MIN) % DAY_MIN;
        return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
    }

    function envMinutes(env) {
        if (!env || typeof env.hour !== 'number') return null;
        return env.hour * 60 + (env.minute || 0);
    }

    function clockText(env) {
        var now = envMinutes(env);
        return now === null ? '--:--' : minutesToLabel(now);
    }

    function greeting(env) {
        var h = env && typeof env.hour === 'number' ? env.hour : 12;
        if (h >= 5 && h < 12) return 'Good morning';
        if (h >= 12 && h < 18) return 'Good afternoon';
        if (h >= 18 && h < 23) return 'Good evening';
        return 'Good night';
    }

    function inWindow(now, start, end) {
        if (end > start) return now >= start && now < end;
        return now >= start || now < end;
    }

    function dayLabel(days) {
        if (!days || !days.length) return 'No set days';
        if (days.length === 5) {
            var weekdays = true;
            for (var i = 0; i < WEEKDAYS.length; i++) {
                if (days.indexOf(WEEKDAYS[i]) < 0) weekdays = false;
            }
            if (weekdays) return 'Mon - Fri';
        }
        if (days.length === 7) return 'Every day';
        return days.map(function (d) { return String(d).slice(0, 3); }).join(' ');
    }

    function clampPct(v) {
        var n = Number(v) || 0;
        if (n < 0) return 0;
        if (n > 100) return 100;
        return n;
    }

    // ------------------------------------------------------------------
    // Game data
    // ------------------------------------------------------------------
    function getEnv() { return cachedRead('env', 900, function () { return call('environment.get_state', {}, 'hour'); }); }

    // ------------------------------------------------------------------
    // Reads every page repeats. The clock, who is being played, the household, the portrait
    // index and the outside contacts change slowly, yet opening a page asked the game for all of
    // them again: twelve round trips before a tap could even start moving, which is what made a
    // conversation feel stuck for a second. A read taken within the last second by the page you
    // came from is good enough for the one you are opening; the poll re-reads them all anyway.
    // ------------------------------------------------------------------
    var freshReads = {};

    function cachedRead(key, ttlMs, run) {
        var seen = freshReads[key];
        if (seen && Date.now() - seen.at < ttlMs) return seen.p;
        var p = Promise.resolve().then(run).then(function (value) {
            freshReads[key] = { at: Date.now(), p: Promise.resolve(value) };
            return value;
        }, function (err) {
            delete freshReads[key];
            throw err;
        });
        return p;
    }

    function forgetReads() { freshReads = {}; }

    function forgetRead(key) { delete freshReads[key]; }

    function getPossessedId() {
        return cachedRead('played', 200, function () {
            return call('entity.get_possessed', {}, 'entity_id').then(function (r) { return String(r.entity_id); });
        });
    }

    function getMembers() {
        return cachedRead('members', 1200, function () {
            return call('household.get_members', {}, 'members').then(function (h) { return h.members || []; });
        });
    }

    function getEmotionTable() {
        if (emotionTable) return Promise.resolve(emotionTable);
        return call('emotion.list_all', {}, 'emotions').then(function (r) {
            var table = {};
            (r.emotions || []).forEach(function (e) {
                var levels = {};
                (e.levels || []).forEach(function (l) { levels[l.level] = l.l10n; });
                table[e.id] = { tendency: e.tendency, levels: levels };
            });
            emotionTable = table;
            return table;
        }, function () { return {}; });
    }

    function getEmotion(id) { return call('emotion.get_current', { entity_id: id }, 'emotion_type'); }

    function getStats(id) { return call('stat.get_all', { entity_id: id }, 'stats'); }

    function emotionLabel(table, emo) {
        if (!emo || emo.error || !emo.emotion_type) return null;
        var row = table ? table[emo.emotion_type] : null;
        var text = row && row.levels[emo.level] ? row.levels[emo.level] : emo.emotion_type;
        return { text: text, tendency: row ? row.tendency : 'neutral' };
    }

    function indexWork(reply) {
        var map = {};
        var rows = reply && reply.results ? reply.results : [];
        for (var i = 0; i < rows.length; i++) map[String(rows[i].entity_id)] = rows[i];
        return map;
    }

    function getWorkStatus(members) {
        var ids = members
            .filter(function (m) { return !!m.has_career; })
            .map(function (m) { return String(m.entity_id); })
            .join(',');
        if (!ids) return Promise.resolve({});
        return soft(call('career.get_work_status', { entity_ids: ids }, 'results')).then(indexWork);
    }

    // ------------------------------------------------------------------
    // Work schedule from game data
    // ------------------------------------------------------------------
    function pickSlot(slots) {
        if (!slots) return null;
        var order = ['business', 'school', 'club'];
        for (var i = 0; i < order.length; i++) {
            var s = slots[order[i]];
            if (s && s.careerDtId && s.careerDtId !== 'None') return s;
        }
        for (var k in slots) {
            if (slots.hasOwnProperty(k) && slots[k] && slots[k].careerDtId && slots[k].careerDtId !== 'None') {
                return slots[k];
            }
        }
        return null;
    }

    function loadCareerRow(careerDtId) {
        if (careerRowCache[careerDtId]) return Promise.resolve(careerRowCache[careerDtId]);
        return call('data.table_get', { Alias: 'Career', Row: careerDtId }, 'organizations')
            .then(function (row) {
                careerRowCache[careerDtId] = row;
                return row;
            });
    }

    function loadCareerSlot(entityId) {
        return call('entity.reflect', { entity_id: String(entityId), Component: 'FB2CareerComponent' }, 'careerSlots')
            .then(function (career) { return pickSlot(career.careerSlots); });
    }

    function findOrg(row, jobId) {
        var orgs = row && row.organizations ? row.organizations : [];
        for (var i = 0; i < orgs.length; i++) {
            if (orgs[i].jobId === jobId) return orgs[i];
        }
        return null;
    }

    function localize(keys) {
        var missing = [];
        keys.forEach(function (k) {
            if (k && !(k in l10nCache) && missing.indexOf(k) < 0) missing.push(k);
        });
        if (!missing.length) return Promise.resolve(l10nCache);
        return call('l10n.get', { Keys: JSON.stringify(missing) }).then(function (map) {
            missing.forEach(function (k) {
                var v = map && typeof map[k] === 'string' ? map[k] : '';
                l10nCache[k] = v && v !== k ? v : '';
            });
            return l10nCache;
        }, function () { return l10nCache; });
    }

    function loadSchedule(member) {
        var key = String(member.entity_id);
        var cached = scheduleCache[key];
        if (cached && Date.now() - cached.at < SCHEDULE_TTL_MS) return Promise.resolve(cached.value);

        return loadCareerSlot(key)
            .then(function (slot) {
                if (!slot) return null;
                return loadCareerRow(slot.careerDtId).then(function (row) {
                    var orgs = row.organizations || [];
                    for (var i = 0; i < orgs.length; i++) {
                        if (orgs[i].jobId === slot.jobDtId) {
                            return {
                                days: orgs[i].workDays || [],
                                start: hhmmToMinutes(orgs[i].startTime),
                                end: hhmmToMinutes(orgs[i].endTime),
                                remote: !!orgs[i].bCanRemoteWork
                            };
                        }
                    }
                    return null;
                });
            })
            .then(function (value) {
                scheduleCache[key] = { at: Date.now(), value: value };
                return value;
            });
    }

    function describe(work, sched, env) {
        if (work && !work.error && work.is_at_work) return { cls: 'pill-work', text: 'At work' };
        if (work && !work.error && work.is_commute_time) return { cls: 'pill-move', text: 'Commuting' };

        var known = work && !work.error;
        var now = envMinutes(env);
        var workday = known ? !!work.is_working_day
            : !!(sched && env && sched.days.indexOf(env.day_of_week) >= 0);
        var onShift = known ? !!work.is_working_time
            : !!(sched && now !== null && inWindow(now, sched.start, sched.end));

        if (!workday) return { cls: 'pill-idle', text: 'Day off' };
        if (onShift) return { cls: 'pill-late', text: 'Not at work' };
        if (!sched || now === null) return { cls: 'pill-idle', text: 'Off shift' };
        if (sched.end > sched.start && now >= sched.end) return { cls: 'pill-idle', text: 'Done today' };
        return { cls: 'pill-idle', text: 'Starts ' + minutesToLabel(sched.start) };
    }

    // ------------------------------------------------------------------
    // DOM helpers
    // ------------------------------------------------------------------
    function node(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }

    function textField(elm) {
        if (!elm || !elm.tagName) return false;
        var tag = String(elm.tagName).toUpperCase();
        return tag === 'INPUT' || tag === 'TEXTAREA';
    }

    // The game keeps the mouse and the keyboard while a text field is focused. Removing
    // that field without blurring it first leaves the capture on, with nothing left to
    // type into: the phone stops taking clicks, and leaving the game window does not
    // open the field again. Sliding a page that still contains the focused field (leaving
    // a chat) does the same for a moment: the UI engine drops the whole phone and draws
    // it again. detach pulls the field out of the page that is about to move; clear()
    // removes the page itself on the same turn, so it only blurs.
    function releaseTextFocus(root, detach) {
        var a = document.activeElement;
        if (!root || !a || !root.contains || !root.contains(a) || !textField(a)) return;
        if (a.id === 'sms-box' && smsComposing) {
            holdComposingField(a);
            return;
        }
        try { a.blur(); } catch (e) {}
        if (detach && a.parentNode && root.contains(a)) a.parentNode.removeChild(a);
    }

    function clear(n) {
        releaseTextFocus(n, false);
        while (n.firstChild) n.removeChild(n.firstChild);
    }

    // The composing box has to stay in the document until the input method finishes, and it
    // has to leave the screen that is about to be rebuilt. Blur and removal are separate
    // turns: doing both at once is what sticks the game's text capture.
    function holdComposingField(a) {
        a.removeAttribute('id');
        var park = document.getElementById('sms-ime-park');
        if (!park) {
            park = document.createElement('div');
            park.id = 'sms-ime-park';
            park.style.position = 'absolute';
            park.style.left = '-9999px';
            park.style.top = '0';
            park.style.width = '1px';
            park.style.height = '1px';
            park.style.overflow = 'hidden';
            document.body.appendChild(park);
        }
        park.appendChild(a);
        setTimeout(function () {
            try { a.blur(); } catch (e) {}
            setTimeout(function () {
                smsComposing = false;
                if (a.parentNode) a.parentNode.removeChild(a);
                if (!smsComposeRefresh) return;
                smsComposeRefresh = false;
                refresh();
            }, 0);
        }, 0);
    }

