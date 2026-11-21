-- HouseholdJournal -- one handling per message.
-- The Zoi scripts are bound to every character ("*") and again to each character group type
-- (EB1CharacterGroupType: ResidenceFamily, Crowd, ...): once another mod binds a script to a
-- group (ZoiWorks Dynamic Weather binds ResidenceFamily), the game no longer runs the "*" ones
-- for that group. Should it run both for someone, the same message reaches a script twice; the
-- second is passed over here. Every
-- request the bridge sends carries its own number, so the same text to the same character a
-- few seconds apart is the same message.

local M = {}

local WINDOW_S = 10
local seen = {}
local lastPrune = 0

-- Every script of a character receives every message to it (each keeps its own kind), so the
-- script asking is part of the key.
---@param script string
---@param owner FB2Character
---@param args table
---@return boolean
function M.repeated(script, owner, args)
    local okI, id = pcall(function() return owner:GetEntityId() end)
    local who = okI and tostring(id and id.Value or id) or "?"
    local parts = {}
    for i = 1, #args do parts[#parts + 1] = tostring(args[i]) end
    local key = script .. "|" .. who .. "|" .. table.concat(parts, "|")
    local now = os.time()
    if now - lastPrune > WINDOW_S then
        lastPrune = now
        for k, at in pairs(seen) do
            if now - at > WINDOW_S then seen[k] = nil end
        end
    end
    if seen[key] and now - seen[key] <= WINDOW_S then return true end
    seen[key] = now
    return false
end

return M
