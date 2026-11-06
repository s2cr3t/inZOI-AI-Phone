'use strict';
// What each character really ate today, by game time. The game keeps no such record: the
// tracker sees an eat task every 20 s, and world.eatProgress tells when the eating has begun
// (Hunger went up). A task that was only walked to, plated up or held never counts.
//
// The activity diary cannot answer "have you had dinner": it keeps every change of activity,
// the prompt shows its last few lines, so by evening breakfast and lunch are gone, and an eat
// task that never got to the first bite looks the same there as a meal.
const path = require('path');
const fsx = require('./fsx');

// Eat steps of one sitting (sit down, eat, take another portion, clean up) less than this
// many game minutes apart are one meal.
const SAME_MEAL_MIN = 40;
// A meal still open this long (game minutes) after it was last seen eaten ended back then:
// the bridge was stopped or the game paused in between.
const OPEN_STALE_MIN = 45;
// Looks further apart than this (game minutes) leave a gap nobody watched: the bridge was
// stopped, or the tracker was busy.
const WATCH_GAP_MIN = 45;
// ...unless the looks were this close in real time: the game runs fast (sleeping, fast forward)
// and the bridge still looked every 20 s.
const WATCH_GAP_REAL_MS = 90000;

// A look at game time now after the watch w: no gap nobody watched in between.
function watchGoesOn(w, now, realNow) {
    if (!w || now < w.to) return false;
    return now - w.to <= WATCH_GAP_MIN || (typeof w.seenAt === 'number' && realNow - w.seenAt <= WATCH_GAP_REAL_MS);
}
const KEEP = 40;
// Drinking (coffee, juice, water: world.eatProgress also follows Drink tasks) is not a meal.
const MEAL_RE = /Eat/i;

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// Minutes since game day 0, for comparing times across midnight.
function absMinutes(env) {
    return Number(env.day) * 1440 + Number(env.hour || 0) * 60 + Number(env.minute || 0);
}

// A day of meals runs from 04:00 to 04:00: asked after midnight, last night's dinner and
// late snack are still today's.
const DAY_START_MIN = 4 * 60;
function mealDay(abs) {
    return Math.floor((abs - DAY_START_MIN) / 1440);
}

function hhmm(abs) {
    const m = ((abs % 1440) + 1440) % 1440;
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

// Which meal of the day a sitting is, by the hour it began.
function mealOf(abs) {
    const h = Math.floor((((abs % 1440) + 1440) % 1440) / 60);
    if (h >= 4 && h < 10) return 'breakfast';
    if (h >= 10 && h < 15) return 'lunch';
    if (h >= 15 && h < 17) return 'snack';
    if (h >= 17 && h < 22) return 'dinner';
    return 'late';
}

function isMealBag(id) {
    const s = String(id || '');
    return MEAL_RE.test(s);
}

class EatLog {
    constructor(dataDir, keep) {
        this.dir = path.join(dataDir, 'eaten');
        this.keep = keep || KEEP;
        this.cache = new Map();
    }

    file(id) {
        return path.join(this.dir, id + '.json');
    }

    load(id) {
        if (!this.cache.has(id)) {
            const r = fsx.readJson(this.file(id));
            const v = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
            this.cache.set(id, {
                meals: Array.isArray(v.meals) ? v.meals : [],
                boots: v.boots && typeof v.boots === 'object' ? v.boots : {},
                // The stretch of game time watched without a gap up to the last look.
                watch: v.watch && typeof v.watch.from === 'number' ? v.watch : null
            });
        }
        return this.cache.get(id);
    }

    save(id) {
        const v = this.load(id);
        while (v.meals.length > this.keep) v.meals.shift();
        const bootIds = Object.keys(v.boots);
        // Only the boots meals still refer to, plus the newest few.
        for (const b of bootIds.slice(0, Math.max(0, bootIds.length - 8))) {
            if (!v.meals.some((m) => m.boot === b)) delete v.boots[b];
        }
        try {
            fsx.writeJson(this.file(id), v, true);
        } catch (e) {
            // A meal log that cannot be written is still right in memory.
        }
    }

    // activity: world.activityOf after world.eatProgress (activity.begun). env: game clock.
    // boot: the Lua mod's start id of the world now loaded ('' when unknown). Returns the meal
    // that was started or extended, or null.
    observe(actorId, activity, env, boot, hunger, realNow) {
        if (!env || typeof env.day !== 'number' && !/^\d+$/.test(String(env.day))) return null;
        const id = String(actorId);
        const v = this.load(id);
        const now = absMinutes(env);
        const b = String(boot || '');
        const real = typeof realNow === 'number' ? realNow : Date.now();
        let changed = false;
        if (b && v.boots[b] === undefined) {
            v.boots[b] = now;
            changed = true;
        }
        const w = v.watch;
        if (w && w.boot !== b && w.from <= now && (now <= w.to || watchGoesOn(w, now, real))) {
            // Another world was loaded (a save) at a time already watched in the last one: what
            // was eaten before that time is the same in both.
            v.watch = { boot: b, from: w.from, to: now };
            changed = true;
        } else if (!w || w.boot !== b || !watchGoesOn(w, now, real)) {
            v.watch = { boot: b, from: now, to: now };
            changed = true;
        } else if (v.watch.to !== now) {
            // Saved with a meal change or every half hour of game time, not on every look.
            if (now - v.watch.savedTo >= 30 || v.watch.savedTo === undefined) changed = true;
            v.watch.to = now;
        }
        const last = v.meals[v.meals.length - 1];
        // A meal of another loaded world, or one not seen eaten for long, is over.
        if (last && last.open && (last.boot !== b || now - last.last > OPEN_STALE_MIN || now < last.start)) {
            last.open = false;
            changed = true;
        }
        const eating = !!(activity && !activity.idle && activity.begun === true && isMealBag(activity.id));
        let meal = null;
        if (eating) {
            const h = typeof hunger === 'number' ? hunger : null;
            if (last && last.boot === b && now >= last.start && now - last.last <= SAME_MEAL_MIN) {
                meal = last;
                if (!meal.open || meal.last !== now) changed = true;
                meal.open = true;
                meal.last = now;
                if (meal.bags.indexOf(activity.id) < 0) meal.bags.push(activity.id);
                if (h !== null && (meal.hungerTo === null || h > meal.hungerTo)) meal.hungerTo = h;
            } else {
                meal = { day: Number(env.day), start: now, last: now, open: true, boot: b, bags: [activity.id], hungerTo: h, seenAt: Date.now() };
                v.meals.push(meal);
                changed = true;
            }
            meal.seenAt = Date.now();
        } else if (last && last.open) {
            last.open = false;
            changed = true;
        }
        v.watch.seenAt = real;
        if (changed) {
            v.watch.savedTo = v.watch.to;
            this.save(id);
        }
        return meal;
    }

    // Since when ('HH:MM') this character has been watched without a gap up to now, on today's
    // game day; null when not watched now. Before it, nobody knows what was eaten.
    watchedSince(actorId, env, boot, realNow) {
        if (!env) return null;
        const v = this.load(String(actorId));
        const w = v.watch;
        const now = absMinutes(env);
        if (!w || w.boot !== String(boot || '') || !watchGoesOn(w, now, typeof realNow === 'number' ? realNow : Date.now())) return null;
        const dayStart = mealDay(now) * 1440 + DAY_START_MIN;
        return hhmm(Math.max(w.from, dayStart));
    }

    // The meals of today's game day that happened in the world now loaded: those of this boot,
    // and those of earlier boots (or of no known boot) from before this world was first seen,
    // which a loaded save of the same day still has behind it.
    today(actorId, env, boot) {
        if (!env) return [];
        const v = this.load(String(actorId));
        const now = absMinutes(env);
        const day = mealDay(now);
        const b = String(boot || '');
        const since = b && v.boots[b] !== undefined ? v.boots[b] : null;
        return v.meals
            .filter((m) => mealDay(m.start) === day && m.start <= now)
            .filter((m) => !b || m.boot === b || (since !== null && m.start < since))
            .map((m) => ({
                meal: mealOf(m.start),
                start: hhmm(m.start),
                end: hhmm(m.last),
                ongoing: !!(m.open && m.boot === b && now - m.last <= OPEN_STALE_MIN),
                minutesAgo: Math.max(0, now - m.last),
                hungerTo: typeof m.hungerTo === 'number' ? m.hungerTo : null
            }));
    }
}

module.exports = { EatLog, mealOf, mealDay, absMinutes, hhmm, DAY_START_MIN, isMealBag, SAME_MEAL_MIN, OPEN_STALE_MIN, WATCH_GAP_MIN, WATCH_GAP_REAL_MS };
