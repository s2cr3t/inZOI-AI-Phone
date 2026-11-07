'use strict';
// Group chats: several of the phone's contacts in one conversation, including people nobody
// plays. The phone owns the left-hand side of every file, this service owns the right:
//
//   <phone mod>/ui/phone/groups/list.cfg              the phone: which groups exist
//   <phone mod>/ui/phone/groups/g-<id>/meta.cfg       the phone: name, members, owner
//   <phone mod>/ui/phone/groups/g-<id>/outbox.cfg     the phone: what the player typed
//   <phone mod>/ui/phone/groups/g-<id>/inbox.cfg      this service: every message, with who said it
//   <phone mod>/ui/phone/groups/g-<id>/seen.cfg       the phone: newest message it has shown
//   <phone mod>/ui/phone/groups/g-<id>/status.cfg     this service: who is typing, for the header
//
// One writer per file, as everywhere else. What has to survive a restart — who spoke last, the
// hourly budget, which line is due — lives in <data>/groups/<id>.json, which only this service
// writes.
//
// A 1:1 thread has one answerer. A group has to decide *who* answers, and has to stop: two
// characters left alone will keep saying "哈哈" to each other until the credit runs out. The
// rules are in plan()/canAuto(): mentions and quotes are answered, everything else competes on a
// score, a third of the messages are met with silence, and lines nobody asked for stop at
// auto_chat.max_auto_per_hour.
const fs = require('fs');
const path = require('path');
// Not the global Web Crypto: randomBytes lives on the module.
const crypto = require('crypto');
const fsx = require('./fsx');
const { sanitizeText, gameStamp } = require('./mailbox');
const persona = require('./persona');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MEMBER_RE = /^\d{1,15}$/;
const KEEP = 200;
const META_TTL_MS = 5000;
const MEMBER_TTL_MS = 60000;

function str(v) { return v === undefined || v === null ? '' : String(v); }

function cleanId(v) {
    const s = str(v).trim();
    return MEMBER_RE.test(s) ? s : '';
}

// A stored member name that is only the member's id (the phone wrote that when it could not look
// the person up) is no name at all.
function realName(name, id) {
    const s = str(name).trim();
    return s && s !== str(id) && !MEMBER_RE.test(s) ? s : '';
}

// Everyone in the group: the members and the one who made it, who is not always listed as a member.
function people(meta) {
    const out = meta.members.slice();
    if (meta.owner && !out.some((m) => m.id === String(meta.owner))) out.push({ id: String(meta.owner), name: '' });
    return out;
}

// playerFrom: who wrote the newest line from the phone. That character is played, so they never
// answer it, nor carry the conversation on by themselves.
function emptyState() {
    return { v: 1, seenAt: 0, lastAt: 0, lastFrom: '', lastPlayerAt: 0, playerFrom: '', queue: [], recent: [], budgetStart: 0, budget: 0, autoBudget: 0 };
}

// A group line is one short breath. When the model ignores the length, cut at the last
// punctuation rather than through a word.
function shortLine(text, max) {
    const s = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length <= max) return s;
    const head = s.slice(0, max);
    const marks = ['。', '！', '？', '，', '；', '、', ' ', '.', ',', '!', '?'];
    let cut = -1;
    for (const m of marks) cut = Math.max(cut, head.lastIndexOf(m));
    if (cut >= Math.floor(max * 0.5)) return head.slice(0, cut) + '…';
    return head + '…';
}

// A group made by this service may carry its own pace (classgroup.js: a class chat is livelier
// than a family one): only known numeric keys, each within reason.
const PACE_KEYS = ['max_per_hour', 'max_auto_per_hour', 'max_replies_per_turn', 'silence_chance', 'min_gap_ms', 'max_gap_ms',
    'auto_gap_min_ms', 'auto_gap_max_ms', 'topic_idle_minutes', 'auto_chance', 'auto_chance_stale', 'second_reply_chance', 'auto_burst'];

// How many lines nobody asked for a group may have said this far into its hour: a burst
// (auto_burst, a fifth of the hour's lines unless set, at least two) and then the rest a little at
// a time, so a lively group does not use its whole hour in the first quarter and then fall silent.
function autoAllowance(pace, elapsedMs) {
    const max = pace.max_auto_per_hour || 6;
    const burst = pace.auto_burst !== undefined ? pace.auto_burst : Math.max(2, Math.round(max / 5));
    const share = Math.min(1, Math.max(0, elapsedMs) / 3600000);
    return Math.min(max, burst + Math.floor((max - burst) * share));
}

function cleanPace(v) {
    const out = {};
    if (!v || typeof v !== 'object') return out;
    for (const k of PACE_KEYS) {
        const n = Number(v[k]);
        if (Number.isFinite(n) && n >= 0 && n <= 3600000) out[k] = n;
    }
    if (Array.isArray(v.quiet_game_hours) && v.quiet_game_hours.length === 2 && v.quiet_game_hours.every((h) => Number.isFinite(Number(h)))) {
        out.quiet_game_hours = v.quiet_game_hours.map(Number);
    }
    return out;
}

class Groups {
    constructor(daemon) {
        this.d = daemon;
        this.dir = null;
        this.dataDir = null;
        this.states = new Map();
        this.metaCache = new Map();
        this.members = new Map();
        this.busy = false;
        this.reported = new Set();
    }

    get log() { return this.d.log; }
    get world() { return this.d.world; }
    get cfg() { return (this.d.cfg && this.d.cfg.groups) || {}; }
    get enabled() { return !!this.cfg && this.cfg.enabled !== false; }

    // The settings for one group: the service's, with the group's own pace over them.
    paceOf(meta) {
        return meta && meta.pace ? Object.assign({}, this.cfg, meta.pace) : this.cfg;
    }

    configure(dataDir) {
        const phone = this.cfg.dir || path.join(path.dirname(this.d.cfg.mailbox.dir), 'groups');
        if (this.dir !== phone) {
            this.dir = phone;
            this.metaCache.clear();
            this.members.clear();
            try { fsx.ensureDir(phone); } catch (e) { this.log.warn('groups: ' + e.message); }
        }
        const data = path.join(dataDir, 'groups');
        if (this.dataDir !== data) {
            this.dataDir = data;
            this.states.clear();
            try { fsx.ensureDir(data); } catch (e) { this.log.warn('groups: ' + e.message); }
        }
    }

    groupDir(id) {
        if (!ID_RE.test(str(id))) throw new Error('invalid group ' + id);
        return path.join(this.dir, 'g-' + id);
    }

    file(id, name) {
        return path.join(this.groupDir(id), name + '.cfg');
    }

    // Which groups exist. The phone writes the list; a group folder with no list entry is still
    // honoured, so a half-written list cannot hide a conversation.
    list() {
        const out = new Set();
        const r = fsx.readJson(path.join(this.dir, 'list'));
        const v = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
        if (Array.isArray(v.groups)) {
            for (const g of v.groups) {
                const id = g && typeof g === 'object' ? str(g.id) : str(g);
                if (ID_RE.test(id)) out.add(id);
            }
        }
        let names = [];
        try { names = fs.readdirSync(this.dir, { withFileTypes: true }); } catch (e) { names = []; }
        for (const d of names) {
            if (!d.isDirectory() || !/^g-/.test(d.name)) continue;
            const id = d.name.slice(2);
            if (ID_RE.test(id)) out.add(id);
        }
        return Array.from(out);
    }

    // Name, owner and members, as the phone wrote them. Invalid entries are dropped rather than
    // guessed: a group of one is not a group.
    meta(id) {
        const hit = this.metaCache.get(id);
        const now = Date.now();
        if (hit && now - hit.at < META_TTL_MS) return hit.value;
        const r = fsx.readJson(this.file(id, 'meta'));
        let value = null;
        if (r.ok && r.value && typeof r.value === 'object') {
            const v = r.value;
            const members = [];
            const seen = new Set();
            for (const m of Array.isArray(v.members) ? v.members : []) {
                const mid = cleanId(m && typeof m === 'object' ? (m.id !== undefined ? m.id : m.entity_id) : m);
                if (!mid || seen.has(mid)) continue;
                seen.add(mid);
                members.push({ id: mid, name: realName(m && typeof m === 'object' ? m.name : '', mid).slice(0, 20) });
                if (members.length >= (this.cfg.max_members || 8)) break;
            }
            const owner = cleanId(v.owner);
            // The phone cannot delete files: a disbanded group is marked closed instead, and is
            // ignored here so nobody answers in it any more.
            if (members.length && owner && !v.closed) {
                value = {
                    id,
                    name: sanitizeText(str(v.name), 20) || '群聊',
                    owner,
                    members,
                    auto: v.auto !== false,
                    createdAt: Number(v.createdAt) || 0,
                    // A class chat (classgroup.js): what kind of group, and how lively it is.
                    kind: v.kind === 'class' ? 'class' : '',
                    // The played member a service-made group belongs to (classgroup.js): only the
                    // player types for them, whoever the game says is played at that moment.
                    player: cleanId(v.player),
                    pace: cleanPace(v.pace)
                };
            }
        }
        this.metaCache.set(id, { at: now, value });
        return value;
    }

    // Array, or null when the file is mid-write.
    readBox(id, name) {
        const file = this.file(id, name);
        const r = fsx.readJson(file);
        if (r.ok && Array.isArray(r.value)) return r.value;
        if (r.ok) return [];
        // Never written (a group this service made, before the player says anything in it): empty,
        // not mid-write, or the group could never carry on by itself.
        return fs.existsSync(file) ? null : [];
    }

    // Appends one message said by a member (never the player: the phone writes those).
    append(id, msg) {
        const body = sanitizeText(msg.text, this.cfg.bubble_max_chars || 120);
        if (!body) return null;
        const file = this.file(id, 'inbox');
        fsx.ensureDir(path.dirname(file));
        return fsx.withLock(file + '.lock', () => {
            const r = fsx.readJson(file);
            const list = r.ok && Array.isArray(r.value) ? r.value : [];
            const last = list.reduce((max, m) => Math.max(max, Number(m && m.at) || 0), 0);
            const at = Math.max(Date.now(), last + 1);
            const entry = {
                id: 'g-' + at + '-' + crypto.randomBytes(3).toString('hex'),
                from: String(msg.from),
                name: sanitizeText(str(msg.name), 20),
                text: body,
                at
            };
            if (Array.isArray(msg.to) && msg.to.length) entry.to = msg.to.slice(0, 8).map(String);
            if (msg.replyTo) entry.replyTo = String(msg.replyTo);
            if (msg.game) entry.game = msg.game;
            list.push(entry);
            fsx.writeJson(file, list.slice(-(this.cfg.keep_messages || KEEP)));
            return entry;
        });
    }

    // Texts > Clear empties the groups as well as the 1:1 threads. The groups themselves (name,
    // members) stay. Like mailbox.clearConversations, this is the one place the service writes
    // the phone's outbox, and only ever an empty list. Who spoke last and what is queued go too,
    // so nobody picks the erased conversation up again on their own.
    clearMessages() {
        if (!this.dir) return 0;
        let messages = 0;
        for (const id of this.list()) {
            for (const name of ['outbox', 'inbox']) {
                const file = this.file(id, name);
                const before = fsx.readJson(file);
                if (before.ok && Array.isArray(before.value)) messages += before.value.length;
                if (!fs.existsSync(file)) continue;
                fsx.withLock(file + '.lock', () => { fsx.writeJson(file, []); });
                const after = fsx.readJson(file);
                const left = after.ok && Array.isArray(after.value) ? after.value.length : -1;
                if (left !== 0) throw new Error('group ' + id + ' ' + name + ' still has ' + left);
            }
            const seen = this.file(id, 'seen');
            if (fs.existsSync(seen)) fsx.withLock(seen + '.lock', () => { fsx.writeJson(seen, { at: 0 }); });
            if (fs.existsSync(this.file(id, 'status'))) this.writeStatus(id, { typing: '' });
            const st = this.state(id);
            Object.assign(st, { lastAt: 0, lastFrom: '', lastPlayerAt: 0, queue: [], recent: [] });
            this.saveState(id, st);
        }
        return messages;
    }

    writeStatus(id, patch) {
        const r = fsx.readJson(this.file(id, 'status'));
        const cur = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
        fsx.writeJson(this.file(id, 'status'), Object.assign(cur, patch, { heartbeat: Date.now() }), false);
    }

    state(id) {
        let st = this.states.get(id);
        if (st) return st;
        const file = path.join(this.dataDir, id + '.json');
        const r = fsx.readJson(file);
        st = Object.assign(emptyState(), r.ok && r.value && typeof r.value === 'object' ? r.value : {});
        if (!Array.isArray(st.queue)) st.queue = [];
        if (!Array.isArray(st.recent)) st.recent = [];
        this.states.set(id, st);
        return st;
    }

    saveState(id, st) {
        const file = path.join(this.dataDir, id + '.json');
        try { fsx.writeJson(file, st, true); } catch (e) { this.log.warn('groups: ' + e.message); }
    }

    // One line at a time, so a group cannot starve the rest of the bridge.
    async tick() {
        if (!this.enabled || !this.dir || this.busy) return;
        if (this.d.householdOk === false) return;
        // Texts > Clear is waiting: nothing new may land in a group about to be emptied.
        if (this.d.clearRequestAt && this.d.clearRequestAt()) return;
        if (!this.d.llm || !this.d.llm.configured) return;
        const now = Date.now();
        for (const id of this.list()) {
            const meta = this.meta(id);
            if (!meta) continue;
            const st = this.state(id);
            const due = (st.queue || []).filter((q) => q && q.at <= now).sort((a, b) => a.at - b.at)[0];
            if (due) {
                this.busy = true;
                try { await this.say(id, meta, st, due); }
                catch (e) { this.note(id, e && e.message || e); }
                finally { this.busy = false; }
                return;
            }
            const out = this.readBox(id, 'outbox');
            if (out === null) continue;
            const fresh = out.filter((m) => m && Number(m.at) > Number(st.seenAt || 0));
            if (fresh.length) {
                st.seenAt = fresh.reduce((max, m) => Math.max(max, Number(m.at) || 0), 0);
                st.lastPlayerAt = Date.now();
                this.plan(id, meta, st, fresh, 'player');
                this.saveState(id, st);
                return;
            }
            if (this.canAuto(meta, st, now)) {
                this.planAuto(id, meta, st, now);
                return;
            }
        }
    }

    note(id, message) {
        const key = id + '|' + str(message).slice(0, 80);
        if (this.reported.has(key)) return;
        this.reported.add(key);
        this.log.warn('groups [' + id + '] ' + message);
    }

    // Everything in this group in one list, oldest first, with the speaker's name on every line.
    // playerId: who this turn is written for; only their own lines are marked player. names: id ->
    // name for people the group file does not name (its owner).
    history(id, meta, limit, playerId, names) {
        const out = this.readBox(id, 'outbox') || [];
        const inbox = this.readBox(id, 'inbox') || [];
        const rows = [];
        // An outbox line may have been written by another character using the same phone; its
        // author decides what the prompt calls it.
        const nameOf = (id) => {
            const hit = meta.members.find((m) => String(m.id) === String(id));
            return (hit && String(hit.name || '')) || (names && names[String(id)]) || '';
        };
        const me = String(playerId || meta.owner);
        for (const m of out) {
            if (!m || typeof m.text !== 'string' && !m.image) continue;
            // Lines from before the phone wrote an author were the owner's.
            const from = String(m.from || meta.owner);
            rows.push({ id: String(m.id || ''), at: Number(m.at) || 0, from, name: nameOf(from), text: m.text, player: from === me, replyTo: m.replyTo || '' });
        }
        for (const m of inbox) {
            if (!m || typeof m.text !== 'string') continue;
            const from = String(m.from || '');
            rows.push({ id: String(m.id || ''), at: Number(m.at) || 0, from, name: realName(m.name, from) || nameOf(from), text: m.text, player: false, to: m.to || [], replyTo: m.replyTo || '' });
        }
        rows.sort((a, b) => a.at - b.at || (a.player === b.player ? 0 : a.player ? -1 : 1));
        return rows.slice(-(limit || this.cfg.history_shown || 30));
    }

    // Who answers. Mentions and the author of the quoted message must; the rest compete.
    plan(id, meta, st, fresh, kind) {
        const now = Date.now();
        const pace = this.paceOf(meta);
        const authors = fresh.map((m) => str(m && m.from) || String(meta.owner));
        const author = authors[authors.length - 1] || String(meta.owner);
        st.playerFrom = author;
        const members = people(meta).map((m) => m.id).filter((x) => authors.indexOf(x) < 0);
        const mentions = [];
        let quote = '';
        const texts = [];
        for (const m of fresh) {
            if (Array.isArray(m.mentions)) for (const a of m.mentions) if (members.indexOf(String(a)) >= 0 && mentions.indexOf(String(a)) < 0) mentions.push(String(a));
            if (m.replyTo && !quote) quote = String(m.replyTo);
            if (typeof m.text === 'string') texts.push(m.text);
        }
        const inbox = this.readBox(id, 'inbox') || [];
        const quoted = quote ? inbox.find((m) => m && String(m.id) === quote) : null;
        const quotedFrom = quoted ? String(quoted.from) : '';
        const forced = [];
        for (const a of mentions) forced.push(a);
        if (quotedFrom && forced.indexOf(quotedFrom) < 0) forced.push(quotedFrom);
        const text = texts.join(' ');
        const speakers = [];
        for (const who of forced) {
            if (speakers.length >= (pace.max_replies_per_turn || 2)) break;
            speakers.push({ from: who, why: mentions.indexOf(who) >= 0 ? '点了名' : '被引用' });
        }
        if (!speakers.length) {
            // Nobody was asked. A group does not answer every line; the chance below is what keeps
            // it from feeling like a help desk.
            if (Math.random() < (pace.silence_chance || 0)) return;
            const ranked = this.rank(meta, st, text, now, authors);
            if (!ranked.length) return;
            speakers.push({ from: ranked[0], why: '接话' });
            if (ranked.length > 1 && (pace.max_replies_per_turn || 2) > 1 && Math.random() < (pace.second_reply_chance || 0.35)) {
                speakers.push({ from: ranked[1], why: '补充' });
            }
            if (ranked.length > 2 && (pace.max_replies_per_turn || 2) > 2 && Math.random() < (pace.second_reply_chance || 0.35) / 2) {
                speakers.push({ from: ranked[2], why: '起哄' });
            }
        }
        // What the answer will be shown as replying to: the line the player quoted, or the newest
        // line the player wrote. Taken here rather than from the model, which never sees message ids.
        const lastPlayer = fresh.filter((m) => m && str(m.text)).slice(-1)[0];
        const replyTo = quotedFrom ? quote : (lastPlayer ? str(lastPlayer.id) : '');
        let at = now;
        for (const s of speakers) {
            at += (pace.min_gap_ms || 3000) + Math.random() * Math.max(0, (pace.max_gap_ms || 12000) - (pace.min_gap_ms || 3000));
            st.queue.push({ at, from: s.from, why: s.why, quote: quotedFrom && s.from === quotedFrom ? quote : '', replyTo, mentions, kind, author });
        }
        st.queue = st.queue.slice(-8);
        this.log.info('groups [' + id + '] plan: ' + speakers.map((s) => s.from + '(' + s.why + ')').join(', ') + (quote ? ' quote=' + quote : ''));
    }

    // Nobody spoke; is this conversation allowed to go on by itself?
    canAuto(meta, st, now) {
        const pace = this.paceOf(meta);
        if (this.cfg.auto_chat === false || meta.auto === false) return false;
        if (!st.lastFrom || st.lastFrom === 'player') return false;
        // One line on its way at a time, or every tick queues another one and the group stutters.
        if ((st.queue || []).length) return false;
        const idle = now - Number(st.lastAt || 0);
        if (!st.lastAt || idle > (pace.topic_idle_minutes || 20) * 60000) return false;
        if (idle < (pace.auto_gap_min_ms || 25000)) return false;
        this.rollBudget(st, now);
        if ((st.budget || 0) >= (pace.max_per_hour || 24)) return false;
        if ((st.autoBudget || 0) >= (pace.max_auto_per_hour || 6)) return false;
        // Spread over the hour, not spent in its first minutes: a burst for a new topic, then the
        // allowance comes back as the hour goes on.
        if ((st.autoBudget || 0) >= autoAllowance(pace, now - Number(st.budgetStart || now))) return false;
        const hour = this.gameHour();
        if (hour !== null && this.quiet(hour, pace)) return false;
        // A second line in a row is rarer than the first: the longer nobody moves, the less
        // likely the next one is.
        const chance = idle > 5 * 60000 ? (pace.auto_chance_stale || 0.1) : (pace.auto_chance || 0.25);
        return Math.random() < chance;
    }

    planAuto(id, meta, st, now) {
        const ranked = this.rank(meta, st, '', now, st.playerFrom ? [String(st.playerFrom)] : []);
        if (!ranked.length) return;
        const pace = this.paceOf(meta);
        const gap = (pace.auto_gap_min_ms || 25000) + Math.random() * Math.max(0, (pace.auto_gap_max_ms || 90000) - (pace.auto_gap_min_ms || 25000));
        st.queue.push({ at: now + gap, from: ranked[0], why: '自己接着说', quote: '', replyTo: '', mentions: [], kind: 'auto', author: str(st.playerFrom) });
        st.queue = st.queue.slice(-8);
        // Held now, so the next tick does not plan another line while this one is on its way.
        st.lastAt = now;
        this.saveState(id, st);
        this.log.info('groups [' + id + '] auto: ' + ranked[0]);
    }

    // Members by how likely they are to answer this line. Mentions and quotes never get here.
    rank(meta, st, text, now, exclude) {
        const recent = (st.recent || []).slice(-4).map((r) => String(r.from));
        const out = [];
        for (const m of people(meta)) {
            if (m.id === String(st.lastFrom || '')) continue;
            if (meta.player && m.id === meta.player) continue;
            if (exclude && exclude.indexOf(m.id) >= 0) continue;
            let score = 40 + Math.random() * 30;
            if (recent.indexOf(m.id) >= 0) score -= 35;
            if (text && m.name && text.indexOf(m.name) >= 0) score += 120;
            out.push({ id: m.id, score });
        }
        out.sort((a, b) => b.score - a.score);
        return out.map((x) => x.id);
    }

    rollBudget(st, now) {
        const start = Number(st.budgetStart || 0);
        if (!start || now - start > 3600000) {
            st.budgetStart = now;
            st.budget = 0;
            st.autoBudget = 0;
        }
    }

    gameHour() {
        try {
            const g = this.d.gameNow ? this.d.gameNow() : null;
            if (!g || typeof g !== 'object') return null;
            if (typeof g.hour === 'number') return g.hour;
            if (g.env && typeof g.env.hour === 'number') return g.env.hour;
        } catch (e) { /* the clock is a nicety */ }
        return null;
    }

    quiet(hour, pace) {
        const q = (pace || this.cfg).quiet_game_hours;
        if (!Array.isArray(q) || q.length < 2) return false;
        return hour >= q[0] && hour < q[1];
    }

    // Names and what everyone is doing, so the speaker knows who is in the room with her.
    async roster(meta, speakerId, player) {
        player = player || await this.world.possessed();
        const out = [];
        for (const m of people(meta)) {
            // The player is who the prompt calls by their family word, not a third person.
            if (m.id === String(speakerId) || m.id === String(player)) continue;
            const info = await this.member(m.id, player);
            out.push({ id: m.id, name: info.name || m.name || m.id, label: info.label || '', site: info.site || '', activity: info.activity || '', outsider: !!info.outsider });
        }
        return out;
    }

    async member(id, player) {
        const key = String(player) + '>' + String(id);
        const hit = this.members.get(key);
        if (hit && Date.now() - hit.at < MEMBER_TTL_MS) return hit.value;
        let value = { id: String(id), name: '', label: '', site: '', activity: '', outsider: false };
        try {
            const pair = await this.world.pair(player, id, { group: true });
            const p = pair.partner || {};
            value = {
                id: String(id),
                name: p.name || '',
                label: pair.role === 'family' ? '' : (pair.role || ''),
                site: p.site || '',
                activity: p.activity && (p.activity.name || p.activity.id) || '',
                outsider: !!pair.outsider
            };
        } catch (e) {
            this.note('member:' + id, e && e.message || e);
        }
        this.members.set(key, { at: Date.now(), value });
        return value;
    }

    // The player wrote and the one picked to answer had nothing to say: the line goes to the next
    // person once, so a message to the group is not met by nobody. Lines nobody asked for (auto)
    // are left to die out.
    passOn(id, meta, st, job) {
        if (!job || job.kind !== 'player' || job.retry) return;
        if ((st.queue || []).some((q) => q && q.kind === 'player')) return;
        const next = this.rank(meta, Object.assign({}, st, { lastFrom: job.from }), '', Date.now(), job.author ? [String(job.author)] : [])[0];
        if (!next) return;
        st.queue.push(Object.assign({}, job, { at: Date.now() + (this.cfg.min_gap_ms || 3000), from: next, why: '接话', quote: '', retry: true }));
        this.log.info('groups [' + id + '] passed on to ' + next);
    }

    // One character writes one line into the group.
    async say(id, meta, st, job) {
        // The line leaves the queue first: one from someone no longer in the group (a class whose
        // members changed) would otherwise stay due forever and hold the group, and every group
        // after it, still.
        st.queue = (st.queue || []).filter((q) => q !== job);
        this.saveState(id, st);
        const member = people(meta).find((m) => m.id === String(job.from));
        if (!member) return;
        const possessed = await this.world.possessed();
        if (!possessed) return;
        // The played character says only what the player types.
        if (member.id === String(possessed) || (meta.player && member.id === meta.player)) {
            this.passOn(id, meta, st, Object.assign({}, job, { author: job.author || String(possessed) }));
            this.saveState(id, st);
            return;
        }
        // The line is written to whoever wrote the line it answers: their name, and the speaker's
        // family word for them. With nobody to answer (auto), the played character if they are in
        // the group, else the one who made it.
        const inGroup = (x) => people(meta).some((m) => m.id === String(x));
        const candidates = [];
        for (const c of [job.author, inGroup(possessed) ? possessed : '', meta.owner, possessed]) {
            const s = str(c);
            if (s && s !== member.id && candidates.indexOf(s) < 0) candidates.push(s);
        }
        let player = '';
        let pair = null;
        let failed = '';
        for (const c of candidates) {
            try { pair = await this.world.pair(c, member.id, { group: true }); player = c; break; } catch (e) { failed = e && e.message || String(e); }
        }
        if (!pair) { this.note(id, 'cannot speak as ' + member.id + ': ' + failed); return; }
        let snap = null;
        try { snap = await this.world.snapshot(pair); } catch (e) { this.note(id, 'snapshot ' + (e && e.message || e)); }
        if (!snap) return;
        // What she really ate today, for a "吃了没" asked in the group (eaten.js).
        if (snap.env && snap.partner && typeof this.d.mealsToday === 'function') {
            const eaten = this.d.mealsToday(member.id, snap.env);
            snap.partner.meals = eaten.meals;
            snap.partner.mealsSince = eaten.since;
        }
        // The game's name for her, should the group have stored none.
        const name = member.name || realName(snap.partner && snap.partner.name, member.id) || (await this.member(member.id, player)).name || member.id;
        const roster = await this.roster(meta, member.id, player);
        const names = {};
        for (const r of roster) if (r.name) names[r.id] = r.name;
        const history = this.history(id, meta, this.cfg.history_shown || 30, player, names);
        const prompt = persona.groupPrompt({ snap, cfg: this.d.cfg, group: meta, roster, history, job });
        this.writeStatus(id, { typing: member.id });
        const started = Date.now();
        let result;
        try {
            result = await this.d.llm.json(prompt.system, prompt.user, { purpose: 'group', voice: ['messages'], max_tokens: 400, thinking: 'disabled' });
        } catch (e) {
            this.writeStatus(id, { typing: '' });
            throw e;
        }
        const texts = [];
        for (const t of Array.isArray(result && result.messages) ? result.messages : []) {
            const body = shortLine(sanitizeText(t, 400), this.cfg.bubble_max_chars || 24);
            if (body) texts.push(body);
            if (texts.length >= (this.cfg.max_bubbles || 2)) break;
        }
        this.writeStatus(id, { typing: '' });
        // A line the speaker has to say (a task the boss handed them) is said, plainly if need be.
        if (!texts.length && job.duty) texts.push('收到，我来。');
        if (!texts.length) {
            this.log.info('groups [' + id + '] ' + name + ' stayed quiet');
            st.lastAt = Date.now();
            this.passOn(id, meta, st, job);
            this.saveState(id, st);
            return;
        }
        const at = (Array.isArray(result && result.at) ? result.at : []).map(String).filter((a) => people(meta).some((m) => m.id === a)).slice(0, 4);
        const replyTo = str(job.replyTo);
        const game = gameStamp(snap.env || null);
        for (const body of texts) {
            this.append(id, { from: member.id, name, text: body, to: at, replyTo, game: game || undefined });
        }
        st.lastAt = Date.now();
        st.lastFrom = member.id;
        this.rollBudget(st, st.lastAt);
        st.budget = (st.budget || 0) + texts.length;
        if (job.kind === 'auto') st.autoBudget = (st.autoBudget || 0) + texts.length;
        st.recent = (st.recent || []).concat([{ at: st.lastAt, from: member.id }]).slice(-12);
        this.saveState(id, st);
        this.log.info('groups [' + id + '] ' + name + ' -> ' + JSON.stringify(texts.join(' / ')) +
            (at.length ? ' @' + at.join(',') : '') + (replyTo ? ' to=' + replyTo : '') + ' (' + (Date.now() - started) + 'ms)');
    }
}

module.exports = { Groups, MEMBER_RE, ID_RE, autoAllowance };
