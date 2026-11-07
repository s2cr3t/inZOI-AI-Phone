'use strict';
// A chore on food never takes the plate someone else is eating from (the game refuses it).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Daemon } = require('../lib/daemon');

test('putting food away skips the plate mom is eating from and takes the other one', async () => {
    const d = Object.create(Daemon.prototype);
    d.log = { info() {}, debug() {}, warn() {} };
    d.actions = {
        currentOf: async (id) => (id === '20522' ? { playing: true, interaction_bag_id: 'ServedCake_Eat', target_entity_id: 107549 } : { playing: false }),
        allObjectActions: async () => [{ id: 'Food_Fridge_Keeping', name: '冷藏' }]
    };
    const known = new Map([
        ['107549', { id: '107549', name: '韩式煎饼', state: '能吃的食物', meters: 1 }],
        ['106909', { id: '106909', name: '家庭装韩式煎饼', state: '能吃的食物', meters: 5 }]
    ]);
    const snap = { player: { id: '20522', name: '宗会荣' }, others: [], partner: { ageGroup: 'LowTeen' } };
    const step = await d.choreRoute({ type: 'use_object', want: '把剩饭放冰箱' }, { partnerId: '43386' }, snap, known);
    assert.equal(step.objectId, '106909');
    assert.equal(step.interaction.id, 'Food_Fridge_Keeping');
});
