'use strict';
// Offline tests for the phone's school app (lib/school.js): the game's school records reach the
// report as they are, and what is made here (timetable, remarks) is the same on every run and
// stands on the real numbers. A fake game; files under a temporary folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { School, remark } = require('../lib/school');

const log = { info() {}, warn() {}, debug() {} };
const WEEK = { weekIndex: 2, attendanceScore: 15, participationScore: 25, homeworkScore: 5, examScore: 22, relationshipScore: 0, totalScore: 67, grade: 'C' };
const days = [['Normal', 'Completed'], ['Normal', 'None'], ['None', 'None'], ['Normal', 'Completed'], ['None', 'None']]
    .map(([a, h]) => ({ attendance: a, homework: h, positiveRelationEvents: 0, negativeRelationEvents: 0 }));
const ranks = (names, step) => names.map((n, i) => ({ rank: i + 1, requireTotalExp: i * step, rankName: 'R_' + n }));
const ROWS = {
    High: { displayName: 'High_Name', organizations: [{ jobId: 'High_Student', displayName: 'High_Org', startTime: 800, endTime: 1600, rankList: ranks(['高中生'], 0) }] },
    Elem: { displayName: 'Campus', organizations: [
        { jobId: 'Elementary', displayName: 'Elem_Org', startTime: 900, endTime: 1400, rankList: ranks(['F', 'C', 'B', 'A', 'A+'], 65) },
        { jobId: 'Upper', displayName: 'Upper_Org', startTime: 900, endTime: 1700, rankList: ranks(['F'], 0) }] }
};
const TEXT = { High_Name: '永成高中', Elem_Org: '世河小学', Campus: 'Seha 学院', 'R_A+': 'A+', R_A: 'A', R_B: 'B', R_C: 'C', R_F: 'F', 'R_高中生': '高中生' };
const ENTITIES = {
    887: {
        classSections: [{ teacherId: { value: 9 }, studentIds: [{ value: 1 }, { value: 3 }] }],
        studentEvaluationMap: {
            '(Value=1)': { dailyRecords: days, lastExamScoreMorning: 18, lastExamScoreAfternoon: 0, bAttendedMorningExam: true, bAttendedAfternoonExam: false,
                weeklyHistory: [Object.assign({}, WEEK, { weekIndex: 1, totalScore: 85, grade: 'A', examScore: 40 }), WEEK], currentGrade: 'C', previousGrade: 'A' },
            '(Value=3)': { dailyRecords: days, weeklyHistory: [Object.assign({}, WEEK, { totalScore: 90, grade: 'A' })], currentGrade: 'A' }
        },
        studentDemeritMap: { '(Value=1)': 10 }, studentHomeworkMap: {}, principalId: { value: 8 }, examDayOfWeek: 'Thursday', scheduleStudioDatas: []
    },
    500: { memberInfo: {
        '(Value=2)': { jobId: 'Elementary', rank: 4, exp: 251, attendanceDays: 4, unexcusedAbsenceCount: 0, consecutiveAbsenceDays: 0 },
        '(Value=40)': { jobId: 'Elementary', rank: 5, exp: 300 },
        '(Value=41)': { jobId: 'Upper', rank: 1, exp: 999 } } }
};
const CAREERS = {
    1: { careerSlots: { school: { careerDtId: 'High', jobDtId: 'High_Student', careerEntityId: { value: 887 }, rank: 1, exp: 65 } }, examPreparation: 100,
        graduationRecords: [{ jobId: 'Elementary', careerDtId: 'Elem', achievementRank: 5 }] },
    2: { careerSlots: { school: { careerDtId: 'Elem', jobDtId: 'Elementary', careerEntityId: { value: 500 }, rank: 4, exp: 251 } } },
    5: { careerSlots: {} }
};
const PEOPLE = { 9: { last_name: '朴', first_name: '承彬' }, 8: { last_name: '张', first_name: '昌允' } };
const MEMBERS = [
    { entity_id: 1, first_name: '亚廷', last_name: '钟', age_group: 'HighTeen' },
    { entity_id: 2, first_name: '子怡', last_name: '宗', age_group: 'Child' },
    { entity_id: 5, first_name: '会荣', last_name: '宗', age_group: 'Youth' }
];

function setup(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'school-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const game = {
        async soft(tool, a) {
            if (tool === 'entity_reflect') return a.Component ? CAREERS[a.entity_id] : ENTITIES[a.entity_id];
            if (tool === 'data_table_get') return ROWS[a.Row];
            if (tool === 'l10n_get') return TEXT;
            if (tool === 'entity_get_character_info') return PEOPLE[a.entity_id] || null;
            if (tool === 'environment_get_state') return { day_of_week: 'Thursday', season: 'Spring', day: 10 };
            return null;
        }
    };
    const world = { phase: async () => 'in_game', household: async () => ({ members: MEMBERS }), cached: (k, ms, fn) => fn() };
    const s = new School({ log, game, world });
    s.configure(root);
    return { s, file: path.join(root, 'school', 'report.cfg') };
}

test('the report card carries the game\'s school records for both stages', async (t) => {
    const { s, file } = setup(t);
    await s.sync();
    const out = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(out.term, '春季学期');
    assert.deepEqual(Object.keys(out.byId).sort(), ['1', '2']);
    const hi = out.byId[1];
    assert.equal(hi.school, '永成高中');
    assert.equal(hi.mode, 'weekly');
    assert.equal(hi.grade, 'C');
    assert.deepEqual(hi.weeks.map((w) => [w.week, w.total, w.grade]), [[1, 85, 'A'], [2, 67, 'C']]);
    assert.equal(hi.current.morning, 18);
    assert.equal(hi.current.afternoon, null);
    assert.deepEqual(hi.teacher, { id: '9', name: '朴承彬', real: true, subject: hi.teacher.subject });
    assert.equal(hi.principal, '张昌允');
    assert.deepEqual(hi.classRank, { rank: 2, of: 2 });
    assert.deepEqual(hi.history, [{ school: '世河小学', kind: '', grade: 'A+' }]);
    assert.ok(hi.timetable.days.find((d) => d.day === 'Thursday').exam);
    const kid = out.byId[2];
    assert.equal(kid.school, '世河小学');
    assert.equal(kid.mode, 'rank');
    assert.equal(kid.grade, 'A');
    assert.deepEqual(kid.progress, { rank: 4, exp: 251, from: 195, to: 260, next: 'A+' });
    // Ranked among the elementary pupils only, not the upper school in the same entity.
    assert.deepEqual(kid.classRank, { rank: 2, of: 2, school: true });
    assert.equal(kid.teacher.real, false);
});

test('what is made here is fixed per student and stands on the real numbers', async (t) => {
    const a = setup(t);
    await a.s.sync();
    const first = JSON.parse(fs.readFileSync(a.file, 'utf8')).byId;
    const b = setup(t);
    await b.s.sync();
    const second = JSON.parse(fs.readFileSync(b.file, 'utf8')).byId;
    for (const id of ['1', '2']) {
        assert.deepEqual(second[id].timetable, first[id].timetable);
        assert.deepEqual(second[id].remark, first[id].remark);
        assert.equal(second[id].className, first[id].className);
    }
    // The fall from 85 to 67 and the homework score are what the remark says.
    assert.match(first[1].remark.text, /85.*67|18/);
    assert.ok(first[1].remark.tags.some((x) => x.text === '作业欠交'));
    assert.match(first[2].remark.text, /251|260|A\+/);
    assert.equal(remark(Object.assign({}, first[1], { weeks: [] })).tags.some((x) => x.text === '作业欠交'), false);
});
