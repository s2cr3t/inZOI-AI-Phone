'use strict';
// A high-school suitor. When the played character is in high school (the game's HighTeen), a
// schoolmate of the same stage who likes them sends a friend request to the phone. Accepted, they
// court the player by text, more eagerly than anyone else texts, and in time say how they feel;
// the player's yes makes it a first love, a no ends it, and the suitor takes the no with grace.
//
// Who: someone in the played character's game phone contacts (contacts_get_all), HighTeen like
// the player, not family, not blocked, of the other sex unless suitor.gender is "any"; at the
// player's school first, then the warmest bond. Never anyone older or younger: the courting only
// runs while both are HighTeen, or once both are grown up (active()).
//
// Files:
//   data/suitors.json                  { v, byPlayer: { <player id>: record } }
//   <phone>/suitor/board.cfg           what the phone shows (the request card), written here:
//                                      { v, byPlayer: { <player id>: { id, state, note, contact, at } } }
//   <phone>/saved/suitor-answers.cfg   the player's answers, written by the phone:
//                                      { v, byId: { <request id>: { answer: accept | decline, at } } }
//
// record: { id, suitorId, name, contact, state, note, at, day, acceptedDay, lastTextAt, texts,
//           replies, confessed, endedDay, past: [suitor ids] }
//   state  request   the card waits on the phone
//          pursuing  accepted; the suitor courts the player
//          dating    the player said yes
//          declined  the player turned the request or the suitor down (or broke up); over
//          ignored   the card was left alone for days; over
const path = require('path');
const fsx = require('./fsx');

const V = 1;
// The game's stage for high school; LowTeen is middle school and gets no suitor.
const HIGH_SCHOOL = 'HighTeen';
const MINOR = { Child: true, Teen: true, LowTeen: true, HighTeen: true };

const DEFAULTS = {
    enabled: true,
    // Who may court the player: "opposite" or "any".
    gender: 'opposite',
    // Real minutes the player must have been in high school, as seen here, before a request comes.
    first_delay_minutes: 8,
    // Game days a request card waits before it counts as ignored.
    request_days: 2,
    // Game days after one suitor is over before another may come.
    again_days: 3,
    // Real minutes of quiet in the chat before the suitor writes again (each gap is drawn 0.7x to
    // 1.3x of this): eager, so a few minutes, not a quarter of an hour.
    pursue_minutes: 5.5,
    dating_minutes: 7,
    // Real minutes of quiet that are enough for a ritual of the game day (good morning, after
    // school, good night), each sent once a day.
    ritual_minutes: 2,
    // Metres within which the two are together in the game: then nobody texts.
    together_meters: 15,
    // Texts of their own in a row with no answer before they wait for the player.
    pursue_unanswered: 2,
    dating_unanswered: 3,
    // The player's answers it takes, and game days since the request was accepted, before a confession.
    confess_replies: 10,
    confess_days: 1
};

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function isMale(g) { return /^m/i.test(String(g || '')); }
function isMinor(g) { return MINOR[g] === true; }
function stat(rel, k) {
    const s = rel && rel.stats && rel.stats[k];
    return s && typeof s.value === 'number' ? s.value : 0;
}

function fullName(m) {
    if (!m) return '';
    const name = (m.last_name || '') + (m.first_name || '');
    return name || m.name || ('#' + m.entity_id);
}

// The schoolmate most likely to like the player, or null. contacts: the game phone's contacts,
// each with an optional bond { Friendship, Romance } (the suitor's toward the player).
function pickSuitor(player, contacts, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    if (!player || player.age_group !== HIGH_SCHOOL) return null;
    const pid = String(player.entity_id);
    const exclude = new Set((o.exclude || []).map(String));
    const playerSite = String(player.current_site || '');
    const list = (contacts || []).filter((c) => {
        if (!c || !c.entity_id) return false;
        const id = String(c.entity_id);
        if (id === pid || exclude.has(id)) return false;
        if (c.age_group !== HIGH_SCHOOL) return false;
        if (player.household_id !== undefined && String(c.household_id) === String(player.household_id)) return false;
        if (c.blocked || c.is_blocked) return false;
        const label = String(c.relationship_label || '').trim();
        if (label && label !== '…') return false;
        if (o.gender !== 'any' && player.gender && c.gender && isMale(c.gender) === isMale(player.gender)) return false;
        return true;
    });
    if (!list.length) return null;
    const score = (c) => {
        const site = String(c.current_site || '');
        const b = c.bond || {};
        return (playerSite && site === playerSite ? 60 : 0) + (/学校|school/i.test(site) ? 30 : 0) +
            (Number(b.Romance) || 0) * 2 + (Number(b.Friendship) || 0);
    };
    list.sort((a, b) => score(b) - score(a) || String(a.entity_id).localeCompare(String(b.entity_id)));
    return list[0];
}

// Whether a romance between these two stages may go on: both in high school, or both grown up.
function active(playerGroup, suitorGroup) {
    if (playerGroup === HIGH_SCHOOL && suitorGroup === HIGH_SCHOOL) return true;
    return !!playerGroup && !!suitorGroup && !isMinor(playerGroup) && !isMinor(suitorGroup);
}

// Texts the suitor sent on their own since the player last wrote, the bubbles of one text counted
// once (the daemon's unansweredSends). A reply to the player is an answer, not something waiting
// for one.
const SEND_GAP_MS = 60000;
function unanswered(messages) {
    let n = 0;
    let newer = null;
    for (let i = (messages || []).length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.side !== 'partner' || m.kind !== 'proactive') break;
        if (!newer || newer.at - m.at > SEND_GAP_MS) n += 1;
        newer = m;
    }
    return n;
}

// Why the suitor texts this time, in the words of the proactive prompt. call / them: what they
// call the player and the pronoun. ctx (optional): { likes: [words], ritual: morning | afterschool
// | night, unanswered: n }. Returns { key, text }: key is confess, a ritual, or the tactic used
// (kept on the record so the next texts try something else).
const CONCRETE = '第一句就要有具体内容：用上你们聊过的事、你答应过的事、你记得的关于对方的事、或者你此刻真在做的事（看【你此刻】）。' +
    '不要发“在干嘛”“吃了吗”“在吗”这种空话，不要客套，不要重复你之前用过的开场白。';

function tacticsFor(state, call, them, likes) {
    const like = likes && likes.length ? likes[Math.floor(Math.random() * likes.length) % likes.length] : '';
    const pursuing = [
        { key: 'callback', text: '翻一下聊天记录和你记得的事，接上一件还没完的：你答应过' + them + '的事（兑现它，或者说你准备好了）、' + them + '提过的事后来怎么样了。' },
        { key: 'share', text: '把你此刻正在做的事发给' + call + '，配一句只会跟' + them + '说的感受或吐槽，让' + them + '觉得你做什么都想到' + them + '。' },
        { key: 'like', text: like
            ? '你知道' + call + '喜欢' + like + '：说你刚看到、想到或者准备了跟它有关的东西，想发给' + them + '或者想跟' + them + '一起去。'
            : '你注意到' + call + '喜欢的一样东西（从聊天里找），说你刚看到跟它有关的东西，第一个想到' + them + '。' },
        { key: 'invite', text: '约' + call + '一个具体的小约会：说清时间和地方（放学后奶茶店、周末图书馆、去公园看夜景、一起练琴、去看比赛），理由要像你会说的，给' + them + '一个好拒绝的台阶。' },
        { key: 'compliment', text: '具体地夸' + call + '一件事（' + them + '说过的、做过的、你看到的），不要空泛的“你真好”；夸完有点不好意思，岔开一句。' },
        { key: 'excuse', text: '找一个有点拙的借口找' + call + '：借笔记、问作业、问' + them + '某首歌或某首曲子叫什么。借口要拙到' + them + '看得出来你就是想找' + them + '。' },
        { key: 'game', text: '给' + call + '出一个好玩的小题目：二选一、心理测试、“如果……你会……”，答案能让你多了解' + them + '一点。' },
        { key: 'surprise', text: '预告一个小惊喜：说你明天或者下次见面要给' + call + '带一样东西，让' + them + '猜是什么，先不说破。' },
        { key: 'open', text: '跟' + call + '说一点关于你自己的、平时不跟别人说的事（一个小烦恼、小梦想、小时候的糗事），让' + them + '更了解你。' },
        { key: 'tease', text: '轻轻逗' + call + '一下：拿你们聊过的事开个只有你们懂的玩笑，或者半开玩笑地试探' + them + '对你的态度。不油腻，不越界。' }
    ];
    const dating = [
        { key: 'miss', text: '你想' + call + '了：用你的方式说出来（直接的就直说，嘴硬的就拐个弯），加一件让你想起' + them + '的具体小事。' },
        { key: 'share', text: '把你此刻正在做的事发给' + call + '，像只有' + them + '会听你讲这些一样。' },
        { key: 'date', text: '安排一次约会：说清时间、地方和要做什么（一起上下学、图书馆、看电影、逛街、公园散步），听' + them + '的意见。' },
        { key: 'callback', text: '接上你们之前聊过、还没完的一件事，或者兑现你答应过' + call + '的事。' },
        { key: 'like', text: like ? '你记得' + call + '喜欢' + like + '：给' + them + '一个跟它有关的小心意或者提议。' : '给' + call + '一个跟' + them + '喜欢的东西有关的小心意或者提议。' },
        { key: 'jealous', text: '有一点点吃醋或者撒娇（比如' + them + '刚才回得慢、提到了别人），说出来但不阴阳怪气，最后自己先软下来。' },
        { key: 'future', text: '跟' + call + '聊一件你们以后想一起做的事（寒假、考完试、一起去的地方），说得具体又有点害羞。' }
    ];
    return state === 'dating' ? dating : pursuing;
}

function reasonFor(rec, call, them, options, hour, rand, ctx) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const r = typeof rand === 'function' ? rand : Math.random;
    const c = ctx || {};
    if (rec.state === 'pursuing' && !rec.confessed && (rec.replies || 0) >= o.confess_replies &&
        typeof rec.acceptedDay === 'number' && typeof rec.day === 'number' && rec.day - rec.acceptedDay >= o.confess_days) {
        return { key: 'confess', text: '你喜欢' + call + '很久了，聊了这么多，你终于鼓起勇气想跟' + them + '表白。按你的性格来：直接的就直说，害羞的就绕一下再说出口；说得真心、具体（喜欢' + them + '什么，从你们聊过的事里挑），会紧张，不油腻。说完等' + them + '回答，不要逼' + them + '马上答应。' };
    }
    const tail = (c.atSchool ? '你们此刻都在学校里（可能正在上课），你是偷偷用手机发的：像传纸条，短一点，可以提眼前的事（老师、同学、这节课）。' : '') +
        (c.unanswered ? call + '还没回你上一条。你忍不住又发一条：换个轻松的话题或者补一句俏皮话，不追问' + them + '为什么不回。' : '') + CONCRETE;
    if (c.ritual === 'morning') return { key: 'morning', text: '早上了，你想第一个跟' + call + '说早安：带一句今天的具体安排或者昨天聊过的事，可以约' + them + '一起去学校。' + tail };
    if (c.ritual === 'afterschool') return { key: 'afterschool', text: '放学了，你想找' + call + '：约' + them + '一起走、去吃点东西，或者聊今天学校里的一件事。' + tail };
    if (c.ritual === 'night') return { key: 'night', text: '快睡觉了，你想跟' + call + '说晚安：先聊两句今天（具体的事），最后说晚安，' + (rec.state === 'dating' ? '甜一点。' : '有点舍不得结束。') + tail };
    const recent = Array.isArray(rec.tactics) ? rec.tactics : [];
    let pool = tacticsFor(rec.state, call, them, c.likes);
    const late = typeof hour === 'number' && (hour >= 21 || hour < 1);
    if (late) pool.push({ key: 'night', text: '快睡觉了，你想跟' + call + '说晚安，顺便聊两句今天。' });
    const fresh = pool.filter((p) => recent.indexOf(p.key) < 0);
    if (fresh.length) pool = fresh;
    const pick = pool[Math.floor(r() * pool.length) % pool.length];
    return { key: pick.key, text: (rec.state === 'dating' ? '你们在谈恋爱，你想主动找' + call + '。' : '你喜欢' + call + '，想主动找' + them + '。') + pick.text + tail };
}

// The prompt parts for the suitor's own chats: the block that says who they are to the player,
// and the rule for the crush field. rec: the record; t: persona terms (call, them).
function promptParts(rec, t, minor) {
    const call = t.call;
    const them = t.them;
    const guard = minor
        ? '你们都是高中生：只有纯纯的校园恋爱。可以害羞、心动、吃醋、约在学校、图书馆、奶茶店、公园；身体上最多牵手、拥抱。不谈性，不过夜，不喝酒，不去危险或很远的地方，不撺掇' + them + '瞒着家里做危险的事。'
        : '';
    let block;
    let rule;
    if (rec.state === 'dating') {
        block = '【你们在谈恋爱】你和' + call + '在一起了，刚开始不久。会想' + them + '、会分享日常、早安晚安、约会，按你的性格来：会撒娇的撒娇，嘴硬的嘴硬，会吃醋也会哄人。' + guard;
        rule = '12. crush：' + call + '这次明确说要分手、不想在一起了，写 {"step":"turned_down"}，你会难过，但这次的话体面地接受，不纠缠、不威胁；其他时候写 {"step":"stay"}。';
    } else {
        block = '【你在追' + call + '】你们同校，你喜欢' + them + '，是你先加的' + them + '。你比' + them + '主动：常找话题、记得' + them + '说过的事、找理由约' + them + '，会紧张、会在意' + them + '回得快不快。' +
            (rec.confessed ? '你已经跟' + them + '表白过了，在等' + them + '的回答，不要一直追问。' : '还没表白：先慢慢熟起来，别一上来就表白。') +
            '不油腻、不纠缠：' + them + '冷淡就收一收，换个轻松的话题。' + guard;
        rule = '12. crush：' + call + '这次答应了你的表白、或者明确说愿意和你在一起，写 {"step":"together"}；' + call + '明确拒绝你、说只想做朋友、或者让你别再找' + them + '，写 {"step":"turned_down"}，你会失落，但这次的话体面地接受，以后不再追；其他时候写 {"step":"stay"}。';
    }
    return { block, rule };
}

class Suitor {
    // d: the daemon (game, world, mailbox, llm, log, cfg, proactive helpers).
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.file = '';
        this.boardFile = '';
        this.answersFile = '';
        this.data = { v: V, byPlayer: {} };
        // Player id -> when this run first saw them in high school with no suitor due.
        this.seen = new Map();
        // Gap drawn for the next text, per player.
        this.nextGap = new Map();
        this.busy = false;
    }

    get opts() {
        return Object.assign({}, DEFAULTS, isObject(this.d.cfg && this.d.cfg.suitor) ? this.d.cfg.suitor : {});
    }

    configure(dataDir, phoneDir) {
        this.file = path.join(dataDir, 'suitors.json');
        this.boardFile = path.join(phoneDir, 'suitor', 'board.cfg');
        this.answersFile = path.join(phoneDir, 'saved', 'suitor-answers.cfg');
        this.forceFile = path.join(dataDir, 'suitor-now.request');
        const r = fsx.readJson(this.file);
        const v = r.ok && isObject(r.value) && r.value.v === V ? r.value : {};
        this.data = { v: V, byPlayer: isObject(v.byPlayer) ? v.byPlayer : {} };
        this.publish();
    }

    save() {
        try {
            fsx.writeJson(this.file, this.data, true);
        } catch (e) {
            this.log.warn('suitor: not saved: ' + e.message);
        }
        this.publish();
    }

    publish() {
        if (!this.boardFile) return;
        const byPlayer = {};
        for (const pid of Object.keys(this.data.byPlayer)) {
            const rec = this.data.byPlayer[pid];
            if (!isObject(rec)) continue;
            byPlayer[pid] = { id: rec.id, state: rec.state, note: rec.note || '', contact: rec.contact || null, at: rec.at || 0 };
        }
        try {
            fsx.ensureDir(path.dirname(this.boardFile));
            fsx.writeJson(this.boardFile, { v: V, byPlayer });
        } catch (e) {
            this.log.warn('suitor: board not written: ' + e.message);
        }
    }

    record(playerId) {
        const rec = this.data.byPlayer[String(playerId)];
        return isObject(rec) ? rec : null;
    }

    // The courting between this pair, while it goes on: { state, confessed } or null.
    view(pair) {
        if (!pair || !pair.outsider) return null;
        const rec = this.record(pair.playerId);
        if (!rec || String(rec.suitorId) !== String(pair.partnerId)) return null;
        if (rec.state !== 'pursuing' && rec.state !== 'dating') return null;
        if (!active(pair.player && pair.player.age_group, pair.partner && pair.partner.age_group)) return null;
        return rec;
    }

    // Gives an outsider pair its suitor role before the snapshot is made from it.
    dress(pair) {
        const rec = this.view(pair);
        if (!rec) return null;
        pair.role = rec.state === 'dating' ? 'sweetheart' : 'suitor';
        pair.suitor = { state: rec.state, confessed: !!rec.confessed };
        return rec;
    }

    // The prompt parts for this pair, or null.
    prompt(pair, t) {
        const rec = this.view(pair);
        if (!rec) return null;
        const minor = isMinor(pair.player && pair.player.age_group) || isMinor(pair.partner && pair.partner.age_group);
        return promptParts(rec, t, minor);
    }

    // After a reply or a text of the suitor's own. crush: the reply's { step }; count: how many of
    // the player's texts a reply answered, or how many texts of their own were sent.
    fromReply(pair, snap, crush, isReply, count, reason) {
        const rec = this.view(pair);
        if (!rec) return;
        const day = snap && snap.env && typeof snap.env.day === 'number' ? snap.env.day : rec.day;
        if (typeof day === 'number') rec.day = day;
        if (isReply) rec.replies = (rec.replies || 0) + Math.max(1, count || 0);
        else {
            rec.lastTextAt = Date.now();
            if (count > 0) rec.texts = (rec.texts || 0) + 1;
            if (reason === 'confess' && count > 0) rec.confessed = true;
        }
        const step = crush && typeof crush.step === 'string' ? crush.step : 'stay';
        if (step === 'together' && rec.state === 'pursuing' && isReply) {
            rec.state = 'dating';
            rec.confessed = true;
            rec.datingDay = day;
            this.log.info('suitor [' + pair.key + '] ' + rec.name + ' and the player are together now');
            this.toast('你和' + rec.name + '在一起了');
            // A first love: the game's bond moves by more than any one reply could.
            if (this.d.relSync) this.d.relSync.bump(pair, snap, { Romance: 15, Friendship: 5 }, '在一起了').catch(() => {});
        } else if (step === 'turned_down' && isReply) {
            this.end(rec, 'declined', day);
            this.log.info('suitor [' + pair.key + '] ' + rec.name + ' was turned down');
        }
        this.save();
    }

    end(rec, state, day) {
        rec.state = state;
        rec.endedDay = typeof day === 'number' ? day : rec.day;
        rec.past = Array.from(new Set((rec.past || []).concat([String(rec.suitorId)])));
    }

    toast(text) {
        this.d.game.soft('toast_show', { Message: text, Lifetime: 6 }).catch(() => {});
    }

    answers() {
        const r = fsx.readJson(this.answersFile);
        return r.ok && isObject(r.value) && isObject(r.value.byId) ? r.value.byId : {};
    }

    // Called every few seconds by the daemon.
    async tick() {
        const o = this.opts;
        if (!o.enabled || this.busy || !this.file) return;
        this.busy = true;
        try {
            await this.step(o);
        } catch (e) {
            this.log.warn('suitor: ' + (e && e.stack || e));
        } finally {
            this.busy = false;
        }
    }

    async step(o) {
        const world = this.d.world;
        if (await world.phase() !== 'in_game') return;
        const playerId = String(await world.possessed() || '');
        if (!playerId) return;
        const hh = await world.household();
        const player = (hh.members || []).find((m) => String(m.entity_id) === playerId);
        if (!player) return;
        const env = await this.d.game.soft('environment_get_state', {});
        const day = env && typeof env.day === 'number' ? env.day : null;
        let rec = this.record(playerId);

        // The phone's answer to a waiting request.
        if (rec && rec.state === 'request') {
            const a = this.answers()[rec.id];
            if (a && (a.answer === 'accept' || a.answer === 'decline')) {
                if (a.answer === 'accept') {
                    rec.state = 'pursuing';
                    rec.acceptedDay = day;
                    rec.day = day;
                    rec.replies = 0;
                    rec.lastTextAt = 0;
                    this.log.info('suitor [' + playerId + '] request from ' + rec.name + ' accepted');
                    this.save();
                    await this.firstText(player, rec);
                } else {
                    this.end(rec, 'declined', day);
                    this.log.info('suitor [' + playerId + '] request from ' + rec.name + ' declined');
                    this.save();
                }
                return;
            }
            if (day !== null && typeof rec.day === 'number' && day - rec.day >= o.request_days) {
                this.end(rec, 'ignored', day);
                this.log.info('suitor [' + playerId + '] request from ' + rec.name + ' left unanswered, dropped');
                this.save();
            }
            return;
        }

        if (rec && (rec.state === 'pursuing' || rec.state === 'dating')) {
            if (day !== null) rec.day = day;
            await this.court(player, rec, env, o);
            return;
        }

        // Nobody courting: maybe someone starts. `node bridge.js suitor-now` skips the waiting.
        const force = this.takeForce();
        if (force && player.age_group === HIGH_SCHOOL) {
            this.log.info('suitor [' + playerId + '] request forced (test)');
            await this.request(player, rec, day, o, force.suitor);
            return;
        }
        if (player.age_group !== HIGH_SCHOOL) {
            this.seen.delete(playerId);
            return;
        }
        if (rec && day !== null && typeof rec.endedDay === 'number' && day - rec.endedDay < o.again_days) return;
        const now = Date.now();
        if (!this.seen.has(playerId)) {
            this.seen.set(playerId, now);
            return;
        }
        if (now - this.seen.get(playerId) < o.first_delay_minutes * 60000) return;
        if (this.quiet(env)) return;
        await this.request(player, rec, day, o);
    }

    // A test request from `node bridge.js suitor-now`: { suitor } (an id or ''), or null. Read once.
    takeForce() {
        if (!this.forceFile) return null;
        const r = fsx.readJson(this.forceFile);
        if (!r.ok) return null;
        try { require('fs').unlinkSync(this.forceFile); } catch (e) { /* already gone */ }
        return { suitor: r.value && r.value.suitor ? String(r.value.suitor) : '' };
    }

    quiet(env) {
        const q = this.d.cfg && this.d.cfg.proactive && this.d.cfg.proactive.quiet_game_hours;
        if (!Array.isArray(q) || !env || typeof env.hour !== 'number') return false;
        return q[0] <= q[1] ? env.hour >= q[0] && env.hour < q[1] : env.hour >= q[0] || env.hour < q[1];
    }

    async request(player, prev, day, o, only) {
        const contacts = await this.d.world.phoneContacts();
        const past = prev ? (prev.past || []) : [];
        const pool = contacts.filter((c) => c && c.age_group === HIGH_SCHOOL && (!only || String(c.entity_id) === String(only)));
        for (const c of pool) {
            const rel = await this.d.game.soft('relationships_get_value_between', { owner_id: String(c.entity_id), target_id: String(player.entity_id) });
            c.bond = { Friendship: stat(rel, 'Friendship'), Romance: stat(rel, 'Romance') };
        }
        const pick = pickSuitor(player, pool, Object.assign({}, o, { exclude: past }));
        // Nobody fits now: look again in a while.
        if (!pick) {
            this.seen.set(String(player.entity_id), Date.now());
            return;
        }
        const name = fullName(pick);
        const note = await this.requestNote(pick, player).catch(() => '');
        const at = Date.now();
        const rec = {
            id: String(player.entity_id) + '-' + String(pick.entity_id) + '-' + at,
            suitorId: String(pick.entity_id),
            name,
            contact: {
                entity_id: pick.entity_id, first_name: pick.first_name || '', last_name: pick.last_name || '', gender: pick.gender || '',
                age_group: pick.age_group || '', age_group_text: pick.age_group_text || '', job_name: pick.job_name || ''
            },
            state: 'request',
            note: note || ('我是' + name + '，我们同校的，可以加个好友吗？'),
            at,
            day,
            past
        };
        this.data.byPlayer[String(player.entity_id)] = rec;
        this.save();
        this.log.info('suitor [' + player.entity_id + '] ' + name + ' sent a friend request: ' + rec.note);
        this.toast(name + ' 想加你为好友：' + rec.note);
    }

    // The line on the request card, in the suitor's own voice.
    async requestNote(pick, player) {
        if (!this.d.llm || !this.d.llm.configured) return '';
        const profile = await this.d.world.profile(String(pick.entity_id)).catch(() => null);
        const persona = require('./persona');
        const voice = profile ? persona.voiceBrief(profile) : '';
        const system = [
            '你是「' + fullName(pick) + '」，一个高中生。你喜欢同校的「' + fullName(player) + '」，现在要在手机上加' + (isMale(player.gender) ? '他' : '她') + '好友。',
            voice,
            '写好友申请里附的一句话：自我介绍或者找个理由（同校、同一个社团、借过笔记、在哪见过），15 个字左右，像高中生，按你的性格。不要表白，不要提 AI 或游戏。',
            require('./aitone').RULE_TEXT,
            '只输出 JSON：{"note":"一句话"}'
        ].filter(Boolean).join('\n');
        const r = await this.d.llm.json(system, '写这句话。', { purpose: 'suitor', voice: ['note'], max_tokens: 200, thinking: 'disabled' });
        const note = r && typeof r.note === 'string' ? r.note.trim().replace(/\s+/g, ' ') : '';
        return note.slice(0, 40);
    }

    async firstText(player, rec) {
        const persona = require('./persona');
        const t = persona.termsFor('suitor', player.gender, rec.contact && rec.contact.gender, player.first_name);
        const reason = t.call + '刚通过了你的好友申请。你发第一句：打个招呼、说说你们在哪见过、你怎么注意到' + t.them + '的，自然一点，有点紧张；不要表白。';
        const sent = await this.d.suitorText(String(player.entity_id), rec.suitorId, reason, 'first').catch((e) => {
            this.log.warn('suitor: first text failed: ' + (e && e.message || e));
            return false;
        });
        if (!sent) rec.lastTextAt = 0;
    }

    async court(player, rec, env, o) {
        const contacts = await this.d.world.phoneContacts();
        const them = contacts.find((c) => String(c.entity_id) === String(rec.suitorId));
        // Moved away, blocked, or one of them grew past the other: no more courting texts.
        if (!them || them.blocked || them.is_blocked || !active(player.age_group, them.age_group)) return;
        const now = Date.now();
        const pid = String(player.entity_id);
        const thread = this.d.mailbox.thread(pid + '-' + rec.suitorId);
        if (!thread || thread.pending.length) return;
        const waiting = unanswered(thread.messages);
        if (waiting >= (rec.state === 'dating' ? o.dating_unanswered : o.pursue_unanswered)) return;
        if (this.quiet(env)) return;
        const last = thread.messages[thread.messages.length - 1];
        // Quiet measured on the chat itself: only what was really said counts.
        const since = last ? last.at : 0;
        const day = env && typeof env.day === 'number' ? env.day : null;
        const hour = env && typeof env.hour === 'number' ? env.hour : null;
        if (!isObject(rec.rituals)) rec.rituals = {};
        let ritual = '';
        if (day !== null && hour !== null) {
            if (hour >= 6 && hour < 9 && rec.rituals.morning !== day) ritual = 'morning';
            else if (hour >= 16 && hour < 19 && rec.rituals.afterschool !== day) ritual = 'afterschool';
            else if (hour >= 21 && rec.rituals.night !== day) ritual = 'night';
        }
        const base = (rec.state === 'dating' ? o.dating_minutes : o.pursue_minutes) * 60000;
        if (!this.nextGap.has(pid)) this.nextGap.set(pid, base * (0.7 + Math.random() * 0.6));
        const need = ritual ? Math.min(o.ritual_minutes * 60000, this.nextGap.get(pid)) : this.nextGap.get(pid);
        if (now - since < need) return;
        // Side by side in the game they talk there, not by text; but at school, sitting in the same
        // building (the game keeps everyone in class at one spot), a high-schooler passes notes.
        const prox = await this.d.world.proximity({ playerId: pid, partnerId: String(rec.suitorId), player, partner: them }, o.together_meters).catch(() => null);
        const atSchool = /学校|school/i.test(String(player.current_site || '')) && String(player.current_site || '') === String(them.current_site || '');
        if (prox && prox.near && !atSchool) return;
        const persona = require('./persona');
        const t = persona.termsFor(rec.state === 'dating' ? 'sweetheart' : 'suitor', player.gender, them.gender, player.first_name);
        const prefs = await this.d.world.preferences(pid).catch(() => null);
        const likes = prefs && Array.isArray(prefs.likes) ? prefs.likes.map((id) => persona.pref(id)).filter(Boolean).slice(0, 8) : [];
        const reason = reasonFor(rec, t.call, t.them, o, hour, undefined, { likes, ritual, unanswered: waiting, atSchool });
        this.log.info('suitor [' + pid + '] ' + rec.name + ' writes first (' + reason.key + (waiting ? ', ' + waiting + ' unanswered' : '') + ')');
        const sent = await this.d.suitorText(pid, rec.suitorId, reason.text, reason.key).catch((e) => {
            this.log.warn('suitor: text failed: ' + (e && e.message || e));
            return false;
        });
        // Nothing went out (another character was texting the player that moment, the model kept
        // quiet): it does not count, and the next check, a few seconds on, tries again.
        if (!sent) {
            this.log.info('suitor [' + pid + '] nothing sent this time, trying again shortly');
            return;
        }
        if (ritual) rec.rituals[ritual] = day;
        rec.tactics = (Array.isArray(rec.tactics) ? rec.tactics : []).concat([reason.key]).slice(-4);
        this.nextGap.delete(pid);
        rec.lastTextAt = Date.now();
        this.save();
    }
}

module.exports = { Suitor, pickSuitor, active, unanswered, reasonFor, promptParts, DEFAULTS, HIGH_SCHOOL };
