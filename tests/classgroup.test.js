'use strict';
// The class chat (lib/classgroup.js): who is in it, its name, the topics classmates open, its
// pace in groups.js, and the class rules in the group prompt.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClassGroup, classmates, className, topicFor, PACE } = require('../lib/classgroup');
const { Groups, autoAllowance } = require('../lib/groups');
const persona = require('../lib/persona');

const me = { entity_id: 20524, first_name: '亚廷', last_name: '钟', gender: 'Female', age_group: 'HighTeen', household_id: 20520, current_site: '永成学校主楼' };
const kid = (id, extra) => Object.assign({ entity_id: id, first_name: 'K' + id, last_name: '白', gender: 'Male', age_group: 'HighTeen', household_id: id + 1, relationship_label: '…' }, extra || {});

test('classmates are the phone contacts at the player\'s own stage, not family, school first', () => {
    const list = classmates(me, [
        kid(1, { age_group: 'LowTeen' }),
        kid(2, { age_group: 'Youth' }),
        kid(3, { household_id: 20520 }),
        kid(4, { relationship_label: '表哥' }),
        kid(5, { blocked: true }),
        kid(6),
        kid(7, { current_site: '永成学校主楼', gender: 'Female' })
    ]);
    assert.deepStrictEqual(list.map((c) => c.entity_id), [7, 6]);
    const many = Array.from({ length: 12 }, (_, i) => kid(100 + i));
    assert.strictEqual(classmates(me, many).length, 7);
    assert.deepStrictEqual(classmates(Object.assign({}, me, { age_group: 'Youth' }), many), []);
});

test('the class is named by stage, the same every time', () => {
    assert.match(className(me), /^高二\(\d\)班$/);
    assert.strictEqual(className(me), className(Object.assign({}, me)));
    assert.match(className(Object.assign({}, me, { age_group: 'LowTeen' })), /^初二/);
    assert.strictEqual(className(Object.assign({}, me, { age_group: 'Child' })), '');
});

test('topics follow the school day and can pull the player in', () => {
    assert.match(topicFor(7, '', () => 0), /迟到|作业|早餐|起不来/);
    assert.match(topicFor(17, '', () => 0), /放学|奶茶|补习|回家|值日/);
    assert.match(topicFor(21, '亚廷', () => 0.999), /@亚廷/);
});

test('a class chat is livelier than a family group', () => {
    const g = new Groups({ cfg: { groups: { silence_chance: 0.35, max_auto_per_hour: 6, auto_gap_min_ms: 25000 }, mailbox: { dir: os.tmpdir() } }, log: { info() {}, warn() {} } });
    const pace = g.paceOf({ pace: PACE });
    assert.ok(pace.silence_chance < 0.35);
    assert.ok(pace.max_auto_per_hour > 6);
    assert.ok(pace.auto_gap_min_ms < 25000);
    assert.ok(pace.max_replies_per_turn >= 3);
    assert.strictEqual(g.paceOf({}).silence_chance, 0.35);
});

test('the meta read back keeps the class kind and its pace, and drops junk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cls-'));
    const g = new Groups({ cfg: { groups: { dir }, mailbox: { dir } }, log: { info() {}, warn() {} } });
    g.configure(dir);
    fs.mkdirSync(path.join(dir, 'g-cls1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'g-cls1', 'meta.cfg'), JSON.stringify({
        v: 1, id: 'cls1', name: '高二(3)班', owner: '7', members: [{ id: '1' }, { id: '7' }],
        kind: 'class', pace: Object.assign({}, PACE, { silence_chance: 'x', bogus: 5 })
    }));
    const meta = g.meta('cls1');
    assert.strictEqual(meta.kind, 'class');
    assert.strictEqual(meta.pace.max_auto_per_hour, PACE.max_auto_per_hour);
    assert.strictEqual(meta.pace.silence_chance, undefined);
    assert.strictEqual(meta.pace.bogus, undefined);
    assert.deepStrictEqual(meta.pace.quiet_game_hours, [1, 6]);
});

test('the group prompt is loud in a class chat and quiet with the family', () => {
    const input = (kind, job) => ({
        snap: {
            role: 'friend', outsider: true, label: '', env: { day: 3, hour: 20, minute: 0 },
            player: { name: '钟亚廷', firstName: '亚廷', gender: 'Female', ageGroup: 'HighTeen' },
            partner: { entity_id: 7, id: '7', name: '白大煐', firstName: '大煐', gender: 'Male', ageGroup: 'HighTeen', activity: {}, work: {} }
        },
        cfg: { reply: { max_bubbles: 3, bubble_max_chars: 40 } },
        group: { name: '高二(3)班', kind },
        roster: [],
        history: [],
        job: job || { kind: 'auto' }
    });
    const cls = persona.groupPrompt(input('class', { kind: 'auto', topic: '对一下今天的作业答案' }));
    assert.match(cls.system, /班级群/);
    assert.match(cls.system, /起哄/);
    assert.doesNotMatch(cls.system, /有爸妈、长辈在的群里话更少/);
    assert.match(cls.user, /起个话头：对一下今天的作业答案/);
    const fam = persona.groupPrompt(input(''));
    assert.doesNotMatch(fam.system, /班级群/);
    assert.match(fam.system, /有爸妈、长辈在的群里话更少/);
});

// ---------------------------------------------------------------- the module, against a fake game
function fake(dir, contacts, player) {
    const queued = {};
    const d = {
        log: { info() {}, warn() {}, debug() {} },
        cfg: { mode: 'auto' },
        llm: { configured: true },
        world: {
            phase: async () => 'in_game',
            possessed: async () => '20524',
            household: async () => ({ members: [player || me] }),
            phoneContacts: async () => contacts
        },
        game: { soft: async (name) => (name === 'environment_get_state' ? d.env : null) },
        env: { day: 4, hour: 20 },
        chatGroups: {
            enabled: true,
            metaCache: new Map(),
            state: (id) => queued[id] || (queued[id] = { queue: [], recent: [], lastAt: 0 }),
            saveState: (id, st) => { queued[id] = st; }
        }
    };
    const c = new ClassGroup(d);
    c.configure(path.join(dir, 'phone'), path.join(dir, 'data'));
    return { d, c, queued };
}

test('the class chat is made, opens a topic, and closes when the player grows up', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cls-'));
    const { d, c, queued } = fake(dir, [kid(7, { current_site: '永成学校主楼' }), kid(8)]);
    await c.tick();
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'phone', 'groups', 'g-cls20524', 'meta.cfg'), 'utf8'));
    assert.strictEqual(meta.kind, 'class');
    assert.strictEqual(meta.owner, '7');
    assert.deepStrictEqual(meta.members.map((m) => m.id), ['20524', '7', '8']);
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'phone', 'groups', 'school.cfg'), 'utf8'));
    assert.strictEqual(index.groups[0].id, 'cls20524');
    // Never spoken in: a topic goes out at once, from a classmate, never the player.
    const q = queued.cls20524.queue;
    assert.strictEqual(q.length, 1);
    assert.ok(q[0].topic);
    assert.notStrictEqual(q[0].from, '20524');
    // Quiet hours: nothing new.
    queued.cls20524.queue = [];
    queued.cls20524.lastAt = 0;
    d.env = { day: 5, hour: 3 };
    await c.tick();
    assert.strictEqual(queued.cls20524.queue.length, 0);
    // Grown up: closed.
    d.world.household = async () => ({ members: [Object.assign({}, me, { age_group: 'Youth' })] });
    c.syncedAt.clear();
    await c.tick();
    const closed = JSON.parse(fs.readFileSync(path.join(dir, 'phone', 'groups', 'g-cls20524', 'meta.cfg'), 'utf8'));
    assert.strictEqual(closed.closed, true);
});

test('no class chat with fewer than two classmates, or for a child', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cls-'));
    const a = fake(dir, [kid(7)]);
    await a.c.tick();
    assert.ok(!fs.existsSync(path.join(dir, 'phone', 'groups', 'g-cls20524')));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cls-'));
    const b = fake(dir2, [kid(7, { age_group: 'Child' }), kid(8, { age_group: 'Child' })], Object.assign({}, me, { age_group: 'Child' }));
    await b.c.tick();
    assert.ok(!fs.existsSync(path.join(dir2, 'phone', 'groups', 'g-cls20524')));
});

test('the class keeps its monitor and order when classmates move around, and never speaks for the player', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cls-'));
    const contacts = [kid(7, { current_site: '永成学校主楼' }), kid(8)];
    const { c } = fake(dir, contacts);
    await c.tick();
    contacts[0].current_site = '公园';
    contacts[1].current_site = '永成学校主楼';
    contacts.push(kid(9, { current_site: '永成学校主楼' }));
    c.syncedAt.clear();
    await c.tick();
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'phone', 'groups', 'g-cls20524', 'meta.cfg'), 'utf8'));
    assert.strictEqual(meta.owner, '7');
    assert.deepStrictEqual(meta.members.map((m) => m.id), ['20524', '7', '8', '9']);
    assert.strictEqual(meta.player, '20524');
    // groups.js never ranks the class's own player to speak.
    const g = new Groups({ cfg: { groups: { dir: path.join(dir, 'phone', 'groups') }, mailbox: { dir } }, log: { info() {}, warn() {} } });
    g.configure(dir);
    const read = g.meta('cls20524');
    assert.strictEqual(read.player, '20524');
    for (let i = 0; i < 20; i++) assert.ok(g.rank(read, { recent: [] }, '', Date.now(), []).indexOf('20524') < 0);
});

test('lines nobody asked for are spread over the hour, after a burst', () => {
    // The class: 30 an hour, 6 at once, then about one every two minutes.
    assert.strictEqual(autoAllowance(PACE, 0), 6);
    assert.strictEqual(autoAllowance(PACE, 15 * 60000), 12);
    assert.strictEqual(autoAllowance(PACE, 30 * 60000), 18);
    assert.strictEqual(autoAllowance(PACE, 60 * 60000), 30);
    assert.strictEqual(autoAllowance(PACE, 3 * 3600000), 30);
    // A family group: 6 an hour, 2 at once.
    assert.strictEqual(autoAllowance({ max_auto_per_hour: 6 }, 0), 2);
    assert.strictEqual(autoAllowance({ max_auto_per_hour: 6 }, 3600000), 6);
});

test('the group holds back once the allowance for this point of the hour is used', () => {
    const g = new Groups({ cfg: { groups: {}, mailbox: { dir: os.tmpdir() } }, log: { info() {}, warn() {} }, gameNow: () => null });
    const meta = { auto: true, pace: Object.assign({}, PACE, { auto_chance: 1, auto_chance_stale: 1 }) };
    const now = Date.now();
    const st = (used, startedAgoMin) => ({ lastFrom: '7', lastAt: now - 20000, queue: [], budgetStart: now - startedAgoMin * 60000, budget: used, autoBudget: used });
    assert.strictEqual(g.canAuto(meta, st(5, 1), now), true);
    // Six already, two minutes into the hour: wait.
    assert.strictEqual(g.canAuto(meta, st(6, 2), now), false);
    // Same six, half an hour in: room again.
    assert.strictEqual(g.canAuto(meta, st(6, 30), now), true);
});
