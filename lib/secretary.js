'use strict';
// The secretary of the company the player runs (company.js): one employee the manager names on
// the phone (oa-mgmt.cfg secretary: { id, at }, id '' to name nobody). The secretary
//   - is marked 秘书 in Texts, like a lover is;
//   - knows the books (the ledger), the project, the staff and the applicants, and answers the
//     manager's questions about them and gives advice on that ground (rule, in their prompt);
//   - texts the manager a report on the money once each game day, from 9:00 (report);
//   - carries out the manager's word: let an employee go, or send an applicant an offer, when the
//     manager's text says so plainly (the reply's "secretary" field: fromReply). What they did and
//     how it went is in their prompt next time, so they can tell.
// State in the company's record: c.secretary (employee id), c.secretaryLog: [{ at, day, do, id,
// name, pay?, state: applying | done | failed | sent, text }], c.reportedDay.
const teamproject = require('./teamproject');

const LOG_KEPT = 12;
const LOG_SHOWN = 5;
const REPORT_FROM_HOUR = 9;
const REPORT_UNTIL_HOUR = 21;
const APPLICANTS_SHOWN = 8;

const OFFERS_SHOWN = 5;
// News for the manager waits this long for more to come with it, and this much is kept.
const NEWS_WAIT_MS = 45000;
const NEWS_KEPT = 10;
// Joined this few game days ago: new.
const NEW_DAYS = 3;
// A talk with an employee (the manager's word): its outcome comes this long after (the talk
// itself), once a game day for each person. It may lift their morale, by GAIN_MIN to GAIN_MAX,
// more likely the lower it is and the better the secretary's own; it never lowers it.
const TALK_MS = 60000;
const TALK_CHANCE_MIN = 0.3;
const TALK_CHANCE_MAX = 0.85;
const TALK_GAIN_MIN = 4;
const TALK_GAIN_MAX = 12;
const TALK_LOYALTY = 2;
const CONTENT_MORALE = 80;
const ORDER_LABEL = { fire: '辞退 ', hire: '给 offer：', talk: '找人谈话：' };
// The manager asking the secretary to talk with someone, and naming the newcomers (hears).
const TALK_WORDS = /谈谈|谈一谈|谈一下|谈话|谈心|就谈|去谈|聊聊|聊一聊|聊一下|打打气|打气|安抚|开导|鼓励一下|做做.{0,2}工作|找.{0,8}(谈|聊)/;
const NEW_WORDS = /新人|新来的|新员工|新同事/;
// An offer as it stands (recruit.js offers[].status).
const OFFER_TEXT = { pending: '还在等对方回复', accepted: '答应了，已经入职', declined: '婉拒了', failed: '没办成' };

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const yuan = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const signed = (n) => (n > 0 ? '+' : n < 0 ? '-' : '') + yuan(Math.abs(n));

class Secretary {
    constructor(company) {
        this.company = company;
        this.log = company.log;
        this.reporting = false;
        this.rand = Math.random;
        // What each employee is doing, looked at each company tick while there is a secretary:
        // { <id>: { atWork, workTime, commute, doing, at } }.
        this.now = {};
    }

    // The staff as they are now: at work or not, and what they are doing (look, once a minute).
    async look(c, desk) {
        if (!c.secretary || !desk || !Array.isArray(desk.staff)) return;
        const d = this.company.d;
        const out = {};
        for (const s of desk.staff) {
            const [ws, cur] = await Promise.all([
                d.game.soft('career_get_work_status', { entity_id: s.id }),
                d.game.soft('interaction_get_current', { entity_id: s.id })
            ]);
            let doing = '';
            if (cur && cur.playing && cur.interaction_bag_id) {
                const task = (c.workTasks || []).find((t) => t.id === cur.interaction_bag_id);
                doing = task && task.name ? task.name
                    : d.world && typeof d.world.interactionName === 'function' ? await d.world.interactionName(cur.interaction_bag_id).catch(() => '') : '';
            }
            out[s.id] = { atWork: !!(ws && ws.is_at_work), workTime: !!(ws && ws.is_working_time), commute: !!(ws && ws.is_commute_time), doing, at: Date.now() };
        }
        this.now = out;
    }

    // How an offer came out, in words: its status, why it failed, what they said.
    offerText(o) {
        if (!o) return '';
        const said = o.reply ? '，回复说「' + String(o.reply).slice(0, 50) + '」' : '';
        return '日薪 ' + Math.round((o.pay || 1) * 100) + '%，' + (OFFER_TEXT[o.status] || o.status) + (o.status === 'failed' && o.note ? '（' + o.note + '）' : '') +
            (o.status === 'declined' || o.status === 'accepted' ? said : '');
    }

    // The offer sent to this applicant on this order (the latest one since it), or null.
    offerFor(c, id, since) {
        const offers = (c.recruit && c.recruit.offers) || [];
        for (let i = offers.length - 1; i >= 0; i--) if (offers[i].id === id && Number(offers[i].at) >= Number(since || 0) - 2000) return offers[i];
        return null;
    }

    // What came of an order, as it stands now: a hire order follows its offer.
    orderText(c, x) {
        if (x.do !== 'hire' || x.state === 'failed') return x.text || '';
        const o = this.offerFor(c, x.id, x.at);
        return o ? this.offerText(o) : x.text || '';
    }

    // One employee's day so far: where they are, and their planned tasks (workplan.view).
    dayLine(c, id, plan) {
        const n = this.now[id];
        let where = '';
        if (n) {
            where = n.atWork ? '在公司' + (n.doing ? '，正在「' + n.doing + '」' : '，闲着')
                : n.commute ? '在上班路上' : n.workTime ? '上班时间不在公司' + (n.doing ? '（在「' + n.doing + '」）' : '') : '不在上班时间';
        }
        const p = plan && plan.people && plan.people[id];
        let tasks = '';
        if (plan && plan.decided && p) {
            const parts = p.slots.filter((s) => s.tasks.length).map((s) => s.label + '：' + s.tasks.map((t) => t.name + (t.done ? ' 做完 ' + t.done + ' 次' : '')).join('、') +
                '（' + s.minutes + ' / ' + s.target + ' 分钟）');
            tasks = parts.length ? '今天的任务 ' + parts.join('；') + '；合计 ' + p.on + ' / ' + p.target + ' 分钟' + (p.done ? '，已达标' : '') + (p.bonus ? '，项目加分 ' + p.bonus : '') +
                (p.off ? '，摸鱼 ' + p.off + ' 分钟' : '') : '今天没给 TA 排任务';
        } else if (plan && plan.decided) {
            tasks = '今天没给 TA 排任务';
        } else if (plan && plan.day !== undefined) {
            tasks = '今天的任务还没排';
        }
        return [where, tasks].filter(Boolean).join('；');
    }

    // The manager's choice from the phone.
    take(c, value) {
        if (!isObject(value) || !(Number(value.at) > (c.secretaryAt || 0))) return false;
        c.secretaryAt = Number(value.at);
        const id = value.id ? String(value.id) : '';
        if (id && !c.staff[id]) return false;
        if (id === (c.secretary || '')) return false;
        if (id) {
            c.secretary = id;
            delete c.reportedDay;
            this.log.info('company: ' + id + ' is the secretary of ' + c.cid);
        } else {
            this.log.info('company: ' + c.cid + ' has no secretary now');
            delete c.secretary;
        }
        return true;
    }

    is(c, id) {
        return !!(c && c.secretary && c.secretary === String(id) && c.staff[c.secretary]);
    }

    // Gone from the staff: no secretary any more.
    check(c) {
        if (c.secretary && !c.staff[c.secretary]) {
            this.log.info('company: the secretary ' + c.secretary + ' left ' + c.cid);
            delete c.secretary;
        }
    }

    // The books of a game day: { revenue, payroll, project, net }.
    dayFigures(c, day) {
        const out = { revenue: 0, payroll: 0, project: 0, net: 0 };
        for (const e of c.ledger || []) {
            if (e.day !== day || e.kind === 'open' || e.kind === 'start') continue;
            if (e.kind === 'revenue') out.revenue += e.amount;
            else if (e.kind === 'payroll') out.payroll += e.amount;
            else if (e.kind === 'project' || e.kind === 'bonus') out.project += e.amount;
            out.net += e.amount;
        }
        return out;
    }

    // What the secretary knows, for their prompt: the money, the project, the staff, the
    // applicants, and what they were told to do.
    facts(c, desk, call) {
        const names = isObject(c.names) ? c.names : {};
        const nameOf = (id) => names[id] || '员工 ' + id;
        const rankName = (r) => (desk && desk.rankNames && desk.rankNames[r]) || '第 ' + r + ' 级';
        const lines = [];
        const day = typeof c.lastDay === 'number' ? c.lastDay : null;
        const y = day !== null ? this.dayFigures(c, day) : null;
        lines.push('- 公司现金：' + yuan(c.cash) + '。' + (y && (y.revenue || y.payroll)
            ? '第 ' + day + ' 天：日常收入 ' + yuan(y.revenue) + '，工资 ' + yuan(-y.payroll) + (y.project ? '，项目进账 ' + yuan(y.project) : '') + '，净变化 ' + signed(y.net) + '。' : ''));
        const week = (c.history || []).slice(-7);
        if (week.length) {
            const rev = week.reduce((s, x) => s + (x.revenue || 0), 0);
            const pay = week.reduce((s, x) => s + (x.payroll || 0), 0);
            lines.push('- 近 ' + week.length + ' 天：日常收入 ' + yuan(rev) + '，工资 ' + yuan(pay) + '，不算项目净 ' + signed(rev - pay) + '。');
        }
        const p = c.project;
        if (p && p.total) {
            const money = this.company.projectMoney(p);
            lines.push('- 项目「' + (p.title || p.id) + '」：' + p.current + ' / ' + p.total + ' 点，达标线 ' + money.pass + ' 点' +
                (p.deadlineMin ? '，第 ' + Math.floor(p.deadlineMin / 1440) + ' 天 ' + teamproject.clock(p.deadlineMin) + ' 截止' : '') +
                '；达标进账 ' + yuan(money.income) + '，做满再加 ' + yuan(money.bonusMax) + '。');
        }
        const pending = (c.requests || []).filter((r) => r.status === 'pending');
        if (pending.length) lines.push('- 待' + call + '审批的申请 ' + pending.length + ' 件。');
        const staff = desk && Array.isArray(desk.staff) ? desk.staff : [];
        const plan = this.company.workplan.view(c);
        if (staff.length) {
            lines.push('- 员工（编号：名字，职级，士气，薪酬，出勤；下一行是此刻在做什么、今天的任务做得怎样）：');
            for (const s of staff) {
                const st = c.staff[s.id] || {};
                const joined = typeof s.joinedDay === 'number' ? '，第 ' + s.joinedDay + ' 天入职' + (day !== null && day - s.joinedDay <= NEW_DAYS ? '（新来的）' : '') : '';
                lines.push('  ' + s.id + '：' + nameOf(s.id) + (s.id === c.secretary ? '（你）' : '') + '，' + rankName(s.rank) + joined + '，士气 ' + (st.morale || 0) +
                    '，日薪 ' + Math.round((st.pay || 1) * 100) + '%，出勤 ' + (s.attendance || 0) + ' 天' + (s.unexcused ? '，旷工 ' + s.unexcused + ' 次' : '') + (st.probation ? '，试用期' : ''));
                const now = this.dayLine(c, s.id, plan);
                if (now) lines.push('    ' + now);
            }
            if (plan && plan.decided) lines.push('  （任务分钟数：在排给 TA 的任务上花的时间 / 达标要的时间，达标要的是那段上班时间的六成；摸鱼是上班时做和工作无关的事。）');
        }
        const rc = c.recruit || {};
        const pool = (rc.pool || []).slice(0, APPLICANTS_SHOWN);
        lines.push('- 招聘：空着的入门工位 ' + (typeof rc.vacancy === 'number' ? rc.vacancy : '不清楚') + ' 个；自动补员' + (c.autoHire === false ? '已关（游戏不往公司塞人）' : '开着') + '。');
        if (pool.length) {
            lines.push('  求职者（编号：名字，主技能，期望日薪）：');
            for (const a of pool) {
                const offer = (rc.offers || []).slice().reverse().find((o) => o.id === a.id);
                lines.push('  ' + a.id + '：' + a.name + (a.key ? '，' + a.key.name + ' ' + a.key.level + ' 级' : '') + '，期望 ' + Math.round((a.expect || 1) * 100) + '%' +
                    (offer && offer.status === 'pending' ? '（已发 offer，等回复）' : ''));
            }
        }
        // Every offer of late, whoever sent it (the manager on the phone, or you), as it came out.
        const offers = (rc.offers || []).slice(-OFFERS_SHOWN);
        if (offers.length) {
            lines.push('- 最近发出的 offer（新的在后）：');
            for (const o of offers) lines.push('  ' + (o.name || o.id) + '：' + this.offerText(o));
        }
        const log = (c.secretaryLog || []).slice(-LOG_SHOWN);
        if (log.length) {
            lines.push('- 你最近替' + call + '办的事：');
            for (const x of log) lines.push('  ' + ORDER_LABEL[x.do] + x.name + '：' + this.orderText(c, x));
        }
        return lines.join('\n');
    }

    // The secretary's part of their prompt (company.rule adds it for them).
    rule(c, desk, call) {
        return [
            '【你是' + call + '的秘书】' + call + '是公司的老板，指定你做秘书：公司的账、项目、人事你都清楚，' + call + '问起就照下面的数说，数字说原数，不要换成「万」。',
            '被问到怎么经营、或者你看出问题时，给一两条具体建议，依据下面的数（比如谁士气太低、谁总旷工、工资占收入太多、项目快到期还差多少点），别空泛。',
            '公司现在的情况：',
            this.facts(c, desk, call),
            '谁士气低、闹情绪，你可以建议' + call + '让你去找 TA 谈谈；谈一次不一定有用，一人一天谈一次。'
        ].join('\n');
    }

    // How the secretary carries out the manager's word: its own rule, next to the reply's format
    // (persona: snap.secretaryRule), with the people named.
    orderRule(c, desk, call) {
        const names = isObject(c.names) ? c.names : {};
        const staff = (desk && Array.isArray(desk.staff) ? desk.staff : []).filter((s) => s.id !== c.secretary);
        const day = typeof c.lastDay === 'number' ? c.lastDay : null;
        const fresh = staff.filter((s) => typeof s.joinedDay === 'number' && day !== null && day - s.joinedDay <= NEW_DAYS);
        const who = (s) => (names[s.id] || s.id) + '=' + s.id;
        const pool = ((c.recruit && c.recruit.pool) || []).slice(0, APPLICANTS_SHOWN);
        return '10d. secretary（你是' + call + '的秘书，替' + call + '办事）：' + call + '这次的消息让你辞退员工、给求职者发 offer、或者找员工谈话（谈谈、聊聊、打打气、安抚一下都算）时，写进 secretary，写了就算办了：' +
            '[{"do":"talk","id":"员工编号","about":"几个字"}]、[{"do":"fire","id":"员工编号"}]、[{"do":"hire","id":"求职者编号","pay":日薪比例}]（pay 不写就按对方期望）。' +
            '员工：' + (staff.length ? staff.map(who).join('、') : '没有别人') + '。' +
            (fresh.length ? call + '说「新人」指新来的：' + fresh.map(who).join('、') + (fresh.length > 1 ? '，有好几个，没说是谁就一起谈（每人写一条）。' : '。') : '') +
            (pool.length ? '求职者：' + pool.map((a) => a.name + '=' + a.id).join('、') + '。' : '') +
            '谈话是你私下找 TA 聊，用不着和 TA 在一起、用不着 TA 的联系方式、用不着等上班或手头的事做完：现在就写，回复里说你这就去找 TA，谈完你会再来告诉' + call + '结果。' +
            '这些事不要写 actions 或 promises；以前答应过要当面去找人谈的，这次写进 secretary，并在 settle 里取消那条约定。' +
            '不能辞退你自己或' + call + '；名单里对不上的人先问清楚。例：' + call + '说「去跟' + (staff[0] ? names[staff[0].id] || '某人' : '某人') + '聊聊，给 TA 打打气」→ secretary:[{"do":"talk","id":"' +
            (staff[0] ? staff[0].id : '编号') + '","about":"打气"}]，messages:["好，我这就找 TA 聊聊。"]。没有这样的吩咐就写 []。';
    }

    // The "secretary" field of their reply: the manager's word carried out.
    fromReply(c, raw, desk) {
        const list = Array.isArray(raw) ? raw : isObject(raw) ? [raw] : [];
        let n = 0;
        for (const x of list.slice(0, 3)) {
            if (!isObject(x)) continue;
            const id = String(x.id || '').replace(/[^\d]/g, '');
            if (!id) continue;
            if (x.do === 'fire') n += this.orderFire(c, id) ? 1 : 0;
            else if (x.do === 'hire') n += this.orderHire(c, id, x.pay) ? 1 : 0;
            else if (x.do === 'talk') n += this.orderTalk(c, id, x.about) ? 1 : 0;
        }
        return n;
    }

    note(c, entry) {
        c.secretaryLog = (Array.isArray(c.secretaryLog) ? c.secretaryLog : []).concat([entry]).slice(-LOG_KEPT);
        this.company.save();
        return entry;
    }

    orderFire(c, id) {
        const names = isObject(c.names) ? c.names : {};
        const entry = { at: Date.now(), day: c.lastDay, do: 'fire', id, name: names[id] || id, state: 'applying', text: '在办' };
        if (!c.staff[id] || id === c.secretary || id === String(c.manager)) {
            entry.state = 'failed';
            entry.text = !c.staff[id] ? '不是公司的员工，没办' : '不能辞退自己或老板，没办';
            this.log.info('company: the secretary was told to let ' + id + ' go: ' + entry.text);
            this.note(c, entry);
            return false;
        }
        this.note(c, entry);
        this.log.info('company: the secretary lets ' + id + ' go on the manager\'s word');
        this.company.fire(c, id, 'secretary').then((effect) => {
            entry.state = effect && effect.state === 'done' ? 'done' : 'failed';
            entry.text = !effect ? '已经在办了' : effect.state === 'done' ? '已经办完离职' : '没办成（' + (effect.text || '') + '）';
            if (effect && effect.state !== 'done') this.news(c, '老板让你辞退的 ' + entry.name + ' ' + entry.text);
            this.company.save();
        });
        return true;
    }

    // The manager's text asks for a talk (with someone named, or 「新人」): started here, not left
    // to the reply (a model talked into "I can't reach them" by its own earlier words keeps to
    // them). texts: the manager's pending texts, then their latest before those (for a bare
    // 「现在就谈」). Returns [{ id, name, started }]; started false: talked with today already.
    hears(c, texts, desk) {
        const now = (texts && texts.now) || [];
        const before = (texts && texts.before) || [];
        if (!now.some((t) => TALK_WORDS.test(t))) return [];
        const names = isObject(c.names) ? c.names : {};
        const day = typeof c.lastDay === 'number' ? c.lastDay : null;
        const staff = (desk && Array.isArray(desk.staff) ? desk.staff : Object.keys(c.staff).map((id) => ({ id })))
            .filter((s) => c.staff[s.id] && s.id !== c.secretary && s.id !== String(c.manager));
        const find = (text) => {
            const ids = staff.filter((s) => {
                const full = names[s.id] || '';
                const given = full.length >= 3 ? full.slice(1) : '';
                return (full && text.indexOf(full) >= 0) || (given && text.indexOf(given) >= 0);
            }).map((s) => s.id);
            if (!ids.length && NEW_WORDS.test(text)) {
                return staff.filter((s) => typeof s.joinedDay === 'number' && day !== null && day - s.joinedDay <= NEW_DAYS).map((s) => s.id);
            }
            return ids;
        };
        let ids = [];
        for (const t of now) ids = ids.concat(find(t));
        for (const t of before.slice().reverse()) {
            if (ids.length) break;
            if (TALK_WORDS.test(t)) ids = find(t);
        }
        const out = [];
        for (const id of Array.from(new Set(ids))) {
            const about = (now.join(' ').match(/打气|安抚|开导|鼓励|谈心/) || [''])[0];
            out.push({ id, name: names[id] || id, started: this.orderTalk(c, id, about) });
        }
        if (out.length) this.log.info('company: the secretary heard the manager ask for a talk with ' + out.map((x) => x.id + (x.started ? '' : ' (talked today)')).join(', '));
        return out;
    }

    // What may be weighing on someone, from the record: for the talk's report.
    worries(c, id) {
        const st = c.staff[id] || {};
        const out = [];
        if ((st.pay || 1) < 0.995) out.push('日薪被调低过（现在 ' + Math.round((st.pay || 1) * 100) + '%）');
        for (const r of (c.requests || []).filter((x) => x.from === id).slice(-3)) {
            const label = { leave: '请假', raise: '加薪', promote: '晋升', resign: '离职' }[r.kind];
            if (!label) continue;
            if (r.status === 'rejected') out.push(label + '申请被驳回了');
            else if (r.status === 'lapsed') out.push(label + '申请一直没人理');
            else if (r.status === 'pending') out.push('还在等' + label + '申请的结果');
        }
        if (st.probation) out.push('还在试用期，心里没底');
        return out;
    }

    // The manager's word: talk with someone (nothing is done in the game; it is settled a minute
    // later: settleTalks).
    orderTalk(c, id, about) {
        const names = isObject(c.names) ? c.names : {};
        const st = c.staff[id];
        const entry = { at: Date.now(), day: c.lastDay, do: 'talk', id, name: names[id] || id, about: String(about || '').slice(0, 30), state: 'applying', text: '在谈' };
        const talked = (c.secretaryLog || []).some((x) => x.do === 'talk' && x.id === id && x.day === c.lastDay && x.state !== 'failed');
        if (!st || id === c.secretary || id === String(c.manager) || talked) {
            entry.state = 'failed';
            entry.text = !st ? '不是公司的员工，没谈' : talked ? '今天已经谈过了，没再谈' : '不能找自己或老板谈，没谈';
            this.log.info('company: the secretary was told to talk with ' + id + ': ' + entry.text);
            this.note(c, entry);
            return false;
        }
        entry.before = st.morale;
        entry.dueAt = Date.now() + TALK_MS;
        this.log.info('company: the secretary talks with ' + id + ' on the manager\'s word');
        this.note(c, entry);
        return true;
    }

    // Talks that are over: their outcome, told to the manager.
    settleTalks(c) {
        const sec = c.staff[c.secretary] || {};
        let any = false;
        for (const x of c.secretaryLog || []) {
            if (x.do !== 'talk' || x.state !== 'applying' || Date.now() < (x.dueAt || 0)) continue;
            any = true;
            const st = c.staff[x.id];
            if (!st) {
                x.state = 'failed';
                x.text = 'TA 已经不在公司了';
                continue;
            }
            const before = st.morale;
            const room = Math.max(0, 100 - before);
            const chance = Math.max(TALK_CHANCE_MIN, Math.min(TALK_CHANCE_MAX, 0.55 + (60 - before) / 150 + ((sec.morale || 60) - 60) / 200));
            const lifted = before < CONTENT_MORALE && room > 0 && this.rand() < chance;
            const gain = lifted ? Math.min(room, TALK_GAIN_MIN + Math.floor(this.rand() * (TALK_GAIN_MAX - TALK_GAIN_MIN + 1))) : 0;
            st.morale = before + gain;
            if (lifted) st.loyalty = Math.min(100, (st.loyalty || 60) + TALK_LOYALTY);
            x.state = 'done';
            x.after = st.morale;
            x.gain = gain;
            x.text = lifted ? '谈完了，TA 心情好了些（士气 ' + before + ' → ' + st.morale + '）'
                : before >= CONTENT_MORALE ? '谈完了，TA 本来状态就不错（士气 ' + before + '）' : '谈完了，TA 没怎么松口，状态没变（士气 ' + before + '）';
            const worries = this.worries(c, x.id);
            this.news(c, '老板让你找 ' + x.name + ' 谈' + (x.about ? '「' + x.about + '」' : '') + '，' + x.text + '。' +
                (worries.length ? 'TA 心里的事：' + worries.join('、') + '。' : '') + '跟老板说说谈得怎样，没谈通的话给个能做的建议。');
            this.log.info('company: the secretary\'s talk with ' + x.id + ': ' + (lifted ? '+' + gain : 'no change'));
        }
        if (any) this.company.save();
    }

    orderHire(c, id, pay) {
        const r = this.company.recruit.state(c);
        const a = r.pool.find((x) => x.id === id);
        const entry = { at: Date.now(), day: c.lastDay, do: 'hire', id, name: a ? a.name : id, state: 'sent', text: '' };
        if (!a) {
            entry.state = 'failed';
            entry.text = '不在求职者名单里，没发';
        } else if (!(Number(r.vacancy) > 0)) {
            entry.state = 'failed';
            entry.text = '入门工位满了，没发';
        } else {
            const p = Number(pay) > 0 ? Number(pay) : a.expect || 1;
            entry.pay = p;
            if (this.company.recruit.takeOffers(c, { [id]: { pay: p, at: Date.now() } })) {
                entry.text = '发了 offer，日薪 ' + Math.round(p * 100) + '%，等对方回复';
            } else {
                entry.state = 'failed';
                entry.text = '已经发过、还在等回复';
            }
        }
        this.log.info('company: the secretary\'s offer to ' + id + ': ' + entry.text);
        this.note(c, entry);
        return entry.state === 'sent';
    }

    // Something about the staff the manager would want to hear of: told by the secretary in a text
    // of their own, a few together (tell). c.secretaryNews: [{ at, text }], until told.
    news(c, text) {
        if (!c || !c.secretary || !text) return;
        c.secretaryNews = (Array.isArray(c.secretaryNews) ? c.secretaryNews : []).concat([{ at: Date.now(), text }]).slice(-NEWS_KEPT);
        this.company.save();
    }

    // The news gathered (NEWS_WAIT_MS after the first, so what comes together goes together).
    async tell(c) {
        const list = Array.isArray(c.secretaryNews) ? c.secretaryNews : [];
        if (!list.length || this.reporting || !c.secretary || !c.staff[c.secretary]) return;
        if (Date.now() - list[0].at < NEWS_WAIT_MS) return;
        const d = this.company.d;
        if (typeof d.staffText !== 'function') return;
        const items = list.slice();
        const reason = '你是老板的秘书，人事上有新情况，主动告诉老板：\n' + items.map((x) => '- ' + x.text).join('\n') +
            '\n简短说清楚，像秘书发微信那样；需要老板拿主意的（比如再招一个、要不要加价再试），顺口问一句。';
        this.reporting = true;
        try {
            const how = await d.staffText(c.manager, c.secretary, reason, { companyId: c.cid });
            if (how === 'text' || how === 'none') {
                c.secretaryNews = (c.secretaryNews || []).filter((x) => items.indexOf(x) < 0);
                this.log.info('company: the secretary told the manager ' + items.length + ' piece(s) of news: ' + how);
                this.company.save();
            }
        } finally {
            this.reporting = false;
        }
    }

    // Once each game day from 9:00, a report on the money with one piece of advice, as a text
    // (daemon.staffText; tried again on the next tick while the chat is busy).
    async report(c, env) {
        if (!c.secretary || !c.staff[c.secretary] || this.reporting) return;
        const day = env && typeof env.day === 'number' ? env.day : null;
        const hour = Number(env && env.hour);
        if (day === null || c.reportedDay === day || hour < REPORT_FROM_HOUR || hour >= REPORT_UNTIL_HOUR) return;
        const d = this.company.d;
        if (typeof d.staffText !== 'function') return;
        // A day's takings and wages go in the books as it begins (company.newDay).
        const f = this.dayFigures(c, day);
        const p = c.project;
        const money = p && p.total ? this.company.projectMoney(p) : null;
        const pending = (c.requests || []).filter((r) => r.status === 'pending').length;
        const reason = '你是老板的秘书，早上给老板发今天的汇报。今天（第 ' + day + ' 天）入账：日常收入 ' + yuan(f.revenue) + '，工资 ' + yuan(-f.payroll) +
            (f.project ? '，项目进账 ' + yuan(f.project) : '') + '，净变化 ' + signed(f.net) + '；现在账上 ' + yuan(c.cash) + '。' +
            (p && money ? '项目「' + (p.title || p.id) + '」' + p.current + ' / ' + p.total + ' 点，达标线 ' + money.pass + ' 点。' : '') +
            (pending ? '有 ' + pending + ' 件申请等老板审批。' : '') +
            '员工此刻在做什么、任务做得怎样你也清楚：谁做得好、谁在摸鱼或没来上班，值得说就提一句。' +
            '挑重点说，最后给一条具体的经营建议（看你掌握的员工和数字）。像秘书发微信那样说，别念报表，数字用原数，不要用「万」。';
        this.reporting = true;
        try {
            const how = await d.staffText(c.manager, c.secretary, reason, { companyId: c.cid });
            if (how === 'text' || how === 'none') {
                c.reportedDay = day;
                this.log.info('company: the secretary\'s report for day ' + day + ': ' + how);
                this.company.save();
            }
        } finally {
            this.reporting = false;
        }
    }

    view(c) {
        const log = (c.secretaryLog || []).slice(-LOG_SHOWN).map((x) => {
            const o = x.do === 'hire' && x.state !== 'failed' ? this.offerFor(c, x.id, x.at) : null;
            return Object.assign({}, x, { text: this.orderText(c, x), state: o ? (o.status === 'accepted' ? 'done' : o.status === 'pending' ? 'sent' : 'failed') : x.state });
        });
        return { id: c.secretary || '', log, reportedDay: typeof c.reportedDay === 'number' ? c.reportedDay : null };
    }
}

module.exports = { Secretary };
