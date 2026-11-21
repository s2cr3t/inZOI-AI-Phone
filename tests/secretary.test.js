'use strict';
// The secretary of the company the player runs (lib/secretary.js through lib/company.js): named
// from the phone, knows the books, carries out the manager's word, and reports once a day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Company } = require('../lib/company');

function desk(over) {
    return Object.assign({
        companyId: '900', companyName: '星河科技', rank: 5, maxRank: 5, hasNext: false, bossId: '',
        salaries: { 1: 100, 2: 150, 3: 200, 4: 260, 5: 340 }, rankNames: { 1: '助理', 2: '专员' },
        staff: [{ id: '11', rank: 2, evaluation: 80, attendance: 9, joinedDay: 2 }, { id: '12', rank: 1, evaluation: 50, attendance: 0, unexcused: 2, joinedDay: 9 }],
        roster: [{ id: '11', rank: 2 }, { id: '12', rank: 1 }, { id: '1', rank: 5 }]
    }, over);
}

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-'));
    let roster = desk().roster;
    const texts = [];
    const asked = [];
    const daemon = {
        log: { info() {}, warn() {}, error() {} },
        game: { soft: async () => null, call: async () => null },
        journal: { can: (f) => f === 'dismiss' },
        career: {
            fresh: async () => ({ roster }),
            request: (actor, op, arg, done) => { asked.push(op + ' ' + arg); roster = roster.filter((p) => p.id !== arg.split('/')[1]); done({ ok: true, detail: 'ok' }); }
        },
        world: { characterInfo: async (id) => ({ last_name: '李', first_name: 'n' + id }) },
        staffText: async (player, who, reason) => { texts.push({ player, who, reason }); return 'text'; }
    };
    const c = new Company(daemon);
    c.configure(path.join(root, 'data'), path.join(root, 'phone'));
    c.rand = () => 0.99;
    const mgmt = (v) => {
        fs.mkdirSync(path.join(root, 'phone', 'saved'), { recursive: true });
        fs.writeFileSync(path.join(root, 'phone', 'saved', 'oa-mgmt.cfg'), JSON.stringify(Object.assign({ v: 1, byId: {} }, v)));
        c.poll();
    };
    return { root, c, texts, asked, mgmt };
}

test('named from the phone, the secretary knows the books, and reports once a day from 9:00', async () => {
    const { root, c, texts, mgmt } = setup();
    await c.tick('1', desk(), { day: 10, hour: 8 });
    mgmt({ secretary: { id: '11', at: Date.now() } });
    const co = c.data.byCompany['900'];
    assert.equal(co.secretary, '11');
    const pair = { outsider: true, playerId: '1', partnerId: '11' };
    assert.ok(c.isSecretary(pair));
    assert.ok(!c.isSecretary({ outsider: true, playerId: '1', partnerId: '12' }));
    const rule = c.rule(pair, '老板', desk());
    assert.ok(rule.indexOf('秘书') >= 0 && rule.indexOf('公司现金') >= 0, 'the books in the prompt');
    assert.ok(rule.indexOf('旷工 2 次') >= 0, 'the staff as they are');
    assert.ok(rule.indexOf('第 9 天入职（新来的）') >= 0 && rule.indexOf('第 2 天入职，') >= 0, 'who is new');
    const orders = c.secretaryRule(pair, '老板', desk());
    assert.ok(orders.indexOf('"do":"fire"') >= 0 && orders.indexOf('"do":"talk"') >= 0, 'how to carry out the manager\'s word');
    assert.ok(orders.indexOf('不要写 actions 或 promises') >= 0, 'nothing to do in the game for it');
    assert.ok(orders.indexOf('n12=12') >= 0, 'the people by name and number');
    assert.ok(orders.indexOf('「新人」指新来的：李n12=12。') >= 0, 'who the new one is: ' + orders);
    assert.equal(c.secretaryRule({ outsider: true, playerId: '1', partnerId: '12' }, '老板', desk()), '', 'only for the secretary');
    // How everyone is doing now, and today's tasks.
    co.workSlots = [{ from: 600, to: 720, label: '上午' }];
    co.workTasks = [{ id: 'Co_A', name: '校正音高' }];
    co.plan = { day: 10, decided: true, assign: { 11: [['Co_A']] }, stats: { 11: { on: 50, other: 0, off: 12, bySlot: { 0: { on: 50, other: 0, off: 12 } }, byTask: { Co_A: 50 }, done: { Co_A: 2 } } }, quest: {} };
    c.secretary.now = { 11: { atWork: true, workTime: true, doing: '校正音高' }, 12: { atWork: false, workTime: true, doing: '' } };
    const busy = c.rule(pair, '老板', desk());
    assert.ok(busy.indexOf('在公司，正在「校正音高」') >= 0);
    assert.ok(busy.indexOf('上班时间不在公司') >= 0);
    assert.ok(busy.indexOf('校正音高 做完 2 次（50 / 72 分钟）') >= 0, 'the task done and the time on it');
    assert.ok(busy.indexOf('摸鱼 12 分钟') >= 0);
    assert.ok(busy.indexOf('今天没给 TA 排任务') >= 0);
    // The game's own look, through the tick.
    c.d.game.soft = async (n, a) => n === 'career_get_work_status' ? { is_at_work: a.entity_id === '11', is_working_time: true }
        : n === 'interaction_get_current' ? (a.entity_id === '11' ? { playing: true, interaction_bag_id: 'Co_A' } : { playing: false }) : null;
    await c.secretary.look(co, desk());
    assert.equal(c.secretary.now['11'].doing, '校正音高', 'a planned task by its name');
    assert.equal(c.secretary.now['12'].atWork, false);
    c.d.game.soft = async () => null;
    await c.tick('1', desk(), { day: 10, hour: 8 });
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(texts.length, 0, 'not before 9:00');
    await c.tick('1', desk(), { day: 10, hour: 9 });
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(texts.length, 1);
    assert.equal(texts[0].who, '11');
    assert.ok(texts[0].reason.indexOf('建议') >= 0);
    await c.tick('1', desk(), { day: 10, hour: 11 });
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(texts.length, 1, 'once a day');
    fs.rmSync(root, { recursive: true, force: true });
});

test('news of the staff reaches the manager from the secretary, a few together, without being asked', async () => {
    const { root, c, texts, mgmt } = setup();
    await c.tick('1', desk(), { day: 10, hour: 20 });
    co_reportDone(c);
    mgmt({ secretary: { id: '11', at: Date.now() } });
    const co = c.data.byCompany['900'];
    co.reportedDay = 10;
    co.recruit = { pool: [], offers: [], passed: [], hired: [], vacancy: 1 };
    c.recruit.answered(co, { id: '501', name: '王一', pay: 0.95, status: 'declined', reply: '钱少了点' });
    c.recruit.answered(co, { id: '502', name: '王二', pay: 1.1, status: 'accepted', reply: '明天就来' });
    await c.tick('1', desk(), { day: 10, hour: 20 });
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(texts.length, 0, 'waits a little for more to come with it');
    for (const x of co.secretaryNews) x.at -= 100000;
    await c.tick('1', desk(), { day: 10, hour: 20 });
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(texts.length, 1, 'one text for both');
    assert.ok(texts[0].reason.indexOf('王一，日薪 95%，婉拒了，回复说「钱少了点」') >= 0, texts[0].reason);
    assert.ok(texts[0].reason.indexOf('王二，日薪 110%，答应了，已经入职') >= 0);
    assert.equal(co.secretaryNews.length, 0, 'told once');
    // No secretary: nothing is kept for one.
    delete co.secretary;
    c.recruit.answered(co, { id: '503', name: '王三', pay: 1, status: 'declined' });
    assert.equal(co.secretaryNews.length, 0);
    fs.rmSync(root, { recursive: true, force: true });
});

test('a talk the manager asks for: maybe lifts the employee\'s morale, never lowers it, once a day, and the secretary tells how it went', async () => {
    const { root, c, texts, mgmt } = setup();
    await c.tick('1', desk(), { day: 10, hour: 20 });
    co_reportDone(c);
    mgmt({ secretary: { id: '11', at: Date.now() } });
    const co = c.data.byCompany['900'];
    co.reportedDay = 10;
    co.staff['12'].morale = 30;
    co.requests.push({ id: 'r1', from: '12', kind: 'raise', status: 'rejected', day: 9 });
    const pair = { outsider: true, playerId: '1', partnerId: '11' };
    assert.equal(c.fromSecretary(pair, [{ do: 'talk', id: '12', about: '最近不开心' }]), 1);
    assert.equal(c.fromSecretary(pair, [{ do: 'talk', id: '12' }]), 0, 'once a day for each person');
    assert.equal(c.fromSecretary(pair, [{ do: 'talk', id: '11' }]), 0, 'not with themself');
    c.secretary.settleTalks(co);
    assert.equal(co.staff['12'].morale, 30, 'the talk takes a while');
    const talk = co.secretaryLog.find((x) => x.do === 'talk' && x.id === '12' && x.state === 'applying');
    talk.dueAt = 0;
    c.secretary.rand = () => 0;
    c.secretary.settleTalks(co);
    assert.equal(co.staff['12'].morale, 34, 'lifted, by the least at this draw');
    assert.equal(talk.state, 'done');
    for (const x of co.secretaryNews) x.at -= 100000;
    await c.tick('1', desk(), { day: 10, hour: 20 });
    await new Promise((res) => setTimeout(res, 20));
    const said = texts[texts.length - 1].reason;
    assert.ok(said.indexOf('谈「最近不开心」') >= 0 && said.indexOf('30 → 34') >= 0, said);
    assert.ok(said.indexOf('加薪申请被驳回了') >= 0, 'what may be weighing on them');
    // The next day, a talk that does not take: no change, never down.
    co.lastDay = 11;
    assert.equal(c.fromSecretary(pair, [{ do: 'talk', id: '12' }]), 1);
    const again = co.secretaryLog[co.secretaryLog.length - 1];
    again.dueAt = 0;
    c.secretary.rand = () => 0.99;
    c.secretary.settleTalks(co);
    assert.equal(co.staff['12'].morale, 34);
    assert.ok(again.text.indexOf('状态没变') >= 0);
    fs.rmSync(root, { recursive: true, force: true });
});

test('the manager asks the secretary for a talk: started from the text itself, by name, 「新人」, or a bare 「现在就谈」', async () => {
    const { root, c, mgmt } = setup();
    await c.tick('1', desk(), { day: 10, hour: 20 });
    co_reportDone(c);
    mgmt({ secretary: { id: '11', at: Date.now() } });
    const co = c.data.byCompany['900'];
    co.names = { 11: '孙有利', 12: '池柱完', 13: '成贞媛' };
    co.staff['13'] = { morale: 50 };
    const d = desk({ staff: desk().staff.concat([{ id: '13', rank: 2, joinedDay: 1 }]) });
    const pair = { outsider: true, playerId: '1', partnerId: '11' };
    assert.deepEqual(c.secretaryHears(pair, { now: ['今天天气不错'], before: [] }, d), [], 'nothing asked');
    // As in the log: asked earlier, then 「现在就谈」.
    const heard = c.secretaryHears(pair, { now: ['现在就谈'], before: ['下班了你也回家吧', '记得帮我找那个新人谈话'] }, d);
    assert.deepEqual(heard.map((x) => [x.id, x.started]), [['12', true]], 'the newcomer (joined day 9), not the old hand');
    assert.deepEqual(c.secretaryHears(pair, { now: ['去跟贞媛聊聊，给她打打气'], before: [] }, d).map((x) => x.id), ['13'], 'by the given name');
    const again = c.secretaryHears(pair, { now: ['再找池柱完谈谈'], before: [] }, d);
    assert.deepEqual(again.map((x) => [x.id, x.started]), [['12', false]], 'once a day');
    assert.deepEqual(c.secretaryHears({ outsider: true, playerId: '1', partnerId: '12' }, { now: ['找成贞媛谈谈'], before: [] }, d), [], 'only the secretary');
    fs.rmSync(root, { recursive: true, force: true });
});

function co_reportDone(c) {
    for (const k of Object.keys(c.data.byCompany)) c.data.byCompany[k].reportedDay = 10;
}

test('the manager\'s word: an employee let go, an applicant sent an offer; nothing unclear is done', async () => {
    const { root, c, asked, mgmt } = setup();
    await c.tick('1', desk(), { day: 10, hour: 8 });
    mgmt({ secretary: { id: '11', at: Date.now() } });
    const co = c.data.byCompany['900'];
    co.recruit = { pool: [{ id: '501', name: '王一', expect: 1.05 }], offers: [], passed: [], hired: [], vacancy: 1 };
    const pair = { outsider: true, playerId: '1', partnerId: '11' };
    assert.equal(c.fromSecretary(pair, [{ do: 'fire', id: '11' }]), 0, 'not the secretary themself');
    assert.equal(c.fromSecretary(pair, [{ do: 'fire', id: '99' }]), 0, 'not someone outside the staff');
    assert.equal(c.fromSecretary(pair, [{ do: 'hire', id: '777' }]), 0, 'not someone who did not apply');
    assert.equal(c.fromSecretary(pair, [{ do: 'fire', id: '12' }, { do: 'hire', id: '501' }]), 2);
    await new Promise((res) => setTimeout(res, 30));
    assert.deepEqual(asked, ['x 900/12']);
    const log = co.secretaryLog;
    assert.equal(log.find((x) => x.do === 'fire' && x.id === '12').state, 'done');
    const offer = co.recruit.offers[0];
    assert.equal(offer.id, '501');
    assert.equal(offer.pay, 1.05, 'the pay they expect, when the manager said none');
    assert.ok(c.rule(pair, '老板', desk()).indexOf('已经办完离职') >= 0, 'told next time how it went');
    assert.ok(c.rule(pair, '老板', desk()).indexOf('王一：日薪 105%，还在等对方回复') >= 0);
    // The applicant answers: the secretary knows how it came out, and so does the phone.
    offer.status = 'declined';
    offer.reply = '待遇再高一点我就来了';
    const told = c.rule(pair, '老板', desk());
    assert.ok(told.indexOf('王一：日薪 105%，婉拒了，回复说「待遇再高一点我就来了」') >= 0, told);
    assert.ok(told.indexOf('给 offer：王一：日薪 105%，婉拒了') >= 0, 'their own order follows the offer');
    assert.equal(c.secretary.view(co).log.find((x) => x.do === 'hire').state, 'failed');
    // An offer the manager sent from the phone is known too.
    co.recruit.offers.push({ id: '502', name: '王二', pay: 1.2, status: 'failed', note: 'TA 已经找到别的工作了，入不了职', at: Date.now() });
    assert.ok(c.rule(pair, '老板', desk()).indexOf('王二：日薪 120%，没办成（TA 已经找到别的工作了，入不了职）') >= 0);
    assert.equal(c.fromSecretary({ outsider: true, playerId: '1', partnerId: '12' }, [{ do: 'fire', id: '11' }]), 0, 'only the secretary');
    fs.rmSync(root, { recursive: true, force: true });
});
