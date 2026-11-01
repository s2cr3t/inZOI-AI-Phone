-- HouseholdJournal -- B1 Zoi.ActorSeen
-- Keeps a few character actors this binding has seen, so B1 Main has a world to look the
-- household up in (UGameplayStatics needs one). The household's own actors may have spawned
-- before the binding, so they are found through the world rather than here.

local HJActors = require("HJActors")

---@class ActorSeen
local M = {}

---@param self table
---@param owner AB1Character
function M.on_begin(self, owner)
    HJActors.add(owner)
end

---@param self table
---@param owner AB1Character
function M.on_end(self, owner)
    HJActors.remove(owner)
end

return M
