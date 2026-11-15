'use strict';
// A household that moves to another city gets new entity ids from the game. It is recognised by
// its people's names and its files are re-keyed to the new ids, with a copy of everything kept;
// the same character in another household is not taken for a move (lib/households.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Households, movedMap } = require('../lib/households');

function touch(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const roster = (list) => list.map(([id, last, first]) => ({ entity_id: id, last_name: last, first_name: first }));

test('a family that moved city keeps its chats and memories under the new ids', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-move-'));
    const data = path.join(root, 'data');
    const phone = path.join(root, 'phone');
    const h = new Households({ dataDir: data });
    h.configure(phone);
    // Played in 道源 first.
    const dowon = { id: 20520, name: '宗', members: roster([[20522, '宗', '会荣'], [43386, '宗', '子怡']]) };
    const first = h.identify(dowon);
    h.touch(first.entry, first.roster, first.name, first.householdId);
    touch(path.join(data, 'memory', '20522-43386.json'), { facts: [{ text: '煎饼', day: 3 }], who: [20522, 43386], friend: '20522-30001' });
    touch(path.join(data, 'ties.json'), { ties: { '43386>20522': { warmth: 2 } } });
    touch(path.join(data, 'rooms.json'), { rooms: ['客厅'] });
    touch(path.join(phone, 'sms', '20522-43386', 'inbox.cfg'), [{ id: 'h-1-1', text: '妈', at: 1 }]);
    touch(path.join(phone, 'persona', '43386', 'folders.cfg'), { v: 1 });
    touch(path.join(phone, 'moments', 'feed.cfg'), { posts: [{ id: 'p1', authorId: '43386', likes: [{ id: '20522' }], text: '你好' }], circles: { 43386: { ids: ['20522', '30001'] } } });

    // Moved to Bliss Bay: the same people, new ids.
    const bliss = { id: 24532, name: '宗', members: roster([[24534, '宗', '会荣'], [24540, '宗', '子怡']]) };
    const d = h.identify(bliss);
    assert.equal(d.kind, 'moved');
    assert.deepEqual(d.map, { 20522: '24534', 43386: '24540' });
    assert.equal(d.from, null, 'the files on disk are already theirs');
    const backup = h.moveTo(d);

    const mem = path.join(data, 'memory', '24534-24540.json');
    assert.ok(fs.existsSync(mem), 'the pair file carries the new ids');
    assert.deepEqual(read(mem).who, [24534, 24540]);
    assert.equal(read(mem).friend, '24534-30001', 'someone outside the family keeps their id');
    assert.deepEqual(Object.keys(read(path.join(data, 'ties.json')).ties), ['24540>24534']);
    assert.ok(fs.existsSync(path.join(phone, 'sms', '24534-24540', 'inbox.cfg')));
    assert.ok(fs.existsSync(path.join(phone, 'persona', '24540', 'folders.cfg')));
    const feed = read(path.join(phone, 'moments', 'feed.cfg'));
    assert.equal(feed.posts[0].authorId, '24540');
    assert.equal(feed.posts[0].likes[0].id, '24534');
    assert.deepEqual(feed.circles['24540'].ids, ['24534', '30001']);
    assert.ok(!fs.existsSync(path.join(data, 'rooms.json')), 'the old home is not the new one');
    // Everything as it was, kept.
    assert.ok(fs.existsSync(path.join(backup, 'data', 'memory', '20522-43386.json')));
    assert.ok(fs.existsSync(path.join(backup, 'data', 'rooms.json')));
    assert.ok(fs.existsSync(path.join(backup, 'phone', 'sms', '20522-43386', 'inbox.cfg')));
    // The record follows: played again, it is the same household.
    assert.equal(h.identify(bliss).kind, 'same');
    fs.rmSync(root, { recursive: true, force: true });
});

test('not a move: another family name, someone more or less, two of the same name', () => {
    const known = { 20522: { first: '会荣', full: '宗会荣' }, 43386: { first: '子怡', full: '宗子怡' } };
    const now = { 24534: { first: '会荣', full: '宗会荣' }, 24540: { first: '子怡', full: '宗子怡' } };
    assert.ok(movedMap(known, now, '宗', '宗'));
    assert.equal(movedMap(known, now, '宗', '钟'), null, 'another household with these names');
    assert.equal(movedMap(known, { 24534: now[24534] }, '宗', '宗'), null, 'the same character on their own somewhere else');
    assert.equal(movedMap(known, Object.assign({ 24542: { first: '亚廷', full: '钟亚廷' } }, now), '宗', '宗'), null);
    const twins = { 1: { first: '明', full: '李明' }, 2: { first: '明', full: '李明' } };
    assert.equal(movedMap(twins, { 5: twins[1], 6: twins[2] }, '李', '李'), null, 'two of one name cannot be told apart');
    assert.equal(movedMap(known, { 20522: known[20522], 24540: now[24540] }, '宗', '宗'), null, 'ids shared: not a new world');
});
