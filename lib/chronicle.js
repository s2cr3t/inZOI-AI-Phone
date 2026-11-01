'use strict';
// 大事记: what happened in the household, taken from the game itself rather than from the
// texts. Big moments between family members come from the HouseholdJournal mod (a kiss, a
// quarrel, praise, a contest); changes in a person come from comparing the game's data with
// what it said a minute ago (a new job, a promotion, growing up, a skill level, a strong
// feeling, someone moving in or out); and things the bridge itself got done (a meal served to
// someone, going out together). One book per household, in the third person, so every member
// can be reminded of what they took part in and of the family news everyone would know.
const path = require('path');
const fsx = require('./fsx');
const { fullName } = require('./world');

const KEEP = 400;
const SAVE_DELAY_MS = 1500;
const WATCH_SKILLS_MS = 5 * 60000;
const ENV_TTL_MS = 20000;
// A member missing from this many reads in a row has really left; one read can come back short.
const GONE_AFTER = 3;
const EVENTS_DAYS = 3;
const EVENTS_MAX = 6;

// Ordered: the first rule that matches the game's name of the interaction decides.
const SOCIAL_RULES = [
    { kind: 'milestone', w: 3, re: /求婚|结婚|婚礼|表白|告白|生日|庆祝|祝贺|毕业|纪念日|订婚/ },
    { kind: 'conflict', w: 3, re: /吵架|争吵|吵|骂|争执|批评|训斥|教训|责备|责怪|抱怨|嘲笑|嘲讽|讽刺|侮辱|指责|打架|推搡|发火|冷战|顶嘴|威胁|挖苦|数落|伤人的话|要求[^，。]{0,8}道歉/ },
    { kind: 'makeup', w: 2, re: /道歉|和好|原谅|认错|安慰|赔不是/ },
    { kind: 'affection', w: 2, re: /爱意|爱的力量|情书|热吻|亲吻|亲脸|亲一|吻|拥抱|抱抱|抱起|搂|牵手|骑在肩|喜悦|知己|好朋友|想念|依偎|撒娇/ },
    { kind: 'praise', w: 2, re: /夸|称赞|赞美|表扬|鼓励|打气|谢意|感谢|值得学习|佩服/ },
    { kind: 'deep', w: 1, re: /梦想|目标|未来|烦恼|秘密|心事|谈论家庭|爱情|人生|友情|担心|倾诉|绝望/ }
];
// The game's bag for an attempt the other person turned down ("Co_Peck_Fail").
const REJECTED_RE = /_Fail(_|$)/i;
// Things done together that are play, not chores.
const PLAY_RE = /下棋|象棋|围棋|足球|篮球|排球|网球|游戏|跳舞|唱歌|弹|演奏|捉迷藏|玩|运动|锻炼|跑步|看电影|拍照/;
const CHORE_RE = /洗|打扫|清洁|清理|做饭|烹饪|前往|搬|修理|整理|倒垃圾|晾|收拾/;
// Something one person signed up for or went through, even alone. The word it is about makes
// one entry of the several bags of one exam ("专心考试", "参加考试", "开始考试").
const SOLO_RE = /(报名|参加|举办|开始|专心|去)[^，。]{0,6}?(比赛|竞赛|考试|演出|表演|面试|派对|选拔|演讲)|(考试|面试)/;
const FEEDBACK_RE = /_FeedBack$/i;
// Feelings people are in most of an ordinary day even at their top level (欢快, 沉浸, 不快):
// not a moment anyone remembers. By the game's ids, which do not change with the language.
const EVERYDAY_EMOTIONS = new Set(['Normal', 'Sleep', 'Calm', 'Preoccupied', 'Uncomfortable']);
// What a strong feeling came during that makes it nothing to tell: the toilet, bed, a meal.
const EVERYDAY_DOING_RE = /睡|马桶|厕所|如厕|洗澡|淋浴|泡澡|刷牙|洗脸|洗手|吃|喝|打扫|清理|清洁/;
// Books written before this version recorded every skill level and every peak feeling.
const BOOK_V = 2;

function hhKey(id) {
    return String(id || '').replace(/[^0-9A-Za-z_-]/g, '') || 'default';
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function timeOf(env) {
    return env && typeof env.hour === 'number' ? pad2(env.hour) + ':' + pad2(env.minute || 0) : '';
}

// The game's name of an interaction between two people, sorted into what kind of moment it was.
function classifySocial(bag, name, coop) {
    if (!name || FEEDBACK_RE.test(bag)) return null;
    for (const r of SOCIAL_RULES) if (r.re.test(name)) return { kind: r.kind, w: r.w };
    if (coop && PLAY_RE.test(name) && !CHORE_RE.test(name)) return { kind: 'play', w: 1 };
    return null;
}

function classifySolo(bag, name) {
    if (!name || FEEDBACK_RE.test(bag)) return null;
    const m = SOLO_RE.exec(name);
    if (!m) return null;
    return { kind: 'solo', w: 2, about: m[2] || m[3] };
}

// A skill level worth telling: halfway (5 of 10, 3 of 5) and the top.
function skillMilestone(level, max) {
    if (typeof max !== 'number' || max <= 0) return level >= 5;
    return level >= max || level === Math.ceil(max / 2);
}

// The person a feeling came with, from the text it was written in: "（当时在「谈心」宗会荣）".
function feelingWith(text) {
    const m = /（当时在「[^」]*」([^）]*)）$/.exec(String(text || ''));
    return m ? m[1] : '';
}

function feelingDoing(text) {
    const m = /（当时在「([^」]*)」/.exec(String(text || ''));
    return m ? m[1] : '';
}

// The rules of BOOK_V applied to what an older book wrote down.
function keepOld(e, names) {
    if (e.kind === 'outing') return false;
    if (e.kind === 'skill') {
        if (/满级/.test(e.text)) return true;
        const level = Number(String(e.key || '').split('|')[3]);
        return level === 5;
    }
    if (e.kind === 'feeling') {
        const with_ = feelingWith(e.text);
        const self = names.find((n) => n && e.text.indexOf(n) === 0) || '';
        if (with_ && with_ !== self && names.indexOf(with_) >= 0) return true;
        return e.w >= 2 && !EVERYDAY_DOING_RE.test(feelingDoing(e.text));
    }
    return true;
}

function maxLevelOf(row) {
    let max = 0;
    for (const k of Object.keys((row && row.levels) || {})) {
        const n = Number(k);
        if (n > max) max = n;
    }
    return max;
}

class Chronicle {
    constructor(daemon, dataDir) {
        this.d = daemon;
        this.dir = path.join(dataDir, 'chronicle');
        this.backupDir = path.join(dataDir, 'backup', 'chronicle-v' + BOOK_V);
        this.books = new Map();
        this.timers = new Map();
        this.rebaseNext = false;
        this.watching = false;
    }

    get log() { return this.d.log; }

    file(hh) {
        return path.join(this.dir, hhKey(hh) + '.json');
    }

    book(hh) {
        const k = hhKey(hh);
        if (!this.books.has(k)) {
            const r = fsx.readJson(this.file(hh));
            const v = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
            const b = {
                v: BOOK_V,
                profiles: v.profiles && typeof v.profiles === 'object' ? v.profiles : {},
                events: Array.isArray(v.events) ? v.events.filter((e) => e && typeof e.text === 'string' && Array.isArray(e.who)) : [],
                seq: typeof v.seq === 'number' ? v.seq : 0,
                day: typeof v.day === 'number' ? v.day : null
            };
            this.books.set(k, b);
            if (r.ok && (typeof v.v !== 'number' || v.v < BOOK_V)) this.tidyOld(hh, b, r.value);
        }
        return this.books.get(k);
    }

    // An older book is copied aside once, then thinned out to what BOOK_V would have written.
    tidyOld(hh, b, original) {
        const k = hhKey(hh);
        // Two saves can share a household id, so every copy gets its own name.
        const backup = path.join(this.backupDir, k + '-' + Date.now() + '.json');
        try {
            fsx.ensureDir(this.backupDir);
            fsx.writeJson(backup, original, true);
        } catch (e) {
            this.log.warn('chronicle: could not back up ' + k + ' (' + e.message + '), left as it was');
            b.v = original.v || 1;
            return;
        }
        const names = Object.keys(b.profiles).map((id) => b.profiles[id] && b.profiles[id].name).filter(Boolean);
        const seen = new Set();
        const before = b.events.length;
        b.events = b.events.filter((e) => {
            if (!keepOld(e, names)) return false;
            if (e.kind === 'skill' && e.key) {
                if (seen.has(e.key)) return false;
                seen.add(e.key);
            }
            return true;
        });
        this.persist(hh);
        this.log.info('chronicle [' + k + '] tidied: kept ' + b.events.length + ' of ' + before + ' event(s), the old book is in ' + backup);
    }

    persist(hh) {
        const k = hhKey(hh);
        if (this.timers.has(k)) return;
        const t = setTimeout(() => {
            this.timers.delete(k);
            this.writeNow(hh);
        }, SAVE_DELAY_MS);
        if (t.unref) t.unref();
        this.timers.set(k, t);
    }

    writeNow(hh) {
        const b = this.books.get(hhKey(hh));
        if (!b) return;
        try {
            fsx.writeJson(this.file(hh), b, true);
        } catch (e) {
            this.log.warn('chronicle: could not save ' + hhKey(hh) + ': ' + e.message);
        }
    }

    flush() {
        for (const [k, t] of this.timers) {
            clearTimeout(t);
            this.timers.delete(k);
            this.writeNow(k);
        }
    }

    // Another world was loaded: what the game says next is not a change from what it said before.
    rebase() {
        this.rebaseNext = true;
    }

    envNow() {
        return this.d.world.cached('chronicle-env', ENV_TTL_MS, () => this.d.game.soft('environment_get_state', {}));
    }

    // ev: { who: [ids], kind, text, w, key? }. The same moment between the same people on the
    // same game day is counted rather than written again.
    add(hh, ev, env) {
        const b = this.book(hh);
        const day = env && typeof env.day === 'number' ? env.day : null;
        const who = (ev.who || []).map(String).filter(Boolean);
        const key = ev.key || (ev.kind + '|' + who.slice().sort().join(',') + '|' + ev.text);
        const now = Date.now();
        const same = b.events.slice(-60).reverse().find((e) => e.key === key && e.day === day && (day !== null || now - e.at < 6 * 3600000));
        if (same) {
            same.count = (same.count || 1) + 1;
            same.last = now;
            this.persist(hh);
            // Done again the same day still moves how they feel about each other.
            this.feel(same);
            return same;
        }
        b.seq += 1;
        const e = { id: b.seq, at: now, day, time: timeOf(env), who, kind: ev.kind, text: String(ev.text).slice(0, 120), w: ev.w || 1, key };
        b.events.push(e);
        if (b.events.length > KEEP) b.events.splice(0, b.events.length - KEEP);
        this.persist(hh);
        this.log.info('chronicle [' + hhKey(hh) + '] ' + e.text + (e.day !== null ? ' (day ' + e.day + ' ' + e.time + ')' : ''));
        this.feel(e);
        return e;
    }

    // What one member did to another moves how they feel about each other (ties.js).
    feel(e) {
        if (!this.d.ties) return;
        try {
            this.d.ties.onChronicle(e);
        } catch (err) {
            this.log.warn('ties from chronicle: ' + (err && err.message || err));
        }
    }

    // Bridge outcomes, already in words.
    async note(hh, who, kind, text, w) {
        const env = await this.envNow().catch(() => null);
        return this.add(hh, { who, kind, text, w }, env);
    }

    // A finished interaction from the mod's journal.
    async onJournal(ev) {
        if (!ev || ev.kind !== 'finished' || !ev.bag || FEEDBACK_RE.test(ev.bag)) return null;
        const hh = await this.d.world.household();
        const byId = new Map(hh.members.map((m) => [String(m.entity_id), m]));
        const actor = byId.get(String(ev.actor));
        if (!actor) return null;
        const target = ev.target && String(ev.target) !== String(ev.actor) ? byId.get(String(ev.target)) : null;
        const name = await this.d.world.interactionName(ev.bag).catch(() => '');
        if (!name) return null;
        const env = await this.envNow().catch(() => null);
        const a = fullName(actor);
        if (target) {
            const c = classifySocial(ev.bag, name, /^Coop_/i.test(ev.bag));
            if (!c) return null;
            const b = fullName(target);
            if (REJECTED_RE.test(ev.bag)) {
                return this.add(hh.id, {
                    who: [ev.actor, ev.target], kind: 'rejected', text: a + '想对' + b + '「' + name + '」，被拒绝了', w: 2,
                    key: 'rejected|' + ev.actor + '>' + ev.target + '|' + name
                }, env);
            }
            const text = c.kind === 'play' ? a + '和' + b + '一起「' + name + '」' : a + '对' + b + '「' + name + '」';
            return this.add(hh.id, { who: [ev.actor, ev.target], kind: c.kind, text, w: c.w, key: c.kind + '|' + ev.actor + '>' + ev.target + '|' + name }, env);
        }
        if (ev.target) return null;
        const c = classifySolo(ev.bag, name);
        if (!c) return null;
        return this.add(hh.id, { who: [ev.actor], kind: c.kind, text: a + '「' + name + '」', w: c.w, key: 'solo|' + ev.actor + '|' + c.about }, env);
    }

    // Compares what the game says about each member now with what it said last time.
    async watch() {
        if (this.watching) return;
        this.watching = true;
        try {
            await this.watchOnce();
        } finally {
            this.watching = false;
        }
    }

    async watchOnce() {
        const hh = await this.d.world.household();
        if (!hh || !hh.id || !hh.members.length) return;
        const env = await this.envNow().catch(() => null);
        const day = env && typeof env.day === 'number' ? env.day : null;
        const b = this.book(hh.id);
        const rebase = this.rebaseNext;
        this.rebaseNext = false;
        // Time went back: an older save of this household was loaded.
        const back = day !== null && b.day !== null && day < b.day;
        const quiet = rebase || back;
        if (quiet) this.log.info('chronicle [' + hhKey(hh.id) + '] another world was loaded, starting the comparison over');
        const hadMembers = Object.keys(b.profiles).length > 0;
        const table = await this.d.world.emotionTable().catch(() => ({}));
        const now = Date.now();
        const present = new Set();
        let changed = false;
        for (const m of hh.members) {
            const id = String(m.entity_id);
            present.add(id);
            const name = fullName(m);
            const cur = {
                name,
                job: m.job_name || '',
                rank: typeof m.job_rank === 'number' ? m.job_rank : null,
                rankName: m.job_rank_name || '',
                ageGroup: m.age_group || '',
                ageText: m.age_group_text || m.age_group || '',
                married: !!m.is_married
            };
            const old = b.profiles[id];
            if (!old) {
                b.profiles[id] = Object.assign(cur, { skills: {}, skillsAt: 0, emo: {}, missing: 0 });
                changed = true;
                if (hadMembers && !quiet) this.add(hh.id, { who: [id], kind: 'family', text: '家里来了新成员：' + name, w: 3 }, env);
                continue;
            }
            old.missing = 0;
            if (!quiet) this.compare(hh.id, id, old, cur, env);
            Object.assign(old, cur);
            changed = true;
        }
        for (const id of Object.keys(b.profiles)) {
            if (present.has(id)) continue;
            const p = b.profiles[id];
            p.missing = (p.missing || 0) + 1;
            changed = true;
            if (p.missing === GONE_AFTER && !quiet) this.add(hh.id, { who: [id], kind: 'family', text: (p.name || '一位家人') + '离开了这个家', w: 3 }, env);
            if (p.missing >= GONE_AFTER) delete b.profiles[id];
        }
        const people = new Map(hh.members.map((m) => [String(m.entity_id), fullName(m)]));
        for (const m of hh.members) {
            const id = String(m.entity_id);
            const p = b.profiles[id];
            if (!p) continue;
            await this.watchEmotion(hh.id, id, p, table, env, quiet, people);
            if (now - (p.skillsAt || 0) >= WATCH_SKILLS_MS || quiet) await this.watchSkills(hh.id, id, p, env, quiet);
        }
        if (day !== null) b.day = day;
        if (changed) this.persist(hh.id);
    }

    compare(hh, id, old, cur, env) {
        const n = cur.name;
        if (old.job !== cur.job) {
            if (!old.job && cur.job) this.add(hh, { who: [id], kind: 'career', text: n + '找到了工作：' + cur.job + (cur.rankName ? '（' + cur.rankName + '）' : ''), w: 3 }, env);
            else if (old.job && !cur.job) this.add(hh, { who: [id], kind: 'career', text: n + '不再做' + old.job + '了', w: 3 }, env);
            else this.add(hh, { who: [id], kind: 'career', text: n + '换了工作：从' + old.job + '换成了' + cur.job, w: 3 }, env);
        } else if (cur.job && old.rank !== null && cur.rank !== null && old.rank !== cur.rank) {
            const up = cur.rank > old.rank;
            this.add(hh, {
                who: [id], kind: 'career',
                text: n + (up ? '升职了' : '职位降了') + '，现在是' + cur.job + (cur.rankName ? '的' + cur.rankName : '第 ' + cur.rank + ' 级'),
                w: up ? 3 : 2
            }, env);
        }
        if (old.ageGroup && cur.ageGroup && old.ageGroup !== cur.ageGroup) {
            this.add(hh, { who: [id], kind: 'growth', text: n + '长大了：从' + (old.ageText || old.ageGroup) + '变成了' + (cur.ageText || cur.ageGroup), w: 3 }, env);
        }
        if (!old.married && cur.married) this.add(hh, { who: [id], kind: 'milestone', text: n + '结婚了', w: 3 }, env);
        else if (old.married && !cur.married) this.add(hh, { who: [id], kind: 'milestone', text: n + '的婚姻结束了', w: 3 }, env);
    }

    // The strongest level of a feeling that is not neutral, once per kind of feeling per game day.
    async watchEmotion(hh, id, p, table, env, quiet, people) {
        const emo = await this.d.game.soft('emotion_get_current', { entity_id: id });
        if (!emo || !emo.emotion_type || EVERYDAY_EMOTIONS.has(emo.emotion_type)) return;
        const row = table[emo.emotion_type];
        if (!row || row.tendency === 'neutral' || !row.tendency) return;
        const max = maxLevelOf(row);
        if (max < 2 || emo.level < max) return;
        const day = env && typeof env.day === 'number' ? env.day : null;
        if (!p.emo || typeof p.emo !== 'object') p.emo = {};
        if (p.emo[emo.emotion_type] === day && day !== null) return;
        p.emo[emo.emotion_type] = day;
        if (quiet) return;
        const feel = row.levels[emo.level] || emo.emotion_type;
        const negative = row.tendency === 'negative';
        let doing = '';
        let withFamily = false;
        let everyday = false;
        const cur = await this.d.game.soft('interaction_get_current', { entity_id: id });
        if (cur && cur.playing && cur.interaction_bag_id) {
            const a = this.d.world.activityOf(cur);
            await this.d.world.nameActivity(a, people).catch(() => {});
            withFamily = !!(a.target && a.target !== id && people && people.has(a.target));
            everyday = EVERYDAY_DOING_RE.test(a.name || '');
            if (a.name) doing = '（当时在「' + a.name + '」' + (a.targetName ? a.targetName : '') + '）';
        }
        // A high on the toilet or while working alone is how the game scores a day, not a memory.
        if (!withFamily && !(negative && !everyday)) return;
        this.add(hh, { who: [id], kind: 'feeling', text: p.name + '感到非常「' + feel + '」' + doing, w: negative ? 2 : 1, key: 'feeling|' + id + '|' + emo.emotion_type }, env);
    }

    async watchSkills(hh, id, p, env, quiet) {
        const r = await this.d.game.soft('skill_get_all', { entity_id: id });
        p.skillsAt = Date.now();
        if (!r || !Array.isArray(r.skills)) return;
        if (!p.skills || typeof p.skills !== 'object') p.skills = {};
        const first = !Object.keys(p.skills).length;
        for (const s of r.skills) {
            if (!s || !s.id || typeof s.level !== 'number') continue;
            const before = p.skills[s.id];
            p.skills[s.id] = s.level;
            if (first || quiet || typeof before !== 'number' || s.level <= before) continue;
            if (!skillMilestone(s.level, s.max_level)) continue;
            const label = s.l10n || s.id;
            const maxed = typeof s.max_level === 'number' && s.level >= s.max_level;
            this.add(hh, {
                who: [id], kind: 'skill',
                text: p.name + '的「' + label + '」' + (maxed ? '练到了满级（' + s.level + ' 级）' : '升到了 ' + s.level + ' 级'),
                w: maxed ? 3 : 2,
                key: 'skill|' + id + '|' + s.id + '|' + s.level
            }, env);
        }
    }

    // Events this world has had so far: a save loaded from before them did not have them yet.
    visible(hh, env) {
        const day = env && typeof env.day === 'number' ? env.day : null;
        return this.book(hh).events.filter((e) => day === null || e.day === null || e.day <= day);
    }

    // What a member took part in, plus the big family news.
    forPerson(hh, id, env) {
        const me = String(id);
        return this.visible(hh, env).filter((e) => e.who.indexOf(me) >= 0 || e.w >= 3);
    }

    // The latest big things, for the prompt every time: the last few game days, the bigger and
    // newer first, the person's own before the rest.
    recentFor(hh, id, env) {
        const day = env && typeof env.day === 'number' ? env.day : null;
        const me = String(id);
        const list = this.forPerson(hh, id, env).filter((e) => {
            if (day !== null && e.day !== null) return day - e.day < EVENTS_DAYS;
            return Date.now() - e.at < EVENTS_DAYS * 86400000;
        });
        const score = (e) => e.w * 10 + (e.who.indexOf(me) >= 0 ? 5 : 0) + (e.day !== null && day !== null ? -(day - e.day) * 3 : 0);
        return list.slice().sort((a, b) => score(b) - score(a) || b.at - a.at).slice(0, EVENTS_MAX)
            .sort((a, b) => a.at - b.at);
    }
}

module.exports = { Chronicle, classifySocial, classifySolo, SOCIAL_RULES, keepOld, skillMilestone };
