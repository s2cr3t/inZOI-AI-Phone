'use strict';
// The class chat's cards: each classmate a part of their own, kept; and the lines that only say
// again what was just said are caught.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClassCards, repeats, wornOut } = require('../lib/classcards');

test('classmates get parts of their own, kept, and echoes are caught', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cards = new ClassCards({ log: { info() {}, warn() {} } });
    cards.configure(dir);
    const emojiNames = ['偷笑', '捂脸', '白眼', '开心', '鼓掌'];
    const ids = ['101', '102', '103', '104', '105', '106', '107'];
    const roles = ids.map((id, i) => cards.card('cls1', id, { owner: '101', traits: i === 1 ? ['Intellect'] : [], emojiNames }).role);
    assert.equal(roles[0], 'monitor', 'the group owner is the monitor');
    assert.equal(roles[1], 'swot', 'the traits pick the part');
    assert.equal(new Set(roles).size, roles.length, 'no two classmates with one part');
    // Kept: asked again (or after a restart), the same card.
    const again = new ClassCards({ log: { info() {}, warn() {} } });
    again.configure(dir);
    assert.deepEqual(again.card('cls1', '104', { emojiNames }), cards.card('cls1', '104', { emojiNames }));
    assert.match(cards.text(cards.card('cls1', '102', {})), /学霸/);

    const recent = ['作业本比我惨，这话我认了[捂脸]', '加班没钱，这作业本比我惨[偷笑]', '闹钟三遍，我直接按掉继续睡'];
    assert.ok(repeats('作业本比我惨这话我也认', recent));
    assert.ok(repeats('闹钟三遍我还能再躺十分钟', recent));
    assert.ok(!repeats('明天数学考试你们复习了吗', recent));
    const worn = wornOut(recent.concat(['作业本比我惨，那我庆幸[捂脸]', '[捂脸]']));
    assert.deepEqual(worn.phrases, ['作业本比我惨']);
    assert.deepEqual(worn.emoji, ['[捂脸]']);
});
