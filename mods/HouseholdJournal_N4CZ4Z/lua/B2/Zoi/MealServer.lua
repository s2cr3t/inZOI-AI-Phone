-- HouseholdJournal -- B2 Zoi.MealServer
-- Takes a family meal out of the fridge for the SMS bridge, puts it on a table, serves one
-- portion and eats it, or serves it to someone, all with the game's own interactions.
--
-- The fridge's 取出 only opens the inventory picker; the item the player clicks there becomes
-- the queue's PickedEntityId of the hidden Storage_Fridge_TakeOut_SelectedFood. Nobody clicks
-- for a character the player is not controlling, so this fills PickedEntityId in instead.
-- After the pick-up the game itself queues Next_AllTypeFood_Start_Eat, which puts a family meal
-- down on any surface and stops. That is swapped, on the tick it appears, for one of:
--   e: Next_Food_Start_Eat_Both_Prepared_Served -- table only, then take one portion
--      (Next_PreparedCake_EatServedCake), eat it, clean up.
--   t: Next_Food_Start_Eat -- for a carried family meal: table only, then stand by it smelling
--      the food or clapping (Next_Smell_Food_Stand). Nobody eats; the family serves themselves.
--   g: AutoFind_DeliveryFood_To_Target on a person -- the game's own "serve food to someone":
--      the dish is put down in front of that person.
-- And for a dish already standing out (container 0):
--   h: PickUp on the dish, then AutoFind_DeliveryFood_To_Target on the person.
-- When the delivery does not start, the dish still in hand goes onto a table the way t does,
-- reported as served with detail "table_fallback", so it is never dropped on the floor.
--
-- The take-out only starts on free hands with nothing queued or playing. An action interrupted
-- by it would resume afterwards while the dish is still carried, and the game drops a carried
-- dish when the character picks something else up.
--
-- Messages, sent by B1Main to the character who takes the dish out:
--   "HouseholdJournal.meal", content "<seq>:<dish>:<container>:<e|t>" or
--     "<seq>:<dish>:<container>:<g|h>:<person>"
--   "HouseholdJournal.mealcancel", content "<seq>" (the bridge stopped waiting)
-- Progress, printed to the Lua log the bridge tails:
--   [HouseholdJournal] T <boot>,<seq>,<stage>,<actor>,<dish>,<detail>
--   stage: queued | out | served | fail

---@class MealServer
local M = {}

local TAG = "[HouseholdJournal] "
local MESSAGE = "HouseholdJournal.meal"
local CANCEL = "HouseholdJournal.mealcancel"
local TAKEOUT = "Storage_Fridge_TakeOut_SelectedFood"
local AUTO_NEXT = "Next_AllTypeFood_Start_Eat"
local SERVE = { e = "Next_Food_Start_Eat_Both_Prepared_Served", t = "Next_Food_Start_Eat" }
local DELIVER = "AutoFind_DeliveryFood_To_Target"
local PICKUP = "PickUp"
-- The delivery is made of this step; either bag id on the body means it started.
local DELIVER_STEP = "AutoFind_Putdown_Food_To_Target"
local PICKUP_MAX_S = 60
-- Game seconds (the tick's dt), so a paused game never times a request out.
local IDLE_WAIT_S = 20
local START_WAIT_S = 15
local TAKEOUT_MAX_S = 180
local SERVE_WAIT_S = 10
-- Between the pick-up and the game's own follow-up the body can be idle for a tick.
local AUTO_NEXT_GAP_S = 1

local boot = tostring(os.time()) .. tostring(math.random(100, 999))
local pending = {}
local pendingCount = 0

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

local function entityKey(n)
    local key = inzoi.FB1EntityId()
    key.Value = tonumber(n)
    return key
end

local function report(seq, stage, actor, dish, detail)
    print(TAG .. "T " .. table.concat({ boot, token(seq), stage, token(actor), token(dish), token(detail) }, ","))
end

local function enumName(enum, value)
    local ok, n = pcall(function() return inzoi[enum].GetNameStringByValue(value) end)
    if ok and n ~= nil then return tostring(n) end
    return ""
end

-- The cancel reason the game uses when one action takes another's place; read from the enum by
-- name so a reordered enum in a game update does not pick something else.
local cancelReason = nil
local function replaceReason()
    if cancelReason ~= nil then return cancelReason end
    local found = {}
    for v = 0, 120 do
        local n = enumName("EB1InteractionCancelReason", v)
        if n ~= "" and found[n] == nil then found[n] = v end
    end
    for _, pattern in ipairs({ "Interrupt", "Replace", "Override", "^User" }) do
        for n, v in pairs(found) do
            if n:find(pattern) then
                cancelReason = v
                return v
            end
        end
    end
    cancelReason = 1
    return cancelReason
end

local function playReason(name)
    local ok, v = pcall(function() return inzoi.EB1InteractionPlayReason[name] end)
    if ok and v ~= nil then return v end
    return nil
end

local function householdMembers()
    local ok, _, data = inzoi.cli.execute("household.get_members")
    if not ok or type(data) ~= "string" then return nil end
    local found = {}
    for id in data:gmatch('"entity_id"%s*:%s*(%d+)') do found[id] = true end
    return found
end

local function currentBag(comp)
    local ok, bag = pcall(function() return comp:GetCurrentInteractionBagId() end)
    if not ok or bag == nil then return "" end
    local s = tostring(bag)
    if s == "None" or s == "nil" then return "" end
    return s
end

-- "" when both hands are free, else the body part name the game reports as holding something.
local function handsBusy(owner)
    local ok, parts = pcall(function() return owner:GetGrabBodyParts() end)
    if not ok or parts == nil then return "" end
    local n = enumName("EB1AnimBodyParts", parts)
    if n == "" or n == "None" or n == "Invalid" then return "" end
    return n
end

local function holding(owner, dish)
    local ok, yes = pcall(function() return owner:IsGrabObject(entityKey(dish)) end)
    return ok and yes == true
end

-- The dish has to be the family meal the bridge saw: still inside that container, edible.
local function checkDish(dish, container)
    local okM, mgr = pcall(function() return inzoi.getB2Manager("FB2EntityManager") end)
    if not okM or not mgr then return "no_entity_manager" end
    local ok, list = pcall(function() return mgr:GetAllEntities(inzoi.EB2EntityType.GameObject):ToTable() end)
    if not ok or type(list) ~= "table" then return "no_object_list" end
    for i = 1, #list do
        local obj = list[i]
        local okI, id = pcall(function() return obj:GetEntityId() end)
        if okI and idText(id) == dish then
            local _, master = pcall(function() return obj:GetInventoryMasterEntityId() end)
            if idText(master) ~= container then return "not_in_container_" .. idText(master) end
            local _, prepared = pcall(function() return obj:HasObjectTag("PreparedFood") end)
            if prepared ~= true then return "not_family_meal" end
            local _, spoiled = pcall(function() return obj:IsSpoiled() end)
            if spoiled == true then return "spoiled" end
            local _, edible = pcall(function() return obj:IsEdible() end)
            if edible ~= true then return "not_edible" end
            return nil
        end
    end
    return "dish_gone"
end

-- A dish standing out (h): it exists, is in nobody's inventory and can still be eaten.
local function checkLoose(dish)
    local okM, mgr = pcall(function() return inzoi.getB2Manager("FB2EntityManager") end)
    if not okM or not mgr then return "no_entity_manager" end
    local ok, list = pcall(function() return mgr:GetAllEntities(inzoi.EB2EntityType.GameObject):ToTable() end)
    if not ok or type(list) ~= "table" then return "no_object_list" end
    for i = 1, #list do
        local obj = list[i]
        local okI, id = pcall(function() return obj:GetEntityId() end)
        if okI and idText(id) == dish then
            local _, master = pcall(function() return obj:GetInventoryMasterEntityId() end)
            local inside = idText(master)
            if inside ~= "" and inside ~= "0" and inside ~= "-1" then return "in_container_" .. inside end
            local _, spoiled = pcall(function() return obj:IsSpoiled() end)
            if spoiled == true then return "spoiled" end
            local _, edible = pcall(function() return obj:IsEdible() end)
            if edible ~= true then return "not_edible" end
            return nil
        end
    end
    return "dish_gone"
end

local function addQueue(comp, actor, dish, bag)
    local req = inzoi.FB2AddInteractionQueueRequest()
    req.InteractionBagId = bag
    req.OwnerEntityId = entityKey(actor)
    req.PickedEntityId = entityKey(dish)
    req.PlayReason = playReason("User")
    return comp:AddAndUpdateInteractionQueue(req)
end

-- An interaction aimed at an entity (the dish to pick up, the person to serve), the way the
-- game's own click on that entity queues it. Returns nil when queued, else why not.
local function addTargeted(comp, target, bag)
    local okV, point = pcall(function() return UE.FVector() end)
    if not okV then point = nil end
    local ok, res = pcall(function()
        return comp:AddInteractionQueueByParam(entityKey(target), point, bag, playReason("User"), false, false, "", true, false)
    end)
    if not ok then return "add_failed_" .. short(res) end
    local name = enumName("EB1AddInteractionQueueResult", res)
    if name == "" or name == "Success" or name == "Coop" or name == "Talk" then return nil end
    return "not_queued_" .. name
end

local function finish(actor, stage, detail)
    local p = pending[actor]
    if not p then return end
    pending[actor] = nil
    pendingCount = pendingCount - 1
    report(p.seq, stage, actor, p.dish, detail)
end

-- The person could not be served: the dish in hand goes onto a table the way t does.
local function startFallback(comp, actor, p, why)
    p.fallback = token(why):sub(1, 40)
    p.serve = SERVE.t
    local okA, err = pcall(function() return addQueue(comp, actor, p.dish, SERVE.t) end)
    if not okA then return finish(actor, "fail", "fallback_add_failed_" .. short(err)) end
    p.stage = "serve"
    p.age = 0
    report(p.seq, "out", actor, p.dish, "fallback_" .. p.fallback)
end

local function interactionOf(owner)
    local ok, comp = pcall(function() return owner:GetComponent(inzoi.EB2ComponentType.Interaction) end)
    if ok and comp then return comp end
    return nil
end

local function accept(owner, content)
    local text = tostring(content or "")
    local seq, dish, container, mode = text:match("^(%d+):(%d+):(%d+):([et])$")
    local person = nil
    if not seq then
        seq, dish, container, mode, person = text:match("^(%d+):(%d+):(%d+):([gh]):(%d+)$")
    end
    local okT, rawActor = pcall(function() return owner:GetEntityId() end)
    local actor = okT and idText(rawActor) or ""
    if not seq then return report(text:match("^(%d+)") or "", "fail", actor, "", "bad_request") end
    if actor == "" then return report(seq, "fail", "", dish, "no_owner_id") end
    if pending[actor] then return report(seq, "fail", actor, dish, "busy_with_" .. pending[actor].seq) end
    local members = householdMembers()
    if not members then return report(seq, "fail", actor, dish, "no_members") end
    if not members[actor] then return report(seq, "fail", actor, dish, "not_household") end
    if person then
        if person == actor then return report(seq, "fail", actor, dish, "person_is_actor") end
        if not members[person] then return report(seq, "fail", actor, dish, "person_not_household") end
    end
    local bad
    if mode == "h" then bad = checkLoose(dish) else bad = checkDish(dish, container) end
    if bad then return report(seq, "fail", actor, dish, bad) end
    pending[actor] = {
        seq = seq, dish = dish, container = container, mode = mode, person = person,
        serve = person and DELIVER or SERVE[mode], stage = "idle", age = 0
    }
    pendingCount = pendingCount + 1
end

-- Waits for an idle body, clearing what autonomy starts meanwhile (the bridge already put the
-- character's own action down), then queues the take-out with the dish picked.
local function stepIdle(owner, comp, actor, p)
    local bag = currentBag(comp)
    local okQ, empty = pcall(function() return comp:IsQueueEmpty() end)
    local hands = handsBusy(owner)
    if bag == "" and okQ and empty == true and hands == "" then
        if p.mode == "h" then
            local loose = checkLoose(p.dish)
            if loose then return finish(actor, "fail", loose) end
            local why = addTargeted(comp, p.dish, PICKUP)
            if why then return finish(actor, "fail", "pickup_" .. why) end
            p.stage = "pickup"
            p.age = 0
            report(p.seq, "queued", actor, p.dish, "")
            return
        end
        local bad = checkDish(p.dish, p.container)
        if bad then return finish(actor, "fail", bad) end
        local okA, err = pcall(function() return addQueue(comp, actor, p.dish, TAKEOUT) end)
        if not okA then return finish(actor, "fail", "add_failed_" .. short(err)) end
        p.stage = "start"
        p.age = 0
        report(p.seq, "queued", actor, p.dish, "")
        return
    end
    if p.age > IDLE_WAIT_S then
        return finish(actor, "fail", hands ~= "" and ("hands_full_" .. hands) or ("busy_" .. (bag ~= "" and bag or "queue")))
    end
    if bag ~= "" and hands == "" then
        local okR, reason = pcall(function() return comp:GetCurrentInteractionPlayReason() end)
        if okR and reason == playReason("Autonomy") then
            pcall(function() comp:ClearInteractionQueue(replaceReason(), true) end)
        end
    end
end

local function stepStart(owner, comp, actor, p)
    local bag = currentBag(comp)
    if bag == TAKEOUT then
        p.stage = "takeout"
        p.age = 0
        return
    end
    if bag == AUTO_NEXT or holding(owner, p.dish) then
        p.stage = "takeout"
        return
    end
    if p.age > START_WAIT_S then return finish(actor, "fail", "not_started_" .. (bag ~= "" and bag or "idle")) end
end

-- The dish is in hand once the game moves on to its own follow-up; that follow-up is replaced
-- in the same tick, before it walks anywhere.
local function stepTakeout(owner, comp, actor, p)
    local bag = currentBag(comp)
    if bag == TAKEOUT then
        if p.age > TAKEOUT_MAX_S then return finish(actor, "fail", "takeout_too_long") end
        return
    end
    if not holding(owner, p.dish) then
        return finish(actor, "fail", "not_in_hand_after_takeout_" .. (bag ~= "" and bag or "idle"))
    end
    if bag == "" then
        p.gapFrom = p.gapFrom or p.age
        if p.age - p.gapFrom < AUTO_NEXT_GAP_S then return end
    end
    if bag == AUTO_NEXT then
        pcall(function() comp:TryCancelCurrentInteraction(replaceReason()) end)
    end
    if p.person then
        local why = addTargeted(comp, p.person, DELIVER)
        if why then return startFallback(comp, actor, p, why) end
    else
        local okA, err = pcall(function() return addQueue(comp, actor, p.dish, p.serve) end)
        if not okA then return finish(actor, "fail", "serve_add_failed_" .. short(err)) end
    end
    p.stage = "serve"
    p.age = 0
    report(p.seq, "out", actor, p.dish, bag)
end

-- h: walking to the dish and lifting it. Once it is in hand the delivery replaces whatever the
-- game would do next, in the same tick.
local function stepPickup(owner, comp, actor, p)
    local bag = currentBag(comp)
    if not holding(owner, p.dish) then
        if p.age > PICKUP_MAX_S then return finish(actor, "fail", "pickup_too_long_" .. (bag ~= "" and bag or "idle")) end
        if bag == "" and p.age > START_WAIT_S then return finish(actor, "fail", "pickup_not_started") end
        return
    end
    if bag ~= "" and bag ~= PICKUP then
        pcall(function() comp:TryCancelCurrentInteraction(replaceReason()) end)
    end
    local why = addTargeted(comp, p.person, DELIVER)
    if why then return startFallback(comp, actor, p, why) end
    p.stage = "serve"
    p.age = 0
    report(p.seq, "out", actor, p.dish, bag)
end

local function stepServe(owner, comp, actor, p)
    local bag = currentBag(comp)
    if bag == p.serve or (p.person and bag == DELIVER_STEP) then
        return finish(actor, "served", p.fallback and ("table_fallback_" .. p.fallback) or "")
    end
    if p.age > SERVE_WAIT_S then
        if p.person and not p.fallback and holding(owner, p.dish) then
            return startFallback(comp, actor, p, "deliver_not_started_" .. (bag ~= "" and bag or "idle"))
        end
        return finish(actor, "fail", "serve_not_started_" .. (bag ~= "" and bag or "idle") .. (holding(owner, p.dish) and "_in_hand" or "_not_in_hand"))
    end
end

local STEPS = { idle = stepIdle, start = stepStart, takeout = stepTakeout, pickup = stepPickup, serve = stepServe }

---@param self table
---@param owner FB2Character
---@param dt number
-- Proof that the B2 bindings are registered. Reloading another Lua mod can drop them while
-- B2 Main keeps running, and the bridge cannot tell that from silence alone.
--   [HouseholdJournal] W <boot>
local BEAT_S = 30
local lastBeat = nil

local function beat()
    local now = os.time()
    if lastBeat and now - lastBeat < BEAT_S then return end
    lastBeat = now
    print(TAG .. "W " .. boot)
end

function M.on_tick(self, owner, dt)
    pcall(beat)
    if pendingCount <= 0 then return end
    local okT, rawActor = pcall(function() return owner:GetEntityId() end)
    if not okT then return end
    local actor = idText(rawActor)
    local p = pending[actor]
    if not p then return end
    p.age = p.age + (type(dt) == "number" and dt > 0 and dt or 0)
    local comp = interactionOf(owner)
    if not comp then return finish(actor, "fail", "no_interaction_component") end
    local ok, err = pcall(STEPS[p.stage], owner, comp, actor, p)
    if not ok then finish(actor, "fail", "error_" .. short(err)) end
end

-- The bridge stopped waiting. Only a request whose dish is still in the fridge is dropped; once
-- the take-out has started, the meal is carried through rather than left half done.
local function withdraw(owner, content)
    local seq = tostring(content or ""):match("^(%d+)$")
    local okT, rawActor = pcall(function() return owner:GetEntityId() end)
    local actor = okT and idText(rawActor) or ""
    local p = pending[actor]
    if not seq or not p or p.seq ~= seq then return end
    if p.stage == "idle" or ((p.stage == "start" or p.stage == "pickup") and not holding(owner, p.dish)) then
        local comp = interactionOf(owner)
        local bag = comp and currentBag(comp) or ""
        if comp and ((p.stage == "start" and bag == TAKEOUT) or (p.stage == "pickup" and bag == PICKUP)) then
            pcall(function() comp:TryCancelCurrentInteraction(replaceReason()) end)
        end
        finish(actor, "fail", "canceled_by_bridge")
    end
end

---@param self table
---@param owner FB2Character
function M.on_lua_message(self, owner, ...)
    local args = { ... }
    for i = 1, #args do
        if args[i] == MESSAGE then
            local ok, err = pcall(accept, owner, args[i + 1])
            if not ok then report("", "fail", "", "", "accept_error_" .. short(err)) end
            return
        end
        if args[i] == CANCEL then
            local ok, err = pcall(withdraw, owner, args[i + 1])
            if not ok then report(tostring(args[i + 1] or ""), "fail", "", "", "withdraw_error_" .. short(err)) end
            return
        end
    end
end

---@param self table
---@param owner FB2Character
function M.on_end(self, owner)
    local okT, rawActor = pcall(function() return owner:GetEntityId() end)
    if okT and pending[idText(rawActor)] then finish(idText(rawActor), "fail", "character_unloaded") end
end

return M
