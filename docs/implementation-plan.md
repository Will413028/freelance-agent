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

- [ ] 長期檢查接進 CI：schema 漂移已接（`pnpm db:check`）；trigger 測試、指紋相容測試、step 型別檢查已在 `pnpm test`／`pnpm typecheck` 內的部分待逐項核對。
- [ ] 步驟 11 設計審查記下的項目還剩：回饋簽名、排序函式的測試專用匯出、舊樣式 class、去向表。`WEB_WRITES` 開關已從程式拿掉（2026-11-15）；下一次部署後把 Vercel production 的 `WEB_WRITES` 變數刪掉。
- [ ] v1 雜湊換版本：把只為相容而照抄的解析換成標準實作，改用 v2 雜湊並一次重新基準化；`golden.json` 拆成永久保留的 v1 相容資料與可刪除的行為對照。
- [ ] 延後項目附觸發條件，搬回主清單。
- [ ] 三個從 11-06 起每天失敗的來源（2026-11-15 查）：
  - LinkedIn、Talent.com：原因是「只要有任何一封信被隔離過，來源就永遠算失敗」，已改成只看當次執行。Talent.com 的 2 封是 10-23 的舊信，部署後應該恢復。LinkedIn 從 10-27 起每天約 4 封在解析階段被拒（同一天也有解析成功的），是通知格式有一種沒支援；要看到信的內容才能修，正式的 Resend key 只在 Vercel，本機讀不到。待辦：取得一封被拒的信的結構（不含個資）後補 parser。
  - Arbeitnow：本機跑同一支掃描是成功的（20 頁、3,914 筆），Vercel 上那一步 6 秒就失敗，原因沒有被記下來。已加 `error` 欄位，部署後下一次執行看 `/sources` 的錯誤種類再決定（`http_403`／`http_429` 是出口被擋或限流，`valueerror` 是分頁中資料變動）。
- [x] 儲存檢討訊號每天有人看：`/sources` 頁顯示到最近一次執行為止 7 天的訊號（2026-11-15；Will 選這個做法，不用 GitHub Actions 排程）。
- [x] 舊 SQLite schema 的結構比對換成 drizzle 的漂移檢查 `pnpm db:check`，接進 CI；凍結檔與比對測試刪除（2026-11-15，Will 決定）。

回滾窗口結束（2026-11-15）後不再需要、還留在程式裡的相容做法，逐項處理或寫明保留理由：

- [ ] `DIGEST_RECIPIENT`：`daily_runs` 主鍵改成只有 `local_date`（或固定值），拿掉這個環境變數，`notifications` 模組併進排程（遷移計畫「延後」段）。
- [ ] `web/src/db/schema.ts` 檔頭列的沿用：時間戳存 Python 格式的 text 等，重新評估。JSON 存 text 仍是 v1 雜湊的輸入，跟 v2 雜湊一起看。
- [ ] `web/src/services/daily.ts` 為 Python 回滾保留的結果形狀；`AccessBlocked`／`PyError` 歸位到 collection 與 `DomainError` 階層；`formatG`。
- [ ] 來源目錄 `source-catalog.ts` 的 Python 欄位（`group`、`runner`、`keyed`、`fn`，程式沒有讀）刪除，`REGISTRY`、`RUNNERS`、`FAILURE_REASON` 併成一張表。
- [x] `web/src/ops/tables.ts` 刪除（唯一的使用者是上面那個比對測試）；`ops/` 只剩 `storage-triggers.ts`。周邊還在講 copy／write back 的註解待清。

舊資源退役（每一項刪除前都要 Will 授權）：

- [x] VM 上本專案的容器、映像、排程單元、程式與資料目錄（含正式 SQLite 檔與切換前備份、放 Resend key 的設定檔）、專用帳號已刪（2026-11-15）。VM 本身是共用主機，沒有動。
- [x] shadow D1 `freelance-agent-shadow` 已刪（2026-11-15）；Vercel Preview 的 `D1_DATABASE_ID` 一併拿掉，preview 部署沒有資料庫。
- [x] Neon 專案 `freelance-agent` 已刪（2026-11-15）。待確認：Cloudflare 與 Vercel 帳單。

延後、有觸發條件才做的項目：

- 每日摘要與寄信：Will 要求時才做（D22）。
- 人工投案、客戶／聯絡人、提案模板與草稿的畫面：要用時再重新設計（D23）。
- 跨來源去重：近 7 天候選裡跨來源同職稱達 3 組且人工確認為同一職缺時（D18）。
- 寫入租約改成逐筆版本控制、D1 存取改走 Worker：`check-storage-triggers` 出現對應訊號時（D20、D21）。
- 不經部署就能切換的來源開關：第一次有來源需要比部署更快關掉時。
- 離線示範模式：Will 要求時才做。

來源每站的限制與下一關卡只更新[平台接通主表](platform-connectivity.md)，不在這裡重複。
