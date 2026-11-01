#!/usr/bin/env node
'use strict';
// inZOI SMS bridge command line.
//   node bridge.js run [--force]     run in this console (Ctrl+C to stop)
//   node bridge.js start             start hidden in the background
//   node bridge.js stop              ask the running bridge to stop
//   node bridge.js restart           stop, then start hidden
//   node bridge.js set-key           store the LLM API key in secrets.json (hidden input)
//   node bridge.js doctor            check config, AI key, game connection and mailbox
//   node bridge.js diagnose          save logs and settings, keys removed, as a zip to send with a report
//   node bridge.js status            show bridge process and per-conversation presence
//   node bridge.js contacts          list who the played character can text, with roles
//   node bridge.js preview <contactId> [text]   print the prompt the AI would get (no AI call)
//   node bridge.js stories [new <contactId> | reset <contactId>]   each contact's story line (spoilers)
//   node bridge.js legacy           family members seen growing up, and the life records of those who died
//   node bridge.js ties             how the household feel about each other, and the grudges they hold
//   node bridge.js autostart on|off  start the guardian hidden at Windows logon
//   node bridge.js guardian start|stop|status   the resident guardian the phone's AI app controls
//   node bridge.js simulate <text> [--thread <playerId-contactId> | --contact <id>]   test only: inject a phone text
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./lib/config');
const fsx = require('./lib/fsx');
const { Logger } = require('./lib/log');
const { Daemon, AlreadyRunningError, PID_FILE, STOP_FILE, VERSION, SITE_MEMORY_FILE, RESTART_EXIT_CODE } = require('./lib/daemon');
const { SiteMemory } = require('./lib/sitememory');
const { GameClient } = require('./lib/game');
const { World, fullName } = require('./lib/world');
const { DEFAULT_FILE: LUA_LOG, parseAgeReport } = require('./lib/journal');
const { Aging } = require('./lib/aging');
const { Mailbox, threadKey, parseKey } = require('./lib/mailbox');
const { LlmClient } = require('./lib/llm');
const { Actions } = require('./lib/actions');
const { MemoryStore, Diary } = require('./lib/memory');
const persona = require('./lib/persona');
const paths = require('./lib/paths');
const winsec = require('./lib/winsec');
const guardian = require('./lib/guardian');

const ROLE_TEXT = { spouse: 'spouse', child: 'child', parent: 'parent', family: 'family' };

const SCRIPT = __filename;
const SUPERVISOR = path.join(__dirname, 'supervisor.js');
const STARTUP_FILE = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'inzoi-sms-bridge.vbs');

function out(line) { process.stdout.write(line + '\n'); }

function runningPid() {
    const r = fsx.readJson(PID_FILE);
    if (r.ok && r.value && r.value.pid && fsx.isProcessAlive(r.value.pid)) return r.value;
    return null;
}

async function cmdRun(args) {
    const cfg = config.load().config;
    const log = new Logger({ dir: config.LOG_DIR, level: cfg.log.level, retainDays: cfg.log.retain_days });
    const daemon = new Daemon(log);
    if (process.env.INZOI_PHONE_GUARDED !== '1') {
        // Without the guardian nobody else would start the service again after a household switch.
        daemon.onRestart = (code) => {
            if (code === RESTART_EXIT_CODE) {
                const child = spawn(process.execPath, [SCRIPT, 'run'], { cwd: config.ROOT, detached: true, stdio: 'ignore', windowsHide: true });
                child.unref();
                log.info('started again in the background (pid ' + child.pid + ') on the files of the household now played');
                out('household changed; the bridge continues in the background (pid ' + child.pid + ')');
            }
            process.exit(code === RESTART_EXIT_CODE ? 0 : code);
        };
    }
    const shutdown = (signal) => {
        log.info('received ' + signal);
        daemon.stop().then(() => process.exit(0));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGBREAK', () => shutdown('SIGBREAK'));
    process.on('uncaughtException', (e) => log.error('uncaught: ' + (e && e.stack || e)));
    process.on('unhandledRejection', (e) => log.error('unhandled rejection: ' + (e && e.stack || e)));
    try {
        await daemon.start({ force: args.indexOf('--force') >= 0 });
    } catch (e) {
        if (e instanceof AlreadyRunningError) {
            log.error(e.message);
            process.exit(2);
        }
        throw e;
    }
}

function cmdStart() {
    const running = runningPid();
    if (running) {
        out('bridge already running (pid ' + running.pid + ')');
        return;
    }
    const child = spawn(process.execPath, [SCRIPT, 'run'], {
        cwd: config.ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    });
    child.unref();
    out('bridge starting in the background (pid ' + child.pid + '); logs in ' + config.LOG_DIR);
}

async function cmdStop() {
    const running = runningPid();
    if (!running) {
        out('bridge is not running');
        return true;
    }
    fsx.writeAtomic(STOP_FILE, String(Date.now()));
    for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (!fsx.isProcessAlive(running.pid)) {
            out('bridge stopped (pid ' + running.pid + ')');
            return true;
        }
    }
    try {
        process.kill(running.pid);
        out('bridge did not stop in time; terminated pid ' + running.pid);
    } catch (e) {
        out('could not stop pid ' + running.pid + ': ' + e.message);
        return false;
    }
    try { fs.unlinkSync(STOP_FILE); } catch (e) { /* ignore */ }
    return true;
}

function readHidden(prompt) {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        if (!stdin.isTTY) {
            let data = '';
            stdin.setEncoding('utf8');
            stdin.on('data', (c) => { data += c; });
            stdin.on('end', () => resolve(data.trim()));
            stdin.on('error', reject);
            return;
        }
        process.stdout.write(prompt);
        let value = '';
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        const onData = (chunk) => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.removeListener('data', onData);
                    process.stdout.write('\n');
                    resolve(value.trim());
                    return;
                }
                if (ch === '\u0003') {
                    stdin.setRawMode(false);
                    process.stdout.write('\n');
                    reject(new Error('cancelled'));
                    return;
                }
                if (ch === '\b' || ch === '\u007f') {
                    if (value.length) {
                        value = value.slice(0, -1);
                        process.stdout.write('\b \b');
                    }
                    continue;
                }
                if (ch >= ' ') {
                    value += ch;
                    process.stdout.write('*');
                }
            }
        };
        stdin.on('data', onData);
    });
}

async function cmdSetKey() {
    const info = config.load();
    const key = await readHidden('Paste the ' + info.config.llm.provider + ' API key and press Enter: ');
    if (!key) {
        out('no key entered, nothing changed');
        return 1;
    }
    if (/\s/.test(key) || key.length < 16) {
        out('that does not look like an API key (too short or contains spaces), nothing changed');
        return 1;
    }
    const how = config.saveApiKey(key, info.config.llm.provider);
    out('saved to ' + config.SECRETS_FILE + ' (' + how + ')');
    const llm = new LlmClient(Object.assign({}, info.config.llm, { apiKey: key, max_retries: 0, quirks_file: path.join(config.DATA_DIR, 'llm-quirks.json') }));
    process.stdout.write('testing the key against ' + info.config.llm.base_url + ' ... ');
    try {
        const r = await llm.ping();
        out('OK (' + r.latencyMs + ' ms)');
    } catch (e) {
        out('FAILED: ' + (e.kind ? e.kind + ' - ' : '') + e.message);
        return 1;
    }
    out('a running bridge picks the new key up automatically');
    return 0;
}

function mark(ok) { return ok ? '[ OK ]' : '[FAIL]'; }

async function cmdDoctor() {
    let failures = 0;
    const check = (ok, label, detail) => {
        if (!ok) failures += 1;
        out(mark(ok) + ' ' + label + (detail ? ': ' + detail : ''));
    };
    const major = Number(process.versions.node.split('.')[0]);
    check(major >= 18, 'Node.js ' + process.versions.node, major >= 18 ? '' : 'Node 18 or newer is required');
    const info = config.load();
    check(!info.problems.length, 'config ' + config.CONFIG_FILE, info.problems.join('; '));
    out('       mode=' + info.config.mode + ', model=' + info.config.llm.model + ', thinking=' + info.config.llm.thinking + ', endpoint=' + info.config.llm.base_url);
    out('       data folder ' + config.HOME + (paths.INSTALLED ? ' (installed)' : ' (development copy)'));
    check(winsec.available(), 'helper ' + paths.HELPER, winsec.available() ? 'keys are encrypted for this Windows user' : 'missing -- keys are stored as plain text');
    check(!!info.apiKey, 'API key (' + info.config.llm.provider + ')', info.apiKey ? info.apiKeyHint + ' from ' + info.apiKeySource : 'missing -- add it in the phone\'s AI app or run: node bridge.js set-key');
    if (info.apiKey) {
        const llm = new LlmClient(Object.assign({}, info.config.llm, { apiKey: info.apiKey, max_retries: 0, quirks_file: path.join(config.DATA_DIR, 'llm-quirks.json') }));
        try {
            const r = await llm.ping();
            check(true, 'AI request', r.latencyMs + ' ms');
        } catch (e) {
            check(false, 'AI request', e.kind + ' - ' + e.message);
        }
    }
    const game = new GameClient({ url: info.config.game.url, timeoutMs: 8000 });
    const world = new World(game, null);
    try {
        const phase = await world.phase();
        check(phase === 'in_game', 'game connection', 'phase ' + phase);
        if (phase === 'in_game') {
            const pid = await world.possessed();
            const hh = await world.household();
            const me = hh.members.find((m) => String(m.entity_id) === String(pid));
            const contacts = await world.contacts(pid);
            check(contacts.length > 0, 'contacts of ' + (me ? fullName(me) : '#' + pid) + ' (' + pid + ')',
                contacts.length ? contacts.map((c) => fullName(c.member) + ' (' + c.member.entity_id + ', ' + ROLE_TEXT[c.role] + ')').join(', ')
                    : 'nobody in the household is old enough to text');
        }
    } catch (e) {
        check(false, 'game connection', e.message);
    }
    const dir = info.config.mailbox.dir;
    try {
        fsx.ensureDir(dir);
        const probe = path.join(dir, '.write-test.tmp');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        check(true, 'mailbox ' + dir, new Mailbox({ dir }).threads().map((t) => t.key).join(', ') || 'no threads yet');
    } catch (e) {
        check(false, 'mailbox ' + dir, e.message);
    }
    for (const id of [paths.PHONE_MOD_ID, paths.JOURNAL_MOD_ID]) {
        const m = paths.modCopies(id);
        check(m.copies.length === 1, 'mod ' + id, m.copies.length === 0 ? 'not found under Documents\\inZOI\\Mods'
            : m.copies.length === 1 ? m.dir : 'installed ' + m.copies.length + ' times; using ' + m.dir + ' because ' + m.reason);
        if (m.copies.length > 1) for (const d of m.copies) out('       ' + (d === m.dir ? '* ' : '  ') + d);
    }
    const running = runningPid();
    check(!!running, 'bridge process', running ? 'pid ' + running.pid + ', v' + running.version : 'not running -- run: node bridge.js start');
    const g = guardian.Guardian.runningPid();
    out('       guardian: ' + (g ? 'running, pid ' + g : 'not running') + ', autostart: ' + autostartText());
    out(failures ? failures + ' problem(s) found' : 'all checks passed');
    return failures ? 1 : 0;
}

async function cmdDiagnose() {
    const r = await require('./lib/diagnostics').build({});
    if (!r.ok) {
        out(r.message);
        return 1;
    }
    out('diagnostics saved: ' + r.file + ' (' + r.bytes + ' bytes)');
    out('API keys are removed. The logs contain the household chat messages.');
    return 0;
}

function cmdStatus() {
    const info = config.load();
    const running = runningPid();
    out('bridge ' + VERSION + ': ' + (running ? 'running, pid ' + running.pid + ' since ' + new Date(running.startedAt).toLocaleString() : 'not running'));
    const g = guardian.Guardian.runningPid();
    out('guardian: ' + (g ? 'running, pid ' + g : 'not running') + ', AI ' + (guardianEnabled() ? 'on' : 'off') + ' on the phone');
    out('mode ' + info.config.mode + ', provider ' + info.config.llm.provider + ', model ' + info.config.llm.model + ', thinking ' + info.config.llm.thinking +
        ', key ' + (info.apiKey ? 'set (' + info.apiKeyHint + ')' : 'MISSING') + ', autostart ' + autostartText());
    const mb = new Mailbox({ dir: info.config.mailbox.dir });
    for (const th of mb.threads()) {
        const s = mb.readStatus(th.key) || {};
        const t = mb.thread(th.key);
        const age = s.heartbeat ? Math.round((Date.now() - s.heartbeat) / 1000) + 's ago' : 'never';
        out('  thread ' + th.key + (s.partnerName ? ' (' + s.partnerName + (s.role ? ', ' + s.role : '') + ')' : '') +
            ': state=' + (s.state || '-') + (s.error ? ' (' + s.error + ')' : '') + ', heartbeat ' + age +
            (t ? ', ' + t.outbox.length + ' sent / ' + t.inbox.length + ' received, ' + t.pending.length + ' pending' : ''));
    }
    const momentsDir = path.join(path.dirname(info.config.mailbox.dir), 'moments');
    const feed = fsx.readJson(path.join(momentsDir, 'feed.cfg'));
    const ms = fsx.readJson(path.join(config.DATA_DIR, 'moments-state.json'));
    const f = feed.ok && feed.value ? feed.value : {};
    const st = ms.ok && ms.value ? ms.value : {};
    const posts = Array.isArray(f.posts) ? f.posts : [];
    const next = st.nextPostAt ? Math.round((st.nextPostAt - Date.now()) / 60000) : null;
    out('  moments: ' + (info.config.moments.enabled ? 'on' : 'off') + ', ' + posts.length + ' post(s), ' +
        (Array.isArray(st.queue) ? st.queue.length : 0) + ' scheduled reaction(s), ' + (Array.isArray(st.tasks) ? st.tasks.length : 0) + ' pending task(s)' +
        (next !== null ? ', next post check ' + (next > 0 ? 'in ' + next + ' min' : 'now') : ''));
    for (const id of Object.keys(f.circles || {})) {
        const c = f.circles[id];
        out('    circle of ' + ((c.names && c.names[id]) || id) + ': ' + (c.ids || []).map((x) => (c.names && c.names[x]) || x).join(', '));
    }
}

async function liveWorld() {
    const info = config.load();
    const game = new GameClient({ url: info.config.game.url, timeoutMs: 15000 });
    const world = new World(game, null);
    world.aging = agingFromLog();
    const phase = await world.phase();
    if (phase !== 'in_game') throw new Error('the game is not in a loaded save (phase ' + phase + ')');
    return { info, game, world };
}

// Ages are not a tool the bridge can ask for: the HouseholdJournal mod prints them (lib/aging.js)
// and the reply service has them pushed at it as it runs. A one-shot command builds its own World,
// so it reads the last line the mod printed instead — otherwise `preview` would show a prompt with
// no ages in it while the phone's AI is being told them. Missing log, or no age line yet: no ages,
// and the prompt simply has no age block.
function agingFromLog() {
    const aging = new Aging({});
    aging.configure(config.DATA_DIR);
    const tag = '[HouseholdJournal] A ';
    let text = '';
    try {
        const size = fs.statSync(LUA_LOG).size;
        const start = Math.max(0, size - 262144);
        const fd = fs.openSync(LUA_LOG, 'r');
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        text = buf.toString('utf8');
    } catch (_) { return aging; }
    const at = text.lastIndexOf(tag);
    if (at < 0) return aging;
    const entries = parseAgeReport(text.slice(at + tag.length).split('\n')[0].trim());
    if (entries.length) aging.setReport(entries);
    return aging;
}

async function cmdContacts() {
    const { world } = await liveWorld();
    const pid = await world.possessed();
    const hh = await world.household();
    const me = hh.members.find((m) => String(m.entity_id) === String(pid));
    out('played character: ' + (me ? fullName(me) : '#' + pid) + ' (' + pid + ')');
    const contacts = await world.contacts(pid);
    if (!contacts.length) out('  nobody in the household is old enough to text');
    for (const c of contacts) {
        const m = c.member;
        out('  ' + m.entity_id + '  ' + fullName(m) + '  role=' + ROLE_TEXT[c.role] + '  ' + (m.relationship_label || '') +
            '  ' + (m.age_group || '') + '  @' + (m.current_site || '?') + '  thread ' + threadKey(pid, m.entity_id));
    }
    return 0;
}

// --ask also sends the prompt to the AI and prints its answer (nothing is kept or sent to the
// phone); --ties <dir> reads ties.json from <dir> instead of the data folder, to try a situation.
async function cmdPreview(args) {
    const ask = args.indexOf('--ask') >= 0;
    if (ask) args.splice(args.indexOf('--ask'), 1);
    const tiesDir = takeOption(args, '--ties');
    const knowhowDir = takeOption(args, '--knowhow');
    const contactId = args[0];
    if (!contactId || !/^\d+$/.test(contactId)) {
        out('usage: node bridge.js preview <contactId> [text] [--ask] [--ties <dir>] [--knowhow <dir>]   (ids: node bridge.js contacts)');
        return 1;
    }
    const sample = args.slice(1).join(' ').trim() || '在干嘛呀？';
    const { info, game, world } = await liveWorld();
    const cfg = info.config;
    const pid = await world.possessed();
    const pair = await world.pair(pid, contactId);
    const snap = await world.snapshot(pair);
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    const siteMemory = new SiteMemory(SITE_MEMORY_FILE, quiet, { readOnly: true });
    const actions = new Actions(game, world, quiet, siteMemory);
    // Someone outside the household gets no actions here (the reply service allows a few only
    // when they are with the played character).
    const catalog = await actions.catalog(pair, snap, pair.outsider ? Object.assign({}, cfg.actions, { enabled: false, allowed: [] }) : cfg.actions);
    if (pair.outsider) out('(outside the household: ' + pair.role + ', chat only in this preview)');
    const memory = new MemoryStore(config.DATA_DIR, cfg.memory).load(pair.playerId, pair.partnerId);
    const diary = snap.env ? new Diary(config.DATA_DIR, cfg.tracker.diary_keep).today(pair.partnerId, snap.env.day) : [];
    const mb = new Mailbox({ dir: cfg.mailbox.dir, keep: cfg.mailbox.keep, textMax: cfg.mailbox.text_max });
    const thread = mb.thread(pair.key) || { messages: [] };
    const now = Date.now();
    const pending = [{ id: 'preview', text: sample, at: now }];
    // The contact's story line, as the reply service adds it (read only).
    const { Stories } = require('./lib/stories');
    const stories = new Stories({ cfg, log: quiet, memory: new MemoryStore(config.DATA_DIR, cfg.memory), llm: null });
    stories.configure(config.DATA_DIR);
    snap.storyBlock = stories.block(pair, snap);
    snap.storyRule = stories.rule(pair);
    const { Ties } = require('./lib/ties');
    const ties = new Ties({ cfg, log: quiet });
    ties.configure(tiesDir ? path.resolve(tiesDir) : config.DATA_DIR);
    snap.tiesBlock = ties.block(pair, { env: snap.env, call: persona.terms(snap).call }, new Map(pair.members.map((m) => [String(m.entity_id), fullName(m)])));
    snap.tiesRule = ties.rule(pair);
    // What the contact knows how to do, as the reply service adds it (read only).
    const { KnowHow, replayable } = require('./lib/knowhow');
    const knowhow = new KnowHow(knowhowDir ? path.resolve(knowhowDir) : config.DATA_DIR, quiet);
    snap.knowhow = knowhow.load(pair.partnerId);
    snap.skills = snap.knowhow.filter(replayable).slice(0, 24);
    snap.knowhowWrong = knowhow.wrong(pair.partnerId);
    const history = thread.messages.filter((m) => m.at > memory.summarizedUpTo).slice(-cfg.reply.history_messages);
    const prompt = persona.replyPrompt({ snap, cfg, memory, diary, catalog, history, pending, now });
    if (ask) {
        const llm = new LlmClient(Object.assign({}, cfg.llm, { apiKey: info.apiKey, quirks_file: path.join(config.DATA_DIR, 'llm-quirks.json') }));
        const r = await llm.json(prompt.system, prompt.user, { purpose: 'preview' });
        out('=== ' + fullName(pair.partner) + ' would answer "' + sample + '" (not sent) ===');
        out('think: ' + (r && r.think));
        for (const m of (r && r.messages) || []) out('  > ' + m);
        for (const a of (r && r.actions) || []) out('  action: ' + JSON.stringify(a));
        out('learned: ' + JSON.stringify(r && r.learned) + '  unlearn: ' + JSON.stringify(r && r.unlearn));
        out('felt: ' + JSON.stringify(r && r.felt) + '  ties: ' + JSON.stringify(r && r.ties) + '  story: ' + JSON.stringify(r && r.story));
        return 0;
    }
    out('=== ' + fullName(pair.player) + ' -> ' + fullName(pair.partner) + ' (role ' + pair.role + ', thread ' + pair.key + ') ===');
    out('--- system ---');
    out(prompt.system);
    out('--- user ---');
    out(prompt.user);
    return 0;
}

// The story lines (lib/stories.js), with their hidden truth: for the person running the mod.
// new <contactId> makes one now for the played character's chat with that contact; reset drops it.
async function cmdStories(args) {
    const { Stories } = require('./lib/stories');
    const info = config.load();
    const quiet = { debug() {}, info: (m) => out('  ' + m), warn: (m) => out('  ! ' + m), error: (m) => out('  ! ' + m) };
    const d = { cfg: info.config, log: quiet, memory: new MemoryStore(config.DATA_DIR, info.config.memory), llm: null };
    const stories = new Stories(d);
    stories.configure(config.DATA_DIR);
    const op = args[0];
    if (op === 'new' || op === 'reset') {
        const contactId = args[1];
        if (!contactId || !/^\d+$/.test(contactId)) {
            out('usage: node bridge.js stories ' + op + ' <contactId>   (ids: node bridge.js contacts)');
            return 1;
        }
        const { world } = await liveWorld();
        const pid = await world.possessed();
        const pair = await world.pair(pid, contactId);
        if (op === 'reset') {
            try { fs.unlinkSync(stories.file(pair.key)); out('story of ' + pair.key + ' removed; a new one starts at the next reply'); } catch (e) { out('no story file for ' + pair.key); }
            return 0;
        }
        d.llm = new LlmClient(Object.assign({}, info.config.llm, { apiKey: info.apiKey, quirks_file: path.join(config.DATA_DIR, 'llm-quirks.json') }));
        if (!d.llm.configured) {
            out('no AI key; run node bridge.js set-key first');
            return 1;
        }
        const snap = await world.snapshot(pair);
        const s = stories.load(pair.key);
        s.active = null;
        s.nextFrom = null;
        stories.save(pair.key, s);
        await stories.make(pair, snap, stories.load(pair.key), typeof snap.env.day === 'number' ? snap.env.day : null);
    }
    const list = stories.all();
    if (!list.length) out('no stories yet; one starts at the next reply in each chat (stories.enabled is ' + info.config.stories.enabled + ')');
    for (const s of list) {
        out('chat ' + s.key + (s.nextFrom !== null ? ', next story from day ' + s.nextFrom : ''));
        const a = s.active;
        if (a) {
            out('  NOW 「' + a.title + '」 (' + a.kind + '), stage ' + (a.stage + 1) + '/' + a.beats.length + ', day ' + a.startedDay + ' to ' + a.endsBy);
            out('    truth: ' + a.premise);
            if (a.want) out('    wants: ' + a.want);
            a.beats.forEach((b, i) => out('    ' + (i === a.stage ? '>' : ' ') + (i + 1) + '. shows: ' + b.show + '  | moves on when: ' + b.next));
            out('    good: ' + a.good);
            out('    bad:  ' + a.bad);
            for (const l of a.log) out('    day ' + l.day + ' (' + l.how + '): ' + l.text);
        }
        for (const e of s.ended.slice(-3)) out('  ended 「' + e.title + '」 ' + (e.good ? 'well' : 'badly') + ' on day ' + e.endedDay + ' (' + e.how + '): ' + e.outcome);
    }
    return 0;
}

function cmdLegacy() {
    const r = fsx.readJson(path.join(config.DATA_DIR, 'legacy.json'));
    const v = r.ok && r.value ? r.value : { people: {}, departed: [] };
    const people = v.people || {};
    const ids = Object.keys(people);
    out(ids.length ? 'family members seen: ' + ids.length : 'nobody seen yet; the reply service records the household as it runs');
    for (const id of ids) {
        const p = people[id];
        const grew = (p.grew || []).map((g) => (g.from || '?') + '->' + g.to + (g.day !== null ? ' (day ' + g.day + ')' : '')).join(', ');
        out('  ' + id + '  ' + (p.name || '?') + '  ' + (p.ageGroup || '?') + (grew ? '  grew: ' + grew : ''));
    }
    for (const d of v.departed || []) {
        out('died: ' + d.name + (d.day !== null ? ' on day ' + d.day : '') + (d.reason ? ' (' + d.reason + ')' : '') + (d.ghost ? ', became a ghost' : ''));
        if (d.life) out('  life: ' + d.life);
        for (const k of d.knownFor || []) out('  known for: ' + k);
        for (const m of d.moments || []) out('  moment: ' + m);
        if (d.keepsake) out('  keepsake: ' + d.keepsake);
    }
    return 0;
}

function cmdTies() {
    const { Ties } = require('./lib/ties');
    const info = config.load();
    const ties = new Ties({ cfg: info.config, log: { debug() {}, info() {}, warn() {} } });
    ties.configure(config.DATA_DIR);
    const lr = fsx.readJson(path.join(config.DATA_DIR, 'legacy.json'));
    const people = lr.ok && lr.value && lr.value.people ? lr.value.people : {};
    const names = new Map(Object.keys(people).map((id) => [id, people[id].name || id]));
    const list = ties.report(names);
    if (!list.length) out('nothing yet: warmth and grudges build up from what happens in the game and in the chats');
    for (const t of list) {
        out(t.holder + ' -> ' + t.target + ': warmth ' + (t.warmth > 0 ? '+' : '') + t.warmth);
        for (const g of t.grudges) out('  ' + g.id + ' weight ' + g.weight + ' (' + g.source + (typeof g.day === 'number' ? ', day ' + g.day : '') + '): ' + g.about);
    }
    return 0;
}

function vbsString(s) {
    return '"' + String(s).replace(/"/g, '""') + '"';
}

function autostartText() {
    if (paths.INSTALLED) return 'set up by the installer';
    return fs.existsSync(STARTUP_FILE) ? 'on' : 'off';
}

function guardianEnabled() {
    const r = fsx.readJson(guardian.STATE_FILE);
    return !(r.ok && r.value && r.value.enabled === false);
}

function cmdAutostart(arg) {
    if (paths.INSTALLED && (arg === 'on' || arg === 'off')) {
        out('this copy was installed; Windows starts it at logon through the installer\'s entry. Uninstall inZOI AI Phone to remove it.');
        return;
    }
    if (arg === 'on') {
        const command = '"' + process.execPath + '" "' + SUPERVISOR + '"';
        const vbs = [
            "' Starts the inZOI AI Phone guardian hidden at logon. Remove with: node bridge.js autostart off",
            'Set sh = CreateObject("WScript.Shell")',
            'sh.CurrentDirectory = ' + vbsString(config.ROOT),
            'sh.Run ' + vbsString(command) + ', 0, False',
            ''
        ].join('\r\n');
        fsx.writeAtomic(STARTUP_FILE, vbs);
        out('autostart on: ' + STARTUP_FILE);
    } else if (arg === 'off') {
        try {
            fs.unlinkSync(STARTUP_FILE);
            out('autostart off');
        } catch (e) {
            out(e.code === 'ENOENT' ? 'autostart was already off' : 'could not remove ' + STARTUP_FILE + ': ' + e.message);
        }
    } else {
        out('autostart is ' + autostartText() + '. Use: node bridge.js autostart on|off');
    }
}

async function cmdGuardian(arg) {
    const pid = guardian.Guardian.runningPid();
    if (arg === 'start') {
        if (pid) {
            out('guardian already running (pid ' + pid + ')');
            return 0;
        }
        const child = spawn(process.execPath, [SUPERVISOR], { cwd: config.ROOT, detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        out('guardian starting in the background (pid ' + child.pid + '); logs in ' + config.LOG_DIR);
        return 0;
    }
    if (arg === 'stop') {
        const r = await guardian.stopRunning(25000);
        if (!r.running) out('guardian is not running');
        else out(r.stopped ? 'guardian stopped (pid ' + r.pid + '), the reply service with it' : 'guardian ' + r.pid + ' did not stop within 25 s');
        return r.running && !r.stopped ? 1 : 0;
    }
    out('guardian: ' + (pid ? 'running, pid ' + pid : 'not running') + ', AI ' + (guardianEnabled() ? 'on' : 'off') + ' on the phone, autostart ' + autostartText());
    if (arg && arg !== 'status') {
        out('usage: node bridge.js guardian start|stop|status');
        return 1;
    }
    return 0;
}

function guardianNote() {
    const pid = guardian.Guardian.runningPid();
    if (pid) out('note: the guardian (pid ' + pid + ') manages the reply service and starts it again while the game runs and AI is on. Use: node bridge.js guardian stop');
}

function takeOption(args, name) {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const v = args[i + 1];
    args.splice(i, 2);
    return v === undefined ? '' : String(v);
}

function cmdSimulate(args) {
    const info = config.load();
    const threadArg = takeOption(args, '--thread');
    const contactArg = takeOption(args, '--contact');
    const text = args.join(' ').trim();
    if (!text) {
        out('usage: node bridge.js simulate <text> [--thread <playerId-contactId> | --contact <id>]');
        return 1;
    }
    const mb = new Mailbox({ dir: info.config.mailbox.dir });
    let key;
    if (threadArg) {
        key = parseKey(threadArg).key;
    } else {
        const all = mb.threads().filter((t) => !contactArg || t.contactId === contactArg);
        if (all.length !== 1) {
            out('specify --thread, threads: ' + (mb.threads().map((t) => t.key).join(', ') || 'none'));
            return 1;
        }
        key = all[0].key;
    }
    mb.ensure(key);
    const file = mb.file(key, 'outbox');
    const list = mb.readBox(key, 'outbox') || [];
    const at = Date.now();
    list.push({ id: 'w-' + at + '-sim', text, at });
    fsx.writeJson(file, list.slice(-info.config.mailbox.keep));
    out('injected into ' + file);
    return 0;
}

async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv.shift() || 'run';
    switch (cmd) {
        case 'run': return cmdRun(argv);
        case 'start': return cmdStart();
        case 'stop': return cmdStop().then((ok) => { guardianNote(); process.exit(ok ? 0 : 1); });
        case 'guardian': return cmdGuardian(argv[0]).then((code) => process.exit(code));
        case 'restart': await cmdStop(); return cmdStart();
        case 'set-key': return cmdSetKey().then((code) => process.exit(code));
        case 'doctor': return cmdDoctor().then((code) => process.exit(code));
        case 'diagnose': return cmdDiagnose().then((code) => process.exit(code));
        case 'status': return cmdStatus();
        case 'contacts': return cmdContacts().then((code) => process.exit(code));
        case 'preview': return cmdPreview(argv).then((code) => process.exit(code));
        case 'stories': return cmdStories(argv).then((code) => process.exit(code));
        case 'legacy': return process.exit(cmdLegacy());
        case 'ties': return process.exit(cmdTies());
        case 'autostart': return cmdAutostart(argv[0]);
        case 'simulate': return process.exit(cmdSimulate(argv));
        default:
            out('unknown command ' + cmd);
            out(fs.readFileSync(SCRIPT, 'utf8').split('\n').slice(2, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
            process.exit(1);
    }
}

main().catch((e) => {
    process.stderr.write((e && e.stack || e) + '\n');
    process.exit(1);
});
