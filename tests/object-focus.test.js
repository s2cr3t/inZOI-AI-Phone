'use strict';
// Offline regression tests: no game connection, API requests, or writes to player data.
const test = require('node:test');
const assert = require('node:assert/strict');
const focus = require('../lib/object-focus');
const { Actions, arrangePlan, TakenError } = require('../lib/actions');
const { Daemon } = require('../lib/daemon');
const { LlmError } = require('../lib/llm');
const { GameToolError } = require('../lib/game');

const log = { info() {}, warn() {}, debug() {} };
const play = { id: 'Object_ClawMachineA_Play', name: '试玩抓娃娃机' };
const machine = { id: '701', name: '小鸡玩偶抓娃娃机', meters: 20, actions: [play] };
const social = { type: 'interact', interaction: { id: 'Co_Child_Friendship_R09', name: '称赞零食' } };
const use = { type: 'use_object', objectId: '701', objectName: machine.name, interaction: play, want: '抓一个小鸡玩偶' };
const pair = { key: '20522-20524', partnerId: '20524', playerId: '20522' };
function snapshot() {
    return { role: 'child', player: { id: '20522', name: '宗会荣', gender: 'Female', site: '中央公园' },
        partner: { id: '20524', name: '钟亚廷', gender: 'Female', ageGroup: 'Child', site: '中央公园', activity: { idle: true } }, others: [], env: { day: 1, hour: 10, minute: 0 } };
}
function catalog() {
    return { allowed: new Set(['use_object', 'interact', 'stop_current', 'go_together']), objects: [machine], more: [],
        player: [social.interaction], members: {}, places: [], facial: [], chores: [], sameSite: true, objectSource: 'live' };
}
function active() {
    return { id: 'target-1', at: Date.now(), query: '宝贝，前面有个抓娃娃机，要去试试吗', site: '中央公园',
        status: 'found', candidates: [machine], inspect: false };
}
function harness() {
    const d = Object.create(Daemon.prototype);
    const st = {};
    d.log = log;
    d.objectFocus = new Map();
    d.state = { pair: () => st, save() {} };
    d.cfg = { actions: { max_per_reply: 4, max_object_actions: 6, want_objects: 6 } };
    d.actionsCfg = () => d.cfg.actions;
    d.actions = new Actions({}, {}, log);
    d.actions.freshObjectActions = async () => [play];
    d.llm = { json: async () => { throw new Error('unexpected model request'); } };
    return { d, st };
}

test('category/partial names find both nearby machine variants without an alias table', () => {
    const objects = [machine, { id: '702', name: '波奇玩偶抓娃娃机', meters: 4 }, { id: '703', name: '吧台椅', meters: 1 }];
    for (const q of ['抓娃娃', '娃娃机', '前面有个抓娃娃机，要去试试吗']) {
        assert.deepEqual(focus.rank(q, objects).map((r) => r.object.id), ['702', '701']);
    }
});
test('exact name beats a closer category match', () => {
    assert.equal(focus.rank('有个小鸡玩偶抓娃娃机', [machine, { id: '702', name: '波奇玩偶抓娃娃机', meters: 1 }])[0].object.id, '701');
});
test('the actual typo and later pronoun questions retain the original goal', () => {
    for (const text of ['宝贝能找到娃娃机嘛', '看到了麻宝贝', '宝贝现在能看到嘛']) {
        const next = focus.next(active(), text, '中央公园', true, Date.now());
        assert.equal(next.query, active().query);
        assert.equal(next.inspect, true);
    }
});
test('correction ranks its positive half, not the rejected activity', () => {
    const ranked = focus.rank('不是拍照啦，是抓娃娃哦', [machine, { id: '704', name: '拍照啦地标' }]);
    assert.deepEqual(ranked.map((r) => r.object.id), ['701']);
});
test('new unrelated topics and cancellation discard the old reference', () => {
    for (const text of ['今天上学开心吗', '算了', '别玩娃娃机了']) assert.equal(focus.next(active(), text, '中央公园', false, Date.now()), null);
});
test('changing site drops old candidate IDs and an expired goal cannot bind a pronoun', () => {
    const moved = focus.next(active(), '看到了吗', '家', false, Date.now());
    assert.deepEqual(moved.candidates, []);
    assert.equal(moved.status, 'looking');
    const stale = focus.next(Object.assign(active(), { at: 1 }), '看到了吗', '中央公园', false, Date.now());
    assert.equal(stale, null);
});
test('explicit repetition is a fresh request', () => {
    const next = focus.next(Object.assign(active(), { status: 'done' }), '再玩一次抓娃娃机', '中央公园', true, Date.now());
    assert.equal(next.followup, false);
    assert.equal(next.status, 'looking');
});
test('scanned objects without actions, including failed queries, remain discoverable', async () => {
    const a = new Actions({}, {}, log);
    a.scanObjects = async () => [machine, { id: '702', name: '新模组物件', meters: 1 }, { id: '703', name: '桌子', meters: 2 }];
    a.objectActions = async (_, id) => { if (id === '702') throw new GameToolError('menu', 'busy'); return []; };
    const c = await a.nearbyObjects('20524', 'Child', { max_objects_listed: 2 }, {});
    assert.equal(c.objects.length, 0);
    assert.deepEqual(c.more.map((o) => o.id), ['701', '702', '703']);
    assert.equal(c.more[1].error, true);
});
test('focus lookup promotes distant objects, keeps catalog cache unchanged, and bounds reads', async () => {
    const a = new Actions({}, {}, log);
    const calls = [];
    a.freshObjectActions = async (_, id) => { calls.push(id); return [play]; };
    const c = Object.assign(catalog(), { objects: [], more: Array.from({ length: 12 }, (_, i) => Object.assign({}, machine, { id: String(i + 700) })) });
    const out = await a.focusCatalog('20524', 'Child', c, a.focusMatches('娃娃机', c, 'Child'), '娃娃机', { max_object_actions: 6 });
    assert.equal(calls.length, 6);
    assert.equal(out.catalog.objects.length, 6);
    assert.equal(c.objects.length, 0);
    assert.equal(c.more.length, 12);
});
test('failed menu reads are reported as unread, never a confirmed lack of actions', async () => {
    const a = new Actions({}, {}, log);
    a.freshObjectActions = async () => { throw new GameToolError('menu', 'timeout'); };
    const out = await a.focusCatalog('20524', 'Child', catalog(), [{ object: machine }], '抓娃娃', {});
    assert.equal(out.candidates[0].error, true);
    assert.equal(out.catalog.objects.length, 0);
    assert.match(focus.prompt(Object.assign(active(), { candidates: out.candidates })), /查询失败/);
});
test('live age restrictions survive focus promotion', async () => {
    const a = new Actions({ call: async () => ({ interactions: [
        { interaction_bag_id: 'Cook_Soup', display_name: '煮汤', enabled: true },
        { interaction_bag_id: play.id, display_name: play.name, enabled: true }
    ] }) }, {}, log);
    const out = await a.focusCatalog('20524', 'Child', catalog(), [{ object: machine }], '抓娃娃', {});
    assert.deepEqual(out.candidates[0].actions.map((x) => x.id), [play.id]);
});
test('menu API failure propagates instead of being cached as an empty menu', async () => {
    const a = new Actions({ call: async () => { throw new GameToolError('menu', 'unavailable'); } }, {}, log);
    await assert.rejects(a.allObjectActions('20524', '701', 'Child'), GameToolError);
    assert.equal(a.listCache.size, 0);
});
test('missing pair regression: repaired action uses the actual pair and retains deferred agreements', async () => {
    const { d } = harness();
    let seen;
    d.actionsCfg = (p) => { seen = p; return { max_per_reply: 4 }; };
    d.llm.json = async () => ({ why: '眼前有抓娃娃机', actions: [{ type: 'use_object', object_id: '701', interaction_id: play.id }] });
    const repaired = await d.repairActions(pair, { steps: [], later: [{ what: '晚点回家' }] }, snapshot(), catalog(), ['我这就去抓娃娃'], [], '抓娃娃');
    assert.equal(seen, pair);
    assert.equal(repaired.failure, null);
    assert.equal(repaired.plan.steps[0].interaction.id, play.id);
    assert.equal(repaired.plan.later[0].what, '晚点回家');
});
test('repair failures remain distinct from no matching object', async () => {
    const { d } = harness();
    for (const error of [new ReferenceError('pair is not defined'), new LlmError('timeout', 'timeout')]) {
        d.llm.json = async () => { throw error; };
        const r = await d.repairActions(pair, { steps: [] }, snapshot(), catalog(), ['我去试试'], [], '抓娃娃');
        assert.ok(['internal_error', 'model_error'].includes(r.failure.code));
        assert.match(r.failure.why, /没有确认东西不存在/);
    }
});
test('empty repair response is an invalid model response, not no available object', async () => {
    const { d } = harness(); d.llm.json = async () => ({});
    const r = await d.repairActions(pair, { steps: [] }, snapshot(), catalog(), [], [], '抓娃娃');
    assert.equal(r.failure.code, 'model_error');
});
test('observational replies never create new work even if the model proposes it', async () => {
    const { d, st } = harness();
    st.follow = { focusId: 'target-1', steps: [use] };
    const snap = snapshot(); snap.objectFocus = Object.assign(active(), { inspect: true });
    const plan = await d.planActions(pair, snap, catalog(), { actions: [use], promises: [{ do: '抓娃娃', when: 'now' }] }, ['我再去抓'], [{ text: '看到了吗' }], false);
    assert.deepEqual(plan.steps, []);
    assert.equal(st.follow.steps[0], use);
});
test('the exact log conversation is grounded before replies without extra LLM calls', async () => {
    const { d } = harness();
    const c = Object.assign(catalog(), { objects: [], more: [Object.assign({}, machine, { actions: undefined })] });
    for (const text of ['宝贝，前面有个抓娃娃机，要去试试吗', '宝贝能找到娃娃机嘛', '看到了麻宝贝', '不是拍照啦，是抓娃娃哦', '宝贝现在能看到嘛', '有个小鸡玩偶抓娃娃机']) {
        const snap = snapshot();
        const out = await d.prepareObjectFocus(pair, snap, c, [{ text }]);
        assert.equal(out.objects[0].id, '701', text);
        assert.equal(snap.objectFocus.candidates[0].actions[0].id, play.id, text);
        assert.doesNotMatch(snap.objectFocus.query, /^看到了麻宝贝$/, text);
    }
});
test('a synonym uses one read-only semantic lookup and rejects invented IDs', async () => {
    const { d } = harness(); let calls = 0;
    const instrument = { id: '705', name: '合成器', actions: [] };
    d.wantObjectMap = async () => [instrument];
    d.llm.json = async () => { calls++; return { object_ids: ['705', '999', '705'] }; };
    const snap = snapshot();
    await d.prepareObjectFocus(pair, snap, Object.assign(catalog(), { objects: [], more: [instrument] }), [{ text: '找一下电子琴' }]);
    assert.equal(calls, 1);
    assert.deepEqual(snap.objectFocus.candidates.map((o) => o.id), ['705']);
});
test('changing target drops only the old goal-owned queue', async () => {
    const { d, st } = harness();
    d.objectFocus.set(pair.key, active());
    st.follow = { focusId: 'target-1', steps: [use] };
    const snap = snapshot();
    await d.prepareObjectFocus(pair, snap, Object.assign(catalog(), { more: [{ id: '706', name: '零食自动售货机', meters: 2 }] }), [{ text: '能找到自动售货机嘛' }]);
    assert.equal(st.follow, undefined);
    assert.equal(snap.objectFocus.query, '能找到自动售货机嘛');
});
test('cancellation never discards an unrelated protected plan', async () => {
    const { d, st } = harness(); d.objectFocus.set(pair.key, active());
    const other = { steps: [{ type: 'use_object', want: '把饭端到桌上' }] };
    st.follow = other;
    await d.prepareObjectFocus(pair, snapshot(), catalog(), [{ text: '别玩娃娃机了' }]);
    assert.equal(st.follow, other);
    assert.equal(d.objectFocus.has(pair.key), false);
});
test('player takeover discards a goal-owned queue instead of restarting it later', async () => {
    const { d, st } = harness(); d.objectFocus.set(pair.key, active());
    st.follow = { actorId: '20524', focusId: 'target-1', steps: [use] };
    await d.advanceFollow(pair.key, st, '20524');
    assert.equal(st.follow, undefined);
    assert.equal(d.objectFocus.has(pair.key), false);
});
test('only confirmed matching completion marks this goal done', () => {
    const { d } = harness(); const f = Object.assign(active(), { task: { objectId: '701', bagId: play.id } });
    d.objectFocus.set(pair.key, f);
    d.noteFinished = () => {}; d.learnFrom = () => {};
    d.onVerdict({ key: pair.key, actorId: '20524', confirmed: true, hold: { bagId: 'Co_Child_Friendship_R09', targetId: '20522' } }, { verdict: 'unknown' });
    assert.equal(f.status, 'found');
    d.onVerdict({ key: pair.key, actorId: '20524', confirmed: true, hold: { bagId: play.id, targetId: '701' } }, { verdict: 'unknown' });
    assert.equal(f.status, 'done');
});
test('accepted object task omits incidental praise but explicit sequences are preserved', () => {
    assert.deepEqual(focus.prioritize([social, use], active(), '抓娃娃', [{ text: '去抓娃娃吧' }], ['我这就去']), [use]);
    const ordered = [social, use];
    assert.equal(focus.prioritize(ordered, active(), '抓娃娃', [{ text: '先夸妈妈，再去抓娃娃' }], []), ordered);
});
test('inventory dependencies and multi-object tasks keep their order', () => {
    for (const steps of [[social, Object.assign({}, use, { after: {} })], [social, use, Object.assign({}, use, { objectId: '702' })]]) {
        assert.equal(focus.prioritize(steps, active(), '抓娃娃', [], ['我这就去']), steps);
    }
});
test('immediate leisure can yield; meals, sleep, school and explicit waiting cannot', () => {
    for (const id of ['Sit_BarStool01', 'Self_Child_Hopscotch', 'Self_Karma_Farting']) {
        assert.equal(focus.interruptIdle({ id }, active(), '抓娃娃', [], ['我这就去'], [use]), true);
    }
    for (const id of ['Eat_Food', 'Sleep_Bed', 'School', 'Shower']) {
        assert.equal(focus.interruptIdle({ id }, active(), '抓娃娃', [], ['我这就去'], [use]), false);
    }
    assert.equal(focus.interruptIdle({ id: 'Sit_BarStool01' }, active(), '抓娃娃', [{ text: '吃完再去' }], ['我这就去'], [use]), false);
    assert.equal(focus.interruptIdle({ id: 'Sit_BarStool01', scheduled: true }, active(), '抓娃娃', [], ['我这就去'], [use]), false);
});
test('existing scheduler protects carrying meals and school even with stop_current', () => {
    const steps = [{ type: 'stop_current' }, use];
    for (const ctx of [{ activity: { id: 'School', scheduled: true } }, { activity: { id: 'Carry_Meal' }, carrying: true }]) {
        const p = arrangePlan(steps, ctx);
        assert.equal(p.wait, true);
        assert.deepEqual(p.now, []);
        assert.deepEqual(p.later, [use]);
    }
});
test('a spatial anchor is not selected as the requested object', async () => {
    const { d } = harness(); let calls = 0;
    const computer = { id: '705', name: '电脑', actions: [] };
    const instrument = { id: '706', name: '合成器', actions: [] };
    d.wantObjectMap = async () => [computer, instrument];
    d.llm.json = async () => { calls++; return { object_ids: ['706'] }; };
    const snap = snapshot();
    await d.prepareObjectFocus(pair, snap, Object.assign(catalog(), { objects: [], more: [computer, instrument] }), [{ text: '找电脑旁边的电子琴' }]);
    assert.equal(calls, 1);
    assert.deepEqual(snap.objectFocus.candidates.map((o) => o.id), ['706']);
});
test('queued target is checked again before executing; changing site or menu prevents execution', async () => {
    const a = new Actions({}, { sites: async () => ({}) }, log);
    a.scheduleHold = async () => null;
    a.freshObjectActions = async () => [];
    const step = Object.assign({}, use, { focusId: 'target-1', focusSite: '中央公园', insertFront: true });
    await assert.rejects(a.runStep(step, pair, snapshot(), {}), /现在没有/);
    const moved = snapshot(); moved.partner.site = '家';
    await assert.rejects(a.runStep(step, pair, moved, {}), /地点已经变了/);
});
test('busy object still uses the existing occupancy check', async () => {
    const a = new Actions({}, { sites: async () => ({}) }, log);
    a.scheduleHold = async () => null;
    a.freshObjectActions = async () => [play];
    a.occupant = async () => ({ id: '999', name: '其他角色' });
    const step = Object.assign({}, use, { focusId: 'target-1', focusSite: '中央公园', insertFront: true });
    await assert.rejects(a.runStep(step, pair, snapshot(), {}), TakenError);
});
test('an accepted object promise is not satisfied by a social action', async () => {
    const { d } = harness();
    const snap = snapshot(); snap.objectFocus = active();
    let incoming;
    d.resolveWants = async (steps) => { incoming = steps; return steps.map((s) => s.type === 'use_object' ? Object.assign({}, use) : s); };
    d.endAtOuting = (s) => s;
    const plan = await d.planActions(pair, snap, catalog(), {
        actions: [{ type: 'interact', interaction_id: social.interaction.id }],
        promises: [{ do: '抓一个小鸡玩偶', when: 'now' }]
    }, ['我这就去抓一个小鸡玩偶'], [{ text: '去抓娃娃吧' }], false);
    assert.ok(incoming.some((s) => s.type === 'use_object'));
    assert.deepEqual(plan.steps.map((s) => s.type), ['use_object']);
    assert.equal(plan.focusId, snap.objectFocus.id);
});
test('plan-level repair error keeps the current activity and carries its real failure type', async () => {
    const { d } = harness();
    d.spokenPromise = async () => '抓娃娃';
    d.llm.json = async () => { throw new ReferenceError('test internal error'); };
    d.resolveWants = async (s) => s;
    d.endAtOuting = (s) => s;
    const plan = await d.planActions(pair, snapshot(), catalog(), { actions: [] }, ['我这就去抓娃娃'], [{ text: '去抓娃娃吧' }], false);
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.misses[0].code, 'internal_error');
});
test('object-menu failure during action selection retains game_error', async () => {
    const { d } = harness();
    d.choreRoute = async () => null; d.wantPeople = () => [];
    d.wantObjectMap = async () => [machine];
    d.llm.json = async () => ({ object_ids: ['701'] });
    d.actions.wantCandidates = async () => { throw new GameToolError('menu', 'timeout'); };
    const misses = [];
    const step = await d.resolveWant({ type: 'use_object', want: '抓娃娃' }, pair, snapshot(), catalog(), {}, misses);
    assert.equal(step, null);
    assert.equal(misses[0].code, 'game_error');
});

test('semantic follow-ups reuse resolved IDs but read the menus again', async () => {
    const { d } = harness(); let semanticCalls = 0; let menuCalls = 0;
    const instrument = { id: '705', name: '合成器', actions: [] };
    d.wantObjectMap = async () => [instrument];
    d.llm.json = async () => { semanticCalls++; return { object_ids: ['705'] }; };
    d.actions.freshObjectActions = async () => { menuCalls++; return [{ id: 'Synth_Play', name: '弹奏' }]; };
    const c = Object.assign(catalog(), { objects: [], more: [instrument] });
    await d.prepareObjectFocus(pair, snapshot(), c, [{ text: '找一下电子琴' }]);
    await d.prepareObjectFocus(pair, snapshot(), c, [{ text: '看到了吗' }]);
    await d.prepareObjectFocus(pair, snapshot(), c, [{ text: '现在能看到嘛' }]);
    assert.equal(semanticCalls, 1);
    assert.equal(menuCalls, 3);
});
test('failed spatial interpretation cannot silently fall back to the anchor object', async () => {
    const { d } = harness();
    d.wantObjectMap = async () => [];
    d.llm.json = async () => { throw new LlmError('timeout', 'timeout'); };
    const snap = snapshot();
    await d.prepareObjectFocus(pair, snap, Object.assign(catalog(), { more: [{ id: '705', name: '电脑' }] }), [{ text: '找电脑旁边的电子琴' }]);
    assert.deepEqual(snap.objectFocus.candidates, []);
    assert.equal(snap.objectFocus.error.code, 'model_error');
});
