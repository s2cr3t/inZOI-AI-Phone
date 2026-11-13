'use strict';
// How one character texts: a few habits fixed per person, so a family's members do not all
// sound like the same lively assistant. Drawn from the character's game traits where those point
// somewhere and from their id otherwise, so it is the same every time without being stored, and
// two characters with the same traits still differ in their catchphrase and favourite emoji.
//   talk     terse (a line, sometimes a second), plain (one, now and then two), chatty (two, three)
//   emoji    none, rare (now and then one), fond (their own one or two, often)
//   punct    bare (no full stops), proper, exclaim, trail (……)
//   phrases  one or two catchphrases of their age, said now and then
// The card goes into the prompt (persona.voiceBlock), and what the model is known to overdo
// (too many texts, an emoji on every one, full stops a bare texter would not type) is held to it
// in code afterwards (shape).
const crypto = require('crypto');

const TERSE = ['Introvert', 'Shy', 'Gloomy', 'Loner', 'Observer', 'Genius', 'Independent'];
const CHATTY = ['Extrovert', 'Outgoing', 'Energetic', 'Popular', 'Entertainer', 'Needy', 'Childish', 'Active'];
const EMOJI_NONE = ['Gloomy', 'Mean', 'Arrogant', 'Intellect', 'Workaholic', 'Perfectionist', 'Genius'];
const EMOJI_FOND = ['Cheerful', 'Childish', 'Popular', 'Needy', 'Romantic', 'Entertainer', 'Flirt'];
const PUNCT = {
    proper: ['Perfectionist', 'Intellect', 'Neat', 'Bookworm', 'Achiever', 'Workaholic'],
    exclaim: ['Hothead', 'Energetic', 'Activist', 'Adventurer', 'Excited'],
    trail: ['Gloomy', 'Dreamer', 'Shy', 'Romantic'],
    bare: ['Lazy', 'Messy', 'Loner', 'Independent', 'Genius']
};
const PUNCT_TEXT = {
    bare: '句末基本不打句号，一句话说完就发，逗号也少用，要停顿就空一格或者干脆分两条',
    proper: '标点打得齐，逗号句号都有，像认真打字的人',
    exclaim: '爱用感叹号，情绪一上来就是“！”',
    trail: '爱用省略号收尾（……），话常常像没说完'
};
const TALK = {
    terse: { max: 2, text: '话少：一般就一条，几个字到一句话；有事要说清楚才发第二条' },
    plain: { max: 2, text: '一般一条，偶尔补一条' },
    chatty: { max: 3, text: '话多：想到就说，常常连发两三条' }
};
const PHRASES = {
    kid: ['我跟你说', '才不是呢', '好耶', '不嘛', '你猜', '超级', '哼', '真的吗真的吗', '我不管', '为什么呀', '我最厉害', '拉钩'],
    teen: ['离谱', '绝了', '无语', '真的会谢', '啊这', '笑死', '随便', '我真服了', '还行吧', '懂了懂了', '别管我', '好家伙', '救命', '有一说一', '确实'],
    adult: ['行吧', '得了', '你说呢', '看情况', '可以啊', '算了算了', '讲真', '回头再说', '没事儿', '那不然呢', '我寻思', '也行', '多大点事', '你看你', '靠谱', '就这么定了', '再说吧', '好家伙', '不至于', '我就说嘛'],
    elder: ['哎哟', '你这孩子', '慢点慢点', '我跟你讲', '那可不', '别瞎折腾', '记得啊', '好好好', '吃了没', '听话', '想当年', '由他去吧']
};
const FAV = {
    bright: ['开心', '大笑', '得意', '调皮', '偷笑', '胜利'],
    sweet: ['抱抱', '爱心', '亲亲', '害羞', '委屈'],
    cool: ['OK', '点赞', '思考', '无语', '白眼'],
    elder: ['玫瑰', '点赞', '鼓掌', '握手', '太阳'],
    kid: ['开心', '调皮', '委屈', '大哭', '馋', '猫']
};
const TOKEN_RE = /\[[^\[\]\s]{1,6}\]/g;
const PICTO_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\p{Extended_Pictographic}]*/gu;

function traitKeys(traits) {
    const tr = traits || {};
    return (tr.traits || []).concat(tr.characteristics || [])
        .map((id) => String(id || '').replace(/^(Trait_|Characteristic_|Personality_|Char_)/i, ''));
}

function ageBand(group) {
    const g = String(group || '');
    if (/^(Child)$/.test(g)) return 'kid';
    if (/Teen$/.test(g) || g === 'Teen') return 'teen';
    if (/^(Old|Elderly|Elder)$/.test(g)) return 'elder';
    return 'adult';
}

function bytesOf(id) {
    return crypto.createHash('md5').update('speech:' + String(id)).digest();
}

function count(keys, list) {
    let n = 0;
    for (const k of keys) if (list.includes(k)) n++;
    return n;
}

// partner: { id, traits, ageGroup }
function card(partner) {
    const p = partner || {};
    const keys = traitKeys(p.traits);
    const b = bytesOf(p.id);
    const band = ageBand(p.ageGroup);
    const terse = count(keys, TERSE);
    const chatty = count(keys, CHATTY);
    let talk = terse > chatty ? 'terse' : chatty > terse ? 'chatty' : null;
    if (!talk) talk = b[0] % 10 < 2 ? 'terse' : b[0] % 10 < 8 ? 'plain' : 'chatty';
    const none = count(keys, EMOJI_NONE);
    const fond = count(keys, EMOJI_FOND);
    let mode = none > fond ? 'none' : fond > none ? 'fond' : null;
    if (!mode) mode = band === 'kid' ? (b[1] % 3 ? 'fond' : 'rare') : ['none', 'rare', 'rare', 'fond'][b[1] % 4];
    let punct = null;
    let best = 0;
    for (const k of Object.keys(PUNCT)) {
        const n = count(keys, PUNCT[k]);
        if (n > best) {
            best = n;
            punct = k;
        }
    }
    if (!punct) punct = band === 'elder' ? (b[2] % 2 ? 'proper' : 'trail') : ['bare', 'bare', 'proper', 'exclaim', 'trail'][b[2] % 5];
    const pool = PHRASES[band];
    const first = pool[b[3] % pool.length];
    let second = pool[b[4] % pool.length];
    const phrases = talk === 'terse' || second === first ? [first] : [first, second];
    // Favourites follow the side of them that shows most: bright, sweet or cool.
    const leans = [
        [FAV.bright, count(keys, ['Cheerful', 'Entertainer', 'Popular', 'Childish', 'Extrovert', 'Energetic', 'Outgoing'])],
        [FAV.sweet, count(keys, ['Romantic', 'Needy', 'Flirt', 'Kind', 'Shy'])],
        [FAV.cool, count(keys, ['Intellect', 'Genius', 'Arrogant', 'Lazy', 'Independent', 'Mean'])]
    ];
    const most = Math.max(leans[0][1], leans[1][1], leans[2][1]);
    const tied = leans.filter((l) => l[1] === most).map((l) => l[0]);
    const favPool = band === 'elder' ? FAV.elder : band === 'kid' ? FAV.kid : tied[b[5] % tied.length];
    const fav = [favPool[b[6] % favPool.length]];
    const other = favPool[b[7] % favPool.length];
    if (other !== fav[0]) fav.push(other);
    return { talk, max: TALK[talk].max, emoji: mode, fav, punct, phrases };
}

// The card in words, for the prompt. talk: face to face (no emoji, no typing habits).
function text(c, talk) {
    const lines = ['【你的说话习惯】这些是你独有的，和别人不一样，每次都要照着来：'];
    lines.push('- ' + TALK[c.talk].text + '。');
    if (!talk) {
        lines.push('- ' + PUNCT_TEXT[c.punct] + '。');
        if (c.emoji === 'none') lines.push('- 你发消息从来不带表情，一个都不发。');
        else if (c.emoji === 'rare') lines.push('- 表情很少发，好几次回复才偶尔带一个，大多数时候一个都没有。');
        else lines.push('- 你爱发表情，常用的是' + c.fav.map((n) => '[' + n + ']').join('') + '，别的很少用；一条里最多一个。');
    }
    lines.push('- 口头禅：' + c.phrases.map((s) => '“' + s + '”').join('、') + '。偶尔顺嘴说出来，十次里一两次，不是每次都说。');
    return lines.join('\n');
}

function stripEmoji(s) {
    return s.replace(TOKEN_RE, '').replace(PICTO_RE, '').replace(/\s{2,}/g, ' ').trim();
}

// How many texts this reply is, drawn fresh each time: a real person does not answer everything
// with the same number of texts. Mostly one; a talker sometimes two or three, a quiet one hardly
// ever more than one. A word or an emoji from the player mostly gets one back; a long message or
// several in a row may get more. said: the player's texts being answered ([] for a message the
// character starts). max: the service's own limit.
const ODDS = {
    terse: { short: [1, 0, 0], usual: [0.85, 0.15, 0], long: [0.7, 0.3, 0] },
    plain: { short: [0.85, 0.15, 0], usual: [0.6, 0.35, 0.05], long: [0.45, 0.45, 0.1] },
    chatty: { short: [0.55, 0.35, 0.1], usual: [0.35, 0.4, 0.25], long: [0.25, 0.4, 0.35] }
};

function pick(c, said, max, rand) {
    const r = rand || Math.random;
    const texts = (said || []).map((s) => String(s || ''));
    const words = texts.join('').replace(TOKEN_RE, '').replace(PICTO_RE, '').replace(/[^\p{L}\p{N}]/gu, '').length;
    const kind = texts.length && words <= 4 ? 'short' : texts.length >= 3 || words >= 30 ? 'long' : 'usual';
    const odds = ODDS[c.talk][kind];
    const x = r();
    let n = x < odds[0] ? 1 : x < odds[0] + odds[1] ? 2 : 3;
    return Math.max(1, Math.min(n, c.max, max || 3));
}

// Holds a reply's texts to the card: no more texts than the card allows (the rest run on in the
// last one, nothing dropped), emoji as often as this person uses them, no full stop at the end
// for a bare texter. voice: the texts as read aloud (persona rule 10c), kept in step; may be null.
// Returns { messages, voice }.
// target: this reply's count from pick(), when one was drawn.
function shape(c, messages, voice, rand, target) {
    const r = rand || Math.random;
    let msgs = messages.slice();
    let said = Array.isArray(voice) ? voice.slice() : null;
    if (c.emoji === 'none' || (c.emoji === 'rare' && r() >= 0.35)) {
        msgs = msgs.map(stripEmoji);
    } else {
        // rare: one in the reply at most; fond: one per text, two in the reply at most.
        let left = c.emoji === 'rare' ? 1 : 2;
        msgs = msgs.map((m) => {
            let inThis = 0;
            return m.replace(TOKEN_RE, (tok) => {
                if (left > 0 && inThis === 0) {
                    left--;
                    inThis++;
                    return tok;
                }
                return '';
            }).trim();
        });
    }
    const keep = [];
    const keepSaid = [];
    for (let i = 0; i < msgs.length; i++) {
        if (!msgs[i]) continue;
        keep.push(msgs[i]);
        if (said) keepSaid.push(said[i] || msgs[i]);
    }
    // A reply that was nothing but an emoji stays one: answering with a face is fine for anyone.
    if (!keep.length) return { messages: messages.slice(0, 1), voice: Array.isArray(voice) ? voice.slice(0, 1) : null };
    msgs = keep;
    said = said ? keepSaid : null;
    const max = Math.max(1, Math.min(c.max, target || c.max));
    if (msgs.length > max) {
        const head = msgs.slice(0, max - 1);
        head.push(msgs.slice(max - 1).join(' '));
        msgs = head;
        if (said) {
            const sh = said.slice(0, max - 1);
            sh.push(said.slice(max - 1).join('，'));
            said = sh;
        }
    }
    if (c.punct === 'bare') msgs = msgs.map((m) => m.replace(/。+(?=(\[[^\[\]\s]{1,6}\])?$)/, ''));
    return { messages: msgs.filter(Boolean), voice: said };
}

module.exports = { card, text, pick, shape, ageBand };
