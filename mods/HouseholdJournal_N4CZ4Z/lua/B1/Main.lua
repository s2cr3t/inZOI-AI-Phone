-- HouseholdJournal -- B1 Main
-- Hands the SMS bridge's requests to the simulation thread. Only B1 can read the mod's cfg
-- files and only B2 can change the game, so this side reads the request files the bridge alone
-- writes and sends each new request to the character it is for.
--
-- bridge/buffs.cfg: <seq>:<target>:<initiator>:<buff id>;...
--   B2 Zoi.BuffReceiver does the checks and queues the buff the way the game's own conversations
--   do; CHECK_S later a second message asks it to read the buff back and print the result to the
--   Lua log, where the bridge reads it and drops the request from the file.
-- bridge/meals.cfg: <seq>:<actor>:<dish>:<container>:<e|t>;... and c<seq>:<actor> for a withdrawn one
--   B2 Zoi.MealServer takes that family meal out of the container for the actor, puts it on a
--   table and either serves the actor a portion (e) or leaves it there for the family (t), and
--   prints its progress (T lines) to the Lua log; a withdrawal drops it if the dish is not out yet.
--   <seq>:<actor>:<dish>:<container>:<g|h>:<person> serves the dish to that person instead: taken
--   out of the container (g), or picked up where it stands, container 0 (h).
-- <phone mod>/ui/phone/freelance/request.cfg: <seq>:<actor>:a:<summary id> or <seq>:<actor>:c
--   written by the phone's Freelance page, one request at a time. B2 Zoi.FreelanceServer accepts
--   that order (a) or cancels the active one (c), and prints an R line.
-- <phone mod>/ui/phone/messages/request.cfg: <seq>:<actor>:p:<partner>:<type> or
--   <seq>:<actor>:s:<system id>:<type>, written by the phone's Messages app. B2 Zoi.MessageServer
--   gives that answer to the game's phone message and prints an S line.
-- <phone mod>/ui/phone/vehicle/request.cfg: <seq>:<actor>:p or <seq>:<actor>:b:<vehicle>:<colour>,
--   written by the phone's Dream Car app. B2 Zoi.VehicleShop answers the phone itself
--   (lua_message.HouseholdJournal.vehicle) and prints a V line; no bridge is needed.
-- bridge/prefs.cfg: <seq>:<target>:<preference id>:<1|0>;...
--   B2 Zoi.PreferenceSetter gives the character that like (1) or dislike (0) and prints a K line.
-- bridge/career.cfg: <seq>:<actor>:r:<company entity> or <seq>:<actor>:q:<quest id>/<mission id>;...
--   B2 Zoi.CareerServer leaves the company (an OA request the boss granted) or adds a work mission
--   (a task the boss handed out) and prints a C line.
-- <phone mod>/ui/focus/camera.cfg: <ms>:<open|close>:<player>:<target>, written by the phone mod's
--   智能对话 box. B1 FocusCamera turns the camera to that character and back (Z lines).
-- bridge/schedule.cfg is written here (Schedules): the week of the characters the bridge lists in bridge/schedids.cfg.
-- A request that cannot be sent is reported as failed in the same format and not retried. A meal
-- request written before this Lua instance started belongs to the world before a loaded save
-- and is reported as stale_after_reload instead of being sent.

local MOD_ID = "HouseholdJournal_N4CZ4Z"
local PHONE_MOD_ID = "HouseholdBoard_I6IXIO"
local FREELANCE_SECTION = "ui/phone/freelance"
local MESSAGES_SECTION = "ui/phone/messages"
local VEHICLE_SECTION = "ui/phone/vehicle"
local TAG = "[HouseholdJournal] "
local POLL_S = 2
local CHECK_S = 3

local Schedules = require("Schedules")
local HJActors = require("HJActors")
local FocusCamera = require("FocusCamera")

local M = {}

local sent = {}
local mealsSent = {}
local freelanceSent = {}
local messagesSent = {}
local vehicleSent = {}
local prefsSent = {}
local careerSent = {}
local checks = {}
local lastPoll = -1000
local reportedShape = {}
local boot = tostring(os.time()) .. tostring(math.random(100, 999))
-- The bridge numbers requests by the time it wrote them, in milliseconds.
local startedMs = os.time() * 1000

local function token(v)
    return (tostring(v):gsub("[^%w_%-%.]", ""))
end

local function failed(seq, target, buff, why, err)
    print(TAG .. "B ," .. seq .. ",fail," .. target .. "," .. buff .. "," .. why .. "_" .. token(err):sub(1, 60))
end

local function mealFailed(seq, actor, dish, why, err)
    print(TAG .. "T " .. boot .. "," .. seq .. ",fail," .. actor .. "," .. dish .. "," .. why .. "_" .. token(err):sub(1, 60))
end

local function send(kind, target, content)
    return pcall(function()
        inzoi.message.send_to_sim(tonumber(target), kind, content)
    end)
end

local function load(key)
    local ok, msg, data = inzoi.cli.execute("uimod.cfg_load mod_id=" .. MOD_ID .. " section=bridge key=" .. key)
    if not ok or type(data) ~= "string" then return nil end
    local value = data:match('"value"%s*:%s*"([^"]*)"')
    if not value and not reportedShape[key] then
        reportedShape[key] = true
        print(TAG .. "Q unreadable " .. key .. " " .. tostring(msg) .. " " .. data:sub(1, 120))
    end
    return value
end

local function freelanceFailed(seq, actor, op, why, err)
    print(TAG .. "R " .. boot .. "," .. token(seq) .. ",fail," .. token(actor) .. "," .. token(op) .. "," .. why .. (err and ("_" .. token(err):sub(1, 60)) or ""))
end

-- One request at a time; a request the phone wrote before this Lua instance started belongs to
-- the world before a loaded save and is reported, not sent.
local function pollFreelance()
    local ok, _, data = inzoi.cli.execute("uimod.cfg_load mod_id=" .. PHONE_MOD_ID .. " section=" .. FREELANCE_SECTION .. " key=request")
    if not ok or type(data) ~= "string" then return end
    local value = data:match('"value"%s*:%s*"([^"]*)"')
    if not value then return end
    local seq, actor, op, arg = value:match("^(%d+):(%d+):([ac]):?(%d*)$")
    if not seq or freelanceSent[seq] then return end
    freelanceSent[seq] = true
    if (tonumber(seq) or 0) < startedMs then return freelanceFailed(seq, actor, op, "stale_after_reload") end
    local content = seq .. ":" .. op
    if arg ~= "" then content = content .. ":" .. arg end
    local okS, err = send("HouseholdJournal.freelance", actor, content)
    if not okS then freelanceFailed(seq, actor, op, "send_failed", err) end
end

-- The phone's Messages app: an answer to one of the game's own phone messages, one at a time.
-- <seq>:<actor>:p:<partner id>:<type> or <seq>:<actor>:s:<system id>:<type>
local function pollMessages()
    local ok, _, data = inzoi.cli.execute("uimod.cfg_load mod_id=" .. PHONE_MOD_ID .. " section=" .. MESSAGES_SECTION .. " key=request")
    if not ok or type(data) ~= "string" then return end
    local value = data:match('"value"%s*:%s*"([^"]*)"')
    if not value then return end
    local seq, actor, rest = value:match("^(%d+):(%d+):([ps]:[%w_;%-]+:[012])$")
    if not seq or messagesSent[seq] then return end
    messagesSent[seq] = true
    if (tonumber(seq) or 0) < startedMs then
        return print(TAG .. "S " .. boot .. "," .. seq .. ",fail," .. actor .. ",stale_after_reload")
    end
    local okS, err = send("HouseholdJournal.sms", actor, seq .. ":" .. rest)
    if not okS then print(TAG .. "S " .. boot .. "," .. seq .. ",fail," .. actor .. ",send_failed_" .. token(err):sub(1, 60)) end
end

-- The phone's Dream Car app: a look at what the dealer sees (p, optionally with a vehicle to look
-- up) or a purchase (b), one at a time. Only this side can read the game's tables, so the vehicle
-- is looked up here and the dealer gets the table's price and the exact colour id (spaces as +);
-- a vehicle the game does not sell or a colour it does not offer is turned away here.
-- A stale purchase (written before this Lua instance started) is answered, never carried out.
local function vehicleAnswer(seq, actor, op, detail)
    local msg = '{"seq":"' .. seq .. '","ok":false,"op":"' .. op .. '","actor":"' .. actor .. '","detail":"' .. detail .. '"}'
    pcall(function() inzoi.message.send_to_client(tonumber(actor), "HouseholdJournal.vehicle", msg) end)
    print(TAG .. "V " .. boot .. "," .. seq .. ",fail," .. actor .. "," .. op .. "," .. detail)
end

-- The dealer's row of a vehicle: price, whether the game sells it, its colour ids. nil when the
-- table has no such row.
local function vehicleRow(dt)
    local ok, msg, data = inzoi.cli.execute("data.table_get alias=Vehicle row=" .. token(dt))
    if not ok or type(data) ~= "string" or not data:find('"price"') then
        return nil, token(tostring(msg)):sub(1, 60)
    end
    local row = { price = tonumber(data:match('"price"%s*:%s*(%d+)')) or 0, colors = {} }
    row.sold = data:match('"purchasableLevel"%s*:%s*%[%s*"') ~= nil and not data:match('"type"%s*:%s*"Invalid"')
        and not data:match('"type"%s*:%s*"Ship"')
    for c in data:gmatch('"colorId"%s*:%s*"([^"]+)"') do row.colors[#row.colors + 1] = c end
    return row
end

-- The client's cheat manager, reached through a character actor (a world for UGameplayStatics).
-- It holds B1RegisterNewVehicle, the client's own "register a vehicle" request.
local function cheatManager()
    local actor = HJActors.latest()
    if not actor then return nil, "no_actor" end
    local okP, pc = pcall(function() return UE.UGameplayStatics.GetPlayerController(actor, 0) end)
    if not okP or not pc then return nil, "no_controller_" .. token(tostring(pc)):sub(1, 40) end
    local okC, cm = pcall(function() return pc.CheatManager end)
    if not okC then return nil, "cheat_read_" .. token(tostring(cm)):sub(1, 40) end
    if not cm then return nil, "no_cheat_manager", pc end
    return cm, "ok", pc
end

local function pollVehicle()
    local ok, _, data = inzoi.cli.execute("uimod.cfg_load mod_id=" .. PHONE_MOD_ID .. " section=" .. VEHICLE_SECTION .. " key=request")
    if not ok or type(data) ~= "string" then return end
    local value = data:match('"value"%s*:%s*"([^"]*)"')
    if not value then return end
    -- h:<dt>:<colour> buys through the game's own car screen, which the game keeps (hidden) even
    -- with its phone off the HUD: the vehicle and colour are set on it and its Buy button's click
    -- is fired, so the game's own code makes the purchase (checks, payment, the car at home).
    -- An optional :<how> picks which click is fired: inner (the common button's inner B1Button,
    -- default) or outer (the common button's own OnClicked).
    local hseq, hactor, hdt, hcolor, hhow = value:match("^(%d+):(%d+):h:([%w_]+):([%w_%+]+):?(%a*)$")
    if hseq then
        if vehicleSent[hseq] then return end
        vehicleSent[hseq] = true
        if (tonumber(hseq) or 0) < startedMs then return vehicleAnswer(hseq, hactor, "h", "stale_after_reload") end
        local color = hcolor:gsub("%+", " ")
        if hhow == "" then hhow = "inner" end
        local steps = { "how=" .. hhow }
        local ok, err = pcall(function()
            local actorObj = HJActors.latest()
            if not actorObj then error("no_actor") end
            local cls = UE.UClass.Load("/Script/BlueClient.B1VehicleDetailWidget")
            local arr = UE.TArray(UE.UUserWidget)
            UE.UWidgetBlueprintLibrary.GetAllWidgetsOfClass(actorObj, arr, cls, false)
            if arr:Length() < 1 then error("no_car_screen") end
            local w = arr:Get(1)
            w.SelectedVehicleDtId = hdt
            steps[#steps + 1] = "dt=" .. tostring(w.SelectedVehicleDtId)
            local picker = w.BW_WBP_CarColorPicker_Detail
            if picker then
                picker.SelectedColorId = color
                local row = vehicleRow(hdt)
                for i, c in ipairs(row and row.colors or {}) do
                    if c == color then picker.SelectedPaletteIndex = i - 1 end
                end
                steps[#steps + 1] = "color=" .. tostring(picker.SelectedColorId) .. "/" .. tostring(picker.SelectedPaletteIndex)
            end
            local buy = w.BW_Button_Buy
            steps[#steps + 1] = "dimmed=" .. tostring(buy.bIsDimmed)
            if hhow == "outer" then
                buy.OnClicked:Broadcast()
            else
                local inner = buy.BW_Button
                if not inner then error("no_inner_button") end
                steps[#steps + 1] = "inner=" .. tostring(inner:GetClass():GetName())
                inner.OnClicked:Broadcast()
            end
            steps[#steps + 1] = "clicked"
        end)
        print(TAG .. "VHID " .. hseq .. "," .. hactor .. "," .. token(hdt) .. "," .. tostring(ok) .. "," .. table.concat(steps, "|") .. (ok and "" or ("," .. token(tostring(err)):sub(1, 120))))
        return
    end
    -- v:<n> (development) prints the owned vehicle the client holds on each character actor.
    -- k:<dt>:<colour> writes that owned vehicle onto the actor's client copy (None:None clears it),
    -- since the client only reads it from the simulation when the actor spawns.
    local vseq, vactor = value:match("^(%d+):(%d+):v:%d+$")
    local kdt, kcolor
    if not vseq then vseq, vactor, kdt, kcolor = value:match("^(%d+):(%d+):k:([%w_]+):([%w_%+]+)$") end
    if vseq then
        if vehicleSent[vseq] then return end
        vehicleSent[vseq] = true
        if kdt and (tonumber(vseq) or 0) < startedMs then return vehicleAnswer(vseq, vactor, "k", "stale_after_reload") end
        local ok, err = pcall(function()
            local actorObj = HJActors.latest()
            if not actorObj then error("no_actor") end
            local arr = UE.TArray(UE.AActor)
            UE.UGameplayStatics.GetAllActorsOfClass(actorObj, UE.UClass.Load("/Script/BlueClient.B1Character"), arr)
            print(TAG .. "VB count=" .. tostring(arr:Length()) .. (kdt and (" write " .. vactor .. " " .. kdt) or ""))
            for i = 1, arr:Length() do
                local a = arr:Get(i)
                local id = ""
                pcall(function() id = tostring(a.EntityId.Value) end)
                if kdt and id == vactor then
                    local ctx = a.VehicleContext
                    local o = ctx.OwnedVehicle
                    o.VehicleDtId = kdt
                    o.ColorId = (kcolor:gsub("%+", " "))
                    ctx.OwnedVehicle = o
                    a.VehicleContext = ctx
                end
                if not kdt or id == vactor then
                    local info = { "id=" .. id }
                    pcall(function()
                        local o = a.VehicleContext.OwnedVehicle
                        info[#info + 1] = "owned=" .. tostring(o.VehicleDtId) .. "/" .. tostring(o.ColorId) .. "/" .. tostring(o.EntityId.Value)
                    end)
                    print(TAG .. "VB   " .. table.concat(info, " "))
                end
            end
        end)
        if not ok then print(TAG .. "VB error " .. token(tostring(err)):sub(1, 120)) end
        return
    end
    -- w:<n> (development) describes the game's car screens that exist right now.
    local wseq, wactor = value:match("^(%d+):(%d+):w:%d+$")
    if wseq then
        if vehicleSent[wseq] then return end
        vehicleSent[wseq] = true
        local ok, err = pcall(function()
            local actorObj = HJActors.latest()
            if not actorObj then error("no_actor") end
            for _, name in ipairs({ "B1VehicleDetailWidget", "B1VehicleManagementWidget", "B1VehicleColorPickerWidget" }) do
                local cls, path = nil, ""
                for _, mod in ipairs({ "BlueClient", "BlueClientCore", "BlueClientUI" }) do
                    local okL, c = pcall(function() return UE.UClass.Load("/Script/" .. mod .. "." .. name) end)
                    if okL and c then cls, path = c, "/Script/" .. mod .. "." .. name break end
                end
                if not cls then
                    print(TAG .. "VW " .. name .. " no_class")
                else
                    local arr = UE.TArray(UE.UUserWidget)
                    UE.UWidgetBlueprintLibrary.GetAllWidgetsOfClass(actorObj, arr, cls, false)
                    print(TAG .. "VW " .. name .. " " .. path .. " count=" .. tostring(arr:Length()))
                    for i = 1, arr:Length() do
                        local w = arr:Get(i)
                        local info = {}
                        pcall(function() info[#info + 1] = "class=" .. w:GetClass():GetPathName() end)
                        pcall(function() info[#info + 1] = "obj=" .. w:GetPathName() end)
                        pcall(function() info[#info + 1] = "visible=" .. tostring(w:IsVisible()) end)
                        pcall(function() info[#info + 1] = "dt=" .. tostring(w.SelectedVehicleDtId) end)
                        pcall(function() info[#info + 1] = "color=" .. tostring(w.SelectedColorId) .. "/" .. tostring(w.SelectedPaletteIndex) end)
                        pcall(function() info[#info + 1] = "picker=" .. tostring(w.BW_WBP_CarColorPicker_Detail and w.BW_WBP_CarColorPicker_Detail.SelectedColorId) end)
                        pcall(function() info[#info + 1] = "buy=" .. w.BW_Button_Buy:GetClass():GetName() end)
                        pcall(function() info[#info + 1] = "buybtn=" .. w.BW_Button_Buy.BW_Button:GetClass():GetName() end)
                        print(TAG .. "VW   " .. table.concat(info, " "))
                    end
                end
            end
        end)
        if not ok then print(TAG .. "VW error " .. token(tostring(err)):sub(1, 120)) end
        return
    end
    -- c:<dt> and f:<n> go to the dealer as they are; r:<dt> is the client's own register request.
    local tseq, tactor, top, targ = value:match("^(%d+):(%d+):([cfr]):([%w_]+)$")
    if not tseq then tseq, tactor, top, targ = value:match("^(%d+):(%d+):(o):([%w_]+:[%w_%+]+)$") end
    if tseq then
        if vehicleSent[tseq] then return end
        vehicleSent[tseq] = true
        if (tonumber(tseq) or 0) < startedMs then return vehicleAnswer(tseq, tactor, top, "stale_after_reload") end
        if top ~= "r" then
            local okS, err = send("HouseholdJournal.vehicle", tactor, tseq .. ":" .. top .. ":" .. targ)
            if not okS then print(TAG .. "V " .. boot .. "," .. tseq .. ",fail," .. tactor .. "," .. top .. ",send_failed_" .. token(err):sub(1, 60)) end
            return
        end
        local okR, how = pcall(function()
            -- Development only, and only where the game has a cheat manager of its own; the
            -- release build has none, and none is made for it.
            local cm, why = cheatManager()
            if not cm then return why end
            cm:B1RegisterNewVehicle(targ)
            return "called"
        end)
        print(TAG .. "VREG " .. tseq .. "," .. tactor .. "," .. token(targ) .. "," .. tostring(okR) .. "," .. token(tostring(how)):sub(1, 80))
        return
    end
    local seq, actor, op, dt, colorFile = value:match("^(%d+):(%d+):([ps]):?([%w_]*)$")
    if not seq then seq, actor, op, dt, colorFile = value:match("^(%d+):(%d+):(b):([%w_]+):([%w_%-]+)$") end
    if not seq or vehicleSent[seq] then return end
    vehicleSent[seq] = true
    if (tonumber(seq) or 0) < startedMs then return vehicleAnswer(seq, actor, op, "stale_after_reload") end
    if op == "p" then
        -- Whether the client's own register request can be reached (looked at, never called).
        local cm, how, pc = cheatManager()
        local has = cm and tostring(pcall(function() return cm.B1RegisterNewVehicle end) and cm.B1RegisterNewVehicle ~= nil) or "false"
        local cls = ""
        pcall(function() cls = tostring(cm and cm:GetName() or (pc and pc:GetName()) or "") end)
        print(TAG .. "VC " .. how .. "," .. token(cls):sub(1, 60) .. ",register=" .. has .. ",actors=" .. tostring(HJActors.count()))
    end
    local content = seq .. ":" .. (op == "s" and "s" or "p")
    if dt ~= "" and op ~= "s" then
        local row, why = vehicleRow(dt)
        if op == "p" then
            print(TAG .. "VR " .. token(dt) .. "," .. (row and (row.price .. "," .. tostring(row.sold) .. "," .. table.concat(row.colors, "|")) or ("none," .. tostring(why))))
        else
            if not row then return vehicleAnswer(seq, actor, op, "unknown_vehicle") end
            if not row.sold then return vehicleAnswer(seq, actor, op, "not_for_sale") end
            local color = nil
            for _, c in ipairs(row.colors) do
                if c:gsub("[^%w_%-]", "_") == colorFile then color = c end
            end
            if not color then return vehicleAnswer(seq, actor, op, "unknown_color") end
            content = seq .. ":b:" .. dt .. ":" .. string.format("%d", row.price) .. ":" .. color:gsub(" ", "+")
        end
    end
    local okS, err = send("HouseholdJournal.vehicle", actor, content)
    if not okS then print(TAG .. "V " .. boot .. "," .. seq .. ",fail," .. actor .. "," .. op .. ",send_failed_" .. token(err):sub(1, 60)) end
end

-- OA requests the boss granted that only the simulation thread can carry out.
local function pollCareer()
    local value = load("career")
    if not value then return end
    for seq, actor, op, arg in value:gmatch("(%d+):(%d+):(%a):([%w_/]+)") do
        if not careerSent[seq] then
            careerSent[seq] = true
            if (tonumber(seq) or 0) < startedMs then
                print(TAG .. "C " .. boot .. "," .. seq .. ",fail," .. actor .. "," .. op .. ",stale_after_reload")
            else
                local okS, err = send("HouseholdJournal.career", actor, seq .. ":" .. op .. ":" .. arg)
                if not okS then
                    print(TAG .. "C " .. boot .. "," .. seq .. ",fail," .. actor .. "," .. op .. ",send_failed_" .. token(err):sub(1, 60))
                end
            end
        end
    end
end

-- Likes and dislikes the bridge gives a character after a conversation.
local function pollPrefs()
    local value = load("prefs")
    if not value then return end
    for seq, target, pref, like in value:gmatch("(%d+):(%d+):([%w_]+):([01])") do
        if not prefsSent[seq] then
            prefsSent[seq] = true
            if (tonumber(seq) or 0) < startedMs then
                print(TAG .. "K " .. boot .. "," .. seq .. ",fail," .. target .. "," .. pref .. "," .. like .. ",stale_after_reload")
            else
                local okS, err = send("HouseholdJournal.pref", target, seq .. ":" .. pref .. ":" .. like)
                if not okS then
                    print(TAG .. "K " .. boot .. "," .. seq .. ",fail," .. target .. "," .. pref .. "," .. like .. ",send_failed_" .. token(err):sub(1, 60))
                end
            end
        end
    end
end

local function pollBuffs(now)
    local value = load("buffs")
    if not value then return end
    for seq, target, initiator, buff in value:gmatch("(%d+):(%d+):(%d+):([%w_]+)") do
        if not sent[seq] then
            sent[seq] = true
            local content = seq .. ":" .. initiator .. ":" .. buff
            local okS, err = send("HouseholdJournal.buff", target, content)
            if okS then
                checks[seq] = { at = now + CHECK_S, target = target, content = content, buff = buff }
            else
                failed(seq, target, buff, "send_failed", err)
            end
        end
    end
end

local function pollMeals()
    local value = load("meals")
    if not value then return end
    for entry in value:gmatch("[^;]+") do
        local seq, actor, dish, container, mode = entry:match("^(%d+):(%d+):(%d+):(%d+):([et])$")
        local person = nil
        if not seq then
            seq, actor, dish, container, mode, person = entry:match("^(%d+):(%d+):(%d+):(%d+):([gh]):(%d+)$")
        end
        if seq and not mealsSent[seq] and (tonumber(seq) or 0) < startedMs then
            -- Written before this Lua instance started, i.e. for the world before a loaded save.
            mealsSent[seq] = true
            mealFailed(seq, actor, dish, "stale_after_reload", "")
        elseif seq and not mealsSent[seq] then
            mealsSent[seq] = true
            local content = seq .. ":" .. dish .. ":" .. container .. ":" .. mode
            if person then content = content .. ":" .. person end
            local okS, err = send("HouseholdJournal.meal", actor, content)
            if not okS then mealFailed(seq, actor, dish, "send_failed", err) end
        end
        local wseq, wactor = entry:match("^c(%d+):(%d+)$")
        if wseq and not mealsSent["c" .. wseq] then
            mealsSent["c" .. wseq] = true
            send("HouseholdJournal.mealcancel", wactor, wseq)
        end
    end
end

local function runChecks(now)
    for seq, c in pairs(checks) do
        if now >= c.at then
            checks[seq] = nil
            local okS, err = send("HouseholdJournal.buffcheck", c.target, c.content)
            if not okS then failed(seq, c.target, c.buff, "check_send_failed", err) end
        end
    end
end

-- <phone mod>/ui/phone/vehicle/hide.cfg: <seq>:1 while the phone's Dream Car app buys through the
-- game's own phone, <seq>:0 after. While on, the game's phone and its popups are drawn fully
-- transparent (they still work, and are clicked by the app). A switch older than HIDE_MAX_MS is
-- ignored, so the game's phone cannot stay invisible after an interrupted purchase.
local HIDE_POLL_S = 0.25
local HIDE_MAX_MS = 90000
-- Not 0: the game counts a fully transparent widget as not drawn, and its UI commands skip it.
local HIDE_ALPHA = 0.01
local lastHidePoll = -1
-- Widgets made transparent, by path, with the opacity each had, to be given back.
local hidden = {}
local userWidgetClass = nil

-- The game's phone always (it is kept, collapsed, between uses); a popup only while it shows.
local function shouldHide(w, name)
    if name:find("WBP_MobileMode", 1, true) then return true end
    if not name:find("Popup", 1, true) then return false end
    local ok, vis = pcall(function() return w:IsVisible() end)
    return ok and vis == true
end

local function hideGamePhone()
    local actorObj = HJActors.latest()
    if not actorObj then return end
    userWidgetClass = userWidgetClass or UE.UClass.Load("/Script/UMG.UserWidget")
    local arr = UE.TArray(UE.UUserWidget)
    UE.UWidgetBlueprintLibrary.GetAllWidgetsOfClass(actorObj, arr, userWidgetClass, false)
    for i = 1, arr:Length() do
        local w = arr:Get(i)
        local name, path = "", nil
        pcall(function() name = w:GetClass():GetName() end)
        if shouldHide(w, name) then
            pcall(function() path = w:GetPathName() end)
            if path and not hidden[path] then
                local okO, alpha = pcall(function() return w:GetRenderOpacity() end)
                hidden[path] = { widget = w, alpha = okO and alpha or 1 }
                print(TAG .. "VHIDE " .. name)
            end
            pcall(function() w:SetRenderOpacity(HIDE_ALPHA) end)
        end
    end
end

local function showGamePhone()
    for path, h in pairs(hidden) do
        pcall(function() h.widget:SetRenderOpacity(h.alpha) end)
        hidden[path] = nil
    end
end

-- Once per Lua instance, outside a purchase: a game phone or popup left fully transparent by an
-- earlier instance (a purchase cut short by a reload) is made visible again.
local repaired = false
local function repairGamePhone()
    local actorObj = HJActors.latest()
    if not actorObj then return end
    repaired = true
    userWidgetClass = userWidgetClass or UE.UClass.Load("/Script/UMG.UserWidget")
    local arr = UE.TArray(UE.UUserWidget)
    UE.UWidgetBlueprintLibrary.GetAllWidgetsOfClass(actorObj, arr, userWidgetClass, false)
    local n = 0
    for i = 1, arr:Length() do
        local w = arr:Get(i)
        local name = ""
        pcall(function() name = w:GetClass():GetName() end)
        if name:find("WBP_MobileMode", 1, true) or name:find("Popup", 1, true) then
            pcall(function()
                if w:GetRenderOpacity() < HIDE_ALPHA * 2 then
                    w:SetRenderOpacity(1)
                    n = n + 1
                end
            end)
        end
    end
    if n > 0 then print(TAG .. "VHIDE repaired " .. n) end
end

local function pollHide()
    local t = os.clock()
    if t - lastHidePoll < HIDE_POLL_S then return end
    lastHidePoll = t
    local ok, _, data = inzoi.cli.execute("uimod.cfg_load mod_id=" .. PHONE_MOD_ID .. " section=" .. VEHICLE_SECTION .. " key=hide")
    local value = ok and type(data) == "string" and data:match('"value"%s*:%s*"([^"]*)"') or ""
    local seq, on = value:match("^(%d+):([01])$")
    if on == "1" and os.time() * 1000 - (tonumber(seq) or 0) < HIDE_MAX_MS then
        pcall(hideGamePhone)
    elseif next(hidden) then
        pcall(showGamePhone)
    elseif not repaired then
        pcall(repairGamePhone)
    end
end

function M.on_begin()
    lastPoll = os.time()
end

function M.on_tick()
    local now = os.time()
    runChecks(now)
    pollHide()
    -- The 智能对话 box camera, polled faster than the rest (FocusCamera paces itself).
    local okF, errF = pcall(FocusCamera.tick)
    if not okF then print(TAG .. "Z error " .. token(tostring(errF)):sub(1, 120)) end
    if now - lastPoll >= POLL_S then
        lastPoll = now
        pollBuffs(now)
        pollMeals()
        pollFreelance()
        pollMessages()
        pollVehicle()
        pollPrefs()
        pollCareer()
        Schedules.tick(MOD_ID)
    end
end

return M
