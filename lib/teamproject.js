'use strict';
// The game's own team projects: each company works on one at a time (the company entity's
// activeTeamProject), filled in by its members' work at the office (interactions tagged
// Event_Career_Work), against a deadline. The TeamProject table holds every company's projects:
// { titleTextId, descTextId, durationDays, totalPoint, baseReward, companyId, skillId }.
//
// Times are game ticks: 10,000,000 a second from the start of day 0, so a tick count is a day and
// a time of day (day 1038 17:00 = (1038 * 86400 + 61200) * 1e7).
const TICKS_PER_MIN = 600000000;
const CATALOGUE_TTL_MS = 6 * 3600000;

const minuteOf = (ticks) => Math.floor(Number(ticks) / TICKS_PER_MIN);

function envMinute(env) {
    return env && typeof env.day === 'number' ? env.day * 1440 + (Number(env.hour) || 0) * 60 + (Number(env.minute) || 0) : null;
}

function parseId(key) {
    const m = /(\d+)/.exec(String(key));
    return m ? m[1] : '';
}

// The project the company works on now, from its entity; null when there is none.
function current(company) {
    const p = company && company.activeTeamProject;
    if (!p || !p.projectId || p.projectId === 'None') return null;
    const contributions = {};
    for (const k of Object.keys(p.memberContributions || {})) {
        const id = parseId(k);
        if (id) contributions[id] = Number(p.memberContributions[k]) || 0;
    }
    // The working day, from when the office opened today and when it closes.
    const open = company.lastOperatingStartTicks ? minuteOf(company.lastOperatingStartTicks) % 1440 : 9 * 60;
    const close = company.todayOperatingEndTicks ? minuteOf(company.todayOperatingEndTicks) % 1440 : 17 * 60;
    return {
        id: String(p.projectId),
        current: Number(p.currentPoint) || 0,
        total: Number(p.totalPoint) || 0,
        startMin: minuteOf(p.startTicks),
        deadlineMin: minuteOf(p.deadlineTicks),
        active: p.bIsActive !== false,
        contributions,
        open: close > open ? open : 9 * 60,
        close: close > open ? close : 17 * 60
    };
}

// Office minutes between two moments (game minutes from day 0).
function workMinutes(from, to, open, close) {
    if (!(to > from)) return 0;
    let sum = 0;
    for (let day = Math.floor(from / 1440); day <= Math.floor(to / 1440); day++) {
        const a = Math.max(from, day * 1440 + open);
        const b = Math.min(to, day * 1440 + close);
        if (b > a) sum += b - a;
    }
    return sum;
}

// How the project stands at a moment: { pct, timePct, pace: done | ahead | ok | behind | late, minutesLeft }.
function standing(p, now) {
    const pct = p.total ? Math.min(1, p.current / p.total) : 0;
    const all = workMinutes(p.startMin, p.deadlineMin, p.open, p.close);
    const spent = now === null ? 0 : workMinutes(p.startMin, Math.min(now, p.deadlineMin), p.open, p.close);
    const timePct = all ? spent / all : 0;
    let pace = 'ok';
    if (pct >= 1) pace = 'done';
    else if (now !== null && now >= p.deadlineMin) pace = 'late';
    else if (timePct < 0.05) pace = 'ok';
    else if (pct >= timePct + 0.1) pace = 'ahead';
    else if (pct < timePct - 0.15) pace = 'behind';
    return { pct, timePct, pace, minutesLeft: now === null ? null : p.deadlineMin - now };
}

const PACE_TEXT = { done: '已完成', ahead: '进度领先', ok: '进度正常', behind: '进度落后', late: '已过截止时间' };

function clock(min) {
    const m = ((min % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

// One line for the reply prompt of a colleague (or the boss) about the company's project.
function promptLine(p, info, playerId, partnerId, call, now) {
    if (!p || !p.active) return '';
    const s = standing(p, now);
    const title = info && info.title ? '「' + info.title + '」' : '一个团队项目';
    const mine = p.contributions[String(playerId)] || 0;
    const theirs = p.contributions[String(partnerId)] || 0;
    return '【公司项目】公司正在做' + title + '：进度 ' + p.current + ' / ' + p.total + '（' + Math.round(s.pct * 100) + '%），第 ' +
        Math.floor(p.deadlineMin / 1440) + ' 天 ' + clock(p.deadlineMin) + ' 截止，' + PACE_TEXT[s.pace] + '。' +
        '到现在你出了 ' + theirs + ' 点力，' + call + '出了 ' + mine + ' 点。聊到工作时可以自然提到，别报数字报得像报表。';
}

// The company's projects (TeamProject rows whose companyId is the career's), with their names.
async function catalogue(daemon, careerDtId) {
    if (!careerDtId) return [];
    return daemon.world.cached('teamprojects:' + careerDtId, CATALOGUE_TTL_MS, async () => {
        const g = daemon.game;
        const ids = await g.soft('data_list_rows', { Alias: 'TeamProject' });
        const mine = (Array.isArray(ids) ? ids : []).filter((id) => String(id).indexOf(careerDtId + '_') === 0);
        const rows = (await Promise.all(mine.map((id) => g.soft('data_table_get', { Alias: 'TeamProject', Row: id }))))
            .filter((r) => r && r.companyId === careerDtId);
        const keys = [];
        rows.forEach((r) => keys.push(r.titleTextId, r.descTextId));
        const text = keys.length ? await g.soft('l10n_get', { Keys: JSON.stringify(keys) }) : null;
        const say = (k) => text && typeof text[k] === 'string' && text[k] !== k ? text[k] : '';
        return rows.map((r) => ({
            id: r.iD || r._row_name, title: say(r.titleTextId) || r._row_name, desc: say(r.descTextId),
            days: Number(r.durationDays) || 0, total: Number(r.totalPoint) || 0, reward: Number(r.baseReward) || 0,
            skill: r.skillId && r.skillId !== 'None' ? String(r.skillId) : ''
        })).sort((a, b) => a.total - b.total);
    });
}

module.exports = { current, standing, workMinutes, promptLine, catalogue, envMinute, minuteOf, clock, PACE_TEXT, TICKS_PER_MIN };
