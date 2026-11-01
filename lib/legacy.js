'use strict';
// The family's long memory. inZOI lives are short (a child is old within a few hundred game days),
// so what a person was should outlast them, and what they were as a child should read as long ago.
//
// Growing up: the Lua mod reports zoi.growth_changed, and the tracker sees age groups change
// even without it (observe). The contact's story ends gently and a new one for the new age can
// start at once (stories.js grewUp); the memories they gathered before are marked with the age
// they were (memory facts get "age", shown as （儿童时）).
//
// Dying: zoi.died. Their stories close, and one LLM call writes a short life record from their
// chats' memories and stories: who they were, what they were known for, a few moments, a
// keepsake. Every family member who lived with them carries it in their prompt afterwards
// (block), with the days since and anniversaries, and new stories may draw on it.
//
// data/legacy.json: { v, people: { id: { name, gender, ageGroup, labels: { playerId: label },
//                     grew: [{ day, from, to }] } }, departed: [record] }
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');

const V = 1;
const DEPARTED_KEEP = 30;
const SHOWN = 3;
const ANNIVERSARIES = [7, 30, 100];
const AGE_ZH = { Baby: '婴儿', Infant: '婴儿', Toddler: '幼儿', Child: '儿童', Teen: '青少年', Youth: '青年', YoungAdult: '青年', Adult: '成年', Old: '中年', Senior: '老年', Elder: '老年' };
const DEATH_ZH = { Aging: '年纪大了，寿终正寝', Vehicle: '出了车祸', Fire: '在火灾里', Starvation: '饿坏了身体', Electrocution: '触电' };

function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clean(s, max) {
    return String(typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function memberName(m) {
    return clean(m && ((m.last_name || '') + (m.first_name || '') || m.name), 40);
}

class Legacy {
    constructor(d) {
        this.d = d;
        this.log = d.log;
        this.file = '';
        this.data = { v: V, people: {}, departed: [] };
        this.writing = new Set();
    }

    configure(dataDir) {
        if (this.file) return;
        this.file = path.join(dataDir, 'legacy.json');
        const r = fsx.readJson(this.file);
        if (r.ok && isObject(r.value) && r.value.v === V) {
            this.data.people = isObject(r.value.people) ? r.value.people : {};
            this.data.departed = Array.isArray(r.value.departed) ? r.value.departed.filter(isObject).slice(-DEPARTED_KEEP) : [];
        }
    }

    save() {
        try {
            fsx.writeJson(this.file, this.data, true);
        } catch (e) {
            this.log.warn('legacy: not saved: ' + e.message);
        }
    }

    departedIds() {
        return new Set(this.data.departed.map((r) => String(r.id)));
    }

    // ------------------------------------------------------------ what the tracker sees
    // The household members as the tracker reads them (every 20 s per contact). Catches growing
    // up that happened while the Lua mod was not reporting.
    observe(members, playerId, env) {
        if (!Array.isArray(members)) return;
        let changed = false;
        const gone = this.departedIds();
        for (const m of members) {
            const id = String(m && m.entity_id || '');
            if (!id || gone.has(id)) continue;
            const p = this.data.people[id] || (this.data.people[id] = { name: '', gender: '', ageGroup: '', labels: {}, grew: [] });
            const name = memberName(m);
            if (name && p.name !== name) { p.name = name; changed = true; }
            if (m.gender && p.gender !== m.gender) { p.gender = m.gender; changed = true; }
            if (playerId && m.relationship_label && p.labels[playerId] !== m.relationship_label) {
                p.labels[playerId] = clean(m.relationship_label, 20);
                changed = true;
            }
            const age = m.age_group || '';
            if (age && p.ageGroup && age !== p.ageGroup) {
                this.grew(id, p.ageGroup, age, env, 'seen');
                changed = true;
            } else if (age && !p.ageGroup) {
                p.ageGroup = age;
                changed = true;
            }
        }
        if (changed) this.save();
    }

    // ------------------------------------------------------------ world events
    onEvent(ev, env) {
        if (!ev || !ev.event) return;
        if (ev.event === 'zoi.growth_changed') {
            const id = String(ev.a || '');
            const p = this.data.people[id];
            if (id && ev.c && (!p || p.ageGroup !== ev.c)) {
                this.grew(id, (p && p.ageGroup) || ev.b || '', ev.c, env, 'event');
                this.save();
            }
        } else if (ev.event === 'zoi.died') {
            this.died(String(ev.a || ''), String(ev.b || ''), String(ev.c) === 'true', env);
        }
    }

    grew(id, from, to, env, how) {
        const p = this.data.people[id] || (this.data.people[id] = { name: '', gender: '', ageGroup: '', labels: {}, grew: [] });
        const day = env && typeof env.day === 'number' ? env.day : null;
        p.ageGroup = to;
        p.grew = (Array.isArray(p.grew) ? p.grew : []).concat([{ day, from, to }]).slice(-10);
        this.log.info('legacy: ' + (p.name || id) + ' grew up from ' + (from || '?') + ' to ' + to + ' (' + how + ')');
        if (from) this.markMemories(id, from);
        if (this.d.stories) this.d.stories.grewUp(id, from, to, day);
    }

    // Facts a contact gathered before growing up keep the age they were then.
    markMemories(partnerId, age) {
        const dir = this.d.memory.dir;
        let names = [];
        try { names = fs.readdirSync(dir); } catch (e) { return; }
        for (const n of names) {
            const m = /^(\d+)-(\d+)\.json$/.exec(n);
            if (!m || m[2] !== partnerId) continue;
            const mem = this.d.memory.load(m[1], m[2]);
            let marked = 0;
            for (const f of mem.facts) {
                if (!f.age) { f.age = age; marked += 1; }
            }
            if (marked) {
                this.d.memory.save(m[1], m[2], mem);
                this.log.info('legacy: ' + marked + ' memory fact(s) of ' + n.slice(0, -5) + ' marked as from ' + age);
            }
        }
    }

    died(id, reason, ghost, env) {
        if (!id || this.departedIds().has(id) || this.writing.has(id)) return;
        const p = this.data.people[id] || {};
        const day = env && typeof env.day === 'number' ? env.day : null;
        // Everyone they lived with, so the record shows up in those chats.
        const family = Object.keys(this.data.people).filter((x) => x !== id);
        const record = {
            id,
            name: p.name || '一位家人',
            gender: p.gender || '',
            ageGroup: p.ageGroup || '',
            labels: p.labels || {},
            day,
            reason: DEATH_ZH[reason] || '',
            ghost: !!ghost,
            family,
            life: '',
            knownFor: [],
            moments: [],
            keepsake: '',
            stories: []
        };
        const gathered = this.gather(id);
        record.stories = gathered.stories.slice(-6);
        if (this.d.stories) this.d.stories.passedAway(id, day, record.name);
        this.log.info('legacy: ' + record.name + ' died' + (record.reason ? ' (' + record.reason + ')' : '') + ', writing their life record');
        this.writing.add(id);
        this.write(record, gathered).then((r) => {
            Object.assign(record, r);
        }, (e) => {
            this.log.warn('legacy: life record of ' + record.name + ' written without the AI: ' + (e && e.message || e));
            Object.assign(record, this.plain(gathered));
        }).then(() => {
            this.writing.delete(id);
            this.data.departed.push(record);
            this.data.departed = this.data.departed.slice(-DEPARTED_KEEP);
            this.save();
            this.log.info('legacy: kept the life of ' + record.name + ': ' + record.life);
        });
    }

    // What the bridge knows of a person: their chats' memories (theirs and others' about them)
    // and their stories.
    gather(id) {
        const out = { facts: [], episodes: [], summaries: [], stories: [] };
        let names = [];
        try { names = fs.readdirSync(this.d.memory.dir); } catch (e) { names = []; }
        for (const n of names) {
            const m = /^(\d+)-(\d+)\.json$/.exec(n);
            if (!m || (m[1] !== id && m[2] !== id)) continue;
            const mem = this.d.memory.load(m[1], m[2]);
            out.facts = out.facts.concat(mem.facts.map((f) => f.text));
            out.episodes = out.episodes.concat(mem.episodes.slice(-6).map((e) => e.text));
            if (mem.summary) out.summaries.push(clean(mem.summary, 300));
        }
        if (this.d.stories) {
            for (const s of this.d.stories.all()) {
                if (!s.key.endsWith('-' + id)) continue;
                for (const e of s.ended) out.stories.push({ title: e.title, good: !!e.good, outcome: clean(e.outcome, 100) });
                if (s.active) out.stories.push({ title: s.active.title, good: false, outcome: '还没来得及有结果' });
            }
        }
        out.facts = out.facts.slice(-40);
        out.episodes = out.episodes.slice(-16);
        return out;
    }

    async write(record, g) {
        const llm = this.d.llm;
        if (!llm || !llm.configured) throw new Error('no AI');
        const system = [
            '一个生活模拟游戏里的家人刚刚去世了。根据下面记得的事，替这个家写下这个人的一生，让家人以后能记得。',
            '只用下面真的有的内容，不要编没有的经历；温和、具体，像家里人会说的话，不煽情。',
            '只输出 JSON：{"life":"两三句话，这个人是个怎样的人、这一生","known_for":["家里人一想起就会提的事，最多3条"],' +
                '"moments":["和家人之间的具体时刻，最多3条"],"keepsake":"一件会让人想起他/她的东西或习惯（没有就空）"}'
        ].join('\n');
        const user = [
            '名字：' + record.name + (record.ageGroup ? '，去世时是' + (AGE_ZH[record.ageGroup] || record.ageGroup) : '') + (record.reason ? '，' + record.reason : '') + '。',
            g.summaries.length ? '聊天摘要：\n' + g.summaries.join('\n') : '',
            g.facts.length ? '记得的事：\n' + g.facts.map((f) => '- ' + f).join('\n') : '',
            g.episodes.length ? '一些片段：\n' + g.episodes.map((e) => '- ' + e).join('\n') : '',
            g.stories.length ? '他/她自己的心事和结果：\n' + g.stories.map((s) => '- 「' + s.title + '」' + s.outcome).join('\n') : '',
            '只输出 JSON。'
        ].filter(Boolean).join('\n');
        const r = await llm.json(system, user, { thinking: 'disabled', temperature: 0.6, max_tokens: 700, purpose: 'legacy' });
        if (!isObject(r) || !clean(r.life, 10)) throw new Error('no usable record');
        const list = (v, n, max) => (Array.isArray(v) ? v : []).map((x) => clean(x, max)).filter(Boolean).slice(0, n);
        return { life: clean(r.life, 240), knownFor: list(r.known_for, 3, 80), moments: list(r.moments, 3, 100), keepsake: clean(r.keepsake, 60) };
    }

    plain(g) {
        return { life: g.facts.length ? '家里人记得：' + g.facts.slice(-3).join('；') : '', knownFor: [], moments: g.episodes.slice(-2).map((e) => clean(e, 100)), keepsake: '' };
    }

    // ------------------------------------------------------------ the prompt
    // Who of this contact's family is gone, for the reply and proactive prompts; '' when nobody.
    block(pair, snap) {
        const mine = this.data.departed.filter((r) => Array.isArray(r.family) &&
            (r.family.indexOf(String(pair.partnerId)) >= 0 || r.family.indexOf(String(pair.playerId)) >= 0));
        if (!mine.length) return '';
        const day = snap.env && typeof snap.env.day === 'number' ? snap.env.day : null;
        const playerName = snap.player && snap.player.name ? snap.player.name : '';
        const lines = ['【不在了的家人】（真的去世了，不会再回来。是你们家的一部分）'];
        for (const r of mine.slice(-SHOWN).reverse()) {
            const since = day !== null && typeof r.day === 'number' ? day - r.day : null;
            const label = r.labels && r.labels[pair.playerId] ? '（' + playerName + '的' + r.labels[pair.playerId] + '）' : '';
            let head = r.name + label + '：';
            if (since !== null) head += since <= 0 ? '今天' : since + ' 天前';
            head += (r.reason ? r.reason + '，' : '') + '走了' + (r.ghost ? '，后来变成了幽灵，有时还能遇见' : '') + '。';
            if (since !== null && (ANNIVERSARIES.indexOf(since) >= 0 || (since > 0 && since % 100 === 0))) head += '今天是走后第 ' + since + ' 天。';
            lines.push(head + (r.life ? r.life : ''));
            if (r.knownFor && r.knownFor.length) lines.push('  一想起就会提：' + r.knownFor.join('；'));
            if (r.moments && r.moments.length) lines.push('  记得的时刻：' + r.moments.join('；'));
            if (r.keepsake) lines.push('  会让人想起的：' + r.keepsake);
        }
        lines.push('想起他们是自然的：看到他们的东西、做他们拿手的事、节日、走后的整数天时。别每次都提，也别编这里没有的细节。刚走没几天时，心里还难受，按你的性格表现。');
        return lines.join('\n');
    }

    // For the story prompt: the departed, as material a new story may use.
    storyLines(pair) {
        return this.data.departed.filter((r) => Array.isArray(r.family) && r.family.indexOf(String(pair.partnerId)) >= 0)
            .slice(-SHOWN).map((r) => r.name + (r.keepsake ? '，留下：' + r.keepsake : '') + (r.knownFor && r.knownFor.length ? '，家里人记得：' + r.knownFor[0] : ''));
    }
}

module.exports = { Legacy, AGE_ZH };
