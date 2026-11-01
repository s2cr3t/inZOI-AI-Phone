(function () {
    'use strict';

    function cli(cmd, params) { return wf.cli(cmd, params); }

    var ACCENTS = ['#9fd4ff', '#f7b6cf', '#bfe6a8', '#d9c6ff', '#ffd59e'];
    var POLL_MS = 15000;
    var SCHEDULE_TTL_MS = 5 * 60 * 1000;
    var DAY_MS = 1440;
    var WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    var WEATHER = { Sun: 'Sunny', Cloud: 'Cloudy', Rain: 'Rain', Snow: 'Snow', Fog: 'Fog', Storm: 'Storm' };

    var el = {
        clock: document.getElementById('hb-clock'),
        day: document.getElementById('hb-day'),
        meta: document.getElementById('hb-meta'),
        workers: document.getElementById('hb-workers'),
        othersLabel: document.getElementById('hb-others-label'),
        others: document.getElementById('hb-others'),
        status: document.getElementById('hb-status'),
        refreshBtn: document.getElementById('hb-refresh')
    };

    var scheduleCache = {};
    var careerRowCache = {};
    var busy = false;

    function setStatus(message, isError) {
        el.status.textContent = message;
        el.status.className = isError ? 'hb-status err' : 'hb-status';
    }

    window.addEventListener('error', function (e) {
        setStatus('Script error: ' + (e && e.message ? e.message : 'unknown'), true);
    });

    // ------------------------------------------------------------------
    // CLI replies
    // ------------------------------------------------------------------
    function snippet(value) {
        var s;
        try { s = typeof value === 'string' ? value : JSON.stringify(value); } catch (e) { s = String(value); }
        if (!s) s = String(value);
        return s.length > 160 ? s.slice(0, 160) + '...' : s;
    }

    function extractJson(text) {
        if (typeof text !== 'string') return null;
        var i = text.search(/[\[{]/);
        if (i < 0) return null;
        try { return JSON.parse(text.slice(i)); } catch (e) { return null; }
    }

    function unwrap(cmd, res) {
        var value = res;
        if (typeof value === 'string') value = extractJson(value) || value;
        if (value && typeof value === 'object' &&
            ('success' in value || 'data' in value || 'message' in value)) {
            if (value.success === false) {
                throw new Error(cmd + ': ' + (value.message || 'failed'));
            }
            var data = value.data;
            if (typeof data === 'string') data = extractJson(data);
            if (data && typeof data === 'object') return data;
            var fromMessage = extractJson(value.message);
            if (fromMessage) return fromMessage;
        }
        return value;
    }

    function call(cmd, params, requiredKey) {
        return Promise.resolve()
            .then(function () { return cli(cmd, params || {}); })
            .then(function (res) {
                var value = unwrap(cmd, res);
                if (requiredKey && !(value && typeof value === 'object' && requiredKey in value)) {
                    throw new Error(cmd + ': unexpected reply ' + snippet(res));
                }
                return value;
            });
    }

    // ------------------------------------------------------------------
    // Time
    // ------------------------------------------------------------------
    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function hhmmToMinutes(v) {
        var n = Number(v) || 0;
        return Math.floor(n / 100) * 60 + (n % 100);
    }

    function minutesToLabel(m) {
        m = ((m % DAY_MS) + DAY_MS) % DAY_MS;
        return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
    }

    function inWindow(now, start, end) {
        if (end > start) return now >= start && now < end;
        return now >= start || now < end;
    }

    function envMinutes(env) {
        if (!env || typeof env.hour !== 'number') return null;
        return env.hour * 60 + (env.minute || 0);
    }

    function dayLabel(days) {
        if (!days || !days.length) return 'No set days';
        if (days.length === 5) {
            var weekdays = true;
            for (var i = 0; i < WEEKDAYS.length; i++) {
                if (days.indexOf(WEEKDAYS[i]) < 0) weekdays = false;
            }
            if (weekdays) return 'Mon - Fri';
        }
        if (days.length === 7) return 'Every day';
        return days.map(function (d) { return String(d).slice(0, 3); }).join(' ');
    }

    // ------------------------------------------------------------------
    // Work schedule from game data
    // ------------------------------------------------------------------
    function pickSlot(slots) {
        if (!slots) return null;
        var order = ['business', 'school', 'club'];
        for (var i = 0; i < order.length; i++) {
            var s = slots[order[i]];
            if (s && s.careerDtId && s.careerDtId !== 'None') return s;
        }
        for (var k in slots) {
            if (slots.hasOwnProperty(k) && slots[k] && slots[k].careerDtId && slots[k].careerDtId !== 'None') {
                return slots[k];
            }
        }
        return null;
    }

    function loadCareerRow(careerDtId) {
        if (careerRowCache[careerDtId]) return Promise.resolve(careerRowCache[careerDtId]);
        return call('data.table_get', { Alias: 'Career', Row: careerDtId }, 'organizations')
            .then(function (row) {
                careerRowCache[careerDtId] = row;
                return row;
            });
    }

    function loadSchedule(member) {
        var key = String(member.entity_id);
        var cached = scheduleCache[key];
        if (cached && Date.now() - cached.at < SCHEDULE_TTL_MS) return Promise.resolve(cached.value);

        return call('entity.reflect', { entity_id: key, Component: 'FB2CareerComponent' }, 'careerSlots')
            .then(function (career) {
                var slot = pickSlot(career.careerSlots);
                if (!slot) return null;
                return loadCareerRow(slot.careerDtId).then(function (row) {
                    var orgs = row.organizations || [];
                    for (var i = 0; i < orgs.length; i++) {
                        if (orgs[i].jobId === slot.jobDtId) {
                            return {
                                days: orgs[i].workDays || [],
                                start: hhmmToMinutes(orgs[i].startTime),
                                end: hhmmToMinutes(orgs[i].endTime),
                                remote: !!orgs[i].bCanRemoteWork
                            };
                        }
                    }
                    return null;
                });
            })
            .then(function (value) {
                scheduleCache[key] = { at: Date.now(), value: value };
                return value;
            });
    }

    function describe(work, sched, env) {
        if (work && work.is_at_work) return { cls: 'pill-work', text: 'At work' };
        if (work && work.is_commute_time) return { cls: 'pill-move', text: 'Commuting' };

        var now = envMinutes(env);
        var workday = work ? !!work.is_working_day
            : !!(sched && env && sched.days.indexOf(env.day_of_week) >= 0);
        var onShift = work ? !!work.is_working_time
            : !!(sched && now !== null && inWindow(now, sched.start, sched.end));

        if (!workday) return { cls: 'pill-idle', text: 'Day off' };
        if (onShift) return { cls: 'pill-late', text: 'Not at work' };
        if (!sched || now === null) return { cls: 'pill-idle', text: 'Off shift' };
        if (sched.end > sched.start && now >= sched.end) return { cls: 'pill-idle', text: 'Done today' };
        return { cls: 'pill-idle', text: 'Starts ' + minutesToLabel(sched.start) };
    }

    // ------------------------------------------------------------------
    // DOM
    // ------------------------------------------------------------------
    function node(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }

    function dot() { return node('span', 'hb-dot'); }

    function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

    function joinWithDots(parent, parts) {
        var first = true;
        for (var i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;
            if (!first) parent.appendChild(dot());
            parent.appendChild(node('span', null, parts[i]));
            first = false;
        }
    }

    function fullName(m) {
        var name = (m.last_name || '') + (m.first_name || '');
        return name || ('#' + m.entity_id);
    }

    function avatar(m, accent) {
        var a = node('div', 'hb-avatar', (m.first_name || m.last_name || '?').charAt(0));
        a.style.background = accent;
        return a;
    }

    function pct(m) { return (m / DAY_MS * 100) + '%'; }

    function segment(track, from, to, color, active) {
        var s = node('div', 'hb-seg');
        s.style.left = pct(from);
        s.style.width = pct(to - from);
        s.style.background = color;
        s.style.opacity = active ? '1' : '0.35';
        track.appendChild(s);
    }

    function timeline(sched, env, accent, active) {
        var wrap = node('div');
        var track = node('div', 'hb-track');
        if (sched.end > sched.start) {
            segment(track, sched.start, sched.end, accent, active);
        } else {
            segment(track, sched.start, DAY_MS, accent, active);
            segment(track, 0, sched.end, accent, active);
        }
        var now = envMinutes(env);
        if (now !== null) {
            var marker = node('div', 'hb-now');
            marker.style.left = pct(now);
            track.appendChild(marker);
        }
        wrap.appendChild(track);

        var ticks = node('div', 'hb-ticks');
        [6, 12, 18].forEach(function (h) {
            var t = node('span', null, pad2(h) + ':00');
            t.style.left = pct(h * 60);
            ticks.appendChild(t);
        });
        wrap.appendChild(ticks);
        return wrap;
    }

    function workerCard(m, accent, work, sched, env) {
        var card = node('div', 'hb-person');

        var top = node('div', 'hb-top');
        top.appendChild(avatar(m, accent));
        var who = node('div', 'hb-who');
        who.appendChild(node('div', 'hb-name', fullName(m)));
        var job = node('div', 'hb-job');
        joinWithDots(job, [m.job_name, m.job_rank_name]);
        who.appendChild(job);
        top.appendChild(who);
        var state = describe(work, sched && !sched.error ? sched : null, env);
        top.appendChild(node('div', 'hb-pill ' + state.cls, state.text));
        card.appendChild(top);

        var shift = node('div', 'hb-shift');
        if (sched && !sched.error) {
            shift.appendChild(node('div', 'hb-hours',
                minutesToLabel(sched.start) + ' - ' + minutesToLabel(sched.end)));
            var tag = node('div', 'hb-tag');
            joinWithDots(tag, [dayLabel(sched.days), sched.remote ? 'Remote OK' : 'On site']);
            shift.appendChild(tag);
            card.appendChild(shift);
            var active = work ? !!work.is_working_day : true;
            card.appendChild(timeline(sched, env, accent, active));
        } else {
            shift.appendChild(node('div', 'hb-tag', 'Hours unavailable'));
            card.appendChild(shift);
        }
        return card;
    }

    function otherChip(m, accent) {
        var chip = node('div', 'hb-chip');
        chip.appendChild(avatar(m, accent));
        chip.appendChild(node('span', 'hb-chip-name', fullName(m)));
        var role = m.relationship_label || m.age_group_text;
        if (role) chip.appendChild(node('span', 'hb-chip-role', role));
        return chip;
    }

    function renderHeader(env) {
        var now = envMinutes(env);
        el.clock.textContent = now === null ? '--:--' : minutesToLabel(now);
        el.day.textContent = env && env.day_of_week ? env.day_of_week : '';
        clear(el.meta);
        var temp = env && typeof env.temperature === 'number' ? env.temperature + ' C' : '';
        joinWithDots(el.meta, [
            env && env.season,
            env && env.weather ? (WEATHER[env.weather] || env.weather) : '',
            temp
        ]);
    }

    function renderPeople(env, workers, others, statusRows, schedules) {
        var statusById = {};
        for (var i = 0; i < statusRows.length; i++) statusById[String(statusRows[i].entity_id)] = statusRows[i];

        clear(el.workers);
        if (!workers.length) {
            el.workers.appendChild(node('div', 'hb-empty', 'Nobody in this household has a job.'));
        }
        workers.forEach(function (m, idx) {
            el.workers.appendChild(workerCard(
                m, ACCENTS[idx % ACCENTS.length],
                statusById[String(m.entity_id)] || null, schedules[idx], env));
        });

        clear(el.others);
        el.othersLabel.style.display = others.length ? '' : 'none';
        others.forEach(function (m, idx) {
            el.others.appendChild(otherChip(m, ACCENTS[(workers.length + idx) % ACCENTS.length]));
        });
    }

    // ------------------------------------------------------------------
    // Grow the window once so the first full render needs no scrolling.
    // ------------------------------------------------------------------
    var fitted = false;

    function reportRect(root) {
        try {
            if (window.inzoi && inzoi.view && inzoi.view.setContentRect) {
                inzoi.view.setContentRect(root.offsetLeft, root.offsetTop, root.offsetWidth, root.offsetHeight);
            }
        } catch (e) {}
    }

    function fitHeightOnce() {
        var root = wf.root;
        var content = wf.content;
        if (fitted || root._minimized) return;
        fitted = true;
        var overflow = content.scrollHeight - content.clientHeight;
        if (overflow <= 0) return;
        var vh = window.innerHeight || document.documentElement.clientHeight || 1080;
        var height = Math.min(root.offsetHeight + overflow, vh - root.offsetTop - 16);
        if (height <= root.offsetHeight) return;
        root.style.height = height + 'px';
        root._savedH = height;
        reportRect(root);
        if (typeof root._saveWindowStateSoon === 'function') root._saveWindowStateSoon();
    }

    // ------------------------------------------------------------------
    // Refresh cycle
    // ------------------------------------------------------------------
    function loadBoard(force) {
        if (busy) return;
        busy = true;
        if (force) {
            scheduleCache = {};
            careerRowCache = {};
        }
        setStatus('Loading...', false);

        var env = null;
        var problems = [];

        call('environment.get_state', {}, 'hour')
            .then(function (e) {
                env = e;
                renderHeader(env);
                return call('household.get_members', {}, 'members');
            })
            .then(function (house) {
                var members = house.members || [];
                var workers = members.filter(function (m) { return !!m.has_career; });
                var others = members.filter(function (m) { return !m.has_career; });
                var ids = workers.map(function (m) { return String(m.entity_id); }).join(',');

                var statusP = ids
                    ? call('career.get_work_status', { entity_ids: ids }, 'results')
                        .then(function (r) { return r.results || []; })
                        .catch(function (err) { problems.push(err.message || String(err)); return []; })
                    : Promise.resolve([]);

                var scheduleP = Promise.all(workers.map(function (m) {
                    return loadSchedule(m).catch(function (err) {
                        var msg = err && err.message ? err.message : String(err);
                        problems.push(msg);
                        return { error: msg };
                    });
                }));

                return Promise.all([statusP, scheduleP]).then(function (r) {
                    renderPeople(env, workers, others, r[0], r[1]);
                    setTimeout(fitHeightOnce, 0);
                });
            })
            .then(function () {
                if (problems.length) {
                    setStatus(problems[0], true);
                } else {
                    setStatus('Updated at game time ' + el.clock.textContent, false);
                }
            }, function (err) {
                var msg = err && err.message ? err.message : String(err);
                setStatus(msg, true);
                console.error('[HouseholdBoard] ' + msg);
            })
            .then(function () { busy = false; });
    }

    el.refreshBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        loadBoard(true);
    });

    loadBoard(true);
    setInterval(function () { loadBoard(false); }, POLL_MS);
})();
