// focus -- 智能对话: a face-to-face talk with the character picked from the game's interaction
// menu. The reply service (sms-bridge lib/focus.js) answers; this page only writes what the
// played character says and shows what it hears. Files, under section ui/focus/talk/<player>-<target>:
//   said     [{id, text, at}]  written only here
//   session  {state: open | closed, at}  written only here
//   heard    [{id, text, at, reAt, face, gesture}]  written by the service
//   status   {state: online | thinking | error, error, at}  written by the service
//   lesson   the lesson board, written by the service during a lesson (lib/ielts.js): the term's
//            units shown on the left, the teacher's question on a card above the talk, and the
//            textbook open on the right at the page of the point being taught
// And ui/focus/request {seq, op: open | close, player, target, title}, written by the service: a
// talk it opens itself (a lesson, ielts.js), which this page shows without a menu pick.
// And ui/focus/book/<player> (written by the service): the textbook of the lessons had, shown by
// 复习功课, the second entry this page puts in the game's menu (trigger focus_review).
// And ui/focus/homework/<player> (lib/homework.js): the day's exercise sheet, shown by 写作业 (trigger
// focus_homework) or when the student does the game's homework, handed in through ui/focus/homework/answer.
// And ui/focus/voice {seq, state, text, key, enabled}, written by the service (lib/voice.js): voice
// input. While the player holds its key the box says it is listening; what was heard lands in
// the input and is said by itself a moment later, unless a key is pressed first to change it.
// What the page went through (loaded, menu picks, script errors), kept in ui/focus/diag.cfg.
var focusDiag = [];
function focusNote(what) {
    var d = new Date();
    focusDiag.push(d.getHours() + ':' + d.getMinutes() + ':' + d.getSeconds() + ' ' + what);
    if (focusDiag.length > 30) focusDiag.shift();
    try { inzoi.cli.execute('uimod.cfg_save', { mod_id: 'HouseholdBoard_I6IXIO', section: 'ui/focus', key: 'diag', value: focusDiag.join(' | ') }); } catch (e) {}
}
window.onerror = function (msg, src, line) { focusNote('error ' + msg + ' @' + line); };
focusNote('loaded');
(function () {
    'use strict';
    var MOD = 'HouseholdBoard_I6IXIO';
    var POLL_MS = 600;
    var TEXT_MAX = 200;
    var SHOWN = 40;
    var TYPE_MS = 45;
    var SERVICE_SILENT_MS = 8000;
    // The camera (HouseholdJournal B1 FocusCamera) turns to the character while the box is open;
    // the request is rewritten this often, and one not rewritten for 15 s counts as closed.
    var CAMERA_REFRESH_MS = 5000;
    var cameraTimer = null;

    var talk = null;          // { player, target, section, name, said: [], heard: [], openedAt, title }
    // The service's requests: only those made after this page loaded (or just before) count.
    var REQUEST_POLL_MS = 2000;
    var REQUEST_FRESH_MS = 60000;
    var requestSeq = (Date.now() - REQUEST_FRESH_MS) * 10;
    var closeTimer = null;
    var lastTrigger = { key: '', at: 0 };
    var pollTimer = null;
    var polling = false;
    var composing = false;
    var typing = null;        // { id, shown } the answer being typed out
    var typedIds = {};
    var serviceAt = 0;
    var LESSON_STALE_MS = 15 * 60000;
    var ASK_GROW = 150;       // the box grows upward by this much while a question card is up
    var lessonKey = '';       // what the board shows now, to redraw only on a change
    var askId = '';
    var answeredId = '';
    var grown = false;

    // ---- the game ----
    function extractJson(s) {
        if (typeof s !== 'string') return null;
        var i = s.indexOf('{');
        var j = s.indexOf('[');
        var start = i < 0 ? j : (j < 0 ? i : Math.min(i, j));
        if (start < 0) return null;
        try { return JSON.parse(s.slice(start)); } catch (e) { return null; }
    }

    function unwrap(res) {
        var v = res;
        if (typeof v === 'string') v = extractJson(v) || v;
        if (v && typeof v === 'object' && ('success' in v || 'data' in v)) {
            if (v.success === false) throw new Error(v.message || 'failed');
            var d = v.data;
            if (typeof d === 'string') d = extractJson(d);
            if (d && typeof d === 'object') return d;
        }
        return v;
    }

    function cli(cmd, params) {
        return Promise.resolve().then(function () { return inzoi.cli.execute(cmd, params || {}); }).then(unwrap);
    }

    function load(key) {
        return cli('uimod.cfg_load', { mod_id: MOD, section: talk.section, key: key }).then(function (r) {
            var raw = r && typeof r.value === 'string' ? r.value : '';
            if (!raw) return null;
            try { return JSON.parse(raw); } catch (e) { return null; }
        }, function () { return null; });
    }

    function save(section, key, value) {
        return cli('uimod.cfg_save', { mod_id: MOD, section: section, key: key, value: JSON.stringify(value) });
    }

    // ---- the page ----
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    var log = el('div');
    log.id = 'talk-log';
    var state = el('div');
    state.id = 'talk-state';
    var compose = el('div');
    compose.id = 'compose';
    var box = el('textarea');
    box.id = 'talk-box';
    box.setAttribute('maxlength', String(TEXT_MAX));
    box.setAttribute('rows', '1');
    box.setAttribute('placeholder', '想说点什么？');
    var send = el('button', 'off', '说');
    send.id = 'talk-send';
    send.type = 'button';
    var hint = el('span', '', 'Enter 说话 · Esc 结束');
    hint.id = 'talk-hint';
    compose.appendChild(box);
    compose.appendChild(send);
    compose.appendChild(hint);
    var askCard = el('div');
    askCard.id = 'ask-card';
    wf.content.appendChild(askCard);
    wf.content.appendChild(log);
    wf.content.appendChild(state);
    var voiceBar = el('div');
    voiceBar.id = 'voice-bar';
    voiceBar.appendChild(el('span', 'voice-dot'));
    var voiceText = voiceBar.appendChild(el('span', '', ''));
    wf.content.appendChild(voiceBar);
    wf.content.appendChild(compose);
    var sub = document.getElementById('title-sub');
    var title = document.getElementById('title-text');

    // ---- the lesson board ----
    var syllabus = document.getElementById('syllabus');
    var ASK_TYPES = { choice: '选择题', fill: '填空', translate: '翻译', make: '造句', speak: '口语' };

    function reportRect() {
        if (typeof wf.root._reportContentRect === 'function') { wf.root._reportContentRect(); return; }
        try { inzoi.view.setContentRect(wf.root.offsetLeft, wf.root.offsetTop, wf.root.offsetWidth, wf.root.offsetHeight); } catch (e) {}
    }

    function grow(on) {
        if (on === grown) return;
        var d = on ? ASK_GROW : -ASK_GROW;
        wf.root.style.top = Math.max(0, wf.root.offsetTop - d) + 'px';
        wf.root.style.height = (wf.root.offsetHeight + d) + 'px';
        grown = on;
        reportRect();
        log.scrollTop = log.scrollHeight;
    }

    function clearBoard() {
        lessonKey = '';
        askId = '';
        syllabus.className = '';
        while (syllabus.firstChild) syllabus.removeChild(syllabus.firstChild);
        askCard.className = '';
        while (askCard.firstChild) askCard.removeChild(askCard.firstChild);
        box.setAttribute('placeholder', '想说点什么？');
        grow(false);
        clearBook();
    }

    function showBoard(b) {
        if (!b || typeof b !== 'object' || b.closed || !(b.units instanceof Array) || Date.now() - (b.at || 0) > LESSON_STALE_MS) {
            if (lessonKey) clearBoard();
            return;
        }
        var key = JSON.stringify([b.units, b.points, b.right, b.checked, b.question && b.question.id, b.page, b.cover]);
        if (key === lessonKey) return;
        lessonKey = key;
        drawSyllabus(b);
        drawAsk(b.question);
        showBook(b);
    }

    function drawSyllabus(b) {
        while (syllabus.firstChild) syllabus.removeChild(syllabus.firstChild);
        syllabus.appendChild(el('div', 'sy-head', '雅思教材 · ' + (b.level || '')));
        syllabus.appendChild(el('div', 'sy-sub', '第 ' + (b.term || 1) + ' 学期 · 共 ' + b.units.length + ' 单元'));
        for (var i = 0; i < b.units.length; i++) {
            var u = b.units[i];
            var row = el('div', 'sy-unit ' + (u.state || 'next'));
            row.appendChild(el('span', 'sy-dot'));
            row.appendChild(el('span', 'sy-no', 'Unit ' + u.n));
            row.appendChild(el('span', '', u.topic));
            syllabus.appendChild(row);
            if (u.state !== 'now') continue;
            var now = el('div', 'sy-now');
            now.appendChild(el('div', 'sy-gram', '语法：' + u.grammar + (b.title ? ' · ' + b.title : '')));
            var pts = b.points instanceof Array ? b.points : [];
            for (var j = 0; j < pts.length; j++) {
                var p = pts[j];
                var pr = el('div', 'sy-pt ' + (p.state || 'next'));
                pr.appendChild(el('span', 'sy-dot'));
                pr.appendChild(el('span', '', p.en + '  ' + p.zh));
                if (p.result) pr.appendChild(el('span', 'sy-res ' + p.result, p.result === 'right' ? '对' : '错'));
                now.appendChild(pr);
            }
            syllabus.appendChild(now);
        }
        if (b.checked) syllabus.appendChild(el('div', 'sy-foot', '本课答对 ' + b.right + ' / ' + b.checked));
        syllabus.className = 'on';
    }

    function drawAsk(q) {
        var id = q && q.id ? q.id : '';
        if (id === askId) return;
        askId = id;
        while (askCard.firstChild) askCard.removeChild(askCard.firstChild);
        if (!q || !q.prompt) {
            askCard.className = '';
            box.setAttribute('placeholder', '想说点什么？');
            grow(false);
            return;
        }
        askCard.appendChild(el('div', 'ask-tag', '老师提问 · ' + (ASK_TYPES[q.type] || '问答')));
        askCard.appendChild(el('div', 'ask-prompt', q.prompt));
        var opts = q.options instanceof Array ? q.options : [];
        if (q.type === 'choice' && opts.length) {
            var row = el('div', 'ask-opts');
            for (var i = 0; i < opts.length; i++) row.appendChild(optionButton(q, String.fromCharCode(65 + i), opts[i]));
            askCard.appendChild(row);
            box.setAttribute('placeholder', '点一个选项，或者直接说');
        } else {
            askCard.appendChild(el('div', 'ask-hint', q.hint || (q.type === 'speak' ? '用英语回答，在下面写下你要说的话' : '在下面写下你的回答，按 Enter')));
            box.setAttribute('placeholder', q.type === 'speak' ? '用英语写下你要说的话' : '写下你的回答');
            setTimeout(function () { try { box.focus(); } catch (e) {} }, 60);
        }
        askCard.className = 'on';
        grow(true);
    }

    function optionButton(q, letter, text) {
        var b = el('button', 'ask-opt', letter + '. ' + text);
        b.type = 'button';
        b.addEventListener('click', function (e) {
            e.stopPropagation();
            if (answeredId === q.id || askId !== q.id) return;
            answeredId = q.id;
            var all = askCard.getElementsByTagName('button');
            for (var i = 0; i < all.length; i++) all[i].className = 'ask-opt off';
            b.className = 'ask-opt picked';
            sayText(text);
        });
        return b;
    }

    // ---- the textbook ----
    // Open on the right during a lesson, display only: the page of the point the teacher is on
    // (board.page: 0 the unit's opening page, a point's number, 'sum' the review), turning by
    // itself as the lesson goes on. The frames are drawn here; a point's page shows what the
    // lesson plan has (meaning, note, example) and, once the service has written them, the
    // printed extras (point.more). A checked point gets its stamp.
    // The same book is gone through again in the review window (复习功课, below): there its tabs
    // are pressed and nothing waits to be printed.
    var TB_TURN_MS = 620;
    function newBook(box, review) {
        // node: the page shown; page: its id ('0', '<n>', 'sum' or 'next'); key: what is printed on it
        return { box: box, review: !!review, host: null, node: null, page: '', key: '', tabs: [], tabIds: [], onTab: null };
    }
    var liveBook = newBook(document.getElementById('textbook'), false);
    var tb = liveBook;        // the book being drawn

    function part(parent, cls, text) {
        return parent.appendChild(el('div', cls, text));
    }

    function clearBook(bk) {
        bk = bk || liveBook;
        bk.box.className = bk.box.className.replace(/\s*\bon\b/, '');
        while (bk.box.firstChild) bk.box.removeChild(bk.box.firstChild);
        bk.host = null;
        bk.node = null;
        bk.page = '';
        bk.key = '';
        bk.tabs = [];
        bk.tabIds = [];
    }

    function tbFrame() {
        if (tb.host) return;
        part(tb.box, 'tb-board');
        part(tb.box, 'tb-edge');
        tb.host = part(tb.box, 'tb-host');
        for (var i = 0; i < 7; i++) part(tb.box, 'tb-ring').style.top = (46 + i * 76) + 'px';
        tb.box.className += ' on';
    }

    function tbDrawTabs(b, id) {
        var pts = b.points instanceof Array ? b.points : [];
        var want = [];
        if (id !== 'next') {
            want.push({ id: '0', text: '封', state: 'done' });
            for (var i = 0; i < pts.length; i++) want.push({ id: String(pts[i].n), text: String(pts[i].n), state: pts[i].state === 'done' ? 'done' : '' });
            want.push({ id: 'sum', text: '结', state: tb.review ? 'done' : '' });
        }
        while (tb.tabs.length > want.length) tb.box.removeChild(tb.tabs.pop());
        tb.tabIds = want.map(function (w) { return w.id; });
        for (var j = 0; j < want.length; j++) {
            var t = tb.tabs[j];
            if (!t) {
                t = tb.tabs[j] = part(tb.box, 'tb-tab', want[j].text);
                t.style.top = (30 + j * 46) + 'px';
                tbTabClick(tb, t, j);
            }
            if (t.textContent !== want[j].text) t.textContent = want[j].text;
            var cls = 'tb-tab ' + (want[j].id === id ? 'now' : want[j].state);
            if (t.className !== cls) t.className = cls;
        }
    }

    function tbTabClick(bk, t, j) {
        t.addEventListener('click', function (e) {
            e.stopPropagation();
            if (bk.onTab && bk.tabIds[j] !== undefined) bk.onTab(bk.tabIds[j]);
        });
    }

    // Grey bars where the print has not come yet.
    function tbWaiting(parent, n) {
        if (tb.review) return;
        for (var i = 0; i < n; i++) part(parent, 'tb-bar' + (i === n - 1 ? ' s' : ''));
        part(parent, 'tb-wait-note', '这一页正在印……');
    }

    // "english / 中文" in two.
    function tbPair(s) {
        var m = /^(.*?)\s*[\/／]\s*(.*)$/.exec(String(s || ''));
        return m ? { en: m[1], zh: m[2] } : { en: String(s || ''), zh: '' };
    }

    // A sentence with the headword marked as with a highlighter.
    function tbMarked(parent, cls, sentence, word) {
        var row = part(parent, cls);
        var low = sentence.toLowerCase();
        var words = String(word || '').split(/\s+/).sort(function (a, b) { return b.length - a.length; });
        var tries = [String(word || '')];
        if (words[0] && words[0] !== word) tries.push(words[0]);
        if (words[0] && words[0].length > 4) tries.push(words[0].slice(0, words[0].length - 1));
        var at = -1;
        var len = 0;
        for (var i = 0; i < tries.length && at < 0; i++) {
            if (!tries[i]) continue;
            at = low.indexOf(tries[i].toLowerCase());
            len = tries[i].length;
        }
        if (at < 0) { row.appendChild(el('span', '', sentence)); return row; }
        while (/[A-Za-z]/.test(sentence.charAt(at + len))) len++;
        row.appendChild(el('span', '', sentence.slice(0, at)));
        row.appendChild(el('span', 'tb-hl', sentence.slice(at, at + len)));
        row.appendChild(el('span', '', sentence.slice(at + len)));
        return row;
    }

    function tbTipAndError(body, more, cls) {
        if (!more.tip && !more.right) return;
        var bottom = part(body, 'tb-bottom ' + cls);
        if (more.tip) {
            var st = part(part(bottom, 'tb-sticky-wrap'), 'tb-sticky');
            part(st, 'tb-sticky-k', '记忆小窍门');
            part(st, '', more.tip);
        }
        if (more.right) {
            var err = part(bottom, 'tb-err');
            if (more.tip) part(err, 'tb-err-k', '易错提醒');
            if (more.wrong) {
                var bad = part(err, 'tb-err-row');
                part(bad, 'tb-badge bad', '误');
                part(bad, 'tb-err-bad', more.wrong);
            }
            var ok = part(err, 'tb-err-row');
            part(ok, 'tb-badge ok', '正');
            part(ok, 'tb-err-ok', more.right);
        }
    }

    function tbExample(body, p, cls) {
        if (!p.example) return;
        var ex = tbPair(p.example);
        part(body, 'tb-h ' + cls, '例句 EXAMPLE');
        tbMarked(body, 'tb-ex-en ' + cls, ex.en, p.kind === 'grammar' ? '' : p.en);
        if (ex.zh) part(body, 'tb-ex-zh ' + cls, ex.zh);
    }

    // A word's page. base: the animation class of what the plan gave ('' when only the print is new).
    function tbWordPage(body, p, base) {
        var more = p.more;
        part(body, 'tb-tag ' + base, 'NEW WORD · ' + (p.n < 10 ? '0' : '') + p.n);
        var row = part(body, 'tb-word-row ' + base);
        part(row, 'tb-word', p.en);
        if (more && more.pos) part(row, 'tb-pos', more.pos);
        if (more && more.syll) part(row, 'tb-syll', more.syll);
        part(part(body, 'tb-zh-row ' + base), 'tb-zh', p.zh);
        if (p.note) part(body, 'tb-note ' + base + ' d1', p.note);
        if (!more) {
            tbExample(body, p, base + ' d2');
            tbWaiting(body, 3);
            return;
        }
        if (more.colls && more.colls.length) {
            part(body, 'tb-h tb-in d2', '搭配 COLLOCATIONS');
            for (var i = 0; i < more.colls.length; i++) {
                var c = part(body, 'tb-coll tb-in d2');
                part(c, 'tb-coll-dot');
                part(c, 'tb-coll-en', more.colls[i].en);
                part(c, 'tb-coll-zh', more.colls[i].zh);
            }
        }
        tbExample(body, p, base + ' d3');
        if (more.family) {
            var fam = part(body, 'tb-family tb-in d4');
            fam.appendChild(el('span', 'tb-family-k', '词族'));
            fam.appendChild(el('span', '', more.family));
        }
        tbTipAndError(body, more, 'tb-in d5');
    }

    function tbGrammarPage(body, p, base) {
        var more = p.more;
        part(body, 'tb-tag ' + base, 'GRAMMAR FOCUS');
        part(body, 'tb-g-name ' + base, p.zh);
        part(body, 'tb-g-zh ' + base, p.en);
        if (more && more.formula) part(body, 'tb-formula tb-in d1', more.formula);
        if (p.note) part(body, 'tb-note ' + base + ' d1', p.note);
        if (!more) {
            tbExample(body, p, base + ' d2');
            tbWaiting(body, 3);
            return;
        }
        if (more.forms && more.forms.length) {
            part(body, 'tb-h tb-in d2', '三种句式 FORMS');
            for (var i = 0; i < more.forms.length; i++) {
                var f = part(body, 'tb-form tb-in d' + (2 + i));
                part(f, 'tb-form-label f' + i, more.forms[i].label || ['肯定', '否定', '疑问'][i]);
                var t = part(f, '');
                part(t, 'tb-form-en', more.forms[i].en);
                if (more.forms[i].zh) part(t, 'tb-form-zh', more.forms[i].zh);
            }
        } else {
            tbExample(body, p, base + ' d2');
        }
        if (more.signals) {
            part(body, 'tb-h tb-in d5', '标志词 SIGNAL WORDS');
            var sg = part(body, 'tb-signals tb-in d5');
            var words = more.signals.split(/\s*[,，、;；]\s*/);
            for (var k = 0; k < words.length && k < 6; k++) if (words[k]) sg.appendChild(el('span', 'tb-signal', words[k]));
        }
        if (more.tip) {
            var rhyme = part(body, 'tb-rhyme tb-in d6');
            rhyme.appendChild(el('span', 'tb-rhyme-k', '口诀'));
            rhyme.appendChild(el('span', '', more.tip));
        }
        tbTipAndError(body, { wrong: more.wrong, right: more.right }, 'tb-in d6');
    }

    function tbCoverPage(body, b, base) {
        var u = b.unit || {};
        var top = part(body, 'tb-cv-top ' + base);
        var no = part(top, 'tb-cv-no');
        part(no, 'tb-cv-no-k', 'UNIT');
        part(no, 'tb-cv-no-n', (u.n < 10 ? '0' : '') + (u.n || 1));
        var main = part(top, 'tb-cv-main');
        part(main, 'tb-cv-topic', u.topic || '');
        part(main, 'tb-cv-gram', '语法 · ' + (u.grammar || ''));
        if (b.title) part(main, 'tb-cv-title', '本课：' + b.title);
        var cover = b.cover;
        if (cover && cover.goal) {
            part(body, 'tb-h tb-in d1', '学习目标 GOAL');
            part(body, 'tb-cv-goal tb-in d1', cover.goal);
        }
        part(body, 'tb-h ' + base + ' d2', '本课内容 IN THIS LESSON');
        var pts = b.points instanceof Array ? b.points : [];
        for (var i = 0; i < pts.length; i++) {
            var r = part(body, 'tb-cv-pt ' + base + ' d' + Math.min(6, 2 + i));
            part(r, 'tb-cv-pt-n ' + (pts[i].kind || 'word'), String(pts[i].n));
            part(r, 'tb-cv-pt-en', pts[i].kind === 'grammar' ? pts[i].zh : pts[i].en);
            part(r, 'tb-cv-pt-zh', pts[i].kind === 'grammar' ? pts[i].en : pts[i].zh);
        }
        if (!cover) { tbWaiting(body, 2); return; }
        if (cover.warmup) {
            var w = tbPair(cover.warmup);
            part(body, 'tb-h tb-in d5', '热身 WARM-UP');
            var bub = part(body, 'tb-bubble tb-in d5');
            part(bub, 'tb-bubble-en', w.en);
            if (w.zh) part(bub, 'tb-bubble-zh', w.zh);
        }
    }

    function tbSumPage(body, b, base) {
        var top = part(body, 'tb-sum-top ' + base);
        var ring = part(top, 'tb-sum-ring');
        part(ring, 'tb-sum-score', (b.right || 0) + ' / ' + (b.checked || 0));
        part(ring, 'tb-sum-score-k', '答对');
        var tt = part(top, 'tb-sum-title');
        part(tt, 'tb-sum-h1', '本课小结');
        part(tt, 'tb-sum-h2', 'Unit ' + ((b.unit && b.unit.n) || 1) + ' · ' + ((b.unit && b.unit.topic) || '') + (b.title ? ' · ' + b.title : ''));
        part(body, 'tb-h ' + base + ' d1', '今天学的 REVIEW');
        var pts = b.points instanceof Array ? b.points : [];
        for (var i = 0; i < pts.length; i++) {
            var r = part(body, 'tb-sum-row ' + base + ' d' + Math.min(6, 1 + i));
            part(r, 'tb-badge ' + (pts[i].result === 'right' ? 'ok' : (pts[i].result === 'wrong' ? 'bad' : '')), pts[i].result === 'right' ? '对' : (pts[i].result === 'wrong' ? '错' : '·'));
            part(r, 'tb-sum-en', pts[i].kind === 'grammar' ? pts[i].zh : pts[i].en);
            part(r, 'tb-sum-zh', pts[i].kind === 'grammar' ? pts[i].en : pts[i].zh);
        }
        if (b.cover && b.cover.homework) {
            part(body, 'tb-h tb-in d5', '课后小任务 HOMEWORK');
            part(body, 'tb-home tb-in d5', b.cover.homework);
        }
        part(part(body, 'tb-stamp-wrap low'), 'tb-stamp over', '下课');
    }

    // The review book's last page: the unit that comes next.
    function tbNextPage(body, b, base) {
        var u = b.unit || {};
        part(body, 'tb-tag ' + base, 'COMING UP · 下一课');
        var top = part(body, 'tb-cv-top ' + base);
        var no = part(top, 'tb-cv-no next');
        part(no, 'tb-cv-no-k', 'UNIT');
        part(no, 'tb-cv-no-n', (u.n < 10 ? '0' : '') + (u.n || 1));
        var main = part(top, 'tb-cv-main');
        part(main, 'tb-cv-topic', u.topic || '');
        part(main, 'tb-cv-gram', '语法 · ' + (u.grammar || ''));
        part(body, 'tb-h ' + base + ' d1', '这一课会学 WHAT TO EXPECT');
        var rows = [u.started ? '这个单元上节课还没讲完，下节课接着讲，换一批新词' : '话题「' + (u.topic || '') + '」里雅思常考的 3 个新词或短语',
            '1 个语法点：' + (u.grammar || ''), '每个要点讲完，老师会当堂提问', '答错的会进错题本，考试前再考一次'];
        for (var i = 0; i < rows.length; i++) {
            var r = part(body, 'tb-cv-pt ' + base + ' d' + (2 + i));
            part(r, 'tb-cv-pt-n next', String(i + 1));
            part(r, 'tb-next-row', rows[i]);
        }
        part(body, 'tb-h ' + base + ' d5', '怎么上课 HOW');
        part(body, 'tb-home ' + base + ' d5', '到了课表上的教室课，坐进教室，老师开讲时这本书会自己翻到新的一页。');
        var left = b.unitsLeft || 0;
        if (left > 1) part(body, 'tb-next-left ' + base + ' d6', '这学期还有 ' + left + ' 个单元');
    }

    // The stamp on a point's page once its question was marked.
    function tbStamp(p) {
        if (!tb.node || !p || !p.result || tb.node._result === p.result) return;
        if (tb.node._stamp && tb.node._stamp.parentNode) tb.node._stamp.parentNode.removeChild(tb.node._stamp);
        tb.node._result = p.result;
        tb.node._stamp = part(tb.node, 'tb-stamp-wrap');
        part(tb.node._stamp, 'tb-stamp ' + p.result, p.result === 'right' ? '答对了' : '再记一次');
    }

    // While the teacher's question on this page's point waits for its answer, a sheet covers the
    // page (the answer is printed on it); answered, the sheet goes and the page is read again.
    function tbQuiz(on) {
        if (!tb.node || !!tb.node._quiz === on) return;
        if (!on) {
            var gone = tb.node._quiz;
            tb.node._quiz = null;
            gone.className = 'tb-quiz out';
            setTimeout(function () { if (gone.parentNode) gone.parentNode.removeChild(gone); }, 420);
            return;
        }
        var q = tb.node._quiz = part(tb.node, 'tb-quiz');
        part(q, 'tb-quiz-mark', '?');
        part(q, 'tb-quiz-h', '老师在提问');
        part(q, 'tb-quiz-t', '先别看书，自己想一想再回答');
        part(q, 'tb-quiz-s', '答完以后，这一页会重新翻开');
    }

    // The live lesson's book on the right.
    function showBook(b) {
        tb = liveBook;
        drawBook(b);
    }

    function drawBook(b) {
        var pts = b.points instanceof Array ? b.points : [];
        var id = b.page === 'sum' || b.page === 'next' ? b.page : String(Number(b.page) || 0);
        var point = null;
        for (var i = 0; i < pts.length; i++) if (String(pts[i].n) === id) point = pts[i];
        if (id !== 'sum' && id !== 'next' && !point) id = '0';
        var key = id === 'next' ? JSON.stringify(b.unit) : id === 'sum' ? JSON.stringify([pts.map(function (p) { return p.result; }), b.cover, b.right, b.checked])
            : (id === '0' ? JSON.stringify([b.cover, b.title, pts.length]) : JSON.stringify([point.en, point.zh, point.note, point.example, point.more]));
        tbFrame();
        tbDrawTabs(b, id);
        var fresh = id !== tb.page || b.id !== tb.lessonId;
        tb.lessonId = b.id;
        var quiz = !tb.review && !!(b.question && b.question.n && String(b.question.n) === id);
        if (!fresh && key === tb.key) { tbQuiz(quiz); tbStamp(point); return; }
        var kind = id === 'sum' || id === 'next' ? id : (id === '0' ? 'cover' : (point.kind === 'grammar' ? 'grammar' : 'word'));
        var page = el('div', 'tb-page k-' + kind);
        var head = part(page, 'tb-head');
        part(head, '', 'Unit ' + ((b.unit && b.unit.n) || 1) + ' · ' + ((b.unit && b.unit.topic) || ''));
        part(head, 'tb-head-r', 'IELTS · ' + String(b.level || '').split(' ').slice(0, 2).join(' ').toUpperCase());
        var body = part(page, 'tb-body');
        var foot = part(page, 'tb-foot');
        part(foot, '', '雅思教材 · 第 ' + (b.term || 1) + ' 学期');
        part(foot, '', id === 'sum' ? '— 小结 —' : (id === 'next' ? '— 预告 —' : '— ' + (Number(id) + 1) + ' —'));
        part(page, 'tb-shade');
        var base = fresh ? 'tb-in' : '';
        if (kind === 'cover') tbCoverPage(body, b, base);
        else if (kind === 'sum') tbSumPage(body, b, base);
        else if (kind === 'next') tbNextPage(body, b, base);
        else if (kind === 'grammar') tbGrammarPage(body, point, base);
        else tbWordPage(body, point, base);
        var old = tb.node;
        if (old && fresh) {
            // The page before folds away over the new one.
            tb.host.insertBefore(page, old);
            old.className += ' tb-out';
            setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, TB_TURN_MS);
        } else if (old) {
            tb.host.replaceChild(page, old);
        } else {
            tb.host.appendChild(page);
        }
        tb.node = page;
        tb.page = id;
        tb.key = key;
        tbQuiz(quiz);
        tbStamp(point);
        tbFit(page, body);
    }

    // A page whose print runs past its foot (a long note, the game's font taller than planned)
    // is set tighter, then tighter still; what is left over scrolls in the review, where the book
    // takes the mouse wheel (in a lesson it takes no input).
    function tbFit(page, body) {
        setTimeout(function () {
            if (!page.parentNode || body.scrollHeight <= body.clientHeight + 2) return;
            page.className += ' tight';
            setTimeout(function () {
                if (!page.parentNode || body.scrollHeight <= body.clientHeight + 2) return;
                page.className += ' tighter';
            }, 0);
        }, 0);
    }

    // ---- the review (复习功课) ----
    // Picked on oneself in the game's menu (trigger focus_review): the window becomes the played
    // character's textbook to go through again, written by the service in ui/focus/book/<id>.cfg
    // (lib/ielts.js publishBook): the lessons had on the left, the book on the right, turned with
    // the buttons, its tabs or the list, and the unit that comes next as its last page.
    var REVIEW_RECT = { left: 340, top: 60, width: 1240, height: 880 };
    var review = null;        // { player, openedAt, geo, cls, data, stops: [{lesson, id}], at }
    var rv = null;            // the window's parts, built once
    var reviewBook = null;
    // Where the review window was dragged to, kept in ui/focus/saved/review {left, top}.
    var rvPos = null;
    cli('uimod.cfg_load', { mod_id: MOD, section: 'ui/focus/saved', key: 'review' }).then(function (r) {
        try { var p = r && typeof r.value === 'string' && r.value ? JSON.parse(r.value) : null; if (p && typeof p.left === 'number' && typeof p.top === 'number') rvPos = p; } catch (e) {}
    }, function () {});

    // The review window moves by its header, kept on screen, and opens there the next time.
    function rvDrag(handle) {
        var drag = null;
        handle.addEventListener('mousedown', function (e) {
            if (!review || (e.target && /rv-close/.test(e.target.className || ''))) return;
            drag = { x: e.clientX, y: e.clientY, left: wf.root.offsetLeft, top: wf.root.offsetTop, moved: false };
        });
        document.addEventListener('mousemove', function (e) {
            if (!drag || !review) return;
            var w = window.innerWidth || 1920;
            var h = window.innerHeight || 1080;
            var left = Math.max(120 - wf.root.offsetWidth, Math.min(w - 120, drag.left + e.clientX - drag.x));
            var top = Math.max(0, Math.min(h - 60, drag.top + e.clientY - drag.y));
            wf.root.style.left = left + 'px';
            wf.root.style.top = top + 'px';
            drag.moved = true;
        });
        document.addEventListener('mouseup', function () {
            if (!drag) return;
            var d = drag;
            drag = null;
            if (!review || !d.moved) return;
            rvPos = { left: wf.root.offsetLeft, top: wf.root.offsetTop };
            save('ui/focus/saved', 'review', rvPos);
            reportRect();
        });
    }

    function rvBuild() {
        if (rv) return;
        rv = {};
        rv.root = part(wf.root, '');
        rv.root.id = 'review';
        var head = part(rv.root, 'rv-head');
        rvDrag(head);
        var tt = part(head, 'rv-title', '我的雅思课本');
        rv.sub = tt.appendChild(el('span', 'rv-sub', ''));
        var x = part(head, 'rv-close', 'X');
        x.addEventListener('click', function (e) { e.stopPropagation(); afterInput(closeReview); });
        var body = part(rv.root, 'rv-body');
        rv.list = part(body, 'rv-list');
        var right = part(body, 'rv-right');
        reviewBook = newBook(part(right, 'tb-book'), true);
        reviewBook.onTab = function (id) { rvGo(review ? rvFind(review.stops[review.at].lesson, id) : -1); };
        var nav = part(right, 'rv-nav');
        rv.prev = nav.appendChild(el('button', 'rv-btn', '‹ 上一页'));
        rv.where = part(nav, 'rv-where', '');
        rv.next = nav.appendChild(el('button', 'rv-btn', '下一页 ›'));
        rv.prev.type = 'button';
        rv.next.type = 'button';
        rv.prev.addEventListener('click', function (e) { e.stopPropagation(); if (review) rvGo(review.at - 1); });
        rv.next.addEventListener('click', function (e) { e.stopPropagation(); if (review) rvGo(review.at + 1); });
    }

    function rvFind(lesson, id) {
        if (!review) return -1;
        for (var i = 0; i < review.stops.length; i++) if (review.stops[i].lesson === lesson && review.stops[i].id === id) return i;
        return -1;
    }

    function rvRow(cls, at) {
        var r = part(rv.list, cls);
        if (at >= 0) r.addEventListener('click', function (e) { e.stopPropagation(); rvGo(at); });
        return r;
    }

    // The list on the left: the lessons had under their units, the lesson that comes next, and
    // the units after it.
    function rvDrawList() {
        var d = review.data;
        while (rv.list.firstChild) rv.list.removeChild(rv.list.firstChild);
        rv.rows = [];
        var lessons = d.lessons;
        var unitKey = '';
        for (var i = 0; i < lessons.length; i++) {
            var L = lessons[i];
            var k = L.level + ':' + L.unit.n;
            if (k !== unitKey) {
                unitKey = k;
                var u = part(rv.list, 'rv-unit');
                u.appendChild(el('span', 'rv-unit-no', 'Unit ' + L.unit.n));
                u.appendChild(el('span', '', L.unit.topic));
            }
            var row = rvRow('rv-lesson', rvFind(i, '0'));
            row._lesson = i;
            part(row, 'rv-lesson-t', '第 ' + (i + 1) + ' 课 · ' + (L.title || L.unit.topic));
            part(row, 'rv-lesson-s' + (L.checked && L.right === L.checked ? ' all' : ''), L.checked ? '答对 ' + L.right + ' / ' + L.checked : '—');
            rv.rows.push(row);
        }
        if (!lessons.length) part(rv.list, 'rv-none', '还没有上过课。到了课表上的教室课，坐进教室听老师讲，课本就会一页一页多起来。');
        if (d.next) {
            part(rv.list, 'rv-unit next', '接下来');
            var nx = rvRow('rv-lesson next', rvFind(-1, 'next'));
            nx._lesson = -1;
            part(nx, 'rv-lesson-t', '下一课 · Unit ' + d.next.n + ' ' + d.next.topic);
            part(nx, 'rv-lesson-s', '预告');
            rv.rows.push(nx);
            var units = d.units || [];
            for (var j = 0; j < units.length; j++) {
                if (units[j].state !== 'next') continue;
                var later = part(rv.list, 'rv-later');
                later.appendChild(el('span', 'rv-unit-no', 'Unit ' + units[j].n));
                later.appendChild(el('span', '', units[j].topic));
            }
        }
    }

    function rvGo(at) {
        if (!review || at < 0 || at >= review.stops.length) return;
        review.at = at;
        var stop = review.stops[at];
        var d = review.data;
        var b;
        if (stop.lesson >= 0) {
            var L = d.lessons[stop.lesson];
            b = { id: L.id, page: stop.id, unit: L.unit, level: L.level, term: d.term, title: L.title, cover: L.cover, points: L.points, right: L.right, checked: L.checked };
        } else {
            var left = 0;
            for (var i = 0; i < (d.units || []).length; i++) if (d.units[i].state !== 'done') left++;
            b = { id: 'next', page: 'next', unit: d.next, level: d.level, term: d.term, points: [], unitsLeft: left };
        }
        tb = reviewBook;
        drawBook(b);
        for (var r = 0; r < rv.rows.length; r++) {
            var cls = rv.rows[r].className.replace(/\s*\bon\b/, '');
            rv.rows[r].className = rv.rows[r]._lesson === stop.lesson ? cls + ' on' : cls;
        }
        rv.prev.className = at > 0 ? 'rv-btn' : 'rv-btn off';
        rv.next.className = at < review.stops.length - 1 ? 'rv-btn' : 'rv-btn off';
        rv.where.textContent = (at + 1) + ' / ' + review.stops.length;
    }

    function rvLoaded(d) {
        if (!d || typeof d !== 'object') d = {};
        if (!(d.lessons instanceof Array)) d.lessons = [];
        review.data = d;
        review.stops = [];
        var lessons = d.lessons;
        for (var i = 0; i < lessons.length; i++) {
            review.stops.push({ lesson: i, id: '0' });
            for (var j = 0; j < lessons[i].points.length; j++) review.stops.push({ lesson: i, id: String(lessons[i].points[j].n) });
            review.stops.push({ lesson: i, id: 'sum' });
        }
        if (d.next) review.stops.push({ lesson: -1, id: 'next' });
        rv.sub.textContent = d.level ? d.level + ' · 第 ' + (d.term || 1) + ' 学期 · 学过 ' + lessons.length + ' 课' : '';
        rvDrawList();
        if (!review.stops.length) {
            rv.where.textContent = '';
            rv.prev.className = 'rv-btn off';
            rv.next.className = 'rv-btn off';
            part(rv.list, 'rv-none', '在手机「设置」里打开雅思学习模式，上学时的教室课就会变成雅思课。');
            return;
        }
        // Open at the last lesson had (its first page), or at what comes next.
        var last = lessons.length ? rvFind(lessons.length - 1, '0') : 0;
        rvGo(last < 0 ? 0 : last);
        rv.list.scrollTop = rv.list.scrollHeight;
    }

    function openReview(player) {
        if (review && Date.now() - review.openedAt < 1500) return;
        closeReview();
        hide();
        rvBuild();
        var st = wf.root.style;
        review = { player: player, openedAt: Date.now(), cls: wf.root.className, geo: { left: st.left, top: st.top, width: st.width, height: st.height }, data: null, stops: [], at: 0 };
        wf.root.className = (review.cls ? review.cls + ' ' : '') + 'review';
        st.left = (rvPos ? rvPos.left : REVIEW_RECT.left) + 'px';
        st.top = (rvPos ? rvPos.top : REVIEW_RECT.top) + 'px';
        st.width = REVIEW_RECT.width + 'px';
        st.height = REVIEW_RECT.height + 'px';
        st.display = '';
        reportRect();
        // The student really sits down with a textbook while it is open (lib/homework.js study).
        save('ui/focus/book', 'ask', { seq: Date.now() * 10, op: 'open', player: String(player), at: Date.now() });
        var r = review;
        cli('uimod.cfg_load', { mod_id: MOD, section: 'ui/focus/book', key: String(player) }).then(function (res) {
            if (review !== r) return;
            var d = null;
            try { d = res && typeof res.value === 'string' && res.value ? JSON.parse(res.value) : null; } catch (e) { d = null; }
            rvLoaded(d);
        }, function () { if (review === r) rvLoaded(null); });
    }

    function closeReview() {
        if (!review) return;
        var r = review;
        review = null;
        save('ui/focus/book', 'ask', { seq: Date.now() * 10, op: 'close', player: String(r.player), at: Date.now() });
        clearBook(reviewBook);
        tb = liveBook;
        var st = wf.root.style;
        wf.root.className = r.cls;
        st.left = r.geo.left;
        st.top = r.geo.top;
        st.width = r.geo.width;
        st.height = r.geo.height;
        setIdle(true);
    }

    // ---- the homework (写作业) ----
    // The day's exercise sheet (lib/homework.js), shown when the played student sits down to
    // the game's homework, or after 写作业 is picked on them (trigger focus_homework, which asks
    // the service through ui/focus/homework/ask). The sheet is ui/focus/homework/<player>;
    // handed in through ui/focus/homework/answer, it comes back marked, each question with its
    // tick or cross, the right answer and why.
    var HW_RECT = { left: 440, top: 70, width: 1040, height: 900 };
    var HW_POLL_MS = 1000;
    var HW_TYPES = { choice: '选择', fill: '填空', translate: '翻译', make: '造句', fix: '改错' };
    var homework = null;      // { player, ask, cls, geo, sheet, answers, key, timer, sentAt, sure }
    var hw = null;            // the window's parts, built once

    function hwBuild() {
        if (hw) return;
        hw = {};
        hw.root = part(wf.root, '');
        hw.root.id = 'homework';
        var paper = part(hw.root, 'hw-paper');
        var head = part(paper, 'hw-head');
        var left = part(head, 'hw-head-l');
        hw.title = part(left, 'hw-title', '今日练习');
        hw.sub = part(left, 'hw-sub', '');
        var x = part(head, 'hw-close', 'X');
        x.addEventListener('click', function (e) { e.stopPropagation(); afterInput(closeHomework); });
        hw.stampWrap = part(paper, 'hw-stamp-wrap');
        hw.body = part(paper, 'hw-body');
        var foot = part(paper, 'hw-foot');
        hw.progress = part(foot, 'hw-progress', '');
        hw.submit = foot.appendChild(el('button', 'hw-submit', '交作业'));
        hw.submit.type = 'button';
        hw.submit.addEventListener('click', function (e) { e.stopPropagation(); hwSubmit(); });
        hw.body.addEventListener('wheel', function (e) { e.stopPropagation(); });
    }

    function hwMessage(title, text) {
        while (hw.body.firstChild) hw.body.removeChild(hw.body.firstChild);
        var m = part(hw.body, 'hw-msg');
        part(m, 'hw-msg-h', title);
        if (text) part(m, 'hw-msg-t', text);
        hw.stampWrap.className = 'hw-stamp-wrap';
        while (hw.stampWrap.firstChild) hw.stampWrap.removeChild(hw.stampWrap.firstChild);
        hw.progress.textContent = '';
        hw.submit.style.display = 'none';
    }

    function hwAnswered() {
        var n = 0;
        var qs = homework.sheet.questions || [];
        for (var i = 0; i < qs.length; i++) if (String(homework.answers[qs[i].n] || '').replace(/\s/g, '')) n++;
        return n;
    }

    function hwSyncFoot() {
        var s = homework.sheet;
        var of = (s.questions || []).length;
        if (s.state === 'marked') {
            hw.progress.textContent = '答对 ' + s.score + ' / ' + s.of + (s.score < s.of ? ' · 错的题已经记进错题本' : ' · 全部答对');
            hw.submit.textContent = '关闭';
            hw.submit.className = 'hw-submit';
            hw.submit.style.display = '';
            return;
        }
        if (s.state === 'marking' || homework.sentAt) {
            hw.progress.textContent = '老师正在批改……';
            hw.submit.textContent = '批改中';
            hw.submit.className = 'hw-submit off';
            hw.submit.style.display = '';
            return;
        }
        var done = hwAnswered();
        hw.progress.textContent = '已完成 ' + done + ' / ' + of;
        hw.submit.style.display = '';
        hw.submit.className = 'hw-submit' + (done ? '' : ' off');
        hw.submit.textContent = homework.sure ? '还有 ' + (of - done) + ' 题没写，仍然交' : '交作业';
    }

    function hwSubmit() {
        var s = homework && homework.sheet;
        if (!s) return;
        if (s.state === 'marked') { afterInput(closeHomework); return; }
        if (s.state !== 'ready' || homework.sentAt) return;
        var done = hwAnswered();
        if (!done) return;
        if (done < (s.questions || []).length && !homework.sure) {
            homework.sure = true;
            hwSyncFoot();
            return;
        }
        homework.sentAt = Date.now();
        save('ui/focus/homework', 'answer', { id: s.id, student: homework.player, answers: homework.answers, at: Date.now() });
        hwDraw(true);
    }

    // One question: its number, kind and prompt, then the choices or the box to write in; once
    // marked, the tick or cross, what was given and what is right.
    function hwQuestion(q, res, locked) {
        var cls = 'hw-q' + (res ? (res.correct ? ' right' : ' wrong') : '');
        var box = part(hw.body, cls);
        var top = part(box, 'hw-q-top');
        part(top, 'hw-q-n', String(q.n));
        part(top, 'hw-q-type', (HW_TYPES[q.type] || '问答') + (q.from === 'mistake' ? ' · 错题重做' : ''));
        if (res) part(box, 'hw-mark ' + (res.correct ? 'right' : 'wrong'), res.correct ? '✓' : '✗');
        part(box, 'hw-q-prompt', q.prompt);
        var given = res ? res.given : (homework.answers[q.n] || '');
        if (q.type === 'choice' && q.options && q.options.length) {
            var row = part(box, 'hw-opts');
            for (var i = 0; i < q.options.length; i++) hwOption(row, q, i, given, res, locked);
        } else if (locked) {
            part(box, 'hw-given' + (res && !res.correct ? ' bad' : ''), given || '（没有作答）');
        } else {
            var t = box.appendChild(el('textarea', 'hw-input'));
            t.setAttribute('rows', q.type === 'fill' ? '1' : '2');
            t.setAttribute('maxlength', '200');
            t.setAttribute('placeholder', q.type === 'fill' ? '填在这里' : (q.type === 'fix' ? '写出改正后的句子' : '用英语写'));
            t.value = given;
            t.addEventListener('input', function () { homework.answers[q.n] = t.value; homework.sure = false; hwSyncFoot(); });
        }
        if (res && !res.correct) {
            var fix = part(box, 'hw-fix');
            fix.appendChild(el('span', 'hw-fix-k', res.fixed ? '改正' : '正确答案'));
            fix.appendChild(el('span', '', res.fixed || res.answer || q.answer));
            if (res.fixed && res.answer && res.fixed !== res.answer) {
                var ref = part(box, 'hw-fix');
                ref.appendChild(el('span', 'hw-fix-k', '参考'));
                ref.appendChild(el('span', '', res.answer));
            }
        }
        if (res && res.why) part(box, 'hw-why', res.why);
    }

    function hwOption(row, q, i, given, res, locked) {
        var text = q.options[i];
        var letter = String.fromCharCode(65 + i);
        var picked = given && (given === text || given.toUpperCase() === letter);
        var cls = 'hw-opt' + (picked ? ' picked' : '');
        if (res) {
            var right = String(q.answer).split('|')[0] === text || String(res.answer) === text;
            if (right) cls += ' is-right';
            else if (picked) cls += ' is-wrong';
        }
        var b = row.appendChild(el('button', cls, letter + '. ' + text));
        b.type = 'button';
        if (locked) return;
        b.addEventListener('click', function (e) {
            e.stopPropagation();
            homework.answers[q.n] = text;
            homework.sure = false;
            var all = row.getElementsByTagName('button');
            for (var k = 0; k < all.length; k++) all[k].className = 'hw-opt' + (all[k] === b ? ' picked' : '');
            hwSyncFoot();
        });
    }

    function hwStamp(s) {
        while (hw.stampWrap.firstChild) hw.stampWrap.removeChild(hw.stampWrap.firstChild);
        if (s.state !== 'marked') { hw.stampWrap.className = 'hw-stamp-wrap'; return; }
        var all = s.score === s.of;
        hw.stampWrap.className = 'hw-stamp-wrap on';
        var st = part(hw.stampWrap, 'hw-stamp' + (all ? ' all' : (s.score * 2 >= s.of ? '' : ' low')));
        part(st, 'hw-stamp-n', s.score + '/' + s.of);
        part(st, 'hw-stamp-t', all ? '全对' : (s.score * 2 >= s.of ? '阅' : '订正'));
    }

    // Draws the sheet; force: even when nothing new came (handed in).
    function hwDraw(force) {
        var s = homework.sheet;
        var key = JSON.stringify([s.state, s.id, s.ask, (s.results || []).length, !!homework.sentAt]);
        if (!force && key === homework.key) return;
        homework.key = key;
        hw.title.textContent = s.title ? '今日练习 · ' + s.title : '今日练习';
        hw.sub.textContent = s.unit ? 'Unit ' + s.unit.n + ' ' + s.unit.topic + (s.level ? ' · ' + s.level : '') +
            (s.from === 'last' ? ' · 今天没上课，复习上一课' : (s.from === 'preview' ? ' · 预习' : '')) + (s.day ? ' · 第 ' + s.day + ' 天' : '') : '';
        if (s.state === 'off') { hwMessage('雅思学习模式没有打开', '在手机「设置」里打开雅思学习模式，就会有每天的课后练习。'); return; }
        if (s.state === 'none') { hwMessage('没有作业', '只有上学的初中生、高中生才有课后练习。'); return; }
        if (s.state === 'failed') { hwMessage('今天的练习没出成', '出题的时候出了问题，过一会儿再点一次「写作业」。'); return; }
        if (s.state === 'making' || !(s.questions instanceof Array)) { hwMessage('老师正在出题……', '按今天学的内容出几道题，马上就好。'); return; }
        var scroll = hw.body.scrollTop;
        while (hw.body.firstChild) hw.body.removeChild(hw.body.firstChild);
        var marked = s.state === 'marked';
        var locked = marked || s.state === 'marking' || !!homework.sentAt;
        for (var i = 0; i < s.questions.length; i++) {
            var q = s.questions[i];
            var res = null;
            if (marked) for (var j = 0; j < (s.results || []).length; j++) if (s.results[j].n === q.n) res = s.results[j];
            hwQuestion(q, res, locked);
        }
        hwStamp(s);
        hwSyncFoot();
        hw.body.scrollTop = marked && !force ? 0 : scroll;
    }

    function hwPoll() {
        if (!homework) return;
        var h = homework;
        cli('uimod.cfg_load', { mod_id: MOD, section: 'ui/focus/homework', key: h.player }).then(function (r) {
            if (homework !== h) return;
            var s = null;
            try { s = r && typeof r.value === 'string' && r.value ? JSON.parse(r.value) : null; } catch (e) { s = null; }
            // Opened from the menu: what was there before the ask is not today's sheet yet.
            if (s && (!h.ask || (s.ask || 0) >= h.ask)) {
                if (h.sheet && h.sheet.id !== s.id) { h.answers = {}; h.sentAt = 0; h.sure = false; }
                // Handed in: locked until the service takes it; not taken in 30 s, it can be handed in again.
                if (s.state !== 'ready') h.sentAt = 0;
                else if (h.sentAt && Date.now() - h.sentAt > 30000) h.sentAt = 0;
                h.sheet = s;
                hwDraw(false);
            }
            h.timer = setTimeout(hwPoll, HW_POLL_MS);
        }, function () { if (homework === h) h.timer = setTimeout(hwPoll, HW_POLL_MS); });
    }

    // ask: the seq of the 写作业 pick that opened it, 0 when the service did.
    function openHomework(player, ask) {
        if (homework && homework.player === player) {
            if (ask) { homework.ask = ask; homework.key = ''; hwMessage('正在准备今天的作业……', ''); }
            return;
        }
        hide();
        hwBuild();
        var st = wf.root.style;
        homework = { player: player, ask: ask || 0, cls: wf.root.className, geo: { left: st.left, top: st.top, width: st.width, height: st.height }, sheet: null, answers: {}, key: '', timer: null, sentAt: 0, sure: false };
        wf.root.className = (homework.cls ? homework.cls + ' ' : '') + 'homework';
        st.left = HW_RECT.left + 'px';
        st.top = HW_RECT.top + 'px';
        st.width = HW_RECT.width + 'px';
        st.height = HW_RECT.height + 'px';
        st.display = '';
        reportRect();
        hwMessage('正在准备今天的作业……', '');
        hwPoll();
    }

    function closeHomework() {
        if (!homework) return;
        var h = homework;
        homework = null;
        if (h.timer) clearTimeout(h.timer);
        var st = wf.root.style;
        wf.root.className = h.cls;
        st.left = h.geo.left;
        st.top = h.geo.top;
        st.width = h.geo.width;
        st.height = h.geo.height;
        setIdle(true);
    }

    function askHomework(player) {
        var seq = Date.now() * 10;
        save('ui/focus/homework', 'ask', { seq: seq, player: player, at: Date.now() });
        openHomework(player, seq);
    }

    function setState(text, err) {
        state.textContent = text || '';
        state.className = err ? 'err' : '';
    }

    function syncSend() {
        send.className = box.value.replace(/\s+/g, '') ? '' : 'off';
    }

    function render() {
        if (!talk) return;
        var lines = [];
        var i;
        for (i = 0; i < talk.said.length; i++) lines.push({ side: 'mine', id: talk.said[i].id, text: talk.said[i].text, at: talk.said[i].at });
        for (i = 0; i < talk.heard.length; i++) lines.push({ side: 'theirs', id: talk.heard[i].id, text: talk.heard[i].text, at: talk.heard[i].at });
        lines.sort(function (a, b) { return a.at - b.at; });
        if (lines.length > SHOWN) lines = lines.slice(lines.length - SHOWN);
        while (log.firstChild) log.removeChild(log.firstChild);
        if (!lines.length) log.appendChild(el('div', 'line note', '走到' + talk.name + '面前，开口说点什么吧。'));
        for (i = 0; i < lines.length; i++) {
            var l = lines[i];
            var row = el('div', 'line ' + l.side);
            row.appendChild(el('span', 'who', (l.side === 'mine' ? '你' : talk.name) + '：'));
            var text = l.text;
            if (typing && typing.id === l.id) text = l.text.slice(0, typing.shown);
            row.appendChild(el('span', '', text));
            log.appendChild(row);
        }
        log.scrollTop = log.scrollHeight;
    }

    // A new answer appears a few characters at a time, as if spoken.
    function typeOut() {
        if (typing || !talk) return;
        for (var i = 0; i < talk.heard.length; i++) {
            var h = talk.heard[i];
            if (typedIds[h.id]) continue;
            typedIds[h.id] = true;
            typing = { id: h.id, shown: 0, len: h.text.length };
            var tick = function () {
                if (!typing) return;
                typing.shown += 1;
                if (typing.shown >= typing.len) typing = null;
                render();
                if (typing) setTimeout(tick, TYPE_MS);
                else typeOut();
            };
            setTimeout(tick, TYPE_MS);
            return;
        }
    }

    // ---- the camera ----
    function camera(op, t) {
        return cli('uimod.cfg_save', { mod_id: MOD, section: 'ui/focus', key: 'camera', value: Date.now() + ':' + op + ':' + t.player + ':' + t.target }).then(null, function () {});
    }

    function cameraOn(t) {
        if (cameraTimer) clearInterval(cameraTimer);
        camera('open', t);
        cameraTimer = setInterval(function () { if (talk === t) camera('open', t); }, CAMERA_REFRESH_MS);
    }

    function cameraOff(t) {
        if (cameraTimer) { clearInterval(cameraTimer); cameraTimer = null; }
        camera('close', t);
    }

    // ---- the talk ----
    function closeTalk() {
        if (!talk) return;
        voiceNote('');
        var t = talk;
        talk = null;
        typing = null;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        clearBoard();
        save(t.section, 'session', { state: 'closed', at: Date.now() });
        cameraOff(t);
        try { box.blur(); } catch (e) {}
    }

    // The view itself is never hidden: shown again after a while hidden, it can come back with
    // its script stopped (no typing, no closing). With no talk open only the box goes, and it
    // takes no clicks (the content rect is empty), like the phone does when put away.
    function setIdle(idle) {
        // A text box hidden with the focus in it never lets the game have the keyboard back
        // (window.js "Input given back"): it gives up the focus first.
        if (idle) {
            try { var a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); } catch (e) {}
        }
        wf.root.style.display = idle ? 'none' : '';
        if (idle) {
            // Nothing of the screen: the corner pixel, not a rect of no size, which the game
            // ignores (window.js _claimNothing).
            if (typeof wf.root._claimNothing === 'function') wf.root._claimNothing();
            else { try { inzoi.view.setContentRect(0, 0, 1, 1); } catch (e) {} }
            // Through the window's own report too, so the area kept in ui/focus/rect reads 0.
            if (typeof wf.root._reportContentRect === 'function') wf.root._reportContentRect();
            // Closed with the cursor on it (its X, Esc): no mouseleave ever comes, and the game
            // would go on thinking the cursor is over this view, eating most of the mouse wheel.
            try { inzoi.view.hover(false); } catch (e) {}
        } else {
            reportRect();
        }
    }

    // A close asked for by a click or a key happens once that input has been handled, never
    // inside it. Hidden in the middle of the engine's handling of a click, the window left the
    // mouse wheel dead where it had been (found in the game: closed by its X it stayed dead,
    // closed by a timer it did not); the engine's own window code defers its hide the same way.
    var AFTER_INPUT_MS = 50;
    function afterInput(fn) {
        setTimeout(fn, AFTER_INPUT_MS);
    }

    function hide() {
        closeHomework();
        closeReview();
        closeTalk();
        setIdle(true);
    }
    // The window's X (window.js) closes it after the click has been handled.
    wf.root._close = function () { afterInput(hide); };

    function openTalk(player, target, heading) {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        if (talk && talk.player === player && talk.target === target) return;
        closeHomework();
        closeReview();
        closeTalk();
        setIdle(false);
        talk = { player: player, target: target, section: 'ui/focus/talk/' + player + '-' + target, name: 'TA', said: [], heard: [], openedAt: Date.now() };
        typedIds = {};
        serviceAt = 0;
        var t = talk;
        sub.textContent = '';
        title.firstChild.nodeValue = 'TA';
        setState('');
        render();
        Promise.all([load('said'), load('heard')]).then(function (r) {
            if (talk !== t) return;
            t.said = r[0] instanceof Array ? r[0] : [];
            t.heard = r[1] instanceof Array ? r[1] : [];
            // What was said before this box opened is shown at once, not typed out again.
            for (var i = 0; i < t.heard.length; i++) typedIds[t.heard[i].id] = true;
            render();
        });
        save(t.section, 'session', { state: 'open', at: t.openedAt });
        cameraOn(t);
        cli('entity.get_character_info', { entity_id: String(target) }).then(function (c) {
            if (talk !== t || !c) return;
            t.name = c.first_name || c.name || 'TA';
            title.firstChild.nodeValue = c.name || t.name;
            sub.textContent = heading || '面对面';
            render();
        }, function () {});
        schedulePoll(0);
        setTimeout(function () { try { box.focus(); } catch (e) {} }, 120);
    }

    function schedulePoll(ms) {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, ms);
    }

    function poll() {
        pollTimer = null;
        if (!talk || polling) { if (talk) schedulePoll(POLL_MS); return; }
        polling = true;
        var t = talk;
        Promise.all([load('heard'), load('status'), load('lesson'), loadVoice()]).then(function (r) {
            polling = false;
            if (talk !== t) return;
            showBoard(r[2]);
            showVoice(r[3]);
            var heard = r[0] instanceof Array ? r[0] : t.heard;
            // New lines by the newest one, not the count: the service keeps only the last ones,
            // so a long talk can add a line and keep the same count.
            var lastOf = function (l) { return l.length ? l[l.length - 1].id : ''; };
            if (heard.length !== t.heard.length || lastOf(heard) !== lastOf(t.heard)) {
                t.heard = heard;
                render();
                typeOut();
            }
            var s = r[1];
            if (s && typeof s.at === 'number') serviceAt = Math.max(serviceAt, s.at);
            var waiting = unanswered(t);
            if (s && s.state === 'error') setState(s.error || '出了点问题', true);
            else if (s && s.state === 'thinking') setState(t.name + ' 在想……');
            else if (waiting && Date.now() - waiting > SERVICE_SILENT_MS && serviceAt < waiting) setState('回复服务好像没在运行（sms-bridge）', true);
            else if (waiting) setState('……');
            else setState('');
            schedulePoll(POLL_MS);
        }, function () {
            polling = false;
            schedulePoll(POLL_MS);
        });
    }

    // The time of the oldest line said and not answered yet, or 0.
    function unanswered(t) {
        var answered = 0;
        for (var i = 0; i < t.heard.length; i++) answered = Math.max(answered, typeof t.heard[i].reAt === 'number' ? t.heard[i].reAt : t.heard[i].at);
        for (var j = 0; j < t.said.length; j++) if (t.said[j].at > answered) return t.said[j].at;
        return 0;
    }

    function say() {
        if (!talk) return;
        var text = box.value.replace(/^\s+|\s+$/g, '').slice(0, TEXT_MAX);
        if (!text) return;
        if (askId) answeredId = askId;
        box.value = '';
        sayText(text);
    }

    function sayText(text) {
        if (!talk || !text) return;
        var now = Date.now();
        var last = talk.said.length ? talk.said[talk.said.length - 1].at : 0;
        var at = Math.max(now, last + 1);
        talk.said.push({ id: 's-' + at, text: text, at: at });
        if (talk.said.length > 80) talk.said = talk.said.slice(talk.said.length - 80);
        save(talk.section, 'said', talk.said);
        syncSend();
        render();
        setState('……');
    }

    // ui/focus/talk/<key>/typing {at}: the player is writing (a lesson waits for the answer, lib/ielts.js).
    var typingAt = 0;
    function noteTyping() {
        if (!talk || Date.now() - typingAt < 3000) return;
        typingAt = Date.now();
        save(talk.section, 'typing', { at: typingAt });
    }
    // ---- voice input ----
    var VOICE_SEND_S = 2;     // what was heard is said after this long, unless a key is pressed
    var VOICE_FRESH_MS = 8000;
    var voiceSeq = Date.now() * 10;
    var voiceTimer = null;
    var voiceHinted = false;

    function loadVoice() {
        return cli('uimod.cfg_load', { mod_id: MOD, section: 'ui/focus', key: 'voice' }).then(function (r) {
            var raw = r && typeof r.value === 'string' ? r.value : '';
            if (!raw) return null;
            try { return JSON.parse(raw); } catch (e) { return null; }
        }, function () { return null; });
    }

    function voiceNote(text, cls) {
        if (voiceTimer) { clearTimeout(voiceTimer); voiceTimer = null; }
        voiceText.textContent = text || '';
        voiceBar.className = text ? 'on ' + (cls || '') : '';
    }

    function voiceCountdown(left) {
        if (left <= 0) {
            voiceNote('');
            say();
            return;
        }
        voiceNote(left + ' 秒后说出去 · 按任意键可以先改', 'heard');
        voiceTimer = setTimeout(function () { voiceTimer = null; voiceCountdown(left - 1); }, 1000);
    }

    function showVoice(v) {
        if (!v || typeof v.seq !== 'number') return;
        if (v.enabled && !voiceHinted) {
            voiceHinted = true;
            hint.textContent = 'Enter 说话 · 按住 ' + (v.key || '语音键') + ' 语音 · Esc 结束';
        }
        if (v.seq <= voiceSeq || Date.now() - (v.at || 0) > VOICE_FRESH_MS) return;
        voiceSeq = v.seq;
        if (v.state === 'listening') {
            voiceNote('正在听……说完松开' + (v.key || '按键'), 'listening');
            noteTyping();
        } else if (v.state === 'thinking') {
            voiceNote('正在识别……', 'thinking');
            noteTyping();
        } else if (v.state === 'heard' && v.text) {
            box.value = (box.value ? box.value + ' ' : '') + v.text;
            if (box.value.length > TEXT_MAX) box.value = box.value.slice(0, TEXT_MAX);
            syncSend();
            noteTyping();
            voiceCountdown(VOICE_SEND_S);
        } else if (v.state === 'error') {
            voiceNote(v.text || '没听清', 'err');
            voiceTimer = setTimeout(function () { voiceTimer = null; voiceNote(''); }, 3000);
        } else {
            voiceNote('');
        }
    }

    // A key pressed while the heard words wait: the player changes them and says them with Enter.
    function voiceHold() {
        if (voiceTimer && voiceBar.className.indexOf('heard') >= 0) voiceNote('');
    }
    box.addEventListener('keydown', voiceHold);

    box.addEventListener('input', function () { syncSend(); noteTyping(); });
    box.addEventListener('compositionupdate', noteTyping);
    box.addEventListener('compositionstart', function () { composing = true; });
    box.addEventListener('compositionend', function () { composing = false; syncSend(); });
    box.addEventListener('keydown', function (e) {
        if (e.keyCode === 13 && !e.shiftKey && !e.isComposing && !composing) {
            if (e.preventDefault) e.preventDefault();
            say();
        } else if (e.keyCode === 27 && !composing) {
            if (e.preventDefault) e.preventDefault();
            afterInput(hide);
        }
    });
    // Esc with the box not focused, while the talk is open, ends it too.
    document.addEventListener('keydown', function (e) {
        if (e.keyCode === 27 && (review || homework || talk && e.target !== box)) afterInput(hide);
    });
    send.addEventListener('click', function (e) {
        e.stopPropagation();
        say();
        try { box.focus(); } catch (err) {}
    });
    var closeBtn = document.getElementById('close-btn');
    document.addEventListener('visibilitychange', function () { if (document.hidden) hide(); });
    window.addEventListener('beforeunload', function () { closeTalk(); });

    // A talk the service opens or ends by itself (a lesson). Open: the page shows itself on that
    // character. Close: the last words stay a moment, then the box goes.
    // ui/focus/alive {at}: this page is running and will see a request (read by lib/ielts.js).
    var aliveAt = 0;
    function pollRequest() {
        if (Date.now() - aliveAt > 30000) {
            aliveAt = Date.now();
            save('ui/focus', 'alive', { at: aliveAt });
        }
        cli('uimod.cfg_load', { mod_id: MOD, section: 'ui/focus', key: 'request' }).then(function (r) {
            var raw = r && typeof r.value === 'string' ? r.value : '';
            var q = null;
            try { q = raw ? JSON.parse(raw) : null; } catch (e) { q = null; }
            if (q && typeof q.seq === 'number' && q.seq > requestSeq) {
                requestSeq = q.seq;
                var player = String(q.player || '');
                var target = String(q.target || '');
                focusNote('request ' + q.op + ' ' + player + '-' + target);
                if (q.op === 'homework' && /^\d+$/.test(player)) {
                    openHomework(player, 0);
                } else if (q.op === 'open' && /^\d+$/.test(player) && /^\d+$/.test(target)) {
                    openTalk(player, target, q.title || '');
                } else if (q.op === 'close' && talk && talk.player === player && talk.target === target) {
                    if (closeTimer) clearTimeout(closeTimer);
                    closeTimer = setTimeout(function () { closeTimer = null; if (talk && talk.player === player && talk.target === target) hide(); }, 7000);
                }
            }
            setTimeout(pollRequest, REQUEST_POLL_MS);
        }, function () { setTimeout(pollRequest, REQUEST_POLL_MS); });
    }
    pollRequest();
    setIdle(true);

    // The game sends each menu pick twice at once; the second one is the same talk.
    inzoi.trigger.onActivated(function (t) {
        try { focusNote('trigger ' + JSON.stringify(t) + (talk ? ' open=' + talk.player + '-' + talk.target : '')); } catch (e) {}
        // focus_boot (game_mode, the play views) keeps this page loaded in a save, so that a talk
        // the service opens (a lesson) finds it running: with no talk open the box stays away.
        if (t && t.triggerId === 'focus_boot') {
            if (!talk && !review && !homework) setIdle(true);
            return;
        }
        // 写作业: the played student sits down to the day's homework, whoever the menu was opened on.
        if (t && t.triggerId === 'focus_homework') {
            if (/^\d+$/.test(String(t.selfEntityId || ''))) askHomework(String(t.selfEntityId));
            return;
        }
        // 复习功课: the played character's textbook, whoever the menu was opened on.
        if (t && t.triggerId === 'focus_review') {
            if (/^\d+$/.test(String(t.selfEntityId || ''))) openReview(String(t.selfEntityId));
            return;
        }
        if (!t || t.triggerId !== 'focus_chat') return;
        var player = String(t.selfEntityId || '');
        var target = String(t.targetEntityId || '');
        if (!/^\d+$/.test(player) || !/^\d+$/.test(target) || player === target) return;
        var key = player + '-' + target;
        var now = Date.now();
        if (lastTrigger.key === key && now - lastTrigger.at < 1500 && talk) return;
        lastTrigger = { key: key, at: now };
        openTalk(player, target);
    });
})();
