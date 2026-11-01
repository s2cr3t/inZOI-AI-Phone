'use strict';
// Character settings the player edits on the phone, one folder per character:
//   <phone>/ui/phone/persona/<characterId>/profile.cfg   written only by the phone
//       { v: 1, at, extra: string | null, styles: { <playerId>: string | null } }
//       extra   what the player wrote about this character; null: nothing written
//       styles  how the character talks to that played character; null or missing: the
//               built-in style. An empty string is a choice too: no style at all.
//   <phone>/ui/phone/persona/<characterId>/default.cfg   written only by the bridge
//       { v: 1, at, name, extra, styles: { <playerId>: { text, role, call } } }
//       what the phone shows as the default and restores
// The reply rules and the output format are not part of either file and stay in persona.js.
const path = require('path');
const fsx = require('./fsx');
const { sanitizeText } = require('./mailbox');

const STYLE_MAX = 1500;
const EXTRA_MAX = 800;
const ID_RE = /^\d+$/;
const READ_REUSE_MS = 1500;

function cleanText(v, max) {
    if (typeof v !== 'string') return null;
    return sanitizeText(v, max);
}

class Personas {
    constructor(log) {
        this.log = log;
        this.dir = '';
        this.published = new Map();
        this.cache = new Map();
    }

    configure(phoneDir) {
        const next = path.join(phoneDir, 'persona');
        if (next !== this.dir) {
            this.dir = next;
            this.published.clear();
            this.cache.clear();
        }
    }

    folder(characterId) {
        const id = String(characterId);
        if (!ID_RE.test(id)) throw new Error('invalid character id ' + id);
        return path.join(this.dir, id);
    }

    // What the player set for this character. A file that cannot be read right now counts as
    // nothing set, and is read again on the next prompt.
    profile(characterId) {
        if (!this.dir) return null;
        const id = String(characterId);
        if (!ID_RE.test(id)) return null;
        const hit = this.cache.get(id);
        if (hit && Date.now() - hit.at < READ_REUSE_MS) return hit.value;
        const r = fsx.readJson(path.join(this.folder(id), 'profile.cfg'));
        let value = null;
        if (r.ok && r.value && typeof r.value === 'object' && !Array.isArray(r.value)) {
            const styles = {};
            const raw = r.value.styles && typeof r.value.styles === 'object' ? r.value.styles : {};
            for (const k of Object.keys(raw)) {
                if (!ID_RE.test(k)) continue;
                const s = cleanText(raw[k], STYLE_MAX);
                if (s !== null) styles[k] = s;
            }
            value = { extra: cleanText(r.value.extra, EXTRA_MAX), styles };
        } else if (!r.ok && !r.missing && this.log) {
            this.log.debug('persona ' + id + ': profile unreadable (' + r.error + ')');
        }
        this.cache.set(id, { at: Date.now(), value });
        return value;
    }

    // { style, extra }: each is a string the player set, or undefined for the built-in one.
    custom(characterId, playerId) {
        const p = this.profile(characterId);
        if (!p) return { style: undefined, extra: undefined };
        const style = Object.prototype.hasOwnProperty.call(p.styles, String(playerId)) ? p.styles[String(playerId)] : undefined;
        return { style, extra: p.extra === null ? undefined : p.extra };
    }

    // The character's own setting for prompts that are not about one played character
    // (Moments posts and replies): what the player wrote, else config.json.
    extraFor(characterId, cfgExtra) {
        const c = this.custom(characterId, '');
        if (typeof c.extra === 'string') return c.extra;
        return cfgExtra ? String(cfgExtra) : '';
    }

    // Writes default.cfg when what it would say has changed.
    publishDefault(characterId, name, cfgExtra, playerId, style) {
        if (!this.dir) return;
        const id = String(characterId);
        const pid = String(playerId);
        if (!ID_RE.test(id) || !ID_RE.test(pid)) return;
        const prev = this.published.get(id);
        let value;
        if (prev) {
            value = JSON.parse(prev);
        } else {
            const r = fsx.readJson(path.join(this.folder(id), 'default.cfg'));
            value = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
        }
        if (!value.styles || typeof value.styles !== 'object') value.styles = {};
        value.v = 1;
        value.name = String(name || '');
        value.extra = cfgExtra ? String(cfgExtra) : '';
        value.styles[pid] = { text: String(style.text || ''), role: String(style.role || ''), call: String(style.call || '') };
        const before = prev ? JSON.stringify(Object.assign({}, JSON.parse(prev), { at: 0 })) : '';
        const after = JSON.stringify(Object.assign({}, value, { at: 0 }));
        if (before === after) return;
        value.at = Date.now();
        fsx.writeJson(path.join(this.folder(id), 'default.cfg'), value);
        this.published.set(id, JSON.stringify(value));
    }
}

module.exports = { Personas, STYLE_MAX, EXTRA_MAX };
