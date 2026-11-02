'use strict';
// Whitelisted in-game actions the texting character can take. The model only proposes
// {type, ...} objects; every field is checked against live game data before anything runs,
// and each type maps to a fixed set of game tools. Unknown types are rejected.

const { MEAL_PREFIX, PICKER_BAG, TAKEOUT_BAG, AUTO_NEXT_BAG, EAT_PORTION_BAG, MODES, modeOf, reasonText } = require('./meals');
const { isScheduledBag, scheduledNow, ScheduleBusyError } = require('./schedule');
const outfit = require('./outfit');
const objectFocus = require('./object-focus');
const { GameToolError } = require('./game');

// Taking something out of the bag. These run once: started again after the item already left
// the bag they point at an entity that no longer exists, and the cancel before each restart
// can throw away what the first run put in the hand.
const TAKE_OUT_RE = /^(AutoFind_PutDown_Inventory|GrabInventory\w*)$/;
const TAKE_OUT_START_MS = 8000;
const TAKE_OUT_BUSY_WAIT_MS = 20000;
const SELF_CACHE_MS = 6000;
// Moving a thing in or out of the bag, or picking it up: not something to do with it once held.
const BAG_MOVE_RE = /^(Put_In_Inventory|PickUp\w*|AutoFind_PutDown_Inventory|GrabInventory\w*|FM_PutDown_Inventory)$/;
const CARRIED_MENU_MS = 30 * 60 * 1000;
const LIVE_PUT = '@live';
const PUT_BAG_RE = /^(AutoFind_PutDown|PutDown\w*|MoveTo_PutDown)$/;
// How long a step done with the thing in hand gets to show it started. No restarts: the game
// either takes it or it is not something that can be done with this thing here.
const THEN_START_MS = 3000;
const FREE_HAND_MS = 5000;
const CARRIED_MENU_MAX = 12;

const ACTION_TYPES = ['go_home', 'go_to_player', 'go_to_place', 'go_together', 'interact', 'stop_current', 'emote', 'use_object'];
// The game's travel group: members follow the leader, or the whole group walks to a site.
const GROUP_TOOLS = ['zoi_group_create', 'zoi_group_get_info', 'zoi_group_follow', 'zoi_group_move_to', 'zoi_group_disband'];
const ACTION_ALIASES = { go_to_spouse: 'go_to_player', do: 'use_object' };

// Between anyone other than spouses, nothing romantic or sexual is ever offered to the model.
const ROMANCE = /(Spouse|Lover|Couple|Date_|_Date|Romance|Romantic|Flirt|Kiss|Peck|TryTo|Mood|Woohoo|Propos|Engage|Marry|Wedding|Serenade|Seduc|Sexy|Sensual|Divorce|Cheat_On|HugDance|PicturePose_Couple)/i;

function canonicalType(t) {
    return ACTION_ALIASES[t] || t;
}

// Social interactions that make no sense between family members in a text-driven context, plus
// irreversible life changes (a real divorce) that a text conversation must never trigger.
const INTERACTION_EXCLUDE = /(^Co_Skill_|_Business(_|$)|Business_|^Co_Box_Give|^Co_Errand|^Co_Namecard|^Co_Divorce|^Co_BreakUp|^Co_Break_Engagement|_Debug|Cheat)/i;

const SAME_NAME_KEEP = 3;

// What someone wanted to use is held by another person; the step never started.
class TakenError extends Error {
    constructor(holder, objectName) {
        super((holder.name || '别人') + '正在用' + (objectName || '它') + (holder.doing ? '（' + holder.doing + '）' : ''));
        this.name = 'TakenError';
        this.taken = { id: holder.id, name: holder.name || '', doing: holder.doing || '', object: objectName || '' };
    }
}

// Procedures a family text must not start: licenses, adoption, investments, cheats.
const OBJECT_SKIP_RE = /GetLicense|Adoption|Immigration|Stock|Business_Tutorial|Business_Lv|CheckBiz|Accommodation|CityTravel|Debug|DEV_|Cheat|Divorce|Woohoo|TryToHave|Proposal|Wedding/i;

// A child can tidy, eat, wash and sleep. Cooking, repairs and anything alcoholic stay off the list.
const CHILD_SKIP_RE = /Cook_|烹饪|煮|酒|Beer|Wine|Repair_|投资|股票|领养|Disinfect|Launch_Cooking|Launch_Baking|烘焙/i;

// Housework the character starts on their own, without a furniture target. The game walks
// them around the home. Child and adult bags are different rows.
const SELF_CHORES = {
    Child: ['C_Self_Basic_Vacuum_Home'],
    Teen: ['Self_Basic_Vacuum_Home'],
    YoungAdult: ['Self_Basic_Vacuum_Home'],
    Adult: ['Self_Basic_Vacuum_Home'],
    Elder: ['Self_Basic_Vacuum_Home']
};

const SELF_CHORE_NAMES = {
    Self_Basic_Vacuum_Home: '用吸尘器把家里打扫几遍',
    C_Self_Basic_Vacuum_Home: '用吸尘器把家里打扫几遍'
};

// The kinds of job a family text is made of, so the listed objects cover all of them before
// the budget goes to a second chair. First match wins.
const KIND_CLASSES = [
    ['sleep', /Sleep|睡/],
    ['wash', /Wash|Bath|Shower|Brush|洗|浴|刷牙|淋浴/],
    ['eat', /Cook|Eat|Drink|烹饪|烘焙|吃|喝/],
    ['clean', /Clean|Dump|Trash|Vacuum|Mop|打扫|清洁|垃圾|吸尘/],
    ['read', /Read|阅读/],
    ['sit', /Sit|坐/]
];

function usefulness(id, name) {
    const s = id + ' ' + name;
    if (/Clean|Dump|Wash|Vacuum|Mop|Trash|Dish|洗衣|洗碗|洗盘|打扫|清洁|清理|垃圾|吸尘/.test(s)) return 6;
    if (/Pick|Take|Put_In|Inventory|Keeping|拿|取|放进|冷藏|收/.test(s)) return 5;
    if (/Cook|Eat|Drink|吃|喝|烹饪|煮|热/.test(s)) return 4;
    if (/Sleep|Sit|Shower|Toilet|Brush|Bath|睡|坐|淋浴|洗澡|刷牙/.test(s)) return 3;
    if (/Computer_Use$|SandBox|阅读小说|学习|看书|玩电子/.test(s)) return 2;
    if (/Read|阅读|练习|玩/.test(s)) return 1;
    return 0;
}

function str(v) {
    return v === undefined || v === null ? '' : String(v).trim();
}

function idNum(v) {
    if (v && typeof v === 'object') {
        if (v.value !== undefined && v.value !== null) v = v.value;
        else if (v.Value !== undefined && v.Value !== null) v = v.Value;
        else return 0;
    }
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// Already inside the pocket. Offering "put in bag" again makes the character
// do the opposite of taking something out.
function pocketStaysInBag(action) {
    const id = action && action.id;
    return id === 'Put_In_Inventory' || id === 'GrabInventoryObjectInteractionBag' || id === 'GrabInventoryCanInteractionBag' || (action && action.name === '放进包里');
}

function pocketTakeOut(action) {
    const id = action && action.id;
    return id === 'AutoFind_PutDown_Inventory' || id === 'GrabInventoryObjectInteractionBag';
}

// at: metres; o: world centimetres. Null when the object has no known place.
function metersBetween(at, o) {
    if (!at || !o || typeof o.x !== 'number' || typeof o.y !== 'number') return null;
    const dx = o.x / 100 - at.x;
    const dy = o.y / 100 - at.y;
    return Math.max(1, Math.round(Math.sqrt(dx * dx + dy * dy)));
}

function safeJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
}

// Eat consumes the portion. Cooking opens the recipe screen; the player picks the dish.
function cookRank(id) {
    const bag = String(id || '');
    if (/Baking|Only_HHB|HHB/.test(bag)) return 0;
    if (bag === 'Launch_Cooking_Craft_UI') return 5;
    if (/StartKitchenRange/.test(bag)) return 4;
    if (/Launch_Cooking/.test(bag)) return 3;
    return 0;
}

function actionKind(id, name) {
    const bag = String(id || '');
    const label = String(name || '');
    const s = bag + ' ' + label;
    if (cookRank(bag) > 0) return 'cook';
    // The cleaning panel's vacuum is the floor job: sweep and mop. It is the
    // interaction on the vacuum object, not the self bag the game drops.
    if (/BasicVC|Mopping_Home|吸尘器/.test(s)) return 'floor';
    if (/^Eat_|^Drink_|Ghost_Eat|OnlyStand|站着吃/.test(s) || /^吃|^喝/.test(label)) return 'eat';
    if (/Clean|Dump|Wash|Vacuum|Mop|Trash|Dish|洗衣|洗碗|洗盘|打扫|清洁|清理|垃圾|吸尘/.test(s)) return 'clean';
    return 'other';
}

function kindOf(step) {
    if (!step) return 'other';
    if (step.kind) return step.kind;
    if (step.type !== 'use_object') return 'other';
    const it = step.interaction || {};
    return actionKind(it.id, it.name);
}

function floorRank(id) {
    const bag = String(id || '');
    if (/BasicVC_Home/.test(bag)) return 5;
    if (/BasicVC/.test(bag)) return 4;
    if (/Mopping_Home/.test(bag)) return 3;
    return 0;
}

function isPhysicalStep(step) {
    return step.type === 'use_object' || step.type === 'interact' || step.type === 'go_home' || step.type === 'go_to_player' || step.type === 'go_to_place' || step.type === 'go_together';
}

// "放到门口那张桌子旁边", "吃苹果": what is done with a thing once it is in the hand.
function placeText(place) {
    if (!place) return '';
    if (place.label) return place.label;
    if (!place.targetId) return '就近放下';
    const at = (place.room ? place.room + '的' : '') + place.targetName;
    return place.relation === 'on' ? '放到' + at + '上' : '放到' + at + '旁边';
}

function placeBags(place) {
    const out = [];
    for (const t of (place && place.tries) || []) {
        if (t.bagId === LIVE_PUT) {
            for (const b of ['PutDown', 'PutDown_Surface', 'PutDown_Target', 'MoveTo_PutDown', 'ClickMove', 'PutDown_Floor']) if (out.indexOf(b) < 0) out.push(b);
        } else if (out.indexOf(t.bagId) < 0) {
            out.push(t.bagId);
        }
    }
    return out;
}

function fromPocket(step) {
    const it = step && step.interaction;
    return !!(it && (it.pocket || it.then || it.id === 'AutoFind_PutDown_Inventory' || it.id === 'GrabInventoryObjectInteractionBag'));
}

// What happens to a thing once it is out of the bag or picked up: one of its own menu actions
// (eat it, water with it), set down on or beside a piece of furniture, or set down where the
// character stands. The last way is always there, so nothing is left in an idle hand for the
// game to put back.
function useThen(action, itemId, itemName) {
    return {
        relation: 'use',
        label: action.name + itemName,
        targetId: '',
        targetName: '',
        room: '',
        tries: [{ bagId: action.id, targetId: String(itemId), hand: true }, { bagId: 'AutoFind_PutDown', targetId: String(itemId), hand: true }]
    };
}

// Putting it on or by a piece of furniture is whatever that furniture offers to a full hand,
// read live once the thing is held (bagId '@live'). What it does not offer cannot be done
// there, and the thing is set down where the character stands instead.
function placeThen(relation, target, itemId) {
    const tries = [];
    if (target) tries.push({ bagId: LIVE_PUT, targetId: String(target.id), relation: relation === 'on' ? 'on' : 'near' });
    tries.push({ bagId: 'AutoFind_PutDown', targetId: String(itemId || ''), hand: true });
    return {
        relation: target ? (relation === 'on' ? 'on' : 'near') : 'here',
        targetId: target ? String(target.id) : '',
        targetName: target ? target.name : '',
        room: target && target.room ? target.room : '',
        tries: tries
    };
}

// The model decides what to do and whether it can wait. This only splits that list into the
// step that has to start now and the steps the follower starts later: the game drops a queue.
function arrangePlan(steps, ctx) {
    const c = ctx || {};
    const notes = [];
    const list = Array.isArray(steps) ? steps : [];
    const busy = !!(c.activity && !c.activity.idle);
    let interrupt = false;
    let wrapUpS = 0;
    const kept = [];
    for (let i = 0; i < list.length; i++) {
        const step = list[i];
        if (!step || !step.type) continue;
        // "Keep at it for N more seconds, then stop" only means something before any other step.
        if (step.type === 'stop_current' && step.afterS > 0 && busy && !kept.length && !wrapUpS) {
            wrapUpS = step.afterS;
            continue;
        }
        if (step.type === 'stop_current') interrupt = true;
        // Taking something out of the bag does not wait for the TV, but never cuts off a take-out
        // already under way: that one is waited for, the step itself then checks the bag again.
        if (fromPocket(step) && !(busy && TAKE_OUT_RE.test(String(c.activity.id || '')))) interrupt = true;
        const kind = kindOf(step);
        if (!step.kind && kind !== 'other') step.kind = kind;
        kept.push(step);
    }
    if (!kept.length) return { now: [], later: [], wait: false, notes: notes };
    if (busy && c.activity.scheduled) {
        const later = kept.filter((s) => s.type !== 'stop_current');
        notes.push('the game timetable holds the character (' + c.activity.id + '), ' + (interrupt || wrapUpS ? 'not stopping it; ' : '') +
            'everything waits until the game ends it');
        return { now: [], later: later, wait: true, untilScheduleEnds: true, notes: notes };
    }
    if (c.carrying) {
        const later = kept.filter((s) => s.type !== 'stop_current');
        notes.push('a family meal is in hand on its way to the table, ' + (interrupt ? 'not stopping it; ' : '') + 'everything waits until it is put down');
        return { now: [], later: later, wait: true, notes: notes };
    }
    if (busy && !interrupt) {
        if (wrapUpS) {
            notes.push('model keeps the current action for about ' + wrapUpS + 's, then puts it down');
            return { now: [], later: kept, wait: true, waitMs: wrapUpS * 1000, notes: notes };
        }
        notes.push('model left the current action running until it ends by itself' + (c.activity && c.activity.id ? ' (' + c.activity.id + ')' : ''));
        return { now: [], later: kept, wait: true, notes: notes };
    }
    const immediate = [];
    const follow = [];
    let seenPhysical = false;
    for (let i = 0; i < kept.length; i++) {
        if (!seenPhysical) {
            immediate.push(kept[i]);
            if (isPhysicalStep(kept[i])) seenPhysical = true;
        } else {
            follow.push(kept[i]);
        }
    }
    if (interrupt) notes.push('model stopped the current action');
    return { now: immediate, later: follow, wait: false, notes: notes };
}

const TASK_GUARD_MS = 10000;
const TASK_GUARD_POLL_MS = 500;
const TASK_GUARD_START_GRACE_MS = 1500;
// An action that has not played once after this many restarts is given up, so the steps planned
// after it are not held up behind it (a hand-over that never starts used to block a meal ~12s).
const TASK_NEVER_STARTED_RESTARTS = 2;
// A cancelled activity plays its own ending first. This is how long that ending may take.
const BODY_FREE_WAIT_MS = 4000;
// An activity animation still on the body this long into the walk is holding it in place.
const BODY_LOCK_CONFIRM_MS = 1500;
// Most seconds the model may keep at the current activity before turning to the next step.
const WRAP_UP_MAX_S = 600;

// Animations that belong to an activity (playing, eating, using something). Walking, standing
// and carrying use locomotion or posture montages, and the game marks the ones it must not cut.
function activityMontages(motion) {
    const list = (motion && Array.isArray(motion.motions)) ? motion.motions : [];
    return list.filter((m) => m && !m.non_interruptible && /Interaction_Montage/i.test(str(m.montage_id)));
}

function isWalking(cur) {
    return !!(cur && cur.playing && /Walk|Run|Move/i.test(str(cur.action_type)));
}

function wrapUpSeconds(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.min(Math.round(n), WRAP_UP_MAX_S);
}

function samePlaying(cur, bagId, targetId) {
    if (!cur || !cur.playing) return false;
    if (bagId && cur.interaction_bag_id === bagId) return true;
    if (targetId && String(cur.target_entity_id) === String(targetId)) return true;
    // Opening the cooking screen replaces the bag id. It is still the cook the model asked for.
    const asked = String(bagId || '');
    const nowBag = String(cur.interaction_bag_id || '');
    const nowType = String(cur.action_type || '');
    if (/Launch_Cooking|LaunchCraft/.test(asked) && /Launch_Cooking|LaunchCraft/.test(nowBag + ' ' + nowType)) return true;
    return false;
}

// ok: the task is the current action. starting: a fresh execute still needs a moment to appear.
// stolen: autonomy replaced it. dropped: nothing is playing.
function taskGuardDecision(cur, bagId, targetId, now, lastExecuteAt) {
    if (samePlaying(cur, bagId, targetId)) return 'ok';
    // A failed read is not proof the task stopped. Only a real idle or another action is.
    if (!cur) return lastExecuteAt ? 'starting' : 'dropped';
    if (lastExecuteAt && now - lastExecuteAt < TASK_GUARD_START_GRACE_MS) return 'starting';
    if (cur.playing) return 'stolen';
    return 'dropped';
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// A site-wide scan of where the player is, taken at most this often while nobody needs one.
const SITE_REFRESH_MS = 2 * 60000;
// One reply reads the lot several times (catalog, scene, want); a scan this fresh is reused.
const SCAN_REUSE_MS = 5000;
// What the game offers on one kind of object for one age group. Furniture does not change;
// food changes with every bite, so food is read per dish and kept only briefly.
const CAP_KEEP_MS = 10 * 60000;
const CAP_FOOD_KEEP_MS = 60000;
const CAP_NAMES_LISTED = 10;
const CAP_PARALLEL = 6;

class Actions {
    // siteMemory (optional): lib/sitememory.js, so people away from the player can still use
    // what is at their own site.
    constructor(game, world, log, siteMemory) {
        this.game = game;
        this.world = world;
        this.log = log;
        this.siteMemory = siteMemory || null;
        this.siteRefreshAt = new Map();
        this.listCache = new Map();
        this.useCache = new Map();
        this.choreNames = new Map();
        this.objectNames = new Map();
        this.stepCache = new Map();
        this.lastScan = null;
        this.scanning = null;
        this.capCache = new Map();
        this.capPending = new Map();
        // (hold, cur) => Promise<boolean>: is the action now playing a later step of the held task?
        this.judge = null;
        // (objectId) => { spoiled, empty, left } | null, from the HouseholdJournal Lua mod.
        this.foodState = null;
        // lib/meals.js: family meals in the fridge, taken out by the HouseholdJournal Lua mod.
        this.meals = null;
        this.realism = null;
        // async (snap) -> (objectId -> room name) or null; set by the daemon.
        this.roomsFor = null;
        // Travel groups this bridge put someone into: memberId -> { player, at, place, lead, made }.
        this.groups = new Map();
        // () => void; the daemon keeps the groups in its state so a restart can still end them.
        this.onGroupsChanged = null;
        this.groupShapeLogged = false;
    }

    async interactionsFor(actorId, targetId, limit, romanceAllowed) {
        const key = actorId + '>' + targetId + (romanceAllowed ? ':r' : '');
        const hit = this.listCache.get(key);
        if (hit && Date.now() - hit.at < 60000) return hit.value;
        const r = await this.game.soft('interaction_list_available', { entity_id: String(actorId), target_entity_id: String(targetId) });
        const raw = (r && r.interactions) || [];
        const seen = new Set();
        const list = [];
        for (const it of raw) {
            const id = str(it.interaction_bag_id);
            if (!id || it.enabled === false || seen.has(id) || INTERACTION_EXCLUDE.test(id)) continue;
            if (!romanceAllowed && ROMANCE.test(id)) continue;
            seen.add(id);
            list.push({ id, name: str(it.display_name) || id, hint: str(it.hint) });
            if (list.length >= limit) break;
        }
        this.listCache.set(key, { at: Date.now(), value: list });
        return list;
    }

    // Everything the model may choose from for this reply.
    async catalog(pair, snap, cfg) {
        const allowed = new Set((cfg.allowed || []).map(canonicalType).filter((t) => ACTION_TYPES.indexOf(t) >= 0));
        if (!cfg.enabled) allowed.clear();
        // Already side by side, going to them would do nothing; offered anyway, the model takes it
        // for "coming over to eat" and the character ends up standing still.
        if (snap.together) allowed.delete('go_to_player');
        const limit = cfg.max_interactions_listed || 60;
        const out = { allowed, player: [], members: {}, places: [], facial: [], chores: [], objects: [], more: [], sameSite: false, objectSource: '', objectSite: '', scannedAt: 0, pocketEmpty: false, handEmpty: false };
        if (!allowed.size) return out;
        const tasks = [];
        if (allowed.has('interact')) {
            tasks.push(this.interactionsFor(pair.partnerId, pair.playerId, limit, pair.role === 'spouse').then((l) => { out.player = l; }));
            for (const m of snap.others) {
                tasks.push(this.interactionsFor(pair.partnerId, m.id, Math.min(limit, 30), false).then((l) => { out.members[m.id] = l; }));
            }
        }
        if (allowed.has('go_to_place') || allowed.has('go_home') || allowed.has('go_to_player') || allowed.has('interact')) {
            tasks.push(this.world.sites().then((s) => { out.places = s.list.map((p) => ({ id: p.id, name: p.name })); }));
        }
        if (allowed.has('emote')) {
            tasks.push(this.world.facialIds().then((f) => { out.facial = f; }));
        }
        if (allowed.has('use_object')) {
            tasks.push(this.gatherUse(pair, snap, cfg).then((u) => {
                out.chores = u.chores;
                out.objects = u.objects;
                out.more = u.more;
                out.sameSite = u.sameSite;
                out.objectSource = u.objectSource;
                out.objectSite = u.objectSite;
                out.scannedAt = u.scannedAt;
                out.pocketEmpty = !!u.pocketEmpty;
                out.handEmpty = !!u.handEmpty;
            }));
        }
        await Promise.all(tasks);
        return out;
    }

    // The character's own pocket. These entities are not site objects, so a room scan
    // never sees them and entity_get_object_info reports them as missing.
    async pocketObjects(actorId, ageGroup) {
        const actor = idNum(actorId);
        if (!actor) return { items: [], read: false };
        const key = 'pocket:' + actor;
        const hit = this.listCache.get(key);
        if (hit && Date.now() - hit.at < 8000) return hit.value;
        const blank = { items: [], read: false };
        try {
            const who = await this.game.soft('entity_reflect', { entity_id: String(actor) });
            const invId = idNum(who && who.inventoryEntityId);
            if (!invId) {
                this.listCache.set(key, { at: Date.now(), value: blank });
                return blank;
            }
            const inv = await this.game.soft('entity_reflect', { entity_id: String(invId) });
            const dt = str(inv && inv.inventoryDtId);
            if (!inv || (dt && dt !== 'Pocket')) {
                this.listCache.set(key, { at: Date.now(), value: blank });
                return blank;
            }
            const owned = Array.isArray(inv.ownedEntityIds) ? inv.ownedEntityIds : [];
            const ids = [];
            for (let i = 0; i < owned.length && ids.length < 12; i++) {
                const id = idNum(owned[i]);
                if (id && ids.indexOf(id) < 0) ids.push(id);
            }
            const items = [];
            const cur = ids.length ? await this.currentOf(actor) : null;
            const takingOut = cur && cur.playing && TAKE_OUT_RE.test(str(cur.interaction_bag_id)) ? idNum(cur.target_entity_id) : 0;
            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                const props = await this.game.soft('entity_reflect', { entity_id: String(id) });
                if (!props) continue;
                const tableId = str(props.objectTableId);
                if (!tableId || tableId === 'None') continue;
                let name = '';
                try { name = await this.world.foodName(tableId); } catch (e) { name = ''; }
                if (!name) name = tableId;
                let then = [];
                try {
                    then = await this.carriedMenu(tableId, ageGroup);
                } catch (e) {
                    if (e && e.name === 'GameOfflineError') throw e;
                    then = [];
                }
                if (takingOut && takingOut === id) {
                    items.push({ id: String(id), name: name, meters: null, state: '正在从背包里拿出来', pocket: true, actions: [] });
                    continue;
                }
                let actions = [];
                try {
                    actions = await this.objectActions(actor, id, ageGroup, 4);
                } catch (e) {
                    if (e && e.name === 'GameOfflineError') throw e;
                    actions = [];
                }
                actions = actions.filter((a) => !pocketStaysInBag(a) && a.id !== 'AutoFind_PutDown' && a.id !== 'PutDown');
                let take = null;
                for (let j = 0; j < actions.length; j++) {
                    if (!pocketTakeOut(actions[j])) continue;
                    actions[j].pocket = true;
                    take = actions[j];
                }
                // The pie menu on an item already in the bag only offers "put in bag".
                // Taking it out is a separate interaction the menu does not list.
                if (!take) {
                    actions.unshift({
                        id: 'AutoFind_PutDown_Inventory',
                        name: '取出',
                        hint: '从背包里拿出来',
                        kind: 'other',
                        pocket: true
                    });
                }
                // What the thing offers once in the hand, from the game's own menu for it. Picking
                // one of these takes the thing out first and does it right after.
                const have = new Set(actions.map((a) => a.id));
                for (const t of then) {
                    if (have.has(t.id)) continue;
                    have.add(t.id);
                    actions.push({ id: t.id, name: t.name, hint: '', kind: t.kind, then: true });
                }
                items.push({
                    id: String(id),
                    name: name,
                    tableId: tableId,
                    meters: null,
                    state: '在背包里',
                    pocket: true,
                    actions: actions
                });
            }
            const value = { items: items, read: true };
            this.listCache.set(key, { at: Date.now(), value: value });
            this.log.info('pocket of ' + actor + ': ' + (items.length ? items.map((o) => o.id + ' ' + o.name + ' [' + o.actions.map((a) => a.id).join(',') + ']').join(', ') : 'empty'));
            return value;
        } catch (e) {
            if (e && e.name === 'GameOfflineError') throw e;
            this.log.debug('pocket of ' + actor + ' unreadable: ' + (e && e.message || e));
            return blank;
        }
    }

    // Pocket contents and the thing in the hand travel with the person, so they are merged on
    // every read and kept out of the 15s room cache.
    async withPocket(actorId, ageGroup, value, cfg) {
        const pocket = await this.pocketObjects(actorId, ageGroup);
        let hand = { read: false, item: null };
        try {
            hand = await this.heldObject(actorId, ageGroup);
        } catch (e) {
            if (e && e.name === 'GameOfflineError') throw e;
        }
        const handId = hand.item ? String(hand.item.id) : '';
        const own = (hand.item ? [hand.item] : []).concat(pocket.items.filter((o) => String(o.id) !== handId));
        // The listing already respects its own budget; the hand and the pocket are extra facts,
        // not a reason to drop a kind it picked. Cutting here used to throw away the last line
        // of the list, which is where a bed or a washing machine ends up after ranking.
        const cap = (cfg && (cfg.max_object_types || cfg.max_objects_listed)) || 18;
        const have = new Set(own.map((o) => String(o.id)));
        const world = (value.objects || []).filter((o) => o && !o.pocket && !o.held && !have.has(String(o.id)));
        return Object.assign({}, value, {
            objects: own.concat(world).slice(0, cap + 1 + own.length),
            pocketEmpty: !!(pocket.read && pocket.items.length === 0),
            handEmpty: !!(hand.read && !hand.item)
        });
    }

    // The game's own menu for a kind of object (Object -> ObjectTemplate -> ObjectSelectionSet),
    // minus the bag moves themselves. This is what the thing offers once it is in the hand,
    // read before it is taken out so the next step can be queued with the take.
    async carriedMenu(tableId, ageGroup) {
        const table = str(tableId);
        if (!table || table === 'None') return [];
        if (!this.menuCache) this.menuCache = new Map();
        const key = table + ':' + (ageGroup || '');
        const hit = this.menuCache.get(key);
        if (hit && Date.now() - hit.at < CARRIED_MENU_MS) return hit.value;
        const obj = await this.game.soft('data_table_get', { Alias: 'Object', Row: table });
        const tplId = str(obj && obj.objectTemplateId);
        const tpl = tplId && tplId !== 'None' ? await this.game.soft('data_table_get', { Alias: 'ObjectTemplate', Row: tplId }) : null;
        const setId = tpl && str(tpl.objectSelectionSetId) && str(tpl.objectSelectionSetId) !== 'None' ? str(tpl.objectSelectionSetId) : table;
        const set = await this.game.soft('data_table_get', { Alias: 'ObjectSelectionSet', Row: setId });
        const ids = [];
        for (const s of (set && Array.isArray(set.selectionSets)) ? set.selectionSets : []) {
            for (const b of Array.isArray(s && s.interactionBagList) ? s.interactionBagList : []) {
                const id = str(b);
                if (!id || id === 'None' || ids.indexOf(id) >= 0) continue;
                if (BAG_MOVE_RE.test(id) || INTERACTION_EXCLUDE.test(id) || OBJECT_SKIP_RE.test(id) || ROMANCE.test(id)) continue;
                ids.push(id);
            }
        }
        const value = [];
        for (const id of ids.slice(0, CARRIED_MENU_MAX)) {
            let name = '';
            try { name = await this.world.interactionName(id); } catch (e) { name = ''; }
            if (!name) name = id;
            if (/骗取|作弊|调试/.test(name)) continue;
            if (ageGroup === 'Child' && CHILD_SKIP_RE.test(id + ' ' + name)) continue;
            value.push({ id: id, name: name, kind: actionKind(id, name) });
        }
        this.menuCache.set(key, { at: Date.now(), value: value });
        return value;
    }

    // Entity ids in the bag, read from the game now. read=false when the game did not answer.
    async pocketIds(actorId) {
        const actor = idNum(actorId);
        if (!actor) return { ids: [], read: false };
        const who = await this.game.soft('entity_reflect', { entity_id: String(actor) });
        if (!who) return { ids: [], read: false };
        const invId = idNum(who.inventoryEntityId);
        if (!invId) return { ids: [], read: true };
        const inv = await this.game.soft('entity_reflect', { entity_id: String(invId) });
        if (!inv) return { ids: [], read: false };
        const owned = Array.isArray(inv.ownedEntityIds) ? inv.ownedEntityIds : [];
        return { ids: owned.map(idNum).filter((n) => n > 0), read: true };
    }

    // true / false, or null when the bag could not be read.
    async inPocket(actorId, itemId) {
        const p = await this.pocketIds(actorId);
        if (!p.read) return null;
        return p.ids.indexOf(idNum(itemId)) >= 0;
    }

    forgetPocket(actorId) {
        const actor = idNum(actorId);
        this.listCache.delete('pocket:' + actor);
        this.listCache.delete('hand:' + actor);
        this.listCache.delete('self:' + actor);
        // What tables and shelves offer changes with what is in the hand.
        for (const key of Array.from(this.listCache.keys())) {
            if (key.indexOf('obj:' + actor + '>') === 0) this.listCache.delete(key);
        }
        this.useCache.clear();
    }

    // The thing in the character's hands (usingCarriableObject), listed with what can be done
    // with it now: put it down, put it back in the bag, hand it over.
    async heldObject(actorId, ageGroup) {
        const actor = idNum(actorId);
        if (!actor) return { read: false, item: null };
        const key = 'hand:' + actor;
        const hit = this.listCache.get(key);
        if (hit && Date.now() - hit.at < SELF_CACHE_MS) return hit.value;
        const who = await this.game.soft('entity_reflect', { entity_id: String(actor) });
        if (!who) return { read: false, item: null };
        const id = idNum(who.usingCarriableObject);
        let value = { read: true, item: null };
        if (id) {
            const props = await this.game.soft('entity_reflect', { entity_id: String(id) });
            const tableId = str(props && props.objectTableId);
            let name = '';
            if (tableId && tableId !== 'None') {
                try { name = await this.world.foodName(tableId); } catch (e) { name = ''; }
            }
            if (!name) name = tableId && tableId !== 'None' ? tableId : '一样东西';
            let actions = [];
            try {
                actions = await this.freshObjectActions(actor, id, ageGroup);
            } catch (e) {
                if (e && e.name === 'GameOfflineError') throw e;
                actions = [];
            }
            actions = actions.filter((a) => !TAKE_OUT_RE.test(a.id)).slice(0, 8);
            value = {
                read: true,
                item: { id: String(id), name: name, meters: 0, state: '拿在你手上', held: true, carried: true, actions: actions }
            };
            this.log.info('hand of ' + actor + ': ' + id + ' ' + name + ' [' + actions.map((a) => a.id).join(',') + ']');
        }
        this.listCache.set(key, { at: Date.now(), value: value });
        return value;
    }

    // What the character knows about their own body: hands, clothes, bag.
    async selfState(actorId, ageGroup) {
        const actor = idNum(actorId);
        if (!actor) return null;
        const key = 'self:' + actor;
        const hit = this.listCache.get(key);
        if (hit && Date.now() - hit.at < SELF_CACHE_MS) return hit.value;
        const [hand, pocket, cat, gar] = await Promise.all([
            this.heldObject(actor, ageGroup).catch((e) => {
                if (e && e.name === 'GameOfflineError') throw e;
                return { read: false, item: null };
            }),
            this.pocketObjects(actor, ageGroup),
            this.game.soft('appearance_get_outfit_category', { entity_id: String(actor) }),
            this.game.soft('appearance_scan_garments', { entity_id: String(actor) })
        ]);
        const wear = cat || gar ? outfit.describe(cat, gar) : null;
        const value = {
            handRead: !!hand.read,
            held: hand.item ? { id: hand.item.id, name: hand.item.name } : null,
            pocketRead: !!pocket.read,
            pocket: pocket.items.filter((o) => !hand.item || String(o.id) !== String(hand.item.id)).map((o) => o.name),
            outfit: wear && wear.text ? wear.text : '',
            barefoot: !!(wear && wear.barefoot)
        };
        this.listCache.set(key, { at: Date.now(), value: value });
        return value;
    }

    // Takes one thing out of the bag, once. The step is checked against the bag as it is now:
    // an item that already left it (an earlier step took it out) is not taken out again.
    async takeOut(actorId, step, who) {
        const itemName = step.objectName || '东西';
        // A menu action chosen on a thing still in the bag: take it out, then do that.
        if (step.interaction.then) {
            if (!step.after) step.after = useThen(step.interaction, step.objectId, itemName);
            step.interaction = { id: 'AutoFind_PutDown_Inventory', name: '取出', kind: 'other', pocket: true };
        }
        if (!step.after) step.after = placeThen('here', null, step.objectId);
        const after = step.after;
        const bagId = step.interaction.id;
        const busyUntil = Date.now() + TAKE_OUT_BUSY_WAIT_MS;
        let cur = await this.currentOf(actorId);
        while (cur && cur.playing && TAKE_OUT_RE.test(str(cur.interaction_bag_id)) && Date.now() < busyUntil) {
            await sleep(1000);
            cur = await this.currentOf(actorId);
        }
        const there = await this.inPocket(actorId, step.objectId);
        if (there === null) throw new Error('读不到背包');
        if (!there) {
            this.forgetPocket(actorId);
            const hand = await this.heldObject(actorId, '');
            this.log.info('take out ' + step.objectId + ' ' + itemName + ': no longer in the bag' +
                (hand.item ? ', hand holds ' + hand.item.id + ' ' + hand.item.name : '') + ', not running it again');
            return { ok: true, skipped: true, gone: true, note: itemName + '已经不在包里' + (hand.item ? '，手上拿着' + hand.item.name : '') };
        }
        const hand = await this.heldObject(actorId, '');
        if (hand.item && !(await this.freeHand(actorId, hand))) {
            throw new Error('手上拿着' + hand.item.name + '，放不下来，没法再从包里拿东西');
        }
        if (hand.item) cur = await this.currentOf(actorId);
        if (cur && cur.playing) await this.preempt(actorId);
        await this.game.call('interaction_execute', {
            entity_id: String(actorId),
            interaction_bag_id: bagId,
            target_entity_id: String(step.objectId),
            insert_front: true
        });
        await this.queueAfter(actorId, after, 0);
        const startedAt = Date.now();
        let seen = false;
        let left = false;
        while (Date.now() - startedAt < TAKE_OUT_START_MS) {
            await sleep(500);
            const now = await this.currentOf(actorId);
            if (now && now.playing && (TAKE_OUT_RE.test(str(now.interaction_bag_id)) || str(now.target_entity_id) === str(step.objectId))) seen = true;
            if (await this.inPocket(actorId, step.objectId) === false) {
                left = true;
                break;
            }
            if (seen) break;
        }
        this.forgetPocket(actorId);
        if (!seen && !left) {
            await this.game.soft('interaction_clear_queue', { entity_id: String(actorId), cancel_current: false });
            throw new Error('游戏没有开始从包里拿' + itemName);
        }
        const where = placeText(after);
        return {
            ok: true,
            note: '正在从包里拿出' + itemName + (where ? '，接着' + where : ''),
            toast: who + '：取出' + itemName,
            hold: {
                bagId: bagId,
                targetId: String(step.objectId),
                startedAt: startedAt,
                confirmUntil: Date.now(),
                noRetake: true,
                pocketItem: String(step.objectId),
                after: after,
                afterTry: 0,
                related: ['GrabInventoryObjectInteraction', 'GrabInventoryObjectInteractionBag', 'AutoFind_PutDown_Inventory'].concat(placeBags(after))
            }
        };
    }

    // The next step queued behind the take, so no gap is left for the game to fill. A put-down
    // on furniture is not queued: what the furniture offers is only known once the hand is full.
    async queueAfter(actorId, after, index) {
        const t = after && after.tries && after.tries[index];
        if (!t || t.bagId === LIVE_PUT) return false;
        const args = { entity_id: String(actorId), interaction_bag_id: t.bagId, insert_front: false };
        if (t.targetId) args.target_entity_id = t.targetId;
        const r = await this.game.soft('interaction_execute', args);
        this.log.info('then queued for ' + actorId + ': ' + t.bagId + (t.targetId ? ' @' + t.targetId : '') + (r ? '' : ' (the game did not take it)'));
        return !!r;
    }

    // Does the next step with what is in the hand now (handId), trying its ways in order from
    // index. Each way is started once and given THEN_START_MS to show; nothing is cancelled or
    // restarted, so the thing in the hand is never knocked out of it by the bridge.
    // { ok, index, bagId, refused:[text], hold } or { ok:false, index:-1, refused }.
    async runAfterNow(actorId, after, index, itemName, handId) {
        const tries = (after && after.tries) || [];
        const refused = [];
        for (let i = index; i < tries.length; i++) {
            const t = tries[i];
            let bagId = t.bagId;
            let targetId = t.hand && handId ? String(handId) : (t.targetId || '');
            if (bagId === LIVE_PUT) {
                const offered = await this.game.soft('interaction_list_available', { entity_id: String(actorId), target_entity_id: String(t.targetId) });
                const list = (offered && offered.interactions) || [];
                const put = list.find((x) => x && x.enabled !== false && PUT_BAG_RE.test(str(x.interaction_bag_id))) ||
                    list.find((x) => x && x.enabled !== false && /放/.test(str(x.display_name)) && !/放进|装进/.test(str(x.display_name)));
                this.log.info('then: ' + t.targetId + ' offers ' + (list.length ? list.map((x) => str(x.interaction_bag_id)).join(',') : 'nothing') + ' to a hand holding ' + itemName);
                if (!put) {
                    refused.push(after.targetName ? after.targetName + '那里游戏不让放' : '那里游戏不让放');
                    continue;
                }
                bagId = str(put.interaction_bag_id);
                targetId = String(t.targetId);
            }
            const args = { entity_id: String(actorId), interaction_bag_id: bagId, insert_front: true };
            if (targetId) args.target_entity_id = targetId;
            const r = await this.game.soft('interaction_execute', args);
            if (!r) {
                this.log.info('then ' + bagId + (targetId ? ' @' + targetId : '') + ' for ' + itemName + ': the game did not take it');
                refused.push('游戏没接「' + bagId + '」');
                continue;
            }
            const startedAt = Date.now();
            let shown = false;
            while (Date.now() - startedAt < THEN_START_MS) {
                await sleep(400);
                const cur = await this.currentOf(actorId);
                if (cur && cur.playing && (str(cur.interaction_bag_id) === bagId || PUT_BAG_RE.test(str(cur.interaction_bag_id)))) {
                    shown = true;
                    break;
                }
                const hand = await this.game.soft('entity_reflect', { entity_id: String(actorId) });
                if (hand && idNum(hand.usingCarriableObject) !== idNum(handId)) {
                    shown = true;
                    break;
                }
            }
            if (!shown) {
                this.log.info('then ' + bagId + (targetId ? ' @' + targetId : '') + ' for ' + itemName + ' did not start within ' + THEN_START_MS + 'ms');
                refused.push('「' + bagId + '」没开始');
                continue;
            }
            this.log.info('then ' + bagId + (targetId ? ' @' + targetId : '') + ' started for ' + itemName);
            return {
                ok: true,
                index: i,
                bagId: bagId,
                refused: refused,
                hold: { bagId: bagId, targetId: targetId, startedAt: startedAt, confirmUntil: Date.now(), noRetake: true }
            };
        }
        return { ok: false, index: -1, refused: refused, hold: null };
    }

    // Something the game itself put in the hand (a snack, a book) is set down first, so the
    // thing asked for can be taken. true when the hand is free.
    async freeHand(actorId, hand) {
        if (!hand || !hand.item) return true;
        const r = await this.game.soft('interaction_execute', {
            entity_id: String(actorId),
            interaction_bag_id: 'AutoFind_PutDown',
            target_entity_id: String(hand.item.id),
            insert_front: true
        });
        if (!r) return false;
        const until = Date.now() + FREE_HAND_MS;
        while (Date.now() < until) {
            await sleep(500);
            const who = await this.game.soft('entity_reflect', { entity_id: String(actorId) });
            if (who && !idNum(who.usingCarriableObject)) {
                this.log.info('hand of ' + actorId + ': set down ' + hand.item.name + ' first');
                this.listCache.delete('hand:' + idNum(actorId));
                return true;
            }
        }
        return false;
    }

    // What this person can do to the things around them. The game scans only the site of the
    // character being played: at the player's site that scan is used live; anywhere else the
    // last scan of the person's own site is used, and every action on it is still read live.
    async gatherUse(pair, snap, cfg) {
        const actor = String(pair.partnerId);
        const site = snap.partner.site || '';
        const playerSite = snap.player.site || '';
        const sameSite = !!(site && playerSite && site === playerSite);
        const key = actor + '@' + site + '@' + playerSite + '@' + (snap.partner.ageGroup || '') + '@' + String(snap.player.id || '');
        const hit = this.useCache.get(key);
        if (hit && Date.now() - hit.at < 15000) return this.withPocket(actor, snap.partner.ageGroup, hit.value, cfg);
        if (!sameSite) await this.refreshPlayerSite(pair, snap);
        // Self bags such as vacuum are accepted into the queue and then dropped, with or
        // without autonomy. Only interactions the game offers on a real object actually start.
        const chores = [];
        let objects = [];
        let more = [];
        const scope = await this.useScope(snap);
        if (scope) {
            const near = await this.nearbyObjects(actor, snap.partner.ageGroup, cfg, scope);
            objects = near.objects;
            more = near.more;
        }
        const objectSource = scope && (objects.length || more.length) ? (scope.live ? 'live' : 'memory') : '';
        // Which room each thing is in, in the words of this character ("你的卧室").
        const roomOf = scope && this.roomsFor ? await this.roomsFor(snap) : null;
        if (roomOf) {
            for (const o of objects.concat(more)) {
                const room = roomOf(o.id);
                if (room) o.room = room;
            }
        }
        const value = {
            chores,
            objects,
            more,
            sameSite,
            objectSource,
            objectSite: site,
            scannedAt: scope && scope.memory ? scope.memory.scannedAt : 0
        };
        this.useCache.set(key, { at: Date.now(), value });
        let from = 'none';
        if (scope && scope.live) from = 'live scan';
        else if (scope) from = 'memory of ' + site + ' (scanned ' + Math.round((Date.now() - scope.memory.scannedAt) / 60000) + ' min ago)';
        else if (!sameSite) from = 'none (' + await this.noMemoryReason(site) + ')';
        this.log.info('use_object catalog for ' + actor + ': ' + objects.length + ' object(s) with actions, ' + more.length + ' more by name, same place ' + (sameSite ? 'yes' : 'no') + ', objects from ' + from);
        return this.withPocket(actor, snap.partner.ageGroup, value, cfg);
    }

    // Where this person's objects come from: { live: true } at the player's site,
    // { memory } for a remembered site of their own, or null when nothing is known.
    async useScope(snap) {
        const site = snap.partner.site || '';
        const playerSite = snap.player.site || '';
        if (site && playerSite && site === playerSite) return { live: true };
        if (!site || !this.siteMemory) return null;
        const ref = await this.siteRef(site);
        if (!ref) return null;
        const memory = this.siteMemory.recall(ref.id);
        return memory ? { live: false, site: ref, memory } : null;
    }

    async noMemoryReason(site) {
        if (!site) return 'site unknown';
        if (!this.siteMemory) return 'no site memory';
        if (!(await this.siteRef(site))) return site + ' is not one unique site';
        return site + ' not scanned yet';
    }

    // The loaded site with this display name, only when the name is unique: several streets
    // share one name and must never be mistaken for each other.
    async siteRef(name) {
        const sites = await this.world.sites();
        let found = null;
        for (const s of sites.list) {
            if (s.name !== name) continue;
            if (found) return null;
            found = s;
        }
        return found;
    }

    // The site of the character being played, the only site the game can scan.
    async possessedSite() {
        const id = await this.world.possessed();
        if (!id) return null;
        const hh = await this.world.household();
        const me = (hh.members || []).find((m) => String(m.entity_id) === String(id));
        const name = me && me.current_site ? String(me.current_site) : '';
        return name ? this.siteRef(name) : null;
    }

    // Keeps the remembered list of the player's own site current while the player is there,
    // so it is ready when someone else is at that site and the player has left.
    async refreshPlayerSite(pair, snap) {
        if (!this.siteMemory || !snap.player.site) return;
        const ref = await this.siteRef(snap.player.site);
        if (ref) await this.refreshSite(ref);
    }

    // Background upkeep: the site of whoever is being played, so a home is known even when
    // nobody texted while the player was there.
    async rememberPlayedSite() {
        if (!this.siteMemory) return;
        const ref = await this.possessedSite();
        if (ref) await this.refreshSite(ref);
    }

    async refreshSite(ref) {
        const last = this.siteRefreshAt.get(ref.id) || 0;
        if (Date.now() - last < SITE_REFRESH_MS) return;
        this.siteRefreshAt.set(ref.id, Date.now());
        await this.scanSite();
    }

    // Every placed object at the played character's site, named, in world centimetres.
    // The catalog and the household scene ask for it within the same moment; one scan serves both.
    scanSite(maxAgeMs) {
        const age = typeof maxAgeMs === 'number' ? maxAgeMs : SCAN_REUSE_MS;
        if (this.lastScan && Date.now() - this.lastScan.at < age) return Promise.resolve(this.lastScan.rows);
        if (this.scanning) return this.scanning;
        this.scanning = this.scanSiteNow()
            .then((rows) => {
                this.lastScan = rows ? { at: Date.now(), rows } : null;
                return rows;
            })
            .finally(() => { this.scanning = null; });
        return this.scanning;
    }

    // A complete scan is also written to the site memory.
    async scanSiteNow() {
        const site = await this.game.soft('build_scan_objects', { Limit: 0 });
        const raw = (site && site.objects) || [];
        if (!raw.length) return null;
        const names = await Promise.all(raw.map((o) => this.objectName(str(o.entity_id))));
        const rows = [];
        for (let i = 0; i < raw.length; i++) {
            const id = str(raw[i].entity_id);
            if (!id || !names[i]) continue;
            const w = raw[i].world_location;
            const row = { id, name: names[i] };
            if (w && typeof w.x === 'number' && typeof w.y === 'number') {
                row.x = w.x;
                row.y = w.y;
                if (typeof w.z === 'number') row.z = w.z;
            }
            rows.push(row);
        }
        const complete = typeof site.total !== 'number' || site.total <= raw.length;
        if (this.siteMemory && complete && rows.length) {
            const ref = await this.possessedSite();
            if (ref) {
                this.siteMemory.remember(ref.id, ref.name, rows);
                this.siteRefreshAt.set(ref.id, Date.now());
            }
        }
        return rows;
    }

    async selfChores(ageGroup) {
        const ids = SELF_CHORES[ageGroup] || [];
        const out = [];
        for (const id of ids) {
            const live = await this.choreName(id);
            out.push({ id, name: live || SELF_CHORE_NAMES[id] || id });
        }
        return out;
    }

    async choreName(id) {
        const hit = this.choreNames.get(id);
        if (hit && Date.now() - hit.at < 600000) return hit.name;
        const r = await this.game.soft('interaction_search', { Keyword: id, max_results: 8 });
        const rows = (r && r.results) || [];
        const found = rows.find((x) => str(x.interaction_bag_id) === id);
        const name = found ? str(found.display_name) : '';
        this.choreNames.set(id, { at: Date.now(), name });
        return name;
    }

    // Display name of a placed object. Names do not change, so one lookup per object is enough.
    async objectName(id) {
        const hit = this.objectNames.get(id);
        if (hit !== undefined) return hit;
        const info = await this.game.soft('entity_get_object_info', { entity_id: String(id) });
        const name = str(info && (info.display_name || info.name));
        if (name) this.objectNames.set(id, name);
        return name;
    }

    // Where the person doing the work stands, in metres. The game has no direct read for a
    // character, so the object they are using stands in for them when that is all there is.
    // remembered (optional): id -> remembered object, for a site the game cannot read right now.
    async actorPoint(actorId, remembered) {
        const self = await this.game.soft('entity_get_object_info', { entity_id: String(actorId) });
        if (self && self.location && typeof self.location.x === 'number') return { at: self.location, source: 'self' };
        const cur = await this.currentOf(actorId);
        const target = cur && cur.target_entity_id ? str(cur.target_entity_id) : '';
        if (target && target !== String(actorId)) {
            const t = await this.game.soft('entity_get_object_info', { entity_id: target });
            if (t && t.location && typeof t.location.x === 'number') return { at: t.location, source: 'object in use' };
            const r = remembered ? remembered.get(target) : null;
            if (r && typeof r.x === 'number') return { at: { x: r.x / 100, y: r.y / 100 }, source: 'remembered place of the object in use' };
        }
        return null;
    }

    // Every object on this lot, nearest to the worker first. build_scan_objects covers the whole
    // lot; entity_scan_objects only sees around the character being played and is the fallback.
    // scope.memory: the remembered site of a person away from the player.
    async scanObjects(actorId, cfg, scope) {
        const rows = scope && scope.memory
            ? await this.rememberedObjects(actorId, scope.memory)
            : (await this.siteObjects(actorId)) || (await this.pawnObjects(cfg));
        rows.sort((a, b) => (a.meters === null) - (b.meters === null) || (a.meters || 0) - (b.meters || 0) || (b.useful || 0) - (a.useful || 0));
        const seenName = new Map();
        const out = [];
        for (const o of rows) {
            const n = seenName.get(o.name) || 0;
            if (n >= SAME_NAME_KEEP) continue;
            seenName.set(o.name, n + 1);
            out.push(o);
        }
        return out;
    }

    async siteObjects(actorId) {
        const scanned = await this.scanSite();
        if (!scanned) return null;
        const point = await this.actorPoint(actorId);
        const pawnMeters = new Map();
        if (!point) {
            for (const p of await this.pawnObjects({ object_radius_m: 40 })) pawnMeters.set(p.id, p.meters);
        }
        const rows = scanned.map((o) => ({
            id: o.id,
            name: o.name,
            meters: point ? metersBetween(point.at, o) : (pawnMeters.has(o.id) ? pawnMeters.get(o.id) : null)
        }));
        this.log.debug('site objects: ' + rows.length + ', distance from ' + (point ? point.source : 'the played character'));
        return rows;
    }

    // The remembered objects of a site the game cannot scan right now. Distances come from what
    // the person is using, when that object is remembered too; otherwise the most useful first.
    async rememberedObjects(actorId, memory) {
        const byId = new Map(memory.objects.map((o) => [o.id, o]));
        const point = await this.actorPoint(actorId, byId);
        const rows = memory.objects.map((o) => ({
            id: o.id,
            name: o.name,
            meters: point ? metersBetween(point.at, o) : null,
            useful: typeof o.useful === 'number' ? o.useful : 0
        }));
        this.log.debug('remembered objects of ' + memory.name + ': ' + rows.length + ', distance from ' + (point ? point.source : 'nowhere'));
        return rows;
    }

    async pawnObjects(cfg) {
        const scan = await this.game.soft('entity_scan_objects', {
            Radius: cfg.object_radius_m || 30,
            Direction: 'all',
            Cone: 180,
            ref: 'pawn',
            Limit: 100,
            sort: 'distance'
        });
        return ((scan && scan.objects) || [])
            .map((o) => ({
                id: str(o.entity_id),
                name: str(o.name),
                meters: typeof o.distance === 'number' ? Math.max(1, Math.round(o.distance)) : null
            }))
            .filter((o) => o.id && o.name);
    }

    // The nearest objects come with their actions. The rest are listed by name: the model can
    // still pick one and say what it wants, and resolveWants looks up the action in the game.
    // What a kind of thing can do, as one number: the best usefulness of anything on its menu.
    // Kept for ten minutes by name, because the same bed in the other bedroom offers the same
    // menu and reading every menu on every build is the whole cost of the catalog.
    async probeKindScore(actorId, ageGroup, list) {
        if (!this.kindScores) this.kindScores = new Map();
        const first = (list && list[0]) || {};
        const key = (ageGroup || '') + '|' + String(first.name || first.id);
        const hit = this.kindScores.get(key);
        if (hit && Date.now() - hit.at < CAP_KEEP_MS) return hit;
        const failed = [];
        for (const o of (list || []).slice(0, 3)) {
            let score = 0, count = 0;
            const names = [];
            try {
                const all = await this.allObjectActions(actorId, o.id, ageGroup);
                count = all.length;
                for (const a of all) {
                    const nm = String(a.name || a.id || '');
                    if (nm && names.indexOf(nm) < 0 && names.length < 8) names.push(nm);
                    const u = usefulness(a.id, a.name);
                    if (u > score) score = u;
                }
            } catch (e) {
                if (e.name === 'GameOfflineError') throw e;
                failed.push(o.id);
                continue;
            }
            // The instance that offers something is the one to list: the nearest bed may sit in
            // a room the character cannot reach right now, while the one upstairs works.
            if (count > 0) {
                const rec = { at: Date.now(), score, count, names, id: o.id };
                if (this.kindScores.size > 2000) this.kindScores.clear();
                this.kindScores.set(key, rec);
                return rec;
            }
        }
        const empty = { at: Date.now(), score: -1, count: 0, names: [] };
        // A menu that could not be read is not a menu without actions: caching it would hide the
        // kind for CAP_KEEP_MS after one busy or timed-out query, so only a confirmed lack is kept.
        if (failed.length) return Object.assign(empty, { failed });
        this.kindScores.set(key, empty);
        return empty;
    }

    async nearbyObjects(actorId, ageGroup, cfg, scope) {
        const perObject = cfg.max_object_actions || 12;
        const all = await this.scanObjects(actorId, cfg, scope);
        // One line per kind of thing, and the kinds are picked by what they can DO, not by how
        // close they are. A home is one open plan: the nearest twenty things are cushions, lamps,
        // doors and shrubs, while the bed is the 56th kind and the washing machine the 54th — so
        // the house's real verbs never reached the model, which could only describe them in
        // words and hope the resolver found them. Distance is kept as the tie-break, and the
        // instances that are not listed stay in 'more' by name so one can still be named.
        const cap = cfg.max_object_types || cfg.max_objects_listed || 20;
        const probeCap = Math.max(cap, cfg.max_object_probes || 80);
        const groups = new Map();
        for (const o of all) {
            const kind = String(o.name || o.id);
            let list = groups.get(kind);
            if (!list) {
                if (groups.size >= probeCap) continue;
                list = [];
                groups.set(kind, list);
            }
            if (list.length < 3) list.push(o);
        }
        const kinds = Array.from(groups.values());
        const scores = new Array(kinds.length);
        let nextKind = 0;
        const worker = async () => {
            while (nextKind < kinds.length) {
                const i = nextKind++;
                scores[i] = await this.probeKindScore(actorId, ageGroup, kinds[i]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CAP_PARALLEL, kinds.length) }, worker));
        const unread = new Set();
        for (const s of scores) for (const id of (s && s.failed) || []) unread.add(id);
        const ranked = kinds
            .map((list, i) => ({ list, s: scores[i] || { score: -1, count: 0, names: [] } }))
            // A door or a roof takes no action at all: spending a slot on it costs a real verb.
            .filter((x) => (x.s.count || 0) > 0)
            .sort((a, b) => (b.s.score - a.s.score) || ((a.list[0].meters || 0) - (b.list[0].meters || 0)));
        // One line per kind of thing worth doing, before the rest by score: a bed and a chair
        // both score the same (sleep, sit) and the chair is nearer, so on score alone a home
        // with a bed in it could be listed without any way to sleep.
        const picked = [];
        const took = new Set();
        for (const x of ranked) {
            const cls = KIND_CLASSES.find((c) => (x.s.names || []).some((n) => c[1].test(n)));
            if (!cls || took.has(cls[0])) continue;
            took.add(cls[0]);
            picked.push(x);
            if (picked.length >= cap) break;
        }
        const head = picked.concat(ranked.filter((x) => picked.indexOf(x) < 0)).slice(0, cap)
            .map((x) => ({ id: x.s.id || x.list[0].id, name: x.list[0].name, meters: x.list[0].meters }));
        const listed = await Promise.all(head.map(async (o) => {
            try {
                const actions = await this.objectActions(actorId, o.id, ageGroup, perObject);
                return actions.length ? { id: o.id, name: o.name, meters: o.meters, state: this.objectState(o.id), actions } : null;
            } catch (e) {
                if (e.name === 'GameOfflineError') throw e;
                unread.add(o.id);
                this.log.warn('object menu ' + o.id + ' ' + o.name + ' could not be read: ' + e.message);
                return null;
            }
        }));
        const objects = listed.filter(Boolean);
        if (this.meals && !(scope && scope.memory)) {
            for (const c of this.meals.carriedDishes()) {
                const at = objects.findIndex((o) => o.id === c.dish);
                const eats = at >= 0 && objects[at].actions.some((a) => a.id === EAT_PORTION_BAG);
                if (eats) continue;
                if (at >= 0) objects.splice(at, 1);
                objects.unshift(this.meals.carriedObject(c));
            }
            // A dish in hand is one more line, not a reason to drop the last kind of the house.
            while (objects.length > cap + 1) objects.pop();
        }
        const shown = new Set(objects.map((o) => o.id));
        // A scanned object with no available menu is still known to exist.
        const more = all.filter((o) => !shown.has(o.id)).map((o) => ({ id: o.id, name: o.name, meters: o.meters, state: this.objectState(o.id), error: unread.has(o.id) }));
        return { objects, more };
    }

    focusMatches(query, catalog, ageGroup) {
        return objectFocus.rank(query, Array.from(this.knownObjects(catalog).values()), (o) => {
            const key = (ageGroup || '') + '|name:' + o.name + (o.room ? '@' + o.room : '');
            const cached = this.capCache.get(key);
            return cached && Date.now() - cached.at < CAP_KEEP_MS ? cached.names : [];
        });
    }

    // Promote a few relevant objects before generating the reply. Copy the catalog: the
    // normal proximity cache is shared with scene/proactive reads and must not be reordered.
    async focusCatalog(actorId, ageGroup, catalog, matches, query, cfg) {
        const selected = matches.slice(0, objectFocus.LIMIT);
        const candidates = await Promise.all(selected.map(async (match) => {
            const o = match.object;
            try {
                const all = o.pocket || o.held || o.carried ? (o.actions || []) : await this.freshObjectActions(actorId, o.id, ageGroup);
                const actions = all.map((a, index) => ({ a, index, score: objectFocus.score(query, a.name) }))
                    .sort((a, b) => b.score - a.score || a.index - b.index)
                    .slice(0, cfg.max_object_actions || 6).map((x) => x.a);
                return Object.assign({}, o, { actions });
            } catch (e) {
                this.log.warn('focus object ' + o.id + ' ' + o.name + ': ' + e.message);
                return Object.assign({}, o, { actions: [], error: true });
            }
        }));
        const ids = new Set(candidates.map((o) => o.id));
        const objects = candidates.filter((o) => o.actions.length).concat((catalog.objects || []).filter((o) => !ids.has(o.id)));
        const more = candidates.filter((o) => !o.actions.length).concat((catalog.more || []).filter((o) => !ids.has(o.id)));
        return { catalog: Object.assign({}, catalog, { objects, more }), candidates };
    }

    // What the game's own item card says about food that a name cannot: spoiled, or eaten up.
    objectState(id) {
        const f = this.foodState ? this.foodState(id) : null;
        if (!f) return '';
        if (f.spoiled) return '已变质' + (f.left !== null && f.left > 0 ? '，还剩 ' + f.left + '%' : '');
        if (f.empty) return '已经吃完，只剩空盘';
        if (f.edible) return '能吃的食物' + (f.left !== null && f.left > 0 && f.left < 100 ? '，还剩 ' + f.left + '%' : '');
        return '';
    }

    // Everything the game lets this person do to one object, minus what a family text must never start.
    async allObjectActions(actorId, objectId, ageGroup) {
        const key = 'obj:' + actorId + '>' + objectId + ':' + (ageGroup || '');
        const hit = this.listCache.get(key);
        if (hit && Date.now() - hit.at < 20000) return hit.value;
        const r = await this.game.call('interaction_list_available', {
            entity_id: String(actorId),
            target_entity_id: String(objectId)
        });
        if (!r || !Array.isArray(r.interactions)) throw new GameToolError('interaction_list_available', 'unreadable interaction list');
        const raw = (r && r.interactions) || [];
        const seen = new Set();
        const list = [];
        let picker = false;
        for (const it of raw) {
            const id = str(it.interaction_bag_id);
            const name = str(it.display_name) || id;
            // The fridge's 取出 only opens the inventory picker, which only the player can click.
            if (id === PICKER_BAG) {
                picker = true;
                continue;
            }
            if (!id || it.enabled === false || seen.has(id)) continue;
            if (INTERACTION_EXCLUDE.test(id) || OBJECT_SKIP_RE.test(id) || ROMANCE.test(id)) continue;
            if (/骗取|作弊|调试|一起泡/.test(name)) continue;
            if (ageGroup === 'Child' && CHILD_SKIP_RE.test(id + ' ' + name)) continue;
            seen.add(id);
            list.push({ id, name, hint: str(it.hint), kind: actionKind(id, name) });
        }
        if (picker && this.meals) {
            try {
                for (const meal of await this.meals.actionsFor(objectId)) list.push(meal);
            } catch (e) {
                this.log.warn('family meals in ' + objectId + ' not listed: ' + (e && e.message || e));
            }
        }
        this.listCache.set(key, { at: Date.now(), value: list });
        return list;
    }

    // The same list read from the game now: what an object offers turns over with its state.
    async freshObjectActions(actorId, objectId, ageGroup) {
        this.listCache.delete('obj:' + actorId + '>' + objectId + ':' + (ageGroup || ''));
        return this.allObjectActions(actorId, objectId, ageGroup);
    }

    async objectActions(actorId, objectId, ageGroup, limit) {
        const all = await this.allObjectActions(actorId, objectId, ageGroup);
        const scored = all.map((x, i) => ({ id: x.id, name: x.name, hint: x.hint, kind: x.kind, meal: x.meal, score: usefulness(x.id, x.name), order: i }));
        scored.sort((a, b) => b.score - a.score || a.order - b.order);
        if (this.siteMemory && scored.length) this.siteMemory.noteUseful(objectId, scored[0].score);
        let bestCook = null;
        let bestCookRank = 0;
        let bestFloor = null;
        let bestFloorRank = 0;
        for (let i = 0; i < scored.length; i++) {
            scored[i].kind = scored[i].kind || actionKind(scored[i].id, scored[i].name);
            const cook = cookRank(scored[i].id);
            if (cook > bestCookRank) {
                bestCookRank = cook;
                bestCook = scored[i];
            }
            const floor = floorRank(scored[i].id);
            if (floor > bestFloorRank) {
                bestFloorRank = floor;
                bestFloor = scored[i];
            }
        }
        const listed = [];
        const pinned = {};
        if (bestCook) { listed.push(bestCook); pinned[bestCook.id] = true; }
        if (bestFloor && !pinned[bestFloor.id]) { listed.push(bestFloor); pinned[bestFloor.id] = true; }
        for (let i = 0; i < scored.length && listed.length < limit; i++) {
            if (pinned[scored[i].id]) continue;
            listed.push(scored[i]);
        }
        return listed.map((x) => {
            const out = { id: x.id, name: x.name, hint: x.hint, kind: x.kind || actionKind(x.id, x.name) };
            if (x.meal) out.meal = x.meal;
            return out;
        });
    }

    // Every object the model was shown, by id.
    knownObjects(catalog) {
        const known = new Map();
        for (const o of (catalog.objects || [])) known.set(o.id, o);
        for (const o of (catalog.more || [])) if (!known.has(o.id)) known.set(o.id, o);
        return known;
    }

    // The whole lot as "what each kind of thing here can do", so a job is matched to the thing
    // that actually does it rather than to whatever has a similar name. Objects sharing a name
    // become one line, represented by the nearest; every line carries the game's own action
    // names for this person. Returns [{ id, name, meters, state, count, actions: [names] }].
    async capabilities(actorId, ageGroup, objects) {
        const groups = new Map();
        for (const o of objects || []) {
            if (!o || !o.id || !o.name) continue;
            const state = o.state || this.objectState(o.id);
            // The same bed in two bedrooms is two choices: "go to bed" means one's own.
            const key = o.carried || state ? 'id:' + o.id : 'name:' + o.name + (o.room ? '@' + o.room : '');
            const g = groups.get(key);
            if (!g) {
                groups.set(key, { key, rep: o, state, count: 1, food: !!state });
                continue;
            }
            g.count += 1;
            if (typeof o.meters === 'number' && (typeof g.rep.meters !== 'number' || o.meters < g.rep.meters)) g.rep = o;
        }
        const list = Array.from(groups.values());
        const out = new Array(list.length);
        let next = 0;
        const worker = async () => {
            while (next < list.length) {
                const i = next++;
                const g = list[i];
                const names = (g.rep.carried || g.rep.pocket)
                    ? (g.rep.actions || []).map((a) => a.name)
                    : await this.capabilityNames(actorId, ageGroup, g);
                out[i] = { id: g.rep.id, name: g.rep.name, meters: g.rep.meters, state: g.state, room: g.rep.room || '', count: g.count, pocket: !!g.rep.pocket, actions: names };
            }
        };
        const workers = [];
        for (let w = 0; w < Math.min(CAP_PARALLEL, list.length); w++) workers.push(worker());
        await Promise.all(workers);
        return out;
    }

    capabilityNames(actorId, ageGroup, group) {
        const key = (ageGroup || '') + '|' + group.key;
        const hit = this.capCache.get(key);
        if (hit && Date.now() - hit.at < (group.food ? CAP_FOOD_KEEP_MS : CAP_KEEP_MS)) return Promise.resolve(hit.names);
        const pending = this.capPending.get(key);
        if (pending) return pending;
        if (this.capCache.size > 1500) {
            const old = Date.now() - CAP_KEEP_MS;
            for (const [k, v] of this.capCache) if (v.at < old) this.capCache.delete(k);
        }
        const run = this.allObjectActions(actorId, group.rep.id, ageGroup)
            .then((all) => {
                const scored = all.map((a, i) => ({ name: a.name, score: usefulness(a.id, a.name), order: i }));
                scored.sort((a, b) => b.score - a.score || a.order - b.order);
                const names = [];
                for (const a of scored) {
                    if (a.name && names.indexOf(a.name) < 0) names.push(a.name);
                    if (names.length >= CAP_NAMES_LISTED) break;
                }
                this.capCache.set(key, { at: Date.now(), names });
                return names;
            })
            .catch((e) => {
                this.log.debug('capabilities of ' + group.rep.id + ' ' + group.rep.name + ': ' + (e && e.message || e));
                return [];
            })
            .finally(() => { this.capPending.delete(key); });
        this.capPending.set(key, run);
        return run;
    }

    // The chosen objects with their full action lists, for turning a "want" into one real action.
    async wantCandidates(actorId, ageGroup, catalog, ids) {
        const known = this.knownObjects(catalog);
        const pool = [];
        for (const id of ids || []) {
            const o = known.get(String(id));
            if (o && pool.indexOf(o) < 0) pool.push(o);
        }
        const listed = await Promise.all(pool.map(async (o) => {
            const found = (o.carried || o.pocket) ? (o.actions || []) : await this.allObjectActions(actorId, o.id, ageGroup);
            const actions = await Promise.all(found.map(async (a) => Object.assign({}, a, { steps: await this.bagSteps(a.id) })));
            return actions.length ? { id: o.id, name: o.name, meters: o.meters, state: o.state || this.objectState(o.id), room: o.room || '', actions } : null;
        }));
        return listed.filter(Boolean);
    }

    // The steps the game's own data says an action is made of, e.g. Food_Fridge_Keeping is
    // Picked_PickUp_RightHand then Storage_Fridge_PutIn. A two-character label such as 冷藏 says
    // far less than this. Table rows do not change while the game runs.
    async bagSteps(bagId) {
        const id = str(bagId);
        if (!id) return [];
        const meal = modeOf(id);
        if (meal) return meal.steps.slice();
        const hit = this.stepCache.get(id);
        if (hit) return hit;
        const row = await this.game.soft('data_table_get', { Alias: 'InteractionBag', Row: id });
        const data = typeof row === 'string' ? safeJson(row) : row;
        const steps = [];
        for (const seq of (data && data.interactionSequence) || []) {
            for (const info of (seq && seq.interactionInfos) || []) {
                const step = str(info && info.interactionId);
                if (step && step !== 'None' && steps.indexOf(step) < 0) steps.push(step);
            }
            const next = str(seq && seq.nextInteractionBagId);
            if (next && next !== 'None' && steps.indexOf(next) < 0) steps.push(next);
        }
        const out = steps.slice(0, 8);
        if (data) this.stepCache.set(id, out);
        return out;
    }

    // Turns raw model output into validated steps. Returns { steps, rejected }.
    normalize(rawActions, catalog, snap, cfg) {
        const steps = [];
        const rejected = [];
        const list = Array.isArray(rawActions) ? rawActions : [];
        const placeById = new Map(catalog.places.map((p) => [p.id, p]));
        const placeByName = new Map(catalog.places.map((p) => [p.name, p]));
        const facial = new Set(catalog.facial.map((f) => f.id));
        const max = cfg.max_per_reply;
        for (const a of list) {
            if (steps.length >= max) {
                rejected.push({ action: a, reason: 'too many actions' });
                break;
            }
            const type = canonicalType(str(a && a.type));
            if (!catalog.allowed.has(type)) {
                rejected.push({ action: a, reason: 'action type not allowed: ' + type });
                continue;
            }
            const fast = !!(a.fast && cfg.allow_teleport);
            if (type === 'go_home') {
                steps.push({ type, fast });
            } else if (type === 'go_to_player') {
                steps.push({ type, fast });
            } else if (type === 'go_to_place') {
                const place = placeById.get(str(a.place_id)) || placeByName.get(str(a.place_id)) || placeByName.get(str(a.place_name));
                if (!place) {
                    rejected.push({ action: a, reason: 'unknown place ' + str(a.place_id || a.place_name) });
                    continue;
                }
                steps.push({ type, fast, place });
            } else if (type === 'go_together') {
                const ref = str(a.place_id || a.place_name);
                const place = ref ? (placeById.get(ref) || placeByName.get(ref) || placeByName.get(str(a.place_name))) : null;
                if (ref && !place) {
                    rejected.push({ action: a, reason: 'unknown place ' + ref });
                    continue;
                }
                // Leading moves the player's own character too: only when the player asked for it.
                steps.push({ type, place: place || null, lead: !!(a.lead && place) });
            } else if (type === 'interact') {
                const target = str(a.target) || 'player';
                const isPlayer = target === 'player' || target === 'spouse' || target === snap.player.id;
                const member = isPlayer ? null : snap.others.find((m) => m.id === target);
                if (!isPlayer && !member) {
                    rejected.push({ action: a, reason: 'unknown target ' + target });
                    continue;
                }
                const options = isPlayer ? catalog.player : (catalog.members[member.id] || []);
                const id = str(a.interaction_id);
                const found = options.find((o) => o.id === id);
                if (!found) {
                    rejected.push({ action: a, reason: 'interaction not available now: ' + id });
                    continue;
                }
                steps.push({
                    type,
                    targetId: isPlayer ? snap.player.id : member.id,
                    targetName: isPlayer ? snap.player.name : member.name,
                    targetSite: isPlayer ? snap.player.site : member.site,
                    interaction: found
                });
            } else if (type === 'stop_current') {
                const afterS = wrapUpSeconds(a.after_s);
                steps.push(afterS ? { type, afterS } : { type });
            } else if (type === 'emote') {
                const expr = str(a.expression);
                if (!facial.has(expr)) {
                    rejected.push({ action: a, reason: 'unknown expression ' + expr });
                    continue;
                }
                steps.push({ type, expression: expr });
            } else if (type === 'use_object') {
                const interactionId = str(a.interaction_id);
                const objectId = str(a.object_id);
                // A learned skill by its id (K1 ...): the bridge finds what here offers it.
                const skillRef = str(a.skill);
                if (skillRef) {
                    const m = /^K?(\d+)$/i.exec(skillRef);
                    const skill = m && Array.isArray(snap.skills) ? snap.skills[Number(m[1]) - 1] : null;
                    if (skill) {
                        steps.push({ type, skill, want: str(a.want) || skill.task, objectId: objectId === 'self' ? '' : objectId });
                        continue;
                    }
                    if (!str(a.want)) {
                        rejected.push({ action: a, reason: 'unknown skill ' + skillRef });
                        continue;
                    }
                }
                if (objectId === 'self') {
                    const found = (catalog.chores || []).find((c) => c.id === interactionId);
                    if (!found) {
                        rejected.push({ action: a, reason: 'housework not available now: ' + interactionId });
                        continue;
                    }
                    steps.push({ type, self: true, interaction: found });
                    continue;
                }
                const obj = (catalog.objects || []).find((o) => o.id === objectId);
                const found = obj && obj.actions.find((x) => x.id === interactionId);
                const want = str(a.want);
                // The model named the thing and what to do with it, on an object whose actions
                // were never put in the catalog (most of the lot is known by name only). Keep
                // the action as given: dropping it made the resolver work the same answer out
                // again from the words of 'want', and that guessing is where most "could not
                // find a way to do it here" failures come from. The game rejects an action this
                // object does not offer, with a real reason, when it is executed.
                // Only when nothing is known about the object: if it was listed, its own list
                // is better evidence than the model's memory of it.
                if (!found && !obj && interactionId && objectId) {
                    const named = (catalog.more || []).find((o) => o.id === objectId);
                    const kind = actionKind(interactionId, '');
                    steps.push({
                        type,
                        kind,
                        objectId,
                        objectName: (named && named.name) || '',
                        interaction: { id: interactionId, name: str(a.interaction_name) || interactionId, hint: '', kind },
                        want,
                        unverified: true
                    });
                    continue;
                }
                if (!found && want && (catalog.sameSite || catalog.objectSource)) {
                    steps.push({ type, want, objectId: objectId || '' });
                    continue;
                }
                if (!obj || !found) {
                    rejected.push({ action: a, reason: 'object action not available now: ' + objectId + ' ' + interactionId });
                    continue;
                }
                steps.push({
                    type,
                    kind: found.kind || actionKind(found.id, found.name),
                    objectId: obj.id,
                    objectName: obj.name,
                    interaction: found,
                    want: want
                });
            }
        }
        // Interacting with someone on another lot needs travel first.
        const out = [];
        let travelled = false;
        let goingTogether = false;
        for (const s of steps) {
            // On an outing the player leads; anything started after it would pull the character away.
            if (goingTogether && isPhysicalStep(s)) {
                rejected.push({ action: s, reason: 'comes after going out together; what to do there is decided once there' });
                continue;
            }
            if (s.type === 'go_together') goingTogether = true;
            if (s.type === 'go_home' || s.type === 'go_to_player' || s.type === 'go_to_place' || s.type === 'go_together') travelled = true;
            if (s.type === 'interact' && !travelled && s.targetSite && snap.partner.site && s.targetSite !== snap.partner.site) {
                const place = placeByName.get(s.targetSite);
                if (s.targetId === snap.player.id) out.push({ type: 'go_to_player', fast: false, implicit: true });
                else if (place) out.push({ type: 'go_to_place', fast: false, place, implicit: true });
                travelled = true;
            }
            out.push(s);
        }
        return { steps: out, rejected };
    }

    async walkToSite(actorId, siteArgs, front) {
        const desc = await this.game.call('movement_get_site_move_interaction', Object.assign({ entity_id: String(actorId) }, siteArgs));
        if (!desc || !desc.interaction_bag_id || desc.target_entity_id === undefined) throw new Error('no route to site');
        if (front) {
            const held = await this.commitInteraction(actorId, desc.interaction_bag_id, desc.target_entity_id);
            if (!held.ok) throw new Error('没有开始前往');
            return Object.assign(desc, { hold: held.hold });
        }
        await this.game.call('interaction_execute', {
            entity_id: String(actorId),
            interaction_bag_id: String(desc.interaction_bag_id),
            target_entity_id: String(desc.target_entity_id),
            SmartZoi: !!(desc.smartzoi || desc.SmartZoi),
            insert_front: false
        });
        return desc;
    }

    async currentOf(actorId) {
        return await this.game.soft('interaction_get_current', { entity_id: String(actorId) });
    }

    // Someone other than actorId already on a thing only one person can use: anyone in the
    // household the game shows playing on it, or a character the bridge has just sent to it.
    // { id, name, doing } or null.
    async occupant(step, actorId, snap) {
        if (!this.realism || step.self || !step.objectId) return null;
        if (!this.realism.exclusive(step.objectName, step.interaction)) return null;
        const id = str(step.objectId);
        const me = str(actorId);
        const people = [];
        if (snap && snap.player && snap.player.id && str(snap.player.id) !== me) people.push({ id: str(snap.player.id), name: snap.player.name });
        for (const m of (snap && snap.others) || []) {
            if (m && m.id && str(m.id) !== me) people.push({ id: str(m.id), name: m.name });
        }
        const curs = await Promise.all(people.map((p) => this.currentOf(p.id).catch(() => null)));
        for (let i = 0; i < people.length; i++) {
            const cur = curs[i];
            if (!cur || !cur.playing || str(cur.target_entity_id) !== id) continue;
            const doing = await this.world.interactionName(cur.interaction_bag_id).catch(() => '');
            return { id: people[i].id, name: people[i].name, doing: doing || '' };
        }
        const c = this.realism.claimedBy(id, me);
        if (!c) return null;
        const cur = await this.currentOf(c.actorId).catch(() => null);
        // Idle again, or on something else: the claim lapsed. Moving without a target yet: it holds.
        if (!cur || !cur.playing) return null;
        if (cur.target_entity_id !== undefined && cur.target_entity_id !== null && str(cur.target_entity_id) !== '' && str(cur.target_entity_id) !== id) return null;
        return { id: c.actorId, name: c.actorName, doing: c.what };
    }

    // Non-null while the game's timetable (school, work, police, clinic) or an emergency (a fire,
    // an accident; see incidents.js) holds the character.
    async scheduleHold(actorId, cur) {
        const now = cur === undefined ? await this.currentOf(actorId) : cur;
        const urgent = this.incidents ? this.incidents.holdFor(actorId, now) : null;
        if (urgent) return urgent;
        if (now && now.playing && isScheduledBag(now.interaction_bag_id)) return scheduledNow(now, null);
        const work = await this.game.soft('career_get_work_status', { entity_id: String(actorId) });
        return scheduledNow(now, work);
    }

    // Queued is not started. A match is the same bag, or already walking to that object.
    playingMatches(cur, bagId, targetId) {
        return samePlaying(cur, bagId, targetId);
    }

    // One task is often several game bags in a row (walk over, pick up, put down, wash). A new
    // bag id is only a takeover when it is not one of those steps. Verdicts are kept on the hold.
    async stillOnTask(actorId, hold, cur) {
        if (!hold) return false;
        if (samePlaying(cur, hold.bagId, hold.targetId)) return true;
        if (!cur || !cur.playing || !cur.interaction_bag_id) return false;
        const bag = String(cur.interaction_bag_id);
        if (!Array.isArray(hold.related)) hold.related = [];
        if (!Array.isArray(hold.unrelated)) hold.unrelated = [];
        if (hold.related.indexOf(bag) >= 0) return true;
        if (hold.unrelated.indexOf(bag) >= 0 || !this.judge) return false;
        let same = false;
        try {
            same = !!(await this.judge(hold, cur));
        } catch (e) {
            this.log.warn('could not tell whether ' + bag + ' belongs to ' + hold.bagId + ': ' + (e && e.message || e));
            return false;
        }
        (same ? hold.related : hold.unrelated).push(bag);
        this.log.info('task watch [' + actorId + ']: ' + bag + (same ? ' is a step of ' : ' is not part of ') + hold.bagId);
        return same;
    }

    async preempt(actorId) {
        const held = await this.scheduleHold(actorId);
        if (held) throw new ScheduleBusyError(held);
        await this.releasePhonePose(actorId);
        await this.game.call('interaction_clear_queue', { entity_id: String(actorId), cancel_current: true });
        await this.freeBody(actorId);
    }

    async motionsOf(actorId) {
        return await this.game.soft('motion_get_current', { entity_id: String(actorId) });
    }

    async stopMontages(actorId, list) {
        for (const m of list) {
            await this.game.soft('motion_stop', { entity_id: String(actorId), anim_id: str(m.anim_id) });
        }
    }

    // A cancelled activity (an instrument, the TV, a toy) first plays its own ending. A task started
    // on top of that ending can stay at "walk to" while the old loop keeps the body in place, so the
    // next task starts only once the body is free, or after the ending has had its time.
    async freeBody(actorId) {
        const until = Date.now() + BODY_FREE_WAIT_MS;
        let left = activityMontages(await this.motionsOf(actorId));
        while (left.length && Date.now() < until) {
            await sleep(250);
            left = activityMontages(await this.motionsOf(actorId));
        }
        if (!left.length) return 0;
        await this.stopMontages(actorId, left);
        this.log.info('stopped ' + left.map((m) => str(m.anim_id)).join(', ') + ' on ' + actorId +
            ': still playing ' + BODY_FREE_WAIT_MS + 'ms after its action was put down');
        return left.length;
    }

    // The task is the current action and says it is walking there, but an activity animation still
    // holds the body. Returns 'free', 'watching' (seen once, confirming), or 'released'.
    async unstickWalk(actorId, hold, cur) {
        if (!hold || !isWalking(cur)) {
            if (hold) delete hold.lockSeenAt;
            return 'free';
        }
        const left = activityMontages(await this.motionsOf(actorId));
        if (!left.length) {
            delete hold.lockSeenAt;
            return 'free';
        }
        const now = Date.now();
        if (!hold.lockSeenAt) {
            hold.lockSeenAt = now;
            return 'watching';
        }
        if (now - hold.lockSeenAt < BODY_LOCK_CONFIRM_MS) return 'watching';
        await this.stopMontages(actorId, left);
        delete hold.lockSeenAt;
        hold.unstuck = (hold.unstuck || 0) + 1;
        this.log.info('task watch [' + actorId + ']: ' + hold.bagId + ' was stuck at ' + str(cur.action_type) + ' under ' +
            left.map((m) => str(m.anim_id)).join(', ') + ', stopped it (' + hold.unstuck + ')');
        return 'released';
    }

    // The texting montage locks the whole body. An interaction can say "walking" while the
    // character stays planted, replying, until this montage is stopped.
    async releasePhonePose(actorId) {
        const cur = await this.game.soft('motion_get_current', { entity_id: String(actorId) });
        const motions = (cur && cur.motions) || [];
        const stuck = motions.filter((m) => /Phone|Text_Messag|SendMessage/i.test(str(m.anim_id)));
        if (!stuck.length) return;
        for (const m of stuck) {
            await this.game.soft('motion_stop', { entity_id: String(actorId), anim_id: str(m.anim_id) });
        }
        this.log.info('stopped the texting pose on ' + actorId);
    }

    // Cancel whatever they are doing, including an autonomous choice, and make this the current action.
    // For the next ten seconds, keep checking. Autonomy often replaces a task a moment after it starts.
    async commitInteraction(actorId, bagId, targetId) {
        const args = {
            entity_id: String(actorId),
            interaction_bag_id: String(bagId),
            insert_front: true
        };
        if (targetId) args.target_entity_id = String(targetId);
        const watchUntil = Date.now() + TASK_GUARD_MS;
        const hold = {
            bagId: String(bagId),
            targetId: targetId ? String(targetId) : '',
            startedAt: Date.now(),
            confirmUntil: watchUntil
        };
        let lastExecuteAt = 0;
        let restarts = 0;
        let sawPlaying = false;
        while (Date.now() < watchUntil || (lastExecuteAt && Date.now() - lastExecuteAt < TASK_GUARD_START_GRACE_MS)) {
            const cur = await this.currentOf(actorId);
            let decision = taskGuardDecision(cur, hold.bagId, hold.targetId, Date.now(), lastExecuteAt);
            if (decision === 'stolen' && await this.stillOnTask(actorId, hold, cur)) decision = 'ok';
            if (decision === 'ok') {
                if (cur && typeof cur.remain_time === 'number') {
                    hold.remain = cur.remain_time;
                    hold.seenAt = Date.now();
                }
                sawPlaying = true;
                await this.unstickWalk(actorId, hold, cur);
                if (Date.now() >= watchUntil) break;
                await sleep(Math.min(TASK_GUARD_POLL_MS, watchUntil - Date.now()));
                continue;
            }
            if (decision === 'starting') {
                await sleep(250);
                continue;
            }
            if (Date.now() >= watchUntil) break;
            if (!sawPlaying && restarts >= TASK_NEVER_STARTED_RESTARTS) {
                this.log.info('task watch: ' + hold.bagId + ' never started after ' + restarts + ' restart(s), giving up so the next step can run');
                break;
            }
            const timetable = await this.scheduleHold(actorId, cur);
            if (timetable) {
                this.log.info('task watch: ' + hold.bagId + ' gave way to ' + (timetable.emergency ? 'an emergency' : 'the game timetable') +
                    ' (' + (timetable.bagId || timetable.what) + '), not taking it back');
                return { ok: false, hold: null, scheduled: timetable };
            }
            const why = cur && cur.playing ? (cur.interaction_bag_id || 'other') : 'idle';
            if (hold.targetId && !(await this.game.soft('entity_reflect', { entity_id: hold.targetId }))) {
                this.log.info('task watch: ' + hold.bagId + ' is not playing (' + why + ') and its target ' + hold.targetId + ' is gone, not starting it again');
                return { ok: sawPlaying, hold: null, gone: true };
            }
            restarts += 1;
            this.log.info('task watch: ' + hold.bagId + ' is not playing (' + why + '), starting it again (' + restarts + ')');
            await this.preempt(actorId);
            await this.game.call('interaction_execute', args);
            lastExecuteAt = Date.now();
            await sleep(250);
        }
        const cur = await this.currentOf(actorId);
        if (await this.stillOnTask(actorId, hold, cur)) {
            this.log.info('task watch: ' + hold.bagId + ' held for ' + TASK_GUARD_MS + 'ms (' + restarts + ' restart(s))');
            return { ok: true, hold: hold };
        }
        this.log.warn('task watch ended and ' + hold.bagId + ' is still not playing' + (sawPlaying ? ' after it had started' : ''));
        return { ok: false, hold: null };
    }

    // After the texts go out the game may start its own "reply on the phone" interaction.
    // Put the AI action back in front if that happened.
    async reassert(actorId, hold) {
        await this.releasePhonePose(actorId);
        if (!hold || !hold.bagId) return;
        const cur = await this.currentOf(actorId);
        if (await this.stillOnTask(actorId, hold, cur)) return;
        const timetable = await this.scheduleHold(actorId, cur);
        if (timetable) {
            this.log.info('action gave way to the game timetable (' + (timetable.bagId || timetable.what) + '); ' + hold.bagId + ' is not taken back');
            return;
        }
        if (hold.noRetake) {
            this.log.warn('action lost the front to ' + ((cur && cur.interaction_bag_id) || 'nothing') + '; ' + hold.bagId + ' cannot be restarted from here');
            return;
        }
        this.log.info('action lost the front to ' + ((cur && cur.interaction_bag_id) || 'nothing') + ', taking it back');
        const again = await this.commitInteraction(actorId, hold.bagId, hold.targetId);
        if (!again.ok) this.log.warn('priority action did not stay playing: ' + hold.bagId);
    }

    // Takes a family meal out of the fridge, or picks up a dish standing out, and by meal.mode eats
    // one portion, leaves it on a table for the family or puts it down in front of meal.person.
    // The Lua mod does the game side (it alone can fill in the picked dish and replace the game's
    // own next step in the same tick); this puts the current action down, hands the request over
    // and waits until the game really is on the task.
    async serveMeal(actorId, step, pairKey, actorName) {
        const meal = step.interaction.meal;
        const mode = MODES[meal.mode] || MODES.eat;
        const what = '「' + meal.name + '」';
        const verb = mode.loose ? '端起' : '取出';
        if (!this.meals || !this.meals.usable()) {
            throw new Error((mode.loose ? '端不了' : '取不出冰箱里的') + what + '：游戏里的 HouseholdJournal 模组现在没有在报告');
        }
        if (this.meals.d.journal.handlersDown()) {
            throw new Error((mode.loose ? '端不了' : '取不出冰箱里的') + what + '：游戏里负责取餐的处理器掉线了（要重新加载 HouseholdJournal 的 Lua）');
        }
        await this.preempt(actorId);
        const seq = this.meals.request(actorId, meal, pairKey, step.want || mode.purpose(meal.name, meal.personName));
        const first = mode.chain[0];
        const until = Date.now() + this.meals.cfg.start_timeout_s * 1000;
        while (Date.now() < until) {
            const res = this.meals.result(seq);
            if (res && res.stage === 'fail') throw new Error('没能' + verb + what + '：' + reasonText(res.detail));
            const cur = await this.currentOf(actorId);
            const bag = cur && cur.playing ? str(cur.interaction_bag_id) : '';
            if (bag && mode.chain.indexOf(bag) >= 0) {
                this.meals.markStarted(seq);
                const hold = {
                    bagId: first,
                    targetId: '',
                    startedAt: Date.now(),
                    confirmUntil: Date.now(),
                    related: mode.chain.filter((b) => b !== first),
                    unrelated: [],
                    replaced: [AUTO_NEXT_BAG],
                    noRetake: true,
                    mealSeq: seq,
                    meal: {
                        name: meal.name || '', mode: meal.mode || '',
                        person: mode.person && meal.person ? String(meal.person) : '', personName: meal.personName || '', cooked: !!meal.cooked
                    },
                    learnAs: { id: MEAL_PREFIX + '（菜的编号）' + mode.suffix, name: mode.learned }
                };
                if (cur && typeof cur.remain_time === 'number') {
                    hold.remain = cur.remain_time;
                    hold.seenAt = Date.now();
                }
                const toWhom = mode.person && meal.personName ? '给' + meal.personName : '';
                return { ok: true, note: mode.doing(meal.name, meal.personName), toast: actorName + '：' + verb + meal.name + toWhom, hold };
            }
            await sleep(500);
        }
        this.meals.withdraw(seq);
        throw new Error('游戏没有开始' + verb + what + '（等了 ' + this.meals.cfg.start_timeout_s + ' 秒）');
    }

    // A self bag that the game will not start, replaced by a real object action of the same kind.
    async directReplacement(actorId, ageGroup, cfg, interaction, snap) {
        const hint = str(interaction && interaction.id) + ' ' + str(interaction && interaction.name);
        const wantClean = /Vacuum|Mop|Sweep|扫|吸|清洁|打扫|清理/.test(hint);
        const scope = snap ? await this.useScope(snap) : { live: true };
        if (!scope) return null;
        const objects = (await this.nearbyObjects(actorId, ageGroup, cfg, scope)).objects;
        let best = null;
        for (const o of objects) {
            if (o.carried) continue;
            for (const a of o.actions) {
                let rank = usefulness(a.id, a.name);
                if (wantClean && rank < 6) continue;
                rank = rank * 10 - (o.meters || 0);
                if (!best || rank > best.rank) best = { object: o, action: a, rank };
            }
        }
        return best;
    }

    // ---------------------------------------------------------------- going out together
    async groupInfo(id) {
        const info = await this.game.soft('zoi_group_get_info', { entity_id: String(id) });
        if (info && !this.groupShapeLogged && info.has_group) {
            this.groupShapeLogged = true;
            this.log.info('zoi group info shape: ' + JSON.stringify(info).slice(0, 400));
        }
        return info;
    }

    // The ids in a group info, whatever the game calls the list.
    static groupMembers(info) {
        const out = new Set();
        if (!info || typeof info !== 'object') return out;
        const add = (v) => {
            if (v === undefined || v === null) return;
            if (typeof v === 'object') {
                if (v.entity_id !== undefined) out.add(String(v.entity_id));
                return;
            }
            out.add(String(v));
        };
        for (const key of ['leader_entity_id', 'leader_id', 'leader']) add(info[key]);
        for (const key of ['members', 'member_entity_ids', 'member_ids']) {
            const list = info[key];
            if (Array.isArray(list)) list.forEach(add);
            else if (typeof list === 'string') list.split(',').map((s) => s.trim()).filter(Boolean).forEach(add);
        }
        return out;
    }

    async groupsReady() {
        for (const t of GROUP_TOOLS) if (!(await this.game.has(t))) return false;
        return true;
    }

    groupsChanged() {
        if (this.onGroupsChanged) {
            try { this.onGroupsChanged(); } catch (e) { this.log.warn('saving travel groups: ' + e.message); }
        }
    }

    // Takes the member out of the group this bridge put them in: the group itself ends when the
    // bridge made it, otherwise only this member leaves the player's group.
    async leaveGroup(memberId, why) {
        const id = String(memberId);
        const g = this.groups.get(id);
        if (!g) return false;
        this.groups.delete(id);
        this.groupsChanged();
        try {
            const info = await this.groupInfo(id);
            if (info && info.has_group === false) {
                this.log.info('together: ' + id + ' is no longer in a group (' + why + ')');
                return true;
            }
            if (g.made) await this.game.call('zoi_group_disband', { entity_id: id });
            else await this.game.call('zoi_group_remove_member', { entity_id: id });
            this.log.info('together: ' + (g.made ? 'ended the group of ' + id + ' and ' + g.player : id + ' left the group of ' + g.player) + ' (' + why + ')');
            return true;
        } catch (e) {
            this.log.warn('together: could not take ' + id + ' out of the group (' + why + '): ' + (e && e.message || e));
            return false;
        }
    }

    // Whether someone is with the player in a group made by this bridge.
    togetherWith(memberId) {
        return this.groups.get(String(memberId)) || null;
    }

    // Groups end on their own terms: kept as long as the outing is meant to last, ended when the
    // two are at different sites for a while (they parted) or the game already ended it.
    // opts: { keepMs, apartMs, now }.
    async tendGroups(opts) {
        if (!this.groups.size) return;
        const o = opts || {};
        const now = o.now || Date.now();
        let members = [];
        try {
            members = (await this.world.household()).members || [];
        } catch (e) {
            return;
        }
        const siteOf = (id) => {
            const m = members.find((x) => String(x.entity_id) === String(id));
            return m && m.current_site ? String(m.current_site) : '';
        };
        for (const [id, g] of Array.from(this.groups.entries())) {
            if (now - g.at > (o.keepMs || 7200000)) {
                await this.leaveGroup(id, 'the outing has lasted ' + Math.round((now - g.at) / 60000) + ' min');
                continue;
            }
            const info = await this.groupInfo(id);
            if (info && info.has_group === false) {
                this.groups.delete(id);
                this.groupsChanged();
                this.log.info('together: the game ended the group of ' + id + ' and ' + g.player);
                continue;
            }
            const a = siteOf(id);
            const b = siteOf(g.player);
            if (a && b && a !== b) {
                if (!g.apartAt) {
                    g.apartAt = now;
                    this.groupsChanged();
                } else if (now - g.apartAt > (o.apartMs || 180000)) {
                    await this.leaveGroup(id, 'at ' + a + ' while ' + g.player + ' is at ' + b);
                }
            } else if (g.apartAt) {
                delete g.apartAt;
                this.groupsChanged();
            }
        }
    }

    async releaseAllGroups(why) {
        for (const id of Array.from(this.groups.keys())) await this.leaveGroup(id, why);
    }

    // Walking with the player: in one group with the player as leader, following them, or (lead)
    // the whole group, the player too, walking to the place. Apart, the character goes to meet them.
    async goTogether(P, pair, snap, step, cfg) {
        const name = snap.partner.name;
        const player = String(pair.playerId);
        const sameSite = !!(snap.partner.site && snap.player.site && snap.partner.site === snap.player.site);
        if (!sameSite) {
            const meet = step.place || null;
            if (meet) {
                const r = await this.runStep({ type: 'go_to_place', fast: false, place: meet, insertFront: step.insertFront }, pair, snap, cfg);
                return Object.assign(r, { note: (r.skipped ? '已经在' + meet.name : '先去' + meet.name) + '，在那里和' + snap.player.name + '会合' });
            }
            const r = await this.runStep({ type: 'go_to_player', fast: false, insertFront: step.insertFront }, pair, snap, cfg);
            return Object.assign(r, { note: (r.note || '去找' + snap.player.name) + '，到了再一起走' });
        }
        if (!(await this.groupsReady())) throw new Error('游戏里没有同行的做法，没法跟着一起走');
        await this.preempt(P);
        const mine = await this.groupInfo(P);
        const theirs = await this.groupInfo(player);
        const known = this.groups.get(String(P));
        let made = false;
        if (mine && mine.has_group) {
            const members = Actions.groupMembers(mine);
            if (!(known && members.has(player))) throw new Error('已经在和别人同行，没法再跟' + snap.player.name + '一起走');
            made = known.made;
        } else if (theirs && theirs.has_group) {
            await this.game.call('zoi_group_add_member', { entity_id: String(P), group_member_entity_id: player });
        } else {
            await this.game.call('zoi_group_create', { leader_entity_id: player, member_entity_ids: String(P), Type: 'Family' });
            made = true;
        }
        const after = await this.groupInfo(P);
        if (!after || !after.has_group) throw new Error('没能和' + snap.player.name + '编到一起同行');
        const members = Actions.groupMembers(after);
        if (members.size && !members.has(player)) {
            if (made) await this.game.soft('zoi_group_disband', { entity_id: String(P) });
            throw new Error('编进去的不是和' + snap.player.name + '同一个同行小组');
        }
        this.groups.set(String(P), { player, at: Date.now(), place: step.place ? { id: step.place.id, name: step.place.name } : null, lead: !!step.lead, made, site: snap.partner.site || '' });
        this.groupsChanged();
        // Only an outing that really set off is one; following around the same lot is not going out.
        const outing = () => {
            if (known || !this.onOuting || !step.place || step.place.name === snap.partner.site) return;
            this.onOuting({
                householdId: pair.householdId, member: String(P), player, memberName: name, playerName: snap.player.name,
                place: step.place.name
            });
        };
        if (step.lead && step.place) {
            await this.game.call('zoi_group_move_to', { entity_id: String(P), destination: String(step.place.id) });
            this.log.info('together: ' + P + ' and ' + player + ' are walking to ' + step.place.name + ' as one group');
            outing();
            return { ok: true, note: '正在和' + snap.player.name + '一起去' + step.place.name, toast: name + ' 和你一起去 ' + step.place.name };
        }
        await this.game.call('zoi_group_follow', { entity_id: String(P) });
        this.log.info('together: ' + P + ' follows ' + player + (step.place ? ' (to ' + step.place.name + ')' : ''));
        outing();
        return { ok: true, note: '跟着' + snap.player.name + '一起走' + (step.place ? '去' + step.place.name : ''), toast: name + ' 跟着你一起走' };
    }

    async runStep(step, pair, snap, cfg) {
        const P = pair.partnerId;
        const name = snap.partner.name;
        if (step.type !== 'emote') {
            const timetable = await this.scheduleHold(P);
            if (timetable) throw new ScheduleBusyError(timetable);
        }
        // Following the player and walking off to do something else pull the body two ways.
        if (step.type !== 'emote' && step.type !== 'go_together' && step.insertFront && this.groups.has(String(P))) {
            await this.leaveGroup(P, 'starting ' + step.type + (step.interaction ? ' ' + step.interaction.id : ''));
        }
        const sites = await this.world.sites();
        switch (step.type) {
            case 'go_together':
                return await this.goTogether(P, pair, snap, step, cfg);
            case 'stop_current':
                await this.preempt(P);
                return { ok: true, note: '放下了手头的事' };
            case 'go_home': {
                if (snap.partner.atHome) return { ok: true, skipped: true, note: '已经在家' };
                if (!step.fast && snap.partner.homeSiteId) {
                    try {
                        const desc = await this.walkToSite(P, { site_id: snap.partner.homeSiteId }, !!step.insertFront);
                        return { ok: true, note: '正在回家', toast: name + ' 正在回家', hold: desc.hold || null };
                    } catch (e) {
                        if (!cfg.allow_teleport) throw e;
                        this.log.warn('walk home failed (' + e.message + '), teleporting');
                    }
                }
                await this.game.call('movement_go_home', { entity_id: P });
                return { ok: true, note: '已经到家', toast: name + ' 已经到家了' };
            }
            case 'go_to_player': {
                if (snap.together) return { ok: true, skipped: true, note: '本来就在一起' };
                const site = snap.player.site ? sites.byName.get(snap.player.site) : null;
                if (!step.fast && site) {
                    try {
                        const desc = await this.walkToSite(P, { site_id: site.id }, !!step.insertFront);
                        return { ok: true, note: '正在赶去' + site.name, toast: name + ' 正在赶去 ' + site.name, hold: desc.hold || null };
                    } catch (e) {
                        if (!cfg.allow_teleport) throw e;
                        this.log.warn('walk to ' + snap.player.name + ' failed (' + e.message + '), teleporting');
                    }
                } else if (!step.fast && !cfg.allow_teleport) {
                    throw new Error('location of ' + snap.player.name + ' unknown');
                }
                await this.game.call('movement_teleport_npc_to', { entity_id: P, target_entity_id: pair.playerId });
                return { ok: true, note: '已经到了身边', toast: name + ' 来到了你身边' };
            }
            case 'go_to_place': {
                if (snap.partner.site === step.place.name) return { ok: true, skipped: true, note: '已经在' + step.place.name };
                if (!step.fast) {
                    try {
                        const desc = await this.walkToSite(P, { site_id: step.place.id }, !!step.insertFront);
                        return { ok: true, note: '正在前往' + step.place.name, toast: name + ' 正在前往 ' + step.place.name, hold: desc.hold || null };
                    } catch (e) {
                        if (!cfg.allow_teleport) throw e;
                        this.log.warn('walk to ' + step.place.id + ' failed (' + e.message + '), teleporting');
                    }
                }
                await this.game.call('movement_teleport', { entity_id: P, destination: step.place.id });
                return { ok: true, note: '到了' + step.place.name, toast: name + ' 到了 ' + step.place.name };
            }
            case 'interact': {
                if (step.insertFront) {
                    const held = await this.commitInteraction(P, step.interaction.id, step.targetId);
                    if (held.scheduled) throw new ScheduleBusyError(held.scheduled);
                    if (!held.ok) throw new Error('没有开始对' + step.targetName + '做' + step.interaction.name);
                    return { ok: true, note: '正在对' + step.targetName + '：' + step.interaction.name, toast: name + '：' + step.interaction.name, hold: held.hold };
                }
                await this.game.call('interaction_execute', {
                    entity_id: P,
                    interaction_bag_id: step.interaction.id,
                    target_entity_id: step.targetId,
                    insert_front: false
                });
                return { ok: true, note: '接着对' + step.targetName + '：' + step.interaction.name };
            }
            case 'emote':
                await this.game.call('facial_set', { entity_id: P, Expression: step.expression });
                return { ok: true, note: '表情 ' + step.expression };
            case 'use_object': {
                if (step.interaction && step.interaction.meal) return await this.serveMeal(P, step, pair.key, name);
                if (fromPocket(step)) return await this.takeOut(P, step, name);
                if (step.focusId && !step.self) {
                    if (step.focusSite && step.focusSite !== snap.partner.site) throw new Error('地点已经变了，需要重新确认目标物品');
                    const fresh = await this.freshObjectActions(P, step.objectId, snap.partner.ageGroup);
                    if (!fresh.some((a) => a.id === step.interaction.id)) throw new Error('找到了「' + step.objectName + '」，但现在没有「' + step.interaction.name + '」的可用做法');
                }
                const what = step.interaction.name;
                const where = step.self ? '' : '（' + step.objectName + '）';
                if (!step.insertFront) {
                    const args = { entity_id: P, interaction_bag_id: step.interaction.id, insert_front: false };
                    if (!step.self) args.target_entity_id = step.objectId;
                    await this.game.call('interaction_execute', args);
                    return { ok: true, note: '接着' + what + where };
                }
                const holder = await this.occupant(step, P, snap);
                if (holder) throw new TakenError(holder, step.objectName || what);
                // Read before the job starts: a short one can be over before it is watched.
                const check = this.beforeTask ? await this.beforeTask(P, step) : null;
                let held = await this.commitInteraction(P, step.interaction.id, step.self ? '' : step.objectId);
                if (held.scheduled) throw new ScheduleBusyError(held.scheduled);
                if (held.ok && held.hold && check) held.hold.check = check;
                if (held.ok && held.hold && step.after) {
                    await this.queueAfter(P, step.after, 0);
                    held.hold.after = step.after;
                    held.hold.afterTry = 0;
                    held.hold.objectName = step.objectName || '';
                    held.hold.related = (held.hold.related || []).concat(placeBags(step.after));
                    return { ok: true, note: '正在' + what + where + '，接着' + placeText(step.after), toast: name + '：' + what, hold: held.hold };
                }
                if (held.ok && !step.self && this.realism && this.realism.exclusive(step.objectName, step.interaction)) {
                    this.realism.claim(step.objectId, P, name, what);
                }
                if (!held.ok && step.self) {
                    const alt = await this.directReplacement(P, snap.partner.ageGroup, cfg, step.interaction, snap);
                    if (alt) {
                        this.log.info('self action ' + step.interaction.id + ' did not start, using ' + alt.action.id + ' @' + alt.object.name);
                        held = await this.commitInteraction(P, alt.action.id, alt.object.id);
                        if (held.scheduled) throw new ScheduleBusyError(held.scheduled);
                        if (held.ok) {
                            return { ok: true, note: '正在' + alt.action.name + '（' + alt.object.name + '）', toast: name + '：' + alt.action.name, hold: held.hold };
                        }
                    }
                }
                if (!held.ok) throw new Error('游戏没有开始：' + what);
                return { ok: true, note: '正在' + what + where, toast: name + '：' + what, hold: held.hold };
            }
            default:
                throw new Error('unsupported step ' + step.type);
        }
    }

    async execute(steps, pair, snap, cfg) {
        const results = [];
        let interrupted = false;
        let startedAfterInterrupt = false;
        let hold = null;
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (step.type === 'stop_current') {
                interrupted = true;
                startedAfterInterrupt = false;
            }
            const physicalStep = isPhysicalStep(step);
            // This batch is the part that has to start now. Later steps are started by the follower
            // after this one actually finishes, because a queued action is often dropped.
            if (physicalStep) step.insertFront = !startedAfterInterrupt;
            try {
                const r = await this.runStep(step, pair, snap, cfg);
                results.push(Object.assign({ type: step.type }, r));
                this.log.info('action ' + step.type + (step.interaction ? ' ' + step.interaction.id : '') +
                    (step.objectName ? ' @' + step.objectName : '') +
                    (step.place ? ' ' + step.place.id : '') + ' -> ' + (r.skipped ? 'skipped' : 'ok') + ' (' + r.note + ')');
                if (physicalStep && r.ok && !r.skipped && interrupted) startedAfterInterrupt = true;
                if (r.hold) {
                    r.hold.kind = step.kind || actionKind(step.interaction && step.interaction.id, step.interaction && step.interaction.name);
                    r.hold.label = (step.interaction && step.interaction.name) || r.hold.bagId;
                    r.hold.want = step.want || '';
                    r.hold.objectName = step.objectName || step.targetName || '';
                    if (step.lesson) r.hold.lesson = step.lesson;
                    if (step.chore) r.hold.chore = step.chore;
                    r.hold.ageGroup = (snap && snap.partner && snap.partner.ageGroup) || '';
                    if (step.forWhom) {
                        r.hold.forWhom = step.forWhom;
                        r.hold.foodBefore = r.hold.check && r.hold.check.foods ? r.hold.check.foods : (this.foodIds ? this.foodIds() : []);
                    }
                    if (!hold) hold = r.hold;
                }
                if (cfg.notify_toast && r.toast && !r.skipped) {
                    await this.game.soft('toast_show', { Message: r.toast, Lifetime: 5 });
                }
            } catch (e) {
                if (e instanceof ScheduleBusyError) {
                    // The timetable started in the meantime: the rest waits for it, it has not failed.
                    results.deferred = steps.slice(i).filter((s) => s.type !== 'stop_current');
                    results.scheduled = e.held;
                    this.log.info('action ' + step.type + ' waits: ' + e.message + ', ' + results.deferred.length + ' step(s) kept for later');
                    break;
                }
                if (e instanceof TakenError) {
                    results.push({ type: step.type, ok: false, note: e.message, taken: e.taken });
                    this.log.info('action ' + step.type + (step.objectName ? ' @' + step.objectName : '') + ' not started: ' + e.message);
                    continue;
                }
                results.push({ type: step.type, ok: false, note: e.message });
                this.log.warn('action ' + step.type + ' failed: ' + e.message);
            }
        }
        results.hold = hold;
        this.listCache.clear();
        this.useCache.clear();
        return results;
    }
}

module.exports = { Actions, TakenError, placeText, placeBags, useThen, placeThen, ACTION_TYPES, canonicalType, arrangePlan, actionKind, cookRank, taskGuardDecision, activityMontages, isWalking, wrapUpSeconds };
