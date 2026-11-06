'use strict';
// The Texts list in one file (lib/smsindex.js): the same newest message, unread count and status
// the phone would work out from every box itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SmsIndex, threadRow, groupRow, newest } = require('../lib/smsindex');

function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}

test('a chat row: newest message across both directions, unread after seen, status', () => {
    const sms = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-'));
    write(path.join(sms, '1-2', 'outbox.cfg'), [{ id: 'a', text: '在吗', at: 100 }]);
    write(path.join(sms, '1-2', 'inbox.cfg'), [{ id: 'b', text: '在', at: 200 }, { id: 'c', text: '咋了', at: 300 }, { id: 'n', text: '心事', at: 50, kind: 'notice' }]);
    write(path.join(sms, '1-2', 'seen.cfg'), { at: 200 });
    write(path.join(sms, '1-2', 'status.cfg'), { state: 'online' });
    // The other way round (2 played, texting 1): what 2 typed is theirs here, and a notice in
    // that inbox is not.
    write(path.join(sms, '2-1', 'outbox.cfg'), [{ id: 'd', text: '晚安', at: 400 }]);
    write(path.join(sms, '2-1', 'inbox.cfg'), [{ id: 'e', text: '旧的', at: 10 }, { id: 'f', text: '别人的心事', at: 500, kind: 'notice' }]);
    const row = threadRow(sms, '1', '2');
    assert.strictEqual(row.last.text, '晚安');
    assert.strictEqual(row.last.side, 'theirs');
    assert.strictEqual(row.last.id, 'r-d');
    // 300 and 400 are after seen 200; the notice at 50 is not.
    assert.strictEqual(row.unread, 2);
    assert.strictEqual(row.theirsAt, 400);
    assert.deepStrictEqual(row.status, { state: 'online' });
    // The banner's newest incoming line: the notices in this chat's own inbox count, as on the phone.
    assert.deepStrictEqual(row.lastIn, { id: 'r-d', text: '晚安', at: 400 });
});

test('ties go the phone\'s way, photos and voice notes are kept, junk is dropped', () => {
    const last = newest([{ id: 'm', text: 'x', at: 5 }], [{ id: 't', text: 'y', at: 5 }]);
    assert.strictEqual(last.side, 'theirs');
    const sms = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-'));
    write(path.join(sms, '1-3', 'inbox.cfg'), [
        { id: 'p', text: '', at: 10, image: { id: '0123456789abcdef', width: 10, height: 20 } },
        { id: 'v', text: '语音', at: 20, voice: { id: 'fedcba9876543210', seconds: 3 } },
        { id: 'bad', at: 30 },
        null
    ]);
    const row = threadRow(sms, '1', '3');
    assert.strictEqual(row.last.id, 'v');
    assert.strictEqual(row.last.voice.seconds, 3);
    assert.strictEqual(row.unread, 2);
    // A chat with no files at all.
    assert.deepStrictEqual(threadRow(sms, '1', '9'), { last: null, unread: 0, theirsAt: 0, lastIn: null, status: null });
});

test('a group row and who sees it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-'));
    const sms = path.join(root, 'sms');
    const groups = path.join(root, 'groups');
    write(path.join(sms, '1-2', 'inbox.cfg'), [{ id: 'b', text: '在', at: 200 }]);
    write(path.join(sms, '5-2', 'inbox.cfg'), [{ id: 'z', text: '别人的', at: 200 }]);
    write(path.join(groups, 'g-cls1', 'meta.cfg'), { id: 'cls1', name: '高二(3)班', owner: '7', members: [{ id: '1' }, { id: '7' }] });
    write(path.join(groups, 'g-cls1', 'inbox.cfg'), [{ id: 'g1', from: '7', name: '小白', text: '作业', at: 50 }, { id: 'g2', from: '7', name: '小白', text: '写完没', at: 60 }]);
    write(path.join(groups, 'g-cls1', 'outbox.cfg'), [{ id: 'o1', from: '1', text: '没', at: 60 }]);
    write(path.join(groups, 'g-cls1', 'seen.cfg'), { at: 50 });
    write(path.join(groups, 'g-other', 'meta.cfg'), { id: 'other', owner: '8', members: [{ id: '8' }, { id: '9' }] });
    write(path.join(groups, 'g-gone', 'meta.cfg'), { id: 'gone', owner: '1', members: [{ id: '1' }, { id: '7' }], closed: true });
    const g = groupRow(groups, 'cls1');
    // Same time: the player's own line is the newer one, as on the phone.
    assert.strictEqual(g.last.side, 'mine');
    assert.strictEqual(g.unread, 1);

    const d = { log: { debug() {} }, world: { possessed: async () => '1' } };
    const idx = new SmsIndex(d);
    idx.configure(sms, groups);
    await idx.tick();
    const out = JSON.parse(fs.readFileSync(path.join(sms, 'index.cfg'), 'utf8'));
    assert.strictEqual(out.v, 1);
    assert.strictEqual(out.player, '1');
    assert.deepStrictEqual(Object.keys(out.threads), ['2']);
    assert.deepStrictEqual(Object.keys(out.groups), ['cls1']);
    assert.ok(Math.abs(Date.now() - out.at) < 5000);
    // Nothing changed: not written again until the heartbeat is due.
    const at = out.at;
    await idx.tick();
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sms, 'index.cfg'), 'utf8')).at, at);
    // A new message: written at once.
    write(path.join(sms, '1-2', 'inbox.cfg'), [{ id: 'b', text: '在', at: 200 }, { id: 'c', text: '新的', at: 900 }]);
    await idx.tick();
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sms, 'index.cfg'), 'utf8')).threads['2'].last.text, '新的');
});
