'use strict';
// 写作业: picked in the menu, the student sits down to the game's homework and gets the day's
// sheet; handed in, it is marked, a sentence of their own judged by the model, and the mistake
// book follows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ielts } = require('../lib/ielts');
const { Homework } = require('../lib/homework');

test('写作业: the sheet of the day, sitting down to the notebook, marked with corrections', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homework-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const phone = path.join(root, 'ui', 'phone');
    const focusDir = path.join(root, 'ui', 'focus');
    fs.mkdirSync(path.join(phone, 'saved'), { recursive: true });
    fs.writeFileSync(path.join(phone, 'saved', 'ielts.cfg'), JSON.stringify({ enabled: true, level: 1 }));
    const calls = [];
    const replies = [];
    const d = {
        log: { info() {}, warn() {} },
        freshEnv: () => ({ day: 30, hour: 19, minute: 0 }),
        world: { possessed: async () => '43386' },
        school: { byId: { 43386: { id: '43386', stage: 'LowTeen', mode: 'weekly' } } },
        game: {
            soft: async (tool, args) => {
                calls.push([tool, args]);
                if (tool === 'entity_reflect' && args.Component) return { careerSlots: { school: { careerEntityId: { value: 887 } } } };
                if (tool === 'entity_reflect') return { a: { studentHomeworkMap: { '(Value=43386)': { homeworkObjectId: { value: 119500 } } } } };
                if (tool === 'interaction_get_current') return d.studyingNow ? { playing: true, interaction_bag_id: 'Bookshelf_SitRead_StudyMath_Perspective' } : { playing: false };
                if (tool === 'entity_scan_objects') return { objects: [{ entity_id: 11, name: '画架' }, { entity_id: 12, name: '书柜' }] };
                if (tool === 'interaction_list_available') return args.target_entity_id === '12' ? { interactions: [{ interaction_bag_id: 'Bookshelf_SitRead_Comic' }, { interaction_bag_id: 'Bookshelf_SitRead_StudyMath_Perspective' }] } : { interactions: [] };
                return {};
            }
        },
        llm: { json: async () => replies.shift() }
    };
    d.ielts = new Ielts(d);
    d.ielts.configure(phone, focusDir, path.join(root, 'data'));
    const rec = d.ielts.load('43386');
    rec.lessons.push({ id: '30:09:00', day: 30, level: 1, topic: '食物和饮食', unit: 3, points: [{ n: 1, en: 'delicious', zh: '美味的', kind: 'word', example: 'The soup is delicious.' }] });
    d.ielts.save('43386', rec);
    const hw = new Homework(d);
    hw.configure(focusDir);
    const dir = path.join(focusDir, 'homework');
    fs.mkdirSync(dir, { recursive: true });

    // 写作业 picked: the student sits down to their notebook, and the sheet is written.
    replies.push({ title: '好吃的', questions: [
        { type: 'choice', point: 'delicious', prompt: '选出正确的词', options: ['delicious', 'dangerous', 'difficult'], answer: 'delicious', explain: 'delicious 是美味的' },
        { type: 'fill', point: 'delicious', prompt: 'The cake is ____.（美味的）', answer: 'delicious', explain: '形容食物好吃' },
        { type: 'make', point: 'delicious', prompt: '用 delicious 造句', answer: 'This apple is delicious.', explain: '' }
    ] });
    fs.writeFileSync(path.join(dir, 'ask.cfg'), JSON.stringify({ seq: Date.now() * 10, player: '43386', at: Date.now() }));
    await hw.tick();
    assert.ok(calls.some(([tool, a]) => tool === 'interaction_execute' && a.interaction_bag_id === 'Homework_Do' && a.target_entity_id === '119500'));
    const sheet = () => JSON.parse(fs.readFileSync(path.join(dir, '43386.cfg'), 'utf8'));
    assert.equal(sheet().state, 'ready');
    assert.equal(sheet().from, 'today');
    assert.equal(sheet().questions.length, 3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(focusDir, 'request.cfg'), 'utf8')).op, 'homework');

    // Handed in: the choice right, the blank wrong, the sentence judged (and corrected) by the model.
    replies.push({ results: [{ n: 3, correct: false, why: '少了 be 动词', fixed: 'The food is delicious.' }] });
    fs.writeFileSync(path.join(dir, 'answer.cfg'), JSON.stringify({ id: sheet().id, student: '43386', answers: { 1: 'A', 2: 'delicous', 3: 'The food delicious.' }, at: Date.now() }));
    await hw.tick();
    const s = sheet();
    assert.equal(s.state, 'marked');
    assert.equal(s.score, 1);
    assert.deepEqual(s.results.map((r) => r.correct), [true, false, false]);
    assert.equal(s.results[2].fixed, 'The food is delicious.');
    // The mistake book has it once, the last wrong answer.
    const book = d.ielts.load('43386').mistakes.filter((m) => m.en === 'delicious');
    assert.equal(book.length, 1);
    assert.equal(book[0].given, 'The food delicious.');

    // 复习功课 opened: the student studies a textbook at the bookcase; closed, they put it away.
    const ask = (op) => fs.writeFileSync(path.join(focusDir, 'book', 'ask.cfg'), JSON.stringify({ seq: Date.now() * 10 + (op === 'open' ? 1 : 2), op, player: '43386', at: Date.now() }));
    fs.mkdirSync(path.join(focusDir, 'book'), { recursive: true });
    ask('open');
    await hw.tick();
    assert.ok(calls.some(([tool, a]) => tool === 'interaction_execute' && a.interaction_bag_id === 'Bookshelf_SitRead_StudyMath_Perspective' && a.target_entity_id === '12'));
    d.studyingNow = true;
    ask('close');
    await hw.tick();
    assert.ok(calls.some(([tool]) => tool === 'interaction_cancel'));
});
