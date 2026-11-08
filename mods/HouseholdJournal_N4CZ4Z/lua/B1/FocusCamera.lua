-- HouseholdJournal -- B1 FocusCamera
-- The camera of the phone mod's "智能对话" box (HouseholdBoard ui/focus): while the box is open
-- the camera turns to the character being talked to, the way an RPG frames a conversation,
-- and goes back to the played character when it closes.
--
-- Request, written by the focus app: <phone mod>/ui/focus/camera.cfg
--   <ms>:open:<player>:<target>   rewritten every few seconds while the box is open
--   <ms>:close:<player>:<target>
-- An open request not refreshed for STALE_MS counts as closed (the box went away without saying).
--
-- Two ways to aim the camera, the first that works is kept for the rest of the run:
--   alt   the camera manager's own alternate camera (ConfigureAlternateCamera with the camera
--         mode it is using now and the target as view target, then SetUsingAlternateCamera)
--   view  the player controller's SetViewTargetWithBlend
-- Whether it worked is read back from the camera (its view target). While the target is in
-- view its camera mode gets a narrower field of view (TUNE fov), put back afterwards.
-- Lines in the Lua log: [HouseholdJournal] Z <event> ...

local HJActors = require("HJActors")

local M = {}

local PHONE_MOD_ID = "HouseholdBoard_I6IXIO"
local SECTION = "ui/focus"
local TAG = "[HouseholdJournal] Z "
local POLL_S = 0.25
local STALE_MS = 15000
local BLEND_S = 0.8
local VERIFY_S = 1.5
local FOV = 55

local lastPoll = -1
local active = nil      -- { seq, player, target, actor, way, since, verified, fovMode, fovOld }
local broken = {}       -- ways that failed this run
local lastValue = ""
local startedMs = os.time() * 1000

local function token(v)
    return (tostring(v):gsub("[^%w_%-%.=:/>]", ""))
end

local function log(text)
    print(TAG .. text)
end

local function readRequest()
    local ok, _, data = inzoi.cli.execute("uimod.cfg_load mod_id=" .. PHONE_MOD_ID .. " section=" .. SECTION .. " key=camera")
    if not ok or type(data) ~= "string" then return nil end
    local value = data:match('"value"%s*:%s*"([^"]*)"')
    if not value then return nil end
    local seq, op, player, target = value:match("^(%d+):(%a+):(%d+):(%d+)$")
    if not seq then return nil end
    return { seq = tonumber(seq), op = op, player = player, target = target, value = value }
end

local function actorOf(id)
    local any = HJActors.latest()
    if not any then return nil end
    local found = nil
    pcall(function()
        local arr = UE.TArray(UE.AActor)
        UE.UGameplayStatics.GetAllActorsOfClass(any, UE.UClass.Load("/Script/BlueClient.B1Character"), arr)
        for i = 1, arr:Length() do
            local a = arr:Get(i)
            local okI, v = pcall(function() return tostring(a.EntityId.Value) end)
            if okI and v == id then found = a return end
        end
    end)
    return found
end

local function cameraOf(actor)
    local ok, cam = pcall(function() return UE.UGameplayStatics.GetPlayerCameraManager(actor, 0) end)
    if ok then return cam end
    return nil
end

local function controllerOf(actor)
    local ok, pc = pcall(function() return UE.UGameplayStatics.GetPlayerController(actor, 0) end)
    if ok then return pc end
    return nil
end

local function list(arr)
    local n
    if not pcall(function() n = arr:Length() end) or not n then
        if not pcall(function() n = arr:Num() end) or not n then return {} end
    end
    local out = {}
    for i = 1, n do
        local ok, v = pcall(function() return arr:Get(i) end)
        if ok and v ~= nil then out[#out + 1] = v end
    end
    return out
end

local function shortName(obj)
    local text = tostring(obj)
    return string.match(text, "([%w_]+_C)[:%s]") or text
end

-- What the camera follows now: the actor, or nil.
local function viewTarget(cam)
    local ok, t = pcall(function() return cam.ViewTarget.Target end)
    if ok and t ~= nil then return t end
    local okS, stack = pcall(function() return list(cam.CameraBlendStack) end)
    if okS and stack and #stack > 0 then
        local okT, top = pcall(function() return stack[#stack].ViewTarget end)
        if okT then return top end
    end
    return nil
end

-- Whether the camera frames the actor: its view target, or any camera of its blend stack (the
-- alternate camera has its own view target there).
local function onTarget(cam, actor)
    local okT, t = pcall(function() return cam.ViewTarget.Target end)
    if okT and t == actor then return true end
    local okS, stack = pcall(function() return list(cam.CameraBlendStack) end)
    if okS and stack then
        for _, e in ipairs(stack) do
            local okE, v = pcall(function() return e.ViewTarget end)
            if okE and v == actor then return true end
        end
    end
    return false
end

local function describe(cam)
    local parts = {}
    pcall(function() parts[#parts + 1] = "kind=" .. tostring(cam:GetCurrentCameraModeType()) end)
    pcall(function() parts[#parts + 1] = "mode=" .. shortName(cam:GetCurrentCameraMode()) end)
    pcall(function() parts[#parts + 1] = "alt=" .. tostring(cam:IsUsingAlternateCamera()) end)
    pcall(function() parts[#parts + 1] = "target=" .. shortName(viewTarget(cam)) end)
    pcall(function()
        local names = {}
        for _, e in ipairs(list(cam.CameraBlendStack)) do names[#names + 1] = shortName(e.Camera) .. ">" .. shortName(e.ViewTarget) end
        parts[#parts + 1] = "stack=[" .. table.concat(names, ",") .. "]"
    end)
    return table.concat(parts, " ")
end

-- The class of the camera mode in use, for the alternate camera.
local function currentModeClass(cam)
    local okC, current = pcall(function() return cam:GetCurrentCameraMode() end)
    if okC and current then
        for _, inst in ipairs(list(cam.CameraModeInstances)) do
            local okM, same = pcall(function() return inst.CameraMode == current end)
            if okM and same then
                local okK, cls = pcall(function() return inst.CameraModeClass end)
                if okK and cls then return cls, "instance" end
            end
        end
        local okG, cls = pcall(function() return current:GetClass() end)
        if okG and cls then return cls, "getclass" end
    end
    return nil, "none"
end

local WAYS = {
    alt = {
        aim = function(cam, pc, actor)
            local cls, how = currentModeClass(cam)
            if not cls then error("no_mode_class") end
            cam:ConfigureAlternateCamera(cls, actor, BLEND_S)
            cam:SetUsingAlternateCamera(true)
            return how
        end,
        back = function(cam, pc, player)
            cam:SetUsingAlternateCamera(false)
            cam:ClearAlternateCamera()
        end
    },
    view = {
        aim = function(cam, pc, actor)
            if not pc then error("no_controller") end
            pc:SetViewTargetWithBlend(actor, BLEND_S, 0, 0, false)
            return "blend"
        end,
        back = function(cam, pc, player)
            if pc and player then pc:SetViewTargetWithBlend(player, BLEND_S, 0, 0, false) end
        end
    }
}
local ORDER = { "alt", "view" }

-- The camera mode now aimed at the target: a narrower view for the close-up.
local function narrow(cam, a)
    if a.fovMode then return end
    for _, inst in ipairs(list(cam.CameraModeInstances)) do
        local okT, t = pcall(function() return inst.ViewTarget end)
        if okT and t == a.actor then
            local okF, old = pcall(function() return inst.CameraMode.FOV end)
            if okF and type(old) == "number" then
                local okW = pcall(function() inst.CameraMode.FOV = FOV end)
                if okW then
                    a.fovMode = inst.CameraMode
                    a.fovOld = old
                    log("fov " .. tostring(old) .. ">" .. FOV .. " " .. shortName(inst.CameraMode))
                end
            end
            return
        end
    end
end

local function release(why)
    local a = active
    active = nil
    if not a then return end
    local player = actorOf(a.player)
    local cam = cameraOf(player or a.actor or HJActors.latest())
    local pc = controllerOf(player or a.actor or HJActors.latest())
    if a.fovMode then pcall(function() a.fovMode.FOV = a.fovOld end) end
    if a.way and cam then
        local ok, err = pcall(WAYS[a.way].back, cam, pc, player)
        log("close " .. why .. " way=" .. a.way .. " " .. (ok and "ok" or ("error_" .. token(err):sub(1, 80))) .. " " .. describe(cam))
    else
        log("close " .. why .. " way=none")
    end
end

-- Aims with the next way not known to fail.
local function aim(a)
    local cam = cameraOf(a.actor)
    if not cam then return log("open no_camera") end
    local pc = controllerOf(a.actor)
    for _, name in ipairs(ORDER) do
        if not broken[name] then
            local ok, how = pcall(WAYS[name].aim, cam, pc, a.actor)
            if ok then
                a.way = name
                a.since = os.clock()
                a.verified = false
                log("open target=" .. a.target .. " way=" .. name .. " how=" .. token(how))
                return
            end
            broken[name] = true
            log("way " .. name .. " error_" .. token(how):sub(1, 100))
        end
    end
    log("open target=" .. a.target .. " no_way " .. describe(cam))
end

local function open(req)
    if active and active.target == req.target and active.player == req.player then
        active.seq = req.seq
        return
    end
    if active then release("switch") end
    local actor = actorOf(req.target)
    if not actor then return log("open target=" .. req.target .. " not_spawned") end
    local cam = cameraOf(actor)
    log("before " .. (cam and describe(cam) or "no_camera"))
    active = { seq = req.seq, player = req.player, target = req.target, actor = actor }
    aim(active)
end

-- After the blend: is the camera on the target? If not, that way does not work here.
local function verify(a)
    if not a.way or a.verified or os.clock() - (a.since or 0) < VERIFY_S then return end
    local cam = cameraOf(a.actor)
    if not cam then return end
    if onTarget(cam, a.actor) then
        a.verified = true
        log("aimed way=" .. a.way .. " " .. describe(cam))
        narrow(cam, a)
        return
    end
    log("missed way=" .. a.way .. " " .. describe(cam))
    pcall(WAYS[a.way].back, cam, controllerOf(a.actor), actorOf(a.player))
    broken[a.way] = true
    a.way = nil
    aim(a)
end

function M.tick()
    local now = os.clock()
    if now - lastPoll < POLL_S then
        if active then verify(active) end
        return
    end
    lastPoll = now
    local req = readRequest()
    local nowMs = os.time() * 1000
    if req and req.value ~= lastValue then
        lastValue = req.value
        if req.op == "open" and req.seq >= startedMs - 2000 and nowMs - req.seq < STALE_MS then
            open(req)
        elseif req.op ~= "open" and active then
            release("closed")
        end
    end
    if active then
        local alive = pcall(function() return active.actor.EntityId.Value end)
        if not alive then return release("target_gone") end
        if nowMs - active.seq > STALE_MS then return release("stale") end
        verify(active)
    end
end

return M
