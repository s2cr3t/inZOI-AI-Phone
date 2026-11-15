'use strict';
// A character knows their own marriage, and an affair is told as one (lib/persona.js familyBlock).
const test = require('node:test');
const assert = require('node:assert/strict');
const persona = require('../lib/persona');

const t = { call: '亚廷', them: '她', me: '恋人' };
const snap = (family, extra) => Object.assign({
    family, role: 'romance', relationship: { Romance: 90 }, outsider: false,
    partner: { id: '2', ageGroup: 'Youth' }, player: { id: '1', ageGroup: 'Youth' }
}, extra);

test('married to someone else and in love with the player: an affair, known as one', () => {
    const text = persona.familyBlock(snap({ married: true, spouse: { id: '9', name: '全礼林', home: false }, home: [], player: { married: false, spouse: null } }), t);
    assert.match(text, /配偶是全礼林/);
    assert.match(text, /婚外情/);
    assert.match(text, /不会说自己单身/);
});

test('married to the player, or single and not in love: no affair', () => {
    assert.doesNotMatch(persona.familyBlock(snap({ married: true, spouse: { id: '1', name: '亚廷' }, home: [], player: { married: true, spouse: { id: '2' } } }), t), /婚外情/);
    const single = persona.familyBlock(snap({ married: false, spouse: null, home: [], player: { married: true, spouse: { id: '7', name: '某人' } } }, { role: 'friend', relationship: { Romance: 0 } }), t);
    assert.match(single, /你没有结婚/);
    assert.match(single, /已婚，配偶是某人/);
    assert.doesNotMatch(single, /婚外情/);
});

test('no affair talk where a minor is involved', () => {
    const text = persona.familyBlock(snap({ married: true, spouse: { id: '9', name: '某人' }, home: [], player: { married: false } }, { partner: { id: '2', ageGroup: 'Teen' } }), t);
    assert.doesNotMatch(text, /婚外情/);
});
