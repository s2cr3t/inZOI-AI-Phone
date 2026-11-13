'use strict';
// Configuration = built-in defaults <- config.json (user editable) <- secrets.json (API keys).
// config.json is created with the full default set on first run so every option is visible.
// secrets.json lives in the data folder (see lib/paths.js), never inside the game's mod folder.
// Keys set from the phone are stored per provider and encrypted with DPAPI.
// Empty paths (mailbox.dir, buffs/meals queue_file) are found automatically under Documents.
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');
const paths = require('./paths');
const providers = require('./providers');
const winsec = require('./winsec');

const ROOT = paths.APP_ROOT;
const HOME = paths.HOME;
const CONFIG_FILE = path.join(HOME, 'config.json');
const SECRETS_FILE = path.join(HOME, 'secrets.json');
const DATA_DIR = path.join(HOME, 'data');
const LOG_DIR = path.join(HOME, 'logs');
const BUNDLED_BUFF_CATALOG = path.join(paths.ASSETS_DIR, 'buff-catalog.json');
const BODILY_NEEDS = ['Hunger', 'Sleep', 'Energy', 'Cleanliness', 'Toilet'];
const THINKING = ['disabled', 'low', 'high', 'max'];

const DEFAULTS = {
    mode: 'auto',
    game: {
        url: 'http://127.0.0.1:11212/mcp',
        timeout_ms: 15000
    },
    mailbox: {
        mod_id: paths.PHONE_MOD_ID,
        dir: '',
        keep: 200,
        text_max: 400
    },
    llm: {
        provider: 'deepseek',
        base_url: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        api_key_env: 'DEEPSEEK_API_KEY',
        temperature: 0.9,
        thinking: 'disabled',
        max_tokens: 1200,
        timeout_ms: 90000,
        max_retries: 2,
        max_calls_per_hour: 120,
        json_mode: true,
        // For the cost shown on the phone when the provider's prices are not built in:
        // { "input": 2, "cached": 0.5, "output": 8, "currency": "CNY" } per million tokens.
        price: null
    },
    // Voice input (lib/voice.js): hold the key in the game and speak; recognised on this PC by
    // whisper.cpp, fetched once with tools/setup-voice.js. language: zh, en ... or auto.
    voice: {
        enabled: false,
        key: 'RightAlt',
        language: 'zh',
        port: 8772,
        only_in_game: true
    },
    reply: {
        debounce_ms: 2500,
        // Up to three texts a reply: 16 was three or four exchanges, too few to keep a story straight.
        history_messages: 40,
        max_bubbles: 3,
        bubble_max_chars: 120,
        typing_ms_per_char: 160,
        typing_min_ms: 1200,
        typing_max_ms: 6500,
        retry_backoff_ms: [15000, 30000, 60000, 120000, 300000]
    },
    actions: {
        enabled: true,
        allowed: ['go_home', 'go_to_player', 'go_to_place', 'go_together', 'interact', 'stop_current', 'emote', 'use_object'],
        // Lists written before going out together existed get it with go_to_place; false keeps it off.
        together: true,
        allow_teleport: true,
        max_per_reply: 4,
        max_interactions_listed: 24,
        max_objects_listed: 12,
        // How many *kinds* of thing get their menu listed, one line each. A lot holds ~70 kinds
        // and well over a hundred instances; listing instances spent the whole budget on the
        // nearest corner of one room. Instances beyond this stay known by name.
        max_object_types: 18,
        max_object_actions: 6,
        want_objects: 6,
        object_radius_m: 30,
        notify_toast: true
    },
    // Group chats (groups.js). Several of the phone's contacts in one conversation, answered by
    // the same service. Auto-chat is on by default, so the caps below are what keeps a quiet
    // evening from turning into two hundred model calls.
    groups: {
        enabled: true,
        dir: '',
        max_members: 8,
        // Lines the bridge may post in one group in an hour, and how many of those may be
        // lines nobody asked for (the characters carrying on among themselves).
        max_per_hour: 24,
        auto_chat: true,
        max_auto_per_hour: 6,
        max_replies_per_turn: 2,
        // Not every message gets an answer, even in a group of four.
        silence_chance: 0.35,
        min_gap_ms: 3000,
        max_gap_ms: 12000,
        // A line nobody asked for comes much later than a reply, or four people sound like one
        // bot sending messages every five seconds.
        auto_gap_min_ms: 25000,
        auto_gap_max_ms: 90000,
        // A thread nobody has touched for this long is over; no new lines until someone speaks.
        topic_idle_minutes: 20,
        history_shown: 30,
        keep_messages: 200,
        // A group is a chat, not a letter: one short line, never two.
        max_bubbles: 1,
        bubble_max_chars: 24
    },
    immersion: {
        toast_on_message: true,
        phone_motion: false,
        phone_motion_anim: 'Self_UsePhone_Text_Messaging',
        speech_bubble: true
    },
    proactive: {
        enabled: true,
        on_work_end: true,
        on_work_start: false,
        on_arrive_home: true,
        on_late_absence: true,
        on_needs: true,
        on_hopes: true,
        on_environment: true,
        need_threshold: 40,
        need_cooldown_minutes: 20,
        late_game_hour: 20,
        idle_minutes: 30,
        idle_chance: 0.5,
        skip_when_nearby: true,
        nearby_meters: 15,
        // Side by side, chatting and sharing still happen, only further apart.
        nearby_chat: true,
        nearby_idle_minutes: 20,
        // Finishing something that took a while is something to tell.
        on_share: true,
        share_min_seconds: 90,
        share_cooldown_minutes: 8,
        // An unanswered text gets one more after this long, never more than max_unanswered in a row.
        follow_up_minutes: 20,
        max_unanswered: 2,
        max_per_hour: 3,
        max_per_hour_total: 6,
        // Unprompted texts from one contact in one game day (emergencies are not held back).
        max_per_day: 4,
        quiet_game_hours: [0, 7]
    },
    moments: {
        enabled: true,
        post_interval_minutes: 25,
        author_cooldown_minutes: 120,
        max_posts_per_hour: 4,
        min_relationship: 0,
        max_circle: 40,
        max_reactors: 6,
        max_comments_per_post: 4,
        reaction_delay_minutes: [1, 20],
        reply_to_player: true,
        reply_delay_seconds: [20, 120],
        keep_posts: 80,
        quiet_game_hours: [0, 7]
    },
    ties: {
        // How the household feel about each other and what they hold against each other (lib/ties.js).
        enabled: true,
        // Game days for a grudge to fade by one step (a heavy one, weight 3, takes three times this).
        fade_days: 2
    },
    stories: {
        // Each contact's own story line, over a few game days (lib/stories.js).
        enabled: true,
        // Game days without a move before a story moves on by itself.
        drift_days: 2,
        // Times a game day a contact may let their story show in texts; past it they leave it
        // until the player asks.
        hints_per_day: 2,
        // Game days after a story ends before the next one starts.
        gap_days: 1,
        // What an ending brings: moodlets, warmth, a thank-you text and a Moments post after the
        // player helped; a chance to make it right after one that went badly.
        rewards: true,
        // Game days after a bad ending during which comforting the contact still mends it.
        mend_days: 2,
        // Real minutes after a good ending before the contact texts a thank-you.
        thanks_delay_minutes: 20,
        // Game days the contact keeps the help in mind (warmer, may bring it up).
        thanks_days: 4
    },
    journal: {
        enabled: true,
        log_file: ''
    },
    setbacks: {
        enabled: true,
        cooldown_s: 90,
        max_age_minutes: 10
    },
    buffs: {
        enabled: true,
        queue_file: '',
        // The ModKit's zh-CN strings; empty uses the catalog shipped in assets/.
        po_file: '',
        cooldown_minutes: 10,
        repeat_minutes: 120,
        max_per_hour: 6,
        ack_timeout_s: 300,
        max_options: 12,
        toast: false
    },
    meals: {
        enabled: true,
        queue_file: '',
        start_timeout_s: 30,
        ack_timeout_s: 300
    },
    // Likes and dislikes the AI gives the character it plays (lib/preferences.js).
    preferences: {
        enabled: true,
        per_game_day: 1
    },
    needs: {
        enabled: true,
        stats: ['Society', 'Admit', 'Fun'],
        points: [4, 8, 14],
        max_per_hour: 30
    },
    tracker: {
        interval_ms: 20000,
        diary_keep: 40
    },
    memory: {
        summarize_after: 40,
        keep_recent: 20,
        // 0 stops remembering new facts. Otherwise facts are kept up to keep_facts (the larger of
        // the two), all of them findable by topic; the prompt shows the newest few plus the ones
        // the conversation is about.
        max_facts: 40,
        keep_facts: 200,
        max_episodes: 150,
        recall: true,
        // Big household events from the game (大事记).
        chronicle: true,
        chronicle_interval_ms: 60000
    },
    persona: {
        extra: {}
    },
    log: {
        level: 'info',
        retain_days: 7
    }
};

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (!isPlainObject(v)) return v;
    const out = {};
    for (const k of Object.keys(v)) out[k] = clone(v[k]);
    return out;
}

// Always returns new objects: validate() edits the result in place, and DEFAULTS must stay as written.
function deepMerge(base, over) {
    if (!isPlainObject(base)) return clone(over === undefined ? base : over);
    const out = {};
    for (const k of Object.keys(base)) out[k] = clone(base[k]);
    if (!isPlainObject(over)) return out;
    for (const k of Object.keys(over)) {
        if (k.startsWith('_')) continue;
        out[k] = isPlainObject(base[k]) && isPlainObject(over[k]) ? deepMerge(base[k], over[k]) : clone(over[k]);
    }
    return out;
}

function num(v, lo, hi, fallback) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(Math.max(n, lo), hi);
}

// [lo, hi] pair of numbers inside [min, max], ordered.
function range(v, min, max, fallback) {
    if (!Array.isArray(v) || v.length !== 2) return fallback.slice();
    const a = num(v[0], min, max, fallback[0]);
    const b = num(v[1], min, max, fallback[1]);
    return a <= b ? [a, b] : [b, a];
}

// A queue file the Lua mod reads: an absolute .cfg path, or empty for the one found automatically.
function queueFile(v, name, auto, problems) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) return auto;
    if (!/\.cfg$/i.test(s) || !path.isAbsolute(s)) {
        problems.push(name + ' must be an absolute path to a .cfg file or empty; finding it automatically');
        return auto;
    }
    return s;
}

function duplicateProblem(modId, mod, problems) {
    if (mod.copies.length < 2) return;
    problems.push('the mod ' + modId + ' is installed ' + mod.copies.length + ' times (' + mod.copies.join('; ') + '); using ' + mod.dir +
        ' because ' + mod.reason + '. The game loads only one copy; delete the others so an old one is never loaded');
}

function validate(c) {
    const d = DEFAULTS;
    const problems = [];
    if (c.mode !== 'auto' && c.mode !== 'cursor' && c.mode !== 'off') {
        problems.push('mode must be "auto", "cursor" or "off"; using "auto"');
        c.mode = 'auto';
    }
    if (typeof c.mailbox.mod_id !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(c.mailbox.mod_id)) c.mailbox.mod_id = d.mailbox.mod_id;
    c.mailbox.dir = typeof c.mailbox.dir === 'string' ? c.mailbox.dir.trim() : '';
    if (c.mailbox.dir && !path.isAbsolute(c.mailbox.dir)) {
        problems.push('mailbox.dir must be an absolute path or empty (found automatically); finding it automatically');
        c.mailbox.dir = '';
    }
    c.mailbox.copies = [];
    if (!c.mailbox.dir) {
        const mod = paths.modCopies(c.mailbox.mod_id);
        c.mailbox.found = !!mod.dir;
        c.mailbox.copies = mod.copies;
        if (!mod.dir) problems.push('the phone mod ' + c.mailbox.mod_id + ' was not found under Documents\\inZOI\\Mods');
        duplicateProblem(c.mailbox.mod_id, mod, problems);
        c.mailbox.dir = path.join(mod.dir || paths.expectedModDir(c.mailbox.mod_id), 'ui', 'phone', 'sms');
    } else {
        c.mailbox.found = paths.isDir(path.dirname(c.mailbox.dir));
    }
    c.mailbox.keep = num(c.mailbox.keep, 20, 2000, d.mailbox.keep);
    c.mailbox.text_max = num(c.mailbox.text_max, 20, 2000, d.mailbox.text_max);
    if (!providers.get(c.llm.provider)) {
        problems.push('llm.provider "' + c.llm.provider + '" is unknown; treating it as custom');
        c.llm.provider = 'custom';
    }
    if (!providers.isModelId(c.llm.model)) {
        problems.push('llm.model is not a valid model id; using "' + d.llm.model + '"');
        c.llm.model = d.llm.model;
    }
    c.llm.temperature = num(c.llm.temperature, 0, 2, d.llm.temperature);
    if (THINKING.indexOf(c.llm.thinking) < 0) {
        problems.push('llm.thinking must be disabled, low, high or max; using "' + d.llm.thinking + '"');
        c.llm.thinking = d.llm.thinking;
    }
    c.llm.max_tokens = num(c.llm.max_tokens, 100, 8000, d.llm.max_tokens);
    c.llm.timeout_ms = num(c.llm.timeout_ms, 5000, 300000, d.llm.timeout_ms);
    c.llm.max_retries = num(c.llm.max_retries, 0, 5, d.llm.max_retries);
    // 0 = no hourly limit.
    c.llm.max_calls_per_hour = Math.round(num(c.llm.max_calls_per_hour, 0, 100000, d.llm.max_calls_per_hour));
    if (c.llm.price !== null && c.llm.price !== undefined) {
        const pr = c.llm.price;
        const okNum = (v) => typeof v === 'number' && isFinite(v) && v >= 0 && v <= 10000;
        if (!isPlainObject(pr) || !okNum(pr.input) || !okNum(pr.output) || (pr.cached !== undefined && !okNum(pr.cached)) ||
            (pr.currency !== undefined && !/^[A-Z]{3}$/.test(String(pr.currency)))) {
            problems.push('llm.price must be { "input": n, "cached": n, "output": n, "currency": "CNY" } in money per million tokens; the cost stays unknown');
            c.llm.price = null;
        }
    } else {
        c.llm.price = null;
    }
    const preset = providers.get(c.llm.provider);
    if (!String(c.llm.base_url || '').trim() && preset.base_url) c.llm.base_url = preset.base_url;
    const url = providers.checkBaseUrl(c.llm.base_url);
    if (url.ok) {
        c.llm.base_url = url.url;
    } else {
        const fallback = preset.base_url || d.llm.base_url;
        problems.push('llm.base_url ' + url.reason + '; using ' + fallback);
        c.llm.base_url = fallback;
    }
    c.reply.debounce_ms = num(c.reply.debounce_ms, 0, 60000, d.reply.debounce_ms);
    c.reply.history_messages = num(c.reply.history_messages, 4, 200, d.reply.history_messages);
    c.reply.max_bubbles = num(c.reply.max_bubbles, 1, 5, d.reply.max_bubbles);
    c.reply.bubble_max_chars = num(c.reply.bubble_max_chars, 20, c.mailbox.text_max, d.reply.bubble_max_chars);
    if (!Array.isArray(c.reply.retry_backoff_ms) || !c.reply.retry_backoff_ms.length) c.reply.retry_backoff_ms = d.reply.retry_backoff_ms;
    if (!Array.isArray(c.actions.allowed)) c.actions.allowed = d.actions.allowed;
    c.actions.together = c.actions.together !== false;
    if (!c.actions.together) {
        c.actions.allowed = c.actions.allowed.filter((t) => t !== 'go_together');
    } else if (c.actions.allowed.indexOf('go_to_place') >= 0 && c.actions.allowed.indexOf('go_together') < 0) {
        c.actions.allowed = c.actions.allowed.concat(['go_together']);
    }
    c.actions.max_per_reply = num(c.actions.max_per_reply, 0, 6, d.actions.max_per_reply);
    c.actions.max_objects_listed = num(c.actions.max_objects_listed, 0, 40, d.actions.max_objects_listed);
    c.actions.max_object_actions = num(c.actions.max_object_actions, 1, 30, d.actions.max_object_actions);
    c.actions.want_objects = num(c.actions.want_objects, 1, 12, d.actions.want_objects);
    c.actions.object_radius_m = num(c.actions.object_radius_m, 5, 40, d.actions.object_radius_m);
    c.proactive.idle_minutes = num(c.proactive.idle_minutes, 3, 1440, d.proactive.idle_minutes);
    c.proactive.idle_chance = num(c.proactive.idle_chance, 0, 1, d.proactive.idle_chance);
    c.proactive.skip_when_nearby = c.proactive.skip_when_nearby !== false;
    c.proactive.nearby_meters = num(c.proactive.nearby_meters, 1, 60, d.proactive.nearby_meters);
    c.proactive.nearby_chat = c.proactive.nearby_chat !== false;
    c.proactive.nearby_idle_minutes = num(c.proactive.nearby_idle_minutes, 3, 1440, d.proactive.nearby_idle_minutes);
    c.proactive.on_share = c.proactive.on_share !== false;
    c.proactive.share_min_seconds = num(c.proactive.share_min_seconds, 20, 3600, d.proactive.share_min_seconds);
    c.proactive.share_cooldown_minutes = num(c.proactive.share_cooldown_minutes, 1, 360, d.proactive.share_cooldown_minutes);
    c.proactive.follow_up_minutes = num(c.proactive.follow_up_minutes, 2, 240, d.proactive.follow_up_minutes);
    c.proactive.max_unanswered = num(c.proactive.max_unanswered, 1, 5, d.proactive.max_unanswered);
    c.proactive.max_per_hour = num(c.proactive.max_per_hour, 0, 30, d.proactive.max_per_hour);
    c.proactive.max_per_hour_total = num(c.proactive.max_per_hour_total, 0, 60, d.proactive.max_per_hour_total);
    c.proactive.max_per_day = num(c.proactive.max_per_day, 0, 50, d.proactive.max_per_day);
    c.proactive.on_needs = c.proactive.on_needs !== false;
    c.proactive.on_hopes = c.proactive.on_hopes !== false;
    c.proactive.on_environment = c.proactive.on_environment !== false;
    c.proactive.need_threshold = num(c.proactive.need_threshold, 10, 80, d.proactive.need_threshold);
    c.proactive.need_cooldown_minutes = num(c.proactive.need_cooldown_minutes, 10, 360, d.proactive.need_cooldown_minutes);
    c.proactive.late_game_hour = num(c.proactive.late_game_hour, 0, 23, d.proactive.late_game_hour);
    if (!Array.isArray(c.proactive.quiet_game_hours) || c.proactive.quiet_game_hours.length !== 2) {
        c.proactive.quiet_game_hours = d.proactive.quiet_game_hours;
    }
    const m = c.moments;
    const dm = d.moments;
    m.enabled = m.enabled !== false;
    m.reply_to_player = m.reply_to_player !== false;
    m.post_interval_minutes = num(m.post_interval_minutes, 3, 1440, dm.post_interval_minutes);
    m.author_cooldown_minutes = num(m.author_cooldown_minutes, 0, 10080, dm.author_cooldown_minutes);
    m.max_posts_per_hour = num(m.max_posts_per_hour, 0, 30, dm.max_posts_per_hour);
    m.min_relationship = num(m.min_relationship, 0, 100, dm.min_relationship);
    m.max_circle = num(m.max_circle, 1, 200, dm.max_circle);
    m.max_reactors = num(m.max_reactors, 0, 12, dm.max_reactors);
    m.max_comments_per_post = num(m.max_comments_per_post, 0, 12, dm.max_comments_per_post);
    m.keep_posts = num(m.keep_posts, 10, 300, dm.keep_posts);
    m.reaction_delay_minutes = range(m.reaction_delay_minutes, 0, 720, dm.reaction_delay_minutes);
    m.reply_delay_seconds = range(m.reply_delay_seconds, 0, 3600, dm.reply_delay_seconds);
    if (!Array.isArray(m.quiet_game_hours) || m.quiet_game_hours.length !== 2) m.quiet_game_hours = dm.quiet_game_hours;
    c.ties.enabled = c.ties.enabled !== false;
    c.ties.fade_days = Math.round(num(c.ties.fade_days, 1, 14, d.ties.fade_days));
    c.stories.enabled = c.stories.enabled !== false;
    c.stories.drift_days = Math.round(num(c.stories.drift_days, 1, 10, d.stories.drift_days));
    c.stories.hints_per_day = Math.round(num(c.stories.hints_per_day, 0, 6, d.stories.hints_per_day));
    c.stories.gap_days = Math.round(num(c.stories.gap_days, 0, 14, d.stories.gap_days));
    c.stories.rewards = c.stories.rewards !== false;
    c.stories.mend_days = Math.round(num(c.stories.mend_days, 0, 7, d.stories.mend_days));
    c.stories.thanks_delay_minutes = num(c.stories.thanks_delay_minutes, 0, 240, d.stories.thanks_delay_minutes);
    c.stories.thanks_days = Math.round(num(c.stories.thanks_days, 1, 14, d.stories.thanks_days));
    c.journal.enabled = c.journal.enabled !== false;
    if (typeof c.journal.log_file !== 'string') c.journal.log_file = '';
    c.setbacks.enabled = c.setbacks.enabled !== false;
    c.setbacks.cooldown_s = num(c.setbacks.cooldown_s, 0, 3600, d.setbacks.cooldown_s);
    c.setbacks.max_age_minutes = num(c.setbacks.max_age_minutes, 1, 120, d.setbacks.max_age_minutes);
    const n = c.needs;
    const dn = d.needs;
    n.enabled = n.enabled !== false;
    if (!Array.isArray(n.stats)) n.stats = dn.stats.slice();
    const bodily = n.stats.filter((s) => BODILY_NEEDS.indexOf(s) >= 0);
    if (bodily.length) problems.push('needs.stats cannot include ' + bodily.join(', ') + ': a text does not feed anyone or let them rest');
    n.stats = n.stats.filter((s) => typeof s === 'string' && /^[A-Za-z]+$/.test(s) && BODILY_NEEDS.indexOf(s) < 0);
    if (!Array.isArray(n.points) || n.points.length !== 3 || n.points.some((v) => typeof v !== 'number' || v <= 0 || v > 50)) {
        if (n.points !== undefined) problems.push('needs.points must be three amounts between 0 and 50 (game stats run -100..100); using default');
        n.points = dn.points.slice();
    }
    n.max_per_hour = num(n.max_per_hour, 0, 200, dn.max_per_hour);
    const b = c.buffs;
    const db = d.buffs;
    b.enabled = b.enabled !== false;
    b.toast = b.toast === true;
    const journalCopies = paths.modCopies(paths.JOURNAL_MOD_ID);
    const journalMod = journalCopies.dir;
    duplicateProblem(paths.JOURNAL_MOD_ID, journalCopies, problems);
    const autoQueue = (name) => journalMod ? path.join(journalMod, 'bridge', name) : '';
    b.queue_file = queueFile(b.queue_file, 'buffs.queue_file', autoQueue('buffs.cfg'), problems);
    if (typeof b.po_file !== 'string') b.po_file = db.po_file;
    b.po_file = b.po_file.trim();
    if (b.po_file && (!/\.po$/i.test(b.po_file) || !path.isAbsolute(b.po_file))) {
        problems.push('buffs.po_file must be an absolute path to a .po file or empty; using the bundled catalog');
        b.po_file = '';
    }
    b.bundled_catalog = BUNDLED_BUFF_CATALOG;
    b.cooldown_minutes = num(b.cooldown_minutes, 0, 1440, db.cooldown_minutes);
    b.repeat_minutes = num(b.repeat_minutes, 0, 10080, db.repeat_minutes);
    b.max_per_hour = num(b.max_per_hour, 0, 60, db.max_per_hour);
    b.ack_timeout_s = num(b.ack_timeout_s, 30, 1800, db.ack_timeout_s);
    b.max_options = num(b.max_options, 6, 40, db.max_options);
    if (b.enabled && !c.journal.enabled) problems.push('buffs needs journal.enabled; chat moodlets stay off until it is on');
    const ml = c.meals;
    const dml = d.meals;
    ml.enabled = ml.enabled !== false;
    ml.queue_file = queueFile(ml.queue_file, 'meals.queue_file', autoQueue('meals.cfg'), problems);
    if (ml.queue_file && b.queue_file && path.resolve(ml.queue_file).toLowerCase() === path.resolve(b.queue_file).toLowerCase()) {
        problems.push('meals.queue_file must not be the buffs queue file; finding it automatically');
        ml.queue_file = autoQueue('meals.cfg');
    }
    if (!journalMod && (!b.queue_file || !ml.queue_file)) {
        if (b.enabled || ml.enabled) problems.push('the Lua mod ' + paths.JOURNAL_MOD_ID + ' was not found; chat moodlets and fridge meals are off');
        if (!b.queue_file) b.enabled = false;
        if (!ml.queue_file) ml.enabled = false;
    }
    ml.start_timeout_s = num(ml.start_timeout_s, 10, 300, dml.start_timeout_s);
    ml.ack_timeout_s = num(ml.ack_timeout_s, 60, 1800, dml.ack_timeout_s);
    const pf = c.preferences;
    pf.enabled = pf.enabled !== false;
    pf.per_game_day = num(pf.per_game_day, 0, 5, d.preferences.per_game_day);
    if (pf.enabled && !c.journal.enabled) problems.push('preferences needs journal.enabled; the characters keep their tastes until it is on');
    if (ml.enabled && !c.journal.enabled) problems.push('meals needs journal.enabled; family meals in the fridge stay hidden until it is on');
    c.tracker.interval_ms = num(c.tracker.interval_ms, 5000, 600000, d.tracker.interval_ms);
    c.memory.summarize_after = num(c.memory.summarize_after, 10, 500, d.memory.summarize_after);
    c.memory.keep_recent = num(c.memory.keep_recent, 4, 200, d.memory.keep_recent);
    c.memory.max_facts = num(c.memory.max_facts, 0, 200, d.memory.max_facts);
    c.memory.keep_facts = num(c.memory.keep_facts, 0, 1000, d.memory.keep_facts);
    c.memory.max_episodes = num(c.memory.max_episodes, 0, 1000, d.memory.max_episodes);
    c.memory.recall = c.memory.recall !== false;
    c.memory.chronicle = c.memory.chronicle !== false;
    c.memory.chronicle_interval_ms = num(c.memory.chronicle_interval_ms, 15000, 600000, d.memory.chronicle_interval_ms);
    if (!isPlainObject(c.persona.extra)) c.persona.extra = {};
    if (['debug', 'info', 'warn', 'error'].indexOf(c.log.level) < 0) c.log.level = 'info';
    return problems;
}

// secrets.json:
//   { "keys": { "<provider>": { "dpapi": "<base64>", "hint": "sk-...abcd", "savedAt": ms } },
//     "llm_api_key": "<plain text, older installs and node bridge.js set-key without the helper>" }
function readSecrets() {
    const r = fsx.readJson(SECRETS_FILE);
    const s = r.ok && isPlainObject(r.value) ? r.value : {};
    if (!isPlainObject(s.keys)) s.keys = {};
    return s;
}

function writeSecrets(s) {
    const out = {};
    if (Object.keys(s.keys || {}).length) out.keys = s.keys;
    if (typeof s.llm_api_key === 'string' && s.llm_api_key) out.llm_api_key = s.llm_api_key;
    fsx.writeJson(SECRETS_FILE, out, true);
}

function keyHint(key) {
    const k = String(key || '');
    if (!k) return '';
    return k.slice(0, 3) + '...' + (k.length > 10 ? k.slice(-4) : '');
}

// The key for the configured provider, in plain text, for this process only.
function resolveApiKey(c) {
    const secrets = readSecrets();
    const entry = secrets.keys[c.llm.provider];
    if (entry && typeof entry.dpapi === 'string' && entry.dpapi) {
        try {
            const key = winsec.unprotect(entry.dpapi).trim();
            if (key) return { key, source: 'secrets.json (' + c.llm.provider + ', encrypted)', hint: entry.hint || keyHint(key) };
        } catch (e) {
            return { key: '', source: 'unreadable', hint: entry.hint || '', error: e.message };
        }
    }
    if (typeof secrets.llm_api_key === 'string' && secrets.llm_api_key.trim()) {
        const key = secrets.llm_api_key.trim();
        return { key, source: 'secrets.json', hint: keyHint(key) };
    }
    const envName = String(c.llm.api_key_env || '');
    if (envName && process.env[envName] && process.env[envName].trim()) {
        const key = process.env[envName].trim();
        return { key, source: 'env ' + envName, hint: keyHint(key) };
    }
    return { key: '', source: 'none', hint: '' };
}

// The stored key of any provider, in plain text, for one request of this process.
// A plain-text key from an older version counts only for the provider configured now.
async function apiKeyFor(provider) {
    const secrets = readSecrets();
    const entry = secrets.keys[provider];
    if (entry && typeof entry.dpapi === 'string' && entry.dpapi) {
        return (await winsec.unprotectAsync(entry.dpapi)).trim();
    }
    const current = load({ withKey: false }).config.llm.provider;
    if (current === provider && typeof secrets.llm_api_key === 'string') return secrets.llm_api_key.trim();
    return '';
}

// Whether a key is stored for a provider, without decrypting it. A plain-text key from an
// older version counts only for the provider configured now (`current`).
function keyInfo(provider, current) {
    const secrets = readSecrets();
    const entry = secrets.keys[provider];
    if (entry && typeof entry.dpapi === 'string' && entry.dpapi) return { set: true, hint: entry.hint || '', source: 'encrypted' };
    const legacyFor = current === undefined ? provider : current;
    if (legacyFor === provider && typeof secrets.llm_api_key === 'string' && secrets.llm_api_key.trim()) {
        return { set: true, hint: keyHint(secrets.llm_api_key.trim()), source: 'plain' };
    }
    return { set: false, hint: '', source: 'none' };
}

function keyInfoAll(current) {
    const out = {};
    for (const p of providers.PROVIDERS) out[p.id] = keyInfo(p.id, current);
    return out;
}

// Stores an already encrypted key for one provider. A plain-text key left by an older version
// belongs to the provider configured now; it is encrypted for that provider and the plain copy
// removed, so only encrypted keys remain.
function saveProtectedKey(provider, blob, hint) {
    if (!providers.get(provider)) throw new Error('unknown provider ' + provider);
    const secrets = readSecrets();
    if (typeof secrets.llm_api_key === 'string' && secrets.llm_api_key.trim()) {
        const legacy = secrets.llm_api_key.trim();
        const current = load({ withKey: false }).config.llm.provider;
        if (current !== provider && !secrets.keys[current]) {
            secrets.keys[current] = { dpapi: winsec.protect(legacy), hint: keyHint(legacy), savedAt: Date.now() };
        }
        delete secrets.llm_api_key;
    }
    secrets.keys[provider] = { dpapi: blob, hint: hint || '', savedAt: Date.now() };
    writeSecrets(secrets);
}

function forgetKey(provider) {
    const secrets = readSecrets();
    const current = load({ withKey: false }).config.llm.provider;
    const legacy = current === provider && !!secrets.llm_api_key;
    const had = !!secrets.keys[provider] || legacy;
    delete secrets.keys[provider];
    if (legacy) delete secrets.llm_api_key;
    writeSecrets(secrets);
    return had;
}

// options.withKey === false: report whether a key is stored without decrypting it.
function load(options) {
    let user = {};
    let created = false;
    const r = fsx.readJson(CONFIG_FILE);
    const problems = [];
    if (r.ok && isPlainObject(r.value)) {
        user = r.value;
    } else if (r.missing) {
        created = true;
    } else {
        problems.push('config.json could not be read (' + r.error + '); using defaults');
    }
    const merged = deepMerge(DEFAULTS, user);
    problems.push.apply(problems, validate(merged));
    if (created) {
        const seed = deepMerge(DEFAULTS, {});
        seed._comment = 'inZOI SMS bridge settings. Edit and save; the bridge reloads automatically. The API key goes in secrets.json (run: node bridge.js set-key).';
        fsx.writeJson(CONFIG_FILE, seed, true);
    }
    if (options && options.withKey === false) {
        const info = keyInfo(merged.llm.provider);
        return { config: merged, apiKey: '', apiKeySet: info.set, apiKeySource: info.source, apiKeyHint: info.hint, problems, created };
    }
    const apiKey = resolveApiKey(merged);
    if (apiKey.error) problems.push('the stored ' + merged.llm.provider + ' key cannot be decrypted (' + apiKey.error + '); enter it again');
    return { config: merged, apiKey: apiKey.key, apiKeySet: !!apiKey.key, apiKeySource: apiKey.source, apiKeyHint: apiKey.hint, problems, created };
}

// Plain key from the command line (node bridge.js set-key): encrypted when the helper exists.
function saveApiKey(key, provider) {
    const p = provider || load().config.llm.provider;
    if (winsec.available()) {
        saveProtectedKey(p, winsec.protect(key), keyHint(key));
        return 'encrypted for ' + p;
    }
    const secrets = readSecrets();
    secrets.llm_api_key = key;
    writeSecrets(secrets);
    return 'plain text';
}

// Changes only the given top-level sections of config.json, keeping everything else the user wrote.
function patchConfigFile(patch) {
    const r = fsx.readJson(CONFIG_FILE);
    const current = r.ok && isPlainObject(r.value) ? r.value : deepMerge(DEFAULTS, {});
    let changed = false;
    for (const section of Object.keys(patch)) {
        const value = patch[section];
        if (isPlainObject(value)) {
            const base = isPlainObject(current[section]) ? current[section] : {};
            for (const k of Object.keys(value)) {
                if (JSON.stringify(base[k]) !== JSON.stringify(value[k])) {
                    base[k] = value[k];
                    changed = true;
                }
            }
            current[section] = base;
        } else if (JSON.stringify(current[section]) !== JSON.stringify(value)) {
            current[section] = value;
            changed = true;
        }
    }
    if (changed) fsx.writeJson(CONFIG_FILE, current, true);
    return changed;
}

function fingerprint() {
    const parts = [];
    for (const f of [CONFIG_FILE, SECRETS_FILE]) {
        try {
            const s = fs.statSync(f);
            parts.push(f + ':' + s.mtimeMs + ':' + s.size);
        } catch (e) {
            parts.push(f + ':none');
        }
    }
    return parts.join('|');
}

module.exports = {
    ROOT, HOME, CONFIG_FILE, SECRETS_FILE, DATA_DIR, LOG_DIR, DEFAULTS, THINKING,
    load, saveApiKey, saveProtectedKey, forgetKey, apiKeyFor, keyInfo, keyInfoAll, keyHint, patchConfigFile, fingerprint, deepMerge
};
