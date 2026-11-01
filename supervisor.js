#!/usr/bin/env node
'use strict';
// inZOI AI Phone guardian. Started hidden at Windows logon by inZOIPhone.exe (installed) or by
// the Startup entry of `node bridge.js autostart on` (development copy). It waits for the
// game and runs the reply service while AI is switched on in the phone's AI app.
const { Guardian } = require('./lib/guardian');

new Guardian().run().then((code) => {
    if (code) process.exit(code);
}, (e) => {
    process.stderr.write((e && e.stack || e) + '\n');
    process.exit(1);
});
