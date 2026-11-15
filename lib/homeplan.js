'use strict';
// The floor plan of the household's home for the phone's 我的家 app: walls, rooms, the furniture
// that names them, doors and windows, and who of the family is where, storey by storey.
//
// Read from the game while the played character is at home (the lot whose entity is the home site
// career_get_work_status gives, world_get_loaded_sites mapping it to the lot build_get_site_info
// names): build_scan_walls (wall segments, lot cm, by storey), build_scan_objects (each thing's lot
// position, storey and yaw, and its world position too), the rooms rooms.js makes of the furniture
// (names such as 主卧, 宗会荣的卧室), and each member's position (their entity's world transform and
// floor, turned into lot cm with the lot's own turn and offset, worked out from the things scanned in
// both). Away from home the
// plan kept from the last time is shown, without people.
//
// <phone>/home/plan.cfg (this module only):
//   { v, at, site, name, size: { x, y }, home: true|false, storeys: [{ level, walls: [[x1,y1,x2,y2]],
//     rooms: [{ key, name, kind, auto, set, x, y }], items: [{ kind, name, x, y, yaw }] }],
//     (auto: what the furniture made of it; set: what the player said, from names.cfg)
// <phone>/home/names.cfg (the phone only): { v, site, byKey: { <room key>: { kind, owner, name, at } } },
//   what the player said each room is; read here and given to rooms.js for every label.
//     people: [{ id, name, x, y, level, room, doing }], peopleAt }
const path = require('path');
const fsx = require('./fsx');
const { kindOf, roomKey } = require('./rooms');

const V = 1;
const STATIC_EVERY_MS = 3 * 60000;
const PEOPLE_EVERY_MS = 5000;
// The kinds of things drawn: furniture that names a room, and doors and windows.
const DOOR_RE = /门|Door/i;
const WINDOW_RE = /窗|Window/i;
const NOT_DOOR_RE = /门锁|门牌|门垫|门帘|Doormat|门把/;
const FLOOR_CM = 390;

const num = (v) => typeof v === 'number' && isFinite(v);

// The lot's turn and offset: world = R(turn) * lot + shift, from things scanned in both.
function transformOf(objects) {
    const both = objects.filter((o) => o && o.location && o.world_location && num(o.location.x) && num(o.world_location.x));
    if (both.length < 2) return null;
    const a = both[0];
    let b = null;
    for (const o of both) {
        if (Math.hypot(o.location.x - a.location.x, o.location.y - a.location.y) > 300) { b = o; break; }
    }
    if (!b) return null;
    const la = Math.atan2(b.location.y - a.location.y, b.location.x - a.location.x);
    const wa = Math.atan2(b.world_location.y - a.world_location.y, b.world_location.x - a.world_location.x);
    const t = wa - la;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const sx = a.world_location.x - (cos * a.location.x - sin * a.location.y);
    const sy = a.world_location.y - (sin * a.location.x + cos * a.location.y);
    const sz = num(a.world_location.z) && num(a.location.z) ? a.world_location.z - a.location.z : 0;
    return {
        toLot(w) {
            const dx = w.x - sx;
            const dy = w.y - sy;
            return { x: cos * dx + sin * dy, y: -sin * dx + cos * dy, z: num(w.z) ? w.z - sz : null };
        }
    };
}

function itemKind(name, table) {
    const k = kindOf(name);
    if (k) return k.kind;
    if (WINDOW_RE.test(name) || /Window/i.test(table)) return 'window';
    if ((DOOR_RE.test(name) || /Door/i.test(table)) && !NOT_DOOR_RE.test(name)) return 'door';
    return '';
}

class HomePlan {
    constructor(daemon) {
        this.d = daemon;
        this.log = daemon.log;
        this.file = '';
        this.plan = null;
        this.staticAt = 0;
        this.peopleAt = 0;
        this.busy = false;
        this.transform = null;
    }

    configure(phoneDir) {
        this.file = path.join(phoneDir, 'home', 'plan.cfg');
        this.namesFile = path.join(phoneDir, 'home', 'names.cfg');
        this.namesText = null;
        const r = fsx.readJson(this.file);
        this.plan = r.ok && r.value && Array.isArray(r.value.storeys) ? r.value : null;
    }

    // Every few seconds (daemon): the plan while at home, people more often than walls.
    async tick() {
        if (this.busy || !this.file) return;
        this.busy = true;
        try {
            // The player renamed a room: given to rooms.js at once (prompts use it home or away), and the plan's labels again.
            if (this.readNames()) this.staticAt = 0;
            const atHome = await this.atHome();
            if (!atHome) {
                if (this.plan && this.plan.home) {
                    this.plan.home = false;
                    this.plan.people = [];
                    this.write();
                }
                return;
            }
            const now = Date.now();
            if (!this.plan || !this.transform || now - this.staticAt > STATIC_EVERY_MS || this.plan.site !== atHome.site) {
                await this.readStatic(atHome);
                // No rooms yet (the furniture's names still loading): soon again, not in minutes.
                const rooms = this.plan ? this.plan.storeys.reduce((n, st) => n + st.rooms.length, 0) : 0;
                this.staticAt = rooms ? now : now - STATIC_EVERY_MS + 15000;
            }
            if (now - this.peopleAt >= PEOPLE_EVERY_MS) {
                await this.readPeople();
                this.peopleAt = now;
            }
            this.plan.home = true;
            this.write();
        } catch (e) {
            this.log.debug('homeplan: ' + (e && e.message || e));
        } finally {
            this.busy = false;
        }
    }

    // The player's names for the rooms, handed to rooms.js. True when they changed.
    readNames() {
        const text = fsx.readText(this.namesFile);
        if (text === this.namesText) return false;
        this.namesText = text;
        let v = null;
        try { v = text ? JSON.parse(text) : null; } catch (e) { v = null; }
        if (v && v.site && v.byKey && this.d.rooms) {
            this.d.rooms.setNames(v.site, v.byKey);
            this.log.info('homeplan: ' + Object.keys(v.byKey).length + ' room name(s) set by the player for ' + v.site);
        }
        return true;
    }

    // { site, name, size } when the played character is on the household's home lot, else null.
    async atHome() {
        const id = await this.d.world.possessed();
        if (!id) return null;
        const g = this.d.game;
        const [ws, info] = await Promise.all([
            this.d.world.cached('home-site:' + id, 60000, () => g.soft('career_get_work_status', { entity_id: String(id) })),
            g.soft('build_get_site_info', {})
        ]);
        if (!ws || !info || !info.site_id) return null;
        const sites = await this.d.world.sites();
        const home = sites.byEntity.get(String(ws.home_site_id));
        if (!home || home.id !== String(info.site_id)) return null;
        return { site: home.id, entity: String(ws.home_site_id), name: home.name, size: info.site_size || null };
    }

    async readStatic(home) {
        const g = this.d.game;
        const [walls, objs, rows] = await Promise.all([
            g.soft('build_scan_walls', { Limit: 0 }),
            g.soft('build_scan_objects', { Limit: 0 }),
            this.d.actions.scanSite().catch(() => null)
        ]);
        const objects = objs && Array.isArray(objs.objects) ? objs.objects : [];
        this.transform = transformOf(objects);
        const names = new Map((rows || []).map((r) => [String(r.id), r.name]));
        const storeys = new Map();
        const storey = (level) => {
            if (!storeys.has(level)) storeys.set(level, { level, walls: [], rooms: [], items: [] });
            return storeys.get(level);
        };
        for (const w of walls && Array.isArray(walls.walls) ? walls.walls : []) {
            if (!w.left || !w.right) continue;
            storey(Number(w.floor_level) || 0).walls.push([Math.round(w.left.x), Math.round(w.left.y), Math.round(w.right.x), Math.round(w.right.y)]);
        }
        const local = new Map();
        for (const o of objects) {
            if (!o || !o.location) continue;
            const id = String(o.entity_id);
            const level = Number(o.floor_level) || 0;
            local.set(id, { x: o.location.x, y: o.location.y, level });
            const name = names.get(id) || '';
            const kind = itemKind(name, String(o.table_id || ''));
            if (!kind) continue;
            storey(level).items.push({ kind, name, x: Math.round(o.location.x), y: Math.round(o.location.y), yaw: Math.round(Number(o.yaw) || 0) });
        }
        // Rooms: rooms.js's rooms of this lot, each placed at the middle of its things.
        if (rows && rows.length && this.d.rooms) {
            const ref = await this.d.actions.possessedSite().catch(() => null);
            const layout = ref ? this.d.rooms.layout(ref.id, rows, this.d.actions.lastScan ? this.d.actions.lastScan.at : rows.length) : null;
            const view = await this.view();
            if (!layout || !layout.rooms.length) this.log.info('homeplan: no rooms (' + (ref ? 'site ' + ref.id + ', ' + rows.length + ' things scanned, ' + (layout ? layout.source : 'no layout') : 'site of the played character unknown') + ')');
            for (const r of layout ? layout.rooms : []) {
                const pts = [...r.objects].map((oid) => local.get(String(oid))).filter(Boolean);
                if (!pts.length) continue;
                const level = pts[0].level;
                const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
                const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
                const set = this.d.rooms.nameOf(layout, r);
                const auto = (r.base + (r.n ? r.n : ''));
                storey(level).rooms.push({ key: roomKey(r), name: this.d.rooms.label(r, layout, view).replace(/^\d+楼 /, ''), kind: r.kind, auto,
                    set: set ? { kind: set.kind || '', owner: set.owner || '', name: set.name || '' } : null, x: Math.round(x), y: Math.round(y) });
            }
        }
        const list = [...storeys.values()].filter((s) => s.walls.length || s.items.length).sort((a, b) => a.level - b.level);
        this.plan = Object.assign({}, this.plan || {}, {
            v: V, at: Date.now(), site: home.site, entity: home.entity, name: home.name, size: home.size, storeys: list
        });
        this.log.info('homeplan: ' + home.name + ': ' + list.map((s) => (s.level + 1) + 'F ' + s.walls.length + ' walls, ' + s.rooms.length + ' rooms, ' + s.items.length + ' things').join('; '));
    }

    // Names for the room labels: everyone at home by name ("宗会荣的卧室").
    async view() {
        const hh = await this.d.world.household();
        const names = new Map((hh.members || []).map((m) => [String(m.entity_id), ((m.last_name || '') + (m.first_name || '')).trim()]));
        return { self: '', player: '', playerWord: '', names };
    }

    async readPeople() {
        if (!this.plan || !this.transform) return;
        const hh = await this.d.world.household();
        const people = [];
        for (const m of hh.members || []) {
            const id = String(m.entity_id);
            // Where they are: the character entity's own world transform, on the home lot only.
            const e = await this.d.game.soft('entity_reflect', { entity_id: id });
            const t = e && e.worldTransform && e.worldTransform.translation;
            const at = e && e.locatedSiteId ? String(e.locatedSiteId.value !== undefined ? e.locatedSiteId.value : e.locatedSiteId) : '';
            if (!t || !num(t.x) || at !== String(this.plan.entity)) continue;
            const p = this.transform.toLot(t);
            const level = num(Number(e.floorLevel)) ? Number(e.floorLevel) : num(p.z) ? Math.max(0, Math.floor((p.z + 60) / FLOOR_CM)) : 0;
            const cur = await this.d.game.soft('interaction_get_current', { entity_id: id });
            let doing = '';
            if (cur && cur.playing && cur.interaction_bag_id) doing = await this.d.world.interactionName(cur.interaction_bag_id).catch(() => '');
            people.push({ id, name: ((m.last_name || '') + (m.first_name || '')).trim(), first: m.first_name || '', x: Math.round(p.x), y: Math.round(p.y), level, doing: doing || '' });
        }
        this.plan.people = people;
        this.plan.peopleAt = Date.now();
    }

    write() {
        if (!this.plan) return;
        try {
            fsx.ensureDir(path.dirname(this.file));
            const text = JSON.stringify(this.plan);
            if (fsx.readText(this.file) !== text) fsx.writeAtomic(this.file, text);
        } catch (e) {
            this.log.warn('homeplan: not written: ' + e.message);
        }
    }
}

module.exports = { HomePlan, transformOf, itemKind };
