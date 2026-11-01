'use strict';
// The bridge service: watches every phone conversation (<playerId>-<contactId>), answers pending
// texts in character with the LLM, runs the validated in-game actions, keeps memory, sends
// occasional messages first, and publishes presence to status.cfg so the phone can show
// Online / Typing / errors per contact. A-B and B-A are read as one shared conversation
// (see mailbox.js); the AI only ever writes as the contact of the character being played.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const fsx = require('./fsx');
const { GameClient, GameOfflineError } = require('./game');
const { World, PairError, fullName } = require('./world');
const { Mailbox, sanitizeText, gameStamp, threadKey, parseKey } = require('./mailbox');
const { LlmClient, LlmError } = require('./llm');
const { Actions, TakenError, arrangePlan, actionKind, isWalking, placeText, placeBags, useThen, placeThen } = require('./actions');
const { MemoryStore, Diary, BridgeState, sameFact, factGrams, FACTS_V } = require('./memory');
const { Moments } = require('./moments');
const { Portraits } = require('./portraits');
const { Photos } = require('./photos');
const { Journal } = require('./journal');
const { Buffs } = require('./buffs');
const { Meals } = require('./meals');
const { Freelance } = require('./freelance');
const { Stories } = require('./stories');
const { Legacy } = require('./legacy');
const { Ties } = require('./ties');
const { Aging } = require('./aging');
const paths = require('./paths');
const emoji = require('./emoji');
const { Preferences } = require('./preferences');
const { KnowHow, replayable, taskKey } = require('./knowhow');
const { Agenda, parsePromise, describeDue, gameMinute } = require('./agenda');
const { Personas } = require('./personas');
const { Realism } = require('./realism');
// Group chats on the phone (several contacts in one conversation). Named chatGroups: the daemon
// already has travelling "zoi groups" of its own.
const { Groups: ChatGroups } = require('./groups');
const { Incidents } = require('./incidents');
const { Rooms } = require('./rooms');
const chores = require('./chores');
const { Verifier } = require('./verify');
const { MODES: MEAL_MODES, MEAL_PREFIX } = require('./meals');
const { Needs } = require('./needs');
const { SiteMemory } = require('./sitememory');
const { Scene } = require('./scene');
const { Chronicle } = require('./chronicle');
const { recall, whenText } = require('./recall');
const { UsageMeter } = require('./usage');
const aftermath = require('./aftermath');
const { Households, describe: describeHousehold } = require('./households');
const persona = require('./persona');
const objectFocus = require('./object-focus');
const { isScheduledBag, isScheduleCancel, scheduleKind, ScheduleBusyError } = require('./schedule');

const VERSION = '2.51.2';
// Exit code asking the guardian for an immediate restart: the files now belong to another household.
const RESTART_EXIT_CODE = 75;
const HOUSEHOLD_CHECK_MS = 3000;
const PROMISE_KEEP_MS = 30 * 60000;
// A held task cut off with more than this much playtime left was interrupted, not finished.
const UNFINISHED_LEFT_S = 5;
// Who ended a held task, by the game's cancel reason. The player, a possession switch or an
// emergency is obeyed; anything else (autonomy, a reaction, a life trigger) is taken back once.
const OBEY_CANCEL_RE = /^User|ChangePossess|Emergency|Fire|Death|Teleport/;
const JOURNAL_SETTLE_MS = 1500;
// Cleaning interactions (Clean_Bath01, Clean_Toilet…, mopping, wiping, dishes) and how long one is
// let run before the next planned step: a full bathtub scrub took about 3.5 minutes.
const CLEANING_RE = /^Clean_|_Clean(_|$)|Wipe|Mop|Sweep|Dust|Wash_?Dish|Scrub/i;
const CLEANING_FINISH_MS = 4 * 60000;
const CONTACT_FACES_MS = 5 * 60000;
// Someone outside the household counts as with the played character within this distance; only
// then may a reply move them, and only with these.
const OUTSIDER_NEAR_M = 30;
const OUTSIDER_ACTIONS = ['stop_current', 'go_to_player', 'interact', 'emote'];
// A loaded save that has not heard from the HouseholdJournal Lua mod this long (it beats every few
// seconds) has the mod not running. The service never remounts it: in the game, mounting one Lua
// path shuts down and restarts every Lua mod in that sandbox while the world is live, and with
// other script mods loaded that ended in EXCEPTION_ACCESS_VIOLATION a second later (UECC crash of
// 2026-10-25, three game disconnects each right after a remount in the same customer's log).
const JOURNAL_QUIET_MS = 45000;
const FOLLOW_PAUSE_MAX_MS = 10 * 60000;
// Longest a plan waits for school or work to let the character go. A whole school or work day
// at normal game speed fits; past this the texts that asked for it are long over.
const SCHEDULE_WAIT_MAX_MS = 4 * 3600000;
const BODY_WATCH_MS = 3000;
// Failures a moment apart are told in one text.
const SETBACK_SETTLE_MS = 3000;
// Steps that end within a few seconds of each other are told together.
const PROGRESS_SETTLE_MS = 4000;
const PROGRESS_GAP_MS = 25000;
const PROGRESS_KEEP_MS = 10 * 60000;
const WANT_CONTEXT_MESSAGES = 6;
// Skills listed to the model under K1, K2 ...; things looked at when one is replayed.
const SKILLS_SHOWN = 24;
const SKILL_REPLAY_OBJECTS = 6;
const PROMISES_MAX = 6;
const KEEP_SETTLE_MAX = 8;
// Someone else was on the thing: the character is reminded to try again this much game time later.
const TAKEN_RETRY_GAME_MIN = 30;
// A queued step finds its thing taken: it waits this long between tries before giving up.
const TAKEN_FOLLOW_WAIT_MS = 60000;
const TAKEN_FOLLOW_TRIES = 3;
// The game clock seen by the last snapshot is trusted this long for things noted without one.
const ENV_FRESH_MS = 5 * 60000;
// The player stopped it or took the character over; nothing to explain.
const PLAYER_CANCEL_RE = /^User|ChangePossess/;
const JUST_TALKED_MS = 3 * 60000;
// An emergency that ended or a turning point (incidents.js) not told within this long is left to
// come up in conversation instead of arriving as a late text.
const INCIDENT_TELL_MS = 20 * 60000;
// Something just finished stays worth telling this long.
const SHARE_KEEP_MS = 6 * 60000;
// Bubbles further apart than this were separate sends.
const SEND_GAP_MS = 60000;
// After cooking for someone, how long the new dish may take to show up in the mod's food report
// (printed every 30 s) before it is told as not found.
const COOKED_DISH_WAIT_MS = 100000;
// An outing with the player lasts at most this long; parted for this long, it is over.
const TOGETHER_KEEP_MS = 3 * 3600000;
const TOGETHER_APART_MS = 3 * 60000;
// The newest remembered facts always in the prompt; older ones come back when talked about.
const SHOWN_FACTS = 8;
const SAME_TASK_KEEP_MS = 12 * 3600000;
const SAME_TASK_MAX = 500;
// What a want is about when the one it is for gets something to eat or drink.
const FOOD_WANT_RE = /吃|喝|饭|菜|食|饿|餐|点心|零食|汤|面|粥|虾|鱼|肉|排|蛋糕|披萨|水果|饮料|端|盛/;

// The model's tidied list as facts, each dated by the newest of the facts it came from, or null
// when the answer does not fit what it was given.
function tidiedFacts(r, listed) {
    if (!r || !Array.isArray(r.facts)) return null;
    const out = [];
    const texts = new Set();
    for (const item of r.facts) {
        const text = item && String(item.text || '').replace(/\s+/g, ' ').trim();
        const from = item && Array.isArray(item.from) ? item.from.map(Number).filter((n) => n >= 1 && n <= listed.length) : [];
        if (!text || text.length < 2 || text.length > 80 || !from.length || texts.has(text)) continue;
        const src = from.map((n) => listed[n - 1]);
        const f = { text, at: Math.max.apply(null, src.map((x) => x.at || 0)) };
        const days = src.map((x) => x.day).filter((d) => typeof d === 'number');
        if (days.length) f.day = Math.max.apply(null, days);
        texts.add(text);
        out.push(f);
    }
    if (!out.length || out.length > listed.length) return null;
    // Keeping almost nothing would be the model misreading the task, not the facts.
    if (listed.length >= 8 && out.length < listed.length * 0.15) return null;
    return out.sort((a, b) => a.at - b.at);
}

// The newest facts, skipping one that says much the same as a newer one already picked, so the
// few always shown are about different things.
function variedFacts(facts, count) {
    const picked = [];
    for (let i = facts.length - 1; i >= 0 && picked.length < count; i--) {
        if (sameFact(picked, facts[i].text)) continue;
        picked.unshift(facts[i]);
    }
    return picked;
}

// Words that carry no topic of their own however often they are said.
const PLAIN_WORDS = new Set(('妈妈 爸爸 宝贝 我们 你们 他们 一下 这个 那个 什么 怎么 可以 就是 还是 已经 现在 一起 知道 没有 不是 ' +
    '我的 你的 好的 一点 有点 真的 刚才 刚刚 这就 马上 等我 我去 我在 我也 我想 你看 你听 好呀 好啊 起来 过去 回来 一个 ' +
    '这样 那样 因为 所以 但是 不过 然后 我就 我会 我要 不要 不用 还没 好像 觉得 一会 喜欢 我把 给你 跟你').split(' '));
// A phrase starting or ending on one of these is grammar around a word, not the word.
const WORN_EDGE = new Set('我你他她它的了在就还去来把给跟和也都很是吗呢啦呀吧哦嗯着过要会想说这那上下个再又才刚先让被对'.split(''));
const WORN_SPAN = 30;
const WORN_MIN = 4;
const WORN_SHARE = 0.15;
const WORN_MAX = 6;
// 像 making a comparison; 好像 (seems), 图像, 画像 are not one.
const SIMILE_RE = /(^|[^好想图影画偶录肖])像/;

// What the character keeps saying in its own recent texts: phrases in several of them, and
// whether most come with a 像…一样. Words the other person just used are the topic, not a habit.
function wornPhrases(messages, avoid) {
    // Typed by the player while playing this character: not a habit of the model's.
    const own = messages.filter((m) => m.side === 'partner' && m.kind !== 'typed').slice(-WORN_SPAN).map((m) => String(m.text || ''));
    const out = { phrases: [], simile: false };
    if (own.length < 6) return out;
    const skip = String(avoid || '');
    const counts = new Map();
    for (const text of own) {
        const seen = new Set();
        for (const part of text.split(/[^\u3400-\u9fff]+/)) {
            for (let n = 2; n <= 5; n++) {
                for (let i = 0; i + n <= part.length; i++) seen.add(part.slice(i, i + n));
            }
        }
        for (const g of seen) counts.set(g, (counts.get(g) || 0) + 1);
    }
    const bar = Math.max(WORN_MIN, Math.ceil(own.length * WORN_SHARE));
    const cands = [];
    for (const [g, c] of counts) {
        if (c < bar || PLAIN_WORDS.has(g) || skip.indexOf(g) >= 0) continue;
        if (WORN_EDGE.has(g[0]) || WORN_EDGE.has(g[g.length - 1])) continue;
        cands.push({ g, c });
    }
    cands.sort((a, b) => b.g.length - a.g.length || b.c - a.c);
    const chosen = [];
    for (const x of cands) {
        // A piece of a longer phrase already listed is the same habit.
        if (chosen.some((y) => y.g.indexOf(x.g) >= 0 && x.c <= y.c + 1)) continue;
        chosen.push(x);
    }
    out.phrases = chosen.sort((a, b) => b.c - a.c).slice(0, WORN_MAX).map((x) => x.g);
    const similes = own.filter((t) => SIMILE_RE.test(t)).length;
    out.simile = similes >= 4 && similes / own.length >= 0.25;
    return out;
}

// How many separate texts the character sent on its own since the player last wrote. A reply
// to the player is an answer, not something waiting for one.
function unansweredSends(messages) {
    let sends = 0;
    let newer = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.side !== 'partner' || m.kind !== 'proactive') break;
        if (!newer || newer.at - m.at > SEND_GAP_MS) sends += 1;
        newer = m;
    }
    return sends;
}
const PID_FILE = path.join(config.DATA_DIR, 'bridge.pid.json');
const STOP_FILE = path.join(config.DATA_DIR, 'stop.request');
const QUIRKS_FILE = path.join(config.DATA_DIR, 'llm-quirks.json');
// The last outcome of an AI call, read by the guardian for the phone's AI settings screen.
const HEALTH_FILE = path.join(config.DATA_DIR, 'llm-health.json');
const USAGE_FILE = path.join(config.DATA_DIR, 'llm-usage.json');
const SAME_TASK_FILE = path.join(config.DATA_DIR, 'same-task.json');
const SITE_MEMORY_FILE = path.join(config.DATA_DIR, 'site-objects.json');

const PAIR_ERROR_TEXT = {
    not_in_household: 'Not in the active household',
    contact_elsewhere: 'Not in the active household',
    cannot_text: 'Too young to text'
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// The chronicle's line for an emergency or turning point; only what the game showed.
function incidentChronicleText(type, inc, names) {
    if (type === 'notice') return inc.text || '';
    const fought = Object.keys(inc.people || {}).filter((id) => inc.people[id].phase === 'fought')
        .map((id) => names.get(String(id))).filter(Boolean);
    const people = Object.keys(inc.people || {}).map((id) => names.get(String(id))).filter(Boolean);
    if (inc.kind === 'fire') {
        if (type === 'start') return '家里着火了';
        return '家里的火被扑灭了' + (fought.length ? '，是' + fought.join('、') + '扑灭的' : '') + (inc.detail.firefighters ? '，消防员也赶来了' : '');
    }
    if (inc.kind === 'accident') {
        return type === 'start' ? (people.length ? people.join('、') : '家里有人') + '遇上了车祸' : '车祸的事处理完了';
    }
    if (inc.kind === 'disaster') {
        return type === 'start' ? '城里闹起了' + inc.detail.label : inc.detail.label + '过去了';
    }
    return '';
}

// A fire or an accident is going on: answers come fast, the way a person in one texts.
function inCrisis(snap) {
    return !!(snap && snap.incidents && snap.incidents.some((i) => i.active && i.grave));
}

function physicalCount(steps) {
    let n = 0;
    for (let i = 0; i < (steps || []).length; i++) if (hasPhysicalStep([steps[i]])) n++;
    return n;
}

function promiseKey(s) {
    return String(s || '').replace(/[\s，。、！？!?,.;；:："“”'‘’（）()…~～-]+/g, '');
}

// "喷壶和爬犁" is two things. Matching the whole phrase against one object name never hits.
function findTerms(thing) {
    const raw = promiseKey(thing);
    if (!raw) return [];
    const parts = raw.split(/和|与|跟|以及|还有/).filter((s) => s.length >= 2);
    return parts.length ? parts : [raw];
}

const PUT_DOWN_RE = /^(AutoFind_PutDown|PutDown|PutDown_Target|PutDown_Surface|MoveTo_PutDown)$/;
const TAKE_OUT_BAG_RE = /^(AutoFind_PutDown_Inventory|GrabInventory\w*)$/;
const CARRY_KEEP = 8;
const NEIGHBOUR_CM = 250;
const NEIGHBOUR_MAX = 3;
const CARRY_SHOW_MS = 3 * 60 * 60 * 1000;

function nameMatches(name, term) {
    const full = promiseKey(name);
    const bare = full.replace(/^(普通|小型|大型|迷你)/, '');
    if (!full || !term) return false;
    if (full.indexOf(term) >= 0 || term.indexOf(full) >= 0) return true;
    return !!(bare && bare !== full && (bare.indexOf(term) >= 0 || term.indexOf(bare) >= 0));
}

// A step is taken to carry out a promise when one's words contain the other's.
function coversPromise(step, what) {
    const a = promiseKey(what);
    const b = promiseKey(step.want || (step.interaction && step.interaction.name) || (step.skill && step.skill.task) || (step.place && step.place.name) || '');
    if (!a || !b) return false;
    return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
}

function hasPhysicalStep(steps) {
    for (let i = 0; i < (steps || []).length; i++) {
        const t = steps[i].type;
        if (t === 'use_object' || t === 'go_home' || t === 'go_to_player' || t === 'go_to_place' || t === 'go_together' || t === 'interact') return true;
    }
    return false;
}

// One queued step in words, as the character would say what it is about to do.
function stepText(s, call) {
    if (!s) return '';
    switch (s.type) {
        case 'use_object':
            return s.want || (s.interaction ? s.interaction.name + (s.objectName ? '（' + s.objectName + '）' : '') : '');
        case 'interact':
            return s.want || (s.interaction ? (s.targetName ? '对' + s.targetName : '') + s.interaction.name : '');
        case 'go_to_place':
            return s.place ? '去' + s.place.name : '';
        case 'go_together':
            return '和' + call + '一起' + (s.place ? '去' + s.place.name : '走');
        case 'go_home':
            return '回家';
        case 'go_to_player':
            return '去找' + call;
        default:
            return s.want || '';
    }
}

function proximityText(prox) {
    if (typeof prox.distance === 'number') return prox.distance.toFixed(1) + ' m apart';
    return prox.sameSite ? 'same site (distance unknown)' : 'not nearby';
}

function environmentAsk(env, t) {
    if (!env) return '';
    if (env.is_disaster) {
        return '外面正在发生灾害，你害怕，想让' + t.call + '赶紧回来，或者告诉你现在安不安全。';
    }
    const temp = typeof env.temperature === 'number' ? env.temperature : null;
    const weather = String(env.weather || '');
    if (temp !== null && temp <= 5) {
        return '外面很冷（' + temp + '°C），你想让' + t.call + '注意保暖，或者早点回来。';
    }
    if (temp !== null && temp >= 35) {
        return '外面很热（' + temp + '°C），你想让' + t.call + '注意避暑，或者给你弄点凉的。';
    }
    if (/rain|storm|snow|thunder|blizzard|暴雨|雷|雪|雨/i.test(weather) && !/^sun$/i.test(weather)) {
        return '外面天气不好（' + weather + '），你想让' + t.call + '出门小心，或者早点回来。';
    }
    return '';
}

class AlreadyRunningError extends Error {}

// The texts of a thread were typed as a character the user no longer plays. They stay pending
// until the user plays that character again or answers them while playing the contact.
class NotPlayedError extends Error {}

// A failed lookup is not evidence that an object is absent.
function actionFailure(error, stage) {
    const name = error && error.name;
    const code = name === 'LlmError' ? 'model_error' : /^Game/.test(name || '') ? 'game_error' : 'internal_error';
    return { code, stage, why: code === 'game_error'
        ? '暂时没能确认这里的东西能怎么用，还没做成；不能据此说没找到东西'
        : '刚才没能把答应的事安排起来，还没做成；没有确认东西不存在，也没有实际走动查找' };
}

class Daemon {
    constructor(log) {
        this.log = log;
        this.jobs = new Map();
        this.status = new Map();
        this.timers = [];
        this.stopping = false;
        this.summarizing = new Set();
        this.sameTaskCache = new Map();
        this.sameTaskDirty = false;
        this.households = null;
        this.household = null;
        this.householdOk = false;
        this.householdNote = '';
        this.switching = false;
        this.proactiveBusy = false;
        this.trackerBusy = false;
        this.clearBusy = false;
        this.clearedAt = 0;
        this.fingerprint = '';
        this.game = null;
        this.llm = null;
        this.moments = new Moments(this);
        this.momentsTracking = false;
        this.chatGroups = new ChatGroups(this);
        this.portraits = new Portraits(this.log);
        this.buffs = new Buffs(this);
        this.meals = new Meals(this);
        this.freelance = new Freelance(log);
        this.stories = new Stories(this);
        // Growing up and passing away, kept for the family (legacy.js).
        this.legacy = new Legacy(this);
        // How the household feel about each other, and what they hold against each other (ties.js).
        this.ties = new Ties(this);
        // Ages in days, and how long until each of them grows up, grows old or dies (aging.js).
        this.aging = new Aging({ log: this.log });
        // Whether the HouseholdJournal Lua mod runs in this game session (watchJournal).
        this.journalWatch = { since: Date.now(), modAt: 0, modFound: false, told: '' };
        this.preferences = new Preferences(this);
        this.knowhow = new KnowHow(config.DATA_DIR, log);
        this.agenda = new Agenda(log);
        this.personas = new Personas(log);
        this.realism = new Realism(log);
        this.incidents = new Incidents(log);
        this.incidents.onChange((c) => this.onIncident(c));
        this.trackAgain = false;
        this.lastEnv = null;
        this.needs = new Needs(this);
        this.verifier = new Verifier(this, (entry, v) => this.onVerdict(entry, v));
        this.setbackTimers = new Map();
        this.progressTimers = new Map();
        this.bodyLocks = new Map();
        this.objectFocus = new Map();
    }

    // ---------------------------------------------------------------- configuration
    applyConfig() {
        const info = config.load();
        this.cfg = info.config;
        this.apiKeySource = info.apiKeySource;
        this.fingerprint = config.fingerprint();
        this.log.setLevel(this.cfg.log.level);
        for (const p of info.problems) this.log.warn('config: ' + p);
        if (info.created) this.log.info('created ' + config.CONFIG_FILE);
        this.mailbox = new Mailbox({ dir: this.cfg.mailbox.dir, keep: this.cfg.mailbox.keep, textMax: this.cfg.mailbox.text_max });
        this.photos = new Photos(path.dirname(this.cfg.mailbox.dir), this.log);
        if (!this.game || this.game.url !== this.cfg.game.url) {
            this.game = new GameClient({ url: this.cfg.game.url, timeoutMs: this.cfg.game.timeout_ms, log: this.log });
            this.world = new World(this.game, this.log);
            // Ages come from the Lua mod rather than the game's tables (aging.js).
            this.world.aging = this.aging;
            this.siteMemory = this.siteMemory || new SiteMemory(SITE_MEMORY_FILE, this.log);
            this.actions = new Actions(this.game, this.world, this.log, this.siteMemory);
            this.actions.judge = (hold, cur) => this.sameTask(hold, cur);
            this.actions.foodState = (id) => (this.cfg.journal.enabled && this.journal ? this.journal.foodState(id) : null);
        } else {
            this.game.timeoutMs = this.cfg.game.timeout_ms;
        }
        this.actions.meals = this.meals;
        this.actions.realism = this.realism;
        this.actions.incidents = this.incidents;
        this.actions.foodIds = () => this.reportedFoodIds();
        this.actions.beforeTask = (actorId, step) => this.verifier.before(actorId, step);
        const llmOptions = Object.assign({}, this.cfg.llm, { apiKey: info.apiKey, log: this.log, quirks_file: QUIRKS_FILE });
        if (this.llm) {
            const same = this.llm.baseUrl + '|' + this.llm.model + '|' + this.llm.apiKey;
            this.llm.update(llmOptions);
            if (same !== this.llm.baseUrl + '|' + this.llm.model + '|' + this.llm.apiKey) this.llm.health = null;
        } else {
            this.llm = new LlmClient(llmOptions);
        }
        this.usage = this.usage || new UsageMeter(USAGE_FILE, this.log);
        this.llm.onUsage = (e) => this.usage.record(e);
        this.writeLlmHealth(true);
        this.memory = new MemoryStore(config.DATA_DIR, this.cfg.memory);
        this.diary = this.diary || new Diary(config.DATA_DIR, this.cfg.tracker.diary_keep);
        this.diary.keep = this.cfg.tracker.diary_keep;
        this.state = this.state || new BridgeState(config.DATA_DIR);
        this.wireGroups();
        this.moments.configure(config.DATA_DIR);
        this.chatGroups.configure(config.DATA_DIR);
        this.portraits.configure(path.dirname(this.cfg.mailbox.dir));
        this.personas.configure(path.dirname(this.cfg.mailbox.dir));
        if (this.households) this.households.configure(path.dirname(this.cfg.mailbox.dir));
        if (this.household) this.scopePortraits(this.household.tag);
        this.scene = this.scene || new Scene(this, config.DATA_DIR);
        this.chronicle = this.chronicle || new Chronicle(this, config.DATA_DIR);
        this.actions.onOuting = (o) => this.chronicleOuting(o);
        this.rooms = this.rooms || new Rooms(path.join(config.DATA_DIR, 'rooms.json'), this.log);
        this.actions.roomsFor = (snap) => this.roomLabeler(snap);
        const journalFile = this.cfg.journal.log_file || undefined;
        if (!this.journal || (journalFile && this.journal.file !== journalFile)) {
            this.journal = new Journal({ file: journalFile, log: this.log });
            // First: what follows (the plans, the scene) must already know an emergency began.
            this.journal.onEvent((ev) => this.incidents.onJournal(ev));
            this.journal.onWorld((ev) => this.onWorldEvent(ev));
            this.journal.onEvent((ev) => this.scene.onEvent(ev));
            this.journal.onEvent((ev) => {
                if (ev && ev.kind === 'started') this.rooms.noteSleep(ev.actor, ev.bag, ev.target);
            });
            this.journal.onEvent((ev) => this.onJournalEvent(ev));
            this.journal.onEvent((ev) => this.chronicleJournal(ev));
            this.journal.onBuff((res) => this.buffs.onResult(res));
            this.journal.onMeal((res) => this.meals.onResult(res));
            this.journal.onFreelance((kind, body) => this.freelance.onLine(kind, body));
            this.journal.onPref((res) => this.preferences.onResult(res));
            this.journal.onAge((entries) => this.aging.setReport(entries));
            this.journal.onRestart(() => {
                this.householdOk = false;
                this.incidents.reset();
                this.chronicle.rebase();
                this.meals.reset();
                this.freelance.reset();
                this.preferences.reset();
                this.aging.reset();
                this.forgetCarriedState('the game loaded another world');
            });
        }
        this.buffs.configure(config.DATA_DIR);
        this.meals.configure();
        this.preferences.configure(config.DATA_DIR);
        this.freelance.configure(path.join(path.dirname(this.cfg.mailbox.dir), 'freelance'));
        emoji.configure(path.dirname(this.cfg.mailbox.dir));
        this.needs.configure(config.DATA_DIR);
        this.stories.configure(config.DATA_DIR);
        this.legacy.configure(config.DATA_DIR);
        this.ties.configure(config.DATA_DIR);
        this.aging.configure(config.DATA_DIR);
        for (const job of this.jobs.values()) {
            job.blockedFingerprint = null;
            job.nextTryAt = 0;
        }
        this.log.info('config loaded: mode=' + this.cfg.mode + ' model=' + this.cfg.llm.model +
            ' thinking=' + this.cfg.llm.thinking + ' @ ' + this.cfg.llm.base_url +
            ' key=' + (info.apiKey ? 'set (' + info.apiKeySource + ')' : 'MISSING') + ' actions=' + (this.cfg.actions.enabled ? 'on' : 'off'));
    }

    // ---------------------------------------------------------------- lifecycle
    acquirePidLock(force) {
        fsx.ensureDir(config.DATA_DIR);
        const r = fsx.readJson(PID_FILE);
        if (r.ok && r.value && r.value.pid && r.value.pid !== process.pid && fsx.isProcessAlive(r.value.pid) && !force) {
            throw new AlreadyRunningError('bridge already running (pid ' + r.value.pid + ', started ' + new Date(r.value.startedAt).toLocaleString() + ')');
        }
        fsx.writeJson(PID_FILE, { pid: process.pid, startedAt: Date.now(), version: VERSION }, true);
    }

    releasePidLock() {
        const r = fsx.readJson(PID_FILE);
        if (r.ok && r.value && r.value.pid === process.pid) {
            try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
        }
    }

    // Loops that read or write anything about the characters wait until the files on disk are
    // known to be those of the household being played. `always` loops keep the service itself up.
    every(ms, fn, always) {
        let running = false;
        const t = setInterval(() => {
            if (running || this.stopping || this.switching) return;
            if (!always && !this.householdOk) return;
            running = true;
            Promise.resolve().then(fn).catch((e) => this.log.error('loop error: ' + (e && e.stack || e))).then(() => { running = false; });
        }, ms);
        this.timers.push(t);
    }

    async start(options) {
        const o = options || {};
        const early = config.load().config;
        this.acquirePidLock(o.force);
        this.households = new Households({ dataDir: config.DATA_DIR, phoneDir: path.dirname(early.mailbox.dir), log: this.log });
        // Nothing may read the character files while a switch is half done.
        this.households.load();
        if (this.households.pending()) this.households.resume();
        this.sameTaskCache = this.loadSameTask();
        this.applyConfig();
        try { fs.unlinkSync(STOP_FILE); } catch (e) { /* no stale request */ }
        const cur = this.households.current();
        this.log.info('inZOI SMS bridge ' + VERSION + ' started, pid ' + process.pid + ', mailbox ' + this.cfg.mailbox.dir +
            ', files of ' + describeHousehold(cur));
        if (cur) this.scopePortraits(cur.tag);
        this.every(500, () => this.tick());
        this.every(3000, () => this.moments.tick());
        this.every(1000, () => this.chatGroups.tick());
        this.every(5000, () => this.heartbeat(), true);
        this.every(2000, () => this.watchConfig(), true);
        this.every(HOUSEHOLD_CHECK_MS, () => this.checkHousehold(), true);
        this.every(this.cfg.tracker.interval_ms, () => this.track());
        this.every(4000, () => this.followThrough());
        this.every(500, () => this.readJournal());
        this.every(5000, () => this.incidents.tick());
        this.every(5000, () => this.buffs.expire());
        this.every(5000, () => this.meals.expire());
        this.every(5000, () => this.preferences.expire());
        this.every(30000, () => this.preferences.load());
        this.every(30000, () => this.rememberSite());
        this.every(BODY_WATCH_MS, () => this.watchBodies());
        this.every(20000, () => this.tendGroups());
        this.every(2500, () => this.verifier.tick());
        this.every(this.cfg.memory.chronicle_interval_ms, () => this.watchChronicle());
        this.every(15000, () => { this.usage.flush(); this.saveSameTask(); }, true);
        await this.heartbeat();
        await this.checkHousehold().catch((e) => this.log.warn('household check failed: ' + (e && e.message || e)));
        if (this.switching) return;
        if (this.householdOk) this.track().catch((e) => this.log.warn('first track failed: ' + e.message));
        const pairs = (this.state.value && this.state.value.pairs) || {};
        for (const key of Object.keys(pairs)) if (this.liveSetbacks(key).length) this.scheduleSetback(key, 10000);
        this.tidyFacts().catch((e) => this.log.warn('memory tidy: ' + (e && e.message || e)));
    }

    // Facts saved before they were checked for repeats are gone through once by the model, after
    // a copy of the file is put aside. A failed try is tried again at the next start.
    async tidyFacts() {
        const cur = this.households.current();
        const roster = (cur && cur.roster) || {};
        const nameOf = (id) => (roster[id] && roster[id].full) || String(id);
        for (const c of this.memory.untidied()) {
            if (this.stopping || this.switching) return;
            const key = c.playerId + '-' + c.partnerId;
            if (this.summarizing.has(key)) continue;
            this.summarizing.add(key);
            try {
                const mem = this.memory.load(c.playerId, c.partnerId);
                const listed = mem.facts.slice();
                if (listed.length < 2) {
                    this.memory.markTidied(c.playerId, c.partnerId);
                    continue;
                }
                const backup = this.memory.backup(c.playerId, c.partnerId, path.join(config.DATA_DIR, 'backup', 'memory-v' + FACTS_V));
                if (!backup) continue;
                const prompt = persona.factsTidyPrompt(mem.summary, listed, nameOf(c.partnerId), nameOf(c.playerId));
                const r = await this.llm.json(prompt.system, prompt.user, { temperature: 0.2, purpose: 'memory_tidy' });
                const next = tidiedFacts(r, listed);
                if (!next) {
                    this.log.warn('memory tidy [' + key + ']: the answer did not fit the ' + listed.length + ' fact(s), left as they were');
                    continue;
                }
                const total = this.memory.replaceFacts(c.playerId, c.partnerId, listed, next);
                this.log.info('memory tidy [' + key + ']: ' + listed.length + ' fact(s) -> ' + next.length + ' (now ' + total + '), the old file is in ' + backup);
            } catch (e) {
                this.log.warn('memory tidy [' + key + ']: ' + (e && e.message || e) + '; tried again at the next start');
            } finally {
                this.summarizing.delete(key);
            }
        }
    }

    // ---------------------------------------------------------------- household
    // Reads the household being played straight from the game and compares it with the owner of
    // the files on disk. Ids the game gave to other people before mean another household.
    async checkHousehold() {
        if (this.switching || this.stopping) return;
        let phase;
        try {
            phase = await this.world.phase();
        } catch (e) {
            this.householdOff('game not reachable');
            return;
        }
        if (phase !== 'in_game') {
            this.householdOff('game phase is ' + phase);
            return;
        }
        let r;
        try {
            r = await this.game.call('household_get_members', {});
        } catch (e) {
            this.householdOff('household not readable: ' + (e && e.message || e));
            return;
        }
        if (this.switching || this.stopping) return;
        const hh = { id: r && r.household_id, name: r && r.name, members: (r && r.members) || [] };
        const d = this.households.identify(hh);
        if (!d) {
            this.householdOff('the game lists no household members');
            return;
        }
        if (d.kind === 'switch') {
            await this.switchHousehold(d);
            return;
        }
        if (d.kind === 'first') this.log.info('households: first household recorded, the files on disk are taken as ' + describeHousehold(d.entry));
        this.households.touch(d.entry, d.roster, d.name, d.householdId);
        const entry = this.households.current();
        if (!this.household || this.household.tag !== entry.tag || !entry.saves.length) this.pickPortraitSave(entry, Object.keys(d.roster));
        this.household = entry;
        if (!this.householdOk) {
            this.householdOk = true;
            this.householdNote = '';
            this.log.info('households: playing ' + describeHousehold(entry));
        }
    }

    householdOff(why) {
        if (!this.householdOk) return;
        this.householdOk = false;
        this.householdNote = why;
        this.log.info('households: paused until the played household is known again (' + why + ')');
    }

    // The save folder holding this household's portraits: the one with most of its members that
    // no household sharing its ids has claimed, newest first.
    pickPortraitSave(entry, ids) {
        const scope = this.households.portraitScope(entry.tag);
        const known = scope.prefer.filter((dir) => fs.existsSync(dir));
        if (known.length) {
            this.scopePortraits(entry.tag);
            return;
        }
        const options = this.portraits.saveFolders(ids).filter((f) => scope.avoid.indexOf(f.dir) < 0 && f.count > 0);
        options.sort((a, b) => b.count - a.count || b.newest - a.newest);
        if (options.length) {
            this.households.setSaves(entry.tag, [options[0].dir]);
            this.log.info('households: portraits of ' + describeHousehold(entry) + ' come from ' + options[0].dir);
        }
        this.scopePortraits(entry.tag);
    }

    scopePortraits(tag) {
        if (!this.households || !this.portraits) return;
        const scope = this.households.portraitScope(tag);
        this.portraits.scope(scope.prefer, scope.avoid);
    }

    // Everything kept in memory is written out first, so it lands in the household it belongs to;
    // then the files change hands and the service starts over on them.
    async switchHousehold(d) {
        if (this.switching) return;
        this.switching = true;
        this.householdOk = false;
        this.log.warn('households: the game is playing ' + describeHousehold(d.to) + (d.fresh ? ' (new)' : ' (played before)') +
            ', the files on disk are those of ' + describeHousehold(d.from) + '; switching');
        await this.stop();
        let code = RESTART_EXIT_CODE;
        try {
            const res = this.households.switchTo(d);
            this.log.info('households: ' + (d.fresh ? 'started empty files for ' : 'brought back the files of ') + describeHousehold(res.to) + '; restarting');
        } catch (e) {
            // The record of the moves stays; the next start carries the switch on.
            this.log.error('households: switch did not finish: ' + (e && e.stack || e));
            code = 1;
        }
        if (this.onRestart) this.onRestart(code);
        else process.exit(code);
    }

    // Travel groups the bridge started live in the bridge state, so a restart can still end them.
    wireGroups() {
        if (!this.actions || this.actions.groupsWired === this.state) return;
        this.actions.groupsWired = this.state;
        const saved = Array.isArray(this.state.value.together) ? this.state.value.together : [];
        for (const g of saved) {
            if (g && g.member && g.player && !this.actions.groups.has(String(g.member))) {
                this.actions.groups.set(String(g.member), {
                    player: String(g.player), at: Number(g.at) || Date.now(), place: g.place || null,
                    lead: !!g.lead, made: g.made !== false, site: g.site || '', apartAt: g.apartAt || 0
                });
            }
        }
        if (this.actions.groups.size) this.log.info('together: ' + this.actions.groups.size + ' outing(s) from before the restart are still tracked');
        this.actions.onGroupsChanged = () => {
            this.state.value.together = Array.from(this.actions.groups.entries()).map(([member, g]) => Object.assign({ member }, g));
            this.state.save();
        };
    }

    async tendGroups() {
        if (!this.actions || !this.actions.groups.size) return;
        try {
            await this.actions.tendGroups({ keepMs: TOGETHER_KEEP_MS, apartMs: TOGETHER_APART_MS });
        } catch (e) {
            if (!(e instanceof GameOfflineError)) this.log.warn('together: ' + (e && e.message || e));
        }
    }

    // Ids of the food in the Lua mod's latest report; empty when it is not reporting.
    reportedFoodIds() {
        if (!this.cfg.journal.enabled || !this.journal || !this.journal.alive() || !this.journal.food) return [];
        return Array.from(this.journal.food.keys()).filter((id) => this.journal.foodState(id));
    }

    // Records what is placed where the player is, for family members left there later.
    async rememberSite() {
        if (!this.cfg.actions.enabled || !this.actions) return;
        try {
            await this.actions.rememberPlayedSite();
        } catch (e) {
            if (e instanceof GameOfflineError) return;
            // In menus and loading screens there is no one to read; this runs every 30 s.
            this.log.debug('site memory scan skipped: ' + (e && e.message || e));
        }
    }

    // A walk can stay frozen under the animation of an activity it replaced, whoever started it:
    // the follower, an earlier reply that is no longer tracked, or the game's own autonomy.
    // Characters with a tracked task are left to the follower, which can also restart the task.
    async watchBodies() {
        if (!this.cfg.actions.enabled || !this.actions || !this.state || !this.state.value) return;
        const pairs = this.state.value.pairs || {};
        const actors = new Set();
        const tracked = new Set();
        for (const key of Object.keys(pairs)) {
            let contact = '';
            try { contact = parseKey(key).contactId; } catch (e) { continue; }
            if (contact) actors.add(String(contact));
            const plan = pairs[key] && pairs[key].follow;
            if (plan && plan.holding) tracked.add(String(plan.actorId));
        }
        if (!actors.size) return;
        let possessed = null;
        try { possessed = String(await this.world.possessed()); } catch (e) { return; }
        for (const actor of actors) {
            if (actor === possessed || tracked.has(actor)) {
                this.bodyLocks.delete(actor);
                continue;
            }
            const cur = await this.actions.currentOf(actor);
            if (!isWalking(cur)) {
                this.bodyLocks.delete(actor);
                continue;
            }
            let watch = this.bodyLocks.get(actor);
            if (!watch || watch.bagId !== String(cur.interaction_bag_id || '')) {
                watch = { bagId: String(cur.interaction_bag_id || '') };
                this.bodyLocks.set(actor, watch);
            }
            await this.actions.unstickWalk(actor, watch, cur);
        }
    }

    async stop() {
        if (this.stopping) return;
        this.stopping = true;
        for (const t of this.timers) clearInterval(t);
        for (const t of this.setbackTimers.values()) clearTimeout(t);
        this.setbackTimers.clear();
        for (const t of this.progressTimers.values()) clearTimeout(t);
        this.progressTimers.clear();
        for (const th of this.mailbox.threads()) {
            try {
                this.mailbox.writeStatus(th.key, this.statusPayload(th.key, Object.assign({}, this.status.get(th.key), { state: 'offline', error: 'Bridge stopped' })));
            } catch (e) { /* ignore */ }
        }
        this.moments.stopped();
        // Nobody would end an outing the bridge started once it is gone; the game is given a
        // few seconds, a closed game ends the groups itself.
        if (this.actions && this.actions.groups.size) {
            await Promise.race([
                this.actions.releaseAllGroups('bridge stopped').catch((e) => this.log.warn('ending travel groups: ' + e.message)),
                sleep(4000)
            ]);
        }
        if (this.siteMemory) this.siteMemory.flush();
        if (this.scene) this.scene.flush();
        if (this.rooms) this.rooms.flush();
        if (this.chronicle) this.chronicle.flush();
        if (this.usage) this.usage.flush();
        this.saveSameTask();
        this.releasePidLock();
        this.log.info('bridge stopped');
    }

    watchConfig() {
        if (fs.existsSync(STOP_FILE)) {
            try { fs.unlinkSync(STOP_FILE); } catch (e) { /* ignore */ }
            this.log.info('stop requested');
            this.stop().then(() => process.exit(0));
            return;
        }
        const fp = config.fingerprint();
        if (fp === this.fingerprint) return;
        this.log.info('config or secrets changed, reloading');
        try {
            this.applyConfig();
        } catch (e) {
            this.log.error('reload failed: ' + e.message);
            this.fingerprint = fp;
        }
    }

    // ---------------------------------------------------------------- presence
    job(key) {
        if (!this.jobs.has(key)) {
            this.jobs.set(key, { busy: false, nextTryAt: 0, failures: 0, blockedFingerprint: null });
        }
        return this.jobs.get(key);
    }

    setStatus(key, patch) {
        const prev = this.status.get(key) || {};
        const next = Object.assign({}, prev, patch);
        if (patch.state && patch.state !== prev.state) next.since = Date.now();
        this.status.set(key, next);
        try {
            this.mailbox.writeStatus(key, this.statusPayload(key, next));
        } catch (e) {
            this.log.warn('status write failed for ' + key + ': ' + e.message);
        }
    }

    statusPayload(key, s) {
        const base = s || this.status.get(key) || {};
        const k = parseKey(key);
        let state = base.state || 'online';
        let error = base.error || '';
        if (this.cfg.mode === 'off') { state = 'paused'; error = 'Auto replies are off'; }
        else if (this.cfg.mode === 'cursor' && state === 'online') state = 'manual';
        else if (this.cfg.mode === 'auto' && !this.llm.configured && state === 'online') { state = 'error'; error = 'AI not configured'; }
        return {
            v: 3,
            state,
            error,
            heartbeat: Date.now(),
            since: base.since || Date.now(),
            readAt: base.readAt || 0,
            playerId: k.playerId,
            contactId: k.contactId,
            partnerId: k.contactId,
            partnerName: base.partnerName || '',
            role: base.role || '',
            mode: this.cfg.mode,
            model: this.cfg.llm.model,
            bridge: VERSION
        };
    }

    writeLlmHealth(force) {
        const h = this.llm && this.llm.health;
        const text = JSON.stringify(h || null);
        if (!force && text === this.lastHealthText) return;
        this.lastHealthText = text;
        try {
            fsx.writeJson(HEALTH_FILE, { pid: process.pid, version: VERSION, configured: !!(this.llm && this.llm.configured), last: h || null }, true);
        } catch (e) {
            this.log.debug('llm health write failed: ' + e.message);
        }
    }

    async heartbeat() {
        this.writeLlmHealth(false);
        this.moments.heartbeat();
        // A signal the phone can read on its own: the AI page used to go by service.cfg, which
        // only the guardian writes, so a bridge run from a console looked disconnected.
        this.writeServiceBeat();
        for (const th of this.mailbox.threads()) {
            try {
                this.mailbox.writeStatus(th.key, this.statusPayload(th.key));
            } catch (e) {
                this.log.debug('heartbeat write failed for ' + th.key + ': ' + e.message);
            }
        }
    }

    // ui/phone/service/daemon.cfg: written here every few seconds while this process runs.
    writeServiceBeat() {
        try {
            const dir = path.join(path.dirname(this.cfg.mailbox.dir), 'service');
            fsx.ensureDir(dir);
            // No package.json in this tree: the version is optional, and must not stop the write.
            let version = '';
            try { version = require('../package.json').version || ''; } catch (e) { version = ''; }
            fsx.writeJson(path.join(dir, 'daemon.cfg'), {
                v: 1,
                heartbeat: Date.now(),
                state: 'running',
                mode: this.cfg.mode,
                provider: this.cfg.llm.provider,
                model: this.cfg.llm.model,
                version
            }, false);
        } catch (e) {
            this.log.debug('daemon.cfg not written: ' + e.message);
        }
    }

    // The phone writes sms/clear.cfg when the user confirms Clear. This empties every
    // conversation and the matching memory. A reply already being written is allowed to
    // finish first, so it cannot put one new bubble back into a thread we just erased.
    clearRequestAt() {
        const file = path.join(this.mailbox.dir, 'clear.cfg');
        const request = fsx.readJson(file);
        if (!request.ok || !request.value || typeof request.value.at !== 'number') return 0;
        if (!this.clearedAt) {
            const ack = fsx.readJson(path.join(this.mailbox.dir, 'cleared.cfg'));
            if (ack.ok && ack.value && typeof ack.value.at === 'number') this.clearedAt = ack.value.at;
        }
        return request.value.at > this.clearedAt ? request.value.at : 0;
    }

    chatBusy() {
        if (this.proactiveBusy || this.summarizing.size) return true;
        for (const job of this.jobs.values()) if (job.busy) return true;
        return false;
    }

    // The Lua mod's start id: it changes whenever a save is loaded, so it names the world now loaded.
    worldBoot() {
        return this.journal && this.cfg.journal.enabled ? this.journal.boot || '' : '';
    }

    // What this person did today in the world now loaded.
    todayDiary(id, env) {
        if (!env || !this.diary) return [];
        return this.diary.today(String(id), env.day, this.worldBoot());
    }

    // Everything the bridge carries from earlier conversations into the next prompt: promises,
    // setbacks still to be told, tasks just finished and the steps still to follow. Spoken in
    // chats that are gone, or about a world that is no longer loaded, they would keep the
    // character acting on things that are not true any more.
    forgetCarriedState(why, opts) {
        this.objectFocus.clear();
        const pairs = (this.state && this.state.value && this.state.value.pairs) || {};
        let n = 0;
        for (const key of Object.keys(pairs)) {
            const st = pairs[key];
            if (!st) continue;
            n += (st.promises || []).length + (st.setbacks || []).length + (st.finished || []).length + (st.follow ? 1 : 0);
            st.promises = [];
            // Agreements are kept in game time and outlive a reload; only clearing the chats ends them.
            if (opts && opts.agenda) {
                n += (st.agenda || []).length + (st.aftermath || []).length + (st.bond ? 1 : 0);
                st.agenda = [];
                st.aftermath = [];
                delete st.bond;
            }
            st.setbacks = [];
            st.finished = [];
            st.progress = [];
            st.carry = [];
            st.setbackAwait = false;
            delete st.follow;
            delete st.share;
            delete st.lastAct;
        }
        for (const t of this.setbackTimers.values()) clearTimeout(t);
        this.setbackTimers.clear();
        for (const t of this.progressTimers.values()) clearTimeout(t);
        this.progressTimers.clear();
        this.realism.reset();
        if (this.state) this.state.save();
        this.log.info('forgot ' + n + ' promise(s), setback(s), finished task(s) and plan(s): ' + why);
        return n;
    }

    watchClear() {
        const at = this.clearRequestAt();
        // A group line being written waits too, for the same reason as a reply.
        if (!at || this.clearBusy || this.chatBusy() || this.chatGroups.busy) return;
        this.clearBusy = true;
        try {
            const messages = this.mailbox.clearConversations();
            const groupMessages = this.chatGroups.clearMessages();
            if (groupMessages) this.log.info('cleared ' + groupMessages + ' group message(s) with the chats');
            const memory = this.memory.clearAll();
            // A story's history is told in those chats; it starts over with them.
            const stories = this.stories.clearAll();
            if (stories) this.log.info('cleared ' + stories + ' story file(s) with the chats');
            const grudges = this.ties.clearChat();
            if (grudges) this.log.info('cleared ' + grudges + ' grudge(s) that came from the chats');
            this.forgetCarriedState('chats cleared', { agenda: true });
            this.clearedAt = at;
            fsx.writeJson(path.join(this.mailbox.dir, 'cleared.cfg'), {
                at: at,
                doneAt: Date.now(),
                messages: messages + groupMessages,
                memory: memory
            });
            this.log.info('cleared chats: ' + messages + ' message(s), ' + memory + ' memory file(s)');
        } catch (e) {
            this.log.warn('clear chats failed: ' + (e && e.message || e));
        } finally {
            this.clearBusy = false;
        }
    }

    // ---------------------------------------------------------------- reply loop
    tick() {
        this.watchClear();
        const holdClear = !!this.clearRequestAt();
        const now = Date.now();
        for (const th of this.mailbox.threads()) {
            const key = th.key;
            const thread = this.mailbox.thread(key);
            if (!thread) continue;
            const job = this.job(key);
            const cur = this.status.get(key) || {};
            if (!thread.pending.length) {
                job.failures = 0;
                if (!job.busy && (cur.state === 'error' || cur.state === 'reading' || cur.state === 'typing' || cur.state === 'waiting')) {
                    this.setStatus(key, { state: 'online', error: '' });
                }
                continue;
            }
            if (holdClear || this.cfg.mode !== 'auto' || job.busy || now < job.nextTryAt) continue;
            if (job.blockedFingerprint && job.blockedFingerprint === this.fingerprint) continue;
            const newest = thread.pending[thread.pending.length - 1];
            if (now - newest.at < this.cfg.reply.debounce_ms) continue;
            job.busy = true;
            this.reply(key)
                .catch((e) => this.onFailure(key, e))
                .then(() => { job.busy = false; });
        }
    }

    onFailure(key, e) {
        const job = this.job(key);
        const now = Date.now();
        if (e instanceof GameOfflineError) {
            job.nextTryAt = now + 5000;
            this.setStatus(key, { state: 'waiting', error: 'Waiting for the game' });
            this.log.debug('reply postponed for ' + key + ': ' + e.message);
            return;
        }
        if (e instanceof NotPlayedError) {
            job.nextTryAt = now + 3000;
            const cur = this.status.get(key) || {};
            if (cur.state !== 'online' || cur.error) this.setStatus(key, { state: 'online', error: '' });
            this.log.debug('reply postponed for ' + key + ': ' + e.message);
            return;
        }
        if (e instanceof PairError) {
            job.nextTryAt = now + 30000;
            this.setStatus(key, { state: 'error', error: PAIR_ERROR_TEXT[e.code] || 'Contact not available' });
            this.log.warn('reply skipped for ' + key + ': ' + e.message);
            return;
        }
        if (e instanceof LlmError && e.permanent) {
            job.blockedFingerprint = this.fingerprint;
            job.nextTryAt = now + 300000;
            this.setStatus(key, { state: 'error', error: e.publicMessage });
            this.log.error('AI request rejected (' + e.kind + '): ' + e.message + ' -- fix config/secrets, the bridge retries automatically after a change');
            return;
        }
        const backoff = this.cfg.reply.retry_backoff_ms;
        const wait = backoff[Math.min(job.failures, backoff.length - 1)];
        job.failures += 1;
        job.nextTryAt = now + wait;
        const pub = e instanceof LlmError ? e.publicMessage : 'Reply failed';
        this.setStatus(key, { state: 'error', error: pub + ', retrying' });
        this.log.error('reply for ' + key + ' failed (attempt ' + job.failures + ', next in ' + Math.round(wait / 1000) + 's): ' + (e && e.stack || e));
    }

    async ensureInGame() {
        const phase = await this.world.phase();
        if (phase !== 'in_game') throw new GameOfflineError('game phase is ' + phase);
    }

    historyFor(thread, memory, excludeIds) {
        const skip = new Set(excludeIds || []);
        const list = thread.messages.filter((m) => m.at > memory.summarizedUpTo && !skip.has(m.id));
        return list.slice(Math.max(0, list.length - this.cfg.reply.history_messages));
    }

    // The last few texts of a conversation (not the ones being answered), to tell what it is about.
    recentTexts(thread, count, skip) {
        if (!thread) return [];
        const ids = new Set((skip || []).map((m) => m.id));
        const list = thread.messages.filter((m) => !ids.has(m.id));
        return list.slice(Math.max(0, list.length - count)).map((m) => m.text);
    }

    // The couple's memory, plus what it is useful to have in mind right now: the newest facts,
    // the household's latest big events and the old facts, conversations and events the texts
    // are about. query: the texts and reasons this message answers.
    // thread: the conversation, to tell what the character has been saying over and over.
    memoryFor(pair, snap, query, thread) {
        const mem = this.memory.load(pair.playerId, pair.partnerId);
        const env = snap && snap.env;
        const now = Date.now();
        mem.shown = variedFacts(mem.facts, SHOWN_FACTS);
        if (thread && Array.isArray(thread.messages)) {
            const theirs = thread.messages.filter((m) => m.side === 'player').slice(-8).map((m) => m.text);
            const names = [snap && snap.player && snap.player.name, snap && snap.partner && snap.partner.name];
            mem.worn = wornPhrases(thread.messages, theirs.concat(names).join(' '));
            if (mem.worn.phrases.length || mem.worn.simile) {
                this.log.info('worn [' + pair.key + '] ' + (mem.worn.phrases.length ? '「' + mem.worn.phrases.join('」「') + '」' : '') + (mem.worn.simile ? ' too many similes' : ''));
            }
        }
        const me = snap && snap.partner && snap.partner.name;
        const asYou = (t) => (me ? String(t).split(me).join('你') : String(t));
        let older = [];
        if (this.cfg.memory.chronicle && this.chronicle && pair.householdId) {
            const recent = this.chronicle.recentFor(pair.householdId, pair.partnerId, env);
            const ids = new Set(recent.map((e) => e.id));
            mem.events = recent.map((e) => ({ text: asYou(e.text), when: whenText(e, env, now), count: e.count || 1 }));
            older = this.chronicle.forPerson(pair.householdId, pair.partnerId, env)
                .filter((e) => !ids.has(e.id))
                .map((e) => ({ src: 'event', text: asYou(e.text), w: e.w, at: e.at, day: e.day, time: e.time }));
        }
        const q = (query || []).filter(Boolean).join(' ');
        if (this.cfg.memory.recall && q) {
            const shown = new Set(mem.shown);
            const pool = mem.facts.filter((f) => !shown.has(f))
                .map((f) => ({ src: 'fact', text: f.text, at: f.at, day: f.day, w: 1 }))
                .concat(mem.episodes.map((e) => ({ src: 'episode', text: e.text, topics: e.topics, at: e.at, day: e.day, w: 2 })))
                .concat(older);
            const names = [];
            for (const m of pair.members || []) names.push(fullName(m), m.first_name || '');
            names.sort((a, b) => b.length - a.length);
            const hits = recall(q, pool, { day: env && typeof env.day === 'number' ? env.day : undefined, now, ignore: names });
            mem.recalled = hits.map((h) => ({ src: h.src, text: h.text, when: whenText(h, env, now) }));
            if (hits.length) {
                this.log.info('recall [' + pair.key + '] ' + hits.length + ' of ' + pool.length + ': ' +
                    hits.map((h) => h.src + ' "' + String(h.text).slice(0, 30) + '" ' + h.score).join(' | '));
            }
        }
        return mem;
    }

    chronicleJournal(ev) {
        if (!this.cfg.memory.chronicle || !ev || ev.kind !== 'finished') return;
        this.chronicle.onJournal(ev).catch((e) => {
            if (e instanceof GameOfflineError) return;
            this.log.warn('chronicle: ' + (e && e.message || e));
        });
    }

    async watchChronicle() {
        if (!this.cfg.memory.chronicle) return;
        try {
            if ((await this.world.phase()) !== 'in_game') return;
            await this.chronicle.watch();
        } catch (e) {
            if (e instanceof GameOfflineError) this.log.debug('chronicle: ' + e.message);
            else this.log.warn('chronicle watch failed: ' + (e && e.stack || e));
        }
    }

    // An emergency began or ended, or a turning point happened (incidents.js): the city time is
    // noted for the character's words, the chronicle keeps it, and every contact is looked at now
    // instead of at the next round.
    onIncident(change) {
        const inc = change.incident;
        this.handleIncident(change)
            .catch((e) => this.log.warn('incident ' + inc.id + ': ' + (e && e.message || e)))
            .then(() => {
                if (!this.householdOk || this.switching || this.stopping) return;
                this.track(true).catch((e) => this.log.warn('tracker after incident: ' + (e && e.message || e)));
            });
    }

    async handleIncident(change) {
        const inc = change.incident;
        // The game is running this; nothing the AI queued may cut in.
        if (change.type === 'start' && inc.blocking) this.dropFollowForEmergency(inc);
        const env = await this.chronicle.envNow().catch(() => null);
        const clock = env && typeof env.hour === 'number' ? pad2(env.hour) + ':' + pad2(env.minute || 0) : '';
        if (change.type === 'end') inc.endClock = clock;
        else inc.startClock = clock;
        if (!this.cfg.memory.chronicle || !this.householdOk) return;
        const hh = await this.world.household();
        const names = new Map(hh.members.map((m) => [String(m.entity_id), fullName(m)]));
        const text = incidentChronicleText(change.type, inc, names);
        if (!text) return;
        const who = (change.type === 'notice' ? inc.people : Object.keys(inc.people || {})).filter((id) => names.has(String(id)));
        this.chronicle.add(hh.id, { who, kind: 'incident', text, w: 3, key: 'incident|' + inc.id + '|' + change.type }, env);
    }

    dropFollowForEmergency(inc) {
        const pairs = (this.state && this.state.value && this.state.value.pairs) || {};
        let n = 0;
        for (const key of Object.keys(pairs)) {
            const st = pairs[key];
            if (!st || !st.follow) continue;
            this.log.info('follow [' + key + '] dropped: ' + inc.kind + ' ' + inc.id);
            delete st.follow;
            n += 1;
        }
        if (n) this.state.save();
    }

    // A world event line of the Lua mod (journal.js). Names are the household's, for the words.
    onWorldEvent(ev) {
        if (!this.householdOk || this.switching) return;
        // Growing up and dying are kept for the family, whatever the incident notice says.
        try {
            this.legacy.onEvent(ev, this.lastEnv && this.lastEnv.env);
        } catch (e) {
            this.log.warn('legacy: ' + ev.event + ': ' + (e && e.message || e));
        }
        this.world.household()
            .then((hh) => this.incidents.onWorld(ev, new Map(hh.members.map((m) => [String(m.entity_id), fullName(m)]))))
            .catch((e) => this.log.warn('world event ' + ev.event + ': ' + (e && e.message || e)));
    }

    chronicleOuting(o) {
        if (!this.cfg.memory.chronicle || !o || !o.householdId) return;
        const text = o.memberName + '和' + o.playerName + '一起出门' + (o.place ? '去' + o.place : '');
        this.chronicle.note(o.householdId, [o.member, o.player], 'outing', text, 2)
            .catch((e) => this.log.warn('chronicle: ' + (e && e.message || e)));
    }

    // A meal really served to someone (the mod said so): a small act of care worth remembering.
    async chronicleMeal(actorId, meal) {
        if (!this.cfg.memory.chronicle || !meal || !meal.person) return;
        const hh = await this.world.household();
        const byId = new Map(hh.members.map((m) => [String(m.entity_id), fullName(m)]));
        const a = byId.get(String(actorId));
        const b = byId.get(String(meal.person)) || meal.personName;
        if (!a || !b) return;
        const dish = meal.name || '饭菜';
        const text = meal.cooked ? a + '亲手做了「' + dish + '」端给' + b : a + '给' + b + '端来了「' + dish + '」';
        await this.chronicle.note(hh.id, [String(actorId), String(meal.person)], 'care', text, meal.cooked ? 2 : 1);
    }

    async reply(key) {
        const replyStarted = Date.now();
        const k = parseKey(key);
        await this.ensureInGame();
        const possessed = await this.world.possessed();
        if (String(possessed) !== k.playerId) {
            throw new NotPlayedError('texts were sent as ' + k.playerId + ', now playing ' + (possessed || 'nobody'));
        }
        const pair = await this.world.pair(k.playerId, k.contactId);
        const thread = this.mailbox.thread(key);
        if (!thread || !thread.pending.length) return;
        const pending = thread.pending;
        const reAt = pending[pending.length - 1].at;
        this.setStatus(key, { state: 'reading', error: '', readAt: reAt, partnerName: fullName(pair.partner), role: pair.role });
        this.log.info('reply [' + key + ' ' + pair.role + ']: ' + pending.length + ' pending text(s) from ' + fullName(pair.player) +
            ' to ' + fullName(pair.partner) + ': ' + pending.map((m) => JSON.stringify(m.text)).join(' | '));

        const snap = await this.snapshot(pair, true);
        snap.proximity = await this.world.proximity(pair, this.cfg.proactive.nearby_meters);
        let [catalog] = await Promise.all([
            this.actions.catalog(pair, snap, this.actionsCfg(pair, snap)),
            sleep(600)
        ]);
        catalog = await this.prepareObjectFocus(pair, snap, catalog, pending);
        this.log.info('reply timing [' + key + '] snapshot and catalog ' + (Date.now() - replyStarted) + 'ms');
        this.warmCapabilities(pair, snap, catalog);
        const memory = this.memoryFor(pair, snap, pending.map((m) => m.text).concat(this.recentTexts(thread, 3, pending)), thread);
        snap.finished = (this.state.pair(pair.key).finished || []).slice(-8);
        snap.promises = this.recentPromises(pair.key);
        // Whether the reply may give the character a new like or dislike today.
        snap.preferOpen = !pair.outsider && this.preferences.open(pair.partnerId, snap.env);
        const told = this.liveSetbacks(pair.key);
        snap.setbacks = told;
        // The player answered, so a new setback may be told by text again.
        this.state.pair(pair.key).setbackAwait = false;
        const diary = this.todayDiary(pair.partnerId, snap.env);
        const photoInputs = [];
        let missingPhotos = 0;
        for (const m of pending) {
            if (!m.image) continue;
            const url = this.photos.dataUrl(m.image);
            if (url) photoInputs.push(url);
            else missingPhotos += 1;
        }
        // A burst can contain several photos; cap one request instead of resending the whole
        // conversation's images. Normally the debounce means this is just the newest picture.
        const images = photoInputs.slice(-4);
        if (missingPhotos) this.log.warn('reply [' + key + ']: ' + missingPhotos + ' attached photo(s) could not be read');
        const prompt = persona.replyPrompt({
            snap,
            cfg: this.cfg,
            memory,
            diary,
            catalog,
            history: this.historyFor(thread, memory, pending.map((m) => m.id)),
            pending,
            photoCount: images.length,
            now: Date.now()
        });
        this.log.debug('prompt system:\n' + prompt.system + '\nprompt user:\n' + prompt.user);
        this.setStatus(key, { state: 'typing' });
        // The phone animation and speech bubble play on the contact's body: not on an outsider far away.
        if (!pair.outsider || snap.outsiderNear) this.immersion(pair, snap).catch((e) => this.log.debug('immersion failed: ' + e.message));
        const started = Date.now();
        const result = await this.llm.json(prompt.system, prompt.user, { purpose: 'reply', max_tokens: 900, images, thinking: inCrisis(snap) ? 'disabled' : undefined });
        this.log.info('reply timing [' + key + '] model ' + (Date.now() - started) + 'ms');
        this.log.debug('llm result: ' + JSON.stringify(result));
        await this.deliver(pair, snap, catalog, result, reAt, 'reply', Date.now() - started, pending);
        if (told.length) {
            const said = new Set(told.map((s) => s.at + '|' + s.what));
            const st = this.state.pair(key);
            st.setbacks = (st.setbacks || []).filter((s) => !said.has(s.at + '|' + s.what));
            this.state.save();
            this.log.info('setback [' + key + '] told in the reply: ' + told.map((s) => s.what).join(' | '));
        }
        this.job(key).failures = 0;
        this.setStatus(key, { state: 'online', error: '' });
        this.summarizeIfNeeded(pair, snap).catch((e) => this.log.warn('summary failed: ' + e.message));
    }

    async prepareObjectFocus(pair, snap, catalog, pending) {
        const started = Date.now();
        const text = pending.map((m) => m.text).join('\n');
        const old = this.objectFocus.get(pair.key);
        let matches = this.actions.focusMatches(text, catalog, snap.partner.ageGroup);
        // A named new object supersedes a pronoun reference to the old target.
        const changed = old && matches.length && !matches.some((m) => objectFocus.score(old.query, m.object.name));
        const focus = objectFocus.next(changed ? null : old, text, snap.partner.site || '', matches.length > 0, started);
        if (old && (!focus || old.id !== focus.id)) {
            const st = this.state.pair(pair.key);
            // Cancel only work owned by this target, never an unrelated meal/appointment.
            if (st.follow && st.follow.focusId === old.id && (focus || objectFocus.CANCEL.test(text.trim()))) {
                delete st.follow;
                this.state.save();
                this.log.info('focus [' + pair.key + '] old queued target dropped');
            }
        }
        if (!focus || !catalog.allowed.has('use_object')) {
            this.objectFocus.delete(pair.key);
            return catalog;
        }
        if (focus.followup) matches = this.actions.focusMatches(focus.query, catalog, snap.partner.ageGroup);
        let method = 'name or cached action';
        if (focus.followup && old && old.site === focus.site && old.method === 'semantic') {
            const known = this.actions.knownObjects(catalog);
            matches = (old.candidates || []).filter((o) => known.has(o.id)).map((o) => ({ object: known.get(o.id), score: 1 }));
            if (matches.length) method = 'cached semantic';
        }
        focus.error = null;
        if ((!matches.length || method !== 'cached semantic' && /旁边|附近|边上|对面|后面/.test(focus.query)) && !(focus.status === 'done' && focus.followup)) {
            // One bounded semantic fallback for an actual object request; no extra model call
            // for direct name/category matches, and this lookup cannot execute an action.
            matches = [];
            method = 'semantic';
            try {
                const known = this.actions.knownObjects(catalog);
                if (known.size) {
                    const objects = await this.wantObjectMap(pair, snap, known);
                    const prompt = persona.focusObjectsPrompt(focus.query, objects);
                    const r = await this.llm.json(prompt.system, prompt.user, { thinking: 'disabled', temperature: 0.1, max_tokens: 250, purpose: 'focus_objects' });
                    if (!r || !Array.isArray(r.object_ids)) throw new LlmError('format', 'object lookup returned no object_ids');
                    matches = Array.from(new Set(r.object_ids.map(String))).filter((id) => known.has(id))
                        .slice(0, objectFocus.LIMIT).map((id) => ({ object: known.get(id), score: 1 }));
                    method = 'semantic';
                }
            } catch (e) {
                focus.error = actionFailure(e, 'focus_objects');
                this.log.warn('focus [' + pair.key + '] ' + focus.error.code + ': ' + e.message);
            }
        }
        const selected = await this.actions.focusCatalog(pair.partnerId, snap.partner.ageGroup, catalog, matches, focus.query, this.actionsCfg(pair, snap));
        focus.candidates = selected.candidates;
        focus.method = method === 'cached semantic' ? 'semantic' : method;
        if (focus.task && snap.partner.activity && snap.partner.activity.id === focus.task.bagId) focus.status = 'started';
        if (!['queued', 'started', 'done'].includes(focus.status)) focus.status = focus.candidates.length ? 'found' : 'looking';
        this.objectFocus.set(pair.key, focus);
        snap.objectFocus = focus;
        this.log.info('focus [' + pair.key + '] ' + JSON.stringify(focus.query) + ' ' + focus.status +
            ' via ' + method + ' in ' + (Date.now() - started) + 'ms: ' + focus.candidates.map((o) =>
                o.id + ' ' + o.name + ' [' + o.actions.map((a) => a.id).join(',') + ']' + (o.error ? ' query failed' : '')).join(' | '));
        return selected.catalog;
    }

    cleanBubbles(raw) {
        let list = raw;
        if (typeof list === 'string') list = [list];
        if (!Array.isArray(list)) list = [];
        const out = [];
        for (const item of list) {
            // Emoji characters become the phone's [name] tokens; ones it cannot draw are dropped.
            const text = sanitizeText(emoji.normalize(typeof item === 'string' ? item : (item && item.text) || ''), this.cfg.reply.bubble_max_chars);
            if (text) out.push(text);
            if (out.length >= this.cfg.reply.max_bubbles) break;
        }
        return out;
    }

    typingDelay(text) {
        const r = this.cfg.reply;
        return Math.min(Math.max(text.length * r.typing_ms_per_char, r.typing_min_ms), r.typing_max_ms);
    }

    // What the reply agreed to: { now: [{ what, when }], later: [{ what, due }], given }.
    // given: the model filled in the promises list (an empty list is an answer too). The old
    // single "promise" string still counts as something to do now.
    readPromises(result, env) {
        const out = { now: [], later: [], given: Array.isArray(result.promises) };
        const raw = out.given ? result.promises.slice(0, PROMISES_MAX) : [];
        if (!out.given && typeof result.promise === 'string' && result.promise.trim()) raw.push({ do: result.promise, when: 'now' });
        for (const p of raw) {
            const item = parsePromise(p, env);
            if (!item) continue;
            if (item.when === 'later') out.later.push(item);
            else out.now.push(item);
        }
        if (!out.given && typeof result.promise === 'string') out.given = true;
        return out;
    }

    // Turns the model's action list into steps. Whatever the reply agreed to do now and has no
    // step for becomes a step looked for in the game; something agreed for later goes into the
    // agenda (deliver). Only when the model gave no promises at all is the reply read again for
    // one, and then one short follow-up fills the action in from the same live catalog.
    async planActions(pair, snap, catalog, result, bubbles, pending, proactive) {
        // A progress/location question is observational, even if the model emits actions.
        // The existing follower owns any already accepted work and continues on its own.
        if (!proactive && snap.objectFocus && (snap.objectFocus.inspect ||
            snap.objectFocus.followup && snap.objectFocus.status === 'done')) {
            this.log.info('focus [' + pair.key + '] status question: keeping the existing plan');
            return { steps: [], rejected: [], misses: [], promised: '', later: [] };
        }
        const raw = Array.isArray(result.actions) ? result.actions : [];
        let plan = this.actions.normalize(raw, catalog, snap, this.actionsCfg(pair, snap));
        for (const r of plan.rejected) this.log.warn('rejected action ' + JSON.stringify(r.action) + ': ' + r.reason);
        this.log.info('model proposed ' + raw.length + ' action(s), kept ' + plan.steps.length +
            (plan.steps.length ? ': ' + plan.steps.map((s) => s.type + (s.interaction ? ' ' + s.interaction.id : '') + (s.objectName ? '@' + s.objectName : '') + (s.want ? ' "' + s.want + '"' : '')).join(', ') : ''));
        // Going where one already is does nothing; counted as a step it would stand in for the
        // real one a promise needs.
        const here = snap.partner && snap.partner.site;
        const idle = plan.steps.filter((s) => s.type === 'go_to_place' && s.place && here && s.place.name === here);
        if (idle.length) {
            plan.steps = plan.steps.filter((s) => idle.indexOf(s) < 0);
            this.log.info('plan [' + pair.key + '] dropped going to ' + here + ': already there');
        }
        const said = this.readPromises(result, snap.env);
        plan.later = said.later;
        for (const p of said.now) this.log.info('model promised (' + p.when + '): ' + JSON.stringify(p.what));
        for (const p of said.later) this.log.info('model promised for later: ' + JSON.stringify(p.what) + ' at ' + describeDue(p.due, snap.env));
        let promise = said.now.length ? said.now.map((p) => p.what).join('；') : said.given ? '' : null;
        let needRepair = false;
        const canLook = catalog.allowed.has('use_object') && (catalog.sameSite || catalog.objectSource);
        const uncovered = said.now.filter((p) => !plan.steps.some((s) => coversPromise(s, p.what)));
        // Following someone or praising them does not fulfill an accepted object task.
        const focusedObject = !proactive && snap.objectFocus && snap.objectFocus.candidates.length &&
            !objectFocus.SEQUENCE.test((pending || []).map((m) => m.text).join('\n')) &&
            said.now.some((p) => objectFocus.rank(p.what, snap.objectFocus.candidates).length);
        const counted = focusedObject ? plan.steps.filter((s) => s.type !== 'interact' && s.type !== 'go_together') : plan.steps;
        const short = said.now.length - physicalCount(counted);
        if (uncovered.length && short > 0 && canLook) {
            for (const p of uncovered.slice(0, short)) {
                plan.steps.push({ type: 'use_object', want: p.what, objectId: '' });
                this.log.info('the reply agreed to "' + p.what + '" with no step for it, looking for one in the game');
            }
        } else if (!hasPhysicalStep(plan.steps) && catalog.allowed.size) {
            if (promise === '' && !said.later.length && bubbles && bubbles.length &&
                persona.needsActionRepair(pending, bubbles, plan.steps, { proactive: !!proactive })) {
                // The words sound like a promise the list left out.
                const heard = await this.spokenPromise(snap, bubbles, pending);
                if (heard) this.log.info('the reply agreed to "' + heard + '" without listing it');
                if (heard) promise = heard;
            } else if (promise === null && bubbles && bubbles.length) {
                const heard = await this.spokenPromise(snap, bubbles, pending);
                if (heard) this.log.info('the reply agreed to "' + heard + '" without queueing it');
                promise = heard === null ? promise : heard;
            }
            needRepair = promise === null
                ? persona.needsActionRepair(pending, bubbles, plan.steps, { proactive: !!proactive })
                : !!promise;
        }
        const misses = [];
        let repair = null;
        if (needRepair) {
            repair = await this.repairActions(pair, plan, snap, catalog, bubbles, pending, promise);
            plan = repair.plan;
        }
        if (needRepair && !hasPhysicalStep(plan.steps)) {
            if (promise) misses.push(Object.assign({ what: promise }, repair.failure || {
                code: 'no_plan', why: '还没确定怎么把这件事做起来；没有确认物品不存在，也没有实际走动查找'
            }));
            if (plan.steps.some((s) => s.type === 'stop_current')) {
                this.log.info('the promise has no real action behind it, keeping the current action');
                plan.steps = plan.steps.filter((s) => s.type !== 'stop_current');
            }
        }
        plan.steps = await this.resolveWants(plan.steps, pair, snap, catalog, bubbles, pending, misses, promise);
        if (!proactive && snap.objectFocus) {
            const before = plan.steps.length;
            plan.steps = objectFocus.prioritize(plan.steps, snap.objectFocus, promise, pending, bubbles);
            if (before !== plan.steps.length) this.log.info('focus [' + pair.key + '] removed optional social actions ahead of the accepted target');
            if (!plan.steps.some((s) => s.type === 'stop_current') && objectFocus.interruptIdle(snap.partner.activity, snap.objectFocus, promise, pending, bubbles, plan.steps)) {
                plan.steps.unshift({ type: 'stop_current' });
                this.log.info('focus [' + pair.key + '] leaving idle leisure for an immediate accepted task');
            }
            const target = plan.steps.find((s) => s.type === 'use_object' && snap.objectFocus.candidates.some((o) => o.id === s.objectId));
            if (target) {
                snap.objectFocus.status = 'queued';
                snap.objectFocus.task = { objectId: target.objectId, bagId: target.interaction && target.interaction.id };
                target.focusId = snap.objectFocus.id;
                target.focusSite = snap.partner.site || '';
                plan.focusId = snap.objectFocus.id;
            }
        }
        plan.steps = this.endAtOuting(plan.steps);
        // Leading walks the player's own character: only on the player's own words just sent.
        for (const s of plan.steps) {
            if (s.type === 'go_together' && s.lead && (proactive || !(pending || []).length)) {
                this.log.info('go_together: not leading ' + snap.player.name + ', who did not just ask for it; following instead');
                s.lead = false;
            }
        }
        plan.misses = misses;
        plan.promised = promise || '';
        return plan;
    }

    // After the texts went out: what the reply agreed to do later goes into the agenda, what it
    // settled leaves it, and missed agreements it was told about are not brought up again.
    keepAgreements(pair, snap, st, result, plan, kind) {
        let changed = false;
        const settle = Array.isArray(result.settle) ? result.settle.slice(0, KEEP_SETTLE_MAX) : [];
        const done = [];
        const cancelled = [];
        for (const s of settle) {
            const id = typeof s === 'string' ? s : s && typeof s.id === 'string' ? s.id : '';
            const clean = id.replace(/[\[\]\s]/g, '');
            if (!clean) continue;
            if (s && s.how === 'cancel') cancelled.push(clean);
            else done.push(clean);
        }
        if (done.length || cancelled.length) {
            const before = this.agenda.open(st).map((a) => a.id + ' ' + a.what);
            const calledOff = this.agenda.open(st).filter((a) => cancelled.indexOf(a.id) >= 0);
            this.agenda.close(st, done, 'done');
            this.agenda.close(st, cancelled, 'cancelled');
            for (const a of calledOff) {
                if (this.realism.noteAftermath(st, snap.env, { kind: 'called_off', what: a.what })) {
                    this.log.info('aftermath [' + pair.key + '] called off "' + a.what + '"');
                }
            }
            const after = new Set(this.agenda.open(st).map((a) => a.id + ' ' + a.what));
            const closed = before.filter((x) => !after.has(x));
            if (closed.length) this.log.info('agenda [' + pair.key + '] settled by the ' + kind + ': ' + closed.join(', '));
            changed = true;
        }
        for (const item of plan.later || []) {
            const entry = this.agenda.add(st, item, snap.env, kind);
            this.log.info('agenda [' + pair.key + '] ' + entry.id + ' "' + entry.what + '" at ' + describeDue(entry.due, snap.env));
            changed = true;
        }
        if (snap.agendaMissed && snap.agendaMissed.length) {
            this.agenda.toldMissed(st);
            changed = true;
        }
        if (changed) this.state.save();
    }

    // A step the model described in words ("want") becomes one real action: the bridge reads every
    // action the game offers on the candidate objects and the model picks the one that matches.
    // A step written as two jobs in a row ("换上睡衣去睡觉") becomes two steps: the first keeps
    // what the model chose (the wardrobe), the second is looked for on its own, through a learned
    // skill when there is one (going to sleep = her own bed). One interaction cannot do both.
    splitWants(steps, pair, snap) {
        const out = [];
        for (const step of steps) {
            const parts = step.type === 'use_object' && typeof step.want === 'string' ? chores.splitCompound(step.want) : null;
            if (!parts) {
                out.push(step);
                continue;
            }
            const first = Object.assign({}, step, { want: parts[0] });
            const rest = { type: 'use_object', want: parts[1] };
            const skill = this.skillFor(parts[1], snap);
            if (skill) rest.skill = skill;
            out.push(first, rest);
            this.log.info('plan [' + pair.key + '] "' + step.want + '" is two jobs: "' + parts[0] + '", then "' + parts[1] + '"' +
                (skill ? ' (as learned: "' + skill.task + '")' : ''));
        }
        return out;
    }

    // A learned skill for a short want ("去睡觉"): one whose task has the want's key words.
    skillFor(want, snap) {
        const core = String(want || '').replace(/^(去|再|然后|舒舒服服地?|赶紧|马上|就)+/, '').replace(/(吧|啦|了|呀)+$/, '');
        if (!core) return null;
        const key = core.length >= 2 ? core.slice(0, 2) : core;
        const list = (snap.skills || []).filter((s) => s && s.task && s.task.indexOf(key) >= 0 && !chores.isCompound(s.task));
        list.sort((a, b) => (b.done || 0) - (a.done || 0));
        return list[0] || null;
    }

    async resolveWants(steps, pair, snap, catalog, bubbles, pending, misses, promise) {
        steps = this.splitWants(steps, pair, snap);
        const out = [];
        let lost = false;
        const ctx = this.wantContext(pair, bubbles, pending, promise);
        for (let step of steps) {
            if (step.type !== 'use_object') {
                out.push(step);
                continue;
            }
            // A known skill: done the learned way on whatever here offers it, with no lookup. When
            // nothing here offers it, the job is looked for like any want, still as that skill.
            if (step.skill) {
                const skill = step.skill;
                const lesson = { id: skill.lesson || '', task: skill.task, how: skill.how, teacher: skill.teacher,
                    source: skill.source, skill: skill.id, actor: String(pair.partnerId) };
                let hit = null;
                try {
                    hit = await this.replaySkill(step, pair, snap, catalog);
                } catch (e) {
                    this.log.warn('skill "' + skill.task + '" replay failed: ' + (e && e.message || e));
                }
                if (hit) {
                    hit.lesson = lesson;
                    this.log.info('skill "' + skill.task + '" -> ' + hit.interaction.id + ' ' + hit.interaction.name + ' @' + hit.objectName + ' (' + hit.objectId + '), as learned');
                    out.push(hit);
                    continue;
                }
                this.log.info('skill "' + skill.task + '": nothing here offers ' + skill.interactionId + ' ' + skill.interactionName + ', looking for another way');
                step = Object.assign({}, step, { want: step.want || skill.task, lesson });
                delete step.skill;
                const found = await this.resolveWant(step, pair, snap, catalog, ctx, misses || []);
                if (!this.takeFound(out, found, lesson)) lost = true;
                continue;
            }
            // Picked straight from the list: the same check, against what was asked and promised.
            // Failing it, the promise (or what was asked) becomes the want and is looked for again.
            if (!step.want && step.interaction) {
                const purpose = ctx.promise || ctx.asked;
                if (!purpose) {
                    out.push(step);
                    continue;
                }
                const verdict = await this.checkWant(Object.assign({}, step, { want: purpose }), snap, ctx);
                if (verdict.ok) {
                    out.push(step);
                    continue;
                }
                this.log.info('direct ' + step.interaction.id + ' ' + step.interaction.name + ' @' + (step.objectName || 'self') + ' does not do "' + purpose + '" (' + verdict.why + '), looking again');
                const retry = Object.assign({}, step, { want: purpose });
                if (retry.self) {
                    delete retry.interaction;
                    delete retry.self;
                }
                const found = await this.resolveWant(retry, pair, snap, catalog, ctx, misses || []);
                if (!this.takeFound(out, found)) lost = true;
                continue;
            }
            if (!step.want) {
                out.push(step);
                continue;
            }
            if (step.interaction) {
                const verdict = await this.checkWant(step, snap, ctx);
                if (verdict.ok) {
                    out.push(step);
                    continue;
                }
                this.log.info('want "' + step.want + '": ' + step.interaction.id + ' ' + step.interaction.name + ' @' + step.objectName + ' does not do it (' + verdict.why + '), looking again');
            }
            const found = await this.resolveWant(step, pair, snap, catalog, ctx, misses || []);
            if (this.takeFound(out, found)) { /* kept */ }
            else lost = true;
        }
        // Anything taken into the hand (out of the bag, or a thing looked for and picked up) has
        // its next step settled now and queued with the take: the game puts away whatever an
        // idle hand holds. A next step the model listed itself on that thing is folded in, since
        // on its own it would come too late.
        for (let i = 0; i < out.length; i++) {
            const s = out[i];
            if (s.type !== 'use_object' || !s.interaction || s.after) continue;
            const pocketTake = !!(s.interaction.pocket || s.interaction.then || TAKE_OUT_BAG_RE.test(s.interaction.id));
            // A chore's own pick-up has its own end; only a thing that was looked for counts.
            const foundPick = /^PickUp\w*$/.test(s.interaction.id) && !!s.found && !s.chore;
            if (!pocketTake && !foundPick) continue;
            const next = out[i + 1];
            const nextOnIt = next && next.type === 'use_object' && next.interaction && !next.after &&
                (String(next.objectId) === String(s.objectId) || PUT_DOWN_RE.test(next.interaction.id)) ? next : null;
            s.after = await this.afterTake(s, pair, snap, catalog, ctx, nextOnIt);
            if (nextOnIt) {
                this.log.info('want "' + (s.want || '') + '": ' + nextOnIt.interaction.id + ' @' + (nextOnIt.objectName || 'self') + ' rides along with taking ' + s.objectName);
                out.splice(i + 1, 1);
            }
        }
        // A way the player called wrong for this job is not done again, unless they are teaching it now.
        if (!snap.teachingNow) {
            const purpose = ctx.promise || ctx.asked || '';
            for (let i = out.length - 1; i >= 0; i--) {
                const s = out[i];
                if (s.type !== 'use_object' || !s.interaction) continue;
                // The step's own want says what it is for; only a step without one is read against the ask.
                const w = this.knowhow.isWrong(pair.partnerId, s.want || purpose, s.interaction.id, true);
                if (!w) continue;
                this.log.info('want "' + (s.want || purpose) + '": ' + s.interaction.id + ' @' + (s.objectName || 'self') + ' was called wrong for "' + w.task + '", dropped');
                out.splice(i, 1);
                lost = true;
            }
        }
        // Stopping was only the way to clear the hands for that job. With the job gone it would
        // leave the character standing idle after saying they are on their way.
        if (lost && !hasPhysicalStep(out) && out.some((s) => s.type === 'stop_current')) {
            this.log.info('nothing real to do instead, keeping the current action');
            return out.filter((s) => s.type !== 'stop_current');
        }
        return out;
    }

    // A want can turn into going out with the player only once resolved. Whatever came after it
    // would pull the character away from the player; what to do there is decided once there.
    endAtOuting(steps) {
        const at = steps.findIndex((s) => s.type === 'go_together');
        if (at < 0) return steps;
        const out = steps.slice(0, at + 1);
        for (const s of steps.slice(at + 1)) {
            if (hasPhysicalStep([s])) this.log.info('dropped ' + s.type + (s.interaction ? ' ' + s.interaction.name : '') + ' after going out together');
            else out.push(s);
        }
        for (let i = 0; i < at; i++) {
            if (out[i].type === 'go_together') return steps;
        }
        return out;
    }

    // The people a want can be for, as the model names them: the player, or a family member by id.
    wantPeople(snap) {
        const here = snap.partner.site || '';
        const out = [{ ref: 'player', id: String(snap.player.id), name: snap.player.name, here: !!snap.together, player: true }];
        for (const m of snap.others || []) {
            out.push({ ref: String(m.id), id: String(m.id), name: m.name, label: m.label || '', age: m.age || '', here: !!(here && m.site && m.site === here), player: false });
        }
        return out;
    }

    personOf(ref, people) {
        const r = String(ref || '').trim();
        if (!r) return null;
        return people.find((p) => p.ref === r || p.id === r) || null;
    }

    // Everyday housework the game always does one way: no lookup, the fixed route on the nearest
    // thing that offers it. A chore nothing here offers is left to the general lookup.
    async choreRoute(step, pair, snap, known) {
        const text = String(step.want || '');
        const recipes = chores.recipesFor(text);
        if (!recipes.length) return null;
        const objects = Array.from(known.values());
        for (const recipe of recipes) {
            let cands = chores.candidatesFor(recipe, objects, text, 4);
            // The thing the model named is tried first even when four nearer ones come before it.
            const named = step.objectId ? chores.candidatesFor(recipe, objects, text, objects.length).find((o) => o.id === String(step.objectId)) : null;
            if (named) cands = [named].concat(cands.filter((o) => o !== named));
            for (const o of cands) {
                let actions;
                try {
                    actions = await this.actions.allObjectActions(pair.partnerId, o.id, snap.partner.ageGroup);
                } catch (e) {
                    if (e instanceof GameOfflineError) throw e;
                    this.log.debug('chore ' + recipe.id + ': actions of ' + o.id + ' unreadable: ' + e.message);
                    continue;
                }
                const it = chores.actionOn(recipe, actions, text, { ageGroup: snap.partner.ageGroup, age: snap.partner.age });
                if (!it) continue;
                this.log.info('want "' + text + '" -> chore ' + recipe.id + ': ' + it.id + ' ' + it.name + ' @' + o.name + ' (' + o.id + ')' + (o.room ? ' in ' + o.room : ''));
                return {
                    type: 'use_object', kind: it.kind || actionKind(it.id, it.name), objectId: o.id, objectName: o.name,
                    interaction: it, want: text, goal: recipe.task, chore: recipe.id
                };
            }
            this.log.info('want "' + text + '": chore ' + recipe.id + ' (' + recipe.task + ') is not offered by ' + (cands.length ? cands.map((o) => o.name).join(', ') : 'anything here') + ', looking it up');
        }
        return null;
    }

    takeFound(out, found, lesson) {
        if (!found) return false;
        const list = found.type === '_many' ? found.steps : [found];
        if (!list.length) return false;
        for (let i = 0; i < list.length; i++) {
            const step = list[i];
            if (lesson && step && step.type === 'use_object') step.lesson = lesson;
            out.push(step);
        }
        return true;
    }

    // Looking for something: picked up when it can be carried, otherwise the person at least
    // knows where it is, and says so. Several names joined by 和 are each matched on their own.
    async findRoute(step, pair, snap, known, ids, thing, misses) {
        const list = Array.from(known.values());
        const chosen = [];
        const seen = new Set();
        const add = (o) => {
            if (!o || seen.has(o.id)) return;
            seen.add(o.id);
            chosen.push(o);
        };
        const terms = findTerms(thing);
        const bagNames = list.filter((x) => x.pocket).map((x) => x.name);
        // What people call a thing is often not the game's name for it. A word that matches no
        // name is matched once by meaning against the names on the lot.
        const unmatched = terms.filter((term) => !list.some((x) => nameMatches(x.name, term)));
        const meant = unmatched.length ? await this.meantNames(step, snap, unmatched, list) : {};
        const found = [];
        for (let i = 0; i < terms.length; i++) {
            const term = terms[i];
            const alias = meant[term];
            const pool = alias ? list.filter((x) => x.name === alias) : list.filter((x) => nameMatches(x.name, term));
            pool.sort((a, b) => (a.meters === undefined || a.meters === null) - (b.meters === undefined || b.meters === null) || (a.meters || 0) - (b.meters || 0));
            if (pool.length) found.push(pool[0]);
        }
        for (const o of found) add(o);
        if (!found.length) for (let i = 0; i < (ids || []).length; i++) add(known.get(String(ids[i])));
        for (let i = 0; i < terms.length; i++) {
            const term = terms[i];
            const hit = meant[term] ? list.find((x) => x.name === meant[term]) : list.find((x) => nameMatches(x.name, term));
            if (hit) continue;
            if (terms.length > 1) {
                misses.push({
                    what: term,
                    why: bagNames.length ? ('背包里没有' + term + '，现在有' + bagNames.join('、')) : ('找了一圈，这里没看到' + term)
                });
            }
        }
        if (!chosen.length) {
            const askedBag = /背包/.test((step.want || '') + (thing || ''));
            this.log.info('want "' + step.want + '": looked for ' + thing + ', not here');
            misses.push({
                what: step.want,
                why: askedBag && bagNames.length ? ('背包里现在是' + bagNames.join('、')) : ('找了一圈，这里没看到' + thing)
            });
            return null;
        }
        const steps = [];
        const fixed = [];
        for (let i = 0; i < chosen.length; i++) {
            const one = await this.routeFoundObject(step, pair, snap, chosen[i], misses);
            if (!one) continue;
            if (one.type === '_use') fixed.push(one);
            else if (one.type === '_many') for (const s of one.steps) steps.push(s);
            else steps.push(one);
        }
        if (steps.length === 1) return steps[0];
        if (steps.length > 1) return { type: '_many', steps: steps };
        if (fixed.length) return { type: '_use', ids: fixed.map((f) => f.id), why: fixed[0].why };
        return null;
    }

    // { word: game name } for the words that are another name for something on the lot.
    async meantNames(step, snap, words, list) {
        const names = Array.from(new Set(list.map((x) => x.name).filter(Boolean))).slice(0, 400);
        if (!names.length || !this.llm.configured) return {};
        try {
            const p = persona.meantNamesPrompt({ snap, want: step.want || '', words, names });
            const r = await this.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0, max_tokens: 200, purpose: 'want_names' });
            const out = {};
            for (const w of words) {
                const n = r && r.names && typeof r.names[w] === 'string' ? r.names[w].trim() : '';
                if (n && names.indexOf(n) >= 0) out[w] = n;
            }
            this.log.info('want "' + (step.want || '') + '": ' + words.map((w) => w + ' = ' + (out[w] || '?')).join(', ') + (r && r.why ? ' (' + String(r.why).slice(0, 100) + ')' : ''));
            return out;
        } catch (e) {
            if (e instanceof GameOfflineError) throw e;
            this.log.warn('want "' + (step.want || '') + '": matching ' + words.join('/') + ' by meaning failed: ' + (e && e.message || e));
            return {};
        }
    }

    // What happens to a thing once it is in the hand, settled before it is taken. The choices
    // are the game's own menu for that kind of thing, setting it down on or beside a piece of
    // furniture, or setting it down where the character stands.
    async afterTake(s, pair, snap, catalog, ctx, next) {
        const item = s.objectName || '东西';
        const known = this.actions.knownObjects(catalog);
        const o = known.get(String(s.objectId));
        if (s.interaction.then) {
            const chosen = s.interaction;
            s.interaction = { id: 'AutoFind_PutDown_Inventory', name: '取出', kind: 'other', pocket: true };
            // A put-down picked from the thing's own menu does not say where; where it goes is
            // read from the request below, like a plain take-out.
            if (!PUT_DOWN_RE.test(chosen.id)) {
                this.log.info('want "' + (s.want || '') + '": ' + chosen.id + ' ' + chosen.name + ' on ' + item + ' in the bag -> take it out, then ' + chosen.name);
                return useThen(chosen, s.objectId, item);
            }
        }
        if (next && String(next.objectId) === String(s.objectId) && !PUT_DOWN_RE.test(next.interaction.id)) {
            return useThen(next.interaction, s.objectId, item);
        }
        const objects = Array.from(known.values())
            .filter((x) => x && x.id && !x.pocket && !x.held && String(x.id) !== String(s.objectId))
            .slice(0, 80);
        if (next && PUT_DOWN_RE.test(next.interaction.id) && next.objectId && String(next.objectId) !== String(s.objectId)) {
            const target = objects.find((x) => String(x.id) === String(next.objectId)) || { id: next.objectId, name: next.objectName || '' };
            return placeThen(/^(PutDown|PutDown_Surface|PutDown_Target)$/.test(next.interaction.id) ? 'on' : 'near', target, s.objectId);
        }
        let menu = o && Array.isArray(o.actions) ? o.actions.filter((a) => a.then) : [];
        if (!menu.length) {
            let tableId = o && o.tableId ? o.tableId : '';
            if (!tableId) {
                const props = await this.game.soft('entity_reflect', { entity_id: String(s.objectId) });
                tableId = props && props.objectTableId ? String(props.objectTableId) : '';
            }
            try {
                menu = await this.actions.carriedMenu(tableId, snap.partner.ageGroup);
            } catch (e) {
                if (e instanceof GameOfflineError) throw e;
                menu = [];
            }
        }
        const uses = menu.filter((a) => !PUT_DOWN_RE.test(a.id));
        const purpose = s.want || (ctx && (ctx.promise || ctx.asked)) || '';
        let r = null;
        try {
            const p = persona.afterTakePrompt({ snap, want: purpose, item, uses, objects, fromBag: !!(s.interaction.pocket || TAKE_OUT_BAG_RE.test(s.interaction.id)) });
            this.log.debug('after-take prompt:\n' + p.system + '\n' + p.user);
            r = await this.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0.1, max_tokens: 220, purpose: 'want_after' });
        } catch (e) {
            if (e instanceof GameOfflineError) throw e;
            this.log.warn('want "' + purpose + '": choosing what to do with ' + item + ' once in hand failed: ' + (e && e.message || e));
        }
        const pick = r && typeof r.next === 'string' ? r.next.trim() : '';
        const use = uses.find((a) => a.id === pick);
        let after;
        if (use) {
            after = useThen(use, s.objectId, item);
        } else {
            const target = pick === 'place' && r.target_id ? objects.find((x) => String(x.id) === String(r.target_id)) : null;
            after = placeThen(target && r.relation === 'on' ? 'on' : 'near', target, s.objectId);
        }
        this.log.info('want "' + purpose + '": once ' + item + ' is in the hand -> ' + placeText(after) +
            ' via ' + after.tries.map((t) => t.bagId + (t.targetId ? '@' + t.targetId : '')).join(' / ') +
            ' [menu: ' + (uses.map((a) => a.id).join(',') || 'none') + ']' + (r && r.why ? ' (' + String(r.why).slice(0, 120) + ')' : ''));
        return after;
    }

    async routeFoundObject(step, pair, snap, o, misses) {
        const t = persona.terms(snap);
        if (o.held) {
            this.log.info('want "' + step.want + '": ' + o.name + ' (' + o.id + ') is already in the hand');
            misses.push({ what: step.want, why: o.name + '已经拿在手上了，不用再找' });
            return null;
        }
        const where = o.pocket ? '在你的背包里' : (o.room ? '在' + o.room : (typeof o.meters === 'number' ? '在离你大约' + Math.round(o.meters) + '米的地方' : '就在这里'));
        if (o.pocket) {
            const take = (o.actions || []).find((a) => a.id === 'AutoFind_PutDown_Inventory') || (o.actions || []).find((a) => a.pocket);
            if (take) {
                this.log.info('want "' + step.want + '" -> found ' + o.name + ' (' + o.id + ') ' + where + ', ' + take.id + ' ' + take.name);
                return {
                    type: 'use_object', kind: take.kind || actionKind(take.id, take.name), objectId: o.id, objectName: o.name,
                    interaction: take, want: step.want, goal: '从背包里拿出' + o.name, found: where
                };
            }
            this.log.info('want "' + step.want + '": ' + o.name + ' (' + o.id + ') is in the pocket, but nothing takes it out');
            misses.push({ what: step.want, why: o.name + '在背包里，这会儿没有把它拿出来的动作' });
            return null;
        }
        let actions = [];
        try {
            actions = await this.actions.allObjectActions(pair.partnerId, o.id, snap.partner.ageGroup);
        } catch (e) {
            if (e instanceof GameOfflineError) throw e;
            this.log.debug('find: actions of ' + o.id + ' unreadable: ' + e.message);
        }
        const take = actions.find((a) => a.id === 'PickUp') || actions.find((a) => /^PickUp_/.test(a.id)) || actions.find((a) => a.id === 'Put_In_Inventory');
        if (take) {
            this.log.info('want "' + step.want + '" -> found ' + o.name + ' (' + o.id + ') ' + where + ', ' + take.id + ' ' + take.name);
            return {
                type: 'use_object', kind: take.kind || actionKind(take.id, take.name), objectId: o.id, objectName: o.name,
                interaction: take, want: step.want, goal: '找到' + o.name + '并拿在手上', found: where
            };
        }
        // Found but not carried: what the request wants done with it is read from its own menu.
        this.log.info('want "' + step.want + '": found ' + o.name + ' (' + o.id + ') ' + where + ', not carried; looking at what it does');
        return { type: '_use', id: o.id, name: o.name, why: '找到了，' + o.name + where + '，但它拿不起来，只能告诉' + t.call + '它在哪' };
    }

    // Food for someone: a dish lying out is picked up and handed over, a dish kept in the fridge
    // is taken out and brought to them. A specific dish that is not here is left to cooking.
    async serveRoute(step, pair, snap, known, ids, who, ctx) {
        if (!who.here) {
            this.log.info('want "' + step.want + '" is for ' + who.name + ', who is not here; serving the usual way');
            return null;
        }
        if (who.id === String(pair.partnerId)) return null;
        if (!this.meals.canServePerson()) {
            this.log.info('want "' + step.want + '" is for ' + who.name + ', but the HouseholdJournal mod running is too old to serve someone; serving the usual way');
            return null;
        }
        const dish = this.pickDish(step, snap, known, ids, ctx);
        if (!dish) return null;
        const mode = dish.loose ? 'hand' : 'give';
        const m = MEAL_MODES[mode];
        const interaction = {
            id: MEAL_PREFIX + dish.id + m.suffix,
            name: m.label(dish.name, who.name),
            hint: '',
            kind: 'meal',
            meal: { dish: dish.id, container: dish.loose ? '0' : String(dish.container), name: dish.name, mode, person: who.id, personName: who.name }
        };
        this.log.info('want "' + step.want + '" -> ' + mode + ' ' + dish.name + ' (' + dish.id + ')' + (dish.loose ? '' : ' from ' + dish.containerName) + ' to ' + who.name);
        return {
            type: 'use_object', kind: 'meal', objectId: dish.loose ? dish.id : String(dish.container),
            objectName: dish.loose ? dish.name : dish.containerName, interaction, want: step.want, goal: m.purpose(dish.name, who.name)
        };
    }

    // A family meal for the actor themselves is already a concrete game route. Pick the real
    // stored dish here instead of asking the model to copy a dynamically injected FamilyMeal id.
    selfMealRoute(step, snap, known, ids, ctx) {
        const text = [step.want, ctx && ctx.asked, ctx && ctx.promise].filter(Boolean).join(' ');
        if (!FOOD_WANT_RE.test(text) || !/吃|饿|盛|拿|取|摆|放|端/.test(text)) return null;
        if (/放(?:进|入|回).*冰箱|收(?:进|入|回).*冰箱|冷藏|倒掉|扔掉|清理|洗碗/.test(text)) return null;
        const dish = this.pickDish(step, snap, known, ids, ctx, true);
        if (!dish) return null;
        const intent = [step.want, ctx && ctx.promise].filter(Boolean).join(' ');
        const eating = !/不吃|别吃|不用吃|先别吃/.test(intent) && (/吃|饿|盛/.test(intent) || /自己.*(?:拿|取).*(?:块|份|点)/.test(intent));
        const mode = eating ? 'eat' : 'table';
        const m = MEAL_MODES[mode];
        const interaction = {
            id: MEAL_PREFIX + dish.id + m.suffix,
            name: m.label(dish.name),
            hint: '',
            kind: 'meal',
            meal: { dish: dish.id, container: String(dish.container), name: dish.name, mode }
        };
        this.log.info('want "' + step.want + '" -> ' + mode + ' ' + dish.name + ' (' + dish.id + ') from ' + dish.containerName + ' (direct)');
        return {
            type: 'use_object', kind: 'meal', objectId: String(dish.container), objectName: dish.containerName,
            interaction, want: step.want, goal: m.purpose(dish.name)
        };
    }

    // The dish meant: named in the texts, then the one the model pointed at, then (for a plain
    // "something to eat") the freshest one lying out, then one kept in the fridge.
    pickDish(step, snap, known, ids, ctx, storedOnly) {
        const scene = snap.scene || {};
        // The scene also shows the home's food while the person is elsewhere; that is not at hand.
        if (!scene.here) return null;
        const loose = [];
        (scene.foods || []).forEach((f, i) => {
            if (!f || !f.id || f.carriedBy || String(f.state || '').indexOf('能吃') !== 0) return;
            loose.push({ id: String(f.id), name: f.name || (known.get(String(f.id)) || {}).name || '', loose: true, at: i });
        });
        const stored = [];
        (scene.stored || []).forEach((f, i) => {
            if (!f || !f.id || !f.containerId || f.spoiled || f.left === 0) return;
            stored.push({ id: String(f.id), name: f.name || '', loose: false, container: String(f.containerId), containerName: f.container || '冰箱', at: i });
        });
        const all = (storedOnly ? stored : loose.concat(stored)).filter((d) => d.name);
        if (!all.length) return null;
        // "给爸爸做红烧肉" asks for cooking even with yesterday's 红烧肉 in the fridge.
        const want = String(step.want || '');
        const cooking = /(做|煮|下厨|烧)(个|点|顿|些|一下|一份|一盘|一顿)?/.test(want) || /(烤|炒|煎|炖|蒸)(个|点|一下|一份|一盘)/.test(want);
        if (cooking && !/端|拿|递|送|盛|热|剩/.test(want)) return null;
        const text = [step.want, ctx && ctx.asked, ctx && ctx.promise].filter(Boolean).join(' ');
        // A dish named by the current action outranks dishes merely mentioned by the conversation.
        // Otherwise an old promise about 松饼 can outvote an explicit new action to eat 煎饼.
        const sources = [step.want, ctx && ctx.asked, ctx && ctx.promise].filter(Boolean);
        let best = 0;
        let key = promiseKey(step.want);
        for (const source of sources) {
            key = promiseKey(source);
            for (const d of all) {
                d.score = chores.dishNameScore(promiseKey(d.name), key);
                if (d.score > best) best = d.score;
            }
            if (best) break;
        }
        // The dish named is here but spoiled, eaten up or in someone's hands: another one is not
        // what was asked for.
        let unusable = 0;
        for (const f of (storedOnly ? [] : (scene.foods || [])).concat(scene.stored || [])) {
            if (!f || !f.name || all.some((d) => d.id === String(f.id))) continue;
            unusable = Math.max(unusable, chores.dishNameScore(promiseKey(f.name), key));
        }
        if (unusable > best) {
            this.log.info('want "' + step.want + '": the dish meant is here but cannot be served (spoiled, eaten up or being carried)');
            return null;
        }
        const named = best ? all.filter((d) => d.score === best) : [];
        const leftovers = /剩/.test(text);
        const order = (list) => list.slice().sort((a, b) => {
            if (leftovers && a.loose !== b.loose) return a.loose ? 1 : -1;
            if (a.loose !== b.loose) return a.loose ? -1 : 1;
            return (b.at || 0) - (a.at || 0);
        });
        if (named.length) return order(named)[0];
        const pointed = all.filter((d) => ids.indexOf(d.id) >= 0 || (d.container && ids.indexOf(d.container) >= 0));
        if (pointed.length) return order(pointed)[0];
        if (/吃的|喝的|东西|饭|菜|剩|点心|零食|饿/.test(text)) return order(all)[0];
        return null;
    }

    // What the want is for: the player's own words (when the character texts first, the player's
    // latest texts), the reply and the promise. The want line alone is often a narrow or
    // half-way phrasing of that purpose.
    wantContext(pair, bubbles, pending, promise) {
        const thread = this.mailbox.thread(pair.key);
        const ids = new Set((pending || []).map((m) => m && m.id));
        const earlier = thread ? thread.messages.filter((m) => !ids.has(m.id)).slice(-WANT_CONTEXT_MESSAGES) : [];
        let asked = (pending || []).map((m) => m && m.text).filter(Boolean).join('\n');
        if (!asked) asked = earlier.filter((m) => m.side === 'player').slice(-2).map((m) => m.text).filter(Boolean).join('\n');
        return {
            asked,
            // asked is what the player just sent, not their older texts recalled for a proactive one.
            replying: ids.size > 0,
            said: (bubbles || []).join('\n'),
            promise: typeof promise === 'string' ? promise.trim() : '',
            earlier: earlier.map((m) => ({ mine: m.side !== 'player', text: m.text }))
        };
    }

    // A failed check is not a reason to drop the model's own choice.
    async checkWant(step, snap, ctx) {
        try {
            const interaction = Object.assign({}, step.interaction, { steps: await this.actions.bagSteps(step.interaction.id) });
            const p = persona.wantCheckPrompt({ snap, want: step.want, goal: step.goal, objectName: step.objectName, interaction, ctx });
            const r = await this.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0.1, max_tokens: 200, purpose: 'want_check' });
            return { ok: r && r.ok !== false, why: String((r && r.why) || '').slice(0, 120) };
        } catch (e) {
            this.log.warn('want check failed: ' + (e && e.message || e));
            return { ok: true, why: '' };
        }
    }

    loadSameTask() {
        const r = fsx.readJson(SAME_TASK_FILE);
        const list = r.ok && r.value && Array.isArray(r.value.entries) ? r.value.entries : [];
        const now = Date.now();
        const map = new Map();
        list.sort((a, b) => (a && a.at || 0) - (b && b.at || 0));
        for (const e of list) {
            if (!e || typeof e.k !== 'string' || typeof e.at !== 'number' || now - e.at >= SAME_TASK_KEEP_MS) continue;
            map.set(e.k, { same: !!e.same, at: e.at });
        }
        return map;
    }

    saveSameTask() {
        if (!this.sameTaskDirty) return;
        const now = Date.now();
        const entries = [];
        for (const pair of this.sameTaskCache) {
            const k = pair[0];
            const v = pair[1];
            if (v && now - v.at < SAME_TASK_KEEP_MS) entries.push({ k, same: !!v.same, at: v.at });
        }
        try {
            fsx.writeJson(SAME_TASK_FILE, { v: 1, entries: entries.slice(-SAME_TASK_MAX) }, false);
            this.sameTaskDirty = false;
        } catch (e) {
            this.log.warn('same-task cache not saved: ' + e.message);
        }
    }

    // The answer depends only on the two interactions, what they are done on and what was
    // wanted, so it is asked once and kept.
    async sameTask(hold, cur) {
        const nowId = String(cur.interaction_bag_id);
        const nowTarget = cur.target_entity_id !== undefined && cur.target_entity_id !== null ? String(cur.target_entity_id) : '';
        const cacheKey = [hold.bagId, hold.targetId || '', nowId, nowTarget, hold.want || ''].join('|');
        const known = this.sameTaskCache.get(cacheKey);
        if (known && Date.now() - known.at < SAME_TASK_KEEP_MS) {
            this.log.info('same task? ' + hold.bagId + ' -> ' + nowId + ': ' + (known.same ? 'yes' : 'no') + ' (asked before)');
            return known.same;
        }
        const names = await Promise.all([
            hold.label && hold.label !== hold.bagId ? Promise.resolve(hold.label) : this.world.interactionName(hold.bagId),
            this.world.interactionName(nowId),
            hold.targetId ? this.world.objectDisplayName(hold.targetId) : Promise.resolve(''),
            nowTarget && nowTarget !== '0' ? this.world.objectDisplayName(nowTarget) : Promise.resolve('')
        ]);
        const p = persona.sameTaskPrompt({
            asked: { id: hold.bagId, name: names[0], on: names[2] },
            want: hold.want || '',
            now: { id: nowId, name: names[1], on: names[3] }
        });
        const r = await this.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0.1, max_tokens: 200, purpose: 'same_task' });
        const same = !!(r && r.same === true);
        this.log.info('same task? ' + hold.bagId + ' -> ' + nowId + ': ' + (same ? 'yes' : 'no') + (r && r.why ? ' (' + String(r.why).slice(0, 120) + ')' : ''));
        this.sameTaskCache.set(cacheKey, { same, at: Date.now() });
        if (this.sameTaskCache.size > SAME_TASK_MAX) this.sameTaskCache.delete(this.sameTaskCache.keys().next().value);
        this.sameTaskDirty = true;
        return same;
    }

    // The object the model named is compared side by side with the related objects the model
    // picks from the whole lot: "put the food in the fridge" is done on the food, not the fridge,
    // and the fridge alone only offers the opposite (take out).
    async resolveWant(step, pair, snap, catalog, ctx, misses) {
        const known = this.actions.knownObjects(catalog);
        const named = step.objectId ? known.get(step.objectId) : null;
        this.log.info('want "' + step.want + '" on ' + (step.objectId ? step.objectId + ' ' + (named ? named.name : '(not in the list)') : 'no object'));
        const chore = await this.choreRoute(step, pair, snap, known);
        if (chore) return chore;
        let ids = [];
        let forWhom = null;
        let foundOnly = '';
        const places = catalog.allowed && catalog.allowed.has('go_to_place') ? (catalog.places || []) : [];
        const together = !!(catalog.allowed && catalog.allowed.has('go_together'));
        const people = this.wantPeople(snap);
        try {
            const objects = await this.wantObjectMap(pair, snap, known);
            const p = persona.wantObjectsPrompt({ snap, want: step.want, objects, places, people, together, ctx, tried: [], pocketEmpty: !!catalog.pocketEmpty });
            this.log.debug('want objects prompt:\n' + p.system + '\n' + p.user);
            const r = await this.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0.2, max_tokens: 450, purpose: 'want_objects' });
            forWhom = this.personOf(r && r.for, people);
            const place = r && r.place_id ? places.find((x) => String(x.id) === String(r.place_id)) : null;
            const withPlayer = together && r && r.together === true;
            if (withPlayer && (place || snap.together)) {
                const lead = !!(place && r.lead === true && ctx && ctx.replying);
                this.log.info('want "' + step.want + '" -> go together with ' + snap.player.name + (place ? ' to ' + place.name : '') + (lead ? ', leading' : ', following') +
                    (r.why ? ' (' + String(r.why).slice(0, 120) + ')' : ''));
                return { type: 'go_together', place: place || null, lead, want: step.want };
            }
            if (place && place.name !== snap.partner.site) {
                this.log.info('want "' + step.want + '" -> go to ' + place.name + (r.why ? ' (' + String(r.why).slice(0, 120) + ')' : ''));
                return { type: 'go_to_place', fast: false, place, want: step.want };
            }
            ids = (Array.isArray(r && r.object_ids) ? r.object_ids : []).map(String).filter((id) => known.has(id));
            if (r && r.why) this.log.info('want "' + step.want + '" objects: ' + String(r.why).slice(0, 160) + (forWhom ? ' [for ' + forWhom.name + ']' : ''));
            const thing = r && typeof r.find === 'string' ? r.find.trim().slice(0, 30) : '';
            if (thing) {
                const route = await this.findRoute(step, pair, snap, known, ids, thing, misses);
                if (!route || route.type !== '_use') return route;
                ids = route.ids;
                foundOnly = route.why;
            }
            if (FOOD_WANT_RE.test(step.want + ' ' + (r.goal || ''))) {
                if (forWhom) {
                    const served = await this.serveRoute(step, pair, snap, known, ids, forWhom, ctx);
                    if (served) return served;
                } else {
                    const own = this.selfMealRoute(step, snap, known, ids, ctx);
                    if (own) return own;
                }
            }
        } catch (e) {
            this.log.warn('want "' + step.want + '": choosing objects failed: ' + (e && e.message || e));
            if (!named) {
                misses.push(Object.assign({ what: step.want }, actionFailure(e, 'want_objects')));
                return null;
            }
        }
        const max = this.cfg.actions.want_objects || 6;
        const pool = (named ? [named.id] : []).concat(ids.filter((id) => !named || id !== named.id)).slice(0, max + (named ? 1 : 0));
        if (pool.length) {
            this.log.info('want "' + step.want + '": looking at ' + pool.map((id) => id + ' ' + known.get(id).name).join(', '));
            let hit;
            try {
                hit = await this.pickWantAction(step, pair, snap, catalog, pool, ctx);
            } catch (e) {
                misses.push(Object.assign({ what: step.want }, actionFailure(e, e.lookupStage || 'want_pick')));
                return null;
            }
            if (hit) {
                hit.want = step.want;
                const verdict = await this.checkWant(hit, snap, ctx);
                if (verdict.ok) {
                    // Cooked for someone: once it is done, the new dish is served to them.
                    if (forWhom && hit.kind === 'cook') hit.forWhom = { id: forWhom.id, name: forWhom.name };
                    return hit;
                }
                this.log.info('want "' + step.want + '": ' + hit.interaction.id + ' ' + hit.interaction.name + ' @' + hit.objectName + ' does not do it either (' + verdict.why + ')');
                misses.push({ what: step.want, why: '想用「' + hit.objectName + '」' + hit.interaction.name + '，但那样做不成（' + verdict.why + '）' });
                return null;
            }
        }
        this.log.info('want "' + step.want + '": the game offers nothing that does this here');
        misses.push({
            what: step.want,
            code: pool.length ? 'no_available_action' : 'no_matching_object',
            why: foundOnly ? foundOnly : pool.length
                ? '已找到' + pool.map((id) => '「' + known.get(id).name + '」').join('、') + '，但当前没有确认能完成这件事的可用做法'
                : '身边找不到能用来做这件事的东西'
        });
        return null;
    }

    // Every object the person was shown, with what the game lets them do to each kind of thing.
    // Without the action names the pick is by name alone and lands on whatever sounds close.
    async wantObjectMap(pair, snap, known) {
        const objects = Array.from(known.values());
        try {
            const started = Date.now();
            const caps = await this.actions.capabilities(pair.partnerId, snap.partner.ageGroup, objects);
            this.log.debug('capability map: ' + caps.length + ' kind(s) of thing from ' + objects.length + ' object(s) in ' + (Date.now() - started) + 'ms');
            await this.markNeighbours(caps);
            return caps;
        } catch (e) {
            this.log.warn('capability map failed, choosing by name: ' + (e && e.message || e));
            return objects;
        }
    }

    // "By the computer" names a place, not the thing: each line says what stands next to it.
    async markNeighbours(rows) {
        let scan = null;
        try {
            scan = await this.actions.scanSite();
        } catch (e) {
            if (e instanceof GameOfflineError) throw e;
            return;
        }
        if (!scan || !scan.length) return;
        const at = new Map();
        for (const s of scan) if (typeof s.x === 'number' && typeof s.y === 'number') at.set(String(s.id), s);
        for (const r of rows) {
            const me = r && at.get(String(r.id));
            if (!me) continue;
            const near = [];
            for (const s of scan) {
                if (s === me || s.name === r.name || typeof s.x !== 'number') continue;
                const d = Math.hypot(s.x - me.x, s.y - me.y);
                if (d <= NEIGHBOUR_CM) near.push({ name: s.name, d: d });
            }
            near.sort((a, b) => a.d - b.d);
            const names = [];
            for (const n of near) if (names.indexOf(n.name) < 0 && names.length < NEIGHBOUR_MAX) names.push(n.name);
            if (names.length) r.near = names;
        }
    }

    // Read while the reply is being written, so choosing the objects for a want does not wait.
    warmCapabilities(pair, snap, catalog) {
        if (!catalog.allowed || !catalog.allowed.has('use_object')) return;
        const known = this.actions.knownObjects(catalog);
        if (!known.size) return;
        this.actions.capabilities(pair.partnerId, snap.partner.ageGroup, Array.from(known.values()))
            .catch((e) => this.log.debug('capability warm-up: ' + (e && e.message || e)));
    }

    async pickWantAction(step, pair, snap, catalog, ids, ctx) {
        let candidates;
        try {
            candidates = await this.actions.wantCandidates(pair.partnerId, snap.partner.ageGroup, catalog, ids);
        } catch (e) {
            this.log.warn('want "' + step.want + '": could not read object actions: ' + e.message);
            e.lookupStage = 'object_actions';
            throw e;
        }
        const rejected = step.interaction ? step.objectId + '>' + step.interaction.id : '';
        if (rejected) {
            candidates = candidates
                .map((o) => Object.assign({}, o, { actions: o.actions.filter((a) => o.id + '>' + a.id !== rejected) }))
                .filter((o) => o.actions.length);
        }
        if (!candidates.length) {
            this.log.info('want "' + step.want + '": no actions on ' + ids.join(', '));
            return null;
        }
        // A hallucinated id is a recoverable model mistake, not proof that the object cannot do
        // the job. Show the invalid answer and ask once more against the same concrete candidates.
        for (let attempt = 0; attempt < 2; attempt++) {
            let pick;
            try {
                const p = persona.wantPrompt({ snap, want: step.want, candidates, ctx });
                if (attempt) {
                    p.user += '\n上一次回答的物件与做法编号不是清单中的一对。这次必须原样复制同一条清单里的 object_id 和 interaction_id；确实没有合适做法时，两个字段都留空。';
                }
                this.log.debug('want prompt:\n' + p.system + '\n' + p.user);
                pick = await this.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0.2, max_tokens: 300, purpose: 'want_pick' });
            } catch (e) {
                this.log.warn('want "' + step.want + '" failed: ' + (e && e.message || e));
                e.lookupStage = 'want_pick';
                throw e;
            }
            const valid = !!pick && typeof pick === 'object' && !Array.isArray(pick);
            const obj = valid && candidates.find((o) => o.id === String(pick.object_id || ''));
            const it = obj && obj.actions.find((a) => a.id === String(pick.interaction_id || ''));
            if (!valid || (pick.object_id || pick.interaction_id) && !it) {
                const detail = String(JSON.stringify(pick)).slice(0, 500);
                this.log.warn('want "' + step.want + '": model chose an action outside the supplied candidates (attempt ' + (attempt + 1) + '/2): ' + detail);
                if (!attempt) continue;
                const error = new LlmError('format', 'object action choice was not in the supplied candidates after one correction');
                error.lookupStage = 'want_pick';
                throw error;
            }
            const goal = typeof pick.goal === 'string' && pick.goal.trim() ? ' [goal: ' + pick.goal.trim().slice(0, 80) + ']' : '';
            if (!obj || !it) {
                this.log.info('want "' + step.want + '": nothing fits on ' + candidates.map((o) => o.name + ' [' + o.actions.map((a) => a.id).join(',') + ']').join(', ') + goal +
                    (typeof pick.why === 'string' && pick.why.trim() ? ' why: ' + pick.why.trim().slice(0, 120) : ''));
                return null;
            }
            this.log.info('want "' + step.want + '" -> ' + it.id + ' ' + it.name + ' @' + obj.name + ' (' + obj.id + ')' + goal + (attempt ? ' (after correction)' : ''));
            return {
                type: 'use_object', kind: it.kind || actionKind(it.id, it.name), objectId: obj.id, objectName: obj.name, interaction: it,
                goal: typeof pick.goal === 'string' ? pick.goal.trim().slice(0, 80) : ''
            };
        }
        return null;
    }

    // '' when nothing was agreed to, null when the check itself failed.
    async spokenPromise(snap, bubbles, pending) {
        try {
            const asked = (pending || []).map((m) => m && m.text).filter(Boolean).join('\n');
            const p = persona.spokenPromisePrompt({ snap, bubbles, asked });
            const r = await this.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0.1, max_tokens: 120, purpose: 'promise_check' });
            return r && typeof r.promise === 'string' ? r.promise.trim().slice(0, 60) : null;
        } catch (e) {
            this.log.warn('promise check failed: ' + (e && e.message || e));
            return null;
        }
    }

    async repairActions(pair, plan, snap, catalog, bubbles, pending, promise) {
        const started = Date.now();
        try {
            const fix = persona.actionRepairPrompt({ snap, bubbles, pending, catalog, promise });
            this.log.debug('action repair prompt:\n' + fix.system + '\n' + fix.user);
            const repaired = await this.llm.json(fix.system, fix.user, { thinking: 'disabled', temperature: 0.2, max_tokens: 800, purpose: 'action_repair' });
            if (!repaired || !Array.isArray(repaired.actions)) throw new LlmError('format', 'action repair returned no actions');
            if (repaired && typeof repaired.why === 'string' && repaired.why.trim()) this.log.info('action repair thinks: ' + JSON.stringify(repaired.why.trim().slice(0, 200)));
            const again = this.actions.normalize(repaired.actions, catalog, snap, this.actionsCfg(pair, snap));
            for (const r of again.rejected) this.log.warn('rejected repaired action ' + JSON.stringify(r.action) + ': ' + r.reason);
            if (again.steps.length) {
                plan = Object.assign({}, plan, again);
                this.log.info('actions repaired: ' + again.steps.map((s) => s.type + (s.interaction ? ' ' + s.interaction.name : '')).join(', '));
            } else {
                this.log.info('action repair kept nothing');
            }
        } catch (e) {
            this.log.warn('action repair failed: ' + (e && e.message || e));
            return { plan, failure: actionFailure(e, 'action_repair') };
        } finally {
            this.log.info('action repair [' + pair.key + '] took ' + (Date.now() - started) + 'ms');
        }
        return { plan, failure: null };
    }

    recentPromises(key) {
        const now = Date.now();
        return (this.state.pair(key).promises || []).filter((p) => p && p.text && now - p.at < PROMISE_KEEP_MS);
    }

    async deliver(pair, snap, catalog, result, reAt, kind, thinkingMs, pending) {
        if (typeof result.think === 'string' && result.think.trim()) {
            this.log.info(kind + ' [' + pair.key + '] thinks: ' + JSON.stringify(result.think.trim().slice(0, 300)));
        }
        const bubbles = this.cleanBubbles(result.messages);
        if (!bubbles.length) {
            if (kind === 'reply') throw new LlmError('format', 'model returned no message text');
            this.log.info('proactive [' + pair.key + ']: model chose not to send anything');
            return { sent: [] };
        }
        const isReply = kind === 'reply';
        const planStarted = Date.now();
        // Ways the player just called wrong are dropped before anything is planned from them.
        const unlearned = isReply ? this.tagUnlearn(pair, snap, result) : [];
        snap.teachingNow = isReply && !!(result.learned && typeof result.learned.task === 'string' && result.learned.task.trim());
        // A progress report tells what the queued steps are doing; its words are not new work.
        const plan = result.report
            ? { steps: [], misses: [], promised: '', later: [] }
            : await this.planActions(pair, snap, catalog, result, bubbles, isReply ? (pending || []) : [], !isReply);
        this.log.info('reply timing [' + pair.key + '] planning ' + (Date.now() - planStarted) + 'ms');
        if (isReply) {
            this.tagLesson(pair, snap, result, plan.steps, unlearned);
            this.tagExperience(pair, plan.steps);
        }
        const st = this.state.pair(pair.key);
        // The reply already says where things stand; an older report would only repeat it.
        if (isReply && st.progress && st.progress.length) {
            st.progress = [];
            this.state.save();
        }
        const promised = plan.promised || '';
        if (promised) {
            const now = Date.now();
            st.promises = (st.promises || []).filter((p) => p && now - p.at < PROMISE_KEEP_MS).concat([{ at: now, game: this.gameNow(), text: promised.slice(0, 80) }]).slice(-4);
            this.state.save();
        }
        const texts = [];
        const asked = isReply ? (pending || []) : [];
        for (let i = 0; i < asked.length; i++) if (asked[i] && asked[i].text) texts.push(asked[i].text);
        const arranged = arrangePlan(plan.steps, {
            pending: texts,
            bubbles: bubbles,
            activity: snap.partner.activity,
            finished: st.finished || [],
            catalog: catalog,
            ageGroup: snap.partner.ageGroup,
            proactive: !isReply,
            carrying: this.meals.carrying(pair.partnerId, snap.partner.activity && snap.partner.activity.id),
            now: Date.now()
        });
        if (arranged.notes.length) this.log.info('plan [' + pair.key + '] ' + arranged.notes.join('; '));
        // A reply that does nothing new leaves the task in progress, and its watch, as they are.
        if (arranged.wait || arranged.now.concat(arranged.later).some((s) => s.type !== 'emote')) delete st.follow;
        else if (st.follow) this.log.info('plan [' + pair.key + '] nothing new to do, still following the earlier plan');
        const sent = [];
        // Start the action before the typing delay. The text can catch up; the body cannot wait.
        const actionRun = arranged.now.length ? this.actions.execute(arranged.now, pair, snap, this.actionsCfg(pair, snap)) : null;
        for (let i = 0; i < bubbles.length; i++) {
            const text = bubbles[i];
            let delay = this.typingDelay(text);
            if (i === 0) delay = Math.max(400, delay - (thinkingMs || 0));
            this.setStatus(pair.key, { state: 'typing' });
            await sleep(delay);
            // The game clock now, not at the snapshot: the typing delay lets game minutes pass.
            const env = await this.game.soft('environment_get_state', {}).catch(() => null);
            const msg = this.mailbox.append(pair.key, text, reAt, kind, env || snap.env);
            sent.push(msg);
            this.log.info(kind + ' [' + pair.key + '] ' + snap.partner.name + ' -> ' + JSON.stringify(text));
            if (this.cfg.immersion.toast_on_message) {
                const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
                this.game.soft('toast_show', { Message: snap.partner.name + '：' + preview, Lifetime: 6 }).catch(() => {});
            }
        }
        // Moodlets and needs change the game characters themselves: family only.
        if (!pair.outsider) this.considerBuffs(pair, snap, asked, sent);
        this.keepAgreements(pair, snap, st, result, plan, kind);
        if (snap.preferOpen) this.preferences.fromReply(pair, snap, result.prefer);
        if (snap.storyRule) this.stories.fromReply(pair, snap, result.story);
        // How the texts made the contact feel lasts past the hour when it was strong; a message the
        // contact sent first has no felt of the player's words.
        this.ties.fromReply(pair, snap, isReply ? result.felt : null, result.ties);
        if (isReply) this.weighBond(pair, st, result, asked, arranged);
        const results = actionRun ? await actionRun : [];
        const misses = (plan.misses || []).slice();
        for (let i = 0; i < results.length; i++) {
            if (!results[i] || results[i].ok !== false) continue;
            const s = arranged.now[i] || {};
            if (results[i].taken) {
                this.waitForTaken(pair, snap, st, s, results[i].taken, misses);
                continue;
            }
            misses.push({
                what: s.want || (s.interaction && s.interaction.name) || promised || '刚才要做的事',
                why: '刚要动手就没做起来（' + String(results[i].note || '').slice(0, 80) + '）'
            });
            this.lessonFailed(pair.key, s.lesson, '刚要动手就没做起来：' + String(results[i].note || '').slice(0, 80));
        }
        this.noteSetbacks(pair.key, misses);
        if (results.deferred && results.deferred.length) {
            const later = results.deferred.concat(arranged.later || []);
            this.keepFollow(st, pair, snap, Object.assign({}, arranged, { later: later, wait: true, waitMs: 0, untilScheduleEnds: true }), null);
            this.log.info('follow [' + pair.key + '] ' + later.length + ' step(s) wait until ' + (results.scheduled.what || 'the timetable') + ' ends');
        } else {
            this.keepFollow(st, pair, snap, arranged, results.hold || null);
        }
        if (st.follow && plan.focusId) st.follow.focusId = plan.focusId;
        const focus = this.objectFocus.get(pair.key);
        if (focus && focus.task && results.hold && results.hold.bagId === focus.task.bagId &&
            String(results.hold.targetId) === String(focus.task.objectId)) focus.status = 'started';
        // Several steps, or something the player asked for: each step done is told as it happens.
        const queued = physicalCount(arranged.now.concat(arranged.later));
        if (st.follow && !result.report && queued && (asked.length || queued >= 2)) {
            st.follow.report = true;
            this.state.save();
        }
        if (results.hold) {
            try {
                await this.actions.reassert(pair.partnerId, results.hold);
            } catch (e) {
                this.log.warn('could not keep the action in front: ' + e.message);
            }
        }
        const added = this.memory.addFacts(pair.playerId, pair.partnerId, result.remember, snap.env && snap.env.day);
        if (added) this.log.info('remembered ' + added + ' new fact(s) for ' + pair.key + ': ' + JSON.stringify(result.remember));
        return { sent, actions: results };
    }

    // How the player's texts and errands moved the character's feelings toward the player.
    weighBond(pair, st, result, asked, arranged) {
        const now = Date.now();
        const before = this.realism.bond(st, now).score;
        const notes = [];
        const f = result.felt;
        const level = f && typeof f === 'object' ? f.level : f;
        const why = f && typeof f === 'object' && typeof f.why === 'string' ? f.why.trim().slice(0, 30) : '';
        const moved = this.realism.felt(st, level, why, now);
        if (moved) notes.push('felt ' + (moved > 0 ? '+' : '') + moved + (why ? ' (' + why + ')' : ''));
        const errand = asked.length && arranged.now.concat(arranged.later || []).some((s) => s && s.type !== 'emote' && s.type !== 'stop_current');
        if (errand) {
            const worn = this.realism.ordered(st, now);
            if (worn) notes.push('errands ' + worn);
        }
        const after = this.realism.bond(st, now).score;
        if (notes.length) this.log.info('bond [' + pair.key + '] ' + Math.round(before) + ' -> ' + Math.round(after) + ': ' + notes.join(', '));
        this.state.save();
    }

    // Someone else is on what the character went to use. It says so, and the thing goes into the
    // agenda for half an hour later, when it is reminded to try again.
    waitForTaken(pair, snap, st, step, taken, misses) {
        const object = taken.object || step.objectName || '';
        const what = step.want || (step.interaction && step.interaction.name) || ('用' + object);
        if (taken.id && object) this.ties.friction(pair.partnerId, taken.id, object, snap.env && snap.env.day);
        misses.push({
            what: what,
            why: (taken.name || '别人') + '正在用' + object + (taken.doing ? '（' + taken.doing + '）' : '') + '，得等' + (taken.name || '别人') + '用完',
            taken: true
        });
        const gm = gameMinute(snap.env);
        if (gm === null) return;
        const entry = this.agenda.add(st, { what: what.slice(0, 50), due: gm + TAKEN_RETRY_GAME_MIN }, snap.env, 'taken');
        this.log.info('agenda [' + pair.key + '] ' + entry.id + ' "' + entry.what + '" again at ' + describeDue(entry.due, snap.env) + ' (' + taken.name + ' is on ' + object + ')');
        this.state.save();
    }

    // Runs beside the actions; how the texts made either person feel never holds up the reply.
    considerBuffs(pair, snap, asked, sent) {
        const exchange = [];
        const ids = new Set();
        for (const m of asked) if (m && m.text) { exchange.push({ side: 'player', text: m.text }); ids.add(m.id); }
        for (const m of sent) if (m && m.text) { exchange.push({ side: 'partner', text: m.text }); ids.add(m.id); }
        const thread = this.mailbox.thread(pair.key);
        const before = thread ? thread.messages.filter((m) => !ids.has(m.id)).slice(-6).map((m) => ({ side: m.side === 'player' ? 'player' : 'partner', text: m.text })) : [];
        aftermath.consider(this, pair, snap, exchange, before)
            .catch((e) => this.log.warn('aftermath [' + pair.key + '] failed: ' + (e && e.stack || e)));
    }

    // ---------------------------------------------------------------- setbacks
    // Something the character meant to do did not happen. Instead of dropping it silently, the
    // character texts the player about it in its own voice so the player can steer.
    liveSetbacks(key) {
        const now = Date.now();
        const maxAge = this.cfg.setbacks.max_age_minutes * 60000;
        return (this.state.pair(key).setbacks || []).filter((s) => s && s.what && now - s.at < maxAge);
    }

    noteSetbacks(key, items) {
        if (!this.cfg.setbacks.enabled || !items || !items.length) return;
        const st = this.state.pair(key);
        const list = this.liveSetbacks(key);
        const now = Date.now();
        const added = [];
        for (const it of items) {
            if (!it || !it.what) continue;
            const what = String(it.what).slice(0, 80);
            const why = String(it.why || '').slice(0, 200);
            if (list.some((s) => s.what === what && s.why === why)) continue;
            const item = { at: now, game: this.gameNow(), what, why, code: it.code || '', kind: it.kind || '' };
            list.push(item);
            added.push(item);
            // Waiting for someone else to finish is not a failure of one's own.
            if (!it.taken && !/_error$/.test(it.code || '')) this.realism.noteAftermath(st, this.freshEnv(), { kind: 'failed', what, why });
        }
        if (!added.length) return;
        st.setbacks = list.slice(-4);
        this.state.save();
        this.log.info('setback [' + key + '] ' + added.map((s) => '"' + s.what + '": ' + s.why).join(' | '));
        this.scheduleSetback(key, SETBACK_SETTLE_MS);
    }

    scheduleSetback(key, ms) {
        if (this.setbackTimers.has(key)) return;
        const t = setTimeout(() => {
            this.setbackTimers.delete(key);
            this.flushSetback(key).catch((e) => this.log.warn('setback [' + key + '] failed: ' + (e && e.message || e)));
        }, Math.max(500, ms));
        if (t.unref) t.unref();
        this.setbackTimers.set(key, t);
    }

    async flushSetback(key) {
        if (this.stopping || this.switching) return;
        if (!this.householdOk) {
            this.scheduleSetback(key, 5000);
            return;
        }
        const st = this.state.pair(key);
        const items = this.liveSetbacks(key);
        if (items.length !== (st.setbacks || []).length) {
            st.setbacks = items;
            this.state.save();
        }
        if (!items.length || this.cfg.mode !== 'auto' || !this.llm.configured || !this.cfg.setbacks.enabled) return;
        // Told once and not answered yet: more texts would pile up. The next reply carries it.
        if (st.setbackAwait) {
            this.log.info('setback [' + key + '] kept for the next reply, the last one is still unanswered');
            return;
        }
        const thread = this.mailbox.thread(key);
        if (!thread) return this.scheduleSetback(key, 5000);
        if (thread.pending.length) return;
        const job = this.job(key);
        if (job.busy || this.proactiveBusy || this.clearRequestAt()) return this.scheduleSetback(key, 4000);
        const now = Date.now();
        const wait = this.cfg.setbacks.cooldown_s * 1000 - (now - (st.setbackSentAt || 0));
        if (wait > 0) return this.scheduleSetback(key, wait);
        const k = parseKey(key);
        const possessed = String(await this.world.possessed());
        if (possessed === k.contactId) {
            this.log.info('setback [' + key + '] dropped: ' + k.contactId + ' is being played now');
            st.setbacks = [];
            this.state.save();
            return;
        }
        if (possessed !== k.playerId) return this.scheduleSetback(key, 15000);
        job.busy = true;
        this.proactiveBusy = true;
        try {
            const pair = await this.world.pair(k.playerId, k.contactId);
            st.setbacks = [];
            st.setbackAwait = true;
            st.setbackSentAt = now;
            this.state.save();
            await this.sendSetback(pair, items, thread.answeredAt);
        } catch (e) {
            this.log.warn('setback [' + key + '] not sent: ' + (e && e.message || e));
            this.setStatus(key, { state: 'online', error: '' });
        } finally {
            job.busy = false;
            this.proactiveBusy = false;
        }
    }

    // Verification and the setback message are separated by a fresh world read. If eating has
    // finished since the failure was queued, or is visibly happening now, the old failure is stale.
    setbacksForReport(key, items, snap) {
        const activity = snap && snap.partner && snap.partner.activity || {};
        const activityText = String(activity.id || '') + ' ' + String(activity.action || '');
        const eating = !activity.idle && (actionKind(activity.id, activity.action || '') === 'eat' || /Eat|吃/.test(activityText));
        const finished = (this.state.pair(key).finished || []).filter((f) => f && (f.kind === 'eat' || f.kind === 'meal'));
        return (items || []).filter((it) => {
            if (!it || (it.kind !== 'eat' && it.kind !== 'meal')) return true;
            const completed = finished.some((f) => (f.at || 0) >= (it.at || 0));
            if (!eating && !completed) return true;
            this.log.info('setback [' + key + '] dropped stale meal failure "' + it.what + '": ' + (completed ? 'a meal finished afterwards' : 'the character is eating now'));
            return false;
        });
    }

    async sendSetback(pair, items, answeredAt) {
        this.log.info('setback [' + pair.key + ' ' + pair.role + '] telling: ' + items.map((s) => '"' + s.what + '"').join(', '));
        const snap = await this.snapshot(pair, true);
        items = this.setbacksForReport(pair.key, items, snap);
        if (!items.length) {
            const st = this.state.pair(pair.key);
            st.setbackAwait = false;
            this.state.save();
            return;
        }
        snap.finished = (this.state.pair(pair.key).finished || []).slice(-8);
        snap.promises = this.recentPromises(pair.key);
        // Whether the reply may give the character a new like or dislike today.
        snap.preferOpen = !pair.outsider && this.preferences.open(pair.partnerId, snap.env);
        snap.proximity = await this.world.proximity(pair, this.cfg.proactive.nearby_meters);
        const catalog = await this.actions.catalog(pair, snap, this.actionsCfg(pair, snap));
        const thread = this.mailbox.thread(pair.key);
        const memory = this.memoryFor(pair, snap, items.map((s) => s.what + ' ' + s.why).concat(this.recentTexts(thread, 2)), thread);
        if (!thread || thread.pending.length) {
            const st = this.state.pair(pair.key);
            st.setbacks = items.concat(st.setbacks || []).slice(-4);
            st.setbackAwait = false;
            this.state.save();
            return;
        }
        const st = this.state.pair(pair.key);
        const progress = (st.progress || []).filter((p) => p && Date.now() - p.at < PROGRESS_KEEP_MS);
        if (progress.length) {
            st.progress = [];
            this.state.save();
        }
        const prompt = persona.setbackPrompt({
            snap,
            cfg: this.cfg,
            memory,
            diary: this.todayDiary(pair.partnerId, snap.env),
            catalog,
            history: this.historyFor(thread, memory),
            setbacks: items,
            progress: progress,
            now: Date.now()
        });
        this.log.debug('setback prompt:\n' + prompt.system + '\n' + prompt.user);
        this.setStatus(pair.key, { state: 'typing', partnerName: snap.partner.name, role: pair.role });
        const started = Date.now();
        const result = await this.llm.json(prompt.system, prompt.user, { purpose: 'setback', max_tokens: 900 });
        await this.deliver(pair, snap, catalog, result, answeredAt, 'proactive', Date.now() - started);
        this.setStatus(pair.key, { state: 'online', error: '' });
    }

    async immersion(pair, snap) {
        const im = this.cfg.immersion;
        if (!im.phone_motion && !im.speech_bubble) return;
        const sim = await this.game.soft('entity_get_simulate_state', { entity_id: pair.partnerId });
        if (!sim || !sim.simulated) return;
        const t = persona.terms(snap);
        if (im.speech_bubble) {
            await this.game.soft('entity_show_speech_bubble', { entity_id: pair.partnerId, Text: '在给' + t.call + '回消息…', duration: 6 });
        }
        // Self_UsePhone_Text_Messaging is a full-body loop. While it plays, walking and chores never start.
    }

    async summarizeIfNeeded(pair, snap) {
        const key = pair.key;
        if (this.summarizing.has(key)) return;
        const mem = this.memory.load(pair.playerId, pair.partnerId);
        const thread = this.mailbox.thread(key);
        if (!thread) return;
        const candidates = this.memory.summarizeCandidates(mem, thread.messages);
        if (!candidates) return;
        this.summarizing.add(key);
        try {
            const listed = mem.facts.slice();
            const prompt = persona.summaryPrompt(mem.summary, candidates, snap, listed);
            const r = await this.llm.json(prompt.system, prompt.user, { temperature: 0.3, purpose: 'summary' });
            const fresh = this.memory.load(pair.playerId, pair.partnerId);
            if (typeof r.summary === 'string' && r.summary.trim()) fresh.summary = r.summary.trim().slice(0, 800);
            fresh.summarizedUpTo = candidates[candidates.length - 1].at;
            const day = snap && snap.env && typeof snap.env.day === 'number' ? snap.env.day : undefined;
            const kept = this.memory.addEpisode(fresh, r.episode, r.topics, day, candidates[candidates.length - 1].at);
            this.memory.save(pair.playerId, pair.partnerId, fresh);
            const fixed = this.memory.reviseFacts(pair.playerId, pair.partnerId, listed, r.revise, r.drop);
            if (fixed.revised || fixed.dropped) this.log.info('memory [' + key + '] the summary put right ' + fixed.revised + ' fact(s) and left out ' + fixed.dropped);
            this.memory.addFacts(pair.playerId, pair.partnerId, r.facts, day);
            this.log.info('memory summarized ' + candidates.length + ' messages for ' + key +
                (kept ? ' (episode: ' + String(r.episode).slice(0, 60) + ' / ' + (Array.isArray(r.topics) ? r.topics.join('、') : '') + ')' : ''));
        } finally {
            this.summarizing.delete(key);
        }
    }

    // ---------------------------------------------------------------- tracker + proactive
    // again: something urgent happened; a round already running is followed by another one at once.
    async track(again) {
        if (this.trackerBusy) {
            if (again) this.trackAgain = true;
            return;
        }
        this.trackerBusy = true;
        this.trackAgain = false;
        try {
            await this.trackOnce();
        } catch (e) {
            if (e instanceof GameOfflineError) this.log.debug('tracker: ' + e.message);
            else if (e instanceof PairError) this.log.debug('tracker: ' + e.message);
            else this.log.warn('tracker failed: ' + (e && e.stack || e));
        } finally {
            this.trackerBusy = false;
        }
        if (this.trackAgain && !this.stopping) {
            this.trackAgain = false;
            setTimeout(() => this.track(true), 0);
        }
    }

    // Household members the played character can text, plus that character. Moments adds the
    // wider circle on its own pass. A failure here must not stop texting.
    syncPortraits(ids) {
        if (!this.portraits) return;
        try {
            this.portraits.sync(ids);
        } catch (e) {
            this.log.warn('portraits: ' + (e && e.message || e));
        }
    }

    // The faces of the game phone's contacts, for the phone's Contacts app; every few minutes,
    // and again when another character is played.
    syncContactPortraits(playerId) {
        const now = Date.now();
        if (this.contactFacesFor === playerId && now - (this.contactFacesAt || 0) < CONTACT_FACES_MS) return;
        this.contactFacesFor = playerId;
        this.contactFacesAt = now;
        this.game.soft('contacts_get_all', {}).then((r) => {
            const ids = r && Array.isArray(r.contacts) ? r.contacts.map((c) => c.entity_id) : [];
            if (ids.length) this.syncPortraits(ids);
        }).catch((e) => this.log.debug('contact portraits: ' + (e && e.message || e)));
    }

    // Samples every textable household member of the played character: creates their phone
    // threads, keeps their activity diaries and decides whether one of them texts first.
    async trackOnce() {
        const phase = await this.world.phase();
        if (phase !== 'in_game') return;
        const playerId = await this.world.possessed();
        if (!playerId) return;
        const env = await this.game.soft('environment_get_state', {});
        this.scene.noteClock(env);
        this.trackMoments(playerId, env);
        const contacts = await this.world.contacts(playerId);
        this.syncPortraits([playerId].concat(contacts.map((c) => c.member.entity_id)));
        this.syncContactPortraits(playerId);
        if (!contacts.length) return;
        for (const c of contacts) {
            if (this.stopping) return;
            const contactId = String(c.member.entity_id);
            const key = threadKey(playerId, contactId);
            this.mailbox.ensure(key);
            const cur = this.status.get(key) || {};
            const name = fullName(c.member);
            if (cur.partnerName !== name || cur.role !== c.role) this.setStatus(key, { partnerName: name, role: c.role });
            try {
                await this.trackContact(playerId, contactId, env);
            } catch (e) {
                if (e instanceof GameOfflineError) throw e;
                if (e instanceof PairError) this.log.debug('tracker ' + key + ': ' + e.message);
                else this.log.warn('tracker ' + key + ' failed: ' + (e && e.stack || e));
            }
        }
    }

    // Runs beside the contact tracker: writing a post can take as long as an AI call.
    trackMoments(playerId, env) {
        if (this.momentsTracking || this.stopping) return;
        this.momentsTracking = true;
        this.moments.track(playerId, env)
            .catch((e) => {
                if (e instanceof GameOfflineError) this.log.debug('moments: ' + e.message);
                else this.log.warn('moments track failed: ' + (e && e.stack || e));
            })
            .then(() => { this.momentsTracking = false; });
    }

    // What the phone shows as this contact's built-in way of talking to the played character.
    publishPersonaDefault(pair) {
        const extra = this.cfg.persona && this.cfg.persona.extra ? this.cfg.persona.extra[pair.partnerId] : '';
        const who = {
            role: pair.role,
            label: pair.label,
            player: {
                name: fullName(pair.player),
                firstName: pair.player.first_name || '',
                gender: pair.player.gender || '',
                ageGroup: pair.player.age_group || ''
            },
            partner: { gender: pair.partner.gender || '', ageGroup: pair.partner.age_group || '' }
        };
        try {
            this.personas.publishDefault(pair.partnerId, fullName(pair.partner), extra, pair.playerId, persona.defaultStyle(who));
        } catch (e) {
            this.log.warn('persona default for ' + pair.key + ' not written: ' + e.message);
        }
    }

    async trackContact(playerId, contactId, env) {
        const pair = await this.world.pair(playerId, contactId);
        this.publishPersonaDefault(pair);
        const P = pair.partnerId;
        const [act, work, stats, emo, table] = await Promise.all([
            this.game.soft('interaction_get_current', { entity_id: P }),
            this.game.soft('career_get_work_status', { entity_id: P }),
            this.game.soft('stat_get_all', { entity_id: P }),
            this.game.soft('emotion_get_current', { entity_id: P }),
            this.world.emotionTable()
        ]);
        const site = pair.partner.current_site || '';
        const activity = this.world.activityOf(act);
        // Seen every 20 s, so an eat that began between two texts is known to have begun.
        this.world.eatProgress(P, activity, this.world.needsOf(stats));
        // Growing up seen in the household list, even when the Lua mod did not report it. The
        // game day is kept too, for world events (a death) that arrive between two texts.
        if (env) this.lastEnv = { env, at: Date.now() };
        this.legacy.observe(pair.members, String(playerId), env);
        // Stories move on and grudges fade by game days even when nobody texts.
        if (env) this.stories.tick(pair, env);
        if (env) this.ties.tick(env);
        if (env) {
            this.diary.record(P, {
                at: Date.now(),
                day: env.day,
                time: pad2(env.hour) + ':' + pad2(env.minute || 0),
                act: activity.idle ? 'Idle' : activity.id,
                site,
                boot: this.worldBoot()
            });
        }
        await this.considerProactive(pair, env, activity, work, site, {
            needs: this.world.needsOf(stats),
            emotion: this.world.emotionOf(table, emo)
        });
    }

    // Something that took a while just ended: worth a word, the way people text "done with the
    // dishes" or "finally finished my homework". Kept until it is told or goes stale, so a
    // moment when texting is not possible does not lose it.
    async noteShare(st, activity, now, pc) {
        const id = activity && !activity.idle && activity.id ? String(activity.id) : 'Idle';
        const last = st.lastAct;
        if (last && last.id === id) return;
        st.lastAct = { id, since: now };
        if (!last || last.id === 'Idle' || now - last.since < pc.share_min_seconds * 1000) return;
        const [done, next] = await Promise.all([
            this.world.interactionName(last.id).catch(() => ''),
            id === 'Idle' ? Promise.resolve('') : this.world.interactionName(id).catch(() => '')
        ]);
        if (!done) return;
        const minutes = Math.max(1, Math.round((now - last.since) / 60000));
        st.share = {
            at: now,
            text: '你刚做完「' + done + '」（做了大约 ' + minutes + ' 分钟）' + (next && next !== done ? '，现在在「' + next + '」' : '')
        };
    }

    async homeSiteName(characterId) {
        const info = await this.world.characterInfo(characterId);
        if (!info || !info.home_site_id) return null;
        const sites = await this.world.sites();
        const home = sites.byId.get(String(info.home_site_id));
        return home ? home.name : null;
    }

    async considerProactive(pair, env, activity, work, site, body) {
        const pc = this.cfg.proactive;
        const st = this.state.pair(pair.key);
        const prevWork = st.work;
        const prevSite = st.site;
        st.work = work ? { atWork: !!work.is_at_work } : prevWork;
        st.site = site || prevSite;
        if (!st.asked || typeof st.asked !== 'object') st.asked = {};
        const now = Date.now();
        const prox = await this.world.proximity(pair, pc.nearby_meters);
        if (prox.near) {
            st.lastNearAt = now;
            const mended = this.realism.together(st, now);
            if (mended) this.log.info('bond [' + pair.key + '] ' + Math.round(this.realism.bond(st, now).score) + ' (+' + mended + ', together)');
        }
        const reasons = [];
        const asks = [];
        const t = persona.termsFor(pair.role, pair.player.gender, pair.partner.gender, pair.player.first_name, pair.label);
        const minor = pair.partner.age_group === 'Child' || pair.partner.age_group === 'Teen';
        const cooldown = (pc.need_cooldown_minutes || 45) * 60000;
        const fresh = (key, ms) => now - (st.asked[key] || 0) >= (ms || cooldown);
        // chat: something to tell or talk about rather than something to ask for; it still
        // happens with the two of them side by side, and rides along with an ask.
        const note = (key, text, ask, chat) => {
            const item = { key: key, text: text, ask: !!ask, chat: !!chat };
            reasons.push(item);
            if (ask) asks.push(item);
        };
        if (pc.on_share) await this.noteShare(st, activity, now, pc);
        if (st.share && now - st.share.at < SHARE_KEEP_MS && fresh('share', pc.share_cooldown_minutes * 60000)) {
            note('share', st.share.text, false, true);
        }
        if (work && prevWork && work.has_job) {
            if (pc.on_work_end && prevWork.atWork && !work.is_at_work) note('work-end', '你刚下班离开公司', false);
            if (pc.on_work_start && !prevWork.atWork && work.is_at_work) note('work-start', '你刚到公司开始上班', false);
        }
        const playerSite = pair.player.current_site || '';
        let home = null;
        if ((pc.on_arrive_home && prevSite && site && prevSite !== site) || pc.on_late_absence) home = await this.homeSiteName(pair.partnerId);
        if (pc.on_arrive_home && prevSite && site && prevSite !== site && home === site && playerSite !== site) {
            note('arrive-home', minor ? '你刚回到家，' + t.call + '不在家' : '你刚回到家，但' + t.them + '不在家', false);
        }
        if (pc.on_late_absence && env && typeof env.hour === 'number' && home && site === home && playerSite && playerSite !== home &&
            env.hour >= pc.late_game_hour && st.lateDay !== env.day) {
            st.lateDay = env.day;
            if (minor) note('late', '天已经黑了，' + t.call + '还没回家，你一个人在家有点担心，也有点想' + t.call, true);
            else if (pair.role === 'spouse') note('late', '已经很晚了，' + t.them + '还没回家，你有点担心，想让' + t.them + '说一声什么时候回来', true);
            else if (pair.role === 'parent') note('late', '已经很晚了，' + t.call + '还没回家，你作为家长有点担心，想让' + t.call + '回家', true);
        }
        const state = body || {};
        if (pc.on_needs !== false) {
            const worst = persona.worstNeed(state.needs, pc.need_threshold);
            if (worst && fresh('need:' + worst.key)) {
                note('need:' + worst.key, '你' + worst.text + '（' + worst.key + ' 只剩 ' + worst.value + '%）', true);
            }
        }
        if (pc.on_hopes !== false) {
            const hopes = await this.world.activeHopes(pair.partnerId);
            for (let i = 0; i < hopes.length; i++) {
                const h = hopes[i];
                if (!fresh('hope:' + h.id)) continue;
                const text = persona.hopeAskText(h, t.call);
                if (text) note('hope:' + h.id, text, true);
            }
        }
        if (pc.on_environment !== false) {
            if (fresh('env')) {
                const envAsk = environmentAsk(env, t);
                if (envAsk) note('env', envAsk, true);
            }
            if (!asks.some((a) => a.key === 'env') && playerSite && site && playerSite === site && fresh('mess')) {
                const messy = await this.messNearby();
                if (messy) note('mess', '你身边能看到没收拾的' + messy, true);
            }
        }
        if (state.emotion && state.emotion.tendency === 'negative' && state.emotion.level >= 2 && fresh('mood')) {
            note('mood', '你现在心情不好（' + state.emotion.text + '）', true);
        }
        const reminders = [];
        for (const r of this.tickAgenda(pair.key, st, env)) {
            const key = 'agenda:' + r.item.id;
            if (!fresh(key)) continue;
            const id = r.item.id;
            if (r.kind === 'due' && r.item.source === 'taken') {
                note(key, '刚才你想「' + r.item.what + '」，可是东西被别人占着，只好等一会儿（编号 ' + id + '）。现在再去试试，actions 里写上要做的事，顺口告诉' + t.call + '一声；' +
                    '还是不行或者已经不需要了，就说一声，然后在 settle 里写上编号 ' + id, true);
            } else if (r.kind === 'due') {
                note(key, '到时间了：你答应过' + t.call + '「' + r.item.what + '」（约的是' + describeDue(r.item.due, env) + '，编号 ' + id + '）。' +
                    '现在就去做，actions 里写上要做的事，发消息告诉' + t.them + '你开始做了；真的做不了，就说明原因，和' + t.them + '商量改个时间（新时间写进 promises 的 later），' +
                    '然后在 settle 里写上编号 ' + id, true);
            } else {
                note(key, '你答应过' + t.call + '「' + r.item.what + '」，一直还没做（编号 ' + id + '）。现在方便就去做，并说一声；不方便就先别提', false, true);
            }
            reminders.push({ key: key, id: id, kind: r.kind });
        }
        const thread = this.mailbox.thread(pair.key);
        const lastAt = thread && thread.messages.length ? thread.messages[thread.messages.length - 1].at : 0;
        // Side by side, a quiet stretch is still something to break, just after a longer one.
        // Apart, having just been together counts as having talked.
        const nearChat = prox.near && pc.nearby_chat;
        const idleMs = (nearChat ? pc.nearby_idle_minutes : pc.idle_minutes) * 60000;
        const quietLongEnough = thread && now - lastAt > idleMs && now - (st.lastIdleCheck || 0) > idleMs &&
            (nearChat || (!prox.near && now - (st.lastNearAt || 0) > idleMs));
        if (!asks.length && quietLongEnough) {
            st.lastIdleCheck = now;
            if (Math.random() < pc.idle_chance * this.realism.reachFactor(st, now)) {
                if (nearChat) note('idle', '你和' + t.call + '待在一起，有一阵子没说话了，你想跟' + t.them + '说点什么：分享手上的事、问一句' + t.them + '在干嘛、接着聊之前的话题都行', false, true);
                else if (minor) note('idle', '你有一阵子没跟' + t.call + '聊天了，有点想' + t.call + '，或者有件小事想跟' + t.call + '分享', false, true);
                else if (pair.role === 'spouse') note('idle', '你们有一阵子没聊天了，你有点想' + t.them, false, true);
                else note('idle', '有一阵子没联系' + t.them + '了，想问问' + t.them + '最近怎么样', false, true);
            }
        }
        const urgentNotes = this.incidentNotes(pair, st, t, now);
        this.state.save();
        if (!reasons.length && !urgentNotes.length) return;

        const urgent = urgentNotes.length > 0;
        const chosen = urgent ? urgentNotes : asks.length ? asks.concat(reasons.filter((r) => r.chat && !r.ask)) : reasons;
        let summary = chosen.map((r) => r.text).join('；');
        const skip = (why) => { this.log.info('proactive [' + pair.key + '] skipped (' + summary + '): ' + why); };
        const chatty = nearChat && chosen.some((r) => r.chat);
        if (this.clearRequestAt()) return skip('texts are being cleared');
        if (!pc.enabled) return skip('disabled');
        if (!urgent && this.incidents.anyBlocking()) return skip('an emergency is going on');
        if (!urgent && pc.skip_when_nearby && prox.near && !asks.length && !chatty) return skip('together, ' + proximityText(prox));
        if (this.cfg.mode !== 'auto') return skip('mode ' + this.cfg.mode);
        if (!this.llm.configured) return skip('AI not configured');
        if (!thread) return skip('mailbox busy');
        if (thread.pending.length) return skip('unanswered texts are handled first');
        if (this.job(pair.key).busy || this.proactiveBusy) {
            if (urgent) this.trackAgain = true;
            return skip('busy');
        }
        if (urgent) {
            // Someone in a crisis texts no matter how the chat stood; only sleep holds back news
            // that is not happening right now.
            if (!chosen.some((r) => r.live) && persona.isSleeping(activity)) return skip('asleep');
            return this.sendProactive(pair, st, chosen, summary, thread, true, [], env, true);
        }
        const last = thread.messages[thread.messages.length - 1];
        const unanswered = unansweredSends(thread.messages);
        if (unanswered >= pc.max_unanswered) {
            const worn = this.realism.ignored(st, last && last.id, now);
            if (worn) {
                this.log.info('bond [' + pair.key + '] ' + Math.round(this.realism.bond(st, now).score) + ' (' + worn + ', texts left unanswered)');
                this.state.save();
            }
            return skip(unanswered + ' message(s) in a row still unanswered');
        }
        if (unanswered) {
            const waited = now - last.at;
            if (waited < pc.follow_up_minutes * 60000) return skip('waiting for an answer, ' + Math.round(waited / 1000) + 's so far');
            summary += '；你上一条消息发出去 ' + Math.round(waited / 60000) + ' 分钟了，' + t.call + '还没回';
        }
        const dire = asks.some((r) => r.key.indexOf('need:') === 0 && state.needs && state.needs[r.key.slice(5)] <= 25);
        if (last && now - last.at < JUST_TALKED_MS && !dire) return skip('just talked ' + Math.round((now - last.at) / 1000) + 's ago');
        st.proactive = st.proactive.filter((ts) => now - ts < 3600000);
        if (st.proactive.length >= pc.max_per_hour) return skip('hourly limit for this contact');
        const total = this.state.totalProactive(now);
        if (total.length >= pc.max_per_hour_total) return skip('hourly limit for all contacts');
        if (env && typeof env.hour === 'number') {
            const q = pc.quiet_game_hours;
            const quiet = q[0] <= q[1] ? env.hour >= q[0] && env.hour < q[1] : env.hour >= q[0] || env.hour < q[1];
            const urgent = asks.some((r) => {
                if (r.key.indexOf('need:') !== 0) return false;
                const value = state.needs && state.needs[r.key.slice(5)];
                return typeof value === 'number' && value <= 25;
            });
            if (quiet && !urgent) return skip('quiet hours');
        }
        if (persona.isSleeping(activity)) return skip('asleep');
        return this.sendProactive(pair, st, chosen, summary, thread, asks.length > 0 || chatty, reminders, env, false);
    }

    // urgent: an emergency or turning point (incidentNotes) is told; it counts toward the hourly
    // limits like any text, but was not held back by them.
    async sendProactive(pair, st, chosen, summary, thread, nearbyOk, reminders, env, urgent) {
        const now = Date.now();
        for (let i = 0; i < chosen.length; i++) st.asked[chosen[i].key] = now;
        if (chosen.some((r) => r.key === 'share')) delete st.share;
        this.state.save();
        this.proactiveBusy = true;
        const job = this.job(pair.key);
        job.busy = true;
        try {
            const r = await this.proactive(pair, summary, thread.answeredAt, nearbyOk, urgent);
            if (r && r.sent && r.sent.length) {
                st.proactive.push(Date.now());
                this.state.totalProactive(Date.now()).push(Date.now());
                for (const m of reminders) {
                    if (!chosen.some((c) => c.key === m.key)) continue;
                    this.agenda.acted(st, m.id, env, m.kind);
                    this.log.info('agenda [' + pair.key + '] ' + m.id + ' reminded (' + m.kind + ')');
                }
                this.state.save();
            } else if (urgent) {
                for (let i = 0; i < chosen.length; i++) delete st.asked[chosen[i].key];
                this.state.save();
                this.trackAgain = true;
            }
        } catch (e) {
            this.log.warn('proactive [' + pair.key + '] failed: ' + (e && e.message || e));
            this.setStatus(pair.key, { state: 'online', error: '' });
            if (urgent) {
                for (let i = 0; i < chosen.length; i++) delete st.asked[chosen[i].key];
                this.state.save();
                this.trackAgain = true;
            }
        } finally {
            job.busy = false;
            this.proactiveBusy = false;
        }
    }

    // What of the household's emergencies and turning points this contact still has to tell, at once.
    // live: the emergency is still going on. Each is told once; a text the character already sent
    // since it happened (a reply that took it in) counts as told.
    incidentNotes(pair, st, t, now) {
        const thread = this.mailbox.thread(pair.key);
        const names = new Map((pair.members || []).map((m) => [String(m.entity_id), fullName(m)]));
        const sentSince = (at) => !!thread && thread.messages.some((m) => m.side === 'partner' && m.at >= at);
        const out = [];
        for (const i of this.incidents.view(pair.partnerId, pair.playerId, names, t.call)) {
            const what = i.lines.map((l) => l.trim()).filter(Boolean).join('；');
            let key = '';
            let text = '';
            let since = 0;
            if (i.active && i.urgent) {
                if (!i.involved) continue;
                key = i.key + ':start';
                text = what;
                since = i.startedAt;
            } else if (!i.active && i.grave && /^(fire|accident)$/.test(i.kind)) {
                if (!i.involved || !i.endedAt || now - i.endedAt > INCIDENT_TELL_MS) continue;
                key = i.key + ':end';
                text = what + '。事情过去了，你想让' + t.call + '知道你现在怎么样，也问问' + t.them + '怎么样';
                since = i.endedAt;
            } else if (!i.active && i.urgent) {
                // Sad news reaches the whole family; good news is told by those it happened to.
                if (!(i.grave || i.involved) || now - i.startedAt > INCIDENT_TELL_MS) continue;
                key = i.key;
                text = what;
                since = i.startedAt;
            } else {
                continue;
            }
            if (st.asked[key]) continue;
            if (sentSince(since)) {
                st.asked[key] = now;
                this.log.info('proactive [' + pair.key + '] ' + key + ' already came up in a text');
                continue;
            }
            out.push({ key, text, ask: false, chat: false, urgent: true, live: !!i.active });
        }
        return out;
    }

    async messNearby() {
        const scan = await this.game.soft('entity_scan_objects', {
            Radius: 18,
            Direction: 'all',
            Cone: 180,
            ref: 'pawn',
            Limit: 40,
            sort: 'distance'
        });
        const objs = (scan && scan.objects) || [];
        for (let i = 0; i < objs.length; i++) {
            const name = String(objs[i].display_name || objs[i].name || '');
            if (this.actions.objectState(objs[i].entity_id).indexOf('已变质') === 0) return '已经变质的' + name;
            if (/灰尘|脏|污渍|垃圾/.test(name) && !/垃圾桶/.test(name)) return name;
        }
        return '';
    }

    freshEnv() {
        return this.lastEnv && Date.now() - this.lastEnv.at < ENV_FRESH_MS ? this.lastEnv.env : null;
    }

    // The game clock as { day, min } for something noted now, so the prompts can say how long
    // ago it was in city time; null when the clock is not known.
    gameNow() {
        return gameStamp(this.freshEnv());
    }

    // Moves the pair's agreements along the game clock. One that just slipped by leaves an
    // aftermath for the rest of the day. Returns the reminders due now, as agenda.tick does.
    tickAgenda(key, st, env) {
        const before = this.agenda.signature(st);
        const open = new Set(this.agenda.open(st).map((a) => a.id));
        const due = this.agenda.tick(st, env);
        if (this.agenda.signature(st) === before) return due;
        for (const a of this.agenda.list(st)) {
            if (a.status !== 'missed' || !open.has(a.id)) continue;
            this.realism.noteAftermath(st, env, { kind: 'missed', what: a.what });
            this.log.info('agenda [' + key + '] ' + a.id + ' "' + a.what + '" missed');
        }
        this.state.save();
        return due;
    }

    // withScene: the household scene too, for prompts that decide what someone says or does.
    // What a contact may do in the game. Family: the configured actions. Someone outside the
    // household: nothing while apart, the bridge does not run their life; with the played
    // character (within OUTSIDER_NEAR_M), only social steps towards them.
    actionsCfg(pair, snap) {
        if (!pair || !pair.outsider) return this.cfg.actions;
        const near = !!(snap && snap.outsiderNear);
        return Object.assign({}, this.cfg.actions, {
            enabled: this.cfg.actions.enabled && near,
            allowed: near ? OUTSIDER_ACTIONS.filter((a) => this.cfg.actions.allowed.indexOf(a) >= 0 || a === 'go_to_player') : [],
            allow_teleport: false,
            max_per_reply: Math.min(2, this.cfg.actions.max_per_reply)
        });
    }

    async snapshot(pair, withScene) {
        const snap = await this.world.snapshot(pair);
        if (snap.env) this.lastEnv = { env: snap.env, at: Date.now() };
        if (pair.outsider) {
            const prox = await this.world.proximity(pair, OUTSIDER_NEAR_M).catch(() => null);
            snap.outsiderNear = !!(prox && prox.near);
            // With the played character they can see what is around; apart they cannot.
            snap.together = snap.outsiderNear;
            this.log.info('outsider [' + pair.key + ']: ' + fullName(pair.partner) + ' (' + pair.role + ')' + (snap.outsiderNear ? ' is with the player' : ' is elsewhere, chat only'));
        }
        snap.custom = this.personas.custom(pair.partnerId, pair.playerId);
        snap.knowhow = this.knowhow.load(pair.partnerId);
        snap.skills = snap.knowhow.filter(replayable).slice(0, SKILLS_SHOWN);
        snap.knowhowWrong = this.knowhow.wrong(pair.partnerId);
        const st = this.state.pair(pair.key);
        if (this.agenda.open(st).length) this.tickAgenda(pair.key, st, snap.env);
        snap.agenda = this.agenda.lines(st, snap.env);
        snap.agendaMissed = this.agenda.missedLines(st);
        const today = this.realism.aftermathToday(st, snap.env);
        if (today.changed) this.state.save();
        snap.aftermath = this.realism.aftermathLines(today.list, snap.env, persona.terms(snap).call);
        snap.bond = this.realism.bondView(st);
        const names = new Map((pair.members || []).map((m) => [String(m.entity_id), fullName(m)]));
        // The household's own goings-on (who took the last dish, a fire at home) are not an
        // outsider's to know; the player can tell them.
        snap.taken = pair.outsider ? [] : this.realism.takenLines(names, pair.partnerId);
        snap.incidents = pair.outsider ? null : this.incidents.view(pair.partnerId, pair.playerId, names, persona.terms(snap).call);
        // The contact's own story line: moved on by time first, then shown; a new one is made in
        // the background when it is due, for a later reply. Family only.
        if (!pair.outsider) {
            this.stories.tick(pair, snap.env);
            snap.storyBlock = this.stories.block(pair, snap);
            snap.storyRule = this.stories.rule(pair);
            this.stories.ensure(pair, snap);
        }
        snap.legacyBlock = this.legacy.block(pair, snap);
        snap.tiesBlock = this.ties.block(pair, { env: snap.env, call: persona.terms(snap).call }, names);
        snap.tiesRule = this.ties.rule(pair);
        // Apart from the player, an outsider's prompt has no house, rooms or things to use.
        if (withScene && (!pair.outsider || snap.outsiderNear)) {
            try {
                snap.self = await this.actions.selfState(pair.partnerId, snap.partner.ageGroup);
                if (snap.self) snap.self.carried = this.carryLines(pair.key);
                if (snap.self) snap.self.plan = this.planView(pair.key, persona.terms(snap).call);
                const me = snap.self;
                if (me) {
                    this.log.info('self [' + pair.key + ']: hand ' + (me.handRead ? (me.held ? me.held.name : 'empty') : 'unread') +
                        ', bag ' + (me.pocketRead ? (me.pocket.length ? me.pocket.join('/') : 'empty') : 'unread') +
                        ', outfit ' + (me.outfit ? JSON.stringify(me.outfit) : 'unread'));
                }
                // The game's own step of what the character is doing, as the model is told it.
                const a = snap.partner && snap.partner.activity;
                const hunger = snap.partner && snap.partner.needs ? snap.partner.needs.Hunger : undefined;
                this.log.info('doing [' + pair.key + ']: ' + (!a || a.idle ? 'nothing' : a.id + ' step ' + (a.action || '?') + ' state ' + (a.state || '?') +
                    ' left ' + (typeof a.remain === 'number' ? a.remain + 's' : '-') + (a.begun !== undefined ? ', eating ' + (a.begun ? 'begun' : 'not begun') : '')) +
                    (typeof hunger === 'number' ? ', Hunger ' + hunger + '%' : ''));
            } catch (e) {
                if (e instanceof GameOfflineError) throw e;
                this.log.warn('self [' + pair.key + ']: ' + (e && e.message || e));
                snap.self = null;
            }
            this.scene.noteClock(snap.env);
            snap.scene = await this.scene.build(pair, snap);
            const sc = snap.scene;
            this.log.info('scene [' + pair.key + ']: ' + sc.foods.length + ' food(s) out' + (sc.site ? ' at ' + sc.site : '') + ', ' +
                sc.stored.length + ' kept meal(s), ' + sc.people.length + ' other member(s), ' + sc.timeline.length + ' recent event(s)');
            try {
                snap.rooms = await this.roomsOf(pair, snap);
            } catch (e) {
                if (e instanceof GameOfflineError) throw e;
                this.log.warn('rooms [' + pair.key + ']: ' + (e && e.message || e));
            }
        }
        return snap;
    }

    // ---------------------------------------------------------------- rooms
    // The rooms of the lot the character is on: a live scan where the player is, the remembered
    // scan elsewhere. null when that lot was never scanned.
    async layoutFor(snap) {
        const scope = await this.actions.useScope(snap);
        if (!scope) return null;
        if (!scope.live) return this.rooms.layout(scope.site.id, scope.memory.objects, scope.memory.scannedAt);
        const rows = await this.actions.scanSite();
        const ref = await this.actions.possessedSite();
        if (!rows || !ref) return null;
        this.rooms.probe(this.game, ref.id, rows).catch((e) => this.log.debug('rooms: build_scan_floors probe failed: ' + (e && e.message || e)));
        return this.rooms.layout(ref.id, rows, this.actions.lastScan ? this.actions.lastScan.at : rows.length);
    }

    // Names as the character would say them: itself is 你, the player is what it calls them.
    roomView(snap) {
        const names = new Map();
        for (const m of snap.others || []) names.set(String(m.id), m.name);
        names.set(String(snap.player.id), snap.player.name);
        names.set(String(snap.partner.id), snap.partner.name);
        return { self: String(snap.partner.id), player: String(snap.player.id), playerWord: persona.terms(snap).call, names };
    }

    // For the action catalog: object id -> "2楼 你的卧室", or null when no rooms are known.
    async roomLabeler(snap) {
        let layout = null;
        try {
            layout = await this.layoutFor(snap);
        } catch (e) {
            if (e instanceof GameOfflineError) throw e;
            this.log.debug('rooms: ' + (e && e.message || e));
        }
        if (!layout || layout.rooms.length < 2) return null;
        const view = this.roomView(snap);
        return (id) => this.rooms.labelOf(layout, id, view);
    }

    // The rooms of this lot and who is in which. Sleep seen right now teaches whose bed it is.
    async roomsOf(pair, snap) {
        const people = [
            { id: String(snap.partner.id), word: '你', activity: snap.partner.activity, row: null },
            { id: String(snap.player.id), word: persona.terms(snap).call, activity: snap.player.activity, row: null }
        ];
        for (const p of (snap.scene && snap.scene.people) || []) people.push({ id: String(p.id), word: p.name, activity: p.activity, row: p });
        for (const p of people) {
            if (p.activity && !p.activity.idle) this.rooms.noteSleep(p.id, p.activity.id, p.activity.target);
        }
        const layout = await this.layoutFor(snap);
        if (!layout || layout.rooms.length < 2) return null;
        const view = this.roomView(snap);
        const possessed = String(await this.world.possessed() || '');
        await Promise.all(people.map(async (p) => {
            const target = p.activity && p.activity.target ? String(p.activity.target) : '';
            let room = target ? layout.roomOf.get(target) || null : null;
            if (!room) {
                const pt = await this.actions.actorPoint(p.id);
                if (pt && pt.source === 'self') {
                    room = this.rooms.locate(layout, { x: pt.at.x * 100, y: pt.at.y * 100, z: typeof pt.at.z === 'number' ? pt.at.z * 100 : undefined });
                }
            }
            if (!room && p.id === possessed) {
                const near = await this.actions.pawnObjects({ object_radius_m: 4 });
                const hit = near.find((o) => layout.roomOf.has(o.id) && layout.roomOf.get(o.id).kind !== 'yard' && (o.meters === null || o.meters <= 2));
                if (hit) room = layout.roomOf.get(hit.id);
            }
            p.room = room ? this.rooms.label(room, layout, view) : '';
            if (p.row && p.room) p.row.room = p.room;
        }));
        const where = people.filter((p) => p.room).map((p) => p.word + '在' + p.room);
        this.log.info('rooms [' + pair.key + ']: ' + layout.rooms.length + ' room(s) from ' + layout.source + (where.length ? ', ' + where.join('，') : ''));
        return { source: layout.source, overview: this.rooms.overview(layout, view), where, storeys: layout.storeys };
    }

    // The model says when the player is teaching it how to do something. The lesson is written down
    // at once (taught), so it outlives a try that cannot start or does not work; the steps queued
    // for it carry it until one of them is seen through (learnFrom).
    // The model says which written-down ways the player has just called wrong ({ skill: "K2" or the
    // job's words, why }). Each is retired (knowhow.retire) and taken out of this turn's skills, so
    // an action naming it falls back to its want. Returns what was retired.
    tagUnlearn(pair, snap, result) {
        const list = Array.isArray(result.unlearn) ? result.unlearn.slice(0, 3) : [];
        const out = [];
        for (const u of list) {
            const ref = u && typeof u === 'object' ? String(u.skill || u.task || '').trim() : String(u || '').trim();
            if (!ref) continue;
            const m = /^K(\d+)$/i.exec(ref);
            const all = snap.knowhow || [];
            const key = taskKey(ref);
            const s = m
                ? (snap.skills || [])[Number(m[1]) - 1]
                : all.find((k) => taskKey(k.task) === key || (k.aliases || []).some((a) => taskKey(a) === key)) ||
                    all.find((k) => key.length >= 2 && (taskKey(k.task).indexOf(key) >= 0 || key.indexOf(taskKey(k.task)) >= 0));
            if (!s || out.indexOf(s) >= 0) {
                this.log.info('knowhow [' + pair.key + '] told "' + ref.slice(0, 40) + '" is wrong, but no such way is written down');
                continue;
            }
            const why = u && typeof u.why === 'string' ? u.why.trim().slice(0, 120) : '';
            try {
                if (!this.knowhow.retire(pair.partnerId, s.id, why, snap.player.name)) continue;
            } catch (e) {
                this.log.warn('knowhow [' + pair.key + '] could not forget "' + s.task + '": ' + e.message);
                continue;
            }
            out.push(s);
            if (snap.skills) snap.skills = snap.skills.map((k) => (k === s ? null : k));
            this.log.info('knowhow [' + pair.key + '] ' + snap.player.name + ' says "' + s.task + '" = ' + (s.interactionId || '(not tried)') +
                ' is wrong' + (why ? ' (' + why + ')' : '') + ', forgotten');
        }
        if (out.length) {
            snap.knowhow = this.knowhow.load(pair.partnerId);
            snap.knowhowWrong = this.knowhow.wrong(pair.partnerId);
        }
        return out;
    }

    tagLesson(pair, snap, result, steps, unlearned) {
        const l = result.learned;
        const task = l && typeof l.task === 'string' ? l.task.trim().slice(0, 40) : '';
        if (!task) return;
        // The job's names under the ways just called wrong, so the old words find the new way.
        const aliases = [];
        (unlearned || []).forEach((s) => { aliases.push(s.task, ...(s.aliases || [])); });
        const how = typeof l.how === 'string' ? l.how.trim().slice(0, 120) : '';
        const lesson = { id: Date.now().toString(36), task: task, how: how, teacher: snap.player.name, source: 'taught', actor: String(pair.partnerId) };
        let n = 0;
        let planned = null;
        for (const s of steps) {
            if ((s.type === 'use_object' || s.type === 'interact') && s.interaction && s.interaction.id) {
                s.lesson = lesson;
                if (!planned) planned = { interactionId: s.interaction.id, interactionName: s.interaction.name, objectName: s.objectName || s.targetName || '' };
                n++;
            }
        }
        let note = '';
        try {
            const r = this.knowhow.teach(pair.partnerId, { lesson: lesson.id, task, how, teacher: snap.player.name, planned, aliases });
            if (r && r.corrects) note = ', correcting a known way';
            else if (aliases.length) note = ', in place of the way called wrong';
        } catch (e) {
            this.log.warn('knowhow [' + pair.key + '] lesson not written down: ' + e.message);
        }
        this.log.info('knowhow [' + pair.key + '] ' + snap.player.name + ' is teaching "' + task + '"' + (how ? ': ' + JSON.stringify(how) : '') + note +
            (n ? ', learned once ' + n + ' step(s) are done' : ', written down to try when it comes up again'));
    }

    // What the character worked out alone for what the player asked, kept once it is done, so the
    // same request is answered from experience the next time.
    tagExperience(pair, steps) {
        for (const s of steps) {
            if (s.type !== 'use_object' || s.lesson || !s.interaction || !s.interaction.id || s.self) continue;
            const task = typeof s.want === 'string' ? s.want.trim().slice(0, 40) : '';
            if (!task) continue;
            // Two jobs in a row ("换上睡衣去睡觉"): this one interaction did only the first, so it is
            // not how to do the whole thing (it once taught "go to sleep" = the wardrobe).
            if (chores.isCompound(task)) {
                this.log.info('knowhow [' + pair.key + '] "' + task + '" is two jobs in a row, not learned as one skill');
                continue;
            }
            s.lesson = { id: '', task, how: '', teacher: '', source: 'self', actor: String(pair.partnerId) };
        }
    }

    // A taught way, a replayed skill or the character's own way was carried out to the end.
    learnFrom(key, actorId, hold) {
        const lesson = hold && hold.lesson;
        if (!lesson || !lesson.task || !hold.bagId) return;
        const as = hold.learnAs || { id: hold.bagId, name: hold.label };
        try {
            const how = this.knowhow.learn(actorId, {
                lesson: lesson.id || '',
                task: lesson.task,
                how: lesson.how,
                teacher: lesson.teacher,
                source: lesson.source === 'self' ? 'self' : 'taught',
                skill: lesson.skill || '',
                objectName: hold.objectName,
                interactionId: as.id,
                interactionName: as.name
            });
            this.log.info('knowhow [' + key + '] ' + actorId + (lesson.skill ? ' practised' : lesson.source === 'self' ? ' found out' : ' learned') +
                ' (' + how + '): "' + lesson.task + '" = ' + as.id + ' ' + as.name +
                (hold.objectName ? ' @' + hold.objectName : '') + (lesson.teacher ? ', taught by ' + lesson.teacher : ''));
        } catch (e) {
            this.log.warn('knowhow [' + key + '] not saved: ' + e.message);
        }
    }

    // The way being tried did not work. Only taught ways and replayed skills count; the
    // character's own first try is just a setback.
    lessonFailed(key, lesson, why) {
        if (!lesson || lesson.source === 'self' || !lesson.actor) return;
        try {
            const s = this.knowhow.fail(lesson.actor, lesson, why);
            if (s) {
                this.log.info('knowhow [' + key + '] "' + s.task + '" did not work (' + String(why || '').slice(0, 80) + '), ' + s.failStreak + ' time(s) in a row' +
                    (this.knowhow.doubtful(s) ? ', will ask before trying it again' : ''));
            }
        } catch (e) {
            this.log.warn('knowhow [' + key + '] failure not saved: ' + e.message);
        }
    }

    // A known skill (K1 ...) is done again without working it out: the nearest thing that offers
    // the same game action is used. null when nothing here offers it.
    async replaySkill(step, pair, snap, catalog) {
        const skill = step.skill;
        const known = this.actions.knownObjects(catalog);
        const near = (a, b) => (typeof a.meters === 'number' ? a.meters : 1e9) - (typeof b.meters === 'number' ? b.meters : 1e9);
        const pool = [];
        const add = (id) => { if (id && known.has(id) && pool.indexOf(id) < 0) pool.push(id); };
        add(step.objectId);
        Array.from(known.values()).filter((o) => skill.objects.indexOf(o.name) >= 0).sort(near).forEach((o) => add(o.id));
        if (pool.length < SKILL_REPLAY_OBJECTS) {
            const caps = await this.wantObjectMap(pair, snap, known);
            caps.filter((o) => Array.isArray(o.actions) && o.actions.some((a) => (typeof a === 'string' ? a : a && a.name) === skill.interactionName))
                .sort(near).forEach((o) => add(o.id));
        }
        const ids = pool.slice(0, SKILL_REPLAY_OBJECTS);
        if (!ids.length) return null;
        let candidates = [];
        try {
            candidates = await this.actions.wantCandidates(pair.partnerId, snap.partner.ageGroup, catalog, ids);
        } catch (e) {
            this.log.warn('skill "' + skill.task + '": could not read object actions: ' + e.message);
            return null;
        }
        for (const id of ids) {
            const o = candidates.find((c) => c.id === id);
            const it = o && o.actions.find((a) => a.id === skill.interactionId);
            if (!it) continue;
            return {
                type: 'use_object', kind: it.kind || actionKind(it.id, it.name), objectId: o.id, objectName: o.name, interaction: it,
                want: step.want || skill.task, goal: step.want || skill.task, replay: true
            };
        }
        return null;
    }

    // A finished task checked against the world. Kept as a skill when the world shows it, or when
    // nothing can show it but the game itself says it finished; a task the world shows undone is
    // told as a setback and counts against the way it was done.
    onVerdict(entry, v) {
        const key = entry.key;
        const hold = entry.hold;
        const st = this.state.pair(key);
        const focus = this.objectFocus.get(key);
        if (focus && focus.task && hold && focus.task.bagId === hold.bagId && String(focus.task.objectId) === String(hold.targetId)) {
            focus.status = v.verdict === 'done' || v.verdict === 'unknown' && entry.confirmed ? 'done' : 'unconfirmed';
        }
        if (hold && hold.chainEnd && v.verdict !== 'failed' && (v.verdict === 'done' || v.verdict === 'unknown')) {
            this.noteProgress(key, { done: hold.want || hold.label || hold.bagId });
        }
        if (v.verdict === 'done' || (v.verdict === 'unknown' && entry.confirmed)) {
            this.noteFinished(st, hold);
            this.learnFrom(key, entry.actorId, hold);
            if (v.verdict === 'done' && hold.mealSeq && hold.meal) {
                this.chronicleMeal(entry.actorId, hold.meal).catch((e) => this.log.warn('chronicle: ' + (e && e.message || e)));
            }
        } else if (v.verdict === 'unknown') {
            this.noteFinished(st, hold);
            if (hold.lesson && hold.lesson.task) {
                this.log.info('knowhow [' + key + '] "' + hold.lesson.task + '" not kept: the game did not say it finished and nothing showed it worked');
            }
        } else {
            this.lessonFailed(key, hold.lesson, '做完以后发现' + v.why);
            // A meal reports its own outcome, and cooking for someone is told by the serving step.
            if (!v.quiet && !(hold.forWhom && hold.kind === 'cook')) this.noteSetbacks(key, [{ what: hold.want || hold.label || hold.bagId, why: '做完「' + (hold.label || hold.bagId) + '」以后发现' + v.why, kind: hold.kind || '' }]);
        }
        this.state.save();
    }

    noteFinished(st, hold) {
        if (!hold) return;
        if (!Array.isArray(st.finished)) st.finished = [];
        st.finished.push({
            at: Date.now(),
            kind: hold.kind || 'other',
            label: hold.label || hold.bagId || ''
        });
        const now = Date.now();
        st.finished = st.finished.filter((x) => x && now - x.at < 30 * 60000).slice(-8);
    }

    keepFollow(st, pair, snap, arranged, hold) {
        const later = arranged.later || [];
        const remain = snap.partner && snap.partner.activity && typeof snap.partner.activity.remain === 'number'
            ? snap.partner.activity.remain * 1000 : 30000;
        const wrapUp = arranged.wait && arranged.waitMs > 0;
        const deadline = Date.now() + (wrapUp ? arranged.waitMs : Math.min(Math.max(remain + 10000, 20000), 180000));
        if (arranged.wait && later.length) {
            // The action being let run: once the game has moved on to something else of its own,
            // that is not waited for as well.
            const waitFor = snap.partner && snap.partner.activity && snap.partner.activity.id ? String(snap.partner.activity.id) : '';
            st.follow = { actorId: String(pair.partnerId), steps: later, wait: true, wrapUp: wrapUp, holding: null, since: Date.now(), deadline: deadline, waitFor };
            if (arranged.untilScheduleEnds) {
                st.follow.untilScheduleEnds = true;
                st.follow.scheduleSince = Date.now();
            }
        } else if (later.length || hold) {
            st.follow = { actorId: String(pair.partnerId), steps: later, wait: false, holding: hold, since: Date.now(), deadline: deadline };
        }
        this.state.save();
    }

    readJournal() {
        if (!this.cfg.journal.enabled || !this.journal) return;
        const was = this.journal.alive();
        this.journal.poll();
        if (this.journal.alive() !== was) {
            this.log.info(this.journal.alive()
                ? 'journal: HouseholdJournal Lua mod is reporting (' + this.journal.members + ' member(s))'
                : 'journal: HouseholdJournal Lua mod went quiet, guessing task ends from the time left');
        }
        this.watchJournal();
    }

    // The Lua mod is sometimes not running in a game session (the game did not mount it at start,
    // or its B2 handlers were dropped when another Lua mod reloaded). Only a game restart loads it
    // safely, so that is what the Freelance page says instead of waiting on a board that never comes.
    watchJournal() {
        const w = this.journalWatch;
        const now = Date.now();
        let state = 'ok';
        let message = '';
        // Looked up on disk only every 30 s; this runs every half second.
        if (now - w.modAt > 30000) {
            w.modAt = now;
            w.modFound = !!paths.findMod(paths.JOURNAL_MOD_ID);
        }
        if (!w.modFound) {
            state = 'missing';
            message = 'The HouseholdJournal mod is not installed. Freelance orders come from it.';
        } else if (!this.householdOk || this.switching) {
            state = 'waiting';
            w.since = now;
        } else {
            const quiet = !this.journal.seenWithin(JOURNAL_QUIET_MS);
            const handlers = this.journal.handlersDown(now);
            if (!quiet && !handlers) {
                state = 'ok';
            } else if (quiet && now - w.since <= JOURNAL_QUIET_MS) {
                state = 'starting';
                message = 'Waiting for the HouseholdJournal mod, which brings the orders…';
            } else {
                state = 'down';
                message = quiet
                    ? 'The HouseholdJournal mod did not start with this game. Check that it is enabled in inZOI\'s mod settings, then restart inZOI.'
                    : 'Part of the HouseholdJournal mod stopped after another Lua mod reloaded. Restart inZOI to load it again.';
            }
        }
        this.tellJournalState(state);
        this.freelance.setSource(state, message);
    }

    // Logged once per change; the reason is for whoever reads the diagnostics.
    tellJournalState(state) {
        const w = this.journalWatch;
        if (w.told === state) return;
        const was = w.told;
        w.told = state;
        if (state === 'down') {
            this.log.warn('journal: HouseholdJournal is not running in this game session' +
                (this.journal.handlersDown() ? ' (its B2 handlers are silent)' : ' (no heartbeat for ' + Math.round(JOURNAL_QUIET_MS / 1000) + ' s)') +
                '; not remounting it while a save is open, the player has to restart inZOI');
        } else if (state === 'ok' && was === 'down') {
            this.log.info('journal: HouseholdJournal is running again');
        }
    }

    // A held task ending is acted on at once instead of at the next 4 s follow pass.
    onJournalEvent(ev) {
        if (ev.kind === 'started') return;
        const pairs = (this.state && this.state.value && this.state.value.pairs) || {};
        for (const key of Object.keys(pairs)) {
            const plan = pairs[key] && pairs[key].follow;
            if (!plan || !plan.holding || String(plan.actorId) !== ev.actor) continue;
            const bags = [plan.holding.bagId].concat(plan.holding.related || []);
            if (bags.indexOf(ev.bag) < 0) continue;
            this.log.info('journal [' + key + '] ' + ev.bag + ' ' + ev.kind + (ev.reason ? ' (' + ev.reason + ')' : ''));
            // A multi-step task starts its next step a moment after one step ends.
            const t = setTimeout(() => {
                if (!this.householdOk || this.switching || this.stopping) return;
                this.followThrough().catch((e) => this.log.warn('follow after journal event: ' + e.message));
            }, JOURNAL_SETTLE_MS);
            if (t.unref) t.unref();
            return;
        }
    }

    // How the game says a held task ended, or null when the Lua journal is not running or saw nothing.
    journalEnd(actorId, hold) {
        if (!this.cfg.journal.enabled || !this.journal || !this.journal.alive()) return null;
        const bags = [hold.bagId].concat(hold.related || []);
        return this.journal.endOf(actorId, bags, hold.startedAt || 0, hold.replaced || []);
    }

    noteHoldSetback(key, hold, why) {
        this.noteSetbacks(key, [{ what: hold.want || hold.label || hold.bagId, why: '在做「' + (hold.label || hold.bagId) + '」时' + why }]);
    }

    // The way itself did not work (it failed, was refused, or never got going). Being called away
    // by the timetable or by something else is not counted against it.
    noteWayFailed(key, hold, why) {
        this.noteHoldSetback(key, hold, why);
        this.lessonFailed(key, hold.lesson, '做「' + (hold.label || hold.bagId) + '」时' + why);
    }

    async actionName(bagId) {
        if (!bagId || bagId === 'another action') return '别的事';
        try {
            const name = await this.world.interactionName(bagId);
            return '「' + (name && name !== bagId ? name + '（' + bagId + '）' : bagId) + '」';
        } catch (e) {
            return '「' + bagId + '」';
        }
    }

    // The game's timetable took the character away from a held task. That is obeyed: the plan
    // ends and the character can tell what happened, but nothing is restarted over it.
    yieldToSchedule(key, st, hold, timetable) {
        this.log.info('follow [' + key + '] ' + (hold ? hold.bagId : 'the plan') + ' gave way to the game timetable (' +
            (timetable.bagId || timetable.what) + '), dropping the plan');
        delete st.follow;
        this.state.save();
        if (hold) this.noteHoldSetback(key, hold, '做到一半到点被叫去' + timetable.what + '了，只能等' + timetable.end + '以后再说');
    }

    // The rest of the plan waits, without a deadline, until the timetable lets the character go.
    waitForSchedule(key, st, plan, what) {
        const now = Date.now();
        if (!plan.untilScheduleEnds || !plan.scheduleSince) {
            plan.wait = true;
            plan.untilScheduleEnds = true;
            plan.scheduleSince = now;
            plan.since = now;
            this.state.save();
            this.log.info('follow [' + key + '] ' + plan.actorId + ' is on the game timetable (' + what + '), ' +
                (plan.steps || []).length + ' step(s) wait until it ends');
            return;
        }
        if (now - plan.scheduleSince > SCHEDULE_WAIT_MAX_MS) {
            this.log.info('follow [' + key + '] ' + what + ' still holds ' + plan.actorId + ' after ' +
                Math.round(SCHEDULE_WAIT_MAX_MS / 3600000) + ' h, dropping the plan');
            delete st.follow;
            this.state.save();
        }
    }

    // A take (and the step riding on it) ended. Where the thing is now decides what is told:
    // still in the bag, back in the bag, still in the hand, or used up / put down.
    // What the game confirmed about the things the character carries, newest last. It is shown
    // to the character as fact, above anything said in the chat.
    noteCarry(key, text) {
        const st = this.state.pair(key);
        const list = Array.isArray(st.carry) ? st.carry : [];
        list.push({ at: Date.now(), text: text });
        st.carry = list.slice(-CARRY_KEEP);
        this.state.save();
        this.log.info('carry [' + key + ']: ' + text);
    }

    carryLines(key) {
        const st = this.state.pair(key);
        const now = Date.now();
        return (Array.isArray(st.carry) ? st.carry : [])
            .filter((c) => c && c.text && now - (c.at || 0) < CARRY_SHOW_MS)
            .map((c) => {
                const min = Math.max(0, Math.round((now - c.at) / 60000));
                return (min < 1 ? '刚刚' : min + '分钟前') + '：' + c.text;
            });
    }

    // The task in hand and what is queued after it, in order. { now, next: [] } or null.
    planView(key, call) {
        const plan = this.state.pair(key).follow;
        if (!plan) return null;
        const now = plan.holding ? (plan.holding.want || plan.holding.label || '') : (plan.wait ? '先把手上正在做的事做完' : '');
        const next = (plan.steps || []).map((s) => stepText(s, call)).filter(Boolean);
        if (!now && !next.length) return null;
        return { now: now, next: next };
    }

    // ---------------------------------------------------------------- progress
    // A step of what the player asked for was done and the next one started (or it was the
    // last). Told in a short text, so the player knows without asking.
    noteProgress(key, item) {
        if (!this.cfg.setbacks.enabled || !item || !item.done) return;
        const st = this.state.pair(key);
        const list = (Array.isArray(st.progress) ? st.progress : []).filter((p) => p && Date.now() - p.at < PROGRESS_KEEP_MS);
        list.push({ at: Date.now(), game: this.gameNow(), done: String(item.done).slice(0, 80), next: String(item.next || '').slice(0, 80), how: String(item.how || '').slice(0, 120) });
        st.progress = list.slice(-4);
        this.state.save();
        this.log.info('progress [' + key + '] done "' + item.done + '"' + (item.next ? ', next "' + item.next + '"' : ', nothing after it'));
        this.scheduleProgress(key, PROGRESS_SETTLE_MS);
    }

    scheduleProgress(key, ms) {
        if (this.progressTimers.has(key)) return;
        const t = setTimeout(() => {
            this.progressTimers.delete(key);
            this.flushProgress(key).catch((e) => this.log.warn('progress [' + key + '] failed: ' + (e && e.message || e)));
        }, Math.max(500, ms));
        if (t.unref) t.unref();
        this.progressTimers.set(key, t);
    }

    async flushProgress(key) {
        if (this.stopping || this.switching) return;
        if (!this.householdOk) return this.scheduleProgress(key, 5000);
        const st = this.state.pair(key);
        const items = (st.progress || []).filter((p) => p && Date.now() - p.at < PROGRESS_KEEP_MS);
        if (!items.length || this.cfg.mode !== 'auto' || !this.llm.configured) return;
        // A setback waiting to be told carries the progress with it.
        if (this.liveSetbacks(key).length) return this.scheduleProgress(key, 6000);
        const thread = this.mailbox.thread(key);
        if (!thread) return this.scheduleProgress(key, 5000);
        // The reply to the player's own text says where things stand.
        if (thread.pending.length) return;
        const job = this.job(key);
        if (job.busy || this.proactiveBusy || this.clearRequestAt()) return this.scheduleProgress(key, 3000);
        const wait = PROGRESS_GAP_MS - (Date.now() - (st.progressSentAt || 0));
        if (wait > 0) return this.scheduleProgress(key, wait);
        const k = parseKey(key);
        const possessed = String(await this.world.possessed());
        if (possessed === k.contactId) {
            st.progress = [];
            this.state.save();
            return;
        }
        if (possessed !== k.playerId) return this.scheduleProgress(key, 15000);
        job.busy = true;
        this.proactiveBusy = true;
        try {
            const pair = await this.world.pair(k.playerId, k.contactId);
            st.progress = [];
            st.progressSentAt = Date.now();
            this.state.save();
            await this.sendProgress(pair, items, thread.answeredAt);
        } catch (e) {
            this.log.warn('progress [' + key + '] not sent: ' + (e && e.message || e));
            this.setStatus(key, { state: 'online', error: '' });
        } finally {
            job.busy = false;
            this.proactiveBusy = false;
        }
    }

    async sendProgress(pair, items, answeredAt) {
        this.log.info('progress [' + pair.key + ' ' + pair.role + '] telling: ' + items.map((p) => '"' + p.done + '"' + (p.next ? ' -> "' + p.next + '"' : '')).join(', '));
        const snap = await this.snapshot(pair, true);
        snap.finished = (this.state.pair(pair.key).finished || []).slice(-8);
        snap.promises = this.recentPromises(pair.key);
        // Whether the reply may give the character a new like or dislike today.
        snap.preferOpen = !pair.outsider && this.preferences.open(pair.partnerId, snap.env);
        snap.proximity = await this.world.proximity(pair, this.cfg.proactive.nearby_meters);
        const catalog = await this.actions.catalog(pair, snap, this.actionsCfg(pair, snap));
        const thread = this.mailbox.thread(pair.key);
        if (!thread || thread.pending.length) return;
        const memory = this.memoryFor(pair, snap, items.map((p) => p.done + ' ' + p.next).concat(this.recentTexts(thread, 2)), thread);
        const prompt = persona.progressPrompt({
            snap,
            cfg: this.cfg,
            memory,
            diary: this.todayDiary(pair.partnerId, snap.env),
            catalog,
            history: this.historyFor(thread, memory),
            progress: items,
            now: Date.now()
        });
        this.log.debug('progress prompt:\n' + prompt.system + '\n' + prompt.user);
        this.setStatus(pair.key, { state: 'typing', partnerName: snap.partner.name, role: pair.role });
        const started = Date.now();
        const result = await this.llm.json(prompt.system, prompt.user, { purpose: 'progress', max_tokens: 600 });
        // A report never changes what is being done: the queued steps go on as they are.
        if (result && typeof result === 'object') {
            result.actions = [];
            result.promises = [];
            result.report = true;
        }
        await this.deliver(pair, snap, catalog, result, answeredAt, 'proactive', Date.now() - started);
        this.setStatus(pair.key, { state: 'online', error: '' });
    }

    async settleCarry(key, st, plan, hold) {
        const actor = plan.actorId;
        const item = hold.objectName || '东西';
        const after = hold.after || null;
        const tries = (after && after.tries) || [];
        const itemId = String(hold.pocketItem || hold.itemId || (tries.length ? tries[tries.length - 1].targetId : '') || '');
        const inBag = hold.pocketItem ? await this.actions.inPocket(actor, hold.pocketItem) : false;
        if (inBag === null) return;
        this.actions.forgetPocket(actor);
        const hand = await this.actions.heldObject(actor, hold.ageGroup || '');
        if (!hand.read) return;
        const mine = !!(hand.item && (!itemId || String(hand.item.id) === itemId));
        const where = after ? placeText(after) : '';
        const refused = (hold.refused || []).slice();
        plan.holding = null;
        const done = () => {
            if (!plan.steps.length) delete st.follow;
            this.state.save();
        };
        const drop = (why) => {
            delete st.follow;
            this.state.save();
            this.noteHoldSetback(key, hold, why);
        };
        const tookOut = () => {
            if (!hold.pocketItem || hold.afterRunning) return true;
            const took = this.journalEnd(actor, { bagId: 'AutoFind_PutDown_Inventory', related: [], startedAt: hold.startedAt || 0, replaced: [] });
            return !!(took && took.kind === 'finished');
        };
        if (inBag) {
            const wasOut = tookOut();
            this.log.info('follow [' + key + '] ' + item + ' is ' + (wasOut ? 'back in the bag after being taken out' : 'still in the bag') + ', dropping the plan');
            const text = wasOut
                ? item + '从背包里拿出来过，还没来得及' + (where || '放下') + '，游戏就又把它收回了背包。现在' + item + '在背包里，手上' + (hand.item ? '拿着' + hand.item.name : '空着') + '。'
                : item + '没能从背包里拿出来，现在还在背包里。';
            this.noteCarry(key, text);
            drop(wasOut ? '把' + item + '从包里拿出来以后，还没来得及' + (where || '放下') + '，游戏又把它收回了包里' : '没能把' + item + '从包里拿出来');
            return;
        }
        if (!mine) {
            const ranAfter = hold.afterRunning || (tries[0] && tries[0].bagId !== '@live' &&
                this.journalEnd(actor, { bagId: tries[0].bagId, related: [], startedAt: hold.startedAt || 0, replaced: [] }));
            const lead = refused.length ? refused.join('，') + '，' : '';
            let text;
            if (!after) {
                text = item + (hold.pocketItem ? '从背包里拿出来了' : '拿起来了') + '，现在不在手上，也不在背包里。';
            } else if (ranAfter && after.relation === 'use') {
                const fellBack = typeof hold.afterTry === 'number' && tries[hold.afterTry] && tries[hold.afterTry].bagId === 'AutoFind_PutDown';
                text = fellBack ? lead + '「' + where + '」没做成，' + item + '就近放下了。' : '已经拿' + item + '做了「' + where + '」。';
            } else if (ranAfter) {
                const fellBack = typeof hold.afterTry === 'number' && tries[hold.afterTry] && tries[hold.afterTry].bagId === 'AutoFind_PutDown' && after.targetId;
                text = lead + (fellBack ? item + '就近放下了，没放到想放的地方。' : '已经把' + item + where + '了。');
            } else {
                text = item + (hold.pocketItem ? '从背包里拿出来了' : '拿起来了') + '，现在不在手上，也不在背包里（' + (where || '放下') + '这一步游戏没确认做过）。';
            }
            if (hand.item) text += '你手上现在拿着的是' + hand.item.name + '。';
            this.log.info('follow [' + key + '] ' + item + ' is out of the bag and out of the hand' + (after ? ' ("' + where + '" ' + (ranAfter ? 'done' : 'unconfirmed') + ')' : ''));
            this.noteCarry(key, text);
            if (plan.report) {
                if (plan.steps.length) plan.justDone = { done: text };
                else this.noteProgress(key, { done: text });
            }
            if (after && ranAfter && (after.targetId || after.relation === 'use')) {
                this.verifier.add({ key, actorId: String(actor), ageGroup: hold.ageGroup || '', hold: Object.assign({}, hold, { label: where }), confirmed: true });
            }
            done();
            return;
        }
        this.log.info('follow [' + key + '] ' + item + ' is in the hand (' + hand.item.id + ' ' + hand.item.name + ')' + (after ? ', "' + where + '" not done yet' : ''));
        if (!after) {
            const text = item + (hold.pocketItem ? '从背包里拿出来了' : '拿起来了') + '，现在拿在手上。';
            this.noteCarry(key, text);
            if (plan.report) {
                if (plan.steps.length) plan.justDone = { done: text };
                else this.noteProgress(key, { done: text });
            }
            done();
            return;
        }
        if (plan !== st.follow) {
            this.noteCarry(key, item + (hold.pocketItem ? '从背包里拿出来了' : '拿起来了') + '，现在拿在手上，' + (where || '放下') + '还没做。');
            return;
        }
        const tried = typeof hold.afterTry === 'number' ? hold.afterTry : 0;
        let next = hold.afterRunning ? tried + 1 : tried;
        if (!hold.afterRunning) {
            const queued = after.tries[tried];
            const ran = queued ? this.journalEnd(actor, { bagId: queued.bagId, related: [], startedAt: hold.startedAt || 0, replaced: [] }) : null;
            if (ran) next = tried + 1;
        }
        const r = await this.actions.runAfterNow(actor, after, next, item, hand.item.id);
        if (st.follow !== plan) {
            this.log.info('follow [' + key + '] a newer plan took over while handling ' + item);
            return;
        }
        if (!r.ok) {
            this.actions.forgetPocket(actor);
            const still = await this.actions.heldObject(actor, hold.ageGroup || '');
            const holding = still.read && still.item && String(still.item.id) === String(hand.item.id);
            const why = (r.refused.concat(refused)).join('，') || '游戏没接';
            this.log.info('follow [' + key + '] no way to "' + where + '" was taken by the game (' + why + '), dropping the plan');
            this.noteCarry(key, item + (hold.pocketItem ? '已经从背包里拿出来了' : '已经拿起来了') + '，可' + where + '没做成（' + why + '）。' +
                (holding ? '现在' + item + '还拿在手上。' : '现在' + item + '不在手上了。'));
            drop(holding ? '拿在手上了，可' + where + '没做成（' + why + '），现在还在手上' : '拿出来了，可' + where + '没做成（' + why + '）');
            return;
        }
        plan.holding = Object.assign(r.hold, {
            kind: actionKind(r.bagId, ''), label: where || '放下' + item, want: hold.want, objectName: item, ageGroup: hold.ageGroup || '',
            after: after, afterTry: r.index, afterRunning: true, noRetake: true, lesson: hold.lesson,
            pocketItem: hold.pocketItem, itemId: itemId, refused: refused.concat(r.refused || []),
            related: placeBags(after)
        });
        this.state.save();
    }

    async retakeHold(key, st, plan, hold, why) {
        const timetable = await this.actions.scheduleHold(plan.actorId);
        if (timetable) {
            this.yieldToSchedule(key, st, hold, timetable);
            return;
        }
        if (hold.noRetake) {
            this.log.info('follow [' + key + '] ' + why + '; ' + hold.bagId + ' cannot be restarted from here, dropping the plan');
            delete st.follow;
            this.state.save();
            this.noteHoldSetback(key, hold, '做到一半被打断了，没法接着做');
            return;
        }
        this.log.info('follow [' + key + '] ' + why + ', taking ' + hold.bagId + ' back');
        let again = null;
        try {
            again = await this.actions.commitInteraction(plan.actorId, hold.bagId, hold.targetId);
        } catch (e) {
            if (!(e instanceof ScheduleBusyError)) throw e;
            again = { ok: false, hold: null, scheduled: e.held };
        }
        if (again.scheduled) {
            this.yieldToSchedule(key, st, hold, again.scheduled);
            return;
        }
        if (!again.ok) {
            this.log.warn('follow [' + key + '] ' + hold.bagId + ' could not be taken back, dropping the plan');
            delete st.follow;
            this.state.save();
            this.noteWayFailed(key, hold, '被打断以后想接着做，却没能重新开始');
            return;
        }
        plan.holding = Object.assign(again.hold, {
            kind: hold.kind, label: hold.label, want: hold.want, retaken: true,
            related: hold.related || [], unrelated: hold.unrelated || [],
            objectName: hold.objectName || '', lesson: hold.lesson
        });
        this.state.save();
    }

    async followThrough() {
        if (this.followBusy || this.stopping) return;
        const pairs = (this.state && this.state.value && this.state.value.pairs) || {};
        let any = false;
        for (const key of Object.keys(pairs)) if (pairs[key] && pairs[key].follow) any = true;
        if (!any) return;
        this.followBusy = true;
        try {
            let possessed = null;
            try { possessed = await this.world.possessed(); } catch (e) { return; }
            for (const key of Object.keys(pairs)) {
                const st = pairs[key];
                if (!st || !st.follow || this.job(key).busy) continue;
                try {
                    await this.advanceFollow(key, st, possessed);
                } catch (e) {
                    this.log.warn('follow [' + key + '] ' + (e && e.message || e));
                }
            }
        } finally {
            this.followBusy = false;
        }
    }

    // Cooked for someone: the dish that showed up after the cooking is served to them as the
    // next step. 'wait' while the mod has not reported it yet.
    async serveCooked(key, plan) {
        const sc = plan.serveCooked;
        const who = sc.forWhom;
        const before = new Set((sc.before || []).map(String));
        const carried = new Set(this.meals.carriedDishes().map((c) => String(c.dish)));
        const fresh = this.reportedFoodIds().map(String).filter((id) => {
            if (before.has(id) || carried.has(id)) return false;
            const f = this.journal.foodState(id);
            return !!(f && f.edible && !f.spoiled && !f.empty);
        });
        const what = '做好饭端给' + who.name;
        if (!fresh.length) {
            if (Date.now() < sc.until) return 'wait';
            delete plan.serveCooked;
            this.log.info('follow [' + key + '] no new dish showed up after cooking for ' + who.name);
            this.noteSetbacks(key, [{ what, why: '饭做完了，可没找到刚做好的那盘，没能端到' + who.name + '面前' }]);
            return 'gone';
        }
        delete plan.serveCooked;
        const dish = fresh[fresh.length - 1];
        const name = (await this.world.objectDisplayName(dish).catch(() => '')) || '刚做好的菜';
        if (!this.meals.canServePerson()) {
            this.log.info('follow [' + key + '] cooked ' + name + ' (' + dish + ') for ' + who.name + ', but the HouseholdJournal mod running cannot serve it');
            this.noteSetbacks(key, [{ what, why: name + '做好了放在那儿，可游戏里的模组还是旧版本，端不到' + who.name + '面前，得叫' + who.name + '自己过来吃' }]);
            return 'gone';
        }
        const m = MEAL_MODES.hand;
        plan.steps = plan.steps || [];
        plan.steps.unshift({
            type: 'use_object', kind: 'meal', objectId: dish, objectName: name,
            interaction: {
                id: MEAL_PREFIX + dish + m.suffix, name: m.label(name, who.name), hint: '', kind: 'meal',
                meal: { dish, container: '0', name, mode: 'hand', person: String(who.id), personName: who.name, cooked: true }
            },
            want: m.purpose(name, who.name)
        });
        this.log.info('follow [' + key + '] cooked ' + name + ' (' + dish + '), serving it to ' + who.name + ' next');
        return 'go';
    }

    async advanceFollow(key, st, possessed) {
        const plan = st.follow;
        if (!plan) return;
        // The player now controls this character: its plan waits, and goes stale if the wait is long.
        if (String(plan.actorId) === String(possessed)) {
            if (plan.focusId) {
                this.objectFocus.delete(key);
                delete st.follow;
                this.state.save();
                this.log.info('focus [' + key + '] queued target dropped: player took control');
                return;
            }
            if (!plan.pausedAt) {
                plan.pausedAt = Date.now();
                this.state.save();
                this.log.info('follow [' + key + '] paused: ' + plan.actorId + ' is being played now, ' + (plan.steps || []).length + ' step(s) wait');
            } else if (Date.now() - plan.pausedAt > FOLLOW_PAUSE_MAX_MS) {
                this.log.info('follow [' + key + '] dropped: ' + plan.actorId + ' was played for over ' + Math.round(FOLLOW_PAUSE_MAX_MS / 60000) + ' min');
                delete st.follow;
                this.state.save();
            }
            return;
        }
        if (plan.pausedAt) {
            this.log.info('follow [' + key + '] resumed after ' + Math.round((Date.now() - plan.pausedAt) / 1000) + 's of being played');
            delete plan.pausedAt;
            plan.deadline = Date.now() + 20000;
            this.state.save();
        }
        const cur = await this.actions.currentOf(plan.actorId);
        // An emergency (incidents.js) takes the character: the game's own steps run, nothing is
        // restarted over them, and the incident itself is what the character tells.
        const urgent = this.incidents.holdFor(plan.actorId, cur);
        if (urgent) {
            this.log.info('follow [' + key + '] ' + plan.actorId + ' is ' + urgent.what + ' (' + urgent.bagId + '), dropping the plan');
            delete st.follow;
            this.state.save();
            return;
        }
        if (plan.holding) {
            if (!cur) return;
            const hold = plan.holding;
            if (await this.actions.stillOnTask(plan.actorId, hold, cur)) {
                if (typeof cur.remain_time === 'number') {
                    hold.remain = cur.remain_time;
                    hold.seenAt = Date.now();
                }
                const body = await this.actions.unstickWalk(plan.actorId, hold, cur);
                if (body === 'released' && hold.unstuck >= 2) {
                    if (!hold.retaken) {
                        await this.retakeHold(key, st, plan, hold, hold.bagId + ' stayed stuck at ' + (cur.action_type || 'walking'));
                        return;
                    }
                    this.log.warn('follow [' + key + '] ' + hold.bagId + ' is still stuck at ' + (cur.action_type || 'walking') + ' after being restarted, dropping the plan');
                    delete st.follow;
                    this.state.save();
                    this.noteWayFailed(key, hold, '想过去却一直没走动，被手头原来的事绊住了');
                    return;
                }
                if (body !== 'free') this.state.save();
                return;
            }
            // Taking out and putting down are judged by the bag and the hand, never started twice.
            if (hold.pocketItem || hold.after) {
                await this.settleCarry(key, st, plan, hold);
                return;
            }
            const took = cur.playing ? (cur.interaction_bag_id || 'another action') : 'nothing';
            if (cur.playing && isScheduledBag(took)) {
                this.yieldToSchedule(key, st, hold, Object.assign({ bagId: took }, scheduleKind(took)));
                return;
            }
            const ended = this.journalEnd(plan.actorId, hold);
            if (ended && ended.kind === 'canceled' && isScheduleCancel(ended.reason)) {
                this.yieldToSchedule(key, st, hold, { bagId: ended.bag + ' (' + ended.reason + ')', what: '按日程出门', end: '回来' });
                return;
            }
            if (ended && ended.kind !== 'finished') {
                const cause = ended.bag + ' ' + ended.kind + (ended.reason ? ' (' + ended.reason + ')' : '');
                if (ended.kind === 'canceled' && !hold.retaken && !OBEY_CANCEL_RE.test(ended.reason)) {
                    await this.retakeHold(key, st, plan, hold, 'the game says ' + cause + ', now ' + took);
                    return;
                }
                this.log.info('follow [' + key + '] the game says ' + cause + (hold.retaken ? ' again' : '') + ', dropping the plan');
                delete st.follow;
                this.state.save();
                if (!PLAYER_CANCEL_RE.test(ended.reason || '')) {
                    const how = ended.kind === 'failed' ? '没做成，卡住了' : '做到一半停下了';
                    this.noteWayFailed(key, hold, how + (ended.reason ? '（原因：' + ended.reason + '）' : '') +
                        (cur.playing && took !== 'nothing' ? '，现在在做' + await this.actionName(took) : ''));
                }
                return;
            }
            if (ended) {
                this.log.info('follow [' + key + '] the game says ' + ended.bag + ' finished, now ' + took);
            } else if (cur.playing) {
                const left = typeof hold.remain === 'number' && hold.seenAt
                    ? hold.remain - (Date.now() - hold.seenAt) / 1000 : null;
                if (left === null || (left > UNFINISHED_LEFT_S && hold.retaken)) {
                    this.log.info('follow [' + key + '] ' + took + ' replaced ' + hold.bagId +
                        (left === null ? ' (time left unknown)' : ' again') + ', dropping the plan');
                    delete st.follow;
                    this.state.save();
                    // Unknown time left may just mean it ran its course; only a known cut-off is told.
                    if (left !== null) this.noteHoldSetback(key, hold, '做到一半又被打断了，转去做了' + await this.actionName(took));
                    return;
                }
                if (left > UNFINISHED_LEFT_S) {
                    await this.retakeHold(key, st, plan, hold, took + ' cut it off with about ' + Math.round(left) + 's left');
                    return;
                }
                this.log.info('follow [' + key + '] ' + hold.bagId + ' had run its course, ' + took + ' came after it');
            }
            if (plan.report) {
                if (plan.steps && plan.steps.length) plan.justDone = { done: hold.want || hold.label || hold.bagId };
                else hold.chainEnd = true;
            }
            // Told as done and kept as a skill only once the world shows it (see verify.js).
            this.verifier.add({ key, actorId: String(plan.actorId), ageGroup: hold.ageGroup || '', hold, confirmed: !!(ended && ended.kind === 'finished') });
            plan.holding = null;
            if (hold.forWhom && hold.kind === 'cook') {
                plan.serveCooked = { forWhom: hold.forWhom, before: hold.foodBefore || [], until: Date.now() + COOKED_DISH_WAIT_MS };
                this.log.info('follow [' + key + '] cooked for ' + hold.forWhom.name + ', waiting for the new dish to be reported');
            }
        } else if (plan.wait) {
            if (this.meals.carrying(plan.actorId, cur && cur.playing ? cur.interaction_bag_id : '')) return;
            if (cur && cur.playing && isScheduledBag(cur.interaction_bag_id)) {
                this.waitForSchedule(key, st, plan, cur.interaction_bag_id);
                return;
            }
            const waited = Math.round((Date.now() - (plan.since || Date.now())) / 1000);
            if (plan.untilScheduleEnds) {
                // School or work is over: whatever the game does next (the ride home, settling in)
                // is not something the texts were waiting for.
                plan.untilScheduleEnds = false;
                delete plan.scheduleSince;
                this.log.info('follow [' + key + '] the game timetable let ' + plan.actorId + ' go after ' + waited + 's, starting the next one');
            } else if (cur && cur.playing && plan.waitFor && cur.interaction_bag_id && String(cur.interaction_bag_id) !== plan.waitFor &&
                !await this.sameTask({ bagId: plan.waitFor, want: '' }, cur).catch(() => true)) {
                // What was let run is over and the game slipped in something of its own: the next
                // step takes over now instead of waiting that out too.
                this.log.info('follow [' + key + '] ' + plan.waitFor + ' ended after ' + waited + 's and the game started ' + cur.interaction_bag_id + ' on its own, starting the next one now');
            } else if (cur && cur.playing) {
                if (Date.now() < plan.deadline) return;
                // Cleaning is let finish: cut off, the thing stays dirty and the game sends the
                // character straight back to it, over and over (a half-scrubbed bathtub).
                if (CLEANING_RE.test(cur.interaction_bag_id || '') && waited * 1000 < CLEANING_FINISH_MS) {
                    if (!plan.cleaningNoted) {
                        plan.cleaningNoted = true;
                        this.log.info('follow [' + key + '] ' + cur.interaction_bag_id + ' is cleaning, letting it finish (up to ' + Math.round(CLEANING_FINISH_MS / 1000) + 's) before the next one');
                    }
                    return;
                }
                this.log.info('follow [' + key + '] ' + (cur.interaction_bag_id || 'the current action') + ' is still going after ' + waited + 's (' +
                    (plan.wrapUp ? 'the time the model gave it' : 'longest wait for it to end') + '), putting it down for the next one');
            } else {
                this.log.info('follow [' + key + '] the current action ended after ' + waited + 's, starting the next one');
            }
            plan.wait = false;
        }
        if (plan.serveCooked && await this.serveCooked(key, plan) === 'wait') {
            this.state.save();
            return;
        }
        if (!plan.steps || !plan.steps.length) {
            delete st.follow;
            this.state.save();
            return;
        }
        if (cur && cur.playing && isScheduledBag(cur.interaction_bag_id)) {
            this.waitForSchedule(key, st, plan, cur.interaction_bag_id);
            return;
        }
        if (plan.retryAt && Date.now() < plan.retryAt) return;
        const parsed = parseKey(key);
        const pair = await this.world.pair(parsed.playerId, parsed.contactId);
        if (String(pair.partnerId) !== String(plan.actorId)) {
            delete st.follow;
            this.state.save();
            return;
        }
        const snap = await this.snapshot(pair);
        const step = plan.steps.shift();
        step.insertFront = true;
        let r = null;
        try {
            r = await this.actions.runStep(step, pair, snap, this.actionsCfg(pair, snap));
        } catch (e) {
            if (e instanceof ScheduleBusyError) {
                plan.steps.unshift(step);
                this.waitForSchedule(key, st, plan, e.held.bagId || e.held.what);
                return;
            }
            if (e instanceof TakenError) {
                plan.takenTries = (plan.takenTries || 0) + 1;
                if (plan.takenTries < TAKEN_FOLLOW_TRIES) {
                    plan.steps.unshift(step);
                    plan.retryAt = Date.now() + TAKEN_FOLLOW_WAIT_MS;
                    this.log.info('follow [' + key + '] ' + e.message + ', trying again in ' + Math.round(TAKEN_FOLLOW_WAIT_MS / 1000) + 's (' + plan.takenTries + '/' + TAKEN_FOLLOW_TRIES + ')');
                    this.state.save();
                    return;
                }
                this.log.info('follow [' + key + '] ' + e.message + ', still taken after ' + plan.takenTries + ' tries');
                if (!plan.steps.length) delete st.follow;
                else delete plan.retryAt;
                plan.takenTries = 0;
                const misses = [];
                this.waitForTaken(pair, snap, st, step, e.taken, misses);
                this.noteSetbacks(key, misses);
                return;
            }
            this.log.warn('follow [' + key + '] ' + step.type + ' failed: ' + e.message);
            this.lessonFailed(key, step.lesson, '轮到它的时候没能开始：' + String(e.message || '').slice(0, 80));
            if (!plan.steps.length) delete st.follow;
            this.state.save();
            this.noteSetbacks(key, [{
                what: step.want || (step.interaction && step.interaction.name) || '接下来要做的事',
                why: '轮到它的时候没能开始（' + String(e.message || '').slice(0, 80) + '）'
            }]);
            return;
        }
        if (r && r.hold) {
            r.hold.kind = step.kind || '';
            r.hold.label = (step.interaction && step.interaction.name) || r.hold.bagId;
            r.hold.want = step.want || '';
            r.hold.objectName = step.objectName || step.targetName || '';
            if (step.lesson) r.hold.lesson = step.lesson;
            if (step.chore) r.hold.chore = step.chore;
            r.hold.ageGroup = (snap.partner && snap.partner.ageGroup) || '';
            if (step.forWhom) {
                r.hold.forWhom = step.forWhom;
                r.hold.foodBefore = r.hold.check && r.hold.check.foods ? r.hold.check.foods : this.reportedFoodIds();
            }
            plan.holding = r.hold;
        }
        this.log.info('follow [' + key + '] ' + step.type + (step.interaction ? ' ' + step.interaction.id : '') + ' -> ' + (r && r.note));
        if (plan.justDone) {
            this.noteProgress(key, { done: plan.justDone.done, next: stepText(step, persona.terms(snap).call) || (r && r.note) || '' });
            delete plan.justDone;
        } else if (plan.report && !(r && (r.hold || r.skipped)) && !plan.steps.length) {
            this.noteProgress(key, { done: stepText(step, persona.terms(snap).call) || (r && r.note) || '' });
        }
        if (!plan.steps.length && !(r && r.hold)) delete st.follow;
        this.state.save();
    }

    async proactive(pair, reason, answeredAt, nearbyOk, urgent) {
        this.log.info('proactive [' + pair.key + ' ' + pair.role + ']: ' + reason);
        const snap = await this.snapshot(pair, true);
        snap.finished = (this.state.pair(pair.key).finished || []).slice(-8);
        snap.promises = this.recentPromises(pair.key);
        // Whether the reply may give the character a new like or dislike today.
        snap.preferOpen = !pair.outsider && this.preferences.open(pair.partnerId, snap.env);
        snap.proximity = await this.world.proximity(pair, this.cfg.proactive.nearby_meters);
        const catalog = await this.actions.catalog(pair, snap, this.actionsCfg(pair, snap));
        const thread = this.mailbox.thread(pair.key);
        if (!thread || thread.pending.length) return null;
        const memory = this.memoryFor(pair, snap, [reason].concat(this.recentTexts(thread, 3)), thread);
        const prompt = persona.proactivePrompt({
            snap,
            cfg: this.cfg,
            memory,
            diary: this.todayDiary(pair.partnerId, snap.env),
            catalog,
            history: this.historyFor(thread, memory),
            reason,
            urgent: !!urgent,
            now: Date.now()
        });
        this.setStatus(pair.key, { state: 'typing', partnerName: snap.partner.name, role: pair.role });
        const started = Date.now();
        const result = await this.llm.json(prompt.system, prompt.user, { purpose: 'proactive', max_tokens: 900, thinking: inCrisis(snap) ? 'disabled' : undefined });
        if (this.cfg.proactive.skip_when_nearby && !nearbyOk && !urgent) {
            this.world.invalidate('scan');
            const again = await this.world.proximity(pair, this.cfg.proactive.nearby_meters);
            if (again.near) {
                this.state.pair(pair.key).lastNearAt = Date.now();
                this.state.save();
                this.log.info('proactive [' + pair.key + '] dropped: met in person while writing (' + proximityText(again) + ')');
                this.setStatus(pair.key, { state: 'online', error: '' });
                return { sent: [] };
            }
        }
        const r = await this.deliver(pair, snap, catalog, result, answeredAt, 'proactive', Date.now() - started);
        this.setStatus(pair.key, { state: 'online', error: '' });
        return r;
    }
}

module.exports = { Daemon, AlreadyRunningError, VERSION, PID_FILE, STOP_FILE, SITE_MEMORY_FILE, HEALTH_FILE, QUIRKS_FILE, USAGE_FILE, RESTART_EXIT_CODE, wornPhrases, tidiedFacts, variedFacts };
