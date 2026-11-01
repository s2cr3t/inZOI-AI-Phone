-- HouseholdJournal -- B1 Schedules
-- Writes the week of the characters the bridge asks for (bridge/schedids.cfg) from the game's schedule (UB1TimelineComponent: one timeline
-- per weekday, Monday first, each with its schedule entries) to the mod's bridge/schedule.cfg,
-- where the SMS bridge reads it for the characters' prompts. B1 can write cfg files itself, so
-- this needs no relay. Written only when it changed.
--
-- bridge/schedule.cfg: characters joined by "|", each "<id>:<entry>;<entry>..." with
--   entry = <day 0 Monday..6 Sunday>,<start HHmm>,<end HHmm>,<b base|o one-off>,<site>,<schedule name>,
--           <timeline name>,<control state>,<social event type>,<event title, percent-encoded>
-- The command line drops quotes and splits on spaces, so the format has neither.

local HJActors = require("HJActors")

local M = {}

local CHECK_S = 30

local lastCheck = -1000
local lastText = nil

local function word(v)
    return (tostring(v or ""):gsub("[^%w_]", ""))
end

local function pct(v)
    return (tostring(v or ""):gsub("[^%w_%-%.]", function(c) return string.format("%%%02X", c:byte()) end))
end

local function num(v)
    local ok, n = pcall(function() return v.Value end)
    if ok and type(n) == "number" then return n end
    return tonumber(v) or 0
end

local function len(arr)
    local ok, n = pcall(function() return arr:Num() end)
    if ok and type(n) == "number" then return n end
    return 0
end

-- TArray:Get is 1-based here.
local function at(arr, i)
    local ok, v = pcall(function() return arr:Get(i) end)
    if ok then return v end
    return nil
end

-- The characters whose week to write: the bridge lists them in bridge/schedids.cfg ("20522,20524").
-- B1 cannot ask the game who is in the household (household.get_members and entity.get_possessed
-- are B2-only).
local function wantedIds(modId)
    local ok, _, data = inzoi.cli.execute("uimod.cfg_load mod_id=" .. modId .. " section=bridge key=schedids")
    local ids = {}
    if not ok or type(data) ~= "string" then return ids end
    local value = data:match('"value"%s*:%s*"([^"]*)"') or ""
    for id in value:gmatch("%d+") do ids[tonumber(id)] = true end
    return ids
end

-- Any live character actor, for a world to search in.
local function anyActor()
    return HJActors.find(function(a)
        local ok, id = pcall(function() return a.EntityId.Value end)
        return ok and type(id) == "number" and id > 0
    end)
end

local function entries(comp)
    local out = {}
    for _, field in ipairs({ "BaseTimelines", "OverrideTimelines" }) do
        local kind = field == "BaseTimelines" and "b" or "o"
        local okL, list = pcall(function() return comp[field] end)
        local days = okL and list and len(list) or 0
        for k = 1, math.min(days, 7) do
            local day = k - 1
            local tl = at(list, k)
            local okS, scheds = pcall(function() return tl.Schedules end)
            local n = okS and scheds and len(scheds) or 0
            for j = 1, n do
                local s = at(scheds, j)
                local okD, d = pcall(function() return s.Detail end)
                if okD and d then
                    local start = num(d.StartTime)
                    local finish = num(d.EndTime)
                    if finish ~= start then
                        out[#out + 1] = table.concat({
                            tostring(day), tostring(start), tostring(finish), kind,
                            word(d.Site), word(d.ScheduleName), word(s.TimelineName),
                            tostring(num(s.ControlState)), tostring(num(s.SocialEventType)), pct(s.CustomEventName)
                        }, ",")
                    end
                end
            end
        end
    end
    return out
end

local function collect(modId)
    local any = anyActor()
    if not any then return nil end
    local ids = wantedIds(modId)
    if not next(ids) then return nil end
    local okA, all = pcall(function() return UE.UGameplayStatics.GetAllActorsOfClass(any, inzoi.AB1Character) end)
    if not okA or not all then return nil end
    local parts = {}
    for i = 1, len(all) do
        local actor = at(all, i)
        local okI, id = pcall(function() return actor.EntityId.Value end)
        if okI and ids[id] then
            local okC, comp = pcall(function() return actor:GetComponentByClass(inzoi.UB1TimelineComponent) end)
            if okC and comp then
                parts[#parts + 1] = tostring(id) .. ":" .. table.concat(entries(comp), ";")
            end
        end
    end
    table.sort(parts)
    return table.concat(parts, "|")
end

-- Called from B1 Main's tick.
function M.tick(modId)
    local now = os.time()
    if now - lastCheck < CHECK_S then return end
    lastCheck = now
    local ok, text = pcall(collect, modId)
    if not ok then
        print("[HouseholdJournal] Q schedule_error " .. word(text):sub(1, 60))
        return
    end
    if not text or text == lastText then return end
    local value = text ~= "" and text or "none"
    local okS = inzoi.cli.execute("uimod.cfg_save mod_id=" .. modId .. " section=bridge key=schedule value=" .. value)
    if okS then lastText = text end
end

return M
