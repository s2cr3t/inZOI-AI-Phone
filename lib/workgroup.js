'use strict';
// The company's own work group, and the tasks its boss hands out in it.
//
// The group: one per company the played character works for, made and kept by this service,
// never the phone. Its members are the company's payroll as the game lists it (memberInfo), the
// owner is whoever holds the highest rank, and nobody leaves it while employed: joining the
// company puts the character in, leaving the company takes them out (sync, every minute).
//   <phone>/groups/g-co<company>/meta.cfg  this service: { v, id, name, owner, members, auto,
//                                          company: true, companyId } — the phone shows it locked
//   <phone>/groups/company.cfg             this service: { v, groups: [{ id, name, owner, members }] },
//                                          which the phone merges into its own list
// Messages go the usual group way (groups.js): the phone writes the player's outbox, this service
// the inbox.
//
// The tasks: once a game day the player's direct boss asks the group who will take one of the
// player's own after-work missions (the rank's afterWorkQuestIdList in the Career table, its
// missions in the Quest table); on a day off it is optional. Nothing is the player's until they
// say so in the group ("我来"): only then is it theirs, and in the game: the HouseholdJournal Lua mod
// adds it (Zoi.CareerServer, op q) under the company's work quest (<Company>_Quest_Working, shown
// as 「工作」 and apart from the game's own after-work 「加班」 one, which the game allows only one
// running mission of), and the game's own quest record tells whether it went in. The game picks
// the quest's mission itself, whatever was asked for: the one it picked is the task. It is never a
// mission the character already has running, or has done or failed today. Nobody takes it within OFFER_MINUTES: on a work day the boss
// hands it to a colleague (no game effect), on a day off it lapses. A task the player took is
// followed in the game's quest record (FB2QuestComponent): the boss acknowledges it done, or
// remarks when a work day ends without it, and the boss's impression of the player moves
// (workplace.js); an optional one left undone costs nothing.
//   data/worktasks.json   this service: { v, tasks: [...], groups: { <company>: members } }
//   <phone>/oa/tasks.cfg  this service: { v, list: [{ id, member, text, bossName, day, state, at, optional, taker }] }
//     state: offered | given | done | missed | handed | lapsed | declined | not_given
const path = require('path');
const fsx = require('./fsx');
const { gameStamp } = require('./mailbox');
const { STYLES } = require('./workplace');
const hanzi = require('./hanzi');

const V = 1;
const TASKS_KEEP = 30;
const TASKS_SHOWN = 10;
// A task is handed out from this hour of the game day, while there is still time to do it.
const FROM_HOUR = 7;
const UNTIL_HOUR = 20;
const DONE_DELTA = 5;
const MISSED_DELTA = -4;
// Done on a day off, without having to.
const OPTIONAL_DONE_DELTA = 4;
const NAME_TTL_MS = 30 * 60000;
// Game minutes an offer stays open for someone to take it.
const OFFER_MINUTES = 180;
// The player taking an offer, or turning it down, in their own words in the group.
const TAKE_RE = /我来|我做|我可以|交给我|我接|我去做|没问题|包在我身上|让我来|我试试|我负责|行，我|好，我|好的，我/;
const NOT_RE = /不来|不做|不行|做不了|没空|没时间|算了|下次|不方便|不接/;

function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Reflected maps start their keys in lower case: SoundCompany_Quest -> soundCompany_Quest.
function reflectedKey(id) {
    const s = String(id || '');
    return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function minuteOf(env) {
    return (Number(env.day) || 0) * 1440 + (Number(env.hour) || 0) * 60 + (Number(env.minute) || 0);
}

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

class WorkGroup {
    constructor(daemon) {
        this.d = daemon;
        this.log = daemon.log;
        this.groupsDir = '';
        this.tasksFile = '';
        this.stateFile = '';
        this.state = { v: V, tasks: [], groups: {} };
        this.names = new Map();
        this.giving = false;
    }

    configure(phoneDir, dataDir) {
        this.groupsDir = path.join(phoneDir, 'groups');
        this.tasksFile = path.join(phoneDir, 'oa', 'tasks.cfg');
        this.stateFile = path.join(dataDir, 'worktasks.json');
        const r = fsx.readJson(this.stateFile);
        const v = r.ok && isObject(r.value) && r.value.v === V ? r.value : {};
        this.state = { v: V, tasks: Array.isArray(v.tasks) ? v.tasks : [], groups: isObject(v.groups) ? v.groups : {} };
    }

    save() {
        this.state.tasks = this.state.tasks.slice(-TASKS_KEEP);
        try {
            fsx.writeJson(this.stateFile, this.state, true);
        } catch (e) {
            this.log.warn('workgroup: not saved: ' + e.message);
        }
        this.publishTasks();
    }

    groupId(companyId) {
        return 'co' + String(companyId);
    }

    async person(id) {
        const hit = this.names.get(String(id));
        if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit;
        const c = await this.d.game.soft('entity_get_character_info', { entity_id: String(id) });
        const name = c ? ((c.last_name || '') + (c.first_name || '')) || c.name || '' : '';
        const entry = { at: Date.now(), name, first: (c && c.first_name) || name };
        if (name) this.names.set(String(id), entry);
        return entry;
    }

    async name(id) {
        return (await this.person(id)).name;
    }

    // What a colleague calls them in the group: the given name.
    async first(id) {
        return (await this.person(id)).first;
    }

    // ------------------------------------------------------------ the group
    // The played character's company group, made or brought up to date from the payroll. Returns
    // { id, desk, owner } or null when the character has no job.
    async sync(playerId) {
        const desk = await this.d.career.desk(String(playerId)).catch(() => undefined);
        if (desk === undefined) return null;
        // Left the company: out of its group.
        for (const companyId of Object.keys(this.state.groups)) {
            const g = this.state.groups[companyId];
            if ((!desk || desk.companyId !== companyId) && g.members.indexOf(String(playerId)) >= 0) {
                g.members = g.members.filter((m) => m !== String(playerId));
                this.log.info('workgroup: ' + playerId + ' left company ' + companyId + ', out of its group');
                this.writeGroup(companyId, g);
            }
        }
        if (!desk || !desk.companyId) {
            this.save();
            return null;
        }
        const roster = desk.roster.slice().sort((a, b) => b.rank - a.rank || Number(a.id) - Number(b.id));
        const owner = roster[0].id;
        const members = roster.map((r) => r.id);
        const names = {};
        for (const id of members) names[id] = await this.name(id);
        const g = { name: (desk.companyName || '公司') + '工作群', owner, members, names };
        const before = this.state.groups[desk.companyId];
        if (!before || before.owner !== g.owner || before.name !== g.name || before.members.join(',') !== members.join(',') ||
            members.some((id) => (before.names || {})[id] !== names[id])) {
            this.state.groups[desk.companyId] = g;
            this.writeGroup(desk.companyId, g);
            this.log.info('workgroup: ' + g.name + ' has ' + members.length + ' member(s), owner ' + owner);
            this.save();
        }
        return { id: this.groupId(desk.companyId), desk, owner };
    }

    writeGroup(companyId, g) {
        const id = this.groupId(companyId);
        try {
            fsx.ensureDir(path.join(this.groupsDir, 'g-' + id));
            fsx.writeJson(path.join(this.groupsDir, 'g-' + id, 'meta.cfg'), {
                v: 1, id, name: g.name, owner: g.owner,
                members: g.members.map((m) => ({ id: m, name: (g.names || {})[m] || '' })),
                // Its members do not chat on their own: the boss's tasks and the player's lines
                // are what is said in it.
                auto: false, company: true, companyId: String(companyId), closed: !g.members.length
            });
            const list = Object.keys(this.state.groups).filter((c) => this.state.groups[c].members.length).map((c) => {
                const x = this.state.groups[c];
                return { id: this.groupId(c), name: x.name, owner: x.owner, members: x.members };
            });
            fsx.writeJson(path.join(this.groupsDir, 'company.cfg'), { v: 1, groups: list });
        } catch (e) {
            this.log.warn('workgroup: group ' + id + ' not written: ' + e.message);
        }
        if (this.d.chatGroups && this.d.chatGroups.metaCache) this.d.chatGroups.metaCache.delete(id);
    }

    post(groupId, from, text, to, env) {
        if (!this.d.chatGroups) return null;
        return this.d.chatGroups.append(groupId, { from: String(from), name: '', text, to: to ? [String(to)] : [], game: gameStamp(env) });
    }

    // ------------------------------------------------------------ tasks
    // Every minute for the played character: the group, how open offers and taken tasks stand,
    // and a new offer when one is due.
    async tick(playerId, env) {
        if (!playerId || !env || typeof env.day !== 'number') return;
        const at = await this.sync(playerId);
        if (!at) return;
        await this.answers(playerId, at, env);
        await this.watch(playerId, at, env);
        if (!at.desk.questIds.length) return this.noTasks(playerId, at.desk.companyName);
        if (isObject(this.state.none) && this.state.none[String(playerId)] !== undefined) {
            delete this.state.none[String(playerId)];
            this.save();
        }
        if (this.giving || !at.desk.bossId) return;
        // A Lua mod from before missions could be added would leave a taken task unanswered.
        const j = this.d.journal;
        if (!j || !j.can('mission')) return;
        if (this.state.tasks.some((t) => t.member === String(playerId) && t.day === env.day)) return;
        if (env.hour < FROM_HOUR || env.hour >= UNTIL_HOUR) return;
        const work = await this.d.game.soft('career_get_work_status', { entity_id: String(playerId) });
        if (!work || !work.has_job) return;
        this.giving = true;
        try {
            await this.offer(playerId, at, env, !work.is_working_day);
        } finally {
            this.giving = false;
        }
    }

    hasOpenOffer() {
        return this.state.tasks.some((t) => t.state === 'offered');
    }

    // Every few seconds: a "我来" is taken at once rather than at the next minute.
    async quick(playerId, env) {
        if (!playerId || !env || typeof env.day !== 'number' || this.quickBusy) return;
        const open = this.state.tasks.filter((t) => t.member === String(playerId) && t.state === 'offered');
        if (!open.length) return;
        this.quickBusy = true;
        try {
            await this.answers(playerId, { id: open[0].group }, env, true);
        } finally {
            this.quickBusy = false;
        }
    }

    // The missions of the player's rank, as { quest, mission, text }: from the company's work
    // quest when it has one (SoundCompany_Quest -> SoundCompany_Quest_Working), else the after-work one.
    async missions(desk) {
        const out = [];
        for (const afterWork of desk.questIds) {
            const working = await this.d.game.soft('data_table_get', { Alias: 'Quest', Row: afterWork + '_Working' });
            const questId = working && Array.isArray(working.questList) ? afterWork + '_Working' : afterWork;
            const row = working && Array.isArray(working.questList) ? working : await this.d.game.soft('data_table_get', { Alias: 'Quest', Row: questId });
            for (const q of row && Array.isArray(row.questList) ? row.questList : []) {
                for (const t of Array.isArray(q.questTask) ? q.questTask : []) {
                    if (t && t.missionDtId && t.missionDtId !== 'None') out.push({ quest: questId, mission: t.missionDtId });
                }
            }
        }
        const keys = [];
        const goals = {};
        for (const m of out) {
            const row = await this.d.game.soft('data_table_get', { Alias: 'Mission', Row: m.mission });
            const c = row && Array.isArray(row.conditions) ? row.conditions[0] : null;
            m.key = c && c.descTextId ? c.descTextId : '';
            goals[m.mission] = c ? Number(c.goalCount) || 1 : 1;
            if (m.key) keys.push(m.key);
        }
        const text = keys.length ? await this.d.game.soft('l10n_get', { Keys: JSON.stringify(keys) }) : null;
        for (const m of out) {
            const t = text && typeof text[m.key] === 'string' && text[m.key] !== m.key ? text[m.key] : '';
            m.text = t.replace(/\{GoalCount\}/g, String(goals[m.mission]));
        }
        return out.filter((m) => m.text);
    }

    // The character's missions running in the game right now, by mission id.
    async running(playerId) {
        const comp = await this.d.game.soft('entity_reflect', { entity_id: String(playerId), Component: 'FB2QuestComponent' });
        const map = comp && isObject(comp.executingQuestMap) ? comp.executingQuestMap : {};
        const out = new Set();
        const byQuest = {};
        for (const k of Object.keys(map)) {
            const info = map[k] && map[k].questInfo;
            const id = info && info.questTask && info.questTask.missionDtId;
            if (!id) continue;
            out.add(String(id));
            const q = String(info.questId || '');
            (byQuest[q] = byQuest[q] || []).push(String(id));
        }
        // Done, failed or running today, in any quest: a task the boss hands out is a new one.
        const today = new Set(out);
        const history = comp && isObject(comp.todayQuestHistoryData) ? comp.todayQuestHistoryData : {};
        for (const q of Object.keys(history)) {
            const elements = history[q] && isObject(history[q].historyElementMap) ? history[q].historyElementMap : {};
            const quest = q.charAt(0).toUpperCase() + q.slice(1);
            for (const k of Object.keys(elements)) {
                const m = k.charAt(0).toUpperCase() + k.slice(1);
                today.add(m);
                // Done or failed already, no longer running: still the quest's today.
                if (!(byQuest[quest] || []).includes(m)) (byQuest[quest] = byQuest[quest] || []).push(m);
            }
        }
        return { comp, missions: out, today, byQuest };
    }

    // The boss asks the group who will take today's task. Nothing is added to the game yet.
    async offer(playerId, at, env, optional) {
        const now = await this.running(playerId);
        const last = this.state.tasks.filter((t) => t.member === String(playerId)).slice(-1)[0];
        const every = await this.missions(at.desk);
        if (!every.length) return this.noTasks(playerId, at.desk.companyName);
        const all = every.filter((m) => !now.today.has(m.mission));
        if (!all.length) {
            this.log.info('workgroup: every mission of ' + playerId + "'s job is already running or done today, no offer");
            return;
        }
        const choice = all.filter((m) => !last || m.mission !== last.mission);
        const m = pick(choice.length ? choice : all);
        const task = {
            id: 't' + Date.now().toString(36), member: String(playerId), companyId: at.desk.companyId, group: at.id,
            boss: at.desk.bossId, quest: m.quest, mission: m.mission, text: m.text, day: env.day, at: Date.now(),
            offeredMin: minuteOf(env), state: 'offered', optional: !!optional
        };
        task.bossName = await this.name(task.boss);
        this.state.tasks.push(task);
        this.save();
        this.log.info('workgroup: ' + task.bossName + ' offered' + (task.optional ? ' (optional)' : '') + ' "' + task.text + '" (' + m.quest + '/' + m.mission + ')');
        this.post(task.group, task.boss, await this.line(task, 'offer'), '', env);
    }

    // What the player said in the group about open offers: taken, turned down, or nothing yet
    // and too late now.
    // quick: only what the player said; nothing closes for lateness.
    async answers(playerId, at, env, quick) {
        const open = this.state.tasks.filter((t) => t.member === String(playerId) && t.state === 'offered');
        if (!open.length) return;
        const r = fsx.readJson(path.join(this.groupsDir, 'g-' + at.id, 'outbox.cfg'));
        const lines = r.ok && Array.isArray(r.value) ? r.value : [];
        for (const t of open) {
            const said = lines.filter((m) => m && Number(m.at) > t.at && (!m.from || String(m.from) === String(playerId)))
                .map((m) => hanzi.simplify(String(m.text || '')));
            if (said.some((x) => TAKE_RE.test(x) && !NOT_RE.test(x))) await this.take(t, env);
            else if (said.some((x) => NOT_RE.test(x))) {
                t.state = 'declined';
                this.save();
                this.log.info('workgroup: ' + playerId + ' turned "' + t.text + '" down');
            } else if (!quick && minuteOf(env) - (t.offeredMin || 0) >= OFFER_MINUTES) await this.close(t, at, env);
        }
    }

    // The player took it: theirs, and in the game.
    async take(task, env) {
        task.state = 'taking';
        task.takenAt = Date.now();
        task.before = (await this.running(task.member)).byQuest[task.quest] || [];
        this.save();
        this.d.career.request(task.member, 'q', task.quest + '/' + task.mission, (res) => {
            this.added(task, res, env).catch((e) => this.log.warn('workgroup: task ' + task.id + ': ' + e.message));
        });
    }

    // The Lua mod's answer. Its own check right after adding is not to be trusted, so the game's
    // quest record says whether a mission went in, and which.
    async added(task, res, env) {
        let inGame = false;
        if (res.ok || /^(not_added|unchecked)$/.test(String(res.detail || ''))) {
            for (let i = 0; i < 4 && !inGame; i++) {
                await new Promise((done) => setTimeout(done, i ? 1000 : 500));
                inGame = await this.adopt(task);
            }
        }
        if (!inGame) {
            task.state = 'not_given';
            task.why = String(res.detail || '') || 'not in the game';
            this.log.warn('workgroup: mission ' + task.mission + ' not added to ' + task.member + ' (' + task.why + ')');
            this.save();
            this.post(task.group, task.boss, await this.line(task, 'cancel'), task.member, env);
            return;
        }
        await this.taken(task, env);
    }

    // A mission new under the task's quest since it was taken: the task, whichever one it is.
    async adopt(task) {
        const now = (await this.running(task.member)).byQuest[task.quest] || [];
        const before = new Set(task.before || []);
        const mine = new Set(this.state.tasks.filter((t) => t !== task && t.member === task.member && t.state === 'given').map((t) => t.mission));
        const fresh = now.filter((m) => !before.has(m) && !mine.has(m));
        if (!fresh.length) return false;
        const m = fresh.indexOf(task.mission) >= 0 ? task.mission : fresh[0];
        if (m !== task.mission) {
            const desk = await this.d.career.desk(task.member).catch(() => null);
            const row = desk ? (await this.missions(desk)).find((x) => x.mission === m) : null;
            this.log.info('workgroup: the game gave ' + m + ' rather than ' + task.mission);
            task.offeredText = task.text;
            task.mission = m;
            if (row) task.text = row.text;
        }
        return true;
    }

    async taken(task, env) {
        task.state = 'given';
        this.log.info('workgroup: ' + task.member + ' took "' + task.text + '" (' + task.quest + '/' + task.mission + ')');
        this.save();
        this.post(task.group, task.boss, await this.line(task, 'confirm'), task.member, env);
    }

    // Nobody took it in time: a colleague gets it on a work day, on a day off it lapses.
    async close(task, at, env) {
        const others = at.desk.roster.map((x) => x.id).filter((id) => id !== task.member && id !== task.boss);
        if (task.optional || !others.length) {
            task.state = 'lapsed';
            this.save();
            this.log.info('workgroup: nobody took the optional "' + task.text + '"');
            return;
        }
        task.state = 'handed';
        task.taker = pick(others);
        task.takerName = await this.name(task.taker);
        this.save();
        this.log.info('workgroup: "' + task.text + '" went to ' + task.takerName);
        const said = this.post(task.group, task.boss, await this.line(task, 'handoff'), task.taker, env);
        this.answerHandoff(task, said);
    }

    // The colleague the boss named answers in the group, in their own voice (groups.js speaks the
    // queued line): a named colleague who says nothing reads as if nobody were there.
    answerHandoff(task, said) {
        const groups = this.d.chatGroups;
        if (!groups || typeof groups.state !== 'function' || !task.taker) return;
        const st = groups.state(task.group);
        const what = task.text.replace(/（.*$/, '');
        const ref = said && said.id ? String(said.id) : '';
        st.queue = (st.queue || []).concat([{
            at: Date.now() + 4000 + Math.floor(Math.random() * 8000), from: String(task.taker), why: '点了名',
            quote: ref, replyTo: ref, mentions: [], kind: 'duty', author: String(task.boss),
            duty: '上级在群里点名让你做「' + what + '」。在群里应下来，像同事平时回领导那样：收到、好的我来、马上弄，可以带一点你自己的语气或者小抱怨，但要答应。'
        }]).slice(-8);
        groups.saveState(task.group, st);
    }

    // How the tasks the player took stand in the game's own quest record.
    async watch(playerId, at, env) {
        for (const t of this.state.tasks.filter((x) => x.member === String(playerId) && x.state === 'not_given' && x.day === env.day && !x.rechecked)) {
            t.rechecked = true;
            if (await this.adopt(t)) {
                t.state = 'given';
                this.log.info('workgroup: ' + t.member + ' has "' + t.text + '" in the game after all');
                this.save();
                // Already done: the boss's thanks below says all there is to say.
                const h = (await this.running(t.member)).comp;
                const q = h && isObject(h.todayQuestHistoryData) ? h.todayQuestHistoryData[reflectedKey(t.quest)] : null;
                const e = q && isObject(q.historyElementMap) ? q.historyElementMap[reflectedKey(t.mission)] : null;
                if (!(e && e.isSuccess)) this.post(t.group, t.boss, await this.line(t, 'recover'), t.member, env);
            } else this.save();
        }
        const open = this.state.tasks.filter((t) => t.member === String(playerId) && t.state === 'given');
        if (!open.length) return;
        const comp = await this.d.game.soft('entity_reflect', { entity_id: String(playerId), Component: 'FB2QuestComponent' });
        if (!comp) return;
        const history = isObject(comp.todayQuestHistoryData) ? comp.todayQuestHistoryData : {};
        for (const t of open) {
            const q = history[reflectedKey(t.quest)] || history[t.quest];
            const map = q && isObject(q.historyElementMap) ? q.historyElementMap : {};
            const e = map[reflectedKey(t.mission)] || map[t.mission];
            if (e && e.isSuccess) await this.settle(t, 'done', env);
            else if ((e && e.isFail) || env.day > t.day) await this.settle(t, 'missed', env);
        }
    }

    async settle(task, state, env) {
        task.state = state;
        task.settledAt = Date.now();
        this.save();
        this.log.info('workgroup: task ' + task.id + ' "' + task.text + '" ' + state);
        // An optional task left undone is nothing to hold against anyone, nor to bring up.
        if (task.optional && state === 'missed') return;
        if (this.d.workplace) {
            const what = '「' + task.text.replace(/（.*$/, '') + '」';
            await this.d.workplace.change(task.member, task.boss,
                state === 'done' ? (task.optional ? OPTIONAL_DONE_DELTA : DONE_DELTA) : MISSED_DELTA,
                state === 'done' ? (task.optional ? '休息日主动做了' : '按时完成了') + what : '接了没做完' + what, env.day, task.bossName);
        }
        this.post(task.group, task.boss, await this.line(task, state), task.member, env);
    }

    // The boss's line in the group: written in their voice when the model answers, else plain.
    // kind: offer | confirm | cancel | handoff | done | missed
    async line(task, kind) {
        const what = task.text.replace(/（.*$/, '');
        const name = (await this.name(task.member)) || '';
        const first = (await this.first(task.member)) || name;
        const other = task.takerName || '';
        const otherFirst = task.taker ? (await this.first(task.taker)) || other : other;
        const plain = {
            offer: task.optional ? '今天休息，谁有空可以把「' + what + '」做一下？不强求。' : '今天「' + what + '」谁来做一下？',
            confirm: '好，@' + first + ' 「' + what + '」交给你了' + (task.optional ? '，辛苦。' : '，下班前给我。'),
            cancel: '@' + first + ' 好，这个我再安排，先不用了。',
            recover: '@' + first + ' 刚才说错了，「' + what + '」还是你来，已经给你了' + (task.optional ? '。' : '，下班前给我。'),
            handoff: '那 @' + otherFirst + ' 你来吧。',
            done: '@' + first + ' 「' + what + '」收到了，' + (task.optional ? '休息日还惦记着，辛苦了。' : '不错。'),
            missed: '@' + first + ' 你接的「' + what + '」呢？'
        }[kind];
        if (!this.d.llm || !this.d.llm.configured || !this.d.workplace) return plain;
        try {
            const style = STYLES[this.d.workplace.style(task.boss)];
            const score = this.d.workplace.score(task.member, task.boss);
            const ask = {
                offer: task.optional
                    ? '今天是休息日。在公司工作群里问大家有没有人有空做一件可选的活：' + task.text + '。说清楚做什么，不点名，也说明不强求。'
                    : '在公司工作群里问大家今天谁来做这件活：' + task.text + '。说清楚做什么，不点名。',
                confirm: task.offeredText
                    ? name + '在群里说他来做，你把活交给他，具体是「' + what + '」（说清楚就做这个），开头 @' + first + '。'
                    : name + '在群里说这件活（' + what + '）他来做，你在群里回一句交给他，开头 @' + first + '。',
                recover: '你刚才在群里说不用' + name + '做了，其实说错了：「' + what + '」还是交给他，已经安排好了。在群里更正一句，开头 @' + first + '。',
                cancel: name + '说要接「' + what + '」，可你又决定先不用他做了，在群里回一句，开头 @' + first + '。',
                handoff: '没人接「' + what + '」，你在群里点名让' + other + '来做，开头 @' + otherFirst + '。',
                done: name + (task.optional ? '在休息日主动' : '按时') + '把接下的「' + what + '」做完了，在群里回一句，开头 @' + first + '。',
                missed: name + '接了「' + what + '」却没做完，在群里说一句，开头 @' + first + '。'
            }[kind];
            const r = await this.d.llm.json(
                '你是公司里的上级' + (task.bossName || '') + '，在公司微信工作群里发一条消息。' + (style ? style.text : '') +
                (typeof score === 'number' && kind !== 'offer' && kind !== 'handoff' ? '你对' + name + '的印象是 ' + score + ' 分（满分 100）。' : '') +
                '只输出 JSON：{"text":"消息内容"}。不超过 40 个字，口语，不写旁白，不提分数和性格。' + require('./aitone').RULE_TEXT,
                ask, { purpose: 'worktask', voice: ['text'], max_tokens: 160, thinking: 'disabled' });
            const text = r && typeof r.text === 'string' ? r.text.trim() : '';
            return text ? text.slice(0, 80) : plain;
        } catch (e) {
            this.log.warn('workgroup: boss line not written: ' + e.message);
            return plain;
        }
    }

    // Only the office jobs (IT, news, architecture, music, lab, travel) have work missions in the
    // game that can be handed out. A shop, a fire station or a company off the lot has its work in
    // the shift itself: the group is there, the boss hands nothing out.
    noTasks(playerId, companyName) {
        const id = String(playerId);
        if (!isObject(this.state.none)) this.state.none = {};
        if (this.state.none[id] === companyName) return;
        this.state.none[id] = companyName || '';
        this.log.info('workgroup: ' + id + "'s job (" + (companyName || '?') + ') has no work missions to hand out');
        this.save();
    }

    // What the phone's OA shows in 待办.
    publishTasks() {
        if (!this.tasksFile) return;
        const list = this.state.tasks.filter((t) => t.state !== 'taking' && t.state !== 'not_given').slice(-TASKS_SHOWN).map((t) => ({
            id: t.id, member: t.member, text: t.text, bossName: t.bossName || '', day: t.day, state: t.state, at: t.at,
            optional: !!t.optional, taker: t.takerName || ''
        }));
        try {
            fsx.ensureDir(path.dirname(this.tasksFile));
            // none: members whose job has nothing the boss can hand out.
            fsx.writeJson(this.tasksFile, { v: V, list, none: isObject(this.state.none) ? Object.keys(this.state.none) : [] });
        } catch (e) {
            this.log.warn('workgroup: tasks not written: ' + e.message);
        }
    }
}

module.exports = { WorkGroup, reflectedKey };
