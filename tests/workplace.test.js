'use strict';
// Offline tests for how colleagues see the player at work (lib/workplace.js): the starting
// impression from the game's Business bond, what moves it (chat, OA decisions, absences), the
// boss's style in the reply prompt, and the file the phone's OA reads. Everything is written under
// a temporary folder; no game, no API, no player data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Workplace, STYLES, labelOf, styleFor } = require('../lib/workplace');

const log = { info() {}, warn() {}, debug() {} };
const pair = { key: '20522-19141', playerId: '20522', partnerId: '19141', outsider: true };
const desk = { bossId: '19141', team: ['19141', '19695'], unexcused: 0 };

function setup(t, business) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workplace-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const asked = [];
    const d = {
        log,
        game: {
            async soft(tool, args) {
                asked.push([tool, args]);
                if (tool === 'relationships_get_value_between') return { stats: { Business: { value: business === undefined ? 20 : business } } };
                return null;
            }
        }
    };
    const w = new Workplace(d);
    w.configure(path.join(root, 'data'), path.join(root, 'ui', 'phone'));
    // A known style for the boss, whatever the id would pick.
    w.data.styles['19141'] = 'strict';
    return { w, root, asked, board: () => JSON.parse(fs.readFileSync(path.join(root, 'ui', 'phone', 'oa', 'impressions.cfg'), 'utf8')) };
}

test('the first impression comes from the game\'s Business bond, the colleague\'s own view', async (t) => {
    const s = setup(t, 20);
    const e = await s.w.entry('20522', '19141');
    assert.equal(e.score, 51);
    assert.deepEqual(s.asked[0], ['relationships_get_value_between', { owner_id: '19141', target_id: '20522' }]);
    // Kept, not asked again; and kept within bounds for extreme bonds.
    await s.w.entry('20522', '19141');
    assert.equal(s.asked.length, 1);
    const high = setup(t, 100);
    assert.equal((await high.w.entry('20522', '19141')).score, 75);
});

test('the boss reply knows the boss\'s style and the impression; a colleague gets theirs; others nothing', async (t) => {
    const s = setup(t, 20);
    const rule = await s.w.rule(pair, '会荣', desk);
    assert.match(rule, /【你和会荣在公司】你是会荣的直属上级。你是严厉型的上级/);
    assert.match(rule, /你对会荣的印象：51 分（满分 100），印象一般。/);
    assert.match(rule, /低于 40 分，你对会荣的请求多半不耐烦/);
    const mate = await s.w.rule(Object.assign({}, pair, { partnerId: '19695' }), '会荣', desk);
    assert.match(mate, /你们是同一家公司的同事/);
    assert.doesNotMatch(mate, /直属上级/);
    assert.equal(await s.w.rule(Object.assign({}, pair, { partnerId: '30000' }), '会荣', desk), '');
    assert.equal(await s.w.rule(Object.assign({}, pair, { outsider: false }), '会荣', desk), '');
    assert.equal(await s.w.rule(pair, '会荣', null), '');
});

test('chat moves it by the boss\'s style: a strict boss gains slowly and minds a slight', async (t) => {
    const s = setup(t, 20);
    await s.w.fromFelt(pair, { env: { day: 3 } }, { level: 2, why: '汇报得很清楚' });
    assert.equal(s.w.score('20522', '19141'), 55);
    await s.w.fromFelt(pair, { env: { day: 3 } }, { level: -1, why: '说话没大没小' });
    assert.equal(s.w.score('20522', '19141'), 52);
    await s.w.fromFelt(pair, { env: { day: 3 } }, { level: 0 });
    assert.equal(s.w.score('20522', '19141'), 52, 'a neutral chat changes nothing');
    assert.match(await s.w.rule(pair, '会荣', desk), /最近：汇报得很清楚（\+4）；说话没大没小（-3）。/);
});

test('OA decisions leave their mark: faked sickness most of all', async (t) => {
    const s = setup(t, 20);
    await s.w.onDecision('20522', '19141', 'leave', 'approved', { ok: true }, 3);
    assert.equal(s.w.score('20522', '19141'), 50);
    await s.w.onDecision('20522', '19141', 'sick', 'rejected', { ok: false }, 3);
    assert.equal(s.w.score('20522', '19141'), 44);
    await s.w.onDecision('20522', '19141', 'promote', 'rejected', { ok: false }, 3);
    assert.equal(s.w.score('20522', '19141'), 42);
    await s.w.onDecision('20522', '19141', 'promote', 'rejected', { ok: true }, 3);
    assert.equal(s.w.score('20522', '19141'), 42, 'a boss saying no to a fair request costs the player nothing');
});

test('a new unexcused absence costs the boss\'s goodwill, double for a strict one', async (t) => {
    const s = setup(t, 20);
    await s.w.watch('20522', Object.assign({}, desk, { unexcused: 0 }), 3);
    assert.equal(s.w.score('20522', '19141'), null, 'the first look only notes the count');
    await s.w.watch('20522', Object.assign({}, desk, { unexcused: 1 }), 4);
    assert.equal(s.w.score('20522', '19141'), 35);
    await s.w.watch('20522', Object.assign({}, desk, { unexcused: 1 }), 4);
    assert.equal(s.w.score('20522', '19141'), 35, 'the same count again changes nothing');
});

test('the phone reads score, label, style and the last changes', async (t) => {
    const s = setup(t, 20);
    await s.w.fromFelt(pair, { env: { day: 3 } }, { level: 1, why: '主动帮忙' });
    const b = s.board().byPair['20522-19141'];
    assert.equal(b.score, 53);
    assert.equal(b.label, '印象一般');
    assert.equal(b.style, 'strict');
    assert.equal(b.styleName, '严厉型');
    assert.deepEqual(b.events.map((e) => e.why + e.delta), ['主动帮忙2']);
});

test('labels and styles', () => {
    assert.equal(labelOf(85), '很赏识你');
    assert.equal(labelOf(29), '很不满意');
    assert.equal(styleFor('19141'), styleFor('19141'), 'the same colleague always gets the same style');
    assert.ok(STYLES[styleFor('12345')]);
    assert.equal(Object.keys(STYLES).length, 5);
});

test('a change the score shows is told in the chat with that colleague; one at the limit is not', async (t) => {
    const s = setup(t, 20);
    const told = [];
    s.w.d.impressionNotice = function () { told.push(Array.prototype.slice.call(arguments)); };
    await s.w.fromFelt(pair, { env: { day: 3 }, partner: { name: '雅各布斯纳尔逊' } }, { level: 1, why: '主动帮忙' });
    assert.deepEqual(told[0], ['20522', '19141', 2, 53, '印象一般', '主动帮忙', '雅各布斯纳尔逊']);
    await s.w.onDecision('20522', '19141', 'sick', 'rejected', { ok: false }, 3);
    assert.deepEqual(told[1].slice(0, 6), ['20522', '19141', -6, 47, '印象一般', '装病请假被看穿']);
    assert.equal(told[1][6], '', 'no name at hand: the daemon looks it up');
    // Already at the top: nothing moved, nothing to tell.
    s.w.data.byPair['20522-19141'].score = 100;
    await s.w.fromFelt(pair, { env: { day: 3 } }, { level: 2, why: '夸了几句' });
    assert.equal(told.length, 2);
});

test('the mailbox keeps which way an impression notice went', (t) => {
    const { Mailbox } = require('../lib/mailbox');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workplace-mail-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const mb = new Mailbox({ dir: root, keep: 50, textMax: 400 });
    const m = mb.append('20522-19141', '对你的印象 +2', null, 'notice', { day: 3, hour: 9, minute: 0 }, { work: 'up' });
    assert.equal(m.work, 'up');
    const odd = mb.append('20522-19141', '对你的印象 +2', null, 'notice', null, { work: 'sideways' });
    assert.equal(odd.work, undefined);
    const stored = JSON.parse(fs.readFileSync(mb.file('20522-19141', 'inbox'), 'utf8'));
    assert.equal(stored[0].work, 'up');
});
