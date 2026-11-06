'use strict';
// The class chat: one group per played schoolchild in middle or high school (the game's LowTeen
// and HighTeen), made and kept by this service, never the phone, and much livelier than the
// company group (workgroup.js), whose members never talk on their own.
//
// Members: the played character and their classmates, the people in their game phone contacts at
// the same stage (contacts_get_all), not family, not blocked; at the player's school first, at
// most MAX_CLASSMATES. The first of them is the class monitor (班长) and owns the group. Nobody
// leaves it while in that stage; growing up out of it closes the group (sync, every minute).
//   <phone>/groups/g-cls<player>/meta.cfg  this service: { v, id, name, owner, members, auto: true,
//                                          kind: 'class', school: true, pace } — the phone shows it locked
//   <phone>/groups/school.cfg              this service: { v, groups: [{ id, name, owner, members }] },
//                                          which the phone merges into its own list
// Messages go the usual group way (groups.js), at the group's own pace (PACE), and with no-one
// asking, a classmate opens a new topic now and then (topic()), picked by the time of the game day.
//   data/classgroups.json  this service: { v, byPlayer: { <player id>: { stage, name, owner, members, names, closed } } }
const path = require('path');
const fsx = require('./fsx');

const V = 1;
const STAGES = { LowTeen: '初', HighTeen: '高' };
const MAX_CLASSMATES = 7;
const MIN_CLASSMATES = 2;
const SYNC_MS = 60000;

const DEFAULTS = {
    enabled: true,
    // Real minutes of quiet before a classmate opens a new topic, drawn between the two.
    topic_min_minutes: 3,
    topic_max_minutes: 8,
    // Game hours nobody starts anything (lines already on their way still come).
    quiet_game_hours: [1, 6]
};

// How lively the class chat is, against groups.js's defaults for a family group (24 lines an
// hour, 6 of them unasked, a third of the player's lines met with silence, 25-90 s between lines
// nobody asked for, a thread over after 20 quiet minutes).
const PACE = {
    max_per_hour: 60,
    max_auto_per_hour: 30,
    // A new topic gets a lively start of this many lines; the rest of the hour's come back about
    // one every two minutes (groups.js autoAllowance), so the chat never goes quiet for long.
    auto_burst: 6,
    max_replies_per_turn: 3,
    silence_chance: 0.08,
    second_reply_chance: 0.6,
    min_gap_ms: 2000,
    max_gap_ms: 8000,
    auto_gap_min_ms: 8000,
    auto_gap_max_ms: 35000,
    auto_chance: 0.65,
    auto_chance_stale: 0.3,
    topic_idle_minutes: 15,
    quiet_game_hours: [1, 6]
};

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function fullName(m) {
    if (!m) return '';
    return ((m.last_name || '') + (m.first_name || '')) || m.name || '';
}

// The class's name: grade by stage, the class number fixed by who the player is.
function className(player) {
    const stage = STAGES[player && player.age_group];
    if (!stage) return '';
    const n = (Number(String(player.entity_id).replace(/\D/g, '').slice(-4)) || 0) % 9 + 1;
    return stage + '二(' + n + ')班';
}

// The player's classmates among the phone contacts, best first.
function classmates(player, contacts) {
    if (!player || !STAGES[player.age_group]) return [];
    const pid = String(player.entity_id);
    const site = String(player.current_site || '');
    const list = (contacts || []).filter((c) => {
        if (!c || !c.entity_id || String(c.entity_id) === pid) return false;
        if (c.age_group !== player.age_group) return false;
        if (player.household_id !== undefined && String(c.household_id) === String(player.household_id)) return false;
        if (c.blocked || c.is_blocked) return false;
        const label = String(c.relationship_label || '').trim();
        return !label || label === '…';
    });
    const score = (c) => (site && String(c.current_site || '') === site ? 2 : 0) + (/学校|school/i.test(String(c.current_site || '')) ? 1 : 0);
    list.sort((a, b) => score(b) - score(a) || Number(a.entity_id) - Number(b.entity_id));
    return list.slice(0, MAX_CLASSMATES);
}

// What a classmate opens with, by the hour of the game day. name: the played character's given
// name, for the topics that pull them in.
function topicFor(hour, name, rand) {
    const r = typeof rand === 'function' ? rand : Math.random;
    const h = typeof hour === 'number' ? hour : 12;
    let pool;
    if (h >= 6 && h < 8) {
        pool = ['早上快迟到了，在群里喊一声', '作业还没写完，求借一下', '问有没有人顺路带早餐', '吐槽今天早上又起不来'];
    } else if (h >= 8 && h < 16) {
        pool = ['课间吐槽刚才那节课的老师', '问下节课是不是要换教室、要不要带什么', '说食堂今天的菜', '谁有充电宝或者纸巾', '偷偷说刚才课上发生的好笑的事'];
    } else if (h >= 16 && h < 19) {
        pool = ['放学了，约人去奶茶店、篮球场或者网吧', '吐槽补习班好累', '问有没有人一起回家', '说今天的值日谁还没做'];
    } else {
        pool = ['对一下今天的作业答案', '问明天是不是要考试、考什么范围', '聊昨晚追的剧或者在玩的游戏', '说一个班里的小八卦（只说群里的人，不编没见过的人）', '发一个最近很火的梗', '突然想起今天的一件糗事'];
    }
    if (name) pool.push('问问' + name + '一件事（作业、放学去哪、刚才在干嘛），@' + name);
    return pool[Math.floor(r() * pool.length) % pool.length];
}

class ClassGroup {
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.groupsDir = '';
        this.stateFile = '';
        this.state = { v: V, byPlayer: {} };
        this.syncedAt = new Map();
        this.nextTopic = new Map();
        this.busy = false;
    }

    get opts() {
        return Object.assign({}, DEFAULTS, isObject(this.d.cfg && this.d.cfg.class_group) ? this.d.cfg.class_group : {});
    }

    configure(phoneDir, dataDir) {
        this.groupsDir = path.join(phoneDir, 'groups');
        this.stateFile = path.join(dataDir, 'classgroups.json');
        this.forceFile = path.join(dataDir, 'class-topic.request');
        const r = fsx.readJson(this.stateFile);
        const v = r.ok && isObject(r.value) && r.value.v === V ? r.value : {};
        this.state = { v: V, byPlayer: isObject(v.byPlayer) ? v.byPlayer : {} };
        this.syncedAt.clear();
    }

    save() {
        try {
            fsx.writeJson(this.stateFile, this.state, true);
        } catch (e) {
            this.log.warn('classgroup: not saved: ' + e.message);
        }
    }

    groupId(playerId) {
        return 'cls' + String(playerId);
    }

    // Every few seconds, from the daemon.
    async tick() {
        const o = this.opts;
        if (!o.enabled || this.busy || !this.stateFile) return;
        this.busy = true;
        try {
            await this.step(o);
        } catch (e) {
            this.log.warn('classgroup: ' + (e && e.stack || e));
        } finally {
            this.busy = false;
        }
    }

    async step(o) {
        const world = this.d.world;
        if (await world.phase() !== 'in_game') return;
        const playerId = String(await world.possessed() || '');
        if (!playerId) return;
        // `node bridge.js class-topic`: a topic at once, for trying the chat out.
        if (fsx.readJson(this.forceFile).ok) {
            try { require('fs').unlinkSync(this.forceFile); } catch (e) { /* gone already */ }
            const ok = await this.kick();
            this.log.info('classgroup: topic forced (test)' + (ok ? '' : ', but there is no class chat to start one in'));
            return;
        }
        const now = Date.now();
        if (now - (this.syncedAt.get(playerId) || 0) >= SYNC_MS) {
            this.syncedAt.set(playerId, now);
            await this.sync(playerId);
        }
        const g = this.state.byPlayer[playerId];
        if (!g || g.closed) return;
        const env = await this.d.game.soft('environment_get_state', {});
        await this.topic(playerId, g, env, o);
    }

    // Makes, updates or closes the played character's class group.
    async sync(playerId) {
        const hh = await this.d.world.household();
        const player = (hh.members || []).find((m) => String(m.entity_id) === String(playerId));
        if (!player) return null;
        const before = this.state.byPlayer[playerId];
        if (!STAGES[player.age_group]) {
            // Grown out of school: the class chat closes.
            if (before && !before.closed) {
                before.closed = true;
                this.writeGroup(playerId, before);
                this.save();
                this.log.info('classgroup: ' + playerId + ' left school, ' + before.name + ' closed');
            }
            return null;
        }
        const found = classmates(player, await this.d.world.phoneContacts());
        if (found.length < MIN_CLASSMATES) return null;
        // Who was in the class stays in its place (and the monitor stays monitor) while still a
        // classmate: where everyone happens to be standing must not reshuffle the class.
        const kept = before && !before.closed && before.stage === player.age_group ? before.members.filter((id) => id !== String(playerId)) : [];
        const byId = new Map(found.map((m) => [String(m.entity_id), m]));
        const mates = kept.filter((id) => byId.has(id)).map((id) => byId.get(id))
            .concat(found.filter((m) => kept.indexOf(String(m.entity_id)) < 0)).slice(0, MAX_CLASSMATES);
        const owner = before && byId.has(String(before.owner)) && before.stage === player.age_group ? String(before.owner) : String(mates[0].entity_id);
        const names = { [String(playerId)]: fullName(player) };
        for (const m of mates) names[String(m.entity_id)] = fullName(m);
        // A new stage is a new class: middle school's chat gives way to high school's.
        const name = before && before.stage === player.age_group && before.name ? before.name : className(player);
        const g = {
            stage: player.age_group,
            name,
            owner,
            members: [String(playerId)].concat(mates.map((m) => String(m.entity_id))),
            names,
            first: player.first_name || '',
            closed: false
        };
        if (!before || before.closed || before.name !== g.name || before.owner !== g.owner || before.members.join(',') !== g.members.join(',') ||
            g.members.some((id) => (before.names || {})[id] !== names[id])) {
            this.state.byPlayer[playerId] = g;
            this.writeGroup(playerId, g);
            this.save();
            this.dropLeavers(playerId, g);
            this.log.info('classgroup: ' + g.name + ' has ' + g.members.length + ' member(s), monitor ' + g.owner);
        }
        return g;
    }

    // Lines still queued for classmates who are no longer in the class are never said.
    dropLeavers(playerId, g) {
        const groups = this.d.chatGroups;
        if (!groups || typeof groups.state !== 'function') return;
        const id = this.groupId(playerId);
        const st = groups.state(id);
        const kept = (st.queue || []).filter((q) => q && g.members.indexOf(String(q.from)) >= 0);
        if (kept.length === (st.queue || []).length) return;
        st.queue = kept;
        groups.saveState(id, st);
        this.log.info('classgroup [' + id + '] dropped lines of classmates who left');
    }

    writeGroup(playerId, g) {
        const id = this.groupId(playerId);
        try {
            fsx.ensureDir(path.join(this.groupsDir, 'g-' + id));
            fsx.writeJson(path.join(this.groupsDir, 'g-' + id, 'meta.cfg'), {
                v: 1, id, name: g.name, owner: g.owner,
                members: g.members.map((m) => ({ id: m, name: (g.names || {})[m] || '' })),
                auto: true, kind: 'class', school: true, player: String(playerId), pace: PACE, closed: !!g.closed
            });
            const list = Object.keys(this.state.byPlayer).filter((p) => !this.state.byPlayer[p].closed).map((p) => {
                const x = this.state.byPlayer[p];
                return { id: this.groupId(p), name: x.name, owner: x.owner, members: x.members };
            });
            fsx.writeJson(path.join(this.groupsDir, 'school.cfg'), { v: 1, groups: list });
        } catch (e) {
            this.log.warn('classgroup: group ' + id + ' not written: ' + e.message);
        }
        if (this.d.chatGroups && this.d.chatGroups.metaCache) this.d.chatGroups.metaCache.delete(id);
    }

    // With the chat quiet for a while, a classmate opens a new topic.
    async topic(playerId, g, env, o, force) {
        const groups = this.d.chatGroups;
        if (!groups || !groups.enabled) return false;
        if (!this.d.llm || !this.d.llm.configured || this.d.cfg.mode !== 'auto') return false;
        if (this.d.clearRequestAt && this.d.clearRequestAt()) return false;
        const id = this.groupId(playerId);
        const st = groups.state(id);
        if ((st.queue || []).length) return false;
        const hour = env && typeof env.hour === 'number' ? env.hour : null;
        const q = o.quiet_game_hours;
        if (!force && hour !== null && Array.isArray(q) && hour >= q[0] && hour < q[1]) return false;
        const now = Date.now();
        const last = Math.max(Number(st.lastAt) || 0, Number(st.lastPlayerAt) || 0);
        if (!this.nextTopic.has(id)) {
            const span = Math.max(0, o.topic_max_minutes - o.topic_min_minutes);
            this.nextTopic.set(id, (o.topic_min_minutes + Math.random() * span) * 60000);
        }
        if (!force && last && now - last < this.nextTopic.get(id)) return false;
        const speakers = g.members.filter((m) => m !== String(playerId));
        if (!speakers.length) return false;
        const recent = (st.recent || []).slice(-2).map((r) => String(r.from));
        const fresh = speakers.filter((m) => recent.indexOf(m) < 0);
        const pool = fresh.length ? fresh : speakers;
        const from = pool[Math.floor(Math.random() * pool.length)];
        const text = topicFor(hour, g.first || '');
        this.nextTopic.delete(id);
        st.queue = (st.queue || []).concat([{ at: now + 1500, from, why: '开个新话题', quote: '', replyTo: '', mentions: [], kind: 'auto', author: String(playerId), topic: text }]).slice(-8);
        // Held now, so the chat's own carrying-on waits for this line.
        st.lastAt = now;
        groups.saveState(id, st);
        this.log.info('classgroup [' + id + '] topic from ' + from + ': ' + text);
        return true;
    }

    // Test only (`node bridge.js class-topic`): a new topic at once.
    async kick() {
        const playerId = String(await this.d.world.possessed() || '');
        if (!playerId) return false;
        this.syncedAt.delete(playerId);
        await this.sync(playerId);
        const g = this.state.byPlayer[playerId];
        if (!g || g.closed) return false;
        const env = await this.d.game.soft('environment_get_state', {});
        return this.topic(playerId, g, env, this.opts, true);
    }
}

module.exports = { ClassGroup, classmates, className, topicFor, PACE, DEFAULTS };
