# 搬離 VM：改寫成 Next.js 全端並部署到 Vercel

**Goal：** 正式環境不再依賴 `oci-a1`。收案、篩選與分組、每日摘要寄送、收藏／略過、投案、客戶與草稿工作台，全部由同一個 Next.js（TypeScript）app 提供，部署在 Vercel，資料放代管的 Postgres。Python backend、Huey、Compose、舊 `frontend/` 與 `contracts/` 都已刪除。驗收見步驟 14。

**上層：** 主清單見本機個人脈絡檔（`AGENTS.local.md`）。本計畫暫代主計畫，所以保留下面的「全域約束與完成定義」。

**附件：** `docs/plans/2026-10-23-nextjs-vercel-migration/`，快照 commit `d994cd2`（在 PRIVATE 的 `freelance-agent-archive`；2026-10-23 起公開 repo 從新歷史開始，本計畫引用的舊 SHA 都在 archive）。
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
- **切換前 Python／VM 是唯一對外寄信、寫正式資料的系統。** TS 版在 shadow 期（影子期）只寫 shadow DB。Vercel production env 裡沒有任何寄送憑證，這是結構性防護，不是只靠程式碼守住；驗收方式是 `vercel env ls production` 的 key 名稱清單。唯一例外（D14，Will 2026-10-25）：讀 Resend Receiving 的 `RESEND_API_KEY`。Resend 沒有唯讀 key，這把 `full_access` key 技術上能寄信與管理帳號；對它的防護是程式加測試：`ReceivingClient` 只送 GET，且每個請求先過 `assertReceivingUrl`（只允許 `https://api.resend.com/emails/receiving` 底下），`web/src` 裡只有 `receiving.ts` 寫到 Resend 的網址。驗收改成精確的 key 名稱白名單：允許 `DATABASE_URL`、`CRON_SECRET`、`DIGEST_RECIPIENT`、`PORTFOLIO_CATEGORY_PROJECTS`、`RESEND_API_KEY`、`RESEND_INBOX`，其他名稱（含任何 SMTP 相關的 key）出現就不通過。
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
| 參與雜湊或 snapshot 的欄位逐位元保存 | `opportunities.item`、`digest_outbox.snapshot`、`proposal_draft_revisions`、`submission_intents` 的 snapshot；TS：這些欄位用 `text` 不用 `jsonb`；序列化集中在 `web/src/platform/py/json.ts` |
| 規格是正式映像的 CPython 3.13.15，不只是 Python 原始碼：`html.parser`、`fromisoformat`、`urlsplit` 在 3.13.13 與 3.13.15 之間行為不同（2026-10-24 量到） | `deploy/backend.Dockerfile` 釘 `python:3.13.15-slim`（2026-10-24 Will 決定；執行中的 `d994cd2` 映像本來就是 3.13.15，下次重建才生效）；TS：`web/src/platform/py/*.ts` 註明的版本、`gen_golden.py` 開頭的版本檢查、本機 `backend/.venv`（3.13.15）。要升 Python 時，Dockerfile、`gen_golden.py` 的版本檢查、本機 venv 一起改，並用新版重跑 `gen_golden.py` 與差異 |
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

- [x] **3. Walking skeleton：新 app、CI 與一條端到端路徑**（被擋於：步驟 2、D3）
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

- [x] **4. 共用層**（被擋於：步驟 3、D4、D10、D11）
  - 4a schema 與資料存取：
    - 25 張表與 6 個 trigger 的 Postgres 版本，用版本化 migration。
    - 參與雜湊或 snapshot 的欄位用 `text`。
    - 每張表的去向照步驟 2。
  - 4b 收集機制與領域邏輯：
    - `source_batch`、`ingest`／`finish`、dedup 與分組。
    - filters／preferences、eligibility unknown。
    - legacy envelope codec：`records.py` 的 new_observation／refresh／feedback_changed／save，以及 `review_status` 的讀取。
    - 指紋函式庫 `web/src/platform/py/json.ts`（照 spike 1c 的結果；測試 `canonical-json.test.ts`）。
  - 4c 每日副本管道與 SQLite → Postgres 收斂腳本 v1：
    - 在 VM 上新增一個只讀正式 DB 的排程，每天 08:30 Asia/Taipei 用 SQLite backup API 做一致副本。
    - 用收斂腳本 v1 把副本灌進 Neon 的 shadow branch：先清空，再全量載入。列保留來源主鍵；載入在單一交易內，中斷時整批回滾，重跑同一份副本得到相同結果。
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
      - `web/src/platform/py/json.ts` 改成不排序 key，或 separators 改錯，1c 的合成期望值測試要失敗。
      - 收斂腳本漏一張表，指紋報告要失敗。
  - 需要人做的事：授權在 VM 上新增副本排程與容器（改 VM 設定）。
  - 回滾：停用並刪除 VM 上的副本排程與容器；正式 DB 沒有被寫入。
  - 實作狀態（2026-10-24，commit 見進度表）：
    - 4a：`web/src/db/schema.ts`、`web/drizzle/0001`、`0002`。text 欄位一律 `COLLATE "C"`；JSON、時間與 0/1 旗標照 SQLite 存 text／integer，切換回滾窗口（D6）結束後再評估改型別。6 個 trigger 之外，兩張必須保留的表另擋 `TRUNCATE`（Postgres 的 TRUNCATE 不經過逐列 DELETE trigger）。
    - 4b：Python 值模型與序列化在 `web/src/platform/py/`；模組在 `web/src/modules/{discovery,legacy,preferences,collection,applications}`，跨模組只經 `public.ts`（dependency-cruiser 擋）。寫入交易先取 advisory lock，等同 Python 的 `BEGIN IMMEDIATE` 單一寫入者；必要條件是收案、分組回饋與 token 檢查都是「讀、比對、再寫」。
    - 對照基準：`web/tests/fixtures/gen_golden.py` 用真的 Python 函式產生 `golden.json`（evaluate、recommendation、fromisoformat、格式化、8 個 store 情境含資料表原始位元組）。切換前 Python 是規格：改 Python 規則時要重跑產生器。
    - 4c：收斂腳本 `web/src/ops/converge.ts`（`pnpm converge`，先清空再全量載入，`--confirm-drop` 必須寫出目標 host）；一致快照 `web/scripts/snapshot.ts`（SQLite backup API，唯讀開啟、目標必須是新檔、保留 7 天）；VM 端檔案 `deploy/shadow.Dockerfile`、`deploy/compose.shadow.yaml`、`deploy/systemd/freelance-shadow-{morning,after}.{service,timer}`。timer 設 `Persistent=false`：漏跑的 08:30 不補，否則起點會晚於 Python 執行。尚未部署到 VM。
    - 4d：比對器 `web/src/ops/compare.ts`（`pnpm compare`）。差異分三類：timing（來源列只有一邊有）、user_action（只在正式環境的人工操作，shadow 不重播）、logic（其餘，含兩邊都改但內容不同、刪除）；揮發欄位（牆鐘時間、隨機 id）不比。
    - 1c 正式副本驗證用 `web/scripts/verify-fingerprints.ts`，在 VM 容器內對副本執行，只印通過數。
    - VM 部署（2026-10-24，Will 授權）：checkout `/opt/freelance-shadow`（獨立於 Python release），映像 `freelance-agent-shadow:<commit>`，副本與報告在 `/var/lib/freelance-shadow`（996:987、0700），連線字串在 `/etc/freelance-agent/shadow.env`（root 0600），timer 參數在 `/etc/freelance-agent/shadow-compose.env`。Neon shadow branch `br-still-mouse-b8vft0vp`。回滾：`systemctl disable --now freelance-shadow-morning.timer`，刪 `/etc/systemd/system/freelance-shadow-*`、`/opt/freelance-shadow`、`/var/lib/freelance-shadow` 與映像。
    - 設計審查（2026-10-24，獨立 subagent）7 項：改 2 項——寫入交易加 `lock_timeout 5s`（同 Python 的 5 秒）與 `idle_in_transaction_session_timeout`，有測試；`discovery/service.ts` 移到 `web/src/services/discovery.ts`，消除 discovery↔legacy／collection 的模組循環，dependency-cruiser 規則 `discovery-is-a-leaf` 守住。記 5 項，處置寫在步驟 5、11、13、14。
    - 已知、接受的比對差異：分組順序（盤點缺陷 21，Python 端受 hash seed 影響）；`sourcesIn` 對目錄外來源列依名稱排序（Python 依 SQLite rowid），只影響已退役來源的顯示順序。

- [ ] **5. TS 端排程骨架（shadow 部署）**（被擋於：步驟 4、D2、D5）
  - 實作狀態（2026-10-24，Will 授權部署）：`199bef1` 起正式專案部署（alias `freelance-agent-sigma.vercel.app`，Protection 未登入 302）；production env 只有 `DATABASE_URL`（shadow pooled）、`CRON_SECRET`、`DIGEST_RECIPIENT`、`PORTFOLIO_CATEGORY_PROJECTS`。來源啟用寫在程式（`web/src/modules/collection/registry.ts`），不放 `discovery_settings`：shadow 每天早上被正式副本覆蓋，Python 的設定契約也不收額外 key。手動觸發（01:17）回 `not due before 09:00 Asia/Taipei`，shadow 沒有寫入。
  - 自然執行驗收（2026-10-24）：VM morning 08:31 結束、`converge ok`，報告 `converge-2026-10-24.json` 為 `ok: true`；shadow `daily_runs` 的 10-24 只有一列（09:14 開始、`complete`、`sources_ok`，毫秒時間戳與無 `intent_id` 是 TS 寫的格式），12:33 再查未變；12:00 那班 12:53 才觸發，dashboard Runtime Logs 有 `daily run 2026-10-24: 已有 run`。Hobby 方案的 cron 在排定的那個小時內任一時間觸發（量到 09:14、12:53），所以「09:00 後」的比對與查 log 要排在該小時結束之後。`vercel logs` CLI 在 12:33 查不到 09:14 那次的 log（未查原因）；要看 log 用 dashboard。
  - Neon 傳輸量（量到）：一次 `list`／分組回饋讀約 8.1 MB（`opportunities.item` 2,226 筆 8,113,212 位元組）。Neon 免費方案每月 5 GB，超過會暫停 compute 到下個週期；300 次就到一半。shadow 期每日 VM 收斂回讀＋比對約 46 MB（推論）。
  - 範圍：
    - 依 D5 設定 cron。
    - 入口先做 `daily_runs` claim，重複觸發時第二次直接返回。
    - fan-out 到各來源的 step（2026-10-24 改為依序執行，見步驟 8「寫入鎖與 fan-out」）。
    - 來源 registry 與啟用規則：沿用 `source_catalog.py` 的來源清單與優先序，加上 `discovery_settings` 的啟用開關；ptt_soho、ptt_codejob 標為停用（D12）。
    - 第一次部署 Vercel 正式專案，DB 指向 shadow branch，env 不含寄送憑證。
  - 驗收：
    - 同一天手動觸發兩次 cron，`daily_runs` 只有一列，第二次的 log 顯示「已有 run」。
    - `vercel env ls production` 的 key 名稱都在全域約束的白名單內（D14 起允許 `RESEND_API_KEY`、`RESEND_INBOX`），不含 SMTP 相關的 key。
    - mutation：拿掉 claim，「重複觸發只跑一次」的測試要失敗。
    - Vercel env 加 `PORTFOLIO_CATEGORY_PROJECTS`（私人作品對應，盤點缺陷 22；非憑證但不進 repo）。
    - 量 Neon 傳輸量：一次 `list` 與一次分組回饋各傳多少位元組，換算每月用量（步驟 14「listIn」項的觸發條件用這個數字）。
  - 需要人做的事：授權第一次正式專案部署與 cron。
  - 回滾：在專案設定 Disable Cron Jobs，刪除正式專案。

- [ ] **6. 試點：Jobicy／Remotive**（被擋於：步驟 5）
  - 開始時啟用 VM 的 `freelance-shadow-after.timer`（10:30 比對）。步驟 5 的 TS 只寫 `daily_runs`、還沒有任何來源，比對只會把 Python 當天的寫入全報成差異。
  - 實作狀態（2026-10-24，未部署）：`web/src/modules/collection/sources/free-jobs.ts`，`registry.ts` 已登記 jobicy、remotive。描述的 HTML 轉文字照 CPython 3.13.15 `html.parser` 逐行移植成 `web/src/platform/py/html.ts`，不用 htmlparser2／parse5：描述進 receipt 雜湊與指紋，tokenizer 不同就會讓每筆 receipt 都不同（盤點原本寫 parse5，這裡改掉）。另補 `pyLower`（`str.lower` 含 Final_Sigma；Node 的 ICU 是 Unicode 17，CPython 是 15.1）與 `platform/http.ts`（不跟 redirect、8 MB 上限、`json.loads(bytes)` 的編碼偵測）。對齊正式映像時發現 `fromisoformat`（零秒偏移帶微秒）、`urlsplit`（大寫 `V` 的 IPvFuture）在 3.13.13 與 3.13.15 不同，一併改成 3.13.15；本機 `backend/.venv` 改用 3.13.15，`gen_golden.py` 不是這個版本就拒跑。
    - 驗證（本機）：golden 新增 98 個 HTML 片段與 96 個 normalize 案例（Python 3.13.15 產生），TS 全同；2026-10-24 抓的真實 feed 209 筆（Remotive＋Jobicy）兩邊 normalize 輸出逐位元組相同；6 個 Python 測試案例的 TS 版通過；`pnpm typecheck`、`boundaries`、`test`（97）、`build`，backend 629 個測試全綠。mutation：註解改回 3.13.13 的關閉順序、`pyLower` 換成 `toLowerCase`、receipt 改 `ensure_ascii=False`、正規化與寫入交錯、不對屬性值做 unescape（超過 4300 位數的 charref 在 Python 會讓整個來源失敗），各自讓測試失敗。獨立審查：正確性 subagent 差分模糊測試（HTML 285,000、unescape 45,000、normalize 80,000 組）只找到屬性值那一項，已修；設計審查 6 項，改 4（移到 `sources/`、`public.ts` 只匯出 `syncFreeJobs`、html 表直接寫到 `web/`、此處記錄）、記 2（步驟 10 的 `source_details`、步驟 14 的 `html.ts` 去向），正式映像釘版本由 Will 決定釘 3.13.15（盤點缺陷 24）。
    - 部署（2026-10-24 13:0x，Will 授權）：`ea55963` 部署到正式專案（`freelance-agent-ev0or1o5n`，alias 不變）；`vercel env ls production` 仍是同樣 4 個 key、`/api/cron` 未登入 302。VM `freelance-shadow-after.timer` 已 enable，第一次 10-25 10:30。
    - 比對範圍（2026-10-24 補）：比對器 v1 比全部資料表，TS 只跑兩個來源時每天都會有其他來源與 `daily_runs`／`digest_outbox` 的邏輯差異，驗收無從判讀。`compareShadow` 加 `scope`：有 `source` 欄的表只比範圍內來源，沒有 `source` 欄的 run 表（`daily_runs`、`digest_outbox`）先不比；範圍外的變動列在 `outOfScope` 計數，不靜默丟掉。`scripts/compare.ts` 的範圍取 `enabledSources()`（跟 TS 排程同一份清單），`--all-sources` 比全部。2026-10-25 改：範圍改讀當天 TS run 自己記下的來源（shadow `daily_runs.result.source_details` 的 key，`ranSources`），不再從比對器映像裡的程式拿；當天沒有唯一一列、狀態不是 complete／failed（例如 Hobby cron 晚觸發、10:30 還沒跑完）或沒有來源時報錯，不當成空範圍。理由：映像裡 import 清單時，每次換範圍都要重建 VM 映像，Vercel 與 VM 版本不一致時範圍會悄悄錯；業界比對器（GitHub Scientist、Diffy）也以實際執行為範圍。之後擴大範圍只要部署 Vercel。測試 `ops.test.ts`「takes the scope from the day's finished TS run」。測試 `ops.test.ts`「compares only the sources in scope」；mutation 把範圍篩選拿掉，該測試失敗。
    - 真實資料演練（2026-10-24，本機可拋棄 Postgres，資料用完即刪）：08:30 副本載入後跑 TS 的 Jobicy／Remotive，與 13:13 的正式副本（Python 當天已跑）比對。範圍內：logic 0、timing 0，opportunities 3／3、source_receipts 3／3 相同；範圍外 opportunities 65、source_receipts 65、mail 21、run 表 3 筆列為 out of scope。沒設 `PORTFOLIO_CATEGORY_PROJECTS` 時 4 筆 opportunity 只差 `portfolio_ids`（合成值），設了就 0，與步驟 4 的盤點缺陷 22 一致。
    - receipt mutation（同一套演練，量到）：receipt 改成 `source:id:x<hash>`，比對器報 3 筆 logic（Jobicy 新職缺的 opportunity，因為 `job.receipt_id` 在 item 裡），receipt 本身一邊有的列仍歸 timing。弱點：當天沒有新職缺、只有重看到的舊職缺時，receipt 規則壞掉只會出現 timing，不會被報出。7 天比對時同時看 source_receipts 的 timing 筆數；要補時的做法是 receipt 改用 `source:id` 當比對 key，雜湊不同就算 different。
    - VM shadow（2026-10-24 13:5x）：`/opt/freelance-shadow` checkout `afa8b10`，`SHADOW_IMAGE=freelance-agent-shadow:afa8b10`（回滾改回 `:13d991c`）；映像內 `enabledSources()` 為 jobicy、remotive。
    - 7 天比對（VM `compare-<日期>.json`，`journalctl -u freelance-shadow-after.service`；source_receipts 的 timing 筆數照上面 receipt mutation 的弱點一起記）：
      - 第 1 天 2026-10-25（10:30:36 報告，exit 0）：範圍 jobicy、remotive；logic 0、timing 0、user_action 0；opportunities 3／3、source_receipts 3／3 相同（source_receipts timing 0）；範圍外 opportunities 101、source_receipts 101、source_health 2、digest_outbox 1、daily_runs 2、mail_sync_state 6、mail_ingestion 10。
    - 範圍擴大（2026-10-25 13:0x，Will 授權提前部署，不等 7 天比對）：步驟 7 與步驟 8 第 1–3 批一起排程，`920b6b4` 部署到正式專案（`freelance-agent-4yenxxd50`，alias 不變；env 仍同樣 4 個 key、`/api/cron` 未登入 302）；VM `/opt/freelance-shadow` checkout `920b6b4`，`SHADOW_IMAGE=freelance-agent-shadow:920b6b4`（回滾改回 `:afa8b10`），映像內 `enabledSources()` 為 16 個來源。所以第 2 天起的比對範圍是 16 個來源，不只 jobicy、remotive；步驟 6 的 7 天比對與步驟 7、8 的比對從同一天起算。這次部署一起帶上依序執行的 fan-out（`eb434e3`）。
    - 最後一批部署（2026-10-25 16:3x，Will 授權）：`82cd89d`（CI 綠燈）部署到正式專案（`freelance-agent-cmpwe77c1`，alias 不變；env 仍同樣 4 個 key、`/api/cron` 未登入 302）；VM `/opt/freelance-shadow` checkout `82cd89d`，`SHADOW_IMAGE=freelance-agent-shadow:82cd89d`（回滾改回 `:920b6b4`）。映像內 `enabledSources()` 19 個（實測），比對器範圍改讀 TS run：用映像對 10-25 的副本另跑一次（報告寫到容器暫存，不覆蓋正式報告），讀出範圍 `jobicy, remotive`，就是當天 TS 實際跑的來源，logic 0、timing 0，和第 1 天報告相同。10-26 起 TS 跑 19 個來源，最後一批的 3 天比對從 10-26 起算。
    - 未跑：7 天比對第 2–7 天（10-26 至 10-31）。
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
  - 實作狀態（2026-10-24；2026-10-25 部署，見步驟 6「範圍擴大」）：`web/src/modules/collection/sources/cryptojobslist.ts`，`registry.ts` 的 `RUNNERS` 已登記；排程要等部署時把它加進 `SCHEDULED`（見步驟 8「排程開關」），VM 比對器範圍跟著 `enabledSources()`，換映像時一起生效。共用件：
    - `platform/py/xml.ts`：`ElementTree.fromstring(bytes)` 與 find／findall／findtext，建在 `saxes`（嚴格 XML 1.0＋namespace 解析器），不用盤點推測的 fast-xml-parser：expat 嚴格、fast-xml-parser 寬鬆，同一份壞 feed 會一邊整個來源失敗、一邊成功。編碼照 expat：BOM、宣告編碼（UTF-8、US-ASCII、ISO-8859-1；BOM 與宣告不符報錯）；pyexpat 另接受的單位元組 codec（如 cp1252）TS 報錯，現有 XML 來源都送 UTF-8。後續步驟 8 的 4 個 XML 來源（community_jobs、nodesk、taiwanjobs、public_feeds）共用。
    - `platform/py/email.ts`：`email.utils.parsedate_to_datetime` 逐行移植；`unicode.ts` 補 `int(str)`（Unicode 十進位數字、底線、4300 位上限）、`str.isdigit`、`str.splitlines`、`str.upper` 的 ASCII 結果；`re.ts` 補 `\b`（Unicode 字元類）與 IGNORECASE（`i`／`k`／`s` 也配 `İ`、`ı`、`K`、`ſ`）。表由 `spike-1c/gen_expected.py` 以 3.13.15 產生。
    - `html.ts` 的 `htmlFeed` 加 `close`（goahead(1)）並把屬性交給 starttag；`text`、`published` 現在在 `sources/text.ts`（步驟 8 第 2 批移入，各來源共用）。
    - 交易邊界：`sourceBatch` 一個交易包住 existing ids、全部 ingest 與最終 health，與 Python 的 `store.source_batch` 相同；開頭的 health=failed 由 `runSource` 另一個交易先寫。
    - 來源結果：`runSource` 改回傳 `ok | partial | waiting | failed`（`SourceOutcome`），照 `collection/service.py` 只有 ok、waiting 算成功。原本只看有沒有拋例外，CryptoJobsList 有被拒的單筆時回 `partial`，當天 run 會被記成 `complete`，Python 是 `failed`；比對器又不比 `daily_runs`，所以不會被發現。測試 `daily.test.ts`「treats a partial source as a failed day」；mutation 讓 `runSource` 一律回 ok，該測試失敗。
    - 差分模糊測試（獨立 subagent，約 30 萬組，另對全部 1,112,064 個 code point 窮舉字元表）：7 類差異，真實 feed 一類都不觸發。改 2：
      - `fromisoformat` 的小數點檢查順序（步驟 4 的 `datetime.ts`，free_jobs 也用）：`07:50:03.+00:00` 這種「小數點後沒有數字」3.13.15 判無效，TS 原本接受；年份下溢時還會從單筆被拒變成整個來源失敗。照 3.13.15 C 原始碼修，golden 加 7 個案例；mutation 改回舊順序，golden 失敗。
      - `xml.ts` 強制照 XML 1.0 解析（saxes 原本遵守 `version="1.1"`，把 NEL 當換行）。
      - 記 5（LOW，寫在 `xml.ts` 開頭）：非 ASCII 元素名稱的字元表版本、命名空間 URI 的 trim 與 `}`、單位元組 codec、無 BOM 的 UTF-16、UTF-8 BOM 後宣告 latin-1；另有一類只是例外類別不同（兩邊都失敗）。
    - 設計審查（獨立 subagent）7 項：改 4（上面的來源結果；Python 例外繼承集中到 `platform/errors.ts` 的 `pyIsInstance`；`gen_expected.py` 直接寫 web/ 的 `unicode-tables.json`；`public.ts` 不匯出 `syncCryptoJobsList`）、記 2（步驟 14 的照抄去向、步驟 8 的共用件）、提 1（寫入鎖與平行 fan-out，Will 決定改依序執行，見步驟 8）。
  - 驗證（本機）：golden 新增 RSS 解析 123 份、`text` 127、`parsedate_to_datetime` 63、`published` 63、`int` 26（Python 3.13.15 產生），TS 全同；2026-10-24 抓的真實 feed（100 筆）兩邊 parse 輸出逐位元組相同（當天 0 筆符合收案條件）；Python 4 個測試案例的 TS 版通過；整批失敗不寫入的測試通過。mutation：改成每筆各自一個交易，該測試失敗（`expected 1 to be +0`）。另一種寫法「在批次交易外逐筆寫入」會卡在全域寫入鎖而整體失敗，測不出交易邊界，所以不採用。

- [ ] **8. 其餘免登入來源（API、RSS、HTML；正式啟用、扣除試點的那些，清單以附件 §1.1 為準）**（被擋於：步驟 7）
  - 範圍：由小到大分批改寫，每批不超過 5 個來源，每批 shadow 跑滿 3 天比對。Freelancer、Arbeitnow 這類有分頁上限、時間上限或 partial 映射的來源最後做。
  - 共用件要補（2026-10-24 步驟 7 設計審查，讀 Python 得出）：
    - `platform/py/xml.ts` 目前只有 bytes 入口、元素沒有屬性與 tail。nodesk（`nodesk.py:30`）、public_feeds（`:172`）、taiwanjobs（`:30`）先 decode 再 `fromstring(str)`，要補 str 入口（str 輸入時 expat 對宣告編碼的處理要另外量）；community_jobs 讀 `get('href')`／`get('rel')`（`:64`），taiwanjobs 讀 `attrib`、`len(child)`（`:43,46`），要補屬性與子元素數。
    - `xml.ts` 不接受 pyexpat 另外支援的單位元組 codec（如 cp1252）。觸發：比對器或 source_health 出現「TS 失敗、Python 成功」且原因是編碼，就補上該 codec。
    - `re.ts` 的 `wordsIgnoreCase` 只涵蓋「單字邊界＋備選字」；`public_feeds.py:138-147` 用到 `\s`、`findall`、`sub`，要更通用的轉譯，同樣以 3.13.15 產生字元表。
  - 寫入鎖與 fan-out（2026-10-24 步驟 7 設計審查；同日 Will 決定改依序執行）：`sourceBatch` 照 Python 用一個交易包住整批寫入，全程握 `writeTransaction` 的全域 advisory lock（`lock_timeout` 5 秒）；Python 依序跑來源（`collection/service.py:10-20`），TS 的 workflow 平行 fan-out（`workflows/daily.ts`）。一個大批次握鎖超過 5 秒，同時在跑的其他來源寫入就會失敗。shadow 現況（量到）：freelancer 1,579 筆、jobicy 53、remotive 4、cryptojobslist 1、taiwanjobs 1，所以步驟 7 不受影響。（更正 2026-10-25：Freelancer 不用 `sourceBatch`，逐筆各開一個交易，不會長時間握鎖；依序執行後這個顧慮已消失，見最後一批的「記」。）
    - 已改：`workflows/in-order.ts` 的 `syncInOrder` 一個來源跑完才跑下一個（每個來源仍是獨立 step，失敗的來源記 failed、後面照跑），和 Python 相同，鎖衝突從結構上消失。代價是每日 run 的總時間變成各來源時間相加（未量）。測試 `daily.test.ts`「runs sources one at a time」量同時執行數；mutation 改回 `Promise.allSettled`，測試失敗。helper 放在不依賴 Node 模組的獨立檔，因為 workflow 函式不能引用會帶入 `pg` 的模組（build 量到）。尚未部署，隨步驟 7 一起上。
  - 排程開關（2026-10-25）：`registry.ts` 的 `RUNNERS` 收全部已移植的來源，排程只跑 `SCHEDULED` 清單（`enabledSources()`，VM 比對器範圍同一份）；2026-10-25 起是 jobicy、remotive、步驟 7 與步驟 8 第 1–3 批共 16 個（Will 授權提前部署，不等步驟 6 的 7 天比對），也就是已授權部署的那些。原本步驟 7 的 cryptojobslist 直接登記就會排程，步驟 6 比對期間若為別的原因部署 main，它會提前啟動；改成部署哪一批就在那個 commit 把它加進 `SCHEDULED`。測試 `daily.test.ts`「fans out only to implemented, enabled sources」。`SCHEDULED` 是 release toggle（只在上線過渡期存在的開關，Fowler／Hodgson 分類），留在程式裡是業界常見做法；改成環境變數一樣要授權重新部署，沒有好處（2026-10-25 設計簡報，Will 同意）。到期：`SCHEDULED` 等於 `RUNNERS` 扣 `DISABLED` 時刪掉它與 `enabledSources` 的 `scheduled` 參數（見步驟 14）。
  - 批次（2026-10-25 定）：第 1 批 himalayas、hackernews、v2ex；getonboard 程式已完成，但它有分頁上限、時間上限與 partial 映射，照本步驟的排序併入後面那批（與 freelancer、arbeitnow 同類）。
  - 第 1 批實作狀態（2026-10-25；同日排程並部署，見步驟 6「範圍擴大」）：`sources/himalayas.ts`、`getonboard.ts`、`community-jobs.ts`（hackernews、v2ex）。共用件：
    - `re.ts` 的 `translate`／`pyRe`／`pyFullmatch`：Python str pattern 的子集（`\b`、`\s`、`\d`、`\w` 用 unicodedata 15.1 的表、`.` 不配 `\n`、`$` 可配結尾換行、IGNORECASE 的 ASCII 字母含 `İ ı K ſ`）；不支援的語法在載入時拋錯，不會默默配錯。步驟 8 後面的 public_feeds 也用。
    - `unicode.ts` 的 `pyFloat`（`float(str)`）、`pyIntToFloat`；`datetime.ts` 的 `fromTimestamp` 錯誤型別照 CPython（time_t 外 OverflowError、tm_year 放不下 OSError、其餘年份 ValueError；Linux `python:3.13.15-slim` 與 macOS 量到相同），加 `fromTimestampValue`（bool 當 int）。getonboard 逐筆只接 ValueError／TypeError／AttributeError／OverflowError，OSError 會讓整個 fetch 失敗，所以類別要對。
    - `url.ts` 的 `urlsplitValue`（自 free-jobs.ts 移入）；`value.ts` 的 `pyGet`／`pySubscript`（四個來源共用）；`xml.ts` 的元素屬性 `attrib`／`xmlGet`（ElementTree 的鍵名：無前綴用 local、有前綴用 `{uri}local`、不含 xmlns 宣告）；deadline 用 `performance.now()`。
    - 差分測試找到、已修：`xml.ts` 第二個 BOM（expat 判 not well-formed，原本 TextDecoder 與 saxes 各會再吃掉一個）；`json.ts` 的 `loads` 補 4300 位整數上限（Python 整份文件失敗，原本 TS 成功）。
  - 第 1 批驗證（本機，2026-10-25）：golden 新增 float 59、fromtimestamp 32、regex 3,744 組、ElementTree 屬性 8、himalayas normalize 105／fetch 17、getonboard normalize 79／fetch 30、hn_job 140、v2ex 66、HN fetch 33（Python 3.13.15 產生），TS 全同；2026-10-24 23:0x 實抓的回應（himalayas 8 個、getonboard 3 個、HN 207 個、v2ex 1 個）餵給兩邊，輸出逐位元組相同（60、196、16、14 筆）；Python store 案例的 TS 版 9 個通過；`pnpm typecheck`、`boundaries`、`test`（140）、`build`，backend 629 個測試全綠。mutation：`\b` 改 JS 原生、`.` 改 JS 原生、`$` 改 JS 原生、拿掉 float 底線檢查、拿掉 OSError、taxonomy 的 `total_pages` 改嚴格相等、分頁 `>=` 改 `>`、時區 8 改 9、標題改 UTF-16 切、屬性不排除 xmlns、v2ex 拿掉 90 天、HN 拿掉 `[:2]`、getonboard 的 partial 不看 truncated，各自讓測試失敗。
  - 獨立審查：差分模糊測試（subagent，6 個 seed）regex 約 290 萬組加全 code point 掃描約 1.33 億次判斷、float 48.6 萬、fromtimestamp 24.3 萬、三個 normalize 各 12 萬、v2ex 6.5 萬：0 筆行為差異，另找到上面已修的 2 類。設計審查 8 項：改 4（排程開關、共用 helper 與單調時鐘、getonboard 移到後面的批次、本段與步驟 14 的紀錄）、記 3（下面三條）、駁回 1：「`mapPool` 第一個失敗時其餘請求沒取消」——Python 的 `with ThreadPoolExecutor` 離開時 `shutdown(wait=True)`，已送出的請求同樣會跑完，請求量相同。
    - 記：golden 在每個函式都比 Python 例外類別，逼 TS 仿出外面看不到的類別。後面的來源只在呼叫端依類別分支的地方比類別（像 getonboard 逐筆的 catch），其餘只比成功或失敗；已寫好的保留。
    - 記：himalayas 照 Python 沒有整體 deadline，最壞約 8×25 秒＋4.8 秒≈205 秒，再加最多 160 筆 ingest（推論，未量）。加整體 deadline 會讓 Python 成功的慢速情況在 TS 失敗，所以切換前不加。觸發：shadow 上 himalayas 單次超過 150 秒，或步驟 8 停止條件的 300 秒有風險時，交 Will 決定。
  - 第 2 批（2026-10-25 定）：public_feeds 的 remoteok、realworkfromanywhere、weworkremotely、workingnomads。實作狀態（2026-10-25 排程並部署）：`sources/public-feeds.ts`；`public_feeds.parse`（每筆都要合法的嚴格版）沒有正式呼叫端，不移植。共用件：
    - 觸發已執行：`sources/text.ts` 收 `htmlText`（free_jobs.Text）、`text`、`published`（public_feeds），5 個來源改從這裡 import，來源之間不互相 import。
    - `xml.ts` 的 `xmlFromString`：Python 把 str 交給 `fromstring` 時，pyexpat 送 UTF-8 並強制 UTF-8，宣告的編碼不論寫什麼都忽略（3.13.15 量到：ISO-8859-1、UTF-16、cp1252、bogus 都照樣 parse），只跳過一個 BOM。parser 另加 doctype 後備檢查：所有呼叫端都先擋 DOCTYPE／ENTITY，所以不改變任何結果，只是漏擋時不會讀 DTD（設計審查 A1）。
    - `re.ts`：lookahead `(?=`／`(?!`、`\n \t \r \f \v`、dotAll（re.S），以及 `pyFindall`／`pySub`／`pyReSplit`。三個 helper 遇到空匹配就丟錯，因為 Python 3.7 起的空匹配推進規則和 JS 不同。觸發：第一個可能配到空字串的 pattern 被移植時，實作 Python 的規則（設計審查 C2；現有 10 個 pattern 都至少吃一個字元，讀碼判斷）。
    - `platform/py/codecs.ts` 的 `decodeStrict`（`bytes.decode` strict，UnicodeDecodeError）：public-feeds、`xml.ts`、`http.ts` 共用，原本是三份 TextDecoder（設計審查 B2）。nodesk 的 `utf-8` 和 taiwanjobs 的 `utf-8-sig` 之後也用這個。
  - 第 2 批驗證（本機，2026-10-25）：golden 新增 normalize 133（只分「單筆拒絕／其他類別」，照第 1 批記下的規則）、整份 feed 66（只比成敗）、regex 1,672 組（search、findall、sub、split；測試解析到正式碼的 regex 物件，flag 寫錯就對不上）、str 版 XML 15，Python 3.13.15 產生，TS 全同。lone surrogate 寫不進 golden.json，另以單元測試確認 TS 也是單筆拒絕（Python 是 UnicodeEncodeError，屬 ValueError）。2026-10-25 01:47 實抓的 4 份回應（remoteok 99、workingnomads 40、realworkfromanywhere 117、weworkremotely 95 筆）餵給兩邊，輸出逐位元組相同。Python store 案例的 TS 版 14 個通過；`pnpm typecheck`、`boundaries`、`test`（162）、`build`，backend 629 個測試全綠。mutation：`> 200` 改 `>=`、partial 不寫 failed、拿掉 `&amp;` 修補、拿掉 re.S、逐筆 catch 多收 OverflowError、isdigit 改 ASCII、拿掉 legal 列跳過、拿掉 smart contract 移除、90 天改 900 天、str 版不跳 BOM、`\n` 改空白、拿掉 doctype 後備檢查、lookahead 改非捕獲群組，各自讓測試失敗。netloc 的 `pyLower` 改 JS `toLowerCase` 測試照過，判定為等價：主機只和 ASCII 比，Unicode 15.1 到 17 之間沒有新增小寫成 ASCII 的對應（推論）。
  - 第 2 批設計審查（獨立 subagent）5 項：改 3（regex 測試改成驗正式碼的物件；這次 mutation 證實原本拿掉 re.S 會漏，另補多行 CDATA 語料；`decodeStrict` 收進 platform；`xml.ts` 的 doctype 後備檢查）、記 2（照抄進步驟 14、空匹配的觸發條件）。審查者另建議把 `pyRe` 的布林位置參數改成具名 flags，不改：flag 寫錯現在已由正式物件比對擋下，改簽名會動到第 1 批的呼叫端，卻沒有多擋到任何東西。
  - 第 3 批（2026-10-25 定）：nodesk、justremote、dynamitejobs、jobbank518、chickpt，同為「列表＋JobPosting 詳情頁」。taiwanjobs 和它們的差別只有：有 rejected 時不呼叫 `finish`（health 留在 failed）、45 秒與 8 MB 上限、逐塊讀；逐塊讀已由本批的 `urlopenRead` 提供，所以它沒有延後的技術理由，只因本批已滿 5 個而排進下一批（剩下的最後一批：taiwanjobs、getonboard（程式已完成）、arbeitnow、freelancer）。實作狀態（2026-10-25 排程並部署）：5 個都在 `RUNNERS` 與 `SCHEDULED`。共用件：
    - `sources/job-pages.ts`：nodesk.Metadata（`jobPostings`）、各 fetch 內的 read()（`pageReader`：deadline、`raiseForUrllibStatus`、其他 2xx 是 ValueError、網路錯誤是 OSError、2 MB 與讀完後的 deadline 檢查）、`pageText` 的存取挑戰檢查、employmentType→kind、`canonicalOn`（urljoin＋host＋路徑 fullmatch）、詳情頁失敗分類 `rejectsDetail`（挑戰頁與 401／403／429 中止整個 fetch）。Python 裡這些散在 nodesk、ptt_soho、public_feeds 與各來源，TS 收成一份，來源之間不互相 import。
    - `platform/http.ts`：`urlopenRead` 照 urllib 加 `ptt_soho.read_body` 的時間模型（標頭等 min(10 秒, 剩餘)、每塊等 min(8 秒, 剩餘)、整個讀取到來源 deadline 為止、超過上限停下），`raiseForUrllibStatus` 照 urllib 加 NoRedirect 的狀態語意（redirect 是 ValueError、非 2xx 是 `HttpError`，OSError 子類）。前幾批的 `getCapped` 是對整個請求一個上限，一個來源只打一次時可以接受；本批每個來源最多讀 200 頁，所以改用逐塊等待（設計審查 A1）。taiwanjobs、arbeitnow、freelancer 移植時用同一份。不送 `Accept-Encoding: identity`：Python 送它是因為 urllib 不會解壓縮，fetch 會協商壓縮並解壓，2 MB 上限量的仍是頁面本身（設計審查 A3）。
    - Python 行為照抄：`url.ts` 的 `urljoin`（與 `urlsplit` 的預設 scheme）；`unicode.ts` 的 `pyUpper`，`upper` 表由 `gen_expected.py` 以 3.13.15 產生（Node 的 ICU 有 55 個 code point 的 upper 和 15.1 不同，量到；nodesk 的 employment_types 進 receipt 雜湊）；`json.ts` 的 `rawDecode`（justremote 的 preloaded state）；`datetime.ts` 的 `dateFromIsoformat`（jobbank518）；`re.ts` 的 `\Z` 與 `pyMatch`；`errors.ts` 的繼承表加 JSONDecodeError、KeyError、TimeoutError、URLError、HTTPError、AccessBlocked。`text.ts` 匯出 `visibleParts`（public_feeds.Text 的 parts，jobbank518 用 `'\n'.join`）。
    - 實抓觀察（2026-10-25，量到）：11:0x Python 的一次 dynamitejobs fetch 在 90 秒內試了 17 頁、7 頁逾時、3 頁因 deadline 沒讀（truncated）；11:5x TS（`urlopenRead`，有壓縮）同一來源 20 頁全讀、20 秒。兩次不同時間，分不出是站況還是壓縮（未量）。shadow 期這會讓兩邊的 dynamitejobs 健康狀態不同；比對器不比 source_health，opportunities 的差異會歸 timing。單一來源仍受 90 秒上限，不碰停止條件的 300 秒，依序執行的每日 run 總時間最多多 90 秒。jobbank518 的索引頁有一段 ld+json 含非法控制字元，`json.loads` 失敗使整個來源 failed，正式 `source_health` 也是 failed，TS 在同一處失敗；已在兩邊一起修，見下方「jobbank518 索引頁修正」。
  - 第 3 批驗證（本機，2026-10-25）：golden 新增 urljoin 408、canonical 330、upper 38、raw_decode 20、date.fromisoformat 21、regex 580、nodesk feed 36／頁面 62、justremote 列表 32／頁面 35、dynamitejobs 列表 21／頁面 36、jobbank518 列表 16／頁面 40／日期 25、chickpt 列表 29／頁面 34、五個 fetch 對 27 組回應（含 redirect、4xx／5xx、網路失敗；Python 3.13.15 產生），TS 全同；`urlopenRead` 對本機 HTTP server 的 6 個案例（慢速但每塊在時限內、停住、deadline、上限、狀態碼、連不上）。實抓回應餵給兩邊：nodesk 11、justremote 17、dynamitejobs 11 個回應在本機抓；jobbank518、chickpt 在本機 Python 的 TLS 驗證失敗（`Missing Subject Key Identifier`，本機 CA／OpenSSL 環境），改在正式映像 `freelance-agent-backend:d994cd2` 以 `docker run --rm` 抓（正式映像同樣開 `VERIFY_X509_STRICT`，兩站回 200）；輸出逐位元組相同（10、16、10、4 筆；jobbank518 兩邊都在 JSON 解析失敗），差異只有實抓時的逾時與 chickpt 的 `received_at`。Python 測試案例的 TS 版：store 17 個、parse／fetch 20 個；TS 版對真實站連網：nodesk 10、chickpt 4、dynamitejobs 20 筆。`pnpm typecheck`、`boundaries`、`test`（224）、`build`，backend 629 個測試全綠。mutation 25 項各自讓測試失敗：`urlopenRead` 只用一個計時器、停住的讀取不是 OSError、kind 的 full-time 優先、401／403／429 不中止、挑戰頁不中止、`pyUpper` 換 JS `toUpperCase`（第一輪存活，補 Node 與 15.1 不同的 code point 後失敗）、nodesk deadline 不計剩餘頁、nodesk partial 寫 ok、justremote 改用 `JSON.parse`、justremote 對空的 validThrough 做解析、justremote 允許 permanent 配 contract、dynamitejobs 的 truncated 改看成功數、dynamitejobs 保留空的 validThrough、dynamitejobs 忽略沒有值的 href、jobbank518 日期一律走 published、jobbank518 拿掉軟體類別篩選、chickpt 範圍上限、chickpt endtag 多留一層、chickpt 空 class 不報錯、chickpt truncated 不看回報總數、chickpt 詳情頁收 AttributeError、urljoin 不濾空段、rawDecode 跳過開頭空白、JSONDecodeError 不是 ValueError、`\Z` 改成 Python 的 `$`（第一輪存活：用到 `\Z` 的地方都在 fullmatch 內，讀碼判定等價，另補直接測 `\Z` 的單元測試）。
  - jobbank518 索引頁修正（2026-10-25，Python 與 TS 一起改）：`parse_index` 只用標題與連結，卻在 `Page` 解析時對每段 ld+json 做 `json.loads`，所以索引頁上一段無關的壞 JSON（實抓：非法控制字元，第 74 行第 81 欄）就讓整個來源 failed。改成 `Page` 只收原文，`postings()` 只在 `parse_article` 解析；詳情頁行為不變（壞 JSON 那篇算 rejected，來源 partial）。其他來源不同處理：nodesk 的 ld+json 只在詳情頁解析；justremote 的 preloaded state 就是列表資料本身，失敗代表沒有資料，整頁失敗是對的。驗證：Python 新案例拿掉修正會失敗；golden 新增索引頁與詳情頁各 4 種壞 ld+json（`jobbank518_index` 20、`jobbank518_article` 44），TS 拿掉修正 `parse_index` 失敗；實抓索引頁與 2 篇詳情頁（本機 curl），舊 Python 重現同一個 `JSONDecodeError`，新版兩邊輸出逐位元組相同（2 個連結、2 篇）。
    - Python 上 VM（2026-10-25 12:4x，Will 授權）：不從公開 repo 重新部署（公開版作品 ID 是範例值，盤點缺陷 22），改在正式 release `d994cd2` 上只換 jobbank518.py 與其測試：`/opt/freelance-agent.d994cd2-jb518`、映像 `freelance-agent-backend:d994cd2-jb518`。兩個映像安裝的 `freelance` 套件逐檔 sha256 比對只差 jobbank518.py（作品資料不變，量到）；新映像內 518 測試 8 個通過、實抓 `fetch()` 讀到 2 篇、0 rejected。切換照 `docs/compose.md`：停 API／worker／Web、備份 `runtime/compose-jb518-d994cd2-backup.sqlite3`（integrity／FK ok）、切 release symlink 與 `BACKEND_IMAGE`、`up -d --wait` 三個 healthy；切換後 opportunities／daily_runs／digest_outbox 筆數不變（當天已跑，不重跑）。回滾：symlink 改回 `/opt/freelance-agent.d994cd2`、`BACKEND_IMAGE` 改回 `:d994cd2`。待驗：10-26 09:00 自然排程後 jobbank518 的 `source_health`。
  - 最後一批（2026-10-25）：taiwanjobs、arbeitnow、freelancer（getonboard 已在第 1 批完成）。實作狀態：`sources/taiwanjobs.ts`、`arbeitnow.ts`、`freelancer.ts`，3 個都登記在 `RUNNERS`；2026-10-25 Will 授權部署，`82cd89d` 加進 `SCHEDULED` 並帶上比對器範圍改讀 TS run（見步驟 6「比對範圍」與「最後一批部署」）。HTTP 一律走 `urlopenRead`／`raiseForUrllibStatus`；taiwanjobs 用 45 秒整體 deadline，arbeitnow 與 freelancer 照 urllib 只限連線與每塊等待（整體傳 `Infinity`，見下方「記」）。共用件：
    - Python 行為照抄：`unicode.ts` 的 `pyRstrip`（arbeitnow 描述進 receipt 雜湊）；taiwanjobs 的 `STRPTIME_YMD`（`_strptime` 的 `%Y%m%d` 正規式，用 `match` 加「後面不能剩字」，`\d` 認 Unicode 數字；決定 `source_updated_at`，進 receipt 雜湊）。
    - 不照抄：URL 參數的編碼與解析用 `URLSearchParams`，不移植 `quote_plus`／`urlencode`／`parse_qs`（設計審查 B1、A2）；等價由 golden 驗證：taiwanjobs 84 組（含 `%31`、`+`、空值、重複參數、Unicode 數字）與 freelancer 搜尋的請求 URL 全同。
    - taiwanjobs 的 `'<!DOCTYPE' in text.upper()` 不把全文轉大寫：`upper()` 逐 code point、只改字母，所以只檢查每個 `<!` 後 7 個 code point（`declares()`）。
  - 最後一批驗證（本機，2026-10-25）：golden 新增 rstrip 10、regex 171、taiwanjobs 日期 28／整批 84／嚴格版 12、arbeitnow normalize 70／整頁 38／scan 32（含請求 URL 與逾時）、freelancer normalize 73／search 40（含請求 URL 與逾時），Python 3.13.15 產生，TS 全同。實抓：本機 Python 的 TLS 驗證對 taiwanjobs 失敗（`Missing Subject Key Identifier`，同第 3 批），改在正式映像 `freelance-agent-backend:d994cd2-jb518`（三個模組與公開 repo 逐檔 sha256 相同）用 Python 自己的讀取路徑錄下回應：taiwanjobs 1 個、arbeitnow 20 頁、freelancer 22 頁；離線重播給兩邊，輸出逐位元組相同（taiwanjobs 998 筆、2 筆 rejected；arbeitnow 4,823 筆、410 rejected；freelancer 601／508／869 筆）。TS 自己連真站（本機）：taiwanjobs 998 筆 7.9 秒、arbeitnow 120 秒期限內 8 頁（截斷，Python 預設同樣是 120 秒）、freelancer 三個查詢共約 32 秒。Python 測試案例的 TS 版：入庫 29 個（`tests/batch4-sources.test.ts`）。mutation 20 項各自讓測試失敗；第一輪存活 4 項（`parse_qs` 不留空值、`rstrip` 換 JS `trimEnd`、freelancer 不收 AttributeError、剩 0～0.6 秒仍暫停），補 golden 邊界案例後失敗（`parse_qs` 那項隨改用 `URLSearchParams` 不再適用，等價改由上面的 golden 守）。
  - 最後一批設計審查（獨立 subagent）6 項：改 4（URL 編碼與解析改用 `URLSearchParams`；arbeitnow 同一頁不再解析兩次，`parseBatch` 回傳 meta 與筆數；本段與步驟 14 的紀錄）、記 2：
    - 單次請求沒有整體上限：arbeitnow 與 freelancer 照 urllib，只限連線與每塊等待，8 MB／2 MB 的慢速回應可以超過盤點 §6 原本寫的「單次 25 秒／20 秒」（§6 已更正）。加整體 deadline 會讓 Python 成功的慢速情況在 TS 失敗，所以切換前不加，同 himalayas。觸發：shadow 上任一來源單次 step 超過 150 秒，或步驟 8 停止條件的 300 秒有風險時，交 Will 決定。
    - freelancer 逐筆 ingest：照 Python 每筆各開一個寫入交易（不用 `sourceBatch`），中途失敗時前面已寫的保留，和 Python 相同。2026-10-25 錄到的資料照正式規則篩選約 303 筆會 ingest（推論，離線計算），每筆到 Neon 的耗時未量。觸發：freelancer 排程後量 step 總時間，超過 200 秒時改成一個 `sourceBatch` 或拆 step，交 Will 決定（改成一個交易只有中途失敗時行為不同：全部不寫）。
  - 第 3 批設計審查（獨立 subagent）6 項：改 4（逐塊等待的 `urlopenRead`，連帶原本記的逾時觸發條件刪除；拿掉 `Accept-Encoding: identity`；urllib 狀態語意收進 `platform/http.ts`；taiwanjobs 排序理由改寫成實際差別）、記 1（下一條）、審查者另提的「read() 包裝在 getonboard、community-jobs 與 job-pages 各有一份」併入第 4 項的處理：後續來源用 `urlopenRead`／`raiseForUrllibStatus`，已移植的 getonboard、community-jobs 不依例外類別分支，不改。
    - 記：`AccessBlocked` 是來源的例外，卻放在平台的 Python 例外繼承表（`errors.ts`），因為 `pyIsInstance` 只查這一張表。處理併入步驟 14 的 D6 終局（業務模組改用 `DomainError` 類別階層時，`AccessBlocked` 歸到 collection 模組）。觸發：D6 窗口結束。
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
  - 子步驟（2026-10-25 拆，一個 session 做不完）：
    - 9a 共用收信與 tasker、linkedin：`ReceivingClient`（只 GET、不跟 redirect、2 MB 上限、每次呼叫間隔 0.6 秒、UUID 正規形式）、寄件者解析（`email.utils.getaddresses` 照 CPython 3.13.15 移植）、`matches`、`read_notification`、`_sync`（游標、上限、隔離、`retry_pending` 復原、狀態），`store` 的 mail 函式與 `ingest_resend_batch`；parser 只有 tasker（`html.parser` 走既有 `platform/py/html.ts`）與 linkedin（receipt 雜湊用 `ensure_ascii=True` 的 `json.dumps`）。驗收：`test_resend_sync.py`、`test_resend_preview.py`（不含 CLI 與 key 檔）、`test_tasker.py`、`test_linkedin_mail.py`、`test_linkedin_receiving.py` 的 TS 版，golden 對照寄件者解析、UUID、`matches`、兩個 parser；mutation 拿掉收件者邊界、`retry_pending` 只覆寫、游標只在 complete 前移，測試各自失敗。
    - 9b cake、jobbank104、talent、glassdoor：parser 與 `matches` 的主旨 gate（`subject_format`、`is_job_subject`），各自 Python 測試的 TS 版與 golden。
    - 兩個子步驟都只登記在 `RUNNERS`，不排程。怎麼上 shadow 照 D14（A）：Resend 的 API key 只有 `full_access` 與 `sending_access` 兩種權限（官方文件 api-keys/create-api-key，2026-10-25 查），讀 Receiving 必須用能寄信、能管理帳號的 `full_access` key，放進 Vercel production env，全域約束因此加了這一條例外。`syncMailSource` 從 `RESEND_API_KEY`、`RESEND_INBOX` 讀（收件網域不進 repo）；缺 env 時照 Python 的 `connection is None`：health 記 failed、回傳 `source_unavailable`。
    - 9a 實作狀態（2026-10-25，未排程、未部署）：`web/src/modules/collection/mail/`（`receiving.ts` client、寄件者、主旨 gate、`readNotification`；`sync.ts`；`tasker.ts`；`linkedin.ts`），store 的 mail 函式在 `collection/ingest.ts`，`getaddresses` 在 `platform/py/email.ts`。驗證：golden 新增 getaddresses 96、UUID 32、寄件者 102、`matches` 620、tasker 66、linkedin 75、read_notification 47（真的 `ReceivingClient`＋假 transport，逐請求比 URL）、sync 情境 35（真 store、兩邊逐表比 mail_sync_state／mail_ingestion／mail_content_versions／opportunities／receipts／health）；mutation 12 項全紅（收件者邊界、`retry_pending` 才覆寫、游標只在 complete 前移、重試順序、content version 計數、linkedin 非職缺通知、既有 ID 不受排除、tasker 的 MULTILINE、getaddresses 計數檢查、waiting 規則、復原迴圈、linkedin receipt 的 ASCII 雜湊），第一輪存活 2 項（`retry_pending` 覆寫、計數）補 store 測試與「同內容第二次」情境後失敗。設計審查（fresh subagent）5 項：改 2（`resendId` 不再模擬 `UUID()` 的錯誤類別，兩個呼叫端都不區分，golden 只比成敗；步驟 14 補 9a 的照抄並更正盤點去向）、記 1（`qualify` 只為了例外而呼叫，下一條）、提 1（D14）、駁回 1：「VM 與 shadow 兩個讀取端共用 Resend 速率上限」——上限是每個 team 每秒 10 個請求（官方文件 api-reference/introduction），每個讀取端每次呼叫間隔 0.6 秒，最多約每秒 1.7 個，兩端合計約 3.4 個。
    - 記：`readNotification` 對每筆職缺跑一次 `qualify` 並丟掉結果，只因 Python 的 `preview()` 會算，算的時候丟例外就讓整封信變 rejected（stage template）。切換前必須一致；D6 後併入下面步驟 14 的 9a 照抄一起處理。

- [ ] **10. 摘要建置與寄送路徑（shadow 只建不寄）**（被擋於：步驟 9、D9）
  - 範圍：
    - `daily_runs` claim 與 `digest_outbox` 狀態機。
    - 摘要建置、寄送（D9 選的通道）、MIME 預覽 sha256 校驗（`bootstrap/jobs.py:21-24`）。
    - 人工核對的 recovery 操作：改成受保護的頁面或 script，取代 `bootstrap/recovery.py`。
    - 手動寄出既有 pending 摘要的操作，取代 `gmail_smtp_cli`：要核對預覽 sha256（由 TS 自己算），不沿用 Python 算的值。
    - shadow 模式只建 snapshot，寄送 step 因為缺憑證而結構上無法執行。
    - 來源結果帶進 `daily_runs.result.source_details`（2026-10-24 設計審查）：Python 把每個 connector 的整份回傳（`seen`、`jobs`、`scope`、失敗的 `reason`）寫進去，`notifications/store.py:32` 讀它建摘要；TS 的 runner 目前回傳這份 dict 但 `runSource` 只留 ok／failed。這一步把 runner 契約定成有型別的計數與 reason，一路帶到 `finishDailySources`；在那之前比對器的 `daily_runs.result` 差異是已知的。
  - 消費端：`inventory-surface.md` §5b–5c 的每個轉移；`rg -n "daily_tick|dispatch|digest_outbox|gmail_smtp" backend/src`。
  - 驗收：
    - 「不確定寄送不重試」「同日不重寄」「過期日期不執行」三組測試的 TS 版通過。
    - shadow 7 天的候選清單與 Python 實寄的 snapshot 在同一起點下比對一致。
    - mutation：讓寄送 step 允許重試，測試要失敗。

- [ ] **11. UI、API、契約與離線 demo**（被擋於：步驟 4、D10；可以和步驟 6–10 並行）
  - 錯誤模型（2026-10-24 設計審查）：route handler 與 server action 依 `Conflict`／`InvalidAction` 等錯誤類別（`instanceof`）對應 HTTP 狀態，不讀 `PyError.pyType` 字串；字串分類只服務 shadow 期的 Python 對照測試，D6 後移除（見步驟 14）。
  - 範圍：
    - 42 個 operation 依 D10 改成 route handler 或 server action，47 個前端呼叫點改成直接呼叫。
    - 移除 proxy 白名單。
    - 補上 Origin 檢查與 body 上限；回應標頭沿用 `no-store`、`nosniff`；錯誤碼對應沿用現有 API（`inventory-surface.md` §2）。
    - `/digest` 預覽使用步驟 10 的 render，這一項要排在步驟 10 之後。
    - 頁面沿用 `frontend/` 的元件。
    - 歷史核准失效保護依 D8。
    - 離線 demo 模式：PGlite 加 network guard，不讀任何 env。
    - 讀取路徑瘦身（D13）：UI 的清單與分組回饋不再每次讀全表、重算全部評估。做法在本步決定（候選：寫入時存 identity key 與投影欄位，回饋只讀相關群組；清單用 SQL 篩選分頁）。每日摘要可以保留全表 `listIn`（每天 1 次），以維持和 Python 的逐位元比對。
  - 消費端：`inventory-surface.md` §3 的 47 個呼叫點；`rg -n "openapi-fetch|api\.d\.ts|contracts/" frontend scripts`；`frontend/tests/{smoke,manual-application-load,workbench}.mjs`。
  - 驗收：
    - 三支前端測試的等價版在 preview 上通過。
    - stale revision 被拒絕的測試通過。
    - 斷網且沒有任何 env 時，demo 的 e2e 通過。
    - mutation：
      - 移除 revision 檢查，測試要失敗。
      - 在 demo 路徑加一個 `fetch`，network guard 要讓測試失敗。
    - D13：以正式資料量級量測，一次 UI 清單請求與一次分組回饋各自從 Neon 讀取的位元組，換算「每天 20 次回饋＋20 次清單＋1 次摘要」的月用量，低於 1 GB；分組 token 與既有群組結果仍和全表算法一致（測試比對兩種算法）。
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
  - 前提：步驟 11 的 D13 驗收已過（Neon 免費方案超量會暫停 compute，每日摘要也會停）。
  - 前置決定（步驟 12 結束前交給 Will）：prod branch 是否分出 runtime 角色——migration 用擁有者角色，app 連線角色只拿 DML，並對 `proposal_draft_revisions`、`submission_events` `REVOKE UPDATE, DELETE, TRUNCATE`；trigger 保留當第二道防線。不分的話，任何拿到 app 連線字串的人都能 `DISABLE TRIGGER`。
  - 範圍：
    1. 在 Vercel 專案 Disable Cron Jobs，確認當天 TS 的 shadow run 已結束。
    2. 確認 VM 當天的 `daily_runs` 已是 complete 或 failed，且 `digest_outbox` 沒有 pending、attempted 或 unknown（pending 要先在 VM 上寄出或人工結案，因為預覽 sha256 不跨語言沿用）。
    3. 停 VM 的 API／worker／Web，用 `docker compose ps` 確認沒有 writer。
    4. 做一致備份；先在 Neon 的 prod branch 跑 Drizzle migration 到最新版本，再跑收斂腳本與指紋報告。
    5. 改 production env：`DATABASE_URL` 指向 prod branch；Will 存入寄送憑證（D9 的 Gmail SMTP）後回 `done`；寄送開關打開。`RESEND_API_KEY`、`RESEND_INBOX` 在 shadow 期已存入（D14），沿用；shadow 期超過 6 週或懷疑外洩時先換一把新 key。然後重新部署，並 Enable Cron Jobs。
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
    - VM 上 4c 的副本容器，以及 `web/src/ops/`、`web/scripts/{converge.ts,compare.ts,snapshot.ts,shadow-job.sh,verify-fingerprints.ts}`。
    - `registry.ts` 的 `SCHEDULED` 與 `enabledSources` 的 `scheduled` 參數（release toggle 到期：等於 `RUNNERS` 扣 `DISABLED` 時，最晚步驟 9 的信件來源全部排上後）。`DISABLED` 改成 source catalog 的資料欄位（PTT 被擋是長期事實，不是開關）。執行中可切換的營運開關（ops toggle）不預先做；觸發：第一次有來源需要比一次授權部署更快關掉，那時做 TS 自己的 DB 表加 UI 開關（切換後 DB 不再被覆蓋，Python 設定契約也已刪除）。
    - `web/tests/fixtures/gen_golden.py`（依賴 `backend/`）；`golden.json` 保留。刪 `backend/` 前先把 `001_sqlite.sql` 凍結進 `web/tests/fixtures/`，改 `web/tests/helpers/db.ts` 的 `SQLITE_SCHEMA_PATH`。
  - 更新：
    - `AGENTS.md`：收斂遷移期規則與技術棧。
    - `README.md`。
    - `docs/design.md`、`docs/compose.md`（改寫成 Vercel 操作）、`docs/implementation-plan.md`、`docs/features.md`、`docs/platform-connectivity.md`、`docs/README.md`。
  - 完成定義逐項核對；獨立設計審查（design-review skill）。
  - 長期檢查接進 CI：schema 漂移、trigger 測試、指紋相容測試、step 型別檢查。
  - 延後項附觸發條件，搬回主清單。
  - D6 窗口結束時處理（2026-10-24 設計審查記下的終局）：
    - Python 值模型只留在雜湊與已存 JSON 的邊界（`web/src/platform/py/{json,unicode,url}.ts`）；業務模組改用 TS 原生型別與 `DomainError` 類別階層，移除 `PyError` 字串分類、C 版 `fromisoformat` 與 Python `round`／格式化的照抄。
    - `golden.json` 拆成兩份：雜湊相容（永久保留）與 Python 行為對照（刪除）。
    - `web/src/platform/py/html.ts` 與 `platform/http.ts` 的 `loadsBytes`（照抄 `json.detect_encoding` 的 UTF-16／32）：二選一，換成 WHATWG parser（parse5）並修盤點缺陷 23，接受所有描述來自 HTML 的來源一次性重算指紋；或永久保留移植。觸發：D6 窗口結束。
    - 步驟 7 的 Python 行為照抄（`platform/py/email.ts` 的 `parsedate_to_datetime`、`re.ts` 的 `\b`＋IGNORECASE、`unicode.ts` 的 `pyInt`／`pyIsDigit`／`pyUpperAscii` 與 `decimal`／`digit`／`word`／`ignorecase_ascii`／`upper_ascii` 表、`xml.ts` 照 expat 的編碼判斷）：它們決定 `published_at`、`taiwan_eligible`、`remote_evidence`，這些欄位進 receipt 雜湊，所以切換前必須和 Python 一致。D6 後二選一：換標準實作（RFC 5322 日期解析、原生 `/iu`、`BigInt`／`Number` 解析），接受這類來源一次性重算 receipt；或永久保留並寫出理由。觸發：D6 窗口結束。（2026-10-24 步驟 7 設計審查）
    - 步驟 8 第 1 批的照抄（`re.ts` 的 `translate`、`unicode.ts` 的 `pyFloat`／`pyIntToFloat`／`space` 與 `cased` 表、`datetime.ts` 的 `fromTimestamp` 錯誤分類、`json.ts` 的 4300 位上限、`xml.ts` 的 `attrib` 與第二個 BOM）：決定 `taiwan_eligible`、`timezone_compatible`、來源成敗與 receipt 雜湊。處理方式同上一條，二選一。觸發：D6 窗口結束。（2026-10-25 步驟 8 設計審查）
    - 步驟 8 第 2 批的照抄（`re.ts` 的 lookahead、控制字元跳脫、dotAll 與 `pyFindall`／`pySub`／`pyReSplit`；`xml.ts` 的 `xmlFromString` 忽略宣告編碼與跳過一個 BOM；`codecs.ts` 的錯誤分類）：決定 `employment_evidence`、`kind`（進 receipt 雜湊）與 RSS 來源成敗。處理方式同上一條，二選一。觸發：D6 窗口結束。（2026-10-25 步驟 8 第 2 批設計審查）
    - 步驟 8 第 3 批的照抄（`url.ts` 的 `urljoin`、`unicode.ts` 的 `pyUpper` 與 `upper` 表、`json.ts` 的 `rawDecode`、`datetime.ts` 的 `dateFromIsoformat`、`re.ts` 的 `\Z`／`pyMatch`、`http.ts` 的 `urlopenRead`／`raiseForUrllibStatus`）：決定 canonical URL（external_id）、`employment_types`（進 receipt 雜湊）、`published_at`／`updated_at` 與詳情頁成敗。處理方式同上一條，二選一。觸發：D6 窗口結束。（2026-10-25 步驟 8 第 3 批）
    - 步驟 8 最後一批的照抄（`unicode.ts` 的 `pyRstrip`、taiwanjobs 的 `STRPTIME_YMD`）：決定 arbeitnow 的 `description` 與 taiwanjobs 的 `source_updated_at`，都進 receipt 雜湊。處理方式同上一條，二選一。觸發：D6 窗口結束。（2026-10-25 步驟 8 最後一批設計審查）
    - 步驟 9a 的照抄（`platform/py/email.ts` 的 `getaddresses`／`AddrlistClass`、`receiving.ts` 的 `utf8Length` 對 lone surrogate 丟錯、`readNotification` 只為例外而呼叫的 `qualify`、`mailRecords` 照 SQLite 主鍵索引的讀取順序）：決定寄件者 allowlist、哪些信被 rejected 與重試順序。二選一：寄件者改用維護中的 RFC 5322 parser 或只比對已知的 From 形式、`qualify` 呼叫刪掉、順序改成明寫的規則；或永久保留並寫出理由。觸發：D6 窗口結束。（2026-10-25 步驟 9a 設計審查）
    - 非雜湊的時間欄位改 `timestamptz`、0/1 旗標改 `boolean`，或寫出保留理由。
    - `listIn` 全表讀取：UI 路徑已在步驟 11 改掉（D13）；這裡只剩每日摘要的全表讀取，D6 後若摘要不再需要和 Python 逐位元比對，再一起改。
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

- **D13 Neon 傳輸量與讀取路徑**（狀態：已決 2026-10-24，Will 照建議；擋住步驟：11、13；事實：步驟 5 量到一次 `list`／分組回饋約 8.1 MB，Neon 免費方案每月 5 GB、超量暫停 compute）
  - A：讀取路徑瘦身提前到步驟 11，列為切換前提。（建議，已選）
  - B：維持步驟 14 才改——切換後每天約 20 次回饋就可能超額，摘要跟著停。
  - C：升級 Neon 付費方案——每月 500 GB，但多一筆固定費用，且不解決每次讀 8 MB 的延遲。

- **D14 信件來源怎麼上 shadow**（狀態：已決 2026-10-25，Will 照建議（A）；擋住步驟：9 的 shadow 排程與 3 天比對，不擋 9a、9b 的程式）
  - 事實：Resend API key 只有 `full_access`（讀寫與管理全部資源）與 `sending_access`（只能寄）；沒有唯讀 key（官方文件，2026-10-25 查）。正式 VM 現在用的 key 也是能寄的那種（`bootstrap/jobs.py:30` 收信與 `:15` 的 Resend 寄送路徑讀同一個 key 檔；D9 選了 SMTP，所以那條寄送路徑目前沒用）。切換後只有 Vercel 讀收件匣，所以 Vercel 遲早要拿 `full_access` key（推論；步驟 13 原本只列 SMTP 憑證，已補上）。
  - A：為 shadow 另建一把專用 `full_access` key 放進 Vercel production env，明文修改全域約束（例外只限 Resend 讀取）；防護改成程式加測試：HTTP 層執行期白名單（只允許 GET `https://api.resend.com/emails/receiving` 底下）＋ mutation 測試、`web/src` 只有 `receiving.ts` 寫到 Resend 網址、env 驗收改成精確的 key 名稱白名單。用真實信件在真正的 runtime 跑 3 天比對，不寫任何步驟 14 會刪的 shadow 專用程式。（建議，已選）
  - B：TS 收信改在 VM 的 shadow 容器跑，key 留在 VM——要繞過 `daily_runs` claim 的單獨入口、比對範圍邏輯、改 VM 設定與掛載 key，全是步驟 14 會刪的程式；也量不到 Vercel 上的耗時。
  - C：不跑 shadow，在 VM 錄真實回應、兩邊離線重播比對；少了 3 天自然信件比對，切換時才第一次在 Vercel 真跑。（A 被否決時的備案）
  - 外洩處置：在 Resend 撤銷這把 key，再稽核帳號裡的 API key 清單、網域與 webhook（`full_access` 能自己建新 key、加網域與 webhook，只撤銷擋不住），並換掉 Vercel env。
  - 終局：切換時這把 key 就是正式的收信 key（步驟 13 第 5 小步）；VM 上的 key 留到 D6 窗口結束才撤銷，因為回滾要用。
  - 狀態更新：已決 2026-10-25，Will 選 A。需要人做的事：在 Resend 建專用 key、存進 Vercel production env（`RESEND_API_KEY`、`RESEND_INBOX`，Sensitive）後回 `done`，再授權部署與排程。

拍板順序：D1、D3、D4、D6、D7、D8、D10、D11 已於 2026-10-23 拍板。D9 於同日拍板（A）。D2、D5、D12 在 spike 1 之後於同日拍板（A）。D13 於 2026-10-24 拍板（A）。D14 於 2026-10-25 拍板（A）。D2 等 spike 1b，D5 等 D1 與 D2，在步驟 1 完成後再交。

## 進度

狀態值：未開始／進行中／程式完成待驗收／完成。

| 步驟 | 狀態 | 已跑的驗收 | 未跑的驗收與原因 | commit |
|---|---|---|---|---|
| 1 Spike | 進行中 | 1a、1b、1e 成立；1c 合成 707/707；1c 正式副本（2026-10-24，VM 容器內）：職缺 ID 與指紋 2,226/2,226、信件內容版本 6/6、摘要 snapshot 37/37 round-trip（submission 0 筆，HP4 無列可驗）；1d 連線成立（`spikes.md`） | 1d 實寄：待憑證與步驟 10 | |
| 2 盤點去向 | 完成 | `check_inventory.py` exit 0（243＋29 列、20 項缺陷）；改一列為 TBD 時 exit 非 0；6 個計畫缺口已補進步驟 5、10、11、13 | `--residue` 要到步驟 14 才跑 | |
| 3 Walking skeleton | 完成 | 本機：`pnpm typecheck`、`pnpm boundaries`（違規 import 被擋）、`pnpm test` 5/5（mutation：移除開頭標 failed → 2 失敗）、`pnpm build`；preview 未登入 302、錯誤 secret 401、觸發 cron 後頁面出現 `skeleton ok`；舊路徑 diff 為空。CI：public repo run 39968672002，backend ✓、web ✓ | 無 | `813df86`（archive repo）；公開版 `5b94e25` |
| 4 共用層 | 完成 | 本機與 CI（run 39986551118、39989561988）全綠；mutation 全部會失敗。VM（2026-10-24）：正式副本收斂 25 表來源／目標指紋相同，同副本收斂兩次報告相同，自我比對 0 差異；Python（正式 `d994cd2` 映像）與 TS 對同一份正式資料的 `list()`（2,226 筆、9,385,428 位元組）與分組（11,379,263 位元組）sha256 相同；`freelance-shadow-morning.timer` 已啟用，正式容器未變動 | 08:30 timer 首次自然執行待觀察；10:30 after timer 在步驟 5 啟用 | `a3de985`、`e7b8c51`、`13d991c` |
| 5 TS 端排程骨架 | 完成 | 正式專案部署；手動觸發（01:17）回 not due、shadow 無寫入；`vercel env ls production` 只有 4 個 key、無寄送憑證；Neon 傳輸量已量；2026-10-24 自然執行：08:31 morning `converge ok`、09:14 cron 寫唯一一列 `complete`、12:53 cron log「已有 run」 | | `199bef1`、`e6a299c` |
| 6 試點 Jobicy／Remotive | 進行中 | 本機：golden（HTML 98、normalize 96）、真實 feed 209 筆逐位元組相同、6 個 Python 案例、5 個 mutation、獨立審查 2 份；7 天比對第 1 天（10-25）logic 0、timing 0 | 7 天比對第 2–7 天、比對器 mutation；2026-10-24 已部署、after timer 已 enable；10-25 起比對範圍擴大為 16 個來源 | |
| 7 CryptoJobsList | 已部署（2026-10-25，`920b6b4`） | 本機：golden（RSS 123、text 127、日期 126、int 26）、真實 feed 100 筆逐位元組相同、4 個 Python 案例、交易邊界 mutation | 比對（10-26 起，與步驟 6 同一份報告）；依序執行的 fan-out 隨同一次部署上線 | |
| 8 其餘免登入來源 | 進行中 | 第 1 批（himalayas、hackernews、v2ex）與 getonboard 程式完成：golden、真實回應逐位元組相同、9 個 store 案例、13 個 mutation、差分模糊測試與設計審查；第 2 批（public_feeds 4 個）程式完成：golden、真實回應 351 筆逐位元組相同、14 個 store 案例、13 個 mutation、設計審查；第 3 批（nodesk、justremote、dynamitejobs、jobbank518、chickpt）程式完成：golden、5 個來源的實抓回應輸出逐位元組相同、37 個 Python 案例、25 個 mutation、設計審查（改 4、記 1） | 第 1–3 批 2026-10-25 已部署（`920b6b4`），3 天比對 10-26 起；jobbank518 索引頁修正（Python 也上 VM，見第 3 批）；最後一批（taiwanjobs、arbeitnow、freelancer）2026-10-25 程式完成：golden、真實回應逐位元組相同、29 個入庫案例、20 個 mutation、設計審查（改 4、記 2），同日部署（`82cd89d`），3 天比對 10-26 起；排程後量各 step 耗時（freelancer 超過 200 秒、任一 step 超過 150 秒交 Will） | |
| 9 信件來源 | 進行中 | 9a（共用收信、tasker、linkedin）程式完成：golden（寄件者、主旨 gate、parser、read_notification、35 個 sync 情境逐表比對）、12 個 mutation、設計審查（改 2、記 1、提 1、駁回 1） | 9b 未開始；shadow 排程與 3 天比對等 D14 | |
| 10 摘要與寄送 | 未開始 | | | |
| 11 UI、API、demo | 未開始 | | | |
| 12 反向收斂與演練 | 未開始 | | | |
| 13 正式切換 | 未開始 | | | |
| 14 收尾 | 未開始 | | | |
