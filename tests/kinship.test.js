'use strict';
// Kinship between household members from the possessed character's labels (world.kinOf).
const test = require('node:test');
const assert = require('node:assert');
const { kinOf } = require('../lib/world');

// A mother, her younger sister, and the mother's two children. Labels are what each member is to
// the possessed character, so they change with who is played.
function household(possessed, labels) {
    const members = [
        { entity_id: 1, first_name: 'Mom', gender: 'Female', age_group: 'Adult' },
        { entity_id: 2, first_name: 'Aunt', gender: 'Female', age_group: 'Adult' },
        { entity_id: 3, first_name: 'Girl', gender: 'Female', age_group: 'Teen' },
        { entity_id: 4, first_name: 'Boy', gender: 'Male', age_group: 'Child' }
    ];
    for (const m of members) m.relationship_label = labels[m.entity_id] || '';
    return { members, possessed: String(possessed) };
}
const byId = (hh, id) => hh.members.find((m) => m.entity_id === id);
const kin = (hh, a, b) => kinOf(byId(hh, a), byId(hh, b), hh);

test('mother played: her sister is the children\'s aunt, not their mother', () => {
    const hh = household(1, { 2: '姐妹', 3: '女儿', 4: '儿子' });
    assert.deepStrictEqual(kin(hh, 3, 2), { role: 'family', label: '姨妈' });
    assert.deepStrictEqual(kin(hh, 4, 2), { role: 'family', label: '姨妈' });
    assert.deepStrictEqual(kin(hh, 2, 3), { role: 'family', label: '外甥女' });
    assert.deepStrictEqual(kin(hh, 2, 4), { role: 'family', label: '外甥' });
    assert.strictEqual(kin(hh, 3, 1).role, 'parent');
    assert.strictEqual(kin(hh, 1, 3).role, 'child');
    assert.deepStrictEqual(kin(hh, 4, 3), { role: 'family', label: '姐姐' });
    assert.deepStrictEqual(kin(hh, 3, 4), { role: 'family', label: '弟弟' });
});

test('child played: the game\'s own word for the aunt is kept', () => {
    const hh = household(3, { 1: '妈妈', 2: '阿姨', 4: '弟弟' });
    assert.deepStrictEqual(kin(hh, 3, 2), { role: 'family', label: '阿姨' });
    assert.strictEqual(kin(hh, 3, 1).role, 'parent');
    assert.strictEqual(kin(hh, 2, 3).role, 'family');
    assert.strictEqual(kin(hh, 4, 1).role, 'parent');
});

test('aunt played: she is nobody\'s mother, the real mother still is', () => {
    const hh = household(2, { 1: '姐妹', 3: '外甥女', 4: '外甥' });
    assert.strictEqual(kin(hh, 3, 2).role, 'family');
    assert.strictEqual(kin(hh, 2, 4).role, 'family');
    assert.strictEqual(kin(hh, 3, 1).role, 'parent');
});

test('father played: his sister is 姑姑, his parent is 爷爷 / 奶奶 to his children', () => {
    const members = [
        { entity_id: 1, gender: 'Male', age_group: 'Adult', relationship_label: '' },
        { entity_id: 2, gender: 'Female', age_group: 'Adult', relationship_label: '姐妹' },
        { entity_id: 3, gender: 'Male', age_group: 'Elder', relationship_label: '爸爸' },
        { entity_id: 4, gender: 'Female', age_group: 'Child', relationship_label: '女儿' }
    ];
    const hh = { members, possessed: '1' };
    assert.deepStrictEqual(kin(hh, 4, 2), { role: 'family', label: '姑姑' });
    assert.deepStrictEqual(kin(hh, 4, 3), { role: 'family', label: '爷爷' });
    assert.deepStrictEqual(kin(hh, 3, 4), { role: 'family', label: '孙女' });
});

test('no labels: age decides as before', () => {
    const hh = household(1, {});
    assert.strictEqual(kin(hh, 3, 2).role, 'parent');
    assert.strictEqual(kinOf(byId(hh, 2), byId(hh, 4)).role, 'child');
});

test('spouses stay spouses', () => {
    const hh = household(1, { 2: '姐妹' });
    byId(hh, 1).spouse_id = 2;
    assert.deepStrictEqual(kin(hh, 2, 1), { role: 'spouse', label: '' });
});

test('a contact\'s label makes a relative only when it is a family word', () => {
    const { isKinLabel } = require('../lib/world');
    for (const l of ['妈妈', '表哥', '姨妈', '亲戚', '哥哥']) assert.ok(isKinLabel(l), l);
    for (const l of ['知己', '朋友', '恋人', '同事', '…', '']) assert.ok(!isKinLabel(l), l);
});
