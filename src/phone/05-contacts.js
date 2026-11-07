    // ------------------------------------------------------------------
    // Contacts: the game phone's own contact list (contacts.get_all) with how the played
    // character feels about each person (relationships.list), grouped like a phone's contacts:
    // the player's card, Family, Friends, Others. A contact's page has their job, where they
    // are and the bonds, and Message for those the phone can text (people at home old enough
    // for a phone). Faces are the game portraits the reply service copies (portraits.js).
    // ------------------------------------------------------------------
    var CT_GROUPS = [
        { id: 'family', title: 'Family' },
        { id: 'friends', title: 'Friends' },
        { id: 'others', title: 'Others' }
    ];
    var ctOpenId = null;

    function ctStat(rel, key) {
        var s = rel && rel.stats && rel.stats[key];
        return s && typeof s.value === 'number' ? s.value : 0;
    }

    function ctLevel(rel, key) {
        var s = rel && rel.stats && rel.stats[key];
        return s && typeof s.level === 'number' ? s.level : 0;
    }

    // What someone is to the played character, from the game's label and the bonds.
    function ctKind(c, rel, meHousehold) {
        var family = (rel && rel.is_family) || (meHousehold && String(c.household_id) === meHousehold && c.relationship_label && c.relationship_label !== '…');
        if (family) return { group: 'family', label: c.relationship_label && c.relationship_label !== '…' ? c.relationship_label : 'Family' };
        var romance = ctStat(rel, 'Romance');
        var friend = ctStat(rel, 'Friendship');
        var work = ctStat(rel, 'Business');
        if (romance >= 20 && romance >= friend) return { group: 'friends', label: 'Romance' };
        if (ctLevel(rel, 'Friendship') >= 2) return { group: 'friends', label: 'Close Friend' };
        if (friend >= 20) return { group: 'friends', label: 'Friend' };
        if (work >= 10 && work >= friend) return { group: 'others', label: 'Colleague' };
        return { group: 'others', label: 'Acquaintance' };
    }

    function ctCloseness(rel) {
        return Math.max(ctStat(rel, 'Friendship'), ctStat(rel, 'Romance'), ctStat(rel, 'Family'), ctStat(rel, 'Business'));
    }

    function loadContacts() {
        var env, me;
        return Promise.all([getEnv(), getPossessedId(), soft(getMembers()), loadPortraitIndex()]).then(function (r) {
            env = r[0];
            me = r[1];
            var members = r[2] && !r[2].error ? r[2] : [];
            return Promise.all([
                soft(call('contacts.get_all', {}, 'contacts')),
                soft(call('relationships.list', { owner_id: me }, 'relationships')),
                Promise.resolve(members)
            ]);
        }).then(function (r) {
            var list = r[0] && !r[0].error && Array.isArray(r[0].contacts) ? r[0].contacts : null;
            var rels = {};
            (r[1] && !r[1].error && Array.isArray(r[1].relationships) ? r[1].relationships : []).forEach(function (x) { rels[String(x.target_id)] = x; });
            var members = r[2];
            var self = null;
            members.forEach(function (m) { if (String(m.entity_id) === me) self = m; });
            var meHousehold = self && self.household_id !== undefined ? String(self.household_id) : '';
            var people = (list || []).filter(function (c) { return String(c.entity_id) !== me; }).map(function (c) {
                var id = String(c.entity_id);
                var rel = rels[id] || null;
                var kind = ctKind(c, rel, meHousehold);
                var home = meHousehold && String(c.household_id) === meHousehold;
                return {
                    id: id, c: c, rel: rel, group: kind.group, label: kind.label, closeness: ctCloseness(rel), home: !!home,
                    // Anyone old enough for a phone; the played character too.
                    textable: !NO_PHONE_STEPS[c.age_group] && !(self && NO_PHONE_STEPS[self.age_group])
                };
            });
            people.sort(function (a, b) { return b.closeness - a.closeness || fullName(a.c).localeCompare(fullName(b.c)); });
            return { env: env, me: me, self: self, people: people, failed: !list };
        });
    }

    function ctRow(p) {
        var row = node('div', 'ct-row');
        row.appendChild(faceAvatar(p.c));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', fullName(p.c)));
        joinWithDots(who.appendChild(node('div', 'ph-sub')), [p.label, p.c.job_name || p.c.age_group_text]);
        row.appendChild(who);
        row.appendChild(node('div', 'ct-chev', '›'));
        onTap(row, function (e) {
            e.stopPropagation();
            ctOpenId = p.id;
            open('contact');
        });
        return row;
    }

    function renderContacts(data) {
        var wrap = node('div', 'ct-screen');
        wrap.appendChild(subHeader('contacts'));
        if (data.self) {
            var mine = node('div', 'ph-card ct-me');
            var line = node('div', 'ph-row');
            var face = faceAvatar(data.self);
            face.className += ' ct-avatar-md';
            line.appendChild(face);
            var who = node('div', 'ph-who');
            who.appendChild(node('div', 'ct-me-name', fullName(data.self)));
            who.appendChild(node('div', 'ph-sub', 'My Card'));
            line.appendChild(who);
            mine.appendChild(line);
            wrap.appendChild(mine);
        }
        if (data.failed) {
            var bad = card();
            bad.appendChild(node('div', 'ph-empty', 'The contact list could not be read from the game.'));
            wrap.appendChild(bad);
            return wrap;
        }
        if (!data.people.length) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'No contacts yet. Meet people in town and they show up here.'));
            wrap.appendChild(none);
            return wrap;
        }
        CT_GROUPS.forEach(function (g) {
            var rows = data.people.filter(function (p) { return p.group === g.id; });
            if (!rows.length) return;
            var head = node('div', 'ct-sec');
            head.appendChild(node('span', null, g.title));
            head.appendChild(node('span', 'ct-sec-count', String(rows.length)));
            wrap.appendChild(head);
            var list = node('div', 'ph-card ct-list');
            rows.forEach(function (p) { list.appendChild(ctRow(p)); });
            wrap.appendChild(list);
        });
        wrap.appendChild(node('div', 'ph-caption ct-foot', data.people.length + ' contacts, from your phone in the game'));
        return wrap;
    }

    function ctInfo(label, value) {
        var row = node('div', 'ct-info-row');
        row.appendChild(node('div', 'ct-info-label', label));
        row.appendChild(node('div', 'ct-info-value', value));
        return row;
    }

    function renderContact(data) {
        var p = null;
        data.people.forEach(function (x) { if (x.id === ctOpenId) p = x; });
        var wrap = node('div', 'ct-screen');
        wrap.appendChild(subHeader('contact', 'Contact'));
        if (!p) {
            var gone = card();
            gone.appendChild(node('div', 'ph-empty', 'This person is no longer in your contacts.'));
            wrap.appendChild(gone);
            return wrap;
        }
        var c = p.c;
        var hero = node('div', 'ct-hero');
        var face = faceAvatar(c);
        face.className += ' ct-avatar-lg';
        hero.appendChild(face);
        hero.appendChild(node('div', 'ct-hero-name', fullName(c)));
        joinWithDots(hero.appendChild(node('div', 'ct-hero-sub')), [p.label, c.age_group_text, c.gender_text]);
        var acts = node('div', 'ct-actions');
        var msg = node('div', 'ct-act' + (p.textable ? '' : ' off'));
        msg.appendChild(node('div', 'ct-act-icon', '✉'));
        msg.appendChild(node('div', 'ct-act-label', 'Message'));
        if (p.textable) {
            onTap(msg, function (e) {
                e.stopPropagation();
                // Someone outside the household joins Texts the first time they are messaged.
                var go = function () {
                    smsContactId = p.id;
                    open('chat');
                };
                if (p.home) go();
                else addOutside(data.me, c, p.label).then(go, go);
            });
        }
        acts.appendChild(msg);
        hero.appendChild(acts);
        if (!p.textable) hero.appendChild(node('div', 'ct-note', 'Too young for a phone.'));
        else if (!p.home) hero.appendChild(node('div', 'ct-note', 'They answer in their own words; they live their own life in the game.'));
        wrap.appendChild(hero);

        var info = node('div', 'ph-card ct-info');
        if (c.job_name) info.appendChild(ctInfo('Work', c.job_name + (c.job_rank_name ? ' · ' + c.job_rank_name : '')));
        else if (c.has_career === false && c.employable) info.appendChild(ctInfo('Work', 'No job right now'));
        info.appendChild(ctInfo('Where', c.current_site || 'Somewhere in town'));
        info.appendChild(ctInfo('Home', p.home ? 'Lives with you' : 'Lives elsewhere'));
        if (c.is_married) info.appendChild(ctInfo('Married', 'Yes'));
        wrap.appendChild(info);

        if (p.rel && p.rel.stats) {
            var bonds = card('HOW YOU FEEL');
            BONDS.forEach(function (b) {
                var s = p.rel.stats[b.key];
                if (!s || typeof s.value !== 'number') return;
                var item = node('div', 'ph-bond');
                var top = node('div', 'ph-bond-top');
                top.appendChild(node('span', null, b.label));
                top.appendChild(node('span', 'ph-need-val', String(Math.round(s.value))));
                item.appendChild(top);
                item.appendChild(bar(s.value, b.color));
                bonds.appendChild(item);
            });
            wrap.appendChild(bonds);
        }
        return wrap;
    }

    function contactsGlyph() {
        var svg = glyphSvg('0 0 24 24');
        glyphPath(svg, 'M12 4.2a3.9 3.9 0 1 1 0 7.8 3.9 3.9 0 0 1 0-7.8zM4.6 19.6c.5-3.6 3.6-5.9 7.4-5.9s6.9 2.3 7.4 5.9c.1.5-.3.9-.8.9H5.4c-.5 0-.9-.4-.8-.9z');
        return svg;
    }

