'use strict';
// Turns of phrase that make a character's message read like an AI wrote it: "不是……而是……",
// "与其说……不如说……", "某种意义上", "仿佛", poetic similes, "值得一提的是", "总而言之",
// "不仅……更是……", three-part parallel lines, stock lyricism, piled-up feeling words, the
// assistant's "我理解你的感受". Every chat line (replies, group chats, the boss in the work
// group, stories, moments) is checked against this list after the model writes it: one
// rewrite is asked for (llm.js, option `voice`), and whatever still matches is cut here.
//
// Patterns are written in simplified characters; build() lets each character also match its
// traditional form, so "與其說" is caught like "与其说" and a fix keeps the text's own script.

const VARIANTS = '与與 说說 仿彷 佛彿 总總 仅僅 这這 义義 种種 实實 谓謂 样樣 结結 归歸 显顯 为為 对對 于於 当當 来來 让讓 们們 ' +
    '无無 论論 从從 发發 现現 时時 间間 岁歲 静靜 温溫 愿願 负負 华華 见見 涌湧 扬揚 里裡 灵靈 诗詩 远遠 长長 爱愛 贵貴 难難 ' +
    '动動 宁寧 满滿 谢謝 问問 题題 帮幫 随隨 诉訴 齐齊 认認 换換 话話 综綜 犹猶 阳陽 风風 极極 许許 烟煙 细細 灿燦 烂爛 闪閃 ' +
    '轻輕 软軟 坚堅 气氣 际際 拥擁 独獨 层層 惊驚 绪緒 价價 简簡 庆慶 关關 键鍵 乐樂 纯純 净淨 头頭 单單 惯慣 处處 觉覺 运運 ' +
    '灯燈 儿兒 鸟鳥 记記 忆憶 后後 赖賴 够夠 辈輩 么麼';
const TRAD = new Map();
for (const p of VARIANTS.split(/\s+/)) {
    const [s, t] = Array.from(p);
    if (s && t && s !== t) TRAD.set(s, t);
}

// A regex whose CJK characters also match their traditional form. Inside [...] the form is
// appended to the class; outside, the character becomes a two-character class.
function build(src, flags) {
    let out = '';
    let inClass = false;
    let esc = false;
    for (const ch of src) {
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '[' && !inClass) { inClass = true; out += ch; continue; }
        if (ch === ']' && inClass) { inClass = false; out += ch; continue; }
        const t = TRAD.get(ch);
        out += t ? (inClass ? ch + t : '[' + ch + t + ']') : ch;
    }
    return new RegExp(out, flags || 'g');
}

const NOT_END = '[^。！？!?\\n]';
const FEEL = '(温暖|美好|温柔|治愈|感动|幸福|珍贵|难忘|美妙|动人|宁静|安心|满足|浪漫|闪耀|美丽)';

// fix: '' or a string replaces the match; a function gets the match; 'clause' drops the
// clause (between commas or sentence ends) that holds it.
const RULES = [
    { id: 'not_but', label: '「不是……而是……」', re: build('不是' + NOT_END + '{1,24}?[，,、]?\\s*而是'),
        fix: (m) => m.replace(build('[，,、]?\\s*而是$', ''), '，是') },
    { id: 'rather_than', label: '「与其说……不如说……」', re: build('与其说' + NOT_END + '{0,24}?[，,]?\\s*倒?不如说'), fix: '其实' },
    { id: 'in_a_sense', label: '「某种意义上／某种程度上」', re: build('[在从]?某种(意义|程度)上(来说|而言|说)?[，,]?'), fix: '' },
    { id: 'as_if', label: '「仿佛／宛如／犹如」', re: build('仿佛|宛如|宛若|犹如|恍若|恍如|好似'), fix: '好像' },
    { id: 'simile_feel', label: '「像……一样温柔」这类比喻', re: build('像' + NOT_END + '{1,10}?(一样|一般|似的)' + FEEL.replace(')', '|灿烂|明亮|耀眼|纯粹|轻柔|柔软)')),
        fix: (m) => '很' + m.replace(build('^.*?(一样|一般|似的)', ''), '') },
    { id: 'simile_poetic', label: '把人和事比作阳光、星星、春风', re: build('像[^，。！？!?\\n]{0,6}?(阳光|星星|星辰|春风|月光|太阳|彩虹|小鹿|潮水|微风|晚风|一束光|繁星|灯塔|港湾|花儿)'), fix: 'clause' },
    { id: 'worth_noting', label: '「值得一提的是」', re: build('值得(一提|注意|关注|庆幸|骄傲)的是[，,]?'), fix: '' },
    { id: 'summing_up', label: '「总而言之／总的来说／换句话说」', re: build('(总而言之|总的来说|综上所述|归根结底|简而言之|总结一下|换句话说|换言之)[，,]?'), fix: '' },
    { id: 'not_only_more', label: '「不仅……更是……」', re: build('不(仅|只|单)仅?' + NOT_END + '{1,20}?[，,]\\s*(更是|更加是|更)'),
        fix: (m) => m.replace(build('^不(仅|只|单)仅?', ''), '').replace(build('(更加是|更是)$', ''), '也是').replace(build('更$', ''), '也') },
    { id: 'more_important', label: '「更重要的是」', re: build('更(重要|难得|关键|可贵|难能可贵)的是[，,]?'), fix: '' },
    { id: 'firstly', label: '「首先……其次」「一方面……另一方面」', re: build('首先[，,]?|其次[，,]?|另一方面[，,]?|一方面[，,]?'), fix: '', when: build('首先' + NOT_END + '{0,40}其次|一方面[^\\n]{0,60}另一方面', '') },
    { id: 'assistant', label: '助手腔（我理解你的感受、感谢你的分享……）', re: build('我(能|可以|完全|很)?理解你的(感受|心情)|你的(感受|情绪)(很|非常)?重要|感谢你的(分享|信任|理解|陪伴)|谢谢你愿意(告诉我|跟我说|和我分享|分享)|希望(这|这些)(能|可以)帮(到|助)你|如果你需要' + NOT_END + '{0,12}随时|这是一个(很|非常)?好的问题'), fix: 'clause' },
    { id: 'lyrical', label: '刻意抒情（岁月静好、心中涌起、那一刻……）', re: build('岁月静好|时光荏苒|未来可期|不负韶华|感恩遇见|诗和远方|星辰大海|人间烟火|细水长流|温柔以待|眼里有光|嘴角(不自觉地|微微)?上扬|心[中头里](涌起|泛起|一暖)|与(世界|自己)和解|(生活|成长|陪伴)的意义|温[暖柔]而坚定|满满的(幸福|感动|爱|温暖|治愈)|治愈了我|被治愈|灵魂|那一刻|这一瞬间|那一瞬间'), fix: 'clause' },
    { id: 'abstract_is', label: '「真正的幸福是」「这就是一种温柔」', re: build('(真正的|最好的)(勇气|幸福|意义|成长|爱|陪伴|力量|温柔|浪漫)|就?是一种(温柔|幸福|力量|陪伴|成长|勇气|浪漫|治愈|幸运|爱)|(大概|也许|或许)?就是(生活|成长|长大|爱|幸福)(吧|的意义|的样子)'), fix: 'clause' },
    { id: 'feel_stack', label: '空泛情绪词堆叠（温暖又美好）', re: build(FEEL + '(而又|又|而且|而|且|、|和)' + FEEL), fix: (m) => m.match(build(FEEL, ''))[0] },
    { id: 'em_dash', label: '破折号「——」', re: /\s*—{1,2}\s*/g, fix: '，' }
];

// Three or more clauses in a row that open with the same two characters: "有你在，有家在，有光在".
const CLAUSE = /[^，,、；;。！？!?\n]+/g;
function parallels(text) {
    const parts = [];
    let m;
    CLAUSE.lastIndex = 0;
    while ((m = CLAUSE.exec(text))) parts.push({ s: m[0].trim(), at: m.index, end: m.index + m[0].length });
    const runs = [];
    let i = 0;
    while (i < parts.length) {
        let j = i;
        const head = Array.from(parts[i].s).slice(0, 2).join('');
        const ok = (p) => { const n = Array.from(p.s).length; return n >= 4 && n <= 16; };
        if (ok(parts[i]) && /^[一-鿿]{2}$/.test(head) && head[0] !== head[1]) {
            while (j + 1 < parts.length && ok(parts[j + 1]) && Array.from(parts[j + 1].s).slice(0, 2).join('') === head &&
                !/[。！？!?\n]/.test(text.slice(parts[j].end, parts[j + 1].at))) j++;
        }
        const distinct = new Set(parts.slice(i, j + 1).map((p) => p.s)).size;
        if (j - i >= 2 && distinct > 1) runs.push({ from: parts[i], to: parts[j] });
        i = j + 1;
    }
    return runs;
}

function hits(text) {
    if (typeof text !== 'string' || !text) return [];
    const out = [];
    for (const r of RULES) {
        if (r.when && !r.when.test(text)) continue;
        r.re.lastIndex = 0;
        const m = r.re.exec(text);
        if (m) out.push({ id: r.id, label: r.label, text: m[0].trim() });
    }
    for (const run of parallels(text)) out.push({ id: 'parallel', label: '三段以上的排比句', text: text.slice(run.from.at, run.to.end).trim() });
    return out;
}

const SEP = /[，,、；;。！？!?~～\n]/;
// Drops the clause around [at, end): from the separator before it to the one after it.
function dropClause(text, at, end) {
    let a = at;
    while (a > 0 && !SEP.test(text[a - 1])) a--;
    let b = end;
    while (b < text.length && !SEP.test(text[b])) b++;
    // Keep the sentence's own ending (。！？) when the clause was its last part.
    if (a > 0 && /[，,、；;]/.test(text[a - 1])) a--;
    else if (b < text.length && /[，,、；;]/.test(text[b])) b++;
    return text.slice(0, a) + text.slice(b);
}

function tidy(text) {
    return text
        .replace(/([，,、；;])\s*([，,、；;。！？!?~～])/g, '$2')
        .replace(/^[\s，,、；;。]+/, '')
        .replace(/[，,、；;]+$/, '')
        .replace(/很很/g, '很')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

// The text with every listed pattern rewritten or cut. May come back '' when nothing is left.
function scrub(text) {
    if (typeof text !== 'string' || !text) return text;
    let t = text;
    for (let round = 0; round < 6; round++) {
        let changed = false;
        for (const r of RULES) {
            if (r.when && !r.when.test(t)) continue;
            r.re.lastIndex = 0;
            const m = r.re.exec(t);
            if (!m) continue;
            if (r.fix === 'clause') t = dropClause(t, m.index, m.index + m[0].length);
            else {
                const by = typeof r.fix === 'function' ? r.fix(m[0]) : r.fix;
                t = t.slice(0, m.index) + by + t.slice(m.index + m[0].length);
            }
            changed = true;
        }
        const runs = parallels(t);
        if (runs.length) {
            const run = runs[0];
            t = t.slice(0, run.from.end) + t.slice(run.to.end);
            changed = true;
        }
        t = tidy(t);
        if (!changed) break;
    }
    return t;
}

// ------------------------------------------------------------ JSON fields

// paths: 'messages', 'text', 'beats.*.show'. A string or an array of strings at the end.
function visit(obj, path, fn) {
    const keys = path.split('.');
    const walk = (node, i) => {
        if (node === null || typeof node !== 'object') return;
        const k = keys[i];
        const last = i === keys.length - 1;
        const slots = k === '*' ? (Array.isArray(node) ? node.map((_, n) => n) : []) : [k];
        for (const s of slots) {
            const v = node[s];
            if (!last) { walk(v, i + 1); continue; }
            if (typeof v === 'string') { const nv = fn(v); if (nv !== v) node[s] = nv; }
            else if (Array.isArray(v)) {
                for (let n = 0; n < v.length; n++) if (typeof v[n] === 'string') { const nv = fn(v[n]); if (nv !== v[n]) v[n] = nv; }
            }
        }
    };
    walk(obj, 0);
}

function findIn(obj, paths) {
    const found = [];
    for (const p of [].concat(paths || [])) visit(obj, p, (s) => { for (const h of hits(s)) found.push(Object.assign({ line: s }, h)); return s; });
    return found;
}

// Rewrites the fields in place; an array loses lines that came back empty. Returns what changed.
function scrubIn(obj, paths) {
    const changed = [];
    for (const p of [].concat(paths || [])) {
        visit(obj, p, (s) => {
            const t = scrub(s);
            if (t !== s) changed.push({ from: s, to: t });
            return t;
        });
    }
    for (const p of [].concat(paths || [])) {
        const keys = p.split('.');
        const parentPath = keys.slice(0, -1);
        const leaf = keys[keys.length - 1];
        const drop = (node, i) => {
            if (node === null || typeof node !== 'object') return;
            if (i === parentPath.length) {
                if (Array.isArray(node[leaf])) node[leaf] = node[leaf].filter((x) => typeof x !== 'string' || x.trim());
                return;
            }
            const k = parentPath[i];
            const next = k === '*' ? (Array.isArray(node) ? node : []) : [node[k]];
            for (const n of next) drop(n, i + 1);
        };
        drop(obj, 0);
    }
    return changed;
}

// The ask for the one rewrite, naming what was caught.
function rewriteAsk(found) {
    const seen = new Set();
    const lines = [];
    for (const f of found) {
        const k = f.id + '|' + f.text;
        if (seen.has(k)) continue;
        seen.add(k);
        lines.push('- ' + f.label + '：「' + f.text + '」');
        if (lines.length >= 8) break;
    }
    return '上面的话里有一听就不像真人发消息的句子：\n' + lines.join('\n') +
        '\n把这些句子改成平常人发微信的说法：直接说事，短，口语，可以省略，可以只说半句。不要换成别的书面说法、比喻或排比。' +
        '其他内容和字段不变，按原来的格式只输出那个 JSON 对象。';
}

// For the prompts: the same list, short, as a rule.
const RULE_TEXT = '说话像真人随手发消息：短句，口语，可以省略、停顿、说半句，不修辞。' +
    '绝对不要用这些：「不是……而是……」「与其说……不如说……」「某种意义上」「仿佛／宛如／犹如」「像……一样温柔」这类比喻、把人比作阳光星星春风、' +
    '「值得一提的是」「更重要的是」「总而言之／总的来说／换句话说」「不仅……更是……」「首先……其次」、三句一样开头的排比、' +
    '岁月静好、那一刻、心中涌起、嘴角上扬、真正的幸福是、这就是一种温柔这类抒情和总结、温暖又美好这种堆形容词、' +
    '「我理解你的感受」「感谢你的分享」这类客服腔、破折号。直接说事和心情，别升华。';

module.exports = { RULES, RULE_TEXT, hits, scrub, findIn, scrubIn, rewriteAsk, build };
