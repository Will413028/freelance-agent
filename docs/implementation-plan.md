# 現況與待辦

本頁只寫現在的狀態與還沒做的事。過程、驗收證據與每個決定的理由在[遷移計畫](plans/2026-10-23-nextjs-vercel-migration.md)；更早的系統只留在 git 歷史。

## 現況（2026-11-15）

- 正式系統是 `web/`：Next.js 在 Vercel（`iad1`），資料在 Cloudflare D1 `freelance-agent-prod`，每日收案由 Vercel Cron 觸發 Vercel Workflow。
- 2026-11-06 從舊的 Python 系統切換過來；2026-11-15 驗收通過（11-06 到 11-13 的自然排程、網頁回饋寫入、本人在網頁上確認）。證據在遷移計畫步驟 13。
- 舊系統的程式已從 repo 刪除。沒有回滾路徑。
- 網頁有清單、詳情與收藏／略過、來源狀態、篩選設定。功能範圍見[功能說明](features.md)。
- 沒有任何系統寄信；每日摘要已停用（遷移計畫決定 D22）。
- 11-06 到 11-13 每天的每日執行狀態都是 `failed`：每天有 3–4 個來源失敗，其他來源照常收案（遷移計畫步驟 13 驗收）。逐來源狀態見[平台接通主表](platform-connectivity.md)。

## 未完成工作

遷移計畫步驟 14（收尾）還開著的項目，以該步驟的清單為準：

- [ ] 長期檢查接進 CI：schema 漂移、trigger 測試、指紋相容測試、step 型別檢查。
- [ ] 步驟 11 設計審查記下的五項（回饋簽名、排序函式的測試專用匯出、舊樣式 class、`WEB_WRITES` 開關退場、去向表）。
- [ ] v1 雜湊換版本：把只為相容而照抄的解析換成標準實作，改用 v2 雜湊並一次重新基準化；`golden.json` 拆成永久保留的 v1 相容資料與可刪除的行為對照。
- [ ] 延後項目附觸發條件，搬回主清單。
- [ ] 查三個從 11-06 起每天失敗的來源（LinkedIn、Talent.com、Arbeitnow；台灣就業通時好時壞）：逐一查因，修好或在來源目錄給 `disabled` 原因。先於 golden 拆分做時，照 `AGENTS.md` 的 golden 規則處理該來源的行為案例。
- [ ] `check-storage-triggers` 每天由誰跑：舊系統的 VM 排程 11-06 停用後沒有接手者（2026-11-15 人工補跑 11-06 起 9 次執行、0 個訊號）。做法待 Will 決定：每日執行收尾時算出訊號寫進結果並顯示在 `/sources`，或 GitHub Actions 排程。
- [ ] `web/tests/fixtures/001_sqlite.sql` 的結構比對（`schema.test.ts`）：原本的理由是回滾時 Python 要讀得懂，已不成立。待 Will 決定：留著當「歷史表不被 migration 誤改」的防護並改寫說明，或換成 drizzle 的漂移檢查。這題和上面「schema 漂移接進 CI」一起回答。

回滾窗口結束（2026-11-15）後不再需要、還留在程式裡的相容做法，逐項處理或寫明保留理由：

- [ ] `DIGEST_RECIPIENT`：`daily_runs` 主鍵改成只有 `local_date`（或固定值），拿掉這個環境變數，`notifications` 模組併進排程（遷移計畫「延後」段）。
- [ ] `web/src/db/schema.ts` 檔頭列的沿用：時間戳存 Python 格式的 text 等，重新評估。JSON 存 text 仍是 v1 雜湊的輸入，跟 v2 雜湊一起看。
- [ ] `web/src/services/daily.ts` 為 Python 回滾保留的結果形狀；`AccessBlocked`／`PyError` 歸位到 collection 與 `DomainError` 階層；`formatG`。
- [ ] 來源目錄 `source-catalog.ts` 的 Python 欄位（`group`、`runner`、`keyed`、`fn`，程式沒有讀）刪除，`REGISTRY`、`RUNNERS`、`FAILURE_REASON` 併成一張表。
- [ ] `web/src/ops/tables.ts` 只剩兩個常數：搬到 `db/` 或投影模組，`ops/` 只留 `storage-triggers.ts`；順手改掉周邊還在講 copy／write back 的註解。

舊資源退役（每一項刪除前都要 Will 授權）：

- [ ] VM 上本專案的容器、映像、SQLite 檔與切換前備份；撤銷 VM 上的 Resend key。
- [ ] shadow D1 `freelance-agent-shadow`。刪之前先決定 Vercel Preview 的 `D1_DATABASE_ID` 改指向哪裡（現在指向它）。
- [ ] Neon 專案 `freelance-agent`；確認 Cloudflare 與 Vercel 帳單。

延後、有觸發條件才做的項目：

- 每日摘要與寄信：Will 要求時才做（D22）。
- 人工投案、客戶／聯絡人、提案模板與草稿的畫面：要用時再重新設計（D23）。
- 跨來源去重：近 7 天候選裡跨來源同職稱達 3 組且人工確認為同一職缺時（D18）。
- 寫入租約改成逐筆版本控制、D1 存取改走 Worker：`check-storage-triggers` 出現對應訊號時（D20、D21）。
- 不經部署就能切換的來源開關：第一次有來源需要比部署更快關掉時。
- 離線示範模式：Will 要求時才做。

來源每站的限制與下一關卡只更新[平台接通主表](platform-connectivity.md)，不在這裡重複。
