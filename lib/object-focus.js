'use strict';
// Short-lived conversational references, never executable commands or long-term memories.
const TTL_MS = 10 * 60000;
const LIMIT = 6;
const FOLLOWUP = /看[到见].*[吗嘛麻么没]|能看到|找到.*[吗嘛么没]|找到了没|在哪[里儿]?|就是.*那个|前面那个|旁边那个|现在呢|然后呢|怎么样了|做好了[吗嘛么没]|做完了[吗嘛么没]/;
const INSPECT = /看[到见].*[吗嘛麻么没]|能看到|找到.*[吗嘛么没]|找到了没|在哪[里儿]?|有没有|能不能找到|能找到|怎么样了|做好了[吗嘛么没]|做完了[吗嘛么没]/;
const LOOKUP = /找|看见|看到|在哪|有没有|试试|去玩|想玩|玩一|用一下|拿|打开|关掉|清理|收拾|弹|抓/;
const CANCEL = /^(?:(?:宝贝|宝宝|妈妈|爸爸)[，,\s]*)?(?:算了|不用了|不找了|别找了|不玩了|别玩了|取消|停下|(?:别|不要|不用)(?:找|玩|用|拿|做)[^，,。！？?吗嘛么]{0,30})(?:吧|啦|了|哦|呀|[，。！!\s])*$/;
const SEQUENCE = /先.+(?:再|然后)|(?:完|结束|之后|以后).*(?:再|去)|等会|等下|待会|稍后|明天|今晚|然后/;

function queryText(text) {
    // A correction replaces its rejected half; do not rank the object the player ruled out.
    return String(text || '').replace(/^.*不是[^，,。]*[，,]\s*(?:而)?是/, '')
        .replace(/^.*(?:别|不要|不用)[^，,。]*[，,]\s*/, '').trim();
}

function score(text, name) {
    const q = queryText(text).toLowerCase().replace(/\s+/g, '');
    const n = String(name || '').toLowerCase().replace(/\s+/g, '');
    if (n.length < 2) return 0;
    if (q.includes(n)) return 100 + n.length;
    // Three-character Chinese fragments handle category names without matching generic verbs.
    for (let size = Math.min(10, n.length); size >= 3; size--) {
        for (let i = 0; i + size <= n.length; i++) {
            const part = n.slice(i, i + size);
            if (/^[\u3400-\u9fff]+$/.test(part) && q.includes(part)) return size * 5;
        }
    }
    const words = n.match(/[a-z]{3,}/g) || [];
    return words.some((w) => new RegExp('\\b' + w + '\\b', 'i').test(String(text))) ? 12 : 0;
}

function rank(text, objects, namesFor) {
    return (objects || []).map((o, index) => {
        const names = (o.actions || []).map((a) => typeof a === 'string' ? a : a.name).concat(namesFor ? namesFor(o) : []);
        return { object: o, score: Math.max(score(text, o.name), ...names.map((n) => score(text, n)), 0), index };
    }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score ||
        (a.object.meters == null ? Infinity : a.object.meters) - (b.object.meters == null ? Infinity : b.object.meters) || a.index - b.index);
}

function next(previous, text, site, matched, now) {
    const q = queryText(text);
    const old = previous && now - previous.at < TTL_MS ? previous : null;
    if (CANCEL.test(q)) return null;
    if (!old && !matched && FOLLOWUP.test(q)) return null;
    const followup = !!(old && FOLLOWUP.test(q) && !/(?:再|重新)(?:找|玩|试|做|来)/.test(q));
    // An unrelated new topic must not inherit the previous target.
    if (!followup && !matched && !LOOKUP.test(q)) return null;
    if (followup) {
        const moved = old.site !== site;
        return Object.assign({}, old, { at: now, site, followup: true, inspect: INSPECT.test(q),
            status: moved ? 'looking' : old.status, candidates: moved ? [] : old.candidates, task: moved ? null : old.task });
    }
    return { id: String(now), at: now, site, query: q.slice(0, 400), followup: false,
        inspect: INSPECT.test(q), status: 'looking', candidates: [] };
}

function prompt(focus) {
    if (!focus) return '';
    const lines = ['本轮正在核实的目标：' + focus.query,
        '目标状态：' + focus.status + '。这是同一件事的上下文，不是新的执行授权。'];
    for (const o of focus.candidates || []) {
        lines.push('候选 ' + o.id + '｜' + o.name + (o.meters == null ? '' : '｜约' + o.meters + '米') +
            '｜' + (o.error ? '当前动作查询失败' : o.actions.length ? '可用动作：' + o.actions.map((a) => a.name).join('、') : '当前未获得可用动作'));
    }
    if (focus.error) lines.push('本轮查询未完成，不能据此声称物品不存在或不能使用。');
    else if (!focus.candidates.length) lines.push('当前提供的信息尚未匹配到目标，这不代表整个世界没有这个物品。');
    lines.push('物品出现在数据清单不等于亲眼看见或已经走到。不要编造转了一圈、走过去看过等过程。' +
        '当前自主动作（例如拍照）不是对方正在问的目标；先回答这件事。');
    if (focus.inspect) lines.push('这一轮只在询问位置或进展：回答核实结果，actions 和 promises 用空数组；已排队的任务由原计划继续，不重新下达。');
    if (focus.status === 'done' && focus.followup) lines.push('这件事已经完成；对方没有明确说再做一次，不要重复执行。');
    return lines.join('\n');
}

// Only eliminate optional social embellishments around a single accepted object task.
// Multi-step instructions, inventory chains, and explicit waiting keep their original order.
function prioritize(steps, focus, promise, pending, bubbles) {
    if (!focus || focus.inspect || !promise || focus.status === 'done') return steps;
    const words = (pending || []).map((m) => m.text || '').concat(bubbles || []).join('\n');
    if (SEQUENCE.test(words)) return steps;
    const uses = steps.filter((s) => s.type === 'use_object');
    if (uses.length !== 1 || uses[0].after || uses[0].interaction && (uses[0].interaction.pocket || uses[0].interaction.then)) return steps;
    const target = uses[0];
    if (!(focus.candidates || []).some((o) => o.id === target.objectId)) return steps;
    if (steps.some((s) => !['use_object', 'interact', 'emote', 'stop_current'].includes(s.type))) return steps;
    return steps.filter((s) => s.type !== 'interact' || score(focus.query, s.interaction && s.interaction.name) > 0);
}

function interruptIdle(activity, focus, promise, pending, bubbles, steps) {
    if (!activity || activity.idle || activity.scheduled || !focus || focus.inspect || !promise) return false;
    const words = (pending || []).map((m) => m.text || '').concat(bubbles || []).join('\n');
    if (SEQUENCE.test(words) || !/马上|现在就|这就|立刻|赶紧/.test(words)) return false;
    if (!steps.some((s) => s.type === 'use_object' && (focus.candidates || []).some((o) => o.id === s.objectId))) return false;
    // Restrict automatic interruption to known idle leisure; no meals, hygiene, work or carrying.
    return /^(Sit_|Self_Child_Hopscotch$|Self_Karma_Farting$)/.test(activity.id || '');
}

module.exports = { TTL_MS, LIMIT, CANCEL, SEQUENCE, queryText, score, rank, next, prompt, prioritize, interruptIdle };
