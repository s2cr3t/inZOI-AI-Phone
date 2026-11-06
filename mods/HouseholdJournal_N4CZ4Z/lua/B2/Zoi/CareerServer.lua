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
            if not seq or (op ~= "r" and op ~= "q" and op ~= "a") then return result(seq or "", false, actor, op or "", "bad_request") end
            local ok, err
            if op == "q" then ok, err = pcall(addMission, owner, actor, seq, arg)
            elseif op == "a" then ok, err = pcall(appointment, owner, actor, seq, arg)
            else ok, err = pcall(leave, actor, seq, arg) end
            if not ok then result(seq, false, actor, op, "error_" .. short(err)) end
            return
        end
    end
end

return M
