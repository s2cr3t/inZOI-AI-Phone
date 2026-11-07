    // ------------------------------------------------------------------
    // AI. Settings of inZOI AI Phone Service (sms-bridge/lib/guardian.js), the program on this
    // PC that writes the replies in Texts and Moments. Files in ui/phone/service/:
    //   service.cfg  written by the service every 2 s: state, settings, which providers have a
    //                key (a short hint only), the answer to the last request
    //   control.cfg  written here: { v, rev, enabled, provider, model, base_url, thinking }
    //   request.cfg  written here: { id, type, provider, model, base_url, key? }
    //                type: paste_key | set_key | forget_key | test | models
    //                (Wallpaper sends wallpaper_pick/remove; Texts sends photo_pick here too)
    // A typed key is in request.cfg only until the service reads it; the service encrypts it
    // for this Windows user and empties the file. Pasting reads the clipboard on the PC side,
    // so the key never passes through this page at all.
    // ------------------------------------------------------------------
    var AI_SECTION = 'ui/phone/service';
    var AI_STALE_MS = 15000;
    var AI_REQUEST_MS = 60000;
    var AI_SAVE_MS = 20000;
    var AI_KEY_MAX = 512;
    var AI_URL_MAX = 300;
    var AI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,127}$/;
    var AI_MODEL_CHIPS = 24;
    var AI_THINKING = [
        { id: 'disabled', label: 'Off' },
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
        { id: 'max', label: 'Max' }
    ];
    var AI_FIELDS = ['ai-model', 'ai-url', 'ai-key'];
    var aiService = null;
    // Provider, model, address and thinking picked on this page and not saved yet.
    var aiDraft = null;
    var aiKeyDraft = '';
    var aiModels = {};
    var aiPending = null;
    var aiSaving = null;
    var aiResult = null;
    var aiConfirmForget = '';
    var aiRenderedKey = '';
    var aiFocus = null;
    var aiSeq = 0;

    // The AI page's state: service.cfg (the guardian) with the daemon's own heartbeat folded in.
    // A bridge started from a console never wrote service.cfg, so the phone called it offline.
    function loadAiService() {
        return Promise.all([
            cfgValue(AI_SECTION, 'service'),
            cfgValue(AI_SECTION, 'daemon')
        ]).then(function (r) {
            var s = r[0] && typeof r[0] === 'object' ? r[0] : null;
            var d = r[1] && typeof r[1] === 'object' ? r[1] : null;
            aiNoteSetup(s, d);
            if (!d || typeof d.heartbeat !== 'number') return s;
            if (Date.now() - d.heartbeat > AI_STALE_MS) return s;
            if (s && typeof s.heartbeat === 'number' && Date.now() - s.heartbeat <= AI_STALE_MS) return s;
            var out = {};
            for (var k in s) if (s.hasOwnProperty(k)) out[k] = s[k];
            out.heartbeat = d.heartbeat;
            out.state = 'running';
            out.error = '';
            // Replies run, but nothing reads request.cfg: photos, wallpapers and keys wait for
            // the guardian.
            out.noGuardian = true;
            if (d.provider) out.provider = d.provider;
            if (d.model) out.model = d.model;
            if (d.version) out.version = d.version;
            return out;
        });
    }

    function aiAlive(s) {
        return !!(s && typeof s.heartbeat === 'number' && Date.now() - s.heartbeat < AI_STALE_MS);
    }

    // Whether request.cfg is read: only the guardian answers requests, a bridge on its own does not.
    var AI_NO_GUARDIAN = 'Open "inZOI AI Phone" from the Windows Start menu, then try again. Only the reply service is running on this PC.';
    function aiTakesRequests(s) {
        return aiAlive(s) && !s.noGuardian;
    }

    // ------------------------------------------------------------------
    // Setting up: a phone installed without AI Phone Service (from a mod site, say) says how to
    // get it. service.cfg and daemon.cfg exist once the service has run on this PC; a phone that
    // has never seen either is told to install it, one that has is told to start it.
    // A read that fails looks the same as a missing file, so neither is said before the files
    // have been missing for AI_SETUP_MISSES reads over AI_SETUP_WAIT_MS, and a phone that has
    // seen the service this session never calls it missing again.
    // ------------------------------------------------------------------
    var AI_DOWNLOAD_URL = 'https://github.com/s2cr3t/inZOI-AI-Phone/releases/latest';
    var AI_SETUP_MISSES = 3;
    var AI_SETUP_WAIT_MS = 20000;
    var aiSetup = { state: '', seen: false, misses: 0, since: 0 };
    var aiCopyResult = null;
    var aiCopying = false;

    function aiNoteSetup(service, daemon) {
        if (service || daemon) aiSetup.seen = true;
        if (aiAlive(service) || aiAlive(daemon)) {
            aiSetup.state = '';
            aiSetup.misses = 0;
            aiSetup.since = 0;
            aiCopyResult = null;
            return;
        }
        aiSetup.misses++;
        if (!aiSetup.since) aiSetup.since = Date.now();
        if (aiSetup.state || (aiSetup.misses >= AI_SETUP_MISSES && Date.now() - aiSetup.since >= AI_SETUP_WAIT_MS)) {
            aiSetup.state = aiSetup.seen ? 'stopped' : 'missing';
        }
    }

    // For the home screen: '' while the service runs (or before it is known not to).
    function loadAiSetup() {
        return cachedRead('aisetup', 4000, function () {
            return loadAiService().then(function () { return aiSetup.state; }, function () { return aiSetup.state; });
        });
    }

    function aiCopyLink() {
        if (aiCopying) return;
        aiCopying = true;
        aiCopyResult = null;
        call('clipboard.copy', { text: AI_DOWNLOAD_URL }).then(function () {
            aiCopyResult = { ok: true, text: 'Link copied. Paste it into your browser. / 已复制，粘贴到浏览器即可。' };
        }, function () {
            aiCopyResult = { ok: false, text: 'Could not copy here. Type the address above into your browser. / 复制失败，请在浏览器里输入上面的地址。' };
        }).then(function () {
            aiCopying = false;
            aiRerender();
        });
    }

    // The AI page is opened on purpose, so it does not wait out the misses: a service seen on
    // this PC is one that is not running, anything else is one not installed.
    function aiSetupStopped(s) {
        return aiSetup.state ? aiSetup.state === 'stopped' : !!(s || aiSetup.seen);
    }

    function aiZh(text) { return node('div', 'ai-detail ai-zh', text); }

    // The status card and the download steps for a phone without a running service.
    function aiSetupCards(wrap, stopped) {
        var status = card('AI PHONE SERVICE');
        if (stopped) {
            status.appendChild(node('div', 'ai-state err', 'Not running'));
            status.appendChild(node('div', 'ai-detail', 'AI Phone Service is not running on this PC. Open "inZOI AI Phone" from the Windows Start menu to start it. After that it starts by itself whenever you sign in to Windows.'));
            status.appendChild(aiZh('AI 手机服务没有在运行。请从 Windows 开始菜单打开“inZOI AI 手机”。之后每次登录 Windows 都会自动启动。'));
            status.appendChild(node('div', 'ai-hint', 'Uninstalled it? Get it again below. / 已经卸载了？在下面重新下载。'));
        } else {
            status.appendChild(node('div', 'ai-state warn', 'One more step'));
            status.appendChild(node('div', 'ai-detail', 'The phone is installed, but AI Phone Service, which writes your family\'s replies, is not on this PC yet. It is one free download.'));
            status.appendChild(aiZh('手机已经装好，但电脑上还没有负责 AI 回复的 AI 手机服务。免费下载安装一次就好。'));
        }
        wrap.appendChild(status);

        var get = card(stopped ? 'DOWNLOAD AGAIN' : 'GET AI PHONE SERVICE');
        var copyRow = node('div', 'ph-btns ai-step-btns');
        var copy = aiButton(aiCopying ? 'Copying...' : 'Copy link', 'on', !aiCopying, aiCopyLink);
        copy.className += ' last';
        copyRow.appendChild(copy);
        var first = [copyRow, node('div', 'ai-url', AI_DOWNLOAD_URL.replace(/^https:\/\//, ''))];
        if (aiCopyResult) first.push(node('div', 'ai-result ' + (aiCopyResult.ok ? 'ok' : 'err'), aiCopyResult.text));
        get.appendChild(aiSetupStep('1', 'Copy the download link.', '复制下载地址。', first));
        get.appendChild(aiSetupStep('2', 'Press Alt+Tab to leave the game, paste the link into your browser, then download and run inZOI-AI-Phone-Setup.exe.',
            '按 Alt+Tab 切出游戏，把地址粘贴到浏览器，下载并运行 inZOI-AI-Phone-Setup.exe。'));
        get.appendChild(aiSetupStep('3', 'Leave "Start inZOI AI Phone Service now" ticked on the last page. Back in the game this page changes by itself; no restart needed.',
            '安装最后一页保持勾选“立即启动 inZOI AI 手机服务”。回到游戏后这一页会自动更新，不用重启游戏。'));
        wrap.appendChild(get);

        var after = card('THEN');
        after.appendChild(node('div', 'ai-detail', 'Pick an AI provider such as DeepSeek on this page and add your own API key. AI Phone is free; the provider bills your own account.'));
        after.appendChild(aiZh('在这一页选择 AI 服务商（如 DeepSeek），填入你自己的 API 密钥。AI 手机本身免费，AI 调用费用由你自己的账号承担。'));
        wrap.appendChild(after);
    }

    function aiSetupStep(n, en, zh, extras) {
        var row = node('div', 'ai-step');
        row.appendChild(node('div', 'ai-step-n', n));
        var text = node('div', 'ai-step-text');
        text.appendChild(node('div', 'ai-detail', en));
        text.appendChild(aiZh(zh));
        (extras || []).forEach(function (x) { text.appendChild(x); });
        row.appendChild(text);
        return row;
    }

    function aiProviders() {
        return aiService && Array.isArray(aiService.providers) ? aiService.providers : [];
    }

    function aiProvider(id) {
        var list = aiProviders();
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    }

    function aiKeyOf(id) {
        var keys = aiService && aiService.keys && typeof aiService.keys === 'object' ? aiService.keys : {};
        var k = keys[id];
        return k && typeof k === 'object' ? k : { set: false, hint: '' };
    }

    function aiLocalUrl(url) {
        return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(url || ''));
    }

    function aiSynced() {
        var s = aiService;
        return {
            provider: String(s.provider || ''),
            model: String(s.model || ''),
            base_url: String(s.base_url || ''),
            thinking: String(s.thinking || 'disabled')
        };
    }

    function aiEnsureDraft() {
        if (!aiDraft && aiAlive(aiService)) aiDraft = aiSynced();
    }

    function aiDiffers() {
        if (!aiDraft || !aiAlive(aiService)) return false;
        var s = aiSynced();
        var p = aiProvider(aiDraft.provider);
        if (aiDraft.provider !== s.provider || aiDraft.model.trim() !== s.model || aiDraft.thinking !== s.thinking) return true;
        return !!(p && p.custom && aiDraft.base_url.trim() !== s.base_url);
    }

    function loadAi() {
        return loadAiService().then(function (v) {
            aiService = v && typeof v === 'object' ? v : null;
            aiCheckAnswers();
            return { service: aiService };
        });
    }

    // Matches the service's answers to what this page asked for.
    function aiCheckAnswers() {
        var s = aiService;
        if (aiPending) {
            var r = s && s.reply && typeof s.reply === 'object' ? s.reply : null;
            if (r && r.id === aiPending.id && !r.pending) {
                var asked = aiPending;
                aiPending = null;
                aiResult = { ok: !!r.ok, type: asked.type, text: String(r.message || (r.ok ? 'Done.' : 'That did not work.')) };
                if (asked.type === 'models' && r.ok && Array.isArray(r.models)) aiModels[asked.provider] = r.models.slice(0, 300);
                if ((asked.type === 'paste_key' || asked.type === 'set_key') && r.ok && r.saved && aiDraft && aiDraft.provider === asked.provider && aiDiffers()) {
                    // The key is for the provider picked here: start using that provider now.
                    aiSaveControl(true);
                }
            } else if (Date.now() - aiPending.at > AI_REQUEST_MS) {
                aiPending = null;
                aiResult = { ok: false, text: 'No answer from AI Phone Service. Check that it is running on this PC.' };
            }
        }
        if (aiSaving) {
            if (s && typeof s.appliedRev === 'number' && s.appliedRev >= aiSaving.rev) {
                var quiet = aiSaving.quiet;
                aiSaving = null;
                if (s.controlError) {
                    aiResult = { ok: false, text: String(s.controlError) };
                } else {
                    aiDraft = null;
                    if (!quiet) aiResult = { ok: true, text: 'Saved.' };
                }
            } else if (Date.now() - aiSaving.at > AI_SAVE_MS) {
                aiSaving = null;
                aiResult = { ok: false, text: 'AI Phone Service did not pick up the change. Check that it is running on this PC.' };
            }
        }
    }

    function aiRerender() {
        if (current !== 'ai') return;
        aiRemember();
        show(renderAi({ service: aiService }));
        aiRestore();
    }

    function aiRemember() {
        var a = document.activeElement;
        aiFocus = null;
        if (a && a.id && AI_FIELDS.indexOf(a.id) >= 0) {
            aiFocus = { id: a.id, start: a.selectionStart, end: a.selectionEnd };
        }
    }

    function aiRestore() {
        if (!aiFocus) return;
        var f = document.getElementById(aiFocus.id);
        if (!f) return;
        try {
            f.focus();
            if (typeof aiFocus.start === 'number') f.setSelectionRange(aiFocus.start, aiFocus.end);
        } catch (e) {}
    }

    // Writes control.cfg. `enabled` keeps the current switch unless given.
    function aiSaveControl(quiet, enabled) {
        var s = aiService;
        if (!aiAlive(s)) return;
        var d = aiDraft || aiSynced();
        var p = aiProvider(d.provider);
        var model = d.model.trim();
        var url = d.base_url.trim();
        if (!p) {
            aiResult = { ok: false, text: 'Pick a provider.' };
            return aiRerender();
        }
        if (!AI_MODEL_RE.test(model)) {
            aiResult = { ok: false, text: model ? 'That model name has characters a model name cannot have.' : 'Enter or pick a model.' };
            return aiRerender();
        }
        if (p.custom && !/^https?:\/\/\S+$/i.test(url)) {
            aiResult = { ok: false, text: 'Enter the address of the server, starting with https://' };
            return aiRerender();
        }
        var rev = Date.now();
        var value = {
            v: 1,
            rev: rev,
            enabled: typeof enabled === 'boolean' ? enabled : s.enabled !== false,
            provider: p.id,
            model: model,
            thinking: d.thinking
        };
        if (p.custom) value.base_url = url;
        aiSaving = { rev: rev, at: Date.now(), quiet: !!quiet };
        if (!quiet) aiResult = null;
        saveJson('control', value, AI_SECTION).then(function () {
            refresh();
        }, function (err) {
            aiSaving = null;
            aiResult = { ok: false, text: 'Could not save: ' + errText(err) };
            aiRerender();
        });
        aiRerender();
    }

    // The switch only turns the service on or off; settings picked but not saved stay a draft.
    function aiSwitch(on) {
        var s = aiService;
        if (!aiAlive(s) || aiSaving || (s.enabled !== false) === on) return;
        var rev = Date.now();
        var value = { v: 1, rev: rev, enabled: on, provider: s.provider, model: s.model, thinking: s.thinking };
        var p = aiProvider(s.provider);
        if (p && p.custom) value.base_url = s.base_url;
        aiSaving = { rev: rev, at: Date.now(), quiet: true };
        aiResult = null;
        saveJson('control', value, AI_SECTION).then(function () {
            refresh();
        }, function (err) {
            aiSaving = null;
            aiResult = { ok: false, text: 'Could not switch: ' + errText(err) };
            aiRerender();
        });
        aiRerender();
    }

    function aiRequest(type, key) {
        if (!aiAlive(aiService) || aiPending) return;
        if (!aiTakesRequests(aiService)) {
            aiResult = { ok: false, text: AI_NO_GUARDIAN };
            return aiRerender();
        }
        // One request at a time goes to the service; request.cfg has room for only one.
        if (wallPending || smsPhotoPending) {
            aiResult = { ok: false, text: wallPending ? 'Finish choosing the wallpaper picture on the PC first.' : 'Finish choosing the Texts photo on the PC first.' };
            return aiRerender();
        }
        var d = aiDraft || aiSynced();
        aiSeq += 1;
        var id = 'r' + Date.now() + '-' + aiSeq;
        var value = { id: id, type: type, provider: d.provider, model: d.model.trim() };
        var p = aiProvider(d.provider);
        if (p && p.custom) value.base_url = d.base_url.trim();
        if (typeof key === 'string') value.key = key;
        aiPending = { id: id, type: type, provider: d.provider, at: Date.now() };
        aiResult = null;
        aiConfirmForget = '';
        saveJson('request', value, AI_SECTION).then(function () {
            refresh();
        }, function (err) {
            aiPending = null;
            aiResult = { ok: false, text: 'Could not send: ' + errText(err) };
            aiRerender();
        });
        aiRerender();
    }

    function aiSubmitKey() {
        var f = document.getElementById('ai-key');
        var key = (f ? f.value : aiKeyDraft).trim();
        aiKeyDraft = '';
        if (f) f.value = '';
        if (!key) {
            aiResult = { ok: false, text: 'Type or paste the key first.' };
            return aiRerender();
        }
        aiRequest('set_key', key);
    }

    function aiPickProvider(id) {
        var p = aiProvider(id);
        if (!p || !aiDraft || aiDraft.provider === id) return;
        var s = aiSynced();
        aiDraft.provider = id;
        if (id === s.provider) {
            aiDraft.model = s.model;
            aiDraft.base_url = s.base_url;
        } else {
            aiDraft.model = p.models && p.models.length ? p.models[0] : '';
            aiDraft.base_url = p.custom ? '' : p.base_url;
        }
        aiConfirmForget = '';
        aiResult = null;
        aiRerender();
    }

    function aiStateView(s) {
        var st = s.state;
        if (st === 'running') {
            if (s.ai && s.ai.ok === false) return { cls: 'err', text: 'Running, last reply failed', detail: s.ai.message || '' };
            return { cls: 'on', text: 'Running', detail: 'Texts and Moments are answered by ' + ((aiProvider(s.provider) || {}).label || s.provider) + ' ' + s.model + '.' };
        }
        if (st === 'starting') return { cls: 'on', text: 'Starting...', detail: '' };
        if (st === 'needs_key') return { cls: 'warn', text: 'Needs an API key', detail: s.error || '' };
        if (st === 'disabled') return { cls: 'off', text: 'Off', detail: 'Characters do not answer texts while AI is off.' };
        if (st === 'waiting_game') return { cls: 'err', text: 'Cannot reach the game', detail: s.error || '' };
        if (st === 'stopped') return { cls: 'off', text: 'Stopped', detail: s.error || '' };
        return { cls: 'err', text: 'Problem', detail: s.error || '' };
    }

    function aiRenderKey(data) {
        var s = data.service;
        if (!aiAlive(s)) {
            return 'dead|' + aiSetupStopped(s) + '|' + aiCopying + '|' + (aiCopyResult ? aiCopyResult.ok + aiCopyResult.text : '');
        }
        var keys = [];
        aiProviders().forEach(function (p) {
            var k = aiKeyOf(p.id);
            keys.push(p.id + ':' + (k.set ? k.hint : '-'));
        });
        var d = aiDraft || aiSynced();
        return JSON.stringify([
            s.state, s.error, s.enabled, s.provider, s.model, s.base_url, s.thinking, s.controlError, s.version,
            s.ai ? [s.ai.ok, s.ai.message] : null, keys.join(','),
            s.usage && s.usage.hour ? [s.usage.hour.calls, s.usage.hour.failed, s.usage.hour.cost, s.usage.today && s.usage.today.calls,
                s.usage.today && s.usage.today.cost, s.usage.limit, s.usage.peak, s.usage.priced, s.usage.model,
                (s.usage.purposes || []).map(function (p) { return p.id + ':' + p.calls; }).join(',')] : null,
            d.provider, d.thinking, aiPending && aiPending.id, aiSaving && aiSaving.rev, aiResult && aiResult.text,
            aiModels[d.provider] ? aiModels[d.provider].length : 0, aiConfirmForget
        ]);
    }

    function aiChip(text, on, onClick, marked) {
        var c = node('button', 'ph-chip ai-chip' + (on ? ' on' : ''));
        c.setAttribute('type', 'button');
        c.appendChild(node('span', null, text));
        if (marked) c.appendChild(node('span', 'ai-keymark'));
        onTap(c, function (e) {
            e.stopPropagation();
            onClick();
        });
        return c;
    }

    function aiButton(text, cls, enabled, onClick) {
        var b = node('button', 'ph-btn ' + (enabled ? cls : 'off'), text);
        b.setAttribute('type', 'button');
        onTap(b, function (e) {
            e.stopPropagation();
            if (enabled) onClick();
        });
        return b;
    }

    function aiInput(id, type, value, placeholder, max, onInput, onEnter) {
        var f = node('input', 'ai-input');
        f.id = id;
        f.setAttribute('type', type);
        f.setAttribute('maxlength', String(max));
        f.setAttribute('placeholder', placeholder);
        f.setAttribute('autocomplete', 'off');
        f.setAttribute('spellcheck', 'false');
        applyUiFont(f);
        f.value = value || '';
        f.addEventListener('input', function () { onInput(f.value); });
        if (onEnter) {
            f.addEventListener('keydown', function (e) {
                if (e.keyCode === 13 && !e.isComposing) {
                    if (e.preventDefault) e.preventDefault();
                    onEnter();
                }
            });
        }
        return f;
    }

    // Updates what depends on typed text without rebuilding the page.
    function aiSync() {
        var save = document.getElementById('ai-save');
        if (save) save.className = 'ph-btn' + (aiDiffers() && !aiSaving ? ' on' : ' off');
        var chips = document.querySelectorAll('.ai-model-chip');
        for (var i = 0; i < chips.length; i++) {
            var on = aiDraft && chips[i].getAttribute('data-model') === aiDraft.model.trim();
            chips[i].className = 'ph-chip ai-chip ai-model-chip' + (on ? ' on' : '');
        }
    }

    // The diagnostics export shows its progress and result in its own card, everything else
    // under Save / Test connection.
    function aiResultLine(diagnose) {
        var type = aiPending ? aiPending.type : aiResult ? aiResult.type : '';
        var mine = !aiSaving && type === 'diagnose';
        var text = '';
        if (mine === !!diagnose) {
            text = aiSaving ? 'Saving...' : aiPending ? (aiPending.type === 'paste_key' || aiPending.type === 'set_key' ? 'Checking the key with the provider...'
                : aiPending.type === 'models' ? 'Asking the provider for its models...' : aiPending.type === 'test' ? 'Testing the connection...'
                    : aiPending.type === 'diagnose' ? 'Collecting logs and settings...' : 'Working...') : aiResult ? aiResult.text : '';
        }
        var cls = aiSaving || aiPending || !text ? 'ai-result' : aiResult ? (aiResult.ok ? 'ai-result ok' : 'ai-result err') : 'ai-result';
        var line = node('div', cls, text);
        line.id = diagnose ? 'ai-diag-result' : 'ai-result';
        return line;
    }

    var AI_PURPOSES = {
        reply: 'Replies to texts',
        aftermath: 'Mood and needs after a chat',
        mood: 'Mood after a chat',
        needs: 'Needs after a chat',
        moodlet: 'Choosing a moodlet',
        same_task: 'Is it still the asked task',
        want_objects: 'Finding the right object',
        want_pick: 'Choosing the action',
        want_check: 'Checking the action',
        promise_check: 'Checking a promise',
        action_repair: 'Fixing an action plan',
        summary: 'Memory summary',
        setback: 'Texts about a setback',
        proactive: 'Texts they start',
        moments_post: 'Moments posts',
        moments_reaction: 'Moments likes and comments',
        moments_reply: 'Moments replies',
        other: 'Other'
    };
    var AI_USAGE_TOP = 6;

    function aiMoney(value, currency) {
        var sign = currency === 'CNY' ? '\u00a5' : currency === 'USD' ? '$' : currency === 'EUR' ? '\u20ac' : (currency || '') + ' ';
        var n = Number(value) || 0;
        if (n > 0 && n < 0.001) return '< ' + sign + '0.001';
        return sign + n.toFixed(n < 1 ? 3 : 2);
    }

    function aiTokens(n) {
        n = Number(n) || 0;
        if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return String(n);
    }

    function aiUsageCard(u) {
        var c = card('USAGE');
        var hour = u.hour || {};
        var today = u.today || {};
        var head = String(hour.calls || 0) + (u.limit ? ' of ' + u.limit : '') + ' AI calls';
        c.appendChild(node('div', 'ai-usage-big', head));
        c.appendChild(node('div', 'ai-detail', 'in the last 60 minutes' + (u.priced ? ', about ' + aiMoney(hour.cost, u.currency) : '')));
        if (hour.failed) c.appendChild(node('div', 'ai-detail st-warn', hour.failed + ' of them failed. Failed calls are not billed.'));
        if (u.limit && hour.calls >= u.limit * 0.8) {
            c.appendChild(node('div', 'ai-detail st-warn', hour.calls >= u.limit
                ? 'The hourly cap is reached. Characters wait before they answer again.'
                : 'Close to the hourly cap. When it is reached, characters wait before they answer again.'));
        }
        c.appendChild(node('div', 'ai-line', 'Today: ' + (today.calls || 0) + ' calls' + (u.priced ? ', about ' + aiMoney(today.cost, u.currency) : '')));
        var purposes = Array.isArray(u.purposes) ? u.purposes : [];
        if (purposes.length) {
            var list = node('div', 'ai-usage-list');
            purposes.slice(0, AI_USAGE_TOP).forEach(function (p) {
                var row = node('div', 'ai-usage-row');
                row.appendChild(node('span', 'ai-usage-name', AI_PURPOSES[p.id] || p.id));
                row.appendChild(node('span', 'ai-usage-count', String(p.calls) + (u.priced && p.cost ? ' \u00b7 ' + aiMoney(p.cost, u.currency) : '')));
                list.appendChild(row);
            });
            if (purposes.length > AI_USAGE_TOP) {
                var rest = 0;
                purposes.slice(AI_USAGE_TOP).forEach(function (p) { rest += p.calls; });
                var more = node('div', 'ai-usage-row');
                more.appendChild(node('span', 'ai-usage-name', 'Everything else'));
                more.appendChild(node('span', 'ai-usage-count', String(rest)));
                list.appendChild(more);
            }
            c.appendChild(list);
        }
        c.appendChild(node('div', 'ai-hint', 'Tokens in the last 60 minutes: ' + aiTokens(hour.prompt) + ' sent (' + aiTokens(hour.cached) + ' from cache), ' + aiTokens(hour.completion) + ' received.'));
        var note;
        if (!u.priced) {
            note = 'No price is known for this model, so only calls and tokens are shown. To see a cost, add "price" under "llm" in config.json, for example "price": {"input": 2, "cached": 0.5, "output": 8, "currency": "CNY"} (per million tokens).';
        } else if (u.priceSource === 'config') {
            note = 'Cost uses the prices set in config.json. It is an estimate; the bill on the provider\'s website is the real figure.';
        } else {
            note = 'Cost uses DeepSeek\'s published prices' + (u.peak === true ? ', peak hours now (full price)' : u.peak === false ? ', off-peak now (half price)' : '') +
                '. It is an estimate; the bill on the provider\'s website is the real figure.';
        }
        if (u.priced && hour.unpriced) note += ' ' + hour.unpriced + ' call(s) came back without token counts and are not in the cost.';
        c.appendChild(node('div', 'ai-hint', note));
        return c;
    }

    function aiSupportCard() {
        var c = card('SUPPORT');
        var btns = node('div', 'ph-btns');
        btns.style.marginTop = '0';
        var b = aiButton('Export diagnostics', '', !aiPending, function () { aiRequest('diagnose'); });
        b.className += ' last';
        btns.appendChild(b);
        c.appendChild(btns);
        c.appendChild(aiResultLine(true));
        c.appendChild(node('div', 'ai-hint', 'Saves the recent logs and settings as one zip file in Documents\\inZOI\\AI Phone Diagnostics. API keys are removed from it. The chat messages stay in, so the problem can be traced. Send the zip together with what happened and roughly when.'));
        return c;
    }

    function renderAi(data) {
        var s = data.service;
        var wrap = node('div');
        wrap.id = 'ai-screen';
        wrap.appendChild(subHeader('ai'));
        aiRenderedKey = aiRenderKey(data);

        if (!aiAlive(s)) {
            aiSetupCards(wrap, aiSetupStopped(s));
            return wrap;
        }
        var status = card('AI PHONE SERVICE');
        aiEnsureDraft();
        var d = aiDraft;
        var view = aiStateView(s);
        status.appendChild(node('div', 'ai-state ' + view.cls, view.text));
        if (view.detail) status.appendChild(node('div', 'ai-detail', view.detail));
        var onOff = node('div', 'ph-btns');
        var enabled = s.enabled !== false;
        onOff.appendChild(aiButton('On', enabled ? 'on' : '', !aiSaving, function () { aiSwitch(true); }));
        var off = aiButton('Off', enabled ? '' : 'on', !aiSaving, function () { aiSwitch(false); });
        off.className += ' last';
        onOff.appendChild(off);
        status.appendChild(onOff);
        wrap.appendChild(status);
        if (s.usage && typeof s.usage === 'object' && s.usage.hour) wrap.appendChild(aiUsageCard(s.usage));

        var p = aiProvider(d.provider) || aiProvider(s.provider);
        var providerCard = card('PROVIDER');
        var pchips = node('div', 'ph-chips');
        aiProviders().forEach(function (item) {
            pchips.appendChild(aiChip(item.label, item.id === d.provider, function () { aiPickProvider(item.id); }, aiKeyOf(item.id).set));
        });
        providerCard.appendChild(pchips);
        providerCard.appendChild(node('div', 'ai-hint', 'A green dot means a key is saved for that provider.'));
        wrap.appendChild(providerCard);
        if (!p) return wrap;

        var key = aiKeyOf(p.id);
        var keyCard = card('API KEY');
        keyCard.appendChild(node('div', 'ai-line', key.set ? 'Saved: ' + (key.hint || 'yes') : 'No key saved for ' + p.label + '.'));
        var keyBtns = node('div', 'ph-btns');
        var paste = aiButton('Paste key', 'on', !aiPending, function () { aiRequest('paste_key'); });
        keyBtns.appendChild(paste);
        if (key.set) {
            var asking = aiConfirmForget === p.id;
            var forget = aiButton(asking ? 'Tap to confirm' : 'Remove key', asking ? 'warn' : '', !aiPending, function () {
                if (aiConfirmForget === p.id) {
                    aiConfirmForget = '';
                    aiRequest('forget_key');
                } else {
                    aiConfirmForget = p.id;
                    aiRerender();
                }
            });
            forget.className += ' last';
            keyBtns.appendChild(forget);
        } else {
            paste.className += ' last';
        }
        keyCard.appendChild(keyBtns);
        var typeRow = node('div', 'ai-row');
        typeRow.appendChild(aiInput('ai-key', 'password', aiKeyDraft, 'Or type the key here', AI_KEY_MAX, function (v) { aiKeyDraft = v; }, aiSubmitKey));
        var saveKey = node('button', 'mo-btn' + (aiPending ? ' mo-btn-off' : ''), 'Save');
        saveKey.setAttribute('type', 'button');
        onTap(saveKey, function (e) {
            e.stopPropagation();
            if (!aiPending) aiSubmitKey();
        });
        typeRow.appendChild(saveKey);
        keyCard.appendChild(typeRow);
        keyCard.appendChild(node('div', 'ai-hint', (p.key_site ? 'Create a key at ' + p.key_site + ' and copy it. ' : '') +
            'Paste key reads the key from the Windows clipboard. It is checked with the provider, then stored encrypted on this PC and never shown again.'));
        wrap.appendChild(keyCard);

        if (p.custom) {
            var urlCard = card('SERVER ADDRESS');
            var urlRow = node('div', 'ai-row');
            urlRow.appendChild(aiInput('ai-url', 'text', d.base_url, 'https://example.com/v1', AI_URL_MAX, function (v) {
                d.base_url = v;
                aiSync();
            }));
            urlCard.appendChild(urlRow);
            urlCard.appendChild(node('div', 'ai-hint', 'Any server that speaks the OpenAI chat completions protocol. http:// is allowed only for a server on this PC.'));
            wrap.appendChild(urlCard);
        }

        var modelCard = card('MODEL');
        var listed = [];
        (p.models || []).concat(aiModels[p.id] || []).forEach(function (m) {
            if (typeof m === 'string' && listed.indexOf(m) < 0) listed.push(m);
        });
        if (listed.length) {
            var mchips = node('div', 'ph-chips');
            listed.slice(0, AI_MODEL_CHIPS).forEach(function (m) {
                var chip = aiChip(m, d.model.trim() === m, function () {
                    d.model = m;
                    var f = document.getElementById('ai-model');
                    if (f) f.value = m;
                    aiSync();
                });
                chip.className += ' ai-model-chip';
                chip.setAttribute('data-model', m);
                mchips.appendChild(chip);
            });
            modelCard.appendChild(mchips);
            if (listed.length > AI_MODEL_CHIPS) {
                modelCard.appendChild(node('div', 'ai-hint', 'Showing ' + AI_MODEL_CHIPS + ' of ' + listed.length + ' models. Type any other name below.'));
            }
        }
        var modelRow = node('div', 'ai-row');
        modelRow.appendChild(aiInput('ai-model', 'text', d.model, 'Model name', 128, function (v) {
            d.model = v;
            aiSync();
        }));
        var canList = !aiPending && (key.set || (p.custom && aiLocalUrl(d.base_url)));
        var fetchBtn = node('button', 'mo-btn mo-btn-plain' + (canList ? '' : ' mo-btn-off'), 'Fetch list');
        fetchBtn.setAttribute('type', 'button');
        onTap(fetchBtn, function (e) {
            e.stopPropagation();
            if (canList) aiRequest('models');
        });
        modelRow.appendChild(fetchBtn);
        modelCard.appendChild(modelRow);
        modelCard.appendChild(node('div', 'ai-hint', 'Fetch list asks the provider which models your key can use.'));
        wrap.appendChild(modelCard);

        var thinkCard = card('DEEP THINKING');
        var tchips = node('div', 'ph-chips');
        AI_THINKING.forEach(function (t) {
            tchips.appendChild(aiChip(t.label, d.thinking === t.id, function () {
                d.thinking = t.id;
                aiRerender();
            }));
        });
        thinkCard.appendChild(tchips);
        thinkCard.appendChild(node('div', 'ai-hint', 'Off answers fastest and costs least. Higher levels think longer before each reply and use more of your credit. Models that cannot switch it off use the lowest level they allow.'));
        wrap.appendChild(thinkCard);

        var actions = card();
        var actionBtns = node('div', 'ph-btns');
        actionBtns.style.marginTop = '0';
        var save = aiButton('Save', 'on', true, function () {
            if (aiDiffers() && !aiSaving) aiSaveControl(false);
        });
        save.id = 'ai-save';
        actionBtns.appendChild(save);
        var test = aiButton('Test connection', '', !aiPending, function () { aiRequest('test'); });
        test.className += ' last';
        actionBtns.appendChild(test);
        actions.appendChild(actionBtns);
        actions.appendChild(aiResultLine());
        actions.appendChild(node('div', 'ai-version', 'AI Phone Service ' + (s.version || '') + (s.installed ? '' : ' (development copy)')));
        wrap.appendChild(actions);
        wrap.appendChild(aiSupportCard());
        setTimeout(aiSync, 0);
        return wrap;
    }

