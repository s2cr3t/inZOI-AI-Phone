'use strict';

// What the character has on, told in plain Chinese. The game gives an outfit category
// (Everyday, Sleep...) with situational overlays, and garment ids such as W_C_Pajama002_004.
// It has no display names for garments, so the id's own words are translated.

const CATEGORY = {
    Everyday: '平时的衣服',
    Daily: '平时的衣服',
    Casual: '平时的衣服',
    Sleep: '睡衣',
    Sleepwear: '睡衣',
    Pajama: '睡衣',
    Formal: '正装',
    Party: '派对穿的衣服',
    Athletic: '运动服',
    Sport: '运动服',
    Exercise: '运动服',
    Workout: '运动服',
    Swim: '泳衣',
    Swimwear: '泳衣',
    Bath: '浴袍',
    Work: '上班穿的衣服',
    Career: '上班穿的衣服',
    Uniform: '制服',
    School: '校服',
    Outdoor: '出门穿的衣服',
    Cold: '保暖的冬衣',
    Winter: '保暖的冬衣',
    Hot: '凉快的夏装',
    Summer: '凉快的夏装',
    Naked: '没穿衣服',
    Nude: '没穿衣服'
};

const REASON = {
    SituationalOutfit: '按眼下要做的事换的',
    WeatherOutfit: '按天气换的',
    CareerOutfit: '上班要穿的',
    ScheduleOutfit: '按日程换的',
    IndoorOutfit: '在家里'
};

const SITUATION = {
    睡衣: '准备睡觉换上的',
    泳衣: '要下水换上的',
    运动服: '要运动换上的',
    浴袍: '洗澡前后换上的'
};

const COSTUME = {
    TakeOffShoes: '进了屋，鞋脱了，光着脚'
};

// Longest words first so "TShirt" is not read as "Shirt".
const WORDS = [
    ['Pajama', '睡衣'], ['Pyjama', '睡衣'], ['Sleepwear', '睡衣'], ['Nightgown', '睡裙'], ['Robe', '浴袍'], ['Bathrobe', '浴袍'],
    ['Swimsuit', '泳衣'], ['Swim', '泳衣'], ['Bikini', '比基尼'],
    ['TShirt', 'T恤'], ['Tshirt', 'T恤'], ['Tee', 'T恤'], ['Hoodie', '连帽卫衣'], ['Sweatshirt', '卫衣'], ['Sweater', '毛衣'],
    ['Cardigan', '开衫'], ['Knit', '针织衫'], ['Blouse', '衬衫'], ['Shirt', '衬衫'], ['Polo', 'Polo 衫'], ['Vest', '背心'],
    ['Tank', '背心'], ['Camisole', '吊带'], ['Crop', '短上衣'], ['Top', '上衣'],
    ['Jacket', '夹克'], ['Blazer', '西装外套'], ['Coat', '外套'], ['Padding', '羽绒服'], ['Parka', '派克大衣'], ['Jumper', '外套'],
    ['Suit', '西装'], ['Tuxedo', '礼服'], ['Gown', '礼服裙'], ['Dress', '连衣裙'], ['OnePiece', '连衣裙'], ['Onepiece', '连衣裙'],
    ['Overall', '背带裤'], ['Jumpsuit', '连体衣'], ['Romper', '连体衣'],
    ['Uniform', '制服'], ['School', '校服'], ['Hanbok', '韩服'], ['Kimono', '和服'], ['Apron', '围裙'],
    ['Jeans', '牛仔裤'], ['Denim', '牛仔裤'], ['Leggings', '打底裤'], ['Jogger', '运动裤'], ['Training', '运动服'], ['Sport', '运动服'],
    ['Shorts', '短裤'], ['Pants', '裤子'], ['Trousers', '裤子'], ['Slacks', '西裤'], ['Skirt', '裙子'], ['Bottom', '下装'],
    ['Sneakers', '运动鞋'], ['Sneaker', '运动鞋'], ['Boots', '靴子'], ['Boot', '靴子'], ['Sandals', '凉鞋'], ['Sandal', '凉鞋'],
    ['Slippers', '拖鞋'], ['Slipper', '拖鞋'], ['Heels', '高跟鞋'], ['Heel', '高跟鞋'], ['Loafer', '乐福鞋'], ['Shoes', '鞋'], ['Shoe', '鞋'],
    ['Socks', '袜子'], ['Sock', '袜子'], ['Stocking', '长袜'],
    ['Hat', '帽子'], ['Cap', '帽子'], ['Beanie', '毛线帽'], ['Glasses', '眼镜'], ['Sunglasses', '墨镜'], ['Scarf', '围巾'],
    ['Gloves', '手套'], ['Glove', '手套'], ['Mask', '口罩'], ['Bag', '包'], ['Backpack', '书包'], ['Necklace', '项链'], ['Earring', '耳环']
].sort((a, b) => b[0].length - a[0].length);

const TYPE = {
    Full: '一身',
    Top: '上衣',
    Bottom: '下装',
    Shoes: '鞋',
    Shoe: '鞋',
    Socks: '袜子',
    Hat: '帽子',
    Headwear: '帽子',
    Glasses: '眼镜',
    Outer: '外套',
    Outerwear: '外套'
};

function str(v) {
    return v === undefined || v === null ? '' : String(v);
}

function categoryName(cat) {
    const c = str(cat);
    if (!c || c === 'None') return '';
    if (CATEGORY[c]) return CATEGORY[c];
    for (const k of Object.keys(CATEGORY)) {
        if (c.toLowerCase().indexOf(k.toLowerCase()) >= 0) return CATEGORY[k];
    }
    return '';
}

// "W_C_Pajama002_004" -> 睡衣. Empty when the id says nothing readable.
function garmentWord(garmentId) {
    const parts = str(garmentId).split('_').filter((p) => /[A-Za-z]{3,}/.test(p));
    for (const part of parts) {
        const bare = part.replace(/\d+/g, '');
        for (const w of WORDS) {
            if (bare.toLowerCase().indexOf(w[0].toLowerCase()) >= 0) return w[1];
        }
    }
    return '';
}

// { text, items, base, overlay, barefoot } where text is one sentence for the prompt.
function describe(category, garments) {
    const base = categoryName(category && category.base_category);
    const overlays = (category && Array.isArray(category.active_overlays)) ? category.active_overlays : [];
    let overlay = '';
    let overlayWhy = '';
    let barefoot = false;
    for (const o of overlays) {
        const costume = str(o && o.costume_id);
        if (costume === 'TakeOffShoes') barefoot = true;
        const name = categoryName(o && o.category);
        if (name && !overlay) {
            overlay = name;
            overlayWhy = REASON[str(o.reason)] || '';
        }
    }
    const list = (garments && Array.isArray(garments.garments)) ? garments.garments : [];
    const items = [];
    for (const g of list) {
        const word = garmentWord(g && (g.garment_id || g.mesh_id));
        const type = TYPE[str(g && g.type)] || '';
        let label = word;
        if (!label) label = type && type !== '一身' ? type : '';
        if (!label) continue;
        if (type === '一身' && word) label = '一身' + word;
        if (items.indexOf(label) < 0) items.push(label);
    }
    if (barefoot) {
        for (let i = items.length - 1; i >= 0; i--) {
            if (/鞋|袜/.test(items[i])) items.splice(i, 1);
        }
    }
    const bits = [];
    if (items.length) bits.push('身上穿着' + items.join('、'));
    else if (overlay || base) bits.push('身上穿着' + (overlay || base));
    if (overlay && items.length && items.join('').indexOf(overlay) < 0) bits.push('这是' + overlay);
    if (overlay && overlayWhy && overlayWhy !== '在家里') bits.push('是' + (SITUATION[overlay] && overlayWhy === REASON.SituationalOutfit ? SITUATION[overlay] : overlayWhy));
    if (barefoot) bits.push(COSTUME.TakeOffShoes);
    return {
        text: bits.length ? bits.join('，') + '。' : '',
        items: items,
        base: base,
        overlay: overlay,
        barefoot: barefoot
    };
}

module.exports = { describe, garmentWord, categoryName };
