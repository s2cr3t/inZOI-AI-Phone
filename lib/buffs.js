'use strict';
// Chat moodlets: after a text exchange the model decides whether either household member is
// moved by it, picks the game's own moodlet for that feeling, and the HouseholdJournal Lua mod
// adds it in game with the other person recorded as its cause ("源自与{InitiatorName}的…").
//
// Delivery: the bridge is the only writer of the mod's bridge/buffs.cfg, one line of
// "<seq>:<target>:<initiator>:<buff id>;..." holding requests not yet answered. The mod's B1
// side reads it, B2 adds the buff and prints a B line to the Lua log; the journal hands that
// line back here and the request leaves the file. A request nobody answers expires.
//
// The catalog is built from the game's Buff table (game MCP, read-only) and the zh-CN strings
// of the ModKit's localization file (read-only), and cached in data/buff-catalog.json.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const fsx = require('./fsx');
const prompts = require('./buffs-prompt');

const CATALOG_VERSION = 1;
const CATALOG_MAX_AGE_MS = 7 * 24 * 3600000;
const CONTEXT_MESSAGES = 6;
const RECENT_FOR_PROMPT_MS = 3 * 3600000;
const KEEP_GIVEN = 60;
// The game flushes its Lua log minutes apart, so "running" here is looser than the journal's.
const MOD_SEEN_MS = 10 * 60000;
const PICK_TEXT_UNDER = 8;
const ID_RE = /^[A-Za-z0-9_]+$/;
const INITIATOR_RE = /\{InitiatorName[^}]*\}/g;

function band(value) {
    return value >= 3 ? 3 : value;
}

// Every "ST_Buff,<key>" msgstr of a gettext file, streamed so the 75 MB file is never held whole.
function readBuffStrings(file) {
    return new Promise((resolve, reject) => {
        const strings = new Map();
        let ctx = null;
        let field = null;
        let val = '';
        const flush = () => {
            if (ctx && field === 'msgstr' && ctx.indexOf('ST_Buff,') === 0) strings.set(ctx.slice(8), val);
        };
        const parse = (s) => {
            try { return JSON.parse(s); } catch (e) { return ''; }
        };
        const input = fs.createReadStream(file, { encoding: 'utf8' });
        input.on('error', reject);
        const rl = readline.createInterface({ input, crlfDelay: Infinity });
        rl.on('line', (line) => {
            if (line.indexOf('msgctxt ') === 0) {
                flush();
                ctx = parse(line.slice(8));
                field = 'msgctxt';
                val = '';
            } else if (line.indexOf('msgid ') === 0) {
                field = 'msgid';
            } else if (line.indexOf('msgstr ') === 0) {
                field = 'msgstr';
                val = parse(line.slice(7));
            } else if (line.charAt(0) === '"' && field === 'msgstr') {
                val += parse(line);
            } else if (!line.trim()) {
                flush();
                ctx = null;
                field = null;
            }
        });
        rl.on('close', () => {
            flush();
            resolve(strings);
        });
    });
}

function listOf(v) {
    return Array.isArray(v) ? v : [];
}

// Moodlets another person causes and nothing else: shown to the player, timed, no scripts or
// tags that would tie them to a game system, and a reason text that names only the initiator.
function socialBuffs(rows, strings) {
    const out = [];
    for (const b of rows) {
        const info = b && b.buffBasicInfo;
        const disp = b && b.buffDisplayInfo;
        const id = String((b && (b.iD || b.id || b.Id)) || '');
        if (!info || !disp || !ID_RE.test(id)) continue;
        if (disp.hiddenFromUI) continue;
        if (!(info.duration > 0 && info.duration <= 720)) continue;
        if (listOf(info.tags).length || info.tickInterval) continue;
        if (info.expireTime && info.expireTime.afterDay >= 0) continue;
        if (listOf(b.addScriptIdList).length || listOf(b.tickScriptIdList).length || listOf(b.intervalScriptIdList).length ||
            listOf(b.cancelScriptIdList).length || listOf(b.finishScriptIdList).length) continue;
        const value = Number(info.emotionValue);
        if (!info.emotionId || info.emotionId === 'Normal' || !(value > 0)) continue;
        const name = strings.get(disp.displayTextId) || '';
        const reason = strings.get(disp.reasonTextId) || '';
        if (!name || !reason) continue;
        const holes = (name + reason).match(/\{[^}]+\}/g) || [];
        if (!holes.length || holes.some((h) => !/^\{InitiatorName[}|]/.test(h))) continue;
        const m = reason.match(/^\[([^\]]*)\]\s*([\s\S]*)$/);
        out.push({
            id,
            name,
            from: m ? m[1] : '',
            text: m ? m[2] : reason,
            emotion: String(info.emotionId),
            value,
            minutes: info.duration
        });
    }
    return out;
}

class Buffs {
    constructor(daemon) {
        this.d = daemon;
        this.log = daemon.log;
        this.catalog = null;
        this.building = null;
        this.catalogFailedAt = 0;
        this.state = { pending: [], given: [] };
        this.stateFile = null;
        this.lastSeq = 0;
        this.quietLogged = false;
    }

    get cfg() {
        return this.d.cfg.buffs;
    }

    configure(dataDir) {
        const first = !this.stateFile;
        this.dataDir = dataDir;
        this.stateFile = path.join(dataDir, 'buffs-state.json');
        this.catalogFile = path.join(dataDir, 'buff-catalog.json');
        if (first) {
            const r = fsx.readJson(this.stateFile);
            if (r.ok && r.value && typeof r.value === 'object') {
                this.state.pending = listOf(r.value.pending).filter((p) => p && p.seq);
                this.state.given = listOf(r.value.given).filter((g) => g && g.at);
            }
            for (const p of this.state.pending) this.lastSeq = Math.max(this.lastSeq, Number(p.seq) || 0);
        }
        this.expire();
        this.writeQueue();
    }

    saveState() {
        try {
            fsx.writeJson(this.stateFile, this.state, true);
        } catch (e) {
            this.log.warn('buffs: state not saved: ' + e.message);
        }
    }

    // The file always holds exactly the unanswered requests; an empty queue is an empty line.
    writeQueue() {
        const file = this.cfg.queue_file;
        if (!file) return;
        const text = this.state.pending.map((p) => p.seq + ':' + p.target + ':' + p.initiator + ':' + p.id).join(';');
        try {
            const now = fsx.readText(file);
            if (now !== null && now === text) return;
            fsx.writeAtomic(file, text);
        } catch (e) {
            this.log.warn('buffs: queue file not written: ' + e.message);
        }
    }

    // ------------------------------------------------------------ catalog
    async ensureCatalog() {
        if (this.catalog) return this.catalog;
        if (this.building) return this.building;
        const po = this.cfg.po_file;
        let stamp = null;
        if (po) {
            try {
                const st = fs.statSync(po);
                stamp = { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
            } catch (e) {
                this.log.warn('buffs: localization file not found (' + po + '); using the bundled catalog');
            }
        }
        if (!stamp) {
            this.catalog = this.index(this.bundledList());
            return this.catalog;
        }
        const cached = fsx.readJson(this.catalogFile);
        const c = cached.ok && cached.value;
        if (c && c.v === CATALOG_VERSION && c.po && c.po.size === stamp.size && c.po.mtimeMs === stamp.mtimeMs &&
            Date.now() - c.builtAt < CATALOG_MAX_AGE_MS && Array.isArray(c.list) && c.list.length) {
            this.catalog = this.index(c.list);
            return this.catalog;
        }
        if (this.catalogFailedAt && Date.now() - this.catalogFailedAt < 5 * 60000) return this.fallbackCatalog(new Error('catalog build failed recently'));
        this.building = this.build(po, stamp).then((list) => {
            this.catalog = this.index(list);
            return this.catalog;
        }, (e) => {
            this.catalogFailedAt = Date.now();
            this.log.warn('buffs: catalog build failed (' + e.message + ')');
            return this.fallbackCatalog(e);
        }).then((v) => { this.building = null; return v; }, (e) => { this.building = null; throw e; });
        return this.building;
    }

    // The catalog shipped with the program, for players without the ModKit's localization files.
    // Not kept in this.catalog, so a later build from the .po file can still replace it.
    fallbackCatalog(cause) {
        try {
            return this.index(this.bundledList());
        } catch (e) {
            throw cause;
        }
    }

    bundledList() {
        if (this.bundled) return this.bundled;
        const file = this.cfg.bundled_catalog;
        const r = file ? fsx.readJson(file) : { ok: false };
        const c = r.ok && r.value;
        if (!c || c.v !== CATALOG_VERSION || !Array.isArray(c.list) || !c.list.length) {
            throw new Error('bundled moodlet catalog missing or outdated: ' + (file || '(none)'));
        }
        this.bundled = c.list;
        return this.bundled;
    }

    async build(po, stamp) {
        const started = Date.now();
        const [strings, table] = await Promise.all([
            readBuffStrings(po),
            this.d.game.call('data_table_get_all', { Alias: 'Buff' }, 180000)
        ]);
        const rows = Array.isArray(table) ? table : listOf(table && (table.rows || table.data || table.Rows));
        if (!rows.length) throw new Error('the game returned no Buff rows');
        const list = socialBuffs(rows, strings);
        if (!list.length) throw new Error('no moodlet in the Buff table is caused by another person');
        fsx.writeJson(this.catalogFile, { v: CATALOG_VERSION, builtAt: Date.now(), po: stamp, rows: rows.length, list }, false);
        this.log.info('buffs: catalog built from ' + rows.length + ' Buff rows, ' + list.length + ' moodlets caused by another person (' +
            Math.round((Date.now() - started) / 1000) + 's)');
        return list;
    }

    index(list) {
        const byId = new Map();
        const byEmotion = new Map();
        for (const b of list) {
            byId.set(b.id, b);
            if (!byEmotion.has(b.emotion)) byEmotion.set(b.emotion, new Map());
            const bands = byEmotion.get(b.emotion);
            const k = band(b.value);
            if (!bands.has(k)) bands.set(k, []);
            bands.get(k).push(b);
        }
        return { list, byId, byEmotion };
    }

    // Every moodlet of the emotion, the asked strength first and then the nearest ones: a fitting
    // source matters more than an exact strength.
    optionsFor(catalog, emotion, strength, exclude) {
        const bands = catalog.byEmotion.get(emotion);
        if (!bands) return { strength, list: [] };
        const order = [1, 2, 3].sort((a, b) => Math.abs(a - strength) - Math.abs(b - strength) || a - b);
        const seen = new Set();
        const list = [];
        for (const s of order) {
            for (const b of bands.get(s) || []) {
                if (list.length >= this.cfg.max_options) return { strength, list };
                if (exclude.has(b.id)) continue;
                const k = b.name + '|' + b.from;
                if (seen.has(k)) continue;
                seen.add(k);
                list.push(b);
            }
        }
        return { strength, list };
    }

    // ------------------------------------------------------------ limits
    recentFor(target, now, ms) {
        const list = this.state.given.concat(this.state.pending);
        return list.filter((g) => String(g.target) === String(target) && now - g.at < ms);
    }

    lastHour(now) {
        return this.state.given.concat(this.state.pending).filter((g) => now - g.at < 3600000).length;
    }

    // The cooldown keeps one kind of feeling from piling up. A swing the other way (praised a
    // moment ago, scolded now) is a real change and always gets through.
    // reward: a story's ending, which is not one more feeling from the same chat.
    canGive(target, now, tendency, table, reward) {
        if (this.d.journal && this.d.journal.handlersDown(now)) return 'the B2 handlers are down (reload HouseholdJournal\'s Lua)';
        if (this.lastHour(now) >= this.cfg.max_per_hour) return 'hourly limit';
        if (reward) return '';
        const recent = this.recentFor(target, now, this.cfg.cooldown_minutes * 60000);
        const same = recent.filter((g) => {
            const row = table && table[g.emotion];
            return !tendency || !row || row.tendency === tendency;
        });
        if (same.length) return 'cooldown (had 「' + same[same.length - 1].name + '」 ' + Math.round((now - same[same.length - 1].at) / 60000) + ' min ago)';
        return '';
    }

    // ------------------------------------------------------------ deciding
    // Reads what the judgement needs; null when there is nothing to judge.
    async prepare(pair, snap, exchange, before) {
        if (!this.cfg.enabled || !exchange.length || !this.d.llm.configured) return null;
        const j = this.d.journal;
        if (!this.d.cfg.journal.enabled || !j || !j.seenWithin(MOD_SEEN_MS)) {
            if (!this.quietLogged) this.log.info('buffs: the HouseholdJournal Lua mod is not reporting, chat moodlets wait for it');
            this.quietLogged = true;
            return null;
        }
        this.quietLogged = false;
        const now = Date.now();
        const people = {
            partner: { id: String(snap.partner.id), name: snap.partner.name },
            player: { id: String(snap.player.id), name: snap.player.name }
        };
        if (this.lastHour(now) >= this.cfg.max_per_hour) {
            this.log.info('buffs [' + pair.key + '] skipped: hourly limit of ' + this.cfg.max_per_hour + ' reached');
            return null;
        }
        let catalog;
        try {
            catalog = await this.ensureCatalog();
        } catch (e) {
            this.log.warn('buffs: no moodlet catalog: ' + (e && e.message || e));
            return null;
        }
        const table = await this.d.world.emotionTable();
        const emotions = this.emotionsOf(catalog, table);
        if (!emotions.length) return null;
        const recent = this.state.given
            .filter((g) => g.pair === pair.key && now - g.at < RECENT_FOR_PROMPT_MS)
            .map((g) => ({
                who: String(g.target) === people.partner.id ? 'partner' : 'player',
                name: g.name,
                emotion: g.emotion,
                minutesAgo: Math.round((now - g.at) / 60000)
            }));
        return { people, catalog, table, emotions, exchange, input: { snap, emotions, recent, exchange, before: (before || []).slice(-CONTEXT_MESSAGES) } };
    }

    // The game's emotions that have moodlets in the catalog.
    emotionsOf(catalog, table) {
        const emotions = [];
        for (const id of catalog.byEmotion.keys()) {
            const row = table[id];
            if (!row) continue;
            const names = Object.keys(row.levels).sort().map((k) => row.levels[k]).join('/');
            emotions.push({ id, names, tendency: row.tendency, strengths: Array.from(catalog.byEmotion.get(id).keys()).sort() });
        }
        return emotions;
    }

    // A story's ending (daemon.storyEnded / storyMended): the feelings are set by the ending,
    // the game's moodlet for them is picked as for a chat. people: { partner, player } as
    // { id, name }; effects: [{ who, emotion, strength, why }]. Resolves to the moodlets queued.
    async storyMood(pair, people, effects, why) {
        if (!this.cfg.enabled || !effects.length || !this.d.llm.configured) return 0;
        const j = this.d.journal;
        if (!this.d.cfg.journal.enabled || !j || !j.seenWithin(MOD_SEEN_MS)) {
            this.log.info('buffs [' + pair.key + '] story moodlets skipped: the HouseholdJournal Lua mod is not reporting');
            return 0;
        }
        let catalog;
        try {
            catalog = await this.ensureCatalog();
        } catch (e) {
            this.log.warn('buffs: no moodlet catalog: ' + (e && e.message || e));
            return 0;
        }
        const table = await this.d.world.emotionTable();
        const emotions = this.emotionsOf(catalog, table);
        if (!emotions.length) return 0;
        const before = this.state.pending.length;
        await this.apply(pair, { people, catalog, table, emotions, exchange: [{ side: 'partner', text: why }], reward: true }, why, effects);
        return this.state.pending.length - before;
    }

    async consider(pair, snap, exchange, before) {
        const ctx = await this.prepare(pair, snap, exchange, before);
        if (!ctx) return;
        const p = prompts.moodPrompt(ctx.input);
        this.log.debug('buff mood prompt:\n' + p.system + '\n' + p.user);
        let r;
        try {
            r = await this.d.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0.3, max_tokens: 500, purpose: 'mood' });
        } catch (e) {
            this.log.warn('buffs [' + pair.key + '] mood check failed: ' + (e && e.message || e));
            return;
        }
        await this.apply(pair, ctx, r && r.why, r && r.effects);
    }

    async apply(pair, ctx, thought, list) {
        const { people, catalog, table, emotions, exchange } = ctx;
        const effects = listOf(list);
        if (typeof thought === 'string' && thought.trim()) {
            this.log.info('buffs [' + pair.key + '] thinks: ' + JSON.stringify(thought.trim().slice(0, 200)) + (effects.length ? '' : ' -> no moodlet'));
        } else if (!effects.length) {
            this.log.info('buffs [' + pair.key + '] no moodlet');
        }
        const done = new Set();
        const known = new Map(emotions.map((e) => [e.id, e]));
        const exchangeText = exchange.map((m) => people[m.side].name + '：' + m.text).join('\n');
        for (const fx of effects) {
            const who = fx && (fx.who === 'partner' || fx.who === 'player') ? fx.who : null;
            if (!who || done.has(who)) continue;
            done.add(who);
            const emotion = known.get(String(fx.emotion || ''));
            if (!emotion) {
                this.log.info('buffs [' + pair.key + '] ' + people[who].name + ': unknown emotion ' + JSON.stringify(fx.emotion));
                continue;
            }
            const target = people[who];
            const initiator = people[who === 'partner' ? 'player' : 'partner'];
            const why = String(fx.why || '').trim().slice(0, 120);
            const blocked = this.canGive(target.id, Date.now(), emotion.tendency, table, !!ctx.reward);
            if (blocked) {
                this.log.info('buffs [' + pair.key + '] ' + target.name + ' would feel ' + emotion.id + ' but ' + blocked);
                continue;
            }
            const strength = Math.min(Math.max(Math.round(Number(fx.strength) || 1), 1), 3);
            const exclude = new Set(this.recentFor(target.id, Date.now(), this.cfg.repeat_minutes * 60000).map((g) => g.id));
            const opts = this.optionsFor(catalog, emotion.id, strength, exclude);
            if (!opts.list.length) {
                this.log.info('buffs [' + pair.key + '] ' + target.name + ': no unused ' + emotion.id + ' moodlet left');
                continue;
            }
            const pick = opts.list.length === 1
                ? opts.list[0]
                : await this.pick(pair, target, initiator, emotion, opts, why, exchangeText);
            if (pick) this.enqueue(pair, target, initiator, pick, why);
        }
    }

    async pick(pair, target, initiator, emotion, opts, why, exchangeText) {
        const withText = opts.list.length <= PICK_TEXT_UNDER;
        const options = opts.list.map((b) => ({
            strength: band(b.value),
            name: b.name,
            from: b.from.replace(INITIATOR_RE, initiator.name),
            text: withText ? b.text.replace(INITIATOR_RE, initiator.name).slice(0, 28) : ''
        }));
        const row = emotion.names.split('/');
        const feeling = row[Math.min(opts.strength, row.length) - 1] || emotion.id;
        const p = prompts.pickPrompt({ target: target.name, feeling, strength: opts.strength, why, exchange: exchangeText, options });
        let r;
        try {
            r = await this.d.llm.json(p.system, p.user, { thinking: 'disabled', temperature: 0.2, max_tokens: 200, purpose: 'moodlet' });
        } catch (e) {
            this.log.warn('buffs [' + pair.key + '] moodlet pick failed: ' + (e && e.message || e));
            return null;
        }
        const n = Math.round(Number(r && r.pick));
        const chosen = n >= 1 && n <= opts.list.length ? opts.list[n - 1] : null;
        const reason = r && typeof r.why === 'string' ? ' (' + r.why.trim().slice(0, 120) + ')' : '';
        if (!chosen) {
            this.log.info('buffs [' + pair.key + '] ' + target.name + ' feels ' + feeling + ', but no ' + emotion.id + ' moodlet fits a text' + reason);
            return null;
        }
        this.log.info('buffs [' + pair.key + '] ' + target.name + ' feels ' + feeling + ' -> ' + chosen.id + ' 「' + chosen.name + '」' + reason);
        return chosen;
    }

    // ------------------------------------------------------------ delivery
    enqueue(pair, target, initiator, buff, why) {
        const now = Date.now();
        const seq = Math.max(now, this.lastSeq + 1);
        this.lastSeq = seq;
        this.state.pending.push({
            seq: String(seq),
            at: now,
            pair: pair.key,
            target: target.id,
            targetName: target.name,
            initiator: initiator.id,
            initiatorName: initiator.name,
            id: buff.id,
            name: buff.name,
            emotion: buff.emotion,
            why
        });
        this.saveState();
        this.writeQueue();
    }

    // A B line from the Lua log: { seq, ok, target, buff, why }. The game writes that log in
    // bursts, so an answer can arrive after its request expired.
    onResult(res) {
        const i = this.state.pending.findIndex((p) => p.seq === res.seq);
        if (i < 0) {
            const late = this.state.given.findIndex((g) => g.unconfirmed && g.seq === res.seq);
            if (late < 0) {
                this.log.debug('buffs: result for unknown request ' + res.seq + ' (' + res.buff + ')');
                return;
            }
            const g = this.state.given[late];
            if (res.ok) {
                delete g.unconfirmed;
                this.log.info('buffs: late answer, ' + g.id + ' was added' + (res.why ? ' [' + res.why + ']' : ''));
            } else {
                this.state.given.splice(late, 1);
                this.log.warn('buffs: late answer, the game did not add ' + g.id + ': ' + (res.why || 'no reason given'));
            }
            this.saveState();
            return;
        }
        const p = this.state.pending.splice(i, 1)[0];
        if (res.ok) {
            this.state.given.push({ at: Date.now(), pair: p.pair, target: p.target, initiator: p.initiator, id: p.id, name: p.name, emotion: p.emotion });
            if (this.state.given.length > KEEP_GIVEN) this.state.given.splice(0, this.state.given.length - KEEP_GIVEN);
            this.log.info('buffs: ' + p.targetName + ' got 「' + p.name + '」 (' + p.id + ') from ' + p.initiatorName + (res.why ? ' [' + res.why + ']' : ''));
            if (this.cfg.toast) {
                this.d.game.soft('toast_show', { Message: p.targetName + '：' + p.name, Lifetime: 5 }).catch(() => {});
            }
        } else {
            this.log.warn('buffs: the game did not add ' + p.id + ' to ' + p.targetName + ': ' + (res.why || 'no reason given'));
        }
        this.saveState();
        this.writeQueue();
    }

    // An unanswered request leaves the file so it is never sent twice. It still counts for the
    // limits, since the game may well have added it.
    expire() {
        const now = Date.now();
        const limit = this.cfg.ack_timeout_s * 1000;
        const keep = [];
        for (const p of this.state.pending) {
            if (now - p.at < limit) {
                keep.push(p);
                continue;
            }
            this.log.warn('buffs: no answer from the Lua mod for ' + p.id + ' on ' + p.targetName + ' after ' + this.cfg.ack_timeout_s + 's, taken off the queue');
            this.state.given.push({ at: p.at, seq: p.seq, pair: p.pair, target: p.target, initiator: p.initiator, id: p.id, name: p.name, emotion: p.emotion, unconfirmed: true });
        }
        if (keep.length === this.state.pending.length) return;
        if (this.state.given.length > KEEP_GIVEN) this.state.given.splice(0, this.state.given.length - KEEP_GIVEN);
        this.state.pending = keep;
        this.saveState();
        this.writeQueue();
    }
}

module.exports = { Buffs, socialBuffs, readBuffStrings };
