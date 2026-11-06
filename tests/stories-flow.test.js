'use strict';
// Offline tests for how a story moves through the chat: the stage's condition read loosely, what
// the stage already let show (not to be said again), the cap on hints a game day and which
// message carries the "话里有话" mark. Everything is written under a temporary folder; no game,
// no API, no player data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Stories, cleanArc } = require('../lib/stories');

const log = { info() {}, warn() {}, debug() {} };
const pair = { key: '20522-20524', playerId: '20522', partnerId: '20524' };

function arcRaw() {
    return {
        title: '门后面的画', kind: '惊喜', premise: '在后门那面墙上偷偷画一幅花，想给妈妈一个惊喜', want: '希望妈妈先别看',
        beats: [
            { show: '让妈妈别擦门后面那块地方', next: '妈妈问起在弄什么' },
            { show: '手上沾了紫色颜料，问颜色怎么调', next: '妈妈关心她在画什么' },
            { show: '说画坏了一朵花，想改', next: '妈妈出主意' }
        ],
        good: '画好了，妈妈很感动', bad: '画没完成', days: 4
    };
}

function setup(t, cap) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stories-flow-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cfg = { enabled: true, gap_days: 1, drift_days: 2 };
    if (cap !== undefined) cfg.hints_per_day = cap;
    const d = {
        log,
        cfg: { stories: cfg, mailbox: { dir: path.join(root, 'ui', 'phone', 'sms') } },
        memory: { addFacts() {} },
        storyEnded(p, done) { stories.endings.push(done); },
        storyAdvanced(p, story, why) { stories.moves.push({ stage: story.stage, why }); }
    };
    const stories = new Stories(d);
    stories.endings = [];
    stories.moves = [];
    stories.configure(path.join(root, 'data'));
    t.after(() => { if (stories.publishTimer) clearTimeout(stories.publishTimer); });
    const s = stories.load(pair.key);
    s.active = cleanArc(arcRaw(), 3);
    stories.save(pair.key, s);
    return stories;
}

// The daughter texting her mother.
const snap = (day) => ({
    env: { day, hour: 9, minute: 0 }, role: 'child',
    player: { gender: 'Female', firstName: '会荣' }, partner: { gender: 'Female', name: '钟亚廷' }
});

test('the stage condition is a direction: answering or asking about it moves the story on', (t) => {
    const stories = setup(t);
    const block = stories.block(pair, snap(3));
    assert.match(block, /进入下一段的大方向（不用一字不差）：妈妈问起在弄什么/);
    assert.match(block, /只要接住了这件事——问起、回答了你的问题、关心、出主意、表示想看——就算到了/);
    const rule = stories.rule(pair, 3);
    assert.match(rule, /回答了你的问题/);
    assert.match(rule, /"why":"对方是怎么回应的"/);
    assert.doesNotMatch(rule, /多数时候是 stay/);
});

test('the next stages follow how the player answered', (t) => {
    const stories = setup(t);
    stories.fromReply(pair, snap(3), { step: 'next', why: '妈妈问她们到底在弄什么' }, true);
    const block = stories.block(pair, snap(3));
    assert.match(block, /之前妈妈是这样回应的：妈妈问她们到底在弄什么/);
    assert.match(block, /接下来的事要顺着妈妈的回应走/);
});

test('what the stage already let show is not to be said again, and a new stage starts clean', (t) => {
    const stories = setup(t, 5);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '让别擦门后面那块地方' }, true);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '又说门后面别擦' }, true);
    let block = stories.block(pair, snap(3));
    assert.match(block, /这一段你已经流露过（妈妈都看到了）：让别擦门后面那块地方；又说门后面别擦。同样的话、同样的问题不要再说/);
    stories.fromReply(pair, snap(3), { step: 'next', why: '妈妈问起在弄什么' }, true);
    block = stories.block(pair, snap(3));
    assert.doesNotMatch(block, /这一段你已经流露过/);
    // The Stories page still keeps every clue, the moving reply's own included.
    assert.equal(stories.load(pair.key).active.clues.length, 3);
});

test('a contact lets the story show at most hints_per_day times a game day', (t) => {
    const stories = setup(t, 2);
    assert.match(stories.block(pair, snap(3)), /今天还可以自然地流露 2 次。每次都要比上一次多让妈妈知道一点新的东西/);
    assert.equal(stories.hintAt(pair, { step: 'stay', hint: true }, 3, 2), 1);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '第一条迹象' }, true);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '第二条迹象' }, true);
    // The third one today: no mark, no clue, and the prompt says to leave it.
    assert.equal(stories.hintAt(pair, { step: 'stay', hint: true }, 3, 2), -1);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '第三条迹象' }, true);
    assert.deepEqual(stories.load(pair.key).active.clues.map((c) => c.text), ['第一条迹象', '第二条迹象']);
    assert.match(stories.block(pair, snap(3)), /今天你已经流露过 2 次这件事了：今天别再主动提，也别再暗示；妈妈问起再说/);
    assert.match(stories.rule(pair, 3), /今天已经流露够了：除非对方问起，"hint" 写 false/);
    // A reply that moves it on still counts, and a new day starts over.
    assert.equal(stories.hintAt(pair, { step: 'next', hint: true }, 3, 1), 0);
    assert.equal(stories.hintAt(pair, { step: 'stay', hint: true }, 4, 1), 0);
    assert.match(stories.block(pair, snap(4)), /今天还可以自然地流露 2 次/);
});

test('without the setting a contact still stops after two a day', (t) => {
    const stories = setup(t);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '一' }, true);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '二' }, true);
    assert.equal(stories.hintAt(pair, { step: 'stay', hint: true }, 3, 1), -1);
});

test('the mark goes on the message the answer names, else the last one', (t) => {
    const stories = setup(t);
    assert.equal(stories.hintAt(pair, { step: 'stay', hint: true, hint_at: 0 }, 3, 3), 0);
    assert.equal(stories.hintAt(pair, { step: 'stay', hint: true, hint_at: 1 }, 3, 3), 1);
    assert.equal(stories.hintAt(pair, { step: 'stay', hint: true, hint_at: 7 }, 3, 3), 2, 'out of range falls back to the last');
    assert.equal(stories.hintAt(pair, { step: 'stay', hint: true }, 3, 3), 2);
    assert.equal(stories.hintAt(pair, { step: 'stay', hint: false }, 3, 3), -1);
});

// Lets the minimum time between two moves pass.
function later(stories) {
    const s = stories.load(pair.key);
    s.active.movedAt -= 3 * 60000;
    if (s.active.hintedAt) s.active.hintedAt -= 3 * 60000;
    stories.save(pair.key, s);
}

test('a reply first makes the story show, then the answer of the player moves it on', (t) => {
    const stories = setup(t);
    assert.equal(stories.mustOf(pair, 3), 'surface');
    assert.match(stories.rule(pair, 3, 'surface'), /这次回复要带出这件心事：hint 写 true/);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '让别擦门后面那块地方' }, true, { must: 'surface' });
    assert.equal(stories.mustOf(pair, 3), 'advance');
    assert.match(stories.rule(pair, 3, 'advance'), /必须往前走：story 写 {"step":"next"/);
    const sn = Object.assign(snap(3), { storyMust: 'advance' });
    assert.match(stories.block(pair, sn), /这次就进入下一段，直接让妈妈知道：手上沾了紫色颜料，问颜色怎么调/);
    // The model still wrote stay: the answer moves it on anyway, and the chat says so.
    stories.fromReply(pair, snap(3), { step: 'stay' }, true, { must: 'advance' });
    assert.equal(stories.load(pair.key).active.stage, 1);
    assert.equal(stories.moves.length, 1);
    assert.equal(stories.moves[0].stage, 1);
});

test('no story field at all still moves it on when the player answered', (t) => {
    const stories = setup(t);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '一' }, true, { must: 'surface' });
    stories.fromReply(pair, snap(3), undefined, true, { must: 'advance' });
    assert.equal(stories.load(pair.key).active.stage, 1);
});

test('right after a move the next answer waits a moment, then must move it again', (t) => {
    const stories = setup(t);
    stories.fromReply(pair, snap(3), { step: 'next', why: '妈妈问起在弄什么', hint: true }, true, {});
    assert.equal(stories.mustOf(pair, 3), 'surface', 'the new stage has not shown yet');
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '紫色的手' }, true, { must: 'surface' });
    assert.equal(stories.mustOf(pair, 3), '', 'too soon after the last move');
    later(stories);
    assert.equal(stories.mustOf(pair, 3), 'advance');
});

test('a text the contact sends first does not count as the player answering', (t) => {
    const stories = setup(t);
    stories.fromReply(pair, snap(3), { step: 'stay', hint: true, clue: '一' }, true, { must: 'surface' });
    stories.fromReply(pair, snap(3), { step: 'stay' }, false, { must: 'advance' });
    assert.equal(stories.load(pair.key).active.stage, 0);
});

test('a player who took part gets the good ending, unless these very words hurt', (t) => {
    const helped = setup(t);
    helped.fromReply(pair, snap(3), { step: 'next', why: '妈妈问起' }, true, {});
    helped.fromReply(pair, snap(3), { step: 'end', good: false, why: '画没画完' }, true, { felt: { level: 0 } });
    assert.equal(helped.endings[0].good, true);
    assert.equal(helped.endings[0].outcome, '画好了，妈妈很感动');
    const hurt = setup(t);
    hurt.fromReply(pair, snap(3), { step: 'next', why: '妈妈问起' }, true, {});
    hurt.fromReply(pair, snap(3), { step: 'end', good: false, why: '妈妈说画得真丑' }, true, { felt: { level: -2 } });
    assert.equal(hurt.endings[0].good, false);
    const never = setup(t);
    never.fromReply(pair, snap(3), { step: 'end', good: false, why: '没人理' }, true, { felt: { level: 0 } });
    assert.equal(never.endings[0].good, false, 'without taking part the ending of the model stands');
});

test('time running out ends well for a player who took part, badly for one who never did', (t) => {
    const helped = setup(t);
    helped.fromReply(pair, snap(3), { step: 'next', why: '妈妈问起' }, true, {});
    helped.tick(pair, { day: 20 });
    assert.equal(helped.endings[0].good, true);
    assert.equal(helped.endings[0].how, 'in the chat');
    const never = setup(t);
    never.tick(pair, { day: 20 });
    assert.equal(never.endings[0].good, false);
    assert.equal(never.endings[0].how, 'ran out of days');
});

test('each move in the chat gives it at least a day more, and drifting never takes the last stage', (t) => {
    const stories = setup(t);
    const s = stories.load(pair.key);
    s.active.endsBy = 4;
    stories.save(pair.key, s);
    stories.fromReply(pair, snap(4), { step: 'next', why: '妈妈问起' }, true, {});
    assert.equal(stories.load(pair.key).active.endsBy, 5);
    // Nobody answers for days: it drifts to the second-to-last stage and stops there.
    const quiet = setup(t);
    const q = quiet.load(pair.key);
    q.active.endsBy = 30;
    quiet.save(pair.key, q);
    quiet.tick(pair, { day: 6 });
    quiet.tick(pair, { day: 9 });
    quiet.tick(pair, { day: 12 });
    assert.equal(quiet.load(pair.key).active.stage, 1, 'three stages: the drift stops before the last');
});
