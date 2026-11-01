'use strict';
// Finds the old memories a conversation is about. Chinese is matched on two-character pieces
// ("踢球" in "上次一起踢球" meets "和爸爸踢球"), Latin text on words. Rare pieces count for
// more than common ones, a big event a little more than a small one, a recent one a little more
// than an old one. No model call: this runs for every reply.

// Pieces too common in texts between family members to say what something is about.
const STOP = new Set([
    '我们', '你们', '他们', '她们', '自己', '什么', '怎么', '这个', '那个', '一下', '一个', '一起', '今天', '现在', '刚才',
    '还是', '就是', '不是', '没有', '可以', '知道', '觉得', '时候', '这样', '那样', '真的', '好的', '好啊', '哈哈', '嗯嗯',
    '一点', '有点', '还有', '然后', '因为', '所以', '但是', '如果', '已经', '怎样', '是不', '不要', '要不', '了吗',
    '的时', '了一', '一会', '会儿', '吗？', '吧！', '你的', '我的', '他的', '她的', '的话', '在干', '干嘛', '你在', '我在',
    '妈妈', '爸爸', '老公', '老婆', '宝贝', '孩子'
]);
// Words that ask for the past: more memories are worth showing.
const ASKS_PAST_RE = /还记得|记得|还记|上次|那次|那天|以前|之前|上回|前几天|昨天|前天|小时候|当时|后来|那件事/;

// Single characters too common to mean anything on their own.
const STOP_CHARS = new Set('我你他她它的了是在有不这那就也都和与跟吗吧呢啊呀哦嗯么个们去来说要会想好看还没很太又再把被给对让着过得地里中大小多少点儿天今明昨日次一起'.split(''));
// A shared character counts this much of a shared pair: "下棋" meets "下国际象棋" only weakly.
const CHAR_WEIGHT = 0.4;

function chars(text) {
    const out = new Set();
    for (const ch of String(text || '').match(/[\u4e00-\u9fff]/g) || []) if (!STOP_CHARS.has(ch)) out.add(ch);
    return out;
}

function grams(text) {
    const s = String(text || '');
    const out = new Set();
    const cjk = s.match(/[\u4e00-\u9fff]+/g) || [];
    for (const run of cjk) {
        if (run.length === 1) continue;
        for (let i = 0; i + 2 <= run.length; i++) {
            const g = run.slice(i, i + 2);
            if (!STOP.has(g)) out.add(g);
        }
    }
    const words = s.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
    for (const w of words) out.add(w);
    return out;
}

// item: { text, topics?, w? (1..3), at?, day? }. Returns the best few with their score,
// highest first; nothing below the bar.
// opts.ignore: words (family names) that say who, not what, and so do not make a match.
function recall(query, items, opts) {
    const o = opts || {};
    const raw = String(query || '');
    const past = ASKS_PAST_RE.test(raw);
    // "还记得" asks for the past; it is not what the past was about.
    let text = raw.split(new RegExp(ASKS_PAST_RE.source, 'g')).join(' ');
    for (const w of o.ignore || []) if (w) text = text.split(w).join(' ');
    const q = grams(text);
    const qc = chars(text);
    if ((!q.size && !qc.size) || !items.length) return [];
    const limit = o.limit || (past ? 8 : 5);
    const bar = typeof o.bar === 'number' ? o.bar : (past ? 1.6 : 2.2);
    const docs = items.map((it) => {
        const body = String(it.text || '') + ' ' + (it.topics || []).join(' ');
        return { it, g: grams(body), c: chars(body) };
    });
    const df = new Map();
    const cf = new Map();
    for (const d of docs) {
        for (const g of d.g) df.set(g, (df.get(g) || 0) + 1);
        for (const c of d.c) cf.set(c, (cf.get(c) || 0) + 1);
    }
    // A small pool would make every piece look common; rarity is judged as if there were 20.
    const n = Math.max(docs.length, 20);
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const day = typeof o.day === 'number' ? o.day : null;
    const scored = [];
    for (const d of docs) {
        let s = 0;
        let hits = 0;
        const covered = new Set();
        for (const g of q) {
            if (!d.g.has(g)) continue;
            hits += 1;
            s += Math.log(1 + n / df.get(g));
            covered.add(g[0]);
            covered.add(g[1]);
        }
        // Characters met outside a shared pair: abbreviations and reordered words.
        let charHits = 0;
        for (const c of qc) {
            if (covered.has(c) || !d.c.has(c)) continue;
            charHits += 1;
            s += CHAR_WEIGHT * Math.log(1 + n / cf.get(c));
        }
        // One shared character alone is chance, not a topic.
        if (!hits && charHits < 2) continue;
        s = s / Math.sqrt(Math.max(12, d.g.size) / 12);
        s += ((d.it.w || 1) - 1) * 0.3;
        const ageDays = day !== null && typeof d.it.day === 'number'
            ? Math.max(0, day - d.it.day)
            : Math.max(0, (now - (d.it.at || now)) / 86400000);
        s -= Math.min(1, ageDays / 60);
        if (s >= bar) scored.push({ item: d.it, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => Object.assign({ score: Math.round(x.score * 100) / 100 }, x.item));
}

// When it was, in the game's days when both are known ("昨天 18:30", "5 天前"), else by the date.
function whenText(item, env, now) {
    if (env && typeof env.day === 'number' && typeof item.day === 'number') {
        const diff = env.day - item.day;
        const at = item.time ? ' ' + item.time : '';
        if (diff <= 0) return '今天' + at;
        if (diff === 1) return '昨天' + at;
        if (diff === 2) return '前天';
        return diff + ' 天前';
    }
    if (!item.at) return '以前';
    const days = Math.floor(((now || Date.now()) - item.at) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    const d = new Date(item.at);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

module.exports = { grams, recall, whenText, ASKS_PAST_RE };
