'use strict';
// The day's tasks (lib/workplan.js): the window is asked for on a work day, the manager's answer
// is taken, and through the work slots an idle employee is set to their task while the played
// character, busy, is left alone; time on the task is counted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkPlan } = require('../lib/workplan');

test('asked on a work day, answered, and kept to', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
    const calls = [];
    const current = { 1: { playing: true, interaction_bag_id: 'Phone_Use' }, 11: { playing: false } };
    const d = {
        log: { info() {}, warn() {} },
        ielts: { boxAlive: () => true, request: (op, p) => calls.push('request ' + op + ' ' + p) },
        world: {
            cached: async (k, t, fn) => fn(), possessed: async () => '1',
            characterInfo: async (id) => ({ last_name: '李', first_name: 'n' + id })
        },
        game: {
            soft: async (n, a) => {
                calls.push(n + (a && a.entity_id ? ':' + a.entity_id : ''));
                if (n === 'interaction_search') return { results: [{ interaction_bag_id: 'Lab_Task', tags: ['Event_Career_Work'] },
                    { interaction_bag_id: 'Co_Task_A', display_name: '做A', tags: ['Event_Career_Work'] }, { interaction_bag_id: 'Co_Talk', tags: [] }] };
                if (n === 'data_table_get') return { scheduleSlotPresetDatas: [{ startHHMM: 1000, endHHMM: 1200, roleActions: [{ actionTagIds: ['Event_Career_Work'] }] }] };
                if (n === 'career_get_work_status') return { is_working_day: true, is_at_work: true };
                if (n === 'interaction_get_current') return current[a.entity_id];
                if (n === 'entity_scan_objects') return { objects: [{ entity_id: 77, name: '李n11 游戏电脑' }] };
                if (n === 'skill_get_all') return { skills: [] };
                return null;
            }
        }
    };
    const company = { toast() {}, save() {} };
    const w = new WorkPlan(d, company);
    w.configure(root);
    const c = { cid: '9', manager: '1', name: '星河', staff: { 11: { morale: 60 } } };
    const desk = { careerDtId: 'Co', roster: [{ id: '1', rank: 4 }, { id: '11', rank: 1 }], rankNames: {} };
    await w.tick(c, desk, { day: 3, hour: 9, minute: 30 });
    assert.ok(calls.includes('request plan 1'), 'the window is asked for before work');
    assert.deepEqual(c.workTasks.map((t) => t.id), ['Co_Task_A'], 'only the company work tasks');
    fs.writeFileSync(path.join(root, 'plan', 'answer.cfg'), JSON.stringify({ seq: Date.now(), player: '1', day: 3, assign: { 1: 'Co_Task_A', 11: 'Co_Task_A' } }));
    await w.tick(c, desk, { day: 3, hour: 9, minute: 40 });
    assert.ok(c.plan.decided);
    calls.length = 0;
    await w.drive(c, { day: 3, hour: 10, minute: 0 });
    await w.drive(c, { day: 3, hour: 10, minute: 10 });
    assert.ok(calls.includes('interaction_execute:11'), 'the idle employee is set to it');
    assert.ok(!calls.includes('interaction_execute:1'), 'the played character, busy, is left alone');
    current[11] = { playing: true, interaction_bag_id: 'Co_Task_A' };
    await w.drive(c, { day: 3, hour: 10, minute: 30 });
    assert.equal(w.view(c).people['11'].on, 20);
    fs.rmSync(root, { recursive: true, force: true });
});

test('several tasks take turns: free again, the one done least goes next', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
    const set = [];
    let cur = { playing: true, interaction_bag_id: 'Co_A' };
    const d = {
        log: { info() {}, warn() {} },
        world: { possessed: async () => '1', characterInfo: async () => ({ last_name: '李', first_name: 'n' }) },
        game: { soft: async (n, a) => {
            if (n === 'career_get_work_status') return { is_at_work: true };
            if (n === 'interaction_get_current') return cur;
            if (n === 'entity_scan_objects') return { objects: [{ entity_id: 77, name: '李n 游戏电脑' }] };
            if (n === 'interaction_execute') set.push(a.interaction_bag_id);
            return null;
        } }
    };
    const w = new WorkPlan(d, { toast() {}, save() {} });
    w.configure(root);
    const c = { manager: '1', staff: { 11: {} }, workSlots: [{ from: 600, to: 720 }], workTasks: [{ id: 'Co_A' }, { id: 'Co_B' }],
        plan: { day: 3, decided: true, assign: { 11: ['Co_A', 'Co_B'] }, stats: {} } };
    await w.drive(c, { day: 3, hour: 10, minute: 0 });
    await w.drive(c, { day: 3, hour: 10, minute: 20 });
    cur = { playing: false };
    await w.drive(c, { day: 3, hour: 10, minute: 21 });
    assert.deepEqual(set, ['Co_B']);
    assert.equal(w.view(c).people['11'].slots[0].tasks[0].minutes, 20);
    fs.rmSync(root, { recursive: true, force: true });
});

test('morning and afternoon apart: each slot its own work, and the game hands out only what was planned', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
    const set = [];
    const entry = (ms) => ({ startTime: 0, questTask: [{ missionDtId: ms }] });
    const row = { questList: [entry('M_A'), entry('M_B'), entry('M_C')], randomSelectMin: 1, randomSelectMax: 2 };
    let executing = { m_C: { questInfo: { questId: 'Co_Quest_Working', questTask: { missionDtId: 'M_C' } } } };
    const d = {
        log: { info() {}, warn() {} },
        world: { possessed: async () => '1', characterInfo: async () => ({ last_name: '李', first_name: 'n' }) },
        game: { soft: async (n, a) => {
            if (n === 'career_get_work_status') return { is_at_work: true };
            if (n === 'interaction_get_current') return { playing: false };
            if (n === 'entity_scan_objects') return { objects: [{ entity_id: 77, name: '李n 游戏电脑' }] };
            if (n === 'interaction_execute') set.push(a.interaction_bag_id);
            if (n === 'data_table_get' && a.Alias === 'Quest') return JSON.parse(JSON.stringify(row));
            if (n === 'data_table_get' && a.Alias === 'Mission') return { conditions: [{ conditionType: 'InteractionBagCount', conditionId1: 'Co_' + a.Row.slice(2) }] };
            if (n === 'entity_reflect') return { executingQuestMap: executing };
            if (n === 'data_patch') {
                const field = a.Query.split('.').pop();
                const v = JSON.parse(a.Value);
                if (field === 'QuestList') row.questList = v.map((q) => ({ startTime: q.StartTime, questTask: q.QuestTask.map((t) => ({ missionDtId: t.MissionDtId })) }));
                else row[field.charAt(0).toLowerCase() + field.slice(1)] = v;
                return { result: 'Applied' };
            }
            return null;
        } }
    };
    const w = new WorkPlan(d, { toast() {}, save() {} });
    w.configure(root);
    const ids = () => row.questList.map((q) => q.questTask[0].missionDtId).join('/');
    const c = { manager: '9', careerDtId: 'Co', staff: { 11: {} }, workSlots: [{ from: 600, to: 720, label: '上午' }, { from: 840, to: 1020, label: '下午' }],
        workTasks: [{ id: 'Co_A' }, { id: 'Co_B' }, { id: 'Co_C' }], plan: { day: 3, decided: true, assign: { 11: [['Co_A'], ['Co_B']], 9: [['Co_A'], ['Co_B', 'Co_A']] }, stats: {}, quest: {} } };
    // Before work: the morning's missions are all the game can hand out.
    await w.syncPlayer(c, 9 * 60 + 30);
    assert.equal(ids(), 'M_A');
    assert.equal(row.randomSelectMin, 1);
    assert.equal(w.view(c).people['9'].slots[0].quest, 'sent', 'the game still shows what it handed out before');
    executing = { m_A: { questInfo: { questId: 'Co_Quest_Working', questTask: { missionDtId: 'M_A' } } } };
    await w.drive(c, { day: 3, hour: 10, minute: 0 });
    assert.equal(w.view(c).people['9'].slots[0].quest, 'set');
    // Lunch: the afternoon's, both of them.
    await w.drive(c, { day: 3, hour: 12, minute: 30 });
    assert.equal(ids(), 'M_A/M_B');
    assert.equal(row.randomSelectMin, 2);
    w.steeredAt.clear();
    await w.drive(c, { day: 3, hour: 14, minute: 30 });
    assert.ok(set.indexOf('Co_A') >= 0 && set.indexOf('Co_B') >= 0, 'each slot its own work');
    // After work: the row as the game had it.
    await w.syncPlayer(c, 17 * 60 + 5);
    assert.equal(ids(), 'M_A/M_B/M_C');
    assert.equal(row.randomSelectMax, 2);
    fs.rmSync(root, { recursive: true, force: true });
});

test('a harder task asks for more skill and, finished, adds more to the project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
    const sent = [];
    let cur = { playing: true, interaction_bag_id: 'Co_Hard' };
    const d = {
        log: { info() {}, warn() {} },
        journal: { can: () => true },
        career: { request: (actor, op, arg, done) => { sent.push(actor + ' ' + op + ' ' + arg); done({ ok: true, detail: op === 'p' ? 'added_' + arg : 'set_1of1' }); } },
        world: { possessed: async () => '1', characterInfo: async () => null },
        game: { soft: async (n) => n === 'career_get_work_status' ? { is_at_work: true } : n === 'interaction_get_current' ? cur : null }
    };
    const { TIERS } = require('../lib/workplan');
    const w = new WorkPlan(d, { toast() {}, save() {} });
    w.configure(root);
    const c = { manager: '1', staff: { 11: {}, 12: {} }, catalogue: [{ skill: 'Instruments' }], workSlots: [{ from: 600, to: 720, label: '上午' }],
        workTasks: [{ id: 'Co_Easy', tier: 0, need: 0, bonus: TIERS[0].bonus }, { id: 'Co_Hard', tier: 2, need: 6, bonus: TIERS[2].bonus }],
        plan: { day: 3, decided: false, assign: {}, stats: {}, quest: {}, levels: { 11: 7, 12: 2 } } };
    fs.mkdirSync(path.join(root, 'plan'), { recursive: true });
    fs.writeFileSync(path.join(root, 'plan', 'answer.cfg'), JSON.stringify({ seq: Date.now(), player: '1', day: 3, assign: { 11: [['Co_Hard']], 12: [['Co_Hard', 'Co_Easy']] } }));
    w.takeAnswer(c, 3);
    assert.deepEqual(c.plan.assign['12'], [['Co_Easy']], 'short of the skill: not given the hard one');
    assert.deepEqual(c.plan.assign['11'], [['Co_Hard']]);
    c.plan.assign = { 11: [['Co_Hard']] };
    await w.drive(c, { day: 3, hour: 10, minute: 0 });
    await w.drive(c, { day: 3, hour: 10, minute: 15 });
    cur = { playing: false };
    await w.drive(c, { day: 3, hour: 10, minute: 16 });
    assert.ok(sent.includes('11 p ' + TIERS[2].bonus), 'finished: the hard task pays its points');
    const v = w.view(c).people['11'];
    assert.equal(v.bonus, TIERS[2].bonus);
    assert.equal(v.slots[0].tasks[0].done, 1);
    fs.rmSync(root, { recursive: true, force: true });
});

