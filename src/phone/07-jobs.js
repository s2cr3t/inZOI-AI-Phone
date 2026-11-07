    // ------------------------------------------------------------------
    // Time
    // ------------------------------------------------------------------
    function loadTime() {
        return Promise.all([getEnv(), call('environment.get_simulation', {}, 'time_scale')]).then(function (r) {
            return { env: r[0], sim: r[1] };
        });
    }

    function runAction(label, factory) {
        setNote(label + '...', false);
        noteFromLoad = false;
        factory().then(function () {
            setNote(label + ' done', false);
            refresh();
        }, function (err) {
            setNote(errText(err), true);
        });
    }

    function actionButton(text, cls, onClick) {
        var b = node('div', 'ph-btn' + (cls ? ' ' + cls : ''), text);
        onTap(b, function (e) {
            e.stopPropagation();
            onClick();
        });
        return b;
    }

    function renderTime(data) {
        var wrap = node('div');
        wrap.appendChild(subHeader('time'));
        var sim = data.sim;
        var paused = !!sim.is_paused;
        var scale = Number(sim.time_scale) || 0;

        var info = card('GAME CLOCK');
        var stateRow = node('div', 'ph-row');
        stateRow.style.marginTop = '8px';
        var left = node('div', 'ph-who');
        left.appendChild(node('div', 'ph-state', clockText(data.env)));
        left.appendChild(node('div', 'ph-speed', (paused ? 'Paused' : 'Running') + '  x' + scale.toFixed(1)));
        stateRow.appendChild(left);
        stateRow.appendChild(node('span', 'ph-pill ' + (paused ? 'pill-late' : 'pill-work'), paused ? 'Paused' : 'Live'));
        info.appendChild(stateRow);
        info.appendChild(joinWithDots(node('div', 'ph-sub'), [data.env.day_of_week, data.env.season]));
        wrap.appendChild(info);

        var playRow = node('div', 'ph-btns');
        playRow.appendChild(actionButton(paused ? 'Play' : 'Pause', 'last on', function () {
            runAction(paused ? 'Play' : 'Pause', function () {
                return call('environment.pause', { Enable: !paused });
            });
        }));
        wrap.appendChild(playRow);

        var speedRow = node('div', 'ph-btns');
        SPEEDS.forEach(function (speed, i) {
            var active = !paused && Math.abs(scale - speed) < 0.01;
            var cls = (i === SPEEDS.length - 1 ? 'last' : '') + (active ? ' on' : '');
            speedRow.appendChild(actionButton(speed + 'x', cls, function () {
                runAction('Speed ' + speed + 'x', function () {
                    return call('environment.time_speed', { Speed: speed }).then(function () {
                        return paused ? call('environment.pause', { Enable: false }) : null;
                    });
                });
            }));
        });
        wrap.appendChild(speedRow);

        var skipRow = node('div', 'ph-btns');
        skipRow.appendChild(actionButton('+1 Hour', 'last', function () {
            runAction('Skip 1 hour', function () {
                return call('environment.time_skip', { Hours: 1 });
            });
        }));
        wrap.appendChild(skipRow);
        return wrap;
    }

    // ------------------------------------------------------------------
    // Jobs
    // ------------------------------------------------------------------
    var lastJobsData = null;

    function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    function memberById(members, id) {
        if (id === null || id === undefined) return null;
        for (var i = 0; i < members.length; i++) {
            if (String(members[i].entity_id) === String(id)) return members[i];
        }
        return null;
    }

    function loadJobs() {
        return Promise.all([
            getEnv(),
            getMembers(),
            soft(getPossessedId()),
            call('career.list_openings', {}, 'openings')
        ]).then(function (r) {
            var members = r[1].filter(function (m) { return !NON_WORKING_STEPS[m.age_group]; });
            var possessed = typeof r[2] === 'string' ? r[2] : null;
            if (!memberById(members, jobsMemberId)) {
                jobsMemberId = memberById(members, possessed) ? possessed
                    : (members.length ? String(members[0].entity_id) : null);
                jobsConfirmKey = null;
            }
            var openings = r[3].openings || [];
            var dtIds = [];
            openings.forEach(function (o) {
                if (dtIds.indexOf(o.career_dt_id) < 0) dtIds.push(o.career_dt_id);
            });
            return Promise.all(dtIds.map(function (id) { return soft(loadCareerRow(id)); })).then(function (rows) {
                var rowById = {};
                var keys = [];
                dtIds.forEach(function (id, i) {
                    var row = rows[i] && !rows[i].error ? rows[i] : null;
                    rowById[id] = row;
                    if (row && row.displayName) keys.push(row.displayName);
                });
                openings.forEach(function (o) {
                    var org = findOrg(rowById[o.career_dt_id], o.job_id);
                    if (org && org.rankList && org.rankList.length) keys.push(org.rankList[0].rankName);
                });
                return Promise.all([
                    localize(keys),
                    jobsMemberId ? soft(loadCareerSlot(jobsMemberId)) : Promise.resolve(null)
                ]).then(function (d) {
                    return {
                        env: r[0], members: members, openings: openings,
                        rowById: rowById, text: d[0], slot: d[1]
                    };
                });
            });
        });
    }

    function jobModel(o, row, text, member) {
        var org = findOrg(row, o.job_id);
        var rank = org && org.rankList && org.rankList.length ? org.rankList[0] : null;
        var shift = rank && rank.shift ? rank.shift : null;
        var model = {
            opening: o,
            key: o.career_entity_id + '|' + o.job_id,
            company: (row && text[row.displayName]) || o.career_dt_id,
            rankName: rank ? (text[rank.rankName] || '') : '',
            org: org,
            salary: shift && typeof shift.salaryPerDay === 'number' ? shift.salaryPerDay : null,
            minStep: shift ? shift.minGrowthStep : null,
            maxStep: shift ? shift.maxGrowthStep : null,
            hidden: !!(org && (org.hiddenFromUI || org.bRecruitable === false)),
            eligible: true
        };
        if (member && model.minStep && model.maxStep) {
            var step = GROWTH_ORDER[member.age_group];
            var lo = GROWTH_ORDER[model.minStep];
            var hi = GROWTH_ORDER[model.maxStep];
            if (step !== undefined && lo !== undefined && hi !== undefined) {
                model.eligible = step >= lo && step <= hi;
            }
        }
        return model;
    }

    function jobRank(model) {
        if (!model.eligible) return 2;
        return (Number(model.opening.vacancy) || 0) > 0 ? 0 : 1;
    }

    function verifyJoined(entityId, dtId, jobId, tries) {
        return loadCareerSlot(entityId).then(function (slot) {
            if (slot && slot.careerDtId === dtId && slot.jobDtId === jobId) return true;
            if (tries <= 1) return false;
            return wait(800).then(function () { return verifyJoined(entityId, dtId, jobId, tries - 1); });
        });
    }

    function joinJob(member, model) {
        if (joining) return;
        joining = true;
        jobsConfirmKey = null;
        noteFromLoad = false;
        var who = fullName(member);
        var o = model.opening;
        setNote('Applying for ' + o.job_name + '...', false);
        if (lastJobsData && current === 'jobs') show(renderJobs(lastJobsData));

        call('career.join', {
            entity_id: String(member.entity_id),
            career_entity_id: String(o.career_entity_id),
            job_id: o.job_id
        })
            .then(function () { return verifyJoined(member.entity_id, o.career_dt_id, o.job_id, 4); })
            .then(function (ok) {
                if (!ok) throw new Error('The game did not assign ' + o.job_name + ' to ' + who + '.');
                delete scheduleCache[String(member.entity_id)];
                setNote(who + ' joined ' + model.company + ' as ' + o.job_name, false);
            })
            .catch(function (err) { setNote(errText(err), true); })
            .then(function () {
                joining = false;
                refresh();
            });
    }

    function rerenderJobs() {
        if (!lastJobsData || current !== 'jobs') return;
        var scrollTop = wf.content.scrollTop;
        show(renderJobs(lastJobsData));
        wf.content.scrollTop = scrollTop;
    }

    function jobButton(member, model, isCurrent) {
        var confirmKey = String(member.entity_id) + '|' + model.key;
        if (isCurrent) return actionButton('Current job', 'last off', function () {});
        if (!model.eligible) return actionButton('Not eligible', 'last off', function () {});
        if ((Number(model.opening.vacancy) || 0) <= 0) return actionButton('No vacancy', 'last off', function () {});
        if (joining) return actionButton('Please wait', 'last off', function () {});
        if (jobsConfirmKey === confirmKey) {
            return actionButton(member.has_career ? 'Confirm switch' : 'Confirm', 'last warn', function () {
                joinJob(member, model);
            });
        }
        return actionButton('Apply', 'last on', function () {
            jobsConfirmKey = confirmKey;
            setNote(member.has_career
                ? fullName(member) + ' will leave ' + (member.job_name || 'the current job') + '. Tap again to confirm.'
                : 'Tap again to confirm.', false);
            noteFromLoad = false;
            rerenderJobs();
        });
    }

    function jobCard(member, model, slot) {
        var o = model.opening;
        var org = model.org;
        var isCurrent = !!(slot && !slot.error && slot.careerDtId === o.career_dt_id && slot.jobDtId === o.job_id);
        var vacancy = Number(o.vacancy) || 0;
        var c = node('div', 'ph-card ph-job');

        var logo = node('div', 'ph-avatar', (model.company || '?').charAt(0));
        logo.style.background = accentFor(o.career_entity_id);
        var row = node('div', 'ph-row');
        row.appendChild(logo);
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', o.job_name || o.job_id));
        who.appendChild(joinWithDots(node('div', 'ph-sub'), [model.company, model.rankName]));
        row.appendChild(who);
        row.appendChild(node('span', 'ph-pill ' + (isCurrent ? 'pill-work' : vacancy > 0 ? 'pill-move' : 'pill-idle'),
            isCurrent ? 'Current' : vacancy > 0 ? vacancy + ' open' : 'Full'));
        c.appendChild(row);

        if (org) {
            c.appendChild(node('div', 'ph-job-hours',
                minutesToLabel(hhmmToMinutes(org.startTime)) + ' - ' + minutesToLabel(hhmmToMinutes(org.endTime))));
            c.appendChild(joinWithDots(node('div', 'ph-sub'), [
                dayLabel(org.workDays),
                org.bCanRemoteWork ? 'Remote OK' : 'On site',
                model.salary !== null ? model.salary + ' / day' : ''
            ]));
        }
        if (!model.eligible) {
            c.appendChild(node('div', 'ph-warn', 'Ages ' + model.minStep + ' - ' + model.maxStep + ' only'));
        }
        if (member) {
            var btns = node('div', 'ph-btns');
            btns.appendChild(jobButton(member, model, isCurrent));
            c.appendChild(btns);
        }
        return c;
    }

    function renderJobs(data) {
        lastJobsData = data;
        var wrap = node('div');
        wrap.appendChild(subHeader('jobs'));
        var member = memberById(data.members, jobsMemberId);

        var pick = card('APPLY AS');
        if (!data.members.length) {
            var none = node('div', 'ph-empty', 'Nobody in this household is old enough to work.');
            none.style.marginTop = '8px';
            pick.appendChild(none);
        } else {
            var chips = node('div', 'ph-chips');
            data.members.forEach(function (m) {
                var id = String(m.entity_id);
                var chip = node('div', 'ph-chip' + (id === jobsMemberId ? ' on' : ''));
                chip.appendChild(avatar(m));
                chip.appendChild(node('span', null, fullName(m)));
                onTap(chip, function (e) {
                    e.stopPropagation();
                    if (id === jobsMemberId) return;
                    jobsMemberId = id;
                    jobsConfirmKey = null;
                    setNote('', false);
                    refresh();
                });
                chips.appendChild(chip);
            });
            pick.appendChild(chips);
            if (member) {
                pick.appendChild(node('div', 'ph-current', member.has_career ? (member.job_name || 'Employed') : 'No job yet'));
                if (member.has_career) {
                    pick.appendChild(joinWithDots(node('div', 'ph-sub'), [member.job_rank_name,
                        member.job_rank ? 'Rank ' + member.job_rank : '']));
                }
            }
        }
        wrap.appendChild(pick);

        var models = [];
        data.openings.forEach(function (o, idx) {
            var model = jobModel(o, data.rowById[o.career_dt_id], data.text, member);
            model.index = idx;
            if (!model.hidden) models.push(model);
        });
        models.sort(function (a, b) {
            var d = jobRank(a) - jobRank(b);
            return d !== 0 ? d : a.index - b.index;
        });

        var open = models.filter(function (m) { return (Number(m.opening.vacancy) || 0) > 0; }).length;
        wrap.appendChild(node('div', 'ph-count', models.length + ' jobs in town, ' + open + ' hiring now'));

        if (!models.length) {
            var empty = card();
            empty.appendChild(node('div', 'ph-empty', 'No job listings right now.'));
            wrap.appendChild(empty);
        }
        models.forEach(function (model) {
            wrap.appendChild(jobCard(member, model, data.slot));
        });
        return wrap;
    }

