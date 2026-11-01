'use strict';
// How much the AI has been used: every request the reply service sent, with the token counts the
// provider reported, kept for a day in data/llm-usage.json. The reply service writes it; the
// guardian reads it and puts a summary on the phone's AI page (calls in the last 60 minutes and
// today, and what they would cost).
//
// The cost is an estimate from the provider's published prices. Prices the program does not
// know are not guessed: those calls are counted, and the page says no price is known, unless the
// player sets llm.price in config.json.
const fsx = require('./fsx');

const KEEP_MS = 25 * 3600000;
const HOUR_MS = 3600000;
const MAX_ENTRIES = 20000;

// Yuan per million tokens, from https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// (checked 2026-10-20). These are the peak prices; outside peak hours they are half.
const DEEPSEEK_PRICES = {
    'deepseek-flash': { cached: 0.04, input: 2, output: 8 },
    'deepseek-v4-pro': { cached: 0.3, input: 9, output: 27 }
};
// Old names DeepSeek still answers, billed as Flash.
const DEEPSEEK_ALIASES = { 'deepseek-v4-flash': 'deepseek-flash', 'deepseek-v4-flash-vision-exp': 'deepseek-flash' };
const BEIJING_MS = 8 * HOUR_MS;

// DeepSeek's peak hours: Monday to Friday 9:00-12:00 and 14:00-18:00 Beijing time. Public
// holidays are off-peak too; they are not known here, so a holiday is priced as a weekday.
function deepseekPeak(at) {
    const d = new Date(at + BEIJING_MS);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) return false;
    const h = d.getUTCHours();
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

function validPrice(p) {
    return !!p && typeof p === 'object' && ['input', 'output'].every((k) => typeof p[k] === 'number' && p[k] >= 0) &&
        (p.cached === undefined || (typeof p.cached === 'number' && p.cached >= 0));
}

// { input, cached, output, currency, peak? } per million tokens for one request, or null.
function priceOf(provider, model, at, custom) {
    if (validPrice(custom)) {
        return { input: custom.input, cached: typeof custom.cached === 'number' ? custom.cached : custom.input, output: custom.output, currency: custom.currency || 'CNY', source: 'config' };
    }
    if (provider !== 'deepseek') return null;
    const id = DEEPSEEK_ALIASES[model] || model;
    const p = DEEPSEEK_PRICES[id];
    if (!p) return null;
    const k = deepseekPeak(at) ? 1 : 0.5;
    return { input: p.input * k, cached: p.cached * k, output: p.output * k, currency: 'CNY', source: 'deepseek' };
}

function costOf(e, custom) {
    if (!e.ok || !e.r) return null;
    const p = priceOf(e.v, e.m, e.t, custom);
    if (!p) return null;
    const fresh = Math.max(0, e.i - e.c);
    return (fresh * p.input + e.c * p.cached + e.o * p.output) / 1e6;
}

function emptyBucket() {
    return { calls: 0, failed: 0, prompt: 0, cached: 0, completion: 0, cost: 0, unpriced: 0 };
}

function add(b, e, cost) {
    b.calls += 1;
    if (!e.ok) b.failed += 1;
    b.prompt += e.i;
    b.cached += e.c;
    b.completion += e.o;
    if (cost === null) {
        if (e.ok) b.unpriced += 1;
    } else {
        b.cost += cost;
    }
}

function round(b) {
    b.cost = Math.round(b.cost * 10000) / 10000;
    return b;
}

function startOfDay(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function compact(e) {
    return {
        t: e.at, p: String(e.purpose || 'other').slice(0, 32), v: String(e.provider || ''), m: String(e.model || '').slice(0, 128),
        ok: !!e.ok, k: e.kind || undefined, i: e.prompt | 0, c: e.cached | 0, o: e.completion | 0, r: !!e.reported
    };
}

function readEntries(file, now) {
    const r = fsx.readJson(file);
    const list = r.ok && r.value && Array.isArray(r.value.entries) ? r.value.entries : [];
    return list.filter((e) => e && typeof e.t === 'number' && now - e.t < KEEP_MS && e.t <= now + 60000);
}

// limit: the reply service's own cap per hour (0 = none). custom: llm.price from config.json.
function summarize(entries, now, opts) {
    const o = opts || {};
    const hour = emptyBucket();
    const today = emptyBucket();
    const purposes = {};
    const dayStart = startOfDay(now);
    for (const e of entries) {
        const cost = costOf(e, o.custom);
        if (e.t >= dayStart) add(today, e, cost);
        if (now - e.t < HOUR_MS) {
            add(hour, e, cost);
            const p = purposes[e.p] || (purposes[e.p] = { id: e.p, calls: 0, cost: 0 });
            p.calls += 1;
            if (cost !== null) p.cost += cost;
        }
    }
    const price = priceOf(o.provider, o.model, now, o.custom);
    return {
        v: 1,
        at: now,
        provider: o.provider || '',
        model: o.model || '',
        limit: typeof o.limit === 'number' ? o.limit : 0,
        currency: price ? price.currency : 'CNY',
        priced: !!price,
        priceSource: price ? price.source : '',
        peak: o.provider === 'deepseek' && !(o.custom && validPrice(o.custom)) ? deepseekPeak(now) : null,
        hour: round(hour),
        today: round(today),
        purposes: Object.keys(purposes).map((k) => purposes[k]).sort((a, b) => b.calls - a.calls)
            .map((p) => ({ id: p.id, calls: p.calls, cost: Math.round(p.cost * 10000) / 10000 }))
    };
}

class UsageMeter {
    constructor(file, log) {
        this.file = file;
        this.log = log;
        this.entries = readEntries(file, Date.now());
        this.dirty = false;
    }

    record(e) {
        this.entries.push(compact(e));
        if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        this.dirty = true;
    }

    // Calls in the last hour, the same count the reply service's hourly cap uses.
    lastHour(now) {
        const t = now || Date.now();
        let n = 0;
        for (const e of this.entries) if (t - e.t < HOUR_MS) n += 1;
        return n;
    }

    flush() {
        if (!this.dirty) return;
        const now = Date.now();
        this.entries = this.entries.filter((e) => now - e.t < KEEP_MS);
        try {
            fsx.writeJson(this.file, { v: 1, savedAt: now, entries: this.entries }, false);
            this.dirty = false;
        } catch (e) {
            if (this.log) this.log.warn('usage not saved: ' + e.message);
        }
    }
}

module.exports = { UsageMeter, summarize, readEntries, priceOf, deepseekPeak, DEEPSEEK_PRICES };
