'use strict';
// Recruiting (lib/recruit.js): jobless grown-ups in town apply with the game's own skills and
// traits; an offer near what they expect is taken, and taking it joins them to the company.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Recruit, fitOf, expectOf, acceptChance } = require('../lib/recruit');

test('fit and expected pay follow the company skill', () => {
    const skills = [{ id: 'Instruments', level: 4 }, { id: 'Art', level: 2 }];
    assert.ok(fitOf(skills, 'Instruments') > fitOf(skills, 'Cooking'));
    assert.ok(expectOf(skills, 'Instruments', 70) > expectOf(skills, 'Cooking', 20));
    assert.ok(acceptChance(1.3, 1.1, 60) > acceptChance(0.9, 1.1, 60));
});

test('applicants come from the jobless grown-ups, and an accepted offer joins them', async () => {
    let roster = [{ id: '11', rank: 1 }];
    const calls = [];
    const people = [
        { entity_id: 501, first_name: '一', last_name: '王', employable: true, has_career: false, age_group: 'Adult', gender: 'Male' },
        { entity_id: 502, first_name: '二', last_name: '王', employable: true, has_career: true, age_group: 'Adult' },
        { entity_id: 503, first_name: '三', last_name: '王', employable: true, has_career: false, age_group: 'Child' }
    ];
    const d = {
        log: { info() {}, warn() {} },
        game: {
            soft: async (n) => n === 'career_list_openings' ? { openings: [{ career_entity_id: 900, job_id: 'Job_1', job_name: '职员', vacancy: 1 }] }
                : n === 'world_list_characters' ? { characters: people }
                : n === 'skill_get_all' ? { skills: [{ id: 'Instruments', l10n: '乐器', level: 3 }] } : null,
            call: async (n, a) => { calls.push(n); if (n === 'career_join') roster = roster.concat([{ id: a.entity_id, rank: 1 }]); }
        },
        world: { cached: async (k, t, fn) => fn(), traits: async () => ({ traits: ['Cheerful'] }), household: async () => ({ members: [] }) },
        career: { fresh: async () => ({ roster }) },
        llm: null
    };
    const r = new Recruit(d);
    r.rand = () => 0;
    const c = { cid: '900', manager: '1', name: '星河', staff: { 11: { morale: 60 } }, catalogue: [{ id: 'P', skill: 'Instruments' }] };
    await r.tick(c, { jobId: 'Job_1' }, { day: 5 });
    const v = r.view(c);
    assert.deepEqual(v.pool.map((a) => a.id), ['501'], 'only the jobless grown-up');
    assert.equal(v.pool[0].key.level, 3);
    assert.equal(v.vacancy, 1);
    r.takeOffers(c, { 501: { pay: 1.5, at: 1 } });
    c.recruit.offers[0].dueAt = 0;
    await r.answer(c, {});
    assert.equal(c.recruit.offers[0].status, 'accepted');
    assert.ok(calls.includes('career_join'));
    assert.equal(c.staff['501'].pay, 1.5, 'paid what was offered');
    assert.equal(r.view(c).pool.length, 0);
});

test('no free seat at the entry rank: nobody is hired over someone else', async () => {
    const calls = [];
    const d = {
        log: { info() {}, warn() {} },
        game: { soft: async () => null, call: async (n) => { calls.push(n); } },
        world: {},
        career: { fresh: async () => ({ seatsKnown: true, seatsFree: { 3: 1 }, entryRank: 1, roster: [] }) },
        llm: null
    };
    const r = new Recruit(d);
    r.rand = () => 0;
    const c = { cid: '900', manager: '1', staff: {}, recruit: { pool: [{ id: '501', name: '王一', expect: 1 }], offers: [], passed: [], hired: [], vacancy: 1, jobId: 'Job_1' } };
    r.takeOffers(c, { 501: { pay: 1.5, at: 1 } });
    c.recruit.offers[0].dueAt = 0;
    await r.answer(c, {});
    assert.equal(c.recruit.offers[0].status, 'failed');
    assert.ok(!calls.includes('career_join'));
});
