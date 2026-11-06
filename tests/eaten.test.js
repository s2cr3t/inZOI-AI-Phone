'use strict';
// What a character really ate today (eaten.js) and how the prompt says it (persona.mealsText):
// "吃了没" must be answered from meals seen eaten, not from an eat task only walked to, and not
// from a diary whose last few lines no longer reach back to the meal.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EatLog, mealOf } = require('../lib/eaten');
const { World } = require('../lib/world');
const persona = require('../lib/persona');

function tmpLog() {
    return new EatLog(fs.mkdtempSync(path.join(os.tmpdir(), 'eaten-')));
}
const at = (day, h, m) => ({ day, hour: h, minute: m || 0 });
const eat = (id, begun) => ({ idle: false, id, begun });
const idle = { idle: true, id: null };

// One look every five game minutes from..to (inclusive), doing `act(minute)`.
function watch(log, who, day, fromMin, toMin, act, boot) {
    for (let t = fromMin; t <= toMin; t += 5) log.observe(who, act(t), at(day, Math.floor(t / 60), t % 60), boot || 'b1', 60);
}

test('an eat task only walked to, plated up or held is not a meal', () => {
    const log = tmpLog();
    watch(log, '1', 1023, 18 * 60, 18 * 60 + 30, () => eat('Next_Food_Start_Eat', false));
    assert.deepStrictEqual(log.today('1', at(1023, 18, 40), 'b1'), []);
});

test('the steps of one sitting are one meal, with when it began and ended', () => {
    const log = tmpLog();
    watch(log, '1', 1023, 6 * 60, 22 * 60, (t) => {
        if (t >= 6 * 60 + 25 && t <= 6 * 60 + 45) return eat('Next_Food_Start_Eat', true);
        if (t >= 20 * 60 + 40 && t <= 20 * 60 + 50) return eat('PreparedCake_EatServedCake', true);
        if (t === 20 * 60 + 55) return { idle: false, id: 'Next_Food_CleanUp' };
        if (t >= 21 * 60 && t <= 21 * 60 + 10) return eat('Next_Food_Start_Eat', true);
        return idle;
    });
    const meals = log.today('1', at(1023, 22, 0), 'b1');
    assert.deepStrictEqual(meals.map((m) => [m.meal, m.start, m.end, m.ongoing]), [
        ['breakfast', '06:25', '06:45', false],
        ['dinner', '20:40', '21:10', false]
    ]);
    // Persisted: a restarted bridge still knows.
    const again = new EatLog(path.dirname(log.dir));
    assert.strictEqual(again.today('1', at(1023, 22, 0), 'b1').length, 2);
});

test('drinking is not a meal', () => {
    const log = tmpLog();
    watch(log, '1', 1023, 19 * 60, 19 * 60 + 20, () => eat('Drink_Coffee_Mug', true));
    assert.deepStrictEqual(log.today('1', at(1023, 19, 30), 'b1'), []);
});

test('yesterday\'s dinner is not today\'s', () => {
    const log = tmpLog();
    watch(log, '1', 1022, 19 * 60, 19 * 60 + 20, () => eat('Next_Food_Start_Eat', true));
    assert.deepStrictEqual(log.today('1', at(1023, 19, 30), 'b1'), []);
});

test('a save loaded back to before dinner forgets that dinner, but keeps breakfast', () => {
    const log = tmpLog();
    watch(log, '1', 1023, 6 * 60, 21 * 60, (t) => (t >= 7 * 60 && t <= 7 * 60 + 15) || (t >= 19 * 60 && t <= 19 * 60 + 20) ? eat('Next_Food_Start_Eat', true) : idle, 'b1');
    // Loaded at 18:00 of the same day: another boot of the Lua mod.
    log.observe('1', idle, at(1023, 18, 0), 'b2', 40);
    const meals = log.today('1', at(1023, 18, 5), 'b2');
    assert.deepStrictEqual(meals.map((m) => m.meal), ['breakfast']);
    // Watched since the morning in both worlds.
    assert.strictEqual(log.watchedSince('1', at(1023, 18, 5), 'b2'), '06:00');
});

test('watched since: a fast-running game is still watched, a stopped bridge is not', () => {
    const log = tmpLog();
    const real = 1000000;
    log.observe('1', idle, at(1023, 6, 0), 'b1', 60, real);
    // Sleeping: 50 game minutes in one 20 s look.
    log.observe('1', idle, at(1023, 6, 50), 'b1', 60, real + 20000);
    assert.strictEqual(log.watchedSince('1', at(1023, 6, 50), 'b1', real + 20000), '06:00');
    // The bridge was off for an hour of game time and ten real minutes.
    log.observe('1', idle, at(1023, 8, 0), 'b1', 60, real + 620000);
    assert.strictEqual(log.watchedSince('1', at(1023, 8, 0), 'b1', real + 620000), '08:00');
    // Not looked at for a while: nobody is watching now.
    assert.strictEqual(log.watchedSince('1', at(1023, 10, 0), 'b1', real + 1300000), null);
});

test('world.eatProgress feeds the log: eating counts once Hunger goes up', () => {
    const world = new World(null, null);
    const log = tmpLog();
    const steps = [[19 * 60, 40], [19 * 60 + 5, 39], [19 * 60 + 10, 52], [19 * 60 + 15, 70]];
    for (const [t, hunger] of steps) {
        const a = { idle: false, id: 'Next_Food_Start_Eat', target: '9' };
        world.eatProgress('1', a, { Hunger: hunger });
        log.observe('1', a, at(1023, Math.floor(t / 60), t % 60), 'b1', hunger);
    }
    const meals = log.today('1', at(1023, 19, 15), 'b1');
    assert.strictEqual(meals.length, 1);
    assert.strictEqual(meals[0].start, '19:10');
    assert.strictEqual(meals[0].ongoing, true);
});

test('after midnight, last night\'s dinner is still today\'s; after 04:00 it is not', () => {
    const log = tmpLog();
    watch(log, '1', 1023, 19 * 60, 19 * 60 + 20, () => eat('Next_Food_Start_Eat', true));
    const night = log.today('1', at(1024, 1, 0), 'b1');
    assert.deepStrictEqual(night.map((m) => [m.meal, m.start]), [['dinner', '19:00']]);
    const s = persona.mealsText(night, at(1024, 1, 0), { Hunger: 70 }, '18:00');
    assert.match(s, /晚饭吃过了（19:00~19:20 吃的）/);
    assert.deepStrictEqual(log.today('1', at(1024, 7, 0), 'b1'), []);
});

test('meal of the day by the hour it began', () => {
    assert.strictEqual(mealOf(1023 * 1440 + 7 * 60), 'breakfast');
    assert.strictEqual(mealOf(1023 * 1440 + 12 * 60), 'lunch');
    assert.strictEqual(mealOf(1023 * 1440 + 19 * 60), 'dinner');
    assert.strictEqual(mealOf(1023 * 1440 + 23 * 60), 'late');
});

test('prompt: dinner not eaten yet, watched all day', () => {
    const meals = [{ meal: 'breakfast', start: '06:25', end: '06:45', ongoing: false, minutesAgo: 900 }];
    const s = persona.mealsText(meals, at(1023, 21, 32), { Hunger: 48 }, '04:00');
    assert.match(s, /早饭吃过了（06:25~06:45 吃的）/);
    assert.match(s, /午饭没吃/);
    assert.match(s, /晚饭还没吃/);
    assert.match(s, /饥饿 48%/);
    assert.doesNotMatch(s, /晚饭吃过/);
});

test('prompt: dinner eaten, and when', () => {
    const meals = [{ meal: 'dinner', start: '20:42', end: '20:55', ongoing: false, minutesAgo: 37 }];
    const s = persona.mealsText(meals, at(1023, 21, 32), { Hunger: 98 }, '16:00');
    assert.match(s, /晚饭吃过了（20:42~20:55 吃的）/);
    assert.match(s, /上一顿是 20:55 吃完的，过去 37 分钟了/);
    assert.doesNotMatch(s, /晚饭还没吃/);
});

test('prompt: eating dinner right now', () => {
    const meals = [{ meal: 'dinner', start: '19:10', end: '19:15', ongoing: true, minutesAgo: 0 }];
    const s = persona.mealsText(meals, at(1023, 19, 15), { Hunger: 70 }, '06:00');
    assert.match(s, /晚饭正在吃（19:10 开始吃的）/);
});

test('prompt: a meal nobody watched is not claimed either way; the stomach is the hint', () => {
    const s = persona.mealsText([], at(1023, 21, 32), { Hunger: 98 }, '21:30');
    assert.doesNotMatch(s, /晚饭没吃|晚饭还没吃|晚饭吃过/);
    assert.match(s, /晚饭有没有吃，没人看到/);
    assert.match(s, /多半吃过了/);
    const partly = persona.mealsText([], at(1023, 21, 32), { Hunger: 30 }, '20:00');
    assert.match(partly, /晚饭在 20:00 以后没吃过，更早有没有吃不确定/);
    assert.match(partly, /多半还没吃/);
});

test('prompt: nothing tracked at all says nothing', () => {
    assert.strictEqual(persona.mealsText(undefined, at(1023, 21, 0), { Hunger: 50 }, ''), '');
});
