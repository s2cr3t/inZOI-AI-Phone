'use strict';
// Teenagers talk like teenagers: the game's LowTeen / HighTeen stages get the adolescent voice,
// bent for who they are texting, while children and adults keep theirs.
const test = require('node:test');
const assert = require('node:assert');
const persona = require('../lib/persona');
const { kinOf } = require('../lib/world');

const mom = { name: '宗会荣', firstName: '会荣', gender: 'Female', ageGroup: 'Youth' };
const style = (who) => persona.defaultStyle(who).text;
const teen = (role, extra) => Object.assign({
    role,
    label: '',
    player: mom,
    partner: { gender: 'Female', ageGroup: 'HighTeen' }
}, extra || {});

test('the game\'s teen stages are teens and minors', () => {
    for (const g of ['LowTeen', 'HighTeen', 'Teen']) {
        assert.ok(persona.isTeenGroup(g), g);
        assert.ok(persona.isMinorGroup(g), g);
    }
    for (const g of ['Child', 'Youth', 'Adult', '', undefined]) assert.ok(!persona.isTeenGroup(g), String(g));
    assert.ok(persona.isMinorGroup('Child'));
    assert.ok(!persona.isMinorGroup('Youth'));
});

test('who a teenager is texting', () => {
    assert.strictEqual(persona.teenAudience(teen('child')), 'parent');
    assert.strictEqual(persona.teenAudience(teen('family', { label: '孙女' })), 'elder');
    assert.strictEqual(persona.teenAudience(teen('family', { label: '外甥女' })), 'elder');
    assert.strictEqual(persona.teenAudience(teen('family', { label: '姐姐' })), 'sibling');
    // No label: an adult player is someone older, a minor one is a brother or sister.
    assert.strictEqual(persona.teenAudience(teen('family')), 'elder');
    const kid = Object.assign({}, mom, { ageGroup: 'Child' });
    assert.strictEqual(persona.teenAudience(teen('family', { player: kid })), 'sibling');
    assert.strictEqual(persona.teenAudience(teen('friend', { outsider: true, player: kid })), 'peer');
    assert.strictEqual(persona.teenAudience(teen('relative', { outsider: true })), 'elder');
    assert.strictEqual(persona.teenAudience(teen('acquaintance', { outsider: true })), 'adult');
});

test('a HighTeen daughter texts her mother like a teenager, not a child', () => {
    const s = style(teen('child'));
    assert.match(s, /青春期/);
    assert.match(s, /高中/);
    assert.match(s, /对妈妈：话最少/);
    assert.match(s, /网络流行语/);
    assert.match(s, /别扭不等于刻薄/);
    assert.doesNotMatch(s, /小学/);
    assert.doesNotMatch(s, /【你是个孩子】/);
});

test('LowTeen is middle school', () => {
    const s = style(teen('child', { partner: { gender: 'Male', ageGroup: 'LowTeen' } }));
    assert.match(s, /初中/);
    assert.match(s, /对妈妈：/);
});

test('the tone changes for siblings, elders and friends', () => {
    const sib = style(teen('family', { label: '姐姐', player: Object.assign({}, mom, { ageGroup: 'Child' }) }));
    assert.match(sib, /对兄弟姐妹/);
    assert.doesNotMatch(sib, /对妈妈/);
    const elder = style(teen('family', { label: '孙女' }));
    assert.match(elder, /（长辈）/);
    assert.match(elder, /对长辈不用网络词/);
    const kid = Object.assign({}, mom, { ageGroup: 'LowTeen' });
    const peer = persona.termsFor('friend', kid.gender, 'Female', kid.firstName);
    assert.strictEqual(peer.outsider, true);
    const friend = style(teen('friend', { outsider: true, player: kid }));
    assert.match(friend, /同龄/);
});

test('children and adults keep their own rules', () => {
    const child = style({ role: 'child', label: '', player: mom, partner: { gender: 'Male', ageGroup: 'Child' } });
    assert.match(child, /【你是个孩子】/);
    assert.match(child, /小学生/);
    assert.doesNotMatch(child, /青春期/);
    const parent = style({ role: 'parent', label: '', player: { name: '钟亚廷', firstName: '亚廷', gender: 'Female', ageGroup: 'HighTeen' }, partner: { gender: 'Female', ageGroup: 'Youth' } });
    assert.match(parent, /【你是家长】/);
    // The played teenager is still a minor to the parent.
    assert.match(parent, /还是孩子，不谈成人话题/);
    assert.doesNotMatch(parent, /青春期/);
    const family = style({ role: 'family', label: '姐妹', player: mom, partner: { gender: 'Female', ageGroup: 'Adult' } });
    assert.match(family, /【你是家人】/);
    assert.doesNotMatch(family, /青春期/);
});

test('the game\'s HighTeen counts as a minor for kinship by age', () => {
    const p = { entity_id: 1, gender: 'Female', age_group: 'Youth' };
    const c = { entity_id: 2, gender: 'Female', age_group: 'HighTeen' };
    assert.strictEqual(kinOf(p, c, null).role, 'child');
    assert.strictEqual(kinOf(c, p, null).role, 'parent');
    // A LowTeen and a HighTeen are younger and older siblings, not just 姐妹.
    const hh = {
        possessed: '1',
        members: [
            { entity_id: 1, gender: 'Female', age_group: 'Youth', relationship_label: '' },
            { entity_id: 2, gender: 'Female', age_group: 'HighTeen', relationship_label: '女儿' },
            { entity_id: 3, gender: 'Male', age_group: 'LowTeen', relationship_label: '儿子' }
        ]
    };
    assert.deepStrictEqual(kinOf(hh.members[2], hh.members[1], hh), { role: 'family', label: '姐姐' });
});

test('a teenager in a group chat is told how teens behave there; adults are not', () => {
    const base = (ageGroup) => ({
        snap: {
            role: 'child', label: '', env: { day: 3, hour: 20, minute: 0 },
            player: { name: '宗会荣', firstName: '会荣', gender: 'Female', ageGroup: 'Youth' },
            partner: { entity_id: 20524, id: '20524', name: '钟亚廷', firstName: '亚廷', gender: 'Female', ageGroup, activity: {}, work: {} }
        },
        cfg: { reply: { max_bubbles: 3, bubble_max_chars: 40 } },
        group: { name: '一家人' },
        roster: [],
        history: [],
        job: { kind: 'auto' }
    });
    const t = persona.groupPrompt(base('HighTeen')).system;
    assert.match(t, /群里的青少年/);
    assert.match(t, /青春期/);
    const a = persona.groupPrompt(Object.assign(base('Adult'), {})).system;
    assert.doesNotMatch(a, /群里的青少年/);
});
