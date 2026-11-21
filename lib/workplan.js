'use strict';
// The day's tasks at the company the player runs (company.js). At work the game lets everyone
// pick their own work at the office (CustomSchedulePreset: in the work slots, any interaction
// tagged Event_Career_Work, all of them on a computer, all of them adding to the team project),
// and puts one or two random missions of the job's work quest in their quest list (「工作」:
// <Company>_Quest_Working, each mission "do this work N times").
//
// Once the player runs the company, every work day a window apart from the phone (the focus app)
// asks them who does what today, themselves included, morning and afternoon (each work slot) apart,
// one task or several each. Then, in each slot:
//   - the work missions the game hands out (its quest list, 「工作」) are the planned ones: the
//     company's work quest row in the game's Quest table is patched (data.patch) to list only the
//     missions the played character has planned for the slot under way, or the next one, and to
//     pick all of them; with nothing planned, or after work, the row is put back as it was. The game
//     hands missions out when a slot starts, so a plan made before the slot is what appears;
//     missions already handed out stay until the game hands out again. The row is one for the
//     whole company, so the employees are handed the same (nobody sees theirs);
//   - everyone is kept on their tasks: someone idle or on other work is set to the one of theirs
//     done least so far today, on their own computer (interaction_execute), so several tasks take
//     turns. The played character is never interrupted: only when idle.
// Whoever has no task works as the game has them.
//
// Tasks have a difficulty (TIERS): a harder one asks for more of the company's skill (the skill its
// team projects use, TeamProject.skillId) and, each time someone finishes it, adds more to the team
// project on top of what the game itself gives for the work (HouseholdJournal op p: the game's own
// Add_TeamProjectPoint_<n> scripts, credited to them). Someone short of the skill cannot be given it.
//
// It also follows how the day goes: game minutes each person spent on their tasks (each one), how
// many times they finished each, on other work, or off it, and the team-project points they added
// today. The phone's OA shows it.
//
// Files (<focus> is the focus app's ui/focus):
//   <focus>/plan/<manager>.cfg  here only, what the window shows:
//     { v, seq, day, company, slots: [{ from, to, label }], tasks: [{ id, name }], last, decided,
//       people: [{ id, name, rankName, me, skills: [{ name, level }], slots: [[task]] }] }
//   <focus>/plan/answer.cfg     the window only: { seq, player, day, assign: { <id>: [[task], [task]] } }
//                               (one list per slot; a flat list counts for every slot)
//   <focus>/request.cfg         op plan, through ielts.request: opens the window
// The phone asks for the window again through oa-mgmt.cfg planOpen: { at } (company.poll).
const path = require('path');
const fsx = require('./fsx');
const paths = require('./paths');

const V = 2;
const TASKS_TTL_MS = 6 * 3600000;
const STEER_GAP_MS = 45000;
// Share of the day's work time on their tasks that counts as the day's work done.
const DONE_SHARE = 0.6;
const MINUTES_CAP = 30;
const SKILLS_SHOWN = 3;

function stateEfficiency(st) {
    const morale = st && typeof st.morale === 'number' ? st.morale : 60;
    return Math.max(0.65, Math.min(1.2, 0.65 + morale / 100 * 0.55));
}
const DONE_MORALE = 2;
// The window is asked for from this long before the first work slot.
const ASK_BEFORE_MIN = 60;

// Difficulty: the company skill a task asks for, and the points finishing it once adds to the project.
const TIERS = [
    { name: '初级', need: 0, bonus: 3 },
    { name: '中级', need: 3, bonus: 6 },
    { name: '高级', need: 6, bonus: 10 }
];
// Where the tasks of a company known here sit, easy to hard. Others are split in three in the
// order the game lists them.
const TIER_OF = {
    SoundCompany_TrendResearch: 0, SoundCompany_SoundCalibration: 0,
    SoundCompany_PitchCorrection: 1, SoundCompany_MelodyStudy: 1,
    SoundCompany_InstRecording: 2, SoundCompany_MainCompose: 2
};
// A planned task done this many game minutes before it ends counts as finished once.
const FINISH_MIN = 8;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// The game's tables are read with camelCase field names and patched with PascalCase ones.
const pascal = (v) => Array.isArray(v) ? v.map(pascal)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).map((k) => [k.charAt(0).toUpperCase() + k.slice(1), pascal(v[k])])) : v;
// The missions of a quest handed out already today (FB2QuestComponent.todayQuestHistoryData, keyed
// by the quest id cut short and with its first letter in lower case: soundCompany_Quest).
function todayMissions(st, quest) {
    const h = st && st.todayQuestHistoryData || {};
    const q = quest.toLowerCase();
    const out = [];
    for (const k of Object.keys(h)) {
        if (!q.startsWith(k.toLowerCase())) continue;
        for (const ms of Object.keys(h[k] && h[k].historyElementMap || {})) out.push(ms.charAt(0).toUpperCase() + ms.slice(1));
    }
    return out;
}
const hhmm = (n) => Math.floor(Number(n) / 100) * 60 + Number(n) % 100;
const flat = (v) => Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : [];
// A person's tasks per slot: [[task], ...]. A flat list (an older plan) counts for every slot.
function perSlot(v, n) {
    const out = [];
    const nested = Array.isArray(v) && v.some((x) => Array.isArray(x));
    for (let i = 0; i < n; i++) out.push(nested ? flat(v[i]) : flat(v));
    return out;
}
function slotLabel(s, i, n) {
    if (n === 2) return i === 0 ? '上午' : '下午';
    return s.from < 720 ? '上午' : s.from < 1080 ? '下午' : '晚上';
}

class WorkPlan {
    constructor(daemon, company) {
        this.d = daemon;
        this.company = company;
        this.log = daemon.log;
        this.dir = '';
        this.moraleFile = '';
        this.moraleValue = '';
        this.answerSeq = 0;
        this.steeredAt = new Map();
        // Mission id -> the work it asks for (Mission table), read once.
        this.missionBag = new Map();
        this.lastDrive = null;
        this.driving = false;
    }

    configure(focusDir) {
        this.dir = path.join(focusDir, 'plan');
        const mod = paths.findMod(paths.JOURNAL_MOD_ID);
        this.moraleFile = mod ? path.join(mod, 'bridge', 'workmorale.cfg') : '';
        this.moraleValue = '';

        const r = fsx.readJson(path.join(this.dir, 'answer.cfg'));
        // An answer from before this run was already taken, or is for a day gone.
        this.answerSeq = r.ok && r.value && typeof r.value.seq === 'number' ? r.value.seq : 0;
    }

    writeMorale(c) {
        if (!this.moraleFile) return;
        const value = Object.keys(c.staff || {}).map((id) => id + ':' + Math.round(Number(c.staff[id].morale) || 60)).join(';');
        if (value === this.moraleValue) return;
        try {
            fsx.ensureDir(path.dirname(this.moraleFile));
            fsx.writeAtomic(this.moraleFile, value);
            this.moraleValue = value;
        } catch (e) { this.log.warn('workplan: morale not written: ' + e.message); }
    }

    // The company's work tasks: its own bags tagged Event_Career_Work, with the game's names.
    async tasks(careerDtId) {
        if (!careerDtId) return [];
        return this.d.world.cached('worktasks:' + careerDtId, TASKS_TTL_MS, async () => {
            const r = await this.d.game.soft('interaction_search', { Keyword: careerDtId, max_results: 60 });
            const list = r && Array.isArray(r.results) ? r.results : [];
            const work = list.filter((x) => x && String(x.interaction_bag_id).indexOf(careerDtId + '_') === 0 &&
                Array.isArray(x.tags) && x.tags.indexOf('Event_Career_Work') >= 0);
            return work.map((x, i) => {
                const id = String(x.interaction_bag_id);
                const tier = TIER_OF[id] !== undefined ? TIER_OF[id] : Math.min(2, Math.floor(i * 3 / work.length));
                return { id, name: x.display_name || id, tier, tierName: TIERS[tier].name, need: TIERS[tier].need, bonus: TIERS[tier].bonus };
            }).sort((a, b) => a.tier - b.tier);
        });
    }

    // The work slots of the day, in minutes: [{ from, to, label }].
    async slots(careerDtId) {
        if (!careerDtId) return [];
        return this.d.world.cached('workslots:' + careerDtId, TASKS_TTL_MS, async () => {
            const row = await this.d.game.soft('data_table_get', { Alias: 'CustomSchedulePreset', Row: careerDtId });
            const slots = row && Array.isArray(row.scheduleSlotPresetDatas) ? row.scheduleSlotPresetDatas : [];
            const out = slots.filter((s) => (s.roleActions || []).some((a) => (a.actionTagIds || []).indexOf('Event_Career_Work') >= 0))
                .map((s) => ({ from: hhmm(s.startHHMM), to: hhmm(s.endHHMM) })).filter((s) => s.to > s.from)
                .sort((a, b) => a.from - b.from);
            return out.map((s, i) => Object.assign(s, { label: slotLabel(s, i, out.length) }));
        });
    }

    // The job's work quest as the game has it unpatched, kept in the company's record the first
    // time it is read (c.questRow: { quest, list, min, max }), and for each work task the mission
    // that asks for it: { quest, list, min, max, byTask: { <bag>: mission } }.
    async missions(c) {
        const careerDtId = c.careerDtId;
        if (!careerDtId) return null;
        const quest = careerDtId + '_Quest_Working';
        if (!isObject(c.questRow) || c.questRow.quest !== quest) {
            const row = await this.d.game.soft('data_table_get', { Alias: 'Quest', Row: quest });
            if (!row || !Array.isArray(row.questList) || !row.questList.length) return null;
            c.questRow = { quest, list: row.questList, min: Number(row.randomSelectMin) || 1, max: Number(row.randomSelectMax) || 1 };
        }
        const byTask = {};
        for (const q of c.questRow.list) {
            const ms = q && Array.isArray(q.questTask) && q.questTask[0] ? q.questTask[0].missionDtId : '';
            if (!ms || ms === 'None') continue;
            if (!this.missionBag.has(ms)) {
                const m = await this.d.game.soft('data_table_get', { Alias: 'Mission', Row: ms });
                const cond = m && Array.isArray(m.conditions) ? m.conditions[0] : null;
                this.missionBag.set(ms, cond && cond.conditionType === 'InteractionBagCount' && cond.conditionId1 ? String(cond.conditionId1) : '');
            }
            const bag = this.missionBag.get(ms);
            if (bag) byTask[bag] = ms;
        }
        return Object.assign({ byTask }, c.questRow);
    }

    planOf(c, day) {
        if (!isObject(c.plan) || c.plan.day !== day) {
            const last = isObject(c.plan) && isObject(c.plan.assign) ? c.plan.assign : {};
            c.plan = { day, decided: false, asked: false, assign: {}, last, stats: {}, start: {}, settled: false, quest: {} };
        }
        if (!isObject(c.plan.quest)) c.plan.quest = {};
        return c.plan;
    }

    slotIndex(c, now) {
        const slots = c.workSlots || [];
        for (let i = 0; i < slots.length; i++) if (now >= slots[i].from && now < slots[i].to) return i;
        return -1;
    }

    // Every minute while the player runs the company (company.tick).
    async tick(c, desk, env) {
        if (!this.dir || !env || typeof env.day !== 'number') return;
        const plan = this.planOf(c, env.day);
        const [tasks, slots] = await Promise.all([this.tasks(desk.careerDtId).catch(() => []), this.slots(desk.careerDtId).catch(() => [])]);
        c.workTasks = tasks;
        c.workSlots = slots;
        c.careerDtId = desk.careerDtId;
        if (!tasks.length || !slots.length) return;
        // Where the project stood when the day began, for the points added today.
        if (desk.project && !Object.keys(plan.start).length) plan.start = Object.assign({}, desk.project.contributions || {});
        plan.points = {};
        if (desk.project) for (const id of Object.keys(desk.project.contributions || {})) plan.points[id] = (desk.project.contributions[id] || 0) - (plan.start[id] || 0);
        this.takeAnswer(c, env.day);
        const now = (Number(env.hour) || 0) * 60 + (Number(env.minute) || 0);
        const first = slots[0].from;
        const last = slots[slots.length - 1].to;
        if (plan.decided) await this.syncPlayer(c, now).catch((e) => this.log.warn('workplan quests: ' + (e && e.message || e)));
        // The day is over: those who did their work are glad of it.
        if (now >= last && plan.decided && !plan.settled) this.settle(c, plan, slots);
        if (plan.decided || plan.asked || now < first - ASK_BEFORE_MIN || now >= last) return;
        const possessed = await this.d.world.possessed();
        if (String(possessed) !== String(c.manager)) return;
        const work = await this.d.game.soft('career_get_work_status', { entity_id: String(c.manager) });
        if (!work || !work.is_working_day) return;
        if (await this.open(c, desk)) plan.asked = true;
    }

    // The window, on the manager, filled with today's people and tasks.
    async open(c, desk) {
        const ielts = this.d.ielts;
        if (!ielts || typeof ielts.request !== 'function' || !ielts.boxAlive()) return false;
        const plan = c.plan;
        const n = (c.workSlots || []).length;
        const ids = [String(c.manager)].concat(Object.keys(c.staff || {}));
        const people = [];
        const keyId = this.keySkill(c);
        let keyName = '';
        plan.levels = {};
        for (const id of ids) {
            const [info, sk] = await Promise.all([
                this.d.world.characterInfo(id).catch(() => null),
                this.d.game.soft('skill_get_all', { entity_id: id })
            ]);
            const r = (desk.roster || []).find((x) => x.id === id);
            const skills = sk && Array.isArray(sk.skills) ? sk.skills.filter((s) => Number(s.level) > 0)
                .sort((a, b) => b.level - a.level).slice(0, SKILLS_SHOWN).map((s) => ({ name: s.l10n || s.id, level: Number(s.level) })) : [];
            const k = keyId && sk && Array.isArray(sk.skills) ? sk.skills.find((s) => s.id === keyId) : null;
            if (k && !keyName) keyName = k.l10n || k.id;
            const level = k ? Number(k.level) || 0 : null;
            if (level !== null) plan.levels[id] = level;
            people.push({
                level,
                id, name: info ? ((info.last_name || '') + (info.first_name || '')).trim() || id : id, me: id === String(c.manager),
                rankName: r && desk.rankNames ? desk.rankNames[r.rank] || '' : '', skills,
                slots: perSlot(plan.assign[id] !== undefined ? plan.assign[id] : plan.last[id], n)
            });
        }
        const last = {};
        for (const id of Object.keys(plan.last || {})) last[id] = perSlot(plan.last[id], n);
        const view = {
            v: V, seq: Date.now(), day: plan.day, company: c.name || '', manager: String(c.manager), decided: plan.decided,
            slots: c.workSlots, tasks: c.workTasks, last, people,
            skill: keyId ? { id: keyId, name: keyName || keyId } : null,
            tiers: TIERS.map((t) => ({ name: t.name, need: keyId ? t.need : 0, bonus: t.bonus }))
        };
        c.keySkillName = keyName || c.keySkillName || '';
        try {
            fsx.ensureDir(this.dir);
            fsx.writeJson(path.join(this.dir, String(c.manager) + '.cfg'), view);
        } catch (e) {
            this.log.warn('workplan: view not written: ' + e.message);
            return false;
        }
        ielts.request('plan', c.manager, c.manager, '今日工作安排');
        this.log.info('workplan: asked ' + c.manager + ' for day ' + plan.day + "'s tasks (" + people.length + ' people)');
        return true;
    }

    takeAnswer(c, day) {
        const r = fsx.readJson(path.join(this.dir, 'answer.cfg'));
        const a = r.ok ? r.value : null;
        if (!isObject(a) || !(Number(a.seq) > this.answerSeq) || String(a.player) !== String(c.manager)) return;
        this.answerSeq = Number(a.seq);
        if (a.day !== day) return;
        const known = new Set((c.workTasks || []).map((t) => t.id));
        const n = (c.workSlots || []).length;
        const assign = {};
        for (const id of Object.keys(isObject(a.assign) ? a.assign : {})) {
            if (id !== String(c.manager) && !c.staff[id]) continue;
            const level = isObject(c.plan.levels) && typeof c.plan.levels[id] === 'number' ? c.plan.levels[id] : null;
            const able = (t) => level === null || !this.keySkill(c) || this.need(c, t) <= level;
            assign[id] = perSlot(a.assign[id], n).map((list) => list.filter((t, i, all) => known.has(t) && all.indexOf(t) === i && able(t)));
        }
        c.plan.assign = assign;
        c.plan.decided = true;
        c.plan.asked = true;
        // A changed plan is put in the game again.
        c.plan.quest = {};
        const given = Object.keys(assign).filter((k) => assign[k].some((l) => l.length)).length;
        this.log.info('workplan: day ' + day + ' planned, ' + given + ' with tasks');
        this.company.toast(given ? 'OA：今天的工作已安排好（' + given + ' 人）' : 'OA：今天大家按自己的节奏工作');
        this.company.save();
    }

    // The skill the company's team projects use (teamproject.catalogue, in company.js).
    keySkill(c) {
        const withSkill = (c.catalogue || []).find((x) => x && x.skill);
        return withSkill ? withSkill.skill : '';
    }

    taskOf(c, id) {
        return (c.workTasks || []).find((t) => t.id === id) || null;
    }

    need(c, id) {
        const t = this.taskOf(c, id);
        return t ? t.need || 0 : 0;
    }

    // A planned task finished once: the project gets its tier's points, credited to them.
    finished(c, id, bag, st) {
        st.done = isObject(st.done) ? st.done : {};
        st.done[bag] = (st.done[bag] || 0) + 1;
        const t = this.taskOf(c, bag);
        const basePoints = t ? t.bonus || 0 : 0;
        const points = basePoints ? Math.max(1, Math.round(basePoints * stateEfficiency(c.staff && c.staff[id]))) : 0;
        const j = this.d.journal;
        const career = this.d.career;
        if (!points || !j || !j.can('teampoint') || !career || typeof career.request !== 'function') {
            st.unpaid = (st.unpaid || 0) + points;
            return;
        }
        career.request(id, 'p', String(points), (res) => {
            const m = /(\d+)$/.exec(String(res && res.detail || ''));
            const got = res && res.ok && m ? Number(m[1]) : 0;
            st.bonus = (st.bonus || 0) + got;
            this.log.info('workplan: ' + id + ' finished ' + bag + ' (' + (t ? t.tierName : '') + ', morale ' +
                (c.staff && c.staff[id] && typeof c.staff[id].morale === 'number' ? c.staff[id].morale : 60) + '), project +' + got + (res && res.ok ? '' : ' (' + (res && res.detail) + ')'));
            this.company.save();
        });
    }

    // The phone asked for the window again.
    async reopen(c, desk) {
        if (!isObject(c.plan)) return;
        if (await this.open(c, desk)) c.plan.asked = true;
    }

    // The slot the game hands missions out for next: the one under way, else the next one today.
    targetSlot(c, now) {
        const slots = c.workSlots || [];
        for (let i = 0; i < slots.length; i++) if (now < slots[i].to) return i;
        return -1;
    }

    // The game's work quest row set to the played character's plan for the target slot (or put
    // back), and how it stands for them, as c.plan.quest[<id>:<slot>]:
    // { step: set (the work missions in their quest list are exactly the planned ones) | sent (the row is
    // patched; the game still shows what it handed out before) | repeat (every planned mission was
    // handed out already today, and the game hands each one out once a day) | failed (the row took
    // no patch) }. A mission handed out already today is left out of the row: the game would not
    // hand it out again, and the slot would get what the game picks instead.
    async syncPlayer(c, now) {
        const plan = c.plan;
        const m = await this.missions(c).catch(() => null);
        if (!m) return;
        const id = String(c.manager);
        const si = isObject(plan) && plan.decided ? this.targetSlot(c, now) : -1;
        const list = si >= 0 ? perSlot(plan.assign[id], (c.workSlots || []).length)[si] : [];
        const planned = list.map((t) => m.byTask[t]).filter(Boolean);
        const st = planned.length ? await this.d.game.soft('entity_reflect', { entity_id: id, Component: 'FB2QuestComponent' }) : null;
        const mine = Object.keys(st && st.executingQuestMap || {}).map((k) => st.executingQuestMap[k])
            .filter((x) => x && x.questInfo && x.questInfo.questId === m.quest).map((x) => String(x.questInfo.questTask.missionDtId));
        const handed = mine.slice().sort().join('/');
        if (st && this.handed !== handed) {
            this.handed = handed;
            this.log.info('workplan: work missions the game gave ' + id + ' at ' + Math.floor(now / 60) + ':' + String(now % 60).padStart(2, '0') + ': ' + (handed || '(none)') + ' (planned ' + planned.join('/') + ')');
        }
        const today = todayMissions(st, m.quest).filter((ms) => mine.indexOf(ms) < 0);
        const wanted = planned.filter((ms) => today.indexOf(ms) < 0);
        const entries = wanted.length ? m.list.filter((q) => wanted.indexOf(q.questTask[0].missionDtId) >= 0) : m.list;
        const min = wanted.length ? entries.length : m.min;
        const max = wanted.length ? entries.length : m.max;
        const row = await this.d.game.soft('data_table_get', { Alias: 'Quest', Row: m.quest });
        if (!row || !Array.isArray(row.questList)) return;
        const ids = (l) => l.map((q) => q.questTask && q.questTask[0] ? q.questTask[0].missionDtId : '').join('/');
        let ok = true;
        if (ids(row.questList) !== ids(entries) || Number(row.randomSelectMin) !== min || Number(row.randomSelectMax) !== max) {
            const q = 'Quest[Id=' + m.quest + ']';
            const done = [];
            for (const [field, value] of [['QuestList', JSON.stringify(pascal(entries))], ['RandomSelectMin', String(min)], ['RandomSelectMax', String(max)]]) {
                const r = await this.d.game.soft('data_patch', { Method: 'Override', Query: q + '.' + field, Value: value });
                done.push(!!(r && r.result === 'Applied'));
            }
            ok = done.every(Boolean);
            this.log.info('workplan: the game\'s work quest ' + m.quest + (wanted.length ? ' set to ' + ids(entries) + ' (' + (c.workSlots[si] || {}).label + ')' : ' put back') + (ok ? '' : ', not taken'));
        }
        if (!planned.length) return;
        const key = id + ':' + si;
        let step = !wanted.length ? 'repeat' : ok ? 'sent' : 'failed';
        if (wanted.length && ok) {
            // All of the plan, and nothing else.
            if (mine.length && mine.every((ms) => wanted.indexOf(ms) >= 0) && wanted.every((ms) => mine.indexOf(ms) >= 0)) step = 'set';
        }
        if (!plan.quest[key] || plan.quest[key].step !== step) this.log.info('workplan: work missions of ' + id + ' (' + (c.workSlots[si] || {}).label + ') ' + step);
        plan.quest[key] = { step, at: now };
    }

    settle(c, plan, slots) {
        plan.settled = true;
        const total = slots.reduce((s, x) => s + (x.to - x.from), 0);
        for (const id of Object.keys(plan.assign)) {
            const st = plan.stats[id];
            const staff = c.staff[id];
            if (!perSlot(plan.assign[id], slots.length).some((l) => l.length) || !st || !staff) continue;
            if (st.on >= total * DONE_SHARE) staff.morale = Math.min(100, staff.morale + DONE_MORALE);
        }
        this.company.save();
    }

    // Every few seconds: keep everyone on the slot's tasks, and count the time.
    async drive(c, env) {
        if (this.driving || !isObject(c.plan) || !c.plan.decided || !env || c.plan.day !== env.day) return;
        this.writeMorale(c);
        const now = (Number(env.hour) || 0) * 60 + (Number(env.minute) || 0);
        const at = env.day * 1440 + now;
        const dt = this.lastDrive === null ? 0 : Math.max(0, Math.min(MINUTES_CAP, at - this.lastDrive));
        this.lastDrive = at;
        await this.syncPlayer(c, now).catch((e) => this.log.warn('workplan quests: ' + (e && e.message || e)));
        const si = this.slotIndex(c, now);
        if (si < 0) return;
        this.driving = true;
        try {
            const work = new Set((c.workTasks || []).map((t) => t.id));
            const possessed = String(await this.d.world.possessed() || '');
            for (const id of Object.keys(c.plan.assign)) {
                const list = perSlot(c.plan.assign[id], (c.workSlots || []).length)[si];
                if (!list.length) continue;
                const st = c.plan.stats[id] || (c.plan.stats[id] = { on: 0, other: 0, off: 0 });
                st.bySlot = isObject(st.bySlot) ? st.bySlot : {};
                const slotStat = st.bySlot[si] || (st.bySlot[si] = { on: 0, other: 0, off: 0 });
                st.byTask = isObject(st.byTask) ? st.byTask : {};
                const [cur, ws] = await Promise.all([
                    this.d.game.soft('interaction_get_current', { entity_id: id }),
                    this.d.game.soft('career_get_work_status', { entity_id: id })
                ]);
                const bag = cur && cur.playing && ws && ws.is_at_work ? String(cur.interaction_bag_id || '') : '';
                // The task they were on is over: finished once, if they stayed on it a while.
                const prev = isObject(st.cur) ? st.cur : null;
                if (prev && prev.bag !== bag) {
                    if (at - prev.since >= FINISH_MIN) this.finished(c, id, prev.bag, st);
                    st.cur = null;
                }
                if (list.indexOf(bag) >= 0 && !(prev && prev.bag === bag)) st.cur = { bag, since: at };
                if (!ws || !ws.is_at_work) { st.away = true; continue; }
                st.away = false;
                if (list.indexOf(bag) >= 0) {
                    st.on += dt;
                    slotStat.on += dt;
                    st.byTask[bag] = (st.byTask[bag] || 0) + dt;
                    continue;
                }
                if (work.has(bag)) { st.other += dt; slotStat.other += dt; }
                else { st.off += dt; slotStat.off += dt; }
                // The played character is the player's: only set to it while doing nothing.
                if (id === possessed && bag) continue;
                // Someone eating, at the toilet, talking: left to it. Idle, or on other work: set.
                if (bag && !work.has(bag)) continue;
                if (Date.now() - (this.steeredAt.get(id) || 0) < STEER_GAP_MS) continue;
                this.steeredAt.set(id, Date.now());
                // Several tasks take turns: the one done least so far today.
                const task = list.slice().sort((a, b) => (st.byTask[a] || 0) - (st.byTask[b] || 0))[0];
                await this.steer(c, id, task, bag);
            }
        } finally {
            this.driving = false;
        }
    }

    // Their task, on their own computer (the office's computers carry their user's name).
    async steer(c, id, task, bag) {
        const pc = await this.computerOf(c, id, task);
        if (!pc) {
            this.log.info('workplan: no computer found for ' + id + ' to do ' + task);
            return;
        }
        if (bag) await this.d.game.soft('interaction_clear_queue', { entity_id: id, cancel_current: true });
        await this.d.game.soft('interaction_execute', { entity_id: id, interaction_bag_id: task, target_entity_id: pc });
        this.log.info('workplan: ' + id + ' set to ' + task + (bag ? ' (was ' + bag + ')' : ''));
    }

    async computerOf(c, id, task) {
        c.computers = isObject(c.computers) ? c.computers : {};
        if (c.computers[id]) return c.computers[id];
        const info = await this.d.world.characterInfo(id).catch(() => null);
        const name = info ? ((info.last_name || '') + (info.first_name || '')).trim() : '';
        const scan = await this.d.game.soft('entity_scan_objects', { Radius: 60, Direction: 'all', Cone: 180, ref: 'pawn', Limit: 300, sort: 'distance' });
        const objects = scan && Array.isArray(scan.objects) ? scan.objects : [];
        const pcs = objects.filter((o) => /电脑|computer|PC/i.test(String(o.name || '')));
        let pick = name ? pcs.find((o) => String(o.name).indexOf(name) === 0) : null;
        if (!pick) {
            // Not one with their name: any the game offers the task on.
            for (const o of pcs) {
                const l = await this.d.game.soft('interaction_list_available', { entity_id: id, target_entity_id: String(o.entity_id) });
                if (l && Array.isArray(l.interactions) && l.interactions.some((x) => x.interaction_bag_id === task)) { pick = o; break; }
            }
        }
        if (!pick) return '';
        c.computers[id] = String(pick.entity_id);
        return c.computers[id];
    }

    // What the phone shows of today.
    view(c) {
        const plan = isObject(c.plan) ? c.plan : null;
        if (!plan) return null;
        const slots = c.workSlots || [];
        const total = slots.reduce((s, x) => s + (x.to - x.from), 0);
        const names = {};
        for (const t of c.workTasks || []) names[t.id] = t.name;
        const people = {};
        for (const id of Object.keys(plan.assign || {})) {
            const st = plan.stats[id] || { on: 0, other: 0, off: 0 };
            const by = isObject(st.byTask) ? st.byTask : {};
            const bySlot = isObject(st.bySlot) ? st.bySlot : {};
            const lists = perSlot(plan.assign[id], slots.length);
            const quest = isObject(plan.quest) ? plan.quest : {};
            people[id] = {
                slots: lists.map((list, i) => ({
                    label: slots[i] ? slots[i].label : '',
                    minutes: Math.round((bySlot[i] && bySlot[i].on) || 0),
                    other: Math.round((bySlot[i] && bySlot[i].other) || 0),
                    off: Math.round((bySlot[i] && bySlot[i].off) || 0),
                    target: slots[i] ? Math.round((slots[i].to - slots[i].from) * DONE_SHARE) : 0,
                    tasks: list.map((t) => {
                        const info = this.taskOf(c, t) || {};
                        return { id: t, name: names[t] || t, minutes: Math.round(by[t] || 0), tierName: info.tierName || '', tier: info.tier || 0,
                            done: isObject(st.done) ? st.done[t] || 0 : 0 };
                    }),
                    quest: quest[id + ':' + i] ? quest[id + ':' + i].step : ''
                })),
                on: Math.round(st.on), other: Math.round(st.other), off: Math.round(st.off),
                target: Math.round(total * DONE_SHARE), done: lists.some((l) => l.length) && st.on >= total * DONE_SHARE, away: !!st.away,
                points: plan.points && typeof plan.points[id] === 'number' ? plan.points[id] : 0,
                bonus: st.bonus || 0, unpaid: st.unpaid || 0
            };
        }
        return { day: plan.day, decided: plan.decided, asked: plan.asked, settled: plan.settled, slots, tasks: c.workTasks || [], people,
            skillName: c.keySkillName || '', tiers: TIERS,
            points: plan.points || {} };
    }
}

module.exports = { WorkPlan, perSlot, TIERS, stateEfficiency };
