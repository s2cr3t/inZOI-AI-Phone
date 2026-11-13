    // ------------------------------------------------------------------
    // 成绩: a school app the way a real campus app looks (the school's badge and name on top, the
    // report card, the week's timetable, the class teacher's remarks). ui/phone/school/report.cfg
    // is written by the reply service (lib/school.js) from the game's own school records: grades,
    // weekly scores, exams, attendance and homework are the game's; the subjects, the subject
    // teachers other than the class teacher, and the remarks' wording are made there, fixed per
    // student. The phone only reads it.
    // ------------------------------------------------------------------
    var SC_SECTION = 'ui/phone/school';
    var SC_STAGES = { Child: '小学', LowTeen: '初中', HighTeen: '高中' };
    var SC_TABS = [{ id: 'grades', text: '成绩' }, { id: 'table', text: '课表' }, { id: 'remark', text: '评语' }];
    var SC_DAY = { Monday: '周一', Tuesday: '周二', Wednesday: '周三', Thursday: '周四', Friday: '周五', Saturday: '周六', Sunday: '周日' };
    var SC_PARTS = [
        { key: 'attendance', text: '出勤', max: 15, color: '#34C759' },
        { key: 'participation', text: '课堂表现', max: 25, color: '#2F80ED' },
        { key: 'homework', text: '作业', max: 20, color: '#F2994A' },
        { key: 'exam', text: '考试', max: 40, color: '#9B51E0' }
    ];
    var scMemberId = null;
    var scTab = 'grades';
    // The week shown on the report card: 0 is this week, else a finished week's weekIndex.
    var scWeek = 0;

    function loadSchool() {
        return Promise.all([getMembers(), soft(getPossessedId()), loadPortraitIndex(), cfgValue(SC_SECTION, 'report'),
            cfgValue(SC_SECTION, 'ielts'), cfgValue(SC_SECTION, 'ielts-exam'), soft(loadStudySettings())]).then(function (r) {
            var played = r[1] && !r[1].error ? String(r[1]) : '';
            var students = (r[0] || []).filter(function (m) { return !!SC_STAGES[m.age_group]; });
            var report = r[3] && r[3].byId && typeof r[3].byId === 'object' ? r[3] : null;
            if (!memberById(students, scMemberId)) {
                scMemberId = memberById(students, played) ? played : students.length ? String(students[0].entity_id) : null;
                scWeek = 0;
            }
            var member = memberById(students, scMemberId);
            var notes = r[4] && r[4].byId && typeof r[4].byId === 'object' ? r[4].byId : {};
            var exam = r[5] && r[5].exam && typeof r[5].exam === 'object' ? r[5].exam : null;
            return { played: played, students: students, member: member, file: report,
                rep: member && report ? report.byId[String(member.entity_id)] || null : null,
                study: member ? notes[String(member.entity_id)] || null : null,
                exam: member && exam && String(exam.student) === String(member.entity_id) ? exam : null };
        });
    }

    // The report of the student on the page now, looked up when a tap lands: the page's buttons
    // outlive the data they were drawn from (morph keeps unchanged nodes).
    function scSwitch(id) {
        if (String(id) === String(scMemberId)) return;
        scMemberId = String(id);
        scWeek = 0;
        refresh();
    }

    function scGradeCls(letter) {
        if (letter === 'A+' || letter === 'A') return 'good';
        if (letter === 'B') return 'ok';
        if (letter === 'C') return 'warn';
        if (letter === 'D' || letter === 'F') return 'bad';
        return 'none';
    }

    function scCard(title, extra) {
        var c = node('div', 'sc-card');
        if (title) {
            var head = c.appendChild(node('div', 'sc-card-head'));
            head.appendChild(node('div', 'sc-card-bar'));
            head.appendChild(node('div', 'sc-card-title', title));
            if (extra) head.appendChild(node('div', 'sc-card-extra', extra));
        }
        return c;
    }

    function scBar(value, max, color) {
        var b = node('div', 'sc-bar');
        var f = b.appendChild(node('div', 'sc-bar-fill'));
        f.style.width = clampPct(max > 0 ? value / max * 100 : 0) + '%';
        f.style.background = color;
        return b;
    }

    // The school's letterhead: badge, name, term, and the student's card under it.
    function scBanner(data) {
        var rep = data.rep;
        var m = data.member;
        var b = node('div', 'sc-banner sc-' + (m.age_group === 'Child' ? 'kid' : 'teen'));
        var top = b.appendChild(node('div', 'sc-banner-top'));
        var badge = top.appendChild(node('div', 'sc-crest'));
        badge.appendChild(node('div', 'sc-crest-ring'));
        badge.appendChild(node('div', 'sc-crest-char', (rep && rep.school ? rep.school : '校').charAt(0)));
        var names = top.appendChild(node('div', 'sc-banner-names'));
        names.appendChild(node('div', 'sc-school', rep && rep.school ? rep.school : SC_STAGES[m.age_group]));
        names.appendChild(node('div', 'sc-term', [data.file && data.file.term, rep && rep.weeks && rep.weeks.length ? '第 ' + (rep.weeks[rep.weeks.length - 1].week + 1) + ' 周' : ''].filter(Boolean).join(' · ') || '智慧校园'));
        top.appendChild(node('div', 'sc-portal', String(m.entity_id) === data.played ? '学生端' : '家长端'));
        var me = b.appendChild(node('div', 'sc-student'));
        me.appendChild(faceAvatar(m));
        var who = me.appendChild(node('div', 'sc-student-who'));
        who.appendChild(node('div', 'sc-student-name', fullName(m)));
        who.appendChild(node('div', 'sc-student-sub', [rep && rep.className, '学号 ' + m.entity_id].filter(Boolean).join(' · ')));
        if (data.students.length > 1) {
            var row = me.appendChild(node('div', 'sc-kids'));
            data.students.forEach(function (s) {
                var id = String(s.entity_id);
                if (id === String(m.entity_id)) return;
                var face = faceAvatar(s);
                face.className += ' sc-kid';
                onTap(face, function (e) {
                    e.stopPropagation();
                    scSwitch(id);
                });
                row.appendChild(face);
            });
        }
        return b;
    }

    function scTabs(withStudy) {
        var row = node('div', 'sc-tabs');
        SC_TABS.concat(withStudy ? [{ id: 'study', text: '雅思' }] : []).forEach(function (t) {
            var tab = row.appendChild(node('div', 'sc-tab' + (scTab === t.id ? ' on' : ''), t.text));
            var id = t.id;
            onTap(tab, function (e) {
                e.stopPropagation();
                if (scTab === id) return;
                scTab = id;
                refresh();
            });
        });
        return row;
    }

    function scStamp(letter, label) {
        var s = node('div', 'sc-stamp ' + scGradeCls(letter));
        s.appendChild(node('div', 'sc-stamp-letter', letter || '—'));
        s.appendChild(node('div', 'sc-stamp-label', label));
        return s;
    }

    function scKpi(value, label, cls) {
        var k = node('div', 'sc-kpi');
        k.appendChild(node('div', 'sc-kpi-val' + (cls ? ' ' + cls : ''), value));
        k.appendChild(node('div', 'sc-kpi-label', label));
        return k;
    }

    // ---------- elementary: the grade ladder, the way to the next grade, little red flowers ----------
    function scKidGrades(wrap, rep) {
        var c = wrap.appendChild(scCard('本学期成绩', '来自学校'));
        var row = c.appendChild(node('div', 'sc-kid-row'));
        row.appendChild(scStamp(rep.grade, '综合等级'));
        var side = row.appendChild(node('div', 'sc-kid-side'));
        var ladder = side.appendChild(node('div', 'sc-ladder'));
        (rep.ladder || []).forEach(function (g) {
            ladder.appendChild(node('div', 'sc-step' + (g === rep.grade ? ' on ' + scGradeCls(g) : ''), g));
        });
        var p = rep.progress;
        if (p) {
            var head = side.appendChild(node('div', 'sc-line'));
            head.appendChild(node('span', 'sc-line-label', p.next ? '升到 ' + p.next + ' 的达成度' : '已经是最高等级'));
            head.appendChild(node('span', 'sc-line-num', p.next ? p.exp + ' / ' + p.to : String(p.exp)));
            side.appendChild(scBar(p.next ? p.exp - p.from : 1, p.next ? p.to - p.from : 1, '#FF9F0A'));
        }
        var a = rep.attendance;
        var kpis = c.appendChild(node('div', 'sc-kpis'));
        kpis.appendChild(scKpi(a ? String(a.days) : '-', '出勤天数'));
        kpis.appendChild(scKpi(a ? String(a.unexcused) : '-', '无故缺课', a && a.unexcused ? 'bad' : ''));
        kpis.appendChild(scKpi(rep.classRank ? rep.classRank.rank + '/' + rep.classRank.of : '-', '达成度排名'));
        // One flower for each day at school this term, at most ten: the game's attendance days.
        var f = wrap.appendChild(scCard('小红花', a ? '共 ' + a.days + ' 朵' : ''));
        var flowers = f.appendChild(node('div', 'sc-flowers'));
        var n = a ? Math.min(10, a.days) : 0;
        for (var i = 0; i < 10; i++) flowers.appendChild(node('div', 'sc-flower' + (i < n ? ' on' : ''), i < n ? '✿' : '·'));
        f.appendChild(node('div', 'sc-caption', n ? '每按时上一天学，就得一朵小红花。' : '按时上学就能得到小红花。'));
    }

    // ---------- middle and high school: this week, the weeks before, the exams ----------
    function scWeekChips(rep) {
        var weeks = (rep.weeks || []).slice(-3).reverse();
        var row = node('div', 'sc-weeks');
        var list = [{ id: 0, text: '本周' }].concat(weeks.map(function (w) { return { id: w.week, text: '第' + w.week + '周' }; }));
        list.forEach(function (x) {
            var chip = row.appendChild(node('div', 'sc-week' + (scWeek === x.id ? ' on' : ''), x.text));
            var id = x.id;
            onTap(chip, function (e) {
                e.stopPropagation();
                if (scWeek === id) return;
                scWeek = id;
                refresh();
            });
        });
        for (var i = list.length; i < 4; i++) row.appendChild(node('div', 'sc-week blank'));
        return row;
    }

    function scPaper(label, subject, score, note) {
        var p = node('div', 'sc-paper');
        var head = p.appendChild(node('div', 'sc-line'));
        head.appendChild(node('span', 'sc-line-label', label + ' · ' + subject));
        head.appendChild(node('span', 'sc-line-num', score === null ? note : score + ' / 20'));
        p.appendChild(scBar(score === null ? 0 : score, 20, score !== null && score >= 16 ? '#34C759' : score !== null && score >= 10 ? '#2F80ED' : '#FF9F0A'));
        return p;
    }

    function scThisWeek(c, rep) {
        var cur = rep.current || {};
        var days = cur.days || [];
        var grid = c.appendChild(node('div', 'sc-att'));
        days.forEach(function (d) {
            var cell = grid.appendChild(node('div', 'sc-att-day' + (d.day === rep.today ? ' today' : '')));
            cell.appendChild(node('div', 'sc-att-name', (SC_DAY[d.day] || '').slice(1)));
            var came = d.attendance === 'Normal' || d.attendance === 'Late';
            cell.appendChild(node('div', 'sc-att-dot' + (came ? ' on' : d.attendance === 'None' ? '' : ' bad'), came ? (d.attendance === 'Late' ? '迟' : '到') : d.attendance === 'None' ? '—' : '缺'));
            cell.appendChild(node('div', 'sc-att-hw' + (d.homework === 'Completed' ? ' on' : ''), d.homework === 'Completed' ? '作业✓' : '作业 -'));
        });
        var papers = cur.papers || ['', ''];
        var exam = rep.examDay ? (SC_DAY[rep.examDay] || '') : '';
        c.appendChild(node('div', 'sc-sub-title', '本周考试' + (exam ? '（' + exam + '）' : '')));
        c.appendChild(scPaper('上午场', papers[0], cur.morning, '未考'));
        c.appendChild(scPaper('下午场', papers[1], cur.afternoon, '未考'));
        if (cur.homeworkDue) c.appendChild(node('div', 'sc-note warn', '有一份作业还没交，记得带去学校。'));
        c.appendChild(node('div', 'sc-caption', '本周的等级在周末评定后公布。'));
    }

    function scPastWeek(c, w) {
        var row = c.appendChild(node('div', 'sc-kid-row'));
        row.appendChild(scStamp(w.grade, '第' + w.week + '周'));
        var side = row.appendChild(node('div', 'sc-kid-side'));
        var total = side.appendChild(node('div', 'sc-total'));
        total.appendChild(node('span', 'sc-total-num', String(w.total)));
        total.appendChild(node('span', 'sc-total-of', ' / 100 分'));
        SC_PARTS.forEach(function (p) {
            var head = side.appendChild(node('div', 'sc-line'));
            head.appendChild(node('span', 'sc-line-label', p.text + (p.key === 'exam' && w.papers ? '（' + w.papers.join('、') + '）' : '')));
            head.appendChild(node('span', 'sc-line-num', w[p.key] + ' / ' + p.max));
            side.appendChild(scBar(w[p.key], p.max, p.color));
        });
        if (w.relationship) c.appendChild(node('div', 'sc-note ' + (w.relationship > 0 ? 'good' : 'warn'), '同学关系 ' + (w.relationship > 0 ? '+' : '') + w.relationship));
    }

    function scTeenGrades(wrap, rep) {
        var top = wrap.appendChild(scCard('成绩总览', rep.stageText));
        var kpis = top.appendChild(node('div', 'sc-kpis'));
        kpis.appendChild(scKpi(rep.grade || '评定中', '当前等级', scGradeCls(rep.grade)));
        kpis.appendChild(scKpi(rep.previous || '-', '上次等级', scGradeCls(rep.previous)));
        kpis.appendChild(scKpi(rep.classRank ? rep.classRank.rank + '/' + rep.classRank.of : '-', '班级排名'));
        kpis.appendChild(scKpi(rep.current && rep.mode === 'weekly' ? String(rep.current.demerit) : '-', '纪律扣分', rep.current && rep.current.demerit >= 30 ? 'bad' : ''));
        if (rep.current && rep.current.prep !== null && rep.current.prep !== undefined) {
            var head = top.appendChild(node('div', 'sc-line'));
            head.appendChild(node('span', 'sc-line-label', '备考进度'));
            head.appendChild(node('span', 'sc-line-num', rep.current.prep + '%'));
            top.appendChild(scBar(rep.current.prep, 100, '#9B51E0'));
        }
        if (rep.mode !== 'weekly') {
            // A school off the lot keeps only the grade and the way to the next one.
            scKidGrades(wrap, rep);
            return;
        }
        var c = wrap.appendChild(scCard('成绩单', '周评定'));
        c.appendChild(scWeekChips(rep));
        var w = null;
        (rep.weeks || []).forEach(function (x) { if (x.week === scWeek) w = x; });
        if (scWeek && w) scPastWeek(c, w);
        else scThisWeek(c, rep);
    }

    // ---------- the timetable ----------
    function scTable(wrap, data) {
        var rep = data.rep;
        var tt = rep.timetable || { periods: [], days: [] };
        var today = data.file && data.file.today;
        var c = wrap.appendChild(scCard('本周课表', rep.hours ? rep.hours.start + '–' + rep.hours.end : ''));
        var head = c.appendChild(node('div', 'sc-tt-row head'));
        head.appendChild(node('div', 'sc-tt-time', ''));
        tt.days.forEach(function (d) { head.appendChild(node('div', 'sc-tt-cell head' + (d.day === today ? ' today' : ''), SC_DAY[d.day] || d.day)); });
        var papers = rep.current && rep.current.papers ? rep.current.papers : ['', ''];
        var lesson = 0;
        tt.periods.forEach(function (p) {
            var row = c.appendChild(node('div', 'sc-tt-row' + (p.kind !== 'lesson' ? ' ' + p.kind : '')));
            var time = row.appendChild(node('div', 'sc-tt-time'));
            time.appendChild(node('div', 'sc-tt-label', p.label));
            time.appendChild(node('div', 'sc-tt-hour', p.start));
            if (p.kind !== 'lesson') {
                row.appendChild(node('div', 'sc-tt-span', p.kind === 'lunch' ? '午餐 · 午休' : '早自习 · 自由活动'));
                return;
            }
            var i = lesson++;
            tt.days.forEach(function (d) {
                var text = d.cells[i] || '';
                var exam = d.exam;
                var cell = row.appendChild(node('div', 'sc-tt-cell' + (exam ? ' exam' : '') + (d.day === today ? ' today' : '')));
                cell.appendChild(node('div', 'sc-tt-subject', exam ? '考试' : text));
                if (exam) cell.appendChild(node('div', 'sc-tt-teacher', p.block === 'pm' ? papers[1] : papers[0]));
            });
        });
        if (rep.club) c.appendChild(node('div', 'sc-note', '社团：' + rep.club));
        var t = wrap.appendChild(scCard('任课老师'));
        var names = Object.keys(tt.teachers || {});
        for (var k = 0; k < names.length; k += 2) {
            var line = t.appendChild(node('div', 'sc-teach-row'));
            for (var j = k; j < k + 2; j++) {
                var cell = line.appendChild(node('div', 'sc-teach'));
                if (j >= names.length) continue;
                cell.appendChild(node('span', 'sc-teach-subject', names[j]));
                cell.appendChild(node('span', 'sc-teach-name', tt.teachers[names[j]] + (names[j] === rep.teacher.subject ? '（班主任）' : '')));
            }
        }
    }

    // ---------- the class teacher's remarks ----------
    function scRemark(wrap, rep) {
        var c = wrap.appendChild(scCard('班主任评语'));
        var who = c.appendChild(node('div', 'sc-teacher'));
        who.appendChild(node('div', 'sc-teacher-face', rep.teacher.name.charAt(0)));
        var n = who.appendChild(node('div', 'sc-teacher-who'));
        n.appendChild(node('div', 'sc-teacher-name', rep.teacher.name));
        n.appendChild(node('div', 'sc-teacher-sub', '班主任 · ' + rep.teacher.subject + (rep.classSize ? ' · 全班 ' + rep.classSize + ' 人' : '')));
        var text = c.appendChild(node('div', 'sc-remark', (rep.remark && rep.remark.text) || '还没有评语。'));
        text.setAttribute('role', 'note');
        var tags = (rep.remark && rep.remark.tags) || [];
        for (var i = 0; i < tags.length; i += 3) {
            var row = c.appendChild(node('div', 'sc-tag-row'));
            for (var j = i; j < i + 3; j++) {
                if (j < tags.length) row.appendChild(node('div', 'sc-tag ' + (tags[j].tone || 'plain'), tags[j].text));
                else row.appendChild(node('div', 'sc-tag blank'));
            }
        }
        if (rep.principal) c.appendChild(node('div', 'sc-caption', '校长：' + rep.principal));
        var h = rep.history || [];
        if (h.length) {
            var arc = wrap.appendChild(scCard('学籍档案'));
            h.forEach(function (x) {
                var line = arc.appendChild(node('div', 'sc-arc'));
                line.appendChild(node('div', 'sc-arc-school', x.school));
                line.appendChild(node('div', 'sc-arc-state', '已毕业'));
                line.appendChild(node('div', 'sc-arc-grade ' + scGradeCls(x.grade), x.grade || '-'));
            });
            var now = arc.appendChild(node('div', 'sc-arc'));
            now.appendChild(node('div', 'sc-arc-school', rep.school));
            now.appendChild(node('div', 'sc-arc-state', '在读'));
            now.appendChild(node('div', 'sc-arc-grade ' + scGradeCls(rep.grade), rep.grade || '…'));
        }
    }

    function scEmpty(wrap, text, sub) {
        var c = wrap.appendChild(node('div', 'sc-card sc-empty'));
        var crest = c.appendChild(node('div', 'sc-crest big'));
        crest.appendChild(node('div', 'sc-crest-ring'));
        crest.appendChild(node('div', 'sc-crest-char', '学'));
        c.appendChild(node('div', 'sc-empty-title', text));
        if (sub) c.appendChild(node('div', 'sc-empty-sub', sub));
        return wrap;
    }

    function renderSchool(data) {
        var wrap = node('div', 'sc-screen');
        wrap.appendChild(subHeader('school'));
        if (!data.students.length) return scEmpty(wrap, '家里没有在上学的孩子', '小学、初中和高中的学生可以在这里看成绩、课表和老师的评语。');
        var m = data.member;
        wrap.appendChild(scBanner(data));
        var rep = data.rep;
        if (!rep) return scEmpty(wrap, '成绩单还没同步', '回复服务每分钟从学校取一次' + fullName(m) + '的成绩，稍等一会儿再看。');
        if (rep.none) return scEmpty(wrap, fullName(m) + '现在没有学籍', '入学以后，成绩、课表和评语会出现在这里。');
        rep.today = data.file && data.file.today;
        var withStudy = (m.age_group === 'HighTeen' || m.age_group === 'LowTeen') && (studySettings.enabled || !!data.study);
        if (scTab === 'study' && !withStudy) scTab = 'grades';
        wrap.appendChild(scTabs(withStudy));
        if (scTab === 'study') scStudy(wrap, data);
        else if (scTab === 'table') scTable(wrap, data);
        else if (scTab === 'remark') scRemark(wrap, rep);
        else if (m.age_group === 'Child') scKidGrades(wrap, rep);
        else scTeenGrades(wrap, rep);
        return wrap;
    }

    // ---------- 雅思: the lessons' notes, the mistake book, the exams (lib/ielts.js) ----------
    function scStudy(wrap, data) {
        var st = data.study || { lessons: [], mistakes: [], exams: [] };
        var exam = data.exam;
        if (exam && !exam.marked) {
            var e = wrap.appendChild(scCard('今天考试', exam.levelName || ''));
            e.appendChild(node('div', 'sc-note', '雅思试卷 · ' + exam.questions.length + ' 道题，题目来自这一周学过的内容和错题本。答题时游戏会暂停。'));
            var go = e.appendChild(node('button', 'ph-btn sc-exam-go', '开始答题'));
            go.setAttribute('type', 'button');
            onTap(go, function (ev) { ev.stopPropagation(); open('scexam'); });
        }
        if (st.term && st.term.units && st.term.units.length) {
            var doneUnits = 0;
            st.term.units.forEach(function (u) { if (u.done) doneUnits += 1; });
            var tc = wrap.appendChild(scCard('本学期教材', '第 ' + (st.term.no || 1) + ' 学期 · ' + doneUnits + '/' + st.term.units.length));
            var nowShown = false;
            st.term.units.forEach(function (u) {
                var cur = !u.done && !nowShown;
                if (cur) nowShown = true;
                tc.appendChild(node('div', 'sc-study-line' + (u.done ? ' good' : ''), 'Unit ' + u.n + '  ' + u.topic + ' · ' + u.grammar + (u.done ? '  已学完' : cur ? '  ← 正在学' : '')));
            });
        }
        if (st.exams && st.exams.length) {
            var x = wrap.appendChild(scCard('考试记录'));
            st.exams.slice(0, 5).forEach(function (r) {
                var line = x.appendChild(node('div', 'sc-arc'));
                line.appendChild(node('div', 'sc-arc-school', '第 ' + r.day + ' 天 · 雅思试卷'));
                line.appendChild(node('div', 'sc-arc-state', r.score + ' / ' + r.of));
                line.appendChild(node('div', 'sc-arc-grade ' + (r.prep >= 80 ? 'good' : r.prep >= 60 ? 'ok' : 'warn'), r.prep + '%'));
            });
            x.appendChild(node('div', 'sc-caption', '百分比是这次的考前准备度，游戏按它给这次考试打分。'));
        }
        var mk = st.mistakes || [];
        var book = wrap.appendChild(scCard('错题本', mk.length ? mk.length + ' 道' : ''));
        if (!mk.length) book.appendChild(node('div', 'sc-note', '还没有错题。课上答错、考试答错的题会记在这里，下次考试优先再考。'));
        mk.slice(0, 12).forEach(function (q) {
            var it = book.appendChild(node('div', 'sc-study-q'));
            it.appendChild(node('div', 'sc-study-en', q.en + '  ' + q.zh));
            if (q.q) it.appendChild(node('div', 'sc-study-line', q.q));
            if (q.given) it.appendChild(node('div', 'sc-study-line bad', '你的回答：' + q.given));
            if (q.a) it.appendChild(node('div', 'sc-study-line good', '正确答案：' + q.a));
        });
        var ls = st.lessons || [];
        if (!ls.length) {
            var none = wrap.appendChild(scCard('课堂笔记'));
            none.appendChild(node('div', 'sc-note', studySettings.enabled ? '下一节英语课开始后，班主任讲的内容会记在这里。' : '在「设置 → 雅思学习」里打开后，英语课会变成雅思课。'));
            return;
        }
        ls.slice(0, 8).forEach(function (l) {
            var right = 0;
            (l.checks || []).forEach(function (c) { if (c.ok) right += 1; });
            var c = wrap.appendChild(scCard('第 ' + l.day + ' 天 · ' + (l.topic || '英语课'), (l.checks && l.checks.length ? '答对 ' + right + '/' + l.checks.length : '') + (l.done ? '' : ' · 没讲完')));
            (l.points || []).forEach(function (p) {
                var it = c.appendChild(node('div', 'sc-study-q'));
                it.appendChild(node('div', 'sc-study-en', (p.kind === 'grammar' ? '语法 · ' : '') + p.en + '  ' + p.zh));
                if (p.note) it.appendChild(node('div', 'sc-study-line', p.note));
                if (p.example) it.appendChild(node('div', 'sc-study-line ex', p.example));
            });
            if (l.teacher) c.appendChild(node('div', 'sc-caption', '授课：' + l.teacher));
        });
    }

    // ---------- the exam paper ----------
    // The game is paused while it is answered and goes on once it is marked. Written here only:
    // ui/phone/school/ielts-answer.cfg {id, answers: {<n>: text}, at}.
    var scDraft = { id: '', answers: {}, sent: false, paused: false };

    function scExamPause(on) {
        if (scDraft.paused === on) return;
        scDraft.paused = on;
        soft(call(on ? 'environment.pause' : 'environment.resume', {}));
    }

    function renderScExam(data) {
        var wrap = node('div', 'sc-screen');
        wrap.appendChild(subHeader('scexam'));
        var exam = data.exam;
        if (!exam) {
            scExamPause(false);
            return scEmpty(wrap, '现在没有要考的试卷', '考试那天，雅思试卷会出现在这里。');
        }
        if (scDraft.id !== exam.id) scDraft = { id: exam.id, answers: {}, sent: false, paused: scDraft.paused };
        if (exam.marked) {
            scExamPause(false);
            var res = wrap.appendChild(scCard('成绩', exam.levelName || ''));
            var kpis = res.appendChild(node('div', 'sc-kpis'));
            kpis.appendChild(scKpi(exam.score + ' / ' + exam.questions.length, '答对'));
            kpis.appendChild(scKpi(exam.prep + '%', '考前准备度', exam.prep >= 80 ? 'good' : exam.prep >= 60 ? 'ok' : 'warn'));
            res.appendChild(node('div', 'sc-note', '准备度已经交给游戏，这次考试按它打分。答错的题进了错题本。'));
            (exam.questions || []).forEach(function (q) {
                var r = (exam.results || []).filter(function (x) { return x.n === q.n; })[0] || {};
                var it = wrap.appendChild(scCard(q.n + '. ' + (r.correct ? '✓ 答对' : '✗ 答错')));
                it.appendChild(node('div', 'sc-study-line', q.question));
                it.appendChild(node('div', 'sc-study-line ' + (r.correct ? 'good' : 'bad'), '你的回答：' + (r.given || '（没写）')));
                if (r.why) it.appendChild(node('div', 'sc-study-line', r.why));
            });
            return wrap;
        }
        scExamPause(true);
        var head = wrap.appendChild(scCard('雅思试卷', exam.levelName || ''));
        head.appendChild(node('div', 'sc-note', scDraft.sent ? '已交卷，正在批改…' : '共 ' + exam.questions.length + ' 题。填空和选择写答案即可，造句和翻译写完整的句子。游戏已暂停。'));
        exam.questions.forEach(function (q) {
            var c = wrap.appendChild(scCard(q.n + '.'));
            c.appendChild(node('div', 'sc-study-line', q.question));
            var long = q.type === 'make' || q.type === 'translate';
            var box = c.appendChild(node(long ? 'textarea' : 'input', 'sc-exam-box'));
            if (!long) box.setAttribute('type', 'text');
            box.setAttribute('maxlength', '200');
            box.value = scDraft.answers[q.n] || '';
            if (scDraft.sent) box.setAttribute('disabled', 'disabled');
            var n = q.n;
            box.addEventListener('input', function () { scDraft.answers[n] = box.value; });
        });
        var submit = wrap.appendChild(node('button', 'ph-btn sc-exam-go' + (scDraft.sent ? ' off' : ''), scDraft.sent ? '批改中…' : '交卷'));
        submit.setAttribute('type', 'button');
        onTap(submit, function (ev) {
            ev.stopPropagation();
            if (scDraft.sent) return;
            scDraft.sent = true;
            soft(call('uimod.cfg_save', { mod_id: SMS_MOD, section: SC_SECTION, key: 'ielts-answer', value: JSON.stringify({ id: scDraft.id, answers: scDraft.answers, at: Date.now() }) }));
            refresh();
        });
        return wrap;
    }

    function schoolGlyph() {
        var svg = glyphSvg('0 0 24 24');
        glyphPath(svg, 'M12 3.6L1.8 8.7 12 13.8l8.4-4.2v5.9h1.6V8.7L12 3.6z');
        glyphPath(svg, 'M5.6 12.2v4.1c0 1.9 2.9 3.6 6.4 3.6s6.4-1.7 6.4-3.6v-4.1L12 15.4l-6.4-3.2z');
        return svg;
    }

