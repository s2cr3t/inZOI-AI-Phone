-- HouseholdJournal -- B2 Zoi.PreferenceSetter
-- Gives a character a like or a dislike (FB2PreferenceComponent) when the SMS bridge says the
-- character came to it in a conversation. AddPreferenceData with the packet on lets the game
-- update its own UI and notice, as when a preference forms in play.
--
-- Request, sent by B1Main to the character, from the bridge's bridge/prefs.cfg:
--   "HouseholdJournal.pref", content "<seq>:<preference id>:<1 like|0 dislike>"
-- Result, printed to the Lua log the bridge tails:
--   [HouseholdJournal] K <boot>,<seq>,<ok|fail>,<actor>,<preference id>,<1|0>,<detail>
--   detail: set | flipped | same | full | not_set | no_component | error_...

---@class PreferenceSetter
local M = {}

local TAG = "[HouseholdJournal] "
local MESSAGE = "HouseholdJournal.pref"
-- EB1PreferenceState
local COMMON = 0
local LIKE = 1
local DISLIKE = 2

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

local function result(seq, ok, actor, pref, like, detail)
    print(TAG .. "K " .. table.concat({ boot, token(seq), ok and "ok" or "fail", token(actor), token(pref), like and "1" or "0", token(detail) }, ","))
end

local function stateOf(comp, pref)
    local ok, v = pcall(function() return comp:GetPreferenceState(pref) end)
    if ok and type(v) == "number" then return v end
    return COMMON
end

local function countOf(comp)
    local n = 0
    pcall(function()
        for _ in pairs(comp:GetPreferenceMap()) do n = n + 1 end
    end)
    return n
end

local function apply(owner, actor, seq, pref, like)
    local okC, comp = pcall(function() return owner:GetComponent(inzoi.EB2ComponentType.Preference) end)
    if not okC or not comp then return result(seq, false, actor, pref, like, "no_component") end
    local want = like and LIKE or DISLIKE
    local before = stateOf(comp, pref)
    if before == want then return result(seq, true, actor, pref, like, "same") end
    -- A new one needs a free slot; turning a like into a dislike (or back) does not.
    if before == COMMON then
        local okM, max = pcall(function() return comp:GetMaxPreferenceCount() end)
        if okM and type(max) == "number" and max > 0 and countOf(comp) >= max then
            return result(seq, false, actor, pref, like, "full")
        end
    end
    local ok, err = pcall(function() comp:AddPreferenceData(pref, like, true) end)
    if not ok then return result(seq, false, actor, pref, like, "error_" .. short(err)) end
    if stateOf(comp, pref) ~= want then return result(seq, false, actor, pref, like, "not_set") end
    result(seq, true, actor, pref, like, before == COMMON and "set" or "flipped")
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
            local seq, pref, like = content:match("^(%d+):([%w_]+):([01])$")
            if not seq then return result("", false, actor, "", false, "bad_request") end
            local ok, err = pcall(apply, owner, actor, seq, pref, like == "1")
            if not ok then result(seq, false, actor, pref, like == "1", "error_" .. short(err)) end
            return
        end
    end
end

return M
