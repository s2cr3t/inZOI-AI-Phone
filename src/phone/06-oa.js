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
            cfgValue(SOUND_SECTION, OA_REQ_KEY), cfgValue(OA_SECTION, 'decisions'), cfgValue(OA_SECTION, 'impressions'), cfgValue(OA_SECTION, 'tasks')]).then(function (r) {
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
                return Promise.all([localize(keys), oaNames(ids.slice(0, OA_TEAM_MAX), contacts)]).then(function (t) {
                    return oaDesk(member, played, slot, row, org, company, rels, t[0], t[1]);
                });
            });
        });
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
                attendance: Number(m.attendanceDays) || 0,
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

    function oaMark(text, color, cls) {
        var m = node('div', 'oa-mark' + (cls ? ' ' + cls : ''), text);
        m.style.background = color;
        return m;
    }

    // ---------- the workbench (home page) ----------

    // The company's letterhead: logo, name, the member's badge and who else at home works.
    function oaBrand(data, desk) {
        var c = node('div', 'ph-card oa-brand');
        var top = node('div', 'ph-row');
        top.appendChild(oaMark(desk.company.charAt(0), accentFor(desk.company.length * 7 + desk.company.charCodeAt(0)), 'oa-logo'));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'oa-company', desk.company));
        who.appendChild(node('div', 'oa-badge', '工号 ' + desk.memberId + ' · ' + desk.job));
        top.appendChild(who);
        c.appendChild(top);
        var me = node('div', 'ph-row oa-me');
        me.appendChild(faceAvatar(data.member));
        var name = node('div', 'ph-who');
        name.appendChild(node('div', 'ph-name', fullName(data.member)));
        name.appendChild(node('div', 'ph-sub', desk.rankName + ' · 第 ' + desk.rank + ' 级'));
        me.appendChild(name);
        if (data.workers.length > 1) me.appendChild(oaPeople(data));
        c.appendChild(me);
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

    function oaKpi(value, label, tone) {
        var k = node('div', 'oa-kpi');
        k.appendChild(node('div', 'oa-kpi-val' + (tone ? ' ' + tone : ''), value));
        k.appendChild(node('div', 'oa-kpi-label', label));
        return k;
    }

    function oaBoard(desk) {
        var c = card('数据看板');
        var row = node('div', 'oa-kpis');
        var grade = oaGrade(desk.evaluation);
        row.appendChild(oaKpi(grade.g, '绩效 ' + desk.evaluation, grade.tone));
        row.appendChild(oaKpi(desk.attendance === null ? '-' : String(desk.attendance), '出勤天数'));
        row.appendChild(oaKpi(desk.leaveLeft === null ? '-' : String(desk.leaveLeft), '年假余额'));
        row.appendChild(oaKpi(String(desk.unexcused), '旷工', desk.unexcused ? 'bad' : ''));
        c.appendChild(row);
        if (desk.nextRankName) {
            var span = desk.expTo - desk.expFrom;
            var pct = span > 0 ? (desk.exp - desk.expFrom) / span * 100 : 100;
            var line = node('div', 'oa-progress-head');
            line.appendChild(node('span', null, '晋升「' + desk.nextRankName + '」'));
            line.appendChild(node('span', 'oa-progress-num', desk.exp + ' / ' + desk.expTo));
            c.appendChild(line);
            c.appendChild(bar(pct, '#FF9F0A'));
        }
        return c;
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
        grid.appendChild(oaApp('联系上级', '聊', '#0A84FF', block ? '不可用' : desk.boss ? fullName(desk.boss.person) : '', function () {
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
            var notices = oaNoticeCard(desk, data.requests);
            if (notices) wrap.appendChild(notices);
            wrap.appendChild(oaClock(data, desk));
            wrap.appendChild(oaBoard(desk));
            wrap.appendChild(oaBossCard(desk));
            wrap.appendChild(oaTaskCard(desk));
            wrap.appendChild(oaApps(data, desk));
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

