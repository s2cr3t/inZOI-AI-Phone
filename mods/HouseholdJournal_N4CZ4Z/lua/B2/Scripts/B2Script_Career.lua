-- Adjust the game's own team-project points by the employee's current morale.
-- The bridge writes bridge/workmorale.cfg as id:morale;...; this remains runtime-only.
local M = {}

local cache = { at = 0, byId = {} }

local function loadMorale()
    local now = os.clock()
    if now - cache.at < 2 then return cache.byId end
    cache.at = now
    local ok, _, data = inzoi.cli.execute("uimod.cfg_load mod_id=HouseholdJournal_N4CZ4Z section=bridge key=workmorale")
    if not ok or type(data) ~= "string" then return cache.byId end
    local value = data:match('"value"%s*:%s*"([^"]*)"') or ""
    local byId = {}
    for id, morale in value:gmatch("(%d+):(%d+)") do byId[id] = tonumber(morale) end
    cache.byId = byId
    return byId
end

local function factor(morale)
    if not morale then return 1 end
    return math.max(0.65, math.min(1.2, 0.65 + morale / 100 * 0.55))
end

---@param InScriptContext FB2ScriptContext
---@param InExecuteParam FB1Execute
function M.Override_Execute_AddTeamProjectPoint(InScriptContext, InExecuteParam)
    local id = InScriptContext and InScriptContext.SelfEntityId and InScriptContext.SelfEntityId.Value
    local morale = id and loadMorale()[tostring(id)] or nil
    if morale then InExecuteParam.F1 = math.max(1, math.floor(InExecuteParam.F1 * factor(morale) + 0.5)) end
    return inzoi.FB2Script_Career.Execute_AddTeamProjectPoint(InScriptContext, InExecuteParam)
end

return M
