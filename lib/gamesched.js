'use strict';
// The week of the played household from the game's own schedule: work and school, the commute,
// the plans the player made (go to the gallery on Sunday 12:00-16:00) and one-off events such as
// a contest. Only the game's B1 side can read it, so the HouseholdJournal Lua mod (B1 Schedules)
// writes it to its bridge/schedule.cfg, for the characters this module lists in bridge/schedids.cfg.
//
// schedule.cfg: characters joined by "|", each "<id>:<entry>;<entry>..." with
//   entry = <day 0 Monday..6 Sunday>,<start HHmm>,<end HHmm>,<b base|o one-off>,<site>,<schedule name>,
//           <timeline name>,<control state>,<social event type>,<event title, percent-encoded>
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');
const paths = require('./paths');

class GameSchedule {
    constructor(log) {
        this.log = log || null;
        this.wanted = new Set();
        this.mtime = 0;
        this.byId = new Map();
    }

    dir() {
        const mod = paths.findMod(paths.JOURNAL_MOD_ID);
        return mod ? path.join(mod, 'bridge') : '';
    }

    // Asks the Lua mod for these characters' weeks (it writes them within about 30 s).
    want(ids) {
        let added = false;
        for (const id of ids) {
            if (id && !this.wanted.has(String(id))) {
                this.wanted.add(String(id));
                added = true;
            }
        }
        if (!added) return;
        const dir = this.dir();
        if (!dir) return;
        try {
            fsx.writeAtomic(path.join(dir, 'schedids.cfg'), Array.from(this.wanted).sort().join(','));
        } catch (e) {
            if (this.log) this.log.warn('schedule: ids not written: ' + e.message);
        }
    }

    // The entries of one character, or null when the mod has not written them.
    entriesOf(id) {
        this.read();
        return this.byId.has(String(id)) ? this.byId.get(String(id)) : null;
    }

    read() {
        const dir = this.dir();
        if (!dir) return;
        const file = path.join(dir, 'schedule.cfg');
        let st;
        try { st = fs.statSync(file); } catch (e) { return; }
        if (st.mtimeMs === this.mtime) return;
        this.mtime = st.mtimeMs;
        const text = fsx.readText(file) || '';
        const byId = new Map();
        for (const part of text.split('|')) {
            const m = /^(\d+):(.*)$/.exec(part);
            if (!m) continue;
            const list = [];
            for (const e of m[2].split(';')) {
                const f = e.split(',');
                if (f.length < 9) continue;
                const day = Number(f[0]);
                const start = Number(f[1]);
                const end = Number(f[2]);
                if (!(day >= 0 && day <= 6) || !isFinite(start) || !isFinite(end) || start === end) continue;
                const site = f[4] && f[4] !== 'None' ? f[4] : '';
                const name = f[5] && f[5] !== 'None' ? f[5] : '';
                if (!site && !name) continue;
                let title = '';
                try { title = decodeURIComponent(f[9] || ''); } catch (err) { title = ''; }
                list.push({
                    day, start, end, once: f[3] === 'o', site, name,
                    timeline: f[6] && f[6] !== 'None' ? f[6] : '', state: Number(f[7]) || 0, title: title.trim()
                });
            }
            list.sort((a, b) => a.day - b.day || a.start - b.start);
            byId.set(m[1], list);
        }
        this.byId = byId;
    }
}

module.exports = { GameSchedule };
