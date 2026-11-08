-- HouseholdJournal -- B2 Zoi.CareerServer
-- Carries out what only the simulation thread can do for the SMS bridge's work features:
-- leaving the company when the boss granted it (lib/career.js), and giving the character one of
-- its job's own after-work missions when the boss hands out a task (lib/workgroup.js). Promotions
-- and leave go through the game's own commands and need nothing here.
--
-- Request, sent by B1Main to the character, from the bridge's bridge/career.cfg:
--   "HouseholdJournal.career", content "<seq>:r:<company entity>"   leave that company
--   "HouseholdJournal.career", content "<seq>:q:<quest id>/<mission id>"   add that mission (the
--     game's FB2QuestComponent:AddQuestForCheat); detail added | already | not_added
--   "HouseholdJournal.career", content "<seq>:a:<partner>/<site>/<start HHmm>/<end HHmm>"   book an
--     appointment with that person at that site (lib/visits.js); detail booked_... | error_...
--   "HouseholdJournal.career", content "<seq>:v:<visitor>"   a visit, sent once the bridge has put
--     the visitor near the player. Someone from the town's crowd (no home, a passer-by, a suitor the
--     game made) is parked in EntityState TimelineSimulateOnly: they keep a schedule but have no body
--     the game runs, and anything done to them says they are busy. Put near the player they get a
--     body (GameSpawned) and stay parked. This does what the game's own visitor spawn does: out of
--     TimelineSimulateOnly, into GameSpawned and Simulate (reason SpawnVisitor), and the force flag
--     the game uses for the people of a karma event keeps them simulated in full while they are there.
--     detail visit_<city>_b<simulated><state>_t<..>_g<..>_s<..>_f<..> (each step: simulated T/F and
--     the EntityState after it; x after a letter: that step failed)
--   "HouseholdJournal.career", content "<seq>:e:<visitor>"   the visit is over: the flag off and, for
--     someone who was parked before, back to TimelineSimulateOnly; detail released_<simulated now>
--   "HouseholdJournal.career", content "<seq>:s:<character>"   how the game runs them, nothing
--     changed; detail sim_<simulated>_force_<forced>_state_<EntityState>_<city>
-- Result, printed to the Lua log the bridge tails:
--   [HouseholdJournal] C <boot>,<seq>,<ok|fail>,<actor>,<op>,<detail>
--   detail: left_<reason> | refused_<reason> | no_manager | error_...
-- The bridge checks the character's job afterwards; "ok" only says the game took the request.

---@class CareerServer
local M = {}

local TAG = "[HouseholdJournal] "
local MESSAGE = "HouseholdJournal.career"
-- EB1CareerLeaveReason names worth trying, the most fitting first. The enum is read at run time:
-- its values are not in the exported Lua API.
local REASONS = { "Voluntary", "VoluntaryLeave", "Resign", "Resignation", "Quit", "SelfLeave", "Self", "Normal", "None" }

local boot = tostring(os.time()) .. tostring(math.random(100, 999))
local reasonsShown = false

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

local function entityKey(n)
    local key = inzoi.FB1EntityId()
    key.Value = tonumber(n)
    return key
end

local function result(seq, ok, actor, op, detail)
    print(TAG .. "C " .. table.concat({ boot, token(seq), ok and "ok" or "fail", token(actor), token(op), token(detail) }, ","))
end

-- The leave reason to pass, and its name for the result line.
local function leaveReason()
    local okE, enum = pcall(function() return inzoi.EB1CareerLeaveReason end)
    if not okE or enum == nil then return 1, "n1" end
    if not reasonsShown then
        reasonsShown = true
        local names = {}
        pcall(function() for k in pairs(enum) do names[#names + 1] = tostring(k) end end)
        print(TAG .. "Q career_leave_reasons " .. token(table.concat(names, "|")))
    end
    for _, name in ipairs(REASONS) do
        local ok, v = pcall(function() return enum[name] end)
        if ok and v ~= nil then return v, name end
    end
    return 1, "n1"
end

local function addMission(owner, actor, seq, arg)
    local quest, mission = arg:match("^([%w_]+)/([%w_]+)$")
    if not quest then return result(seq, false, actor, "q", "bad_mission") end
    local okC, comp = pcall(function() return owner:GetComponent(inzoi.EB2ComponentType.Quest) end)
    if not okC or not comp then return result(seq, false, actor, "q", "no_component") end
    local okH, had = pcall(function() return comp:HasQuest(quest, mission) end)
    if okH and had then return result(seq, true, actor, "q", "already") end
    local ok, err = pcall(function() comp:AddQuestForCheat(quest, mission) end)
    if not ok then return result(seq, false, actor, "q", "error_" .. short(err)) end
    local okA, has = pcall(function() return comp:HasQuest(quest, mission) end)
    if okA and has then return result(seq, true, actor, "q", "added") end
    result(seq, false, actor, "q", okA and "not_added" or "unchecked")
end

-- An appointment the character makes with someone, the way the game's phone books one after an
-- accepted "meet up" message (FB2MobileMessageComponent:HandleAppointment): the partner then comes
-- to the site in the time window, brought by the game itself even when nobody simulates them now.
-- arg: <partner entity>/<site id>/<start HHmm>/<end HHmm>. detail: booked | error_...
local function appointment(owner, actor, seq, arg)
    local partner, site, startHm, endHm = arg:match("^(%d+)/([%w_]+)/(%d+)/(%d+)$")
    if not partner then return result(seq, false, actor, "a", "bad_appointment") end
    local okC, comp = pcall(function() return owner:GetComponent(inzoi.EB2ComponentType.MobileMessage) end)
    if not okC or not comp then return result(seq, false, actor, "a", "no_message_component") end
    local okD, data = pcall(function()
        local d = inzoi.FB1AppointmentData()
        d.SiteId = site
        d.StartTime = tonumber(startHm)
        d.EndTime = tonumber(endHm)
        return d
    end)
    if not okD or not data then return result(seq, false, actor, "a", "no_data_" .. short(data)) end
    local ok, err = pcall(function() comp:HandleAppointment(entityKey(partner), data) end)
    if not ok then return result(seq, false, actor, "a", "error_" .. short(err)) end
    result(seq, true, actor, "a", "booked_" .. partner .. "_" .. site .. "_" .. startHm)
end

-- The visitor, found by id: not necessarily simulated, so not reachable by a message of its own.
local function character(id)
    local okM, em = pcall(function() return inzoi.getB2Manager("FB2EntityManager") end)
    if not okM or not em then return nil, "no_entity_manager" end
    local okF, ch = pcall(function() return em:FindCharacter(entityKey(id)) end)
    if not okF or not ch then return nil, "not_found" end
    return ch
end

local function simText(ch)
    local okS, sim = pcall(function() return ch:IsSimulated() end)
    return okS and tostring(sim) or "unknown"
end

-- Where the game has them: a city id, or "-" when the game does not say.
local function cityText(ch)
    local okC, city = pcall(function() return ch:GetLocatedCityId() end)
    local s = okC and tostring(city) or ""
    return s ~= "" and s or "-"
end

local function entityStateText(ch)
    local okE, st = pcall(function() return ch:GetEntityState() end)
    return okE and tostring(st) or "unknown"
end

-- A step: its letter, "x" when it failed, then simulated (T/F) and the EntityState after it.
local function step(steps, name, ch, fn)
    local ok = pcall(fn)
    steps[#steps + 1] = name .. (ok and "" or "x") .. (simText(ch) == "true" and "T" or "F") .. entityStateText(ch)
end

-- Visitors this mod took out of TimelineSimulateOnly, by id: put back there when the visit ends.
local unparked = {}

local function visit(actor, seq, op, arg)
    local id = arg:match("^(%d+)$")
    if not id then return result(seq, false, actor, op, "bad_visitor") end
    local ch, why = character(id)
    if not ch then return result(seq, false, actor, op, why) end
    local S = inzoi.EB2EntityState
    local R = inzoi.EB2EntityStateChangeReason
    if op == "s" then
        local okF, forced = pcall(function() return ch:IsForceSimulationLevelOfDetailZero() end)
        return result(seq, true, actor, op, "sim_" .. simText(ch) .. "_force_" .. (okF and tostring(forced) or "unknown") .. "_state_" .. entityStateText(ch) .. "_" .. cityText(ch))
    end
    if op == "e" then
        pcall(function() ch:SetForceSimulationLevelOfDetailZero(false) end)
        if unparked[id] then
            unparked[id] = nil
            pcall(function() ch:RemoveEntityState(S.Simulate, R.NpcTimeline) end)
            pcall(function() ch:AddEntityState(S.TimelineSimulateOnly, R.NpcTimeline) end)
        end
        return result(seq, true, actor, op, "released_" .. simText(ch))
    end
    local steps = { "b" .. (simText(ch) == "true" and "T" or "F") .. entityStateText(ch) }
    local okP, parked = pcall(function() return ch:HasEntityState(S.TimelineSimulateOnly) end)
    if okP and parked then
        unparked[id] = true
        step(steps, "t", ch, function() ch:RemoveEntityState(S.TimelineSimulateOnly, R.SpawnVisitor) end)
        step(steps, "g", ch, function() ch:AddEntityState(S.GameSpawned, R.SpawnVisitor) end)
        step(steps, "s", ch, function() ch:AddEntityState(S.Simulate, R.SpawnVisitor) end)
    end
    step(steps, "f", ch, function() ch:SetForceSimulationLevelOfDetailZero(true) end)
    result(seq, true, actor, op, "visit_" .. cityText(ch) .. "_" .. table.concat(steps, "_"))
end

local function leave(actor, seq, company)
    local okM, mgr = pcall(function() return inzoi.getB2Manager("FB2CareerManager") end)
    if not okM or not mgr then return result(seq, false, actor, "r", "no_manager") end
    local reason, name = leaveReason()
    local ok, done = pcall(function() return mgr:RequestLeaveCareerByEntity(entityKey(actor), entityKey(company), reason) end)
    if not ok then return result(seq, false, actor, "r", "error_" .. short(done)) end
    if done == false then return result(seq, false, actor, "r", "refused_" .. name) end
    result(seq, true, actor, "r", "left_" .. name)
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
            local seq, op, arg = content:match("^(%d+):(%a):([%w_/]+)$")
            if not seq or not ("rqaves"):find(op, 1, true) then return result(seq or "", false, actor, op or "", "bad_request") end
            local ok, err
            if op == "q" then ok, err = pcall(addMission, owner, actor, seq, arg)
            elseif op == "a" then ok, err = pcall(appointment, owner, actor, seq, arg)
            elseif op == "v" or op == "e" or op == "s" then ok, err = pcall(visit, actor, seq, op, arg)
            else ok, err = pcall(leave, actor, seq, arg) end
            if not ok then result(seq, false, actor, op, "error_" .. short(err)) end
            return
        end
    end
end

return M
