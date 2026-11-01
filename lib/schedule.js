'use strict';
// The game's own timetable: school, work, being held at the police station, volunteering, a
// clinic visit. The character is away until the game ends it, and cutting one short is skipping
// class or walking out of work. No AI step may put one down, push in front of it or take its
// place; everything the texts asked for waits until the game lets the character go.

// Bag ids of the timetable itself. "RabbitHole" covers school, company, police, hospital and
// lessons off the lot; the rest are on-lot schools and workplaces.
const SCHEDULE_BAG_RE = /RabbitHole|^Go_School_|^Go_Work_|^Go_Cahaya_FakeCompany|FakeCompany/i;
// Cancel reasons that come from the timetable taking the character away.
const SCHEDULE_CANCEL_RE = /Schedule|Career|RabbitHole/i;

function isScheduledBag(bagId) {
    return !!bagId && SCHEDULE_BAG_RE.test(String(bagId));
}

function isScheduleCancel(reason) {
    return !!reason && SCHEDULE_CANCEL_RE.test(String(reason));
}

// What kind of timetable entry this is, in the words the texting character would use.
function scheduleKind(bagId) {
    const s = String(bagId || '');
    if (/School/i.test(s)) return { what: '上学', end: '放学' };
    if (/FakeCompany|Go_Work_|Labor/i.test(s)) return { what: '上班', end: '下班' };
    if (/Detained|Police/i.test(s)) return { what: '被带去警局', end: '被放出来' };
    if (/Medical|Health|Hospital|Sonogram|CheckBaby|UnbornBaby/i.test(s)) return { what: '去医院', end: '看完' };
    return { what: '外出办事', end: '回来' };
}

// The live current interaction (interaction_get_current) and, if known, the work status
// (career_get_work_status) say the character is held by the timetable right now.
function scheduledNow(cur, work) {
    if (cur && cur.playing && isScheduledBag(cur.interaction_bag_id)) {
        return Object.assign({ bagId: String(cur.interaction_bag_id) }, scheduleKind(cur.interaction_bag_id));
    }
    if (work && work.has_job && work.is_at_work === true) {
        return { bagId: cur && cur.interaction_bag_id ? String(cur.interaction_bag_id) : '', what: '上班', end: '下班' };
    }
    return null;
}

class ScheduleBusyError extends Error {
    constructor(held) {
        super('正在' + held.what + '，要等' + held.end + '以后才能做');
        this.name = 'ScheduleBusyError';
        this.held = held;
    }
}

module.exports = { isScheduledBag, isScheduleCancel, scheduleKind, scheduledNow, ScheduleBusyError };
