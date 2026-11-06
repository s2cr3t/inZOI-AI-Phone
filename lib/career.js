'use strict';
// OA requests decided by the boss in the chat, and carried out in the game.
//
// The phone's OA app files a request (leave, sick leave, remote work, promotion, resignation)
// and opens the chat with the boss. While a request waits, the boss's reply prompt gets the
// request and the company's rules for it (rule); the boss answers in words and in the reply's
// "oa" field, and fromReply turns an approval into the game's own change:
//   promote  game career_promotion, checked on the company's member list
//   leave    the game's own "call in for leave" (interaction CareerCommon_UseVacation), which
//            plays the phone call and runs ApplyCareerVacation(Business, PaidVacation)
//   sick     CareerCommon_SickLeave the same way; the game grants it only to someone who is
//            ill (a buff tagged Disease), so the rules let the boss approve only then
//   resign   the HouseholdJournal Lua mod (Zoi.CareerServer) asks FB2CareerManager to let the
//            character leave the company; requests go through its bridge/career.cfg
//            (<seq>:<character>:r:<company entity>;..., this module is its only writer) and the
//            answer comes back on the Lua log:
//              [HouseholdJournal] C <boot>,<seq>,<ok|fail>,<character>,<op>,<detail>
//   remote   no way into the game yet: approved in words only, and the phone says so
//
// Files (<phone> is the phone mod's ui/phone):
//   <phone>/saved/oa-requests.cfg  the requests. Phone only; read here. A record's retry (ms) newer
//                                  than a failed effect asks for the approval to be carried out again.
//   <phone>/oa/decisions.cfg       the boss's answers and how carrying them out went. Only here:
//     { v, byId: { <request id>: { status: approved | rejected, note, at, day, days,
//                                  effect: { state: applying | done | failed | unsupported, text } } } }
const path = require('path');
const fsx = require('./fsx');
const paths = require('./paths');

const KINDS = { leave: '请假', sick: '病假', remote: '远程办公', promote: '晋升', resign: '离职' };
const VACATION_BAG = { leave: 'CareerCommon_UseVacation', sick: 'CareerCommon_SickLeave' };
// How long the phone call for leave may take before the change is looked for in vain.
const VACATION_WAIT_MS = 120000;
const POLL_MS = 3000;
// After the call finished, how long the booking may take to show on the member list.
const FINISHED_WAIT_MS = 15000;
const ACK_TIMEOUT_MS = 5 * 60000;
const DESK_TTL_MS = 20000;
const REQUEST_KEEP_MS = 7 * 24 * 3600000;
const SICK_TAG = 'Disease';

function parseId(key) {
    const m = /(\d+)/.exec(String(key));
    return m ? m[1] : '';
}

class Career {
    constructor(daemon) {
        this.d = daemon;
        this.log = daemon.log;
        this.requestsFile = '';
        this.decisionsFile = '';
        this.queueFile = '';
        // Lua requests not answered yet: { seq, actor, op, arg, id, at }.
        this.pending = [];
        // Requests being carried out, so a second reply does not start the same change again.
        this.busy = new Set();
        this.buffTags = new Map();
    }

    configure(phoneDir) {
        this.requestsFile = path.join(phoneDir, 'saved', 'oa-requests.cfg');
        this.decisionsFile = path.join(phoneDir, 'oa', 'decisions.cfg');
        const mod = paths.findMod(paths.JOURNAL_MOD_ID);
        const file = mod ? path.join(mod, 'bridge', 'career.cfg') : '';
        if (file !== this.queueFile) {
            this.queueFile = file;
            // Nothing from an earlier run is resent: the file starts empty.
            this.pending = [];
            this.writeQueue();
        }
    }

    requests() {
        const r = fsx.readJson(this.requestsFile);
        return r.ok && r.value && Array.isArray(r.value.list) ? r.value.list : [];
    }

    decisions() {
        const r = fsx.readJson(this.decisionsFile);
        return r.ok && r.value && r.value.byId && typeof r.value.byId === 'object' ? r.value.byId : {};
    }

    saveDecision(id, patch) {
        const byId = this.decisions();
        byId[id] = Object.assign({}, byId[id] || {}, patch);
        try {
            fsx.ensureDir(path.dirname(this.decisionsFile));
            fsx.writeJson(this.decisionsFile, { v: 1, byId }, true);
        } catch (e) {
            this.log.warn('career: decisions not written: ' + e.message);
        }
        return byId[id];
    }

    setEffect(id, state, text) {
        this.saveDecision(id, { effect: { state, text: text || '', at: Date.now() } });
    }

    // Requests from player to boss that wait for an answer.
    waiting(playerId, bossId) {
        const byId = this.decisions();
        const now = Date.now();
        return this.requests().filter((r) => r && r.id && r.member === String(playerId) && String(r.boss) === String(bossId) &&
            r.status !== 'withdrawn' && !byId[r.id] && KINDS[r.kind] && now - (r.at || 0) < REQUEST_KEEP_MS);
    }

    // The member's place in the company, from the game (FB2CareerComponent, the company's
    // memberInfo and the Career table), the way the phone's OA reads it.
    async desk(memberId) {
        const g = this.d.game;
        return this.d.world.cached('oa-desk:' + memberId, DESK_TTL_MS, async () => {
            const career = await g.soft('entity_reflect', { entity_id: String(memberId), Component: 'FB2CareerComponent' });
            // Unread is not the same as no job: a resignation is checked by the job being gone.
            if (!career || !career.careerSlots) throw new Error('career of ' + memberId + ' not read');
            const slot = career.careerSlots.business;
            if (!slot || !slot.careerDtId || slot.careerDtId === 'None') return null;
            const companyId = slot.careerEntityId && slot.careerEntityId.value;
            const [company, row] = await Promise.all([
                companyId ? g.soft('entity_reflect', { entity_id: String(companyId) }) : null,
                g.soft('data_table_get', { Alias: 'Career', Row: slot.careerDtId })
            ]);
            const named = row && row.displayName ? await g.soft('l10n_get', { Keys: JSON.stringify([row.displayName]) }) : null;
            const companyName = named && typeof named[row.displayName] === 'string' && named[row.displayName] !== row.displayName ? named[row.displayName] : slot.careerDtId;
            const org = row && Array.isArray(row.organizations) ? row.organizations.find((o) => o && o.jobId === slot.jobDtId) : null;
            const ranks = (org && Array.isArray(org.rankList) ? org.rankList : []).slice().sort((a, b) => a.rank - b.rank);
            const info = company && company.memberInfo ? company.memberInfo : {};
            let mine = null;
            const team = [];
            for (const k of Object.keys(info)) {
                const pid = parseId(k);
                if (!pid || !info[k]) continue;
                if (pid === String(memberId)) mine = info[k];
                else team.push({ id: pid, rank: Number(info[k].rank) || 0 });
            }
            const rank = Number(mine ? mine.rank : slot.rank) || 0;
            const cur = ranks.find((x) => x.rank === rank) || null;
            const next = ranks.find((x) => x.rank === rank + 1) || null;
            team.sort((a, b) => b.rank - a.rank);
            const boss = team.find((t) => t.rank > rank) || null;
            return {
                companyId: companyId ? String(companyId) : '',
                rank,
                exp: Number(mine ? mine.exp : slot.exp) || 0,
                expTo: next ? Number(next.requireTotalExp) || 0 : 0,
                hasNext: !!next,
                leaveLeft: mine ? Number(mine.remainingVacationDays) || 0 : 0,
                leaveBooked: mine ? Number(mine.vacationScheduledDays) || 0 : 0,
                segments: mine && Array.isArray(mine.vacationSegments) ? mine.vacationSegments.length : 0,
                nextDay: mine ? String(mine.nextDayVacationType || 'None') : 'None',
                evaluation: Number(mine ? mine.evaluationScore : slot.evaluationScore) || 0,
                attendance: mine ? Number(mine.attendanceDays) || 0 : 0,
                unexcused: mine ? Number(mine.unexcusedAbsenceCount) || 0 : 0,
                remoteOk: !!(org && org.bCanRemoteWork),
                remoteNow: !!(mine && mine.activeWorkMode === 'Remote'),
                bossId: boss ? boss.id : '',
                team: team.map((t) => t.id),
                // For the company's work group and the tasks its boss hands out (workgroup.js).
                companyName,
                roster: team.concat([{ id: String(memberId), rank }]),
                questIds: cur && Array.isArray(cur.afterWorkQuestIdList) ? cur.afterWorkQuestIdList.filter((q) => q && q !== 'None') : []
            };
        });
    }

    // Whether the character is ill in the game: a buff whose Buff table row is tagged Disease.
    async sick(memberId) {
        const comp = await this.d.game.soft('entity_reflect', { entity_id: String(memberId), Component: 'FB2BuffComponent' });
        const ids = comp && comp.buffs ? Object.keys(comp.buffs).map((k) => comp.buffs[k] && comp.buffs[k].iD).filter(Boolean) : [];
        for (const id of ids) {
            if (!this.buffTags.has(id)) {
                const row = await this.d.game.soft('data_table_get', { Alias: 'Buff', Row: id });
                const tags = row && row.buffBasicInfo && Array.isArray(row.buffBasicInfo.tags) ? row.buffBasicInfo.tags : [];
                this.buffTags.set(id, tags);
            }
            if (this.buffTags.get(id).indexOf(SICK_TAG) >= 0) return true;
        }
        return false;
    }

    // The company's rules for one request: whether it may be granted, and why not.
    // The phone's OA shows the same rules (oaChecks in app.js).
    judge(r, desk, ill) {
        const days = Math.max(1, Number(r.days) || 1);
        const no = [];
        const facts = [];
        if (r.kind === 'leave') {
            if (desk.leaveLeft < days) no.push('年假只剩 ' + desk.leaveLeft + ' 天，不够 ' + days + ' 天');
            facts.push('年假剩 ' + desk.leaveLeft + ' 天');
        } else if (r.kind === 'sick') {
            if (!ill) no.push('看不出对方真的生病了，不能按病假批');
        } else if (r.kind === 'remote') {
            if (!desk.remoteOk) no.push('这个岗位必须到岗，不能远程');
            else if (desk.remoteNow) no.push('对方已经在远程办公了');
        } else if (r.kind === 'promote') {
            if (!desk.hasNext) no.push('对方已经是最高职级');
            else if (desk.exp < desk.expTo) no.push('经验 ' + desk.exp + '，升下一级要 ' + desk.expTo);
        }
        if (desk.unexcused) facts.push('有 ' + desk.unexcused + ' 次旷工');
        return { ok: !no.length, no, facts, days };
    }

    // The block for the boss's reply prompt while requests wait, or '' (also when the contact is
    // not the player's boss any more).
    async rule(pair, snap, call) {
        if (!pair.outsider) return '';
        const list = this.waiting(pair.playerId, pair.partnerId);
        if (!list.length) return '';
        const desk = await this.desk(pair.playerId).catch(() => null);
        if (!desk || desk.bossId !== String(pair.partnerId)) return '';
        const ill = list.some((r) => r.kind === 'sick') ? await this.sick(pair.playerId).catch(() => false) : false;
        const lines = ['【OA 审批】你是' + call + '的直属上级。' + call + '在公司 OA 上给你提交了申请，等你批：'];
        for (const r of list) {
            const j = this.judge(r, desk, ill);
            lines.push('  - 编号 ' + r.id + '：' + KINDS[r.kind] + (r.kind === 'leave' || r.kind === 'sick' ? ' ' + j.days + ' 天' : '') +
                (r.reason ? '，事由：' + r.reason : '') + '。' +
                (j.ok ? '按公司规定可以批。' : '按公司规定不能批：' + j.no.join('；') + '。'));
        }
        lines.push('  ' + call + '平时：绩效 ' + desk.evaluation + ' 分，出勤 ' + desk.attendance + ' 天' + (desk.unexcused ? '，旷工 ' + desk.unexcused + ' 次' : '') + '。');
        lines.push('  oa：' + call + '这次的消息在谈这些申请时，写你的决定 [{"id":"编号","decision":"approve 或 reject 或 later","note":"给对方看的一句批复","days":天数}]。' +
            '像真实的上级一样按你的性格、对方的表现和你们的关系来定：可以爽快批，可以刁难、追问，也可以只批少几天（days 写批的天数，只能比申请的少）。' +
            '不能批的只能 reject 或 later。还要再问清楚、想一想，或者对方没提这事，写 later 或不写。决定必须和你 messages 里说的一致：批了就说批了，没批就别说批了。');
        return lines.join('\n');
    }

    // The "oa" field of the boss's reply.
    async fromReply(pair, snap, raw) {
        const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
        if (!list.length) return;
        const waiting = this.waiting(pair.playerId, pair.partnerId);
        let desk = null;
        let ill = null;
        for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const r = waiting.find((x) => x.id === String(item.id || '').trim());
            const decision = String(item.decision || '').trim();
            if (!r || (decision !== 'approve' && decision !== 'reject')) continue;
            if (!desk) desk = await this.desk(pair.playerId).catch(() => null);
            if (!desk) {
                this.log.warn('career [' + pair.key + ']: ' + r.id + ' not decided, the job could not be read');
                continue;
            }
            if (ill === null) ill = r.kind === 'sick' ? await this.sick(pair.playerId).catch(() => false) : false;
            const j = this.judge(r, desk, ill);
            let status = decision === 'approve' ? 'approved' : 'rejected';
            let note = typeof item.note === 'string' ? item.note.trim().slice(0, 60) : '';
            if (status === 'approved' && !j.ok) {
                // The words may have said yes; the company's rules do not.
                this.log.warn('career [' + pair.key + ']: ' + r.id + ' approved against the rules (' + j.no.join('; ') + '), filed as rejected');
                status = 'rejected';
                note = note || j.no[0];
            }
            let days = j.days;
            const asked = Number(item.days);
            if (status === 'approved' && (r.kind === 'leave' || r.kind === 'sick') && asked >= 1 && asked < days) days = Math.floor(asked);
            const env = snap && snap.env;
            this.saveDecision(r.id, { status, note, at: Date.now(), day: env && typeof env.day === 'number' ? env.day : 0, days });
            // What the boss now thinks of the player for asking (workplace.js).
            if (this.d.workplace) {
                this.d.workplace.onDecision(pair.playerId, pair.partnerId, r.kind, status, j, env && env.day)
                    .catch((e) => this.log.warn('career: impression not changed: ' + e.message));
            }
            this.log.info('career [' + pair.key + ']: ' + KINDS[r.kind] + ' ' + r.id + ' ' + status + (note ? ': ' + note : ''));
            if (status === 'approved') this.carryOut(pair, r, days, desk, ill).catch((e) => {
                this.log.warn('career: ' + r.id + ' failed: ' + e.message);
                this.setEffect(r.id, 'failed', '出错了：' + e.message.slice(0, 40));
            });
            else this.toast('OA：' + KINDS[r.kind] + '申请被驳回' + (note ? '：' + note : ''));
        }
    }

    toast(text) {
        this.d.game.soft('toast_show', { Message: text, Lifetime: 6 }).catch(() => {});
    }

    async carryOut(pair, r, days, desk, ill) {
        if (this.busy.has(r.id)) return;
        this.busy.add(r.id);
        try {
            const who = String(pair.playerId);
            if (r.kind === 'promote') await this.promote(r, who, desk);
            else if (r.kind === 'leave' || r.kind === 'sick') await this.vacation(r, who, days);
            else if (r.kind === 'resign') this.resign(r, who, desk);
            else {
                this.setEffect(r.id, 'unsupported', '游戏里暂时不能切换远程办公，只是口头同意');
                this.toast('OA：远程办公申请已同意');
            }
        } finally {
            this.busy.delete(r.id);
        }
    }

    async fresh(memberId) {
        this.d.world.invalidate('oa-desk:' + memberId);
        return this.desk(memberId);
    }

    async promote(r, who, desk) {
        this.setEffect(r.id, 'applying', '正在办理晋升');
        await this.d.game.call('career_promotion', { entity_id: who });
        await new Promise((res) => setTimeout(res, 1500));
        const after = await this.fresh(who);
        if (after && after.rank > desk.rank) {
            this.d.game.soft('buff_add', { entity_id: who, buff_id: 'Buff_Job_Promotion' }).catch(() => {});
            this.d.world.invalidate('job:' + who);
            this.setEffect(r.id, 'done', '已升到第 ' + after.rank + ' 级');
            this.toast('OA：晋升申请已通过，升到第 ' + after.rank + ' 级');
            this.log.info('career: ' + who + ' promoted to rank ' + after.rank);
        } else {
            this.setEffect(r.id, 'failed', '游戏没有改职级');
            this.log.warn('career: promotion of ' + who + ' did not change the rank');
        }
    }

    // The leave as the game grants it: the character phones in (the game's own interaction) and
    // the game books the days. How many days one call books is read back, and the call is made
    // again while the days granted are not all booked and each call still books more.
    async vacation(r, who, days) {
        const bag = VACATION_BAG[r.kind];
        this.setEffect(r.id, 'applying', '正在打电话请假');
        this.toast('OA：' + KINDS[r.kind] + '申请已通过');
        let booked = 0;
        let why = '';
        for (let i = 0; i < days; i++) {
            const before = await this.fresh(who);
            if (!before) break;
            const since = Date.now();
            // A call to oneself: the game runs its Self interactions with the character as the
            // target, and without one it fails at once with NotFoundTarget.
            await this.d.game.call('interaction_execute', { entity_id: who, interaction_bag_id: bag, target_entity_id: who });
            const seen = await this.waitChange(who, before, bag, since);
            if (!seen.desk) {
                why = seen.why;
                break;
            }
            const after = seen.desk;
            const more = Math.max(after.leaveBooked - before.leaveBooked, before.leaveLeft - after.leaveLeft, 1);
            booked += more;
            this.log.info('career: ' + who + ' ' + bag + ' booked ' + more + ' day(s), ' + booked + '/' + days);
            if (booked >= days) break;
        }
        if (booked) this.setEffect(r.id, 'done', '游戏里已经请好 ' + booked + ' 天' + (booked < days ? '（批了 ' + days + ' 天）' : ''));
        else {
            this.setEffect(r.id, 'failed', why || '电话打了，游戏没有记上假');
            this.log.warn('career: ' + bag + ' for ' + who + ' booked nothing: ' + (why || 'no change'));
        }
    }

    // { desk } once the leave shows on the member list, or { why } when the call ended without it.
    // The journal tells a call that failed or was cancelled at once; a call that finished is given
    // a little longer for the booking to show.
    async waitChange(who, before, bag, since) {
        let until = Date.now() + VACATION_WAIT_MS;
        let finished = false;
        while (Date.now() < until) {
            await new Promise((res) => setTimeout(res, POLL_MS));
            const now = await this.fresh(who);
            if (!now) return { why: '读不到工作资料' };
            if (now.leaveBooked !== before.leaveBooked || now.leaveLeft !== before.leaveLeft ||
                now.segments !== before.segments || now.nextDay !== before.nextDay) return { desk: now };
            const j = this.d.journal;
            const end = j && typeof j.endOf === 'function' ? j.endOf(who, [bag], since) : null;
            if (end && end.kind !== 'finished') return { why: '电话没打成（游戏：' + (end.kind + ' ' + (end.reason || '')).trim() + '）' };
            if (end && !finished) {
                finished = true;
                until = Math.min(until, Date.now() + FINISHED_WAIT_MS);
            }
        }
        return { why: finished ? '电话打完了，游戏没有记上假' : '一直没见到打电话' };
    }

    // An approval the game did not carry out, asked again from the phone (the record's retry is
    // newer than the failure). Checked on the service's tick.
    retry() {
        const byId = this.decisions();
        for (const r of this.requests()) {
            const d = r && byId[r.id];
            if (!d || d.status !== 'approved' || !d.effect || d.effect.state !== 'failed') continue;
            if (!(Number(r.retry) > (Number(d.effect.at) || 0)) || this.busy.has(r.id)) continue;
            this.log.info('career: ' + KINDS[r.kind] + ' ' + r.id + ' carried out again from the phone');
            // Not failed any more, so the next tick does not start it a second time.
            this.setEffect(r.id, 'applying', '重新办理中');
            this.fresh(r.member).then((desk) => {
                if (!desk) throw new Error('job not found');
                return this.carryOut({ playerId: r.member }, r, Number(d.days) || 1, desk, true);
            }).catch((e) => this.setEffect(r.id, 'failed', '出错了：' + e.message.slice(0, 40)));
        }
    }

    resign(r, who, desk) {
        const j = this.d.journal;
        if (!this.queueFile || !desk.companyId || !j || !j.can('career')) {
            this.setEffect(r.id, 'failed', '互动 mod 没在运行或版本太旧，没法办离职');
            return;
        }
        const seq = String(Date.now());
        this.pending.push({ seq, actor: who, op: 'r', arg: desk.companyId, id: r.id, at: Date.now() });
        this.writeQueue();
        this.setEffect(r.id, 'applying', '正在办理离职');
        this.toast('OA：离职申请已通过');
    }

    // Another request for the Lua mod's career handler: op and arg as Zoi.CareerServer reads
    // them; done(res) gets its C line, or { ok: false, detail } when it never came.
    request(actor, op, arg, done) {
        const j = this.d.journal;
        if (!this.queueFile || !j || !j.can('career')) {
            done({ ok: false, detail: 'mod_not_running' });
            return;
        }
        const last = this.pending.reduce((m, p) => Math.max(m, Number(p.seq) || 0), 0);
        const seq = String(Math.max(Date.now(), last + 1));
        this.pending.push({ seq, actor: String(actor), op, arg, done, at: Date.now() });
        this.writeQueue();
    }

    // A C line from the Lua mod.
    async onResult(res) {
        const i = this.pending.findIndex((p) => p.seq === res.seq);
        if (i < 0) return;
        const p = this.pending.splice(i, 1)[0];
        this.writeQueue();
        if (typeof p.done === 'function') {
            p.done(res);
            return;
        }
        const after = await this.fresh(p.actor).catch(() => undefined);
        if (res.ok && after === null) {
            this.d.world.invalidate('job:' + p.actor);
            this.setEffect(p.id, 'done', '已经离职');
            this.log.info('career: ' + p.actor + ' left company ' + p.arg + ' (' + res.detail + ')');
        } else {
            this.setEffect(p.id, 'failed', '游戏没有办成离职（' + res.detail + '）');
            this.log.warn('career: ' + p.actor + ' did not leave company ' + p.arg + ': ' + res.detail);
        }
    }

    expire() {
        const now = Date.now();
        const late = this.pending.filter((p) => now - p.at >= ACK_TIMEOUT_MS);
        if (!late.length) return;
        this.pending = this.pending.filter((p) => now - p.at < ACK_TIMEOUT_MS);
        for (const p of late) {
            if (typeof p.done === 'function') p.done({ ok: false, detail: 'no_answer' });
            else this.setEffect(p.id, 'failed', '互动 mod 没有回应');
        }
        this.log.warn('career: ' + late.length + ' request(s) got no answer from the Lua mod');
        this.writeQueue();
    }

    // The Lua mod started again: whatever it had not answered is gone with the world it was for.
    reset() {
        if (!this.pending.length) return;
        for (const p of this.pending) {
            if (typeof p.done === 'function') p.done({ ok: false, detail: 'game_reloaded' });
            else this.setEffect(p.id, 'failed', '游戏重新载入了，没有办完');
        }
        this.pending = [];
        this.writeQueue();
    }

    writeQueue() {
        if (!this.queueFile) return;
        const text = this.pending.map((p) => p.seq + ':' + p.actor + ':' + p.op + ':' + p.arg).join(';');
        try {
            const now = fsx.readText(this.queueFile);
            if (now !== null && now === text) return;
            fsx.writeAtomic(this.queueFile, text);
        } catch (e) {
            this.log.warn('career: queue file not written: ' + e.message);
        }
    }
}

module.exports = { Career };
