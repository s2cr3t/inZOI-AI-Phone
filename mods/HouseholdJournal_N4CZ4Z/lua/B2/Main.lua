-- HouseholdJournal -- B2 Main
-- Reports to the SMS bridge what its MCP reads cannot see: how the played household's
-- interactions start and end (finished, canceled with the game's reason, failed), and the state
-- of the food lying around the played character's lot (spoiled, finished, how much is left).
-- Reads game state only. Buffs the bridge asks for are added by Zoi.BuffReceiver, which prints
-- the B line below.
--
-- Interaction events fire only in B2, and B2 cannot write cfg files, so each report is printed
-- to the Lua log (BlueClient/Saved/inzoi_lua.log), which the bridge tails read-only:
--   [HouseholdJournal] J <boot>,<seq>,<kind>,<entity>,<bag>,<target>,<reason>
--   [HouseholdJournal] H <boot>,<members>,<subscriptions>,<errors>,<features>      (heartbeat)
--     features: what this version of the mod can do for the bridge, "|"-separated
--     (give = Zoi.MealServer serves a dish to a person, modes g and h;
--      freelance = Zoi.FreelanceServer prints the L/A/P/O board and R results)
--   [HouseholdJournal] F <boot>,<objects walked>,<cpu ms>;<id>:<s|e|f>:<percent left>;...
--     s = spoiled, e = eaten up / empty plate, f = still good to eat
--   [HouseholdJournal] B <boot>,<seq>,<ok|fail>,<target>,<buff id>,<why>      (buff request result)
--   [HouseholdJournal] M <boot>;<id>:<container>:<object id>:<servings left>:<servings>:<s|f>;...
--     family meals (PreparedFood) stored inside a container such as a fridge, after each scan
--   [HouseholdJournal] T <boot>,<seq>,<stage>,<actor>,<dish>,<detail>
--     progress of a "take a family meal out" request, printed by Zoi.MealServer
--   [HouseholdJournal] E <boot>,<seq>,<event>,<a>,<b>,<c>,<d>
--     a turning point of the household or the city (events = this line is printed):
--     zoi.died a=who b=reason c=became_ghost      zoi.born a=baby b=mother c=father
--     zoi.pregnancy_begin / _cancel a=who b=father zoi.growth_changed a=who b=from c=to
--     zoi.married / zoi.divorced a=who b=partner   weather.changed b=from c=to d=is_disaster
--     Zoi events are printed only when someone of the played household is in them.

local TAG = "[HouseholdJournal] "
-- beat: Zoi.MealServer prints a W line every 30 s while the B2 bindings are registered.
local FEATURES = "give|events|freelance|beat|age|career|mission"
local HEARTBEAT_S = 30
local MEMBERS_EVERY_S = 60
local FOOD_EVERY_S = 30
local FOOD_MAX = 200
local FOOD_SLICE = 500
local STORED_MAX = 100

local M = {}

local boot = tostring(os.time()) .. tostring(math.random(100, 999))
local seq = 0
local members = {}
local memberCount = 0
local errors = 0
local subs = 0
local handles = {}
local lastMembers = -1000
local lastBeat = -1000
local lastFood = -1000
local entities = nil

local function token(v)
    if v == nil then return "" end
    return (tostring(v):gsub("[^%w_%-%.]", ""))
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

local function refreshMembers()
    local ok, _, data = inzoi.cli.execute("household.get_members")
    if not ok or type(data) ~= "string" then
        errors = errors + 1
        return
    end
    local found = {}
    local n = 0
    for id in data:gmatch('"entity_id"%s*:%s*(%d+)') do
        if not found[id] then
            found[id] = true
            n = n + 1
        end
    end
    if n > 0 then
        members = found
        memberCount = n
    end
end

local function field(p, a, b)
    if type(p) ~= "table" then return nil end
    local v = p[a]
    if v == nil and b then v = p[b] end
    return v
end

local function report(kind, p)
    local id = token(field(p, "entity_id"))
    if id == "" or not members[id] then return end
    seq = seq + 1
    print(TAG .. "J " .. table.concat({
        boot, tostring(seq), kind, id,
        token(field(p, "interaction_bag_id")),
        token(field(p, "target_entity_id")),
        token(field(p, "reason", "Reason"))
    }, ","))
end

local function heartbeat()
    print(TAG .. "H " .. boot .. "," .. tostring(memberCount) .. "," .. tostring(subs) .. "," .. tostring(errors) .. "," .. FEATURES)
end

-- Age, how far the person is through the stage they are in, and the age the game picked for
-- their death. The game keeps all three in the Bio component and no MCP table carries them, so
-- they are printed here: the phone's AI needs them to say how long until someone grows up, comes
-- of age or grows old. The growth step goes out as its EB1GrowthStep number; the bridge names it.
--   [HouseholdJournal] A <boot>;<id>:<growth>:<age>:<days in stage>:<death age>:<born day>:<paused>;<...>
-- The numbers are days: a newborn is 0, an elderly Zoi is in the nineties, and every stage of the
-- Aging table lasts the same ten of them.
local AGE_EVERY_S = 60
local lastAge = -1000

local function entityKey(n)
    local key = inzoi.FB1EntityId()
    key.Value = tonumber(n)
    return key
end

local function num(v)
    if type(v) == "number" then return math.floor(v) end
    return nil
end

local function ages()
    local okM, mgr = pcall(function() return inzoi.getB2Manager("FB2EntityManager") end)
    if not okM or not mgr then
        errors = errors + 1
        return
    end
    local parts = {}
    for id in pairs(members) do
        local okC, ch = pcall(function() return mgr:FindCharacter(entityKey(id)) end)
        if okC and ch then
            local okB, bio = pcall(function() return ch:GetComponent(inzoi.EB2ComponentType.Bio) end)
            if okB and bio then
                local _, age = pcall(function() return bio:GetAge() end)
                local _, prog = pcall(function() return bio:GetAgeProgress() end)
                local _, step = pcall(function() return bio:GetGrowthStep() end)
                local _, dead = pcall(function() return bio:GetDeadAge() end)
                local _, born = pcall(function() return bio:GetBornDay() end)
                local _, paused = pcall(function() return bio:IsAgingPaused() end)
                local a = num(age)
                if a then
                    local g = num(step)
                    parts[#parts + 1] = table.concat({
                        id,
                        g and tostring(g) or token(step),
                        tostring(a),
                        string.format("%.3f", tonumber(prog) or 0),
                        tostring(num(dead) or -1),
                        tostring(num(born) or -1),
                        paused == true and "1" or "0"
                    }, ":")
                end
            end
        end
    end
    if #parts > 0 then print(TAG .. "A " .. boot .. ";" .. table.concat(parts, ";")) end
end

-- The lot scan command is B1-only, so the whole world's objects are walked here a slice per
-- tick and every food object is reported with its state. Food that needs dealing with goes
-- first so the cap never drops it. The bridge keeps the ones that are on its own lot.
local scan = nil

local function foodMark(obj)
    local okS, spoiled = pcall(function() return obj:IsSpoiled() end)
    if not okS or type(spoiled) ~= "boolean" then return nil end
    local _, empty = pcall(function() return obj:IsEmptyFood() end)
    local kind
    if spoiled then
        kind = "s"
    elseif empty == true then
        kind = "e"
    else
        local _, edible = pcall(function() return obj:IsEdible() end)
        if edible ~= true then return nil end
        kind = "f"
    end
    local _, id = pcall(function() return obj:GetEntityId() end)
    local _, rate = pcall(function() return obj:GetRemainRate() end)
    local left = type(rate) == "number" and math.floor(rate * 100 + 0.5) or -1
    return token(id) .. ":" .. kind .. ":" .. tostring(left), kind
end

-- A family meal kept in a container (the fridge). The inventory picker is the only way the game
-- offers to take one out, so the bridge learns from this which dish to ask Zoi.MealServer for.
local function storedDish(obj, kind)
    if kind ~= "s" and kind ~= "f" then return nil end
    local okM, master = pcall(function() return obj:GetInventoryMasterEntityId() end)
    local container = okM and idText(master) or ""
    if container == "" or container == "-1" or container == "0" then return nil end
    local okT, prepared = pcall(function() return obj:HasObjectTag("PreparedFood") end)
    if not okT or prepared ~= true then return nil end
    local _, id = pcall(function() return obj:GetEntityId() end)
    local _, objectId = pcall(function() return obj:GetObjectId() end)
    local _, left = pcall(function() return obj:GetRemainQuantity() end)
    local _, total = pcall(function() return obj:GetTotalQuantity() end)
    return table.concat({
        idText(id), container, token(objectId),
        tostring(type(left) == "number" and math.floor(left) or -1),
        tostring(type(total) == "number" and math.floor(total) or -1),
        kind
    }, ":")
end

local function startFoodScan()
    if not entities then return end
    local ok, list = pcall(function() return entities:GetAllEntities(inzoi.EB2EntityType.GameObject):ToTable() end)
    if not ok or type(list) ~= "table" then
        errors = errors + 1
        return
    end
    scan = { list = list, i = 1, parts = {}, fresh = {}, stored = {}, cpu = 0 }
end

local function stepFoodScan()
    local t0 = os.clock()
    local list = scan.list
    local stop = math.min(scan.i + FOOD_SLICE - 1, #list)
    for i = scan.i, stop do
        local obj = list[i]
        if obj then
            local s, kind = foodMark(obj)
            if s then
                local into = kind == "f" and scan.fresh or scan.parts
                if #into < FOOD_MAX then into[#into + 1] = s end
                if #scan.stored < STORED_MAX then
                    local dish = storedDish(obj, kind)
                    if dish then scan.stored[#scan.stored + 1] = dish end
                end
            end
        end
    end
    scan.i = stop + 1
    scan.cpu = scan.cpu + (os.clock() - t0)
    if scan.i > #list then
        for i = 1, #scan.fresh do
            if #scan.parts >= FOOD_MAX then break end
            scan.parts[#scan.parts + 1] = scan.fresh[i]
        end
        print(TAG .. "F " .. boot .. "," .. tostring(#list) .. "," .. tostring(math.floor(scan.cpu * 1000)) .. ";" .. table.concat(scan.parts, ";"))
        print(TAG .. "M " .. boot .. ";" .. table.concat(scan.stored, ";"))
        scan = nil
    end
end

local KINDS = {
    ["interaction.started"] = "started",
    ["interaction.finished"] = "finished",
    ["interaction.canceled"] = "canceled",
    ["interaction.failed"] = "failed"
}

-- Payload fields of each world event, in the order of a,b,c,d on the E line.
local WORLD = {
    ["zoi.died"] = { "entity_id", "reason", "became_ghost" },
    ["zoi.born"] = { "baby_entity_id", "mother_entity_id", "father_entity_id" },
    ["zoi.pregnancy_begin"] = { "entity_id", "father_entity_id" },
    ["zoi.pregnancy_cancel"] = { "entity_id", "father_entity_id" },
    ["zoi.growth_changed"] = { "entity_id", "from_step", "to_step" },
    ["zoi.married"] = { "entity_id", "partner_entity_id" },
    ["zoi.divorced"] = { "entity_id", "partner_entity_id" },
    ["weather.changed"] = { "", "from_weather", "to_weather", "is_disaster" }
}

local function worldValue(p, name)
    if name == "" then return "" end
    local v = field(p, name)
    if v == nil then
        local up = name:gsub("^%l", string.upper)
        v = field(p, up)
    end
    if type(v) == "boolean" then return v and "true" or "false" end
    local id = idText(v)
    if id ~= "" then return id end
    return token(v)
end

local function reportWorld(event, p)
    local names = WORLD[event]
    local values = {}
    local ours = event:sub(1, 4) ~= "zoi."
    for i = 1, 4 do
        local v = names[i] and worldValue(p, names[i]) or ""
        values[i] = v
        if v ~= "" and members[v] then ours = true end
    end
    if not ours then return end
    seq = seq + 1
    print(TAG .. "E " .. table.concat({ boot, tostring(seq), event, values[1], values[2], values[3], values[4] }, ","))
end

function M.on_begin()
    local okM, mgr = pcall(function() return inzoi.getB2Manager("FB2EntityManager") end)
    if okM and mgr then entities = mgr else errors = errors + 1 end
    refreshMembers()
    lastMembers = os.time()
    for event, kind in pairs(KINDS) do
        local h = inzoi.event.on(event, function(p) report(kind, p) end)
        if h and h ~= 0 then
            handles[event] = h
            subs = subs + 1
        else
            errors = errors + 1
        end
    end
    for event in pairs(WORLD) do
        local hw = inzoi.event.on(event, function(p) reportWorld(event, p) end)
        if hw and hw ~= 0 then
            handles[event] = hw
            subs = subs + 1
        else
            errors = errors + 1
        end
    end
    local h = inzoi.event.on("time.hour_changed", function() refreshMembers() end)
    if h and h ~= 0 then handles["time.hour_changed"] = h end
    heartbeat()
    lastBeat = os.time()
end

function M.on_tick()
    local now = os.time()
    if now - lastMembers >= MEMBERS_EVERY_S or memberCount == 0 and now - lastMembers >= 5 then
        lastMembers = now
        refreshMembers()
    end
    if now - lastBeat >= HEARTBEAT_S then
        lastBeat = now
        heartbeat()
    end
    if now - lastAge >= AGE_EVERY_S then
        lastAge = now
        ages()
    end
    if scan then
        stepFoodScan()
    elseif now - lastFood >= FOOD_EVERY_S then
        lastFood = now
        startFoodScan()
    end
end

function M.on_end()
    for event, h in pairs(handles) do inzoi.event.off(event, h) end
    handles = {}
end

return M
