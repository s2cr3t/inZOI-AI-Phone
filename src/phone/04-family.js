    // ------------------------------------------------------------------
    // 我的家: the home's floor plan, storey by storey, with who of the family is where.
    // ui/phone/home/plan.cfg, written by the reply service (lib/homeplan.js) while the played
    // character is at home: { name, home, size, storeys: [{ level, walls: [[x1,y1,x2,y2]],
    // rooms: [{ name, kind, x, y }], items: [{ kind, name, x, y, yaw }] }], people: [{ id, name,
    // first, x, y, level, doing }], at }. Lot centimetres; away from home it is the plan last seen.
    // ------------------------------------------------------------------
    var HOME_SECTION = 'ui/phone/home';
    var homeLevel = null;
    var HOME_MARGIN = 80;
    // How each kind of thing is drawn: a letter on a tinted tile; doors and windows as bars.
    var HOME_ITEMS = {
        bed: { t: '床', c: '#5E5CE6' }, living: { t: '沙', c: '#FF9F0A' }, kitchen: { t: '厨', c: '#FF453A' },
        bath: { t: '浴', c: '#64D2FF' }, dining: { t: '餐', c: '#30D158' }, study: { t: '桌', c: '#BF5AF2' },
        laundry: { t: '洗', c: '#0A84FF' }
    };

    function loadFamily() {
        return Promise.all([cfgValue(HOME_SECTION, 'plan'), getMembers(), soft(getPossessedId()), cfgValue(HOME_SECTION, 'names')]).then(function (r) {
            return { plan: r[0] && Array.isArray(r[0].storeys) ? r[0] : null, members: r[1] || [], played: r[2] && !r[2].error ? String(r[2]) : '',
                names: r[3] && r[3].byKey ? r[3] : null };
        });
    }

    // The span of everything drawn, over all storeys, so switching storeys keeps the same frame.
    function homeBounds(plan) {
        var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        plan.storeys.forEach(function (s) {
            s.walls.forEach(function (w) {
                b.x0 = Math.min(b.x0, w[0], w[2]); b.x1 = Math.max(b.x1, w[0], w[2]);
                b.y0 = Math.min(b.y0, w[1], w[3]); b.y1 = Math.max(b.y1, w[1], w[3]);
            });
        });
        if (!isFinite(b.x0)) return null;
        b.x0 -= HOME_MARGIN; b.y0 -= HOME_MARGIN; b.x1 += HOME_MARGIN; b.y1 += HOME_MARGIN;
        return b;
    }

    // The nearest room on the same storey, for "在客厅".
    function homeRoomAt(storey, p) {
        var best = null;
        (storey ? storey.rooms : []).forEach(function (r) {
            if (r.kind === 'yard') return;
            var d = Math.sqrt((r.x - p.x) * (r.x - p.x) + (r.y - p.y) * (r.y - p.y));
            if (d < 450 && (!best || d < best.d)) best = { r: r, d: d };
        });
        return best ? best.r.name : '';
    }

    function homeSvg(w, h, b) {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(w));
        svg.setAttribute('height', String(h));
        svg.setAttribute('viewBox', b.x0 + ' ' + b.y0 + ' ' + (b.x1 - b.x0) + ' ' + (b.y1 - b.y0));
        svg.setAttribute('class', 'hm-svg');
        return svg;
    }

    function homeMap(data, plan, storey, width) {
        var b = homeBounds(plan);
        var box = node('div', 'hm-map');
        if (!b) return box;
        var scale = width / (b.x1 - b.x0);
        var height = Math.round((b.y1 - b.y0) * scale);
        box.style.width = width + 'px';
        box.style.height = height + 'px';
        var at = function (x, y) { return { left: Math.round((x - b.x0) * scale), top: Math.round((y - b.y0) * scale) }; };
        var svg = box.appendChild(homeSvg(width, height, b));
        storey.walls.forEach(function (wl) {
            var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', String(wl[0])); line.setAttribute('y1', String(wl[1]));
            line.setAttribute('x2', String(wl[2])); line.setAttribute('y2', String(wl[3]));
            line.setAttribute('class', 'hm-wall');
            line.setAttribute('stroke-width', String(Math.max(10, Math.round(2.6 / scale))));
            line.setAttribute('stroke-linecap', 'square');
            svg.appendChild(line);
        });
        // Doors and windows over the walls, then furniture, then room names, then people.
        storey.items.forEach(function (it) {
            var p = at(it.x, it.y);
            if (it.kind === 'door' || it.kind === 'window') {
                var bar = box.appendChild(node('div', 'hm-' + it.kind));
                bar.style.left = p.left + 'px';
                bar.style.top = p.top + 'px';
                bar.style.transform = 'translate(-50%, -50%) rotate(' + (it.yaw || 0) + 'deg)';
                return;
            }
            var k = HOME_ITEMS[it.kind];
            if (!k) return;
            var tile = box.appendChild(node('div', 'hm-item', it.kind === 'living' && /电视|TV/i.test(it.name) ? '视' : k.t));
            tile.style.left = p.left + 'px';
            tile.style.top = p.top + 'px';
            tile.style.color = k.c;
            tile.style.background = oaTint(k.c, 0.16);
        });
        storey.rooms.forEach(function (r) {
            var p = at(r.x, r.y);
            var label = box.appendChild(node('div', 'hm-room' + (r.kind === 'yard' ? ' yard' : '') + (r.set ? ' set' : ''), r.name));
            label.style.left = p.left + 'px';
            label.style.top = p.top + 'px';
            if (r.key) onTap(label, function (e) { e.stopPropagation(); homeOpenRoom(r); });
        });
        (plan.home ? plan.people || [] : []).forEach(function (pp) {
            if (pp.level !== storey.level) return;
            var p = at(pp.x, pp.y);
            var dot = box.appendChild(node('div', 'hm-person'));
            dot.style.left = p.left + 'px';
            dot.style.top = p.top + 'px';
            var m = memberById(data.members, pp.id) || { entity_id: pp.id, first_name: pp.first || pp.name };
            dot.appendChild(faceAvatar(m));
            dot.appendChild(node('div', 'hm-person-name', pp.first || pp.name));
            dot.style.borderColor = accentFor(pp.id);
        });
        return box;
    }

// ---------- 我的家: what a room is, as the player says (ui/phone/home/names.cfg) ----------
    // { v, site, byKey: { <room key>: { kind, owners, owner, name, at } } }, written only here; the reply
    // service gives it to every character, so they all call the room the player's way.
    var HOME_KINDS = [
        { id: 'living', name: '客厅' }, { id: 'bed', name: '卧室' }, { id: 'kitchen', name: '厨房' }, { id: 'bath', name: '卫生间' },
        { id: 'study', name: '书房' }, { id: 'dining', name: '餐厅' }, { id: 'laundry', name: '洗衣间' }, { id: 'yard', name: '院子' },
        { id: 'other', name: '其他' }
    ];
    var HOME_NAME_MAX = 12;
    var homeEditKey = null;
    var homeDraft = null;     // { key, kind, owners: [id], name }; a bedroom may be a couple's

    function homeOpenRoom(r) {
        homeEditKey = r.key;
        var s = r.set || {};
        var owners = s.owners && s.owners.length ? s.owners.map(String) : s.owner ? [String(s.owner)] : [];
        homeDraft = { key: r.key, kind: s.kind || r.kind || 'other', owners: owners, name: s.name || '' };
        open('homeRoom');
    }

    // What the characters will call it, as the service will (lib/rooms.js setText).
    function homeSpoken(draft, data) {
        if (draft.name) return draft.name;
        var k = HOME_KINDS.filter(function (x) { return x.id === draft.kind; })[0];
        var base = k && k.id !== 'other' ? k.name : '房间';
        if (draft.kind === 'bed' && draft.owners.length) {
            var who = draft.owners.map(function (id) { var m = memberById(data.members, id); return m ? (draft.owners.length > 1 ? m.first_name || fullName(m) : fullName(m)) : ''; })
                .filter(Boolean);
            if (who.length) return who.join('和') + '的卧室';
        }
        return base;
    }

    function homeSaveNames(data, key, value) {
        var cur = data.names && data.names.byKey ? data.names.byKey : {};
        var byKey = {};
        for (var k in cur) if (cur.hasOwnProperty(k) && k !== key) byKey[k] = cur[k];
        if (value) byKey[key] = value;
        return saveJson('names', { v: 1, site: data.plan.site, byKey: byKey }, HOME_SECTION);
    }

    function homeChip(text, on, fn) {
        var chip = node('div', 'oa-chip hm-chip' + (on ? ' on' : ''), text);
        onTap(chip, function (e) { e.stopPropagation(); fn(); });
        return chip;
    }

    function renderHomeRoom(data) {
        var wrap = node('div', 'hm-screen');
        wrap.appendChild(subHeader('homeRoom'));
        var plan = data.plan;
        var room = null;
        (plan ? plan.storeys : []).forEach(function (s) { s.rooms.forEach(function (r) { if (r.key === homeEditKey) room = r; }); });
        if (!room || !homeDraft || homeDraft.key !== homeEditKey) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', '找不到这个房间了，回户型图再选一次。'));
            wrap.appendChild(none);
            return wrap;
        }
        var head = card();
        head.className += ' hm-head';
        head.appendChild(node('div', 'hm-name', homeSpoken(homeDraft, data)));
        head.appendChild(node('div', 'hm-sub', '自动识别：' + (room.auto || '房间') + '（看里面的家具判断）'));
        wrap.appendChild(head);

        var kinds = card('这是什么房间');
        var chips = [];
        HOME_KINDS.forEach(function (k) {
            chips.push(homeChip(k.name, homeDraft.kind === k.id, function () {
                homeDraft.kind = k.id;
                if (k.id !== 'bed') homeDraft.owners = [];
                refresh();
            }));
        });
        kinds.appendChild(oaChipRows(chips, 4));
        wrap.appendChild(kinds);

        if (homeDraft.kind === 'bed') {
            var whose = card('谁的卧室（可多选，比如夫妻、情侣）');
            var owners = [homeChip('不属于谁', !homeDraft.owners.length, function () { homeDraft.owners = []; refresh(); })];
            data.members.forEach(function (m) {
                if (NO_PHONE_STEPS[m.age_group] && m.age_group !== 'Toddler') return;
                var id = String(m.entity_id);
                owners.push(homeChip(m.first_name || fullName(m), homeDraft.owners.indexOf(id) >= 0, function () {
                    // Read the draft as it is now: a redraw keeps the old chip (morph).
                    var list = homeDraft ? homeDraft.owners.slice() : [];
                    var at = list.indexOf(id);
                    if (at >= 0) list.splice(at, 1);
                    else list.push(id);
                    if (homeDraft) homeDraft.owners = list;
                    refresh();
                }));
            });
            whose.appendChild(oaChipRows(owners, 3));
            wrap.appendChild(whose);
        }

        var named = card('自己起个名字（可不填）');
        var input = named.appendChild(node('input', 'oa-wage-input hm-name-input'));
        input.id = 'hm-room-name';
        applyUiFont(input);
        input.setAttribute('maxlength', String(HOME_NAME_MAX));
        input.setAttribute('placeholder', '比如：琴房、婴儿房、健身房');
        input.value = homeDraft.name || '';
        input.addEventListener('input', function () { if (homeDraft) homeDraft.name = input.value.trim().slice(0, HOME_NAME_MAX); });
        named.appendChild(node('div', 'oa-foot', '填了名字就用这个名字；不填就按上面选的类型叫。'));
        wrap.appendChild(named);

        var act = card();
        act.appendChild(node('div', 'hm-sub', '保存后，家里每个人在聊天里都会这样称呼这个房间，比如「我在' + homeSpoken(homeDraft, data) + '」。'));
        var row = act.appendChild(node('div', 'oa-ap-actions'));
        var reset = row.appendChild(node('div', 'oa-ap-btn', '恢复自动识别'));
        var save = row.appendChild(node('div', 'oa-ap-btn primary', '保存'));
        onTap(reset, function (e) {
            e.stopPropagation();
            homeSaveNames(data, homeEditKey, null).then(function () { setNote('已恢复自动识别。', false); open('family'); }, function () { setNote('没保存上，再试一次。', true); });
        });
        onTap(save, function (e) {
            e.stopPropagation();
            // The box on the page now (a redraw may have put a new one in its place).
            var box = document.getElementById('hm-room-name');
            if (box && homeDraft) homeDraft.name = String(box.value || '').trim().slice(0, HOME_NAME_MAX);
            var d = homeDraft;
            if (!d) return;
            var bedOwners = d.kind === 'bed' ? d.owners.slice() : [];
            homeSaveNames(data, d.key, { kind: d.kind, owners: bedOwners, owner: bedOwners[0] || '', name: d.name, at: Date.now() }).then(function () {
                setNote('已保存：' + homeSpoken(d, data) + '。', false);
                open('family');
            }, function () { setNote('没保存上，再试一次。', true); });
        });
        wrap.appendChild(act);
        return wrap;
    }

    function renderFamily(data) {
        var wrap = node('div', 'hm-screen');
        wrap.appendChild(subHeader('family'));
        var plan = data.plan;
        if (!plan || !plan.storeys.length) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', L('Your home is drawn the next time you are there.')));
            wrap.appendChild(none);
            return wrap;
        }
        var levels = plan.storeys.map(function (s) { return s.level; });
        if (homeLevel === null || levels.indexOf(homeLevel) < 0) {
            // The storey the played character is on, else the ground floor.
            var me = (plan.people || []).filter(function (p) { return p.id === data.played; })[0];
            homeLevel = me && levels.indexOf(me.level) >= 0 ? me.level : levels[0];
        }
        var storey = plan.storeys.filter(function (s) { return s.level === homeLevel; })[0];
        var head = card();
        head.className += ' hm-head';
        var top = head.appendChild(node('div', 'ph-row'));
        var who = top.appendChild(node('div', 'ph-who'));
        who.appendChild(node('div', 'hm-name', plan.name || L('My Home')));
        var rooms = 0;
        plan.storeys.forEach(function (s) { rooms += s.rooms.filter(function (r) { return r.kind !== 'yard'; }).length; });
        who.appendChild(node('div', 'hm-sub', L('{n} storeys · {r} rooms', { n: plan.storeys.length, r: rooms }) + (plan.home ? '' : ' · ' + L('away from home'))));
        if (levels.length > 1) {
            var seg = head.appendChild(node('div', 'hm-seg'));
            levels.forEach(function (lv) {
                var here = (plan.home ? plan.people || [] : []).filter(function (p) { return p.level === lv; }).length;
                var item = seg.appendChild(node('div', 'hm-seg-item' + (lv === homeLevel ? ' on' : ''), L('Floor {n}', { n: lv + 1 }) + (here ? ' · ' + here : '')));
                onTap(item, function (e) {
                    e.stopPropagation();
                    if (homeLevel === lv) return;
                    homeLevel = lv;
                    refresh();
                });
            });
        }
        wrap.appendChild(head);
        var mapCard = card();
        mapCard.className += ' hm-card';
        var width = 296;
        mapCard.appendChild(homeMap(data, plan, storey, width));
        wrap.appendChild(mapCard);
        // The rooms of this storey: what each is, and a tap to say otherwise.
        var list = storey.rooms.filter(function (r) { return r.key; });
        if (list.length) {
            var roomsCard = card('房间 · 点一下设定是什么');
            list.forEach(function (r) {
                var row = roomsCard.appendChild(node('div', 'ph-row hm-room-row'));
                var w = row.appendChild(node('div', 'ph-who'));
                w.appendChild(node('div', 'hm-where-name', r.name));
                w.appendChild(node('div', 'hm-where-sub', r.set ? '你设定的 · 自动识别是' + (r.auto || '房间') : '自动识别'));
                row.appendChild(node('span', 'ph-pill ' + (r.set ? 'pill-work' : 'pill-idle'), r.set ? '已设定' : '设定'));
                onTap(row, function (e) { e.stopPropagation(); homeOpenRoom(r); });
            });
            wrap.appendChild(roomsCard);
        }
        // Who is where, under the map.
        var people = plan.home ? plan.people || [] : [];
        if (people.length) {
            var where = card();
            people.forEach(function (pp) {
                var s = plan.storeys.filter(function (x) { return x.level === pp.level; })[0];
                var room = homeRoomAt(s, pp);
                var row = where.appendChild(node('div', 'ph-row hm-where'));
                var m = memberById(data.members, pp.id) || { entity_id: pp.id, first_name: pp.first || pp.name };
                row.appendChild(faceAvatar(m));
                var w = row.appendChild(node('div', 'ph-who'));
                w.appendChild(node('div', 'hm-where-name', pp.name));
                w.appendChild(node('div', 'hm-where-sub', [levels.length > 1 ? L('Floor {n}', { n: pp.level + 1 }) : '', room, pp.doing].filter(Boolean).join(' · ')));
                onTap(row, function (e) {
                    e.stopPropagation();
                    if (homeLevel === pp.level) return;
                    homeLevel = pp.level;
                    refresh();
                });
            });
            wrap.appendChild(where);
        }
        wrap.appendChild(node('div', 'ph-caption hm-foot', plan.home ? L('Drawn from the game while you are at home.')
            : L('Away from home: this is how it looked the last time you were there.')));
        return wrap;
    }

    // ------------------------------------------------------------------
    // Bonds
    // ------------------------------------------------------------------
    function loadBonds() {
        return Promise.all([getEnv(), getPossessedId(), getMembers()]).then(function (r) {
            var me = r[1];
            var members = r[2];
            var self = null;
            var others = [];
            members.forEach(function (m) {
                if (String(m.entity_id) === me) self = m;
                else others.push(m);
            });
            return Promise.all(others.map(function (m) {
                return soft(call('relationships.get_value_between',
                    { owner_id: me, target_id: String(m.entity_id) }, 'stats'));
            })).then(function (rels) {
                return { env: r[0], meId: me, self: self, others: others, rels: rels };
            });
        });
    }

    function renderBonds(data) {
        var wrap = node('div');
        wrap.appendChild(subHeader('bonds'));
        var from = data.self ? fullName(data.self) : ('#' + data.meId);
        wrap.appendChild(node('div', 'ph-caption', 'How ' + from + ' feels about everyone'));

        if (!data.others.length) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'Nobody else lives here.'));
            wrap.appendChild(none);
            return wrap;
        }
        data.others.forEach(function (m, idx) {
            var rel = data.rels[idx];
            var c = card();
            c.appendChild(personRow(m, [m.relationship_label, m.age_group_text], null));
            if (!rel || rel.error || !rel.stats) {
                var msg = node('div', 'ph-empty', 'Relationship unavailable');
                msg.style.marginTop = '10px';
                c.appendChild(msg);
            } else {
                BONDS.forEach(function (b) {
                    var s = rel.stats[b.key];
                    if (!s || typeof s.value !== 'number') return;
                    var item = node('div', 'ph-bond');
                    var top = node('div', 'ph-bond-top');
                    top.appendChild(node('span', null, b.label));
                    top.appendChild(node('span', 'ph-need-val', String(Math.round(s.value))));
                    item.appendChild(top);
                    item.appendChild(bar(s.value, b.color));
                    c.appendChild(item);
                });
            }
            wrap.appendChild(c);
        });
        return wrap;
    }

    // ------------------------------------------------------------------
    // Stories: each family member's own story as the played character has come to know it,
    // from ui/phone/stories/board.cfg (written by the reply service, lib/stories.js). A story
    // still running shows the clues the contact let slip in the chat, how far it has come and
    // the days left, and its title once the contact said what it is. An ended story shows all
    // of it. The newest ending the player has looked at is kept in saved/stories-seen.cfg.
    // ------------------------------------------------------------------
    var ST_SECTION = 'ui/phone/stories';
    var ST_SEEN_KEY = 'stories-seen';
    var stOpen = {};

    function stBoard() {
        return cachedRead('stboard', 3000, function () {
            return cfgValue(ST_SECTION, 'board').then(function (v) {
                return v && v.v === 1 && Array.isArray(v.pairs) ? v : null;
            });
        });
    }

    function stSeenAt() {
        return cfgValue(SOUND_SECTION, ST_SEEN_KEY).then(function (v) {
            return v && typeof v.at === 'number' ? v.at : 0;
        });
    }

    function stMine(board, meId) {
        return board ? board.pairs.filter(function (p) { return p && String(p.playerId) === String(meId); }) : [];
    }

    function stNewest(pairs) {
        var at = 0;
        pairs.forEach(function (p) {
            (p.ended || []).forEach(function (e) { if (e && e.at > at) at = e.at; });
        });
        return at;
    }

    // Endings the played character has not looked at yet, for the icon badge.
    function storiesNew(meId) {
        return Promise.all([stBoard(), stSeenAt()]).then(function (r) {
            var n = 0;
            stMine(r[0], meId).forEach(function (p) {
                (p.ended || []).forEach(function (e) { if (e && e.at > r[1]) n += 1; });
            });
            return n;
        }, function () { return 0; });
    }

    function loadStories() {
        return Promise.all([getEnv(), getPossessedId(), soft(getMembers()), loadPortraitIndex(), loadOutside(), stBoard(), stSeenAt(),
            stKeepSeenAt().then(null, function () { return 0; })]).then(function (r) {
            var meId = String(r[1]);
            var members = r[2] && !r[2].error ? r[2] : [];
            var pairs = stMine(r[5], meId);
            var newest = stNewest(pairs);
            if (newest > r[6]) saveJson(ST_SEEN_KEY, { at: newest }, SOUND_SECTION).then(null, function () {});
            return { env: r[0], meId: meId, members: grpPeople(members), board: r[5], pairs: pairs, seenAt: r[6], keepSeenAt: r[7] };
        });
    }

    function stPerson(data, p) {
        var m = memberById(data.members, p.contactId);
        return m || { entity_id: p.contactId, first_name: p.name || ('#' + p.contactId), last_name: '' };
    }

    function stDay(day, env) {
        if (typeof day !== 'number') return '';
        if (env && typeof env.day === 'number') {
            var ago = env.day - day;
            if (ago <= 0) return '今天';
            if (ago === 1) return '昨天';
            return ago + ' 天前';
        }
        return '第 ' + day + ' 天';
    }

    function stProgress(a) {
        var wrap = node('div', 'st-progress');
        var track = node('div', 'st-steps');
        for (var i = 0; i < a.stages; i++) {
            track.appendChild(node('div', 'st-step' + (i < a.stage ? ' done' : i === a.stage ? ' now' : '')));
        }
        wrap.appendChild(track);
        var parts = ['进展 ' + Math.min(a.stage + 1, a.stages) + '/' + a.stages];
        if (typeof a.daysLeft === 'number') parts.push(a.daysLeft <= 0 ? '今天就有结果' : '还剩 ' + a.daysLeft + ' 天');
        wrap.appendChild(node('div', 'st-progress-text' + (a.soon ? ' soon' : ''), parts.join(' · ')));
        return wrap;
    }

    function stClues(list, env, empty) {
        var box = node('div', 'st-clues');
        if (!list || !list.length) {
            if (empty) box.appendChild(node('div', 'st-clue-empty', empty));
            return box;
        }
        list.forEach(function (c) {
            var row = node('div', 'st-clue');
            row.appendChild(node('span', 'st-clue-dot'));
            row.appendChild(node('span', 'st-clue-text', c.text));
            var when = stDay(c.day, env);
            if (when) row.appendChild(node('span', 'st-clue-day', when));
            box.appendChild(row);
        });
        return box;
    }

    function stActiveCard(data, p) {
        var a = p.active;
        var m = stPerson(data, p);
        var c = node('div', 'ph-card st-card' + (a.soon ? ' soon' : ''));
        var head = node('div', 'ph-row');
        head.appendChild(faceAvatar(m));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', fullName(m)));
        who.appendChild(node('div', 'st-title' + (a.revealed ? '' : ' hidden'),
            a.revealed ? '「' + a.title + '」' + (a.kind ? ' · ' + a.kind : '') : '好像有心事，还不知道是什么事'));
        head.appendChild(who);
        if (a.soon) head.appendChild(node('span', 'ph-pill st-pill soon', '快有结果了'));
        c.appendChild(head);
        c.appendChild(stProgress(a));
        if (a.depth > 0) c.appendChild(node('div', 'st-deep', a.depth > 1 ? '这是一件藏了很久的大心事' : '这是一件更私密的心事'));
        c.appendChild(node('div', 'st-sub', '你察觉到的'));
        c.appendChild(stClues(a.clues, data.env, '还没聊出什么。问问' + (m.first_name || 'TA') + '最近怎么样。'));
        var go = node('div', 'st-go', '去聊聊 \u203A');
        c.appendChild(go);
        onTap(c, function (e) {
            e.stopPropagation();
            smsContactId = String(p.contactId);
            open('chat');
        });
        return c;
    }

    function stOutcomePill(e) {
        if (e.how === 'grew up') return node('span', 'ph-pill st-pill past', '已经过去');
        if (e.how === 'died') return node('span', 'ph-pill st-pill past', '没来得及');
        return e.good ? node('span', 'ph-pill st-pill good', '好结局') : node('span', 'ph-pill st-pill bad', '坏结局');
    }

    function stHowText(e) {
        if (e.how === 'in the chat') return e.good ? '你帮上了忙' : '你知道这件事，但没能如愿';
        if (e.how === 'grew up') return '长大以后，这件事慢慢过去了';
        if (e.how === 'died') return '人走了，这件事没来得及有结果';
        return '你没察觉到';
    }

    // A bad ending that can still be made right opens the chat; one made right says so.
    function stMendLine(p, e, m) {
        var mend = e.mend;
        if (!mend || typeof mend !== 'object') return null;
        if (mend.state === 'mended') return node('div', 'st-mend done', '后来你去安慰过了，' + (m.first_name || 'TA') + '心里好受多了');
        if (mend.state === 'missed') return node('div', 'st-mend missed', '没来得及补救');
        if (mend.state !== 'open') return null;
        var left = typeof mend.daysLeft === 'number' && mend.daysLeft > 0 ? '还有 ' + (mend.daysLeft + 1) + ' 天' : '今天还来得及';
        var line = node('div', 'st-mend open', (m.first_name || 'TA') + '还在意这件事 · ' + left + '，去安慰一下 \u203A');
        onTap(line, function (ev) {
            ev.stopPropagation();
            smsContactId = String(p.contactId);
            open('chat');
        });
        return line;
    }

    // ------------------------------------------------------------------
    // 纪念与信任 (stkeep): what helping the family has come to. The trust each member has in the
    // played character as a ladder of titles, the keepsakes the stories left, the bad endings
    // that can still be made right and the ones that were. The ladder comes with the board
    // (lib/stories.js TRUST); ST_LADDER is the same for a board written before it was there.
    // ------------------------------------------------------------------
    var ST_LADDER = [
        { helped: 1, title: '开始信任你', depth: 0 },
        { helped: 2, title: '愿意对你说心里话', depth: 1 },
        { helped: 4, title: '把你当最懂自己的人', depth: 2 }
    ];
    var ST_UNLOCK = ['', '解锁私密心事', '解锁深藏心事'];
    var ST_KEEP_SEEN_KEY = 'stories-keep-seen';
    var stKeepSel = null;
    // Keepsakes newer than this are marked new while the phone stays open, though the page
    // saved them as seen at the first look.
    var stKeepMark = null;

    function stKeepSeenAt() {
        return cfgValue(SOUND_SECTION, ST_KEEP_SEEN_KEY).then(function (v) {
            return v && typeof v.at === 'number' ? v.at : 0;
        });
    }

    function stLadder(board) {
        var l = board && Array.isArray(board.ladder) ? board.ladder.filter(function (r) {
            return r && typeof r.helped === 'number' && r.helped > 0 && typeof r.title === 'string' && r.title;
        }) : [];
        return l.length ? l : ST_LADDER;
    }

    // Every ending of the played character's pairs, newest first.
    function stEnded(data) {
        var ended = [];
        data.pairs.forEach(function (p) {
            (p.ended || []).forEach(function (e) { if (e && e.id) ended.push({ p: p, e: e }); });
        });
        ended.sort(function (x, y) { return (y.e.at || 0) - (x.e.at || 0) || (y.e.endedDay || 0) - (x.e.endedDay || 0); });
        return ended;
    }

    // Stories helped through and made right are counted all time (the trust counts); the
    // keepsakes are those still in the archive.
    function stTally(data, ended) {
        var t = { helped: 0, mended: 0, keepsakes: 0, best: null, fresh: false };
        data.pairs.forEach(function (p) {
            var tr = p.trust;
            if (!tr || typeof tr.helped !== 'number') return;
            t.helped += tr.helped;
            t.mended += tr.mended || 0;
            if (tr.title && (!t.best || tr.level > t.best.trust.level || (tr.level === t.best.trust.level && tr.helped > t.best.trust.helped))) t.best = p;
        });
        ended.forEach(function (x) {
            if (!x.e.keepsake) return;
            t.keepsakes += 1;
            if (x.e.at > data.keepSeenAt) t.fresh = true;
        });
        return t;
    }

    function stTrusted(data) {
        var pairs = data.pairs.filter(function (p) { return p.trust && typeof p.trust.helped === 'number'; });
        pairs.sort(function (x, y) { return (y.trust.level - x.trust.level) || (y.trust.helped - x.trust.helped); });
        return pairs;
    }

    // On the Stories page: the way in, with where things stand.
    function stEntryCard(data, ended) {
        var t = stTally(data, ended);
        var c = node('div', 'ph-card st-entry' + (t.fresh ? ' fresh' : ''));
        c.appendChild(node('div', 'st-entry-badge', String(t.keepsakes)));
        var who = node('div', 'ph-who');
        var top = node('div', 'st-entry-top');
        top.appendChild(node('span', 'st-entry-title', '纪念与信任'));
        if (t.fresh) top.appendChild(node('span', 'ph-pill st-pill fresh', '新纪念'));
        who.appendChild(top);
        who.appendChild(node('div', 'st-entry-sub', t.best
            ? fullName(stPerson(data, t.best)) + ' 现在「' + t.best.trust.title + '」'
            : '帮家人度过一件心事，就会在这里留下纪念'));
        var parts = ['帮成 ' + t.helped + ' 件', '纪念 ' + t.keepsakes + ' 件'];
        if (t.mended) parts.push('补救 ' + t.mended + ' 件');
        who.appendChild(node('div', 'st-entry-count', parts.join(' · ')));
        c.appendChild(who);
        c.appendChild(node('div', 'st-entry-go', '\u203A'));
        onTap(c, function (e) {
            e.stopPropagation();
            open('stkeep');
        });
        return c;
    }

    function loadStoryKeep() {
        return loadStories().then(function (data) {
            var newest = 0;
            data.pairs.forEach(function (p) {
                (p.ended || []).forEach(function (e) { if (e && e.keepsake && e.at > newest) newest = e.at; });
            });
            if (newest > data.keepSeenAt) {
                if (stKeepMark === null) stKeepMark = data.keepSeenAt;
                saveJson(ST_KEEP_SEEN_KEY, { at: newest }, SOUND_SECTION).then(null, function () {});
            }
            data.keepNewAfter = stKeepMark === null ? data.keepSeenAt : Math.min(stKeepMark, data.keepSeenAt);
            return data;
        });
    }

    function stHero(data, ended) {
        var t = stTally(data, ended);
        var hero = node('div', 'st-hero');
        var stats = node('div', 'st-hero-stats');
        [['帮成的心事', t.helped], ['收集的纪念', t.keepsakes], ['补救回来', t.mended]].forEach(function (s) {
            var cell = node('div', 'st-hero-stat');
            cell.appendChild(node('div', 'st-hero-num', String(s[1])));
            cell.appendChild(node('div', 'st-hero-label', s[0]));
            stats.appendChild(cell);
        });
        hero.appendChild(stats);
        hero.appendChild(node('div', 'st-hero-line', t.best
            ? fullName(stPerson(data, t.best)) + ' 现在「' + t.best.trust.title + '」'
            : '帮家人度过一件心事，TA 会记着你的好，还会留下一件纪念。'));
        return hero;
    }

    function stMendOpenCard(data, ended) {
        var list = ended.filter(function (x) { return x.e.mend && x.e.mend.state === 'open'; });
        if (!list.length) return null;
        var c = card('还来得及补救');
        c.className += ' st-mend-card';
        list.forEach(function (x) {
            var m = stPerson(data, x.p);
            var row = node('div', 'st-mend-row');
            row.appendChild(node('div', 'st-ended-title', '「' + (x.e.title || '一件心事') + '」'));
            row.appendChild(node('div', 'st-ended-meta', fullName(m) + ' · ' + stHowText(x.e)));
            var line = stMendLine(x.p, x.e, m);
            if (line) row.appendChild(line);
            c.appendChild(row);
        });
        return c;
    }

    // One member's trust: the titles as steps, each filled as far as the stories helped reach.
    function stTrustLadder(data, p, ladder, first) {
        var m = stPerson(data, p);
        var t = p.trust;
        var box = node('div', 'st-tl' + (first ? '' : ' sep'));
        var head = node('div', 'ph-row');
        head.appendChild(faceAvatar(m));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', fullName(m)));
        var done = ['帮成 ' + t.helped + ' 件'];
        if (t.mended) done.push('补救 ' + t.mended + ' 件');
        who.appendChild(node('div', 'st-trust-count', done.join(' · ')));
        head.appendChild(who);
        head.appendChild(node('span', 'ph-pill st-pill ' + (t.title ? 'trust' : 'past'), t.title || '还不太了解'));
        box.appendChild(head);
        var rungs = node('div', 'st-rungs');
        var prev = 0;
        var prevDepth = 0;
        var next = null;
        ladder.forEach(function (r) {
            var on = t.helped >= r.helped;
            if (!on && !next) next = r;
            var rung = node('div', 'st-rung' + (on ? ' on' : ''));
            var track = node('div', 'st-rung-track');
            var fill = node('div', 'st-rung-fill');
            var span = r.helped - prev;
            fill.style.width = (on ? 100 : Math.max(0, Math.min(100, Math.round((t.helped - prev) / (span > 0 ? span : 1) * 100)))) + '%';
            track.appendChild(fill);
            rung.appendChild(track);
            rung.appendChild(node('div', 'st-rung-title', r.title));
            rung.appendChild(node('div', 'st-rung-need', on ? '已达成' : '帮成 ' + r.helped + ' 件'));
            var depth = typeof r.depth === 'number' ? r.depth : 0;
            if (depth > prevDepth && ST_UNLOCK[depth]) rung.appendChild(node('div', 'st-rung-unlock', ST_UNLOCK[depth]));
            prevDepth = Math.max(prevDepth, depth);
            prev = r.helped;
            rungs.appendChild(rung);
        });
        box.appendChild(rungs);
        var name = m.first_name || 'TA';
        box.appendChild(node('div', 'st-trust-next', next
            ? '再帮成 ' + (next.helped - t.helped) + ' 件，' + name + '就会「' + next.title + '」'
            : name + '已经把你当成最信任的人了'));
        return box;
    }

    function stKeepDetail(data, x) {
        var m = stPerson(data, x.p);
        var e = x.e;
        var box = node('div', 'st-kdetail');
        box.appendChild(node('div', 'st-kdetail-name', e.keepsake));
        var meta = ['「' + (e.title || '一件心事') + '」', fullName(m)];
        var when = stDay(e.endedDay, data.env);
        if (when) meta.push(when);
        box.appendChild(node('div', 'st-ended-meta', meta.join(' · ')));
        if (e.premise) {
            box.appendChild(node('div', 'st-sub', '那时' + (m.first_name || 'TA') + '心里的事'));
            box.appendChild(node('div', 'st-text', e.premise));
        }
        var mine = (e.steps || []).filter(function (s) { return s.how === 'in the chat'; });
        if (mine.length) {
            box.appendChild(node('div', 'st-sub', '你做过的'));
            box.appendChild(stClues(mine, data.env, ''));
        }
        box.appendChild(node('div', 'st-sub', '结局 · ' + stHowText(e)));
        box.appendChild(node('div', 'st-text', e.outcome || ''));
        return box;
    }

    function stKeepCollection(data, ended) {
        var list = ended.filter(function (x) { return x.e.keepsake; });
        var c = card('纪念品收藏');
        if (!list.length) {
            c.appendChild(node('div', 'ph-empty', '还没有纪念品。在聊天里帮家人把心事办成，就会留下一件。'));
            return c;
        }
        c.appendChild(node('div', 'st-tally', '已收集 ' + list.length + ' 件 · 点一件看看它的来历'));
        var grid = node('div', 'st-kgrid');
        var sel = null;
        list.forEach(function (x) {
            var key = x.p.key + '/' + x.e.id;
            var isSel = stKeepSel === key;
            if (isSel) sel = x;
            var m = stPerson(data, x.p);
            var tile = node('div', 'st-ktile');
            var inner = node('div', 'st-ktile-in' + (isSel ? ' sel' : ''));
            if (x.e.at > data.keepNewAfter) inner.appendChild(node('span', 'st-ktile-new', '新'));
            inner.appendChild(node('div', 'st-ktile-name', x.e.keepsake));
            inner.appendChild(node('div', 'st-ktile-from', '「' + (x.e.title || '一件心事') + '」'));
            var meta = [m.first_name || fullName(m)];
            var when = stDay(x.e.endedDay, data.env);
            if (when) meta.push(when);
            inner.appendChild(node('div', 'st-ktile-meta', meta.join(' · ')));
            tile.appendChild(inner);
            onTap(tile, function (ev) {
                ev.stopPropagation();
                stKeepSel = isSel ? null : key;
                refresh();
            });
            grid.appendChild(tile);
        });
        c.appendChild(grid);
        if (sel) c.appendChild(stKeepDetail(data, sel));
        return c;
    }

    function stMendedCard(data, ended) {
        var list = ended.filter(function (x) { return x.e.mend && x.e.mend.state === 'mended'; });
        if (!list.length) return null;
        var c = card('补救回来的');
        list.forEach(function (x) {
            var m = stPerson(data, x.p);
            var row = node('div', 'st-mend-row');
            row.appendChild(node('div', 'st-ended-title', '「' + (x.e.title || '一件心事') + '」'));
            var meta = [fullName(m)];
            var when = stDay(x.e.mend.day, data.env);
            if (when) meta.push(when + '补救');
            row.appendChild(node('div', 'st-ended-meta', meta.join(' · ')));
            row.appendChild(node('div', 'st-mend done', x.e.mend.text || ('后来你去安慰过了，' + (m.first_name || 'TA') + '心里好受多了')));
            c.appendChild(row);
        });
        return c;
    }

    function renderStoryKeep(data) {
        var wrap = node('div');
        wrap.appendChild(subHeader('stkeep', '纪念与信任'));
        var why = !data.board ? 'AI 手机服务还没有写出心事。打开 AI 页面确认服务在运行，然后和家人聊几句。'
            : data.board.enabled === false ? '心事在 AI 手机服务的设置里关掉了。'
            : data.board.rewards === false ? '心事的奖励在 AI 手机服务的设置里关掉了。' : '';
        if (why) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', why));
            wrap.appendChild(none);
            return wrap;
        }
        var ended = stEnded(data);
        wrap.appendChild(stHero(data, ended));
        var mend = stMendOpenCard(data, ended);
        if (mend) wrap.appendChild(mend);
        var ladder = stLadder(data.board);
        var trust = card('家人的信任');
        var pairs = stTrusted(data);
        if (!pairs.length) trust.appendChild(node('div', 'ph-empty', '和家人多聊聊。等 TA 有了心事、你帮上了忙，信任就从这里开始。'));
        pairs.forEach(function (p, i) { trust.appendChild(stTrustLadder(data, p, ladder, i === 0)); });
        wrap.appendChild(trust);
        wrap.appendChild(stKeepCollection(data, ended));
        var mended = stMendedCard(data, ended);
        if (mended) wrap.appendChild(mended);
        return wrap;
    }

    function stEndedRow(data, p, e) {
        var m = stPerson(data, p);
        var key = p.key + '/' + e.id;
        var open_ = !!stOpen[key];
        var row = node('div', 'st-ended' + (open_ ? ' open' : '') + (e.at > data.seenAt ? ' new' : ''));
        var top = node('div', 'st-ended-top');
        top.appendChild(node('div', 'st-ended-title', '「' + (e.title || '一件心事') + '」'));
        top.appendChild(stOutcomePill(e));
        row.appendChild(top);
        var meta = [fullName(m)];
        if (e.kind) meta.push(e.kind);
        var when = stDay(e.endedDay, data.env);
        if (when) meta.push(when);
        row.appendChild(node('div', 'st-ended-meta', meta.join(' · ')));
        if (e.keepsake) row.appendChild(node('div', 'st-keepsake', e.keepsake));
        var mend = stMendLine(p, e, m);
        if (mend) row.appendChild(mend);
        if (open_) {
            if (e.premise) {
                row.appendChild(node('div', 'st-sub', '真实情况'));
                row.appendChild(node('div', 'st-text', e.premise));
            }
            if (e.clues && e.clues.length) {
                row.appendChild(node('div', 'st-sub', '你察觉到的'));
                row.appendChild(stClues(e.clues, data.env, ''));
            }
            var mine = (e.steps || []).filter(function (s) { return s.how === 'in the chat'; });
            if (mine.length) {
                row.appendChild(node('div', 'st-sub', '你做过的'));
                row.appendChild(stClues(mine, data.env, ''));
            }
            row.appendChild(node('div', 'st-sub', '结局 · ' + stHowText(e)));
            row.appendChild(node('div', 'st-text', e.outcome || ''));
        } else {
            row.appendChild(node('div', 'st-ended-more', '查看经过 \u203A'));
        }
        onTap(row, function (ev) {
            ev.stopPropagation();
            stOpen[key] = !open_;
            refresh();
        });
        return row;
    }

    function renderStories(data) {
        var wrap = node('div');
        wrap.appendChild(subHeader('stories'));
        if (!data.board) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'AI 手机服务还没有写出心事。打开 AI 页面确认服务在运行，然后和家人聊几句。'));
            wrap.appendChild(none);
            return wrap;
        }
        if (data.board.enabled === false) {
            var off = card();
            off.appendChild(node('div', 'ph-empty', '心事在 AI 手机服务的设置里关掉了。'));
            wrap.appendChild(off);
            return wrap;
        }
        wrap.appendChild(node('div', 'ph-caption', data.board.rewards === false
            ? '每个人都有自己的心事。多聊聊，线索会慢慢浮出来；没人在意，事情也会自己往坏处走。'
            : '每个人都有自己的心事。多聊聊，线索会慢慢浮出来。帮上了忙，TA 会记着你的好、更信任你，以后也愿意说更深的心事；没帮上，过后去安慰一下也还来得及。'));
        var ended = stEnded(data);
        if (data.board.rewards !== false) wrap.appendChild(stEntryCard(data, ended));
        var active = data.pairs.filter(function (p) { return p.active; });
        active.sort(function (x, y) {
            var a = x.active;
            var b = y.active;
            if (a.soon !== b.soon) return a.soon ? -1 : 1;
            if ((a.clues.length > 0) !== (b.clues.length > 0)) return a.clues.length ? -1 : 1;
            return (b.clues.length - a.clues.length) || (b.stage - a.stage);
        });
        if (!active.length) {
            var calm = card();
            calm.appendChild(node('div', 'ph-empty', '现在家里没人有心事。和家人多聊聊，新的心事过一阵就会冒出来。'));
            wrap.appendChild(calm);
        }
        active.forEach(function (p) { wrap.appendChild(stActiveCard(data, p)); });
        if (ended.length) {
            var arch = card('已经了结的心事');
            var good = ended.filter(function (x) { return x.e.how === 'in the chat' && x.e.good; }).length;
            var mended = ended.filter(function (x) { return x.e.mend && x.e.mend.state === 'mended'; }).length;
            arch.appendChild(node('div', 'st-tally', '一共 ' + ended.length + ' 件 · 你帮上忙的 ' + good + ' 件' + (mended ? ' · 补救的 ' + mended + ' 件' : '')));
            ended.forEach(function (x) { arch.appendChild(stEndedRow(data, x.p, x.e)); });
            wrap.appendChild(arch);
        }
        return wrap;
    }

