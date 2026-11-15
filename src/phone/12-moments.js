    // ------------------------------------------------------------------
    // Moments. feed.cfg is written by the reply service; this phone only appends the
    // played character's actions to its own outbox and shows them until they are merged.
    // ------------------------------------------------------------------
    function momentsViewerSection(meId) { return MOMENTS_SECTION + '/' + meId; }

    function cfgValue(section, key) {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: section, key: key }, 'value')
            .then(function (r) { return parseJson(r.value); }, function () { return null; });
    }

    function loadPortraitIndex() {
        return cachedRead('portraits', 4000, function () {
            return cfgValue(PORTRAIT_SECTION, 'index').then(function (v) {
                portraitIndex = v && v.files && typeof v.files === 'object' ? v.files : {};
                portraitRev = v && typeof v.updatedAt === 'number' ? v.updatedAt : 0;
                return portraitRev;
            }, function () {
                portraitIndex = {};
                portraitRev = 0;
                return 0;
            });
        });
    }

    // The last readable feed is kept, so a read that races the service's save shows old data
    // for one refresh instead of an empty page.
    function loadFeed() {
        return cfgValue(MOMENTS_SECTION, 'feed').then(function (v) {
            if (v && typeof v === 'object' && Array.isArray(v.posts)) momentsFeed = v;
            return momentsFeed;
        });
    }

    function cleanActions(raw) {
        if (!Array.isArray(raw)) return [];
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var a = raw[i];
            if (a && typeof a.id === 'string' && typeof a.kind === 'string' && typeof a.at === 'number') out.push(a);
        }
        return out;
    }

    function loadMomentsOutbox(meId) {
        return cfgValue(momentsViewerSection(meId), 'outbox').then(cleanActions);
    }

    function loadMomentsSeen(meId) {
        return cfgValue(momentsViewerSection(meId), 'seen').then(function (v) {
            return v && typeof v.at === 'number' ? v.at : 0;
        });
    }

    function copyPost(p) {
        var likes = [];
        var comments = [];
        var i;
        for (i = 0; i < (p.likes || []).length; i++) likes.push(p.likes[i]);
        for (i = 0; i < (p.comments || []).length; i++) comments.push(p.comments[i]);
        return {
            id: p.id, authorId: String(p.authorId), authorName: p.authorName || '', authorFirst: p.authorFirst || '',
            at: p.at, place: p.place || '', text: p.text, likes: likes, comments: comments, pending: !!p.pending,
            game: smsGameClean(p.game), gameTime: p.gameTime || '', image: smsImageClean(p.image)
        };
    }

    function findById(list, id) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return list[i];
        }
        return null;
    }

    // Mirrors Moments.apply() in the reply service, so an action looks the same before and
    // after it has been merged into the feed.
    function applyPending(posts, me, a) {
        var post;
        var i;
        if (a.kind === 'post') {
            posts.push({ id: 'u-' + a.id, authorId: me.id, authorName: me.name, authorFirst: me.first, at: a.at, place: a.place || '', text: a.text || '', likes: [], comments: [], pending: true, game: smsGameClean(a.game), image: smsImageClean(a.image) });
            return;
        }
        post = findById(posts, String(a.postId));
        if (!post) return;
        if (a.kind === 'like') {
            var has = false;
            for (i = 0; i < post.likes.length; i++) if (String(post.likes[i].id) === me.id) has = true;
            if (!has) post.likes.push({ id: me.id, name: me.name, at: a.at, pending: true });
        } else if (a.kind === 'unlike') {
            post.likes = post.likes.filter(function (l) { return String(l.id) !== me.id; });
        } else if (a.kind === 'delete') {
            if (post.authorId === me.id) {
                for (i = 0; i < posts.length; i++) {
                    if (posts[i] === post) { posts.splice(i, 1); break; }
                }
            }
        } else if (a.kind === 'comment') {
            var c = { id: 'u-' + a.id, authorId: me.id, authorName: me.name, text: a.text || '', at: a.at, pending: true };
            var target = a.replyToCommentId ? findById(post.comments, String(a.replyToCommentId)) : null;
            if (target && String(target.authorId) !== me.id) c.replyTo = { id: String(target.authorId), name: target.authorName, commentId: target.id };
            post.comments.push(c);
        }
    }

    // What the played character can see: posts, likes and comments of people it knows.
    function momentsView(feed, outbox, me) {
        var f = feed || { posts: [], circles: {}, applied: {} };
        var circleRow = f.circles ? f.circles[me.id] : null;
        var known = {};
        var names = {};
        var i;
        if (circleRow && circleRow.ids) {
            for (i = 0; i < circleRow.ids.length; i++) known[String(circleRow.ids[i])] = true;
            names = circleRow.names || {};
        }
        known[me.id] = true;
        var posts = [];
        for (i = 0; i < (f.posts || []).length; i++) posts.push(copyPost(f.posts[i]));
        var applied = {};
        var done = f.applied && f.applied[me.id] ? f.applied[me.id] : [];
        for (i = 0; i < done.length; i++) applied[done[i]] = true;
        var pending = outbox.filter(function (a) { return !applied[a.id]; }).sort(function (a, b) { return a.at - b.at; });
        for (i = 0; i < pending.length; i++) applyPending(posts, me, pending[i]);
        var visible = [];
        for (i = 0; i < posts.length; i++) {
            var p = posts[i];
            if (!known[p.authorId]) continue;
            p.likes = p.likes.filter(function (l) { return known[String(l.id)]; });
            p.comments = p.comments.filter(function (c) { return known[String(c.authorId)]; });
            visible.push(p);
        }
        visible.sort(function (a, b) { return b.at - a.at; });
        return { posts: visible, circleKnown: !!circleRow, names: names, pending: pending.length };
    }

    // Things meant for the viewer since seenAt: friends' posts, and likes, comments and replies
    // on the viewer's own posts or comments.
    function momentsNews(view, meId, seenAt) {
        var n = 0;
        var newest = 0;
        for (var i = 0; i < view.posts.length; i++) {
            var p = view.posts[i];
            var mine = p.authorId === meId;
            if (p.at > newest) newest = p.at;
            if (!mine && p.at > seenAt) n += 1;
            var j;
            for (j = 0; j < p.likes.length; j++) {
                var l = p.likes[j];
                if (typeof l.at === 'number' && l.at > newest) newest = l.at;
                if (mine && String(l.id) !== meId && l.at > seenAt) n += 1;
            }
            for (j = 0; j < p.comments.length; j++) {
                var c = p.comments[j];
                if (c.at > newest) newest = c.at;
                if (String(c.authorId) === meId || c.at <= seenAt) continue;
                if (mine || (c.replyTo && String(c.replyTo.id) === meId)) n += 1;
            }
        }
        return { count: n, newest: newest };
    }

    function momentsMe(meId, members) {
        var m = memberById(members, meId);
        if (m) return Promise.resolve({ id: meId, name: fullName(m), first: m.first_name || '' });
        return soft(call('entity.get_character_info', { entity_id: meId }, 'entity_id')).then(function (info) {
            var ok = info && !info.error;
            return { id: meId, name: ok ? fullName(info) : '#' + meId, first: ok ? info.first_name || '' : '' };
        });
    }

    function momentsUnread(meId) {
        return Promise.all([loadFeed(), loadMomentsOutbox(meId), loadMomentsSeen(meId)]).then(function (d) {
            if (!d[0]) return 0;
            var view = momentsView(d[0], d[1], { id: meId, name: '', first: '' });
            return momentsNews(view, meId, d[2]).count;
        }, function () { return 0; });
    }

    function momentsKey(view, status) {
        var parts = [view.circleKnown ? 'c' : 'n', momentsPresence(status).cls];
        for (var i = 0; i < view.posts.length; i++) {
            var p = view.posts[i];
            var s = p.id + (p.pending ? '*' : '') + (p.image ? '#' + p.image.id : '') + ':' + p.likes.length;
            for (var j = 0; j < p.likes.length; j++) s += ',' + p.likes[j].id;
            for (j = 0; j < p.comments.length; j++) s += ';' + p.comments[j].id + (p.comments[j].pending ? '*' : '');
            parts.push(s);
        }
        return parts.join('|');
    }

    function momentsPresence(status) {
        if (!status || typeof status.heartbeat !== 'number' || Date.now() - status.heartbeat > BRIDGE_STALE_MS) {
            return { cls: 'off', text: 'Reply service offline: friends cannot post or answer right now.' };
        }
        if (status.state === 'paused' || status.state === 'offline') return { cls: 'off', text: status.error || 'Paused' };
        if (status.state === 'error') return { cls: 'err', text: status.error || 'Reply service error' };
        return { cls: 'on', text: '' };
    }

    function loadMoments() {
        return Promise.all([getEnv(), getPossessedId(), soft(getMembers()), loadPortraitIndex(), loadEmojiSet()]).then(function (r) {
            var meId = String(r[1]);
            var members = r[2] && !r[2].error ? r[2] : [];
            return Promise.all([
                momentsMe(meId, members), loadFeed(), loadMomentsOutbox(meId), loadMomentsSeen(meId),
                cfgValue(MOMENTS_SECTION, 'status')
            ]).then(function (d) {
                var me = d[0];
                var view = momentsView(d[1], d[2], me);
                var news = momentsNews(view, meId, d[3]);
                var seenP = news.newest > d[3]
                    ? saveJson('seen', { at: news.newest }, momentsViewerSection(meId)).then(function () {}, function () {})
                    : Promise.resolve();
                return seenP.then(function () {
                    return { env: r[0], me: me, view: view, status: d[4], key: meId + '|' + momentsKey(view, d[4]), portraitRev: r[3] || 0 };
                });
            });
        });
    }

    function sendMomentsAction(me, action, done) {
        if (momentsSending) return;
        momentsSending = true;
        action.id = 'a-' + Date.now() + '-' + (momentsSeq += 1);
        action.at = Date.now();
        action.name = me.name;
        action.first = me.first;
        var section = momentsViewerSection(me.id);
        // The game clock when the player acted, so the feed can show it in game time.
        Promise.all([loadMomentsOutbox(me.id), soft(getEnv())]).then(function (r) {
            var list = r[0];
            var game = smsGameOf(r[1]);
            if (game) action.game = game;
            list.push(action);
            if (list.length > MOMENTS_KEEP) list = list.slice(list.length - MOMENTS_KEEP);
            return saveJson('outbox', list, section);
        }).then(function () {
            if (action.kind === 'post' || action.kind === 'comment') soundPlay('sent');
            if (done) done();
            momentsRenderedKey = '';
            setNote('', false);
            refresh();
        }, function (err) {
            setNote(errText(err), true);
        }).then(function () {
            momentsSending = false;
        });
    }

    function rememberMoments() {
        var post = document.getElementById('mo-post');
        var reply = document.getElementById('mo-reply');
        var place = document.getElementById('mo-place');
        if (refreshDropping) {
            momentsPostDraft = '';
            momentsDraft = '';
            momentsPlaceDraft = '';
            momentsFocus = null;
            return;
        }
        if (post) momentsPostDraft = post.value;
        if (place) momentsPlaceDraft = place.value;
        if (reply) momentsDraft = reply.value;
        if (momentsFocusPending) return;
        momentsFocus = document.activeElement === post ? 'post' : document.activeElement === reply ? 'reply' : null;
    }

    function restoreMoments() {
        // The deck can only measure itself once it is on the page; a page still being laid out
        // is tried again on the next frames.
        var tries = 0;
        (function lay() {
            if (moDeck && !(moAdopt() && moLayout()) && ++tries < 20) nextFrame(lay);
        })();
        var id = momentsFocus === 'post' ? 'mo-post' : momentsFocus === 'reply' ? 'mo-reply' : '';
        var target = id ? document.getElementById(id) : null;
        var pending = momentsFocusPending;
        momentsFocusPending = false;
        momentsFocus = null;
        if (!target || !pending) return;
        try {
            target.focus();
            var len = target.value.length;
            if (target.setSelectionRange) target.setSelectionRange(len, len);
        } catch (e0) {}
    }

    var MO_HEART = 'M12 20.4s-6.6-4-8.8-7.7C1.5 9.6 2.2 6.2 4.9 5.1c1.8-.7 3.7-.1 4.9 1.6L12 8.8l2.2-2.1c1.2-1.7 3.1-2.3 4.9-1.6 2.7 1.1 3.4 4.5 1.7 7.6-2.2 3.7-8.8 7.7-8.8 7.7z';
    var MO_HEART_LINE = 'M12 20.4s-6.6-4-8.8-7.7C1.5 9.6 2.2 6.2 4.9 5.1c1.8-.7 3.7-.1 4.9 1.6L12 8.8l2.2-2.1c1.2-1.7 3.1-2.3 4.9-1.6 2.7 1.1 3.4 4.5 1.7 7.6-2.2 3.7-8.8 7.7-8.8 7.7zm0-2.3c1.9-1.2 5.3-3.7 6.9-6.3 1.2-2.1.8-4.4-.9-5.1-1.1-.4-2.3 0-3.1 1.1L12 10.9 9.1 7.8C8.3 6.7 7.1 6.3 6 6.7c-1.7.7-2.1 3-.9 5.1 1.6 2.6 5 5.1 6.9 6.3z';
    var MO_BUBBLE = 'M12 3.6c-4.9 0-8.8 3.4-8.8 7.7 0 2 .9 3.9 2.4 5.3l-.8 3.3c-.1.4.3.7.7.5l3.4-1.7c1 .3 2 .4 3.1.4 4.9 0 8.8-3.4 8.8-7.7S16.9 3.6 12 3.6zm0 13.7c-1 0-1.9-.1-2.8-.4l-.4-.1-2.1 1 .5-2-.4-.4c-1.4-1.1-2.2-2.6-2.2-4.2 0-3.3 3.3-6 7.3-6s7.3 2.7 7.3 6-3.2 6.1-7.2 6.1z';
    var MO_PIN = 'M12 2.2c-3.5 0-6.3 2.8-6.3 6.3 0 4.7 6.3 12.8 6.3 12.8s6.3-8.1 6.3-12.8c0-3.5-2.8-6.3-6.3-6.3zm0 8.6c-1.3 0-2.3-1-2.3-2.3s1-2.3 2.3-2.3 2.3 1 2.3 2.3-1 2.3-2.3 2.3z';
    var MO_PLUS = 'M11 4.5h2v6.5h6.5v2H13v6.5h-2V13H4.5v-2H11V4.5z';
    var MO_LEFT = 'M14.8 5.2l1.6 1.6-5.2 5.2 5.2 5.2-1.6 1.6L8 12l6.8-6.8z';
    var MO_RIGHT = 'M9.2 5.2L16 12l-6.8 6.8-1.6-1.6 5.2-5.2-5.2-5.2 1.6-1.6z';
    var MO_PHOTO = 'M4.5 5h15c.8 0 1.5.7 1.5 1.5v11c0 .8-.7 1.5-1.5 1.5h-15c-.8 0-1.5-.7-1.5-1.5v-11C3 5.7 3.7 5 4.5 5zm.3 1.8v8.6l3.9-4.1c.4-.4 1-.4 1.4 0l2.4 2.5 1.6-1.6c.4-.4 1-.4 1.4 0l3.7 3.8V6.8H4.8zM15.6 8.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2z';

    function moIcon(d, extra, fill) {
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'mi-ico' + (extra ? ' ' + extra : ''));
        glyphPath(svg, d, fill || 'currentColor', 'evenodd');
        return svg;
    }

    function momentsPerson(first, name, id) {
        return faceAvatar({ first_name: first || '', name: name || '', entity_id: id });
    }

    // An avatar inside the warm gradient ring the feed draws around people.
    function moRing(first, name, id, cls) {
        var ring = node('div', 'mi-ring' + (cls ? ' ' + cls : ''));
        var gap = ring.appendChild(node('div', 'mi-ring-gap'));
        gap.appendChild(momentsPerson(first, name, id));
        return ring;
    }

    function momentsInput(id, cls, placeholder, value, max) {
        var t = node('textarea', cls);
        t.id = id;
        applyUiFont(t);
        t.setAttribute('maxlength', String(max));
        t.setAttribute('placeholder', placeholder);
        t.value = value || '';
        return t;
    }

    // A tap that does nothing right after a swipe of the cards (the mouse up of a drag clicks).
    function moTap(elm, fn, options) {
        return onTap(elm, function (e) {
            e.stopPropagation();
            if (Date.now() - moDraggedAt < 350) return;
            fn(e);
        }, options);
    }

    function momentsButton(text, cls, onClick) {
        var b = node('button', cls, text);
        b.setAttribute('type', 'button');
        moTap(b, function () { onClick(); });
        return b;
    }

    function openComposer() {
        momentsComposeOpen = true;
        momentsMenuPost = null;
        momentsConfirmDelete = null;
        momentsFocus = 'post';
        momentsFocusPending = true;
        momentsRenderedKey = '';
        refresh();
    }

    function closeComposer() {
        momentsComposeOpen = false;
        momentsFocus = null;
        momentsEmojiFor = null;
        momentsRenderedKey = '';
        refresh();
    }

    function toggleMenu(postId) {
        if (momentsMenuPost === postId) {
            momentsMenuPost = null;
            momentsConfirmDelete = null;
        } else {
            momentsMenuPost = postId;
            momentsConfirmDelete = null;
            if (momentsComposer && momentsComposer.postId === postId) {
                momentsComposer = null;
                momentsDraft = '';
                momentsFocus = null;
            }
        }
        momentsRenderedKey = '';
        refresh();
    }

    // Emoji for the Moments text boxes: [name] tokens like in Texts. momentsEmojiFor says which
    // box ('post' or 'reply') has its panel open; momentsCaret where each box's caret was.
    var momentsEmojiFor = null;
    var momentsCaret = {};

    function moFieldId(key) { return key === 'post' ? 'mo-post' : 'mo-reply'; }

    function moTrackCaret(input, key) {
        var keep = function () { momentsCaret[key] = input.selectionEnd; };
        input.addEventListener('keyup', keep);
        input.addEventListener('mouseup', keep);
        input.addEventListener('input', keep);
    }

    function moInsertEmoji(key, name, max, onChange) {
        var input = document.getElementById(moFieldId(key));
        if (!input) return;
        var token = '[' + name + ']';
        var value = input.value;
        if (value.length + token.length > max) return;
        var at = typeof momentsCaret[key] === 'number' && momentsCaret[key] <= value.length ? momentsCaret[key] : value.length;
        input.value = value.slice(0, at) + token + value.slice(at);
        momentsCaret[key] = at + token.length;
        onChange(input.value);
    }

    function moEmojiButton(key) {
        var b = node('button', 'mo-emoji-btn' + (momentsEmojiFor === key ? ' on' : ''));
        b.setAttribute('type', 'button');
        b.setAttribute('title', L('Emoji'));
        if (emojiSet) b.appendChild(emojiImg(emojiSet.byName['微笑'] || emojiSet.list[0].id, ''));
        else b.style.display = 'none';
        moTap(b, function () {
            momentsEmojiFor = momentsEmojiFor === key ? null : key;
            var panel = document.getElementById('mo-emoji-' + key);
            if (panel) panel.style.display = momentsEmojiFor === key ? '' : 'none';
            b.className = 'mo-emoji-btn' + (momentsEmojiFor === key ? ' on' : '');
        });
        return b;
    }

    function moEmojiPanel(key, max, onChange) {
        var panel = node('div', 'sms-emoji-panel mo-emoji-panel');
        panel.id = 'mo-emoji-' + key;
        if (momentsEmojiFor !== key) panel.style.display = 'none';
        (emojiSet ? emojiSet.list : []).forEach(function (e) {
            var cell = node('div', 'sms-emoji-pick');
            cell.setAttribute('title', e.name);
            cell.appendChild(emojiImg(e.id, e.name));
            onTap(cell, function (ev) {
                ev.stopPropagation();
                moInsertEmoji(key, e.name, max, onChange);
            }, { silent: true });
            panel.appendChild(cell);
        });
        return panel;
    }

    // ---------- A photo for a new post ----------
    // Picked on this PC through AI Phone Service, the same way as a photo in Texts: the answer
    // lands in the phone's media folder as { id, width, height }. Only one picker at a time across
    // the phone (Texts, wallpaper, the AI page share the service's request slot).
    var moPhoto = null;
    var moPhotoPending = null;
    var moPhotoWatching = false;
    var momentsPlaceDraft = '';

    function pickMomentsPhoto() {
        if (moPhotoPending || smsPhotoPending) {
            setNote(L('Finish choosing the photo on the PC first.'), false);
            return;
        }
        if (aiPending || wallPending) {
            setNote(L('Another phone service request is still running. Try again in a moment.'), false);
            return;
        }
        loadAiService().then(function (v) {
            aiService = v && typeof v === 'object' ? v : null;
            if (!aiAlive(aiService)) {
                setNote(L('Adding photos needs AI Phone Service running on this PC.'), true);
                return;
            }
            if (!aiTakesRequests(aiService)) {
                setNote(L(AI_NO_GUARDIAN), true);
                return;
            }
            var id = 'm' + Date.now() + '-' + (momentsSeq += 1);
            moPhotoPending = { id: id, at: Date.now() };
            momentsRenderedKey = '';
            refresh();
            saveJson('request', { id: id, type: 'photo_pick' }, AI_SECTION).then(function () {
                moPhotoWatch();
            }, function (err) {
                moPhotoPending = null;
                momentsRenderedKey = '';
                refresh();
                setNote(L('Could not open the photo picker: {why}', { why: errText(err) }), true);
            });
        }, function (err) {
            setNote(L('Could not reach AI Phone Service: {why}', { why: errText(err) }), true);
        });
    }

    function moPhotoWatch() {
        if (moPhotoWatching) return;
        moPhotoWatching = true;
        var step = function () {
            if (!moPhotoPending) { moPhotoWatching = false; return; }
            loadAiService().then(function (v) {
                if (v && typeof v === 'object') aiService = v;
                moPhotoCheckAnswer();
            }).then(null, function () {}).then(function () {
                if (moPhotoPending) setTimeout(step, SMS_PHOTO_WATCH_MS);
                else moPhotoWatching = false;
            });
        };
        setTimeout(step, SMS_PHOTO_WATCH_MS);
    }

    function moPhotoCheckAnswer() {
        var asked = moPhotoPending;
        if (!asked) return;
        var r = aiService && aiService.reply && typeof aiService.reply === 'object' ? aiService.reply : null;
        if (!r || r.id !== asked.id || r.pending) {
            if (Date.now() - asked.at > SMS_PHOTO_PICK_MS) {
                moPhotoPending = null;
                setNote(L('No answer from AI Phone Service. Check that it is running on this PC.'), true);
                momentsRenderedKey = '';
                if (current === 'moments') refresh();
            }
            return;
        }
        moPhotoPending = null;
        var item = r.ok ? smsImageClean(r.item) : null;
        if (item) moPhoto = item;
        else if (r.code !== 'cancelled') setNote(String(r.message || L('That photo could not be added.')), true);
        momentsRenderedKey = '';
        if (current === 'moments') refresh();
    }

    // ---------- The composer: a page of its own, like a new post on Instagram ----------
    function renderComposer(data) {
        var me = data.me;
        var page = node('div', 'mi-new');
        var head = node('div', 'mi-new-head');
        head.appendChild(momentsButton(L('Cancel'), 'mi-new-cancel', function () { closeComposer(); }));
        head.appendChild(node('div', 'mi-new-title', L('New post')));
        var postBtn = momentsButton(L('Share'), 'mi-new-share off', function () {
            var input = document.getElementById('mo-post');
            var place = document.getElementById('mo-place');
            var text = String(input ? input.value : momentsPostDraft || '').replace(/^\s+|\s+$/g, '');
            if (!text && !moPhoto) return;
            if (moPhotoPending) {
                setNote(L('Finish choosing the photo on the PC first.'), false);
                return;
            }
            if (text.length > MOMENTS_POST_MAX) {
                setNote(L('Keep it under {n} characters.', { n: MOMENTS_POST_MAX }), true);
                return;
            }
            var action = { kind: 'post', text: text };
            if (moPhoto) action.image = moPhoto;
            var where = String(place ? place.value : momentsPlaceDraft || '').replace(/^\s+|\s+$/g, '');
            if (where) action.place = where.slice(0, 30);
            sendMomentsAction(me, action, function () {
                momentsPostDraft = '';
                momentsPlaceDraft = '';
                moPhoto = null;
                momentsComposeOpen = false;
                momentsEmojiFor = null;
                momentsFocus = null;
                momentsAt = null;
            });
        });
        head.appendChild(postBtn);
        page.appendChild(head);

        var body = node('div', 'mi-new-body');
        var who = node('div', 'mi-new-who');
        who.appendChild(moRing(me.first, me.name, me.id, 'small'));
        var whoText = who.appendChild(node('div', 'mi-new-who-text'));
        whoText.appendChild(node('div', 'mi-new-name', me.name || L('You')));
        whoText.appendChild(node('div', 'mi-new-aud', L('Friends who know you can see this.')));
        body.appendChild(who);

        // The photo: a picked one with a way to drop it, the picker waiting, or a tile to add one.
        var slot = node('div', 'mi-new-photo' + (moPhoto ? ' has' : ''));
        if (moPhoto) {
            var pic = slot.appendChild(node('div', 'mi-new-pic'));
            pic.style.backgroundImage = 'url(media/' + moPhoto.id + '.jpg)';
            var ratio = Math.max(0.6, Math.min(1.25, moPhoto.height / moPhoto.width));
            pic.style.paddingTop = Math.round(ratio * 100) + '%';
            var x = pic.appendChild(node('button', 'mi-new-pic-x', '×'));
            x.setAttribute('type', 'button');
            x.setAttribute('title', L('Remove photo'));
            moTap(x, function () {
                moPhoto = null;
                momentsRenderedKey = '';
                refresh();
            });
        } else if (moPhotoPending) {
            var wait = slot.appendChild(node('div', 'mi-new-add wait'));
            wait.appendChild(node('div', 'mi-new-spin'));
            wait.appendChild(node('div', 'mi-new-add-text', L('Choose a photo on your PC. If covered by the game, press Alt+Tab.')));
        } else {
            var add = slot.appendChild(node('div', 'mi-new-add'));
            add.appendChild(moIcon(MO_PHOTO, 'mi-new-add-ico'));
            add.appendChild(node('div', 'mi-new-add-text', L('Add a photo')));
            moTap(add, function () { pickMomentsPhoto(); });
        }
        body.appendChild(slot);

        var input = momentsInput('mo-post', 'mi-new-input', L('Write a caption…'), momentsPostDraft, MOMENTS_POST_MAX);
        moTrackCaret(input, 'post');
        body.appendChild(input);

        var place = node('div', 'mi-new-place');
        place.appendChild(moIcon(MO_PIN, 'mi-new-place-ico'));
        var where = node('input', 'mi-new-place-input');
        where.id = 'mo-place';
        applyUiFont(where);
        where.setAttribute('maxlength', '30');
        where.setAttribute('placeholder', L('Add location (optional)'));
        where.value = momentsPlaceDraft || '';
        where.addEventListener('input', function () { momentsPlaceDraft = where.value; });
        place.appendChild(where);
        body.appendChild(place);

        var tools = node('div', 'mi-new-tools');
        tools.appendChild(moEmojiButton('post'));
        var count = tools.appendChild(node('div', 'mi-new-count'));
        body.appendChild(tools);
        var sync = function () {
            var n = String(input.value || '').length;
            count.textContent = n ? n + ' / ' + MOMENTS_POST_MAX : '';
            postBtn.className = (n || moPhoto) && !moPhotoPending ? 'mi-new-share' : 'mi-new-share off';
        };
        var changed = function (value) {
            momentsPostDraft = value;
            sync();
        };
        input.addEventListener('input', function () { changed(input.value); });
        sync();
        body.appendChild(moEmojiPanel('post', MOMENTS_POST_MAX, changed));
        page.appendChild(body);
        return page;
    }

    function openReply(postId, comment) {
        momentsMenuPost = null;
        momentsConfirmDelete = null;
        momentsComposer = {
            postId: postId,
            commentId: comment ? comment.id : null,
            name: comment ? comment.authorName : null
        };
        momentsAt = postId;
        momentsDraft = '';
        momentsFocus = 'reply';
        momentsFocusPending = true;
        momentsRenderedKey = '';
        refresh();
    }

    function closeReply() {
        momentsComposer = null;
        momentsDraft = '';
        momentsFocus = null;
        momentsRenderedKey = '';
        refresh();
    }

    function renderReplyBox(data, post) {
        var box = node('div', 'mi-reply');
        if (momentsComposer.name) box.appendChild(node('div', 'mi-reply-to', L('Replying to {name}', { name: momentsComposer.name })));
        var row = node('div', 'mi-reply-row');
        row.appendChild(momentsPerson(data.me.first, data.me.name, data.me.id));
        var input = momentsInput('mo-reply', 'mi-reply-input', momentsComposer.name ? L('Write a reply…') : L('Add a comment…'), momentsDraft, MOMENTS_COMMENT_MAX);
        moTrackCaret(input, 'reply');
        var send = function () {
            var text = String(input.value || '').replace(/^\s+|\s+$/g, '');
            if (!text) return;
            sendMomentsAction(data.me, { kind: 'comment', postId: post.id, text: text, replyToCommentId: momentsComposer.commentId }, function () {
                momentsComposer = null;
                momentsDraft = '';
                momentsEmojiFor = null;
                momentsFocus = null;
                momentsOpenComments[post.id] = true;
            });
        };
        input.addEventListener('input', function () { momentsDraft = input.value; });
        input.addEventListener('keydown', function (e) {
            if (e.keyCode === 13 && !e.shiftKey && !e.isComposing) {
                if (e.preventDefault) e.preventDefault();
                send();
            } else if (e.keyCode === 27) {
                momentsEmojiFor = null;
                closeReply();
            }
        });
        row.appendChild(input);
        row.appendChild(moEmojiButton('reply'));
        row.appendChild(momentsButton(L('Post'), 'mi-reply-send', send));
        box.appendChild(row);
        box.appendChild(moEmojiPanel('reply', MOMENTS_COMMENT_MAX, function (value) { momentsDraft = value; }));
        box.appendChild(momentsButton(L('Cancel'), 'mi-reply-cancel', function () {
            momentsEmojiFor = null;
            closeReply();
        }));
        return box;
    }

    function likeName(data, like) {
        var me = data.me;
        if (String(like.id) === me.id) return me.name;
        return like.name || data.view.names[String(like.id)] || ('#' + like.id);
    }

    function renderMomentsEmpty(known) {
        var box = node('div', 'mi-empty');
        var stack = box.appendChild(node('div', 'mm-cover-stack mi-empty-stack'));
        stack.appendChild(node('div', 'mm-cover-card c3'));
        stack.appendChild(node('div', 'mm-cover-card c2'));
        var front = stack.appendChild(node('div', 'mm-cover-card c1'));
        front.appendChild(node('span', 'mm-cover-sun'));
        front.appendChild(node('span', 'mm-cover-hill'));
        box.appendChild(node('div', 'mi-empty-title', L('No moments yet')));
        box.appendChild(node('div', 'mi-empty-sub', known
            ? L('Posts from people you know will show up here.')
            : L('Moments appear once the reply service has seen this character.')));
        return box;
    }

    // When a post was made, in game time: the clock today, else "Yesterday 18:34", a weekday or
    // "Day 998 08:12". Older posts only have the game's label ("Friday 18:34"); posts with neither
    // show no time rather than a real-world one.
    function moTime(post, env) {
        var g = post.game;
        if (g) return env && env.day === g.day ? smsGameClock(g) : smsStamp(g, env);
        return post.gameTime || '';
    }

    // A text-only post gets a cover of its own: a gradient picked by the post (so it is the same
    // every time) with the words set large on it, the way a text post looks on Instagram.
    var MO_COVERS = [
        ['#FF9A8B', '#FF6A88'], ['#F6D365', '#FDA085'], ['#4FACFE', '#2A6FF2'], ['#A18CD1', '#E58FC2'],
        ['#43C6AC', '#2F8F9D'], ['#FF9466', '#F2541B'], ['#5EE7DF', '#5A8DEE'], ['#30CFD0', '#4B2C80']
    ];

    function moHash(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return Math.abs(h);
    }

    function moMedia(data, post, liked) {
        var media = node('div', 'mi-media' + (post.image ? ' photo' : ' words'));
        if (post.image) {
            var ratio = Math.max(0.8, Math.min(1.25, post.image.height / post.image.width));
            media.style.paddingTop = Math.round(ratio * 100) + '%';
            var pic = media.appendChild(node('div', 'mi-media-pic'));
            pic.style.backgroundImage = 'url(media/' + post.image.id + '.jpg)';
        } else {
            var c = MO_COVERS[moHash(post.id) % MO_COVERS.length];
            media.style.backgroundImage = 'linear-gradient(135deg, ' + c[0] + ' 0%, ' + c[1] + ' 100%)';
            var words = media.appendChild(node('div', 'mi-words'));
            var len = String(post.text || '').length;
            var size = len <= 18 ? 'xl' : len <= 48 ? 'l' : len <= 110 ? 'm' : 's';
            var t = words.appendChild(node('div', 'mi-words-text ' + size));
            emojiFill(t, post.text);
            words.appendChild(node('div', 'mi-words-mark', '“'));
        }
        // Two taps on the picture like it, with the heart Instagram shows.
        var pop = media.appendChild(node('div', 'mi-pop'));
        pop.appendChild(moIcon(MO_HEART, 'mi-pop-ico', '#ffffff'));
        if (!post.pending) {
            var lastTap = 0;
            moTap(media, function () {
                var now = Date.now();
                if (now - lastTap > 320) { lastTap = now; return; }
                lastTap = 0;
                pop.className = 'mi-pop';
                nextFrame(function () { pop.className = 'mi-pop on'; });
                if (!liked) sendMomentsAction(data.me, { kind: 'like', postId: post.id });
            }, { silent: true });
        }
        return media;
    }

    // One post as a card: who and where on top, the picture, the heart and the comment button,
    // who liked it, the caption and the latest comments, and the comment box when it is open.
    function renderCard(data, post) {
        var me = data.me;
        var mine = post.authorId === me.id;
        var card = node('div', 'mi-card' + (post.pending ? ' pending' : ''));
        card._postId = post.id;

        var head = node('div', 'mi-head');
        head.appendChild(moRing(post.authorFirst, post.authorName, post.authorId, 'small'));
        var who = head.appendChild(node('div', 'mi-who'));
        who.appendChild(node('div', 'mi-name', post.authorName || ('#' + post.authorId)));
        var sub = who.appendChild(node('div', 'mi-sub'));
        if (post.place) {
            sub.appendChild(moIcon(MO_PIN, 'mi-pin'));
            sub.appendChild(node('span', 'mi-place', post.place));
            sub.appendChild(node('span', 'mi-dot', '·'));
        }
        sub.appendChild(node('span', 'mi-time', post.pending ? L('Sending') : moTime(post, data.env)));
        if (mine && !post.pending) {
            var more = head.appendChild(node('button', 'mi-more' + (momentsMenuPost === post.id ? ' on' : '')));
            more.setAttribute('type', 'button');
            more.appendChild(node('span'));
            more.appendChild(node('span'));
            more.appendChild(node('span'));
            moTap(more, function () { toggleMenu(post.id); });
            if (momentsMenuPost === post.id) {
                var confirming = momentsConfirmDelete === post.id;
                var menu = head.appendChild(node('div', 'mi-menu'));
                menu.appendChild(momentsButton(confirming ? L('Tap again to delete') : L('Delete post'), 'mi-menu-item warn', function () {
                    if (momentsConfirmDelete !== post.id) {
                        momentsConfirmDelete = post.id;
                        momentsRenderedKey = '';
                        refresh();
                        setTimeout(function () {
                            if (momentsConfirmDelete === post.id) {
                                momentsConfirmDelete = null;
                                momentsRenderedKey = '';
                                refresh();
                            }
                        }, 3000);
                        return;
                    }
                    momentsConfirmDelete = null;
                    momentsMenuPost = null;
                    momentsAt = null;
                    sendMomentsAction(me, { kind: 'delete', postId: post.id });
                }));
            }
        }
        card.appendChild(head);

        var liked = false;
        var i;
        for (i = 0; i < post.likes.length; i++) if (String(post.likes[i].id) === me.id) liked = true;
        card.appendChild(moMedia(data, post, liked));

        if (!post.pending) {
            var bar = card.appendChild(node('div', 'mi-bar'));
            var like = bar.appendChild(node('button', 'mi-act like' + (liked ? ' on' : '')));
            like.setAttribute('type', 'button');
            like.setAttribute('title', liked ? L('Unlike') : L('Like'));
            like.appendChild(moIcon(liked ? MO_HEART : MO_HEART_LINE, 'mi-act-ico'));
            moTap(like, function () {
                like.className = 'mi-act like ' + (liked ? '' : 'on') + ' bump';
                sendMomentsAction(me, { kind: liked ? 'unlike' : 'like', postId: post.id });
            });
            var talk = bar.appendChild(node('button', 'mi-act'));
            talk.setAttribute('type', 'button');
            talk.setAttribute('title', L('Comment'));
            talk.appendChild(moIcon(MO_BUBBLE, 'mi-act-ico'));
            moTap(talk, function () { openReply(post.id, null); });
            if (post.comments.length) bar.appendChild(node('span', 'mi-act-count', String(post.comments.length)));
        }

        var info = card.appendChild(node('div', 'mi-info'));
        if (post.likes.length) {
            var names = post.likes.map(function (l) { return likeName(data, l); });
            var shown = names.slice(0, 2).join(L('、'));
            info.appendChild(node('div', 'mi-likes', names.length > 2
                ? L('Liked by {names} and {n} others', { names: shown, n: names.length - 2 })
                : L('Liked by {names}', { names: shown })));
        }
        if (post.image && post.text) {
            var cap = info.appendChild(node('div', 'mi-caption'));
            cap.appendChild(node('span', 'mi-cap-name', post.authorName || ('#' + post.authorId)));
            var capText = cap.appendChild(node('span', 'mi-cap-text'));
            emojiFill(capText, post.text);
        }
        if (post.comments.length) {
            var open = !!momentsOpenComments[post.id] || post.comments.length <= 2;
            var list = open ? post.comments : post.comments.slice(-2);
            if (!open) {
                var all = info.appendChild(node('div', 'mi-all', L('View all {n} comments', { n: post.comments.length })));
                moTap(all, function () {
                    momentsOpenComments[post.id] = true;
                    momentsRenderedKey = '';
                    refresh();
                });
            }
            list.forEach(function (cm) {
                var own = String(cm.authorId) === me.id;
                var line = info.appendChild(node('div', 'mi-c' + (cm.pending ? ' dim' : '') + (!own && !cm.pending ? ' live' : '')));
                line.appendChild(node('span', 'mi-c-name', cm.authorName || ('#' + cm.authorId)));
                if (cm.replyTo) {
                    line.appendChild(node('span', 'mi-c-to', ' ▸ '));
                    line.appendChild(node('span', 'mi-c-name', cm.replyTo.name || ('#' + cm.replyTo.id)));
                }
                var body = line.appendChild(node('span', 'mi-c-text'));
                emojiFill(body, cm.text);
                if (!own && !cm.pending) moTap(line, function () { openReply(post.id, cm); });
            });
        }
        if (momentsComposer && momentsComposer.postId === post.id && !post.pending) card.appendChild(renderReplyBox(data, post));
        return card;
    }

    // ---------- The deck: one card at a time, swiped sideways ----------
    // The cards sit in a row on a track; the deck shows the current one whole and a sliver of its
    // neighbours. A drag, a sideways wheel or trackpad, the arrows or the dots turn it; the deck
    // takes the height of the card shown, and the page scrolls up and down as usual.
    var momentsAt = null;
    var momentsOpenComments = {};
    var moDeck = null;
    var moDrag = null;
    var moDraggedAt = 0;
    var moWheel = { sum: 0, at: 0, lockedUntil: 0 };
    var MO_PEEK = 30;
    var MO_GAP = 10;

    function moIndexOf(posts, id) {
        for (var i = 0; i < posts.length; i++) if (posts[i].id === id) return i;
        return 0;
    }

    function moStories(data) {
        var row = node('div', 'mi-stories');
        var me = data.me;
        var mine = row.appendChild(node('div', 'mi-story me'));
        var ring = mine.appendChild(moRing(me.first, me.name, me.id, 'plain'));
        var plus = ring.appendChild(node('div', 'mi-story-plus'));
        plus.appendChild(moIcon(MO_PLUS, 'mi-story-plus-ico', '#ffffff'));
        mine.appendChild(node('div', 'mi-story-name', L('Your story')));
        moTap(mine, function () { openComposer(); });
        var seen = {};
        data.view.posts.forEach(function (p, i) {
            if (p.authorId === me.id || seen[p.authorId]) return;
            seen[p.authorId] = true;
            var s = row.appendChild(node('div', 'mi-story'));
            s.appendChild(moRing(p.authorFirst, p.authorName, p.authorId));
            s.appendChild(node('div', 'mi-story-name', p.authorFirst || p.authorName || ('#' + p.authorId)));
            moTap(s, function () { moGo(i, true); });
        });
        return row;
    }

    function moPager(count) {
        var pager = node('div', 'mi-pager');
        var prev = pager.appendChild(node('button', 'mi-arrow prev'));
        prev.setAttribute('type', 'button');
        prev.setAttribute('title', L('Previous'));
        prev.appendChild(moIcon(MO_LEFT, 'mi-arrow-ico'));
        moTap(prev, function () { if (moDeck) moGo(moDeck.index - 1, true); });
        var dots = pager.appendChild(node('div', 'mi-dots'));
        var shown = Math.min(count, 7);
        for (var i = 0; i < shown; i++) dots.appendChild(node('span', 'mi-dotp'));
        pager.appendChild(node('div', 'mi-count'));
        var next = pager.appendChild(node('button', 'mi-arrow next'));
        next.setAttribute('type', 'button');
        next.setAttribute('title', L('Next'));
        next.appendChild(moIcon(MO_RIGHT, 'mi-arrow-ico'));
        moTap(next, function () { if (moDeck) moGo(moDeck.index + 1, true); });
        return pager;
    }

    // The page on screen after a redraw: the poll's redraw morphs the old page into the new one
    // (showInPlace), keeping old elements whose tag and attributes did not change, so the deck
    // takes its parts from the page itself, not from the copy it was drawn in.
    function moAdopt() {
        var d = moDeck;
        var s = document.getElementById('mo-screen');
        var deck = s ? s.querySelector('.mi-deck') : null;
        if (!d || !deck) return false;
        if (deck !== d.deck) {
            d.deck = deck;
            d.w = 0;
        }
        d.track = deck.querySelector('.mi-track');
        d.cards = [].slice.call(d.track.children);
        d.count = s.querySelector('.mi-count');
        d.dots = s.querySelector('.mi-dots');
        d.prev = s.querySelector('.mi-arrow.prev');
        d.next = s.querySelector('.mi-arrow.next');
        if (d.cards.length !== d.posts.length) return false;
        for (var i = 0; i < d.cards.length; i++) if (!d.cards[i].style.width) d.w = 0;
        moBindDeck();
        return true;
    }

    // Card widths follow the deck, which follows the phone window (it can be resized).
    function moLayout() {
        var d = moDeck;
        if (!d || !d.deck.parentNode) return false;
        var w = d.deck.clientWidth;
        if (!w) return false;
        if (w !== d.w) {
            d.w = w;
            d.cardW = Math.max(160, w - MO_PEEK * 2);
            for (var i = 0; i < d.cards.length; i++) d.cards[i].style.width = d.cardW + 'px';
        }
        moGo(d.index, false);
        return true;
    }

    function moOffset(i) {
        var d = moDeck;
        return MO_PEEK - i * (d.cardW + MO_GAP);
    }

    function moSetX(x, animate) {
        var d = moDeck;
        d.track.style.transition = animate ? 'transform 380ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
        d.track.style.transform = 'translateX(' + Math.round(x) + 'px)';
    }

    function moGo(i, animate) {
        var d = moDeck;
        if (!d || !d.cards.length) return;
        if (!d.cardW && !moLayout()) return;
        var n = d.cards.length;
        i = Math.max(0, Math.min(n - 1, i));
        d.index = i;
        momentsAt = d.posts[i].id;
        moSetX(moOffset(i), animate);
        for (var k = 0; k < n; k++) d.cards[k].className = d.cards[k].className.replace(/\s*\bactive\b/g, '') + (k === i ? ' active' : '');
        var h = d.cards[i].offsetHeight;
        if (h) d.deck.style.height = h + 'px';
        if (d.count) d.count.textContent = (i + 1) + ' / ' + n;
        if (d.prev) d.prev.className = 'mi-arrow prev' + (i === 0 ? ' off' : '');
        if (d.next) d.next.className = 'mi-arrow next' + (i === n - 1 ? ' off' : '');
        // Seven dots at most; with more posts the bright one marks where in the feed this is.
        var dots = d.dots ? d.dots.children : [];
        var on = dots.length ? (n <= dots.length ? i : Math.round(i / (n - 1) * (dots.length - 1))) : -1;
        for (var j = 0; j < dots.length; j++) dots[j].className = 'mi-dotp' + (j === on ? ' on' : '');
    }

    function moBindDeck() {
        var d = moDeck;
        if (d.deck._miBound) return;
        d.deck._miBound = true;
        d.deck.addEventListener('mousedown', function (e) {
            if (e.button || moDeck !== d) return;
            var t = e.target;
            if (t && /^(TEXTAREA|INPUT)$/.test(t.tagName)) return;
            if (!d.cardW) moLayout();
            moDrag = { x: e.clientX, y: e.clientY, base: moOffset(d.index), now: moOffset(d.index), moved: false,
                press: pressStart(e), samples: [{ x: e.clientX, t: Date.now() }] };
        });
        d.deck.addEventListener('wheel', function (e) {
            if (moDeck !== d) return;
            // Up and down scrolls the page; sideways (a trackpad, a tilted wheel) turns the cards.
            if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
            if (e.preventDefault) e.preventDefault();
            var now = Date.now();
            if (now < moWheel.lockedUntil) return;
            if (now - moWheel.at > 250) moWheel.sum = 0;
            moWheel.at = now;
            moWheel.sum += e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
            if (Math.abs(moWheel.sum) < 60) return;
            var dir = moWheel.sum > 0 ? 1 : -1;
            moWheel.sum = 0;
            moWheel.lockedUntil = now + 420;
            moGo(d.index + dir, true);
        }, { passive: false });
    }

    document.addEventListener('mousemove', function (e) {
        var g = moDrag;
        var d = moDeck;
        if (!g || !d) return;
        if (pressLost(e, g.press)) { moRelease(); return; }
        var dx = e.clientX - g.x;
        var dy = e.clientY - g.y;
        if (!g.moved) {
            if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
            if (Math.abs(dy) > Math.abs(dx)) { moDrag = null; return; }
            g.moved = true;
        }
        var pos = g.base + dx;
        var max = moOffset(0);
        var min = moOffset(d.cards.length - 1);
        if (pos > max) pos = max + (pos - max) * 0.3;
        else if (pos < min) pos = min + (pos - min) * 0.3;
        g.now = pos;
        moSetX(pos, false);
        g.samples.push({ x: e.clientX, t: Date.now() });
        if (g.samples.length > 6) g.samples.shift();
    });

    function moRelease() {
        var g = moDrag;
        var d = moDeck;
        moDrag = null;
        if (!g || !d || !g.moved) return;
        moDraggedAt = Date.now();
        var first = g.samples[0];
        var last = g.samples[g.samples.length - 1];
        var dt = last.t - first.t;
        var v = dt > 0 ? (last.x - first.x) / dt : 0;
        var travel = g.now - g.base;
        var target = d.index;
        if (v <= -0.45 || travel <= -d.cardW * 0.22) target = d.index + 1;
        else if (v >= 0.45 || travel >= d.cardW * 0.22) target = d.index - 1;
        moGo(target, true);
    }

    document.addEventListener('mouseup', moRelease);
    document.addEventListener('mouseout', function (e) {
        if (moDrag && leftPhone(e)) moRelease();
    });
    window.addEventListener('blur', moRelease);

    // The window can be resized by its corner, and pictures settle after they load: the deck
    // keeps the card widths and its own height in step.
    setInterval(function () {
        var d = moDeck;
        if (current !== 'moments' || !d || moDrag || !d.deck.parentNode) return;
        if (d.deck.clientWidth !== d.w) { moLayout(); return; }
        var h = d.cards[d.index] ? d.cards[d.index].offsetHeight : 0;
        if (h && d.deck.style.height !== h + 'px') d.deck.style.height = h + 'px';
    }, 500);

    function renderMoments(data) {
        var wrap = node('div', 'mi');
        wrap.id = 'mo-screen';
        momentsRenderedKey = momentsRenderKey(data);
        if (momentsComposeOpen) {
            moDeck = null;
            wrap.appendChild(renderComposer(data));
            return wrap;
        }
        var head = subHeader('moments');
        var newBtn = head.appendChild(node('button', 'mi-new-btn'));
        newBtn.setAttribute('type', 'button');
        newBtn.setAttribute('title', L('New post'));
        newBtn.appendChild(moIcon(MO_PLUS, 'mi-new-btn-ico'));
        moTap(newBtn, function () { openComposer(); });
        wrap.appendChild(head);
        var p = momentsPresence(data.status);
        if (p.text) wrap.appendChild(node('div', 'mi-status ' + p.cls, L(p.text)));
        var posts = data.view.posts;
        if (momentsComposer && !findById(posts, momentsComposer.postId)) momentsComposer = null;
        wrap.appendChild(moStories(data));
        if (!posts.length) {
            moDeck = null;
            wrap.appendChild(renderMomentsEmpty(data.view.circleKnown));
            return wrap;
        }
        var deck = node('div', 'mi-deck');
        var track = deck.appendChild(node('div', 'mi-track'));
        var cards = posts.map(function (post) { return track.appendChild(renderCard(data, post)); });
        wrap.appendChild(deck);
        var pager = moPager(posts.length);
        wrap.appendChild(pager);
        moDeck = { deck: deck, track: track, cards: cards, posts: posts, index: moIndexOf(posts, momentsAt), w: 0, cardW: 0,
            count: pager.querySelector('.mi-count'), dots: pager.querySelector('.mi-dots'),
            prev: pager.querySelector('.mi-arrow.prev'), next: pager.querySelector('.mi-arrow.next') };
        moBindDeck();
        return wrap;
    }

    // Same feed, same open panels: the page on screen is current and must not be rebuilt.
    function momentsRenderKey(data) {
        // The game day too: "Today" and "Yesterday" move on with it.
        var open = [];
        for (var k in momentsOpenComments) if (momentsOpenComments[k]) open.push(k);
        return data.key + '|' + (data.env ? data.env.day : '') + '|' + (data.portraitRev || 0) + '|' + (momentsComposeOpen ? '1' : '0') + '|' +
            (momentsComposer ? momentsComposer.postId + '/' + momentsComposer.commentId : '') + '|' +
            (momentsMenuPost || '') + '|' + (momentsConfirmDelete || '') + '|' + open.join(',') + '|' +
            (moPhoto ? moPhoto.id : '') + '|' + (moPhotoPending ? 'p' : '') + '|' + phoneLang;
    }
