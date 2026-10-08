<div align="center">

# Deckhand — Claude Code のマルチ AI ツールバー

**Many hands, one deck.**

使用量メーター、ワンクリックでのモデル切り替え、サブエージェントの並行処理、他の AI CLI からの読み取り専用セカンドオピニオンを、Claude Code の入力欄の上の 1 本のバーにまとめました。

[![Version](https://img.shields.io/badge/version-0.5.0-2563EB?style=flat-square)](plugins/deckhand/.claude-plugin/plugin.json)
[![Python](https://img.shields.io/badge/Python-%E2%89%A53.9-3C873A?style=flat-square)](#前提環境)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square)](#インストール)
[![License](https://img.shields.io/badge/license-MIT-64748B?style=flat-square)](LICENSE)
[![CI](https://github.com/stephen-taipei/deckhand/actions/workflows/ci.yml/badge.svg)](https://github.com/stephen-taipei/deckhand/actions/workflows/ci.yml)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md)

by [BetterWorkflows](https://github.com/stephen-taipei/better-workflows)

</div>

[インストール](#インストール) · [ツールバーの構成](#ツールバーの構成) · [委任ボタン](#委任ボタン) · [設定](#設定) · [その他のツール](#その他のツール) · [プライバシーとセキュリティ](#プライバシーとセキュリティ) · [変更履歴](CHANGELOG.md)

## Deckhand の概要

Deckhand は Claude Code のプラグインです。ターミナルおよびデスクトップアプリの入力欄の上にツールバーを追加します。Claude をメインエージェントのまま維持しつつ、ツールバーから以下の操作を行えます。

- 各使用量ウィンドウの残り枠を確認する
- 1 クリックでモデルを切り替える
- タスクを分割し、それぞれ別の git worktree でサブエージェントに並行実行させる
- 他の AI CLI に読み取り専用でセカンドオピニオンを求め、Claude にその結果をレビューさせる
- セッションの現状を、平易な言葉で手短に振り返る

## インストール

Claude Code で次の 2 つのコマンドを実行します。

```text
/plugin marketplace add stephen-taipei/deckhand
/plugin install deckhand@deckhand
```

入力欄の上にツールバーが表示されます。表示されない場合は、新しいセッションを開始してください。

## ツールバーの構成

| 項目 | 機能 |
| --- | --- |
| 使用量メーター | 5 時間枠、モデル別の週間枠、全モデル合計の週間枠、コンテキストウィンドウ |
| `O` `F` `S` `H` | モデルを Opus、Fable、Sonnet、Haiku に切り替え |
| `Sub5` | 現在のタスクを最大 5 件に分割し、サブエージェントで並行実行 |
| `CL` `CS` `CA` `CR` `GF` | タスクを他の AI CLI に読み取り専用で委任し、回答を Claude にレビューさせる |
| `Recap` | サイドペインで、現在のコンテキストをたとえ話を交えて平易に解説 |
| `⚙` | 設定ペインを開く（ツールバー右端） |

各ボタンにホバーすると説明が表示されます。

### 使用量メーター

- `5h`: 5 時間枠の使用量。
- お使いのアカウントに適用されているモデル別の週間枠（例: Fable の場合は `fb`）。
- `7d`: 全モデル合計の週間枠。
- `ctx`: コンテキストウィンドウの使用率。

数値は Claude アプリの使用量カードと一致します（端数切り捨て）。各枠が警告しきい値を超えると、Deckhand がトースト通知を 1 回表示します。

### モデルボタン

`O` Opus · `F` Fable · `S` Sonnet · `H` Haiku

- **ターミナル:** ボタンを押すとセッションのモデルが直接切り替わり、設定中の effort も保持されます。
- **デスクトップアプリ:** モデルの管理はアプリ側で行われます。ボタンを押すと入力欄に `/model <name>` が入力されるので、Enter を押して反映させます。これにより、アプリ本体のモデルメニューとも同期が保たれます。

### Sub5

Sub5 は、現在のタスクを最大 5 件の独立した作業に分割します。各タスクは個別の git worktree 内で、それぞれ専用のサブエージェントによって同時に実行されます。ワーカーの処理が完了すると、メインエージェントが成果物をレビューして統合し、worktree とブランチをクリーンアップします。

正確な git の手順はスクリプト（`bin/sub5.py`）が実行します。強制処理（force）やリモートへの push は一切行いません。ワーカーのモデル、effort、最大タスク数は設定から変更できます。

### 委任ボタン

委任ボタンを押すと、単一のタスクを他の AI CLI に渡します。委任先の AI は読み取り専用で動作して回答を生成し、Claude がその内容をレビューして妥当な部分を取り込みます。

| ボタン | CLI | モデル | Effort |
| --- | --- | --- | --- |
| `CL` | Codex | GPT-6 Luna | max |
| `CS` | Codex | GPT-6.1 Sol | medium |
| `CA` | Codex | GPT-6 Astra | medium |
| `CR` | Cursor agent | Grok 4.7 | high |
| `GF` | agy | Gemini 3.8 Flash | high |

上記はデフォルト設定です。委任先の設定（ラベル、CLI、モデル ID、effort、表示名、有効/無効）はすべて設定画面で編集できます。

- **CLI ごとの読み取り専用制御:** Codex は `-s read-only`、Cursor agent は `--mode ask` で動作します。agy はヘッドレスモードで起動し、ツールの使用を自動的に拒否します。
- **機密情報のチェック:** トークン、キー、パスワードのいずれかを含む依頼内容は送信を拒否します。
- **ローカル履歴:** 依頼内容と回答はプライベートな一時フォルダーに保存され、3 日後に自動削除されます。
- **前提条件:** 対象の CLI がインストールされ、ログイン済みである必要があります。インストールされていない CLI のボタンは非表示になります。

> [!NOTE]
> 委任を行うと、その CLI を提供するサービスプロバイダーに依頼内容が送信されます。

### Recap

Recap は、現在のコンテキスト全体をできる限り簡潔・平易に、たとえ話を交えながらサイドペインで解説します。会話履歴には何も追加されません。ボタンの表記は表示言語に連動します（英語では `Recap`、繁体字中国語では `通靈`）。

### 設定

ツールバー右端の `⚙` ボタンから設定ペインを開けます。以下の項目を編集できます。`/deckhand` でも開けます。

- 表示言語
- 各ボタンの表示/非表示
- 委任先のターゲット設定
- Sub5 のモデル、effort、最大タスク数
- CLI のパスと Codex のホームフォルダー
- 帰属表示ガード
- ポーリングガードと、その停止回数
- 使用量の警告しきい値
- 翻訳モデル

設定はユーザーごとに保存されます。

### 言語

English、繁體中文、简体中文、日本語、한국어に対応しています。デフォルトの表示言語は Claude Code の `language` 設定に従います。設定ペインから手動で選択することも可能です。

## その他のツール

| ツール | 機能 |
| --- | --- |
| `/watch-deploy` および `watch_deploy` ツール | PR、CI の実行、URL をバックグラウンドで監視します。同じ結果が N 回連続すると自動停止します。 |
| `/handoff`、`/handoff-in`、`/codex` | Claude と Codex の間で作業を引き継ぎます。Codex 向けの引き継ぎメモを作成したり、Codex の最新メモを入力欄に読み込んだり、Codex のインボックスを開いたりできます。 |
| 帰属表示ガード | コミットや PR 作成コマンドから `Co-Authored-By` 行や Claude Code のフッターを削除します。デフォルトはオフです。ただし、Claude の設定で帰属表示をすでにオフにしている場合はオンになります。 |
| ポーリングガード | `sleep` によるポーリングループや `gh run watch` などのブロッキング待機を停止し、同じ結果を N 回連続で返すステータスチェックを中断させます。 |
| `agy_translate` | agy を介したローカライズ翻訳。直訳ではなく、現地の開発者が実際に使う自然な言い回しに翻訳します。 |

## 前提環境

- プラグインのフックモジュールに対応した Claude Code（2.1.288 で検証済み）。
- Python 3.9 以上。
- 任意: 監視機能を使用する場合は `gh`、委任ボタンを使用する場合は `codex`、Cursor `agent`、`agy` の各 CLI。

## プライバシーとセキュリティ

お使いのマシンの外へ送信されるデータ:

- **委任の依頼内容**: 委任ボタンを押したときにのみ、選択した CLI のプロバイダーへ送信されます。
- **使用量の読み取り**: Claude Code を経由し、セッション自体の認証情報を使用して Anthropic の使用量エンドポイントを呼び出します。
- **ユーザーや Claude が明示的に呼び出したツール**: 対象のサービスと通信します（`agy_translate` は agy 経由でテキストを送信し、監視機能は `gh` 経由で GitHub に問い合わせるか指定された URL を取得します）。

上記以外のデータがマシンの外へ送信されることはありません。

安全性に関するルール:

- 委任処理は、各 CLI 固有のフラグやモードによって読み取り専用が強制されます。
- 機密情報チェックにより、トークン、キー、パスワードを含む依頼内容は拒否されます。
- 依頼内容と回答はプライベートな一時フォルダーに保存され、3 日後に削除されます。
- Sub5 の git スクリプトは、強制処理（force）やリモートへの push を一切行いません。

## 開発

```bash
(cd plugins/deckhand && python3 -m unittest discover -s tests -p 'test_*.py')
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/scan-secrets.py
```

`scripts/scan-secrets.py` は、Git で追跡されている全ファイルをスキャンし、キー、トークン、URL 内の認証情報、メールアドレス、ホームフォルダーのパスが含まれていないかを検証します。詳細は [CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。

## コントリビューション、セキュリティ、ライセンス

[コントリビューション](CONTRIBUTING.md) · [セキュリティポリシー](SECURITY.md) · [変更履歴](CHANGELOG.md) · [ライセンス](LICENSE)

[BetterWorkflows](https://github.com/stephen-taipei/better-workflows) が開発し、[stephen-taipei](https://github.com/stephen-taipei) がメンテナンスしています。Deckhand は独立したプラグインであり、Anthropic の製品ではありません。[MIT ライセンス](LICENSE)で公開しています。
