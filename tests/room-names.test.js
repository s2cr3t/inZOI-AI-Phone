'use strict';
// A room the player named on the phone (我的家) is named their way in every label the AI reads
// (lib/rooms.js setNames / label / overview).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { Rooms, roomKey } = require('../lib/rooms');

test('the player names a room: kind, whose bedroom, or a name of their own', () => {
    const rooms = new Rooms(path.join(os.tmpdir(), 'rooms-names-' + Date.now() + '.json'));
    const rows = [
        { id: '501', name: '双人床', x: 0, y: 0, z: 0 },
        { id: '502', name: '沙发', x: 900, y: 0, z: 0 },
        { id: '503', name: '冰箱', x: 0, y: 900, z: 0 }
    ];
    const layout = rooms.layout('Site_A', rows, 1);
    const bed = layout.rooms.find((r) => r.kind === 'bed');
    const sofa = layout.rooms.find((r) => r.kind === 'living');
    const view = { self: '7', player: '8', playerWord: '妈妈', names: new Map([['9', '宗子怡']]) };
    assert.equal(roomKey(bed), 'r501');
    rooms.setNames('Site_A', { r501: { kind: 'bed', owner: '9' }, [roomKey(sofa)]: { kind: 'other', name: '琴房' } });
    assert.equal(rooms.label(bed, layout, view), '宗子怡的卧室');
    assert.equal(rooms.label(sofa, layout, view), '琴房');
    rooms.setNames('Site_A', { r501: { kind: 'bed', owner: '7' } });
    assert.equal(rooms.label(bed, layout, view), '你的卧室', 'the one speaking hears it as theirs');
    assert.ok(rooms.overview(layout, view).join('').indexOf('你的卧室') >= 0);
});
test('a bedroom set for two is both of theirs; an older single owner still reads', () => {
    const { Rooms } = require('../lib/rooms');
    const r = Object.create(Rooms.prototype);
    const view = { self: '1', player: '2', playerWord: '亚廷', names: new Map([['3', '子怡']]) };
    assert.equal(r.setText({ kind: 'bed', owners: ['2', '1'] }, view), '你和亚廷的卧室');
    assert.equal(r.setText({ kind: 'bed', owner: '3' }, view), '子怡的卧室');
});
