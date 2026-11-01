-- HouseholdJournal -- B2 Zoi.FreelanceServer
-- The freelance board for the phone. The order list lives only in B2's FB2FreelanceManager and
-- B2 cannot write cfg files, so the board of the played character is printed to the Lua log,
-- where the bridge reads it and writes ui/phone/freelance/board.cfg for the phone. Licenses and
-- statistics the phone reads itself (entity.reflect FB2CareerComponent).
--
-- Board, printed when it changed and at least every KEEPALIVE_S, one report = these lines:
--   [HouseholdJournal] L <boot>,<round>,begin,<me>,<now ticks>,<initialized>,<playing>,<penalty>
--   [HouseholdJournal] A <boot>,<round>,<instance>,<summary>,<template>,<status>,<started ticks>,
--     <expire ticks>,<quest index>,<missions>,<client>,<recipient>,<target type>,<target>,<recipe>,
--     <crafting>,<craft percent>,<mission>                       (the active order, when there is one)
--   [HouseholdJournal] P <boot>,<round>,<path>,<next ticks>,<template>,<item>   (penalty flow)
--   [HouseholdJournal] O <boot>,<round>,<summary>,<template>,<reward>,<difficulty>,<generated ticks>,
--     <client type>,<client>,<site>,<recipient>,<target type>,<target>,<recipe>,<reason>
--     reason: EB1FreelanceOrderAcceptFailReason of ValidateAcceptOrder for <me>, 0 = can accept
--   [HouseholdJournal] L <boot>,<round>,end,<order count>
-- Ticks are game time, 600000000 per game minute.
--
-- Requests, sent by B1Main to the character they are for, from the phone's request.cfg:
--   "HouseholdJournal.freelance", content "<seq>:a:<summary>" accept, "<seq>:c" cancel the active
--   order. Licenses are applied for on the computer in the game, as the game's guide says.
-- Result:
--   [HouseholdJournal] R <boot>,<seq>,<ok|fail>,<actor>,<a|c>,<detail>

---@class FreelanceServer
local M = {}

local TAG = "[HouseholdJournal] "
local MESSAGE = "HouseholdJournal.freelance"
local CHECK_S = 3
local KEEPALIVE_S = 30
local POSSESSED_S = 2

local boot = tostring(os.time()) .. tostring(math.random(100, 999))
local round = 0
local lastSignature = ""
local lastPrinted = -1000
local lastCheck = -1000
local dirty = true
local possessedId = nil
local possessedAt = -1000

local function token(v)
    if v == nil then return "" end
    return (tostring(v):gsub("[^%w_%-%.]", ""))
end

local function short(err)
    return token(tostring(err)):sub(1, 60)
end

local function idText(v)
    local t = type(v)
    if t == "number" then return tostring(math.floor(v)) end
    if t == "string" then return token(v) end
    if t == "userdata" or t == "table" then
        local ok, inner = pcall(function() return v.Value end)
        if ok and inner ~= nil then return idText(inner) end
    end
    return ""
end

-- A field that may be missing or unreadable reads as "".
local function field(f)
    local ok, v = pcall(f)
    if not ok or v == nil then return "" end
    if type(v) == "boolean" then return v and "1" or "0" end
    if type(v) == "number" then
        if v == math.floor(v) then return string.format("%d", v) end
        return string.format("%.3f", v)
    end
    if type(v) == "userdata" or type(v) == "table" then return idText(v) end
    return token(v)
end

local function entityKey(n)
    local key = inzoi.FB1EntityId()
    key.Value = tonumber(n)
    return key
end

local function possessed(now)
    if now - possessedAt >= POSSESSED_S then
        possessedAt = now
        local ok, _, data = inzoi.cli.execute("entity.get_possessed")
        possessedId = ok and type(data) == "string" and data:match('"entity_id"%s*:%s*(%d+)') or nil
    end
    return possessedId
end

local function manager()
    local ok, mgr = pcall(function() return inzoi.getB2Manager("FB2FreelanceManager") end)
    if ok then return mgr end
    return nil
end

local function nowTicks()
    local ok, v = pcall(function() return inzoi.getB2Manager("FB2TimeManager"):GetCurrentTicks() end)
    if ok and v then return field(function() return v end) end
    return ""
end

local function line(kind, parts)
    return TAG .. kind .. " " .. boot .. "," .. tostring(round) .. "," .. table.concat(parts, ",")
end

local function activeFields(mgr, key)
    local okA, inst = pcall(function() return mgr:GetActiveOrderInstance(key) end)
    if not okA or not inst then return nil end
    local id = field(function() return inst.OrderInstanceId end)
    if id == "" or id == "-1" then return nil end
    return {
        id,
        field(function() return inst.SummaryId end),
        field(function() return inst.TemplateId end),
        field(function() return inst.Status end),
        field(function() return inst.StartedTimeTicks end),
        field(function() return inst.ExpireTimeTicks end),
        field(function() return inst.CurrentQuestIndex end),
        field(function() return inst.TotalMissionCount end),
        field(function() return inst.ClientInfo.EntityId end),
        field(function() return inst.RecipientInfo.EntityId end),
        field(function() return inst.RequestTarget.TargetType end),
        field(function() return inst.RequestTarget.TargetId end),
        field(function() return inst.RequestTarget.RecipeId end),
        field(function() return inst.bCrafting end),
        field(function() return math.floor((inst.CraftingProgressFraction or 0) * 100 + 0.5) end),
        field(function() return inst.CurrentMissionDtId end)
    }
end

local function penaltyFields(mgr, key)
    local okP, has = pcall(function() return mgr:HasActivePenaltyFlow(key) end)
    if not okP or not has then return nil end
    local okS, st = pcall(function() return mgr:FindPenaltyFlowState(key) end)
    if not okS or not st then return { "", "", "", "" } end
    return {
        field(function() return st.Path end),
        field(function() return st.NextTriggerTicks end),
        field(function() return st.OrderTemplateId end),
        field(function() return st.TargetItemId end)
    }
end

-- The board without the volatile now-ticks, to tell whether anything changed.
local function board(mgr, me)
    local key = entityKey(me)
    local orders = {}
    local okM, map = pcall(function() return mgr:GetOrderSummaryMap() end)
    if okM and map then
        pcall(function()
            for id, s in pairs(map) do
                local sid = idText(id)
                local reason = field(function() return mgr:ValidateAcceptOrder(key, tonumber(sid)) end)
                orders[#orders + 1] = {
                    sid = tonumber(sid) or 0,
                    text = table.concat({
                        sid,
                        field(function() return s.TemplateId end),
                        field(function() return s.BaseReward end),
                        field(function() return s.Difficulty end),
                        field(function() return s.GeneratedTicks end),
                        field(function() return s.ClientInfo.ClientType end),
                        field(function() return s.ClientInfo.EntityId end),
                        field(function() return s.ClientInfo.SpawnSiteEntityId end),
                        field(function() return s.RecipientInfo.EntityId end),
                        field(function() return s.RequestTarget.TargetType end),
                        field(function() return s.RequestTarget.TargetId end),
                        field(function() return s.RequestTarget.RecipeId end),
                        reason
                    }, ",")
                }
            end
        end)
    end
    table.sort(orders, function(a, b) return a.sid > b.sid end)
    return {
        initialized = field(function() return mgr.bFreelanceInitialized end),
        playing = field(function() return mgr:IsPlayingFreelanceOrder(key) end),
        penalty = penaltyFields(mgr, key),
        active = activeFields(mgr, key),
        orders = orders
    }
end

local function signature(me, b)
    local parts = { me, b.initialized, b.playing,
        b.penalty and table.concat(b.penalty, ",") or "", b.active and table.concat(b.active, ",") or "" }
    for _, o in ipairs(b.orders) do parts[#parts + 1] = o.text end
    return table.concat(parts, "|")
end

local function report(me, now)
    local mgr = manager()
    if not mgr then return end
    local b = board(mgr, me)
    local sig = signature(me, b)
    if not dirty and sig == lastSignature and now - lastPrinted < KEEPALIVE_S then return end
    dirty = false
    lastSignature = sig
    lastPrinted = now
    round = round + 1
    print(line("L", { "begin", me, nowTicks(), b.initialized, b.playing, b.penalty and "1" or "0" }))
    if b.active then print(line("A", b.active)) end
    if b.penalty then print(line("P", b.penalty)) end
    for _, o in ipairs(b.orders) do print(line("O", { o.text })) end
    print(line("L", { "end", tostring(#b.orders) }))
end

local function result(seq, ok, actor, op, detail)
    print(TAG .. "R " .. table.concat({ boot, token(seq), ok and "ok" or "fail", token(actor), token(op), token(detail) }, ","))
end

local function activeId(mgr, key)
    return field(function() return mgr:GetActiveOrderInstanceId(key) end)
end

local function accept(actor, seq, summary)
    local mgr = manager()
    if not mgr then return result(seq, false, actor, "a", "no_manager") end
    local key = entityKey(actor)
    local sid = tonumber(summary)
    local reason = field(function() return mgr:ValidateAcceptOrder(key, sid) end)
    if reason ~= "0" then return result(seq, false, actor, "a", "reason_" .. reason) end
    -- AcceptOrder has two out parameters; how the binding takes them is not documented, so the
    -- call with placeholders is tried first and the plain one after it. The active order is
    -- what tells whether it worked.
    local ok, err = pcall(function()
        return mgr:AcceptOrder(key, sid, inzoi.FB1FreelanceOrderInstanceId(), 0)
    end)
    if not ok then
        local ok2, err2 = pcall(function() return mgr:AcceptOrder(key, sid) end)
        if not ok2 then return result(seq, false, actor, "a", "error_" .. short(err) .. "_" .. short(err2)) end
    end
    local id = activeId(mgr, key)
    if id ~= "" and id ~= "-1" then return result(seq, true, actor, "a", id) end
    result(seq, false, actor, "a", "not_started")
end

local function cancel(actor, seq)
    local mgr = manager()
    if not mgr then return result(seq, false, actor, "c", "no_manager") end
    local key = entityKey(actor)
    local before = activeId(mgr, key)
    if before == "" or before == "-1" then return result(seq, false, actor, "c", "no_active_order") end
    local ok, done = pcall(function() return mgr:TryCancelFreelanceOrderByEntityId(key) end)
    if not ok then return result(seq, false, actor, "c", "error_" .. short(done)) end
    local after = activeId(mgr, key)
    if after == "" or after == "-1" then return result(seq, true, actor, "c", before) end
    result(seq, false, actor, "c", done and "still_active" or "refused")
end

---@param self table
---@param owner FB2Character
---@param dt number
function M.on_tick(self, owner, dt)
    local now = os.time()
    if not dirty and now - lastCheck < CHECK_S then return end
    local me = possessed(now)
    if not me then return end
    local okT, rawActor = pcall(function() return owner:GetEntityId() end)
    if not okT or idText(rawActor) ~= me then return end
    lastCheck = now
    local ok, err = pcall(report, me, now)
    if not ok then print(TAG .. "Q freelance_report_error " .. short(err)) end
end

---@param self table
---@param owner FB2Character
function M.on_lua_message(self, owner, ...)
    local args = { ... }
    for i = 1, #args do
        if args[i] == MESSAGE then
            local content = tostring(args[i + 1] or "")
            local okT, rawActor = pcall(function() return owner:GetEntityId() end)
            local actor = okT and idText(rawActor) or ""
            local seq, op, arg = content:match("^(%d+):([ac]):?(%d*)$")
            if not seq then return result("", false, actor, "", "bad_request") end
            local ok, err
            if op == "a" then ok, err = pcall(accept, actor, seq, arg)
            else ok, err = pcall(cancel, actor, seq) end
            if not ok then result(seq, false, actor, op, "error_" .. short(err)) end
            dirty = true
            return
        end
    end
end

return M
