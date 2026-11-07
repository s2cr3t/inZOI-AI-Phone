    // ------------------------------------------------------------------
    // Group chats. One conversation with several of the phone's contacts in it, answered by
    // the PC service (lib/groups.js). Files, all under ui/phone/groups/:
    //   list.cfg           { v, groups: [{ id, name, members: [id] }] }        this screen writes
    //   g-<id>/meta.cfg    { v, id, name, owner, members: [{ id, name }], auto }
    //   g-<id>/outbox.cfg  what the player typed: { id, text, at, mentions, replyTo }
    //   g-<id>/inbox.cfg   what the contacts said: { id, from, name, text, at, to, replyTo }
    // ------------------------------------------------------------------
    var SMS_G_SECTION = 'ui/phone/groups';
    var SMS_G_MAX = 8;
    var SMS_G_TEXT_MAX = 400;
    var SMS_G_KEEP = 200;
    var grpIndex = null;
    var grpId = '';
    var grpDraft = '';
    var grpComposing = false;
    var grpComposingAt = 0;
    var grpRenderedKey = '';
    var grpShown = null;
    var grpStick = true;
    var grpScroll = 0;
    // While this is in the future, nothing may turn the pin off: right after entering, the log
    // can be measured before it has a height, and that reads as "the reader scrolled up".
    var grpPinnedUntil = 0;
    var grpFocused = false;
    var grpReply = null;
    var grpMention = null;
    var grpSending = false;
    var grpSeq = 0;
    var grpMeId = '';
    var grpMentionOpen = false;
    // Which group the DOM currently shows, so an update can be applied in place.
    var grpShownId = '';
    // Set by actions that must redraw even though the composer has the cursor.
    var grpForceDraw = false;
    var grpMenuOpen = false;
    var grpNameDraft = '';
    var grpNameBusy = false;
    var grpMembersBusy = false;
    var grpAddOpen = false;
    var grpNewName = '';
    var grpNewSel = {};
    var grpNewBusy = false;

    function grpValid(id) { return /^[A-Za-z0-9_-]{1,40}$/.test(String(id || '')); }
    function grpSection(id) { return SMS_G_SECTION + '/g-' + id; }

    function loadGroupIndex() {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: SMS_G_SECTION, key: 'list' }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                var out = [];
                if (v && Array.isArray(v.groups)) {
                    for (var i = 0; i < v.groups.length; i++) {
                        var g = v.groups[i];
                        if (g && grpValid(g.id)) {
                            var ms = Array.isArray(g.members) ? g.members.map(String).filter(function (x) { return /^\d+$/.test(x); }) : [];
                            out.push({ id: String(g.id), name: String(g.name || 'Group').slice(0, 20), members: ms });
                        }
                    }
                }
                grpIndex = out;
                return out;
            }, function () { grpIndex = []; return []; });
    }

    // The company work groups (groups/company.cfg). The reply service makes and keeps them
    // (workgroup.js): they are shown with the phone's own groups but never written to its list.
    function loadCompanyIndex() {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: SMS_G_SECTION, key: 'company' }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                var out = [];
                (v && Array.isArray(v.groups) ? v.groups : []).forEach(function (g) {
                    if (!g || !grpValid(g.id)) return;
                    var ms = Array.isArray(g.members) ? g.members.map(String).filter(function (x) { return /^\d+$/.test(x); }) : [];
                    out.push({ id: String(g.id), name: String(g.name || '工作群').slice(0, 20), members: ms, company: true });
                });
                return out;
            }, function () { return []; });
    }

    // The class chats (groups/school.cfg), made and kept by the reply service (classgroup.js) for a
    // played middle- or high-schooler: shown like the company groups, locked the same way.
    function loadSchoolIndex() {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: SMS_G_SECTION, key: 'school' }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                var out = [];
                (v && Array.isArray(v.groups) ? v.groups : []).forEach(function (g) {
                    if (!g || !grpValid(g.id)) return;
                    var ms = Array.isArray(g.members) ? g.members.map(String).filter(function (x) { return /^d+$/.test(x); }) : [];
                    out.push({ id: String(g.id), name: String(g.name || '班级群').slice(0, 20), members: ms, company: true, school: true });
                });
                return out;
            }, function () { return []; });
    }

    // Group messages carry who said it and what they answered, which cleanList — written for
    // one-to-one threads — strips. Read the raw array and validate only the shape.
    function loadGroupBox(key, section) {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: section, key: key }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                if (!Array.isArray(v)) return [];
                var out = [];
                for (var i = 0; i < v.length; i++) {
                    var m = v[i];
                    if (!m || typeof m.text !== 'string' || typeof m.at !== 'number') continue;
                    out.push(m);
                }
                return out;
            }, function () { return []; });
    }

    function loadGroupMeta(id) {
        if (!grpValid(id)) return Promise.resolve(null);
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: grpSection(id), key: 'meta' }, 'value')
            .then(function (r) { return grpMetaFrom(id, parseJson(r.value)); }, function () { return null; });
    }

    // A group's meta.cfg as the phone uses it, or null when it is not a group to show.
    function grpMetaFrom(id, v) {
        if (!v || !Array.isArray(v.members)) return null;
        if (v.closed) return null;
        var list = [];
        var names = {};
        for (var i = 0; i < v.members.length; i++) {
            var m = v.members[i];
            var mid = m && typeof m === 'object' ? String(m.id) : String(m);
            if (!/^\d+$/.test(mid)) continue;
            // A name that is only the id was stored when the person could not be looked
            // up; leaving it out lets grpName find the real one.
            if (m && typeof m === 'object' && m.name && !/^\d+$/.test(String(m.name))) names[mid] = String(m.name);
            if (list.indexOf(mid) < 0 && list.length < SMS_G_MAX) list.push(mid);
        }
        if (!list.length) return null;
        return { id: String(id), name: String(v.name || 'Group').slice(0, 20), owner: String(v.owner || ''), members: list, memberNames: names, auto: v.auto !== false, createdAt: Number(v.createdAt) || 0, company: !!v.company || !!v.school, school: !!v.school };
    }

    // Both sides of the group in one list, oldest first. "mine" is the player's own typing.
    function loadGroupConversation(id, meId) {
        var me = String(meId || '');
        var section = grpSection(id);
        return Promise.all([loadGroupMeta(id), loadGroupBox('inbox', section), loadGroupBox('outbox', section), loadSeen(section), loadStatus(section)])
            .then(function (r) {
                var meta = r[0];
                if (!meta) return { meta: null, messages: [], seenAt: 0, status: null };
                // The outbox is shared by everyone who uses this phone, so a line written by
                // another character must not be drawn as the current player's own.
                var mine = [];
                var other = [];
                r[2].forEach(function (m) {
                    var from = String(m.from || '');
                    var row = {
                        id: String(m.id || ''), text: String(m.text || ''), at: Number(m.at) || 0,
                        game: smsGameClean(m.game), mentions: m.mentions || [], replyTo: m.replyTo || '',
                        from: from, name: from && meta && meta.memberNames ? (meta.memberNames[from] || '') : ''
                    };
                    // No author recorded (written before this existed): the current player's own.
                    if (!from || !me || from === me) { row.side = 'mine'; mine.push(row); }
                    else { row.side = 'theirs'; other.push(row); }
                });
                var theirs = r[1].map(function (m) {
                    return { id: String(m.id || ''), side: 'theirs', text: String(m.text || ''), at: Number(m.at) || 0, game: smsGameClean(m.game), from: String(m.from || ''), name: String(m.name || ''), to: m.to || [], replyTo: m.replyTo || '' };
                });
                var all = mine.concat(theirs).concat(other);
                all.sort(function (a, b) { return a.at - b.at || (a.side === b.side ? 0 : a.side === 'mine' ? -1 : 1); });
                return { meta: meta, messages: all, seenAt: r[3], status: r[4] };
            });
    }

    function grpKey(data) {
        if (!data || !data.messages) return '';
        var last = data.messages.length ? data.messages[data.messages.length - 1] : null;
        // The name and the size of the group are part of the picture too: without them a rename
        // leaves the page untouched until the next message arrives.
        // Who is playing is part of the picture: the group is one shared thread, so switching
        // character has to redraw which side every line sits on.
        return data.meta.id + '|' + String(data.meId || '') + '|' + data.meta.name + '|' + data.meta.members.length + '|' +
            data.messages.length + '|' + (last ? last.id : '') + '|' +
            (data.status && data.status.typing ? data.status.typing : '') + '|' +
            (grpReply ? 'reply:' + grpReply.id : '');
    }

    // What the list page shows for one group: who spoke last and how much is new.
    function loadGroupSummary(g) {
        var section = grpSection(g.id);
        return Promise.all([loadGroupMeta(g.id), loadGroupBox('inbox', section), loadGroupBox('outbox', section), loadSeen(section)]).then(function (r) {
            var meta = r[0];
            if (!meta) return null;
            var all = r[1].map(function (m) { return { side: 'theirs', at: Number(m.at) || 0, text: String(m.text || ''), name: grpSpeaker(meta, { name: m.name, from: String(m.from || '') }) }; })
                .concat(r[2].map(function (m) { return { side: 'mine', at: Number(m.at) || 0, text: String(m.text || ''), name: '' }; }));
            all.sort(function (a, b) { return a.at - b.at; });
            var unread = 0;
            for (var i = 0; i < r[1].length; i++) if (Number(r[1][i].at) > r[3]) unread += 1;
            return { meta: meta, last: all.length ? all[all.length - 1] : null, unread: unread, env: null };
        }, function () { return null; });
    }

    // Loaded with the Texts page: the groups this character is in, with the last line and the
    // unread count. A group belongs to whoever made it and to everyone in it — someone who was
    // not added must not find it on their phone.
    function loadGroupsForTexts(members, meId, idx) {
        var me = String(meId || '');
        grpKnown = grpPeople(members);
        if (idx) return Promise.resolve(groupsFromIndex(idx, me));
        return Promise.all([loadGroupIndex(), loadCompanyIndex(), loadSchoolIndex()]).then(function (r) {
            r[1] = r[2].concat(r[1]);
            var list = r[1].concat(r[0].filter(function (g) { return !r[1].some(function (c) { return c.id === g.id; }); }));
            return Promise.all(list.map(function (g) { return loadGroupSummary(g); })).then(function (rows) {
                return rows.filter(function (row) {
                    if (!row || !row.meta) return false;
                    if (!me) return false;
                    if (String(row.meta.owner) === me) return true;
                    return row.meta.members.indexOf(me) >= 0;
                });
            });
        }, function () { return []; });
    }

    // The groups of the Texts list from the index (lib/smsindex.js), as loadGroupSummary would give
    // them: the service already left out closed groups and those this character is not in.
    function groupsFromIndex(idx, me) {
        var rows = [];
        Object.keys(idx.groups).forEach(function (id) {
            if (!grpValid(id)) return;
            var g = idx.groups[id];
            var meta = grpMetaFrom(id, g && g.meta);
            if (!meta) return;
            if (String(meta.owner) !== me && meta.members.indexOf(me) < 0) return;
            var raw = g.last;
            var last = raw && typeof raw.at === 'number' ? {
                side: raw.side === 'mine' ? 'mine' : 'theirs', at: raw.at, text: String(raw.text || ''),
                name: raw.side === 'mine' ? '' : grpSpeaker(meta, { name: raw.name, from: String(raw.from || '') })
            } : null;
            var unread = typeof g.unread === 'number' ? g.unread : 0;
            var seen = smsSeenLocal[grpSection(id)];
            if (unread && seen && seen >= (Number(g.theirsAt) || 0)) unread = 0;
            rows.push({ meta: meta, last: last, unread: unread, env: null });
        });
        // Service-made groups first (class, then company), then the phone's own, newest line first within each.
        var rank = function (m) { return m.school ? 0 : m.company ? 1 : 2; };
        rows.sort(function (a, b) {
            return rank(a.meta) - rank(b.meta) || ((b.last && b.last.at) || 0) - ((a.last && a.last.at) || 0);
        });
        return rows;
    }

    function openGroup(id) {
        grpId = String(id);
        grpDraft = '';
        grpReply = null;
        grpMention = null;
        grpRenderedKey = '';
        grpShown = null;
        grpStick = true;
        grpScroll = 0;
        grpPinnedUntil = Date.now() + 2500;
        open('group');
    }

    function loadGroup() {
        var id = grpId;
        return Promise.all([getEnv(), getPossessedId(), getMembers(), loadPortraitIndex(), loadEmojiSet(), loadOutside()]).then(function (r) {
            grpKnown = grpPeople(r[2]);
            return loadGroupConversation(id, r[1]).then(function (conv) {
                if (!conv.meta) return { env: r[0], meId: String(r[1]), meta: null, messages: [] };
                conv.messages.forEach(function (m) { if (m.side === 'theirs') m.name = grpSpeaker(conv.meta, m); });
                grpHealNames(conv.meta);
                var latest = 0;
                for (var i = 0; i < conv.messages.length; i++) if (conv.messages[i].side === 'theirs' && conv.messages[i].at > latest) latest = conv.messages[i].at;
                if (latest) smsSeenLocal[grpSection(id)] = Math.max(smsSeenLocal[grpSection(id)] || 0, latest);
                var seenP = latest > conv.seenAt ? saveJson('seen', { at: latest }, grpSection(id)).then(function () { }, function () { }) : Promise.resolve();
                return seenP.then(function () {
                    return { env: r[0], meId: String(r[1]), members: grpKnown, meta: conv.meta, messages: conv.messages, status: conv.status };
                });
            });
        });
    }


    function grpSetPresence(data) {
        var pres = document.getElementById('sms-presence');
        if (!pres || !data.meta) return;
        var typing = data.status && data.status.typing ? grpName(data.meta, data.status.typing) : '';
        pres.textContent = typing ? typing + ' is typing…' : (data.meta.members.length + ' people');
        pres.className = 'sms-presence' + (typing ? '' : ' off');
    }

    // Applies a refresh to the page already on screen: new lines are appended, the header's
    // presence is updated, and everything else — the header, the composer, every bubble that was
    // already there — is left alone. Returns false when the page is not in a state that allows it,
    // and the caller falls back to drawing the whole page.
    function patchGroup(data) {
        var log = document.getElementById('sms-log');
        if (!log || !data.meta) return false;
        if (String(grpShownId) !== String(data.meta.id)) return false;
        var list = data.messages || [];
        if (!list.length) return false;
        var shown = grpShown || {};
        var first = 0;
        while (first < list.length && shown[list[first].id]) first += 1;
        if (first === 0) return false;                 // nothing on this page matches yet
        for (var j = first; j < list.length; j++) if (shown[list[j].id]) return false;
        var empty = log.getElementsByClassName('sms-empty');
        if (empty.length) log.removeChild(empty[0]);
        var added = grpFillLog(log, data, list, first);
        for (var k in added) if (added.hasOwnProperty(k)) shown[k] = true;
        grpShown = shown;
        grpSetPresence(data);
        grpRenderedKey = grpKey(data);
        if (grpStick) grpToBottom();
        return true;
    }

    // People the group pages last loaded (grpPeople), for names the group did not store.
    var grpKnown = [];

    function grpName(meta, id) {
        if (meta && meta.memberNames && meta.memberNames[id]) return meta.memberNames[id];
        var p = memberById(grpKnown, id);
        return p ? (p.first_name || fullName(p)) : 'Someone';
    }

    // A message's speaker as the page shows it: what the service stored, unless that is only an id.
    function grpSpeaker(meta, msg) {
        var n = String(msg.name || '');
        return n && !/^\d+$/.test(n) ? n : (msg.from ? grpName(meta, msg.from) : n);
    }

    // Writes back the real names of members stored by id only, so the service sees them too.
    function grpHealNames(meta) {
        var fix = false;
        meta.memberNames = meta.memberNames || {};
        meta.members.forEach(function (mid) {
            if (meta.memberNames[mid]) return;
            var p = memberById(grpKnown, mid);
            if (p) { meta.memberNames[mid] = p.first_name || fullName(p); fix = true; }
        });
        return fix ? soft(saveGroupMeta(meta)) : Promise.resolve();
    }

    // One face for the group. A stack of avatars inside another avatar needs nested percentage
    // heights and negative margins, and cohtml laid that out as one very tall empty row; the row
    // already says how many people are in it one line down.
    // A group picture the way WeChat draws one: a square of member faces, laid out with fixed
    // pixel offsets. No nested .ph-avatar and no percentage heights — cohtml collapsed that.
    function grpFaceCell(id, members) {
        var key = String(id);
        var cell = node('div', 'sms-gcell');
        var meta = portraitIndex[key];
        if (meta && typeof meta === 'object') {
            var img = node('img', 'sms-gcell-img');
            img.setAttribute('alt', '');
            img.src = 'portraits/' + key + '.png?v=' + (meta.mtime || portraitRev || 1);
            cell.appendChild(img);
        } else {
            var m = memberById(members || [], id);
            var letter = m ? String(m.first_name || fullName(m) || '?').slice(0, 1) : '?';
            var ph = node('div', 'sms-gcell-letter', letter);
            cell.style.background = smsMemberColor(key);
            cell.appendChild(ph);
        }
        return cell;
    }

    function grpFaces(meta, members) {
        var pic = node('div', 'sms-pic');
        var box = node('div', 'sms-gavatar');
        var ids = meta.members.slice(0, 4);
        // [left, top, width, height] inside a 44px square
        var cells = ids.length >= 4 ? [[0, 0, 21, 21], [23, 0, 21, 21], [0, 23, 21, 21], [23, 23, 21, 21]]
            : ids.length === 3 ? [[0, 0, 21, 21], [23, 0, 21, 21], [0, 23, 21, 21]]
            : [[0, 0, 21, 44], [23, 0, 21, 44]];
        for (var i = 0; i < ids.length && i < cells.length; i++) {
            var c = cells[i];
            var cell = grpFaceCell(ids[i], members);
            cell.style.left = c[0] + 'px';
            cell.style.top = c[1] + 'px';
            cell.style.width = c[2] + 'px';
            cell.style.height = c[3] + 'px';
            box.appendChild(cell);
        }
        pic.appendChild(box);
        return pic;
    }

    // The rows on the Texts page: one New Group entry, then every group.
    function groupListRows(wrap, groups, members, env) {
        groups.forEach(function (row) {
            var meta = row.meta;
            var card = node('div', 'ph-card sms-contact sms-group');
            var row2 = node('div', 'ph-row');
            var pic2 = grpFaces(meta, members);
            if (row.unread > 0) pic2.appendChild(node('div', 'sms-unread', row.unread > 9 ? '9+' : String(row.unread)));
            row2.appendChild(pic2);
            var who2 = node('div', 'ph-who');
            var top = node('div', 'sms-contact-top');
            top.appendChild(node('div', 'ph-name', meta.name));
            if (row.last) {
                var lg = row.last.game;
                if (lg && env) top.appendChild(node('div', 'sms-contact-time', env.day === lg.day ? smsGameClock(lg) : smsStamp(lg, env)));
            }
            who2.appendChild(top);
            who2.appendChild(node('div', 'ph-sub', meta.members.length + ' people'));
            var previewEl = node('div', 'sms-preview' + (row.unread > 0 ? ' new' : ''));
            var line = '';
            if (row.last) line = (row.last.side === 'mine' ? 'You: ' : (row.last.name ? row.last.name + ': ' : '')) + String(row.last.text || '');
            emojiFill(previewEl, smsClip(line || 'No messages yet', 40));
            who2.appendChild(previewEl);
            row2.appendChild(who2);
            card.appendChild(row2);
            onTap(card, function (e) { e.stopPropagation(); openGroup(meta.id); });
            wrap.appendChild(card);
        });
    }

    function loadGroupNew() {
        return Promise.all([getEnv(), getPossessedId(), getMembers(), loadPortraitIndex(), loadOutside()]).then(function (r) {
            var meId = String(r[1]);
            grpKnown = grpPeople(r[2]);
            return { env: r[0], meId: meId, members: r[2], contacts: textContacts(meId, r[2]) };
        });
    }

    function renderGroupNew(data) {
        var wrap = node('div', 'ph-page');
        wrap.appendChild(subHeader('groupNew', 'New Group'));
        var nameCard = card();
        var field = node('textarea', 'sms-gname');
        field.setAttribute('placeholder', 'Group name (optional)');
        field.setAttribute('maxlength', '20');
        field.setAttribute('rows', '1');
        field.value = grpNewName;
        applyUiFont(field);
        field.addEventListener('input', function () { grpNewName = field.value; });
        nameCard.appendChild(field);
        wrap.appendChild(nameCard);

        var chosen = 0;
        Object.keys(grpNewSel).forEach(function (k) { if (grpNewSel[k]) chosen += 1; });
        var hint = card();
        hint.appendChild(node('div', 'ph-sub', chosen ? chosen + ' chosen' : 'Choose two or more people'));
        wrap.appendChild(hint);

        var listCard = card();
        data.contacts.forEach(function (m) {
            var id = String(m.entity_id);
            var row = node('div', 'sms-pick');
            row.appendChild(faceAvatar(m));
            row.appendChild(node('div', 'sms-pick-name', fullName(m)));
            var tick = node('div', 'sms-pick-tick' + (grpNewSel[id] ? ' on' : ''), grpNewSel[id] ? '\u2713' : '');
            row.appendChild(tick);
            onTap(row, function (e) {
                e.stopPropagation();
                if (grpNewSel[id]) { delete grpNewSel[id]; tick.className = 'sms-pick-tick'; tick.textContent = ''; }
                else {
                    var n = 0;
                    Object.keys(grpNewSel).forEach(function (k) { if (grpNewSel[k]) n += 1; });
                    if (n >= SMS_G_MAX) { setNote('Up to ' + SMS_G_MAX + ' people in one group.', true); return; }
                    grpNewSel[id] = true;
                    tick.className = 'sms-pick-tick on';
                    tick.textContent = '\u2713';
                }
                setNote('', false);
                refresh();
            });
            listCard.appendChild(row);
        });
        wrap.appendChild(listCard);

        var go = node('button', 'ph-btn sms-gcreate' + (chosen >= 2 ? '' : ' off'), 'Create');
        go.type = 'button';
        onTap(go, function (e) { e.stopPropagation(); createGroup(data); }, { silent: true });
        wrap.appendChild(go);
        return wrap;
    }

    function createGroup(data) {
        if (grpNewBusy) return;
        var ids = Object.keys(grpNewSel).filter(function (k) { return grpNewSel[k]; });
        if (ids.length < 2) { setNote('Choose two or more people.', true); return; }
        var name = String(grpNewName || '').replace(/^\s+|\s+$/g, '').slice(0, 20);
        // The picker lists people outside the household too (data.contacts), so names come from there.
        var person = function (mid) { return memberById(data.contacts, mid) || memberById(grpPeople(data.members), mid); };
        if (!name) {
            var names = ids.map(function (id) {
                var m = person(id);
                return m ? (m.first_name || fullName(m)) : '';
            }).filter(Boolean);
            name = names.slice(0, 3).join(', ') || 'Group';
        }
        var id = 'g' + Date.now().toString(36);
        var members = ids.map(function (mid) {
            var m = person(mid);
            return { id: String(mid), name: m ? (m.first_name || fullName(m)) : String(mid) };
        });
        var meta = { v: 1, id: id, name: name, owner: String(data.meId), members: members, auto: true, createdAt: Date.now() };
        grpNewBusy = true;
        saveJson('meta', meta, grpSection(id)).then(function () {
            return loadGroupIndex();
        }).then(function (list) {
            var groups = (list || []).slice();
            groups.push({ id: id, name: name, members: ids });
            return saveJson('list', { v: 1, groups: groups.map(function (g) { return { id: g.id, name: g.name, members: Array.isArray(g.members) && g.members.length ? g.members : [] }; }) }, SMS_G_SECTION);
        }).then(function () {
            grpNewBusy = false;
            setNote('', false);
            openGroup(id);
        }, function (err) {
            grpNewBusy = false;
            setNote(errText(err), true);
        });
    }

    function grpStamped(prev, m) { return !prev || m.at - prev.at > SMS_RUN_GAP_MS; }

    function smsMemberColor(id) {
        // A fixed palette rather than hsl(): cohtml's colour parser is partial, and six colours
        // are enough to tell a handful of people apart.
        var palette = ['#0A84FF', '#FF9F0A', '#30D158', '#BF5AF2', '#FF375F', '#64D2FF'];
        var n = 0;
        var s = String(id);
        for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % palette.length;
        return palette[n];
    }

    function findGroupMessage(list, id) {
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    }

    // Draws the lines of a group thread into the log, from index `from` on. Used for the first
    // paint and for appending later lines in place, so an incoming message does not force the
    // whole conversation to be rebuilt (which reads as a flicker).
    function grpFillLog(log, data, list, from) {
        var known = grpShown;
        var nextSeen = {};
        var prev = from > 0 ? list[from - 1] : null;
        var freshN = 0;
        for (var i = from; i < list.length; i++) {
            var m = list[i];
            nextSeen[m.id] = true;
            // A line that was not on screen last time is new: it grows out of its corner, and a
            // burst of them comes in one after another, the way a one-to-one thread does.
            var arriving = !!(known && !known[m.id]);
            var delay = Math.min(freshN * SMS_IN_STAGGER_MS, SMS_IN_STAGGER_MAX);
            if (arriving) freshN += 1;
            if (grpStamped(prev, m)) {
                var stampText = smsStamp(m.game, data.env);
                if (stampText) {
                    var stamp = node('div', 'sms-stamp' + (prev ? '' : ' first') + (arriving ? ' sms-in' : ''), stampText);
                    if (arriving) setSmsDelay(stamp, delay);
                    log.appendChild(stamp);
                }
            }
            // Its own row class: the 1:1 rows carry wrap and radius rules that a group row
            // (name above, quote above) does not want.
            var row = node('div', 'sms-grow ' + (m.side === 'mine' ? 'mine' : 'theirs') + (arriving ? ' sms-in' : ''));
            var stack = node('div', 'sms-gstack');
            if (arriving) setSmsDelay(stack, delay);
            if (m.side === 'theirs' && (!prev || prev.side !== 'theirs' || prev.from !== m.from)) {
                var tag = node('div', 'sms-sender', m.name || grpName(data.meta, m.from));
                tag.style.color = smsMemberColor(m.from);
                stack.appendChild(tag);
            }
            var quoted = m.replyTo ? findGroupMessage(list, m.replyTo) : null;
            if (quoted) {
                var q = node('div', 'sms-quote');
                q.appendChild(node('div', 'sms-quote-who', quoted.side === 'mine' ? 'You' : (quoted.name || grpName(data.meta, quoted.from))));
                q.appendChild(node('div', 'sms-quote-text', String(quoted.text || '').slice(0, 60)));
                stack.appendChild(q);
            }
            var bubble = smsBubble(String(m.text || ''));
            // Every line can be the one being answered — your own too, so the others know which
            // of your messages is under discussion. Tapping the row toggles it.
            row.setAttribute('data-id', m.id);
            (function (mm) {
                onTap(row, function (e) {
                    e.stopPropagation();
                    if (grpReply && grpReply.id === mm.id) grpReply = null;
                    else grpReply = { id: mm.id, name: mm.side === 'mine' ? 'You' : (mm.name || grpName(data.meta, mm.from)), text: mm.text };
                    grpSyncReplyBar();
                });
            })(m);
            if (grpReply && grpReply.id === m.id) row.className += ' picked';
            stack.appendChild(bubble);
            var time = m.game ? node('div', 'sms-time', smsGameClock(m.game)) : null;
            if (time && m.side === 'mine') row.appendChild(time);
            row.appendChild(stack);
            if (time && m.side !== 'mine') row.appendChild(time);
            log.appendChild(row);
            prev = m;
        }
        return nextSeen;
    }

    function grpReplyBar() {
        var bar = node('div', 'sms-replybar');
        bar.appendChild(node('div', 'sms-replybar-who', 'Replying to ' + grpReply.name));
        bar.appendChild(node('div', 'sms-replybar-text', String(grpReply.text || '').slice(0, 60)));
        var x = node('button', 'sms-replybar-x', '\u00D7');
        x.type = 'button';
        onTap(x, function (e) { e.stopPropagation(); grpReply = null; grpSyncReplyBar(); }, { silent: true });
        bar.appendChild(x);
        return bar;
    }

    // The quote bar, the box's placeholder and the picked line follow grpReply in place. A refresh
    // does not do it: patchGroup only appends new lines and leaves the composer as it is, so the
    // bar stayed up after closing it and after sending.
    function grpSyncReplyBar() {
        var box = document.getElementById('sms-box');
        var compose = box && box.parentNode ? box.parentNode.parentNode : null;
        if (compose) {
            var old = compose.getElementsByClassName('sms-replybar');
            while (old.length) old[0].parentNode.removeChild(old[0]);
            var field = box.parentNode;
            if (grpReply) compose.insertBefore(grpReplyBar(), field);
        }
        if (box) box.setAttribute('placeholder', grpReply ? 'Reply' : 'Message');
        var rows = document.getElementsByClassName('sms-grow');
        for (var i = 0; i < rows.length; i++) {
            if (grpReply && rows[i].getAttribute('data-id') === grpReply.id) rows[i].classList.add('picked');
            else rows[i].classList.remove('picked');
        }
        grpRenderedKey = '';
    }

    function renderGroup(data) {
        grpMeId = String(data.meId || '');
        // The layout that pins the composer to the bottom hangs off #content.sms-open. A refresh
        // that short-circuits on an unchanged thread never reaches the code that adds it, so the
        // page sets it itself.
        try {
            var shell = document.getElementById('content');
            if (shell) shell.classList.add('sms-open');
        } catch (e) {}
        var wrap = node('div', 'sms');
        if (!data.meta) {
            wrap.appendChild(subHeader('group', 'Group'));
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'This group is gone.'));
            wrap.appendChild(none);
            return wrap;
        }
        var nav = node('div', 'sms-nav');
        var back = node('div', 'ph-back', '< Back');
        onTap(back, function (e) { e.stopPropagation(); open('texts'); });
        nav.appendChild(back);
        // The avatar stack fights .sms-nav's centred peer block; the header carries the name
        // and the member line only, the way Messages shows a compact group header.
        var peer = node('div', 'sms-peer sms-peer-group');
        peer.appendChild(node('div', 'sms-peer-name', data.meta.name));
        var typing = data.status && data.status.typing ? grpName(data.meta, data.status.typing) : '';
        var pres = node('div', 'sms-presence' + (typing ? '' : ' off'), typing ? typing + ' is typing\u2026' : (data.meta.members.length + ' people'));
        pres.id = 'sms-presence';
        peer.appendChild(pres);
        nav.appendChild(peer);
        var more = node('button', 'sms-more');
        more.type = 'button';
        more.setAttribute('title', 'Group settings');
        // Plain text: the positioned divs measured correctly and still painted as one point, and
        // the svg never made it into the tree on this engine. Text is what everything else here is.
        more.appendChild(node('div', 'sms-more-glyph', '...'));
        onTap(more, function (e) { e.stopPropagation(); grpOpenMenu(data); }, { silent: true });
        wrap.appendChild(nav);
        // Appended to the page, not the nav: the nav is pulled 16px past the content edge on both
        // sides, so a right:0 child sat half outside the screen.
        wrap.appendChild(more);

        grpShownId = String(data.meta.id);
        var log = node('div', 'sms-log');
        log.id = 'sms-log';
        // Hidden for a beat while it is placed at the newest line: on a slow layout the first
        // paint would show the top of the thread. The timers live here, not in restoreGroup,
        // because that path is not always taken on a second visit — and a log left hidden is
        // worse than a short flash.
        if (grpPinnedUntil > Date.now()) {
            log.style.opacity = '0';
            setTimeout(function () {
                var l = document.getElementById('sms-log');
                if (!l) return;
                l.scrollTop = l.scrollHeight;
                l.style.opacity = '1';
            }, 400);
            setTimeout(function () {
                var l = document.getElementById('sms-log');
                if (l && l.style.opacity === '0') { l.scrollTop = l.scrollHeight; l.style.opacity = '1'; }
            }, 1200);
        }
        log.addEventListener('scroll', function () { grpJumpSync(log); });
        var list = data.messages || [];
        if (!list.length) log.appendChild(node('div', 'sms-empty', 'No messages yet. Say something.'));
        grpShown = grpFillLog(log, data, list, 0);
        wrap.appendChild(log);

        var compose = node('div', 'sms-compose');
        compose.appendChild(grpJumpButton());
        if (grpReply) compose.appendChild(grpReplyBar());
        var field = node('div', 'sms-field');
        var at = node('button', 'sms-at-btn', '@');
        at.type = 'button';
        at.setAttribute('title', 'Mention someone');
        onTap(at, function (e) { e.stopPropagation(); grpPickMention(data); }, { silent: true });
        var input = node('textarea', 'sms-input sms-ginput');
        input.id = 'sms-box';
        applyUiFont(input);
        input.setAttribute('maxlength', String(SMS_G_TEXT_MAX));
        input.setAttribute('placeholder', grpReply ? 'Reply' : 'Message');
        input.setAttribute('rows', '1');
        input.value = grpDraft;
        input.addEventListener('input', function () {
            grpDraft = input.value;
            fitSmsBox(input);
            syncSendButton();
            // Typing "@" brings the list up by itself, the way a chat app does; a space after it
            // means the name is done being asked for.
            var caret = input.selectionEnd === undefined || input.selectionEnd === null ? grpDraft.length : input.selectionEnd;
            var before = grpDraft.slice(0, caret);
            var at = before.lastIndexOf('@');
            var asking = at >= 0 && before.slice(at + 1).indexOf(' ') < 0;
            if (asking && !grpMentionOpen) grpPickMention(data);
            else if (!asking && grpMentionOpen) grpHideMention();
        });
        input.addEventListener('compositionstart', function () { grpComposing = true; grpComposingAt = Date.now(); });
        input.addEventListener('compositionend', function () { grpComposing = false; grpDraft = input.value; });
        input.addEventListener('keydown', function (e) {
            if (e.keyCode === 13 && !e.shiftKey && !e.isComposing && !grpComposing) {
                if (e.preventDefault) e.preventDefault();
                sendGroup();
            }
        });
        var send = node('button', 'sms-send' + (String(grpDraft || '').replace(/\s/g, '') ? '' : ' off'));
        send.id = 'sms-send';
        send.type = 'button';
        send.setAttribute('title', 'Send');
        send.appendChild(sendGlyph());
        onTap(send, function (e) { e.stopPropagation(); sendGroup(); }, { silent: true });
        field.appendChild(at);
        field.appendChild(input);
        field.appendChild(send);
        compose.appendChild(field);
        wrap.appendChild(compose);
        grpRenderedKey = grpKey(data);
        // If the flex chain from #ph-screen down is not honoured, the page keeps its content
        // height and the composer floats up under the last message. Measuring the real screen
        // box and pinning the page to it works whatever the engine does with flex.
        setTimeout(function () {
            try {
                var host = document.getElementById('ph-screen') || document.getElementById('content');
                var h = host ? host.clientHeight : 0;
                if (h > 200) wrap.style.height = h + 'px';
                grpToBottom();
            } catch (e) {}
        }, 0);
        return wrap;
    }


    // ------------------------------------------------------------------
    // Group settings: rename, members, leaving. Reached from the "..." in the group header.
    // Only the creator manages the member list; anyone in a group can read it and leave.
    // ------------------------------------------------------------------
    function grpIsOwner(meta, meId) {
        return !!meta && !meta.company && !!meId && String(meta.owner) === String(meId);
    }

    function grpMetaOut(meta, patch) {
        var names = meta.memberNames || {};
        var out = {
            v: 1,
            id: meta.id,
            name: meta.name,
            owner: meta.owner,
            members: (meta.members || []).map(function (mid) { return { id: mid, name: names[mid] || mid }; }),
            auto: meta.auto !== false,
            createdAt: meta.createdAt || 0
        };
        if (patch) for (var k in patch) if (patch.hasOwnProperty(k)) out[k] = patch[k];
        return out;
    }

    // The summary the list page reads is a copy of meta: keep the two together.
    function syncGroupList(id, name, members, closed) {
        return loadGroupIndex().then(function (list) {
            var groups = (list || []).filter(function (g) { return g.id !== id; });
            if (!closed) groups.push({ id: id, name: name, members: members || [] });
            return saveJson('list', { v: 1, groups: groups }, SMS_G_SECTION);
        });
    }

    function saveGroupMeta(meta, patch) {
        var out = grpMetaOut(meta, patch);
        return saveJson('meta', out, grpSection(meta.id)).then(function () {
            return syncGroupList(meta.id,
                out.name,
                out.members.map(function (m) { return m.id; }),
                out.closed);
        });
    }

    function renameGroup(id, name) {
        if (grpNameBusy) return;
        var clean = String(name || '').replace(/^\s+|\s+$/g, '').slice(0, 20);
        if (!clean) { setNote('The name cannot be empty.', true); return; }
        grpNameBusy = true;
        loadGroupMeta(id).then(function (meta) {
            if (!meta) throw new Error('This group is gone.');
            return saveGroupMeta(meta, { name: clean });
        }).then(function () {
            grpNameBusy = false;
            grpNameDraft = '';
            grpMenuOpen = false;
            grpRenderedKey = '';
            grpShown = null;
            setNote('', false);
            // Straight back to the conversation, redrawn even though no message changed.
            if (current === 'group') refresh();
            else open('group');
        }, function (err) {
            grpNameBusy = false;
            setNote(errText(err), true);
        });
    }

    // The creator leaving ends the group for everyone; a member leaving only removes themselves.
    function leaveGroup(id, meId) {
        loadGroupMeta(id).then(function (meta) {
            if (!meta) { open('texts'); return; }
            if (grpIsOwner(meta, meId)) return saveGroupMeta(meta, { closed: true });
            var rest = meta.members.filter(function (mid) { return String(mid) !== String(meId); });
            if (!rest.length) return saveGroupMeta(meta, { closed: true });
            meta.memberNames = meta.memberNames || {};
            return saveGroupMeta(meta, { members: rest.map(function (mid) { return { id: mid, name: meta.memberNames[mid] || mid }; }) });
        }).then(function () {
            grpMenuOpen = false;
            setNote('', false);
            open('texts');
        }, function (err) { setNote(errText(err), true); });
    }

    function removeMember(id, memberId) {
        if (grpMembersBusy) return;
        grpMembersBusy = true;
        loadGroupMeta(id).then(function (meta) {
            if (!meta) throw new Error('This group is gone.');
            var rest = meta.members.filter(function (mid) { return String(mid) !== String(memberId); });
            var names = meta.memberNames || {};
            return saveGroupMeta(meta, { members: rest.map(function (mid) { return { id: mid, name: names[mid] || mid }; }) });
        }).then(function () {
            grpMembersBusy = false;
            refresh();
        }, function (err) { grpMembersBusy = false; setNote(errText(err), true); });
    }

    function addMember(id, memberId, members) {
        if (grpMembersBusy) return;
        grpMembersBusy = true;
        loadGroupMeta(id).then(function (meta) {
            if (!meta) throw new Error('This group is gone.');
            if (meta.members.indexOf(String(memberId)) >= 0) return null;
            if (meta.members.length >= SMS_G_MAX) throw new Error('Up to ' + SMS_G_MAX + ' people.');
            var m = memberById(members || [], memberId);
            var name = m ? (m.first_name || fullName(m)) : String(memberId);
            var list = meta.members.concat([String(memberId)]);
            var out = list.map(function (mid) { return { id: mid, name: mid === String(memberId) ? name : (meta.memberNames[mid] || mid) }; });
            return saveGroupMeta(meta, { members: out });
        }).then(function () {
            grpMembersBusy = false;
            grpAddOpen = false;
            refresh();
        }, function (err) { grpMembersBusy = false; setNote(errText(err), true); });
    }

    function loadGroupMembers() {
        return Promise.all([getEnv(), getPossessedId(), getMembers(), loadPortraitIndex(), loadGroupMeta(grpId), loadOutside()]).then(function (r) {
            grpKnown = grpPeople(r[2]);
            if (r[4]) grpHealNames(r[4]);
            return { env: r[0], meId: String(r[1]), members: grpKnown, household: r[2], meta: r[4] };
        });
    }

    function renderGroupMembers(data) {
        var wrap = node('div', 'ph-page');
        wrap.appendChild(subHeader('groupMembers', 'Members'));
        if (!data.meta) {
            var gone = card();
            gone.appendChild(node('div', 'ph-empty', 'This group is gone.'));
            wrap.appendChild(gone);
            return wrap;
        }
        var owner = grpIsOwner(data.meta, data.meId);
        var listCard = card();
        data.meta.members.forEach(function (mid) {
            var m = memberById(data.members || [], mid);
            var row = node('div', 'sms-pick');
            if (m) row.appendChild(faceAvatar(m));
            else row.appendChild(node('div', 'ph-avatar sms-gface-blank'));
            var who = node('div', 'sms-pick-name', data.meta.memberNames[mid] || (m ? fullName(m) : String(mid)));
            row.appendChild(who);
            if (String(mid) === String(data.meta.owner)) row.appendChild(node('div', 'sms-tag', data.meta.school ? '班长' : data.meta.company ? '群主' : 'Creator'));
            if (owner) {
                var x = node('button', 'sms-pick-x', '\u00D7');
                x.type = 'button';
                x.setAttribute('title', 'Remove from group');
                onTap(x, function (e) { e.stopPropagation(); removeMember(data.meta.id, mid); }, { silent: true });
                row.appendChild(x);
            }
            listCard.appendChild(row);
        });
        wrap.appendChild(listCard);

        if (owner) {
            var add = node('button', 'ph-btn sms-gcreate', grpAddOpen ? 'Done' : 'Add people');
            add.type = 'button';
            onTap(add, function (e) { e.stopPropagation(); grpAddOpen = !grpAddOpen; refresh(); }, { silent: true });
            wrap.appendChild(add);
            if (grpAddOpen) {
                var poolCard = card();
                var any = 0;
                (data.household || data.members || []).forEach(function (m) {
                    var id = String(m.entity_id);
                    if (id === String(data.meId)) return;
                    if (data.meta.members.indexOf(id) >= 0) return;
                    if (NO_PHONE_STEPS[m.age_group]) return;
                    any += 1;
                    var row = node('div', 'sms-pick');
                    row.appendChild(faceAvatar(m));
                    row.appendChild(node('div', 'sms-pick-name', fullName(m)));
                    row.appendChild(node('div', 'sms-pick-plus', '+'));
                    onTap(row, function (e) { e.stopPropagation(); addMember(data.meta.id, id, data.members); });
                    poolCard.appendChild(row);
                });
                if (!any) poolCard.appendChild(node('div', 'ph-empty', 'Everyone in the house is already in.'));
                wrap.appendChild(poolCard);
            }
        }
        if (data.meta.school) {
            wrap.appendChild(node('div', 'ph-caption sms-company-note', '班级群：同班同学自动加入，群主是班长；在读期间不能退群，毕业后群会解散。'));
            return wrap;
        }
        if (data.meta.company) {
            wrap.appendChild(node('div', 'ph-caption sms-company-note', '公司工作群：入职自动加入，群主是公司职位最高的人；在职期间不能退群，离职后自动退出。'));
            return wrap;
        }
        var leave = node('button', 'ph-btn sms-gleave', owner ? 'Disband group' : 'Leave group');
        leave.type = 'button';
        onTap(leave, function (e) { e.stopPropagation(); leaveGroup(data.meta.id, data.meId); }, { silent: true });
        wrap.appendChild(leave);
        return wrap;
    }

    function loadGroupName() {
        return Promise.all([getEnv(), loadGroupMeta(grpId)]).then(function (r) {
            return { env: r[0], meta: r[1] };
        });
    }

    function renderGroupName(data) {
        var wrap = node('div', 'ph-page');
        wrap.appendChild(subHeader('groupName', 'Group Name'));
        if (!data.meta) {
            var gone = card();
            gone.appendChild(node('div', 'ph-empty', 'This group is gone.'));
            wrap.appendChild(gone);
            return wrap;
        }
        var c = card();
        // A textarea, not an input: the chat box is a textarea and it is the one field in this
        // phone that reliably takes Latin letters and digits. An <input> here only ever got
        // text through the input method.
        var field = node('textarea', 'sms-gname');
        field.setAttribute('placeholder', 'Group name');
        field.setAttribute('maxlength', '20');
        field.setAttribute('rows', '1');
        field.value = grpNameDraft || data.meta.name;
        applyUiFont(field);
        field.addEventListener('input', function () { grpNameDraft = field.value; });
        c.appendChild(field);
        wrap.appendChild(c);
        var save = node('button', 'ph-btn sms-gcreate', 'Save');
        save.type = 'button';
        onTap(save, function (e) {
            e.stopPropagation();
            var box = document.querySelector('.sms-gname');
            renameGroup(data.meta.id, box ? box.value : grpNameDraft);
        }, { silent: true });
        wrap.appendChild(save);
        return wrap;
    }

    // The "..." sheet over an open group.
    // Removes the open sheet. Nothing is reloaded: the sheet is only a layer over the page.
    function grpHideMenuSheet() {
        var veil = document.getElementById('sms-sheet-wrap');
        if (veil && veil.parentNode) veil.parentNode.removeChild(veil);
    }

    // Puts the sheet on the page that is already there. Opening the menu used to go through a
    // full reload of the thread, which took seconds and left the poll frozen while it was open.
    function grpOpenMenu(data) {
        if (document.getElementById('sms-sheet-wrap')) return;
        var wrap = document.querySelector('.sms');
        if (!wrap || !data || !data.meta) return;
        var veil = grpMenuSheet(data);
        veil.id = 'sms-sheet-wrap';
        wrap.appendChild(veil);
    }

    function grpMenuSheet(data) {
        var veil = node('div', 'sms-sheet-veil');
        onTap(veil, function (e) { e.stopPropagation(); grpHideMenuSheet(); });
        var sheet = node('div', 'sms-sheet');
        sheet.id = 'sms-sheet';
        var owner = grpIsOwner(data.meta, data.meId);
        function item(label, danger, action) {
            var row = node('div', 'sms-sheet-item' + (danger ? ' danger' : ''), label);
            onTap(row, function (e) {
                e.stopPropagation();
                grpHideMenuSheet();
                action();
            });
            sheet.appendChild(row);
        }
        if (owner) item('Group Name', false, function () { grpNameDraft = data.meta.name; open('groupName'); });
        item('Members', false, function () { grpAddOpen = false; open('groupMembers'); });
        if (owner) item('Manage Members', false, function () { grpAddOpen = true; open('groupMembers'); });
        if (!data.meta.company) item(owner ? 'Disband Group' : 'Leave Group', true, function () { leaveGroup(data.meta.id, data.meId); });
        var cancel = node('div', 'sms-sheet-cancel', 'Cancel');
        onTap(cancel, function (e) { e.stopPropagation(); grpHideMenuSheet(); });
        sheet.appendChild(cancel);
        // In the corner, small: which build the phone is actually running.
        sheet.appendChild(node('div', 'sms-sheet-build', 'Build ' + SMS_BUILD));
        veil.appendChild(sheet);
        return veil;
    }

    function grpHideMention() {
        var panel = document.getElementById('sms-mention-panel');
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
        grpMentionOpen = false;
    }

    function grpPickMention(data) {
        if (grpMentionOpen) { grpHideMention(); return; }
        grpMentionOpen = true;
        var old = document.getElementById('sms-mention-panel');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var box = node('div', 'sms-mention-panel');
        box.id = 'sms-mention-panel';
        data.meta.members.forEach(function (id) {
            var m = memberById(data.members || [], id);
            var row = node('div', 'sms-mention-row');
            if (m) row.appendChild(faceAvatar(m));
            row.appendChild(node('div', 'sms-pick-name', grpName(data.meta, id)));
            onTap(row, function (e) {
                e.stopPropagation();
                var field = document.getElementById('sms-box');
                // Replace the half-typed "@..." the list was opened for, instead of adding a
                // second @ in front of it. The fragment can be just "@" or "@永".
                var val = String(field ? field.value : grpDraft || '');
                var caret = field && field.selectionEnd !== undefined && field.selectionEnd !== null ? field.selectionEnd : val.length;
                var head = val.slice(0, caret);
                var at = head.lastIndexOf('@');
                var before = at >= 0 ? val.slice(0, at) : val;
                var after = at >= 0 ? val.slice(caret) : '';
                var next = (before + '@' + grpName(data.meta, id) + ' ' + after).slice(0, SMS_G_TEXT_MAX);
                grpMention = { id: id, name: grpName(data.meta, id) };
                grpDraft = next;
                // Written straight into the box: a refresh() here would run rememberGroup() first,
                // which copies the old box text back over the mention.
                if (field) {
                    field.value = next;
                    try { fitSmsBox(field); } catch (err) {}
                }
                if (box.parentNode) box.parentNode.removeChild(box);
                grpMentionOpen = false;
                syncSendButton();
            });
            box.appendChild(row);
        });
        var compose = document.querySelector('.sms-compose');
        if (compose) compose.appendChild(box);
    }

    // The same chevron as a one-to-one thread, but it pins grpStick: the one-to-one button
    // sets smsStick, which this page never reads.
    function grpJumpButton() {
        var b = node('button', 'sms-jump' + (grpStick ? '' : ' show'));
        b.id = 'sms-jump';
        b.type = 'button';
        b.setAttribute('title', 'Latest');
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'sms-jump-glyph');
        glyphPath(svg, 'M5.3 8.6a1.1 1.1 0 0 1 1.6 0L12 13.7l5.1-5.1a1.1 1.1 0 1 1 1.6 1.6l-5.9 5.9a1.1 1.1 0 0 1-1.6 0L5.3 10.2a1.1 1.1 0 0 1 0-1.6z', '#ffffff');
        b.appendChild(svg);
        onTap(b, function (e) {
            e.stopPropagation();
            var log = document.getElementById('sms-log');
            if (!log) return;
            grpStick = true;
            b.className = 'sms-jump';
            rideSmsLog(log, Math.max(0, log.scrollHeight - log.clientHeight - log.scrollTop));
            setTimeout(grpToBottom, 400);
        });
        return b;
    }

    // Shows the chevron once the reader is a screen above the newest line.
    function grpJumpSync(log) {
        var b = document.getElementById('sms-jump');
        if (!b || !log) return;
        if (smsScrollRide && !smsScrollRide.dead) return;
        var up = log.scrollHeight - log.scrollTop - log.clientHeight > SMS_JUMP_PX;
        var want = up ? 'sms-jump show' : 'sms-jump';
        if (b.className !== want) b.className = want;
    }

    function rememberGroup() {
        var box = document.getElementById('sms-box');
        var log = document.getElementById('sms-log');
        if (box) { grpDraft = box.value; grpFocused = false; }
        if (log) {
            if (Date.now() >= grpPinnedUntil) {
                grpStick = (log.scrollHeight - log.scrollTop - log.clientHeight) < 48;
                grpScroll = log.scrollTop;
            }
        }
    }

    // The page has just been rebuilt: at this moment the log has no height yet, so a single
    // scrollTop = scrollHeight lands on 0 — the top. The one-to-one chat jumps again over the
    // next few frames for exactly this reason, and so does this.
    // Delays after which the log is pushed to the newest line. The engine lays out asynchronously:
    // one attempt on the same tick lands while the log still has no height.
    var GRP_SCROLL_TRIES = [0, 60, 160, 320, 600, 1000, 1600];

    function grpToBottom() {
        var log = document.getElementById('sms-log');
        if (!log) return;
        if (current !== 'group') return;
        if (!grpStick && Date.now() >= grpPinnedUntil) { log.style.opacity = '1'; return; }
        var max = log.scrollHeight - log.clientHeight;
        // Nothing has been laid out yet: leave it hidden and let the next attempt try again.
        if (max < 2) return;
        if (max - log.scrollTop < 2) { log.style.opacity = '1'; return; }
        log.scrollTop = log.scrollHeight;
        log.style.opacity = '1';
    }


    function restoreGroup() {
        var box = document.getElementById('sms-box');
        var log = document.getElementById('sms-log');
        if (box && box.value !== grpDraft) box.value = grpDraft;
        if (box) {
            try { fitSmsBox(box); } catch (e) {}
            syncSendButton();
            if (document.activeElement === box) { try { box.blur(); } catch (e) {} }
        }
        if (!log) return;
        if (grpStick) {
            log.scrollTop = log.scrollHeight;
            for (var i = 0; i < GRP_SCROLL_TRIES.length; i++) setTimeout(grpToBottom, GRP_SCROLL_TRIES[i]);
            setTimeout(function () {
                var l = document.getElementById('sms-log');
                if (l && l.style.opacity === '0') l.style.opacity = '1';
            }, 1500);
        } else {
            log.scrollTop = grpScroll;
        }
    }

    function sendGroup() {
        if (grpSending || !grpId) return;
        var box = document.getElementById('sms-box');
        var body = String(box ? box.value : grpDraft || '').replace(/^\s+|\s+$/g, '');
        if (!body) return;
        if (body.length > SMS_G_TEXT_MAX) { setNote('Keep it under ' + SMS_G_TEXT_MAX + ' characters.', true); return; }
        var section = grpSection(grpId);
        var mention = grpMention;
        var reply = grpReply;
        grpSending = true;
        // The box is emptied here, exactly as a one-to-one send does. Only clearing grpDraft
        // would not hold: the next refresh runs rememberGroup(), which copies whatever is still
        // in the textarea back over it, and the "sent" line reappears in the field.
        grpDraft = '';
        if (box) {
            box.value = '';
            try { fitSmsBox(box); } catch (e) {}
            if (document.activeElement === box) { try { box.blur(); } catch (e) {} }
        }
        try { syncSendButton(); } catch (e) {}
        // Raw read: cleanList (made for one-to-one threads) drops from/mentions/replyTo, and
        // writing the list back would strip them from every earlier line — which turned an older
        // character's message into the current player's own.
        Promise.all([loadGroupBox('outbox', section), soft(getEnv())]).then(function (r) {
            var list = r[0];
            var msg = { id: 'w-' + Date.now() + '-' + (grpSeq += 1), text: body, at: Date.now() };
            if (grpMeId) msg.from = grpMeId;
            if (mention) msg.mentions = [mention.id];
            if (reply) msg.replyTo = reply.id;
            var game = smsGameOf(r[1]);
            if (game) msg.game = game;
            list.push(msg);
            if (list.length > SMS_G_KEEP) list = list.slice(list.length - SMS_G_KEEP);
            return saveJson('outbox', list, section);
        }).then(function () {
            soundPlay('sent');
            grpReply = null;
            grpSyncReplyBar();
            grpMention = null;
            grpMentionOpen = false;
            grpComposing = false;
            grpRenderedKey = '';
            grpStick = true;
            setNote('', false);
            refresh();
        }, function (err) {
            // Put the line back so it is not lost, the way a failed one-to-one send does.
            grpDraft = body;
            if (box) {
                box.value = body;
                try { fitSmsBox(box); } catch (e) {}
            }
            setNote(errText(err), true);
        }).then(function () { grpSending = false; });
    }

