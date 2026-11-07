    // ------------------------------------------------------------------
    // Freelance
    // ------------------------------------------------------------------
    // The order list lives only in the game's simulation thread. The HouseholdJournal Lua mod
    // prints it to the Lua log and the reply service writes it here (sms-bridge/lib/freelance.js):
    //   ui/phone/freelance/board.cfg    the played character's board and the latest request
    //                                   results. Reply service only.
    //   ui/phone/freelance/request.cfg  <seq>:<actor>:a:<summary id> (accept) or <seq>:<actor>:c
    //                                   (cancel the active order). Phone only; the Lua mod reads it
    //                                   itself, so accepting and cancelling work without the service.
    // Licenses, statistics and the active order id come straight from the game (FB2CareerComponent).
    var FL_SECTION = 'ui/phone/freelance';
    // The Lua mod prints the board at least every 30 s while the game runs.
    var FL_BOARD_STALE_MS = 90000;
    var FL_TICKS_PER_MIN = 600000000;
    var FL_WAIT_TRIES = 12;
    var FL_DIFFICULTY = { 1: 'Easy', 2: 'Normal', 3: 'Hard', 4: 'Expert' };
    var FL_DIFFICULTY_PILL = { 1: 'pill-work', 2: 'pill-move', 3: 'pill-late', 4: 'pill-late' };
    // EB1FreelanceOrderAcceptFailReason
    var FL_REASONS = {
        1: 'Not available', 2: 'Order is gone', 3: 'Order is gone', 4: 'Conditions not met',
        5: 'Could not start', 6: 'Could not start', 7: 'Could not start', 8: 'Penalty pending',
        9: 'Already on an order', 10: 'License needed', 11: 'License under review', 12: 'Grade too low'
    };
    var FL_STATUS = { 1: 'In progress', 2: 'Completed', 3: 'Failed', 4: 'Cancelled' };
    var FL_LICENSE_STATUS = { Owned: 'Owned', UnderReview: 'Under review', Available: 'Can apply', Locked: 'Locked' };
    var FL_LICENSE_PILL = { Owned: 'pill-work', UnderReview: 'pill-move', Available: 'pill-move', Locked: 'pill-idle' };
    var FL_LICENSE_ORDER = { Owned: 0, UnderReview: 1, Available: 2, Locked: 3 };
    var FL_CATEGORY_COLORS = { Delivery: '#FF9F0A', Creation: '#BF5AF2' };
    var FL_TABS = [
        { id: 'orders', label: 'Orders' },
        { id: 'active', label: 'Active' },
        { id: 'licenses', label: 'Licenses' }
    ];
    var flTab = 'orders';
    // Summary id of the order open in detail, or null for the list.
    var flOpenId = null;
    var flConfirmKey = null;
    var flBusy = false;
    var flTemplates = {};
    var flCategories = {};
    var flLicenseRows = {};
    var flNames = {};
    var lastFreelanceData = null;

    // A data table row, kept for the session once read. null when it cannot be read now.
    function flRow(cache, alias, row) {
        if (!row) return Promise.resolve(null);
        if (cache[row]) return Promise.resolve(cache[row]);
        return soft(call('data.table_get', { Alias: alias, Row: row })).then(function (r) {
            if (!r || r.error || typeof r !== 'object') return null;
            cache[row] = r;
            return r;
        });
    }

    function flRows(cache, alias, ids) {
        return Promise.all(ids.map(function (id) { return flRow(cache, alias, id); })).then(function () {
            var out = {};
            ids.forEach(function (id) { out[id] = cache[id] || null; });
            return out;
        });
    }

    function flName(id) {
        if (!id) return Promise.resolve('');
        if (flNames[id]) return Promise.resolve(flNames[id]);
        return soft(call('entity.get_character_info', { entity_id: String(id) }, 'entity_id')).then(function (r) {
            if (!r || r.error) return '';
            flNames[id] = fullName(r);
            return flNames[id];
        });
    }

    function flItemKey(targetId) { return targetId ? 'Object_' + targetId + '_DisplayNameTextId' : ''; }

    function flLoadBoard() {
        return call('uimod.cfg_load', { mod_id: SMS_MOD, section: FL_SECTION, key: 'board' }, 'value')
            .then(function (r) {
                var v = parseJson(r.value);
                return v && typeof v === 'object' ? v : null;
            }, function () { return null; });
    }

    function flLoadCareer(me) {
        return soft(call('entity.reflect', { entity_id: String(me), Component: 'FB2CareerComponent' }, 'licensesMap'))
            .then(function (r) { return r && !r.error ? r : null; });
    }

    function flActiveId(career) {
        var v = career && career.activeFreelanceOrderInstanceId;
        var n = v && typeof v === 'object' ? Number(v.value) : NaN;
        return isFinite(n) ? n : -1;
    }

    function flUnique(list) {
        var out = [];
        list.forEach(function (v) { if (v && out.indexOf(v) < 0) out.push(v); });
        return out;
    }

    function loadFreelance() {
        var env, me, board, career;
        return Promise.all([getEnv(), getPossessedId()]).then(function (r) {
            env = r[0];
            me = r[1];
            return Promise.all([flLoadBoard(), flLoadCareer(me)]);
        }).then(function (r) {
            var raw = r[0];
            career = r[1];
            // The board of another character (just switched) or an old one is not shown.
            var state = !raw ? 'none'
                : raw.me !== me ? 'other'
                : typeof raw.at !== 'number' || Date.now() - raw.at > FL_BOARD_STALE_MS ? 'stale' : 'ok';
            // Without a board, why: the service says whether the HouseholdJournal Lua mod runs,
            // at least every 30 s while it runs itself.
            var source = raw && raw.source && typeof raw.source === 'object' && typeof raw.written === 'number' &&
                Date.now() - raw.written < FL_BOARD_STALE_MS ? raw.source : null;
            var sourceMessage = '';
            if (state !== 'ok') {
                if (!source) state = raw ? 'stale' : 'none';
                else if (/^(starting|down|missing)$/.test(source.state)) {
                    state = 'mod-' + source.state;
                    sourceMessage = typeof source.message === 'string' ? source.message.slice(0, 200) : '';
                }
            }
            board = state === 'ok' ? raw : null;
            var orders = board && Array.isArray(board.orders) ? board.orders : [];
            var active = board && board.active && board.active.instanceId ? board.active : null;
            if (flOpenId && !orders.some(function (o) { return o.summaryId === flOpenId; })) flOpenId = null;
            var licenses = [];
            var map = career && career.licensesMap && typeof career.licensesMap === 'object' ? career.licensesMap : {};
            Object.keys(map).forEach(function (k) { if (map[k] && map[k].licenseId) licenses.push(map[k]); });
            var templateIds = flUnique(orders.map(function (o) { return o.templateId; }).concat(active ? [active.templateId] : []));
            return Promise.all([
                flRows(flTemplates, 'FreelanceOrderTemplate', templateIds),
                flRows(flLicenseRows, 'License', licenses.map(function (l) { return l.licenseId; }))
            ]).then(function (rows) {
                var templates = rows[0];
                var categoryIds = flUnique(templateIds.map(function (id) { return templates[id] && templates[id].categoryId; }));
                return flRows(flCategories, 'FreelanceCategory', categoryIds).then(function (categories) {
                    var open = flOpenId ? orders.filter(function (o) { return o.summaryId === flOpenId; })[0] : null;
                    // Names and item names only for what is shown in full.
                    var full = [open, active].filter(Boolean);
                    var keys = [];
                    templateIds.forEach(function (id) {
                        var t = templates[id];
                        if (t) keys.push(t.orderTitleTextId, t.orderDescriptionTextId);
                    });
                    categoryIds.forEach(function (id) { if (categories[id]) keys.push(categories[id].nameTextId); });
                    licenses.forEach(function (l) {
                        var row = rows[1][l.licenseId];
                        if (row) keys.push(row.licenseNameTextId, row.acquireGuideTextId);
                    });
                    full.forEach(function (o) { keys.push(flItemKey(o.targetId)); });
                    var people = flUnique([].concat.apply([], full.map(function (o) { return [o.clientId, o.recipientId]; })));
                    return Promise.all([
                        localize(keys),
                        Promise.all(people.map(flName))
                    ]).then(function (d) {
                        return {
                            env: env, me: me, state: state, sourceMessage: sourceMessage, board: board, orders: orders, active: active,
                            open: open, career: career, licenses: licenses, licenseRows: rows[1],
                            templates: templates, categories: categories, text: d[0]
                        };
                    });
                });
            });
        });
    }

    function flText(data, key) { return (key && data.text[key]) || ''; }

    function flTemplate(data, o) { return (o && data.templates[o.templateId]) || null; }

    function flTitle(data, o) {
        var t = flTemplate(data, o);
        return (t && flText(data, t.orderTitleTextId)) || (o && o.templateId) || 'Order';
    }

    function flCategoryName(data, o) {
        var t = flTemplate(data, o);
        var c = t && data.categories[t.categoryId];
        return (c && flText(data, c.nameTextId)) || (t && t.categoryId) || '';
    }

    function flLicenseName(data, id) {
        var row = data.licenseRows[id] || flLicenseRows[id];
        return (row && flText(data, row.licenseNameTextId)) || String(id || '').replace(/^License_/, '');
    }

    function flDescription(data, o) {
        var t = flTemplate(data, o);
        var text = t ? flText(data, t.orderDescriptionTextId) : '';
        var item = flText(data, flItemKey(o.targetId)) || o.targetId || '';
        return text
            .replace(/\{Client\}/g, flNames[o.clientId] || 'The client')
            .replace(/\{Recipient\}/g, flNames[o.recipientId] || 'the recipient')
            .replace(/\{Item\}/g, item);
    }

    // "2 h 05 min left" from game ticks; '' when the board has no clock.
    function flTimeLeft(board, ticks) {
        if (!board || typeof board.nowTicks !== 'number' || typeof ticks !== 'number' || ticks <= 0) return '';
        var min = Math.floor((ticks - board.nowTicks) / FL_TICKS_PER_MIN);
        if (min <= 0) return 'Time is up';
        var h = Math.floor(min / 60);
        return (h ? h + ' h ' + pad2(min % 60) : min) + ' min left';
    }

    function flReasonText(data, o) {
        var why = FL_REASONS[o.reason] || 'Not available';
        var t = flTemplate(data, o);
        var cond = t && t.condition;
        if (cond && (o.reason === 10 || o.reason === 11 || o.reason === 12) && cond.requiredLicenseId) {
            why += ': ' + flLicenseName(data, cond.requiredLicenseId) +
                (o.reason === 12 && cond.minimumGrade ? ' (' + cond.minimumGrade + ')' : '');
        }
        return why;
    }

    function flLogo(data, o) {
        var t = flTemplate(data, o);
        var name = flCategoryName(data, o);
        var logo = node('div', 'ph-avatar', (name || '?').charAt(0));
        logo.style.background = (t && FL_CATEGORY_COLORS[t.categoryId]) || accentFor(o.summaryId);
        return logo;
    }

    function rerenderFreelance() {
        if (!lastFreelanceData || current !== 'freelance') return;
        var scrollTop = wf.content.scrollTop;
        show(renderFreelance(lastFreelanceData));
        wf.content.scrollTop = scrollTop;
    }

    // Writes the request and waits for the outcome: the result line the reply service copies
    // into board.cfg, or the game's active order id changing, whichever shows first.
    function flAwait(seq, op, me, tries) {
        return Promise.all([flLoadBoard(), flLoadCareer(me)]).then(function (r) {
            var results = r[0] && Array.isArray(r[0].results) ? r[0].results : [];
            for (var i = 0; i < results.length; i++) {
                if (results[i] && results[i].seq === seq) return results[i];
            }
            var activeId = flActiveId(r[1]);
            if (op === 'a' && activeId >= 0) return { ok: true };
            if (op === 'c' && activeId < 0) return { ok: true };
            if (tries <= 1) return null;
            return wait(1000).then(function () { return flAwait(seq, op, me, tries - 1); });
        });
    }

    function flFailText(detail) {
        var m = /^reason_(\d+)$/.exec(detail || '');
        if (m) return FL_REASONS[Number(m[1])] || 'Not available';
        if (detail === 'no_active_order') return 'There is no order in progress';
        if (detail === 'stale_after_reload') return 'The game was loaded again; try once more';
        return detail ? detail.replace(/_/g, ' ') : 'The game refused';
    }

    function flSend(op, me, summaryId, label, done) {
        if (flBusy) return;
        flBusy = true;
        flConfirmKey = null;
        noteFromLoad = false;
        var seq = String(Date.now());
        setNote(label + '...', false);
        rerenderFreelance();
        call('uimod.cfg_save', {
            mod_id: SMS_MOD,
            section: FL_SECTION,
            key: 'request',
            value: seq + ':' + me + ':' + op + (summaryId ? ':' + summaryId : '')
        })
            .then(function () { return flAwait(seq, op, me, FL_WAIT_TRIES); })
            .then(function (res) {
                if (!res) throw new Error('No answer from the game. Is the HouseholdJournal mod installed and on?');
                if (!res.ok) throw new Error(label + ' failed: ' + flFailText(res.detail));
                done();
            })
            .catch(function (err) { setNote(errText(err), true); })
            .then(function () {
                flBusy = false;
                refresh();
            });
    }

    function flAccept(data, o) {
        flSend('a', data.me, o.summaryId, 'Accepting', function () {
            flOpenId = null;
            flTab = 'active';
            setNote('Order accepted: ' + flTitle(data, o), false);
        });
    }

    function flCancel(data) {
        flSend('c', data.me, '', 'Cancelling', function () {
            setNote('Order cancelled', false);
        });
    }

    function flAcceptButton(data, o) {
        var key = 'a|' + o.summaryId;
        if (flBusy) return actionButton('Please wait', 'last off', function () {});
        if (data.active || flActiveId(data.career) >= 0) return actionButton('Finish your current order first', 'last off', function () {});
        if (o.reason !== 0) return actionButton(flReasonText(data, o), 'last off', function () {});
        if (flConfirmKey === key) {
            return actionButton('Confirm', 'last warn', function () { flAccept(data, o); });
        }
        return actionButton('Accept order', 'last on', function () {
            flConfirmKey = key;
            setNote('Tap again to take this order.', false);
            noteFromLoad = false;
            rerenderFreelance();
        });
    }

    function flTabs() {
        var row = node('div', 'ph-btns');
        FL_TABS.forEach(function (tab, i) {
            var cls = (i === FL_TABS.length - 1 ? 'last' : '') + (tab.id === flTab ? ' on' : '');
            row.appendChild(actionButton(tab.label, cls, function () {
                if (tab.id === flTab) return;
                flTab = tab.id;
                flConfirmKey = null;
                rerenderFreelance();
            }));
        });
        return row;
    }

    var FL_MOD_TITLES = {
        'mod-starting': 'Starting the order service',
        'mod-down': 'The order service is not running',
        'mod-missing': 'The order service is missing'
    };

    function flBoardMissing(data) {
        var c = card();
        if (FL_MOD_TITLES[data.state]) {
            c.appendChild(node('div', 'ph-name', FL_MOD_TITLES[data.state]));
            c.appendChild(node('div', 'fl-desc', data.sourceMessage || 'Freelance orders come from the HouseholdJournal mod.'));
            return c;
        }
        c.appendChild(node('div', 'ph-empty', data.state === 'stale'
            ? 'The order list has not been updated for a while. Is the AI phone service running?'
            : data.state === 'other'
                ? 'Loading the order list for this character...'
                : 'The order list comes from the AI phone service. Turn it on in the AI app to see orders.'));
        return c;
    }

    function flOrderCard(data, o) {
        var c = node('div', 'ph-card ph-job fl-order');
        var row = node('div', 'ph-row');
        row.appendChild(flLogo(data, o));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', flTitle(data, o)));
        who.appendChild(joinWithDots(node('div', 'ph-sub'), [flCategoryName(data, o), FL_DIFFICULTY[o.difficulty] || '']));
        row.appendChild(who);
        row.appendChild(node('span', 'ph-pill ' + (o.reason === 0 ? 'pill-work' : 'pill-idle'), o.reason === 0 ? 'Open' : 'Locked'));
        c.appendChild(row);
        var meta = node('div', 'fl-meta');
        meta.appendChild(node('span', 'fl-pay', typeof o.reward === 'number' ? o.reward + ' pay' : ''));
        if (o.reason !== 0) meta.appendChild(node('span', 'fl-why', flReasonText(data, o)));
        c.appendChild(meta);
        onTap(c, function (e) {
            e.stopPropagation();
            flOpenId = o.summaryId;
            flConfirmKey = null;
            setNote('', false);
            refresh();
        });
        return c;
    }

    function flFact(label, value) {
        if (!value) return null;
        var f = node('div', 'fl-fact');
        f.appendChild(node('span', 'fl-fact-label', label));
        f.appendChild(node('span', 'fl-fact-value', value));
        return f;
    }

    function flAppend(parent, children) {
        children.forEach(function (c) { if (c) parent.appendChild(c); });
    }

    function flHours(cond) {
        if (!cond || typeof cond.startHour !== 'number' || typeof cond.endHour !== 'number') return '';
        if (cond.startHour === cond.endHour) return '';
        return pad2(cond.startHour) + ':00 - ' + pad2(cond.endHour) + ':00';
    }

    function renderFlDetail(data, o) {
        var wrap = node('div');
        var head = node('div', 'ph-head');
        var back = node('div', 'ph-back', '< Orders');
        onTap(back, function (e) {
            e.stopPropagation();
            flOpenId = null;
            flConfirmKey = null;
            setNote('', false);
            rerenderFreelance();
        });
        head.appendChild(back);
        head.appendChild(node('div', 'ph-title', 'Order'));
        wrap.appendChild(head);

        var t = flTemplate(data, o);
        var cond = t && t.condition;
        var c = node('div', 'ph-card ph-job');
        var row = node('div', 'ph-row');
        row.appendChild(flLogo(data, o));
        var who = node('div', 'ph-who');
        who.appendChild(node('div', 'ph-name', flTitle(data, o)));
        who.appendChild(joinWithDots(node('div', 'ph-sub'), [flCategoryName(data, o)]));
        row.appendChild(who);
        if (FL_DIFFICULTY[o.difficulty]) {
            row.appendChild(node('span', 'ph-pill ' + (FL_DIFFICULTY_PILL[o.difficulty] || 'pill-idle'), FL_DIFFICULTY[o.difficulty]));
        }
        c.appendChild(row);
        var desc = flDescription(data, o);
        if (desc) c.appendChild(node('div', 'fl-desc', desc));
        c.appendChild(node('div', 'ph-job-hours', typeof o.reward === 'number' ? o.reward + ' pay' : ''));
        var item = flText(data, flItemKey(o.targetId)) || o.targetId;
        var delivery = t && t.categoryId === 'Delivery';
        flAppend(c, [
            flFact('Client', flNames[o.clientId]),
            delivery && o.recipientId && o.recipientId !== o.clientId ? flFact('Deliver to', flNames[o.recipientId]) : null,
            flFact(delivery ? 'Item' : 'Make', item),
            cond && cond.requiredLicenseId ? flFact('License', flLicenseName(data, cond.requiredLicenseId) +
                (cond.minimumGrade && cond.minimumGrade !== 'Beginner' ? ', ' + cond.minimumGrade + ' or above' : '')) : null,
            flFact('Hours', flHours(cond))
        ]);
        if (o.reason !== 0) c.appendChild(node('div', 'ph-warn', flReasonText(data, o)));
        var btns = node('div', 'ph-btns');
        btns.appendChild(flAcceptButton(data, o));
        c.appendChild(btns);
        wrap.appendChild(c);
        return wrap;
    }

    function renderFlOrders(data, wrap) {
        if (data.state !== 'ok') {
            wrap.appendChild(flBoardMissing(data));
            return;
        }
        var orders = data.orders.slice();
        orders.sort(function (a, b) {
            var d = (a.reason === 0 ? 0 : 1) - (b.reason === 0 ? 0 : 1);
            return d !== 0 ? d : (Number(b.reward) || 0) - (Number(a.reward) || 0);
        });
        var open = orders.filter(function (o) { return o.reason === 0; }).length;
        wrap.appendChild(node('div', 'ph-count', orders.length + ' orders, ' + open + ' you can take now'));
        if (!orders.length) {
            var empty = card();
            empty.appendChild(node('div', 'ph-empty', 'No orders right now. New ones come in every day.'));
            wrap.appendChild(empty);
        }
        orders.forEach(function (o) { wrap.appendChild(flOrderCard(data, o)); });
    }

    function renderFlActive(data, wrap) {
        var a = data.active;
        var activeId = flActiveId(data.career);
        if (!a && activeId < 0) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'No order in progress. Pick one from Orders.'));
            wrap.appendChild(none);
        } else {
            var c = card('CURRENT ORDER');
            if (a) {
                var row = node('div', 'ph-row');
                row.style.marginTop = '10px';
                row.appendChild(flLogo(data, a));
                var who = node('div', 'ph-who');
                who.appendChild(node('div', 'ph-name', flTitle(data, a)));
                who.appendChild(joinWithDots(node('div', 'ph-sub'), [flCategoryName(data, a), FL_STATUS[a.status] || '']));
                row.appendChild(who);
                c.appendChild(row);
                var left = flTimeLeft(data.board, a.expireTicks);
                if (left) c.appendChild(node('div', 'ph-job-hours', left));
                var desc = flDescription(data, a);
                if (desc) c.appendChild(node('div', 'fl-desc', desc));
                var t = flTemplate(data, a);
                var delivery = t && t.categoryId === 'Delivery';
                flAppend(c, [
                    flFact('Client', flNames[a.clientId]),
                    delivery && a.recipientId && a.recipientId !== a.clientId ? flFact('Deliver to', flNames[a.recipientId]) : null,
                    flFact(delivery ? 'Item' : 'Make', flText(data, flItemKey(a.targetId)) || a.targetId)
                ]);
                if (a.crafting || (a.craftPercent || 0) > 0) {
                    c.appendChild(flFact('Work done', (a.craftPercent || 0) + '%'));
                    c.appendChild(bar(a.craftPercent || 0, '#BF5AF2'));
                }
            } else {
                c.appendChild(node('div', 'ph-current', 'On an order'));
                c.appendChild(node('div', 'ph-sub', 'The details come from the AI phone service.'));
            }
            var btns = node('div', 'ph-btns');
            if (flBusy) {
                btns.appendChild(actionButton('Please wait', 'last off', function () {}));
            } else if (flConfirmKey === 'c') {
                btns.appendChild(actionButton('Keep it', '', function () {
                    flConfirmKey = null;
                    setNote('', false);
                    rerenderFreelance();
                }));
                btns.appendChild(actionButton('Cancel order', 'last warn', function () { flCancel(data); }));
            } else {
                btns.appendChild(actionButton('Cancel order', 'last', function () {
                    flConfirmKey = 'c';
                    setNote('Cancelling costs trust, and a delivery may also bring a penalty.', false);
                    noteFromLoad = false;
                    rerenderFreelance();
                }));
            }
            c.appendChild(btns);
            wrap.appendChild(c);
        }
        var b = data.board;
        if (b && b.penalty) {
            var p = card('PENALTY');
            p.appendChild(node('div', 'ph-warn', 'A failed delivery is still being settled.'));
            var pf = b.penaltyFlow;
            if (pf) {
                flAppend(p, [
                    flFact('Order', pf.templateId && flTemplates[pf.templateId] ? flText(data, flTemplates[pf.templateId].orderTitleTextId) : pf.templateId),
                    flFact('Next step', flTimeLeft(b, pf.nextTicks).replace(' left', ''))
                ]);
            }
            wrap.appendChild(p);
        }
    }

    function flCondition(cond) {
        if (!cond) return '';
        if (cond.method === 'Skill') return (cond.s1 || 'Skill') + ' skill level ' + (cond.f1 || 0);
        if (cond.method === 'GrowthStep') return 'Age ' + (cond.s1 || '') + ' or older';
        return [cond.method, cond.s1, cond.f1 ? String(cond.f1) : ''].filter(Boolean).join(' ');
    }

    function renderFlLicenses(data, wrap) {
        var st = data.career && data.career.statistics;
        if (st) {
            var s = card('MY RECORD');
            var grid = node('div', 'ph-needs');
            [
                ['Completed', st.totalCompletedOrders],
                ['Failed', st.totalFailedOrders],
                ['Earned', st.totalEarnings],
                ['Tips', st.totalTips],
                ['Rating', typeof st.averageRating === 'number' ? (st.averageRating * 5).toFixed(1) + ' / 5' : '']
            ].forEach(function (pair) {
                var cell = node('div', 'ph-need');
                var top = node('div', 'ph-need-top');
                top.appendChild(node('span', null, pair[0]));
                top.appendChild(node('span', 'ph-need-val', pair[1] === undefined || pair[1] === null ? '-' : String(pair[1])));
                cell.appendChild(top);
                grid.appendChild(cell);
            });
            s.appendChild(grid);
            wrap.appendChild(s);
        }
        if (!data.career) {
            var none = card();
            none.appendChild(node('div', 'ph-empty', 'Licenses unavailable'));
            wrap.appendChild(none);
            return;
        }
        var list = data.licenses.slice().sort(function (a, b) {
            var d = (FL_LICENSE_ORDER[a.status] || 9) - (FL_LICENSE_ORDER[b.status] || 9);
            return d !== 0 ? d : String(a.licenseId).localeCompare(String(b.licenseId));
        });
        list.forEach(function (l) {
            var row = data.licenseRows[l.licenseId];
            var c = node('div', 'ph-card ph-job');
            var head = node('div', 'ph-row');
            var who = node('div', 'ph-who');
            who.appendChild(node('div', 'ph-name', flLicenseName(data, l.licenseId)));
            if (l.status === 'Owned') {
                who.appendChild(joinWithDots(node('div', 'ph-sub'), [l.currentGrade, (l.completedOrderCount || 0) + ' done']));
            }
            head.appendChild(who);
            head.appendChild(node('span', 'ph-pill ' + (FL_LICENSE_PILL[l.status] || 'pill-idle'), FL_LICENSE_STATUS[l.status] || l.status));
            c.appendChild(head);
            if (l.status === 'Owned') {
                c.appendChild(flFact('Trust', (l.trustScore || 0) + ' / 100'));
                c.appendChild(bar(l.trustScore || 0, '#30D158'));
            } else if (l.status === 'UnderReview') {
                var left = flTimeLeft(data.board, l.reviewExpireTimeTicks);
                c.appendChild(node('div', 'ph-sub', left ? 'Review: ' + left : 'The application is being reviewed.'));
            } else {
                var conds = row && Array.isArray(row.acquireConditions) ? row.acquireConditions : [];
                var met = Array.isArray(l.acquireConditionSatisfiedList) ? l.acquireConditionSatisfiedList : [];
                conds.forEach(function (cond, i) {
                    var ok = met[i] === true;
                    c.appendChild(node('div', 'fl-cond ' + (ok ? 'fl-ok' : 'fl-no'), (ok ? '✓ ' : '✗ ') + flCondition(cond)));
                });
                var guide = row ? flText(data, row.acquireGuideTextId) : '';
                if (guide) c.appendChild(node('div', 'fl-desc', guide));
            }
            wrap.appendChild(c);
        });
    }

    function renderFreelance(data) {
        lastFreelanceData = data;
        // The detail follows flOpenId, not the loaded data, so Back shows the list at once.
        if (flOpenId && data.open && data.open.summaryId === flOpenId) return renderFlDetail(data, data.open);
        var wrap = node('div');
        wrap.appendChild(subHeader('freelance'));
        wrap.appendChild(flTabs());
        if (flTab === 'active') renderFlActive(data, wrap);
        else if (flTab === 'licenses') renderFlLicenses(data, wrap);
        else renderFlOrders(data, wrap);
        return wrap;
    }

