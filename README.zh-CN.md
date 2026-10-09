<div align="center">

# Deckhand — Claude Code 的多 AI 工具栏

**Many hands, one deck.**

在 Claude Code 输入框上方的工具栏中，集成用量指示器、一键切换模型、并行子代理，以及来自其他 AI CLI 的只读参考建议。

[![Version](https://img.shields.io/badge/version-1.0.0-2563EB?style=flat-square)](plugins/deckhand/.claude-plugin/plugin.json)
[![Python](https://img.shields.io/badge/Python-%E2%89%A53.9-3C873A?style=flat-square)](#环境要求)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square)](#安装)
[![License](https://img.shields.io/badge/license-MIT-64748B?style=flat-square)](LICENSE)
[![CI](https://github.com/stephen-taipei/deckhand/actions/workflows/ci.yml/badge.svg)](https://github.com/stephen-taipei/deckhand/actions/workflows/ci.yml)

[English](README.md) · [繁體中文](README.zh-TW.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

[安装](#安装) · [工具栏](#工具栏) · [委派按钮](#委派按钮) · [设置](#设置) · [更多工具](#更多工具) · [隐私与安全](#隐私与安全) · [赞助](#赞助) · [更新日志](CHANGELOG.md)

![Claude Code 输入框上方的 Deckhand 控制栏：两个已完成的 CI 监控及通知、用量、模型按钮、Sub5、委派按钮、Recap 与设置](docs/images/band.png)

<sub>截图为繁体中文界面。</sub>

[通过 USDT（TRC20）赞助 Deckhand](#赞助)：仅接受一次性赞助。

## 功能简介

Deckhand 是一个 Claude Code 插件。无论在终端还是桌面端应用中，它都会在输入框上方添加一条工具栏。Claude 依然作为主代理运行。通过工具栏，你可以：

- 查看各用量窗口的剩余额度；
- 一键切换模型；
- 在独立的 git worktree 中由并行子代理分工处理任务；
- 向其他 AI CLI 请求只读的参考建议，并交由 Claude 审查；
- 用通俗直白的话快速了解当前会话进展。

## 安装

在 Claude Code 中运行以下两条命令：

```text
/plugin marketplace add stephen-taipei/deckhand
/plugin install deckhand@deckhand
```

工具栏会显示在输入框上方。如果未显示，请开启新会话。

## 工具栏

| 部件 | 功能说明 |
| --- | --- |
| 用量指示器 | 5 小时窗口、各模型的每周窗口、所有模型合计的每周窗口，以及上下文窗口 |
| `O` `F` `S` `H` | 将模型切换至 Opus、Fable、Sonnet 或 Haiku |
| `Sub5` | 将当前任务拆分为最多 5 个子项，由并行子代理分工执行 |
| `cL` `cS` `cA` `cR` `gF` | 将单项任务以只读模式交由其他 AI CLI 处理，并由 Claude 审查结果 |
| `Recap` | 在侧边面板中用通俗比喻解释当前上下文 |
| `⚙` | 打开设置面板（位于工具栏最右侧） |

将鼠标悬停在按钮上即可查看其功能说明。

### 用量指示器

- `5h`：5 小时窗口。
- 你的账户拥有的各模型每周窗口，例如 Fable 显示为 `fb`。
- `7d`：所有模型合计的每周窗口。
- `ctx`：上下文窗口占用率。

数值与 Claude 应用中的用量卡片一致（向下取整）。当某个窗口用量超过预警阈值时，Deckhand 会弹出一次通知。

### 模型按钮

`O` Opus · `F` Fable · `S` Sonnet · `H` Haiku

- **终端：** 点击按钮直接切换当前会话的模型，并保留你的 effort 等级。
- **桌面端应用：** 桌面端由应用管理会话模型，插件无法一键切换：Claude Code 不接受插件发送以 `/` 开头的提示，应用也不允许会话切换自己的模型。因此点击按钮会将 `/model <name>` 填入输入框（输入框里有文字时，请先发送或清空）。在输入框按下回车后，模型随即切换，应用自带的模型菜单同步更新，Deckhand 也会把 effort 恢复到原来的等级。如果输入框无法填入（例如打开了对话框），命令会改为复制到剪贴板：粘贴到输入框后按回车即可。

### Sub5

Sub5 将当前任务拆分为最多 5 个独立子项。每个子项同时在各自的 git worktree 中由专属子代理运行。工作子代理完成后，主代理会审查其工作成果并进行整合，随后清理相关 worktree 和分支。

具体 git 操作由脚本（`bin/sub5.py`）执行。该脚本绝不执行强制操作，也绝不推送代码。你可以在设置中配置工作子代理的模型、effort 以及最大子项数量。

### 委派按钮

委派按钮可将单项任务交由另一个 AI CLI 处理。该 AI 以只读方式运行并输出结果，随后由 Claude 审查其回答并整合合理的内容。

| 按钮 | CLI | 模型 | Effort |
| --- | --- | --- | --- |
| `cL` | Codex | GPT-6 Luna | max |
| `cS` | Codex | GPT-6.1 Sol | medium |
| `cA` | Codex | GPT-6 Astra | medium |
| `cR` | Cursor agent | Grok 4.7 | high |
| `gF` | agy | Gemini 3.8 Flash | high |

以上均为默认配置。你可以在设置中自定义所有委派目标：按钮标签、CLI、模型 ID、effort、名称以及开关状态。

- **各 CLI 的只读机制：** Codex 携带 `-s read-only` 运行，Cursor agent 携带 `--mode ask` 运行，agy 以 headless 模式运行，会自动拒绝工具调用。
- **联网搜索（仅 `search`）：** Codex 附加 `-c web_search="live"`，Cursor agent 附加 `--auto-review`（仍为 ask 模式），使搜索无需询问即可执行。agy 的 headless 模式本身就能搜索。
- **敏感信息检查：** 若任务说明中包含令牌、密钥或密码，Deckhand 会拒绝发送。
- **本地记录：** 任务说明和回答均保存在私有的临时文件夹中，3 天后自动清理。
- **工具栏上的进度：** 委派运行期间，用量行上方会多出一行，显示标签、CLI、模型和已运行时间。结束后，这一行会显示结果 10 分钟，或直到点击**清除已结束**。没有停止按钮：Deckhand 只观察运行委派的 Bash 调用。
- **委派记录：** 输入 `/delegates`，或点击已结束那一行的**记录**，会列出近 3 天的委派。每个回答都可以完整打开、复制，或在输入框为空时填入输入框。
- **环境要求：** 必须已安装相应 CLI 并完成登录。未安装的 CLI 对应的按钮会自动隐藏。

> [!NOTE]
> 委派任务时，任务说明将发送至该 CLI 背后的服务商。

### Recap

Recap 会在侧边面板中用生动易懂的比喻，尽可能简明扼要地解释当前完整的上下文。它不会向会话中添加任何内容。按钮在所有语言中都显示为 `Recap`。

### 设置

点击工具栏最右侧的 `⚙`，或运行 `/deckhand`，即可打开设置面板。面板分为 5 个标签页：

| 标签页 | 可设置的内容 |
| --- | --- |
| 常规 | 显示语言、显示哪些按钮、用量预警阈值 |
| 委派 | 每个委派目标的开关、标签、CLI、模型 ID、effort、名称 |
| 翻译与搜索 | 是否把翻译和联网搜索交给委派目标，以及交给哪一个（`cL`～`gF`）。两者默认关闭。 |
| Sub5 | worker 的模型、effort 和最多项目数 |
| 高级 | CLI 路径与 Codex 目录、防护、部署监控、恢复默认 |

![Deckhand 设置：“常规”与“翻译与搜索”标签页](docs/images/settings.png)

设置按用户分别存储。

### 语言

支持 English、繁體中文、简体中文、日本語和 한국어。默认情况下，显示语言遵循 Claude Code 的 `language` 设置，你也可以在设置中手动选择语言。

## 更多工具

| 工具 | 功能说明 |
| --- | --- |
| `/watch-deploy` 与 `watch_deploy` 工具 | 在后台监视 PR、CI 运行或 URL。若连续 N 次返回相同结果，监视将自动停止。 |
| `/handoff`、`/handoff-in`、`/codex` | 在 Claude 与 Codex 之间交接工作：为 Codex 编写交接说明、将 Codex 最新的交接内容取回输入框，以及打开 Codex 收件箱。 |
| 署名防护 | 从 commit 和 PR 命令中去除 `Co-Authored-By` 署名及 Claude Code 页脚。默认关闭，除非你的 Claude 设置中已停用署名。 |
| 轮询防护 | 拦截 `sleep` 轮询循环和类似 `gh run watch` 的阻塞式等待，并在状态检查连续 N 次返回相同结果时自动终止。 |
| `translate` | 交由你在设置中选择的委派目标进行本地化翻译，采用目标语言母语开发者的表达习惯，而非逐字直译。默认关闭，可在 `⚙` 中开启。 |
| `search` | 交由你在设置中选择的委派目标联网搜索并整理：简短结论、要点及各自的来源，再由 Claude 核实。默认关闭，可在 `⚙` 中开启。 |

## 环境要求

- macOS 或 Linux。不支持 Windows；WSL 尚未测试。
- 支持插件 Hook 模块的 Claude Code（已在 2.1.288 版本上测试）。
- Python 3.9 或更高版本。
- 可选：用于监视功能的 `gh`；用于委派按钮的 `codex`、Cursor `agent` 及 `agy` CLI。

## 隐私与安全

离开你本地设备的数据：

- **委派任务说明：** 仅在你点击委派按钮时发送给对应 CLI 的服务商。
- **用量读取：** 通过 Claude Code，使用当前会话自身的凭据调用 Anthropic 的用量接口。
- **你或 Claude 主动调用的工具：** 仅连接其对应的服务：`translate` 和 `search` 在你开启后，将要翻译或搜索的内容发送给你选择的委派目标，监视功能通过 `gh` 查询 GitHub 或请求你指定的 URL。

除此之外，没有任何数据会离开你的本地设备。

安全机制：

- 委派操作均为只读，由各 CLI 自身的参数或运行模式强制保证。
- 敏感信息检查会拦截包含令牌、密钥或密码的任务说明。
- 任务说明与回答均存放在私有临时文件夹中，3 天后自动清理。
- Sub5 的 git 脚本绝不执行强制操作，也绝不推送代码。

## 开发

```bash
(cd plugins/deckhand && python3 -m unittest discover -s tests -p 'test_*.py')
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/scan-secrets.py
```

`scripts/scan-secrets.py` 会检查所有被 Git 跟踪的文件中的密钥、令牌、URL 凭据、邮箱地址及用户主目录路径。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 赞助

一次性的 USDT 赞助用于维护 Deckhand 的代码、文档以及 5 种语言的本地化。赞助不提供会员资格，也不提供功能排期或技术支持上的优先权。

**USDT · TRON（TRC20）** · `TGuMUi1d8MoBQcuFrGJZnu4JrbaeP3wy9a`

<img src="docs/images/sponsor-usdt-trc20.png" alt="USDT (TRC20) QR: TGuMUi1d8MoBQcuFrGJZnu4JrbaeP3wy9a" width="160">

仅支持通过 TRON（TRC20）网络转账 USDT。通过其他网络转出的代币将无法找回。

## 贡献、安全与许可证

[贡献指南](CONTRIBUTING.md) · [安全政策](SECURITY.md) · [更新日志](CHANGELOG.md) · [许可证](LICENSE)

由 [stephen-taipei](https://github.com/stephen-taipei) 开发与维护。Deckhand 是一款独立插件，非 Anthropic 官方产品。采用 [MIT 许可证](LICENSE) 发布。
