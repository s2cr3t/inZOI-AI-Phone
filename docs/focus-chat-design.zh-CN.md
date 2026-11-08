# 「专注聊天」设计方案

> **实现状态（2026-11-07）**：第 1 到第 3 步已在游戏里实测通过。
> - 菜单注入：UI app `ui/focus`，触发器类型 interaction_menu。
> - 对话框和面对面通道：`lib/focus.js`、`lib/focus-body.js`、`persona.talkPrompt`，以及 daemon 里的 `tickTalks / talkReply / talkSummarize`。
> - 镜头：`B1/FocusCamera.lua`，用备用镜头这条路，视角收窄到 55，关闭时还原。
>
> 第 4 步里「两人互相看着」「目标角色停下手头的事」还没做。

# 原始设计（草案）

目标：点击一个角色，交互菜单里出现「智能对话」；点了以后镜头拉到这个角色身上，屏幕底部弹出对话框，和这个角色面对面聊天。回复由现有服务用这个角色的人设和记忆生成，角色说话时有表情和动作。按 Esc 或关闭按钮结束对话，镜头还原。

状态说明：✅ 已确认（实测，或在现有代码里已经跑通）　🟡 有依据但没实测　❓ 需要在游戏里验证

---

## 1. 交互菜单里加「智能对话」

**方案 A（推荐）：UI mod 自带的 `interaction_menu` 触发器**，不需要改数据表。

> **探路结果（2026-11-07）✅**：manifest 写成 `{ "id": "focus_chat", "type": "interaction_menu", "target": "character", "label_key": "智能对话", "context_pass": true, "action": "show" }`，菜单里就会出现「智能对话」，`label_key` 填的文字原样显示。点击后窗口弹出，回调收到的内容是
> `{"triggerId":"focus_chat","subItemId":"","targetEntityId":<被点的人>,"selfEntityId":<玩家>}`。
> 要注意三点：① 必须写 `"action": "show"`，不写的话窗口不会弹出，脚本也不会运行；② 每点一次，同一个触发会在同一时刻送来**两次**，要去重；③ 窗口在第一次被点开前不会加载，触发是在页面加载完之后才送到的，所以第一次点击也能收到。

- ModKit 文档 `ws_uimod.md` 写明：UI mod 的 manifest 可以声明
  `{ "id": "focus_chat", "type": "interaction_menu", "target": "character", "label_key": "智能对话" }`，
  在游戏的交互菜单里注入一项，玩家选中后这个 app 显示出来，并触发 `inzoi.trigger.onActivated(t)`。🟡
- 游戏程序里能找到对应的实现：`UB1UIModInteractionInjector`、`FB1UIModInteractionItem`（字段有 DisplayText、IconPath、Position、SubItemId、TriggerId），菜单项 ID 的格式是 `_UIMod_<mod>~<trigger>`，manifest 支持的字段有 `label_key / icon / sub_items / context_pass / target`。触发时的负载格式是 `{"targetEntityId":…,"selfEntityId":…}`，所以能拿到点的是谁。🟡
- 还要验证：❓ `label_key` 是直接显示的文字，还是 StringTable 的键（如果是键，就用 Language 工作区注册一条中文）；❓ 负载里的目标 ID 在 `t` 的哪个字段，是否需要 `context_pass: true`；❓ 能不能用 `isSelf` 一类的过滤条件，不在自己身上显示。
- 好处：点击后不会排进游戏的交互队列，角色不会先走过去演一段假对话；也不用碰游戏的交互表，和其他 mod 冲突的可能最小。

**方案 B（备选）：数据 mod 新增一条聊天交互**，在 A 不可用时再用。
- ModKit 有 `Talk` 工作区和 `modkit_build_talk_patch`，会一次性生成 TalkSelection、InteractionBag_Talk、CoopTalk、Script_Talk、Condition 这几张表的行，并在聊天分类（比如 DailyLife）里出现。✅（工具和表都在）
- 点击后的通知：B2 的 `interaction.started` 事件里有 `entity_id / interaction_bag_id / target_entity_id`。现有的 `B2/Main.lua` 已经订阅了这个事件，并在打印 J 行，例如 `J …,started,43386,Stand,43386,`。✅
- 缺点：玩家角色会真的走过去，播一段游戏自带的聊天动画；而且需要做 pak 数据 mod，要重启游戏才能生效。

## 2. 点击后怎么通知 mod

- 方案 A：UI 的 `onActivated` 直接拿到 `targetEntityId` 和 `selfEntityId`，对话框本身就是被触发的 app，不经过 Lua。🟡
- UI 通知 Lua（用来控制镜头）：UI 用 `uimod.cfg_save` 写 `ui/focus/request.cfg`，内容是 `<seq>:<player>:<target>:<open|close>`；B1 Lua 读 cfg 文件。这和现有的 freelance、messages、vehicle 用的是同一套机制。✅ 不过 B1 Main 现在每 2 秒才轮询一次，镜头要跟得上，专注聊天这一项需要单独改成约 0.25 秒轮询一次（一次 `cfg_load` 的开销很小）。
- UI 通知服务（用来生成回复）：见第 4 节。

## 3. 镜头聚焦和还原

现在玩家视角的镜头是 `BP_B1CameraMode_Follow_C`（ShoulderView），跟着玩家角色走。✅（`camera_get_view` 和日志都能看到）

游戏的 CLI 里**没有**能设置镜头位置或跟随对象的命令（只有 `camera.get_view`、改 fov、改灵敏度、自由镜头开关）。所以聚焦必须在 **B1 Lua** 里做：

- 拿到相机管理器：`UE.UGameplayStatics.GetPlayerCameraManager(owner, 0)`。✅ 之前做的「第一人称镜头修正」mod 就是这么取的，日志里能看到它读出了 `kind / current / CameraBlendStack / CameraModeInstances`。
- 聚焦（首选做法）：`AB1PlayerCameraManager2` 支持备用镜头（游戏自己的说明是 "View target to focus when using alt camera mode"）：
  1. 从 `CameraModeInstances` 里找到 Follow 模式的那一项，取它的 `CameraModeClass`；
  2. 调用 `cam:ConfigureAlternateCamera(class, 目标角色的 Actor, 0.8)`，再调用 `cam:SetUsingAlternateCamera(true)`；
  3. 镜头切换完成后，把新建的这个 Follow 实例（它的 ViewTarget 是目标角色）的 `CameraToPivot`、`LookatOffsetLocal`、`FOV` 调成近景，拉近到胸口以上，镜头稍微偏到玩家角色肩后。
  ❓ `TSubclassOf` 和 `AActor*` 这两种参数在 Lua 里怎么映射，接口元数据标的是 unverified，必须实测。
- 还原：`cam:SetUsingAlternateCamera(false)`，然后 `cam:ClearAlternateCamera()`；改过的镜头参数逐项写回原值（第一人称 mod 已经有一套「记下原值、事后还原」的写法可以照搬）。读档、换人、对话框被关掉、目标角色消失（Actor 的 on_end）时也都要自动还原。
- 备选：如果备用镜头不起作用，改用 `PlayerController:SetViewTargetWithBlend(目标Actor, 0.8)`，前提是 `UE` 表里开放了这个接口 ❓；再不行就退一步，只调整玩家自己 Follow 镜头的距离和朝向，让镜头从玩家肩后看向对方（一定能做到，但效果弱一些）。
- 目标角色的 Actor 从哪来：B1 的 Zoi 绑定已经会把见过的角色 Actor 记下来（`B1/HJActors.lua` 和 `Zoi.ActorSeen`），按 EntityId 查找就行。🟡
- 两人面对面：开始对话时让双方互相看着对方，用 B2 的 `FB2Character:StartLookAtLoc` / `FinishLookAtLoc`，走现有的 B1→B2 消息通道。🟡 另外可以让目标角色先停下手头的事（`zoi.freeze`，或者只清空交互队列），对话结束后恢复自主行为。

## 4. 对话框和回复通道

**UI**：在 `mods/HouseholdBoard_I6IXIO/ui/` 下新建一个 app，名字叫 `focus`（和 phone、board 并列，`uimod_apps.json` 里加一项）。这样不改手机的 24 个分片，手机和短信不受影响。
- 布局：底部居中一条对话框（宽约 60%），左边是角色名字和头像，中间显示最近 3～4 句（像 RPG 字幕那样逐字出现），下面是输入框加发送按钮，右上角是关闭按钮。
- 遵守 cohtml 的限制：不用 flex-wrap、不用 calc()、每个元素只用一个 animation、ES5、CRLF 行尾。
- 关闭：关闭按钮；输入框获得焦点时按 Esc；`inzoi.view.hide()` 之后写入 close 请求。❓ Esc 在游戏里本来会打开菜单，要实测输入框有焦点时 Esc 能不能被 UI 拦下来。

**通道**：新开一个「面对面」通道，**不复用**短信的 outbox 和 inbox，免得面对面的话出现在短信记录里，也免得短信那套「人在身边还发消息」的规则来干扰。
- 文件：`ui/focus/<player>-<target>/said.cfg`（只由 UI 写：玩家说的话）、`heard.cfg`（只由服务写：角色的回答，附带表情和动作）、`status.cfg`（思考中、出错）。每个文件只有一个写入方，和 mailbox 的约定一样。
- 服务端：新增 `lib/focus.js`，监听 said.cfg（和监听 outbox 的方式一样）。复用 `daemon.reply()` 里的 `snapshot`、`memoryFor`、`actions.catalog`、`deliver` 这几步，只把提示词换成新的 `persona.talkPrompt()`。新提示词的要点：现在是面对面说话；回复是口语、短句（一次 1 到 3 句）；不要写「发消息」「打字」之类的词。输出格式在现有回复的格式上加两个字段：
  - `face`：从 `facial.list` 的 42 个表情 ID 里选一个（如 Joyful、Surprised、Embarassed、Angry…）；
  - `gesture`：从一张常用动作白名单里选一个（如 wave、laugh、nod、shrug、cry、angry），也可以不选。
- 记忆：每一轮对话都写进同一个 `MemoryStore` 和日记，标记为「当面聊过」，这样之后发短信时角色记得刚才当面说过什么。现有的动作计划（`planActions`，比如答应去做某件事）照常可以触发。
- 表情和动作：服务拿到回复后调用 `facial.set entity_id=<target> Expression=<face>`（✅ 有这个 CLI），动作用 `motion.list filter=<词> validate=true entity_id=<target>` 找出这个角色能播的动画，再用 `motion.play` 播放（🟡 CLI 是通的，每个白名单词具体对应哪个动画要实测挑一下）。另外可以选择同时用 `entity.show_speech_bubble` 在头顶冒一个气泡（✅ 服务已经在用）。
- 延迟：模型生成期间，对话框显示「……」，角色这时播一个「思考」类的表情（比如 Preoccupied）。

## 5. 改动范围

| 部分 | 文件 | 生效方式 |
|---|---|---|
| UI | `mods/HouseholdBoard_I6IXIO/ui/focus/*`（新建），`ui/uimod_apps.json` | 复制到 InGame，然后 remount UI mod（游戏开着也可以） |
| B1 Lua | 新增 `lua/B1/FocusCamera.lua`，由 `B1/Main.lua` 每帧调用它的 tick；B1 Zoi 绑定补一下按 ID 查 Actor | 装进 InGame 后**重启游戏** |
| B2 Lua | `Zoi.CareerServer` 增加 `l`（互相看着）和 `u`（结束）两个操作，或者另写一个小的 `Zoi.FocusServer` | 同上，需要重启游戏 |
| 服务 | 新增 `lib/focus.js`，`persona.js` 加 `talkPrompt`，`daemon.js` 里接线 | 重启服务 |

不改手机分片，不改短信的 mailbox，不动存档。

## 6. 实施顺序（每一步都可以单独验证）

1. **探路（只动 UI，不需要重启）**：做一个最简单的 `focus` app，只声明 interaction_menu 触发器，打开后显示收到的 `t` 的完整 JSON。用来确认菜单里出现「智能对话」、`label_key` 是怎么显示的、负载里有没有目标 ID。如果不行，改走方案 B。
2. 服务的面对面通道和对话框：先不动镜头，确认能来回对话，表情和动作也能出来。
3. B1 镜头的 Lua：装进 InGame，请你重启游戏，测试聚焦和还原，以及各种异常情况（读档、换人、目标离开）。
4. 收尾：互相看着、目标角色停下手头的事、Esc 关闭、出错提示，最后跑一遍回归，确认手机和短信不受影响。

## 7. 风险

- 备用镜头的 Lua 参数映射没有验证过，这是最大的不确定点。上面准备了两级备选；最差的情况是镜头只能从玩家肩后看向对方。
- `interaction_menu` 文档把它标成 "advanced"，如果第 1 步发现不可用，就换方案 B（数据 mod，需要重启游戏）。
- 镜头相关的 Lua 每改一次都要重启游戏才能测，第 3 步需要你配合重启几次。
