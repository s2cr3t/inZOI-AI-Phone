    // ------------------------------------------------------------------
    // Texts. outbox.cfg is written only here. inbox.cfg holds the contact's replies.
    // ------------------------------------------------------------------
    function parseJson(raw) {
        if (typeof raw !== 'string') return raw;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    function smsImageClean(raw) {
        if (!raw || typeof raw.id !== 'string' || !/^[a-f0-9]{16}$/.test(raw.id)) return null;
        var w = Number(raw.width);
        var h = Number(raw.height);
        if (Math.floor(w) !== w || Math.floor(h) !== h || w <= 0 || h <= 0 || w > 100000 || h > 100000) return null;
        return { id: raw.id, width: w, height: h };
    }

    // A family member's reply read aloud (sms-bridge lib/voicenotes.js): media/<id>.webm.
    function smsVoiceClean(raw) {
        if (!raw || typeof raw.id !== 'string' || !/^[a-f0-9]{16}$/.test(raw.id)) return null;
        var seconds = Number(raw.seconds);
        return isFinite(seconds) && seconds > 0 && seconds < 600 ? { id: raw.id, seconds: seconds } : null;
    }

    function cleanList(raw) {
        var data = parseJson(raw);
        if (!Array.isArray(data)) return [];
        var out = [];
        for (var i = 0; i < data.length; i++) {
            var m = data[i];
            if (!m || typeof m.text !== 'string' || typeof m.at !== 'number') continue;
            var image = smsImageClean(m.image);
            if (!m.text && !image) continue;
            var msg = { id: String(m.id || ('m-' + m.at + '-' + i)), text: m.text || SMS_PHOTO_TEXT, at: m.at, game: smsGameClean(m.game) };
            if (image) msg.image = image;
            var voice = smsVoiceClean(m.voice);
            if (voice) msg.voice = voice;
            if (m.kind === 'notice') msg.notice = true;
            if (m.work === 'up' || m.work === 'down') msg.work = m.work;
            if (m.hint === true) msg.hint = true;
            out.push(msg);
        }
        return out;
    }

    function notNotice(m) { return !m.notice; }

    // cohtml does not clip a list row: white-space/text-overflow are ignored and a long message
    // wraps to four lines. Cut the text to about one line instead, counting a CJK character as
    // two, so the row keeps its height whatever the engine does.
    function smsClip(text, budget) {
        var s = String(text === undefined || text === null ? '' : text);
        var n = 0;
        for (var i = 0; i < s.length; i++) {
            n += s.charCodeAt(i) > 0x2e80 ? 2 : 1;
            if (n > (budget || 40)) return s.slice(0, i) + '\u2026';
        }
        return s;
    }

    // Which build this page is running. Written once per boot into the mod's cfg directory, so
    // from outside the game it is possible to tell whether a reload really picked up new code.
    var SMS_BUILD = '2026-10-28.2.89-groups';

    function smsSection(playerId, contactId) { return SMS_SECTION + '/' + playerId + '-' + contactId; }

    function loadBox(key, section) {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: section, key: key }, 'value')
            .then(function (r) { return cleanList(r.value); }, function () { return []; });
    }

    function loadSeen(section) {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: section, key: 'seen' }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                return v && typeof v.at === 'number' ? v.at : 0;
            }, function () { return 0; });
    }

    function loadStatus(section) {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: section, key: 'status' }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                return v && typeof v === 'object' ? v : null;
            }, function () { return null; });
    }

    function saveJson(key, value, section) {
        return call('uimod.cfg_save', {
            mod_id: SMS_MOD,
            section: section,
            key: key,
            value: JSON.stringify(value)
        });
    }

    // The reply service empties every conversation and its memory. The phone only writes the
    // request, then waits until cleared.cfg names that same request.
    function watchClear() {
        if (!smsClearingAt) return Promise.resolve();
        if (Date.now() - smsClearingAt > 120000) {
            smsClearingAt = 0;
            smsClearAsk = false;
            setNote('Could not clear texts. Is the reply service running?', true);
            return Promise.resolve();
        }
        return cfgValue(SMS_SECTION, 'cleared').then(function (v) {
            if (v && typeof v.at === 'number' && v.at >= smsClearingAt) {
                smsClearingAt = 0;
                smsClearAsk = false;
                smsRenderedKey = '';
                smsDraft = '';
                smsPhotos = {};
                smsPhotoPending = null;
                syncSmsPhotoComposer();
                setNote('Texts cleared.', false);
                bannerAt = {};
                bannerReady = {};
                clearBannerQueue();
            }
        }, function () {});
    }

    function requestClear() {
        if (smsClearingAt) return;
        smsClearAsk = false;
        smsClearingAt = Date.now();
        smsRenderedKey = '';
        setNote('Clearing...', false);
        saveJson('clear', { at: smsClearingAt }, SMS_SECTION).then(function () {
            refresh();
        }, function (err) {
            smsClearingAt = 0;
            setNote(errText(err), true);
            refresh();
        });
    }

    function clearTools() {
        var row = node('div', 'sms-tools');
        if (smsClearingAt) {
            row.appendChild(node('div', 'sms-tool-note', 'Clearing all texts...'));
            return row;
        }
        if (smsClearAsk) {
            row.appendChild(node('div', 'sms-tool-note', 'Clear all texts and group chats?'));
            var yes = node('button', 'sms-tool warn', 'Clear');
            yes.type = 'button';
            onTap(yes, function (e) {
                e.stopPropagation();
                requestClear();
            });
            var no = node('button', 'sms-tool', 'Cancel');
            no.type = 'button';
            onTap(no, function (e) {
                e.stopPropagation();
                smsClearAsk = false;
                setNote('', false);
                refresh();
            });
            row.appendChild(yes);
            row.appendChild(no);
            return row;
        }
        var btn = node('button', 'sms-tool', 'Clear');
        btn.type = 'button';
        onTap(btn, function (e) {
            e.stopPropagation();
            smsClearAsk = true;
            refresh();
        });
        row.appendChild(btn);
        return row;
    }

    function isSpouseOf(self, m) {
        if (!self || !m) return false;
        return String(self.spouse_id) === String(m.entity_id) || String(m.spouse_id) === String(self.entity_id);
    }

    // Household members the played character can text: spouse first, then oldest to youngest.
    function textContacts(meId, members) {
        var self = memberById(members, meId);
        var list = members.filter(function (m) {
            return String(m.entity_id) !== String(meId) && !NO_PHONE_STEPS[m.age_group];
        });
        list.sort(function (a, b) {
            var sa = isSpouseOf(self, a) ? 1 : 0;
            var sb = isSpouseOf(self, b) ? 1 : 0;
            if (sa !== sb) return sb - sa;
            return (GROWTH_ORDER[b.age_group] || 0) - (GROWTH_ORDER[a.age_group] || 0);
        });
        // Then the people outside the household this character has texted, newest first.
        var mine = smsOutside[String(meId)];
        if (mine && Array.isArray(mine.people)) {
            mine.people.forEach(function (p) {
                if (p && p.entity_id && !memberById(list, p.entity_id) && String(p.entity_id) !== String(meId)) list.push(p);
            });
        }
        return list;
    }

    // People outside the household the played character has texted (from Contacts), per
    // character, in saved/texts-outside.cfg: { v, byPlayer: { id: { people: [contact] } } }.
    // The reply service answers them like family, without moving them in the game.
    var SMS_OUTSIDE_KEY = 'texts-outside';
    var SMS_OUTSIDE_MAX = 30;
    var smsOutside = {};

    function loadOutside() {
        return cachedRead('outside', 4000, function () {
            return cfgValue(SOUND_SECTION, SMS_OUTSIDE_KEY).then(function (v) {
                smsOutside = v && v.v === 1 && v.byPlayer && typeof v.byPlayer === 'object' ? v.byPlayer : {};
            }, function () {});
        });
    }

    // Everyone a group can hold: the household, then the people outside it that any character on
    // this phone has texted (New Group offers those too), so their names and faces resolve.
    function grpPeople(members) {
        var list = (members || []).slice();
        Object.keys(smsOutside).forEach(function (pid) {
            var mine = smsOutside[pid];
            (mine && Array.isArray(mine.people) ? mine.people : []).forEach(function (p) {
                if (p && p.entity_id && !memberById(list, p.entity_id)) list.push(p);
            });
        });
        return list;
    }

    function addOutside(meId, c, label) {
        var key = String(meId);
        var mine = smsOutside[key] || (smsOutside[key] = { people: [] });
        var person = {
            entity_id: c.entity_id, first_name: c.first_name || '', last_name: c.last_name || '', gender: c.gender || '',
            age_group: c.age_group || '', age_group_text: c.age_group_text || '', job_name: c.job_name || '',
            relationship_label: label || '', outside: true
        };
        mine.people = [person].concat(mine.people.filter(function (p) { return String(p.entity_id) !== String(c.entity_id); })).slice(0, SMS_OUTSIDE_MAX);
        return saveJson(SMS_OUTSIDE_KEY, { v: 1, byPlayer: smsOutside }, SOUND_SECTION).then(null, function () {});
    }

    // A schoolmate's friend request to the played high-schooler, from ui/phone/suitor/board.cfg
    // (written by the reply service, lib/suitor.js): { v, byPlayer: { id: { id, state, note,
    // contact } } }. The answer goes to saved/suitor-answers.cfg, { v, byId: { request id:
    // { answer: accept | decline, at } } }, where the service picks it up; accepted, the suitor
    // joins Texts like anyone messaged from Contacts.
    var SUITOR_SECTION = 'ui/phone/suitor';
    var SUITOR_ANSWERS_KEY = 'suitor-answers';
    var SUITOR_ANSWERS_MAX = 20;
    var suitorBoard = {};
    var suitorAnswers = {};

    function loadSuitor() {
        return cachedRead('suitor', 4000, function () {
            return Promise.all([cfgValue(SUITOR_SECTION, 'board'), cfgValue(SOUND_SECTION, SUITOR_ANSWERS_KEY)]).then(function (r) {
                var b = r[0];
                suitorBoard = b && b.v === 1 && b.byPlayer && typeof b.byPlayer === 'object' ? b.byPlayer : {};
                var a = r[1] && r[1].v === 1 && r[1].byId && typeof r[1].byId === 'object' ? r[1].byId : {};
                Object.keys(a).forEach(function (k) { if (!suitorAnswers[k]) suitorAnswers[k] = a[k]; });
            }, function () {});
        });
    }

    // The request waiting for this character, or null.
    function suitorRequest(meId) {
        var rec = suitorBoard[String(meId)];
        if (!rec || rec.state !== 'request' || !rec.id || !rec.contact || !rec.contact.entity_id) return null;
        return suitorAnswers[rec.id] ? null : rec;
    }

    // The household as the last Texts or chat read had it, for the lover mark on a chat's header.
    var smsMembersSeen = [];

    // Who the played character loves, marked in Texts and on the chat: their spouse, or the
    // schoolmate they are going out with (suitor board state dating). '' for anyone else.
    function loverTag(meId, m, members) {
        if (!m) return '';
        var self = memberById(members || [], meId);
        if (self && isSpouseOf(self, m)) return '爱人';
        var rec = suitorBoard[String(meId)];
        if (rec && rec.state === 'dating' && rec.contact && String(rec.contact.entity_id) === String(m.entity_id)) return '恋人';
        return '';
    }

    function answerSuitor(meId, rec, answer) {
        suitorAnswers[rec.id] = { answer: answer, at: Date.now() };
        var ids = Object.keys(suitorAnswers).sort(function (a, b) { return (suitorAnswers[b].at || 0) - (suitorAnswers[a].at || 0); });
        var keep = {};
        ids.slice(0, SUITOR_ANSWERS_MAX).forEach(function (k) { keep[k] = suitorAnswers[k]; });
        suitorAnswers = keep;
        var saved = saveJson(SUITOR_ANSWERS_KEY, { v: 1, byId: keep }, SOUND_SECTION).then(null, function () {});
        if (answer !== 'accept') return saved;
        return saved.then(function () { return addOutside(meId, rec.contact, ''); });
    }

    // Texts folders: the player's own grouping of their chats, per played character, kept by this
    // phone alone in saved/texts-folders.cfg: { v, byPlayer: { id: { folders: [{ id, name }],
    // assign: { 'c:<contact id>' | 'g:<group id>': folder id } } } }. The Texts list shows one folder
    // at a time, picked from the chips above it; Manage (textsFolders) makes, names and fills them.
    // Each character's folders live in persona/<id>/folders.cfg: { v, folders, assign }. The
    // service files that folder with the household it belongs to (lib/households.js), so another
    // save, whose people may have the same ids, never sees them. Folders written before that, in the
    // shared saved/texts-folders.cfg ({ v, byPlayer: { id: ... } }), are taken over once.
    var TX_FOLDERS_KEY = 'folders';
    var TX_LEGACY_KEY = 'texts-folders';
    var TX_FOLDERS_MAX = 8;
    var TX_NAME_MAX = 8;
    var TX_ALL = '';
    var TX_NONE = '_none';
    // Player id -> { folders, assign } as last read or changed here.
    var txFoldersAll = {};
    // Player id -> read from its file at least once since the phone started.
    var txFoldersRead = {};
    // Player id -> when they were last changed here: a read within a few seconds of a change does
    // not put back what the file held before the change was saved.
    var txFoldersChangedAt = {};
    var TX_FRESH_MS = 6000;
    // Player id -> the folder the list shows.
    var txFolderOn = {};
    var txNewName = '';

    function txSection(meId) { return 'ui/phone/persona/' + String(meId); }

    function txClean(v) {
        if (!v || typeof v !== 'object') return null;
        return { folders: Array.isArray(v.folders) ? v.folders : [], assign: v.assign && typeof v.assign === 'object' ? v.assign : {} };
    }

    // { folders, assign } of this player; {} when never saved (the file is not there); null when
    // the read failed (the game busy loading a save, the answer late), which is not an empty file.
    function readTxFolders(meId) {
        var missing = function (e) { return /not found/i.test(errText(e)); };
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: txSection(meId), key: TX_FOLDERS_KEY }, 'value').then(function (r) {
            var raw = r && r.value;
            if (raw === undefined || raw === null || raw === '') return readTxLegacy(meId);
            var v = parseJson(raw);
            return v && v.v === 1 ? txClean(v) : null;
        }, function (e) {
            return missing(e) ? readTxLegacy(meId) : null;
        });
    }

    // The shared file of before: this player's entry, or {} when there is none.
    function readTxLegacy(meId) {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: SOUND_SECTION, key: TX_LEGACY_KEY }, 'value').then(function (r) {
            var v = parseJson(r && r.value);
            var mine = v && v.v === 1 && v.byPlayer && typeof v.byPlayer === 'object' ? v.byPlayer[String(meId)] : null;
            var got = txClean(mine);
            if (!got) return {};
            // Taken over: written to its own place, and out of the shared file, so another save
            // with someone under the same id cannot find it there later.
            got.migrated = v.byPlayer;
            return got;
        }, function (e) {
            return /not found/i.test(errText(e)) ? {} : null;
        });
    }

    // Read again whenever the Texts list loads (a few seconds apart at most), so a household switch
    // that moved the files is picked up; what was just changed here is not undone by it.
    function loadTxFolders(meId) {
        var key = String(meId);
        return cachedRead('tx-folders:' + key, 5000, function () { return readTxFolders(key); }).then(function (v) {
            if (!v) return;
            if (Date.now() - (txFoldersChangedAt[key] || 0) < TX_FRESH_MS) return;
            var legacy = v.migrated;
            delete v.migrated;
            txFoldersAll[key] = v.folders ? v : { folders: [], assign: {} };
            txFoldersRead[key] = true;
            if (legacy) {
                saveJson(TX_FOLDERS_KEY, { v: 1, folders: v.folders, assign: v.assign }, txSection(key)).then(function () {
                    var rest = {};
                    Object.keys(legacy).forEach(function (k) { if (k !== key) rest[k] = legacy[k]; });
                    return saveJson(TX_LEGACY_KEY, { v: 1, byPlayer: rest }, SOUND_SECTION);
                }).then(null, function () {});
                forgetRead('tx-folders:' + key);
            }
        }, function () {});
    }

    function txFoldersOf(meId) {
        var key = String(meId);
        var f = txFoldersAll[key];
        if (!f || typeof f !== 'object') f = txFoldersAll[key] = { folders: [], assign: {} };
        if (!Array.isArray(f.folders)) f.folders = [];
        f.folders = f.folders.filter(function (x) { return x && typeof x.id === 'string' && typeof x.name === 'string'; });
        if (!f.assign || typeof f.assign !== 'object') f.assign = {};
        return f;
    }

    // meId: the player whose folders changed. Never read yet: read first, so a failed read cannot
    // turn into an empty file written over the real one.
    function saveTxFolders(meId) {
        var key = String(meId);
        txFoldersChangedAt[key] = Date.now();
        var write = function () {
            var f = txFoldersOf(key);
            txFoldersChangedAt[key] = Date.now();
            forgetRead('tx-folders:' + key);
            return saveJson(TX_FOLDERS_KEY, { v: 1, folders: f.folders, assign: f.assign }, txSection(key)).then(null, function () {});
        };
        if (txFoldersRead[key]) return write();
        return readTxFolders(key).then(function (v) {
            if (!v) {
                setNote('分组暂时存不进去，稍后再改一次。', true);
                return;
            }
            txFoldersRead[key] = true;
            return write();
        });
    }

    // The folder a chat is in, or '' when it is in none (or its folder was deleted).
    function txFolderOfKey(f, key) {
        var id = f.assign[key];
        return id && f.folders.some(function (x) { return x.id === id; }) ? id : '';
    }

    function txInFolder(f, key, folder) {
        if (folder === TX_ALL) return true;
        var at = txFolderOfKey(f, key);
        return folder === TX_NONE ? !at : at === folder;
    }

    function txCurrent(meId, f) {
        var on = txFolderOn[String(meId)] || TX_ALL;
        if (on !== TX_ALL && on !== TX_NONE && !f.folders.some(function (x) { return x.id === on; })) on = TX_ALL;
        return on;
    }

    function txCleanName(v) {
        return String(v || '').replace(/[\r\n]/g, '').replace(/^\s+|\s+$/g, '').slice(0, TX_NAME_MAX);
    }

    // Every chat on the Texts list as { key, unread }.
    function txChats(data) {
        var out = [];
        (data.groups || []).forEach(function (row) { if (row && row.meta) out.push({ key: 'g:' + row.meta.id, unread: row.unread || 0 }); });
        (data.contacts || []).forEach(function (row) { out.push({ key: 'c:' + row.member.entity_id, unread: row.unread || 0 }); });
        return out;
    }

    // Switching folders, or changing them on the Manage page, only changes what is drawn: the page
    // is drawn again from what it last read instead of reading every conversation from the game
    // again, which takes seconds in the game.
    function txRedraw() {
        var rec = lastData[current];
        if ((current !== 'texts' && current !== 'textsFolders') || !rec || !rec.data || String(rec.played) !== String(playedId)) {
            refresh();
            return;
        }
        var scroll = wf.content.scrollTop;
        show(screens[current].render(rec.data));
        if (current === 'textsFolders') wf.content.scrollTop = scroll;
    }

    function txChips(data, f, on) {
        var row = node('div', 'tx-chips');
        var chats = txChats(data);
        var chip = function (id, label) {
            var unread = 0;
            chats.forEach(function (c) { if (txInFolder(f, c.key, id)) unread += c.unread; });
            var c = node('div', 'tx-chip' + (on === id ? ' on' : ''));
            c.appendChild(node('span', 'tx-chip-name', label));
            if (unread > 0 && on !== id && id !== TX_ALL) c.appendChild(node('span', 'tx-chip-dot', unread > 9 ? '9+' : String(unread)));
            onTap(c, function (e) {
                e.stopPropagation();
                txFolderOn[String(data.meId)] = id;
                txRedraw();
            });
            row.appendChild(c);
        };
        chip(TX_ALL, '全部');
        f.folders.forEach(function (x) { chip(x.id, x.name); });
        if (f.folders.length && chats.some(function (c) { return !txFolderOfKey(f, c.key); })) chip(TX_NONE, '未分组');
        var edit = node('div', 'tx-chip tx-chip-edit', f.folders.length ? '管理' : '+ 分组');
        onTap(edit, function (e) {
            e.stopPropagation();
            // The Manage page reads what the list reads: it opens on the list's data at once, and
            // is brought up to date behind it.
            if (!lastData.textsFolders || String(lastData.textsFolders.played) !== String(playedId)) {
                lastData.textsFolders = { data: data, at: Date.now(), played: playedId };
            }
            open('textsFolders');
        });
        row.appendChild(edit);
        return row;
    }

    // One tap: family, classmates, work and friends, from what the list already knows. Chats the
    // player already put somewhere stay where they are.
    function txAutoFolders(data, f) {
        var me = memberById(data.members || [], data.meId) || {};
        var teen = /Teen$/.test(String(me.age_group || ''));
        var ensure = function (name) {
            for (var i = 0; i < f.folders.length; i++) if (f.folders[i].name === name) return f.folders[i].id;
            if (f.folders.length >= TX_FOLDERS_MAX) return '';
            var id = 'f' + Date.now().toString(36) + f.folders.length;
            f.folders.push({ id: id, name: name });
            return id;
        };
        var put = function (key, name) {
            if (txFolderOfKey(f, key)) return;
            var id = ensure(name);
            if (id) f.assign[key] = id;
        };
        var household = function (id) { return !!memberById(data.members || [], id); };
        (data.groups || []).forEach(function (row) {
            var m = row && row.meta;
            if (!m) return;
            put('g:' + m.id, m.school ? '同学' : m.company ? '工作' : m.members.every(household) ? '家人' : '朋友');
        });
        var notKin = { '': 1, '…': 1, Romance: 1, 'Close Friend': 1, Friend: 1, Colleague: 1, Acquaintance: 1, '上级': 1 };
        (data.contacts || []).forEach(function (row) {
            var m = row.member;
            var label = String(m.relationship_label || '');
            var name;
            if (!m.outside) name = '家人';
            else if (label === 'Colleague' || label === '上级') name = '工作';
            else if (teen && /Teen$/.test(String(m.age_group || ''))) name = '同学';
            else if (!notKin[label]) name = '家人';
            else name = '朋友';
            put('c:' + m.entity_id, name);
        });
    }

    function txNameField(value, placeholder, onInput) {
        var field = node('textarea', 'sms-gname tx-fname');
        field.setAttribute('maxlength', String(TX_NAME_MAX));
        field.setAttribute('rows', '1');
        if (placeholder) field.setAttribute('placeholder', placeholder);
        field.value = value;
        applyUiFont(field);
        field.addEventListener('input', function () { onInput(field.value); });
        return field;
    }

    function renderTxFolders(data) {
        var wrap = node('div', 'ph-page');
        wrap.appendChild(subHeader('textsFolders', '聊天分组'));
        var f = txFoldersOf(data.meId);
        var fc = card('分组');
        if (!f.folders.length) fc.appendChild(node('div', 'ph-caption', '还没有分组。可以自己建，也可以一键按家人、同学、工作、朋友分好。'));
        f.folders.forEach(function (x) {
            var r = node('div', 'tx-frow');
            var name = txNameField(x.name, '', function (v) { v = txCleanName(v); if (v) x.name = v; });
            name.addEventListener('blur', function () { saveTxFolders(data.meId); });
            r.appendChild(name);
            var del = node('div', 'tx-fbtn warn', '删除');
            onTap(del, function (e) {
                e.stopPropagation();
                f.folders = f.folders.filter(function (y) { return y.id !== x.id; });
                Object.keys(f.assign).forEach(function (k) { if (f.assign[k] === x.id) delete f.assign[k]; });
                if (txFolderOn[String(data.meId)] === x.id) txFolderOn[String(data.meId)] = TX_ALL;
                saveTxFolders(data.meId);
                txRedraw();
            });
            r.appendChild(del);
            fc.appendChild(r);
        });
        if (f.folders.length < TX_FOLDERS_MAX) {
            var addRow = node('div', 'tx-frow');
            addRow.appendChild(txNameField(txNewName, '新分组名称', function (v) { txNewName = v; }));
            var add = node('div', 'tx-fbtn on', '添加');
            onTap(add, function (e) {
                e.stopPropagation();
                var v = txCleanName(txNewName);
                if (!v) { setNote('先写分组名称。', true); return; }
                if (f.folders.some(function (y) { return y.name === v; })) { setNote('已经有叫「' + v + '」的分组了。', true); return; }
                f.folders.push({ id: 'f' + Date.now().toString(36), name: v });
                txNewName = '';
                setNote('', false);
                saveTxFolders(data.meId);
                txRedraw();
            });
            addRow.appendChild(add);
            fc.appendChild(addRow);
        }
        if (!f.folders.length) {
            var btns = node('div', 'ph-btns');
            btns.appendChild(actionButton('一键分组', 'on last', function () {
                txAutoFolders(data, f);
                saveTxFolders(data.meId);
                txRedraw();
            }));
            fc.appendChild(btns);
        }
        wrap.appendChild(fc);
        if (!f.folders.length) return wrap;

        var ac = card('把聊天放进分组');
        var rows = [];
        (data.groups || []).forEach(function (row) {
            if (row && row.meta) rows.push({ key: 'g:' + row.meta.id, name: row.meta.name, face: function () { return grpFaces(row.meta, data.members || []); } });
        });
        (data.contacts || []).forEach(function (row) {
            var m = row.member;
            rows.push({ key: 'c:' + m.entity_id, name: fullName(m), face: function () { var p = node('div', 'sms-pic'); p.appendChild(faceAvatar(m)); return p; } });
        });
        if (!rows.length) ac.appendChild(node('div', 'ph-empty', '还没有聊天。'));
        rows.forEach(function (item) {
            var r = node('div', 'tx-arow');
            var top = node('div', 'ph-row');
            top.appendChild(item.face());
            top.appendChild(node('div', 'ph-name tx-aname', item.name));
            r.appendChild(top);
            var chips = node('div', 'tx-achips');
            var paint = function () {
                var at = txFolderOfKey(f, item.key);
                for (var i = 0; i < chips.childNodes.length; i++) {
                    var c = chips.childNodes[i];
                    c.className = 'tx-chip small' + (c.getAttribute('data-f') === at ? ' on' : '');
                }
            };
            var opt = function (id, label) {
                var c = node('div', 'tx-chip small', label);
                c.setAttribute('data-f', id);
                onTap(c, function (e) {
                    e.stopPropagation();
                    if (id) f.assign[item.key] = id;
                    else delete f.assign[item.key];
                    paint();
                    saveTxFolders(data.meId);
                });
                chips.appendChild(c);
            };
            f.folders.forEach(function (x) { opt(x.id, x.name); });
            opt('', '不分组');
            paint();
            r.appendChild(chips);
            ac.appendChild(r);
        });
        wrap.appendChild(ac);
        return wrap;
    }

    function suitorCard(rec, meId) {
        var c = node('div', 'ph-card sms-suitor');
        var line = node('div', 'ph-row');
        var pic = node('div', 'sms-pic');
        pic.appendChild(faceAvatar(rec.contact));
        line.appendChild(pic);
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', fullName(rec.contact)));
        who.appendChild(node('div', 'ph-sub', '想加你为好友'));
        line.appendChild(who);
        c.appendChild(line);
        if (rec.note) c.appendChild(node('div', 'sms-suitor-note', '“' + rec.note + '”'));
        var btns = node('div', 'ph-btns');
        btns.appendChild(actionButton('拒绝', '', function () {
            answerSuitor(meId, rec, 'decline').then(function () { refresh(); });
        }));
        btns.appendChild(actionButton('接受', 'on last', function () {
            answerSuitor(meId, rec, 'accept').then(function () {
                smsContactId = String(rec.contact.entity_id);
                open('chat');
            });
        }));
        c.appendChild(btns);
        return c;
    }

    function prefixIds(list, prefix) {
        var out = [];
        for (var i = 0; i < list.length; i++) out.push({ id: prefix + list[i].id, text: list[i].text, image: list[i].image || null, voice: list[i].voice || null, at: list[i].at, game: list[i].game });
        return out;
    }

    // The conversation between meId and contactId as seen by meId:
    //   mine   = me-contact/outbox (typed as me)      + contact-me/inbox (replies written for me)
    //   theirs = me-contact/inbox  (contact's replies) + contact-me/outbox (typed as the contact)
    function loadConversation(meId, contactId) {
        var section = smsSection(meId, contactId);
        var reverse = smsSection(contactId, meId);
        return Promise.all([
            loadBox('outbox', section),
            loadBox('inbox', section),
            loadBox('outbox', reverse),
            loadBox('inbox', reverse),
            loadSeen(section),
            loadStatus(section)
        ]).then(function (d) {
            // A notice in the reverse inbox is about the other character's story, not this one's.
            var mine = d[0].concat(prefixIds(d[3].filter(notNotice), 'r-'));
            var theirs = d[1].concat(prefixIds(d[2], 'r-'));
            return {
                section: section,
                mine: mine,
                theirs: theirs,
                messages: mergeThread(mine, theirs),
                seenAt: d[4],
                status: d[5]
            };
        });
    }

    // The Texts list in one file (ui/phone/sms/index.cfg, written by the reply service,
    // lib/smsindex.js): each chat's newest message, unread count and status, and each group's
    // summary. One read instead of six per chat and four per group, which the game's pace for UI
    // mods turned into seconds. Used only while fresh and written for the played character;
    // otherwise every file is read as before.
    var SMS_INDEX_FRESH_MS = 10000;
    // Section -> newest message of theirs this phone has marked seen: the index catches up a
    // second later, and a chat just read must not show its old unread badge meanwhile.
    var smsSeenLocal = {};

    function loadSmsIndex(meId) {
        return cachedRead('sms-index', 700, function () {
            return call('uimod.cfg_load', { mod_id: SMS_MOD, section: SMS_SECTION, key: 'index' }, 'value')
                .then(function (r) { return parseJson(r.value); }, function () { return null; });
        }).then(function (v) {
            if (!v || v.v !== 1 || String(v.player) !== String(meId) || typeof v.at !== 'number') return null;
            if (Math.abs(Date.now() - v.at) > SMS_INDEX_FRESH_MS) return null;
            if (!v.threads || typeof v.threads !== 'object' || !v.groups || typeof v.groups !== 'object') return null;
            return v;
        }, function () { return null; });
    }

    function smsIndexLast(raw) {
        if (!raw || typeof raw.at !== 'number' || typeof raw.text !== 'string') return null;
        var side = raw.side === 'mine' || raw.side === 'notice' ? raw.side : 'theirs';
        return { side: side, id: String(raw.id || ''), text: raw.text, image: smsImageClean(raw.image), voice: smsVoiceClean(raw.voice), at: raw.at, game: smsGameClean(raw.game) };
    }

    // One Texts row from the index: { last, unread, status }, as loadConversation would give it.
    function smsIndexRow(idx, meId, contactId) {
        var row = idx.threads[String(contactId)] || null;
        var section = smsSection(meId, contactId);
        var last = row ? smsIndexLast(row.last) : null;
        var unread = row && typeof row.unread === 'number' ? row.unread : 0;
        var theirsAt = row && typeof row.theirsAt === 'number' ? row.theirsAt : 0;
        if (unread && smsSeenLocal[section] && smsSeenLocal[section] >= theirsAt) unread = 0;
        // A chat open a moment ago knows its newest message sooner than the index does.
        var rec = chatLast[section];
        var fresh = rec && rec.data && rec.data.messages && rec.data.messages.length ? rec.data.messages[rec.data.messages.length - 1] : null;
        if (fresh && (!last || fresh.at > last.at)) last = fresh;
        return { last: last, unread: unread, status: row && row.status && typeof row.status === 'object' ? row.status : null };
    }

    function totalUnread(meId, members) {
        var contacts = textContacts(meId, members);
        return loadSmsIndex(meId).then(function (idx) {
            if (!idx) return null;
            var n = 0;
            contacts.forEach(function (m) { n += smsIndexRow(idx, meId, m.entity_id).unread; });
            return n;
        }).then(function (fromIndex) {
            if (fromIndex !== null) return fromIndex;
            return totalUnreadRead(meId, contacts);
        });
    }

    function totalUnreadRead(meId, contacts) {
        return Promise.all(contacts.map(function (m) {
            var section = smsSection(meId, m.entity_id);
            var reverse = smsSection(m.entity_id, meId);
            return Promise.all([loadBox('inbox', section), loadBox('outbox', reverse), loadSeen(section)]).then(function (d) {
                return unreadCount(d[0].concat(d[1]), d[2]);
            });
        })).then(function (counts) {
            var n = 0;
            for (var i = 0; i < counts.length; i++) n += counts[i];
            return n;
        }, function () { return 0; });
    }

    // Presence of the reply service, from status.cfg and its heartbeat age.
    function presence(status) {
        if (!status || typeof status.heartbeat !== 'number' || Date.now() - status.heartbeat > BRIDGE_STALE_MS) {
            return { cls: 'off', text: 'Offline', fresh: false, typing: false };
        }
        var s = status.state;
        if (s === 'typing') return { cls: 'typing', text: 'Typing...', fresh: true, typing: true };
        if (s === 'reading') return { cls: 'on', text: 'Reading...', fresh: true, typing: false };
        if (s === 'waiting') return { cls: 'off', text: 'Connecting...', fresh: true, typing: false };
        if (s === 'paused') return { cls: 'off', text: 'Auto replies off', fresh: true, typing: false };
        if (s === 'offline') return { cls: 'off', text: 'Offline', fresh: false, typing: false };
        if (s === 'error') return { cls: 'err', text: status.error || 'Reply service error', fresh: true, typing: false };
        return { cls: 'on', text: 'Online', fresh: true, typing: false };
    }

    function receiptText(data) {
        var list = data.messages;
        if (!list.length) return '';
        var last = list[list.length - 1];
        if (last.side !== 'mine') return '';
        var st = data.status;
        var p = presence(st);
        if (st && typeof st.readAt === 'number' && st.readAt >= last.at && p.fresh) return 'Read';
        return p.fresh ? 'Delivered' : 'Sent';
    }

    // hold: a full redraw follows and will glide the log itself, so the typing row only
    // takes its entrance here and does not start a second glide.
    function applySmsStatus(data, hold) {
        var p = presence(data.status);
        var pres = document.getElementById('sms-presence');
        if (pres) {
            pres.textContent = p.text;
            pres.className = 'sms-presence ' + p.cls;
        }
        var receipt = document.getElementById('sms-receipt');
        if (receipt) receipt.textContent = receiptText(data);
        var heart = document.getElementById('sms-heart');
        if (heart) {
            var h = p.fresh ? heartText(data.status) : '';
            heart.textContent = h;
            heart.style.display = h ? 'block' : 'none';
        }
        var typing = document.getElementById('sms-typing');
        if (p.typing !== smsTypingShown) {
            var turnedOn = p.typing && !smsTypingShown;
            smsTypingShown = p.typing;
            if (typing) {
                typing.className = 'sms-row theirs sms-typing' + (turnedOn ? ' sms-in' : '');
                typing.style.display = p.typing ? 'flex' : 'none';
            }
            if (turnedOn && smsStick && !hold) {
                var log = document.getElementById('sms-log');
                if (log) rideSmsLog(log);
            } else if (!p.typing && smsStick) {
                stickToBottom();
            }
        } else if (typing) {
            typing.style.display = p.typing ? 'flex' : 'none';
        }
    }

    function unreadCount(inbox, seenAt) {
        var n = 0;
        var at = seenAt || 0;
        for (var i = 0; i < inbox.length; i++) {
            if (inbox[i].at > at) n += 1;
        }
        return n;
    }

    function mergeThread(outbox, inbox) {
        var list = [];
        var i;
        for (i = 0; i < outbox.length; i++) list.push({ side: 'mine', id: outbox[i].id, text: outbox[i].text, image: outbox[i].image || null, voice: outbox[i].voice || null, at: outbox[i].at, game: outbox[i].game });
        for (i = 0; i < inbox.length; i++) {
            list.push({ side: inbox[i].notice ? 'notice' : 'theirs', id: inbox[i].id, text: inbox[i].text, image: inbox[i].image || null, voice: inbox[i].voice || null, at: inbox[i].at, game: inbox[i].game, hint: !!inbox[i].hint, work: inbox[i].work || '' });
        }
        list.sort(function (a, b) {
            if (a.at !== b.at) return a.at - b.at;
            if (a.side !== b.side) return a.side === 'mine' ? -1 : 1;
            return a.id < b.id ? -1 : 1;
        });
        return list;
    }

    function threadKey(messages) {
        var s = '';
        for (var i = 0; i < messages.length; i++) s += messages[i].id + '\n';
        return s;
    }

    // The game UI does not resolve the font of form controls like other elements; copying the
    // font actually used by the page keeps CJK input from rendering as boxes.
    var uiFontFamily = null;
    function applyUiFont(el) {
        if (uiFontFamily === null) {
            uiFontFamily = '';
            try {
                var cs = window.getComputedStyle ? window.getComputedStyle(document.body) : null;
                if (cs && cs.fontFamily) uiFontFamily = cs.fontFamily;
            } catch (e) {
                uiFontFamily = '';
            }
        }
        if (uiFontFamily) el.style.fontFamily = uiFontFamily;
    }

    // Real time, for Moments posts.
    function smsClock(ms) {
        var d = new Date(ms);
        if (isNaN(d.getTime())) return '';
        var now = new Date();
        var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
        return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm;
    }

    function loadEmojiSet() {
        if (emojiSet) return Promise.resolve(emojiSet);
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: EMOJI_SECTION, key: 'set' }, 'value').then(function (r) {
            var v = parseJson(r.value);
            var list = v && Array.isArray(v.emoji) ? v.emoji.filter(function (e) {
                return e && /^[a-z0-9]+$/.test(e.id || '') && typeof e.name === 'string' && e.name;
            }) : [];
            if (!list.length) return null;
            var byName = {};
            list.forEach(function (e) { byName[e.name] = e.id; });
            emojiSet = { list: list, byName: byName };
            return emojiSet;
        }, function () { return null; });
    }

    function emojiImg(id, name) {
        var img = node('img', 'sms-emoji');
        img.src = 'emoji/' + id + '.png';
        img.alt = '[' + name + ']';
        return img;
    }

    // Text with its [name] tokens drawn as emoji. Returns how many emoji and how much other text.
    // Each piece of text goes in its own span: the game's UI puts a bare text node next to an
    // image on a line of its own, while spans and images flow on one line.
    function emojiText(parent, piece) {
        parent.appendChild(node('span', 'sms-run', piece));
    }

    function emojiFill(parent, text) {
        var count = 0;
        var other = 0;
        var re = /\[([^\[\]\s]{1,6})\]/g;
        var last = 0;
        var m;
        while ((m = re.exec(text))) {
            var id = emojiSet && emojiSet.byName[m[1]];
            if (!id) continue;
            if (m.index > last) {
                emojiText(parent, text.slice(last, m.index));
                if (/\S/.test(text.slice(last, m.index))) other += 1;
            }
            parent.appendChild(emojiImg(id, m[1]));
            count += 1;
            last = re.lastIndex;
        }
        if (last < text.length) {
            emojiText(parent, text.slice(last));
            if (/\S/.test(text.slice(last))) other += 1;
        }
        return { emoji: count, other: other };
    }

    // A bubble of only a few emoji is drawn large and without the bubble, like other phones do.
    function smsBubble(text) {
        var bubble = node('div', 'sms-bubble');
        var r = emojiFill(bubble, text);
        if (r.emoji > 0 && r.emoji <= EMOJI_BIG_MAX && !r.other) bubble.className = 'sms-bubble big';
        return bubble;
    }

    // A contact's story came to an end: one centred line from the reply service, which opens
    // the Stories page.
    function smsNotice(text, arriving, delay) {
        var line = node('div', 'sms-notice' + (arriving ? ' sms-in' : ''));
        line.appendChild(node('span', 'sms-notice-text', text));
        line.appendChild(node('span', 'sms-notice-go', '查看 \u203A'));
        if (arriving) setSmsDelay(line, delay);
        onTap(line, function (e) {
            e.stopPropagation();
            open('stories');
        });
        return line;
    }

    // How a colleague's impression of the player just moved (the reply service's workplace.js):
    // a centred line, up in green or down in red, which opens OA.
    function smsWorkNotice(text, dir, arriving, delay) {
        var line = node('div', 'sms-notice sms-work ' + (dir === 'up' ? 'up' : 'down') + (arriving ? ' sms-in' : ''));
        line.appendChild(node('span', 'sms-work-arrow', dir === 'up' ? '\u25B2' : '\u25BC'));
        line.appendChild(node('span', 'sms-notice-text', text));
        line.appendChild(node('span', 'sms-notice-go', 'OA \u203A'));
        if (arriving) setSmsDelay(line, delay);
        onTap(line, function (e) {
            e.stopPropagation();
            open('oa');
        });
        return line;
    }

    // Under a message that let the contact's story show.
    function smsHintTag(arriving, delay) {
        var tag = node('div', 'sms-hint' + (arriving ? ' sms-in' : ''), '话里有话 \u203A');
        if (arriving) setSmsDelay(tag, delay);
        onTap(tag, function (e) {
            e.stopPropagation();
            open('stories');
        });
        return tag;
    }

    // status.cfg heart: the contact's story has let something show.
    function heartText(status) {
        var h = status && status.heart;
        if (!h || typeof h !== 'object' || !(h.clues > 0)) return '';
        return h.soon ? '好像有心事 · 这两天就有结果' : '好像有心事';
    }

    // A photo keeps its aspect ratio and shares the bubble with an optional caption. The
    // placeholder gives the text-only reply service context, but is not shown as a caption.
    function smsMessageBubble(m) {
        if (m.voice) return smsVoiceBubble(m.voice);
        if (!m.image) return smsBubble(m.text);
        var caption = m.text === SMS_PHOTO_TEXT ? '' : m.text;
        var bubble = node('div', 'sms-bubble sms-photo-message' + (caption ? ' has-caption' : ''));
        var frame = node('div', 'sms-photo-frame');
        var w = m.image.width;
        var h = m.image.height;
        var scale = Math.min(2, 218 / w, 250 / h);
        var outW = Math.max(1, Math.round(w * scale));
        var outH = Math.max(1, Math.round(h * scale));
        frame.style.width = outW + 'px';
        frame.style.height = outH + 'px';
        var img = node('img', 'sms-photo-image');
        img.src = 'media/' + m.image.id + '.jpg';
        img.setAttribute('alt', caption || 'Photo');
        img.addEventListener('load', function () {
            if (smsStick) stickToBottom();
        });
        img.addEventListener('error', function () {
            img.style.display = 'none';
            frame.appendChild(node('span', 'sms-photo-missing', 'Photo unavailable'));
        });
        frame.appendChild(img);
        bubble.appendChild(frame);
        if (caption) {
            var text = node('div', 'sms-photo-caption');
            emojiFill(text, caption);
            bubble.appendChild(text);
        }
        return bubble;
    }

    // A voice message: a bubble as wide as the clip is long, tapped to play or stop. The game's
    // engine plays sound only from a <video> it draws, so the clip plays in the island like the
    // phone's sounds (soundHostEl). The chat is redrawn often; the playing clip outlives its
    // bubble and the new bubble is marked from smsVoiceNow.
    var smsVoiceNow = null;

    function smsVoiceBubble(voice) {
        var secs = Math.max(1, Math.round(voice.seconds));
        var bubble = node('div', 'sms-bubble sms-voice' + (smsVoiceNow && smsVoiceNow.id === voice.id ? ' playing' : ''));
        bubble._voiceId = voice.id;
        bubble.style.width = Math.min(210, 66 + secs * 7) + 'px';
        var wave = node('span', 'sms-voice-wave');
        for (var i = 1; i <= 3; i++) wave.appendChild(node('span', 'sms-voice-bar b' + i));
        bubble.appendChild(wave);
        bubble.appendChild(node('span', 'sms-voice-len', secs + '″'));
        bubble.addEventListener('click', function () { smsVoicePlay(voice); });
        smsVoiceLoad(voice);
        return bubble;
    }

    function smsVoiceMark(id, on) {
        var list = document.getElementsByClassName('sms-voice');
        for (var i = 0; i < list.length; i++) {
            if (list[i]._voiceId !== id) continue;
            list[i].className = 'sms-bubble sms-voice' + (on ? ' playing' : '');
        }
    }

    // Like the phone's sounds, a clip is made and left loading in the island before it is wanted
    // (when its bubble is drawn) and is rewound and played on a tap: a <video> made on the tap
    // reports playing but stays silent. The newest few are kept.
    var SMS_VOICE_KEEP = 6;
    var smsVoiceMedia = [];

    function smsVoiceLoad(voice) {
        for (var i = 0; i < smsVoiceMedia.length; i++) {
            if (smsVoiceMedia[i].id === voice.id) return smsVoiceMedia[i].media;
        }
        var m = document.createElement('video');
        m.setAttribute('preload', 'auto');
        m.setAttribute('width', '16');
        m.setAttribute('height', '16');
        m.src = 'media/' + voice.id + '.webm';
        ['playing', 'ended', 'error'].forEach(function (name) {
            m.addEventListener(name, function () {
                traceLoad('voice ' + voice.id + ' ' + name + ' at ' + (m.currentTime || 0) + (m.error ? ' error ' + m.error.code : ''));
                if (name !== 'playing' && smsVoiceNow && smsVoiceNow.id === voice.id) smsVoiceStop();
            });
        });
        soundHostEl().appendChild(m);
        smsVoiceMedia.push({ id: voice.id, media: m });
        while (smsVoiceMedia.length > SMS_VOICE_KEEP) {
            var old = smsVoiceMedia.shift();
            if (smsVoiceNow && smsVoiceNow.id === old.id) smsVoiceStop();
            soundDrop(old.media);
        }
        return m;
    }

    function smsVoiceStop() {
        var cur = smsVoiceNow;
        if (!cur) return;
        smsVoiceNow = null;
        clearTimeout(cur.timer);
        try { cur.media.pause(); } catch (e) {}
        smsVoiceMark(cur.id, false);
    }

    function smsVoicePlay(voice) {
        var again = smsVoiceNow && smsVoiceNow.id === voice.id;
        smsVoiceStop();
        if (again) return;
        var m = smsVoiceLoad(voice);
        try {
            m.volume = Math.max(0, Math.min(1, soundSettings.volume / 100 * soundGame));
            m.currentTime = 0;
        } catch (e) {}
        var cur = { id: voice.id, media: m, timer: 0 };
        smsVoiceNow = cur;
        smsVoiceMark(voice.id, true);
        traceLoad('voice ' + voice.id + ' tap, ready ' + m.readyState + ' volume ' + m.volume + ' (sound ' + soundState + ')');
        // The engine may play without ever firing ended, so the clip's length stops it too.
        cur.timer = setTimeout(function () { if (smsVoiceNow === cur) smsVoiceStop(); }, (voice.seconds + 1.5) * 1000);
        soundStart(m);
        setTimeout(function () {
            traceLoad('voice ' + voice.id + ' +1000ms ready ' + m.readyState + ' at ' + (m.currentTime || 0) + ' paused ' + m.paused);
        }, 1000);
    }

    function smsInsertEmoji(name) {
        if (smsComposing) return;
        var box = document.getElementById('sms-box');
        var value = box ? box.value : smsDraft;
        var token = '[' + name + ']';
        if (value.length + token.length > SMS_TEXT_MAX) return;
        var at = smsCaret !== null && smsCaret <= value.length ? smsCaret : value.length;
        value = value.slice(0, at) + token + value.slice(at);
        smsCaret = at + token.length;
        smsDraft = value;
        if (box) {
            box.value = value;
            fitSmsBox(box);
        }
        syncSendButton();
    }

    function emojiPanel() {
        var panel = node('div', 'sms-emoji-panel' + (smsEmojiOpen ? '' : ' closed'));
        panel.id = 'sms-emoji-panel';
        (emojiSet ? emojiSet.list : []).forEach(function (e, i) {
            var cell = node('div', 'sms-emoji-pick');
            // The first rows pop in as a wave from the top left.
            if (i < 40) setSmsDelay(cell, 60 + Math.floor(i / 8) * 40 + (i % 8) * 16);
            cell.setAttribute('title', e.name);
            cell.appendChild(emojiImg(e.id, e.name));
            onTap(cell, function (ev) {
                ev.stopPropagation();
                smsInsertEmoji(e.name);
            }, { silent: true });
            panel.appendChild(cell);
        });
        return panel;
    }

    // Opening and closing are CSS animations of transform and opacity only, so the game's UI
    // engine never re-lays out the chat mid-animation. Closed, the panel keeps its emoji loaded
    // at zero height rather than display: none, so the first open does not wait for images.
    var emojiFoldTimer = null;

    function restartAnim(elm, cls) {
        elm.className = elm.className.replace(new RegExp('\\s*\\b' + cls + '\\b', 'g'), '');
        void elm.offsetWidth;
        elm.className += ' ' + cls;
    }

    function animateEmojiPanel(panel, opening) {
        if (emojiFoldTimer) { clearTimeout(emojiFoldTimer); emojiFoldTimer = null; }
        if (opening) {
            panel.className = 'sms-emoji-panel';
            restartAnim(panel, 'pop');
            stickToBottom();
            setTimeout(stickToBottom, 60);
        } else {
            panel.className = 'sms-emoji-panel';
            restartAnim(panel, 'fold');
            emojiFoldTimer = setTimeout(function () {
                emojiFoldTimer = null;
                if (!smsEmojiOpen) panel.className = 'sms-emoji-panel closed';
                stickToBottom();
            }, 170);
        }
    }

    function smsGameClean(g) {
        return g && typeof g.day === 'number' && typeof g.min === 'number' ? { day: g.day, min: g.min } : null;
    }

    function smsGameOf(env) {
        if (!env || typeof env.day !== 'number' || typeof env.hour !== 'number') return null;
        return { day: env.day, min: env.hour * 60 + (env.minute || 0) };
    }

    function smsGameClock(g) { return g ? minutesToLabel(g.min) : ''; }

    // The time line between message runs, in game time: "Today 18:31", "Yesterday 09:05",
    // "Monday 21:40", "Day 998 08:12".
    function smsStamp(g, env) {
        if (!g) return '';
        var hm = minutesToLabel(g.min);
        var today = env && typeof env.day === 'number' ? env.day : null;
        if (today === null) return 'Day ' + g.day + ' ' + hm;
        var ago = today - g.day;
        if (ago === 0) return 'Today ' + hm;
        if (ago === 1) return 'Yesterday ' + hm;
        var dow = SMS_WEEKDAYS.indexOf(env.day_of_week);
        if (ago > 1 && ago < 7 && dow >= 0) return SMS_WEEKDAYS[((dow - ago) % 7 + 7) % 7] + ' ' + hm;
        return 'Day ' + g.day + ' ' + hm;
    }

    // Whether a time line goes above m. Only messages that know their game time get one.
    function smsStamped(prev, m) {
        if (!m.game) return false;
        if (!prev || !prev.game) return true;
        if (m.game.day !== prev.game.day) return true;
        return m.game.min - prev.game.min >= SMS_STAMP_GAP_MIN;
    }

    function sendGlyph() {
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'sms-send-ico');
        glyphPath(svg, 'M12 3.6l-7.1 7.1 1.6 1.6 4.4-4.4V20.4h2.2V7.9l4.4 4.4 1.6-1.6L12 3.6z', '#ffffff');
        return svg;
    }

    function photoGlyph() {
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'sms-photo-ico');
        glyphShape(svg, 'rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7 });
        glyphShape(svg, 'circle', { cx: 8.2, cy: 9, r: 1.5, fill: 'currentColor' });
        glyphPath(svg, 'M5.5 17.2l4.1-4.4c.7-.7 1.7-.7 2.4 0l2.1 2.2 1.5-1.5c.7-.7 1.7-.7 2.4 0l2 2.1v2H5.5z', 'currentColor');
        return svg;
    }

    function pickSmsPhoto() {
        if (!smsThread || smsSending || smsClearingAt) return;
        if (smsPhotoPending) {
            setNote('Finish choosing the photo on the PC first.', false);
            return;
        }
        if (aiPending || wallPending) {
            setNote('Another phone service request is still running. Try again in a moment.', false);
            return;
        }
        var section = smsThread;
        loadAiService().then(function (v) {
            aiService = v && typeof v === 'object' ? v : null;
            if (smsThread !== section) return;
            if (!aiAlive(aiService)) {
                setNote('Adding photos needs AI Phone Service running on this PC.', true);
                return;
            }
            if (!aiTakesRequests(aiService)) {
                setNote(AI_NO_GUARDIAN, true);
                return;
            }
            smsSeq += 1;
            var id = 'p' + Date.now() + '-' + smsSeq;
            smsPhotoPending = { id: id, type: 'photo_pick', section: section, at: Date.now() };
            smsEmojiOpen = false;
            var panel = document.getElementById('sms-emoji-panel');
            if (panel) animateEmojiPanel(panel, false);
            syncSmsPhotoComposer();
            saveJson('request', { id: id, type: 'photo_pick' }, AI_SECTION).then(function () {
                smsPhotoWatch();
            }, function (err) {
                smsPhotoPending = null;
                syncSmsPhotoComposer();
                setNote('Could not open the photo picker: ' + errText(err), true);
            });
        }, function (err) {
            setNote('Could not reach AI Phone Service: ' + errText(err), true);
        });
    }

    // The Windows dialog may outlive the chat page, so its answer is watched independently.
    function smsPhotoWatch() {
        if (smsPhotoWatching) return;
        smsPhotoWatching = true;
        var step = function () {
            if (!smsPhotoPending) {
                smsPhotoWatching = false;
                return;
            }
            loadAiService().then(function (v) {
                if (v && typeof v === 'object') aiService = v;
                smsPhotoCheckAnswer();
            }).then(null, function () {}).then(function () {
                if (smsPhotoPending) setTimeout(step, SMS_PHOTO_WATCH_MS);
                else smsPhotoWatching = false;
            });
        };
        setTimeout(step, SMS_PHOTO_WATCH_MS);
    }

    function smsPhotoCheckAnswer() {
        var asked = smsPhotoPending;
        if (!asked) return;
        var r = aiService && aiService.reply && typeof aiService.reply === 'object' ? aiService.reply : null;
        if (!r || r.id !== asked.id || r.pending) {
            if (Date.now() - asked.at > SMS_PHOTO_PICK_MS) {
                smsPhotoPending = null;
                syncSmsPhotoComposer();
                if (smsThread === asked.section) setNote('No answer from AI Phone Service. Check that it is running on this PC.', true);
            }
            return;
        }
        smsPhotoPending = null;
        var item = r.ok ? smsImageClean(r.item) : null;
        if (item) {
            smsPhotos[asked.section] = item;
            if (smsThread === asked.section) smsStick = true;
        } else if (smsThread === asked.section && r.code !== 'cancelled') {
            setNote(String(r.message || 'That photo could not be added.'), true);
        }
        syncSmsPhotoComposer();
        if (item && smsThread === asked.section) stickToBottom();
    }

    // Updates only the attachment UI; the textarea and any active IME are left untouched.
    function syncSmsPhotoComposer() {
        var pick = document.getElementById('sms-photo');
        var preview = document.getElementById('sms-photo-preview');
        var waiting = !!(smsPhotoPending && smsPhotoPending.section === smsThread);
        var photo = smsThread && smsPhotos[smsThread] ? smsPhotos[smsThread] : null;
        if (pick) {
            pick.className = 'sms-photo-btn' + (waiting ? ' waiting' : '') + (smsPhotoPending || smsSending ? ' off' : '');
            pick.setAttribute('title', waiting ? 'Choosing a photo on the PC' : 'Add photo');
        }
        if (preview) {
            while (preview.firstChild) preview.removeChild(preview.firstChild);
            if (waiting) {
                preview.style.display = 'flex';
                preview.appendChild(node('span', 'sms-photo-spinner'));
                preview.appendChild(node('span', 'sms-photo-wait', 'Choose a photo on your PC. If covered by the game, press Alt+Tab.'));
            } else if (photo) {
                preview.style.display = 'flex';
                var thumb = node('img', 'sms-photo-thumb');
                thumb.src = 'media/' + photo.id + '.jpg';
                thumb.setAttribute('alt', 'Selected photo');
                preview.appendChild(thumb);
                var meta = node('div', 'sms-photo-meta');
                meta.appendChild(node('div', 'sms-photo-ready', 'Photo ready'));
                meta.appendChild(node('div', 'sms-photo-size', photo.width + ' × ' + photo.height));
                preview.appendChild(meta);
                var remove = node('button', 'sms-photo-remove', '×');
                remove.type = 'button';
                remove.setAttribute('title', 'Remove photo');
                var section = smsThread;
                onTap(remove, function (e) {
                    e.stopPropagation();
                    delete smsPhotos[section];
                    syncSmsPhotoComposer();
                }, { silent: true });
                preview.appendChild(remove);
            } else {
                preview.style.display = 'none';
            }
        }
        syncSendButton();
    }

    // The send button is grey while there is nothing to send or a send is still being saved.
    function syncSendButton() {
        var box = document.getElementById('sms-box');
        var btn = document.getElementById('sms-send');
        if (!btn) return;
        var photo = smsThread && smsPhotos[smsThread];
        var empty = !photo && (!box || !String(box.value || '').replace(/^\s+|\s+$/g, ''));
        btn.className = 'sms-send' + (empty || smsSending || smsClearingAt ? ' off' : '');
    }

    // The box grows with what is typed, up to a few lines, then scrolls.
    // A scrollbar shown while measuring narrows the text and adds a line, so it is hidden then.
    // A thread read at its newest message stays there while the box takes room from it.
    function fitSmsBox(box) {
        if (!box) return;
        var log = document.getElementById('sms-log');
        var atEnd = !!log && (log.scrollHeight - log.scrollTop - log.clientHeight) < 48;
        box.style.overflowY = 'hidden';
        box.style.height = '38px';
        var h = box.scrollHeight + 2;
        if (h > 38) box.style.height = Math.min(h, SMS_INPUT_MAX_PX) + 'px';
        box.style.overflowY = h > SMS_INPUT_MAX_PX ? 'auto' : 'hidden';
        if (log && atEnd && !(smsScrollRide && !smsScrollRide.dead)) log.scrollTop = log.scrollHeight;
    }

    function rememberSms() {
        var box = document.getElementById('sms-box');
        var log = document.getElementById('sms-log');
        if (box) {
            smsDraft = box.value;
            // A rebuild must not focus this box again. focus() is what pulled a held walk
            // key into the field. The draft stays; the player clicks the box to continue.
            smsFocused = false;
        }
        if (log) {
            smsStick = (log.scrollHeight - log.scrollTop - log.clientHeight) < 48;
            smsScroll = log.scrollTop;
        }
    }

    function restoreSms() {
        var box = document.getElementById('sms-box');
        var log = document.getElementById('sms-log');
        if (box && box.value !== smsDraft) box.value = smsDraft;
        if (box) {
            fitSmsBox(box);
            syncSendButton();
        }
        smsFocused = false;
        // The rebuilt box must not keep the keyboard. A held walk key would fall into it,
        // and the next message would then remove a focused field.
        if (box && document.activeElement === box) {
            try { box.blur(); } catch (e) {}
        }
        restoreSmsLog(log);
    }

    function smsEarlierRow(hidden) {
        var row = node('div', 'sms-earlier', '查看更早的消息（' + hidden + '）');
        row.id = 'sms-earlier';
        onTap(row, function (e) {
            e.stopPropagation();
            smsShowEarlier();
        });
        return row;
    }

    // The next SMS_PAGE older messages above the ones shown, the reading position held: the
    // message at the top stays where it was and the older ones appear above it.
    function smsShowEarlier() {
        var oldLog = document.getElementById('sms-log');
        var data = smsChatData;
        if (smsEarlierBusy || !oldLog || !data || current !== 'chat' || smsWindow.section !== data.section) return;
        smsEarlierBusy = true;
        var fromBottom = oldLog.scrollHeight - oldLog.scrollTop;
        smsWindow.count += SMS_PAGE;
        if (patchChat(data)) {
            var log = document.getElementById('sms-log');
            if (log) {
                smsStick = false;
                log.scrollTop = Math.max(0, log.scrollHeight - fromBottom);
                smsJumpSync(log);
            }
        } else {
            smsWindow.count -= SMS_PAGE;
        }
        // Once the new rows have been laid out: a scroll event from the swap must not ask again.
        setTimeout(function () { smsEarlierBusy = false; }, 120);
    }

    function restoreSmsLog(log) {
        if (log && smsStick) {
            var px = measureSmsIn(log);
            // A new bubble eases into view. The first paint of a thread, and a log that has
            // not been laid out yet, still jump to the newest line.
            if (px > 1 && log.clientHeight > 0) rideSmsLog(log, px);
            else {
                log.scrollTop = log.scrollHeight;
                setTimeout(stickToBottom, 0);
                setTimeout(stickToBottom, 120);
                setTimeout(stickToBottom, 400);
            }
        } else if (log) {
            log.scrollTop = smsScroll;
        }
    }

    // A text arriving in the open thread replaces the header and the message list only. The
    // compose box is the same element before and after, so it keeps its focus, its draft and
    // the input method's half-typed word. Rebuilding it while a word was being composed left
    // the game's text input stuck, and no text field in the phone took a key after that.
    function patchChat(data) {
        var box = document.getElementById('sms-box');
        var oldLog = document.getElementById('sms-log');
        var wrap = oldLog ? oldLog.parentNode : null;
        if (!box || !wrap || !data || !data.contact || smsShownSection !== data.section) return false;
        var oldNav = null;
        for (var i = 0; i < wrap.children.length; i++) {
            if (wrap.children[i].className === 'sms-nav') oldNav = wrap.children[i];
        }
        if (!oldNav) return false;
        var prevKey = smsRenderedKey;
        var prevSection = smsShownSection;
        var fresh = renderChat(data);
        var nav = null;
        var log = null;
        for (var j = 0; j < fresh.children.length; j++) {
            var c = fresh.children[j];
            if (c.className === 'sms-nav') nav = c;
            else if (c.id === 'sms-log') log = c;
        }
        if (!nav || !log) {
            smsRenderedKey = prevKey;
            smsShownSection = prevSection;
            return false;
        }
        smsStick = (oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight) < 48;
        smsScroll = oldLog.scrollTop;
        if (smsScrollRide) smsScrollRide.dead = true;
        wrap.replaceChild(nav, oldNav);
        wrap.replaceChild(log, oldLog);
        applySmsStatus(data, true);
        restoreSmsLog(log);
        return true;
    }

    function stickToBottom() {
        var log = document.getElementById('sms-log');
        if (!log || !smsStick) return;
        if (smsScrollRide && !smsScrollRide.dead) return;
        log.scrollTop = log.scrollHeight;
    }

    function setSmsDelay(elm, ms) {
        if (!ms) return;
        var v = ms + 'ms';
        elm.style.webkitAnimationDelay = v;
        elm.style.animationDelay = v;
    }

    // Height the new bubbles, their time lines and the typing row add to the log.
    function measureSmsIn(log) {
        var rows = log.getElementsByClassName('sms-in');
        var h = 0;
        for (var i = 0; i < rows.length; i++) {
            h += rows[i].offsetHeight;
            var mt = 0;
            try {
                var cs = window.getComputedStyle(rows[i]);
                if (cs && cs.marginTop) mt = parseFloat(cs.marginTop) || 0;
            } catch (e) {}
            h += mt;
        }
        return h;
    }

    // The round button over the box that appears once the log is scrolled up from the newest
    // message, and glides back down to it.
    var SMS_JUMP_PX = 160;

    function smsJumpButton() {
        var b = node('button', 'sms-jump' + (smsStick ? '' : ' show'));
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
            smsStick = true;
            b.className = 'sms-jump';
            rideSmsLog(log, Math.max(0, log.scrollHeight - log.clientHeight - log.scrollTop));
        });
        return b;
    }

    function smsJumpSync(log) {
        var b = document.getElementById('sms-jump');
        if (!b || !log) return;
        if (smsScrollRide && !smsScrollRide.dead) return;
        var up = log.scrollHeight - log.scrollTop - log.clientHeight > SMS_JUMP_PX;
        var want = up ? 'sms-jump show' : 'sms-jump';
        if (b.className !== want) b.className = want;
    }

    function stopSmsRide() {
        if (!smsScrollRide || smsScrollRide.dead) return;
        smsScrollRide.dead = true;
        smsStick = false;
    }

    // Glide the log by the height of whatever just arrived, and keep aiming at the bottom
    // if that height changes while the glide is running.
    function rideSmsLog(log, px) {
        if (!log) return;
        if (!(px > 1)) px = measureSmsIn(log);
        var dest = Math.max(0, log.scrollHeight - log.clientHeight);
        var from = dest - px;
        if (from < 0) from = 0;
        if (dest - from < 2) {
            log.scrollTop = dest;
            return;
        }
        if (smsScrollRide) smsScrollRide.dead = true;
        var ride = { dead: false, log: log, from: from, t0: Date.now() };
        smsScrollRide = ride;
        log.scrollTop = from;
        function step() {
            if (ride.dead || !log.parentNode) {
                if (smsScrollRide === ride) smsScrollRide = null;
                return;
            }
            var p = springAt((Date.now() - ride.t0) / 1000, SMS_SCROLL.response, SMS_SCROLL.damping);
            if (p > 1) p = 1;
            var destNow = Math.max(0, log.scrollHeight - log.clientHeight);
            log.scrollTop = ride.from + (destNow - ride.from) * p;
            if (Date.now() - ride.t0 < SMS_SCROLL.ms && p < 0.995) nextFrame(step);
            else {
                log.scrollTop = log.scrollHeight;
                if (smsScrollRide === ride) smsScrollRide = null;
            }
        }
        nextFrame(step);
    }

    // Contact list: one row per household member who can text, with the latest message.
    // Every conversation the list has just read, kept per pair of people, so tapping a row can
    // open that very thread at once instead of waiting for the same six files to come back
    // (open, chatCached). Keyed by section, so what is shown can only be the thread whose row was
    // tapped; the fresh copy lands as soon as it arrives and is patched over it.
    var CHAT_TTL_MS = 5 * 60 * 1000;
    // The row last tapped in Texts: { contact, meId, env }, for opening its thread before it is read.
    var smsOpenHint = null;
    var chatLast = {};

    function chatCached(screenId) {
        if (screenId !== 'chat' || !smsContactId || !playedId) return null;
        var section = smsSection(playedId, smsContactId);
        var rec = chatLast[section];
        if (rec && Date.now() - rec.at <= CHAT_TTL_MS) return rec.data;
        // Not read yet (the list is still reading, or it was read too long ago): the tapped row
        // already says who it is, so the conversation slides in at once on its header and box and
        // says it is loading, instead of the tap sitting unanswered until the read lands.
        var hint = smsOpenHint;
        if (!hint || String(hint.contact.entity_id) !== String(smsContactId) || String(hint.meId) !== String(playedId)) return null;
        return { env: hint.env, meId: hint.meId, contact: hint.contact, section: section, messages: [], status: null,
            portraitRev: portraitRev, loading: true };
    }

    function rememberChat(env, meId, contact, conv) {
        var section = smsSection(meId, contact.entity_id);
        chatLast[section] = { at: Date.now(), data: {
            env: env, meId: meId, contact: contact, section: section,
            messages: conv.messages, status: conv.status, portraitRev: portraitRev } };
        return chatLast[section].data;
    }

    function loadTexts() {
        return watchClear().then(function () {
            return Promise.all([getEnv(), getPossessedId(), getMembers(), loadPortraitIndex(), loadEmojiSet(), loadOutside(), loadSuitor()]);
        }).then(function (r) {
            return Promise.all([loadSmsIndex(String(r[1])), loadTxFolders(String(r[1]))]).then(function (x) { r.push(x[0]); return r; });
        }).then(function (r) {
            var meId = String(r[1]);
            var members = r[2];
            var contacts = textContacts(meId, members);
            var suitor = suitorRequest(meId);
            var idx = r[r.length - 1];
            return Promise.all(contacts.map(function (m) {
                // The index has every row ready; only without it is each chat read.
                if (idx) {
                    var row = smsIndexRow(idx, meId, m.entity_id);
                    return Promise.resolve({ member: m, last: row.last, unread: row.unread, status: row.status });
                }
                return loadConversation(meId, m.entity_id).then(function (conv) {
                    rememberChat(r[0], meId, m, conv);
                    return {
                        member: m,
                        last: conv.messages.length ? conv.messages[conv.messages.length - 1] : null,
                        unread: unreadCount(conv.theirs, conv.seenAt),
                        status: conv.status
                    };
                });
            })).then(function (rows) {
                return loadGroupsForTexts(members, meId, idx).then(function (groups) {
                    return { env: r[0], meId: meId, members: members, self: memberById(members, meId), contacts: rows, groups: groups, suitor: suitor };
                });
            });
        });
    }

    // The way into a new group: a plus in the corner of the header, not a row in the list.
    function smsPlusButton(action) {
        var btn = node('button', 'sms-plus');
        btn.type = 'button';
        btn.setAttribute('title', 'New group');
        var icon = node('div', 'sms-plus-icon');
        icon.appendChild(node('div', 'sms-np-h'));
        icon.appendChild(node('div', 'sms-np-v'));
        btn.appendChild(icon);
        onTap(btn, function (e) { e.stopPropagation(); action(); }, { silent: true });
        return btn;
    }

    function renderTexts(data) {
        var wrap = node('div');
        var head = subHeader('texts');
        head.appendChild(smsPlusButton(function () { grpNewName = ''; grpNewSel = {}; open('groupNew'); }));
        wrap.appendChild(head);
        wrap.appendChild(clearTools());
        if (data.suitor) wrap.appendChild(suitorCard(data.suitor, data.meId));
        var folders = txFoldersOf(data.meId);
        var shown = txCurrent(data.meId, folders);
        var chatCount = (data.groups || []).filter(Boolean).length + data.contacts.length;
        if (chatCount) wrap.appendChild(txChips(data, folders, shown));
        var groupsShown = (data.groups || []).filter(function (row) { return row && row.meta && txInFolder(folders, 'g:' + row.meta.id, shown); });
        var contactsShown = data.contacts.filter(function (row) { return txInFolder(folders, 'c:' + row.member.entity_id, shown); });
        try {
            groupListRows(wrap, groupsShown, data.members || [], data.env);
            if (groupsShown.length) wrap.appendChild(node('div', 'ph-group-sep'));
        } catch (e) {
            setNote('Groups: ' + errText(e), true);
        }
        if (shown !== TX_ALL && !groupsShown.length && !contactsShown.length) {
            var emptyFolder = card();
            emptyFolder.appendChild(node('div', 'ph-empty', '这个分组里还没有聊天。点「管理」把聊天放进来。'));
            wrap.appendChild(emptyFolder);
            return wrap;
        }
        if (!data.contacts.length) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'Nobody to text yet. Open Contacts and tap Message on someone.'));
            wrap.appendChild(none);
            return wrap;
        }
        contactsShown.forEach(function (row) {
            var m = row.member;
            var id = String(m.entity_id);
            var c = node('div', 'ph-card sms-contact');
            var line = node('div', 'ph-row');
            var pic = node('div', 'sms-pic');
            pic.appendChild(faceAvatar(m));
            if (row.unread > 0) pic.appendChild(node('div', 'sms-unread', row.unread > 9 ? '9+' : String(row.unread)));
            line.appendChild(pic);
            var who = node('div', 'ph-who');
            var top = node('div', 'sms-contact-top');
            top.appendChild(node('div', 'ph-name', fullName(m)));
            var lastGame = row.last && row.last.game;
            if (lastGame) {
                top.appendChild(node('div', 'sms-contact-time', data.env && data.env.day === lastGame.day
                    ? smsGameClock(lastGame) : smsStamp(lastGame, data.env)));
            }
            who.appendChild(top);
            var p = presence(row.status);
            var sub = node('div', 'ph-sub');
            joinWithDots(sub, [m.relationship_label || m.age_group_text]);
            var lover = loverTag(data.meId, m, data.members || []);
            if (lover) sub.appendChild(node('span', 'sms-lover inline', '\u2665 ' + lover));
            var pres = node('span', 'sms-presence inline ' + p.cls, p.text);
            sub.appendChild(pres);
            var heartLine = p.fresh ? heartText(row.status) : '';
            if (heartLine) sub.appendChild(node('span', 'sms-heart inline', heartLine));
            who.appendChild(sub);
            var lastText = row.last && row.last.voice ? '[语音]'
                : row.last && row.last.image
                ? (row.last.text === SMS_PHOTO_TEXT ? 'Photo' : 'Photo: ' + row.last.text)
                : row.last ? row.last.text : '';
            var preview = row.last ? (row.last.side === 'mine' ? 'You: ' : '') + lastText : 'No messages yet';
            var previewEl = node('div', 'sms-preview' + (row.unread > 0 ? ' new' : ''));
            emojiFill(previewEl, smsClip(preview, 40));
            who.appendChild(previewEl);
            line.appendChild(who);
            c.appendChild(line);
            onTap(c, function (e) {
                e.stopPropagation();
                smsContactId = id;
                smsOpenHint = { contact: m, meId: data.meId, env: data.env };
                open('chat');
            });
            wrap.appendChild(c);
        });
        return wrap;
    }

    // One conversation between the played character and the selected contact.
    function loadChat() {
        var followPlayed = refreshDropping;
        return watchClear().then(function () {
            return Promise.all([getEnv(), getPossessedId(), getMembers(), loadPortraitIndex(), loadEmojiSet(), loadOutside(), loadSuitor()]);
        }).then(function (r) {
            var meId = String(r[1]);
            var members = r[2];
            smsMembersSeen = members;
            var contact = null;
            var contacts = textContacts(meId, members);
            for (var i = 0; i < contacts.length; i++) {
                if (String(contacts[i].entity_id) === String(smsContactId)) contact = contacts[i];
            }
            if (!contact) {
                return { env: r[0], meId: meId, contact: null, portraitRev: portraitRev, leave: followPlayed };
            }
            var section = smsSection(meId, contact.entity_id);
            if (smsThread !== section) {
                smsThread = section;
                smsRenderedKey = '';
                smsDraft = '';
                smsStick = true;
                smsArrived = null;
            }
            // A text another app wrote for this chat (OA's request to the boss) waits in the box,
            // unless something is already being typed there.
            if (smsPrefill) {
                if (smsPrefill.contactId === String(contact.entity_id) && !smsDraft) smsDraft = smsPrefill.text;
                smsPrefill = null;
            }
            return loadConversation(meId, contact.entity_id).then(function (conv) {
                var latest = 0;
                for (var j = 0; j < conv.theirs.length; j++) {
                    if (conv.theirs[j].at > latest) latest = conv.theirs[j].at;
                }
                if (latest) smsSeenLocal[section] = Math.max(smsSeenLocal[section] || 0, latest);
                var seenP = latest > conv.seenAt ? saveJson('seen', { at: latest }, section).then(function () {}, function () {}) : Promise.resolve();
                return seenP.then(function () {
                    return rememberChat(r[0], meId, contact, conv);
                });
            });
        });
    }

    function sendSms() {
        if (smsSending || smsClearingAt || !smsThread) return;
        var box = document.getElementById('sms-box');
        var raw = box ? box.value : smsDraft;
        var body = String(raw || '').replace(/^\s+|\s+$/g, '');
        var section = smsThread;
        var photo = smsPhotos[section] || null;
        if (!body && !photo) return;
        if (body.length > SMS_TEXT_MAX) {
            setNote('Keep it under ' + SMS_TEXT_MAX + ' characters.', true);
            return;
        }
        smsSending = true;
        smsDraft = '';
        smsCaret = null;
        delete smsPhotos[section];
        if (box) {
            box.value = '';
            fitSmsBox(box);
        }
        syncSmsPhotoComposer();
        Promise.all([loadBox('outbox', section), soft(getEnv())]).then(function (r) {
            var list = r[0];
            var msg = { id: 'w-' + Date.now() + '-' + (smsSeq += 1), text: body || SMS_PHOTO_TEXT, at: Date.now() };
            if (photo) msg.image = photo;
            var game = smsGameOf(r[1]);
            if (game) msg.game = game;
            list.push(msg);
            if (list.length > SMS_KEEP) list = list.slice(list.length - SMS_KEEP);
            return saveJson('outbox', list, section);
        }).then(function () {
            soundPlay('sent');
            smsRenderedKey = '';
            smsStick = true;
            setNote('', false);
            refresh();
        }, function (err) {
            smsDraft = body;
            if (photo) smsPhotos[section] = photo;
            var again = document.getElementById('sms-box');
            if (again) {
                again.value = body;
                fitSmsBox(again);
            }
            setNote(errText(err), true);
        }).then(function () {
            smsSending = false;
            syncSmsPhotoComposer();
        });
    }

    function renderChat(data) {
        var wrap = node('div', 'sms');
        if (!data.contact) {
            wrap.appendChild(subHeader('chat'));
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'This person can no longer be texted.'));
            wrap.appendChild(none);
            return wrap;
        }
        var nav = node('div', 'sms-nav');
        var back = node('div', 'ph-back', '< Back');
        onTap(back, function (e) {
            e.stopPropagation();
            open(backTarget('chat'));
        });
        nav.appendChild(back);
        var peer = node('div', 'sms-peer');
        peer.setAttribute('title', 'Edit how ' + (data.contact.first_name || fullName(data.contact)) + ' talks');
        peer.appendChild(faceAvatar(data.contact));
        peer.appendChild(node('div', 'sms-peer-name', fullName(data.contact) + ' \u203A'));
        var loverWord = loverTag(data.meId, data.contact, smsMembersSeen);
        if (loverWord) peer.appendChild(node('div', 'sms-lover', '\u2665 ' + loverWord));
        var pres = node('div', 'sms-presence off', 'Offline');
        pres.id = 'sms-presence';
        peer.appendChild(pres);
        onTap(peer, function (e) {
            e.stopPropagation();
            open('persona');
        });
        nav.appendChild(peer);
        var heart = node('div', 'sms-heart', '');
        heart.id = 'sms-heart';
        heart.style.display = 'none';
        onTap(heart, function (e) {
            e.stopPropagation();
            open('stories');
        });
        nav.appendChild(heart);
        wrap.appendChild(nav);

        var log = node('div', 'sms-log');
        log.id = 'sms-log';
        // The reader turning the wheel takes the list back. The glide only writes scrollTop,
        // which does not count as that.
        log.addEventListener('wheel', function () {
            smsReaderAt = Date.now();
            stopSmsRide();
        });
        // A drag on the scrollbar is the reader too.
        log.addEventListener('mousedown', function () { smsReaderAt = Date.now(); });
        log.addEventListener('scroll', function () {
            smsJumpSync(log);
            // Older messages come in only when the reader scrolls up to them. A log that was
            // just swapped in sits at the top until the game's view has laid it out, and a new
            // text then must not load more and leave the thread stuck in the middle.
            if (log.scrollTop < SMS_EARLIER_PX && Date.now() - smsReaderAt < SMS_READER_MS &&
                !(smsScrollRide && !smsScrollRide.dead) && document.getElementById('sms-earlier')) smsShowEarlier();
        });
        var list = data.messages;
        if (data.loading) {
            var wait = node('div', 'sms-loading');
            wait.appendChild(node('div', 'sms-loading-spin'));
            wait.appendChild(node('div', 'sms-loading-text', '正在载入对话…'));
            log.appendChild(wait);
        } else if (!list.length) {
            log.appendChild(node('div', 'sms-empty', 'No messages yet. Say hi to ' + (data.contact.first_name || fullName(data.contact)) + '.'));
        }
        smsChatData = data;
        if (smsWindow.section !== data.section) smsWindow = { section: data.section, count: SMS_PAGE };
        var start = Math.max(0, list.length - smsWindow.count);
        if (start > 0) log.appendChild(smsEarlierRow(start));
        var known = smsArrived;
        var nextSeen = {};
        var freshN = 0;
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            // Every id counts as seen, drawn or not, so older messages shown later do not
            // animate in as if they had just arrived.
            nextSeen[m.id] = true;
            if (i < start) continue;
            var prev = i > 0 ? list[i - 1] : null;
            var next = i + 1 < list.length ? list[i + 1] : null;
            var stamped = smsStamped(prev, m);
            var arriving = !!(known && !known[m.id]);
            var delay = Math.min(freshN * SMS_IN_STAGGER_MS, SMS_IN_STAGGER_MAX);
            if (arriving) freshN += 1;
            var stampNode = null;
            if (stamped) {
                stampNode = node('div', 'sms-stamp' + (prev ? '' : ' first') + (arriving ? ' sms-in' : ''), smsStamp(m.game, data.env));
                if (arriving) setSmsDelay(stampNode, delay);
                log.appendChild(stampNode);
            }
            if (m.side === 'notice') {
                log.appendChild(m.work ? smsWorkNotice(m.text, m.work, arriving, delay) : smsNotice(m.text, arriving, delay));
                continue;
            }
            var joinPrev = !stamped && !!prev && prev.side === m.side && m.at - prev.at < SMS_RUN_GAP_MS;
            var joinNext = !!next && next.side === m.side && next.at - m.at < SMS_RUN_GAP_MS && !smsStamped(m, next);
            var row = node('div', 'sms-row ' + (m.side === 'mine' ? 'mine' : 'theirs') + (joinPrev ? ' join' : '') + (joinNext ? '' : ' tail') + (arriving ? ' sms-in' : ''));
            var bubble = smsMessageBubble(m);
            if (arriving) setSmsDelay(bubble, delay);
            var time = m.game ? node('div', 'sms-time', smsGameClock(m.game)) : null;
            if (time && m.side === 'mine') row.appendChild(time);
            row.appendChild(bubble);
            if (time && m.side !== 'mine') row.appendChild(time);
            log.appendChild(row);
            if (m.hint && m.side === 'theirs') log.appendChild(smsHintTag(arriving, delay));
        }
        // The loading shell has no messages yet; what it is filled with first is the thread as it
        // was, not texts that just arrived.
        if (!data.loading) smsArrived = nextSeen;
        var receipt = node('div', 'sms-receipt', '');
        receipt.id = 'sms-receipt';
        log.appendChild(receipt);
        var typing = node('div', 'sms-row theirs sms-typing');
        typing.id = 'sms-typing';
        var dots = node('div', 'sms-bubble sms-dots');
        dots.appendChild(node('span', 'sms-dot d1'));
        dots.appendChild(node('span', 'sms-dot d2'));
        dots.appendChild(node('span', 'sms-dot d3'));
        typing.appendChild(dots);
        typing.style.display = 'none';
        log.appendChild(typing);
        smsTypingShown = false;
        wrap.appendChild(log);

        var compose = node('div', 'sms-compose');
        compose.appendChild(smsJumpButton());
        var field = node('div', 'sms-field');
        var input = node('textarea', 'sms-input');
        input.id = 'sms-box';
        applyUiFont(input);
        input.setAttribute('maxlength', String(SMS_TEXT_MAX));
        input.setAttribute('placeholder', 'Message');
        input.setAttribute('rows', '1');
        input.addEventListener('input', function () {
            smsDraft = input.value;
            smsCaret = input.selectionEnd;
            fitSmsBox(input);
            syncSendButton();
        });
        var keepCaret = function () { smsCaret = input.selectionEnd; };
        input.addEventListener('keyup', keepCaret);
        input.addEventListener('mouseup', keepCaret);
        input.addEventListener('keydown', function (e) {
            if (e.keyCode === 13 && !e.shiftKey && !e.isComposing && !smsComposing) {
                if (e.preventDefault) e.preventDefault();
                sendSms();
            }
        });
        input.addEventListener('compositionstart', function () { smsComposing = true; });
        input.addEventListener('compositionend', function () {
            smsComposing = false;
            smsDraft = input.value;
            if (!smsComposeRefresh) return;
            smsComposeRefresh = false;
            refresh();
        });
        var send = node('button', 'sms-send off');
        send.id = 'sms-send';
        send.type = 'button';
        send.setAttribute('title', 'Send');
        send.appendChild(sendGlyph());
        onTap(send, function (e) {
            e.stopPropagation();
            sendSms();
        }, { silent: true });
        var pick = node('button', 'sms-photo-btn');
        pick.id = 'sms-photo';
        pick.type = 'button';
        pick.setAttribute('title', 'Add photo');
        pick.appendChild(photoGlyph());
        onTap(pick, function (e) {
            e.stopPropagation();
            pickSmsPhoto();
        }, { silent: true });
        var smile = node('button', 'sms-emoji-btn' + (smsEmojiOpen ? ' on' : ''));
        smile.type = 'button';
        smile.setAttribute('title', 'Emoji');
        if (emojiSet) {
            var face = emojiSet.byName['微笑'] || emojiSet.list[0].id;
            smile.appendChild(emojiImg(face, ''));
        } else {
            smile.style.display = 'none';
        }
        onTap(smile, function (e) {
            e.stopPropagation();
            smsEmojiOpen = !smsEmojiOpen;
            var panel = document.getElementById('sms-emoji-panel');
            smile.className = 'sms-emoji-btn' + (smsEmojiOpen ? ' on' : '');
            restartAnim(smile, 'press');
            if (panel) animateEmojiPanel(panel, smsEmojiOpen);
            else stickToBottom();
        });
        field.appendChild(pick);
        field.appendChild(smile);
        field.appendChild(input);
        field.appendChild(send);
        compose.appendChild(emojiPanel());
        var photoPreview = node('div', 'sms-photo-preview');
        photoPreview.id = 'sms-photo-preview';
        photoPreview.style.display = 'none';
        compose.appendChild(photoPreview);
        compose.appendChild(field);
        wrap.appendChild(compose);
        syncSmsPhotoComposer();
        smsRenderedKey = threadKey(data.messages) + '|' + (data.portraitRev || 0);
        smsShownSection = data.section || '';
        return wrap;
    }

