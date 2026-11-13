'use strict';
// Streamable-HTTP MCP client for the inZOI game (http://127.0.0.1:11212/mcp).
// The game issues a new Mcp-Session-Id on every restart, so the client performs the
// initialize handshake itself and transparently re-handshakes when the session expires.

const PROTOCOL_VERSION = '2024-11-05';

class GameOfflineError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GameOfflineError';
    }
}

class GameToolError extends Error {
    constructor(tool, message) {
        super(tool + ': ' + message);
        this.name = 'GameToolError';
        this.tool = tool;
    }
}

function parseSse(text) {
    const events = [];
    const blocks = text.split(/\r?\n\r?\n/);
    for (const block of blocks) {
        const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data) continue;
        try { events.push(JSON.parse(data)); } catch (e) { /* ignore keep-alive frames */ }
    }
    return events;
}

function tryParse(text) {
    try { return { ok: true, value: JSON.parse(text) }; } catch (e) { /* fall through */ }
    // Some game commands emit \' inside JSON strings, which is not a legal JSON escape.
    if (text.indexOf("\\'") >= 0) {
        try { return { ok: true, value: JSON.parse(text.replace(/\\'/g, "'")) }; } catch (e) { /* fall through */ }
    }
    return { ok: false };
}

function extractJson(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    let r = tryParse(trimmed);
    if (r.ok) return r.value;
    const i = trimmed.search(/[\[{]/);
    if (i < 0) return null;
    r = tryParse(trimmed.slice(i));
    return r.ok ? r.value : null;
}

// Game tool results are CLI envelopes such as {"success":true,"message":"...","data":{...}},
// sometimes serialized into the text content. Normalize to the payload object.
function unwrapPayload(tool, text) {
    const value = extractJson(text);
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        ('success' in value || 'data' in value)) {
        if (value.success === false) throw new GameToolError(tool, value.message || 'failed');
        let data = value.data;
        if (typeof data === 'string') data = extractJson(data) || data;
        if (data !== undefined && data !== null && data !== '') return data;
        const fromMessage = extractJson(value.message);
        if (fromMessage) return fromMessage;
        return value;
    }
    if (value !== null) return value;
    if (/^\s*ERROR\b/i.test(text)) throw new GameToolError(tool, text.trim());
    return { text: text };
}

class Semaphore {
    constructor(limit) {
        this.limit = limit;
        this.active = 0;
        this.queue = [];
    }
    async run(fn) {
        if (this.active >= this.limit) await new Promise((resolve) => this.queue.push(resolve));
        this.active += 1;
        try {
            return await fn();
        } finally {
            this.active -= 1;
            const next = this.queue.shift();
            if (next) next();
        }
    }
}

class GameClient {
    constructor(options) {
        const o = options || {};
        this.url = o.url || 'http://127.0.0.1:11212/mcp';
        this.timeoutMs = o.timeoutMs || 15000;
        this.log = o.log || null;
        this.sessionId = null;
        this.handshake = null;
        this.nextId = 1;
        this.gate = new Semaphore(o.concurrency || 4);
        this.tools = null;
    }

    async post(body, timeoutMs) {
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream'
        };
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);
        let res;
        try {
            res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
        } catch (e) {
            clearTimeout(timer);
            if (e && e.name === 'AbortError') throw new GameOfflineError('game did not answer within ' + (timeoutMs || this.timeoutMs) + ' ms');
            throw new GameOfflineError('game is not reachable at ' + this.url + ' (' + (e.cause && e.cause.code || e.message) + ')');
        }
        let text;
        try {
            text = await res.text();
        } finally {
            clearTimeout(timer);
        }
        return { res, text };
    }

    async connect() {
        if (this.sessionId) return;
        if (!this.handshake) {
            this.handshake = (async () => {
                this.sessionId = null;
                const { res, text } = await this.post({
                    jsonrpc: '2.0',
                    id: this.nextId++,
                    method: 'initialize',
                    params: {
                        protocolVersion: PROTOCOL_VERSION,
                        capabilities: {},
                        clientInfo: { name: 'inzoi-sms-bridge', version: '2.0.0' }
                    }
                });
                if (!res.ok) throw new GameOfflineError('initialize failed with HTTP ' + res.status + ': ' + text.slice(0, 200));
                const sid = res.headers.get('mcp-session-id');
                if (!sid) throw new GameOfflineError('game did not issue an Mcp-Session-Id');
                this.sessionId = sid;
                await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
                if (this.log) this.log.info('game session ' + sid);
            })().finally(() => { this.handshake = null; });
        }
        await this.handshake;
    }

    reset() {
        this.sessionId = null;
        this.tools = null;
    }

    async rpc(method, params, timeoutMs) {
        // INZOI_TRACE_CALLS=<file>: one line per tool called, for finding what the service asks
        // the game for, and how often (a diagnosis aid, off unless set).
        if (process.env.INZOI_TRACE_CALLS && method === 'tools/call') {
            try { require('fs').appendFileSync(process.env.INZOI_TRACE_CALLS, Date.now() + ' ' + (params && params.name) + '\n'); } catch (e) { /* tracing only */ }
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            await this.connect();
            const id = this.nextId++;
            const { res, text } = await this.post({ jsonrpc: '2.0', id, method, params: params || {} }, timeoutMs);
            if (res.status === 404 || res.status === 400 && /session/i.test(text)) {
                this.reset();
                continue;
            }
            if (!res.ok) throw new GameOfflineError(method + ' failed with HTTP ' + res.status + ': ' + text.slice(0, 200));
            const type = res.headers.get('content-type') || '';
            let msg = null;
            if (type.includes('text/event-stream')) {
                msg = parseSse(text).find((m) => m && m.id === id) || null;
            } else {
                msg = extractJson(text);
            }
            if (!msg) throw new GameOfflineError(method + ' returned an unreadable reply');
            if (msg.error) {
                if (/session/i.test(msg.error.message || '') && attempt === 0) {
                    this.reset();
                    continue;
                }
                throw new GameToolError(method, msg.error.message || JSON.stringify(msg.error));
            }
            return msg.result;
        }
        throw new GameOfflineError(method + ': session could not be re-established');
    }

    async listTools() {
        if (this.tools) return this.tools;
        const result = await this.rpc('tools/list', {});
        this.tools = new Set((result.tools || []).map((t) => t.name));
        this.toolSchemas = new Map((result.tools || []).map((t) => [t.name, t.inputSchema || null]));
        return this.tools;
    }

    // The input schema the game lists for a tool, or null.
    async schemaOf(tool) {
        try {
            await this.listTools();
        } catch (e) {
            return null;
        }
        return (this.toolSchemas && this.toolSchemas.get(tool)) || null;
    }

    async has(tool) {
        try {
            const tools = await this.listTools();
            return tools.has(tool);
        } catch (e) {
            return false;
        }
    }

    // Calls a game tool and returns its payload. Throws GameToolError on tool failure and
    // GameOfflineError when the game is not running.
    call(tool, args, timeoutMs) {
        return this.gate.run(async () => {
            const result = await this.rpc('tools/call', { name: tool, arguments: args || {} }, timeoutMs);
            const parts = (result && result.content) || [];
            const text = parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
            if (result && result.isError) throw new GameToolError(tool, text || 'failed');
            return unwrapPayload(tool, text);
        });
    }

    // Same as call() but resolves to null instead of throwing for tool-level failures.
    // Offline errors still propagate so callers can tell "game closed" from "no data".
    async soft(tool, args, timeoutMs) {
        try {
            return await this.call(tool, args, timeoutMs);
        } catch (e) {
            if (e instanceof GameOfflineError) throw e;
            if (this.log) this.log.debug('soft ' + tool + ' failed: ' + e.message);
            return null;
        }
    }
}

// Why the game cannot be asked anything yet: 'offline' (not running, or not answering),
// 'no_save' (running, but no household is being played: the main menu, a load screen), or ''
// for a real error.
const NO_SAVE_RE = /No possessed character|no household/i;
function notReady(e) {
    if (e instanceof GameOfflineError) return 'offline';
    if (e instanceof GameToolError && NO_SAVE_RE.test(e.message)) return 'no_save';
    return '';
}

module.exports = { GameClient, GameOfflineError, GameToolError, extractJson, notReady };
