'use strict';
// A story of their own for each family member the played character texts: a goal, a secret, some
// trouble or a surprise of the contact's, that unfolds over a few game days through the chat.
//
// One LLM call makes an arc when there is none: what is really going on (only the contact knows),
// three or four stages, each with what the contact lets show in texts and what moves it on, and a
// good and a bad ending. From then on no extra calls: the reply and proactive prompts carry the
// story (block), and the answer's "story" field says when an exchange moved it on or settled it
// (fromReply). The world does not wait for the player: two game days without a move and the story
// moves on by itself, and past its last day it ends badly (tick). An ending is kept as a memory
// fact; a new story starts a game day later.
//
// data/stories/<playerId>-<partnerId>.json: { v, active, ended: [...], nextFrom }
//
// The phone's Stories page shows them from ui/phone/stories/board.cfg (publish). A story still
// running shows only what the player could have noticed: the clues the contact let slip in the
// chat, how far it has come and the days left; its title once the contact said what it is. The
// premise is written there only after the story ended.
//
// What an ending brings (stories.rewards): a story the player helped through leaves a keepsake,
// warms the contact (ties.thank), sets moodlets on both, and a while later the contact texts a
// thank-you (followUp) and may post about it on Moments; the daemon hands these out
// (storyEnded). A story that went badly can still be made right for mend_days: the contact
// says what they would need, and comforting them in the chat ("mend") eases the grudge.
// Each story the player helped raises the contact's trust; at more trust the next story is
// a deeper, more private one.
const path = require('path');
const fsx = require('./fsx');
const persona = require('./persona');

const V = 1;
const BOARD_V = 1;
const KINDS = ['目标', '秘密', '麻烦', '惊喜'];
const ENDED_KEEP = 12;
const LOG_KEEP = 12;
const CLUES_KEEP = 8;
const CLUE_MAX = 60;
// What the running stage already let show, kept to tell the contact not to say it again.
const STAGE_CLUES_KEEP = 6;
const PUBLISH_DELAY_MS = 400;
// A story moves on at most this often from replies, so one burst of texts does not race through it.
const MOVE_GAP_MS = 2 * 60000;
// Arcs are made one at a time, and not again soon after a failed attempt.
const MAKE_RETRY_MS = 10 * 60000;
// The just-ended story stays in the prompt this many game days, so the contact can bring it up.
const RECENT_DAYS = 2;
// A thank-you not sent within this long after the ending is not sent any more.
const FOLLOW_KEEP_MS = 6 * 3600000;
// Trust from the stories the player helped through: the title shown on the Stories page and
// how deep the contact's next story may go.
const TRUST = [
    { helped: 0, title: '', depth: 0 },
    { helped: 1, title: '开始信任你', depth: 0 },
    { helped: 2, title: '愿意对你说心里话', depth: 1 },
    { helped: 4, title: '把你当最懂自己的人', depth: 2 }
];
// {call}: what the contact calls the player.
const DEPTH_TEXT = [
    '',
    '这个人已经很信任{call}：这次可以写更私密一点的事，比如藏了很久的心愿、一个解不开的心结、和家里某个人之间的别扭、对将来的担心。',
    '这个人把{call}当最懂自己的人：这次可以写一件一直没说出口的大事，比如人生里一个重要的决定、一段放不下的过去、一句一直想对{call}说的真心话。'
];

function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clean(s, max) {
    return String(typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function dayOf(env) {
    return env && typeof env.day === 'number' ? env.day : null;
}

// The arc the model wrote, checked; null when it cannot be used. depth: 0..2 (trust).
function cleanArc(raw, day, depth) {
    if (!isObject(raw)) return null;
    const beats = (Array.isArray(raw.beats) ? raw.beats : [])
        .map((b) => isObject(b) ? { show: clean(b.show, 160), next: clean(b.next, 120) } : null)
        .filter((b) => b && b.show && b.next)
        .slice(0, 4);
    const title = clean(raw.title, 24);
    const premise = clean(raw.premise, 200);
    if (beats.length < 2 || !title || !premise) return null;
    const days = Math.max(2, Math.min(6, Math.round(Number(raw.days) || 4)));
    return {
        id: 's' + Date.now().toString(36),
        title,
        kind: KINDS.indexOf(raw.kind) >= 0 ? raw.kind : '目标',
        premise,
        want: clean(raw.want, 120),
        beats,
        good: clean(raw.good, 120),
        bad: clean(raw.bad, 120),
        keepsake: clean(raw.keepsake, 16),
        depth: Math.max(0, Math.min(2, Math.round(Number(depth) || 0))),
        stage: 0,
        startedDay: day,
        lastMoveDay: day,
        endsBy: day === null ? null : day + days,
        movedAt: 0,
        log: [],
        clues: [],
        revealed: false
    };
}

// Whether the answer's "story" field says this message let the story show.
function hinted(raw) {
    return isObject(raw) && (raw.hint === true || raw.step === 'next' || raw.step === 'end');
}

function cleanList(list) {
    return (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x).map((x) => clean(x, CLUE_MAX));
}

function cleanClues(list) {
    return (Array.isArray(list) ? list : []).filter((c) => isObject(c) && typeof c.text === 'string' && c.text)
        .map((c) => ({ text: clean(c.text, CLUE_MAX), day: typeof c.day === 'number' ? c.day : null }));
}

function cleanSteps(list) {
    return (Array.isArray(list) ? list : []).filter((x) => isObject(x) && typeof x.text === 'string' && x.text)
        .map((x) => ({ text: clean(x.text, 120), day: typeof x.day === 'number' ? x.day : null, how: typeof x.how === 'string' ? x.how : '' }));
}

// Stages the player moved on in the chat (the others moved by themselves).
function chatMovesOf(a) {
    return (Array.isArray(a && a.log) ? a.log : []).filter((x) => isObject(x) && x.how === 'in the chat').length;
}

// The player helped this one through: it ended well, in the chat.
function helpedWith(e) {
    return isObject(e) && e.good === true && e.how === 'in the chat';
}

// Stories helped through and made right afterwards, all time. Only the last ENDED_KEEP endings
// are kept, so the counts are kept apart; files from before have them worked out once.
function countsOf(s) {
    if (isObject(s.trust)) {
        return { helped: Math.max(0, Math.round(Number(s.trust.helped) || 0)), mended: Math.max(0, Math.round(Number(s.trust.mended) || 0)) };
    }
    const list = Array.isArray(s.ended) ? s.ended : [];
    return { helped: list.filter(helpedWith).length, mended: list.filter((e) => isObject(e) && isObject(e.mended)).length };
}

// How much the contact trusts the player: { helped, mended } -> level, title, depth.
function trustOf(counts) {
    const helped = counts.helped;
    const mended = counts.mended;
    let level = 0;
    for (let i = 0; i < TRUST.length; i++) if (helped >= TRUST[i].helped) level = i;
    const next = TRUST[level + 1] || null;
    // The next step that makes the stories deeper, for "再帮上 N 件".
    const deeper = TRUST.find((t) => t.depth > TRUST[level].depth) || null;
    return {
        helped,
        mended,
        level,
        title: TRUST[level].title,
        depth: TRUST[level].depth,
        next: next ? next.helped - helped : 0,
        deeper: deeper ? deeper.helped - helped : 0
    };
}

class Stories {
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.dir = '';
        this.making = null;
        this.madeFailAt = 0;
        // The game day the tracker saw last, for the days left on the board.
        this.day = null;
        this.publishTimer = null;
        this.boardText = '';
        // key -> { clues, soon } of the running stories, as last published (status.cfg reads it).
        this.hearts = new Map();
    }

    get cfg() {
        return this.d.cfg.stories;
    }

    configure(dataDir) {
        this.dir = path.join(dataDir, 'stories');
        fsx.ensureDir(this.dir);
        this.publishSoon();
    }

    file(key) {
        return path.join(this.dir, key + '.json');
    }

    load(key) {
        const r = fsx.readJson(this.file(key));
        const v = r.ok && isObject(r.value) && r.value.v === V ? r.value : {};
        return {
            v: V,
            active: isObject(v.active) && Array.isArray(v.active.beats) ? v.active : null,
            ended: Array.isArray(v.ended) ? v.ended.filter(isObject).slice(-ENDED_KEEP) : [],
            nextFrom: typeof v.nextFrom === 'number' ? v.nextFrom : null,
            trust: isObject(v.trust) ? v.trust : null
        };
    }

    save(key, s) {
        try {
            fsx.writeJson(this.file(key), s, true);
        } catch (e) {
            this.log.warn('stories [' + key + '] not saved: ' + e.message);
        }
        this.publishSoon();
    }

    // Every pair's file, for bridge.js stories.
    all() {
        let names = [];
        try { names = require('fs').readdirSync(this.dir); } catch (e) { return []; }
        return names.filter((n) => /^\d+-\d+\.json$/.test(n)).map((n) => {
            const key = n.slice(0, -5);
            return Object.assign({ key }, this.load(key));
        });
    }

    clearAll() {
        let names = [];
        try { names = require('fs').readdirSync(this.dir); } catch (e) { return 0; }
        let n = 0;
        for (const name of names) {
            if (!/\.json$/.test(name)) continue;
            try { require('fs').unlinkSync(path.join(this.dir, name)); n += 1; } catch (e) { /* in use */ }
        }
        this.publishSoon();
        return n;
    }

    // ------------------------------------------------------------ the prompt
    // The 【你自己的心事】 block for the reply and proactive prompts, or ''.
    block(pair, snap) {
        if (!this.cfg.enabled) return '';
        const s = this.load(pair.key);
        const t = persona.terms(snap);
        const day = dayOf(snap.env);
        const lines = [];
        const a = s.active;
        if (a) {
            const beat = a.beats[Math.min(a.stage, a.beats.length - 1)];
            lines.push('【你自己的心事】（只有你知道，' + t.call + '不知道。是你自己生活里的事，聊天时按你的性格自然流露）');
            lines.push('这件事：「' + a.title + '」（' + a.kind + '）。真实情况：' + a.premise);
            if (a.want) lines.push('你心里希望：' + a.want);
            lines.push('现在是第 ' + (a.stage + 1) + ' 段，共 ' + a.beats.length + ' 段。这一段要让' + t.call + '慢慢知道的：' + beat.show);
            lines.push('进入下一段的大方向（不用一字不差）：' + beat.next.replace(/[。！？.!?\s]+$/, '') + '。' + t.call + '只要接住了这件事——问起、回答了你的问题、关心、出主意、表示想看——就算到了。');
            if (a.log.length) {
                lines.push('之前' + t.call + '是这样回应的：' + a.log.slice(-4).map((x) => x.text).join('；'));
                lines.push('接下来的事要顺着' + t.call + '的回应走，不要照原来的计划硬搬：' + t.call + '帮了、问了，你就更敞开、多说一点真话；' +
                    t.call + '敷衍、没在意，你就有点失落，或者换个方式求助。');
            }
            const shown = cleanList(a.stageClues);
            if (shown.length) {
                lines.push('这一段你已经流露过（' + t.call + '都看到了）：' + shown.join('；') +
                    '。同样的话、同样的问题不要再说；' + t.call + '已经回答过的问题不要再问。');
            }
            const used = this.hintsToday(a, day);
            const cap = this.hintCap();
            if (used >= cap) {
                lines.push('今天你已经流露过 ' + used + ' 次这件事了：今天别再主动提，也别再暗示；' + t.call + '问起再说。');
            } else {
                lines.push('今天还可以自然地流露 ' + (cap - used) + ' 次。每次都要比上一次多让' + t.call + '知道一点新的东西' +
                    '（新的细节、事情的进展、一个具体的请求，或者干脆说出你在做什么）；说不出新东西就这次不提。');
            }
            if (day !== null && a.endsBy !== null) {
                const left = a.endsBy - day;
                lines.push(left > 0 ? '大约还有 ' + left + ' 天就会有结果。' : '今天就会有结果。');
            }
            const must = snap.storyMust || '';
            if (must === 'advance') {
                const next = a.beats[a.stage + 1];
                lines.push(next
                    ? '这次' + t.call + '在回应你流露的这件心事：这次就进入下一段，直接让' + t.call + '知道：' + next.show
                    : '这次' + t.call + '在回应你流露的这件心事：事情就在这次有个结果。');
            } else if (must === 'surface') {
                lines.push('这次回复要自然地带出这件心事，并且比之前多让' + t.call + '知道一点新的东西。');
            }
            if (a.bad) lines.push('要是一直没人发现、没人帮：' + a.bad);
            lines.push('怎么说：藏着、暗示、憋不住说漏嘴，都按你这个人来。' + t.call + '没问就别一下子全说出来，问到了就真的多说一点，别再绕；' +
                '不要每条消息都提；' + t.call + '在说别的急事时先别提。' +
                '能在游戏里做的（练琴、看书、出门、找人），可以真的写进 actions 去做。');
        }
        const recent = s.ended.slice(-1)[0];
        if (recent && day !== null && typeof recent.endedDay === 'number' && day - recent.endedDay <= RECENT_DAYS) {
            lines.push('最近了结的心事：「' + recent.title + '」，' + (recent.good ? '结果挺好：' : '结果不太好：') + clean(recent.outcome, 120) +
                '。想起来可以提，' + t.call + '帮过你的就记着。');
        }
        const open = this.mendable(s, day);
        if (open) {
            lines.push('「' + open.title + '」这件事' + (open.how === 'in the chat' ? '没能如愿' : t.call + '一直没察觉') + '，你心里还有点在意。' +
                '要是' + t.call + '这次真心问起、安慰你、陪你或者道歉，你会好受很多，愿意多说一点当时的事；随口一提、只说"没事吧"不算。');
        }
        const mended = s.ended.filter((e) => isObject(e.mended) && day !== null && typeof e.mended.day === 'number' && day - e.mended.day <= RECENT_DAYS).slice(-1)[0];
        if (mended) lines.push('「' + mended.title + '」那件事后来' + t.call + '还是来问了，你心里好受多了。');
        return lines.join('\n');
    }

    // The newest bad ending the player can still make right, or null.
    mendable(s, day) {
        if (!this.cfg.rewards || day === null) return null;
        for (let i = s.ended.length - 1; i >= 0; i--) {
            const e = s.ended[i];
            if (!isObject(e) || !isObject(e.mend) || isObject(e.mended)) continue;
            if (typeof e.mend.until === 'number' && day <= e.mend.until) return e;
        }
        return null;
    }

    // Rule for the answer's "story" field, or '' without a story.
    rule(pair, day, must) {
        if (!this.cfg.enabled) return '';
        const s = this.load(pair.key);
        const open = this.mendable(s, typeof day === 'number' ? day : null);
        const mend = open ? '「' + open.title + '」那件事：对方这次真心问起、安慰、陪伴或者道歉，让你好受了，story 里加上 "mend":true；随口一提不算。' : '';
        if (!s.active) return mend ? '10c. story：' + mend + '没有就写 {}。' : '';
        const keep = this.cfg.rewards && !s.active.keepsake ? '好结果时再加 "keepsake"：这件事留下的一个小纪念，一件东西或者一个瞬间，不超过 8 个字，比如「第三名的奖状」；' : '';
        const over = this.hintsToday(s.active, typeof day === 'number' ? day : null) >= this.hintCap();
        const forced = must === 'advance'
            ? '这次对方在回应你流露的心事，必须往前走：story 写 {"step":"next","why":"对方是怎么回应的"}（已经是最后一段就写 end），messages 里要让对方明显感觉到事情有了进展，不能再原地重复。'
            : must === 'surface' ? '这次回复要带出这件心事：hint 写 true。' : '';
        const ending = '结局怎么定：对方一路有回应、关心或者帮忙，结局就是好的（good:true）；只有对方明确拒绝、嘲笑你，或者从头到尾不理，才是坏结局。';
        return '10c. story：' + mend + forced + ending + '对方这次的话接住了【你自己的心事】这一段（问起、回答了你的问题、关心、出主意、表示想看，或者游戏里真的发生了「进入下一段的大方向」那件事），就写 {"step":"next","why":"对方是怎么回应的"}；' +
            '你自己透露了、暗示了这一段的事不算，那只是这一段在进行；对方完全没理这件事也不算。事情这次有了结果，写 {"step":"end","good":true 或 false,"why":"结果是怎样"}；' + keep + '否则 {"step":"stay"}。' +
            (over ? '今天已经流露够了：除非对方问起，"hint" 写 false。'
                : '同时：这次你发的消息里流露了这件心事（暗示、说漏嘴、明说都算），加上 "hint":true、"hint_at"：流露的是 messages 里第几条（从 0 数），和 "clue"：用一句话写对方从这次消息里能看出来的新迹象，' +
                '只写对方看得到的，不写对方不知道的真实情况，不写人名，不超过 25 个字，比如「说最近一下班就往外跑，问去哪也不说」；没流露就写 "hint":false。') +
            '这次你明明白白告诉了对方这是件什么事，再加 "named":true。';
    }

    // ------------------------------------------------------------ moving it on
    hinted(raw) {
        return !!this.cfg.enabled && hinted(raw);
    }

    // Times a day the story may show (cfg.stories.hints_per_day; 2 when not set).
    hintCap() {
        const n = Number(this.cfg.hints_per_day);
        return isFinite(n) && n >= 0 ? n : 2;
    }

    // What the player's reply must do for the running story: 'advance' when this stage has shown
    // (a hint since the last move) and the last move is not too recent, 'surface' when it has not
    // shown yet and today's hints are not used up, else ''.
    mustOf(pair, day) {
        if (!this.cfg.enabled) return '';
        const a = this.load(pair.key).active;
        if (!a) return '';
        const moved = a.movedAt || 0;
        if ((a.hintedAt || 0) > moved) return Date.now() - moved >= MOVE_GAP_MS ? 'advance' : '';
        return this.hintsToday(a, typeof day === 'number' ? day : null) < this.hintCap() ? 'surface' : '';
    }

    // How many times the story showed today (game day).
    hintsToday(a, day) {
        if (!a || day === null || !isObject(a.hintDay) || a.hintDay.day !== day) return 0;
        return Math.max(0, Number(a.hintDay.n) || 0);
    }

    // Which of the reply's n messages carries the story's mark, or -1: the one the answer names
    // (hint_at), else the last; none once the day's hints are used up, unless the story moved.
    hintAt(pair, raw, day, n) {
        if (!this.hinted(raw) || !n) return -1;
        const s = this.load(pair.key);
        const moved = raw.step === 'next' || raw.step === 'end';
        if (!moved && this.hintsToday(s.active, typeof day === 'number' ? day : null) >= this.hintCap()) return -1;
        const at = Math.round(Number(raw.hint_at));
        return at >= 0 && at < n ? at : n - 1;
    }

    // isReply: an answer to what the player wrote; a text the contact sent first cannot be the
    // player coming back to comfort them.
    // opts: { must } what this reply had to do (mustOf), { felt } how the player's words felt.
    fromReply(pair, snap, raw, isReply, opts) {
        const must = opts && isReply !== false ? opts.must || '' : '';
        if (!this.cfg.enabled || (!isObject(raw) && must !== 'advance')) return;
        if (!isObject(raw)) raw = {};
        let step = raw.step === 'next' || raw.step === 'end' ? raw.step : '';
        // The player answered what the story let show: it moves on whatever the model wrote.
        if (must === 'advance' && !step) {
            step = 'next';
            this.log.info('stories [' + pair.key + '] the player answered the story, moved on (the model wrote ' + (raw.step || 'nothing') + ')');
        }
        const s = this.load(pair.key);
        const day = dayOf(snap.env);
        if (raw.mend === true && isReply !== false) this.mend(pair, s, day, raw.why);
        const a = s.active;
        if (!a) return;
        if (snap.partner && snap.partner.name) a.partnerName = clean(snap.partner.name, 40);
        // Past the day's hints a message that still lets it show is no new clue (the prompt asked
        // for none); a reply that moves the story on always counts.
        const over = !step && this.hintsToday(a, day) >= this.hintCap();
        if (hinted(raw) && !over) {
            this.noteClue(pair, a, raw, day);
            a.hintDay = { day, n: this.hintsToday(a, day) + 1 };
            a.hintedAt = Date.now();
        }
        if (!step) {
            if (hinted(raw) && !over) this.save(pair.key, s);
            return;
        }
        const why = clean(raw.why, 120);
        if (step === 'end') {
            let good = raw.good === true;
            // A player who has been taking part gets the good ending, unless these very words hurt.
            const felt = opts && isObject(opts.felt) ? Number(opts.felt.level) : 0;
            if (!good && chatMovesOf(a) >= 1 && !(felt <= -1)) {
                good = true;
                this.log.info('stories [' + pair.key + '] "' + a.title + '": the player took part, the ending is the good one');
            }
            // Stories made before keepsakes existed get theirs from the ending itself.
            if (good && !a.keepsake) a.keepsake = clean(raw.keepsake, 16);
            this.end(pair, s, good, good ? (raw.good === true && why ? why : a.good || why) : why || a.bad, day, 'in the chat');
            return;
        }
        if (Date.now() - (a.movedAt || 0) < MOVE_GAP_MS) {
            this.log.info('stories [' + pair.key + '] "' + a.title + '": the reply moved it on again too soon, kept at stage ' + (a.stage + 1));
            this.save(pair.key, s);
            return;
        }
        this.advance(pair, s, why || a.beats[a.stage].next, day, 'in the chat');
    }

    // The player comforted the contact about a story that went badly.
    mend(pair, s, day, why) {
        const e = this.mendable(s, day);
        if (!e) return null;
        const counts = countsOf(s);
        s.trust = { helped: counts.helped, mended: counts.mended + 1 };
        e.mended = { day, at: Date.now(), text: clean(why, 80) };
        this.save(pair.key, s);
        this.log.info('stories [' + pair.key + '] "' + e.title + '" was made right afterwards' + (e.mended.text ? ': ' + e.mended.text : ''));
        if (this.d.ties) {
            try {
                this.d.ties.storyMended(pair, e.mend.grudge || '', e.title);
            } catch (err) {
                this.log.warn('stories [' + pair.key + '] mend not felt: ' + err.message);
            }
        }
        if (typeof this.d.storyMended === 'function') {
            try {
                this.d.storyMended(pair, e);
            } catch (err) {
                this.log.warn('stories [' + pair.key + '] mend not told: ' + err.message);
            }
        }
        return e;
    }

    // A thank-you the contact still owes for a story the player helped through, once its delay
    // is over: { id, title, outcome, keepsake }, or null.
    followUp(pair, now) {
        if (!this.cfg.enabled || !this.cfg.rewards) return null;
        const s = this.load(pair.key);
        const at = typeof now === 'number' ? now : Date.now();
        for (let i = s.ended.length - 1; i >= 0; i--) {
            const e = s.ended[i];
            const f = isObject(e) ? e.followUp : null;
            if (!isObject(f) || f.sent || typeof f.at !== 'number') continue;
            const waited = at - f.at;
            if (waited < this.cfg.thanks_delay_minutes * 60000 || waited >= FOLLOW_KEEP_MS) continue;
            return { id: String(e.id), title: e.title, outcome: clean(e.outcome, 120), keepsake: clean(e.keepsake, 16) };
        }
        return null;
    }

    followedUp(pair, id) {
        const s = this.load(pair.key);
        const e = s.ended.find((x) => isObject(x) && String(x.id) === String(id));
        if (!e || !isObject(e.followUp) || e.followUp.sent) return;
        e.followUp.sent = true;
        e.followUp.sentAt = Date.now();
        this.save(pair.key, s);
        this.log.info('stories [' + pair.key + '] "' + e.title + '": thank-you sent');
    }

    // What the player could see in this message, for the Stories page. The same words twice are
    // one clue.
    noteClue(pair, a, raw, day) {
        const text = clean(raw.clue, CLUE_MAX) || clean(a.beats[Math.min(a.stage, a.beats.length - 1)].show, CLUE_MAX);
        a.clues = cleanClues(a.clues);
        a.stageClues = cleanList(a.stageClues);
        if (text && a.stageClues.indexOf(text) < 0) a.stageClues = a.stageClues.concat([text]).slice(-STAGE_CLUES_KEEP);
        if (text && !a.clues.some((c) => c.text === text)) {
            a.clues.push({ text, day });
            a.clues = a.clues.slice(-CLUES_KEEP);
            this.log.info('stories [' + pair.key + '] "' + a.title + '" let a clue slip: ' + text);
        }
        if (raw.named === true && !a.revealed) {
            a.revealed = true;
            this.log.info('stories [' + pair.key + '] "' + a.title + '" was told to the player');
        }
    }

    advance(pair, s, text, day, how) {
        const a = s.active;
        a.log.push({ day, text: clean(text, 120), how });
        a.log = a.log.slice(-LOG_KEEP);
        a.movedAt = Date.now();
        a.lastMoveDay = day;
        if (a.stage + 1 >= a.beats.length) {
            // Past the last stage: it has come to a head. Moved on by the player it went well.
            this.end(pair, s, how === 'in the chat', how === 'in the chat' ? a.good || text : text, day, how);
            return;
        }
        a.stage += 1;
        // A new stage has its own new things to let show.
        a.stageClues = [];
        // A player who is moving it on does not run out of time in the middle of it.
        if (how === 'in the chat' && day !== null && typeof a.endsBy === 'number') a.endsBy = Math.max(a.endsBy, day + 1);
        if (how === 'in the chat' && typeof this.d.storyAdvanced === 'function') {
            try {
                this.d.storyAdvanced(pair, a, clean(text, 60));
            } catch (err) {
                this.log.warn('stories [' + pair.key + '] progress not told: ' + err.message);
            }
        }
        this.log.info('stories [' + pair.key + '] "' + a.title + '" moved to stage ' + (a.stage + 1) + '/' + a.beats.length + ' (' + how + '): ' + clean(text, 80));
        this.save(pair.key, s);
    }

    end(pair, s, good, outcome, day, how) {
        const a = s.active;
        const done = {
            id: a.id, title: a.title, kind: a.kind, good: !!good, outcome: clean(outcome, 160), startedDay: a.startedDay, endedDay: day, how,
            at: Date.now(), premise: a.premise, partnerName: a.partnerName || '', clues: cleanClues(a.clues), steps: cleanSteps(a.log),
            depth: Math.max(0, Math.min(2, Number(a.depth) || 0))
        };
        const rewards = !!this.cfg.rewards;
        const helped = !!good && how === 'in the chat';
        if (helped && a.keepsake) done.keepsake = clean(a.keepsake, 16);
        if (rewards && helped) done.followUp = { at: done.at, sent: false };
        // Gone wrong or gone unnoticed, not outgrown or cut short: it can still be made right.
        if (rewards && !good && how !== 'grew up' && how !== 'died' && day !== null && this.cfg.mend_days > 0) {
            done.mend = { until: day + this.cfg.mend_days, grudge: '' };
        }
        const counts = countsOf(s);
        s.trust = { helped: counts.helped + (helped ? 1 : 0), mended: counts.mended };
        s.ended.push(done);
        s.ended = s.ended.slice(-ENDED_KEEP);
        s.active = null;
        s.nextFrom = day === null ? null : day + this.cfg.gap_days;
        this.save(pair.key, s);
        this.log.info('stories [' + pair.key + '] "' + a.title + '" ended ' + (good ? 'well' : 'badly') + ' (' + how + '): ' + done.outcome);
        if (typeof this.d.storyEnded === 'function') {
            try {
                this.d.storyEnded(pair, done);
            } catch (e) {
                this.log.warn('stories [' + pair.key + '] ending not told: ' + e.message);
            }
        }
        const fact = clean(a.title + '：' + (good ? '有了好结果，' : '结果不太好，') + done.outcome, 80);
        try {
            this.d.memory.addFacts(pair.playerId, pair.partnerId, [fact], day);
        } catch (e) {
            this.log.warn('stories [' + pair.key + '] ending not remembered: ' + e.message);
        }
    }

    // The contact grew up (legacy.js): a story made for the child they were ends gently, and one
    // for their new age may start at once.
    grewUp(partnerId, from, to, day) {
        for (const s of this.all()) {
            if (!s.key.endsWith('-' + partnerId)) continue;
            const pair = { key: s.key, playerId: s.key.split('-')[0], partnerId: String(partnerId) };
            if (s.active) {
                this.end(pair, s, true, '长大了，这件事慢慢就过去了，想起来还会笑', day, 'grew up');
            }
            const now = this.load(s.key);
            now.nextFrom = day;
            this.save(s.key, now);
        }
    }

    // The contact died (legacy.js): their stories stop where they were.
    passedAway(partnerId, day, name) {
        for (const s of this.all()) {
            if (!s.key.endsWith('-' + partnerId) || !s.active) continue;
            const pair = { key: s.key, playerId: s.key.split('-')[0], partnerId: String(partnerId) };
            this.end(pair, s, false, (name || '他/她') + '走了，这件事没来得及有结果', day, 'died');
            const now = this.load(s.key);
            now.nextFrom = null;
            this.save(s.key, now);
        }
    }

    // Called with the game day for every pair the tracker sees. No LLM.
    tick(pair, env) {
        if (!this.cfg.enabled) return;
        const day = dayOf(env);
        if (day === null) return;
        if (day !== this.day) {
            this.day = day;
            this.publishSoon();
        }
        const s = this.load(pair.key);
        const a = s.active;
        if (!a) return;
        if (a.startedDay === null) {
            // Made before the game day was known.
            a.startedDay = day;
            a.lastMoveDay = day;
            a.endsBy = day + 4;
            this.save(pair.key, s);
            return;
        }
        if (a.endsBy !== null && day > a.endsBy && chatMovesOf(a) >= 1) {
            // The player was part of it: it came out well, with their help.
            this.end(pair, s, true, a.good || '事情有了好结果', day, 'in the chat');
        } else if (a.endsBy !== null && day > a.endsBy) {
            this.end(pair, s, false, a.bad || '时间过去了，事情没等到帮忙', day, 'ran out of days');
            // Nobody noticed: that stings a little (ties.js), until it is made right.
            const g = this.d.ties ? this.d.ties.storyMissed(pair, a.title, day) : null;
            if (g && g.id) {
                const now = this.load(pair.key);
                const e = now.ended.find((x) => isObject(x) && x.id === a.id);
                if (e && isObject(e.mend)) {
                    e.mend.grudge = String(g.id);
                    this.save(pair.key, now);
                }
            }
        } else if (typeof a.lastMoveDay === 'number' && day - a.lastMoveDay >= this.cfg.drift_days && a.stage + 2 < a.beats.length) {
            // Unnoticed it moves on by itself, but never into its last stage: only the player takes it there.
            // What the stage showed, not what would have moved it on: that never happened.
            this.advance(pair, s, '这一段没人察觉，事情自己往下走了（那时：' + clean(a.beats[a.stage].show, 60) + '）', day, 'by itself');
        }
    }

    // ------------------------------------------------------------ making a new one
    // Starts making a story for the pair when it has none and the gap after the last one is over.
    // Never waits for it; the next reply sees it.
    ensure(pair, snap) {
        if (!this.cfg.enabled || this.making || !this.d.llm || !this.d.llm.configured) return;
        if (Date.now() - this.madeFailAt < MAKE_RETRY_MS) return;
        const day = dayOf(snap.env);
        if (day === null) return;
        const s = this.load(pair.key);
        if (s.active || (s.nextFrom !== null && day < s.nextFrom)) return;
        this.making = this.make(pair, snap, s, day).then(() => {
            this.making = null;
        }, (e) => {
            this.making = null;
            this.madeFailAt = Date.now();
            this.log.warn('stories [' + pair.key + '] could not make a story: ' + (e && e.message || e));
        });
    }

    async make(pair, snap, s, day) {
        const p = this.prompt(pair, snap, s);
        this.log.debug('stories prompt:\n' + p.system + '\n' + p.user);
        const raw = await this.d.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0.95, max_tokens: 900, purpose: 'stories', voice: ['beats.*.show', 'good', 'bad'] });
        const arc = cleanArc(raw, day, p.depth);
        if (!arc) throw new Error('the model did not write a usable arc');
        const now = this.load(pair.key);
        if (now.active) return;
        if (snap.partner && snap.partner.name) arc.partnerName = clean(snap.partner.name, 40);
        now.active = arc;
        this.save(pair.key, now);
        this.log.info('stories [' + pair.key + '] new for ' + snap.partner.name + ': "' + arc.title + '" (' + arc.kind + ', ' + arc.beats.length +
            ' stages, by day ' + arc.endsBy + (arc.depth ? ', depth ' + arc.depth : '') + '): ' + arc.premise);
    }

    prompt(pair, snap, s) {
        const t = persona.terms(snap);
        const mem = this.d.memory.load(pair.playerId, pair.partnerId);
        const facts = mem.facts.slice(-15).map((f) => '- ' + f.text).join('\n');
        const past = s.ended.slice(-6).map((e) => '「' + e.title + '」').join('、');
        const minor = persona.isMinorGroup(snap.partner.ageGroup);
        const gone = this.d.legacy ? this.d.legacy.storyLines(pair) : [];
        const depth = this.cfg.rewards ? trustOf(countsOf(s)).depth : 0;
        const deeper = depth ? DEPTH_TEXT[depth].split('{call}').join(t.call) : '';
        const system = [
            '你给一个生活模拟游戏里的角色写一段属于他/她自己的小故事线，接下来几天会通过角色和' + t.call + '的微信聊天慢慢展开。',
            '要求：',
            '1. 是这个人自己生活里的事：一个想实现的目标、一个藏着的秘密、一个遇到的麻烦，或者在给' + t.call + '准备的惊喜。小而具体，几天之内能有结果。',
            '2. 合乎这个人的年龄、性格、喜好、学校或工作，以及下面记得的事。只用普通生活里有的东西：家、学校、公司、公园、图书馆、朋友、爱好、比赛、钱、身体、家务。' +
                '不要超自然，不要犯罪，不要生病住院、死亡这类大事。' + (minor ? '这是小孩：不写恋爱，不写危险的事。' : ''),
            '3. ' + t.call + '能参与：注意到、问起、帮忙、鼓励、批评，都会让事情不一样；没人管，事情也会自己往坏处走一点。',
            '4. beats 写 3 到 4 段，从隐约的迹象开始，越来越明显，最后一段到达关键时刻。每段 show 写这一段角色在聊天里会让' + t.call + '新知道的东西（不是剧情旁白），每段都要比上一段多透露一层，第二段起就要让' + t.call + '大概猜得到在发生什么；' +
                'next 写' + t.call + '大致怎样回应就会进入下一段（问起、关心、帮忙、鼓励这类方向，不要写成' + t.call + '必须说的某一句原话），或者事情自己有了什么变化。',
            '5. 和以前的故事不重样' + (past ? '：' + past : '') + '。',
            gone.length ? '6. 家里以前的人（已经去世），可以但不一定要用进故事里，比如找到他们留下的东西、想学他们拿手的事、在他们的忌日想做点什么：' + gone.join('；') + '。' : '',
            deeper ? '7. ' + deeper + '仍然遵守第 2 条。' : '',
            '8. keepsake 写好结局之后留下的一个小纪念：一件东西或者一个瞬间，不超过 8 个字，比如「第三名的奖状」「一起看的那场雪」。',
            '9. show、good、bad 用平常大白话写事情本身，别写成文案：' + require('./aitone').RULE_TEXT,
            '只输出 JSON：{"title":"不超过十个字","kind":"目标|秘密|麻烦|惊喜","premise":"真实情况，只有角色自己知道","want":"角色心里希望' + t.call + '怎样（可以是希望别发现）",' +
                '"beats":[{"show":"","next":""}],"good":"好结局","bad":"没人帮或搞砸时的结局","keepsake":"好结局的小纪念","days":3}'
        ].join('\n');
        const user = [
            persona.personaBlock(snap, this.d.cfg),
            // 年龄、职业、家里的成员和感情值现在单独一块（为了系统提示词的缓存），这里照旧拼上。
            persona.factsBlock(snap, this.d.cfg),
            '',
            '你此刻：' + persona.activityText(snap.partner.activity) + '。' + persona.workText(snap.partner.work, snap.partner.ageGroup) + '。',
            facts ? '记得的事：\n' + facts : '',
            '',
            '写一段新的故事线。只输出 JSON。'
        ].join('\n');
        return { system, user, depth };
    }
}

// ---------------------------------------------------------------- the phone's Stories page
Stories.prototype.boardFile = function () {
    const mailbox = this.d.cfg && this.d.cfg.mailbox;
    if (!mailbox || !mailbox.dir) return '';
    return path.join(path.dirname(mailbox.dir), 'stories', 'board.cfg');
};

Stories.prototype.publishSoon = function () {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
        this.publishTimer = null;
        this.publish();
    }, PUBLISH_DELAY_MS);
    if (this.publishTimer.unref) this.publishTimer.unref();
};

// A running story as the player may see it: never the premise, the beats or the endings.
Stories.prototype.activeView = function (a) {
    const clues = cleanClues(a.clues);
    const left = this.day !== null && typeof a.endsBy === 'number' ? Math.max(0, a.endsBy - this.day) : null;
    return {
        id: String(a.id || ''),
        revealed: !!a.revealed,
        title: a.revealed ? clean(a.title, 24) : '',
        kind: a.revealed ? clean(a.kind, 4) : '',
        stage: Math.max(0, Math.min(Number(a.stage) || 0, a.beats.length)),
        stages: a.beats.length,
        daysLeft: left,
        soon: left !== null && left <= 1,
        depth: Math.max(0, Math.min(2, Number(a.depth) || 0)),
        clues,
        startedDay: typeof a.startedDay === 'number' ? a.startedDay : null
    };
};

// Whether a bad ending can still be made right, and until which day.
Stories.prototype.mendView = function (e) {
    if (isObject(e.mended)) {
        return { state: 'mended', day: typeof e.mended.day === 'number' ? e.mended.day : null, text: clean(e.mended.text, 80) };
    }
    if (!isObject(e.mend) || typeof e.mend.until !== 'number' || !this.cfg.rewards) return null;
    if (this.day === null || this.day > e.mend.until) return { state: 'missed' };
    return { state: 'open', daysLeft: e.mend.until - this.day };
};

Stories.prototype.endedView = function (e) {
    return {
        id: String(e.id || ''),
        title: clean(e.title, 24),
        kind: clean(e.kind, 4),
        good: !!e.good,
        how: typeof e.how === 'string' ? e.how : '',
        outcome: clean(e.outcome, 160),
        premise: clean(e.premise, 200),
        clues: cleanClues(e.clues),
        steps: cleanSteps(e.steps),
        keepsake: clean(e.keepsake, 16),
        depth: Math.max(0, Math.min(2, Number(e.depth) || 0)),
        mend: this.mendView(e),
        startedDay: typeof e.startedDay === 'number' ? e.startedDay : null,
        endedDay: typeof e.endedDay === 'number' ? e.endedDay : null,
        at: typeof e.at === 'number' ? e.at : 0
    };
};

Stories.prototype.publish = function () {
    const file = this.boardFile();
    if (!file || !this.dir) return;
    const pairs = [];
    const hearts = new Map();
    for (const s of this.all()) {
        const m = /^(\d+)-(\d+)$/.exec(s.key);
        if (!m || (!s.active && !s.ended.length)) continue;
        const active = s.active ? this.activeView(s.active) : null;
        if (active && active.clues.length) hearts.set(s.key, { clues: active.clues.length, soon: active.soon });
        pairs.push({
            key: s.key,
            playerId: m[1],
            contactId: m[2],
            name: clean((s.active && s.active.partnerName) || (s.ended.length && s.ended[s.ended.length - 1].partnerName) || '', 40),
            active,
            ended: s.ended.map((e) => this.endedView(e)).reverse(),
            trust: trustOf(countsOf(s))
        });
    }
    this.hearts = hearts;
    const ladder = TRUST.slice(1).map((t) => ({ helped: t.helped, title: t.title, depth: t.depth }));
    const board = { v: BOARD_V, enabled: !!this.cfg.enabled, rewards: !!this.cfg.rewards, day: this.day, ladder, pairs };
    const text = JSON.stringify(board);
    if (text === this.boardText) return;
    try {
        fsx.ensureDir(path.dirname(file));
        fsx.writeJson(file, Object.assign({ at: Date.now() }, board));
        this.boardText = text;
    } catch (e) {
        this.log.warn('stories board not written: ' + e.message);
    }
};

// The contact's trust now; reached: the last story the player helped through took it to this level.
Stories.prototype.trustFor = function (key) {
    const t = trustOf(countsOf(this.load(key)));
    t.reached = !!t.title && TRUST[t.level].helped === t.helped;
    return t;
};

// For status.cfg: { clues, soon } while the contact's story has let something show, else null.
Stories.prototype.heart = function (key) {
    if (!this.cfg.enabled) return null;
    return this.hearts.get(String(key)) || null;
};

module.exports = { Stories, cleanArc, hinted, trustOf, countsOf, TRUST };
