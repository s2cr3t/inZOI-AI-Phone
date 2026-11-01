'use strict';
// Leveled logger: one file per day under logs/, old files pruned after retain_days.
// Anything that looks like an API key is masked before it reaches disk.
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function pad(n, w) {
    let s = String(n);
    while (s.length < (w || 2)) s = '0' + s;
    return s;
}

function stamp(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
}

function day(d) {
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}

function redact(text) {
    return String(text)
        .replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***')
        .replace(/(Bearer\s+)[A-Za-z0-9_\-.~+\/=]{8,}/gi, '$1***')
        .replace(/("(?:api[_-]?key|apikey|llm_api_key|access[_-]?token|secret|password|authorization|dpapi|x-api-key)"\s*:\s*)"(?:[^"\\]|\\.)+"/gi, '$1"***"')
        .replace(/\b((?:api[_-]?key|access[_-]?token|x-api-key)\s*[=:]\s*)[^\s,;&"']{8,}/gi, '$1***');
}

class Logger {
    constructor(options) {
        const o = options || {};
        this.dir = o.dir;
        this.prefix = o.prefix || 'bridge';
        this.level = LEVELS[o.level] || LEVELS.info;
        this.retainDays = o.retainDays || 7;
        this.console = o.console !== false;
        this.stream = o.stream || process.stderr;
        this.currentDay = '';
        if (this.dir) fs.mkdirSync(this.dir, { recursive: true });
        this.prune();
    }

    setLevel(name) {
        this.level = LEVELS[name] || LEVELS.info;
    }

    prune() {
        if (!this.dir) return;
        const cutoff = Date.now() - this.retainDays * 86400000;
        let names = [];
        try { names = fs.readdirSync(this.dir); } catch (e) { return; }
        for (const name of names) {
            if (!name.startsWith(this.prefix + '-') || !name.endsWith('.log')) continue;
            const full = path.join(this.dir, name);
            try {
                if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
            } catch (e) { /* ignore */ }
        }
    }

    write(level, message) {
        if (LEVELS[level] < this.level) return;
        const now = new Date();
        const line = stamp(now) + ' ' + level.toUpperCase().padEnd(5) + ' ' + redact(message);
        if (this.console) {
            try { this.stream.write(line + '\n'); } catch (e) { /* console closed */ }
        }
        if (!this.dir) return;
        const d = day(now);
        if (d !== this.currentDay) {
            this.currentDay = d;
            this.prune();
        }
        try {
            fs.appendFileSync(path.join(this.dir, this.prefix + '-' + d + '.log'), line + '\n', 'utf8');
        } catch (e) { /* disk full or locked: never crash because of logging */ }
    }

    debug(m) { this.write('debug', m); }
    info(m) { this.write('info', m); }
    warn(m) { this.write('warn', m); }
    error(m) { this.write('error', m); }
}

module.exports = { Logger, redact };
