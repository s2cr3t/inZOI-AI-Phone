'use strict';
// Likes and dislikes the AI gives the character it plays, from what the conversation, the
// surroundings and the character's mood make of it ("prefer" in the reply).
//
// The game knows a fixed list of preferences (the Preference data table: Running, Coffee,
// HorrorMovie ...); each is liked, disliked or neither. The HouseholdJournal Lua mod
// (Zoi.PreferenceSetter) sets one with the game's own AddPreferenceData, so the game shows its
// usual notice. Requests go through the mod's bridge/prefs.cfg (this module is its only writer):
//   <seq>:<character>:<preference id>:<1 like|0 dislike>;...
// and the answer comes back on the Lua log:
//   [HouseholdJournal] K <boot>,<seq>,<ok|fail>,<character>,<preference id>,<1|0>,<detail>
//
// Tastes drift slowly: a character changes at most cfg.per_game_day of them a game day. The day of
// the last change is kept in data/preferences-state.json so a restart does not reset it.
const path = require('path');
const fsx = require('./fsx');
const paths = require('./paths');

const ACK_TIMEOUT_MS = 5 * 60000;
const ID_RE = /^[A-Za-z_]+$/;

// The game's preference ids with their Chinese names, filled by load(); shared with persona.pref.
const names = new Map();

function nameOf(id) {
    return names.get(String(id || '')) || '';
}

// The choices for the reply prompt: 跑步(Running)、咖啡(Coffee) ...
function optionsText() {
    return Array.from(names.entries()).map(([id, zh]) => zh + '(' + id + ')').join('、');
}

class Preferences {
    constructor(daemon) {
        this.d = daemon;
        this.log = daemon.log;
        this.cfg = { enabled: true, per_game_day: 1 };
        this.file = '';
        this.stateFile = '';
        this.state = {};
        this.pending = [];
        this.loading = null;
    }

    configure(dataDir) {
        this.cfg = this.d.cfg.preferences || this.cfg;
        const mod = paths.findMod(paths.JOURNAL_MOD_ID);
        const file = mod ? path.join(mod, 'bridge', 'prefs.cfg') : '';
        if (file !== this.file) {
            this.file = file;
            // Nothing from an earlier run is resent: the file starts empty.
            this.pending = [];
            this.writeQueue();
        }
        if (!this.stateFile) {
            this.stateFile = path.join(dataDir, 'preferences-state.json');
            const r = fsx.readJson(this.stateFile);
            this.state = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
        }
    }

    // The game's preference list and names, read once when the game answers.
    load() {
        if (names.size || this.loading) return this.loading || Promise.resolve();
        this.loading = (async () => {
            const rows = await this.d.game.soft('data_table_get_all', { alias: 'Preference' });
            if (!Array.isArray(rows)) return;
            const keys = rows.map((r) => r && r.displayInfo && r.displayInfo.displayNameTextId).filter(Boolean);
            const text = keys.length ? await this.d.game.soft('l10n_get', { Keys: JSON.stringify(keys) }) : null;
            for (const r of rows) {
                const id = r && (r.iD || r._row_name);
                if (!id || !ID_RE.test(id)) continue;
                const key = r.displayInfo && r.displayInfo.displayNameTextId;
                const zh = text && key && typeof text[key] === 'string' && text[key] !== key ? text[key] : id;
                names.set(id, zh);
            }
            if (this.log) this.log.info('preferences: ' + names.size + ' preference(s) known');
        })().catch((e) => {
            if (this.log) this.log.warn('preferences: list not read: ' + e.message);
        }).then(() => { this.loading = null; });
        return this.loading;
    }

    usable() {
        const j = this.d.journal;
        return !!(this.cfg.enabled && this.file && names.size && this.d.cfg.journal.enabled && j && j.alive());
    }

    // Whether this character may take on or drop a taste today (game day of env).
    open(charId, env) {
        if (!this.usable() || !env || typeof env.day !== 'number') return false;
        const s = this.state[String(charId)];
        if (!s || s.day !== env.day) return true;
        return (s.count || 0) < this.cfg.per_game_day;
    }

    // The "prefer" field of a reply: [{ "id": "Coffee", "like": true, "why": "..." }].
    fromReply(pair, snap, raw) {
        const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
        if (!list.length) return;
        const charId = String(pair.partnerId);
        const env = snap && snap.env;
        if (!this.open(charId, env)) return;
        const current = (snap.partner && snap.partner.preferences) || { likes: [], dislikes: [] };
        for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const id = String(item.id || '').trim();
            if (!names.has(id) || typeof item.like !== 'boolean') continue;
            if (((item.like ? current.likes : current.dislikes) || []).indexOf(id) >= 0) continue;
            if (this.pending.some((p) => p.charId === charId)) return;
            const why = typeof item.why === 'string' ? item.why.trim().slice(0, 40) : '';
            this.request(charId, id, item.like, env, why, pair.key);
            return;
        }
    }

    request(charId, id, like, env, why, pairKey) {
        const seq = String(Date.now());
        this.pending.push({ seq, charId, id, like, why, pairKey, at: Date.now() });
        this.count(charId, env.day, 1);
        this.writeQueue();
        this.log.info('preferences [' + pairKey + '] ' + charId + ' ' + (like ? 'likes' : 'dislikes') + ' ' + nameOf(id) +
            ' (' + id + ')' + (why ? ': ' + why : ''));
    }

    count(charId, day, delta) {
        const s = this.state[charId] && this.state[charId].day === day ? this.state[charId] : { day, count: 0 };
        s.count = Math.max(0, (s.count || 0) + delta);
        this.state[charId] = s;
        try { fsx.writeJson(this.stateFile, this.state, true); } catch (e) { this.log.warn('preferences: state not saved: ' + e.message); }
    }

    // A K line from the Lua mod.
    onResult(res) {
        const i = this.pending.findIndex((p) => p.seq === res.seq);
        if (i < 0) return;
        const p = this.pending.splice(i, 1)[0];
        this.writeQueue();
        const s = this.state[p.charId];
        if (res.ok) {
            if (res.detail !== 'same') this.d.world.invalidate('prefs:' + p.charId);
            this.log.info('preferences: ' + p.charId + ' ' + (p.like ? 'likes' : 'dislikes') + ' ' + nameOf(p.id) + ' now (' + res.detail + ')');
        } else {
            // Not taken: it does not use up the day's change.
            if (s) this.count(p.charId, s.day, -1);
            this.log.info('preferences: ' + nameOf(p.id) + ' for ' + p.charId + ' not set (' + res.detail + ')');
        }
    }

    expire() {
        const now = Date.now();
        const before = this.pending.length;
        this.pending = this.pending.filter((p) => now - p.at < ACK_TIMEOUT_MS);
        if (this.pending.length !== before) {
            this.log.warn('preferences: ' + (before - this.pending.length) + ' request(s) got no answer from the Lua mod');
            this.writeQueue();
        }
    }

    // The Lua mod started again: whatever it had not answered is gone with the world it was for.
    reset() {
        if (!this.pending.length) return;
        this.pending = [];
        this.writeQueue();
    }

    writeQueue() {
        if (!this.file) return;
        const text = this.pending.map((p) => p.seq + ':' + p.charId + ':' + p.id + ':' + (p.like ? '1' : '0')).join(';');
        try {
            const now = fsx.readText(this.file);
            if (now !== null && now === text) return;
            fsx.writeAtomic(this.file, text);
        } catch (e) {
            this.log.warn('preferences: queue file not written: ' + e.message);
        }
    }
}

module.exports = { Preferences, nameOf, optionsText };
