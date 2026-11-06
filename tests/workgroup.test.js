'use strict';
// Offline tests for the company work group and the tasks its boss offers in it (lib/workgroup.js):
// who is in the group and who owns it, a task offered to the group and taken by the player's own
// reply, added in the game only then (or the one the game already gave), handed to a colleague or
// lapsing when nobody takes it, and how a taken task's end is read from the game's quest record.
// Everything is written under a temporary folder; no game, no API, no player data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkGroup, reflectedKey } = require('../lib/workgroup');

const log = { info() {}, warn() {}, debug() {} };
const NAMES = { 20522: ['宗', '会荣'], 19141: ['雅各布斯', '纳尔逊'], 19695: ['霍洛威', '约瑟夫'] };
const env = (day, hour, minute) => ({ day, hour, minute: minute || 0 });
const MISSIONS = {
    desc_Mission_Career_SoundCompany_01: '调查最新趋势（电脑 {GoalCount} 次）',
    desc_Mission_Career_SoundCompany_02: '构思新曲旋律（使用电脑 {GoalCount} 次）',
    desc_Mission_Career_SoundCompany_03: '校正音准（电脑 {GoalCount} 次）'
};

function setup(t, over) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workgroup-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const world = Object.assign({
        job: true, workday: true, working: true, quests: {}, running: [], addWorks: true, picks: null,
        roster: [{ id: '19141', rank: 4 }, { id: '19695', rank: 2 }, { id: '20522', rank: 3 }]
    }, over || {});
    const asked = [];
    const posts = [];
    const changes = [];
    const d = {
        log,
        journal: { can: (f) => f === 'career' || (f === 'mission' && world.mission !== false) },
        game: {
            async soft(tool, args) {
                if (tool === 'entity_get_character_info') {
                    const n = NAMES[args.entity_id];
                    return n ? { last_name: n[0], first_name: n[1] } : null;
                }
                if (tool === 'career_get_work_status') return { has_job: world.job, is_working_day: world.workday };
                if (tool === 'data_table_get' && args.Alias === 'Quest') {
                    // The company's work quest, beside the after-work one, unless the job has none.
                    if (args.Row === 'SoundCompany_Quest_Working' && !world.working) return null;
                    return { questList: [1, 2, 3].map((i) => ({ questTask: [{ missionDtId: 'Mission_Career_SoundCompany_0' + i }] })) };
                }
                if (tool === 'data_table_get' && args.Alias === 'Mission') {
                    return { conditions: [{ goalCount: 1, descTextId: 'desc_' + args.Row }] };
                }
                if (tool === 'l10n_get') {
                    const out = {};
                    for (const k of JSON.parse(args.Keys)) out[k] = MISSIONS[k] || k;
                    return out;
                }
                if (tool === 'entity_reflect' && args.Component === 'FB2QuestComponent') {
                    const executing = {};
                    // "Quest/Mission", or a bare mission of the game's own after-work quest.
                    for (const r of world.running) {
                        const [q, m] = r.indexOf('/') > 0 ? r.split('/') : ['SoundCompany_Quest', r];
                        executing[reflectedKey(m)] = { questInfo: { questId: q, questTask: { missionDtId: m } } };
                    }
                    return { todayQuestHistoryData: world.quests, executingQuestMap: executing };
                }
                return null;
            }
        },
        career: {
            async desk(id) {
                if (!world.job) return null;
                const me = world.roster.find((r) => r.id === id);
                const boss = world.roster.filter((r) => r.rank > me.rank).sort((a, b) => b.rank - a.rank)[0];
                return { companyId: '885', companyName: '节拍代码', roster: world.roster.slice(), bossId: boss ? boss.id : '', questIds: ['SoundCompany_Quest'] };
            },
            request(actor, op, arg, done) {
                asked.push({ actor, op, arg, done });
                // The game takes it (or not); the Lua mod's own check is not trusted either way.
                // The game picks the quest's mission itself (picks), or the one asked for.
                if (world.addWorks) world.running.push(world.picks ? arg.split('/')[0] + '/' + world.picks : arg);
            }
        },
        chatGroups: { metaCache: new Map(), states: new Map(), append(id, msg) { posts.push(Object.assign({ group: id }, msg)); return Object.assign({ id: 'g-' + posts.length }, msg); },
            state(id) { if (!this.states.has(id)) this.states.set(id, { queue: [] }); return this.states.get(id); }, saveState() {} },
        workplace: {
            style() { return 'strict'; },
            score() { return 50; },
            async change(p, c, delta, why) { changes.push({ p, c, delta, why }); }
        }
    };
    const w = new WorkGroup(d);
    w.configure(path.join(root, 'ui', 'phone'), path.join(root, 'data'));
    const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, 'ui', 'phone', rel), 'utf8'));
    // The player writes in the group, as the phone does.
    const say = (text) => {
        const file = path.join(root, 'ui', 'phone', 'groups', 'g-co885', 'outbox.cfg');
        let list = [];
        try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first line */ }
        list.push({ id: 'o' + list.length, from: '20522', text, at: Date.now() + 1 });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(list));
    };
    return { w, d, world, asked, posts, changes, read, say };
}

const settle = () => new Promise((r) => setTimeout(r, 900));

test('the company group: the payroll as members, the highest rank as owner, locked for the phone', async (t) => {
    const s = setup(t);
    const at = await s.w.sync('20522');
    assert.equal(at.id, 'co885');
    const meta = s.read('groups/g-co885/meta.cfg');
    assert.equal(meta.name, '节拍代码工作群');
    assert.equal(meta.owner, '19141');
    assert.deepEqual(meta.members.map((m) => m.id), ['19141', '20522', '19695']);
    assert.equal(meta.members[0].name, '雅各布斯纳尔逊');
    assert.equal(meta.company, true);
    assert.equal(meta.auto, false);
    assert.deepEqual(s.read('groups/company.cfg').groups.map((g) => g.id), ['co885']);
});

test('leaving the company takes the player out of its group, and the group closes when empty', async (t) => {
    const s = setup(t, { roster: [{ id: '20522', rank: 3 }] });
    await s.w.sync('20522');
    s.world.job = false;
    await s.w.sync('20522');
    const meta = s.read('groups/g-co885/meta.cfg');
    assert.deepEqual(meta.members, []);
    assert.equal(meta.closed, true);
    assert.deepEqual(s.read('groups/company.cfg').groups, []);
});

test('the boss asks the group who will take it; nothing is the player\'s, nor in the game, yet', async (t) => {
    const s = setup(t);
    await s.w.tick('20522', env(1021, 9));
    assert.equal(s.asked.length, 0, 'nothing added to the game');
    assert.equal(s.posts.length, 1);
    assert.equal(s.posts[0].from, '19141');
    assert.deepEqual(s.posts[0].to, [], 'nobody is named');
    assert.match(s.posts[0].text, /^今天「(调查最新趋势|构思新曲旋律|校正音准)」谁来做一下？$/);
    assert.equal(s.read('oa/tasks.cfg').list[0].state, 'offered');
    // One offer a day.
    await s.w.tick('20522', env(1021, 10));
    assert.equal(s.posts.length, 1);
});

test('the player\'s "我来" takes it: added in the game, confirmed by the boss, followed to its end', async (t) => {
    const s = setup(t);
    await s.w.tick('20522', env(1021, 9));
    s.say('我來吧');
    await s.w.tick('20522', env(1021, 9, 5));
    assert.equal(s.asked.length, 1);
    assert.match(s.asked[0].arg, /^SoundCompany_Quest_Working\/Mission_Career_SoundCompany_0[123]$/);
    // The Lua mod's own check said no; the game's quest record says it is there.
    s.asked[0].done({ ok: false, detail: 'not_added' });
    await settle();
    assert.equal(s.read('oa/tasks.cfg').list[0].state, 'given');
    assert.deepEqual(s.posts[1].to, ['20522']);
    assert.match(s.posts[1].text, /^好，@会荣 「.+」交给你了，下班前给我。$/);
    const mission = s.asked[0].arg.split('/')[1];
    s.world.quests = { soundCompany_Quest_Working: { historyElementMap: { [reflectedKey(mission)]: { isSuccess: true } } } };
    await s.w.tick('20522', env(1021, 15));
    assert.equal(s.read('oa/tasks.cfg').list[0].state, 'done');
    assert.equal(s.changes[0].delta, 5);
    assert.match(s.posts[2].text, /收到了，不错/);
});

test('a task is always a new mission: never one running, done or failed today', async (t) => {
    const s = setup(t, {
        running: ['Mission_Career_SoundCompany_01'],
        quests: { soundCompany_Quest: { historyElementMap: { mission_Career_SoundCompany_03: { isFail: true } } } }
    });
    await s.w.tick('20522', env(1021, 9));
    assert.match(s.posts[0].text, /构思新曲旋律/);
    s.say('交给我');
    await s.w.tick('20522', env(1021, 9, 5));
    assert.equal(s.asked[0].arg, 'SoundCompany_Quest_Working/Mission_Career_SoundCompany_02');
    // All of them taken today: no offer at all.
    const full = setup(t, { running: ['Mission_Career_SoundCompany_01', 'Mission_Career_SoundCompany_02', 'Mission_Career_SoundCompany_03'] });
    await full.w.tick('20522', env(1021, 9));
    assert.equal(full.posts.length, 0);
    // A job without a work quest: the after-work one.
    const old = setup(t, { working: false });
    await old.w.tick('20522', env(1021, 9));
    old.say('我来');
    await old.w.tick('20522', env(1021, 9, 5));
    assert.match(old.asked[0].arg, /^SoundCompany_Quest\//);
});

test('the game picks the mission itself: the one it gave is the task', async (t) => {
    const s = setup(t, { picks: 'Mission_Career_SoundCompany_03', running: ['Mission_Career_SoundCompany_03'] });
    await s.w.tick('20522', env(1021, 9));
    s.say('我来');
    await s.w.quick('20522', env(1021, 9, 1));
    assert.equal(s.asked.length, 1, 'taken within seconds, without waiting for the minute');
    s.asked[0].done({ ok: false, detail: 'not_added' });
    await settle();
    const task = s.read('oa/tasks.cfg').list[0];
    assert.equal(task.state, 'given');
    assert.match(task.text, /校正音准/);
    assert.match(s.posts[1].text, /「校正音准」交给你了/);
});

test('a task called off that the game added after all is given back, with a correction', async (t) => {
    const s = setup(t, { addWorks: false });
    await s.w.tick('20522', env(1021, 9));
    s.say('我来');
    await s.w.tick('20522', env(1021, 9, 5));
    s.asked[0].done({ ok: true, detail: 'added' });
    await new Promise((r) => setTimeout(r, 3800));
    assert.match(s.posts[1].text, /先不用了/);
    s.world.running.push('SoundCompany_Quest_Working/Mission_Career_SoundCompany_02');
    await s.w.tick('20522', env(1021, 10));
    assert.equal(s.read('oa/tasks.cfg').list[0].state, 'given');
    assert.match(s.posts[2].text, /刚才说错了，「构思新曲旋律」还是你来/);
});

test('a task called off that the player has already done in the game is credited, not corrected', async (t) => {
    const s = setup(t, { addWorks: false });
    await s.w.tick('20522', env(1021, 9));
    s.say('我来');
    await s.w.tick('20522', env(1021, 9, 5));
    s.asked[0].done({ ok: true, detail: 'added' });
    await new Promise((r) => setTimeout(r, 3800));
    s.world.quests = { soundCompany_Quest_Working: { historyElementMap: { mission_Career_SoundCompany_05: { isSuccess: true } } } };
    await s.w.tick('20522', env(1021, 10));
    assert.equal(s.read('oa/tasks.cfg').list[0].state, 'done');
    assert.equal(s.posts.length, 3, 'call-off, then thanks; no correction');
    assert.match(s.posts[2].text, /收到了/);
});

test('a mission the game did not take: the boss calls it off, nothing is held against the player', async (t) => {
    const s = setup(t, { addWorks: false });
    await s.w.tick('20522', env(1021, 9));
    s.say('我可以');
    await s.w.tick('20522', env(1021, 9, 5));
    s.asked[0].done({ ok: true, detail: 'added' });
    await new Promise((r) => setTimeout(r, 3800));
    assert.equal(s.read('oa/tasks.cfg').list.length, 0, 'not shown as a task');
    assert.match(s.posts[1].text, /先不用了/);
    assert.equal(s.changes.length, 0);
});

test('turning it down, or saying nothing, costs nothing; on a work day a colleague gets it', async (t) => {
    const no = setup(t);
    await no.w.tick('20522', env(1021, 9));
    no.say('今天没空');
    await no.w.tick('20522', env(1021, 9, 5));
    assert.equal(no.read('oa/tasks.cfg').list[0].state, 'declined');
    assert.equal(no.asked.length, 0);
    const quiet = setup(t);
    await quiet.w.tick('20522', env(1021, 9));
    await quiet.w.tick('20522', env(1021, 11, 59));
    assert.equal(quiet.read('oa/tasks.cfg').list[0].state, 'offered', 'still open');
    await quiet.w.tick('20522', env(1021, 12, 0));
    const shown = quiet.read('oa/tasks.cfg').list[0];
    assert.equal(shown.state, 'handed');
    assert.equal(shown.taker, '霍洛威约瑟夫');
    assert.match(quiet.posts[1].text, /^那 @约瑟夫 你来吧。$/);
    // The colleague the boss named answers the boss's line in the group.
    const reply = quiet.d.chatGroups.state('co885').queue.find((q) => q.kind === 'duty');
    assert.ok(reply && reply.duty, 'a reply is queued');
    assert.equal(reply.from, quiet.posts[1].to[0]);
    assert.equal(reply.replyTo, 'g-2');
    assert.equal(quiet.changes.length, 0);
});

test('on a day off the offer is optional: it lapses quietly, and done it earns a little goodwill', async (t) => {
    const s = setup(t, { workday: false });
    await s.w.tick('20522', env(1021, 13));
    assert.match(s.posts[0].text, /今天休息，谁有空可以把「.+」做一下？不强求。/);
    assert.equal(s.read('oa/tasks.cfg').list[0].optional, true);
    await s.w.tick('20522', env(1021, 16, 0));
    assert.equal(s.read('oa/tasks.cfg').list[0].state, 'lapsed');
    assert.equal(s.posts.length, 1, 'nobody is handed an optional one');
    const d = setup(t, { workday: false });
    await d.w.tick('20522', env(1021, 13));
    d.say('我来');
    await d.w.tick('20522', env(1021, 13, 5));
    d.asked[0].done({ ok: true, detail: 'added' });
    await settle();
    const mission = d.asked[0].arg.split('/')[1];
    d.world.quests = { soundCompany_Quest_Working: { historyElementMap: { [reflectedKey(mission)]: { isSuccess: true } } } };
    await d.w.tick('20522', env(1021, 15));
    assert.equal(d.changes[0].delta, 4);
    assert.match(d.changes[0].why, /^休息日主动做了「/);
    // An optional one taken and left undone costs nothing either.
    const left = setup(t, { workday: false });
    await left.w.tick('20522', env(1021, 13));
    left.say('我来');
    await left.w.tick('20522', env(1021, 13, 5));
    left.asked[0].done({ ok: true, detail: 'added' });
    await settle();
    await left.w.tick('20522', env(1022, 6));
    assert.equal(left.read('oa/tasks.cfg').list[0].state, 'missed');
    assert.equal(left.changes.length, 0);
});

test('a work-day task the player took and left undone is held against them', async (t) => {
    const s = setup(t);
    await s.w.tick('20522', env(1021, 9));
    s.say('好的，我来');
    await s.w.tick('20522', env(1021, 9, 5));
    s.asked[0].done({ ok: true, detail: 'added' });
    await settle();
    await s.w.tick('20522', env(1022, 6));
    assert.equal(s.read('oa/tasks.cfg').list[0].state, 'missed');
    assert.equal(s.changes[0].delta, -4);
    assert.match(s.changes[0].why, /^接了没做完「/);
});

test('no offer outside the hours, for the top of the company, or while the Lua mod cannot add missions', async (t) => {
    const late = setup(t);
    await late.w.tick('20522', env(1021, 22));
    assert.equal(late.posts.length, 0);
    const top = setup(t, { roster: [{ id: '20522', rank: 4 }, { id: '19695', rank: 2 }] });
    await top.w.tick('20522', env(1021, 9));
    assert.equal(top.posts.length, 0);
    const old = setup(t, { mission: false });
    await old.w.tick('20522', env(1021, 9));
    assert.equal(old.posts.length, 0);
});

test('reflected keys start in lower case', () => {
    assert.equal(reflectedKey('SoundCompany_Quest'), 'soundCompany_Quest');
    assert.equal(reflectedKey('Mission_Career_SoundCompany_06'), 'mission_Career_SoundCompany_06');
});
