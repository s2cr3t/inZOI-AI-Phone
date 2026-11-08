'use strict';
// Someone outside the household who is not with the player can still come over when invited;
// apart, that is all they can do.
const test = require('node:test');
const assert = require('node:assert');
const persona = require('../lib/persona');
const { Daemon } = require('../lib/daemon');

const daemon = { cfg: { actions: { enabled: true, allowed: ['go_home', 'go_to_player', 'go_to_place', 'interact', 'stop_current', 'emote', 'use_object'], max_per_reply: 4 } } };
const pair = { outsider: true, playerId: '20524', partnerId: '20548' };

test('apart, an outsider may only come over', () => {
    const cfg = Daemon.prototype.actionsCfg.call(daemon, pair, { outsiderNear: false });
    assert.strictEqual(cfg.enabled, true);
    assert.deepStrictEqual(cfg.allowed.slice().sort(), ['go_to_player', 'stop_current']);
    assert.strictEqual(cfg.allow_teleport, false);
});

test('together, they can do what an outsider can do side by side', () => {
    const cfg = Daemon.prototype.actionsCfg.call(daemon, pair, { outsiderNear: true });
    assert.ok(cfg.allowed.includes('interact'));
    assert.ok(cfg.allowed.includes('go_to_player'));
    assert.ok(!cfg.allowed.includes('use_object'));
});

test('household members keep the full set', () => {
    assert.strictEqual(Daemon.prototype.actionsCfg.call(daemon, { outsider: false }, {}), daemon.cfg.actions);
});

test('the prompt tells an outsider apart that saying they are coming means doing it', () => {
    const snap = {
        role: 'sweetheart', outsider: true, label: '', outsiderNear: false,
        player: { name: '钟亚廷', firstName: '亚廷', gender: 'Female', ageGroup: 'HighTeen' },
        partner: { gender: 'Male', ageGroup: 'HighTeen' }
    };
    const s = persona.defaultStyle(snap).text;
    assert.match(s, /go_to_player/);
    assert.match(s, /会白等/);
    assert.doesNotMatch(s, /不要写走过去/);
});

test('off screen (the game does not simulate them), they cannot come and must not promise to', () => {
    const cfg = Daemon.prototype.actionsCfg.call(daemon, pair, { outsiderNear: false, outsiderReachable: false });
    assert.deepStrictEqual(cfg.allowed, []);
    const snap = {
        role: 'sweetheart', outsider: true, label: '', outsiderNear: false, outsiderReachable: false,
        player: { name: '钟亚廷', firstName: '亚廷', gender: 'Female', ageGroup: 'HighTeen' },
        partner: { gender: 'Male', ageGroup: 'HighTeen' }
    };
    const s = persona.defaultStyle(snap).text;
    assert.match(s, /这会儿过不去/);
    assert.match(s, /不要说“这就出门”/);
    assert.doesNotMatch(s, /go_to_player/);
});

const { Actions, visitSlot } = require('../lib/actions');

test('the appointment window: half an hour on, rounded to ten, two hours long, never past the day', () => {
    assert.deepStrictEqual(visitSlot({ hour: 14, minute: 7 }), { start: 1440, end: 1640, text: '14:40' });
    assert.deepStrictEqual(visitSlot({ hour: 21, minute: 50 }), { start: 2220, end: 2359, text: '22:20' });
    assert.strictEqual(visitSlot({ hour: 23, minute: 10 }), null);
    assert.strictEqual(visitSlot(null), null);
});

test('off screen but reachable by a visit, they may agree to come; the prompt says it takes a while', () => {
    const cfg = Daemon.prototype.actionsCfg.call(daemon, pair, { outsiderNear: false, outsiderReachable: false, outsiderCanBook: true });
    assert.deepStrictEqual(cfg.allowed.slice().sort(), ['go_to_player', 'stop_current']);
    const s = persona.defaultStyle({
        role: 'sweetheart', outsider: true, label: '', outsiderNear: false, outsiderReachable: false, outsiderCanBook: true,
        player: { name: '钟亚廷', firstName: '亚廷', gender: 'Female', ageGroup: 'HighTeen' },
        partner: { gender: 'Male', ageGroup: 'HighTeen' }
    }).text;
    assert.match(s, /一会儿/);
    assert.match(s, /go_to_player/);
    assert.match(s, /别说“已经到了”/);
});

function actionsWith(book) {
    const a = Object.create(Actions.prototype);
    a.log = { info() {}, warn() {} };
    a.bookVisit = book;
    a.visitMode = 'appointment';
    return a;
}
const site = { id: 'Gangnam_Residence_Free01', name: '钟家' };
const vpair = { key: '20524-20548', playerId: '20524', partnerId: '20548' };

test('a visit by appointment is booked for the player\'s site and said as it is', async () => {
    const calls = [];
    const a = actionsWith(async (...args) => { calls.push(args); return { ok: true, detail: 'booked' }; });
    const r = await a.visitByAppointment('20548', vpair, { env: { hour: 14, minute: 0 } }, site, '白大煐');
    assert.deepStrictEqual(calls[0], ['20524', '20548', 'Gangnam_Residence_Free01', 1430, 1630]);
    assert.strictEqual(r.ok, true);
    assert.match(r.toast, /约好 14:30 左右到 钟家/);
});

test('a refused booking is a failure, never a trip under way', async () => {
    const a = actionsWith(async () => ({ ok: false, detail: 'bad_request' }));
    await assert.rejects(a.visitByAppointment('20548', vpair, { env: { hour: 14, minute: 0 } }, site, '白大煐'), /约见也没约成/);
    const none = actionsWith(undefined);
    await assert.rejects(none.visitByAppointment('20548', vpair, { env: { hour: 14, minute: 0 } }, site, '白大煐'), /没法走过去/);
});

function forced(opts) {
    const o = opts || {};
    const calls = [];
    const asked = [];
    let possessed = o.possessed || '20524';
    const a = Object.create(Actions.prototype);
    a.log = { info() {}, warn() {} };
    // Long enough that the trip's own timer never fires during the test; the arrival is called below.
    a.visitTravelMs = 60000;
    a.visitSettleMs = 1;
    a.visitMode = 'force';
    a.visitForce = async (player, visitor, on) => { asked.push([player, visitor, on]); return o.refuse ? { ok: false, detail: 'no_answer' } : { ok: true, detail: 'visit_false_-' }; };
    a.game = {
        call: async (tool, args) => { calls.push(tool + ':' + (args.entity_id || '')); if (tool === 'entity_possess') possessed = args.entity_id; return {}; },
        soft: async (tool) => (tool === 'entity_get_simulate_state' ? { results: [{ entity_id: 20548, simulated: true }] } : {})
    };
    a.world = { possessed: async () => possessed, invalidate() {}, scanAroundPossessed: async () => new Map([['20548', 1.5]]) };
    return { a, calls, asked };
}

test('a visit: off screen or homeless, the game is asked to simulate them, then they are brought over', async () => {
    const { a, calls, asked } = forced();
    const r = a.visitFar('20548', vpair, {}, site, '白大煐');
    assert.strictEqual(r.ok, true);
    assert.match(r.toast, /出门了/);
    // A second "go" while on the way does not start another trip.
    assert.strictEqual(a.visitFar('20548', vpair, {}, site, '白大煐').note, '已经在路上了');
    clearTimeout(a.visitTrips.get('20548'));
    a.visitTrips.clear();
    assert.strictEqual(await a.arriveByForce('20548', '20524', '白大煐'), true);
    assert.deepStrictEqual(asked, [['20524', '20548', true]]);
    assert.deepStrictEqual(calls, ['movement_summon:20548'], 'nobody is possessed');
});

test('a visitor turns up twenty metres off, is freed of their crowd walk, and walks over in a group kept for the visit', async () => {
    const { a } = forced();
    a.visitWalkMs = 200;
    a.visitFollowMs = 1;
    a.visitRefollowMs = 1000;
    const calls = [];
    let distance = 20;
    a.game.soft = async (tool, args) => {
        calls.push(tool);
        if (tool === 'entity_get_simulate_state') return { results: [{ simulated: true }] };
        if (tool === 'entity_reflect') return { worldTransform: { translation: { x: 1000, y: 2000, z: 150 } } };
        if (tool === 'movement_teleport') { const dx = args.X - 1000, dy = args.Y - 2000; assert.ok(Math.abs(Math.hypot(dx, dy) - 2000) < 1); return {}; }
        if (tool === 'zoi_group_get_info') return { has_group: false };
        if (tool === 'zoi_group_follow') return {};
        return {};
    };
    a.game.call = async (tool) => { calls.push('call:' + tool); return {}; };
    a.world.scanAroundPossessed = async () => { distance = Math.max(1, distance - 4); return new Map([['20548', distance]]); };
    assert.strictEqual(await a.arriveByForce('20548', '20524', '白大煐'), true);
    assert.ok(calls.indexOf('interaction_clear_queue') < calls.indexOf('zoi_group_create'), 'crowd walk cancelled first');
    assert.ok(!calls.includes('zoi_group_disband'), 'the group stays for the visit');
    assert.ok(calls.filter((c) => c === 'zoi_group_follow').length <= 2, 'no gathering request every few seconds');
    assert.ok(!calls.includes('call:movement_summon'), 'walked, not summoned');
    await a.endVisitGroup('20548');
    assert.ok(calls.includes('zoi_group_disband'), 'left when the visit ends');
});

test('no visit while someone else is played, nor when the game was not asked; without the mod they cannot come', async () => {
    const other = forced({ possessed: '43386' });
    assert.strictEqual(await other.a.arriveByForce('20548', '20524', '白大煐'), false);
    assert.deepStrictEqual(other.asked, []);
    const refused = forced({ refuse: true });
    assert.strictEqual(await refused.a.arriveByForce('20548', '20524', '白大煐'), false);
    assert.deepStrictEqual(refused.calls, []);
    const off = forced();
    off.a.visitMode = 'off';
    assert.strictEqual(off.a.visitFar('20548', vpair, {}, site, '白大煐').ok, false);
});
