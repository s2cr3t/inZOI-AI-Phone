'use strict';
// Stdio MCP for the inZOI phone mailbox, used from Cursor. In "auto" mode the bridge service
// answers by itself and these tools are for inspection and manual override; in "cursor" mode
// the agent answers through sms_reply. stdout is reserved for JSON-RPC, logs go to stderr.
const config = require('./lib/config');
const fsx = require('./lib/fsx');
const { Mailbox, parseKey } = require('./lib/mailbox');
const { PID_FILE } = require('./lib/daemon');

function log(message) {
    process.stderr.write('[inzoi-sms] ' + message + '\n');
}

function mailbox() {
    const c = config.load().config;
    return { cfg: c, mb: new Mailbox({ dir: c.mailbox.dir, keep: c.mailbox.keep, textMax: c.mailbox.text_max }) };
}

function lastActivity(mb, key) {
    const t = mb.thread(key);
    return t && t.messages.length ? t.messages[t.messages.length - 1].at : 0;
}

function numericArg(value, name) {
    if (value === undefined || value === null || String(value) === '') return null;
    const id = String(value);
    if (!/^\d+$/.test(id)) throw new Error(name + ' must be a numeric entity id');
    return id;
}

// Threads matching the arguments: an explicit thread key, or every thread of a contact / player.
function matchThreads(mb, args) {
    if (args.thread !== undefined && args.thread !== null && String(args.thread) !== '') return [parseKey(String(args.thread)).key];
    const contact = numericArg(args.contact_id, 'contact_id');
    const player = numericArg(args.player_id, 'player_id');
    return mb.threads()
        .filter((t) => (!contact || t.contactId === contact) && (!player || t.playerId === player))
        .map((t) => t.key);
}

// The matching thread with the most recent activity.
function pickThread(mb, args) {
    let best = null;
    let bestAt = -1;
    for (const key of matchThreads(mb, args)) {
        const last = lastActivity(mb, key);
        if (last > bestAt) {
            best = key;
            bestAt = last;
        }
    }
    if (!best) throw new Error('no matching phone thread; open the Texts app in game first (threads: ' + mb.threads().map((t) => t.key).join(', ') + ')');
    return best;
}

function threadView(mb, key) {
    const t = mb.thread(key);
    if (!t) return { ok: false, error: 'mailbox is being written, try again' };
    const s = mb.readStatus(key) || {};
    return {
        ok: true,
        thread: key,
        player_id: t.playerId,
        contact_id: t.contactId,
        contact_name: s.partnerName || null,
        role: s.role || null,
        bridge_state: s.state || null,
        pending: t.pending.map((m) => ({ id: m.id, text: m.text, at: m.at })),
        messages: t.messages.slice(-60).map((m) => ({ side: m.side === 'player' ? 'player' : 'contact', id: m.id, text: m.text, at: m.at, kind: m.kind }))
    };
}

function waitForText(mb, args, timeoutSec) {
    const limit = Math.min(Math.max(Number(timeoutSec) || 30, 1), 180);
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + limit * 1000;
        const poll = () => {
            let keys;
            try { keys = matchThreads(mb, args); } catch (e) { reject(e); return; }
            for (const key of keys) {
                const t = mb.thread(key);
                if (t && t.pending.length) {
                    const s = mb.readStatus(key) || {};
                    resolve({ pending: true, thread: key, contact_name: s.partnerName || null, messages: t.pending.map((m) => ({ id: m.id, text: m.text, at: m.at })) });
                    return;
                }
            }
            if (Date.now() >= deadline) {
                resolve({ pending: false, messages: [] });
                return;
            }
            setTimeout(poll, 200);
        };
        poll();
    });
}

function statusView() {
    const { cfg, mb } = mailbox();
    const r = fsx.readJson(PID_FILE);
    const pid = r.ok && r.value ? r.value : null;
    const running = !!(pid && fsx.isProcessAlive(pid.pid));
    return {
        bridge_running: running,
        bridge_pid: running ? pid.pid : null,
        mode: cfg.mode,
        model: cfg.llm.model,
        threads: mb.threads().map((th) => {
            const s = mb.readStatus(th.key) || {};
            const t = mb.thread(th.key);
            return {
                thread: th.key,
                contact_name: s.partnerName || null,
                role: s.role || null,
                state: s.state || null,
                error: s.error || null,
                heartbeat_age_s: s.heartbeat ? Math.round((Date.now() - s.heartbeat) / 1000) : null,
                pending: t ? t.pending.length : null
            };
        })
    };
}

const THREAD_ARGS = {
    thread: { type: 'string', description: 'Conversation key "<playerId>-<contactId>" as returned by sms_status / sms_wait.' },
    contact_id: { type: 'string', description: 'Entity id of the household member being texted. Used when thread is omitted.' },
    player_id: { type: 'string', description: 'Entity id of the phone owner (the played character). Used when thread is omitted.' }
};

const TOOLS = [
    {
        name: 'sms_thread',
        description: 'Read one inZOI phone conversation between the played character and a household member (spouse, child, parent...): both sides of the chat plus the texts still waiting for an answer. Default: the most recently active matching conversation.',
        inputSchema: { type: 'object', properties: THREAD_ARGS, additionalProperties: false }
    },
    {
        name: 'sms_wait',
        description: 'Wait until any (or the matching) phone conversation has an unanswered text, or until timeout_seconds. Returns immediately if one is already waiting.',
        inputSchema: {
            type: 'object',
            properties: Object.assign({
                timeout_seconds: { type: 'integer', minimum: 1, maximum: 180, description: 'How long to wait. Default 30.' }
            }, THREAD_ARGS),
            additionalProperties: false
        }
    },
    {
        name: 'sms_reply',
        description: 'Send one text from the household member (the contact of the conversation) to the played character\'s phone. It appears in the Texts app within a few seconds and marks the waiting texts as answered.',
        inputSchema: {
            type: 'object',
            properties: Object.assign({
                text: { type: 'string', description: 'The reply, at most 400 characters.' }
            }, THREAD_ARGS),
            required: ['text'],
            additionalProperties: false
        }
    },
    {
        name: 'sms_status',
        description: 'Show whether the automatic AI bridge is running, its mode (auto/cursor/off), and the presence/error state of every phone thread.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }
];

function send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}

function ok(id, value) {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
}

function fail(id, message) {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } });
}

async function callTool(name, args) {
    const { mb } = mailbox();
    if (name === 'sms_thread') return threadView(mb, pickThread(mb, args));
    if (name === 'sms_wait') return waitForText(mb, args, args.timeout_seconds);
    if (name === 'sms_reply') {
        const key = pickThread(mb, args);
        const t = mb.thread(key);
        if (!t) throw new Error('mailbox is being written, try again');
        const reAt = t.outbox.reduce((max, m) => Math.max(max, m.at), 0);
        return { sent: mb.append(key, args.text, reAt, 'manual'), thread: key };
    }
    if (name === 'sms_status') return statusView();
    throw new Error('Unknown tool: ' + name);
}

async function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id === undefined || msg.id === null) return;
    try {
        if (msg.method === 'initialize') {
            const requested = msg.params && msg.params.protocolVersion;
            send({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                    protocolVersion: requested || '2024-11-05',
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'inzoi-sms', version: '2.1.0' }
                }
            });
            return;
        }
        if (msg.method === 'ping') {
            send({ jsonrpc: '2.0', id: msg.id, result: {} });
            return;
        }
        if (msg.method === 'tools/list') {
            send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
            return;
        }
        if (msg.method === 'tools/call') {
            const name = msg.params && msg.params.name;
            const args = (msg.params && msg.params.arguments) || {};
            ok(msg.id, await callTool(name, args));
            return;
        }
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
    } catch (e) {
        fail(msg.id, e && e.message ? e.message : String(e));
    }
}

let buffer = '';
function pump() {
    while (buffer.length) {
        if (buffer.startsWith('Content-Length:')) {
            const sep = buffer.indexOf('\r\n\r\n');
            if (sep < 0) return;
            const match = /Content-Length:\s*(\d+)/i.exec(buffer.slice(0, sep));
            if (!match) {
                buffer = buffer.slice(sep + 4);
                continue;
            }
            const start = sep + 4;
            const length = Number(match[1]);
            if (Buffer.byteLength(buffer.slice(start)) < length) return;
            const body = Buffer.from(buffer.slice(start)).subarray(0, length).toString('utf8');
            buffer = buffer.slice(start + body.length);
            try { handle(JSON.parse(body)); } catch (e) { log('bad frame: ' + e.message); }
            continue;
        }
        const lead = buffer.charCodeAt(0);
        if (lead === 10 || lead === 13) {
            buffer = buffer.slice(1);
            continue;
        }
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl).replace(/\r$/, '').trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch (e) { log('bad line: ' + e.message); }
    }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    pump();
});
process.stdin.on('end', () => process.exit(0));
log('ready, mailbox ' + mailbox().cfg.mailbox.dir);
