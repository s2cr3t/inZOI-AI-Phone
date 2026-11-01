-- HouseholdJournal -- B1 HJActors
-- The character actors the B1 Zoi binding (Zoi.ActorSeen) has seen, shared with B1 Main and
-- Schedules, which need a world for UGameplayStatics. A module rather than a global: the game
-- checks each Lua file on its own when it applies the mod, and a global read in a file that does
-- not create it fails that check and disables the whole mod.

---@class HJActors
local M = {}

local KEEP = 8

---@type AB1Character[]
local list = {}

---@param actor AB1Character
function M.add(actor)
    list[#list + 1] = actor
    while #list > KEEP do table.remove(list, 1) end
end

---@param actor AB1Character
function M.remove(actor)
    for i = #list, 1, -1 do
        if list[i] == actor then table.remove(list, i) end
    end
end

-- The most recently seen actor, or nil while none has spawned yet.
---@return AB1Character|nil
function M.latest()
    return list[#list]
end

---@return integer
function M.count()
    return #list
end

-- Newest first; stops at the first actor for which pick returns true.
---@param pick fun(actor: AB1Character): boolean
---@return AB1Character|nil
function M.find(pick)
    for i = #list, 1, -1 do
        if pick(list[i]) then return list[i] end
    end
    return nil
end

return M
