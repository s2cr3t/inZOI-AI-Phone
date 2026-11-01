# inZOI Lua Mod - Agent Guide

This folder holds the Lua scripts for an inZOI mod. Follow these conventions.

## Layout
- Scripts live under `B2/` (simulation thread) and `B1/` (client/render thread).
- A script's module (require) path is its path under the env folder, dotted:
  `B2/Components/EmotionTracker.lua` -> module `Components.EmotionTracker`.
- `lua_manifest.json` declares manifest bindings; do not invent other manifest files.

## Two ways a script runs
1. **Manifest binding** (`lua_manifest.json` -> `bindings.{B2,B1}`): entry `{ type, key, script }`.
   Types: Zoi, ObjectTemplate, Household, Vehicle, Component, Manager. Activates only while the
   entry exists. Lifecycle: `M.on_begin(self, owner)`, `M.on_tick(self, owner, dt)`, `M.on_end(self, owner)`.
2. **Chunk-based module**: a script whose module path equals a C++ chunk path (e.g.
   `Actions.B2Action_Buy`, `Scripts.B2Script_Family`, `Actors.B1GizmoActor`). Auto-loaded by the
   runtime when the file exists (no manifest entry needed).

## Override functions (intercept native C++ calls)
- Define `function M.Override_<NativeFunc>(...)`. There is **no leading `self`**.
- **Static / chunk-module overrides**: module-level, first parameter is the first C++ argument.
  Call the original via `inzoi.<Type>.<Func>(...)`.
- **Per-entity overrides** (manifest Component/Manager/entity types): first parameter is the bound
  target (`owner` / `comp` / `manager`), then the C++ arguments. Call original via `owner:<Func>(...)`.
- Every binding module returns its table: end files with `return M`.

## APIs
- `inzoi.cli.execute(command_line)` -> **3 return values** `success (boolean), message (string), data (string|nil)`.
  - Takes ONE command-line STRING (args inline), NOT `(name, {args})`. Args are space-separated `key=value`
    (quote values with spaces): `inzoi.cli.execute('motion.play anim_id=Self_Crouch entity_id=' .. id)`.
  - `data` is a JSON STRING (not a table). Parse it if you need fields; do NOT index the boolean.
    Capture all three: `local ok, msg, data = inzoi.cli.execute('entity.get_possessed')`.
  - (The `(name, {args}) -> {success,message,data}` table form is the UI-mod JavaScript API, NOT Lua.)
- `inzoi.event.on(event_id, cb)` -> `handle` (integer; 0 on failure). `cb` receives ONE payload table
  (snake_case fields). Unsubscribe with `inzoi.event.off(event_id, handle)`.
  (The UI-mod JS form `on(name, cb) -> { remove = fn }` is NOT the Lua form.)
- `inzoi.message.send(entity_id, type, content)` (also `send_to_sim` / `send_to_client`); no return value.
- `Main.lua` (per env) is a boot module: `on_begin/on_tick/on_end` with no owner; auto-loaded.

## Sandbox (blocked standard-library features)
Lua mods run sandboxed. Using a blocked feature fails static analysis AND is stripped at runtime:
- Blocked tables: `io`, `debug`, `File` (any member access errors).
- Blocked functions: `dofile`, `loadfile`, `loadstring`.
- Blocked `require`: `http`, `socket`, `socket.http`, `ssl`, `ssl.https`.
- `os` is PARTIALLY allowed: only `os.time`, `os.clock`, `os.date`, `os.difftime`.
  `os.execute` / `os.remove` / `os.rename` / `os.exit` / `os.getenv` / `os.tmpname` / `os.setlocale`
  and dynamic `os[...]` / `os:...` are blocked. Do NOT use them.
- For RNG, `math.random` / `math.randomseed` are fine (seed with `os.time()` if you want per-session
  variation; each entity already gets independent draws). Do not reach for `io`/`os.execute`.

## Type annotations (LuaLS `---@`)
- Annotate callback parameters with their REAL type so hover / autocomplete / type-check work.
  The scaffold already emits these -- KEEP them when you rewrite a file.
- NEVER write `---@param x any` with the real type only in a trailing comment; that defeats LuaLS.
    BAD:   `---@param char any  -- FB2Character`
    GOOD:  `---@param char FB2Character`
- `self` is a plain table: `---@param self table`.
- The type name is the C++ export name (e.g. `FB2Character`, `FB2StatComponent`) and resolves
  against luals-defs. Get the bound target's type from `lua_api_lookup` or the binding:
  Zoi -> `FB2Character`, Component key=Stat -> `FB2StatComponent`, Manager key=Weather -> `FB2WeatherManager`, etc.
- Override stubs: annotate every parameter and the return, e.g.
    `---@param owner FB2GameObject` / `---@param InSlotName FName` -> use `string` for FName/FString/FText,
    `integer` for int/uint, `number` for float/double, `boolean` for bool.

## Editing
- Keep B2 (simulation) and B1 (client) logic in their own folders; they run on different threads.
- Prefer the types/fields surfaced by LuaLS (see .luarc.json / luals-defs) over guessing names.