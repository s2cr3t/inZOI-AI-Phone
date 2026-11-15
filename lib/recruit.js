'use strict';
// Recruiting for the company the player runs (company.js): people in town without a job send in
// their résumés, the manager reads them and sends offers, and whoever accepts joins the company in
// the game (career_join).
//
// Applicants: every game day a few townspeople the game lists as employable and jobless
// (world_list_characters: employable, !has_career; grown-ups only) apply, up to POOL_MAX at a time,
// each for EXPIRE_DAYS days. Their résumé is the game's: skills (skill_get_all), traits
// (FB2TraitComponent), age, where they are; how well they fit is mostly the skill the company's
// team projects use (TeamProject.skillId), and what they expect to earn follows from it.
//
// Offers: the manager names a daily wage, as a share of the entry rank's wage. The applicant
// answers within a minute or two: the closer the offer is to what they expect (and the happier the
// staff), the likelier a yes, in their own words. A yes joins them to the company in the game; a
// seat must be free (career_list_openings vacancy).
//
// State lives in the company's record: c.recruit = { pool: [applicant], offers: [offer],
//   passed: [ids], hired: [ids], vacancy, jobName, poolDay }.
// The phone's offers: oa-mgmt.cfg offers: { <applicant id>: { pay, at } }.
const persona = require('./persona');

const POOL_MAX = 6;
const NEW_PER_DAY = 3;
const EXPIRE_DAYS = 3;
const OFFERS_KEPT = 12;
const PASSED_KEPT = 200;
const PEOPLE_TTL_MS = 20 * 60000;
const ADULT = ['Youth', 'Adult', 'Old'];
const AGE_ZH = { Youth: '青年', Adult: '成年', Old: '中年' };
const SKILLS_SHOWN = 8;
// How long an applicant takes to answer an offer.
const ANSWER_MS = 45000;
const PAY_MIN = 0.6;
const PAY_MAX = 2;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// How well someone fits, 0..100: the company's skill counts most, then their best three others.
function fitOf(skills, key) {
    const k = key ? (skills.find((s) => s.id === key) || { level: 0 }).level : 0;
    const others = skills.filter((s) => s.id !== key).map((s) => s.level).sort((a, b) => b - a).slice(0, 3);
    return Math.max(5, Math.min(100, Math.round(12 + k * 9 + others.reduce((a, b) => a + b, 0) * 3)));
}

// The daily wage they hope for, as a share of the entry rank's: more for the company's skill.
function expectOf(skills, key, fit) {
    const k = key ? (skills.find((s) => s.id === key) || { level: 0 }).level : 0;
    return Math.round((0.9 + k * 0.05 + (fit >= 70 ? 0.05 : 0)) * 20) / 20;
}

// The chance an offer is taken: an offer at what they expect is a fair yes, under it a hard sell.
function acceptChance(pay, expect, morale) {
    const p = 0.55 + (pay - expect) * 3 + ((Number(morale) || 60) - 60) / 200;
    return Math.max(0.05, Math.min(0.97, p));
}

function letterOf(name, company, key, skills) {
    const top = skills[0];
    const k = key ? skills.find((s) => s.id === key) : null;
    if (k && k.level >= 2) return k.name + '练到了 ' + k.level + ' 级，很想来「' + company + '」试试。';
    if (top && top.level >= 2) return '擅长' + top.name + '（' + top.level + ' 级），' + (k ? k.name + '还在学，' : '') + '希望有机会加入「' + company + '」。';
    return '没什么工作经验，但愿意从头学起，想在「' + company + '」找个开始。';
}

class Recruit {
    constructor(daemon) {
        this.d = daemon;
        this.log = daemon.log;
        this.rand = Math.random;
        this.busy = false;
    }

    state(c) {
        const r = isObject(c.recruit) ? c.recruit : (c.recruit = {});
        for (const k of ['pool', 'offers', 'passed', 'hired']) if (!Array.isArray(r[k])) r[k] = [];
        return r;
    }

    // Every minute while the player runs the company (company.tick).
    async tick(c, desk, env) {
        const r = this.state(c);
        const day = env && typeof env.day === 'number' ? env.day : null;
        await this.readSeats(c, desk);
        if (day !== null && r.poolDay !== day) {
            r.poolDay = day;
            r.pool = r.pool.filter((a) => typeof a.until !== 'number' || a.until >= day || this.offerOf(r, a.id));
            await this.applicants(c, desk, day).catch((e) => this.log.warn('recruit: applicants not read: ' + (e && e.message || e)));
        }
        await this.answer(c, desk);
    }

    // Free seats for the entry job, from the game's job openings.
    async readSeats(c, desk) {
        const r = this.state(c);
        const open = await this.d.game.soft('career_list_openings', { entity_id: String(c.manager) });
        const list = open && Array.isArray(open.openings) ? open.openings : null;
        if (!list) return;
        const mine = list.filter((o) => String(o.career_entity_id) === String(c.cid));
        const job = mine.find((o) => !desk.jobId || o.job_id === desk.jobId) || mine[0];
        // The seats a newcomer can sit in: the entry rank's free seats. The game's own vacancy count
        // takes in every rank's empty seat, and a join with the entry seats full pushed someone out.
        r.vacancy = desk.seatsKnown ? Number(desk.seatsFree && desk.seatsFree[desk.entryRank || 1]) || 0 : job ? Number(job.vacancy) || 0 : 0;
        r.jobId = job ? job.job_id : (desk.jobId || '');
        r.jobName = job ? job.job_name || '' : '';
    }

    async people() {
        return this.d.world.cached('recruit-people', PEOPLE_TTL_MS, async () => {
            const res = await this.d.game.soft('world_list_characters', { limit: 1000 });
            return res && Array.isArray(res.characters) ? res.characters : [];
        });
    }

    // New résumés for the day.
    async applicants(c, desk, day) {
        const r = this.state(c);
        const room = Math.min(NEW_PER_DAY, POOL_MAX - r.pool.length);
        if (room <= 0) return;
        const hh = await this.d.world.household().catch(() => ({ members: [] }));
        const skip = new Set([].concat(r.passed, r.hired, r.pool.map((a) => a.id), Object.keys(c.staff || {}), [String(c.manager)],
            (hh.members || []).map((m) => String(m.entity_id))));
        const free = (await this.people()).filter((p) => p && p.employable && !p.has_career && ADULT.indexOf(p.age_group) >= 0 && !skip.has(String(p.entity_id)));
        const key = this.keySkill(c);
        for (let i = 0; i < room && free.length; i++) {
            const p = free.splice(Math.floor(this.rand() * free.length), 1)[0];
            const a = await this.resume(p, key, c, day).catch(() => null);
            if (a) r.pool.push(a);
        }
        if (room) this.log.info('recruit: ' + r.pool.length + ' applicant(s) for ' + c.cid + ' on day ' + day);
    }

    keySkill(c) {
        const withSkill = (c.catalogue || []).find((x) => x.skill);
        return withSkill ? withSkill.skill : '';
    }

    async resume(p, key, c, day) {
        const id = String(p.entity_id);
        const g = this.d.game;
        const [sk, tr] = await Promise.all([
            g.soft('skill_get_all', { entity_id: id }),
            this.d.world.traits(id).catch(() => null)
        ]);
        const all = sk && Array.isArray(sk.skills) ? sk.skills.map((s) => ({ id: s.id, name: s.l10n || s.id, level: Number(s.level) || 0 })) : [];
        const skills = all.filter((s) => s.level > 0 || s.id === key).sort((a, b) => b.level - a.level).slice(0, SKILLS_SHOWN);
        const traits = persona.traitIds(tr).map((t) => persona.trait(t)).slice(0, 4);
        const fit = fitOf(all, key);
        const keyRow = key ? all.find((s) => s.id === key) : null;
        const name = ((p.last_name || '') + (p.first_name || '')).trim() || id;
        return {
            id, name, first: p.first_name || '', gender: p.gender === 'Male' ? '男' : p.gender === 'Female' ? '女' : '',
            age: AGE_ZH[p.age_group] || p.age_group_text || '', site: p.current_site || '', married: !!p.is_married,
            traits, skills, key: keyRow ? { id: keyRow.id, name: keyRow.name, level: keyRow.level } : null,
            fit, expect: expectOf(all, key, fit), letter: letterOf(name, c.name || '公司', key, skills),
            day, until: day + EXPIRE_DAYS - 1
        };
    }

    offerOf(r, id) {
        return r.offers.slice().reverse().find((o) => o.id === String(id)) || null;
    }

    // The manager's offers from the phone (company.poll).
    takeOffers(c, offers) {
        const r = this.state(c);
        let changed = false;
        for (const id of Object.keys(offers || {})) {
            const o = offers[id];
            const a = r.pool.find((x) => x.id === String(id));
            if (!a || !isObject(o) || !(Number(o.at) > (a.offeredAt || 0))) continue;
            const last = this.offerOf(r, id);
            if (last && (last.status === 'pending' || last.status === 'accepted')) continue;
            a.offeredAt = Number(o.at);
            const pay = Math.round(Math.max(PAY_MIN, Math.min(PAY_MAX, Number(o.pay) || 1)) * 10000) / 10000;
            r.offers.push({ id: a.id, name: a.name, pay, expect: a.expect, status: 'pending', at: Date.now(), dueAt: Date.now() + ANSWER_MS });
            r.offers = r.offers.slice(-OFFERS_KEPT);
            this.log.info('recruit: offer to ' + a.id + ' at ' + Math.round(pay * 100) + '% (expects ' + Math.round(a.expect * 100) + '%)');
            changed = true;
        }
        return changed;
    }

    // Offers that are due get their answer, one at a time.
    async answer(c, desk) {
        const r = this.state(c);
        const o = r.offers.find((x) => x.status === 'pending' && Date.now() >= (x.dueAt || 0));
        if (!o || this.busy) return;
        this.busy = true;
        try {
            const a = r.pool.find((x) => x.id === o.id) || { id: o.id, name: o.name, traits: [], skills: [], expect: o.expect };
            const staff = Object.keys(c.staff || {}).map((k) => c.staff[k].morale);
            const morale = staff.length ? staff.reduce((s, x) => s + x, 0) / staff.length : 60;
            const yes = this.rand() < acceptChance(o.pay, a.expect, morale);
            o.reply = await this.replyText(a, o, yes, c).catch(() => '');
            if (!yes) {
                o.status = 'declined';
                o.reply = o.reply || '谢谢您的邀请，不过待遇和我的期望还有些差距，这次就先不考虑了。';
                this.done(r, a.id);
                this.toast('OA：' + a.name + '婉拒了 offer');
                this.log.info('recruit: ' + a.id + ' declined');
                return;
            }
            // Seats as they are now: someone may have joined since.
            const fresh = await this.d.career.fresh(c.manager).catch(() => null);
            if (fresh && fresh.seatsKnown) r.vacancy = Number(fresh.seatsFree && fresh.seatsFree[fresh.entryRank || 1]) || 0;
            if (!(r.vacancy > 0)) {
                o.status = 'failed';
                o.note = '没有空的工位了';
                this.log.info('recruit: ' + a.id + ' said yes, no seat free');
                return;
            }
            const joined = await this.join(c, a.id, r.jobId);
            if (joined) {
                o.status = 'accepted';
                o.reply = o.reply || '太好了，谢谢您！我会尽快到岗。';
                r.hired.push(a.id);
                // Their pay is what was offered, from the first day.
                c.staff[a.id] = { morale: 70, loyalty: 65, pay: o.pay, since: Date.now() };
                this.done(r, a.id);
                this.toast('OA：' + a.name + '接受了 offer，已入职');
                this.log.info('recruit: ' + a.id + ' joined ' + c.cid);
            } else {
                o.status = 'failed';
                o.note = '答应了，但游戏没有办成入职';
                this.log.warn('recruit: ' + a.id + ' said yes, career_join did not take');
            }
        } finally {
            this.busy = false;
            if (typeof this.onChange === 'function') this.onChange();
        }
    }

    // Out of the pool, and not asked again.
    done(r, id) {
        r.pool = r.pool.filter((x) => x.id !== String(id));
        if (r.passed.indexOf(String(id)) < 0) r.passed = r.passed.concat([String(id)]).slice(-PASSED_KEPT);
    }

    async join(c, id, jobId) {
        if (!jobId) return false;
        await this.d.game.call('career_join', { entity_id: String(id), career_entity_id: String(c.cid), job_id: String(jobId) }).catch(() => null);
        await new Promise((res) => setTimeout(res, 1500));
        const after = await this.d.career.fresh(c.manager).catch(() => null);
        return !!(after && Array.isArray(after.roster) && after.roster.some((p) => p.id === String(id)));
    }

    // Their answer in their own words; '' leaves it to the default line.
    async replyText(a, o, yes, c) {
        const llm = this.d.llm;
        if (!llm || !llm.configured) return '';
        const wage = Math.round(o.pay * 100);
        const system = '你是' + a.name + '，' + [a.gender, a.age].filter(Boolean).join('、') + (a.traits.length ? '，性格：' + a.traits.join('、') : '') +
            '。你向「' + (c.name || '一家公司') + '」投了简历，对方发来了录用通知。用一两句话回复，像真人发的消息，口语，不客套。' +
            '不要提百分比。只输出 JSON：{"text":"……"}';
        const ask = '对方给的日薪是基本工资的 ' + wage + '%，你心里期望大约 ' + Math.round(a.expect * 100) + '%。你决定' +
            (yes ? '接受，表达你的高兴或干脆，按你的性格。' : '婉拒，给一个真实的理由（待遇、时间、方向不合适等），按你的性格。');
        const r = await llm.json(system, ask, { purpose: 'recruit', max_tokens: 160, thinking: 'disabled' });
        return r && typeof r.text === 'string' ? r.text.trim().slice(0, 80) : '';
    }

    // What the phone shows.
    view(c) {
        const r = this.state(c);
        return {
            vacancy: typeof r.vacancy === 'number' ? r.vacancy : null, jobName: r.jobName || '',
            pool: r.pool.map((a) => Object.assign({}, a, { offer: this.offerOf(r, a.id) })),
            offers: r.offers.slice(-OFFERS_KEPT)
        };
    }

    toast(text) {
        if (this.d.game) this.d.game.soft('toast_show', { Message: text, Lifetime: 6 }).catch(() => {});
    }
}

module.exports = { Recruit, fitOf, expectOf, acceptChance, letterOf };
