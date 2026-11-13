'use strict';
// 成长册: growing up writes the booklet of the stage left, from that stage's records only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Booklet } = require('../lib/booklet');

test('growing up writes the stage left from its own records; a stage jumped through makes no booklet', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'booklet-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const data = path.join(root, 'data');
    const phone = path.join(root, 'phone');
    for (const d of ['chronicle', 'memory', 'stories']) fs.mkdirSync(path.join(data, d), { recursive: true });
    fs.writeFileSync(path.join(data, 'chronicle', '1.json'), JSON.stringify({ v: 2, profiles: { 7: { name: '小满', skills: { Art: 3 } } }, events: [
        { day: 3, who: ['7', '8'], kind: 'affection', text: '小满给姐姐画了一张画', w: 2 },
        { day: 4, who: ['7'], kind: 'skill', text: '小满的「艺术」升到了 2 级', w: 2 },
        { day: 5, who: ['7'], kind: 'skill', text: '小满的「艺术」升到了 3 级', w: 2 },
        { day: 30, who: ['7'], kind: 'affection', text: '后来的事', w: 2 }
    ] }));
    fs.writeFileSync(path.join(data, 'memory', '8-7.json'), JSON.stringify({ facts: [{ text: '小满在院子里捡到一块圆石头', day: 4 }, { text: '很久以前的事', day: 0 }] }));
    fs.writeFileSync(path.join(data, 'stories', '8-7.json'), JSON.stringify({ ended: [{ title: '石头的秘密', kind: '秘密', premise: '把石头藏在枕头下', outcome: '告诉了姐姐', good: true, endedDay: 5 }] }));
    let asked = '';
    const d = {
        log: { info() {}, warn() {} },
        chronicle: { dir: path.join(data, 'chronicle'), book: (k) => JSON.parse(fs.readFileSync(path.join(data, 'chronicle', k + '.json'), 'utf8')) },
        memory: { dir: path.join(data, 'memory') },
        stories: { dir: path.join(data, 'stories') },
        world: { relations: async () => [{ id: '8', name: '姐姐', isFamily: true, stats: { Friendship: 60 } }], traits: async () => ({ traits: [] }) },
        llm: { json: async (system, ask) => {
            asked = ask;
            return { title: '圆石头', opening: '你那时候总蹲在院子里。', worries: [{ title: '石头的秘密', text: '你把石头藏起来，后来告诉了姐姐。' }],
                friends: [{ id: '8', text: '你的画第一个给她看。' }, { id: '99', text: '不在候选里的人' }], moments: ['捡到一块圆石头'], achievements: ['艺术到了 3 级'], character: '', letter: '慢慢长大。' };
        } }
    };
    const b = new Booklet(d);
    b.configure(data, phone);
    await b.observe([{ entity_id: 7, first_name: '满', last_name: '小', age_group: 'Toddler' }], { day: 2 });
    // The game reports the stage as a number, through a stage jumped in no time.
    b.grew('7', 'Toddler', '4', 6);
    b.grew('7', '4', 'LowTeen', 6);
    await b.tick({ day: 6 });
    await b.tick({ day: 6 });
    const board = JSON.parse(fs.readFileSync(path.join(phone, 'booklet', 'board.cfg'), 'utf8'));
    const books = board.people['7'].books;
    assert.equal(books.length, 1, 'the Child stage lasted no time and holds nothing');
    assert.equal(books[0].stage, 'Toddler');
    assert.equal(books[0].song.title, '小手拉小手');
    assert.equal(board.people['7'].stage, 'LowTeen');
    assert.deepEqual(books[0].friends.map((f) => f.name), ['姐姐'], 'only a candidate can be the closest');
    assert.match(asked, /画了一张画/);
    assert.match(asked, /圆石头/);
    assert.match(asked, /石头的秘密/);
    assert.match(asked, /升到了 3 级/);
    assert.doesNotMatch(asked, /升到了 2 级|后来的事|很久以前/, 'only the stage, and a skill once at its highest');
    // A save loaded from before: the stage going back is no growing up.
    b.grew('7', 'LowTeen', 'Child', 7);
    assert.equal(b.data.queue.length, 0);
    // A birthday cake: the game's event has no day, and the stage seen at the start holds little.
    await b.observe([{ entity_id: 8, first_name: '雨', last_name: '小', age_group: 'HighTeen' }], { day: 9 });
    await b.tick({ day: 10 });
    b.grew('8', 'HighTeen', '32');
    await b.tick({ day: 10 });
    const after = JSON.parse(fs.readFileSync(path.join(phone, 'booklet', 'board.cfg'), 'utf8'));
    assert.equal(after.people['8'].books.length, 1, 'the cake still ends the stage with its booklet');
    assert.equal(after.people['8'].books[0].to, 10);
});
