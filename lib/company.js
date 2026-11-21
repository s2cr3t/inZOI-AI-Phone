'use strict';
// Running the company: once the played character holds the company's top rank, with nobody
// above them, they manage it from the phone's OA (管理台).
//
// What is real and what is kept here:
//   staff     the company's payroll as the game lists it (memberInfo): rank, evaluation,
//             attendance. Morale, loyalty and a pay rise are this module's own.
//   requests  the staff file them with the manager (leave, a raise, a promotion, leaving), one
//             now and then on a new game day; the manager decides on the phone. A promotion
//             granted is the game's own (career_promotion); leaving is the Lua mod's
//             (Zoi.CareerServer op r, through career.js); leave and a raise are this module's
//             only (the game keeps no other character's leave for us to book).
//   figures   the company's takings, wages and cash, worked out once a game day from the staff
//             (their wage by rank, evaluation and morale). Kept here; no money reaches the game.
//
// Files (<phone> is the phone mod's ui/phone):
//   data/company.json           this module only: { v, byCompany: { <company id>: state } }
//   <phone>/oa/company.cfg      this module only, what the phone shows:
//                               { v, at, byManager: { <member id>: view } }
//   <phone>/saved/oa-mgmt.cfg   the phone only: { v, byId: { <request id>: { decision, at } },
//                               pay: { <employee id>: { to, at } }, hiring: { auto, at },
//                               offers: { <applicant id>: { pay, at } } } (recruit.js),
//                               planOpen: { at } (workplan.js: the day's task window again),
//                               fire: { <employee id>: { at } } (let go, takeFire),
//                               secretary: { id, at } (the secretary, '' for none: secretary.js),
//                               decision approved | rejected,
//                               to the pay as a share of the rank's wage (1 = the rank's own)
//
// Pay: set on the phone, it takes effect the next game day. Then the employee's morale and
// loyalty move with it (a cut more than a rise), their impression of the manager too, and their
// morale settles towards where their pay puts it from then on. The wage is paid out of the
// company's cash every day. The employee answers it: a text in their own words when they are in
// the player's contacts, else a rise is thanked for in the work group.
const path = require('path');
const fsx = require('./fsx');
const teamproject = require('./teamproject');
const { Recruit } = require('./recruit');
const { WorkPlan } = require('./workplan');
const { Secretary } = require('./secretary');

const V = 1;
const KINDS = {
    leave: { label: '请假', reasons: ['家里有点事，想请{days}天假', '最近太累了，想歇{days}天', '孩子生病了，得在家照顾{days}天', '想陪家人出去走走，请{days}天'] },
    raise: { label: '加薪', reasons: ['在公司干了这么久，想谈谈薪水', '最近活多了不少，希望工资也能涨一点', '外面同岗位给得更高，想跟您聊聊待遇'] },
    promote: { label: '晋升', reasons: ['这段时间业绩一直不错，想争取晋升', '觉得自己可以承担更多了', '经验攒够了，想往上走一步'] },
    resign: { label: '离职', reasons: ['最近状态不好，想离开一段时间', '找到了别的机会，想辞职', '觉得在这里没什么发展了'] },
    // Not asked by the employee: the game seated someone from the town, and the manager decides.
    hire: { label: '入职', reasons: ['人事给空着的工位安排了新人，等你决定留不留'] },
    // Not asked by anyone: someone left the company without the manager's say (the game took them).
    gone: { label: '离开', reasons: ['没经过你审批就离开了公司'] }
};
const PENDING_MAX = 3;
const REQUEST_CHANCE = 0.6;
// A request nobody looked at in this many game days lapses, and is minded.
const LAPSE_DAYS = 2;
const REQUESTS_KEPT = 30;
const HISTORY_DAYS = 14;
const CATCH_UP_DAYS = 7;
const MORALE_START = 60;
const RAISE_STEP = 0.1;
const RAISE_MAX = 1.5;
// What the manager may set, as a share of the rank's wage.
const PAY_MIN = 0.6;
const PAY_MAX = 2;
const PAY_LOG_KEPT = 20;
// The rest of the staff, when someone is let go.
const FIRE_MORALE = -3;
// Morale and loyalty per percentage point of change: a cut is felt more than a rise.
const PAY_MORALE_UP = 1.2;
const PAY_MORALE_DOWN = 1.8;
const PAY_LOYALTY_UP = 0.5;
const PAY_LOYALTY_DOWN = 0.8;
// An answer not sent yet (the chat was busy) is tried again for this long.
const REACT_TRY_MS = 3 * 3600000;
const PROMOTE_EVALUATION = 75;
const RESIGN_MORALE = 35;
// What deciding does to the person who asked: morale, loyalty, and their impression of the manager.
const EFFECTS = {
    leave: { approved: [8, 2, 2], rejected: [-6, -1, -2] },
    raise: { approved: [15, 5, 3], rejected: [-8, -3, -3] },
    promote: { approved: [12, 6, 4], rejected: [-8, -3, -3] },
    resign: { approved: [0, 0, 0], rejected: [6, 0, 1] },
    hire: { approved: [8, 6, 2], rejected: [0, 0, 0] },
    gone: { approved: [0, 0, 0], rejected: [0, 0, 0] }
};
const LAPSE_MORALE = -5;
// A team project finished: the company is paid this many times the game's base reward (the
// game's own reward is the members' bonus); everyone's morale moves, the top contributor's more.
const PROJECT_TAKE = 2;
const PROJECT_DONE_MORALE = 4;
const PROJECT_TOP_MORALE = 6;
const PROJECT_FAILED_MORALE = -6;
const PROJECTS_KEPT = 12;
// The day's own takings are a share of what the staff's work is worth; projects bring the rest.
const DAILY_SHARE = 0.75;
const PROJECT_SETTLEMENT_FIX_V = 1;
// The company's books (c.ledger): every change of its cash, newest last.
const LEDGER_KEPT = 300;
const LEDGER_SHOWN = 150;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));

// Whether the desk (career.js) is the top of its company: the highest rank, nobody above.
function isManager(desk) {
    return !!(desk && desk.companyId && !desk.hasNext && !desk.bossId && desk.rank >= (desk.maxRank || 0));
}

function moodOf(morale) {
    return morale >= 75 ? '干劲十足' : morale >= 55 ? '状态不错' : morale >= 35 ? '有点低落' : '想走了';
}

// One person's day for the company: what their work brings in and what they cost.
function dayOf(person, st, salaries) {
    const base = Number(salaries && salaries[person.rank]) || 0;
    const wage = Math.round(base * (st.pay || 1));
    const output = DAILY_SHARE * base * (1.1 + (Number(person.evaluation) || 0) / 100 * 0.6) * (0.6 + st.morale / 100 * 0.8);
    return { wage, revenue: Math.round(output) };
}

// The staff request to file today, or null: who asks and for what, as the people are.
function pickRequest(staff, states, requests, maxRank, rand) {
    const r = rand || Math.random;
    const pending = requests.filter((x) => x.status === 'pending');
    if (pending.length >= PENDING_MAX || r() >= REQUEST_CHANCE) return null;
    const asking = new Set(pending.map((x) => x.from));
    const options = [];
    for (const p of staff) {
        const st = states[p.id];
        if (!st || asking.has(p.id) || st.probation) continue;
        const add = (kind, w) => { if (w > 0) options.push({ p, kind, w }); };
        add('resign', st.morale < RESIGN_MORALE ? 3 : 0);
        add('raise', (st.pay || 1) >= RAISE_MAX ? 0 : 1 + (st.morale < 55 ? 1 : 0));
        add('promote', p.evaluation >= PROMOTE_EVALUATION && p.rank < maxRank - 1 ? 2 : 0);
        add('leave', 1.5);
    }
    if (!options.length) return null;
    let roll = r() * options.reduce((s, o) => s + o.w, 0);
    const o = options.find((x) => (roll -= x.w) < 0) || options[options.length - 1];
    const days = o.kind === 'leave' ? 1 + Math.floor(r() * 3) : 0;
    const reasons = KINDS[o.kind].reasons;
    const reason = reasons[Math.floor(r() * reasons.length) % reasons.length].replace('{days}', String(days));
    return { from: o.p.id, kind: o.kind, days, reason };
}

class Company {
    constructor(daemon) {
        this.d = daemon;
        this.log = daemon.log;
        this.file = '';
        this.viewFile = '';
        this.mgmtFile = '';
        this.data = { v: V, byCompany: {} };
        this.busy = new Set();
        this.lastMgmt = '';
        this.rand = Math.random;
        // Résumés from town and the offers sent (recruit.js).
        this.recruit = new Recruit(daemon);
        this.recruit.onChange = () => this.save();
        // The day's tasks: the window that asks for them, and keeping everyone on theirs (workplan.js).
        this.workplan = new WorkPlan(daemon, this);
        // The employee the manager named secretary: reports, advice, and the manager's word (secretary.js).
        this.secretary = new Secretary(this);
        // An offer answered: the secretary tells the manager.
        this.recruit.onOffer = (c, o) => this.secretary.news(c, 'offer：' + (o.name || o.id) + '，' + this.secretary.offerText(o));
    }

    configure(dataDir, phoneDir) {
        this.file = path.join(dataDir, 'company.json');
        this.viewFile = path.join(phoneDir, 'oa', 'company.cfg');
        this.mgmtFile = path.join(phoneDir, 'saved', 'oa-mgmt.cfg');
        const r = fsx.readJson(this.file);
        this.data = r.ok && isObject(r.value) && isObject(r.value.byCompany) ? r.value : { v: V, byCompany: {} };
        this.lastMgmt = '';
        let changed = false;
        // Books begun on a company already running: one line with what is on its account.
        for (const c of Object.values(this.data.byCompany)) {
            if (!c || typeof c.cash !== 'number' || Array.isArray(c.ledger)) continue;
            this.book(c, 'open', 0, '开始记账，此前的结余');
            changed = true;
        }
        if (this.repairProjectSettlements()) changed = true;
        // A dismissal under way when the service stopped has nobody waiting on it any more.
        for (const c of Object.values(this.data.byCompany)) {
            for (const id of Object.keys(c && isObject(c.firing) ? c.firing : {})) {
                if (c.firing[id].state !== 'applying') continue;
                c.firing[id] = { state: 'failed', text: '服务重启了，没有办完，再点一次' };
                changed = true;
            }
        }
        if (changed) this.save();
    }

    // Old builds called an early game project shutdown a success. Correct those records once
    // (below the pass mark: teamproject.settlement).
    repairProjectSettlements() {
        let changed = false;
        for (const c of Object.values(this.data.byCompany)) {
            if (!c || c.projectSettlementFixV >= PROJECT_SETTLEMENT_FIX_V) continue;
            for (const x of Array.isArray(c.projectLog) ? c.projectLog : []) {
                if (x.done && !teamproject.settlement(x.current, x.total, 1).done && Number(x.income) > 0) {
                    this.book(c, 'correction', -Math.min(Number(c.cash) || 0, Math.round(x.income)), '更正：项目「' + (x.title || x.id) + '」当初没达标却记了回款');
                    x.done = false;
                    x.income = 0;
                    x.corrected = true;
                    changed = true;
                }
            }
            c.projectSettlementFixV = PROJECT_SETTLEMENT_FIX_V;
            changed = true;
        }
        return changed;
    }

    save() {
        if (!this.file) return;
        try {
            fsx.writeJson(this.file, this.data, true);
        } catch (e) {
            this.log.warn('company: not saved: ' + e.message);
        }
        this.publish();
    }

    // The company the member manages, or null.
    managed(memberId) {
        for (const cid of Object.keys(this.data.byCompany)) {
            const c = this.data.byCompany[cid];
            if (c && c.manager === String(memberId) && !c.ended) return c;
        }
        return null;
    }

    // Every few seconds (daemon): everyone kept on the day's task; the secretary's talks settled
    // and their news told, without waiting for the minute's tick.
    async drive() {
        for (const cid of Object.keys(this.data.byCompany)) {
            const c = this.data.byCompany[cid];
            if (!c || c.ended || !c.secretary) continue;
            this.secretary.settleTalks(c);
            this.secretary.tell(c).catch(() => {});
        }
        const env = this.d.freshEnv ? this.d.freshEnv() : null;
        if (!env) return;
        for (const cid of Object.keys(this.data.byCompany)) {
            const c = this.data.byCompany[cid];
            if (c && !c.ended) await this.workplan.drive(c, env).catch((e) => this.log.warn('workplan drive: ' + (e && e.message || e)));
        }
    }

    // Everyone running a company now.
    managers() {
        return Object.keys(this.data.byCompany).map((k) => this.data.byCompany[k]).filter((c) => c && !c.ended && c.manager).map((c) => String(c.manager));
    }

    // The played character at work, every minute (daemon.watchWork).
    async tick(playerId, desk, env) {
        const id = String(playerId);
        const day = env && typeof env.day === 'number' ? env.day : null;
        const before = this.managed(id);
        if (!isManager(desk)) {
            // Left the company or lost the top seat: the record stays, the 管理台 closes.
            if (before && desk !== undefined && (!desk || desk.companyId !== before.cid || desk.bossId || desk.hasNext)) {
                before.ended = Date.now();
                this.save();
                this.log.info('company: ' + id + ' no longer runs ' + before.name);
                this.guardAbsence(before, false).catch(() => {});
                this.guardAutoFill(before, false).catch(() => {});
            }
            return;
        }
        let c = this.data.byCompany[desk.companyId];
        if (!c || c.manager !== id || c.ended) {
            c = this.appoint(id, desk, day, c);
        }
        c.name = desk.companyName || c.name;
        if (desk.careerDtId) c.careerDtId = desk.careerDtId;
        await this.guardAbsence(c, true).catch((e) => this.log.warn('company: absence rule: ' + (e && e.message || e)));
        await this.guardAutoFill(c, c.autoHire === false).catch((e) => this.log.warn('company: auto-fill: ' + (e && e.message || e)));
        this.syncStaff(c, desk);
        this.secretary.check(c);
        this.absences(c, desk);
        this.workplan.writeMorale(c);
        if (day !== null && (c.lastDay === null || c.lastDay === undefined)) c.lastDay = day;
        if (day !== null && day > c.lastDay) {
            const from = Math.max(c.lastDay + 1, day - CATCH_UP_DAYS + 1);
            for (let d = from; d <= day; d++) this.newDay(c, desk, d);
            c.lastDay = day;
        }
        await this.trackProject(c, desk, env);
        await this.recruit.tick(c, desk, env).catch((e) => this.log.warn('recruit: ' + (e && e.message || e)));
        await this.workplan.tick(c, desk, env).catch((e) => this.log.warn('workplan: ' + (e && e.message || e)));
        await this.learnNames(c).catch(() => {});
        c.desk = { maxRank: desk.maxRank, salaries: desk.salaries, staff: desk.staff };
        this.save();
        this.answerPay(c).catch(() => {});
        this.secretary.settleTalks(c);
        this.secretary.look(c, desk).catch(() => {})
            .then(() => this.secretary.report(c, env))
            .then(() => this.secretary.tell(c))
            .catch((e) => this.log.warn('company: secretary report: ' + (e && e.message || e)));
    }

    // Whether this contact is the secretary of the company the player runs (their reply then has a
    // "secretary" field: fromSecretary).
    isSecretary(pair) {
        const c = pair ? this.managed(pair.playerId) : null;
        return !!(c && this.secretary.is(c, pair.partnerId));
    }

    // The manager's texts to the secretary asking for a talk: started (secretary.hears).
    secretaryHears(pair, texts, desk) {
        const c = pair ? this.managed(pair.playerId) : null;
        if (!c || !this.secretary.is(c, pair.partnerId)) return [];
        return this.secretary.hears(c, texts, desk);
    }

    // The secretary's rule for carrying out the manager's word (the reply's "secretary" field), or
    // '' for anyone else.
    secretaryRule(pair, call, desk) {
        const c = pair ? this.managed(pair.playerId) : null;
        if (!c || !this.secretary.is(c, pair.partnerId)) return '';
        return this.secretary.orderRule(c, desk, call);
    }

    // The secretary's reply: the manager's word carried out (secretary.js fromReply).
    fromSecretary(pair, raw) {
        const c = this.managed(pair.playerId);
        if (!c || !this.secretary.is(c, pair.partnerId)) return 0;
        return this.secretary.fromReply(c, raw);
    }

    // The game's team project: followed while it runs, and settled once it is over (done when
    // it reached its points, or ended before its deadline; failed when the deadline passed).
    async trackProject(c, desk, env) {
        const now = teamproject.envMinute(env);
        const list = await teamproject.catalogue(this.d, desk.careerDtId).catch(() => []);
        if (list.length) c.catalogue = list;
        const p = desk.project;
        const key = p ? p.id + '@' + p.startMin : '';
        const cur = c.project || null;
        if (cur && (key !== cur.key || !p.active)) {
            const last = key === cur.key ? Object.assign({}, cur, p, { key }) : cur;
            this.settleProject(c, last, env);
            c.project = null;
        }
        c.settled = Array.isArray(c.settled) ? c.settled : [];
        if (p && p.active && c.settled.indexOf(key) < 0) {
            const info = (c.catalogue || []).find((x) => x.id === p.id) || {};
            c.project = Object.assign({ key, title: info.title || p.id, desc: info.desc || '', days: info.days || 0, reward: info.reward || 0 }, p);
        }
    }

    // Done once it reached the pass mark (teamproject.settlement): the company's payment, and a
    // bonus for the points past the mark.
    settleProject(c, p, env) {
        c.settled = (Array.isArray(c.settled) ? c.settled : []).concat([p.key]).slice(-PROJECTS_KEPT);
        const day = env && typeof env.day === 'number' ? env.day : null;
        const ids = Object.keys(p.contributions || {}).filter((id) => c.staff[id]);
        const top = ids.sort((a, b) => p.contributions[b] - p.contributions[a])[0] || '';
        const s = teamproject.settlement(p.current, p.total, (p.reward || 0) * PROJECT_TAKE);
        const done = s.done;
        const income = s.income;
        for (const sid of Object.keys(c.staff)) {
            const st = c.staff[sid];
            st.morale = clamp(st.morale + (done ? PROJECT_DONE_MORALE + (sid === top ? PROJECT_TOP_MORALE : 0) : PROJECT_FAILED_MORALE));
        }
        if (s.base) this.book(c, 'project', s.base, '项目「' + (p.title || p.id) + '」达标回款（' + p.current + ' / ' + p.total + ' 点）');
        if (s.bonus) this.book(c, 'bonus', s.bonus, '项目「' + (p.title || p.id) + '」超额奖金（超出达标线 ' + (p.current - s.pass) + ' 点）');
        c.projectLog =(Array.isArray(c.projectLog) ? c.projectLog : []).concat([{
            id: p.id, title: p.title || p.id, day, done, current: p.current, total: p.total, pass: s.pass, income, bonus: s.bonus, top,
            contributions: p.contributions || {}
        }]).slice(-PROJECTS_KEPT);
        this.log.info('company: project ' + p.id + (done ? ' done, +' + income + (s.bonus ? ' (bonus ' + s.bonus + ')' : '') : ' failed') +
            ' (' + p.current + '/' + p.total + ', pass ' + s.pass + ')');
        this.toast(done ? 'OA：项目「' + (p.title || p.id) + '」达标，公司进账 ' + income + (s.bonus ? '（含超额奖金 ' + s.bonus + '）' : '')
            : 'OA：项目「' + (p.title || p.id) + '」没能按期达标');
    }

    // What the running project pays the company, for the phone: { pass, income (on reaching the
    // pass mark), bonusMax (on top, for all the points), bonusNow (at the points so far) }.
    projectMoney(p) {
        const base = (p.reward || 0) * PROJECT_TAKE;
        const full = teamproject.settlement(p.total, p.total, base);
        const now = teamproject.settlement(p.current, p.total, base);
        return { pass: full.pass, income: full.base, bonusMax: full.bonus, bonusNow: now.bonus };
    }

    appoint(id, desk, day, old) {
        const c = old && old.manager === id ? old : { cid: desk.companyId, staff: {}, requests: [], history: [] };
        c.cid = desk.companyId;
        c.manager = id;
        c.name = desk.companyName || '';
        c.appointedAt = Date.now();
        c.appointedDay = day;
        c.lastDay = day;
        delete c.ended;
        if (typeof c.cash !== 'number') {
            // A month of wages to start with.
            const wages = (desk.staff || []).reduce((s, p) => s + (Number(desk.salaries && desk.salaries[p.rank]) || 0), 0);
            c.cash = 0;
            this.book(c, 'start', wages * 30, '上任时公司账上的启动资金（一个月工资）');
        }
        this.data.byCompany[desk.companyId] = c;
        this.log.info('company: ' + id + ' now runs ' + c.name + ' (' + desk.companyId + ')');
        this.toast('OA：你已被任命为「' + (c.name || '公司') + '」的最高负责人，打开 OA 的管理台看看吧');
        return c;
    }

    // Everyone on the payroll has a state; whoever left is dropped.
    // Everyone on the payroll has a state; whoever left is dropped. Someone the game seated after
    // the manager took over is on probation, and their hire waits for the manager.
    syncStaff(c, desk) {
        const ids = new Set((desk.staff || []).map((p) => p.id));
        const first = !c.hiresSince;
        if (first) c.hiresSince = typeof c.appointedDay === 'number' ? c.appointedDay : 0;
        for (const p of desk.staff || []) {
            const known = isObject(c.staff[p.id]);
            // Hired by the manager's own offer (recruit.js): theirs already.
            const offered = c.recruit && Array.isArray(c.recruit.hired) && c.recruit.hired.indexOf(p.id) >= 0;
            const fresh = !offered && (first ? typeof p.joinedDay === 'number' && p.joinedDay >= c.hiresSince : !known);
            if (!known) c.staff[p.id] = { morale: MORALE_START, loyalty: MORALE_START, pay: 1, since: Date.now() };
            if (fresh && !c.requests.some((r) => r.kind === 'hire' && r.from === p.id && r.status === 'pending')) this.newHire(c, p);
        }
        // Someone no longer on the payroll. Let go by the manager (release), they were expected to
        // go. Otherwise the game took them without a word: told, and the manager may call them back.
        // A payroll read with nobody on it is not trusted, and anyone must be missing twice.
        if (!ids.size && Object.keys(c.staff).length > 1) return;
        c.missing = isObject(c.missing) ? c.missing : {};
        c.expectLeave = isObject(c.expectLeave) ? c.expectLeave : {};
        for (const sid of Object.keys(c.staff)) {
            if (ids.has(sid)) { delete c.missing[sid]; continue; }
            c.missing[sid] = (c.missing[sid] || 0) + 1;
            if (c.missing[sid] < 2 && !c.expectLeave[sid]) continue;
            delete c.missing[sid];
            if (c.expectLeave[sid]) delete c.expectLeave[sid];
            else this.gone(c, sid);
            delete c.staff[sid];
        }
    }

    // The game fires anyone who misses work without leave (Career.UnexcusedAbsenceScriptId,
    // AddBuff_Career_Fired). Only the manager lets people go, so while the player runs the company
    // the rule is off in the game's table (runtime only: a restart brings it back, and the next
    // tick takes it off again), and put back when they no longer run it. An absence is told instead.
    async guardAbsence(c, on) {
        if (!c.careerDtId) return;
        const g = this.d.game;
        const row = await g.soft('data_table_get', { Alias: 'Career', Row: c.careerDtId });
        if (!row || typeof row.unexcusedAbsenceScriptId !== 'string') return;
        // A name field takes the bare name (a quoted one is kept with its quotes).
        const bare = (v) => String(v || '').replace(/^"+|"+$/g, '');
        const now = bare(row.unexcusedAbsenceScriptId);
        if (bare(c.absenceScript) === 'None') delete c.absenceScript;
        if (on && now !== 'None') c.absenceScript = now;
        const want = on ? 'None' : (c.absenceScript || now);
        if (row.unexcusedAbsenceScriptId === want) return;
        const r = await g.soft('data_patch', { Method: 'Override', Query: 'Career[Id=' + c.careerDtId + '].UnexcusedAbsenceScriptId', Value: want });
        const ok = !!(r && r.result === 'Applied');
        this.log.info('company: firing for absence at ' + c.careerDtId + (on ? ' off' : ' back on (' + want + ')') + (ok ? '' : ', not taken'));
    }

    // The game keeps each rank at a least number of town NPCs (Career organizations[].rankList[].
    // shift.crowdAutoFillCount) and hires whoever is needed to get there. With auto-fill off (on
    // the phone) those are 0 in the game's table, so it hires nobody; the numbers it had are kept
    // (c.autoFillCounts: { <org>/<rank index>: n }) and put back once auto-fill is on again or the
    // player no longer runs the company. Runtime only, like guardAbsence: a restart brings the
    // game's back, and the next tick takes them off again.
    async guardAutoFill(c, off) {
        if (!c.careerDtId) return;
        const g = this.d.game;
        const row = await g.soft('data_table_get', { Alias: 'Career', Row: c.careerDtId });
        if (!row || !Array.isArray(row.organizations)) return;
        c.autoFillCounts = isObject(c.autoFillCounts) ? c.autoFillCounts : {};
        let changed = 0;
        for (let o = 0; o < row.organizations.length; o++) {
            const ranks = Array.isArray(row.organizations[o].rankList) ? row.organizations[o].rankList : [];
            for (let i = 0; i < ranks.length; i++) {
                const shift = ranks[i] && ranks[i].shift;
                if (!shift || typeof shift.crowdAutoFillCount !== 'number') continue;
                const key = o + '/' + i;
                const now = shift.crowdAutoFillCount;
                if (off && now > 0) c.autoFillCounts[key] = now;
                const want = off ? 0 : (typeof c.autoFillCounts[key] === 'number' ? c.autoFillCounts[key] : now);
                if (now === want) continue;
                const r = await g.soft('data_patch', { Method: 'Override', Value: String(want),
                    Query: 'Career[Id=' + c.careerDtId + '].Organizations[' + o + '].RankList[' + i + '].Shift.CrowdAutoFillCount' });
                if (r && r.result === 'Applied') changed++;
            }
        }
        if (changed) this.log.info('company: the game\'s own hiring at ' + c.careerDtId + (off ? ' off' : ' back on') + ' (' + changed + ' rank(s))');
    }

    // An unexcused absence (the game's count went up): told, the manager decides.
    absences(c, desk) {
        c.unexcused = isObject(c.unexcused) ? c.unexcused : {};
        for (const p of desk.staff || []) {
            const n = Number(p.unexcused) || 0;
            const was = c.unexcused[p.id];
            c.unexcused[p.id] = n;
            if (typeof was !== 'number' || n <= was) continue;
            this.log.info('company: ' + p.id + ' missed work without leave (' + n + ' in all)');
            this.nameOf(p.id).then((name) => {
                this.toast('OA：' + (name || '有员工') + '今天无故缺勤');
                this.secretary.news(c, (name || p.id) + ' 今天无故缺勤（一共 ' + n + ' 次）');
            }).catch(() => {});
        }
    }

    gone(c, sid) {
        const st = c.staff[sid] || {};
        const r = { id: 'cr-gone-' + sid + '-' + Date.now().toString(36), from: sid, kind: 'gone', days: 0, reason: KINDS.gone.reasons[0],
            day: typeof c.lastDay === 'number' ? c.lastDay : null, at: Date.now(), status: 'pending',
            keep: { pay: st.pay || 1, morale: st.morale, loyalty: st.loyalty } };
        c.requests.push(r);
        c.requests = c.requests.slice(-REQUESTS_KEPT);
        this.log.warn('company: ' + sid + ' left ' + c.cid + ' without the manager');
        this.afterGone(c, r).catch((e) => this.log.warn('company: after ' + sid + ' left: ' + (e && e.message || e)));
    }

    // Left with no job at all, the game let them go (one of its own reasons: absence, evaluation,
    // its population system...): called back at once, since only the manager lets people go. Gone
    // to another job, or not readable, it waits for the manager.
    async afterGone(c, r) {
        r.fromName = await this.nameOf(r.from).catch(() => '') || '';
        const ws = await this.d.game.soft('career_get_work_status', { entity_id: r.from });
        if (ws && ws.has_job === false) {
            this.log.info('company: ' + r.from + ' was let go by the game with no job to go to; calling them back');
            await this.decide(c, r, 'approved', '游戏自动辞退，已自动召回');
            if (r.effect && r.effect.state === 'done') {
                this.secretary.news(c, (r.fromName || r.from) + ' 被游戏自己移出了公司（不是老板的意思），已经自动召回（从入门职级重新开始）');
                return;
            }
        }
        this.toast('OA：' + (r.fromName || '有员工') + '没经过你审批就离开了公司');
        this.secretary.news(c, (r.fromName || r.from) + ' 没经过老板审批就离开了公司（去了别处），要不要召回在审批里定');
        this.save();
    }

    newHire(c, p) {
        const st = c.staff[p.id];
        st.probation = true;
        const day = typeof c.lastDay === 'number' ? c.lastDay : null;
        const r = { id: 'cr-hire-' + p.id + '-' + Date.now().toString(36), from: p.id, kind: 'hire', days: 0, reason: KINDS.hire.reasons[0], day, at: Date.now(), status: 'pending' };
        c.requests.push(r);
        c.requests = c.requests.slice(-REQUESTS_KEPT);
        this.log.info('company: the game seated ' + p.id + ' (rank ' + p.rank + ') at ' + c.cid + (c.autoHire === false ? ', auto-fill is off' : ', waiting for the manager'));
        if (c.autoHire === false) {
            // Auto-fill off: let go at once.
            this.decide(c, r, 'rejected', '自动补员已关闭').catch(() => {});
            return;
        }
        this.announce(r);
        this.nameOf(p.id).then((name) => this.secretary.news(c, '游戏给空工位安排了新人 ' + (name || p.id) + '（第 ' + p.rank + ' 级），留不留等老板在审批里定')).catch(() => {});
    }

    newDay(c, desk, day) {
        for (const id of Object.keys(isObject(c.payPlan) ? c.payPlan : {})) {
            const plan = c.payPlan[id];
            if (!isObject(plan) || (typeof plan.day === 'number' && day <= plan.day)) continue;
            this.applyPay(c, id, plan, day);
            delete c.payPlan[id];
        }
        // Morale settles back towards where pay puts it.
        for (const sid of Object.keys(c.staff)) {
            const st = c.staff[sid];
            const rest = MORALE_START + ((st.pay || 1) - 1) * 50;
            st.morale = clamp(st.morale + Math.sign(rest - st.morale) * Math.min(3, Math.abs(rest - st.morale)));
        }
        // Requests left waiting lapse.
        for (const r of c.requests) {
            // A hire waits for the manager however long it takes: they are already at work.
            if (r.status === 'pending' && r.kind !== 'hire' && r.kind !== 'gone' && typeof r.day === 'number' && day - r.day >= LAPSE_DAYS) {
                r.status = 'lapsed';
                r.decidedAt = Date.now();
                const st = c.staff[r.from];
                if (st) st.morale = clamp(st.morale + LAPSE_MORALE);
            }
        }
        // The day's figures, in the books by person.
        let revenue = 0;
        let payroll = 0;
        const earned = [];
        const paid = [];
        for (const p of desk.staff || []) {
            const st = c.staff[p.id];
            if (!st) continue;
            const x = dayOf(p, st, desk.salaries);
            revenue += x.revenue;
            payroll += x.wage;
            earned.push({ id: p.id, amount: x.revenue });
            paid.push({ id: p.id, amount: -x.wage, pay: st.pay || 1 });
        }
        if (revenue) this.book(c, 'revenue', revenue, '第 ' + day + ' 天员工日常收入', earned, day);
        if (payroll) this.book(c, 'payroll', -payroll, '第 ' + day + ' 天工资', paid, day);
        c.history.push({ day, revenue, payroll });
        c.history = c.history.slice(-HISTORY_DAYS);
        // Someone asks for something.
        const ask = pickRequest(desk.staff || [], c.staff, c.requests, desk.maxRank || 0, this.rand);
        if (ask) {
            const r = Object.assign({ id: 'cr-' + day + '-' + ask.from + '-' + ask.kind, day, at: Date.now(), status: 'pending' }, ask);
            if (!c.requests.some((x) => x.id === r.id)) {
                c.requests.push(r);
                this.announce(r);
            }
        }
        c.requests = c.requests.slice(-REQUESTS_KEPT);
    }

    // A change of the company's cash, written in its books: { id, day, at, kind, amount, balance,
    // text, lines? }. kind: start (the money it started with) | open (books begun on a company
    // already running) | revenue (the day's takings, lines by person) | payroll (the day's wages,
    // lines by person) | project (a project done) | bonus (its points past the pass mark) |
    // correction (an old record put right).
    book(c, kind, amount, text, lines, onDay) {
        const n = Math.round(Number(amount) || 0);
        c.cash = Math.round((Number(c.cash) || 0) + n);
        c.ledger = Array.isArray(c.ledger) ? c.ledger : [];
        const day = typeof onDay === 'number' ? onDay : typeof c.lastDay === 'number' ? c.lastDay : null;
        const e = { id: 'l' + Date.now().toString(36) + c.ledger.length, day, at: Date.now(), kind, amount: n, balance: c.cash, text };
        if (Array.isArray(lines) && lines.length) e.lines = lines;
        c.ledger.push(e);
        if (c.ledger.length > LEDGER_KEPT) c.ledger = c.ledger.slice(-LEDGER_KEPT);
        return e;
    }

    // Names for the books (people who have left included), looked up once each.
    async learnNames(c) {
        c.names = isObject(c.names) ? c.names : {};
        const ids = new Set(Object.keys(c.staff));
        for (const e of c.ledger || []) for (const l of e.lines || []) ids.add(String(l.id));
        for (const id of ids) {
            if (c.names[id]) continue;
            const name = await this.nameOf(id).catch(() => '');
            if (name) c.names[id] = name;
        }
    }

    async nameOf(id) {
        const w = this.d.world;
        const info = w && typeof w.characterInfo === 'function' ? await w.characterInfo(id).catch(() => null) : null;
        return info ? ((info.last_name || '') + (info.first_name || '')).trim() : '';
    }

    announce(r) {
        this.nameOf(r.from).then((name) => {
            r.fromName = name || r.fromName || '';
            this.toast(r.kind === 'hire' ? 'OA：公司新来了' + (name || '一位员工') + '，等你决定留不留' : 'OA：' + (name || '有员工') + '提交了' + KINDS[r.kind].label + '申请');
            this.save();
        }).catch(() => {});
    }

    // The manager's decisions from the phone, every few seconds.
    poll() {
        if (!this.mgmtFile) return;
        const text = fsx.readText(this.mgmtFile);
        if (text === null || text === this.lastMgmt) return;
        this.lastMgmt = text;
        let value = null;
        try { value = JSON.parse(text); } catch (e) { return; }
        const byId = value && isObject(value.byId) ? value.byId : {};
        const pay = value && isObject(value.pay) ? value.pay : {};
        const hiring = value && isObject(value.hiring) ? value.hiring : null;
        const offers = value && isObject(value.offers) ? value.offers : {};
        const planOpen = value && isObject(value.planOpen) ? Number(value.planOpen.at) || 0 : 0;
        for (const cid of Object.keys(this.data.byCompany)) {
            const c = this.data.byCompany[cid];
            if (!c || c.ended || !(planOpen > (c.planOpenAt || 0))) continue;
            c.planOpenAt = planOpen;
            this.d.career.desk(c.manager).then((desk) => desk && this.workplan.reopen(c, desk))
                .then(() => this.save()).catch((e) => this.log.warn('workplan: not reopened: ' + (e && e.message || e)));
        }
        for (const cid of Object.keys(this.data.byCompany)) {
            const c = this.data.byCompany[cid];
            if (c && !c.ended && this.recruit.takeOffers(c, offers)) this.save();
        }
        for (const cid of Object.keys(this.data.byCompany)) {
            const c = this.data.byCompany[cid];
            if (!c || c.ended || !hiring || !(Number(hiring.at) > (c.hiringAt || 0))) continue;
            c.hiringAt = Number(hiring.at);
            c.autoHire = hiring.auto !== false;
            this.log.info('company: auto-fill at ' + cid + ' turned ' + (c.autoHire ? 'on' : 'off'));
            this.guardAutoFill(c, !c.autoHire).catch((e) => this.log.warn('company: auto-fill: ' + (e && e.message || e)));
            this.save();
        }
        for (const cid of Object.keys(this.data.byCompany)) {
            const c = this.data.byCompany[cid];
            if (c && !c.ended) this.takePay(c, pay);
        }
        const fire = value && isObject(value.fire) ? value.fire : {};
        for (const cid of Object.keys(this.data.byCompany)) {
            const c = this.data.byCompany[cid];
            if (c && !c.ended) this.takeFire(c, fire);
        }
        const sec = value && isObject(value.secretary) ? value.secretary : null;
        for (const cid of Object.keys(this.data.byCompany)) {
            const c = this.data.byCompany[cid];
            if (c && !c.ended && sec && this.secretary.take(c, sec)) this.save();
        }
        for (const cid of Object.keys(this.data.byCompany)) {
            const c = this.data.byCompany[cid];
            if (!c || c.ended) continue;
            for (const r of c.requests) {
                const d = byId[r.id];
                if (r.status !== 'pending' || !d || (d.decision !== 'approved' && d.decision !== 'rejected') || this.busy.has(r.id)) continue;
                this.decide(c, r, d.decision).catch((e) => {
                    r.effect = { state: 'failed', text: '出错了：' + String(e && e.message || e).slice(0, 40) };
                    this.save();
                });
            }
        }
    }

    // The pay the manager set on the phone: due the next game day (or dropped when set back).
    takePay(c, pay) {
        c.payAsked = isObject(c.payAsked) ? c.payAsked : {};
        c.payPlan = isObject(c.payPlan) ? c.payPlan : {};
        let changed = false;
        for (const id of Object.keys(pay)) {
            const p = pay[id];
            const st = c.staff[id];
            if (!st || !isObject(p) || !(Number(p.at) > (c.payAsked[id] || 0))) continue;
            c.payAsked[id] = Number(p.at);
            const to = Math.round(Math.max(PAY_MIN, Math.min(PAY_MAX, Number(p.to) || 1)) * 10000) / 10000;
            if (Math.abs(to - (st.pay || 1)) < 0.005) delete c.payPlan[id];
            else c.payPlan[id] = { from: st.pay || 1, to, day: c.lastDay, at: Date.now() };
            this.log.info('company: pay of ' + id + (c.payPlan[id] ? ' set to ' + Math.round(to * 100) + '% from the next day' : ' left as it is'));
            changed = true;
        }
        if (changed) this.save();
    }

    // Let go by the manager on the phone (oa-mgmt.cfg fire: { <id>: { at } }): out of the company
    // in the game, and the rest of the staff a little shaken. c.firing[<id>]: { state: applying |
    // failed, text } while it is under way or after it failed; gone once they are out.
    takeFire(c, fire) {
        c.fireAsked = isObject(c.fireAsked) ? c.fireAsked : {};
        c.firing = isObject(c.firing) ? c.firing : {};
        for (const id of Object.keys(fire)) {
            const f = fire[id];
            if (!c.staff[id] || !isObject(f) || !(Number(f.at) > (c.fireAsked[id] || 0))) continue;
            c.fireAsked[id] = Number(f.at);
            this.fire(c, id, 'phone');
        }
    }

    // Lets someone go (from the phone, or the secretary on the manager's word): resolves to the
    // effect, { state: done | failed, text }; null when they are not on the staff or already going.
    fire(c, id, by) {
        c.firing = isObject(c.firing) ? c.firing : {};
        if (!c.staff[id] || (c.firing[id] && c.firing[id].state === 'applying')) return Promise.resolve(null);
        c.firing[id] = { state: 'applying', text: '正在办理离职' };
        this.log.info('company: the manager lets ' + id + ' go (' + by + ')');
        this.save();
        return this.release(c, id).then(async (effect) => {
            if (effect.state !== 'done') {
                c.firing[id] = effect;
                this.save();
                return effect;
            }
            delete c.firing[id];
            const name = await this.nameOf(id).catch(() => '');
            for (const sid of Object.keys(c.staff)) {
                if (sid === id) continue;
                c.staff[sid].morale = clamp(c.staff[sid].morale + FIRE_MORALE);
            }
            if (c.secretary === id) delete c.secretary;
            c.fireLog = (Array.isArray(c.fireLog) ? c.fireLog : []).concat([{ id, name: name || '', day: c.lastDay, at: Date.now(), by }]).slice(-10);
            this.toast('OA：' + (by === 'secretary' ? '秘书' : '') + '已辞退' + (name || '这名员工'));
            if (by === 'secretary') this.secretary.news(c, '老板让你辞退的 ' + (name || id) + ' 已经办完离职');
            this.save();
            return effect;
        }).catch((e) => {
            const effect = { state: 'failed', text: '出错了：' + String(e && e.message || e).slice(0, 40) };
            c.firing[id] = effect;
            this.save();
            return effect;
        });
    }

    // The new pay starts: morale, loyalty and impression move, and the employee is to answer it.
    applyPay(c, id, plan, day) {
        const st = c.staff[id];
        if (!st) return;
        const pts = Math.round((plan.to - plan.from) * 100);
        st.pay = plan.to;
        const up = pts > 0;
        st.morale = clamp(st.morale + Math.max(-35, Math.min(25, pts * (up ? PAY_MORALE_UP : PAY_MORALE_DOWN))));
        st.loyalty = clamp(st.loyalty + pts * (up ? PAY_LOYALTY_UP : PAY_LOYALTY_DOWN));
        const w = this.d.workplace;
        if (w && pts) w.change(c.manager, id, Math.max(-12, Math.min(8, Math.round(pts / 3))), up ? '涨了工资' : '被降了工资', day).catch(() => {});
        const rank = this.rankIn(c, id);
        const base = rank !== null && c.desk && c.desk.salaries ? Number(c.desk.salaries[rank]) || 0 : 0;
        c.payLog = (Array.isArray(c.payLog) ? c.payLog : []).concat([{
            id, from: plan.from, to: plan.to, day, wageFrom: Math.round(base * plan.from), wageTo: Math.round(base * plan.to),
            answer: 'waiting', at: Date.now()
        }]).slice(-PAY_LOG_KEPT);
        this.log.info('company: ' + id + ' paid ' + Math.round(plan.to * 100) + '% from day ' + day + ' (' + (up ? '+' : '') + pts + ' points)');
    }

    rankIn(c, id) {
        const p = c.desk && Array.isArray(c.desk.staff) ? c.desk.staff.find((x) => x.id === String(id)) : null;
        return p ? p.rank : null;
    }

    // The employees' answers to their new pay, one at a time.
    async answerPay(c) {
        if (this.answering || typeof this.d.staffText !== 'function') return;
        const due = (c.payLog || []).find((x) => x.answer === 'waiting');
        if (!due) return;
        if (Date.now() - due.at > REACT_TRY_MS) {
            due.answer = 'missed';
            this.save();
            return;
        }
        this.answering = true;
        try {
            const st = c.staff[due.id] || { morale: MORALE_START };
            const pts = Math.round((due.to - due.from) * 100);
            const amount = due.wageFrom && due.wageTo ? '日薪从 ' + due.wageFrom + ' 调到 ' + due.wageTo : '工资' + (pts > 0 ? '上调' : '下调') + '了';
            const reason = pts > 0
                ? '你的老板，也就是你现在发消息的这个人，亲自给你涨了工资：' + amount + '（涨了 ' + pts + '%），今天开始生效。你现在' + moodOf(st.morale) + '。' +
                  '这条消息是直接发给老板本人的：按你的性格跟对方说点什么，感谢、惊喜、表个态，或者有点不好意思都行；涨得不多也可以只是客气一句。' +
                  '别把老板当成第三个人来转述（不要说“老板给我涨了工资”），别报百分比，别像在算账。'
                : '你的老板，也就是你现在发消息的这个人，亲自给你降了工资：' + amount + '（降了 ' + (-pts) + '%），今天开始生效。你现在' + moodOf(st.morale) + '。' +
                  '这条消息是直接发给老板本人的：按你的性格回应，可能委屈、不满、问为什么、担心是不是要被裁，也可能硬撑着说理解；' +
                  '心里很难受的话可以带点情绪，甚至流露出想走的念头。别把老板当成第三个人来转述，别客套，别装没事。';
            const how = await this.d.staffText(c.manager, due.id, reason, { publicThanks: pts > 0, companyId: c.cid });
            due.answer = how || 'waiting';
            if (how) this.log.info('company: ' + due.id + ' answered the new pay (' + how + ')');
            this.save();
        } catch (e) {
            this.log.warn('company: pay answer of ' + due.id + ' not sent: ' + (e && e.message || e));
        } finally {
            this.answering = false;
        }
    }

    async decide(c, r, decision, why) {
        this.busy.add(r.id);
        try {
            r.status = decision;
            r.decidedAt = Date.now();
            const st = c.staff[r.from];
            const fx = EFFECTS[r.kind][decision];
            if (st) {
                st.morale = clamp(st.morale + fx[0]);
                st.loyalty = clamp(st.loyalty + fx[1]);
            }
            const env = this.d.freshEnv ? this.d.freshEnv() : null;
            const w = this.d.workplace;
            if (w && fx[2]) w.change(c.manager, r.from, fx[2], 'OA：' + KINDS[r.kind].label + '申请' + (decision === 'approved' ? '被批准' : '被驳回'), env && env.day).catch(() => {});
            if (r.kind === 'gone') {
                if (decision === 'rejected') {
                    r.effect = { state: 'done', text: '已确认离开' };
                } else {
                    r.effect = { state: 'applying', text: '正在召回' };
                    this.save();
                    r.effect = await this.recall(c, r);
                }
                this.save();
                return;
            }
            if (r.kind === 'hire') {
                if (decision === 'approved') {
                    if (st) st.probation = false;
                    r.effect = { state: 'done', text: '已留用，转为正式员工' };
                    this.toast('OA：已留用新员工');
                } else {
                    r.effect = { state: 'applying', text: '正在办理辞退' };
                    this.save();
                    const out = await this.release(c, r.from);
                    r.effect = out.state === 'done' ? { state: 'done', text: (why ? why + '，' : '') + '已辞退，工位过几天会再来人' }
                        : { state: 'failed', text: '游戏没有办成辞退，TA 还在公司' + (out.text ? '（' + out.text + '）' : '') };
                    // Still there: an employee like the rest.
                    if (out.state !== 'done' && st) st.probation = false;
                    if (out.state === 'done') this.toast('OA：已辞退新来的员工');
                }
                this.save();
                return;
            }
            if (decision === 'rejected') {
                r.effect = { state: 'done', text: r.kind === 'resign' ? (st && st.loyalty >= 50 ? '被你留下了' : '暂时留下了，心里还有疙瘩') : '已驳回' };
                this.save();
                return;
            }
            if (r.kind === 'leave') {
                r.effect = { state: 'unsupported', text: '已批准；游戏里不会改他的排班' };
            } else if (r.kind === 'raise') {
                if (st) st.pay = Math.min(RAISE_MAX, Math.round(((st.pay || 1) + RAISE_STEP) * 100) / 100);
                r.effect = { state: 'done', text: '日薪涨到原来的 ' + Math.round((st ? st.pay : 1) * 100) + '%（公司账上）' };
            } else if (r.kind === 'promote') {
                r.effect = { state: 'applying', text: '正在办理晋升' };
                this.save();
                r.effect = await this.promote(c, r.from);
            } else if (r.kind === 'resign') {
                r.effect = { state: 'applying', text: '正在办理离职' };
                this.save();
                r.effect = await this.release(c, r.from);
            }
            this.save();
        } finally {
            this.busy.delete(r.id);
        }
    }

    // Someone who left without the manager's say, back in the company: at the entry rank (the game's
    // join), only into a free entry seat, with the pay they had.
    async recall(c, r) {
        const desk = await this.d.career.fresh(c.manager).catch(() => null);
        const free = desk && desk.seatsKnown ? Number(desk.seatsFree && desk.seatsFree[desk.entryRank || 1]) || 0 : 1;
        if (!free) return { state: 'failed', text: '入门工位都满了，召回不了' };
        const rc = this.recruit.state(c);
        if (!rc.jobId && desk) await this.recruit.readSeats(c, desk).catch(() => {});
        const joined = await this.recruit.join(c, r.from, rc.jobId || (desk && desk.jobId) || '');
        if (joined !== true) return { state: 'failed', text: '游戏没有办成重新入职' + (joined ? '（' + joined + '）' : '') };
        if (rc.hired.indexOf(r.from) < 0) rc.hired.push(r.from);
        const keep = isObject(r.keep) ? r.keep : {};
        c.staff[r.from] = { morale: clamp((Number(keep.morale) || MORALE_START) + 10), loyalty: clamp((Number(keep.loyalty) || MORALE_START) + 5),
            pay: Number(keep.pay) || 1, since: Date.now() };
        this.log.info('company: ' + r.from + ' called back to ' + c.cid);
        this.toast('OA：已召回' + (r.fromName || '员工'));
        return { state: 'done', text: '已召回，从入门职级重新开始' };
    }

    rankOf(desk, id) {
        const p = desk && Array.isArray(desk.roster) ? desk.roster.find((x) => x.id === String(id)) : null;
        return p ? p.rank : null;
    }

    async promote(c, who) {
        const career = this.d.career;
        const before = this.rankOf(await career.fresh(c.manager), who);
        await this.d.game.call('career_promotion', { entity_id: String(who) });
        await new Promise((res) => setTimeout(res, 1500));
        const after = this.rankOf(await career.fresh(c.manager), who);
        if (before !== null && after !== null && after > before) {
            this.log.info('company: ' + who + ' promoted to rank ' + after);
            this.toast('OA：晋升已办好，升到第 ' + after + ' 级');
            return { state: 'done', text: '已升到第 ' + after + ' 级' };
        }
        this.log.warn('company: promotion of ' + who + ' did not change the rank');
        return { state: 'failed', text: '游戏没有改职级' };
    }

    release(c, who) {
        c.expectLeave = isObject(c.expectLeave) ? c.expectLeave : {};
        c.expectLeave[String(who)] = Date.now();
        // The played character asks for it (op x) when the running Lua mod can: an employee the game
        // does not simulate never answers a request of their own. Else the employee asks (op r).
        const j = this.d.journal;
        const byManager = !!(j && typeof j.can === 'function' && j.can('dismiss'));
        return new Promise((resolve) => {
            const done = async (res) => {
                const after = await this.d.career.fresh(c.manager).catch(() => null);
                const gone = after && this.rankOf(after, who) === null;
                if (res.ok && gone) {
                    this.log.info('company: ' + who + ' left ' + c.cid);
                    resolve({ state: 'done', text: '已经办完离职' });
                } else {
                    this.log.warn('company: ' + who + ' did not leave ' + c.cid + ': ' + (res.detail || 'still listed'));
                    resolve({ state: 'failed', text: '游戏没有办成离职（' + (res.detail || '还在名单上') + '）' });
                }
            };
            if (byManager) this.d.career.request(String(c.manager), 'x', c.cid + '/' + who, done);
            else this.d.career.request(String(who), 'r', c.cid, done);
        });
    }

    // For the reply prompt of someone at the company the player runs.
    rule(pair, call, desk) {
        if (!pair || !pair.outsider || !desk) return '';
        const c = this.managed(pair.playerId);
        if (!c || c.cid !== desk.companyId) return '';
        const id = String(pair.partnerId);
        const st = c.staff[id];
        if (!st) return '';
        const lines = ['【' + call + '是你们公司的最高负责人】你是' + call + '手下的员工，说话带着对老板的分寸，但按你自己的性格来。' +
            '你现在的状态：' + moodOf(st.morale) + (st.pay > 1 ? '，老板给你涨过工资' : '') + '。' +
            (st.probation ? '你是刚被安排进公司的新人，还在试用期，留不留你由' + call + '决定：做事积极点，说话也更小心。' : '')];
        const mine = c.requests.filter((r) => r.from === id).slice(-2);
        for (const r of mine) {
            const what = KINDS[r.kind].label + '申请（' + r.reason + '）';
            if (r.status === 'pending') lines.push('  你在 OA 上提交了' + what + '，' + call + '还没批。可以提一句，别催得太紧。');
            else if (r.status === 'approved') lines.push('  你的' + what + call + '批准了。');
            else if (r.status === 'rejected') lines.push('  你的' + what + '被' + call + '驳回了。');
            else if (r.status === 'lapsed') lines.push('  你的' + what + call + '一直没理。');
        }
        if (this.secretary.is(c, id)) {
            // The secretary speaks of the books and the staff by their numbers: that is their job.
            lines.push(this.secretary.rule(c, desk, call));
            return lines.join('\n');
        }
        lines.push('  别把士气、数值这些说出口。');
        return lines.join('\n');
    }

    // What the phone shows.
    publish() {
        if (!this.viewFile) return;
        const byManager = {};
        for (const cid of Object.keys(this.data.byCompany)) {
            const c = this.data.byCompany[cid];
            if (!c || c.ended || !c.manager) continue;
            const week = c.history.slice(-7);
            const sum = (k) => week.reduce((s, x) => s + (x[k] || 0), 0);
            const lastDay = c.history.length ? c.history[c.history.length - 1].day : null;
            const projectIncome = (c.projectLog || []).filter((x) => lastDay === null || (typeof x.day === 'number' && x.day > lastDay - 7))
                .reduce((s, x) => s + (x.income || 0), 0);
            const staff = {};
            let total = 0;
            for (const sid of Object.keys(c.staff)) {
                const st = c.staff[sid];
                const plan = isObject(c.payPlan) && isObject(c.payPlan[sid]) ? c.payPlan[sid] : null;
                staff[sid] = { morale: st.morale, loyalty: st.loyalty, pay: st.pay || 1, mood: moodOf(st.morale),
                    planned: plan ? plan.to : null, plannedAt: plan ? plan.at : null, probation: !!st.probation,
                    leaving: isObject(c.firing) && c.firing[sid] ? c.firing[sid] : null,
                    leavingAt: isObject(c.fireAsked) ? c.fireAsked[sid] || null : null };
                total += st.morale;
            }
            const n = Object.keys(c.staff).length;
            byManager[c.manager] = {
                companyId: cid, company: c.name, appointedDay: c.appointedDay, appointedAt: c.appointedAt,
                cash: c.cash, today: c.history.length ? c.history[c.history.length - 1] : null,
                week: { revenue: sum('revenue') + projectIncome, project: projectIncome, payroll: sum('payroll'),
                    profit: sum('revenue') + projectIncome - sum('payroll'), days: week.length },
                project: c.project ? { id: c.project.id, title: c.project.title, desc: c.project.desc, days: c.project.days,
                    reward: c.project.reward, current: c.project.current, total: c.project.total,
                    deadlineMin: c.project.deadlineMin, ...this.projectMoney(c.project) } : null,
                projectLog: (c.projectLog || []).slice(-8),
                payLog: (c.payLog || []).slice(-10),
                fireLog: (c.fireLog || []).slice(-10),
                secretary: this.secretary.view(c),
                ledger: (c.ledger || []).slice(-LEDGER_SHOWN),
                ledgerKept: LEDGER_KEPT,
                names: isObject(c.names) ? c.names : {},
                lastDay: typeof c.lastDay === 'number' ? c.lastDay : null,
                payRange: [PAY_MIN, PAY_MAX],
                autoHire: c.autoHire !== false,
                recruit: this.recruit.view(c),
                plan: this.workplan.view(c),
                catalogue: (c.catalogue || []).map((x) => ({ id: x.id, title: x.title, days: x.days, total: x.total, income: Math.round(x.reward * PROJECT_TAKE) })),
                history: c.history, morale: n ? Math.round(total / n) : 0, staff,
                requests: c.requests.slice(-20).map((r) => ({ id: r.id, from: r.from, fromName: r.fromName || '', kind: r.kind,
                    label: KINDS[r.kind].label, days: r.days, reason: r.reason, day: r.day, at: r.at, status: r.status, effect: r.effect || null }))
            };
        }
        try {
            fsx.ensureDir(path.dirname(this.viewFile));
            const text = JSON.stringify({ v: V, byManager });
            if (fsx.readText(this.viewFile) !== text) fsx.writeAtomic(this.viewFile, text);
        } catch (e) {
            this.log.warn('company: view not written: ' + e.message);
        }
    }

    toast(text) {
        if (this.d.game) this.d.game.soft('toast_show', { Message: text, Lifetime: 6 }).catch(() => {});
    }
}

module.exports = { Company, isManager, pickRequest, dayOf, moodOf, KINDS };
