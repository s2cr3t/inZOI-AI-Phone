'use strict';
// What happens to the household that ordinary days do not have: a fire at home, a traffic
// accident, a death, a birth, a disaster in the city.
//
// The game runs emergencies itself. On a fire it cancels what everyone was doing with the reason
// Emergency_Fire, the characters react (Self_Fire_*), someone puts it out (…FireExtinguish), the
// firefighters come and are thanked (Coop_Thanks_FireFighter). The bridge must never pull a
// character out of that, has to tell the character's AI that it is happening, and the character
// reaches out at once, the way a person texts in a crisis.
//
// Sources: the HouseholdJournal Lua mod's interaction lines (J: started / finished / canceled /
// failed with the game's reason) and its world event lines (E: zoi.died, zoi.born, weather ...).
// Kept in memory only: an emergency is over long before anyone would restart the bridge, and the
// chronicle keeps what is worth remembering.

// Bags of the game's fire sequence. Fireplaces, fireworks and dismissing an employee share the word.
const FIRE_BAG_RE = /(^|_)Fire(_|$)|FireExtinguish|FireFighter|Extinguisher/i;
const FIRE_NOT_RE = /Fireplace|Firework|Campfire|Bonfire|Firepit|FireDance|Employee|Staff|Worker|Fired/i;
const FIRE_CANCEL_RE = /^Emergency_Fire$/;
const ACCIDENT_BAG_RE = /VehicleAccident|CarAccident|TrafficAccident/i;
const ACCIDENT_CANCEL_RE = /^VehicleAccident$/;

// How long after the last sign of it an emergency counts as over, when nothing ends it explicitly.
const QUIET_MS = { fire: 3 * 60000, accident: 2 * 60000 };
// After the firefighters were thanked the fire is out; what is left is tidying up.
const THANKED_SETTLE_MS = 30000;
// How long an emergency that is over, or an announcement, stays in the character's mind.
const RECENT_MS = 45 * 60000;
const KEEP_ENDED = 12;

const BLOCKING = { fire: true, accident: true };

const FIRE_STEPS = [
    { re: /Thanks_FireFighter|FireFighter/i, phase: 'thanks' },
    { re: /FireExtinguish|Extinguisher/i, phase: 'fighting' },
    { re: /(^|_)Fire(_|$)/i, phase: 'alarm' }
];

const PHASE_TEXT = {
    alarm: '发现着火了，正在躲开火',
    fighting: '正在灭火',
    fought: '刚把火扑灭',
    failed: '想去灭火，没能靠近起火的地方',
    thanks: '在谢谢赶来的消防员',
    involved: '被卷进了这件事'
};

const DISASTER_LABELS = { HeavyRain: '暴雨', HeatWave: '高温', YellowDust: '沙尘暴' };
const DEATH_REASONS = { Aging: '年纪大了，寿终正寝', Vehicle: '出了车祸', Fire: '在火灾里', Starvation: '饿坏了身体', Electrocution: '触电' };
const GROWTH_TEXT = { Baby: '婴儿', Toddler: '幼儿', Child: '儿童', LowTeen: '少年', Teen: '青少年', HighTeen: '青少年', YoungAdult: '青年', Adult: '成年人', Senior: '老年人' };

function isFireBag(bag) {
    return !!bag && FIRE_BAG_RE.test(bag) && !FIRE_NOT_RE.test(bag);
}

function isAccidentBag(bag) {
    return !!bag && ACCIDENT_BAG_RE.test(bag);
}

// A bag the game runs as part of an emergency. Nothing the AI does may cut into it.
function isEmergencyBag(bag) {
    return isFireBag(String(bag || '')) || isAccidentBag(String(bag || ''));
}

function firePhase(bag) {
    for (const s of FIRE_STEPS) if (s.re.test(bag)) return s.phase;
    return 'involved';
}

class Incidents {
    constructor(log) {
        this.log = log || { debug() {}, info() {}, warn() {}, error() {} };
        this.active = new Map();
        this.ended = [];
        this.notices = [];
        this.seq = 0;
        this.listeners = [];
    }

    // fn({ type: 'start' | 'end' | 'notice', incident })
    onChange(fn) {
        this.listeners.push(fn);
    }

    emit(type, incident) {
        for (const fn of this.listeners) {
            try { fn({ type, incident }); } catch (e) { this.log.warn('incidents listener: ' + (e && e.message || e)); }
        }
    }

    // A new world was loaded: nothing of the old one is happening any more.
    reset() {
        this.active.clear();
        this.ended = [];
        this.notices = [];
    }

    nextId(kind, at) {
        this.seq += 1;
        return kind + '-' + at + '-' + this.seq;
    }

    open(kind, at, detail) {
        let inc = this.active.get(kind);
        if (inc) return { inc, fresh: false };
        inc = { id: this.nextId(kind, at), kind, blocking: !!BLOCKING[kind], startedAt: at, lastAt: at, endedAt: 0, settleAt: 0, people: {}, detail: detail || {} };
        this.active.set(kind, inc);
        return { inc, fresh: true };
    }

    // One interaction line of the Lua mod: { at, kind, actor, bag, target, reason }.
    onJournal(ev) {
        if (!ev || !ev.actor) return;
        const at = ev.at || Date.now();
        const bag = String(ev.bag || '');
        const reason = String(ev.reason || '');
        let kind = '';
        if (ev.kind === 'canceled' && FIRE_CANCEL_RE.test(reason)) kind = 'fire';
        else if (isFireBag(bag)) kind = 'fire';
        else if ((ev.kind === 'canceled' && ACCIDENT_CANCEL_RE.test(reason)) || isAccidentBag(bag)) kind = 'accident';
        if (!kind) return;
        // A fire step ending normally is the end of that step, not a new alarm.
        if (kind === 'fire' && !this.active.has('fire') && ev.kind !== 'started' && !FIRE_CANCEL_RE.test(reason)) return;
        const { inc, fresh } = this.open(kind, at);
        inc.lastAt = at;
        const person = inc.people[ev.actor] || (inc.people[ev.actor] = { phase: 'involved', at });
        if (kind === 'fire') {
            const step = FIRE_CANCEL_RE.test(reason) ? 'alarm' : firePhase(bag);
            if (step === 'fighting' && ev.kind === 'finished') person.phase = 'fought';
            else if (step === 'fighting' && ev.kind === 'failed') person.phase = 'failed';
            else if (step === 'thanks') {
                person.phase = 'thanks';
                inc.detail.firefighters = true;
                if (ev.kind !== 'started') inc.settleAt = inc.settleAt || at + THANKED_SETTLE_MS;
            } else if (ev.kind === 'started' || FIRE_CANCEL_RE.test(reason)) {
                // Later steps are not undone by an earlier one starting again.
                const order = ['involved', 'alarm', 'fighting', 'failed', 'fought', 'thanks'];
                if (order.indexOf(step) >= order.indexOf(person.phase)) person.phase = step;
            }
            if (person.phase === 'fought') inc.detail.out = true;
        }
        person.at = at;
        if (fresh) {
            this.log.warn('incident ' + inc.id + ' started: ' + kind + ' (' + ev.actor + ' ' + ev.kind + ' ' + bag + (reason ? ' ' + reason : '') + ')');
            this.emit('start', inc);
        }
    }

    // One world event line of the Lua mod: { at, event, a, b, c, d } (see journal.js).
    onWorld(ev, names) {
        if (!ev || !ev.event) return;
        const at = ev.at || Date.now();
        const name = (id) => (names && names.get(String(id))) || '';
        if (ev.event === 'weather.changed') {
            const disaster = String(ev.d) === 'true';
            const cur = this.active.get('disaster');
            if (disaster) {
                const label = ev.label || DISASTER_LABELS[ev.c] || ev.c || '灾害天气';
                if (cur && cur.detail.weather === ev.c) return;
                if (cur) this.close(cur, at, 'replaced');
                const { inc } = this.open('disaster', at, { weather: ev.c, label });
                this.log.warn('incident ' + inc.id + ' started: disaster ' + ev.c);
                this.emit('start', inc);
            } else if (cur) {
                this.close(cur, at, 'weather is ' + (ev.c || 'normal') + ' again');
            }
            return;
        }
        const notice = { id: this.nextId('notice', at), kind: ev.event, at, people: [], text: '' };
        if (ev.event === 'zoi.died') {
            const who = name(ev.a) || '一位家人';
            const why = DEATH_REASONS[ev.b] || '';
            notice.people = [String(ev.a)];
            notice.text = who + (why ? why + '，' : '') + '去世了' + (String(ev.c) === 'true' ? '，后来变成了幽灵' : '');
            notice.grave = true;
        } else if (ev.event === 'zoi.born') {
            const mom = name(ev.b);
            const dad = name(ev.c);
            notice.people = [String(ev.a), String(ev.b), String(ev.c)].filter((x) => x && x !== '-1');
            notice.text = '家里添了一个小宝宝' + (mom || dad ? '（' + [mom, dad].filter(Boolean).join('和') + '的孩子）' : '');
        } else if (ev.event === 'zoi.pregnancy_begin') {
            notice.people = [String(ev.a), String(ev.b)].filter((x) => x && x !== '-1');
            notice.text = (name(ev.a) || '家里有人') + '怀孕了';
        } else if (ev.event === 'zoi.pregnancy_cancel') {
            notice.people = [String(ev.a)];
            notice.text = (name(ev.a) || '家里有人') + '的孩子没能保住';
            notice.grave = true;
        } else if (ev.event === 'zoi.growth_changed') {
            notice.people = [String(ev.a)];
            notice.text = (name(ev.a) || '家里有人') + '长大了，从' + (GROWTH_TEXT[ev.b] || ev.b) + '变成了' + (GROWTH_TEXT[ev.c] || ev.c);
        } else if (ev.event === 'zoi.married') {
            notice.people = [String(ev.a), String(ev.b)];
            notice.text = (name(ev.a) || '家里有人') + '和' + (name(ev.b) || '对方') + '结婚了';
        } else if (ev.event === 'zoi.divorced') {
            notice.people = [String(ev.a), String(ev.b)];
            notice.text = (name(ev.a) || '家里有人') + '和' + (name(ev.b) || '对方') + '离婚了';
            notice.grave = true;
        } else {
            return;
        }
        this.notices.push(notice);
        this.prune(at);
        this.log.info('incident notice ' + notice.id + ': ' + notice.text);
        this.emit('notice', notice);
    }

    close(inc, at, why) {
        inc.endedAt = at;
        this.active.delete(inc.kind);
        this.ended.push(inc);
        if (this.ended.length > KEEP_ENDED) this.ended.splice(0, this.ended.length - KEEP_ENDED);
        this.log.info('incident ' + inc.id + ' over (' + why + ') after ' + Math.round((at - inc.startedAt) / 1000) + 's');
        this.emit('end', inc);
    }

    // Ends emergencies nothing has been heard of for a while, and forgets old ones.
    tick(now) {
        const t = now || Date.now();
        for (const inc of Array.from(this.active.values())) {
            if (inc.settleAt && t >= inc.settleAt) this.close(inc, inc.settleAt, 'the firefighters were thanked');
            else if (QUIET_MS[inc.kind] && t - inc.lastAt > QUIET_MS[inc.kind]) this.close(inc, inc.lastAt, 'no sign of it for ' + Math.round(QUIET_MS[inc.kind] / 60000) + ' min');
        }
        this.prune(t);
    }

    prune(t) {
        this.ended = this.ended.filter((i) => t - i.endedAt < RECENT_MS);
        this.notices = this.notices.filter((n) => t - n.at < RECENT_MS);
    }

    // Non-null while an emergency holds this character: the game's own steps for it run, and no AI
    // step may cancel them or push in front. Same shape as a timetable hold (see schedule.js).
    holdFor(actorId, cur) {
        const id = String(actorId || '');
        if (cur && cur.playing && isEmergencyBag(cur.interaction_bag_id)) {
            const kind = isFireBag(String(cur.interaction_bag_id)) ? 'fire' : 'accident';
            return holdOf(kind, String(cur.interaction_bag_id));
        }
        for (const inc of this.active.values()) {
            if (inc.blocking && inc.people[id]) return holdOf(inc.kind, inc.kind + ' ' + inc.id);
        }
        return null;
    }

    anyBlocking() {
        for (const inc of this.active.values()) if (inc.blocking) return true;
        return false;
    }

    // What the character knows of it, in words: [{ key, active, grave, urgent, startedAt, endedAt, lines: [] }]
    // selfId: the character; names: id -> full name; playerId / playerWord: who the player is and
    // what the character calls them. Times are the city clock the daemon noted (startClock, endClock).
    view(selfId, playerId, names, playerWord) {
        const out = [];
        const who = (id) => (String(id) === String(selfId) ? '你' : String(id) === String(playerId) ? playerWord : (names.get(String(id)) || '一位家人'));
        const describe = (inc, active) => {
            const lines = [];
            const people = Object.keys(inc.people);
            const span = inc.startClock ? '（城市时间 ' + inc.startClock + ' 开始' + (!active && inc.endClock ? '，' + inc.endClock + ' 结束' : '') + '）' : '';
            if (inc.kind === 'fire') {
                lines.push((active ? '家里着火了！' : '刚才家里着火了，现在火已经灭了。') + span);
                for (const id of people) {
                    const phase = inc.people[id].phase;
                    lines.push('  ' + who(id) + '：' + (active ? PHASE_TEXT[phase] || PHASE_TEXT.involved : phase === 'fought' ? '亲手把火扑灭了' : '当时也在场'));
                }
                if (inc.detail.firefighters) lines.push('  消防员已经赶到' + (active ? '了' : '帮忙把火灭了'));
                else if (inc.detail.out) lines.push('  火已经被扑灭');
            } else if (inc.kind === 'accident') {
                lines.push((active ? '刚刚出了车祸！' : '刚才出了一场车祸，已经过去了。') + span);
                for (const id of people) lines.push('  ' + who(id) + '：' + (active ? '卷进了这场车祸，正在处理' : '经历了这场车祸'));
            } else if (inc.kind === 'disaster') {
                lines.push((active ? '城里正在闹' + inc.detail.label + '。' : '前面城里闹了一场' + inc.detail.label + '，已经过去了。') + span);
            }
            return lines;
        };
        for (const inc of this.active.values()) {
            out.push({ key: 'incident:' + inc.id, kind: inc.kind, active: true, urgent: inc.kind !== 'disaster', grave: inc.blocking,
                involved: !!inc.people[String(selfId)], startedAt: inc.startedAt, endedAt: 0, lines: describe(inc, true) });
        }
        for (const inc of this.ended) {
            out.push({ key: 'incident:' + inc.id, kind: inc.kind, active: false, urgent: false, grave: inc.blocking,
                involved: !!inc.people[String(selfId)], startedAt: inc.startedAt, endedAt: inc.endedAt, lines: describe(inc, false) });
        }
        for (const n of this.notices) {
            out.push({ key: 'incident:' + n.id, kind: n.kind, active: false, urgent: true, grave: !!n.grave,
                involved: n.people.indexOf(String(selfId)) >= 0, startedAt: n.at, endedAt: n.at,
                lines: [n.text.replace(new RegExp(escapeRe(names.get(String(selfId)) || '\u0000'), 'g'), '你') + (n.startClock ? '（城市时间 ' + n.startClock + '）' : '')] });
        }
        return out.sort((a, b) => b.startedAt - a.startedAt);
    }
}

function holdOf(kind, bagId) {
    if (kind === 'fire') return { bagId, what: '躲避火灾', end: '火灭了', emergency: 'fire' };
    return { bagId, what: '处理车祸', end: '车祸处理完', emergency: 'accident' };
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { Incidents, isEmergencyBag, isFireBag, isAccidentBag, RECENT_MS };
