'use strict';
// A chat that follows on: the character remembers what it meant by its last message, does not
// answer questions nobody asked, and does not report a meal it did eat as one it could not.
const test = require('node:test');
const assert = require('node:assert');
const persona = require('../lib/persona');
const { Daemon } = require('../lib/daemon');

const t = { call: '亚廷', them: '她' };

test('the riddle it set comes back with the next reply', () => {
    const line = persona.lastThoughtLine({ lastThought: { at: Date.now(), text: '刚放完屁，让她猜我干了什么坏事', said: '亚廷，我刚干了个坏事 / 你猜' } }, t);
    assert.match(line, /刚放完屁/);
    assert.match(line, /你猜/);
    assert.match(line, /照你心里的答案说猜对没有/);
    assert.match(line, /别把她的猜测当成指责/);
    assert.strictEqual(persona.lastThoughtLine({}, t), '');
    assert.strictEqual(persona.lastThoughtLine({ lastThought: { text: '' } }, t), '');
});

test('the rules forbid answering a question the player never asked', () => {
    const snap = {
        role: 'family', label: '弟弟', env: { day: 1, hour: 20, minute: 0 },
        player: { name: '钟亚廷', firstName: '亚廷', gender: 'Female', ageGroup: 'HighTeen' },
        partner: { name: '宗子怡', gender: 'Male', ageGroup: 'Child', activity: {}, work: {} }
    };
    const p = persona.rulesBlock(snap, { reply: { max_bubbles: 3, bubble_max_chars: 40 } });
    assert.match(p, /不要自问自答/);
});

test('a meal failure right after a meal that happened is not told', () => {
    const logs = [];
    const fake = {
        log: { info: (m) => logs.push(m) },
        state: { pair: () => ({ finished: [{ kind: 'eat', at: 1000 }] }) }
    };
    const idle = { partner: { activity: { idle: true } } };
    // Failed two minutes after the meal finished: it was eaten already.
    const kept = Daemon.prototype.setbacksForReport.call(fake, 'k', [{ kind: 'eat', what: '吃披萨', at: 1000 + 2 * 60000 }, { kind: 'use', what: '放下披萨', at: 1000 + 60000 }], idle);
    assert.deepStrictEqual(kept.map((x) => x.what), ['放下披萨']);
    assert.ok(logs.some((l) => /dropped stale meal failure/.test(l)));
    // An hour after the last meal: a real failure, told.
    const later = Daemon.prototype.setbacksForReport.call(fake, 'k', [{ kind: 'eat', what: '吃晚饭', at: 1000 + 60 * 60000 }], idle);
    assert.strictEqual(later.length, 1);
});
