    // ------------------------------------------------------------------
    // Persona: how the open contact talks, edited from the chat header.
    // Only the character setting is here. The reply rules stay with the reply service.
    // ------------------------------------------------------------------
    var personaDraft = null;
    var personaRenderedKey = '';
    var personaSaving = false;
    var personaNote = null;

    function personaSection(id) { return PERSONA_SECTION + '/' + id; }

    function personaKey(data) {
        return data.contact ? String(data.contact.entity_id) + '|' + data.meId : '';
    }

    function loadPersona() {
        return Promise.all([getEnv(), getPossessedId(), getMembers(), loadPortraitIndex()]).then(function (r) {
            var meId = String(r[1]);
            var contact = null;
            var contacts = textContacts(meId, r[2]);
            for (var i = 0; i < contacts.length; i++) {
                if (String(contacts[i].entity_id) === String(smsContactId)) contact = contacts[i];
            }
            if (!contact) return { env: r[0], meId: meId, contact: null };
            var section = personaSection(contact.entity_id);
            return Promise.all([cfgValue(section, 'default'), cfgValue(section, 'profile')]).then(function (d) {
                return { env: r[0], meId: meId, contact: contact, def: d[0], profile: d[1], portraitRev: portraitRev };
            });
        });
    }

    // What the reply service would use when nothing is set.
    function personaDefaults(data) {
        var def = data.def && typeof data.def === 'object' ? data.def : {};
        var styles = def.styles && typeof def.styles === 'object' ? def.styles : {};
        var mine = styles[data.meId] && typeof styles[data.meId] === 'object' ? styles[data.meId] : null;
        return {
            known: !!mine,
            style: mine && typeof mine.text === 'string' ? mine.text : '',
            extra: typeof def.extra === 'string' ? def.extra : ''
        };
    }

    function personaSaved(data) {
        var p = data.profile && typeof data.profile === 'object' ? data.profile : {};
        var styles = p.styles && typeof p.styles === 'object' ? p.styles : {};
        return {
            style: typeof styles[data.meId] === 'string' ? styles[data.meId] : null,
            extra: typeof p.extra === 'string' ? p.extra : null
        };
    }

    function personaRenderKey(data) {
        return personaKey(data) + '|' + JSON.stringify(data.def || null) + '|' + JSON.stringify(data.profile || null) +
            '|' + (data.portraitRev || 0);
    }

    function personaDraftFor(data) {
        var key = personaKey(data);
        if (personaDraft && personaDraft.key === key && personaDraft.dirty) return personaDraft;
        var def = personaDefaults(data);
        var saved = personaSaved(data);
        personaDraft = {
            key: key,
            style: saved.style !== null ? saved.style : def.style,
            extra: saved.extra !== null ? saved.extra : def.extra,
            dirty: false
        };
        return personaDraft;
    }

    function personaCount(id, text, max) {
        var c = document.getElementById(id);
        if (c) c.textContent = String(text || '').length + ' / ' + max;
    }

    function personaSyncButtons() {
        var d = personaDraft;
        var save = document.getElementById('pe-save');
        if (save) save.className = 'ph-btn ' + (d && d.dirty && !personaSaving ? 'on' : 'off') + ' last';
        if (!d || !d.def) return;
        var rs = document.getElementById('pe-style-reset');
        if (rs) rs.className = 'pe-reset' + (d.def.known && d.style !== d.def.style ? '' : ' off');
        var re = document.getElementById('pe-extra-reset');
        if (re) re.className = 'pe-reset' + (d.extra !== d.def.extra ? '' : ' off');
    }

    function personaField(id, value, max, rows, placeholder, onInput) {
        var f = node('textarea', 'pe-text');
        f.id = id;
        applyUiFont(f);
        f.setAttribute('maxlength', String(max));
        f.setAttribute('rows', String(rows));
        f.setAttribute('spellcheck', 'false');
        f.setAttribute('placeholder', placeholder);
        f.value = value || '';
        f.addEventListener('input', function () { onInput(f.value); });
        return f;
    }

    function personaSave(data) {
        if (!personaDraft || !personaDraft.dirty || personaSaving) return;
        var draft = personaDraft;
        var id = String(data.contact.entity_id);
        var meId = data.meId;
        var def = personaDefaults(data);
        var section = personaSection(id);
        personaSaving = true;
        personaNote = null;
        personaSyncButtons();
        // Read again right before writing: the same character may have been edited while
        // playing someone else, and that setting must survive.
        cfgValue(section, 'profile').then(function (cur) {
            var next = { v: 1, at: Date.now(), extra: null, styles: {} };
            if (cur && typeof cur === 'object') {
                if (typeof cur.extra === 'string') next.extra = cur.extra;
                if (cur.styles && typeof cur.styles === 'object') {
                    for (var k in cur.styles) {
                        if (cur.styles.hasOwnProperty(k) && typeof cur.styles[k] === 'string') next.styles[k] = cur.styles[k];
                    }
                }
            }
            var style = String(draft.style || '').replace(/\r\n?/g, '\n').slice(0, PERSONA_STYLE_MAX);
            var extra = String(draft.extra || '').replace(/\r\n?/g, '\n').slice(0, PERSONA_EXTRA_MAX);
            if (def.known && style === def.style) delete next.styles[meId];
            else next.styles[meId] = style;
            next.extra = extra === def.extra ? null : extra;
            return saveJson('profile', next, section);
        }).then(function () {
            personaDraft = null;
            personaNote = { ok: true, text: 'Saved. The next reply uses it.' };
        }, function (err) {
            personaNote = { ok: false, text: 'Could not save: ' + errText(err) };
        }).then(function () {
            personaSaving = false;
            personaRenderedKey = '';
            refresh();
        });
    }

    function renderPersona(data) {
        var wrap = node('div', 'pe');
        wrap.id = 'pe-screen';
        wrap.appendChild(subHeader('persona'));
        if (!data.contact) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'This person can no longer be texted.'));
            wrap.appendChild(none);
            personaRenderedKey = '';
            return wrap;
        }
        var c = data.contact;
        var first = c.first_name || fullName(c);
        var def = personaDefaults(data);
        var draft = personaDraftFor(data);
        draft.def = def;

        var who = node('div', 'pe-who');
        who.appendChild(faceAvatar(c));
        var whoText = node('div', 'ph-who');
        whoText.appendChild(node('div', 'ph-name', fullName(c)));
        whoText.appendChild(node('div', 'ph-sub', c.relationship_label || c.age_group_text || ''));
        who.appendChild(whoText);
        wrap.appendChild(who);

        var styleCard = card('HOW ' + first.toUpperCase() + ' TALKS TO YOU');
        styleCard.appendChild(personaField('pe-style', draft.style, PERSONA_STYLE_MAX, 9,
            'Tone, words they use, how they react when scolded...', function (v) {
                draft.style = v;
                draft.dirty = true;
                personaNote = null;
                personaCount('pe-style-n', v, PERSONA_STYLE_MAX);
                personaSyncButtons();
            }));
        var styleFoot = node('div', 'pe-foot');
        var styleN = node('div', 'pe-count', String(draft.style || '').length + ' / ' + PERSONA_STYLE_MAX);
        styleN.id = 'pe-style-n';
        styleFoot.appendChild(styleN);
        var styleReset = node('button', 'pe-reset' + (def.known && draft.style !== def.style ? '' : ' off'), 'Use default');
        styleReset.id = 'pe-style-reset';
        styleReset.setAttribute('type', 'button');
        onTap(styleReset, function (e) {
            e.stopPropagation();
            if (!def.known || draft.style === def.style) return;
            draft.style = def.style;
            draft.dirty = true;
            personaNote = null;
            personaRenderedKey = '';
            settingsKeep(function () { show(renderPersona(data)); });
        });
        styleFoot.appendChild(styleReset);
        styleCard.appendChild(styleFoot);
        styleCard.appendChild(node('div', 'ai-hint', def.known
            ? (def.style ? 'Only with the person you are playing now. Leave it empty for no set style.'
                : 'There is no built-in style for this relationship. Anything you write here is used as is.')
            : 'The reply service has not shared the built-in style yet. Start it, then come back.'));
        wrap.appendChild(styleCard);

        var extraCard = card('ABOUT ' + first.toUpperCase());
        extraCard.appendChild(personaField('pe-extra', draft.extra, PERSONA_EXTRA_MAX, 5,
            'Background, habits, secrets, what they care about...', function (v) {
                draft.extra = v;
                draft.dirty = true;
                personaNote = null;
                personaCount('pe-extra-n', v, PERSONA_EXTRA_MAX);
                personaSyncButtons();
            }));
        var extraFoot = node('div', 'pe-foot');
        var extraN = node('div', 'pe-count', String(draft.extra || '').length + ' / ' + PERSONA_EXTRA_MAX);
        extraN.id = 'pe-extra-n';
        extraFoot.appendChild(extraN);
        var extraReset = node('button', 'pe-reset' + (draft.extra !== def.extra ? '' : ' off'), 'Use default');
        extraReset.id = 'pe-extra-reset';
        extraReset.setAttribute('type', 'button');
        onTap(extraReset, function (e) {
            e.stopPropagation();
            if (draft.extra === def.extra) return;
            draft.extra = def.extra;
            draft.dirty = true;
            personaNote = null;
            personaRenderedKey = '';
            settingsKeep(function () { show(renderPersona(data)); });
        });
        extraFoot.appendChild(extraReset);
        extraCard.appendChild(extraFoot);
        extraCard.appendChild(node('div', 'ai-hint', 'Used in every chat with ' + first + ', and in Moments.'));
        wrap.appendChild(extraCard);

        var actions = card();
        var btns = node('div', 'ph-btns');
        btns.style.marginTop = '0';
        var save = node('button', 'ph-btn ' + (draft.dirty && !personaSaving ? 'on' : 'off') + ' last', personaSaving ? 'Saving...' : 'Save');
        save.id = 'pe-save';
        save.setAttribute('type', 'button');
        onTap(save, function (e) {
            e.stopPropagation();
            personaSave(data);
        });
        btns.appendChild(save);
        actions.appendChild(btns);
        if (personaNote) actions.appendChild(node('div', 'ai-result ' + (personaNote.ok ? 'ok' : 'err'), personaNote.text));
        actions.appendChild(node('div', 'ai-hint', 'This changes who ' + first + ' is and how they talk. What they can do in the game, and how replies are written, stay the same.'));
        wrap.appendChild(actions);
        personaRenderedKey = personaRenderKey(data);
        return wrap;
    }

    // Redraws the open page without losing its scroll position.
    function settingsKeep(draw) {
        var top = wf.content.scrollTop;
        draw();
        wf.content.scrollTop = top;
    }

