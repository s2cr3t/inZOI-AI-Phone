-- RoomLights -- B2 Main
-- Turns the played household's lamps on only in rooms that currently have someone in them,
-- and off when the room is empty. The game's own switch is one lamp at a time or the
-- whole lot at once. This follows people instead.
--
-- The switch is the lamp's own OnOff state, the same one the game's "turn off the light"
-- interaction sets: state group OnOff / state On is a switched-off lamp, Normal / Normal is
-- a lit one. A lamp is only switched when its state differs from what its room calls for,
-- so a lamp the game or the player switches back is corrected on the next pass (about
-- two seconds) and nothing is sent while everything is already right.
--
-- A lamp is an object tagged AutoOnOff, or listed in LightObject / LightObject_E01. One the
-- engine refuses to switch is left alone for the rest of the session.
-- A lamp the game says is outdoors, or whose point is not inside any room, is left alone.
-- Someone awake in a room keeps it lit, guests too. Someone asleep or dozing does not:
-- a room where everyone is sleeping goes dark, and lights again when they get up.
-- The lot is the household home only. A cafe or a workplace is not controlled.
-- Power cut: leave the game in charge until the power is back.
-- Lamps this mod switched off are switched back on when the mod stops.
--
-- Log lines, one physical line each, in BlueClient/Saved/inzoi_lua.log:
--   [RoomLights] ready <boot>,<how many lamp ids>
--   [RoomLights] site <home site entity id>
--   [RoomLights] S <boot>,<site>,<people>,<lit>,<dark>,<yard>,<unplaced>,<rooms>,<switched>,<errors>,<asleep>
--   people counts only those awake; asleep is how many on the lot were left out as sleeping.
--   [RoomLights] E <what failed, once per kind>
--   [RoomLights] D reverted <lamp> <state>   a lamp we switched off was switched back by the game
--   [RoomLights] D on-failed|off-failed <lamp> ...   the engine did not take the change
-- lit/dark are lamps we control. yard and unplaced were left as the game had them.
-- switched is how many lamps were turned on or off during this pass.

local TAG = "[RoomLights] "
local SLICE = 48
local CYCLE_GAP_S = 2
local MEMBER_EVERY_S = 30
local BACKOFF_S = 5
local LOWER_CM = 100
local OFF_GROUP, OFF_STATE = "OnOff", "On"
local ON_GROUP, ON_STATE = "Normal", "Normal"

local M = {}

local boot = tostring(os.time()) .. tostring(math.random(100, 999))
local mgr = nil
-- One entry per lamp id from LightObject and LightObject_E01.
-- The number is how many light components that lamp declares.
local LIGHTS = {
    ["BP_Lighting01_v38"] = 1,
    ["BP_Lighting01_v39"] = 1,
    ["BP_Lighting01_v40"] = 1,
    ["ChristmasSnowFlakeLighting01"] = 1,
    ["ChristmasSnowFlakeLighting01_01"] = 1,
    ["ChristmasSnowFlakeLighting01_02"] = 1,
    ["ChristmasSnowFlakeLighting01_03"] = 1,
    ["ChristmasSnowFlakeLighting01_v01"] = 1,
    ["ChristmasSnowFlakeLighting01_v01_01"] = 1,
    ["ChristmasSnowFlakeLighting01_v01_02"] = 1,
    ["ChristmasSnowFlakeLighting01_v01_03"] = 1,
    ["ChristmasSnowFlakeLighting01_v02"] = 1,
    ["ChristmasSnowFlakeLighting01_v02_01"] = 1,
    ["ChristmasSnowFlakeLighting01_v02_02"] = 1,
    ["ChristmasSnowFlakeLighting01_v02_03"] = 1,
    ["ChristmasSnowFlakeLighting01_v03"] = 1,
    ["ChristmasSnowFlakeLighting01_v03_01"] = 1,
    ["ChristmasSnowFlakeLighting01_v03_02"] = 1,
    ["ChristmasSnowFlakeLighting01_v03_03"] = 1,
    ["ChristmasSnowFlakeLighting02"] = 1,
    ["ChristmasSnowFlakeLighting02_01"] = 1,
    ["ChristmasSnowFlakeLighting02_02"] = 1,
    ["ChristmasSnowFlakeLighting02_03"] = 1,
    ["E01_Lighting01"] = 1,
    ["E01_Lighting01_v01"] = 1,
    ["E01_Lighting01_v02"] = 1,
    ["E01_Lighting01_v03"] = 1,
    ["E01_Lighting02"] = 1,
    ["E01_Lighting02_v01"] = 1,
    ["E01_Lighting02_v02"] = 1,
    ["E01_Lighting02_v03"] = 1,
    ["E01_SeafoodSkewer01"] = 1,
    ["E01_SkewerStall01"] = 1,
    ["GymLamp01"] = 1,
    ["GymLamp01_v01"] = 1,
    ["GymLamp01_v02"] = 1,
    ["GymLamp01_v03"] = 1,
    ["KoreanLanterns01"] = 1,
    ["Light_Robot_Head01_v01"] = 1,
    ["Lighting01"] = 1,
    ["Lighting01_v01"] = 1,
    ["Lighting01_v02"] = 1,
    ["Lighting01_v03"] = 1,
    ["Lighting01_v04"] = 1,
    ["Lighting01_v05"] = 1,
    ["Lighting01_v06"] = 1,
    ["Lighting01_v08"] = 1,
    ["Lighting01_v09"] = 1,
    ["Lighting01_v10"] = 1,
    ["Lighting01_v11"] = 1,
    ["Lighting01_v12"] = 1,
    ["Lighting01_v13"] = 1,
    ["Lighting01_v14"] = 1,
    ["Lighting01_v15"] = 1,
    ["Lighting01_v16"] = 1,
    ["Lighting01_v17"] = 1,
    ["Lighting01_v19"] = 1,
    ["Lighting01_v20"] = 1,
    ["Lighting01_v21"] = 1,
    ["Lighting01_v22"] = 1,
    ["Lighting01_v23"] = 1,
    ["Lighting01_v24"] = 1,
    ["Lighting01_v25"] = 1,
    ["Lighting01_v26"] = 1,
    ["Lighting01_v27"] = 1,
    ["Lighting01_v28"] = 1,
    ["Lighting01_v29"] = 1,
    ["Lighting01_v30"] = 1,
    ["Lighting01_v31"] = 1,
    ["Lighting01_v32"] = 1,
    ["Lighting01_v33"] = 1,
    ["Lighting01_v34"] = 1,
    ["Lighting01_v36"] = 1,
    ["Lighting01_v37"] = 1,
    ["Lighting01_v44"] = 1,
    ["Lighting01_v45"] = 1,
    ["Lighting01_v46"] = 1,
    ["Lighting01_v47"] = 1,
    ["Lighting01_v48"] = 1,
    ["Lighting01_v49"] = 1,
    ["Lighting01_v50"] = 1,
    ["Lighting02"] = 1,
    ["Lighting02_01"] = 1,
    ["Lighting02_02"] = 1,
    ["Lighting02_03"] = 1,
    ["Lighting02_v01"] = 1,
    ["Lighting02_v01_01"] = 1,
    ["Lighting02_v01_02"] = 1,
    ["Lighting02_v01_03"] = 1,
    ["Lighting02_v02"] = 1,
    ["Lighting02_v03"] = 1,
    ["Lighting02_v03_01"] = 1,
    ["Lighting02_v03_02"] = 1,
    ["Lighting02_v03_03"] = 1,
    ["Lighting02_v04"] = 1,
    ["Lighting02_v05"] = 1,
    ["Lighting02_v06"] = 1,
    ["Lighting02_v07"] = 1,
    ["Lighting02_v08"] = 1,
    ["Lighting02_v08_01"] = 1,
    ["Lighting02_v08_02"] = 1,
    ["Lighting02_v08_03"] = 1,
    ["Lighting02_v09"] = 1,
    ["Lighting02_v09_01"] = 1,
    ["Lighting02_v09_02"] = 1,
    ["Lighting02_v09_03"] = 1,
    ["Lighting02_v10"] = 1,
    ["Lighting02_v11"] = 1,
    ["Lighting02_v12"] = 1,
    ["Lighting02_v13"] = 1,
    ["Lighting02_v13_01"] = 1,
    ["Lighting02_v13_02"] = 1,
    ["Lighting02_v13_03"] = 1,
    ["Lighting02_v14"] = 1,
    ["Lighting02_v14_01"] = 1,
    ["Lighting02_v14_02"] = 1,
    ["Lighting02_v14_03"] = 1,
    ["Lighting02_v15"] = 1,
    ["Lighting02_v16"] = 1,
    ["Lighting02_v16_01"] = 1,
    ["Lighting02_v16_02"] = 1,
    ["Lighting02_v16_03"] = 1,
    ["Lighting02_v17"] = 1,
    ["Lighting02_v18"] = 1,
    ["Lighting02_v18_01"] = 1,
    ["Lighting02_v18_02"] = 1,
    ["Lighting02_v18_03"] = 1,
    ["Lighting02_v19"] = 1,
    ["Lighting02_v20"] = 1,
    ["Lighting02_v21"] = 1,
    ["Lighting02_v22"] = 1,
    ["Lighting02_v22_01"] = 1,
    ["Lighting02_v22_02"] = 1,
    ["Lighting02_v22_03"] = 1,
    ["Lighting02_v23"] = 1,
    ["Lighting02_v24"] = 1,
    ["Lighting02_v24_01"] = 1,
    ["Lighting02_v24_02"] = 1,
    ["Lighting02_v24_03"] = 1,
    ["Lighting02_v25"] = 1,
    ["Lighting02_v25_01"] = 1,
    ["Lighting02_v25_02"] = 1,
    ["Lighting02_v25_03"] = 1,
    ["Lighting02_v26"] = 1,
    ["Lighting02_v26_01"] = 1,
    ["Lighting02_v26_02"] = 1,
    ["Lighting02_v26_03"] = 1,
    ["Lighting02_v27"] = 1,
    ["Lighting02_v28"] = 1,
    ["Lighting02_v29"] = 1,
    ["Lighting02_v30"] = 1,
    ["Lighting02_v31"] = 1,
    ["Lighting02_v32"] = 1,
    ["Lighting02_v33"] = 1,
    ["Lighting02_v34"] = 1,
    ["Lighting02_v35"] = 1,
    ["Lighting02_v37"] = 1,
    ["Lighting02_v38"] = 1,
    ["Lighting02_v39"] = 1,
    ["Lighting02_v40"] = 1,
    ["Lighting02_v41"] = 1,
    ["Lighting02_v42"] = 1,
    ["Lighting02_v43"] = 1,
    ["Lighting02_v44"] = 1,
    ["Lighting02_v45"] = 1,
    ["Lighting06"] = 1,
    ["Lighting08"] = 1,
    ["Mirrorball01"] = 1,
    ["Mirrorball02"] = 1,
    ["Shadow_Lighting01_v03"] = 1,
    ["Shadow_Lighting01_v25"] = 1,
    ["Shadow_Lighting02_v02"] = 1,
    ["Shadow_Lighting02_v12"] = 1,
    ["Shadow_Lighting02_v17"] = 1,
    ["Shadow_Lighting02_v34"] = 1,
    ["Shadow_Lighting02_v35"] = 1,
    ["Shadow_Lighting04"] = 1,
    ["StudioAreaLight"] = 1,
    ["StudioPointLight"] = 1,
    ["StudioSpotLight"] = 1,
}
local catalogCount = 0
local catalogLower = nil
local members = {}
local memberCount = 0
local lastMembers = -1000
local switchedOff = {}
local refused = {}
local noted = {}
local errors = 0
local scan = nil
local nextScan = 0
local lastReport = -1000
local reported = false
local siteSeen = false
local roomsBroken = false
local roomStrikes = 0
local ready = false

local function short(err)
    local s = tostring(err)
    s = s:gsub("[%c]", " ")
    if #s > 160 then s = s:sub(1, 160) end
    return s
end

local function noteOnce(kind, err)
    if noted[kind] then return end
    noted[kind] = true
    print(TAG .. "E " .. kind .. " " .. short(err))
end

local function idText(v)
    local t = type(v)
    if t == "number" then return tostring(math.floor(v)) end
    if t == "string" then
        return (v:gsub("[^%w_%-%.]", ""))
    end
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

local function asTable(v)
    if type(v) == "table" then return v end
    if v == nil then return nil end
    local ok, t = pcall(function() return v:ToTable() end)
    if ok and type(t) == "table" then return t end
    return nil
end

-- TArray comes back as userdata. An empty list and a map both report length 0,
-- so a map is walked once into a plain array.
local function listOf(v)
    if v == nil then return nil end
    local t = v
    if type(t) ~= "table" then
        t = asTable(v)
        if not t then return nil end
    end
    if #t > 0 then return t end
    local arr = {}
    for _, item in pairs(t) do
        arr[#arr + 1] = item
    end
    if #arr == 0 then return t end
    return arr
end

local function catalogCountOf()
    local n = 0
    for _ in pairs(LIGHTS) do n = n + 1 end
    return n
end

local function catalogHit(id)
    if type(id) ~= "string" or id == "" then return false end
    if LIGHTS[id] ~= nil then return true end
    if not catalogLower then
        catalogLower = {}
        for k in pairs(LIGHTS) do catalogLower[k:lower()] = true end
    end
    local bare = id:match("([^%./]+)$") or id
    return catalogLower[bare:lower()] == true
end

local function hasTag(obj, tag)
    local ok, v = pcall(function() return obj:HasObjectTag(tag) end)
    return ok and v == true
end

-- Every lamp the game can switch carries AutoOnOff. Tax_Light alone is not enough:
-- a lit wall mirror is on the electricity bill but has no switch. The tables back
-- the tag up for lamps whose tags could not be read.
local function isLamp(obj, objectId)
    if hasTag(obj, "AutoOnOff") then return true end
    return catalogHit(objectId)
end

local function stateOf(obj)
    local okC, comp = pcall(function() return obj:GetComponent(inzoi.EB2ComponentType.State) end)
    if not okC or comp == nil then return nil, nil, okC and "no-state-component" or comp end
    local okS, off = pcall(function() return comp:IsInState(OFF_GROUP, OFF_STATE) end)
    if not okS or type(off) ~= "boolean" then return nil, nil, okS and "state-type" or off end
    return comp, not off, nil
end

local function isOnNow(comp)
    local ok, off = pcall(function() return comp:IsInState(OFF_GROUP, OFF_STATE) end)
    if not ok or type(off) ~= "boolean" then return nil end
    return not off
end

local function currentState(comp)
    local okG, g = pcall(function() return comp:GetCurrentStateGroupId() end)
    local okI, s = pcall(function() return comp:GetCurrentStateId() end)
    return tostring(okG and g or "?") .. "/" .. tostring(okI and s or "?")
end

local diag = {}

local function diagOnce(kind, text)
    if diag[kind] then return end
    diag[kind] = true
    print(TAG .. "D " .. kind .. " " .. short(text))
end

-- The engine takes an instigator with every state change, the way the game's own
-- "turn off the light" passes the Zoi who flipped the switch. Without it the call
-- does nothing. A household member stands in for that Zoi; the lamp itself is the
-- fallback when no member could be resolved. Only this lamp's component is touched:
-- the site-wide state call switches every object that has an OnOff state (stove,
-- microwave, beds), so it is never used here.
local function instigatorFor(eid)
    local id = next(members)
    if id then return entityKey(id) end
    return eid
end

local function switchLamp(comp, on, eid, key)
    local group = on and ON_GROUP or OFF_GROUP
    local id = on and ON_STATE or OFF_STATE
    local okC, errC = pcall(function() comp:ChangeState(group, id, instigatorFor(eid)) end)
    if okC and isOnNow(comp) == on then return true, nil end
    diagOnce(on and "on-failed" or "off-failed", key .. " call=" .. tostring(okC) .. ":" .. short(errC)
        .. " now=" .. currentState(comp))
    return false, "not-applied"
end

local function refreshMembers()
    local ok, _, data = inzoi.cli.execute("household.get_members")
    if not ok or type(data) ~= "string" then return end
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

local function resolveHome()
    local bestText, bestN = "", 0
    local ids = {}
    for id in pairs(members) do
        local okC, ch = pcall(function() return mgr:FindCharacter(entityKey(id)) end)
        if okC and ch then
            local okH, hid = pcall(function() return ch:GetHomeSiteEntityId(false) end)
            local text = okH and idText(hid) or ""
            if text ~= "" and text ~= "0" and text ~= "-1" then
                local n = (ids[text] and ids[text].n or 0) + 1
                ids[text] = { id = hid, n = n }
                if n > bestN then
                    bestN = n
                    bestText = text
                end
            end
        end
    end
    if bestText == "" then return nil, "" end
    return ids[bestText].id, bestText
end

local function personLocation(ch)
    local okB, bottom = pcall(function() return ch:GetBottomLocation() end)
    if okB and bottom ~= nil then return bottom end
    local okG, loc = pcall(function() return ch:GetLocation() end)
    if okG and loc ~= nil then return loc end
    return nil
end

-- Sleeping in a bed, napping on a sofa or bench, dozing in a chair. Putting on or
-- taking off pyjamas (OutfitCategory_Sleep, Next_Sleep_Bed) is done awake.
local function sleepBag(bag)
    if type(bag) ~= "string" or bag == "" then return false end
    if bag:find("Dozing", 1, true) then return true end
    if bag:match("^Sleep_") and not bag:match("^Sleep_Sunbed01") then return true end
    if bag:match("^Jail_Sleep_") then return true end
    return false
end

-- Some commands hand their JSON back as the message, others as the data value.
local function cliField(cmd, field)
    local pat = '"' .. field .. '"%s*:%s*"([^"]*)"'
    local res = { inzoi.cli.execute(cmd) }
    for i = 2, 3 do
        if type(res[i]) == "string" then
            local v = res[i]:match(pat)
            if v then return v end
        end
    end
    return nil
end

-- Asked through the same CLI as the household list. The current interaction is the
-- main signal; the Sleep emotion covers the moment between two sleep interactions.
-- Anything that cannot be read counts as awake, so a broken lookup keeps lamps lit.
local function isAsleep(key)
    if not key:match("^%d+$") then return false end
    local bag = cliField("interaction.get_current entity_id=" .. key, "interaction_bag_id")
    if sleepBag(bag) then return true end
    local emo = cliField("emotion.get_current entity_id=" .. key, "emotion_type")
    if bag == nil and emo == nil then noteOnce("sleep-check", key) end
    return emo == "Sleep"
end

local function addHere(found, seen, ch, siteText, fallbackKey)
    if not ch then return false end
    local okS, sid = pcall(function() return ch:GetLocatedSiteId() end)
    if not okS or idText(sid) ~= siteText then return false end
    local okE, eid = pcall(function() return ch:GetEntityId() end)
    local key = okE and idText(eid) or ""
    if key == "" then key = fallbackKey or ("p" .. tostring(#found + 1)) end
    if seen[key] or (fallbackKey and seen[fallbackKey]) then return true end
    seen[key] = true
    if fallbackKey and fallbackKey ~= "" then seen[fallbackKey] = true end
    local okA, asleep = pcall(isAsleep, key)
    if okA and asleep then
        found.asleep = found.asleep + 1
        return true
    end
    if not okA then noteOnce("asleep", asleep) end
    found[#found + 1] = { loc = personLocation(ch) }
    return true
end

-- Household members are asked by id as well as through the city-wide list. A list that
-- fails to come back must not be treated as an empty house, or every lamp would go dark
-- while the family is standing in it.
local function peopleHere(siteText)
    local found = { asleep = 0 }
    local seen = {}
    local listed = false
    local ok, raw = pcall(function() return mgr:GetAllEntities(inzoi.EB2EntityType.Character) end)
    if ok and raw ~= nil then
        local list = listOf(raw)
        if list then
            listed = true
            for i = 1, #list do
                addHere(found, seen, list[i], siteText, nil)
            end
        end
    end
    local memberHits = 0
    for id in pairs(members) do
        local okC, ch = pcall(function() return mgr:FindCharacter(entityKey(id)) end)
        if okC and addHere(found, seen, ch, siteText, id) then
            memberHits = memberHits + 1
        end
    end
    if not listed and memberHits == 0 then return nil end
    return found
end

local function pointInRoom(site, loc)
    local ok, same = pcall(function() return site:IsSameRoom(loc, loc) end)
    if not ok then return nil, same end
    if type(same) ~= "boolean" then return nil, "same-room-type" end
    return same, nil
end

-- A ceiling lamp's origin often sits in the slab, outside the room volume.
-- Drop a sample into the room under that slab. If the engine will not build
-- that point, the lamp is left as the game had it.
local function lower(loc, cm)
    local x, y, z
    local okR = pcall(function()
        x = loc.X
        y = loc.Y
        z = loc.Z
    end)
    if not okR or type(x) ~= "number" or type(y) ~= "number" or type(z) ~= "number" then
        return nil
    end
    local made, v = pcall(function()
        local p = UE.FVector()
        p.X = x
        p.Y = y
        p.Z = z - cm
        return p
    end)
    if made and v ~= nil then return v end
    return nil
end

local function roomPoint(site, loc)
    local placed, err = pointInRoom(site, loc)
    if placed == true then return loc, true, nil end
    if placed == nil then return nil, nil, err end
    local dropped = lower(loc, LOWER_CM)
    if dropped == nil then return nil, false, nil end
    local placed2, err2 = pointInRoom(site, dropped)
    if placed2 == true then return dropped, true, nil end
    if placed2 == nil then return nil, nil, err2 end
    return nil, false, nil
end

local function occupied(site, loc, people)
    local located = 0
    for i = 1, #people do
        local ploc = people[i].loc
        if ploc ~= nil then
            located = located + 1
            local ok, same = pcall(function() return site:IsSameRoom(loc, ploc) end)
            if not ok then return nil, same end
            if same == true then return true, nil end
        end
    end
    if #people > 0 and located == 0 then return nil, "people-unlocated" end
    return false, nil
end

local function peopleInRooms(site, people)
    local n = 0
    for i = 1, #people do
        if people[i].loc ~= nil then
            local placed = pointInRoom(site, people[i].loc)
            if placed == true then n = n + 1 end
        end
    end
    return n
end

local function rememberRoom(point)
    for i = 1, #scan.reps do
        local ok, same = pcall(function() return scan.site:IsSameRoom(scan.reps[i], point) end)
        if ok and same == true then return end
    end
    scan.reps[#scan.reps + 1] = point
end

local function objectIdOf(obj)
    local ok, id = pcall(function() return obj:GetObjectId() end)
    if not ok or type(id) ~= "string" then return "" end
    return id
end

local function storedAway(obj)
    local ok, master = pcall(function() return obj:GetInventoryMasterEntityId() end)
    if not ok then return false end
    local text = idText(master)
    return text ~= "" and text ~= "0" and text ~= "-1"
end

local function indoors(obj)
    local ok, v = pcall(function() return obj:IsIndoor() end)
    if ok and type(v) == "boolean" then return v end
    return nil
end

local function resolveObject(entry)
    if entry == nil then return nil end
    if type(entry) == "userdata" or type(entry) == "table" then
        local okId, oid = pcall(function() return entry:GetObjectId() end)
        if okId and type(oid) == "string" and oid ~= "" then return entry end
        local ok, obj = pcall(function() return mgr:FindGameObject(entry) end)
        if ok and obj ~= nil then return obj end
    end
    return nil
end

-- A lamp that left our control (moved outdoors, out of every room) gets back the
-- light we took from it. A lamp we never switched off is not touched.
local function releaseLamp(obj, key)
    local eid = switchedOff[key]
    if not eid then return end
    local comp, isOn = stateOf(obj)
    if comp and isOn == false then switchLamp(comp, true, eid, key) end
    switchedOff[key] = nil
end

local function consider(entry)
    local obj = resolveObject(entry)
    if not obj then return end
    if not isLamp(obj, objectIdOf(obj)) then return end
    if storedAway(obj) then return end
    local okE, eid = pcall(function() return obj:GetEntityId() end)
    if not okE or eid == nil then return end
    local key = idText(eid)
    if key == "" or refused[key] then return end
    local inside = indoors(obj)
    if inside == nil then
        scan.skipped = scan.skipped + 1
        return
    end
    if inside == false then
        scan.yard = scan.yard + 1
        releaseLamp(obj, key)
        return
    end
    local okL, loc = pcall(function() return obj:GetLocation() end)
    if not okL or loc == nil then
        scan.skipped = scan.skipped + 1
        return
    end
    local point, placed, err = roomPoint(scan.site, loc)
    if placed == nil then
        scan.selfErr = scan.selfErr + 1
        noteOnce("room", err)
        return
    end
    if placed ~= true then
        scan.unplaced = scan.unplaced + 1
        releaseLamp(obj, key)
        return
    end
    scan.selfOk = scan.selfOk + 1
    rememberRoom(point)
    local occ, oerr = occupied(scan.site, point, scan.people)
    if occ == nil then
        scan.occErr = scan.occErr + 1
        noteOnce("room", oerr)
        return
    end
    local comp, isOn, serr = stateOf(obj)
    if comp == nil then
        errors = errors + 1
        noteOnce("state", serr)
        return
    end
    if occ then scan.lit = scan.lit + 1 else scan.dark = scan.dark + 1 end
    local pending = scan.pending
    pending[#pending + 1] = { key = key, eid = eid, comp = comp, isOn = isOn, occ = occ }
end

local function report(now)
    if scan.switched == 0 and reported and now - lastReport < 60 then return end
    reported = true
    lastReport = now
    print(TAG .. "S " .. table.concat({
        boot,
        scan.siteText,
        tostring(#scan.people),
        tostring(scan.lit),
        tostring(scan.dark),
        tostring(scan.yard),
        tostring(scan.unplaced),
        tostring(#scan.reps),
        tostring(scan.switched),
        tostring(errors),
        tostring(scan.people.asleep or 0)
    }, ","))
end

-- Room lookup that puts every lamp into one room, while people stand indoors and
-- none of them shares it, means the lookup is not telling rooms apart. Switching
-- off then would black the house out under their feet, so this pass changes nothing.
-- Someone in a lampless room (a bathroom without a light) is normal and is not held.
local function finish(now)
    local indoorsPeople = peopleInRooms(scan.site, scan.people)
    local hold = indoorsPeople > 0 and scan.lit == 0 and scan.dark > 1 and #scan.reps <= 1
    if hold then
        noteOnce("none-lit", tostring(scan.dark))
    else
        for i = 1, #scan.pending do
            local p = scan.pending[i]
            if p.isOn ~= p.occ and not p.occ and switchedOff[p.key] then
                diagOnce("reverted", p.key .. " " .. currentState(p.comp))
            end
            if p.isOn ~= p.occ then
                local okS, errS = switchLamp(p.comp, p.occ, p.eid, p.key)
                if okS then
                    scan.switched = scan.switched + 1
                    if p.occ then
                        switchedOff[p.key] = nil
                    else
                        switchedOff[p.key] = p.eid
                    end
                else
                    errors = errors + 1
                    refused[p.key] = true
                    noteOnce("switch", errS)
                end
            end
        end
    end
    if (scan.lit + scan.dark) >= 4 and #scan.reps == 1 and #scan.people > 0 then
        noteOnce("one-room", tostring(scan.lit + scan.dark))
    end
    if scan.selfErr > 0 and scan.selfOk == 0 and scan.unplaced == 0 and (scan.lit + scan.dark) == 0 then
        roomStrikes = roomStrikes + 1
        if roomStrikes >= 3 then
            roomsBroken = true
            noteOnce("rooms", "unavailable")
        end
    else
        roomStrikes = 0
    end
    report(now)
    scan = nil
    nextScan = now + CYCLE_GAP_S
end

local function step()
    local now = os.time()
    local list = scan.ids
    local last = scan.i + SLICE - 1
    if last > #list then last = #list end
    for i = scan.i, last do
        local ok, err = pcall(consider, list[i])
        if not ok then
            errors = errors + 1
            noteOnce("object", err)
        end
    end
    scan.i = last + 1
    if scan.i > #list then finish(now) end
end

local function beginScan()
    local now = os.time()
    if not mgr then
        local okM, m = pcall(function() return inzoi.getB2Manager("FB2EntityManager") end)
        if okM and m then mgr = m end
    end
    if not mgr then
        noteOnce("manager", "missing")
        nextScan = now + BACKOFF_S
        return
    end
    if memberCount == 0 or now - lastMembers >= MEMBER_EVERY_S then
        lastMembers = now
        refreshMembers()
    end
    if memberCount == 0 then
        noteOnce("household", "empty")
        nextScan = now + BACKOFF_S
        return
    end
    local homeId, homeText = resolveHome()
    if homeText == "" then
        noteOnce("home", "missing")
        nextScan = now + BACKOFF_S
        return
    end
    local okS, site = pcall(function() return mgr:FindSite(homeId) end)
    if not okS or site == nil then
        if siteSeen then
            siteSeen = false
            print(TAG .. "E site-away " .. homeText)
        end
        nextScan = now + CYCLE_GAP_S
        return
    end
    if not siteSeen then
        siteSeen = true
        print(TAG .. "site " .. homeText)
    end
    local okPub, pub = pcall(function() return site:IsPublicSite() end)
    if okPub and pub == true then
        noteOnce("public-site", homeText)
        nextScan = now + BACKOFF_S
        return
    end
    local okFake, fake = pcall(function() return site:IsFakeSite() end)
    if okFake and fake == true then
        noteOnce("fake-site", homeText)
        nextScan = now + BACKOFF_S
        return
    end
    local okP, cut = pcall(function() return site:IsElectricityCutoff() end)
    if okP and cut == true then
        noteOnce("power-off", homeText)
        nextScan = now + CYCLE_GAP_S
        return
    end
    local people = peopleHere(homeText)
    if people == nil then
        noteOnce("people", "unavailable")
        nextScan = now + BACKOFF_S
        return
    end
    local okO, raw = pcall(function() return site:GetObjects() end)
    if not okO or raw == nil then
        noteOnce("objects", "unavailable")
        nextScan = now + BACKOFF_S
        return
    end
    local ids = listOf(raw)
    if not ids then
        noteOnce("objects", "unlisted")
        nextScan = now + BACKOFF_S
        return
    end
    scan = {
        ids = ids,
        i = 1,
        people = people,
        site = site,
        siteText = homeText,
        pending = {},
        reps = {},
        lit = 0,
        dark = 0,
        yard = 0,
        unplaced = 0,
        skipped = 0,
        selfOk = 0,
        selfErr = 0,
        occErr = 0,
        switched = 0
    }
end

local function tick()
    if not ready or roomsBroken then return end
    if scan then
        step()
        return
    end
    if os.time() >= nextScan then beginScan() end
end

function M.on_begin()
    catalogCount = catalogCountOf()
    local okM, m = pcall(function() return inzoi.getB2Manager("FB2EntityManager") end)
    if okM and m then mgr = m else errors = errors + 1 end
    refreshMembers()
    lastMembers = os.time()
    ready = true
    nextScan = os.time()
    print(TAG .. "ready " .. boot .. "," .. tostring(catalogCount))
end

function M.on_tick()
    local ok, err = pcall(tick)
    if not ok then
        errors = errors + 1
        noteOnce("tick", err)
    end
end

function M.on_end()
    if not mgr then return end
    for key, eid in pairs(switchedOff) do
        pcall(function()
            local obj = mgr:FindGameObject(eid)
            if not obj then return end
            local comp, isOn = stateOf(obj)
            if comp and isOn == false then switchLamp(comp, true, eid, key) end
        end)
    end
    switchedOff = {}
end

return M
