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

test('a visit by cheat: off screen, they set off now and are brought next to the player after the trip', async () => {
    const calls = [];
    let possessed = '20524';
    const a = Object.create(Actions.prototype);
    a.log = { info() {}, warn() {} };
    // Long enough that the trip's own timer never fires during the test; the arrival is called below.
    a.visitTravelMs = 60000;
    a.game = {
        call: async (tool, args) => { calls.push(tool + ':' + (args.entity_id || '')); if (tool === 'entity_possess') possessed = args.entity_id; return {}; },
        soft: async () => ({})
    };
    a.world = { possessed: async () => possessed, invalidate() {}, scanAroundPossessed: async () => new Map([['20548', 1.5]]) };
    const r = a.visitFar('20548', vpair, {}, site, '白大煐');
    assert.strictEqual(r.ok, true);
    assert.match(r.toast, /出门了/);
    // A second "go" while on the way does not start another trip.
    assert.strictEqual(a.visitFar('20548', vpair, {}, site, '白大煐').note, '已经在路上了');
    clearTimeout(a.cheatTrips.get('20548'));
    a.cheatTrips.clear();
    const here = await a.arriveByCheat('20548', '20524', '白大煐');
    assert.strictEqual(here, true);
    assert.deepStrictEqual(calls.slice(-3), ['entity_possess:20548', 'movement_teleport_to:20524', 'entity_possess:20524']);
    assert.strictEqual(possessed, '20524');
});

test('the cheat never runs while someone else is played, and always hands control back', async () => {
    const a = Object.create(Actions.prototype);
    a.log = { info() {}, warn() {} };
    let possessed = '43386';
    const calls = [];
    a.game = { call: async (tool, args) => { calls.push(tool); if (tool === 'movement_teleport_to') throw new Error('boom'); if (tool === 'entity_possess') possessed = args.entity_id; return {}; }, soft: async () => ({}) };
    a.world = { possessed: async () => possessed, invalidate() {}, scanAroundPossessed: async () => new Map() };
    assert.strictEqual(await a.arriveByCheat('20548', '20524', '白大煐'), false);
    assert.deepStrictEqual(calls, []);
    possessed = '20524';
    await assert.rejects(a.arriveByCheat('20548', '20524', '白大煐'), /boom/);
    assert.strictEqual(possessed, '20524');
});
