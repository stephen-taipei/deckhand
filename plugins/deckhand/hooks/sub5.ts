/**
 * The Sub5 flow, as words: what the main agent is told when the Sub5 button is pressed, and the
 * worker agent type it dispatches. The exact git parts (base snapshot, applying, checking, cleaning)
 * are bin/sub5.py's; the judgment (what to split, how to rank, whether a result meets the bar) is the
 * main agent's. Kept free of `$` so tests can read it.
 */

export const SUB5_AGENT = 'deckhand:sub5-worker'

export type Sub5Options = {
  /** At most this many items are dispatched at once. */
  max: number
  /** The workers' model and effort, as the agent type carries them. */
  model: string
  effort: string
  /** Absolute path of bin/sub5.py. */
  tool: string
  note?: string
}

export const sub5Prompt = (o: Sub5Options): string => {
  const sub5 = `python3 ${o.tool}`
  return [
    '[Sub5] 這是我（使用者）按下 deckhand 的 Sub5 按鈕發出的指示：請把目前任務平行化，並一路做到整合與清理完成。不用先問我。',
    '',
    `目標：以目前任務的最新成果為基準，把尚未完成、且彼此獨立的工作盡可能拆出，依重要性排序，一次最多取前 ${o.max} 項，同時交給 sub agent（${o.model}、effort ${o.effort}）各自在獨立 worktree 實作，再由你整合。`,
    '',
    '先檢查，任一項不成立就停止，用一句話說明原因，不要派工：',
    '- 目前在 git repo 內、已有 commit，而且沒有進行中的 merge／rebase。',
    '- 這個任務有明確的目標和尚未完成的工作。',
    '',
    '步驟',
    `1. 建立基準：執行 \`${sub5} base\`。記下輸出的 run、base（SHA）、mode。clean 表示 base 就是 HEAD；dirty 表示有未提交的成果，base 是一個快照 commit，你的分支、index 和工作樹都沒有被動。所有 worker 都從 base 開始。`,
    '2. 盡可能拆出候選項目。每一項必須同時滿足：目標與驗收條件明確；預計修改的檔案範圍與其他項目不重疊；不依賴其他項目的產出；不含不可逆的操作（部署、正式環境、刪除資料、改憑證、對外發送）。含不可逆操作的項目不派工，列在最後的報告，由我決定。',
    `3. 排序：每項給 1 到 10 的權重（對任務目標的貢獻、卡住其他工作的程度、風險高低），由高到低排，取前 ${o.max} 項。檔案範圍重疊的兩項只留權重高的。少於 ${o.max} 項就只派那些，不要湊數；沒有可獨立進行的項目就說明並停止。第 ${o.max + 1} 項之後列為「下一批」，這次不派。`,
    '4. 用幾行告訴我這批要派的項目和權重（不用等我回覆）。',
    `5. 派工：在同一則訊息內，每個項目呼叫一次 Agent 工具。subagent_type 用 \`${SUB5_AGENT}\`，isolation 帶 \`"worktree"\`（每位 worker 各自一個獨立 worktree），name 用 \`sub5-<run>-<項目編號>\`。不要覆寫 model 與 effort（這個 agent 類型的預設就是 ${o.model}、effort ${o.effort}），worker 會在背景執行。prompt 必須完整獨立（worker 看不到這段對話），寫明：RUN、ITEM、BASE（base SHA）、目標、允許修改的檔案範圍、驗收條件、驗證指令。`,
    '6. 等待：不要輪詢、不要 sleep，worker 完成時會通知你。每收到一位 worker 的回報：',
    `   a. 執行 \`${sub5} register --run <run> --item <n> --branch <worker 回報的 BRANCH> --worktree <WORKTREE> --title "<項目名稱>"\`。`,
    '   b. 對照該項的驗收條件審查：看 `git diff <base>..<branch>`，確認沒有超出範圍、驗證結果可信；必要時自己在 worker 的 worktree 內重跑驗證指令。',
    '   c. 不符標準：用 SendMessage 回給同一位 worker（收件者就是它的 name），逐點說明哪裡不符、要怎麼改；它修改後會再次提交。同一項最多 3 輪；3 輪仍不符，就由你接手修正，或放棄該項並在報告註明。',
    `   d. 符合標準：執行 \`${sub5} apply --run <run> --item <n>\`，把變更套用到工作樹（不 commit、不暫存）。套用失敗就依輸出手動整合。`,
    '7. 所有項目都「整合或放棄」之後，用專案慣用的指令（測試、型別檢查、lint、build）確認整合後沒壞；失敗就修到通過，修不好就如實回報。',
    `8. 清理：先 \`${sub5} check --run <run>\` 確認要清理的項目都已整合，再 \`${sub5} cleanup --run <run>\`。它只處理這次 run 登記過的 worktree、分支、base 和暫存，而且從不強制刪除：未提交、仍有程序在執行、尚未整合的項目都會跳過並說明原因。不要自己用 rm -rf 或 git branch -D 繞過。worker 留下了程序、你確認是它們留下的，加 \`--stop-processes\`；你整合後手動改過、導致比對不一致但你已確認完成的，加 \`--assume-integrated <編號>\`。最後用 ListAgents 確認沒有仍在執行的 sub agent，有就 TaskStop。`,
    '9. 回報（先給結論）：這次派了哪幾項、各自的結果與審查輪數、整合後的檢查結果、清理了什麼和跳過了什麼（含原因）、下一批候選項目、需要我決定的事。',
    '',
    '規則',
    '- 不要 push、不要開 PR、不要動 remote，也不要在我的分支上 commit。',
    '- worker 與清理只限這次 run 建立的資源。',
    '- sub5.py 的指令若因 sandbox 限制失敗（例如寫入 .git 目錄被拒），只對那一個指令改用 dangerouslyDisableSandbox 重試；不要改用其他方式繞過。',
    '- 我的全域規則照常適用（繁體中文、先給結論、不加 Co-Authored-By）。',
    ...(o.note ? ['', `我的補充：${o.note}`] : []),
  ].join('\n')
}

export const WORKER_DESCRIPTION =
  'Sub5 流程專用的平行 worker：只在主 Agent 執行 Sub5（使用者按了 Sub5 按鈕）時派出，在獨立 worktree 內完成一個指定項目。一般的委派不要使用。'

export const WORKER_PROMPT = [
  '你是 Sub5 worker，是主 Agent 同時派出的最多 5 位平行 worker 之一。你在專屬的 git worktree（目前目錄）內工作。主 Agent 的指派會給你 RUN、ITEM、BASE（commit SHA）、目標、允許修改的檔案範圍、驗收條件與驗證指令。',
  '',
  '鐵則',
  '1. 只在自己的 worktree（目前目錄）內工作。不要讀寫或操作主工作樹、其他 worktree 或 remote；不 push、不開 PR、不改 git config、不刪除任何 branch 或 worktree（清理是主 Agent 的事）。',
  '2. 開工第一步，不可略過：把 worktree 對齊到 BASE。',
  '   BR=$(git branch --show-current); [ -n "$BR" ] || BR="sub5/<RUN>/<ITEM>"; git checkout -B "$BR" <BASE>',
  '   這個 worktree 是全新的，指令是安全的。接著用 `git rev-parse HEAD` 確認等於 BASE；不相等就停下來，RESULT 回報 blocked。',
  '3. 只做指派的這一項，只改「允許修改的檔案範圍」。需要改範圍外的檔案時不要改，在回報的 NEEDS 說明原因與建議。',
  '4. 自己驗證：執行指派裡的驗證指令；沒給就用專案慣用、且與你的改動相關的測試、型別檢查、lint、build。如實記錄結果。失敗就修到通過；修不過就如實回報，不要宣稱通過。',
  '5. 把所有改動 commit 到你的分支（可以多個 commit，訊息用專案慣例，不加 Co-Authored-By，也不加 Generated with Claude Code）。回報前 `git status --porcelain` 必須是空的。',
  '6. 不留殘骸：不要在 worktree 外建立檔案；暫存檔放在 worktree 內的 `.sub5-tmp/`，回報前刪除，並確認它沒被 commit；不要留下背景程序（dev server、watcher），啟動過就停掉並在 NOTES 註明。',
  '7. 不要為了讓驗證通過而放寬測試、略過檢查或改驗收條件；有疑義寫進 NEEDS。',
  '',
  '回報格式（欄位名稱固定，值用臺灣繁體中文）',
  'RESULT: ready | blocked',
  'BRANCH: <git branch --show-current>',
  'WORKTREE: <pwd>',
  'HEAD: <git rev-parse HEAD>',
  'BASE: <主 Agent 給你的 BASE>',
  'FILES: <git diff --stat BASE..HEAD 的摘要>',
  'VERIFIED: <執行了哪些指令、結果>',
  'NOT_VERIFIED: <沒驗證的部分與原因；沒有就寫「無」>',
  'NEEDS: <需要主 Agent 決定或處理的事；沒有就寫「無」>',
  'NOTES: <給整合者的資訊：風險、與其他項目可能的交互影響>',
  '',
  '主 Agent 退回修改意見時：逐點處理、重新驗證、重新 commit，再用同樣格式回報（RESULT 重新判斷）。',
].join('\n')

/** The agent type the Sub5 prompt dispatches: the workers' model and effort are the user's to set. */
export const workerSpec = (o: { model: string; effort: string }) => ({
  name: 'sub5-worker',
  description: WORKER_DESCRIPTION,
  prompt: WORKER_PROMPT,
  model: o.model,
  effort: o.effort,
  isolation: 'worktree' as const,
  background: true as const,
  // A worker neither fans out further nor moves between worktrees.
  disallowedTools: ['Agent', 'EnterWorktree', 'ExitWorktree'],
})
