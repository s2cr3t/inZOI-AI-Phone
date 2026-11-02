'use strict';
// Read-only view of the running game: who is played, which household members they can text,
// and what both sides of a conversation are doing right now. Everything here is gathered
// through game MCP read tools.
const { GameOfflineError } = require('./game');
const { isScheduledBag } = require('./schedule');
const { GameSchedule } = require('./gamesched');

class PairError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PairError';
        this.code = code;
    }
}

function fullName(m) {
    if (!m) return '';
    const name = (m.last_name || '') + (m.first_name || '');
    return name || m.name || ('#' + m.entity_id);
}

const GROWTH_ORDER = { Baby: 0, Infant: 0, Toddler: 1, Child: 2, Teen: 3, Youth: 4, YoungAdult: 4, Adult: 5, Elder: 6 };
const NO_PHONE = { Baby: true, Infant: true, Toddler: true };
const AGE_ZH = { Baby: '婴儿', Infant: '婴儿', Toddler: '幼儿', Child: '儿童', Teen: '青少年', Youth: '青年', YoungAdult: '青年', Adult: '成年', Old: '中年', Elder: '老年' };

// Characters further than this, or not spawned near the played character, count as not nearby.
// Interactions that eat or drink (PreparedCake_EatServedCake, Eat_Fridge_Served_*, Coop_CoEat_*).
const EAT_RE = /Eat|Drink/i;
// Hunger points (whole %) it must rise by for the eating to count as begun.
const EAT_RISE = 1;
const SCAN_RADIUS_M = 60;
const SCAN_LIMIT = 100;

function canText(m) {
    return !!m && !NO_PHONE[m.age_group];
}

function isMinor(m) {
    const g = GROWTH_ORDER[m && m.age_group];
    return g !== undefined && g <= GROWTH_ORDER.Teen;
}

// The game's relationship_label says what a member is to the possessed character, and only that.
// Kinship between two other members is worked out through the possessed character: the sister of
// the kids' mother is their aunt, not a second mother. Age alone decides only when the labels
// cannot tell (a member with no label, or two people the labels do not connect).
const PARENT_RE = /^(爸爸|妈妈|父亲|母亲|继父|继母|养父|养母|father|mother|dad|mom|stepfather|stepmother)$/i;
const CHILD_RE = /^(儿子|女儿|继子|继女|养子|养女|son|daughter|stepson|stepdaughter|child)$/i;
const SIBLING_RE = /^(兄弟|姐妹|哥哥|弟弟|姐姐|妹妹|兄妹|姐弟|brother|sister|sibling)$/i;
const GRANDPARENT_RE = /^(爷爷|奶奶|外公|外婆|姥爷|姥姥|祖父|祖母|grandfather|grandmother|grandpa|grandma|grandparent)$/i;
const GRANDCHILD_RE = /^(孙子|孙女|外孙|外孙女|grandson|granddaughter|grandchild)$/i;

function isSpouse(a, b) {
    return String(a.spouse_id) === String(b.entity_id) || String(b.spouse_id) === String(a.entity_id);
}

function maleOf(m) { return /^m/i.test(String(m && m.gender || '')); }

// What `m` is to the possessed character `p`: self | spouse | parent | child | sibling |
// grandparent | grandchild | other (a label that is not kin, such as 室友) | '' (no label).
function kinToPossessed(m, p) {
    if (String(m.entity_id) === String(p.entity_id)) return 'self';
    if (isSpouse(m, p)) return 'spouse';
    const label = String(m.relationship_label || '').trim();
    if (!label || label === '…') return '';
    if (PARENT_RE.test(label)) return 'parent';
    if (CHILD_RE.test(label)) return 'child';
    if (SIBLING_RE.test(label)) return 'sibling';
    if (GRANDPARENT_RE.test(label)) return 'grandparent';
    if (GRANDCHILD_RE.test(label)) return 'grandchild';
    return 'other';
}

function siblingWord(player, contact) {
    const p = GROWTH_ORDER[player.age_group];
    const c = GROWTH_ORDER[contact.age_group];
    const male = maleOf(contact);
    if (p !== undefined && c !== undefined && c > p) return male ? '哥哥' : '姐姐';
    if (p !== undefined && c !== undefined && c < p) return male ? '弟弟' : '妹妹';
    return male ? '兄弟' : '姐妹';
}

function ageRole(player, contact) {
    const p = GROWTH_ORDER[player.age_group];
    const c = GROWTH_ORDER[contact.age_group];
    if (p !== undefined && c !== undefined) {
        if (isMinor(contact) && !isMinor(player) && p > c) return 'child';
        if (isMinor(player) && !isMinor(contact) && c > p) return 'parent';
    }
    return 'family';
}

// What `contact` is to `player`, from the possessed character's labels. null when they cannot tell.
function kinByLabels(player, contact, possessed) {
    const a = kinToPossessed(player, possessed);
    const b = kinToPossessed(contact, possessed);
    if (!a || !b) return null;
    const pMale = maleOf(possessed);
    const cMale = maleOf(contact);
    const fam = (label) => ({ role: 'family', label: label || '' });
    if (a === 'self') {
        if (b === 'parent' || b === 'child' || b === 'spouse') return { role: b, label: '' };
        return fam(String(contact.relationship_label).trim());
    }
    if (b === 'self') {
        if (a === 'parent') return { role: 'child', label: '' };
        if (a === 'child') return { role: 'parent', label: '' };
        if (a === 'spouse') return { role: 'spouse', label: '' };
        if (a === 'sibling') return fam(siblingWord(player, contact));
        if (a === 'grandparent') return fam(cMale ? '孙子' : '孙女');
        if (a === 'grandchild') return fam(cMale ? '爷爷' : '奶奶');
        return fam('');
    }
    const pair = a + '/' + b;
    switch (pair) {
        case 'child/spouse': return { role: 'parent', label: '' };
        case 'spouse/child': return { role: 'child', label: '' };
        case 'parent/sibling': return { role: 'child', label: '' };
        case 'sibling/parent': return { role: 'parent', label: '' };
        case 'child/child':
        case 'sibling/sibling': return fam(siblingWord(player, contact));
        case 'child/sibling': return fam(pMale ? (cMale ? '叔叔' : '姑姑') : (cMale ? '舅舅' : '姨妈'));
        case 'sibling/child': return fam(pMale ? (cMale ? '侄子' : '侄女') : (cMale ? '外甥' : '外甥女'));
        case 'child/parent': return fam(pMale ? (cMale ? '爷爷' : '奶奶') : (cMale ? '外公' : '外婆'));
        case 'parent/child': return fam(pMale ? (cMale ? '孙子' : '孙女') : (cMale ? '外孙' : '外孙女'));
        case 'parent/parent':
        case 'spouse/sibling':
        case 'sibling/spouse': return fam('');
    }
    // Anything else (a grandchild and a child of the possessed one, a nephew and the possessed
    // one's sister, a label not listed above) may still be parent and child.
    return null;
}

// Relationship of `contact` to `player`: { role: spouse | child | parent | family, label }.
// label is the family word for `family` (姨妈, 哥哥 ...) when it is known, '' otherwise.
// hh: { members, possessed } from World.household(); without it only age decides.
function kinOf(player, contact, hh) {
    if (isSpouse(player, contact)) return { role: 'spouse', label: '' };
    const pid = hh && hh.possessed;
    const possessed = pid && hh.members ? hh.members.find((m) => String(m.entity_id) === String(pid)) : null;
    const byLabels = possessed ? kinByLabels(player, contact, possessed) : null;
    return byLabels || { role: ageRole(player, contact), label: '' };
}

function roleOf(player, contact, hh) {
    return kinOf(player, contact, hh).role;
}

const NEED_LABELS = {
    Hunger: '饥饿', Sleep: '困倦', Energy: '体力', Fun: '娱乐', Society: '社交',
    Cleanliness: '清洁', Toilet: '如厕', Admit: '认可'
};

class World {
    constructor(game, log) {
        this.game = game;
        this.log = log;
        this.cache = new Map();
        this.gameSched = new GameSchedule(log);
        // Eat tasks seen per character: { key, hunger, begun, at } (eatProgress).
        this.eats = new Map();
    }

    // The game names an eat task from its first step: walking over, picking the plate up,
    // sitting down. Holding the food is not eating either. The eating has begun once Hunger has
    // gone up since the task was first seen; the tracker looks every 20 s, so a meal well under
    // way has been seen rise. Sets activity.begun (eat tasks only) and returns it.
    eatProgress(actorId, activity, needs) {
        const id = String(actorId);
        if (!activity || activity.idle || !EAT_RE.test(String(activity.id || ''))) {
            this.eats.delete(id);
            return undefined;
        }
        const hunger = needs && typeof needs.Hunger === 'number' ? needs.Hunger : null;
        const key = activity.id + '@' + (activity.target || '');
        let e = this.eats.get(id);
        if (!e || e.key !== key) {
            e = { key, hunger, begun: false, at: Date.now() };
            this.eats.set(id, e);
        } else if (!e.begun && hunger !== null) {
            if (e.hunger === null) e.hunger = hunger;
            else if (hunger >= e.hunger + EAT_RISE) {
                e.begun = true;
                if (this.log) this.log.info('eat [' + id + '] ' + activity.id + ' has begun (Hunger ' + e.hunger + '% -> ' + hunger + '% after ' + Math.round((Date.now() - e.at) / 1000) + 's)');
            } else if (hunger < e.hunger) {
                // Hunger only drops before the first bite: the lowest point is where eating starts from.
                e.hunger = hunger;
            }
        }
        activity.begun = e.begun;
        return e.begun;
    }

    async cached(key, ttlMs, fn) {
        const hit = this.cache.get(key);
        if (hit && Date.now() - hit.at < ttlMs) return hit.value;
        const value = await fn();
        this.cache.set(key, { at: Date.now(), value });
        return value;
    }

    invalidate(prefix) {
        for (const k of Array.from(this.cache.keys())) {
            if (!prefix || k.startsWith(prefix)) this.cache.delete(k);
        }
    }

    async phase() {
        const s = await this.game.call('game_get_state', {});
        return s && s.phase ? String(s.phase) : 'unknown';
    }

    possessed() {
        return this.cached('possessed', 2000, async () => {
            const r = await this.game.call('entity_get_possessed', {});
            return r && r.entity_id !== undefined ? String(r.entity_id) : null;
        });
    }

    // entity_id -> distance in metres from the possessed character, for everyone within SCAN_RADIUS_M.
    // One scan is shared by every contact checked within the same few seconds.
    scanAroundPossessed() {
        return this.cached('scan', 3000, async () => {
            const r = await this.game.call('entity_scan_characters', { Radius: SCAN_RADIUS_M, ref: 'pawn', sort: 'distance', Limit: SCAN_LIMIT });
            const map = new Map();
            const list = r && Array.isArray(r.characters) ? r.characters : [];
            for (const c of list) {
                if (c && c.entity_id !== undefined && typeof c.distance === 'number' && isFinite(c.distance)) map.set(String(c.entity_id), c.distance);
            }
            return map;
        });
    }

    // How close the contact is to the character being played. near = close enough to just talk.
    // Distances are measured from the possessed character, so they are only used when that is the
    // pair's player; otherwise, or when the scan fails, being at the same site counts as near.
    async proximity(pair, nearMeters) {
        const pSite = pair.partner.current_site || '';
        const wSite = pair.player.current_site || '';
        const sameSite = !!(pSite && wSite && pSite === wSite);
        const fallback = { distance: null, near: sameSite, sameSite, source: 'site' };
        const possessed = await this.possessed();
        if (String(possessed) !== String(pair.playerId)) return fallback;
        let map;
        try {
            map = await this.scanAroundPossessed();
        } catch (e) {
            if (e instanceof GameOfflineError) throw e;
            this.log.debug('proximity scan failed, using sites: ' + e.message);
            return fallback;
        }
        const distance = map.has(String(pair.partnerId)) ? map.get(String(pair.partnerId)) : null;
        return { distance, near: distance !== null && distance <= nearMeters, sameSite, source: 'scan' };
    }

    household() {
        return this.cached('household', 4000, async () => {
            const r = await this.game.call('household_get_members', {});
            // Who the labels are written for (kinOf).
            let possessed = null;
            try { possessed = await this.possessed(); } catch (e) { if (e instanceof GameOfflineError) throw e; }
            return { id: r && r.household_id, members: (r && r.members) || [], possessed };
        });
    }

    sites() {
        return this.cached('sites', 10 * 60000, async () => {
            const r = await this.game.soft('world_get_loaded_sites', {});
            const list = ((r && r.sites) || []).map((s) => ({ id: String(s.id), name: String(s.l10n || s.id), entity_id: String(s.entity_id) }));
            const byName = new Map();
            const byId = new Map();
            const byEntity = new Map();
            for (const s of list) {
                if (!byName.has(s.name)) byName.set(s.name, s);
                byId.set(s.id, s);
                byEntity.set(s.entity_id, s);
            }
            return { list, byName, byId, byEntity };
        });
    }

    emotionTable() {
        return this.cached('emotions', 3600000, async () => {
            const r = await this.game.soft('emotion_list_all', {});
            const table = {};
            for (const e of (r && r.emotions) || []) {
                const levels = {};
                for (const l of e.levels || []) levels[l.level] = l.l10n;
                table[e.id] = { tendency: e.tendency, levels };
            }
            return table;
        });
    }

    facialIds() {
        return this.cached('facial', 3600000, async () => {
            const r = await this.game.soft('facial_list', {});
            return ((r && r.expressions) || []).map((e) => ({ id: String(e.id), name: String(e.l10n || e.id) }));
        });
    }

    traits(id) {
        return this.cached('traits:' + id, 30 * 60000, async () => {
            const r = await this.game.soft('entity_reflect', { entity_id: String(id), Component: 'FB2TraitComponent' });
            return {
                traits: (r && r.traitIdList) || [],
                characteristics: (r && r.characteristics) || [],
                aptitudes: (r && r.aptitudes) || []
            };
        });
    }

    preferences(id) {
        return this.cached('prefs:' + id, 30 * 60000, async () => {
            const r = await this.game.soft('entity_reflect', { entity_id: String(id), Component: 'FB2PreferenceComponent' });
            const map = (r && r.preferenceMap) || {};
            const likes = [];
            const dislikes = [];
            for (const k of Object.keys(map)) (map[k] ? likes : dislikes).push(k);
            return { likes, dislikes };
        });
    }

    // The game's title of a schedule entry from its ScheduleInfo row ("音乐比赛"); '' when it is a
    // template the game fills in itself ("{SiteName:{0}}") or unknown.
    scheduleTitle(name) {
        return this.cached('schedtitle:' + name, 3600000, async () => {
            const row = await this.game.soft('data_table_get', { alias: 'ScheduleInfo', row: name });
            const key = row && row.titleText;
            if (!key) return '';
            const t = await this.game.soft('l10n_get', { Keys: JSON.stringify([key]) });
            const v = t && typeof t[key] === 'string' && t[key] !== key ? t[key] : '';
            return v.indexOf('{') >= 0 ? '' : v;
        });
    }

    // A character's week from the game's schedule (lib/gamesched.js) with places named and titles
    // in words; null while the Lua mod has not written it.
    async gameSchedule(id, sites) {
        const list = this.gameSched.entriesOf(id);
        if (!list) return null;
        const names = Array.from(new Set(list.map((e) => e.name).filter(Boolean)));
        const titles = {};
        await Promise.all(names.map(async (n) => { titles[n] = await this.scheduleTitle(n); }));
        return list.map((e) => {
            const site = e.site && sites && sites.byId.get(e.site);
            return Object.assign({}, e, { siteName: site ? site.name : '', titleText: titles[e.name] || '' });
        });
    }

    // The character's fixed timetable from the game (FB2TimelineComponent careerTimelineParams):
    // [{ kind: 'Business'|'School'|..., days: ['Monday', ...], start: 1000, end: 1700 (HHmm),
    //    remoteFlags, vacationFlags (bits by EB1DayOfWeek, Monday = 1), holidayOff, bag }].
    timetable(id) {
        return this.cached('timetable:' + id, 30 * 60000, async () => {
            const r = await this.game.soft('entity_reflect', { entity_id: String(id), Component: 'FB2TimelineComponent' });
            const params = (r && r.careerTimelineParams) || {};
            const out = [];
            for (const k of Object.keys(params)) {
                const p = params[k];
                const hours = p && p.workHour;
                if (!p || !hours || !Array.isArray(p.workDays) || !p.workDays.length) continue;
                if (typeof hours.startTime !== 'number' || typeof hours.endTime !== 'number' || hours.startTime === hours.endTime) continue;
                out.push({
                    kind: String(p.careerType || k),
                    days: p.workDays.map(String),
                    start: hours.startTime,
                    end: hours.endTime,
                    remoteFlags: Number(p.remoteWorkDayFlags) || 0,
                    vacationFlags: Number(p.vacationDayFlags) || 0,
                    holidayOff: p.bHolidayOff !== false,
                    bag: p.rabbitholeInteractionBagId && p.rabbitholeInteractionBagId !== 'None' ? String(p.rabbitholeInteractionBagId) : ''
                });
            }
            return out;
        });
    }

    characterInfo(id) {
        return this.cached('info:' + id, 10 * 60000, () => this.game.soft('entity_get_character_info', { entity_id: String(id) }));
    }

    // Everyone the character knows: [{ id, name, isFamily, stats: { Friendship, Romance, Family, Business } }].
    relations(id) {
        return this.cached('rel:' + id, 60000, async () => {
            const r = await this.game.soft('relationships_list', { owner_id: String(id) });
            const out = [];
            for (const x of (r && Array.isArray(r.relationships)) ? r.relationships : []) {
                if (!x || x.target_id === undefined) continue;
                const stats = {};
                for (const k of Object.keys(x.stats || {})) {
                    if (x.stats[k] && typeof x.stats[k].value === 'number') stats[k] = Math.round(x.stats[k].value);
                }
                out.push({ id: String(x.target_id), name: fullName(x), isFamily: !!x.is_family, stats });
            }
            return out;
        });
    }

    // Localized job of any character: { kind: 'business' | 'school' | 'club', job, rank } or null.
    job(id) {
        return this.cached('job:' + id, 30 * 60000, async () => {
            const career = await this.game.soft('entity_reflect', { entity_id: String(id), Component: 'FB2CareerComponent' });
            const slots = career && career.careerSlots;
            if (!slots) return null;
            let kind = null;
            let slot = null;
            for (const k of ['business', 'school', 'club']) {
                const s = slots[k];
                if (s && s.careerDtId && s.careerDtId !== 'None') { kind = k; slot = s; break; }
            }
            if (!slot) return null;
            const row = await this.game.soft('data_table_get', { Alias: 'Career', Row: slot.careerDtId });
            const orgs = (row && Array.isArray(row.organizations)) ? row.organizations : [];
            const org = orgs.find((o) => o && o.jobId === slot.jobDtId) || null;
            if (!org) return null;
            const rankRow = Array.isArray(org.rankList) ? org.rankList.find((r) => r && r.rank === slot.rank) : null;
            const keys = [org.displayName, rankRow && rankRow.rankName].filter((k) => typeof k === 'string' && k && k !== 'None');
            const text = keys.length ? (await this.game.soft('l10n_get', { Keys: JSON.stringify(keys) })) || {} : {};
            const tr = (k) => (k && typeof text[k] === 'string' && text[k] && text[k] !== k ? text[k] : '');
            const job = tr(org.displayName);
            if (!job) return null;
            return { kind, job, rank: rankRow ? tr(rankRow.rankName) : '' };
        });
    }

    // What a post or comment author is like, for any character (household member or not).
    async profile(id) {
        const key = String(id);
        const hh = await this.household();
        const member = hh.members.find((m) => String(m.entity_id) === key) || null;
        const [info, traits, prefs, job, emo, cur, table] = await Promise.all([
            this.characterInfo(key),
            this.traits(key),
            this.preferences(key),
            this.job(key),
            this.game.soft('emotion_get_current', { entity_id: key }),
            this.game.soft('interaction_get_current', { entity_id: key }),
            this.emotionTable()
        ]);
        const src = member || info || {};
        const ageGroup = (member && member.age_group) || (info && info.growth_step) || '';
        return {
            id: key,
            name: fullName(src),
            firstName: src.first_name || '',
            gender: src.gender || (info && info.gender) || '',
            ageGroup,
            age: (member && member.age_group_text) || AGE_ZH[ageGroup] || ageGroup,
            household: !!member,
            site: member ? member.current_site || null : null,
            job,
            traits,
            preferences: prefs,
            emotion: this.emotionOf(table, emo),
            activity: this.activityOf(cur)
        };
    }

    // Household members the given character can text (spouse first, then oldest to youngest).
    async contacts(playerId) {
        const hh = await this.household();
        const player = hh.members.find((m) => String(m.entity_id) === String(playerId));
        if (!player || !canText(player)) return [];
        return hh.members
            .filter((m) => String(m.entity_id) !== String(playerId) && canText(m))
            .map((m) => ({ member: m, role: roleOf(player, m, hh) }))
            .sort((a, b) => (a.role === 'spouse' ? -1 : 0) - (b.role === 'spouse' ? -1 : 0) ||
                (GROWTH_ORDER[b.member.age_group] || 0) - (GROWTH_ORDER[a.member.age_group] || 0));
    }

    // Resolves a conversation between a household member (the phone owner) and a contact.
    async pair(playerId, contactId) {
        const hh = await this.household();
        const members = hh.members;
        const player = members.find((m) => String(m.entity_id) === String(playerId));
        if (!player) throw new PairError('not_in_household', 'character ' + playerId + ' is not in the active household');
        // A baby or a toddler has no phone: nobody texts them and they text nobody.
        if (!canText(player)) throw new PairError('cannot_text', fullName(player) + ' is too young to text');
        const partner = members.find((m) => String(m.entity_id) === String(contactId));
        if (!partner) return this.outsiderPair(player, contactId, hh);
        if (!canText(partner)) throw new PairError('cannot_text', fullName(partner) + ' is too young to text');
        const possessed = await this.possessed();
        // relationship_label is written from the possessed character's point of view.
        const fromPlayer = String(possessed) === String(playerId);
        const kin = kinOf(player, partner, hh);
        return {
            key: String(player.entity_id) + '-' + String(partner.entity_id),
            playerId: String(player.entity_id),
            partnerId: String(partner.entity_id),
            player,
            partner,
            members,
            role: kin.role,
            label: kin.label || (fromPlayer ? (partner.relationship_label || '') : ''),
            labelsFromPlayer: fromPlayer,
            household: hh,
            householdId: hh.id
        };
    }

    // The game phone's contacts of the possessed character (contacts_get_all).
    phoneContacts() {
        return this.cached('phone-contacts', 60000, async () => {
            const r = await this.game.call('contacts_get_all', {});
            return (r && Array.isArray(r.contacts)) ? r.contacts : [];
        });
    }

    // A conversation with someone outside the household: anyone in the played character's game
    // phone contacts old enough for a phone. Only the possessed character's phone has that list,
    // so only they can text outside. role: relative | romance | close_friend | friend |
    // colleague | acquaintance, from the game's label and the bonds.
    async outsiderPair(player, contactId, hh) {
        const possessed = await this.possessed();
        if (String(possessed) !== String(player.entity_id)) {
            throw new PairError('contact_elsewhere', 'only the played character can text people outside the household');
        }
        const list = await this.phoneContacts();
        const partner = list.find((c) => String(c.entity_id) === String(contactId));
        if (!partner) throw new PairError('contact_elsewhere', 'character ' + contactId + ' is not in the phone contacts');
        if (!canText(partner)) throw new PairError('cannot_text', fullName(partner) + ' is too young to text');
        const rel = await this.game.soft('relationships_get_value_between', { owner_id: String(player.entity_id), target_id: String(contactId) });
        const stat = (k) => rel && rel.stats && rel.stats[k] && typeof rel.stats[k].value === 'number' ? rel.stats[k].value : 0;
        const level = (k) => rel && rel.stats && rel.stats[k] && typeof rel.stats[k].level === 'number' ? rel.stats[k].level : 0;
        const label = partner.relationship_label && partner.relationship_label !== '…' ? partner.relationship_label : '';
        let role = 'acquaintance';
        if (label || (rel && rel.is_family)) role = 'relative';
        else if (stat('Romance') >= 20 && stat('Romance') >= stat('Friendship')) role = 'romance';
        else if (level('Friendship') >= 2) role = 'close_friend';
        else if (stat('Friendship') >= 20) role = 'friend';
        else if (stat('Business') >= 10 && stat('Business') >= stat('Friendship')) role = 'colleague';
        return {
            key: String(player.entity_id) + '-' + String(partner.entity_id),
            playerId: String(player.entity_id),
            partnerId: String(partner.entity_id),
            player,
            partner,
            // The household, for names; the outsider is not one of them.
            members: hh.members,
            role,
            label,
            labelsFromPlayer: true,
            householdId: hh.id,
            outsider: true
        };
    }

    emotionOf(table, emo) {
        if (!emo || !emo.emotion_type) return null;
        const row = table[emo.emotion_type];
        return {
            type: emo.emotion_type,
            level: emo.level,
            text: row && row.levels[emo.level] ? row.levels[emo.level] : emo.emotion_type,
            tendency: row ? row.tendency : 'neutral'
        };
    }

    activityOf(cur) {
        if (!cur || !cur.playing) return { idle: true, id: null };
        const scheduled = isScheduledBag(cur.interaction_bag_id);
        return {
            idle: false,
            id: cur.interaction_bag_id || null,
            state: cur.state || null,
            action: cur.action_type || null,
            target: cur.target_entity_id !== undefined ? String(cur.target_entity_id) : null,
            // A timetable entry reports the time left of its current leg, not of the day.
            remain: !scheduled && typeof cur.remain_time === 'number' ? cur.remain_time : null,
            scheduled: scheduled
        };
    }

    // The game's own words for what someone is doing and what with, so the model reads
    // "烹饪 at 简约冰箱" instead of a bag id.
    async nameActivity(a, people) {
        if (!a || a.idle || !a.id) return;
        const person = a.target && people ? people.get(String(a.target)) : '';
        const [name, target] = await Promise.all([
            this.interactionName(a.id),
            person ? Promise.resolve(person) : a.target ? this.objectDisplayName(a.target) : Promise.resolve('')
        ]);
        if (name) a.name = name;
        if (target) a.targetName = target;
    }

    interactionName(bagId) {
        return this.cached('bag-name:' + bagId, 3600000, async () => {
            const r = await this.game.soft('interaction_search', { Keyword: bagId, max_results: 8 });
            const rows = (r && r.results) || [];
            const hit = rows.find((x) => String(x.interaction_bag_id) === String(bagId));
            return hit && hit.display_name ? String(hit.display_name) : '';
        });
    }

    objectDisplayName(id) {
        return this.cached('obj-name:' + id, 3600000, async () => {
            const info = await this.game.soft('entity_get_object_info', { entity_id: String(id) });
            if (info && (info.display_name || info.name)) return String(info.display_name || info.name);
            return '';
        });
    }

    needsOf(stats) {
        const out = {};
        const s = stats && stats.stats;
        if (!s) return out;
        for (const k of Object.keys(NEED_LABELS)) {
            if (s[k] && typeof s[k].pct === 'number') out[k] = Math.round(s[k].pct);
        }
        return out;
    }

    // Currently selected hopes only. The full table has more than a thousand rows; a character
    // carries at most a handful, and those are the ones they can actually ask for.
    async activeHopes(entityId) {
        const listed = await this.game.soft('hope_list', { entity_id: String(entityId) });
        const selected = (listed && listed.selected) || [];
        const out = [];
        for (let i = 0; i < selected.length; i++) {
            const id = selected[i] && selected[i].hope_id;
            if (!id) continue;
            const text = await this.hopeText(id);
            if (!text) continue;
            out.push({ id: id, display: text.display, desc: text.desc, reason: text.reason });
        }
        return out;
    }

    // The dish name the game shows for an Object row, e.g. PreparedShrimp01. '' when unknown.
    async foodName(objectId) {
        const id = String(objectId || '');
        if (!/^[A-Za-z0-9_]+$/.test(id)) return '';
        return this.cached('food-name:' + id, 3600000, async () => {
            const row = await this.game.soft('data_table_get', { Alias: 'Object', Row: id });
            const key = row && typeof row.displayNameTextId === 'string' ? row.displayNameTextId : '';
            if (!key || key === 'None') return '';
            const loc = (await this.game.soft('l10n_get', { Keys: JSON.stringify([key]) })) || {};
            const text = typeof loc[key] === 'string' ? loc[key].trim() : '';
            return text && text !== key && text.indexOf('MISSING') < 0 ? text : '';
        });
    }

    async hopeText(hopeId) {
        return this.cached('hope-text:' + hopeId, 600000, async () => {
            const row = await this.game.soft('data_table_get', { Alias: 'Hope', Row: hopeId });
            if (!row || !row.displayTextId) return null;
            const keys = [row.displayTextId, row.descTextId, row.reasonDescTextId].filter(Boolean);
            const loc = await this.game.soft('l10n_get', { Keys: JSON.stringify(keys) });
            if (!loc) return null;
            const display = loc[row.displayTextId];
            if (!display || String(display).indexOf('MISSING') >= 0) return null;
            return {
                display: display,
                desc: loc[row.descTextId] || '',
                reason: loc[row.reasonDescTextId] || ''
            };
        });
    }

    // The age numbers the HouseholdJournal mod reports for a character (aging.js), or null.
    ageOf(id) {
        return this.aging ? this.aging.get(id) : null;
    }

    // Full situation for prompting. Missing pieces become null; only "game closed" throws.
    async snapshot(pair) {
        const P = pair.partnerId;
        const W = pair.playerId;
        const g = this.game;
        this.gameSched.want([P, W]);
        const [env, table, sites, pInfo, pTraits, pPrefs, pEmo, pCur, pWork, pStats, rel, wEmo, wCur, wWork, pTimes] = await Promise.all([
            g.soft('environment_get_state', {}),
            this.emotionTable(),
            this.sites(),
            this.characterInfo(P),
            this.traits(P),
            this.preferences(P),
            g.soft('emotion_get_current', { entity_id: P }),
            g.soft('interaction_get_current', { entity_id: P }),
            g.soft('career_get_work_status', { entity_id: P }),
            g.soft('stat_get_all', { entity_id: P }),
            g.soft('relationships_get_value_between', { owner_id: P, target_id: W }),
            g.soft('emotion_get_current', { entity_id: W }),
            g.soft('interaction_get_current', { entity_id: W }),
            g.soft('career_get_work_status', { entity_id: W }),
            this.timetable(P)
        ]);
        const pSched = await this.gameSchedule(P, sites);
        const homeSite = pInfo && pInfo.home_site_id ? sites.byId.get(String(pInfo.home_site_id)) : null;
        const workSite = pWork && pWork.work_site_id !== undefined ? sites.byEntity.get(String(pWork.work_site_id)) : null;
        const pSiteName = pair.partner.current_site || null;
        const wSiteName = pair.player.current_site || null;
        const relationship = {};
        if (rel && rel.stats) {
            for (const k of Object.keys(rel.stats)) {
                if (rel.stats[k] && typeof rel.stats[k].value === 'number') relationship[k] = Math.round(rel.stats[k].value);
            }
        }
        // An outsider has no "others at home": the household is the player's, not theirs.
        const others = (pair.outsider ? [] : pair.members)
            .filter((m) => String(m.entity_id) !== P && String(m.entity_id) !== W)
            .map((m) => ({
                id: String(m.entity_id),
                name: fullName(m),
                label: pair.labelsFromPlayer ? (m.relationship_label || '')
                    : pair.household ? kinOf(pair.player, m, pair.household).label : '',
                age: m.age_group_text || m.age_group || '',
                aging: this.ageOf(m.entity_id),
                site: m.current_site || null
            }));
        const pActivity = this.activityOf(pCur);
        const wActivity = this.activityOf(wCur);
        this.eatProgress(P, pActivity, this.needsOf(pStats));
        const people = new Map(pair.members.map((m) => [String(m.entity_id), fullName(m)]));
        await Promise.all([this.nameActivity(pActivity, people), this.nameActivity(wActivity, people)]);
        return {
            takenAt: Date.now(),
            env: env || null,
            role: pair.role,
            label: pair.label,
            partner: {
                id: P,
                name: fullName(pair.partner),
                firstName: pair.partner.first_name || '',
                gender: pair.partner.gender || (pInfo && pInfo.gender) || '',
                ageGroup: pair.partner.age_group || '',
                age: pair.partner.age_group_text || pair.partner.age_group || '',
                aging: this.ageOf(P),
                job: pair.partner.job_name || '',
                rankName: pair.partner.job_rank_name || '',
                site: pSiteName,
                homeSiteId: homeSite ? homeSite.id : (pInfo && pInfo.home_site_id) || null,
                homeSiteName: homeSite ? homeSite.name : null,
                atHome: !!(homeSite && pSiteName && homeSite.name === pSiteName),
                workSiteName: workSite ? workSite.name : null,
                traits: pTraits,
                preferences: pPrefs,
                emotion: this.emotionOf(table, pEmo),
                activity: pActivity,
                work: pWork || null,
                timetable: Array.isArray(pTimes) ? pTimes : [],
                gameSchedule: pSched,
                needs: this.needsOf(pStats)
            },
            player: {
                id: W,
                name: fullName(pair.player),
                firstName: pair.player.first_name || '',
                gender: pair.player.gender || '',
                ageGroup: pair.player.age_group || '',
                age: pair.player.age_group_text || pair.player.age_group || '',
                aging: this.ageOf(W),
                job: pair.player.job_name || '',
                site: wSiteName,
                emotion: this.emotionOf(table, wEmo),
                activity: wActivity,
                work: wWork || null
            },
            together: !!(pSiteName && wSiteName && pSiteName === wSiteName),
            relationship,
            others,
            outsider: !!pair.outsider,
            // How the player's household look to an outsider: names and who is who, nothing more.
            playerHousehold: pair.outsider ? pair.members.filter((m) => String(m.entity_id) !== W).map((m) => ({
                name: fullName(m), label: m.relationship_label || '', age: m.age_group_text || ''
            })) : []
        };
    }
}

module.exports = { World, PairError, GameOfflineError, fullName, NEED_LABELS, AGE_ZH, canText, roleOf, kinOf };
