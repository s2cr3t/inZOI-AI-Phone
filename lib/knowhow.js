'use strict';
// What a character knows how to do, kept for good in data/knowhow/<character>.json.
//
// A skill is one way of doing one job: "把食物放进冰箱冷藏 = 冷藏 (Food_Fridge_Keeping) on a food".
// It is shown to the model whenever that character plans, under a short id (K1, K2 ...) that an
// action can name, so a known job is replayed straight away instead of being worked out again.
//
// Where skills come from:
//   taught   the player explained how. Kept at once, before it has been tried, so a lesson the
//            character could not act on yet is still there the next time the job comes up.
//   learned  a taught way that was then carried out to the end.
//   self     a job the player asked for that the character worked out alone and finished. It
//            never overrides what the player taught.
// The same game action under other words ("开电视", "打开电视让节目播出来") is one skill with
// several names. A way that keeps failing is marked doubtful so the character asks first.
// A way the player calls out as wrong is retired: it is no longer a skill, and the wrong pairing
// (job + game action) is kept so the character neither replays it nor finds it out again alone.
const path = require('path');
const fsx = require('./fsx');

const VERSION = 2;
const KEEP = 60;
const KEEP_SELF = 20;
const KEEP_TAUGHT = 12;
const TAUGHT_KEEP_MS = 30 * 24 * 3600 * 1000;
const ALIASES_MAX = 6;
const OBJECTS_MAX = 6;
const DOUBT_STREAK = 2;
const TASK_MAX = 40;
const HOW_MAX = 120;
const REASON_MAX = 120;
const WRONG_KEEP = 20;

function text(v, max) {
    return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// A job as a name: no closing punctuation ("玩电视游戏。" is "玩电视游戏").
function taskText(v) {
    return text(v, TASK_MAX).replace(/[\s，。、！？!?,.;；:：~～…]+$/, '');
}

// Comparable form of a task: no spaces or punctuation, so "把食物 收起来。" and "把食物收起来" meet.
function taskKey(s) {
    return String(s || '').replace(/[\s，。、！？!?,.;；:："“”'‘’（）()【】\[\]…~～-]+/g, '').toLowerCase();
}

function addUnique(list, value, max) {
    const v = taskText(value);
    if (!v) return list;
    const k = taskKey(v);
    if (list.some((x) => taskKey(x) === k)) return list;
    return list.concat([v]).slice(-max);
}

function nameKey(s) { return String(s || '').trim(); }

function newId() {
    return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

// A v1 lesson ({ lesson, task, how, objectName, interactionId, interactionName, teacher, at, done }).
function fromV1(x) {
    return {
        id: newId(),
        lesson: x.lesson || '',
        status: 'learned',
        source: x.teacher ? 'taught' : 'self',
        task: taskText(x.task),
        aliases: [],
        how: text(x.how, HOW_MAX),
        teacher: text(x.teacher, 20),
        interactionId: String(x.interactionId || ''),
        interactionName: text(x.interactionName, 40) || String(x.interactionId || ''),
        objects: x.objectName ? [text(x.objectName, 40)] : [],
        taughtAt: x.at || Date.now(),
        learnedAt: x.at || Date.now(),
        usedAt: x.at || Date.now(),
        done: Math.max(1, Number(x.done) || 1),
        fails: 0,
        failStreak: 0,
        lastFail: null
    };
}

function clean(x) {
    if (!x || typeof x !== 'object') return null;
    const status = x.status === 'taught' ? 'taught' : 'learned';
    const s = {
        id: String(x.id || newId()),
        lesson: String(x.lesson || ''),
        status,
        source: x.source === 'self' ? 'self' : 'taught',
        task: taskText(x.task),
        aliases: Array.isArray(x.aliases) ? x.aliases.map((a) => taskText(a)).filter(Boolean).slice(-ALIASES_MAX) : [],
        how: text(x.how, HOW_MAX),
        teacher: text(x.teacher, 20),
        interactionId: String(x.interactionId || ''),
        interactionName: text(x.interactionName, 40),
        objects: Array.isArray(x.objects) ? x.objects.map((o) => text(o, 40)).filter(Boolean).slice(-OBJECTS_MAX) : [],
        taughtAt: Number(x.taughtAt) || 0,
        learnedAt: Number(x.learnedAt) || 0,
        usedAt: Number(x.usedAt) || 0,
        done: Math.max(0, Number(x.done) || 0),
        fails: Math.max(0, Number(x.fails) || 0),
        failStreak: Math.max(0, Number(x.failStreak) || 0),
        lastFail: x.lastFail && typeof x.lastFail === 'object' ? { at: Number(x.lastFail.at) || 0, why: text(x.lastFail.why, REASON_MAX) } : null
    };
    if (!s.task) return null;
    if (status === 'learned' && !s.interactionId) return null;
    if (!s.interactionName) s.interactionName = s.interactionId;
    return s;
}

// A way the player said was wrong: { task, aliases, interactionId, interactionName, objects, why, by, at }.
function cleanWrong(x) {
    if (!x || typeof x !== 'object') return null;
    const w = {
        task: taskText(x.task),
        aliases: Array.isArray(x.aliases) ? x.aliases.map((a) => taskText(a)).filter(Boolean).slice(-ALIASES_MAX) : [],
        interactionId: String(x.interactionId || ''),
        interactionName: text(x.interactionName, 40),
        objects: Array.isArray(x.objects) ? x.objects.map((o) => text(o, 40)).filter(Boolean).slice(-OBJECTS_MAX) : [],
        why: text(x.why, REASON_MAX),
        by: text(x.by, 20),
        at: Number(x.at) || 0
    };
    if (!w.task || !w.interactionId) return null;
    if (!w.interactionName) w.interactionName = w.interactionId;
    return w;
}

function sameTask(s, task) {
    const k = taskKey(task);
    if (!k) return false;
    if (taskKey(s.task) === k) return true;
    return (s.aliases || []).some((a) => taskKey(a) === k);
}

// Higher is worth keeping: taught before self-found, used often and lately, not failing.
function worth(s, now) {
    const days = Math.max(0, (now - (s.usedAt || s.learnedAt || s.taughtAt || 0)) / 86400000);
    let v = Math.min(s.done, 20) * 3 - days * 0.5 - s.failStreak * 4;
    if (s.status === 'learned') v += 40;
    if (s.source === 'taught') v += 20;
    return v;
}

// A learned skill the bridge can start again by its game action id. Meals are learned under a
// pattern ("Next_Food_（菜的编号）_Eat"), not a real id, and are only shown as advice.
function replayable(s) {
    return !!s && s.status === 'learned' && !!s.interactionId && !/[（(]/.test(s.interactionId);
}

class KnowHow {
    constructor(dataDir, log) {
        this.dir = path.join(dataDir, 'knowhow');
        this.log = log;
        this.cache = new Map();
        this.wrongs = new Map();
    }

    file(id) {
        return path.join(this.dir, String(id).replace(/[^0-9A-Za-z_-]/g, '') + '.json');
    }

    // Every skill of the character, best first. Old (v1) files are read as learned skills.
    load(id) {
        const key = String(id);
        if (this.cache.has(key)) return this.cache.get(key);
        const r = fsx.readJson(this.file(key));
        const v = r.ok && r.value ? r.value : null;
        let list = [];
        let migrated = false;
        this.wrongs.set(key, v && Array.isArray(v.wrong) ? v.wrong.map(cleanWrong).filter(Boolean) : []);
        if (v && Array.isArray(v.skills)) {
            list = v.skills.map(clean).filter(Boolean);
        } else if (v && Array.isArray(v.lessons)) {
            list = v.lessons.filter((x) => x && x.task && x.interactionId).map(fromV1).map(clean).filter(Boolean);
            migrated = list.length > 0;
        } else if (r.ok === false && !r.missing) {
            if (this.log) this.log.warn('knowhow ' + key + ': could not read (' + r.error + '), starting empty without overwriting it');
            this.cache.set(key, []);
            this.unreadable = this.unreadable || new Set();
            this.unreadable.add(key);
            return [];
        }
        list = this.merge(list);
        this.cache.set(key, list);
        if (migrated) {
            this.save(key, list);
            if (this.log) this.log.info('knowhow ' + key + ': ' + list.length + ' lesson(s) moved to the skill list');
        }
        return list;
    }

    // Ways the character has carried out: replayable by id.
    learned(id) { return this.load(id).filter((s) => s.status === 'learned'); }

    // Ways the player explained that have not worked yet.
    taught(id) { return this.load(id).filter((s) => s.status === 'taught'); }

    find(id, skillId) { return this.load(id).find((s) => s.id === skillId) || null; }

    doubtful(s) { return !!s && s.status === 'learned' && s.failStreak >= DOUBT_STREAK; }

    // Ways the player said were wrong, newest first.
    wrong(id) {
        this.load(id);
        return (this.wrongs.get(String(id)) || []).slice().sort((a, b) => b.at - a.at);
    }

    // This game action was called out as the wrong way to do this job. loose: the job's words may
    // also sit inside the text ("去睡觉吧" is "去睡觉"); a part of them is not the job ("换上睡衣" is
    // not "换上睡衣去睡觉").
    isWrong(id, task, interactionId, loose) {
        if (!interactionId) return null;
        const k = taskKey(task);
        const near = (n) => {
            const nk = taskKey(n);
            return nk.length >= 2 && k.indexOf(nk) >= 0;
        };
        return this.wrong(id).find((w) => w.interactionId === String(interactionId) &&
            (sameTask(w, task) || (loose && [w.task].concat(w.aliases).some(near)))) || null;
    }

    save(id, list) {
        const key = String(id);
        if (this.unreadable && this.unreadable.has(key)) {
            throw new Error('the skill file could not be read earlier and is left as it is');
        }
        const kept = this.trim(list, Date.now());
        const wrong = (this.wrongs.get(key) || []).slice().sort((a, b) => b.at - a.at).slice(0, WRONG_KEEP);
        fsx.writeJson(this.file(key), { v: VERSION, skills: kept, wrong }, true);
        this.cache.set(key, kept);
        this.wrongs.set(key, wrong);
        return kept;
    }

    // The player said this way is wrong. The skill (learned or only taught) is dropped; a way with a
    // game action is remembered as wrong for its job and every name it went by. Returns the skill.
    retire(id, skillId, why, by) {
        const list = this.load(id).slice();
        const s = list.find((x) => x.id === skillId);
        if (!s) return null;
        const key = String(id);
        if (s.interactionId) {
            const names = [s.task].concat(s.aliases || []);
            let wrong = (this.wrongs.get(key) || []).slice();
            const twin = wrong.find((w) => w.interactionId === s.interactionId && names.some((n) => sameTask(w, n)));
            const w = twin || { task: s.task, aliases: [], interactionId: s.interactionId, interactionName: s.interactionName, objects: [] };
            names.forEach((n) => { if (!sameTask(w, n)) w.aliases = addUnique(w.aliases, n, ALIASES_MAX); });
            (s.objects || []).forEach((o) => { if (w.objects.indexOf(o) < 0) w.objects = w.objects.concat([o]).slice(-OBJECTS_MAX); });
            w.why = text(why, REASON_MAX) || w.why || '';
            w.by = text(by, 20) || w.by || '';
            w.at = Date.now();
            if (!twin) wrong.push(w);
            this.wrongs.set(key, wrong.map(cleanWrong).filter(Boolean));
        }
        this.save(id, list.filter((x) => x !== s));
        return s;
    }

    // One entry per game action; names of the same action are folded together.
    merge(list) {
        const out = [];
        for (const s of list) {
            const twin = s.status === 'learned'
                ? out.find((o) => o.status === 'learned' && o.interactionId === s.interactionId)
                : out.find((o) => o.status === 'taught' && sameTask(o, s.task));
            if (!twin) {
                out.push(s);
                continue;
            }
            twin.aliases = addUnique(twin.aliases, s.task, ALIASES_MAX);
            s.aliases.forEach((a) => { twin.aliases = addUnique(twin.aliases, a, ALIASES_MAX); });
            twin.aliases = twin.aliases.filter((a) => taskKey(a) !== taskKey(twin.task));
            s.objects.forEach((o) => { if (twin.objects.indexOf(o) < 0) twin.objects = twin.objects.concat([o]).slice(-OBJECTS_MAX); });
            twin.done += s.done;
            twin.usedAt = Math.max(twin.usedAt, s.usedAt);
            if (!twin.how && s.how) twin.how = s.how;
            if (twin.source === 'self' && s.source === 'taught') {
                twin.source = 'taught';
                twin.teacher = s.teacher;
                twin.how = s.how || twin.how;
            }
        }
        return out;
    }

    trim(list, now) {
        let kept = list.filter((s) => s.status === 'learned' || now - (s.taughtAt || 0) < TAUGHT_KEEP_MS);
        const cap = (pred, max) => {
            const group = kept.filter(pred).sort((a, b) => worth(b, now) - worth(a, now));
            const drop = new Set(group.slice(max).map((s) => s.id));
            kept = kept.filter((s) => !drop.has(s.id));
        };
        cap((s) => s.status === 'taught', KEEP_TAUGHT);
        cap((s) => s.status === 'learned' && s.source === 'self', KEEP_SELF);
        cap(() => true, KEEP);
        return kept.sort((a, b) => worth(b, now) - worth(a, now));
    }

    // The player explained how to do something. Kept now, so it is not lost when it cannot be
    // tried yet or the try fails; a newer explanation of the same job replaces the older one.
    // planned: the action the character is about to try it with, if any. aliases: names of the job
    // under a way this lesson corrects, so the old wording finds the new way.
    teach(id, entry) {
        const task = taskText(entry.task);
        if (!task) return null;
        const now = Date.now();
        const list = this.load(id).filter((s) => !(s.status === 'taught' && (sameTask(s, task) || s.lesson === entry.lesson)));
        const known = list.find((s) => s.status === 'learned' && sameTask(s, task));
        const s = {
            id: newId(),
            lesson: String(entry.lesson || ''),
            status: 'taught',
            source: 'taught',
            task,
            aliases: (Array.isArray(entry.aliases) ? entry.aliases : [])
                .reduce((a, n) => (sameTask({ task }, n) ? a : addUnique(a, n, ALIASES_MAX)), []),
            how: text(entry.how, HOW_MAX),
            teacher: text(entry.teacher, 20),
            interactionId: entry.planned ? String(entry.planned.interactionId || '') : '',
            interactionName: entry.planned ? text(entry.planned.interactionName, 40) : '',
            objects: entry.planned && entry.planned.objectName ? [text(entry.planned.objectName, 40)] : [],
            taughtAt: now,
            learnedAt: 0,
            usedAt: now,
            done: 0,
            fails: 0,
            failStreak: 0,
            lastFail: null
        };
        list.push(s);
        this.save(id, list);
        return { skill: s, corrects: known ? known.id : '' };
    }

    // A way was carried out to the end. entry: { lesson, task, how, teacher, objectName,
    // interactionId, interactionName, source: 'taught' | 'self', skill: id of a replayed skill }.
    // Returns what happened: 'new', 'again', 'renamed', 'replaces N', 'kept the taught way'.
    learn(id, entry) {
        const task = taskText(entry.task);
        const interactionId = String(entry.interactionId || '');
        if (!task || !interactionId) return 'nothing to keep';
        const now = Date.now();
        const self = entry.source === 'self';
        let list = this.load(id).slice();
        // A way called out as wrong is not picked up again alone; taught again, it is right after all.
        const wrong = this.isWrong(id, task, interactionId);
        if (wrong && self) return 'called out as wrong before';
        if (wrong) {
            const key = String(id);
            this.wrongs.set(key, (this.wrongs.get(key) || []).filter((w) => w !== wrong));
        }
        const objectName = text(entry.objectName, 40);
        const touch = (s) => {
            s.done += 1;
            s.usedAt = now;
            s.failStreak = 0;
            if (objectName && s.objects.indexOf(objectName) < 0) s.objects = s.objects.concat([objectName]).slice(-OBJECTS_MAX);
            if (!sameTask(s, task)) s.aliases = addUnique(s.aliases, task, ALIASES_MAX);
            if (!self && entry.how) s.how = text(entry.how, HOW_MAX);
            if (!self && entry.teacher && s.source === 'self') {
                s.source = 'taught';
                s.teacher = text(entry.teacher, 20);
            }
        };
        // The taught entry this came from is now a learned skill.
        const wasTaught = list.filter((s) => s.status === 'taught' && ((entry.lesson && s.lesson === entry.lesson) || sameTask(s, task)));
        list = list.filter((s) => wasTaught.indexOf(s) < 0);
        const replayed = entry.skill ? list.find((s) => s.id === entry.skill && s.status === 'learned') : null;
        const same = replayed && replayed.interactionId === interactionId
            ? replayed
            : list.find((s) => s.status === 'learned' && s.interactionId === interactionId);
        if (same) {
            const renamed = !sameTask(same, task);
            touch(same);
            this.save(id, list);
            return renamed ? 'renamed' : 'again';
        }
        // A different way for a job already known: the player's new lesson corrects the old way;
        // the character's own way never pushes out a taught one.
        const rivals = list.filter((s) => s.status === 'learned' && sameTask(s, task) && (!entry.lesson || s.lesson !== entry.lesson));
        if (self && rivals.some((s) => s.source === 'taught')) return 'kept the taught way';
        list = list.filter((s) => rivals.indexOf(s) < 0);
        const from = wasTaught[0];
        list.push({
            id: newId(),
            lesson: String(entry.lesson || ''),
            status: 'learned',
            source: self ? 'self' : 'taught',
            task: from ? from.task : task,
            aliases: from ? (sameTask(from, task) ? from.aliases : addUnique(from.aliases, task, ALIASES_MAX)) : [],
            how: self ? '' : text(entry.how, HOW_MAX) || (from ? from.how : ''),
            teacher: self ? '' : text(entry.teacher, 20),
            interactionId,
            interactionName: text(entry.interactionName, 40) || interactionId,
            objects: objectName ? [objectName] : [],
            taughtAt: from ? from.taughtAt : now,
            learnedAt: now,
            usedAt: now,
            done: 1,
            fails: from ? from.fails : 0,
            failStreak: 0,
            lastFail: null
        });
        this.save(id, list);
        return rivals.length ? 'replaces ' + rivals.length : 'new';
    }

    // A taught way or a replayed skill did not work this time.
    fail(id, ref, why) {
        if (!ref) return null;
        const list = this.load(id).slice();
        const hit = list.filter((s) => (ref.skill && s.id === ref.skill) || (!ref.skill && ref.id && s.lesson === ref.id));
        if (!hit.length) return null;
        const now = Date.now();
        hit.forEach((s) => {
            s.fails += 1;
            s.failStreak += 1;
            s.lastFail = { at: now, why: text(why, REASON_MAX) };
        });
        this.save(id, list);
        return hit[0];
    }
}

module.exports = { KnowHow, replayable, taskKey, DOUBT_STREAK };
