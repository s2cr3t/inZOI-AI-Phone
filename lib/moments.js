'use strict';
// Moments (朋友圈) for the phone.
//
// Files next to the SMS mailbox (<mod>/ui/phone/moments/), each with a single writer:
//   feed.cfg               every post with its likes and comments, plus circles (who each played
//                          character knows) and applied (player actions already merged). Bridge only.
//   status.cfg             bridge presence for the phone. Bridge only.
//   <viewerId>/outbox.cfg  actions of the player while playing that character: post, like, unlike,
//                          comment, delete. Phone only.
//   <viewerId>/seen.cfg    newest feed item the player has looked at. Phone only.
//
// The phone shows a post when its author is in the viewer's circle (or is the viewer), and a like
// or comment only when its author is, like WeChat shows only mutual friends.
//
// The bridge writes posts for the people the played character knows, lets the people who know the
// author like and comment later on, answers comments the player leaves and reacts to the player's
// own posts. Follow-up work is kept in data/moments-state.json so a restart does not lose it.
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');
const { sanitizeText, gameStamp } = require('./mailbox');
const { GameOfflineError } = require('./game');
const { LlmError } = require('./llm');
const { fullName, canText, kinOf } = require('./world');
const persona = require('./persona');
const prompts = require('./moments-prompt');
const emoji = require('./emoji');

const POST_MAX = 300;
const COMMENT_MAX = 140;
const PLACE_MAX = 30;
const APPLIED_KEEP = 400;
const COMMENTS_KEEP = 40;
const LIKES_KEEP = 60;
const TASKS_KEEP = 40;
const TASK_TRIES = 4;
const ID_RE = /^\d+$/;
const NO_PHONE = { Baby: true, Infant: true, Toddler: true };

function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

function newId(prefix) { return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

// A { day, min } game-time stamp sent by the phone, or null.
function gameOf(g) {
    return g && typeof g.day === 'number' && typeof g.min === 'number' ? { day: g.day, min: g.min } : null;
}

function str(v) { return v === undefined || v === null ? '' : String(v); }

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// What `otherId` is to `selfId` when both live in the played household, in the words `selfId`
// would use (妈妈 / 女儿 / 丈夫 ...); '' when unknown or not one household.
function kinWord(hh, selfId, selfGender, otherId, otherGender) {
    const self = hh.members.find((m) => String(m.entity_id) === String(selfId));
    const other = hh.members.find((m) => String(m.entity_id) === String(otherId));
    if (!self || !other || self === other) return '';
    const kin = kinOf(self, other, hh);
    if (kin.role === 'family') return kin.label;
    return persona.termsFor(kin.role, selfGender, otherGender, '', '').me;
}

function emptyFeed() { return { v: 1, updatedAt: 0, posts: [], circles: {}, applied: {} }; }

function cleanFeed(value) {
    const f = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const feed = emptyFeed();
    feed.updatedAt = typeof f.updatedAt === 'number' ? f.updatedAt : 0;
    feed.posts = Array.isArray(f.posts) ? f.posts.filter((p) => p && typeof p.id === 'string' && typeof p.text === 'string' && typeof p.at === 'number') : [];
    for (const p of feed.posts) {
        p.authorId = str(p.authorId);
        p.authorFirst = str(p.authorFirst);
        p.likes = Array.isArray(p.likes) ? p.likes.filter((l) => l && l.id !== undefined) : [];
        p.comments = Array.isArray(p.comments) ? p.comments.filter((c) => c && typeof c.id === 'string' && typeof c.text === 'string') : [];
    }
    feed.circles = f.circles && typeof f.circles === 'object' ? f.circles : {};
    feed.applied = f.applied && typeof f.applied === 'object' ? f.applied : {};
    return feed;
}

// occasions: something worth a post by a given author (a story of theirs the viewer helped
// through), posted once its time comes: { authorId, viewerId, text, after, until }.
function emptyState() { return { lastPostAt: 0, nextPostAt: 0, authors: {}, posted: [], queue: [], tasks: [], occasions: [] }; }
const OCCASIONS_KEEP = 8;

class MomentsStore {
    constructor(dir) {
        this.dir = dir;
    }

    file(name) { return path.join(this.dir, name + '.cfg'); }

    viewerFile(viewerId, name) {
        if (!ID_RE.test(String(viewerId))) throw new Error('invalid viewer ' + viewerId);
        return path.join(this.dir, String(viewerId), name + '.cfg');
    }

    ensureViewer(viewerId) {
        fsx.ensureDir(path.dirname(this.viewerFile(viewerId, 'outbox')));
    }

    // The feed has a single writer (this process), so an unreadable file is damage, not a
    // half-written save: it is moved aside, never overwritten, and a fresh feed is started.
    loadFeed(log) {
        const file = this.file('feed');
        const r = fsx.readJson(file);
        if (r.ok) return cleanFeed(r.value);
        if (r.missing) return emptyFeed();
        const aside = file + '.damaged-' + Date.now();
        try {
            fs.renameSync(file, aside);
            log.error('moments feed was unreadable (' + r.error + '), kept as ' + aside + ' and started a new one');
        } catch (e) {
            log.error('moments feed is unreadable (' + r.error + ') and could not be moved aside: ' + e.message);
            throw e;
        }
        return emptyFeed();
    }

    saveFeed(feed) {
        feed.updatedAt = Date.now();
        fsx.writeJson(this.file('feed'), feed);
    }

    writeStatus(status) {
        fsx.writeJson(this.file('status'), status);
    }

    viewers() {
        let names = [];
        try { names = fs.readdirSync(this.dir, { withFileTypes: true }); } catch (e) { return []; }
        return names.filter((d) => d.isDirectory() && ID_RE.test(d.name)).map((d) => d.name);
    }

    // Player actions of one viewer, or null while the phone is writing the file.
    readOutbox(viewerId) {
        const r = fsx.readJson(this.viewerFile(viewerId, 'outbox'));
        if (r.missing) return [];
        if (!r.ok) return null;
        const list = Array.isArray(r.value) ? r.value : [];
        return list.filter((a) => a && typeof a.id === 'string' && typeof a.kind === 'string' && typeof a.at === 'number');
    }
}

class Moments {
    constructor(daemon) {
        this.d = daemon;
        this.store = null;
        this.feed = null;
        this.dirty = false;
        this.stateFile = null;
        this.state = null;
        this.working = false;
        this.planning = false;
        this.circleCache = new Map();
    }

    get log() { return this.d.log; }
    get cfg() { return this.d.cfg.moments; }
    get world() { return this.d.world; }

    // Called whenever the bridge (re)loads its configuration.
    configure(dataDir) {
        const dir = path.join(path.dirname(this.d.cfg.mailbox.dir), 'moments');
        if (!this.store || this.store.dir !== dir) {
            this.store = new MomentsStore(dir);
            fsx.ensureDir(dir);
            this.feed = this.store.loadFeed(this.log);
            this.log.info('moments: ' + this.feed.posts.length + ' post(s) in ' + dir);
        }
        if (!this.stateFile) {
            this.stateFile = path.join(dataDir, 'moments-state.json');
            const r = fsx.readJson(this.stateFile);
            const v = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
            this.state = Object.assign(emptyState(), v);
            for (const k of ['posted', 'queue', 'tasks', 'occasions']) if (!Array.isArray(this.state[k])) this.state[k] = [];
            if (!this.state.authors || typeof this.state.authors !== 'object') this.state.authors = {};
        }
    }

    saveState() {
        fsx.writeJson(this.stateFile, this.state, true);
    }

    commit() {
        if (!this.dirty) return;
        this.store.saveFeed(this.feed);
        this.dirty = false;
    }

    // ------------------------------------------------------------- presence
    heartbeat() {
        let state = 'online';
        let error = '';
        if (!this.cfg.enabled) { state = 'paused'; error = 'Moments are off'; }
        else if (this.d.cfg.mode !== 'auto') { state = 'paused'; error = 'Auto replies are off'; }
        else if (!this.d.llm.configured) { state = 'error'; error = 'AI not configured'; }
        try {
            this.store.writeStatus({ v: 1, state, error, heartbeat: Date.now() });
        } catch (e) {
            this.log.debug('moments status write failed: ' + e.message);
        }
    }

    stopped() {
        try { this.store.writeStatus({ v: 1, state: 'offline', error: 'Bridge stopped', heartbeat: Date.now() }); } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------- helpers
    post(id) {
        return this.feed.posts.find((p) => p.id === id) || null;
    }

    nameOf(id, fallback) {
        const key = str(id);
        for (const c of Object.values(this.feed.circles)) {
            if (c && c.names && c.names[key]) return c.names[key];
        }
        return fallback || ('#' + key);
    }

    async resolveName(id) {
        const hh = await this.world.household();
        const m = hh.members.find((x) => String(x.entity_id) === String(id));
        if (m) return fullName(m);
        const info = await this.world.characterInfo(id);
        return info ? fullName(info) : this.nameOf(id);
    }

    gameStamp(env) {
        if (!env || typeof env.hour !== 'number') return '';
        return (env.day_of_week ? env.day_of_week + ' ' : '') + pad2(env.hour) + ':' + pad2(env.minute || 0);
    }

    trim() {
        const keep = this.cfg.keep_posts;
        if (this.feed.posts.length > keep) {
            const dropped = this.feed.posts.splice(0, this.feed.posts.length - keep);
            const gone = new Set(dropped.map((p) => p.id));
            this.state.queue = this.state.queue.filter((q) => !gone.has(q.postId));
            this.state.tasks = this.state.tasks.filter((t) => !gone.has(t.postId));
        }
        for (const p of this.feed.posts) {
            if (p.comments.length > COMMENTS_KEEP) p.comments = p.comments.slice(p.comments.length - COMMENTS_KEEP);
            if (p.likes.length > LIKES_KEEP) p.likes = p.likes.slice(p.likes.length - LIKES_KEEP);
        }
    }

    inQuietHours(env) {
        if (!env || typeof env.hour !== 'number') return false;
        const q = this.cfg.quiet_game_hours;
        return q[0] <= q[1] ? env.hour >= q[0] && env.hour < q[1] : env.hour >= q[0] || env.hour < q[1];
    }

    aiAllowed() {
        return this.cfg.enabled && this.d.cfg.mode === 'auto' && this.d.llm.configured;
    }

    // ------------------------------------------------------------- circles
    // Everyone the viewer knows and may see in Moments: household members first, then the
    // people with a relationship, closest first.
    async circleOf(viewerId) {
        const key = String(viewerId);
        const hit = this.circleCache.get(key);
        if (hit && Date.now() - hit.at < 60000) return hit.list;
        const hh = await this.world.household();
        const byId = new Map();
        const inHousehold = hh.members.some((m) => String(m.entity_id) === key);
        if (inHousehold) {
            for (const m of hh.members) {
                const id = String(m.entity_id);
                if (id === key || !canText(m)) continue;
                byId.set(id, { id, name: fullName(m), household: true, family: true, closeness: 100 });
            }
        }
        for (const r of await this.world.relations(key)) {
            if (r.id === key) continue;
            const values = Object.keys(r.stats).map((k) => r.stats[k]);
            const closeness = values.length ? Math.max.apply(null, values) : 0;
            if (!r.isFamily && closeness < this.cfg.min_relationship) continue;
            const prev = byId.get(r.id);
            if (prev) { prev.family = prev.family || r.isFamily; continue; }
            byId.set(r.id, { id: r.id, name: r.name, household: false, family: r.isFamily, closeness: r.isFamily ? Math.max(closeness, 50) : closeness });
        }
        const list = Array.from(byId.values())
            .sort((a, b) => (b.household ? 1 : 0) - (a.household ? 1 : 0) || b.closeness - a.closeness)
            .slice(0, this.cfg.max_circle);
        this.circleCache.set(key, { at: Date.now(), list });
        return list;
    }

    publishCircle(viewerId, list, viewerName) {
        const key = String(viewerId);
        const ids = list.map((c) => c.id);
        const names = {};
        for (const c of list) names[c.id] = c.name;
        names[key] = viewerName;
        const prev = this.feed.circles[key];
        const same = prev && Array.isArray(prev.ids) && prev.ids.join(',') === ids.join(',') &&
            JSON.stringify(prev.names || {}) === JSON.stringify(names);
        if (same) return;
        this.feed.circles[key] = { at: Date.now(), ids, names };
        this.dirty = true;
        this.log.info('moments: circle of ' + viewerName + ' (' + key + ') = ' + list.map((c) => c.name).join(', '));
    }

    // ------------------------------------------------------------- tracker hook
    // Runs with the tracker for the played character: keeps its circle current and from time to
    // time lets one of the people it knows post something.
    async track(viewerId, env) {
        const key = String(viewerId);
        this.store.ensureViewer(key);
        const circle = await this.circleOf(key);
        this.publishCircle(key, circle, await this.resolveName(key));
        this.commit();
        this.syncPortraits(key, circle);
        await this.maybePost(key, circle, env);
    }

    // The viewer and everyone they would see on Moments. Missing portraits stay as letters.
    syncPortraits(viewerId, circle) {
        if (!this.d.portraits) return;
        const ids = [viewerId];
        for (const c of circle) ids.push(c.id);
        try {
            this.d.portraits.sync(ids);
        } catch (e) {
            this.log.warn('portraits: ' + (e && e.message || e));
        }
    }

    // Something worth a post for authorId, seen by viewerId's circle: written between delayMs and
    // delayMs + keepMs from now, in place of a random post.
    occasion(authorId, viewerId, text, delayMs, keepMs) {
        if (!this.cfg.enabled || !this.state) return;
        const now = Date.now();
        const why = sanitizeText(text, 200);
        if (!why) return;
        this.state.occasions = this.state.occasions.filter((o) => o && o.until > now && !(String(o.authorId) === String(authorId) && o.text === why));
        this.state.occasions.push({ authorId: String(authorId), viewerId: String(viewerId), text: why, after: now + Math.max(0, delayMs || 0), until: now + Math.max(0, delayMs || 0) + (keepMs || 6 * 3600000) });
        this.state.occasions = this.state.occasions.slice(-OCCASIONS_KEEP);
        this.saveState();
        this.log.info('moments: ' + authorId + ' has something to post about later: ' + why);
    }

    // The occasion due now for someone in the circle, or null; past ones are dropped.
    dueOccasion(viewerId, circle, now) {
        const before = this.state.occasions.length;
        this.state.occasions = this.state.occasions.filter((o) => o && o.until > now);
        if (this.state.occasions.length !== before) this.saveState();
        const ids = new Set(circle.map((p) => p.id));
        return this.state.occasions.find((o) => o.viewerId === String(viewerId) && o.after <= now && ids.has(o.authorId)) || null;
    }

    async maybePost(viewerId, circle, env) {
        const now = Date.now();
        const c = this.cfg;
        if (!this.aiAllowed() || this.working || !circle.length) return;
        const due = this.dueOccasion(viewerId, circle, now);
        if (due && !this.inQuietHours(env) && this.state.posted.filter((t) => now - t < 3600000).length < c.max_posts_per_hour) {
            const author = circle.find((p) => p.id === due.authorId);
            this.state.occasions = this.state.occasions.filter((o) => o !== due);
            this.saveState();
            this.working = true;
            try {
                // Asleep: the same thing is still worth a post when they wake up.
                if (await this.writePost(viewerId, author, env, due.text) === 'asleep') {
                    this.state.occasions.push(Object.assign({}, due, { after: Date.now() + 10 * 60000 }));
                    this.saveState();
                }
            } catch (e) {
                if (e instanceof GameOfflineError) throw e;
                this.log.warn('moments: post about ' + JSON.stringify(due.text) + ' failed: ' + (e && e.message || e));
            } finally {
                this.working = false;
            }
            return;
        }
        if (!this.state.nextPostAt) {
            this.state.nextPostAt = now + c.post_interval_minutes * 60000 * rand(0.2, 0.6);
            this.saveState();
            return;
        }
        if (now < this.state.nextPostAt) return;
        this.state.posted = this.state.posted.filter((t) => now - t < 3600000);
        const later = (minutes, why) => {
            this.state.nextPostAt = now + minutes * 60000;
            this.saveState();
            this.log.info('moments: no post now (' + why + '), next check in ' + Math.round(minutes) + ' min');
        };
        if (this.state.posted.length >= c.max_posts_per_hour) return later(10, 'hourly limit');
        if (this.inQuietHours(env)) return later(10, 'quiet hours');
        const cooldown = c.author_cooldown_minutes * 60000;
        const eligible = circle.filter((p) => !this.state.authors[p.id] || now - this.state.authors[p.id] >= cooldown);
        if (!eligible.length) return later(Math.max(5, c.post_interval_minutes / 3), 'everyone posted recently');
        let total = 0;
        const weights = eligible.map((p) => { const w = (p.household ? 2 : 1) + p.closeness / 50; total += w; return w; });
        let pick = Math.random() * total;
        let author = eligible[eligible.length - 1];
        for (let i = 0; i < eligible.length; i++) {
            pick -= weights[i];
            if (pick <= 0) { author = eligible[i]; break; }
        }
        this.working = true;
        try {
            await this.writePost(viewerId, author, env);
        } catch (e) {
            if (e instanceof GameOfflineError) throw e;
            if (e instanceof LlmError && e.permanent) {
                later(30, 'AI rejected the request: ' + e.message);
            } else {
                later(5, 'post failed: ' + (e && e.message || e));
            }
        } finally {
            this.working = false;
        }
    }

    // occasion: what this post is about (maybePost), or '' for whatever the author is up to.
    async writePost(viewerId, author, env, occasion) {
        const now = Date.now();
        const c = this.cfg;
        const profile = await this.world.profile(author.id);
        if (NO_PHONE[profile.ageGroup]) {
            this.state.authors[author.id] = now + 7 * 86400000;
            this.state.nextPostAt = now + 60000;
            this.saveState();
            return;
        }
        if (persona.isSleeping(profile.activity)) {
            this.state.authors[author.id] = now - c.author_cooldown_minutes * 60000 / 2;
            this.state.nextPostAt = now + 3 * 60000;
            this.saveState();
            this.log.info('moments: ' + profile.name + ' is asleep, picking someone else later');
            return 'asleep';
        }
        const relations = (await this.world.relations(author.id))
            .slice()
            .sort((a, b) => (b.isFamily ? 1 : 0) - (a.isFamily ? 1 : 0) || (b.stats.Friendship || 0) - (a.stats.Friendship || 0))
            .slice(0, 8);
        const hh = await this.world.household();
        const infos = await Promise.all(relations.map((r) => this.world.characterInfo(r.id)));
        const friends = relations.map((r, i) => {
            const info = infos[i] || null;
            return prompts.personLine(r, info, kinWord(hh, author.id, profile.gender, r.id, info && info.gender));
        });
        const recent = this.feed.posts.filter((p) => p.authorId === author.id).slice(-4).map((p) => p.text);
        const diary = profile.household ? this.d.todayDiary(author.id, env) : [];
        const extra = this.d.personas.extraFor(author.id, this.d.cfg.persona && this.d.cfg.persona.extra ? this.d.cfg.persona.extra[author.id] : '');
        const prompt = prompts.postPrompt({ profile, env, recent, friends, diary, extra, occasion: occasion || '' });
        this.log.debug('moments post prompt:\n' + prompt.system + '\n' + prompt.user);
        const result = await this.d.llm.json(prompt.system, prompt.user, { purpose: 'moments_post', voice: ['text'] });
        // Emoji characters become the phone's [name] tokens, as in texts.
        const text = sanitizeText(emoji.normalize((result && result.text) || ''), POST_MAX);
        this.state.lastPostAt = Date.now();
        this.state.nextPostAt = Date.now() + c.post_interval_minutes * 60000 * rand(0.6, 1.4);
        this.state.authors[author.id] = Date.now();
        if (!text || (result && result.skip === true)) {
            this.saveState();
            this.log.info('moments: ' + profile.name + ' chose not to post');
            return;
        }
        const post = {
            id: newId('p'),
            authorId: author.id,
            authorName: profile.name,
            authorFirst: profile.firstName,
            at: Date.now(),
            gameTime: this.gameStamp(env),
            game: gameStamp(env),
            place: sanitizeText(result.place, PLACE_MAX) || profile.site || '',
            text,
            source: 'ai',
            likes: [],
            comments: []
        };
        this.feed.posts.push(post);
        this.trim();
        this.dirty = true;
        this.commit();
        this.state.posted.push(Date.now());
        this.addTask({ type: 'reactions', postId: post.id, viewerId: String(viewerId) });
        this.saveState();
        this.log.info('moments: ' + profile.name + ' posted ' + JSON.stringify(text) + (post.place ? ' @' + post.place : ''));
        if (this.d.cfg.immersion.toast_on_message) {
            const preview = text.length > 30 ? text.slice(0, 30) + '…' : text;
            this.d.game.soft('toast_show', { Message: profile.name + ' 发了朋友圈：' + preview, Lifetime: 5 }).catch(() => {});
        }
    }

    // ------------------------------------------------------------- reactions
    // People in the viewer's circle who know the author (the viewer reacts by hand).
    async reactorsFor(post, viewerId) {
        const circle = await this.circleOf(viewerId);
        const authorId = post.authorId;
        if (authorId === String(viewerId)) {
            return circle.map((c) => ({ id: c.id, closeness: c.closeness }));
        }
        const rel = await this.world.relations(authorId);
        const known = new Map(rel.map((r) => [r.id, r]));
        const hh = await this.world.household();
        const authorAtHome = hh.members.some((m) => String(m.entity_id) === authorId);
        const out = [];
        for (const c of circle) {
            if (c.id === authorId) continue;
            const r = known.get(c.id);
            const sameHome = authorAtHome && c.household;
            if (!r && !sameHome) continue;
            const values = r ? Object.keys(r.stats).map((k) => r.stats[k]) : [];
            out.push({ id: c.id, closeness: sameHome ? 100 : (values.length ? Math.max.apply(null, values) : 0) });
        }
        return out;
    }

    async planReactions(task) {
        const post = this.post(task.postId);
        if (!post) return;
        const c = this.cfg;
        const already = new Set(post.likes.map((l) => str(l.id)).concat(post.comments.map((x) => x.authorId)));
        const queued = new Set(this.state.queue.filter((q) => q.postId === post.id).map((q) => q.authorId));
        const reactors = (await this.reactorsFor(post, task.viewerId))
            .filter((r) => r.id !== String(task.viewerId) && r.id !== post.authorId && !already.has(r.id) && !queued.has(r.id))
            .sort((a, b) => b.closeness - a.closeness)
            .slice(0, c.max_reactors);
        if (!reactors.length) return;
        const profiles = await Promise.all(reactors.map((r) => this.world.profile(r.id)));
        const author = await this.world.profile(post.authorId);
        const hh = await this.world.household();
        const candidates = [];
        for (let i = 0; i < profiles.length; i++) {
            const p = profiles[i];
            if (NO_PHONE[p.ageGroup]) continue;
            const rel = (await this.world.relations(p.id)).find((x) => x.id === post.authorId) || null;
            candidates.push({ profile: p, relation: rel, kin: kinWord(hh, p.id, p.gender, author.id, author.gender) });
        }
        if (!candidates.length) return;
        const env = await this.d.game.soft('environment_get_state', {});
        const room = Math.max(0, c.max_comments_per_post - post.comments.filter((x) => x.authorId !== String(task.viewerId)).length);
        const prompt = prompts.reactionPrompt({ post, author, candidates, env, maxComments: room, nameOf: (id, n) => this.nameOf(id, n) });
        this.log.debug('moments reaction prompt:\n' + prompt.system + '\n' + prompt.user);
        const result = await this.d.llm.json(prompt.system, prompt.user, { purpose: 'moments_reaction', voice: ['comments.*.text'] });
        const allowed = new Map(candidates.map((x) => [x.profile.id, x.profile]));
        const [lo, hi] = c.reaction_delay_minutes;
        const now = Date.now();
        const likes = new Set();
        for (const id of Array.isArray(result.likes) ? result.likes : []) if (allowed.has(str(id))) likes.add(str(id));
        let comments = 0;
        for (const item of Array.isArray(result.comments) ? result.comments : []) {
            if (!item || comments >= room) continue;
            const id = str(item.id);
            const text = sanitizeText(emoji.normalize(item.text || ''), COMMENT_MAX);
            if (!allowed.has(id) || !text) continue;
            comments += 1;
            likes.add(id);
            const due = now + rand(lo, hi) * 60000 + 30000;
            this.state.queue.push({ id: newId('q'), due, kind: 'comment', postId: post.id, authorId: id, authorName: allowed.get(id).name, text });
        }
        for (const id of likes) {
            this.state.queue.push({ id: newId('q'), due: now + rand(lo, hi) * 60000, kind: 'like', postId: post.id, authorId: id, authorName: allowed.get(id).name });
        }
        this.saveState();
        this.log.info('moments: reactions planned for ' + post.id + ': ' + likes.size + ' like(s), ' + comments + ' comment(s)');
    }

    // ------------------------------------------------------------- replies to the player
    async replyToPlayer(task) {
        const post = this.post(task.postId);
        if (!post) return;
        const idx = post.comments.findIndex((x) => x.id === task.commentId);
        if (idx < 0) return;
        const comment = post.comments[idx];
        const responderId = str(task.responderId);
        if (post.comments.some((x) => x.authorId === responderId && x.replyTo && x.replyTo.commentId === comment.id)) return;
        const responder = await this.world.profile(responderId);
        if (NO_PHONE[responder.ageGroup]) return;
        const viewer = { id: str(task.viewerId), name: this.nameOf(task.viewerId, comment.authorName) };
        const relation = (await this.world.relations(responderId)).find((x) => x.id === viewer.id) || null;
        const viewerInfo = await this.world.characterInfo(viewer.id);
        const kin = kinWord(await this.world.household(), responderId, responder.gender, viewer.id, viewerInfo && viewerInfo.gender);
        const target = comment.replyTo && comment.replyTo.commentId ? post.comments.find((x) => x.id === comment.replyTo.commentId) || null : null;
        const env = await this.d.game.soft('environment_get_state', {});
        const extra = this.d.personas.extraFor(responderId, this.d.cfg.persona && this.d.cfg.persona.extra ? this.d.cfg.persona.extra[responderId] : '');
        const prompt = prompts.replyPrompt({
            responder, viewer, relation, kin, post, before: post.comments.slice(0, idx), comment, target, env, extra,
            nameOf: (id, n) => this.nameOf(id, n)
        });
        this.log.debug('moments reply prompt:\n' + prompt.system + '\n' + prompt.user);
        const result = await this.d.llm.json(prompt.system, prompt.user, { purpose: 'moments_reply', voice: ['text'] });
        const text = sanitizeText(emoji.normalize((result && result.text) || ''), COMMENT_MAX);
        if (!text) {
            this.log.info('moments: ' + responder.name + ' left the comment of ' + viewer.name + ' unanswered');
            return;
        }
        const [lo, hi] = this.cfg.reply_delay_seconds;
        this.state.queue.push({
            id: newId('q'), due: Date.now() + rand(lo, hi) * 1000, kind: 'comment', postId: post.id,
            authorId: responderId, authorName: responder.name, text,
            replyTo: { id: viewer.id, name: viewer.name, commentId: comment.id }
        });
        this.saveState();
        this.log.info('moments: ' + responder.name + ' will answer ' + viewer.name + ': ' + JSON.stringify(text));
    }

    // ------------------------------------------------------------- tasks
    addTask(task) {
        if (this.state.tasks.length >= TASKS_KEEP) {
            this.log.warn('moments: too many pending tasks, dropping ' + task.type + ' for ' + task.postId);
            return;
        }
        this.state.tasks.push(Object.assign({ id: newId('t'), tries: 0, notBefore: 0 }, task));
    }

    async runTasks() {
        if (this.planning || !this.state.tasks.length || !this.aiAllowed()) return;
        const now = Date.now();
        const task = this.state.tasks.find((t) => t.notBefore <= now);
        if (!task) return;
        this.planning = true;
        try {
            if (task.type === 'reactions') await this.planReactions(task);
            else if (task.type === 'reply') await this.replyToPlayer(task);
            this.state.tasks = this.state.tasks.filter((t) => t.id !== task.id);
        } catch (e) {
            task.tries += 1;
            const retry = (e instanceof GameOfflineError || (e instanceof LlmError && !e.permanent)) && task.tries < TASK_TRIES;
            if (retry) {
                task.notBefore = Date.now() + 30000 * task.tries;
                this.log.warn('moments: ' + task.type + ' for ' + task.postId + ' failed (' + e.message + '), retry ' + task.tries);
            } else {
                this.state.tasks = this.state.tasks.filter((t) => t.id !== task.id);
                this.log.error('moments: ' + task.type + ' for ' + task.postId + ' given up: ' + (e && e.stack || e));
            }
        } finally {
            this.planning = false;
            this.saveState();
        }
    }

    // ------------------------------------------------------------- scheduled likes / comments
    deliverDue() {
        const now = Date.now();
        const due = this.state.queue.filter((q) => q.due <= now).sort((a, b) => a.due - b.due);
        if (!due.length) return;
        const done = new Set();
        for (const q of due) {
            done.add(q.id);
            const post = this.post(q.postId);
            if (!post) continue;
            if (q.kind === 'like') {
                if (post.likes.some((l) => str(l.id) === q.authorId)) continue;
                post.likes.push({ id: q.authorId, name: q.authorName, at: now, game: this.d.gameNow() });
            } else if (q.kind === 'comment') {
                const c = { id: newId('c'), authorId: q.authorId, authorName: q.authorName, text: q.text, at: now, game: this.d.gameNow() };
                if (q.replyTo) c.replyTo = q.replyTo;
                post.comments.push(c);
                this.log.info('moments: ' + q.authorName + ' commented on ' + post.id + ': ' + JSON.stringify(q.text));
            }
            this.dirty = true;
        }
        this.state.queue = this.state.queue.filter((q) => !done.has(q.id));
        this.trim();
        this.commit();
        this.saveState();
    }

    // ------------------------------------------------------------- player actions
    ingest() {
        let changed = false;
        for (const viewerId of this.store.viewers()) {
            const list = this.store.readOutbox(viewerId);
            if (!list || !list.length) continue;
            const applied = Array.isArray(this.feed.applied[viewerId]) ? this.feed.applied[viewerId] : [];
            const seen = new Set(applied);
            const fresh = list.filter((a) => !seen.has(a.id)).sort((a, b) => a.at - b.at);
            if (!fresh.length) continue;
            for (const a of fresh) {
                try {
                    this.apply(viewerId, a);
                } catch (e) {
                    this.log.warn('moments: action ' + a.id + ' (' + a.kind + ') of ' + viewerId + ' ignored: ' + e.message);
                }
                applied.push(a.id);
            }
            this.feed.applied[viewerId] = applied.slice(Math.max(0, applied.length - APPLIED_KEEP));
            this.dirty = true;
            changed = true;
        }
        if (!changed) return;
        this.trim();
        this.commit();
        this.saveState();
    }

    apply(viewerId, a) {
        const name = this.nameOf(viewerId, a.name ? sanitizeText(a.name, 40) : '');
        const at = Math.min(Number(a.at) || Date.now(), Date.now());
        // The phone stamps the game clock when the player acts; an older phone does not.
        const game = gameOf(a.game) || this.d.gameNow();
        if (a.kind === 'post') {
            const text = sanitizeText(a.text, POST_MAX);
            if (!text) throw new Error('empty post');
            const post = {
                id: 'u-' + a.id, authorId: viewerId, authorName: name, authorFirst: sanitizeText(a.first, 20),
                at, gameTime: '', game, place: sanitizeText(a.place, PLACE_MAX), text, source: 'player', likes: [], comments: []
            };
            this.feed.posts.push(post);
            this.feed.posts.sort((x, y) => x.at - y.at);
            if (this.cfg.enabled) this.addTask({ type: 'reactions', postId: post.id, viewerId });
            this.log.info('moments: ' + name + ' posted ' + JSON.stringify(text));
            return;
        }
        const post = this.post(str(a.postId));
        if (!post) throw new Error('post ' + a.postId + ' no longer exists');
        if (a.kind === 'like') {
            if (!post.likes.some((l) => str(l.id) === viewerId)) post.likes.push({ id: viewerId, name, at, game });
        } else if (a.kind === 'unlike') {
            post.likes = post.likes.filter((l) => str(l.id) !== viewerId);
        } else if (a.kind === 'delete') {
            if (post.authorId !== viewerId) throw new Error('only the author can delete a post');
            this.feed.posts = this.feed.posts.filter((p) => p.id !== post.id);
            this.state.queue = this.state.queue.filter((q) => q.postId !== post.id);
            this.state.tasks = this.state.tasks.filter((t) => t.postId !== post.id);
            this.log.info('moments: ' + name + ' deleted ' + post.id);
        } else if (a.kind === 'comment') {
            const text = sanitizeText(a.text, COMMENT_MAX);
            if (!text) throw new Error('empty comment');
            const comment = { id: 'u-' + a.id, authorId: viewerId, authorName: name, text, at, game };
            const target = a.replyToCommentId ? post.comments.find((x) => x.id === str(a.replyToCommentId)) : null;
            if (target && target.authorId !== viewerId) comment.replyTo = { id: target.authorId, name: target.authorName, commentId: target.id };
            post.comments.push(comment);
            this.log.info('moments: ' + name + ' commented on ' + post.id + ': ' + JSON.stringify(text));
            const responderId = comment.replyTo ? comment.replyTo.id : (post.authorId !== viewerId ? post.authorId : null);
            if (responderId && this.cfg.enabled && this.cfg.reply_to_player) {
                this.addTask({ type: 'reply', postId: post.id, commentId: comment.id, responderId, viewerId });
            }
        } else {
            throw new Error('unknown action');
        }
    }

    // ------------------------------------------------------------- loop
    async tick() {
        this.ingest();
        this.deliverDue();
        await this.runTasks();
    }

    summary() {
        return {
            posts: this.feed ? this.feed.posts.length : 0,
            queued: this.state ? this.state.queue.length : 0,
            tasks: this.state ? this.state.tasks.length : 0,
            nextPostAt: this.state ? this.state.nextPostAt : 0
        };
    }
}

module.exports = { Moments, MomentsStore, cleanFeed };
