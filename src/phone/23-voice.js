    // ---- voice input in the texts ----
    // The service (sms-bridge lib/voice.js) hears the player while they hold its key, and writes
    // what goes on to ui/phone/voice/state.cfg {seq, state, why, text, key_en}: listening |
    // thinking | heard | error. With a conversation open (a text or a group), a line above the
    // box says so; what was heard lands in the box and is sent by itself a moment later, unless
    // a key is pressed first to change it. While a conversation is open the phone stamps
    // ui/phone/voice/box.cfg {at}, which is how the service knows the words are for the phone.
    var VOICE_SECTION = 'ui/phone/voice';
    var VOICE_POLL_MS = 700;
    var VOICE_IDLE_POLL_MS = 2500;
    var VOICE_BUSY_POLL_MS = 250;     // while recording or working one out
    var VOICE_STAMP_MS = 4000;
    var VOICE_FRESH_MS = 8000;
    var VOICE_SEND_S = 2;
    var VOICE_ERRORS = { no_microphone: 'No microphone found', unclear: 'Didn\'t catch that, say it again' };
    var voiceSeq = Date.now() * 10;
    var voiceStampAt = 0;
    var voiceTimer = null;
    var voiceWaiting = false;     // heard words are in the box, about to be sent

    // The box of the conversation on screen; none while the phone is put away.
    function voiceBox() {
        if (wf.root && wf.root._minimized) return null;
        return document.getElementById('sms-box');
    }

    function voiceNote(text, cls) {
        if (voiceTimer) { clearTimeout(voiceTimer); voiceTimer = null; }
        voiceWaiting = false;
        var bar = document.getElementById('sms-dictate');
        var box = voiceBox();
        if (!text || !box) {
            if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
            return;
        }
        if (!bar) {
            // Above the field the box sits in, inside the composer.
            var field = box.parentNode;
            if (!field || !field.parentNode) return;
            bar = node('div', 'sms-dictate');
            bar.id = 'sms-dictate';
            bar.appendChild(node('span', 'sms-dictate-dot'));
            bar.appendChild(node('span', 'sms-dictate-text'));
            field.parentNode.insertBefore(bar, field);
        }
        bar.className = 'sms-dictate ' + (cls || '');
        bar.lastChild.textContent = text;
    }

    function voiceNoteShown() {
        var bar = document.getElementById('sms-dictate');
        return !!bar && bar.className.indexOf('err') < 0;
    }

    function voiceSend() {
        var box = voiceBox();
        voiceNote('');
        if (!box || !String(box.value || '').replace(/\s/g, '')) return;
        if (box.className.indexOf('sms-ginput') >= 0) sendGroup();
        else sendSms();
    }

    function voiceCountdown(left) {
        if (left <= 0) { voiceSend(); return; }
        voiceNote('Sending in ' + left + ' · press any key to edit', 'heard');
        voiceWaiting = true;
        voiceTimer = setTimeout(function () { voiceTimer = null; voiceCountdown(left - 1); }, 1000);
    }

    // The words go in as if typed: the box's own input handler keeps the draft, the box's height
    // and the send button.
    function voiceType(text) {
        var box = voiceBox();
        if (!box) return false;
        var max = Number(box.getAttribute('maxlength')) || 400;
        box.value = ((box.value ? box.value + ' ' : '') + text).slice(0, max);
        var ev = document.createEvent('Event');
        ev.initEvent('input', true, true);
        box.dispatchEvent(ev);
        return true;
    }

    // ---- the microphone button ----
    // Where the send button is while the box is empty (the send button comes back with the first
    // letter): tap it, speak, tap it again. The phone asks the service through
    // ui/phone/voice/request.cfg {seq, op: start | stop, at}; the service records as if the key
    // were held, and what it hears comes back the same way as for the key.
    var VOICE_START_WAIT_MS = 4000;   // no word from the service by then: it is not running
    var VOICE_REC_MAX_MS = 31000;     // the service stops a recording at 30 s
    var voiceAvailable = false;       // the service has voice input on (its state says so)
    var voiceRec = 0;                 // when the button started a recording, or 0
    var voiceHeard = false;           // the service said it is listening to this recording
    var voiceReqSeq = Date.now() * 10;

    function micGlyph(rec) {
        var svg = glyphSvg('0 0 24 24');
        svg.setAttribute('class', 'sms-mic-ico');
        if (rec) {
            glyphShape(svg, 'rect', { x: 7, y: 7, width: 10, height: 10, rx: 2, fill: '#ffffff' });
            return svg;
        }
        glyphShape(svg, 'rect', { x: 9, y: 3, width: 6, height: 11, rx: 3, fill: '#ffffff' });
        glyphPath(svg, 'M6.3 11.2a5.7 5.7 0 0 0 11.4 0h-1.7a4 4 0 0 1-8 0H6.3zM11.15 17.6h1.7v3h-1.7z', '#ffffff');
        return svg;
    }

    function voiceAsk(op) {
        voiceReqSeq = Math.max(voiceReqSeq + 1, Date.now() * 10);
        soft(call('uimod.cfg_save', { mod_id: SMS_MOD, section: VOICE_SECTION, key: 'request', value: JSON.stringify({ seq: voiceReqSeq, op: op, at: Date.now() }) }));
    }

    function voiceRecEnd() {
        voiceRec = 0;
        voiceHeard = false;
        voiceSyncField();
    }

    function voiceMicTap() {
        if (voiceRec) {
            voiceAsk('stop');
            voiceRecEnd();
            voiceNote('Working out what you said...', 'thinking');
            return;
        }
        var box = voiceBox();
        if (!box) return;
        voiceAsk('start');
        var started = voiceRec = Date.now();
        voiceHeard = false;
        voiceSyncField();
        voiceNote('Listening... tap ■ when done', 'listening');
        setTimeout(function () {
            if (voiceRec !== started || voiceHeard) return;
            voiceRecEnd();
            voiceNote('Voice input is not running', 'err');
            voiceTimer = setTimeout(function () { voiceTimer = null; voiceNote(''); }, 3000);
        }, VOICE_START_WAIT_MS);
    }

    // The button in the conversation's field, and which of it and send shows: the microphone
    // while the box is empty (or while it records), send once there is something to send.
    function voiceSyncField() {
        var box = voiceBox();
        var field = box ? box.parentNode : null;
        if (!field) return;
        var mic = field.getElementsByClassName('sms-mic')[0];
        if (!mic) {
            mic = node('button', 'sms-mic');
            mic.type = 'button';
            mic.setAttribute('title', 'Voice input');
            onTap(mic, function (e) { e.stopPropagation(); voiceMicTap(); }, { silent: true });
            field.appendChild(mic);
        }
        // A text's photo waiting to go counts as something to send; groups take no photos.
        var photo = box.className.indexOf('sms-ginput') < 0 && smsThread && smsPhotos[smsThread];
        var empty = !photo && !String(box.value || '').replace(/\s/g, '');
        var want = 'sms-field' + (voiceAvailable && (empty || voiceRec) ? ' vc-mic' : '') + (voiceRec ? ' vc-rec' : '');
        if (field.className !== want) field.className = want;
        var rec = voiceRec ? 'rec' : 'mic';
        if (mic._shows !== rec) {
            mic._shows = rec;
            while (mic.firstChild) mic.removeChild(mic.firstChild);
            mic.appendChild(micGlyph(!!voiceRec));
        }
    }

    function voiceShow(v) {
        if (v && typeof v.enabled === 'boolean' && v.enabled !== voiceAvailable) {
            voiceAvailable = v.enabled;
            voiceSyncField();
        }
        if (!v || typeof v.seq !== 'number' || v.seq <= voiceSeq) return;
        voiceSeq = v.seq;
        if (Date.now() - (v.at || 0) > VOICE_FRESH_MS || !voiceBox()) return;
        var key = v.key_en || 'the key';
        if (v.state !== 'listening' && voiceRec) voiceRecEnd();
        if (v.state === 'listening') {
            if (voiceRec) voiceHeard = true;
            voiceNote(voiceRec ? 'Listening... tap ■ when done' : 'Listening... release ' + key, 'listening');
        } else if (v.state === 'thinking') voiceNote('Working out what you said...', 'thinking');
        else if (v.state === 'heard' && v.text) {
            if (voiceType(v.text)) voiceCountdown(VOICE_SEND_S);
        } else if (v.state === 'error') {
            voiceNote(VOICE_ERRORS[v.why] || 'Voice input did not work', 'err');
            voiceTimer = setTimeout(function () { voiceTimer = null; voiceNote(''); }, 3000);
        } else voiceNote('');
    }

    function voicePoll() {
        var open = !!voiceBox();
        setTimeout(voicePoll, !open ? VOICE_IDLE_POLL_MS : (voiceRec || voiceNoteShown() ? VOICE_BUSY_POLL_MS : VOICE_POLL_MS));
        // Left the conversation (or put the phone away) while recording: the recording stops.
        if (voiceRec && (!open || Date.now() - voiceRec > VOICE_REC_MAX_MS)) {
            if (!open) voiceAsk('stop');
            voiceRecEnd();
        }
        if (!open) return;
        voiceSyncField();
        if (Date.now() - voiceStampAt > VOICE_STAMP_MS) {
            voiceStampAt = Date.now();
            soft(call('uimod.cfg_save', { mod_id: SMS_MOD, section: VOICE_SECTION, key: 'box', value: JSON.stringify({ at: voiceStampAt }) }));
        }
        cfgValue(VOICE_SECTION, 'state').then(voiceShow, function () {});
    }
    setTimeout(voicePoll, 5000);

    // A key pressed in the box while the heard words wait: the player changes them and sends
    // them with Enter.
    document.addEventListener('keydown', function (e) {
        if (voiceWaiting && e.target && e.target.id === 'sms-box') voiceNote('');
    }, true);

