'use strict';
// Offline tests for what a story's ending brings (stories.rewards): the keepsake, the trust the
// contact builds up and the deeper stories it opens, the thank-you text a while later, the days a
// story that went badly can still be made right, and what ties.js keeps of it. Everything is
// written under a temporary folder; no game, no API, no player data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Stories, cleanArc, trustOf, countsOf, TRUST } = require('../lib/stories');
const { Ties } = require('../lib/ties');

const log = { info() {}, warn() {}, debug() {} };
const pair = { key: '20522-20524', playerId: '20522', partnerId: '20524' };

function arcRaw(title) {
    return {
        title: title || '偷偷报名的比赛', kind: '秘密', premise: '偷偷报名了市里的钢琴比赛，怕考砸了被笑话', want: '希望有人鼓励',
        beats: [
            { show: '一下课就往外跑，问去哪也不说', next: '被问起去哪' },
            { show: '比赛前一天很紧张', next: '比赛那天有人陪' }
        ],
        good: '拿了名次，很开心', bad: '临场紧张发挥失常', keepsake: '第三名的奖状', days: 4
    };
}

function setup(t, over) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stories-rewards-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const told = { ended: [], mended: [], facts: [] };
    const cfg = {
        stories: Object.assign({ enabled: true, gap_days: 1, drift_days: 2, rewards: true, mend_days: 2, thanks_delay_minutes: 20, thanks_days: 4 }, over || {}),
        ties: { enabled: true, fade_days: 2 },
        mailbox: { dir: path.join(root, 'ui', 'phone', 'sms') }
    };
    const d = {
        log,
        cfg,
        memory: { addFacts(p, q, list) { told.facts.push.apply(told.facts, list); }, load() { return { facts: [] }; } },
        storyEnded(p, done) { told.ended.push(done); },
        storyMended(p, e) { told.mended.push(e); }
    };
    const ties = new Ties(d);
    ties.configure(path.join(root, 'data'));
    t.after(() => { if (ties.saveTimer) clearTimeout(ties.saveTimer); });
    d.ties = ties;
    const stories = new Stories(d);
    stories.configure(path.join(root, 'data'));
    t.after(() => { if (stories.publishTimer) clearTimeout(stories.publishTimer); });
    return { root, stories, ties, told, cfg };
}

function start(stories, day, title) {
    const s = stories.load(pair.key);
    s.active = cleanArc(arcRaw(title), day, trustOf(countsOf(s)).depth);
    s.active.id = 's' + Math.random().toString(36).slice(2, 8);
    s.active.partnerName = '钟亚廷';
    stories.save(pair.key, s);
    stories.tick(pair, { day });
    return s.active.id;
}

const snap = (day) => ({ env: { day, hour: 9, minute: 0 }, partner: { name: '钟亚廷' } });
// For the prompts: the player is the contact's mother.
const full = (day) => ({
    role: 'child', env: { day, hour: 9, minute: 0 },
    player: { name: '钟美华', firstName: '美华', gender: 'Female' },
    partner: { name: '钟亚廷', firstName: '亚廷', gender: 'Female', ageGroup: 'Teen', activity: {}, work: {} }
});

function board(stories) {
    stories.publish();
    return JSON.parse(fs.readFileSync(stories.boardFile(), 'utf8'));
}

// ---------------------------------------------------------------- trust
test('trust levels follow the stories the player helped through', () => {
    assert.deepEqual(TRUST.map((x) => x.helped), [0, 1, 2, 4]);
    const at = (helped) => trustOf({ helped, mended: 0 });
    assert.equal(at(0).title, '');
    assert.equal(at(0).depth, 0);
    assert.equal(at(0).next, 1);
    assert.equal(at(0).deeper, 2);
    assert.equal(at(1).title, '开始信任你');
    assert.equal(at(1).depth, 0);
    assert.equal(at(1).next, 1);
    assert.equal(at(2).title, '愿意对你说心里话');
    assert.equal(at(2).depth, 1);
    assert.equal(at(2).next, 2);
    assert.equal(at(2).deeper, 2);
    assert.equal(at(3).level, 2);
    assert.equal(at(4).title, '把你当最懂自己的人');
    assert.equal(at(4).depth, 2);
    assert.equal(at(4).next, 0, 'the top level has no next step');
    assert.equal(at(4).deeper, 0);
    assert.equal(at(9).level, 3);
});

test('old files without trust counts have them worked out from their endings', () => {
    const counts = countsOf({ ended: [
        { good: true, how: 'in the chat' },
        { good: true, how: 'grew up' },
        { good: false, how: 'ran out of days', mended: { day: 3 } },
        { good: true, how: 'in the chat' }
    ] });
    assert.deepEqual(counts, { helped: 2, mended: 1 });
    assert.deepEqual(countsOf({ trust: { helped: '3', mended: -1 }, ended: [] }), { helped: 3, mended: 0 });
});

test('a story helped through in the chat leaves a keepsake, a thank-you to send and one more step of trust', (t) => {
    const { stories, told } = setup(t);
    start(stories, 3);
    stories.fromReply(pair, snap(4), { step: 'end', good: true, why: '在鼓励下拿了第三名' }, true);
    assert.equal(told.ended.length, 1);
    const done = told.ended[0];
    assert.equal(done.keepsake, '第三名的奖状');
    assert.equal(done.followUp.sent, false);
    assert.equal(done.mend, undefined, 'a good ending has nothing to make right');
    const p = board(stories).pairs[0];
    assert.equal(board(stories).rewards, true);
    assert.deepEqual(board(stories).ladder, [
        { helped: 1, title: '开始信任你', depth: 0 },
        { helped: 2, title: '愿意对你说心里话', depth: 1 },
        { helped: 4, title: '把你当最懂自己的人', depth: 2 }
    ], 'the phone draws the trust ladder from the board');
    assert.equal(p.ended[0].keepsake, '第三名的奖状');
    assert.equal(p.ended[0].mend, null);
    assert.equal(p.trust.helped, 1);
    assert.equal(p.trust.title, '开始信任你');
    const tr = stories.trustFor(pair.key);
    assert.equal(tr.reached, true, 'this ending is the one that took trust to its level');
});

test('a story made before keepsakes gets one from its good ending, and the rule asks only then', (t) => {
    const { stories, told } = setup(t);
    start(stories, 3);
    assert.equal(stories.rule(pair, 3).indexOf('"keepsake"'), -1, 'the story already has one');
    const s = stories.load(pair.key);
    delete s.active.keepsake;
    stories.save(pair.key, s);
    assert.ok(stories.rule(pair, 3).indexOf('"keepsake"') >= 0);
    stories.fromReply(pair, snap(4), { step: 'end', good: true, why: '拿了第三名', keepsake: '一张合影，大家都在笑着看镜头' }, true);
    assert.equal(told.ended[0].keepsake, '一张合影，大家都在笑着看镜头'.slice(0, 16));
    assert.equal(board(stories).pairs[0].ended[0].keepsake, told.ended[0].keepsake);
    start(stories, 6, '第二件');
    const s2 = stories.load(pair.key);
    delete s2.active.keepsake;
    stories.save(pair.key, s2);
    stories.fromReply(pair, snap(7), { step: 'end', good: false, why: '没成', keepsake: '不该有' }, true);
    assert.equal(told.ended[1].keepsake, undefined, 'a bad ending leaves no keepsake');
});

test('a story that ended well on its own (grew up) gives no keepsake and no trust', (t) => {
    const { stories, told } = setup(t);
    start(stories, 3);
    stories.grewUp('20524', 'Child', 'Teen', 4);
    assert.equal(told.ended[0].how, 'grew up');
    assert.equal(told.ended[0].keepsake, undefined);
    assert.equal(told.ended[0].followUp, undefined);
    assert.equal(told.ended[0].mend, undefined, 'growing up is not something to make right');
    assert.equal(stories.trustFor(pair.key).helped, 0);
});

test('trust is counted apart from the archive, so it outlives the endings kept', (t) => {
    const { stories } = setup(t);
    for (let i = 0; i < 14; i++) {
        start(stories, 10 + i * 2, '第' + i + '件');
        stories.fromReply(pair, snap(11 + i * 2), { step: 'end', good: true, why: '好了' }, true);
    }
    const s = stories.load(pair.key);
    assert.equal(s.ended.length, 12);
    assert.equal(s.trust.helped, 14);
    const p = board(stories).pairs[0];
    assert.equal(p.trust.level, 3);
    assert.equal(stories.trustFor(pair.key).reached, false, 'past the top level no ending reaches it again');
});

test('more trust makes the next story deeper, and the prompt says how', (t) => {
    const { stories } = setup(t);
    const s = stories.load(pair.key);
    s.trust = { helped: 2, mended: 0 };
    stories.save(pair.key, s);
    const p = stories.prompt(pair, full(3), stories.load(pair.key));
    assert.equal(p.depth, 1);
    assert.ok(p.system.indexOf('7. 这个人已经很信任妈妈') >= 0);
    assert.equal(p.system.indexOf('{call}'), -1, 'what the contact calls the player is filled in');
    assert.ok(p.system.indexOf('keepsake') >= 0);
    assert.equal(cleanArc(arcRaw(), 3, p.depth).depth, 1);
    assert.equal(cleanArc(arcRaw(), 3, 7).depth, 2);
    assert.equal(cleanArc(arcRaw(), 3).depth, 0);
    stories.d.cfg.stories.rewards = false;
    const off = stories.prompt(pair, full(3), stories.load(pair.key));
    assert.equal(off.depth, 0, 'without rewards the stories stay as they were');
    assert.equal(off.system.indexOf('7. 这个人'), -1);
});

// ---------------------------------------------------------------- making it right
test('a story that ran out leaves a grudge and stays mendable for mend_days', (t) => {
    const { stories, ties, told } = setup(t);
    start(stories, 3);
    stories.tick(pair, { day: 8 });
    const done = told.ended[0];
    assert.equal(done.how, 'ran out of days');
    assert.equal(done.mend.until, 10);
    assert.equal(done.keepsake, undefined);
    const e = stories.load(pair.key).ended[0];
    const grudge = ties.open('20524', '20522')[0];
    assert.ok(grudge, 'not noticing it stings');
    assert.equal(e.mend.grudge, grudge.id);
    let m = board(stories).pairs[0].ended[0].mend;
    assert.deepEqual(m, { state: 'open', daysLeft: 2 });
    stories.tick(pair, { day: 10 });
    m = board(stories).pairs[0].ended[0].mend;
    assert.deepEqual(m, { state: 'open', daysLeft: 0 });
    stories.tick(pair, { day: 11 });
    assert.deepEqual(board(stories).pairs[0].ended[0].mend, { state: 'missed' });
    assert.equal(stories.mendable(stories.load(pair.key), 11), null);
});

test('comforting them in a reply makes it right: the grudge eases, trust counts it and the daemon is told', (t) => {
    const { stories, ties, told } = setup(t);
    start(stories, 3);
    stories.tick(pair, { day: 8 });
    const grudge = ties.open('20524', '20522')[0];
    stories.fromReply(pair, snap(9), { mend: true, why: '你来问我，还说下次陪我去' }, true);
    const e = stories.load(pair.key).ended[0];
    assert.equal(e.mended.day, 9);
    assert.equal(e.mended.text, '你来问我，还说下次陪我去');
    assert.equal(told.mended.length, 1);
    assert.equal(grudge.weight, 0, 'the grudge it left is settled');
    assert.equal(stories.load(pair.key).trust.mended, 1);
    assert.deepEqual(board(stories).pairs[0].ended[0].mend, { state: 'mended', day: 9, text: '你来问我，还说下次陪我去' });
    stories.fromReply(pair, snap(9), { mend: true, why: '再一次' }, true);
    assert.equal(told.mended.length, 1, 'made right once');
});

test('a text the contact sent first cannot make it right, nor can a late reply', (t) => {
    const { stories, told } = setup(t);
    start(stories, 3);
    stories.tick(pair, { day: 8 });
    stories.fromReply(pair, snap(9), { mend: true, why: '主动发的' }, false);
    assert.equal(told.mended.length, 0);
    stories.fromReply(pair, snap(11), { mend: true, why: '太晚了' }, true);
    assert.equal(told.mended.length, 0);
    assert.equal(stories.load(pair.key).ended[0].mended, undefined);
});

test('a bad ending in the chat is mendable too, without a grudge to ease', (t) => {
    const { stories, told } = setup(t);
    start(stories, 3);
    stories.fromReply(pair, snap(4), { step: 'end', good: false, why: '被说了一句就放弃了' }, true);
    assert.deepEqual(told.ended[0].mend, { until: 6, grudge: '' });
    stories.fromReply(pair, snap(5), { mend: true, why: '道歉了' }, true);
    assert.equal(told.mended.length, 1);
});

test('the answer rule asks for mend only while a story can be made right', (t) => {
    const { stories } = setup(t);
    assert.equal(stories.rule(pair, 3), '', 'no story, no rule');
    start(stories, 3);
    const running = stories.rule(pair, 3);
    assert.ok(running.indexOf('"step":"next"') >= 0);
    assert.equal(running.indexOf('"mend":true'), -1);
    stories.tick(pair, { day: 8 });
    const mendOnly = stories.rule(pair, 9);
    assert.ok(mendOnly.indexOf('"mend":true') >= 0);
    assert.ok(/没有就写 \{\}。$/.test(mendOnly), 'with no story running the rule asks for nothing else');
    assert.equal(stories.rule(pair, 11), '');
    assert.equal(stories.rule(pair, null), '');
    const block = stories.block(pair, full(9));
    assert.ok(block.indexOf('「偷偷报名的比赛」这件事妈妈一直没察觉，你心里还有点在意') >= 0);
    assert.equal(stories.block(pair, full(11)).indexOf('还有点在意'), -1, 'past the window it is not brought up');
});

test('with rewards off nothing is mendable, nothing is owed and the board says so', (t) => {
    const { stories, told } = setup(t, { rewards: false });
    start(stories, 3);
    stories.fromReply(pair, snap(4), { step: 'end', good: false, why: '没成' }, true);
    assert.equal(told.ended[0].mend, undefined);
    assert.equal(stories.rule(pair, 5), '');
    assert.equal(board(stories).rewards, false);
    start(stories, 6, '第二件');
    stories.fromReply(pair, snap(7), { step: 'end', good: true, why: '成了' }, true);
    assert.equal(told.ended[1].followUp, undefined);
    assert.equal(told.ended[1].keepsake, '第三名的奖状', 'the keepsake is part of the story itself');
    assert.equal(stories.followUp(pair, Date.now() + 3600000), null);
});

// ---------------------------------------------------------------- the thank-you text
test('the thank-you waits its delay, is sent once, and is dropped when too late', (t) => {
    const { stories, told } = setup(t);
    start(stories, 3);
    stories.fromReply(pair, snap(4), { step: 'end', good: true, why: '拿了第三名' }, true);
    const at = told.ended[0].at;
    assert.equal(stories.followUp(pair, at + 19 * 60000), null, 'not before thanks_delay_minutes');
    const f = stories.followUp(pair, at + 21 * 60000);
    assert.equal(f.title, '偷偷报名的比赛');
    assert.equal(f.keepsake, '第三名的奖状');
    assert.equal(f.outcome, '拿了第三名');
    assert.equal(stories.followUp(pair, at + 6 * 3600000), null, 'too late to say thanks');
    stories.followedUp(pair, f.id);
    assert.equal(stories.followUp(pair, at + 30 * 60000), null, 'sent once');
    assert.equal(stories.load(pair.key).ended[0].followUp.sent, true);
});

// ---------------------------------------------------------------- what ties keeps
test('a thank warms the tie, eases a light grudge and is kept in mind for thanks_days', (t) => {
    const { ties } = setup(t);
    const g = ties.grudge('20524', '20522', '上次没回消息', 1, 3, 'chat');
    const k = ties.storyHelped(pair, '偷偷报名的比赛', 4);
    assert.ok(k && /^k\d+$/.test(k.id));
    assert.equal(g.weight, 0, 'helping them makes up for a light grudge');
    assert.equal(ties.tie('20524', '20522').warmth, -1 + 3);
    assert.equal(ties.storyHelped(pair, '偷偷报名的比赛', 4), null, 'the same help is one thank');
    ties.storyHelped(pair, '第二件', 6);
    assert.deepEqual(ties.thanksFor('20524', '20522', 6).map((x) => x.about), ['「第二件」那件事多亏了你', '「偷偷报名的比赛」那件事多亏了你']);
    assert.deepEqual(ties.thanksFor('20524', '20522', 9).map((x) => x.about), ['「第二件」那件事多亏了你']);
    assert.deepEqual(ties.thanksFor('20522', '20524', 6), []);
    const block = ties.block(pair, Object.assign({ call: '你' }, snap(6)), new Map());
    assert.ok(block.indexOf('【你记着的好】') >= 0);
    assert.ok(block.indexOf('「第二件」那件事多亏了你') >= 0);
});

// ---------------------------------------------------------------- what the daemon hands out
// The daemon's own methods on a stand-in: the notice is captured, moodlets and posts recorded.
function daemonFor(t, over) {
    const { Daemon } = require('../lib/daemon');
    const env = setup(t, over);
    const got = { notices: [], moods: [], posts: [] };
    const dm = Object.create(Daemon.prototype);
    Object.assign(dm, {
        log,
        cfg: Object.assign(env.cfg, { moments: { enabled: true } }),
        stories: env.stories,
        ties: env.ties,
        world: { household: async () => ({ members: [
            { entity_id: 20522, name: '钟美华', first_name: '美华', last_name: '钟' },
            { entity_id: 20524, name: '钟亚廷', first_name: '亚廷', last_name: '钟' }
        ] }) },
        buffs: { storyMood: async (p, people, effects, why) => { got.moods.push({ people, effects, why }); return effects.length; } },
        moments: { occasion: (author, viewer, text, delay, keep) => got.posts.push({ author, viewer, text, delay, keep }) },
        storyNotice: (p, text, id, name) => got.notices.push({ text, id, name })
    });
    env.stories.d.storyEnded = (p, done) => dm.storyEnded(p, done);
    env.stories.d.storyMended = (p, e) => dm.storyMended(p, e);
    return Object.assign(env, { dm, got });
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('a helped ending: notice with keepsake and trust, moodlets on both, warmth and a Moments post later', async (t) => {
    const { stories, ties, got } = daemonFor(t);
    start(stories, 3);
    stories.fromReply(pair, snap(4), { step: 'end', good: true, why: '在鼓励下拿了第三名' }, true);
    await settle();
    assert.equal(got.notices.length, 1);
    assert.equal(got.notices[0].text, '心事有了结果 ·「偷偷报名的比赛」：你帮上了忙。在鼓励下拿了第三名。留下了「第三名的奖状」。钟亚廷现在「开始信任你」。');
    assert.equal(got.moods.length, 1);
    assert.deepEqual(got.moods[0].effects.map((e) => [e.who, e.emotion, e.strength]), [['partner', 'Touched', 2], ['player', 'Touched', 1]]);
    assert.equal(got.moods[0].people.player.id, '20522');
    assert.equal(ties.thanksFor('20524', '20522', 4).length, 1);
    assert.equal(got.posts.length, 1);
    assert.equal(got.posts[0].author, '20524');
    assert.equal(got.posts[0].viewer, '20522');
    assert.ok(got.posts[0].delay >= 30 * 60000 && got.posts[0].delay <= 90 * 60000);
    assert.ok(got.posts[0].text.indexOf('第三名的奖状') >= 0);
});

test('the notice says when trust opens deeper stories', async (t) => {
    const { stories, got } = daemonFor(t);
    const s = stories.load(pair.key);
    s.trust = { helped: 1, mended: 0 };
    stories.save(pair.key, s);
    start(stories, 3);
    stories.fromReply(pair, snap(4), { step: 'end', good: true, why: '成了！' }, true);
    await settle();
    assert.ok(got.notices[0].text.indexOf('成了！留下了') >= 0, 'an outcome that already ends a sentence gets no extra full stop');
    assert.ok(/钟亚廷现在「愿意对你说心里话」，以后会跟你说更深的心事。$/.test(got.notices[0].text));
});

test('a missed ending: the notice says it is not too late, the contact is a little sad, no post', async (t) => {
    const { stories, got } = daemonFor(t);
    start(stories, 3);
    stories.tick(pair, { day: 8 });
    await settle();
    assert.ok(/^你没察觉到的心事 ·「偷偷报名的比赛」：临场紧张发挥失常。这两天去问问、安慰一下，还来得及。$/.test(got.notices[0].text), got.notices[0].text);
    assert.deepEqual(got.moods[0].effects.map((e) => [e.who, e.emotion, e.strength]), [['partner', 'Sad', 1]]);
    assert.equal(got.posts.length, 0);
    stories.fromReply(pair, snap(9), { mend: true, why: '你来问我了' }, true);
    await settle();
    assert.equal(got.notices[1].text, '后来你还是来问了 ·「偷偷报名的比赛」：钟亚廷心里好受多了。');
    assert.deepEqual(got.moods[1].effects.map((e) => [e.who, e.emotion, e.strength]), [['partner', 'Touched', 1]]);
});

test('with rewards off the notice is as before and nothing is handed out', async (t) => {
    const { stories, ties, got } = daemonFor(t, { rewards: false });
    start(stories, 3);
    stories.fromReply(pair, snap(4), { step: 'end', good: true, why: '在鼓励下拿了第三名' }, true);
    await settle();
    assert.equal(got.notices[0].text, '心事有了结果 ·「偷偷报名的比赛」：你帮上了忙。在鼓励下拿了第三名');
    assert.equal(got.moods.length, 0);
    assert.equal(got.posts.length, 0);
    assert.equal(ties.thanksFor('20524', '20522', 4).length, 0);
});

test('making it right settles the grudge it left and brings some warmth back', (t) => {
    const { ties } = setup(t);
    const g = ties.storyMissed(pair, '偷偷报名的比赛', 5);
    assert.equal(g.weight, 1);
    const before = ties.tie('20524', '20522').warmth;
    ties.storyMended(pair, g.id, '偷偷报名的比赛');
    assert.equal(g.weight, 0);
    assert.equal(ties.tie('20524', '20522').warmth, before + 2);
    ties.cfg.enabled = false;
    assert.equal(ties.storyHelped(pair, '关掉之后', 6), null);
});
