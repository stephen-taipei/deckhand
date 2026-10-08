<div align="center">

# Deckhand — Claude Code 的 AI 神隊友工具列

**Many hands, one deck.**

在 Claude Code 輸入框上方加一條工具列：看用量、一鍵換模型、平行派出子代理，再請其他 AI CLI 以唯讀方式提供第二意見。

[![Version](https://img.shields.io/badge/version-1.0.0-2563EB?style=flat-square)](plugins/deckhand/.claude-plugin/plugin.json)
[![Python](https://img.shields.io/badge/Python-%E2%89%A53.9-3C873A?style=flat-square)](#系統需求)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square)](#安裝)
[![License](https://img.shields.io/badge/license-MIT-64748B?style=flat-square)](LICENSE)
[![CI](https://github.com/stephen-taipei/deckhand/actions/workflows/ci.yml/badge.svg)](https://github.com/stephen-taipei/deckhand/actions/workflows/ci.yml)

[English](README.md) · **繁體中文** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

by [BetterWorkflows](https://github.com/stephen-taipei/better-workflows)

</div>

[安裝](#安裝) · [工具列](#工具列) · [外派按鈕](#外派按鈕) · [設定](#設定) · [其他工具](#其他工具) · [隱私與安全](#隱私與安全) · [變更紀錄](CHANGELOG.md)

![Claude Code 輸入框上方的 Deckhand 控制列：已完成的 CI 監看、用量、模型按鈕、Sub5、外派按鈕、Recap 與設定](docs/images/band.png)

## Deckhand 能做什麼

Deckhand 是 Claude Code 的外掛。它在輸入框上方加一條工具列，終端機與桌面版 App 都支援。Claude 仍是主代理。你可以在工具列上：

- 查看每個用量區間還剩多少；
- 一鍵切換模型；
- 把一項任務拆給多個子代理，在各自的 git worktree 中平行處理；
- 請另一個 AI CLI 以唯讀方式提供第二意見，再由 Claude 審查；
- 用白話快速了解這個工作階段目前的狀況。

## 安裝

在 Claude Code 中執行這兩行指令：

```text
/plugin marketplace add stephen-taipei/deckhand
/plugin install deckhand@deckhand
```

安裝後，工具列會出現在輸入框上方。如果沒有出現，請開一個新的工作階段。

## 工具列

| 區塊 | 功能 |
| --- | --- |
| 用量指標 | 5 小時區間、各模型的每週區間、所有模型合計的每週區間，以及上下文視窗 |
| `O` `F` `S` `H` | 把模型切換成 Opus、Fable、Sonnet 或 Haiku |
| `Sub5` | 把目前的任務拆成最多 5 項，交給子代理平行處理 |
| `cL` `cS` `cA` `cR` `gF` | 把一項任務以唯讀方式交給另一個 AI CLI，再由 Claude 審查答案 |
| `Recap` | 在側邊窗格用比喻、白話說明目前的上下文 |
| `⚙` | 開啟設定窗格（位於工具列最右端） |

滑鼠移到按鈕上，會顯示它的功能說明。

### 用量指標

- `5h`：5 小時區間。
- 你的帳號擁有的各模型每週區間，例如 Fable 顯示為 `fb`。
- `7d`：所有模型合計的每週區間。
- `ctx`：上下文視窗的使用比例。

數字與 Claude App 用量卡片上的數字一致（無條件捨去）。某個區間超過警示門檻時，Deckhand 會跳出一次提示通知。

### 模型按鈕

`O` Opus · `F` Fable · `S` Sonnet · `H` Haiku

- **終端機：** 按鈕會直接切換這個工作階段的模型，並保留你目前的 effort 等級。
- **桌面版 App：** 工作階段的模型由 App 管理。按鈕會把 `/model <name>` 填入輸入框，你按 Enter 後，App 自己的模型選單也會同步更新。

### Sub5

Sub5 會把目前的任務拆成最多 5 個互相獨立的項目。每個項目由一個子代理在自己的 git worktree 中同時處理。所有子代理完成後，主代理會審查成果、整合進來，並清理 worktree 與分支。

精確的 git 步驟由腳本（`bin/sub5.py`）執行。它不會使用 force，也不會 push。子代理的模型、effort 與最多項目數可以在設定中調整。

### 外派按鈕

外派按鈕會把一項任務交給另一個 AI CLI。對方以唯讀方式工作並寫出答案，再由 Claude 審查答案，只整合站得住腳的部分。

| 按鈕 | CLI | 模型 | Effort |
| --- | --- | --- | --- |
| `cL` | Codex | GPT-6 Luna | max |
| `cS` | Codex | GPT-6.1 Sol | medium |
| `cA` | Codex | GPT-6 Astra | medium |
| `cR` | Cursor agent | Grok 4.7 | high |
| `gF` | agy | Gemini 3.8 Flash | high |

以上是預設值。每個外派目標都可以在設定中修改：標籤、CLI、模型 ID、effort、名稱，以及是否啟用。

- **依 CLI 強制唯讀：** Codex 使用 `-s read-only`，Cursor agent 使用 `--mode ask`，agy 以 headless 模式執行，會自動拒絕工具呼叫。
- **網路搜尋（只有 `search`）：** Codex 加上 `-c web_search="live"`，Cursor agent 加上 `--auto-review`（仍是 ask 模式），讓搜尋不必詢問就能執行。agy 的 headless 模式本來就能搜尋。
- **機密檢查：** 任務說明含有 token、金鑰或密碼時，Deckhand 會拒絕送出。
- **本機紀錄：** 任務說明與答案存放在私有的暫存資料夾，3 天後自動刪除。
- **使用條件：** 對應的 CLI 必須已安裝並登入。未安裝的 CLI，其按鈕會隱藏。

> [!NOTE]
> 外派會把任務說明送到該 CLI 背後的服務供應商。

### Recap

Recap 會在側邊窗格用比喻，盡量白話、簡短地說明目前的完整上下文。它不會在對話中加入任何內容。按鈕在所有語言都顯示 `Recap`。

### 設定

點工具列最右端的 `⚙`，或執行 `/deckhand`，會開啟設定窗格。窗格分成 5 個分頁：

| 分頁 | 可以設定 |
| --- | --- |
| 一般 | 顯示語言、要顯示哪些按鈕、用量警示門檻 |
| 外派 | 每個外派目標的開關、標籤、CLI、模型 ID、effort、名稱 |
| 翻譯與搜尋 | 翻譯與網路搜尋是否交給外派目標，以及交給哪一個（`cL`～`gF`）。兩者預設關閉。 |
| Sub5 | worker 的模型、effort 與最多項目數 |
| 進階 | CLI 路徑與 Codex 資料夾、防護、部署監看、恢復預設 |

![Deckhand 設定：「一般」與「翻譯與搜尋」分頁](docs/images/settings.png)

設定依使用者分別儲存。

### 語言

支援 English、繁體中文、简体中文、日本語與 한국어。顯示語言預設跟隨 Claude Code 的 `language` 設定，也可以在設定中另外選擇。

## 其他工具

| 工具 | 功能 |
| --- | --- |
| `/watch-deploy` 與 `watch_deploy` 工具 | 在背景監看 PR、CI 執行或網址。連續 N 次結果相同時，監看會自動停止。 |
| `/handoff`、`/handoff-in`、`/codex` | 在 Claude 與 Codex 之間交接工作：寫一份交給 Codex 的交接文件、把 Codex 最新的交接文件帶回輸入框，以及開啟 Codex 收件匣。 |
| 署名防護 | 從 commit 與 PR 指令中移除 `Co-Authored-By` trailer 與 Claude Code 頁尾。預設關閉；如果你的 Claude 設定已關閉署名，則預設開啟。 |
| 輪詢防護 | 擋下 `sleep` 輪詢迴圈與 `gh run watch` 這類阻塞式等待，並在同一個狀態查詢連續 N 次得到相同結果時停止它。 |
| `translate` | 交給你在設定中選的外派目標做在地化翻譯，用母語使用者實際的說法，而不是逐字直譯。預設關閉，可在 `⚙` 開啟。 |
| `search` | 交給你在設定中選的外派目標上網搜尋並整理：簡短結論、重點與各自的來源，再由 Claude 查證。預設關閉，可在 `⚙` 開啟。 |

## 系統需求

- 支援外掛 hook 模組的 Claude Code（已在 2.1.288 測試）。
- Python 3.9 以上。
- 選用：監看功能需要 `gh`；外派按鈕需要 `codex`、Cursor `agent` 與 `agy` CLI。

## 隱私與安全

會離開你電腦的資料：

- **外派的任務說明**：只在你按下外派按鈕時，送到你選擇的 CLI 的服務供應商。
- **用量讀數**：透過 Claude Code，以這個工作階段自己的憑證呼叫 Anthropic 的用量端點。
- **你或 Claude 主動呼叫的工具**：只連到該工具指定的服務。`translate` 與 `search` 在你開啟後，把要翻譯或搜尋的內容送給你選的外派目標；監看功能透過 `gh` 查詢 GitHub，或讀取你提供的網址。

除此之外，沒有其他資料會離開你的電腦。

安全規則：

- 外派一律唯讀，由各 CLI 自己的旗標或模式強制執行。
- 機密檢查會拒絕含有 token、金鑰或密碼的任務說明。
- 任務說明與答案存放在私有的暫存資料夾，3 天後清除。
- Sub5 的 git 腳本不會使用 force，也不會 push。

## 開發

```bash
(cd plugins/deckhand && python3 -m unittest discover -s tests -p 'test_*.py')
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/scan-secrets.py
```

`scripts/scan-secrets.py` 會檢查所有納入版本控制的檔案，找出金鑰、token、網址中的帳密、電子郵件地址與家目錄路徑。詳見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 參與貢獻、安全與授權

[參與貢獻](CONTRIBUTING.md) · [安全政策](SECURITY.md) · [變更紀錄](CHANGELOG.md) · [授權條款](LICENSE)

由 [BetterWorkflows](https://github.com/stephen-taipei/better-workflows) 製作，[stephen-taipei](https://github.com/stephen-taipei) 維護。Deckhand 是獨立開發的外掛，不是 Anthropic 的產品。以 [MIT 授權條款](LICENSE)釋出。
