'use strict';
// Voice messages start being spoken when the reply is written and each one follows its own text,
// in order, however the clips and the texts interleave; a reply that never went out posts none.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tts = require('../lib/tts');
const { VoiceNotes } = require('../lib/voicenotes');

const tick = () => new Promise((r) => setTimeout(r, 5));

test('voices: spoken ahead, each posted after its own text, in order', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voicenotes-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const saved = { available: tts.available, ensureVoice: tts.ensureVoice, speak: tts.speak };
    t.after(() => Object.assign(tts, saved));
    const spoken = [];
    tts.available = async () => true;
    tts.ensureVoice = async () => ({ ok: true, created: false });
    tts.speak = async ({ text }) => { spoken.push(text); return { ok: true, buffer: Buffer.from('x'), seconds: 1, text }; };
    const posted = [];
    const mailbox = { append: (key, text, reAt, kind, at, extra) => posted.push(text + '|' + kind + '|' + (extra && extra.voice && extra.voice.of)) };
    const notes = new VoiceNotes({ log: { info() {}, warn() {} } });
    notes.configure(mailbox, root);
    const pair = { key: 'p', partner: { entity_id: 7 } };

    const voice = notes.begin({ key: 'p', pair, tag: 'hh', bubbles: ['刚到家', '[偷笑]', '饿死了！'], spoken: ['哎呀，刚到家……', '', ''], reAt: null, env: async () => null });
    await tick();
    assert.deepEqual(spoken, ['哎呀，刚到家…饿死了！'], 'the whole reply in one voice, spoken before any text went out, as the reply says it');
    voice.delivered(0, 'h-1-1');
    voice.delivered(1, 'h-2-1');
    await tick();
    assert.equal(posted.length, 0, 'not before the last text');
    voice.delivered(2, 'h-3-1');
    await tick();
    assert.deepEqual(posted, ['哎呀，刚到家…饿死了！|voice|h-3-1'], 'posted after the last text, drawn in its bubble');
    assert.equal(fs.readdirSync(path.join(root, 'media')).length, 1);

    const dropped = notes.begin({ key: 'p', pair, tag: 'hh', bubbles: ['算了'], reAt: null, env: async () => null });
    dropped.cancel();
    dropped.delivered(0);
    await tick();
    assert.equal(posted.length, 1, 'a cancelled reply posts no voice');
});
