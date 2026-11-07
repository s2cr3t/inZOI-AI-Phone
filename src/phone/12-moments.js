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
            game: smsGameClean(p.game), gameTime: p.gameTime || ''
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
            posts.push({ id: 'u-' + a.id, authorId: me.id, authorName: me.name, authorFirst: me.first, at: a.at, place: '', text: a.text || '', likes: [], comments: [], pending: true, game: smsGameClean(a.game) });
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
            var s = p.id + (p.pending ? '*' : '') + ':' + p.likes.length;
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
        if (refreshDropping) {
            momentsPostDraft = '';
            momentsDraft = '';
            momentsFocus = null;
            return;
        }
        if (post) momentsPostDraft = post.value;
        if (reply) momentsDraft = reply.value;
        if (momentsFocusPending) return;
        momentsFocus = document.activeElement === post ? 'post' : document.activeElement === reply ? 'reply' : null;
    }

    function restoreMoments() {
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
    var MO_BUBBLE = 'M4.2 4.4h15.6c.9 0 1.6.7 1.6 1.6v8.2c0 .9-.7 1.6-1.6 1.6h-6.2L8.2 19.4c-.4.3-.9 0-.9-.5v-3.1H4.2c-.9 0-1.6-.7-1.6-1.6V6c0-.9.7-1.6 1.6-1.6z';
    var MO_PIN = 'M12 2.2c-3.5 0-6.3 2.8-6.3 6.3 0 4.7 6.3 12.8 6.3 12.8s6.3-8.1 6.3-12.8c0-3.5-2.8-6.3-6.3-6.3zm0 8.6c-1.3 0-2.3-1-2.3-2.3s1-2.3 2.3-2.3 2.3 1 2.3 2.3-1 2.3-2.3 2.3z';
    var MO_PENCIL = 'M3.6 16.6V20.4h3.8l11.2-11.2-3.8-3.8L3.6 16.6zM19.7 7.5c.4-.4.4-.9 0-1.3l-2-2c-.4-.4-.9-.4-1.3 0l-1.5 1.5 3.3 3.3 1.5-1.5z';

    function moIcon(d, extra, fill) {
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'mo-ico' + (extra ? ' ' + extra : ''));
        glyphPath(svg, d, fill || '#f5f5f7');
        return svg;
    }

    function momentsPerson(first, name, id) {
        return faceAvatar({ first_name: first || '', name: name || '', entity_id: id });
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

    function momentsButton(text, cls, onClick) {
        var b = node('button', cls, text);
        b.setAttribute('type', 'button');
        onTap(b, function (e) {
            e.stopPropagation();
            onClick();
        });
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
        b.setAttribute('title', 'Emoji');
        if (emojiSet) b.appendChild(emojiImg(emojiSet.byName['微笑'] || emojiSet.list[0].id, ''));
        else b.style.display = 'none';
        onTap(b, function (e) {
            e.stopPropagation();
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

    function renderComposer(data) {
        var me = data.me;
        var c = node('div', 'mo-compose' + (momentsComposeOpen ? ' open' : ''));
        var top = node('div', 'mo-compose-top');
        top.appendChild(momentsPerson(me.first, me.name, me.id));
        if (!momentsComposeOpen) {
            var draft = String(momentsPostDraft || '').replace(/^\s+|\s+$/g, '');
            var prompt = node('div', 'mo-prompt' + (draft ? ' filled' : ''));
            emojiFill(prompt, draft || "What's on your mind?");
            top.appendChild(prompt);
            top.appendChild(moIcon(MO_PENCIL, 'mo-compose-ico', '#8e8e93'));
            c.appendChild(top);
            onTap(c, function () { openComposer(); });
            return c;
        }
        top.appendChild(node('div', 'mo-who', me.name || 'You'));
        c.appendChild(top);
        var input = momentsInput('mo-post', 'mo-input', "What's on your mind?", momentsPostDraft, MOMENTS_POST_MAX);
        moTrackCaret(input, 'post');
        var row = node('div', 'mo-compose-row');
        var hint = node('div', 'mo-hint', 'Friends who know you can see this.');
        var postBtn = momentsButton('Post', 'mo-btn mo-btn-off', function () {
            var text = String(input.value || '').replace(/^\s+|\s+$/g, '');
            if (!text) return;
            if (text.length > MOMENTS_POST_MAX) {
                setNote('Keep it under ' + MOMENTS_POST_MAX + ' characters.', true);
                return;
            }
            sendMomentsAction(me, { kind: 'post', text: text }, function () {
                momentsPostDraft = '';
                momentsComposeOpen = false;
                momentsEmojiFor = null;
                momentsFocus = null;
            });
        });
        var sync = function () {
            var n = String(input.value || '').length;
            hint.textContent = n ? (n + ' / ' + MOMENTS_POST_MAX) : 'Friends who know you can see this.';
            postBtn.className = n ? 'mo-btn' : 'mo-btn mo-btn-off';
        };
        var changed = function (value) {
            momentsPostDraft = value;
            sync();
        };
        input.addEventListener('input', function () { changed(input.value); });
        sync();
        row.appendChild(moEmojiButton('post'));
        row.appendChild(hint);
        row.appendChild(momentsButton('Cancel', 'mo-btn mo-btn-plain', function () {
            momentsEmojiFor = null;
            closeComposer();
        }));
        row.appendChild(postBtn);
        c.appendChild(input);
        c.appendChild(row);
        c.appendChild(moEmojiPanel('post', MOMENTS_POST_MAX, changed));
        return c;
    }

    function openReply(postId, comment) {
        momentsMenuPost = null;
        momentsConfirmDelete = null;
        momentsComposer = {
            postId: postId,
            commentId: comment ? comment.id : null,
            name: comment ? comment.authorName : null
        };
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
        var box = node('div', 'mo-reply-box');
        if (momentsComposer.name) box.appendChild(node('div', 'mo-reply-to', 'Reply to ' + momentsComposer.name));
        var row = node('div', 'mo-reply-row');
        var input = momentsInput('mo-reply', 'mo-input mo-input-small', momentsComposer.name ? 'Write a reply' : 'Write a comment', momentsDraft, MOMENTS_COMMENT_MAX);
        moTrackCaret(input, 'reply');
        var send = function () {
            var text = String(input.value || '').replace(/^\s+|\s+$/g, '');
            if (!text) return;
            sendMomentsAction(data.me, { kind: 'comment', postId: post.id, text: text, replyToCommentId: momentsComposer.commentId }, function () {
                momentsComposer = null;
                momentsDraft = '';
                momentsEmojiFor = null;
                momentsFocus = null;
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
        row.appendChild(moEmojiButton('reply'));
        row.appendChild(input);
        var btns = node('div', 'mo-reply-btns');
        btns.appendChild(momentsButton('Send', 'mo-btn', send));
        btns.appendChild(momentsButton('Cancel', 'mo-btn mo-btn-plain', function () {
            momentsEmojiFor = null;
            closeReply();
        }));
        row.appendChild(btns);
        box.appendChild(row);
        box.appendChild(moEmojiPanel('reply', MOMENTS_COMMENT_MAX, function (value) { momentsDraft = value; }));
        return box;
    }

    function likeName(data, like) {
        var me = data.me;
        if (String(like.id) === me.id) return me.name;
        return like.name || data.view.names[String(like.id)] || ('#' + like.id);
    }

    function renderMomentsEmpty(known) {
        var box = node('div', 'mo-empty');
        var mark = node('div', 'mo-empty-mark');
        mark.appendChild(appGlyph('moments'));
        box.appendChild(mark);
        box.appendChild(node('div', 'mo-empty-title', 'No moments yet'));
        box.appendChild(node('div', 'mo-empty-sub', known
            ? 'Posts from people you know will show up here.'
            : 'Moments appear once the reply service has seen this character.'));
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

    // One post laid out like a social feed: who and when on top, the text across the card, then
    // Like and Comment always in reach, then who liked it and the comments.
    function renderPost(data, post) {
        var me = data.me;
        var mine = post.authorId === me.id;
        var c = node('div', 'mo-post' + (post.pending ? ' mo-pending' : ''));

        var head = node('div', 'mo-head');
        head.appendChild(momentsPerson(post.authorFirst, post.authorName, post.authorId));
        var who = node('div', 'mo-who-box');
        who.appendChild(node('div', 'mo-author', post.authorName || ('#' + post.authorId)));
        var sub = node('div', 'mo-sub');
        sub.appendChild(node('span', 'mo-time' + (post.pending ? ' wait' : ''), post.pending ? 'Sending' : moTime(post, data.env)));
        if (post.place) {
            sub.appendChild(node('span', 'mo-sep', '·'));
            var place = node('span', 'mo-place');
            place.appendChild(moIcon(MO_PIN, 'mo-pin', '#8e8e93'));
            place.appendChild(node('span', null, post.place));
            sub.appendChild(place);
        }
        who.appendChild(sub);
        head.appendChild(who);
        if (mine && !post.pending) {
            var more = node('button', 'mo-more' + (momentsMenuPost === post.id ? ' on' : ''));
            more.setAttribute('type', 'button');
            more.appendChild(node('span'));
            more.appendChild(node('span'));
            more.appendChild(node('span'));
            onTap(more, function (e) {
                e.stopPropagation();
                toggleMenu(post.id);
            });
            head.appendChild(more);
            if (momentsMenuPost === post.id) {
                var confirming = momentsConfirmDelete === post.id;
                var menu = node('div', 'mo-menu');
                menu.appendChild(momentsButton(confirming ? 'Tap again to delete' : 'Delete post', 'mo-menu-item warn', function () {
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
                    sendMomentsAction(me, { kind: 'delete', postId: post.id });
                }));
                head.appendChild(menu);
            }
        }
        c.appendChild(head);

        var text = node('div', 'mo-text');
        emojiFill(text, post.text);
        c.appendChild(text);

        var liked = false;
        var i;
        for (i = 0; i < post.likes.length; i++) if (String(post.likes[i].id) === me.id) liked = true;
        if (!post.pending) {
            var actions = node('div', 'mo-actions');
            var like = momentsButton('', 'mo-act' + (liked ? ' on' : ''), function () {
                sendMomentsAction(me, { kind: liked ? 'unlike' : 'like', postId: post.id });
            });
            like.appendChild(moIcon(MO_HEART, '', liked ? '#FF375F' : '#8e8e93'));
            like.appendChild(node('span', null, post.likes.length ? String(post.likes.length) : 'Like'));
            actions.appendChild(like);
            var talk = momentsButton('', 'mo-act', function () { openReply(post.id, null); });
            talk.appendChild(moIcon(MO_BUBBLE, '', '#8e8e93'));
            talk.appendChild(node('span', null, post.comments.length ? String(post.comments.length) : 'Comment'));
            actions.appendChild(talk);
            c.appendChild(actions);
        }

        if (post.likes.length || post.comments.length) {
            var social = node('div', 'mo-social');
            if (post.likes.length) {
                var likes = node('div', 'mo-likes' + (post.comments.length ? ' split' : ''));
                likes.appendChild(moIcon(MO_HEART, '', '#FF375F'));
                likes.appendChild(node('span', 'mo-like-names', post.likes.map(function (l) {
                    return likeName(data, l);
                }).join('，')));
                social.appendChild(likes);
            }
            post.comments.forEach(function (cm) {
                var own = String(cm.authorId) === me.id;
                var line = node('div', 'mo-c' + (cm.pending ? ' dim' : '') + (!own && !cm.pending ? ' live' : ''));
                line.appendChild(node('span', 'mo-n', cm.authorName || ('#' + cm.authorId)));
                if (cm.replyTo) {
                    line.appendChild(node('span', 'mo-r', ' reply '));
                    line.appendChild(node('span', 'mo-n', cm.replyTo.name || ('#' + cm.replyTo.id)));
                }
                line.appendChild(node('span', 'mo-colon', '：'));
                emojiFill(line, cm.text);
                if (!own && !cm.pending) {
                    onTap(line, function (e) {
                        e.stopPropagation();
                        openReply(post.id, cm);
                    });
                }
                social.appendChild(line);
            });
            c.appendChild(social);
        }
        if (momentsComposer && momentsComposer.postId === post.id && !post.pending) c.appendChild(renderReplyBox(data, post));
        return c;
    }

    function renderMoments(data) {
        var wrap = node('div');
        wrap.id = 'mo-screen';
        wrap.appendChild(subHeader('moments'));
        var p = momentsPresence(data.status);
        if (p.text) wrap.appendChild(node('div', 'mo-status ' + p.cls, p.text));
        wrap.appendChild(renderComposer(data));
        if (momentsComposer && !findById(data.view.posts, momentsComposer.postId)) momentsComposer = null;
        if (!data.view.posts.length) {
            wrap.appendChild(renderMomentsEmpty(data.view.circleKnown));
        } else {
            var feed = node('div', 'mo-feed');
            data.view.posts.forEach(function (post) { feed.appendChild(renderPost(data, post)); });
            wrap.appendChild(feed);
        }
        momentsRenderedKey = momentsRenderKey(data);
        return wrap;
    }

    // Same feed, same open panels: the page on screen is current and must not be rebuilt.
    function momentsRenderKey(data) {
        // The game day too: "Today" and "Yesterday" move on with it.
        return data.key + '|' + (data.env ? data.env.day : '') + '|' + (data.portraitRev || 0) + '|' + (momentsComposeOpen ? '1' : '0') + '|' +
            (momentsComposer ? momentsComposer.postId + '/' + momentsComposer.commentId : '') + '|' +
            (momentsMenuPost || '') + '|' + (momentsConfirmDelete || '');
    }

