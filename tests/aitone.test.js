'use strict';
const test = require('node:test');
const assert = require('node:assert');
const tone = require('../lib/aitone');
const { LlmClient } = require('../lib/llm');

const BANNED = [
    ['我不是生气，而是有点失望。', 'not_but'],
    ['與其說是生氣，不如說是失望', 'rather_than'],
    ['某種意義上，你說得對', 'in_a_sense'],
    ['彷彿回到了小時候', 'as_if'],
    ['你就像阳光一样温暖', 'simile_feel'],
    ['值得一提的是，今天的菜很好吃', 'worth_noting'],
    ['總而言之，早點睡', 'summing_up'],
    ['这不仅是一顿饭，更是一份心意', 'not_only_more'],
    ['有你在的地方，有你在的日子，有你在的家', 'parallel'],
    ['那一刻我心中涌起一股暖流，好想你', 'lyrical'],
    ['这一切温暖又美好', 'feel_stack'],
    ['我理解你的感受，别难过', 'assistant'],
    ['今天好累——不想动', 'em_dash']
];

const PLAIN = ['不是我，是他吃的', '不是吧，又加班', '我在路上了，马上到', '你吃饭了没？我刚下班', '像个小孩一样哭',
    '哈哈哈哈，哈哈哈哈哈，哈哈哈哈', '妈，晚上吃啥', '有点累，有点饿，有点困', '與其在家悶著，不如出去走走', '總之你快回來', '好啦好啦 我去洗碗'];

test('banned turns of phrase are caught, simplified and traditional, and cut', () => {
    for (const [line, id] of BANNED) {
        assert.ok(tone.hits(line).some((h) => h.id === id), line + ' should hit ' + id);
        assert.deepStrictEqual(tone.hits(tone.scrub(line)), [], line + ' → ' + tone.scrub(line));
    }
    assert.strictEqual(tone.scrub('與其說是生氣，不如說是失望'), '其实是失望');
    assert.strictEqual(tone.scrub('我不是生气，而是有点失望。'), '我不是生气，是有点失望。');
});

test('everyday chat is left alone', () => {
    for (const line of PLAIN) {
        assert.deepStrictEqual(tone.hits(line), [], line);
        assert.strictEqual(tone.scrub(line), line);
    }
});

test('llm voice: one rewrite is asked, other fields kept, leftovers cut', async () => {
    const asked = [];
    const fake = {
        log: null,
        reserve() {},
        async once(messages) {
            asked.push(messages[messages.length - 1].content);
            return { content: JSON.stringify({ messages: ['没生气，就是有点失望', '总而言之早点睡'], actions: ['changed'] }) };
        }
    };
    const first = { messages: ['我不是生气，而是有点失望'], actions: [{ type: 'go_home' }] };
    const out = await LlmClient.prototype.voiced.call(fake, [], '{}', first, { voice: ['messages'], purpose: 'reply' });
    assert.strictEqual(asked.length, 1);
    assert.match(asked[0], /不是……而是/);
    assert.deepStrictEqual(out.messages, ['没生气，就是有点失望', '早点睡']);
    assert.deepStrictEqual(out.actions, [{ type: 'go_home' }]);
    const clean = { text: '收到，辛苦' };
    assert.strictEqual(await LlmClient.prototype.voiced.call(fake, [], '{}', clean, { voice: ['text'] }), clean);
    assert.strictEqual(asked.length, 1);
});
