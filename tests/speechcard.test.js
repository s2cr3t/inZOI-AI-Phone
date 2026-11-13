'use strict';
// Each character texts their own way: habits drawn from traits and id, the same every time, and
// a reply held to them (how many texts, how many emoji, full stops) without losing what was said.
const test = require('node:test');
const assert = require('node:assert/strict');
const { card, text, pick, shape } = require('../lib/speechcard');

test('speech cards: how many texts varies per reply, mostly one, fewer after a word', () => {
    const chatty = { talk: 'chatty', max: 3 };
    const tally = (said) => {
        const h = { 1: 0, 2: 0, 3: 0 };
        let x = 0;
        for (let i = 0; i < 300; i++) h[pick(chatty, said, 3, () => (x = (x * 9301 + 49297) % 233280) / 233280)]++;
        return h;
    };
    const short = tally(['差不多']);
    const usual = tally(['我不知道呀，好像两次吧']);
    assert.ok(short[1] > short[3] && usual[3] > short[3], 'a word gets fewer texts back than a sentence');
    assert.ok(usual[1] > 0 && usual[2] > 0 && usual[3] > 0, 'not the same count every time');
    assert.equal(pick({ talk: 'terse', max: 2 }, ['嗯'], 3, () => 0.99), 1);
    const r = shape({ talk: 'chatty', max: 3, emoji: 'none', punct: 'proper' }, ['两次啊 那还行', '我还以为你们天天在画室', '平时都干嘛'], null, null, 1);
    assert.deepEqual(r.messages, ['两次啊 那还行 我还以为你们天天在画室 平时都干嘛'], 'held to the count drawn, nothing lost');
});

test('speech cards: from traits, stable, and not all alike', () => {
    const shy = card({ id: 1, traits: { traits: ['Trait_Introvert', 'Trait_Gloomy'] }, ageGroup: 'Adult' });
    assert.equal(shy.talk, 'terse');
    assert.equal(shy.emoji, 'none');
    const loud = card({ id: 2, traits: { traits: ['Trait_Extrovert', 'Trait_Cheerful'] }, ageGroup: 'HighTeen' });
    assert.equal(loud.talk, 'chatty');
    assert.equal(loud.emoji, 'fond');
    assert.deepEqual(card({ id: 2, traits: { traits: ['Trait_Extrovert', 'Trait_Cheerful'] }, ageGroup: 'HighTeen' }), loud, 'same person, same card');
    const plain = [];
    for (let id = 100; id < 140; id++) plain.push(JSON.stringify(card({ id, traits: {}, ageGroup: 'Adult' })));
    assert.ok(new Set(plain).size > 15, 'people with no telling traits still differ');
    assert.match(text(loud, false), /口头禅/);
    assert.doesNotMatch(text(shy, true), /表情/, 'face to face has no emoji habit');
});

test('speech cards: a reply held to the habits, nothing said lost', () => {
    const terse = { talk: 'terse', max: 2, emoji: 'none', fav: [], punct: 'bare', phrases: ['行吧'] };
    const r = shape(terse, ['到家了。[开心]', '饿死了[馋]', '你吃了没？'], ['到家了。', '饿死了', '你吃了没？']);
    assert.deepEqual(r.messages, ['到家了', '饿死了 你吃了没？'], 'two texts at most, no emoji, no full stop');
    assert.deepEqual(r.voice, ['到家了。', '饿死了，你吃了没？'], 'read-aloud lines follow');
    assert.deepEqual(shape(terse, ['[抱抱]'], null).messages, ['[抱抱]'], 'an emoji-only reply stays');
    const fond = { talk: 'chatty', max: 3, emoji: 'fond', fav: ['开心'], punct: 'proper', phrases: [] };
    const f = shape(fond, ['好呀[开心][开心]', '等我[加油]', '马上[OK]'], null);
    assert.equal(f.messages.join('').match(/\[/g).length, 2, 'two emoji in a reply at most, one per text');
});
