    // ------------------------------------------------------------------
    // OA: a workplace app laid out like a company's own (attendance, figures, notices, the
    // workbench, approvals), filled from the game's career data.
    // The member's career slot (FB2CareerComponent) names the company entity; its memberInfo
    // holds everyone on the payroll with rank, exp, evaluation, attendance and leave left, and the
    // Career table row holds the rank ladder (exp needed, pay a day, leave a year). The boss is
    // the colleague with the highest rank above the member's own.
    //
    // Requests (leave, sick leave, remote work, promotion, resignation) are filled in on the
    // approval form, kept as records and sent to the boss as a text. Files:
    //   ui/phone/saved  oa-requests  the records. Phone only: { v, list: [{ id, member, kind,
    //                   days, reason, text, boss, bossName, day, time, at, status }] },
    //                   status pending | withdrawn.
    //   ui/phone/oa     decisions    the boss's answers and how carrying them out in the game
    //                   went. Reply service only (lib/career.js):
    //                   { v, byId: { <request id>: { status: approved | rejected, note, at, day, days,
    //                     effect: { state: applying | done | failed | unsupported, text } } } }.
    // A decision outranks the record's own status; a withdrawn request takes none.
    // ------------------------------------------------------------------
    var oaMemberId = null;
    var oaApplyKind = 'leave';
    var oaApplyDays = 1;
    var oaApplyReason = 0;
    var oaNameCache = {};
    var oaRequests = null;
    // How each colleague sees the member (ui/phone/oa/impressions.cfg, written by the reply
    // service's workplace.js): { <member>-<colleague>: { score, label, style, styleName, events } }.
    var oaImpressions = {};
    // The tasks bosses handed out (ui/phone/oa/tasks.cfg, written by workgroup.js).
    var oaTasks = [];
    // Members whose job has no tasks a boss can hand out (the work is the shift itself).
    var oaTasksNone = [];
    var OA_TASK_STATE = {
        offered: { text: '待认领', cls: 'oa-tag' },
        given: { text: '进行中', cls: 'pill-move' },
        handed: { text: '交给别人了', cls: 'pill-idle' },
        lapsed: { text: '没人接', cls: 'pill-idle' },
        declined: { text: '没接', cls: 'pill-idle' },
        done: { text: '已完成', cls: 'pill-work' },
        missed: { text: '未完成', cls: 'pill-late' },
        // An optional task left undone.
        skipped: { text: '没做', cls: 'pill-idle' }
    };
    var OA_REQ_KEY = 'oa-requests';
    var OA_SECTION = 'ui/phone/oa';
    var OA_REQ_MAX = 40;
    var OA_REQ_SHOWN = 5;
    var OA_TEAM_MAX = 12;
    var OA_SICK_DAYS_MAX = 3;
    // Below this evaluation a boss is unlikely to hear of a promotion. A hint, not a game rule.
    var OA_GOOD_EVALUATION = 60;
    var OA_GRADES = [{ min: 90, g: 'S', tone: 'good' }, { min: 75, g: 'A', tone: 'good' }, { min: 60, g: 'B', tone: '' },
        { min: 40, g: 'C', tone: 'warn' }, { min: -1000, g: 'D', tone: 'bad' }];
    var OA_KINDS = [
        { id: 'leave', label: '请假', form: '请假申请', mark: '假', color: '#30D158', days: true,
            reasons: ['家里有事', '想休息几天', '出去走走', '陪陪家人'] },
        { id: 'sick', label: '病假', form: '病假申请', mark: '病', color: '#FF375F', days: true,
            reasons: ['发烧了', '身体不太舒服', '要去看医生'] },
        { id: 'remote', label: '远程办公', form: '远程办公申请', mark: '远', color: '#64D2FF',
            reasons: ['家里走不开', '在家效率更高', '身体不便出门'] },
        { id: 'promote', label: '晋升申请', form: '晋升申请', mark: '升', color: '#FF9F0A',
            reasons: ['最近业绩一直不错', '经验已经够了', '想承担更多'] },
        { id: 'resign', label: '离职申请', form: '离职申请', mark: '离', color: '#8E8E93',
            reasons: ['想换个环境', '找到了更好的机会', '想休息一阵'] }
    ];
    var OA_STATUS = {
        pending: { text: '审批中', cls: 'pill-move' },
        approved: { text: '已通过', cls: 'pill-work' },
        rejected: { text: '已驳回', cls: 'pill-late' },
        withdrawn: { text: '已撤回', cls: 'pill-idle' }
    };
    var OA_EFFECT = { applying: 'oa-eff-move', done: 'oa-eff-good', failed: 'oa-eff-bad', unsupported: 'oa-eff-idle' };
    var OA_DAY_NAMES = { Monday: '一', Tuesday: '二', Wednesday: '三', Thursday: '四', Friday: '五', Saturday: '六', Sunday: '日' };
    var OA_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    function oaKind(id) {
        for (var i = 0; i < OA_KINDS.length; i++) if (OA_KINDS[i].id === id) return OA_KINDS[i];
        return OA_KINDS[0];
    }

    function oaGrade(score) {
        for (var i = 0; i < OA_GRADES.length; i++) if (score >= OA_GRADES[i].min) return OA_GRADES[i];
        return OA_GRADES[OA_GRADES.length - 1];
    }

    // memberInfo is keyed by the printed FB1EntityId, "(Value=20522)".
    function oaParseId(key) {
        var m = /(\d+)/.exec(String(key));
        return m ? m[1] : '';
    }

    function oaRankRow(ranks, rank) {
        for (var i = 0; i < ranks.length; i++) if (ranks[i].rank === rank) return ranks[i];
        return null;
    }

    function oaRelStat(rels, id, key) {
        var x = rels[id];
        var s = x && x.stats && x.stats[key];
        return s && typeof s.value === 'number' ? s.value : 0;
    }

    function oaDays(days) {
        if (!days || !days.length) return '不固定';
        if (days.length === 7) return '每天';
        var weekdays = days.length === 5 && WEEKDAYS.every(function (d) { return days.indexOf(d) >= 0; });
        if (weekdays) return '周一至周五';
        return '周' + days.map(function (d) { return OA_DAY_NAMES[d] || d; }).join('、');
    }

    // describe() says it in English for the other apps.
    function oaState(work, sched, env) {
        var s = describe(work, sched, env);
        var text = { 'At work': '上班中', 'Commuting': '通勤中', 'Day off': '休息日', 'Not at work': '未到岗',
            'Off shift': '不在班上', 'Done today': '已下班' }[s.text];
        if (!text && /^Starts /.test(s.text)) text = s.text.slice(7) + ' 上班';
        return { cls: s.cls, text: text || s.text };
    }

    function oaStatusOf(r, decisions) {
        if (r.status === 'withdrawn') return 'withdrawn';
        var d = decisions[r.id];
        return d && OA_STATUS[d.status] ? d.status : 'pending';
    }

    function loadOa() {
        return Promise.all([getEnv(), getMembers(), soft(getPossessedId()), loadPortraitIndex(),
            cfgValue(SOUND_SECTION, OA_REQ_KEY), cfgValue(OA_SECTION, 'decisions'), cfgValue(OA_SECTION, 'impressions'), cfgValue(OA_SECTION, 'tasks'),
            cfgValue(OA_SECTION, 'company'), cfgValue(SOUND_SECTION, OA_MGMT_KEY)]).then(function (r) {
            oaMgRead(r[8]);
            oaMgReadMine(r[9]);
            var env = r[0];
            var played = r[2] && !r[2].error ? String(r[2]) : '';
            var workers = r[1].filter(function (m) { return !!m.has_career; });
            oaRequests = r[4] && Array.isArray(r[4].list) ? r[4].list : [];
            oaImpressions = r[6] && r[6].byPair && typeof r[6].byPair === 'object' ? r[6].byPair : {};
            oaTasks = r[7] && Array.isArray(r[7].list) ? r[7].list : [];
            oaTasksNone = r[7] && Array.isArray(r[7].none) ? r[7].none.map(String) : [];
            var decisions = r[5] && r[5].byId && typeof r[5].byId === 'object' ? r[5].byId : {};
            // First the played character's job, else the first real job at home: a pupil's desk
            // has nothing on it yet.
            if (!memberById(workers, oaMemberId)) {
                var employed = workers.filter(function (m) { return !!m.job_name; });
                oaMemberId = memberById(employed, played) ? played
                    : employed.length ? String(employed[0].entity_id)
                    : memberById(workers, played) ? played
                    : workers.length ? String(workers[0].entity_id) : null;
            }
            var member = memberById(workers, oaMemberId);
            return Promise.all([
                getWorkStatus(workers),
                Promise.all(workers.map(function (m) { return soft(loadSchedule(m)); })),
                member ? soft(oaLoadDesk(member, played)) : Promise.resolve(null)
            ]).then(function (d) {
                var requests = oaRequests.filter(function (x) { return member && x.member === String(member.entity_id); })
                    .map(function (x) { return { r: x, status: oaStatusOf(x, decisions), decision: decisions[x.id] || null }; });
                requests.sort(function (a, b) { return (b.r.at || 0) - (a.r.at || 0); });
                return { env: env, played: played, workers: workers, work: d[0], schedules: d[1], member: member,
                    desk: d[2], requests: requests };
            });
        });
    }

    function oaImpression(memberId, colleagueId) {
        var e = oaImpressions[String(memberId) + '-' + String(colleagueId)];
        return e && typeof e.score === 'number' ? e : null;
    }

    // 待办: what the boss handed out in the work group, as the game's own after-work missions.
    function oaTaskCard(desk) {
        var mine = oaTasks.filter(function (t) { return t && String(t.member) === String(desk.memberId); }).slice().reverse();
        var c = card('待办');
        if (!mine.length && oaTasksNone.indexOf(String(desk.memberId)) >= 0) {
            c.appendChild(node('div', 'ph-caption', '这份工作的活都在班上，按排班做；上级不会在工作群里另外派任务。'));
            return c;
        }
        if (!mine.length) {
            c.appendChild(node('div', 'ph-caption', '上级会在工作群里问谁来做。你回复「我来」接下以后，任务会出现在游戏的任务栏「工作」里，用电脑做完就算完成。'));
            return c;
        }
        mine.slice(0, 4).forEach(function (t) {
            var row = node('div', 'ph-row oa-req');
            row.appendChild(oaMark('任', '#0A84FF', 'oa-req-mark'));
            var who = node('div', 'ph-who');
            who.appendChild(node('div', 'oa-req-title', String(t.text || '')));
            who.appendChild(node('div', 'ph-sub', [t.optional ? '可选' : '', t.bossName ? t.bossName + (t.state === 'offered' ? ' 在群里问' : ' 派的') : '', typeof t.day === 'number' ? '第 ' + t.day + ' 天' : ''].filter(Boolean).join(' · ')));
            if (t.state === 'offered') who.appendChild(node('div', 'oa-req-note', '在工作群里回复「我来」就能接下；不想接不用理。'));
            if (t.state === 'handed' && t.taker) who.appendChild(node('div', 'oa-req-note', '没人接，交给了' + t.taker + '。'));
            row.appendChild(who);
            var st = OA_TASK_STATE[t.optional && t.state === 'missed' ? 'skipped' : t.state] || OA_TASK_STATE.given;
            row.appendChild(node('span', 'ph-pill ' + st.cls, st.text));
            c.appendChild(row);
        });
        return c;
    }

    // The boss, the kind of boss they are, and what they think of the member and why.
    function oaBossCard(desk) {
        var c = card('我的上级');
        var boss = desk.boss;
        if (!boss) {
            c.appendChild(node('div', 'ph-caption', desk.readable ? '你已经是这里职级最高的人。' : '公司的人员名单读不到。'));
            return c;
        }
        var seen = oaImpression(desk.memberId, boss.id);
        var row = node('div', 'ph-row oa-person');
        row.appendChild(faceAvatar(boss.person));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', fullName(boss.person)));
        who.appendChild(node('div', 'ph-sub', boss.rankName));
        row.appendChild(who);
        if (seen && seen.styleName) row.appendChild(node('span', 'ph-pill oa-style', seen.styleName));
        c.appendChild(row);
        if (!seen) {
            c.appendChild(node('div', 'ph-caption', '还没打过交道。跟上级聊几句、提一次申请，就知道 TA 对你印象如何。'));
            return c;
        }
        var line = node('div', 'oa-progress-head');
        line.appendChild(node('span', null, '对你的印象：' + seen.label));
        line.appendChild(node('span', 'oa-progress-num oa-imp-num', seen.score + ' / 100'));
        c.appendChild(line);
        c.appendChild(bar(seen.score, seen.score >= 65 ? '#30D158' : seen.score >= 45 ? '#0A84FF' : seen.score >= 30 ? '#FF9F0A' : '#FF453A'));
        (Array.isArray(seen.events) ? seen.events : []).slice().reverse().forEach(function (ev) {
            var e = node('div', 'oa-imp-event');
            e.appendChild(node('span', 'oa-imp-delta ' + (ev.delta > 0 ? 'up' : 'down'), (ev.delta > 0 ? '+' : '') + ev.delta));
            e.appendChild(node('span', 'oa-imp-why', ev.why || ''));
            c.appendChild(e);
        });
        return c;
    }

    function oaSaveRequests() {
        return saveJson(OA_REQ_KEY, { v: 1, list: oaRequests.slice(-OA_REQ_MAX) }, SOUND_SECTION);
    }

    // Changes one request by its id in the list as it is now. A row's button cannot hold on to
    // the record it was drawn from: the poll re-reads the list into new objects every few seconds
    // and keeps the unchanged button (morph), so that record is no longer the one that is saved.
    function oaChangeRequest(id, patch) {
        var list = oaRequests || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === id) {
                for (var k in patch) if (patch.hasOwnProperty(k)) list[i][k] = patch[k];
                oaSaveRequests().then(refresh, refresh);
                return;
            }
        }
        setNote('这条申请已经找不到了。', true);
    }

    function oaLoadDesk(member, played) {
        var id = String(member.entity_id);
        return loadCareerSlot(id).then(function (slot) {
            if (!slot) return { none: true };
            var companyId = slot.careerEntityId && slot.careerEntityId.value;
            return Promise.all([
                loadCareerRow(slot.careerDtId),
                companyId ? soft(call('entity.reflect', { entity_id: String(companyId) }, 'memberInfo')) : Promise.resolve(null),
                soft(call('relationships.list', { owner_id: id }, 'relationships')),
                // Only the played character's phone has a contact list, and only they text outside.
                id === played ? soft(call('contacts.get_all', {}, 'contacts')) : Promise.resolve(null)
            ]).then(function (r) {
                var row = r[0];
                var org = findOrg(row, slot.jobDtId);
                var company = r[1] && !r[1].error ? r[1] : null;
                var rels = {};
                (r[2] && !r[2].error && Array.isArray(r[2].relationships) ? r[2].relationships : [])
                    .forEach(function (x) { rels[String(x.target_id)] = x; });
                var contacts = r[3] && !r[3].error && Array.isArray(r[3].contacts) ? r[3].contacts : [];
                var keys = [row.displayName];
                (org && org.rankList ? org.rankList : []).forEach(function (k) { keys.push(k.rankName); });
                var ids = company ? Object.keys(company.memberInfo || {}).map(oaParseId)
                    .filter(function (x) { return x && x !== id; }) : [];
                var tp = company && company.activeTeamProject && company.activeTeamProject.projectId;
                return (tp && tp !== 'None' ? oaProjectRow(tp) : Promise.resolve(null)).then(function (pr) {
                    if (pr) keys.push(pr.titleTextId, pr.descTextId);
                    return Promise.all([localize(keys), oaNames(ids.slice(0, OA_TEAM_MAX), contacts)]).then(function (t) {
                        var desk = oaDesk(member, played, slot, row, org, company, rels, t[0], t[1]);
                        if (desk && !desk.school) desk.project = oaProjectOf(company, pr, t[0]);
                        return desk;
                    });
                });
            });
        });
    }

    // ---------- the company's team project (the game's own) ----------
    // The company entity's activeTeamProject: { projectId, currentPoint, totalPoint, startTicks,
    // deadlineTicks, memberContributions: { "(Value=<id>)": points }, bIsActive }, its TeamProject
    // table row { titleTextId, descTextId, durationDays, baseReward }. Ticks are 10,000,000 a second
    // from day 0 (lib/teamproject.js reads them the same way).
    var OA_TICKS_PER_MIN = 600000000;
    var OA_PJ_COLOR = '#5E5CE6';
    var oaProjectRows = {};
    var OA_PACE = {
        done: { text: '已完成', cls: 'pill-work', color: '#30D158' },
        passed: { text: '已达标', cls: 'pill-work', color: '#30D158' },
        ahead: { text: '进度领先', cls: 'pill-work', color: '#30D158' },
        ok: { text: '进度正常', cls: 'oa-pill-info', color: '#0A84FF' },
        behind: { text: '进度落后', cls: 'pill-move', color: '#FF9F0A' },
        late: { text: '已超期', cls: 'pill-late', color: '#FF453A' }
    };

    function oaProjectRow(id) {
        if (oaProjectRows[id]) return Promise.resolve(oaProjectRows[id]);
        return soft(call('data.table_get', { Alias: 'TeamProject', Row: id }, 'totalPoint')).then(function (r) {
            if (!r || r.error) return null;
            oaProjectRows[id] = r;
            return r;
        });
    }

    function oaTickMin(t) {
        return Math.floor(Number(t) / OA_TICKS_PER_MIN);
    }

    function oaEnvMin(env) {
        return env && typeof env.day === 'number' ? env.day * 1440 + (Number(env.hour) || 0) * 60 + (Number(env.minute) || 0) : null;
    }

    function oaClockOf(min) {
        var m = ((min % 1440) + 1440) % 1440;
        var h = Math.floor(m / 60);
        var mm = m % 60;
        return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
    }

    function oaProjectOf(company, row, text) {
        var p = company && company.activeTeamProject;
        if (!p || !p.projectId || p.projectId === 'None') return null;
        var open = company.lastOperatingStartTicks ? oaTickMin(company.lastOperatingStartTicks) % 1440 : 540;
        var close = company.todayOperatingEndTicks ? oaTickMin(company.todayOperatingEndTicks) % 1440 : 1020;
        if (!(close > open)) { open = 540; close = 1020; }
        var contributions = {};
        Object.keys(p.memberContributions || {}).forEach(function (k) {
            var id = oaParseId(k);
            if (id) contributions[id] = Number(p.memberContributions[k]) || 0;
        });
        var say = function (k) { return k && text[k] && text[k] !== k ? text[k] : ''; };
        return {
            id: String(p.projectId), title: (row && say(row.titleTextId)) || String(p.projectId), desc: row ? say(row.descTextId) : '',
            days: row ? Number(row.durationDays) || 0 : 0, reward: row ? Number(row.baseReward) || 0 : 0,
            current: Number(p.currentPoint) || 0, total: Number(p.totalPoint) || 0,
            startMin: oaTickMin(p.startTicks), deadlineMin: oaTickMin(p.deadlineTicks), active: p.bIsActive !== false,
            contributions: contributions, open: open, close: close
        };
    }

    function oaWorkMin(from, to, open, close) {
        if (!(to > from)) return 0;
        var sum = 0;
        for (var day = Math.floor(from / 1440); day <= Math.floor(to / 1440); day++) {
            var a = Math.max(from, day * 1440 + open);
            var b = Math.min(to, day * 1440 + close);
            if (b > a) sum += b - a;
        }
        return sum;
    }

    // { pct, timePct, pace, pass } as lib/teamproject.js standing(). pass: the points that make the
    // project done for the company the player runs (its pace is against them), else 0 (the game's
    // own rule: all the points).
    function oaStanding(p, env, pass) {
        var now = oaEnvMin(env);
        var pct = p.total ? Math.min(1, p.current / p.total) : 0;
        var goal = pass ? Math.min(1, p.current / pass) : pct;
        var all = oaWorkMin(p.startMin, p.deadlineMin, p.open, p.close);
        var spent = now === null ? 0 : oaWorkMin(p.startMin, Math.min(now, p.deadlineMin), p.open, p.close);
        var timePct = all ? spent / all : 0;
        var pace = 'ok';
        if (pct >= 1) pace = 'done';
        else if (pass && p.current >= pass) pace = 'passed';
        else if (now !== null && now >= p.deadlineMin) pace = 'late';
        else if (timePct < 0.05) pace = 'ok';
        else if (goal >= timePct + 0.1) pace = 'ahead';
        else if (goal < timePct - 0.15) pace = 'behind';
        return { pct: pct, timePct: timePct, pace: pace, pass: pass || 0 };
    }

    function oaDeadlineText(p, env) {
        var day = Math.floor(p.deadlineMin / 1440);
        var at = oaClockOf(p.deadlineMin);
        var now = oaEnvMin(env);
        if (now === null) return '第 ' + day + ' 天 ' + at + ' 截止';
        if (p.deadlineMin <= now) return '已过截止时间';
        if (day === env.day) return '今天 ' + at + ' 截止';
        if (day === env.day + 1) return '明天 ' + at + ' 截止';
        return '还剩 ' + (day - env.day) + ' 天 · 第 ' + day + ' 天 ' + at + ' 截止';
    }

    // Who has put in how much, most first; with everyone on the team when all is set.
    function oaContributors(data, desk, p, all) {
        var people = [{ id: desk.memberId, person: data.member, me: true }];
        desk.team.forEach(function (t) { people.push({ id: t.id, person: t.person }); });
        people.forEach(function (x) { x.points = p.contributions[x.id] || 0; });
        if (!all) people = people.filter(function (x) { return x.points > 0; });
        people.sort(function (a, b) { return b.points - a.points; });
        return people;
    }

    function oaContributorRow(x, max) {
        var row = node('div', 'oa-pj-who' + (x.me ? ' me' : ''));
        row.appendChild(faceAvatar(x.person));
        row.appendChild(node('div', 'oa-pj-name', x.me ? '我' : fullName(x.person)));
        var track = row.appendChild(node('div', 'oa-pj-mini'));
        var fill = track.appendChild(node('div', 'oa-pj-mini-fill'));
        fill.style.width = (max ? Math.max(x.points ? 4 : 0, Math.round(x.points / max * 100)) : 0) + '%';
        row.appendChild(node('div', 'oa-pj-pts' + (x.points ? '' : ' none'), x.points ? String(x.points) : '没出力'));
        return row;
    }

    // The project card: what it is, how far, by when, and who is carrying it.
    function oaProjectCard(data, desk, full) {
        var p = desk.project;
        if (!p) return null;
        var run = oaRun(desk);
        var s = oaStanding(p, data.env, run && run.project && run.project.id === p.id ? run.project.pass : 0);
        var pace = OA_PACE[s.pace];
        var c = card(full ? '当前项目' : '团队项目');
        var head = c.appendChild(node('div', 'ph-row oa-pj-head'));
        head.appendChild(oaMark('项', OA_PJ_COLOR, 'oa-req-mark'));
        var who = head.appendChild(node('div', 'ph-who'));
        who.appendChild(node('div', 'oa-req-title', p.title));
        who.appendChild(node('div', 'oa-pj-sub', [p.days ? '工期 ' + p.days + ' 天' : '', p.reward ? '项目奖励 ' + p.reward : ''].filter(Boolean).join(' · ')));
        head.appendChild(node('span', 'ph-pill ' + pace.cls, pace.text));
        if (p.desc) c.appendChild(node('div', 'oa-pj-desc', p.desc));
        var nums = c.appendChild(node('div', 'oa-pj-nums'));
        nums.appendChild(node('span', 'oa-pj-now', String(p.current)));
        nums.appendChild(node('span', 'oa-pj-total', ' / ' + p.total + ' 点'));
        nums.appendChild(node('span', 'oa-pj-pct', Math.round(s.pct * 100) + '%'));
        var track = c.appendChild(node('div', 'oa-pj-track'));
        var fill = track.appendChild(node('div', 'oa-pj-fill'));
        fill.style.width = Math.round(s.pct * 100) + '%';
        fill.style.background = pace.color;
        // The pass mark, and where the points should be by now (towards it) if the work were
        // spread evenly over office hours.
        var goalAt = s.pass && p.total ? s.pass / p.total : 1;
        if (s.pass && p.total) track.appendChild(node('div', 'oa-pj-pass')).style.left = Math.round(goalAt * 100) + '%';
        if (s.pace !== 'done' && s.pace !== 'passed' && s.timePct > 0.02 && s.timePct < 1) track.appendChild(node('div', 'oa-pj-mark')).style.left = Math.round(s.timePct * goalAt * 100) + '%';
        if (s.pass) c.appendChild(node('div', 'oa-pj-passnote', p.current >= s.pass
            ? '已过达标线 ' + s.pass + ' 点，再往上做的每一点都算奖金'
            : '达标线 ' + s.pass + ' 点（总点数的 ' + Math.round(s.pass / p.total * 100) + '%），还差 ' + (s.pass - p.current) + ' 点'));
        var meta = c.appendChild(node('div', 'oa-pj-meta'));
        meta.appendChild(node('span', null, oaDeadlineText(p, data.env)));
        var people = oaContributors(data, desk, p, !!full);
        var mine = p.contributions[desk.memberId] || 0;
        var place = 0;
        people.forEach(function (x, i) { if (x.me) place = i + 1; });
        meta.appendChild(node('span', 'oa-pj-mine', mine ? '我出力 ' + mine + ' 点' + (place ? ' · 第 ' + place : '') : '我还没出力'));
        if (people.length) {
            var list = c.appendChild(node('div', 'oa-pj-list'));
            var max = people[0].points;
            people.slice(0, full ? 12 : 4).forEach(function (x) { list.appendChild(oaContributorRow(x, max)); });
        }
        c.appendChild(node('div', 'oa-foot', s.pass ? '上班时做工作类的事都会给项目加点。绿线是达标线，细竖线是按时达标此刻应到的进度。'
            : '上班时做工作类的事都会给项目加点。竖线是按时完成此刻应到的进度。'));
        return c;
    }

    // Names and faces of colleagues: the contact list first, else the game's character info,
    // which is kept for the session (names do not change while the game runs).
    function oaNames(ids, contacts) {
        var byId = {};
        contacts.forEach(function (c) { byId[String(c.entity_id)] = c; });
        return Promise.all(ids.map(function (pid) {
            if (byId[pid]) return Promise.resolve({ id: pid, person: byId[pid], contact: byId[pid] });
            if (oaNameCache[pid]) return Promise.resolve({ id: pid, person: oaNameCache[pid], contact: null });
            return soft(call('entity.get_character_info', { entity_id: pid }, 'entity_id')).then(function (c) {
                if (!c || c.error) return { id: pid, person: null, contact: null };
                oaNameCache[pid] = c;
                return { id: pid, person: c, contact: null };
            });
        })).then(function (list) {
            var map = {};
            list.forEach(function (x) { map[x.id] = x; });
            return map;
        });
    }

    // Everything the OA pages show about one member's job, as plain values.
    function oaDesk(member, played, slot, row, org, company, rels, text, names) {
        var id = String(member.entity_id);
        if (slot.slotType && slot.slotType !== 'Business') {
            return { school: true, place: text[row.displayName] || slot.careerDtId };
        }
        var ranks = (org && org.rankList ? org.rankList : []).slice().sort(function (a, b) { return a.rank - b.rank; });
        var rankName = function (n) {
            var x = oaRankRow(ranks, n);
            return x ? text[x.rankName] || '' : '';
        };
        var info = company ? company.memberInfo || {} : {};
        var mine = null;
        var team = [];
        Object.keys(info).forEach(function (k) {
            var pid = oaParseId(k);
            var m = info[k];
            if (!pid || !m) return;
            if (pid === id) { mine = m; return; }
            var found = names[pid];
            if (!found) return;
            team.push({
                id: pid, rank: Number(m.rank) || 0, rankName: rankName(Number(m.rank) || 0),
                attendance: Number(m.attendanceDays) || 0, evaluation: Number(m.evaluationScore) || 0,
                person: found.person || { entity_id: pid }, contact: found.contact,
                business: oaRelStat(rels, pid, 'Business')
            });
        });
        var rank = Number(mine ? mine.rank : slot.rank) || 0;
        var exp = Number(mine ? mine.exp : slot.exp) || 0;
        var cur = oaRankRow(ranks, rank);
        var next = oaRankRow(ranks, rank + 1);
        team.sort(function (a, b) { return b.rank - a.rank || b.business - a.business; });
        var above = team.filter(function (t) { return t.rank > rank; });
        var boss = above.length ? above[0] : null;
        if (boss) boss.boss = true;
        var phoneOk = id === played && !NO_PHONE_STEPS[member.age_group];
        return {
            memberId: id,
            company: text[row.displayName] || slot.careerDtId,
            job: member.job_name || '',
            rank: rank,
            maxRank: ranks.length ? ranks[ranks.length - 1].rank : rank,
            rankName: rankName(rank) || member.job_rank_name || '',
            nextRankName: next ? rankName(next.rank) : '',
            exp: exp,
            expFrom: cur ? Number(cur.requireTotalExp) || 0 : 0,
            expTo: next ? Number(next.requireTotalExp) || 0 : 0,
            salary: cur && cur.shift ? Number(cur.shift.salaryPerDay) || 0 : 0,
            nextSalary: next && next.shift ? Number(next.shift.salaryPerDay) || 0 : 0,
            ladder: ranks.map(function (x) {
                return { rank: x.rank, name: rankName(x.rank), exp: Number(x.requireTotalExp) || 0,
                    salary: x.shift ? Number(x.shift.salaryPerDay) || 0 : 0, leave: Number(x.baseVacationDays) || 0 };
            }),
            workDays: org && org.workDays ? org.workDays.length : 0,
            leaveLeft: mine ? Number(mine.remainingVacationDays) || 0 : null,
            leaveYear: cur ? Number(cur.baseVacationDays) || 0 : 0,
            leaveBooked: mine ? Number(mine.vacationScheduledDays) || 0 : 0,
            evaluation: Number(mine ? mine.evaluationScore : slot.evaluationScore) || 0,
            attendance: mine ? Number(mine.attendanceDays) || 0 : null,
            unexcused: mine ? Number(mine.unexcusedAbsenceCount) || 0 : 0,
            absentRun: mine ? Number(mine.consecutiveAbsenceDays) || 0 : 0,
            remoteNow: !!(mine && mine.activeWorkMode === 'Remote'),
            remoteOk: !!(org && org.bCanRemoteWork),
            boss: boss,
            bossTextable: !!(boss && boss.contact && phoneOk && !NO_PHONE_STEPS[boss.contact.age_group]),
            phoneOk: phoneOk,
            team: team,
            readable: !!mine
        };
    }

    // Why the boss cannot be texted from here, or '' when they can.
    function oaBossBlock(desk) {
        if (!desk.boss) return desk.readable ? '你已经是这里职级最高的人，没有上级。' : '公司的人员名单读不到，找不到上级。';
        if (!desk.phoneOk) return '只有你正在操作的角色能给上级发消息。';
        if (!desk.boss.contact) return '上级还不在你的手机通讯录里。在游戏里和 TA 聊过、交换联系方式以后就能发消息。';
        if (!desk.bossTextable) return '上级现在没法用手机。';
        return '';
    }

    // Opens the chat with the boss, with text waiting in the box when there is any.
    function oaOpenChat(data, desk, text) {
        var boss = desk.boss;
        if (!boss || !desk.bossTextable) return;
        smsPrefill = text ? { contactId: boss.id, text: text } : null;
        var go = function () {
            smsContactId = boss.id;
            open('chat');
        };
        addOutside(data.played, boss.contact, '上级').then(go, go);
    }

    // Chips in rows of a fixed count. cohtml does not grow a wrapping flex box with chips sized by
    // their text (they stretch and spill out of the card), so each row is its own one-line box.
    function oaChipRows(chips, perRow) {
        var box = node('div', 'oa-chips');
        var row = null;
        chips.forEach(function (chip, i) {
            if (i % perRow === 0) row = box.appendChild(node('div', 'oa-chip-row'));
            row.appendChild(chip);
        });
        return box;
    }

    function oaNotice(wrap, text) {
        var c = card();
        c.appendChild(node('div', 'ph-empty', text));
        wrap.appendChild(c);
        return wrap;
    }

    function oaSection(title, more, onMore) {
        var head = node('div', 'oa-sec');
        head.appendChild(node('div', 'oa-sec-title', title));
        if (more) {
            var link = head.appendChild(node('div', 'oa-sec-more', more + ' ›'));
            onTap(link, function (e) {
                e.stopPropagation();
                onMore();
            });
        }
        return head;
    }

    // A colour as rgba at the given alpha ('#0A84FF' -> 'rgba(10,132,255,0.16)').
    function oaTint(hex, alpha) {
        var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
        if (!m) return hex;
        var n = parseInt(m[1], 16);
        return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + alpha + ')';
    }

    function oaMark(text, color, cls) {
        var m = node('div', 'oa-mark' + (cls ? ' ' + cls : ''), text);
        m.style.background = oaTint(color, 0.16);
        m.style.color = color;
        return m;
    }

    // The company's colours for its header: a deep gradient picked by its name.
    var OA_HERO = [['#1F4FD1', '#3D7DFF'], ['#0E6670', '#1B9AA0'], ['#3A2F9E', '#6A5BE8'],
        ['#9A3F14', '#D9732E'], ['#1D5C3A', '#2E9A5C'], ['#5B2A7C', '#9553C4']];

    function oaHeroColors(name) {
        var n = 0;
        for (var i = 0; i < name.length; i++) n = (n * 31 + name.charCodeAt(i)) % 9973;
        return OA_HERO[n % OA_HERO.length];
    }

    function oaHeroKpi(value, label, warn) {
        var k = node('div', 'oa-hero-kpi');
        k.appendChild(node('div', 'oa-hero-kpi-val' + (warn ? ' warn' : ''), value));
        k.appendChild(node('div', 'oa-hero-kpi-label', label));
        return k;
    }

    // ---------- the workbench (home page) ----------

    // The company's letterhead: logo, name, the member's badge and who else at home works.
    function oaBrand(data, desk) {
        var colors = oaHeroColors(desk.company);
        var c = node('div', 'ph-card oa-hero');
        c.style.background = 'linear-gradient(135deg, ' + colors[0] + ', ' + colors[1] + ')';
        var top = node('div', 'ph-row');
        top.appendChild(node('div', 'oa-hero-logo', desk.company.charAt(0)));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'oa-hero-company', desk.company));
        who.appendChild(node('div', 'oa-hero-badge', desk.job + ' · 工号 ' + desk.memberId));
        top.appendChild(who);
        if (data.workers.length > 1) top.appendChild(oaPeople(data));
        c.appendChild(top);
        var me = node('div', 'ph-row oa-hero-me');
        me.appendChild(faceAvatar(data.member));
        var name = node('div', 'ph-who');
        name.appendChild(node('div', 'oa-hero-name', fullName(data.member)));
        name.appendChild(node('div', 'oa-hero-rank', desk.rankName + ' · 第 ' + desk.rank + ' 级'));
        me.appendChild(name);
        c.appendChild(me);
        var kpis = node('div', 'oa-hero-kpis');
        var grade = oaGrade(desk.evaluation);
        kpis.appendChild(oaHeroKpi(grade.g, '绩效 ' + desk.evaluation, grade.tone === 'bad'));
        kpis.appendChild(oaHeroKpi(desk.attendance === null ? '-' : String(desk.attendance), '出勤天数'));
        kpis.appendChild(oaHeroKpi(desk.leaveLeft === null ? '-' : String(desk.leaveLeft), '年假余额'));
        kpis.appendChild(oaHeroKpi(String(desk.unexcused), '旷工', desk.unexcused > 0));
        c.appendChild(kpis);
        var line = node('div', 'oa-hero-progress');
        if (desk.nextRankName) {
            var span = desk.expTo - desk.expFrom;
            var pct = span > 0 ? Math.max(0, Math.min(100, (desk.exp - desk.expFrom) / span * 100)) : 100;
            var head = line.appendChild(node('div', 'oa-hero-progress-head'));
            head.appendChild(node('span', null, '距晋升「' + desk.nextRankName + '」'));
            head.appendChild(node('span', 'oa-hero-progress-num', desk.exp + ' / ' + desk.expTo));
            var track = line.appendChild(node('div', 'oa-hero-track'));
            track.appendChild(node('div', 'oa-hero-fill')).style.width = Math.round(pct) + '%';
        } else {
            line.appendChild(node('div', 'oa-hero-progress-head', '已是公司最高职级'));
        }
        c.appendChild(line);
        return c;
    }

    // Small faces to switch whose workbench this is.
    function oaPeople(data) {
        var row = node('div', 'oa-people');
        data.workers.forEach(function (m) {
            var id = String(m.entity_id);
            if (id === oaMemberId) return;
            var face = faceAvatar(m);
            face.className += ' oa-person-face';
            onTap(face, function (e) {
                e.stopPropagation();
                oaMemberId = id;
                setNote('', false);
                refresh();
            });
            row.appendChild(face);
        });
        return row;
    }

    // Attendance as a clock-in card: today's state in the dial, the two punches beside it and the
    // week underneath.
    function oaClock(data, desk) {
        var m = data.member;
        var idx = data.workers.indexOf(m);
        var sched = data.schedules[idx];
        var validSched = sched && !sched.error ? sched : null;
        var work = data.work[String(m.entity_id)];
        var known = work && !work.error;
        var state = oaState(work, validSched, data.env);
        var c = card('考勤打卡');
        var row = node('div', 'ph-row oa-clock');
        var dial = node('div', 'oa-dial ' + state.cls);
        dial.appendChild(node('div', 'oa-dial-state', state.text));
        dial.appendChild(node('div', 'oa-dial-time', clockText(data.env)));
        row.appendChild(dial);
        var punches = node('div', 'ph-who');
        var now = envMinutes(data.env);
        var workday = known ? !!work.is_working_day : !!(validSched && validSched.days.indexOf(data.env.day_of_week) >= 0);
        var started = validSched && now !== null && now >= validSched.start;
        var ended = validSched && now !== null && validSched.end > validSched.start && now >= validSched.end;
        var inText = !workday ? '休息' : known && work.is_at_work ? '已到岗' : ended ? '已打卡' : started ? '未到岗' : '未开始';
        var outText = !workday ? '休息' : ended ? '已下班' : '未开始';
        punches.appendChild(oaPunch('上班', validSched ? minutesToLabel(validSched.start) : '--:--', inText, inText === '未到岗' ? 'bad' : inText === '已到岗' || inText === '已打卡' ? 'good' : ''));
        punches.appendChild(oaPunch('下班', validSched ? minutesToLabel(validSched.end) : '--:--', outText, outText === '已下班' ? 'good' : ''));
        punches.appendChild(node('div', 'oa-clock-mode', desk.remoteNow ? '今天远程办公' : desk.remoteOk ? '到岗办公 · 可申请远程' : '到岗办公'));
        row.appendChild(punches);
        c.appendChild(row);
        c.appendChild(oaWeek(validSched, data.env));
        return c;
    }

    function oaPunch(label, time, text, tone) {
        var p = node('div', 'oa-punch');
        p.appendChild(node('span', 'oa-punch-label', label));
        p.appendChild(node('span', 'oa-punch-time', time));
        p.appendChild(node('span', 'oa-punch-state' + (tone ? ' ' + tone : ''), text));
        return p;
    }

    function oaWeek(sched, env) {
        var week = node('div', 'oa-week');
        OA_WEEK.forEach(function (d) {
            var cell = node('div', 'oa-day' + (env && env.day_of_week === d ? ' today' : ''));
            cell.appendChild(node('div', 'oa-day-name', OA_DAY_NAMES[d]));
            var on = sched && sched.days.indexOf(d) >= 0;
            cell.appendChild(node('div', 'oa-day-dot' + (on ? ' on' : ''), on ? '班' : '休'));
            week.appendChild(cell);
        });
        return week;
    }

    // Notices the company would send: what is worth acting on now.
    function oaNotices(desk, requests) {
        var out = [];
        var pending = requests.filter(function (x) { return x.status === 'pending'; }).length;
        if (pending) out.push({ tone: 'move', text: '有 ' + pending + ' 个申请在等上级审批。' });
        requests.forEach(function (x) {
            if (!x.decision || out.length >= 3 || x.status === 'pending') return;
            var eff = x.decision.effect;
            if (eff && eff.state === 'failed') out.push({ tone: 'bad', text: oaKind(x.r.kind).form + '批了，但' + (eff.text || '游戏里没办成') + '。' });
            else out.push({ tone: x.status === 'approved' ? 'good' : 'bad', text: oaKind(x.r.kind).form + (x.status === 'approved' ? '已通过' : '被驳回') + (x.decision.note ? '：' + x.decision.note : '。') });
        });
        if (desk.nextRankName && desk.exp >= desk.expTo) out.push({ tone: 'good', text: '晋升「' + desk.nextRankName + '」的经验已经够了，可以发起晋升申请。' });
        if (desk.unexcused) out.push({ tone: 'bad', text: '你有 ' + desk.unexcused + ' 次旷工记录，会影响绩效和审批。' });
        if (desk.absentRun > 1) out.push({ tone: 'bad', text: '已经连续 ' + desk.absentRun + ' 天没来上班。' });
        if (desk.leaveLeft) out.push({ tone: '', text: '年假还有 ' + desk.leaveLeft + ' 天没休。' });
        return out.slice(0, 3);
    }

    function oaNoticeCard(desk, requests) {
        var list = oaNotices(desk, requests);
        if (!list.length) return null;
        var c = node('div', 'ph-card oa-notices');
        list.forEach(function (n) {
            var line = node('div', 'oa-notice');
            line.appendChild(node('span', 'oa-notice-dot ' + (n.tone || 'info')));
            line.appendChild(node('span', 'oa-notice-text', n.text));
            c.appendChild(line);
        });
        return c;
    }

    function oaHint(kind, desk) {
        if (kind.id === 'leave') return desk.leaveLeft === null ? '' : '余 ' + desk.leaveLeft + ' 天';
        if (kind.id === 'sick') return '不占年假';
        if (kind.id === 'remote') return !desk.remoteOk ? '不支持' : desk.remoteNow ? '远程中' : '可申请';
        if (kind.id === 'promote') {
            if (!desk.nextRankName) return '已到顶';
            return desk.exp >= desk.expTo ? '可申请' : '差 ' + (desk.expTo - desk.exp);
        }
        return '';
    }

    function oaApp(text, mark, color, hint, onOpen) {
        var tile = node('div', 'oa-app');
        tile.appendChild(oaMark(mark, color, 'oa-app-mark'));
        tile.appendChild(node('div', 'oa-app-label', text));
        tile.appendChild(node('div', 'oa-app-hint', hint || ''));
        onTap(tile, function (e) {
            e.stopPropagation();
            onOpen();
        });
        return tile;
    }

    function oaApps(data, desk) {
        var c = card('工作台');
        var grid = node('div', 'oa-apps');
        OA_KINDS.forEach(function (k) {
            grid.appendChild(oaApp(k.label, k.mark, k.color, oaHint(k, desk), function () {
                oaApplyKind = k.id;
                oaApplyDays = 1;
                oaApplyReason = 0;
                open('oaApply');
            }));
        });
        var block = oaBossBlock(desk);
        var run = oaRun(desk);
        // Nobody above to text: the company to run instead.
        if (run) grid.appendChild(oaApp('管理台', '管', '#FF453A', oaMgWaiting(run).length ? oaMgWaiting(run).length + ' 待批' : '经营', function () { open('oaManage'); }));
        else grid.appendChild(oaApp('联系上级', '聊', '#0A84FF', block ? '不可用' : desk.boss ? fullName(desk.boss.person) : '', function () {
            if (block) setNote(block, false);
            else oaOpenChat(data, desk, '');
        }));
        grid.appendChild(oaApp('组织架构', '组', '#5E5CE6', desk.team.length + 1 + ' 人', function () { open('oaOrg'); }));
        grid.appendChild(oaApp('薪酬职级', '薪', '#BF5AF2', '日薪 ' + desk.salary, function () { open('oaPay'); }));
        c.appendChild(grid);
        return c;
    }

    function oaRequestRow(x, withdraw) {
        var kind = oaKind(x.r.kind);
        var row = node('div', 'ph-row oa-req');
        row.appendChild(oaMark(kind.mark, kind.color, 'oa-req-mark'));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'oa-req-title', kind.form + (x.r.days ? ' · ' + x.r.days + ' 天' : '')));
        who.appendChild(node('div', 'ph-sub', [x.r.day ? '第 ' + x.r.day + ' 天' : '', x.r.time || '', x.r.reason || ''].filter(Boolean).join(' · ')));
        if (x.decision && x.decision.note) who.appendChild(node('div', 'oa-req-note', '批复：' + x.decision.note));
        // How the game carried out what the boss granted (lib/career.js).
        var eff = x.status === 'approved' && x.decision && x.decision.effect;
        if (eff && OA_EFFECT[eff.state]) who.appendChild(node('div', 'oa-req-eff ' + OA_EFFECT[eff.state], (eff.state === 'applying' ? '办理中：' : '办理：') + (eff.text || '')));
        row.appendChild(who);
        var st = OA_STATUS[x.status];
        var side = node('div', 'oa-req-side');
        side.appendChild(node('span', 'ph-pill ' + st.cls, st.text));
        var id = x.r.id;
        if (x.status === 'pending' && withdraw) {
            var undo = side.appendChild(node('div', 'oa-req-undo', '撤回'));
            onTap(undo, function (e) {
                e.stopPropagation();
                oaChangeRequest(id, { status: 'withdrawn' });
            });
        }
        // Granted but not carried out: the reply service tries again once the record says so.
        var asked = eff && eff.state === 'failed' && Number(x.r.retry) > (Number(eff.at) || 0);
        if (eff && eff.state === 'failed' && withdraw) {
            var again = side.appendChild(node('div', 'oa-req-undo', asked ? '已重新提交' : '重新办理'));
            if (!asked) {
                onTap(again, function (e) {
                    e.stopPropagation();
                    oaChangeRequest(id, { retry: Date.now() });
                });
            }
        }
        row.appendChild(side);
        return row;
    }

    function oaRequestCard(data) {
        var c = card('我的申请');
        if (!data.requests.length) {
            c.appendChild(node('div', 'ph-caption', '还没有提交过申请。在工作台选一项，填好就能提交给上级。'));
            return c;
        }
        data.requests.slice(0, OA_REQ_SHOWN).forEach(function (x) { c.appendChild(oaRequestRow(x, true)); });
        if (data.requests.length > OA_REQ_SHOWN) c.appendChild(node('div', 'ph-caption', '只显示最近 ' + OA_REQ_SHOWN + ' 条，共 ' + data.requests.length + ' 条。'));
        return c;
    }

    // Who else at home is at work right now: what the old Work app showed.
    function oaFamilyCard(data) {
        var others = data.workers.filter(function (m) { return m !== data.member; });
        if (!others.length) return null;
        var c = card('家人出勤');
        others.forEach(function (m) {
            var idx = data.workers.indexOf(m);
            var sched = data.schedules[idx];
            var state = oaState(data.work[String(m.entity_id)], sched && !sched.error ? sched : null, data.env);
            var row = personRow(m, [m.job_name || '上学', m.job_rank_name], node('span', 'ph-pill ' + state.cls, state.text));
            row.className += ' oa-person';
            row.replaceChild(faceAvatar(m), row.firstChild);
            onTap(row, function (e) {
                e.stopPropagation();
                oaMemberId = String(m.entity_id);
                refresh();
            });
            c.appendChild(row);
        });
        return c;
    }

    function renderOa(data) {
        var wrap = node('div', 'oa-screen');
        wrap.appendChild(subHeader('oa'));
        if (!data.workers.length) return oaNotice(wrap, '家里还没有人有工作。去「Jobs」找一份吧。');
        var desk = data.desk;
        var name = fullName(data.member);
        if (!desk || desk.error || desk.none || desk.school) {
            if (!desk || desk.error) oaNotice(wrap, '读不到' + name + '的工作资料。' + (desk && desk.error ? desk.error : ''));
            else if (desk.none) oaNotice(wrap, name + '现在没有工作。');
            else oaNotice(wrap, name + '在' + desk.place + '上学。OA 只管上班的事，上学请假以后再接入。');
        } else {
            wrap.appendChild(oaBrand(data, desk));
            var run = oaRun(desk);
            if (run) wrap.appendChild(oaRunCard(run));
            var notices = oaNoticeCard(desk, data.requests);
            if (notices) wrap.appendChild(notices);
            wrap.appendChild(oaApps(data, desk));
            wrap.appendChild(oaClock(data, desk));
            var project = oaProjectCard(data, desk, false);
            if (project) wrap.appendChild(project);
            // Nobody above: with a company to run there is nothing to say here.
            if (desk.boss || !run) wrap.appendChild(oaBossCard(desk));
            wrap.appendChild(oaTaskCard(desk));
            wrap.appendChild(oaRequestCard(data));
        }
        var family = oaFamilyCard(data);
        if (family) wrap.appendChild(family);
        return wrap;
    }

    // ---------- the approval form ----------

    // What the boss will look at, as { ok: true | false | null, text }; null is just a fact.
    // The reply service is to apply the same rules before a request is granted in the game.
    function oaChecks(kind, desk, days) {
        var out = [];
        if (kind.id === 'leave') {
            out.push({ ok: desk.leaveLeft !== null && desk.leaveLeft >= days, text: '年假余额 ' + (desk.leaveLeft === null ? '?' : desk.leaveLeft) + ' 天，本次 ' + days + ' 天' });
            out.push({ ok: desk.unexcused === 0, text: desk.unexcused ? '有 ' + desk.unexcused + ' 次旷工记录' : '无旷工记录' });
        } else if (kind.id === 'sick') {
            out.push({ ok: null, text: '病假不占年假，单次最多 ' + OA_SICK_DAYS_MAX + ' 天' });
            out.push({ ok: null, text: '真的生病了才批得下来，装病会被看穿' });
            out.push({ ok: desk.unexcused === 0, text: desk.unexcused ? '有 ' + desk.unexcused + ' 次旷工记录，上级可能会怀疑' : '无旷工记录' });
        } else if (kind.id === 'remote') {
            out.push({ ok: desk.remoteOk, text: desk.remoteOk ? '岗位允许远程办公' : '岗位必须到岗' });
            if (desk.remoteNow) out.push({ ok: null, text: '当前已在远程办公' });
            out.push({ ok: null, text: '游戏里暂时不能切换远程办公，批了也只是口头同意' });
        } else if (kind.id === 'promote') {
            out.push({ ok: !!desk.nextRankName, text: desk.nextRankName ? '下一级「' + desk.nextRankName + '」' : '已是最高职级' });
            if (desk.nextRankName) out.push({ ok: desk.exp >= desk.expTo, text: '经验 ' + desk.exp + ' / ' + desk.expTo });
            out.push({ ok: desk.evaluation >= OA_GOOD_EVALUATION, text: '绩效 ' + oaGrade(desk.evaluation).g + '（' + desk.evaluation + ' 分）' });
        } else if (kind.id === 'resign') {
            out.push({ ok: null, text: '离职后将离开' + desk.company + '，职级和经验不保留' });
        }
        return out;
    }

    // How likely the boss is to say yes, from the checks: any failed rule makes it unlikely.
    function oaOdds(checks) {
        var rules = checks.filter(function (x) { return x.ok !== null; });
        if (!rules.length) return { text: '看上级心情', cls: 'pill-idle' };
        if (rules.some(function (x) { return x.ok === false; })) return { text: '通过把握 低', cls: 'pill-late' };
        return { text: '通过把握 高', cls: 'pill-work' };
    }

    function oaDraft(kind, desk, days, reason) {
        if (kind.id === 'leave') return '领导您好，' + reason + '，我想请 ' + days + ' 天假，您看可以吗？';
        if (kind.id === 'sick') return '领导，我' + reason + '，想请 ' + days + ' 天病假。';
        if (kind.id === 'remote') return '领导，最近' + reason + '，我想申请远程办公，您看行吗？';
        if (kind.id === 'promote') return '领导，我来公司' + (desk.attendance ? '上了 ' + desk.attendance + ' 天班' : '有一阵了') + '，' + reason + '，想跟您聊聊晋升的事。';
        return '领导，我考虑了很久，' + reason + '，想跟您提离职。';
    }

    function oaDaysMax(kind, desk) {
        if (kind.id === 'sick') return OA_SICK_DAYS_MAX;
        return Math.max(1, desk.leaveLeft || 0);
    }

    function oaField(label, value) {
        var row = node('div', 'oa-field');
        row.appendChild(node('div', 'oa-field-label', label));
        var v = node('div', 'oa-field-value');
        if (typeof value === 'string') v.appendChild(document.createTextNode(value));
        else v.appendChild(value);
        row.appendChild(v);
        return row;
    }

    function oaStepper(max) {
        var stepper = node('div', 'oa-stepper');
        var minus = node('div', 'oa-step-btn' + (oaApplyDays > 1 ? '' : ' off'), '−');
        var plus = node('div', 'oa-step-btn' + (oaApplyDays < max ? '' : ' off'), '+');
        onTap(minus, function (e) {
            e.stopPropagation();
            if (oaApplyDays <= 1) return;
            oaApplyDays -= 1;
            refresh();
        });
        onTap(plus, function (e) {
            e.stopPropagation();
            if (oaApplyDays >= max) return;
            oaApplyDays += 1;
            refresh();
        });
        stepper.appendChild(minus);
        stepper.appendChild(node('div', 'oa-step-val', oaApplyDays + ' 天'));
        stepper.appendChild(plus);
        return stepper;
    }

    // The approval route: the applicant, the direct boss, then the file.
    function oaFlow(data, desk) {
        var c = card('审批流程');
        var steps = [
            { who: fullName(data.member), what: '发起申请', state: '现在', on: true },
            { who: desk.boss ? fullName(desk.boss.person) : '无上级', what: '直属上级审批' + (desk.boss ? ' · ' + desk.boss.rankName : ''), state: '在聊天里答复' },
            { who: desk.company, what: '人事归档', state: '自动' }
        ];
        steps.forEach(function (s, i) {
            var step = node('div', 'oa-flow-step' + (i === steps.length - 1 ? ' last' : ''));
            var rail = node('div', 'oa-flow-rail');
            rail.appendChild(node('div', 'oa-flow-dot' + (s.on ? ' on' : '')));
            if (i < steps.length - 1) rail.appendChild(node('div', 'oa-flow-line'));
            step.appendChild(rail);
            var body = node('div', 'ph-who');
            body.appendChild(node('div', 'oa-flow-what', s.what));
            body.appendChild(node('div', 'ph-sub', s.who + ' · ' + s.state));
            step.appendChild(body);
            c.appendChild(step);
        });
        return c;
    }

    function oaSubmit(data, desk, kind, draft) {
        var env = data.env || {};
        oaRequests.push({
            id: 'r' + Date.now().toString(36),
            member: desk.memberId,
            kind: kind.id,
            days: kind.days ? oaApplyDays : 0,
            reason: kind.reasons[oaApplyReason],
            text: draft,
            boss: desk.boss.id,
            bossName: fullName(desk.boss.person),
            day: env.day || 0,
            time: clockText(env),
            at: Date.now(),
            status: 'pending'
        });
        var go = function () { oaOpenChat(data, desk, draft); };
        oaSaveRequests().then(go, go);
    }

    function renderOaApply(data) {
        var kind = oaKind(oaApplyKind);
        var wrap = node('div', 'oa-screen');
        wrap.appendChild(subHeader('oaApply', kind.form));
        var desk = data.desk;
        if (!desk || desk.error || desk.none || desk.school) return oaNotice(wrap, '这个人现在没有可以申请的工作。');

        var form = node('div', 'ph-card oa-form');
        form.appendChild(oaField('申请人', fullName(data.member)));
        form.appendChild(oaField('所属部门', desk.company + ' · ' + desk.job));
        form.appendChild(oaField('当前职级', desk.rankName + '（第 ' + desk.rank + ' 级）'));
        var kinds = oaChipRows(OA_KINDS.map(function (k) {
            var chip = node('div', 'oa-chip' + (k.id === kind.id ? ' on' : ''), k.label);
            onTap(chip, function (e) {
                e.stopPropagation();
                if (k.id === oaApplyKind) return;
                oaApplyKind = k.id;
                oaApplyDays = 1;
                oaApplyReason = 0;
                refresh();
            });
            return chip;
        }), 3);
        form.appendChild(oaField('申请类型', kinds));
        var max = oaDaysMax(kind, desk);
        if (oaApplyDays > max) oaApplyDays = max;
        if (kind.days) form.appendChild(oaField('时长', oaStepper(max)));
        if (oaApplyReason >= kind.reasons.length) oaApplyReason = 0;
        form.appendChild(oaField('事由', oaChipRows(kind.reasons.map(function (text, i) {
            var chip = node('div', 'oa-chip' + (i === oaApplyReason ? ' on' : ''), text);
            onTap(chip, function (e) {
                e.stopPropagation();
                if (i === oaApplyReason) return;
                oaApplyReason = i;
                refresh();
            });
            return chip;
        }), 2)));
        wrap.appendChild(form);

        var checks = oaChecks(kind, desk, oaApplyDays);
        var odds = oaOdds(checks);
        var rules = card();
        var head = node('div', 'ph-row');
        var title = node('div', 'ph-who');
        title.appendChild(node('div', 'ph-card-label', '系统校验'));
        head.appendChild(title);
        head.appendChild(node('span', 'ph-pill ' + odds.cls, odds.text));
        rules.appendChild(head);
        checks.forEach(function (x) {
            var line = node('div', 'oa-check ' + (x.ok === true ? 'ok' : x.ok === false ? 'no' : 'info'));
            line.appendChild(node('span', 'oa-check-mark', x.ok === true ? '✓' : x.ok === false ? '✕' : '·'));
            line.appendChild(node('span', null, x.text));
            rules.appendChild(line);
        });
        wrap.appendChild(rules);

        wrap.appendChild(oaFlow(data, desk));

        var draft = oaDraft(kind, desk, oaApplyDays, kind.reasons[oaApplyReason]);
        var say = card('附言（发给上级）');
        say.appendChild(node('div', 'oa-draft', draft));
        say.appendChild(node('div', 'ph-caption', '提交后这段话会放进和上级的聊天框，改好了再发。上级在聊天里答复，批了以后游戏里自动办理：请假会打电话给公司请好，晋升直接升级，离职会离开公司。'));
        wrap.appendChild(say);

        var block = oaBossBlock(desk);
        var btns = node('div', 'ph-btns');
        btns.appendChild(actionButton('提交审批', 'last ' + (block ? 'off' : 'on'), function () {
            if (block) return;
            oaSubmit(data, desk, kind, draft);
        }));
        wrap.appendChild(btns);
        if (block) wrap.appendChild(node('div', 'ph-caption', block));
        return wrap;
    }

    // ---------- organisation and pay ----------

    function renderOaOrg(data) {
        var wrap = node('div', 'oa-screen');
        wrap.appendChild(subHeader('oaOrg'));
        var desk = data.desk;
        if (!desk || desk.error || desk.none || desk.school) return oaNotice(wrap, '这个人现在没有工作。');
        var people = desk.team.map(function (t) { return t; });
        people.push({ id: desk.memberId, rank: desk.rank, rankName: desk.rankName, person: data.member, me: true,
            attendance: desk.attendance || 0, business: 0 });
        var ranks = desk.ladder.slice().reverse();
        wrap.appendChild(node('div', 'ph-caption', desk.company + ' · ' + people.length + ' 人' + (desk.readable ? '' : '（名单读不全）')));
        ranks.forEach(function (r) {
            var here = people.filter(function (p) { return p.rank === r.rank; });
            if (!here.length) return;
            var c = card(r.name + ' · 第 ' + r.rank + ' 级');
            here.forEach(function (p) {
                var row = node('div', 'ph-row oa-person');
                row.appendChild(faceAvatar(p.person));
                var who = node('div', 'ph-who');
                who.appendChild(node('div', 'ph-name', fullName(p.person)));
                var seen = p.me ? null : oaImpression(desk.memberId, p.id);
                who.appendChild(node('div', 'ph-sub', p.me ? '出勤 ' + p.attendance + ' 天'
                    : '出勤 ' + p.attendance + ' 天 · ' + (seen ? '对你' + seen.label : '工作关系 ' + Math.round(p.business))));
                row.appendChild(who);
                if (p.me) row.appendChild(node('span', 'ph-pill pill-work', '我'));
                else if (p.boss) row.appendChild(node('span', 'ph-pill oa-tag', '直属上级'));
                c.appendChild(row);
            });
            wrap.appendChild(c);
        });
        return wrap;
    }

    function oaPayLine(label, value, strong) {
        var row = node('div', 'oa-pay-line' + (strong ? ' strong' : ''));
        row.appendChild(node('span', null, label));
        row.appendChild(node('span', 'oa-pay-val', value));
        return row;
    }

    function renderOaPay(data) {
        var wrap = node('div', 'oa-screen');
        wrap.appendChild(subHeader('oaPay'));
        var desk = data.desk;
        if (!desk || desk.error || desk.none || desk.school) return oaNotice(wrap, '这个人现在没有工作。');
        var slip = card('工资条');
        slip.appendChild(oaPayLine('日薪', String(desk.salary)));
        slip.appendChild(oaPayLine('每周上班', desk.workDays + ' 天'));
        slip.appendChild(oaPayLine('周薪（预计）', String(desk.salary * desk.workDays), true));
        if (desk.nextRankName) slip.appendChild(node('div', 'ph-caption', '升到「' + desk.nextRankName + '」后日薪 ' + desk.nextSalary + '，每周多 ' + (desk.nextSalary - desk.salary) * desk.workDays + '。'));
        wrap.appendChild(slip);

        var ladder = card('职级阶梯');
        var head = node('div', 'oa-rung oa-rung-head');
        ['职级', '经验', '日薪', '年假'].forEach(function (t) { head.appendChild(node('div', 'oa-rung-cell', t)); });
        ladder.appendChild(head);
        desk.ladder.forEach(function (r) {
            var cls = r.rank === desk.rank ? ' now' : r.rank < desk.rank ? ' done' : '';
            var row = node('div', 'oa-rung' + cls);
            row.appendChild(node('div', 'oa-rung-cell oa-rung-name', (r.rank < desk.rank ? '✓ ' : '') + r.name));
            row.appendChild(node('div', 'oa-rung-cell', String(r.exp)));
            row.appendChild(node('div', 'oa-rung-cell', String(r.salary)));
            row.appendChild(node('div', 'oa-rung-cell', r.leave + ' 天'));
            ladder.appendChild(row);
        });
        ladder.appendChild(node('div', 'ph-caption', '经验在上班时慢慢涨；够了以后找上级谈晋升。'));
        wrap.appendChild(ladder);
        return wrap;
    }

    // ---------- 管理台: the company the member runs ----------
    // Once the member holds the company's top rank with nobody above, the reply service runs the
    // company with them (lib/company.js): ui/phone/oa/company.cfg is what it shows,
    // { v, byManager: { <member>: { companyId, company, cash, week, history, morale, staff, requests } } },
    // and the manager's answers go to ui/phone/saved/oa-mgmt.cfg (phone only):
    // { v, byId: { <request id>: { decision: approved | rejected, at } }, seen: { <company id>: at } }.
    var OA_MGMT_KEY = 'oa-mgmt';
    var OA_MGMT_KEEP = 60;
    // A request left this many game days lapses (lib/company.js LAPSE_DAYS).
    var OA_MG_LAPSE = 2;
    var oaCompany = {};
    var oaMgmt = { v: 1, byId: {}, seen: {}, pay: {}, offers: {}, fire: {} };
    var oaMgTab = 'overview';
    // The executive's colours, set on the element: the light theme's card background would win over a class.
    var OA_EXEC_BG = 'linear-gradient(135deg, #141E36, #2A3F78)';
    var OA_MG_KINDS = {
        leave: { mark: '假', color: '#30D158', yes: '批准', no: '驳回', what: '只记在公司账上，游戏里的排班不变' },
        raise: { mark: '薪', color: '#BF5AF2', yes: '批准', no: '驳回', what: '日薪涨 10%，记在公司账上' },
        promote: { mark: '升', color: '#FF9F0A', yes: '批准', no: '驳回', what: '批准后游戏里会真的升一级' },
        resign: { mark: '离', color: '#8E8E93', yes: '同意', no: '挽留', what: '同意后 TA 会在游戏里离开公司' },
        // The game seated someone in an empty seat (lib/company.js): kept, or let go.
        hire: { mark: '新', color: '#64D2FF', yes: '留用', no: '辞退', what: '游戏安排进来的新人，还在试用期；辞退后 TA 会在游戏里离开公司，空出的工位过几天会再来人',
            done: { approved: '已留用', rejected: '已辞退' } },
        // Someone the game took out of the company without the manager (lib/company.js gone): call back, or let be.
        gone: { mark: '走', color: '#FF453A', yes: '召回', no: '就这样吧', what: '这次离开没经过你审批。召回会让 TA 重新入职（需要有空的入门工位，从入门职级重新开始，薪酬照旧）',
            done: { approved: '已召回', rejected: '已确认' } }
    };
    var OA_MG_STATUS = {
        pending: { text: '待审批', cls: 'pill-move' }, approved: { text: '已批准', cls: 'pill-work' },
        rejected: { text: '已驳回', cls: 'pill-late' }, lapsed: { text: '已过期', cls: 'pill-idle' },
        sent: { text: '处理中', cls: 'pill-move' }
    };
    // Morale bands, best first: the label the service gives, and a colour.
    var OA_MG_MOODS = [
        { min: 75, text: '干劲十足', color: '#30D158' }, { min: 55, text: '状态不错', color: '#0A84FF' },
        { min: 35, text: '有点低落', color: '#FF9F0A' }, { min: -1, text: '想走了', color: '#FF453A' }
    ];

    function oaMgRead(r) {
        oaCompany = r && r.byManager && typeof r.byManager === 'object' ? r.byManager : {};
    }

    function oaMgReadMine(r) {
        oaMgmt = { v: 1, byId: r && r.byId && typeof r.byId === 'object' ? r.byId : {},
            seen: r && r.seen && typeof r.seen === 'object' ? r.seen : {},
            pay: r && r.pay && typeof r.pay === 'object' ? r.pay : {},
            hiring: r && r.hiring && typeof r.hiring === 'object' ? r.hiring : null,
            offers: r && r.offers && typeof r.offers === 'object' ? r.offers : {},
            fire: r && r.fire && typeof r.fire === 'object' ? r.fire : {},
            secretary: r && r.secretary && typeof r.secretary === 'object' ? r.secretary : null };
        if (r && r.planOpen && typeof r.planOpen === 'object') oaMgmt.planOpen = r.planOpen;
    }

    // The company the member runs, or null.
    function oaRun(desk) {
        if (!desk || desk.error || desk.none || desk.school) return null;
        var v = oaCompany[desk.memberId];
        return v && typeof v === 'object' && Array.isArray(v.requests) ? v : null;
    }

    function oaMoney(n) {
        n = Math.round(Number(n) || 0);
        var abs = Math.abs(n);
        var s = abs >= 10000 ? (Math.round(abs / 1000) / 10) + '万' : String(abs);
        return (n < 0 ? '-' : '') + s;
    }

    function oaSigned(n) {
        return (n > 0 ? '+' : '') + oaMoney(n);
    }

    function oaMood(morale) {
        for (var i = 0; i < OA_MG_MOODS.length; i++) if (morale >= OA_MG_MOODS[i].min) return OA_MG_MOODS[i];
        return OA_MG_MOODS[OA_MG_MOODS.length - 1];
    }

    function oaMgWaiting(run) {
        return run.requests.filter(function (r) { return r.status === 'pending' && !oaMgmt.byId[r.id]; });
    }

    function oaMgSave() {
        var keys = Object.keys(oaMgmt.byId);
        if (keys.length > OA_MGMT_KEEP) {
            keys.sort(function (a, b) { return (oaMgmt.byId[a].at || 0) - (oaMgmt.byId[b].at || 0); })
                .slice(0, keys.length - OA_MGMT_KEEP).forEach(function (k) { delete oaMgmt.byId[k]; });
        }
        return saveJson(OA_MGMT_KEY, oaMgmt, SOUND_SECTION);
    }

    function oaMgDecide(id, decision) {
        oaMgmt.byId[id] = { decision: decision, at: Date.now() };
        oaMgSave().then(refresh, function () {
            delete oaMgmt.byId[id];
            setNote('没保存上，再试一次。', true);
        });
    }

    // The appointment is shown as news until the 管理台 was opened once.
    function oaMgSeen(run) {
        if (oaMgmt.seen[run.companyId]) return;
        oaMgmt.seen[run.companyId] = Date.now();
        oaMgSave();
    }

    // On the workbench: the appointment, then the company at a glance.
    function oaRunCard(run) {
        var seen = !!oaMgmt.seen[run.companyId];
        var waiting = oaMgWaiting(run).length;
        var c = node('div', 'ph-card oa-exec' + (seen ? '' : ' fresh'));
        c.style.background = OA_EXEC_BG;
        var head = c.appendChild(node('div', 'ph-row'));
        var title = head.appendChild(node('div', 'ph-who'));
        title.appendChild(node('div', 'oa-exec-kicker', seen ? '管理台' : '任命通知'));
        title.appendChild(node('div', 'oa-exec-title', seen ? run.company : '你已出任「' + run.company + '」最高负责人'));
        if (waiting) head.appendChild(node('span', 'oa-exec-badge', waiting + ' 待审批'));
        if (!seen) c.appendChild(node('div', 'oa-exec-sub', '员工的申请从今天起由你审批，公司的经营也由你负责。'));
        var kpis = node('div', 'oa-hero-kpis');
        kpis.appendChild(oaHeroKpi(oaYuan(run.cash), '公司现金', run.cash < 0));
        kpis.appendChild(oaHeroKpi(oaSigned(run.week.profit), '近 7 天利润', run.week.profit < 0));
        kpis.appendChild(oaHeroKpi(String(run.morale), '团队士气', run.morale < 40));
        c.appendChild(kpis);
        c.appendChild(node('div', 'oa-exec-go', '进入管理台 ›'));
        onTap(c, function (e) {
            e.stopPropagation();
            open('oaManage');
        });
        return c;
    }

    function oaStaffOf(desk, id) {
        for (var i = 0; i < desk.team.length; i++) if (desk.team[i].id === String(id)) return desk.team[i];
        return null;
    }

    // A face for whoever asked: their photo when they are on the team list, else their initial.
    function oaMgFace(desk, r) {
        var who = oaStaffOf(desk, r.from);
        return faceAvatar(who ? who.person : { entity_id: r.from, first_name: (r.fromName || '员').slice(-2) });
    }

    function oaMgName(desk, r) {
        var who = oaStaffOf(desk, r.from);
        return who ? fullName(who.person) : r.fromName || '员工';
    }

    function oaMgTag(kind, text) {
        var t = node('span', 'oa-tagchip', text);
        t.style.background = oaTint(kind.color, 0.16);
        t.style.color = kind.color;
        return t;
    }

    // ----- 今日任务: the day's tasks and how they go (lib/workplan.js, run.plan) -----
    function oaPlanAsk() {
        oaMgmt.planOpen = { at: Date.now() };
        oaMgSave().then(function () {
            setNote('已在游戏里打开「今日工作安排」窗口。', false);
        }, function () { setNote('没发出去，再试一次。', true); });
    }

    // Whether the person has any task today, in any slot.
    function oaPlanAny(p) {
        return (p.slots || []).some(function (s) { return (s.tasks || []).length; });
    }

    // Whether the slot's work went into the game's own work quest (lib/workplan.js syncQuests).
    var OA_QUEST = {
        sent: { text: '已排进游戏：下次派任务时换成这些', cls: 'move' }, set: { text: '已替换游戏工作任务', cls: 'good' },
        done: { text: '已替换游戏工作任务', cls: 'good' }, failed: { text: '没能写入游戏任务', cls: 'bad' },
        waiting: { text: '重启游戏后写入任务', cls: 'idle' },
        repeat: { text: '这些今天已派过，游戏每项一天只派一次', cls: 'bad' }
    };

    function oaPlanStatus(p, now, slots) {
        if (!oaPlanAny(p)) return { text: '自由安排', cls: 'pill-idle' };
        if (p.done) return { text: '已完成', cls: 'pill-work' };
        if (p.away) return { text: '不在公司', cls: 'pill-idle' };
        var started = slots.length && now !== null && now >= slots[0].from;
        if (!started) return { text: '未开始', cls: 'pill-idle' };
        if (p.on > 0 && p.on >= p.off) return { text: '进行中', cls: 'oa-pill-info' };
        return { text: '没在做', cls: 'pill-move' };
    }

    function oaMgPlanCard(data, desk, run) {
        var plan = run.plan;
        if (!plan || !(plan.tasks || []).length) return null;
        var c = card('今日任务 · 第 ' + plan.day + ' 天');
        var env = data.env || {};
        var now = typeof env.hour === 'number' ? env.hour * 60 + (env.minute || 0) : null;
        var slots = plan.slots || [];
        if (!plan.decided) {
            c.appendChild(node('div', 'oa-empty', plan.asked ? '今天的安排窗口已经弹出过，还没有确定。没安排的话，大家按自己的节奏工作。'
                : '上班前游戏里会弹出「今日工作安排」窗口，让你给每个人（包括你自己）安排今天的工作。'));
        } else {
            var ids = Object.keys(plan.people || {});
            ids.sort(function (a, b) { return (a === desk.memberId ? -1 : 0) - (b === desk.memberId ? -1 : 0); });
            if (!ids.length) c.appendChild(node('div', 'oa-empty', '今天没给任何人安排任务，大家按自己的节奏工作。'));
            ids.forEach(function (id) {
                var p = plan.people[id];
                var who = id === desk.memberId ? { person: data.member, me: true } : oaStaffOf(desk, id);
                if (!who) return;
                var row = c.appendChild(node('div', 'ph-row oa-staff oa-plan-row'));
                row.appendChild(faceAvatar(who.person));
                var w = row.appendChild(node('div', 'ph-who'));
                var line = w.appendChild(node('div', 'oa-staff-name'));
                line.appendChild(node('span', null, who.me ? '我' : fullName(who.person)));
                (p.slots || []).forEach(function (s, si) {
                    if (!(s.tasks || []).length) return;
                    var sl = w.appendChild(node('div', 'oa-plan-slot'));
                    var slotNow = slots[si] || null;
                    var slotTarget = s.target || 0;
                    var slotPct = slotTarget ? Math.min(100, Math.round((s.minutes || 0) / slotTarget * 100)) : 0;
                    var slotLive = slotNow && now !== null && now >= slotNow.from && now < slotNow.to;
                    var slotState = s.minutes >= slotTarget && slotTarget ? '已完成' : slotLive ? '进行中' : now !== null && slotNow && now < slotNow.from ? '未开始' : '未达标';
                    var slotHead = sl.appendChild(node('div', 'oa-plan-slot-head'));
                    slotHead.appendChild(node('span', 'oa-plan-slot-label', (s.label || '') + (slotNow ? ' ' + minutesToLabel(slotNow.from) + '–' + minutesToLabel(slotNow.to) : '')));
                    slotHead.appendChild(node('span', 'oa-plan-slot-state ' + (slotState === '已完成' ? 'good' : slotState === '进行中' ? 'move' : ''), slotState));
                    sl.appendChild(node('span', 'oa-plan-slot-tasks', s.tasks.map(function (t) {
                        return (t.tierName ? t.tierName + '·' : '') + t.name + (t.done ? ' ×' + t.done : '') + (t.minutes ? ' ' + t.minutes + '分' : '');
                    }).join('、')));
                    var slotTrack = sl.appendChild(node('div', 'oa-plan-slot-track'));
                    var slotFill = slotTrack.appendChild(node('div', 'oa-plan-slot-fill'));
                    slotFill.style.width = Math.max(slotPct ? 3 : 0, slotPct) + '%';
                    slotFill.style.background = slotState === '已完成' ? '#30D158' : '#0A84FF';
                    sl.appendChild(node('span', 'oa-plan-slot-meta', (s.minutes || 0) + ' / ' + slotTarget + ' 分钟' + (s.other ? ' · 其他工作 ' + s.other + ' 分钟' : '')));
                    var q = OA_QUEST[s.quest];
                    if (q) w.appendChild(node('div', 'oa-plan-quest ' + q.cls, (s.label || '') + '：' + q.text));
                });
                if (oaPlanAny(p)) {
                    var track = w.appendChild(node('div', 'oa-staff-track oa-plan-track'));
                    var fill = track.appendChild(node('div', 'oa-staff-fill'));
                    var pct = p.target ? Math.min(100, Math.round(p.on / p.target * 100)) : 0;
                    fill.style.width = Math.max(pct ? 3 : 0, pct) + '%';
                    fill.style.background = p.done ? '#30D158' : '#0A84FF';
                    w.appendChild(node('div', 'oa-staff-sub', '专心做了 ' + p.on + ' / ' + p.target + ' 分钟' +
                        (p.other ? ' · 别的工作 ' + p.other + ' 分钟' : '') + (p.points ? ' · 项目 +' + p.points + ' 点' : '') +
                        (p.bonus ? '（其中任务奖励 +' + p.bonus + '）' : '')));
                } else {
                    w.appendChild(node('div', 'oa-staff-sub', '没有指定任务' + (p.points ? ' · 项目 +' + p.points + ' 点' : '')));
                }
                var st = oaPlanStatus(p, now, slots);
                row.appendChild(node('span', 'ph-pill ' + st.cls, st.text));
            });
        }
        var acts = c.appendChild(node('div', 'oa-ap-actions'));
        var btn = acts.appendChild(node('div', 'oa-ap-btn primary', plan.decided ? '调整今天的安排' : '打开安排窗口'));
        onTap(btn, function (e) { e.stopPropagation(); oaPlanAsk(); });
        c.appendChild(node('div', 'oa-foot', '安排窗口会在游戏里弹出（不在手机上）。上午、下午分开安排；每个时段开始后，安排的工作会替换游戏随机给的「工作」任务。任务分初级、中级、高级：越难要求技能越高，每完成一次给项目加的点也越多（3 / 6 / 10）。专心做满上班时间的六成就算完成，完成的人士气会涨一点。'));
        return c;
    }

    // ----- 概览 -----

    function oaMgTile(label, value, sub, tone) {
        var t = node('div', 'oa-tile');
        t.appendChild(node('div', 'oa-tile-label', label));
        t.appendChild(node('div', 'oa-tile-val' + (tone ? ' ' + tone : ''), value));
        if (sub) t.appendChild(node('div', 'oa-tile-sub', sub));
        return t;
    }

    function oaMgChart(run) {
        var box = node('div', 'oa-chart');
        var days = run.history.slice(-7);
        var max = 1;
        days.forEach(function (h) { max = Math.max(max, h.revenue || 0, h.payroll || 0); });
        days.forEach(function (h, i) {
            var col = box.appendChild(node('div', 'oa-chart-col' + (i === days.length - 1 ? ' last' : '')));
            var bars = col.appendChild(node('div', 'oa-chart-bars'));
            bars.appendChild(node('div', 'oa-chart-bar in')).style.height = Math.max(3, Math.round((h.revenue || 0) / max * 72)) + 'px';
            bars.appendChild(node('div', 'oa-chart-bar out')).style.height = Math.max(3, Math.round((h.payroll || 0) / max * 72)) + 'px';
            col.appendChild(node('div', 'oa-chart-day', String(h.day)));
        });
        return box;
    }

    function oaMgLegend(items) {
        var l = node('div', 'oa-legend');
        items.forEach(function (x) {
            var i = l.appendChild(node('span', 'oa-legend-item'));
            i.appendChild(node('span', 'oa-legend-dot')).style.background = x[1];
            i.appendChild(node('span', null, x[0]));
        });
        return l;
    }

    function oaMgOverview(wrap, data, desk, run) {
        var today = oaMgPlanCard(data, desk, run);
        if (today) { today.className += ' oa-mg-section oa-mg-task-section'; wrap.appendChild(today); }
        var guide = card('公司经营');
        guide.className += ' oa-mg-section oa-mg-money-section';
        var finBtn = guide.appendChild(node('div', 'oa-ap-actions')).appendChild(node('div', 'oa-ap-btn primary', '查看资金明细与流水'));
        onTap(finBtn, function (e) { e.stopPropagation(); open('oaFinance'); });
        guide.appendChild(node('div', 'oa-business-line', '现金 = 上期现金 + 员工日常收入 − 工资支出 + 项目回款'));
        var todayRevenue = run.today && typeof run.today.revenue === 'number' ? run.today.revenue : 0;
        var todayPayroll = run.today && typeof run.today.payroll === 'number' ? run.today.payroll : 0;
        var todayNet = todayRevenue - todayPayroll;
        var guideRows = guide.appendChild(node('div', 'oa-business-rows'));
        [['今天日常收入', oaMoney(todayRevenue)], ['今天工资支出', oaMoney(todayPayroll)], ['今天净变化', oaSigned(todayNet)],
            ['近 7 天项目回款', oaMoney(run.week.project || 0)]].forEach(function (x) {
            var row = guideRows.appendChild(node('div', 'oa-business-row'));
            row.appendChild(node('span', null, x[0]));
            row.appendChild(node('strong', x[1].charAt(0) === '-' ? 'bad' : '', x[1]));
        });
        var current = run.project;
        if (current && current.total) {
            var project = guide.appendChild(node('div', 'oa-business-project'));
            project.appendChild(node('div', 'oa-business-project-title', '当前项目：' + current.title));
            project.appendChild(node('div', 'oa-business-project-sub', current.current + ' / ' + current.total + ' 点 · 达标线 ' + current.pass +
                ' 点 · 达标回款 ' + oaMoney(current.income) + (current.bonusMax ? '，做满最多再 +' + oaMoney(current.bonusMax) : '')));
            var track = project.appendChild(node('div', 'oa-staff-track'));
            var fill = track.appendChild(node('div', 'oa-staff-fill'));
            fill.style.width = Math.min(100, Math.round(current.current / current.total * 100)) + '%';
            fill.style.background = '#0A84FF';
        }
        guide.appendChild(node('div', 'oa-foot', '员工工作先产生项目点数；到截止时过了达标线（总点数的 70%）就算完成并回款，超过达标线的部分换成奖金，没达标不会产生项目收入。公司现金和家庭余额分开计算。'));
        wrap.appendChild(guide);
        var w = run.week;
        var c = card('经营概况');
        c.className += ' oa-mg-section oa-mg-money-section';
        var r1 = c.appendChild(node('div', 'oa-tiles'));
        r1.appendChild(oaMgTile('近 7 天日常收入', oaMoney(w.revenue - (w.project || 0)), w.days ? '不含项目回款' : ''));
        r1.appendChild(oaMgTile('近 7 天项目回款', oaMoney(w.project || 0), '达标项目才计入'));
        r1.appendChild(oaMgTile('近 7 天工资', oaMoney(w.payroll), w.days ? '日均 ' + oaMoney(w.payroll / w.days) : ''));
        var r2 = c.appendChild(node('div', 'oa-tiles'));
        r2.appendChild(oaMgTile('近 7 天利润', oaSigned(w.profit), '收入 − 工资', w.profit < 0 ? 'bad' : w.profit > 0 ? 'good' : ''));
        r2.appendChild(oaMgTile('利润率', w.revenue ? Math.round(w.profit / w.revenue * 100) + '%' : '-', '利润 ÷ 收入'));
        wrap.appendChild(c);

        var trend = card('收支走势');
        trend.className += ' oa-mg-section oa-mg-trend-section';
        if (run.history.length) {
            trend.appendChild(oaMgLegend([['收入', '#30D158'], ['工资', '#8E8E93']]));
            trend.appendChild(oaMgChart(run));
        } else {
            trend.appendChild(node('div', 'oa-empty', '过了今天就有第一天的数据。'));
        }
        wrap.appendChild(trend);

        var team = card('团队状态');
        team.className += ' oa-mg-section oa-mg-team-section';
        var head = team.appendChild(node('div', 'oa-team-head'));
        var mood = oaMood(run.morale);
        head.appendChild(node('span', 'oa-team-num', String(run.morale)));
        head.appendChild(node('span', 'oa-team-label', '平均士气 · ' + mood.text));
        var counts = OA_MG_MOODS.map(function () { return 0; });
        var ids = Object.keys(run.staff || {});
        ids.forEach(function (id) { counts[OA_MG_MOODS.indexOf(oaMood(run.staff[id].morale))]++; });
        if (ids.length) {
            var stack = team.appendChild(node('div', 'oa-stack'));
            OA_MG_MOODS.forEach(function (m, i) {
                if (!counts[i]) return;
                var seg = stack.appendChild(node('div', 'oa-stack-seg'));
                seg.style.width = (counts[i] / ids.length * 100) + '%';
                seg.style.background = m.color;
            });
            team.appendChild(oaMgLegend(OA_MG_MOODS.map(function (m, i) { return [m.text + ' ' + counts[i], m.color]; })));
        }
        team.appendChild(node('div', 'oa-foot', '团队项目是公司的主要收入；员工绩效越好、士气越高，日常收入也越多。公司的账不进家里的钱包。'));
        wrap.appendChild(team);
    }

    // ----- 项目 -----

    function oaMgProjects(wrap, data, desk, run) {
        var p = desk.project;
        var card1 = oaProjectCard(data, desk, true);
        if (card1) {
            var mineP = run.project && run.project.id === p.id ? run.project : null;
            var income = mineP ? mineP.income : p.reward * 2;
            if (income) {
                var pay = node('div', 'oa-pj-pay');
                pay.appendChild(node('span', null, mineP && mineP.pass ? '到 ' + mineP.pass + ' 点达标，公司进账' : '按时完成，公司进账'));
                pay.appendChild(node('span', 'oa-pj-pay-num', '+' + oaMoney(income)));
                card1.insertBefore(pay, card1.lastChild);
                if (mineP && mineP.bonusMax) {
                    var extra = node('div', 'oa-pj-pay');
                    extra.appendChild(node('span', null, (mineP.bonusNow ? '眼下奖金 +' + oaMoney(mineP.bonusNow) + ' · ' : '') + '做满 ' + p.total + ' 点再加'));
                    extra.appendChild(node('span', 'oa-pj-pay-num', '+' + oaMoney(mineP.bonusMax)));
                    card1.insertBefore(extra, card1.lastChild);
                }
            }
            wrap.appendChild(card1);
        } else {
            var none = card('当前项目');
            none.appendChild(node('div', 'oa-empty', '公司现在没有进行中的团队项目，下一个项目会由游戏分派。'));
            wrap.appendChild(none);
        }
        var log = (run.projectLog || []).slice().reverse();
        var past = card('项目记录');
        if (!log.length) past.appendChild(node('div', 'oa-empty', '你上任以后完成的项目会记在这里。'));
        log.forEach(function (x) {
            var row = past.appendChild(node('div', 'ph-row oa-hist'));
            row.appendChild(oaMark(x.done ? '成' : '败', x.done ? '#30D158' : '#FF453A', 'oa-req-mark'));
            var who = row.appendChild(node('div', 'ph-who'));
            who.appendChild(node('div', 'oa-req-title', x.title));
            who.appendChild(node('div', 'oa-hist-sub', [typeof x.day === 'number' ? '第 ' + x.day + ' 天' : '', x.current + ' / ' + x.total + ' 点'].filter(Boolean).join(' · ')));
            if (x.done && x.bonus) who.appendChild(node('div', 'oa-hist-sub', '含超额奖金 ' + oaMoney(x.bonus)));
            row.appendChild(node('span', 'oa-pj-income' + (x.done ? '' : ' none'), x.done ? '+' + oaMoney(x.income) : '未达标'));
        });
        wrap.appendChild(past);
        var list = run.catalogue || [];
        if (list.length) {
            var lib = card('公司项目库 · ' + list.length);
            list.forEach(function (x) {
                var row = lib.appendChild(node('div', 'ph-row oa-hist'));
                var who = row.appendChild(node('div', 'ph-who'));
                who.appendChild(node('div', 'oa-req-title', x.title));
                who.appendChild(node('div', 'oa-hist-sub', '工期 ' + x.days + ' 天 · ' + x.total + ' 点'));
                if (p && p.id === x.id) row.appendChild(node('span', 'ph-pill oa-pill-info', '进行中'));
                else row.appendChild(node('span', 'oa-pj-income', '+' + oaMoney(x.income)));
            });
            lib.appendChild(node('div', 'oa-foot', '项目由游戏按公司分派。工期越长、点数越多，回款越高；金额是达标回款，做满还能多拿一半。'));
            wrap.appendChild(lib);
        }
    }

    // ----- 审批 -----

    function oaMgApproval(data, desk, r) {
        var kind = OA_MG_KINDS[r.kind] || OA_MG_KINDS.leave;
        var who = oaStaffOf(desk, r.from);
        var box = node('div', 'oa-ap');
        var head = box.appendChild(node('div', 'ph-row'));
        head.appendChild(oaMgFace(desk, r));
        var name = head.appendChild(node('div', 'ph-who'));
        name.appendChild(node('div', 'oa-ap-name', oaMgName(desk, r)));
        name.appendChild(node('div', 'oa-ap-meta', [who && who.rankName, typeof r.day === 'number' ? '第 ' + r.day + ' 天提交' : ''].filter(Boolean).join(' · ')));
        head.appendChild(oaMgTag(kind, r.label + (r.days ? ' ' + r.days + ' 天' : '')));
        box.appendChild(node('div', 'oa-ap-quote', r.reason));
        if (r.kind === 'hire' && who) {
            var cv = box.appendChild(node('div', 'oa-cv'));
            [['职级', who.rankName || '第 ' + who.rank + ' 级'], ['绩效', oaGrade(who.evaluation || 0).g + ' · ' + (who.evaluation || 0)],
                ['日薪', String(oaBaseWage(desk, who.rank))], ['出勤', who.attendance + ' 天']].forEach(function (x) {
                var cell = cv.appendChild(node('div', 'oa-cv-cell'));
                cell.appendChild(node('div', 'oa-cv-val', x[1]));
                cell.appendChild(node('div', 'oa-cv-label', x[0]));
            });
        }
        var today = data.env && typeof data.env.day === 'number' ? data.env.day : null;
        var left = today !== null && typeof r.day === 'number' ? r.day + OA_MG_LAPSE - today : null;
        box.appendChild(node('div', 'oa-ap-note', kind.what + (left !== null && left <= 1 ? ' · 今天不处理就过期' : '')));
        var id = r.id;
        if (r.status === 'pending' && !oaMgmt.byId[id]) {
            var actions = box.appendChild(node('div', 'oa-ap-actions'));
            var no = actions.appendChild(node('div', 'oa-ap-btn', kind.no));
            var yes = actions.appendChild(node('div', 'oa-ap-btn primary', kind.yes));
            onTap(no, function (e) { e.stopPropagation(); oaMgDecide(id, 'rejected'); });
            onTap(yes, function (e) { e.stopPropagation(); oaMgDecide(id, 'approved'); });
        } else {
            box.appendChild(node('div', 'oa-ap-sent', '已提交，等系统办理…'));
        }
        return box;
    }

    function oaMgHistoryRow(desk, r) {
        var kind = OA_MG_KINDS[r.kind] || OA_MG_KINDS.leave;
        var row = node('div', 'ph-row oa-hist');
        row.appendChild(oaMark(kind.mark, kind.color, 'oa-req-mark'));
        var who = row.appendChild(node('div', 'ph-who'));
        who.appendChild(node('div', 'oa-req-title', oaMgName(desk, r) + ' · ' + r.label + (r.days ? ' ' + r.days + ' 天' : '')));
        var sub = r.effect && r.effect.text ? r.effect.text : r.reason;
        who.appendChild(node('div', 'oa-hist-sub' + (r.effect && OA_EFFECT[r.effect.state] ? ' ' + OA_EFFECT[r.effect.state] : ''), sub));
        var st = OA_MG_STATUS[r.status] || OA_MG_STATUS.pending;
        if (kind.done && kind.done[r.status]) st = { text: kind.done[r.status], cls: st.cls };
        row.appendChild(node('span', 'ph-pill ' + st.cls, st.text));
        return row;
    }

    function oaMgApprovals(wrap, data, desk, run) {
        var waiting = run.requests.filter(function (r) { return r.status === 'pending'; }).slice().reverse();
        var c = card('待审批');
        if (!waiting.length) c.appendChild(node('div', 'oa-empty', '没有待处理的申请。员工会不时来请假、谈加薪、要晋升，或者提出离职。'));
        waiting.forEach(function (r) { c.appendChild(oaMgApproval(data, desk, r)); });
        wrap.appendChild(c);
        var done = run.requests.filter(function (r) { return r.status !== 'pending'; }).slice(-8).reverse();
        if (done.length) {
            var past = card('已处理');
            done.forEach(function (r) { past.appendChild(oaMgHistoryRow(desk, r)); });
            wrap.appendChild(past);
        }
    }

    // ----- 员工 -----

    function oaMgStaffRow(data, desk, run, t) {
        var st = run.staff[t.id] || null;
        var row = node('div', 'ph-row oa-staff');
        row.appendChild(faceAvatar(t.person));
        var who = row.appendChild(node('div', 'ph-who'));
        var line = who.appendChild(node('div', 'oa-staff-name'));
        line.appendChild(node('span', null, fullName(t.person)));
        if (oaSecretaryId(run) === t.id) line.appendChild(node('span', 'oa-staff-pay sec', '秘书'));
        if (st && Math.abs((st.pay || 1) - 1) > 0.005) line.appendChild(node('span', 'oa-staff-pay', '薪 ' + Math.round(st.pay * 100) + '%'));
        if (st && oaPayPlanned(run, t.id) !== null) line.appendChild(node('span', 'oa-staff-pay next', '明日调薪'));
        if (st && st.probation) line.appendChild(node('span', 'oa-staff-pay trial', '试用'));
        who.appendChild(node('div', 'oa-staff-sub', (t.rankName || '第 ' + t.rank + ' 级') + ' · 绩效 ' + oaGrade(t.evaluation || 0).g + ' · 出勤 ' + t.attendance + ' 天'));
        if (st) {
            var m = oaMood(st.morale);
            var side = row.appendChild(node('div', 'oa-staff-mood'));
            var label = side.appendChild(node('div', 'oa-staff-mood-text', m.text));
            label.style.color = m.color;
            var track = side.appendChild(node('div', 'oa-staff-track'));
            var fill = track.appendChild(node('div', 'oa-staff-fill'));
            fill.style.width = Math.max(4, Math.min(100, st.morale)) + '%';
            fill.style.background = m.color;
        }
        onTap(row, function (e) {
            e.stopPropagation();
            oaOpenStaff(t.id);
        });
        return row;
    }

    // Whether the game may fill empty seats: the one just set here, else the service's.
    function oaAutoHire(run) {
        var mine = oaMgmt.hiring;
        return mine && typeof mine.auto === 'boolean' ? mine.auto : run.autoHire !== false;
    }

    function oaMgHiring(run) {
        var on = oaAutoHire(run);
        var c = card();
        var row = c.appendChild(node('div', 'ph-row oa-switch-row'));
        var who = row.appendChild(node('div', 'ph-who'));
        who.appendChild(node('div', 'oa-ap-name', '自动补员'));
        who.appendChild(node('div', 'oa-ap-meta', on ? '工位空了，游戏会从镇上安排新人，由你审批留不留' : '已冻结招聘：游戏不再往公司里安排人，只能你自己招（万一还有漏进来的，会被直接辞退）'));
        var sw = row.appendChild(node('div', 'oa-switch' + (on ? ' on' : '')));
        sw.appendChild(node('div', 'oa-switch-knob'));
        onTap(row, function (e) {
            e.stopPropagation();
            oaMgmt.hiring = { auto: !on, at: Date.now() };
            oaMgSave().then(refresh, function () {
                setNote('没保存上，再试一次。', true);
            });
        });
        return c;
    }

    function oaMgStaff(wrap, data, desk, run) {
        wrap.appendChild(oaMgHiring(run));
        var c = card('团队成员 · ' + desk.team.length + ' 人');
        if (!desk.team.length) c.appendChild(node('div', 'oa-empty', desk.readable ? '公司里只有你一个人。' : '公司的人员名单读不到。'));
        desk.team.forEach(function (t) { c.appendChild(oaMgStaffRow(data, desk, run, t)); });
        if (desk.team.length) c.appendChild(node('div', 'oa-foot', '点成员可以看详情、调整薪酬或发消息。'));
        wrap.appendChild(c);
    }

    // ----- one employee: their state and their pay -----
    // The manager sets pay as a share of the rank's wage (oa-mgmt.cfg pay: { <id>: { to, at } });
    // the service starts it the next game day (lib/company.js).
    var oaStaffId = null;
    var oaPayDraft = null;
    var OA_PAY_STEP = 5;
    var OA_PAY_ANSWER = { text: 'TA 私聊回应了', group: 'TA 在公司群里道了谢', none: 'TA 没有说什么', missed: 'TA 没有说什么', waiting: '等 TA 回应' };

    function oaOpenStaff(id) {
        oaStaffId = String(id);
        oaPayDraft = null;
        open('oaStaff');
    }

    function oaBaseWage(desk, rank) {
        for (var i = 0; i < desk.ladder.length; i++) if (desk.ladder[i].rank === rank) return desk.ladder[i].salary;
        return 0;
    }

    // The pay due next: the one just set here, else the service's plan, else none.
    function oaPayPlanned(run, id) {
        var mine = oaMgmt.pay[id];
        var st = run.staff[id] || {};
        if (mine && !(Number(st.plannedAt) >= Number(mine.at))) {
            return Math.abs(Number(mine.to) - (st.pay || 1)) < 0.005 ? null : Number(mine.to);
        }
        return typeof st.planned === 'number' ? st.planned : null;
    }

    function oaPaySave(id, to) {
        oaMgmt.pay[id] = { to: Math.round(to * 10000) / 10000, at: Date.now() };
        oaMgSave().then(function () {
            oaPayDraft = null;
            refresh();
        }, function () { setNote('没保存上，再试一次。', true); });
    }

    function oaMeter(label, value, color) {
        var box = node('div', 'oa-meter');
        var head = box.appendChild(node('div', 'oa-meter-head'));
        head.appendChild(node('span', null, label));
        head.appendChild(node('span', 'oa-meter-num', String(value)));
        var track = box.appendChild(node('div', 'oa-staff-track'));
        var fill = track.appendChild(node('div', 'oa-staff-fill'));
        fill.style.width = Math.max(3, Math.min(100, value)) + '%';
        fill.style.background = color;
        return box;
    }

    // A daily wage to set, as a share of a base wage: − and + by OA_PAY_STEP, or typed in.
    // The page keeps its values in ed (a global it fills on every render): a redraw keeps the old
    // buttons (morph), so a handler must read the value as it is now, not the one it was drawn with.
    var oaWageTyped = {};

    function oaWageEditor(ed) {
        var box = node('div', 'oa-wage');
        var stepper = box.appendChild(node('div', 'oa-pay-stepper'));
        var minus = stepper.appendChild(node('div', 'oa-step-btn' + (ed.draft > ed.lo ? '' : ' off'), '−'));
        var mid = stepper.appendChild(node('div', 'oa-pay-mid'));
        mid.appendChild(node('div', 'oa-pay-pct', Math.round(ed.draft * 10) / 10 + '%'));
        mid.appendChild(node('div', 'oa-pay-wage', '日薪 ' + Math.round(ed.base * ed.draft / 100)));
        var plus = stepper.appendChild(node('div', 'oa-step-btn' + (ed.draft < ed.hi ? '' : ' off'), '+'));
        var step = function (by) {
            var v = ed.view();
            var next = Math.max(v.lo, Math.min(v.hi, v.draft + by));
            if (next === v.draft) return;
            delete oaWageTyped[v.key];
            v.set(next);
        };
        onTap(minus, function (e) { e.stopPropagation(); step(-OA_PAY_STEP); });
        onTap(plus, function (e) { e.stopPropagation(); step(OA_PAY_STEP); });
        var row = box.appendChild(node('div', 'oa-wage-row'));
        row.appendChild(node('span', 'oa-wage-label', '日薪'));
        var input = row.appendChild(node('input', 'oa-wage-input'));
        input.id = 'oa-wage-' + ed.key;
        applyUiFont(input);
        input.setAttribute('maxlength', '6');
        input.setAttribute('placeholder', String(Math.round(ed.base * ed.draft / 100)));
        input.value = oaWageTyped[ed.key] !== undefined ? oaWageTyped[ed.key] : String(Math.round(ed.base * ed.draft / 100));
        input.addEventListener('input', function () { oaWageTyped[ed.view().key] = input.value; });
        var apply = function () {
            var v = ed.view();
            // The box on the page now: a redraw may have put a new one in place of this one.
            var box = document.getElementById('oa-wage-' + v.key) || input;
            var w = parseInt(String(box.value || '').replace(/[^0-9]/g, ''), 10);
            delete oaWageTyped[v.key];
            if (!w || !v.base) { refresh(); return; }
            // Exactly the wage typed, not rounded to a whole percent.
            var want = w / v.base * 100;
            var pct = Math.max(v.lo, Math.min(v.hi, want));
            if (pct !== want) setNote('日薪只能在 ' + Math.round(v.base * v.lo / 100) + ' 到 ' + Math.round(v.base * v.hi / 100) + ' 之间。', false);
            v.set(pct);
        };
        input.addEventListener('keydown', function (e) {
            if (e.keyCode === 13 || e.key === 'Enter') {
                e.preventDefault();
                apply();
            }
        });
        var set = row.appendChild(node('div', 'oa-wage-set', '设定'));
        onTap(set, function (e) { e.stopPropagation(); apply(); });
        box.appendChild(node('div', 'oa-wage-range', '可设 ' + Math.round(ed.base * ed.lo / 100) + ' ~ ' + Math.round(ed.base * ed.hi / 100) + '（基本 ' + ed.base + ' 的 ' + ed.lo + '% ~ ' + ed.hi + '%）'));
        return box;
    }

    // What the pay page and the offer page show now (filled on every render).
    var oaPayView = null;
    var oaOfferView = null;

    function renderOaStaff(data) {
        var wrap = node('div', 'oa-screen');
        wrap.appendChild(subHeader('oaStaff'));
        var desk = data.desk;
        var run = oaRun(desk);
        var t = run ? oaStaffOf(desk, oaStaffId) : null;
        if (!run || !t) return oaNotice(wrap, '找不到这名员工。');
        var st = run.staff[t.id] || { morale: 60, loyalty: 60, pay: 1, mood: '' };
        var mood = oaMood(st.morale);

        var head = card();
        var row = head.appendChild(node('div', 'ph-row oa-staff-top'));
        row.appendChild(faceAvatar(t.person));
        var who = row.appendChild(node('div', 'ph-who'));
        who.appendChild(node('div', 'oa-ap-name', fullName(t.person)));
        who.appendChild(node('div', 'oa-ap-meta', (t.rankName || '第 ' + t.rank + ' 级') + ' · 绩效 ' + oaGrade(t.evaluation || 0).g + ' · 出勤 ' + t.attendance + ' 天'));
        var tag = row.appendChild(node('span', 'oa-tagchip', mood.text));
        tag.style.background = oaTint(mood.color, 0.16);
        tag.style.color = mood.color;
        var meters = head.appendChild(node('div', 'oa-tiles'));
        meters.appendChild(oaMeter('士气', st.morale, mood.color));
        meters.appendChild(oaMeter('忠诚', st.loyalty, '#5E5CE6'));
        if (t.contact && desk.phoneOk) {
            var talk = head.appendChild(node('div', 'oa-ap-actions')).appendChild(node('div', 'oa-ap-btn', '发消息'));
            onTap(talk, function (e) {
                e.stopPropagation();
                var go = function () { smsContactId = t.id; open('chat'); };
                addOutside(data.played, t.contact, '下属').then(go, go);
            });
        }
        wrap.appendChild(head);

        var base = oaBaseWage(desk, t.rank);
        var pay = st.pay || 1;
        var planned = oaPayPlanned(run, t.id);
        var range = Array.isArray(run.payRange) ? run.payRange : [0.6, 2];
        var draft = oaPayDraft !== null ? oaPayDraft : (planned !== null ? planned : pay) * 100;
        var c = card('薪酬');
        var now = c.appendChild(node('div', 'oa-pj-nums'));
        now.appendChild(node('span', 'oa-pj-now', String(Math.round(base * pay))));
        now.appendChild(node('span', 'oa-pj-total', ' / 天 · 职级基本 ' + base + ' × ' + Math.round(pay * 100) + '%'));
        if (planned !== null) {
            var plan = c.appendChild(node('div', 'oa-pay-plan'));
            plan.appendChild(node('span', null, '已安排：明天起日薪 ' + Math.round(base * planned) + '（' + Math.round(planned * 100) + '%）'));
            var undo = plan.appendChild(node('span', 'oa-pay-undo', '撤销'));
            onTap(undo, function (e) { e.stopPropagation(); oaPaySave(t.id, pay); });
        }
        var lo = Math.round(range[0] * 100);
        var hi = Math.round(range[1] * 100);
        oaPayView = { key: 'pay-' + t.id, id: t.id, base: base, lo: lo, hi: hi, draft: draft, pay: pay,
            set: function (pct) { oaPayDraft = pct; refresh(); } };
        oaPayView.view = function () { return oaPayView; };
        c.appendChild(oaWageEditor(oaPayView));
        var diff = Math.round(base * draft / 100) - Math.round(base * pay);
        var pts = Math.abs(draft - pay * 100) < 0.05 ? 0 : draft - pay * 100;
        var effect = c.appendChild(node('div', 'oa-pay-effect'));
        if (!pts) effect.appendChild(node('div', null, '和现在一样。'));
        else {
            effect.appendChild(node('div', 'oa-pay-cost' + (diff > 0 ? ' up' : ' down'), '公司每天' + (diff > 0 ? '多支出 ' : '少支出 ') + Math.abs(diff) + '，一周 ' + Math.abs(diff * 7)));
            effect.appendChild(node('div', null, pts > 0 ? '涨薪会提振 TA 的士气和忠诚，以后士气也会稳在更高的位置。'
                : '降薪对士气和忠诚的打击比涨薪的提振更大，士气太低的人可能会提离职。'));
        }
        effect.appendChild(node('div', null, '明天生效，生效当天 TA 会来跟你说说；工资每天从公司现金里扣。'));
        var same = planned !== null ? Math.abs(draft - planned * 100) < 0.05 : !pts;
        oaPayView.same = same;
        var acts = c.appendChild(node('div', 'oa-ap-actions'));
        var reset = acts.appendChild(node('div', 'oa-ap-btn', '还原'));
        var ok = acts.appendChild(node('div', 'oa-ap-btn primary' + (same ? ' off' : ''), '确认调整'));
        onTap(reset, function (e) {
            e.stopPropagation();
            if (oaPayView) delete oaWageTyped[oaPayView.key];
            oaPayDraft = null;
            refresh();
        });
        onTap(ok, function (e) {
            e.stopPropagation();
            var v = oaPayView;
            if (!v || v.same) return;
            oaPaySave(v.id, v.draft / 100);
        });
        c.appendChild(node('div', 'oa-foot', '公司现金 ' + oaYuan(run.cash) + '。'));
        wrap.appendChild(c);

        var log = (run.payLog || []).filter(function (x) { return x.id === t.id; }).slice().reverse();
        if (log.length) {
            var past = card('调薪记录');
            log.forEach(function (x) {
                var up = x.to > x.from;
                var r = past.appendChild(node('div', 'ph-row oa-hist'));
                r.appendChild(oaMark(up ? '涨' : '降', up ? '#30D158' : '#FF9F0A', 'oa-req-mark'));
                var w = r.appendChild(node('div', 'ph-who'));
                w.appendChild(node('div', 'oa-req-title', (x.wageFrom && x.wageTo ? x.wageFrom + ' → ' + x.wageTo : Math.round(x.from * 100) + '% → ' + Math.round(x.to * 100) + '%')));
                w.appendChild(node('div', 'oa-hist-sub', (typeof x.day === 'number' ? '第 ' + x.day + ' 天起 · ' : '') + (OA_PAY_ANSWER[x.answer] || '')));
            });
            wrap.appendChild(past);
        }
        wrap.appendChild(oaSecretaryCard(data, desk, run, t));
        wrap.appendChild(oaFireCard(run, t, st));
        return wrap;
    }

    // The secretary (lib/secretary.js): named here (oa-mgmt.cfg secretary: { id, at }), and put in
    // Texts so the manager can talk to them. The one just named counts until the service says.
    function oaSecretaryId(run) {
        var mine = oaMgmt.secretary;
        var sec = run && run.secretary ? run.secretary : null;
        if (mine && !(sec && Number(sec.at) >= Number(mine.at)) && Date.now() - Number(mine.at) < 60000) return mine.id ? String(mine.id) : '';
        return sec && sec.id ? String(sec.id) : '';
    }

    function oaSecretaryCard(data, desk, run, t) {
        var c = card('秘书');
        var isSec = oaSecretaryId(run) === t.id;
        if (isSec) {
            c.appendChild(node('div', 'oa-pay-effect', fullName(t.person) + ' 是你的秘书：每天早上发消息汇报公司的钱和经营情况，给你建议；你在聊天里让 TA 辞退谁、给哪位求职者发 offer、找谁谈谈心，TA 会去办，办完来告诉你。'));
            var log = (run.secretary && run.secretary.log) || [];
            if (log.length) {
                var past = c.appendChild(node('div', 'oa-business-rows'));
                log.slice().reverse().forEach(function (x) {
                    var row = past.appendChild(node('div', 'oa-business-row'));
                    row.appendChild(node('span', null, ({ fire: '辞退 ', hire: 'offer：', talk: '谈话：' }[x.do] || '') + x.name));
                    row.appendChild(node('strong', x.state === 'failed' ? 'bad' : 'plain', x.text || ''));
                });
            }
        } else {
            c.appendChild(node('div', 'oa-pay-effect', '任命 TA 当秘书：每天汇报财务、给经营建议，还能在聊天里替你办辞退、招聘，找员工谈话。' +
                (oaSecretaryId(run) ? '现在的秘书会被换下来。' : '')));
        }
        var acts = c.appendChild(node('div', 'oa-ap-actions'));
        if (isSec && t.contact && desk.phoneOk) {
            var talk = acts.appendChild(node('div', 'oa-ap-btn', '找秘书聊聊'));
            onTap(talk, function (e) {
                e.stopPropagation();
                var go = function () { smsContactId = t.id; open('chat'); };
                addOutside(data.played, t.contact, '秘书').then(go, go);
            });
        }
        var btn = acts.appendChild(node('div', 'oa-ap-btn' + (isSec ? '' : ' primary'), isSec ? '撤销秘书' : '任命为秘书'));
        btn.setAttribute('data-id', t.id);
        onTap(btn, function (e) {
            e.stopPropagation();
            var id = btn.getAttribute('data-id');
            var now = oaSecretaryId(oaRun(desk)) === id;
            oaMgmt.secretary = { id: now ? '' : id, at: Date.now() };
            var person = oaStaffOf(desk, id);
            var after = function () { refresh(); };
            oaMgSave().then(function () {
                if (!now && person && person.contact && desk.phoneOk) return addOutside(data.played, person.contact, '秘书');
            }).then(after, function () { setNote('没保存上，再试一次。', true); });
        });
        return c;
    }

    // Letting someone go (oa-mgmt.cfg fire: { <id>: { at } }; lib/company.js takeFire): asked once
    // more before it is sent. st.leaving: { state: applying | failed, text } from the service.
    var oaFireArm = null;

    function oaFireCard(run, t, st) {
        var c = card('人事');
        var mine = oaMgmt.fire[t.id];
        var sent = mine && !(Number(st.leavingAt) >= Number(mine.at));
        var leaving = st.leaving || null;
        if (sent || (leaving && leaving.state === 'applying')) {
            c.appendChild(node('div', 'oa-pay-effect', '正在办理离职，办完后 TA 会离开公司。'));
            return c;
        }
        if (leaving && leaving.state === 'failed') c.appendChild(node('div', 'oa-pay-cost down', '上次没办成：' + (leaving.text || '')));
        var armed = oaFireArm === t.id;
        c.appendChild(node('div', 'oa-pay-effect', armed
            ? '确定辞退 ' + fullName(t.person) + ' 吗？TA 会在游戏里离开公司，其他员工的士气会受点影响。'
            : '辞退后 TA 会在游戏里离开公司，空出的工位可以再招人。'));
        var acts = c.appendChild(node('div', 'oa-ap-actions'));
        if (armed) {
            var back = acts.appendChild(node('div', 'oa-ap-btn', '再想想'));
            onTap(back, function (e) { e.stopPropagation(); oaFireArm = null; refresh(); });
        }
        var go = acts.appendChild(node('div', 'oa-ap-btn' + (armed ? ' danger' : ''), armed ? '确认辞退' : '辞退'));
        go.setAttribute('data-id', t.id);
        onTap(go, function (e) {
            e.stopPropagation();
            var id = go.getAttribute('data-id');
            if (oaFireArm !== id) { oaFireArm = id; refresh(); return; }
            oaFireArm = null;
            oaMgmt.fire[id] = { at: Date.now() };
            oaMgSave().then(refresh, function () { setNote('没保存上，再试一次。', true); });
        });
        return c;
    }

    // ----- 招聘: résumés from town and offers (lib/recruit.js) -----
    // run.recruit: { vacancy, jobName, pool: [{ id, name, first, gender, age, site, traits, skills,
    // key, fit, expect, letter, offer }], offers: [{ id, name, pay, expect, status, reply, note }] };
    // an offer goes in oa-mgmt.cfg offers: { <id>: { pay, at } }.
    var oaCandId = null;
    var oaOfferDraft = null;
    var OA_OFFER_STATUS = {
        sent: { text: '已发送', cls: 'pill-move' }, pending: { text: '等回复', cls: 'pill-move' },
        accepted: { text: '已入职', cls: 'pill-work' }, declined: { text: '婉拒了', cls: 'pill-late' },
        failed: { text: '没办成', cls: 'pill-idle' }
    };

    function oaRecruitOf(run) {
        var r = run.recruit || {};
        return { vacancy: typeof r.vacancy === 'number' ? r.vacancy : null, jobName: r.jobName || '',
            pool: Array.isArray(r.pool) ? r.pool : [], offers: Array.isArray(r.offers) ? r.offers : [] };
    }

    // Where an offer to this applicant stands: the service's answer, else one just sent from here.
    function oaOfferState(a) {
        var mine = oaMgmt.offers[a.id];
        var theirs = a.offer;
        if (mine && !(Number(a.offeredAt) >= Number(mine.at)) && !(theirs && theirs.status === 'pending')) return { status: 'sent', pay: mine.pay };
        return theirs || null;
    }

    function oaFitColor(fit) {
        return fit >= 75 ? '#30D158' : fit >= 50 ? '#0A84FF' : fit >= 30 ? '#FF9F0A' : '#8E8E93';
    }

    function oaFitBadge(fit) {
        var b = node('div', 'oa-fit');
        var color = oaFitColor(fit);
        b.style.borderColor = color;
        var n = b.appendChild(node('div', 'oa-fit-num', String(fit)));
        n.style.color = color;
        b.appendChild(node('div', 'oa-fit-label', '匹配'));
        return b;
    }

    function oaCandFace(a) {
        return faceAvatar({ entity_id: a.id, first_name: a.first || a.name.slice(-1) });
    }

    function oaOpenCand(id) {
        oaCandId = String(id);
        oaOfferDraft = null;
        open('oaCand');
    }

    function oaMgRecruit(wrap, data, desk, run) {
        var rc = oaRecruitOf(run);
        var head = card('招聘');
        var seats = head.appendChild(node('div', 'oa-pj-nums'));
        seats.appendChild(node('span', 'oa-pj-now', rc.vacancy === null ? '-' : String(rc.vacancy)));
        seats.appendChild(node('span', 'oa-pj-total', ' 个空着的入门工位' + (rc.jobName ? ' · ' + rc.jobName : '')));
        head.appendChild(node('div', 'oa-pay-effect', '新人从入门职级入职，只能坐入门工位：工位满了就招不进来（以免把现有员工挤出公司）。每天都会有镇上没工作的人投来简历，几天没回音就会另谋出路。发 offer 时自己定日薪：给得越接近 TA 的期望，越可能答应。' +
            (oaAutoHire(run) ? '「自动补员」开着，游戏也会往空位安排人；想全由自己招，可以在「员工」页关掉。' : '')));
        wrap.appendChild(head);

        var list = card('求职者 · ' + rc.pool.length);
        if (!rc.pool.length) list.appendChild(node('div', 'oa-empty', '今天还没有人投简历，明天再来看看。'));
        rc.pool.forEach(function (a) {
            var row = list.appendChild(node('div', 'ph-row oa-staff'));
            row.appendChild(oaCandFace(a));
            var who = row.appendChild(node('div', 'ph-who'));
            var line = who.appendChild(node('div', 'oa-staff-name'));
            line.appendChild(node('span', null, a.name));
            var st = oaOfferState(a);
            if (st && OA_OFFER_STATUS[st.status]) line.appendChild(node('span', 'oa-staff-pay next', OA_OFFER_STATUS[st.status].text));
            who.appendChild(node('div', 'oa-staff-sub', [a.gender, a.age, a.key ? a.key.name + ' ' + a.key.level + ' 级' : '',
                a.skills && a.skills[0] && (!a.key || a.skills[0].id !== a.key.id) ? a.skills[0].name + ' ' + a.skills[0].level + ' 级' : ''].filter(Boolean).join(' · ')));
            row.appendChild(oaFitBadge(a.fit || 0));
            onTap(row, function (e) {
                e.stopPropagation();
                oaOpenCand(a.id);
            });
        });
        wrap.appendChild(list);

        var sent = rc.offers.filter(function (o) { return o.status !== 'pending'; }).slice().reverse();
        if (sent.length) {
            var past = card('Offer 记录');
            sent.forEach(function (o) {
                var row = past.appendChild(node('div', 'ph-row oa-hist'));
                var who = row.appendChild(node('div', 'ph-who'));
                who.appendChild(node('div', 'oa-req-title', o.name + ' · 日薪 ' + Math.round(o.pay * 100) + '%'));
                who.appendChild(node('div', 'oa-hist-sub', o.reply ? '「' + o.reply + '」' : o.note || ''));
                var st = OA_OFFER_STATUS[o.status] || OA_OFFER_STATUS.pending;
                row.appendChild(node('span', 'ph-pill ' + st.cls, st.text));
            });
            wrap.appendChild(past);
        }
    }

    function oaSkillRow(s, key) {
        var row = node('div', 'oa-skill' + (key ? ' key' : ''));
        row.appendChild(node('div', 'oa-skill-name', s.name));
        var track = row.appendChild(node('div', 'oa-pj-mini'));
        var fill = track.appendChild(node('div', 'oa-pj-mini-fill'));
        fill.style.width = Math.round(Math.max(0, Math.min(10, s.level)) * 10) + '%';
        fill.style.background = key ? '#FF9F0A' : '#5E5CE6';
        row.appendChild(node('div', 'oa-skill-lv', s.level + ' 级'));
        return row;
    }

    function oaOfferChance(pay, expect) {
        var gap = pay - expect;
        if (gap >= 0.1) return { text: '很可能答应', color: '#30D158' };
        if (gap >= 0) return { text: '有希望', color: '#0A84FF' };
        if (gap >= -0.1) return { text: '有点悬', color: '#FF9F0A' };
        return { text: '多半会拒', color: '#FF453A' };
    }

    function renderOaCand(data) {
        var wrap = node('div', 'oa-screen');
        wrap.appendChild(subHeader('oaCand'));
        var desk = data.desk;
        var run = oaRun(desk);
        var rc = run ? oaRecruitOf(run) : null;
        var a = null;
        if (rc) rc.pool.forEach(function (x) { if (x.id === oaCandId) a = x; });
        if (!a) return oaNotice(wrap, '这份简历已经撤下了。');

        var head = card();
        var row = head.appendChild(node('div', 'ph-row oa-staff-top'));
        row.appendChild(oaCandFace(a));
        var who = row.appendChild(node('div', 'ph-who'));
        who.appendChild(node('div', 'oa-ap-name', a.name));
        who.appendChild(node('div', 'oa-ap-meta', [a.gender, a.age, a.married ? '已婚' : '', a.site ? '在' + a.site : ''].filter(Boolean).join(' · ')));
        row.appendChild(oaFitBadge(a.fit || 0));
        if (a.traits && a.traits.length) {
            var chips = head.appendChild(node('div', 'oa-cand-traits'));
            a.traits.forEach(function (t) { chips.appendChild(node('span', 'oa-trait', t)); });
        }
        head.appendChild(node('div', 'oa-ap-quote', a.letter));
        wrap.appendChild(head);

        var skills = card('能力');
        (a.skills || []).forEach(function (s) { skills.appendChild(oaSkillRow(s, a.key && s.id === a.key.id)); });
        if (!(a.skills || []).length) skills.appendChild(node('div', 'oa-empty', '没有练过什么技能。'));
        if (a.key) skills.appendChild(node('div', 'oa-foot', '橙色是公司团队项目用到的「' + a.key.name + '」，它最影响匹配度。'));
        wrap.appendChild(skills);

        var base = oaBaseWage(desk, 1);
        var st = oaOfferState(a);
        var c = card('发 Offer');
        var draft = oaOfferDraft !== null ? oaOfferDraft : Math.round((a.expect || 1) * 100);
        var hope = c.appendChild(node('div', 'oa-pj-nums'));
        hope.appendChild(node('span', 'oa-pj-now', String(Math.round(base * (a.expect || 1)))));
        hope.appendChild(node('span', 'oa-pj-total', ' / 天 · TA 的期望（入门职级基本 ' + base + ' 的 ' + Math.round((a.expect || 1) * 100) + '%）'));
        var waiting = st && (st.status === 'sent' || st.status === 'pending');
        if (st && st.status && !waiting) {
            var said = c.appendChild(node('div', 'oa-pay-plan'));
            said.appendChild(node('span', null, (OA_OFFER_STATUS[st.status] || {}).text + (st.reply ? '：「' + st.reply + '」' : st.note ? '：' + st.note : '')));
        }
        if (waiting) {
            c.appendChild(node('div', 'oa-pay-plan')).appendChild(node('span', null, '已发出日薪 ' + Math.round(base * st.pay) + '（' + Math.round(st.pay * 100) + '%）的 offer，等 TA 回复…'));
        } else {
            oaOfferView = { key: 'offer-' + a.id, id: a.id, base: base, lo: 60, hi: 200, draft: draft,
                set: function (pct) { oaOfferDraft = pct; refresh(); } };
            oaOfferView.view = function () { return oaOfferView; };
            c.appendChild(oaWageEditor(oaOfferView));
            var chance = oaOfferChance(draft / 100, a.expect || 1);
            var hint = c.appendChild(node('div', 'oa-pay-effect'));
            hint.appendChild(node('div', 'oa-pay-cost')).appendChild(node('span', null, chance.text)).style.color = chance.color;
            hint.appendChild(node('div', null, '答应后 TA 会在游戏里入职「' + (rc.jobName || '入门职位') + '」，从第一天起按这个日薪从公司现金里发工资。'));
            var full = rc.vacancy === 0;
            var acts = c.appendChild(node('div', 'oa-ap-actions'));
            oaOfferView.blocked = full || !!(st && st.status === 'accepted');
            var send = acts.appendChild(node('div', 'oa-ap-btn primary' + (oaOfferView.blocked ? ' off' : ''), full ? '没有空缺工位' : '发送 Offer'));
            onTap(send, function (e) {
                e.stopPropagation();
                var v = oaOfferView;
                if (!v || v.blocked) return;
                oaMgmt.offers[v.id] = { pay: v.draft / 100, at: Date.now() };
                oaMgSave().then(function () {
                    delete oaWageTyped[v.key];
                    oaOfferDraft = null;
                    refresh();
                }, function () { setNote('没发出去，再试一次。', true); });
            });
        }
        wrap.appendChild(c);
        return wrap;
    }

    // ----- 资金: the company's books (lib/company.js book: run.ledger, newest last) -----
    // Every amount in full, never in 万.
    var OA_FIN_KINDS = {
        start: { mark: '始', color: '#64D2FF', label: '启动资金' },
        open: { mark: '账', color: '#8E8E93', label: '开始记账' },
        revenue: { mark: '收', color: '#30D158', label: '员工日常收入' },
        payroll: { mark: '薪', color: '#FF9F0A', label: '工资' },
        project: { mark: '项', color: '#5E5CE6', label: '项目回款' },
        bonus: { mark: '奖', color: '#BF5AF2', label: '超额奖金' },
        correction: { mark: '正', color: '#FF453A', label: '更正' }
    };
    var OA_FIN_ORDER = ['revenue', 'project', 'bonus', 'start', 'payroll', 'correction'];
    var oaFinRange = 'week';
    var oaFinFilter = 'all';
    var oaFinOpen = {};

    // 48213 -> "48,213"; signed: "+48,213" / "-48,213".
    function oaYuan(n, signed) {
        n = Math.round(Number(n) || 0);
        var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (n < 0 ? '-' : signed && n > 0 ? '+' : '') + s;
    }

    function oaFinName(run, desk, id) {
        var t = oaStaffOf(desk, id);
        if (t && t.person) return fullName(t.person);
        return (run.names && run.names[id]) || '员工 ' + id;
    }

    // The entries of the period: today (the last game day in the books), the last 7 days, or all.
    function oaFinEntries(run) {
        var list = (run.ledger || []).filter(function (e) { return e.kind !== 'open'; });
        if (oaFinRange === 'all') return list;
        var last = typeof run.lastDay === 'number' ? run.lastDay : null;
        list.forEach(function (e) { if (typeof e.day === 'number' && (last === null || e.day > last)) last = e.day; });
        if (last === null) return list;
        var from = oaFinRange === 'today' ? last : last - 6;
        return list.filter(function (e) { return typeof e.day === 'number' && e.day >= from; });
    }

    function oaFinSeg(items, now, set) {
        var seg = node('div', 'oa-fin-seg');
        items.forEach(function (x) {
            var item = seg.appendChild(node('div', 'oa-fin-seg-item' + (now === x[0] ? ' on' : ''), x[1]));
            onTap(item, function (e) { e.stopPropagation(); set(x[0]); refresh(); });
        });
        return seg;
    }

    function renderOaFinance(data) {
        var wrap = node('div', 'oa-screen');
        wrap.appendChild(subHeader('oaFinance'));
        var desk = data.desk;
        var run = oaRun(desk);
        if (!run) return oaNotice(wrap, '只有管理公司的人才能看公司资金。');
        var ledger = run.ledger || [];

        var hero = node('div', 'ph-card oa-fin-hero');
        hero.style.background = OA_EXEC_BG;
        hero.appendChild(node('div', 'oa-exec-kicker', run.company + ' · 公司现金'));
        hero.appendChild(node('div', 'oa-fin-cash' + (run.cash < 0 ? ' bad' : ''), oaYuan(run.cash)));
        var first = ledger.length ? ledger[0] : null;
        hero.appendChild(node('div', 'oa-fin-since', [typeof run.lastDay === 'number' ? '截至第 ' + run.lastDay + ' 天' : '',
            first && typeof first.day === 'number' ? '第 ' + first.day + ' 天开始记账' : ''].filter(Boolean).join(' · ')));
        wrap.appendChild(hero);

        // The period: totals by kind.
        var sum = card('收支汇总');
        sum.appendChild(oaFinSeg([['today', '今天'], ['week', '近 7 天'], ['all', '全部记录']], oaFinRange, function (v) { oaFinRange = v; }));
        var entries = oaFinEntries(run);
        var byKind = {};
        var inSum = 0;
        var outSum = 0;
        entries.forEach(function (e) {
            byKind[e.kind] = (byKind[e.kind] || 0) + e.amount;
            if (e.amount > 0) inSum += e.amount; else outSum += e.amount;
        });
        var tiles = sum.appendChild(node('div', 'oa-tiles'));
        tiles.appendChild(oaMgTile('收入', oaYuan(inSum, true), '', 'good'));
        tiles.appendChild(oaMgTile('支出', oaYuan(outSum), '', outSum < 0 ? 'bad' : ''));
        tiles.appendChild(oaMgTile('净变化', oaYuan(inSum + outSum, true), '', inSum + outSum < 0 ? 'bad' : inSum + outSum > 0 ? 'good' : ''));
        var rows = sum.appendChild(node('div', 'oa-business-rows'));
        var any = false;
        OA_FIN_ORDER.forEach(function (k) {
            if (!byKind[k]) return;
            any = true;
            var row = rows.appendChild(node('div', 'oa-business-row'));
            row.appendChild(node('span', null, OA_FIN_KINDS[k].label));
            row.appendChild(node('strong', byKind[k] < 0 ? 'bad' : '', oaYuan(byKind[k], true)));
        });
        if (!any) rows.appendChild(node('div', 'oa-empty', '这段时间还没有进出账。'));
        wrap.appendChild(sum);

        // Wages now, by person (the last payday).
        var pay = null;
        for (var i = ledger.length - 1; i >= 0; i--) if (ledger[i].kind === 'payroll') { pay = ledger[i]; break; }
        if (pay && pay.lines) {
            var wc = card('每日工资 · 第 ' + pay.day + ' 天');
            pay.lines.slice().sort(function (a, b) { return a.amount - b.amount; }).forEach(function (l) {
                var row = wc.appendChild(node('div', 'oa-business-row'));
                row.appendChild(node('span', null, oaFinName(run, desk, l.id) + (l.pay && Math.abs(l.pay - 1) > 0.004 ? '（' + Math.round(l.pay * 1000) / 10 + '%）' : '')));
                row.appendChild(node('strong', 'plain', oaYuan(-l.amount)));
            });
            var total = wc.appendChild(node('div', 'oa-business-row oa-fin-total'));
            total.appendChild(node('span', null, '合计'));
            total.appendChild(node('strong', 'plain', oaYuan(-pay.amount)));
            wc.appendChild(node('div', 'oa-foot', '括号里是调过的薪酬比例。工资每天从公司现金里扣。'));
            wrap.appendChild(wc);
        }

        // The books, newest first.
        var flow = card('资金流水');
        flow.appendChild(oaFinSeg([['all', '全部'], ['in', '收入'], ['out', '支出']], oaFinFilter, function (v) { oaFinFilter = v; }));
        var shown = entries.slice().reverse().filter(function (e) {
            return oaFinFilter === 'all' || (oaFinFilter === 'in' ? e.amount > 0 : e.amount < 0);
        });
        if (!shown.length) flow.appendChild(node('div', 'oa-empty', '这段时间没有这类记录。'));
        shown.forEach(function (e) {
            var kind = OA_FIN_KINDS[e.kind] || OA_FIN_KINDS.correction;
            var row = flow.appendChild(node('div', 'ph-row oa-hist oa-fin-row'));
            row.setAttribute('data-id', e.id);
            row.appendChild(oaMark(kind.mark, kind.color, 'oa-req-mark'));
            var who = row.appendChild(node('div', 'ph-who'));
            who.appendChild(node('div', 'oa-req-title', e.text || kind.label));
            who.appendChild(node('div', 'oa-hist-sub', [typeof e.day === 'number' ? '第 ' + e.day + ' 天' : '', '余额 ' + oaYuan(e.balance),
                e.lines && e.lines.length ? (oaFinOpen[e.id] ? '收起' : e.lines.length + ' 人明细 ›') : ''].filter(Boolean).join(' · ')));
            row.appendChild(node('span', 'oa-fin-amt' + (e.amount < 0 ? ' out' : ''), oaYuan(e.amount, true)));
            if (e.lines && e.lines.length) {
                onTap(row, function (ev) {
                    ev.stopPropagation();
                    var id = row.getAttribute('data-id');
                    oaFinOpen[id] = !oaFinOpen[id];
                    refresh();
                });
                if (oaFinOpen[e.id]) {
                    var box = flow.appendChild(node('div', 'oa-fin-lines'));
                    e.lines.slice().sort(function (a, b) { return Math.abs(b.amount) - Math.abs(a.amount); }).forEach(function (l) {
                        var r = box.appendChild(node('div', 'oa-business-row'));
                        r.appendChild(node('span', null, oaFinName(run, desk, l.id)));
                        r.appendChild(node('strong', l.amount < 0 ? 'bad' : '', oaYuan(l.amount, true)));
                    });
                }
            }
        });
        flow.appendChild(node('div', 'oa-foot', '员工日常收入按每人的绩效、士气算，工资按职级基本工资和调过的比例算；手机上显示最近 ' +
            (ledger.length) + ' 笔，服务最多保留 ' + (run.ledgerKept || 300) + ' 笔。'));
        wrap.appendChild(flow);
        return wrap;
    }

    // ----- the page -----

    function oaMgHead(desk, run) {
        var c = node('div', 'ph-card oa-mg-head');
        c.style.background = OA_EXEC_BG;
        c.appendChild(node('div', 'oa-exec-kicker', '管理台 · ' + desk.rankName));
        c.appendChild(node('div', 'oa-mg-company', run.company));
        var money = c.appendChild(node('div', 'oa-mg-money'));
        money.appendChild(node('span', 'oa-mg-cash', oaYuan(run.cash)));
        money.appendChild(node('span', 'oa-mg-cash-label', '公司现金 · 资金明细 ›'));
        onTap(money, function (e) { e.stopPropagation(); open('oaFinance'); });
        money.appendChild(node('span', 'oa-mg-delta' + (run.week.profit < 0 ? ' bad' : ''), '近 7 天 ' + oaSigned(run.week.profit)));
        c.appendChild(node('div', 'oa-mg-since', desk.team.length + ' 名员工' + (typeof run.appointedDay === 'number' ? ' · 第 ' + run.appointedDay + ' 天上任' : '')));
        var waiting = oaMgWaiting(run).length;
        var seg = c.appendChild(node('div', 'oa-seg'));
        [['overview', '概览'], ['projects', '项目'], ['approvals', waiting ? '审批 ' + waiting : '审批'], ['staff', '员工'], ['recruit', '招聘']].forEach(function (x) {
            var item = seg.appendChild(node('div', 'oa-seg-item' + (oaMgTab === x[0] ? ' on' : ''), x[1]));
            onTap(item, function (e) {
                e.stopPropagation();
                if (oaMgTab === x[0]) return;
                oaMgTab = x[0];
                refresh();
            });
        });
        return c;
    }

    function renderOaManage(data) {
        var wrap = node('div', 'oa-screen oa-mg-page');
        wrap.appendChild(subHeader('oaManage'));
        var desk = data.desk;
        var run = oaRun(desk);
        if (!run) return oaNotice(wrap, '只有在公司里职级最高、上面没有别人的时候，才能管理公司。');
        oaMgSeen(run);
        wrap.appendChild(oaMgHead(desk, run));
        if (oaMgTab === 'approvals') oaMgApprovals(wrap, data, desk, run);
        else if (oaMgTab === 'staff') oaMgStaff(wrap, data, desk, run);
        else if (oaMgTab === 'projects') oaMgProjects(wrap, data, desk, run);
        else if (oaMgTab === 'recruit') oaMgRecruit(wrap, data, desk, run);
        else oaMgOverview(wrap, data, desk, run);
        return wrap;
    }
