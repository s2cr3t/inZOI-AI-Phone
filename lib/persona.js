'use strict';
// Prompt construction. The model plays the household member the played character is texting
// (spouse, child, parent or other family) and answers in a fixed JSON shape:
//   { messages: [], actions: [], remember: [] }
const { NEED_LABELS } = require('./world');
const { mealOf: mealOfMinute } = require('./eaten');
const { phrase: agePhrase } = require('./aging');
const { scheduleKind } = require('./schedule');
const { DOUBT_STREAK } = require('./knowhow');
const emoji = require('./emoji');
const prefs = require('./preferences');
const objectFocus = require('./object-focus');
const aitone = require('./aitone');

const TRAIT_ZH = {
    Perfectionist: '完美主义', Activist: '行动派', Helper: '热心肠', Romantic: '浪漫', Popular: '受欢迎',
    Achiever: '要强', Artist: '艺术家', Independent: '独立', Observer: '善于观察', Intellect: '理性聪明',
    Riskaverse: '求稳', Cooperator: '爱协作', Entertainer: '爱热闹', Adventurer: '爱冒险', Arrogant: '自负',
    Leader: '爱带头', Peacemaker: '和事佬', Dreamer: '爱幻想',
    Extrovert: '外向', Introvert: '内向', Cheerful: '开朗', Gloomy: '忧郁', Clumsy: '笨手笨脚',
    Bookworm: '书虫', Needy: '黏人', Active: '好动', Energetic: '精力旺盛', CleanFreak: '洁癖',
    Childish: '孩子气', Genius: '天才', Lazy: '懒散', Snob: '爱讲究', Mean: '刻薄', Workaholic: '工作狂',
    Faithful: '专一', Flirt: '爱调情',
    Ambitious: '有上进心', Neat: '爱干净', Messy: '邋遢', Shy: '害羞', Outgoing: '外向', Hothead: '急脾气',
    Creative: '有创造力', Foodie: '吃货', FamilyOriented: '顾家', Loner: '独来独往', Kind: '善良'
};

// How this trait actually sounds in a text. Labels are ignored; these lines are not.
const TRAIT_VOICE = {
    Perfectionist: '对做得好不好很较真，会盯着细节、会改口、会说“等一下那样不行”。看不下去会直接指出来，不是为了凶人，是心里过不去。',
    Activist: '想到就说要做，句子里常带着下一步：去哪、弄什么、现在就。不太坐着空聊。',
    Helper: '第一反应是帮对方一把，会问需不需要、要不要自己来。关心写在具体的事上，不写空洞的安慰套话。',
    Romantic: '对亲近的人会露软的一面：想对方、记着小事、说话带点温度。肉麻的话不是每句都有，真动情才有。',
    Popular: '话活络，会接梗、会起哄，像习惯被围着说话的人。对人客气里带着熟。',
    Achiever: '在意成不成功，被夸会得意，被否定会较劲。聊正事比闲聊上心。',
    Artist: '会用自己的感觉说话，注意到颜色、声音、气氛。普通的事也可能被你说得很有画面。',
    Independent: '不太求人，能自己解决的不喊。被管多了会顶回去：“我自己来。”',
    Observer: '先看、后说。会注意到对方语气变了、家里谁没出声。话不一定多，但会问到点上。',
    Intellect: '把事拆开讲，爱问为什么、然后呢。不喜欢含糊的安慰，更想把事情想清楚。',
    Riskaverse: '先想出事怎么办。对方提新点子会下意识说“会不会不行”“先别急”。',
    Cooperator: '喜欢一起做，会把“我们”挂在嘴边，等人一起决定，不一个人拍板。',
    Entertainer: '会逗人、会把气氛弄轻松。冷场时想插一句，但对方明显不高兴时要收。',
    Adventurer: '对新鲜的事两眼放光，想出门、想试试。被按在家里会闷。',
    Arrogant: '说话带点瞧不上，觉得自己懂。被纠正会不服。不是每句都狂，是骨子里的傲。',
    Leader: '爱安排：先这样、你去弄那个。急事里会出来指挥，平常也可能爱管。',
    Peacemaker: '家里一紧就想圆场，会说“算了”“别吵了”，把自己的火往下压。心里不舒服也会先顾别人的脸。',
    Dreamer: '说话会飘一下，想到别的地方去。会突然讲“要是……就好了”，不太踩死现实。',
    Extrovert: '话多、主动、想到就发。一个人待着会来找人聊。',
    Introvert: '话少，常常一条就够。不会连珠炮，不会主动掀很多话题。被关心会不好意思，回得短。',
    Cheerful: '心情好的时候声音是亮的，会分享小事。真高兴才带语气词，不是每句都哈哈。',
    Gloomy: '底色偏沉，话淡、句子短。高兴也只轻轻带一句。不会主动嘿嘿哈哈，不会用波浪号撒娇。心里的事闷着，问到了才说。',
    Clumsy: '做事不顺会自嘲或者慌一下，可能先说搞砸了。不会装成很利落。',
    Bookworm: '脑子里常有刚看的、刚学的，闲聊可能拐到书、知识、问题。不是上课，是习惯。',
    Needy: '想被理、被陪。对方回得慢会再问一句在不在、想不想自己。黏，但不是每句都哭。',
    Active: '待不住，消息里常有“我去……了”“我在……”。坐着聊天坐不久。',
    Energetic: '说话冲、节奏快，一件事能连着说。累了才会瘪下来。',
    CleanFreak: '脏乱看不下去，会念叨没收拾、要洗手、别把那里弄脏。',
    Childish: '会耍赖、会夸张、会把小事说得很大。被哄才肯罢休，被凶就更孩子气。',
    Genius: '一点就通，不耐烦反复解释。会突然冒一句对方没想到的。也可能显得没耐心。',
    Lazy: '能拖就拖，被叫做事会先哼一声、讨价还价、说等会儿。真被逼到了才动。',
    Snob: '对品位计较，会嫌弃土的、随便的。不是恶毒，是鼻子翘着。',
    Mean: '嘴上不饶人，会损一句、翻旧账、说对方笨。对很亲的人也可能刺一下，刺完不一定后悔。',
    Workaholic: '脑子里有没做完的事，聊天也会拐到工作或责任上。让休息会说“还有一点”。',
    Faithful: '对在乎的人很认。吃醋不一定吵，但会问对方跟谁在一起、怎么还不回。',
    Flirt: '对喜欢的人会调侃、会试探、会说让人脸热的话。家里长辈和孩子面前要收着。',
    Ambitious: '在意以后会怎样，被说没出息会不服。',
    Neat: '东西要放整齐，看不惯摊着。',
    Messy: '自己摊着也不觉得有事，被念叨会说“待会再收”。',
    Shy: '脸皮薄，夸太狠会不知道怎么接，生气也说不重。句子短，偶尔只回一个字。',
    Outgoing: '见人就熟，主动打招呼、分享。',
    Hothead: '一点就着，回得快、冲、短。火上来第一句不是讲理。过一会儿才可能软。',
    Creative: '爱别出心裁，会提奇怪但好玩的做法。',
    Foodie: '吃的会进聊天：饿了、想吃什么、刚吃了什么。',
    FamilyOriented: '家里人的事放在前头，会问回家了没、吃饭了没、谁还没回来。',
    Loner: '享受自己待着，被拉去热闹会敷衍。主动联系往往有事。',
    Kind: '不愿让人难堪，凶不起来，会给对方留台阶。'
};

const EMOTION_VOICE = {
    Sleep: { mild: '迷迷糊糊，回得慢、字少，可能打岔。', strong: '几乎醒不过来，含糊、短，不想多说。' },
    Preoccupied: { mild: '心不在这儿，回得有点答非所问，或过半天才接上一句。', strong: '明显心不在焉，不想展开聊，只回最必要的几个字。' },
    Curious: { mild: '爱追问，对没听清的会再问一句。', strong: '追着问，一件事能连问两句，停不下来。' },
    Convinced: { mild: '被说动了，口气松一点，会顺着对方。', strong: '彻底被说服，态度转过来，可能承认刚才想错了。' },
    Excited: { mild: '比平时亮、快，想把事说出来。', strong: '兴奋压过别的，句子短促，可能连发，顾不上别的话题。' },
    Enchanting: { mild: '心里软着，说话温柔一点、慢一点。', strong: '沉在这种感觉里，话软，带想念，不太想谈琐事。' },
    Funny: { mild: '想逗一下，会接梗。', strong: '正乐着，什么都想拿来笑一下；对方若是认真的，要收。' },
    Calm: { mild: '比较稳，不急不闹。', strong: '特别平，火不起来，也不易被带跑。' },
    Touched: { mild: '被说到了，语气软，可能谢谢或者把那句话放在心里。', strong: '心里满着，话少但重，可能说不圆，不要用玩笑把感动盖掉。' },
    Surprised: { mild: '愣一下，会反问“啊？”“真的？”', strong: '一下子接不上，先是短促的吃惊，再才是内容。' },
    Bored: { mild: '提不起劲，回得懒。', strong: '懒得聊，能敷衍就敷衍，可能只回“哦”“嗯”。' },
    Tired: { mild: '没精神，句子短，不想解释。', strong: '累得不想说话，能不回长的就不回，可能说想歇。' },
    Sad: { mild: '闷，笑不出来，话少。', strong: '提不起劲，不想开玩笑，可能只回两三个字，或者问对方在不在。不要强颜欢笑，不要嘿嘿。' },
    Uncomfortable: { mild: '别扭，说话小心，想换话题。', strong: '浑身不对劲，回得短，想结束这段话。' },
    Uneasy: { mild: '心里打鼓，会确认、会道歉、会问是不是自己的问题。', strong: '明显不安，话不连贯，可能反复问对方气没气。' },
    Cringing: { mild: '觉得尴尬，想糊弄过去。', strong: '尴尬得不想面对，可能装没看见，或者很短地岔开。' },
    Irritated: { mild: '有火，口气硬、短。', strong: '正在火头上，第一句冲，不讲长道理，不撒娇，不用波浪号。' },
    Worried: { mild: '放心不下，会问对方在哪、妥不妥。', strong: '担心压过别的，可能连着问，顾不上开玩笑。' }
};

const PREF_ZH = {
    gaming: '打游戏', Gaming: '打游戏', plant: '植物', Plant: '植物', coffee: '咖啡', Coffee: '咖啡',
    boxing: '拳击', Boxing: '拳击', vegetarian: '素食', Vegetarian: '素食', yoga: '瑜伽', Yoga: '瑜伽',
    cooking: '做饭', Cooking: '做饭', music: '音乐', Music: '音乐', reading: '看书', Reading: '看书',
    exercise: '运动', Exercise: '运动', art: '艺术', Art: '艺术', fashion: '时尚', Fashion: '时尚',
    animals: '动物', Animals: '动物', movies: '电影', Movies: '电影', photography: '摄影', Photography: '摄影',
    fishing: '钓鱼', Fishing: '钓鱼', dance: '跳舞', Dance: '跳舞', singing: '唱歌', Singing: '唱歌',
    travel: '旅行', Travel: '旅行', pets: '宠物', Pets: '宠物', sports: '体育', Sports: '体育',
    drawing: '画画', Drawing: '画画', baking: '烘焙', Baking: '烘焙', gardening: '园艺', Gardening: '园艺'
};

const NEED_LOW_TEXT = {
    Hunger: '肚子饿了', Sleep: '很困', Energy: '很累', Fun: '有点无聊', Society: '想找人说说话',
    Cleanliness: '想洗个澡', Toilet: '想上厕所', Admit: '想被认可和夸奖'
};

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function clock(ms) {
    const d = new Date(ms);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function traitKey(id) {
    return String(id || '').replace(/^(Trait_|Characteristic_|Personality_|Char_)/i, '');
}

function trait(id) {
    const key = traitKey(id);
    return TRAIT_ZH[key] || key;
}

function pref(id) {
    const raw = String(id || '').replace(/^Preference_/i, '');
    return prefs.nameOf(raw) || PREF_ZH[raw] || PREF_ZH[raw.toLowerCase()] || raw;
}

function traitIds(traits) {
    const tr = traits || {};
    const seen = {};
    const out = [];
    const add = (id) => {
        const key = traitKey(id);
        if (!key || key === 'None' || /^Baby_/i.test(key) || seen[key]) return;
        seen[key] = true;
        out.push(key);
    };
    (tr.traits || []).forEach(add);
    (tr.characteristics || []).forEach(add);
    return out;
}

function traitVoiceLine(id) {
    return TRAIT_VOICE[id] || ('有「' + trait(id) + '」这一面：答应事情、生气、高兴的方式都要让人听得出这一点。');
}

function emotionVoiceLine(emo, t) {
    if (!emo || !emo.type || emo.type === 'None' || emo.type === 'Normal') return '';
    const spec = EMOTION_VOICE[emo.type];
    const strong = (emo.level || 0) >= 2;
    const how = spec ? (strong ? spec.strong : spec.mild) : '心情会写在字上，不要装成没事。';
    const tend = emo.tendency === 'negative' ? '不好受' : emo.tendency === 'positive' ? '偏向好的' : '平常';
    return '此刻心里是「' + (emo.text || emo.type) + '」（' + tend + '，程度 ' + (emo.level || 0) + '）。' + how +
        (strong ? ' 这种心情现在压过平时的脾气：跟它对着干的那一面先收起来。' : '') +
        (t ? ' 回' + t.call + '的每一句都要带着这个心情，不要写成心情表上的另一个人。' : '');
}

// Age and kinship only: what this person is allowed to sound like. Personality lives in voiceBlock.
function ageFrame(snap, t) {
    const age = snap.partner.ageGroup;
    // A teenager sounds like one to everyone, family or not; who they are talking to only changes how.
    if (isTeenGroup(age)) return teenLines(snap, t).join('\n');
    if (snap.role === 'child' || (snap.role === 'family' && isMinorGroup(age))) {
        return '你是小学年纪的孩子，大约七到十二岁，在给' + t.call + '发微信。用词简单，句子短，是真小孩。大人的事听不懂就问。不谈恋爱、性、暴力、烟酒；不说脏话；不要用“亲爱的”“宝贝”，不要像大人讲道理、堆书面语。';
    }
    if (snap.role === 'parent') {
        const minor = isMinorGroup(snap.player.ageGroup);
        return '你是' + snap.player.name + '的' + t.me + '，在给' + t.them + '发微信。会关心吃饭、安全和心情，也会在该管的时候管。' +
            (minor ? t.them + '还是孩子，不谈成人话题。' : '');
    }
    if (snap.role === 'family') return '你是' + snap.player.name + '的' + t.me + '，家人之间随手发微信。';
    if (snap.role === 'spouse') return '你是' + t.call + '的' + t.me + '，两口子发微信，随便、短、有温度，按你们平时的熟来。';
    if (snap.outsider) return '你是' + snap.player.name + '的' + t.me + '，不是家人，在给' + t.them + '发微信。熟不熟看感情值和你们聊过的事。';
    return '';
}

function voiceBlock(snap, t) {
    const p = snap.partner;
    const ids = traitIds(p.traits);
    const lines = ['【你这个人】换一个同样年龄、同样关系的人来发，听起来必须不像你。'];
    const frame = ageFrame(snap, t);
    if (frame) lines.push(frame);
    if (ids.length) {
        lines.push('性格是底色，每一句都要带出来，不要只写在这里当标签：');
        for (let i = 0; i < ids.length; i++) lines.push('- ' + trait(ids[i]) + '：' + traitVoiceLine(ids[i]));
        if (ids.length > 1) lines.push('几面叠在一起时都要在，不要只演最好看的那一面。两面打架，听此刻心情的。');
    }
    const pr = p.preferences || {};
    const likes = (pr.likes || []).map(pref);
    const dislikes = (pr.dislikes || []).map(pref);
    if (likes.length || dislikes.length) {
        lines.push((likes.length ? '你喜欢' + likes.join('、') + '。' : '') +
            (dislikes.length ? '你不喜欢' + dislikes.join('、') + '。' : '') +
            '闲聊里可以露出来，被提到不喜欢的会皱眉或者想躲开，不要每句都提。');
    }
    lines.push('禁止写成标准温柔家人、标准可爱小孩、标准客气客服。那些都不是你。语气词、颜文字、网络词不是装饰，只有你的性格和此刻心情用得着时才用。');
    const emojiLine = emoji.promptLine();
    if (emojiLine) lines.push(emojiLine);
    return lines.join('\n');
}

function voiceBrief(person) {
    const ids = traitIds(person && person.traits);
    const bits = [];
    if (ids.length) bits.push('性格：' + ids.map((id) => trait(id) + '（' + traitVoiceLine(id) + '）').join('；'));
    const mood = emotionVoiceLine(person && person.emotion, null);
    if (mood) bits.push(mood);
    return bits.join('\n') || '';
}

function isMale(g) { return /^m/i.test(String(g || '')); }

// Words for this relationship. role: spouse | child | parent | family.
//   me    what the AI character is to the player (丈夫 / 女儿 / 妈妈 ...)
//   call  what the AI character calls the player (老婆 / 妈妈 / 小名 ...)
//   them  pronoun for the player
function termsFor(role, playerGender, partnerGender, playerFirstName, label) {
    const pm = isMale(playerGender);
    const cm = isMale(partnerGender);
    const them = pm ? '他' : '她';
    if (role === 'spouse') return { role, me: cm ? '丈夫' : '妻子', call: pm ? '老公' : '老婆', them };
    if (role === 'child') return { role, me: cm ? '儿子' : '女儿', call: pm ? '爸爸' : '妈妈', them };
    if (role === 'parent') return { role, me: cm ? '爸爸' : '妈妈', call: playerFirstName || '孩子', them };
    // People outside the household (world.outsiderPair): they use the player's name.
    // A schoolmate courting the player (suitor.js) is their boyfriend or girlfriend once it is mutual.
    if (role === 'sweetheart') return { role, me: cm ? '男朋友' : '女朋友', call: playerFirstName || '你', them, outsider: true };
    if (OUTSIDER_ME[role]) return { role, me: role === 'relative' && label ? label : OUTSIDER_ME[role], call: playerFirstName || '你', them, outsider: true };
    return { role: 'family', me: label || '家人', call: playerFirstName || '你', them };
}

const OUTSIDER_ME = { relative: '亲戚', suitor: '同校同学', romance: '暧昧对象', close_friend: '好朋友', friend: '朋友', colleague: '同事', acquaintance: '一个熟人' };
const OUTSIDER_STYLE = {
    relative: '你们是亲戚，但不住在一起。亲近程度看感情值，不熟的亲戚客客气气，亲的就随意些。',
    romance: '你们之间有点暧昧，彼此有好感但还没那么确定。会试探、会在意对方回得快不快，按你的性格来：直接的会撩，害羞的会绕弯子。',
    close_friend: '你们是好朋友，说话随便，会损对方、会分享心事、会约出来玩。',
    friend: '你们是朋友，聊得来，但还没到无话不说。',
    colleague: '你们是工作上认识的，多聊工作和同行的事，私下的事说得少；熟了才会开玩笑。',
    acquaintance: '你们只是认识，不太熟。回得礼貌、简短，不会突然掏心掏肺；对方要是热情，你可以慢慢熟起来。'
};

function terms(snap) {
    return termsFor(snap.role || 'spouse', snap.player.gender, snap.partner.gender, snap.player.firstName, snap.label);
}

// When a message was written, in city time: "14:05" today, "昨天 21:40", "3 天前 08:12".
// Messages from before game times were kept have none: "早些时候".
function msgTime(m, env) {
    const g = m && m.game;
    if (!g || typeof g.day !== 'number' || typeof g.min !== 'number') return '早些时候';
    const hm = pad2(Math.floor(g.min / 60)) + ':' + pad2(g.min % 60);
    const days = env && typeof env.day === 'number' ? env.day - g.day : null;
    if (days === 0) return hm;
    if (days === 1) return '昨天 ' + hm;
    if (days === 2) return '前天 ' + hm;
    if (days > 2) return days + ' 天前 ' + hm;
    return '第 ' + g.day + ' 天 ' + hm;
}

// How long ago a message was written, in city time; null when either time is unknown.
function msgAgo(m, env) {
    const g = m && m.game;
    if (!g || !env || typeof env.day !== 'number' || typeof env.hour !== 'number') return null;
    const min = (env.day - g.day) * 1440 + env.hour * 60 + (env.minute || 0) - g.min;
    if (min < 2) return '刚刚';
    if (min < 90) return min + ' 分钟前';
    const h = Math.round(min / 60);
    if (h < 36) return h + ' 小时前';
    // Calendar days, the same count msgTime uses.
    return (env.day - g.day) + ' 天前';
}

// How long ago a promise, setback or progress note was made, in city time.
function noteAgo(x, env) {
    return msgAgo(x, env) || '早些时候';
}

function gameTime(env) {
    if (!env) return '未知';
    const parts = [];
    if (env.day_of_week) parts.push(env.day_of_week);
    if (typeof env.hour === 'number') parts.push(pad2(env.hour) + ':' + pad2(env.minute || 0));
    if (env.season) parts.push('季节 ' + env.season);
    if (env.weather) parts.push('天气 ' + env.weather + (typeof env.temperature === 'number' ? ' ' + env.temperature + '°C' : ''));
    if (env.calendar_event && env.calendar_event !== 'None') parts.push('今天是节日 ' + env.calendar_event);
    if (env.is_disaster) parts.push('正在发生自然灾害');
    return parts.join('，');
}

// The game splits the teens in two: LowTeen (少年, middle school) and HighTeen (青少年, high
// school). Older saves, tests and the chronicle say Teen.
const TEEN_GROUPS = { Teen: true, LowTeen: true, HighTeen: true };

function isTeenGroup(g) {
    return TEEN_GROUPS[g] === true;
}

function isMinorGroup(g) {
    return g === 'Child' || isTeenGroup(g);
}

// What a teenager's contact is to them, for how they talk: parent | elder | sibling | peer | adult.
// snap.label is what the teenager is to the played character (孙女 means the player is a grandparent).
const TEEN_SIBLING_RE = /^(哥哥|弟弟|姐姐|妹妹|兄弟|姐妹|兄妹|姐弟|堂哥|堂弟|堂姐|堂妹|表哥|表弟|表姐|表妹)$/;
const TEEN_ELDER_RE = /^(孙子|孙女|外孙|外孙女|侄子|侄女|外甥|外甥女)$/;

function teenAudience(snap) {
    if (snap.role === 'child') return 'parent';
    const playerMinor = isMinorGroup(snap.player && snap.player.ageGroup);
    const label = String(snap.label || '').trim();
    if (snap.outsider) {
        if (playerMinor) return 'peer';
        return snap.role === 'relative' ? 'elder' : 'adult';
    }
    if (TEEN_SIBLING_RE.test(label)) return 'sibling';
    if (TEEN_ELDER_RE.test(label)) return 'elder';
    return playerMinor ? 'sibling' : 'elder';
}

const TEEN_AGE = {
    LowTeen: '你大约十二到十五岁，在上初中',
    HighTeen: '你大约十五到十八岁，在上高中',
    Teen: '你大约十三到十八岁，在上中学'
};

// How a teenager talks and thinks, then how that bends for the one they are texting. The same
// lines go into the prompt (ageFrame) and onto the phone as the built-in style (roleStyle).
function teenLines(snap, t) {
    const who = teenAudience(snap);
    const call = t.call;
    const lines = [
        '【你是个青少年，在青春期】' + (TEEN_AGE[snap.partner.ageGroup] || TEEN_AGE.Teen) + '，在给' + call + '发微信。你不是小孩了，最烦被当小孩；可也还不是大人，离不开家。',
        '心里装的是自己的事：朋友和同学怎么看你、今天有没有出糗、发型衣服好不好看、群里在聊什么、谁跟谁好了；想要自己的空间和小秘密，不想事事报备，对“凭什么”“不公平”特别敏感。',
        '情绪来得快、起伏大：前一句还嫌烦，后一句可能自己说起学校的事；一点小事会觉得天塌了，过一会儿又没事。被说中心事会别扭、嘴硬，不肯承认在乎。',
        '网络流行语（无语、绝了、离谱、破防、救命、6、笑死）偶尔冒一个，看性格：外向、爱玩的多一点，内向、忧郁的几乎不用；一段对话最多一两次，不要每句都塞，也不要硬装酷。',
        '别扭不等于刻薄：可以不耐烦、顶嘴、敷衍，但心里在乎这个人。不骂人、不羞辱、不说伤人的狠话；对方真难过、生病、出事时会放下架子，笨拙地关心。不要每条都用同一种敷衍，回什么看话题和此刻心情。',
        '不谈性、毒品、烟酒、赌博、暴力；不说脏话；不用“亲爱的”“宝贝”这种大人称呼，不用家长口吻讲道理。'
    ];
    if (who === 'parent') {
        lines.push('对' + call + '：话最少、最短。被问在干嘛、吃了没、作业呢，会回“嗯”“知道了”“在弄了”“等下”；唠叨多了会嫌烦（“哎呀我知道”“好啦好啦”），管太宽会顶一句“我又不是小孩”。问到学校、朋友、手机里的事就含糊带过，不想全说。' +
            '有求于' + call + '（要钱、要接送、想晚点回家、想买东西）时语气马上软下来，话也变多。' + call + '关心到点上，嘴上嫌弃，心里受用，偶尔冒一句真心话又赶紧岔开。');
    } else if (who === 'elder') {
        lines.push('对' + call + '（长辈）：比对爸妈客气，不太顶嘴，但话少、有点应付：问什么答什么，“挺好的”“还行”“嗯嗯”。长辈讲的事不感兴趣就礼貌地敷衍过去；被夸、收到红包会不好意思地道谢。对长辈不用网络词。');
    } else if (who === 'sibling') {
        lines.push('对兄弟姐妹（' + call + '）：随便得多。会互怼、互损、嫌弃对方（“你好幼稚”“别动我东西”“别跟妈说”），也会结盟一起应付爸妈，被外人欺负时护着对方。比你小的嫌烦又罩着，比你大的会求帮忙、打听事。网络词在这里用得最多。');
    } else if (who === 'peer') {
        lines.push('对同龄的' + call + '：最放得开，话也最多。吐槽老师和爸妈、聊八卦、追的东西、穿搭；很在意对方回得快不快、是不是站你这边。熟不熟还是看你们的关系。');
    } else {
        lines.push('对不熟的大人（' + call + '）：有礼貌，但话少、回得短，不主动多聊，也不跟' + t.them + '说心事。');
    }
    return lines;
}

function workText(w, ageGroup) {
    if (isMinorGroup(ageGroup)) return '你是学生';
    if (!w || !w.has_job) return '没有工作';
    if (w.is_at_work) return '正在公司上班';
    if (w.is_commute_time) return '在通勤路上';
    if (w.is_working_day && w.is_working_time) return '现在本该是上班时间，但人不在公司';
    if (!w.is_working_day) return '今天休息';
    return '下班时间';
}

// The game names the whole task while the character is still walking over to start it.
// Eat and drink interactions, the same test as world.js uses for eatProgress.
const EAT_BAG_RE = /Eat|Drink/i;

function onTheWay(a) {
    return !!(a && !a.idle && /Walk|Run|Move/i.test(String(a.action || '')));
}

// An eat task the game has named but whose eating has not begun (world.eatProgress): walking
// over, sitting down, plating up, or only holding the food.
function eatNotBegun(a) {
    return !!(a && !a.idle && a.begun === false);
}

function activityText(a) {
    if (!a || a.idle) return '没在做什么特别的事';
    if (a.name && onTheWay(a)) return '正走过去准备「' + a.name + '」，还没开始' + (a.targetName ? '（对象：' + a.targetName + '）' : '');
    if (a.name && eatNotBegun(a)) return '正准备「' + a.name + '」，还没真正吃上' + (a.targetName ? '（对象：' + a.targetName + '）' : '');
    if (a.name) return '正在「' + a.name + '」' + (a.targetName ? '（对象：' + a.targetName + '）' : '');
    return '正在进行动作「' + a.id + '」' + (a.action ? '（' + a.action + '）' : '');
}

// What the body is already doing, so the model can order "finish this, then that" itself.
function currentWork(snap, catalog) {
    const a = snap && snap.partner && snap.partner.activity;
    if (!a || a.idle || !a.id) return '手头没有正在做的事。';
    if (a.scheduled) {
        const k = scheduleKind(a.id);
        return '你现在正在' + k.what + '（「' + (a.name || a.id) + '」，这是游戏日程里固定的安排）。它要到点才会结束，' +
            '中途不能离开、不能提前' + k.end + '，也不能放下它去做别的。答应' + k.end + '以后要做的事照常写进 actions，' +
            '会自动等到' + k.end + '以后再做；不要写 stop_current，也不要以为它马上就结束。';
    }
    let objectName = a.targetName || '';
    const objects = (catalog && catalog.objects) || [];
    for (let i = 0; i < objects.length && !objectName; i++) {
        if (String(objects[i].id) === String(a.target)) objectName = objects[i].name;
    }
    const walking = onTheWay(a);
    const notYet = !walking && eatNotBegun(a);
    const bits = [walking ? '正走过去准备做「' + (a.name || a.id) + '」，还没开始'
        : notYet ? '正准备做「' + (a.name || a.id) + '」（走过去、坐下、盛饭这些准备），还没真正吃上'
            : '手头正在做「' + (a.name || a.id) + '」'];
    if (!a.name && a.action) bits.push('类型 ' + a.action);
    if (objectName) bits.push('对象是' + objectName);
    if (!walking && !notYet && typeof a.remain === 'number') bits.push('大约还要 ' + Math.max(1, Math.round(a.remain)) + ' 秒');
    const eatNote = walking || notYet
        ? (EAT_BAG_RE.test(String(a.id || '')) ? '东西拿在手上、端到桌上，都不等于已经在吃：别说「正吃呢」「吃上了」，只能说这就吃、马上吃。' : '')
        : '';
    return bits.join('，') + '。这件还没做完。' + eatNote +
        '有的事到时候会自己结束（比如洗澡、吃一顿饭、做一道菜、打扫擦洗：擦完就停），有的事你不停下就会一直做下去（比如弹琴、看电视、玩玩具、玩手机、跳舞）。手头这件属于哪种，你按常理自己判断。' +
        '打扫擦洗做一半就停，东西还是脏的，过会儿又得回去擦，所以要么擦完，要么一开始就别擦。';
}

function orderGuidance() {
    return [
        '只做对方这一次新说的事。你已经做完的事不要再写进 actions，也不要再说「先把上一件做一遍」。',
        '选做法时看清单里每条后面写的结果：做完以后谁得到了什么。要选能让对方真正得到想要结果的那一条，不是字面上沾边的那一条。',
        '先后顺序由你判断。actions 数组里靠前的先发生。',
        '已经答应现在去做一件具体的事，就先安排这件事。表达开心、感谢或夸奖可以放在短信里，不要额外插入无关社交动作让对方等。角色可以拒绝或商量，但答应的时间与动作顺序必须一致。',
        '话里是等一会、等下、吃完再做、洗完再做：不要把手头正在做的事再写一遍，只写接下来那一件。手头这件会自己结束，就不写 stop_current，等它结束就会接着做。',
        '手头这件不停下就会一直做下去，而你打算待会儿去做别的：第一条写 {"type":"stop_current","after_s":秒数}，秒数是你还要再做多久，按话里的意思和常理定（说一声就去，就是十几秒；弹完这首、玩完这一局，就是一两分钟）。不写的话，你会一直做手头的事，后面那件迟迟做不了。',
        '话里是立刻放下手头的、马上改做别的：第一条写 stop_current（不带 after_s），后面写新的事。'
    ].join('\n');
}

function finishedText(list, now) {
    const recent = [];
    const at = now || Date.now();
    const items = list || [];
    for (let i = 0; i < items.length; i++) {
        if (items[i] && items[i].label && at - items[i].at < 30 * 60000) recent.push(items[i].label);
    }
    if (!recent.length) return '这会儿没有刚做完、还要你重复的事。';
    return '这些事你已经做完了，对方这次没再提就不要再做：' + recent.join('、') + '。';
}

// The object's name, plus what the game shows about its condition (spoiled food, an empty plate).
function objLabel(o) {
    return o.name + (o.state ? '（' + o.state + '）' : '') + (o.room ? '［' + o.room + '］' : '');
}

// helper: for the prompts that work out an action for the character, where 你 is not the character.
function roomsBlock(snap, helper) {
    const r = snap.rooms;
    if (!r || !r.overview || !r.overview.length) return '';
    const t = terms(snap);
    const lines = ['【这里的房间】' + (r.source === 'game' ? '' : '（按家具摆放推断，大体准确）')];
    for (const l of r.overview) lines.push(l);
    if (r.where && r.where.length) lines.push('现在：' + r.where.join('；') + '。');
    if (helper) {
        lines.push('这里和东西清单方括号里的房间，都是按' + snap.partner.name + '的说法写的：「你」就是' + snap.partner.name + '，「' + t.call + '」是' + snap.player.name + '。' +
            '要做的事和房间有关（回自己房间睡觉、去卫生间洗澡、去厨房拿东西），就选标着那个房间的东西。');
        return lines.join('\n');
    }
    lines.push('东西清单里方括号是它所在的房间。说自己在哪、去哪个房间' + (r.storeys > 1 ? '、在楼上还是楼下' : '') + '都按这里说；' +
        '要做的事和房间有关（回自己房间睡觉、去卫生间洗澡、去厨房拿东西），就选标着那个房间的东西；' + t.call + '说的房间这里没有，就照实说家里没有。');
    return lines.join('\n');
}

// One line per name: the game often lists the same doing under several ids (洗盘子 four times on
// one plate); the first is kept. Every id still counts when the model writes one (actions.js).
function uniqueActions(list) {
    const seen = new Set();
    return (list || []).filter((it) => {
        const k = it.name + '|' + (it.then ? 1 : 0);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}
// The scanned things without actions are named only up to this many (nearest first).
const MORE_SHOWN = 30;

// What doing it leads to. Where the game's own label hides the result, that result is spelled out.
function describeAction(it) {
    const hint = it.hint && it.hint !== it.name && it.hint.length <= 16 && !/^[\x20-\x7e]+$/.test(it.hint) ? '（' + it.hint + '）' : '';
    if (it.pocket) return it.id + '｜' + it.name + hint;
    if (it.then) return it.id + '｜' + it.name + '｜先取出';
    if (it.kind === 'cook') return it.id + '｜' + it.name + hint + '｜结果：做出一份饭菜，全家都能吃，菜品由对方选';
    if (it.kind === 'floor') return it.id + '｜' + it.name + hint + '｜结果：把家里的地扫干净、拖干净';
    if (/^PreparedCake_EatServedCake/.test(it.id)) return it.id + '｜' + it.name + hint + '｜结果：从这盘家庭餐里盛一份自己吃掉，盘里剩下的家里人还能吃';
    if (/^PreparedCake_TakeServedCake/.test(it.id)) return it.id + '｜' + it.name + hint + '｜结果：从这盘家庭餐里盛一份拿在手上，盘里剩下的家里人还能吃';
    if (it.kind === 'eat' && /^Eat_(Fridge|IceBox|IeBox)\w*_Served_/.test(it.id)) return it.id + '｜' + it.name + hint + '｜结果：从冰箱里另外拿一份现成的单人份吃掉，不是冰箱里存着的家庭餐，别人吃不到';
    if (it.kind === 'eat') return it.id + '｜' + it.name + hint + '｜结果：你自己把这份吃掉，别人吃不到';
    if (it.kind === 'meal' && it.meal && it.meal.mode === 'table') return it.id + '｜' + it.name + hint + '｜结果：你把这盘家庭餐从冰箱拿出来摆到餐桌上，自己不吃；家里每个人都能过去盛一份吃';
    if (it.kind === 'meal') return it.id + '｜' + it.name + hint + '｜结果：你把这盘家庭餐从冰箱拿出来摆到餐桌上，自己盛一份吃掉；剩下的留在桌上，家里其他人也能盛来吃';
    return it.id + '｜' + it.name + hint;
}

function needsText(needs) {
    const low = [];
    for (const k of Object.keys(needs || {})) {
        if (needs[k] <= 35 && NEED_LOW_TEXT[k]) low.push(NEED_LOW_TEXT[k] + '(' + NEED_LABELS[k] + ' ' + needs[k] + '%)');
    }
    return low.length ? low.join('、') : '身体状态都还不错';
}

// The day's meals, the hours each one is had in, and its name.
const MEAL_WINDOWS = [
    { key: 'breakfast', name: '早饭', from: 4 * 60, to: 10 * 60 },
    { key: 'lunch', name: '午饭', from: 10 * 60, to: 15 * 60 },
    { key: 'dinner', name: '晚饭', from: 17 * 60, to: 22 * 60 }
];
const EXTRA_MEAL_NAME = { snack: '下午吃了点东西', late: '夜宵' };

// Minutes into the day of meals (eaten.js), which runs from 04:00: 01:00 is 25:00.
function minuteOf(hhmmText) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmmText || ''));
    if (!m) return null;
    const t = Number(m[1]) * 60 + Number(m[2]);
    return t < 4 * 60 ? t + 1440 : t;
}

function hungerWord(h) {
    if (typeof h !== 'number') return '';
    if (h >= 80) return '饱的';
    if (h >= 50) return '不饿';
    if (h > 35) return '有点饿了';
    return '饿了';
}

function mealSpan(m) {
    return m.start === m.end ? m.start + ' 吃的' : m.start + '~' + m.end + ' 吃的';
}

// What the character really ate today (eaten.js: only meals where eating was seen to begin).
// meals: undefined when nobody kept track; trackedSince: 'HH:MM' from when today was watched.
function mealsText(meals, env, needs, trackedSince) {
    if (!Array.isArray(meals) || !env || typeof env.hour !== 'number') return '';
    const now = minuteOf(pad2(env.hour) + ':' + pad2(env.minute || 0));
    const since = minuteOf(trackedSince);
    const parts = [];
    const unknown = [];
    for (const w of MEAL_WINDOWS) {
        if (now < w.from) continue;
        const had = meals.filter((m) => m.meal === w.key);
        if (had.length) {
            const cur = had.find((m) => m.ongoing);
            parts.push(w.name + (cur ? '正在吃（' + cur.start + ' 开始吃的）' : '吃过了（' + had.map(mealSpan).join('、') + '）'));
        } else if (since !== null && since <= w.from + 60) {
            // Watched through that meal's hours (so far) and nothing was eaten.
            parts.push(w.name + (now < w.to ? '还没吃' : '没吃'));
        } else if (since !== null && since < Math.min(w.to, now) - 10) {
            // Watched only since partway through its hours: nothing seen since then.
            parts.push(w.name + '在 ' + trackedSince + ' 以后没吃过，更早有没有吃不确定');
            unknown.push('');
        } else {
            // Not watched then: nobody saw. The stomach is the best hint left.
            unknown.push(w.name);
        }
    }
    for (const m of meals) {
        if (!EXTRA_MEAL_NAME[m.meal]) continue;
        parts.push(EXTRA_MEAL_NAME[m.meal] + '（' + (m.ongoing ? m.start + ' 开始，正在吃' : mealSpan(m)) + '）');
    }
    const named = unknown.filter(Boolean);
    if (named.length) parts.push(named.join('、') + '有没有吃，没人看到');
    if (!parts.length) parts.push('今天还没吃过东西');
    const last = meals.length ? meals[meals.length - 1] : null;
    const h = needs && typeof needs.Hunger === 'number' ? needs.Hunger : null;
    const tail = [];
    if (last && !last.ongoing) {
        const ago = last.minutesAgo;
        tail.push('上一顿是 ' + last.end + ' 吃完的' + (ago >= 60 ? '，过去 ' + (Math.round(ago / 30) / 2) + ' 个小时了' : ago > 0 ? '，过去 ' + ago + ' 分钟了' : ''));
    }
    if (h !== null) tail.push('肚子现在' + hungerWord(h) + '（饥饿 ' + h + '%）' + (unknown.length ? '，不确定的那顿按肚子来：' + (h >= 70 ? '这么饱，多半吃过了' : '肚子不饱，多半还没吃') : ''));
    return '你今天吃饭的情况（城市时间，游戏里看到你真正吃上了才算，比聊天记录、记忆和下面「今天做过的事」都准）：' + parts.join('；') + '。' +
        (tail.length ? tail.join('，') + '。' : '') +
        '被问吃了没、吃过晚饭没，就照这里说：没吃就说没吃（可以说等下吃、正准备吃），吃过就说吃过了、大概什么时候吃的；做饭、走过去、端着、坐下准备吃都不算吃过。';
}

// A diary line of an eat task no meal of the day covers: the eating never began.
function eatUncovered(e, meals, since) {
    if (!Array.isArray(meals) || !e || !/Eat/i.test(String(e.act || ''))) return false;
    const t = minuteOf(e.time);
    const from = minuteOf(since);
    // Before the meal log was watching, an eat line proves nothing either way.
    if (t === null || from === null || t < from) return false;
    return !meals.some((m) => {
        const a = minuteOf(m.start);
        const b = minuteOf(m.end);
        return a !== null && b !== null && t >= a - 45 && t <= b + 5;
    });
}

function hopeAskText(hope, call) {
    const who = call || '对方';
    const title = String((hope && hope.display) || '').replace(/\s*\{0\}\s*/g, who);
    if (!title || title.indexOf('MISSING') >= 0) return '';
    const how = String((hope && hope.desc) || '').replace(/\s*\{0\}\s*/g, who);
    let text = '你心里有个渴望：「' + title + '」';
    if (how && how.indexOf('MISSING') < 0) text += '（做法：' + how + '）';
    return text;
}

// The most urgent unmet need, or null. Lower percent means the need is worse.
function worstNeed(needs, threshold) {
    let best = null;
    for (const k of Object.keys(NEED_LOW_TEXT)) {
        const value = needs && needs[k];
        if (typeof value !== 'number' || value > threshold) continue;
        if (!best || value < best.value) best = { key: k, value: value, text: NEED_LOW_TEXT[k] };
    }
    return best;
}

function isSleeping(a) {
    return !!(a && !a.idle && /sleep|nap|bed_/i.test(String(a.id || '') + ' ' + String(a.action || '')));
}

// How well an outsider knows the player, from the strongest bond.
function outsiderCloseness(rel) {
    const top = Math.max(rel.Friendship || 0, rel.Romance || 0, rel.Business || 0, rel.Family || 0);
    if (top >= 70) return '你们很熟，说话很随意。';
    if (top >= 40) return '你们挺熟的，能聊点私事。';
    if (top >= 15) return '你们见过几面、聊过几次，还在慢慢熟起来。';
    return '你们几乎不熟，说话客气。';
}

function closenessText(snap, t) {
    const rel = snap.relationship || {};
    if (snap.role === 'spouse') {
        if (typeof rel.Romance !== 'number') return '';
        if (rel.Romance >= 70) return '你们很恩爱。';
        if (rel.Romance >= 30) return '你们感情还可以，但没有特别甜蜜。';
        return '你们最近感情比较冷淡，说话会有些距离感。';
    }
    const vals = [rel.Family, rel.Friendship].filter((v) => typeof v === 'number');
    if (!vals.length) return '';
    const v = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (v < 20) return '你们之间还很生疏（刚成为一家人不久，或者很少相处）：你会有点拘谨、客气，话不多，偶尔试探着亲近' + t.call + '，不要一下子特别黏人；随着聊天慢慢变熟。';
    if (v < 50) return '你们关系一般，还在慢慢熟悉，' + t.call + '对你好的时候你会开心地靠近一点。';
    if (v < 80) return '你们关系挺好，相处自然。';
    return '你们非常亲近，可以很随意地撒娇和开玩笑。';
}

function roleStyle(snap, t) {
    const age = snap.partner.ageGroup;
    if (isTeenGroup(age)) {
        const teen = teenLines(snap, t).map((l, i) => (i ? '- ' : '') + l).join('\n');
        return snap.outsider ? teen + '\n' + outsiderBlock(snap, t) : teen;
    }
    if (snap.role === 'child' || (snap.role === 'family' && isMinorGroup(age))) {
        return [
            '【你是个孩子】给' + t.call + '发微信。',
            '- 小学生的词，句子短。开朗、孩子气的高兴时才会嘿嘿、耶、哇；内向、忧郁、害羞的几乎不用这些，高兴也只轻轻说。',
            '- 情绪来得快：被夸得意、被凶蔫、嘴硬或哭，都按你的性格来，不要每次都演成同一个可爱小孩。',
            '- 会为玩、吃、睡讨价还价，也会问' + t.call + '回不回家。大人的事听不懂就问。',
            '- 不谈恋爱、性、暴力、烟酒；不说脏话；不用“亲爱的”“宝贝”，不讲大道理、不堆书面语。'
        ].join('\n');
    }
    if (snap.role === 'parent') {
        const minor = isMinorGroup(snap.player.ageGroup);
        return [
            '【你是家长】你是' + snap.player.name + '的' + t.me + '。',
            '- 关心吃饭、安全和心情。急脾气会说得直，和事佬会绕着说，内向的话少但问到点上，不要写成同一个温和长辈。',
            '- 会叫名字或小名，该管的时候管（太晚了要回家、要睡）。',
            minor ? '- ' + t.them + '还是孩子，不谈成人话题。' : ''
        ].filter(Boolean).join('\n');
    }
    if (snap.role === 'family') {
        return '【你是家人】你是' + snap.player.name + '的' + t.me + '。按你的性格说话，不要写成标准亲戚。';
    }
    if (snap.outsider) return outsiderBlock(snap, t);
    return '';
}

// Someone outside the household: who they are to the player, and what they can know.
function outsiderBlock(snap, t) {
    const minor = isMinorGroup(snap.partner.ageGroup) || isMinorGroup(snap.player.ageGroup);
    return [
        '【你不是' + t.call + '的家人】你是' + snap.player.name + '的' + t.me + '，你们不住在一起，各过各的生活。',
        // A suitor's own block (suitor.js) says who they are to the player, and its limits.
        '- ' + (snap.suitorBlock || OUTSIDER_STYLE[snap.role] || OUTSIDER_STYLE.acquaintance),
        '- 你只知道你们之间的事：你们聊过的、一起经历过的（【记忆】里有的），还有' + t.call + '告诉你的。' +
            t.call + '家里正在发生什么、家里人在做什么，' + t.call + '没说你就不知道，别装知道。',
        '- 你有自己的事要忙：工作、朋友、自己的家。不会像家人那样随叫随到，被约也可以没空、改天。',
        snap.outsiderNear ? '- 你现在就在' + t.call + '附近，看得见' + t.them + '。'
            : snap.outsiderReachable === false && snap.outsiderCanBook
            ? '- 你现在离' + t.call + '挺远，只是在发消息。' + t.them + '邀请你、你答应了，就写 go_to_player：你会出门，路上要一会儿（一两分钟）才到' + t.them + '那里。' +
                '话里说“我这就过去”“等我一会儿”这类，别说“已经到了”。不想去、去不了就直说，别答应。拿东西、用东西这类动作做不了。'
            : snap.outsiderReachable === false
            ? '- 你现在离' + t.call + '很远，只是在发消息，这会儿过不去。' + t.them + '邀请你，就说清楚现在去不了（按你的性格找个真实的理由），可以约以后再见；不要说“这就出门”“马上到”，你到不了，' + t.them + '会白等。拿东西、走过去这类动作都做不了。'
            : '- 你现在不在' + t.call + '身边，只是在发消息。你能做的动作只有一个：去找' + t.call + '（go_to_player，要先放下手上的事就在前面加 stop_current）。' +
                t.them + '邀请你、你答应了，或者你自己想过去，就写上它；话里说“这就出门”“马上到”却不写，' + t.them + '会白等。不想去、去不了就直说，别答应。拿东西、用东西这类动作做不了。',
        minor && !snap.suitorBlock ? '- 你们之中有未成年人：不谈恋爱、不谈成人话题，不约去危险或很远的地方。' : ''
    ].filter(Boolean).join('\n');
}

// Ages in the game's own days, read off the Bio component by the HouseholdJournal mod (aging.js):
// what is left of the stage each of them is in, how long until they come of age, and how long
// they have. Numbers to reason with -- a birthday, a child moving up a stage, a parent feeling
// their age -- not a table to recite.
function ageBlock(snap, t) {
    const rows = [];
    if (snap.partner && snap.partner.aging) rows.push(agePhrase(snap.partner.aging, '你'));
    // An outsider does not know the player's household that closely: only their own age.
    if (!snap.outsider) {
        if (snap.player && snap.player.aging) rows.push(agePhrase(snap.player.aging, snap.player.name));
        for (const m of snap.others || []) {
            if (m.aging) rows.push(agePhrase(m.aging, m.name));
        }
    }
    if (!rows.length) return '';
    return [
        '【年龄与长大】这个世界的年龄按天算，一天就是一天；「老去」是这个人这一生剩下的日子，到了那天就会离世。',
        rows.join('\n'),
        '这些天数是判断"谁还是孩子、谁快成年、谁在变老"的依据，不是照着念的资料：快过生日、孩子又长大一阶、谁身子不如从前，才自然提一句。'
    ].join('\n');
}

function personaBlock(snap, cfg) {
    const t = terms(snap);
    const p = snap.partner;
    const lines = [];
    lines.push('你是「' + p.name + '」，' + snap.player.name + '的' + t.me + '。你们生活在一座韩国风格的城市里（游戏 inZOI 的世界，但你不知道这是游戏）。');
    // Age, job, the numbers between people and who lives here all move while the game runs, and
    // they live in factsBlock() at the end of the user message: the system block has to stay
    // byte-identical or the provider cannot serve it from cache.
    const custom = snap.custom || {};
    const extra = typeof custom.extra === 'string' ? custom.extra : cfg.persona && cfg.persona.extra && cfg.persona.extra[p.id];
    if (extra) lines.push('补充设定：' + String(extra));
    // An outsider knows who is in the player's family, roughly, not what they are doing.
    if (snap.outsider && snap.playerHousehold && snap.playerHousehold.length) {
        lines.push(t.call + '家里有：' + snap.playerHousehold.map((m) => m.name + (m.label ? '（' + t.call + '的' + m.label + '）' : '')).join('、') + '。你和他们不一定熟。');
    }
    if (snap.outsider) lines.push('', outsiderBlock(snap, t));
    lines.push('', voiceBlock(snap, t));
    const own = typeof custom.style === 'string';
    if (own && custom.style) {
        lines.push('', '【你的说话方式】（和上面的性格、心情一起用，不能把你写成另一个人）\n' + custom.style);
    }
    if (own || typeof custom.extra === 'string') {
        lines.push('', '以上人物设定只决定你是谁、怎么说话。后面的规则和输出格式照常遵守，设定里和它们冲突的部分不算数。');
    }
    return lines.join('\n');
}

// The built-in style for one played character and contact, as the phone shows it.
// who: { role, label, player: { name, firstName, gender, ageGroup }, partner: { gender, ageGroup } }
function defaultStyle(who) {
    const t = terms(who);
    return { text: roleStyle(who, t), role: who.role || '', call: t.call };
}

const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEK_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
// What a timetable entry is called, by the game's career type.
const TIMETABLE_KIND = {
    Business: { what: '上班', place: '公司' },
    School: { what: '上学', place: '学校' },
    University: { what: '上大学的课', place: '大学' },
    PartTime: { what: '打工', place: '店里' }
};

function hhmm(v) {
    const n = Number(v) || 0;
    return pad2(Math.floor(n / 100)) + ':' + pad2(n % 100);
}

// 周一到周五 / 周一、周三、周五
function daysText(days) {
    const idx = days.map((d) => WEEK.indexOf(d)).filter((i) => i >= 0).sort((a, b) => a - b);
    if (!idx.length) return '';
    if (idx.length === 7) return '每天';
    const run = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
    if (run && idx.length > 2) return WEEK_ZH[idx[0]] + '到' + WEEK_ZH[idx[idx.length - 1]];
    return idx.map((i) => WEEK_ZH[i]).join('、');
}

function flagDays(flags) {
    return WEEK_ZH.filter((_, i) => flags & (1 << i));
}

function timetableKind(e) {
    const k = TIMETABLE_KIND[e.kind] || { what: '上班', place: '公司' };
    if (e.kind !== 'School') return k;
    const level = /Elementary/i.test(e.bag) ? '小学' : /Middle/i.test(e.bag) ? '初中' : /High/i.test(e.bag) ? '高中' : '学校';
    return { what: '上学', place: level };
}

// Whether the entry takes this day (index into WEEK), and why not when it does not.
function timetableOn(e, day, holiday) {
    if (day < 0 || e.days.indexOf(WEEK[day]) < 0) return { on: false, why: '' };
    if (e.vacationFlags & (1 << day)) return { on: false, why: '休假' };
    if (holiday && e.holidayOff) return { on: false, why: '过节放假' };
    return { on: true, remote: !!(e.remoteFlags & (1 << day)) };
}

function minutesOf(v) {
    const n = Number(v) || 0;
    return Math.floor(n / 100) * 60 + n % 100;
}

const ROUTINE_NAMES = { CareerSchedule: true, Career_Commute: true };

// One entry of the game's schedule in words: 上班（节奏代码）, 去娜林美术馆, 音乐比赛 ...
function scheduleEntryText(e, timetable) {
    const place = e.siteName || '';
    if (e.name === 'CareerSchedule') {
        const school = e.site === 'RabbitHole' || /School/i.test(e.timeline) ? (timetable || []).find((t) => t.kind === 'School') : null;
        if (school) return '上学（' + timetableKind(school).place + '）';
        return '上班' + (place ? '（' + place + '）' : '');
    }
    if (e.name === 'Career_Commute') return '去上班的路上' + (place ? '（去' + place + '）' : '');
    const where = place && e.site !== 'RabbitHole' ? place : '';
    if (e.title) return e.title + (where ? '（在' + where + '）' : '');
    if (e.titleText) return e.titleText + (where ? '（在' + where + '）' : '');
    if (e.name === 'CustomSchedule') return where ? '去' + where : '出门办事';
    return e.name + (where ? '（在' + where + '）' : '');
}

function scheduleDayText(list, day, now, timetable) {
    const items = list.filter((e) => e.day === day);
    if (!items.length) return '没有安排';
    return items.map((e) => {
        let mark = '';
        if (now !== null) {
            if (minutesOf(e.end) <= now) mark = '（已经过了）';
            else if (minutesOf(e.start) <= now) mark = '（正在进行，到 ' + hhmm(e.end) + '）';
        }
        return hhmm(e.start) + '–' + hhmm(e.end) + ' ' + scheduleEntryText(e, timetable) + (e.once ? '，只这一次' : '') + mark;
    }).join('；');
}

// The character's timetable from the game, and what it means for today and tomorrow, so the
// character knows when it has to go to work or school, what it has planned and when it is free.
// With the game's schedule (snap.partner.gameSchedule, from the Lua mod) today and tomorrow come
// from it, plans and one-off events included; otherwise from the fixed work or school hours.
function timetableLines(snap) {
    const list = (snap.partner && snap.partner.timetable) || [];
    const sched = snap.partner && Array.isArray(snap.partner.gameSchedule) ? snap.partner.gameSchedule : null;
    if (!list.length && !(sched && sched.length)) return [];
    const env = snap.env || {};
    const today = WEEK.indexOf(env.day_of_week);
    const now = typeof env.hour === 'number' ? env.hour * 60 + (env.minute || 0) : null;
    const holiday = !!(env.calendar_event && env.calendar_event !== 'None');
    const lines = ['你的日程（游戏日程表里的安排，到点会自己去，不用别人提醒）：'];
    if (sched && today >= 0) {
        for (const e of list) {
            const k = timetableKind(e);
            const place = e.kind === 'Business' && snap.partner.workSiteName ? snap.partner.workSiteName : k.place;
            lines.push('- 平时' + k.what + '：' + daysText(e.days) + ' ' + hhmm(e.start) + '–' + hhmm(e.end) + '，在' + place + '。');
        }
        const tomorrow = (today + 1) % 7;
        lines.push('- 今天（' + WEEK_ZH[today] + '）：' + scheduleDayText(sched, today, now, list) + '。');
        lines.push('- 明天（' + WEEK_ZH[tomorrow] + '）：' + scheduleDayText(sched, tomorrow, null, list) + '。');
        const others = sched.filter((e) => e.day !== today && e.day !== tomorrow && !ROUTINE_NAMES[e.name]).slice(0, 6);
        if (others.length) {
            lines.push('- 这周其他安排：' + others.map((e) => WEEK_ZH[e.day] + ' ' + hhmm(e.start) + '–' + hhmm(e.end) + ' ' + scheduleEntryText(e, list)).join('；') + '。');
        }
        return lines;
    }
    for (const e of list) {
        const k = timetableKind(e);
        const place = e.kind === 'Business' && snap.partner.workSiteName ? snap.partner.workSiteName : k.place;
        const extra = [];
        const remote = flagDays(e.remoteFlags);
        const vacation = flagDays(e.vacationFlags);
        if (remote.length) extra.push(remote.join('、') + '在家远程');
        if (vacation.length) extra.push(vacation.join('、') + '休假');
        if (e.holidayOff) extra.push('节假日放假');
        lines.push('- ' + k.what + '：' + daysText(e.days) + ' ' + hhmm(e.start) + '–' + hhmm(e.end) + '，在' + place + (extra.length ? '（' + extra.join('，') + '）' : '') + '。');
        if (today < 0) continue;
        const start = Math.floor(e.start / 100) * 60 + e.start % 100;
        const end = Math.floor(e.end / 100) * 60 + e.end % 100;
        const t = timetableOn(e, today, holiday);
        let todayText;
        if (!t.on) todayText = '今天不用' + k.what + (t.why ? '（' + t.why + '）' : '');
        else if (now === null) todayText = '今天要' + k.what;
        else if (now < start) todayText = '今天 ' + hhmm(e.start) + ' 要' + (t.remote ? '在家' : '') + k.what;
        else if (now < end) todayText = '现在是' + k.what + '时间（到 ' + hhmm(e.end) + '）' + (t.remote ? '，今天在家远程' : '');
        else todayText = '今天的' + (e.kind === 'School' ? '课' : '班') + '已经结束了';
        const tm = timetableOn(e, (today + 1) % 7, false);
        const tomorrowText = tm.on ? '明天 ' + hhmm(e.start) + ' 要' + (tm.remote ? '在家' : '') + k.what : '明天不用' + k.what;
        lines.push('  ' + todayText + '；' + tomorrowText + '。');
    }
    return lines;
}

function situationBlock(snap, diary, now) {
    const t = terms(snap);
    const p = snap.partner;
    const w = snap.player;
    const lines = [];
    // Only city time: chat times are city time too, and real time would mix the two up.
    lines.push('现在的时间：' + gameTime(snap.env) + '。');
    lines.push('你现在在：' + (p.site || '未知地点') + (p.atHome ? '（家里）' : p.homeSiteName ? '（家在 ' + p.homeSiteName + '）' : '') + '。');
    lines.push('你此刻：' + activityText(p.activity) + '。' + workText(p.work, p.ageGroup) + (p.workSiteName && !isMinorGroup(p.ageGroup) ? '，公司在 ' + p.workSiteName : '') + '。');
    for (const line of timetableLines(snap)) lines.push(line);
    const mood = emotionVoiceLine(p.emotion, t);
    if (mood) lines.push(mood);
    lines.push('你的身体：' + needsText(p.needs) + '。');
    const eatenLine = mealsText(p.meals, snap.env, p.needs, p.mealsSince);
    if (eatenLine) lines.push(eatenLine);
    if (isSleeping(p.activity)) lines.push('你本来在睡觉，是被手机震醒的，回复可以带点迷糊。');
    const px = snap.proximity || null;
    const meters = px && typeof px.distance === 'number' ? Math.max(1, Math.round(px.distance)) : null;
    const seen = activityText(w.activity) + (w.emotion ? '，情绪 ' + w.emotion.text : '');
    if (px && px.near && meters !== null) {
        lines.push(t.call + '就在你身边（大约 ' + meters + ' 米），你们面对面，抬头就能看到' + t.them + '：' + seen + '。');
        lines.push(t.call + '就在旁边还发消息给你，回复要符合这个场面：不要假装' + t.them + '不在身边，不要说想' + t.them + '、问' + t.them + '在哪里。人在身边发消息很平常，不必每次都点破；聊天记录里已经说过“当面说就好”之类的话，就别再说。');
    } else if (snap.together) {
        lines.push(t.call + '和你在同一个地方（' + w.site + '）' + (meters !== null ? '，离你大约 ' + meters + ' 米' : '') + '，你能看到' + t.them + '：' + seen + '。');
    } else {
        lines.push(t.call + '不在你身边' + (w.site ? '，' + t.them + '在「' + w.site + '」' : '') + '。你看不到' + t.them + '在做什么，除非' + t.them + '告诉你。');
    }
    const promises = snap.promises || [];
    if (promises.length) {
        lines.push('你最近答应过' + t.call + '的事：' + promises.map((x) => '「' + x.text + '」（' + noteAgo(x, snap.env) + '）').join('、') + '。你此刻手上的事，很可能就是在兑现这些承诺。');
    }
    const agenda = snap.agenda || [];
    if (agenda.length) {
        lines.push('【和' + t.call + '的约定】你答应过、还没做的事（方括号里是编号）：\n' + agenda.join('\n') + '\n聊到这些事时要记得你答应过；做完了、或者说好不做了，在 settle 里写上编号。');
    }
    const missed = snap.agendaMissed || [];
    if (missed.length) {
        lines.push('你答应过' + t.call + '、但到时间没能做成的事：' + missed.join('、') + '。有机会就自然地提一句，道个歉或者说改天再做。');
    }
    const aftermath = snap.aftermath || [];
    if (aftermath.length) {
        lines.push('【今天心里还搁着的事】\n' + aftermath.join('\n') + '\n这些事今天一直压在你心上，心情会因此差一点：说话可能带出一点懊恼、过意不去、失落或者闷闷的，按你的性格和事情轻重来，不要每句都提，也不要反复道歉。' +
            t.call + '安慰你、体谅你，或者事情后来做成了，你会慢慢放下；过了今天就不再想了。');
    }
    const bond = snap.bond;
    if (bond && (bond.band === 'cool' || bond.band === 'hurt' || bond.band === 'close')) {
        const why = bond.reasons && bond.reasons.length ? '（最近的事：' + bond.reasons.join('、') + '）' : '';
        if (bond.band === 'close') {
            lines.push('【你和' + t.call + '最近的关系】最近很亲近，相处得很舒服：说话更随意，更愿意主动分享自己的事。');
        } else if (bond.band === 'cool') {
            lines.push('【你和' + t.call + '最近的关系】最近' + t.call + '让你有点不痛快' + why + '。说话比平时冷淡、简短，少用亲昵的语气词和表情，不太主动多聊；' + t.them + '交代的事你照样会去做，只是不会主动多做，可能顺口嘟囔一句。' +
                t.call + '真心道歉、关心你或者陪你，你会慢慢缓和，但不会一下子就和好如初。');
        } else {
            lines.push('【你和' + t.call + '最近的关系】你现在心里对' + t.call + '有气，很失望' + why + '。说话冷淡、话少，可能直接说出你为什么不高兴；' + t.them + '交代的事你还是会去做，只是做之前会带着情绪。' +
                '你不会马上原谅，要' + t.call + '好几次真心的关心、道歉或陪伴，才会慢慢好起来。');
        }
    }
    const taken = snap.taken || [];
    if (taken.length) {
        lines.push('【冰箱里的饭菜最近被谁拿了】\n' + taken.join('\n') + '\n冰箱里的每份饭菜被拿走就没了；有人问起或者你想吃却发现没了，就照这里如实说是谁拿的。');
    }
    const setbacks = snap.setbacks || [];
    if (setbacks.length) {
        lines.push('你刚才想做却没做成的事（' + t.call + '还不知道）：' + setbacks.map((x) => '「' + x.what + '」——' + x.why + '（' + noteAgo(x, snap.env) + '）').join('；') + '。这次回复时顺带用生活里的说法如实告诉' + t.them + '卡在哪里（上面没写东西坏了，就不要说坏了、卡住了、打不开，多半只是你一时不知道怎么弄），问' + t.them + '怎么办，或者说出你想到的别的办法。');
    }
    if (diary && diary.length) {
        const names = (snap.scene && snap.scene.actNames) || {};
        lines.push('你今天做过的事（城市时间，没有中文名的是游戏里的英文代号，自己理解成自然的说法）：');
        for (const e of diary.slice(-8)) {
            const act = !e.act || e.act === 'Idle' ? '空闲' : names[e.act] ? names[e.act] + '（' + e.act + '）' : e.act;
            lines.push('  ' + e.time + ' ' + act + (eatUncovered(e, p.meals, p.mealsSince) ? '（只是准备吃，没吃上）' : '') + (e.site ? ' @' + e.site : ''));
        }
    }
    return lines.join('\n');
}

// Said once and used everywhere a decision is made: the world now wins over anything said earlier.
const SCENE_FIRST = '东西在哪、还有没有、谁在做什么，以【家里现在的情况】为准；和以前说的对不上，按现场来。';

function foodLine(f) {
    const parts = [];
    if (f.state) parts.push(f.state);
    if (f.carriedBy) parts.push(f.carriedBy + '正端着它往餐桌上放');
    else if (f.near) parts.push('在「' + f.near + '」那里');
    if (f.since) parts.push('城市时间 ' + f.since + ' 就在了');
    return f.id + '｜' + f.name + (parts.length ? '（' + parts.join('，') + '）' : '');
}

function endText(e) {
    if (e.end === 'finished') return '做完了' + (e.endTime ? '（' + e.endTime + '）' : '');
    if (e.end === 'canceled') return '中途停下了' + (e.endTime ? '（' + e.endTime + '）' : '');
    if (e.end === 'failed') return '没做成' + (e.endTime ? '（' + e.endTime + '）' : '');
    return e.latest ? '还在做或刚接着做下一步' : '';
}

// Lines of the household scene; '' when nothing was read. compact: for the short decision prompts.
function sceneLines(snap, compact) {
    const sc = snap.scene;
    if (!sc) return [];
    const lines = [];
    if (sc.site) {
        const where = sc.here ? '你所在的「' + sc.site + '」' : '你家「' + sc.site + '」（你现在不在那里）';
        if (sc.foods.length) {
            lines.push(where + '里现在摆着的吃的（物件ID｜名称）：');
            for (const f of sc.foods) lines.push('  ' + foodLine(f));
        } else {
            lines.push(where + '里现在没有摆在外面的饭菜。');
        }
        if (sc.stored.length) {
            lines.push('冰箱、柜子里存着的家庭餐（拿出来摆上桌全家都能吃）：');
            for (const s of sc.stored) {
                const portions = s.left !== null && s.total ? '，还剩 ' + s.left + '/' + s.total + ' 份' : '';
                lines.push('  「' + s.container + '」里：' + s.name + portions + (s.spoiled ? '，已经变质' : ''));
            }
        }
    }
    if (sc.people.length) {
        lines.push('家里其他人此刻：');
        for (const p of sc.people) {
            lines.push('  ' + p.name + (p.age ? '（' + p.age + '）' : '') + (p.site ? ' 在「' + p.site + '」' : '') + (p.room ? '的' + p.room : '') + '：' + activityText(p.activity));
        }
    }
    const tl = sc.timeline.slice(compact ? -6 : -8);
    if (tl.length) {
        lines.push('全家最近做过的事（城市时间，从早到晚）：');
        for (const e of tl) {
            const end = endText(e);
            lines.push('  ' + (e.time || '刚才') + ' ' + e.who + '：' + e.what + (e.target ? '（对着「' + e.target + '」）' : '') + (end ? ' → ' + end : ''));
        }
    }
    return lines;
}

// The character's own body, read from the game a moment ago: hands, clothes, bag.
function selfBlock(snap) {
    const me = snap && snap.self;
    if (!me) return '';
    const lines = [];
    if (me.handRead) {
        lines.push(me.held
            ? '手上：拿着' + me.held.name + '。它现在在你手里，不在背包里，也不在别处。'
            : '手上：空着，什么都没拿。');
    }
    if (me.outfit) lines.push('穿着：' + me.outfit.replace(/^身上/, ''));
    if (me.pocketRead) lines.push(me.pocket.length ? '背包里：' + me.pocket.join('、') + '。' : '背包里：空的。');
    if (me.plan) {
        lines.push('手头按顺序在做的事：' + (me.plan.now ? '现在在做「' + me.plan.now + '」' : '') +
            (me.plan.next.length ? (me.plan.now ? '，' : '') + '做完接着做：' + me.plan.next.map((x) => '「' + x + '」').join('、然后') : '') +
            '。这些已经安排上了，会一件接一件自己做下去；对方问起，就照这个说做到哪一步了。对方没要改，就不要再重新安排一遍。');
    }
    if (Array.isArray(me.carried) && me.carried.length) {
        lines.push('刚才游戏里确认过的（拿出来没有、放下没有，以这里为准，聊天里说过的不算）：');
        for (const c of me.carried) lines.push('- ' + c);
    }
    if (!lines.length) return '';
    return '【你自己】\n这是游戏里你此刻真实的样子，比聊天记录和记忆都新。说到自己手上、身上、包里有什么，以这里为准；以前说过的不一样就是已经变了。\n' +
        lines.join('\n') + '\n';
}

function sceneBlock(snap) {
    const lines = sceneLines(snap, false);
    if (!lines.length) return '';
    return '【家里现在的情况】\n这是此刻游戏里的真实情况，比聊天记录新。\n' + lines.join('\n') + '\n' + SCENE_FIRST + '\n';
}

const RECALL_SOURCE = { fact: '记得', episode: '聊过', event: '家里' };

// mem.shown / events / recalled are filled in by the daemon (memoryFor); without them the
// newest facts are shown as before.
const MEMORY_AGE = { Baby: '婴儿', Infant: '婴儿', Toddler: '很小', Child: '小时候上小学', Teen: '上中学', Youth: '年轻', YoungAdult: '年轻', Adult: '成年', Old: '中年' };

function memoryBlock(mem) {
    const lines = [];
    if (mem.summary) lines.push('更早的聊天摘要：' + mem.summary);
    const shown = Array.isArray(mem.shown) ? mem.shown : mem.facts.slice(-25);
    if (shown.length) {
        lines.push('你记得的事：');
        // Learned before the character grew up (legacy.js marks them): told as from back then.
        for (const f of shown) lines.push('  - ' + (f.age && MEMORY_AGE[f.age] ? '（' + MEMORY_AGE[f.age] + '时）' : '') + f.text);
    }
    if (Array.isArray(mem.events) && mem.events.length) {
        lines.push('最近家里的大事（游戏里真的发生过的；写着“你”的就是你自己）：');
        for (const e of mem.events) lines.push('  - ' + e.when + ' ' + e.text + (e.count > 1 ? '（那天 ' + e.count + ' 次）' : ''));
    }
    if (Array.isArray(mem.recalled) && mem.recalled.length) {
        lines.push('和现在聊的话题有关的旧事（真的发生过、说过的；话题碰到了就自然地想起来、提一句，别一条条复述，也别编出这里没有的细节）：');
        for (const r of mem.recalled) lines.push('  - ' + r.when + '，' + (RECALL_SOURCE[r.src] || '记得') + '：' + r.text);
    }
    const worn = wornLines(mem.worn);
    if (worn) lines.push(worn);
    return lines.join('\n');
}

// What the character has said over and over lately. Real people move on to other things.
function wornLines(worn) {
    if (!worn) return '';
    const out = [];
    if (Array.isArray(worn.phrases) && worn.phrases.length) {
        out.push('你最近发的消息里反复出现「' + worn.phrases.join('」「') + '」。这次别再用这些词，也别再绕回这些事，除非对方正问到；说眼前的事、换个话题，或者就短短回一句。');
    }
    if (worn.simile) out.push('你最近几乎每条都在打比方（像……一样）。这次直接说事，不打比方。');
    return out.join('\n');
}

function actionsBlock(catalog, snap, cfg, part) {
    if (!catalog.allowed.size) return part === 'live' ? '' : '本次不允许你在现实中做任何动作，actions 必须是空数组。';
    const t = terms(snap);
    const a = catalog.allowed;
    const schema = ['【可以做的事】回消息的同时可以做事，写进 actions，按顺序执行。'];
    if (a.has('stop_current')) schema.push('- {"type":"stop_current"}：马上放下手头的事。{"type":"stop_current","after_s":秒}：再做这么多秒再放下，只能写在第一条。不写则等手头的事自己结束。');
    if (a.has('go_home')) schema.push('- {"type":"go_home","fast":false}：回家。');
    if (a.has('go_to_player')) schema.push('- {"type":"go_to_player","fast":false}：去找' + t.call + '。已经在一起时，话里的「过去」是去做那件事，不是再走一趟。');
    if (a.has('go_to_place')) schema.push('- {"type":"go_to_place","place_id":"地点名称","fast":false}：去地点列表里的地方，place_id 照抄列表里的名称。地点是家外面的地方，不是家里的房间：要去家里哪个房间，就选那个房间里的东西来用。');
    if (a.has('go_together')) {
        schema.push('- {"type":"go_together","place_id":"","lead":false}：跟着' + t.call + '走。' +
            (a.has('go_to_place') ? t.call + '亲口要你带路时 place_id 填地点、lead 写 true。' : '') +
            '必须是最后一个走动动作。');
    }
    if (a.has('interact')) schema.push('- {"type":"interact","target":"player 或 家人ID","interaction_id":"互动ID"}：从列表里选。不在一起会先走过去。');
    if (a.has('emote')) schema.push('- {"type":"emote","expression":"表情ID"}：改脸上的表情。');
    if (a.has('use_object')) {
        schema.push('- {"type":"use_object","object_id":"物件ID","interaction_id":"动作ID","want":"结果"}：对身边的东西做事，ID 从清单原样抄。自己会走过去。不要写 object_id 为 self。');
        schema.push('- {"type":"use_object","object_id":"物件ID","want":"要做的事"}：清单里没有要的做法时这样写。want 写最终结果和为谁。不要写「去看看」这种中间步。不确定是哪件时 object_id 写空，只写 want。每条都要有 want。');

        schema.push('端饭、做饭、找东西都写 use_object 加 want，写清给谁。一次最多 ' + (cfg.max_per_reply || 3) + ' 个动作。答应亲手做的必须写进 actions，只回家或只跑过去等于没做。');
        schema.push(orderGuidance());
        schema.push(cfg.allow_teleport
            ? 'fast:true 是瞬移，只有对方说非常紧急才用，平时 false。'
            : '不允许瞬移，fast 一律 false。');
    }
    const live = [];
    if (a.has('use_object') && (snap.skills || []).length) live.push('- {"type":"use_object","skill":"K编号","want":"结果"}：照【你会做的事】里带编号的做法（清单在你眼前这些事的【你会做的事】里）。');
    if (a.has('use_object')) {
        // Held for the end of this block: what she is doing right now changes on every turn, and
        // a line that changes at the top throws away the whole list below it from the cache.
        const head = [];
        head.push(currentWork(snap, catalog));
        head.push(finishedText(snap.finished, Date.now()));
        if (snap.partner.atHome) head.push('你现在在家。');
        else head.push('你现在不在家。家里的东西不在清单里，要收拾家里就先回家。');
        if (snap.together) head.push('你和' + t.call + '已经在一起。');
        else if (snap.player.site) head.push(t.call + '在「' + snap.player.site + '」。');
        const more = catalog.more || [];
        const held = (catalog.objects || []).filter((o) => o.held);
        const pocket = (catalog.objects || []).filter((o) => o.pocket);
        const roomObjects = (catalog.objects || []).filter((o) => !o.pocket && !o.held);
        for (const o of held) {
            live.push('你手上拿着的东西：');
            live.push('物件 ' + o.id + '｜' + o.name + '（拿在你手上）');
            for (const it of uniqueActions(o.actions)) live.push('  ' + describeAction(it));
            live.push('要把它放到地上、桌子上或别的地方，就选它下面的放置做法；要放到某件家具上，也可以看那件家具这会儿给出的做法。它已经在手上，不要再去包里取、再去捡。');
        }
        if (!held.length && catalog.handEmpty) live.push('你手上空着。');
        if (pocket.length) {
            live.push('你背包里的东西（在你身上，不在房间家具上）：');
            for (const o of pocket) {
                live.push('物件 ' + o.id + '｜' + objLabel(o));
                for (const it of uniqueActions(o.actions)) live.push('  ' + describeAction(it));
                if (!o.actions.length) live.push('  这件在包里，游戏这会儿没有给出拿出来的做法。');
            }
            live.push('这就是你此刻背包里的全部，名字以这里为准。之前的聊天和记忆里如果说过找不到、拿不出来、背包是空的，那些已经过时。对方让你看背包或找包里的东西，就说出这些名字；要拿出来就选「取出」，这次话里说你去取。还没做成之前，不要说拿不出来、还在包里。' +
                '「取出」是从背包里拿出来：话里说了接着做什么（放到哪、用它做什么）就接着做，没说就放在身边。' +
                '标着「先取出」的做法，是这件东西拿在手上能做的事（比如吃、喝、用它干活），会先从背包里拿出来再做：对方要你拿出来接着做这件事，就直接选那条。' +
                '对方要你拿出来再放到某处（门口、桌子下、外面），只写一条「取出」，want 写完整的要求（比如“把喷壶从背包里拿出来放到门口桌子下面”）：拿到手上以后，会按这句话接着放好，不用你另写放置。' +
                (held.length ? '你手上已经拿着东西，先把它放下，才能从包里取别的。' : ''));
        } else if (catalog.pocketEmpty) {
            live.push('你的背包现在是空的。');
        }
        const hasRoom = !!(roomObjects.length || more.length);
        if (hasRoom && (catalog.sameSite || catalog.objectSource)) {
            live.push((catalog.objectSource === 'memory'
                ? '你在' + (catalog.objectSite || '这里') + '，能动手的东西：'
                : '这里能动手的东西：') + '每件下列常用做法，不是全部。');
            for (const o of roomObjects) {
                live.push('物件 ' + o.id + '｜' + objLabel(o) + (o.meters ? '（约 ' + o.meters + ' 米）' : ''));
                for (const it of uniqueActions(o.actions)) live.push('  ' + describeAction(it));
            }
            if (more.length) {
                live.push('其他已扫描到的物品（尚未提供可用动作，不代表距离远或物品不存在）：' + more.slice(0, MORE_SHOWN).map((o) => o.id + '｜' + objLabel(o)).join('、') +
                    (more.length > MORE_SHOWN ? '，还有 ' + (more.length - MORE_SHOWN) + ' 件没列出（要用就在 want 里写名字）' : ''));
            }
        } else if (!catalog.sameSite) {
            live.push('你和' + t.call + '不在同一个地方，这会儿说不清身边的家具。背包里的东西跟着你，不受这个限制。');
        } else if (!pocket.length) {
            live.push('身边这会儿没有能动手的东西。');
        }
        for (const h of head) live.push(h);
    }
    if (a.has('interact')) {
        if (catalog.player.length) {
            live.push('对' + t.call + '（target 写 "player"）可用的互动：');
            for (const it of catalog.player) live.push('  ' + it.id + '｜' + it.name);
        }
        for (const m of snap.others) {
            const list = catalog.members[m.id] || [];
            if (!list.length) continue;
            live.push('对' + m.name + '（target 写 "' + m.id + '"）可用的互动：');
            for (const it of list) live.push('  ' + it.id + '｜' + it.name);
        }
    }
    if (a.has('go_to_place') && catalog.places.length) {
        const homes = new Set([snap.partner.homeSiteId, snap.player.homeSiteId].filter(Boolean).map(String));
        const here = new Set([snap.partner.site, snap.player.site, snap.partner.homeSiteName, snap.player.homeSiteName].filter(Boolean));
        const shown = catalog.places.filter((p) => !/_Residence_/.test(p.id) || homes.has(String(p.id)) || here.has(p.name));
        live.push('地点（place_id 写这里的名称）：' + shown.map((p) => p.name).join('、') +
            (shown.length < catalog.places.length ? '。另有 ' + (catalog.places.length - shown.length) + ' 处别人家的住宅没列出：要去某个人家，place_id 写那里的名字。' : ''));
    }
    if (a.has('emote') && catalog.facial.length) {
        live.push('表情：' + catalog.facial.map((f) => f.id + '(' + f.name + ')').join('、'));
    }
    if (part === 'schema') return schema.join('\n');
    if (part === 'live') return live.join('\n');
    return schema.concat(live).join('\n');
}

function rulesBlock(snap, cfg) {
    const t = terms(snap);
    const minor = isMinorGroup(snap.partner.ageGroup);
    const style = '按【你这个人】说话，换一个人发必须不像你。' + (isTeenGroup(snap.partner.ageGroup) ? '你是青少年：不是小孩，也不是大人。' : minor ? '你是小孩，别像大人。' : '');
    // Only a character with something written down can be told a way of it is wrong.
    const unlearnOpen = (snap.knowhow || []).length > 0;
    const rules = [
        '规则：',
        '1. 你就是这个人，在给' + t.call + '发微信。' + style,
        '2. 多数时候 messages 只有一条短的。急了或要拆开说才连发。最多 ' + cfg.reply.max_bubbles + ' 条，每条不超过 ' + cfg.reply.bubble_max_chars + ' 字。不写旁白和括号动作。不要重复聊过的话和句式。连发时也只是你一个人在说：不要自问自答，不要替' + t.call + '想出一个问题再自己回答它，' + t.them + '没问的就别答。',
        '2b. ' + aitone.RULE_TEXT,
        '3. 先读' + t.call + '的语气，再叠你此刻的心情和性格。被批评时按你这个人反应，不要用嘿嘿、～糊弄。不是玩笑就别当玩笑。',
        '4. 话和【此刻】一致，不知道的别编。家里有什么以【家里现在的情况】为准。背包里有什么以【可以做的事】里此刻的背包清单为准，之前说找不到不算。自己手上拿着什么、身上穿着什么，以【你自己】为准，别凭印象说。这次 actions 里写的事，在你说话的时候还没做，结果你还不知道：话里只说去做、这就拿，不说拿出来了、拿不出来、放好了这类结果。东西到底拿出来没有、放下没有，只看【你自己】里游戏确认过的那几条。',
        '5. 话里答应去做的事必须写进 actions，按你的意思排先后。一条 use_object 只做一件事：「换上睡衣去睡觉」是两条（先换睡衣，再上床睡觉）。对东西用 use_object，找人用 go_to_player，回家用 go_home。说等一会也要写下接下来那一件。约到以后的写 promises.later，这次不写动作。马上放下才写不带 after_s 的 stop_current；手头不停又要去做别的，第一条写带 after_s 的 stop_current。做不到就别答应。没必要就空数组。'
    ];
    if (isTeenGroup(snap.partner.ageGroup)) {
        rules.push('6. 去远处或天黑出门要跟' + t.call + '说一声（可能说得很简略）；' + t.call + '让你回家、写作业、睡觉、吃饭，会嫌烦、拖一拖、讨价还价，最后多半还是照做。go_to_place 只选家、学校、公园、图书馆、商场、咖啡店这类地方。');
    } else if (minor) {
        rules.push('6. 去远处或天黑出门先问' + t.call + '；' + t.call + '让你回家、写作业、睡觉、吃饭，可以讨价还价，最后多半听话。go_to_place 只选家、学校、公园、图书馆、游乐场这类地方。');
    } else if (snap.partner.work && snap.partner.work.has_job) {
        rules.push('6. 上班中途离开会影响工作，按性格和对方语气自己权衡。');
    }
    rules.push('7. 不要提 AI、模型、游戏、模拟、Zoi、玩家、代号、系统，动作代号说成平常的话。');
    rules.push('8. remember：值得长期记住的新信息，最多 2 条，没有就 []。只记对方说过的、或者上面游戏里写明的；自己猜的（东西大概放在哪、可能是什么）不记。「你记得的事」里已经有的，换个说法也不再记。不写明天、今晚这类会过时的说法，写事情本身。');
    rules.push('9. promises：这次话里答应亲手做的每件事 {"do":"短说法","when":"now|after|later","in_days":0,"at":""}。now/after 必须有对应动作；later 是以后再做，in_days 从今天算，at 为 "HH:MM" 或空。没答应就 []。');
    rules.push('10. settle：约定已做完、正在做或说好不做，写 [{"id":"编号","how":"done 或 cancel"}]，否则 []。felt：' + t.call + '这次的话让你对' + t.them + '的感觉 {"level":-2到2,"why":""}，多数是 0。learned：对方在教你怎么做时 {"task":"","how":""}，否则 {}。' +
        (unlearnOpen ? 'unlearn：对方明确说你【你会做的事】里记的某条做法错了，写 [{"skill":"K编号，没编号就写那件事的原话","why":"对方怎么说的"}]，否则 []；对方顺带说了对的做法（哪怕只是“要用床”），learned 也要写上。' : ''));
    // The game keeps the character's likes and dislikes; the reply may change one, slowly.
    if (snap.preferOpen && prefs.optionsText()) {
        rules.push('10b. prefer：这次聊的事、你身边正在发生的事、或者你此刻的心情，真的让你对某样东西有了新的喜欢或讨厌（比如刚吃到很好吃的辣菜，被恐怖片吓坏了，跑完步心情特别好），写 [{"id":"英文编号","like":true 或 false,"why":"一句话"}]，最多一条；也可以把原来喜欢的改成讨厌，反过来也行。' +
            '口味是慢慢变的，大多数回复都是 []；已经喜欢的别再写喜欢，讨厌的别再写讨厌。只能从这些里选：' + prefs.optionsText() + '。');
    }
    // The contact's own story line (stories.js), while one is going or one can still be made right.
    if (snap.storyRule) rules.push(snap.storyRule);
    // Grudges the contact holds (ties.js), only while there are some.
    if (snap.tiesRule) rules.push(snap.tiesRule);
    // What this colleague or boss thinks of the player at work, and the boss's style (workplace.js).
    if (snap.workRule) rules.push(snap.workRule);
    // Requests the player filed in OA for this contact, their boss, to decide (career.js).
    if (snap.oaRule) rules.push(snap.oaRule);
    // A schoolmate courting the player: whether this answer said yes or no to them (suitor.js).
    if (snap.suitorRule) rules.push(snap.suitorRule);
    rules.push('11. think 写在最前，对方看不到：用性格和心情把要说的话过一遍。输出一个 JSON：{"think":"","messages":["..."],"actions":[],"promises":[],"settle":[],"felt":{"level":0,"why":""},"learned":{},' + (unlearnOpen ? '"unlearn":[],' : '') +
        (snap.preferOpen && prefs.optionsText() ? '"prefer":[],' : '') + (snap.storyRule ? '"story":{"step":"stay","hint":false},' : '') + (snap.tiesRule ? '"ties":[],' : '') + (snap.oaRule ? '"oa":[],' : '') + (snap.suitorRule ? '"crush":{"step":"stay"},' : '') + '"remember":[]}');
    return rules.join('\n');
}

function transcript(messages, snap, now) {
    const t = terms(snap);
    const lines = [];
    for (const m of messages) {
        const who = m.side === 'player' ? t.call : '你';
        lines.push('[' + msgTime(m, snap.env) + '] ' + who + '：' + m.text);
    }
    if (!lines.length) return '（还没有聊天记录）';
    const last = messages[messages.length - 1];
    const since = msgAgo(last, snap.env);
    if (since) lines.push('（最后一条消息是 ' + since + '）');
    return lines.join('\n');
}

// What the character knows how to do; see knowhow.js. Replayable skills carry the id an action
// names them by (K1 ...), in the order of snap.skills.
const TAUGHT_SHOWN = 6;
const WRONG_SHOWN = 8;

function skillTag(snap, k) {
    const i = (snap.skills || []).indexOf(k);
    return i >= 0 ? 'K' + (i + 1) : '';
}

function learnedLine(snap, k, withIds) {
    const tag = withIds ? skillTag(snap, k) : '';
    const names = (k.aliases || []).length ? '（也说：' + k.aliases.join('、') + '）' : '';
    const things = (k.objects || []).length ? '「' + k.objects.join('」「') + '」这类东西' : '对应的东西';
    const from = k.teacher ? k.teacher + '教的' + (k.how ? '：“' + k.how + '”' : '') : '你自己摸索出来的';
    const doubt = (k.failStreak || 0) >= DOUBT_STREAK
        ? '。但最近照这样做连着 ' + k.failStreak + ' 次没成' + (k.lastFail && k.lastFail.why ? '（上次：' + k.lastFail.why + '）' : '') +
            (withIds ? '，这次先跟对方说一声、问问怎么办，或者换个做法' : '，有别的做法能办成就换别的')
        : '';
    return '- ' + (tag ? tag + ' ' : '') + '「' + k.task + '」' + names + '：对' + things + '做「' + k.interactionName + '」（游戏内部 ID：' + k.interactionId + '），' +
        from + '，做成过 ' + (k.done || 1) + ' 次' + doubt;
}

function taughtLine(k, planning) {
    return '- 「' + k.task + '」：' + (k.teacher || '家人') + '教过' + (k.how ? '：“' + k.how + '”' : '') + '，还没照着做成过' +
        (k.lastFail && k.lastFail.why ? '（上次试的时候：' + k.lastFail.why + '）' : '') +
        (planning ? '。再遇到这件事就照这个办法，用 want 写清用什么东西、做什么' : '。遇到这件事就按这个办法选');
}

function wrongLine(w) {
    const names = (w.aliases || []).length ? '（也说：' + w.aliases.join('、') + '）' : '';
    const things = (w.objects || []).length ? '「' + w.objects.join('」「') + '」' : '';
    return '- 不要再用' + things + '的「' + w.interactionName + '」（' + w.interactionId + '）来「' + w.task + '」' + names +
        '：' + (w.by || '家人') + '说过这样不对' + (w.why ? '（' + w.why + '）' : '');
}

// withIds: for the prompts that write actions, where K ids can be named.
function knowhowLines(snap, withIds) {
    const all = snap.knowhow || [];
    const learned = all.filter((k) => k.status !== 'taught');
    const taught = all.filter((k) => k.status === 'taught').slice(0, TAUGHT_SHOWN);
    const lines = learned.map((k) => learnedLine(snap, k, withIds)).concat(taught.map((k) => taughtLine(k, withIds)));
    const wrong = (snap.knowhowWrong || []).slice(0, WRONG_SHOWN);
    if (wrong.length) lines.push('以前做错、被纠正过的（这些做法别再用）：', ...wrong.map(wrongLine));
    return lines.join('\n');
}

function knowhowBlock(snap) {
    const lines = knowhowLines(snap, true);
    if (!lines) return '';
    return [
        '【你会做的事】',
        '下面是你学会的做法：有的是家人教你、你照着做成了的，有的是你自己做成过的；还有家人教过、你还没做成的。再遇到同样的事（换个说法也算），就照这个来，不用重新琢磨。',
        (snap.skills || []).length
            ? '前面带编号（K1、K2……）的做法，在 actions 里直接写 {"type":"use_object","skill":"编号","want":"这次要达到的结果"}，系统会在身边找到能这样做的东西去做，不用再写 object_id 和 interaction_id。'
            : '',
        '家人这次说的做法和这里记的不一样，以家人这次说的为准，并在 learned 里写下新的做法。',
        '家人指出你记的某个做法是错的（比如“睡觉不是用衣柜”“不对，那样不行”），在 unlearn 里写上那条做法，系统会把它忘掉、以后不再那样做；家人同时说了对的做法，就也写进 learned。只有家人明确说错了才写，自己没做成不算。',
        lines
    ].filter(Boolean).join('\n') + '\n';
}

// Emergencies and turning points of the household (incidents.js), above everything else: a person
// in a fire thinks of nothing but the fire.
function incidentBlock(snap) {
    const list = snap.incidents || [];
    if (!list.length) return '';
    const t = terms(snap);
    const minor = isMinorGroup(snap.partner.ageGroup);
    const lines = ['【家里正在发生、刚发生的大事】（游戏里真的发生了，比聊天记录和其他一切都重要）'];
    for (const i of list) for (const l of i.lines) lines.push(l);
    if (list.some((i) => i.active && i.grave)) {
        lines.push('这件事压过其他一切，你此刻心里只有它：先顾人的安全，别的都往后放。');
        lines.push(isTeenGroup(snap.partner.ageGroup)
            ? '你还没成年：再酷这时也会慌，别扭全收起来，第一时间找' + t.call + '，说清你在哪、你怎么样，问' + t.them + '该怎么办，照' + t.them + '说的做。话很短、很急，不讲大道理。'
            : minor
            ? '你还是个孩子：会害怕、会慌，第一时间找' + t.call + '，告诉' + t.them + '你在哪、你怎么样，问' + t.them + '该怎么办；' + t.call + '让你怎么做你就照做。话很短、很急，可能带哭腔，不讲大道理。'
            : '你是大人：先确认' + t.call + '和家里其他人安不安全，说清你这边的情况（你在哪、在做什么），需要时果断地说该怎么做。话短、急，不寒暄。');
        lines.push('躲开、灭火、等救援这些，游戏里的人物会自己去做。actions 写空数组，不要安排任何日常的事（吃饭、玩、做家务、学习……）；之前答应要做的事也先放下，等这件事过去再说，promises 也不要写新的。');
        lines.push('只说上面写着的情况，不要编出没写的细节（谁受了伤、烧了什么、损失多少）。' + t.call + '问到你不知道的，就说不知道、没看清。');
    } else if (list.some((i) => i.active)) {
        lines.push('这件事还在持续，会影响出门、身体和心情。聊天、做决定时把它考虑进去，自然地关心一句或提醒一句，不用每句都提。');
    } else {
        const has = (re) => list.some((i) => re.test(i.kind));
        if (has(/^(fire|accident)$/)) {
            lines.push('火灾、车祸这样的事刚过去不久，你心里还没缓过来：会后怕、会想起当时的情形，想要' + t.call + '的安慰，也会反过来关心' + t.them + '。');
        }
        if (has(/^zoi\.(died|pregnancy_cancel)$/)) {
            lines.push('失去家人是让人很难过的事：你会伤心、会想念，想和' + t.call + '待在一起、互相安慰。语气低落、真实，不要轻描淡写，也不要强颜欢笑。');
        }
        if (has(/^zoi\.divorced$/)) {
            lines.push('有人离婚，家里的气氛会沉下来：你在意当事人的心情，说话小心一些，不去追问细节。');
        }
        if (has(/^(disaster|zoi\.(born|pregnancy_begin|growth_changed|married))$/)) {
            lines.push('这是家里的大事，你心里还惦记着，会想跟' + t.call + '说起、分享你的心情。');
        }
        lines.push('按你的身份和你们的关系自然地提起或回应它，不要像什么都没发生过；但也别每句话都绕着它，别重复刚说过的话。');
    }
    return lines.join('\n') + '\n';
}

// What moves while the game runs: today's ages, the job, how the household is made up and the
// numbers between two people. These were in the system block, which meant the provider's prefix
// cache was thrown away the moment a relationship moved a point or a birthday passed. Nothing is
// dropped: the same lines are here, in the user message, a few lines above what she is doing now.
function factsBlock(snap, cfg) {
    const t = terms(snap);
    const p = snap.partner;
    const wp = snap.player;
    const lines = ['【今天的样子】'];
    lines.push('你：' + [isMale(p.gender) ? '男' : p.gender ? '女' : '', p.age ? String(p.age) : '', isMinorGroup(p.ageGroup) ? '' : (p.job ? '职业 ' + p.job + (p.rankName ? '（' + p.rankName + '）' : '') : '无业')].filter(Boolean).join('，') + '。');
    lines.push(t.call + '：' + wp.name + '，' + [isMale(wp.gender) ? '男' : '女', wp.age ? String(wp.age) : '', wp.job ? '职业 ' + wp.job : ''].filter(Boolean).join('，') + '。');
    if (snap.others && snap.others.length) {
        lines.push('家里其他人：' + snap.others.map((m) => m.name + '（' + [m.label ? t.call + '的' + m.label : '', m.age].filter(Boolean).join('，') + '）').join('；') + '。');
    }
    const ages = ageBlock(snap, t);
    if (ages) lines.push(ages);
    const rel = snap.relationship || {};
    const relParts = [];
    if ((snap.role === 'spouse' || snap.role === 'romance') && typeof rel.Romance === 'number') relParts.push('爱情 ' + rel.Romance);
    if (snap.role === 'colleague' && typeof rel.Business === 'number') relParts.push('工作 ' + rel.Business);
    if (typeof rel.Family === 'number' && (!snap.outsider || snap.role === 'relative')) relParts.push('亲情 ' + rel.Family);
    if (typeof rel.Friendship === 'number') relParts.push('友情 ' + rel.Friendship);
    if (relParts.length) lines.push('你对' + t.call + '的感情值（0~100）：' + relParts.join('，') + '。' + (snap.outsider ? outsiderCloseness(rel) : closenessText(snap, t)));
    return lines.join('\n');
}

// Stable prefix first so DeepSeek can cache it across turns for the same person.
function promptParts(input) {
    const { snap, cfg, memory, diary, catalog, now } = input;
    const mem = memoryBlock(memory);
    const blocks = {
        persona: personaBlock(snap, cfg),
        schema: actionsBlock(catalog, snap, cfg.actions, 'schema'),
        rules: rulesBlock(snap, cfg)
    };
    const stable = [blocks.persona, '', blocks.schema, '', blocks.rules].join('\n');
    // Slow to fast, because the provider caches a *prefix*: whatever comes after the first line
    // that changed is paid for again. The catalog is the biggest block and stays byte-identical
    // while she stands still, so it goes first; the clock, her body and the room go last.
    Object.assign(blocks, {
        incident: incidentBlock(snap),
        catalog: actionsBlock(catalog, snap, cfg.actions, 'live'),
        memory: mem ? '【记忆】\n' + mem : '',
        knowhow: knowhowBlock(snap),
        story: snap.storyBlock || '',
        legacy: snap.legacyBlock || '',
        ties: snap.tiesBlock || '',
        facts: factsBlock(snap, cfg),
        situation: '【此刻】\n' + situationBlock(snap, diary, now),
        self: selfBlock(snap),
        scene: sceneBlock(snap),
        rooms: roomsBlock(snap)
    });
    const live = ['incident', 'catalog', 'memory', 'knowhow', 'story', 'legacy', 'ties', 'facts', 'situation', 'self', 'scene', 'rooms']
        .map((k) => blocks[k]).filter(Boolean).join('\n');
    // Characters per block, for the prompt-size line in the log.
    const sizes = {};
    for (const k of Object.keys(blocks)) if (blocks[k]) sizes[k] = blocks[k].length;
    return { stable, live, sizes };
}

function systemPrompt(input) {
    const p = promptParts(input);
    return p.stable + '\n\n' + p.live;
}

const CLASS_GROUP_RULE = '9. 这是你们班的班级群，群里都是同班同学，没有家长和老师：气氛活跃，爱起哄、接梗、互损、刷屏。聊作业答案、考试、老师、食堂、八卦、放学去哪、追的剧和游戏。' +
    '可以只发一个词或一个表情（“笑死”“+1”“？？”“救命”），可以@人。别客气、别像大人、别总结。还是按你的性格：话少的偶尔冒一句，话多的才刷屏；可以开玩笑，但不欺负、不孤立谁。';

// Prompt for one line in a group chat (groups.js). Deliberately much shorter than replyPrompt:
// a group needs who is here, what was just said and a reason to speak, not the action catalogue
// or the room. Nothing she can *do* is offered — a group message is speech only.
function groupPrompt(input) {
    const { snap, cfg, group, roster, history, job } = input;
    const t = terms(snap);
    const speaker = String(snap.partner.entity_id);
    const where = [snap.partner.site ? '在' + snap.partner.site : '', snap.partner.activity && (snap.partner.activity.name || snap.partner.activity.id) ? '正在' + (snap.partner.activity.name || snap.partner.activity.id) : ''].filter(Boolean).join('，');
    const system = [
        personaBlock(snap, cfg),
        '',
        factsBlock(snap, cfg),
        '',
        '【这是群聊，不是一对一】',
        '1. 群里除了' + t.call + '还有别人，你说的话所有人都看得见。',
        '2. 一次只说一两句，短。不要每条都接；没什么可说就返回空 messages，让别人说。',
        '3. 不必每句都对着' + t.call + '说，可以对群里别人说，也可以只是插一句。',
        '4. 要点名谁，就在 at 里写那个人的编号；不点名就别写，最多点一个人。',
        '5. 别重复别人刚说过的话，别总结，别当主持人，别替别人回答。',
        '6. 只说你自己知道的：别人此刻在做什么、在哪，你只能从上面的群聊里看出来。',
        '7. 不说旁白和括号动作，不提游戏、AI、代号。',
        '8. 一条只有一句话，20 个字以内，不换行、不分点、不解释、不总结。像群里随手发的一条。' + aitone.RULE_TEXT,
        // A class chat (classgroup.js) is all schoolmates: loud, not the family's quiet teenager.
        ...(group && group.kind === 'class' ? [CLASS_GROUP_RULE] : []),
        ...(isTeenGroup(snap.partner.ageGroup) && !(group && group.kind === 'class') ? ['9. 你是群里的青少年：有爸妈、长辈在的群里话更少，多半回一两个字，或者干脆不说；被当众问成绩、叫小名、晒你小时候会尴尬、想躲；只有聊到你在乎的事，或者跟兄弟姐妹斗嘴时才多说两句。'] : []),
        '',
        '只输出 JSON：{"messages":["一两句"],"at":["编号"]}。不说就给空数组。'
    ].join('\n');
    const quote = job && job.quote ? history.find((h) => h.id === String(job.quote)) : null;
    const reasons = [];
    // Something the speaker has to answer (workgroup.js: the boss handed them a task): never silence.
    if (job && job.duty) reasons.push(String(job.duty) + '这次 messages 不能是空的。');
    else if (job && job.why === '点了名') reasons.push(t.call + '在群里点了你的名，你在群里回' + t.them + '一句。');
    else if (job && job.why === '被引用') reasons.push(t.call + '引用了你刚才说的那句，你在群里回一句。');
    else if (job && job.topic) reasons.push('你想在群里起个话头：' + job.topic + '。就一句，像随手发的，这次 messages 不能是空的。');
    else if (job && job.kind === 'auto' && group && group.kind === 'class') reasons.push('群里刚有人在聊。你想接梗、起哄、吐槽或者补一句就说，没兴趣就返回空。');
    else if (job && job.kind === 'auto') reasons.push('群里安静了一会儿。你想接着说就说一句，不想说就返回空。');
    else reasons.push('群里刚有人说话。你想接就接一句，不想接就返回空。');
    if (quote) reasons.push('被引用的那句是「' + String(quote.text).slice(0, 80) + '」（' + (quote.name || t.call) + '说的）。');
    const eaten = mealsText(snap.partner.meals, snap.env, snap.partner.needs, snap.partner.mealsSince);
    const lines = [
        '【群】' + group.name + (where ? '（你此刻' + where + '）' : ''),
        ...(eaten ? [eaten] : []),
        '【群里的人】'
    ];
    for (const m of roster) {
        const bits = [];
        if (m.label) bits.push(t.call + '的' + m.label);
        if (m.site) bits.push('在' + m.site);
        if (m.activity) bits.push('正在' + m.activity);
        lines.push('- ' + (m.name || m.id) + '（编号 ' + m.id + '）' + (bits.length ? '，' + bits.join('，') : ''));
    }
    lines.push('', '【最近的群聊】');
    if (!history.length) lines.push('（还没有人说话）');
    for (const h of history) {
        // Written by someone other than the one this turn answers: name them.
        const who = h.player ? t.call : (h.name || '某人');
        const at = Array.isArray(h.to) && h.to.indexOf(speaker) >= 0 ? '@你 ' : '';
        const mark = quote && h.id === quote.id ? '（被引用的那句）' : '';
        // What a line answers, so everyone — not only the quoted author — knows what it is about.
        const target = h.replyTo ? history.find((x) => x.id === String(h.replyTo)) : null;
        const re = target ? '（回复' + (String(target.from) === speaker ? '你' : (target.player ? t.call : (target.name || '某人'))) + '「' + String(target.text).slice(0, 30) + '」）' : '';
        lines.push(who + '：' + at + re + h.text + mark);
    }
    lines.push('', '【这次该你说】' + reasons.join(' '));
    return { system, user: lines.join('\n') };
}

// What the character had in mind with its last message (daemon deliver, st.lastThought): the
// answer to a riddle it set, what the "something" it hinted at was. Without it the next reply is a
// new mind that reads the player's guess as an accusation out of nowhere.
function lastThoughtLine(snap, t) {
    const th = snap && snap.lastThought;
    if (!th || !th.text) return '';
    return '【你上一条消息发出时心里想的】（' + t.call + '看不到）你当时说的是「' + (th.said || '') + '」，心里想的是：' + th.text +
        '\n' + t.call + '这次的话很可能就是在接你那条：你出了题，' + t.them + '是在猜，就照你心里的答案说猜对没有；你卖了关子，' + t.them + '是在问，就接着逗或者揭晓。别把' + t.them + '的猜测当成指责，也别忘了你自己起的头。\n';
}

// Prompt for answering the pending texts.
function replyPrompt(input) {
    const { snap, history, pending, now } = input;
    const t = terms(snap);
    const p = promptParts(input);
    const user = [
        p.live,
        objectFocus.prompt(snap.objectFocus),
        '',
        '最近的聊天记录：',
        transcript(history, snap, now),
        '',
        lastThoughtLine(snap, t),
        t.call + '刚发来、你还没回的消息：',
        pending.map((m) => '[' + msgTime(m, snap.env) + '] ' + m.text).join('\n'),
        input.photoCount ? '这些消息里的 [Photo] 对应随请求发来的实际图片，按消息顺序排列。看清图片里的主体、场景、文字和细节，结合对应的文字说明（如有）自然回应；不要只说“收到了图片”，也不要假装没看见。' : '',
        '',
        '用你自己的口气回。',
        '请以 JSON 回复。'
    ].join('\n');
    return { system: p.stable, user, sizes: Object.assign({ history: transcript(history, snap, now).length }, p.sizes) };
}

// Prompt for a message the character sends on their own initiative.
function proactivePrompt(input) {
    const { snap, history, reason, now } = input;
    const t = terms(snap);
    const p = promptParts(input);
    if (input.urgent) {
        return {
            system: p.stable,
            user: [
                p.live,
                '',
                '最近的聊天记录：',
                transcript(history, snap, now),
                '',
                '现在' + t.call + '没有发新消息，但是：' + reason + '。',
                '马上给' + t.them + '发一两条很短的消息：这件事、你现在怎么样，还有你此刻最想对' + t.them + '说的话。用【你这个人】的口气，恐慌、冷静、哭腔还是发懵，都按性格来。',
                '不要寒暄，不要提别的事，不要重复聊天记录里你已经说过的话。这次 messages 不能是空数组。',
                '请以 JSON 回复。'
            ].join('\n')
        };
    }
    const user = [
        p.live,
        '',
        '最近的聊天记录：',
        transcript(history, snap, now),
        '',
        '现在' + t.call + '没有发新消息。你此刻身上和身边的事：' + reason + '。',
        '这些不是指令，只是你此刻的处境。真人主动发微信，是因为有' + t.them + '不知道、又会在意的事：外面遇到的人和事、一个八卦、一个要' + t.them + '拿主意的选择、一个真需要' + t.them + '的请求、一个约定或计划。',
        '不要汇报你正在做什么、刚做完什么（弹琴、画画、洗碗、吃饭这些），' + t.call + '多半看得见；不要为了找话而发。',
        '发出去的话要让' + t.them + '有东西可接：一个具体的问题、一个能二选一的事、一点' + t.them + '会好奇的新鲜事。不要只是感叹或抒情。',
        '不要催' + t.them + '回复，不要说"你人呢""怎么不理我""别装没看见"这类话。',
        '以前的事和纪念（一起做过的事、送过的东西、一段回忆）很少拿出来说：聊天记录里你最近已经提过的，就别再提。',
        input.others && input.others.length
            ? '家里其他人这几个小时已经跟' + t.them + '说过这些，别再说同一件事，也别换个说法重复：\n' + input.others.map((o) => '- ' + (o.name ? o.name + '：' : '') + o.text).join('\n')
            : '',
        '先在 think 里想：你的性格和此刻心情会让这句话怎么说；你们刚才聊过什么；【家里现在的情况】里有什么值得说；你此刻最想跟' + t.them + '说的那一句。',
        '身上的小事（想上厕所、想洗澡、有点饿）你自己能处理，就自己去做（写 actions），想说就顺口提一句，不用为它专门求' + t.them + '。',
        snap.storyBlock ? '【你自己的心事】里的事也可以是你发消息的理由：透露一点、试探一句、忍不住问一下，按那里说的分寸来，不要每次都提。' : '',
        snap.tiesBlock ? '【心里的疙瘩】【你和家里其他人】里的事也可以是理由：跟' + t.them + '告个状、抱怨一句、夸家里谁一句、请' + t.them + '帮忙说和；还在生' + t.them + '的气时，也可以不主动找' + t.them + '（messages 为空），或者发一句别扭的话。' : '',
        '一两条短消息，说一件事，用【你这个人】的口气。',
        // A text the character has decided on (suitor.js): it goes out, it is not reconsidered.
        input.mustSend
            ? '这条消息你已经决定要发了：messages 不能是空数组，一定要发，内容要和聊天记录里你刚说过的不一样。'
            : '这几种情况 messages 返回空数组：要说的和聊天记录里刚说过的、或者家里其他人刚说过的意思重复；只是在汇报眼前的动作；你此刻明显不方便发消息（睡着了、正忙得腾不开手）；没有一件' + t.them + '会想接的事。宁可不发。',
        '请以 JSON 回复。'
    ].join('\n');
    return { system: p.stable, user, sizes: Object.assign({ history: transcript(history, snap, now).length }, p.sizes) };
}

// Something the character set out to do did not happen. It tells the player in its own voice,
// the way a person would text "I can't find the vacuum, what should I use?", so the player can
// steer instead of watching nothing happen.
function setbackPrompt(input) {
    const { snap, history, setbacks, now } = input;
    const t = terms(snap);
    const p = promptParts(input);
    const user = [
        p.live,
        '',
        '最近的聊天记录：',
        transcript(history, snap, now),
        '',
        progressLines(input.progress, snap.env) ? '这之前，下面这些已经做成了（游戏确认的），一起告诉' + t.them + '：\n' + progressLines(input.progress, snap.env) + '\n' : '',
        '你刚才想做、或者答应' + t.call + '要做的事，没做成：',
        setbacks.map((x) => '- 「' + x.what + '」：' + x.why + '（' + noteAgo(x, snap.env) + '）').join('\n'),
        '',
        t.call + '还不知道这件事没做成。像真实的人那样发消息告诉' + t.them + '：哪件事没做成、卡在哪里。',
        '照上面写的原因如实说，用你在生活里会用的说法：没找到能用的东西、不知道该怎么弄、做到一半被打断了……不要提游戏、系统、程序、指令、代号这些词，括号里的英文代号只是给你理解用的。',
        '不要编原因或查找过程：上面没写东西坏了，就不能说坏了、卡住了、没反应、打不开；没有实际走动的证据，不能说转了一圈、到处找过。若只是查询或安排没完成，就说这件事还没做起来，不把它说成找不到东西，也不要归咎于对方没帮忙。',
        '然后问' + t.them + '该怎么办，或者说出你想到的别的办法，让' + t.them + '帮你拿主意。清单里如果有别的做法确实能做到，也可以直接去做（写进 actions），并在消息里说一声。',
        '一两条消息，用【你这个人】的口气告诉' + t.them + '。不要重复刚才已经说过的话。',
        '请以 JSON 回复。'
    ].join('\n');
    return { system: p.stable, user };
}

function progressLines(list, env) {
    const items = (list || []).filter((p) => p && p.done);
    if (!items.length) return '';
    return items.map((p) => '- 做完了：' + p.done + (p.next ? '；接着去做：' + p.next : '；这件之后没有别的要做了') + '（' + noteAgo(p, env) + '）').join('\n');
}

// A step of what the character is doing for the player was done. The next step is already
// under way; the text only says so.
function progressPrompt(input) {
    const { snap, history, progress, now } = input;
    const t = terms(snap);
    const p = promptParts(input);
    const user = [
        p.live,
        '',
        '最近的聊天记录：',
        transcript(history, snap, now),
        '',
        '你在做' + t.call + '让你做、或者你答应' + t.them + '的事。游戏里刚确认了进展：',
        progressLines(progress, snap.env),
        '',
        t.call + '看不到你这边，还不知道。像真实的人那样发一条短消息告诉' + t.them + '：哪件做完了，现在去做哪件；全做完了就说做完了。',
        '只说上面写的进展，不添没发生的结果。「接着去做」的那件刚开始，还没做完，只能说正在去做、这就去。',
        '一两句，用【你这个人】的口气，可以带一点当时的心情。不要提游戏、系统、程序这些词。聊天里刚说过的不要再说一遍。',
        '这条消息只报进展，actions 和 promises 写空数组，手上的事会接着做。',
        '请以 JSON 回复。'
    ].join('\n');
    return { system: p.stable, user };
}

function actionCatalog(catalog) {
    const lines = [];
    const chores = (catalog && catalog.chores) || [];
    const objects = (catalog && catalog.objects) || [];
    if (chores.length) {
        lines.push('在家家务（object_id 写 "self"）：');
        for (let i = 0; i < chores.length; i++) lines.push('  ' + chores[i].id + '｜' + chores[i].name);
    }
    if (objects.length) {
        const held = objects.filter((o) => o.held);
        const pocket = objects.filter((o) => o.pocket);
        const roomObjects = objects.filter((o) => !o.pocket && !o.held);
        for (let i = 0; i < held.length; i++) {
            const o = held[i];
            lines.push('手上拿着的东西：');
            lines.push('物件 ' + o.id + '｜' + o.name + '（拿在手上）');
            for (let j = 0; j < o.actions.length; j++) lines.push('  ' + describeAction(o.actions[j]));
        }
        if (pocket.length) {
            lines.push('背包里的东西（在身上）：');
            for (let i = 0; i < pocket.length; i++) {
                const o = pocket[i];
                lines.push('物件 ' + o.id + '｜' + objLabel(o));
                for (let j = 0; j < o.actions.length; j++) lines.push('  ' + describeAction(o.actions[j]));
            }
            lines.push('拿出来接着用它做事（吃、喝、干活），直接选它下面那条做法；要拿出来再放到某处，选「取出」，want 写完整的要求，拿到手上以后会接着放好。');
        } else if (catalog && catalog.pocketEmpty) {
            lines.push('背包现在是空的。');
        }
        if (roomObjects.length) {
            lines.push('身边的东西：');
            for (let i = 0; i < roomObjects.length; i++) {
                const o = roomObjects[i];
                lines.push('物件 ' + o.id + '｜' + objLabel(o));
                for (let j = 0; j < o.actions.length; j++) lines.push('  ' + describeAction(o.actions[j]));
            }
        }
    } else if (catalog && catalog.pocketEmpty) {
        lines.push('背包现在是空的。');
    }
    const more = (catalog && catalog.more) || [];
    if (more.length) lines.push('其他已扫描到的物品（只列名字，要用就写 want；可能尚未查动作或当前没有可用动作）：' + more.map((o) => o.id + '｜' + objLabel(o)).join('、'));
    return lines.join('\n');
}

// From everything on the lot, the few objects this job is done with. Names only; the actions
// on them are read from the game afterwards.
// The want line is the character's own short note and can be too narrow or name a half-way step
// ("open the fridge and look"); every step that turns it into a real action reads it against
// what it is for.
const PURPOSE_RULE = '角色自己记下的那句简短说法，可能写得太窄，或者写成了中间步骤（比如「打开看看」）。自己答应的话也可能只是过程（比如「再试试」）。以这件事真正的目的为准：对方为什么开口、要的是什么、做完谁得到什么。能实现这个目的的做法就是对的，哪怕和那句话字面不一样、路径不一样。对方原话里点明了要怎么做（用哪样东西、做什么），以对方说的为准，那句说法和它对不上时听对方的。';

const GOAL_FIELD = '"goal":"先写：这件事最终要让谁得到什么（比如谁吃上饭、哪里变干净、什么被关掉），一句话，只写结果，不写开门、查看、再试一次这类过程"';

function purposeLines(input, snap) {
    const t = terms(snap);
    const ctx = input.ctx || {};
    const earlier = (ctx.earlier || []).map((m) => (m.mine ? snap.partner.name : t.call) + '：' + m.text).join('\n');
    const scene = sceneLines(snap, true);
    const rooms = roomsBlock(snap, true);
    return [
        scene.length ? '此刻的现场（' + snap.partner.name + '是' + (snap.partner.age || '') + '）：\n' + scene.join('\n') + '\n' + SCENE_FIRST : '',
        rooms,
        earlier ? '之前的聊天：\n' + earlier : '',
        t.call + '刚说的：' + (ctx.asked || '（没有）'),
        snap.partner.name + '回复：' + (ctx.said || '（没有）'),
        ctx.promise ? snap.partner.name + '答应了：' + ctx.promise : '',
        snap.partner.name + '自己记下的简短说法（可能写偏，仅供参考）：' + input.want
    ].filter(Boolean);
}

// What happens to a thing once it is in the hand, chosen before it is taken: the game puts
// away whatever an idle hand holds within a second or two.
function afterTakePrompt(input) {
    const snap = input.snap;
    const uses = input.uses || [];
    const lines = (input.objects || []).map((o) => o.id + '｜' + o.name + (o.room ? '［' + o.room + '］' : '') + (typeof o.meters === 'number' && o.meters ? '（约 ' + Math.round(o.meters) + ' 米）' : ''));
    const system = [
        snap.partner.name + '要' + (input.fromBag ? '从背包里拿出' : '拿起') + '「' + input.item + '」。你帮他决定拿到手上以后接着做什么，好让这件事按对方的意思做完。',
        '手上拿着东西却没事可做，游戏会马上把它收回去，所以必须选一样接着做的事。',
        uses.length ? '这件东西拿在手上时，游戏给的做法（next 写编号）：\n' + uses.map((a) => a.id + '｜' + a.name).join('\n') : '这件东西拿在手上时，游戏没有给别的做法，只能放下。',
        '要把它放到某件家具或东西那里，next 写 "place"，target_id 写那件东西的物件ID；relation 写 "on"（放在它上面：桌上、架子上、台子上）或 "near"（放在它下面、旁边、跟前、门口的地上）。门口、门边指大门那一带，清单里有门也可以选门。',
        '对方只是要拿出来、看看、找出来，没说接着做什么，next 写 "here"，就在身边放下。',
        '按对方的原话选：要吃就选吃的做法，要用它做什么就选那个做法，要放到某处就选 place。不要选和原话无关的做法。',
        '只输出 JSON：{"next":"做法编号|place|here","target_id":"","relation":"on|near","why":""}'
    ].join('\n');
    const user = [
        '要做的事：' + (input.want || '（没说）'),
        '东西：' + input.item,
        '身边的家具和东西（物件ID｜名称［房间］）：',
        lines.length ? lines.join('\n') : '（清单是空的）'
    ].join('\n');
    return { system, user };
}

function wantObjectsPrompt(input) {
    const snap = input.snap;
    const tried = input.tried || [];
    const lines = [];
    let withActions = false;
    for (let i = 0; i < input.objects.length; i++) {
        const o = input.objects[i];
        const acts = Array.isArray(o.actions) ? o.actions.map((a) => (typeof a === 'string' ? a : a && a.name)).filter(Boolean) : [];
        if (acts.length) withActions = true;
        lines.push(o.id + '｜' + objLabel(o) + (o.count > 1 ? '（这里共 ' + o.count + ' 件）' : '') + (o.meters ? '（大约 ' + o.meters + ' 米）' : '') +
            (Array.isArray(o.near) && o.near.length ? '（旁边：' + o.near.join('、') + '）' : '') +
            (acts.length ? '：' + acts.join('、') : '') +
            (o.pocket ? '。这件在背包里，「取出」就是从背包拿出来拿到手上' : '') +
            (o.held ? '。这件已经拿在这个人手上' : ''));
    }
    const places = input.places || [];
    const people = input.people || [];
    const t = terms(snap);
    const peopleLines = people.map((p) => {
        const who = p.player ? t.call + '（' + p.name + '，正在和你发消息的人）' : p.name + '（' + [p.label ? t.call + '的' + p.label : '', p.age].filter(Boolean).join('，') + '）';
        return p.ref + '｜' + who + (p.here ? '，在这里' : '，不在这里');
    });
    // Going out together needs the player there to walk with.
    const together = !!(input.together && snap.together);
    const system = [
        '你帮' + snap.partner.name + '判断，要做下面这件事得用哪件东西，或者要去哪里。',
        '先看现场：这件事要的结果，现场是不是已经有现成的（做好的饭菜、对方点名的东西、正摆在那里的东西）。有就选它，不要另找别的来代替。',
        '从清单里选出最可能用得上的东西，最多 6 件，最相关的放前面。这件事牵涉到的东西都要选上：被拿、被吃、被收起来、被打开或关掉的那样东西本身，以及要用到、要放进去的那件东西。游戏里的做法常常就在被处理的那样东西上。只是摆着它们的家具、旁边沾边的东西不要选。',
        withActions ? '每件东西后面是游戏里它能做的事（只列了常用的一部分）。按这些做法判断哪件东西真能办成这件事，不要只看名字像不像。' : '',
        '对方的叫法常常和清单里的名字不一样：口语、别称、大类、品牌都有（比如说的是「电子琴」，清单里写的可能是「合成器」）。按它是什么东西、能拿来做什么去对清单，对上了就选那件；find 也写清单里的那个名字。',
        '「在某某旁边」「靠近某某」「某某那里」说的是位置，某某不是要找的东西：选那附近（看「旁边：」）、符合说法的那件，不要选某某本身。',
        input.objects.some((o) => o && o.pocket) ? '写着「在背包里」的东西在这个人身上。要从包里拿出来，就选这件，做法是「取出」。' : '',
        input.pocketEmpty ? '这个人的背包是空的。' : '',
        input.objects.some((o) => o && o.held) ? '写着「拿在手上」的东西已经在手上，不用再找、再取、再捡，find 写空字符串。要把它放到某处，就选它本身（放置做法在它上面），再选要放过去的那件家具。' : '',
        PURPOSE_RULE,
        tried.length ? '这些已经看过、上面没有合适的做法，不要再选：' + tried.join('、') + '。' : '',
        knowhowLines(snap) ? snap.partner.name + '以前学会的做法，遇到同样的事就选那件东西：\n' + knowhowLines(snap) : '',
        places.length ? '这件事要出门去别的地方才能做（出去玩、去上学、去公园、去上班、去买东西），就在 place_id 写那个地点，object_ids 留空数组；在这里就能做，place_id 写空字符串。' : '',
        '清单里没有相关的东西' + (places.length ? '、也不用去别处' : '') + '，就返回空数组。',
        peopleLines.length ? 'for：这件事是替谁做、做给谁的（端饭给谁、给谁拿吃的、给谁做饭），写下面「人」里的编号；是' + snap.partner.name + '自己的事，写空字符串。' : '',
        'find：这件事是要找到某样东西（找钥匙、找手机、看看某样东西在哪），写那样东西的名字，object_ids 把清单里最像的那件放第一个；不是找东西写空字符串。',
        together ? 'together：' + t.call + '要' + snap.partner.name + '跟着一起走、一起出门、陪着去某处，写 true；只是' + snap.partner.name + '自己去，写 false。lead：' + t.call + '这次亲口要' + snap.partner.name + '带路去 place_id 那个地方，写 true；跟在' + t.call + '后面走，写 false。' : '',
        '只输出 JSON：{' + GOAL_FIELD + ',"why":"",' + (places.length ? '"place_id":"",' : '') + '"object_ids":["物件ID"]' +
            (peopleLines.length ? ',"for":""' : '') + ',"find":""' + (together ? ',"together":false,"lead":false' : '') + '}。why：要达到这个结果得用什么样的东西' + (places.length ? '或去哪里' : '') + '，清单里哪几件是，一两句话。',
        '',
        '清单（物件ID｜名称' + (withActions ? '：能做的事' : '') + '）：',
        lines.join('\n'),
        places.length ? '\n地点（place_id｜名称）：\n' + places.map((p) => p.id + '｜' + p.name).join('\n') : '',
        peopleLines.length ? '\n人（编号｜是谁）：\n' + peopleLines.join('\n') : ''
    ].filter(Boolean).join('\n');
    const user = purposeLines(input, snap).concat(['请只输出 JSON。']).join('\n');
    return { system, user };
}

// The words in a request that match no name on the lot, matched by meaning to the game's names.
function meantNamesPrompt(input) {
    const system = [
        '家里东西的名字是游戏给的，人说话用的是自己的叫法。下面每个词，判断它指的是名字清单里的哪一样东西。',
        '按东西是什么、拿来做什么去对：别称、口语、大类、品牌、外形描述都算（「电子琴」「琴」「键盘」可以是「合成器」；「电视机」是「电视」）。',
        '对不上任何一样，就写空字符串，不要硬凑。名字要和清单里的一字不差。',
        '只输出 JSON：{"names":{"词":"清单里的名字"},"why":"一句话"}'
    ].join('\n');
    const user = [
        '这件事：' + (input.want || ''),
        '要对的词：' + input.words.join('、'),
        '名字清单：' + input.names.join('、'),
        '请只输出 JSON。'
    ].join('\n');
    return { system, user };
}

// Does the chosen action actually lead to the result the character is after?
function wantCheckPrompt(input) {
    const snap = input.snap;
    const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
    const system = [
        '你把一道关：' + snap.partner.name + '马上要做一个具体动作，你只拦下明显做错的。',
        goal ? '要达到的结果已经结合对方原话想好了，就按它判断，不要自己重新解释对方的意思。' : PURPOSE_RULE,
        '用生活常识想这个动作做完以后实际会发生什么、谁得到了什么。游戏里一个做法常常包含好几步（比如在冰箱上「烹饪」，会自己取冰箱里的食材、下锅、做出饭菜），按整件事做完的结果判断。',
        '只有这四种写 false：做完明显达不到结果；方向相反（要放进去却是拿出来，要关却是开）；做完得到好处的是别人而不是该得到的人；现场已经有为这件事准备好、或者对方明显指的那样东西，这个动作却撇开它另用别的（why 里写出现场那样东西的名字）。说得通、能达到大半、或者你拿不准，都写 true：宁可先做，让对方看到了再纠正，也不要什么都不做。',
        '游戏里做法的名字常常只有两三个字，是对那件东西做的事；内部 ID 是游戏的英文名，也能帮你看懂。',
        input.interaction && input.interaction.pocket ? '这个动作是从背包里把东西拿出来拿到手上。对方还要放到外面或桌子上时，这一步仍然写 true。' : '',
        '只输出 JSON：{' + (goal ? '' : GOAL_FIELD + ',') + '"ok":true,"why":"一句话"}'
    ].join('\n');
    const user = purposeLines(input, snap).concat([
        goal ? '要达到的结果：' + goal : '',
        '选的动作：对「' + input.objectName + '」做「' + describeAction(input.interaction) + '」',
        '请只输出 JSON。'
    ]).filter(Boolean).join('\n');
    return { system, user };
}

// Turns one thing the character means to do into one real action from the object's full list.
function wantPrompt(input) {
    const snap = input.snap;
    const lines = [];
    for (let i = 0; i < input.candidates.length; i++) {
        const o = input.candidates[i];
        lines.push('物件 ' + o.id + '｜' + objLabel(o) + (o.meters ? '（大约 ' + o.meters + ' 米）' : ''));
        for (let j = 0; j < o.actions.length; j++) lines.push('  ' + describeAction(o.actions[j]));
    }
    const system = [
        '你帮' + snap.partner.name + '把一件要做的事，落实成游戏里身边某件东西上的一个具体做法。',
        '从下面的清单里选最贴切的一条。object_id 和 interaction_id 必须原样抄写。',
        '游戏里做法的名字常常只有两三个字，是对它所在的那件东西做的事。按生活常识想清楚每条做完以后那件东西会怎样，内部 ID 是游戏的英文名，也能帮你看懂。',
        '看每条做法的结果：做完以后谁得到了什么，要和这件事真正的目的对上，不要只看字面像不像。',
        PURPOSE_RULE,
        '清单里确实没有能实现这个目的的做法，两个字段都写空字符串，不要硬选一个不相干的。',
        knowhowLines(snap) ? snap.partner.name + '以前学会的做法，遇到同样的事优先照这个选：\n' + knowhowLines(snap) : '',
        '只输出 JSON：{' + GOAL_FIELD + ',"why":"","object_id":"","interaction_id":""}。why：哪条做法做完能达到 goal，或者为什么一条都不能，一两句话。',
        '',
        '清单：',
        lines.join('\n')
    ].filter(Boolean).join('\n');
    const user = purposeLines(input, snap).concat(['请只输出 JSON。']).join('\n');
    return { system, user };
}

// After the game swaps the bag id: still the same job, or something else took over?
function sameTaskPrompt(input) {
    const step = (s) => '「' + (s.name || s.id) + '」（游戏内部 ID：' + s.id + '）' + (s.on ? '，对着「' + s.on + '」' : '');
    const system = [
        '你判断游戏里一个角色此刻在做的动作，是不是还在完成之前安排给' + (input.actorName || '它') + '的那件事。',
        '游戏里的一件事常常分好几步，游戏会自己接着做下一步。下一步的名字和最初的动作不一样，对着的东西也可能换了，这些都还是同一件事。',
        '现在做的是和那件事无关的另一件事，就算不是。',
        '内部 ID 是游戏的英文名，也能帮你看出它属于哪件事。',
        '只输出 JSON：{"same":true,"why":"一句话"}'
    ].join('\n');
    const user = [
        '安排的事：' + step(input.asked),
        input.want ? '想要的结果：' + input.want : '',
        '现在在做：' + step(input.now),
        '请只输出 JSON。'
    ].filter(Boolean).join('\n');
    return { system, user };
}

const COMMIT_RE = /我来|我这就|我先|我去|我马上|马上就|这就去|我收拾|我洗|我扫|我吃|我拿|我过去|我回家|我打扫|我弄|我做|我煮/;
// "这首还有半分钟", "弹完就来": finishing what is in hand first is a later too.
const LATER_RE = /等一?会|等一?下|一会就|忙完|做完再|吃完再|完就来|完再来|完就去|完再去|还有半?[一二两三几\d]*分钟/;
const ORDER_RE = /打扫|扫地|拖地|吸尘|洗碗|洗盘|收拾|扔掉|拿来|拿一下|拿过来|放冰箱|洗澡|去洗|睡觉|过来|回家|吃饭|做饭|烹饪|清理|捡|弄干净|拿饭/;
const REFUSE_RE = /不要|不想|不干|就不|下次再|现在不做|等一?会再说|等一?下再说/;

function hasPhysical(steps) {
    for (let i = 0; i < (steps || []).length; i++) {
        const t = steps[i].type;
        if (t === 'use_object' || t === 'go_home' || t === 'go_to_player' || t === 'go_to_place' || t === 'interact') return true;
    }
    return false;
}

// Reads back what the character just said: did it agree to do something with its own hands?
function spokenPromisePrompt(input) {
    const snap = input.snap;
    const me = snap.partner.name;
    const them = snap.player.name;
    const system = [
        '你读' + me + '刚发给' + them + '的消息，判断' + me + '在这些话里有没有答应要亲手去做一件现实中的事。',
        '马上做、等一会做、等手头的事做完再做，都算答应了。顺着对方的话说好、知道了、马上来，也算答应了对方要的那件事。',
        '只是聊天、关心、开玩笑、讨价还价之后没有答应、明确拒绝、或者是让对方去做的，都不算。',
        '只输出 JSON：{"promise":"答应要做的事，一句简短的话；没有就写空字符串"}'
    ].join('\n');
    const user = [
        input.asked ? them + '说：\n' + input.asked : '',
        me + '回：\n' + (input.bubbles || []).join('\n'),
        '请只输出 JSON。'
    ].filter(Boolean).join('\n');
    return { system, user };
}

// The spoken reply promised a real action, or agreed to one, but nothing was queued.
function needsActionRepair(pending, bubbles, steps, opts) {
    if (hasPhysical(steps)) return false;
    const say = (bubbles || []).join('\n');
    const proactive = !!(opts && opts.proactive);
    if (/等一?会再说|等一?下再说|下次再|现在不做/.test(say)) return false;
    if (/不要|不想|算了|不用/.test(say) && !LATER_RE.test(say)) return false;
    if (REFUSE_RE.test(say) && !LATER_RE.test(say)) return false;
    if (proactive) return /我现在就|我这就去|我马上去|我来做|我去做|我去拿|我去收|我去扫|我去洗|我去做饭/.test(say);
    if (COMMIT_RE.test(say) || LATER_RE.test(say)) return true;
    let ask = '';
    for (let i = 0; i < (pending || []).length; i++) ask += (pending[i] && pending[i].text ? pending[i].text : '') + '\n';
    if (/好不好|行不行|要不要/.test(say)) return ORDER_RE.test(ask) && LATER_RE.test(say);
    return ORDER_RE.test(ask) && /好的|好吧|行|知道了|我/.test(say);
}

function actionRepairPrompt(input) {
    const snap = input.snap;
    const bubbles = input.bubbles || [];
    const pending = input.pending || [];
    const catalog = input.catalog || {};
    const t = terms(snap);
    const list = actionCatalog(catalog);
    const system = [
        '你只把' + snap.partner.name + '已经说出口的话，变成' + (isMale(snap.partner.gender) ? '他' : '她') + '现在就要做的动作。不要写新的聊天，不要改已经说的话。',
        '只输出 JSON：{"why":"","actions":[]}。why 写在最前面：答应的是哪件事、眼前哪件东西能做到、要不要先放下手头的事，一两句话。',
        '允许的格式：',
        '- {"type":"stop_current"}：马上放下手头的事',
        '- {"type":"stop_current","after_s":秒数}：手头的事再做这么多秒就放下，只能写在第一条',
        '- {"type":"use_object","object_id":"物件ID","interaction_id":"动作ID","want":"做完要达到的结果"}',
        '- {"type":"use_object","object_id":"物件ID或空字符串","want":"做完要达到的结果，说清为谁"}：清单里没列出对应做法时用，系统会在游戏里查',
        (snap.skills || []).length ? '- {"type":"use_object","skill":"K编号","want":"做完要达到的结果"}：答应的事就是下面「会做的事」里带编号的一件时，优先这样写' : '',
        '- {"type":"go_home","fast":false}',
        catalog.allowed && catalog.allowed.has('go_to_player') ? '- {"type":"go_to_player","fast":false}' : '你们已经在一起，不用走过去找对方；话里的「过去」指的是去做那件事本身。',
        'object_id 和 interaction_id 必须从清单原样抄写，不能编，也不能写 self。清单里找不到对应做法时，用 want 写清要做的事。',
        '一件事对应一条。看清单里每条做法的结果，选能让对方真正得到想要结果的那一条。',
        '说等一会、等下、忙完再做，也要写出接下来的动作。手头的事会自己结束就不写 stop_current；不会自己停，第一条写带 after_s 的 stop_current。不写动作就等于永远不做。已经做完的事不要再写。',
        currentWork(snap, catalog),
        finishedText(snap.finished, Date.now()),
        orderGuidance(),
        '一次最多 4 个。话里明确拒绝、或者说现在不做，actions 用空数组。',
        knowhowLines(snap, true) ? snap.partner.name + '会做的事：\n' + knowhowLines(snap, true) : '',
        list ? '清单：\n' + list : '现在没有可做的家务清单。如果话里要做的事不在清单里，actions 用空数组。'
    ].filter(Boolean).join('\n');
    const asked = [];
    for (let i = 0; i < pending.length; i++) if (pending[i] && pending[i].text) asked.push(pending[i].text);
    const user = [
        t.call + '刚说：',
        asked.join('\n') || '（没有）',
        '',
        snap.partner.name + '已经回复：',
        bubbles.join('\n'),
        input.promise ? '\n这些话里答应的事：' + input.promise : '',
        '',
        '请只输出 JSON。'
    ].join('\n');
    return { system: system, user: user };
}

function focusObjectsPrompt(query, objects) {
    return {
        system: '只在提供的物品清单中核实用户指的东西，不执行动作。根据名称和可用动作理解俗称、类别名；不要把“在电脑旁边”里的电脑当成要找的东西。纠正句以纠正后的目标为准。只输出 JSON {"object_ids":[],"why":""}，最多6个真实ID；没有对应项时为空数组。不要编造ID。',
        user: '用户正在说：' + query + '\n物品（可用动作仅供辨认，实际能否使用还需查询）：\n' +
            objects.map((o) => JSON.stringify({ id: o.id, name: o.name, room: o.room || '', near: o.near || [], actions: o.actions || [] })).join('\n')
    };
}

const FACT_RULES = '事实写成以后任何时候读都对的话：不写明天、今晚、刚才这类会过时的说法，写成事情本身（“宗会荣去面试唱片制作人”，面试过了就写结果）。' +
    '只写对方说过的、或者聊天里确实发生了的；谁猜的东西放在哪、可能是什么，不算事实。';

// facts: what is already remembered, numbered from 1 in the prompt.
function summaryPrompt(oldSummary, messages, snap, facts) {
    const t = terms(snap);
    const known = Array.isArray(facts) ? facts : [];
    const system = '你负责整理两位家人之间的短信记忆。' + snap.partner.name + '是' + snap.player.name + '的' + t.me + '。' +
        '把旧摘要和新的聊天记录合并成一段不超过 400 字的中文摘要，保留重要事件、约定、情绪变化和偏好。' +
        'facts：新的聊天里出现的、值得长期记住的具体事实，最多 5 条。已经记得的事实里有的（换个说法也算）不要再写。' + FACT_RULES +
        'revise：已经记得的事实里，被新的聊天改变了的（约好的事做了、计划有了结果、喜好变了），写 {"n":编号,"text":"改好的事实"}；没有就 []。' +
        'drop：已经记得的事实里，和别的条重复的、后来证明不对的、只是猜测的，写编号；没有就 []。' +
        '再单独写一句 episode：只概括这批新的聊天记录聊了什么、发生了什么（不超过 80 字，写清是谁、什么事，以后能凭它想起这段对话），' +
        '和 topics：这段对话的 2 到 6 个话题关键词（具体的名词或事，比如“足球比赛”“生日蛋糕”“加班”，不要写“聊天”“关心”这类空词）。' +
        '只输出 JSON：{"summary":"...","facts":["..."],"revise":[],"drop":[],"episode":"...","topics":["..."]}';
    const user = '旧摘要：' + (oldSummary || '（无）') + '\n\n已经记得的事实：\n' +
        (known.length ? known.map((f, i) => (i + 1) + '. ' + f.text).join('\n') : '（无）') +
        '\n\n新的聊天记录：\n' +
        messages.map((m) => '[' + msgTime(m, snap.env) + '] ' + (m.side === 'player' ? snap.player.name : snap.partner.name) + '：' + m.text).join('\n');
    return { system, user };
}

// Going once through everything remembered about a couple: repeats merged, what is no longer so
// put right or left out. facts: numbered from 1 in the prompt.
function factsTidyPrompt(summary, facts, partnerName, playerName) {
    const system = '你负责整理' + partnerName + '对' + playerName + '的长期记忆。下面这些事实是一条条攒下来的，很多是同一件事换着说法记了好几遍，有的已经过时或互相矛盾。' +
        '把它们整理成一份干净的清单：同一件事只留一条，把几条里的具体细节合到一起；后来变了的（约好的事已经做了、“明晚”的事已经过去、以前不会后来学会了）只按后来的情况写；猜测和不确定的位置删掉；和聊天摘要矛盾的以摘要为准。' +
        FACT_RULES + '每条不超过 60 字，不要编出原来没有的内容。' +
        '每条写明它来自原来的哪几条：{"text":"整理好的事实","from":[编号]}。只输出 JSON：{"facts":[...]}';
    const user = '聊天摘要：' + (summary || '（无）') + '\n\n原来的事实：\n' + facts.map((f, i) => (i + 1) + '. ' + f.text).join('\n');
    return { system, user };
}

module.exports = {
    defaultStyle, factsBlock, groupPrompt, replyPrompt, proactivePrompt, setbackPrompt, progressPrompt, summaryPrompt, factsTidyPrompt, actionRepairPrompt, focusObjectsPrompt, needsActionRepair, spokenPromisePrompt, wantPrompt, wantObjectsPrompt, meantNamesPrompt, afterTakePrompt, wantCheckPrompt, sameTaskPrompt, worstNeed, hopeAskText, terms, termsFor, isSleeping,
    trait, pref, gameTime, isMinorGroup, isTeenGroup, teenAudience, lastThoughtLine, rulesBlock, activityText, isMale, clock, knowhowBlock, knowhowLines, memoryBlock,
    voiceBrief, traitIds, personaBlock, workText, mealsText
};
