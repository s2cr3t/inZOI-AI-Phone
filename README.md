# inZOI AI 手机

给 inZOI 加一部会聊天的手机：游戏里的家人、朋友会用 AI 给你发短信、发朋友圈、回复你的消息，还能真的去做事，比如点餐、买车、改变心情和喜好。

免费使用，源代码公开，非商用许可（见文末“许可”）。

## 玩家安装

1. 到 [Releases](https://github.com/s2cr3t/inZOI-AI-Phone/releases/latest) 下载最新的 `inZOI-AI-Phone-Setup-<版本>.exe`。
2. 双击安装。安装程序会把手机 mod（HouseholdBoard）和互动 mod（HouseholdJournal）装进 `文档\inZOI\Mods`，并装好在后台运行的 AI 手机服务。
3. 启动 inZOI，在 mod 设置里确认 **HouseholdBoard** 和 **HouseholdJournal** 都是打开的。
4. 进入游戏，打开手机里的 AI 设置，选择模型提供商，填入你自己的 API 密钥。

支持的提供商：DeepSeek、通义千问（Qwen）、Kimi、智谱 GLM、豆包、OpenAI，以及兼容 OpenAI 接口的自定义地址。AI 调用费用由你自己的账号承担。

要求：Windows 10 或 11，正版 inZOI。

### 只从 CurseForge 装了 mod？

手机里的 AI 需要电脑上的 AI 手机服务才能工作，mod 本身不包含它。请按上面的步骤下载并运行安装包，装好后手机会自动连上，不用重启游戏。

### 可选：RoomLights

`mods/RoomLights_N4CZ4Z` 是一个独立的小 mod，不在安装包里，需要的话手动复制到 `文档\inZOI\Mods\InGame`。

## 已知问题

见 [docs/known-issues.zh-CN.txt](docs/known-issues.zh-CN.txt)。遇到问题请在 [Issues](https://github.com/s2cr3t/inZOI-AI-Phone/issues) 反馈，并按已知问题文档最后一节的方法附上诊断包。

## 目录

| 目录 | 内容 |
|---|---|
| `bridge.js`、`server.js`、`lib/` | AI 手机服务（Node.js） |
| `native/PhoneHelper.cs` | 开机启动、保管密钥的小程序 `inZOIPhone.exe` |
| `installer/` | Inno Setup 安装脚本 |
| `mods/` | 三个游戏 mod 的发布版文件 |
| `tools/` | 打包和检查工具 |
| `tests/` | 测试 |

## 开发者打包

需要：Node.js 24、Inno Setup 6、Windows 自带的 .NET Framework 4 编译器（`csc.exe`）。

```powershell
node tools/build-installer.js --mods mods
node tools/build-test-kit.js --mods mods
```

安装包输出到 `build\dist`。不带 `--mods` 时，从本机 `文档\inZOI\Mods` 里取 mod。

本机运行时的配置 `config.json`、密钥 `secrets.json`、聊天数据 `data/` 和日志 `logs/` 都不进仓库。

## 许可

[CC BY-NC 4.0](LICENSE)：可以自由使用、修改和转发，需要注明出处，**不得用于商业目的**。

inZOI 是 KRAFTON 的商标。本项目是玩家自制 mod，与 KRAFTON 无关。
