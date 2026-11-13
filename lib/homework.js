'use strict';
// 写作业: the day's homework for a middle or high schooler studying IELTS (雅思学习模式, ielts.js).
// While the played student does the game's own homework (Homework_Do on the homework notebook
// the school hands out), or after 写作业 is picked on them in the game's menu (which has them sit
// down to it), the 智能对话 window shows the day's exercise sheet: questions on what the day's
// lesson taught (or the last lesson's, on a day without one) and the mistakes not yet put right.
// Handed in, it is marked here: one right answer is compared as it is, a sentence of the
// student's own (translate, make, fix) is judged by the model, which says why and how it should
// read. What is wrong goes into the mistake book (ielts.js), what is put right comes out of it.
//
// Files, under <focus>/homework:
//   <student>.cfg  the sheet {v, id, day, student, ask, state, title, unit, from, questions, results,
//                  score, of, why}   written here only. state: making | ready | marking | marked |
//                  off (study mode off) | none (not a student) | failed
//   ask.cfg        {seq, player, at}   写作业 picked, written by the focus app
//   answer.cfg     {id, student, answers: {n: text}, at}   handed in, written by the focus app
// And <focus>/request.cfg op homework (ielts.request), which opens the window on the sheet.
const path = require('path');
const fsx = require('./fsx');
const { LEVELS, sameAnswer, choiceAnswer } = require('./ielts');

const V = 1;
const STAGES = { LowTeen: true, HighTeen: true };
// The game's homework: sitting down to it, and doing it.
const HOMEWORK_RE = /^(Has|Next_)?Homework_/;
const TYPES = ['choice', 'fill', 'translate', 'make', 'fix'];
const OPEN_TYPES = { translate: true, make: true, fix: true };
const NEW_QUESTIONS = 6;
const MISTAKES_ASKED = 2;
const ASK_FRESH_MS = 20000;
const LOOK_MS = 6000;
// The game's "学习专业教材" at a bookcase or a book (either size of it).
const STUDY_RE = /^Bookshelf_SitRead_StudyMath(_45cm)?_Perspective$/;

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function clip(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }

// A question as the model wrote it, or null: a choice keeps its options only if the answer is one.
function cleanQuestion(q) {
    if (!isObject(q) || !q.prompt || !q.answer) return null;
    const out = { type: TYPES.indexOf(q.type) >= 0 ? q.type : 'fill', prompt: clip(q.prompt, 160), answer: clip(q.answer, 140), point: clip(q.point, 60), explain: clip(q.explain, 120) };
    if (out.type === 'choice') {
        const options = (Array.isArray(q.options) ? q.options : []).map((o) => clip(String(o).replace(/^\s*[A-Da-d]\s*[.、)）]\s*/, ''), 60)).filter(Boolean).slice(0, 4);
        if (options.length >= 2 && options.some((o) => sameAnswer(o, out.answer))) out.options = options;
        else out.type = 'fill';
    }
    return out;
}

class Homework {
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.busy = false;
        this.askSeq = 0;
        this.answerAt = 0;
        this.lookAt = 0;
        this.shown = {};      // student -> doing the game's homework at the last look (the sheet shown then)
    }

    configure(focusDir) {
        this.dir = path.join(focusDir, 'homework');
        this.askFile = path.join(this.dir, 'ask.cfg');
        this.answerFile = path.join(this.dir, 'answer.cfg');
        const a = fsx.readJson(this.askFile);
        this.askSeq = a.ok && a.value && typeof a.value.seq === 'number' ? a.value.seq : 0;
        const b = fsx.readJson(this.answerFile);
        this.answerAt = b.ok && b.value && typeof b.value.at === 'number' ? b.value.at : 0;
        // 复习功课 opened or closed (focus app.js): {seq, op: open | close, player, at}.
        this.studyFile = path.join(focusDir, 'book', 'ask.cfg');
        const c = fsx.readJson(this.studyFile);
        this.studySeq = c.ok && c.value && typeof c.value.seq === 'number' ? c.value.seq : 0;
        this.studying = null;     // { id, bag } the study this service started
    }

    // 复习功课: while the textbook is open, the student really studies — walks to the nearest
    // bookcase or book on the lot, takes a textbook and sits down with it (the game's own
    // 学习专业教材). Closed, the study they were sat down to ends.
    async study() {
        const r = fsx.readJson(this.studyFile);
        const q = r.ok && isObject(r.value) ? r.value : null;
        if (!q || typeof q.seq !== 'number' || q.seq <= this.studySeq) return;
        this.studySeq = q.seq;
        const id = String(q.player || '');
        if (!/^\d+$/.test(id) || Date.now() - (q.at || 0) > ASK_FRESH_MS) return;
        if (q.op === 'close') {
            const s = this.studying;
            this.studying = null;
            if (!s || s.id !== id) return;
            const cur = await this.d.game.soft('interaction_get_current', { entity_id: id });
            if (cur && cur.playing && STUDY_RE.test(String(cur.interaction_bag_id || ''))) {
                await this.d.game.soft('interaction_cancel', { entity_id: id });
                this.log.info('homework: ' + id + ' puts the textbook away');
            }
            return;
        }
        if (q.op !== 'open' || (this.d.ielts.lesson && !this.d.ielts.lesson.closed)) return;
        const cur = await this.d.game.soft('interaction_get_current', { entity_id: id });
        if (cur && cur.playing && (STUDY_RE.test(String(cur.interaction_bag_id || '')) || /Sleep/.test(String(cur.interaction_bag_id || '')))) return;
        const scan = await this.d.game.soft('entity_scan_objects', { Radius: 30, Direction: 'all', Cone: 180, ref: 'pawn', Limit: 100, sort: 'distance' });
        const books = ((scan && scan.objects) || []).filter((o) => /书/.test(String(o.name || ''))).slice(0, 6);
        for (const o of books) {
            const list = await this.d.game.soft('interaction_list_available', { entity_id: id, target_entity_id: String(o.entity_id) });
            const hit = ((list && list.interactions) || []).find((x) => x.enabled !== false && STUDY_RE.test(String(x.interaction_bag_id || '')));
            if (!hit) continue;
            const done = await this.d.game.soft('interaction_execute', { entity_id: id, interaction_bag_id: hit.interaction_bag_id, target_entity_id: String(o.entity_id), insert_front: true });
            if (done === null) continue;
            this.studying = { id, bag: hit.interaction_bag_id };
            this.log.info('homework: ' + id + ' studies a textbook at ' + o.name + ' (' + o.entity_id + ') for 复习功课');
            return;
        }
        this.log.info('homework: no bookcase or book near ' + id + ' to study at');
    }

    sheetFile(id) { return path.join(this.dir, String(id) + '.cfg'); }

    readSheet(id) {
        const r = fsx.readJson(this.sheetFile(id));
        return r.ok && isObject(r.value) ? r.value : null;
    }

    writeSheet(sheet) {
        try {
            fsx.ensureDir(this.dir);
            fsx.writeJson(this.sheetFile(sheet.student), Object.assign(sheet, { v: V, at: Date.now() }));
        } catch (e) {
            this.log.warn('homework: sheet not written: ' + e.message);
        }
    }

    // ---------------------------------------------------------------- every few seconds
    async tick() {
        if (this.busy || !this.dir) return;
        this.busy = true;
        try {
            const env = this.d.freshEnv ? this.d.freshEnv() : null;
            if (!env || typeof env.day !== 'number') return;
            await this.asked(env);
            await this.study();
            await this.handedIn(env);
            await this.look(env);
        } catch (e) {
            this.log.warn('homework: ' + (e && e.message || e));
        } finally {
            this.busy = false;
        }
    }

    // 写作业 picked in the menu: the student sits down to the game's homework when there is some,
    // and the sheet is shown.
    async asked(env) {
        const r = fsx.readJson(this.askFile);
        const q = r.ok && isObject(r.value) ? r.value : null;
        if (!q || typeof q.seq !== 'number' || q.seq <= this.askSeq) return;
        this.askSeq = q.seq;
        if (Date.now() - (q.at || 0) > ASK_FRESH_MS || !/^\d+$/.test(String(q.player || ''))) return;
        const id = String(q.player);
        const rep = this.report(id);
        if (!this.d.ielts.settings().enabled) {
            this.writeSheet({ student: id, ask: q.seq, state: 'off', day: env.day });
            return;
        }
        if (!rep) {
            this.writeSheet({ student: id, ask: q.seq, state: 'none', day: env.day });
            return;
        }
        const hw = await this.notebook(id);
        if (hw) {
            await this.d.game.soft('interaction_execute', { entity_id: id, interaction_bag_id: 'Homework_Do', target_entity_id: hw, insert_front: true });
            this.log.info('homework: ' + id + ' sits down to the homework notebook ' + hw);
        }
        // Sitting down to it now, from the menu: the sheet is already up.
        this.shown[id] = true;
        await this.open(id, env, q.seq);
    }

    // Doing the game's homework by themselves: the sheet is shown each time they sit down to it
    // (closed by mistake, the next go at the homework brings it back), until it is handed in.
    async look(env) {
        if (Date.now() - this.lookAt < LOOK_MS) return;
        this.lookAt = Date.now();
        if (!this.d.ielts.settings().enabled || (this.d.ielts.lesson && !this.d.ielts.lesson.closed)) return;
        const id = String(await this.d.world.possessed().catch(() => '') || '');
        if (!id || !this.report(id)) return;
        const cur = await this.d.game.soft('interaction_get_current', { entity_id: id });
        const doing = !!(cur && cur.playing && HOMEWORK_RE.test(String(cur.interaction_bag_id || '')));
        const was = this.shown[id] === true;
        this.shown[id] = doing;
        if (!doing || was) return;
        const sheet = this.readSheet(id);
        if (sheet && sheet.day === env.day && sheet.state === 'marked') return;
        this.log.info('homework: ' + id + ' is doing homework (' + cur.interaction_bag_id + '), the sheet opens');
        await this.open(id, env, 0);
    }

    // A middle or high schooler of a school with a timetable, or null.
    report(id) {
        const rep = this.d.school && this.d.school.byId ? this.d.school.byId[id] : null;
        return rep && STAGES[rep.stage] && rep.mode === 'weekly' ? rep : null;
    }

    // The homework notebook the school handed this student, or ''.
    async notebook(id) {
        const car = await this.d.game.soft('entity_reflect', { entity_id: id, Component: 'FB2CareerComponent' });
        const slot = car && car.careerSlots && car.careerSlots.school;
        const sid = slot && slot.careerEntityId && slot.careerEntityId.value;
        if (!sid) return '';
        const school = await this.d.game.soft('entity_reflect', { entity_id: String(sid) });
        const find = (o, depth) => {
            if (!o || typeof o !== 'object' || depth > 6) return null;
            if (o.studentHomeworkMap) return o.studentHomeworkMap;
            for (const k of Object.keys(o)) { const r = find(o[k], depth + 1); if (r) return r; }
            return null;
        };
        const map = find(school, 0) || {};
        const key = Object.keys(map).find((k) => k === id || k.indexOf('=' + id + ')') >= 0);
        const v = key && map[key] && map[key].homeworkObjectId && Number(map[key].homeworkObjectId.value);
        return v > 0 ? String(v) : '';
    }

    // Shows today's sheet: as it is when there is one, else written now.
    async open(id, env, ask) {
        let sheet = this.readSheet(id);
        if (sheet && sheet.day === env.day && (sheet.state === 'ready' || sheet.state === 'marked' || sheet.state === 'marking')) {
            sheet.ask = ask || sheet.ask || 0;
            this.writeSheet(sheet);
            this.d.ielts.request('homework', id, id, '今日练习');
            return;
        }
        sheet = { id: 'hw' + env.day, student: id, day: env.day, ask: ask || 0, state: 'making' };
        this.writeSheet(sheet);
        this.d.ielts.request('homework', id, id, '今日练习');
        try {
            Object.assign(sheet, await this.make(id, env), { state: 'ready' });
        } catch (e) {
            this.log.warn('homework: no sheet for ' + id + ': ' + e.message);
            sheet.state = 'failed';
        }
        this.writeSheet(sheet);
    }

    // The day's questions: new ones on what was taught, and the mistakes still in the book.
    async make(id, env) {
        const ie = this.d.ielts;
        const set = ie.settings();
        const level = LEVELS[set.level];
        const rec = ie.load(id);
        const today = rec.lessons.filter((l) => l.day === env.day && (l.points || []).length);
        const taught = today.length ? today : rec.lessons.filter((l) => (l.points || []).length).slice(-1);
        const points = [];
        for (const l of taught) for (const p of l.points) points.push(p);
        const unit = taught.length ? { n: taught[taught.length - 1].unit || 1, topic: taught[taught.length - 1].topic } : null;
        const term = ie.termFor(rec, set.level);
        const next = term.units.find((u) => !u.done) || term.units[0];
        const about = unit ? '这些是学生' + (today.length ? '今天' : '上节课') + '学的要点：\n' + points.map((p) => '- [' + p.kind + '] ' + p.en + ' = ' + p.zh + (p.example ? '；例句：' + p.example : '')).join('\n')
            : '学生还没上过课，就出本学期第一个单元的预习题：话题「' + next.topic + '」，语法「' + next.grammar + '」。';
        const r = await this.d.llm.json('你是一位雅思老师，给中国' + (this.report(id) && this.report(id).stage === 'LowTeen' ? '初中' : '高中') + '生布置课后练习。只输出 JSON。', [
            '出一份课后练习，学生程度：' + level.name + '（雅思 ' + level.band + '，CEFR ' + level.cefr + '）。',
            about,
            '出 ' + NEW_QUESTIONS + ' 道新题，换着角度考这些要点，不要照抄课上的例句，题型都要有：',
            'choice（单选，options 3 到 4 个英文选项，不带字母，answer 和其中一个一字不差）、fill（填空，题干里用 ____ 标出空，answer 是唯一的词或短语，有几种都对用 | 隔开）、',
            'translate（把一句中文翻成英文，answer 是参考译文）、make（用指定的词造一个句子，answer 是参考句）、fix（给一句有一个错的英文让学生改正，answer 是改对的句子）。',
            '题干 prompt 用中文写要求，英文部分照原样。每题写 point（考的是哪个要点，英文）和 explain（一句中文：考点是什么、怎么想）。',
            '输出：{"title":"这份练习的小标题（中文，10 字以内）","questions":[{"type":"choice","point":"","prompt":"","options":["","",""],"answer":"","explain":""}]}'
        ].join('\n'), { purpose: 'ielts_homework', max_tokens: 1600, thinking: 'disabled' });
        const fresh = (r && Array.isArray(r.questions) ? r.questions : []).map(cleanQuestion).filter(Boolean).slice(0, NEW_QUESTIONS);
        if (!fresh.length) throw new Error('the model wrote no questions');
        const asked = new Set(fresh.map((q) => q.point.toLowerCase()));
        const again = rec.mistakes.slice().reverse().filter((m) => m.question && m.answer && !asked.has(String(m.en).toLowerCase())).slice(0, MISTAKES_ASKED)
            .map((m) => cleanQuestion({ type: m.type === 'make' || m.type === 'translate' || m.type === 'choice' ? m.type : 'fill', prompt: m.question, options: m.options, answer: m.answer, point: m.en, explain: '错题本里的题：上次答的是「' + clip(m.given, 40) + '」' }))
            .filter(Boolean).map((q) => Object.assign(q, { from: 'mistake' }));
        const questions = fresh.concat(again).map((q, i) => Object.assign({ n: i + 1 }, q));
        return {
            title: clip(r.title, 20) || '课后练习', level: level.name, unit: unit || { n: next.n, topic: next.topic },
            from: today.length ? 'today' : (taught.length ? 'last' : 'preview'), questions, of: questions.length
        };
    }

    // The sheet handed in: marked, the mistake book brought up to date.
    async handedIn(env) {
        const r = fsx.readJson(this.answerFile);
        const a = r.ok && isObject(r.value) ? r.value : null;
        if (!a || typeof a.at !== 'number' || a.at <= this.answerAt) return;
        this.answerAt = a.at;
        const id = String(a.student || '');
        const sheet = /^\d+$/.test(id) ? this.readSheet(id) : null;
        if (!sheet || sheet.id !== a.id || sheet.state !== 'ready') return;
        sheet.state = 'marking';
        this.writeSheet(sheet);
        const given = isObject(a.answers) ? a.answers : {};
        const results = sheet.questions.map((q) => {
            const g = clip(given[q.n], 200);
            if (!g) return { n: q.n, given: '', correct: false, answer: q.answer.split('|')[0], why: '没有作答。' + q.explain };
            if (OPEN_TYPES[q.type]) return { n: q.n, given: g, correct: null, answer: q.answer, why: '' };
            const ok = sameAnswer(q.options ? choiceAnswer(g, q.options) : g, q.answer);
            return { n: q.n, given: g, correct: ok, answer: q.answer.split('|')[0], why: ok ? '' : q.explain };
        });
        const open = results.filter((x) => x.correct === null).map((x) => Object.assign({}, x, { q: sheet.questions.find((q) => q.n === x.n) }));
        if (open.length) {
            try {
                const m = await this.d.llm.json('你是严格但公正的雅思老师，批改学生的作业。只输出 JSON。', [
                    '批改下面每道题。翻译看意思准不准、语法对不对；造句看有没有用对指定的词、句子是否通顺；改错看错处是否改对了，其他地方没改坏。',
                    '小的拼写或标点问题不算错，但要在 why 里提一句。每题给 correct（true 或 false）、why（一句中文：对在哪或错在哪）、fixed（把学生的句子改成正确的样子；完全对就照抄）。',
                    open.map((o) => o.n + '. [' + o.q.type + '] ' + o.q.prompt + '（考点：' + o.q.point + '，参考答案：' + o.q.answer + '）学生答：' + o.given).join('\n'),
                    '输出：{"results":[{"n":题号,"correct":true,"why":"","fixed":""}]}'
                ].join('\n'), { purpose: 'ielts_mark', max_tokens: 1200, thinking: 'disabled' });
                for (const x of m && Array.isArray(m.results) ? m.results : []) {
                    const it = results.find((y) => y.n === Number(x.n));
                    if (!it || it.correct !== null) continue;
                    it.correct = x.correct === true;
                    it.why = clip(x.why, 160);
                    const fixed = clip(x.fixed, 160);
                    if (fixed && fixed !== it.given) it.fixed = fixed;
                }
            } catch (e) {
                this.log.warn('homework: marking the open questions failed: ' + e.message);
            }
            for (const it of results) if (it.correct === null) { it.correct = false; it.why = '没能批改，先按错题算，对照参考答案看看。'; }
        }
        sheet.results = results;
        sheet.score = results.filter((x) => x.correct).length;
        sheet.of = results.length;
        sheet.state = 'marked';
        sheet.markedAt = Date.now();
        this.writeSheet(sheet);
        // The mistake book: wrong ones in (at the end, so they come first next time), right ones out.
        const ie = this.d.ielts;
        const rec = ie.load(id);
        for (const it of results) {
            const q = sheet.questions.find((x) => x.n === it.n);
            const en = String(q.point || '').toLowerCase();
            if (it.correct && q.from !== 'mistake') continue;
            rec.mistakes = rec.mistakes.filter((m) => String(m.en).toLowerCase() !== en);
            if (!it.correct) rec.mistakes.push({ en: q.point || q.answer, zh: '', question: q.prompt, answer: q.answer, type: q.type, options: q.options, given: it.given, day: env.day, lesson: sheet.id });
        }
        ie.save(id, rec);
        this.log.info('homework: ' + sheet.id + ' of ' + id + ' marked ' + sheet.score + '/' + sheet.of);
    }
}

module.exports = { Homework, cleanQuestion, HOMEWORK_RE };
