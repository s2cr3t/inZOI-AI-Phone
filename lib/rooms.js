'use strict';
// Rooms and storeys of a lot, so a character can say "I'm upstairs in my room" and pick the bed
// in its own bedroom. The game's object scan has no rooms, only positions (world centimetres), so
// rooms are read from the furniture: beds make a bedroom, a toilet or shower a bathroom, a stove
// or fridge a kitchen, a sofa or TV a living room. Storeys come from the height of what stands on
// the floor. Who sleeps in which bed is learned from the household's own sleep actions.
//
// When the game itself reports rooms (build_scan_floors), and its rooms really contain the
// scanned furniture, its grouping is used instead of the guess; the furniture still names them.
const fsx = require('./fsx');

const VERSION = 1;
const SAVE_DELAY_MS = 3000;
const BEDS_KEEP = 200;
const SLEEP_SEEN_MS = 2 * 3600000;

// A new storey starts when floor-standing furniture is this much higher than the last level.
const STOREY_GAP_CM = 200;
// Something hung on a wall or a ceiling still belongs to the storey below it.
const STOREY_SLACK_CM = 60;
// Anything this far from every room's furniture belongs to none.
const ASSIGN_MAX_CM = 400;
const YARD_FREE_CM = 250;
const LOCATE_MAX_CM = 250;
const TILE_MAX_CM = 150;
const PROBE_AGAIN_MS = 10 * 60000;

const KINDS = [
    { kind: 'bath', base: '卫生间', primary: true, join: 300, re: /马桶|坐便|淋浴|浴缸|浴盆|小便器|Toilet|Shower|Bathtub|Urinal/i },
    { kind: 'kitchen', base: '厨房', primary: true, join: 450, re: /冰箱|炉具|炉灶|灶台|烤箱|抽油烟机|洗碗机|Fridge|Refrigerator|Stove|Oven|Hood|Dishwasher/i },
    { kind: 'bed', base: '卧室', primary: true, join: 250, re: /床|Bed/i, not: /床头|床垫|床单|床边|日光浴床|浴床|沙发床|Bedside|SunBed|Sofa ?Bed/i },
    { kind: 'living', base: '客厅', primary: true, join: 500, re: /沙发|电视|Sofa|Couch|Television|\bTV\b/i, not: /电视柜|懒人沙发|TV ?Stand/i },
    // into: the rooms it can be part of; anywhere else it makes a room of its own.
    { kind: 'dining', base: '餐厅', primary: false, attach: 450, into: ['kitchen', 'living'], re: /餐桌|Dining ?Table/i, not: /野餐|Picnic/i },
    { kind: 'study', base: '书房', primary: false, attach: 300, into: ['bed', 'living'], re: /书桌|办公桌|电脑|书架|Desk|Computer|Bookshelf|Bookcase/i, not: /笔记本电脑|Laptop/i },
    { kind: 'laundry', base: '洗衣间', primary: false, attach: 300, into: ['bath', 'kitchen'], re: /洗衣机|烘干机|Washer|Washing|Dryer/i }
];
// Things that belong with one kind of room. Without walls the nearest furniture can be on the
// other side of one; a room of the right kind close enough wins over it.
const AFFINITY = [
    { kind: 'bath', re: /浴室柜|毛巾架|卫生纸架|洗脸盆|洗手池|浴巾|Towel|Vanity/i },
    { kind: 'kitchen', re: /料理台|橱柜|水槽|刀架|电饭锅|咖啡机|净水器|Counter|Kitchen ?Cabinet|Sink/i },
    { kind: 'bed', re: /衣橱|衣柜|梳妆台|梳妆凳|床头柜|Wardrobe|Dresser|Nightstand/i },
    { kind: 'living', re: /电视柜|咖啡桌|茶几|TV ?Stand|Coffee ?Table/i }
];
const KID_BED_RE = /儿童床|婴儿床|摇篮|Crib|Kid|Child|Bunk/i;
const BIG_BED_RE = /大床|双人床|Double|Queen|King/i;
// Shell of the building: never a hint of which room something is in.
const STRUCTURE_RE = /窗|门(?!铃|垫)|屋顶|立柱|楼梯|电梯|栏杆|墙(?!面镜|灯|钟|饰)|地板|天花|Window|Door(?!bell|mat)|Roof|Pillar|Stair|Elevator|Railing/i;
// What grows or stands outside; inside, a potted plant is just a plant.
const OUTDOOR_RE = /黄杨木|金盏花|矮牵牛|波斯菊|玫瑰灌木|灌木|树苗|树(?!脂|屋)|花坛|草坪|邮箱|篱笆|围栏|野餐|烧烤|秋千|花岗岩块|Tree|Bush|Shrub|Hedge|Mailbox|Fence|Picnic|Grill/i;
const POTTED_RE = /^小盆|^中盆|^大盆|花束|盆栽|Potted/i;
const SLEEP_BAG_RE = /(^|_)(Sleep|Nap)(_|$)|Sleep_Bed|Bed_Sleep/i;

function str(v) {
    return v === undefined || v === null ? '' : String(v).trim();
}

function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
}

function kindOf(name) {
    for (const k of KINDS) {
        if (k.re.test(name) && !(k.not && k.not.test(name))) return k;
    }
    return null;
}

function flat(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// A point { x, y } from the shapes the game uses for positions.
function pointOf(o) {
    if (!o || typeof o !== 'object') return null;
    const src = o.world_location || o.location || o.position || o.center || o.centre || o;
    const x = num(src.x !== undefined ? src.x : src.X);
    const y = num(src.y !== undefined ? src.y : src.Y);
    if (x === null || y === null) return null;
    const z = num(src.z !== undefined ? src.z : src.Z);
    return z === null ? { x, y } : { x, y, z };
}

function insidePolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i];
        const b = poly[j];
        if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / ((b.y - a.y) || 1e-9) + a.x) inside = !inside;
    }
    return inside;
}

class Rooms {
    constructor(file, log) {
        this.file = file;
        this.log = log || { debug() {}, info() {}, warn() {} };
        // bed id -> { ids: { memberId: nights }, at }
        this.beds = new Map();
        this.sleepSeen = new Map();
        this.layouts = new Map();
        // site id -> { rooms: [{ key, storey, objects?, tiles?, polygon?, box? }], at } from the game
        this.gameRooms = new Map();
        this.probed = new Set();
        this.emptyAt = new Map();
        this.timer = null;
        this.load();
    }

    load() {
        const r = fsx.readJson(this.file);
        if (!r.ok) {
            if (!r.missing) this.log.warn('rooms: ' + this.file + ' unreadable, starting empty: ' + r.error);
            return;
        }
        const v = r.value;
        if (!v || v.v !== VERSION || !v.beds || typeof v.beds !== 'object') return;
        for (const id of Object.keys(v.beds)) {
            const b = v.beds[id];
            if (!b || !b.ids || typeof b.ids !== 'object') continue;
            const ids = {};
            for (const m of Object.keys(b.ids)) if (num(b.ids[m]) > 0) ids[m] = Math.round(b.ids[m]);
            if (Object.keys(ids).length) this.beds.set(id, { ids, at: num(b.at) || 0 });
        }
    }

    scheduleSave() {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, SAVE_DELAY_MS);
        if (this.timer.unref) this.timer.unref();
    }

    flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const beds = {};
        for (const [id, b] of this.beds) beds[id] = b;
        try {
            fsx.writeJson(this.file, { v: VERSION, savedAt: Date.now(), beds });
        } catch (e) {
            this.log.warn('rooms: bed owners not saved: ' + (e && e.message || e));
        }
    }

    // ------------------------------------------------------------ who sleeps where
    // A sleep action someone started on a bed (from the Lua journal or seen live).
    noteSleep(actorId, bagId, targetId) {
        const actor = str(actorId);
        const bed = str(targetId);
        if (!actor || !bed || bed === actor || bed === '0' || !SLEEP_BAG_RE.test(str(bagId))) return false;
        const key = actor + '>' + bed;
        const now = Date.now();
        if (now - (this.sleepSeen.get(key) || 0) < SLEEP_SEEN_MS) return false;
        this.sleepSeen.set(key, now);
        const b = this.beds.get(bed) || { ids: {}, at: 0 };
        b.ids[actor] = (b.ids[actor] || 0) + 1;
        b.at = now;
        this.beds.set(bed, b);
        if (this.beds.size > BEDS_KEEP) {
            const oldest = Array.from(this.beds.entries()).sort((x, y) => x[1].at - y[1].at);
            for (let i = 0; i < oldest.length - BEDS_KEEP; i++) this.beds.delete(oldest[i][0]);
        }
        this.layouts.clear();
        this.scheduleSave();
        this.log.info('rooms: ' + actor + ' sleeps in bed ' + bed + ' (' + b.ids[actor] + ' time(s))');
        return true;
    }

    // The people who usually sleep in this bed, most nights first; at most two.
    bedOwners(bedId) {
        const b = this.beds.get(str(bedId));
        if (!b) return [];
        const list = Object.keys(b.ids).map((id) => ({ id, n: b.ids[id] })).sort((x, y) => y.n - x.n);
        if (!list.length) return [];
        const floor = Math.max(1, list[0].n / 3);
        return list.filter((x) => x.n >= floor).slice(0, 2).map((x) => x.id);
    }

    // ------------------------------------------------------------ the game's own rooms
    // Asks the game once per site and session. Kept only when it can be read and matches the
    // furniture; what it looked like is logged either way, without any values.
    async probe(game, siteId, rows) {
        const id = str(siteId);
        if (!game || !id || this.probed.has(id)) return;
        // An empty answer (nobody played on the lot yet) is asked again a while later.
        if (Date.now() - (this.emptyAt.get(id) || 0) < PROBE_AGAIN_MS) return;
        this.probed.add(id);
        const has = await game.has('build_scan_floors');
        if (!has) {
            this.log.info('rooms: the game has no build_scan_floors, rooms of ' + id + ' come from the furniture');
            return;
        }
        const schema = game.schemaOf ? await game.schemaOf('build_scan_floors') : null;
        const props = schema && schema.properties ? Object.keys(schema.properties) : [];
        const required = schema && Array.isArray(schema.required) ? schema.required : [];
        this.log.info('rooms: build_scan_floors takes ' + (props.length ? props.join(', ') : 'no arguments') + (required.length ? ' (required: ' + required.join(', ') + ')' : ''));
        if (required.length) {
            this.log.info('rooms: build_scan_floors needs arguments the bridge does not have, rooms of ' + id + ' come from the furniture');
            return;
        }
        const res = await game.soft('build_scan_floors', { Limit: 0 });
        this.log.info('rooms: build_scan_floors for ' + id + ' answered ' + shapeOf(res, 0));
        if (!res || (typeof res === 'object' && !Object.keys(res).length)) {
            this.probed.delete(id);
            this.emptyAt.set(id, Date.now());
            return;
        }
        const parsed = parseGameRooms(res);
        if (!parsed.length) {
            this.log.info('rooms: no rooms in that answer, rooms of ' + id + ' come from the furniture');
            return;
        }
        const check = this.matchGameRooms(parsed, rows || []);
        if (!check.ok) {
            this.log.info('rooms: the game\'s ' + parsed.length + ' room(s) do not match the furniture (' + check.why + '), using the furniture');
            return;
        }
        this.gameRooms.set(id, { rooms: parsed, at: Date.now() });
        this.layouts.delete(id);
        this.log.info('rooms: using the game\'s ' + parsed.length + ' room(s) for ' + id + ' (' + check.why + ')');
    }

    // Which game room each scanned object falls in: Map objectId -> room key.
    placeInGameRooms(parsed, rows) {
        const out = new Map();
        const byId = new Map(parsed.filter((r) => r.objects).map((r) => [r, new Set(r.objects)]));
        for (const o of rows) {
            if (!o || typeof o.x !== 'number') continue;
            let hit = null;
            for (const r of parsed) {
                if (r.objects && byId.get(r).has(o.id)) { hit = r; break; }
                if (r.polygon && insidePolygon(o, r.polygon) && sameStorey(r, o)) { hit = r; break; }
                if (r.box && o.x >= r.box.minX && o.x <= r.box.maxX && o.y >= r.box.minY && o.y <= r.box.maxY && sameStorey(r, o)) { hit = r; break; }
            }
            if (!hit) {
                let best = null;
                for (const r of parsed) {
                    if (!r.tiles) continue;
                    for (const t of r.tiles) {
                        if (typeof t.z === 'number' && typeof o.z === 'number' && Math.abs(o.z - t.z) > STOREY_GAP_CM) continue;
                        const d = flat(o, t);
                        if (d <= TILE_MAX_CM && (!best || d < best.d)) best = { r, d };
                    }
                }
                if (best) hit = best.r;
            }
            if (hit) out.set(o.id, hit.key);
        }
        return out;
    }

    matchGameRooms(parsed, rows) {
        const anchors = rows.filter((o) => typeof o.x === 'number' && kindOf(o.name));
        if (anchors.length < 2) return { ok: false, why: 'too little furniture to compare' };
        const placed = this.placeInGameRooms(parsed, rows);
        const used = new Set();
        let inside = 0;
        for (const a of anchors) {
            const k = placed.get(a.id);
            if (!k) continue;
            inside += 1;
            used.add(k);
        }
        const why = inside + '/' + anchors.length + ' furniture inside, ' + used.size + ' room(s) used';
        return { ok: used.size >= 2 && inside * 2 >= anchors.length, why };
    }

    // ------------------------------------------------------------ layout
    // rows: every object of one site, { id, name, x, y, z } in world cm. stamp changes when the
    // rows do (the scan time), so a layout is worked out once per scan.
    layout(siteId, rows, stamp) {
        const id = str(siteId);
        const key = id + '@' + (stamp || rows.length);
        const hit = this.layouts.get(id);
        if (hit && hit.key === key) return hit.value;
        const value = this.build(id, rows || []);
        this.layouts.set(id, { key, value });
        if (value.rooms.length) {
            this.log.info('rooms: ' + (value.source === 'game' ? 'game rooms' : 'furniture') + ' of ' + id + ': ' +
                value.rooms.map((r) => (value.storeys > 1 ? (r.storey + 1) + 'F ' : '') + r.base + '(' + r.objects.size + ')').join(', '));
        }
        return value;
    }

    build(siteId, rows) {
        const placed = rows.filter((o) => o && o.id && o.name && typeof o.x === 'number' && typeof o.y === 'number');
        const levels = storeyLevels(placed);
        const storeyOf = (o) => {
            if (typeof o.z !== 'number' || levels.length < 2) return 0;
            let s = 0;
            for (let i = 0; i < levels.length; i++) if (o.z + STOREY_SLACK_CM >= levels[i]) s = i;
            return s;
        };
        const game = this.gameRooms.get(siteId);
        const rooms = game ? this.fromGame(game.rooms, placed, storeyOf) : this.fromFurniture(placed, storeyOf);
        const roomOf = new Map();
        for (const r of rooms) for (const oid of r.objects) roomOf.set(oid, r);
        this.nameRooms(rooms);
        const top = rooms.reduce((m, r) => Math.max(m, r.storey + 1), 1);
        return { siteId, storeys: Math.max(levels.length, top), levels, rooms, roomOf, storeyOf, source: game ? 'game' : 'furniture', objects: placed };
    }

    fromFurniture(placed, storeyOf) {
        const rooms = [];
        const anchorRoom = new Map();
        const byStorey = new Map();
        for (const o of placed) {
            const k = kindOf(o.name);
            if (!k) continue;
            const s = storeyOf(o);
            if (!byStorey.has(s)) byStorey.set(s, []);
            byStorey.get(s).push({ o, k });
        }
        for (const [s, list] of byStorey) {
            // Rooms grow from the furniture that defines them, one kind at a time.
            for (const k of KINDS.filter((x) => x.primary)) {
                const mine = list.filter((a) => a.k === k);
                const clusters = [];
                for (const a of mine) {
                    const near = clusters.filter((c) => c.some((b) => flat(a.o, b.o) <= k.join));
                    if (!near.length) {
                        clusters.push([a]);
                        continue;
                    }
                    const merged = near[0];
                    merged.push(a);
                    for (let i = 1; i < near.length; i++) {
                        for (const b of near[i]) merged.push(b);
                        clusters.splice(clusters.indexOf(near[i]), 1);
                    }
                }
                for (const c of clusters) {
                    const room = newRoom(k, s);
                    for (const a of c) addAnchor(room, a.o, anchorRoom);
                    rooms.push(room);
                }
            }
            // A desk, dining table or washer joins the room it stands in, or makes its own.
            for (const k of KINDS.filter((x) => !x.primary)) {
                for (const a of list.filter((x) => x.k === k)) {
                    let best = null;
                    for (const r of rooms) {
                        if (r.storey !== s || k.into.indexOf(r.kind) < 0) continue;
                        for (const p of r.anchors) {
                            const d = flat(a.o, p);
                            if (d <= k.attach && (!best || d < best.d)) best = { r, d };
                        }
                    }
                    if (best) {
                        addAnchor(best.r, a.o, anchorRoom);
                        if (best.r.extra.indexOf(k.kind) < 0) best.r.extra.push(k.kind);
                        continue;
                    }
                    const own = rooms.find((r) => r.storey === s && r.kind === k.kind && r.anchors.some((p) => flat(a.o, p) <= k.attach));
                    if (own) {
                        addAnchor(own, a.o, anchorRoom);
                        continue;
                    }
                    const room = newRoom(k, s);
                    addAnchor(room, a.o, anchorRoom);
                    rooms.push(room);
                }
            }
        }
        // Everything else goes with the nearest room furniture on its storey.
        let yard = null;
        for (const o of placed) {
            if (anchorRoom.has(o.id) || STRUCTURE_RE.test(o.name)) continue;
            const s = storeyOf(o);
            const outdoor = OUTDOOR_RE.test(o.name) && !POTTED_RE.test(o.name);
            const fit = AFFINITY.find((a) => a.re.test(o.name));
            let best = null;
            let fitted = null;
            for (const r of rooms) {
                if (r.storey !== s || r.kind === 'yard') continue;
                for (const p of r.anchors) {
                    const d = flat(o, p);
                    if (!best || d < best.d) best = { r, d };
                    if (fit && r.kind === fit.kind && (!fitted || d < fitted.d)) fitted = { r, d };
                }
            }
            if (fitted && fitted.d <= ASSIGN_MAX_CM) best = fitted;
            // Shrubs and flowerbeds by a window are still outside.
            if (outdoor && s === 0) {
                if (!yard) {
                    yard = { id: 'yard', kind: 'yard', base: '院子', storey: 0, anchors: [], objects: new Set(), beds: [], extra: [] };
                    rooms.push(yard);
                }
                yard.objects.add(o.id);
                continue;
            }
            if (best && best.d <= ASSIGN_MAX_CM) best.r.objects.add(o.id);
        }
        rooms.forEach((r, i) => { r.id = r.id || 'r' + (i + 1); });
        return rooms;
    }

    fromGame(parsed, placed, storeyOf) {
        const placedIn = this.placeInGameRooms(parsed, placed);
        const groups = new Map();
        for (const o of placed) {
            const key = placedIn.get(o.id);
            if (!key) continue;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(o);
        }
        const levelOf = new Map(parsed.map((r) => [r.key, r.storey]));
        const known = parsed.map((r) => r.storey).filter((s) => typeof s === 'number');
        const lowest = known.length ? Math.min.apply(null, known) : 0;
        const rooms = [];
        for (const [key, list] of groups) {
            const votes = new Map();
            for (const o of list) {
                const k = kindOf(o.name);
                if (k) votes.set(k, (votes.get(k) || 0) + (k.primary ? 3 : 1));
            }
            let kind = null;
            for (const [k, n] of votes) if (!kind || n > votes.get(kind)) kind = k;
            const outdoor = !kind && list.some((o) => OUTDOOR_RE.test(o.name) && !POTTED_RE.test(o.name));
            const room = kind ? newRoom(kind, 0) : { kind: outdoor ? 'yard' : 'other', base: outdoor ? '院子' : '', anchors: [], objects: new Set(), beds: [], extra: [] };
            const level = levelOf.get(key);
            if (typeof level === 'number') {
                room.storey = level - lowest;
            } else {
                const storeys = list.map(storeyOf).sort((a, b) => a - b);
                room.storey = storeys[Math.floor(storeys.length / 2)] || 0;
            }
            room.id = 'g' + key;
            for (const o of list) {
                room.objects.add(o.id);
                const k = kindOf(o.name);
                if (k) {
                    room.anchors.push({ x: o.x, y: o.y });
                    if (k.kind === 'bed') room.beds.push({ id: o.id, name: o.name });
                    if (kind && k !== kind && room.extra.indexOf(k.kind) < 0) room.extra.push(k.kind);
                }
            }
            if (room.base) rooms.push(room);
        }
        return rooms;
    }

    // Bedrooms take the names of who sleeps there; the same name twice on a storey is numbered.
    nameRooms(rooms) {
        for (const r of rooms) {
            r.owners = [];
            if (r.kind !== 'bed') continue;
            for (const b of r.beds) for (const id of this.bedOwners(b.id)) if (r.owners.indexOf(id) < 0) r.owners.push(id);
            r.owners = r.owners.slice(0, 2);
            if (r.beds.length && r.beds.every((b) => KID_BED_RE.test(b.name))) r.base = '儿童房';
            else if (r.beds.some((b) => BIG_BED_RE.test(b.name))) r.base = '主卧';
        }
        const masters = rooms.filter((r) => r.base === '主卧');
        if (masters.length > 1) for (const r of masters) r.base = '卧室';
        const seen = new Map();
        for (const r of rooms) {
            if (r.owners.length) continue;
            const k = r.storey + '|' + r.base;
            seen.set(k, (seen.get(k) || 0) + 1);
        }
        const count = new Map();
        for (const r of rooms) {
            r.n = 0;
            if (r.owners.length) continue;
            const k = r.storey + '|' + r.base;
            if (seen.get(k) < 2) continue;
            count.set(k, (count.get(k) || 0) + 1);
            r.n = count.get(k);
        }
    }

    // ------------------------------------------------------------ reading a layout
    // view: { self, player, playerWord, names: Map id -> name }. "2楼 你的卧室", "妈妈和爸爸的卧室".
    label(room, layout, view) {
        if (!room) return '';
        let text = room.base + (room.n ? room.n : '');
        if (room.owners && room.owners.length) {
            const who = room.owners.map((id) => {
                if (view && id === str(view.self)) return '你';
                if (view && id === str(view.player)) return view.playerWord || '';
                return view && view.names ? view.names.get(id) || '' : '';
            }).filter(Boolean);
            if (who.length) text = who.join('和') + '的' + (room.base === '儿童房' || room.base === '主卧' ? '卧室' : room.base);
        }
        return (layout.storeys > 1 && room.kind !== 'yard' ? (room.storey + 1) + '楼 ' : '') + text;
    }

    labelOf(layout, objectId, view) {
        const r = layout.roomOf.get(str(objectId));
        return r ? this.label(r, layout, view) : '';
    }

    // The room around a point (world cm): the room of the nearest placed thing close by.
    locate(layout, point) {
        if (!point || typeof point.x !== 'number') return null;
        let best = null;
        for (const o of layout.objects) {
            const r = layout.roomOf.get(o.id);
            if (!r || r.kind === 'yard') continue;
            if (typeof point.z === 'number' && typeof o.z === 'number' && layout.storeyOf(o) !== layout.storeyOf(point)) continue;
            const d = flat(point, o);
            if (d <= LOCATE_MAX_CM && (!best || d < best.d)) best = { r, d };
        }
        return best ? best.r : null;
    }

    // One line per storey for the prompts: "1楼：厨房、客厅、你的卧室".
    overview(layout, view) {
        const lines = [];
        for (let s = 0; s < layout.storeys; s++) {
            const names = layout.rooms.filter((r) => r.storey === s && r.kind !== 'yard').map((r) => {
                const text = this.label(r, layout, view).replace(/^\d+楼 /, '');
                const extra = r.extra.filter((k) => k !== r.kind).map((k) => KINDS.find((x) => x.kind === k).base);
                return text + (extra.length ? '（带' + extra.join('、') + '）' : '');
            });
            if (names.length) lines.push((layout.storeys > 1 ? (s + 1) + '楼：' : '') + names.join('、'));
        }
        if (layout.rooms.some((r) => r.kind === 'yard')) lines.push('屋外：院子');
        return lines;
    }
}

function newRoom(k, storey) {
    return { id: '', kind: k.kind, base: k.base, storey, anchors: [], objects: new Set(), beds: [], extra: [] };
}

function addAnchor(room, o, anchorRoom) {
    room.anchors.push({ x: o.x, y: o.y });
    room.objects.add(o.id);
    anchorRoom.set(o.id, room);
    if (room.kind === 'bed' && kindOf(o.name) && kindOf(o.name).kind === 'bed') room.beds.push({ id: o.id, name: o.name });
}

function sameStorey(r, o) {
    return typeof r.z !== 'number' || typeof o.z !== 'number' || Math.abs(o.z - r.z) <= STOREY_GAP_CM;
}

// Floor heights from what stands on a floor, lowest first.
function storeyLevels(placed) {
    const zs = placed.filter((o) => typeof o.z === 'number' && kindOf(o.name)).map((o) => o.z).sort((a, b) => a - b);
    const levels = [];
    for (const z of zs) {
        if (!levels.length || z - levels[levels.length - 1].top > STOREY_GAP_CM) levels.push({ base: z, top: z });
        else levels[levels.length - 1].top = z;
    }
    return levels.map((l) => l.base);
}

// What an answer looks like, without its values: keys, types and list lengths, two levels deep.
function shapeOf(v, depth) {
    if (v === null || v === undefined) return 'nothing';
    if (Array.isArray(v)) return '[' + v.length + (v.length && depth < 2 ? ' x ' + shapeOf(v[0], depth + 1) : '') + ']';
    if (typeof v !== 'object') return typeof v;
    const keys = Object.keys(v).slice(0, 16);
    if (depth >= 2) return '{' + keys.join(',') + '}';
    return '{' + keys.map((k) => k + ':' + shapeOf(v[k], depth + 1)).join(', ') + '}';
}

function roomKeyOf(o) {
    for (const k of ['room_id', 'roomId', 'room_index', 'roomIndex', 'room', 'space_id', 'spaceId', 'area_id']) {
        const v = o[k];
        if (v !== undefined && v !== null && (typeof v === 'string' || typeof v === 'number') && String(v) !== '' && String(v) !== '-1') return String(v);
    }
    return '';
}

function storeyKeyOf(o) {
    for (const k of ['floor_level', 'floorLevel', 'storey', 'floor', 'floor_index', 'floorIndex', 'level', 'story', 'storey_index']) {
        const v = num(o[k]);
        if (v !== null) return v;
    }
    return null;
}

function idsOf(list) {
    if (!Array.isArray(list)) return null;
    const out = list.map((x) => (x && typeof x === 'object' ? str(x.entity_id || x.id) : str(x))).filter(Boolean);
    return out.length ? out : null;
}

function polygonOf(o) {
    for (const k of ['polygon', 'points', 'vertices', 'outline', 'corners']) {
        if (!Array.isArray(o[k])) continue;
        const pts = o[k].map(pointOf).filter(Boolean);
        if (pts.length >= 3) return pts;
    }
    return null;
}

function boxOf(o) {
    const b = o.bounds || o.bbox || o.box || o;
    const min = b.min ? pointOf(b.min) : null;
    const max = b.max ? pointOf(b.max) : null;
    if (min && max) return { minX: Math.min(min.x, max.x), maxX: Math.max(min.x, max.x), minY: Math.min(min.y, max.y), maxY: Math.max(min.y, max.y) };
    const v = [num(b.min_x), num(b.max_x), num(b.min_y), num(b.max_y)];
    if (v.every((x) => x !== null)) return { minX: v[0], maxX: v[1], minY: v[2], maxY: v[3] };
    return null;
}

// Rooms from an answer of build_scan_floors (rooms listed per floor level, paged), in any of the
// shapes it may come in: rooms with their objects, outline or bounds, or floor tiles tagged with
// a room. Every floor's list is read, each room carrying the level of the floor it is listed
// under. [] when none of that is there.
function parseGameRooms(res) {
    const lists = [];
    const walk = (v, depth, storey) => {
        if (!v || typeof v !== 'object' || depth > 4) return;
        if (Array.isArray(v)) {
            if (v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) lists.push({ list: v, storey });
            for (const x of v) walk(x, depth + 1, storey);
            return;
        }
        const own = storeyKeyOf(v);
        for (const k of Object.keys(v)) walk(v[k], depth + 1, own !== null ? own : storey);
    };
    walk(res, 0, null);
    const rooms = [];
    const seen = new Set();
    for (const { list, storey } of lists) {
        for (let i = 0; i < list.length; i++) {
            const o = list[i];
            const objects = idsOf(o.objects || o.object_ids || o.objectIds || o.entities || o.entity_ids);
            const polygon = polygonOf(o);
            const box = polygon ? null : boxOf(o);
            if (!objects && !polygon && !box) continue;
            const level = storeyKeyOf(o) !== null ? storeyKeyOf(o) : storey;
            const key = (level !== null ? level + ':' : '') + (roomKeyOf(o) || str(o.id || o.name) || String(rooms.length));
            if (seen.has(key)) continue;
            seen.add(key);
            const p = pointOf(o);
            rooms.push({ key, storey: level, z: p && typeof p.z === 'number' ? p.z : null, objects, polygon, box });
        }
    }
    if (rooms.length >= 2) return rooms;
    const groups = new Map();
    for (const { list, storey } of lists) {
        for (const o of list) {
            const id = roomKeyOf(o);
            const p = pointOf(o);
            if (!id || !p) continue;
            const level = storeyKeyOf(o) !== null ? storeyKeyOf(o) : storey;
            const key = (level !== null ? level + ':' : '') + id;
            if (!groups.has(key)) groups.set(key, { key, storey: level, z: null, tiles: [] });
            groups.get(key).tiles.push(p);
        }
    }
    return groups.size >= 2 ? Array.from(groups.values()) : [];
}

module.exports = { Rooms, kindOf, parseGameRooms, storeyLevels, KINDS, SLEEP_BAG_RE };
