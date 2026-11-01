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
    var TITLES = { family: 'Family', bonds: 'Bonds', work: 'Work', time: 'Time', jobs: 'Jobs', freelance: 'Freelance', texts: 'Texts', messages: 'Messages', chat: 'Chat', persona: 'Persona', moments: 'Moments', ai: 'AI', settings: 'Settings', sounds: 'Sounds', wallpaper: 'Wallpaper' };
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
            return Promise.all([infoP, soft(getEmotion(id)), soft(getStats(id)), totalUnread(id, members), momentsUnread(id)]).then(function (d) {
                return {
                    env: r[0], table: r[1], id: id, info: d[0], emotion: d[1], stats: d[2],
                    unread: d[3], momentsUnread: d[4]
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
        } else if (id === 'work') {
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
        onTap(tile, function (e) {
            e.stopPropagation();
            if (homeTapBlocked()) return;
            soundPlay('tap');
            open(app.id);
        }, { silent: true });
        return tile;
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
    function homeHero(env) {
        var hero = node('div', 'ph-hero');
        hero.appendChild(node('div', 'ph-greet', greeting(env)));
        hero.appendChild(node('div', 'ph-clock', clockText(env)));
        hero.appendChild(joinWithDots(node('div', 'ph-date'), [env.day_of_week, env.season]));
        var weatherParts = [];
        if (env.weather) weatherParts.push(WEATHER[env.weather] || env.weather);
        if (typeof env.temperature === 'number') weatherParts.push(env.temperature + ' C');
        if (weatherParts.length) hero.appendChild(node('div', 'ph-weather', weatherParts.join('  ')));
        return hero;
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
        var key = homeTilesKey(data);
        if (v.tilesKey !== key) {
            if (v.tileIds !== homeTileIds() || !homePatchBadges(data)) { traceNav('home rebuild: apps changed'); return false; }
            v.tilesKey = key;
        }
        traceNav('home patched');
        // Children only: the pages carry the sizes the layout gave them.
        morphChildren(v.today, homeTodayPage(data));
        morphChildren(v.hero, homeHero(data.env));
        return true;
    }

    function renderHome(data) {
        var env = data.env;
        homeIcons = {};
        var wrap = node('div', 'hs');
        var viewport = node('div', 'hs-viewport');
        var track = node('div', 'hs-track');
        viewport.appendChild(track);
        wrap.appendChild(viewport);

        var today = homeTodayPage(data);

        var main = node('div', 'hs-page');
        var hero = homeHero(env);
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
            pages: [today, main], tiles: tiles, w: 0, h: 0, hero: hero, tilesKey: homeTilesKey(data), tileIds: homeTileIds() };
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
    // Family
    // ------------------------------------------------------------------
    function loadFamily() {
        return Promise.all([getEnv(), getEmotionTable(), getMembers()]).then(function (r) {
            var members = r[2];
            return Promise.all([
                getWorkStatus(members),
                Promise.all(members.map(function (m) {
                    var id = String(m.entity_id);
                    return Promise.all([soft(getEmotion(id)), soft(getStats(id))]);
                }))
            ]).then(function (d) {
                return { env: r[0], table: r[1], members: members, work: d[0], details: d[1] };
            });
        });
    }

    function renderFamily(data) {
        var wrap = node('div');
        wrap.appendChild(subHeader('family'));
        if (!data.members.length) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'No household members found.'));
            wrap.appendChild(none);
            return wrap;
        }
        data.members.forEach(function (m, idx) {
            var detail = data.details[idx] || [];
            var c = card();
            var work = data.work[String(m.entity_id)];
            var subParts = [m.relationship_label || m.age_group_text];
            if (m.has_career) {
                var state = describe(work, null, data.env);
                subParts.push(state.text);
            }
            c.appendChild(personRow(m, subParts, moodPill(emotionLabel(data.table, detail[0]))));
            c.appendChild(needsGrid(detail[1], FAMILY_NEEDS));
            wrap.appendChild(c);
        });
        return wrap;
    }

    // ------------------------------------------------------------------
    // Bonds
    // ------------------------------------------------------------------
    function loadBonds() {
        return Promise.all([getEnv(), getPossessedId(), getMembers()]).then(function (r) {
            var me = r[1];
            var members = r[2];
            var self = null;
            var others = [];
            members.forEach(function (m) {
                if (String(m.entity_id) === me) self = m;
                else others.push(m);
            });
            return Promise.all(others.map(function (m) {
                return soft(call('relationships.get_value_between',
                    { owner_id: me, target_id: String(m.entity_id) }, 'stats'));
            })).then(function (rels) {
                return { env: r[0], meId: me, self: self, others: others, rels: rels };
            });
        });
    }

    function renderBonds(data) {
        var wrap = node('div');
        wrap.appendChild(subHeader('bonds'));
        var from = data.self ? fullName(data.self) : ('#' + data.meId);
        wrap.appendChild(node('div', 'ph-caption', 'How ' + from + ' feels about everyone'));

        if (!data.others.length) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'Nobody else lives here.'));
            wrap.appendChild(none);
            return wrap;
        }
        data.others.forEach(function (m, idx) {
            var rel = data.rels[idx];
            var c = card();
            c.appendChild(personRow(m, [m.relationship_label, m.age_group_text], null));
            if (!rel || rel.error || !rel.stats) {
                var msg = node('div', 'ph-empty', 'Relationship unavailable');
                msg.style.marginTop = '10px';
                c.appendChild(msg);
            } else {
                BONDS.forEach(function (b) {
                    var s = rel.stats[b.key];
                    if (!s || typeof s.value !== 'number') return;
                    var item = node('div', 'ph-bond');
                    var top = node('div', 'ph-bond-top');
                    top.appendChild(node('span', null, b.label));
                    top.appendChild(node('span', 'ph-need-val', String(Math.round(s.value))));
                    item.appendChild(top);
                    item.appendChild(bar(s.value, b.color));
                    c.appendChild(item);
                });
            }
            wrap.appendChild(c);
        });
        return wrap;
    }

    // ------------------------------------------------------------------
    // Contacts: the game phone's own contact list (contacts.get_all) with how the played
    // character feels about each person (relationships.list), grouped like a phone's contacts:
    // the player's card, Family, Friends, Others. A contact's page has their job, where they
    // are and the bonds, and Message for those the phone can text (people at home old enough
    // for a phone). Faces are the game portraits the reply service copies (portraits.js).
    // ------------------------------------------------------------------
    var CT_GROUPS = [
        { id: 'family', title: 'Family' },
        { id: 'friends', title: 'Friends' },
        { id: 'others', title: 'Others' }
    ];
    var ctOpenId = null;

    function ctStat(rel, key) {
        var s = rel && rel.stats && rel.stats[key];
        return s && typeof s.value === 'number' ? s.value : 0;
    }

    function ctLevel(rel, key) {
        var s = rel && rel.stats && rel.stats[key];
        return s && typeof s.level === 'number' ? s.level : 0;
    }

    // What someone is to the played character, from the game's label and the bonds.
    function ctKind(c, rel, meHousehold) {
        var family = (rel && rel.is_family) || (meHousehold && String(c.household_id) === meHousehold && c.relationship_label && c.relationship_label !== '…');
        if (family) return { group: 'family', label: c.relationship_label && c.relationship_label !== '…' ? c.relationship_label : 'Family' };
        var romance = ctStat(rel, 'Romance');
        var friend = ctStat(rel, 'Friendship');
        var work = ctStat(rel, 'Business');
        if (romance >= 20 && romance >= friend) return { group: 'friends', label: 'Romance' };
        if (ctLevel(rel, 'Friendship') >= 2) return { group: 'friends', label: 'Close Friend' };
        if (friend >= 20) return { group: 'friends', label: 'Friend' };
        if (work >= 10 && work >= friend) return { group: 'others', label: 'Colleague' };
        return { group: 'others', label: 'Acquaintance' };
    }

    function ctCloseness(rel) {
        return Math.max(ctStat(rel, 'Friendship'), ctStat(rel, 'Romance'), ctStat(rel, 'Family'), ctStat(rel, 'Business'));
    }

    function loadContacts() {
        var env, me;
        return Promise.all([getEnv(), getPossessedId(), soft(getMembers()), loadPortraitIndex()]).then(function (r) {
            env = r[0];
            me = r[1];
            var members = r[2] && !r[2].error ? r[2] : [];
            return Promise.all([
                soft(call('contacts.get_all', {}, 'contacts')),
                soft(call('relationships.list', { owner_id: me }, 'relationships')),
                Promise.resolve(members)
            ]);
        }).then(function (r) {
            var list = r[0] && !r[0].error && Array.isArray(r[0].contacts) ? r[0].contacts : null;
            var rels = {};
            (r[1] && !r[1].error && Array.isArray(r[1].relationships) ? r[1].relationships : []).forEach(function (x) { rels[String(x.target_id)] = x; });
            var members = r[2];
            var self = null;
            members.forEach(function (m) { if (String(m.entity_id) === me) self = m; });
            var meHousehold = self && self.household_id !== undefined ? String(self.household_id) : '';
            var people = (list || []).filter(function (c) { return String(c.entity_id) !== me; }).map(function (c) {
                var id = String(c.entity_id);
                var rel = rels[id] || null;
                var kind = ctKind(c, rel, meHousehold);
                var home = meHousehold && String(c.household_id) === meHousehold;
                return {
                    id: id, c: c, rel: rel, group: kind.group, label: kind.label, closeness: ctCloseness(rel), home: !!home,
                    // Anyone old enough for a phone; the played character too.
                    textable: !NO_PHONE_STEPS[c.age_group] && !(self && NO_PHONE_STEPS[self.age_group])
                };
            });
            people.sort(function (a, b) { return b.closeness - a.closeness || fullName(a.c).localeCompare(fullName(b.c)); });
            return { env: env, me: me, self: self, people: people, failed: !list };
        });
    }

    function ctRow(p) {
        var row = node('div', 'ct-row');
        row.appendChild(faceAvatar(p.c));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', fullName(p.c)));
        joinWithDots(who.appendChild(node('div', 'ph-sub')), [p.label, p.c.job_name || p.c.age_group_text]);
        row.appendChild(who);
        row.appendChild(node('div', 'ct-chev', '›'));
        onTap(row, function (e) {
            e.stopPropagation();
            ctOpenId = p.id;
            open('contact');
        });
        return row;
    }

    function renderContacts(data) {
        var wrap = node('div', 'ct-screen');
        wrap.appendChild(subHeader('contacts'));
        if (data.self) {
            var mine = node('div', 'ph-card ct-me');
            var line = node('div', 'ph-row');
            var face = faceAvatar(data.self);
            face.className += ' ct-avatar-md';
            line.appendChild(face);
            var who = node('div', 'ph-who');
            who.appendChild(node('div', 'ct-me-name', fullName(data.self)));
            who.appendChild(node('div', 'ph-sub', 'My Card'));
            line.appendChild(who);
            mine.appendChild(line);
            wrap.appendChild(mine);
        }
        if (data.failed) {
            var bad = card();
            bad.appendChild(node('div', 'ph-empty', 'The contact list could not be read from the game.'));
            wrap.appendChild(bad);
            return wrap;
        }
        if (!data.people.length) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'No contacts yet. Meet people in town and they show up here.'));
            wrap.appendChild(none);
            return wrap;
        }
        CT_GROUPS.forEach(function (g) {
            var rows = data.people.filter(function (p) { return p.group === g.id; });
            if (!rows.length) return;
            var head = node('div', 'ct-sec');
            head.appendChild(node('span', null, g.title));
            head.appendChild(node('span', 'ct-sec-count', String(rows.length)));
            wrap.appendChild(head);
            var list = node('div', 'ph-card ct-list');
            rows.forEach(function (p) { list.appendChild(ctRow(p)); });
            wrap.appendChild(list);
        });
        wrap.appendChild(node('div', 'ph-caption ct-foot', data.people.length + ' contacts, from your phone in the game'));
        return wrap;
    }

    function ctInfo(label, value) {
        var row = node('div', 'ct-info-row');
        row.appendChild(node('div', 'ct-info-label', label));
        row.appendChild(node('div', 'ct-info-value', value));
        return row;
    }

    function renderContact(data) {
        var p = null;
        data.people.forEach(function (x) { if (x.id === ctOpenId) p = x; });
        var wrap = node('div', 'ct-screen');
        wrap.appendChild(subHeader('contact', 'Contact'));
        if (!p) {
            var gone = card();
            gone.appendChild(node('div', 'ph-empty', 'This person is no longer in your contacts.'));
            wrap.appendChild(gone);
            return wrap;
        }
        var c = p.c;
        var hero = node('div', 'ct-hero');
        var face = faceAvatar(c);
        face.className += ' ct-avatar-lg';
        hero.appendChild(face);
        hero.appendChild(node('div', 'ct-hero-name', fullName(c)));
        joinWithDots(hero.appendChild(node('div', 'ct-hero-sub')), [p.label, c.age_group_text, c.gender_text]);
        var acts = node('div', 'ct-actions');
        var msg = node('div', 'ct-act' + (p.textable ? '' : ' off'));
        msg.appendChild(node('div', 'ct-act-icon', '✉'));
        msg.appendChild(node('div', 'ct-act-label', 'Message'));
        if (p.textable) {
            onTap(msg, function (e) {
                e.stopPropagation();
                // Someone outside the household joins Texts the first time they are messaged.
                var go = function () {
                    smsContactId = p.id;
                    open('chat');
                };
                if (p.home) go();
                else addOutside(data.me, c, p.label).then(go, go);
            });
        }
        acts.appendChild(msg);
        hero.appendChild(acts);
        if (!p.textable) hero.appendChild(node('div', 'ct-note', 'Too young for a phone.'));
        else if (!p.home) hero.appendChild(node('div', 'ct-note', 'They answer in their own words; they live their own life in the game.'));
        wrap.appendChild(hero);

        var info = node('div', 'ph-card ct-info');
        if (c.job_name) info.appendChild(ctInfo('Work', c.job_name + (c.job_rank_name ? ' · ' + c.job_rank_name : '')));
        else if (c.has_career === false && c.employable) info.appendChild(ctInfo('Work', 'No job right now'));
        info.appendChild(ctInfo('Where', c.current_site || 'Somewhere in town'));
        info.appendChild(ctInfo('Home', p.home ? 'Lives with you' : 'Lives elsewhere'));
        if (c.is_married) info.appendChild(ctInfo('Married', 'Yes'));
        wrap.appendChild(info);

        if (p.rel && p.rel.stats) {
            var bonds = card('HOW YOU FEEL');
            BONDS.forEach(function (b) {
                var s = p.rel.stats[b.key];
                if (!s || typeof s.value !== 'number') return;
                var item = node('div', 'ph-bond');
                var top = node('div', 'ph-bond-top');
                top.appendChild(node('span', null, b.label));
                top.appendChild(node('span', 'ph-need-val', String(Math.round(s.value))));
                item.appendChild(top);
                item.appendChild(bar(s.value, b.color));
                bonds.appendChild(item);
            });
            wrap.appendChild(bonds);
        }
        return wrap;
    }

    function contactsGlyph() {
        var svg = glyphSvg('0 0 24 24');
        glyphPath(svg, 'M12 4.2a3.9 3.9 0 1 1 0 7.8 3.9 3.9 0 0 1 0-7.8zM4.6 19.6c.5-3.6 3.6-5.9 7.4-5.9s6.9 2.3 7.4 5.9c.1.5-.3.9-.8.9H5.4c-.5 0-.9-.4-.8-.9z');
        return svg;
    }

    // ------------------------------------------------------------------
    // Work
    // ------------------------------------------------------------------
    function loadWork() {
        return Promise.all([getEnv(), getMembers()]).then(function (r) {
            var workers = r[1].filter(function (m) { return !!m.has_career; });
            return Promise.all([
                getWorkStatus(workers),
                Promise.all(workers.map(function (m) { return soft(loadSchedule(m)); }))
            ]).then(function (d) {
                return { env: r[0], workers: workers, work: d[0], schedules: d[1] };
            });
        });
    }

    function renderWork(data) {
        var wrap = node('div');
        wrap.appendChild(subHeader('work'));
        if (!data.workers.length) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'Nobody in this household has a job.'));
            wrap.appendChild(none);
            return wrap;
        }
        data.workers.forEach(function (m, idx) {
            var sched = data.schedules[idx];
            var validSched = sched && !sched.error ? sched : null;
            var work = data.work[String(m.entity_id)];
            var state = describe(work, validSched, data.env);
            var c = card();
            c.appendChild(personRow(m, [m.job_name, m.job_rank_name],
                node('span', 'ph-pill ' + state.cls, state.text)));
            if (validSched) {
                c.appendChild(node('div', 'ph-hours',
                    minutesToLabel(validSched.start) + ' - ' + minutesToLabel(validSched.end)));
                c.appendChild(joinWithDots(node('div', 'ph-sub'),
                    [dayLabel(validSched.days), validSched.remote ? 'Remote OK' : 'On site']));
                var active = work && !work.error ? !!work.is_working_day : true;
                c.appendChild(timeline(validSched, data.env, accentFor(m.entity_id), active));
            } else {
                var msg = node('div', 'ph-empty', sched && sched.error ? sched.error : 'Hours unavailable');
                msg.style.marginTop = '10px';
                c.appendChild(msg);
            }
            wrap.appendChild(c);
        });
        return wrap;
    }

    // ------------------------------------------------------------------
    // Time
    // ------------------------------------------------------------------
    function loadTime() {
        return Promise.all([getEnv(), call('environment.get_simulation', {}, 'time_scale')]).then(function (r) {
            return { env: r[0], sim: r[1] };
        });
    }

    function runAction(label, factory) {
        setNote(label + '...', false);
        noteFromLoad = false;
        factory().then(function () {
            setNote(label + ' done', false);
            refresh();
        }, function (err) {
            setNote(errText(err), true);
        });
    }

    function actionButton(text, cls, onClick) {
        var b = node('div', 'ph-btn' + (cls ? ' ' + cls : ''), text);
        onTap(b, function (e) {
            e.stopPropagation();
            onClick();
        });
        return b;
    }

    function renderTime(data) {
        var wrap = node('div');
        wrap.appendChild(subHeader('time'));
        var sim = data.sim;
        var paused = !!sim.is_paused;
        var scale = Number(sim.time_scale) || 0;

        var info = card('GAME CLOCK');
        var stateRow = node('div', 'ph-row');
        stateRow.style.marginTop = '8px';
        var left = node('div', 'ph-who');
        left.appendChild(node('div', 'ph-state', clockText(data.env)));
        left.appendChild(node('div', 'ph-speed', (paused ? 'Paused' : 'Running') + '  x' + scale.toFixed(1)));
        stateRow.appendChild(left);
        stateRow.appendChild(node('span', 'ph-pill ' + (paused ? 'pill-late' : 'pill-work'), paused ? 'Paused' : 'Live'));
        info.appendChild(stateRow);
        info.appendChild(joinWithDots(node('div', 'ph-sub'), [data.env.day_of_week, data.env.season]));
        wrap.appendChild(info);

        var playRow = node('div', 'ph-btns');
        playRow.appendChild(actionButton(paused ? 'Play' : 'Pause', 'last on', function () {
            runAction(paused ? 'Play' : 'Pause', function () {
                return call('environment.pause', { Enable: !paused });
            });
        }));
        wrap.appendChild(playRow);

        var speedRow = node('div', 'ph-btns');
        SPEEDS.forEach(function (speed, i) {
            var active = !paused && Math.abs(scale - speed) < 0.01;
            var cls = (i === SPEEDS.length - 1 ? 'last' : '') + (active ? ' on' : '');
            speedRow.appendChild(actionButton(speed + 'x', cls, function () {
                runAction('Speed ' + speed + 'x', function () {
                    return call('environment.time_speed', { Speed: speed }).then(function () {
                        return paused ? call('environment.pause', { Enable: false }) : null;
                    });
                });
            }));
        });
        wrap.appendChild(speedRow);

        var skipRow = node('div', 'ph-btns');
        skipRow.appendChild(actionButton('+1 Hour', 'last', function () {
            runAction('Skip 1 hour', function () {
                return call('environment.time_skip', { Hours: 1 });
            });
        }));
        wrap.appendChild(skipRow);
        return wrap;
    }

    // ------------------------------------------------------------------
    // Jobs
    // ------------------------------------------------------------------
    var lastJobsData = null;

    function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    function memberById(members, id) {
        if (id === null || id === undefined) return null;
        for (var i = 0; i < members.length; i++) {
            if (String(members[i].entity_id) === String(id)) return members[i];
        }
        return null;
    }

    function loadJobs() {
        return Promise.all([
            getEnv(),
            getMembers(),
            soft(getPossessedId()),
            call('career.list_openings', {}, 'openings')
        ]).then(function (r) {
            var members = r[1].filter(function (m) { return !NON_WORKING_STEPS[m.age_group]; });
            var possessed = typeof r[2] === 'string' ? r[2] : null;
            if (!memberById(members, jobsMemberId)) {
                jobsMemberId = memberById(members, possessed) ? possessed
                    : (members.length ? String(members[0].entity_id) : null);
                jobsConfirmKey = null;
            }
            var openings = r[3].openings || [];
            var dtIds = [];
            openings.forEach(function (o) {
                if (dtIds.indexOf(o.career_dt_id) < 0) dtIds.push(o.career_dt_id);
            });
            return Promise.all(dtIds.map(function (id) { return soft(loadCareerRow(id)); })).then(function (rows) {
                var rowById = {};
                var keys = [];
                dtIds.forEach(function (id, i) {
                    var row = rows[i] && !rows[i].error ? rows[i] : null;
                    rowById[id] = row;
                    if (row && row.displayName) keys.push(row.displayName);
                });
                openings.forEach(function (o) {
                    var org = findOrg(rowById[o.career_dt_id], o.job_id);
                    if (org && org.rankList && org.rankList.length) keys.push(org.rankList[0].rankName);
                });
                return Promise.all([
                    localize(keys),
                    jobsMemberId ? soft(loadCareerSlot(jobsMemberId)) : Promise.resolve(null)
                ]).then(function (d) {
                    return {
                        env: r[0], members: members, openings: openings,
                        rowById: rowById, text: d[0], slot: d[1]
                    };
                });
            });
        });
    }

    function jobModel(o, row, text, member) {
        var org = findOrg(row, o.job_id);
        var rank = org && org.rankList && org.rankList.length ? org.rankList[0] : null;
        var shift = rank && rank.shift ? rank.shift : null;
        var model = {
            opening: o,
            key: o.career_entity_id + '|' + o.job_id,
            company: (row && text[row.displayName]) || o.career_dt_id,
            rankName: rank ? (text[rank.rankName] || '') : '',
            org: org,
            salary: shift && typeof shift.salaryPerDay === 'number' ? shift.salaryPerDay : null,
            minStep: shift ? shift.minGrowthStep : null,
            maxStep: shift ? shift.maxGrowthStep : null,
            hidden: !!(org && (org.hiddenFromUI || org.bRecruitable === false)),
            eligible: true
        };
        if (member && model.minStep && model.maxStep) {
            var step = GROWTH_ORDER[member.age_group];
            var lo = GROWTH_ORDER[model.minStep];
            var hi = GROWTH_ORDER[model.maxStep];
            if (step !== undefined && lo !== undefined && hi !== undefined) {
                model.eligible = step >= lo && step <= hi;
            }
        }
        return model;
    }

    function jobRank(model) {
        if (!model.eligible) return 2;
        return (Number(model.opening.vacancy) || 0) > 0 ? 0 : 1;
    }

    function verifyJoined(entityId, dtId, jobId, tries) {
        return loadCareerSlot(entityId).then(function (slot) {
            if (slot && slot.careerDtId === dtId && slot.jobDtId === jobId) return true;
            if (tries <= 1) return false;
            return wait(800).then(function () { return verifyJoined(entityId, dtId, jobId, tries - 1); });
        });
    }

    function joinJob(member, model) {
        if (joining) return;
        joining = true;
        jobsConfirmKey = null;
        noteFromLoad = false;
        var who = fullName(member);
        var o = model.opening;
        setNote('Applying for ' + o.job_name + '...', false);
        if (lastJobsData && current === 'jobs') show(renderJobs(lastJobsData));

        call('career.join', {
            entity_id: String(member.entity_id),
            career_entity_id: String(o.career_entity_id),
            job_id: o.job_id
        })
            .then(function () { return verifyJoined(member.entity_id, o.career_dt_id, o.job_id, 4); })
            .then(function (ok) {
                if (!ok) throw new Error('The game did not assign ' + o.job_name + ' to ' + who + '.');
                delete scheduleCache[String(member.entity_id)];
                setNote(who + ' joined ' + model.company + ' as ' + o.job_name, false);
            })
            .catch(function (err) { setNote(errText(err), true); })
            .then(function () {
                joining = false;
                refresh();
            });
    }

    function rerenderJobs() {
        if (!lastJobsData || current !== 'jobs') return;
        var scrollTop = wf.content.scrollTop;
        show(renderJobs(lastJobsData));
        wf.content.scrollTop = scrollTop;
    }

    function jobButton(member, model, isCurrent) {
        var confirmKey = String(member.entity_id) + '|' + model.key;
        if (isCurrent) return actionButton('Current job', 'last off', function () {});
        if (!model.eligible) return actionButton('Not eligible', 'last off', function () {});
        if ((Number(model.opening.vacancy) || 0) <= 0) return actionButton('No vacancy', 'last off', function () {});
        if (joining) return actionButton('Please wait', 'last off', function () {});
        if (jobsConfirmKey === confirmKey) {
            return actionButton(member.has_career ? 'Confirm switch' : 'Confirm', 'last warn', function () {
                joinJob(member, model);
            });
        }
        return actionButton('Apply', 'last on', function () {
            jobsConfirmKey = confirmKey;
            setNote(member.has_career
                ? fullName(member) + ' will leave ' + (member.job_name || 'the current job') + '. Tap again to confirm.'
                : 'Tap again to confirm.', false);
            noteFromLoad = false;
            rerenderJobs();
        });
    }

    function jobCard(member, model, slot) {
        var o = model.opening;
        var org = model.org;
        var isCurrent = !!(slot && !slot.error && slot.careerDtId === o.career_dt_id && slot.jobDtId === o.job_id);
        var vacancy = Number(o.vacancy) || 0;
        var c = node('div', 'ph-card ph-job');

        var logo = node('div', 'ph-avatar', (model.company || '?').charAt(0));
        logo.style.background = accentFor(o.career_entity_id);
        var row = node('div', 'ph-row');
        row.appendChild(logo);
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', o.job_name || o.job_id));
        who.appendChild(joinWithDots(node('div', 'ph-sub'), [model.company, model.rankName]));
        row.appendChild(who);
        row.appendChild(node('span', 'ph-pill ' + (isCurrent ? 'pill-work' : vacancy > 0 ? 'pill-move' : 'pill-idle'),
            isCurrent ? 'Current' : vacancy > 0 ? vacancy + ' open' : 'Full'));
        c.appendChild(row);

        if (org) {
            c.appendChild(node('div', 'ph-job-hours',
                minutesToLabel(hhmmToMinutes(org.startTime)) + ' - ' + minutesToLabel(hhmmToMinutes(org.endTime))));
            c.appendChild(joinWithDots(node('div', 'ph-sub'), [
                dayLabel(org.workDays),
                org.bCanRemoteWork ? 'Remote OK' : 'On site',
                model.salary !== null ? model.salary + ' / day' : ''
            ]));
        }
        if (!model.eligible) {
            c.appendChild(node('div', 'ph-warn', 'Ages ' + model.minStep + ' - ' + model.maxStep + ' only'));
        }
        if (member) {
            var btns = node('div', 'ph-btns');
            btns.appendChild(jobButton(member, model, isCurrent));
            c.appendChild(btns);
        }
        return c;
    }

    function renderJobs(data) {
        lastJobsData = data;
        var wrap = node('div');
        wrap.appendChild(subHeader('jobs'));
        var member = memberById(data.members, jobsMemberId);

        var pick = card('APPLY AS');
        if (!data.members.length) {
            var none = node('div', 'ph-empty', 'Nobody in this household is old enough to work.');
            none.style.marginTop = '8px';
            pick.appendChild(none);
        } else {
            var chips = node('div', 'ph-chips');
            data.members.forEach(function (m) {
                var id = String(m.entity_id);
                var chip = node('div', 'ph-chip' + (id === jobsMemberId ? ' on' : ''));
                chip.appendChild(avatar(m));
                chip.appendChild(node('span', null, fullName(m)));
                onTap(chip, function (e) {
                    e.stopPropagation();
                    if (id === jobsMemberId) return;
                    jobsMemberId = id;
                    jobsConfirmKey = null;
                    setNote('', false);
                    refresh();
                });
                chips.appendChild(chip);
            });
            pick.appendChild(chips);
            if (member) {
                pick.appendChild(node('div', 'ph-current', member.has_career ? (member.job_name || 'Employed') : 'No job yet'));
                if (member.has_career) {
                    pick.appendChild(joinWithDots(node('div', 'ph-sub'), [member.job_rank_name,
                        member.job_rank ? 'Rank ' + member.job_rank : '']));
                }
            }
        }
        wrap.appendChild(pick);

        var models = [];
        data.openings.forEach(function (o, idx) {
            var model = jobModel(o, data.rowById[o.career_dt_id], data.text, member);
            model.index = idx;
            if (!model.hidden) models.push(model);
        });
        models.sort(function (a, b) {
            var d = jobRank(a) - jobRank(b);
            return d !== 0 ? d : a.index - b.index;
        });

        var open = models.filter(function (m) { return (Number(m.opening.vacancy) || 0) > 0; }).length;
        wrap.appendChild(node('div', 'ph-count', models.length + ' jobs in town, ' + open + ' hiring now'));

        if (!models.length) {
            var empty = card();
            empty.appendChild(node('div', 'ph-empty', 'No job listings right now.'));
            wrap.appendChild(empty);
        }
        models.forEach(function (model) {
            wrap.appendChild(jobCard(member, model, data.slot));
        });
        return wrap;
    }

    // ------------------------------------------------------------------
    // Freelance
    // ------------------------------------------------------------------
    // The order list lives only in the game's simulation thread. The HouseholdJournal Lua mod
    // prints it to the Lua log and the reply service writes it here (sms-bridge/lib/freelance.js):
    //   ui/phone/freelance/board.cfg    the played character's board and the latest request
    //                                   results. Reply service only.
    //   ui/phone/freelance/request.cfg  <seq>:<actor>:a:<summary id> (accept) or <seq>:<actor>:c
    //                                   (cancel the active order). Phone only; the Lua mod reads it
    //                                   itself, so accepting and cancelling work without the service.
    // Licenses, statistics and the active order id come straight from the game (FB2CareerComponent).
    var FL_SECTION = 'ui/phone/freelance';
    // The Lua mod prints the board at least every 30 s while the game runs.
    var FL_BOARD_STALE_MS = 90000;
    var FL_TICKS_PER_MIN = 600000000;
    var FL_WAIT_TRIES = 12;
    var FL_DIFFICULTY = { 1: 'Easy', 2: 'Normal', 3: 'Hard', 4: 'Expert' };
    var FL_DIFFICULTY_PILL = { 1: 'pill-work', 2: 'pill-move', 3: 'pill-late', 4: 'pill-late' };
    // EB1FreelanceOrderAcceptFailReason
    var FL_REASONS = {
        1: 'Not available', 2: 'Order is gone', 3: 'Order is gone', 4: 'Conditions not met',
        5: 'Could not start', 6: 'Could not start', 7: 'Could not start', 8: 'Penalty pending',
        9: 'Already on an order', 10: 'License needed', 11: 'License under review', 12: 'Grade too low'
    };
    var FL_STATUS = { 1: 'In progress', 2: 'Completed', 3: 'Failed', 4: 'Cancelled' };
    var FL_LICENSE_STATUS = { Owned: 'Owned', UnderReview: 'Under review', Available: 'Can apply', Locked: 'Locked' };
    var FL_LICENSE_PILL = { Owned: 'pill-work', UnderReview: 'pill-move', Available: 'pill-move', Locked: 'pill-idle' };
    var FL_LICENSE_ORDER = { Owned: 0, UnderReview: 1, Available: 2, Locked: 3 };
    var FL_CATEGORY_COLORS = { Delivery: '#FF9F0A', Creation: '#BF5AF2' };
    var FL_TABS = [
        { id: 'orders', label: 'Orders' },
        { id: 'active', label: 'Active' },
        { id: 'licenses', label: 'Licenses' }
    ];
    var flTab = 'orders';
    // Summary id of the order open in detail, or null for the list.
    var flOpenId = null;
    var flConfirmKey = null;
    var flBusy = false;
    var flTemplates = {};
    var flCategories = {};
    var flLicenseRows = {};
    var flNames = {};
    var lastFreelanceData = null;

    // A data table row, kept for the session once read. null when it cannot be read now.
    function flRow(cache, alias, row) {
        if (!row) return Promise.resolve(null);
        if (cache[row]) return Promise.resolve(cache[row]);
        return soft(call('data.table_get', { Alias: alias, Row: row })).then(function (r) {
            if (!r || r.error || typeof r !== 'object') return null;
            cache[row] = r;
            return r;
        });
    }

    function flRows(cache, alias, ids) {
        return Promise.all(ids.map(function (id) { return flRow(cache, alias, id); })).then(function () {
            var out = {};
            ids.forEach(function (id) { out[id] = cache[id] || null; });
            return out;
        });
    }

    function flName(id) {
        if (!id) return Promise.resolve('');
        if (flNames[id]) return Promise.resolve(flNames[id]);
        return soft(call('entity.get_character_info', { entity_id: String(id) }, 'entity_id')).then(function (r) {
            if (!r || r.error) return '';
            flNames[id] = fullName(r);
            return flNames[id];
        });
    }

    function flItemKey(targetId) { return targetId ? 'Object_' + targetId + '_DisplayNameTextId' : ''; }

    function flLoadBoard() {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: FL_SECTION, key: 'board' }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                return v && typeof v === 'object' ? v : null;
            }, function () { return null; });
    }

    function flLoadCareer(me) {
        return soft(call('entity.reflect', { entity_id: String(me), Component: 'FB2CareerComponent' }, 'licensesMap'))
            .then(function (r) { return r && !r.error ? r : null; });
    }

    function flActiveId(career) {
        var v = career && career.activeFreelanceOrderInstanceId;
        var n = v && typeof v === 'object' ? Number(v.value) : NaN;
        return isFinite(n) ? n : -1;
    }

    function flUnique(list) {
        var out = [];
        list.forEach(function (v) { if (v && out.indexOf(v) < 0) out.push(v); });
        return out;
    }

    function loadFreelance() {
        var env, me, board, career;
        return Promise.all([getEnv(), getPossessedId()]).then(function (r) {
            env = r[0];
            me = r[1];
            return Promise.all([flLoadBoard(), flLoadCareer(me)]);
        }).then(function (r) {
            var raw = r[0];
            career = r[1];
            // The board of another character (just switched) or an old one is not shown.
            var state = !raw ? 'none'
                : raw.me !== me ? 'other'
                : typeof raw.at !== 'number' || Date.now() - raw.at > FL_BOARD_STALE_MS ? 'stale' : 'ok';
            // Without a board, why: the service says whether the HouseholdJournal Lua mod runs,
            // at least every 30 s while it runs itself.
            var source = raw && raw.source && typeof raw.source === 'object' && typeof raw.written === 'number' &&
                Date.now() - raw.written < FL_BOARD_STALE_MS ? raw.source : null;
            var sourceMessage = '';
            if (state !== 'ok') {
                if (!source) state = raw ? 'stale' : 'none';
                else if (/^(starting|down|missing)$/.test(source.state)) {
                    state = 'mod-' + source.state;
                    sourceMessage = typeof source.message === 'string' ? source.message.slice(0, 200) : '';
                }
            }
            board = state === 'ok' ? raw : null;
            var orders = board && Array.isArray(board.orders) ? board.orders : [];
            var active = board && board.active && board.active.instanceId ? board.active : null;
            if (flOpenId && !orders.some(function (o) { return o.summaryId === flOpenId; })) flOpenId = null;
            var licenses = [];
            var map = career && career.licensesMap && typeof career.licensesMap === 'object' ? career.licensesMap : {};
            Object.keys(map).forEach(function (k) { if (map[k] && map[k].licenseId) licenses.push(map[k]); });
            var templateIds = flUnique(orders.map(function (o) { return o.templateId; }).concat(active ? [active.templateId] : []));
            return Promise.all([
                flRows(flTemplates, 'FreelanceOrderTemplate', templateIds),
                flRows(flLicenseRows, 'License', licenses.map(function (l) { return l.licenseId; }))
            ]).then(function (rows) {
                var templates = rows[0];
                var categoryIds = flUnique(templateIds.map(function (id) { return templates[id] && templates[id].categoryId; }));
                return flRows(flCategories, 'FreelanceCategory', categoryIds).then(function (categories) {
                    var open = flOpenId ? orders.filter(function (o) { return o.summaryId === flOpenId; })[0] : null;
                    // Names and item names only for what is shown in full.
                    var full = [open, active].filter(Boolean);
                    var keys = [];
                    templateIds.forEach(function (id) {
                        var t = templates[id];
                        if (t) keys.push(t.orderTitleTextId, t.orderDescriptionTextId);
                    });
                    categoryIds.forEach(function (id) { if (categories[id]) keys.push(categories[id].nameTextId); });
                    licenses.forEach(function (l) {
                        var row = rows[1][l.licenseId];
                        if (row) keys.push(row.licenseNameTextId, row.acquireGuideTextId);
                    });
                    full.forEach(function (o) { keys.push(flItemKey(o.targetId)); });
                    var people = flUnique([].concat.apply([], full.map(function (o) { return [o.clientId, o.recipientId]; })));
                    return Promise.all([
                        localize(keys),
                        Promise.all(people.map(flName))
                    ]).then(function (d) {
                        return {
                            env: env, me: me, state: state, sourceMessage: sourceMessage, board: board, orders: orders, active: active,
                            open: open, career: career, licenses: licenses, licenseRows: rows[1],
                            templates: templates, categories: categories, text: d[0]
                        };
                    });
                });
            });
        });
    }

    function flText(data, key) { return (key && data.text[key]) || ''; }

    function flTemplate(data, o) { return (o && data.templates[o.templateId]) || null; }

    function flTitle(data, o) {
        var t = flTemplate(data, o);
        return (t && flText(data, t.orderTitleTextId)) || (o && o.templateId) || 'Order';
    }

    function flCategoryName(data, o) {
        var t = flTemplate(data, o);
        var c = t && data.categories[t.categoryId];
        return (c && flText(data, c.nameTextId)) || (t && t.categoryId) || '';
    }

    function flLicenseName(data, id) {
        var row = data.licenseRows[id] || flLicenseRows[id];
        return (row && flText(data, row.licenseNameTextId)) || String(id || '').replace(/^License_/, '');
    }

    function flDescription(data, o) {
        var t = flTemplate(data, o);
        var text = t ? flText(data, t.orderDescriptionTextId) : '';
        var item = flText(data, flItemKey(o.targetId)) || o.targetId || '';
        return text
            .replace(/\{Client\}/g, flNames[o.clientId] || 'The client')
            .replace(/\{Recipient\}/g, flNames[o.recipientId] || 'the recipient')
            .replace(/\{Item\}/g, item);
    }

    // "2 h 05 min left" from game ticks; '' when the board has no clock.
    function flTimeLeft(board, ticks) {
        if (!board || typeof board.nowTicks !== 'number' || typeof ticks !== 'number' || ticks <= 0) return '';
        var min = Math.floor((ticks - board.nowTicks) / FL_TICKS_PER_MIN);
        if (min <= 0) return 'Time is up';
        var h = Math.floor(min / 60);
        return (h ? h + ' h ' + pad2(min % 60) : min) + ' min left';
    }

    function flReasonText(data, o) {
        var why = FL_REASONS[o.reason] || 'Not available';
        var t = flTemplate(data, o);
        var cond = t && t.condition;
        if (cond && (o.reason === 10 || o.reason === 11 || o.reason === 12) && cond.requiredLicenseId) {
            why += ': ' + flLicenseName(data, cond.requiredLicenseId) +
                (o.reason === 12 && cond.minimumGrade ? ' (' + cond.minimumGrade + ')' : '');
        }
        return why;
    }

    function flLogo(data, o) {
        var t = flTemplate(data, o);
        var name = flCategoryName(data, o);
        var logo = node('div', 'ph-avatar', (name || '?').charAt(0));
        logo.style.background = (t && FL_CATEGORY_COLORS[t.categoryId]) || accentFor(o.summaryId);
        return logo;
    }

    function rerenderFreelance() {
        if (!lastFreelanceData || current !== 'freelance') return;
        var scrollTop = wf.content.scrollTop;
        show(renderFreelance(lastFreelanceData));
        wf.content.scrollTop = scrollTop;
    }

    // Writes the request and waits for the outcome: the result line the reply service copies
    // into board.cfg, or the game's active order id changing, whichever shows first.
    function flAwait(seq, op, me, tries) {
        return Promise.all([flLoadBoard(), flLoadCareer(me)]).then(function (r) {
            var results = r[0] && Array.isArray(r[0].results) ? r[0].results : [];
            for (var i = 0; i < results.length; i++) {
                if (results[i] && results[i].seq === seq) return results[i];
            }
            var activeId = flActiveId(r[1]);
            if (op === 'a' && activeId >= 0) return { ok: true };
            if (op === 'c' && activeId < 0) return { ok: true };
            if (tries <= 1) return null;
            return wait(1000).then(function () { return flAwait(seq, op, me, tries - 1); });
        });
    }

    function flFailText(detail) {
        var m = /^reason_(\d+)$/.exec(detail || '');
        if (m) return FL_REASONS[Number(m[1])] || 'Not available';
        if (detail === 'no_active_order') return 'There is no order in progress';
        if (detail === 'stale_after_reload') return 'The game was loaded again; try once more';
        return detail ? detail.replace(/_/g, ' ') : 'The game refused';
    }

    function flSend(op, me, summaryId, label, done) {
        if (flBusy) return;
        flBusy = true;
        flConfirmKey = null;
        noteFromLoad = false;
        var seq = String(Date.now());
        setNote(label + '...', false);
        rerenderFreelance();
        call('uimod.cfg_save', {
            mod_id: SMS_MOD,
            section: FL_SECTION,
            key: 'request',
            value: seq + ':' + me + ':' + op + (summaryId ? ':' + summaryId : '')
        })
            .then(function () { return flAwait(seq, op, me, FL_WAIT_TRIES); })
            .then(function (res) {
                if (!res) throw new Error('No answer from the game. Is the HouseholdJournal mod installed and on?');
                if (!res.ok) throw new Error(label + ' failed: ' + flFailText(res.detail));
                done();
            })
            .catch(function (err) { setNote(errText(err), true); })
            .then(function () {
                flBusy = false;
                refresh();
            });
    }

    function flAccept(data, o) {
        flSend('a', data.me, o.summaryId, 'Accepting', function () {
            flOpenId = null;
            flTab = 'active';
            setNote('Order accepted: ' + flTitle(data, o), false);
        });
    }

    function flCancel(data) {
        flSend('c', data.me, '', 'Cancelling', function () {
            setNote('Order cancelled', false);
        });
    }

    function flAcceptButton(data, o) {
        var key = 'a|' + o.summaryId;
        if (flBusy) return actionButton('Please wait', 'last off', function () {});
        if (data.active || flActiveId(data.career) >= 0) return actionButton('Finish your current order first', 'last off', function () {});
        if (o.reason !== 0) return actionButton(flReasonText(data, o), 'last off', function () {});
        if (flConfirmKey === key) {
            return actionButton('Confirm', 'last warn', function () { flAccept(data, o); });
        }
        return actionButton('Accept order', 'last on', function () {
            flConfirmKey = key;
            setNote('Tap again to take this order.', false);
            noteFromLoad = false;
            rerenderFreelance();
        });
    }

    function flTabs() {
        var row = node('div', 'ph-btns');
        FL_TABS.forEach(function (tab, i) {
            var cls = (i === FL_TABS.length - 1 ? 'last' : '') + (tab.id === flTab ? ' on' : '');
            row.appendChild(actionButton(tab.label, cls, function () {
                if (tab.id === flTab) return;
                flTab = tab.id;
                flConfirmKey = null;
                rerenderFreelance();
            }));
        });
        return row;
    }

    var FL_MOD_TITLES = {
        'mod-starting': 'Starting the order service',
        'mod-down': 'The order service is not running',
        'mod-missing': 'The order service is missing'
    };

    function flBoardMissing(data) {
        var c = card();
        if (FL_MOD_TITLES[data.state]) {
            c.appendChild(node('div', 'ph-name', FL_MOD_TITLES[data.state]));
            c.appendChild(node('div', 'fl-desc', data.sourceMessage || 'Freelance orders come from the HouseholdJournal mod.'));
            return c;
        }
        c.appendChild(node('div', 'ph-empty', data.state === 'stale'
            ? 'The order list has not been updated for a while. Is the AI phone service running?'
            : data.state === 'other'
                ? 'Loading the order list for this character...'
                : 'The order list comes from the AI phone service. Turn it on in the AI app to see orders.'));
        return c;
    }

    function flOrderCard(data, o) {
        var c = node('div', 'ph-card ph-job fl-order');
        var row = node('div', 'ph-row');
        row.appendChild(flLogo(data, o));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', flTitle(data, o)));
        who.appendChild(joinWithDots(node('div', 'ph-sub'), [flCategoryName(data, o), FL_DIFFICULTY[o.difficulty] || '']));
        row.appendChild(who);
        row.appendChild(node('span', 'ph-pill ' + (o.reason === 0 ? 'pill-work' : 'pill-idle'), o.reason === 0 ? 'Open' : 'Locked'));
        c.appendChild(row);
        var meta = node('div', 'fl-meta');
        meta.appendChild(node('span', 'fl-pay', typeof o.reward === 'number' ? o.reward + ' pay' : ''));
        if (o.reason !== 0) meta.appendChild(node('span', 'fl-why', flReasonText(data, o)));
        c.appendChild(meta);
        onTap(c, function (e) {
            e.stopPropagation();
            flOpenId = o.summaryId;
            flConfirmKey = null;
            setNote('', false);
            refresh();
        });
        return c;
    }

    function flFact(label, value) {
        if (!value) return null;
        var f = node('div', 'fl-fact');
        f.appendChild(node('span', 'fl-fact-label', label));
        f.appendChild(node('span', 'fl-fact-value', value));
        return f;
    }

    function flAppend(parent, children) {
        children.forEach(function (c) { if (c) parent.appendChild(c); });
    }

    function flHours(cond) {
        if (!cond || typeof cond.startHour !== 'number' || typeof cond.endHour !== 'number') return '';
        if (cond.startHour === cond.endHour) return '';
        return pad2(cond.startHour) + ':00 - ' + pad2(cond.endHour) + ':00';
    }

    function renderFlDetail(data, o) {
        var wrap = node('div');
        var head = node('div', 'ph-head');
        var back = node('div', 'ph-back', '< Orders');
        onTap(back, function (e) {
            e.stopPropagation();
            flOpenId = null;
            flConfirmKey = null;
            setNote('', false);
            rerenderFreelance();
        });
        head.appendChild(back);
        head.appendChild(node('div', 'ph-title', 'Order'));
        wrap.appendChild(head);

        var t = flTemplate(data, o);
        var cond = t && t.condition;
        var c = node('div', 'ph-card ph-job');
        var row = node('div', 'ph-row');
        row.appendChild(flLogo(data, o));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', flTitle(data, o)));
        who.appendChild(joinWithDots(node('div', 'ph-sub'), [flCategoryName(data, o)]));
        row.appendChild(who);
        if (FL_DIFFICULTY[o.difficulty]) {
            row.appendChild(node('span', 'ph-pill ' + (FL_DIFFICULTY_PILL[o.difficulty] || 'pill-idle'), FL_DIFFICULTY[o.difficulty]));
        }
        c.appendChild(row);
        var desc = flDescription(data, o);
        if (desc) c.appendChild(node('div', 'fl-desc', desc));
        c.appendChild(node('div', 'ph-job-hours', typeof o.reward === 'number' ? o.reward + ' pay' : ''));
        var item = flText(data, flItemKey(o.targetId)) || o.targetId;
        var delivery = t && t.categoryId === 'Delivery';
        flAppend(c, [
            flFact('Client', flNames[o.clientId]),
            delivery && o.recipientId && o.recipientId !== o.clientId ? flFact('Deliver to', flNames[o.recipientId]) : null,
            flFact(delivery ? 'Item' : 'Make', item),
            cond && cond.requiredLicenseId ? flFact('License', flLicenseName(data, cond.requiredLicenseId) +
                (cond.minimumGrade && cond.minimumGrade !== 'Beginner' ? ', ' + cond.minimumGrade + ' or above' : '')) : null,
            flFact('Hours', flHours(cond))
        ]);
        if (o.reason !== 0) c.appendChild(node('div', 'ph-warn', flReasonText(data, o)));
        var btns = node('div', 'ph-btns');
        btns.appendChild(flAcceptButton(data, o));
        c.appendChild(btns);
        wrap.appendChild(c);
        return wrap;
    }

    function renderFlOrders(data, wrap) {
        if (data.state !== 'ok') {
            wrap.appendChild(flBoardMissing(data));
            return;
        }
        var orders = data.orders.slice();
        orders.sort(function (a, b) {
            var d = (a.reason === 0 ? 0 : 1) - (b.reason === 0 ? 0 : 1);
            return d !== 0 ? d : (Number(b.reward) || 0) - (Number(a.reward) || 0);
        });
        var open = orders.filter(function (o) { return o.reason === 0; }).length;
        wrap.appendChild(node('div', 'ph-count', orders.length + ' orders, ' + open + ' you can take now'));
        if (!orders.length) {
            var empty = card();
            empty.appendChild(node('div', 'ph-empty', 'No orders right now. New ones come in every day.'));
            wrap.appendChild(empty);
        }
        orders.forEach(function (o) { wrap.appendChild(flOrderCard(data, o)); });
    }

    function renderFlActive(data, wrap) {
        var a = data.active;
        var activeId = flActiveId(data.career);
        if (!a && activeId < 0) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'No order in progress. Pick one from Orders.'));
            wrap.appendChild(none);
        } else {
            var c = card('CURRENT ORDER');
            if (a) {
                var row = node('div', 'ph-row');
                row.style.marginTop = '10px';
                row.appendChild(flLogo(data, a));
                var who = node('div', 'ph-who');
                who.appendChild(node('div', 'ph-name', flTitle(data, a)));
                who.appendChild(joinWithDots(node('div', 'ph-sub'), [flCategoryName(data, a), FL_STATUS[a.status] || '']));
                row.appendChild(who);
                c.appendChild(row);
                var left = flTimeLeft(data.board, a.expireTicks);
                if (left) c.appendChild(node('div', 'ph-job-hours', left));
                var desc = flDescription(data, a);
                if (desc) c.appendChild(node('div', 'fl-desc', desc));
                var t = flTemplate(data, a);
                var delivery = t && t.categoryId === 'Delivery';
                flAppend(c, [
                    flFact('Client', flNames[a.clientId]),
                    delivery && a.recipientId && a.recipientId !== a.clientId ? flFact('Deliver to', flNames[a.recipientId]) : null,
                    flFact(delivery ? 'Item' : 'Make', flText(data, flItemKey(a.targetId)) || a.targetId)
                ]);
                if (a.crafting || (a.craftPercent || 0) > 0) {
                    c.appendChild(flFact('Work done', (a.craftPercent || 0) + '%'));
                    c.appendChild(bar(a.craftPercent || 0, '#BF5AF2'));
                }
            } else {
                c.appendChild(node('div', 'ph-current', 'On an order'));
                c.appendChild(node('div', 'ph-sub', 'The details come from the AI phone service.'));
            }
            var btns = node('div', 'ph-btns');
            if (flBusy) {
                btns.appendChild(actionButton('Please wait', 'last off', function () {}));
            } else if (flConfirmKey === 'c') {
                btns.appendChild(actionButton('Keep it', '', function () {
                    flConfirmKey = null;
                    setNote('', false);
                    rerenderFreelance();
                }));
                btns.appendChild(actionButton('Cancel order', 'last warn', function () { flCancel(data); }));
            } else {
                btns.appendChild(actionButton('Cancel order', 'last', function () {
                    flConfirmKey = 'c';
                    setNote('Cancelling costs trust, and a delivery may also bring a penalty.', false);
                    noteFromLoad = false;
                    rerenderFreelance();
                }));
            }
            c.appendChild(btns);
            wrap.appendChild(c);
        }
        var b = data.board;
        if (b && b.penalty) {
            var p = card('PENALTY');
            p.appendChild(node('div', 'ph-warn', 'A failed delivery is still being settled.'));
            var pf = b.penaltyFlow;
            if (pf) {
                flAppend(p, [
                    flFact('Order', pf.templateId && flTemplates[pf.templateId] ? flText(data, flTemplates[pf.templateId].orderTitleTextId) : pf.templateId),
                    flFact('Next step', flTimeLeft(b, pf.nextTicks).replace(' left', ''))
                ]);
            }
            wrap.appendChild(p);
        }
    }

    function flCondition(cond) {
        if (!cond) return '';
        if (cond.method === 'Skill') return (cond.s1 || 'Skill') + ' skill level ' + (cond.f1 || 0);
        if (cond.method === 'GrowthStep') return 'Age ' + (cond.s1 || '') + ' or older';
        return [cond.method, cond.s1, cond.f1 ? String(cond.f1) : ''].filter(Boolean).join(' ');
    }

    function renderFlLicenses(data, wrap) {
        var st = data.career && data.career.statistics;
        if (st) {
            var s = card('MY RECORD');
            var grid = node('div', 'ph-needs');
            [
                ['Completed', st.totalCompletedOrders],
                ['Failed', st.totalFailedOrders],
                ['Earned', st.totalEarnings],
                ['Tips', st.totalTips],
                ['Rating', typeof st.averageRating === 'number' ? (st.averageRating * 5).toFixed(1) + ' / 5' : '']
            ].forEach(function (pair) {
                var cell = node('div', 'ph-need');
                var top = node('div', 'ph-need-top');
                top.appendChild(node('span', null, pair[0]));
                top.appendChild(node('span', 'ph-need-val', pair[1] === undefined || pair[1] === null ? '-' : String(pair[1])));
                cell.appendChild(top);
                grid.appendChild(cell);
            });
            s.appendChild(grid);
            wrap.appendChild(s);
        }
        if (!data.career) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'Licenses unavailable'));
            wrap.appendChild(none);
            return;
        }
        var list = data.licenses.slice().sort(function (a, b) {
            var d = (FL_LICENSE_ORDER[a.status] || 9) - (FL_LICENSE_ORDER[b.status] || 9);
            return d !== 0 ? d : String(a.licenseId).localeCompare(String(b.licenseId));
        });
        list.forEach(function (l) {
            var row = data.licenseRows[l.licenseId];
            var c = node('div', 'ph-card ph-job');
            var head = node('div', 'ph-row');
            var who = node('div', 'ph-who');
            who.appendChild(node('div', 'ph-name', flLicenseName(data, l.licenseId)));
            if (l.status === 'Owned') {
                who.appendChild(joinWithDots(node('div', 'ph-sub'), [l.currentGrade, (l.completedOrderCount || 0) + ' done']));
            }
            head.appendChild(who);
            head.appendChild(node('span', 'ph-pill ' + (FL_LICENSE_PILL[l.status] || 'pill-idle'), FL_LICENSE_STATUS[l.status] || l.status));
            c.appendChild(head);
            if (l.status === 'Owned') {
                c.appendChild(flFact('Trust', (l.trustScore || 0) + ' / 100'));
                c.appendChild(bar(l.trustScore || 0, '#30D158'));
            } else if (l.status === 'UnderReview') {
                var left = flTimeLeft(data.board, l.reviewExpireTimeTicks);
                c.appendChild(node('div', 'ph-sub', left ? 'Review: ' + left : 'The application is being reviewed.'));
            } else {
                var conds = row && Array.isArray(row.acquireConditions) ? row.acquireConditions : [];
                var met = Array.isArray(l.acquireConditionSatisfiedList) ? l.acquireConditionSatisfiedList : [];
                conds.forEach(function (cond, i) {
                    var ok = met[i] === true;
                    c.appendChild(node('div', 'fl-cond ' + (ok ? 'fl-ok' : 'fl-no'), (ok ? '✓ ' : '✗ ') + flCondition(cond)));
                });
                var guide = row ? flText(data, row.acquireGuideTextId) : '';
                if (guide) c.appendChild(node('div', 'fl-desc', guide));
            }
            wrap.appendChild(c);
        });
    }

    function renderFreelance(data) {
        lastFreelanceData = data;
        // The detail follows flOpenId, not the loaded data, so Back shows the list at once.
        if (flOpenId && data.open && data.open.summaryId === flOpenId) return renderFlDetail(data, data.open);
        var wrap = node('div');
        wrap.appendChild(subHeader('freelance'));
        wrap.appendChild(flTabs());
        if (flTab === 'active') renderFlActive(data, wrap);
        else if (flTab === 'licenses') renderFlLicenses(data, wrap);
        else renderFlOrders(data, wrap);
        return wrap;
    }

    // ------------------------------------------------------------------
    // Texts. outbox.cfg is written only here. inbox.cfg holds the contact's replies.
    // ------------------------------------------------------------------
    function parseJson(raw) {
        if (typeof raw !== 'string') return raw;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    function smsImageClean(raw) {
        if (!raw || typeof raw.id !== 'string' || !/^[a-f0-9]{16}$/.test(raw.id)) return null;
        var w = Number(raw.width);
        var h = Number(raw.height);
        if (Math.floor(w) !== w || Math.floor(h) !== h || w <= 0 || h <= 0 || w > 100000 || h > 100000) return null;
        return { id: raw.id, width: w, height: h };
    }

    function cleanList(raw) {
        var data = parseJson(raw);
        if (!Array.isArray(data)) return [];
        var out = [];
        for (var i = 0; i < data.length; i++) {
            var m = data[i];
            if (!m || typeof m.text !== 'string' || typeof m.at !== 'number') continue;
            var image = smsImageClean(m.image);
            if (!m.text && !image) continue;
            var msg = { id: String(m.id || ('m-' + m.at + '-' + i)), text: m.text || SMS_PHOTO_TEXT, at: m.at, game: smsGameClean(m.game) };
            if (image) msg.image = image;
            out.push(msg);
        }
        return out;
    }

    // cohtml does not clip a list row: white-space/text-overflow are ignored and a long message
    // wraps to four lines. Cut the text to about one line instead, counting a CJK character as
    // two, so the row keeps its height whatever the engine does.
    function smsClip(text, budget) {
        var s = String(text === undefined || text === null ? '' : text);
        var n = 0;
        for (var i = 0; i < s.length; i++) {
            n += s.charCodeAt(i) > 0x2e80 ? 2 : 1;
            if (n > (budget || 40)) return s.slice(0, i) + '\u2026';
        }
        return s;
    }

    // Which build this page is running. Written once per boot into the mod's cfg directory, so
    // from outside the game it is possible to tell whether a reload really picked up new code.
    var SMS_BUILD = '2026-10-28.2.89-groups';

    function smsSection(playerId, contactId) { return SMS_SECTION + '/' + playerId + '-' + contactId; }

    function loadBox(key, section) {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: section, key: key }, 'value')
            .then(function (r) { return cleanList(r.value); }, function () { return []; });
    }

    function loadSeen(section) {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: section, key: 'seen' }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                return v && typeof v.at === 'number' ? v.at : 0;
            }, function () { return 0; });
    }

    function loadStatus(section) {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: section, key: 'status' }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                return v && typeof v === 'object' ? v : null;
            }, function () { return null; });
    }

    function saveJson(key, value, section) {
        return call('uimod.cfg_save', {
            mod_id: SMS_MOD,
            section: section,
            key: key,
            value: JSON.stringify(value)
        });
    }

    // The reply service empties every conversation and its memory. The phone only writes the
    // request, then waits until cleared.cfg names that same request.
    function watchClear() {
        if (!smsClearingAt) return Promise.resolve();
        if (Date.now() - smsClearingAt > 120000) {
            smsClearingAt = 0;
            smsClearAsk = false;
            setNote('Could not clear texts. Is the reply service running?', true);
            return Promise.resolve();
        }
        return cfgValue(SMS_SECTION, 'cleared').then(function (v) {
            if (v && typeof v.at === 'number' && v.at >= smsClearingAt) {
                smsClearingAt = 0;
                smsClearAsk = false;
                smsRenderedKey = '';
                smsDraft = '';
                smsPhotos = {};
                smsPhotoPending = null;
                syncSmsPhotoComposer();
                setNote('Texts cleared.', false);
                bannerAt = {};
                bannerReady = {};
                clearBannerQueue();
            }
        }, function () {});
    }

    function requestClear() {
        if (smsClearingAt) return;
        smsClearAsk = false;
        smsClearingAt = Date.now();
        smsRenderedKey = '';
        setNote('Clearing...', false);
        saveJson('clear', { at: smsClearingAt }, SMS_SECTION).then(function () {
            refresh();
        }, function (err) {
            smsClearingAt = 0;
            setNote(errText(err), true);
            refresh();
        });
    }

    function clearTools() {
        var row = node('div', 'sms-tools');
        if (smsClearingAt) {
            row.appendChild(node('div', 'sms-tool-note', 'Clearing all texts...'));
            return row;
        }
        if (smsClearAsk) {
            row.appendChild(node('div', 'sms-tool-note', 'Clear all texts and group chats?'));
            var yes = node('button', 'sms-tool warn', 'Clear');
            yes.type = 'button';
            onTap(yes, function (e) {
                e.stopPropagation();
                requestClear();
            });
            var no = node('button', 'sms-tool', 'Cancel');
            no.type = 'button';
            onTap(no, function (e) {
                e.stopPropagation();
                smsClearAsk = false;
                setNote('', false);
                refresh();
            });
            row.appendChild(yes);
            row.appendChild(no);
            return row;
        }
        var btn = node('button', 'sms-tool', 'Clear');
        btn.type = 'button';
        onTap(btn, function (e) {
            e.stopPropagation();
            smsClearAsk = true;
            refresh();
        });
        row.appendChild(btn);
        return row;
    }

    function isSpouseOf(self, m) {
        if (!self || !m) return false;
        return String(self.spouse_id) === String(m.entity_id) || String(m.spouse_id) === String(self.entity_id);
    }

    // Household members the played character can text: spouse first, then oldest to youngest.
    function textContacts(meId, members) {
        var self = memberById(members, meId);
        var list = members.filter(function (m) {
            return String(m.entity_id) !== String(meId) && !NO_PHONE_STEPS[m.age_group];
        });
        list.sort(function (a, b) {
            var sa = isSpouseOf(self, a) ? 1 : 0;
            var sb = isSpouseOf(self, b) ? 1 : 0;
            if (sa !== sb) return sb - sa;
            return (GROWTH_ORDER[b.age_group] || 0) - (GROWTH_ORDER[a.age_group] || 0);
        });
        // Then the people outside the household this character has texted, newest first.
        var mine = smsOutside[String(meId)];
        if (mine && Array.isArray(mine.people)) {
            mine.people.forEach(function (p) {
                if (p && p.entity_id && !memberById(list, p.entity_id) && String(p.entity_id) !== String(meId)) list.push(p);
            });
        }
        return list;
    }

    // People outside the household the played character has texted (from Contacts), per
    // character, in saved/texts-outside.cfg: { v, byPlayer: { id: { people: [contact] } } }.
    // The reply service answers them like family, without moving them in the game.
    var SMS_OUTSIDE_KEY = 'texts-outside';
    var SMS_OUTSIDE_MAX = 30;
    var smsOutside = {};

    function loadOutside() {
        return cachedRead('outside', 4000, function () {
            return cfgValue(SOUND_SECTION, SMS_OUTSIDE_KEY).then(function (v) {
                smsOutside = v && v.v === 1 && v.byPlayer && typeof v.byPlayer === 'object' ? v.byPlayer : {};
            }, function () {});
        });
    }

    // Everyone a group can hold: the household, then the people outside it that any character on
    // this phone has texted (New Group offers those too), so their names and faces resolve.
    function grpPeople(members) {
        var list = (members || []).slice();
        Object.keys(smsOutside).forEach(function (pid) {
            var mine = smsOutside[pid];
            (mine && Array.isArray(mine.people) ? mine.people : []).forEach(function (p) {
                if (p && p.entity_id && !memberById(list, p.entity_id)) list.push(p);
            });
        });
        return list;
    }

    function addOutside(meId, c, label) {
        var key = String(meId);
        var mine = smsOutside[key] || (smsOutside[key] = { people: [] });
        var person = {
            entity_id: c.entity_id, first_name: c.first_name || '', last_name: c.last_name || '', gender: c.gender || '',
            age_group: c.age_group || '', age_group_text: c.age_group_text || '', job_name: c.job_name || '',
            relationship_label: label || '', outside: true
        };
        mine.people = [person].concat(mine.people.filter(function (p) { return String(p.entity_id) !== String(c.entity_id); })).slice(0, SMS_OUTSIDE_MAX);
        return saveJson(SMS_OUTSIDE_KEY, { v: 1, byPlayer: smsOutside }, SOUND_SECTION).then(null, function () {});
    }

    function prefixIds(list, prefix) {
        var out = [];
        for (var i = 0; i < list.length; i++) out.push({ id: prefix + list[i].id, text: list[i].text, image: list[i].image || null, at: list[i].at, game: list[i].game });
        return out;
    }

    // The conversation between meId and contactId as seen by meId:
    //   mine   = me-contact/outbox (typed as me)      + contact-me/inbox (replies written for me)
    //   theirs = me-contact/inbox  (contact's replies) + contact-me/outbox (typed as the contact)
    function loadConversation(meId, contactId) {
        var section = smsSection(meId, contactId);
        var reverse = smsSection(contactId, meId);
        return Promise.all([
            loadBox('outbox', section),
            loadBox('inbox', section),
            loadBox('outbox', reverse),
            loadBox('inbox', reverse),
            loadSeen(section),
            loadStatus(section)
        ]).then(function (d) {
            var mine = d[0].concat(prefixIds(d[3], 'r-'));
            var theirs = d[1].concat(prefixIds(d[2], 'r-'));
            return {
                section: section,
                mine: mine,
                theirs: theirs,
                messages: mergeThread(mine, theirs),
                seenAt: d[4],
                status: d[5]
            };
        });
    }

    function totalUnread(meId, members) {
        var contacts = textContacts(meId, members);
        return Promise.all(contacts.map(function (m) {
            var section = smsSection(meId, m.entity_id);
            var reverse = smsSection(m.entity_id, meId);
            return Promise.all([loadBox('inbox', section), loadBox('outbox', reverse), loadSeen(section)]).then(function (d) {
                return unreadCount(d[0].concat(d[1]), d[2]);
            });
        })).then(function (counts) {
            var n = 0;
            for (var i = 0; i < counts.length; i++) n += counts[i];
            return n;
        }, function () { return 0; });
    }

    // Presence of the reply service, from status.cfg and its heartbeat age.
    function presence(status) {
        if (!status || typeof status.heartbeat !== 'number' || Date.now() - status.heartbeat > BRIDGE_STALE_MS) {
            return { cls: 'off', text: 'Offline', fresh: false, typing: false };
        }
        var s = status.state;
        if (s === 'typing') return { cls: 'typing', text: 'Typing...', fresh: true, typing: true };
        if (s === 'reading') return { cls: 'on', text: 'Reading...', fresh: true, typing: false };
        if (s === 'waiting') return { cls: 'off', text: 'Connecting...', fresh: true, typing: false };
        if (s === 'paused') return { cls: 'off', text: 'Auto replies off', fresh: true, typing: false };
        if (s === 'offline') return { cls: 'off', text: 'Offline', fresh: false, typing: false };
        if (s === 'error') return { cls: 'err', text: status.error || 'Reply service error', fresh: true, typing: false };
        return { cls: 'on', text: 'Online', fresh: true, typing: false };
    }

    function receiptText(data) {
        var list = data.messages;
        if (!list.length) return '';
        var last = list[list.length - 1];
        if (last.side !== 'mine') return '';
        var st = data.status;
        var p = presence(st);
        if (st && typeof st.readAt === 'number' && st.readAt >= last.at && p.fresh) return 'Read';
        return p.fresh ? 'Delivered' : 'Sent';
    }

    // hold: a full redraw follows and will glide the log itself, so the typing row only
    // takes its entrance here and does not start a second glide.
    function applySmsStatus(data, hold) {
        var p = presence(data.status);
        var pres = document.getElementById('sms-presence');
        if (pres) {
            pres.textContent = p.text;
            pres.className = 'sms-presence ' + p.cls;
        }
        var receipt = document.getElementById('sms-receipt');
        if (receipt) receipt.textContent = receiptText(data);
        var typing = document.getElementById('sms-typing');
        if (p.typing !== smsTypingShown) {
            var turnedOn = p.typing && !smsTypingShown;
            smsTypingShown = p.typing;
            if (typing) {
                typing.className = 'sms-row theirs sms-typing' + (turnedOn ? ' sms-in' : '');
                typing.style.display = p.typing ? 'flex' : 'none';
            }
            if (turnedOn && smsStick && !hold) {
                var log = document.getElementById('sms-log');
                if (log) rideSmsLog(log);
            } else if (!p.typing && smsStick) {
                stickToBottom();
            }
        } else if (typing) {
            typing.style.display = p.typing ? 'flex' : 'none';
        }
    }

    function unreadCount(inbox, seenAt) {
        var n = 0;
        var at = seenAt || 0;
        for (var i = 0; i < inbox.length; i++) {
            if (inbox[i].at > at) n += 1;
        }
        return n;
    }

    function mergeThread(outbox, inbox) {
        var list = [];
        var i;
        for (i = 0; i < outbox.length; i++) list.push({ side: 'mine', id: outbox[i].id, text: outbox[i].text, image: outbox[i].image || null, at: outbox[i].at, game: outbox[i].game });
        for (i = 0; i < inbox.length; i++) list.push({ side: 'theirs', id: inbox[i].id, text: inbox[i].text, image: inbox[i].image || null, at: inbox[i].at, game: inbox[i].game });
        list.sort(function (a, b) {
            if (a.at !== b.at) return a.at - b.at;
            if (a.side !== b.side) return a.side === 'mine' ? -1 : 1;
            return a.id < b.id ? -1 : 1;
        });
        return list;
    }

    function threadKey(messages) {
        var s = '';
        for (var i = 0; i < messages.length; i++) s += messages[i].id + '\n';
        return s;
    }

    // The game UI does not resolve the font of form controls like other elements; copying the
    // font actually used by the page keeps CJK input from rendering as boxes.
    var uiFontFamily = null;
    function applyUiFont(el) {
        if (uiFontFamily === null) {
            uiFontFamily = '';
            try {
                var cs = window.getComputedStyle ? window.getComputedStyle(document.body) : null;
                if (cs && cs.fontFamily) uiFontFamily = cs.fontFamily;
            } catch (e) {
                uiFontFamily = '';
            }
        }
        if (uiFontFamily) el.style.fontFamily = uiFontFamily;
    }

    // Real time, for Moments posts.
    function smsClock(ms) {
        var d = new Date(ms);
        if (isNaN(d.getTime())) return '';
        var now = new Date();
        var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
        return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm;
    }

    function loadEmojiSet() {
        if (emojiSet) return Promise.resolve(emojiSet);
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: EMOJI_SECTION, key: 'set' }, 'value').then(function (r) {
            var v = parseJson(r.value);
            var list = v && Array.isArray(v.emoji) ? v.emoji.filter(function (e) {
                return e && /^[a-z0-9]+$/.test(e.id || '') && typeof e.name === 'string' && e.name;
            }) : [];
            if (!list.length) return null;
            var byName = {};
            list.forEach(function (e) { byName[e.name] = e.id; });
            emojiSet = { list: list, byName: byName };
            return emojiSet;
        }, function () { return null; });
    }

    function emojiImg(id, name) {
        var img = node('img', 'sms-emoji');
        img.src = 'emoji/' + id + '.png';
        img.alt = '[' + name + ']';
        return img;
    }

    // Text with its [name] tokens drawn as emoji. Returns how many emoji and how much other text.
    // Each piece of text goes in its own span: the game's UI puts a bare text node next to an
    // image on a line of its own, while spans and images flow on one line.
    function emojiText(parent, piece) {
        parent.appendChild(node('span', 'sms-run', piece));
    }

    function emojiFill(parent, text) {
        var count = 0;
        var other = 0;
        var re = /\[([^\[\]\s]{1,6})\]/g;
        var last = 0;
        var m;
        while ((m = re.exec(text))) {
            var id = emojiSet && emojiSet.byName[m[1]];
            if (!id) continue;
            if (m.index > last) {
                emojiText(parent, text.slice(last, m.index));
                if (/\S/.test(text.slice(last, m.index))) other += 1;
            }
            parent.appendChild(emojiImg(id, m[1]));
            count += 1;
            last = re.lastIndex;
        }
        if (last < text.length) {
            emojiText(parent, text.slice(last));
            if (/\S/.test(text.slice(last))) other += 1;
        }
        return { emoji: count, other: other };
    }

    // A bubble of only a few emoji is drawn large and without the bubble, like other phones do.
    function smsBubble(text) {
        var bubble = node('div', 'sms-bubble');
        var r = emojiFill(bubble, text);
        if (r.emoji > 0 && r.emoji <= EMOJI_BIG_MAX && !r.other) bubble.className = 'sms-bubble big';
        return bubble;
    }

    // A photo keeps its aspect ratio and shares the bubble with an optional caption. The
    // placeholder gives the text-only reply service context, but is not shown as a caption.
    function smsMessageBubble(m) {
        if (!m.image) return smsBubble(m.text);
        var caption = m.text === SMS_PHOTO_TEXT ? '' : m.text;
        var bubble = node('div', 'sms-bubble sms-photo-message' + (caption ? ' has-caption' : ''));
        var frame = node('div', 'sms-photo-frame');
        var w = m.image.width;
        var h = m.image.height;
        var scale = Math.min(2, 218 / w, 250 / h);
        var outW = Math.max(1, Math.round(w * scale));
        var outH = Math.max(1, Math.round(h * scale));
        frame.style.width = outW + 'px';
        frame.style.height = outH + 'px';
        var img = node('img', 'sms-photo-image');
        img.src = 'media/' + m.image.id + '.jpg';
        img.setAttribute('alt', caption || 'Photo');
        img.addEventListener('load', function () {
            if (smsStick) stickToBottom();
        });
        img.addEventListener('error', function () {
            img.style.display = 'none';
            frame.appendChild(node('span', 'sms-photo-missing', 'Photo unavailable'));
        });
        frame.appendChild(img);
        bubble.appendChild(frame);
        if (caption) {
            var text = node('div', 'sms-photo-caption');
            emojiFill(text, caption);
            bubble.appendChild(text);
        }
        return bubble;
    }

    function smsInsertEmoji(name) {
        if (smsComposing) return;
        var box = document.getElementById('sms-box');
        var value = box ? box.value : smsDraft;
        var token = '[' + name + ']';
        if (value.length + token.length > SMS_TEXT_MAX) return;
        var at = smsCaret !== null && smsCaret <= value.length ? smsCaret : value.length;
        value = value.slice(0, at) + token + value.slice(at);
        smsCaret = at + token.length;
        smsDraft = value;
        if (box) {
            box.value = value;
            fitSmsBox(box);
        }
        syncSendButton();
    }

    function emojiPanel() {
        var panel = node('div', 'sms-emoji-panel' + (smsEmojiOpen ? '' : ' closed'));
        panel.id = 'sms-emoji-panel';
        (emojiSet ? emojiSet.list : []).forEach(function (e, i) {
            var cell = node('div', 'sms-emoji-pick');
            // The first rows pop in as a wave from the top left.
            if (i < 40) setSmsDelay(cell, 60 + Math.floor(i / 8) * 40 + (i % 8) * 16);
            cell.setAttribute('title', e.name);
            cell.appendChild(emojiImg(e.id, e.name));
            onTap(cell, function (ev) {
                ev.stopPropagation();
                smsInsertEmoji(e.name);
            }, { silent: true });
            panel.appendChild(cell);
        });
        return panel;
    }

    // Opening and closing are CSS animations of transform and opacity only, so the game's UI
    // engine never re-lays out the chat mid-animation. Closed, the panel keeps its emoji loaded
    // at zero height rather than display: none, so the first open does not wait for images.
    var emojiFoldTimer = null;

    function restartAnim(elm, cls) {
        elm.className = elm.className.replace(new RegExp('\\s*\\b' + cls + '\\b', 'g'), '');
        void elm.offsetWidth;
        elm.className += ' ' + cls;
    }

    function animateEmojiPanel(panel, opening) {
        if (emojiFoldTimer) { clearTimeout(emojiFoldTimer); emojiFoldTimer = null; }
        if (opening) {
            panel.className = 'sms-emoji-panel';
            restartAnim(panel, 'pop');
            stickToBottom();
            setTimeout(stickToBottom, 60);
        } else {
            panel.className = 'sms-emoji-panel';
            restartAnim(panel, 'fold');
            emojiFoldTimer = setTimeout(function () {
                emojiFoldTimer = null;
                if (!smsEmojiOpen) panel.className = 'sms-emoji-panel closed';
                stickToBottom();
            }, 170);
        }
    }

    function smsGameClean(g) {
        return g && typeof g.day === 'number' && typeof g.min === 'number' ? { day: g.day, min: g.min } : null;
    }

    function smsGameOf(env) {
        if (!env || typeof env.day !== 'number' || typeof env.hour !== 'number') return null;
        return { day: env.day, min: env.hour * 60 + (env.minute || 0) };
    }

    function smsGameClock(g) { return g ? minutesToLabel(g.min) : ''; }

    // The time line between message runs, in game time: "Today 18:31", "Yesterday 09:05",
    // "Monday 21:40", "Day 998 08:12".
    function smsStamp(g, env) {
        if (!g) return '';
        var hm = minutesToLabel(g.min);
        var today = env && typeof env.day === 'number' ? env.day : null;
        if (today === null) return 'Day ' + g.day + ' ' + hm;
        var ago = today - g.day;
        if (ago === 0) return 'Today ' + hm;
        if (ago === 1) return 'Yesterday ' + hm;
        var dow = SMS_WEEKDAYS.indexOf(env.day_of_week);
        if (ago > 1 && ago < 7 && dow >= 0) return SMS_WEEKDAYS[((dow - ago) % 7 + 7) % 7] + ' ' + hm;
        return 'Day ' + g.day + ' ' + hm;
    }

    // Whether a time line goes above m. Only messages that know their game time get one.
    function smsStamped(prev, m) {
        if (!m.game) return false;
        if (!prev || !prev.game) return true;
        if (m.game.day !== prev.game.day) return true;
        return m.game.min - prev.game.min >= SMS_STAMP_GAP_MIN;
    }

    function sendGlyph() {
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'sms-send-ico');
        glyphPath(svg, 'M12 3.6l-7.1 7.1 1.6 1.6 4.4-4.4V20.4h2.2V7.9l4.4 4.4 1.6-1.6L12 3.6z', '#ffffff');
        return svg;
    }

    function photoGlyph() {
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'sms-photo-ico');
        glyphShape(svg, 'rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7 });
        glyphShape(svg, 'circle', { cx: 8.2, cy: 9, r: 1.5, fill: 'currentColor' });
        glyphPath(svg, 'M5.5 17.2l4.1-4.4c.7-.7 1.7-.7 2.4 0l2.1 2.2 1.5-1.5c.7-.7 1.7-.7 2.4 0l2 2.1v2H5.5z', 'currentColor');
        return svg;
    }

    function pickSmsPhoto() {
        if (!smsThread || smsSending || smsClearingAt) return;
        if (smsPhotoPending) {
            setNote('Finish choosing the photo on the PC first.', false);
            return;
        }
        if (aiPending || wallPending) {
            setNote('Another phone service request is still running. Try again in a moment.', false);
            return;
        }
        var section = smsThread;
        loadAiService().then(function (v) {
            aiService = v && typeof v === 'object' ? v : null;
            if (smsThread !== section) return;
            if (!aiAlive(aiService)) {
                setNote('Adding photos needs AI Phone Service running on this PC.', true);
                return;
            }
            if (!aiTakesRequests(aiService)) {
                setNote(AI_NO_GUARDIAN, true);
                return;
            }
            smsSeq += 1;
            var id = 'p' + Date.now() + '-' + smsSeq;
            smsPhotoPending = { id: id, type: 'photo_pick', section: section, at: Date.now() };
            smsEmojiOpen = false;
            var panel = document.getElementById('sms-emoji-panel');
            if (panel) animateEmojiPanel(panel, false);
            syncSmsPhotoComposer();
            saveJson('request', { id: id, type: 'photo_pick' }, AI_SECTION).then(function () {
                smsPhotoWatch();
            }, function (err) {
                smsPhotoPending = null;
                syncSmsPhotoComposer();
                setNote('Could not open the photo picker: ' + errText(err), true);
            });
        }, function (err) {
            setNote('Could not reach AI Phone Service: ' + errText(err), true);
        });
    }

    // The Windows dialog may outlive the chat page, so its answer is watched independently.
    function smsPhotoWatch() {
        if (smsPhotoWatching) return;
        smsPhotoWatching = true;
        var step = function () {
            if (!smsPhotoPending) {
                smsPhotoWatching = false;
                return;
            }
            loadAiService().then(function (v) {
                if (v && typeof v === 'object') aiService = v;
                smsPhotoCheckAnswer();
            }).then(null, function () {}).then(function () {
                if (smsPhotoPending) setTimeout(step, SMS_PHOTO_WATCH_MS);
                else smsPhotoWatching = false;
            });
        };
        setTimeout(step, SMS_PHOTO_WATCH_MS);
    }

    function smsPhotoCheckAnswer() {
        var asked = smsPhotoPending;
        if (!asked) return;
        var r = aiService && aiService.reply && typeof aiService.reply === 'object' ? aiService.reply : null;
        if (!r || r.id !== asked.id || r.pending) {
            if (Date.now() - asked.at > SMS_PHOTO_PICK_MS) {
                smsPhotoPending = null;
                syncSmsPhotoComposer();
                if (smsThread === asked.section) setNote('No answer from AI Phone Service. Check that it is running on this PC.', true);
            }
            return;
        }
        smsPhotoPending = null;
        var item = r.ok ? smsImageClean(r.item) : null;
        if (item) {
            smsPhotos[asked.section] = item;
            if (smsThread === asked.section) smsStick = true;
        } else if (smsThread === asked.section && r.code !== 'cancelled') {
            setNote(String(r.message || 'That photo could not be added.'), true);
        }
        syncSmsPhotoComposer();
        if (item && smsThread === asked.section) stickToBottom();
    }

    // Updates only the attachment UI; the textarea and any active IME are left untouched.
    function syncSmsPhotoComposer() {
        var pick = document.getElementById('sms-photo');
        var preview = document.getElementById('sms-photo-preview');
        var waiting = !!(smsPhotoPending && smsPhotoPending.section === smsThread);
        var photo = smsThread && smsPhotos[smsThread] ? smsPhotos[smsThread] : null;
        if (pick) {
            pick.className = 'sms-photo-btn' + (waiting ? ' waiting' : '') + (smsPhotoPending || smsSending ? ' off' : '');
            pick.setAttribute('title', waiting ? 'Choosing a photo on the PC' : 'Add photo');
        }
        if (preview) {
            while (preview.firstChild) preview.removeChild(preview.firstChild);
            if (waiting) {
                preview.style.display = 'flex';
                preview.appendChild(node('span', 'sms-photo-spinner'));
                preview.appendChild(node('span', 'sms-photo-wait', 'Choose a photo on your PC. If covered by the game, press Alt+Tab.'));
            } else if (photo) {
                preview.style.display = 'flex';
                var thumb = node('img', 'sms-photo-thumb');
                thumb.src = 'media/' + photo.id + '.jpg';
                thumb.setAttribute('alt', 'Selected photo');
                preview.appendChild(thumb);
                var meta = node('div', 'sms-photo-meta');
                meta.appendChild(node('div', 'sms-photo-ready', 'Photo ready'));
                meta.appendChild(node('div', 'sms-photo-size', photo.width + ' × ' + photo.height));
                preview.appendChild(meta);
                var remove = node('button', 'sms-photo-remove', '×');
                remove.type = 'button';
                remove.setAttribute('title', 'Remove photo');
                var section = smsThread;
                onTap(remove, function (e) {
                    e.stopPropagation();
                    delete smsPhotos[section];
                    syncSmsPhotoComposer();
                }, { silent: true });
                preview.appendChild(remove);
            } else {
                preview.style.display = 'none';
            }
        }
        syncSendButton();
    }

    // The send button is grey while there is nothing to send or a send is still being saved.
    function syncSendButton() {
        var box = document.getElementById('sms-box');
        var btn = document.getElementById('sms-send');
        if (!btn) return;
        var photo = smsThread && smsPhotos[smsThread];
        var empty = !photo && (!box || !String(box.value || '').replace(/^\s+|\s+$/g, ''));
        btn.className = 'sms-send' + (empty || smsSending || smsClearingAt ? ' off' : '');
    }

    // The box grows with what is typed, up to a few lines, then scrolls.
    // A scrollbar shown while measuring narrows the text and adds a line, so it is hidden then.
    // A thread read at its newest message stays there while the box takes room from it.
    function fitSmsBox(box) {
        if (!box) return;
        var log = document.getElementById('sms-log');
        var atEnd = !!log && (log.scrollHeight - log.scrollTop - log.clientHeight) < 48;
        box.style.overflowY = 'hidden';
        box.style.height = '38px';
        var h = box.scrollHeight + 2;
        if (h > 38) box.style.height = Math.min(h, SMS_INPUT_MAX_PX) + 'px';
        box.style.overflowY = h > SMS_INPUT_MAX_PX ? 'auto' : 'hidden';
        if (log && atEnd && !(smsScrollRide && !smsScrollRide.dead)) log.scrollTop = log.scrollHeight;
    }

    function rememberSms() {
        var box = document.getElementById('sms-box');
        var log = document.getElementById('sms-log');
        if (box) {
            smsDraft = box.value;
            // A rebuild must not focus this box again. focus() is what pulled a held walk
            // key into the field. The draft stays; the player clicks the box to continue.
            smsFocused = false;
        }
        if (log) {
            smsStick = (log.scrollHeight - log.scrollTop - log.clientHeight) < 48;
            smsScroll = log.scrollTop;
        }
    }

    function restoreSms() {
        var box = document.getElementById('sms-box');
        var log = document.getElementById('sms-log');
        if (box && box.value !== smsDraft) box.value = smsDraft;
        if (box) {
            fitSmsBox(box);
            syncSendButton();
        }
        smsFocused = false;
        // The rebuilt box must not keep the keyboard. A held walk key would fall into it,
        // and the next message would then remove a focused field.
        if (box && document.activeElement === box) {
            try { box.blur(); } catch (e) {}
        }
        restoreSmsLog(log);
    }

    function restoreSmsLog(log) {
        if (log && smsStick) {
            var px = measureSmsIn(log);
            // A new bubble eases into view. The first paint of a thread, and a log that has
            // not been laid out yet, still jump to the newest line.
            if (px > 1 && log.clientHeight > 0) rideSmsLog(log, px);
            else {
                log.scrollTop = log.scrollHeight;
                setTimeout(stickToBottom, 0);
                setTimeout(stickToBottom, 120);
                setTimeout(stickToBottom, 400);
            }
        } else if (log) {
            log.scrollTop = smsScroll;
        }
    }

    // A text arriving in the open thread replaces the header and the message list only. The
    // compose box is the same element before and after, so it keeps its focus, its draft and
    // the input method's half-typed word. Rebuilding it while a word was being composed left
    // the game's text input stuck, and no text field in the phone took a key after that.
    function patchChat(data) {
        var box = document.getElementById('sms-box');
        var oldLog = document.getElementById('sms-log');
        var wrap = oldLog ? oldLog.parentNode : null;
        if (!box || !wrap || !data || !data.contact || smsShownSection !== data.section) return false;
        var oldNav = null;
        for (var i = 0; i < wrap.children.length; i++) {
            if (wrap.children[i].className === 'sms-nav') oldNav = wrap.children[i];
        }
        if (!oldNav) return false;
        var prevKey = smsRenderedKey;
        var prevSection = smsShownSection;
        var fresh = renderChat(data);
        var nav = null;
        var log = null;
        for (var j = 0; j < fresh.children.length; j++) {
            var c = fresh.children[j];
            if (c.className === 'sms-nav') nav = c;
            else if (c.id === 'sms-log') log = c;
        }
        if (!nav || !log) {
            smsRenderedKey = prevKey;
            smsShownSection = prevSection;
            return false;
        }
        smsStick = (oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight) < 48;
        smsScroll = oldLog.scrollTop;
        if (smsScrollRide) smsScrollRide.dead = true;
        wrap.replaceChild(nav, oldNav);
        wrap.replaceChild(log, oldLog);
        applySmsStatus(data, true);
        restoreSmsLog(log);
        return true;
    }

    function stickToBottom() {
        var log = document.getElementById('sms-log');
        if (!log || !smsStick) return;
        if (smsScrollRide && !smsScrollRide.dead) return;
        log.scrollTop = log.scrollHeight;
    }

    function setSmsDelay(elm, ms) {
        if (!ms) return;
        var v = ms + 'ms';
        elm.style.webkitAnimationDelay = v;
        elm.style.animationDelay = v;
    }

    // Height the new bubbles, their time lines and the typing row add to the log.
    function measureSmsIn(log) {
        var rows = log.getElementsByClassName('sms-in');
        var h = 0;
        for (var i = 0; i < rows.length; i++) {
            h += rows[i].offsetHeight;
            var mt = 0;
            try {
                var cs = window.getComputedStyle(rows[i]);
                if (cs && cs.marginTop) mt = parseFloat(cs.marginTop) || 0;
            } catch (e) {}
            h += mt;
        }
        return h;
    }

    // The round button over the box that appears once the log is scrolled up from the newest
    // message, and glides back down to it.
    var SMS_JUMP_PX = 160;

    function smsJumpButton() {
        var b = node('button', 'sms-jump' + (smsStick ? '' : ' show'));
        b.id = 'sms-jump';
        b.type = 'button';
        b.setAttribute('title', 'Latest');
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'sms-jump-glyph');
        glyphPath(svg, 'M5.3 8.6a1.1 1.1 0 0 1 1.6 0L12 13.7l5.1-5.1a1.1 1.1 0 1 1 1.6 1.6l-5.9 5.9a1.1 1.1 0 0 1-1.6 0L5.3 10.2a1.1 1.1 0 0 1 0-1.6z', '#ffffff');
        b.appendChild(svg);
        onTap(b, function (e) {
            e.stopPropagation();
            var log = document.getElementById('sms-log');
            if (!log) return;
            smsStick = true;
            b.className = 'sms-jump';
            rideSmsLog(log, Math.max(0, log.scrollHeight - log.clientHeight - log.scrollTop));
        });
        return b;
    }

    function smsJumpSync(log) {
        var b = document.getElementById('sms-jump');
        if (!b || !log) return;
        if (smsScrollRide && !smsScrollRide.dead) return;
        var up = log.scrollHeight - log.scrollTop - log.clientHeight > SMS_JUMP_PX;
        var want = up ? 'sms-jump show' : 'sms-jump';
        if (b.className !== want) b.className = want;
    }

    function stopSmsRide() {
        if (!smsScrollRide || smsScrollRide.dead) return;
        smsScrollRide.dead = true;
        smsStick = false;
    }

    // Glide the log by the height of whatever just arrived, and keep aiming at the bottom
    // if that height changes while the glide is running.
    function rideSmsLog(log, px) {
        if (!log) return;
        if (!(px > 1)) px = measureSmsIn(log);
        var dest = Math.max(0, log.scrollHeight - log.clientHeight);
        var from = dest - px;
        if (from < 0) from = 0;
        if (dest - from < 2) {
            log.scrollTop = dest;
            return;
        }
        if (smsScrollRide) smsScrollRide.dead = true;
        var ride = { dead: false, log: log, from: from, t0: Date.now() };
        smsScrollRide = ride;
        log.scrollTop = from;
        function step() {
            if (ride.dead || !log.parentNode) {
                if (smsScrollRide === ride) smsScrollRide = null;
                return;
            }
            var p = springAt((Date.now() - ride.t0) / 1000, SMS_SCROLL.response, SMS_SCROLL.damping);
            if (p > 1) p = 1;
            var destNow = Math.max(0, log.scrollHeight - log.clientHeight);
            log.scrollTop = ride.from + (destNow - ride.from) * p;
            if (Date.now() - ride.t0 < SMS_SCROLL.ms && p < 0.995) nextFrame(step);
            else {
                log.scrollTop = log.scrollHeight;
                if (smsScrollRide === ride) smsScrollRide = null;
            }
        }
        nextFrame(step);
    }

    // Contact list: one row per household member who can text, with the latest message.
    // Every conversation the list has just read, kept per pair of people, so tapping a row can
    // open that very thread at once instead of waiting for the same six files to come back
    // (open, chatCached). Keyed by section, so what is shown can only be the thread whose row was
    // tapped; the fresh copy lands as soon as it arrives and is patched over it.
    var CHAT_TTL_MS = 5 * 60 * 1000;
    var chatLast = {};

    function chatCached(screenId) {
        if (screenId !== 'chat' || !smsContactId || !playedId) return null;
        var rec = chatLast[smsSection(playedId, smsContactId)];
        if (!rec || Date.now() - rec.at > CHAT_TTL_MS) return null;
        return rec.data;
    }

    function rememberChat(env, meId, contact, conv) {
        var section = smsSection(meId, contact.entity_id);
        chatLast[section] = { at: Date.now(), data: {
            env: env, meId: meId, contact: contact, section: section,
            messages: conv.messages, status: conv.status, portraitRev: portraitRev } };
        return chatLast[section].data;
    }

    function loadTexts() {
        return watchClear().then(function () {
            return Promise.all([getEnv(), getPossessedId(), getMembers(), loadPortraitIndex(), loadEmojiSet(), loadOutside()]);
        }).then(function (r) {
            var meId = String(r[1]);
            var members = r[2];
            var contacts = textContacts(meId, members);
            return Promise.all(contacts.map(function (m) {
                return loadConversation(meId, m.entity_id).then(function (conv) {
                    rememberChat(r[0], meId, m, conv);
                    return {
                        member: m,
                        last: conv.messages.length ? conv.messages[conv.messages.length - 1] : null,
                        unread: unreadCount(conv.theirs, conv.seenAt),
                        status: conv.status
                    };
                });
            })).then(function (rows) {
                return loadGroupsForTexts(members, meId).then(function (groups) {
                    return { env: r[0], meId: meId, members: members, self: memberById(members, meId), contacts: rows, groups: groups };
                });
            });
        });
    }

    // The way into a new group: a plus in the corner of the header, not a row in the list.
    function smsPlusButton(action) {
        var btn = node('button', 'sms-plus');
        btn.type = 'button';
        btn.setAttribute('title', 'New group');
        var icon = node('div', 'sms-plus-icon');
        icon.appendChild(node('div', 'sms-np-h'));
        icon.appendChild(node('div', 'sms-np-v'));
        btn.appendChild(icon);
        onTap(btn, function (e) { e.stopPropagation(); action(); }, { silent: true });
        return btn;
    }

    function renderTexts(data) {
        var wrap = node('div');
        var head = subHeader('texts');
        head.appendChild(smsPlusButton(function () { grpNewName = ''; grpNewSel = {}; open('groupNew'); }));
        wrap.appendChild(head);
        wrap.appendChild(clearTools());
        try {
            groupListRows(wrap, (data.groups || []).filter(Boolean), data.members || [], data.env);
            wrap.appendChild(node('div', 'ph-group-sep'));
        } catch (e) {
            setNote('Groups: ' + errText(e), true);
        }
        if (!data.contacts.length) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'Nobody to text yet. Open Contacts and tap Message on someone.'));
            wrap.appendChild(none);
            return wrap;
        }
        data.contacts.forEach(function (row) {
            var m = row.member;
            var id = String(m.entity_id);
            var c = node('div', 'ph-card sms-contact');
            var line = node('div', 'ph-row');
            var pic = node('div', 'sms-pic');
            pic.appendChild(faceAvatar(m));
            if (row.unread > 0) pic.appendChild(node('div', 'sms-unread', row.unread > 9 ? '9+' : String(row.unread)));
            line.appendChild(pic);
            var who = node('div', 'ph-who');
            var top = node('div', 'sms-contact-top');
            top.appendChild(node('div', 'ph-name', fullName(m)));
            var lastGame = row.last && row.last.game;
            if (lastGame) {
                top.appendChild(node('div', 'sms-contact-time', data.env && data.env.day === lastGame.day
                    ? smsGameClock(lastGame) : smsStamp(lastGame, data.env)));
            }
            who.appendChild(top);
            var p = presence(row.status);
            var sub = node('div', 'ph-sub');
            joinWithDots(sub, [m.relationship_label || m.age_group_text]);
            var pres = node('span', 'sms-presence inline ' + p.cls, p.text);
            sub.appendChild(pres);
            who.appendChild(sub);
            var lastText = row.last && row.last.image
                ? (row.last.text === SMS_PHOTO_TEXT ? 'Photo' : 'Photo: ' + row.last.text)
                : row.last ? row.last.text : '';
            var preview = row.last ? (row.last.side === 'mine' ? 'You: ' : '') + lastText : 'No messages yet';
            var previewEl = node('div', 'sms-preview' + (row.unread > 0 ? ' new' : ''));
            emojiFill(previewEl, smsClip(preview, 40));
            who.appendChild(previewEl);
            line.appendChild(who);
            c.appendChild(line);
            onTap(c, function (e) {
                e.stopPropagation();
                smsContactId = id;
                open('chat');
            });
            wrap.appendChild(c);
        });
        return wrap;
    }

    // One conversation between the played character and the selected contact.
    function loadChat() {
        var followPlayed = refreshDropping;
        return watchClear().then(function () {
            return Promise.all([getEnv(), getPossessedId(), getMembers(), loadPortraitIndex(), loadEmojiSet(), loadOutside()]);
        }).then(function (r) {
            var meId = String(r[1]);
            var members = r[2];
            var contact = null;
            var contacts = textContacts(meId, members);
            for (var i = 0; i < contacts.length; i++) {
                if (String(contacts[i].entity_id) === String(smsContactId)) contact = contacts[i];
            }
            if (!contact) {
                return { env: r[0], meId: meId, contact: null, portraitRev: portraitRev, leave: followPlayed };
            }
            var section = smsSection(meId, contact.entity_id);
            if (smsThread !== section) {
                smsThread = section;
                smsRenderedKey = '';
                smsDraft = '';
                smsStick = true;
                smsArrived = null;
            }
            return loadConversation(meId, contact.entity_id).then(function (conv) {
                var latest = 0;
                for (var j = 0; j < conv.theirs.length; j++) {
                    if (conv.theirs[j].at > latest) latest = conv.theirs[j].at;
                }
                var seenP = latest > conv.seenAt ? saveJson('seen', { at: latest }, section).then(function () {}, function () {}) : Promise.resolve();
                return seenP.then(function () {
                    return rememberChat(r[0], meId, contact, conv);
                });
            });
        });
    }

    function sendSms() {
        if (smsSending || smsClearingAt || !smsThread) return;
        var box = document.getElementById('sms-box');
        var raw = box ? box.value : smsDraft;
        var body = String(raw || '').replace(/^\s+|\s+$/g, '');
        var section = smsThread;
        var photo = smsPhotos[section] || null;
        if (!body && !photo) return;
        if (body.length > SMS_TEXT_MAX) {
            setNote('Keep it under ' + SMS_TEXT_MAX + ' characters.', true);
            return;
        }
        smsSending = true;
        smsDraft = '';
        smsCaret = null;
        delete smsPhotos[section];
        if (box) {
            box.value = '';
            fitSmsBox(box);
        }
        syncSmsPhotoComposer();
        Promise.all([loadBox('outbox', section), soft(getEnv())]).then(function (r) {
            var list = r[0];
            var msg = { id: 'w-' + Date.now() + '-' + (smsSeq += 1), text: body || SMS_PHOTO_TEXT, at: Date.now() };
            if (photo) msg.image = photo;
            var game = smsGameOf(r[1]);
            if (game) msg.game = game;
            list.push(msg);
            if (list.length > SMS_KEEP) list = list.slice(list.length - SMS_KEEP);
            return saveJson('outbox', list, section);
        }).then(function () {
            soundPlay('sent');
            smsRenderedKey = '';
            smsStick = true;
            setNote('', false);
            refresh();
        }, function (err) {
            smsDraft = body;
            if (photo) smsPhotos[section] = photo;
            var again = document.getElementById('sms-box');
            if (again) {
                again.value = body;
                fitSmsBox(again);
            }
            setNote(errText(err), true);
        }).then(function () {
            smsSending = false;
            syncSmsPhotoComposer();
        });
    }

    function renderChat(data) {
        var wrap = node('div', 'sms');
        if (!data.contact) {
            wrap.appendChild(subHeader('chat'));
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'This person can no longer be texted.'));
            wrap.appendChild(none);
            return wrap;
        }
        var nav = node('div', 'sms-nav');
        var back = node('div', 'ph-back', '< Back');
        onTap(back, function (e) {
            e.stopPropagation();
            open(backTarget('chat'));
        });
        nav.appendChild(back);
        var peer = node('div', 'sms-peer');
        peer.setAttribute('title', 'Edit how ' + (data.contact.first_name || fullName(data.contact)) + ' talks');
        peer.appendChild(faceAvatar(data.contact));
        peer.appendChild(node('div', 'sms-peer-name', fullName(data.contact) + ' \u203A'));
        var pres = node('div', 'sms-presence off', 'Offline');
        pres.id = 'sms-presence';
        peer.appendChild(pres);
        onTap(peer, function (e) {
            e.stopPropagation();
            open('persona');
        });
        nav.appendChild(peer);
        wrap.appendChild(nav);

        var log = node('div', 'sms-log');
        log.id = 'sms-log';
        // The reader turning the wheel takes the list back. The glide only writes scrollTop,
        // which does not count as that.
        log.addEventListener('wheel', stopSmsRide);
        log.addEventListener('scroll', function () { smsJumpSync(log); });
        var list = data.messages;
        if (!list.length) {
            log.appendChild(node('div', 'sms-empty', 'No messages yet. Say hi to ' + (data.contact.first_name || fullName(data.contact)) + '.'));
        }
        var known = smsArrived;
        var nextSeen = {};
        var freshN = 0;
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            nextSeen[m.id] = true;
            var prev = i > 0 ? list[i - 1] : null;
            var next = i + 1 < list.length ? list[i + 1] : null;
            var stamped = smsStamped(prev, m);
            var arriving = !!(known && !known[m.id]);
            var delay = Math.min(freshN * SMS_IN_STAGGER_MS, SMS_IN_STAGGER_MAX);
            if (arriving) freshN += 1;
            var stampNode = null;
            if (stamped) {
                stampNode = node('div', 'sms-stamp' + (prev ? '' : ' first') + (arriving ? ' sms-in' : ''), smsStamp(m.game, data.env));
                if (arriving) setSmsDelay(stampNode, delay);
                log.appendChild(stampNode);
            }
            var joinPrev = !stamped && !!prev && prev.side === m.side && m.at - prev.at < SMS_RUN_GAP_MS;
            var joinNext = !!next && next.side === m.side && next.at - m.at < SMS_RUN_GAP_MS && !smsStamped(m, next);
            var row = node('div', 'sms-row ' + (m.side === 'mine' ? 'mine' : 'theirs') + (joinPrev ? ' join' : '') + (joinNext ? '' : ' tail') + (arriving ? ' sms-in' : ''));
            var bubble = smsMessageBubble(m);
            if (arriving) setSmsDelay(bubble, delay);
            var time = m.game ? node('div', 'sms-time', smsGameClock(m.game)) : null;
            if (time && m.side === 'mine') row.appendChild(time);
            row.appendChild(bubble);
            if (time && m.side !== 'mine') row.appendChild(time);
            log.appendChild(row);
        }
        smsArrived = nextSeen;
        var receipt = node('div', 'sms-receipt', '');
        receipt.id = 'sms-receipt';
        log.appendChild(receipt);
        var typing = node('div', 'sms-row theirs sms-typing');
        typing.id = 'sms-typing';
        var dots = node('div', 'sms-bubble sms-dots');
        dots.appendChild(node('span', 'sms-dot d1'));
        dots.appendChild(node('span', 'sms-dot d2'));
        dots.appendChild(node('span', 'sms-dot d3'));
        typing.appendChild(dots);
        typing.style.display = 'none';
        log.appendChild(typing);
        smsTypingShown = false;
        wrap.appendChild(log);

        var compose = node('div', 'sms-compose');
        compose.appendChild(smsJumpButton());
        var field = node('div', 'sms-field');
        var input = node('textarea', 'sms-input');
        input.id = 'sms-box';
        applyUiFont(input);
        input.setAttribute('maxlength', String(SMS_TEXT_MAX));
        input.setAttribute('placeholder', 'Message');
        input.setAttribute('rows', '1');
        input.addEventListener('input', function () {
            smsDraft = input.value;
            smsCaret = input.selectionEnd;
            fitSmsBox(input);
            syncSendButton();
        });
        var keepCaret = function () { smsCaret = input.selectionEnd; };
        input.addEventListener('keyup', keepCaret);
        input.addEventListener('mouseup', keepCaret);
        input.addEventListener('keydown', function (e) {
            if (e.keyCode === 13 && !e.shiftKey && !e.isComposing && !smsComposing) {
                if (e.preventDefault) e.preventDefault();
                sendSms();
            }
        });
        input.addEventListener('compositionstart', function () { smsComposing = true; });
        input.addEventListener('compositionend', function () {
            smsComposing = false;
            smsDraft = input.value;
            if (!smsComposeRefresh) return;
            smsComposeRefresh = false;
            refresh();
        });
        var send = node('button', 'sms-send off');
        send.id = 'sms-send';
        send.type = 'button';
        send.setAttribute('title', 'Send');
        send.appendChild(sendGlyph());
        onTap(send, function (e) {
            e.stopPropagation();
            sendSms();
        }, { silent: true });
        var pick = node('button', 'sms-photo-btn');
        pick.id = 'sms-photo';
        pick.type = 'button';
        pick.setAttribute('title', 'Add photo');
        pick.appendChild(photoGlyph());
        onTap(pick, function (e) {
            e.stopPropagation();
            pickSmsPhoto();
        }, { silent: true });
        var smile = node('button', 'sms-emoji-btn' + (smsEmojiOpen ? ' on' : ''));
        smile.type = 'button';
        smile.setAttribute('title', 'Emoji');
        if (emojiSet) {
            var face = emojiSet.byName['微笑'] || emojiSet.list[0].id;
            smile.appendChild(emojiImg(face, ''));
        } else {
            smile.style.display = 'none';
        }
        onTap(smile, function (e) {
            e.stopPropagation();
            smsEmojiOpen = !smsEmojiOpen;
            var panel = document.getElementById('sms-emoji-panel');
            smile.className = 'sms-emoji-btn' + (smsEmojiOpen ? ' on' : '');
            restartAnim(smile, 'press');
            if (panel) animateEmojiPanel(panel, smsEmojiOpen);
            else stickToBottom();
        });
        field.appendChild(pick);
        field.appendChild(smile);
        field.appendChild(input);
        field.appendChild(send);
        compose.appendChild(emojiPanel());
        var photoPreview = node('div', 'sms-photo-preview');
        photoPreview.id = 'sms-photo-preview';
        photoPreview.style.display = 'none';
        compose.appendChild(photoPreview);
        compose.appendChild(field);
        wrap.appendChild(compose);
        syncSmsPhotoComposer();
        smsRenderedKey = threadKey(data.messages) + '|' + (data.portraitRev || 0);
        smsShownSection = data.section || '';
        return wrap;
    }

    // ------------------------------------------------------------------
    // Group chats. One conversation with several of the phone's contacts in it, answered by
    // the PC service (lib/groups.js). Files, all under ui/phone/groups/:
    //   list.cfg           { v, groups: [{ id, name, members: [id] }] }        this screen writes
    //   g-<id>/meta.cfg    { v, id, name, owner, members: [{ id, name }], auto }
    //   g-<id>/outbox.cfg  what the player typed: { id, text, at, mentions, replyTo }
    //   g-<id>/inbox.cfg   what the contacts said: { id, from, name, text, at, to, replyTo }
    // ------------------------------------------------------------------
    var SMS_G_SECTION = 'ui/phone/groups';
    var SMS_G_MAX = 8;
    var SMS_G_TEXT_MAX = 400;
    var SMS_G_KEEP = 200;
    var grpIndex = null;
    var grpId = '';
    var grpDraft = '';
    var grpComposing = false;
    var grpComposingAt = 0;
    var grpRenderedKey = '';
    var grpShown = null;
    var grpStick = true;
    var grpScroll = 0;
    // While this is in the future, nothing may turn the pin off: right after entering, the log
    // can be measured before it has a height, and that reads as "the reader scrolled up".
    var grpPinnedUntil = 0;
    var grpFocused = false;
    var grpReply = null;
    var grpMention = null;
    var grpSending = false;
    var grpSeq = 0;
    var grpMeId = '';
    var grpMentionOpen = false;
    // Which group the DOM currently shows, so an update can be applied in place.
    var grpShownId = '';
    // Set by actions that must redraw even though the composer has the cursor.
    var grpForceDraw = false;
    var grpMenuOpen = false;
    var grpNameDraft = '';
    var grpNameBusy = false;
    var grpMembersBusy = false;
    var grpAddOpen = false;
    var grpNewName = '';
    var grpNewSel = {};
    var grpNewBusy = false;

    function grpValid(id) { return /^[A-Za-z0-9_-]{1,40}$/.test(String(id || '')); }
    function grpSection(id) { return SMS_G_SECTION + '/g-' + id; }

    function loadGroupIndex() {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: SMS_G_SECTION, key: 'list' }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                var out = [];
                if (v && Array.isArray(v.groups)) {
                    for (var i = 0; i < v.groups.length; i++) {
                        var g = v.groups[i];
                        if (g && grpValid(g.id)) {
                            var ms = Array.isArray(g.members) ? g.members.map(String).filter(function (x) { return /^\d+$/.test(x); }) : [];
                            out.push({ id: String(g.id), name: String(g.name || 'Group').slice(0, 20), members: ms });
                        }
                    }
                }
                grpIndex = out;
                return out;
            }, function () { grpIndex = []; return []; });
    }

    // Group messages carry who said it and what they answered, which cleanList — written for
    // one-to-one threads — strips. Read the raw array and validate only the shape.
    function loadGroupBox(key, section) {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: section, key: key }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                if (!Array.isArray(v)) return [];
                var out = [];
                for (var i = 0; i < v.length; i++) {
                    var m = v[i];
                    if (!m || typeof m.text !== 'string' || typeof m.at !== 'number') continue;
                    out.push(m);
                }
                return out;
            }, function () { return []; });
    }

    function loadGroupMeta(id) {
        if (!grpValid(id)) return Promise.resolve(null);
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: grpSection(id), key: 'meta' }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                if (!v || !Array.isArray(v.members)) return null;
                if (v.closed) return null;
                var list = [];
                var names = {};
                for (var i = 0; i < v.members.length; i++) {
                    var m = v.members[i];
                    var mid = m && typeof m === 'object' ? String(m.id) : String(m);
                    if (!/^\d+$/.test(mid)) continue;
                    // A name that is only the id was stored when the person could not be looked
                    // up; leaving it out lets grpName find the real one.
                    if (m && typeof m === 'object' && m.name && !/^\d+$/.test(String(m.name))) names[mid] = String(m.name);
                    if (list.indexOf(mid) < 0 && list.length < SMS_G_MAX) list.push(mid);
                }
                if (!list.length) return null;
                return { id: String(id), name: String(v.name || 'Group').slice(0, 20), owner: String(v.owner || ''), members: list, memberNames: names, auto: v.auto !== false, createdAt: Number(v.createdAt) || 0 };
            }, function () { return null; });
    }

    // Both sides of the group in one list, oldest first. "mine" is the player's own typing.
    function loadGroupConversation(id, meId) {
        var me = String(meId || '');
        var section = grpSection(id);
        return Promise.all([loadGroupMeta(id), loadGroupBox('inbox', section), loadGroupBox('outbox', section), loadSeen(section), loadStatus(section)])
            .then(function (r) {
                var meta = r[0];
                if (!meta) return { meta: null, messages: [], seenAt: 0, status: null };
                // The outbox is shared by everyone who uses this phone, so a line written by
                // another character must not be drawn as the current player's own.
                var mine = [];
                var other = [];
                r[2].forEach(function (m) {
                    var from = String(m.from || '');
                    var row = {
                        id: String(m.id || ''), text: String(m.text || ''), at: Number(m.at) || 0,
                        game: smsGameClean(m.game), mentions: m.mentions || [], replyTo: m.replyTo || '',
                        from: from, name: from && meta && meta.memberNames ? (meta.memberNames[from] || '') : ''
                    };
                    // No author recorded (written before this existed): the current player's own.
                    if (!from || !me || from === me) { row.side = 'mine'; mine.push(row); }
                    else { row.side = 'theirs'; other.push(row); }
                });
                var theirs = r[1].map(function (m) {
                    return { id: String(m.id || ''), side: 'theirs', text: String(m.text || ''), at: Number(m.at) || 0, game: smsGameClean(m.game), from: String(m.from || ''), name: String(m.name || ''), to: m.to || [], replyTo: m.replyTo || '' };
                });
                var all = mine.concat(theirs).concat(other);
                all.sort(function (a, b) { return a.at - b.at || (a.side === b.side ? 0 : a.side === 'mine' ? -1 : 1); });
                return { meta: meta, messages: all, seenAt: r[3], status: r[4] };
            });
    }

    function grpKey(data) {
        if (!data || !data.messages) return '';
        var last = data.messages.length ? data.messages[data.messages.length - 1] : null;
        // The name and the size of the group are part of the picture too: without them a rename
        // leaves the page untouched until the next message arrives.
        // Who is playing is part of the picture: the group is one shared thread, so switching
        // character has to redraw which side every line sits on.
        return data.meta.id + '|' + String(data.meId || '') + '|' + data.meta.name + '|' + data.meta.members.length + '|' +
            data.messages.length + '|' + (last ? last.id : '') + '|' +
            (data.status && data.status.typing ? data.status.typing : '') + '|' +
            (grpReply ? 'reply:' + grpReply.id : '');
    }

    // What the list page shows for one group: who spoke last and how much is new.
    function loadGroupSummary(g) {
        var section = grpSection(g.id);
        return Promise.all([loadGroupMeta(g.id), loadGroupBox('inbox', section), loadGroupBox('outbox', section), loadSeen(section)]).then(function (r) {
            var meta = r[0];
            if (!meta) return null;
            var all = r[1].map(function (m) { return { side: 'theirs', at: Number(m.at) || 0, text: String(m.text || ''), name: grpSpeaker(meta, { name: m.name, from: String(m.from || '') }) }; })
                .concat(r[2].map(function (m) { return { side: 'mine', at: Number(m.at) || 0, text: String(m.text || ''), name: '' }; }));
            all.sort(function (a, b) { return a.at - b.at; });
            var unread = 0;
            for (var i = 0; i < r[1].length; i++) if (Number(r[1][i].at) > r[3]) unread += 1;
            return { meta: meta, last: all.length ? all[all.length - 1] : null, unread: unread, env: null };
        }, function () { return null; });
    }

    // Loaded with the Texts page: the groups this character is in, with the last line and the
    // unread count. A group belongs to whoever made it and to everyone in it — someone who was
    // not added must not find it on their phone.
    function loadGroupsForTexts(members, meId) {
        var me = String(meId || '');
        grpKnown = grpPeople(members);
        return loadGroupIndex().then(function (list) {
            return Promise.all(list.map(function (g) { return loadGroupSummary(g); })).then(function (rows) {
                return rows.filter(function (row) {
                    if (!row || !row.meta) return false;
                    if (!me) return false;
                    if (String(row.meta.owner) === me) return true;
                    return row.meta.members.indexOf(me) >= 0;
                });
            });
        }, function () { return []; });
    }

    function openGroup(id) {
        grpId = String(id);
        grpDraft = '';
        grpReply = null;
        grpMention = null;
        grpRenderedKey = '';
        grpShown = null;
        grpStick = true;
        grpScroll = 0;
        grpPinnedUntil = Date.now() + 2500;
        open('group');
    }

    function loadGroup() {
        var id = grpId;
        return Promise.all([getEnv(), getPossessedId(), getMembers(), loadPortraitIndex(), loadEmojiSet(), loadOutside()]).then(function (r) {
            grpKnown = grpPeople(r[2]);
            return loadGroupConversation(id, r[1]).then(function (conv) {
                if (!conv.meta) return { env: r[0], meId: String(r[1]), meta: null, messages: [] };
                conv.messages.forEach(function (m) { if (m.side === 'theirs') m.name = grpSpeaker(conv.meta, m); });
                grpHealNames(conv.meta);
                var latest = 0;
                for (var i = 0; i < conv.messages.length; i++) if (conv.messages[i].side === 'theirs' && conv.messages[i].at > latest) latest = conv.messages[i].at;
                var seenP = latest > conv.seenAt ? saveJson('seen', { at: latest }, grpSection(id)).then(function () { }, function () { }) : Promise.resolve();
                return seenP.then(function () {
                    return { env: r[0], meId: String(r[1]), members: grpKnown, meta: conv.meta, messages: conv.messages, status: conv.status };
                });
            });
        });
    }


    function grpSetPresence(data) {
        var pres = document.getElementById('sms-presence');
        if (!pres || !data.meta) return;
        var typing = data.status && data.status.typing ? grpName(data.meta, data.status.typing) : '';
        pres.textContent = typing ? typing + ' is typing…' : (data.meta.members.length + ' people');
        pres.className = 'sms-presence' + (typing ? '' : ' off');
    }

    // Applies a refresh to the page already on screen: new lines are appended, the header's
    // presence is updated, and everything else — the header, the composer, every bubble that was
    // already there — is left alone. Returns false when the page is not in a state that allows it,
    // and the caller falls back to drawing the whole page.
    function patchGroup(data) {
        var log = document.getElementById('sms-log');
        if (!log || !data.meta) return false;
        if (String(grpShownId) !== String(data.meta.id)) return false;
        var list = data.messages || [];
        if (!list.length) return false;
        var shown = grpShown || {};
        var first = 0;
        while (first < list.length && shown[list[first].id]) first += 1;
        if (first === 0) return false;                 // nothing on this page matches yet
        for (var j = first; j < list.length; j++) if (shown[list[j].id]) return false;
        var empty = log.getElementsByClassName('sms-empty');
        if (empty.length) log.removeChild(empty[0]);
        var added = grpFillLog(log, data, list, first);
        for (var k in added) if (added.hasOwnProperty(k)) shown[k] = true;
        grpShown = shown;
        grpSetPresence(data);
        grpRenderedKey = grpKey(data);
        if (grpStick) grpToBottom();
        return true;
    }

    // People the group pages last loaded (grpPeople), for names the group did not store.
    var grpKnown = [];

    function grpName(meta, id) {
        if (meta && meta.memberNames && meta.memberNames[id]) return meta.memberNames[id];
        var p = memberById(grpKnown, id);
        return p ? (p.first_name || fullName(p)) : 'Someone';
    }

    // A message's speaker as the page shows it: what the service stored, unless that is only an id.
    function grpSpeaker(meta, msg) {
        var n = String(msg.name || '');
        return n && !/^\d+$/.test(n) ? n : (msg.from ? grpName(meta, msg.from) : n);
    }

    // Writes back the real names of members stored by id only, so the service sees them too.
    function grpHealNames(meta) {
        var fix = false;
        meta.memberNames = meta.memberNames || {};
        meta.members.forEach(function (mid) {
            if (meta.memberNames[mid]) return;
            var p = memberById(grpKnown, mid);
            if (p) { meta.memberNames[mid] = p.first_name || fullName(p); fix = true; }
        });
        return fix ? soft(saveGroupMeta(meta)) : Promise.resolve();
    }

    // One face for the group. A stack of avatars inside another avatar needs nested percentage
    // heights and negative margins, and cohtml laid that out as one very tall empty row; the row
    // already says how many people are in it one line down.
    // A group picture the way WeChat draws one: a square of member faces, laid out with fixed
    // pixel offsets. No nested .ph-avatar and no percentage heights — cohtml collapsed that.
    function grpFaceCell(id, members) {
        var key = String(id);
        var cell = node('div', 'sms-gcell');
        var meta = portraitIndex[key];
        if (meta && typeof meta === 'object') {
            var img = node('img', 'sms-gcell-img');
            img.setAttribute('alt', '');
            img.src = 'portraits/' + key + '.png?v=' + (meta.mtime || portraitRev || 1);
            cell.appendChild(img);
        } else {
            var m = memberById(members || [], id);
            var letter = m ? String(m.first_name || fullName(m) || '?').slice(0, 1) : '?';
            var ph = node('div', 'sms-gcell-letter', letter);
            cell.style.background = smsMemberColor(key);
            cell.appendChild(ph);
        }
        return cell;
    }

    function grpFaces(meta, members) {
        var pic = node('div', 'sms-pic');
        var box = node('div', 'sms-gavatar');
        var ids = meta.members.slice(0, 4);
        // [left, top, width, height] inside a 44px square
        var cells = ids.length >= 4 ? [[0, 0, 21, 21], [23, 0, 21, 21], [0, 23, 21, 21], [23, 23, 21, 21]]
            : ids.length === 3 ? [[0, 0, 21, 21], [23, 0, 21, 21], [0, 23, 21, 21]]
            : [[0, 0, 21, 44], [23, 0, 21, 44]];
        for (var i = 0; i < ids.length && i < cells.length; i++) {
            var c = cells[i];
            var cell = grpFaceCell(ids[i], members);
            cell.style.left = c[0] + 'px';
            cell.style.top = c[1] + 'px';
            cell.style.width = c[2] + 'px';
            cell.style.height = c[3] + 'px';
            box.appendChild(cell);
        }
        pic.appendChild(box);
        return pic;
    }

    // The rows on the Texts page: one New Group entry, then every group.
    function groupListRows(wrap, groups, members, env) {
        groups.forEach(function (row) {
            var meta = row.meta;
            var card = node('div', 'ph-card sms-contact sms-group');
            var row2 = node('div', 'ph-row');
            var pic2 = grpFaces(meta, members);
            if (row.unread > 0) pic2.appendChild(node('div', 'sms-unread', row.unread > 9 ? '9+' : String(row.unread)));
            row2.appendChild(pic2);
            var who2 = node('div', 'ph-who');
            var top = node('div', 'sms-contact-top');
            top.appendChild(node('div', 'ph-name', meta.name));
            if (row.last) {
                var lg = row.last.game;
                if (lg && env) top.appendChild(node('div', 'sms-contact-time', env.day === lg.day ? smsGameClock(lg) : smsStamp(lg, env)));
            }
            who2.appendChild(top);
            who2.appendChild(node('div', 'ph-sub', meta.members.length + ' people'));
            var previewEl = node('div', 'sms-preview' + (row.unread > 0 ? ' new' : ''));
            var line = '';
            if (row.last) line = (row.last.side === 'mine' ? 'You: ' : (row.last.name ? row.last.name + ': ' : '')) + String(row.last.text || '');
            emojiFill(previewEl, smsClip(line || 'No messages yet', 40));
            who2.appendChild(previewEl);
            row2.appendChild(who2);
            card.appendChild(row2);
            onTap(card, function (e) { e.stopPropagation(); openGroup(meta.id); });
            wrap.appendChild(card);
        });
    }

    function loadGroupNew() {
        return Promise.all([getEnv(), getPossessedId(), getMembers(), loadPortraitIndex(), loadOutside()]).then(function (r) {
            var meId = String(r[1]);
            grpKnown = grpPeople(r[2]);
            return { env: r[0], meId: meId, members: r[2], contacts: textContacts(meId, r[2]) };
        });
    }

    function renderGroupNew(data) {
        var wrap = node('div', 'ph-page');
        wrap.appendChild(subHeader('groupNew', 'New Group'));
        var nameCard = card();
        var field = node('textarea', 'sms-gname');
        field.setAttribute('placeholder', 'Group name (optional)');
        field.setAttribute('maxlength', '20');
        field.setAttribute('rows', '1');
        field.value = grpNewName;
        applyUiFont(field);
        field.addEventListener('input', function () { grpNewName = field.value; });
        nameCard.appendChild(field);
        wrap.appendChild(nameCard);

        var chosen = 0;
        Object.keys(grpNewSel).forEach(function (k) { if (grpNewSel[k]) chosen += 1; });
        var hint = card();
        hint.appendChild(node('div', 'ph-sub', chosen ? chosen + ' chosen' : 'Choose two or more people'));
        wrap.appendChild(hint);

        var listCard = card();
        data.contacts.forEach(function (m) {
            var id = String(m.entity_id);
            var row = node('div', 'sms-pick');
            row.appendChild(faceAvatar(m));
            row.appendChild(node('div', 'sms-pick-name', fullName(m)));
            var tick = node('div', 'sms-pick-tick' + (grpNewSel[id] ? ' on' : ''), grpNewSel[id] ? '\u2713' : '');
            row.appendChild(tick);
            onTap(row, function (e) {
                e.stopPropagation();
                if (grpNewSel[id]) { delete grpNewSel[id]; tick.className = 'sms-pick-tick'; tick.textContent = ''; }
                else {
                    var n = 0;
                    Object.keys(grpNewSel).forEach(function (k) { if (grpNewSel[k]) n += 1; });
                    if (n >= SMS_G_MAX) { setNote('Up to ' + SMS_G_MAX + ' people in one group.', true); return; }
                    grpNewSel[id] = true;
                    tick.className = 'sms-pick-tick on';
                    tick.textContent = '\u2713';
                }
                setNote('', false);
                refresh();
            });
            listCard.appendChild(row);
        });
        wrap.appendChild(listCard);

        var go = node('button', 'ph-btn sms-gcreate' + (chosen >= 2 ? '' : ' off'), 'Create');
        go.type = 'button';
        onTap(go, function (e) { e.stopPropagation(); createGroup(data); }, { silent: true });
        wrap.appendChild(go);
        return wrap;
    }

    function createGroup(data) {
        if (grpNewBusy) return;
        var ids = Object.keys(grpNewSel).filter(function (k) { return grpNewSel[k]; });
        if (ids.length < 2) { setNote('Choose two or more people.', true); return; }
        var name = String(grpNewName || '').replace(/^\s+|\s+$/g, '').slice(0, 20);
        // The picker lists people outside the household too (data.contacts), so names come from there.
        var person = function (mid) { return memberById(data.contacts, mid) || memberById(grpPeople(data.members), mid); };
        if (!name) {
            var names = ids.map(function (id) {
                var m = person(id);
                return m ? (m.first_name || fullName(m)) : '';
            }).filter(Boolean);
            name = names.slice(0, 3).join(', ') || 'Group';
        }
        var id = 'g' + Date.now().toString(36);
        var members = ids.map(function (mid) {
            var m = person(mid);
            return { id: String(mid), name: m ? (m.first_name || fullName(m)) : String(mid) };
        });
        var meta = { v: 1, id: id, name: name, owner: String(data.meId), members: members, auto: true, createdAt: Date.now() };
        grpNewBusy = true;
        saveJson('meta', meta, grpSection(id)).then(function () {
            return loadGroupIndex();
        }).then(function (list) {
            var groups = (list || []).slice();
            groups.push({ id: id, name: name, members: ids });
            return saveJson('list', { v: 1, groups: groups.map(function (g) { return { id: g.id, name: g.name, members: Array.isArray(g.members) && g.members.length ? g.members : [] }; }) }, SMS_G_SECTION);
        }).then(function () {
            grpNewBusy = false;
            setNote('', false);
            openGroup(id);
        }, function (err) {
            grpNewBusy = false;
            setNote(errText(err), true);
        });
    }

    function grpStamped(prev, m) { return !prev || m.at - prev.at > SMS_RUN_GAP_MS; }

    function smsMemberColor(id) {
        // A fixed palette rather than hsl(): cohtml's colour parser is partial, and six colours
        // are enough to tell a handful of people apart.
        var palette = ['#0A84FF', '#FF9F0A', '#30D158', '#BF5AF2', '#FF375F', '#64D2FF'];
        var n = 0;
        var s = String(id);
        for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % palette.length;
        return palette[n];
    }

    function findGroupMessage(list, id) {
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    }

    // Draws the lines of a group thread into the log, from index `from` on. Used for the first
    // paint and for appending later lines in place, so an incoming message does not force the
    // whole conversation to be rebuilt (which reads as a flicker).
    function grpFillLog(log, data, list, from) {
        var known = grpShown;
        var nextSeen = {};
        var prev = from > 0 ? list[from - 1] : null;
        var freshN = 0;
        for (var i = from; i < list.length; i++) {
            var m = list[i];
            nextSeen[m.id] = true;
            // A line that was not on screen last time is new: it grows out of its corner, and a
            // burst of them comes in one after another, the way a one-to-one thread does.
            var arriving = !!(known && !known[m.id]);
            var delay = Math.min(freshN * SMS_IN_STAGGER_MS, SMS_IN_STAGGER_MAX);
            if (arriving) freshN += 1;
            if (grpStamped(prev, m)) {
                var stampText = smsStamp(m.game, data.env);
                if (stampText) {
                    var stamp = node('div', 'sms-stamp' + (prev ? '' : ' first') + (arriving ? ' sms-in' : ''), stampText);
                    if (arriving) setSmsDelay(stamp, delay);
                    log.appendChild(stamp);
                }
            }
            // Its own row class: the 1:1 rows carry wrap and radius rules that a group row
            // (name above, quote above) does not want.
            var row = node('div', 'sms-grow ' + (m.side === 'mine' ? 'mine' : 'theirs') + (arriving ? ' sms-in' : ''));
            var stack = node('div', 'sms-gstack');
            if (arriving) setSmsDelay(stack, delay);
            if (m.side === 'theirs' && (!prev || prev.side !== 'theirs' || prev.from !== m.from)) {
                var tag = node('div', 'sms-sender', m.name || grpName(data.meta, m.from));
                tag.style.color = smsMemberColor(m.from);
                stack.appendChild(tag);
            }
            var quoted = m.replyTo ? findGroupMessage(list, m.replyTo) : null;
            if (quoted) {
                var q = node('div', 'sms-quote');
                q.appendChild(node('div', 'sms-quote-who', quoted.side === 'mine' ? 'You' : (quoted.name || grpName(data.meta, quoted.from))));
                q.appendChild(node('div', 'sms-quote-text', String(quoted.text || '').slice(0, 60)));
                stack.appendChild(q);
            }
            var bubble = smsBubble(String(m.text || ''));
            // Every line can be the one being answered — your own too, so the others know which
            // of your messages is under discussion. Tapping the row toggles it.
            row.setAttribute('data-id', m.id);
            (function (mm) {
                onTap(row, function (e) {
                    e.stopPropagation();
                    if (grpReply && grpReply.id === mm.id) grpReply = null;
                    else grpReply = { id: mm.id, name: mm.side === 'mine' ? 'You' : (mm.name || grpName(data.meta, mm.from)), text: mm.text };
                    grpSyncReplyBar();
                });
            })(m);
            if (grpReply && grpReply.id === m.id) row.className += ' picked';
            stack.appendChild(bubble);
            var time = m.game ? node('div', 'sms-time', smsGameClock(m.game)) : null;
            if (time && m.side === 'mine') row.appendChild(time);
            row.appendChild(stack);
            if (time && m.side !== 'mine') row.appendChild(time);
            log.appendChild(row);
            prev = m;
        }
        return nextSeen;
    }

    function grpReplyBar() {
        var bar = node('div', 'sms-replybar');
        bar.appendChild(node('div', 'sms-replybar-who', 'Replying to ' + grpReply.name));
        bar.appendChild(node('div', 'sms-replybar-text', String(grpReply.text || '').slice(0, 60)));
        var x = node('button', 'sms-replybar-x', '\u00D7');
        x.type = 'button';
        onTap(x, function (e) { e.stopPropagation(); grpReply = null; grpSyncReplyBar(); }, { silent: true });
        bar.appendChild(x);
        return bar;
    }

    // The quote bar, the box's placeholder and the picked line follow grpReply in place. A refresh
    // does not do it: patchGroup only appends new lines and leaves the composer as it is, so the
    // bar stayed up after closing it and after sending.
    function grpSyncReplyBar() {
        var box = document.getElementById('sms-box');
        var compose = box && box.parentNode ? box.parentNode.parentNode : null;
        if (compose) {
            var old = compose.getElementsByClassName('sms-replybar');
            while (old.length) old[0].parentNode.removeChild(old[0]);
            var field = box.parentNode;
            if (grpReply) compose.insertBefore(grpReplyBar(), field);
        }
        if (box) box.setAttribute('placeholder', grpReply ? 'Reply' : 'Message');
        var rows = document.getElementsByClassName('sms-grow');
        for (var i = 0; i < rows.length; i++) {
            if (grpReply && rows[i].getAttribute('data-id') === grpReply.id) rows[i].classList.add('picked');
            else rows[i].classList.remove('picked');
        }
        grpRenderedKey = '';
    }

    function renderGroup(data) {
        grpMeId = String(data.meId || '');
        // The layout that pins the composer to the bottom hangs off #content.sms-open. A refresh
        // that short-circuits on an unchanged thread never reaches the code that adds it, so the
        // page sets it itself.
        try {
            var shell = document.getElementById('content');
            if (shell) shell.classList.add('sms-open');
        } catch (e) {}
        var wrap = node('div', 'sms');
        if (!data.meta) {
            wrap.appendChild(subHeader('group', 'Group'));
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'This group is gone.'));
            wrap.appendChild(none);
            return wrap;
        }
        var nav = node('div', 'sms-nav');
        var back = node('div', 'ph-back', '< Back');
        onTap(back, function (e) { e.stopPropagation(); open('texts'); });
        nav.appendChild(back);
        // The avatar stack fights .sms-nav's centred peer block; the header carries the name
        // and the member line only, the way Messages shows a compact group header.
        var peer = node('div', 'sms-peer sms-peer-group');
        peer.appendChild(node('div', 'sms-peer-name', data.meta.name));
        var typing = data.status && data.status.typing ? grpName(data.meta, data.status.typing) : '';
        var pres = node('div', 'sms-presence' + (typing ? '' : ' off'), typing ? typing + ' is typing\u2026' : (data.meta.members.length + ' people'));
        pres.id = 'sms-presence';
        peer.appendChild(pres);
        nav.appendChild(peer);
        var more = node('button', 'sms-more');
        more.type = 'button';
        more.setAttribute('title', 'Group settings');
        // Plain text: the positioned divs measured correctly and still painted as one point, and
        // the svg never made it into the tree on this engine. Text is what everything else here is.
        more.appendChild(node('div', 'sms-more-glyph', '...'));
        onTap(more, function (e) { e.stopPropagation(); grpOpenMenu(data); }, { silent: true });
        wrap.appendChild(nav);
        // Appended to the page, not the nav: the nav is pulled 16px past the content edge on both
        // sides, so a right:0 child sat half outside the screen.
        wrap.appendChild(more);

        grpShownId = String(data.meta.id);
        var log = node('div', 'sms-log');
        log.id = 'sms-log';
        // Hidden for a beat while it is placed at the newest line: on a slow layout the first
        // paint would show the top of the thread. The timers live here, not in restoreGroup,
        // because that path is not always taken on a second visit — and a log left hidden is
        // worse than a short flash.
        if (grpPinnedUntil > Date.now()) {
            log.style.opacity = '0';
            setTimeout(function () {
                var l = document.getElementById('sms-log');
                if (!l) return;
                l.scrollTop = l.scrollHeight;
                l.style.opacity = '1';
            }, 400);
            setTimeout(function () {
                var l = document.getElementById('sms-log');
                if (l && l.style.opacity === '0') { l.scrollTop = l.scrollHeight; l.style.opacity = '1'; }
            }, 1200);
        }
        log.addEventListener('scroll', function () { grpJumpSync(log); });
        var list = data.messages || [];
        if (!list.length) log.appendChild(node('div', 'sms-empty', 'No messages yet. Say something.'));
        grpShown = grpFillLog(log, data, list, 0);
        wrap.appendChild(log);

        var compose = node('div', 'sms-compose');
        compose.appendChild(grpJumpButton());
        if (grpReply) compose.appendChild(grpReplyBar());
        var field = node('div', 'sms-field');
        var at = node('button', 'sms-at-btn', '@');
        at.type = 'button';
        at.setAttribute('title', 'Mention someone');
        onTap(at, function (e) { e.stopPropagation(); grpPickMention(data); }, { silent: true });
        var input = node('textarea', 'sms-input sms-ginput');
        input.id = 'sms-box';
        applyUiFont(input);
        input.setAttribute('maxlength', String(SMS_G_TEXT_MAX));
        input.setAttribute('placeholder', grpReply ? 'Reply' : 'Message');
        input.setAttribute('rows', '1');
        input.value = grpDraft;
        input.addEventListener('input', function () {
            grpDraft = input.value;
            fitSmsBox(input);
            syncSendButton();
            // Typing "@" brings the list up by itself, the way a chat app does; a space after it
            // means the name is done being asked for.
            var caret = input.selectionEnd === undefined || input.selectionEnd === null ? grpDraft.length : input.selectionEnd;
            var before = grpDraft.slice(0, caret);
            var at = before.lastIndexOf('@');
            var asking = at >= 0 && before.slice(at + 1).indexOf(' ') < 0;
            if (asking && !grpMentionOpen) grpPickMention(data);
            else if (!asking && grpMentionOpen) grpHideMention();
        });
        input.addEventListener('compositionstart', function () { grpComposing = true; grpComposingAt = Date.now(); });
        input.addEventListener('compositionend', function () { grpComposing = false; grpDraft = input.value; });
        input.addEventListener('keydown', function (e) {
            if (e.keyCode === 13 && !e.shiftKey && !e.isComposing && !grpComposing) {
                if (e.preventDefault) e.preventDefault();
                sendGroup();
            }
        });
        var send = node('button', 'sms-send' + (String(grpDraft || '').replace(/\s/g, '') ? '' : ' off'));
        send.id = 'sms-send';
        send.type = 'button';
        send.setAttribute('title', 'Send');
        send.appendChild(sendGlyph());
        onTap(send, function (e) { e.stopPropagation(); sendGroup(); }, { silent: true });
        field.appendChild(at);
        field.appendChild(input);
        field.appendChild(send);
        compose.appendChild(field);
        wrap.appendChild(compose);
        grpRenderedKey = grpKey(data);
        // If the flex chain from #ph-screen down is not honoured, the page keeps its content
        // height and the composer floats up under the last message. Measuring the real screen
        // box and pinning the page to it works whatever the engine does with flex.
        setTimeout(function () {
            try {
                var host = document.getElementById('ph-screen') || document.getElementById('content');
                var h = host ? host.clientHeight : 0;
                if (h > 200) wrap.style.height = h + 'px';
                grpToBottom();
            } catch (e) {}
        }, 0);
        return wrap;
    }


    // ------------------------------------------------------------------
    // Group settings: rename, members, leaving. Reached from the "..." in the group header.
    // Only the creator manages the member list; anyone in a group can read it and leave.
    // ------------------------------------------------------------------
    function grpIsOwner(meta, meId) {
        return !!meta && !!meId && String(meta.owner) === String(meId);
    }

    function grpMetaOut(meta, patch) {
        var names = meta.memberNames || {};
        var out = {
            v: 1,
            id: meta.id,
            name: meta.name,
            owner: meta.owner,
            members: (meta.members || []).map(function (mid) { return { id: mid, name: names[mid] || mid }; }),
            auto: meta.auto !== false,
            createdAt: meta.createdAt || 0
        };
        if (patch) for (var k in patch) if (patch.hasOwnProperty(k)) out[k] = patch[k];
        return out;
    }

    // The summary the list page reads is a copy of meta: keep the two together.
    function syncGroupList(id, name, members, closed) {
        return loadGroupIndex().then(function (list) {
            var groups = (list || []).filter(function (g) { return g.id !== id; });
            if (!closed) groups.push({ id: id, name: name, members: members || [] });
            return saveJson('list', { v: 1, groups: groups }, SMS_G_SECTION);
        });
    }

    function saveGroupMeta(meta, patch) {
        var out = grpMetaOut(meta, patch);
        return saveJson('meta', out, grpSection(meta.id)).then(function () {
            return syncGroupList(meta.id,
                out.name,
                out.members.map(function (m) { return m.id; }),
                out.closed);
        });
    }

    function renameGroup(id, name) {
        if (grpNameBusy) return;
        var clean = String(name || '').replace(/^\s+|\s+$/g, '').slice(0, 20);
        if (!clean) { setNote('The name cannot be empty.', true); return; }
        grpNameBusy = true;
        loadGroupMeta(id).then(function (meta) {
            if (!meta) throw new Error('This group is gone.');
            return saveGroupMeta(meta, { name: clean });
        }).then(function () {
            grpNameBusy = false;
            grpNameDraft = '';
            grpMenuOpen = false;
            grpRenderedKey = '';
            grpShown = null;
            setNote('', false);
            // Straight back to the conversation, redrawn even though no message changed.
            if (current === 'group') refresh();
            else open('group');
        }, function (err) {
            grpNameBusy = false;
            setNote(errText(err), true);
        });
    }

    // The creator leaving ends the group for everyone; a member leaving only removes themselves.
    function leaveGroup(id, meId) {
        loadGroupMeta(id).then(function (meta) {
            if (!meta) { open('texts'); return; }
            if (grpIsOwner(meta, meId)) return saveGroupMeta(meta, { closed: true });
            var rest = meta.members.filter(function (mid) { return String(mid) !== String(meId); });
            if (!rest.length) return saveGroupMeta(meta, { closed: true });
            meta.memberNames = meta.memberNames || {};
            return saveGroupMeta(meta, { members: rest.map(function (mid) { return { id: mid, name: meta.memberNames[mid] || mid }; }) });
        }).then(function () {
            grpMenuOpen = false;
            setNote('', false);
            open('texts');
        }, function (err) { setNote(errText(err), true); });
    }

    function removeMember(id, memberId) {
        if (grpMembersBusy) return;
        grpMembersBusy = true;
        loadGroupMeta(id).then(function (meta) {
            if (!meta) throw new Error('This group is gone.');
            var rest = meta.members.filter(function (mid) { return String(mid) !== String(memberId); });
            var names = meta.memberNames || {};
            return saveGroupMeta(meta, { members: rest.map(function (mid) { return { id: mid, name: names[mid] || mid }; }) });
        }).then(function () {
            grpMembersBusy = false;
            refresh();
        }, function (err) { grpMembersBusy = false; setNote(errText(err), true); });
    }

    function addMember(id, memberId, members) {
        if (grpMembersBusy) return;
        grpMembersBusy = true;
        loadGroupMeta(id).then(function (meta) {
            if (!meta) throw new Error('This group is gone.');
            if (meta.members.indexOf(String(memberId)) >= 0) return null;
            if (meta.members.length >= SMS_G_MAX) throw new Error('Up to ' + SMS_G_MAX + ' people.');
            var m = memberById(members || [], memberId);
            var name = m ? (m.first_name || fullName(m)) : String(memberId);
            var list = meta.members.concat([String(memberId)]);
            var out = list.map(function (mid) { return { id: mid, name: mid === String(memberId) ? name : (meta.memberNames[mid] || mid) }; });
            return saveGroupMeta(meta, { members: out });
        }).then(function () {
            grpMembersBusy = false;
            grpAddOpen = false;
            refresh();
        }, function (err) { grpMembersBusy = false; setNote(errText(err), true); });
    }

    function loadGroupMembers() {
        return Promise.all([getEnv(), getPossessedId(), getMembers(), loadPortraitIndex(), loadGroupMeta(grpId), loadOutside()]).then(function (r) {
            grpKnown = grpPeople(r[2]);
            if (r[4]) grpHealNames(r[4]);
            return { env: r[0], meId: String(r[1]), members: grpKnown, household: r[2], meta: r[4] };
        });
    }

    function renderGroupMembers(data) {
        var wrap = node('div', 'ph-page');
        wrap.appendChild(subHeader('groupMembers', 'Members'));
        if (!data.meta) {
            var gone = card();
            gone.appendChild(node('div', 'ph-empty', 'This group is gone.'));
            wrap.appendChild(gone);
            return wrap;
        }
        var owner = grpIsOwner(data.meta, data.meId);
        var listCard = card();
        data.meta.members.forEach(function (mid) {
            var m = memberById(data.members || [], mid);
            var row = node('div', 'sms-pick');
            if (m) row.appendChild(faceAvatar(m));
            else row.appendChild(node('div', 'ph-avatar sms-gface-blank'));
            var who = node('div', 'sms-pick-name', data.meta.memberNames[mid] || (m ? fullName(m) : String(mid)));
            row.appendChild(who);
            if (String(mid) === String(data.meta.owner)) row.appendChild(node('div', 'sms-tag', 'Creator'));
            if (owner) {
                var x = node('button', 'sms-pick-x', '\u00D7');
                x.type = 'button';
                x.setAttribute('title', 'Remove from group');
                onTap(x, function (e) { e.stopPropagation(); removeMember(data.meta.id, mid); }, { silent: true });
                row.appendChild(x);
            }
            listCard.appendChild(row);
        });
        wrap.appendChild(listCard);

        if (owner) {
            var add = node('button', 'ph-btn sms-gcreate', grpAddOpen ? 'Done' : 'Add people');
            add.type = 'button';
            onTap(add, function (e) { e.stopPropagation(); grpAddOpen = !grpAddOpen; refresh(); }, { silent: true });
            wrap.appendChild(add);
            if (grpAddOpen) {
                var poolCard = card();
                var any = 0;
                (data.household || data.members || []).forEach(function (m) {
                    var id = String(m.entity_id);
                    if (id === String(data.meId)) return;
                    if (data.meta.members.indexOf(id) >= 0) return;
                    if (NO_PHONE_STEPS[m.age_group]) return;
                    any += 1;
                    var row = node('div', 'sms-pick');
                    row.appendChild(faceAvatar(m));
                    row.appendChild(node('div', 'sms-pick-name', fullName(m)));
                    row.appendChild(node('div', 'sms-pick-plus', '+'));
                    onTap(row, function (e) { e.stopPropagation(); addMember(data.meta.id, id, data.members); });
                    poolCard.appendChild(row);
                });
                if (!any) poolCard.appendChild(node('div', 'ph-empty', 'Everyone in the house is already in.'));
                wrap.appendChild(poolCard);
            }
        }
        var leave = node('button', 'ph-btn sms-gleave', owner ? 'Disband group' : 'Leave group');
        leave.type = 'button';
        onTap(leave, function (e) { e.stopPropagation(); leaveGroup(data.meta.id, data.meId); }, { silent: true });
        wrap.appendChild(leave);
        return wrap;
    }

    function loadGroupName() {
        return Promise.all([getEnv(), loadGroupMeta(grpId)]).then(function (r) {
            return { env: r[0], meta: r[1] };
        });
    }

    function renderGroupName(data) {
        var wrap = node('div', 'ph-page');
        wrap.appendChild(subHeader('groupName', 'Group Name'));
        if (!data.meta) {
            var gone = card();
            gone.appendChild(node('div', 'ph-empty', 'This group is gone.'));
            wrap.appendChild(gone);
            return wrap;
        }
        var c = card();
        // A textarea, not an input: the chat box is a textarea and it is the one field in this
        // phone that reliably takes Latin letters and digits. An <input> here only ever got
        // text through the input method.
        var field = node('textarea', 'sms-gname');
        field.setAttribute('placeholder', 'Group name');
        field.setAttribute('maxlength', '20');
        field.setAttribute('rows', '1');
        field.value = grpNameDraft || data.meta.name;
        applyUiFont(field);
        field.addEventListener('input', function () { grpNameDraft = field.value; });
        c.appendChild(field);
        wrap.appendChild(c);
        var save = node('button', 'ph-btn sms-gcreate', 'Save');
        save.type = 'button';
        onTap(save, function (e) {
            e.stopPropagation();
            var box = document.querySelector('.sms-gname');
            renameGroup(data.meta.id, box ? box.value : grpNameDraft);
        }, { silent: true });
        wrap.appendChild(save);
        return wrap;
    }

    // The "..." sheet over an open group.
    // Removes the open sheet. Nothing is reloaded: the sheet is only a layer over the page.
    function grpHideMenuSheet() {
        var veil = document.getElementById('sms-sheet-wrap');
        if (veil && veil.parentNode) veil.parentNode.removeChild(veil);
    }

    // Puts the sheet on the page that is already there. Opening the menu used to go through a
    // full reload of the thread, which took seconds and left the poll frozen while it was open.
    function grpOpenMenu(data) {
        if (document.getElementById('sms-sheet-wrap')) return;
        var wrap = document.querySelector('.sms');
        if (!wrap || !data || !data.meta) return;
        var veil = grpMenuSheet(data);
        veil.id = 'sms-sheet-wrap';
        wrap.appendChild(veil);
    }

    function grpMenuSheet(data) {
        var veil = node('div', 'sms-sheet-veil');
        onTap(veil, function (e) { e.stopPropagation(); grpHideMenuSheet(); });
        var sheet = node('div', 'sms-sheet');
        sheet.id = 'sms-sheet';
        var owner = grpIsOwner(data.meta, data.meId);
        function item(label, danger, action) {
            var row = node('div', 'sms-sheet-item' + (danger ? ' danger' : ''), label);
            onTap(row, function (e) {
                e.stopPropagation();
                grpHideMenuSheet();
                action();
            });
            sheet.appendChild(row);
        }
        if (owner) item('Group Name', false, function () { grpNameDraft = data.meta.name; open('groupName'); });
        item('Members', false, function () { grpAddOpen = false; open('groupMembers'); });
        if (owner) item('Manage Members', false, function () { grpAddOpen = true; open('groupMembers'); });
        item(owner ? 'Disband Group' : 'Leave Group', true, function () { leaveGroup(data.meta.id, data.meId); });
        var cancel = node('div', 'sms-sheet-cancel', 'Cancel');
        onTap(cancel, function (e) { e.stopPropagation(); grpHideMenuSheet(); });
        sheet.appendChild(cancel);
        // In the corner, small: which build the phone is actually running.
        sheet.appendChild(node('div', 'sms-sheet-build', 'Build ' + SMS_BUILD));
        veil.appendChild(sheet);
        return veil;
    }

    function grpHideMention() {
        var panel = document.getElementById('sms-mention-panel');
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
        grpMentionOpen = false;
    }

    function grpPickMention(data) {
        if (grpMentionOpen) { grpHideMention(); return; }
        grpMentionOpen = true;
        var old = document.getElementById('sms-mention-panel');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var box = node('div', 'sms-mention-panel');
        box.id = 'sms-mention-panel';
        data.meta.members.forEach(function (id) {
            var m = memberById(data.members || [], id);
            var row = node('div', 'sms-mention-row');
            if (m) row.appendChild(faceAvatar(m));
            row.appendChild(node('div', 'sms-pick-name', grpName(data.meta, id)));
            onTap(row, function (e) {
                e.stopPropagation();
                var field = document.getElementById('sms-box');
                // Replace the half-typed "@..." the list was opened for, instead of adding a
                // second @ in front of it. The fragment can be just "@" or "@永".
                var val = String(field ? field.value : grpDraft || '');
                var caret = field && field.selectionEnd !== undefined && field.selectionEnd !== null ? field.selectionEnd : val.length;
                var head = val.slice(0, caret);
                var at = head.lastIndexOf('@');
                var before = at >= 0 ? val.slice(0, at) : val;
                var after = at >= 0 ? val.slice(caret) : '';
                var next = (before + '@' + grpName(data.meta, id) + ' ' + after).slice(0, SMS_G_TEXT_MAX);
                grpMention = { id: id, name: grpName(data.meta, id) };
                grpDraft = next;
                // Written straight into the box: a refresh() here would run rememberGroup() first,
                // which copies the old box text back over the mention.
                if (field) {
                    field.value = next;
                    try { fitSmsBox(field); } catch (err) {}
                }
                if (box.parentNode) box.parentNode.removeChild(box);
                grpMentionOpen = false;
                syncSendButton();
            });
            box.appendChild(row);
        });
        var compose = document.querySelector('.sms-compose');
        if (compose) compose.appendChild(box);
    }

    // The same chevron as a one-to-one thread, but it pins grpStick: the one-to-one button
    // sets smsStick, which this page never reads.
    function grpJumpButton() {
        var b = node('button', 'sms-jump' + (grpStick ? '' : ' show'));
        b.id = 'sms-jump';
        b.type = 'button';
        b.setAttribute('title', 'Latest');
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'sms-jump-glyph');
        glyphPath(svg, 'M5.3 8.6a1.1 1.1 0 0 1 1.6 0L12 13.7l5.1-5.1a1.1 1.1 0 1 1 1.6 1.6l-5.9 5.9a1.1 1.1 0 0 1-1.6 0L5.3 10.2a1.1 1.1 0 0 1 0-1.6z', '#ffffff');
        b.appendChild(svg);
        onTap(b, function (e) {
            e.stopPropagation();
            var log = document.getElementById('sms-log');
            if (!log) return;
            grpStick = true;
            b.className = 'sms-jump';
            rideSmsLog(log, Math.max(0, log.scrollHeight - log.clientHeight - log.scrollTop));
            setTimeout(grpToBottom, 400);
        });
        return b;
    }

    // Shows the chevron once the reader is a screen above the newest line.
    function grpJumpSync(log) {
        var b = document.getElementById('sms-jump');
        if (!b || !log) return;
        if (smsScrollRide && !smsScrollRide.dead) return;
        var up = log.scrollHeight - log.scrollTop - log.clientHeight > SMS_JUMP_PX;
        var want = up ? 'sms-jump show' : 'sms-jump';
        if (b.className !== want) b.className = want;
    }

    function rememberGroup() {
        var box = document.getElementById('sms-box');
        var log = document.getElementById('sms-log');
        if (box) { grpDraft = box.value; grpFocused = false; }
        if (log) {
            if (Date.now() >= grpPinnedUntil) {
                grpStick = (log.scrollHeight - log.scrollTop - log.clientHeight) < 48;
                grpScroll = log.scrollTop;
            }
        }
    }

    // The page has just been rebuilt: at this moment the log has no height yet, so a single
    // scrollTop = scrollHeight lands on 0 — the top. The one-to-one chat jumps again over the
    // next few frames for exactly this reason, and so does this.
    // Delays after which the log is pushed to the newest line. The engine lays out asynchronously:
    // one attempt on the same tick lands while the log still has no height.
    var GRP_SCROLL_TRIES = [0, 60, 160, 320, 600, 1000, 1600];

    function grpToBottom() {
        var log = document.getElementById('sms-log');
        if (!log) return;
        if (current !== 'group') return;
        if (!grpStick && Date.now() >= grpPinnedUntil) { log.style.opacity = '1'; return; }
        var max = log.scrollHeight - log.clientHeight;
        // Nothing has been laid out yet: leave it hidden and let the next attempt try again.
        if (max < 2) return;
        if (max - log.scrollTop < 2) { log.style.opacity = '1'; return; }
        log.scrollTop = log.scrollHeight;
        log.style.opacity = '1';
    }


    function restoreGroup() {
        var box = document.getElementById('sms-box');
        var log = document.getElementById('sms-log');
        if (box && box.value !== grpDraft) box.value = grpDraft;
        if (box) {
            try { fitSmsBox(box); } catch (e) {}
            syncSendButton();
            if (document.activeElement === box) { try { box.blur(); } catch (e) {} }
        }
        if (!log) return;
        if (grpStick) {
            log.scrollTop = log.scrollHeight;
            for (var i = 0; i < GRP_SCROLL_TRIES.length; i++) setTimeout(grpToBottom, GRP_SCROLL_TRIES[i]);
            setTimeout(function () {
                var l = document.getElementById('sms-log');
                if (l && l.style.opacity === '0') l.style.opacity = '1';
            }, 1500);
        } else {
            log.scrollTop = grpScroll;
        }
    }

    function sendGroup() {
        if (grpSending || !grpId) return;
        var box = document.getElementById('sms-box');
        var body = String(box ? box.value : grpDraft || '').replace(/^\s+|\s+$/g, '');
        if (!body) return;
        if (body.length > SMS_G_TEXT_MAX) { setNote('Keep it under ' + SMS_G_TEXT_MAX + ' characters.', true); return; }
        var section = grpSection(grpId);
        var mention = grpMention;
        var reply = grpReply;
        grpSending = true;
        // The box is emptied here, exactly as a one-to-one send does. Only clearing grpDraft
        // would not hold: the next refresh runs rememberGroup(), which copies whatever is still
        // in the textarea back over it, and the "sent" line reappears in the field.
        grpDraft = '';
        if (box) {
            box.value = '';
            try { fitSmsBox(box); } catch (e) {}
            if (document.activeElement === box) { try { box.blur(); } catch (e) {} }
        }
        try { syncSendButton(); } catch (e) {}
        // Raw read: cleanList (made for one-to-one threads) drops from/mentions/replyTo, and
        // writing the list back would strip them from every earlier line — which turned an older
        // character's message into the current player's own.
        Promise.all([loadGroupBox('outbox', section), soft(getEnv())]).then(function (r) {
            var list = r[0];
            var msg = { id: 'w-' + Date.now() + '-' + (grpSeq += 1), text: body, at: Date.now() };
            if (grpMeId) msg.from = grpMeId;
            if (mention) msg.mentions = [mention.id];
            if (reply) msg.replyTo = reply.id;
            var game = smsGameOf(r[1]);
            if (game) msg.game = game;
            list.push(msg);
            if (list.length > SMS_G_KEEP) list = list.slice(list.length - SMS_G_KEEP);
            return saveJson('outbox', list, section);
        }).then(function () {
            soundPlay('sent');
            grpReply = null;
            grpSyncReplyBar();
            grpMention = null;
            grpMentionOpen = false;
            grpComposing = false;
            grpRenderedKey = '';
            grpStick = true;
            setNote('', false);
            refresh();
        }, function (err) {
            // Put the line back so it is not lost, the way a failed one-to-one send does.
            grpDraft = body;
            if (box) {
                box.value = body;
                try { fitSmsBox(box); } catch (e) {}
            }
            setNote(errText(err), true);
        }).then(function () { grpSending = false; });
    }

    // ------------------------------------------------------------------
    // Persona: how the open contact talks, edited from the chat header.
    // Only the character setting is here. The reply rules stay with the reply service.
    // ------------------------------------------------------------------
    var personaDraft = null;
    var personaRenderedKey = '';
    var personaSaving = false;
    var personaNote = null;

    function personaSection(id) { return PERSONA_SECTION + '/' + id; }

    function personaKey(data) {
        return data.contact ? String(data.contact.entity_id) + '|' + data.meId : '';
    }

    function loadPersona() {
        return Promise.all([getEnv(), getPossessedId(), getMembers(), loadPortraitIndex()]).then(function (r) {
            var meId = String(r[1]);
            var contact = null;
            var contacts = textContacts(meId, r[2]);
            for (var i = 0; i < contacts.length; i++) {
                if (String(contacts[i].entity_id) === String(smsContactId)) contact = contacts[i];
            }
            if (!contact) return { env: r[0], meId: meId, contact: null };
            var section = personaSection(contact.entity_id);
            return Promise.all([cfgValue(section, 'default'), cfgValue(section, 'profile')]).then(function (d) {
                return { env: r[0], meId: meId, contact: contact, def: d[0], profile: d[1], portraitRev: portraitRev };
            });
        });
    }

    // What the reply service would use when nothing is set.
    function personaDefaults(data) {
        var def = data.def && typeof data.def === 'object' ? data.def : {};
        var styles = def.styles && typeof def.styles === 'object' ? def.styles : {};
        var mine = styles[data.meId] && typeof styles[data.meId] === 'object' ? styles[data.meId] : null;
        return {
            known: !!mine,
            style: mine && typeof mine.text === 'string' ? mine.text : '',
            extra: typeof def.extra === 'string' ? def.extra : ''
        };
    }

    function personaSaved(data) {
        var p = data.profile && typeof data.profile === 'object' ? data.profile : {};
        var styles = p.styles && typeof p.styles === 'object' ? p.styles : {};
        return {
            style: typeof styles[data.meId] === 'string' ? styles[data.meId] : null,
            extra: typeof p.extra === 'string' ? p.extra : null
        };
    }

    function personaRenderKey(data) {
        return personaKey(data) + '|' + JSON.stringify(data.def || null) + '|' + JSON.stringify(data.profile || null) +
            '|' + (data.portraitRev || 0);
    }

    function personaDraftFor(data) {
        var key = personaKey(data);
        if (personaDraft && personaDraft.key === key && personaDraft.dirty) return personaDraft;
        var def = personaDefaults(data);
        var saved = personaSaved(data);
        personaDraft = {
            key: key,
            style: saved.style !== null ? saved.style : def.style,
            extra: saved.extra !== null ? saved.extra : def.extra,
            dirty: false
        };
        return personaDraft;
    }

    function personaCount(id, text, max) {
        var c = document.getElementById(id);
        if (c) c.textContent = String(text || '').length + ' / ' + max;
    }

    function personaSyncButtons() {
        var d = personaDraft;
        var save = document.getElementById('pe-save');
        if (save) save.className = 'ph-btn ' + (d && d.dirty && !personaSaving ? 'on' : 'off') + ' last';
        if (!d || !d.def) return;
        var rs = document.getElementById('pe-style-reset');
        if (rs) rs.className = 'pe-reset' + (d.def.known && d.style !== d.def.style ? '' : ' off');
        var re = document.getElementById('pe-extra-reset');
        if (re) re.className = 'pe-reset' + (d.extra !== d.def.extra ? '' : ' off');
    }

    function personaField(id, value, max, rows, placeholder, onInput) {
        var f = node('textarea', 'pe-text');
        f.id = id;
        applyUiFont(f);
        f.setAttribute('maxlength', String(max));
        f.setAttribute('rows', String(rows));
        f.setAttribute('spellcheck', 'false');
        f.setAttribute('placeholder', placeholder);
        f.value = value || '';
        f.addEventListener('input', function () { onInput(f.value); });
        return f;
    }

    function personaSave(data) {
        if (!personaDraft || !personaDraft.dirty || personaSaving) return;
        var draft = personaDraft;
        var id = String(data.contact.entity_id);
        var meId = data.meId;
        var def = personaDefaults(data);
        var section = personaSection(id);
        personaSaving = true;
        personaNote = null;
        personaSyncButtons();
        // Read again right before writing: the same character may have been edited while
        // playing someone else, and that setting must survive.
        cfgValue(section, 'profile').then(function (cur) {
            var next = { v: 1, at: Date.now(), extra: null, styles: {} };
            if (cur && typeof cur === 'object') {
                if (typeof cur.extra === 'string') next.extra = cur.extra;
                if (cur.styles && typeof cur.styles === 'object') {
                    for (var k in cur.styles) {
                        if (cur.styles.hasOwnProperty(k) && typeof cur.styles[k] === 'string') next.styles[k] = cur.styles[k];
                    }
                }
            }
            var style = String(draft.style || '').replace(/\r\n?/g, '\n').slice(0, PERSONA_STYLE_MAX);
            var extra = String(draft.extra || '').replace(/\r\n?/g, '\n').slice(0, PERSONA_EXTRA_MAX);
            if (def.known && style === def.style) delete next.styles[meId];
            else next.styles[meId] = style;
            next.extra = extra === def.extra ? null : extra;
            return saveJson('profile', next, section);
        }).then(function () {
            personaDraft = null;
            personaNote = { ok: true, text: 'Saved. The next reply uses it.' };
        }, function (err) {
            personaNote = { ok: false, text: 'Could not save: ' + errText(err) };
        }).then(function () {
            personaSaving = false;
            personaRenderedKey = '';
            refresh();
        });
    }

    function renderPersona(data) {
        var wrap = node('div', 'pe');
        wrap.id = 'pe-screen';
        wrap.appendChild(subHeader('persona'));
        if (!data.contact) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'This person can no longer be texted.'));
            wrap.appendChild(none);
            personaRenderedKey = '';
            return wrap;
        }
        var c = data.contact;
        var first = c.first_name || fullName(c);
        var def = personaDefaults(data);
        var draft = personaDraftFor(data);
        draft.def = def;

        var who = node('div', 'pe-who');
        who.appendChild(faceAvatar(c));
        var whoText = node('div', 'ph-who');
        whoText.appendChild(node('div', 'ph-name', fullName(c)));
        whoText.appendChild(node('div', 'ph-sub', c.relationship_label || c.age_group_text || ''));
        who.appendChild(whoText);
        wrap.appendChild(who);

        var styleCard = card('HOW ' + first.toUpperCase() + ' TALKS TO YOU');
        styleCard.appendChild(personaField('pe-style', draft.style, PERSONA_STYLE_MAX, 9,
            'Tone, words they use, how they react when scolded...', function (v) {
                draft.style = v;
                draft.dirty = true;
                personaNote = null;
                personaCount('pe-style-n', v, PERSONA_STYLE_MAX);
                personaSyncButtons();
            }));
        var styleFoot = node('div', 'pe-foot');
        var styleN = node('div', 'pe-count', String(draft.style || '').length + ' / ' + PERSONA_STYLE_MAX);
        styleN.id = 'pe-style-n';
        styleFoot.appendChild(styleN);
        var styleReset = node('button', 'pe-reset' + (def.known && draft.style !== def.style ? '' : ' off'), 'Use default');
        styleReset.id = 'pe-style-reset';
        styleReset.setAttribute('type', 'button');
        onTap(styleReset, function (e) {
            e.stopPropagation();
            if (!def.known || draft.style === def.style) return;
            draft.style = def.style;
            draft.dirty = true;
            personaNote = null;
            personaRenderedKey = '';
            settingsKeep(function () { show(renderPersona(data)); });
        });
        styleFoot.appendChild(styleReset);
        styleCard.appendChild(styleFoot);
        styleCard.appendChild(node('div', 'ai-hint', def.known
            ? (def.style ? 'Only with the person you are playing now. Leave it empty for no set style.'
                : 'There is no built-in style for this relationship. Anything you write here is used as is.')
            : 'The reply service has not shared the built-in style yet. Start it, then come back.'));
        wrap.appendChild(styleCard);

        var extraCard = card('ABOUT ' + first.toUpperCase());
        extraCard.appendChild(personaField('pe-extra', draft.extra, PERSONA_EXTRA_MAX, 5,
            'Background, habits, secrets, what they care about...', function (v) {
                draft.extra = v;
                draft.dirty = true;
                personaNote = null;
                personaCount('pe-extra-n', v, PERSONA_EXTRA_MAX);
                personaSyncButtons();
            }));
        var extraFoot = node('div', 'pe-foot');
        var extraN = node('div', 'pe-count', String(draft.extra || '').length + ' / ' + PERSONA_EXTRA_MAX);
        extraN.id = 'pe-extra-n';
        extraFoot.appendChild(extraN);
        var extraReset = node('button', 'pe-reset' + (draft.extra !== def.extra ? '' : ' off'), 'Use default');
        extraReset.id = 'pe-extra-reset';
        extraReset.setAttribute('type', 'button');
        onTap(extraReset, function (e) {
            e.stopPropagation();
            if (draft.extra === def.extra) return;
            draft.extra = def.extra;
            draft.dirty = true;
            personaNote = null;
            personaRenderedKey = '';
            settingsKeep(function () { show(renderPersona(data)); });
        });
        extraFoot.appendChild(extraReset);
        extraCard.appendChild(extraFoot);
        extraCard.appendChild(node('div', 'ai-hint', 'Used in every chat with ' + first + ', and in Moments.'));
        wrap.appendChild(extraCard);

        var actions = card();
        var btns = node('div', 'ph-btns');
        btns.style.marginTop = '0';
        var save = node('button', 'ph-btn ' + (draft.dirty && !personaSaving ? 'on' : 'off') + ' last', personaSaving ? 'Saving...' : 'Save');
        save.id = 'pe-save';
        save.setAttribute('type', 'button');
        onTap(save, function (e) {
            e.stopPropagation();
            personaSave(data);
        });
        btns.appendChild(save);
        actions.appendChild(btns);
        if (personaNote) actions.appendChild(node('div', 'ai-result ' + (personaNote.ok ? 'ok' : 'err'), personaNote.text));
        actions.appendChild(node('div', 'ai-hint', 'This changes who ' + first + ' is and how they talk. What they can do in the game, and how replies are written, stay the same.'));
        wrap.appendChild(actions);
        personaRenderedKey = personaRenderKey(data);
        return wrap;
    }

    // Redraws the open page without losing its scroll position.
    function settingsKeep(draw) {
        var top = wf.content.scrollTop;
        draw();
        wf.content.scrollTop = top;
    }

    // ------------------------------------------------------------------
    // Moments. feed.cfg is written by the reply service; this phone only appends the
    // played character's actions to its own outbox and shows them until they are merged.
    // ------------------------------------------------------------------
    function momentsViewerSection(meId) { return MOMENTS_SECTION + '/' + meId; }

    function cfgValue(section, key) {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: section, key: key }, 'value')
            .then(function (r) { return parseJson(r.value); }, function () { return null; });
    }

    function loadPortraitIndex() {
        return cachedRead('portraits', 4000, function () {
            return cfgValue(PORTRAIT_SECTION, 'index').then(function (v) {
                portraitIndex = v && v.files && typeof v.files === 'object' ? v.files : {};
                portraitRev = v && typeof v.updatedAt === 'number' ? v.updatedAt : 0;
                return portraitRev;
            }, function () {
                portraitIndex = {};
                portraitRev = 0;
                return 0;
            });
        });
    }

    // The last readable feed is kept, so a read that races the service's save shows old data
    // for one refresh instead of an empty page.
    function loadFeed() {
        return cfgValue(MOMENTS_SECTION, 'feed').then(function (v) {
            if (v && typeof v === 'object' && Array.isArray(v.posts)) momentsFeed = v;
            return momentsFeed;
        });
    }

    function cleanActions(raw) {
        if (!Array.isArray(raw)) return [];
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var a = raw[i];
            if (a && typeof a.id === 'string' && typeof a.kind === 'string' && typeof a.at === 'number') out.push(a);
        }
        return out;
    }

    function loadMomentsOutbox(meId) {
        return cfgValue(momentsViewerSection(meId), 'outbox').then(cleanActions);
    }

    function loadMomentsSeen(meId) {
        return cfgValue(momentsViewerSection(meId), 'seen').then(function (v) {
            return v && typeof v.at === 'number' ? v.at : 0;
        });
    }

    function copyPost(p) {
        var likes = [];
        var comments = [];
        var i;
        for (i = 0; i < (p.likes || []).length; i++) likes.push(p.likes[i]);
        for (i = 0; i < (p.comments || []).length; i++) comments.push(p.comments[i]);
        return {
            id: p.id, authorId: String(p.authorId), authorName: p.authorName || '', authorFirst: p.authorFirst || '',
            at: p.at, place: p.place || '', text: p.text, likes: likes, comments: comments, pending: !!p.pending,
            game: smsGameClean(p.game), gameTime: p.gameTime || ''
        };
    }

    function findById(list, id) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return list[i];
        }
        return null;
    }

    // Mirrors Moments.apply() in the reply service, so an action looks the same before and
    // after it has been merged into the feed.
    function applyPending(posts, me, a) {
        var post;
        var i;
        if (a.kind === 'post') {
            posts.push({ id: 'u-' + a.id, authorId: me.id, authorName: me.name, authorFirst: me.first, at: a.at, place: '', text: a.text || '', likes: [], comments: [], pending: true, game: smsGameClean(a.game) });
            return;
        }
        post = findById(posts, String(a.postId));
        if (!post) return;
        if (a.kind === 'like') {
            var has = false;
            for (i = 0; i < post.likes.length; i++) if (String(post.likes[i].id) === me.id) has = true;
            if (!has) post.likes.push({ id: me.id, name: me.name, at: a.at, pending: true });
        } else if (a.kind === 'unlike') {
            post.likes = post.likes.filter(function (l) { return String(l.id) !== me.id; });
        } else if (a.kind === 'delete') {
            if (post.authorId === me.id) {
                for (i = 0; i < posts.length; i++) {
                    if (posts[i] === post) { posts.splice(i, 1); break; }
                }
            }
        } else if (a.kind === 'comment') {
            var c = { id: 'u-' + a.id, authorId: me.id, authorName: me.name, text: a.text || '', at: a.at, pending: true };
            var target = a.replyToCommentId ? findById(post.comments, String(a.replyToCommentId)) : null;
            if (target && String(target.authorId) !== me.id) c.replyTo = { id: String(target.authorId), name: target.authorName, commentId: target.id };
            post.comments.push(c);
        }
    }

    // What the played character can see: posts, likes and comments of people it knows.
    function momentsView(feed, outbox, me) {
        var f = feed || { posts: [], circles: {}, applied: {} };
        var circleRow = f.circles ? f.circles[me.id] : null;
        var known = {};
        var names = {};
        var i;
        if (circleRow && circleRow.ids) {
            for (i = 0; i < circleRow.ids.length; i++) known[String(circleRow.ids[i])] = true;
            names = circleRow.names || {};
        }
        known[me.id] = true;
        var posts = [];
        for (i = 0; i < (f.posts || []).length; i++) posts.push(copyPost(f.posts[i]));
        var applied = {};
        var done = f.applied && f.applied[me.id] ? f.applied[me.id] : [];
        for (i = 0; i < done.length; i++) applied[done[i]] = true;
        var pending = outbox.filter(function (a) { return !applied[a.id]; }).sort(function (a, b) { return a.at - b.at; });
        for (i = 0; i < pending.length; i++) applyPending(posts, me, pending[i]);
        var visible = [];
        for (i = 0; i < posts.length; i++) {
            var p = posts[i];
            if (!known[p.authorId]) continue;
            p.likes = p.likes.filter(function (l) { return known[String(l.id)]; });
            p.comments = p.comments.filter(function (c) { return known[String(c.authorId)]; });
            visible.push(p);
        }
        visible.sort(function (a, b) { return b.at - a.at; });
        return { posts: visible, circleKnown: !!circleRow, names: names, pending: pending.length };
    }

    // Things meant for the viewer since seenAt: friends' posts, and likes, comments and replies
    // on the viewer's own posts or comments.
    function momentsNews(view, meId, seenAt) {
        var n = 0;
        var newest = 0;
        for (var i = 0; i < view.posts.length; i++) {
            var p = view.posts[i];
            var mine = p.authorId === meId;
            if (p.at > newest) newest = p.at;
            if (!mine && p.at > seenAt) n += 1;
            var j;
            for (j = 0; j < p.likes.length; j++) {
                var l = p.likes[j];
                if (typeof l.at === 'number' && l.at > newest) newest = l.at;
                if (mine && String(l.id) !== meId && l.at > seenAt) n += 1;
            }
            for (j = 0; j < p.comments.length; j++) {
                var c = p.comments[j];
                if (c.at > newest) newest = c.at;
                if (String(c.authorId) === meId || c.at <= seenAt) continue;
                if (mine || (c.replyTo && String(c.replyTo.id) === meId)) n += 1;
            }
        }
        return { count: n, newest: newest };
    }

    function momentsMe(meId, members) {
        var m = memberById(members, meId);
        if (m) return Promise.resolve({ id: meId, name: fullName(m), first: m.first_name || '' });
        return soft(call('entity.get_character_info', { entity_id: meId }, 'entity_id')).then(function (info) {
            var ok = info && !info.error;
            return { id: meId, name: ok ? fullName(info) : '#' + meId, first: ok ? info.first_name || '' : '' };
        });
    }

    function momentsUnread(meId) {
        return Promise.all([loadFeed(), loadMomentsOutbox(meId), loadMomentsSeen(meId)]).then(function (d) {
            if (!d[0]) return 0;
            var view = momentsView(d[0], d[1], { id: meId, name: '', first: '' });
            return momentsNews(view, meId, d[2]).count;
        }, function () { return 0; });
    }

    function momentsKey(view, status) {
        var parts = [view.circleKnown ? 'c' : 'n', momentsPresence(status).cls];
        for (var i = 0; i < view.posts.length; i++) {
            var p = view.posts[i];
            var s = p.id + (p.pending ? '*' : '') + ':' + p.likes.length;
            for (var j = 0; j < p.likes.length; j++) s += ',' + p.likes[j].id;
            for (j = 0; j < p.comments.length; j++) s += ';' + p.comments[j].id + (p.comments[j].pending ? '*' : '');
            parts.push(s);
        }
        return parts.join('|');
    }

    function momentsPresence(status) {
        if (!status || typeof status.heartbeat !== 'number' || Date.now() - status.heartbeat > BRIDGE_STALE_MS) {
            return { cls: 'off', text: 'Reply service offline: friends cannot post or answer right now.' };
        }
        if (status.state === 'paused' || status.state === 'offline') return { cls: 'off', text: status.error || 'Paused' };
        if (status.state === 'error') return { cls: 'err', text: status.error || 'Reply service error' };
        return { cls: 'on', text: '' };
    }

    function loadMoments() {
        return Promise.all([getEnv(), getPossessedId(), soft(getMembers()), loadPortraitIndex(), loadEmojiSet()]).then(function (r) {
            var meId = String(r[1]);
            var members = r[2] && !r[2].error ? r[2] : [];
            return Promise.all([
                momentsMe(meId, members), loadFeed(), loadMomentsOutbox(meId), loadMomentsSeen(meId),
                cfgValue(MOMENTS_SECTION, 'status')
            ]).then(function (d) {
                var me = d[0];
                var view = momentsView(d[1], d[2], me);
                var news = momentsNews(view, meId, d[3]);
                var seenP = news.newest > d[3]
                    ? saveJson('seen', { at: news.newest }, momentsViewerSection(meId)).then(function () {}, function () {})
                    : Promise.resolve();
                return seenP.then(function () {
                    return { env: r[0], me: me, view: view, status: d[4], key: meId + '|' + momentsKey(view, d[4]), portraitRev: r[3] || 0 };
                });
            });
        });
    }

    function sendMomentsAction(me, action, done) {
        if (momentsSending) return;
        momentsSending = true;
        action.id = 'a-' + Date.now() + '-' + (momentsSeq += 1);
        action.at = Date.now();
        action.name = me.name;
        action.first = me.first;
        var section = momentsViewerSection(me.id);
        // The game clock when the player acted, so the feed can show it in game time.
        Promise.all([loadMomentsOutbox(me.id), soft(getEnv())]).then(function (r) {
            var list = r[0];
            var game = smsGameOf(r[1]);
            if (game) action.game = game;
            list.push(action);
            if (list.length > MOMENTS_KEEP) list = list.slice(list.length - MOMENTS_KEEP);
            return saveJson('outbox', list, section);
        }).then(function () {
            if (action.kind === 'post' || action.kind === 'comment') soundPlay('sent');
            if (done) done();
            momentsRenderedKey = '';
            setNote('', false);
            refresh();
        }, function (err) {
            setNote(errText(err), true);
        }).then(function () {
            momentsSending = false;
        });
    }

    function rememberMoments() {
        var post = document.getElementById('mo-post');
        var reply = document.getElementById('mo-reply');
        if (refreshDropping) {
            momentsPostDraft = '';
            momentsDraft = '';
            momentsFocus = null;
            return;
        }
        if (post) momentsPostDraft = post.value;
        if (reply) momentsDraft = reply.value;
        if (momentsFocusPending) return;
        momentsFocus = document.activeElement === post ? 'post' : document.activeElement === reply ? 'reply' : null;
    }

    function restoreMoments() {
        var id = momentsFocus === 'post' ? 'mo-post' : momentsFocus === 'reply' ? 'mo-reply' : '';
        var target = id ? document.getElementById(id) : null;
        var pending = momentsFocusPending;
        momentsFocusPending = false;
        momentsFocus = null;
        if (!target || !pending) return;
        try {
            target.focus();
            var len = target.value.length;
            if (target.setSelectionRange) target.setSelectionRange(len, len);
        } catch (e0) {}
    }

    var MO_HEART = 'M12 20.4s-6.6-4-8.8-7.7C1.5 9.6 2.2 6.2 4.9 5.1c1.8-.7 3.7-.1 4.9 1.6L12 8.8l2.2-2.1c1.2-1.7 3.1-2.3 4.9-1.6 2.7 1.1 3.4 4.5 1.7 7.6-2.2 3.7-8.8 7.7-8.8 7.7z';
    var MO_BUBBLE = 'M4.2 4.4h15.6c.9 0 1.6.7 1.6 1.6v8.2c0 .9-.7 1.6-1.6 1.6h-6.2L8.2 19.4c-.4.3-.9 0-.9-.5v-3.1H4.2c-.9 0-1.6-.7-1.6-1.6V6c0-.9.7-1.6 1.6-1.6z';
    var MO_PIN = 'M12 2.2c-3.5 0-6.3 2.8-6.3 6.3 0 4.7 6.3 12.8 6.3 12.8s6.3-8.1 6.3-12.8c0-3.5-2.8-6.3-6.3-6.3zm0 8.6c-1.3 0-2.3-1-2.3-2.3s1-2.3 2.3-2.3 2.3 1 2.3 2.3-1 2.3-2.3 2.3z';
    var MO_PENCIL = 'M3.6 16.6V20.4h3.8l11.2-11.2-3.8-3.8L3.6 16.6zM19.7 7.5c.4-.4.4-.9 0-1.3l-2-2c-.4-.4-.9-.4-1.3 0l-1.5 1.5 3.3 3.3 1.5-1.5z';

    function moIcon(d, extra, fill) {
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'mo-ico' + (extra ? ' ' + extra : ''));
        glyphPath(svg, d, fill || '#f5f5f7');
        return svg;
    }

    function momentsPerson(first, name, id) {
        return faceAvatar({ first_name: first || '', name: name || '', entity_id: id });
    }

    function momentsInput(id, cls, placeholder, value, max) {
        var t = node('textarea', cls);
        t.id = id;
        applyUiFont(t);
        t.setAttribute('maxlength', String(max));
        t.setAttribute('placeholder', placeholder);
        t.value = value || '';
        return t;
    }

    function momentsButton(text, cls, onClick) {
        var b = node('button', cls, text);
        b.setAttribute('type', 'button');
        onTap(b, function (e) {
            e.stopPropagation();
            onClick();
        });
        return b;
    }

    function openComposer() {
        momentsComposeOpen = true;
        momentsMenuPost = null;
        momentsConfirmDelete = null;
        momentsFocus = 'post';
        momentsFocusPending = true;
        momentsRenderedKey = '';
        refresh();
    }

    function closeComposer() {
        momentsComposeOpen = false;
        momentsFocus = null;
        momentsRenderedKey = '';
        refresh();
    }

    function toggleMenu(postId) {
        if (momentsMenuPost === postId) {
            momentsMenuPost = null;
            momentsConfirmDelete = null;
        } else {
            momentsMenuPost = postId;
            momentsConfirmDelete = null;
            if (momentsComposer && momentsComposer.postId === postId) {
                momentsComposer = null;
                momentsDraft = '';
                momentsFocus = null;
            }
        }
        momentsRenderedKey = '';
        refresh();
    }

    // Emoji for the Moments text boxes: [name] tokens like in Texts. momentsEmojiFor says which
    // box ('post' or 'reply') has its panel open; momentsCaret where each box's caret was.
    var momentsEmojiFor = null;
    var momentsCaret = {};

    function moFieldId(key) { return key === 'post' ? 'mo-post' : 'mo-reply'; }

    function moTrackCaret(input, key) {
        var keep = function () { momentsCaret[key] = input.selectionEnd; };
        input.addEventListener('keyup', keep);
        input.addEventListener('mouseup', keep);
        input.addEventListener('input', keep);
    }

    function moInsertEmoji(key, name, max, onChange) {
        var input = document.getElementById(moFieldId(key));
        if (!input) return;
        var token = '[' + name + ']';
        var value = input.value;
        if (value.length + token.length > max) return;
        var at = typeof momentsCaret[key] === 'number' && momentsCaret[key] <= value.length ? momentsCaret[key] : value.length;
        input.value = value.slice(0, at) + token + value.slice(at);
        momentsCaret[key] = at + token.length;
        onChange(input.value);
    }

    function moEmojiButton(key) {
        var b = node('button', 'mo-emoji-btn' + (momentsEmojiFor === key ? ' on' : ''));
        b.setAttribute('type', 'button');
        b.setAttribute('title', 'Emoji');
        if (emojiSet) b.appendChild(emojiImg(emojiSet.byName['微笑'] || emojiSet.list[0].id, ''));
        else b.style.display = 'none';
        onTap(b, function (e) {
            e.stopPropagation();
            momentsEmojiFor = momentsEmojiFor === key ? null : key;
            var panel = document.getElementById('mo-emoji-' + key);
            if (panel) panel.style.display = momentsEmojiFor === key ? '' : 'none';
            b.className = 'mo-emoji-btn' + (momentsEmojiFor === key ? ' on' : '');
        });
        return b;
    }

    function moEmojiPanel(key, max, onChange) {
        var panel = node('div', 'sms-emoji-panel mo-emoji-panel');
        panel.id = 'mo-emoji-' + key;
        if (momentsEmojiFor !== key) panel.style.display = 'none';
        (emojiSet ? emojiSet.list : []).forEach(function (e) {
            var cell = node('div', 'sms-emoji-pick');
            cell.setAttribute('title', e.name);
            cell.appendChild(emojiImg(e.id, e.name));
            onTap(cell, function (ev) {
                ev.stopPropagation();
                moInsertEmoji(key, e.name, max, onChange);
            }, { silent: true });
            panel.appendChild(cell);
        });
        return panel;
    }

    function renderComposer(data) {
        var me = data.me;
        var c = node('div', 'mo-compose' + (momentsComposeOpen ? ' open' : ''));
        var top = node('div', 'mo-compose-top');
        top.appendChild(momentsPerson(me.first, me.name, me.id));
        if (!momentsComposeOpen) {
            var draft = String(momentsPostDraft || '').replace(/^\s+|\s+$/g, '');
            var prompt = node('div', 'mo-prompt' + (draft ? ' filled' : ''));
            emojiFill(prompt, draft || "What's on your mind?");
            top.appendChild(prompt);
            top.appendChild(moIcon(MO_PENCIL, 'mo-compose-ico', '#8e8e93'));
            c.appendChild(top);
            onTap(c, function () { openComposer(); });
            return c;
        }
        top.appendChild(node('div', 'mo-who', me.name || 'You'));
        c.appendChild(top);
        var input = momentsInput('mo-post', 'mo-input', "What's on your mind?", momentsPostDraft, MOMENTS_POST_MAX);
        moTrackCaret(input, 'post');
        var row = node('div', 'mo-compose-row');
        var hint = node('div', 'mo-hint', 'Friends who know you can see this.');
        var postBtn = momentsButton('Post', 'mo-btn mo-btn-off', function () {
            var text = String(input.value || '').replace(/^\s+|\s+$/g, '');
            if (!text) return;
            if (text.length > MOMENTS_POST_MAX) {
                setNote('Keep it under ' + MOMENTS_POST_MAX + ' characters.', true);
                return;
            }
            sendMomentsAction(me, { kind: 'post', text: text }, function () {
                momentsPostDraft = '';
                momentsComposeOpen = false;
                momentsEmojiFor = null;
                momentsFocus = null;
            });
        });
        var sync = function () {
            var n = String(input.value || '').length;
            hint.textContent = n ? (n + ' / ' + MOMENTS_POST_MAX) : 'Friends who know you can see this.';
            postBtn.className = n ? 'mo-btn' : 'mo-btn mo-btn-off';
        };
        var changed = function (value) {
            momentsPostDraft = value;
            sync();
        };
        input.addEventListener('input', function () { changed(input.value); });
        sync();
        row.appendChild(moEmojiButton('post'));
        row.appendChild(hint);
        row.appendChild(momentsButton('Cancel', 'mo-btn mo-btn-plain', function () {
            momentsEmojiFor = null;
            closeComposer();
        }));
        row.appendChild(postBtn);
        c.appendChild(input);
        c.appendChild(row);
        c.appendChild(moEmojiPanel('post', MOMENTS_POST_MAX, changed));
        return c;
    }

    function openReply(postId, comment) {
        momentsMenuPost = null;
        momentsConfirmDelete = null;
        momentsComposer = {
            postId: postId,
            commentId: comment ? comment.id : null,
            name: comment ? comment.authorName : null
        };
        momentsDraft = '';
        momentsFocus = 'reply';
        momentsFocusPending = true;
        momentsRenderedKey = '';
        refresh();
    }

    function closeReply() {
        momentsComposer = null;
        momentsDraft = '';
        momentsFocus = null;
        momentsRenderedKey = '';
        refresh();
    }

    function renderReplyBox(data, post) {
        var box = node('div', 'mo-reply-box');
        if (momentsComposer.name) box.appendChild(node('div', 'mo-reply-to', 'Reply to ' + momentsComposer.name));
        var row = node('div', 'mo-reply-row');
        var input = momentsInput('mo-reply', 'mo-input mo-input-small', momentsComposer.name ? 'Write a reply' : 'Write a comment', momentsDraft, MOMENTS_COMMENT_MAX);
        moTrackCaret(input, 'reply');
        var send = function () {
            var text = String(input.value || '').replace(/^\s+|\s+$/g, '');
            if (!text) return;
            sendMomentsAction(data.me, { kind: 'comment', postId: post.id, text: text, replyToCommentId: momentsComposer.commentId }, function () {
                momentsComposer = null;
                momentsDraft = '';
                momentsEmojiFor = null;
                momentsFocus = null;
            });
        };
        input.addEventListener('input', function () { momentsDraft = input.value; });
        input.addEventListener('keydown', function (e) {
            if (e.keyCode === 13 && !e.shiftKey && !e.isComposing) {
                if (e.preventDefault) e.preventDefault();
                send();
            } else if (e.keyCode === 27) {
                momentsEmojiFor = null;
                closeReply();
            }
        });
        row.appendChild(moEmojiButton('reply'));
        row.appendChild(input);
        var btns = node('div', 'mo-reply-btns');
        btns.appendChild(momentsButton('Send', 'mo-btn', send));
        btns.appendChild(momentsButton('Cancel', 'mo-btn mo-btn-plain', function () {
            momentsEmojiFor = null;
            closeReply();
        }));
        row.appendChild(btns);
        box.appendChild(row);
        box.appendChild(moEmojiPanel('reply', MOMENTS_COMMENT_MAX, function (value) { momentsDraft = value; }));
        return box;
    }

    function likeName(data, like) {
        var me = data.me;
        if (String(like.id) === me.id) return me.name;
        return like.name || data.view.names[String(like.id)] || ('#' + like.id);
    }

    function renderMomentsEmpty(known) {
        var box = node('div', 'mo-empty');
        var mark = node('div', 'mo-empty-mark');
        mark.appendChild(appGlyph('moments'));
        box.appendChild(mark);
        box.appendChild(node('div', 'mo-empty-title', 'No moments yet'));
        box.appendChild(node('div', 'mo-empty-sub', known
            ? 'Posts from people you know will show up here.'
            : 'Moments appear once the reply service has seen this character.'));
        return box;
    }

    // When a post was made, in game time: the clock today, else "Yesterday 18:34", a weekday or
    // "Day 998 08:12". Older posts only have the game's label ("Friday 18:34"); posts with neither
    // show no time rather than a real-world one.
    function moTime(post, env) {
        var g = post.game;
        if (g) return env && env.day === g.day ? smsGameClock(g) : smsStamp(g, env);
        return post.gameTime || '';
    }

    // One post laid out like a social feed: who and when on top, the text across the card, then
    // Like and Comment always in reach, then who liked it and the comments.
    function renderPost(data, post) {
        var me = data.me;
        var mine = post.authorId === me.id;
        var c = node('div', 'mo-post' + (post.pending ? ' mo-pending' : ''));

        var head = node('div', 'mo-head');
        head.appendChild(momentsPerson(post.authorFirst, post.authorName, post.authorId));
        var who = node('div', 'mo-who-box');
        who.appendChild(node('div', 'mo-author', post.authorName || ('#' + post.authorId)));
        var sub = node('div', 'mo-sub');
        sub.appendChild(node('span', 'mo-time' + (post.pending ? ' wait' : ''), post.pending ? 'Sending' : moTime(post, data.env)));
        if (post.place) {
            sub.appendChild(node('span', 'mo-sep', '·'));
            var place = node('span', 'mo-place');
            place.appendChild(moIcon(MO_PIN, 'mo-pin', '#8e8e93'));
            place.appendChild(node('span', null, post.place));
            sub.appendChild(place);
        }
        who.appendChild(sub);
        head.appendChild(who);
        if (mine && !post.pending) {
            var more = node('button', 'mo-more' + (momentsMenuPost === post.id ? ' on' : ''));
            more.setAttribute('type', 'button');
            more.appendChild(node('span'));
            more.appendChild(node('span'));
            more.appendChild(node('span'));
            onTap(more, function (e) {
                e.stopPropagation();
                toggleMenu(post.id);
            });
            head.appendChild(more);
            if (momentsMenuPost === post.id) {
                var confirming = momentsConfirmDelete === post.id;
                var menu = node('div', 'mo-menu');
                menu.appendChild(momentsButton(confirming ? 'Tap again to delete' : 'Delete post', 'mo-menu-item warn', function () {
                    if (momentsConfirmDelete !== post.id) {
                        momentsConfirmDelete = post.id;
                        momentsRenderedKey = '';
                        refresh();
                        setTimeout(function () {
                            if (momentsConfirmDelete === post.id) {
                                momentsConfirmDelete = null;
                                momentsRenderedKey = '';
                                refresh();
                            }
                        }, 3000);
                        return;
                    }
                    momentsConfirmDelete = null;
                    momentsMenuPost = null;
                    sendMomentsAction(me, { kind: 'delete', postId: post.id });
                }));
                head.appendChild(menu);
            }
        }
        c.appendChild(head);

        var text = node('div', 'mo-text');
        emojiFill(text, post.text);
        c.appendChild(text);

        var liked = false;
        var i;
        for (i = 0; i < post.likes.length; i++) if (String(post.likes[i].id) === me.id) liked = true;
        if (!post.pending) {
            var actions = node('div', 'mo-actions');
            var like = momentsButton('', 'mo-act' + (liked ? ' on' : ''), function () {
                sendMomentsAction(me, { kind: liked ? 'unlike' : 'like', postId: post.id });
            });
            like.appendChild(moIcon(MO_HEART, '', liked ? '#FF375F' : '#8e8e93'));
            like.appendChild(node('span', null, post.likes.length ? String(post.likes.length) : 'Like'));
            actions.appendChild(like);
            var talk = momentsButton('', 'mo-act', function () { openReply(post.id, null); });
            talk.appendChild(moIcon(MO_BUBBLE, '', '#8e8e93'));
            talk.appendChild(node('span', null, post.comments.length ? String(post.comments.length) : 'Comment'));
            actions.appendChild(talk);
            c.appendChild(actions);
        }

        if (post.likes.length || post.comments.length) {
            var social = node('div', 'mo-social');
            if (post.likes.length) {
                var likes = node('div', 'mo-likes' + (post.comments.length ? ' split' : ''));
                likes.appendChild(moIcon(MO_HEART, '', '#FF375F'));
                likes.appendChild(node('span', 'mo-like-names', post.likes.map(function (l) {
                    return likeName(data, l);
                }).join('，')));
                social.appendChild(likes);
            }
            post.comments.forEach(function (cm) {
                var own = String(cm.authorId) === me.id;
                var line = node('div', 'mo-c' + (cm.pending ? ' dim' : '') + (!own && !cm.pending ? ' live' : ''));
                line.appendChild(node('span', 'mo-n', cm.authorName || ('#' + cm.authorId)));
                if (cm.replyTo) {
                    line.appendChild(node('span', 'mo-r', ' reply '));
                    line.appendChild(node('span', 'mo-n', cm.replyTo.name || ('#' + cm.replyTo.id)));
                }
                line.appendChild(node('span', 'mo-colon', '：'));
                emojiFill(line, cm.text);
                if (!own && !cm.pending) {
                    onTap(line, function (e) {
                        e.stopPropagation();
                        openReply(post.id, cm);
                    });
                }
                social.appendChild(line);
            });
            c.appendChild(social);
        }
        if (momentsComposer && momentsComposer.postId === post.id && !post.pending) c.appendChild(renderReplyBox(data, post));
        return c;
    }

    function renderMoments(data) {
        var wrap = node('div');
        wrap.id = 'mo-screen';
        wrap.appendChild(subHeader('moments'));
        var p = momentsPresence(data.status);
        if (p.text) wrap.appendChild(node('div', 'mo-status ' + p.cls, p.text));
        wrap.appendChild(renderComposer(data));
        if (momentsComposer && !findById(data.view.posts, momentsComposer.postId)) momentsComposer = null;
        if (!data.view.posts.length) {
            wrap.appendChild(renderMomentsEmpty(data.view.circleKnown));
        } else {
            var feed = node('div', 'mo-feed');
            data.view.posts.forEach(function (post) { feed.appendChild(renderPost(data, post)); });
            wrap.appendChild(feed);
        }
        momentsRenderedKey = momentsRenderKey(data);
        return wrap;
    }

    // Same feed, same open panels: the page on screen is current and must not be rebuilt.
    function momentsRenderKey(data) {
        // The game day too: "Today" and "Yesterday" move on with it.
        return data.key + '|' + (data.env ? data.env.day : '') + '|' + (data.portraitRev || 0) + '|' + (momentsComposeOpen ? '1' : '0') + '|' +
            (momentsComposer ? momentsComposer.postId + '/' + momentsComposer.commentId : '') + '|' +
            (momentsMenuPost || '') + '|' + (momentsConfirmDelete || '');
    }

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

    // ------------------------------------------------------------------
    // AI. Settings of inZOI AI Phone Service (sms-bridge/lib/guardian.js), the program on this
    // PC that writes the replies in Texts and Moments. Files in ui/phone/service/:
    //   service.cfg  written by the service every 2 s: state, settings, which providers have a
    //                key (a short hint only), the answer to the last request
    //   control.cfg  written here: { v, rev, enabled, provider, model, base_url, thinking }
    //   request.cfg  written here: { id, type, provider, model, base_url, key? }
    //                type: paste_key | set_key | forget_key | test | models
    //                (Wallpaper sends wallpaper_pick/remove; Texts sends photo_pick here too)
    // A typed key is in request.cfg only until the service reads it; the service encrypts it
    // for this Windows user and empties the file. Pasting reads the clipboard on the PC side,
    // so the key never passes through this page at all.
    // ------------------------------------------------------------------
    var AI_SECTION = 'ui/phone/service';
    var AI_STALE_MS = 15000;
    var AI_REQUEST_MS = 60000;
    var AI_SAVE_MS = 20000;
    var AI_KEY_MAX = 512;
    var AI_URL_MAX = 300;
    var AI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,127}$/;
    var AI_MODEL_CHIPS = 24;
    var AI_THINKING = [
        { id: 'disabled', label: 'Off' },
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
        { id: 'max', label: 'Max' }
    ];
    var AI_FIELDS = ['ai-model', 'ai-url', 'ai-key'];
    var aiService = null;
    // Provider, model, address and thinking picked on this page and not saved yet.
    var aiDraft = null;
    var aiKeyDraft = '';
    var aiModels = {};
    var aiPending = null;
    var aiSaving = null;
    var aiResult = null;
    var aiConfirmForget = '';
    var aiRenderedKey = '';
    var aiFocus = null;
    var aiSeq = 0;

    // The AI page's state: service.cfg (the guardian) with the daemon's own heartbeat folded in.
    // A bridge started from a console never wrote service.cfg, so the phone called it offline.
    function loadAiService() {
        return Promise.all([
            cfgValue(AI_SECTION, 'service'),
            cfgValue(AI_SECTION, 'daemon')
        ]).then(function (r) {
            var s = r[0] && typeof r[0] === 'object' ? r[0] : null;
            var d = r[1] && typeof r[1] === 'object' ? r[1] : null;
            if (!d || typeof d.heartbeat !== 'number') return s;
            if (Date.now() - d.heartbeat > AI_STALE_MS) return s;
            if (s && typeof s.heartbeat === 'number' && Date.now() - s.heartbeat <= AI_STALE_MS) return s;
            var out = {};
            for (var k in s) if (s.hasOwnProperty(k)) out[k] = s[k];
            out.heartbeat = d.heartbeat;
            out.state = 'running';
            out.error = '';
            // Replies run, but nothing reads request.cfg: photos, wallpapers and keys wait for
            // the guardian.
            out.noGuardian = true;
            if (d.provider) out.provider = d.provider;
            if (d.model) out.model = d.model;
            if (d.version) out.version = d.version;
            return out;
        });
    }

    function aiAlive(s) {
        return !!(s && typeof s.heartbeat === 'number' && Date.now() - s.heartbeat < AI_STALE_MS);
    }

    // Whether request.cfg is read: only the guardian answers requests, a bridge on its own does not.
    var AI_NO_GUARDIAN = 'Open "inZOI AI Phone" from the Windows Start menu, then try again. Only the reply service is running on this PC.';
    function aiTakesRequests(s) {
        return aiAlive(s) && !s.noGuardian;
    }

    function aiProviders() {
        return aiService && Array.isArray(aiService.providers) ? aiService.providers : [];
    }

    function aiProvider(id) {
        var list = aiProviders();
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    }

    function aiKeyOf(id) {
        var keys = aiService && aiService.keys && typeof aiService.keys === 'object' ? aiService.keys : {};
        var k = keys[id];
        return k && typeof k === 'object' ? k : { set: false, hint: '' };
    }

    function aiLocalUrl(url) {
        return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(url || ''));
    }

    function aiSynced() {
        var s = aiService;
        return {
            provider: String(s.provider || ''),
            model: String(s.model || ''),
            base_url: String(s.base_url || ''),
            thinking: String(s.thinking || 'disabled')
        };
    }

    function aiEnsureDraft() {
        if (!aiDraft && aiAlive(aiService)) aiDraft = aiSynced();
    }

    function aiDiffers() {
        if (!aiDraft || !aiAlive(aiService)) return false;
        var s = aiSynced();
        var p = aiProvider(aiDraft.provider);
        if (aiDraft.provider !== s.provider || aiDraft.model.trim() !== s.model || aiDraft.thinking !== s.thinking) return true;
        return !!(p && p.custom && aiDraft.base_url.trim() !== s.base_url);
    }

    function loadAi() {
        return loadAiService().then(function (v) {
            aiService = v && typeof v === 'object' ? v : null;
            aiCheckAnswers();
            return { service: aiService };
        });
    }

    // Matches the service's answers to what this page asked for.
    function aiCheckAnswers() {
        var s = aiService;
        if (aiPending) {
            var r = s && s.reply && typeof s.reply === 'object' ? s.reply : null;
            if (r && r.id === aiPending.id && !r.pending) {
                var asked = aiPending;
                aiPending = null;
                aiResult = { ok: !!r.ok, type: asked.type, text: String(r.message || (r.ok ? 'Done.' : 'That did not work.')) };
                if (asked.type === 'models' && r.ok && Array.isArray(r.models)) aiModels[asked.provider] = r.models.slice(0, 300);
                if ((asked.type === 'paste_key' || asked.type === 'set_key') && r.ok && r.saved && aiDraft && aiDraft.provider === asked.provider && aiDiffers()) {
                    // The key is for the provider picked here: start using that provider now.
                    aiSaveControl(true);
                }
            } else if (Date.now() - aiPending.at > AI_REQUEST_MS) {
                aiPending = null;
                aiResult = { ok: false, text: 'No answer from AI Phone Service. Check that it is running on this PC.' };
            }
        }
        if (aiSaving) {
            if (s && typeof s.appliedRev === 'number' && s.appliedRev >= aiSaving.rev) {
                var quiet = aiSaving.quiet;
                aiSaving = null;
                if (s.controlError) {
                    aiResult = { ok: false, text: String(s.controlError) };
                } else {
                    aiDraft = null;
                    if (!quiet) aiResult = { ok: true, text: 'Saved.' };
                }
            } else if (Date.now() - aiSaving.at > AI_SAVE_MS) {
                aiSaving = null;
                aiResult = { ok: false, text: 'AI Phone Service did not pick up the change. Check that it is running on this PC.' };
            }
        }
    }

    function aiRerender() {
        if (current !== 'ai') return;
        aiRemember();
        show(renderAi({ service: aiService }));
        aiRestore();
    }

    function aiRemember() {
        var a = document.activeElement;
        aiFocus = null;
        if (a && a.id && AI_FIELDS.indexOf(a.id) >= 0) {
            aiFocus = { id: a.id, start: a.selectionStart, end: a.selectionEnd };
        }
    }

    function aiRestore() {
        if (!aiFocus) return;
        var f = document.getElementById(aiFocus.id);
        if (!f) return;
        try {
            f.focus();
            if (typeof aiFocus.start === 'number') f.setSelectionRange(aiFocus.start, aiFocus.end);
        } catch (e) {}
    }

    // Writes control.cfg. `enabled` keeps the current switch unless given.
    function aiSaveControl(quiet, enabled) {
        var s = aiService;
        if (!aiAlive(s)) return;
        var d = aiDraft || aiSynced();
        var p = aiProvider(d.provider);
        var model = d.model.trim();
        var url = d.base_url.trim();
        if (!p) {
            aiResult = { ok: false, text: 'Pick a provider.' };
            return aiRerender();
        }
        if (!AI_MODEL_RE.test(model)) {
            aiResult = { ok: false, text: model ? 'That model name has characters a model name cannot have.' : 'Enter or pick a model.' };
            return aiRerender();
        }
        if (p.custom && !/^https?:\/\/\S+$/i.test(url)) {
            aiResult = { ok: false, text: 'Enter the address of the server, starting with https://' };
            return aiRerender();
        }
        var rev = Date.now();
        var value = {
            v: 1,
            rev: rev,
            enabled: typeof enabled === 'boolean' ? enabled : s.enabled !== false,
            provider: p.id,
            model: model,
            thinking: d.thinking
        };
        if (p.custom) value.base_url = url;
        aiSaving = { rev: rev, at: Date.now(), quiet: !!quiet };
        if (!quiet) aiResult = null;
        saveJson('control', value, AI_SECTION).then(function () {
            refresh();
        }, function (err) {
            aiSaving = null;
            aiResult = { ok: false, text: 'Could not save: ' + errText(err) };
            aiRerender();
        });
        aiRerender();
    }

    // The switch only turns the service on or off; settings picked but not saved stay a draft.
    function aiSwitch(on) {
        var s = aiService;
        if (!aiAlive(s) || aiSaving || (s.enabled !== false) === on) return;
        var rev = Date.now();
        var value = { v: 1, rev: rev, enabled: on, provider: s.provider, model: s.model, thinking: s.thinking };
        var p = aiProvider(s.provider);
        if (p && p.custom) value.base_url = s.base_url;
        aiSaving = { rev: rev, at: Date.now(), quiet: true };
        aiResult = null;
        saveJson('control', value, AI_SECTION).then(function () {
            refresh();
        }, function (err) {
            aiSaving = null;
            aiResult = { ok: false, text: 'Could not switch: ' + errText(err) };
            aiRerender();
        });
        aiRerender();
    }

    function aiRequest(type, key) {
        if (!aiAlive(aiService) || aiPending) return;
        if (!aiTakesRequests(aiService)) {
            aiResult = { ok: false, text: AI_NO_GUARDIAN };
            return aiRerender();
        }
        // One request at a time goes to the service; request.cfg has room for only one.
        if (wallPending || smsPhotoPending) {
            aiResult = { ok: false, text: wallPending ? 'Finish choosing the wallpaper picture on the PC first.' : 'Finish choosing the Texts photo on the PC first.' };
            return aiRerender();
        }
        var d = aiDraft || aiSynced();
        aiSeq += 1;
        var id = 'r' + Date.now() + '-' + aiSeq;
        var value = { id: id, type: type, provider: d.provider, model: d.model.trim() };
        var p = aiProvider(d.provider);
        if (p && p.custom) value.base_url = d.base_url.trim();
        if (typeof key === 'string') value.key = key;
        aiPending = { id: id, type: type, provider: d.provider, at: Date.now() };
        aiResult = null;
        aiConfirmForget = '';
        saveJson('request', value, AI_SECTION).then(function () {
            refresh();
        }, function (err) {
            aiPending = null;
            aiResult = { ok: false, text: 'Could not send: ' + errText(err) };
            aiRerender();
        });
        aiRerender();
    }

    function aiSubmitKey() {
        var f = document.getElementById('ai-key');
        var key = (f ? f.value : aiKeyDraft).trim();
        aiKeyDraft = '';
        if (f) f.value = '';
        if (!key) {
            aiResult = { ok: false, text: 'Type or paste the key first.' };
            return aiRerender();
        }
        aiRequest('set_key', key);
    }

    function aiPickProvider(id) {
        var p = aiProvider(id);
        if (!p || !aiDraft || aiDraft.provider === id) return;
        var s = aiSynced();
        aiDraft.provider = id;
        if (id === s.provider) {
            aiDraft.model = s.model;
            aiDraft.base_url = s.base_url;
        } else {
            aiDraft.model = p.models && p.models.length ? p.models[0] : '';
            aiDraft.base_url = p.custom ? '' : p.base_url;
        }
        aiConfirmForget = '';
        aiResult = null;
        aiRerender();
    }

    function aiStateView(s) {
        var st = s.state;
        if (st === 'running') {
            if (s.ai && s.ai.ok === false) return { cls: 'err', text: 'Running, last reply failed', detail: s.ai.message || '' };
            return { cls: 'on', text: 'Running', detail: 'Texts and Moments are answered by ' + ((aiProvider(s.provider) || {}).label || s.provider) + ' ' + s.model + '.' };
        }
        if (st === 'starting') return { cls: 'on', text: 'Starting...', detail: '' };
        if (st === 'needs_key') return { cls: 'warn', text: 'Needs an API key', detail: s.error || '' };
        if (st === 'disabled') return { cls: 'off', text: 'Off', detail: 'Characters do not answer texts while AI is off.' };
        if (st === 'waiting_game') return { cls: 'err', text: 'Cannot reach the game', detail: s.error || '' };
        if (st === 'stopped') return { cls: 'off', text: 'Stopped', detail: s.error || '' };
        return { cls: 'err', text: 'Problem', detail: s.error || '' };
    }

    function aiRenderKey(data) {
        var s = data.service;
        if (!aiAlive(s)) return 'dead|' + (s && s.state);
        var keys = [];
        aiProviders().forEach(function (p) {
            var k = aiKeyOf(p.id);
            keys.push(p.id + ':' + (k.set ? k.hint : '-'));
        });
        var d = aiDraft || aiSynced();
        return JSON.stringify([
            s.state, s.error, s.enabled, s.provider, s.model, s.base_url, s.thinking, s.controlError, s.version,
            s.ai ? [s.ai.ok, s.ai.message] : null, keys.join(','),
            s.usage && s.usage.hour ? [s.usage.hour.calls, s.usage.hour.failed, s.usage.hour.cost, s.usage.today && s.usage.today.calls,
                s.usage.today && s.usage.today.cost, s.usage.limit, s.usage.peak, s.usage.priced, s.usage.model,
                (s.usage.purposes || []).map(function (p) { return p.id + ':' + p.calls; }).join(',')] : null,
            d.provider, d.thinking, aiPending && aiPending.id, aiSaving && aiSaving.rev, aiResult && aiResult.text,
            aiModels[d.provider] ? aiModels[d.provider].length : 0, aiConfirmForget
        ]);
    }

    function aiChip(text, on, onClick, marked) {
        var c = node('button', 'ph-chip ai-chip' + (on ? ' on' : ''));
        c.setAttribute('type', 'button');
        c.appendChild(node('span', null, text));
        if (marked) c.appendChild(node('span', 'ai-keymark'));
        onTap(c, function (e) {
            e.stopPropagation();
            onClick();
        });
        return c;
    }

    function aiButton(text, cls, enabled, onClick) {
        var b = node('button', 'ph-btn ' + (enabled ? cls : 'off'), text);
        b.setAttribute('type', 'button');
        onTap(b, function (e) {
            e.stopPropagation();
            if (enabled) onClick();
        });
        return b;
    }

    function aiInput(id, type, value, placeholder, max, onInput, onEnter) {
        var f = node('input', 'ai-input');
        f.id = id;
        f.setAttribute('type', type);
        f.setAttribute('maxlength', String(max));
        f.setAttribute('placeholder', placeholder);
        f.setAttribute('autocomplete', 'off');
        f.setAttribute('spellcheck', 'false');
        applyUiFont(f);
        f.value = value || '';
        f.addEventListener('input', function () { onInput(f.value); });
        if (onEnter) {
            f.addEventListener('keydown', function (e) {
                if (e.keyCode === 13 && !e.isComposing) {
                    if (e.preventDefault) e.preventDefault();
                    onEnter();
                }
            });
        }
        return f;
    }

    // Updates what depends on typed text without rebuilding the page.
    function aiSync() {
        var save = document.getElementById('ai-save');
        if (save) save.className = 'ph-btn' + (aiDiffers() && !aiSaving ? ' on' : ' off');
        var chips = document.querySelectorAll('.ai-model-chip');
        for (var i = 0; i < chips.length; i++) {
            var on = aiDraft && chips[i].getAttribute('data-model') === aiDraft.model.trim();
            chips[i].className = 'ph-chip ai-chip ai-model-chip' + (on ? ' on' : '');
        }
    }

    // The diagnostics export shows its progress and result in its own card, everything else
    // under Save / Test connection.
    function aiResultLine(diagnose) {
        var type = aiPending ? aiPending.type : aiResult ? aiResult.type : '';
        var mine = !aiSaving && type === 'diagnose';
        var text = '';
        if (mine === !!diagnose) {
            text = aiSaving ? 'Saving...' : aiPending ? (aiPending.type === 'paste_key' || aiPending.type === 'set_key' ? 'Checking the key with the provider...'
                : aiPending.type === 'models' ? 'Asking the provider for its models...' : aiPending.type === 'test' ? 'Testing the connection...'
                    : aiPending.type === 'diagnose' ? 'Collecting logs and settings...' : 'Working...') : aiResult ? aiResult.text : '';
        }
        var cls = aiSaving || aiPending || !text ? 'ai-result' : aiResult ? (aiResult.ok ? 'ai-result ok' : 'ai-result err') : 'ai-result';
        var line = node('div', cls, text);
        line.id = diagnose ? 'ai-diag-result' : 'ai-result';
        return line;
    }

    var AI_PURPOSES = {
        reply: 'Replies to texts',
        aftermath: 'Mood and needs after a chat',
        mood: 'Mood after a chat',
        needs: 'Needs after a chat',
        moodlet: 'Choosing a moodlet',
        same_task: 'Is it still the asked task',
        want_objects: 'Finding the right object',
        want_pick: 'Choosing the action',
        want_check: 'Checking the action',
        promise_check: 'Checking a promise',
        action_repair: 'Fixing an action plan',
        summary: 'Memory summary',
        setback: 'Texts about a setback',
        proactive: 'Texts they start',
        moments_post: 'Moments posts',
        moments_reaction: 'Moments likes and comments',
        moments_reply: 'Moments replies',
        other: 'Other'
    };
    var AI_USAGE_TOP = 6;

    function aiMoney(value, currency) {
        var sign = currency === 'CNY' ? '\u00a5' : currency === 'USD' ? '$' : currency === 'EUR' ? '\u20ac' : (currency || '') + ' ';
        var n = Number(value) || 0;
        if (n > 0 && n < 0.001) return '< ' + sign + '0.001';
        return sign + n.toFixed(n < 1 ? 3 : 2);
    }

    function aiTokens(n) {
        n = Number(n) || 0;
        if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return String(n);
    }

    function aiUsageCard(u) {
        var c = card('USAGE');
        var hour = u.hour || {};
        var today = u.today || {};
        var head = String(hour.calls || 0) + (u.limit ? ' of ' + u.limit : '') + ' AI calls';
        c.appendChild(node('div', 'ai-usage-big', head));
        c.appendChild(node('div', 'ai-detail', 'in the last 60 minutes' + (u.priced ? ', about ' + aiMoney(hour.cost, u.currency) : '')));
        if (hour.failed) c.appendChild(node('div', 'ai-detail st-warn', hour.failed + ' of them failed. Failed calls are not billed.'));
        if (u.limit && hour.calls >= u.limit * 0.8) {
            c.appendChild(node('div', 'ai-detail st-warn', hour.calls >= u.limit
                ? 'The hourly cap is reached. Characters wait before they answer again.'
                : 'Close to the hourly cap. When it is reached, characters wait before they answer again.'));
        }
        c.appendChild(node('div', 'ai-line', 'Today: ' + (today.calls || 0) + ' calls' + (u.priced ? ', about ' + aiMoney(today.cost, u.currency) : '')));
        var purposes = Array.isArray(u.purposes) ? u.purposes : [];
        if (purposes.length) {
            var list = node('div', 'ai-usage-list');
            purposes.slice(0, AI_USAGE_TOP).forEach(function (p) {
                var row = node('div', 'ai-usage-row');
                row.appendChild(node('span', 'ai-usage-name', AI_PURPOSES[p.id] || p.id));
                row.appendChild(node('span', 'ai-usage-count', String(p.calls) + (u.priced && p.cost ? ' \u00b7 ' + aiMoney(p.cost, u.currency) : '')));
                list.appendChild(row);
            });
            if (purposes.length > AI_USAGE_TOP) {
                var rest = 0;
                purposes.slice(AI_USAGE_TOP).forEach(function (p) { rest += p.calls; });
                var more = node('div', 'ai-usage-row');
                more.appendChild(node('span', 'ai-usage-name', 'Everything else'));
                more.appendChild(node('span', 'ai-usage-count', String(rest)));
                list.appendChild(more);
            }
            c.appendChild(list);
        }
        c.appendChild(node('div', 'ai-hint', 'Tokens in the last 60 minutes: ' + aiTokens(hour.prompt) + ' sent (' + aiTokens(hour.cached) + ' from cache), ' + aiTokens(hour.completion) + ' received.'));
        var note;
        if (!u.priced) {
            note = 'No price is known for this model, so only calls and tokens are shown. To see a cost, add "price" under "llm" in config.json, for example "price": {"input": 2, "cached": 0.5, "output": 8, "currency": "CNY"} (per million tokens).';
        } else if (u.priceSource === 'config') {
            note = 'Cost uses the prices set in config.json. It is an estimate; the bill on the provider\'s website is the real figure.';
        } else {
            note = 'Cost uses DeepSeek\'s published prices' + (u.peak === true ? ', peak hours now (full price)' : u.peak === false ? ', off-peak now (half price)' : '') +
                '. It is an estimate; the bill on the provider\'s website is the real figure.';
        }
        if (u.priced && hour.unpriced) note += ' ' + hour.unpriced + ' call(s) came back without token counts and are not in the cost.';
        c.appendChild(node('div', 'ai-hint', note));
        return c;
    }

    function aiSupportCard() {
        var c = card('SUPPORT');
        var btns = node('div', 'ph-btns');
        btns.style.marginTop = '0';
        var b = aiButton('Export diagnostics', '', !aiPending, function () { aiRequest('diagnose'); });
        b.className += ' last';
        btns.appendChild(b);
        c.appendChild(btns);
        c.appendChild(aiResultLine(true));
        c.appendChild(node('div', 'ai-hint', 'Saves the recent logs and settings as one zip file in Documents\\inZOI\\AI Phone Diagnostics. API keys are removed from it. The chat messages stay in, so the problem can be traced. Send the zip together with what happened and roughly when.'));
        return c;
    }

    function renderAi(data) {
        var s = data.service;
        var wrap = node('div');
        wrap.id = 'ai-screen';
        wrap.appendChild(subHeader('ai'));
        aiRenderedKey = aiRenderKey(data);

        var status = card('AI PHONE SERVICE');
        if (!aiAlive(s)) {
            status.appendChild(node('div', 'ai-state err', 'Not running'));
            status.appendChild(node('div', 'ai-detail', s && s.state === 'stopped'
                ? 'AI Phone Service was closed on this PC. Open "inZOI AI Phone" (inZOI AI 手机) from the Windows Start menu to start it again.'
                : 'AI Phone Service is not running on this PC. Install inZOI AI Phone, or open "inZOI AI Phone" (inZOI AI 手机) from the Windows Start menu. After that it starts by itself whenever you sign in to Windows.'));
            wrap.appendChild(status);
            return wrap;
        }
        aiEnsureDraft();
        var d = aiDraft;
        var view = aiStateView(s);
        status.appendChild(node('div', 'ai-state ' + view.cls, view.text));
        if (view.detail) status.appendChild(node('div', 'ai-detail', view.detail));
        var onOff = node('div', 'ph-btns');
        var enabled = s.enabled !== false;
        onOff.appendChild(aiButton('On', enabled ? 'on' : '', !aiSaving, function () { aiSwitch(true); }));
        var off = aiButton('Off', enabled ? '' : 'on', !aiSaving, function () { aiSwitch(false); });
        off.className += ' last';
        onOff.appendChild(off);
        status.appendChild(onOff);
        wrap.appendChild(status);
        if (s.usage && typeof s.usage === 'object' && s.usage.hour) wrap.appendChild(aiUsageCard(s.usage));

        var p = aiProvider(d.provider) || aiProvider(s.provider);
        var providerCard = card('PROVIDER');
        var pchips = node('div', 'ph-chips');
        aiProviders().forEach(function (item) {
            pchips.appendChild(aiChip(item.label, item.id === d.provider, function () { aiPickProvider(item.id); }, aiKeyOf(item.id).set));
        });
        providerCard.appendChild(pchips);
        providerCard.appendChild(node('div', 'ai-hint', 'A green dot means a key is saved for that provider.'));
        wrap.appendChild(providerCard);
        if (!p) return wrap;

        var key = aiKeyOf(p.id);
        var keyCard = card('API KEY');
        keyCard.appendChild(node('div', 'ai-line', key.set ? 'Saved: ' + (key.hint || 'yes') : 'No key saved for ' + p.label + '.'));
        var keyBtns = node('div', 'ph-btns');
        var paste = aiButton('Paste key', 'on', !aiPending, function () { aiRequest('paste_key'); });
        keyBtns.appendChild(paste);
        if (key.set) {
            var asking = aiConfirmForget === p.id;
            var forget = aiButton(asking ? 'Tap to confirm' : 'Remove key', asking ? 'warn' : '', !aiPending, function () {
                if (aiConfirmForget === p.id) {
                    aiConfirmForget = '';
                    aiRequest('forget_key');
                } else {
                    aiConfirmForget = p.id;
                    aiRerender();
                }
            });
            forget.className += ' last';
            keyBtns.appendChild(forget);
        } else {
            paste.className += ' last';
        }
        keyCard.appendChild(keyBtns);
        var typeRow = node('div', 'ai-row');
        typeRow.appendChild(aiInput('ai-key', 'password', aiKeyDraft, 'Or type the key here', AI_KEY_MAX, function (v) { aiKeyDraft = v; }, aiSubmitKey));
        var saveKey = node('button', 'mo-btn' + (aiPending ? ' mo-btn-off' : ''), 'Save');
        saveKey.setAttribute('type', 'button');
        onTap(saveKey, function (e) {
            e.stopPropagation();
            if (!aiPending) aiSubmitKey();
        });
        typeRow.appendChild(saveKey);
        keyCard.appendChild(typeRow);
        keyCard.appendChild(node('div', 'ai-hint', (p.key_site ? 'Create a key at ' + p.key_site + ' and copy it. ' : '') +
            'Paste key reads the key from the Windows clipboard. It is checked with the provider, then stored encrypted on this PC and never shown again.'));
        wrap.appendChild(keyCard);

        if (p.custom) {
            var urlCard = card('SERVER ADDRESS');
            var urlRow = node('div', 'ai-row');
            urlRow.appendChild(aiInput('ai-url', 'text', d.base_url, 'https://example.com/v1', AI_URL_MAX, function (v) {
                d.base_url = v;
                aiSync();
            }));
            urlCard.appendChild(urlRow);
            urlCard.appendChild(node('div', 'ai-hint', 'Any server that speaks the OpenAI chat completions protocol. http:// is allowed only for a server on this PC.'));
            wrap.appendChild(urlCard);
        }

        var modelCard = card('MODEL');
        var listed = [];
        (p.models || []).concat(aiModels[p.id] || []).forEach(function (m) {
            if (typeof m === 'string' && listed.indexOf(m) < 0) listed.push(m);
        });
        if (listed.length) {
            var mchips = node('div', 'ph-chips');
            listed.slice(0, AI_MODEL_CHIPS).forEach(function (m) {
                var chip = aiChip(m, d.model.trim() === m, function () {
                    d.model = m;
                    var f = document.getElementById('ai-model');
                    if (f) f.value = m;
                    aiSync();
                });
                chip.className += ' ai-model-chip';
                chip.setAttribute('data-model', m);
                mchips.appendChild(chip);
            });
            modelCard.appendChild(mchips);
            if (listed.length > AI_MODEL_CHIPS) {
                modelCard.appendChild(node('div', 'ai-hint', 'Showing ' + AI_MODEL_CHIPS + ' of ' + listed.length + ' models. Type any other name below.'));
            }
        }
        var modelRow = node('div', 'ai-row');
        modelRow.appendChild(aiInput('ai-model', 'text', d.model, 'Model name', 128, function (v) {
            d.model = v;
            aiSync();
        }));
        var canList = !aiPending && (key.set || (p.custom && aiLocalUrl(d.base_url)));
        var fetchBtn = node('button', 'mo-btn mo-btn-plain' + (canList ? '' : ' mo-btn-off'), 'Fetch list');
        fetchBtn.setAttribute('type', 'button');
        onTap(fetchBtn, function (e) {
            e.stopPropagation();
            if (canList) aiRequest('models');
        });
        modelRow.appendChild(fetchBtn);
        modelCard.appendChild(modelRow);
        modelCard.appendChild(node('div', 'ai-hint', 'Fetch list asks the provider which models your key can use.'));
        wrap.appendChild(modelCard);

        var thinkCard = card('DEEP THINKING');
        var tchips = node('div', 'ph-chips');
        AI_THINKING.forEach(function (t) {
            tchips.appendChild(aiChip(t.label, d.thinking === t.id, function () {
                d.thinking = t.id;
                aiRerender();
            }));
        });
        thinkCard.appendChild(tchips);
        thinkCard.appendChild(node('div', 'ai-hint', 'Off answers fastest and costs least. Higher levels think longer before each reply and use more of your credit. Models that cannot switch it off use the lowest level they allow.'));
        wrap.appendChild(thinkCard);

        var actions = card();
        var actionBtns = node('div', 'ph-btns');
        actionBtns.style.marginTop = '0';
        var save = aiButton('Save', 'on', true, function () {
            if (aiDiffers() && !aiSaving) aiSaveControl(false);
        });
        save.id = 'ai-save';
        actionBtns.appendChild(save);
        var test = aiButton('Test connection', '', !aiPending, function () { aiRequest('test'); });
        test.className += ' last';
        actionBtns.appendChild(test);
        actions.appendChild(actionBtns);
        actions.appendChild(aiResultLine());
        actions.appendChild(node('div', 'ai-version', 'AI Phone Service ' + (s.version || '') + (s.installed ? '' : ' (development copy)')));
        wrap.appendChild(actions);
        wrap.appendChild(aiSupportCard());
        setTimeout(aiSync, 0);
        return wrap;
    }

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

    // ------------------------------------------------------------------
    // Navigation and refresh
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // App registry
    // ------------------------------------------------------------------
    // Every app the phone can hold is registered here once. The home screen (APPS, HOME_DOCK),
    // page titles (TITLES), pages (screens), icons and the App Store all read the registry, so a
    // new app is one registerApp call plus its own load/render functions and icon class:
    //   registerApp({
    //       id: 'notes',                 // also the page opened from the icon (or launch: '<page>')
    //       label: 'Notes',              // name under the icon and in the App Store
    //       cls: 'ic-notes',             // icon background, a class in index.html
    //       glyph: function () {},       // optional: draws the icon (else appGlyph's own drawing)
    //       category: 'Productivity',    // App Store
    //       desc: 'Quick notes.',        // App Store: one line in the list
    //       subtitle: '...', about: '...', whatsNew: '...', version: '1.0', developer: '...',
    //       featured: 'A headline',      // App Store: the app can be the featured card
    //       system: false,               // true: always on the phone, cannot be removed
    //       preinstalled: true,          // on the phone the first time this app is seen
    //       dock: false,                 // in the dock under the pages instead of on a page
    //       badge: function (homeData) { return 0; },   // optional number on the icon
    //       screens: {                   // every page of the app
    //           notes: { load: loadNotes, render: renderNotes, title: 'Notes' },
    //           note: { load: loadNote, render: renderNote, parent: 'notes' }   // Back goes to parent
    //       }
    //   });
    // Which apps are on the phone is kept in saved/apps.cfg: { v, installed: [ids], known: [ids] }.
    // "known" lets an app added in a later version install itself once (when preinstalled), while
    // an app the player removed stays removed.
    var APP_STORE_KEY = 'apps';
    var appRegistry = {};
    var appOrder = [];
    var screenApp = {};
    var screenParent = {};
    var appsInstalled = null;
    var appsKnown = null;
    var appsLoaded = false;
    var screens = {};

    function registerApp(def) {
        if (!def || !def.id || appRegistry[def.id]) return;
        var app = {
            id: def.id,
            label: def.label || def.id,
            cls: def.cls || '',
            glyph: typeof def.glyph === 'function' ? def.glyph : null,
            category: def.category || '',
            desc: def.desc || '',
            // App Store page: a short line under the name, the full text, and what changed last.
            subtitle: def.subtitle || def.desc || '',
            about: def.about || def.desc || '',
            whatsNew: def.whatsNew || '',
            developer: def.developer || 'HouseholdBoard',
            featured: def.featured || '',
            version: def.version || '',
            system: !!def.system,
            preinstalled: def.preinstalled !== false,
            dock: !!def.dock,
            badge: typeof def.badge === 'function' ? def.badge : null,
            launch: def.launch || def.id,
            screens: def.screens || {}
        };
        appRegistry[app.id] = app;
        appOrder.push(app.id);
        Object.keys(app.screens).forEach(function (sid) {
            var s = app.screens[sid];
            if (!s || typeof s.load !== 'function' || typeof s.render !== 'function') return;
            screens[sid] = { load: s.load, render: s.render };
            screenApp[sid] = app.id;
            if (s.parent) screenParent[sid] = s.parent;
            TITLES[sid] = s.title || (sid === app.launch ? app.label : TITLES[sid] || '');
        });
        appsRebuild();
    }

    function appInstalled(id) {
        var app = appRegistry[id];
        if (!app) return false;
        if (app.system) return true;
        return appsInstalled ? appsInstalled.indexOf(id) >= 0 : app.preinstalled;
    }

    // The app a page belongs to ('home' and unknown pages belong to none).
    function appOfScreen(screenId) { return screenApp[screenId] || ''; }

    // APPS and HOME_DOCK, the installed apps in registration order.
    function appsRebuild() {
        APPS.length = 0;
        HOME_DOCK.length = 0;
        appOrder.forEach(function (id) {
            var app = appRegistry[id];
            if (!appInstalled(id)) return;
            APPS.push(app);
            if (app.dock) HOME_DOCK.push(id);
        });
    }

    function appsSave() {
        if (!appsLoaded) return;
        saveJson(APP_STORE_KEY, { v: 1, installed: appsInstalled.slice(), known: appsKnown.slice() }, SOUND_SECTION)
            .then(null, function () {});
    }

    // Reads saved/apps.cfg once at start. Until it is read every preinstalled app is shown.
    function appsLoad() {
        return cfgValue(SOUND_SECTION, APP_STORE_KEY).then(function (v) {
            var saved = v && Array.isArray(v.installed) ? v : null;
            var installed = [];
            var known = saved && Array.isArray(saved.known) ? saved.known.slice() : [];
            appOrder.forEach(function (id) {
                var app = appRegistry[id];
                var wasKnown = known.indexOf(id) >= 0 || (saved && !saved.known);
                if (app.system || (saved && saved.installed.indexOf(id) >= 0) || (!wasKnown && app.preinstalled) || (!saved && app.preinstalled)) {
                    installed.push(id);
                }
                if (known.indexOf(id) < 0) known.push(id);
            });
            appsInstalled = installed;
            appsKnown = known;
            appsLoaded = true;
            appsRebuild();
            appsSave();
            if (current === 'home') refresh();
        }, function () {
            appsLoaded = false;
        });
    }

    function appInstall(id) {
        var app = appRegistry[id];
        if (!app || !appsInstalled || appsInstalled.indexOf(id) >= 0) return;
        appsInstalled.push(id);
        appsRebuild();
        appsSave();
    }

    function appRemove(id) {
        var app = appRegistry[id];
        if (!app || app.system || !appsInstalled) return;
        appsInstalled = appsInstalled.filter(function (x) { return x !== id; });
        appsRebuild();
        appsSave();
    }

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

    // ------------------------------------------------------------------
    // Dream Car: the game's car dealer (梦中情车) as an app.
    // ------------------------------------------------------------------
    // The catalog, prices and colours are the game's Vehicle table, the names and descriptions its
    // own text. The photos are files in cars/, cropped from the game's car app by
    // sms-bridge/tools/capture-cars.js: cars/<id>.png (first colour) for every vehicle, and
    // cars/<id>/<colour>.png for the colours captured. A purchase goes to the dealer in the simulation
    // (HouseholdJournal's Zoi.VehicleShop), which checks age, home, the one-vehicle rule and money
    // the way the game's dealer does; the game's own phone is never opened. Ownership is read back
    // from each character (ownedVehicle) before the app says the car is theirs.
    var DC_HYUNDAI = { CASPER: 1, GRANDEUR: 1, IONIQ5: 1, STARIA: 1, IONIQ9: 1, NEXO: 1 };
    var DC_KINDS = [
        { id: 'all', label: 'All' },
        { id: 'car', label: 'Cars' },
        { id: 'moto', label: 'Motorbikes' },
        { id: 'scooter', label: 'Scooters' },
        { id: 'bike', label: 'Bikes' }
    ];
    var DC_KIND_LABEL = { car: 'CAR', moto: 'MOTORBIKE', scooter: 'SCOOTER', bike: 'BICYCLE' };
    // Who the game would refuse by age (EB1VehiclePurchaseRejectReason.Underage).
    var DC_TOO_YOUNG = { Infant: 1, Toddler: 1, Child: 1, LowTeen: 1 };
    var dcCatalog = null;
    var dcCatalogLoading = null;
    var dcDoors = {};
    var dcTab = 'showroom';
    var dcFilter = 'all';
    var dcOpenId = null;
    var dcColor = {};
    var dcConfirm = false;
    var dcBuy = null;
    var dcLastData = null;
    var dcPicKnown = {};
    var dcPicLoads = {};
    var dcCurtain = null;

    // A veil fades on frames, but the end of the fade is also guaranteed by a timer: a curtain
    // that is left half-covered because the frame loop stopped strands the open behind it.
    function fadeVeil(veil, target, ms, alive, done) {
        var start = Number(veil.style.opacity) || 0;
        var at = Date.now();
        var fired = false;
        var fallback = setTimeout(finish, ms + 160);
        function finish() {
            if (fired) return;
            fired = true;
            clearTimeout(fallback);
            if (!alive()) return;
            veil.style.opacity = String(target);
            done();
        }
        function step() {
            if (!alive()) { clearTimeout(fallback); fired = true; return; }
            var t = Math.min(1, (Date.now() - at) / ms);
            veil.style.opacity = String(start + (target - start) * (1 - Math.pow(1 - t, 3)));
            if (t < 1) nextFrame(step);
            else nextFrame(finish);
        }
        nextFrame(step);
    }

    // Each veil carries its own Back, because it covers the page header that would otherwise be
    // the way out. Tapping it abandons the open: the veil goes, and if the page had already
    // landed we leave it the usual way. Two things it must not do, and used to: run a second
    // cover (Dream Car faded the whole phone to black again) or slide a page that never finished
    // drawing.
    function splashBack(stop, screenId) {
        openWaiting = '';
        var landed = current === screenId;
        stop();
        if (landed) open('home');
    }

    // The curtain lives outside the moving content/header, so theme changes never leak through.
    function dcFade(c, target, ms, done) {
        fadeVeil(c.veil, target, ms, function () { return dcCurtain === c; }, done);
    }

    function dcStopCurtain() {
        var c = dcCurtain;
        if (!c) return;
        clearTimeout(c.timer);
        if (c.veil.parentNode) c.veil.parentNode.removeChild(c.veil);
        c.root.classList.remove('dc-covering');
        c.root.classList.remove('dc-revealing');
        c.root.classList.remove('dc-reveal-fast');
        dcCurtain = null;
    }

    function dcFailCurtain(c) {
        if (dcCurtain !== c || c.phase === 'revealing') return;
        c.phase = 'failed';
        c.veil.querySelector('.dc-cover-center').style.visibility = 'visible';
        c.label.textContent = 'The showroom is taking too long to load.';
        c.veil.classList.add('dc-cover-failed');
        c.retry.style.display = 'inline-block';
        traceNav('dreamcar loading failed ' + c.screen);
    }

    function dcNavigate(screenId) {
        var opacity = dcCurtain ? dcCurtain.veil.style.opacity : '0';
        dcStopCurtain();
        ++openSeq;
        awaitOpen(screenId);
        var root = document.getElementById('app-root');
        var veil = node('div', 'dc-cover');
        veil.style.opacity = opacity;
        var back = veil.appendChild(node('button', 'dc-cover-back', 'Back'));
        var center = veil.appendChild(node('div', 'dc-cover-center'));
        center.appendChild(node('div', 'dc-cover-brand', 'DREAM CAR'));
        var label = center.appendChild(node('div', 'dc-cover-label', 'Preparing your showroom'));
        label.setAttribute('role', 'status');
        var track = center.appendChild(node('div', 'dc-cover-track'));
        track.appendChild(node('div', 'dc-cover-light'));
        var retry = center.appendChild(node('button', 'dc-cover-retry', 'Retry'));
        retry.style.display = 'none';
        veil.appendChild(node('div', 'dc-cover-home'));
        root.appendChild(veil);
        root.classList.add('dc-covering');
        var c = dcCurtain = { root: root, veil: veil, label: label, retry: retry,
            screen: screenId, phase: 'covering', at: Date.now(), timer: null };
        onTap(back, function () { splashBack(dcStopCurtain, screenId); });
        onTap(retry, function () { dcNavigate(screenId); });
        var entering = appOfScreen(screenId) === 'dreamcar';
        if (!entering) center.style.visibility = 'hidden';
        var pre = entering ? { screenId: screenId, promise: Promise.resolve().then(function () { return screens[screenId].load(); }) } : null;
        if (pre) pre.promise.then(function () {}, function () {});
        c.timer = setTimeout(function () { dcFailCurtain(c); }, 10000);
        traceNav('dreamcar cover ' + current + ' -> ' + screenId);
        dcFade(c, 1, 180, function () {
            if (c.phase === 'failed') return;
            c.phase = 'loading';
            openNow(screenId, pre);
        });
    }

    function dcReadyCurtain() {
        var c = dcCurtain;
        if (!c || c.screen !== current || c.phase !== 'loading') return;
        c.phase = 'preparing';
        // Layout and image decode must settle before revealing the current viewport.
        nextFrame(function () { nextFrame(function () {
            if (dcCurtain !== c) return;
            var bounds = wf.content.getBoundingClientRect();
            var waits = [];
            var wells = el.screen.querySelectorAll('.dc-well');
            for (var i = 0; i < wells.length; i++) {
                var r = wells[i].getBoundingClientRect();
                if (r.bottom > bounds.top && r.top < bounds.bottom && wells[i].dcReady) waits.push(wells[i].dcReady);
            }
            Promise.all(waits).then(function () {
                nextFrame(function () { nextFrame(function () {
                    if (dcCurtain !== c || c.phase !== 'preparing') return;
                    clearTimeout(c.timer);
                    c.phase = 'revealing';
                    c.root.classList.add('dc-revealing');
                    var fast = Date.now() - c.at < 400;
                    if (fast) c.root.classList.add('dc-reveal-fast');
                    traceNav('dreamcar ready ' + c.screen + ' +' + (Date.now() - c.at) + 'ms images ' + waits.length);
                    dcFade(c, 0, fast ? 300 : 500, function () {
                        dcStopCurtain();
                        traceNav('dreamcar revealed ' + current);
                    });
                }); });
            });
        }); });
    }

    // ---- Texts splash ----
    // The threads are already on this PC, so there is nothing to wait for. The veil is only ever on screen while the page behind it paints — long enough to
    // read as the app opening, short enough that a tap never seems to stall.
    var txCurtain = null;
    var TX_SPLASH_MIN_MS = 820;
    var TX_SPLASH_MAX_MS = 1800;

    function txCurtainStop() {
        var c = txCurtain;
        if (!c) return;
        clearTimeout(c.timer);
        clearTimeout(c.waitTimer);
        if (c.veil.parentNode) c.veil.parentNode.removeChild(c.veil);
        c.root.classList.remove('tx-covering');
        txCurtain = null;
        // A veil that comes down before its page is up is a tap that went nowhere; the log says
        // which stage it died in (ui/phone/diag/loadlog.cfg).
        if (c.phase !== 'revealing') traceNav('texts curtain dropped at ' + c.phase + ' for ' + c.screen);
    }

    function txCurtainFade(target, ms, done) {
        var c = txCurtain;
        if (!c) return;
        fadeVeil(c.veil, target, ms, function () { return txCurtain === c; }, done);
    }

    function txCurtainOpen(screenId) {
        txCurtainStop();
        ++openSeq;
        awaitOpen(screenId);
        var root = document.getElementById('app-root');
        var veil = node('div', 'tx-cover');
        veil.style.opacity = '0';
        var back = veil.appendChild(node('button', 'tx-cover-back', 'Back'));
        var center = veil.appendChild(node('div', 'tx-cover-center'));
        var bubble = center.appendChild(node('div', 'tx-cover-bubble'));
        bubble.appendChild(node('span', 'tx-cover-dot'));
        bubble.appendChild(node('span', 'tx-cover-dot'));
        bubble.appendChild(node('span', 'tx-cover-dot'));
        center.appendChild(node('div', 'tx-cover-brand', 'TEXTS'));
        var label = center.appendChild(node('div', 'tx-cover-label', 'Loading your conversations'));
        label.setAttribute('role', 'status');
        veil.appendChild(node('div', 'tx-cover-home'));
        root.appendChild(veil);
        root.classList.add('tx-covering');
        var c = txCurtain = { root: root, veil: veil, screen: screenId, phase: 'covering',
            at: Date.now(), timer: 0, waitTimer: 0, pending: false };
        onTap(back, function () { splashBack(txCurtainStop, screenId); });
        // The threads are read from the phone's own files; if that read is slower than this, the
        // page says so itself, so the veil never stays up past it.
        c.timer = setTimeout(function () {
            if (txCurtain !== c || c.phase === 'revealing') return;
            txSplashReveal();
        }, TX_SPLASH_MAX_MS);
        traceNav('texts cover ' + current + ' -> ' + screenId);
        txCurtainFade(1, 160, function () {
            var k = txCurtain;
            if (!k || k !== c) return;
            k.phase = 'loading';
            openNow(screenId, null);
            if (k.pending) txSplashReveal();
        });
    }

    function txSplashReveal() {
        var c = txCurtain;
        if (!c) return;
        if (c.phase !== 'loading') { c.pending = true; return; }
        var wait = TX_SPLASH_MIN_MS - (Date.now() - c.at);
        if (wait > 0) {
            if (!c.waitTimer) c.waitTimer = setTimeout(function () {
                c.waitTimer = 0;
                txSplashReveal();
            }, wait);
            return;
        }
        c.phase = 'preparing';
        nextFrame(function () { nextFrame(function () {
            var k = txCurtain;
            if (!k || k !== c || k.phase !== 'preparing') return;
            clearTimeout(k.timer);
            k.phase = 'revealing';
            traceNav('texts revealed +' + (Date.now() - k.at) + 'ms');
            txCurtainFade(0, 380, function () { txCurtainStop(); });
        }); });
    }

    function txSplashCheck() {
        var c = txCurtain;
        if (!c) return;
        // During the cover, `current` is still the page being left, and a poll of that page
        // asking here must not take the veil — and the open behind it — down.
        if (c.phase === 'covering') return;
        if (c.screen !== current) { txCurtainStop(); return; }
        if (c.phase !== 'loading') return;
        txSplashReveal();
    }

    // ---- Freelance splash ----
    // The board and the played character's career record come from two different places: the
    // service's board file and the game's own component. Opening Freelance therefore gets a real
    // loading cover in the visual language of a white professional network. It is played on every entry from outside the app,
    // never when an order detail opens inside it.
    var flCurtain = null;
    var FL_SPLASH_MIN_MS = 1040;
    var FL_SPLASH_MAX_MS = 2500;

    function flCoverGlyph() {
        var svg = glyphSvg('0 0 24 24');
        // Three connected people, the network mark of the cover.
        glyphShape(svg, 'path', {
            d: 'M6.5 8.1L17.5 8.1 12 17.3Z', fill: 'none', stroke: '#ffffff',
            'stroke-width': '1.2', 'stroke-linejoin': 'round', opacity: '0.62'
        });
        glyphShape(svg, 'circle', { cx: '6.5', cy: '8.1', r: '2.25', fill: '#ffffff' });
        glyphShape(svg, 'circle', { cx: '17.5', cy: '8.1', r: '2.25', fill: '#ffffff' });
        glyphShape(svg, 'circle', { cx: '12', cy: '17.3', r: '2.25', fill: '#ffffff' });
        return svg;
    }

    function flCoverRow(letter, color, category, second) {
        var row = node('div', 'fl-cover-row ' + (second ? 'second' : 'first'));
        var avatar = row.appendChild(node('div', 'fl-cover-avatar', letter));
        avatar.style.background = color;
        var plan = row.appendChild(node('div', 'fl-cover-plan'));
        plan.appendChild(node('div', 'fl-cover-cat', category));
        plan.appendChild(node('div', 'fl-cover-line wide'));
        plan.appendChild(node('div', 'fl-cover-line short'));
        row.appendChild(node('div', 'fl-cover-node'));
        return row;
    }

    function flCurtainStop() {
        var c = flCurtain;
        if (!c) return;
        clearTimeout(c.timer);
        clearTimeout(c.waitTimer);
        if (c.veil.parentNode) c.veil.parentNode.removeChild(c.veil);
        c.root.classList.remove('fl-covering');
        flCurtain = null;
        if (c.phase !== 'revealing') traceNav('freelance curtain dropped at ' + c.phase + ' for ' + c.screen);
    }

    function flCurtainFade(target, ms, done) {
        var c = flCurtain;
        if (!c) return;
        fadeVeil(c.veil, target, ms, function () { return flCurtain === c; }, done);
    }

    function flCurtainOpen(screenId) {
        flCurtainStop();
        ++openSeq;
        awaitOpen(screenId);
        var root = document.getElementById('app-root');
        var veil = node('div', 'fl-cover');
        veil.style.opacity = '0';
        var back = veil.appendChild(node('button', 'fl-cover-back', 'Back'));
        veil.appendChild(node('div', 'fl-cover-halo'));
        veil.appendChild(node('div', 'fl-cover-ring outer'));
        veil.appendChild(node('div', 'fl-cover-ring'));
        var center = veil.appendChild(node('div', 'fl-cover-center'));
        var card = center.appendChild(node('div', 'fl-cover-card'));
        var top = card.appendChild(node('div', 'fl-cover-top'));
        top.appendChild(node('div', 'fl-cover-mark')).appendChild(flCoverGlyph());
        var names = top.appendChild(node('div', 'fl-cover-names'));
        names.appendChild(node('div', 'fl-cover-brand', 'FREELANCE'));
        names.appendChild(node('div', 'fl-cover-kicker', 'CAREER NETWORK'));
        top.appendChild(node('div', 'fl-cover-live', 'OPEN'));
        card.appendChild(node('div', 'fl-cover-headline', 'Work that finds you.'));
        card.appendChild(node('div', 'fl-cover-sub', 'Matching open briefs to your skills and your day.'));
        var feed = card.appendChild(node('div', 'fl-cover-feed'));
        feed.appendChild(flCoverRow('D', 'linear-gradient(145deg, #2D8BE8 0%, #0A66C2 100%)', 'DELIVERY', false));
        feed.appendChild(flCoverRow('C', 'linear-gradient(145deg, #9A83DF 0%, #6E52BC 100%)', 'CREATIVE', true));
        feed.appendChild(node('div', 'fl-cover-sheen'));
        var status = card.appendChild(node('div', 'fl-cover-status'));
        status.appendChild(node('div', 'fl-cover-pulse'));
        var label = status.appendChild(node('div', 'fl-cover-label', 'Building your opportunity feed'));
        label.setAttribute('role', 'status');
        var steps = status.appendChild(node('div', 'fl-cover-steps'));
        steps.appendChild(node('div', 'fl-cover-step first'));
        steps.appendChild(node('div', 'fl-cover-step second'));
        steps.appendChild(node('div', 'fl-cover-step third'));
        veil.appendChild(node('div', 'fl-cover-home'));
        root.appendChild(veil);
        root.classList.add('fl-covering');
        var c = flCurtain = { root: root, veil: veil, screen: screenId, phase: 'covering',
            at: Date.now(), timer: null, waitTimer: 0, pending: false };
        onTap(back, function () { splashBack(flCurtainStop, screenId); });
        // The page can say on its own that the board is missing; the cover never holds it longer
        // than this while the game is busy or the Lua mod has not reported yet.
        c.timer = setTimeout(function () {
            if (flCurtain !== c || c.phase === 'revealing') return;
            flSplashReveal();
        }, FL_SPLASH_MAX_MS);
        traceNav('freelance cover ' + current + ' -> ' + screenId);
        flCurtainFade(1, 190, function () {
            var k = flCurtain;
            if (!k || k !== c) return;
            k.phase = 'loading';
            openNow(screenId, null);
            if (k.pending) flSplashReveal();
        });
    }

    function flSplashReveal() {
        var c = flCurtain;
        if (!c) return;
        if (c.phase !== 'loading') { c.pending = true; return; }
        var wait = FL_SPLASH_MIN_MS - (Date.now() - c.at);
        if (wait > 0) {
            if (!c.waitTimer) c.waitTimer = setTimeout(function () {
                c.waitTimer = 0;
                flSplashReveal();
            }, wait);
            return;
        }
        c.phase = 'preparing';
        // One paint lets the loaded page settle under the card before it fades away.
        nextFrame(function () { nextFrame(function () {
            var k = flCurtain;
            if (!k || k !== c || k.phase !== 'preparing') return;
            clearTimeout(k.timer);
            k.phase = 'revealing';
            traceNav('freelance revealed +' + (Date.now() - k.at) + 'ms');
            flCurtainFade(0, 420, function () { flCurtainStop(); });
        }); });
    }

    // Called when the page under the veil has drawn. As with Texts, a poll for the
    // page being left must not take this veil down before the open has landed.
    function flSplashCheck() {
        var c = flCurtain;
        if (!c) return;
        if (c.phase === 'covering') return;
        if (c.screen !== current) { flCurtainStop(); return; }
        if (c.phase !== 'loading') return;
        if (appOfScreen(current) !== 'freelance') { flCurtainStop(); return; }
        flSplashReveal();
    }

    // ---- News splash ----
    // Freelance borrows the language of a professional network; News borrows the language of a
    // printed morning edition. A warm paper sheet, a masthead, a front-page picture and ruled
    // type settle into place while the local edition is assembled. It plays on every entry from
    // outside the app, never when a story opens inside it.
    var nwCurtain = null;
    var NW_SPLASH_MIN_MS = 1080;
    var NW_SPLASH_MAX_MS = 2400;

    function nwCoverGlyph() {
        var svg = glyphSvg('0 0 24 24');
        glyphPath(svg, 'M4 4.2h13.2c1.5 0 2.8 1.2 2.8 2.8v12.8H6.8A2.8 2.8 0 0 1 4 17V4.2zm2.2 2.4v8.1h5.6V6.6H6.2zm7.6 0v3.1h3.8V6.6h-3.8zm0 5.2v2.9h3.8v-2.9h-3.8z', '#ffffff', 'evenodd');
        return svg;
    }

    function nwCoverLine(cls) {
        return node('div', 'nw-cover-line ' + (cls || ''));
    }

    function nwCurtainStop() {
        var c = nwCurtain;
        if (!c) return;
        clearTimeout(c.timer);
        clearTimeout(c.waitTimer);
        if (c.veil.parentNode) c.veil.parentNode.removeChild(c.veil);
        c.root.classList.remove('nw-covering');
        nwCurtain = null;
        if (c.phase !== 'revealing') traceNav('news curtain dropped at ' + c.phase + ' for ' + c.screen);
    }

    function nwCurtainFade(target, ms, done) {
        var c = nwCurtain;
        if (!c) return;
        fadeVeil(c.veil, target, ms, function () { return nwCurtain === c; }, done);
    }

    function nwCurtainOpen(screenId) {
        nwCurtainStop();
        ++openSeq;
        awaitOpen(screenId);
        var root = document.getElementById('app-root');
        var veil = node('div', 'nw-cover');
        veil.style.opacity = '0';
        var back = veil.appendChild(node('button', 'nw-cover-back', '< Back'));
        veil.appendChild(node('div', 'nw-cover-disc outer'));
        veil.appendChild(node('div', 'nw-cover-disc'));
        var center = veil.appendChild(node('div', 'nw-cover-center'));
        var paper = center.appendChild(node('div', 'nw-cover-paper'));
        var top = paper.appendChild(node('div', 'nw-cover-top'));
        top.appendChild(node('div', 'nw-cover-mark')).appendChild(nwCoverGlyph());
        var names = top.appendChild(node('div', 'nw-cover-names'));
        names.appendChild(node('div', 'nw-cover-brand', 'THE CITY DESK'));
        names.appendChild(node('div', 'nw-cover-kicker', 'INDEPENDENT MORNING EDITION'));
        top.appendChild(node('div', 'nw-cover-live', 'PREVIEW'));
        paper.appendChild(node('div', 'nw-cover-rule'));
        var edition = paper.appendChild(node('div', 'nw-cover-edition'));
        edition.appendChild(node('div', 'nw-cover-date', 'MORNING EDITION'));
        edition.appendChild(node('div', 'nw-cover-price', 'LOCAL · DAILY'));
        paper.appendChild(node('div', 'nw-cover-headline', 'The city, before it wakes.'));
        paper.appendChild(node('div', 'nw-cover-sub', 'The people, places and small changes shaping tomorrow.'));
        var front = paper.appendChild(node('div', 'nw-cover-front'));
        var art = nwArt({ art: 'city', cat: 'City' }, 'nw-cover-art');
        front.appendChild(art);
        var col = front.appendChild(node('div', 'nw-cover-col'));
        col.appendChild(nwCoverLine('strong'));
        col.appendChild(nwCoverLine('wide'));
        col.appendChild(nwCoverLine('wide'));
        col.appendChild(nwCoverLine('short'));
        col.appendChild(nwCoverLine('wide'));
        col.appendChild(nwCoverLine('mid'));
        paper.appendChild(node('div', 'nw-cover-columns'));
        paper.appendChild(node('div', 'nw-cover-rule thin'));
        var status = paper.appendChild(node('div', 'nw-cover-status'));
        status.appendChild(node('div', 'nw-cover-pulse'));
        var label = status.appendChild(node('div', 'nw-cover-status-label', 'Laying out the morning edition'));
        label.setAttribute('role', 'status');
        var steps = status.appendChild(node('div', 'nw-cover-steps'));
        steps.appendChild(node('div', 'nw-cover-step first'));
        steps.appendChild(node('div', 'nw-cover-step second'));
        steps.appendChild(node('div', 'nw-cover-step third'));
        veil.appendChild(node('div', 'nw-cover-home'));
        root.appendChild(veil);
        root.classList.add('nw-covering');
        var c = nwCurtain = { root: root, veil: veil, screen: screenId, phase: 'covering',
            at: Date.now(), timer: null, waitTimer: 0, pending: false };
        onTap(back, function () { splashBack(nwCurtainStop, screenId); });
        c.timer = setTimeout(function () {
            if (nwCurtain !== c || c.phase === 'revealing') return;
            nwSplashReveal();
        }, NW_SPLASH_MAX_MS);
        traceNav('news cover ' + current + ' -> ' + screenId);
        nwCurtainFade(1, 190, function () {
            var k = nwCurtain;
            if (!k || k !== c) return;
            k.phase = 'loading';
            openNow(screenId, null);
            if (k.pending) nwSplashReveal();
        });
    }

    function nwSplashReveal() {
        var c = nwCurtain;
        if (!c) return;
        if (c.phase !== 'loading') { c.pending = true; return; }
        var wait = NW_SPLASH_MIN_MS - (Date.now() - c.at);
        if (wait > 0) {
            if (!c.waitTimer) c.waitTimer = setTimeout(function () {
                c.waitTimer = 0;
                nwSplashReveal();
            }, wait);
            return;
        }
        c.phase = 'preparing';
        nextFrame(function () { nextFrame(function () {
            var k = nwCurtain;
            if (!k || k !== c || k.phase !== 'preparing') return;
            clearTimeout(k.timer);
            k.phase = 'revealing';
            traceNav('news revealed +' + (Date.now() - k.at) + 'ms');
            nwCurtainFade(0, 420, function () { nwCurtainStop(); });
        }); });
    }

    function nwSplashCheck() {
        var c = nwCurtain;
        if (!c) return;
        if (c.phase === 'covering') return;
        if (c.screen !== current) { nwCurtainStop(); return; }
        if (c.phase !== 'loading') return;
        if (appOfScreen(current) !== 'news') { nwCurtainStop(); return; }
        nwSplashReveal();
    }

    function dcColorFile(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.png'; }

    function dcKind(row) {
        var id = row._row_name;
        if (row.type === 'Car') return 'car';
        if (row.type === 'Bicycle') return 'bike';
        if (/^ScramblerBike/.test(id)) return 'moto';
        return 'scooter';
    }

    function dcMoney(n) {
        var s = String(Math.round(Number(n) || 0));
        var out = '';
        while (s.length > 3) {
            out = ',' + s.slice(-3) + out;
            s = s.slice(0, -3);
        }
        return '₼' + s + out;
    }

    function dcHex(c) {
        var h = String((c && c.uIHexColor) || '#888888');
        return h.length === 9 ? h.slice(0, 7) : h;
    }

    // Vehicles the game sells (purchasableLevel), cheapest first; read once per session.
    function dcLoadCatalog() {
        if (dcCatalog) return Promise.resolve(dcCatalog);
        if (dcCatalogLoading) return dcCatalogLoading;
        dcCatalogLoading = call('data.table_get_all', { Alias: 'Vehicle' }).then(function (rows) {
            var list = (Array.isArray(rows) ? rows : []).filter(function (r) {
                return r && (r.purchasableLevel || []).length && r.type !== 'Invalid' && r.type !== 'Ship';
            });
            var keys = [];
            list.forEach(function (r) { keys.push(r.displayNameTextId, r.descriptionTextId); });
            return localize(keys).then(function (l10n) {
                var cars = list.map(function (r) {
                    return {
                        id: r._row_name,
                        name: l10n[r.displayNameTextId] || r._row_name,
                        about: l10n[r.descriptionTextId] || '',
                        price: Number(r.price) || 0,
                        type: r.type,
                        kind: dcKind(r),
                        template: r.vehicleTemplateId || '',
                        used: /_Used$/.test(r._row_name),
                        hyundai: !!DC_HYUNDAI[r._row_name],
                        electric: /^IONIQ|^ElectricScooter|^MopedBike/.test(r._row_name),
                        hydrogen: r._row_name === 'NEXO',
                        colors: (r.color || []).map(function (c) { return { id: c.colorId, hex: dcHex(c) }; })
                    };
                });
                cars.sort(function (a, b) { return a.price - b.price; });
                dcCatalog = cars;
                return cars;
            });
        }).then(function (cars) {
            dcCatalogLoading = null;
            return cars;
        }, function (err) {
            dcCatalogLoading = null;
            throw err;
        });
        return dcCatalogLoading;
    }

    function dcCar(id) {
        var list = dcCatalog || [];
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    }

    // Doors, from the vehicle's template (cars only), read when its page first opens.
    function dcLoadDoors(car) {
        if (!car || car.kind !== 'car' || !car.template || car.id in dcDoors) return Promise.resolve();
        return soft(call('data.table_get', { Alias: 'VehicleTemplate', Row: car.template })).then(function (t) {
            var n = 0;
            ((t && t.partList) || []).forEach(function (p) { if (/Door$/.test(String(p.partType || ''))) n++; });
            dcDoors[car.id] = n;
        });
    }

    // What a character owns, from the character itself.
    function dcOwned(id) {
        return soft(call('entity.reflect', { entity_id: String(id) })).then(function (r) {
            var o = r && ((r.vehicleContext && r.vehicleContext.ownedVehicle) || r.ownedVehicle);
            var dt = o && o.vehicleDtId && o.vehicleDtId !== 'None' ? String(o.vehicleDtId) : '';
            return dt ? { id: dt, color: o.colorId && o.colorId !== 'None' ? String(o.colorId) : '' } : null;
        });
    }

    function loadDreamCar() {
        return Promise.all([soft(getEnv()), getPossessedId(), getMembers(), dcLoadCatalog()]).then(function (r) {
            var me = r[1];
            var members = r[2] || [];
            var householdId = '';
            members.forEach(function (m) { if (String(m.entity_id) === me && m.household_id !== undefined) householdId = String(m.household_id); });
            if (!householdId && members[0] && members[0].household_id !== undefined) householdId = String(members[0].household_id);
            return Promise.all([
                householdId ? soft(call('entity.reflect', { entity_id: householdId, Component: 'Currency' })) : Promise.resolve(null),
                Promise.all(members.map(function (m) { return dcOwned(m.entity_id); })),
                dcLoadDoors(dcCar(dcOpenId))
            ]).then(function (d) {
                var money = d[0] && d[0].currencyMap && typeof d[0].currencyMap.mew === 'number' ? d[0].currencyMap.mew : null;
                var owned = {};
                members.forEach(function (m, i) { if (d[1][i]) owned[String(m.entity_id)] = d[1][i]; });
                var self = null;
                members.forEach(function (m) { if (String(m.entity_id) === me) self = m; });
                var data = { env: r[0] && !r[0].error ? r[0] : {}, me: me, self: self, members: members, money: money, owned: owned, cars: r[3] };
                return data;
            });
        });
    }

    // ---- photos ----
    // The photo of a colour when it was captured, else the vehicle's list photo. Which files exist
    // is learned once per file with an Image, so a redraw always draws the same picture.
    function dcPicUrl(car, colorId) {
        var exact = colorId ? 'cars/' + car.id + '/' + dcColorFile(colorId) : '';
        if (exact && dcPicKnown[exact] === true) return exact;
        return 'cars/' + car.id + '.png';
    }

    function dcProbe(url) {
        if (dcPicLoads[url]) return dcPicLoads[url];
        dcPicLoads[url] = new Promise(function (resolve) {
            var img = new Image();
            var settled = false;
            var timer = setTimeout(function () { finish(false); }, 4000);
            function finish(ok) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                dcPicKnown[url] = ok;
                img.onload = img.onerror = null;
                resolve(ok);
            }
            img.onload = function () {
                if (typeof img.decode === 'function') img.decode().then(function () { finish(true); }, function () { finish(true); });
                else finish(true);
            };
            img.onerror = function () { finish(false); };
            img.src = url;
        });
        return dcPicLoads[url];
    }

    // large: a well wider than the list photo, where that photo is drawn near its own size.
    function dcWell(car, colorId, badges, large) {
        var well = node('div', 'dc-well');
        var url = dcPicUrl(car, colorId);
        var pic = node('div', 'dc-pic' + (large && url === 'cars/' + car.id + '.png' ? ' small' : ''));
        if (dcPicKnown[url]) pic.style.backgroundImage = 'url("' + url + '")';
        well.appendChild(pic);
        var exact = colorId ? 'cars/' + car.id + '/' + dcColorFile(colorId) : '';
        var fallback = 'cars/' + car.id + '.png';
        well.dcReady = (exact ? dcProbe(exact) : Promise.resolve(false)).then(function (ok) {
            if (ok) return exact;
            return dcProbe(fallback).then(function (found) { return found ? fallback : ''; });
        }).then(function (readyUrl) {
            if (!readyUrl) {
                well.appendChild(node('div', 'dc-photo-missing', 'Image unavailable'));
                return;
            }
            pic.className = 'dc-pic' + (large && readyUrl === fallback ? ' small' : '');
            var background = 'url("' + readyUrl + '")';
            if (!dcCurtain && pic.style.backgroundImage && pic.style.backgroundImage !== background) {
                var incoming = node('div', pic.className);
                incoming.style.backgroundImage = background;
                incoming.style.opacity = '0';
                well.insertBefore(incoming, pic.nextSibling);
                nextFrame(function () { incoming.style.opacity = '1'; });
                setTimeout(function () { if (pic.parentNode) pic.parentNode.removeChild(pic); }, 300);
            } else pic.style.backgroundImage = background;
        });
        if (badges && badges.length) {
            var row = well.appendChild(node('div', 'dc-badges'));
            badges.forEach(function (b) { row.appendChild(node('div', 'dc-badge' + (b.cls ? ' ' + b.cls : ''), b.text)); });
        }
        return well;
    }

    function dcBadges(car, featured) {
        var out = [];
        if (featured) out.push({ text: 'FEATURED', cls: 'hot' });
        if (car.used) out.push({ text: 'PRE-OWNED', cls: 'used' });
        else if (car.hydrogen) out.push({ text: 'HYDROGEN', cls: 'eco' });
        else if (car.electric) out.push({ text: 'ELECTRIC', cls: 'eco' });
        return out.slice(0, 2);
    }

    function dcRerender() {
        if (dcCurtain) return;
        if (!dcLastData || appOfScreen(current) !== 'dreamcar') return;
        var view = screens[current] && screens[current].render;
        if (!view) return;
        var scrollTop = wf.content.scrollTop;
        show(view(dcLastData));
        wf.content.scrollTop = scrollTop;
    }

    // ---- showroom ----
    function dcHeader(data, title, sub) {
        var frag = node('div');
        var brand = frag.appendChild(node('div', 'dc-brand'));
        brand.appendChild(node('div', 'dc-brand-mark', 'DREAM CAR'));
        var env = data.env || {};
        brand.appendChild(node('div', 'dc-brand-day', [env.day_of_week, env.season].filter(Boolean).join(' · ').toUpperCase()));
        frag.appendChild(node('div', 'dc-hero-title', title));
        if (sub) frag.appendChild(node('div', 'dc-hero-sub', sub));
        return frag;
    }

    function dcSegment() {
        var seg = node('div', 'dc-seg');
        [{ id: 'showroom', label: 'Showroom', screen: 'dreamcar' }, { id: 'garage', label: 'Garage', screen: 'dcgarage' }].forEach(function (t) {
            var item = seg.appendChild(node('div', 'dc-seg-item' + (dcTab === t.id ? ' on' : ''), t.label));
            onTap(item, function (e) {
                e.stopPropagation();
                if (dcTab === t.id) return;
                dcTab = t.id;
                open(t.screen);
            });
        });
        return seg;
    }

    function dcWallet(data) {
        var w = node('div', 'dc-wallet');
        var main = w.appendChild(node('div', 'dc-wallet-main'));
        main.appendChild(node('div', 'dc-wallet-label', 'HOUSEHOLD FUNDS'));
        main.appendChild(node('div', 'dc-wallet-value', data.money === null ? '—' : dcMoney(data.money)));
        var side = w.appendChild(node('div', 'dc-wallet-side'));
        side.appendChild(node('div', 'dc-wallet-who', data.self ? fullName(data.self) : 'You'));
        var mine = data.owned[data.me];
        var car = mine ? dcCar(mine.id) : null;
        side.appendChild(node('div', 'dc-wallet-ride' + (mine ? '' : ' none'), mine ? (car ? car.name : mine.id) : 'No vehicle yet'));
        return w;
    }

    function dcFit(data, car) {
        if (data.money === null) return null;
        var short = car.price - data.money;
        var fit = node('div', 'dc-tile-fit' + (short > 0 ? ' short' : ''));
        fit.appendChild(node('span', 'dc-fit-dot'));
        fit.appendChild(node('span', null, short > 0 ? dcMoney(short) + ' short' : 'In your budget'));
        return fit;
    }

    function dcOpenCar(car) {
        dcOpenId = car.id;
        dcConfirm = false;
        if (dcBuy && dcBuy.carId !== car.id && dcBuy.state !== 'running') dcBuy = null;
        open('dccar');
    }

    // The featured vehicle changes with the game day: one of the licensed models.
    function dcFeatured(cars, env) {
        var picks = cars.filter(function (c) { return c.hyundai; });
        if (!picks.length) picks = cars.filter(function (c) { return c.kind === 'car'; });
        if (!picks.length) return null;
        var day = Number(env && (env.day || env.days || env.total_days)) || 0;
        return picks[Math.abs(day) % picks.length];
    }

    function renderDreamCar(data) {
        dcLastData = data;
        dcTab = 'showroom';
        var wrap = node('div', 'dc');
        wrap.appendChild(subHeader('dreamcar'));
        wrap.appendChild(dcHeader(data, 'Find the one.', data.cars.length + ' vehicles in stock, from bicycles to SUVs.'));
        wrap.appendChild(dcSegment());
        wrap.appendChild(dcWallet(data));

        var feat = dcFeatured(data.cars, data.env);
        if (feat && dcFilter === 'all') {
            var f = node('div', 'dc-feature');
            f.appendChild(dcWell(feat, dcColor[feat.id], dcBadges(feat, true), true));
            var body = f.appendChild(node('div', 'dc-feature-body'));
            var text = body.appendChild(node('div', 'dc-feature-text'));
            text.appendChild(node('div', 'dc-feature-kicker', feat.hyundai ? 'HYUNDAI' : DC_KIND_LABEL[feat.kind]));
            text.appendChild(node('div', 'dc-feature-name', feat.name));
            text.appendChild(node('div', 'dc-feature-price', 'From ' + dcMoney(feat.price) + ' · ' + feat.colors.length + ' colours'));
            body.appendChild(node('div', 'dc-cta', 'Explore'));
            onTap(f, function (e) {
                e.stopPropagation();
                dcOpenCar(feat);
            });
            wrap.appendChild(f);
        }

        var chips = node('div', 'dc-chips');
        DC_KINDS.forEach(function (k) {
            var chip = chips.appendChild(node('div', 'dc-chip' + (dcFilter === k.id ? ' on' : ''), k.label));
            onTap(chip, function (e) {
                e.stopPropagation();
                dcFilter = k.id;
                dcRerender();
            });
        });
        wrap.appendChild(chips);

        var shown = data.cars.filter(function (c) { return dcFilter === 'all' || c.kind === dcFilter; });
        var title = DC_KINDS.filter(function (k) { return k.id === dcFilter; })[0];
        var sec = wrap.appendChild(node('div', 'dc-sec'));
        sec.appendChild(node('div', 'dc-sec-title', dcFilter === 'all' ? 'All vehicles' : title.label));
        sec.appendChild(node('div', 'dc-sec-sub', shown.length + ' · price low to high'));
        var grid = wrap.appendChild(node('div', 'dc-grid'));
        shown.forEach(function (car) {
            var tile = grid.appendChild(node('div', 'dc-tile'));
            tile.appendChild(dcWell(car, dcColor[car.id], dcBadges(car, false).slice(0, 1)));
            var b = tile.appendChild(node('div', 'dc-tile-body'));
            b.appendChild(node('div', 'dc-tile-kind', car.hyundai ? 'HYUNDAI' : DC_KIND_LABEL[car.kind]));
            b.appendChild(node('div', 'dc-tile-name', car.name));
            b.appendChild(node('div', 'dc-tile-price', dcMoney(car.price)));
            var fit = dcFit(data, car);
            if (fit) b.appendChild(fit);
            var sw = b.appendChild(node('div', 'dc-tile-swatches'));
            car.colors.slice(0, 8).forEach(function (c) { sw.appendChild(node('span', 'dc-mini')).style.background = c.hex; });
            onTap(tile, function (e) {
                e.stopPropagation();
                dcOpenCar(car);
            });
        });
        if (!shown.length) wrap.appendChild(node('div', 'dc-empty', 'Nothing in this category right now.'));
        wrap.appendChild(node('div', 'dc-foot', 'Prices and stock from the game’s own car dealer. One vehicle per person; it is delivered to your home.'));
        return wrap;
    }

    // ---- vehicle page ----
    // Why the played character cannot buy this one now, or '' when they can.
    function dcBlocker(data, car) {
        if (data.self && DC_TOO_YOUNG[data.self.age_group]) return { text: 'Too young to buy a vehicle', why: fullName(data.self) + ' is too young. An adult in the family can buy one.' };
        var mine = data.owned[data.me];
        if (mine) {
            var have = dcCar(mine.id);
            if (mine.id === car.id) return { text: 'You own this one', why: 'It is already in your garage.' };
            return { text: 'One vehicle per person', why: 'You already own ' + (have ? have.name : mine.id) + '. The dealer sells one vehicle per person.' };
        }
        if (data.money !== null && car.price > data.money) return { text: 'Not enough funds', why: 'You need ' + dcMoney(car.price - data.money) + ' more.' };
        return null;
    }

    function dcSpec(label, value) {
        var row = node('div', 'dc-spec');
        row.appendChild(node('div', 'dc-spec-label', label));
        row.appendChild(node('div', 'dc-spec-value', value));
        return row;
    }

    function renderDreamCarCar(data) {
        dcLastData = data;
        var wrap = node('div', 'dc');
        var car = dcCar(dcOpenId);
        wrap.appendChild(subHeader('dccar', car ? car.name : 'Vehicle'));
        if (!car) {
            wrap.appendChild(node('div', 'dc-empty', 'This vehicle is no longer for sale.'));
            return wrap;
        }
        var colorId = dcColor[car.id] || (car.colors[0] && car.colors[0].id) || '';
        var stage = wrap.appendChild(node('div', 'dc-stage'));
        stage.appendChild(dcWell(car, colorId, dcBadges(car, false), true));

        var titleRow = wrap.appendChild(node('div', 'dc-title-row'));
        var main = titleRow.appendChild(node('div', 'dc-title-main'));
        main.appendChild(node('div', 'dc-kicker', car.hyundai ? 'HYUNDAI' : DC_KIND_LABEL[car.kind]));
        main.appendChild(node('div', 'dc-name', car.name));
        var tags = main.appendChild(node('div', 'dc-tags'));
        [car.used ? 'Pre-owned' : 'New', car.hydrogen ? 'Hydrogen' : car.electric ? 'Electric' : '', car.colors.length + ' colours']
            .filter(Boolean).forEach(function (t) { tags.appendChild(node('div', 'dc-tag', t)); });
        var priceBlock = titleRow.appendChild(node('div', 'dc-price-block'));
        priceBlock.appendChild(node('div', 'dc-price', dcMoney(car.price)));
        if (data.money !== null) {
            var left = data.money - car.price;
            priceBlock.appendChild(node('div', 'dc-price-note' + (left < 0 ? ' short' : ''), left < 0 ? dcMoney(-left) + ' short' : dcMoney(left) + ' left after'));
        }

        // Colour.
        var paint = wrap.appendChild(node('div', 'dc-panel'));
        var head = paint.appendChild(node('div', 'dc-panel-head'));
        head.appendChild(node('div', 'dc-panel-title', 'COLOUR'));
        head.appendChild(node('div', 'dc-panel-value', colorId));
        var sw = paint.appendChild(node('div', 'dc-swatches'));
        car.colors.forEach(function (c) {
            var s = sw.appendChild(node('div', 'dc-swatch' + (c.id === colorId ? ' on' : '')));
            s.style.background = c.hex;
            onTap(s, function (e) {
                e.stopPropagation();
                if (dcBuy && dcBuy.state === 'running') return;
                dcColor[car.id] = c.id;
                dcConfirm = false;
                dcRerender();
            });
        });

        // About and specs.
        var about = wrap.appendChild(node('div', 'dc-panel'));
        about.appendChild(node('div', 'dc-panel-title', 'ABOUT'));
        about.appendChild(node('div', 'dc-about', car.about || 'A ' + DC_KIND_LABEL[car.kind].toLowerCase() + ' from the city’s dealer.'));
        var specs = wrap.appendChild(node('div', 'dc-panel'));
        specs.appendChild(node('div', 'dc-panel-title', 'AT A GLANCE'));
        specs.appendChild(dcSpec('Type', { car: 'Car', moto: 'Motorbike', scooter: 'Scooter', bike: 'Bicycle' }[car.kind]));
        specs.appendChild(dcSpec('Condition', car.used ? 'Pre-owned' : 'New'));
        if (car.hyundai) specs.appendChild(dcSpec('Make', 'Hyundai'));
        if (dcDoors[car.id]) specs.appendChild(dcSpec('Doors', String(dcDoors[car.id])));
        specs.appendChild(dcSpec('Drive', car.hydrogen ? 'Hydrogen fuel cell' : car.electric ? 'Electric' : car.kind === 'bike' ? 'Pedal power' : 'Petrol'));
        specs.appendChild(dcSpec('Delivery', 'To your home'));

        wrap.appendChild(dcBuyArea(data, car, colorId));
        return wrap;
    }

    // ---- buying ----
    function dcBuyArea(data, car, colorId) {
        var box = node('div');
        var b = dcBuy && dcBuy.carId === car.id ? dcBuy : null;
        if (b && b.state === 'running') {
            var sheet = box.appendChild(node('div', 'dc-sheet'));
            sheet.appendChild(node('div', 'dc-sheet-title', 'Buying ' + car.name + '…'));
            var steps = sheet.appendChild(node('div', 'dc-steps'));
            DC_STEPS.forEach(function (label, i) {
                var st = steps.appendChild(node('div', 'dc-step' + (i < b.step ? ' done' : i === b.step ? ' now' : '')));
                st.appendChild(node('span', 'dc-step-mark'));
                st.appendChild(node('span', null, label));
            });
            box.appendChild(node('div', 'dc-buy-why', 'The city’s dealer opens on the game’s phone for a moment to take your order.'));
            return box;
        }
        if (b && b.state === 'done') {
            var done = box.appendChild(node('div', 'dc-done'));
            done.appendChild(node('div', 'dc-done-title', 'It’s yours.'));
            done.appendChild(node('div', 'dc-done-sub', car.name + ' in ' + (b.color || colorId) + ', paid ' + dcMoney(car.price) + '. It waits for you at home.'));
            var g = box.appendChild(node('div', 'dc-alt', 'See it in your garage'));
            onTap(g, function (e) {
                e.stopPropagation();
                dcBuy = null;
                dcTab = 'garage';
                open('dcgarage');
            });
            return box;
        }
        if (b && b.state === 'failed') {
            var fail = box.appendChild(node('div', 'dc-fail'));
            fail.appendChild(node('div', 'dc-fail-title', 'The purchase did not go through'));
            fail.appendChild(node('div', 'dc-fail-sub', b.why || 'The game did not hand over the vehicle.'));
        }
        var block = dcBlocker(data, car);
        if (block) {
            box.appendChild(node('div', 'dc-buy off', block.text));
            box.appendChild(node('div', 'dc-buy-why', block.why));
            return box;
        }
        if (dcConfirm) {
            var s = box.appendChild(node('div', 'dc-sheet'));
            s.appendChild(node('div', 'dc-sheet-title', 'Confirm your order'));
            var line = function (label, value, cls) {
                var l = s.appendChild(node('div', 'dc-sheet-line' + (cls ? ' ' + cls : '')));
                l.appendChild(node('span', null, label));
                l.appendChild(node('b', null, value));
            };
            line('Vehicle', car.name);
            line('Colour', colorId);
            line('Buyer', data.self ? fullName(data.self) : 'You');
            if (data.money !== null) line('Funds after', dcMoney(data.money - car.price));
            line('Total', dcMoney(car.price), 'total');
            var row = s.appendChild(node('div', 'dc-sheet-row'));
            var cancel = row.appendChild(node('div', 'dc-sheet-btn', 'Cancel'));
            var go = row.appendChild(node('div', 'dc-sheet-btn go', 'Buy now'));
            onTap(cancel, function (e) {
                e.stopPropagation();
                dcConfirm = false;
                dcRerender();
            });
            onTap(go, function (e) {
                e.stopPropagation();
                dcConfirm = false;
                dcStartBuy(data, car, colorId);
            });
            return box;
        }
        var buy = box.appendChild(node('div', 'dc-buy', 'Buy for ' + dcMoney(car.price)));
        onTap(buy, function (e) {
            e.stopPropagation();
            dcConfirm = true;
            dcRerender();
        });
        box.appendChild(node('div', 'dc-buy-why', 'Paid from the household funds. One vehicle per person.'));
        return box;
    }

    // A purchase goes through the game's own dealer: its phone is opened on the car app, the
    // vehicle and colour are picked there and its Buy is confirmed, so the game itself checks the
    // buyer, takes the money and delivers the vehicle (no mod can send the game's purchase request).
    // The game's phone shows for a few seconds while this runs and is closed again afterwards.
    // Clicks call the buttons directly (force), since this phone may lie over the game's.
    var DC_STEPS = ['Opening the dealer', 'Paying', 'Handing over the keys'];
    var DC_POLL_MS = 250;
    var DC_WAIT_MS = 5000;

    function dcSleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    // What the last purchase went through, step by step, kept in vehicle/buylog.cfg.
    var dcTrace = [];
    function dcLog(s) { dcTrace.push(new Date().toISOString().slice(11, 19) + ' ' + s); }

    function dcWalk(n, fn) {
        if (!n || typeof n !== 'object') return;
        fn(n);
        Object.keys(n).forEach(function (k) { if (Array.isArray(n[k])) n[k].forEach(function (c) { dcWalk(c, fn); }); });
    }

    function dcFind(tree, re) {
        var hit = null;
        dcWalk(tree, function (n) { if (!hit && n.ref && re.test(n.ref)) hit = n; });
        return hit;
    }

    function dcAll(tree, re) {
        var out = [];
        dcWalk(tree, function (n) { if (n.ref && re.test(n.ref)) out.push(n); });
        return out;
    }

    function dcClick(ref) { return call('ui.click', { ref: ref, Force: true }); }

    function dcPhoneOpen() {
        return call('ui.list_windows', {}).then(function (w) {
            return ((w && w.windows) || []).some(function (x) { return x.ui_type === 'Smartphone'; });
        });
    }

    function dcPhoneTree() { return soft(call('ui.get_tree', { Window: 'Smartphone', max_nodes: 3000 })); }

    // The first widget matching re on the game's phone, waited for; fails with why.
    function dcWaitFor(re, why, ms) {
        var until = Date.now() + (ms || DC_WAIT_MS);
        return (function poll() {
            return dcPhoneTree().then(function (t) {
                var n = dcFind(t, re);
                if (n) return n;
                if (Date.now() > until) throw new Error(why);
                return dcSleep(DC_POLL_MS).then(poll);
            });
        })();
    }

    // The open game popup whose id passes test, waited for; null when none came.
    function dcWaitPopup(test, ms) {
        var until = Date.now() + (ms || DC_WAIT_MS);
        return (function poll() {
            return soft(call('ui.get_blocking', {})).then(function (b) {
                var hit = null;
                ((b && b.popups) || []).forEach(function (p) { if (!hit && test(p)) hit = p; });
                if (hit) return hit;
                if (Date.now() > until) return null;
                return dcSleep(DC_POLL_MS).then(poll);
            });
        })();
    }

    function dcIsVehiclePopup(p) { return /Vehicle/i.test(String(p.popup_id || '')); }

    // The game's phone, on its car app's Buy tab.
    function dcOpenDealer() {
        return dcPhoneOpen().then(function (isOpen) {
            if (isOpen) return null;
            return call('ui.find', { Window: 'Hud', Name: 'BW_Button_SmartPhone' }).then(function (hits) {
                var btn = (Array.isArray(hits) ? hits : []).filter(function (h) { return h.ref; })[0];
                if (!btn) throw new Error('The game’s phone button is not on screen.');
                return dcClick(btn.ref);
            });
        }).then(function () {
            return dcWaitFor(/(WBP_Mobile_AppIcon_Car\/BW_Button|BW_WBP_CarButton_Buy\/BW_Button_Car|WBP_Mobile_Car_Detail\/BW_Button_Back)$/, 'The game’s phone did not open.');
        }).then(function () {
            return dcPhoneTree();
        }).then(function (t) {
            var back = dcFind(t, /WBP_Mobile_Car_Detail\/BW_Button_Back$/);
            if (back && back.rect) return dcClick(back.ref).then(function () { return dcSleep(600); }).then(dcPhoneTree);
            return t;
        }).then(function (t) {
            var app = dcFind(t, /WBP_Mobile_AppIcon_Car\/BW_Button$/);
            if (app && !dcFind(t, /BW_WBP_CarButton_Buy\/BW_Button_Car$/)) return dcClick(app.ref);
            return null;
        }).then(function () {
            return dcWaitFor(/BW_WBP_CarButton_Buy\/BW_Button_Car$/, 'The game’s car app did not open.');
        }).then(function (tab) {
            return dcClick(tab.ref);
        }).then(function () {
            return dcWaitFor(/BW_TileView_CarSlot$/, 'The game’s car list did not open.');
        });
    }

    // Scrolls the game's car list to the vehicle's card and presses its 购买, which opens the
    // vehicle's own screen. Cards carry the vehicle's display name, the same text as car.name.
    // The list shows three rows of two; it is moved one row at a time, counted here, up to the
    // largest offset the list reports.
    function dcOpenCard(list, car) {
        var listRef = list.ref;
        var offset = 0;
        var max = null;
        return call('ui.scroll', { ref: listRef, To: 'start' }).then(function () {
            return (function look() {
                return dcSleep(400).then(function () {
                    return call('ui.find', { Window: 'Smartphone', Role: 'entry', Text: car.name, Limit: 20 });
                }).then(function (hits) {
                    var card = null;
                    (Array.isArray(hits) ? hits : []).forEach(function (e) {
                        if (!card && e.ref && String(e.text || '').trim() === car.name && e.ref.indexOf(listRef + '/') === 0) card = e;
                    });
                    dcLog('look offset=' + offset + ' max=' + max + ' hits=' + snippet(hits));
                    if (card) return dcClick(card.ref + '/BW_Button_Common/BW_Button');
                    if (max !== null && offset >= max) throw new Error('The game’s dealer does not list ' + car.name + '.');
                    offset += 2;
                    return call('ui.scroll', { ref: listRef, To: 'offset', Offset: offset }).then(function (r) {
                        if (r && typeof r.max === 'number') max = r.max;
                        if (max !== null && offset > max) offset = max;
                        if (max === null && offset > 60) throw new Error('The game’s car list does not scroll.');
                        dcLog('scroll ' + snippet(r));
                    }).then(look);
                });
            })();
        }).then(function () {
            return dcWaitFor(/WBP_Mobile_Car_Detail\/BW_Button_Buy\/BW_Button$/, 'The game’s dealer did not open ' + car.name + '.');
        });
    }

    // Picks the colour on the vehicle's screen: its swatches are in the table's colour order. The
    // swatches are built a moment after the screen's Buy button, so they are waited for.
    function dcPickColor(car, colorId) {
        var idx = -1;
        car.colors.forEach(function (c, i) { if (c.id === colorId) idx = i; });
        if (idx < 0) return Promise.resolve();
        var until = Date.now() + DC_WAIT_MS;
        return (function poll() {
            return dcPhoneTree().then(function (t) {
                var sw = dcAll(t, /WBP_Mobile_Car_Detail\/.*WBP_ColorPalette_Slot02_C_\d+\/BW_Button$/).filter(function (n) { return n.rect; });
                if (sw.length < car.colors.length && Date.now() < until) return dcSleep(DC_POLL_MS).then(poll);
                dcLog('swatches ' + sw.length + '/' + car.colors.length + ' pick ' + idx);
                sw.sort(function (a, b) { return a.rect[0] - b.rect[0]; });
                if (!sw[idx]) throw new Error('The game’s dealer does not offer ' + colorId + ' here.');
                return dcClick(sw[idx].ref).then(function () { return dcSleep(400); });
            });
        })();
    }

    // Buy, then the game's confirmation, then its answer: the success popup, or any other vehicle
    // popup, whose text is the game's reason.
    function dcConfirmOrder(buyRef) {
        return dcClick(buyRef).then(function () {
            return dcWaitPopup(dcIsVehiclePopup);
        }).then(function (p) {
            if (!p) throw new Error('The game’s dealer did not ask to confirm the order.');
            if (p.popup_id !== 'VehiclePurchaseConfirm') return p;
            return call('ui.click_popup_button', { popup_id: p.popup_id, list_key: 'btn0' }).then(function () {
                return dcWaitPopup(function (q) { return dcIsVehiclePopup(q) && q.popup_id !== 'VehiclePurchaseConfirm'; }, 8000);
            });
        }).then(function (p) {
            if (!p) throw new Error('The game’s dealer did not answer.');
            var ok = p.popup_id === 'VehiclePurchaseSuccess';
            var why = String(p.desc || '').split(/\r?\n/)[0];
            return soft(call('ui.click_popup_button', { popup_id: p.popup_id, list_key: 'btn0' })).then(function () {
                if (!ok) throw new Error(why || 'The game’s dealer turned the order down.');
            });
        });
    }

    // Closes the game's phone the way ESC does, and restarts the clock if it ran before.
    function dcCloseDealer(wasRunning) {
        return (function close(n) {
            return soft(dcPhoneOpen()).then(function (isOpen) {
                if (isOpen !== true || n > 4) return null;
                return soft(call('ui.dismiss', { max_steps: 1 })).then(function () { return dcSleep(400); }).then(function () { return close(n + 1); });
            });
        })(0).then(function () {
            if (!wasRunning) return null;
            return soft(call('environment.get_time', {})).then(function (t) {
                if (!t || t.paused !== true) return null;
                return soft(call('ui.find', { Window: 'Hud', Name: 'BW_Button_Speed1' })).then(function (hits) {
                    var btn = (Array.isArray(hits) ? hits : []).filter(function (h) { return h.ref; })[0];
                    return btn ? soft(dcClick(btn.ref)) : null;
                });
            });
        });
    }

    function dcStartBuy(data, car, colorId) {
        if (dcBuy && dcBuy.state === 'running') return;
        var me = data.me;
        var b = dcBuy = { carId: car.id, color: colorId, state: 'running', step: 0, why: '' };
        var wasRunning = false;
        var stepTo = function (n) {
            b.step = n;
            dcRerender();
        };
        dcRerender();
        dcTrace = [];
        dcLog('buy ' + car.id + ' "' + car.name + '" ' + colorId + ' for ' + me);
        soft(call('environment.get_time', {}))
            .then(function (t) {
                wasRunning = !!t && t.paused === false;
                return dcOpenDealer();
            })
            .then(function (list) {
                dcLog('list ' + (list && list.ref));
                return dcOpenCard(list, car);
            })
            .then(function (buy) {
                dcLog('detail ' + (buy && buy.ref));
                return dcPickColor(car, colorId).then(function () {
                    stepTo(1);
                    return dcConfirmOrder(buy.ref);
                });
            })
            .then(function () {
                stepTo(2);
                var until = Date.now() + DC_WAIT_MS;
                return (function wait() {
                    return dcOwned(me).then(function (o) {
                        if (o && o.id === car.id) return o;
                        if (Date.now() > until) throw new Error('The game took the order but did not hand over the vehicle.');
                        return dcSleep(500).then(wait);
                    });
                })();
            })
            .then(function (o) {
                b.state = 'done';
                b.color = o.color || colorId;
                dcLog('done ' + o.id + ' ' + o.color);
            }, function (err) {
                b.state = 'failed';
                b.why = errText(err);
                dcLog('failed ' + b.why);
            })
            .then(function () { return dcCloseDealer(wasRunning); })
            .then(function () {
                return soft(call('uimod.cfg_save', { mod_id: SMS_MOD, section: 'ui/phone/vehicle', key: 'buylog', value: dcTrace.join('\n') }));
            })
            .then(function () {
                if (dcBuy === b) refresh();
            });
    }

    // ---- garage ----
    function renderDreamCarGarage(data) {
        dcLastData = data;
        dcTab = 'garage';
        var wrap = node('div', 'dc');
        wrap.appendChild(subHeader('dcgarage', 'Dream Car'));
        var count = 0;
        data.members.forEach(function (m) { if (data.owned[String(m.entity_id)]) count++; });
        wrap.appendChild(dcHeader(data, 'Your garage', count ? count + (count === 1 ? ' vehicle' : ' vehicles') + ' in the family.' : 'Nobody in the family owns a vehicle yet.'));
        wrap.appendChild(dcSegment());
        if (!count) {
            // An empty garage invites to the showroom, with the dealer's featured vehicle.
            var feat = dcFeatured(data.cars, data.env);
            var invite = wrap.appendChild(node('div', 'dc-feature'));
            if (feat) invite.appendChild(dcWell(feat, dcColor[feat.id], [], true));
            var ib = invite.appendChild(node('div', 'dc-feature-body'));
            var it = ib.appendChild(node('div', 'dc-feature-text'));
            it.appendChild(node('div', 'dc-feature-kicker', 'YOUR FIRST RIDE'));
            it.appendChild(node('div', 'dc-feature-name', 'The garage is empty'));
            it.appendChild(node('div', 'dc-feature-price', 'Bicycles start at ' + dcMoney(data.cars.length ? data.cars[0].price : 0) + '.'));
            ib.appendChild(node('div', 'dc-cta', 'Showroom'));
            onTap(invite, function (e) {
                e.stopPropagation();
                dcTab = 'showroom';
                open('dreamcar');
            });
            wrap.appendChild(node('div', 'dc-sec')).appendChild(node('div', 'dc-sec-title', 'The family'));
        }
        var people = data.members.slice().sort(function (a, b) {
            return (String(b.entity_id) === data.me) - (String(a.entity_id) === data.me);
        });
        people.forEach(function (m) {
            var id = String(m.entity_id);
            var o = data.owned[id];
            var car = o ? dcCar(o.id) : null;
            if (o && car) {
                var c = wrap.appendChild(node('div', 'dc-car'));
                c.appendChild(dcWell(car, o.color, dcBadges(car, false), true));
                var body = c.appendChild(node('div', 'dc-car-body'));
                var text = body.appendChild(node('div', 'dc-car-text'));
                text.appendChild(node('div', 'dc-car-owner', (id === data.me ? 'You · ' : '') + fullName(m)));
                text.appendChild(node('div', 'dc-car-name', car.name));
                var color = null;
                car.colors.forEach(function (x) { if (x.id === o.color) color = x; });
                var line = text.appendChild(node('div', 'dc-car-color'));
                if (color) line.appendChild(node('span', 'dc-mini')).style.background = color.hex;
                line.appendChild(node('span', null, (o.color || 'Factory colour') + ' · bought for ' + dcMoney(car.price)));
                onTap(c, function (e) {
                    e.stopPropagation();
                    dcOpenCar(car);
                });
                return;
            }
            var row = wrap.appendChild(node('div', 'dc-nocar'));
            row.appendChild(node('div', 'dc-nocar-who', (id === data.me ? 'You · ' : '') + fullName(m)));
            row.appendChild(node('div', 'dc-nocar-sub', o ? o.id : DC_TOO_YOUNG[m.age_group] ? 'Too young' : 'No vehicle'));
        });
        wrap.appendChild(node('div', 'dc-foot', 'Each vehicle waits at home and comes along when its owner travels.'));
        return wrap;
    }

    function dreamCarGlyph() {
        var svg = glyphSvg('0 0 24 24');
        glyphPath(svg, 'M5.2 10.4l1.5-3.6c.4-.9 1.2-1.4 2.2-1.4h6.2c1 0 1.8.5 2.2 1.4l1.5 3.6c1 .3 1.7 1.2 1.7 2.3v3.1c0 .5-.4.9-.9.9h-.9a2.3 2.3 0 0 1-4.5 0H9.8a2.3 2.3 0 0 1-4.5 0h-.9a.9.9 0 0 1-.9-.9v-3.1c0-1.1.7-2 1.7-2.3zm2.1-.3h9.4l-1.1-2.7a.9.9 0 0 0-.8-.5H9.2a.9.9 0 0 0-.8.5zM7.6 14.9a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm8.8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', '#ffffff', 'evenodd');
        return svg;
    }

    // ------------------------------------------------------------------
    // News: a local editorial preview. The stories and artwork are built in, so the app opens
    // without a network. A live open-source news feed can replace NW_STORIES later without
    // changing the page structure.
    // ------------------------------------------------------------------
    var NW_STORIES = [
        {
            id: 'night-train', cat: 'City', art: 'city', time: '6:10 AM', read: '7 min',
            byline: 'Mara Ellison', title: 'The 2 a.m. train that is quietly changing how the city works',
            standfirst: 'A year after the night line opened, the people who keep the city running say the biggest change is not the route. It is the hour.',
            body: [
                'At ten past two, the platform at East Market is almost empty. A baker in a flour-dusted jacket sits beside a nurse coming off a double shift. A cleaner charges her phone from the only free socket. Fifteen minutes later, the train arrives and the city begins its quiet second day.',
                'The night line was introduced as a modest transport experiment: four stations, one train every twenty minutes, and a promise to review the service after twelve months. Officials expected students and late diners. They did not expect the people who make the early city possible.',
                'Ridership figures released this week show the service carrying more passengers between two and four in the morning than it did during its first three months. The largest growth is among hospital staff, warehouse workers and bakers. For many, the train has turned an impossible commute into a twenty-minute nap.',
                'There are still problems. The eastern interchange closes for maintenance twice a month, and buses do not always wait for a delayed train. But on the platform, the complaints are practical rather than fundamental. The question now is not whether the night line should exist. It is how far it should go.',
                'A decision on extending the route is expected before winter. For the baker and the nurse, that decision cannot come soon enough. They have started saving each other a seat.'
            ],
            quote: 'For once, the city waits for the people who keep it running.'
        },
        {
            id: 'rooftop-forest', cat: 'Climate', art: 'climate', time: '5:48 AM', read: '5 min',
            byline: 'Jon Bell', title: 'A rooftop forest is cooling the old market district, one building at a time',
            standfirst: 'Three summers of sensors show what shopkeepers already suspected: the green roofs are making the street below more bearable.',
            body: [
                'From street level, the change is easy to miss. Look up and the old market district has grown a second, softer skyline: clipped hedges, climbing vines and rows of small trees in deep planters.',
                'The project began as a heat study. Twenty-two roofs were fitted with soil, drainage and drought-tolerant plants, then watched by a network of cheap temperature sensors. The results were modest but stubbornly consistent. On the hottest afternoons, the shaded side of the street ran nearly two degrees cooler than comparable blocks nearby.',
                'Shopkeepers report lower air-conditioning bills and more people lingering outdoors. Residents talk about something harder to measure: the sound of birds in the morning, and the feeling that the building has become part of the street rather than a wall above it.',
                'The scheme is not a substitute for shade at ground level, and the initial cost remains out of reach for many small landlords. The city is now considering a shared fund that would let neighbouring buildings apply together.',
                'For now, the experiment has done what good public projects often do: it has made a better future visible, one rooftop at a time.'
            ],
            quote: 'The street below is two degrees cooler, and the pavement stays busy after five.'
        },
        {
            id: 'warm-coral', cat: 'Science', art: 'science', time: '5:20 AM', read: '6 min',
            byline: 'Dr. Nia Okafor', title: 'A coral that likes warm water gives researchers a cautious reason to hope',
            standfirst: 'A small colony off the southern reef has survived four heat waves. Scientists are careful not to call it a rescue.',
            body: [
                'The colony is not much to look at: a spread of brownish branches no wider than a dining table. But its survival has made it one of the most closely watched pieces of reef in the region.',
                'During the last four marine heat waves, nearby corals bleached and in some cases died. This colony kept its colour. Samples suggest it hosts a different mix of microscopic algae, partners that appear to tolerate warmer water.',
                'The finding is promising, not conclusive. A single resilient colony does not rebuild a reef, and moving corals between sites can introduce disease or weaken local populations. Researchers are testing whether the algae can be shared naturally, without intervention.',
                'What excites the team most is the method: inexpensive sensors, repeated photographs from the same angles, and a network of local divers who know the reef in every season. The data is richer than a single expedition could produce.',
                'The next survey begins at the end of the month. The question is no longer whether some corals can endure a hotter ocean. It is what else they need in order to stay.'
            ],
            quote: 'One surviving colony is a clue, not a cure.'
        },
        {
            id: 'four-am-bakery', cat: 'Culture', art: 'food', time: '4:55 AM', read: '4 min',
            byline: 'Lena Park', title: 'The bakery that opens at four, and the street that slows down around it',
            standfirst: 'Before the buses start, one corner of the old quarter smells of butter and cardamom. The regulars say the queue is part of the recipe.',
            body: [
                'The lights come on at four. By half past, the first tray is out and the first customer is already leaning against the window, still half asleep.',
                'The bakery has no sign, no delivery app and no plan to expand. It opens when the dough is ready and closes when the shelves are empty. Somehow, that has been enough for nineteen years.',
                'What has changed is the street. A bus driver stops for a paper bag before his shift. Nurses arrive in small groups after the night handover. A group of teenagers, improbably awake, debate which pastry deserves the last of their money.',
                'The owner says she has been offered money to franchise the name. She has refused every time. The bakery works, she explains, because she can still taste every batch and recognise every face.',
                'By nine, the shelves are bare. The shutters come down, the street returns to its ordinary pace, and the queue begins again tomorrow at four.'
            ],
            quote: 'The queue is not a delay. It is where the neighbourhood says good morning.'
        },
        {
            id: 'family-final', cat: 'Sport', art: 'sport', time: '6:02 AM', read: '5 min',
            byline: 'Theo Grant', title: 'The final is a family affair: three siblings, two teams, one dinner table',
            standfirst: 'On Sunday, the city final will put two sisters on opposite benches and their brother in the stands, wearing a shirt he refuses to explain.',
            body: [
                'The fixture list made the joke before anyone else could. Northside against Riverside, the two best teams in the city, and two sisters who grew up sharing a bedroom.',
                'The elder sister coaches Northside. The younger plays midfield for Riverside. Their brother, a former referee, has tickets for the family section and a shirt with both club colours stitched down the middle.',
                'At home, the rivalry is carefully managed. Dinner is early, phones go face down, and nobody mentions the league table. Their mother has one rule: whatever happens on Sunday, everyone comes back for soup.',
                'Both teams say the match is bigger than the family story. It is also, unmistakably, the family story. Ticket sales have doubled, and the local radio station is sending a crew to the mother’s kitchen.',
                'The sisters have not spoken about tactics. They have spoken about soup. That, their brother says, is how you know it is serious.'
            ],
            quote: 'Whatever happens on Sunday, everyone comes back for soup.'
        },
        {
            id: 'bench-map', cat: 'City', art: 'map', time: '7:05 AM', read: '3 min',
            byline: 'Iris Chen', title: 'The bench map: 140 places to sit and watch the city go by',
            standfirst: 'A hand-drawn guide started as a joke between friends. Now it is the most useful thing on the neighbourhood noticeboard.',
            body: [
                'It began with a disagreement about the best bench in the city. One friend preferred the view of the river. Another insisted the real answer was the bench outside the library, where the afternoon light lands on the reading room windows.',
                'The argument became a map. Fourteen benches, each with a note about shade, noise and the best hour to arrive. Within a week, strangers had added their own favourites in pencil.',
                'The map now lists 140 places, from a stone ledge behind the station to a folding chair that appears outside a repair shop whenever the owner is not busy. It is printed on paper, updated by hand, and pinned to the noticeboard by the market.',
                'The creators have resisted an app. A map you can hold, they say, invites conversation. Someone always leans over to point out a bench you have missed.',
                'The latest addition is marked in red ink: a bench with a good view of the sunset, a short walk from the last stop on the night line.'
            ],
            quote: 'A map you can hold invites someone to lean over and add a place you missed.'
        },
        {
            id: 'bedroom-records', cat: 'Culture', art: 'culture', time: '6:35 AM', read: '8 min',
            byline: 'Samir Vale', title: 'Six bedroom records that gave the city its new sound',
            standfirst: 'No studio, no budget, no permission. A generation of musicians turned small rooms into the city’s most interesting venue.',
            body: [
                'The sound is hard to describe until you hear it in context: soft keyboards, field recordings from the market, a drum machine that seems to be thinking out loud. It could only have been made in a room with a window open.',
                'Over the past three years, a loose group of musicians has released a series of records recorded at home. The files are exchanged online, but the music belongs to particular streets. You can hear the 6 a.m. tram in one track and a neighbour’s radio in another.',
                'The records have found an audience far beyond the city. Tourists ask about the venues; there are none. Fans ask about the studios; they are bedrooms, kitchens and a converted storage cupboard.',
                'The musicians are wary of the attention. They worry that a scene built on low rents and borrowed equipment will be packaged too quickly. For now, they keep playing small shows and splitting the door money.',
                'A compilation is due next month. It will be pressed in a limited run and sold at the market, next to the bakery. The cover is a photograph of an open window.'
            ],
            quote: 'The room is not a limitation. It is the instrument.'
        },
        {
            id: 'repair-cafe', cat: 'Science', art: 'science', time: '5:36 AM', read: '4 min',
            byline: 'Ruth Adeyemi', title: 'The repair café where a broken radio becomes a lesson in patience',
            standfirst: 'Every Saturday, a church hall fills with faulty lamps, loose handles and people willing to learn how things work.',
            body: [
                'The radio arrived in three pieces and a shoebox. Its owner had been told it was not worth fixing. Forty minutes later, a retired engineer had found a cracked solder joint and a room full of spectators had learned what a multimeter does.',
                'The repair café runs on a simple idea: bring something broken, sit with a volunteer, and try to fix it together. Nothing is done behind a curtain. The point is not only the object but the confidence that comes from opening it.',
                'Some repairs take minutes. Others are declared beyond help, which is its own kind of useful answer. Volunteers log every fault, building a quiet archive of which products fail and how.',
                'The café has become a Saturday institution. Teenagers come to learn to solder; older residents bring stories attached to objects. A lamp with a cracked base turned out to have crossed the country three times.',
                'The radio went home working. Its owner stayed to help with the next one.'
            ],
            quote: 'Nothing is done behind a curtain. The point is to open it.'
        },
        {
            id: 'quiet-delivery', cat: 'Climate', art: 'climate', time: '6:58 AM', read: '5 min',
            byline: 'Jon Bell', title: 'The quiet delivery hour that shops and residents both want to keep',
            standfirst: 'For six months, heavy vans were kept out of the old quarter before eight. The streets are calmer, but the experiment is not free.',
            body: [
                'The first thing residents noticed was not the silence. It was the sleep. With deliveries moved to cargo bikes and a single shared van, the 5 a.m. tailgate slams stopped.',
                'The pilot covered eleven streets for six months. Shops received deliveries through a consolidation centre on the edge of the quarter. Drivers planned routes together instead of competing for the same kerb.',
                'Not every business benefited. Cafés needed fresh produce earlier than the shared vans could provide, and two shops opted out. The scheme’s organizers say those exceptions are part of the design, not a failure.',
                'Measurements showed a modest drop in morning traffic and a larger drop in noise complaints. The most persuasive evidence came from the pavement: more people walking to work, and more children crossing the street without a hand held tight.',
                'The council will vote on making the scheme permanent in spring. Shopkeepers have asked for one change: a later collection window for bakery waste. The quiet hour, they say, should not make the bread wait.'
            ],
            quote: 'The city did not get slower. It got quieter enough to notice itself.'
        },
        {
            id: 'noodle-shop', cat: 'Culture', art: 'food', time: '7:12 AM', read: '6 min',
            byline: 'Lena Park', title: 'After forty years, the noodle shop has a new recipe: none',
            standfirst: 'The menu has not changed since 1986. That, the owner says, is why people keep coming back.',
            body: [
                'There are eight things on the menu and one of them is sold out by noon. The tables are small, the tea is hot, and the handwritten prices have been corrected so many times that the paper looks like a map.',
                'The shop opened forty years ago. Its recipes came from a family kitchen and have survived three renovations, two rent increases and a brief, unsuccessful experiment with a second location.',
                'The current owner took over from her mother without changing the stock or the supplier. Regulars say they can taste the continuity. A bowl ordered after a long absence arrives exactly as remembered.',
                'Younger customers have discovered the place through photographs online. The owner is amused by the attention but wary of the queue. She has refused to add a waiting list. If you want the noodles, you wait like everyone else.',
                'Asked about the future, she points to the kitchen. Her niece is learning the broth. The recipe is not written down. It is taught by standing beside someone, tasting, and trying again.'
            ],
            quote: 'The recipe is not written down. It is taught by standing beside someone.'
        }
    ];
    var NW_CATS = ['Top', 'City', 'Science', 'Culture', 'Sport'];
    var nwCat = 'Top';
    var nwOpenId = '';
    var nwSaved = {};
    var NW_ART = {
        city: { bg: '#EBC9B7', ink: '#3A211A', accent: '#D25734', soft: '#F5E4D9' },
        climate: { bg: '#C8DED5', ink: '#173B33', accent: '#2E7D6E', soft: '#E6F1EC' },
        science: { bg: '#CDD6ED', ink: '#202B55', accent: '#4562C4', soft: '#E8ECF9' },
        culture: { bg: '#E6CBD4', ink: '#3D1D2A', accent: '#A44A6C', soft: '#F5E6EB' },
        sport: { bg: '#CFE0C9', ink: '#193A25', accent: '#2A7A4B', soft: '#E9F1E5' },
        food: { bg: '#EFD4A9', ink: '#3D2812', accent: '#B36B27', soft: '#F9EBD5' },
        map: { bg: '#E8DCC5', ink: '#343026', accent: '#B05235', soft: '#F6EEE0' }
    };

    function nwFind(id) {
        for (var i = 0; i < NW_STORIES.length; i++) if (NW_STORIES[i].id === id) return NW_STORIES[i];
        return null;
    }

    function loadNews() {
        return getEnv().then(function (env) { return { env: env || {} }; },
            function () { return { env: {} }; });
    }

    function nwEdition(env) {
        var day = env && env.day ? String(env.day) : '1016';
        var season = env && env.season ? String(env.season) : 'Autumn';
        return 'NO. ' + day + ' · ' + season.toUpperCase();
    }

    // A small editorial illustration, drawn rather than downloaded: the same artwork language
    // as a printed section front, without depending on a live image service.
    function nwArt(story, variant) {
        var p = NW_ART[story.art] || NW_ART.city;
        var box = node('div', 'nw-art' + (variant ? ' ' + variant : ''));
        box.style.backgroundColor = p.bg;
        var svg = svgEl('svg');
        svg.setAttribute('viewBox', '0 0 320 180');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        svg.setAttribute('class', 'nw-art-svg');
        if (story.art === 'city') {
            glyphShape(svg, 'circle', { cx: '254', cy: '48', r: '31', fill: p.soft, opacity: '0.95' });
            glyphShape(svg, 'rect', { x: '24', y: '91', width: '34', height: '89', fill: p.ink, opacity: '0.9' });
            glyphShape(svg, 'rect', { x: '65', y: '66', width: '27', height: '114', fill: p.accent });
            glyphShape(svg, 'rect', { x: '99', y: '103', width: '44', height: '77', fill: p.ink, opacity: '0.75' });
            glyphShape(svg, 'rect', { x: '151', y: '78', width: '38', height: '102', fill: p.soft });
            glyphShape(svg, 'rect', { x: '197', y: '112', width: '29', height: '68', fill: p.ink, opacity: '0.58' });
            glyphShape(svg, 'rect', { x: '234', y: '87', width: '59', height: '93', fill: p.accent, opacity: '0.86' });
            glyphShape(svg, 'rect', { x: '0', y: '150', width: '320', height: '2', fill: p.ink, opacity: '0.42' });
        } else if (story.art === 'climate') {
            glyphShape(svg, 'circle', { cx: '238', cy: '47', r: '25', fill: p.soft });
            glyphShape(svg, 'path', { d: 'M-20 94C35 66 70 116 124 90S211 62 340 98V134C267 108 215 140 151 119S42 112-20 140Z', fill: p.accent, opacity: '0.85' });
            glyphShape(svg, 'path', { d: 'M-20 123C45 98 83 145 140 119S231 99 340 132V180H-20Z', fill: p.ink, opacity: '0.78' });
            glyphShape(svg, 'path', { d: 'M23 52c25-18 55-18 80 0M52 76c15-10 32-10 47 0', fill: 'none', stroke: p.ink, 'stroke-width': '2', opacity: '0.42' });
        } else if (story.art === 'science') {
            glyphShape(svg, 'ellipse', { cx: '160', cy: '90', rx: '116', ry: '44', fill: 'none', stroke: p.accent, 'stroke-width': '2', opacity: '0.8', transform: 'rotate(-17 160 90)' });
            glyphShape(svg, 'ellipse', { cx: '160', cy: '90', rx: '78', ry: '78', fill: 'none', stroke: p.ink, 'stroke-width': '1.5', opacity: '0.36' });
            glyphShape(svg, 'circle', { cx: '160', cy: '90', r: '27', fill: p.accent });
            glyphShape(svg, 'circle', { cx: '250', cy: '57', r: '8', fill: p.ink });
            glyphShape(svg, 'circle', { cx: '70', cy: '124', r: '5', fill: p.soft });
            glyphShape(svg, 'circle', { cx: '219', cy: '137', r: '4', fill: p.ink, opacity: '0.55' });
        } else if (story.art === 'culture') {
            glyphShape(svg, 'rect', { x: '31', y: '35', width: '119', height: '146', fill: p.ink, opacity: '0.92' });
            glyphShape(svg, 'circle', { cx: '174', cy: '91', r: '68', fill: p.soft });
            glyphShape(svg, 'circle', { cx: '174', cy: '91', r: '34', fill: p.accent });
            glyphShape(svg, 'rect', { x: '227', y: '54', width: '66', height: '108', fill: p.accent, opacity: '0.62' });
            glyphShape(svg, 'path', { d: 'M54 146C78 104 112 88 132 61', fill: 'none', stroke: p.soft, 'stroke-width': '2.5', opacity: '0.72' });
        } else if (story.art === 'sport') {
            glyphShape(svg, 'path', { d: 'M-20 156C53 113 107 184 172 143S261 97 340 128', fill: 'none', stroke: p.accent, 'stroke-width': '14', opacity: '0.86' });
            glyphShape(svg, 'path', { d: 'M-20 134C55 96 112 160 180 119S268 77 340 104', fill: 'none', stroke: p.ink, 'stroke-width': '2', opacity: '0.44' });
            glyphShape(svg, 'circle', { cx: '249', cy: '52', r: '23', fill: p.soft });
            glyphShape(svg, 'path', { d: 'M238 45h22M234 55h30M243 34l4 34', fill: 'none', stroke: p.ink, 'stroke-width': '1.4', opacity: '0.5' });
        } else if (story.art === 'food') {
            glyphShape(svg, 'circle', { cx: '160', cy: '93', r: '66', fill: p.soft });
            glyphShape(svg, 'circle', { cx: '160', cy: '93', r: '47', fill: 'none', stroke: p.accent, 'stroke-width': '8', opacity: '0.8' });
            glyphShape(svg, 'circle', { cx: '160', cy: '93', r: '26', fill: p.accent, opacity: '0.42' });
            glyphShape(svg, 'path', { d: 'M36 38v105M46 38v105M36 38v35c0 7 10 7 10 0V38M266 38c-14 7-17 32-8 43v62', fill: 'none', stroke: p.ink, 'stroke-width': '3.2', 'stroke-linecap': 'round', opacity: '0.82' });
        } else {
            glyphShape(svg, 'path', { d: 'M19 139C62 100 77 46 140 62s55 68 118 37c23-11 36-6 45 4', fill: 'none', stroke: p.accent, 'stroke-width': '3' });
            glyphShape(svg, 'path', { d: 'M20 40l48 27-14 39 84 12 41-48 66 26', fill: 'none', stroke: p.ink, 'stroke-width': '1.3', opacity: '0.28' });
            glyphShape(svg, 'circle', { cx: '19', cy: '139', r: '7', fill: p.accent });
            glyphShape(svg, 'circle', { cx: '258', cy: '99', r: '7', fill: p.ink });
            glyphShape(svg, 'circle', { cx: '138', cy: '118', r: '4', fill: p.accent, opacity: '0.6' });
        }
        box.appendChild(svg);
        box.appendChild(node('div', 'nw-art-tag', story.cat.toUpperCase()));
        return box;
    }

    function nwSaveButton(story, compact) {
        var saved = !!nwSaved[story.id];
        var b = node('button', 'nw-save' + (saved ? ' on' : '') + (compact ? ' compact' : ''), saved ? 'Saved' : 'Save');
        b.setAttribute('type', 'button');
        onTap(b, function (e) {
            e.stopPropagation();
            nwSaved[story.id] = !nwSaved[story.id];
            b.className = 'nw-save' + (nwSaved[story.id] ? ' on' : '') + (compact ? ' compact' : '');
            b.textContent = nwSaved[story.id] ? 'Saved' : 'Save';
        });
        return b;
    }

    function nwStoryOpen(story) {
        nwOpenId = story.id;
        open('newsdetail');
    }

    function nwMeta(story) {
        var m = node('div', 'nw-meta');
        m.appendChild(node('span', 'nw-meta-dot'));
        m.appendChild(node('span', null, story.time + ' · ' + story.read + ' read'));
        return m;
    }

    function nwHero(story) {
        var c = node('div', 'nw-hero');
        onTap(c, function (e) { e.stopPropagation(); nwStoryOpen(story); });
        c.appendChild(nwArt(story, 'nw-hero-art'));
        var body = c.appendChild(node('div', 'nw-hero-body'));
        var top = body.appendChild(node('div', 'nw-kicker-row'));
        top.appendChild(node('div', 'nw-kicker', story.cat.toUpperCase()));
        top.appendChild(node('div', 'nw-kicker-note', 'LEAD STORY'));
        body.appendChild(node('div', 'nw-hero-title', story.title));
        body.appendChild(node('div', 'nw-hero-deck', story.standfirst));
        var foot = body.appendChild(node('div', 'nw-hero-foot'));
        foot.appendChild(nwMeta(story));
        foot.appendChild(node('div', 'nw-byline', 'By ' + story.byline));
        return c;
    }

    function nwRow(story, number) {
        var row = node('div', 'nw-row');
        onTap(row, function (e) { e.stopPropagation(); nwStoryOpen(story); });
        if (number) row.appendChild(node('div', 'nw-rank', number));
        row.appendChild(nwArt(story, 'nw-row-art'));
        var body = row.appendChild(node('div', 'nw-row-body'));
        body.appendChild(node('div', 'nw-row-kicker', story.cat.toUpperCase()));
        body.appendChild(node('div', 'nw-row-title', story.title));
        body.appendChild(nwMeta(story));
        return row;
    }

    function nwChips() {
        var row = node('div', 'nw-chips');
        NW_CATS.forEach(function (cat) {
            var b = node('button', 'nw-chip' + (cat === nwCat ? ' on' : ''), cat);
            b.setAttribute('type', 'button');
            onTap(b, function (e) {
                e.stopPropagation();
                if (nwCat === cat) return;
                nwCat = cat;
                refresh();
            });
            row.appendChild(b);
        });
        return row;
    }

    function nwSectionHead(title, note) {
        var h = node('div', 'nw-section-head');
        h.appendChild(node('div', 'nw-section-title', title));
        if (note) h.appendChild(node('div', 'nw-section-note', note));
        return h;
    }

    function renderNews(data) {
        var wrap = node('div', 'nw-screen');
        wrap.appendChild(subHeader('news'));
        var env = data && data.env || {};
        var mast = node('div', 'nw-masthead');
        var line = mast.appendChild(node('div', 'nw-mast-line'));
        line.appendChild(node('div', 'nw-mast-name', 'THE CITY DESK'));
        line.appendChild(node('div', 'nw-mast-edition', 'MORNING'));
        mast.appendChild(node('div', 'nw-mast-rule'));
        var sub = mast.appendChild(node('div', 'nw-mast-sub'));
        sub.appendChild(node('div', 'nw-mast-date', nwEdition(env)));
        sub.appendChild(node('div', 'nw-mast-preview', 'PREVIEW FEED'));
        wrap.appendChild(mast);
        wrap.appendChild(nwChips());
        var list = NW_STORIES.filter(function (s) { return nwCat === 'Top' || s.cat === nwCat; });
        if (!list.length) {
            var empty = card();
            empty.appendChild(node('div', 'ph-empty', 'Nothing filed in this section yet.'));
            wrap.appendChild(empty);
            return wrap;
        }
        wrap.appendChild(nwHero(list[0]));
        var rest = list.slice(1);
        if (rest.length) {
            wrap.appendChild(nwSectionHead('Latest', rest.length === 1 ? '1 STORY' : rest.length + ' STORIES'));
            var feed = node('div', 'nw-feed');
            rest.forEach(function (s) { feed.appendChild(nwRow(s)); });
            wrap.appendChild(feed);
        }
        if (nwCat === 'Top') {
            wrap.appendChild(nwSectionHead('Most read this morning', 'THE DESK'));
            var most = node('div', 'nw-most');
            list.slice(1, 5).forEach(function (s, i) {
                var row = node('div', 'nw-most-row');
                onTap(row, function (e) { e.stopPropagation(); nwStoryOpen(s); });
                row.appendChild(node('div', 'nw-most-num', String(i + 1).length < 2 ? '0' + (i + 1) : String(i + 1)));
                row.appendChild(node('div', 'nw-most-title', s.title));
                row.appendChild(node('div', 'nw-most-time', s.read));
                most.appendChild(row);
            });
            wrap.appendChild(most);
        }
        var foot = node('div', 'nw-editor-note');
        foot.appendChild(node('div', 'nw-editor-mark'));
        var ft = foot.appendChild(node('div', 'nw-editor-text'));
        ft.appendChild(node('div', 'nw-editor-title', 'A preview edition'));
        ft.appendChild(node('div', 'nw-editor-body', 'These stories and illustrations are local demo content. No live news source is connected yet.'));
        wrap.appendChild(foot);
        return wrap;
    }

    function nwParagraphs(story, wrap) {
        story.body.forEach(function (text) {
            wrap.appendChild(node('p', 'nw-body-p', text));
        });
    }

    function nwRelated(story, wrap) {
        var related = NW_STORIES.filter(function (s) { return s.id !== story.id && s.cat === story.cat; }).slice(0, 2);
        if (!related.length) {
            related = NW_STORIES.filter(function (s) { return s.id !== story.id; }).slice(0, 2);
        }
        wrap.appendChild(nwSectionHead('More from ' + story.cat, 'THE DESK'));
        var list = node('div', 'nw-related');
        related.forEach(function (s) { list.appendChild(nwRow(s)); });
        wrap.appendChild(list);
    }

    function renderNewsDetail() {
        var story = nwFind(nwOpenId);
        var wrap = node('div', 'nw-screen nw-detail');
        wrap.appendChild(subHeader('newsdetail', 'Story'));
        if (!story) {
            var gone = card();
            gone.appendChild(node('div', 'ph-empty', 'This story is no longer on the front page.'));
            wrap.appendChild(gone);
            return wrap;
        }
        var head = node('div', 'nw-detail-head');
        var top = head.appendChild(node('div', 'nw-detail-top'));
        top.appendChild(node('div', 'nw-detail-kicker', story.cat.toUpperCase()));
        top.appendChild(nwSaveButton(story, true));
        head.appendChild(node('h1', 'nw-detail-title', story.title));
        head.appendChild(node('div', 'nw-detail-deck', story.standfirst));
        var by = head.appendChild(node('div', 'nw-detail-by'));
        by.appendChild(node('div', 'nw-detail-author', 'By ' + story.byline));
        by.appendChild(node('div', 'nw-detail-time', story.time + ' · ' + story.read + ' read'));
        wrap.appendChild(head);
        wrap.appendChild(nwArt(story, 'nw-detail-art'));
        wrap.appendChild(node('div', 'nw-art-caption', 'Illustration for The City Desk · ' + story.cat));
        var body = node('div', 'nw-detail-body');
        nwParagraphs(story, body);
        if (story.quote) {
            var q = body.appendChild(node('blockquote', 'nw-quote'));
            q.appendChild(node('div', 'nw-quote-mark', '“'));
            q.appendChild(node('div', 'nw-quote-text', story.quote));
        }
        body.appendChild(node('div', 'nw-detail-end'));
        wrap.appendChild(body);
        var tags = node('div', 'nw-tags');
        tags.appendChild(node('span', 'nw-tag', story.cat));
        tags.appendChild(node('span', 'nw-tag', 'Morning edition'));
        tags.appendChild(node('span', 'nw-tag', 'Local'));
        wrap.appendChild(tags);
        var note = node('div', 'nw-detail-note');
        note.appendChild(node('div', 'nw-detail-note-title', 'About this preview'));
        note.appendChild(node('div', 'nw-detail-note-body', 'This is a demonstration article bundled with the app. It is not a report from a live source, and no external feed has been fetched.'));
        wrap.appendChild(note);
        nwRelated(story, wrap);
        return wrap;
    }

    // ------------------------------------------------------------------
    // The apps of this phone
    // ------------------------------------------------------------------
    screens.home = { load: loadHome, render: renderHome };
    registerApp({ id: 'family', label: 'Family', cls: 'ic-family', category: 'Household', version: '1.4',
        desc: 'Your household at a glance', subtitle: 'Your household at a glance',
        featured: 'Know how everyone at home is doing',
        about: 'Everyone who lives with you on one page: their mood, how hungry, tired or lonely they are, and where they are right now.',
        screens: { family: { load: loadFamily, render: renderFamily } } });
    registerApp({ id: 'bonds', label: 'Bonds', cls: 'ic-bonds', category: 'Household', version: '1.2',
        desc: 'Friendship, romance and family ties', subtitle: 'Friendship, romance and family ties',
        about: 'How close the character you play is to each person they know, as friendship, romance, family and business.',
        screens: { bonds: { load: loadBonds, render: renderBonds } } });
    registerApp({ id: 'work', label: 'Work', cls: 'ic-work', category: 'Career', version: '1.3',
        desc: "Who's at work, and until when", subtitle: "Who's at work, and until when",
        about: 'Work hours of each household member on a timeline of the day, and who is at work right now.',
        screens: { work: { load: loadWork, render: renderWork } } });
    registerApp({ id: 'time', label: 'Time', cls: 'ic-time', category: 'Utilities', version: '1.1',
        desc: 'Pause, speed up, skip ahead', subtitle: 'Pause, speed up, skip ahead',
        about: 'The game clock in your hand: pause the city, run it at 1x, 2x or 3x, or skip an hour ahead.',
        screens: { time: { load: loadTime, render: renderTime } } });
    registerApp({ id: 'jobs', label: 'Jobs', cls: 'ic-jobs', category: 'Career', version: '1.5',
        desc: 'Openings in town, one tap to apply', subtitle: 'Openings in town, one tap to apply',
        featured: 'Find a job that fits',
        about: 'Every job opening in town with its hours, workdays and pay. Pick a household member and apply on the spot.',
        screens: { jobs: { load: loadJobs, render: renderJobs } } });
    registerApp({ id: 'freelance', label: 'Freelance', cls: 'ic-freelance', category: 'Career', version: '1.2',
        desc: 'Take orders, earn on your own time', subtitle: 'Take orders, earn on your own time',
        featured: 'Be your own boss',
        whatsNew: 'Orders open straight from the list; Back always stays at the top.',
        about: 'Freelance orders from people in town: deliveries and creative work. Accept an order, follow the one in progress, and see your licenses and record.',
        screens: { freelance: { load: loadFreelance, render: renderFreelance } } });
    registerApp({ id: 'news', label: 'News', cls: 'ic-news', category: 'Media', version: '0.9',
        preinstalled: false,
        desc: 'A morning edition for the city', subtitle: 'A morning edition for the city',
        featured: 'The city, before it wakes',
        whatsNew: 'First preview: a local morning edition, section filters, saved stories and full article pages. The live source feed is not connected yet.',
        about: 'A calm, readable newspaper for the city: a lead story, local sections, a most-read list and full article pages. This preview uses bundled demo stories and drawings; an open-source news feed can be connected later without changing the reading experience.',
        screens: {
            news: { load: loadNews, render: renderNews },
            newsdetail: { load: loadNews, render: renderNewsDetail, title: 'Story', parent: 'news' }
        } });
    registerApp({ id: 'texts', label: 'Texts', cls: 'ic-texts', category: 'Social', dock: true, version: '2.4',
        desc: 'Chat with your family', subtitle: 'Chat with your family',
        featured: 'Your family, one text away',
        whatsNew: 'Emoji, and every message now shows the time in the city.',
        about: 'Text the people you live with. They answer in their own voice, remember what you talked about, and can do what you ask in the game.',
        badge: function (data) { return data.unread || 0; },
        screens: {
            texts: { load: loadTexts, render: renderTexts },
            chat: { load: loadChat, render: renderChat, title: 'Chat', parent: 'texts' },
            group: { load: loadGroup, render: renderGroup, title: 'Group', parent: 'texts' },
            groupNew: { load: loadGroupNew, render: renderGroupNew, title: 'New Group', parent: 'texts' },
            groupMembers: { load: loadGroupMembers, render: renderGroupMembers, title: 'Members', parent: 'group' },
            groupName: { load: loadGroupName, render: renderGroupName, title: 'Group Name', parent: 'group' },
            persona: { load: loadPersona, render: renderPersona, title: 'Persona', parent: 'chat' }
        } });
    registerApp({ id: 'contacts', label: 'Contacts', cls: 'ic-contacts', glyph: contactsGlyph, category: 'Social', version: '1.0',
        desc: 'Everyone in your phone', subtitle: 'Everyone in your phone',
        whatsNew: 'First release: the contacts of your phone in the game, with their faces, jobs and how close you are.',
        about: 'The contact list of your phone in the game: family, friends and everyone else you have met, closest first. Open someone for their job, where they are right now and how you feel about each other, and text the people you live with.',
        screens: {
            contacts: { load: loadContacts, render: renderContacts },
            contact: { load: loadContacts, render: renderContact, title: 'Contact', parent: 'contacts' }
        } });
    registerApp({ id: 'messages', label: 'Messages', cls: 'ic-messages', category: 'Social', version: '1.1',
        desc: 'Banks, services and everyone else', subtitle: 'Banks, services and everyone else',
        whatsNew: 'New messages pop up as banners.',
        about: "The city's own phone messages: people you know, banks, schools and shops. Read them and answer the ones that wait for you.",
        screens: { messages: { load: loadMessages, render: renderMessages } } });
    registerApp({ id: 'moments', label: 'Moments', cls: 'ic-moments', category: 'Social', dock: true, version: '2.0',
        desc: 'What your friends are up to', subtitle: 'What your friends are up to',
        featured: 'Share the moment',
        whatsNew: 'A fresh look, emoji, and times in the city.',
        about: 'Posts from the people you know, with likes and comments. Post your own and see who reacts.',
        badge: function (data) { return data.momentsUnread || 0; },
        screens: { moments: { load: loadMoments, render: renderMoments } } });
    registerApp({ id: 'dreamcar', label: 'Dream Car', cls: 'ic-dreamcar', glyph: dreamCarGlyph, category: 'Household', version: '1.0',
        preinstalled: false,
        desc: 'The city’s car dealer in your pocket', subtitle: 'The city’s car dealer in your pocket',
        featured: 'Drive home your dream car',
        whatsNew: 'First release: every vehicle the game sells, with real photos from the dealer and all its colours.',
        about: 'The game’s own car dealer, 梦中情车, as a phone app: bicycles, scooters, motorbikes and cars with their prices, colours and descriptions. Pick a colour and buy; the game’s dealer handles the payment and delivers the vehicle home. The Garage shows what everyone in the family drives.',
        screens: {
            dreamcar: { load: loadDreamCar, render: renderDreamCar },
            dccar: { load: loadDreamCar, render: renderDreamCarCar, title: 'Vehicle', parent: 'dreamcar' },
            dcgarage: { load: loadDreamCar, render: renderDreamCarGarage, title: 'Garage' }
        } });
    registerApp({ id: 'ai', label: 'AI', cls: 'ic-ai', category: 'Utilities', dock: true, version: '2.49',
        desc: 'The service behind your family', subtitle: 'The service behind your family',
        about: 'Switch the AI phone service on or off, choose a provider and model, and test the connection.',
        screens: { ai: { load: loadAi, render: renderAi } } });
    registerApp({ id: 'settings', label: 'Settings', cls: 'ic-settings', category: 'Utilities', dock: true, system: true, version: '1.0',
        desc: 'Sounds and wallpaper', subtitle: 'Sounds and wallpaper',
        about: 'Phone sounds and the wallpaper, including your own pictures.',
        screens: {
            settings: { load: loadSettings, render: renderSettings },
            sounds: { load: loadSettings, render: renderSounds, title: 'Sounds', parent: 'settings' },
            wallpaper: { load: loadWallpaper, render: renderWallpaper, title: 'Wallpaper', parent: 'settings' }
        } });
    registerApp({ id: 'store', label: 'App Store', cls: 'ic-store', category: 'Utilities', system: true, version: '1.0',
        glyph: storeGlyph, desc: 'Get, open and remove apps', subtitle: 'Get, open and remove apps',
        about: 'Every app this phone can hold. Get the ones you want, remove the ones you do not; their data stays.',
        screens: {
            store: { load: loadStore, render: renderStore },
            storeapp: { load: loadStore, render: renderStoreApp, title: 'App', parent: 'store' }
        } });

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
        if (screenId === 'ai' && from !== 'ai') {
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
            return loadPortraitIndex().then(function () {
                var contacts = textContacts(me, members);
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
