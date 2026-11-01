'use strict';
// The freelance board for the phone's Freelance page.
//
// The order list exists only in the game's simulation thread, which cannot write cfg files, so
// the HouseholdJournal Lua mod (Zoi.FreelanceServer) prints it to the Lua log and this module
// turns it into a file next to the SMS mailbox (<mod>/ui/phone/freelance/):
//   board.cfg    the board of the played character and the latest request results. Bridge only.
//   request.cfg  the phone's accept / cancel / license request. Phone only; the Lua mod reads it.
// board.cfg also says whether the Lua mod runs (source: ok | waiting | starting | down | missing),
// so the phone can say why there is no board instead of waiting for one.
//
// One board report in the log is L begin, then A (active order) and P (penalty) when there are
// any, one O per order, and L end with the order count. A report is written only once complete.
const path = require('path');
const fsx = require('./fsx');

const RESULTS_KEEP = 10;
const ORDERS_MAX = 200;
const SOURCE_REFRESH_MS = 30000;

function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : null;
}

function id(v) {
    return /^-?\d+$/.test(String(v || '')) && String(v) !== '-1' ? String(v) : '';
}

function word(v) {
    return v && v !== 'None' ? String(v) : '';
}

class Freelance {
    constructor(log) {
        this.log = log || null;
        this.dir = '';
        this.building = null;
        this.board = null;
        this.boardAt = 0;
        this.writtenAt = 0;
        this.results = [];
        this.source = { state: 'waiting', message: '' };
    }

    // Whether the Lua mod runs, from the reply service's watch on it. Written when it changes and
    // at least every 30 s, so the phone can tell a current status from one left by a stopped service.
    setSource(state, message) {
        const same = this.source.state === state && this.source.message === (message || '');
        if (same && Date.now() - this.writtenAt < SOURCE_REFRESH_MS) return;
        this.source = { state, message: message || '' };
        this.write();
    }

    configure(dir) {
        if (this.dir === dir) return;
        this.dir = dir;
        fsx.ensureDir(dir);
        if (this.log) this.log.info('freelance: board in ' + dir);
    }

    // The Lua mod started again (save loaded, game restarted, mod remounted).
    reset() {
        this.building = null;
    }

    // kind is the line's letter (L A P O R), body what follows it.
    onLine(kind, body) {
        const f = body.split(',');
        if (f.length < 3) return;
        const boot = f[0];
        if (kind === 'R') return this.onResult(f);
        const round = f[1];
        if (kind === 'L' && f[2] === 'begin') {
            this.building = {
                boot, round,
                me: id(f[3]),
                nowTicks: num(f[4]),
                initialized: f[5] === '1',
                playing: f[6] === '1',
                penalty: f[7] === '1',
                active: null,
                penaltyFlow: null,
                orders: []
            };
            return;
        }
        const b = this.building;
        if (!b || b.boot !== boot || b.round !== round) return;
        if (kind === 'A' && f.length >= 18) {
            b.active = {
                instanceId: id(f[2]),
                summaryId: id(f[3]),
                templateId: word(f[4]),
                status: num(f[5]),
                startedTicks: num(f[6]),
                expireTicks: num(f[7]),
                questIndex: num(f[8]),
                missions: num(f[9]),
                clientId: id(f[10]),
                recipientId: id(f[11]),
                targetType: num(f[12]),
                targetId: word(f[13]),
                recipeId: word(f[14]),
                crafting: f[15] === '1',
                craftPercent: num(f[16]),
                missionId: word(f[17])
            };
        } else if (kind === 'P' && f.length >= 6) {
            b.penaltyFlow = { path: num(f[2]), nextTicks: num(f[3]), templateId: word(f[4]), itemId: word(f[5]) };
        } else if (kind === 'O' && f.length >= 15 && b.orders.length < ORDERS_MAX) {
            b.orders.push({
                summaryId: id(f[2]),
                templateId: word(f[3]),
                reward: num(f[4]),
                difficulty: num(f[5]),
                generatedTicks: num(f[6]),
                clientType: num(f[7]),
                clientId: id(f[8]),
                siteId: id(f[9]),
                recipientId: id(f[10]),
                targetType: num(f[11]),
                targetId: word(f[12]),
                recipeId: word(f[13]),
                reason: num(f[14])
            });
        } else if (kind === 'L' && f[2] === 'end') {
            this.building = null;
            if (num(f[3]) !== b.orders.length) {
                if (this.log) this.log.warn('freelance: board ' + round + ' incomplete (' + b.orders.length + '/' + f[3] + '), skipped');
                return;
            }
            delete b.round;
            this.board = b;
            this.boardAt = Date.now();
            this.write();
        }
    }

    // "<boot>,<seq>,<ok|fail>,<actor>,<op>,<detail>"
    onResult(f) {
        if (f.length < 6 || !f[1]) return;
        const res = { seq: f[1], ok: f[2] === 'ok', actor: id(f[3]), op: f[4], detail: f.slice(5).join(','), at: Date.now() };
        this.results = this.results.filter((r) => r.seq !== res.seq);
        this.results.unshift(res);
        if (this.results.length > RESULTS_KEEP) this.results.length = RESULTS_KEEP;
        if (this.log) this.log.info('freelance: request ' + res.seq + ' ' + res.op + ' ' + (res.ok ? 'ok' : 'failed') + ' (' + res.detail + ')');
        this.write();
    }

    write() {
        if (!this.dir) return;
        // at is when the board was last reported (the phone's freshness check), so a status or a
        // result written alone never makes an old board look current.
        const value = Object.assign({ v: 1, at: this.board ? this.boardAt : 0 }, this.board || { orders: [] },
            { results: this.results, source: this.source, written: Date.now() });
        this.writtenAt = value.written;
        try {
            fsx.writeJson(path.join(this.dir, 'board.cfg'), value);
        } catch (e) {
            if (this.log) this.log.warn('freelance: cannot write board: ' + e.message);
        }
    }
}

module.exports = { Freelance };
