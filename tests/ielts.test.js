'use strict';
// 雅思学习: a lesson in the 智能对话 box during the English period, the mistake book, and the exam
// paper whose mark becomes the game's exam preparation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ielts, sameAnswer } = require('../lib/ielts');
const { FocusTalks } = require('../lib/focus');

function setup(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ielts-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const phone = path.join(root, 'ui', 'phone');
    const focusDir = path.join(root, 'ui', 'focus');
    fs.mkdirSync(path.join(phone, 'saved'), { recursive: true });
    fs.writeFileSync(path.join(phone, 'saved', 'ielts.cfg'), JSON.stringify({ enabled: true, level: 1 }));
    const env = { day: 30, day_of_week: 'Tuesday', hour: 9, minute: 10 };
    const world = { teaching: true };
    const calls = [];
    const asked = [];
    const replies = [];
    const d = {
        log: { info() {}, warn() {}, debug() {} },
        freshEnv: () => env,
        world: { possessed: async () => '20524', scanAroundPossessed: async () => new Map([['30001', 3]]) },
        school: { byId: { 20524: {
            id: '20524', name: '钟亚廷', firstName: '亚廷', stage: 'HighTeen', mode: 'weekly', examDay: 'Friday',
            teacher: { id: '30001', name: '金老师', real: true },
            slots: [{ start: '09:00', end: '11:00', phase: 'Class', activity: 'School_Subject_Social', room: 'School_Classroom_0' },
                { start: '11:00', end: '12:00', phase: 'LunchBreak', activity: 'School_LunchTime', room: 'School_Cafeteria' },
                { start: '14:00', end: '16:00', phase: 'Class', activity: 'School_Subject_Science', room: 'School_ScienceLab' }],
            timetable: { periods: [{ kind: 'lesson', start: '09:00', end: '09:50' }, { kind: 'lesson', start: '10:00', end: '10:50' }],
                days: [{ day: 'Tuesday', exam: false, cells: ['英语', '数学'] }, { day: 'Friday', exam: true, cells: ['考试', '考试'] }] }
        } } },
        focusTalks: new FocusTalks({ dir: path.join(focusDir, 'talk') }),
        game: {
            soft: async (tool, args) => {
                calls.push([tool, args]);
                if (tool === 'interaction_get_current') return args.entity_id === '30001' ? { playing: world.teaching, interaction_bag_id: 'School_Stand_Lectern' } : { playing: true, interaction_bag_id: 'Stand' };
                return {};
            },
            call: async (tool, args) => { calls.push([tool, args]); return {}; }
        },
        gestureCache: new Map(),
        llm: { json: async (system, ask, o) => { asked.push(o.purpose); return replies.shift(); } }
    };
    const ie = new Ielts(d);
    ie.configure(phone, focusDir, path.join(root, 'data'));
    return { ie, d, env, world, calls, asked, replies, phone, focusDir };
}

const PLAN = {
    topic: '城市和交通',
    points: [
        { en: 'crowded', zh: '拥挤的', note: '形容地方人多', example: 'The bus is crowded. / 公交车很挤。', kind: 'word', check: { type: 'fill', question: '“拥挤的”英文是？', answer: 'crowded' } },
        { en: 'comparatives', zh: '比较级', note: '两者比较用 -er / more', example: 'Seoul is bigger than Busan.', kind: 'grammar', check: { type: 'make', question: '用比较级造句', answer: 'The city is bigger than the town.' } }
    ]
};

test('an answer counts whatever its case, spaces and end punctuation; | gives other right answers', () => {
    assert.ok(sameAnswer(' Crowded. ', 'crowded'));
    assert.ok(sameAnswer('busy', 'crowded|busy'));
    assert.ok(!sameAnswer('', 'crowded'));
    assert.ok(!sameAnswer('crowd', 'crowded'));
});

test('the teacher at the board is a lesson they open in the box, and a wrong answer goes to the mistake book', async (t) => {
    const s = setup(t);
    const BOOK = { goal: '能说出城市里的拥挤', warmup: 'Is your city crowded? / 你的城市挤吗？', homework: '用 crowded 写两句话',
        pages: [{ n: 1, pos: 'adj.', syll: 'CROWD·ed', colls: [{ en: 'a crowded street', zh: '拥挤的街道' }], tip: 'crowd 人群 + ed', wrong: 'The bus is crowd.', right: 'The bus is crowded.' }] };
    s.replies.push(PLAN, BOOK, { text: '今天我们讲城市生活。先看 crowded，意思是拥挤的。“拥挤的”英文怎么说？', point: 1, ask: { point: 1 }, face: 'Joyful' });
    await s.ie.tick();
    const key = '20524-30001';
    assert.ok(s.ie.owns(key), 'the lesson owns the talk with the teacher');
    const req = JSON.parse(fs.readFileSync(path.join(s.focusDir, 'request.cfg'), 'utf8'));
    assert.equal(req.op, 'open');
    assert.equal(req.target, '30001');
    assert.match(s.d.focusTalks.talk(key).heard[0].text, /crowded/);
    // The board: the term's units on the left, the question on its card.
    const board = () => JSON.parse(fs.readFileSync(s.d.focusTalks.file(key, 'lesson'), 'utf8'));
    assert.equal(board().units.length, 10);
    assert.equal(board().units[0].state, 'now');
    assert.equal(board().question.type, 'fill');
    // The textbook on the right: open at the point being taught, its page printed by the model.
    await s.ie.booking;
    assert.equal(board().page, 1);
    assert.equal(board().cover.homework, '用 crowded 写两句话');
    assert.equal(board().points[0].more.colls[0].en, 'a crowded street');
    assert.equal(board().points[1].more, null, 'a page the model left out shows what the plan has');
    // The student answers wrong: marked here, the teacher corrects.
    const sayFile = s.d.focusTalks.file(key, 'said');
    fs.writeFileSync(sayFile, JSON.stringify([{ id: 's1', text: 'crowd', at: Date.now() + 5 }]));
    s.replies.push({ text: '差一点，是 crowded，要加 -ed。', taught: [1], face: 'Calm' });
    await s.ie.answer(key);
    assert.equal(board().question, null);
    assert.equal(board().points[0].result, 'wrong');
    const notes = JSON.parse(fs.readFileSync(path.join(s.phone, 'school', 'ielts.cfg'), 'utf8')).byId['20524'];
    assert.equal(notes.lessons[0].topic, '家庭和朋友', 'unit 1 of the term');
    assert.equal(notes.mistakes[0].en, 'crowded');
    assert.equal(notes.mistakes[0].given, 'crowd');
    // The review book (复习功课): the lesson with its printed pages and marks, and the unit next.
    const review = JSON.parse(fs.readFileSync(path.join(s.focusDir, 'book', '20524.cfg'), 'utf8'));
    assert.equal(review.lessons[0].points[0].more.pos, 'adj.');
    assert.equal(review.lessons[0].points[0].result, 'wrong');
    assert.equal(review.next.n, 1);
    // The teacher stops teaching for a while: still the period, the lesson goes on.
    s.world.teaching = false;
    for (let i = 0; i < 4; i++) await s.ie.tick();
    assert.ok(s.ie.owns(key), 'only the end of the period is the bell');
    // The bell: the period ends; a last word, and the box closes.
    s.env.hour = 11;
    s.env.minute = 0;
    await s.ie.tick();
    assert.ok(!s.ie.owns(key));
    assert.match(s.d.focusTalks.talk(key).heard.slice(-1)[0].text, /下课/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.focusDir, 'request.cfg'), 'utf8')).op, 'close');
    assert.deepEqual(s.asked, ['ielts_plan', 'ielts_book', 'ielts_teach', 'ielts_teach']);
    // Lunch, then the science lab: no lesson outside a classroom.
    s.world.teaching = true;
    s.env.hour = 14;
    s.env.minute = 20;
    await s.ie.tick();
    assert.equal(s.asked.length, 4, 'no lesson in the lab');
});

test('no lesson when the mode is off, the class has not begun, or the teacher is not in the room', async (t) => {
    const off = setup(t);
    fs.writeFileSync(path.join(off.phone, 'saved', 'ielts.cfg'), JSON.stringify({ enabled: false }));
    await off.ie.tick();
    assert.equal(off.asked.length, 0);
    const idle = setup(t);
    idle.world.teaching = false;
    await idle.ie.tick();
    assert.equal(idle.asked.length, 0);
    const away = setup(t);
    away.d.world.scanAroundPossessed = async () => new Map();
    await away.ie.tick();
    assert.equal(away.asked.length, 0);
});

test('exam day: a paper of the mistakes and the week, marked, and the mark is the game\'s exam preparation', async (t) => {
    const s = setup(t);
    s.replies.push(PLAN, { text: '开始上课。', point: 1 });
    await s.ie.tick();
    await s.ie.endLesson('test', false);
    const rec = s.ie.load('20524');
    rec.mistakes.push({ en: 'crowded', zh: '拥挤的', question: '“拥挤的”英文是？', answer: 'crowded', type: 'fill', day: 30 });
    s.ie.save('20524', rec);
    s.env.day = 33;
    s.env.day_of_week = 'Friday';
    await s.ie.tick();
    const paper = JSON.parse(fs.readFileSync(path.join(s.phone, 'school', 'ielts-exam.cfg'), 'utf8')).exam;
    assert.equal(paper.questions[0].en, 'crowded', 'the mistakes first');
    assert.equal(paper.questions.length, 2);
    fs.writeFileSync(path.join(s.phone, 'school', 'ielts-answer.cfg'), JSON.stringify({ id: paper.id, answers: { 1: 'Crowded', 2: 'Seoul big' }, at: Date.now() }));
    s.replies.push({ results: [{ n: 2, correct: false, why: '要用比较级 bigger than' }] });
    await s.ie.tick();
    const marked = JSON.parse(fs.readFileSync(path.join(s.phone, 'school', 'ielts-exam.cfg'), 'utf8')).exam;
    assert.equal(marked.score, 1);
    assert.equal(marked.prep, 50);
    assert.deepEqual(s.calls.find((c) => c[0] === 'career_set_exam_preparation'), ['career_set_exam_preparation', { entity_id: '20524', Value: 50 }]);
    const notes = JSON.parse(fs.readFileSync(path.join(s.phone, 'school', 'ielts.cfg'), 'utf8')).byId['20524'];
    assert.equal(notes.exams[0].score, 1);
    assert.ok(!notes.mistakes.some((m) => m.en === 'crowded'), 'right this time: out of the mistake book');
    assert.ok(notes.mistakes.some((m) => m.en === 'comparatives'));
});
