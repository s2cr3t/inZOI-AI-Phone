'use strict';
// Offline tests for OA requests the boss decides in the chat (lib/career.js): which requests reach
// the boss's prompt and with which rules, how a decision in the reply is filed, and how an
// approval is carried out against a stand-in for the game. Everything is written under a
// temporary folder; no game, no API, no player data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../lib/paths');
const { Career } = require('../lib/career');

const log = { info() {}, warn() {}, debug() {} };
const pair = { key: '20522-19141', playerId: '20522', partnerId: '19141', outsider: true };
const env = { day: 1017, hour: 20, minute: 32 };

// The company as the game reflects it: the player at rank 3 and the boss at 4.
function world(over) {
    const me = Object.assign({ jobId: 'SoundCompany_1', rank: 3, exp: 200, evaluationScore: 70, attendanceDays: 7,
        remainingVacationDays: 2, vacationScheduledDays: 0, vacationSegments: [], nextDayVacationType: 'None',
        unexcusedAbsenceCount: 0, activeWorkMode: 'OnSite' }, over || {});
    return {
        me,
        hasJob: true,
        buffs: {},
        rows: {
            Career: { organizations: [{ jobId: 'SoundCompany_1', bCanRemoteWork: true, rankList: [
                { rank: 1, requireTotalExp: 0 }, { rank: 2, requireTotalExp: 100 },
                { rank: 3, requireTotalExp: 200 }, { rank: 4, requireTotalExp: 300 }] }] },
            Buff: { Buff_Cold: { buffBasicInfo: { tags: ['Disease'] } }, Buff_Happy: { buffBasicInfo: { tags: [] } } }
        }
    };
}

function setup(t, w) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const mod = path.join(root, 'HouseholdJournal');
    fs.mkdirSync(path.join(mod, 'bridge'), { recursive: true });
    const realFind = paths.findMod;
    paths.findMod = () => mod;
    t.after(() => { paths.findMod = realFind; });
    const phone = path.join(root, 'ui', 'phone');
    const calls = [];
    // Interaction endings as the journal reports them.
    const ends = [];
    const toasts = [];
    const game = {
        async soft(tool, args) {
            if (tool === 'toast_show') { toasts.push(args.Message); return {}; }
            if (tool === 'buff_add') { calls.push([tool, args]); return {}; }
            if (tool === 'entity_reflect' && args.Component === 'FB2CareerComponent') {
                return { careerSlots: w.hasJob ? { business: { slotType: 'Business', careerDtId: 'SoundCompany', jobDtId: 'SoundCompany_1',
                    careerEntityId: { value: 885 }, rank: w.me.rank, exp: w.me.exp, evaluationScore: w.me.evaluationScore } } : {} };
            }
            if (tool === 'entity_reflect' && args.Component === 'FB2BuffComponent') {
                const buffs = {};
                for (const id of Object.keys(w.buffs)) buffs[id.toLowerCase()] = { iD: id };
                return { buffs };
            }
            if (tool === 'entity_reflect') {
                return { memberInfo: { '(Value=20522)': w.me, '(Value=19141)': { rank: 4 }, '(Value=29463)': { rank: 1 } } };
            }
            if (tool === 'data_table_get') return (w.rows[args.Alias] && args.Alias === 'Buff' ? w.rows.Buff[args.Row] : w.rows[args.Alias]) || null;
            return null;
        },
        async call(tool, args) {
            calls.push([tool, args]);
            // The game's own effects, as they would show on the member list.
            if (tool === 'career_promotion') w.me.rank += 1;
            // As in the game: a call to oneself without the character as its target fails at once.
            if (tool === 'interaction_execute' && String(args.target_entity_id) !== String(args.entity_id)) {
                ends.push({ at: Date.now(), kind: 'failed', actor: args.entity_id, bag: args.interaction_bag_id, reason: 'NotFoundTarget' });
                return {};
            }
            if (tool === 'interaction_execute' && w.vacationBooks === 'finish') {
                ends.push({ at: Date.now(), kind: 'finished', actor: args.entity_id, bag: args.interaction_bag_id, reason: '' });
                return {};
            }
            if (tool === 'interaction_execute' && w.vacationBooks !== false) {
                w.me.vacationScheduledDays += 1;
                w.me.remainingVacationDays -= args.interaction_bag_id === 'CareerCommon_UseVacation' ? 1 : 0;
                w.me.vacationSegments = w.me.vacationSegments.concat([{}]);
            }
            return {};
        }
    };
    const cache = new Map();
    const d = {
        log,
        game,
        journal: {
            can: (f) => f === 'career',
            endOf(actor, bags, since) {
                for (let i = ends.length - 1; i >= 0; i--) {
                    const e = ends[i];
                    if (e.at >= since && e.actor === String(actor) && bags.indexOf(e.bag) >= 0) return e;
                }
                return null;
            }
        },
        world: {
            async cached(key, ttl, fn) {
                if (cache.has(key)) return cache.get(key);
                const v = await fn();
                cache.set(key, v);
                return v;
            },
            invalidate(prefix) { for (const k of Array.from(cache.keys())) if (k.startsWith(prefix)) cache.delete(k); }
        }
    };
    const career = new Career(d);
    career.configure(phone);
    const file = (rel) => path.join(phone, rel);
    const request = (r) => {
        const list = career.requests().concat([Object.assign({ id: 'r' + (career.requests().length + 1), member: '20522', boss: '19141',
            days: 0, reason: '家里有事', at: Date.now(), status: 'pending' }, r)]);
        fs.mkdirSync(file('saved'), { recursive: true });
        fs.writeFileSync(file('saved/oa-requests.cfg'), JSON.stringify({ v: 1, list }));
        return list[list.length - 1];
    };
    return { career, calls, toasts, request, file, mod, w };
}

// Waits for an approval being carried out in the background to settle.
async function settled(career, id, ms) {
    const until = Date.now() + (ms || 15000);
    while (Date.now() < until) {
        const e = (career.decisions()[id] || {}).effect;
        if (e && e.state !== 'applying') return e;
        await new Promise((r) => setTimeout(r, 100));
    }
    return (career.decisions()[id] || {}).effect;
}

test('a waiting request reaches the boss with the rules for it', async (t) => {
    const s = setup(t, world());
    const r = s.request({ kind: 'leave', days: 3 });
    const rule = await s.career.rule(pair, { env }, '会荣');
    assert.match(rule, /【OA 审批】你是会荣的直属上级/);
    assert.match(rule, new RegExp('编号 ' + r.id + '：请假 3 天'));
    assert.match(rule, /不能批：年假只剩 2 天，不够 3 天/);
    assert.match(rule, /"decision":"approve 或 reject 或 later"/);
});

test('no rule for someone who is not the boss, or when nothing waits', async (t) => {
    const s = setup(t, world());
    assert.equal(await s.career.rule(pair, { env }, '会荣'), '');
    s.request({ kind: 'leave', days: 1, boss: '19695' });
    assert.equal(await s.career.rule(pair, { env }, '会荣'), '');
    assert.equal(await s.career.rule(Object.assign({}, pair, { partnerId: '19695' }), { env }, '会荣'), '', 'not the boss in the game');
    s.request({ kind: 'leave', days: 1, status: 'withdrawn' });
    assert.equal(await s.career.rule(pair, { env }, '会荣'), '');
});

test('an approved leave is booked through the game and filed as done', async (t) => {
    const s = setup(t, world());
    const r = s.request({ kind: 'leave', days: 2 });
    await s.career.fromReply(pair, { env }, [{ id: r.id, decision: 'approve', note: '去吧，早点回来' }]);
    const d = s.career.decisions()[r.id];
    assert.equal(d.status, 'approved');
    assert.equal(d.note, '去吧，早点回来');
    assert.equal(d.days, 2);
    const eff = await settled(s.career, r.id);
    assert.equal(eff.state, 'done');
    assert.match(eff.text, /请好 2 天/);
    const bags = s.calls.filter((c) => c[0] === 'interaction_execute').map((c) => c[1].interaction_bag_id);
    assert.deepEqual(bags, ['CareerCommon_UseVacation', 'CareerCommon_UseVacation']);
    assert.ok(s.calls.filter((c) => c[0] === 'interaction_execute').every((c) => c[1].target_entity_id === '20522'), 'the call is made to oneself');
    assert.ok(s.toasts.some((x) => /请假申请已通过/.test(x)));
    assert.equal(await s.career.rule(pair, { env }, '会荣'), '', 'a decided request no longer waits');
});

test('the boss may grant fewer days than asked, never more', async (t) => {
    const s = setup(t, world());
    const r = s.request({ kind: 'leave', days: 2 });
    await s.career.fromReply(pair, { env }, [{ id: r.id, decision: 'approve', days: 1 }]);
    assert.equal(s.career.decisions()[r.id].days, 1);
    assert.equal((await settled(s.career, r.id)).state, 'done');
    const r2 = s.request({ kind: 'leave', days: 1 });
    await s.career.fromReply(pair, { env }, [{ id: r2.id, decision: 'approve', days: 5 }]);
    assert.equal(s.career.decisions()[r2.id].days, 1);
    await settled(s.career, r2.id);
});

test('an approval the rules do not allow is filed as rejected and changes nothing', async (t) => {
    const s = setup(t, world());
    const r = s.request({ kind: 'promote' });
    await s.career.fromReply(pair, { env }, [{ id: r.id, decision: 'approve' }]);
    const d = s.career.decisions()[r.id];
    assert.equal(d.status, 'rejected');
    assert.match(d.note, /经验 200，升下一级要 300/);
    assert.equal(s.calls.length, 0);
});

test('a promotion with enough experience raises the rank', async (t) => {
    const w = world({ exp: 320 });
    const s = setup(t, w);
    const r = s.request({ kind: 'promote' });
    await s.career.fromReply(pair, { env }, [{ id: r.id, decision: 'approve', note: '这阵子辛苦了' }]);
    const eff = await settled(s.career, r.id);
    assert.equal(eff.state, 'done');
    assert.equal(w.me.rank, 4);
    assert.ok(s.calls.some((c) => c[0] === 'buff_add' && c[1].buff_id === 'Buff_Job_Promotion'));
});

test('sick leave is granted only to someone who is ill', async (t) => {
    const w = world();
    const s = setup(t, w);
    const r = s.request({ kind: 'sick', days: 1 });
    assert.match(await s.career.rule(pair, { env }, '会荣'), /看不出对方真的生病了/);
    await s.career.fromReply(pair, { env }, [{ id: r.id, decision: 'approve' }]);
    assert.equal(s.career.decisions()[r.id].status, 'rejected');
    w.buffs = { Buff_Cold: true, Buff_Happy: true };
    const r2 = s.request({ kind: 'sick', days: 1 });
    await s.career.fromReply(pair, { env }, [{ id: r2.id, decision: 'approve' }]);
    assert.equal(s.career.decisions()[r2.id].status, 'approved');
    assert.equal((await settled(s.career, r2.id)).state, 'done');
    assert.ok(s.calls.some((c) => c[0] === 'interaction_execute' && c[1].interaction_bag_id === 'CareerCommon_SickLeave'));
});

test('a call that finishes without booking the leave is reported as failed, with why', async (t) => {
    const w = world();
    w.vacationBooks = 'finish';
    const s = setup(t, w);
    const r = s.request({ kind: 'leave', days: 1 });
    await s.career.fromReply(pair, { env }, [{ id: r.id, decision: 'approve' }]);
    const eff = await settled(s.career, r.id, 30000);
    assert.equal(eff.state, 'failed');
    assert.match(eff.text, /电话打完了，游戏没有记上假/);
});

test('a call the game refuses fails at once with its reason', async (t) => {
    const w = world();
    const s = setup(t, w);
    const r = s.request({ kind: 'leave', days: 1 });
    const started = Date.now();
    const call = s.career.d.game.call;
    // The call as the first version made it: no target.
    s.career.d.game.call = (tool, args) => call(tool, tool === 'interaction_execute' ? Object.assign({}, args, { target_entity_id: undefined }) : args);
    await s.career.fromReply(pair, { env }, [{ id: r.id, decision: 'approve' }]);
    const eff = await settled(s.career, r.id);
    assert.equal(eff.state, 'failed');
    assert.match(eff.text, /电话没打成（游戏：failed NotFoundTarget）/);
    assert.ok(Date.now() - started < 10000, 'not the two-minute wait');
});

test('a failed approval is carried out again when the phone asks', async (t) => {
    const w = world();
    const s = setup(t, w);
    const r = s.request({ kind: 'leave', days: 1 });
    // The record the first version left: approved, failed, no time on the effect.
    fs.mkdirSync(s.file('oa'), { recursive: true });
    fs.writeFileSync(s.file('oa/decisions.cfg'), JSON.stringify({ v: 1, byId: { [r.id]: { status: 'approved', days: 1, at: 1,
        effect: { state: 'failed', text: '电话打了，游戏没有记上假' } } } }));
    s.career.retry();
    assert.equal(s.calls.length, 0, 'nothing without a retry');
    const list = s.career.requests();
    list[0].retry = Date.now();
    fs.writeFileSync(s.file('saved/oa-requests.cfg'), JSON.stringify({ v: 1, list }));
    s.career.retry();
    s.career.retry();
    const eff = await settled(s.career, r.id);
    assert.equal(eff.state, 'done');
    assert.equal(s.calls.filter((c) => c[0] === 'interaction_execute').length, 1, 'carried out once');
    s.career.retry();
    assert.equal(s.calls.filter((c) => c[0] === 'interaction_execute').length, 1, 'done stays done');
});

test('a resignation goes through the Lua mod and is checked on the job', async (t) => {
    const w = world();
    const s = setup(t, w);
    const r = s.request({ kind: 'resign' });
    await s.career.fromReply(pair, { env }, [{ id: r.id, decision: 'approve' }]);
    await settled(s.career, r.id, 500);
    const queue = fs.readFileSync(path.join(s.mod, 'bridge', 'career.cfg'), 'utf8');
    const m = /^(\d+):20522:r:885$/.exec(queue);
    assert.ok(m, 'queued: ' + queue);
    assert.equal(s.career.decisions()[r.id].effect.state, 'applying');
    w.hasJob = false;
    await s.career.onResult({ seq: m[1], ok: true, actor: '20522', op: 'r', detail: 'left_Voluntary' });
    assert.equal(s.career.decisions()[r.id].effect.state, 'done');
    assert.equal(fs.readFileSync(path.join(s.mod, 'bridge', 'career.cfg'), 'utf8'), '');
});

test('remote work is approved in words only, and later or unknown answers file nothing', async (t) => {
    const s = setup(t, world());
    const r = s.request({ kind: 'remote' });
    await s.career.fromReply(pair, { env }, [{ id: 'nope', decision: 'approve' }, { id: r.id, decision: 'later' }]);
    assert.equal(s.career.decisions()[r.id], undefined);
    await s.career.fromReply(pair, { env }, { id: r.id, decision: 'approve' });
    assert.equal((await settled(s.career, r.id)).state, 'unsupported');
});
