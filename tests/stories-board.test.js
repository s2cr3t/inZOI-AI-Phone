'use strict';
// Offline tests for the phone's Stories page: what the board shows of a running story, the
// archive of ended ones, the "话里有话" mark and the ending notice in the chat. Everything is
// written under a temporary folder; no game, no API, no player data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Stories, cleanArc, hinted } = require('../lib/stories');
const { Mailbox } = require('../lib/mailbox');

const log = { info() {}, warn() {}, debug() {} };
const pair = { key: '20522-20524', playerId: '20522', partnerId: '20524' };
const PREMISE = '偷偷报名了市里的钢琴比赛，怕考砸了被笑话，谁都没告诉';

function arcRaw() {
    return {
        title: '偷偷报名的比赛', kind: '秘密', premise: PREMISE, want: '希望有人鼓励',
        beats: [
            { show: '一下课就往外跑，问去哪也不说', next: '被问起去哪' },
            { show: '承认在练琴，但不说为什么', next: '被鼓励' },
            { show: '比赛前一天很紧张', next: '比赛那天有人陪' }
        ],
        good: '拿了名次，很开心', bad: '临场紧张发挥失常', days: 4
    };
}

function setup(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stories-board-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const smsDir = path.join(root, 'ui', 'phone', 'sms');
    const ended = [];
    const facts = [];
    const d = {
        log,
        cfg: { stories: { enabled: true, gap_days: 1, drift_days: 2 }, mailbox: { dir: smsDir } },
        memory: { addFacts(p, q, list) { facts.push.apply(facts, list); } },
        storyEnded(p, done) { ended.push({ pair: p, done }); }
    };
    const stories = new Stories(d);
    stories.configure(path.join(root, 'data'));
    const s = stories.load(pair.key);
    s.active = cleanArc(arcRaw(), 3);
    s.active.partnerName = '钟亚廷';
    stories.save(pair.key, s);
    stories.tick(pair, { day: 3 });
    return { root, smsDir, stories, ended, facts, boardFile: stories.boardFile() };
}

function readBoard(stories) {
    stories.publish();
    return JSON.parse(fs.readFileSync(stories.boardFile(), 'utf8'));
}

const snap = (day) => ({ env: { day, hour: 9, minute: 0 }, partner: { name: '钟亚廷' } });

test('the board lives next to the phone mailbox, where the phone reads ui/phone/stories', (t) => {
    const { root, boardFile } = setup(t);
    assert.equal(boardFile, path.join(root, 'ui', 'phone', 'stories', 'board.cfg'));
});

test('a running story shows only what the player could notice: no premise, beats, endings or title', (t) => {
    const { stories } = setup(t);
    const board = readBoard(stories);
    assert.equal(board.v, 1);
    assert.equal(board.enabled, true);
    assert.equal(board.day, 3);
    assert.equal(board.pairs.length, 1);
    const p = board.pairs[0];
    assert.equal(p.playerId, '20522');
    assert.equal(p.contactId, '20524');
    assert.equal(p.name, '钟亚廷');
    assert.equal(p.active.revealed, false);
    assert.equal(p.active.title, '');
    assert.equal(p.active.kind, '');
    assert.equal(p.active.stage, 0);
    assert.equal(p.active.stages, 3);
    assert.equal(p.active.daysLeft, 4);
    assert.equal(p.active.soon, false);
    assert.deepEqual(p.active.clues, []);
    const text = JSON.stringify(board);
    for (const secret of [PREMISE, '偷偷报名的比赛', '拿了名次', '临场紧张', '被问起去哪', '希望有人鼓励']) {
        assert.equal(text.indexOf(secret), -1, 'board leaks ' + secret);
    }
    assert.equal(stories.heart(pair.key), null, 'no heart before anything showed');
});

test('a hinting reply adds one clue, the same words twice stay one clue, and the heart lights up', (t) => {
    const { stories } = setup(t);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '说最近一下课就往外跑，问去哪也不说' });
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '说最近一下课就往外跑，问去哪也不说' });
    stories.fromReply(pair, snap(3), { step: 'stay', hint: false, clue: '这条不该记' });
    const board = readBoard(stories);
    const a = board.pairs[0].active;
    assert.deepEqual(a.clues, [{ text: '说最近一下课就往外跑，问去哪也不说', day: 3 }]);
    assert.equal(a.revealed, false);
    assert.deepEqual(stories.heart(pair.key), { clues: 1, soon: false });
});

test('a hint without its own clue falls back to what the stage shows', (t) => {
    const { stories } = setup(t);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true });
    assert.deepEqual(readBoard(stories).pairs[0].active.clues, [{ text: '一下课就往外跑，问去哪也不说', day: 3 }]);
});

test('the title shows once the contact told what it is', (t) => {
    const { stories } = setup(t);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '说自己报了个比赛', named: true });
    const a = readBoard(stories).pairs[0].active;
    assert.equal(a.revealed, true);
    assert.equal(a.title, '偷偷报名的比赛');
    assert.equal(a.kind, '秘密');
    assert.equal(JSON.stringify(a).indexOf(PREMISE), -1, 'the premise still waits for the ending');
});

test('moving on counts as a hint and advances the stage; the last day is marked soon', (t) => {
    const { stories } = setup(t);
    stories.d.cfg.stories.drift_days = 9;
    stories.fromReply(pair, snap(3), { step: 'next', why: '被问起去哪了', clue: '终于说在练琴' });
    stories.tick(pair, { day: 6 });
    const a = readBoard(stories).pairs[0].active;
    assert.equal(a.stage, 1);
    assert.equal(a.daysLeft, 1);
    assert.equal(a.soon, true);
    assert.deepEqual(stories.heart(pair.key), { clues: 1, soon: true });
});

test('an ending in the chat goes to the archive in full, tells the daemon and is remembered', (t) => {
    const { stories, ended, facts } = setup(t);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '一下课就不见人' });
    stories.fromReply(pair, snap(3), { step: 'next', why: '被问起去哪了' });
    stories.fromReply(pair, snap(4), { step: 'end', good: true, why: '在鼓励下拿了第三名' });
    const board = readBoard(stories);
    const p = board.pairs[0];
    assert.equal(p.active, null);
    assert.equal(p.name, '钟亚廷');
    assert.equal(p.ended.length, 1);
    const e = p.ended[0];
    assert.equal(e.title, '偷偷报名的比赛');
    assert.equal(e.kind, '秘密');
    assert.equal(e.good, true);
    assert.equal(e.how, 'in the chat');
    assert.equal(e.outcome, '在鼓励下拿了第三名');
    assert.equal(e.premise, PREMISE);
    // The move and the ending let the stage they happened in show, in the stage's own words.
    assert.deepEqual(e.clues.map((c) => c.text), ['一下课就不见人', '一下课就往外跑，问去哪也不说', '承认在练琴，但不说为什么']);
    assert.deepEqual(e.steps, [{ text: '被问起去哪了', day: 3, how: 'in the chat' }]);
    assert.equal(e.startedDay, 3);
    assert.equal(e.endedDay, 4);
    assert.ok(e.at > 0);
    assert.equal(ended.length, 1);
    assert.equal(ended[0].done.id, e.id);
    assert.equal(facts.length, 1);
    assert.equal(stories.heart(pair.key), null);
});

test('running out of days ends it badly and the archive lists the newest first', (t) => {
    const { stories, ended } = setup(t);
    stories.fromReply(pair, snap(3), { step: 'end', good: true, why: '第一件好结果' });
    const s = stories.load(pair.key);
    s.active = cleanArc(Object.assign(arcRaw(), { title: '第二件事' }), 5);
    s.active.id = 'second1';
    stories.save(pair.key, s);
    stories.tick(pair, { day: 5 });
    stories.tick(pair, { day: 10 });
    const p = readBoard(stories).pairs[0];
    assert.deepEqual(p.ended.map((e) => e.title), ['第二件事', '偷偷报名的比赛']);
    assert.equal(p.ended[0].good, false);
    assert.equal(p.ended[0].how, 'ran out of days');
    assert.equal(ended[1].done.how, 'ran out of days');
});

test('the board is written again only when something changed', (t) => {
    const { stories, boardFile } = setup(t);
    stories.publish();
    const first = fs.readFileSync(boardFile, 'utf8');
    stories.publish();
    assert.equal(fs.readFileSync(boardFile, 'utf8'), first);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '新的迹象' });
    stories.publish();
    assert.notEqual(fs.readFileSync(boardFile, 'utf8'), first);
});

test('with stories switched off nothing hints and the board says so', (t) => {
    const { stories } = setup(t);
    stories.d.cfg.stories.enabled = false;
    assert.equal(stories.hinted({ hint: true }), false);
    assert.equal(stories.heart(pair.key), null);
    assert.equal(readBoard(stories).enabled, false);
});

test('hinted() reads the answer field strictly', () => {
    assert.equal(hinted({ hint: true }), true);
    assert.equal(hinted({ step: 'next' }), true);
    assert.equal(hinted({ step: 'end' }), true);
    assert.equal(hinted({ step: 'stay', hint: 'true' }), false);
    assert.equal(hinted({ step: 'stay' }), false);
    assert.equal(hinted(null), false);
    assert.equal(hinted('hint'), false);
});

test('a notice is a phone line only: never a reply, never history, and it keeps hint/story marks clean', (t) => {
    const { smsDir } = setup(t);
    const mb = new Mailbox({ dir: smsDir });
    fs.mkdirSync(path.join(smsDir, pair.key), { recursive: true });
    fs.writeFileSync(path.join(smsDir, pair.key, 'outbox.cfg'), JSON.stringify([{ id: 'o1', text: '在干嘛', at: 1000 }]));
    const notice = mb.append(pair.key, '心事有了结果 ·「偷偷报名的比赛」：你帮上了忙。', null, 'notice', { day: 4, hour: 9, minute: 0 }, { story: 's1abc' });
    assert.equal(notice.kind, 'notice');
    assert.equal(notice.story, 's1abc');
    assert.equal(notice.hint, undefined);
    let th = mb.thread(pair.key);
    assert.equal(th.inbox.length, 0);
    assert.equal(th.messages.length, 1);
    assert.equal(th.pending.length, 1, 'a notice does not answer what the player typed');
    const reply = mb.append(pair.key, '在练琴呢', 1000, 'reply', null, { hint: true, story: 'BAD ID!' });
    assert.equal(reply.hint, true);
    assert.equal(reply.story, undefined);
    th = mb.thread(pair.key);
    assert.equal(th.inbox.length, 1);
    assert.equal(th.pending.length, 0);
    const reverse = new Mailbox({ dir: smsDir }).thread('20524-20522');
    assert.equal(reverse.reverseInbox.length, 1, 'the other side sees the reply but not the notice');
    const raw = JSON.parse(fs.readFileSync(path.join(smsDir, pair.key, 'inbox.cfg'), 'utf8'));
    assert.deepEqual(raw.map((m) => m.kind), ['notice', 'reply']);
});
