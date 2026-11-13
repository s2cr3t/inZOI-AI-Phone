'use strict';
// The phone's school app (成绩): each schoolchild's report card, timetable and teacher's remarks.
//
// What comes from the game (read every SYNC_MS):
//   FB2CareerComponent.careerSlots.school   the school, the class (jobDtId), rank and exp
//   Career data table                        school and class names, rank names, school hours
//   the school entity (FB2School, on-lot middle and high schools)
//     studentEvaluationMap[<student>]        this week's attendance and homework by day, the last
//                                            morning and afternoon exam (out of 20 each), the grade
//                                            now and before, and every finished week's scores
//                                            (attendance 15, participation 25, homework 20,
//                                            exam 40, relationships) with its grade
//     classSections                          the class: its teacher and students
//     studentDemeritMap, principalId, examDayOfWeek, scheduleStudioDatas (today's periods)
//   the school entity (FB2FakeSchool, the elementary school off the lot): only memberInfo; the
//     grade there is the rank, whose names are the grades (F, C, B, A, A+), and exp the way to the next
//   graduationRecords                        earlier schools and the grade they ended with
//   careerSlots.club                         the school club
// What the game does not have, made here and fixed by who the student is (seeded, never random):
//   the subjects in the timetable and who teaches them (except the class teacher at an on-lot
//   school, who is the game's), which subject each exam paper was, the class name (classgroup.js's,
//   so the class chat and the report agree), and the teacher's remarks, which are written from the
//   real numbers above and change only when they do.
//
// <phone>/school/report.cfg (this module only): { v, at, term, byId: { <member id>: report } }.
const path = require('path');
const fsx = require('./fsx');
const { className } = require('./classgroup');

const V = 1;
const SYNC_MS = 60000;
const ROW_TTL_MS = 30 * 60000;
const NAME_TTL_MS = 30 * 60000;

const STAGE_TEXT = { Child: '小学', LowTeen: '初中', HighTeen: '高中' };
const GRADE_TEXT = { APlus: 'A+', A: 'A', B: 'B', C: 'C', D: 'D', F: 'F' };
const SEASON_TERM = { Spring: '春季学期', Summer: '夏季学期', Autumn: '秋季学期', Fall: '秋季学期', Winter: '冬季学期' };
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
// Most a week's part can score (the game's weekly history adds up to 100).
const PART_MAX = { attendance: 15, participation: 25, homework: 20, exam: 40 };
const PAPER_MAX = 20;

const SUBJECTS = {
    Child: { main: ['语文', '数学', '英语'], rest: ['科学', '音乐', '美术', '体育', '道德与法治', '劳动'] },
    LowTeen: { main: ['语文', '数学', '英语'], rest: ['物理', '生物', '历史', '地理', '道德与法治', '体育', '音乐', '美术', '信息技术'] },
    HighTeen: { main: ['语文', '数学', '英语'], rest: ['物理', '化学', '生物', '历史', '地理', '政治', '体育', '信息技术'] }
};
const PAPERS = { main: ['语文', '数学', '英语'], Child: ['科学'], LowTeen: ['物理', '历史', '生物'], HighTeen: ['物理', '化学', '历史', '生物'] };
const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '胡', '郭', '林', '何', '高', '罗', '郑'];

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function hash(s) {
    let h = 2166136261;
    for (const ch of String(s)) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

// A fixed sequence of numbers in [0, 1) for one seed.
function seeded(seed) {
    let a = hash(seed) || 1;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick(list, r) { return list[Math.floor(r() * list.length) % list.length]; }

function gradeText(g) { return GRADE_TEXT[g] || ''; }

function hhmm(n) {
    const v = Number(n) || 0;
    const h = Math.floor(v / 100);
    const m = v % 100;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function minutes(n) { return Math.floor(n / 100) * 60 + (n % 100); }
function toHhmm(min) { return Math.floor(min / 60) * 100 + (min % 60); }

function idKey(id) { return '(Value=' + id + ')'; }

function fullName(c) {
    if (!c) return '';
    return ((c.last_name || '') + (c.first_name || '')) || c.name || '';
}

// The periods of a school day. slots: today's periods of the class at an on-lot school (the
// game's own times); else the school hours from the Career table, cut into lessons.
function periods(slots, start, end) {
    const out = [];
    if (Array.isArray(slots) && slots.length) {
        for (const s of slots) {
            const a = Number(s.startHHMM);
            const b = Number(s.endHHMM);
            if (!(b > a)) continue;
            if (s.phase === 'BeforeSchool') out.push({ kind: 'self', label: '早自习', start: hhmm(a), end: hhmm(b) });
            else if (s.phase === 'LunchBreak') out.push({ kind: 'lunch', label: '午休', start: hhmm(a), end: hhmm(b) });
            else {
                // A two-hour class block is two lessons with a break between.
                const from = minutes(a);
                const to = minutes(b);
                const n = Math.max(1, Math.round((to - from) / 60));
                const len = Math.floor((to - from - 10 * (n - 1)) / n);
                for (let i = 0; i < n; i++) {
                    const ls = from + i * (len + 10);
                    out.push({ kind: 'lesson', block: s.slotId === 'School_AfternoonClass' ? 'pm' : 'am', start: hhmm(toHhmm(ls)), end: hhmm(toHhmm(ls + len)) });
                }
            }
        }
    }
    if (!out.length && end > start) {
        let t = minutes(start);
        const stop = minutes(end);
        while (t + 40 <= stop) {
            if (t >= 12 * 60 && t < 13 * 60) {
                out.push({ kind: 'lunch', label: '午休', start: hhmm(toHhmm(t)), end: '13:00' });
                t = 13 * 60;
                continue;
            }
            out.push({ kind: 'lesson', block: t < 12 * 60 ? 'am' : 'pm', start: hhmm(toHhmm(t)), end: hhmm(toHhmm(t + 45)) });
            t += 60;
        }
    }
    let n = 0;
    for (const p of out) if (p.kind === 'lesson') p.label = '第' + '一二三四五六七八九十'.charAt(n++) + '节';
    return out;
}

// The week's subjects, the same every time for one class.
function timetable(stage, seed, per, examDay, teacherName) {
    const pool = SUBJECTS[stage] || SUBJECTS.HighTeen;
    const r = seeded('tt:' + seed);
    const lessons = per.filter((p) => p.kind === 'lesson').length;
    const homeroom = pick(pool.main, r);
    const teachers = {};
    const used = new Set();
    for (const s of pool.main.concat(pool.rest)) {
        if (s === homeroom && teacherName) { teachers[s] = teacherName; continue; }
        let sur = pick(SURNAMES, r);
        for (let i = 0; i < 4 && used.has(sur); i++) sur = pick(SURNAMES, r);
        used.add(sur);
        teachers[s] = sur + '老师';
    }
    const days = WEEKDAYS.map((day) => {
        if (day === examDay) return { day, exam: true, cells: per.filter((p) => p.kind === 'lesson').map(() => '考试') };
        // Main subjects every day, the rest filled in, no subject twice in a row.
        const want = pool.main.slice();
        const rest = pool.rest.slice();
        while (want.length < lessons) want.push(rest.splice(Math.floor(r() * rest.length), 1)[0] || pick(pool.main, r));
        const cells = want.slice(0, lessons);
        for (let i = cells.length - 1; i > 0; i--) {
            const j = Math.floor(r() * (i + 1));
            const t = cells[i]; cells[i] = cells[j]; cells[j] = t;
        }
        for (let i = 1; i < cells.length; i++) {
            if (cells[i] === cells[i - 1] && i + 1 < cells.length) { const t = cells[i]; cells[i] = cells[i + 1]; cells[i + 1] = t; }
        }
        return { day, exam: false, cells };
    });
    return { homeroom, teachers, days };
}

// Which subject a week's two exam papers were, fixed per student and week.
function papers(stage, seed, week) {
    const r = seeded('paper:' + seed + ':' + week);
    const second = PAPERS[stage] || PAPERS.HighTeen;
    return [pick(PAPERS.main, r), pick(second.concat(PAPERS.main), r)];
}

function tone(letter) {
    if (letter === 'A+' || letter === 'A') return 'good';
    if (letter === 'B') return 'ok';
    if (letter === 'C') return 'warn';
    if (letter === 'D' || letter === 'F') return 'bad';
    return '';
}

// The teacher's remarks, from the numbers only. Every sentence stands on a fact of the report;
// the wording of a fact is picked by the student and the week, so it reads the same until the
// facts change. Returns { text, tags: [{ text, tone }] }.
function remark(rep) {
    const r = seeded('remark:' + rep.id + ':' + (rep.weeks.length ? rep.weeks[rep.weeks.length - 1].week : 0) + ':' + rep.grade);
    const name = rep.firstName || rep.name || '这位同学';
    const s = [];
    const tags = [];
    const last = rep.weeks.length ? rep.weeks[rep.weeks.length - 1] : null;
    const prev = rep.weeks.length > 1 ? rep.weeks[rep.weeks.length - 2] : null;
    if (rep.mode === 'weekly') {
        if (last) {
            if (prev && last.total > prev.total + 4) s.push(pick(['第' + last.week + '周比上周进步了 ' + (last.total - prev.total) + ' 分，看得出在用心。', '这周总评 ' + last.total + ' 分，比上周高出一截，值得表扬。'], r));
            else if (prev && last.total < prev.total - 4) s.push(pick(['第' + last.week + '周总评从 ' + prev.total + ' 分掉到 ' + last.total + ' 分，要找找原因。', '最近一周退步了 ' + (prev.total - last.total) + ' 分，老师有点担心。'], r));
            else s.push(pick(['上周总评 ' + last.total + ' 分，评为 ' + last.grade + '。', '第' + last.week + '周拿到 ' + last.grade + '（' + last.total + ' 分）。'], r));
            if (last.exam >= 36) { s.push(pick(['考试发挥很稳，' + last.exam + '/40。', '卷面成绩 ' + last.exam + '/40，基础扎实。'], r)); tags.push({ text: '考试稳', tone: 'good' }); }
            else if (last.exam < 24) { s.push(pick(['考试只拿了 ' + last.exam + '/40，复习要再下功夫。', '卷面 ' + last.exam + '/40 偏低，考前要多做准备。'], r)); tags.push({ text: '考试待提高', tone: 'warn' }); }
            if (last.homework >= PART_MAX.homework) { s.push(pick(['作业每次都按时交。', '作业完成得很认真。'], r)); tags.push({ text: '作业认真', tone: 'good' }); }
            else if (last.homework <= 8) { s.push(pick(['作业经常没交（' + last.homework + '/20），这是最该补上的。', '作业分只有 ' + last.homework + '/20，回家记得写作业。'], r)); tags.push({ text: '作业欠交', tone: 'bad' }); }
            if (last.attendance >= PART_MAX.attendance) tags.push({ text: '全勤', tone: 'good' });
            else { s.push('出勤扣了分，按时到校很重要。'); tags.push({ text: '缺勤', tone: 'bad' }); }
            if (last.participation >= PART_MAX.participation) tags.push({ text: '课堂积极', tone: 'good' });
            if (last.relationship > 0) { s.push('和同学相处融洽。'); tags.push({ text: '人缘好', tone: 'good' }); }
            else if (last.relationship < 0) { s.push('和同学有过摩擦，要学会好好沟通。'); tags.push({ text: '注意相处', tone: 'warn' }); }
        } else {
            s.push(rep.history.length ? '刚升入' + rep.school + '不久，第一份周评定还没出来。' : pick(['刚转来不久，还没有完整的一周评定。', '这学期的第一份周评定还没出来。'], r));
        }
        const c = rep.current;
        if (c) {
            const came = c.days.filter((d) => d.attendance === 'Normal').length;
            const done = c.days.filter((d) => d.homework === 'Completed').length;
            if (came) s.push('本周已到校 ' + came + ' 天' + (done ? '，交了 ' + done + ' 次作业' : '，作业还一次没交') + '。');
            if (c.morning !== null && c.morning >= 18) s.push(pick(['上午场考了 ' + c.morning + '/20，很不错。', '上午那场卷子 ' + c.morning + '/20，继续保持。'], r));
            if (c.prep >= 80) { s.push('考前准备得很充分。'); tags.push({ text: '备考充分', tone: 'good' }); }
            else if (c.prep !== null && c.prep < 30 && !last) tags.push({ text: '备考不足', tone: 'warn' });
            if (c.demerit >= 30) { s.push('纪律分扣了 ' + c.demerit + '，课上要守规矩。'); tags.push({ text: '注意纪律', tone: 'bad' }); }
        }
    } else {
        const g = rep.grade;
        if (g === 'A+') s.push(pick([name + '这学期表现非常出色，是班上的榜样。', name + '各方面都很棒，老师为你骄傲。'], r));
        else if (g === 'A') s.push(pick([name + '学习认真，成绩优秀。', name + '表现很好，老师很放心。'], r));
        else if (g === 'B') s.push(pick([name + '成绩不错，还有进步的空间。', name + '学习态度端正，再加把劲就能更好。'], r));
        else if (g === 'C') s.push(pick([name + '成绩一般，要多花点心思在学习上。', name + '基础还要打牢，老师相信你可以。'], r));
        else s.push(pick([name + '最近成绩不太理想，需要家长多关心。', name + '要多和老师交流，把落下的补上。'], r));
        const p = rep.progress;
        if (p && p.next) {
            const left = p.to - p.exp;
            if (left <= (p.to - p.from) * 0.2) { s.push('离 ' + p.next + ' 只差 ' + left + ' 点达成度了，加油！'); tags.push({ text: '快升级了', tone: 'good' }); }
            else s.push('达成度 ' + p.exp + '，到 ' + p.to + ' 就能升到 ' + p.next + '。');
        } else if (p) {
            tags.push({ text: '最高等级', tone: 'good' });
        }
        const a = rep.attendance;
        if (a) {
            if (a.unexcused) { s.push('有 ' + a.unexcused + ' 次无故缺课，要按时上学。'); tags.push({ text: '缺课', tone: 'bad' }); }
            else if (a.days >= 3) { s.push('已经按时上学 ' + a.days + ' 天，从不缺课。'); tags.push({ text: '按时到校', tone: 'good' }); }
            if (a.absentRun > 1) s.push('已经连续 ' + a.absentRun + ' 天没来上学了。');
        }
    }
    if (rep.club) tags.push({ text: rep.club, tone: '' });
    return { text: s.join(''), tags: tags.slice(0, 6) };
}

class School {
    constructor(daemon) {
        this.d = daemon;
        this.log = daemon.log;
        this.file = '';
        this.syncedAt = 0;
        this.busy = false;
        this.last = '';
    }

    configure(phoneDir) {
        this.file = path.join(phoneDir, 'school', 'report.cfg');
    }

    tick() {
        if (this.busy || Date.now() - this.syncedAt < SYNC_MS) return;
        this.busy = true;
        this.syncedAt = Date.now();
        this.sync().catch((e) => this.log.warn('school: ' + e.message)).then(() => { this.busy = false; });
    }

    row(dtId) {
        return this.d.world.cached('school-row:' + dtId, ROW_TTL_MS, () => this.d.game.soft('data_table_get', { Alias: 'Career', Row: dtId }));
    }

    async text(keys) {
        const list = keys.filter((k) => typeof k === 'string' && k && k !== 'None');
        if (!list.length) return {};
        const t = (await this.d.game.soft('l10n_get', { Keys: JSON.stringify(list) })) || {};
        const out = {};
        for (const k of list) if (typeof t[k] === 'string' && t[k] && t[k] !== k) out[k] = t[k];
        return out;
    }

    async personName(id) {
        if (!id || Number(id) < 0) return '';
        const c = await this.d.world.cached('school-name:' + id, NAME_TTL_MS, () => this.d.game.soft('entity_get_character_info', { entity_id: String(id) }));
        return fullName(c);
    }

    async sync() {
        const world = this.d.world;
        if (await world.phase() !== 'in_game') return;
        const hh = await world.household();
        const env = (await this.d.game.soft('environment_get_state', {})) || {};
        const byId = {};
        const schools = new Map();
        for (const m of hh.members || []) {
            if (!STAGE_TEXT[m.age_group]) continue;
            const rep = await this.report(m, env, schools).catch((e) => {
                this.log.warn('school: report of ' + m.entity_id + ' not read: ' + e.message);
                return null;
            });
            if (rep) byId[String(m.entity_id)] = rep;
        }
        // The reports, for the IELTS lessons and exams (ielts.js).
        this.byId = byId;
        const out = { v: V, term: SEASON_TERM[env.season] || '', today: env.day_of_week || '', day: typeof env.day === 'number' ? env.day : null, byId };
        const text = JSON.stringify(out);
        if (text === this.last) return;
        this.last = text;
        try {
            fsx.ensureDir(path.dirname(this.file));
            fsx.writeJson(this.file, Object.assign({ at: Date.now() }, out), true);
        } catch (e) {
            this.log.warn('school: report not written: ' + e.message);
        }
    }

    async report(m, env, schools) {
        const id = String(m.entity_id);
        const career = await this.d.game.soft('entity_reflect', { entity_id: id, Component: 'FB2CareerComponent' });
        const slots = career && career.careerSlots;
        if (!slots) return null;
        const slot = slots.school;
        if (!slot || !slot.careerDtId || slot.careerDtId === 'None') return { id, stage: m.age_group, none: true };
        const schoolId = slot.careerEntityId && slot.careerEntityId.value;
        if (schoolId && !schools.has(schoolId)) schools.set(schoolId, this.d.game.soft('entity_reflect', { entity_id: String(schoolId) }));
        const [row, school] = await Promise.all([this.row(slot.careerDtId), schoolId ? schools.get(schoolId) : null]);
        const orgs = row && Array.isArray(row.organizations) ? row.organizations : [];
        const org = orgs.find((o) => o && o.jobId === slot.jobDtId) || null;
        const ranks = (org && Array.isArray(org.rankList) ? org.rankList : []).slice().sort((a, b) => a.rank - b.rank);
        const club = slots.club && slots.club.careerDtId && slots.club.careerDtId !== 'None' ? await this.row(slots.club.careerDtId) : null;
        const grads = Array.isArray(career.graduationRecords) ? career.graduationRecords : [];
        const gradRows = await Promise.all(grads.map((g) => this.row(g.careerDtId)));
        const keys = [row && row.displayName, org && org.displayName, club && club.displayName];
        ranks.forEach((k) => keys.push(k.rankName));
        grads.forEach((g, i) => {
            const go = gradRows[i] && Array.isArray(gradRows[i].organizations) ? gradRows[i].organizations.find((o) => o && o.jobId === g.jobId) : null;
            g._org = go;
            if (go) {
                keys.push(go.displayName);
                const rk = (go.rankList || []).find((x) => x.rank === g.achievementRank);
                if (rk) keys.push(rk.rankName);
            }
        });
        const t = await this.text(keys);
        // One school row may hold several (the elementary and high school of one campus): the
        // class's own name is the school's then.
        const schoolName = (orgs.length > 1 && org && t[org.displayName]) || (row && t[row.displayName]) || slot.careerDtId;
        const rep = {
            id, name: fullName(m), firstName: m.first_name || '', gender: m.gender || '',
            stage: m.age_group, stageText: STAGE_TEXT[m.age_group],
            school: schoolName, schoolId: String(schoolId || ''),
            club: club && t[club.displayName] ? t[club.displayName] : '',
            history: grads.map((g) => {
                const rk = g._org ? (g._org.rankList || []).find((x) => x.rank === g.achievementRank) : null;
                return { school: g._org ? t[g._org.displayName] || '' : '', kind: g.educationType || '', grade: rk ? t[rk.rankName] || '' : '' };
            }).filter((g) => g.school),
            mode: 'rank', grade: '', previous: '', weeks: [], current: null, progress: null, attendance: null,
            teacher: null, principal: '', classSize: null, classRank: null, examDay: '',
            hours: org ? { start: hhmm(org.startTime), end: hhmm(org.endTime) } : null
        };
        const evalMap = school && isObject(school.studentEvaluationMap) ? school.studentEvaluationMap : null;
        const ev = evalMap ? evalMap[idKey(id)] : null;
        let section = null;
        let sectionIndex = -1;
        (school && Array.isArray(school.classSections) ? school.classSections : []).forEach((s, i) => {
            if (s && Array.isArray(s.studentIds) && s.studentIds.some((x) => String(x && x.value) === id)) { section = s; sectionIndex = i; }
        });
        let slotsToday = null;
        if (ev) {
            rep.mode = 'weekly';
            rep.grade = gradeText(ev.currentGrade);
            rep.previous = gradeText(ev.previousGrade);
            rep.weeks = (Array.isArray(ev.weeklyHistory) ? ev.weeklyHistory : []).map((w) => ({
                week: w.weekIndex, attendance: w.attendanceScore, participation: w.participationScore, homework: w.homeworkScore,
                exam: w.examScore, relationship: w.relationshipScore, total: w.totalScore, grade: gradeText(w.grade)
            }));
            const days = (Array.isArray(ev.dailyRecords) ? ev.dailyRecords : []).slice(0, 5).map((d, i) => ({
                day: WEEKDAYS[i], attendance: String(d.attendance || 'None'), homework: String(d.homework || 'None'),
                good: Number(d.positiveRelationEvents) || 0, bad: Number(d.negativeRelationEvents) || 0
            }));
            const hw = school.studentHomeworkMap && school.studentHomeworkMap[idKey(id)];
            rep.current = {
                days,
                morning: ev.bAttendedMorningExam ? Number(ev.lastExamScoreMorning) || 0 : null,
                afternoon: ev.bAttendedAfternoonExam ? Number(ev.lastExamScoreAfternoon) || 0 : null,
                lastMorning: Number(ev.lastExamScoreMorning) || 0,
                lastAfternoon: Number(ev.lastExamScoreAfternoon) || 0,
                hadExam: !!ev.bHadExamThisCareer,
                prep: typeof career.examPreparation === 'number' ? Math.round(career.examPreparation) : null,
                demerit: school.studentDemeritMap ? Number(school.studentDemeritMap[idKey(id)]) || 0 : 0,
                counseling: !!ev.bHadCounseling,
                homeworkDue: !!(hw && hw.homeworkObjectId && Number(hw.homeworkObjectId.value) > 0)
            };
            rep.examDay = String(school.examDayOfWeek || '');
            rep.principal = await this.personName(school.principalId && school.principalId.value);
            if (section) {
                rep.classSize = section.studentIds.length;
                const tid = section.teacherId && section.teacherId.value;
                const tname = await this.personName(tid);
                if (tname) rep.teacher = { id: String(tid), name: tname, real: true };
                // Rank in the class by the last finished week, among those who have one.
                const totals = section.studentIds.map((x) => {
                    const e = evalMap[idKey(x && x.value)];
                    const h = e && Array.isArray(e.weeklyHistory) && e.weeklyHistory.length ? e.weeklyHistory[e.weeklyHistory.length - 1] : null;
                    return { id: String(x && x.value), total: h ? Number(h.totalScore) || 0 : null };
                }).filter((x) => x.total !== null);
                const mine = totals.find((x) => x.id === id);
                if (mine) rep.classRank = { rank: 1 + totals.filter((x) => x.total > mine.total).length, of: totals.length };
            }
            const studio = (Array.isArray(school.scheduleStudioDatas) ? school.scheduleStudioDatas : [])
                .find((s) => s && s.schoolScheduleType === 'School_Class' && s.classIndex === sectionIndex);
            slotsToday = studio && Array.isArray(studio.scheduleSlots) ? studio.scheduleSlots : null;
        } else {
            // The grade is the rank: its name says it (F, C, B, A, A+).
            const info = school && school.memberInfo ? school.memberInfo[idKey(id)] : null;
            const rank = Number(info ? info.rank : slot.rank) || 0;
            const exp = Number(info ? info.exp : slot.exp) || 0;
            const cur = ranks.find((x) => x.rank === rank) || null;
            const next = ranks.find((x) => x.rank === rank + 1) || null;
            rep.grade = cur ? t[cur.rankName] || '' : '';
            rep.ladder = ranks.map((x) => t[x.rankName] || String(x.rank));
            rep.progress = { rank, exp, from: cur ? Number(cur.requireTotalExp) || 0 : 0, to: next ? Number(next.requireTotalExp) || 0 : exp, next: next ? t[next.rankName] || '' : '' };
            if (info) {
                rep.attendance = { days: Number(info.attendanceDays) || 0, unexcused: Number(info.unexcusedAbsenceCount) || 0, absentRun: Number(info.consecutiveAbsenceDays) || 0 };
                // Where the student stands in the school by the way to the next grade.
                // One school entity may hold several stages (elementary and high school of a campus).
                const all = Object.keys(school.memberInfo).map((k) => school.memberInfo[k])
                    .filter((x) => x && x.jobId === slot.jobDtId).map((x) => Number(x.exp) || 0);
                rep.classRank = { rank: 1 + all.filter((x) => x > exp).length, of: all.length, school: true };
            }
        }
        // Made here, fixed by who the student is.
        const cls = this.d.classGroup && this.d.classGroup.state && this.d.classGroup.state.byPlayer[id];
        rep.className = cls && !cls.closed && cls.stage === m.age_group && cls.name ? cls.name
            : className(m) || ((['一', '二', '三', '四', '五', '六'][hash('grade:' + id) % 6]) + '年级(' + ((hash('class:' + id) % 9) + 1) + ')班');
        const seed = slot.careerDtId + ':' + rep.className + ':' + (sectionIndex >= 0 ? sectionIndex : id);
        if (!rep.teacher) rep.teacher = { id: '', name: pick(SURNAMES, seeded('teacher:' + seed)) + '老师', real: false };
        const per = periods(slotsToday, org ? Number(org.startTime) : 0, org ? Number(org.endTime) : 0);
        const tt = timetable(m.age_group, seed, per, rep.examDay, rep.teacher.real ? rep.teacher.name : '');
        rep.teacher.subject = tt.homeroom;
        rep.timetable = { periods: per, days: tt.days, teachers: tt.teachers };
        // Today's slots of the game's own timetable for the student's class: what is on and in
        // which room (a classroom, or the lab, gym, art or craft room). Read by ielts.js.
        rep.slots = (slotsToday || []).map((s) => {
            const acts = Array.isArray(s.roleActions) ? s.roleActions : [];
            const mine = acts.find((a) => /Student$/.test(String(a.roleId || ''))) || acts.find((a) => /Teacher$/.test(String(a.roleId || ''))) || {};
            return { start: hhmm(s.startHHMM), end: hhmm(s.endHHMM), phase: String(s.phase || ''), activity: String(s.activityId || ''), room: String(mine.roomPurposeId || '') };
        });
        rep.weeks.forEach((w) => { w.papers = papers(m.age_group, id, w.week); });
        if (rep.current) rep.current.papers = papers(m.age_group, id, (rep.weeks.length ? rep.weeks[rep.weeks.length - 1].week : 0) + 1);
        rep.remark = remark(rep);
        rep.tone = tone(rep.grade);
        return rep;
    }
}

module.exports = { School, remark, timetable, periods, papers, seeded, gradeText };
