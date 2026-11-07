'use strict';
// app.js is built from src/phone (tools/build-phone.js): it must be up to date, and whole.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const { build, OUT } = require('../tools/build-phone');

test('app.js is what the src/phone pieces make, and parses as one script', () => {
    const text = build();
    assert.equal(fs.readFileSync(OUT, 'utf8'), text, 'run node tools/build-phone.js');
    assert.doesNotThrow(() => new vm.Script(text, { filename: 'app.js' }));
    assert.ok(!/[^\r]\n/.test(text), 'CRLF line endings throughout');
});
