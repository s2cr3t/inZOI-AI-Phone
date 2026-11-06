'use strict';
// OpenAI-compatible chat completions client (DeepSeek, Qwen, Kimi, GLM, Doubao, OpenAI, custom
// servers). Always asks for a JSON object and validates it before returning.
//
// Providers disagree on the optional fields: how deep thinking is switched off, whether
// temperature, max_tokens or JSON mode are accepted. The `dialect` of the provider picks the
// first attempt. When a server rejects a field (HTTP 400/422 naming it), the request is
// adjusted and sent again at once, and the adjustment is remembered per server and model in
// data/llm-quirks.json.
const fs = require('fs');
const path = require('path');

const MAX_ADAPT = 5;
const OPENAI_EFFORT_FALLBACK = ['none', 'minimal', 'low'];

class LlmError extends Error {
    constructor(kind, message, status) {
        super(message);
        this.name = 'LlmError';
        this.kind = kind; // auth | balance | rate | server | network | timeout | format | config | model | quota
        this.status = status || 0;
    }

    // Errors that will not go away by retrying with the same configuration.
    get permanent() {
        return this.kind === 'auth' || this.kind === 'balance' || this.kind === 'config' || this.kind === 'model';
    }

    // Short English line for the phone UI.
    get publicMessage() {
        switch (this.kind) {
            case 'auth': return 'AI key rejected';
            case 'balance': return 'AI account out of credit';
            case 'rate': return 'AI service busy';
            case 'quota': return 'Hourly AI limit reached';
            case 'timeout': return 'AI timed out';
            case 'network': return 'AI service unreachable';
            case 'config': return 'AI not configured';
            case 'model': return 'AI model not available';
            case 'format': return 'AI reply unreadable';
            default: return 'AI service error';
        }
    }
}

// Remembered adjustments, keyed by "<base url>|<model>".
class QuirkStore {
    constructor(file) {
        this.file = file || '';
        this.map = {};
        if (!this.file) return;
        try {
            const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (v && typeof v === 'object' && !Array.isArray(v)) this.map = v;
        } catch (e) { /* none yet */ }
    }

    get(key) {
        const q = this.map[key];
        return q && typeof q === 'object' ? q : {};
    }

    set(key, q) {
        this.map[key] = q;
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = this.file + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.map, null, 2) + '\n', 'utf8');
            fs.renameSync(tmp, this.file);
        } catch (e) { /* only an optimisation */ }
    }
}

const quirkStores = new Map();
function quirkStore(file) {
    const key = file || '';
    if (!quirkStores.has(key)) quirkStores.set(key, new QuirkStore(file));
    return quirkStores.get(key);
}

function mentions(detail, words) {
    return words.some((w) => detail.indexOf(w) >= 0);
}

// Learns from a rejected request. Returns the new quirks, or null when nothing can be changed.
function adapt(dialect, q, detail, thinking) {
    const d = String(detail || '').toLowerCase();
    const n = Object.assign({}, q);
    if (mentions(d, ['response_format', 'json_object', 'json mode', 'json_mode']) && !n.noJsonMode) {
        n.noJsonMode = true;
        return n;
    }
    if (mentions(d, ['max_completion_tokens']) && !n.completionTokens) {
        n.completionTokens = true;
        return n;
    }
    if (mentions(d, ['max_tokens']) && !n.completionTokens && !n.noMaxTokens) {
        n.completionTokens = true;
        return n;
    }
    if (mentions(d, ['temperature', 'top_p', 'sampling']) && !n.noTemperature) {
        n.noTemperature = true;
        return n;
    }
    if (mentions(d, ['reasoning_effort', 'reasoning effort', 'effort'])) {
        if (dialect === 'openai' && thinking === 'disabled') {
            const at = OPENAI_EFFORT_FALLBACK.indexOf(n.effort || 'none');
            if (at >= 0 && at + 1 < OPENAI_EFFORT_FALLBACK.length) {
                n.effort = OPENAI_EFFORT_FALLBACK[at + 1];
                return n;
            }
        }
        if (!n.noEffort) {
            n.noEffort = true;
            return n;
        }
        if (dialect === 'openai') return null;
    }
    if (mentions(d, ['thinking', 'enable_thinking', 'reasoning'])) {
        // A model that always thinks refuses to be told not to: ask for the least thinking it
        // allows, and if even that is refused, leave the switch out.
        if (!n.thinkingForced) {
            n.thinkingForced = true;
            return n;
        }
        if (!n.noThinkingParam) {
            n.noThinkingParam = true;
            return n;
        }
    }
    return null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripFences(text) {
    let s = String(text || '').trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
    if (fence) s = fence[1].trim();
    return s;
}

function parseJsonObject(text) {
    const s = stripFences(text);
    try {
        const v = JSON.parse(s);
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch (e) { /* fall through */ }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const v = JSON.parse(s.slice(start, end + 1));
            if (v && typeof v === 'object' && !Array.isArray(v)) return v;
        } catch (e) { /* fall through */ }
    }
    return null;
}

class LlmClient {
    constructor(options) {
        this.update(options);
        this.calls = [];
        this.health = null;
    }

    update(options) {
        const o = options || {};
        this.baseUrl = String(o.base_url || '').replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
        this.model = o.model;
        this.apiKey = o.apiKey || '';
        this.provider = o.provider || 'custom';
        this.dialect = o.dialect || dialectOf(this.provider);
        this.temperature = o.temperature;
        this.thinking = o.thinking || 'disabled';
        this.maxTokens = o.max_tokens;
        this.timeoutMs = o.timeout_ms || 60000;
        this.maxRetries = o.max_retries === undefined ? 2 : o.max_retries;
        this.maxPerHour = o.max_calls_per_hour === 0 ? 0 : (o.max_calls_per_hour || 120);
        this.jsonMode = o.json_mode !== false;
        this.quirks = quirkStore(o.quirks_file || (this.quirks && this.quirks.file) || '');
        this.log = o.log || this.log || null;
        this.keyRequired = !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(this.baseUrl);
    }

    get configured() {
        return !!(this.baseUrl && this.model && (this.apiKey || !this.keyRequired));
    }

    endpoint() {
        return this.baseUrl + '/chat/completions';
    }

    quirkKey() {
        return this.baseUrl + '|' + this.model;
    }

    // The request body for this provider, with what earlier rejections taught us applied.
    body(messages, o, q) {
        const thinking = o.thinking || this.thinking || 'disabled';
        const off = thinking === 'disabled';
        const body = { model: this.model, messages, stream: false };
        const tokens = o.max_tokens || this.maxTokens;
        if (tokens && !q.noMaxTokens) {
            if (q.completionTokens || this.dialect === 'openai') body.max_completion_tokens = tokens;
            else body.max_tokens = tokens;
        }
        const temperature = o.temperature === undefined ? this.temperature : o.temperature;
        // Thinking models fix their own sampling; temperature only shapes a direct answer.
        if (off && !q.thinkingForced && !q.noTemperature && typeof temperature === 'number') {
            body.temperature = temperature;
        }
        if (!q.noThinkingParam) {
            switch (this.dialect) {
                case 'deepseek':
                case 'thinking':
                    if (off && !q.thinkingForced) {
                        body.thinking = { type: 'disabled' };
                    } else {
                        body.thinking = { type: 'enabled' };
                        if (!q.noEffort) body.reasoning_effort = off ? 'low' : thinking;
                    }
                    break;
                case 'qwen':
                    body.enable_thinking = !(off && !q.thinkingForced);
                    break;
                case 'openai':
                    if (!q.noEffort) body.reasoning_effort = off ? (q.effort || 'none') : (thinking === 'max' ? 'high' : thinking);
                    break;
                default:
                    break;
            }
        }
        if (this.dialect === 'openai' && body.reasoning_effort && body.reasoning_effort !== 'none') delete body.temperature;
        if (this.jsonMode && !q.noJsonMode) body.response_format = { type: 'json_object' };
        return body;
    }

    headers() {
        const headers = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers.Authorization = 'Bearer ' + this.apiKey;
        return headers;
    }

    // Model ids the server offers (GET /models). Empty when the server has no such list.
    async listModels() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 20000));
        let res;
        let text;
        try {
            res = await fetch(this.baseUrl + '/models', { method: 'GET', headers: this.headers(), signal: controller.signal });
            text = await res.text();
        } catch (e) {
            if (e && e.name === 'AbortError') throw new LlmError('timeout', 'no answer from /models');
            throw new LlmError('network', (e.cause && e.cause.code) || e.message);
        } finally {
            clearTimeout(timer);
        }
        if (res.status === 401 || res.status === 403) throw new LlmError('auth', 'HTTP ' + res.status, res.status);
        if (!res.ok) return [];
        let data;
        try { data = JSON.parse(text); } catch (e) { return []; }
        const list = Array.isArray(data) ? data : Array.isArray(data && data.data) ? data.data : Array.isArray(data && data.models) ? data.models : [];
        const ids = [];
        for (const m of list) {
            const id = typeof m === 'string' ? m : m && (m.id || m.model || m.name);
            if (typeof id === 'string' && id && ids.indexOf(id) < 0) ids.push(id);
        }
        return ids;
    }

    reserve() {
        const hourAgo = Date.now() - 3600000;
        this.calls = this.calls.filter((t) => t > hourAgo);
        if (this.maxPerHour > 0 && this.calls.length >= this.maxPerHour) {
            throw new LlmError('quota', 'more than ' + this.maxPerHour + ' AI calls in the last hour');
        }
        this.calls.push(Date.now());
    }

    // Every request that reached the provider (or failed trying), for the usage meter.
    // usage: the provider's own token counts; absent when it reported none.
    report(purpose, ok, usage, kind) {
        if (!this.onUsage) return;
        const u = usage || {};
        const details = u.prompt_tokens_details || {};
        const cached = typeof u.prompt_cache_hit_tokens === 'number' ? u.prompt_cache_hit_tokens
            : typeof details.cached_tokens === 'number' ? details.cached_tokens : 0;
        try {
            this.onUsage({
                at: Date.now(),
                purpose: purpose || 'other',
                provider: this.provider,
                model: this.model,
                ok: !!ok,
                kind: kind || '',
                prompt: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0,
                cached,
                completion: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
                reported: typeof u.prompt_tokens === 'number'
            });
        } catch (e) { /* the meter must never break a request */ }
    }

    // One request, adjusting and resending at once when the server rejects an optional field.
    async once(messages, options) {
        const o = typeof options === 'number' ? { temperature: options } : (options || {});
        const thinking = o.thinking || this.thinking || 'disabled';
        const key = this.quirkKey();
        let q = this.quirks.get(key);
        for (let n = 0; ; n++) {
            try {
                const r = await this.post(this.body(messages, o, q));
                r.jsonMode = this.jsonMode && !q.noJsonMode;
                this.health = { ok: true, at: Date.now(), model: this.model };
                this.report(o.purpose, true, r.usage);
                return r;
            } catch (e) {
                const next = e instanceof LlmError && e.rejectedField && n < MAX_ADAPT ? adapt(this.dialect, q, e.detail, thinking) : null;
                if (!next) {
                    if (e instanceof LlmError) this.health = { ok: false, at: Date.now(), model: this.model, kind: e.kind, message: e.publicMessage };
                    this.report(o.purpose, false, null, e instanceof LlmError ? e.kind : 'error');
                    throw e;
                }
                if (this.log) this.log.warn('llm ' + this.model + ' rejected a request field (' + e.detail.slice(0, 160) + '); adjusting and sending again');
                q = next;
                this.quirks.set(key, q);
            }
        }
    }

    async post(body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let res;
        let text;
        try {
            res = await fetch(this.endpoint(), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal });
            text = await res.text();
        } catch (e) {
            if (e && e.name === 'AbortError') throw new LlmError('timeout', 'no answer within ' + this.timeoutMs + ' ms');
            throw new LlmError('network', (e.cause && e.cause.code) || e.message);
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) throw httpError(res.status, text);
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new LlmError('format', 'response is not JSON');
        }
        const choice = data && data.choices && data.choices[0];
        const content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
        if (this.log && data.usage) {
            this.log.debug('llm usage prompt=' + data.usage.prompt_tokens + ' completion=' + data.usage.completion_tokens +
                (data.usage.prompt_cache_hit_tokens !== undefined ? ' cache_hit=' + data.usage.prompt_cache_hit_tokens : ''));
        }
        return { content, finish: choice && choice.finish_reason, usage: data && data.usage ? data.usage : null };
    }

    // Checks key, server and model with one tiny request. Resolves to { latencyMs };
    // throws LlmError otherwise. A reply that is not JSON still proves the connection works.
    async ping() {
        if (!this.configured) throw new LlmError('config', 'no API key configured');
        const started = Date.now();
        await this.once([
            { role: 'system', content: 'Reply with the JSON object {"ok":true} and nothing else.' },
            { role: 'user', content: 'ping' }
        ], { max_tokens: 400, temperature: 0 });
        return { latencyMs: Date.now() - started };
    }

    // Sends system+user, returns a parsed JSON object. Retries transient failures with backoff
    // and asks once more if the model produced something that is not a JSON object.
    async json(system, user, options) {
        if (!this.configured) throw new LlmError('config', 'no API key configured');
        const o = options || {};
        const images = Array.isArray(o.images) ? o.images.filter((u) => typeof u === 'string' && /^data:image\/(?:jpeg|png|gif|webp);base64,/i.test(u)) : [];
        // Vision providers use content blocks in the user message. Plain text requests keep
        // their original shape, and no image data is ever copied into logs or retry prompts.
        const content = images.length ? [{ type: 'text', text: user }].concat(images.map((url) => ({
            type: 'image_url', image_url: { url, detail: 'auto' }
        }))) : user;
        const messages = [
            { role: 'system', content: system },
            { role: 'user', content }
        ];
        let formatRetry = false;
        for (let attempt = 0; ; attempt++) {
            this.reserve();
            try {
                const r = await this.once(messages, o);
                const obj = parseJsonObject(r.content);
                if (obj) return o.voice ? this.voiced(messages, r.content, obj, o) : obj;
                if (formatRetry) throw new LlmError('format', 'model did not return a JSON object: ' + r.content.slice(0, 200));
                formatRetry = true;
                messages.push({ role: 'assistant', content: r.content });
                messages.push({ role: 'user', content: '上一条输出不是合法的 JSON 对象。请只输出符合要求的 JSON 对象，不要任何其他文字。' });
                continue;
            } catch (e) {
                if (!(e instanceof LlmError)) throw e;
                const transient = e.kind === 'rate' || e.kind === 'server' || e.kind === 'network' || e.kind === 'timeout';
                if (!transient || attempt >= this.maxRetries) throw e;
                const wait = Math.min(2000 * Math.pow(2, attempt), 15000);
                if (this.log) this.log.warn('llm ' + e.kind + ' (' + e.message + '), retry in ' + wait + ' ms');
                await sleep(wait);
            }
        }
    }

    // Chat lines (o.voice: the JSON fields that hold them) go through lib/aitone.js: on a hit
    // the model is asked once to rewrite them, and whatever still matches is cut by hand.
    async voiced(messages, content, obj, o) {
        const tone = require('./aitone');
        let out = obj;
        const found = tone.findIn(obj, o.voice);
        if (found.length) {
            if (this.log) this.log.info('ai tone [' + (o.purpose || 'other') + ']: ' + found.map((f) => f.id + '「' + f.text + '」').join(' | ') + '; asking for a rewrite');
            try {
                this.reserve();
                const r = await this.once(messages.concat([
                    { role: 'assistant', content },
                    { role: 'user', content: tone.rewriteAsk(found) }
                ]), Object.assign({}, o, { purpose: (o.purpose || 'other') + '_retone' }));
                const again = parseJsonObject(r.content);
                // Only the chat fields are taken from the rewrite: actions and the rest stay as first written.
                if (again) {
                    out = Object.assign({}, obj);
                    for (const top of new Set([].concat(o.voice).map((p) => String(p).split('.')[0]))) {
                        if (again[top] !== undefined && Array.isArray(again[top]) === Array.isArray(obj[top]) && typeof again[top] === typeof obj[top]) out[top] = again[top];
                    }
                }
            } catch (e) {
                if (this.log) this.log.warn('ai tone rewrite failed (' + e.message + '); cutting the lines by hand');
            }
        }
        const cut = tone.scrubIn(out, o.voice);
        if (cut.length && this.log) this.log.info('ai tone [' + (o.purpose || 'other') + '] cut: ' + cut.map((c) => '「' + c.from + '」→「' + c.to + '」').join(' | '));
        return out;
    }
}

function dialectOf(provider) {
    try {
        const p = require('./providers').get(provider);
        return (p && p.dialect) || 'plain';
    } catch (e) {
        return 'plain';
    }
}

const FIELD_WORDS = ['response_format', 'json_object', 'json mode', 'temperature', 'top_p', 'max_tokens',
    'max_completion_tokens', 'reasoning_effort', 'thinking', 'enable_thinking', 'unsupported parameter',
    'unknown parameter', 'unrecognized', 'not supported', 'extra inputs', 'extra_forbidden'];

// Turns an HTTP error answer into an LlmError. Bodies are cut short and never contain the key.
function httpError(s, text) {
    let detail = String(text || '').slice(0, 300);
    let code = '';
    try {
        const j = JSON.parse(text);
        const err = j && (j.error || j);
        if (err && typeof err === 'object') {
            detail = String(err.message || err.msg || JSON.stringify(err)).slice(0, 300);
            code = String(err.code || err.type || '');
        }
    } catch (e) { /* keep raw */ }
    const low = (detail + ' ' + code).toLowerCase();
    const msg = 'HTTP ' + s + ': ' + detail;
    let e;
    if (s === 401 || s === 403 || mentions(low, ['invalid api key', 'invalidapikey', 'incorrect api key', 'invalid_api_key', 'authentication', 'unauthorized'])) {
        e = new LlmError('auth', msg, s);
    } else if (s === 402 || mentions(low, ['insufficient balance', 'insufficient_balance', 'arrearage', 'insufficient_quota',
        'exceeded_current_quota', 'account balance', 'overdue', 'not enough balance'])) {
        e = new LlmError('balance', msg, s);
    } else if (s === 429) {
        e = new LlmError('rate', msg, s);
    } else if (!mentions(low, FIELD_WORDS) && (mentions(low, ['model_not_found', 'modelnotfound', 'no such model', 'invalidendpointormodel']) ||
        (low.indexOf('model') >= 0 && mentions(low, ['not found', 'does not exist', 'not exist', 'invalid', 'unknown', 'no access', 'not have access', 'not available'])))) {
        e = new LlmError('model', msg, s);
    } else if (s === 400 || s === 404 || s === 422) {
        e = new LlmError('config', msg, s);
    } else {
        e = new LlmError('server', msg, s);
    }
    e.detail = detail;
    e.rejectedField = (s === 400 || s === 422) && e.kind === 'config' && mentions(low, FIELD_WORDS);
    return e;
}

module.exports = { LlmClient, LlmError, parseJsonObject, httpError, adapt };
