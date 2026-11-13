'use strict';
// 成长册: for every life stage a person lives through, a small booklet of that stage, written when
// they leave it (and a last one when they die): what was on their mind, who they were closest
// to, the everyday moments, what they achieved, the character they grew into, a few words to
// them, and the stage's own song. Everything in it comes from what the bridge and the game
// recorded during the stage; the model only chooses and words it, and leaves a page empty
// rather than make something up.
//
// The stage's records, between the day it started and the day it ended:
//   chronicle    the household's big moments the person took part in (chronicle.js)
//   memory       facts and episode summaries of the chats with or about them (memory.js)
//   stories      the stories of their own that ended (心事, stories.js)
//   moments      their own Moments posts
//   ties         who they felt warm to, and what they were grateful for (ties.js)
//   the game     relationships, traits, skills, job and school, now and at the stage's start
//
// Files:
//   data/booklets.json                     { v, people: { <id>: person }, queue: [item] }   here only
//   <phone>/booklet/board.cfg              what the phone's 成长册 shows                    here only
//   <phone>/booklet/request.cfg            { seq, id, op: 'draft', at }                      phone only
//   <phone>/booklet/songs/<song>.webm      the songs (tools/make-booklet-music.js)
// A person: { name, stage, start: { day, traits, skills }, books: [book], draftDay }.
// A draft is the stage still being lived, written on the player's asking (at most once a game day).
const path = require('path');
const fsx = require('./fsx');
const { STAGES } = require('./aging');

const V = 1;
// Which song a stage's booklet plays: the stage being left. Edit to change the soundtrack.
const SONGS = {
    open: { title: '第一次睁眼', file: 'open-eyes' },
    hand: { title: '小手拉小手', file: 'hand-in-hand' },
    grow: { title: '多长一点点', file: 'grow-a-little' },
    crush: { title: '第一次喜欢一个人', file: 'first-crush' },
    go: { title: '为何出发', file: 'why-set-out' },
    carry: { title: '扛起生活', file: 'carry-life' },
    thanks: { title: '谢谢你曾来过我的生命', file: 'thank-you' }
};
const STAGE_SONG = { Infant: 'open', Toddler: 'hand', Child: 'grow', LowTeen: 'grow', HighTeen: 'crush', Youth: 'go', Adult: 'carry', Old: 'thanks', Elderly: 'thanks' };
// What a booklet of the stage is called.
const STAGE_BOOK = {
    Infant: '刚来到世界', Toddler: '幼儿时光', Child: '童年', LowTeen: '少年时代', HighTeen: '青春',
    Youth: '青年时代', Adult: '成年的日子', Old: '中年', Elderly: '晚年'
};
const BY_KEY = new Map(STAGES.map((s) => [s.key, s]));
const BY_VALUE = new Map(STAGES.map((s) => [String(s.value), s]));
const STAGE_ORDER = STAGES.map((s) => s.key);
const BOOKS_KEPT = 12;
const TRIES = 3;
const RETRY_MS = 10 * 60000;
// A stage this short with this little in it is not a booklet (an age-up jumping several stages).
const MIN_ITEMS = 3;
// How long after growing up the game's member list may still show the stage left.
const STALE_MS = 3 * 60000;
// Per page, what the model is given at most.
const LIMIT = { chronicle: 40, facts: 40, episodes: 12, stories: 8, posts: 12, friends: 6 };

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function clip(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }
// A stage as the game names it (age_group) from either its name or its EB1GrowthStep number.
function stageKey(v) {
    const s = BY_KEY.get(String(v)) || BY_VALUE.get(String(v));
    return s ? s.key : '';
}
function stageZh(key) { const s = BY_KEY.get(key); return s ? s.zh : ''; }
function inRange(day, from, to) { return typeof day === 'number' && day >= from && day <= to; }

class Booklet {
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.data = { v: V, people: {}, queue: [] };
        this.busy = false;
        this.lastSeq = 0;
    }

    configure(dataDir, phoneDir) {
        this.file = path.join(dataDir, 'booklets.json');
        this.dir = path.join(phoneDir, 'booklet');
        this.boardFile = path.join(this.dir, 'board.cfg');
        this.requestFile = path.join(this.dir, 'request.cfg');
        this.phoneDir = phoneDir;
        this.dataDir = dataDir;
        const r = fsx.readJson(this.file);
        const v = r.ok && isObject(r.value) ? r.value : {};
        this.data = { v: V, people: isObject(v.people) ? v.people : {}, queue: Array.isArray(v.queue) ? v.queue : [] };
        // A request older than this start is not answered again.
        const q = fsx.readJson(this.requestFile);
        this.lastSeq = q.ok && q.value && typeof q.value.seq === 'number' ? q.value.seq : 0;
        this.publish();
    }

    save() {
        try {
            fsx.writeJson(this.file, this.data, true);
        } catch (e) {
            this.log.warn('booklet: not saved: ' + e.message);
        }
    }

    person(id, name) {
        const k = String(id);
        let p = this.data.people[k];
        if (!isObject(p)) p = this.data.people[k] = { name: name || '', stage: '', start: null, books: [], draftDay: null };
        if (!Array.isArray(p.books)) p.books = [];
        if (name) p.name = name;
        return p;
    }

    // ------------------------------------------------------------ what happens
    // The household members as the game lists them (daemon, every minute): a person seen for the
    // first time starts their stage here (as far back as the game says they have been in it), and
    // a stage that changed without legacy.js telling is a growing up too.
    async observe(members, env) {
        if (!Array.isArray(members) || !env || typeof env.day !== 'number') return;
        this.today = env.day;
        let changed = false;
        for (const m of members) {
            const id = String(m && m.entity_id || '');
            const stage = stageKey(m && m.age_group);
            if (!id || !stage) continue;
            const p = this.person(id, [m.last_name, m.first_name].filter(Boolean).join(''));
            if (!p.stage) {
                const a = this.d.aging && this.d.aging.get(id);
                const into = a && a.stageKey === stage && typeof a.daysInStage === 'number' ? Math.floor(a.daysInStage) : 0;
                p.stage = stage;
                p.start = { day: env.day - into, traits: await this.traitsOf(id), skills: this.skillsOf(id), seenAt: env.day, via: 'seen' };
                changed = true;
            } else if (p.stage !== stage) {
                this.grew(id, p.stage, stage, env.day);
                changed = true;
            }
            if (p.start && !p.start.traits) {
                p.start.traits = await this.traitsOf(id);
                changed = true;
            }
        }
        if (changed) {
            this.save();
            this.publish();
        }
    }

    // Grew from one stage to the next (legacy.js on the game's event, or observe): the booklet of
    // the stage left is written. The game's event may come without the day (a birthday cake):
    // the last day seen is taken. A stage going back (a save loaded from before) is no growing
    // up: the person is in that stage from now on, and nothing is written.
    grew(id, from, to, day) {
        const p = this.person(id);
        const left = stageKey(p.stage) || stageKey(from);
        const now = stageKey(to);
        if (!now || left === now) return;
        // Right after the game's growing-up event its member list can still say the stage just
        // left for a moment: that is no going back.
        if (now === p.left && Date.now() - (p.grewAt || 0) < STALE_MS) return;
        if (typeof day !== 'number') day = typeof this.today === 'number' ? this.today : null;
        const start = p.start || { day };
        p.stage = now;
        p.start = { day: typeof day === 'number' ? day : start.day, traits: null, skills: this.skillsOf(id), via: 'grew' };
        if (left && STAGE_ORDER.indexOf(now) < STAGE_ORDER.indexOf(left)) {
            p.start.via = 'seen';
            this.log.info('booklet: ' + (p.name || id) + ' is ' + now + ' again (was ' + left + '), a save from before: no booklet');
            this.save();
            this.publish();
            return;
        }
        p.left = left;
        p.grewAt = Date.now();
        if (!left || typeof day !== 'number') return;
        // A stage gone through in no time (several stages at once) has nothing to tell.
        this.enqueue({ id: String(id), kind: 'stage', stage: left, next: now, from: start.day, to: day, jump: start.via === 'grew', startTraits: start.traits || null, startSkills: start.skills || null });
        this.log.info('booklet: ' + (p.name || id) + ' left ' + left + ' for ' + now + ', its booklet is queued');
        this.save();
        this.publish();
    }

    // Died: the booklet of the last stage, which ends the life.
    died(id, day) {
        const p = this.data.people[String(id)];
        if (!p || !p.stage || typeof day !== 'number') return;
        const start = p.start || { day };
        this.enqueue({ id: String(id), kind: 'final', stage: p.stage, next: '', from: start.day, to: day, startTraits: start.traits || null, startSkills: start.skills || null });
        this.save();
        this.publish();
    }

    enqueue(item) {
        this.data.queue = this.data.queue.filter((q) => !(q.id === item.id && q.kind === item.kind && q.stage === item.stage));
        this.data.queue.push(Object.assign({ tries: 0, nextAt: 0 }, item));
    }

    // ------------------------------------------------------------ every few seconds
    async tick(env) {
        if (env && typeof env.day === 'number') this.today = env.day;
        if (this.busy) return;
        this.busy = true;
        try {
            this.requests(env);
            const item = this.data.queue.find((q) => Date.now() >= (q.nextAt || 0));
            if (item) await this.write(item);
        } catch (e) {
            this.log.warn('booklet: ' + (e && e.message || e));
        } finally {
            this.busy = false;
        }
    }

    // The phone asks for the stage being lived so far ("先翻翻看").
    requests(env) {
        const r = fsx.readJson(this.requestFile);
        const q = r.ok && isObject(r.value) ? r.value : null;
        if (!q || typeof q.seq !== 'number' || q.seq <= this.lastSeq) return;
        this.lastSeq = q.seq;
        const p = this.data.people[String(q.id)];
        if (q.op !== 'draft' || !p || !p.stage || !env || typeof env.day !== 'number') return;
        if (this.data.queue.some((x) => x.id === String(q.id) && x.kind === 'draft')) return;
        const start = p.start || { day: env.day };
        this.enqueue({ id: String(q.id), kind: 'draft', stage: p.stage, next: '', from: start.day, to: env.day, startTraits: start.traits || null, startSkills: start.skills || null });
        this.log.info('booklet: a draft of ' + (p.name || q.id) + '\'s ' + p.stage + ' asked for');
        this.save();
        this.publish();
    }

    async write(item) {
        const p = this.person(item.id);
        let book = null;
        try {
            // A booklet written in advance for this person and stage (a household set up for a
            // demonstration, data/booklet-presets.json) is used as it is: no records, no model.
            const preset = item.kind !== 'draft' ? this.preset(item) : null;
            const rec = preset ? null : await this.gather(item);
            if (preset) {
                book = this.fromPreset(item, preset);
            } else if (rec.count < MIN_ITEMS && item.kind === 'stage' && item.jump && item.to - item.from < 1) {
                this.log.info('booklet: ' + (p.name || item.id) + '\'s ' + item.stage + ' lasted no time and holds nothing, no booklet');
            } else {
                book = await this.compose(item, p, rec);
            }
        } catch (e) {
            item.tries = (item.tries || 0) + 1;
            item.nextAt = Date.now() + RETRY_MS;
            this.log.warn('booklet: ' + (p.name || item.id) + '\'s ' + item.stage + ' not written (' + item.tries + '/' + TRIES + '): ' + e.message);
            if (item.tries < TRIES) {
                this.save();
                return;
            }
        }
        this.data.queue = this.data.queue.filter((q) => q !== item);
        if (book) {
            p.books = p.books.filter((b) => !(b.draft && b.stage === book.stage) && b.id !== book.id).concat([book]).slice(-BOOKS_KEPT);
            if (book.draft) p.draftDay = item.to;
            this.log.info('booklet: ' + (p.name || item.id) + '\'s ' + (book.draft ? 'draft of ' : '') + item.stage + ' written: 「' + book.title + '」');
        }
        this.save();
        this.publish();
    }

    // ------------------------------------------------------------ the stage's records
    async gather(item) {
        const id = String(item.id);
        const from = item.from;
        const to = item.to;
        const names = this.names();
        const out = { chronicle: [], facts: [], episodes: [], stories: [], posts: [], friends: [], thanks: [], achievements: [], traits: { now: [], before: [] }, school: null, job: '', count: 0 };
        // The household's big moments they took part in.
        for (const b of this.chronicleBooks()) {
            for (const e of b.events) {
                if (!Array.isArray(e.who) || e.who.indexOf(id) < 0 || !inRange(e.day, from, to)) continue;
                if (e.kind === 'skill' || e.kind === 'career' || e.kind === 'milestone' || e.kind === 'growth') out.achievements.push({ day: e.day, text: e.text });
                else out.chronicle.push({ day: e.day, kind: e.kind, text: e.text, w: e.w || 1 });
            }
        }
        out.chronicle = out.chronicle.sort((a, b) => b.w - a.w || a.day - b.day).slice(0, LIMIT.chronicle).sort((a, b) => a.day - b.day);
        // Skills: only the highest level reached of each in the stage.
        const best = new Map();
        for (const a of out.achievements) {
            const m = /「(.+?)」升到了 (\d+) 级/.exec(a.text);
            if (!m) continue;
            const prev = best.get(m[1]);
            if (!prev || Number(m[2]) > prev.level) best.set(m[1], { level: Number(m[2]), item: a });
        }
        out.achievements = out.achievements.filter((a) => {
            const m = /「(.+?)」升到了 (\d+) 级/.exec(a.text);
            return !m || best.get(m[1]).item === a;
        });
        // The chats: facts and episode summaries, from the files of the pairs they are in.
        for (const f of this.listDir(this.d.memory && this.d.memory.dir)) {
            const m = /^(\d+)-(\d+)\.json$/.exec(f);
            if (!m || (m[1] !== id && m[2] !== id)) continue;
            const r = fsx.readJson(path.join(this.d.memory.dir, f));
            const mem = r.ok && isObject(r.value) ? r.value : {};
            for (const x of Array.isArray(mem.facts) ? mem.facts : []) if (x && x.text && inRange(x.day, from, to)) out.facts.push({ day: x.day, text: clip(x.text, 120) });
            for (const x of Array.isArray(mem.episodes) ? mem.episodes : []) {
                const text = x && (x.summary || x.text);
                if (text && inRange(x.day, from, to)) out.episodes.push({ day: x.day, text: clip(text, 200) });
            }
        }
        out.facts = dedupe(out.facts).slice(-LIMIT.facts);
        out.episodes = out.episodes.slice(-LIMIT.episodes);
        // Their own stories that ended in the stage: what was on their mind.
        for (const f of this.listDir(this.d.stories && this.d.stories.dir)) {
            const m = /^(\d+)-(\d+)\.json$/.exec(f);
            if (!m || m[2] !== id) continue;
            const r = fsx.readJson(path.join(this.d.stories.dir, f));
            for (const s of r.ok && r.value && Array.isArray(r.value.ended) ? r.value.ended : []) {
                if (!s || !inRange(s.endedDay, from, to)) continue;
                out.stories.push({ day: s.endedDay, title: clip(s.title, 30), kind: clip(s.kind, 10), premise: clip(s.premise, 200), outcome: clip(s.outcome, 200), good: !!s.good, with: names[m[1]] || '' });
            }
        }
        out.stories = out.stories.slice(-LIMIT.stories);
        // Their own Moments posts.
        const feed = fsx.readJson(path.join(this.phoneDir, 'moments', 'feed.cfg'));
        for (const x of feed.ok && feed.value && Array.isArray(feed.value.posts) ? feed.value.posts : []) {
            const day = x && x.game && x.game.day;
            if (x && String(x.authorId) === id && inRange(day, from, to)) out.posts.push({ day, text: clip(x.text, 140), likes: Array.isArray(x.likes) ? x.likes.length : 0 });
        }
        out.posts = out.posts.slice(-LIMIT.posts);
        // Who they were closest to: the game's bonds, then the warmth kept here.
        const rel = await (this.d.world && this.d.world.relations ? this.d.world.relations(id).catch(() => []) : []);
        const ties = this.d.ties && this.d.ties.data && isObject(this.d.ties.data.ties) ? this.d.ties.data.ties : {};
        const cand = new Map();
        for (const x of Array.isArray(rel) ? rel : []) {
            const stats = isObject(x.stats) ? x.stats : {};
            const keys = Object.keys(stats);
            if (!keys.length) continue;
            const top = keys.reduce((a, b) => (stats[b] > stats[a] ? b : a));
            cand.set(String(x.id), { id: String(x.id), name: x.name || names[x.id] || '', family: !!x.isFamily, bond: top, score: stats[top] });
        }
        for (const k of Object.keys(ties)) {
            const [h, t] = k.split('>');
            if (h !== id || !t) continue;
            const c = cand.get(t) || { id: t, name: names[t] || '', family: false, bond: '', score: 0 };
            c.warmth = ties[k].warmth || 0;
            cand.set(t, c);
            for (const th of Array.isArray(ties[k].thanks) ? ties[k].thanks : []) {
                if (th && inRange(th.day, from, to)) out.thanks.push({ to: c.name || t, about: clip(th.about, 80) });
            }
        }
        out.friends = Array.from(cand.values()).filter((c) => c.name && c.id !== id)
            .sort((a, b) => (b.score + (b.warmth || 0) * 5) - (a.score + (a.warmth || 0) * 5)).slice(0, LIMIT.friends);
        // Character: the traits now and at the stage's start; the skills that grew.
        out.traits.now = await this.traitsOf(id);
        out.traits.before = Array.isArray(item.startTraits) ? item.startTraits : [];
        const skillsNow = this.skillsOf(id);
        const skillsThen = isObject(item.startSkills) ? item.startSkills : {};
        out.skills = Object.keys(skillsNow).map((k) => ({ skill: k, from: Number(skillsThen[k]) || 0, to: Number(skillsNow[k]) || 0 }))
            .filter((s) => s.to > s.from).sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 6);
        // School and work as the stage ends.
        const rep = this.d.school && this.d.school.byId ? this.d.school.byId[id] : null;
        if (rep && !rep.none) out.school = { school: rep.school || '', grade: rep.grade || '', club: rep.club || '', className: rep.className || '' };
        const prof = this.profile(id);
        if (prof && prof.job) out.job = prof.job + (prof.rankName ? '（' + prof.rankName + '）' : '');
        out.count = out.chronicle.length + out.facts.length + out.episodes.length + out.stories.length + out.posts.length + out.achievements.length;
        return out;
    }

    // ------------------------------------------------------------ the booklet itself
    async compose(item, p, rec) {
        const name = p.name || '这个人';
        const stage = item.stage;
        const song = SONGS[STAGE_SONG[stage]] || SONGS.grow;
        const lines = (list, f) => list.map(f).join('\n');
        const system = [
            '你在给' + name + '整理一本「成长册」：TA ' + stageZh(stage) + '这一段（第 ' + item.from + ' 天到第 ' + item.to + ' 天）的回忆。',
            '像家里人一笔一笔记下来的手账：具体、温暖、有画面，不煽情、不说教，不用排比和华丽的形容。',
            '只写下面记录里真发生过的事，人名、物件、细节都照记录来；记录里没有的，宁可空着，也不要编。',
            '记录少就写得短，那一页留空；不要说「没有特别的事」「虽然只有一天」这类话，不要提第几天、记录、游戏。',
            '最后几句话也只从记录里的事说起，不要编家里的近况，不要和这段人生无关的叮嘱。',
            '用第二人称「你」写给' + name + '。只输出 JSON。'
        ].join('\n');
        const ask = [
            '【大事】', lines(rec.chronicle, (e) => '第' + e.day + '天 ' + e.text) || '（无）',
            '【聊天里记下的事】', lines(rec.facts, (e) => '第' + e.day + '天 ' + e.text) || '（无）',
            '【聊天的片段】', lines(rec.episodes, (e) => '第' + e.day + '天 ' + e.text) || '（无）',
            '【心事（TA 自己的故事）】', lines(rec.stories, (s) => '「' + s.title + '」（' + s.kind + '，和' + (s.with || '家人') + '有关）起因：' + s.premise + ' 结果：' + s.outcome + (s.good ? '（解开了）' : '（没解开）')) || '（无）',
            '【TA 发的朋友圈】', lines(rec.posts, (x) => '第' + x.day + '天 ' + x.text + (x.likes ? '（' + x.likes + ' 个赞）' : '')) || '（无）',
            '【记着谁的好】', lines(rec.thanks, (x) => '对' + x.to + '：' + x.about) || '（无）',
            '【最亲近的人（候选，按亲近程度排）】', lines(rec.friends, (c) => c.id + ' ' + c.name + (c.family ? '（家人）' : '') + (c.bond ? ' 关系最深的一面：' + c.bond : '')) || '（无）',
            '【成就】', lines(rec.achievements, (a) => '第' + a.day + '天 ' + a.text) || '（无）',
            rec.skills.length ? '【这段时间长进的本事】' + rec.skills.map((s) => s.skill + ' ' + s.from + '→' + s.to + ' 级').join('、') : '',
            '【性格】现在：' + (rec.traits.now.join('、') || '（不详）') + (rec.traits.before.length ? '；这段开始时：' + rec.traits.before.join('、') : ''),
            rec.school ? '【上学】' + [rec.school.school, rec.school.className, rec.school.grade ? '成绩 ' + rec.school.grade : '', rec.school.club ? '社团 ' + rec.school.club : ''].filter(Boolean).join(' · ') : '',
            rec.job ? '【工作】' + rec.job : '',
            '',
            item.kind === 'draft' ? '这一段还没过完，这是到今天为止的样子。' : (item.kind === 'final' ? '这是' + name + '人生的最后一段，写完这本，TA 的一生就合上了。' : '这一段刚刚过完，' + name + '长成了' + stageZh(item.next) + '。'),
            '输出：{"title":"这一段的名字，8 个字以内，用记录里的一个具体东西或一件事起名","opening":"开头两三句",',
            '"worries":[{"title":"心事的名字","text":"两三句：那时在想什么，后来怎样了"}],',
            '"friends":[{"id":"候选里的 id","text":"一两句：为什么是 TA，最好用一件真事"}],',
            '"moments":["日常的一个小片段，一句话"],',
            '"achievements":["一项成就，一句话"],',
            '"character":"两三句：这段时间长成了什么样的性格，从哪些事看得出来",',
            '"letter":"给' + name + '的几句话，三到五句，像家里的大人写在本子最后一页的"}',
            '心事最多 3 条，最亲近的人最多 3 个，日常片段 4 到 8 条，成就最多 6 条。'
        ].filter((x) => x !== '').join('\n');
        const r = await this.d.llm.json(system, ask, { purpose: 'booklet', max_tokens: 2200, thinking: 'disabled' });
        if (!r || !r.title) throw new Error('the model wrote no booklet');
        const friendIds = new Map(rec.friends.map((c) => [c.id, c]));
        const list = (v, n, f) => (Array.isArray(v) ? v : []).map(f).filter(Boolean).slice(0, n);
        return {
            id: item.id + ':' + stage + (item.kind === 'draft' ? ':draft' : ''),
            stage, stageZh: stageZh(stage), name: STAGE_BOOK[stage] || stageZh(stage), next: item.next || '',
            draft: item.kind === 'draft', final: item.kind === 'final',
            from: item.from, to: item.to, days: Math.max(1, item.to - item.from),
            song: { title: song.title, file: song.file },
            title: clip(r.title, 16),
            opening: clip(r.opening, 240),
            worries: list(r.worries, 3, (w) => (w && w.text ? { title: clip(w.title, 20), text: clip(w.text, 200) } : null)),
            friends: list(r.friends, 3, (f) => {
                const c = f && friendIds.get(String(f.id));
                return c && f.text ? { id: c.id, name: c.name, family: c.family, text: clip(f.text, 160) } : null;
            }),
            moments: list(r.moments, 8, (m) => clip(m, 100) || null),
            achievements: list(r.achievements, 6, (a) => clip(a, 80) || null),
            character: clip(r.character, 240),
            traits: rec.traits.now.slice(0, 6),
            // For the adult notebook's business card.
            job: clip(rec.job, 40),
            letter: clip(r.letter, 360),
            writtenAt: Date.now()
        };
    }

    // ------------------------------------------------------------ booklets written in advance
    // data/booklet-presets.json: { v, people: { <id>: { <stage> | final: preset } } }, written by
    // hand for a household set up to show the booklets. A preset has the booklet's own fields
    // (title, opening, worries, friends [{id, name, family, text}], moments, achievements,
    // character, traits, letter, job); the rest comes from the stage that ended.
    preset(item) {
        const r = fsx.readJson(path.join(this.dataDir, 'booklet-presets.json'));
        const people = r.ok && isObject(r.value) && isObject(r.value.people) ? r.value.people : {};
        const mine = people[String(item.id)];
        if (!isObject(mine)) return null;
        const pr = mine[item.kind === 'final' ? 'final' : item.stage];
        return isObject(pr) && pr.title ? pr : null;
    }

    fromPreset(item, pr) {
        const stage = item.stage;
        const song = SONGS[STAGE_SONG[stage]] || SONGS.grow;
        const list = (v, n) => (Array.isArray(v) ? v : []).slice(0, n);
        return {
            id: item.id + ':' + stage, stage, stageZh: stageZh(stage), name: STAGE_BOOK[stage] || stageZh(stage), next: item.next || '',
            draft: false, final: item.kind === 'final', preset: true,
            from: item.from, to: item.to, days: Math.max(1, (item.to || 0) - (item.from || 0)),
            song: { title: song.title, file: song.file },
            title: clip(pr.title, 16), opening: clip(pr.opening, 240),
            worries: list(pr.worries, 3).map((w) => ({ title: clip(w.title, 20), text: clip(w.text, 200) })),
            friends: list(pr.friends, 3).map((f) => ({ id: String(f.id || ''), name: clip(f.name, 12), family: !!f.family, text: clip(f.text, 160) })),
            moments: list(pr.moments, 8).map((m) => clip(m, 100)),
            achievements: list(pr.achievements, 6).map((a) => clip(a, 80)),
            character: clip(pr.character, 240), traits: list(pr.traits, 6).map((t) => clip(t, 8)),
            job: clip(pr.job, 40), letter: clip(pr.letter, 360),
            writtenAt: Date.now()
        };
    }

    // ------------------------------------------------------------ for the phone
    publish() {
        if (!this.boardFile) return;
        const people = {};
        for (const id of Object.keys(this.data.people)) {
            const p = this.data.people[id];
            people[id] = {
                name: p.name || '', stage: p.stage || '', stageZh: stageZh(p.stage), book: STAGE_BOOK[p.stage] || '',
                since: p.start ? p.start.day : null, draftDay: p.draftDay,
                writing: this.data.queue.filter((q) => q.id === id).map((q) => ({ kind: q.kind, stage: q.stage })),
                books: p.books.slice().reverse()
            };
        }
        try {
            fsx.ensureDir(this.dir);
            fsx.writeJson(this.boardFile, { v: V, at: Date.now(), people });
        } catch (e) {
            this.log.warn('booklet: board not written: ' + e.message);
        }
    }

    // ------------------------------------------------------------ helpers
    listDir(dir) {
        if (!dir) return [];
        try { return require('fs').readdirSync(dir); } catch (e) { return []; }
    }

    chronicleBooks() {
        const c = this.d.chronicle;
        if (!c || !c.dir) return [];
        return this.listDir(c.dir).filter((f) => /\.json$/.test(f)).map((f) => {
            try { return c.book(f.replace(/\.json$/, '')); } catch (e) { return null; }
        }).filter((b) => b && Array.isArray(b.events));
    }

    profile(id) {
        for (const b of this.chronicleBooks()) if (b.profiles && b.profiles[String(id)]) return b.profiles[String(id)];
        return null;
    }

    skillsOf(id) {
        const p = this.profile(id);
        return p && isObject(p.skills) ? Object.assign({}, p.skills) : {};
    }

    names() {
        const out = {};
        for (const id of Object.keys(this.data.people)) if (this.data.people[id].name) out[id] = this.data.people[id].name;
        for (const b of this.chronicleBooks()) for (const id of Object.keys(b.profiles || {})) if (b.profiles[id].name) out[id] = out[id] || b.profiles[id].name;
        return out;
    }

    async traitsOf(id) {
        if (!this.d.world || !this.d.world.traits) return [];
        try {
            const t = await this.d.world.traits(String(id));
            const persona = require('./persona');
            return (t && Array.isArray(t.traits) ? t.traits : []).map((x) => persona.trait(x)).filter(Boolean).slice(0, 8);
        } catch (e) {
            return [];
        }
    }
}

// Facts that say the same thing twice (a chat remembered from both sides) are kept once.
function dedupe(list) {
    const seen = new Set();
    return list.sort((a, b) => a.day - b.day).filter((x) => {
        const k = x.text.replace(/[\s，。！？、,.!?]/g, '');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

module.exports = { Booklet, SONGS, STAGE_SONG, STAGE_BOOK, stageKey };
