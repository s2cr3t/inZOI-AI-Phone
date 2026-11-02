'use strict';
// Group chats when the played character is a member, not the one who made the group: the played
// character never answers for themselves, and answers are written to whoever wrote the line.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const persona = require('../lib/persona');
const { Groups } = require('../lib/groups');

const MOM = '100';
const HOSHINO = '200';
const SISTER = '300';

function setup(possessed) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-player-'));
    const phone = path.join(root, 'phone', 'groups');
    const g = path.join(phone, 'g-fam');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'meta.cfg'), JSON.stringify({
        v: 1, id: 'fam', name: '家人群', owner: MOM,
        members: [{ id: HOSHINO, name: '星野' }, { id: SISTER, name: '小葵' }]
    }));
    const pairs = [];
    const world = {
        possessed: async () => possessed,
        pair: async (player, contact) => {
            pairs.push(player + '>' + contact);
            const names = { [MOM]: '妈妈本人', [HOSHINO]: '星野', [SISTER]: '小葵' };
            return { playerId: player, partnerId: contact, role: 'family', partner: { name: names[contact] } };
        },
        snapshot: async (pair) => ({ player: { id: pair.playerId }, partner: { entity_id: pair.partnerId, name: pair.partner.name }, env: null })
    };
    const said = [];
    const d = {
        log: { info() {}, warn() {}, debug() {} },
        world,
        cfg: { groups: { silence_chance: 0, min_gap_ms: 0, max_gap_ms: 0 }, mailbox: { dir: path.join(root, 'phone', 'sms') } },
        llm: { configured: true, json: async () => ({ messages: ['好呀'] }) }
    };
    const groups = new Groups(d);
    groups.configure(path.join(root, 'data'));
    return { groups, phone: g, pairs, said, root };
}

function writeOutbox(dir, lines) {
    fs.writeFileSync(path.join(dir, 'outbox.cfg'), JSON.stringify(lines));
}

test('the played member never answers their own line', () => {
    const { groups, phone } = setup(HOSHINO);
    const meta = groups.meta('fam');
    for (let i = 0; i < 30; i++) {
        const st = groups.state('fam');
        st.queue = [];
        st.lastFrom = '';
        groups.plan('fam', meta, st, [{ id: 'm' + i, at: i + 1, from: HOSHINO, text: '我点了披萨有人要吃吗' }], 'player');
        assert.ok(st.queue.length > 0);
        for (const q of st.queue) assert.notStrictEqual(q.from, HOSHINO);
        assert.strictEqual(st.queue[0].author, HOSHINO);
    }
    writeOutbox(phone, []);
});

test('a mention of the played member by name is not answered by them', () => {
    const { groups } = setup(HOSHINO);
    const meta = groups.meta('fam');
    const st = groups.state('fam');
    groups.plan('fam', meta, st, [{ id: 'x', at: 1, from: HOSHINO, text: '小葵 吃不吃', mentions: [HOSHINO, SISTER] }], 'player');
    assert.deepStrictEqual(st.queue.map((q) => q.from), [SISTER]);
});

test('the answer is written to the one who wrote, with their name, not to the group owner', async () => {
    const { groups, phone, pairs } = setup(HOSHINO);
    writeOutbox(phone, [{ id: 'p1', at: 1, from: HOSHINO, text: '@小葵 我点了披萨', mentions: [SISTER] }]);
    let input = null;
    const orig = persona.groupPrompt;
    persona.groupPrompt = (x) => { input = x; return { system: '', user: '' }; };
    try {
        const meta = groups.meta('fam');
        const st = groups.state('fam');
        groups.plan('fam', meta, st, [{ id: 'p1', at: 1, from: HOSHINO, text: '@小葵 我点了披萨', mentions: [SISTER] }], 'player');
        await groups.say('fam', meta, st, st.queue[0]);
    } finally {
        persona.groupPrompt = orig;
    }
    assert.ok(input, 'a prompt was built');
    assert.strictEqual(input.snap.player.id, HOSHINO);
    assert.strictEqual(pairs[0], HOSHINO + '>' + SISTER);
    assert.ok(!input.roster.some((r) => r.id === HOSHINO), 'the player is not listed as a third person');
    assert.ok(input.roster.some((r) => r.id === MOM), 'the owner is in the room');
    const mine = input.history.find((h) => h.id === 'p1');
    assert.strictEqual(mine.player, true);
});

test('lines the owner wrote earlier are named, not taken for the player\'s', () => {
    const { groups, phone } = setup(HOSHINO);
    writeOutbox(phone, [
        { id: 'o1', at: 1, text: '今晚吃什么' },
        { id: 'p1', at: 2, from: HOSHINO, text: '披萨' }
    ]);
    const rows = groups.history('fam', groups.meta('fam'), 30, HOSHINO, { [MOM]: '妈妈本人' });
    assert.deepStrictEqual(rows.map((r) => [r.id, r.player, r.name]), [['o1', false, '妈妈本人'], ['p1', true, '星野']]);
});

test('a job that lands on the played character is passed on, not spoken', async () => {
    const { groups } = setup(SISTER);
    const meta = groups.meta('fam');
    const st = groups.state('fam');
    const job = { at: 0, from: SISTER, why: '接话', kind: 'player', author: HOSHINO, replyTo: '' };
    st.queue = [job];
    await groups.say('fam', meta, st, job);
    assert.ok(!fs.existsSync(path.join(groups.groupDir('fam'), 'inbox.cfg')) ||
        !JSON.parse(fs.readFileSync(path.join(groups.groupDir('fam'), 'inbox.cfg'), 'utf8')).some((m) => m.from === SISTER));
    assert.ok(st.queue.length === 1 && st.queue[0].from !== SISTER && st.queue[0].from !== HOSHINO);
});
