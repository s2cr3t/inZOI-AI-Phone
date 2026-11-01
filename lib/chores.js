'use strict';
// Fixed routes for everyday housework. A want such as "关掉电视" or "把菜放进冰箱" names a job
// the game always does the same way: the same interaction on the same kind of thing. Matching it
// here takes it straight to that interaction instead of three rounds of the model guessing from
// names, which is where most of these jobs used to be lost.
//
// Every interaction id below was seen working in game (bridge logs) or listed by the game itself
// (interaction_list_available). Where the id depends on the object's state or model (a lamp that
// is on offers 关灯 under On_Lighting01, one that is off offers something else), the game's own
// action name is matched instead. A recipe that finds nothing here gives the want back to the
// model unchanged: it only ever shortens the way, it never refuses a job.

// actions.js owns the cooking order; read on use so neither module needs the other at load.
function cookRank(id) {
    return require('./actions').cookRank(id);
}

// Wants that say not to do something, or only talk about it.
const NEGATED_RE = /(不要|不用|别再?|不想|先不|没法|不能|不会|不让|禁止)/;
// What the job is for, said as a "not" ("放进冰箱，不让它坏掉"): not a negated job.
const PURPOSE_TAIL_RE = /[，,、]?\s*(不让|别让|免得|以免|防止|省得|好不)[^，。,.]*/g;
// The job is for someone else ("给爸爸热吃的"): who gets it decides the route, not the chore.
const FOR_SOMEONE_RE = /(给|帮|替|为)[^，。,.]{0,8}(做|拿|端|热|盛|送|递|准备|弄)|(拿|端|送|递|盛|热)[^，。,.]{0,10}给/;

// Room words in a want, matched against the room labels the rooms module gives objects.
const ROOM_WORDS = [
    { re: /卧室|房间|屋里|床边/, label: /卧室|房间/ },
    { re: /客厅/, label: /客厅/ },
    { re: /厨房/, label: /厨房/ },
    { re: /餐厅|饭厅/, label: /餐厅/ },
    { re: /卫生间|浴室|厕所|洗手间/, label: /卫生间|浴室/ },
    { re: /书房/, label: /书房/ },
    { re: /洗衣房/, label: /洗衣/ },
    { re: /院子|外面|花园/, label: /院子/ },
    { re: /楼上|二楼|2楼/, label: /^2楼|二楼/ },
    { re: /楼下|一楼|1楼/, label: /^1楼|一楼/ }
];

// Names of things to eat as the game prints them on a placed dish.
const FOOD_NAME_RE = /家庭装|饭|菜|汤|面|粥|披萨|蛋糕|松饼|煎饼|吐司|三明治|沙拉|早餐|虾|鱼|肉|排|鸡|蛋|饺|年糕|拌饭|咖喱|甜点|甜品|水果|芒果|刨冰|麦片|拿铁|咖啡|饮料/;

function isFood(o) {
    const state = String(o.state || '');
    if (/食物|变质|空盘|家庭餐|饭菜/.test(state)) return true;
    // 面 in 墙面镜 or 台面 is not noodles.
    return FOOD_NAME_RE.test(String(o.name || '')) && !/机|炉|冰箱|柜|桌|椅|架|箱|锅|灶|镜|灯|墙|窗|门|台|板|毯|垫|盆|画/.test(String(o.name || ''));
}

function isLeftover(o) {
    return /变质|空盘|吃完/.test(String(o.state || ''));
}

// TV channels by the words people use for them; the game names each channel's action.
const TV_CHANNELS = [
    { re: /新闻/, name: /新闻/ },
    { re: /天气/, name: /天气/ },
    { re: /脱口秀|搞笑/, name: /脱口秀/ },
    { re: /动画|动画片|少儿|儿童|卡通/, name: /儿童/ },
    { re: /电视剧|连续剧|剧/, name: /电视剧/ },
    { re: /健身/, name: /健身/ },
    { re: /音乐|唱歌|MV/i, name: /音乐/ },
    { re: /真人秀|综艺/, name: /真人秀/ },
    { re: /美食|做菜节目|烹饪节目/, name: /美食/ },
    { re: /辩论/, name: /辩论/ },
    { re: /瑜伽/, name: /瑜伽/ }
];

function pickChannel(actions, text, ctx) {
    for (const c of TV_CHANNELS) {
        if (!c.re.test(text)) continue;
        const hit = actions.find((a) => c.name.test(a.name));
        if (hit) return hit;
    }
    const minor = ctx && (ctx.ageGroup === 'Child' || ctx.ageGroup === 'Teen');
    const usual = actions.find((a) => (minor ? /儿童/ : /电视剧/).test(a.name));
    return usual || actions[0] || null;
}

// The best cooking start on this object, the same order the action lists use.
function pickCook(actions) {
    let best = null;
    let rank = 0;
    for (const a of actions) {
        const r = cookRank(a.id);
        if (r > rank) {
            rank = r;
            best = a;
        }
    }
    return best;
}

// say: the want; not: wants that look alike but are another job; objects: which things to look
// at (a name pattern, or a test on the object); acts: the interactions in the order they are
// tried, by id or by the game's action name; pick: chooses among the matching actions.
const RECIPES = [
    {
        id: 'tv_off', task: '关掉电视',
        say: /(关|关掉|关上|关了)[^，。]{0,3}电视|电视[^，。]{0,4}(关掉|关上|关了|关)/,
        objects: /电视/,
        acts: [{ id: /^Off_TV/ }, { name: /关闭电视|关电视|关掉电视/ }]
    },
    {
        id: 'tv_game', task: '一起用电视玩游戏',
        say: /(玩|打)[^，。]{0,3}(电子)?游戏|游戏机/,
        not: /手机|电脑/,
        objects: /电视/,
        acts: [{ id: /^Coop_TVGame_Match_Together$/ }, { name: /一起玩游戏/ }]
    },
    {
        id: 'tv_on', task: '打开电视看节目',
        say: /(开|打开|看)[^，。]{0,3}电视|电视[^，。]{0,4}(打开|开着|开一下)|看[^，。]{0,4}(节目|频道|电视剧|动画片|新闻)/,
        not: /关/,
        objects: /电视/,
        acts: [{ id: /^On_TV\d*(_Channel_\d+)?$/ }],
        pick: pickChannel
    },
    {
        id: 'lights_all_off', task: '把灯都关掉',
        say: /(所有|全部|都|整个家)[^，。]{0,4}灯[^，。]{0,3}关|灯[^，。]{0,3}(都|全部)[^，。]{0,2}关/,
        objects: /灯/,
        acts: [{ name: /关掉所有灯/ }, { id: /^On_Lighting\d*_All$/ }]
    },
    {
        id: 'light_off', task: '关灯',
        say: /关[^，。]{0,2}灯|灯[^，。]{0,3}关/,
        objects: /灯/,
        acts: [{ name: /^关灯$/ }, { id: /^On_Lighting\d*$/ }]
    },
    {
        id: 'light_on', task: '开灯',
        say: /(开|打开)[^，。]{0,2}灯|灯[^，。]{0,3}(打开|开一下|开着)/,
        not: /关/,
        objects: /灯/,
        acts: [{ name: /^开灯$/ }, { name: /打开所有灯/ }]
    },
    {
        id: 'fridge_keep', task: '把食物放进冰箱冷藏',
        say: /(放|收|存|搁|塞)[^，。]{0,3}(进|回|到)?[^，。]{0,2}冰箱|冷藏|(食物|饭菜|剩菜|菜|饭)[^，。]{0,6}收(好|起来)|收[^，。]{0,3}(食物|饭菜|剩菜)/,
        not: /(拿|取|端)[^，。]{0,4}出/,
        objects: isFood,
        acts: [{ id: /^Food_Fridge_Keeping$/ }, { name: /^冷藏$/ }]
    },
    {
        id: 'dump_food', task: '把坏掉或吃剩的食物处理掉',
        say: /(倒掉|扔掉|丢掉|处理|清理|收拾|打扫)[^，。]{0,8}(坏|变质|馊|剩|吃完|空盘|残羹|垃圾)|(坏|变质|馊)[^，。]{0,6}(食物|饭|菜)/,
        objects: isFood,
        prefer: isLeftover,
        acts: [{ id: /^DumpFood/ }, { id: /^DumpTarget/ }, { name: /^打扫干净$|倒掉|丢弃/ }]
    },
    {
        id: 'clear_table', task: '把餐桌收拾干净',
        say: /(收拾|清理|擦|整理)[^，。]{0,4}(餐桌|桌子|饭桌)|(餐桌|桌子|饭桌)[^，。]{0,4}(收拾|清理|擦)/,
        objects: /桌/,
        acts: [{ id: /^Clean_Table_All$/ }, { name: /全部清理/ }, { name: /^清理|擦/ }]
    },
    {
        id: 'dishes', task: '洗碗',
        say: /洗碗|刷碗|洗盘子|洗餐具|碗[^，。]{0,3}洗/,
        objects: /盘|碗|餐具|水槽|洗碗机/,
        acts: [{ name: /洗碗|洗盘子|洗餐具/ }, { id: /Dish|CleanUp_NonAuto/ }]
    },
    {
        id: 'mop', task: '拖地',
        say: /拖[^，。]{0,3}地(板|面)?(?!方|址|点|图)|地[^，。]{0,3}拖/,
        objects: /拖把/,
        acts: [{ id: /^C_Object_Mopping_Home$/ }, { id: /Mopping_Home/ }]
    },
    {
        id: 'vacuum', task: '用吸尘器打扫地板',
        say: /吸尘|扫地|扫[^，。]{0,2}地板|地板[^，。]{0,4}(扫|干净)|打扫(一下)?(家里|屋子|房间|卫生)/,
        objects: /吸尘器/,
        acts: [{ id: /^C_Object_BasicVC_Home$/ }, { id: /BasicVC_Home/ }, { id: /BasicVC/ }]
    },
    {
        id: 'trash', task: '倒垃圾',
        say: /倒垃圾|扔垃圾|丢垃圾|垃圾[^，。]{0,4}(倒|拿出去|扔|清)/,
        objects: /垃圾桶/,
        acts: [{ name: /倒垃圾|清空|拿出垃圾|丢垃圾|清理垃圾|倒掉/ }, { id: /TrashCan.*(Empty|Clean|Take|Dump)/ }]
    },
    {
        id: 'laundry', task: '洗衣服',
        say: /洗衣服|洗衣|衣服[^，。]{0,4}洗/,
        objects: /洗衣机/,
        acts: [{ name: /^(洗衣服?|开始洗衣|使用)$/ }, { id: /^(?!Coop_).*WashingMachine/ }, { id: /WashingMachine/ }, { name: /洗衣/ }]
    },
    {
        id: 'clean_bathroom', task: '打扫卫生间',
        say: /(刷|擦|清洁|打扫|洗)[^，。]{0,3}(浴缸|马桶|厕所|卫生间|浴室|淋浴|洗手池)/,
        objects: /浴缸|淋浴|马桶|水槽|浴室柜|洗手台/,
        acts: [{ id: /^Clean_(Bath|Toilet|Shower|Sink)/ }, { name: /^清洁|^打扫/ }]
    },
    {
        id: 'bath', task: '洗澡',
        say: /洗澡|泡澡|冲凉|淋浴|冲个澡|洗个澡/,
        not: /刷|擦|清洁|打扫/,
        objects: /浴缸|淋浴/,
        acts: [{ id: /^Use_Bath\d+$/ }, { id: /^Shower\d*$/ }, { name: /^(洗澡|淋浴)$/ }, { id: /^Use_Bath/ }]
    },
    {
        id: 'teeth', task: '刷牙',
        say: /刷牙/,
        objects: /浴室柜|水槽|洗手台|洗手池/,
        acts: [{ id: /^BrushTeeth/ }, { name: /^刷牙$/ }]
    },
    {
        id: 'wash_hands', task: '洗手',
        say: /洗手/,
        not: /洗手间/,
        objects: /浴室柜|水槽|洗手台|洗手池/,
        acts: [{ id: /^WashHand\d*$/ }, { name: /^洗手$/ }]
    },
    {
        id: 'wash_face', task: '洗脸',
        say: /洗脸|洗把脸/,
        objects: /浴室柜|水槽|洗手台|洗手池/,
        acts: [{ id: /^WashFace\d*$/ }, { name: /^洗脸$/ }]
    },
    {
        id: 'toilet', task: '上厕所',
        say: /上厕所|上个厕所|尿尿|拉屎|大便|小便|方便一下/,
        objects: /马桶|厕所/,
        acts: [{ id: /^Toilet\d*_Use$/ }, { name: /^使用$/ }]
    },
    {
        id: 'sleep', task: '上床睡觉',
        say: /睡觉|去睡|上床|午睡|睡一会|睡会儿|躺[^，。]{0,2}床/,
        objects: /床/,
        prefer: (o) => /^你的|你的卧室|你和/.test(String(o.room || '')),
        acts: [{ id: /^Sleep_Bed/ }, { name: /^睡觉$/ }]
    },
    {
        id: 'drink_water', task: '喝水',
        say: /喝(点|口|杯)?水/,
        objects: /净水器|饮水机|水槽|水龙头/,
        acts: [{ name: /^喝水$/ }, { id: /WaterPurifier_Drink|SinkBowl_Drink/ }]
    },
    {
        id: 'coffee', task: '喝咖啡',
        say: /咖啡/,
        objects: /咖啡机/,
        acts: [{ name: /咖啡/ }]
    },
    {
        id: 'homework', task: '写作业',
        say: /写作业|做作业|做练习|写练习册|完成练习册|做功课/,
        objects: /书架|书桌|课桌|电脑/,
        acts: [{ name: /完成练习册|写作业|做作业/ }, { id: /Doodling|Homework/ }]
    },
    {
        id: 'diary', task: '写日记',
        say: /写日记/,
        objects: /书架|书桌/,
        acts: [{ name: /^写日记$/ }, { id: /Write_Memoir/ }]
    },
    {
        id: 'read', task: '看书',
        say: /看书|读书|看小说|看会儿?书|看本书/,
        objects: /书/,
        acts: [{ id: /^Book_Read$/ }, { name: /^读书$/ }, { name: /^阅读小说$/ }]
    },
    {
        id: 'water_plants', task: '给植物浇水',
        say: /浇花|浇水|给[^，。]{0,4}(花|植物|盆栽)[^，。]{0,2}浇/,
        objects: /盆|花|植物|树|草|兰|芋|鹅掌柴|绿植|多肉/,
        acts: [{ name: /浇水|浇花/ }]
    },
    {
        id: 'change_clothes', task: '换衣服',
        say: /换(件|身|套)?衣服|换装|换上/,
        objects: /衣橱|衣柜|衣架|衣帽/,
        acts: [{ name: /换衣服|更衣|换装/ }, { name: /选择服装/ }]
    },
    {
        id: 'cook', task: '做饭',
        say: /做饭|煮饭|烧饭|下厨|做(个|点|顿|些)?(菜|饭|吃的|晚饭|午饭|早饭|早餐|午餐|晚餐)/,
        objects: /冰箱|炉|灶|烤箱|厨/,
        acts: [{ test: (a) => cookRank(a.id) > 0 }],
        pick: (actions) => pickCook(actions)
    }
];

function acceptsObject(recipe, o) {
    if (!o || !o.name) return false;
    if (typeof recipe.objects === 'function') return !!recipe.objects(o);
    return recipe.objects.test(String(o.name));
}

function actionMatches(rule, a) {
    if (rule.test) return !!rule.test(a);
    if (rule.id && !rule.id.test(String(a.id || ''))) return false;
    if (rule.name && !rule.name.test(String(a.name || ''))) return false;
    return true;
}

// A want that is two jobs in a row: "换上睡衣去睡觉", "上完厕所，舒舒服服去吃早饭", "洗完澡再看电视".
// One interaction does only the first, so no recipe stands for it and it is never learned as one
// skill (it once taught "go to sleep" = the wardrobe). A want that starts with 去 is one job.
const COMPOUND_RE = /(然后|接着|之后再|[完好了][^，。]{0,3}(再|就)|再去|，\s*再|，[^，。]{0,6}去[^，。]{1,})|^(?!去|准备)[^，。]{1,8}?(了|好|完|上)[^，。]{0,4}(去|准备|好去)[^，。]{1,}/;

function isCompound(text) {
    return COMPOUND_RE.test(String(text || '').trim());
}

// The two jobs of such a want: ["换上睡衣", "去睡觉"], or null when it is one.
function splitCompound(text) {
    const s = String(text || '').trim();
    if (!isCompound(s)) return null;
    const cut = (i, skip) => {
        const a = s.slice(0, i).replace(/[，,\s]+$/, '');
        const b = s.slice(i + skip).replace(/^[，,\s]+/, '');
        return a && b ? [a, b] : null;
    };
    let m = /(然后|接着|之后再|再去|，\s*再)/.exec(s);
    if (m) return cut(m.index, m[0].length) || null;
    m = /，[^，。]{0,6}去/.exec(s);
    if (m) return cut(m.index, 1);
    m = /[完好了][^，。]{0,3}(再|就)/.exec(s);
    if (m) {
        const at = m.index + m[0].length - 1;
        return cut(at, 1);
    }
    // "换上睡衣准备睡觉": the second job is what comes after 准备; "换上睡衣去睡觉" keeps its 去.
    m = /^(?!去|准备)[^，。]{1,8}?(了|好|完|上)[^，。]{0,4}?(好去|去|准备)/.exec(s);
    if (m) {
        const word = m[2];
        return word === '去' ? cut(m.index + m[0].length - 1, 0) : cut(m.index + m[0].length - word.length, word.length);
    }
    return null;
}

// The recipes a want reads as, best first. Empty when the want says not to, or is for someone
// else (then who gets it is the route, see daemon.resolveWant), or is two jobs in a row.
function recipesFor(text) {
    const s = String(text || '').trim();
    if (!s || NEGATED_RE.test(s.replace(PURPOSE_TAIL_RE, '')) || FOR_SOMEONE_RE.test(s) || isCompound(s)) return [];
    const hits = [];
    for (const r of RECIPES) {
        const m = r.say.exec(s);
        if (!m) continue;
        if (r.not && r.not.test(s)) continue;
        hits.push({ r, at: m.index });
    }
    // The job named first in the sentence is the one meant; ties keep the table order, which
    // puts the narrower recipe (所有灯) before the wider one (关灯).
    hits.sort((a, b) => a.at - b.at);
    return hits.map((h) => h.r);
}

// Objects this recipe would look at, in the order they are tried: a room the want names, then
// what the recipe prefers (one's own bed, a spoiled dish), then the nearest.
function candidatesFor(recipe, objects, text, limit) {
    const room = ROOM_WORDS.find((w) => w.re.test(String(text || '')));
    const list = (objects || []).filter((o) => acceptsObject(recipe, o) && !o.carried);
    const score = (o) => {
        let s = 0;
        if (room && room.label.test(String(o.room || ''))) s += 4;
        if (recipe.prefer && recipe.prefer(o)) s += 2;
        return s;
    };
    list.sort((a, b) => score(b) - score(a) ||
        (typeof a.meters !== 'number') - (typeof b.meters !== 'number') || (a.meters || 0) - (b.meters || 0));
    return list.slice(0, limit || 4);
}

// The action of this recipe on one object, from the object's full action list; null when the
// object does not offer it now.
function actionOn(recipe, actions, text, ctx) {
    for (const rule of recipe.acts) {
        const found = (actions || []).filter((a) => actionMatches(rule, a));
        if (!found.length) continue;
        return recipe.pick ? (recipe.pick(found, String(text || ''), ctx || {}) || found[0]) : found[0];
    }
    return null;
}

// How well a text names a dish: 3 the whole name, 2 two characters of it, 1 one of its food
// words (虾 for 烤虾); 0 not at all.
function dishNameScore(dishName, text) {
    const n = String(dishName || '').replace(/^(家庭装|一人份|大份|小份|一盘|一份)/, '').replace(/[\s「」]/g, '');
    const s = String(text || '');
    if (!n || !s) return 0;
    if (s.indexOf(n) >= 0) return 3;
    for (let i = 0; i + 2 <= n.length; i++) {
        if (s.indexOf(n.slice(i, i + 2)) >= 0 && FOOD_NAME_RE.test(n.slice(i, i + 2))) return 2;
    }
    const words = n.match(new RegExp(FOOD_NAME_RE.source, 'g')) || [];
    for (const w of words) if (w !== '家庭装' && s.indexOf(w) >= 0) return 1;
    return 0;
}

module.exports = { RECIPES, recipesFor, candidatesFor, actionOn, isFood, dishNameScore, isCompound, splitCompound, FOR_SOMEONE_RE, NEGATED_RE, ROOM_WORDS };
