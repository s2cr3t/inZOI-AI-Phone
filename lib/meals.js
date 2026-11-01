'use strict';
// Family meals kept in the fridge. The game's 取出 only opens the fridge inventory picker, and
// nobody clicks a dish there for a character the player is not controlling. The HouseholdJournal
// Lua mod lists the family meals it finds inside containers (M lines) and, when asked, takes one
// out with the dish already picked and puts it on a table, all with the game's own interactions
// (Zoi.MealServer, T lines). Then, by the mode the character chose:
//   eat:   serves itself one portion and eats it; the rest stays on the table.
//   table: stands by it smelling the food or clapping, the way the game serves a cooked meal;
//          nobody eats, the family serves themselves.
//   give:  serves it to one person with the game's AutoFind_DeliveryFood_To_Target: the dish is
//          put down in front of them.
// A dish already standing out (just cooked, left on the counter) is served to a person the same
// way, picked up where it stands (hand). Both need a mod that lists "give" in its heartbeat; when
// the person cannot be served, the mod puts the dish on a table instead and says so.
//
// Delivery: the bridge is the only writer of the mod's bridge/meals.cfg. It holds the requests
// not yet answered, "<seq>:<actor>:<dish>:<container>:<e|t>" or
// "<seq>:<actor>:<dish>:<container>:<g|h>:<person>" (container 0 for h), and withdrawals of
// requests the bridge gave up on, "c<seq>:<actor>", separated by ";". The mod's B1 side sends
// each new entry once.
const fsx = require('./fsx');

const MEAL_PREFIX = 'FamilyMeal_';
const PICKER_BAG = 'Storage_Fridge_SelectFood';
const TAKEOUT_BAG = 'Storage_Fridge_TakeOut_SelectedFood';
// The game's own follow-up after the pick-up; the mod cancels it and starts the mode's serveBag.
const AUTO_NEXT_BAG = 'Next_AllTypeFood_Start_Eat';
// The game's "serve food to the target" and the one step it is made of.
const DELIVER_BAG = 'AutoFind_DeliveryFood_To_Target';
const DELIVER_STEP = 'AutoFind_Putdown_Food_To_Target';
const PICKUP_BAG = 'PickUp';
const PICKED_STEP = 'Picked_PickUp_RightHand';
// The heartbeat feature a mod that can serve a person lists.
const GIVE_FEATURE = 'give';
// chain: every bag the task passes through. steps: what the game's data says it is made of,
// shown to the model like any action's steps.
const MODES = {
    eat: {
        code: 'e',
        suffix: '',
        serveBag: 'Next_Food_Start_Eat_Both_Prepared_Served',
        chain: [
            TAKEOUT_BAG,
            AUTO_NEXT_BAG,
            'Next_Food_Start_Eat_Both_Prepared_Served',
            'Next_PreparedCake_EatServedCake',
            'Next_Food_Start_Eat',
            'Next_Stand_EatSkewer_And_Destroy',
            'Next_Food_CleanUp',
            'Next_Dump_Trash'
        ],
        steps: [TAKEOUT_BAG, 'AutoFind_PutDown_TableOnly_ToSurface', 'AutoFind_PreparedCake_TakeServedCake', 'Food_Eat', 'Next_Food_CleanUp'],
        label: (name) => '取出「' + name + '」摆上餐桌，盛一份吃',
        learned: '取出冰箱里的家庭餐，摆上餐桌盛一份吃',
        doing: (name) => '正在从冰箱取出「' + name + '」，摆上餐桌盛一份吃',
        purpose: (name) => '把冰箱里的' + name + '拿出来吃',
        served: 'on the way to the table, then one portion and eating'
    },
    table: {
        code: 't',
        suffix: '_Table',
        serveBag: 'Next_Food_Start_Eat',
        chain: [TAKEOUT_BAG, AUTO_NEXT_BAG, 'Next_Food_Start_Eat', 'Next_Smell_Food_Stand'],
        steps: [TAKEOUT_BAG, 'AutoFind_PutDown_TableOnly_ToSurface', 'Next_Smell_Food_Stand'],
        label: (name) => '取出「' + name + '」摆上餐桌',
        learned: '取出冰箱里的家庭餐，摆上餐桌给家里人吃',
        doing: (name) => '正在从冰箱取出「' + name + '」，摆上餐桌',
        purpose: (name) => '把冰箱里的' + name + '拿出来摆上餐桌',
        served: 'on the way to the table, left there for the family'
    },
    give: {
        code: 'g',
        suffix: '_Give',
        person: true,
        serveBag: DELIVER_BAG,
        chain: [TAKEOUT_BAG, AUTO_NEXT_BAG, DELIVER_BAG, DELIVER_STEP, 'Next_Food_Start_Eat', 'Next_Smell_Food_Stand'],
        steps: [TAKEOUT_BAG, DELIVER_BAG, DELIVER_STEP],
        label: (name, who) => '取出「' + name + '」端给' + (who || '对方'),
        learned: '取出冰箱里的家庭餐，端到家里人面前',
        doing: (name, who) => '正在从冰箱取出「' + name + '」，端给' + (who || '对方'),
        purpose: (name, who) => '把冰箱里的' + name + '拿出来给' + (who || '对方'),
        served: 'in hand, being served to the person'
    },
    hand: {
        code: 'h',
        suffix: '_Hand',
        person: true,
        loose: true,
        serveBag: DELIVER_BAG,
        chain: [PICKUP_BAG, PICKED_STEP, DELIVER_BAG, DELIVER_STEP, 'Next_Food_Start_Eat', 'Next_Smell_Food_Stand'],
        steps: [PICKUP_BAG, DELIVER_BAG, DELIVER_STEP],
        label: (name, who) => '把「' + name + '」端给' + (who || '对方'),
        learned: '把做好的饭菜端到家里人面前',
        doing: (name, who) => '正在把「' + name + '」端给' + (who || '对方'),
        purpose: (name, who) => '把' + name + '端给' + (who || '对方'),
        served: 'picked up, being served to the person'
    }
};

function modeOf(id) {
    const s = String(id || '');
    if (s.indexOf(MEAL_PREFIX) !== 0) return null;
    if (/_Table$/.test(s)) return MODES.table;
    if (/_Give$/.test(s)) return MODES.give;
    if (/_Hand$/.test(s)) return MODES.hand;
    return MODES.eat;
}

// The bags during which the dish is in the actor's hands: out of the fridge or picked up, not yet put down.
const CARRYING_BAGS = [TAKEOUT_BAG, AUTO_NEXT_BAG, MODES.eat.serveBag, MODES.table.serveBag, PICKUP_BAG, PICKED_STEP, DELIVER_BAG, DELIVER_STEP];

// Every bag any mode passes through.
const CHAIN_BAGS = Object.keys(MODES).reduce((all, k) => all.concat(MODES[k].chain.filter((b) => all.indexOf(b) < 0)), []);
// The game writes its Lua log in bursts minutes apart, so the list may be this old. The mod
// checks the dish again before taking it out.
const STORED_FRESH_MS = 15 * 60000;
const KEEP_RESULTS = 40;
const WITHDRAW_KEEP_MS = 10 * 60000;
// A dish on its way to the table is in someone's hands, where the game offers nothing to eat
// from it. For this long after it was put down the scan of the site lists it anyway.
const CARRIED_KEEP_MS = 5 * 60000;
// The game's own "take one portion and eat it" on a family meal standing on a table.
const EAT_PORTION_BAG = 'PreparedCake_EatServedCake';

// Why a request did not go through, in words the character can pass on. The mod only reports
// what it saw; nothing here guesses.
function reasonText(detail) {
    const d = String(detail || '');
    if (/^dish_gone|^not_in_container/.test(d)) return '那盘菜已经不在冰箱里了';
    if (/^spoiled/.test(d)) return '那盘菜已经变质了';
    if (/^not_edible/.test(d)) return '那盘菜已经吃完了';
    if (/^not_family_meal/.test(d)) return '那不是一盘家庭餐';
    if (/^hands_full/.test(d)) return '手上一直拿着别的东西，腾不出手去拿';
    if (/^busy_with/.test(d)) return '上一次取菜还没做完';
    if (/^busy/.test(d)) return '一直有别的事占着，没空下来去冰箱拿';
    if (/^not_started/.test(d)) return '游戏没有开始取菜';
    if (/^takeout_too_long/.test(d)) return '去冰箱拿菜拖得太久，没拿出来';
    if (/^not_in_hand_after_takeout/.test(d)) return '打开冰箱以后菜没拿到手上';
    if (/^serve_not_started.*_in_hand$/.test(d)) return '菜拿出来了，却没能开始摆上餐桌，菜还在手上';
    if (/^serve_not_started/.test(d)) return '菜拿出来了，却没能开始摆上餐桌';
    if (/^not_household/.test(d)) return '不是这一家的人，不能动这台冰箱里的菜';
    if (/^canceled_by_bridge/.test(d)) return '等了太久没有开始，取菜请求已经撤回';
    if (/^character_unloaded/.test(d)) return '人离开了这里';
    if (/^send_failed/.test(d)) return '取菜的指令没能交给游戏';
    if (/^stale_after_reload/.test(d)) return '游戏重新加载过，之前的取菜请求作废了';
    if (/^in_container/.test(d)) return '那盘菜已经被收进冰箱或柜子里了';
    if (/^person_not_household/.test(d)) return '要端给的人不是这一家的';
    if (/^person_is_actor/.test(d)) return '要端给的就是自己';
    if (/^pickup_too_long/.test(d)) return '走过去端那盘菜拖得太久，没端起来';
    if (/^pickup_not_started|^pickup_/.test(d)) return '游戏没有开始去端那盘菜';
    if (/^fallback_add_failed/.test(d)) return '没能端到对方面前，想先放到餐桌上也没放成，菜还在手上';
    return '没做成（' + d.slice(0, 60) + '）';
}

// A served request whose dish ended up on a table because the person could not be served.
function servedOnTable(detail) {
    return /^table_fallback/.test(String(detail || ''));
}

class Meals {
    constructor(daemon) {
        this.d = daemon;
        this.log = daemon.log;
        this.pending = [];
        this.withdrawn = [];
        this.results = new Map();
        this.lastSeq = 0;
        this.writtenOnce = false;
        // Dishes the mod has taken out and is carrying to a table: { dish, name, seq, servedAt }.
        this.carried = [];
    }

    // Family meals being carried to a table right now, or put down there moments ago. One listed
    // inside a container again after it was taken out is back there (put away, or a save loaded).
    carriedDishes() {
        const now = Date.now();
        const j = this.d.journal;
        this.carried = this.carried.filter((c) => {
            if (c.servedAt && now - c.servedAt >= CARRIED_KEEP_MS) return false;
            if (c.outSeq && j && j.storedSeq > c.outSeq && j.storedContainerOf(c.dish)) {
                this.log.info('meals: 「' + c.name + '」 is listed inside ' + j.storedContainerOf(c.dish) + ' again, no longer on its way to the table');
                return false;
            }
            return true;
        });
        return this.carried.map((c) => ({ dish: c.dish, name: c.name, mode: c.mode || 'eat', personName: c.personName || '' }));
    }

    // The Lua mod started again. It forgot every request, and after a loaded save the dishes are
    // where that save had them. Nothing is resent: the file is emptied, and the mod's B1 side
    // also refuses requests older than itself.
    reset() {
        const dropped = this.pending.length;
        this.pending = [];
        this.withdrawn = [];
        this.carried = [];
        this.writeQueue();
        this.log.info('meals: Lua mod restarted, forgot ' + dropped + ' unanswered request(s) and every dish on its way to a table');
    }

    // The actor has a family meal in hand, or is about to: cutting in now would make the game drop
    // it. bagId: what the actor is playing now. Until the serve bag has put the dish down, any
    // new step waits for the current one to end.
    carrying(actorId, bagId) {
        const actor = String(actorId);
        if (this.pending.some((p) => p.actor === actor)) return true;
        const bag = String(bagId || '');
        if (!bag || CARRYING_BAGS.indexOf(bag) < 0) return false;
        this.carriedDishes();
        return this.carried.some((c) => c.actor === actor);
    }

    // What eating from a carried dish looks like before the game offers it: its real action,
    // which works once the dish stands on the table.
    carriedObject(c) {
        const toPerson = c.mode && MODES[c.mode] && MODES[c.mode].person;
        const where = toPerson ? (c.personName || '家里人') + '面前' : '餐桌上';
        return {
            id: c.dish,
            name: c.name,
            meters: null,
            carried: true,
            state: toPerson ? '正在被端给' + (c.personName || '家里人') + '的饭菜' : '正在被端上餐桌的家庭餐',
            actions: [{
                id: EAT_PORTION_BAG,
                name: '吃一块',
                hint: '这盘菜放到' + where + '以后，从里面盛一份吃；现在还在端过去的路上，排在后面做',
                kind: 'eat'
            }]
        };
    }

    get cfg() {
        return this.d.cfg.meals;
    }

    // The mod is running and has listed what is in the containers recently.
    usable() {
        const j = this.d.journal;
        return !!(this.cfg.enabled && this.d.cfg.journal.enabled && j && j.alive());
    }

    // The running mod can put a dish down in front of a person (modes give and hand).
    canServePerson() {
        return this.usable() && this.d.journal.can(GIVE_FEATURE);
    }

    // Nothing from an earlier run is resent: the file starts empty.
    configure() {
        if (this.writtenOnce) return;
        this.writtenOnce = true;
        this.writeQueue();
    }

    writeQueue() {
        const file = this.cfg.queue_file;
        if (!file) return;
        const entries = this.pending.map((p) => p.seq + ':' + p.actor + ':' + p.dish + ':' + p.container + ':' + MODES[p.mode].code + (MODES[p.mode].person ? ':' + p.person : ''))
            .concat(this.withdrawn.map((w) => 'c' + w.seq + ':' + w.actor));
        const text = entries.join(';');
        try {
            const now = fsx.readText(file);
            if (now !== null && now === text) return;
            fsx.writeAtomic(file, text);
        } catch (e) {
            this.log.warn('meals: queue file not written: ' + e.message);
        }
    }

    // Family meals in this container that can still be eaten, with the game's dish names.
    // null when the mod has not reported recently, so nothing is offered on old news.
    async dishesIn(containerId) {
        if (!this.usable()) return null;
        const list = this.d.journal.storedIn(containerId, STORED_FRESH_MS);
        if (!list) return null;
        const busy = new Set(this.pending.map((p) => p.dish));
        const out = [];
        for (const dish of list) {
            if (dish.spoiled || busy.has(dish.id) || (dish.left !== null && dish.left <= 0)) continue;
            let name = '';
            try {
                name = await this.d.world.foodName(dish.objectId);
            } catch (e) {
                name = '';
            }
            out.push(Object.assign({}, dish, { name: name || dish.objectId }));
        }
        return out;
    }

    // The actions shown for a fridge in place of its inventory picker, two per family meal.
    async actionsFor(containerId) {
        const dishes = await this.dishesIn(containerId);
        if (!dishes) return [];
        const out = [];
        for (const dish of dishes) {
            const hint = '冰箱里存着的家庭餐「' + dish.name + '」' +
                (dish.left !== null && dish.total ? '，还剩 ' + dish.left + '/' + dish.total + ' 份' : '');
            for (const mode of ['eat', 'table']) {
                const m = MODES[mode];
                out.push({
                    id: MEAL_PREFIX + dish.id + m.suffix,
                    name: m.label(dish.name),
                    hint,
                    kind: 'meal',
                    meal: { dish: dish.id, container: String(containerId), name: dish.name, mode }
                });
            }
        }
        return out;
    }

    // meal: { dish, container, name, mode, person, personName }. A mode that serves a person
    // needs a numeric person id and a mod that can do it; anything else is refused here, before
    // a line the mod cannot read reaches its file.
    request(actor, meal, pairKey, what) {
        const now = Date.now();
        const mode = MODES[meal.mode] ? meal.mode : 'eat';
        const m = MODES[mode];
        const person = m.person ? String(meal.person || '') : '';
        if (m.person && !/^\d+$/.test(person)) throw new Error('不知道要端给谁');
        if (m.person && !this.canServePerson()) throw new Error('游戏里的 HouseholdJournal 模组还是旧版本，不会把菜端到别人面前');
        if (!/^\d+$/.test(String(meal.dish || ''))) throw new Error('那盘菜没有编号');
        const container = m.loose ? '0' : String(meal.container || '');
        if (!/^\d+$/.test(container)) throw new Error('不知道那盘菜在哪个冰箱里');
        const seq = String(Math.max(now, this.lastSeq + 1));
        this.lastSeq = Number(seq);
        this.pending.push({
            seq, at: now, actor: String(actor), dish: String(meal.dish), container, mode, person,
            personName: meal.personName || '', name: meal.name || '', pairKey: pairKey || '', what: what || '', started: false
        });
        this.writeQueue();
        this.log.info('meals: asked the mod to ' + (m.loose ? 'pick up 「' + (meal.name || meal.dish) + '」 (' + meal.dish + ')' : 'take 「' + (meal.name || meal.dish) + '」 (' + meal.dish + ') out of ' + container) +
            ' for ' + actor + ', mode ' + mode + (person ? ' to ' + person : '') + ' [' + seq + ']');
        return seq;
    }

    result(seq) {
        return this.results.get(String(seq)) || null;
    }

    // The bridge saw the task start in game; a failure after this point is told as a setback.
    markStarted(seq) {
        const p = this.pending.find((x) => x.seq === String(seq));
        if (p) p.started = true;
    }

    // The bridge stopped waiting. The mod drops the request if it has not taken the dish out yet.
    withdraw(seq) {
        const i = this.pending.findIndex((x) => x.seq === String(seq));
        if (i < 0) return;
        const p = this.pending.splice(i, 1)[0];
        this.withdrawn.push({ seq: p.seq, actor: p.actor, at: Date.now() });
        this.writeQueue();
        this.log.info('meals: withdrew request ' + p.seq + ' for 「' + (p.name || p.dish) + '」');
    }

    // A T line from the Lua log: { seq, stage, actor, dish, detail }.
    onResult(res) {
        const seq = String(res.seq || '');
        this.results.set(seq, { stage: res.stage, detail: res.detail, at: Date.now() });
        if (this.results.size > KEEP_RESULTS) this.results.delete(this.results.keys().next().value);
        const p = this.pending.find((x) => x.seq === seq);
        const label = p ? '「' + (p.name || p.dish) + '」' : res.dish;
        if (p) this.noteCarried(p, res.stage);
        if (p && !MODES[p.mode].loose && (res.stage === 'out' || res.stage === 'served') && this.d.realism) {
            this.d.realism.noteTaken(p.seq, p.dish, p.name || '', p.actor, p.mode, p.person);
        }
        if (res.stage === 'queued' || res.stage === 'out') {
            const where = p && MODES[p.mode].person ? 'going to ' + (p.personName || p.person) : 'going to the table';
            this.log.info('meals [' + seq + '] ' + label + ': ' + (res.stage === 'queued' ? (p && MODES[p.mode].loose ? 'pick-up' : 'take-out') + ' queued in game' : 'in hand, ' + where) +
                (res.detail && res.stage === 'out' && /^fallback/.test(res.detail) ? ' (' + res.detail + ', onto a table instead)' : ''));
            return;
        }
        if (res.stage === 'served') {
            if (p && servedOnTable(res.detail)) {
                this.log.warn('meals [' + seq + '] ' + label + ': could not be served to ' + (p.personName || p.person) + ' (' + res.detail + '), put on a table instead');
                if (p.pairKey) {
                    this.d.noteSetbacks(p.pairKey, [{
                        what: p.what || MODES[p.mode].purpose(p.name || '饭菜', p.personName),
                        why: '没能端到' + (p.personName || '对方') + '面前，菜先放在了餐桌上，' + (p.personName || '对方') + '得自己过去吃'
                    }]);
                }
            } else {
                this.log.info('meals [' + seq + '] ' + label + ': ' + (p ? MODES[p.mode].served : 'on the way to the table'));
            }
        } else if (res.stage === 'fail') {
            this.log.warn('meals [' + seq + '] ' + label + ' failed: ' + (res.detail || 'no reason given'));
            if (p && p.started && p.pairKey) {
                this.d.noteSetbacks(p.pairKey, [{ what: p.what || MODES[p.mode].purpose(p.name || '家庭餐'), why: reasonText(res.detail) }]);
            }
        } else {
            this.log.debug('meals [' + seq + '] ' + label + ': ' + res.stage + ' ' + (res.detail || ''));
            return;
        }
        if (p) {
            this.pending.splice(this.pending.indexOf(p), 1);
            this.writeQueue();
        }
    }

    noteCarried(p, stage) {
        const i = this.carried.findIndex((c) => c.seq === p.seq);
        if (stage === 'fail') {
            if (i >= 0) this.carried.splice(i, 1);
            return;
        }
        if (i < 0) this.carried.push({ dish: p.dish, name: p.name || p.dish, seq: p.seq, actor: p.actor, mode: p.mode, personName: p.personName || '', servedAt: 0, outSeq: 0 });
        const c = this.carried[i < 0 ? this.carried.length - 1 : i];
        if ((stage === 'out' || stage === 'served') && !c.outSeq) c.outSeq = this.d.journal ? this.d.journal.storedSeq : 0;
        if (stage === 'served') c.servedAt = Date.now();
    }

    expire() {
        const now = Date.now();
        const limit = this.cfg.ack_timeout_s * 1000;
        const before = this.pending.length + this.withdrawn.length;
        this.pending = this.pending.filter((p) => {
            if (now - p.at < limit) return true;
            this.log.warn('meals: no final answer from the Lua mod for request ' + p.seq + ' after ' + this.cfg.ack_timeout_s + 's, taken off the queue');
            return false;
        });
        this.withdrawn = this.withdrawn.filter((w) => now - w.at < WITHDRAW_KEEP_MS);
        this.carried = this.carried.filter((c) => c.servedAt || this.pending.some((p) => p.seq === c.seq));
        if (this.pending.length + this.withdrawn.length !== before) this.writeQueue();
    }
}

module.exports = {
    Meals, MEAL_PREFIX, PICKER_BAG, TAKEOUT_BAG, AUTO_NEXT_BAG, EAT_PORTION_BAG, DELIVER_BAG, DELIVER_STEP, PICKUP_BAG, GIVE_FEATURE,
    MODES, CHAIN_BAGS, modeOf, reasonText, servedOnTable
};
