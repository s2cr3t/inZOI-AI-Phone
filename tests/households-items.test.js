'use strict';
// A household switch carries the files of the suitor, the class chats, the relationship moves and
// the phone's Texts folders with the household they belong to (lib/households.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Households, DATA_ITEMS, PHONE_ITEMS } = require('../lib/households');

function touch(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text || '{}');
}

test('the new per-household files are on the switch lists', () => {
    for (const n of ['suitors.json', 'classgroups.json', 'relsync.json']) assert.ok(DATA_ITEMS.includes(n), n);
    const phone = (dir, name) => PHONE_ITEMS.some((p) => p.dir === dir && p.match.test(name));
    assert.ok(phone('suitor', 'board.cfg'));
    assert.ok(phone('groups', 'school.cfg'));
    assert.ok(phone('groups', 'g-cls20524'));
    // persona/<id>/ holds the played character's folders.cfg.
    assert.ok(phone('persona', '20524'));
    // The service's own answers file and the index are not one household's.
    assert.ok(!phone('sms', 'index.cfg'));
});

test('switching households moves them out and brings the other household\'s back', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-'));
    const data = path.join(root, 'data');
    const phone = path.join(root, 'phone');
    touch(path.join(data, 'suitors.json'), '{"a":1}');
    touch(path.join(data, 'classgroups.json'));
    touch(path.join(data, 'relsync.json'));
    touch(path.join(phone, 'suitor', 'board.cfg'));
    touch(path.join(phone, 'groups', 'school.cfg'));
    touch(path.join(phone, 'persona', '20524', 'folders.cfg'), '{"v":1,"folders":[{"id":"f1","name":"同学"}]}');
    // What the other household left in its archive.
    const other = path.join(data, 'households', 'hh-b');
    touch(path.join(other, 'data', 'suitors.json'), '{"b":1}');
    const h = new Households({ dataDir: data, phoneDir: phone });
    const moves = h.plan({ tag: 'hh-a' }, { tag: 'hh-b' });
    const from = (p) => moves.some((m) => m.src === p);
    assert.ok(from(path.join(data, 'suitors.json')));
    assert.ok(from(path.join(data, 'classgroups.json')));
    assert.ok(from(path.join(data, 'relsync.json')));
    assert.ok(from(path.join(phone, 'suitor', 'board.cfg')));
    assert.ok(from(path.join(phone, 'groups', 'school.cfg')));
    assert.ok(from(path.join(phone, 'persona', '20524')));
    assert.ok(moves.some((m) => m.src === path.join(other, 'data', 'suitors.json') && m.dst === path.join(data, 'suitors.json')));
});
