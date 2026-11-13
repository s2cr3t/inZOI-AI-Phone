'use strict';
// Who each classmate is in the class chat (classgroup.js): a card made once per member and kept
// (data/classcards.json), so the chat has its joker, its swot, its lurker and its contrarian, and
// each of them sounds the same every time they speak. The card is drawn from the member's game
// traits where those point somewhere, no two members of one class with the same part while parts
// are left, and fixed by the member's id otherwise, so it never changes from one start to the next.
//   role       the part they play, and how often they speak (weight, against 1 for most)
//   habits     a catchphrase, how long their lines run, their punctuation
//   emoji      the one or two they use, or none
//   topics     what they bring up when they open a topic
// The card goes into the group prompt (persona.groupPrompt), the weight into who speaks next
// (groups.rank), the topics into what a classmate opens with (classgroup.topic).
const path = require('path');
const fsx = require('./fsx');

const V = 1;
// The parts, with what they say and how often. traits: game trait keys that point to the part.
const ROLES = [
    { id: 'monitor', name: '班长', weight: 0.9, traits: ['Leader'],
        how: '你是班长：会提醒交作业、明天考什么、值日、别刷屏；偶尔被大家起哄“班长说两句”。正经里带点无奈，不跟着瞎起哄太久。',
        topics: ['提醒大家明天要交的东西或者要考的范围', '通知一件班里的事（值日、换座位、班会），顺便吐槽一句', '催还没交作业的人（点一个群里的人）'] },
    { id: 'joker', name: '段子手', weight: 1.6, traits: ['Entertainer', 'Popular'],
        how: '你是群里的段子手：爱抖机灵、谐音梗、夸张比喻，别人说什么你都能往好笑的方向歪一下。但不重复别人的梗，每次都是你自己的新说法。',
        topics: ['讲一件今天发生的糗事，越说越离谱', '发一个自己编的冷笑话或者谐音梗', '给刚才那节课的老师起个外号（不说脏话）'] },
    { id: 'swot', name: '学霸', weight: 0.8, traits: ['Intellect', 'Achiever', 'Perfectionist'],
        how: '你是学霸：有人问作业、考试，你会认真答（说出具体是哪一题、哪个知识点），用词规整，标点齐全。被调侃“学霸带带我”时有点无语，但还是会帮。不聊剧、不熬夜。',
        topics: ['问大家某道作业题是不是有歧义，说出你的想法', '提醒一个容易错的知识点', '说今天老师讲的一个点你觉得很有意思'] },
    { id: 'lurker', name: '潜水党', weight: 0.25, traits: ['Observer', 'Riskaverse'],
        how: '你是潜水党：几乎不说话，冒泡也只回一两个字（“嗯”“+1”“？”“哈”），或者一个表情。被点名才多说半句。绝不长篇。',
        topics: ['冒个泡，只问一句很短的“明天要带什么”'] },
    { id: 'gossip', name: '八卦王', weight: 1.4, traits: [],
        how: '你是八卦王：最爱打听和爆料，“听说……”“你们知道吗”“谁谁谁是不是……”，对谁和谁走得近特别敏感。只说群里的人，不编没见过的人。',
        topics: ['神秘兮兮地说“你们知道吗”，爆一个群里的人的小八卦（不伤人）', '打听谁放学和谁一起走的'] },
    { id: 'contrarian', name: '杠精', weight: 1.0, traits: ['Arrogant'],
        how: '你是杠精：别人说东你偏说“也不一定吧”“我觉得还好啊”，爱较真、挑字眼，但不是吵架，是嘴硬。',
        topics: ['反驳一个大家都认同的说法（比如食堂难吃），说出你的歪理'] },
    { id: 'meme', name: '表情包狂魔', weight: 1.1, traits: [],
        how: '你是表情包狂魔：一半的时候只发表情，或者“哈哈哈哈哈哈”“救命”“绝了”这种一两个词，很少打完整的句子。',
        topics: ['只发一句“救命”加一个表情，然后说今天太累了'] },
    { id: 'artsy', name: '文艺青年', weight: 0.7, traits: ['Dreamer', 'Artist', 'Romantic'],
        how: '你是文艺青年：说话有画面感，偶尔冒一句像歌词或者朋友圈文案的话，喜欢天气、晚霞、音乐。会被大家吐槽“又开始了”。',
        topics: ['说今天的天色或者天气，配一句文艺的话', '分享一首最近单曲循环的歌'] },
    { id: 'sporty', name: '体育委员', weight: 1.0, traits: ['Activist', 'Adventurer'],
        how: '你是体育委员：张口闭口打球、跑步、体育课，嗓门大，爱用感叹号，约人放学去球场。对作业不上心。',
        topics: ['约人放学去打球或者跑步', '吐槽体育课被取消了或者跑八百米'] },
    { id: 'helper', name: '老好人', weight: 0.9, traits: ['Helper', 'Cooperator', 'Peacemaker'],
        how: '你是老好人：有人吵起来你打圆场，有人求帮忙你第一个答应，说话软，爱说“没事没事”“我可以帮你”。',
        topics: ['问谁需要帮忙（借笔记、带早餐）', '关心一下群里今天看起来不太对劲的人'] },
    { id: 'cool', name: '高冷', weight: 0.6, traits: ['Independent'],
        how: '你是高冷的那个：话少，句子短，不用感叹号也不用表情，偶尔一句吐槽一针见血。从不刷屏。',
        topics: ['冷冷地吐槽一句今天的作业量'] },
    { id: 'gamer', name: '游戏宅', weight: 1.0, traits: [],
        how: '你是游戏宅：聊游戏、熬夜、上分，用游戏里的词形容生活（“这波”“血亏”“掉线”），总是没睡够。',
        topics: ['说昨晚打游戏打到几点，约人今晚开黑', '用游戏的说法吐槽今天的课'] },
    { id: 'foodie', name: '吃货', weight: 1.0, traits: [],
        how: '你是吃货：什么话题都能拐到吃的上，食堂、奶茶、零食、谁带了什么吃的，饿了就在群里喊。',
        topics: ['问食堂今天有什么好吃的，或者约人去买奶茶', '说你包里藏了什么零食'] }
];
const BY_ID = new Map(ROLES.map((r) => [r.id, r]));
const CATCH = {
    monitor: ['都安静点', '别刷屏了啊', '收到回个1'], joker: ['笑不活了', '我宣布', '离大谱'], swot: ['严格来说', '其实', '我算了一下'],
    lurker: ['嗯', '+1', '？'], gossip: ['你们知道吗', '听说', '我跟你们说'], contrarian: ['也不一定吧', '我觉得还好', '那可未必'],
    meme: ['救命', '哈哈哈哈哈哈', '绝了'], artsy: ['今天的天好好看', '突然有点感慨', '像歌里唱的'], sporty: ['走起！', '冲！', '谁来！'],
    helper: ['没事没事', '我可以帮你', '别急别急'], cool: ['哦', '随便', '行吧'], gamer: ['这波', '血亏', '我掉线了'], foodie: ['饿了', '有吃的吗', '奶茶走起']
};
const PUNCT = ['几乎不用标点，用空格断开', '句号党：每句都规规矩矩用句号', '爱用“！！”', '爱用“……”', '偶尔用“~”', '标点正常'];
const LENGTH = { lurker: '一两个字', meme: '很短，常常只有表情或一两个词', cool: '很短', swot: '可以稍长，最多 25 个字' };

function hash(s) {
    let h = 2166136261;
    for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h;
}

class ClassCards {
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.data = { v: V, groups: {} };
    }

    configure(dataDir) {
        this.file = path.join(dataDir, 'classcards.json');
        const r = fsx.readJson(this.file);
        this.data = r.ok && r.value && r.value.v === V && r.value.groups ? r.value : { v: V, groups: {} };
    }

    save() {
        if (!this.file) return;
        try { fsx.writeJson(this.file, this.data, true); } catch (e) { this.log.warn('classcards: not saved: ' + e.message); }
    }

    // The card of one member, made the first time it is asked for. traits: the game trait keys,
    // owner: the class monitor's id, emojiNames: the phone's emoji.
    card(groupId, memberId, opts) {
        const o = opts || {};
        const g = this.data.groups[groupId] || (this.data.groups[groupId] = {});
        const id = String(memberId);
        if (g[id] && BY_ID.has(g[id].role)) return g[id];
        const taken = new Set(Object.keys(g).map((k) => g[k].role));
        const h = hash(groupId + ':' + id);
        let role = '';
        if (o.owner && String(o.owner) === id) role = 'monitor';
        if (!role) {
            const fit = ROLES.filter((r) => r.id !== 'monitor' && r.traits.some((t) => (o.traits || []).indexOf(t) >= 0) && !taken.has(r.id));
            if (fit.length) role = fit[h % fit.length].id;
        }
        if (!role) {
            const free = ROLES.filter((r) => r.id !== 'monitor' && !taken.has(r.id));
            const pool = free.length ? free : ROLES.filter((r) => r.id !== 'monitor');
            role = pool[h % pool.length].id;
        }
        const names = Array.isArray(o.emojiNames) ? o.emojiNames : [];
        // One in five uses no emoji at all; the lurker and the cool one most of all.
        let emoji = [];
        if (names.length && role !== 'cool' && (h >> 3) % 5 !== 0) {
            const n = role === 'meme' ? 2 : 1 + ((h >> 5) % 2);
            for (let i = 0; i < n; i++) {
                const e = names[(h >> (7 + i * 4)) % names.length];
                if (emoji.indexOf(e) < 0) emoji.push(e);
            }
        }
        const catches = CATCH[role] || [''];
        const c = {
            role,
            catchphrase: catches[(h >> 11) % catches.length],
            punct: role === 'swot' ? PUNCT[1] : role === 'cool' ? PUNCT[0] : role === 'sporty' ? PUNCT[2] : PUNCT[(h >> 13) % PUNCT.length],
            length: LENGTH[role] || '短，一句话',
            emoji
        };
        g[id] = c;
        this.save();
        this.log.info('classcards [' + groupId + '] ' + id + ' is the ' + BY_ID.get(role).name + (emoji.length ? ' [' + emoji.join('][') + ']' : ', no emoji'));
        return c;
    }

    // How often a member speaks against the rest (groups.rank); 1 for anyone without a card yet.
    weight(groupId, memberId) {
        const c = this.data.groups[groupId] && this.data.groups[groupId][String(memberId)];
        const r = c && BY_ID.get(c.role);
        return r ? r.weight : 1;
    }

    // A topic in this member's line, or '' for the hour's own pool.
    topic(groupId, memberId, rand) {
        const c = this.data.groups[groupId] && this.data.groups[groupId][String(memberId)];
        const r = c && BY_ID.get(c.role);
        if (!r || !r.topics.length) return '';
        return r.topics[Math.floor((typeof rand === 'function' ? rand() : Math.random()) * r.topics.length) % r.topics.length];
    }

    // The card as the prompt gives it.
    text(c) {
        const r = c && BY_ID.get(c.role);
        if (!r) return '';
        return [
            '【你在这个群里是什么样的人】' + r.how,
            '口头禅：「' + c.catchphrase + '」（偶尔用，别每句都用）。句子长度：' + c.length + '。标点：' + c.punct + '。',
            c.emoji.length ? '表情你只用这' + c.emoji.length + '个：' + c.emoji.map((e) => '[' + e + ']').join('') + '，而且大多数句子不带表情。'
                : '你在群里不发表情。'
        ].join('\n');
    }
}

// ------------------------------------------------------------ keeping the chat from echoing
function grams(s) {
    const t = String(s || '').replace(/\[[^\]]{1,6}\]/g, '').replace(/[\s，。！？、；：,.!?;:~～…"“”'‘’()（）]/g, '');
    const out = new Set();
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
    return { text: t, set: out };
}

// Whether a line says what one of the recent ones already said: most of its pairs of characters
// in one of them, or the same run of five characters.
function repeats(line, recent) {
    const a = grams(line);
    if (a.text.length < 2) return false;
    for (const r of recent || []) {
        const b = grams(r);
        if (!b.text) continue;
        if (a.text === b.text) return true;
        let shared = 0;
        for (const g of a.set) if (b.set.has(g)) shared++;
        if (a.set.size >= 3 && shared / a.set.size >= 0.6) return true;
        for (let i = 0; i + 5 <= a.text.length; i++) if (b.text.indexOf(a.text.slice(i, i + 5)) >= 0) return true;
    }
    return false;
}

// What the recent lines keep saying: runs of four or more characters found in two or more of
// them, and the emoji used three times or more.
function wornOut(lines) {
    const texts = (lines || []).map((l) => grams(l).text);
    const runs = new Map();
    texts.forEach((t, i) => {
        const seen = new Set();
        for (let n = 6; n >= 4; n--) for (let k = 0; k + n <= t.length; k++) {
            const s = t.slice(k, k + n);
            if (seen.has(s)) continue;
            seen.add(s);
            if (!runs.has(s)) runs.set(s, new Set());
            runs.get(s).add(i);
        }
    });
    const phrases = [];
    for (const [s, at] of Array.from(runs.entries()).sort((x, y) => y[1].size - x[1].size || y[0].length - x[0].length)) {
        // A run overlapping one already picked (作业本比我惨 / 业本比我惨这) is the same phrase.
        const overlaps = (p) => { for (let k = 0; k + 3 <= s.length; k++) if (p.indexOf(s.slice(k, k + 3)) >= 0) return true; return false; };
        if (at.size < 2 || phrases.some(overlaps)) continue;
        phrases.push(s);
        if (phrases.length >= 5) break;
    }
    const emo = new Map();
    for (const l of lines || []) for (const m of String(l).match(/\[[^\]]{1,6}\]/g) || []) emo.set(m, (emo.get(m) || 0) + 1);
    const emoji = Array.from(emo.entries()).filter((e) => e[1] >= 3).map((e) => e[0]);
    return { phrases, emoji };
}

module.exports = { ClassCards, ROLES, repeats, wornOut };
