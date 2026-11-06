'use strict';
// Offline tests for when a reply that agreed to something but listed no step gets its step asked
// for again (persona.needsActionRepair), with the player typing traditional characters
// (hanzi.simplify). No game, no API, no player data.
const test = require('node:test');
const assert = require('node:assert/strict');
const persona = require('../lib/persona');
const hanzi = require('../lib/hanzi');

const busy = [{ type: 'stop_current' }];
const asked = (text) => [{ text: hanzi.simplify(text) }];

test('traditional characters read as the simplified ones the checks know', () => {
    assert.equal(hanzi.simplify('快來吃飯啦'), '快来吃饭啦');
    assert.equal(hanzi.simplify('弟弟在幹嘛，還不來吃飯嗎'), '弟弟在干嘛，还不来吃饭吗');
    assert.equal(hanzi.simplify('去睡覺'), '去睡觉');
    assert.equal(hanzi.simplify('mixed 吃饭 text'), 'mixed 吃饭 text', 'simplified and other text pass through');
    assert.equal(hanzi.simplify(''), '');
    assert.equal(hanzi.simplify(null), null);
});

test('"吃飯啦" answered with "知道了" asks for the eating step', () => {
    assert.equal(persona.needsActionRepair([{ text: '吃飯啦' }], ['知道了[困]'], busy, {}), false, 'unconverted, the check cannot read it');
    assert.equal(persona.needsActionRepair(asked('吃飯啦'), ['知道了[困]'], busy, {}), true);
});

test('finishing what is in hand first is a later, and still needs the step', () => {
    assert.equal(persona.needsActionRepair(asked('吃飯啦'), ['知道了知道了，这首还有半分钟[困]'], busy, {}), true);
    assert.equal(persona.needsActionRepair(asked('在干嘛'), ['弹完就来'], busy, {}), true);
    assert.equal(persona.needsActionRepair(asked('在干嘛'), ['这首还有3分钟'], busy, {}), true);
});

test('a refusal, or a reply that already has its step, asks for nothing', () => {
    assert.equal(persona.needsActionRepair(asked('吃飯啦'), ['不想吃'], busy, {}), false);
    assert.equal(persona.needsActionRepair(asked('吃飯啦'), ['知道了'], [{ type: 'use_object', objectId: '1', want: '吃饭' }], {}), false);
});
