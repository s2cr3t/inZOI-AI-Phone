-- HouseholdJournal -- B2 Zoi.MessageServer
-- Answers the game's own phone messages (FB2MobileMessageComponent) for the phone's Messages
-- app: the positive, neutral or negative answer the game's phone offers, so the game writes the
-- reply and applies the relationship change itself. The phone reads the threads on its own
-- (entity.reflect FB2MobileMessageComponent) and sees the answer there.
--
-- Request, sent by B1Main to the character who answers, from the phone's messages/request.cfg:
--   "HouseholdJournal.sms", content "<seq>:p:<partner id>:<type>" for a person or
--   "<seq>:s:<system id>:<type>" for a system sender such as bank;Gangnam_Map.
--   type: EB1MobileMessageResponseType, 0 normal, 1 positive, 2 negative.
-- Result:
--   [HouseholdJournal] S <boot>,<seq>,<ok|fail>,<actor>,<detail>

---@class MessageServer
local M = {}

local TAG = "[HouseholdJournal] "
local MESSAGE = "HouseholdJournal.sms"

local boot = tostring(os.time()) .. tostring(math.random(100, 999))

local function token(v)
    if v == nil then return "" end
    return (tostring(v):gsub("[^%w_%-%.;]", ""))
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

local function result(seq, ok, actor, detail)
    print(TAG .. "S " .. table.concat({ boot, token(seq), ok and "ok" or "fail", token(actor), token(detail) }, ","))
end

local function answer(owner, actor, seq, kind, target, responseType)
    local okC, comp = pcall(function() return owner:GetComponent(inzoi.EB2ComponentType.MobileMessage) end)
    if not okC or not comp then return result(seq, false, actor, "no_message_component") end
    local partner = kind == "p" and entityKey(target) or entityKey(-1)
    local system = kind == "s" and target or "None"
    -- The answering character sends the response; the other side, a person or a system,
    -- receives it. This is the order of the game's own C_RequestSendMessageResponse.
    local ok, err = pcall(function()
        comp:SendMessageResponse(entityKey(actor), partner, system, tonumber(responseType))
    end)
    if not ok then return result(seq, false, actor, "error_" .. short(err)) end
    result(seq, true, actor, kind .. "_" .. target)
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
            local seq, kind, target, responseType = content:match("^(%d+):([ps]):([%w_;%-]+):([012])$")
            if not seq then return result("", false, actor, "bad_request") end
            local ok, err = pcall(answer, owner, actor, seq, kind, target, responseType)
            if not ok then result(seq, false, actor, "error_" .. short(err)) end
            return
        end
    end
end

return M
