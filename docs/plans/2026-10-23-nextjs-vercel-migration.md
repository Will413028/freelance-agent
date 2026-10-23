# 搬離 VM：改寫成 Next.js 全端並部署到 Vercel

**Goal：** 正式環境不再依賴 `oci-a1`。收案、篩選與分組、每日摘要寄送、收藏／略過、投案、客戶與草稿工作台，全部由同一個 Next.js（TypeScript）app 提供，部署在 Vercel，資料放代管的 Postgres。Python backend、Huey、Compose、舊 `frontend/` 與 `contracts/` 都已刪除。驗收見步驟 14。

**上層：** 主清單見本機個人脈絡檔（`AGENTS.local.md`）。本計畫暫代主計畫，所以保留下面的「全域約束與完成定義」。

**附件：** `docs/plans/2026-10-23-nextjs-vercel-migration/`，快照 commit `d994cd2`。
- `inventory-surface.md`：25 張表、42 個 API operation、47 個前端呼叫點、19 個 CLI、狀態機、測試、legacy。
- `inventory-sources.md`：29 個來源 connector、共用收集機制、通知、submissions、外部相依、300 秒適配。
- 兩份盤點的「去向」欄在步驟 2 填寫。
- 之後新增的附件：`spikes.md`（步驟 1）、`allowed-residue.md`（步驟 2）、`check_inventory.py`（步驟 2）。

## 全域約束與完成定義（暫代主計畫）

- `AGENTS.md` 的產品規則全部沿用，只換語言與主機：
  - 職缺與信件內容是不可信資料。
  - 未知的預算、地區、工時、截止日保留為未知，不把 remote 推定成 worldwide。
  - 不確定的寄送不自動重試。
  - 歷史 proposal、application、outbox、receipt 資料必須保留。
  - 離線 demo 不讀憑證、不連外、不寄信。
  - 不新增自動提案或自動應徵。
  - email 內文與 token 不寫 log。
- **切換前 Python／VM 是唯一對外寄信、寫正式資料的系統。** TS 版在 shadow 期（影子期）只寫 shadow DB。Vercel production env 裡沒有任何寄送憑證，這是結構性防護，不是只靠程式碼守住；驗收方式是 `vercel env ls production` 的 key 名稱清單。
- **Workflow step 的輸入輸出只放 ID、計數與狀態。** 信件正文、職缺內文與憑證只在 step 內讀寫 DB，因為 Vercel Workflows 會記錄每個 step 的輸入、輸出與錯誤（[Workflows](https://vercel.com/docs/workflows)）。
- 憑證只放 Vercel 的 Sensitive Environment Variables 或本機 `secrets/`。Will 存好後回 `done`，agent 只看 key 名稱，不讀值。
- 每次部署到 Vercel 正式專案、每次改 VM 上的設定，都要 Will 先授權。preview 部署不算。
- 每個單元（一個來源、一組 API、一個狀態機）的完成定義：
  - 對應 Python 測試的行為案例已移植到 TS。
  - 比對器對同一起點、同一天的增量輸出一致；有差異時逐項列在附件，經 Will 接受。
  - 盤點的「去向」欄已更新。
  - 有一個真正的 mutation：改壞實作，測試要失敗。

## 前提（開工時核對過，2026-10-23）

- **會被取代的既有部署是否在線：在線。** `oci-a1` 每天 09:00 Asia/Taipei 收案並寄出摘要。本 session 唯讀查正式 DB 量到：2026-10-23 的 `daily_runs` 是 `failed`（來源部分失敗），`delivery_status: sent`。
  - 會改到正式資料、部署或設定的步驟（4c、6–10 的 shadow 部署、12、13）都附回滾、相容性窗口與資料搬移。
  - 只在本機、分支或 preview 上的步驟，回滾就是 revert。
- Will 選了 C：Next.js 全端改寫並部署到 Vercel，不採保留 Python 換主機或容器平台。（來源：對話，2026-10-23；已確認）
- Vercel 的限制（來源：[Functions limits](https://vercel.com/docs/functions/limitations)、[Cron usage](https://vercel.com/docs/cron-jobs/usage-and-pricing)、[Manage cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)，2026-10-23 查；已確認）：
  - 函式最長 300 秒（Hobby）／800 秒（Pro）。
  - 沒有可長久保存的檔案系統。
  - Hobby 的 cron 一天一次，會在指定的那一小時內任意時間觸發。
  - cron 是 best effort，可能漏觸發，也可能同一排程觸發兩次。
  - Instant Rollback 會恢復舊 deployment 的 cron 定義。
  - Hobby 限個人或非商業用途。
- Vercel Authentication（All Deployments）各方案都有，可以把正式網址也限定成 Vercel 帳號登入才能看。（來源：[Deployment Protection](https://vercel.com/docs/deployment-protection)，2026-10-23 兩位 subagent 各自查文件；未在帳號上驗證 → spike 1a）
- **正式寄送通道是 Gmail SMTP（已確認，量到）。** 2026-10-23 唯讀查正式 DB：最近 3 天 `digest_outbox.delivery_receipt` 的前綴都是 `smtp-accepted`，這個字串只有 `notifications/gmail_smtp.py:21` 會寫入；接線在 `bootstrap/jobs.py:17-24`。
- 今天的收案約 5 分鐘：27 個來源的 `source_health.checked_at` 從 01:01:02 到 01:05:56 UTC（量到，只有今天一個樣本，不含寄信時間）。
- 所有 connector 只用 Python 標準函式庫。（來源：`inventory-sources.md` §0；讀程式得出）
- 雜湊點有 131 行命中（`rg -n "sha256|json.dumps" backend/src | wc -l`，subagent 量到）。各處的 `ensure_ascii` 與 separators 不一致，例如：
  - `discovery/rules.py:61`：預設 separators、`ensure_ascii=False`。
  - `submissions/domain.py:13`：緊湊 separators、`allow_nan=False`。

  另外 Python 的 `sort_keys` 依 code point 排序，JS 預設依 UTF-16 排序。（讀程式得出 → spike 1c）
- `legacy/records.py` 與 legacy 欄位 `review_status` 仍在正式的收案、回饋與候選判斷路徑上。（來源：`inventory-surface.md` §7；讀程式得出）
- 正式資料量：2,226 筆 opportunities、2,303 筆 source_receipts（2026-10-23 唯讀查正式 DB，量到；`docs/implementation-plan.md:20` 的 708／726 是 9/28 的舊數字）；DB 檔 22.9 MB（量到）。
- 環境（2026-10-23 建立）：Vercel 專案 `freelance-agent`（iad1，Deployment Protection All）；Neon 專案 `freelance-agent`（`fancy-water-44947465`，aws-us-east-1，branch `main`、`dev`；preview 用 `dev`）。spike 專案 `freelance-agent-spike` 在 1d 完成後刪除。
- 工具鏈預設（可推翻）：
  - Next.js 16 App Router、TypeScript、pnpm，沿用 `frontend/` 的版本鎖定。
  - ORM 用 Drizzle，搭版本化的 migration；不用 SQLite 那種「整份 `IF NOT EXISTS` 重跑」。
  - 測試用 Vitest；e2e 沿用 Playwright。
  - CI 用 GitHub Actions（repo 目前沒有 workflow；量到：沒有 `.github/workflows`）。
  - TS 的模組邊界用 dependency-cruiser 檢查。

**驗收基線（`d994cd2`，2026-10-23 量到）：**
- 舊系統（規格）：`FREELANCE_TEST_DSN='' backend/.venv/bin/python -B -m unittest discover -s backend/tests -q` → `Ran 629 tests … OK (skipped=22)`，exit 0。
- 前端：`pnpm run contracts:check`、`pnpm run typecheck`、`pnpm run build` 都 exit 0。
- 已知失敗：無。
- 新 app：還沒建立，基線在步驟 3 建立。
- 正式狀態：`daily_runs` 自 2026-10-16 起每天 `failed`（部分來源失敗），信仍寄出。這是既有缺陷，不在本計畫修；比對以 Python 的實際輸出為準。

## 本階段依賴的不變量

| 不變量 | 依賴它的機制 |
|---|---|
| 同一天、同一收件者最多一份摘要 intent；snapshot 寫入後不可變 | `digest_outbox`（`001_sqlite.sql:28`、trigger `digest_immutable` :41）、`daily_runs` 主鍵 `(local_date, recipient)`、`notifications/daily.py`、`notifications/scheduler.py`；TS：`daily` 工作流程、Postgres 唯一約束與 trigger |
| attempted／unknown 的寄送不自動重試，只能人工核對 | `digest_outbox` 狀態機（`inventory-surface.md` §5c）、`notifications/gmail_smtp.py`、`notifications/scheduler.py:20-39` 的 `dispatch`、`bootstrap/recovery.py`；TS：寄送 step 的重試次數固定為 0 |
| 已有任何 daily run 就不重新呼叫來源或重寄；過期日期不執行 | `scheduler.daily_tick`（`docs/design.md:60`）；TS：cron handler 入口的 `daily_runs` claim。這條同時擋住 Vercel cron 重複觸發 |
| 同一時間只有一個 writer 寫正式資料、對外寄信 | Huey 單一 consumer 與 `queue.lock`（`bootstrap/queue.py:24`）、SQLite `BEGIN IMMEDIATE`；TS：`daily_runs` row claim 加 Postgres advisory lock；切換程序（步驟 13） |
| 草稿版本、submission 與其事件不可修改、不可刪除 | `draft_revision_immutable`／`draft_revision_retained`／`submission_immutable`／`submission_event_immutable`／`submission_event_retained`（`001_sqlite.sql:192-224`）；TS：Postgres 等價 trigger |
| 參與雜湊或 snapshot 的欄位逐位元保存 | `opportunities.item`、`digest_outbox.snapshot`、`proposal_draft_revisions`、`submission_intents` 的 snapshot；TS：這些欄位用 `text` 不用 `jsonb`；序列化集中在 `web/src/shared/canonical-json.ts` |
| `(source, external_id)` 唯一；receipt ID 防重複匯入 | `opportunities`、`source_receipts`、各 connector 的 receipt 規則（`inventory-sources.md` §1）；TS：connector 共用的 `ingest` 與指紋函式庫 |
| 未知欄位保留為未知 | `discovery/rules.py`、各 connector 的 envelope；TS：envelope 型別（unknown 是明確的值，不用 `null` 推定） |
| 回饋與設定變更沿用呼叫端的交易，stale revision 被拒絕 | `preferences`、`discovery/settings.py`、`tracking_events` revision；TS：route handler／server action 的交易邊界 |
| 歷史核准失效保護（`AGENTS.md`） | `legacy/review_service.py`、`backend/tests/legacy/test_review.py`（11 個）；TS 去向見 D8 |
| Workflow run data 不含正文與憑證 | TS：所有 `"use step"` 函式的參數與回傳型別只能是 ID、計數、狀態；用型別測試加 lint 守住 |
| UI 與 API 只有本人看得到；請求有來源檢查與 body 上限 | 現況：loopback、SSH tunnel、`LocalBoundary` 的 Origin 檢查與 body 上限（`bootstrap/http.py`）；TS：Vercel Authentication 加上 route 層的 Origin 檢查與 body 上限 |
| 離線 demo 不讀憑證、不連外、不寄信 | `bootstrap/http.py` `mode='demo'`、MemoryDatabase；TS：步驟 11 的 demo 模式（PGlite 加 network guard） |

## 規模（搬遷）

| | 數量 | 產生計數的位置 |
|---|---|---|
| SQLite 資料表 | 25 張（19 張保留歷史）、6 個 trigger | `inventory-surface.md` §1 |
| HTTP API operation | 42 個（32 個 path） | `inventory-surface.md` §2 |
| 前端呼叫點 | 47 個；proxy 的 route 白名單 1 份 | `inventory-surface.md` §3 |
| CLI 入口 | 19 個 | `inventory-surface.md` §4 |
| 來源 connector | 29 個：API 10、RSS 5、HTML 7、Resend 信件 7；正式啟用 27 個 | `inventory-sources.md` §0–1 |
| Python 程式／測試 | `backend/src` 9,940 行；74 個測試檔、629 個測試 | `find backend/src -name '*.py' \| xargs wc -l`；基線輸出 |

## 範圍

- **做：**
  - 新 Next.js 全端 app，取代 FastAPI、Huey、`frontend/` 與 `contracts/`。
  - Postgres schema 與版本化 migration。
  - 27 個正式啟用的來源。
  - 每日排程與每個來源各跑一次（fan-out）。
  - 摘要建置與寄送。
  - 收藏／略過、設定、投案、客戶、模板與草稿工作台。
  - 離線 demo。
  - 每日副本管道與 shadow 比對器。
  - SQLite ↔ Postgres 雙向收斂腳本。
  - CI 與模組邊界檢查、切換，以及刪除 Python、Compose、舊前端。
- **不做：**
  - Submission 對外送出（Email／Freelancer）的程式改寫，因為通道未配置（`docs/compose.md:64`）。資料表與歷史會搬（D7）。
  - Legacy AI 擬稿、Antigravity、舊 PG adapter，因為只有 legacy 測試在用（`inventory-surface.md` §7）。資料搬，程式不改寫。
  - Indeed、Guru，因為正式未啟用。
  - 修 2026-10-16 起的來源失敗，那是既有缺陷，另開工作。
- **延後：**
  - Submission 送出改寫（觸發條件：Will 決定要配置 Email 或 Freelancer 通道）。
  - VM 上本專案資源的退役與 SQLite 檔刪除（觸發條件：D6 窗口結束，且期間每天的自然排程都寄出）。
  - Indeed、Guru 接入（觸發條件：`platform-connectivity.md` 把它們改成可啟用）。
  - 被 Vercel 出口 IP 擋下的來源（觸發條件：spike 1e 量到被擋；處置見步驟 8 的停止條件）。

## 步驟

- [ ] **1. Spike：把技術未知換成事實**（被擋於：D1；需要人做的事見下）
  - 產出是事實紀錄（附件 `spikes.md`），不是產品程式碼。每項寫測法、原始輸出與「成立／不成立」。
  - 用另開的 spike 專案（Vercel 與 Neon 各一個），用完刪除。
  - 1a 存取控管：開啟 Vercel Authentication（All Deployments），驗兩件事：
    - 未登入的 `curl -sI <url>` 回 401 或導向登入頁。
    - 帶 `CRON_SECRET` 的 cron 能穿過保護呼叫 handler；或用 Protection Bypass for Automation 達到同樣效果。
  - 1b fan-out：用 D2-A（Vercel Cron 加 Workflows）跑 27 個假 step，每個睡 60 秒。驗：
    - 一次觸發內全部完成。
    - 單一 step 失敗不影響其他 step。
    - step 的重試次數可以設成 0。
    - run data 裡只有 ID 與狀態。
    - 量 event 數與寫入量，換算 Hobby 的每月用量。

    不成立時，改用 D2-B 或 D2-C 的候選重測。
  - 1c 指紋相容：
    - 把 131 行雜湊命中整理成雜湊點清單。
    - 每個點用合成資料產生 Python 期望值，涵蓋中文、emoji（非 BMP）、浮點數、巢狀結構、空值。
    - TS 實作要逐位元相同。合成 fixture 可以進 git。
    - 另外用正式副本做一次性驗證，結果只記通過數，不提交資料。
  - 1d 寄送通道：照 D9 的選項，從 Vercel 函式寄一封合成信到測試收件者。D9-A 驗 SMTP 465 能連出。另外用 Resend Receiving API 讀一頁 metadata。
  - 1e 出口與時間：對 27 個啟用來源各從 Vercel 函式抓一次，用 D1 選的 function 區域。記 HTTP 狀態、秒數、是否被擋（challenge、403、逾時）。
  - 消費端：無（spike 專案）。
  - 驗收：`spikes.md` 每項都有原始輸出與結論。
  - 1c 的正式副本驗證擋住步驟 4c；1d 實寄擋住步驟 10。這兩項不擋步驟 2、3。
  - 停止條件：遇到下列任一種，停下回報：
    - 1a 不成立：正式網址擋不住。
    - 1c 有雜湊點無法逐位元重現：D4 要改成「切換時重新計算指紋」，那會讓既有 receipt 失效。
    - 1e 有 3 個以上的來源被擋。
  - 需要人做的事：
    - 建立 Vercel 帳號與 spike 專案、選方案（D1）。
    - 建立 Neon 專案。
    - 把 spike 用的寄送與 Resend 憑證存進 spike 專案的 Sensitive env，存好回 `done`。
    - 授權在 1c 讀正式 DB 的副本。

- [x] **2. 填寫盤點去向、缺陷處置與允許殘留**（被擋於：spike 1a、1b、1c 合成、1e（已成立）；D1–D12（已決））
  - 範圍：
    - 在兩份盤點的每一列填「去向」：改寫成什麼 TS 模組、搬資料不改寫、刪除（附理由）。
    - 列出既有缺陷並寫處置：
      - `store.review()`、`tracking_summary()` 只有測試在呼叫。
      - proxy 的 regex 白名單是 API 的第二份登記處。
      - `--backend` 預設是 postgres。
      - `backend/tests/preferences/` 是空目錄。
    - 新增 `allowed-residue.md`：步驟 14 允許留下的 `oci-a1`、`compose`、`huey`、`8327`、`3327` 命中，例如 `docs/implementation-history.md` 與本計畫目錄。
    - 新增 `check_inventory.py`，檢查兩件事：去向欄沒有 `TBD` 或空白、缺陷都有處置；以及給定的 rg 輸出只命中允許殘留。
  - 消費端：無（只改文件）。
  - 不能動：盤點的原始事實欄位。
  - 驗收：`python3 docs/plans/2026-10-23-nextjs-vercel-migration/check_inventory.py` exit 0。mutation：把任一列改回 `TBD`，腳本要 exit 非 0。

- [ ] **3. Walking skeleton：新 app、CI 與一條端到端路徑**（被擋於：步驟 2、D3）
  - 範圍：
    - 依 D3 建立 `web/`。
    - Drizzle 連 Neon 的 dev branch，第一個 migration 建 `source_health`。
    - 一個 cron route 觸發工作流程，跑一個假來源，寫入 `source_health`。
    - 一個受保護的頁面列出 `source_health`。
    - GitHub Actions：
      - typecheck、lint、dependency-cruiser 邊界檢查。
      - Vitest（用 Postgres service container）、build。
      - Python 的 629 個測試與 `scripts/check_boundaries.py` 也在同一份 CI 跑，直到步驟 14 刪除。
    - 在 `AGENTS.md` 加一段遷移期規則：`web/` 在切換前不擁有正式業務結果，正式 writer 仍是 Huey；契約生成規則只適用於 `backend/` 與 `frontend/`。這段到步驟 14 收斂。
  - 消費端：舊路徑不受影響。驗收方式：`git diff d994cd2 -- backend frontend deploy contracts scripts` 輸出為空。
  - 不能動：`frontend/`、`backend/`、`deploy/`、`contracts/` 與 VM。
  - 驗收：
    - CI 在 PR 上綠燈。
    - preview 上未登入的 `curl -sI` 被擋。
    - 手動觸發 cron 後，頁面出現假來源那一列。
    - mutation：把 handler 開頭「先標 failed」那行移除，再讓假來源丟例外，「失敗時 `source_health` 為 failed」的測試要失敗。

- [ ] **4. 共用層**（被擋於：步驟 3、D4、D10、D11）
  - 4a schema 與資料存取：
    - 25 張表與 6 個 trigger 的 Postgres 版本，用版本化 migration。
    - 參與雜湊或 snapshot 的欄位用 `text`。
    - 每張表的去向照步驟 2。
  - 4b 收集機制與領域邏輯：
    - `source_batch`、`ingest`／`finish`、dedup 與分組。
    - filters／preferences、eligibility unknown。
    - legacy envelope codec：`records.py` 的 new_observation／refresh／feedback_changed／save，以及 `review_status` 的讀取。
    - 指紋函式庫 `canonical-json.ts`（照 spike 1c 的結果）。
  - 4c 每日副本管道與 SQLite → Postgres 收斂腳本 v1：
    - 在 VM 上新增一個只讀正式 DB 的排程，每天 08:30 Asia/Taipei 用 SQLite backup API 做一致副本。
    - 用收斂腳本 v1 把副本灌進 Neon 的 shadow branch：先清空，再全量載入。冪等鍵取自來源主鍵，重跑結果相同，中斷可續。
    - 執行位置是 VM 上獨立的容器，不掛正式 DB 的寫入權限。
    - 副本檔在 VM 上保留 7 天。
  - 4d shadow 比對器：
    - 輸入是 08:30 起點副本、Python 跑完後的副本（10:30 再做一次），以及 TS 跑完後的 shadow DB。
    - 只比較「同一起點之後的增量」。
    - 差異分成兩類：來源資料時間差（兩邊抓取時間不同，可接受），和邏輯差異（不可接受）。
    - 報告寫到 VM 上的報告目錄，印出兩份副本的時間。
  - 消費端：
    - `rg -n "source_batch|store\.ingest|records\.(save|refresh|new_observation|feedback_changed)|review_status" backend/src` 的每個命中都要在 TS 有對應或去向。
    - `rg -n "CREATE TABLE" backend/src/freelance/platform/schema/001_sqlite.sql` 的每一列都要出現在收斂腳本中。
  - 不能動：Python 端任何行為；正式 DB 只讀。
  - 驗收：
    - 移植 dedup、分組、stale feedback、unknown eligibility 的測試案例，Vitest 通過。
    - trigger 測試：UPDATE／DELETE 不可變的列被 Postgres 拒絕。
    - 收斂腳本對同一副本跑兩次，逐表計數與內容指紋報告完全相同。
    - 比對器對同一份副本與自己比較，輸出 0 差異。
    - mutation：
      - 拿掉 `draft_revision_immutable` 的等價 trigger，測試要失敗。
      - `canonical-json.ts` 改成不排序 key，或 separators 改錯，1c 的合成期望值測試要失敗。
      - 收斂腳本漏一張表，指紋報告要失敗。
  - 需要人做的事：授權在 VM 上新增副本排程與容器（改 VM 設定）。
  - 回滾：停用並刪除 VM 上的副本排程與容器；正式 DB 沒有被寫入。

- [ ] **5. TS 端排程骨架（shadow 部署）**（被擋於：步驟 4、D2、D5）
  - 範圍：
    - 依 D5 設定 cron。
    - 入口先做 `daily_runs` claim，重複觸發時第二次直接返回。
    - fan-out 到各來源的 step。
    - 來源 registry 與啟用規則：沿用 `source_catalog.py` 的來源清單與優先序，加上 `discovery_settings` 的啟用開關；ptt_soho、ptt_codejob 標為停用（D12）。
    - 第一次部署 Vercel 正式專案，DB 指向 shadow branch，env 不含寄送憑證。
  - 驗收：
    - 同一天手動觸發兩次 cron，`daily_runs` 只有一列，第二次的 log 顯示「已有 run」。
    - `vercel env ls production` 不含寄送相關的 key。
    - mutation：拿掉 claim，「重複觸發只跑一次」的測試要失敗。
  - 需要人做的事：授權第一次正式專案部署與 cron。
  - 回滾：在專案設定 Disable Cron Jobs，刪除正式專案。

- [ ] **6. 試點：Jobicy／Remotive**（被擋於：步驟 5）
  - 範圍：把 `collection/free_jobs.py`（80 行、6 個測試）改寫成 TS，在 shadow 模式每天跑。
  - 消費端：`rg -n "free_jobs|jobicy|remotive" backend/src frontend/src`。
  - 不能動：VM 上的 Python 來源照常跑，是唯一 writer。
  - 驗收：
    - 6 個 Python 測試案例的 TS 版通過。
    - 連續 7 天，比對器對 Jobicy、Remotive 回報 0 筆邏輯差異。
    - mutation：把 receipt ID 規則改掉，比對器要回報差異。
  - 停止條件：有無法以來源資料時間差解釋的差異 → 停下並回報差異清單。

- [ ] **7. 第二個試點：CryptoJobsList（驗證 `source_batch`）**（被擋於：步驟 6）
  - 範圍與驗收：同步驟 6。
  - 另加：批次中途失敗時整批不寫入的測試。mutation：把交易邊界移到逐筆寫入，測試要失敗。

- [ ] **8. 其餘免登入來源（API、RSS、HTML；正式啟用、扣除試點的那些，清單以附件 §1.1 為準）**（被擋於：步驟 7）
  - 範圍：由小到大分批改寫，每批不超過 5 個來源，每批 shadow 跑滿 3 天比對。Freelancer、Arbeitnow 這類有分頁上限、時間上限或 partial 映射的來源最後做。
  - 消費端：附件 §1.1 每列的檔案。
  - 驗收：
    - 每批的 Python 測試案例 TS 版通過。
    - 比對器 3 天 0 筆邏輯差異。
    - 每批一個 mutation：改壞分頁或 partial 判斷，測試要失敗。
  - 停止條件：遇到下列任一種，停下回報：
    - spike 1e 或實跑顯示來源超過 300 秒：先拆成多個 step 再做，不調高逾時了事。
    - 來源擋 Vercel 出口 IP：回報 Will，選項有換 function 區域、移到延後，或放棄該來源。

- [ ] **9. 信件來源（Resend Receiving，7 個）**（被擋於：步驟 8）
  - 範圍：
    - `mail_sync_state` 游標。
    - 逐封交易、隔離、`retry_pending`。
    - 收件者邊界。
    - 各家 parser，照附件 §1.2。
    - shadow 模式只讀，不改 Resend 端的任何狀態。
    - 正文只在 step 內讀寫，不放進 step 的參數或回傳值。
  - 消費端：附件 §1.2；`rg -n "mail_sync|mail_ingestion|mail_content_versions" backend/src`。
  - 驗收：
    - `test_glassdoor_mail.py` 與 LinkedIn alert header（`8943ec8`）這類回歸案例的 TS 版通過。
    - 比對器 3 天 0 筆邏輯差異。
    - 查 run data，裡面沒有正文欄位。
    - mutation：拿掉收件者邊界檢查，對應測試要失敗。

- [ ] **10. 摘要建置與寄送路徑（shadow 只建不寄）**（被擋於：步驟 9、D9）
  - 範圍：
    - `daily_runs` claim 與 `digest_outbox` 狀態機。
    - 摘要建置、寄送（D9 選的通道）、MIME 預覽 sha256 校驗（`bootstrap/jobs.py:21-24`）。
    - 人工核對的 recovery 操作：改成受保護的頁面或 script，取代 `bootstrap/recovery.py`。
    - 手動寄出既有 pending 摘要的操作，取代 `gmail_smtp_cli`：要核對預覽 sha256（由 TS 自己算），不沿用 Python 算的值。
    - shadow 模式只建 snapshot，寄送 step 因為缺憑證而結構上無法執行。
  - 消費端：`inventory-surface.md` §5b–5c 的每個轉移；`rg -n "daily_tick|dispatch|digest_outbox|gmail_smtp" backend/src`。
  - 驗收：
    - 「不確定寄送不重試」「同日不重寄」「過期日期不執行」三組測試的 TS 版通過。
    - shadow 7 天的候選清單與 Python 實寄的 snapshot 在同一起點下比對一致。
    - mutation：讓寄送 step 允許重試，測試要失敗。

- [ ] **11. UI、API、契約與離線 demo**（被擋於：步驟 4、D10；可以和步驟 6–10 並行）
  - 範圍：
    - 42 個 operation 依 D10 改成 route handler 或 server action，47 個前端呼叫點改成直接呼叫。
    - 移除 proxy 白名單。
    - 補上 Origin 檢查與 body 上限；回應標頭沿用 `no-store`、`nosniff`；錯誤碼對應沿用現有 API（`inventory-surface.md` §2）。
    - `/digest` 預覽使用步驟 10 的 render，這一項要排在步驟 10 之後。
    - 頁面沿用 `frontend/` 的元件。
    - 歷史核准失效保護依 D8。
    - 離線 demo 模式：PGlite 加 network guard，不讀任何 env。
  - 消費端：`inventory-surface.md` §3 的 47 個呼叫點；`rg -n "openapi-fetch|api\.d\.ts|contracts/" frontend scripts`；`frontend/tests/{smoke,manual-application-load,workbench}.mjs`。
  - 驗收：
    - 三支前端測試的等價版在 preview 上通過。
    - stale revision 被拒絕的測試通過。
    - 斷網且沒有任何 env 時，demo 的 e2e 通過。
    - mutation：
      - 移除 revision 檢查，測試要失敗。
      - 在 demo 路徑加一個 `fetch`，network guard 要讓測試失敗。
  - 完成後的狀態：preview 讀的是 shadow DB。

- [ ] **12. 反向收斂腳本與切換演練**（被擋於：步驟 10、11、D6）
  - 範圍：
    - 收斂腳本 v1 定版，加上切換用的計數與指紋報告。
    - 反向腳本 Postgres → SQLite 做全表收斂：以主鍵 upsert，涵蓋切換後的新增列與更新列，例如 `opportunity_tracking.state`、`digest_outbox.status`、`daily_runs`、`mail_sync_state.cursor`、`opportunities.item`、revision。有不可變 trigger 的表只追加。
    - 在副本上演練完整切換與回滾各 2 次。
  - 驗收：
    - 2 次演練的指紋報告完全相同。
    - 回寫後的 SQLite 副本通過兩項檢查：
      - `scripts/test_workbench_upgrade.py --database <回寫副本> --previous-source <d994cd2 checkout>`。
      - 用切換前的 Python image 讀取的投影，與 Postgres 端一致（`scripts/verify_cutover.py` 或新增的投影比對）。
    - mutation：反向腳本漏掉 `digest_outbox.status` 這類更新欄位，驗收要失敗。
  - 需要人做的事：授權讀正式 DB 副本。

- [ ] **13. 正式切換（deploy，必須連著做）**（被擋於：步驟 12、D6、D9；Will 明確授權）
  - 範圍：
    1. 在 Vercel 專案 Disable Cron Jobs，確認當天 TS 的 shadow run 已結束。
    2. 確認 VM 當天的 `daily_runs` 已是 complete 或 failed，且 `digest_outbox` 沒有 pending、attempted 或 unknown（pending 要先在 VM 上寄出或人工結案，因為預覽 sha256 不跨語言沿用）。
    3. 停 VM 的 API／worker／Web，用 `docker compose ps` 確認沒有 writer。
    4. 做一致備份；先在 Neon 的 prod branch 跑 Drizzle migration 到最新版本，再跑收斂腳本與指紋報告。
    5. 改 production env：`DATABASE_URL` 指向 prod branch；Will 存入寄送憑證後回 `done`；寄送開關打開。然後重新部署，並 Enable Cron Jobs。
    6. 驗下一次自然排程；Hobby 會在 09:00–09:59 之間觸發。
    7. shadow branch 保留到 D6 窗口結束。
  - 回滾（D6 窗口內）：
    1. Disable Cron Jobs。
    2. 跑反向腳本。
    3. 用切換前的 image 與 env 重啟 VM 的 Compose（`docs/compose.md:60`）。
    4. 不用 Instant Rollback，因為它會恢復舊的 cron 定義。
  - 驗收：
    - 第 4 小步的每表計數與指紋，等於第 3 小步備份算出的值。
    - 隔天 `daily_runs` 有一列、`delivery_status=sent`，Will 確認收到信。
    - VM 的 worker 確認已停。
  - 停止條件：指紋不符，或第一次自然排程沒有寄出 → 照回滾程序處理，不重寄。
  - 需要人做的事：授權部署；存入寄送憑證；確認收到信。
  - 完成後的狀態：VM 停機但保留，直到 D6 窗口結束；4c 的副本排程停用。

- [ ] **14. 收尾**
  - 刪除：
    - `backend/`、`deploy/`、`frontend/`、`contracts/`。
    - `scripts/test_compose.py`、`test_installed.py`、`test_workbench_upgrade.py`、`verify_cutover.py`。
    - `scripts/check_boundaries.py`，由 dependency-cruiser 取代。
    - VM 上 4c 的副本容器。
  - 更新：
    - `AGENTS.md`：收斂遷移期規則與技術棧。
    - `README.md`。
    - `docs/design.md`、`docs/compose.md`（改寫成 Vercel 操作）、`docs/implementation-plan.md`、`docs/features.md`、`docs/platform-connectivity.md`、`docs/README.md`。
  - 完成定義逐項核對；獨立設計審查（design-review skill）。
  - 長期檢查接進 CI：schema 漂移、trigger 測試、指紋相容測試、step 型別檢查。
  - 延後項附觸發條件，搬回主清單。
  - 需要人做的事：
    - VM 退役。
    - 確認 Neon 與 Vercel 帳單。
    - 更新 repo 外的 wiki 專案頁（交給 recording 流程）。
  - 驗收：
    - `rg -n -l "oci-a1|compose|huey|8327|3327|freelance\." .` 的輸出交給 `check_inventory.py`，只剩 `allowed-residue.md` 列的命中。
    - CI 綠燈。
    - design-review 的發現都有處置。

## 決定

- **D1 Vercel 方案、資料庫供應商與區域**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：1、2；需要的事實：Workflows 的 Hobby 用量與 Neon 免費方案的 branch／儲存上限，在 1b 量）
  - A：Vercel Hobby（免費）＋ Neon 免費方案，function 與 DB 放同一區（Neon 的 Singapore 搭 Vercel `sin1`，或都放 `iad1`）——預期成本 0，但 Workflows 按用量計費，要 1b 確認。cron 有一小時誤差，函式 300 秒；非商業條款用在找兼職算灰色地帶（推論）。（建議，先用；條款疑慮或時間精度不夠時升 Pro）
  - B：Vercel Pro（每月 20 美元）＋ Neon——cron 可以每分鐘、函式 800 秒、條款沒疑慮。
  - C：Supabase 取代 Neon——多了 auth 與 storage，本專案用不到。

- **D2 每天的工作流程與 fan-out 機制**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：5）
  - A：Vercel Cron ＋ Vercel Workflows——步驟可持久化、每步可設重試、同平台；run data 會記錄 step 的輸入輸出，要遵守「只放 ID」。（建議，條件是 1b 成立）
  - B：Inngest 或 Trigger.dev——成熟的 durable jobs，多一個外部帳號與憑證。
  - C：GitHub Actions 排程呼叫受保護的 endpoint——免費、時間較準，workflow 狀態要自己存在 DB。

- **D3 新 app 放在哪裡**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：3）
  - A：同一個 repo 的新目錄 `web/`，切換後刪 `backend/`、`frontend/`、`contracts/`——歷史與 issue 在同一處，CI 能同時跑新舊測試。（建議）
  - B：直接改寫 `frontend/`——少一個目錄，但遷移期間現行 Web 和新 app 混在一起。
  - C：新 repo——最乾淨，但歷史分散。

- **D4 正式資料怎麼搬**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：4、12；需要的事實：spike 1c）
  - A：25 張表全部搬進 Postgres，指紋逐位元相容——歷史、dedup 與 receipt 延續，不會重收舊職缺。（建議）
  - B：只搬工作台、投案與 tracking，其他匯出成唯讀封存——schema 較小，但 dedup 歷史斷掉，切換後第一天會把舊職缺當新的。
  - C：重新開始——違反保留歷史資料的規則。

- **D5 排程時間與補跑語意**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：5）
  - 現況：09:00 後每分鐘檢查，重啟可以補當天（`docs/design.md:60`）。
  - A：09:00 一支 cron，加上同一天 12:00 第二支補跑 cron，由 `daily_runs` claim 保證最多一次；跨日不補——Hobby 可行。摘要在 09:00–09:59 寄出，第一支漏觸發時在 12:00–12:59 補寄。（建議）
  - B：只有一支 cron——最簡單，但漏觸發的那天就沒有摘要。
  - C：準時 09:00 並每分鐘補跑——需要 Pro 或 D2-C。

- **D6 切換後的回滾窗口**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：12、13）
  - A：14 天，VM 停機但保留，反向腳本隨時可跑。（建議）
  - B：7 天——比較快收掉 VM，只涵蓋一週的自然排程。
  - C：不保留回滾——第一週出問題只能往前修。

- **D7 Submission 對外送出模組**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：2、11）
  - A：資料表與歷史搬過去，送出程式不改寫，UI 顯示「未配置」，延後到要配置通道時再寫。（建議）
  - B：一起改寫——多約 11 個狀態轉移，但沒有真實通道可以驗收。

- **D8 Legacy 程式與歷史核准失效保護**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：2、4、11）
  - A：`records.py` 的 envelope codec 與 `review_status` 讀取還在正式路徑上，改寫成 TS。AI 擬稿、舊 PG adapter 只搬資料。歷史核准失效保護改寫成 TS，移植 `test_review.py` 的 11 個案例。（建議）
  - B：同 A，但歷史核准失效保護不改寫，改成「歷史 approval 一律唯讀、不可再用於送出」，並同步改 `AGENTS.md` 的對應規則——程式較少，但規則要改。
  - C：`records.py` 也不改寫，切換時把 envelope 正規化成新欄位——schema 較乾淨，但多一道資料轉換，比對器要多一層對應。

- **D9 摘要寄送通道**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：1d、10、13）
  - A：沿用 Gmail SMTP（app password，smtp.gmail.com:465）——不改寄件人與收件體驗；要 1d 驗證 Vercel 能連出 465。（建議；現況已確認是 SMTP）
  - B：改用 Resend 寄送（repo 已有 `resend_delivery.py`）——HTTP API，serverless 最穩；需要自訂寄件網域（`jobs.py:12`），寄件人會改變。
  - C：Gmail API OAuth——不需要 app password，但要處理 refresh token 的存放。

- **D10 API 契約來源**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：4、11）
  - 現況：契約由 `contracts.py` 生成 `openapi.json` 與 `api.d.ts`，有編譯期的負向契約測試（`inventory-surface.md` §3c）。
  - A：zod schema 當唯一來源，server action 與 route handler 共用，負向測試改成 zod 的型別測試；刪除 OpenAPI 生成——全端同一語言後，生成步驟沒有必要。（建議）
  - B：保留 OpenAPI，從 zod 生成——只有在要給外部 client 用時才值得。

- **D11 shadow 期把正式資料副本放進 Neon**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：4）
  - A：每天把正式副本灌進 Neon 的 shadow branch——比對器才能在同一起點比較。這等於切換前就把個人資料放上 Neon，而切換後資料本來就會在那裡。（建議）
  - B：shadow 只用合成資料——資料不提前上雲，但比對器無法驗證真實資料的 dedup 與摘要，步驟 6–10 的驗收要改成只跑合成案例。

ADR：`docs/adr/2026-10-23-nextjs-vercel-full-stack-rewrite.md`（選 C 與已決各題的理由）。

- **D12 PTT 兩個來源（ptt_soho、ptt_codejob）**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：2、8；需要的事實：spike 1e，已完成）
  - 事實：Vercel 的 sin1 與 iad1 對 PTT 都回 403 challenge，VM 與 Mac 回 200（`spikes.md` §1e）。PTT 至今共收 3 筆、0 筆有人工標記（2026-10-23 量到）。依規則不繞過 challenge。
  - A：不搬，切換後停用這兩個來源；歷史資料照搬，`platform-connectivity.md` 標明原因——損失極小（3 筆）。（建議）
  - B：在 VM 或 Mac 保留一個只抓 PTT 的小程式，寫入 Neon——保住來源，但留下要維護的主機，和搬離 VM 的目標衝突。

拍板順序：D1、D3、D4、D6、D7、D8、D10、D11 已於 2026-10-23 拍板。D9 於同日拍板（A）。D2、D5、D12 在 spike 1 之後於同日拍板（A）。D2 等 spike 1b，D5 等 D1 與 D2，在步驟 1 完成後再交。

## 進度

狀態值：未開始／進行中／程式完成待驗收／完成。

| 步驟 | 狀態 | 已跑的驗收 | 未跑的驗收與原因 | commit |
|---|---|---|---|---|
| 1 Spike | 進行中 | 1a、1b、1e 成立；1c 合成 707/707；1d 連線成立（`spikes.md`） | 1c 正式副本、1d 實寄：待授權與憑證 | |
| 2 盤點去向 | 完成 | `check_inventory.py` exit 0（243＋29 列、20 項缺陷）；改一列為 TBD 時 exit 非 0；6 個計畫缺口已補進步驟 5、10、11、13 | `--residue` 要到步驟 14 才跑 | |
| 3 Walking skeleton | 程式完成待驗收 | 本機：`pnpm typecheck`、`pnpm boundaries`（違規 import 被擋）、`pnpm test` 5/5（mutation：移除開頭標 failed → 2 失敗）、`pnpm build`；preview 未登入 302、錯誤 secret 401、觸發 cron 後頁面出現 `skeleton ok`；舊路徑 diff 為空 | CI 在 PR #1 沒啟動：GitHub Actions 帳務（付款失敗或花費上限），待 Will 處理後重跑 | `813df86` |
| 4 共用層 | 未開始 | | | |
| 5 TS 端排程骨架 | 未開始 | | | |
| 6 試點 Jobicy／Remotive | 未開始 | | | |
| 7 CryptoJobsList | 未開始 | | | |
| 8 其餘免登入來源 | 未開始 | | | |
| 9 信件來源 | 未開始 | | | |
| 10 摘要與寄送 | 未開始 | | | |
| 11 UI、API、demo | 未開始 | | | |
| 12 反向收斂與演練 | 未開始 | | | |
| 13 正式切換 | 未開始 | | | |
| 14 收尾 | 未開始 | | | |
