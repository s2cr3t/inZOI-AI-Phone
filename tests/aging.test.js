'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Aging } = require('../lib/aging');

test('the stages are not all ten days: a high schooler nine days in still has six to go', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aging-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const a = new Aging({});
    a.configure(dir);
    // The live report of a family: high schooler, young adult, middle schooler.
    a.setReport([{ id: 1, step: 16, age: 34, progress: 9, dead: 99 }, { id: 2, step: 32, age: 63, progress: 23, dead: 98 }]);
    assert.equal(a.get(1).daysToNext, 6);
    assert.equal(a.get(1).nextStage, '青年');
    assert.equal(a.get(2).daysToNext, 7);
    // A world whose ages run twice as long: the stages not seen yet follow.
    const b = new Aging({});
    b.configure(fs.mkdtempSync(path.join(dir, 'b-')));
    b.setReport([{ id: 1, step: 16, age: 50, progress: 0, dead: 200 }]);
    assert.equal(b.get(1).daysToNext, 30);
});
