'use strict';
// The guardian: a small resident process started at Windows logon (inZOIPhone.exe ->
// supervisor.js). It sleeps until the game's MCP port answers, then runs the reply service
// (bridge.js run) as a child, and stops it a while after the game has closed.
//
// The phone talks to it through three files in <phone mod>\ui\phone\service\:
//   control.cfg  written by the phone: { rev, enabled, provider, model, base_url, thinking }
//   request.cfg  written by the phone: { id, type, provider, model, base_url, key? }
//                type: paste_key | set_key | forget_key | test | models | diagnose
//                      | wallpaper_pick | wallpaper_remove (with wallpaper: <id>) | photo_pick
//                Read once and emptied at once; a typed key never stays on disk.
//   service.cfg  written here every few seconds: state, settings, which providers have a key
//                (hint only), the answer to the last request. Never contains a key.
//
// Its own files, in the data folder: guardian.pid (plain pid, rewritten as a heartbeat),
// guardian.stop (inZOIPhone.exe --stop asks it to quit), guardian-state.json.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const fsx = require('./fsx');
const paths = require('./paths');
const providers = require('./providers');
const winsec = require('./winsec');
const { Logger, redact } = require('./log');
const { LlmClient, LlmError } = require('./llm');
const daemon = require('./daemon');
const usage = require('./usage');
const diagnostics = require('./diagnostics');
const wallpapers = require('./wallpapers');
const photos = require('./photos');

const VERSION = daemon.VERSION;
const BRIDGE_SCRIPT = path.join(paths.APP_ROOT, 'bridge.js');
const PID_FILE = path.join(config.DATA_DIR, 'guardian.pid');
const STOP_FILE = path.join(config.DATA_DIR, 'guardian.stop');
const STATE_FILE = path.join(config.DATA_DIR, 'guardian-state.json');

const TICK_MS = 2000;
const IDLE_TICK_MS = 5000;
const PID_REFRESH_MS = 10000;
const PID_STALE_MS = 60000;
const PROBE_TIMEOUT_MS = 1500;
// The game's port can be busy for a few seconds while a save loads; only a long silence
// means the game has closed.
const GAME_GONE_MS = 120000;
const BRIDGE_STOP_WAIT_MS = 15000;
const STABLE_MS = 10 * 60000;
const BACKOFF_MS = [5000, 15000, 30000, 60000, 120000, 300000];
const GIVE_UP_AFTER = 8;
const REQUEST_TIMEOUT_MS = 45000;
const PICK_REQUEST_TIMEOUT_MS = wallpapers.PICK_TIMEOUT_MS + 30000;
const KEY_RE = /^[\x21-\x7e]{16,512}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_MODELS = 300;
const USAGE_REFRESH_MS = 15000;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function probe(url) {
    let u;
    try { u = new URL(url); } catch (e) { return Promise.resolve(false); }
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(what + ' timed out')), ms);
        })
    ]).then((v) => { clearTimeout(timer); return v; }, (e) => { clearTimeout(timer); throw e; });
}

const KIND_MESSAGES = {
    auth: 'The key was rejected. Check that it was copied completely and belongs to this provider.',
    balance: 'The key works, but the account has no credit left.',
    rate: 'The provider is busy right now. Try again in a minute.',
    timeout: 'The provider did not answer in time.',
    network: 'Cannot reach the provider. Check the internet connection or the address.',
    model: 'The key works, but this model is not available to it.',
    config: 'The provider did not accept the request. Check the address and the model name.',
    format: 'The provider answered in an unexpected way.',
    server: 'The provider reported an error. Try again later.'
};

class Guardian {
    constructor() {
        const info = config.load({ withKey: false });
        this.log = new Logger({ dir: config.LOG_DIR, level: info.config.log.level, retainDays: info.config.log.retain_days, prefix: 'guardian' });
        this.cfg = info.config;
        this.problemsText = '';
        this.state = this.readState();
        this.stopping = false;
        this.timer = null;
        this.pidWrittenAt = 0;
        this.game = { up: false, seenAt: 0, checkedAt: 0 };
        this.bridge = { pid: 0, child: null, startedAt: 0, version: '', failures: 0, nextStartAt: 0, lastExit: null, stopping: null };
        this.reply = null;
        this.work = null;
        this.lastRequestId = '';
        this.controlError = '';
        this.lastStateLine = '';
        this.mailboxDir = '';
    }

    // ------------------------------------------------------------ lifecycle
    static runningPid() {
        let st;
        let text;
        try {
            st = fs.statSync(PID_FILE);
            text = fs.readFileSync(PID_FILE, 'utf8').trim();
        } catch (e) {
            return 0;
        }
        const pid = Number(text);
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return 0;
        if (Date.now() - st.mtimeMs > PID_STALE_MS) return 0;
        return fsx.isProcessAlive(pid) ? pid : 0;
    }

    async run() {
        fsx.ensureDir(config.DATA_DIR);
        const other = Guardian.runningPid();
        if (other) {
            this.log.info('guardian already running (pid ' + other + '), exiting');
            return 2;
        }
        this.writePid();
        try { fs.unlinkSync(STOP_FILE); } catch (e) { /* no stale request */ }
        this.log.info('inZOI AI Phone guardian ' + VERSION + ' started, pid ' + process.pid + (paths.INSTALLED ? ', installed' : ', development copy') +
            ', data ' + config.HOME);
        const onSignal = (sig) => {
            this.log.info('received ' + sig);
            this.shutdown('signal ' + sig).then(() => process.exit(0));
        };
        process.on('SIGINT', () => onSignal('SIGINT'));
        process.on('SIGTERM', () => onSignal('SIGTERM'));
        process.on('SIGBREAK', () => onSignal('SIGBREAK'));
        process.on('uncaughtException', (e) => this.log.error('uncaught: ' + (e && e.stack || e)));
        process.on('unhandledRejection', (e) => this.log.error('unhandled rejection: ' + (e && e.stack || e)));
        this.loop();
        return 0;
    }

    loop() {
        if (this.stopping) return;
        let next = TICK_MS;
        this.tick().then((idle) => {
            if (idle) next = IDLE_TICK_MS;
        }, (e) => {
            this.log.error('guardian tick failed: ' + (e && e.stack || e));
        }).then(() => {
            if (!this.stopping) this.timer = setTimeout(() => this.loop(), next);
        });
    }

    writePid() {
        try {
            fsx.writeAtomic(PID_FILE, String(process.pid));
            this.pidWrittenAt = Date.now();
        } catch (e) {
            this.log.warn('guardian.pid not written: ' + e.message);
        }
    }

    async shutdown(reason) {
        if (this.stopping) return;
        this.stopping = true;
        if (this.timer) clearTimeout(this.timer);
        this.log.info('guardian stopping (' + reason + ')');
        await this.stopBridge('the guardian is stopping');
        this.writeService('stopped', 'AI Phone Service was closed');
        try {
            const text = fs.readFileSync(PID_FILE, 'utf8').trim();
            if (Number(text) === process.pid) fs.unlinkSync(PID_FILE);
        } catch (e) { /* already gone */ }
        this.log.info('guardian stopped');
    }

    readState() {
        const r = fsx.readJson(STATE_FILE);
        const v = r.ok && isObject(r.value) ? r.value : {};
        return { enabled: v.enabled !== false, rev: typeof v.rev === 'number' ? v.rev : 0 };
    }

    saveState() {
        try {
            fsx.writeJson(STATE_FILE, this.state, true);
        } catch (e) {
            this.log.warn('guardian state not saved: ' + e.message);
        }
    }

    // ------------------------------------------------------------ main loop
    // Resolves true when nothing is happening and the next check can wait longer.
    async tick() {
        if (fs.existsSync(STOP_FILE)) {
            try { fs.unlinkSync(STOP_FILE); } catch (e) { /* ignore */ }
            await this.shutdown('stop requested');
            process.exit(0);
            return false;
        }
        if (Date.now() - this.pidWrittenAt > PID_REFRESH_MS) this.writePid();

        const info = config.load({ withKey: false });
        this.cfg = info.config;
        this.log.setLevel(this.cfg.log.level);
        const problems = info.problems.join('; ');
        if (problems !== this.problemsText) {
            this.problemsText = problems;
            for (const p of info.problems) this.log.warn('config: ' + p);
        }

        this.game.up = await probe(this.cfg.game.url);
        if (this.game.up) this.game.seenAt = Date.now();

        const mailboxDir = this.cfg.mailbox.dir;
        if (this.mailboxDir && mailboxDir !== this.mailboxDir) {
            this.log.warn('the phone mod in use is now ' + path.dirname(path.dirname(path.dirname(mailboxDir))) + ' (was ' +
                path.dirname(path.dirname(path.dirname(this.mailboxDir))) + ')');
            if (this.bridge.pid) {
                await this.stopBridge('the phone mod folder changed');
                this.bridge.failures = 0;
                this.bridge.nextStartAt = 0;
            }
        }
        this.mailboxDir = mailboxDir;

        const phone = this.cfg.mailbox.found;
        if (phone) {
            this.readControl();
            this.readRequest();
        }

        this.watchBridge();
        const keyed = this.keySet(this.cfg.llm.provider);
        const want = this.state.enabled && keyed && phone;
        if (!want) {
            if (this.bridge.pid) await this.stopBridge(!this.state.enabled ? 'switched off on the phone' : !keyed ? 'no API key' : 'the phone mod is missing');
        } else if (this.game.up) {
            if (!this.bridge.pid && !this.bridge.stopping && Date.now() >= this.bridge.nextStartAt && this.bridge.failures < GIVE_UP_AFTER) this.startBridge();
        } else if (this.bridge.pid && Date.now() - this.game.seenAt > GAME_GONE_MS) {
            await this.stopBridge('the game has closed');
            this.bridge.failures = 0;
            this.bridge.nextStartAt = 0;
        }
        if (!this.game.up && this.bridge.failures >= GIVE_UP_AFTER) {
            // The next game session gets a fresh set of attempts.
            this.bridge.failures = 0;
            this.bridge.nextStartAt = 0;
        }

        const s = this.describe(want, keyed);
        if (phone) this.writeService(s.state, s.error);
        const line = s.state + (s.error ? ' (' + s.error + ')' : '');
        if (line !== this.lastStateLine) {
            this.lastStateLine = line;
            this.log.info('state: ' + line);
        }
        return !this.game.up && !this.bridge.pid && !this.work;
    }

    keySet(provider) {
        if (!providers.get(provider)) return false;
        const p = providers.get(provider);
        if (p.custom && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(this.cfg.llm.base_url) && provider === this.cfg.llm.provider) return true;
        return config.keyInfo(provider, this.cfg.llm.provider).set;
    }

    describe(want, keyed) {
        const label = (providers.get(this.cfg.llm.provider) || {}).label || this.cfg.llm.provider;
        if (!this.state.enabled) return { state: 'disabled', error: 'AI is switched off' };
        if (!keyed) return { state: 'needs_key', error: 'Add an API key for ' + label };
        if (this.bridge.pid) {
            if (Date.now() - this.bridge.startedAt < 8000) return { state: 'starting', error: '' };
            return { state: 'running', error: '' };
        }
        if (!this.game.up) return { state: 'waiting_game', error: "Cannot reach the game's MCP service at " + this.cfg.game.url };
        if (this.bridge.failures >= GIVE_UP_AFTER) return { state: 'error', error: 'The AI service keeps stopping. Its log is in ' + config.LOG_DIR };
        if (this.bridge.failures > 0) {
            const wait = Math.max(0, Math.round((this.bridge.nextStartAt - Date.now()) / 1000));
            return { state: 'error', error: 'The AI service stopped unexpectedly; restarting in ' + wait + ' s' };
        }
        return { state: want ? 'starting' : 'stopped', error: '' };
    }

    // ------------------------------------------------------------ the reply service
    watchBridge() {
        const b = this.bridge;
        if (b.pid && !fsx.isProcessAlive(b.pid)) this.bridgeExited(null);
        if (!b.pid && !b.stopping) {
            const r = fsx.readJson(daemon.PID_FILE);
            if (r.ok && isObject(r.value) && r.value.pid && fsx.isProcessAlive(r.value.pid)) {
                b.pid = r.value.pid;
                b.child = null;
                b.startedAt = r.value.startedAt || Date.now();
                b.version = r.value.version || '';
                this.log.info('adopted the running reply service (pid ' + b.pid + ', v' + (b.version || '?') + ')');
                if (b.version !== VERSION) {
                    this.log.info('it is version ' + (b.version || '?') + ', this program is ' + VERSION + '; restarting it');
                    this.stopBridge('version change').then(() => { b.nextStartAt = 0; });
                }
            }
        }
    }

    bridgeExited(code) {
        const b = this.bridge;
        if (!b.pid) return;
        const ran = Date.now() - b.startedAt;
        const pid = b.pid;
        b.pid = 0;
        b.child = null;
        b.lastExit = { at: Date.now(), code };
        if (b.stopping) return;
        if (code === 2) {
            // Another copy holds the lock; watchBridge adopts it on the next tick.
            this.log.info('reply service ' + pid + ' found another copy running');
            return;
        }
        if (code === daemon.RESTART_EXIT_CODE) {
            // The played household changed and its files were swapped in; not a failure.
            this.log.info('reply service ' + pid + ' switched household files, starting it again');
            b.nextStartAt = 0;
            return;
        }
        if (ran > STABLE_MS) b.failures = 0;
        b.failures += 1;
        const wait = BACKOFF_MS[Math.min(b.failures - 1, BACKOFF_MS.length - 1)];
        b.nextStartAt = Date.now() + wait;
        this.log.warn('reply service ' + pid + ' exited' + (code === null ? '' : ' with code ' + code) + ' after ' + Math.round(ran / 1000) +
            ' s (failure ' + b.failures + '); next start in ' + Math.round(wait / 1000) + ' s');
    }

    startBridge() {
        const b = this.bridge;
        let child;
        try {
            child = spawn(process.execPath, [BRIDGE_SCRIPT, 'run'], {
                cwd: paths.APP_ROOT,
                stdio: 'ignore',
                windowsHide: true,
                env: Object.assign({}, process.env, { INZOI_PHONE_HOME: config.HOME, INZOI_PHONE_GUARDED: '1' })
            });
        } catch (e) {
            this.log.error('reply service could not start: ' + e.message);
            b.failures += 1;
            b.nextStartAt = Date.now() + BACKOFF_MS[Math.min(b.failures - 1, BACKOFF_MS.length - 1)];
            return;
        }
        b.pid = child.pid;
        b.child = child;
        b.startedAt = Date.now();
        b.version = VERSION;
        child.once('error', (e) => {
            this.log.error('reply service error: ' + e.message);
            if (b.child === child) this.bridgeExited(null);
        });
        child.once('exit', (code) => {
            if (b.child === child) this.bridgeExited(code);
        });
        this.log.info('reply service started (pid ' + child.pid + ')');
    }

    stopBridge(reason) {
        const b = this.bridge;
        if (b.stopping) return b.stopping;
        if (!b.pid) return Promise.resolve();
        const pid = b.pid;
        this.log.info('stopping the reply service (pid ' + pid + '): ' + reason);
        b.stopping = (async () => {
            try {
                fsx.writeAtomic(daemon.STOP_FILE, String(Date.now()));
            } catch (e) {
                this.log.warn('stop request not written: ' + e.message);
            }
            const until = Date.now() + BRIDGE_STOP_WAIT_MS;
            while (Date.now() < until && fsx.isProcessAlive(pid)) await sleep(250);
            if (fsx.isProcessAlive(pid)) {
                try {
                    process.kill(pid);
                    this.log.warn('reply service ' + pid + ' did not stop in time; terminated');
                } catch (e) {
                    this.log.warn('could not terminate reply service ' + pid + ': ' + e.message);
                }
                await sleep(500);
            }
            try { fs.unlinkSync(daemon.STOP_FILE); } catch (e) { /* the service removed it */ }
            if (b.pid === pid) {
                b.pid = 0;
                b.child = null;
                b.lastExit = { at: Date.now(), code: null };
            }
        })().then(() => { b.stopping = null; }, (e) => {
            b.stopping = null;
            this.log.error('stopping the reply service failed: ' + e.message);
        });
        return b.stopping;
    }

    // ------------------------------------------------------------ phone channel
    serviceDir() {
        return path.join(path.dirname(this.cfg.mailbox.dir), 'service');
    }

    // Settings chosen on the phone. A newer rev than the last one applied is copied into
    // config.json, which the running reply service reloads by itself.
    readControl() {
        const file = path.join(this.serviceDir(), 'control.cfg');
        const r = fsx.readJson(file);
        if (!r.ok || !isObject(r.value)) return;
        const c = r.value;
        if (typeof c.rev !== 'number' || !(c.rev > this.state.rev)) return;
        const errors = [];
        const llm = {};
        // Provider, address and model only change together, so config.json never pairs one
        // provider's address with another provider's model.
        const p = c.provider === undefined ? providers.get(this.cfg.llm.provider) : providers.get(c.provider);
        if (!p) {
            errors.push('unknown provider');
        } else {
            let base = p.base_url;
            if (p.custom) {
                const u = providers.checkBaseUrl(c.base_url === undefined && p.id === this.cfg.llm.provider ? this.cfg.llm.base_url : c.base_url);
                base = u.ok ? u.url : '';
                if (!u.ok) errors.push('address ' + u.reason);
            }
            const m = typeof c.model === 'string' ? c.model.trim() : '';
            let model = '';
            if (m) {
                if (providers.isModelId(m)) model = m;
                else errors.push('model name is not valid');
            } else if (p.id === this.cfg.llm.provider) {
                model = this.cfg.llm.model;
            } else {
                model = p.models[0] || '';
                if (!model) errors.push('enter a model name');
            }
            if (base && model) {
                llm.provider = p.id;
                llm.base_url = base;
                llm.model = model;
            }
        }
        if (c.thinking !== undefined) {
            if (config.THINKING.indexOf(c.thinking) >= 0) llm.thinking = c.thinking;
            else errors.push('deep thinking setting is not valid');
        }
        this.state.rev = c.rev;
        if (typeof c.enabled === 'boolean' && c.enabled !== this.state.enabled) {
            this.state.enabled = c.enabled;
            this.log.info('AI switched ' + (c.enabled ? 'on' : 'off') + ' on the phone');
            if (c.enabled) {
                this.bridge.failures = 0;
                this.bridge.nextStartAt = 0;
            }
        }
        this.saveState();
        this.controlError = errors.length ? 'Not saved: ' + errors.join(', ') : '';
        if (!Object.keys(llm).length) return;
        try {
            if (config.patchConfigFile({ llm })) {
                this.log.info('settings from the phone: ' + Object.keys(llm).map((k) => k + '=' + llm[k]).join(', '));
                this.cfg = config.load({ withKey: false }).config;
                this.bridge.failures = 0;
                this.bridge.nextStartAt = 0;
            }
        } catch (e) {
            this.controlError = 'Settings could not be saved: ' + e.message;
            this.log.error('config.json not updated: ' + e.message);
        }
    }

    readRequest() {
        const file = path.join(this.serviceDir(), 'request.cfg');
        let raw;
        try { raw = fsx.readText(file); } catch (e) { return; }
        if (raw === null || !raw.trim()) return;
        // Emptied before anything else: a typed key must not stay in the mod folder.
        try {
            fsx.writeAtomic(file, '');
        } catch (e) {
            this.log.warn('request.cfg could not be emptied: ' + e.message);
        }
        let req;
        try { req = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { req = null; }
        raw = '';
        if (!isObject(req) || typeof req.id !== 'string' || !ID_RE.test(req.id)) {
            this.log.warn('ignored an unreadable request from the phone');
            return;
        }
        if (req.id === this.lastRequestId) return;
        this.lastRequestId = req.id;
        if (this.work) {
            this.reply = { id: req.id, type: String(req.type || ''), ok: false, code: 'busy', message: 'Still working on the previous request.', at: Date.now() };
            return;
        }
        const started = Date.now();
        this.reply = { id: req.id, type: String(req.type || ''), pending: true, at: started };
        const limit = req.type === 'wallpaper_pick' || req.type === 'photo_pick' ? PICK_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        this.work = withTimeout(this.handle(req), limit, 'request').then((r) => r, (e) => {
            this.log.error('request ' + req.type + ' failed: ' + redact(e && e.message || String(e)));
            return { ok: false, code: 'error', message: 'Something went wrong. Details are in the log.' };
        }).then((r) => {
            // The phone matches answers by request id; nothing a handler returns may replace it.
            this.reply = Object.assign({}, r, { id: req.id, type: String(req.type || ''), at: Date.now(), tookMs: Date.now() - started });
            this.work = null;
            const keyed = this.keySet(this.cfg.llm.provider);
            const s = this.describe(this.state.enabled && keyed, keyed);
            this.writeService(s.state, s.error);
        });
    }

    // Provider, address and model for a request; the phone may be testing a choice it has
    // not saved yet.
    target(req) {
        const p = providers.get(req.provider) || providers.get(this.cfg.llm.provider);
        const current = p.id === this.cfg.llm.provider;
        let base = p.base_url;
        if (p.custom) {
            const raw = typeof req.base_url === 'string' && req.base_url.trim() ? req.base_url : current ? this.cfg.llm.base_url : '';
            const u = providers.checkBaseUrl(raw);
            if (!u.ok) return { error: { ok: false, code: 'bad_url', message: 'The address ' + u.reason + '.' } };
            base = u.url;
        }
        const m = typeof req.model === 'string' ? req.model.trim() : '';
        const model = providers.isModelId(m) ? m : current ? this.cfg.llm.model : (p.models[0] || '');
        return { provider: p, base_url: base, model };
    }

    client(t, key) {
        return new LlmClient({
            base_url: t.base_url,
            model: t.model || 'unknown',
            provider: t.provider.id,
            apiKey: key,
            thinking: 'disabled',
            temperature: 0,
            max_tokens: 400,
            timeout_ms: 30000,
            max_retries: 0,
            max_calls_per_hour: 0,
            quirks_file: daemon.QUIRKS_FILE,
            log: this.log
        });
    }

    async handle(req) {
        if (req.type === 'diagnose') return this.diagnose();
        if (req.type === 'wallpaper_pick') return this.wallpaperPick();
        if (req.type === 'wallpaper_remove') return this.wallpapers().remove(req.wallpaper);
        if (req.type === 'photo_pick') return this.photoPick();
        const t = this.target(req);
        if (t.error) return t.error;
        switch (req.type) {
            case 'paste_key': return this.pasteKey(t);
            case 'set_key': return this.setKey(t, req.key);
            case 'forget_key': return this.forget(t);
            case 'test': return this.test(t);
            case 'models': return this.models(t);
            default: return { ok: false, code: 'unknown', message: 'Unknown request.' };
        }
    }

    // A package of logs and settings, with keys taken out, for a tester to send back.
    async diagnose() {
        const r = await diagnostics.build({
            log: this.log,
            gameUp: this.game.up,
            bridgePid: this.bridge.pid || 0,
            serviceDir: this.serviceDir()
        });
        if (!r.ok) return { ok: false, code: 'diagnose_failed', message: r.message };
        this.log.info('diagnostics written: ' + r.file + ' (' + r.bytes + ' bytes)');
        return { ok: true, code: 'ok', file: r.file, message: 'Saved to ' + r.shown + '. Send this file with your report.' };
    }

    wallpapers() {
        return new wallpapers.Wallpapers(path.dirname(this.cfg.mailbox.dir), this.log);
    }

    async wallpaperPick() {
        const missing = this.helperProblem();
        if (missing) return missing;
        return this.wallpapers().pick();
    }

    photos() {
        return new photos.Photos(path.dirname(this.cfg.mailbox.dir), this.log);
    }

    async photoPick() {
        const missing = this.helperProblem();
        if (missing) return missing;
        return this.photos().pick();
    }

    helperProblem() {
        if (winsec.available()) return null;
        return { ok: false, code: 'helper_missing', message: 'inZOIPhone.exe is missing. Reinstall inZOI AI Phone.' };
    }

    async pasteKey(t) {
        const missing = this.helperProblem();
        if (missing) return missing;
        const clip = await winsec.clipboardKey();
        if (!clip.ok) {
            const msg = clip.reason === 'clipboard_empty' ? 'The clipboard is empty. Copy the key on the provider\'s website first.'
                : clip.reason === 'clipboard_busy' ? 'Another program is using the clipboard. Try again.'
                    : 'The clipboard does not hold an API key. Copy only the key and try again.';
            return { ok: false, code: clip.reason || 'clipboard_invalid', message: msg };
        }
        const key = (await winsec.unprotectAsync(clip.blob)).trim();
        return this.storeKey(t, key, clip.blob, clip.hint || config.keyHint(key));
    }

    async setKey(t, typed) {
        const missing = this.helperProblem();
        if (missing) return missing;
        const key = String(typeof typed === 'string' ? typed : '').trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '');
        if (!KEY_RE.test(key)) {
            return { ok: false, code: 'key_invalid', message: 'That does not look like an API key (16 to 512 characters, no spaces).' };
        }
        const blob = await winsec.protectAsync(key);
        return this.storeKey(t, key, blob, config.keyHint(key));
    }

    // Tests the key and keeps it unless the provider says it is wrong.
    async storeKey(t, key, blob, hint) {
        const check = await this.ping(t, key);
        if (check.code === 'auth') return Object.assign(check, { saved: false });
        config.saveProtectedKey(t.provider.id, blob, hint);
        this.log.info('API key saved for ' + t.provider.id + ' (' + hint + '), check: ' + check.code);
        this.bridge.failures = 0;
        this.bridge.nextStartAt = 0;
        const label = t.provider.label;
        if (check.ok) return { ok: true, saved: true, code: 'ok', latencyMs: check.latencyMs, message: 'Key saved for ' + label + '. Connection works.' };
        return { ok: true, saved: true, code: check.code, message: 'Key saved for ' + label + ', but the check failed: ' + check.message };
    }

    async forget(t) {
        const had = config.forgetKey(t.provider.id);
        this.log.info('API key removed for ' + t.provider.id);
        return { ok: true, code: 'ok', message: had ? 'Key removed for ' + t.provider.label + '.' : 'No key was stored for ' + t.provider.label + '.' };
    }

    async storedKey(t) {
        try {
            return await config.apiKeyFor(t.provider.id);
        } catch (e) {
            this.log.warn('stored key for ' + t.provider.id + ' unreadable: ' + e.message);
            return null;
        }
    }

    async test(t) {
        const key = await this.storedKey(t);
        if (key === null) return { ok: false, code: 'key_unreadable', message: 'The stored key cannot be read on this PC. Enter it again.' };
        const llm = this.client(t, key);
        if (!llm.configured) return { ok: false, code: 'no_key', message: 'Add an API key for ' + t.provider.label + ' first.' };
        if (!t.model) return { ok: false, code: 'bad_model', message: 'Choose a model first.' };
        return this.ping(t, key);
    }

    async ping(t, key) {
        if (!t.model) return { ok: false, code: 'bad_model', message: 'Choose a model first.' };
        try {
            const r = await this.client(t, key).ping();
            return { ok: true, code: 'ok', latencyMs: r.latencyMs, message: 'Connection works (' + r.latencyMs + ' ms).' };
        } catch (e) {
            if (!(e instanceof LlmError)) throw e;
            this.log.warn('connection check ' + t.provider.id + '/' + t.model + ': ' + e.kind + ' - ' + redact(e.message));
            return { ok: false, code: e.kind, message: KIND_MESSAGES[e.kind] || e.publicMessage };
        }
    }

    async models(t) {
        const key = await this.storedKey(t);
        if (key === null) return { ok: false, code: 'key_unreadable', message: 'The stored key cannot be read on this PC. Enter it again.' };
        const llm = this.client(t, key);
        if (!llm.configured) return { ok: false, code: 'no_key', message: 'Add an API key for ' + t.provider.label + ' first.' };
        try {
            const ids = (await llm.listModels()).filter((id) => providers.isModelId(id)).sort().slice(0, MAX_MODELS);
            if (!ids.length) return { ok: false, code: 'no_list', message: 'This provider does not publish a model list. Type the model name instead.' };
            return { ok: true, code: 'ok', models: ids, message: ids.length + ' models found.' };
        } catch (e) {
            if (!(e instanceof LlmError)) throw e;
            return { ok: false, code: e.kind, message: KIND_MESSAGES[e.kind] || e.publicMessage };
        }
    }

    // Calls and estimated cost for the AI page. The reply service saves its log every 15 s, so
    // reading it more often would not show anything new.
    usageSummary() {
        const now = Date.now();
        const llm = this.cfg.llm;
        const sig = llm.provider + '|' + llm.model + '|' + llm.max_calls_per_hour + '|' + JSON.stringify(llm.price || null);
        if (this.usageCache && this.usageCache.sig === sig && now - this.usageCache.at < USAGE_REFRESH_MS) return this.usageCache.value;
        let value = null;
        try {
            value = usage.summarize(usage.readEntries(daemon.USAGE_FILE, now), now, {
                provider: llm.provider,
                model: llm.model,
                limit: llm.max_calls_per_hour,
                custom: llm.price
            });
        } catch (e) {
            this.log.debug('usage summary failed: ' + e.message);
        }
        this.usageCache = { sig, at: now, value };
        return value;
    }

    // What the phone shows. Never contains a key, only whether one is stored and its hint.
    writeService(state, error) {
        if (!this.cfg || !this.cfg.mailbox.found) return;
        const current = this.cfg.llm.provider;
        const keys = {};
        const all = config.keyInfoAll(current);
        for (const id of Object.keys(all)) keys[id] = { set: all[id].set, hint: all[id].hint };
        const health = fsx.readJson(daemon.HEALTH_FILE);
        const h = health.ok && isObject(health.value) && health.value.pid === this.bridge.pid ? health.value.last : null;
        const payload = {
            v: 1,
            heartbeat: Date.now(),
            version: VERSION,
            installed: paths.INSTALLED,
            state,
            error: error || '',
            enabled: this.state.enabled,
            appliedRev: this.state.rev,
            controlError: this.controlError,
            provider: current,
            model: this.cfg.llm.model,
            base_url: this.cfg.llm.base_url,
            thinking: this.cfg.llm.thinking,
            key: { set: this.keySet(current), hint: (keys[current] && keys[current].hint) || '' },
            keys,
            providers: providers.publicList(),
            game: { reachable: this.game.up },
            bridge: { running: !!this.bridge.pid, since: this.bridge.pid ? this.bridge.startedAt : 0, restarts: this.bridge.failures },
            ai: h && h.model === this.cfg.llm.model ? { ok: !!h.ok, kind: h.kind || '', message: h.ok ? '' : (KIND_MESSAGES[h.kind] || h.message || ''), at: h.at || 0 } : null,
            usage: this.usageSummary(),
            reply: this.reply
        };
        try {
            fsx.writeJson(path.join(this.serviceDir(), 'service.cfg'), payload, false);
        } catch (e) {
            this.log.debug('service.cfg not written: ' + e.message);
        }
        // The phone of a copy not in use still shows the service as running, so whatever the
        // player does on it marks that copy as the one the game loads and the service moves there.
        const using = path.resolve(path.dirname(path.dirname(path.dirname(this.cfg.mailbox.dir)))).toLowerCase();
        for (const dir of this.cfg.mailbox.copies || []) {
            if (path.resolve(dir).toLowerCase() === using || !paths.isDir(path.join(dir, 'ui', 'phone'))) continue;
            try {
                fsx.writeJson(path.join(dir, 'ui', 'phone', 'service', 'service.cfg'), payload, false);
            } catch (e) {
                this.log.debug('service.cfg not written in ' + dir + ': ' + e.message);
            }
        }
    }
}

// Asks a running guardian to quit and waits for it. Used by bridge.js guardian stop.
async function stopRunning(waitMs) {
    const pid = Guardian.runningPid();
    if (!pid) return { running: false };
    fsx.writeAtomic(STOP_FILE, String(Date.now()));
    const until = Date.now() + (waitMs || 25000);
    while (Date.now() < until) {
        await sleep(250);
        if (!fsx.isProcessAlive(pid)) return { running: true, stopped: true, pid };
    }
    return { running: true, stopped: false, pid };
}

module.exports = { Guardian, stopRunning, PID_FILE, STOP_FILE, STATE_FILE };
