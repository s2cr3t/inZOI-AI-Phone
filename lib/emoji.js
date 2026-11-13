'use strict';
// Emoji for the phone chat. The phone cannot draw emoji characters, so an emoji is written into
// the text as a token like [开心] and the phone draws it from ui/phone/emoji/<id>.png. The set
// is the phone's ui/phone/emoji/set.cfg: { v, emoji: [{ id, name, ch }] }, read here so the AI
// is told exactly the tokens the phone can draw.
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');

const CHECK_MS = 30000;
// Emoji characters and the joiners and variation selectors that build them.
const PICTO_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\p{Extended_Pictographic}]*/gu;

let file = '';
let checkedAt = 0;
let mtime = 0;
let set = [];

function configure(phoneDir) {
    const next = path.join(phoneDir, 'emoji', 'set.cfg');
    if (next !== file) {
        file = next;
        checkedAt = 0;
        mtime = 0;
        set = [];
    }
}

function load() {
    if (!file || Date.now() - checkedAt < CHECK_MS) return set;
    checkedAt = Date.now();
    let st;
    try { st = fs.statSync(file); } catch (e) { set = []; return set; }
    if (st.mtimeMs === mtime) return set;
    mtime = st.mtimeMs;
    const r = fsx.readJson(file);
    const list = r.ok && r.value && Array.isArray(r.value.emoji) ? r.value.emoji : [];
    set = list.filter((e) => e && typeof e.name === 'string' && e.name && typeof e.ch === 'string');
    return set;
}

// Without variation selectors and skin tones, so 👍🏻 and ❤️ match 👍 and ❤.
function stripVs(s) { return s.replace(/[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, ''); }

// The text with each emoji character of the set turned into its token and any other emoji
// character dropped, since the phone would show it as a box. A made-up token such as [飞吻]
// (one to three Chinese characters in brackets, not in the set, where an emoji sits: at the
// end, or before a space, punctuation or another token) is dropped too; the phone would show it
// as plain text. Brackets inside a sentence, like 他说[我不去]了, stay.
function normalize(text) {
    const list = load();
    if (!list.length) return text;
    const byChar = new Map(list.map((e) => [stripVs(e.ch), e.name]));
    const names = new Set(list.map((e) => e.name));
    return String(text).replace(PICTO_RE, (m) => {
        const name = byChar.get(stripVs(m));
        return name ? '[' + name + ']' : '';
    }).replace(/\[([一-鿿]{1,3})\](?=$|[\s，。！？、；,.!?;~～…]|\[)/g, (m, name) => (names.has(name) ? m : ''))
        .replace(/[ \t]{2,}/g, ' ').trim();
}

// One line for the reply prompt; '' when the phone has no emoji set.
function promptLine() {
    const list = load();
    if (!list.length) return '';
    return '手机能发表情，只能写成方括号写法，例如[开心]，放在句中或句末都行；可用的只有：' +
        list.map((e) => '[' + e.name + ']').join('') +
        '。不要写 emoji 字符，也不要自己编别的方括号表情。对方发来的[开心]这类也是表情。' +
        '真人发短信常用表情：可以在一句话末尾带一个表达语气，' +
        '也可以单独发一条只有表情的消息来回应，比如对方说好消息回[鼓掌]，被关心了回[抱抱]，' +
        '答应一件事回[OK]，对方发来表情也可以回一个表情。' +
        '整段回复里适合时带上一两个，不要每条都加，也不要一条里堆好几个；' +
        '哪个表情、多常用跟着你的性格和此刻心情走，正在生气或难过时就别用开心的。';
}

// The same for Moments posts and comments; '' when the phone has no emoji set.
function momentsLine() {
    const list = load();
    if (!list.length) return '';
    return '朋友圈的帖子和评论可以带表情，只能写成方括号写法，例如[开心]；可用的只有：' +
        list.map((e) => '[' + e.name + ']').join('') +
        '。不要写 emoji 字符，也不要自己编别的方括号表情。' +
        '像真人发朋友圈那样，帖子末尾常带一两个表情，评论可以只回一个表情，比如[点赞][鼓掌][大笑]；' +
        '跟着你的性格和此刻心情走，难过或生气时别用开心的。';
}

// The names of the phone's emoji, as written between brackets.
function names() {
    return load().map((e) => e.name);
}

module.exports = { configure, normalize, promptLine, momentsLine, names };
