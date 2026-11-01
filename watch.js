'use strict';
// Only for mode "cursor": wakes the Cursor agent when a phone thread has an unanswered text,
// so the agent can answer through the inzoi-sms MCP. In mode "auto" the bridge answers and
// this watcher stays silent.
const config = require('./lib/config');
const { Mailbox } = require('./lib/mailbox');

let announced = '';
let announcedAt = 0;

function check() {
    const cfg = config.load().config;
    if (cfg.mode !== 'cursor') {
        announced = '';
        return;
    }
    const mb = new Mailbox({ dir: cfg.mailbox.dir });
    let newest = null;
    for (const th of mb.threads()) {
        const t = mb.thread(th.key);
        if (!t || !t.pending.length) continue;
        const m = t.pending[t.pending.length - 1];
        if (!newest || m.at > newest.at) {
            const s = mb.readStatus(th.key) || {};
            newest = { id: m.id, at: m.at, thread: th.key, name: s.partnerName || ('#' + th.contactId) };
        }
    }
    if (!newest) {
        announced = '';
        return;
    }
    if (newest.id !== announced || Date.now() - announcedAt >= 45000) {
        announced = newest.id;
        announcedAt = Date.now();
        process.stdout.write('AGENT_LOOP_WAKE_sms ' + JSON.stringify({
            prompt: 'Unanswered inZOI phone text in thread ' + newest.thread + ' (to ' + newest.name + '). Call sms_thread with thread "' +
                newest.thread + '", then sms_reply once in character as ' + newest.name + ' with the same thread. Then keep listening.'
        }) + '\n');
    }
}

console.log('sms-watch started (active only in mode "cursor")');
setInterval(check, 500);
check();
