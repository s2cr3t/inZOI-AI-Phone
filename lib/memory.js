'use strict';
// Persistent per-couple memory (rolling summary + remembered facts), a per-character activity
// diary sampled from the game, and small bridge state (proactive message bookkeeping).
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');

const FACTS_V = 2;
// Two facts sharing this much of their rarer wording say the same thing.
const SAME_FACT = 0.75;

function loadJson(file, fallback) {
    const r = fsx.readJson(file);
    return r.ok && r.value && typeof r.value === 'object' ? r.value : fallback;
}

// Pairs of characters within one clause; punctuation splits clauses so no pair spans two.
function factGrams(text) {
    const out = new Set();
    for (const part of String(text || '').toLowerCase().split(/[^\u3400-\u9fffa-z0-9]+/)) {
        for (let i = 0; i + 1 < part.length; i++) out.add(part.slice(i, i + 2));
    }
    return out;
}

// Pairs in most of the facts (names, 喜欢) say nothing about which thing a fact is about.
function commonGrams(grams) {
    const df = new Map();
    for (const g of grams) for (const x of g) df.set(x, (df.get(x) || 0) + 1);
    const bar = Math.max(3, grams.length * 0.25);
    const common = new Set();
    for (const [x, n] of df) if (n > bar) common.add(x);
    return common;
}

// How much of a (0..1) is also in b, rare pairs only.
function covered(a, b, common) {
    let n = 0;
    let hit = 0;
    for (const x of a) {
        if (common.has(x)) continue;
        n += 1;
        if (b.has(x)) hit += 1;
    }
    return n ? hit / n : 0;
}

// The remembered fact that already says what text says, and whether text says more.
function sameFact(facts, text) {
    if (!facts.length) return null;
    const grams = facts.map((f) => factGrams(f.text));
    const g = factGrams(text);
    const common = commonGrams(grams.concat([g]));
    let best = null;
    for (let i = 0; i < facts.length; i++) {
        const inOld = covered(g, grams[i], common);
        const inNew = covered(grams[i], g, common);
        const score = Math.max(inOld, inNew);
        if (score < SAME_FACT || (best && best.score >= score)) continue;
        best = { index: i, score, wider: inNew >= SAME_FACT && inOld < SAME_FACT };
    }
    return best;
}

class MemoryStore {
    constructor(dataDir, cfg) {
        this.dir = path.join(dataDir, 'memory');
        this.cfg = cfg;
    }

    file(playerId, partnerId) {
        return path.join(this.dir, playerId + '-' + partnerId + '.json');
    }

    load(playerId, partnerId) {
        const m = loadJson(this.file(playerId, partnerId), {});
        return {
            summary: typeof m.summary === 'string' ? m.summary : '',
            facts: Array.isArray(m.facts) ? m.facts.filter((f) => f && typeof f.text === 'string') : [],
            episodes: Array.isArray(m.episodes) ? m.episodes.filter((e) => e && typeof e.text === 'string') : [],
            summarizedUpTo: typeof m.summarizedUpTo === 'number' ? m.summarizedUpTo : 0,
            // 2: the facts were gone through once for repeats and things that are no longer so.
            tidied: typeof m.tidied === 'number' ? m.tidied : 0,
            updatedAt: m.updatedAt || 0
        };
    }

    // One stretch of the conversation folded into the summary, kept on its own so it can be
    // found again by topic after the summary has moved on.
    addEpisode(mem, episode, topics, day, at) {
        const keep = typeof this.cfg.max_episodes === 'number' ? this.cfg.max_episodes : 150;
        const text = String(episode || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        if (!keep || text.length < 4) return false;
        const tags = (Array.isArray(topics) ? topics : [])
            .map((t) => String(t || '').trim().slice(0, 12))
            .filter((t) => t.length >= 1)
            .slice(0, 8);
        const e = { text, topics: tags, at: at || Date.now() };
        if (typeof day === 'number') e.day = day;
        mem.episodes.push(e);
        if (mem.episodes.length > keep) mem.episodes = mem.episodes.slice(mem.episodes.length - keep);
        return true;
    }

    save(playerId, partnerId, mem) {
        mem.updatedAt = Date.now();
        fsx.writeJson(this.file(playerId, partnerId), mem, true);
    }

    // Forgets what was said. The diary is a separate record and is left alone.
    clearAll() {
        let names = [];
        try { names = fs.readdirSync(this.dir); } catch (e) { return 0; }
        let count = 0;
        for (let i = 0; i < names.length; i++) {
            if (!names[i].endsWith('.json')) continue;
            fsx.writeJson(path.join(this.dir, names[i]), {
                summary: '',
                facts: [],
                episodes: [],
                summarizedUpTo: 0,
                tidied: FACTS_V,
                updatedAt: Date.now()
            }, true);
            count += 1;
        }
        return count;
    }

    // day: the game day it was learned on, so it can later be told as "3 天前".
    addFacts(playerId, partnerId, facts, day) {
        const list = (Array.isArray(facts) ? facts : [])
            .map((f) => String(f || '').replace(/\s+/g, ' ').trim())
            .filter((f) => f.length >= 2 && f.length <= 80);
        if (!list.length || !this.cfg.max_facts) return 0;
        const mem = this.load(playerId, partnerId);
        let added = 0;
        let changed = false;
        for (const text of list) {
            if (mem.facts.some((f) => f.text === text)) continue;
            // Said again in other words: kept once, in the fuller wording.
            const same = sameFact(mem.facts, text);
            if (same) {
                if (same.wider) {
                    const old = mem.facts[same.index];
                    old.text = text;
                    if (typeof day === 'number') old.day = day;
                    changed = true;
                }
                continue;
            }
            const f = { text, at: Date.now() };
            if (typeof day === 'number') f.day = day;
            mem.facts.push(f);
            added += 1;
        }
        const keep = Math.max(this.cfg.max_facts, this.cfg.keep_facts || 0);
        if (mem.facts.length > keep) mem.facts = mem.facts.slice(mem.facts.length - keep);
        if (added || changed) this.save(playerId, partnerId, mem);
        return added;
    }

    // What the summary said about the facts it was shown: listed[n - 1] is fact n of the prompt.
    // A fact written meanwhile is not among them and is left alone.
    reviseFacts(playerId, partnerId, listed, revise, drop) {
        const mem = this.load(playerId, partnerId);
        const find = (n) => {
            const f = listed[Number(n) - 1];
            if (!f) return -1;
            return mem.facts.findIndex((x) => x.at === f.at && x.text === f.text);
        };
        let revised = 0;
        for (const r of Array.isArray(revise) ? revise : []) {
            const i = r ? find(r.n) : -1;
            const text = r && String(r.text || '').replace(/\s+/g, ' ').trim();
            if (i < 0 || !text || text.length < 2 || text.length > 80) continue;
            mem.facts[i].text = text;
            revised += 1;
        }
        const gone = new Set();
        for (const n of Array.isArray(drop) ? drop : []) {
            const i = find(n);
            if (i >= 0) gone.add(i);
        }
        // Most of the facts at once would be the model misreading the task, not the facts.
        if (gone.size > Math.max(3, listed.length * 0.5)) gone.clear();
        if (gone.size) mem.facts = mem.facts.filter((f, i) => !gone.has(i));
        if (revised || gone.size) this.save(playerId, partnerId, mem);
        return { revised, dropped: gone.size };
    }

    // The facts replaced by a gone-through list (tidy); one written meanwhile stays at the end.
    replaceFacts(playerId, partnerId, listed, next) {
        const mem = this.load(playerId, partnerId);
        const was = new Set(listed.map((f) => f.at + '|' + f.text));
        const meanwhile = mem.facts.filter((f) => !was.has(f.at + '|' + f.text));
        mem.facts = next.concat(meanwhile);
        mem.tidied = FACTS_V;
        this.save(playerId, partnerId, mem);
        return mem.facts.length;
    }

    markTidied(playerId, partnerId) {
        const mem = this.load(playerId, partnerId);
        mem.tidied = FACTS_V;
        this.save(playerId, partnerId, mem);
    }

    // Couples whose facts were never gone through: [{ playerId, partnerId }].
    untidied() {
        let names = [];
        try { names = fs.readdirSync(this.dir); } catch (e) { return []; }
        const out = [];
        for (const n of names) {
            const m = /^(\d+)-(\d+)\.json$/.exec(n);
            if (!m) continue;
            if (this.load(m[1], m[2]).tidied < FACTS_V) out.push({ playerId: m[1], partnerId: m[2] });
        }
        return out;
    }

    // A copy of the file as it is, before it is gone through.
    backup(playerId, partnerId, backupDir) {
        const r = fsx.readJson(this.file(playerId, partnerId));
        if (!r.ok) return null;
        const file = path.join(backupDir, playerId + '-' + partnerId + '-' + Date.now() + '.json');
        fsx.writeJson(file, r.value, true);
        return file;
    }

    // Messages older than the newest keep_recent, not yet folded into the summary.
    summarizeCandidates(mem, messages) {
        const fresh = messages.filter((m) => m.at > mem.summarizedUpTo);
        if (fresh.length < this.cfg.summarize_after + this.cfg.keep_recent) return null;
        return fresh.slice(0, fresh.length - this.cfg.keep_recent);
    }
}

class Diary {
    constructor(dataDir, keep) {
        this.dir = path.join(dataDir, 'diary');
        this.keep = keep || 40;
        this.cache = new Map();
    }

    file(id) {
        return path.join(this.dir, id + '.json');
    }

    list(id) {
        if (!this.cache.has(id)) {
            const v = loadJson(this.file(id), []);
            this.cache.set(id, Array.isArray(v) ? v : []);
        }
        return this.cache.get(id);
    }

    // Records an entry only when activity or place changed since the last entry.
    record(id, entry) {
        const list = this.list(id);
        const last = list[list.length - 1];
        if (last && last.act === entry.act && last.site === entry.site && last.boot === entry.boot) return false;
        list.push(entry);
        while (list.length > this.keep) list.shift();
        fsx.writeJson(this.file(id), list, true);
        return true;
    }

    // boot: the Lua mod's start id of the world now loaded. Entries of another loaded save (or
    // written before entries carried one) describe things that did not happen in this world.
    today(id, gameDay, boot) {
        return this.list(id).filter((e) => e.day === gameDay && (!boot || e.boot === boot));
    }
}

class BridgeState {
    constructor(dataDir) {
        this.file = path.join(dataDir, 'state.json');
        this.value = loadJson(this.file, {});
        if (!this.value.pairs || typeof this.value.pairs !== 'object') this.value.pairs = {};
        if (!Array.isArray(this.value.proactive)) this.value.proactive = [];
    }

    pair(key) {
        if (!this.value.pairs[key]) this.value.pairs[key] = { proactive: [], lastIdleCheck: 0, work: null, site: null, lateDay: null };
        const p = this.value.pairs[key];
        if (!Array.isArray(p.proactive)) p.proactive = [];
        return p;
    }

    // Timestamps of every proactive message, across all conversations.
    totalProactive(now) {
        this.value.proactive = this.value.proactive.filter((ts) => now - ts < 3600000);
        return this.value.proactive;
    }

    save() {
        fsx.writeJson(this.file, this.value, true);
    }
}

module.exports = { MemoryStore, Diary, BridgeState, sameFact, factGrams, FACTS_V };
