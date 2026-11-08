'use strict';
// Face-to-face talks (lib/focus.js): what is said in person is its own conversation, answered
// in spoken lines with a face and a gesture, and never written into the texts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const persona = require('../lib/persona');
const { FocusTalks } = require('../lib/focus');
const focusBody = require('../lib/focus-body');

const cfg = { reply: { max_bubbles: 4, bubble_max_chars: 40 } };
const snap = (talk) => ({
    talk,
    role: 'family', label: '弟弟', env: { day: 1, hour: 20, minute: 0 },
    player: { name: '钟亚廷', firstName: '亚廷', gender: 'Female', ageGroup: 'HighTeen' },
    partner: { name: '宗子怡', gender: 'Male', ageGroup: 'LowTeen', activity: {}, work: {} }
});

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'focus-talk-'));
}

function write(dir, key, name, value) {
    fs.mkdirSync(path.join(dir, key), { recursive: true });
    fs.writeFileSync(path.join(dir, key, name + '.cfg'), JSON.stringify(value));
}

test('what was said and not answered yet is pending, answers carry face and gesture', () => {
    const dir = tmpDir();
    const talks = new FocusTalks({ dir });
    write(dir, '20524-43386', 'said', [{ id: 's1', text: '你好呀', at: 1000 }]);
    write(dir, '20524-43386', 'session', { state: 'open', at: 900 });
    let t = talks.talk('20524-43386');
    assert.strictEqual(t.open, true);
    assert.deepStrictEqual(t.pending.map((m) => m.text), ['你好呀']);
    talks.append('20524-43386', '嗨，姐', 1000, { face: 'Joyful', gesture: 'greet' });
    write(dir, '20524-43386', 'said', [{ id: 's1', text: '你好呀', at: 1000 }, { id: 's2', text: '吃饭了吗', at: Date.now() + 5000 }]);
    t = talks.talk('20524-43386');
    assert.deepStrictEqual(t.pending.map((m) => m.text), ['吃饭了吗']);
    assert.deepStrictEqual(t.messages.map((m) => m.side), ['player', 'partner', 'player']);
    assert.strictEqual(t.heard[0].face, 'Joyful');
    assert.strictEqual(t.heard[0].gesture, 'greet');
    assert.deepStrictEqual(talks.talks().map((k) => k.key), ['20524-43386']);
});

test('a talk folder never holds texts: the mailbox files are not touched', () => {
    const dir = tmpDir();
    const talks = new FocusTalks({ dir });
    talks.append('1-2', '好的', 5, {});
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, '1-2')).sort(), ['heard.cfg']);
});

test('the rules of a talk are spoken, with a face and a gesture to pick', () => {
    const talk = persona.rulesBlock(snap(true), cfg);
    assert.match(talk, /当面说话/);
    assert.match(talk, /"face":"Normal","gesture":""/);
    assert.match(talk, /Joyful（愉快）/);
    assert.match(talk, /greet（打招呼）/);
    assert.doesNotMatch(talk, /在给亚廷发微信/);
    const texts = persona.rulesBlock(snap(false), cfg);
    assert.match(texts, /发微信/);
    assert.doesNotMatch(texts, /"face"/);
    // Both keep the shared rules.
    for (const r of [talk, texts]) assert.match(r, /不要自问自答/);
});

test('the model\'s face and gesture are kept only when the game has them', () => {
    assert.strictEqual(focusBody.cleanFace('joyful'), 'Joyful');
    assert.strictEqual(focusBody.cleanFace('Grinning'), '');
    assert.strictEqual(focusBody.cleanGesture('Laugh'), 'laugh');
    assert.strictEqual(focusBody.cleanGesture('dance'), '');
});

test('a gesture plays the first motion this character can play, and is looked up once', async () => {
    const calls = [];
    const game = {
        soft: async (tool, args) => {
            calls.push(tool + ':' + (args.Filter || args.anim_id || args.Expression));
            if (tool === 'motion_list') return args.Filter === 'StreetGreeting_01' ? [{ anim_id: 'StreetGreeting_01' }] : [];
            return { ok: true };
        }
    };
    const cache = new Map();
    const d = await focusBody.perform(game, 43386, 'Joyful', 'greet', cache);
    assert.deepStrictEqual(d, { face: 'Joyful', motion: 'StreetGreeting_01' });
    calls.length = 0;
    await focusBody.perform(game, 43386, '', 'greet', cache);
    assert.deepStrictEqual(calls, ['motion_play:StreetGreeting_01']);
});
