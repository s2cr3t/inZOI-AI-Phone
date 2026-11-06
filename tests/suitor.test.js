'use strict';
// A high-school suitor (lib/suitor.js): who is picked, the request card and its answer, courting
// texts, the confession and its answer, and the prompt parts that let two high-schoolers have a
// first love without anything more.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suitor, pickSuitor, active, unanswered, reasonFor, promptParts, DEFAULTS } = require('../lib/suitor');
const persona = require('../lib/persona');

const me = { entity_id: 20524, first_name: '亚廷', last_name: '钟', gender: 'Female', age_group: 'HighTeen', household_id: 20520, current_site: '永成学校主楼' };
const boy = (id, extra) => Object.assign({ entity_id: id, first_name: 'B' + id, last_name: '白', gender: 'Male', age_group: 'HighTeen', household_id: id + 1, relationship_label: '…' }, extra || {});

test('the suitor is a high-school schoolmate of the other sex, never older, younger or family', () => {
    const contacts = [
        boy(1, { age_group: 'Youth' }),
        boy(2, { age_group: 'LowTeen' }),
        boy(3, { relationship_label: '表哥' }),
        boy(4, { household_id: 20520 }),
        boy(5, { gender: 'Female' }),
        boy(6, { blocked: true }),
        boy(7, { current_site: '公园' }),
        boy(8, { current_site: '永成学校主楼' })
    ];
    assert.strictEqual(pickSuitor(me, contacts).entity_id, 8);
    // The warmest bond wins among the rest.
    const warm = [boy(7), Object.assign(boy(9), { bond: { Friendship: 40, Romance: 10 } })];
    assert.strictEqual(pickSuitor(me, warm).entity_id, 9);
    assert.strictEqual(pickSuitor(me, [boy(8)], { exclude: ['8'] }), null);
    assert.strictEqual(pickSuitor(me, [boy(5, { gender: 'Female' })], { gender: 'any' }).entity_id, 5);
    // Middle school and adults get no suitor.
    assert.strictEqual(pickSuitor(Object.assign({}, me, { age_group: 'LowTeen' }), [boy(8, { age_group: 'LowTeen' })]), null);
    assert.strictEqual(pickSuitor(Object.assign({}, me, { age_group: 'Youth' }), [boy(8, { age_group: 'Youth' })]), null);
});

test('courting runs only between two high-schoolers or two adults', () => {
    assert.ok(active('HighTeen', 'HighTeen'));
    assert.ok(active('Youth', 'Adult'));
    assert.ok(!active('Youth', 'HighTeen'));
    assert.ok(!active('HighTeen', 'Youth'));
    assert.ok(!active('HighTeen', 'LowTeen'));
    assert.ok(!active('', 'HighTeen'));
});

test('unanswered counts the texts the suitor started, not replies or the bubbles of one text', () => {
    const p = (at) => ({ side: 'partner', kind: 'proactive', at });
    assert.strictEqual(unanswered([{ side: 'player', at: 1 }, p(1000), p(200000), p(200500)]), 2);
    // Replies to the player (two bubbles), then one text of his own: one waiting, not three.
    assert.strictEqual(unanswered([{ side: 'player', at: 1 }, { side: 'partner', kind: 'reply', at: 2 }, { side: 'partner', kind: 'reply', at: 3 }, p(90000)]), 1);
    assert.strictEqual(unanswered([p(1), { side: 'player', at: 2 }]), 0);
    assert.strictEqual(unanswered([]), 0);
});

test('the confession comes after enough talk and a day, once', () => {
    const rec = { state: 'pursuing', replies: 10, acceptedDay: 3, day: 4, confessed: false };
    assert.strictEqual(reasonFor(rec, '亚廷', '她', {}, 15).key, 'confess');
    assert.notStrictEqual(reasonFor(Object.assign({}, rec, { replies: 4 }), '亚廷', '她', {}, 15).key, 'confess');
    assert.notStrictEqual(reasonFor(Object.assign({}, rec, { day: 3 }), '亚廷', '她', {}, 15).key, 'confess');
    assert.notStrictEqual(reasonFor(Object.assign({}, rec, { confessed: true }), '亚廷', '她', {}, 15).key, 'confess');
    assert.notStrictEqual(reasonFor(Object.assign({}, rec, { state: 'dating' }), '亚廷', '她', {}, 15).key, 'confess');
    // Late at night there is a good-night among the reasons.
    const last = reasonFor({ state: 'dating' }, '亚廷', '她', {}, 22, () => 0.999);
    assert.match(last.text, /晚安/);
});

test('the prompt keeps a high-school romance innocent and asks for the crush answer', () => {
    const t = { call: '亚廷', them: '她' };
    const p = promptParts({ state: 'pursuing' }, t, true);
    assert.match(p.block, /你在追亚廷/);
    assert.match(p.block, /纯纯的校园恋爱/);
    assert.match(p.block, /不谈性/);
    assert.match(p.block, /别一上来就表白/);
    assert.match(p.rule, /"step":"together"/);
    assert.match(p.rule, /"step":"turned_down"/);
    const d = promptParts({ state: 'dating' }, t, true);
    assert.match(d.block, /在一起了/);
    assert.match(d.rule, /分手/);
    assert.doesNotMatch(promptParts({ state: 'dating' }, t, false).block, /高中生/);
});

test('persona: a suitor replaces the minors\' no-romance line, and a sweetheart is a boy/girlfriend', () => {
    assert.strictEqual(persona.termsFor('sweetheart', 'Female', 'Male', '亚廷').me, '男朋友');
    assert.strictEqual(persona.termsFor('sweetheart', 'Male', 'Female', '大煐').me, '女朋友');
    assert.strictEqual(persona.termsFor('suitor', 'Female', 'Male', '亚廷').outsider, true);
    const snap = (extra) => Object.assign({
        role: 'suitor', outsider: true, label: '',
        player: { name: '钟亚廷', firstName: '亚廷', gender: 'Female', ageGroup: 'HighTeen' },
        partner: { gender: 'Male', ageGroup: 'HighTeen' }
    }, extra || {});
    const plain = persona.defaultStyle(snap({ role: 'friend' })).text;
    assert.match(plain, /不谈恋爱/);
    const courting = persona.defaultStyle(snap({ suitorBlock: '【你在追亚廷】测试' })).text;
    assert.match(courting, /【你在追亚廷】测试/);
    assert.doesNotMatch(courting, /不谈恋爱/);
});

// ---------------------------------------------------------------- the flow, against a fake game
function fakeDaemon(dir, contacts) {
    const sent = [];
    const toasts = [];
    const d = {
        log: { info() {}, warn() {}, debug() {} },
        cfg: { proactive: { quiet_game_hours: [1, 6] }, suitor: { first_delay_minutes: 0 } },
        env: { day: 5, hour: 15 },
        threads: {},
        llm: { configured: false },
        world: {
            phase: async () => 'in_game',
            possessed: async () => '20524',
            household: async () => ({ members: [me] }),
            phoneContacts: async () => contacts,
            profile: async () => null,
            proximity: async () => ({ near: d.near === true }),
            preferences: async () => ({ likes: ['Food_Dessert'], dislikes: [] })
        },
        game: {
            soft: async (name, args) => {
                if (name === 'environment_get_state') return d.env;
                if (name === 'toast_show') { toasts.push(args.Message); return {}; }
                if (name === 'relationships_get_value_between') return { stats: {} };
                return null;
            }
        },
        mailbox: { thread: (key) => d.threads[key] || { messages: [], pending: [] } },
        async suitorText(playerId, suitorId, reason, key) {
            sent.push({ playerId, suitorId, reason, key });
            return true;
        }
    };
    const s = new Suitor(d);
    s.configure(path.join(dir, 'data'), path.join(dir, 'phone'));
    return { d, s, sent, toasts };
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('request, accept, courting texts, confession, together', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suitor-'));
    const { d, s, sent, toasts } = fakeDaemon(dir, [boy(20548, { current_site: '永成学校主楼' }), boy(1, { age_group: 'Youth' })]);
    await s.tick(); // first seen in high school
    await s.tick(); // the request
    const rec = s.record('20524');
    assert.strictEqual(rec.state, 'request');
    assert.strictEqual(rec.suitorId, '20548');
    assert.match(toasts[0], /想加你为好友/);
    const board = read(s.boardFile);
    assert.strictEqual(board.byPlayer['20524'].state, 'request');
    assert.ok(board.byPlayer['20524'].note);

    // The phone accepts.
    fs.mkdirSync(path.dirname(s.answersFile), { recursive: true });
    fs.writeFileSync(s.answersFile, JSON.stringify({ v: 1, byId: { [rec.id]: { answer: 'accept', at: Date.now() } } }));
    await s.tick();
    assert.strictEqual(s.record('20524').state, 'pursuing');
    assert.strictEqual(sent[0].key, 'first');
    assert.strictEqual(sent[0].suitorId, '20548');

    // Courting: a text of their own once the gap has passed, none while two wait unanswered.
    const r = s.record('20524');
    r.lastTextAt = 0;
    s.nextGap.set('20524', 0);
    d.threads['20524-20548'] = { messages: [{ side: 'partner', kind: 'proactive', at: 1 }, { side: 'partner', kind: 'proactive', at: 200000 }], pending: [] };
    await s.tick();
    assert.strictEqual(sent.length, 1);
    d.threads['20524-20548'] = { messages: [{ side: 'partner', at: 1 }, { side: 'player', at: 2 }], pending: [] };
    s.nextGap.set('20524', 0);
    await s.tick();
    assert.strictEqual(sent.length, 2);
    assert.notStrictEqual(sent[1].key, 'confess');

    // Enough talk and a day later: the confession.
    const pair = { key: '20524-20548', outsider: true, playerId: '20524', partnerId: '20548', player: me, partner: boy(20548) };
    for (let i = 0; i < 10; i++) s.fromReply(pair, { env: { day: 6 } }, { step: 'stay' }, true, 1);
    r.lastTextAt = 0;
    s.nextGap.set('20524', 0);
    d.env = { day: 6, hour: 16 };
    await s.tick();
    assert.strictEqual(sent[2].key, 'confess');
    s.fromReply(pair, { env: { day: 6 } }, { step: 'stay' }, false, 1, 'confess');
    assert.strictEqual(s.record('20524').confessed, true);

    // The player says yes.
    assert.strictEqual(s.dress(Object.assign({}, pair)), s.record('20524'));
    s.fromReply(pair, { env: { day: 6 } }, { step: 'together' }, true, 1);
    assert.strictEqual(s.record('20524').state, 'dating');
    const dressed = Object.assign({}, pair);
    s.dress(dressed);
    assert.strictEqual(dressed.role, 'sweetheart');
    assert.match(toasts[toasts.length - 1], /在一起了/);

    // A suitor who is not the player's age any more is no suitor.
    const grown = Object.assign({}, pair, { player: Object.assign({}, me, { age_group: 'Youth' }) });
    assert.strictEqual(s.view(grown), null);
});

test('a declined request ends it; another suitor comes only days later, never the same one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suitor-'));
    const { d, s } = fakeDaemon(dir, [boy(20548), boy(30000)]);
    await s.tick();
    await s.tick();
    const rec = s.record('20524');
    fs.mkdirSync(path.dirname(s.answersFile), { recursive: true });
    fs.writeFileSync(s.answersFile, JSON.stringify({ v: 1, byId: { [rec.id]: { answer: 'decline', at: Date.now() } } }));
    await s.tick();
    assert.strictEqual(s.record('20524').state, 'declined');
    await s.tick();
    await s.tick();
    assert.strictEqual(s.record('20524').state, 'declined');
    d.env = { day: 9, hour: 15 };
    await s.tick();
    await s.tick();
    const next = s.record('20524');
    assert.strictEqual(next.state, 'request');
    assert.notStrictEqual(next.suitorId, rec.suitorId);
});

test('a request left alone is dropped; turning the suitor down ends the courting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suitor-'));
    const { d, s, sent } = fakeDaemon(dir, [boy(20548)]);
    await s.tick();
    await s.tick();
    d.env = { day: 7, hour: 15 };
    await s.tick();
    assert.strictEqual(s.record('20524').state, 'ignored');

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'suitor-'));
    const b = fakeDaemon(dir2, [boy(20548)]);
    await b.s.tick();
    await b.s.tick();
    const rec = b.s.record('20524');
    fs.mkdirSync(path.dirname(b.s.answersFile), { recursive: true });
    fs.writeFileSync(b.s.answersFile, JSON.stringify({ v: 1, byId: { [rec.id]: { answer: 'accept', at: Date.now() } } }));
    await b.s.tick();
    const pair = { key: '20524-20548', outsider: true, playerId: '20524', partnerId: '20548', player: me, partner: boy(20548) };
    b.s.fromReply(pair, { env: { day: 5 } }, { step: 'turned_down' }, true, 1);
    assert.strictEqual(b.s.record('20524').state, 'declined');
    assert.strictEqual(b.s.view(pair), null);
    const before = b.sent.length;
    b.s.nextGap.set('20524', 0);
    await b.s.tick();
    assert.strictEqual(b.sent.length, before);
    assert.ok(sent.length === 0);
});

test('a middle-schooler gets no request', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suitor-'));
    const { d, s } = fakeDaemon(dir, [boy(20548, { age_group: 'LowTeen' })]);
    d.world.household = async () => ({ members: [Object.assign({}, me, { age_group: 'LowTeen' })] });
    await s.tick();
    await s.tick();
    assert.strictEqual(s.record('20524'), null);
});

test('suitor-now sends the request at once, from the schoolmate asked for', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suitor-'));
    const { d, s } = fakeDaemon(dir, [boy(20548, { current_site: '永成学校主楼' }), boy(30000)]);
    d.cfg.suitor.first_delay_minutes = 8;
    d.env = { day: 5, hour: 3 }; // quiet hours do not hold a test back
    fs.mkdirSync(path.dirname(s.forceFile), { recursive: true });
    fs.writeFileSync(s.forceFile, JSON.stringify({ at: Date.now(), suitor: '30000' }));
    await s.tick();
    assert.strictEqual(s.record('20524').state, 'request');
    assert.strictEqual(s.record('20524').suitorId, '30000');
    assert.ok(!fs.existsSync(s.forceFile));
});

test('topics are concrete, rotate, and follow the day', () => {
    const rec = { state: 'pursuing', replies: 2, tactics: [] };
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
        const r = reasonFor(rec, '亚廷', '她', {}, 15, Math.random, { likes: ['巧克力'] });
        assert.match(r.text, /不要发“在干嘛”/);
        rec.tactics = rec.tactics.concat([r.key]).slice(-4);
        seen.add(r.key);
    }
    // Twelve texts never fall back on the same handful.
    assert.ok(seen.size >= 5);
    // The last four are not tried again.
    const r = reasonFor({ state: 'pursuing', tactics: ['callback', 'share', 'like', 'invite'] }, '亚廷', '她', {}, 15);
    assert.ok(['callback', 'share', 'like', 'invite'].indexOf(r.key) < 0);
    assert.match(reasonFor({ state: 'pursuing' }, '亚廷', '她', {}, 7, Math.random, { ritual: 'morning' }).text, /早安/);
    assert.match(reasonFor({ state: 'dating' }, '亚廷', '她', {}, 22, Math.random, { ritual: 'night' }).text, /晚安/);
    assert.match(reasonFor({ state: 'pursuing' }, '亚廷', '她', {}, 15, Math.random, { unanswered: 1 }).text, /还没回你上一条/);
});

test('the suitor writes after a few quiet minutes, keeps the rituals of the day, and never while together', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suitor-'));
    const { d, s, sent } = fakeDaemon(dir, [boy(20548)]);
    await s.tick();
    await s.tick();
    const rec = s.record('20524');
    fs.mkdirSync(path.dirname(s.answersFile), { recursive: true });
    fs.writeFileSync(s.answersFile, JSON.stringify({ v: 1, byId: { [rec.id]: { answer: 'accept', at: Date.now() } } }));
    await s.tick();
    const r = s.record('20524');
    const now = Date.now();
    // Talked three minutes ago: too soon for a topic of his own, but a morning ritual may go.
    d.threads['20524-20548'] = { messages: [{ side: 'player', at: now - 3 * 60000 }], pending: [] };
    r.lastTextAt = 0;
    s.nextGap.delete('20524');
    d.env = { day: 6, hour: 15 };
    const before = sent.length;
    await s.tick();
    assert.ok(DEFAULTS.pursue_minutes * 0.7 > 3);
    assert.strictEqual(sent.length, before);
    d.env = { day: 6, hour: 7 };
    await s.tick();
    assert.strictEqual(sent[sent.length - 1].key, 'morning');
    // Once a day.
    r.lastTextAt = 0;
    d.threads['20524-20548'] = { messages: [{ side: 'player', at: now - 3 * 60000 }], pending: [] };
    const n = sent.length;
    await s.tick();
    assert.strictEqual(sent.length, n);
    // Together in the game: nothing by text.
    d.near = true;
    d.env = { day: 7, hour: 7 };
    await s.tick();
    assert.strictEqual(sent.length, n);
    // Unless both are at school: then a note passed in class.
    me.current_site = '永成学校主楼';
    const mates = await d.world.phoneContacts();
    mates[0].current_site = '永成学校主楼';
    await s.tick();
    assert.strictEqual(sent.length, n + 1);
    assert.match(sent[sent.length - 1].reason, /传纸条/);
    delete mates[0].current_site;
});
