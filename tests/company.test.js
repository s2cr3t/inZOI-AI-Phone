'use strict';
// The company the player runs once they hold its top rank (lib/company.js): the appointment,
// a game day's figures and staff requests, and the manager's decisions from the phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Company, isManager } = require('../lib/company');

function desk(over) {
    return Object.assign({
        companyId: '900', companyName: '星河科技', rank: 5, maxRank: 5, hasNext: false, bossId: '',
        salaries: { 1: 100, 2: 150, 3: 200, 4: 260, 5: 340 },
        staff: [{ id: '11', rank: 2, evaluation: 80 }, { id: '12', rank: 1, evaluation: 50 }],
        roster: [{ id: '11', rank: 2 }, { id: '12', rank: 1 }, { id: '1', rank: 5 }]
    }, over);
}

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-'));
    const calls = [];
    let roster = desk().roster;
    const daemon = {
        log: { info() {}, warn() {}, error() {} },
        game: { soft: async (n, a) => { calls.push(n); return null; }, call: async (n, a) => { calls.push(n + ':' + a.entity_id); roster = roster.map((p) => p.id === a.entity_id ? { id: p.id, rank: p.rank + 1 } : p); } },
        career: { fresh: async () => ({ roster }), request: (actor, op, arg, done) => { roster = roster.filter((p) => p.id !== actor); done({ ok: true, detail: 'ok' }); } },
        world: { characterInfo: async (id) => ({ last_name: '李', first_name: 'n' + id }) }
    };
    const c = new Company(daemon);
    c.configure(path.join(root, 'data'), path.join(root, 'phone'));
    return { root, c, calls };
}

const view = (root) => JSON.parse(fs.readFileSync(path.join(root, 'phone', 'oa', 'company.cfg'), 'utf8')).byManager['1'];
const decide = (root, byId) => {
    fs.mkdirSync(path.join(root, 'phone', 'saved'), { recursive: true });
    fs.writeFileSync(path.join(root, 'phone', 'saved', 'oa-mgmt.cfg'), JSON.stringify({ v: 1, byId }));
};

test('only the top rank with nobody above runs the company', () => {
    assert.ok(isManager(desk()));
    assert.ok(!isManager(desk({ hasNext: true, rank: 4 })));
    assert.ok(!isManager(desk({ bossId: '7' })), 'a colleague of the same top rank is above');
    assert.ok(!isManager(null));
});

test('a manager gets figures and requests each day, and decides them', async () => {
    const { root, c, calls } = setup();
    c.rand = () => 0;
    await c.tick('1', desk(), { day: 10 });
    assert.ok(calls.includes('toast_show'), 'the appointment is announced');
    let v = view(root);
    assert.equal(v.company, '星河科技');
    assert.equal(v.cash, (150 + 100) * 30);
    await c.tick('1', desk(), { day: 11 });
    v = view(root);
    assert.equal(v.history.length, 1);
    assert.ok(v.week.revenue > 0 && v.week.payroll === 250);
    assert.equal(v.requests.length, 1);
    const r = v.requests[0];
    assert.equal(r.status, 'pending');

    decide(root, { [r.id]: { decision: 'approved', at: 1 } });
    c.poll();
    await new Promise((res) => setTimeout(res, 50));
    v = view(root);
    assert.equal(v.requests[0].status, 'approved');
    assert.ok(v.requests[0].effect.text);
    // A request nobody answers lapses.
    c.rand = () => 0;
    await c.tick('1', desk(), { day: 12 });
    await c.tick('1', desk(), { day: 15 });
    v = view(root);
    assert.ok(v.requests.some((x) => x.status === 'lapsed'));
    // Losing the top seat closes the 管理台.
    await c.tick('1', null, { day: 16 });
    assert.equal(view(root), undefined);
    fs.rmSync(root, { recursive: true, force: true });
});

test('a team project is followed, and paid when it is done', async () => {
    const { root, c, calls } = setup();
    const teamproject = require('../lib/teamproject');
    const at = (day, h) => (day * 1440 + h * 60) * teamproject.TICKS_PER_MIN;
    const company = (current, active) => ({ activeTeamProject: { projectId: 'X_Song', currentPoint: current, totalPoint: 300,
        startTicks: at(10, 9), deadlineTicks: at(11, 17), bIsActive: active, memberContributions: { '(Value=11)': current - 10, '(Value=12)': 10 } },
        lastOperatingStartTicks: at(10, 9), todayOperatingEndTicks: at(10, 17) });
    const p = teamproject.current(company(100, true));
    assert.equal(p.contributions['11'], 90);
    // A day and a half of two office days gone, a third of the points: behind.
    assert.equal(teamproject.standing(p, 11 * 1440 + 13 * 60).pace, 'behind');
    await c.tick('1', desk({ project: p }), { day: 10, hour: 12, minute: 0 });
    // Done: the game ends it at its points.
    await c.tick('1', desk({ project: teamproject.current(company(300, false)) }), { day: 11, hour: 12, minute: 0 });
    const v = view(root);
    assert.equal(v.projectLog.length, 1);
    assert.ok(v.projectLog[0].done);
    assert.equal(v.projectLog[0].income, 0, 'no reward known without the catalogue');
    assert.ok(calls.includes('toast_show'));
    // Not settled twice.
    await c.tick('1', desk({ project: teamproject.current(company(300, false)) }), { day: 11, hour: 13, minute: 0 });
    assert.equal(view(root).projectLog.length, 1);
    fs.rmSync(root, { recursive: true, force: true });
});

test('pay set by the manager starts the next day, is paid from the cash, and is answered', async () => {
    const { root, c } = setup();
    c.rand = () => 0.99;
    const asked = [];
    c.d.staffText = async (manager, id, reason) => { asked.push({ id, reason }); return 'text'; };
    await c.tick('1', desk(), { day: 10 });
    await c.tick('1', desk(), { day: 11 });
    const before = view(root);
    decide(root, {});
    fs.writeFileSync(path.join(root, 'phone', 'saved', 'oa-mgmt.cfg'), JSON.stringify({ v: 1, byId: {}, pay: { 11: { to: 1.3, at: 5 }, 12: { to: 0.8, at: 5 } } }));
    c.poll();
    let v = view(root);
    assert.equal(v.staff['11'].pay, 1, 'not before the next day');
    assert.equal(v.staff['11'].planned, 1.3);
    await c.tick('1', desk(), { day: 12 });
    await new Promise((res) => setTimeout(res, 20));
    v = view(root);
    assert.equal(v.staff['11'].pay, 1.3);
    assert.equal(v.staff['12'].pay, 0.8);
    assert.ok(v.staff['11'].morale > before.staff['11'].morale, 'a rise lifts morale');
    assert.ok(v.staff['12'].morale < before.staff['12'].morale, 'a cut lowers it');
    // The day's wages are the new ones: 150 * 1.3 + 100 * 0.8.
    assert.equal(v.history[v.history.length - 1].payroll, 195 + 80);
    assert.equal(v.payLog[0].wageTo, 195);
    assert.ok(asked.length >= 1 && /涨了工资/.test(asked[0].reason));
    fs.rmSync(root, { recursive: true, force: true });
});

test('someone the game seats waits for the manager: kept, or let go; auto-fill off lets them go', async () => {
    const { root, c } = setup();
    c.rand = () => 0.99;
    await c.tick('1', desk(), { day: 10 });
    const staff = (more) => desk({ staff: desk().staff.concat(more), roster: desk().roster.concat(more.map((p) => ({ id: p.id, rank: p.rank }))) });
    await c.tick('1', staff([{ id: '13', rank: 1, evaluation: 50, joinedDay: 10 }]), { day: 10 });
    let v = view(root);
    const hire = v.requests.find((r) => r.kind === 'hire');
    assert.equal(hire.from, '13');
    assert.ok(v.staff['13'].probation);
    decide(root, { [hire.id]: { decision: 'approved', at: 1 } });
    c.poll();
    await new Promise((res) => setTimeout(res, 20));
    v = view(root);
    assert.equal(v.staff['13'].probation, false);
    // Auto-fill off: the next one is let go at once (the game is asked to take them out).
    fs.writeFileSync(path.join(root, 'phone', 'saved', 'oa-mgmt.cfg'), JSON.stringify({ v: 1, byId: {}, hiring: { auto: false, at: 2 } }));
    c.poll();
    await c.tick('1', staff([{ id: '13', rank: 1, evaluation: 50 }, { id: '14', rank: 1, evaluation: 40 }]), { day: 10 });
    await new Promise((res) => setTimeout(res, 20));
    v = view(root);
    const second = v.requests.find((r) => r.kind === 'hire' && r.from === '14');
    assert.equal(second.status, 'rejected');
    assert.equal(v.autoHire, false);
    fs.rmSync(root, { recursive: true, force: true });
});

test('someone gone without the manager is told and waits for them; someone let go is not', async () => {
    const { root, c } = setup();
    c.rand = () => 0.99;
    await c.tick('1', desk(), { day: 10 });
    const only11 = desk({ staff: [{ id: '11', rank: 2, evaluation: 80 }], roster: [{ id: '11', rank: 2 }, { id: '1', rank: 5 }] });
    await c.tick('1', only11, { day: 10 });
    assert.ok(!view(root).requests.some((r) => r.kind === 'gone'), 'missing once is not yet gone');
    await c.tick('1', only11, { day: 10 });
    const gone = view(root).requests.find((r) => r.kind === 'gone');
    assert.equal(gone.from, '12');
    assert.equal(gone.status, 'pending');
    decide(root, { [gone.id]: { decision: 'rejected', at: 1 } });
    c.poll();
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(view(root).requests.find((r) => r.kind === 'gone').status, 'rejected');
    // Let go by the manager: expected, no record.
    c.data.byCompany['900'].expectLeave = { 11: Date.now() };
    await c.tick('1', desk({ staff: [], roster: [{ id: '1', rank: 5 }] }), { day: 10 });
    assert.equal(view(root).requests.filter((r) => r.kind === 'gone').length, 1);
    fs.rmSync(root, { recursive: true, force: true });
});

test('a project is done at its pass mark, points past it are a bonus, below it fails; an old false success is corrected once', async () => {
    const { root, c } = setup();
    const pj = (id, current, active) => ({ project: { id, current, total: 100, active, reward: 400, contributions: {} } });
    await c.tick('1', desk(pj('X', 60, true)), { day: 10 });
    assert.equal(view(root).project.pass, 70);
    assert.equal(view(root).project.income, 800);
    assert.equal(view(root).project.bonusMax, 400);
    await c.tick('1', desk(pj('X', 60, false)), { day: 11 });
    let v = view(root);
    assert.equal(v.projectLog[0].done, false, 'below the pass mark');
    assert.equal(v.projectLog[0].income, 0);
    await c.tick('1', desk(pj('Y', 85, true)), { day: 12 });
    await c.tick('1', desk(pj('Y', 85, false)), { day: 13 });
    v = view(root);
    // Every change of the cash is in the books, each with the balance after it.
    const kinds = v.ledger.map((e) => e.kind);
    assert.equal(kinds[0], 'start');
    assert.ok(kinds.indexOf('revenue') > 0 && kinds.indexOf('payroll') > 0);
    assert.deepEqual(kinds.slice(-2), ['project', 'bonus']);
    assert.deepEqual(v.ledger.slice(-2).map((e) => e.amount), [800, 200]);
    assert.equal(v.ledger[v.ledger.length - 1].balance, c.data.byCompany['900'].cash);
    for (let i = 1; i < v.ledger.length; i++) assert.equal(v.ledger[i].balance, v.ledger[i - 1].balance + v.ledger[i].amount, 'balances add up');
    const wages = v.ledger.find((e) => e.kind === 'payroll');
    assert.equal(wages.lines.reduce((s, l) => s + l.amount, 0), wages.amount, 'by person, adding up');
    assert.equal(v.projectLog[1].done, true, 'past the pass mark');
    assert.equal(v.projectLog[1].bonus, 200, 'half the way from the mark to all the points: half the bonus');
    assert.equal(v.projectLog[1].income, 1000);

    fs.rmSync(root, { recursive: true, force: true });
    const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'company-old-'));
    fs.mkdirSync(path.join(oldRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, 'data', 'company.json'), JSON.stringify({ v: 1, byCompany: {
        '900': { manager: '1', name: '星河科技', cash: 15000, staff: {}, requests: [], history: [],
            projectLog: [{ id: 'X', current: 60, total: 100, done: true, income: 800 }, { id: 'Y', current: 80, total: 100, done: true, income: 800 }] }
    } }));
    const d = setup().c.d;
    const fixed = new Company(d);
    fixed.configure(path.join(oldRoot, 'data'), path.join(oldRoot, 'phone'));
    assert.equal(fixed.data.byCompany['900'].cash, 14200);
    assert.equal(fixed.data.byCompany['900'].projectLog[0].done, false);
    assert.equal(fixed.data.byCompany['900'].projectLog[1].done, true, 'past the pass mark: kept');
    fixed.configure(path.join(oldRoot, 'data'), path.join(oldRoot, 'phone'));
    assert.equal(fixed.data.byCompany['900'].cash, 14200);
    fs.rmSync(oldRoot, { recursive: true, force: true });
});

test('let go by the game with no job to go to: called back at once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-'));
    let roster = desk().roster;
    const joins = [];
    const daemon = {
        log: { info() {}, warn() {}, error() {} },
        game: {
            soft: async (n, a) => n === 'career_get_work_status' ? { has_job: a.entity_id !== '12' ? true : false } : null,
            call: async (n, a) => { if (n === 'career_join') { joins.push(a.entity_id); roster = roster.concat([{ id: a.entity_id, rank: 1 }]); } }
        },
        career: { fresh: async () => ({ roster, jobId: 'Co_1' }), request: (actor, op, arg, done) => done({ ok: true, detail: 'ok' }) },
        world: { characterInfo: async (id) => ({ last_name: '李', first_name: 'n' + id }) }
    };
    const c = new Company(daemon);
    c.configure(path.join(root, 'data'), path.join(root, 'phone'));
    c.rand = () => 0.99;
    await c.tick('1', desk(), { day: 10 });
    roster = [{ id: '11', rank: 2 }, { id: '1', rank: 5 }];
    const only11 = desk({ staff: [{ id: '11', rank: 2, evaluation: 80 }], roster });
    await c.tick('1', only11, { day: 10 });
    await c.tick('1', only11, { day: 10 });
    await new Promise((res) => setTimeout(res, 1700));
    const gone = view(root).requests.find((r) => r.kind === 'gone');
    assert.deepEqual(joins, ['12']);
    assert.equal(gone.status, 'approved');
    assert.ok(c.data.byCompany['900'].staff['12'], 'on the payroll again');
    fs.rmSync(root, { recursive: true, force: true });
});

test('let go from the phone: asked of the played character, out of the company, the rest a little shaken', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-'));
    let roster = desk().roster;
    const asked = [];
    const daemon = {
        log: { info() {}, warn() {}, error() {} },
        game: { soft: async () => null, call: async () => null },
        journal: { can: (f) => f === 'dismiss' },
        career: {
            fresh: async () => ({ roster }),
            request: (actor, op, arg, done) => { asked.push(actor + ' ' + op + ' ' + arg); roster = roster.filter((p) => p.id !== arg.split('/')[1]); done({ ok: true, detail: 'dismissed' }); }
        },
        world: { characterInfo: async (id) => ({ last_name: '李', first_name: 'n' + id }) }
    };
    const c = new Company(daemon);
    c.configure(path.join(root, 'data'), path.join(root, 'phone'));
    c.rand = () => 0.99;
    await c.tick('1', desk(), { day: 10 });
    const before = c.data.byCompany['900'].staff['11'].morale;
    fs.mkdirSync(path.join(root, 'phone', 'saved'), { recursive: true });
    fs.writeFileSync(path.join(root, 'phone', 'saved', 'oa-mgmt.cfg'), JSON.stringify({ v: 1, byId: {}, fire: { 12: { at: Date.now() } } }));
    c.poll();
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(asked, ['1 x 900/12']);
    const co = c.data.byCompany['900'];
    assert.ok(!co.firing['12'], 'done');
    assert.equal(co.staff['11'].morale, before - 3);
    assert.equal(co.fireLog[0].id, '12');
    await c.tick('1', desk({ staff: [{ id: '11', rank: 2, evaluation: 80 }], roster }), { day: 10 });
    assert.ok(!co.staff['12'], 'off the payroll');
    assert.ok(!co.requests.some((r) => r.kind === 'gone'), 'not taken for a departure without the manager');
    // Under way when the service stopped: failed on the next start, so it can be asked again.
    co.firing['11'] = { state: 'applying', text: '正在办理离职' };
    c.save();
    const c2 = new Company(daemon);
    c2.configure(path.join(root, 'data'), path.join(root, 'phone'));
    assert.equal(c2.data.byCompany['900'].firing['11'].state, 'failed');
    fs.rmSync(root, { recursive: true, force: true });
});

test('auto-fill off: the game keeps no rank filled, so it hires nobody; on again, as it was', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-'));
    const counts = [1, 2, 1, 1];
    const daemon = {
        log: { info() {}, warn() {}, error() {} },
        game: {
            soft: async (n, a) => {
                if (n === 'data_table_get' && a.Alias === 'Career') {
                    return { unexcusedAbsenceScriptId: 'None', organizations: [{ rankList: counts.map((x) => ({ shift: { crowdAutoFillCount: x } })) }] };
                }
                if (n === 'data_patch') {
                    const m = /RankList\[(\d+)\]\.Shift\.CrowdAutoFillCount$/.exec(a.Query);
                    if (m) { counts[Number(m[1])] = Number(a.Value); return { result: 'Applied' }; }
                }
                return null;
            },
            call: async () => null
        },
        career: { fresh: async () => null, request: (x, o, g, done) => done({ ok: false }) },
        world: { characterInfo: async () => null }
    };
    const c = new Company(daemon);
    c.configure(path.join(root, 'data'), path.join(root, 'phone'));
    c.rand = () => 0.99;
    await c.tick('1', desk({ careerDtId: 'Co' }), { day: 10 });
    assert.deepEqual(counts, [1, 2, 1, 1], 'auto-fill on: left as the game has it');
    c.data.byCompany['900'].autoHire = false;
    await c.tick('1', desk({ careerDtId: 'Co' }), { day: 10 });
    assert.deepEqual(counts, [0, 0, 0, 0]);
    await c.tick('1', desk({ careerDtId: 'Co' }), { day: 10 });
    assert.deepEqual(counts, [0, 0, 0, 0], 'still off, the numbers it had kept');
    c.data.byCompany['900'].autoHire = true;
    await c.tick('1', desk({ careerDtId: 'Co' }), { day: 10 });
    assert.deepEqual(counts, [1, 2, 1, 1]);
    fs.rmSync(root, { recursive: true, force: true });
});

test('while the player runs it, the game fires nobody for absence: told instead, and the rule put back after', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-'));
    const row = { unexcusedAbsenceScriptId: 'AddBuff_Career_Fired' };
    const daemon = {
        log: { info() {}, warn() {}, error() {} },
        game: {
            soft: async (n, a) => {
                if (n === 'data_table_get' && a.Alias === 'Career') return Object.assign({}, row);
                if (n === 'data_patch') { row.unexcusedAbsenceScriptId = a.Value; return { result: 'Applied' }; }
                return null;
            },
            call: async () => null
        },
        career: { fresh: async () => null, request: (a, o, g, done) => done({ ok: false }) },
        world: { characterInfo: async (id) => ({ last_name: '李', first_name: 'n' + id }) }
    };
    const toasts = [];
    const c = new Company(daemon);
    c.configure(path.join(root, 'data'), path.join(root, 'phone'));
    c.toast = (t) => toasts.push(t);
    c.rand = () => 0.99;
    await c.tick('1', desk({ careerDtId: 'Co' }), { day: 10 });
    assert.equal(row.unexcusedAbsenceScriptId, 'None');
    await c.tick('1', desk({ careerDtId: 'Co', staff: [{ id: '11', rank: 2, evaluation: 80 }, { id: '12', rank: 1, evaluation: 50, unexcused: 1 }] }), { day: 10 });
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(toasts.some((t) => t.indexOf('无故缺勤') >= 0));
    await c.tick('1', desk({ careerDtId: 'Co', rank: 4, hasNext: true }), { day: 10 });
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(row.unexcusedAbsenceScriptId, 'AddBuff_Career_Fired');
    fs.rmSync(root, { recursive: true, force: true });
});
