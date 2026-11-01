'use strict';
// How old everyone is, and how long until they grow up, grow old or die.
//
// The MCP tables carry only a life stage (`age_group`: 幼儿 / 儿童 / 青年 ...), but the Bio
// component behind it holds the numbers the game's own UI shows: the age in days, how many days
// the person has spent in the stage they are in, and the age the game picked for their death.
// No MCP tool reads those, so the HouseholdJournal Lua mod prints them (line A) and the bridge
// takes them off the Lua log (lib/journal.js). Everything the phone's AI says about growing up
// comes from here.
//
// The units, as measured against the running game:
//   age       days since birth -- a newborn is near 0, an elderly Zoi is in the nineties
//   progress  days spent in the current stage, so the stage ends at the stage length
//   dead      the day of death the game chose for this person (99 for most adults)
// Every row of the Aging table gives the same length, TimeToNextAge 1440 (tenths of a game
// minute): 1440 / 144 = 10 days a stage. A stage the household was seen growing through, at two
// known ages, replaces that estimate with what was measured (data/aging.json).
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');

// EB1GrowthStep: powers of two, because the game compares stages as bit flags.
const STAGES = [
    { value: 1, key: 'Infant', zh: '婴儿' },
    { value: 2, key: 'Toddler', zh: '幼儿' },
    { value: 4, key: 'Child', zh: '儿童' },
    { value: 8, key: 'LowTeen', zh: '少年' },
    { value: 16, key: 'HighTeen', zh: '青少年' },
    { value: 32, key: 'Youth', zh: '青年' },
    { value: 64, key: 'Adult', zh: '成年' },
    { value: 128, key: 'Old', zh: '中年' },
    { value: 256, key: 'Elderly', zh: '老年' }
];
const BY_VALUE = new Map(STAGES.map((s) => [s.value, s]));
const ADULT = 64;
// 1440 tenths of a game minute a stage, 144 of them to a day.
const STAGE_DAYS = 10;
// A report older than this is not used. Generous on purpose: ages only move while the game runs,
// and the Lua mod stops printing while it is paused, so a pause is not old news. Loading another
// world restarts the mod, which clears what it said before.
const STALE_MS = 60 * 60 * 1000;
const KEEP_GROWN = 12;

function stageOf(step) {
    return BY_VALUE.get(Number(step)) || null;
}

function stageZh(step) {
    const s = stageOf(step);
    return s ? s.zh : '';
}

class Aging {
    constructor(options) {
        const o = options || {};
        this.log = o.log || null;
        this.file = null;
        // id -> { step, age, progress, dead, born, at }
        this.report = new Map();
        this.data = { stageDays: {}, grown: {}, pending: {} };
    }

    configure(dir) {
        this.file = path.join(dir, 'aging.json');
        if (fs.existsSync(this.file)) {
            try {
                const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (raw && typeof raw === 'object') {
                    this.data.stageDays = raw.stageDays && typeof raw.stageDays === 'object' ? raw.stageDays : {};
                    this.data.grown = raw.grown && typeof raw.grown === 'object' ? raw.grown : {};
                    this.data.pending = raw.pending && typeof raw.pending === 'object' ? raw.pending : {};
                }
            } catch (e) {
                if (this.log) this.log.warn('aging: settings unreadable, starting fresh: ' + e.message);
            }
        }
    }

    save() {
        if (!this.file) return;
        try {
            fsx.writeJson(this.file, this.data, true);
        } catch (e) {
            if (this.log) this.log.warn('aging: not saved: ' + e.message);
        }
    }

    // The Lua mod started again (another save, another world): what it said before is not ours.
    reset() {
        this.report.clear();
    }

    // One A line from the mod: entries of { id, step, age, progress, dead, born }.
    setReport(entries) {
        const at = Date.now();
        for (const e of entries || []) {
            const id = String(e.id || '');
            if (!id) continue;
            const before = this.report.get(id);
            const row = {
                step: Number(e.step) || 0,
                age: Number(e.age),
                progress: Number(e.progress),
                dead: Number(e.dead),
                born: Number(e.born),
                at
            };
            if (!Number.isFinite(row.age)) continue;
            // Growing up between two reports is the one moment the length of a stage can be
            // measured: the age now, minus the age when the stage began.
            if (before && before.step && row.step && before.step !== row.step && row.age > before.age) {
                this.noteGrown(id, before, row);
            }
            this.report.set(id, row);
        }
    }

    noteGrown(id, before, row) {
        const from = stageZh(before.step) || String(before.step);
        const to = stageZh(row.step) || String(row.step);
        const grown = this.data.grown[id] && Array.isArray(this.data.grown[id]) ? this.data.grown[id] : [];
        grown.push({ from, to, day: row.age });
        this.data.grown[id] = grown.slice(-KEEP_GROWN);
        // A length is only worth measuring between two growth changes this bridge saw: entered
        // the stage at one age, left it at another. A Zoi created mid-stage in the character
        // editor says nothing about how long a stage lasts.
        const pending = this.data.pending[id];
        if (pending && Number(pending.step) === Number(before.step) && row.age > pending.age) {
            const days = Math.round((row.age - pending.age) * 10) / 10;
            if (days > 0 && days < 400) {
                const key = String(before.step);
                const seen = Number(this.data.stageDays[key]);
                this.data.stageDays[key] = seen ? Math.round((seen + days) / 2 * 10) / 10 : days;
                if (this.log) this.log.info('aging: a ' + from + ' stage lasted ' + days + ' days (' + id + ', ' + pending.age + ' -> ' + row.age + ')');
            }
        }
        this.data.pending[id] = { step: Number(row.step), age: row.age };
        if (this.log) this.log.info('aging: ' + id + ' grew from ' + from + ' to ' + to + ' at ' + row.age + ' days');
        this.save();
    }

    // How many days a stage lasts: what the household was seen living through, else the table.
    stageDays(step) {
        const seen = Number(this.data.stageDays[String(step)]);
        return seen > 0 ? seen : STAGE_DAYS;
    }

    // Everything worth saying about one person, or null when the mod has not reported them.
    get(id) {
        const row = this.report.get(String(id));
        if (!row || !stageOf(row.step)) return null;
        if (Date.now() - row.at > STALE_MS) return null;
        const stage = stageOf(row.step);
        const length = this.stageDays(row.step);
        const into = Math.max(0, Math.min(length, Number.isFinite(row.progress) ? row.progress : 0));
        const toNext = Math.max(0, Math.round(length - into));
        const at = STAGES.findIndex((s) => s.value === stage.value);
        const adultAt = STAGES.findIndex((s) => s.value === ADULT);
        let toAdult = 0;
        if (at > adultAt) toAdult = 0;
        else if (at === adultAt) toAdult = 0;
        else {
            toAdult = toNext;
            for (let i = at + 1; i < adultAt; i++) toAdult += this.stageDays(STAGES[i].value);
        }
        const toDeath = Number.isFinite(row.dead) && row.dead > row.age ? Math.round(row.dead - row.age) : null;
        const next = at >= 0 && at + 1 < STAGES.length ? STAGES[at + 1] : null;
        return {
            step: stage.value,
            stage: stage.zh,
            stageKey: stage.key,
            ageDays: Math.round(row.age),
            daysInStage: Math.round(into * 10) / 10,
            stageDays: length,
            daysToNext: toNext,
            nextStage: next ? next.zh : '',
            nextKey: next ? next.key : '',
            nextIsAdult: !!next && next.value === ADULT,
            daysToAdult: toAdult,
            adult: stage.value >= ADULT,
            daysToDeath: toDeath,
            // True when the numbers are the game's table and not a stage measured here.
            estimated: !this.data.stageDays[String(stage.value)]
        };
    }

    // One short Chinese line for the prompt, e.g.
    //   钟亚廷：14 天，儿童。再过 6 天进入少年，成年还要 36 天，离老去还有 85 天。
    line(id, name) {
        return phrase(this.get(id), name);
    }

    // The whole household, for the prompt block. Empty when the mod is not reporting ages.
    lines(members) {
        const out = [];
        for (const m of members || []) {
            const line = this.line(m.id, m.name);
            if (line) out.push(line);
        }
        return out;
    }
}

// One person's numbers as a sentence. `a` is what get() returns, so this reads the same whether
// the numbers came from the bridge or from a snapshot built earlier.
function phrase(a, name) {
    if (!a || !a.stage) return '';
    const head = (name ? name + '：' : '') + a.ageDays + ' 天，' + a.stage + '。';
    if (a.adult) {
        return head + (a.daysToDeath !== null && a.daysToDeath !== undefined
            ? '离老去还有 ' + a.daysToDeath + ' 天。'
            : '');
    }
    const bits = [];
    if (a.nextIsAdult) {
        // The next stage is adulthood: one milestone, said once.
        bits.push('再过 ' + a.daysToNext + ' 天成年');
    } else {
        if (a.nextStage) bits.push('再过 ' + a.daysToNext + ' 天进入' + a.nextStage);
        bits.push('成年还要 ' + a.daysToAdult + ' 天');
    }
    if (a.daysToDeath !== null && a.daysToDeath !== undefined) bits.push('离老去还有 ' + a.daysToDeath + ' 天');
    return head + bits.join('，') + '。';
}

module.exports = { Aging, STAGES, STAGE_DAYS, stageOf, stageZh, phrase };
