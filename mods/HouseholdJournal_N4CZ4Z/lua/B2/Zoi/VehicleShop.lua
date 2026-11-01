-- HouseholdJournal -- B2 Zoi.VehicleShop
-- The car dealer for the phone's Dream Car app, without the game's own phone. The game buys a
-- vehicle from a client request (FB1Packet_C_RegisterVehicle) that no mod can send, so this does
-- what owning one means in the simulation: the dealer's checks (EB1VehiclePurchaseRejectReason:
-- age, a home, one vehicle per person, money), the price taken from the household with the game's
-- ExpenseBuy reason (it shows in the household ledger like any purchase), and the vehicle written
-- into the character's VehicleContext.OwnedVehicle, from which the game spawns it when it is used.
--
-- Requests, sent by B1Main to the character they are for, from the phone's vehicle/request.cfg:
--   "HouseholdJournal.vehicle", content "<seq>:p"                          probe: what the dealer sees
--                                       "<seq>:b:<VehicleDtId>:<price>:<ColorId>" buy
-- Only B1 can read the game's tables (data.table_get is B1-only), so B1Main looks the vehicle up:
-- it turns away one the game does not sell or a colour it does not offer, and passes the table's
-- price and the exact colour id (spaces as +). The phone's request carries neither.
-- Answer, to the phone (lua_message.HouseholdJournal.vehicle, JSON) and the Lua log:
--   [HouseholdJournal] V <boot>,<seq>,<ok|fail>,<actor>,<p|b>,<detail>
--   {"seq":"..","ok":true,"op":"b","actor":"..","detail":"..","owned":"..","color":"..","money":N,
--    "growth":N,"home":true}
-- detail on a refusal: underage, homeless, ownership_limit, not_enough_money, unknown_vehicle,
-- not_for_sale, unknown_color, no_household, not_paid, payment_mismatch, not_owned (paid back),
-- error_<text>. Every payment also prints a VPAY line: call ok, its answer, money before/after.

---@class VehicleShop
local M = {}

local TAG = "[HouseholdJournal] "
local MESSAGE = "HouseholdJournal.vehicle"
local CURRENCY = "mew"
-- Who the dealer turns away by age: babies to young teens.
local UNDERAGE = { [1] = true, [2] = true, [4] = true, [8] = true }

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

local function nameText(v)
    if v == nil then return "" end
    local s = tostring(v)
    if s == "None" then return "" end
    return s
end

local function jsonText(s)
    return '"' .. tostring(s or ""):gsub('[%c"\\]', function(c)
        if c == '"' then return '\\"' end
        if c == "\\" then return "\\\\" end
        return ""
    end) .. '"'
end

local function reply(owner, actor, seq, ok, op, detail, extra)
    print(TAG .. "V " .. table.concat({ boot, token(seq), ok and "ok" or "fail", token(actor), token(op), token(detail) }, ","))
    local parts = { '"seq":' .. jsonText(seq), '"ok":' .. (ok and "true" or "false"), '"op":' .. jsonText(op),
        '"actor":' .. jsonText(actor), '"detail":' .. jsonText(detail) }
    for k, v in pairs(extra or {}) do
        if type(v) == "number" then parts[#parts + 1] = '"' .. k .. '":' .. string.format("%d", v)
        elseif type(v) == "boolean" then parts[#parts + 1] = '"' .. k .. '":' .. (v and "true" or "false")
        else parts[#parts + 1] = '"' .. k .. '":' .. jsonText(v) end
    end
    local json = "{" .. table.concat(parts, ",") .. "}"
    -- A probe's answer is also logged whole, for checking what the dealer sees.
    if op == "p" then print(TAG .. "VP " .. json) end
    pcall(function() inzoi.message.send_to_client(tonumber(actor), MESSAGE, json) end)
end

-- The vehicle the character owns: dt id ("" for none) and colour.
local function owned(owner)
    local ok, dt, color = pcall(function()
        local o = owner.VehicleContext.OwnedVehicle
        return nameText(o.VehicleDtId), nameText(o.ColorId)
    end)
    if not ok then return "", "" end
    return dt or "", color or ""
end

---@return any
local function currency(owner)
    local hhId = owner:GetHouseholdEntityId()
    local mgr = inzoi.getB2Manager("FB2EntityManager")
    local okH, hh = pcall(function() return mgr:FindHousehold(hhId) end)
    if not okH or not hh then return nil end
    local kind = (inzoi.EB2ComponentType and inzoi.EB2ComponentType.Currency) or 17
    return hh:GetComponent(kind)
end

-- The household's money. The binding's way of returning it is not documented: each known way is
-- tried; moneyHow tells which one answered (shown by the probe).
local moneyHow = ""
local function money(cur)
    if not cur then return nil end
    local tries = {
        { "map_find", function() return cur.CurrencyMap:Find(CURRENCY) end },
        { "getmap_find", function() return cur:GetCurrencyMap():Find(CURRENCY) end },
        { "by_id", function() local a, b = cur:GetCurrencyByCurrencyId(CURRENCY, 0); return type(b) == "number" and b or a end },
        { "default", function() local a, b = cur:GetCurrency(0); return type(b) == "number" and b or a end },
        { "amount", function() return cur:GetCurrencyAmount(CURRENCY) end },
        { "map_index", function() return cur.CurrencyMap[CURRENCY] end }
    }
    for _, t in ipairs(tries) do
        local ok, v = pcall(t[2])
        if ok and type(v) == "number" then
            moneyHow = t[1]
            return v
        end
    end
    return nil
end

local function growth(owner)
    local ok, v = pcall(function() return owner:GetGrowthStep() end)
    return ok and tonumber(v) or 0
end

local function hasHome(owner)
    local ok, v = pcall(function() return owner:GetHomeSiteEntityId(false) end)
    local id = ok and tonumber(idText(v)) or nil
    return id ~= nil and id > 0
end

-- The dealer's row for a vehicle: price, whether it is sold, and its colours.
local function status(owner)
    local dt, color = owned(owner)
    local okC, cur = pcall(currency, owner)
    local st = { owned = dt, color = color, money = money(okC and cur or nil) or -1, growth = growth(owner), home = hasHome(owner) }
    if not okC then st.why = "currency_" .. short(cur) elseif not cur then st.why = "no_currency_component" end
    return st, okC and cur or nil
end

local function buy(owner, actor, seq, dt, price, color)
    local st, cur = status(owner)
    local function refuse(why) reply(owner, actor, seq, false, "b", why, st) end
    if UNDERAGE[st.growth] then return refuse("underage") end
    if not st.home then return refuse("homeless") end
    if st.owned ~= "" then return refuse("ownership_limit") end
    if not cur then return refuse("no_household") end
    if not price or price <= 0 or color == "" then return refuse("unknown_vehicle") end
    local row = { price = price }
    if st.money < row.price then return refuse("not_enough_money") end

    -- Paid first, through the household's ledger as a purchase by this character.
    local key = inzoi.FB1EntityId()
    key.Value = tonumber(actor)
    local before = st.money
    local reason = (inzoi.EB1TransactionReason and inzoi.EB1TransactionReason.ExpenseBuy) or 3
    -- One payment from the household, with every argument the binding expects (it does not fill
    -- in missing ones). The buyer is the owner: the game refuses a payment without one, and with
    -- the buyer it reads and pays from the household's money. Forced, because the game's own
    -- funds check (HasEnoughCurrency) answers no for any amount here; the funds were checked above
    -- against the household's balance instead. The ledger records a purchase (ExpenseBuy) by the
    -- buyer, who also gets the money effect.
    local noBiz = inzoi.FB1EntityId()
    noBiz.Value = -1
    local okPay, paid = pcall(function()
        return cur:AddCurrency(-row.price, reason, key, true, key, "None", noBiz, {})
    end)
    local after = money(cur) or before
    print(TAG .. "VPAY " .. token(seq) .. "," .. tostring(okPay) .. "," .. short(paid) .. "," .. string.format("%d", before) .. "," .. string.format("%d", after))
    if after ~= before - row.price then
        st.money = after
        if after == before then return reply(owner, actor, seq, false, "b", okPay and "not_paid" or ("error_" .. short(paid)), st) end
        return reply(owner, actor, seq, false, "b", "payment_mismatch", st)
    end

    -- Then the keys: the character's owned vehicle, written back whole in case the binding hands
    -- out a copy of the struct.
    local okOwn, errOwn = pcall(function()
        local ctx = owner.VehicleContext
        local o = ctx.OwnedVehicle
        o.VehicleDtId = dt
        o.ColorId = color
        local none = inzoi.FB1EntityId()
        none.Value = -1
        o.EntityId = none
        ctx.OwnedVehicle = o
        owner.VehicleContext = ctx
    end)
    pcall(function() owner.bNeedResetVehiclePacket = true end)
    local nowDt = owned(owner)
    if not okOwn or nowDt ~= dt then
        pcall(function() cur:AddCurrency(row.price, (inzoi.EB1TransactionReason and inzoi.EB1TransactionReason.ExpenseBizRefund) or 33, key, true, key, "None", noBiz, {}) end)
        st.money = money(cur) or before
        return reply(owner, actor, seq, false, "b", okOwn and "not_owned" or ("error_" .. short(errOwn)), st)
    end
    st.owned, st.color, st.money = dt, color, after
    reply(owner, actor, seq, true, "b", dt, st)
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
            local seq, op = content:match("^(%d+):([ps])$")
            -- c:<dt>  clears an owned vehicle that has no car in the world (entity -1), named so
            --         that only the expected one is cleared.
            -- f:<n>   pays n back to the household (a refund for a purchase charged twice).
            -- o:<dt>:<colour> records a vehicle as owned without paying (a test of what the game
            --         does with an owned vehicle); only when the character owns none.
            local arg, arg2
            if not seq then seq, op, arg = content:match("^(%d+):([cf]):([%w_]+)$") end
            if not seq then seq, op, arg, arg2 = content:match("^(%d+):(o):([%w_]+):([%w_%+]+)$") end
            if seq and op == "o" then
                local st = status(owner)
                if st.owned ~= "" then return reply(owner, actor, seq, false, "o", "ownership_limit", st) end
                pcall(function()
                    local ctx = owner.VehicleContext
                    local o = ctx.OwnedVehicle
                    o.VehicleDtId = arg
                    o.ColorId = (arg2:gsub("%+", " "))
                    local none = inzoi.FB1EntityId()
                    none.Value = -1
                    o.EntityId = none
                    ctx.OwnedVehicle = o
                    owner.VehicleContext = ctx
                end)
                st.owned, st.color = owned(owner)
                return reply(owner, actor, seq, st.owned == arg, "o", st.owned == arg and "recorded" or "not_recorded", st)
            end
            if seq and op == "c" then
                local st = status(owner)
                local okE, ent = pcall(function() return tonumber(idText(owner.VehicleContext.OwnedVehicle.EntityId)) end)
                if st.owned ~= arg or not okE or (ent or -1) > 0 then return reply(owner, actor, seq, false, "c", "not_cleared", st) end
                pcall(function()
                    local ctx = owner.VehicleContext
                    local o = ctx.OwnedVehicle
                    o.VehicleDtId = "None"
                    o.ColorId = "None"
                    ctx.OwnedVehicle = o
                    owner.VehicleContext = ctx
                end)
                st.owned, st.color = owned(owner)
                return reply(owner, actor, seq, st.owned == "", "c", st.owned == "" and "cleared" or "not_cleared", st)
            end
            if seq and op == "f" then
                local st, cur = status(owner)
                local n = tonumber(arg)
                if not cur or not n or n <= 0 then return reply(owner, actor, seq, false, "f", "bad_refund", st) end
                local key = inzoi.FB1EntityId()
                key.Value = tonumber(actor)
                local noBiz = inzoi.FB1EntityId()
                noBiz.Value = -1
                local before = st.money
                local reason = (inzoi.EB1TransactionReason and inzoi.EB1TransactionReason.ExpenseBizRefund) or 33
                local okR, r = pcall(function() return cur:AddCurrency(n, reason, key, true, key, "None", noBiz, {}) end)
                st.money = money(cur) or before
                print(TAG .. "VPAY refund " .. token(seq) .. "," .. tostring(okR) .. "," .. short(r) .. "," .. string.format("%d", before) .. "," .. string.format("%d", st.money))
                return reply(owner, actor, seq, st.money == before + n, "f", st.money == before + n and "refunded" or "not_refunded", st)
            end
            local dt, price, color = "", nil, ""
            if not seq then
                local p
                seq, dt, p, color = content:match("^(%d+):b:([%w_]+):(%d+):([%w_%+%-]+)$")
                op = "b"
                price = tonumber(p)
                color = color and color:gsub("%+", " ") or ""
            end
            if not seq then return reply(owner, actor, "", false, "", "bad_request") end
            local ok, err = pcall(function()
                if op == "s" then
                    -- Sends the client (B1) what the simulation holds for this character and its
                    -- household, as the game does after loading; each answer is reported.
                    local st = status(owner)
                    local function call(name, f)
                        local okC, v = pcall(f)
                        st["sync_" .. name] = okC and tostring(v) or ("!" .. short(v))
                    end
                    call("possess", function() return owner:SendPossessCharacterDataCache() end)
                    call("compact", function() return owner:SendCompactData() end)
                    call("b1spawn", function() return owner:RefreshB1Spawn(true) end)
                    call("household", function()
                        local mgr = inzoi.getB2Manager("FB2EntityManager")
                        local okH, hh = pcall(function() return mgr:FindHousehold(owner:GetHouseholdEntityId()) end)
                        if not okH or not hh then error(okH and "no_household" or hh) end
                        hh:RefreshHouseholdMemberInfo()
                        return hh:SendUpdateHouseholdInfo(true)
                    end)
                    print(TAG .. "VP " .. "sync " .. token(seq) .. " " .. table.concat({ st.sync_possess, st.sync_compact, st.sync_b1spawn, st.sync_household }, ","))
                    reply(owner, actor, seq, true, "s", "sync", st)
                    return
                end
                if op == "p" then
                    local st, cur = status(owner)
                    st.how = moneyHow
                    if not cur then st.how = "no_currency" end
                    reply(owner, actor, seq, true, "p", "probe", st)
                else
                    -- Off: written here, the ownership never reaches the client (B1), so the game
                    -- shows no car and cannot spawn it. Kept for when that can be done properly.
                    reply(owner, actor, seq, false, "b", "unavailable", (status(owner)))
                    if false then buy(owner, actor, seq, dt, price, color) end
                end
            end)
            if not ok then reply(owner, actor, seq, false, op, "error_" .. short(err)) end
            return
        end
    end
end

return M
