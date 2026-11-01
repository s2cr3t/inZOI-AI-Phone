-- HouseholdJournal -- B2 Zoi.BuffReceiver
-- Adds the buff the SMS bridge asked for. B1Main reads the bridge's request file and sends each
-- request to the character who should get the buff; the message arrives here on that
-- character's binding. The other household member is recorded as the person who caused it, so
-- the game's reason text ("源自与{InitiatorName}的…") names them.
--
-- The buff goes through the component's normal deferred queue, the same path the game's own
-- conversations use, so the moodlet panel and notifications see it. The queue is processed on
-- the next tick, so B1Main sends a second message a few seconds later and the result is read
-- back then.
--
-- Messages: "HouseholdJournal.buff" and "HouseholdJournal.buffcheck",
--           content "<seq>:<initiator>:<buff id>"
-- Result, printed to the Lua log the bridge tails:
--   [HouseholdJournal] B <boot>,<seq>,<ok|fail>,<target>,<buff id>,<why>
-- ok with why "initiator_<id>" means the game kept a different initiator than the one asked for.

---@class BuffReceiver
local M = {}

local TAG = "[HouseholdJournal] "
local ADD = "HouseholdJournal.buff"
local CHECK = "HouseholdJournal.buffcheck"
local boot = tostring(os.time()) .. tostring(math.random(100, 999))

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

local function householdMembers()
    local ok, _, data = inzoi.cli.execute("household.get_members")
    if not ok or type(data) ~= "string" then return nil end
    local found = {}
    for id in data:gmatch('"entity_id"%s*:%s*(%d+)') do found[id] = true end
    return found
end

-- Parses the request and finds the buff component; calls fail(why) and returns nil on problems.
local function open(owner, content)
    local req = {}
    req.seq, req.initiator, req.buff = tostring(content or ""):match("^(%d+):(%d+):([%w_]+)$")
    local okT, rawTarget = pcall(function() return owner:GetEntityId() end)
    req.target = okT and idText(rawTarget) or ""
    req.done = function(ok, why)
        print(TAG .. "B " .. table.concat({ boot, token(req.seq), ok and "ok" or "fail", req.target, token(req.buff), token(why) }, ","))
    end
    if not req.seq then return req.done(false, "bad_request") end
    if req.target == "" then return req.done(false, "no_owner_id") end
    local okB, comp = pcall(function() return owner:GetComponent(inzoi.EB2ComponentType.Buff) end)
    if not okB or not comp then return req.done(false, "no_buff_component_" .. short(comp)) end
    req.comp = comp
    return req
end

-- Both people must be members of the played household: the bridge cannot hand buffs to anyone
-- else, whatever the request file says.
local function addBuff(owner, content)
    local req = open(owner, content)
    if not req then return end
    local members = householdMembers()
    if not members then return req.done(false, "no_members") end
    if not members[req.target] or not members[req.initiator] or req.target == req.initiator then
        return req.done(false, "not_household")
    end
    local okD, detail = pcall(function()
        local d = inzoi.FB1BuffDetail()
        d.Initiator = entityKey(req.initiator)
        d.CreateBuffReason = inzoi.EB1BuffCreateReason.Talk
        return d
    end)
    if not okD or not detail then return req.done(false, "no_detail_" .. short(detail)) end
    local okA, err = pcall(function() req.comp:AddBuff(req.buff, detail, "") end)
    if not okA then return req.done(false, "add_failed_" .. short(err)) end
end

local function checkBuff(owner, content)
    local req = open(owner, content)
    if not req then return end
    local okG, from = pcall(function()
        local b = req.comp:GetBuff(req.buff)
        if not b then return "" end
        return idText(b.Detail.Initiator)
    end)
    if not okG then return req.done(false, "check_failed_" .. short(from)) end
    if from == "" then
        local okH, has = pcall(function() return req.comp:HasBuff(req.buff) end)
        if okH and has == true then return req.done(true, "") end
        return req.done(false, "not_added")
    end
    if from ~= req.initiator then return req.done(true, "initiator_" .. from) end
    req.done(true, "")
end

---@param self table
---@param owner FB2Character
function M.on_lua_message(self, owner, ...)
    local args = { ... }
    for i = 1, #args do
        if args[i] == ADD then return addBuff(owner, args[i + 1]) end
        if args[i] == CHECK then return checkBuff(owner, args[i + 1]) end
    end
end

return M
