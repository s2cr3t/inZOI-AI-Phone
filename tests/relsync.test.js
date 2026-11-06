'use strict';
// Chats move the game's relationship values (lib/relsync.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RelSync, stepsFor, capped, sharedValue, DAY_CAP } = require('../lib/relsync');

test('which stats a felt moves, by relationship', () => {
    assert.deepStrictEqual(stepsFor('sweetheart', 2), { Romance: 3, Friendship: 1.5 });
    assert.deepStrictEqual(stepsFor('spouse', -2), { Romance: -4, Friendship: -2 });
    assert.deepStrictEqual(stepsFor('child', 1), { Family: 1.5, Friendship: 0.8 });
    assert.deepStrictEqual(stepsFor('colleague', 1), { Business: 1.5, Friendship: 0.8 });
    assert.deepStrictEqual(stepsFor('friend', -1), { Friendship: -2 });
    assert.deepStrictEqual(stepsFor('friend', 0), {});
    assert.deepStrictEqual(stepsFor('friend', undefined), {});
});

test('a day\'s allowance caps each stat both ways', () => {
    assert.strictEqual(capped(3, 0), 3);
    assert.strictEqual(capped(3, DAY_CAP - 1), 1);
    assert.strictEqual(capped(3, DAY_CAP), 0);
    assert.strictEqual(capped(-4, -DAY_CAP + 2), -2);
    // Down today does not eat the room to go up.
    assert.strictEqual(capped(3, -6), 3);
});

// The game as it behaves: two directions, kept a little apart, and every set landing on both.
// stats: their bond toward the player; mine (optional): the player's toward them.
function fakeGame(stats, guarded, mine) {
    const calls = [];
    const back = mine || Object.assign({}, stats);
    const game = {
        calls,
        stats,
        back,
        soft: async (tool, args) => {
            calls.push(tool);
            if (tool === 'relationships_get_value_between') {
                const src = args.owner_id === '20548' ? stats : back;
                const out = {};
                for (const k of Object.keys(src)) out[k] = { value: src[k], relationship_id: k.toLowerCase() + '1' };
                return { stats: out };
            }
            if (tool === 'relationships_set_value_between') {
                const stat = args.relationship_id;
                if (stat in stats && !(guarded || []).includes(stat)) { stats[stat] = args.Value; back[stat] = args.Value; }
                return '';
            }
            return null;
        }
    };
    return game;
}

function sync(game) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-'));
    const r = new RelSync({ log: { info() {}, warn() {} }, cfg: {}, game });
    r.configure(dir);
    return r;
}

const pair = (role) => ({ playerId: '20524', partnerId: '20548', role });
const snap = (day) => ({ env: { day }, partner: { name: '白大煐' } });

test('a warm reply raises the bond in the game, and a stat the game guards is left alone', async () => {
    const stats = { Romance: 10, Friendship: 40, Family: 0, Business: 0 };
    const game = fakeGame(stats, ['Romance']);
    const r = sync(game);
    const out = await r.fromFelt(pair('suitor'), snap(5), { level: 2, why: '她答应一起走' });
    assert.strictEqual(stats.Friendship, 41.5);
    // Romance was refused by the game: not counted, not claimed.
    assert.strictEqual(stats.Romance, 10);
    assert.deepStrictEqual(out.done.map((d) => d.stat), ['Friendship']);
    assert.ok(game.calls.includes('toast_show'));
});

test('the daily cap holds; a new game day starts over; a big moment goes past it', async () => {
    const stats = { Romance: 0, Friendship: 0 };
    const r = sync(fakeGame(stats));
    for (let i = 0; i < 6; i++) await r.fromFelt(pair('sweetheart'), snap(5), { level: 2 });
    assert.strictEqual(stats.Romance, DAY_CAP);
    await r.fromFelt(pair('sweetheart'), snap(6), { level: 2 });
    assert.strictEqual(stats.Romance, DAY_CAP + 3);
    await r.bump(pair('sweetheart'), snap(6), { Romance: 15 }, '在一起了');
    assert.strictEqual(stats.Romance, DAY_CAP + 18);
    // A felt of 0 moves nothing.
    assert.strictEqual(await r.fromFelt(pair('sweetheart'), snap(6), { level: 0 }), null);
});

test('two moves at once both happen, one after the other', async () => {
    const stats = { Friendship: 0 };
    const r = sync(fakeGame(stats));
    await Promise.all([r.fromFelt(pair('friend'), snap(1), { level: 2 }), r.fromFelt(pair('friend'), snap(1), { level: 2 })]);
    assert.strictEqual(stats.Friendship, 6);
});

test('switched off in the config, nothing moves', async () => {
    const stats = { Friendship: 0 };
    const game = fakeGame(stats);
    const r = new RelSync({ log: { info() {}, warn() {} }, cfg: { relsync: { enabled: false } }, game });
    r.configure(fs.mkdtempSync(path.join(os.tmpdir(), 'rel-')));
    assert.strictEqual(await r.fromFelt(pair('friend'), snap(1), { level: 2 }), null);
    assert.strictEqual(stats.Friendship, 0);
});

test('the shared value: the middle moved by the step, nobody against it', () => {
    // Close together: both move about one step.
    assert.strictEqual(sharedValue(40, 41, 3), 43.5);
    // Far apart on a warm reply: the higher side stays, the lower one closes in; nobody goes down.
    assert.strictEqual(sharedValue(92.5, 95, 1), 95);
    assert.strictEqual(sharedValue(95, 92.5, 1), 95);
    // A cold reply: nobody goes up.
    assert.strictEqual(sharedValue(92.5, 95, -1), 92.5);
    assert.strictEqual(sharedValue(50, 50, -4), 46);
});

test('a reply moves both directions to the shared value, as the game can only do', async () => {
    const theirs = { Friendship: 92.5 };
    const mine = { Friendship: 95 };
    const game = fakeGame(theirs, [], mine);
    const r = sync(game);
    // A warm reply (+3 a step for a friend): middle 93.75 + 3 = 96.75, above both.
    await r.fromFelt(pair('friend'), snap(1), { level: 2 });
    assert.strictEqual(theirs.Friendship, 96.8);
    assert.strictEqual(mine.Friendship, 96.8);
    // A cold reply never raises either side.
    theirs.Friendship = 60; mine.Friendship = 70;
    await r.fromFelt(pair('friend'), snap(2), { level: -1 });
    assert.ok(theirs.Friendship <= 60 && mine.Friendship <= 70);
});
