'use strict';
// What a character's face and body do while it talks face to face (lib/focus.js): the faces the
// model may pick (the game's facial.list ids) and a short list of gestures, each a few of the
// game's own motions, the first one this character can play is used.

// facial.list ids, with what they look like.
const FACES = {
    Normal: '平静', Calm: '满意', Joyful: '愉快', Delighted: '欢快', Funny: '快乐', Giggling: '偷笑',
    Laughing: '大笑', Excited: '兴奋', Curious: '好奇', Preoccupied: '专注', Confident: '自信',
    Touched: '感动', Bored: '无聊', Tired: '无精打采', Sad: '难过', Depressed: '沮丧',
    Embarassed: '尴尬', Uneasy: '紧张', Nervous: '焦虑', Worried: '担心', Irritated: '不爽',
    Angry: '生气', Furious: '暴怒', Disgusted: '不快', Afraid: '害怕', Surprised: '惊讶', Shocked: '惊恐'
};

// gesture: [what it is, motions to try in order]. Motions found with motion.list validate=true.
const GESTURES = {
    greet: ['打招呼', ['GreetingPositiveA', 'StreetGreeting_01']],
    nod: ['点头', ['Self_Worker_Nod', 'SecurityGuard_Nod01']],
    laugh: ['笑出声', ['EmoReact_Funny_Laughing', 'Self_Event_Laugh']],
    think: ['想一想', ['Self_Emotion_Thinking', 'Self_Thinking']],
    surprised: ['吃了一惊', ['Reaction_Surprised_Lv2', 'Reaction_Surprised_Lv2_F', 'Self_Surprised']],
    pleased: ['惊喜', ['Reaction_PleasantSurprise', 'Reaction_PleasantSurprise_F']],
    sigh: ['叹气', ['Stand_Sigh']],
    angry: ['发火', ['Self_Angry_NoHand', 'Self_Angry']],
    cry: ['哭', ['Cry_Emotional', 'AddOnAnim_Cry_Weak']],
    clap: ['拍手', ['Self_Emotion_Clapping']],
    cheer: ['欢呼', ['Self_Emotion_CheerUp', 'Self_Emotion_CheerUp_2']],
    cold: ['冷淡地别过头', ['GreetingNegativeA', 'GreetingNegativeB']]
};

function cleanFace(v) {
    const s = String(v || '').trim();
    for (const id of Object.keys(FACES)) if (id.toLowerCase() === s.toLowerCase()) return id;
    return '';
}

function cleanGesture(v) {
    const s = String(v || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(GESTURES, s) ? s : '';
}

function facesText() {
    return Object.keys(FACES).map((id) => id + '（' + FACES[id] + '）').join('、');
}

function gesturesText() {
    return Object.keys(GESTURES).map((id) => id + '（' + GESTURES[id][0] + '）').join('、');
}

// Plays the face and the gesture on the character. game: GameClient (soft calls). cache: a Map
// remembering, per character, which motion of a gesture it can play ('' when none).
async function perform(game, entityId, face, gesture, cache, log) {
    const id = String(entityId);
    const done = { face: '', motion: '' };
    if (face) {
        try {
            const r = await game.soft('facial_set', { entity_id: id, Expression: face });
            if (r !== null) done.face = face;
        } catch (e) {
            if (log) log.debug('focus face ' + face + ' on ' + id + ' failed: ' + e.message);
        }
    }
    if (!gesture || !GESTURES[gesture]) return done;
    const key = id + '|' + gesture;
    let motion = cache && cache.has(key) ? cache.get(key) : null;
    if (motion === null) {
        motion = '';
        for (const anim of GESTURES[gesture][1]) {
            try {
                const r = await game.soft('motion_list', { Filter: anim, Max: 20, Validate: true, entity_id: id });
                const text = typeof r === 'string' ? r : JSON.stringify(r || '');
                if (text.indexOf('"' + anim + '"') >= 0) { motion = anim; break; }
            } catch (e) {
                if (log) log.debug('focus motion lookup ' + anim + ' failed: ' + e.message);
            }
        }
        if (cache) cache.set(key, motion);
    }
    if (!motion) return done;
    try {
        const r = await game.soft('motion_play', { anim_id: motion, entity_id: id });
        if (r !== null) done.motion = motion;
    } catch (e) {
        if (log) log.debug('focus motion ' + motion + ' on ' + id + ' failed: ' + e.message);
    }
    return done;
}

module.exports = { FACES, GESTURES, cleanFace, cleanGesture, facesText, gesturesText, perform };
