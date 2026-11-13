'use strict';
// 雅思学习模式: with it on (phone Settings), a middle or high schooler's classes are IELTS lessons taught face
// to face by their real class teacher in the 智能对话 box (focus.js), and the week's
// exam is a real paper on the phone, made of what those lessons taught; its score is the game's
// exam preparation (career.set_exam_preparation), from which the game marks the exam itself.
//
// Files:
//   <phone>/saved/ielts.cfg      {enabled, level}                       written by the phone only
//   <phone>/school/ielts.cfg     {v, byId: {<student>: notes}}          written here only
//   <phone>/school/ielts-exam.cfg  {v, exam}  the paper to answer       written here only
//   <phone>/school/ielts-answer.cfg {id, answers, at}                   written by the phone only
//   <focus>/request.cfg          {seq, op: open | close, player, target, title}  written here only;
//                                the focus app opens the talk with the teacher by itself on it
//   <data>/ielts/<student>.json  everything a student learnt, answered and got wrong, and the term
//   <focus>/talk/<key>/lesson.cfg  the lesson board the box shows: the term's units (the textbook's
//                                contents), this lesson's points, and the question put to the
//                                student now {id, n, type, prompt, options}   written here only;
//                                and the textbook the box opens on the right: page (0 the unit's
//                                opening page, a point's number, or 'sum'), cover {goal, warmup,
//                                homework} and each point's page (note, example, more)
//   <focus>/book/<student>.cfg   the textbook to go through again (复习功课, picked on oneself in
//                                the game's menu): the lessons had, page by page, and the unit
//                                that comes next                                written here only
//
// The term: one unit per topic of the level, each with a grammar point, taught in order; a unit
// is done when a lesson has got through all its points (or after two lessons on it).
// The textbook: each point is a page of it. The page's frame is drawn by the box; what is printed
// on it beyond the lesson plan (word class, syllables, collocations, a memory tip, the usual
// mistake; for grammar the pattern and its three sentence forms) is written by the model in one
// go as the lesson starts (book), and the page shows what the plan has until then.
// Questions: the teacher puts each point's check to the student, and some short spoken
// questions on the topic; the box shows them on a card (choices as buttons). Choice and fill-in
// answers are marked here; the rest the teacher judges.
//
// A lesson is a period of the game's own timetable for the student's class (school.js rep.slots):
// only one held in a classroom (School_Classroom_N), not the lab, gym, art or craft room, nor an
// exam. It starts once the class has begun (the student sitting in it or the teacher at the board,
// the teacher in the room) and lasts until the period ends; one lesson per period.
// A lesson is a talk with the teacher (key <student>-<teacher>) for the length of the class. The
// teacher speaks first and leads: one point at a time, asks, checks the answer, corrects. While a
// lesson owns that talk, daemon.tickTalks hands the student's lines here instead of talkReply.
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');
const focusBody = require('./focus-body');

const V = 1;
// What each level teaches: the band it aims at, the topics, the grammar, the kinds of question.
const LEVELS = {
    1: {
        name: 'Level 1 基础', band: '约 4.0', cefr: 'A2',
        topics: ['家庭和朋友', '学校生活', '食物和饮食', '爱好和运动', '天气和季节', '城市和交通', '购物', '日常作息', '假期和旅行', '健康'],
        grammar: ['一般现在时', '现在进行时', '一般过去时', 'can / must / should', '比较级和最高级', 'there is / there are', '可数和不可数名词', '频率副词', '介词 in / on / at（时间和地点）', 'be going to'],
        tasks: '单词的中英互译、选词填空、用单词造一个简单句、改一句话里的语法错'
    },
    2: {
        name: 'Level 2 进阶', band: '约 5.0', cefr: 'B1',
        topics: ['教育', '工作和职业', '科技和网络', '环境', '媒体', '人际关系', '健康和医疗', '住房', '文化和节日', '交通问题'],
        grammar: ['现在完成时', '将来时的几种说法', '第一类条件句', '被动语态', '情态动词表推测', '定语从句（who / which / that）', '动名词和不定式', '连接词 although / because / so'],
        tasks: '同义替换、雅思口语 Part 1 式的问答、听写式填空、判断句子对错（True / False）'
    },
    3: {
        name: 'Level 3 中级', band: '约 6.0', cefr: 'B2',
        topics: ['城市化', '全球化', '教育公平', '气候变化', '科技与隐私', '工作与生活平衡', '老龄化', '旅游业', '艺术资助', '犯罪与惩罚'],
        grammar: ['第二、三类条件句', '非限制性定语从句', '分词作状语', '强调句', '让步和转折的连接', '描述数据和趋势的表达'],
        tasks: '同义改写、口语 Part 2 的展开、小作文描述图表的句子、阅读的 True / False / Not Given'
    },
    4: {
        name: 'Level 4 高阶', band: '约 7.0', cefr: 'C1',
        topics: ['政策与社会', '学术研究', '伦理问题', '经济发展', '公共健康', '文化保护', '城市规划', '媒体责任'],
        grammar: ['倒装', '名词化', '虚拟语气', '复杂的比较结构', '衔接与指代', '学术搭配'],
        tasks: '大作文论点句和让步句、学术词汇搭配、口语 Part 3 的深入回答、改写复杂句'
    }
};
const DEFAULT_LEVEL = 1;
// A lesson: this many points (words and one grammar point), each taught then checked.
const POINTS = 4;
// After the teacher only explained (no question), they go on by themselves once the line has had
// time to be typed out in the box and read: a moment plus this much per character, at most the cap.
// With a question on the card they wait much longer for the answer. Typing in the box counts as not quiet.
const READ_MS = 4000;
const READ_PER_CHAR_MS = 110;
const READ_MAX_MS = 30000;
const ANSWER_WAIT_MS = 240000;
// How long the box gets to open by itself before the player is told to open it from the menu.
const OPEN_WAIT_MS = 12000;
// The box stays open this long after the teacher's last words, then closes.
const CLOSE_AFTER_MS = 8000;
const LESSONS_KEPT = 120;
const NOTES_SHOWN = 40;
// The lessons the review book holds.
const REVIEW_LESSONS = 30;
const MISTAKES_KEPT = 60;
// An exam paper: this many questions, the mistakes first.
const PAPER_SIZE = 10;
// Middle and high schoolers of an on-lot school (the level chosen in Settings sets the difficulty).
const STAGES = { LowTeen: true, HighTeen: true };
// What a class looks like in the game (InteractionBag ids): the student sitting in it, or the
// teacher giving it at the board or the lectern; and how many looks in a row without either end it.
const LISTENING_RE = /ListenClass/;
const TEACHING_RE = /^School_\w*(Teach|Lectern|ChalkBoard)\w*$/;
const CLASSROOM_RE = /^School_Classroom/;
// No new lesson this close to the end of a period (game minutes).
const LATE_MIN = 15;
// The student has left the classroom: the teacher out of reach this many looks in a row (~3 min).
const AWAY_LOOKS = 36;

function minutesOf(t) {
    const p = String(t || '').split(':');
    const h = Number(p[0]);
    const m = Number(p[1]);
    return p.length === 2 && p[0] !== '' && p[1].length === 2 && h >= 0 && m >= 0 ? h * 60 + m : null;
}

// The classroom period of the game's timetable going on now, or null: { start, end, endMin, activity }.
function lecture(rep, env) {
    const now = env.hour * 60 + (env.minute || 0);
    for (const sl of Array.isArray(rep.slots) ? rep.slots : []) {
        const a = minutesOf(sl.start);
        const b = minutesOf(sl.end);
        if (a === null || b === null || now < a || now >= b) continue;
        if (sl.phase !== 'Class' || !CLASSROOM_RE.test(sl.room) || /Exam/i.test(sl.activity)) return null;
        return { start: sl.start, end: sl.end, endMin: b, activity: sl.activity };
    }
    return null;
}

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function clip(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }

// One answer against the expected one, for the questions that have a single right answer:
// case, spaces and end punctuation do not count.
function sameAnswer(given, expected) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s.,!?;:'"，。！？；：、]/g, '');
    const g = norm(given);
    if (!g) return false;
    return String(expected || '').split('|').some((e) => norm(e) === g);
}

// A choice answered by its letter (A, b, C.) or by the option itself.
function choiceAnswer(given, options) {
    const m = /^\s*([A-Da-d])\s*[.、。)）]?\s*$/.exec(String(given || ''));
    if (m && options[m[1].toUpperCase().charCodeAt(0) - 65]) return options[m[1].toUpperCase().charCodeAt(0) - 65];
    return String(given || '').replace(/^\s*[A-Da-d]\s*[.、。)）]\s*/, '');
}

// A point's check question as planned: a choice keeps its options only if the answer is one of them.
function cleanCheck(c) {
    const out = { type: ['choice', 'fill', 'translate', 'make'].indexOf(c.type) >= 0 ? c.type : 'fill', question: clip(c.question, 140), answer: clip(c.answer, 120) };
    if (out.type === 'choice') {
        const options = (Array.isArray(c.options) ? c.options : []).map((o) => clip(String(o).replace(/^\s*[A-Da-d]\s*[.、)）]\s*/, ''), 60)).filter(Boolean).slice(0, 4);
        if (options.length >= 2 && options.some((o) => sameAnswer(o, out.answer))) out.options = options;
        else out.type = 'fill';
    }
    return out;
}

// The term's units for a level: its topics in order, each with one of its grammar points.
function termUnits(levelNo) {
    const level = LEVELS[levelNo];
    return level.topics.map((topic, i) => ({ n: i + 1, topic, grammar: level.grammar[i % level.grammar.length], lessons: 0, done: false }));
}

class Ielts {
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.lesson = null;      // the lesson being taught now (see startLesson)
        this.busy = false;
        this.examBusy = false;
        this.seq = 0;
    }

    configure(phoneDir, focusDir, dataDir) {
        this.settingsFile = path.join(phoneDir, 'saved', 'ielts.cfg');
        this.notesFile = path.join(phoneDir, 'school', 'ielts.cfg');
        this.examFile = path.join(phoneDir, 'school', 'ielts-exam.cfg');
        this.answerFile = path.join(phoneDir, 'school', 'ielts-answer.cfg');
        this.requestFile = path.join(focusDir, 'request.cfg');
        this.aliveFile = path.join(focusDir, 'alive.cfg');
        this.bookDir = path.join(focusDir, 'book');
        this.bookOf = '';
        this.dir = path.join(dataDir, 'ielts');
    }

    settings() {
        const r = this.settingsFile ? fsx.readJson(this.settingsFile) : { ok: false };
        const v = r.ok && isObject(r.value) ? r.value : {};
        const level = LEVELS[Number(v.level)] ? Number(v.level) : DEFAULT_LEVEL;
        return { enabled: v.enabled === true, level };
    }

    file(id) { return path.join(this.dir, String(id) + '.json'); }

    load(id) {
        const r = fsx.readJson(this.file(id));
        const v = r.ok && isObject(r.value) ? r.value : {};
        return {
            v: V,
            lessons: Array.isArray(v.lessons) ? v.lessons : [],
            mistakes: Array.isArray(v.mistakes) ? v.mistakes : [],
            exams: Array.isArray(v.exams) ? v.exams : [],
            term: isObject(v.term) && Array.isArray(v.term.units) ? v.term : null
        };
    }

    // The term being studied at this level; a new one when the level changed or all units are done.
    termFor(rec, levelNo) {
        const t = rec.term;
        if (t && t.level === levelNo && t.units.some((u) => !u.done)) return t;
        rec.term = { level: levelNo, no: t && t.level === levelNo ? (t.no || 1) + 1 : 1, units: termUnits(levelNo) };
        return rec.term;
    }

    save(id, rec) {
        rec.lessons = rec.lessons.slice(-LESSONS_KEPT);
        rec.mistakes = rec.mistakes.slice(-MISTAKES_KEPT);
        rec.exams = rec.exams.slice(-20);
        try {
            fsx.ensureDir(this.dir);
            fsx.writeJson(this.file(id), rec, true);
        } catch (e) {
            this.log.warn('ielts: ' + id + ' not saved: ' + e.message);
        }
        this.publish(id, rec);
        this.publishBook(id, rec);
    }

    // What the phone's 成绩 app shows: the lessons' notes, newest first, and the mistake book.
    publish(id, rec) {
        if (!this.notesFile) return;
        const r = fsx.readJson(this.notesFile);
        const all = r.ok && isObject(r.value) && isObject(r.value.byId) ? r.value.byId : {};
        all[String(id)] = {
            lessons: rec.lessons.slice(-NOTES_SHOWN).reverse().map((l) => ({
                id: l.id, day: l.day, level: l.level, topic: l.topic, teacher: l.teacherName, done: !!l.done,
                points: (l.points || []).map((p) => ({ en: p.en, zh: p.zh, note: p.note || '', example: p.example || '', kind: p.kind || 'word' })),
                checks: (l.checks || []).map((c) => ({ q: c.question, a: c.answer, ok: c.correct }))
            })),
            mistakes: rec.mistakes.slice(-MISTAKES_KEPT).reverse().map((m) => ({ en: m.en, zh: m.zh, q: m.question, a: m.answer, given: m.given || '', day: m.day })),
            exams: rec.exams.slice(-10).reverse().map((x) => ({ day: x.day, score: x.score, of: x.of, prep: x.prep })),
            term: rec.term ? { level: rec.term.level, no: rec.term.no || 1, units: rec.term.units.map((u) => ({ n: u.n, topic: u.topic, grammar: u.grammar, done: !!u.done })) } : null
        };
        try {
            fsx.ensureDir(path.dirname(this.notesFile));
            fsx.writeJson(this.notesFile, { v: V, at: Date.now(), byId: all });
        } catch (e) {
            this.log.warn('ielts: notes not written: ' + e.message);
        }
    }

    // The review book of a student: every lesson had with its pages as the textbook printed them
    // and how each point's question went, and the unit that comes next.
    publishBook(id, rec) {
        if (!this.bookDir) return;
        const term = rec.term;
        const next = term ? term.units.find((u) => !u.done) : null;
        const lessons = rec.lessons.filter((l) => Array.isArray(l.points) && l.points.length).slice(-REVIEW_LESSONS).map((l) => {
            const level = LEVELS[l.level] || LEVELS[DEFAULT_LEVEL];
            const last = {};
            for (const c of l.checks || []) last[c.n] = c.correct ? 'right' : 'wrong';
            const checks = l.checks || [];
            return {
                id: l.id, day: l.day, level: level.name, title: l.title || '', cover: l.cover || null, done: !!l.done,
                unit: { n: l.unit || 1, topic: l.topic || '', grammar: level.grammar[((l.unit || 1) - 1) % level.grammar.length] },
                right: checks.filter((c) => c.correct).length, checked: checks.length,
                points: l.points.map((p) => ({ n: p.n, en: p.en, zh: p.zh, kind: p.kind || 'word', note: p.note || '', example: p.example || '', more: p.more || null, result: last[p.n] || '', state: 'done' }))
            };
        });
        try {
            fsx.ensureDir(this.bookDir);
            fsx.writeJson(path.join(this.bookDir, String(id) + '.cfg'), {
                v: V, at: Date.now(), level: term ? LEVELS[term.level].name : '', term: term ? term.no || 1 : 1,
                units: term ? term.units.map((u) => ({ n: u.n, topic: u.topic, grammar: u.grammar, state: u.done ? 'done' : (next && u.n === next.n ? 'now' : 'next') })) : [],
                next: next ? { n: next.n, topic: next.topic, grammar: next.grammar, started: (next.lessons || 0) > 0 } : null,
                lessons
            });
        } catch (e) {
            this.log.warn('ielts: review book not written: ' + e.message);
        }
    }

    request(op, player, target, title) {
        if (!this.requestFile) return;
        try {
            fsx.ensureDir(path.dirname(this.requestFile));
            fsx.writeJson(this.requestFile, { seq: Date.now() * 10 + (++this.seq % 10), op, player: String(player), target: String(target), title: title || '' });
        } catch (e) {
            this.log.warn('ielts: focus request not written: ' + e.message);
        }
    }

    // Whether the focus app is running (it stamps ui/focus/alive every 30 s): only then does a
    // request open the box by itself.
    boxAlive() {
        const r = this.aliveFile ? fsx.readJson(this.aliveFile) : { ok: false };
        return !!(r.ok && r.value && typeof r.value.at === 'number' && Date.now() - r.value.at < 75000);
    }

    // The talk key a lesson is taught in, while one is.
    owns(key) {
        return !!(this.lesson && this.lesson.key === key && !this.lesson.closed);
    }

    // ---------------------------------------------------------------- every few seconds
    async tick() {
        if (this.busy) return;
        this.busy = true;
        try {
            await this.step();
        } catch (e) {
            this.log.warn('ielts: ' + (e && e.message || e));
        } finally {
            this.busy = false;
        }
    }

    async step() {
        const set = this.settings();
        const env = this.d.freshEnv ? this.d.freshEnv() : null;
        const lesson = this.lesson;
        if (lesson && !lesson.closed) {
            if (!set.enabled) return this.endLesson('ielts mode turned off', false);
            // The bell: the period of the timetable is over.
            const now = env && typeof env.hour === 'number' ? env.hour * 60 + (env.minute || 0) : null;
            if (now !== null && lesson.endMin !== null && (now >= lesson.endMin || now < lesson.startMin)) return this.endLesson('the period is over', true);
            // The student left the classroom for good.
            const near = await this.d.world.scanAroundPossessed().catch(() => null);
            const dist = near && near.get ? near.get(lesson.teacher) : undefined;
            if (typeof dist === 'number' && dist <= 40) lesson.awayLooks = 0;
            else if (near && ++lesson.awayLooks >= AWAY_LOOKS) return this.endLesson('the student left the classroom', false);
            if (lesson.done && Date.now() - lesson.doneAt > CLOSE_AFTER_MS) return this.endLesson('taught', false);
            const talk = this.d.focusTalks && this.d.focusTalks.talk(lesson.key);
            // The box did not open by itself (the focus app loads only after its first menu pick in
            // a game session): the player is told how to come to the lesson.
            if (talk && !talk.open && !lesson.toldHow && (Date.now() - lesson.startedAt > OPEN_WAIT_MS || !this.boxAlive())) {
                lesson.toldHow = true;
                this.d.game.soft('toast_show', { Message: '上课了：点' + lesson.teacherName + '，选「智能对话」听雅思课', Lifetime: 10 }).catch(() => {});
            }
            // The teacher goes on: after an explanation, once it is read; after a question, when
            // the student has not answered for long (they still hear the lesson).
            const typed = this.d.focusTalks ? this.d.focusTalks.readObject(lesson.key, 'typing') : null;
            const quietSince = Math.max(lesson.lastAt, typed && typeof typed.at === 'number' ? typed.at : 0);
            if (talk && !talk.pending.length && !lesson.thinking && !lesson.done && Date.now() - quietSince > (lesson.question ? ANSWER_WAIT_MS : lesson.readMs || READ_MS)) {
                await this.teach(lesson, [], lesson.question ? 'silent' : 'continue');
            }
            return;
        }
        if (!set.enabled || !env || typeof env.hour !== 'number') return;
        await this.exams(set, env);
        const id = String(await this.d.world.possessed().catch(() => '') || '');
        if (!id) return;
        // The played character's review book is there from the start, not only after a lesson.
        if (this.bookOf !== id) {
            this.bookOf = id;
            this.publishBook(id, this.load(id));
        }
        const rep = this.d.school && this.d.school.byId ? this.d.school.byId[id] : null;
        if (!rep || !STAGES[rep.stage] || rep.mode !== 'weekly' || !rep.teacher || !rep.teacher.real || !rep.teacher.id) return;
        // A classroom period of the game's timetable, one lesson in it, begun once the class has.
        const period = lecture(rep, env);
        const lessonId = period ? env.day + ':' + period.start : '';
        const rec = this.load(id);
        // One left open by a restart whose period is over by now: it ends, so the box lets go of it.
        const left = rec.lessons.find((l) => l.id !== lessonId && !l.closed && !l.done && Number(l.day) >= env.day - 1);
        if (left) {
            await this.resume(id, rep, period || { start: left.start || '00:00', endMin: 0 }, left, env, true);
            return this.endLesson('its period ended while the service was away', false);
        }
        if (!period) return;
        const had = rec.lessons.find((l) => l.id === lessonId);
        // Begun and not ended (the service restarted during it): it goes on.
        if (had && !had.closed && !had.done) return this.resume(id, rep, period, had, env);
        if (had || env.hour * 60 + (env.minute || 0) > period.endMin - LATE_MIN) return;
        const near = await this.d.world.scanAroundPossessed().catch(() => null);
        const d = near && near.get ? near.get(rep.teacher.id) : undefined;
        if (!(typeof d === 'number' && d <= 25)) return;
        if (!(await this.inClass(id, rep.teacher.id))) return;
        await this.startLesson(id, rep, period, lessonId, set, env, rec);
    }

    // Whether a class is going on: the student sitting in it, or the teacher giving it.
    async inClass(studentId, teacherId) {
        const bag = async (id) => {
            const cur = await this.d.game.soft('interaction_get_current', { entity_id: String(id) });
            return cur && cur.playing ? String(cur.interaction_bag_id || '') : '';
        };
        if (LISTENING_RE.test(await bag(studentId))) return true;
        return TEACHING_RE.test(await bag(teacherId));
    }

    // ---------------------------------------------------------------- a lesson
    async startLesson(id, rep, period, lessonId, set, env, rec) {
        const level = LEVELS[set.level];
        const term = this.termFor(rec, set.level);
        const unit = term.units.find((u) => !u.done);
        const plan = await this.plan(rec, set.level, rep, unit);
        if (!plan) return;
        const key = id + '-' + rep.teacher.id;
        const lesson = {
            id: lessonId, key, student: id, studentName: rep.firstName || rep.name, teacher: rep.teacher.id, teacherName: rep.teacher.name,
            day: env.day, start: period.start, startMin: minutesOf(period.start), endMin: period.endMin, awayLooks: 0, level: set.level, levelName: level.name,
            unit: { n: unit.n, topic: unit.topic, grammar: unit.grammar }, title: plan.title,
            topic: unit.topic, points: plan.points, checks: [], taught: [], lines: [], startedAt: Date.now(), lastAt: Date.now(),
            current: 0, question: null, asked: 0,
            thinking: false, done: false, doneAt: 0, closed: false
        };
        this.lesson = lesson;
        rec.lessons.push(this.record(lesson));
        this.save(id, rec);
        this.board(lesson);
        // The textbook's pages are printed while the teacher opens the lesson.
        this.booking = this.book(lesson, rep).catch((e) => this.log.warn('ielts: textbook not written: ' + (e && e.message || e)));
        this.log.info('ielts: lesson ' + lessonId + ' for ' + id + ' with ' + rep.teacher.name + ' (' + level.name + ', unit ' + unit.n + '): ' + unit.topic + ' — ' + plan.points.map((p) => p.en).join(', '));
        // The box opens by itself on the teacher; picking 智能对话 on them opens the same lesson.
        this.request('open', id, rep.teacher.id, '英语课 · ' + level.name);
        if (this.d.focusTalks) this.d.focusTalks.writeStatus(key, { state: 'online', error: '' });
        await this.teach(lesson, [], 'open');
    }

    record(l) {
        return {
            id: l.id, day: l.day, start: l.start, level: l.level, topic: l.topic, unit: l.unit ? l.unit.n : 0, teacherName: l.teacherName,
            title: l.title || '', cover: l.cover || null, points: l.points, checks: l.checks, done: l.done, closed: !!l.closed
        };
    }

    // The lesson board the focus box shows beside the talk (see the head of this file).
    board(lesson) {
        const f = this.d.focusTalks;
        if (!f) return;
        const rec = this.load(lesson.student);
        const term = rec.term || { no: 1, units: [] };
        const last = {};
        for (const c of lesson.checks) last[c.n] = c.correct ? 'right' : 'wrong';
        const q = lesson.question;
        try {
            fsx.ensureDir(path.dirname(f.file(lesson.key, 'lesson')));
            fsx.writeJson(f.file(lesson.key, 'lesson'), {
                v: V, at: Date.now(), closed: !!lesson.closed, done: !!lesson.done, id: lesson.id,
                level: lesson.levelName, term: term.no || 1, title: lesson.title || '',
                units: term.units.map((u) => ({ n: u.n, topic: u.topic, grammar: u.grammar, state: u.n === lesson.unit.n ? 'now' : (u.done ? 'done' : 'next') })),
                unit: lesson.unit,
                page: lesson.done ? 'sum' : (lesson.current || 0), cover: lesson.cover || null,
                points: lesson.points.map((p) => ({
                    n: p.n, en: p.en, zh: p.zh, kind: p.kind, note: p.note || '', example: p.example || '', more: p.more || null,
                    state: lesson.taught.indexOf(p.n) >= 0 ? 'done' : (lesson.current === p.n ? 'now' : 'next'), result: last[p.n] || ''
                })),
                right: lesson.checks.filter((c) => c.correct).length, checked: lesson.checks.length,
                question: q && !lesson.closed ? { id: q.id, n: q.n, type: q.type, prompt: q.prompt, hint: q.hint || '', options: q.options } : null
            });
        } catch (e) {
            this.log.warn('ielts: lesson board not written: ' + e.message);
        }
    }

    // The question put to the student now, from the teacher's ask: a point's check, or a short
    // spoken question on the topic.
    pose(lesson, ask) {
        if (!isObject(ask)) return null;
        const p = lesson.points.find((x) => x.n === Number(ask.point));
        if (p && p.check) {
            return { id: 'q' + (++lesson.asked), n: p.n, type: p.check.type, prompt: p.check.question, options: p.check.options || [], answer: p.check.answer };
        }
        if (ask.type === 'speak' && ask.prompt) {
            return { id: 'q' + (++lesson.asked), n: 0, type: 'speak', prompt: clip(ask.prompt, 140), hint: clip(ask.hint, 60), options: [] };
        }
        return null;
    }

    // What this lesson teaches: from the level's syllabus, not what the last lessons taught, with
    // one point from the mistake book to go over again.
    async plan(rec, levelNo, rep, unit) {
        const level = LEVELS[levelNo];
        const recent = rec.lessons.slice(-12);
        const seen = new Set();
        recent.forEach((l) => (l.points || []).forEach((p) => seen.add(String(p.en).toLowerCase())));
        const review = rec.mistakes.slice(-6).map((m) => m.en).filter(Boolean);
        const again = recent.filter((l) => l.unit === unit.n).map((l) => l.topic).length > 0;
        const system = '你是一位经验丰富的雅思老师，为中国' + (rep.stage === 'LowTeen' ? '初中' : '高中') + '生备课。只输出 JSON。';
        const ask = [
            '给一节 15 分钟的雅思课备课。学生程度：' + level.name + '（雅思 ' + level.band + '，CEFR ' + level.cefr + '）。题型：' + level.tasks + '。',
            '这节课是本学期教材的第 ' + unit.n + ' 单元：话题「' + unit.topic + '」，语法「' + unit.grammar + '」。' + (again ? '这个单元上节课没讲完，这次接着讲，换新的词。' : ''),
            seen.size ? '最近学过的词（不要再选）：' + Array.from(seen).slice(0, 60).join(', ') + '。' : '',
            review.length ? '学生做错过、要复习的：' + review.join(', ') + '。挑一个和这个单元搭得上的放进来复习。' : '',
            '要点：' + (POINTS - 1) + ' 个这个话题里雅思常考、这个级别该会的单词或短语，加 1 个语法点（就是「' + unit.grammar + '」）。全部是原创内容，不抄真题。',
            '每个要点给：en（英文）、zh（中文意思）、note（一句中文讲解：用法、搭配或易错处）、example（一个英文例句，配中文翻译，用“ / ”隔开）、',
            'kind（word 或 grammar）、check（一道检查题：问题 question 用中文提，answer 是标准答案，有几种都对就用 | 隔开；type 是 choice、fill、translate 或 make 之一，make 是造句，answer 写一个参考句）。',
            '检查题的题型要有变化，至少一道 choice：choice 给 options（3 到 4 个英文选项，不带 A/B 字母），answer 和其中一个选项一字不差。',
            '输出：{"title":"这节课的小标题（中文，10 字以内）","points":[{"en":"","zh":"","note":"","example":"","kind":"word","check":{"type":"choice","question":"","options":["","",""],"answer":""}}]}'
        ].filter(Boolean).join('\n');
        let r = null;
        try {
            r = await this.d.llm.json(system, ask, { purpose: 'ielts_plan', max_tokens: 1400, thinking: 'disabled' });
        } catch (e) {
            this.log.warn('ielts: lesson plan failed: ' + e.message);
            return null;
        }
        const points = (r && Array.isArray(r.points) ? r.points : []).filter((p) => p && p.en && p.zh).slice(0, POINTS + 1).map((p, i) => ({
            n: i + 1, en: clip(p.en, 60), zh: clip(p.zh, 40), note: clip(p.note, 120), example: clip(p.example, 160),
            kind: p.kind === 'grammar' ? 'grammar' : 'word',
            check: p.check && p.check.question ? cleanCheck(p.check) : null
        }));
        if (!points.length) return null;
        return { title: clip(r.title || r.topic, 20), points };
    }

    // What is printed on the textbook's pages beyond the plan: asked once, as the lesson starts.
    async book(lesson, rep) {
        const system = '你是一位雅思教材的编者，为中国' + (rep && rep.stage === 'LowTeen' ? '初中' : '高中') + '生编写课本页面的内容。只输出 JSON。';
        const ask = [
            '给一节雅思课（' + lesson.levelName + '）的课本页面填内容。第 ' + lesson.unit.n + ' 单元，话题「' + lesson.topic + '」，语法「' + lesson.unit.grammar + '」。',
            '这节课的要点：',
            lesson.points.map((p) => p.n + '. [' + p.kind + '] ' + p.en + ' = ' + p.zh + '；例句：' + p.example).join('\n'),
            '',
            '每个要点一页。单词或短语（word）的页给：pos（词性，如 n. / v. / adj. / phr.）、syll（按音节用 · 隔开，重读音节大写，如 im·POR·tant；短语不用写）、',
            'colls（2 到 3 个雅思里常见的搭配，每个 {"en":"","zh":""}）、family（词族，一行，如 decide v. → decision n. → decisive adj.；没有就空）、',
            'tip（一句中文的记忆小窍门：拆词、联想或谐音）、wrong 和 right（中国学生用这个词最常犯的一个错：一句错的英文和改对的英文）。',
            '语法（grammar）的页给：formula（结构公式，一行，如 主语 + have/has + 过去分词）、forms（肯定、否定、疑问三句同一内容的英文例句，每个 {"label":"肯定","en":"","zh":""}）、',
            'signals（常一起出现的标志词，一行英文，用逗号隔开）、tip（一句中文口诀）、wrong 和 right（最常见的一个错句和改对的句子）。',
            '另外给这一课的开篇页：goal（一句中文：学完这课你能做到什么）、warmup（一个和话题有关、学生能马上开口的英文小问题，后面用“ / ”接中文）、homework（一句中文的课后小任务）。',
            '难度贴合这个级别，全部原创。输出：{"goal":"","warmup":"","homework":"","pages":[{"n":1,"pos":"","syll":"","colls":[{"en":"","zh":""}],"family":"","tip":"","wrong":"","right":""},' +
            '{"n":4,"formula":"","forms":[{"label":"肯定","en":"","zh":""}],"signals":"","tip":"","wrong":"","right":""}]}'
        ].join('\n');
        const r = await this.d.llm.json(system, ask, { purpose: 'ielts_book', max_tokens: 1800, thinking: 'disabled' });
        if (!isObject(r) || lesson.closed) return;
        lesson.cover = { goal: clip(r.goal, 60), warmup: clip(r.warmup, 120), homework: clip(r.homework, 80) };
        for (const pg of Array.isArray(r.pages) ? r.pages : []) {
            const p = isObject(pg) && lesson.points.find((x) => x.n === Number(pg.n));
            if (!p) continue;
            const pairs = (v, n, withLabel) => (Array.isArray(v) ? v : []).filter((c) => isObject(c) && c.en).slice(0, n)
                .map((c) => (withLabel ? { label: clip(c.label, 6), en: clip(c.en, 90), zh: clip(c.zh, 50) } : { en: clip(c.en, 40), zh: clip(c.zh, 24) }));
            p.more = p.kind === 'grammar'
                ? { formula: clip(pg.formula, 70), forms: pairs(pg.forms, 3, true), signals: clip(pg.signals, 70), tip: clip(pg.tip, 70), wrong: clip(pg.wrong, 90), right: clip(pg.right, 90) }
                : { pos: clip(pg.pos, 8), syll: clip(pg.syll, 30), colls: pairs(pg.colls, 3, false), family: clip(pg.family, 80), tip: clip(pg.tip, 70), wrong: clip(pg.wrong, 90), right: clip(pg.right, 90) };
        }
        this.saveLesson(lesson);
        this.board(lesson);
        this.log.info('ielts: textbook pages of lesson ' + lesson.id + ' written');
    }

    // The teacher's next turn. said: the student's lines since the last one; why: open | answer |
    // silent. Writes into the talk the box shows, with a face and a gesture on the teacher.
    // graded: the student's answer to a choice or fill-in, already marked here {n, given, correct, answer}.
    async teach(lesson, said, why, graded) {
        if (lesson.thinking || lesson.closed) return;
        lesson.thinking = true;
        const f = this.d.focusTalks;
        try {
            if (f) f.writeStatus(lesson.key, { state: 'thinking', error: '' });
            const left = lesson.points.filter((p) => lesson.taught.indexOf(p.n) < 0);
            const plan = lesson.points.map((p) => p.n + '. [' + p.kind + '] ' + p.en + ' = ' + p.zh + '；讲解：' + p.note + '；例句：' + p.example +
                (p.check ? '；检查题（' + p.check.type + '）：' + p.check.question + (p.check.options ? '，选项：' + p.check.options.join(' / ') : '') + '，标准答案：' + p.check.answer : '') +
                (lesson.taught.indexOf(p.n) >= 0 ? '（已讲完）' : '')).join('\n');
            const spoken = lesson.lines.filter((l) => l.who === 'teacher' && l.speak).length;
            const system = [
                '你是' + lesson.teacherName + '，' + lesson.studentName + '的班主任，这节课在教室里给全班上英语课，现在正面对面地给' + lesson.studentName + '讲雅思（' + lesson.levelName + '）。',
                '你在说话，不是在发消息：口语，短，每次 1 到 3 句、不超过 120 个字，一次只讲一件事。中文讲解，英文单词、例句照原样说。',
                '按教案的顺序：先讲一个要点（意思、用法、例句），再用它的检查题问学生（写 ask.point），等学生回答；学生答了，先判断对不对：对就简短肯定，错就指出错在哪、给出正确说法，必要时换个问法再问一次。',
                '提问会显示在学生面前的题卡上（选择题的选项也在上面），你在话里自然地把问题说出来就行，不用念全部选项。',
                '多和学生互动：讲完两个要点之间，或者全部讲完之后，用一个和本单元话题有关的英文小问题请学生开口回答（雅思口语 Part 1 那样，写 ask.type 为 speak），一节课 1 到 2 个；学生答了，夸具体的地方，再给一个更地道的说法。',
                '一个要点问过并判断过，才进下一个。全部讲完，最后用一两句总结这节课，并且结束。',
                '提了问就停下来等学生回答，不要自问自答；学生很久没回答，才自己说出答案往下讲。学生说的话和课无关，就用一句话拉回来。',
                '不说“作为 AI”这类话，不说游戏、系统；不用表情符号。'
            ].join('\n');
            const transcript = lesson.lines.slice(-14).map((l) => (l.who === 'student' ? lesson.studentName : '你') + '：' + l.text).join('\n');
            const q = lesson.question;
            const ask = [
                '教案（第 ' + lesson.unit.n + ' 单元，话题：' + lesson.topic + '，语法：' + lesson.unit.grammar + '）：',
                plan,
                '',
                transcript ? '这节课刚才的对话：\n' + transcript : (lesson.resumed ? '这节课刚才的对话没有记下来；讲过的要点在教案里标了（已讲完）。' : '课刚开始，你先开场：一句话说今天讲第几单元、讲什么，然后讲第一个要点。'),
                q ? '题卡上现在的问题：' + (q.n ? '要点 ' + q.n + ' 的检查题' : '口语小问题') + '「' + q.prompt + '」。' : '',
                said.length ? lesson.studentName + '刚说：' + said.map((m) => m.text).join(' / ') : (why === 'silent' ? lesson.studentName + '一直没开口：你自己接着往下讲' + (q ? '（可以先说出这道题的答案）' : '') + '。' : why === 'continue' ? lesson.studentName + '在听你讲：接着往下，刚讲完的要点还没问过就用它的检查题问。' : why === 'resume' ? '课刚才被打断了一下（' + lesson.studentName + '那边没听到最后几句）：用一句话自然地接回来，接着讲或者问还没讲完的要点；刚才问到一半的题可以再问一次。' : ''),
                graded ? '这个回答已经判过了：' + (graded.correct ? '对' : '错') + '，标准答案是 ' + graded.answer + '。照这个结果回应，不要写 check。' : '',
                left.length ? '还没讲完的要点：' + left.map((p) => p.n).join('、') + '。' : '要点都讲完了：' + (spoken ? '' : '先问一个口语小问题，学生答完再') + '总结并结束。',
                '只输出 JSON：{"text":"你这次说的话","point":本次讲的或问的要点编号,"ask":{"point":这次提问的要点编号} 或 {"type":"speak","prompt":"英文问题","hint":"一句中文提示"},' +
                '"check":{"point":判断的要点编号,"given":"学生的回答","correct":true 或 false},"taught":[已经讲完并检查过的要点编号],"done":false,"face":"' +
                focusBody.facesText() + ' 之一","gesture":"' + focusBody.gesturesText() + ' 之一，或空"}。这次没提问就不写 ask；没在判断学生的回答，就不要写 check。'
            ].filter(Boolean).join('\n');
            const r = await this.d.llm.json(system, ask, { purpose: 'ielts_teach', voice: ['text'], max_tokens: 900, thinking: 'disabled' });
            const text = clip(r && r.text, 360);
            if (!text) throw new Error('the teacher said nothing');
            for (const n of Array.isArray(r.taught) ? r.taught : []) {
                const k = Number(n);
                if (lesson.points.some((p) => p.n === k) && lesson.taught.indexOf(k) < 0) lesson.taught.push(k);
            }
            if (r.check && !graded && lesson.points.some((p) => p.n === Number(r.check.point)) && typeof r.check.correct === 'boolean') {
                this.noteCheck(lesson, lesson.points.find((p) => p.n === Number(r.check.point)), clip(r.check.given, 120) || (said[0] && said[0].text) || '', r.check.correct);
            }
            if (lesson.points.some((p) => p.n === Number(r.point))) lesson.current = Number(r.point);
            // The question card: a new question, or the one answered goes away.
            const posed = this.pose(lesson, r.ask);
            if (posed) {
                lesson.question = posed;
                if (posed.n) lesson.current = posed.n;
            } else if (said.length || graded) lesson.question = null;
            const reAt = said.length ? said[said.length - 1].at : undefined;
            const face = focusBody.cleanFace(r.face) || 'Normal';
            const gesture = focusBody.cleanGesture(r.gesture);
            if (f) f.append(lesson.key, text, reAt, { face, gesture });
            focusBody.perform(this.d.game, lesson.teacher, face, gesture, this.d.gestureCache, this.log).catch(() => {});
            lesson.lines.push({ who: 'teacher', text, speak: !!(posed && posed.type === 'speak') });
            lesson.lastAt = Date.now();
            lesson.readMs = Math.min(READ_MAX_MS, READ_MS + text.length * READ_PER_CHAR_MS);
            if (r.done === true || lesson.taught.length >= lesson.points.length && !left.length) {
                lesson.done = true;
                lesson.doneAt = Date.now();
                lesson.question = null;
            }
            this.log.info('ielts [' + lesson.key + '] ' + lesson.teacherName + ': ' + JSON.stringify(text) + (posed ? ' [asks ' + posed.type + ']' : '') + (lesson.done ? ' (lesson over)' : ''));
            this.saveLesson(lesson);
            this.board(lesson);
        } finally {
            lesson.thinking = false;
            if (f && !lesson.closed) f.writeStatus(lesson.key, { state: 'online', error: '' });
        }
    }

    // The student's lines, handed over by daemon.tickTalks while the lesson owns the talk.
    async answer(key) {
        const lesson = this.lesson;
        if (!lesson || lesson.key !== key || lesson.thinking) return;
        const talk = this.d.focusTalks.talk(key);
        if (!talk || !talk.pending.length) return;
        for (const m of talk.pending) lesson.lines.push({ who: 'student', text: m.text });
        // A choice or a fill-in on the card has one right answer: marked here, the teacher only answers to it.
        const q = lesson.question;
        let graded = null;
        if (q && q.n && !q.marked && (q.type === 'choice' || q.type === 'fill')) {
            q.marked = true;
            const given = clip(talk.pending[talk.pending.length - 1].text, 120);
            const correct = sameAnswer(q.type === 'choice' ? choiceAnswer(given, q.options) : given, q.answer);
            graded = { n: q.n, given, correct, answer: String(q.answer).split('|')[0] };
            this.noteCheck(lesson, lesson.points.find((p) => p.n === q.n), given, correct);
        }
        await this.teach(lesson, talk.pending, 'answer', graded);
    }

    noteCheck(lesson, point, given, correct) {
        lesson.checks.push({ n: point.n, question: point.check ? point.check.question : point.en, answer: point.check ? point.check.answer : point.zh, given, correct });
        if (correct) return;
        const rec = this.load(lesson.student);
        rec.mistakes.push({ en: point.en, zh: point.zh, question: point.check ? point.check.question : '', answer: point.check ? point.check.answer : '', type: point.check ? point.check.type : 'fill', options: point.check && point.check.options || undefined, given, day: lesson.day, lesson: lesson.id });
        this.save(lesson.student, rec);
    }

    saveLesson(lesson) {
        const rec = this.load(lesson.student);
        const i = rec.lessons.findIndex((l) => l.id === lesson.id);
        if (i >= 0) rec.lessons[i] = this.record(lesson);
        else rec.lessons.push(this.record(lesson));
        this.save(lesson.student, rec);
        // The lesson as it stands, so that a restart of the service in the middle of it goes on
        // with it (resume) instead of leaving the box on its last question.
        try {
            if (lesson.closed) fs.rmSync(this.liveFile(lesson.student), { force: true });
            else fsx.writeJson(this.liveFile(lesson.student), lesson);
        } catch (e) {
            this.log.warn('ielts: lesson state not kept: ' + e.message);
        }
    }

    liveFile(id) { return path.join(this.dir, String(id) + '.live.json'); }

    // A lesson of this period begun before the service (re)started and not ended: it goes on from
    // where it was, as it was kept (saveLesson), or rebuilt from its record when it was not.
    async resume(id, rep, period, had, env, quiet) {
        const r = fsx.readJson(this.liveFile(id));
        let lesson = r.ok && isObject(r.value) && r.value.id === had.id ? r.value : null;
        if (!lesson) {
            const level = LEVELS[had.level] || LEVELS[DEFAULT_LEVEL];
            const unitNo = had.unit || 1;
            const checks = Array.isArray(had.checks) ? had.checks : [];
            lesson = {
                id: had.id, key: id + '-' + rep.teacher.id, student: id, studentName: rep.firstName || rep.name, teacher: rep.teacher.id, teacherName: rep.teacher.name,
                day: env.day, start: period.start, level: had.level, levelName: level.name,
                unit: { n: unitNo, topic: had.topic, grammar: level.grammar[(unitNo - 1) % level.grammar.length] }, title: had.title || '', cover: had.cover || null,
                topic: had.topic, points: had.points || [], checks, taught: Array.from(new Set(checks.map((c) => c.n))), lines: [],
                current: 0, question: null, asked: checks.length, done: !!had.done, doneAt: 0
            };
        }
        Object.assign(lesson, {
            startMin: minutesOf(period.start), endMin: period.endMin, startedAt: Date.now(), lastAt: Date.now(), awayLooks: 0,
            thinking: false, closed: false, toldHow: false, resumed: true
        });
        this.lesson = lesson;
        // Only to be ended (its period is over): nothing opened, nothing said.
        if (quiet) return;
        this.board(lesson);
        this.request('open', id, lesson.teacher, '英语课 · ' + lesson.levelName);
        if (this.d.focusTalks) this.d.focusTalks.writeStatus(lesson.key, { state: 'online', error: '' });
        this.log.info('ielts: lesson ' + lesson.id + ' for ' + id + ' goes on after a restart (' + lesson.taught.length + '/' + lesson.points.length + ' point(s) taught' + (r.ok ? '' : ', rebuilt from its record') + ')');
        if (!lesson.done) await this.teach(lesson, [], 'resume');
    }

    // The lesson is over: the box closes, the notes stay. wrapUp: the bell rang before the
    // teacher finished, a last word first.
    async endLesson(why, wrapUp) {
        const lesson = this.lesson;
        if (!lesson || lesson.closed) return;
        if (wrapUp && !lesson.done && this.d.focusTalks) {
            try { this.d.focusTalks.append(lesson.key, '下课铃响了，今天先到这里，剩下的我们下节课接着讲。回去把笔记看一看。', undefined, { face: 'Calm' }); } catch (e) { /* nothing to add */ }
        }
        lesson.closed = true;
        lesson.question = null;
        this.saveLesson(lesson);
        // The unit: done when this lesson got through it, or on its second lesson.
        const rec = this.load(lesson.student);
        const unit = rec.term && rec.term.units.find((u) => u.n === lesson.unit.n);
        if (unit) {
            if (lesson.taught.length) unit.lessons = (unit.lessons || 0) + 1;
            if (lesson.done || lesson.taught.length >= lesson.points.length || unit.lessons >= 2 && lesson.taught.length) unit.done = true;
            this.save(lesson.student, rec);
        }
        this.board(lesson);
        this.request('close', lesson.student, lesson.teacher, '');
        this.log.info('ielts: lesson ' + lesson.id + ' for ' + lesson.student + ' ended (' + why + '), ' + lesson.taught.length + '/' + lesson.points.length + ' point(s), ' +
            lesson.checks.filter((c) => c.correct).length + '/' + lesson.checks.length + ' right');
        this.lesson = null;
    }

    // ---------------------------------------------------------------- the exam
    // On exam day, before the first paper: a paper of what the week's lessons taught, on the
    // phone. Answered: marked here, and the mark becomes the game's exam preparation.
    async exams(set, env) {
        if (this.examBusy) return;
        const id = String(await this.d.world.possessed().catch(() => '') || '');
        const rep = id && this.d.school && this.d.school.byId ? this.d.school.byId[id] : null;
        if (!rep || !STAGES[rep.stage] || rep.mode !== 'weekly' || !rep.examDay || env.day_of_week !== rep.examDay) return;
        this.examBusy = true;
        try {
            const rec = this.load(id);
            const examId = 'x' + env.day;
            const open = this.readExam();
            const answered = fsx.readJson(this.answerFile);
            if (open && open.id === examId && open.student === id && !open.marked && answered.ok && isObject(answered.value) && answered.value.id === examId) {
                await this.mark(id, rec, open, answered.value, env);
                return;
            }
            if (rec.exams.some((x) => x.id === examId) || (open && open.id === examId && open.student === id)) return;
            const paper = this.paper(id, rec, examId, env, set.level);
            if (!paper) return;
            this.writeExam(paper);
            this.log.info('ielts: exam paper ' + examId + ' for ' + id + ', ' + paper.questions.length + ' question(s)');
            if (this.d.game) this.d.game.soft('toast_show', { Message: '今天考试：手机里有一张雅思试卷，打开「成绩」作答', Lifetime: 8 }).catch(() => {});
        } finally {
            this.examBusy = false;
        }
    }

    readExam() {
        const r = fsx.readJson(this.examFile);
        return r.ok && isObject(r.value) && isObject(r.value.exam) ? r.value.exam : null;
    }

    writeExam(exam) {
        fsx.ensureDir(path.dirname(this.examFile));
        fsx.writeJson(this.examFile, { v: V, at: Date.now(), exam });
    }

    // The questions: what was got wrong first, then the rest of the points of the last lessons.
    paper(id, rec, examId, env, levelNo) {
        const since = env.day - 7;
        const pool = [];
        const seen = new Set();
        const add = (p, from) => {
            const k = String(p.en).toLowerCase();
            if (!p.question || seen.has(k)) return;
            seen.add(k);
            pool.push({ n: pool.length + 1, en: p.en, zh: p.zh, type: p.type || 'fill', question: p.question, options: Array.isArray(p.options) ? p.options : undefined, answer: p.answer, from });
        };
        rec.mistakes.slice().reverse().forEach((m) => add(m, 'mistake'));
        rec.lessons.filter((l) => l.day >= since).slice().reverse().forEach((l) => (l.points || []).forEach((p) => {
            if (p.check) add({ en: p.en, zh: p.zh, type: p.check.type, question: p.check.question, options: p.check.options, answer: p.check.answer }, 'lesson');
        }));
        if (!pool.length) return null;
        return {
            id: examId, student: id, day: env.day, level: levelNo, levelName: LEVELS[levelNo].name, marked: false,
            questions: pool.slice(0, PAPER_SIZE).map((q, i) => ({ n: i + 1, type: q.type, question: q.question + (q.options ? '  ' + q.options.map((o, j) => String.fromCharCode(65 + j) + '. ' + o).join('   ') : ''), options: q.options, en: q.en, zh: q.zh, answer: q.answer, from: q.from }))
        };
    }

    // Marks the paper: one right answer is compared as it is; a sentence of the student's own
    // (make, translate) is judged by the model, which says why.
    async mark(id, rec, exam, answers, env) {
        const given = isObject(answers.answers) ? answers.answers : {};
        const open = [];
        const results = exam.questions.map((q) => {
            const a = clip(given[q.n], 200);
            if (!a) return { n: q.n, given: '', correct: false, why: '没有作答' };
            if (q.type === 'make' || q.type === 'translate') {
                open.push({ n: q.n, question: q.question, en: q.en, reference: q.answer, given: a });
                return { n: q.n, given: a, correct: null, why: '' };
            }
            const ok = sameAnswer(q.options ? choiceAnswer(a, q.options) : a, q.answer);
            return { n: q.n, given: a, correct: ok, why: ok ? '' : '正确答案：' + q.answer };
        });
        if (open.length) {
            try {
                const r = await this.d.llm.json('你是严格但公正的雅思老师，批改高中生的答案。只输出 JSON。',
                    '批改下面每道题（造句看是否用对了目标词、语法基本正确；翻译看意思是否准确）。每题给 correct（true 或 false）和 why（一句中文理由，错了要给出正确写法）。\n' +
                    open.map((o) => o.n + '. 题目：' + o.question + '（目标：' + o.en + '，参考：' + o.reference + '）学生答：' + o.given).join('\n') +
                    '\n输出：{"results":[{"n":题号,"correct":true,"why":""}]}', { purpose: 'ielts_mark', max_tokens: 900, thinking: 'disabled' });
                for (const x of r && Array.isArray(r.results) ? r.results : []) {
                    const it = results.find((y) => y.n === Number(x.n));
                    if (it && it.correct === null) { it.correct = x.correct === true; it.why = clip(x.why, 140); }
                }
            } catch (e) {
                this.log.warn('ielts: marking the open questions failed: ' + e.message);
            }
            for (const it of results) if (it.correct === null) { it.correct = false; it.why = '没能批改，按错题算'; }
        }
        const right = results.filter((x) => x.correct).length;
        const prep = Math.round(100 * right / exam.questions.length);
        await this.d.game.call('career_set_exam_preparation', { entity_id: String(id), Value: prep });
        exam.marked = true;
        exam.results = results;
        exam.score = right;
        exam.prep = prep;
        this.writeExam(exam);
        // Wrong again: back in the mistake book, at the end so it comes first next time.
        for (const it of results) {
            if (it.correct) continue;
            const q = exam.questions.find((x) => x.n === it.n);
            rec.mistakes = rec.mistakes.filter((m) => String(m.en).toLowerCase() !== String(q.en).toLowerCase());
            rec.mistakes.push({ en: q.en, zh: q.zh, question: q.question, answer: q.answer, type: q.type, given: it.given, day: env.day, lesson: exam.id });
        }
        for (const it of results) {
            if (!it.correct) continue;
            const q = exam.questions.find((x) => x.n === it.n);
            if (q.from === 'mistake') rec.mistakes = rec.mistakes.filter((m) => String(m.en).toLowerCase() !== String(q.en).toLowerCase());
        }
        rec.exams.push({ id: exam.id, day: exam.day, score: right, of: exam.questions.length, prep });
        this.save(id, rec);
        this.log.info('ielts: exam ' + exam.id + ' for ' + id + ': ' + right + '/' + exam.questions.length + ', exam preparation ' + prep);
    }
}

module.exports = { Ielts, LEVELS, sameAnswer, choiceAnswer };
