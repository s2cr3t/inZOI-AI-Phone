'use strict';
// Prompts for chat moodlets. The model reads one text exchange between two household members
// and decides, the way a real person would feel it, whether either of them is moved by it; a
// second short call picks the game's own moodlet that fits what happened.
const persona = require('./persona');

const STRENGTH_TEXT = { 1: '轻微', 2: '明显', 3: '强烈' };

function emotionLine(e) {
    if (!e) return '不清楚';
    return e.text + '（' + e.type + '）';
}

function closeness(snap) {
    const rel = snap.relationship || {};
    const parts = [];
    for (const k of Object.keys(rel)) parts.push(k + ' ' + rel[k]);
    return parts.length ? parts.join('，') + '（0~100）' : '不清楚';
}

function transcriptLines(list, names) {
    return (list || []).map((m) => names[m.side] + '：' + m.text).join('\n');
}

// The mood judgement in parts, so it can be asked alone (moodPrompt) or together with the needs
// judgement in one call (aftermath.js).
// emotions: [{ id, names: '满意/愉快/欢快', tendency, strengths: [1,2,3] }]
// recent: [{ who: 'partner'|'player', name, emotion, minutesAgo }]
function moodParts(input) {
    const snap = input.snap;
    const names = { partner: snap.partner.name, player: snap.player.name };
    const menu = input.emotions.map((e) => e.id + '：' + e.names + '（' + (e.tendency === 'negative' ? '负面' : '正面') + '，可选强度 ' + e.strengths.join('/') + '）').join('\n');
    const rules = [
        '你判断的结果会变成游戏里的一条心情效果，挂在这个人身上一段时间，游戏会写明这份心情源自和对方的哪段交流。',
        '像一个真实的人那样去体会：谁对谁说了什么，读到的人会是什么感受，有多强烈。这和你们是什么关系、关系好不好、读的人此刻本来是什么心情都有关系。',
        '日常来往、问事情、交代事情，读完心情不会变，这时 effects 写空数组。一句话真的让人心里一动（高兴、感动、被惦记、被逗乐，或者委屈、生气、难过、不安……）就写。',
        '读的人自己回了什么是最直接的证据：回复里已经流露出明显的情绪，说明这段话确实打动了他。',
        '两个人都可能被影响：一方的话会影响另一方，回过来的话也会再影响先开口的人。每个人最多一条。',
        '只有下面「最近因为聊天已有的心情」里列出的才算已经有过；之前的聊天里提过同一件事，但没列在那里，就是还没有，这次照样可以给。已经有过的同样感受不要再给一次，除非这次的话明显又往前推了一步（比如答应的事真的兑现了）。',
        '情绪只能从下面这张表里选 id。强度：1 轻微，2 明显，3 强烈。强烈的很少见，要配得上那句话的分量。',
        menu
    ];
    const format = '"effects":[{"who":"partner 或 player","emotion":"表里的 id","strength":1,"why":"一句话，读到哪句话、为什么是这种感受"}]';
    const recent = (input.recent || []).map((r) => names[r.who] + ' ' + r.minutesAgo + ' 分钟前因为聊天有了「' + r.name + '」（' + r.emotion + '）').join('\n');
    const state = [
        names.partner + ' 现在的心情：' + emotionLine(snap.partner.emotion),
        names.player + ' 现在的心情：' + emotionLine(snap.player.emotion)
    ];
    return { rules, format, state, recent: recent ? '最近因为聊天已有的心情：\n' + recent : '' };
}

// The lines both judgements read: who the two are, how close, and the texts.
function exchangeContext(snap, before, exchange) {
    const t = persona.terms(snap);
    const names = { partner: snap.partner.name, player: snap.player.name };
    return {
        who: 'partner = ' + names.partner + '，是' + names.player + '的' + t.me + '；player = ' + names.player + '。',
        closeness: '关系数值：' + closeness(snap),
        before: before && before.length ? '\n之前的聊天：\n' + transcriptLines(before, names) : '',
        exchange: '\n这次的短信：\n' + transcriptLines(exchange, names)
    };
}

function moodPrompt(input) {
    const m = moodParts(input);
    const c = exchangeContext(input.snap, input.before, input.exchange);
    const system = [
        '你读两位家人之间刚发生的一段手机短信，判断这段话会不会让其中一个人的心情真的起变化。'
    ].concat(m.rules, [
        '只输出 JSON：{"why":"",' + m.format + '}',
        'why 写在最前面：这段话里有没有真正触动谁的地方，一两句话。'
    ]).join('\n');
    const user = [c.who, c.closeness].concat(m.state, [m.recent, c.before, c.exchange, '\n请只输出 JSON。']).filter(Boolean).join('\n');
    return { system, user };
}

// options: [{ strength, name, from, text }] of one emotion, nearest strength first.
function pickPrompt(input) {
    const lines = input.options.map((o, i) => (i + 1) + '. [' + (STRENGTH_TEXT[o.strength] || '') + '] ' + o.name + '｜' + o.from + (o.text ? '｜' + o.text : '')).join('\n');
    const system = [
        '游戏里有下面这些心情效果，每条是：序号. [强度] 名字｜游戏写的来源｜说明。',
        '为刚才这段手机短信给 ' + input.target + ' 选一条最贴切的。来源和说明要和真实发生的事说得通：这是隔着手机发短信，不是当面做了什么、送了什么、一起经历了什么。',
        '来源说得通最重要，强度其次：感受的强度附近没有合适的，可以选强一档或弱一档的。',
        '没有说得通的就选 0，宁可不选也不要选一条和事情对不上的。',
        '只输出 JSON：{"why":"一句话","pick":序号}'
    ].join('\n');
    const user = [
        input.target + ' 的感受：' + input.feeling + '（' + (STRENGTH_TEXT[input.strength] || '') + '）',
        '原因：' + input.why,
        '短信：\n' + input.exchange,
        '',
        '可选：',
        lines,
        '',
        '请只输出 JSON。'
    ].join('\n');
    return { system, user };
}

module.exports = { moodPrompt, moodParts, exchangeContext, pickPrompt, STRENGTH_TEXT };
