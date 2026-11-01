'use strict';
// What one text exchange leaves behind in the two people: a mood (buffs.js) and a shift in their
// inner needs (needs.js). Both are read from the same texts by the same kind of judgement, so they
// are asked in one model call; each module still decides on its own what reaches the game.
const buffPrompts = require('./buffs-prompt');
const { needsParts } = require('./needs');

const MAX_TOKENS = 800;

// mood / needs: the input of buffs.prepare / needs.prepare, or null when that side has nothing to
// judge. At least one is present.
function aftermathPrompt(mood, needs) {
    const base = (mood || needs);
    const c = buffPrompts.exchangeContext(base.snap, base.before, base.exchange);
    const m = mood ? buffPrompts.moodParts(mood) : null;
    const n = needs ? needsParts(needs, true) : null;
    const format = [];
    const system = ['你读两位家人之间刚发生的一段手机短信，判断这段话会不会让其中一个人真的起变化。'];
    if (m && n) system.push('分两部分各自判断：一是心情，二是心里的需求。两部分互不替代，可以只有一边有变化，也可以两边都没有。');
    if (m) {
        system.push('\n【心情】');
        Array.prototype.push.apply(system, m.rules);
        format.push(m.format);
    }
    if (n) {
        system.push('\n【需求】');
        Array.prototype.push.apply(system, n.rules);
        format.push(n.format);
    }
    system.push('');
    system.push('只输出 JSON：{"why":"",' + format.join(',') + '}');
    system.push('why 写在最前面：这段话有没有真正触动谁、碰到谁心里的什么，一两句话。');
    const user = [c.who, c.closeness]
        .concat(m ? m.state : [], n ? n.state : [], [m ? m.recent : '', n ? n.recent : '', c.before, c.exchange, '\n请只输出 JSON。'])
        .filter(Boolean)
        .join('\n');
    return { system: system.join('\n'), user };
}

const ACK_RE = /^(嗯+|哦+|啊+|好+|好的|嗯嗯|哦哦|哈哈+|呵呵+|嘿+|ok|OK|okay|行|知道了|收到|谢谢)[。.!！~～]*$/;

function lightExchange(exchange) {
    const player = (exchange || []).filter((m) => m.side === 'player').map((m) => String(m.text || '').trim()).filter(Boolean);
    if (!player.length) return true;
    const last = player[player.length - 1];
    return last.length <= 2 || (last.length <= 8 && ACK_RE.test(last));
}

async function consider(d, pair, snap, exchange, before) {
    if (!exchange.length || !d.llm.configured) return;
    if (lightExchange(exchange)) {
        d.log.debug('aftermath [' + pair.key + '] skipped: light exchange');
        return;
    }
    const ready = await Promise.all([
        d.buffs.prepare(pair, snap, exchange, before).catch((e) => {
            d.log.warn('buffs [' + pair.key + '] failed: ' + (e && e.stack || e));
            return null;
        }),
        d.needs.prepare(pair, snap, exchange, before).catch((e) => {
            d.log.warn('needs [' + pair.key + '] failed: ' + (e && e.stack || e));
            return null;
        })
    ]);
    const mood = ready[0];
    const needs = ready[1];
    if (!mood && !needs) return;
    const p = aftermathPrompt(mood && mood.input, needs && needs.input);
    d.log.debug('aftermath prompt:\n' + p.system + '\n' + p.user);
    let r;
    try {
        r = await d.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0.3, max_tokens: MAX_TOKENS, purpose: 'aftermath' });
    } catch (e) {
        d.log.warn('aftermath [' + pair.key + '] mood and needs check failed: ' + (e && e.message || e));
        return;
    }
    const why = r && r.why;
    if (mood) {
        await d.buffs.apply(pair, mood, why, r && r.effects)
            .catch((e) => d.log.warn('buffs [' + pair.key + '] failed: ' + (e && e.stack || e)));
    }
    if (needs) {
        await d.needs.apply(pair, needs, mood ? null : why, r && r.changes)
            .catch((e) => d.log.warn('needs [' + pair.key + '] failed: ' + (e && e.stack || e)));
    }
}

module.exports = { consider, aftermathPrompt };
