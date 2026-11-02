'use strict';
// Prompts for Moments (朋友圈): a post written by one character, the likes and comments of the
// people who can see it, and a character answering a comment the player left.
// Every prompt asks for a fixed JSON object; the caller validates the fields.
const persona = require('./persona');
const { AGE_ZH } = require('./world');
const emoji = require('./emoji');

function genderText(g) {
    if (!g) return '';
    return persona.isMale(g) ? '男' : '女';
}

function jobText(p) {
    const j = p.job;
    if (j && j.kind === 'school') return '学生（' + j.job + '）';
    if (j && j.job) return j.job + (j.rank ? '（' + j.rank + '）' : '');
    if (persona.isMinorGroup(p.ageGroup)) return '学生';
    return '没有工作';
}

function likesText(p) {
    const pr = p.preferences || {};
    const parts = [];
    if (pr.likes && pr.likes.length) parts.push('喜欢 ' + pr.likes.map(persona.pref).join('、'));
    if (pr.dislikes && pr.dislikes.length) parts.push('不喜欢 ' + pr.dislikes.map(persona.pref).join('、'));
    return parts.join('；');
}

function brief(p) {
    return p.name + '（' + [genderText(p.gender), p.age, jobText(p)].filter(Boolean).join('，') + '）';
}

// How one character relates to another, from a relations() entry (null = barely know each other).
// kin is what the other person is inside the household (妈妈 / 女儿 / 丈夫 ...), when known.
function relationText(r, kin) {
    if (!r && !kin) return '认识但不熟';
    const s = (r && r.stats) || {};
    let kind;
    if (kin) kind = '你的' + kin;
    else if (r.isFamily) kind = '家人（亲戚）';
    else if ((s.Romance || 0) >= 40) kind = '恋人';
    else if ((s.Friendship || 0) >= 60) kind = '好朋友';
    else if ((s.Friendship || 0) >= 25) kind = '朋友';
    else if ((s.Business || 0) >= 30) kind = '同事或生意伙伴';
    else kind = '认识但不熟';
    const nums = [];
    if (typeof s.Family === 'number' && s.Family > 0) nums.push('亲情 ' + s.Family);
    if (typeof s.Friendship === 'number' && s.Friendship > 0) nums.push('友情 ' + s.Friendship);
    if (typeof s.Romance === 'number' && s.Romance > 0) nums.push('爱情 ' + s.Romance);
    return kind + (nums.length ? '（' + nums.join('，') + '，满分 100）' : '');
}

// One known person for a prompt: 郑宇庭（女，成年，你的妈妈（亲情 70，友情 83，满分 100））.
// info is entity_get_character_info of that person (may be null).
function personLine(r, info, kin) {
    const i = info || {};
    const age = i.growth_step ? AGE_ZH[i.growth_step] || i.growth_step : '';
    return r.name + '（' + [genderText(i.gender), age, relationText(r, kin)].filter(Boolean).join('，') + '）';
}

function voiceRule(p) {
    const g = p.ageGroup;
    const age = g === 'Child'
        ? '你是小学生：用词简单、句子短。开朗才用“嘿嘿”“哇”；闷的、内向的几乎不用。只写适合孩子的内容，不谈恋爱、烟酒、暴力。'
        : g === 'Teen'
            ? '你是中学生：简短随意。外向才多用网络词，内向话更平。不写烟酒、性、暴力。'
            : (g === 'Old' || g === 'Elder' || g === 'Senior')
                ? '你是中老年人：语气按性格来，可以完整一点，不要写成同一个慈祥长辈。'
                : '像这个人随手发的朋友圈，有自己的生活和小情绪。';
    const voice = persona.voiceBrief(p);
    return voice ? age + '\n' + voice : age;
}

function sharedRules() {
    return [
        '不要提到 AI、游戏、模拟、玩家、NPC 这些词，你们就生活在这座城市里。',
        // The phone draws [name] tokens as emoji; without its emoji set, none can be shown.
        emoji.momentsLine() || '不要用 emoji 表情符号（手机字体显示不出来），可以用“～”“！”“哈哈”这类文字表达情绪。',
        '不要用 #话题#，不要写旁白或括号里的动作描写。'
    ];
}

function postPrompt(input) {
    const p = input.profile;
    const lines = [];
    lines.push('你在扮演城市居民「' + p.name + '」，现在要用手机发一条朋友圈（类似微信朋友圈）。你生活在一座韩国风格的城市里，不知道这是游戏。');
    lines.push('你的资料：' + [genderText(p.gender), p.age, jobText(p)].filter(Boolean).join('，') + '。');
    const lk = likesText(p);
    if (lk) lines.push('你的喜好：' + lk + '。');
    if (input.extra) lines.push('补充设定：' + input.extra);
    lines.push('', voiceRule(p));
    lines.push('换一个同样年龄的人发，听起来必须不像你。');
    lines.push('', '要求：');
    const rules = [
        '内容来自你此刻真实的生活：工作或学习、心情、天气季节、吃的玩的、家人朋友、兴趣爱好、一点小感悟。要具体、有画面感，像这个人随手发的，不要像广告或作文。',
        '正文 6~80 个字，口语，带你的性格。',
        '可以偶尔提到你认识的人，但不要每条都提。提到家里人时用家里的叫法（妈妈、老公、女儿……），不要直呼家里人的全名；别把家里人说成同学、同事。你认识的人都可能看到这条朋友圈。',
        '不要和你最近发过的内容重复，换个话题或者说法。',
        '如果此刻实在不适合发（比如正在睡觉），返回 "skip": true。'
    ].concat(sharedRules());
    rules.forEach((r, i) => lines.push((i + 1) + '. ' + r));
    lines.push('', '只输出一个 JSON 对象：{"text":"朋友圈正文","place":"定位地点（可留空字符串）","skip":false}');
    const system = lines.join('\n');

    const u = [];
    u.push('城市时间：' + persona.gameTime(input.env) + '。');
    u.push('你此刻：' + persona.activityText(p.activity) + (p.emotion ? '，情绪 ' + p.emotion.text : '') + (p.site ? '，在「' + p.site + '」' : '') + '。');
    if (input.diary && input.diary.length) {
        u.push('你今天做过的事（动作代号需要你自己理解成自然的说法）：');
        for (const e of input.diary.slice(-10)) u.push('  ' + e.time + ' ' + (e.act || '空闲') + (e.site ? ' @' + e.site : ''));
    }
    if (input.friends && input.friends.length) u.push('你认识的人：' + input.friends.join('、') + '。');
    if (input.recent && input.recent.length) {
        u.push('你最近发过的朋友圈：');
        for (const t of input.recent) u.push('  - ' + t);
    }
    if (input.occasion) {
        u.push('这条朋友圈想说的事：' + input.occasion);
        u.push('按你的性格写：可以开心地晒一下，也可以含蓄地带一句；提到帮你的人，用你平时对这个人的叫法，也可以不点名。原来是秘密的部分，你愿意说多少就说多少。这次不要返回 skip。');
    }
    u.push('现在写这条朋友圈。');
    return { system, user: u.join('\n') };
}

function threadLines(post, nameOf) {
    const out = [];
    for (const c of post.comments || []) {
        out.push('  ' + nameOf(c.authorId, c.authorName) + (c.replyTo ? ' 回复 ' + nameOf(c.replyTo.id, c.replyTo.name) : '') + '：' + c.text);
    }
    return out;
}

function reactionPrompt(input) {
    const a = input.author;
    const lines = [];
    lines.push('城市里有人刚发了一条朋友圈（类似微信朋友圈），下面列出的人都能看到它。请判断每个人会不会点赞、会不会评论，并替会评论的人写评论。这些人生活在一座韩国风格的城市里，不知道这是游戏。');
    lines.push('', '规则：');
    const rules = [
        '像真实的社交圈：关系越近越可能互动，不熟的人多半只是看看。不是每个人都要互动，也可以谁都不互动。',
        '评论的人通常也会点赞。评论最多 ' + input.maxComments + ' 条。',
        '评论 2~30 个字，口语，每个人按自己的性格写：开朗的、刻薄的、内向的、爱讲究的，听起来不能一样。孩子是小孩的词，长辈是长辈的词。',
        '评论要针对这条朋友圈的内容，不要千篇一律的“好棒”“厉害”。'
    ].concat(sharedRules());
    rules.forEach((r, i) => lines.push((i + 1) + '. ' + r));
    lines.push('', '只输出一个 JSON 对象：{"likes":["点赞的人的 id"],"comments":[{"id":"评论的人的 id","text":"评论内容"}]}，没有人互动就输出空数组。');
    const system = lines.join('\n');

    const u = [];
    u.push('城市时间：' + persona.gameTime(input.env) + '。');
    u.push('发布者：' + brief(a) + '。');
    u.push('内容：「' + input.post.text + '」' + (input.post.place ? '，定位：' + input.post.place : ''));
    const thread = threadLines(input.post, input.nameOf);
    if (thread.length) u.push('已有评论：', ...thread);
    u.push('', '能看到的人：');
    for (const c of input.candidates) {
        const p = c.profile;
        const voice = persona.voiceBrief(p);
        u.push('- id=' + p.id + ' ' + brief(p) + (voice ? '\n  ' + voice.replace(/\n/g, ' ') : '') + '；发布者是这个人的：' + relationText(c.relation, c.kin).replace(/^你的/, ''));
    }
    return { system, user: u.join('\n') };
}

function replyPrompt(input) {
    const p = input.responder;
    const lines = [];
    lines.push('你在扮演城市居民「' + p.name + '」，在朋友圈的评论区里有人回复了你，你要回一句。你生活在一座韩国风格的城市里，不知道这是游戏。');
    lines.push('你的资料：' + [genderText(p.gender), p.age, jobText(p)].filter(Boolean).join('，') + '。');
    if (input.extra) lines.push('补充设定：' + input.extra);
    lines.push(input.viewer.name + '是你的：' + relationText(input.relation, input.kin).replace(/^你的/, '') + '。' + (input.kin ? '称呼对方时用家里的叫法。' : ''));
    lines.push('', voiceRule(p));
    lines.push('', '规则：');
    const rules = [
        '回复 2~40 个字，口语，像在评论区里自然地接话，符合你的性格和你们的关系。',
        '如果对方的话不需要回应（比如只是“哈哈”），可以返回空字符串表示不回。'
    ].concat(sharedRules());
    rules.forEach((r, i) => lines.push((i + 1) + '. ' + r));
    lines.push('', '只输出一个 JSON 对象：{"text":"回复内容，不回就是空字符串"}');
    const system = lines.join('\n');

    const u = [];
    u.push('城市时间：' + persona.gameTime(input.env) + '。');
    u.push('朋友圈：' + input.nameOf(input.post.authorId, input.post.authorName) + (input.post.authorId === p.id ? '（就是你）' : '') + '：「' + input.post.text + '」');
    const thread = threadLines(Object.assign({}, input.post, { comments: input.before }), input.nameOf);
    if (thread.length) u.push('评论区：', ...thread);
    u.push(input.viewer.name + ' 刚刚' + (input.target ? '回复了你的评论「' + input.target.text + '」' : '评论了你的朋友圈') + '：「' + input.comment.text + '」');
    u.push('现在写你的回复。');
    return { system, user: u.join('\n') };
}

module.exports = { postPrompt, reactionPrompt, replyPrompt, relationText, personLine };
