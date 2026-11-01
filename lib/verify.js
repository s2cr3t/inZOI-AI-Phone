'use strict';
// Did the job really get done? A held task that ran to its end is checked against the world
// before anyone is told it worked and before the way is kept as a skill.
//
// The game shows no on/off or clean/dirty flag on objects, but it shows what can be done with
// them, and that turns over with their state: a TV that is on offers 关闭 (Off_TV*), one that is
// off only offers channels; a lamp that is on offers 关灯; a table with dishes on it offers
// 全部清理; a dish standing out offers 冷藏 and 倒掉, one in the fridge or in the bin does not.
// A person's needs are exact numbers: a bath raises 卫生, the toilet 如厕, sleep 困倦, a meal 饱食.
// Watching TV is not checked by the TV: once the show is over it may well be switched off.
// Meals carried by the Lua mod report their own outcome; cooking leaves a new dish behind.
//
// Verdicts: 'done' (the world shows it), 'not_done' (the world shows it did not happen, with the
// reason in words), 'unknown' (nothing here can tell). A check that needs a fresh report waits
// for it ('wait') up to its own limit, then decides on what it saw.

const { servedOnTable, MODES, modeOf } = require('./meals');

// Object checks, tried in order on the held bag and its name. gone: done once nothing on the
// object matches; appears: done once something matches.
const OBJECT_CHECKS = [
    { id: 'tv_off', when: (h) => /^Off_TV/.test(h.bagId), gone: (a) => /^Off_TV/.test(a.id), missed: (n) => '「' + n + '」还开着' },
    { id: 'lights_off', when: (h) => /关掉所有灯/.test(h.label) || /^On_Lighting\d*_All$/.test(h.bagId), gone: (a) => /^关灯$/.test(a.name), missed: (n) => '「' + n + '」还亮着' },
    { id: 'light_off', when: (h) => /^关灯$/.test(h.label), gone: (a) => /^关灯$/.test(a.name), missed: (n) => '「' + n + '」还亮着' },
    { id: 'light_on', when: (h) => /^开灯$|打开所有灯/.test(h.label), appears: (a) => /^关灯$/.test(a.name), missed: (n) => '「' + n + '」没有亮' },
    { id: 'clear_table', when: (h) => /^Clean_Table_All$/.test(h.bagId), gone: (a) => a.id === 'Clean_Table_All', missed: (n) => '「' + n + '」上还没收拾干净' },
    { id: 'fridge_keep', when: (h) => h.bagId === 'Food_Fridge_Keeping', gone: (a) => a.id === 'Food_Fridge_Keeping', food: 'stored', missed: (n) => '「' + n + '」没放进冰箱，还在外面' },
    { id: 'dump_food', when: (h) => /^Dump(Food|Target)/.test(h.bagId), gone: (a) => /^Dump(Food|Target)/.test(a.id), food: 'gone', missed: (n) => '「' + n + '」还在原处，没处理掉' }
];

// Need checks: the stat the job is for, by bag id or the game's action name.
const NEED_CHECKS = [
    { stat: 'Cleanliness', re: /^Use_Bath|^Shower|^Bath_|洗澡|淋浴|泡澡/, missed: '洗完了，身上却还是不干净' },
    { stat: 'Cleanliness', re: /^WashHand|^WashFace|^BrushTeeth|^洗手$|^洗脸$|^刷牙$/, small: true, missed: '洗完了，却一点没变干净' },
    { stat: 'Toilet', re: /^Toilet|^上厕所$|如厕/, missed: '去了厕所却没上成，还是憋着' },
    { stat: 'Sleep', re: /^Sleep_|^Nap|^睡觉$|午睡|小睡/, missed: '躺了一会儿却没睡着，还是很困' },
    { stat: 'Hunger', kind: 'eat', missed: '吃完了，肚子却还是饿' }
];
// A rise this big (stat points, -100..100) shows the need was met; a small job (washing hands)
// needs less. Already this full before, there was nothing to gain and the job counts as done.
const NEED_RISE = 4;
const NEED_RISE_SMALL = 1;
const NEED_FULL_PCT = 92;
// Object state can trail the end of the action by a moment.
const OBJECT_WAIT_MS = 8000;
// The Lua food report comes every 30 s.
const FOOD_WAIT_MS = 75000;
const MEAL_WAIT_MS = 30000;
const COOK_WAIT_MS = 100000;
const POLL_MS = 2500;

function needCheckOf(hold) {
    const s = String(hold.bagId || '') + ' ' + String(hold.label || '');
    for (const c of NEED_CHECKS) {
        if (c.kind && hold.kind === c.kind) return c;
        if (c.re && (c.re.test(String(hold.bagId || '')) || c.re.test(String(hold.label || '')) || c.re.test(s))) return c;
    }
    return null;
}

function objectCheckOf(hold) {
    if (!hold.targetId) return null;
    return OBJECT_CHECKS.find((c) => c.when(hold)) || null;
}

class Verifier {
    // d: the daemon (game, actions, journal, meals, log). onVerdict(entry, verdict) is called once
    // per check, entry being what add() was given.
    constructor(d, onVerdict) {
        this.d = d;
        this.onVerdict = onVerdict;
        this.pending = [];
        this.busy = false;
    }

    // What the check compares against later, read before the job starts. Never throws.
    async before(actorId, step) {
        const it = (step && step.interaction) || {};
        const probe = { bagId: String(it.id || ''), label: String(it.name || ''), kind: step && step.kind, chore: step && step.chore, targetId: step && !step.self ? String(step.objectId || '') : '' };
        const out = { at: Date.now() };
        try {
            const need = needCheckOf(probe);
            if (need) out.stats = await this.stats(actorId);
            if (probe.kind === 'cook') out.foods = this.foodIds();
        } catch (e) {
            this.d.log.debug('verify: before ' + probe.bagId + ': ' + (e && e.message || e));
        }
        return out;
    }

    // entry: { key, actorId, ageGroup, hold, confirmed }. confirmed: the game's own journal said
    // the task finished (not just that its time ran out).
    add(entry) {
        const hold = entry.hold;
        const plan = this.planFor(hold);
        this.pending.push(Object.assign({}, entry, { plan, endedAt: Date.now(), until: Date.now() + plan.waitMs, tries: 0 }));
        this.d.log.info('verify [' + entry.key + '] ' + hold.bagId + (hold.objectName ? ' @' + hold.objectName : '') + ': checking by ' + plan.by);
        return this.tick();
    }

    planFor(hold) {
        if (hold.mealSeq) return { by: 'meal result', waitMs: MEAL_WAIT_MS };
        if (hold.kind === 'cook') return { by: 'new dish', waitMs: COOK_WAIT_MS };
        const obj = objectCheckOf(hold);
        if (obj) return { by: 'object ' + obj.id, obj, waitMs: obj.food ? FOOD_WAIT_MS : OBJECT_WAIT_MS };
        const need = needCheckOf(hold);
        if (need && hold.check && hold.check.stats && hold.check.stats[need.stat]) return { by: 'need ' + need.stat, need, waitMs: OBJECT_WAIT_MS };
        return { by: 'nothing to read', waitMs: 0 };
    }

    async tick() {
        if (this.busy || !this.pending.length) return;
        this.busy = true;
        const batch = this.pending;
        this.pending = [];
        const keep = [];
        try {
            const now = Date.now();
            for (const e of batch) {
                if (e.nextAt && now < e.nextAt) {
                    keep.push(e);
                    continue;
                }
                let v;
                try {
                    v = await this.check(e);
                } catch (err) {
                    this.d.log.warn('verify [' + e.key + '] ' + e.hold.bagId + ': ' + (err && err.message || err));
                    v = { verdict: 'unknown', why: '' };
                }
                if (v.verdict === 'wait') {
                    if (Date.now() < e.until) {
                        e.tries += 1;
                        e.nextAt = Date.now() + POLL_MS;
                        keep.push(e);
                        continue;
                    }
                    v = v.timeout || { verdict: 'unknown', why: '' };
                }
                this.d.log.info('verify [' + e.key + '] ' + e.hold.bagId + (e.hold.objectName ? ' @' + e.hold.objectName : '') + ' -> ' + v.verdict +
                    (v.why ? ' (' + v.why + ')' : '') + (v.verdict === 'unknown' ? (e.confirmed ? ', the game says it finished' : ', not confirmed by the game') : ''));
                try {
                    this.onVerdict(e, v);
                } catch (err) {
                    this.d.log.warn('verify [' + e.key + '] verdict not applied: ' + (err && err.message || err));
                }
            }
        } finally {
            // Checks added while this pass ran come after the ones still waiting.
            this.pending = keep.concat(this.pending);
            this.busy = false;
        }
    }

    async check(e) {
        const h = e.hold;
        const p = e.plan;
        if (h.mealSeq) return this.checkMeal(e);
        if (h.kind === 'cook') return this.checkCook(e);
        if (p.obj) return this.checkObject(e);
        if (p.need) return this.checkNeed(e);
        return { verdict: 'unknown', why: '' };
    }

    checkMeal(e) {
        const res = this.d.meals.result(e.hold.mealSeq);
        if (!res) return { verdict: 'wait', timeout: { verdict: 'unknown', why: 'no result from the mod' } };
        if (res.stage === 'fail') return { verdict: 'not_done', why: 'the mod reported ' + String(res.detail || 'fail').slice(0, 60), quiet: true };
        if (res.stage !== 'served') return { verdict: 'wait', timeout: { verdict: 'unknown', why: 'stuck at ' + res.stage } };
        const mode = modeOf(e.hold.learnAs && e.hold.learnAs.id) || MODES.eat;
        // Put on a table instead of in front of the person: not what was asked; already told.
        if (mode.person && servedOnTable(res.detail)) return { verdict: 'not_done', why: 'left on a table, not served to the person', quiet: true };
        return { verdict: 'done', why: 'the mod reported served' };
    }

    checkCook(e) {
        const before = new Set(((e.hold.check && e.hold.check.foods) || e.hold.foodBefore || []).map(String));
        const j = this.d.journal;
        if (!j || !j.alive()) return { verdict: 'unknown', why: 'the mod is not reporting' };
        const fresh = this.foodIds().filter((id) => {
            if (before.has(id)) return false;
            const f = j.foodState(id);
            return !!(f && f.edible);
        });
        if (fresh.length) return { verdict: 'done', why: 'new dish ' + fresh[fresh.length - 1] };
        return { verdict: 'wait', timeout: { verdict: 'not_done', why: '做完了，却没见到做好的菜' } };
    }

    async checkObject(e) {
        const h = e.hold;
        const c = e.plan.obj;
        const actions = await this.d.actions.freshObjectActions(e.actorId, h.targetId, e.ageGroup);
        const name = h.objectName || '那样东西';
        const matched = actions.some((a) => (c.gone || c.appears)(a));
        if (c.gone ? !matched : matched) return { verdict: 'done', why: c.gone ? 'no longer offered on it' : 'now offered on it' };
        // Food: a family meal listed inside a container, or a dish missing from a report made
        // after the job ended, settles it whatever the actions say.
        if (c.food) {
            const j = this.d.journal;
            if (c.food === 'stored' && j && j.storedContainerOf(h.targetId) && j.storedAt > e.endedAt) return { verdict: 'done', why: 'listed inside ' + j.storedContainerOf(h.targetId) };
            if (c.food === 'gone' && j && j.alive() && j.foodAt > e.endedAt && j.food && !j.food.has(String(h.targetId))) return { verdict: 'done', why: 'no longer in the food report' };
        }
        return { verdict: 'wait', timeout: { verdict: 'not_done', why: c.missed(name) } };
    }

    async checkNeed(e) {
        const n = e.plan.need;
        const was = e.hold.check.stats[n.stat];
        const now = (await this.stats(e.actorId))[n.stat];
        if (!now || typeof now.value !== 'number' || typeof was.value !== 'number') return { verdict: 'unknown', why: 'need not readable' };
        const rise = now.value - was.value;
        const need = n.small ? NEED_RISE_SMALL : NEED_RISE;
        const shown = n.stat + ' ' + Math.round(was.pct) + '% -> ' + Math.round(now.pct) + '%';
        if (rise >= need) return { verdict: 'done', why: shown };
        if (was.pct >= NEED_FULL_PCT && now.pct >= NEED_FULL_PCT) return { verdict: 'done', why: shown + ', it was already met' };
        // A snack may restore only a point or two. Once the game says the eating interaction
        // actually finished, a small rise is still evidence of eating; no rise is inconclusive,
        // never proof that the food was absent or the action failed.
        if (n.stat === 'Hunger' && e.confirmed) {
            if (rise > 0) return { verdict: 'done', why: shown + ', the game says eating finished' };
            return { verdict: 'unknown', why: 'the game says eating finished; hunger change is inconclusive', detail: shown };
        }
        return { verdict: 'wait', timeout: { verdict: 'not_done', why: n.missed, detail: shown } };
    }

    async stats(actorId) {
        const r = await this.d.game.soft('stat_get_all', { entity_id: String(actorId) });
        const s = (r && r.stats) || {};
        const out = {};
        for (const k of Object.keys(s)) {
            if (s[k] && typeof s[k].value === 'number') out[k] = { value: s[k].value, pct: typeof s[k].pct === 'number' ? s[k].pct : null };
        }
        return out;
    }

    foodIds() {
        return this.d.reportedFoodIds ? this.d.reportedFoodIds().map(String) : [];
    }

    // Checks of one character are dropped when the bridge forgets what that character was doing.
    forget(actorId) {
        this.pending = this.pending.filter((e) => String(e.actorId) !== String(actorId));
    }
}

module.exports = { Verifier, OBJECT_CHECKS, NEED_CHECKS, needCheckOf, objectCheckOf };
