    // ------------------------------------------------------------------
    // 成长册: one booklet for each life stage a household member lived through, written by the
    // reply service (sms-bridge lib/booklet.js) when the stage ended, from what happened in it:
    // 心事, the people they were closest to, everyday moments, achievements, the character they
    // grew into, and a few words to them. Each plays the stage's song while it is open
    // (booklet/songs/<file>.webm). The stage being lived can be leafed through as a draft.
    // A booklet just finished (someone really grew up) opens by itself in the middle of the
    // screen, outside the phone, with the game paused, once; the shelf keeps it afterwards.
    //   ui/phone/booklet/board.cfg    written by the service only
    //   ui/phone/booklet/request.cfg  { seq, id, op: 'draft', at }, written here only
    //   ui/phone/saved/booklet-seen.cfg  { init, ids: { <book id>:<written at>: at } }, here only:
    //                                 the booklets already shown in the middle of the screen
    // ------------------------------------------------------------------
    var BK_SECTION = 'ui/phone/booklet';
    var BK_TINT = {
        Infant: 'bk-t-dawn', Toddler: 'bk-t-sun', Child: 'bk-t-grass', LowTeen: 'bk-t-sky', HighTeen: 'bk-t-rose',
        Youth: 'bk-t-sea', Adult: 'bk-t-amber', Old: 'bk-t-plum', Elderly: 'bk-t-dusk'
    };
    var bkMemberId = null;
    var bkBookId = null;
    var bkPage = 0;
    var bkAsked = {};
    // The song playing: { file, media, watch }. bkMusicOn: the player's choice while the phone runs.
    var bkMusic = null;
    var bkMusicOn = true;

    function loadBooklet() {
        return Promise.all([getMembers(), soft(getPossessedId()), loadPortraitIndex(), cfgValue(BK_SECTION, 'board'), getEnv().then(null, function () { return null; })]).then(function (r) {
            var played = r[1] && !r[1].error ? String(r[1]) : '';
            var members = r[0] || [];
            var board = r[3] && r[3].people && typeof r[3].people === 'object' ? r[3] : null;
            if (!memberById(members, bkMemberId)) bkMemberId = memberById(members, played) ? played : members.length ? String(members[0].entity_id) : null;
            var m = memberById(members, bkMemberId);
            return { played: played, members: members, member: m, board: board, env: r[4],
                person: m && board ? board.people[String(m.entity_id)] || null : null };
        });
    }

    function bkToday(data) {
        return data.env && typeof data.env.day === 'number' ? data.env.day : null;
    }

    function bkBooks(person) {
        return person && person.books instanceof Array ? person.books : [];
    }

    function bkEmpty(wrap, text, sub) {
        var c = wrap.appendChild(node('div', 'bk-card bk-empty'));
        c.appendChild(node('div', 'bk-empty-mark', '册'));
        c.appendChild(node('div', 'bk-empty-title', text));
        if (sub) c.appendChild(node('div', 'bk-empty-sub', sub));
        return wrap;
    }

    function bkAskDraft(id) {
        bkAsked[id] = Date.now();
        soft(call('uimod.cfg_save', { mod_id: SMS_MOD, section: BK_SECTION, key: 'request', value: JSON.stringify({ seq: Date.now(), id: String(id), op: 'draft', at: Date.now() }) }));
        refresh();
    }

    function bkOpenBook(id) {
        bkBookId = id;
        bkPage = 0;
        open('bookread');
    }

    function renderBooklet(data) {
        var wrap = node('div', 'bk-screen');
        wrap.appendChild(subHeader('booklet'));
        if (!data.members.length) return bkEmpty(wrap, '家里还没有人', '');
        var m = data.member;
        var p = data.person;
        var id = String(m.entity_id);
        // Who: the member, and the others to switch to.
        var hero = wrap.appendChild(node('div', 'bk-hero'));
        hero.appendChild(faceAvatar(m));
        var who = hero.appendChild(node('div', 'bk-hero-who'));
        who.appendChild(node('div', 'bk-hero-name', fullName(m)));
        var today = bkToday(data);
        var since = p && typeof p.since === 'number' && today !== null ? Math.max(0, today - p.since) : null;
        who.appendChild(node('div', 'bk-hero-sub', p ? (p.stageZh || '') + (since !== null ? ' · 这一段第 ' + (since + 1) + ' 天' : '') : '还没开始记'));
        if (data.members.length > 1) {
            var row = hero.appendChild(node('div', 'bk-kids'));
            data.members.forEach(function (o) {
                var oid = String(o.entity_id);
                if (oid === id) return;
                var face = faceAvatar(o);
                face.className += ' bk-kid';
                onTap(face, function (e) {
                    e.stopPropagation();
                    bkMemberId = oid;
                    refresh();
                });
                row.appendChild(face);
            });
        }
        if (!data.board) return bkEmpty(wrap, '成长册还没同步', '回复服务（sms-bridge）开着时，这里会记下每个人每一段人生。');
        if (!p) return bkEmpty(wrap, fullName(m) + '的成长册刚刚打开', '从现在起发生的事都会记下来，过完这一段人生，就会有一本属于这一段的册子。');
        // The stage being lived: a draft to leaf through.
        var writing = p.writing instanceof Array ? p.writing : [];
        var drafting = writing.some(function (w) { return w.kind === 'draft'; }) || (bkAsked[id] && Date.now() - bkAsked[id] < 20000);
        var draft = null;
        bkBooks(p).forEach(function (b) { if (b.draft && b.stage === p.stage) draft = b; });
        var now = wrap.appendChild(node('div', 'bk-card bk-now ' + (BK_TINT[p.stage] || '')));
        now.appendChild(node('div', 'bk-now-tag', '正在书写'));
        now.appendChild(node('div', 'bk-now-title', p.book || p.stageZh));
        now.appendChild(node('div', 'bk-now-sub', draft ? (today !== null && draft.to === today ? '草稿写到今天' : '草稿写到 ' + Math.max(0, (today || draft.to) - draft.to) + ' 天前') : '这一段还没过完，可以先翻翻看'));
        var btns = now.appendChild(node('div', 'bk-now-btns'));
        if (draft) {
            var read = btns.appendChild(node('button', 'ph-btn bk-btn', '翻开草稿'));
            read.setAttribute('type', 'button');
            onTap(read, function (e) { e.stopPropagation(); bkOpenBook(draft.id); });
        }
        var canAsk = !drafting && !(draft && today !== null && p.draftDay === today);
        var ask = btns.appendChild(node('button', 'ph-btn bk-btn' + (draft ? ' ghost' : '') + (canAsk ? '' : ' off'), drafting ? '正在整理…' : (draft ? (canAsk ? '重新整理' : '今天已整理') : '先翻翻看')));
        ask.setAttribute('type', 'button');
        if (canAsk) onTap(ask, function (e) { e.stopPropagation(); bkAskDraft(id); });
        // The shelf: the stages already lived, the newest first.
        var done = bkBooks(p).filter(function (b) { return !b.draft; });
        var shelf = wrap.appendChild(node('div', 'bk-card'));
        shelf.appendChild(node('div', 'bk-shelf-head', '书架' + (done.length ? ' · ' + done.length + ' 本' : '')));
        if (writing.some(function (w) { return w.kind !== 'draft'; })) shelf.appendChild(node('div', 'bk-shelf-note', '上一段人生正在整理成册……'));
        if (!done.length) shelf.appendChild(node('div', 'bk-shelf-note', '每过完一段人生，这里就会多一本。'));
        done.forEach(function (b) {
            var item = shelf.appendChild(node('div', 'bk-book ' + (BK_TINT[b.stage] || '')));
            var spine = item.appendChild(node('div', 'bk-book-cover'));
            spine.appendChild(node('div', 'bk-book-stage', b.name || b.stageZh));
            var info = item.appendChild(node('div', 'bk-book-info'));
            info.appendChild(node('div', 'bk-book-title', '「' + b.title + '」'));
            info.appendChild(node('div', 'bk-book-sub', '共 ' + (b.days || 1) + ' 天' + (b.final ? ' · 一生' : '')));
            if (b.song) info.appendChild(node('div', 'bk-book-song', '♪ ' + b.song.title));
            onTap(item, function (e) { e.stopPropagation(); bkOpenBook(b.id); });
        });
        return wrap;
    }

    // ---------- reading one booklet ----------
    function bkPagesOf(b) {
        var pages = [{ kind: 'cover' }];
        if (b.worries && b.worries.length) pages.push({ kind: 'worries', title: '心事' });
        if (b.friends && b.friends.length) pages.push({ kind: 'friends', title: '最亲近的人' });
        if (b.moments && b.moments.length) pages.push({ kind: 'moments', title: '日常点滴' });
        if (b.achievements && b.achievements.length) pages.push({ kind: 'achievements', title: '获得的成就' });
        if (b.character || (b.traits && b.traits.length)) pages.push({ kind: 'character', title: '长成的样子' });
        if (b.letter) pages.push({ kind: 'letter', title: '写给你' });
        return pages;
    }

    function bkPageBody(page, b, data) {
        var body = node('div', 'bk-page-body');
        if (page.kind === 'cover') {
            body.appendChild(node('div', 'bk-cover-stage', b.name || b.stageZh));
            body.appendChild(node('div', 'bk-cover-title', '「' + b.title + '」'));
            body.appendChild(node('div', 'bk-cover-who', (data.member ? fullName(data.member) : '') + ' · 共 ' + (b.days || 1) + ' 天' + (b.draft ? ' · 草稿' : '')));
            if (b.opening) body.appendChild(node('div', 'bk-cover-open', b.opening));
            if (b.song) body.appendChild(node('div', 'bk-cover-song', '♪ ' + b.song.title));
            return body;
        }
        body.appendChild(node('div', 'bk-page-title', page.title));
        if (page.kind === 'worries') {
            b.worries.forEach(function (w) {
                var it = body.appendChild(node('div', 'bk-note'));
                if (w.title) it.appendChild(node('div', 'bk-note-title', w.title));
                it.appendChild(node('div', 'bk-note-text', w.text));
            });
        } else if (page.kind === 'friends') {
            b.friends.forEach(function (f) {
                var it = body.appendChild(node('div', 'bk-friend'));
                var mm = memberById(data.members, f.id);
                if (mm) it.appendChild(faceAvatar(mm));
                else it.appendChild(node('div', 'bk-friend-mark', (f.name || '?').charAt(0)));
                var t = it.appendChild(node('div', 'bk-friend-text'));
                t.appendChild(node('div', 'bk-friend-name', f.name + (f.family ? ' · 家人' : '')));
                t.appendChild(node('div', 'bk-note-text', f.text));
            });
        } else if (page.kind === 'moments') {
            b.moments.forEach(function (x) { body.appendChild(node('div', 'bk-dot', x)); });
        } else if (page.kind === 'achievements') {
            b.achievements.forEach(function (x) { body.appendChild(node('div', 'bk-star', x)); });
        } else if (page.kind === 'character') {
            if (b.traits && b.traits.length) {
                var chips = body.appendChild(node('div', 'bk-chips'));
                b.traits.forEach(function (t) { chips.appendChild(node('span', 'bk-chip', t)); });
            }
            if (b.character) body.appendChild(node('div', 'bk-note-text bk-gap', b.character));
        } else if (page.kind === 'letter') {
            body.appendChild(node('div', 'bk-letter', b.letter));
            body.appendChild(node('div', 'bk-letter-sign', b.final ? '—— 这一生，谢谢你' : '—— 下一段，也要好好的'));
        }
        return body;
    }

    function renderBookRead(data) {
        var wrap = node('div', 'bk-screen');
        wrap.appendChild(subHeader('bookread'));
        var b = null;
        bkBooks(data.person).forEach(function (x) { if (x.id === bkBookId) b = x; });
        if (!b) {
            bkMusicStop('the booklet is gone');
            return bkEmpty(wrap, '这本册子不见了', '回到书架再找找。');
        }
        if (b.song && bkMusicOn) bkMusicPlay(b.song.file, null, bkPhoneKeep);
        var pages = bkPagesOf(b);
        if (bkPage >= pages.length) bkPage = pages.length - 1;
        if (bkPage < 0) bkPage = 0;
        var paper = wrap.appendChild(node('div', 'bk-paper ' + (BK_TINT[b.stage] || '') + (bkPage === 0 ? ' cover' : '')));
        paper.appendChild(bkPageBody(pages[bkPage], b, data));
        var nav = wrap.appendChild(node('div', 'bk-nav'));
        var prev = nav.appendChild(node('button', 'ph-btn bk-turn' + (bkPage > 0 ? '' : ' off'), '‹ 上一页'));
        prev.setAttribute('type', 'button');
        onTap(prev, function (e) { e.stopPropagation(); if (bkPage > 0) { bkPage -= 1; refresh(); } });
        nav.appendChild(node('div', 'bk-count', (bkPage + 1) + ' / ' + pages.length));
        var next = nav.appendChild(node('button', 'ph-btn bk-turn' + (bkPage < pages.length - 1 ? '' : ' off'), '下一页 ›'));
        next.setAttribute('type', 'button');
        onTap(next, function (e) { e.stopPropagation(); if (bkPage < pages.length - 1) { bkPage += 1; refresh(); } });
        if (b.song) {
            var music = wrap.appendChild(node('button', 'ph-btn bk-music' + (bkMusicOn ? ' on' : ''), (bkMusicOn ? '♪ 正在播放：' : '♪ 已静音：') + b.song.title));
            music.setAttribute('type', 'button');
            onTap(music, function (e) {
                e.stopPropagation();
                bkMusicOn = !bkMusicOn;
                if (bkMusicOn) bkMusicPlay(b.song.file, null, bkPhoneKeep); else bkMusicStop('muted');
                refresh();
            });
        }
        return wrap;
    }

    // ---------- the song ----------
    // Played like a voice message: a <video> the engine draws (in the island, or on the booklet
    // in the middle of the screen). keep() says whether it goes on: 'on', 'pause' (the phone put
    // away) or 'stop' (the page left, the booklet closed).
    function bkPhoneKeep() {
        if (current !== 'bookread' || bkStage) return 'stop';
        return wf.root && wf.root._minimized ? 'pause' : 'on';
    }

    function bkMusicPlay(file, host, keep) {
        if (bkMusic && bkMusic.file === file && bkMusic.keep === keep) return;
        bkMusicStop();
        var m = document.createElement('video');
        m.setAttribute('preload', 'auto');
        m.setAttribute('width', '16');
        m.setAttribute('height', '16');
        m.src = 'booklet/songs/' + file + '.webm';
        var cur = { file: file, media: m, watch: 0, paused: false, keep: keep, at: -1, still: 0, ticks: 0, nudges: 0 };
        // What the player went through, in ui/phone/diag/loadlog.cfg.
        ['playing', 'pause', 'waiting', 'stalled', 'ended', 'error'].forEach(function (name) {
            m.addEventListener(name, function () {
                traceLoad('booklet song ' + file + ' ' + name + ' at ' + Math.round((m.currentTime || 0) * 10) / 10 + (m.error ? ' error ' + m.error.code : ''));
            });
        });
        m.addEventListener('ended', function () {
            if (bkMusic !== cur) return;
            try { m.currentTime = 0; } catch (e) {}
            soundStart(m);
        });
        (host || soundHostEl()).appendChild(m);
        try { m.volume = Math.max(0, Math.min(1, soundSettings.volume / 100 * soundGame)); } catch (e) {}
        bkMusic = cur;
        traceLoad('booklet song ' + file + ' start in ' + (host ? 'the booklet' : 'the island'));
        soundStart(m);
        cur.watch = setInterval(function () {
            if (bkMusic !== cur) return;
            var k = keep();
            if (k === 'stop') { bkMusicStop('left'); return; }
            var away = k === 'pause';
            if (away && !cur.paused) {
                cur.paused = true;
                try { m.pause(); } catch (e) {}
            } else if (!away && cur.paused) {
                cur.paused = false;
                soundStart(m);
            }
            try { m.volume = Math.max(0, Math.min(1, soundSettings.volume / 100 * soundGame)); } catch (e) {}
            // A song whose clock stands still while it should play is started again where it was.
            var pos = m.currentTime || 0;
            cur.ticks += 1;
            if (!cur.paused && pos === cur.at) cur.still += 1; else cur.still = 0;
            cur.at = pos;
            if (cur.ticks % 10 === 0) traceLoad('booklet song ' + file + ' at ' + Math.round(pos * 10) / 10 + ' paused ' + m.paused + ' ready ' + m.readyState);
            if (cur.still >= 3 && cur.nudges < 5) {
                cur.still = 0;
                cur.nudges += 1;
                traceLoad('booklet song ' + file + ' stuck at ' + Math.round(pos * 10) / 10 + ', started again (' + cur.nudges + ')');
                try { m.currentTime = pos + 0.05; } catch (e) {}
                soundStart(m);
            }
        }, 1000);
    }

    function bkMusicStop(why) {
        var cur = bkMusic;
        if (!cur) return;
        traceLoad('booklet song ' + cur.file + ' stop (' + (why || 'asked') + ') at ' + Math.round((cur.media.currentTime || 0) * 10) / 10);
        bkMusic = null;
        clearInterval(cur.watch);
        try { cur.media.pause(); } catch (e) {}
        soundDrop(cur.media);
    }

    // ---------- a booklet just finished, in the middle of the screen ----------
    var BK_STAGE_POLL_MS = 5000;
    // On the first look, booklets written longer ago than this count as already shown.
    var BK_STAGE_FRESH_MS = 30 * 60000;
    var bkStage = null;
    var bkSeen = null;

    function bkSeenKey(b) { return b.id + ':' + (b.writtenAt || 0); }

    function bkSeenSave() {
        soft(call('uimod.cfg_save', { mod_id: SMS_MOD, section: 'ui/phone/saved', key: 'booklet-seen', value: JSON.stringify(bkSeen) }));
    }

    function bkStagePoll() {
        setTimeout(bkStagePoll, BK_STAGE_POLL_MS);
        if (bkStage) return;
        Promise.all([cfgValue(BK_SECTION, 'board'), bkSeen ? Promise.resolve(bkSeen) : cfgValue('ui/phone/saved', 'booklet-seen'), getMembers()]).then(function (r) {
            if (bkStage) return;
            var board = r[0] && r[0].people && typeof r[0].people === 'object' ? r[0] : null;
            if (!bkSeen) bkSeen = r[1] && r[1].ids && typeof r[1].ids === 'object' ? r[1] : { init: false, ids: {} };
            if (!board) return;
            var members = r[2] || [];
            var pick = null;
            var who = null;
            var changed = false;
            members.forEach(function (m) {
                var p = board.people[String(m.entity_id)];
                bkBooks(p).forEach(function (b) {
                    if (b.draft || bkSeen.ids[bkSeenKey(b)]) return;
                    // Booklets from before this phone looked are not shown all at once.
                    if (!bkSeen.init && Date.now() - (b.writtenAt || 0) > BK_STAGE_FRESH_MS) {
                        bkSeen.ids[bkSeenKey(b)] = Date.now();
                        changed = true;
                        return;
                    }
                    if (!pick || (b.writtenAt || 0) < (pick.writtenAt || 0)) { pick = b; who = m; }
                });
            });
            if (!bkSeen.init) { bkSeen.init = true; changed = true; }
            if (changed) bkSeenSave();
            if (pick) bkStageOpen(pick, who, members);
        }, function () {});
    }

    // Clicks out here do not get window.js's help (it only covers the phone): a mouseup on the
    // element the press started on is the click, and a native one right after is dropped.
    function bkStageClicks(el) {
        var down = null;
        var guard = false;
        el.addEventListener('mousedown', function (e) { down = e.target; }, true);
        el.addEventListener('mouseup', function (e) {
            var dt = down;
            down = null;
            if (!dt) return;
            var up = e.target;
            if (!(up === dt || (dt.contains && dt.contains(up)) || (up.contains && up.contains(dt)))) return;
            guard = true;
            var evt;
            try { evt = new MouseEvent('click', { bubbles: true, cancelable: true }); }
            catch (err) { evt = document.createEvent('MouseEvents'); evt.initEvent('click', true, true); }
            evt._synthetic = true;
            up.dispatchEvent(evt);
            setTimeout(function () { guard = false; }, 0);
        }, true);
        el.addEventListener('click', function (e) {
            if (e._synthetic) return;
            if (guard) { e.stopImmediatePropagation(); e.preventDefault(); }
        }, true);
    }

    // While the booklet is up it takes every click on the screen; afterwards only the phone does.
    // Hidden with a booklet on screen (the game's menu, a load), the phone gives the screen back; shown again, takes it.
    document.addEventListener('visibilitychange', function () {
        if (bkStage) bkStageRect(!document.hidden);
    });

    function bkStageRect(full) {
        try {
            if (full) {
                inzoi.view.setContentRect(0, 0, window.innerWidth || 1920, window.innerHeight || 1080);
                soft(call('uimod.cfg_save', { mod_id: SMS_MOD, section: 'ui/phone', key: 'rect', value: JSON.stringify({ rect: [0, 0, window.innerWidth || 1920, window.innerHeight || 1080], booklet: true, at: Date.now() }) }));
                if (typeof wf.root._rectForget === 'function') wf.root._rectForget();
            } else if (typeof wf.root._reportContentRect === 'function') wf.root._reportContentRect();
            else inzoi.view.setContentRect(wf.root.offsetLeft, wf.root.offsetTop, wf.root.offsetWidth, wf.root.offsetHeight);
        } catch (e) {}
    }

    // ---------- the spread: the booklet in the middle of the screen, in its stage's style ----------
    // A baby's stage is a cloth book, early childhood a crayon pad, childhood a pop-up book, the
    // teenage years a notebook with stickers, setting out a travel journal, adulthood a business
    // notebook, middle and old age a diary with photographs. The left page is the style's
    // picture of the page shown (it rises, or is stuck on, as the page turns); the right one is
    // the page itself.
    var BK_THEME = { Infant: 'baby', Toddler: 'crayon', Child: 'child', LowTeen: 'child', HighTeen: 'teen', Youth: 'travel', Adult: 'adult', Old: 'elder', Elderly: 'elder' };
    // The styles that fly in as a magic book and turn their pages; how long those take (ms).
    // The cloth book flies in as a magic book and turns its pages at the spine; the crayon pad is
    // tossed onto the table, its cover flips up and its sheets flip up over the top binding.
    var BK_FANCY = {
        baby: { fly: 'bk-fly', turn: 'book', open: 2300, turnMs: 860 },
        crayon: { fly: 'bk-toss', turn: 'pad', open: 1700, turnMs: 640 },
        child: { fly: 'bk-rise-in', turn: 'popup', open: 1900, turnMs: 860, flatMs: 300 },
        teen: { fly: 'bk-slide', turn: 'curl', open: 2000, turnMs: 860 },
        travel: { fly: 'bk-plane', turn: 'book', open: 2000, turnMs: 860, passport: true },
        adult: { fly: 'bk-thud', turn: 'book', open: 2000, turnMs: 620, crisp: true, leather: true },
        elder: { fly: 'bk-float-up', turn: 'book', open: 2700, turnMs: 1200, gentle: true, album: true }
    };
    var BK_VOL = { Infant: '01', Toddler: '02', Child: '03', LowTeen: '04', HighTeen: '05', Youth: '06', Adult: '07', Old: '08', Elderly: '09' };

    function bkAt(parent, cls, left, top, w, h, text) {
        var e = parent.appendChild(node('div', cls, text));
        e.style.position = 'absolute';
        e.style.left = left + 'px';
        e.style.top = top + 'px';
        if (w !== null) e.style.width = w + 'px';
        if (h !== null) e.style.height = h + 'px';
        return e;
    }

    function bkSvgAt(parent, left, top, size, box, paths, cls) {
        var s = glyphSvg(box);
        s.setAttribute('class', 'bk-svg' + (cls ? ' ' + cls : ''));
        s.setAttribute('width', String(size));
        s.setAttribute('height', String(size));
        s.style.position = 'absolute';
        s.style.left = left + 'px';
        s.style.top = top + 'px';
        for (var i = 0; i < paths.length; i++) glyphPath(s, paths[i][0], paths[i][1]);
        parent.appendChild(s);
        return s;
    }

    function bkShort(s, n) {
        s = String(s || '');
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    // What the picture on the left says about the page shown.
    function bkLeftLines(page, b) {
        if (page.kind === 'worries') return b.worries.map(function (w) { return w.title || w.text; });
        if (page.kind === 'friends') return b.friends.map(function (f) { return f.name; });
        if (page.kind === 'moments') return b.moments.slice();
        if (page.kind === 'achievements') return b.achievements.slice();
        if (page.kind === 'character') return (b.traits || []).slice();
        if (page.kind === 'letter') return ['写给你'];
        return [b.name || b.stageZh];
    }

    var BK_STAR = 'M12 2l2.9 6.2 6.8.8-5 4.6 1.3 6.7L12 17l-6 3.3 1.3-6.7-5-4.6 6.8-.8z';
    var BK_HEART = 'M12 21s-9-5.6-9-12a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.4-9 12-9 12z';

    // Childhood: a pop-up book. Every page is its own paper scene standing up from the fold: home
    // on its hills, a night village whose lit window lets out the worries, a big tree with the
    // people's name tags, a street of houses with signposts, a podium for the winners, a tree
    // growing the character on its leaves, and a sunset with birds for the last words.
    function bkPopSky(left, cls) {
        return bkAt(left, 'bk-c-sky ' + cls, 0, 0, 600, 780);
    }

    function bkPopHouse(left, x, y, tint, delay, lit) {
        var house = bkAt(left, 'bk-c-house ' + (tint || '') + ' bk-pop ' + delay, x, y, 150, 140);
        bkAt(house, 'bk-c-roof', 0, 0, 0, 0);
        bkAt(house, 'bk-c-wall', 20, 60, 110, 78);
        bkAt(house, 'bk-c-door', 62, 92, 26, 46);
        bkAt(house, 'bk-c-win' + (lit ? ' lit' : ''), 30, 78, 22, 20);
        bkAt(house, 'bk-c-win' + (lit ? ' lit' : ''), 98, 78, 22, 20);
        return house;
    }

    function bkPopHome(left, page, b) {
        var lines = bkLeftLines(page, b);
        bkPopSky(left, 'day');
        bkAt(left, 'bk-c-sun bk-pop d1', 70, 54, 96, 96);
        bkAt(left, 'bk-c-cloud bk-pop d2', 330, 80, 150, 46);
        bkAt(left, 'bk-c-cloud bk-pop d2', 380, 62, 70, 50);
        bkAt(left, 'bk-c-hill back bk-pop d2', -80, 330, 520, 300);
        bkAt(left, 'bk-c-hill bk-pop d3', 250, 380, 480, 300);
        bkPopHouse(left, 370, 268, '', 'd4', false);
        bkAt(left, 'bk-c-ground bk-pop d3', 0, 560, 600, 240);
        bkAt(left, 'bk-c-sign bk-pop d5', 70, 588, 460, null, bkShort(lines[0] || '', 40));
        if (lines[1]) bkAt(left, 'bk-c-sign small bk-pop d5', 110, 670, 380, null, bkShort(lines[1], 30));
    }

    function bkPopNight(left, page, b) {
        bkPopSky(left, 'night');
        bkAt(left, 'bk-c-moon bk-pop d1', 440, 60, 90, 90).appendChild(node('div', 'bk-c-moon-cut'));
        for (var i = 0; i < 6; i++) bkAt(left, 'bk-c-dot bk-pop d1', 60 + i * 70, 70 + (i % 3) * 40, 8, 8);
        bkAt(left, 'bk-c-hill night back bk-pop d2', -80, 420, 520, 300);
        bkAt(left, 'bk-c-hill night bk-pop d3', 250, 460, 480, 300);
        bkPopHouse(left, 220, 400, 'night', 'd4', true);
        var spots = [[60, 170], [300, 230], [90, 300]];
        for (var k = 0; k < spots.length; k++) {
            var w = b.worries[k];
            if (!w) break;
            var bub = bkAt(left, 'bk-c-think bk-pop d' + (5 + Math.min(1, k)), spots[k][0], spots[k][1], 240, null, bkShort(w.title || w.text, 11));
            bub.appendChild(node('div', 'bk-c-think-tail'));
        }
        bkAt(left, 'bk-c-ground night bk-pop d3', 0, 600, 600, 200);
    }

    function bkPopTree(left, page, b) {
        bkPopSky(left, 'day');
        var flags = bkAt(left, 'bk-c-bunting bk-pop d1', 30, 40, 540, 70);
        for (var i = 0; i < 8; i++) {
            var fl = flags.appendChild(node('div', 'bk-c-flag c' + (i % 4)));
            fl.style.left = (10 + i * 66) + 'px';
        }
        bkAt(left, 'bk-c-hill back bk-pop d2', -80, 400, 520, 300);
        bkAt(left, 'bk-c-trunk bk-pop d2', 270, 300, 60, 300);
        bkAt(left, 'bk-c-crown back bk-pop d3', 110, 120, 380, 260);
        bkAt(left, 'bk-c-crown bk-pop d3', 150, 150, 300, 220);
        var spots = [[150, 260], [330, 230], [240, 330]];
        for (var k = 0; k < spots.length; k++) {
            var fr = b.friends[k];
            if (!fr) break;
            var tag = bkAt(left, 'bk-c-tag bk-pop d' + (4 + Math.min(1, k)), spots[k][0], spots[k][1], 120, null, bkShort(fr.name, 5));
            tag.appendChild(node('div', 'bk-c-tag-string'));
        }
        bkAt(left, 'bk-c-ground bk-pop d3', 0, 580, 600, 220);
    }

    function bkPopStreet(left, page, b) {
        bkPopSky(left, 'day');
        bkAt(left, 'bk-c-sun bk-pop d1', 460, 50, 80, 80);
        var tints = ['', 'blue', 'green', 'pink'];
        for (var i = 0; i < 4; i++) bkPopHouse(left, 6 + i * 146, 300 - (i % 2) * 40, tints[i], 'd' + (2 + (i % 3)), false);
        bkAt(left, 'bk-c-road bk-pop d3', 0, 440, 600, 120);
        var spots = [[40, 560], [320, 580], [170, 660]];
        for (var k = 0; k < spots.length; k++) {
            var m = b.moments[k];
            if (!m) break;
            var post = bkAt(left, 'bk-c-post bk-pop d' + (4 + Math.min(1, k)), spots[k][0], spots[k][1], 240, null, bkShort(m, 16));
            post.appendChild(node('div', 'bk-c-post-pole'));
        }
    }

    function bkPopPodium(left, page, b) {
        bkPopSky(left, 'gold');
        var flags = bkAt(left, 'bk-c-bunting bk-pop d1', 30, 40, 540, 70);
        for (var i = 0; i < 8; i++) {
            var fl = flags.appendChild(node('div', 'bk-c-flag c' + ((i + 1) % 4)));
            fl.style.left = (10 + i * 66) + 'px';
        }
        bkAt(left, 'bk-c-cup bk-pop d2', 245, 170, 110, 110);
        bkAt(left, 'bk-c-cup-base bk-pop d2', 275, 280, 50, 40);
        var steps = [[220, 330, 160, 260, '1'], [60, 410, 160, 180, '2'], [380, 450, 160, 140, '3']];
        for (var k = 0; k < steps.length; k++) {
            var st = steps[k];
            var block = bkAt(left, 'bk-c-step s' + k + ' bk-pop d' + (3 + k), st[0], st[1], st[2], st[3]);
            block.appendChild(node('div', 'bk-c-step-no', st[4]));
            var a = b.achievements[k];
            if (a) block.appendChild(node('div', 'bk-c-step-text', bkShort(a.replace(/^你的?/, ''), 10)));
        }
        bkAt(left, 'bk-c-ground bk-pop d3', 0, 590, 600, 210);
    }

    function bkPopGrow(left, page, b) {
        bkPopSky(left, 'day');
        bkAt(left, 'bk-c-trunk bk-pop d1', 275, 330, 50, 280);
        bkAt(left, 'bk-c-branch l bk-pop d2', 180, 360, 110, 18);
        bkAt(left, 'bk-c-branch r bk-pop d2', 310, 330, 110, 18);
        var traits = (b.traits && b.traits.length ? b.traits : [b.name || '']).slice(0, 5);
        var small = [[200, 250, 60], [330, 230, 70], [260, 170, 50], [160, 330, 50], [400, 350, 55], [300, 120, 45]];
        for (var j = 0; j < small.length; j++) bkAt(left, 'bk-c-leaf c' + (j % 4) + ' bk-pop d2', small[j][0], small[j][1], small[j][2], small[j][2]);
        var spots = [[110, 300], [380, 270], [235, 200], [140, 180], [340, 150]];
        for (var i = 0; i < traits.length; i++) {
            bkAt(left, 'bk-c-leaf c' + (i % 4) + ' bk-pop d' + (3 + Math.min(2, i)), spots[i][0], spots[i][1], 130, 90, bkShort(traits[i], 4));
        }
        bkAt(left, 'bk-c-ground bk-pop d2', 0, 590, 600, 210);
        bkAt(left, 'bk-c-sign small bk-pop d5', 150, 660, 300, null, '一天一天长大');
    }

    function bkPopSunset(left, page, b) {
        bkPopSky(left, 'dusk');
        bkAt(left, 'bk-c-sunset bk-pop d1', 200, 330, 200, 200);
        bkAt(left, 'bk-c-hill dusk back bk-pop d2', -80, 420, 520, 300);
        bkAt(left, 'bk-c-hill dusk bk-pop d3', 250, 460, 480, 300);
        var svg = glyphSvg('0 0 600 400');
        svg.setAttribute('class', 'bk-svg bk-pop d4');
        svg.setAttribute('width', '600');
        svg.setAttribute('height', '400');
        svg.style.position = 'absolute';
        svg.style.left = '0px';
        svg.style.top = '60px';
        bkStroke(svg, 'M120 120 Q140 100 160 120 Q180 100 200 120', '#5a3a4a', 6);
        bkStroke(svg, 'M260 70 Q275 55 290 70 Q305 55 320 70', '#5a3a4a', 5);
        bkStroke(svg, 'M400 150 Q418 132 436 150 Q454 132 472 150', '#5a3a4a', 6);
        left.appendChild(svg);
        bkAt(left, 'bk-c-ground dusk bk-pop d3', 0, 600, 600, 200);
        bkAt(left, 'bk-c-sign bk-pop d5', 70, 640, 460, null, '「' + bkShort(b.letter || '写给你', 18) + '」');
    }

    var BK_POP = {
        cover: bkPopHome, worries: bkPopNight, friends: bkPopTree, moments: bkPopStreet,
        achievements: bkPopPodium, character: bkPopGrow, letter: bkPopSunset
    };

    function bkArtChild(left, page, b) {
        (BK_POP[page.kind] || bkPopHome)(left, page, b);
    }

    // The teenage years: a spiral notebook full of stickers, every page laid out like a scrapbook of
    // its own: the polaroid on the cover, a locked secret diary with notes peeking out of an
    // envelope, a photo-booth strip of the people, sticky notes held by a clip, a board of enamel
    // pins, a personality-quiz card, and a letter to the future sealed with a heart.
    function bkTeenCover(left, page, b, data) {
        var lines = bkLeftLines(page, b);
        bkAt(left, 'bk-t-title', 44, 40, 500, null, b.title);
        bkAt(left, 'bk-t-mark', 44, 136, 200, 14);
        var pol = bkAt(left, 'bk-t-polaroid bk-drop d1', 64, 196, 300, null);
        var pic = pol.appendChild(node('div', 'bk-t-pic ' + (BK_TINT[b.stage] || '')));
        pic.appendChild(node('div', 'bk-t-pic-sun'));
        pic.appendChild(node('div', 'bk-t-pic-hill'));
        pol.appendChild(node('div', 'bk-t-cap', bkShort(b.moments[0] || b.name || lines[0] || '', 13)));
        bkAt(left, 'bk-t-tape bk-drop d2', 150, 180, 130, 30);
        bkAt(left, 'bk-t-badge bk-pin d3', 384, 230, 118, 118, b.stageZh || '');
        bkSvgAt(left, 470, 390, 70, '0 0 24 24', [[BK_STAR, '#ffd34d']], 'bk-pin d4');
        bkSvgAt(left, 470, 640, 56, '0 0 24 22', [[BK_HEART, '#ff9bb8']], 'bk-pin d5');
        if (b.opening) bkAt(left, 'bk-t-hand', 60, 540, 400, null, bkShort(b.opening, 80));
    }

    function bkTeenSecret(left, page, b, data) {
        bkAt(left, 'bk-t-title', 44, 40, 500, null, '秘密日记');
        bkAt(left, 'bk-t-mark', 44, 92, 160, 14);
        var diary = bkAt(left, 'bk-t-diary bk-drop d1', 60, 140, 280, 360);
        diary.style.transform = 'rotate(-4deg)';
        diary.appendChild(node('div', 'bk-t-diary-strap'));
        diary.appendChild(node('div', 'bk-t-lock'));
        diary.appendChild(node('div', 'bk-t-diary-title', 'SECRET'));
        bkAt(left, 'bk-t-hush bk-pin d2', 420, 150, 110, 110, '嘘');
        for (var i = 0; i < 2; i++) {
            var w = b.worries[i];
            if (!w) break;
            var note = bkAt(left, 'bk-t-peek bk-drop d' + (4 + i), 270 + i * 120, 400 - i * 30, 150, 110, bkShort(w.title || w.text, 10));
            note.style.transform = 'rotate(' + (i ? 7 : -6) + 'deg)';
        }
        // In front of the notes, so they peek out of it.
        var env = bkAt(left, 'bk-t-envelope bk-drop d3', 250, 470, 300, 190);
        env.appendChild(node('div', 'bk-t-flap'));
        bkSvgAt(left, 380, 560, 46, '0 0 24 22', [[BK_HEART, '#ff7aa2']], 'bk-pin d6');
    }

    function bkTeenBooth(left, page, b, data) {
        bkAt(left, 'bk-t-title', 44, 40, 500, null, '大头贴');
        bkAt(left, 'bk-t-mark', 44, 92, 140, 14);
        var who = data.member ? (data.member.first_name || fullName(data.member)) : '';
        var people = [{ name: who }].concat(b.friends.slice(0, 2));
        var strip = bkAt(left, 'bk-t-strip bk-drop d1', 90, 130, 240, 40 + people.length * 190);
        strip.style.transform = 'rotate(-3deg)';
        var tints = ['pink', 'blue', 'mint'];
        for (var i = 0; i < people.length; i++) {
            var fr = strip.appendChild(node('div', 'bk-t-frame ' + tints[i]));
            fr.style.top = (20 + i * 190) + 'px';
            fr.appendChild(node('div', 'bk-t-frame-face', (people[i].name || '?').charAt(0)));
            fr.appendChild(node('div', 'bk-t-frame-name', bkShort(people[i].name || '', 6)));
        }
        bkAt(left, 'bk-t-tape bk-drop d2', 160, 110, 110, 30);
        bkSvgAt(left, 380, 200, 80, '0 0 24 22', [[BK_HEART, '#ff7aa2']], 'bk-pin d3');
        bkSvgAt(left, 450, 330, 54, '0 0 24 22', [[BK_HEART, '#ffb3c9']], 'bk-pin d4');
        bkSvgAt(left, 390, 470, 64, '0 0 24 24', [[BK_STAR, '#ffd34d']], 'bk-pin d5');
        bkAt(left, 'bk-t-hand', 360, 600, 200, null, 'best friends');
    }

    function bkTeenNotes(left, page, b, data) {
        bkAt(left, 'bk-t-title', 44, 40, 500, null, '便利贴');
        bkAt(left, 'bk-t-mark', 44, 92, 140, 14);
        var spots = [[50, 140, -4, 'yellow'], [310, 160, 3, 'pink'], [70, 420, 2, 'blue'], [320, 440, -3, 'mint']];
        for (var i = 0; i < spots.length; i++) {
            var m = b.moments[i];
            if (!m) break;
            var n = bkAt(left, 'bk-t-sticky ' + spots[i][3] + ' bk-drop d' + (1 + i), spots[i][0], spots[i][1], 230, 220);
            n.style.transform = 'rotate(' + spots[i][2] + 'deg)';
            n.appendChild(node('div', 'bk-t-sticky-text', bkShort(m, 30)));
        }
        bkAt(left, 'bk-t-clip bk-drop d5', 120, 110, 28, 50);
    }

    function bkTeenPins(left, page, b, data) {
        bkAt(left, 'bk-t-title', 44, 40, 500, null, '我的徽章');
        bkAt(left, 'bk-t-mark', 44, 92, 180, 14);
        bkAt(left, 'bk-t-denim bk-drop d1', 50, 140, 500, 520);
        var spots = [[90, 180], [320, 210], [130, 400], [350, 430]];
        var tints = ['pink', 'yellow', 'blue', 'mint'];
        for (var i = 0; i < spots.length; i++) {
            var a = b.achievements[i];
            if (!a) break;
            bkAt(left, 'bk-t-pin ' + tints[i] + ' bk-pin d' + (2 + i), spots[i][0], spots[i][1], 160, 160, bkShort(a.replace(/^你的?/, '').replace(/^第一次/, ''), 8));
        }
        bkAt(left, 'bk-t-ribbon bk-drop d6', 120, 680, 360, 56, '★ 闪闪发光 ★');
    }

    function bkTeenQuiz(left, page, b, data) {
        bkAt(left, 'bk-t-title', 44, 40, 500, null, '性格测试');
        bkAt(left, 'bk-t-mark', 44, 92, 160, 14);
        var card = bkAt(left, 'bk-t-quiz bk-drop d1', 60, 140, 480, 540);
        card.style.transform = 'rotate(2deg)';
        card.appendChild(node('div', 'bk-t-quiz-head', '测试结果：你是——'));
        var traits = (b.traits && b.traits.length ? b.traits : [b.name || '']).slice(0, 4);
        card.appendChild(node('div', 'bk-t-quiz-big', traits[0] || ''));
        for (var i = 0; i < traits.length; i++) {
            var row = card.appendChild(node('div', 'bk-t-quiz-row'));
            row.appendChild(node('div', 'bk-t-quiz-box', '✓'));
            row.appendChild(node('div', 'bk-t-quiz-text', traits[i]));
        }
        if (b.character) card.appendChild(node('div', 'bk-t-quiz-note', bkShort(b.character, 60)));
        bkSvgAt(left, 450, 120, 70, '0 0 24 24', [[BK_STAR, '#ffd34d']], 'bk-pin d3');
        bkSvgAt(left, 70, 640, 50, '0 0 24 22', [[BK_HEART, '#ff9bb8']], 'bk-pin d4');
    }

    function bkTeenLetter(left, page, b, data) {
        bkAt(left, 'bk-t-title', 44, 40, 500, null, '给未来的我');
        bkAt(left, 'bk-t-mark', 44, 92, 200, 14);
        var paper = bkAt(left, 'bk-t-paper bk-drop d1', 110, 140, 380, 320);
        paper.style.transform = 'rotate(-2deg)';
        paper.appendChild(node('div', 'bk-t-paper-text', bkShort(b.letter || '', 60)));
        var env = bkAt(left, 'bk-t-envelope big bk-drop d2', 80, 400, 440, 280);
        env.appendChild(node('div', 'bk-t-flap big'));
        var seal = bkAt(left, 'bk-t-seal bk-pin d4', 255, 470, 90, 90);
        var hs = glyphSvg('0 0 24 22');
        hs.setAttribute('class', 'bk-t-seal-heart');
        hs.setAttribute('width', '44');
        hs.setAttribute('height', '40');
        glyphPath(hs, BK_HEART, '#ffe1ea');
        seal.appendChild(hs);
    }

    var BK_TEEN = {
        cover: bkTeenCover, worries: bkTeenSecret, friends: bkTeenBooth, moments: bkTeenNotes,
        achievements: bkTeenPins, character: bkTeenQuiz, letter: bkTeenLetter
    };

    function bkArtTeen(left, page, b, data) {
        (BK_TEEN[page.kind] || bkTeenCover)(left, page, b, data);
    }

    // Adulthood: a business notebook in navy leather. Every page has its own piece of the working
    // life on the inside of the cover: the card in the pocket, a legal-pad memo of the worries with
    // a pen across it, a fan of name cards for the people, a desk-calendar agenda, a framed
    // certificate with a gold seal, a staff badge on its lanyard, and a letter on letterhead.
    // The writing goes on line by line, like ink, as a page lands.
    function bkAdultHead(left, text) {
        bkAt(left, 'bk-a-vol bk-ink d1', 48, 48, 500, null, text);
        bkAt(left, 'bk-a-rule', 48, 76, 60, 2);
    }

    function bkAdultCover(left, page, b, data) {
        bkAt(left, 'bk-a-vol bk-ink d1', 48, 48, 500, null, 'VOL. ' + (BK_VOL[b.stage] || '00') + ' · ' + String(b.stage || '').toUpperCase());
        bkAt(left, 'bk-a-title bk-ink d2', 48, 84, 500, null, b.title);
        bkAt(left, 'bk-a-rule', 48, 214, 60, 2);
        bkAt(left, 'bk-a-text bk-ink d3', 48, 238, 500, null, bkShort(b.opening, 90));
        bkAt(left, 'bk-a-pocket', 48, 560, 504, 180);
        var card = bkAt(left, 'bk-a-card bk-drop d4', 78, 520, 330, 170);
        card.appendChild(node('div', 'bk-a-card-name', data.member ? fullName(data.member) : ''));
        card.appendChild(node('div', 'bk-a-card-job', b.job || (b.name || b.stageZh)));
        card.appendChild(node('div', 'bk-a-card-note', '这一段的名片 · 收在内袋里'));
    }

    function bkAdultMemo(left, page, b, data) {
        bkAdultHead(left, 'MEMO · 待解决');
        var pad = bkAt(left, 'bk-a-legal bk-drop d2', 60, 120, 470, 520);
        pad.style.transform = 'rotate(-2deg)';
        pad.appendChild(node('div', 'bk-a-legal-top'));
        for (var i = 0; i < b.worries.length && i < 4; i++) {
            var w = b.worries[i];
            var row = pad.appendChild(node('div', 'bk-a-legal-row bk-ink d' + (3 + i)));
            row.appendChild(node('div', 'bk-a-legal-no', String(i + 1) + '.'));
            row.appendChild(node('div', 'bk-a-legal-text', bkShort(w.title || w.text, 14)));
        }
        bkAt(left, 'bk-a-stamp bk-pin d5', 360, 540, 160, 70, '待解决');
        var pen = bkAt(left, 'bk-a-pen bk-drop d6', 120, 650, 360, 22);
        pen.style.transform = 'rotate(-8deg)';
        pen.appendChild(node('div', 'bk-a-pen-cap'));
        pen.appendChild(node('div', 'bk-a-pen-nib'));
    }

    function bkAdultCards(left, page, b, data) {
        bkAdultHead(left, 'CONTACTS · 通讯录');
        var people = b.friends.slice(0, 3);
        for (var i = people.length - 1; i >= 0; i--) {
            var c = bkAt(left, 'bk-a-namecard bk-drop d' + (2 + i), 70 + i * 40, 140 + i * 180, 400, 170);
            c.style.transform = 'rotate(' + (-6 + i * 5) + 'deg)';
            c.appendChild(node('div', 'bk-a-namecard-bar c' + i));
            c.appendChild(node('div', 'bk-a-namecard-name', people[i].name || ''));
            c.appendChild(node('div', 'bk-a-namecard-role', people[i].family ? '家人' : '朋友'));
            c.appendChild(node('div', 'bk-a-namecard-line', bkShort(people[i].text || '', 22)));
        }
    }

    function bkAdultAgenda(left, page, b, data) {
        bkAdultHead(left, 'AGENDA · 日程');
        var cal = bkAt(left, 'bk-a-cal bk-drop d2', 60, 120, 480, 600);
        var top = cal.appendChild(node('div', 'bk-a-cal-top'));
        top.appendChild(node('div', 'bk-a-cal-day', String(b.days || 1)));
        top.appendChild(node('div', 'bk-a-cal-unit', '天 · ' + (b.name || b.stageZh)));
        var times = ['08:00', '12:30', '18:00', '21:00', '23:00'];
        for (var i = 0; i < b.moments.length && i < 5; i++) {
            var row = cal.appendChild(node('div', 'bk-a-cal-row bk-ink d' + (3 + Math.min(3, i))));
            row.appendChild(node('div', 'bk-a-cal-time', times[i]));
            row.appendChild(node('div', 'bk-a-cal-text', bkShort(b.moments[i], 18)));
        }
    }

    function bkAdultCert(left, page, b, data) {
        bkAdultHead(left, 'CERTIFICATE · 证书');
        var frame = bkAt(left, 'bk-a-frame bk-drop d2', 50, 120, 500, 560);
        var inner = frame.appendChild(node('div', 'bk-a-frame-inner'));
        inner.appendChild(node('div', 'bk-a-cert-title', '荣 誉 证 书'));
        inner.appendChild(node('div', 'bk-a-cert-who', (data.member ? fullName(data.member) : '') + '：'));
        for (var i = 0; i < b.achievements.length && i < 4; i++) {
            inner.appendChild(node('div', 'bk-a-cert-line bk-ink d' + (3 + i), bkShort(b.achievements[i], 18)));
        }
        bkAt(left, 'bk-a-seal bk-pin d6', 400, 560, 110, 110, '认证');
    }

    function bkAdultBadge(left, page, b, data) {
        bkAdultHead(left, 'PROFILE · 个人档案');
        bkAt(left, 'bk-a-lanyard l', 250, 90, 14, 130);
        bkAt(left, 'bk-a-lanyard r', 336, 90, 14, 130);
        var badge = bkAt(left, 'bk-a-badge bk-drop d2', 140, 210, 320, 440);
        badge.appendChild(node('div', 'bk-a-badge-clip'));
        badge.appendChild(node('div', 'bk-a-badge-photo', data.member ? (data.member.first_name || fullName(data.member)).charAt(0) : ''));
        badge.appendChild(node('div', 'bk-a-badge-name', data.member ? fullName(data.member) : ''));
        badge.appendChild(node('div', 'bk-a-badge-job', b.job || (b.name || b.stageZh)));
        var kw = badge.appendChild(node('div', 'bk-a-badge-kw'));
        (b.traits || []).slice(0, 4).forEach(function (t, i) { kw.appendChild(node('span', 'bk-a-badge-tag bk-ink d' + (3 + i), t)); });
    }

    function bkAdultLetter(left, page, b, data) {
        bkAdultHead(left, 'LETTER · 写给你');
        var sheet = bkAt(left, 'bk-a-letterhead bk-drop d2', 70, 120, 460, 560);
        sheet.appendChild(node('div', 'bk-a-lh-top', (data.member ? fullName(data.member) : '') + ' · ' + (b.name || b.stageZh)));
        sheet.appendChild(node('div', 'bk-a-lh-text bk-ink d3', bkShort(b.letter || '', 90)));
        sheet.appendChild(node('div', 'bk-a-lh-sign bk-ink d5', '此致 · 下一段见'));
        var pen = bkAt(left, 'bk-a-pen bk-drop d6', 260, 690, 300, 22);
        pen.style.transform = 'rotate(-12deg)';
        pen.appendChild(node('div', 'bk-a-pen-cap'));
        pen.appendChild(node('div', 'bk-a-pen-nib'));
    }

    var BK_ADULT = {
        cover: bkAdultCover, worries: bkAdultMemo, friends: bkAdultCards, moments: bkAdultAgenda,
        achievements: bkAdultCert, character: bkAdultBadge, letter: bkAdultLetter
    };

    function bkArtAdult(left, page, b, data) {
        (BK_ADULT[page.kind] || bkAdultCover)(left, page, b, data);
    }

    // Middle and old age: a photo album kept as a diary. Every page is its own: old photographs in
    // their corners on the cover, a bundle of letters tied with string for what weighed on the
    // heart, a group photograph captioned from the left, a page of small snapshots of the days,
    // newspaper clippings for what was achieved, pressed flowers named for the character, and a
    // last letter with a photograph clipped to it. The photographs fade in as if developing.
    function bkElderTitle(left, text) {
        bkAt(left, 'bk-e-title bk-fade d1', 40, 36, 520, null, text);
    }

    function bkElderPhoto(left, x, y, w, h, rot, tint, text, cap, delay) {
        var ph = bkAt(left, 'bk-e-photo bk-fade ' + delay, x, y, w, null);
        ph.style.transform = 'rotate(' + rot + 'deg)';
        var img = ph.appendChild(node('div', 'bk-e-img ' + tint));
        img.style.height = h + 'px';
        if (text) img.appendChild(node('div', 'bk-e-img-text', text));
        if (cap) ph.appendChild(node('div', 'bk-e-cap', cap));
        return ph;
    }

    function bkElderCover(left, page, b, data) {
        var pool = [b.title].concat(b.moments || []).filter(function (x) { return !!x; });
        bkElderPhoto(left, 44, 40, 250, 180, -3, 't0', bkShort(pool[1] || b.title, 16), b.title, 'd1');
        bkElderPhoto(left, 318, 70, 250, 180, 2.5, 't1', bkShort(pool[2] || b.name || '', 16), b.name || b.stageZh, 'd2');
        bkElderPhoto(left, 150, 350, 300, 200, -1.5, 't2', bkShort(pool[3] || '', 16), data.member ? fullName(data.member) : '', 'd3');
        bkAt(left, 'bk-e-corner tl', 140, 342, 0, 0);
        bkAt(left, 'bk-e-corner tr', 432, 342, 0, 0);
        bkAt(left, 'bk-e-corner bl', 140, 594, 0, 0);
        bkAt(left, 'bk-e-corner br', 432, 594, 0, 0);
        bkAt(left, 'bk-e-stem', 520, 600, 3, 110);
        bkAt(left, 'bk-e-petal', 502, 580, 40, 44);
        bkAt(left, 'bk-e-foot', 40, 740, 500, null, '翻一页，贴上一张');
    }

    function bkElderLetters(left, page, b, data) {
        bkElderTitle(left, '那些放不下的');
        var n = Math.min(3, b.worries.length);
        for (var i = n - 1; i >= 0; i--) {
            var w = b.worries[i];
            var env = bkAt(left, 'bk-e-letter bk-fade d' + (2 + i), 70 + i * 26, 140 + i * 160, 420, 220);
            env.style.transform = 'rotate(' + (i % 2 ? 3 : -3) + 'deg)';
            env.appendChild(node('div', 'bk-e-letter-stamp'));
            env.appendChild(node('div', 'bk-e-letter-text', bkShort(w.title || w.text, 12)));
            env.appendChild(node('div', 'bk-e-letter-line'));
        }
        bkAt(left, 'bk-e-string v', 270, 130, 6, 520);
        bkAt(left, 'bk-e-string h', 60, 296, 480, 6);
        bkAt(left, 'bk-e-knot bk-fade d5', 258, 284, 30, 30);
    }

    function bkElderGroup(left, page, b, data) {
        bkElderTitle(left, '合影');
        var who = data.member ? (data.member.first_name || fullName(data.member)) : '';
        var names = [who].concat(b.friends.slice(0, 3).map(function (f) { return f.name; }));
        var ph = bkElderPhoto(left, 50, 120, 500, 300, -1, 't2', '', '', 'd2');
        var img = ph.firstChild;
        for (var i = 0; i < names.length; i++) {
            var face = img.appendChild(node('div', 'bk-e-face', (names[i] || '?').charAt(0)));
            face.style.left = Math.round(40 + i * (320 / Math.max(1, names.length - 1))) + 'px';
            if (names.length === 1) face.style.left = '200px';
        }
        bkAt(left, 'bk-e-caption bk-fade d4', 60, 470, 480, null, '从左到右：' + names.join('、'));
        bkAt(left, 'bk-e-caption small bk-fade d5', 60, 540, 480, null, (b.name || b.stageZh) + ' · 一起走过的人');
        bkAt(left, 'bk-e-stem', 480, 620, 3, 110);
        bkAt(left, 'bk-e-petal', 462, 600, 40, 44);
    }

    function bkElderSnaps(left, page, b, data) {
        bkElderTitle(left, '那些日子');
        var tints = ['t0', 't1', 't2', 't1', 't0', 't2'];
        for (var i = 0; i < 6 && i < b.moments.length; i++) {
            var col = i % 2;
            var row = Math.floor(i / 2);
            bkElderPhoto(left, 50 + col * 270, 110 + row * 210, 230, 120, (i % 3 - 1) * 2, tints[i], bkShort(b.moments[i], 22), '第 ' + (i + 1) + ' 张', 'd' + (2 + Math.min(3, i)));
        }
    }

    function bkElderClippings(left, page, b, data) {
        bkElderTitle(left, '剪报');
        var spots = [[50, 120, -3], [300, 160, 4], [70, 400, 2], [310, 430, -2]];
        for (var i = 0; i < spots.length && i < b.achievements.length; i++) {
            var cl = bkAt(left, 'bk-e-clip bk-fade d' + (2 + i), spots[i][0], spots[i][1], 240, 230);
            cl.style.transform = 'rotate(' + spots[i][2] + 'deg)';
            cl.appendChild(node('div', 'bk-e-clip-paper', '晚报 · 第 ' + (i + 1) + ' 版'));
            cl.appendChild(node('div', 'bk-e-clip-head', bkShort(b.achievements[i].replace(/^你的?/, ''), 14)));
            for (var k = 0; k < 4; k++) cl.appendChild(node('div', 'bk-e-clip-line'));
            cl.appendChild(node('div', 'bk-e-tape'));
        }
    }

    function bkElderFlowers(left, page, b, data) {
        bkElderTitle(left, '压花');
        var traits = (b.traits && b.traits.length ? b.traits : [b.name || '']).slice(0, 4);
        var spots = [[80, 140], [330, 170], [100, 430], [350, 450]];
        var petals = ['#d9a6a0', '#e3c27a', '#b9a0d0', '#a0c0d9'];
        for (var i = 0; i < traits.length; i++) {
            var x = spots[i][0];
            var y = spots[i][1];
            bkAt(left, 'bk-e-stem bk-fade d' + (2 + i), x + 78, y + 70, 3, 150);
            for (var k = 0; k < 5; k++) {
                var p = bkAt(left, 'bk-e-petal bk-fade d' + (2 + i), x + 62 + Math.round(Math.cos(k * 1.256) * 24), y + 40 + Math.round(Math.sin(k * 1.256) * 24), 34, 38);
                p.style.background = petals[i % petals.length];
            }
            bkAt(left, 'bk-e-heart-dot bk-fade d' + (2 + i), x + 70, y + 50, 18, 18);
            bkAt(left, 'bk-e-label bk-fade d' + (3 + i), x + 10, y + 230, 160, null, traits[i]);
        }
    }

    function bkElderLetter(left, page, b, data) {
        bkElderTitle(left, '致这一生');
        var paper = bkAt(left, 'bk-e-paper bk-fade d2', 60, 110, 480, 520);
        paper.style.transform = 'rotate(-1deg)';
        paper.appendChild(node('div', 'bk-e-paper-text', bkShort(b.letter || '', 100)));
        paper.appendChild(node('div', 'bk-e-paper-sign', b.final ? '—— 这一生，谢谢你' : '—— 写于' + (b.name || b.stageZh)));
        bkElderPhoto(left, 50, 540, 180, 120, -6, 't0', '', '', 'd4');
        bkAt(left, 'bk-e-paperclip bk-fade d5', 120, 520, 24, 60);
    }

    var BK_ELDER = {
        cover: bkElderCover, worries: bkElderLetters, friends: bkElderGroup, moments: bkElderSnaps,
        achievements: bkElderClippings, character: bkElderFlowers, letter: bkElderLetter
    };

    function bkArtElder(left, page, b, data) {
        (BK_ELDER[page.kind] || bkElderCover)(left, page, b, data);
    }

    // A drawn line (the crayon drawing, the travel map's route).
    function bkStroke(svg, d, color, width, dash) {
        var p = svgEl('path');
        p.setAttribute('d', d);
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', color);
        p.setAttribute('stroke-width', String(width));
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        if (dash) p.setAttribute('stroke-dasharray', dash);
        svg.appendChild(p);
    }

    // The first stage: a soft cloth book, stitched round, every page with a felt picture of its
    // own: a crib mobile on the cover, secrets on clouds, the people who held the baby round a
    // blanket, footprints and a ruler for the days, felt rosettes for the firsts, a teddy holding
    // the character, and a night sky to say goodnight.
    var BK_FOOT = [['M20 18a14 18 0 1 0 0.1 0z'], ['M8 12m-4.5 0a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0'], ['M17 7m-4.5 0a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0'],
        ['M27 8m-4.5 0a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0'], ['M34 15m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0']];

    function bkFoot(left, x, y, size, color, cls) {
        return bkSvgAt(left, x, y, size, '0 0 40 55', BK_FOOT.map(function (p) { return [p[0], color]; }), cls);
    }

    // One felt thing on a string, swinging: the string and the thing hang from the top.
    function bkHang(left, x, len, cls, delay) {
        var outer = bkAt(left, 'bk-pop ' + delay, x, 156, 80, len + 90);
        var swing = outer.appendChild(node('div', 'bk-b-sway ' + cls.split(' ')[0]));
        var str = swing.appendChild(node('div', 'bk-b-string'));
        str.style.height = len + 'px';
        var thing = swing.appendChild(node('div', 'bk-b-hang ' + cls));
        thing.style.top = len + 'px';
        return thing;
    }

    function bkBabyCover(left, page, b, data, who) {
        bkAt(left, 'bk-b-hello', 60, 56, 480, null, '你好呀，' + who);
        bkAt(left, 'bk-b-bar bk-pop d1', 120, 140, 360, 18);
        var moon = bkHang(left, 150, 70, 's1 moon', 'd2');
        moon.appendChild(node('div', 'bk-b-moon-cut'));
        var star = bkHang(left, 260, 130, 's2 star', 'd3');
        var ss = glyphSvg('0 0 24 24');
        ss.setAttribute('width', '64');
        ss.setAttribute('height', '64');
        ss.setAttribute('class', 'bk-b-star-svg');
        glyphPath(ss, BK_STAR, '#ffd25a');
        star.appendChild(ss);
        var cloud = bkHang(left, 370, 90, 's3 cloud', 'd4');
        cloud.appendChild(node('div', 'bk-b-cloud-a'));
        cloud.appendChild(node('div', 'bk-b-cloud-b'));
        var badge = bkAt(left, 'bk-b-badge bk-pop d3', 70, 440, 180, 180);
        badge.appendChild(node('div', 'bk-b-badge-small', '这一段'));
        badge.appendChild(node('div', 'bk-b-badge-big', (b.days || 1) + ' 天'));
        bkFoot(left, 330, 460, 80, '#f6b3c4', 'bk-pop d4');
        bkFoot(left, 420, 490, 80, '#c7b4e6', 'bk-pop d5');
        bkAt(left, 'bk-b-ribbon bk-pop d5', 60, 668, 480, null, who + ' · ' + (b.name || b.stageZh));
    }

    function bkBabyWorries(left, page, b, data, who) {
        bkAt(left, 'bk-b-hello', 60, 56, 480, null, '小小的心事');
        bkAt(left, 'bk-b-hush bk-pop d1', 400, 60, 130, 56, '嘘——');
        var spots = [[50, 160], [230, 340], [60, 520]];
        var tints = ['', ' blue', ' lilac'];
        for (var i = 0; i < spots.length; i++) {
            var w = b.worries[i];
            if (!w) break;
            var outer = bkAt(left, 'bk-pop d' + (i + 2), spots[i][0], spots[i][1], 310, 140);
            var fl = outer.appendChild(node('div', 'bk-b-float f' + i));
            var c = fl.appendChild(node('div', 'bk-b-wcloud' + tints[i]));
            c.appendChild(node('div', 'bk-b-wcloud-bump a'));
            c.appendChild(node('div', 'bk-b-wcloud-bump b'));
            c.appendChild(node('div', 'bk-b-wcloud-text', bkShort(w.title || w.text, 12)));
        }
        var pillow = bkAt(left, 'bk-b-pillow bk-pop d5', 330, 640, 220, 80);
        pillow.appendChild(node('div', 'bk-b-pillow-text', '悄悄藏在枕头下'));
    }

    function bkBabyFriends(left, page, b, data, who) {
        bkAt(left, 'bk-b-hello', 60, 56, 480, null, '抱过你的人');
        bkSvgAt(left, 190, 280, 220, '0 0 24 22', [[BK_HEART, '#f9c6d3']], 'bk-pop d1');
        bkAt(left, 'bk-b-blanket-text bk-pop d2', 190, 360, 220, null, who);
        var spots = [[70, 170], [400, 190], [250, 560]];
        var tints = ['pink', 'blue', 'green'];
        for (var i = 0; i < spots.length; i++) {
            var f = b.friends[i];
            if (!f) break;
            var holder = bkAt(left, 'bk-b-friend bk-pop d' + (i + 3), spots[i][0], spots[i][1], 130, 160);
            holder.appendChild(node('div', 'bk-b-face ' + tints[i], (f.name || '?').charAt(0)));
            holder.appendChild(node('div', 'bk-b-face-name', bkShort(f.name, 6)));
        }
    }

    function bkBabyMoments(left, page, b, data, who) {
        bkAt(left, 'bk-b-hello', 60, 56, 480, null, '一天一天');
        bkFoot(left, 330, 150, 90, '#f6b3c4', 'bk-pop d1');
        bkFoot(left, 430, 180, 90, '#c7b4e6', 'bk-pop d2');
        bkAt(left, 'bk-b-note', 340, 300, 220, null, '小脚印');
        var badge = bkAt(left, 'bk-b-badge bk-pop d1', 70, 140, 190, 190);
        badge.appendChild(node('div', 'bk-b-badge-small', '记下了'));
        badge.appendChild(node('div', 'bk-b-badge-big', b.moments.length + ' 件事'));
        var ruler = bkAt(left, 'bk-b-ruler bk-pop d3', 60, 380, 480, 64);
        for (var t = 0; t < 12; t++) {
            var tick = ruler.appendChild(node('div', 'bk-b-tick' + (t % 2 ? ' short' : '')));
            tick.style.left = (24 + t * 38) + 'px';
        }
        bkAt(left, 'bk-b-note', 80, 456, 400, null, '身高尺 · 一点一点长高');
        var cls = ['pink', 'blue', 'green'];
        var icons = [[BK_HEART, '#f59a7a', '0 0 24 22'], [BK_STAR, '#ffd25a', '0 0 24 24'], ['M12 3c-3 4-5 6-5 9a5 5 0 0 0 10 0c0-3-2-5-5-9z', '#8fcf7a', '0 0 24 24']];
        for (var i = 0; i < 3; i++) {
            var patch = bkAt(left, 'bk-b-patch ' + cls[i] + ' bk-pop d' + (i + 3), 60 + i * 164, 520, 150, 180);
            var ic = glyphSvg(icons[i][2]);
            ic.setAttribute('class', 'bk-b-icon');
            ic.setAttribute('width', '54');
            ic.setAttribute('height', '54');
            glyphPath(ic, icons[i][0], icons[i][1]);
            patch.appendChild(ic);
            patch.appendChild(node('div', 'bk-b-patch-text', bkShort(b.moments[i] || b.title, 14)));
        }
    }

    function bkBabyMedals(left, page, b, data, who) {
        bkAt(left, 'bk-b-hello', 60, 56, 480, null, '第一次');
        var spots = [[70, 170], [320, 250], [110, 470], [350, 520]];
        var tints = ['gold', 'pink', 'blue', 'green'];
        for (var i = 0; i < spots.length; i++) {
            var a = b.achievements[i];
            if (!a) break;
            var m = bkAt(left, 'bk-b-medal bk-pop d' + (i + 1), spots[i][0], spots[i][1], 180, 220);
            m.appendChild(node('div', 'bk-b-tail l ' + tints[i]));
            m.appendChild(node('div', 'bk-b-tail r ' + tints[i]));
            var disc = m.appendChild(node('div', 'bk-b-rosette ' + tints[i]));
            disc.appendChild(node('div', 'bk-b-rosette-text', bkShort(a.replace(/^你的?/, '').replace(/^第一次/, ''), 8)));
        }
        for (var k = 0; k < 7; k++) {
            bkAt(left, 'bk-b-confetti c' + (k % 4) + ' bk-pop d5', 70 + k * 70, 720 - (k % 3) * 18, 14, 14);
        }
    }

    function bkBabyBear(left, page, b, data, who) {
        bkAt(left, 'bk-b-hello', 60, 56, 480, null, '你的小模样');
        var bear = bkAt(left, 'bk-b-bear bk-pop d1', 150, 140, 300, 470);
        bkAt(bear, 'bk-b-ear', 30, 10, 80, 80);
        bkAt(bear, 'bk-b-ear', 190, 10, 80, 80);
        bkAt(bear, 'bk-b-head', 40, 30, 220, 200);
        bkAt(bear, 'bk-b-eye', 105, 105, 16, 16);
        bkAt(bear, 'bk-b-eye', 179, 105, 16, 16);
        bkAt(bear, 'bk-b-muzzle', 110, 135, 80, 60);
        bkAt(bear, 'bk-b-nose', 138, 145, 24, 16);
        bkAt(bear, 'bk-b-body', 30, 210, 240, 240);
        bkAt(bear, 'bk-b-belly', 85, 260, 130, 150);
        var sign = bkAt(left, 'bk-b-sign bk-pop d3', 90, 400, 420, null, (b.traits && b.traits.length ? b.traits.join(' · ') : (b.name || '')));
        bkSvgAt(left, 470, 560, 46, '0 0 24 22', [[BK_HEART, '#f59a7a']], 'bk-pop d4');
        bkSvgAt(left, 80, 600, 36, '0 0 24 22', [[BK_HEART, '#c7b4e6']], 'bk-pop d5');
    }

    function bkBabyNight(left, page, b, data, who) {
        bkAt(left, 'bk-b-night', 0, 0, 600, 780);
        bkAt(left, 'bk-b-stitch night', 16, 16, 568, 748);
        var moon = bkAt(left, 'bk-b-bigmoon bk-pop d1', 340, 90, 160, 160);
        moon.appendChild(node('div', 'bk-b-bigmoon-cut'));
        var stars = [[80, 120, 26], [200, 80, 18], [260, 210, 22], [120, 300, 16], [480, 320, 20], [70, 460, 22], [520, 470, 16], [300, 360, 14]];
        for (var i = 0; i < stars.length; i++) {
            bkSvgAt(left, stars[i][0], stars[i][1], stars[i][2] * 2, '0 0 24 24', [[BK_STAR, '#ffe48a']], 'bk-b-twinkle t' + (i % 3));
        }
        var cloud = bkAt(left, 'bk-b-sleep bk-pop d3', 110, 520, 380, 120);
        cloud.appendChild(node('div', 'bk-b-cloud-a'));
        cloud.appendChild(node('div', 'bk-b-cloud-b'));
        cloud.appendChild(node('div', 'bk-b-zzz', 'Z z z'));
        bkAt(left, 'bk-b-goodnight bk-pop d4', 60, 680, 480, null, '晚安，' + who);
    }

    var BK_BABY = {
        cover: bkBabyCover, worries: bkBabyWorries, friends: bkBabyFriends, moments: bkBabyMoments,
        achievements: bkBabyMedals, character: bkBabyBear, letter: bkBabyNight
    };

    function bkArtBaby(left, page, b, data) {
        var who = data.member ? (data.member.first_name || fullName(data.member)) : '';
        if (page.kind !== 'letter') bkAt(left, 'bk-b-stitch', 16, 16, 568, 748);
        (BK_BABY[page.kind] || bkBabyCover)(left, page, b, data, who);
    }

    // Early childhood: a crayon pad bound at the top, every page a crayon drawing of its own whose
    // lines draw themselves on: home on the cover, a little rain for the worries, friends hand in
    // hand, drawings on the fridge, stars for what was learnt, a self-portrait, a rainbow.
    var BK_CRAYON = ['#e05a4a', '#6cc04a', '#3a7ad0', '#f5b82e', '#e0662e', '#b06ad0'];

    // A crayon line drawing itself on: n is its turn (when it starts).
    function bkDraw(svg, d, color, width, n) {
        bkStroke(svg, d, color, width);
        svg.lastChild.setAttribute('class', 'bk-k-draw d' + Math.min(9, n));
        return svg.lastChild;
    }

    function bkCrayonSheet(left) {
        var svg = glyphSvg('0 0 600 780');
        svg.setAttribute('class', 'bk-svg');
        svg.setAttribute('width', '600');
        svg.setAttribute('height', '780');
        svg.style.position = 'absolute';
        svg.style.left = '0px';
        svg.style.top = '0px';
        left.appendChild(svg);
        return svg;
    }

    function bkCrayonTitle(left, text, color) {
        var t = bkAt(left, 'bk-k-title bk-drop d1', 40, 46, 520, null, text);
        if (color) t.style.color = color;
        return t;
    }

    function bkCrayonCover(left, page, b, data, who) {
        var svg = bkCrayonSheet(left);
        bkDraw(svg, 'M522 140a52 52 0 1 0 -104 0a52 52 0 1 0 104 0', '#f5b82e', 12, 1);
        bkDraw(svg, 'M470 60 L470 40 M550 140 L572 140 M528 82 L545 65 M528 198 L545 215 M412 82 L395 65', '#f5b82e', 10, 2);
        bkDraw(svg, 'M452 155 Q470 172 490 155', '#4a3a2a', 6, 2);
        bkDraw(svg, 'M455 130 L455 131 M487 130 L487 131', '#4a3a2a', 12, 2);
        bkDraw(svg, 'M40 550 Q160 500 300 540 T580 530', '#6cc04a', 16, 3);
        bkDraw(svg, 'M120 530 L120 360 L230 290 L340 360 L340 535', '#e05a4a', 12, 4);
        bkDraw(svg, 'M200 535 L200 450 L260 450 L260 535', '#3a7ad0', 10, 5);
        bkDraw(svg, 'M420 330 L420 500 M420 370 L380 420 M420 370 L460 420 M420 500 L390 550 M420 500 L450 550', '#e0662e', 10, 6);
        bkDraw(svg, 'M448 305a28 28 0 1 0 -56 0a28 28 0 1 0 56 0', '#e0662e', 10, 6);
        bkDraw(svg, 'M70 190 Q100 150 140 190 Q170 150 210 190', '#9ac6e8', 12, 3);
        bkAt(left, 'bk-k-cap bk-drop d5', 40, 630, 420, null, '我和我的家 · ' + who + '画');
        bkAt(left, 'bk-k-sticker bk-drop d6', 470, 610, 86, 86, '真棒');
    }

    function bkCrayonRain(left, page, b, data, who) {
        bkCrayonTitle(left, '心里的小雨', '#3a7ad0');
        var svg = bkCrayonSheet(left);
        bkDraw(svg, 'M150 230 Q130 170 200 160 Q230 110 300 140 Q370 110 400 170 Q470 170 450 230 Q440 260 380 255 L200 255 Q140 260 150 230 Z', '#8a9ab0', 10, 1);
        bkDraw(svg, 'M200 290 L190 320 M260 290 L250 320 M320 290 L310 320 M380 290 L370 320 M230 340 L220 370 M350 340 L340 370', '#3a7ad0', 8, 2);
        bkDraw(svg, 'M220 470 Q300 380 380 470 Z', '#e05a4a', 10, 3);
        bkDraw(svg, 'M300 470 L300 540 Q300 560 280 555', '#4a3a2a', 8, 4);
        bkDraw(svg, 'M300 600 L300 680 M300 620 L270 650 M300 620 L330 650 M300 680 L280 720 M300 680 L320 720', '#e0662e', 9, 5);
        bkDraw(svg, 'M318 585a18 18 0 1 0 -36 0a18 18 0 1 0 36 0', '#e0662e', 9, 5);
        for (var i = 0; i < 2; i++) {
            var w = b.worries[i];
            if (!w) break;
            var note = bkAt(left, 'bk-k-note bk-drop d' + (6 + i), i ? 390 : 30, 520 + i * 40, 180, null, bkShort(w.title || w.text, 12));
            note.style.transform = 'rotate(' + (i ? 4 : -5) + 'deg)';
        }
    }

    function bkCrayonFriends(left, page, b, data, who) {
        bkCrayonTitle(left, '我的好朋友', '#e05a4a');
        var svg = bkCrayonSheet(left);
        bkDraw(svg, 'M300 250 C 260 200, 200 230, 230 280 L300 340 L370 280 C 400 230, 340 200, 300 250 Z', '#ff6b8a', 10, 1);
        var people = [{ name: who }].concat(b.friends.slice(0, 2));
        var xs = people.length === 3 ? [150, 300, 450] : [210, 390];
        for (var i = 0; i < people.length; i++) {
            var x = xs[i];
            var c = BK_CRAYON[(i * 2) % BK_CRAYON.length];
            bkDraw(svg, 'M' + (x + 30) + ' 440a30 30 0 1 0 -60 0a30 30 0 1 0 60 0', c, 9, 2 + i);
            bkDraw(svg, 'M' + x + ' 470 L' + x + ' 580 M' + x + ' 580 L' + (x - 25) + ' 650 M' + x + ' 580 L' + (x + 25) + ' 650', c, 9, 3 + i);
            if (i < people.length - 1) bkDraw(svg, 'M' + x + ' 510 L' + xs[i + 1] + ' 510', c, 9, 4 + i);
            bkAt(left, 'bk-k-name bk-drop d' + (5 + i), x - 70, 668, 140, null, bkShort(people[i].name || '', 6)).style.color = c;
        }
    }

    function bkCrayonFridge(left, page, b, data, who) {
        bkCrayonTitle(left, '贴在冰箱上的', '#3a7ad0');
        bkAt(left, 'bk-k-fridge bk-drop d1', 60, 120, 480, 620);
        bkAt(left, 'bk-k-handle', 500, 300, 14, 140);
        var spots = [[90, 150, -4], [300, 190, 5], [100, 420, 3], [310, 460, -3]];
        for (var i = 0; i < spots.length; i++) {
            var m = b.moments[i];
            if (!m) break;
            var paper = bkAt(left, 'bk-k-paper bk-drop d' + (2 + i), spots[i][0], spots[i][1], 190, 170);
            paper.style.transform = 'rotate(' + spots[i][2] + 'deg)';
            paper.appendChild(node('div', 'bk-k-magnet c' + (i % 4)));
            paper.appendChild(node('div', 'bk-k-paper-text', bkShort(m, 22)));
        }
    }

    function bkCrayonStars(left, page, b, data, who) {
        bkCrayonTitle(left, '我会了！', '#e0662e');
        var svg = bkCrayonSheet(left);
        var spots = [[150, 230], [420, 300], [170, 520]];
        for (var i = 0; i < spots.length; i++) {
            var a = b.achievements[i];
            if (!a) break;
            var x = spots[i][0];
            var y = spots[i][1];
            var r = 70;
            var pts = [];
            for (var k = 0; k < 10; k++) {
                var ang = -Math.PI / 2 + k * Math.PI / 5;
                var rr = k % 2 ? r * 0.45 : r;
                pts.push((x + Math.cos(ang) * rr).toFixed(0) + ' ' + (y + Math.sin(ang) * rr).toFixed(0));
            }
            bkDraw(svg, 'M' + pts.join(' L') + ' Z', '#f5b82e', 10, 1 + i * 2);
            bkAt(left, 'bk-k-star-text bk-drop d' + (2 + i * 2), x - 90, y + 80, 180, null, bkShort(a.replace(/^你的?/, ''), 10));
        }
        bkAt(left, 'bk-k-stamp bk-drop d8', 400, 520, 140, 140, '100分');
    }

    function bkCrayonMe(left, page, b, data, who) {
        bkCrayonTitle(left, '这就是我', '#b06ad0');
        var svg = bkCrayonSheet(left);
        bkDraw(svg, 'M400 330a100 110 0 1 0 -200 0a100 110 0 1 0 200 0', '#e0662e', 10, 1);
        bkDraw(svg, 'M205 290 L225 230 L245 280 L265 215 L290 275 L310 210 L335 272 L355 220 L375 285 L395 250', '#4a3a2a', 9, 2);
        bkDraw(svg, 'M262 320 L262 322 M338 320 L338 322', '#4a3a2a', 16, 3);
        bkDraw(svg, 'M255 375 Q300 410 345 375', '#e05a4a', 9, 4);
        bkDraw(svg, 'M240 360 L240 361 M360 360 L360 361', '#ff9bb0', 20, 4);
        bkDraw(svg, 'M300 440 L300 560 M300 470 L240 520 M300 470 L360 520 M300 560 L270 640 M300 560 L330 640', '#3a7ad0', 10, 5);
        var traits = (b.traits && b.traits.length ? b.traits : [b.name || '']).slice(0, 4);
        var spots = [[40, 160], [430, 170], [40, 500], [440, 520]];
        for (var i = 0; i < traits.length; i++) {
            var t = bkAt(left, 'bk-k-word bk-drop d' + (6 + i), spots[i][0], spots[i][1], 130, null, traits[i]);
            t.style.borderColor = BK_CRAYON[i % BK_CRAYON.length];
            t.style.color = BK_CRAYON[i % BK_CRAYON.length];
        }
    }

    function bkCrayonRainbow(left, page, b, data, who) {
        bkCrayonTitle(left, '给' + who + '的话', '#e05a4a');
        var svg = bkCrayonSheet(left);
        var colors = ['#e05a4a', '#f5b82e', '#6cc04a', '#3a7ad0', '#b06ad0'];
        for (var i = 0; i < colors.length; i++) {
            var r = 240 - i * 26;
            bkDraw(svg, 'M' + (300 - r) + ' 470 A' + r + ' ' + r + ' 0 0 1 ' + (300 + r) + ' 470', colors[i], 18, 1 + i);
        }
        bkDraw(svg, 'M40 560 Q170 520 300 560 T560 555', '#6cc04a', 16, 6);
        bkDraw(svg, 'M110 650a40 40 0 1 0 -80 0a40 40 0 1 0 80 0', '#f5b82e', 10, 7);
        bkAt(left, 'bk-k-cap bk-drop d8', 140, 630, 420, null, '雨停了，就有彩虹');
    }

    var BK_CRAYON_PAGES = {
        cover: bkCrayonCover, worries: bkCrayonRain, friends: bkCrayonFriends, moments: bkCrayonFridge,
        achievements: bkCrayonStars, character: bkCrayonMe, letter: bkCrayonRainbow
    };

    function bkArtCrayon(left, page, b, data) {
        var holes = bkAt(left, 'bk-k-band', 0, 0, 600, 26);
        for (var h = 0; h < 11; h++) {
            var hole = holes.appendChild(node('div', 'bk-k-hole'));
            hole.style.left = (30 + h * 50) + 'px';
        }
        var who = data.member ? (data.member.first_name || fullName(data.member)) : '';
        (BK_CRAYON_PAGES[page.kind] || bkCrayonCover)(left, page, b, data, who);
    }

    // Setting out: a travel journal, a map with the route so far, a boarding pass and stamps.
    // Setting out: a travel journal. Every page is a piece of the journey of its own: the map with
    // the route so far on the cover, a departure board of the worries, postcards to the people, a
    // strip of film of the everyday, a passport page of visa stamps for the achievements, a
    // suitcase covered in stickers for the character, and a compass with the next ticket. Ink
    // stamps thump on and routes draw themselves in as a page lands.
    function bkStamp(left, cls, x, y, w, h, delay) {
        var outer = bkAt(left, 'bk-thump ' + delay, x, y, w, h);
        var inner = outer.appendChild(node('div', 'bk-v-stamp ' + cls));
        inner.style.width = w + 'px';
        inner.style.height = h + 'px';
        return inner;
    }

    function bkTravelTitle(left, text) {
        bkAt(left, 'bk-v-title bk-drop d1', 40, 40, 520, null, text);
    }

    function bkTravelMap(left, page, b, data) {
        var lines = bkLeftLines(page, b);
        var pool = lines.concat(b.moments || []).filter(function (x) { return !!x; });
        var svg = glyphSvg('0 0 600 780');
        svg.setAttribute('class', 'bk-svg');
        svg.setAttribute('width', '600');
        svg.setAttribute('height', '780');
        svg.style.position = 'absolute';
        svg.style.left = '0px';
        svg.style.top = '0px';
        glyphPath(svg, 'M-20 140 Q90 100 160 150 T330 130 T480 170 T640 140 L640 -20 L-20 -20 Z', '#c9dbe0');
        glyphPath(svg, 'M-20 600 Q120 560 220 620 T420 600 T640 640 L640 800 L-20 800 Z', '#c9dbe0');
        glyphPath(svg, 'M60 260 Q140 230 210 270 Q260 300 250 360 Q240 420 170 430 Q100 440 70 380 Q40 320 60 260 Z', '#d9cfae');
        glyphPath(svg, 'M330 230 Q420 210 500 250 Q560 290 540 370 Q520 450 430 460 Q350 470 320 400 Q300 330 330 230 Z', '#d9cfae');
        bkDraw(svg, 'M150 340 C 230 300, 300 420, 380 330 S 470 300, 470 300', '#c0503a', 4, 2);
        glyphPath(svg, 'M159 340a9 9 0 1 0 -18 0a9 9 0 1 0 18 0', '#c0503a');
        glyphPath(svg, 'M479 300a9 9 0 1 0 -18 0a9 9 0 1 0 18 0', '#c0503a');
        left.appendChild(svg);
        bkAt(left, 'bk-v-place', 112, 360, 120, null, '出发');
        bkAt(left, 'bk-v-place', 440, 270, 140, null, '远方');
        var pass = bkAt(left, 'bk-v-pass bk-drop d1', 40, 40, 380, 150);
        var info = pass.appendChild(node('div', 'bk-v-pass-info'));
        info.appendChild(node('div', 'bk-v-pass-label', 'BOARDING PASS · 登机牌'));
        info.appendChild(node('div', 'bk-v-pass-route', (b.days ? b.days + ' 天' : '') + ' → ' + (b.name || b.stageZh)));
        info.appendChild(node('div', 'bk-v-pass-who', '乘客 ' + (data.member ? fullName(data.member) : '') + ' · ' + b.title));
        pass.appendChild(node('div', 'bk-v-pass-gate', 'GATE ' + (BK_VOL[b.stage] || '06')));
        var s1 = bkStamp(left, 'round', 380, 520, 150, 150, 'd4');
        s1.appendChild(node('div', 'bk-v-stamp-small', 'ARRIVED'));
        s1.appendChild(node('div', 'bk-v-stamp-big', bkShort(pool[0] || b.title, 5)));
        var s2 = bkStamp(left, 'square', 70, 540, 140, 130, 'd5');
        s2.appendChild(node('div', 'bk-v-stamp-small', 'VISITED'));
        s2.appendChild(node('div', 'bk-v-stamp-big', bkShort(pool[1] || b.name || '', 5)));
        bkAt(left, 'bk-v-tag bk-drop d4', 240, 670, 130, 56, '行李牌');
    }

    function bkTravelBoard(left, page, b, data) {
        bkTravelTitle(left, '途中的心事');
        var board = bkAt(left, 'bk-v-board bk-drop d2', 40, 120, 520, 120 + Math.max(1, b.worries.length) * 92);
        var head = board.appendChild(node('div', 'bk-v-board-head'));
        head.appendChild(node('div', 'bk-v-board-h dest', 'DEPARTURES · 心事'));
        head.appendChild(node('div', 'bk-v-board-h stat', 'STATUS'));
        for (var i = 0; i < b.worries.length && i < 4; i++) {
            var w = b.worries[i];
            var row = board.appendChild(node('div', 'bk-v-board-row'));
            row.appendChild(node('div', 'bk-v-board-no', 'Q' + (i + 1)));
            row.appendChild(node('div', 'bk-v-board-dest', bkShort(w.title || w.text, 9)));
            row.appendChild(node('div', 'bk-v-board-stat', '已登机'));
        }
        var cloud = bkStamp(left, 'round', 200, 520, 180, 180, 'd4');
        cloud.appendChild(node('div', 'bk-v-stamp-small', 'CLEARED'));
        cloud.appendChild(node('div', 'bk-v-stamp-big', '雨过天晴'));
    }

    function bkTravelPostcards(left, page, b, data) {
        bkTravelTitle(left, '寄给你们');
        var spots = [[40, 120, -4], [170, 330, 3], [60, 540, -2]];
        for (var i = 0; i < spots.length; i++) {
            var fr = b.friends[i];
            if (!fr) break;
            var card = bkAt(left, 'bk-v-postcard bk-drop d' + (2 + i), spots[i][0], spots[i][1], 380, 190);
            card.style.transform = 'rotate(' + spots[i][2] + 'deg)';
            card.appendChild(node('div', 'bk-v-post-stamp c' + i, (fr.name || '?').charAt(0)));
            card.appendChild(node('div', 'bk-v-post-to', '寄给 ' + bkShort(fr.name, 6)));
            card.appendChild(node('div', 'bk-v-post-text', bkShort(fr.text || '', 26)));
            card.appendChild(node('div', 'bk-v-post-line'));
        }
    }

    function bkTravelFilm(left, page, b, data) {
        bkTravelTitle(left, '一路拍下的');
        var n = Math.min(4, Math.max(1, b.moments.length));
        var strip = bkAt(left, 'bk-v-film bk-drop d2', 80, 120, 440, 30 + n * 150);
        for (var h = 0; h < 2; h++) {
            var holes = strip.appendChild(node('div', 'bk-v-film-holes ' + (h ? 'r' : 'l')));
            for (var k = 0; k < n * 5; k++) holes.appendChild(node('div', 'bk-v-film-hole'));
        }
        for (var i = 0; i < n; i++) {
            var fr = strip.appendChild(node('div', 'bk-v-film-frame c' + (i % 4)));
            fr.style.top = (15 + i * 150) + 'px';
            fr.appendChild(node('div', 'bk-v-film-text', bkShort(b.moments[i] || '', 22)));
            fr.appendChild(node('div', 'bk-v-film-no', String(i + 1) + 'A'));
        }
    }

    function bkTravelVisa(left, page, b, data) {
        bkTravelTitle(left, '签证页');
        bkAt(left, 'bk-v-visa bk-drop d1', 40, 110, 520, 620);
        var spots = [[70, 150, 'round', 170, 170], [300, 170, 'square', 220, 140], [90, 400, 'square', 210, 150], [330, 380, 'round', 180, 180], [190, 590, 'square', 220, 110]];
        var tints = ['', ' red', ' green', ' purple', ''];
        for (var i = 0; i < spots.length; i++) {
            var a = b.achievements[i];
            if (!a) break;
            var st = bkStamp(left, spots[i][2] + tints[i], spots[i][0], spots[i][1], spots[i][3], spots[i][4], 'd' + (2 + Math.min(3, i)));
            st.appendChild(node('div', 'bk-v-stamp-small', 'VISA · ' + String(i + 1)));
            st.appendChild(node('div', 'bk-v-stamp-mid', bkShort(a.replace(/^你的?/, '').replace(/^第一次/, ''), 8)));
        }
    }

    function bkTravelSuitcase(left, page, b, data) {
        bkTravelTitle(left, '我的行李箱');
        bkAt(left, 'bk-v-handle bk-drop d1', 240, 150, 120, 60);
        bkAt(left, 'bk-v-case bk-drop d1', 70, 190, 460, 440);
        bkAt(left, 'bk-v-case-strap', 280, 190, 40, 440);
        var traits = (b.traits && b.traits.length ? b.traits : [b.name || '']).slice(0, 5);
        var spots = [[110, 230, 150, 'c0'], [330, 250, 160, 'c1'], [120, 420, 160, 'c2'], [340, 450, 150, 'c3'], [220, 340, 140, 'c1']];
        for (var i = 0; i < traits.length; i++) {
            var sp = spots[i];
            bkAt(left, 'bk-v-sticker ' + sp[3] + ' bk-pin d' + (2 + Math.min(3, i)), sp[0], sp[1], sp[2], 90, bkShort(traits[i], 4));
        }
        bkAt(left, 'bk-v-wheel', 120, 630, 40, 40);
        bkAt(left, 'bk-v-wheel', 440, 630, 40, 40);
    }

    function bkTravelCompass(left, page, b, data) {
        bkTravelTitle(left, '下一站');
        var svg = glyphSvg('0 0 600 780');
        svg.setAttribute('class', 'bk-svg');
        svg.setAttribute('width', '600');
        svg.setAttribute('height', '780');
        svg.style.position = 'absolute';
        svg.style.left = '0px';
        svg.style.top = '0px';
        bkDraw(svg, 'M440 300a140 140 0 1 0 -280 0a140 140 0 1 0 280 0', '#24394a', 6, 1);
        bkDraw(svg, 'M420 300a120 120 0 1 0 -240 0a120 120 0 1 0 240 0', '#8a8378', 2, 2);
        glyphPath(svg, 'M300 170 L326 300 L300 330 L274 300 Z', '#c0503a');
        glyphPath(svg, 'M300 430 L274 300 L300 270 L326 300 Z', '#24394a');
        bkDraw(svg, 'M300 150 L300 168 M300 432 L300 450 M150 300 L168 300 M432 300 L450 300', '#24394a', 4, 3);
        left.appendChild(svg);
        bkAt(left, 'bk-v-dir n', 285, 118, 30, null, 'N');
        var next = bkAt(left, 'bk-v-pass bk-drop d4', 60, 500, 480, 150);
        var info = next.appendChild(node('div', 'bk-v-pass-info'));
        info.appendChild(node('div', 'bk-v-pass-label', 'NEXT STOP · 下一站'));
        info.appendChild(node('div', 'bk-v-pass-route', BK_NEXT_ZH[b.stage] || '下一段'));
        info.appendChild(node('div', 'bk-v-pass-who', bkShort(b.letter || '', 24)));
        next.appendChild(node('div', 'bk-v-pass-gate', 'GO'));
    }

    // The stage that comes after the one a booklet is of (for the ticket to the next stop).
    var BK_NEXT_ZH = { Infant: '幼儿', Toddler: '儿童', Child: '少年', LowTeen: '青少年', HighTeen: '青年', Youth: '成年', Adult: '中年', Old: '老年' };

    var BK_TRAVEL = {
        cover: bkTravelMap, worries: bkTravelBoard, friends: bkTravelPostcards, moments: bkTravelFilm,
        achievements: bkTravelVisa, character: bkTravelSuitcase, letter: bkTravelCompass
    };

    function bkArtTravel(left, page, b, data) {
        (BK_TRAVEL[page.kind] || bkTravelMap)(left, page, b, data);
    }

    // The right page: the page itself, with the style's touches.
    function bkSpreadBody(page, b, data, theme) {
        var body = bkPageBody(page, b, data);
        var i;
        if (theme === 'baby' || theme === 'crayon' || theme === 'travel') {
            var items = body.getElementsByClassName('bk-dot');
            for (i = 0; i < items.length; i++) {
                items[i].className += ' c' + (i % 4);
                items[i].insertBefore(node('span', 'bk-mark', theme === 'baby' ? String(i + 1) : ''), items[i].firstChild);
            }
        }
        if (theme === 'child') {
            var dots = body.getElementsByClassName('bk-dot');
            for (i = 0; i < dots.length; i++) {
                dots[i].className += ' c' + (i % 3);
                dots[i].appendChild(node('span', 'bk-tab', '拉 →'));
            }
        } else if (theme === 'adult') {
            var stars = body.getElementsByClassName('bk-star');
            for (i = 0; i < stars.length; i++) stars[i].insertBefore(node('span', 'bk-no', (i < 9 ? '0' : '') + (i + 1)), stars[i].firstChild);
        }
        return body;
    }

    function bkStageOpen(b, member, members) {
        var theme = BK_THEME[b.stage] || 'teen';
        var el = node('div', 'bk-stage');
        var wrap = el.appendChild(node('div', 'bk-sp-wrap bk-th-' + theme));
        var head = wrap.appendChild(node('div', 'bk-sp-head'));
        head.appendChild(node('div', 'bk-sp-kicker', b.final ? '这一生' : (member ? (member.first_name || fullName(member)) : '') + '长大了'));
        head.appendChild(node('div', 'bk-sp-name', (member ? fullName(member) + ' · ' : '') + (b.name || b.stageZh) + ' 成长册'));
        if (b.song) head.appendChild(node('div', 'bk-sp-song', '♪ ' + b.song.title));
        var spread = wrap.appendChild(node('div', 'bk-sp'));
        var left = spread.appendChild(node('div', 'bk-sp-left'));
        var gutter = spread.appendChild(node('div', 'bk-sp-gutter'));
        for (var g = 0; g < 8; g++) gutter.appendChild(node('div', 'bk-sp-ring'));
        var right = spread.appendChild(node('div', 'bk-sp-right'));
        var paper = right.appendChild(node('div', 'bk-stage-paper'));
        var tabs = theme === 'adult' ? right.appendChild(node('div', 'bk-a-tabs')) : null;
        if (theme === 'adult') right.appendChild(node('div', 'bk-a-ribbon'));
        var foot = right.appendChild(node('div', 'bk-stage-foot'));
        // The song's picture is drawn here: the engine only plays a video it draws.
        var slot = foot.appendChild(node('div', 'bk-stage-slot'));
        var music = foot.appendChild(node('button', 'ph-btn bk-stage-music', ''));
        music.setAttribute('type', 'button');
        var prev = foot.appendChild(node('button', 'ph-btn bk-stage-turn', '‹ 上一页'));
        prev.setAttribute('type', 'button');
        var count = foot.appendChild(node('div', 'bk-stage-count', ''));
        var next = foot.appendChild(node('button', 'ph-btn bk-stage-turn', '下一页 ›'));
        next.setAttribute('type', 'button');
        var close = foot.appendChild(node('button', 'ph-btn bk-stage-close', '合上册子'));
        close.setAttribute('type', 'button');
        var st = { el: el, book: b, page: 0, pages: bkPagesOf(b), paused: false, turning: false };
        var data = { member: member, members: members };
        // The styles that fly in, open their cover and turn their pages (the others just show).
        var fx = BK_FANCY[theme] || null;
        var fancy = !!fx;
        function paintLeft(box) {
            var page = st.pages[st.page];
            while (box.firstChild) box.removeChild(box.firstChild);
            if (theme === 'child') bkArtChild(box, page, b, data);
            else if (theme === 'adult') bkArtAdult(box, page, b, data);
            else if (theme === 'elder') bkArtElder(box, page, b, data);
            else if (theme === 'baby') bkArtBaby(box, page, b, data);
            else if (theme === 'crayon') bkArtCrayon(box, page, b, data);
            else if (theme === 'travel') bkArtTravel(box, page, b, data);
            else bkArtTeen(box, page, b, data);
        }
        function drawLeft() {
            left.className = 'bk-sp-left';
            paintLeft(left);
        }
        function draw() {
            drawLeft();
            drawRight();
        }
        function drawRight() {
            var page = st.pages[st.page];
            while (paper.firstChild) paper.removeChild(paper.firstChild);
            paper.className = 'bk-stage-paper' + (st.page === 0 ? ' cover' : '');
            paper.appendChild(bkSpreadBody(page, b, data, theme));
            if (tabs) {
                while (tabs.firstChild) tabs.removeChild(tabs.firstChild);
                st.pages.forEach(function (p, i) {
                    if (!p.title) return;
                    var t = tabs.appendChild(node('div', 'bk-a-tab' + (i === st.page ? ' on' : '')));
                    for (var c = 0; c < p.title.length && c < 4; c++) t.appendChild(node('div', 'bk-a-tab-ch', p.title.charAt(c)));
                });
            }
            labels();
        }
        function labels() {
            count.textContent = (st.page + 1) + ' / ' + st.pages.length;
            prev.className = 'ph-btn bk-stage-turn' + (st.page > 0 ? '' : ' off');
            next.className = 'ph-btn bk-stage-turn' + (st.page < st.pages.length - 1 ? '' : ' off');
            music.textContent = b.song ? (bkMusicOn ? '♪ 播放中' : '♪ 已静音') : '';
        }
        // A page laid over the spread while it turns: a copy of one side, folding to the spine or
        // unfolding from it, with the shadow of the fold.
        function leaf(cls, side, content) {
            if (side === spread) side = { offsetLeft: 0, offsetTop: 0, offsetWidth: spread.offsetWidth, offsetHeight: spread.offsetHeight };
            var lf = node('div', 'bk-leaf ' + cls);
            lf.style.left = side.offsetLeft + 'px';
            lf.style.top = side.offsetTop + 'px';
            lf.style.width = side.offsetWidth + 'px';
            lf.style.height = side.offsetHeight + 'px';
            content.className += ' bk-leaf-content';
            // The copy of the song's picture would load the song a second time.
            var vids = content.getElementsByTagName('video');
            for (var v = vids.length - 1; v >= 0; v--) vids[v].parentNode.removeChild(vids[v]);
            content.style.position = 'absolute';
            content.style.left = '0px';
            content.style.top = '0px';
            content.style.width = side.offsetWidth + 'px';
            content.style.height = side.offsetHeight + 'px';
            content.style.margin = '0px';
            lf.appendChild(content);
            lf.appendChild(node('div', 'bk-leaf-shade'));
            spread.appendChild(lf);
            return lf;
        }
        // Forward: the right page folds over to the spine, then the next left page unfolds from it
        // and its picture rises once it has landed. Back: the same the other way.
        function turn(dir) {
            var to = st.page + dir;
            if (st.turning || to < 0 || to >= st.pages.length) return;
            if (!fancy) {
                st.page = to;
                draw();
                return;
            }
            st.turning = true;
            var leaves = [];
            if (fx.turn === 'pad') {
                // The pad: the sheet flips up over the top binding and the next spread is under it;
                // back, the last sheet comes down over this one.
                var oldSpread = spread.cloneNode(true);
                st.page = to;
                if (dir > 0) {
                    draw();
                    leaves.push(leaf('flip-up', spread, oldSpread));
                } else {
                    leaves.push(leaf('hold', spread, oldSpread));
                    draw();
                    leaves.push(leaf('flip-down', spread, spread.cloneNode(true)));
                }
                setTimeout(function () {
                    leaves.forEach(function (lf) { if (lf.parentNode) lf.parentNode.removeChild(lf); });
                    st.turning = false;
                }, fx.turnMs);
                return;
            }
            if (fx.turn === 'popup' && !st.flat) {
                // The pop-up scene folds down into the page first, then the page turns.
                st.flat = true;
                left.className += ' bk-c-flatten';
                setTimeout(function () {
                    var keepSky = left.getElementsByClassName('bk-c-sky')[0];
                    while (left.firstChild) left.removeChild(left.firstChild);
                    if (keepSky) left.appendChild(keepSky);
                    left.className = 'bk-sp-left';
                    st.turning = false;
                    turn(dir);
                    st.flat = false;
                }, fx.flatMs);
                return;
            }
            var oldLeft = left.cloneNode(true);
            var oldRight = right.cloneNode(true);
            st.page = to;
            // The notebook's page curls round the spiral as it turns; the others fold at the spine.
            var fold = fx.turn === 'curl' ? 'curl' : (fx.crisp ? 'snap' : (fx.gentle ? 'soft' : 'fold'));
            var unfold = fx.turn === 'curl' ? 'uncurl' : (fx.crisp ? 'unsnap' : (fx.gentle ? 'unsoft' : 'unfold'));
            // The album lifts its sheet of tissue first.
            if (fx.gentle) leaves.push(leaf(dir > 0 ? 'tissue-r' : 'tissue-l', dir > 0 ? right : left, node('div', 'bk-e-tissue')));
            if (dir > 0) {
                leaves.push(leaf('hold', left, oldLeft));
                drawRight();
                leaves.push(leaf(fold + '-r', right, oldRight));
                var nl = node('div', 'bk-sp-left');
                paintLeft(nl);
                leaves.push(leaf(unfold + '-l', left, nl));
            } else {
                leaves.push(leaf('hold', right, oldRight));
                drawLeft();
                leaves.push(leaf(fold + '-l', left, oldLeft));
                drawRight();
                leaves.push(leaf(unfold + '-r', right, right.cloneNode(true)));
            }
            setTimeout(function () {
                if (dir > 0) drawLeft();
                leaves.forEach(function (lf) { if (lf.parentNode) lf.parentNode.removeChild(lf); });
                st.turning = false;
            }, fx.turnMs);
        }
        function keep() { return bkStage === st ? 'on' : 'stop'; }
        onTap(prev, function (e) { e.stopPropagation(); turn(-1); });
        onTap(next, function (e) { e.stopPropagation(); turn(1); });
        // Closed once the tap has been handled, never inside it (see the focus window's afterInput).
        onTap(close, function (e) { e.stopPropagation(); setTimeout(bkStageClose, 50); });
        onTap(music, function (e) {
            e.stopPropagation();
            bkMusicOn = !bkMusicOn;
            if (bkMusicOn && b.song) bkMusicPlay(b.song.file, slot, keep); else bkMusicStop('muted');
            labels();
        });
        bkStageClicks(el);
        // The phone's own song stops: this one plays.
        bkMusicStop('the booklet opened on screen');
        bkStage = st;
        if (fx && fx.turn === 'pad') {
            // A crayon pad tossed onto the table: crayon scraps fly as it lands, its kraft cover flips
            // up over the binding, and the drawing draws itself on after that.
            wrap.className += ' ' + fx.fly;
            for (var q = 0; q < 12; q++) bkAt(wrap, 'bk-scrap k' + q + ' c' + (q % 6), 612, 410, 26, 9);
            var pad = spread.appendChild(node('div', 'bk-pad-cover'));
            for (var ph = 0; ph < 22; ph++) {
                var hole = pad.appendChild(node('div', 'bk-k-hole'));
                hole.style.left = (30 + ph * 54) + 'px';
            }
            pad.appendChild(node('div', 'bk-pad-kicker', b.name || b.stageZh));
            pad.appendChild(node('div', 'bk-pad-big', (member ? (member.first_name || fullName(member)) : '') + '的画画本'));
            pad.appendChild(node('div', 'bk-pad-title', '「' + b.title + '」'));
            var scribble = glyphSvg('0 0 400 120');
            scribble.setAttribute('class', 'bk-pad-scribble');
            scribble.setAttribute('width', '400');
            scribble.setAttribute('height', '120');
            bkStroke(scribble, 'M20 80 Q60 20 100 80 T180 80 T260 80 T340 80', '#e05a4a', 10);
            bkStroke(scribble, 'M40 100 L120 100 M200 30a20 20 0 1 0 -40 0a20 20 0 1 0 40 0', '#3a7ad0', 8);
            bkStroke(scribble, 'M300 30 L320 70 L340 30 L360 70', '#6cc04a', 8);
            pad.appendChild(scribble);
            pad.appendChild(node('div', 'bk-pad-sticker', '真棒'));
            st.turning = true;
            document.body.appendChild(el);
            bkStageRect(true);
            drawRight();
            setTimeout(function () {
                if (bkStage !== st) return;
                drawLeft();
            }, fx.open - 500);
            setTimeout(function () {
                if (bkStage !== st) return;
                if (pad.parentNode) pad.parentNode.removeChild(pad);
                st.turning = false;
            }, fx.open);
        } else if (fx && fx.album) {
            // An old album rising slowly through warm light, dust in the air; its ribbon unties and
            // the leather cover opens slowly; the photographs fade in.
            wrap.className += ' ' + fx.fly;
            for (var mq = 0; mq < 12; mq++) {
                var mote = bkAt(el, 'bk-mote k' + mq, 300 + (mq * 113) % 1320, 380 + (mq * 71) % 520, 6 + (mq % 3) * 3, 6 + (mq % 3) * 3);
                mote.style.position = 'absolute';
            }
            spread.appendChild(node('div', 'bk-e-glow'));
            var ac = right.appendChild(node('div', 'bk-e-cover'));
            ac.appendChild(node('div', 'bk-e-cover-frame'));
            var win = ac.appendChild(node('div', 'bk-e-cover-window'));
            win.appendChild(node('div', 'bk-e-cover-window-in', b.title));
            ac.appendChild(node('div', 'bk-e-cover-big', b.final ? '这一生' : (b.name || b.stageZh)));
            ac.appendChild(node('div', 'bk-e-cover-who', member ? fullName(member) : ''));
            ac.appendChild(node('div', 'bk-e-bow'));
            left.className = 'bk-sp-left bk-unfold-e';
            st.turning = true;
            document.body.appendChild(el);
            bkStageRect(true);
            drawRight();
            setTimeout(function () {
                if (bkStage !== st) return;
                drawLeft();
                if (ac.parentNode) ac.parentNode.removeChild(ac);
                st.turning = false;
            }, fx.open);
        } else if (fx && fx.leather) {
            // A leather notebook put down on the desk: its elastic band slips off, the navy cover
            // swings open, and the writing goes on line by line.
            wrap.className += ' ' + fx.fly;
            var lc = right.appendChild(node('div', 'bk-a-cover'));
            lc.appendChild(node('div', 'bk-a-cover-deboss'));
            lc.appendChild(node('div', 'bk-a-cover-kicker', 'VOL. ' + (BK_VOL[b.stage] || '00')));
            lc.appendChild(node('div', 'bk-a-cover-big', b.name || b.stageZh));
            lc.appendChild(node('div', 'bk-a-cover-who', member ? fullName(member) : ''));
            lc.appendChild(node('div', 'bk-a-band'));
            left.className = 'bk-sp-left bk-unfold-t';
            st.turning = true;
            document.body.appendChild(el);
            bkStageRect(true);
            drawRight();
            setTimeout(function () {
                if (bkStage !== st) return;
                drawLeft();
                if (lc.parentNode) lc.parentNode.removeChild(lc);
                st.turning = false;
            }, fx.open);
        } else if (fx && fx.passport) {
            // A travel journal landing like a plane: a dotted flight path behind it, its passport
            // cover swinging open, the map unfolding, the route drawing itself in, the stamps.
            wrap.className += ' ' + fx.fly;
            for (var tq = 0; tq < 9; tq++) {
                var dot = bkAt(el, 'bk-trail k' + tq, 140 + tq * 85, 120 + Math.round(Math.pow(tq / 8, 1.6) * 330), 12, 12);
                dot.style.position = 'absolute';
            }
            var pc = right.appendChild(node('div', 'bk-v-cover'));
            pc.appendChild(node('div', 'bk-v-cover-ring'));
            pc.appendChild(node('div', 'bk-v-cover-kicker', 'TRAVEL JOURNAL'));
            pc.appendChild(node('div', 'bk-v-cover-big', '「' + b.title + '」'));
            pc.appendChild(node('div', 'bk-v-cover-who', (member ? fullName(member) + ' · ' : '') + (b.name || b.stageZh)));
            left.className = 'bk-sp-left bk-unfold-t';
            st.turning = true;
            document.body.appendChild(el);
            bkStageRect(true);
            drawRight();
            setTimeout(function () {
                if (bkStage !== st) return;
                drawLeft();
                if (pc.parentNode) pc.parentNode.removeChild(pc);
                st.turning = false;
            }, fx.open);
        } else if (fx && fx.turn === 'curl') {
            // A spiral notebook slid across the desk: hearts fly up as it stops, its sticker cover
            // flips over the spiral, the first left page opens, and its stickers go on one by one.
            wrap.className += ' ' + fx.fly;
            for (var hq = 0; hq < 10; hq++) {
                var hh = bkSvgAt(wrap, 612, 420, 34, '0 0 24 22', [[BK_HEART, hq % 2 ? '#ff9bb8' : '#ffd1dd']], 'bk-heart k' + hq);
                hh.style.position = 'absolute';
            }
            var tc = right.appendChild(node('div', 'bk-t-cover'));
            tc.appendChild(node('div', 'bk-t-cover-kicker', b.name || b.stageZh));
            tc.appendChild(node('div', 'bk-t-cover-big', '「' + b.title + '」'));
            tc.appendChild(node('div', 'bk-t-cover-who', member ? fullName(member) : ''));
            tc.appendChild(node('div', 'bk-t-cover-badge', 'DIARY'));
            var cst = glyphSvg('0 0 24 24');
            cst.setAttribute('class', 'bk-t-cover-star');
            cst.setAttribute('width', '80');
            cst.setAttribute('height', '80');
            glyphPath(cst, BK_STAR, '#ffd34d');
            tc.appendChild(cst);
            var cht = glyphSvg('0 0 24 22');
            cht.setAttribute('class', 'bk-t-cover-heart');
            cht.setAttribute('width', '70');
            cht.setAttribute('height', '64');
            glyphPath(cht, BK_HEART, '#ffffff');
            tc.appendChild(cht);
            left.className = 'bk-sp-left bk-unfold-t';
            st.turning = true;
            document.body.appendChild(el);
            bkStageRect(true);
            drawRight();
            setTimeout(function () {
                if (bkStage !== st) return;
                drawLeft();
                if (tc.parentNode) tc.parentNode.removeChild(tc);
                st.turning = false;
            }, fx.open);
        } else if (fx && fx.turn === 'popup') {
            // A pop-up book: it rises in, the pages riffle through to the first one, and the scene
            // stands up from the fold.
            wrap.className += ' ' + fx.fly;
            st.turning = true;
            document.body.appendChild(el);
            bkStageRect(true);
            drawRight();
            bkPopSky(left, 'day');
            ['c0', 'c1', 'c2', 'c3'].forEach(function (t, i) {
                setTimeout(function () {
                    if (bkStage !== st) return;
                    var a = leaf('riffle-fold', right, node('div', 'bk-riffle ' + t));
                    var z = leaf('riffle-unfold', left, node('div', 'bk-riffle ' + t));
                    setTimeout(function () {
                        [a, z].forEach(function (lf) { if (lf.parentNode) lf.parentNode.removeChild(lf); });
                    }, 380);
                }, 760 + i * 150);
            });
            setTimeout(function () {
                if (bkStage !== st) return;
                drawLeft();
                st.turning = false;
            }, fx.open);
        } else if (fancy) {
            // A magic book: it flies in closed, lands with a shower of sparks, its cover swings open
            // and the first left page unfolds; its picture rises after that.
            wrap.className += ' ' + fx.fly;
            spread.appendChild(node('div', 'bk-glow'));
            for (var k = 0; k < 10; k++) bkAt(wrap, 'bk-spark k' + k, 612, 410, 16, 16);
            var cover = right.appendChild(node('div', 'bk-cover'));
            cover.appendChild(node('div', 'bk-cover-stitch'));
            cover.appendChild(node('div', 'bk-cover-kicker', b.name || b.stageZh));
            cover.appendChild(node('div', 'bk-cover-big', '「' + b.title + '」'));
            cover.appendChild(node('div', 'bk-cover-who', member ? fullName(member) : ''));
            var cs = glyphSvg('0 0 24 24');
            cs.setAttribute('class', 'bk-cover-star');
            cs.setAttribute('width', '90');
            cs.setAttribute('height', '90');
            glyphPath(cs, BK_STAR, '#ffd25a');
            cover.appendChild(cs);
            left.className = 'bk-sp-left bk-unfold';
            st.turning = true;
            document.body.appendChild(el);
            bkStageRect(true);
            drawRight();
            setTimeout(function () {
                if (bkStage !== st) return;
                drawLeft();
                if (cover.parentNode) cover.parentNode.removeChild(cover);
                st.turning = false;
            }, fx.open);
        } else {
            document.body.appendChild(el);
            bkStageRect(true);
            draw();
        }
        if (b.song && bkMusicOn) bkMusicPlay(b.song.file, slot, keep);
        // The game waits while the booklet is read.
        st.paused = true;
        soft(call('environment.pause', {}));
        bkSeen.ids[bkSeenKey(b)] = Date.now();
        bkSeenSave();
    }

    function bkStageClose() {
        var st = bkStage;
        if (!st) return;
        bkStage = null;
        bkMusicStop('the booklet on screen closed');
        if (st.el.parentNode) st.el.parentNode.removeChild(st.el);
        bkStageRect(false);
        if (st.paused) soft(call('environment.resume', {}));
    }

    document.addEventListener('keydown', function (e) {
        if (bkStage && e.keyCode === 27) setTimeout(bkStageClose, 50);
    });
    setTimeout(bkStagePoll, 8000);

    function bookletGlyph() {
        var svg = glyphSvg('0 0 24 24');
        glyphPath(svg, 'M5 3.5h10.5A3.5 3.5 0 0 1 19 7v13.5H7.5A2.5 2.5 0 0 1 5 18V3.5zm2 14.5c0 .3.2.5.5.5H17V16H7.5a.5.5 0 0 0-.5.5v1.5z');
        glyphPath(svg, 'M12 6.6c-.9-1.2-3-.8-3 .9 0 1.4 1.7 2.5 3 3.6 1.3-1.1 3-2.2 3-3.6 0-1.7-2.1-2.1-3-.9z');
        return svg;
    }

