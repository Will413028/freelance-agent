# 搬離 VM：改寫成 Next.js 全端並部署到 Vercel

**Goal：** 正式環境不再依賴 `oci-a1`。收案、篩選與排名、網頁上看職缺與收藏／略過，由同一個 Next.js（TypeScript）app 提供，部署在 Vercel，資料放 Cloudflare D1（D19）。不建每日摘要、不寄信（D22，Will 2026-11-03）；投案、客戶與草稿工作台延後（見範圍）。Python backend、Huey、Compose、舊 `frontend/` 與 `contracts/` 都已刪除。驗收見步驟 14。

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
- **切換前 Python／VM 是唯一寫正式資料的系統；沒有任何系統寄摘要信（D22：Python 自 2026-11-03 起 `live_send: false`，TS 不建摘要）。** TS 版在 shadow 期（影子期）只寫 shadow DB。Vercel production env 裡沒有任何寄送憑證，這是結構性防護，不是只靠程式碼守住；驗收方式是 `vercel env ls production` 的 key 名稱清單。唯一例外（D14，Will 2026-10-25）：讀 Resend Receiving 的 `RESEND_API_KEY`。Resend 沒有唯讀 key，這把 `full_access` key 技術上能寄信與管理帳號；對它的防護是程式加測試：`ReceivingClient` 只送 GET，且每個請求先過 `assertReceivingUrl`（只允許 `https://api.resend.com/emails/receiving` 底下），`web/src` 裡只有 `receiving.ts` 寫到 Resend 的網址。驗收改成精確的 key 名稱白名單：允許 `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`D1_API_TOKEN`（4e4 起取代 `DATABASE_URL`）、`CRON_SECRET`、`DIGEST_RECIPIENT`（D22 後只當 `daily_runs` 的鍵，不寄信）、`PORTFOLIO_CATEGORY_PROJECTS`、`RESEND_API_KEY`、`RESEND_INBOX`、`WEB_WRITES`（D23，切換時才設），其他名稱（含任何 SMTP 相關的 key）出現就不通過；切換（步驟 13）也不加寄送憑證。
- **Workflow step 的輸入輸出只放 ID、計數與狀態。** 信件正文、職缺內文與憑證只在 step 內讀寫 DB，因為 Vercel Workflows 會記錄每個 step 的輸入、輸出與錯誤（[Workflows](https://vercel.com/docs/workflows)）。
- 憑證只放 Vercel 的 Sensitive Environment Variables 或本機 `secrets/`。Will 存好後回 `done`，agent 只看 key 名稱，不讀值。
- 每次部署到 Vercel 正式專案、每次改 VM 上的設定，都要 Will 先授權。preview 部署不算。
- 每個單元（一個來源、一組 API、一個狀態機）的完成定義：
  - 對應 Python 測試的行為案例已移植到 TS。
  - 比對器對同一起點、同一天的增量輸出一致；有差異時逐項列在附件，經 Will 接受。
  - 盤點的「去向」欄已更新。
  - 有一個真正的 mutation：改壞實作，測試要失敗。

## 前提（開工時核對過，2026-10-23）

- **會被取代的既有部署是否在線：在線。** `oci-a1` 每天 09:00 Asia/Taipei 收案；2026-11-03 起不再寄摘要（D22：`worker.json` 的 `live_send` 改成 `false`、拿掉 `smtp_config`，備份 `worker.pre-nosend-20261103.json`，worker 15:5x 重啟；摘要照建、停在 `pending`；回滾是複製備份回去並 `restart worker`）。證據（2026-11-03 量到，只看鍵名與布林值，不印值）：容器內 `DailySettings` 驗證通過、`live_send in container: False`；`docker compose ps` 顯示 worker `Up 31 seconds (healthy)`，api、web 未動。待查：11-04 當天 `digest_outbox` 那列停在 `pending`（和 4e4 驗收一起查，見進度表第 4e 列）。本 session 唯讀查正式 DB 量到：2026-10-23 的 `daily_runs` 是 `failed`（來源部分失敗），`delivery_status: sent`。
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
- **（D22 前的事實，保留為紀錄）正式寄送通道是 Gmail SMTP（已確認，量到）。** 2026-10-23 唯讀查正式 DB：最近 3 天 `digest_outbox.delivery_receipt` 的前綴都是 `smtp-accepted`，這個字串只有 `notifications/gmail_smtp.py:21` 會寫入；接線在 `bootstrap/jobs.py:17-24`。
- 今天的收案約 5 分鐘：27 個來源的 `source_health.checked_at` 從 01:01:02 到 01:05:56 UTC（量到，只有今天一個樣本，不含寄信時間）。
- 所有 connector 只用 Python 標準函式庫。（來源：`inventory-sources.md` §0；讀程式得出）
- 雜湊點有 131 行命中（`rg -n "sha256|json.dumps" backend/src | wc -l`，subagent 量到）。各處的 `ensure_ascii` 與 separators 不一致，例如：
  - `discovery/rules.py:61`：預設 separators、`ensure_ascii=False`。
  - `submissions/domain.py:13`：緊湊 separators、`allow_nan=False`。

  另外 Python 的 `sort_keys` 依 code point 排序，JS 預設依 UTF-16 排序。（讀程式得出 → spike 1c）
- `legacy/records.py` 與 legacy 欄位 `review_status` 仍在正式的收案、回饋與候選判斷路徑上。（來源：`inventory-surface.md` §7；讀程式得出）
- 正式資料量：2,226 筆 opportunities、2,303 筆 source_receipts（2026-10-23 唯讀查正式 DB，量到；`docs/implementation-plan.md:20` 的 708／726 是 9/28 的舊數字）；DB 檔 22.9 MB（量到）。
- 環境（2026-10-23 建立）：Vercel 專案 `freelance-agent`（iad1，Deployment Protection All）；Neon 專案 `freelance-agent`（`fancy-water-44947465`，aws-us-east-1，branch `main`、`dev`；preview 用 `dev`）。spike 專案 `freelance-agent-spike` 已於 2026-10-26 1d 完成後刪除（Will 授權；`vercel project ls` 只剩 `freelance-agent`）。2026-11-03（4e4）起 shadow 在 Cloudflare D1 `freelance-agent-shadow`（ENAM），CI 用 `freelance-agent-ci-test`；Neon 的 shadow branch 在 4e4b 結束後刪，Neon 專案的退役見步驟 14。
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
| （Python 側；TS 自 10f 起不建摘要，D22）同一天、同一收件者最多一份摘要 intent；snapshot 寫入後不可變；歷史 `digest_outbox` 列照搬保留 | `digest_outbox`（`001_sqlite.sql:28`、trigger `digest_immutable` :41）、`daily_runs` 主鍵 `(local_date, recipient)`、`notifications/daily.py`、`notifications/scheduler.py`；TS（10f 起）：不寫 `digest_outbox`，保留它的唯一約束與 `digest_immutable` trigger 守歷史列 |
| （Python 側；D22 後沒有寄送）attempted／unknown 的寄送不自動重試，只能人工核對 | `digest_outbox` 狀態機（`inventory-surface.md` §5c）、`notifications/gmail_smtp.py`、`notifications/scheduler.py:20-39` 的 `dispatch`、`bootstrap/recovery.py`；TS：10f 起沒有寄送程式 |
| TS 不寄任何信（D22） | `web/package.json` 沒有 `nodemailer`（10f 刪除）；`rg -n "smtp|nodemailer|sendmail" web/src` 沒有命中；env 白名單（全域約束）；`receiving.ts` 只送 GET（D14） |
| 已有任何 daily run 就不重新呼叫來源；過期日期不執行 | `scheduler.daily_tick`（`docs/design.md:60`）；TS：cron handler 入口的 `daily_runs` claim。這條同時擋住 Vercel cron 重複觸發 |
| 同一時間只有一個 writer 寫正式資料 | Huey 單一 consumer 與 `queue.lock`（`bootstrap/queue.py:24`）、SQLite `BEGIN IMMEDIATE`；TS（4e2b 起，D20-B）：`daily_runs` row claim 加 `writer_lease` 租約與 fencing token（`web/src/db/unit.ts`；租約表的寫入 batch 必須以守衛開頭，D1 client 拒送沒有守衛的，`web/src/db/d1/guard.ts`）；切換程序（步驟 13） |
| 草稿版本、submission 與其事件不可修改、不可刪除 | `draft_revision_immutable`／`draft_revision_retained`／`submission_immutable`／`submission_event_immutable`／`submission_event_retained`（`001_sqlite.sql:192-224`）；TS：同樣的 SQLite trigger（`RAISE(ABORT, …)`），`check-storage-triggers` 每次執行檢查它們還在 |
| 參與雜湊或 snapshot 的欄位逐位元保存 | `opportunities.item`、`digest_outbox.snapshot`、`proposal_draft_revisions`、`submission_intents` 的 snapshot；TS：這些欄位存 `text`，不經 JSON 函式改寫；序列化集中在 `web/src/platform/py/json.ts` |
| （D17，2026-10-26 起只限 v1 雜湊邊界：canonical JSON、opportunity id、fingerprint、receipt id、novelty key、核准雜湊，以及產生它們輸入的解析，到 D6 窗口結束；其他程式改原生，不再以 Python 輸出為規格）規格是正式映像的 CPython 3.13.15，不只是 Python 原始碼：`html.parser`、`fromisoformat`、`urlsplit` 在 3.13.13 與 3.13.15 之間行為不同（2026-10-24 量到） | `deploy/backend.Dockerfile` 釘 `python:3.13.15-slim`（2026-10-24 Will 決定；執行中的 `d994cd2` 映像本來就是 3.13.15，下次重建才生效）；TS：`web/src/platform/py/*.ts` 註明的版本、`gen_golden.py` 開頭的版本檢查、本機 `backend/.venv`（3.13.15）。要升 Python 時，Dockerfile、`gen_golden.py` 的版本檢查、本機 venv 一起改，並用新版重跑 `gen_golden.py` 與差異 |
| `(source, external_id)` 唯一；receipt ID 防重複匯入 | `opportunities`、`source_receipts`、各 connector 的 receipt 規則（`inventory-sources.md` §1）；TS：connector 共用的 `ingest` 與指紋函式庫 |
| 未知欄位保留為未知 | `discovery/rules.py`、各 connector 的 envelope；TS：envelope 型別（unknown 是明確的值，不用 `null` 推定） |
| 回饋與設定變更沿用呼叫端的交易，stale revision 被拒絕 | `preferences`、`discovery/settings.py`、`tracking_events` revision；TS：route handler／server action 的交易邊界 |
| 歷史核准失效保護（`AGENTS.md`） | `legacy/review_service.py`、`backend/tests/legacy/test_review.py`（11 個）；TS 去向見 D8 |
| Workflow run data 不含正文與憑證 | TS：所有 `"use step"` 函式的參數與回傳型別只能是 ID、計數、狀態；用型別測試加 lint 守住 |
| UI 與 API 只有本人看得到；請求有來源檢查與 body 上限 | 現況：loopback、SSH tunnel、`LocalBoundary` 的 Origin 檢查與 body 上限（`bootstrap/http.py`）；TS：Vercel Authentication 加上 route 層的 Origin 檢查與 body 上限 |
| 離線 demo 不讀憑證、不連外、不寄信 | `bootstrap/http.py` `mode='demo'`、MemoryDatabase；TS：步驟 11 的 demo 模式（`node:sqlite` 記憶體庫加 network guard） |

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
  - D1（SQLite 方言）schema 與版本化 migration（只經 `scripts/migrate.ts` 套用）。
  - 27 個正式啟用的來源。
  - 每日排程與每個來源各跑一次（fan-out）。
  - 網頁前端第一版（D22）：職缺清單分頁、單筆詳情、收藏／略過／想接的回饋、篩選設定。
  - 每日副本管道與 shadow 比對器。
  - 正式 SQLite → D1 的一次性匯入（`import-copy`），與切換回滾用的 D1 → SQLite 反向腳本。
  - CI 與模組邊界檢查、切換，以及刪除 Python、Compose、舊前端。
- **不做：**
  - 每日摘要建置與寄送（D22，Will 2026-11-03：「不需要摘要，也不要寄送 email，我先只要有網頁前端可以看就好」）。已寫好的 TS 摘要、已通知帳本、寄送與 replay 在 10f 刪除；歷史 `digest_outbox` 列照搬保留（`AGENTS.md`：歷史 outbox 資料保留）。
  - Submission 對外送出（Email／Freelancer）的程式改寫，因為通道未配置（`docs/compose.md:64`）。資料表與歷史會搬（D7）。
  - Legacy AI 擬稿、Antigravity、舊 PG adapter，因為只有 legacy 測試在用（`inventory-surface.md` §7）。資料搬，程式不改寫。
  - Indeed、Guru，因為正式未啟用。
  - 修 2026-10-16 起的來源失敗，那是既有缺陷，另開工作。
- **延後：**
  - 前端的投案紀錄、客戶、模板與草稿工作台，以及離線 demo（觸發條件：Will 要求；D22 只要求看清單與回饋）。資料表與歷史照搬。Will 2026-11-03 接受切換後這些功能暫時沒有入口（D23）。
  - 重新加回摘要或通知（觸發條件：Will 要求；從 git 歷史的 10b–10c 與 PR #5 的 `76cd816` 恢復，寄送通道重新決定，D9 已被 D22 取代）。
  - Submission 送出改寫（觸發條件：Will 決定要配置 Email 或 Freelancer 通道）。
  - VM 上本專案資源的退役與 SQLite 檔刪除（觸發條件：D6 窗口結束，且期間每天的自然排程都完成收案）。
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
  - 1f D1 over HTTP（D19，2026-10-26 新增；被擋於 D19；擋住步驟 4e 與決定 D20、D21）：spike D1 資料庫 `freelance-agent-spike-1f`（ENAM）已建，token 在本機 `secrets/`（帳號層級 D1 Read＋Write，2026-11-30 到期）。從一個 Vercel spike 專案的 preview 部署（iad1）打 D1 query 端點，量下列各項，每項寫成成立／不成立：
    - (a) 延遲：單一 SELECT、10 個語句的 batch、真實最大的寫入（一個來源批次 274 筆、2,450 列投影重算、225 KB snapshot 加 110 列帳本），各跑 20 次記 p50／p95，且每個請求在 30 秒、每條查詢 100 個綁定參數、每條 SQL 100 KB 以內。
    - (b) HTTP batch 原子性：前兩句成功、第三句違反 UNIQUE，前兩句是否回滾。
    - (c) 單獨送 `BEGIN`／`COMMIT`／`SAVEPOINT` 的結果（被拒或各自提交）。
    - (d) 條件寫入：`UPDATE … WHERE …` 的 `meta.changes`、`INSERT … ON CONFLICT DO NOTHING RETURNING` 是否回傳列；一條「前一句影響 0 列就讓 batch 失敗」的守衛語句（例如寫入帶 CHECK 的守衛表）能否讓整個 HTTP batch 回滾。
    - (e) 值的往返：`params` 是字串陣列，量 null、整數、大於 2^53 的整數、浮點、非 BMP 字元、U+0000、U+2028、孤立 surrogate 寫入再讀回是否逐位元相同（雜湊與 snapshot 欄位靠這個）。
    - (f) 同一個 batch 裡的多條 SELECT 是否讀到同一個狀態（現行 `readTransaction` 是 repeatable read）。
    - (g) 允許的 SQL 函式：`sqlite_version()` 回 7500「not authorized to use function」（2026-10-26 量到），列出現行與計畫中 SQL 用到的每個函式是否可用。
    - (h) 列寫入量：用回應的 `meta.rows_written` 量合成的正式量級副本（2,450 筆 opportunities、40 份 snapshot、4,815 列帳本、投影）一次完整匯入、一次全刪、一次帳本重建；換算「shadow 每日 converge＋replay」與「正式每日執行」的列寫入與請求數。真實正式副本上傳 Cloudflare 要 Will 另外授權，這一項先用合成副本。
  - 1f 的撤回觸發（任一成立就停，回報 Will，選項：回 Neon＋P1、資料存取 Worker 代理（D21-B）、整個 app 搬 Workers）：(b) 不原子且 (d) 的守衛語句也無法讓 batch 回滾；任一 step 的「請求數 × p95」超過 150 秒；正式加 shadow 的每日列寫入估計超過帳號免費額度（10 萬列）的 50%；(e) 有值無法逐位元往返。
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

- [ ] **4e. 儲存層換成 Cloudflare D1**（D19，2026-10-26 新增；D20、D21 已決；在 10e1 之前做；Will 2026-10-26 要求盡快上 shadow）
  - 共同規格（各子步驟都照這裡；選項與理由見 `d20-d21-brief.md` v2.1）：
    - schema 改 SQLite 方言，以 Python 的 `backend/src/freelance/platform/schema/001_sqlite.sql` 為表結構來源，加上 `digest_novelty`；Postgres 的 plpgsql 不可改 trigger 改成 SQLite trigger（`RAISE(ABORT, …)`）。D1 專屬表（不在 `TABLES`，converge 不刪、反向腳本不碰）：`write_attempts`、`guard`（4e2a 建）、`writer_lease`（D20-B，4e2b 建）。drizzle 換 `sqlite-core`；drizzle-kit 只用來 generate，migration 只經 `web/src/db/migrate.ts` 套到 D1（`scripts/migrate.ts`；一個請求，資料庫已有 `writer_lease` 時在租約守衛之後送，4e3）。10e1 的投影表在 10e1 加。
    - 資料存取：`Executor` 換成自寫的 D1 HTTP client（drizzle `sqlite-proxy` 加 batch callback，打 REST 的 `/raw` 端點：回傳 `columns` 與陣列形式的 `rows`，正是 sqlite-proxy 要的形狀，另有 `meta.changes`、`rows_written`；1f 補充量到，D21）。值的往返照 1f (e)：大於 2^53 的整數以字串送出，回應裡出現超過 `Number.MAX_SAFE_INTEGER` 的整數就丟錯（fail closed，不默默失真）；布林送 0／1。約束失敗與交易語句都回 HTTP 400、code 7500，靠訊息區分（`SQLITE_CONSTRAINT` 是確定回滾）。讀取可以重試；寫入只在冪等時重試；429、overloaded、每日額度錯誤記錄後讓該單元失敗，不等待。每日執行把請求數與列寫入記在 `daily_runs.result` 頂層（`d1_requests`、`d1_rows_written`、`lease_wait_ms`，4e2b 另加 `lease_timeouts`、`lease_lost`、`d1_errors`（依錯誤種類計數）、`lost_steps`（死掉的 step 帶走自己的計數，總數是下界）；不能放進 `source_details`，`ranSources` 會把它當來源）。
    - 寫入路徑照簡報的分類：第 1 類單一條件語句原樣；第 2、3 類單元是「讀取 batch → 記憶體計算（unit of work 疊加層）→ 一個寫入 batch，只送有變的列」，程式內最多重試 3 次；結果不明時靠 `write_attempts` 判斷。並行控制照 D20（建議 B：`writer_lease` 租約加 fencing token，取得租約與讀取同一請求、寫入 batch 開頭守衛 `holder AND token`、每批續期、最後釋放；每日執行單元最多等 35 秒、UI 5 秒）。`createDigestIn` 的寫入不進租約，唯一鍵失敗時重讀既有的那份。全域寫入鎖（`writeTransaction`）刪除，不變量表「單一 writer」那列改寫成這個機制。
    - 本機測試替身：`node:sqlite` 實作同一個 proxy 介面，照 D1 擋 BEGIN／COMMIT／SAVEPOINT、超過 100 個參數或 100 KB 的語句；batch 用 SQLite 的 savepoint 模擬原子（替身內部可以，產品程式不行）；`rg -n 'transaction\(' web/src` 為 0。
    - env 白名單：新增 `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`D1_API_TOKEN`；`DATABASE_URL` 在 4e4 移除。token 用現有的帳號層級 user token（`secrets/` 的 d1-spike-1f，D1 Read＋Write；Will 2026-10-26；2026-11-30 到期，到期前重建並換掉 Vercel、VM shadow env、GitHub secrets 的值）。
    - D1 shadow 不每天收斂（Will 2026-10-26「不需要每日快照吧」，取代 D11 在 D1 期間的每日收斂）：4e4 換過去時把一份正式副本載入 D1 shadow 一次，之後 TS 在 D1 上自己累積、和正式系統分岔，只在需要時（例如步驟 12、13 的演練前）手動重載，每次先問 Will。每日同一起點的比對改由 replay 承擔：VM 照舊每天 08:30 拍正式副本，只留在 VM、不上傳，replay 在 VM 上對它跑本機替身。即時比對器（同一起點、同一天兩邊收案的差異）在換到 D1 後停用；它負責的步驟 6–9 比對窗口在 Neon 上跑完（3 天窗口到 10-28；步驟 6 的 7 天窗口到 10-31，4e4 若早於 10-31 上線，步驟 6 只算到換過去前一天，屆時回報 Will）。額度（D21，免費方案）：每日寫入只剩 TS 每日執行約 0.1–0.2 萬列（1–2%，推論）＋一次性載入約 3 萬列＋CI；每日用量＝`daily_runs.result`＋當天 CI 執行的列寫入（UTC 日）。CI 的真 D1 整合測試每次執行最多 2,000 列寫入，由測試自己加總 client 的計數器並斷言。CI 與 shadow、之後的正式資料庫同一個 Cloudflare 帳號（Will 2026-10-26）。
  - 分支：4e1–4e3 在分支 `4e-d1`（linked worktree）上做，各子步驟各自驗收、各自 commit；4e4 合進 main 並部署，4e4b 觀察 3 天。main 在合併前維持 Postgres，shadow 照常跑。
  - ADR：D19–D21 的修訂段已寫在 `docs/adr/2026-10-23-nextjs-vercel-full-stack-rewrite.md`（2026-10-26）。
  - [x] **4e1 D1 client 與本機替身**（被擋於：無；2026-10-26 完成，分支 `4e-d1` 的 `0701406`，本機驗收見進度表；CI 過：PR #2 run `41551184578`（2026-11-03））：`web/src/db/d1/`（HTTP client：query、batch、錯誤分類、計數器）、本機替身、限制測試；回應與 body 上限已在 2026-10-26 量（1f 補充：Mac 對 spike D1，一個 batch 10.1 MB、56 句成功，一次讀回 17.2 MB 成功，所以 8.6 MB 全表與 2.25 MB 投影一個請求讀得完）。驗收：client 對假伺服器的錯誤分類（429、7500 約束、7500 交易語句、每日額度、5xx、逾時）各一例；2^53＋1 以字串寫入讀回相同、回應裡的不安全整數丟錯；替身拒絕 BEGIN、101 個參數、100 KB＋1 的語句；mutation：替身拿掉 BEGIN 檢查、client 拿掉不安全整數檢查，測試各自失敗。不動任何既有消費端。
  - [x] **4e2a schema 與讀取、單一語句路徑**（被擋於：4e1；2026-10-26 完成，分支 `4e-d1` 的 `789d83c`，本機驗收見下方實作狀態與進度表；CI 過：PR #2 run `41551184578`（2026-11-03））：`schema.ts` 換 `sqlite-core`、drizzle migration 重產（D1 方言，含 trigger 與 D1 專屬表）、所有讀取路徑與第 1 類語句（`claimDailyRun`、`finishDailyRun`、`claimDigest`、`finishDigest`、`recordMail`、`saveMailState`、`setSourceHealthIn`）改在 D1 client 上跑。驗收：`schema.test.ts`、`delivery.test.ts`、daily-runs 與 outbox 的測試在替身上通過；不可改 trigger 的測試照舊紅綠；mutation：拿掉 `finishDigest` 的 `status = 'attempted'` 條件，測試失敗。這個 commit 在分支上允許紅的只有：`pnpm typecheck`、`pnpm build` 在第 2、3 類寫入路徑（`sourceBatch`、`ingest`、`ingestResendBatch`、`feedback`、`track`、`replaceSettings`、`createDigest`、`writeTransaction` 的呼叫端）的錯誤，與依賴它們的測試檔；4e2b 結束時全部綠。
    - 4e2a 實作狀態（2026-10-26，`789d83c`）：`schema.ts` 用 `sqlite-core`；migration 重產為 `0000_schema.sql`（drizzle-kit，`dialect: sqlite`、`driver: d1-http`）與手寫的 `0001_triggers.sql`（Python 的 6 個 trigger 逐字、`digest_novelty` 不可改與不可刪、`guard_failed`）。D1 專屬表：`guard(ok)`，用法是 `insert into guard (ok) select 0 where not (<條件>)`，條件成立時不寫任何列，不成立時 trigger `RAISE(ABORT,'guard failed')` 讓整批回滾（比 spike 的 CHECK 寫法少寫入）；`write_attempts(attempt_id, at)`。`db/client.ts`：`getDb()`（D1 三個 env，每次新的 client）、`Read`／`readAll`（要合併的讀取放同一個 batch，取代 `readTransaction` 的快照）、`retrying()`（只對 `outcome_unknown` 重試，用在讀取與冪等語句）、`inList`（`json_each`，spike 1f (g)）、`insertChunks`。第 1 類：`claimDailyRun` 結果不明時重送，衝突時以自己的 `started_at` 讀回判斷；`claimDigest` 不重試；`finishDailyRun`、`finishDigest`、`recordMail`、`saveMailState`、`setSourceHealth` 結果不明時重試。`createDigest` 提前在本步驟改完（`delivery.test.ts` 依賴它；簡報 D20 共同基礎第 4 點本來就不進租約）：一個讀取 batch（當天摘要、來源狀態、list 的 5 張表）→ 已通知帳本的讀取（key 從候選算出，所以另一個請求；帳本只增不改，和放同一批等價，理由寫在 `insertDigest` 註解）→ 一個寫入 batch；唯一鍵失敗（另一個 run 先寫，或回應遺失但已提交）時回傳既有那份。測試全改跑替身（`tests/helpers/db.ts`，每次 reset 一個新的 in-memory 庫並套 migration；`losingResponse` 模擬提交後回應遺失）；schema 比對加嚴成型別、預設值、主鍵、唯一鍵與 index、trigger 原文；SQLite 沒有 TRUNCATE，相關案例刪除，暫停 trigger 改成 drop 後從 migration 重建。刪除 `src/db/client.test.ts`（`writeTransaction` 鎖的測試由 4e2b 的租約測試取代；`strictSslUrl` 隨 Postgres 在 4e3 消失）。`sourcesIn`／`sourceChecksIn` 改名 `sourceStatuses`／`sourceChecks`。
    - 4e2a 允許紅的範圍比原文多一塊（原文漏列）：ops、verify 與 scripts（`src/ops`、`src/verify`、`scripts/*`、`tests/ops.test.ts`）仍是 Postgres，屬 4e3；`novelty.test.ts`、`scale.test.ts` 用收案準備資料，屬「依賴第 2、3 類的測試檔」。歸因實驗（不提交）：在 `client.ts` 暫時補一個不原子的 `writeTransaction` 後重跑，非 ops 的紅只剩 8 個原子性與回滾案例（批次中途失敗不留資料、receipt 衝突回滾、`group_feedback_atomic_and_stale`、`source_batch`），全是 4e2b 的範圍；`scale.test.ts` 在替身上通過（正式規模的摘要與帳本）。
    - 4e2a 設計審查（fresh subagent，`pi -p` 唯讀）6 項：改 4（`getDb` 不再是 process 單例，計數跟著 step；`backfillNoveltyIn` 跨 digest 每 50 句一個請求，匯入數百份 digest 不會打出數百個請求；IN 清單改 `json_each` 一個參數，取代每 90 個 key 一句的切塊；`write_attempts` 註解不再宣稱已有清理，清理排進 4e2b）、記 2（`createDigest` 兩個讀取請求的等價理由寫進註解；`In` 字尾分成 4e2b 與 4e3 各自去掉，見兩步的範圍）。
    - 4e2a 真 D1 套用（2026-10-26 19:3x，Will 授權用 spike token）：spike 資料庫已有 1f 載入的表，所以另建暫時資料庫 `freelance-agent-4e2a-check`（`14c8b98d…`，ENAM，無 replica）。結果：被擋，帳號當天（UTC）的 D1 免費寫入額度 10 萬列已用完（`7500 Your account has exceeded D1's free tier daily row write limit`，client 正確分類為 `daily_limit`、`committed: false`）；只建成第一張表。用量來源未查（推論：當天 spike 1f 與補充量測的大 batch 與全表載入）。觀察到的事實：`drizzle-kit migrate`（`d1-http`）逐句送出、不是一個 batch，失敗時不印錯誤只回 exit 1，留下半套 schema；4e3 匯入工具與 4e4 改用自己的 migrator（sqlite-proxy migrator 交給 D1 client 一個 batch，和測試同一條路徑），`drizzle-kit` 只用來 generate。不寫入的部分當晚已驗：所有 migration 語句在真 D1 上 `EXPLAIN`（只編譯、不執行，0 列寫入）都成立——28 句建表在暫時資料庫（含帶表名的 CHECK、`unixepoch()` 預設值），23 句 index 與 trigger 改名後在 spike 資料庫（它有同名的表），`guard_failed` 掛在既有表上編譯；`json_each` 當 IN 清單在 D1 回傳正確。待辦（要寫入的部分）：10-27 08:00（台北，UTC 換日）後在暫時資料庫重跑套用與檢查（schema 物件和替身逐一相同、trigger、具名 CHECK、guard 整批回滾、`unixepoch()` 預設、`inList` 250 個 key），之後用 `cf d1 delete` 刪掉它。原本列的未驗證項目：migration 在真 D1 上套用（`CHECK` 裡帶表名的欄位、`unixepoch()` 預設值、trigger 語法；替身是 SQLite 3.53，D1 版本未知），要用 `secrets/` 的 spike token 對 spike 資料庫跑 `drizzle-kit migrate`，或等 4e4 的 CI；`drizzle-kit migrate`（`d1-http`）與測試用的 sqlite-proxy migrator 寫出的 `__drizzle_migrations` 是否相容未查，4e3 匯入工具重建時要決定只用其中一條。
  - [x] **4e2b 寫入單元與並行控制**（被擋於：4e2a；2026-10-26 完成，分支 `4e-d1` 的 `e988871`，本機驗收見下方實作狀態與進度表；CI 過：PR #2 run `41551184578`（2026-11-03））：unit of work 疊加層（簡報 D20 共同基礎第 2 點的函式清單）、`writer_lease`、`write_attempts`、程式內重試；收案（`sourceBatch` 與逐筆的 4 個來源改成整個來源一個單元）、`ingestResendBatch`、`track`、`feedback`、`replaceSettings` 改寫（`createDigest` 已在 4e2a 改完）；`write_attempts` 的 7 天清理由新增它的寫入路徑負責；每日執行把 `d1_requests`、`d1_rows_written`、`lease_wait_ms` 記進 `daily_runs.result` 頂層（`getDb()` 每次給新的 client，計數只涵蓋該 step，由收尾 step 加總）；第 2、3 類讀取的 IN 清單用 `inList`（`json_each`，一個參數）、多列寫入用 `insertChunks`；收案路徑上 `In` 字尾的函式（`ingestIn`、`setSourceHealthIn`）與 `in-order.ts` 講 `lock_timeout` 的註解在改寫時一起更新。驗收：全套測試在替身上通過（含 4e2a 時因依賴收案而紅的 `novelty.test.ts`、`scale.test.ts`）；同一來源批次內重複 `external_id` 與 receipt 歸屬的測試；併發測試（UI `track` 夾在收案的讀取與寫入之間，收案重試後兩邊的改動都在）；結果不明（替身在提交後丟掉回應）時不重複寫入；租約過期被別人拿走時舊持有者的寫入被擋；mutation 各一：拿掉寫入 batch 的守衛、守衛只比 token、疊加層不回傳尚未送出的寫入、結果不明時直接重送，測試各自失敗。golden 與 `scale.test.ts` 照舊通過。
    - 4e2b 實作狀態（2026-10-26，`e988871`）：`web/src/db/unit.ts` 的 `writeUnit(db, policy, reads, run)`：第一個請求是「取得租約（`writer_lease` 的 upsert，`RETURNING token`）＋單元的全部讀取」；沒拿到時丟掉這批讀取，只用取得租約那一句輪詢（100 ms 起倍增、上限 1 秒，每日 35 秒、UI 5 秒），拿到後再讀一次（讀取可能很大，輪詢不重讀）。`run` 只能同步計算（型別排除 Promise、執行期也擋），持有租約時不能等網路或在讀取集合外讀 DB；各模組在 `Writes` 上有自己的 view（`Records`、`Receipts`、`ContentVersions`、`Trackings`），後面的步驟看得到前面尚未送出的寫入，`get` 回傳複本，沒讀過的 key 丟錯。寫入 batch：守衛（`GUARD_SQL`，比對 holder 與 token）、續期、第一批清掉 7 天前的 `write_attempts`、資料列（依外鍵深度排序；讀到不存在的列用純 INSERT，讀到存在的用 upsert，DO NOTHING 照 Python 的 INSERT OR IGNORE）、`write_attempts`、最後一批釋放。守衛失敗時從讀取重來，最多重試 3 次（0.2／0.5／1 秒加抖動）；結果不明時先重新取得自己的租約（token 加一，舊請求之後必被擋）再在同一請求讀 `write_attempts`，token 跳超過一表示有人插隊，重讀重算。上限 75 句（spike 1f (a) 量到）、4 MB；只有收案（`INTAKE_WRITE`）可以超過一個請求，依 opportunity 分批（每批自帶該批職缺的 receipt、健康狀態在最後一批），其他單元超過時在寫入前失敗。D1 client 拒送「寫入租約表但第一句不是守衛」的 batch（租約表＝schema 全部表，扣掉第 1 類的表與 D1 專屬表；之後新增的表預設要租約）。收案改成宣告式 `ingestSource(db, source, now, listings, keep(job, exists), health)`（`exists` 是單元讀到時的狀態，取代 `existingIds()`；14 個來源都改走它，4 個逐筆來源變成整個來源一個單元）；收信同步的「已知與否」改在 `ingestResendBatch` 單元內判斷（`keep` 參數），不再用租約外的 `existingSourceIds`。單筆 `ingest` 與 `existingSourceIds` 只剩 golden 重播用，移到 `web/tests/helpers/intake.ts`。`track`、`feedback`、`replaceSettings` 等 5 秒，放棄時回 409（「系統忙碌，請稍後再試」或「資料已更新，請重新載入」）。D1 錯誤在 client 依種類計數，放棄租約在單元計數；`runSource` 把儲存失敗記成 `storage_<種類>`／`storage_lease_wait`／`storage_lease_lost`，不再混成該來源的失敗原因，收信同步對儲存錯誤改成丟出讓 `runSource` 記。每日執行的 step 回傳自己的用量，收尾 step 加總後寫進 `daily_runs.result` 頂層（見共同規格）。`writer_lease` 有 `CHECK(id = 1)`（migration `0002_writer_lease.sql`）；`D1_ONLY_TABLES` 定義在 `guard.ts`，`ops/tables.ts` 轉出口。
    - 4e2b 設計審查（fresh subagent，`pi -p` 唯讀，兩輪）：第一輪 10 項，改 7（儲存錯誤另記 reason、分批只給收案並把上限改成量到的 75 句、純 INSERT 與 upsert 分開、`run` 只能同步、收案改宣告式、守衛 SQL 與表清單只留一份、單筆 `ingest` 移到測試）、記 1（DDL 與匯入的租約 API，見 4e3）、部分駁回 1（觸發要的就是每次 run 的 `lease_wait_ms`，見簡報 D20「終點與觸發」；逾時另外計數）、駁回 1（守衛檢查留在 D1 client 而不是 `dbOver`：直接呼叫 `client.batch` 的路徑，例如測試的 `query()` 與 4e3 匯入工具的 raw statement，也要受檢查，不留豁免口）。第二輪核對第一輪處置都在程式裡，另 5 項：改 3（錯誤與放棄租約在發生處計數並寫進 result 頂層、`lost_steps` 標出總數是下界、`writer_lease` 加 `CHECK(id = 1)`）、記 1（觸發條件由誰讀，見下方待決）、駁回 1（`Listing` 的 receipt 與 job 分開：golden 重播要用和 job 欄位不同的 receipt，改成只收 jobs 會多一個只給測試的入口）。
    - 4e2b 交接：(1) 4e3 的匯入工具要一個跨多個請求、每批續期的租約 API（`writeUnit` 只有收案能分批，而且要事先讀完；`Writes.statement()` 只給測試 fixture），並決定 DDL（`DROP TABLE`、`CREATE`）在租約表上要不要也要求守衛（現在 client 只檢查 insert／replace／update／delete），4e3 開工時定。(2) 10e1 的改設定整份重算不是收案，不能分批：要在 75 句、4 MB 一個請求內（投影 2,450 列在 spike 1f (a) 是 75 句，加上 5 句簿記會超過），否則先在 spike 資料庫量更大的 batch 失敗點再定上限。(3) UI 的 409 在步驟 11 前沒有呼叫端，只有 `console.warn`；步驟 11 決定 UI 的放棄租約記在哪裡。(4) 觸發條件逐次檢查（Will 2026-10-26 選）：`web/src/ops/storage-triggers.ts` 讀每次執行的 `daily_runs.result`，等租約超過 2 秒、任一次租約逾時或被搶（D20）、任一次 429 或超過 600 個請求（D21）就標出，`lost_steps` 另外標「總數是下界」；`scripts/check-storage-triggers.ts` 只印日期、訊號與數字，有訊號時 exit 1（`253fb17`）。4e3 把它接進 VM 的 after job。(5) 接受的差異（D17）：逐筆的 4 個來源中途失敗時不留任何一筆；`keep` 對同一批內重複的 `external_id` 用單元讀到時的狀態（和舊的 `existingIds()` 一樣）；收案的 `now` 每個單元一個。
  - [x] **4e3 ops 與 VM 腳本**（被擋於：4e2b；2026-10-26 完成，分支 `4e-d1` 的 `fd88c11`、`7a4942c`，本機驗收見下方實作狀態與進度表；CI 過：PR #2 run `41551184578`（2026-11-03）；真 D1 的匯入在 CI `d1` job 過）：converge 改成一次性的匯入工具「SQLite 副本 → D1」（取租約（跨多個請求、每批續期的租約 API 與 DDL 是否要守衛，見 4e2b 交接 (1)）；after job 另跑 `check-storage-triggers.ts`（4e2b 交接 (4)）；`DROP TABLE` 後依 migration 重建、全載、重建帳本、表集合與筆數報告），4e4 載入 shadow 與步驟 13 載入正式資料庫都用它；中斷時重跑（冪等），驗證報告通過才放行。VM 的 morning job 改成只拍副本（不收斂）；after job 改成：replay 對當天 Python 的 after 副本跑本機替身（不碰 D1）、`check-novelty` 直接以唯讀查詢讀 D1 的帳本與當天摘要；即時比對器（`compare.ts`）不再排程。`shadow-job.sh`、`deploy/compose.shadow.yaml`、`deploy/shadow.Dockerfile`、`deploy/systemd/freelance-shadow-{morning,after}.service`、`replay-digest.ts`、`check-novelty.ts` 換 env 與輸入。驗收：`ops.test.ts` 在替身上通過（匯入冪等、中斷後重跑、帳本重建、表集合檢查、匯入後與來源逐表相同）；replay 測試在替身上通過（相同、竄改、無 digest、inconclusive）；replay 直接在替身上呼叫 `createDigest`（`createDigestIn` 已刪）；`ops/tables.ts` 的 `IDENTITY_COLUMNS`（Postgres sequence）在 SQLite 上刪除或改寫；`checkNoveltyIn`、`backfillNoveltyIn`、`rebuildNoveltyIn` 去掉 `In` 字尾；`check-novelty` 讀不到當天摘要時報錯而不是報通過；匯入報告記 `d1_rows_written`；mutation：匯入不重建帳本、匯入漏一張表，測試各自失敗。
    - 4e3 實作狀態（2026-10-26，`fd88c11`、`7a4942c`）：converge 換成 `web/src/ops/import.ts` 的 `importCopy`（`scripts/import-copy.ts --sqlite <副本> --confirm-drop <database id>`）：表集合檢查 → `migrateD1` → 在 `withLease`（`web/src/db/unit.ts`：跨多個請求的租約，`send` 自己依 75 句、4 MB 打包，每個請求守衛並續期，結束或失敗都釋放；不處理結果不明，任何失敗就整個失敗、重跑）之內：反向載入順序 `DROP TABLE IF EXISTS` 產品表與衍生表 → 依 SQLite 自己的目錄（用同一份 migration 建出的空替身的 `sqlite_master`）重建表、index、trigger → 全載（值的型別要和欄位宣告相符；整數以文字送、`cast(… as text)` 讀回；不再限 int32 與 NUL，1f (e) 量到 D1 往返相同）→ 重建帳本 → 逐表筆數與 sha256 報告、`d1RowsWritten`。D1 專屬表與 migration journal 不動。中斷時重跑（測試：第 3 個請求斷線後重跑通過）。migration 只經 `migrateD1`（一個請求；已有 `writer_lease` 時走租約，否則 ALTER／DROP 租約表的 migration 會被 client 拒送，也可能和每日執行交錯），`db:migrate`（drizzle-kit）刪除，`drizzle.config.ts` 不再有 driver 與憑證；部署前跑 `scripts/migrate.ts`。DDL 守衛（4e2b 交接 (1)）：租約表上的 `DROP TABLE`、`ALTER TABLE` 要守衛，`CREATE` 不要（migration 要在 `writer_lease` 存在前建表）。replay（`web/src/verify/replay.ts`）改在每次新的 in-memory 替身上跑：migration → 載入副本（扣當天 digest）→ 重建帳本 → `createDigest`，不碰 D1 也不碰副本。`check-novelty` 改成唯讀查 D1 的 `checkLedger`（`services/digest.ts`），沒有當天以後的 digest 就失敗。VM：morning job 只拍副本；after job 跑 replay、check-novelty、`check-storage-triggers`（4e2b 交接 (4)）；shadow env 換成 `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`D1_API_TOKEN`；一次性載入的指令寫在 `deploy/compose.shadow.yaml`。即時比對器（`ops/compare.ts`、`scripts/compare.ts`）與它的測試刪除（main 上的 Neon 版照跑，它的窗口在 Neon 結束）；`IDENTITY_COLUMNS`、`TableSpec` 的 `volatile`／`match` 刪除；`checkNoveltyIn`／`backfillNoveltyIn`／`rebuildNoveltyIn` 去掉 `In`。`AGENTS.md`（分支上）：`web/` 測試不需要資料庫。
    - 4e3 設計審查（fresh subagent，`pi -p` 唯讀）7 項：改 4（正在運作的 D1 沒有套 migration 的入口 → `scripts/migrate.ts` 並寫進部署順序；DDL 守衛會擋 migration → migration 走租約；用 regex 重放 migration 歷史 → 改讀 `sqlite_master`；匯入自己重寫一套打包 → `withLease` 打包、`inserts` 用 `insertChunks`；另把帳本重建與報告移進租約內）、改 1（`drizzle.config.ts` 拿掉 `d1-http` 與憑證，`pg` 依賴留到 4e4 和 CI 一起拿）、記 1（租約只擋產品寫入單元，不擋第 1 類寫入者與讀取：重載與步驟 13 要停 cron 或避開 09:00–09:59）、提 1（每天的 VM job 改用 D1 Read token，見下方待決）。
    - 4e3 交接：(1) 4e4 的順序加上 `scripts/migrate.ts`：建 shadow D1 → `import-copy`（內含 migration）→ 部署 Vercel → 換 VM 映像；之後每次有新 migration（10e1 的投影表起），先跑 `scripts/migrate.ts` 再部署（10b2 部署順序「隔天 08:30 converge 用新 migration 建表」在 D1 上不再成立）。(2) 4e4 移除 `pg`、`@types/pg` 與 CI 的 Postgres service（`TEST_DATABASE_URL`），CI 改跑替身加真 D1 整合測試。(3) 重載 D1 shadow 與步驟 13 的正式載入：停 cron 或避開 09:00–09:59；載入期間沒有讀取隔離，報告 ok 前不要用。(4) Will 2026-10-26 決定：VM 每天的 job 與匯入用同一把讀寫 token（不另建 D1 Read token）；步驟 13 的正式載入不記 Time Travel bookmark。(5) 真 D1：2026-10-26 22:xx 量到帳號當天寫入額度仍用完（7500 daily row write limit；`CREATE TEMP TABLE` 回 `SQLITE_AUTH`，不能用暫存表繞過），所以要寫入的檢查只能等 UTC 換日（台北 08:00）。不寫入的部分當晚已驗：新語句的形狀在 spike 資料庫 `EXPLAIN` 全部編譯成立（0 列寫入：`0002_writer_lease.sql`、租約取得的 upsert＋`WHERE`＋`RETURNING`、續期與釋放、守衛的 `not exists`、`write_attempts` 清理、drizzle 的帶表名衝突目標、多列 DO NOTHING、`drop table if exists`、`cast(… as text)` 讀回、`sqlite_master` 讀 DDL），`pragma table_info` 與 `sqlite_master` 在 D1 可讀（`pragma` 的型別回大寫，`columnsOf` 已轉小寫）。要寫入的部分寫成 `web/tests/d1-real-product.test.ts`（清空資料庫、migration、schema 物件與替身逐一相同、租約等待與 fencing、`json_each` 250 個 key、匯入報告 ok、列寫入 ≤ 2,000；只在 `D1_DESTRUCTIVE_TEST` 等於 `D1_DATABASE_ID` 時跑，替身上試跑 5 個全過），08:00 後對暫時資料庫 `freelance-agent-4e2a-check` 跑，之後 `cf d1 delete` 刪掉它。
  - [ ] **4e4 CI、合併、上 shadow**（被擋於：4e3、Will 授權部署）：CI 跑一組對真 D1 的整合測試（batch 原子、守衛、租約、速率計數、每次最多 2,000 列寫入；專用測試資料庫，fork 的 PR 不跑）；合進 main；換過去的順序（避開 09:00–09:59 的 cron）：前一天晚上建 shadow D1、用 4e3 的匯入工具載入當晚的正式副本並驗證報告、部署 Vercel（env 換成 D1 三個 key、移除 `DATABASE_URL`）、換 VM 映像與 shadow env；隔天 09:xx 的 TS run 在 D1 上。驗收：CI 綠；匯入報告 ok；隔天 TS run `complete` 或只有來源失敗、after job 的 replay 與 check-novelty 跑完。
    - 回滾窗口內（到 4e4b 結束、Neon shadow branch 刪除前），VM 的 shadow env 檔同時保留 Neon 與 D1 兩組設定；回滾是 Vercel promote 回前一版、VM 的 `SHADOW_IMAGE` 改回原值。刪 Neon 資料要 Will 授權。
    - 進行中的比對窗口（Will 2026-10-26 要求盡快上 shadow，取代原本「排在 10-31 之後」）：replay 的 7 天窗口在 D1 上照算（它在 VM 本機跑，不受 D1 影響）；即時比對器的窗口見共同規格「D1 shadow 不每天收斂」。
    - 已授權（Will 2026-10-26）：把正式副本（VM 08:30 拍的正式 SQLite 快照，和現在每天載入 Neon shadow 的是同一份）載入 D1 shadow（一次；之後重載每次先問）；token 用現有的那把。
    - 需要人做的事：把 token 放進 Vercel、VM 的 shadow env 檔、CI 的 GitHub secrets（agent 從 `secrets/` 直接餵進指令、不印值，動手前問一次）；授權部署 Vercel 正式專案與更新 VM shadow 映像；spike 結束後刪 spike 資料庫。
    - 4e4 上 shadow（2026-11-03 10:0x–10:5x，Will 授權「現在部署」與刪 `freelance-agent-4e2a-check`）：程式完成待驗收（驗收的「隔天 TS run」與 after job 要等 11-04）。CI：GitHub secrets 三個（`D1_TEST_DATABASE_ID` 指向新建的 CI 專用庫 `freelance-agent-ci-test`）；PR #2（`4e-d1`→dev，merge `8cb4635`）綠；release PR #3 第一輪 `d1` 紅：測試清空資料庫走 client，DDL 守衛擋下租約表的 `DROP TABLE`，所以同一個庫只有第一次能跑；`87ab392` 改走 transport，本機對已用過的 CI 庫 6 過，CI 推送與 PR 兩輪先後對同一個庫都綠；PR #3 merge 進 main `6c33182`。D1：刪 `freelance-agent-4e2a-check`；建 shadow 庫 `freelance-agent-shadow`（ENAM、無 replica，名稱刻意不符 `-(check|test)$`，破壞性測試會拒絕它）。VM：映像 `freelance-agent-shadow:8cb4635`（另 tag `:6c33182`；兩者之間映像用到的 `web/src`、`scripts`、`drizzle`、`deploy`、lockfile 無差異），`/opt/freelance-shadow` checkout `6c33182`；新 env 檔 `/etc/freelance-agent/shadow-d1.env`（root 0600：D1 三個 key＋`PORTFOLIO_CATEGORY_PROJECTS`），舊 `shadow.env`（Neon）保留；10:30 after job 跑完後用它的副本 `2026-11-03-1030.sqlite3` 一次匯入：26 張表 `same`、`digest_novelty` 5831 rebuilt、`d1_rows_written` 28814、`import ok`（報告 `/var/lib/freelance-shadow/reports/import-2026-11-03.json`）；`shadow-compose.env` 改 `SHADOW_IMAGE=freelance-agent-shadow:6c33182`、`SHADOW_ENV=/etc/freelance-agent/shadow-d1.env`（備份 `shadow-compose.env.bak-c247200`），`docker compose config` 過。Vercel：production env 加 `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`D1_API_TOKEN`（sensitive），刪 `DATABASE_URL`，`vercel env ls production` 是 8 個名稱、無寄送憑證；`6c33182`（`web/` 與部署時本機 tree 相同）部署到正式專案 `freelance-agent-fpy1yk482`，alias 不變，alias 與部署網址的 `/api/cron` 未登入 302。回滾：Vercel promote 回 `freelance-agent-5knxy7mjg`（它帶部署當時的 `DATABASE_URL`）；VM `cp shadow-compose.env.bak-c247200 shadow-compose.env`。同日舊映像最後一次 after job：replay same（66 項）、novelty 帳本 same，但即時比對器 `opportunities` 有 1 項 logic 差異，job exit 1（11-01 也一樣）；比對器在 4e3 已刪，不追。未跑：11-04 09:xx 的 TS run 在 D1 上 `complete`（或只有來源失敗）、10:30 after job 的 replay、check-novelty、check-storage-triggers。「在 4e4 合併時一起改寫的段落」同日改寫。
    - 4e4 準備（2026-10-26 23:3x，分支 `4e-d1` 的 `afebf31`；不需部署授權的部分，CI 過：PR #2 run `41551184578`（2026-11-03））：CI 的 `web` job 拿掉 Postgres service 與 `TEST_DATABASE_URL`；新增 `d1` job（`pnpm test:d1` = `d1-real-product` 與 `d1-real` 兩檔；fork 的 PR 不跑；`concurrency: d1-real` 一次一個，因為每次都清空同一個資料庫；secrets 缺任一個就失敗，不讓測試自己 skip 成綠）。要的 GitHub secrets：`CLOUDFLARE_ACCOUNT_ID`、`D1_TEST_DATABASE_ID`、`D1_API_TOKEN`；CI 專用資料庫要命名成 `freelance-agent-<…>-test`（例如 `freelance-agent-ci-test`）：`d1-real-product` 在 `beforeAll` 用 Cloudflare API 讀資料庫名稱，不符 `^freelance-agent-[a-z0-9-]*-(check|test)$` 就整組不跑（CI 兩個 env 取自同一個 secret，id 相等的檢查擋不住填錯 id，而 shadow 與之後的正式資料庫在同一個帳號）。假 token 實測：401 時 5 個測試全部沒跑、exit 1。`pg`、`@types/pg` 移除（lockfile 用 pnpm 11.2.2 產生，和 CI、shadow 映像同版）。本機：actionlint 0、`pnpm typecheck` 0、`pnpm boundaries` 過、全套 37 檔 438 過 6 skip、`pnpm build` 0。
  - [ ] **4e4b D1 shadow 觀察 3 天**（被擋於：4e4）：驗收：連 3 天 TS run 在 D1 上結束（`daily_runs` 有當天那列）、replay same 或差異逐項解釋、check-novelty 0 缺 0 多；每日請求數與列寫入（`daily_runs.result` 的 `d1_requests`、`d1_rows_written`）記進進度表；之後刪 Neon shadow branch（Will 授權）與 VM env 的 Neon 那組。
  - 消費端（2026-10-26 量）：`rg -l '@/db/client|\.\./src/db/client' web/src web/scripts web/tests`（38 個檔）；`rg -l '@/db/schema|db/schema"' web/src web/scripts web/tests`（12 個）；`rg -n 'writeTransaction|readTransaction' web/src web/scripts`；`rg -n 'pg_advisory|::text|::jsonb|jsonb|any\(|COLLATE|to_char|lock_timeout|plpgsql' web/src web/scripts web/drizzle -g '!**/meta/**'`；`rg -n 'DATABASE_URL|from "pg"|"pg"|db:migrate' web deploy .github AGENTS.md -g '!**/node_modules/**'`（含 `web/package.json` 的 `pg` 依賴與 `db:migrate`、`web/.dependency-cruiser.cjs`、 `deploy/compose.shadow.yaml`、`deploy/shadow.Dockerfile`、VM 的 shadow env、`web/scripts/verify-fingerprints.ts`、`.github/workflows/ci.yml` 的 postgres service、`web/tests/helpers/db.ts`、`web/drizzle.config.ts`、`AGENTS.md` 的 `TEST_DATABASE_URL`、步驟 11 離線 demo 的 PGlite）。
  - 不能動：已存雜湊與 `external_id`（N2）；snapshot 位元組；10c 的寄送語意（claim 先提交、不確定不重試）；VM 上的 Python 正式系統。
  - 受影響、在 4e4 合併時一起改寫的段落（2026-11-03 已改寫）：全域約束的 production env 白名單（步驟 5 的驗收看 `vercel env ls` 的 key）、Goal（「代管的 Postgres」）、範圍（Postgres schema、SQLite ↔ Postgres 收斂）、前提的環境（Neon 專案）、不變量表（唯一約束、advisory lock、trigger、text JSON、demo 的 PGlite）、步驟 11（demo 改 `node:sqlite`）、12（反向腳本：在停用 cron 後匯出到本機 SQLite，再照原本的 upsert 規則回寫）、13（D1 沒有資料庫角色，runtime 角色與 REVOKE 那個前置決定要改寫；回滾評估 D1 Time Travel）、14（Neon 退役）、`AGENTS.md` 與 README 的驗證段。
  - 完成後的狀態：10e1 在 D1 上做（Postgres 版的參考 commit `48b4dd6`，分支 `wip/10e1-postgres-projection` 已於 2026-11-03 刪除）；D13 的 Neon 傳輸預算改成 D1 的每日列讀取與列寫入預算。

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
      - 第 2 天 2026-10-26（10:30:36 報告；after job exit 1，原因見本條末）：範圍 25 個來源（TS run 實際跑的，含 6 個信件來源）；logic 1、timing 12、user_action 0。opportunities Python 49／TS 55／相同 49，source_receipts 49／55／49，source_health 2／1／1，mail_sync_state 6／6／6，mail_ingestion 8／8／8；`daily_runs`、`digest_outbox` 各 2 筆範圍外。timing 12 筆都是只有 TS 有的列：opportunities 6、source_receipts 6（himalayas 5、remoteok 1；source_receipts timing 6，照上面 receipt mutation 的弱點記），TS 比 Python 晚約 13 分鐘抓，看到較新的職缺。jobicy、remotive 0 差異。logic 1 筆是 `source_health` 的 weworkremotely 只有 Python 變動：Python 09:01:34 抓失敗記 failed（`public_feed_unavailable_or_unsupported`），TS 09:14:51 抓到 95 筆、記 ok（和 08:30 起點相同，所以 TS 端沒有變動）。以抓取時間差解釋（量到兩邊的 `checked_at` 與 TS 的 `seen`），不觸發停止條件；比對器把單邊 failed 的 health 歸 logic 是刻意的（TS bug 讓失敗來源看起來 ok 時也是這個形狀），所以這類日子要人工解釋，after job 會 exit 1。
    - 範圍擴大（2026-10-25 13:0x，Will 授權提前部署，不等 7 天比對）：步驟 7 與步驟 8 第 1–3 批一起排程，`920b6b4` 部署到正式專案（`freelance-agent-4yenxxd50`，alias 不變；env 仍同樣 4 個 key、`/api/cron` 未登入 302）；VM `/opt/freelance-shadow` checkout `920b6b4`，`SHADOW_IMAGE=freelance-agent-shadow:920b6b4`（回滾改回 `:afa8b10`），映像內 `enabledSources()` 為 16 個來源。所以第 2 天起的比對範圍是 16 個來源，不只 jobicy、remotive；步驟 6 的 7 天比對與步驟 7、8 的比對從同一天起算。這次部署一起帶上依序執行的 fan-out（`eb434e3`）。
    - 最後一批部署（2026-10-25 16:3x，Will 授權）：`82cd89d`（CI 綠燈）部署到正式專案（`freelance-agent-cmpwe77c1`，alias 不變；env 仍同樣 4 個 key、`/api/cron` 未登入 302）；VM `/opt/freelance-shadow` checkout `82cd89d`，`SHADOW_IMAGE=freelance-agent-shadow:82cd89d`（回滾改回 `:920b6b4`）。映像內 `enabledSources()` 19 個（實測），比對器範圍改讀 TS run：用映像對 10-25 的副本另跑一次（報告寫到容器暫存，不覆蓋正式報告），讀出範圍 `jobicy, remotive`，就是當天 TS 實際跑的來源，logic 0、timing 0，和第 1 天報告相同。10-26 起 TS 跑 19 個來源，最後一批的 3 天比對從 10-26 起算。
    - 未跑：7 天比對第 3–7 天（10-27 至 10-31）。
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
    - 9b 實作狀態（2026-10-25，未排程、未部署）：`mail/cake.ts`、`jobbank104.ts`、`talent.ts`、`glassdoor.ts`，共用件在 `mail/common.ts`；主旨 gate 由各 parser 模組匯出、`SUBJECT_GATES` 只組裝；`platform/py/html.ts` 補 `handle_comment`（talent 靠註解切欄位；含 close() 時未結束的 comment）；`platform/py/url.ts` 的 `queryValues` 照步驟 8 的決定用 `URLSearchParams` 解碼，只保留 Python 的兩個拒收（`max_num_fields`、`strict_parsing` 的空欄位或缺 `=`）與 `keep_blank_values=False` 的丟空值。cake 的追蹤連結：base64url 只有長度多一個字元才失敗、`node:zlib` 的 `inflateSync` 以 `maxOutputLength` 8192 加 `bytesWritten` 檢查「恰好一個 stream、沒有剩餘」（Node 會默默忽略尾端資料，量到）。驗證：golden 新增 html comment 事件 68、canonical cake 52／talent 19／glassdoor 18、parser cake 35／104 40／talent 59／glassdoor 43、主旨 gate 64、read_notification 20、sync 情境 6（4 個來源各 waiting→ok→重播→隔離，另 2 個）；mutation 16 項全紅，第一輪存活 4 項（base64 長度、talent 結尾連結深度、丟空值、沒有值的 class）補案例後失敗。設計審查（fresh subagent）5 項全改：parser 不再照抄 Python 的例外類別（呼叫端只看成敗，同 9a）、`parse_qs`／`unquote` 原樣移植改回 `URLSearchParams`（第一版推翻了步驟 8 的決定卻沒寫理由）、步驟 14 補 9b 的照抄、主旨 gate 不再重寫兩份、盤點 §1.2 的 jobbank104 列更正為「整封拒收」。
    - 上 shadow（2026-10-25 19:5x，Will 授權存憑證與部署）：在 VM 上用正式 key 呼叫 Resend `POST /api-keys` 建專用 key `freelance-agent-vercel-shadow`（`full_access`，id `f6ff204b-c4cd-478a-bae8-c7c2b83c4dd9`），token 經管線直接送進 `vercel env add RESEND_API_KEY production --sensitive`，送入前用它 GET `/emails/receiving?limit=1` 回 200（實測）；`RESEND_INBOX` 由 VM 的 worker 設定直接送入。值都沒有顯示。`vercel env ls production` 為白名單內的 6 個名稱，全部 `sensitive`、只在 production。正式 worker 的 `sources` 清單含全部 6 個信件來源，所以 6 個都排程：`f23f052`（CI 綠燈）部署到正式專案（`freelance-agent-2cqsaiyx1`，alias 不變；`/api/cron` 未登入 302）。比對器範圍讀 TS run（步驟 6「比對範圍」），VM 映像不用換（仍是 `:82cd89d`）。當天的 run 已跑過，信件來源第一次自然執行是 10-26，3 天比對從 10-26 起算。回滾：從 `SCHEDULED` 拿掉 6 個信件來源並重新部署；撤銷 key 照 D14 的外洩處置。
    - 記：`readNotification` 對每筆職缺跑一次 `qualify` 並丟掉結果，只因 Python 的 `preview()` 會算，算的時候丟例外就讓整封信變 rejected（stage template）。切換前必須一致；D6 後併入下面步驟 14 的 9a 照抄一起處理。

- [ ] **10. 摘要建置與寄送路徑（shadow 只建不寄）**（被擋於：步驟 9、D9）
  - **2026-11-03 起被 D22 取代**（Will：不建摘要、不寄信）：10a（來源結果）與 10e（投影）保留並繼續；10b、10b2、10c 的程式由新的 10f 刪除，下面的實作紀錄保留為歷史；10d 取消；驗收改成只看 10a、10e、10f。
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
    - shadow 7 天的候選清單與 Python 實寄的 snapshot 在同一起點下比對一致；10e 之後（D17）改成差異逐項列在 replay 報告、每項有解釋並經 Will 接受。
    - mutation：讓寄送 step 允許重試，測試要失敗。
  - 子步驟（2026-10-25 拆，一個 session 做不完；各自有驗收，依序做）：
    - 10a 來源結果帶進 `daily_runs.result`：runner 契約定成 `SourceDetail`（`status`、`reason`、`scope` 是字串，其餘只能是非負整數、布林或 null；正文與清單不能進來，因為它是 step 的回傳值）。`runSource` 回傳整份 detail，runner 丟例外時記 `{status: failed, reason: source_unavailable}`（Python 的同一情況是整個 `collect_sources` 中止、只記一筆頂層 `source_unavailable`；TS 依 D2 逐來源隔離，這個差異是既定的）。`finishDailySources` 寫出和 Python `collect_sources` 同形的 `source_details`：頂層 `status`、`reason`（`one_or_more_sources_failed` 或 null），加上每個來源一個 dict。`ranSources` 改成只取值是 dict 的 key，頂層的 `status`、`reason` 不算來源。驗收：`runSource` 保留 runner 的計數、例外記 `source_unavailable`、非計數欄位被擋；`ranSources` 對 Python 同形的 result 只回來源名稱。mutation：`ranSources` 不過濾非 dict、`runSource` 丟掉計數，測試各自失敗。
    - 10a 實作狀態（2026-10-25，本機完成，未部署）：`run-source.ts` 的 `SourceDetail`／`detailDict`／`succeeded`，`SourceRunner` 收緊成必須回傳 `PyDict`；各來源的失敗 reason 在 `registry.ts` 的 `FAILURE_REASON`，golden 新增 `failure_reasons`（Python 每個非信件 sync 在 urllib 與 socket 都斷網時的實際回傳，21 個），測試逐一對照，不手抄；`syncInOrder` 改成泛型，死掉的 step 記 `source_unavailable`；`ranSources` 只取值是 dict 的 key。驗證：`pnpm typecheck`、`pnpm boundaries`、`pnpm build`、`pnpm test` 29 檔 344 個全過；mutation 5 項全紅（`ranSources` 不過濾、`runSource` 丟計數、錯一個來源的 reason、非法值改成 null 而不拒收、拿掉頂層 reason）。code review（low）2 項：「非 dict 結果改判失敗」改成型別結構性擋住；「識別字以外的字串整筆拒收」駁回——逐一核對所有 connector 的 `scope`／`reason`／`error_stages` 都是識別字，拒收是刻意的（step 回傳值不能帶內容）。部署跟 10b 一起。
    - 10b 摘要 snapshot 建置（shadow 會寫 `pending` 的 `digest_outbox`）：`createDigest`／`findDigest`／`getDigest`（`notifications/store.py`）、`render`（`digest.py`），每日流程照 `run_daily`：claim 後若當天已有 digest 就不跑來源（`existing_digest`），否則跑完來源再建 digest，result 欄位同 Python（`status`、`local_date`、`intent_id`、`source_status`、`source_reason`、`source_details`、`candidates`、`delivery_status`；沒有 `output`，TS 不寫檔）。驗收：golden 用 Python 在合成情境產生 snapshot 與 render 的 HTML，TS 逐位元組相同；「過期日期不執行」與「同日不重寄」的 TS 測試。同一起點的比對（步驟 10 驗收第 2 項）：VM 的 after 服務新增 replay——在 shadow DB 的單一交易裡建暫用 schema、載入 Python 當天 after 副本（去掉當天的 `digest_outbox` 列）、用 Python snapshot 的 `generated_at` 跑 `createDigest`、逐位元組比 snapshot，最後 rollback，不留任何資料；7 天全相同才算過。live 比對器維持不比 `daily_runs`／`digest_outbox` 的內容（兩邊抓取時間不同，候選必然不同），由 replay 負責。mutation：novelty 不讀 `attempted`／`unknown` 的舊 snapshot，golden 要失敗。需要人做的事：授權部署到 Vercel 正式專案、更新 VM 的 shadow 映像。
    - 10b 實作狀態（2026-10-25，本機完成，未部署）：`notifications/digest.ts`（`render`、`safeUrl`；`html.escape` 補在 `platform/py/html.ts`）、`notifications/outbox.ts`（`findDigest`／`getDigest`／`insertDigestIn`，以及 10c 會用到的 `claimDigest`／`finishDigest`）、`services/digest.ts`（`createDigest`／`createDigestIn`）、`services/daily.ts` 的 `finishDaily`（workflow 收尾 step 改呼叫它）。和 Python 的刻意差異：result 沒有 `output`（TS 不寫檔）；`finished_at` 記實際完成時間（Python 用開始時間，兩欄對比對器都是 volatile）。驗證：golden 新增 `digest_novelty_and_uncertain_delivery` 情境（38 步，含 sent 無 receipt、attempted、unknown、pending 不抑制、跨收件者，最終 `digest_outbox` 逐列比對）、`digest_render` 12 例、`daily_run` 4 例（ok／failed／reused／render 失敗，Python 真的跑 `run_daily`），TS 全部逐位元組相同；`pnpm typecheck`、`pnpm boundaries`、`pnpm build`、`pnpm test` 30 檔 365 個全過（審查修正後重跑見下）。mutation 20 項全紅，第一輪存活 4 項補案例後失敗（180 字邊界、`taiwan_eligible` 非 True 的 truthy 值、以 UTF-16 長度截斷、跳過 render——最後一項證實 render 呼叫是必要的：list 的 `kind` 能過收案但不能 render，Python 因此把當天記成 `daily_processing_failed`）。
    - replay 的實際做法（取代上面「暫用 schema」的寫法，因為 migration 的 FK 寫死 `"public".`）：在 shadow DB 的交易裡為每張表建 `create temporary table … (like public.x including all) on commit drop`，未加 schema 前綴的表名會先找 `pg_temp`，產品程式只讀寫副本，最後 rollback；public 的列與保留用 trigger（含擋 TRUNCATE 的那個）完全不碰。前提：Drizzle 產生的 SQL 不加 schema 前綴、`createDigest` 不依賴 FK 或 trigger（`LIKE` 不複製這兩者）；守住它的是測試「replay 後 shadow 的列數不變」與「拿掉暫存表就失敗」的 mutation。08:30 與 after 副本之間 Will 改過 user 表（`opportunity_tracking`、`tracking_events`、`discovery_settings`、applications 等）時，replay 報 inconclusive（`equal: null`、列出表名），不報 DIFFERENT，因為 Python 的 digest 可能建在那次操作之前；7 天驗收只計結論為相同或不同的日子，inconclusive 的日子不算、順延。程式在 `web/src/verify/replay.ts`（獨立的 verify 層：只准用 `services/digest.ts`，產品與 ops 都不能 import 它）與 `scripts/replay-digest.ts`，after 服務在比對器之後執行它，任一失敗整個 job 失敗。
    - 10b 部署後實測（2026-10-25 22:3x–23:0x，VM shadow 映像，10-25 的真實副本）：第一次 replay 報 DIFFERENT，104 筆對 104 筆，差異只在 `evaluation.portfolio_ids`（shadow 容器沒有 `PORTFOLIO_CATEGORY_PROJECTS`，TS 用合成 ID）。帶真實作品對應重跑時，`createDigestIn` 超過 10 分鐘仍未完成（量到；Vercel 收尾 step 上限 300 秒）。V8 profile 顯示 96% 在 libc，JS 熱點在 `groupItems` 與 `unseen`：`unseen()` 每個候選都把整個 `seen` 展開重建 id 集合，`groupItems` 的相容性檢查每對成員都重算 `text()`（NFKC＋casefold；Python 這兩處是 C 實作）。修正（行為不變，golden 不動，兩個 mutation 會紅）：`seenIds` 每次建摘要只算一次；`groupItems` 每筆職缺的比對欄位只正規化一次。修正後同一份資料：建摘要 12 秒，snapshot 與 Python 逐位元組相同（量到）。為什麼只有真實作品對應會觸發：推論，未查明（可能和排序改變後的合併順序有關）。事後用合成的正式量級資料（2,500 筆職缺、60 天歷史，每筆 6 個 novelty key）分開量兩個修正（Mac）：novelty 抑制在舊寫法 28 秒、新寫法 1.7 秒，是主因；`groupItems` 的正規化快取在每組 5 筆時只快約 1.4 倍（1.67 → 1.18 秒），保留是因為行為不變，但它沒有會紅的 mutation。守住它的是 `web/tests/scale.test.ts`（CI 跑）：分組 10 秒、novelty 抑制 5 秒、整個 `createDigest` 60 秒三個上限；抑制的那段抽成純函式 `selectUnseen`，資料庫時間不放進緊的上限（量到 7–15 秒的跳動）。mutation：改回每個候選重建 id 集合，測試失敗。
    - 歷史摘要的儲存與重複（2026-10-26 量 10-25 正式副本，只算計數）：`digest_outbox` 39 列、11.2 MB（09-17 起）；snapshot 共 2,406 筆、2,343 個不同 ID；重複出現的 63 筆是內容改版後重新通知（設計如此），同 ID 同指紋的只有 10 筆、43 KB（0.4%）。`opportunities` 2,395 列，`(source, external_id)` 沒有重複（唯一約束）。snapshot 存整份 item 是不變量要求的寄送證據（寫入後不可變、逐位元保存），不改成引用。

    - 10a＋10b 上 shadow（2026-10-25 23:2x，Will 授權部署與 VM 設定）：`a5b2e6c`（CI run 40206008208 綠）部署到正式專案（`freelance-agent-8h6bndpwp`，alias 不變；`vercel env ls production` 仍是白名單 6 個名稱；`/api/cron` 未登入 302）。先前同晚部署的 `3add463`（`ecohqwuzp`）被它取代。VM：`/opt/freelance-shadow` checkout `a5b2e6c`，`SHADOW_IMAGE=freelance-agent-shadow:a5b2e6c`（回滾改回 `:82cd89d`，備份 `shadow-compose.env.bak-3add463`、`.bak-82cd89d`）；`/etc/freelance-agent/shadow.env` 新增 `PORTFOLIO_CATEGORY_PROJECTS`（值由本機 `portfolio.json` 的 `category_projects` 經管線寫入、未顯示，備份 `shadow.env.bak-a5b2e6c`），replay 需要它才會算出和 Python 相同的 `portfolio_ids`。驗收：新映像加新 env 對 10-25 副本跑 `replay-digest.ts` → same（104 對 104 筆），整個 job 35 秒（量到）。shadow 第一次自然建摘要是 10-26，replay 與候選清單的 7 天比對從 10-26 起算。回滾：Vercel 重新部署 `2cqsaiyx1`；VM 把 `SHADOW_IMAGE` 改回 `:82cd89d`、`shadow.env` 換回備份。
    - 10b 設計審查（fresh subagent）9 項：改 5（replay 的 user 表 inconclusive；`finished_at` 用實際時間；reused 分支的註解改成實際觸發條件——TS 裡只有人工刪掉 run 列、或副本有 digest 沒有 run 時才會走到，claim 之後崩潰會停在 running、隔天是 already_run；render 呼叫的註解寫明理由與移除時機（10c 把組信接進 `finishDaily` 時由組信取代）；replay 從 ops 層移到獨立的 verify 層，不在 ops 規則上開單檔例外）、記 3（下一條）、盤點更新 1（§4、§5b、§5c 與測試列的去向改成實際路徑）。
    - 記：reused 時 `source_details` 只有 `{status: <tasker 的健康狀態>}`，是 Python 只有 Tasker 一個來源時期的寫法（`daily.py:46`），`ranSources` 讀這天會得到零個來源而 fail closed；切換前照規格保留，步驟 14 刪 `backend/` 時改成從 snapshot 的 `sources` 重建 `collect_sources` 同形的 dict。`FAILURE_REASON` 和 runner 分兩處維護：漂移由 golden `failure_reasons` 守住，新增來源時測試會要求補上；步驟 14 的 D6 終局把 reason 併進 runner spec（`RUNNERS[source] = { run, failureReason }`）。replay 的 pg_temp 前提見上一條；若之後 Drizzle 設定改成帶 schema（`pgSchema`），replay 要改用獨立的資料庫（Neon branch 或步驟 11 的 PGlite）。
    - 10b2 已通知帳本（D15，2026-10-26 新增，排在 10c 前）：表 `digest_novelty(digest_id, key, fingerprint)`，和 snapshot 同一個交易、由同一批 items 推導、寫入後不改；選取時 join `digest_outbox.status in ('sent','attempted','unknown')`。舊 snapshot 回填用同一個推導，那 483 筆沒存 `novelty_keys` 的走移植版 `novelty()`，回填前先在 VM 證明這 483 筆的 key 和 Python 算的相同。converge 載入後重建帳本、replay 在暫存表裡重建、反向腳本排除它（Python 不讀）；`TABLES` 以外的衍生表要有自己的清單，converge 的表集合檢查不能把它當成多出來的表。另留一支「從 snapshot 重建帳本再比對」的檢查，步驟 14 刪 replay 後仍可跑。驗收：帳本選取與掃 snapshot 選取在 golden 情境、`scale.test.ts` 與每天的 replay 都相同；`scale.test.ts` 的抑制段改量帳本路徑。mutation：拿掉 status join（pending 也抑制）、回填跳過 483 筆、replay 不在暫存表重建帳本，測試各自失敗。
    - 10b2 實作狀態（2026-10-26，本機完成，未部署）：表 `digest_novelty`（`web/src/db/schema.ts`、`drizzle/0003_digest_novelty.sql`；主鍵 `(key, fingerprint, digest_id)` 兼查詢索引；trigger 擋 UPDATE、DELETE、TRUNCATE，因為少一列就會重複通知；重建永遠寫進空表：converge 先 drop schema，replay 的暫存表沒有 trigger）。`notifications/outbox.ts`：`insertDigestIn` 在同一交易寫 snapshot 後，從存下的 snapshot 以 `noveltyRows` 寫帳本；選取只查當天候選的 novelty key 與 member id（`lookupKeys`），`unseen()` 讀到的每一對都以其中之一為 key，所以和全掃等價；`backfillNoveltyIn(tx, digests)` 只吃傳入的副本列、已有列就因主鍵失敗（不默默略過）；`checkNoveltyIn` 從 snapshot 重推再比對。converge 多一個必填的 `rebuild` 參數（`ops` 不能 import 產品模組，由 `scripts/converge.ts` 傳入 `rebuildNoveltyIn`），在載入的同一交易重建；replay 為 `DERIVED_TABLES` 建暫存表並從副本（去掉當天）重建；`ops/tables.ts` 的 `DERIVED_TABLES` 是 converge、比對器與步驟 12 反向腳本都不碰的清單；`scripts/check-novelty.ts` 接在 after job 最後（`--since` 當天）。483 筆的 VM 證明（2026-10-26 01:5x，10-25 after 副本，`--network none` 唯讀掛載，只輸出計數與雜湊）：Python（`freelance-agent-backend:d994cd2-jb518` 的 `discovery.rules.novelty`）與 TS（`freelance-agent-shadow:a5b2e6c` 的 `novelty`，本步驟沒改它）都是 39 份 digest、483 筆無 `novelty_keys` 的 item、966 對、sha256 `f8c6b211318c9b0105422f5d5319de5c8eb930c1a5fd876a6df5da61aac22c29`。驗證：新 `tests/novelty.test.ts` 10 例（寫入、sent／attempted／unknown 各自抑制、pending 不抑制、跨收件者、舊 snapshot 回填、只能靠 identity key 比到的已消失 opportunity、檢查器、不可改）；golden digest 情境經帳本仍逐位元組相同並加帳本一致檢查；`scale.test.ts` 歷史改成部分宣告過真實候選（含內容已變），帳本選取和全掃選出同一批（1000 候選、抑制 200），`createDigest` 2.8–4.3 秒；ops 測試加 converge 重建帳本。mutation 6 項全紅：拿掉 status join、拿掉 unknown、回填跳過無 `novelty_keys` 的 item、replay 不重建帳本、建摘要不寫帳本、查詢不帶 novelty key（第一輪存活，補「已消失 opportunity」案例後失敗：同一天清單裡內容相同的職缺一定同組，identity key 只在宣告過的 opportunity 已不在表裡時單獨起作用）。`pnpm typecheck`、`boundaries`、`build` 過，`pnpm test` 32 檔 376 個全過（審查修正後重跑見進度表）。審查（兩個 fresh subagent，對抗式與 design-review）：無 HIGH／MED；改 4（帳本補擋 DELETE／TRUNCATE、回填刪掉讀 DB 的預設路徑與略過已有列、三種狀態各自的抑制測試、測試排序）；記 4：(1) 檢查器兩邊都用 `noveltyRows`，抓的是寫入路徑和重建的漂移，抓不到推導本身錯，推導對 Python 的保證來自上面的 VM 證明與每天的 replay；步驟 14 刪 `shadow-job.sh` 後它沒有排程，觸發條件：改 `novelty()`、`noveltyRows` 或帳本寫入時手動跑一次全量（不帶 `--since`）。(2) 帳本 key 經過 Postgres text：含 U+0000 的 key 會讓當天摘要失敗（看得到，不會默默重寄），孤立 surrogate 會被換成 U+FFFD 而可能重寄一筆；key 來自 URL 與雜湊，現有資料沒有；觸發：任何來源出現這種 URL 時改存 key 的雜湊。(3) 讀取量只量了時間，沒量 Neon 傳輸量；併入步驟 11 的 D13 量測。(4) 步驟 12 的反向腳本排除 `DERIVED_TABLES`，已寫進步驟 12。部署順序：VM 映像先換（隔天 08:30 converge 用新 migration 建表並重建），再部署 Vercel；反過來會讓 TS 在沒有表的 shadow DB 上建摘要而失敗。需要人做的事：授權部署 Vercel 正式專案與更新 VM shadow 映像。
    - 10b2 上 shadow（2026-10-26 02:2x，Will 授權部署與 VM 設定）：VM `/opt/freelance-shadow` checkout `c247200`，`SHADOW_IMAGE=freelance-agent-shadow:c247200`（備份 `shadow-compose.env.bak-a5b2e6c`）；新映像對 10-25 after 副本手動跑 converge：`converge ok`、`digest_novelty` 重建 4,815 列，`check-novelty` 39 份 digest、0 缺 0 多（shadow DB 08:30 會照常重載）。Vercel 正式專案部署 `c247200`（`freelance-agent-kzojngp21`，alias 不變；`vercel env ls production` 仍是白名單 6 個名稱；`/api/cron` 未登入 302）。回滾要兩邊一起：`SHADOW_IMAGE` 改回 `:a5b2e6c` 並把 Vercel promote 回 `8h6bndpwp`；只回滾 VM 會讓新程式碰到沒有帳本表的 shadow DB。
    - 10-26 自然執行（第一次經帳本選取；唯讀查 shadow DB、`workflow inspect`，只取計數與狀態）：run `wrun_41M5TWAYRX0GWSCRVWJ1RTDQHG`（iad1）09:14:01 開始、09:16:27 結束（146 秒），`daily_runs` 一列 `failed`（`one_or_more_sources_failed`，不是停在 running）；`digest_outbox` 一列 `pending`（09:16:19，225,330 bytes，55 個候選），`digest_novelty` 有這份 digest 的 110 列。after job：replay same（Python 49 筆對 TS 49 筆）、`novelty ledger same: 1 digests, 110 rows, 0 missing, 0 extra`。step 耗時（量到；依序執行，順序與 `source_details` 相同，用 health 的 `checked_at` 對過兩個點）：claim 0.7 秒、sources 0.1 秒，25 個 sync step 中 freelancer 25.5 秒（1,450 筆看過、274 筆入庫、20 頁）、arbeitnow 24.5 秒（failed）、dynamitejobs 15.0、nodesk 11.9、justremote 10.8、taiwanjobs 7.1、chickpt 6.7、himalayas 6.5、linkedin 6.4，其餘都在 5 秒內；收尾（建摘要＋帳本查詢）7.6 秒。都低於步驟 8 的觸發值（freelancer 200 秒、任一 step 150 秒）。Resend 狀態碼：沒有原始紀錄——程式不記狀態碼，Hobby 的 runtime log 只留約 1 小時（11:2x 查 09:14 的時段，`vercel logs` 回 400）。推論全部是 200：`ReceivingClient` 遇非 200 就丟例外、來源記 failed，而 6 個信件來源除 talent 外都是 ok，talent 的 `incomplete_or_unsupported_scan` 來自隔離 2 封（Python 同一天同樣 failed、同 reason，`mail_ingestion` 兩邊 8／8 相同）。要量到原始狀態碼得先在 detail 加計數，觸發：信件 step 出現 `source_unavailable`。
    - 10a 缺陷（2026-10-26 自然執行發現，已修，未部署）：TS 把當天的 cryptojobslist 記成 `{status: failed, reason: invalid_source_result}`，Python 是 ok。原因：Python 的結果帶 `feed_built_at`（RSS 的 lastBuildDate 原文，如 `Mon, 26 Oct 2026 …`），10a 的 `SourceDetail` 只收識別字字串，整份 detail 被拒收；10a 審查時逐一核對了 `scope`／`reason`／`error_stages`，漏了這個欄位。影響只在 `daily_runs.result.source_details`（比對器不比，所以沒報出）：入庫與 health 由 `sourceBatch` 照常寫入（比對器 0 差異），摘要的來源狀態讀 `source_health` 不讀 detail。正式 DB 全部 30 天的 `source_details` 掃過，不合契約的只有 `cryptojobslist.feed_built_at`（30 天都有）。修法在產生端：TS 的 cryptojobslist 不輸出 `feed_built_at`（`rg feed_built_at` 只有兩個產生端與 golden 的 parse 結果，沒有讀取端；D17 允許和 Python 輸出不同）。回歸測試 `tests/cryptojobslist.test.ts`「records a healthy feed with a build date as ok」先紅（`invalid_source_result`）後綠；`pnpm typecheck`、`boundaries`、`build`，`pnpm test` 32 檔 380 個全過。部署要 Will 授權（只動 Vercel，VM 映像不用換）。
    - 10c 寄送路徑（shadow 結構上不能寄）：`claimDigest`／`finishDigest`／`dispatch`（`scheduler.py`），寄送 step `maxRetries = 0`；MIME 由 TS 自己組（multipart/alternative、utf-8、固定 boundary 與 Message-ID，同一 snapshot 永遠是同一串位元組），預覽 sha256 由 TS 算，不沿用 Python 的值；SMTP 用 nodemailer 只當傳輸層（`raw` 寄出我們組好的位元組，Node 沒有內建 SMTP client），連 `smtp.gmail.com:465`、驗憑證。寄送憑證的 env 名稱在步驟 13 才存入，缺 env 時寄送 step 回 `not_configured`、不 claim。驗收：「不確定寄送不重試」（sender 丟例外、沒有 receipt、程序在 claim 後中斷，三種都留在 `attempted`／`unknown`，再跑一次不會寄）、sha256 不符拒寄、snapshot 改變拒寄、`existing_snapshot_requires_review`。mutation：寄送 step 允許重試、`finishDigest` 接受非 `attempted` 的列，測試各自失敗。1d 實寄（合成信）在這一步做，需要 Will 把 SMTP 憑證存進 spike 專案的 env。
    - 10c 實作狀態（2026-10-26，本機完成，未部署）：`notifications/delivery.ts`（`buildMessage`、`dispatch`、`deliver`、`smtpPassword`）、`platform/smtp.ts`（`openGmail`：nodemailer 的 `SMTPConnection`，一條 TLS 連線 connect → login → send，和 Python `SMTP_SSL`＋`login`＋`sendmail` 同一個流程，所以登入失敗發生在 claim 前、摘要留 pending；不用 `createTransport`，它的 `verify()` 與 `sendMail()` 各開一條連線，第二條在 claim 後才登入失敗會變成 unknown）。寄送接在收尾 step 的 `finishDaily` 裡（和 `run_daily` 同一處），`finishStep` 本來就是 `maxRetries = 0`，回傳改成 `{status, delivery}`；組信取代原本只為檢查而呼叫的 `render`。寄送開關就是 env：只有 `GMAIL_APP_PASSWORD`（帳號就是 `DIGEST_RECIPIENT`，和 Python 設定檔的 email 必須等於收件者同義，所以只多一個 secret），沒設時 `delivery: not_configured`、不 claim、result 不多欄位，shadow 行為不變。和 Python 的刻意差異（D17）：MIME 自己組（base64 的 text 與 html 兩段、From／To 用 snapshot 存的收件者，所以位元組只由 snapshot 與 intent id 決定）；sha256 是 TS 自己的值。依賴：`nodemailer` 10.0.16（2026-10-07 發布，無依賴，自帶型別）。驗證：`tests/delivery.test.ts` 15 例（真 Postgres、假 SMTP client）：sender 丟例外／沒有 receipt／claim 後中斷三種都停在 unknown／attempted 且再跑不寄、`finishDigest` 不收非 attempted、sha256 不符在連線前拒寄、登入失敗留 pending、snapshot 改變拒寄（測試裡暫停不可改 trigger 才做得到）、`existing_snapshot_requires_review`、未設定不 claim、組信位元組固定與只寄給驗證過的帳號；`src/platform/smtp.test.ts` 3 例（本機 socket：對方斷線、對方不回應、格式不符不連線）。mutation 9 項全紅：step 允許重試、`finishDigest` 不限 attempted、sender 失敗後重試、拿掉 sha256 比對、拿掉 snapshot 比對、拿掉收件者接受檢查、拿掉 pending 檢查、reused 也寄、`openGmail` 不聽 error／end 事件（兩個測試逾時）。因為先寫實作再寫測試，測試的鑑別力以這些 mutation 證明，不是先紅後綠。對抗式審查（fresh subagent）：沒有找到重寄或誤標 sent 的路徑；改 3：(MED) 連線、TLS、逾時錯誤在 nodemailer 只走 `error` 事件、不呼叫 connect／login 的 callback，原本 `openGmail` 會永遠不結束、run 停在 running 到函式被殺，改成兩段等待都聽 `error`／`end` 並加上面的 socket 測試；(LOW) 一條對 `PyDict` 用 `toHaveProperty` 的空斷言；(LOW)「沒有 receipt」補再跑不寄。記 1：Workflow SDK 自己說 step 本體在重新投遞時可能跑兩次（`workflow` 5.2.3 的 `step-executed-multiple-times` 文件），`maxRetries = 0` 不是「最多一次」；擋住重寄的是 `claimDigest` 的條件式 UPDATE（`pending → attempted` 只有一個呼叫者拿得到列）與 `deliver` 只處理 pending。1d 實寄（2026-10-26）：從 spike 專案用本步驟的 `buildMessage` 與 `openGmail` 寄出合成信，Gmail 接受 1、拒收 0（`spikes.md` 1d）。Will 確認收件匣收到、顯示正常。正式專案上的寄送要到步驟 13 才有憑證。
    - 10a 修正＋10c 上 shadow（2026-10-26 12:3x，Will 授權部署）：`86b62be` 部署到正式專案（`freelance-agent-5knxy7mjg`，alias 不變；部署前 `vercel env ls production` 仍是白名單 6 個名稱、沒有 `GMAIL_APP_PASSWORD`，所以收尾 step 回 `not_configured`、不 claim；alias 與部署網址的 `/api/cron` 未登入都是 302）。VM 映像不用換（沒有 migration，比對器與 replay 不讀這兩處改動）。回滾：Vercel promote 回 `kzojngp21`。未跑：10-27 第一次自然執行，確認 cryptojobslist 的 detail 是 ok、workflow 回傳 `delivery: not_configured`、`digest_outbox` 仍是 pending。
    - 10e 共用讀取模型（D16、D18，2026-10-26 新增，排在 10c 後；D19 之後被擋於步驟 4e；Will 2026-11-03 放寬：10e1 可在 4e4b 觀察期間於分支上開工，合併等 4e4b 驗收過，觀察期發現儲存層問題時分支跟著接上修正；一個 session 做不完，拆成 10e1、10e2，依序做）：取代全表 `listIn`，UI 與摘要都讀同一份投影。讀取模型照 D18 的 P1：依 settings revision 存評估狀態與排名基分，SQL 只算和時間有關的部分（是否過期、新鮮度加分）並分頁，只補讀當頁；補讀時用 TS 重算並核對 SQL 給的分數，不符就丟錯。D18：不做跨來源合併，每筆 opportunity 是只有自己一個成員的群組；`members: [自己]`、成員 token 公式（fingerprint、tracking revision、內容版本雜湊、applications token）、`observation_fingerprints`、`novelty_keys`、內容版本的主卡選擇（`display_basis`）照舊，所以 DTO、snapshot 與 Python 回滾時的 render 都不變。
      - 10e1 投影與維護：衍生表 `discovery_items`（每筆 opportunity 一列）與 `discovery_versions`（每個內容版本一列），加進 `DERIVED_TABLES`（converge、replay、步驟 12 反向腳本都從 SQLite 副本重建，不回讀 Neon）。寫入時存：當作未過期算出的狀態、`qualify` 理由與分類理由分開存（讀取時照 `evaluate` 的順序組回）、截止到期時刻（`timestamptz`；只有日期的存隔天 00:00Z，溢位存 null）、排名與卡片要的欄位、novelty 對、settings revision。讀取時算：是否過期、freshness、排名、候選、顯示的 `review_status`、主卡用哪個版本。tracking 與 applications 讀取時從各自的窄表 join。維護：`insertRecord`／`saveRecord` 與 `ingestResendBatch` 同交易重算該筆，`replaceSettings` 同交易重算全部（實測要在寫入鎖 5 秒等待內），讀取時 settings revision 不符就丟錯。新程式用 TS 原生型別，只在既有消費端邊界轉 `PyDict`。這一步讀取端仍走 `listIn`，行為不變。驗收：參考實作（從原始列直接跑 `evaluate`／`recommendation`／`isCandidate`）在多個 `now`（aware 截止前、當下、後；只有日期的截止跨 UTC 日界；只有版本有截止）和投影讀取結果相同；增量投影等於整批重建（含改設定、新增版本）；converge 重建後相同。mutation：寫入時判斷過期、設定變更不重投影、新增版本不重算該筆，測試各自失敗。
        - 10e1 實作狀態（2026-11-03，分支 `10e1` 的 `526a1c1`、`f23f2f2`，本機完成，未推送、未合併、未部署；合併等 4e4b 驗收）：在 D1 上做，和上一條原文的差異與理由：
          - 投影只存 SQL 排名與篩選要的欄位，不存評估理由與卡片欄位：`discovery_items`（`opportunity_id` 主鍵、外鍵到 `opportunities`；`fingerprint`、`review_status`、`deadline_at`（`novelty` 欄位在 10e2 刪除，見 10e2 實作狀態）、`published_at`、`settings_revision`、`excluded`、`base_tenths`）與 `discovery_versions`（`(opportunity_id, fingerprint)` 主鍵，後五欄同）；migration `web/drizzle/0003_discovery_projection.sql`。理由：P1 本來就要求補讀當頁時用 TS 重算並核對，當頁（與 10e2 的摘要入選者）反正要讀原始列，存理由是第二份要維護的衍生資料，必要條件不成立。`excluded` 是「截止前」的狀態（含分類），`base_tenths` 是分類分 ×7 加每個確認條件 25（推薦分的十分位，未計 tracking 與新鮮度）。
          - 時間存 UTC 文字 `YYYY-MM-DDTHH:MM:SS.ffffffZ`（以文字排序），不是原文的 `timestamptz`；只有日期的截止存隔天 00:00Z；早於 1 年存 `0000-…`、晚於 9999 年存 null（截止永不到、發布時間未知）。不用整數微秒：9999 年的微秒值超過 2^53，D1 REST 的 JSON 數字會失真、client 讀回時 fail closed（1f (e)）。觸發：要在 SQL 做時間算術時再改。
          - 共用同一份規則：`qualify` 拆成 `qualifyUnexpired`（不看 `now`）與 `expire`（套用截止），`evaluate`＝`evaluationAt(evaluateUnexpired(…))`；推薦分抽出 `publishedAt`、`confirmedCount`。新鮮度的天數比較改成整數微秒，和原本「秒數除以 86400」在整數輸入上結果相同（不是 D17 差異；golden 與全套測試照舊通過，`526a1c1`）。
          - 維護：`Records` 每次寫紀錄、`ContentVersions.add` 每次寫版本，同一單元一起 upsert 投影列（`Records` 建構時帶單元讀到的 `Settings`）。`replaceSettings` 移到 `services/discovery.ts`（discovery 模組不能 import legacy／collection），在同一頁面單元讀全部紀錄與版本，用 `UPDATE … FROM json_each(?)`（每句一個 ≤ 90 KB 的 JSON 參數，經 `Writes.statement()`）重寫每列的設定欄位，所以整表在一個請求內（4e2b 交接 (2) 的解法；2,500 筆在替身上是 2 個請求）。
          - 重建：`DERIVED_TABLES` 加兩表；`RebuildDerived` 多收租約內的 `send`（投影表是租約表）；匯入（`scripts/import-copy.ts`）與 replay 都從副本 `rebuildProjection`。
          - 讀取（`listPage`，10e2 之前沒有呼叫端）：第一個請求做一致性檢查（列數和來源表相等、沒有舊 revision 的列）與 SQL 排名分頁（過期、新鮮度、候選、分數、tracking 與 applications 用窄表 join；時間以 SQL 字面量帶入，避開 100 個參數上限）；第二個請求只補讀當頁的紀錄、版本、tracking、applications，在 TS 照 `list_in` 組回並逐筆核對候選與分數，不符丟 `ProjectionMismatch`（兩次請求之間有寫入時重試一次）。`now` 必須是 UTC。
          - 驗證：`tests/projection.test.ts` 7 個（6 個 `now`：aware 截止前 1 µs／當下／後 1 µs、只有日期的截止的 UTC 日界兩側、發布滿 2 天與 7 天；只有版本有截止且只有版本可能符合；興趣、略過、已投、stage；分頁是全排名的切片；novelty 對；增量維護在收案、新版本、回饋、改設定後都等於整批重建；過期投影與欄位竄改被拒；非 UTC 被拒）；`ops.test.ts` 匯入後 `listPage` 等於 `list`；`scale.test.ts` 2,500 筆分頁與改設定一個寫入請求；`d1-real-product.test.ts` 加真 D1 的 90 KB `json_each` 參數與 `replaceSettings`（CI 的 d1 job 才跑）。mutation 10 項全紅：截止不在讀取時套用、改設定不重投影、新版本不投影、更新紀錄不重投影、週新鮮度、applications、只有日期的截止提前一天、興趣加分、忽略版本選項、忽略 stage（第一輪後兩項存活，補 fixture 後紅）。`pnpm typecheck`、`pnpm boundaries`、`pnpm build` 0；`pnpm test` 38 檔 447 過、7 skip（審查修正前；修正後見進度表）。
          - 設計審查（fresh subagent，完成前，8 項）：改 4（投影表加外鍵到 `opportunities`、`Writes.statement()` 的註解寫明正式用途、當頁 applications 只讀當頁、本段補實際形狀）；記 2（時間存文字，理由見上；兩個請求加重試：單一請求要在每句重複排名子查詢、讀取列數倍增，交 10e2 依 D13 量測決定，觸發：重試次數或核對失敗出現在 log）；交 Will 1（下一點）；駁回 1（nit：replay 經 `services/digest.ts` 轉出 `rebuildProjection`，因為 replay 重建的就是摘要要讀的資料）。另外自己補的：原地重建指令 `scripts/rebuild-projection.ts`（`rebuildProjectionInPlace`；增量測試改用它當「整批重建」的對照，並從空表開始驗一次）。另記：每次讀取的一致性檢查約多讀 4–6 × 筆數列，併入 10e2 的 D13 讀取量測。
          - code review（`/code-review` medium，2026-11-03，10 項）：改 6（部署順序改成重建在部署之後；`Writes.statement()` 帶位元組數，最後一批超過 4 MB 時在寫入前失敗，`write-units.test.ts` 加案例、拿掉檢查時紅；`json_each` 分塊用位元組計算；`rebuild-projection.ts` 結束時檢查完整性；它在 09:00–09:59 拒絕執行；重建與 `settingsRead` 共用 `settingsOf` 的預設設定）；記 2（改設定在租約內讀全表 3.2–3.4 秒：觸發條件見下一點；排名查詢裡版本子查詢重複計算：10e2 從 iad1 量 `listPage`，超過 1 秒就改成先算一次的子查詢）；駁回 2（「daily 與 replay 傳台北時間的 `now`」不成立：`daily.py:20` 與 `PyDateTime.now()` 都是 UTC，golden 的 `generated_at` 全是 `+00:00`，非 UTC 時讀取 fail closed；「`novelty` 欄位 10e1 沒有讀取端」是計畫要求存的，紀錄本身不帶 `novelty_keys`，只有 snapshot 的 item 帶）。修正後 `pnpm test` 38 檔 447 過、7 skip，typecheck、boundaries、build 0。
          - 真 D1 正式量級（2026-11-03 13:0x，Will 同意，對 `freelance-agent-ci-test`，Mac → ENAM，不是 iad1；一次性腳本只印計數與耗時）：灌 2,450 筆（每筆約 3.5 KB）12 個請求、17.3 秒、寫 12,396 列。`replaceSettings` 3 次：每次 4.5–5.8 秒，其中「取租約＋讀全表」的請求 3.2–3.4 秒、寫入請求 9 句 181 KB 0.5–1.3 秒，每次寫 2,456 列；`listPage`（50 筆）1.0–1.4 秒。結論：改設定在一個寫入請求內成立（4e2b 交接 (2) 解決）。原文「實測要在寫入鎖 5 秒等待內」：5 秒是 UI 等租約的上限，不是單元本身的耗時；但改設定持有租約約 4–6 秒，期間另一個 UI 寫入可能等滿 5 秒回 409（推論）。iad1 的讀取應較快（1f 補充：Mac 讀 17.2 MB 要 2.63 秒），10e2 從 Vercel 再量一次，連同 `listPage` 的耗時與列讀取併入 D13；觸發：iad1 上改設定超過 5 秒，就改成不在同一單元讀全表（例如只讀投影列與 job 欄位）。量測連灌資料共寫 19,764 列（當天 UTC 另有 4e4 匯入 28,814 列）。部署順序：合併後先 `scripts/migrate.ts`（建出空的新表），再部署 Vercel 與 VM 映像（會維護投影的程式），最後 `scripts/rebuild-projection.ts`（在 D1 上原地重建，持有租約、讀 D1 自己的列，不重載副本；09:00–09:59 拒絕執行；結束時檢查列數與 revision，不完整就 exit 非 0，重跑即可）。順序不能反過來：重建之後若舊程式還在寫，新紀錄沒有投影列，讀取會一直拒絕（code review 指出）。投影的推導改變時也重跑它。
      - 10e2 讀取端切換：`list`／`group`／`feedback`／`createDigestIn` 改讀投影；刪 `listIn` 與跨來源合併（`groupItems` 只剩單筆群組的組裝）；ranking 與 render 的 Python `round`／格式化改原生（步驟 14「現在就原生」那一項）；在 TS 每日執行記錄「近 7 天候選裡跨來源同（正規化）職稱的配對數」（D18 的觸發量測，切換後仍會跑）。驗收：正式量級下一頁清單與一次回饋的 D1 列讀取量、摘要耗時；replay 照常逐位元組比對，差異逐項解釋。mutation：token 拿掉內容版本雜湊（舊畫面在新版本後仍可回饋）、`unseen` 不讀 `observation_fingerprints`（已通知職缺的新版本不再出現於摘要）、主卡不依可能符合的版本選擇，測試各自失敗。
        - 10e2 設計盤點（2026-11-03，分支 `10e2`，疊在 `10e1` 上；開工時設計審查 11 項已分流，結果併入本段）：舊實作就是規格，每項寫去向。
          - 讀取路徑：
            - `list(db, now)`：從正式程式刪除。
              - 全表組裝（`listReads`、`assembleList`）搬到 `web/tests/helpers/reference.ts`，當投影讀取的參考實作。
              - 正式只有分頁的 `listPage`，步驟 11 的 UI 用它，不得一次讀全部（ADR 2026-10-26「no full-table recompute remains」）。
            - `group(db, key, now)`：改成只組那一筆，成為單一成員群組（D18 A3）。
            - `feedback`：寫入單元只讀那一筆的紀錄、版本、tracking、applications 與設定，不再讀全表；token 比對照舊。
            - `createDigest`：改成 `listPage` 讀全部候選（SQL 排名，每筆經 TS 重算核對），再 `asGroup`，再沿用現有的 `selectUnseen` 與帳本。
              - 不另做輕量候選。審查指出必要條件沒有證據：D1 不收傳輸費，摘要一天一次，約 2,450 列；而輕量路徑會讓被壓下的候選不經核對。
              - 當天既有的 digest 與來源狀態放進排名同一個請求。
          - 摘要的一致性規則（記）：
            - 投影過期或不完整（`checkState`），或兩次請求之間有寫入且重試一次後仍不符時，建摘要失敗。daily run 記 `failed`／`daily_processing_failed`，照規範不自動重試。
            - 復原：先跑 `scripts/rebuild-projection.ts`，再用 10d 的復原頁重跑當天。10d 之前的復原方式是手動刪掉當天 `daily_runs` 那列，再觸發 cron，每次先問 Will。
            - `ProjectionMismatch` 重試有計數：client 計數器 `projection_retries`，寫進 `daily_runs.result` 頂層；`check-storage-triggers` 遇到大於 0 就標出。
          - 分組：`groupItems` 的 union-find 跨來源合併刪除，改成 `asGroup(item)` 組單一成員群組。
            - members、token 公式、`observation_fingerprints`、`novelty_keys`、`display_basis` 照舊。
            - `identityKeys` 保留，novelty 還要用。
            - render 對沒有 `members` 的 item 重新分組的後備分支刪除：唯一呼叫端渲染的是 snapshot，item 一律帶 `members`。
          - golden：拿掉合併後有 5 個測試紅（2026-11-03 實驗：`discovery.test.ts` 的 bridge 案例；`scenarios.test.ts` 的 `url_and_content_grouping`、`group_feedback_atomic_and_stale`、`digest_novelty_and_uncertain_delivery`；`ops.test.ts` 的 replay 合成案例）。全都是合成情境刻意讓兩筆共用 URL key 而合併；正式資料從未合併過（D18 事實）。
            - bridge 案例：刪除，它驗的機制已經不存在。
            - 三個情境：改 `gen_golden.py` 的輸入，讓共用 key 的那幾筆改用各自不同的 URL，然後重產 golden。群組回饋的原子性改用同一筆的舊 token 驗。
            - 補一個只在 TS 跑的情境：兩筆共用 URL key、各自成卡，前一筆已通知後，後一筆因為共用 URL key 而被壓下。這列為 D17 差異：Python 在回滾窗口內會把它們合併成一張卡。
            - replay：真實副本照常逐位元組比對。
          - 原生化（步驟 14「現在就原生」）：
            - ranking 的 `roundFloat(score, 1)`、`roundToInt(completeness)` 換成原生。證據是窮舉全部分數組合，原生與原寫法結果相同，寫成測試。注意分數在浮點裡不一定剛好是 0.5 的倍數，例如 59.49999999999999。
            - render 的工時格式化不換（審查的 nit，駁回）：render 輸出不存資料庫，但 render 的 golden 用 `%g` 的邊界值（`1e-05`、`10**20`）逐位元組比對，換原生只換來一份差異清單、沒有功能上的好處。步驟 14 刪 Python 時連同 golden 一起換。render 不再接受沒有 `members` 的 item（後備分支刪除），golden 少掉直接傳 `store.list()` 的那一例。
            - 評估理由裡的 `formatG`、`formatThousands0f` 不換：評估文字存在 `opportunities` 列，Python 回滾時會讀到。D6 窗口結束後隨步驟 14 再換。
          - D18 觸發量測：建摘要之後的獨立步驟，失敗只記錄、不影響摘要。
            - 範圍是當天候選中發布在 now 前 7 天內、跨來源、職稱經 `text()` 正規化後相同的配對數，寫進 `daily_runs.result` 頂層的 `cross_source_title_pairs`。發布時間未知的候選另記 `cross_source_unknown_published`，不默默排除。
            - 讀它的人：`check-storage-triggers`（VM after job）在配對數達 3 時標出、exit 1，接著由 Will 人工抽樣（D18）。
          - 量測：
            - 替身回報的 `rowsRead` 是傳回列數，不是 D1 計費的掃描列數。一頁清單、一次回饋的列讀取，要在真 D1（`freelance-agent-ci-test`）上量，要 Will 同意。
            - iad1 的耗時：建摘要由部署後每日執行的 step 耗時量（`workflow inspect`）；改設定與分頁由步驟 11 接上 UI 後量。10e1 的兩個觸發條件照舊。
          - 新機制：沒有新表、沒有新的讀取形狀。新增的只有兩個計數（`projection_retries`、`cross_source_*`），必要條件分別是 10e1 的重試觸發與 D18 的觸發量測。
        - 10e2 實作狀態（2026-11-03，分支 `10e2` 的 `742e662`、`76cd816` 與審查修正，本機完成，未合併、未部署；合併等 4e4b 與 10e1）：和上面設計盤點的差異如下。
          - golden 改用「讓 Python 也一筆一組」重產，而不是改情境的輸入。`gen_golden.py` 的 `single_member_groups` 把每個綁定了 `group_items` 的已載入模組都 patch 掉（實際是 discovery 的 public／rules／service、notifications 的 digest／store），排序鍵照抄 Python 的 `group_items`。
            - 理由：改輸入會拿掉 `url_and_content_grouping` 要驗的 URL 正規化，這段讓 key 相撞的程式 novelty 仍在用。
            - 代價：這三個情境（`url_and_content_grouping`、`group_feedback_atomic_and_stale`、`digest_novelty_and_uncertain_delivery`）記錄的是「A3 之下的 Python」，不是正式 Python 的輸出（正式 Python 會合併）。這是 D17 差異。
            - 其餘情境逐位元組不變（逐鍵比對）。改成 patch 所有模組之後重產，golden 也逐位元組不變。
          - 投影的 `novelty` 欄位刪除（0003 migration 重產，未部署過）。原本留給輕量候選用，10e2 不做輕量候選之後它沒有讀取端。
          - 摘要讀取（`digestCandidates`）：
            - 第一個請求：一致性檢查、全表排名（不設 LIMIT），以及當天既有的 digest 與來源狀態。已有 digest 就直接回傳，不讀任何列。
            - 第二個請求：整表讀取（不帶 id 清單；全部候選約 2,400 個 id，做成單一 JSON 參數約 164 KB，沒在真 D1 驗過），只組候選、逐筆核對。
            - `listPage` 限制每頁 1–200 筆（`MAX_PAGE`），UI 不能一次讀全部；沒有對外匯出的「全部」值。
          - D18 量測：在建摘要與寄信之前，一個請求內完成（排名＋全表職稱），不拉長「已寄出但還是 running」的時間。失敗記成 `cross_source_title_pairs: null`，`check-storage-triggers` 標出 `cross_source_unmeasured`。
          - 重試計數叫 `read_retries`（盤點原寫 `projection_retries`），走 D1 client 的計數器與 `Usage`。UI 請求的計數沒有人保存，和 4e2b 交接 (3) 的 409 一起在步驟 11 決定記在哪裡。
          - 驗證：
            - typecheck、boundaries、build 0。`pnpm test` 39 檔 453 過、7 skip。
            - 新測試：重試計數、單筆群組與舊 token 被拒、共用 URL 不合併且被壓下、新版本重新通知、D18 配對數、觸發訊號。
            - `tests/ranking-rounding.test.ts` 用分類定義窮舉 150 個分數，原生與 Python round 相同。
            - mutation 全紅：token 拿掉版本雜湊、`unseen` 不讀 `observation_fingerprints`（第一輪存活，補「新版本重新通知」後紅）、主卡不依可能符合的版本、重試不計數、回饋讀全表、同來源也算配對、摘要不核對、已有 digest 仍讀列、量測失敗當成 0。
          - 審查（完成前，design-review 10 項＋`/code-review` medium 10 項，重疊合併後分流）：
            - 改：量測位置、已有 digest 提前回傳、摘要只組候選且不帶 id 清單、不匯出「全部」、量測失敗另標、窮舉測試的分數從分類定義推導、render 丟 `PyError`、刪 `novelty` 欄位、golden patch 涵蓋所有模組。
            - 記：golden 的做法（見上）、`read_retries` 的名稱與 UI 端的計數（步驟 11）。量測每天多做一次全表排名，約 2,450 列讀取，在 D1 每天 500 萬列內，推論。
            - 交 Will：ADR 2026-10-26 寫的「no full-table recompute remains」。換到 D1 後，摘要每天在 TS 重算全部候選（約 97% 的列）；UI 只讀頁。要嘛修 ADR，要嘛縮小摘要範圍（例如 SQL 先用帳本濾掉已通知的候選）。
            - 駁回：
              - 「一筆不符就整份摘要失敗」：P1 明定不符就丟錯，復原步驟見設計盤點。
              - `groupItems` 保留重新排序：`insertDigest` 對任何輸入順序都要正確，nit。
          - 真 D1 量測（2026-11-03 15:xx，Will 同意；`freelance-agent-ci-test`，2,450 筆、每筆約 3.5 KB，Mac → ENAM；一次性腳本只印計數與耗時；`rows_read` 取自 D1 回應的 `meta.rows_read`，即計費的掃描列數）：
            - 一頁清單（50 筆）：2 個請求，`rows_read` 15,252，0.9–1.2 秒。
            - 一次回饋：2 個請求，`rows_read` 28–31，0.7 秒。
            - D18 量測：1 個請求，`rows_read` 14,701，1.2 秒。
            - 摘要的讀取（`digestCandidates`，2,450 個候選）：2 個請求，`rows_read` 19,609。耗時 38–39 秒，其中排名 1.4–1.9 秒、整表讀回 7.4–12 秒，其餘約 30 秒是 TS 重算全部候選；機器 load average 124，推論偏高。10e2 之前的摘要也在 TS 重算全部項目，10-26 在 Vercel 上收尾 step 的實測是 7.6 秒。
            - D13 換算（推論）：每天 20 頁清單、20 次回饋、1 次摘要、1 次 D18 量測，約 34 萬列讀取，是每日 500 萬的 6.8%，低於 20% 的目標。每日執行收案的讀取另計。
            - 新發現：建摘要在這份資料上失敗，`7500 string or blob too big: SQLITE_TOOBIG`。
              - 原因（推論）：空的新庫裡 2,450 筆全都沒通知過，全進同一份 snapshot；每個 snapshot item 約 4.7 KB，量到的，整份約 11 MB，超過 D1 單一值 2 MB 的上限。
              - 寫入 snapshot 的 `insertDigest` 從 4e2a 起就沒改過，不是 10e2 造成的。正式 shadow 每天約 55 筆、約 225 KB。
              - 上限約是 420 筆新職缺（2 MB ÷ 4.7 KB）。超過時當天建摘要失敗、記 `daily_processing_failed`，照規範不自動重試。
              - 可能觸發的情境：新來源第一次上線、連續幾天沒建摘要後累積、切換（步驟 13）的第一天。
              - D22 後不再適用：TS 不建摘要（10f 刪除）。Python 的 SQLite 沒有這個上限。
            - 量測期間寫了兩次種子資料：第一次量測腳本在建摘要時中斷，所以重灌一次，共 24,792 列。之後改成只讀不寫的量測（0 列）。當天（UTC）帳號累計推估約 7.5 萬列，沒有再寫。
          - 未驗證：
            - 真實副本上的 replay：部署到 shadow 後由每天的 after job 跑。
            - iad1 的耗時：部署後由每日執行的 step 耗時量。
    - 10f 刪除 TS 摘要與寄送（D22，2026-11-03 新增；疊在 10e2 之後；合併等 4e4b）：
      - 範圍（舊實作就是規格，每項寫去向）：
        - 刪除：`services/digest.ts` 的 `createDigest`、`checkLedger`、`rebuildNovelty`；`modules/notifications/` 的 digest（render）、outbox（`insertDigest`、`selectUnseen`、帳本）、delivery（組信、`deliver`）；`platform/smtp.ts` 與 `nodemailer` 依賴；`verify/replay.ts`、`scripts/replay-digest.ts`、`scripts/check-novelty.ts`；`discovery/rules.ts` 的 `unseen`／`seenIds`／`novelty` 與只給摘要用的 `publicItem` 欄位（若 UI 不用）；`tests/delivery.test.ts`、`novelty.test.ts`、摘要相關的 golden 比對與 `scale.test.ts` 的摘要段；`groupItems`／`asGroup` 只留 UI 需要的部分。
        - 改寫：`services/daily.ts` 的 `finishDaily` 只記來源結果、D18 量測與 D1 用量，`daily_runs.result` 的 `status` 依來源結果決定，不再有 `intent_id`、`candidates`、`delivery_status`；workflow 收尾 step 照舊 `maxRetries = 0`。
        - schema：`digest_novelty` 刪除（新 migration：租約下 `DROP TABLE`；`DERIVED_TABLES` 拿掉；匯入不再重建帳本）。`digest_outbox` 保留（歷史資料照搬，TS 不再寫入；不可變 trigger 保留）。
        - VM shadow after job：拿掉 replay 與 check-novelty，只留 `check-storage-triggers`；`shadow-job.sh` 與 compose 改寫，換映像時一起換。
        - env：`DIGEST_RECIPIENT` 只當 `daily_runs` 的鍵；`GMAIL_APP_PASSWORD` 這個名稱從程式消失。
        - `beginDailyRun` 的 `reused`（用 `findDigest` 判斷）與 `finishDaily` 的「沿用既有摘要」分支刪除：沒有摘要後，claim 之後中斷的 run 停在 `running`，照既有規則由人工處理。
        - `rebuildProjection` 改從 `services/discovery` 匯入（`scripts/import-copy.ts`、`tests/ops.test.ts`、`tests/d1-real-product.test.ts`）。
        - `daily_runs.result` 保留 `status`、`local_date`、`source_status`、`source_reason`、`source_details` 的形狀：回滾時 Python 讀 `source_details`（`backend/src/freelance/modules/notifications/store.py:32`），加一個測試斷言這幾個鍵與形狀。
        - `src/db/d1/guard.ts` 的 `SINGLE_STATEMENT_TABLES` 拿掉 `digest_novelty`；`src/ops/tables.ts` 的 `DERIVED_TABLES` 拿掉它；`scripts/import-copy.ts` 不再重建帳本。
        - 文件同步：`AGENTS.md`（寄信者一句改成「沒有系統寄信」、novelty key 拿掉）；ADR 2026-10-26 加修訂段（帳本決定被 D22 取代）；盤點附件（`inventory-surface.md`、`inventory-sources.md`）的摘要、寄送、recovery 列去向改成「刪除（D22）」；`allowed-residue.md` 加下面的允許殘留；跑 `python3 docs/plans/2026-10-23-nextjs-vercel-migration/check_inventory.py`。
      - 檔案：刪除 `web/src/modules/notifications/{digest,delivery}.ts` 與摘要部分的 `outbox.ts`、`web/src/platform/smtp.ts`、`web/src/verify/replay.ts`、`web/scripts/{replay-digest,check-novelty}.ts`、`web/tests/{delivery,novelty}.test.ts`；刪除 `web/src/services/digest.ts`、`web/src/modules/notifications/digest.test.ts`、`web/src/platform/smtp.test.ts`；修改 `web/src/services/{daily,discovery}.ts`（`digestCandidates` 刪除）、`web/src/workflows/daily.ts`、`web/src/modules/notifications/public.ts`（只留 daily-runs）、`web/src/modules/discovery/{rules,public}.ts`（`unseen`、`seenIds` 刪除）、`web/src/db/{schema.ts,d1/guard.ts}`、`web/src/ops/{tables,import}.ts`、`web/.dependency-cruiser.cjs`（刪 verify 層的兩條規則）、`web/scripts/{import-copy.ts,shadow-job.sh}`、`deploy/compose.shadow.yaml`、`web/package.json` 與 `web/pnpm-lock.yaml`（pnpm 11.2.2 移除 `nodemailer`）；測試 `web/tests/{daily,d1-paths,projection,scenarios,ops,d1-real-product,scale,write-units}.test.ts`、`web/src/modules/discovery/discovery.test.ts` 改寫（`projection.test.ts` 用 `createDigest` 驗「已通知壓下」與「新版本重新通知」的兩個案例隨 D22 刪除；`scenarios.test.ts` 不再跑摘要的 op 與 `digest_novelty_and_uncertain_delivery` 情境）；新增 migration `web/drizzle/0004_*.sql`（`DROP TABLE digest_novelty`）。
      - 消費端：`rg -n "digestCandidates|checkNovelty|noveltyRows|services/digest|createDigest|insertDigest|findDigest|claimDigest|finishDigest|announced|backfillNovelty|digest_novelty|checkLedger|rebuildNovelty|replayDigest|deliver\(|buildMessage|messageSha256|gmailOpener|smtpPassword|nodemailer|openGmail|selectUnseen" web deploy`。
      - 不能動：歷史 `digest_outbox` 列與它的 trigger；`daily_runs` 的 claim 語意（同一天只跑一次、過期不跑）。
      - 驗收：消費端搜尋只剩允許殘留，且只在這些路徑：已套用的 migration 與 meta（`web/drizzle/000[0-3]_*.sql`、`web/drizzle/meta/000[0-3]_snapshot.json`，不能改寫）、`web/drizzle/0004_*.sql` 的 DROP、`web/tests/fixtures/{gen_golden.py,golden.json}`（Python 側的情境，步驟 14 處理）；`digest_outbox` 的 schema、trigger 與匯入不在搜尋詞內、照留；`check_inventory.py` exit 0；`pnpm typecheck`、`boundaries`、`build`、`test` 全過；每日執行的測試在沒有摘要下記錄來源結果；mutation：收尾 step 仍呼叫建摘要時測試失敗（型別上已不存在，改成檢查 `daily_runs.result` 沒有 `intent_id`）。
      - 部署順序（合併後，避開 09:00–10:59）：套 0003（10e1 的投影表，新增型）→ 部署 Vercel、換 VM 映像（after job 不再跑 replay、check-novelty；程式不再碰 `digest_novelty`）→ `scripts/rebuild-projection.ts` → 隔天自然執行確認 → 套 0004（刪除型）。回滾：Vercel promote 回前一版、VM `SHADOW_IMAGE` 改回；0004 已套用時，用 10e2 版本（`b30c4a6`）的 `import-copy` 重載 shadow（會重建帳本表；每次先問 Will）。
    - 10d 受保護的操作頁（**D22 取消**：寄送頁不再需要；隔離信件的復原頁移到步驟 11 之後依需要再做，觸發：第一次有信件被隔離而需要重試）（原被擋於：步驟 11 的 Origin 檢查與 body 上限）：`/ops/recovery`（列出隔離信件與卡住的 `running`；把一封 rejected 標回 `retry_pending`，取代 `bootstrap/recovery.py`）、`/ops/digest`（預覽 MIME 與 sha256，帶相符的 sha256 才寄既有 `pending`，取代 `gmail_smtp_cli`）。憑證只在 Vercel，不複製到本機，所以用頁面不用本機 script（盤點 §4 已定）。驗收：`retry_mail` 的 Python 案例 TS 版、sha256 不符拒寄、跨來源 Origin 被擋。mutation：拿掉 sha256 比對，測試要失敗。

- [ ] **11. 網頁前端第一版**（D22 改寫，2026-11-03；被擋於：10e2；10f 可並行；合併等 4e4b）
  - 2026-11-03 前的原範圍（42 個 operation、工作台、離線 demo）由 D22 縮減，未做的部分列在「範圍」的延後。
  - 錯誤模型：route handler 與 server action 依 `Conflict`／`InvalidAction` 等錯誤類別（`instanceof`）對應 HTTP 狀態，不讀 `PyError.pyType` 字串。
  - 範圍：
    - 頁面：職缺清單（`listPage`，每頁最多 200 筆，候選在前，顯示評估狀態、理由、推薦分與新鮮度）、單筆詳情（`group`：職缺內容、評估、內容版本差異、display basis）、回饋（想接／略過／中立，`feedback` 帶 token，舊 token 回 409）、篩選設定（`replaceSettings`，帶 revision，舊 revision 回 409）。
    - 切換前唯讀（D23）：回饋與設定的寫入由一個 env 開關控制（`WEB_WRITES=on` 才開），切換前 production 與 preview 都不設，頁面的按鈕停用並標示「切換後開放」；server action 在開關關閉時一律回 403，不靠前端隱藏。切換（步驟 13）時打開。理由：切換時正式 D1 從 Python 資料重載，shadow 期的寫入會消失。
    - 既有 `web/src/app/page.tsx`（shadow 的來源狀態頁）改成 `/sources`，首頁換成清單。
    - 檔案：新增 `web/src/app/(jobs)/` 底下的清單、詳情、設定頁與 server actions、`web/src/app/sources/page.tsx`（由 `page.tsx` 搬來）、`web/src/web/guard.ts`（Origin、body 上限、寫入開關）與對應測試；修改 `web/src/app/page.tsx`、`web/src/app/layout.tsx`。
    - 存取：只有 Will 看得到。Vercel Authentication（All Deployments，spike 1a 已驗）加 route 層的 Origin 檢查與 body 上限；回應 `no-store`、`nosniff`。
    - 讀寫都經 10e 的投影與寫入單元；UI 的 409（租約等不到或資料已更新）顯示「請稍後再試／請重新載入」（4e2b 交接 (3)）；讀取重試與 409 次數記在 log（Vercel 的 runtime log，Hobby 只留約 1 小時，觸發：要長期看時改寫進 DB）。
    - 不用 `frontend/` 的 Python API client；元件可沿用 `frontend/` 的樣式。
  - 消費端：舊首頁的連結與書籤（`/` 改成清單、來源狀態移到 `/sources`）；`rg -l '"use client"' web/src` 的檔案都沒有匯入 `@/services/`（只有 server 端呼叫讀寫）；`frontend/` 是 Python 的前端，不改。
  - 驗收：
    - 頁面的 server 端測試（Vitest，替身 D1）：清單分頁、詳情、寫入開關關閉時回饋與設定回 403、開關打開時回饋成功與舊 token 409、設定成功與舊 revision 409、跨來源 Origin 被擋、超過 body 上限被擋。
    - preview 上未登入 `curl -sI <preview url>/` 與 `/sources` 回 401 或 302（Vercel Authentication，在正式專案的 preview 上驗，不靠 spike 1a）。
    - 不做瀏覽器 e2e（CI 沒有 Playwright job；第一版的頁面邏輯由 server 端測試涵蓋；觸發：前端有用戶端互動邏輯時加 CI e2e job）。
    - mutation：移除 revision 檢查、移除 Origin 檢查、寫入開關關閉時仍寫入，測試各自失敗。
    - D13：10e2 已在真 D1 量到（一頁 15,252 列、回饋約 30 列；每天 20 頁＋20 次回饋＋1 次 D18 量測約 32 萬列，是讀取額度的 6.4%；推論；收案的讀取另計，切換後第一週由 `daily_runs.result` 的用量確認），本步只在 preview 上確認頁面的請求數與 10e2 量測相同。
  - 需要人做的事：preview 部署不需授權；部署到正式專案要授權。
  - 完成後的狀態：preview 與正式網址讀 shadow D1（切換前）。

- [ ] **12. 反向收斂腳本與切換演練**（被擋於：10f、步驟 11、D6）
  - 範圍：
    - 收斂腳本 v1 定版，加上切換用的計數與指紋報告。
    - 反向腳本 D1 → SQLite 做全表收斂：停用 cron 後把 D1 的 `TABLES` 匯出成本機 SQLite，再以主鍵 upsert 回寫正式副本，涵蓋切換後的新增列與更新列，例如 `opportunity_tracking.state`、`daily_runs`、`mail_sync_state.cursor`、`opportunities.item`、revision。有不可變 trigger 的表只追加。只走 `TABLES`，`DERIVED_TABLES`（10e 的投影）不回寫（Python 沒有也不讀）；回滾後再切換時由 `import-copy` 重建。D1 專屬表（`write_attempts`、`guard`、`writer_lease`）不回寫。
    - 在副本上演練完整切換與回滾各 2 次。
  - 驗收：
    - 2 次演練的指紋報告完全相同。
    - 回寫後的 SQLite 副本通過兩項檢查：
      - `scripts/test_workbench_upgrade.py --database <回寫副本> --previous-source <d994cd2 checkout>`。
      - 用切換前的 Python image 讀取的投影，與 D1 端一致（`scripts/verify_cutover.py` 或新增的投影比對）。
    - mutation：反向腳本漏掉 `opportunity_tracking.state` 這類更新欄位，驗收要失敗。
  - 需要人做的事：授權讀正式 DB 副本。

- [ ] **13. 正式切換（deploy，必須連著做）**（被擋於：步驟 12、D6、4e4b；Will 明確授權；D22 後不再被 D9 擋；D23：步驟 11 完成後盡快做）
  - 前提：D13 讀取預算已量（10e2）（D1 免費方案超過每日額度時，到 UTC 換日前的查詢都會失敗，收案與網頁也會停；2026-10-26 量到寫入額度用完時的錯誤）。
  - D1 沒有資料庫角色（4e 起取代原本「分 runtime 角色、`REVOKE`」的前置決定）：拿到 `D1_API_TOKEN` 的人能改 schema 或刪 trigger（token 範圍是整個帳號的 D1 讀寫，Will 2026-10-26 接受）。不可改的表靠 SQLite trigger 加 client 的租約守衛，`check-storage-triggers` 每次執行檢查 trigger 還在；token 外洩時的處置是撤銷重建。
  - 範圍：
    1. 在 Vercel 專案 Disable Cron Jobs，確認當天 TS 的 shadow run 已結束。
    2. 確認 VM 當天的 `daily_runs` 已是 complete 或 failed（D22 後 Python 的摘要都停在 `pending`，照搬保留，不寄出）。
    3. 停 VM 的 API／worker／Web，用 `docker compose ps` 確認沒有 writer。
    4. 做一致備份；建正式 D1 資料庫，用 `import-copy` 載入備份（內含 migration），產出每表計數與 sha256 報告；不記 Time Travel bookmark（Will 2026-10-26）。
    5. 改 production env：`D1_DATABASE_ID` 指向正式 D1 資料庫、設 `WEB_WRITES=on`（D23）；不加寄送憑證（D22）。`RESEND_API_KEY`、`RESEND_INBOX` 在 shadow 期已存入（D14），沿用；shadow 期超過 6 週或懷疑外洩時先換一把新 key。然後重新部署，並 Enable Cron Jobs。
    6. 驗下一次自然排程；Hobby 會在 09:00–09:59 之間觸發。
    7. shadow D1 資料庫保留到 D6 窗口結束。
  - 回滾（D6 窗口內）：
    1. Disable Cron Jobs；拿掉 `WEB_WRITES` 並重新部署，確認網頁寫入回 403 後才往下做（D23：反向腳本之後的網頁寫入會留在 D1、回不到 SQLite）。
    2. 跑反向腳本。
    3. 用切換前的 image 與 env 重啟 VM 的 Compose（`docs/compose.md:60`；`worker.json` 維持 D22 的 `live_send: false`）。
    4. 不用 Instant Rollback，因為它會恢復舊的 cron 定義。
    - D1 Time Travel 不是回滾路徑：回滾要的是把切換後的變化寫回 SQLite（反向腳本）；Time Travel 只在 D1 端資料本身損毀、要先還原 D1 時考慮，保留天數依方案，執行前查。
  - 驗收：
    - 第 4 小步的每表計數與指紋，等於第 3 小步備份算出的值。
    - 隔天 `daily_runs` 有一列：`status` 是 complete，或 failed 且 `result.source_status` 是 failed（只有來源失敗）；`source_details` 裡至少一個來源 ok。網頁清單的總筆數等於 D1 `opportunities` 筆數；當天新寫入的 opportunities（D1 在切換前後的筆數差）都出現在清單。Will 在網頁上確認看得到。
    - `WEB_WRITES=on` 已設，網頁上的回饋寫進正式 D1（D23）。
    - VM 的 worker 確認已停。
  - 停止條件：指紋不符，或第一次自然排程沒有完成收案 → 照回滾程序處理。
  - 需要人做的事：授權部署；在網頁上確認看得到。
  - 完成後的狀態：VM 停機但保留，直到 D6 窗口結束；4c 的副本排程停用。

- [ ] **14. 收尾**
  - 刪除：
    - `backend/`、`deploy/`、`frontend/`、`contracts/`。
    - `scripts/test_compose.py`、`test_installed.py`、`test_workbench_upgrade.py`、`verify_cutover.py`。
    - `scripts/check_boundaries.py`，由 dependency-cruiser 取代。
    - VM 上 4c 的副本容器，以及 `web/src/ops/`、`web/scripts/{import-copy.ts,snapshot.ts,shadow-job.sh,verify-fingerprints.ts}`（`replay-digest.ts`、`check-novelty.ts` 已在 10f 刪除）。
    - `registry.ts` 的 `SCHEDULED` 與 `enabledSources` 的 `scheduled` 參數（release toggle 到期：等於 `RUNNERS` 扣 `DISABLED` 時，最晚步驟 9 的信件來源全部排上後）。`DISABLED` 改成 source catalog 的資料欄位（PTT 被擋是長期事實，不是開關）。執行中可切換的營運開關（ops toggle）不預先做；觸發：第一次有來源需要比一次授權部署更快關掉，那時做 TS 自己的 DB 表加 UI 開關（切換後 DB 不再被覆蓋，Python 設定契約也已刪除）。
    - `web/tests/fixtures/gen_golden.py`（依賴 `backend/`）；`golden.json` 保留。刪 `backend/` 前先把 `001_sqlite.sql` 凍結進 `web/tests/fixtures/`，改 `web/tests/helpers/db.ts` 的 `SQLITE_SCHEMA_PATH`。
  - 更新：
    - `AGENTS.md`：收斂遷移期規則與技術棧。
    - `README.md`。
    - `docs/design.md`、`docs/compose.md`（改寫成 Vercel 操作）、`docs/implementation-plan.md`、`docs/features.md`、`docs/platform-connectivity.md`、`docs/README.md`。
  - 完成定義逐項核對；獨立設計審查（design-review skill）。
  - 長期檢查接進 CI：schema 漂移、trigger 測試、指紋相容測試、step 型別檢查。
  - 延後項附觸發條件，搬回主清單。
  - D6 窗口結束時處理（2026-10-24 設計審查記下的終局；2026-10-26 依 D17 改寫：不再是「照抄或原生二選一」，而是分成「現在就原生」與「窗口結束後換版本」兩組）：
    - 現在就原生（不影響任何已存雜湊，在各自相關的步驟裡做，不等步驟 14）：業務模組改用 TS 原生型別與 `DomainError` 類別階層，移除 `PyError` 字串分類（步驟 10c、11 起，新程式不再用）；`FAILURE_REASON` 併進 runner spec；`readNotification` 只為例外而呼叫的 `qualify` 刪除；`AccessBlocked` 歸到 collection；ranking／render 的 Python `round`／格式化照抄換原生（決定 R1 的投影步驟一起做）；`mailRecords` 的讀取順序改成明寫的規則；非雜湊的時間欄位改 `timestamptz`、0/1 旗標改 `boolean`（反向腳本負責轉回 SQLite 格式）。
    - 窗口結束後換版本（會改到已存雜湊的輸入）：下列照抄在 D6 前必須和 Python 一致，窗口結束後換成標準實作，寫入改用 v2 雜湊並把已知職缺一次重新基準化（只差版本不通知），v1 函式保留來驗證舊列；`external_id`／canonical URL（`url.ts` 的 `urljoin`）不換，或附舊→新 id 對照表。換之前在 VM 量受影響的職缺數。範圍：`html.ts` 與 `http.ts` 的 `loadsBytes`（盤點缺陷 23）；步驟 7 的 `email.ts` `parsedate_to_datetime`、`re.ts` 的 `\b`＋IGNORECASE、`unicode.ts` 的 `pyInt`／`pyIsDigit`／`pyUpperAscii` 與相關表、`xml.ts` 的編碼判斷；步驟 8 各批的 `re.ts`（`translate`、lookahead、dotAll、`pyFindall`／`pySub`／`pyReSplit`、`\Z`／`pyMatch`）、`unicode.ts`（`pyFloat`、`pyIntToFloat`、`space`／`cased`／`upper` 表、`pyUpper`、`pyRstrip`）、`datetime.ts`（`fromTimestamp`、`dateFromIsoformat`）、`json.ts`（4300 位上限、`rawDecode`）、`xml.ts`（`attrib`、BOM、宣告編碼）、`codecs.ts`、`http.ts` 的 `urlopenRead`／`raiseForUrllibStatus`、taiwanjobs 的 `STRPTIME_YMD`；步驟 9a 的 `getaddresses`／`AddrlistClass`、`utf8Length`；步驟 9b 的 glassdoor `received_at` 格式、cake 的 base64／zlib 規則、`queryValues` 的拒收、`html.ts` 未結束 comment。
    - `golden.json` 拆成兩份：v1 雜湊相容（永久保留，驗證舊列用）與 Python 行為對照（刪除）。
    - 照抄清單的原始逐條紀錄（每批的理由與審查來源）見 `git show dbd9b12:docs/plans/2026-10-23-nextjs-vercel-migration.md` 的本段。
  - 需要人做的事：
    - VM 退役。
    - 刪 Neon 專案 `freelance-agent`（Will 授權），確認 Cloudflare 與 Vercel 帳單。
    - 更新 repo 外的 wiki 專案頁（交給 recording 流程）。
  - 驗收：
    - `rg -n -l "oci-a1|compose|huey|8327|3327|freelance\." .` 的輸出交給 `check_inventory.py`，只剩 `allowed-residue.md` 列的命中。
    - CI 綠燈。
    - design-review 的發現都有處置。

## 決定

- **D1 Vercel 方案、資料庫供應商與區域**（狀態：已決 2026-10-23，Will 照建議（A）；資料庫供應商由 D19（2026-10-26）改成 Cloudflare D1，Vercel 部分仍有效；擋住步驟：1、2；需要的事實：Workflows 的 Hobby 用量與 Neon 免費方案的 branch／儲存上限，在 1b 量）
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

- **D9 摘要寄送通道**（狀態：已決 2026-10-23，Will 照建議（A）；**2026-11-03 被 D22 取代**；擋住步驟：1d、10、13）
  - A：沿用 Gmail SMTP（app password，smtp.gmail.com:465）——不改寄件人與收件體驗；要 1d 驗證 Vercel 能連出 465。（建議；現況已確認是 SMTP）
  - B：改用 Resend 寄送（repo 已有 `resend_delivery.py`）——HTTP API，serverless 最穩；需要自訂寄件網域（`jobs.py:12`），寄件人會改變。
  - C：Gmail API OAuth——不需要 app password，但要處理 refresh token 的存放。

- **D10 API 契約來源**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：4、11）
  - 現況：契約由 `contracts.py` 生成 `openapi.json` 與 `api.d.ts`，有編譯期的負向契約測試（`inventory-surface.md` §3c）。
  - A：zod schema 當唯一來源，server action 與 route handler 共用，負向測試改成 zod 的型別測試；刪除 OpenAPI 生成——全端同一語言後，生成步驟沒有必要。（建議）
  - B：保留 OpenAPI，從 zod 生成——只有在要給外部 client 用時才值得。

- **D11 shadow 期把正式資料副本放進 Neon**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：4）（2026-10-26 修改：換到 D1 後不再每天收斂，只載入一次，見步驟 4e 共同規格；Will）
  - A：每天把正式副本灌進 Neon 的 shadow branch——比對器才能在同一起點比較。這等於切換前就把個人資料放上 Neon，而切換後資料本來就會在那裡。（建議）
  - B：shadow 只用合成資料——資料不提前上雲，但比對器無法驗證真實資料的 dedup 與摘要，步驟 6–10 的驗收要改成只跑合成案例。

ADR：`docs/adr/2026-10-23-nextjs-vercel-full-stack-rewrite.md`（選 C 與已決各題的理由）。

- **D12 PTT 兩個來源（ptt_soho、ptt_codejob）**（狀態：已決 2026-10-23，Will 照建議（A）；擋住步驟：2、8；需要的事實：spike 1e，已完成）
  - 事實：Vercel 的 sin1 與 iad1 對 PTT 都回 403 challenge，VM 與 Mac 回 200（`spikes.md` §1e）。PTT 至今共收 3 筆、0 筆有人工標記（2026-10-23 量到）。依規則不繞過 challenge。
  - A：不搬，切換後停用這兩個來源；歷史資料照搬，`platform-connectivity.md` 標明原因——損失極小（3 筆）。（建議）
  - B：在 VM 或 Mac 保留一個只抓 PTT 的小程式，寫入 Neon——保住來源，但留下要維護的主機，和搬離 VM 的目標衝突。

- **D13 Neon 傳輸量與讀取路徑**（狀態：已決 2026-10-24，Will 照建議；換到 D1 後預算改成 D1 每日列讀取與列寫入，驗收見步驟 11；擋住步驟：11、13；事實：步驟 5 量到一次 `list`／分組回饋約 8.1 MB，Neon 免費方案每月 5 GB、超量暫停 compute）
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

- **D15 摘要怎麼判斷已通知**（狀態：已決 2026-10-26，Will 同意；**2026-11-03 被 D22 取代，帳本在 10f 刪除**；擋住步驟：10b2）：已通知帳本，和 snapshot 同交易推導、不可改，選取時 join 狀態。否決：每天重掃全部 snapshot（傳輸量隨歷史成長，碰 Neon 免費上限）、只看最近 N 天（改變產品行為）。ADR：`docs/adr/2026-10-26-digest-ledger-shared-read-model-native-port.md`。
- **D16 衍生資料的讀取**（狀態：已決 2026-10-26，Will 同意；擋住步驟：10e、11）：UI 與摘要共用一份寫入時投影，取代 D13 原本「只做 UI」的路徑與步驟 14 的摘要 `listIn`。否決：兩條讀取路徑（同一份衍生資料兩套算法會漂移）、全表加快取（serverless 不共用記憶體、每次回饋都失效）。ADR 同上。
- **D17 移植忠實度**（狀態：已決 2026-10-26，Will：「也不一定輸出一致，可以用更好的方式重構」；擋住步驟：10c 起所有新程式、步驟 14）：不再照抄 Python 的實作，也不要求輸出和 Python 一致；改原生寫法，shadow 與 replay 的差異逐項列出、經 Will 接受（完成定義原本就允許）。D4 的目的（不重收、不重複通知）由兩條護欄守住：雜湊加演算法版本，只差版本時重新基準化不通知；`external_id` 不變或附舊→新 id 對照表。已存雜湊的演算法只在 D6 窗口結束後換（窗口內 Python 要能回滾），v1 函式保留驗證舊列。修改了 2026-10-23 ADR 的 D0（輸出一致）與 D4（永久逐位元相容）。ADR 同上。
- **D18 跨來源去重與投影形狀**（狀態：已決 2026-10-26，Will 照建議選 A3、B1；擋住步驟：10e1、10e2、11）：事實（2026-10-26 在 shadow 副本量到）：2,447 筆都只有 URL key、沒有一筆有 content key，沒有任何兩筆共用 key，現行分組在 Python 與 TS 都從未合併；同公司＋同職稱 16 組（跨來源 1）、只看同職稱 55 組（跨來源 7）；內容版本 6 筆在 3 筆 opportunity 上。選 A3：不做跨來源合併，每筆是單一成員群組，DTO／snapshot／token 形狀不變。否決：A1 照現行「衝突保持分開」做增量群組（key 索引、閉包重算，正式資料上合併 0 筆）、A2 現在就做連通分量＋survivorship（在現有 key 下同樣合併 0 筆，要放寬比對才有作用，放寬會誤併）。讀取模型選 B1（衍生投影表）；正規化 `opportunities`（B2）是 D6 窗口結束後的終點（Python 回滾要讀 SQLite 形狀，external）。加回去重的觸發：近 7 天候選裡跨來源同職稱配對達 3 組且人工抽樣確認為同一職缺，或某個 parser 開始廣泛提供 `company`。`docs/design.md` 的「去重與人工狀態」描述的是現行 Python 正式系統，切換（步驟 13）時改寫。ADR 同上（2026-10-26 修訂段）。
- **D18 補充：清單讀取（P1）**（狀態：已決 2026-10-26，Will 照建議選 P1；擋住步驟：10e1、10e2、11）：事實（2026-10-26，shadow 副本上建表後 rollback 量到）：只存內容值的投影全表 2,249,279 位元組，候選 2,384／2,447 筆，SQL 預先排除只省 50 筆；每次清單都讀全表時月用量推估超過 D13 的 1 GB 且隨筆數線性成長。選 P1：依 settings revision 存設定相依結果，SQL 做時間相依部分與分頁。否決 P2（只存內容值、讀取時全表重算）。
- **D19 正式資料庫**（狀態：已決 2026-10-26，Will 選「資料放 Cloudflare D1，程式留在 Vercel」，聽過 REST 上限與沒有互動式交易兩個限制後仍選；同日決定 D1 放在 Will 現有的 Cloudflare 使用者與帳號底下，token 是帳號層級 D1 Read＋Write；擋住步驟：1f、4e、10e1、10e2、11、12、13、14）：事實（Cloudflare 官方文件，2026-10-26 查）：D1 不收傳輸費；Workers Free 每天 500 萬列讀取、10 萬列寫入（整個帳號共用，超過時帳號內所有 D1 查詢擋到 00:00 UTC），單一資料庫 500 MB；每條查詢 100 個綁定參數、SQL 100 KB、單查詢 30 秒、資料庫單執行緒；Vercel 只能經 REST `POST /accounts/{id}/d1/database/{id}/query` 連（可帶 `batch`），Cloudflare API 每個使用者每 5 分鐘 1,200 個請求，超過則全部 API 擋 5 分鐘；D1 auto-commit，Worker 的 `batch()` 是交易，HTTP batch 是否原子文件沒寫；D1 權限只能設在帳號層級（`D1 Write` 的 scope 只有 `com.cloudflare.api.account`，2026-10-26 用 `cf user tokens permission-groups list` 量到），所以同帳號的 `meal-prep-production` 也在 token 範圍內（Will 接受；該資料庫已於 2026-10-26 刪除，當晚量到帳號內只剩 spike 資料庫）。否決：留在 Neon 只做 P1；Neon 付費；整個 app 搬 Workers＋D1。撤回觸發見 spike 1f。修改 2026-10-23 ADR 的 C 選項（Neon Postgres）與 D11（shadow 用 Neon branch）；ADR 修訂段已寫（2026-10-26，storage 修訂段）。
- **D20 取代全域寫入鎖**（狀態：已決 2026-10-26，Will 問「個人用的怎麼做比較適合」，聽完建議後回「好」，選 B；擋住步驟：4e2b）：B 租約加 fencing token（`writer_lease` 一列，取得與讀取同一請求，寫入 batch 開頭守衛 `holder AND token`）。否決 A 聚合版本的樂觀並行（要求每條路徑的讀取集合與每張子表的 trigger 都齊全，漏一個是默默的遺失更新；設定重算時退化成全域計數）。兩者共同的做法（讀取 batch → 記憶體計算 → 一個寫入 batch、單元內記憶體疊加、程式內有上限重試、`write_attempts`）照做。改成 A 的觸發：來源改回並行、第二個使用者或對外 API，或任一次每日執行的等租約超過 2 秒、出現一次等租約逾時或租約一直被搶（`lease_timeouts`、`lease_lost`）；不看 7 天 p95（Will 2026-10-26「現在就改不用等七天」），每次執行都由 `web/scripts/check-storage-triggers.ts` 檢查（`253fb17`，4e3 接進 after job）。D21 改 Worker 的觸發同樣逐次檢查：任一次 429（`d1_errors.rate_limited`）或一次執行超過 600 個請求。ADR：`docs/adr/2026-10-23-nextjs-vercel-full-stack-rewrite.md` 的 storage 修訂段。簡報 `d20-d21-brief.md` v2.1。
- **D21 存取路徑與額度隔離**（狀態：已決 2026-10-26，Will：走 REST、用免費方案、切換後 CI 與正式同一個 Cloudflare 帳號；擋住步驟：4e）：選項與用量見 `d20-d21-brief.md` v2.1。存取：REST 的 `/raw` 端點，token 直接用現有的帳號層級 user token（Will 2026-10-26：「直接用現在的」；2026-11-30 到期，到期前重建並換掉各處的值）。額度：不開 Workers Paid；D1 shadow 不每天收斂（Will 2026-10-26），只在換過去時載入一次，每日寫入約 1–2%（推論），原本的增量 converge（舊 4e5）不需要，1f 的 50% 撤回觸發遠低於門檻。否決：Workers Paid（每月 5 美元）、Worker 代理（多一個 runtime；觸發：任一次 429、一次每日執行請求數超過 600、帳號加入別的專案的資料庫）、CI 放另一個帳號。

拍板順序：D1、D3、D4、D6、D7、D8、D10、D11 已於 2026-10-23 拍板。D9 於同日拍板（A）。D2、D5、D12 在 spike 1 之後於同日拍板（A）。D13 於 2026-10-24 拍板（A）。D14 於 2026-10-25 拍板（A）。D15、D16、D17、D18（含 P1）、D19 於 2026-10-26 拍板；D20、D21 於 2026-10-26 拍板。D2 等 spike 1b，D5 等 D1 與 D2，在步驟 1 完成後再交。

- **D22 不建摘要、不寄信，先只做網頁前端**（狀態：已決 2026-11-03，Will：「不需要摘要，也不要寄送 email，我先只要有網頁前端可以看就好」；四個選項依建議或 Will 的選擇：Python 也現在停寄、TS 摘要程式刪除、前端第一版做清單＋收藏／略過（含設定）、現在在分支上開工）：取代 D9、D15，改寫步驟 10（新增 10f、取消 10d）、11、12、13、14 與範圍、不變量、全域約束。Python 停寄的做法與回滾見前提第一條；11-04 確認當天摘要停在 `pending`。重新加回摘要的觸發見範圍的延後。

- **D23 切換前網頁唯讀、提前切換、切換後暫時沒有工作台**（狀態：已決 2026-11-03，Will：切換前寫入怎麼處理選「提前切換」，工作台選「接受，要用時再做」；計畫審查指出 shadow 期寫入會在切換時消失後提出；擋住步驟：11、13）：選項：切換前唯讀／可寫但標明會丟／切換時合併／提前切換；工作台：接受延後／切換前要有／只要投案紀錄。結論：步驟 11 的寫入由 `WEB_WRITES` 開關控制，切換前關閉；11 完成後接著做 12、13（仍等 4e4b 與 D6 的回滾準備）；投案、客戶、模板、草稿在切換後暫時沒有入口，資料照搬，要用時再改寫。

## 進度

狀態值：未開始／進行中／程式完成待驗收／完成。

| 步驟 | 狀態 | 已跑的驗收 | 未跑的驗收與原因 | commit |
|---|---|---|---|---|
| 1 Spike | 進行中 | 1a、1b、1e 成立；1c 合成 707/707；1c 正式副本（2026-10-24，VM 容器內）：職缺 ID 與指紋 2,226/2,226、信件內容版本 6/6、摘要 snapshot 37/37 round-trip（submission 0 筆，HP4 無列可驗）；1d 連線成立（`spikes.md`）；1f（2026-10-26，`spikes.md` §1f）：HTTP batch 原子、BEGIN 一律被拒、守衛語句與 trigger 可讓整批回滾、iad1 單請求 p95 60–90 ms、最大 batch p95 ≤ 640 ms，撤回觸發都沒成立；逐句移植會超過 REST 上限，要按來源批次合併；shadow 全刪全載約佔每日寫入額度 35–45% | 1d 實寄已跑（2026-10-26，iad1，Gmail 接受 1／拒收 0、登入 225 ms，`spikes.md`）；Will 確認收到兩封、顯示正常 | |
| 2 盤點去向 | 完成 | `check_inventory.py` exit 0（243＋29 列、20 項缺陷）；改一列為 TBD 時 exit 非 0；6 個計畫缺口已補進步驟 5、10、11、13 | `--residue` 要到步驟 14 才跑 | |
| 3 Walking skeleton | 完成 | 本機：`pnpm typecheck`、`pnpm boundaries`（違規 import 被擋）、`pnpm test` 5/5（mutation：移除開頭標 failed → 2 失敗）、`pnpm build`；preview 未登入 302、錯誤 secret 401、觸發 cron 後頁面出現 `skeleton ok`；舊路徑 diff 為空。CI：public repo run 39968672002，backend ✓、web ✓ | 無 | `813df86`（archive repo）；公開版 `5b94e25` |
| 4 共用層 | 完成 | 本機與 CI（run 39986551118、39989561988）全綠；mutation 全部會失敗。VM（2026-10-24）：正式副本收斂 25 表來源／目標指紋相同，同副本收斂兩次報告相同，自我比對 0 差異；Python（正式 `d994cd2` 映像）與 TS 對同一份正式資料的 `list()`（2,226 筆、9,385,428 位元組）與分組（11,379,263 位元組）sha256 相同；`freelance-shadow-morning.timer` 已啟用，正式容器未變動 | 08:30 timer 首次自然執行待觀察；10:30 after timer 在步驟 5 啟用 | `a3de985`、`e7b8c51`、`13d991c` |
| 4e 儲存層換 D1 | 進行中（拆成 4e1–4e4b；D20、D21 已決）；4e1 完成（`0701406`）、4e2a 完成（`789d83c`）、4e2b 完成（`e988871`、觸發檢查 `253fb17`）、4e3 完成（`fd88c11`、`7a4942c`）、4e4 程式完成待驗收（2026-11-03：PR #2、#3 合進 main `6c33182`，shadow D1 一次匯入 ok，Vercel `fpy1yk482`，VM 映像 `:6c33182`；等 11-04 的 TS run 與 after job；同日查 Python 當天摘要停在 `pending`，D22） | 4e3（替身）：全套 38 檔 438 過、1 skip、0 紅；`pnpm typecheck`、`pnpm boundaries`、`pnpm build` 全綠（4e 開始以來第一次）；`ops.test.ts` 15 個（匯入兩次報告相同、位元組不變、schema 完整、匯入後可寫；tracking_events id 接續；D1 專屬表不動；帳本重建；斷線後重跑；值型別不符拒絕、NUL 照樣往返；表集合不符拒絕；租約被占時放棄；DDL 取自目錄；migration 經租約套用 ALTER；snapshot；replay 相同、竄改、無 digest、inconclusive）；`scripts/replay-digest.ts` 在合成副本上實跑 same、無 digest 時 inconclusive；mutation 5 項全紅（匯入不重建帳本、匯入漏一張表、反向 drop 改正向、重建不含 trigger、live 資料庫的 migration 不走租約）；設計審查 7 項（改 5、記 1、提 1）。4e2b（替身）：全套 37 檔 421 過、14 紅、1 skip，紅的只有 `tests/ops.test.ts`（4e3 範圍）；新增 `tests/write-units.test.ts` 18 個（一個請求讀、一個請求寫；同一批重複 `external_id` 看得到前面的寫入；1,300 筆分批、每批 receipt 跟著職缺、健康狀態最後；沒有守衛被 client 拒送；租約過期被拿走時舊持有者被擋並重讀重算，兩邊改動都在；釋放後同一 token 被擋；UI 等租約後兩邊都寫進；UI 5 秒逾時與租約一直被搶各回 409；持有者當掉時等過期；`write_attempts` 7 天清理；非收案單元不分批；async 計算被擋；純 INSERT 與 upsert；儲存失敗的 reason 與計數；結果不明時 track 與內容版本都只寫一次；每日用量進 result 頂層）；`novelty.test.ts`、`scale.test.ts`、golden 全過；mutation 4 項全紅（拿掉守衛＋client 檢查、守衛只比 token、疊加層不回傳尚未送出的寫入、結果不明時直接重送），另 1 項（等租約後沿用沒租約時的讀取）紅；`pnpm boundaries` 過；`pnpm typecheck`、`pnpm build`（Turbopack 與 workflow 編譯成功）只紅在 4e3 範圍（`scripts/*`、`src/verify/replay.ts`、`tests/ops.test.ts`）；設計審查兩輪（15 項：改 10、記 2、駁回 2、部分駁回 1）。4e2a（替身）：`schema.test.ts` 10、`delivery.test.ts` 15、`daily-runs.test.ts` 4、`tests/d1-paths.test.ts` 8 個全過；全套 297 過、115 紅、4 skip，紅的全在允許範圍（第 2、3 類寫入與依賴它們的測試、4e3 的 ops），歸因實驗見 4e2a 實作狀態；mutation 10 項全紅（`finishDigest` 拿掉 `status = 'attempted'`、`claimDailyRun` 不讀回、`readAll` 每個讀取一個請求、`insertDigest` 不接唯一鍵失敗、`retrying` 不拆 drizzle 的 cause、欄位型別漂移、唯一鍵變一般 index、submission trigger 本體被拿掉、帳本 key 改成綁定參數、backfill 每份 digest 一個請求）；`pnpm boundaries` 過；`pnpm typecheck`、`pnpm build` 只紅在允許範圍（build：5 個 `writeTransaction` 匯入）；設計審查 6 項（改 4 記 2）。4e1：`src/db/d1` 9 個測試（HTTP 錯誤分類 7 種、bigint／布林編碼、不安全整數 fail closed、替身拒絕交易語句與 101 個參數與 100 KB＋1、batch 原子、drizzle 查詢與 batch）；`tests/d1-real.test.ts` 對 spike D1 通過（沒設 env 時 skip）；mutation 2 項全紅（替身拿掉 BEGIN 檢查、client 拿掉不安全整數檢查）；`pnpm typecheck`、`boundaries`、`build` 過；全套 36 檔 407 過 1 skip（本機 Postgres） | CI（2026-11-03，PR #2 run `41551184578`，`0bb463c`）5 個 job 全過；`d1` job 對 CI 專用庫 `freelance-agent-ci-test` 跑 2 檔 6 個測試（空庫套全部 migration、writer lease 取得／拒絕／fencing、250 個 key 一個 `json_each` 參數、匯入報告相同、寫入額度）；shadow 與正式 D1 尚未套 migration；VM 映像未建 | `0701406`、`789d83c`、`e988871`、`253fb17`、`fd88c11`、`7a4942c`、4e4 準備 `afebf31`（分支 `4e-d1`） |
| 5 TS 端排程骨架 | 完成 | 正式專案部署；手動觸發（01:17）回 not due、shadow 無寫入；`vercel env ls production` 只有 4 個 key、無寄送憑證；Neon 傳輸量已量；2026-10-24 自然執行：08:31 morning `converge ok`、09:14 cron 寫唯一一列 `complete`、12:53 cron log「已有 run」 | | `199bef1`、`e6a299c` |
| 6 試點 Jobicy／Remotive | 進行中 | 本機：golden（HTML 98、normalize 96）、真實 feed 209 筆逐位元組相同、6 個 Python 案例、5 個 mutation、獨立審查 2 份；7 天比對第 1 天（10-25）logic 0、timing 0；第 2 天（10-26）jobicy、remotive 0 差異 | 7 天比對第 3–7 天、比對器 mutation；2026-10-24 已部署、after timer 已 enable；10-25 起比對範圍擴大為 16 個來源 | |
| 7 CryptoJobsList | 已部署（2026-10-25，`920b6b4`） | 本機：golden（RSS 123、text 127、日期 126、int 26）、真實 feed 100 筆逐位元組相同、4 個 Python 案例、交易邊界 mutation | 3 天比對第 1 天（10-26）0 差異；第 2–3 天未跑；10-26 發現 `source_details` 記成 `invalid_source_result`（10a 缺陷，見步驟 10，已修待部署）；依序執行的 fan-out 隨同一次部署上線 | |
| 8 其餘免登入來源 | 進行中 | 第 1 批（himalayas、hackernews、v2ex）與 getonboard 程式完成：golden、真實回應逐位元組相同、9 個 store 案例、13 個 mutation、差分模糊測試與設計審查；第 2 批（public_feeds 4 個）程式完成：golden、真實回應 351 筆逐位元組相同、14 個 store 案例、13 個 mutation、設計審查；第 3 批（nodesk、justremote、dynamitejobs、jobbank518、chickpt）程式完成：golden、5 個來源的實抓回應輸出逐位元組相同、37 個 Python 案例、25 個 mutation、設計審查（改 4、記 1） | 第 1–3 批 2026-10-25 已部署（`920b6b4`），3 天比對 10-26 起；jobbank518 索引頁修正（Python 也上 VM，見第 3 批）；最後一批（taiwanjobs、arbeitnow、freelancer）2026-10-25 程式完成：golden、真實回應逐位元組相同、29 個入庫案例、20 個 mutation、設計審查（改 4、記 2），同日部署（`82cd89d`），3 天比對第 1 天（10-26）：logic 1（weworkremotely 的 health，以抓取時間差解釋，見步驟 6 第 2 天）、timing 12（himalayas、remoteok 晚抓看到的新職缺）；第 2–3 天未跑。step 耗時已量（10-26，見步驟 10「10-26 自然執行」）：freelancer 25.5 秒、最長 step 25.5 秒，低於觸發值 | |
| 9 信件來源 | 進行中 | 9a（共用收信、tasker、linkedin）與 9b（cake、104、talent、glassdoor）程式完成：golden（寄件者、主旨 gate、parser、read_notification、41 個 sync 情境逐表比對）、12＋16 個 mutation、設計審查兩輪（9a 改 2 記 1 提 1 駁回 1；9b 改 5） | 2026-10-25 排程並部署（`f23f052`，`2cqsaiyx1`）；3 天比對第 1 天（10-26）：mail_sync_state 6／6、mail_ingestion 8／8 相同，信件來源 opportunities 0 差異；第 2–3 天未跑。信件 step 耗時已量（最長 linkedin 6.4 秒）；Resend 狀態碼沒有原始紀錄（不記錄、log 只留 1 小時），由結果推論為 200（見步驟 10「10-26 自然執行」） | |
| 10 摘要與寄送 | 進行中（10a、10e 繼續；10b、10b2、10c 由 10f 刪除；10d 取消，D22） | 10a（`51eb12f`，CI run 40193316438 綠）：typecheck、boundaries、build、344 個測試、5 個 mutation、golden `failure_reasons` 21 個；10b（`3add463`、效能修正 `a5b2e6c`）：golden（digest 情境、render 12 例、run_daily 4 例）逐位元組相同、22 個 mutation、replay 測試（相同、竄改、無 digest、inconclusive）、設計審查 9 項已分流；正式副本建摘要 12 秒 | 10a＋10b 已上 shadow（`a5b2e6c`，`8h6bndpwp`，VM `:a5b2e6c`），10-25 副本 replay same；replay 7 天比對、shadow 7 天候選清單比對從 10-26 起算；2026-10-26 依 D15–D17 新增 10b2（帳本）與 10e（共用投影），順序 10b2 → 10c → 10e → 10d；10b2 程式完成待驗收（`7c61740`，CI run 40219932273 web／backend 兩個 job success；本機驗收見 10b2 實作狀態；已上 shadow（`c247200`，`kzojngp21`，VM `:c247200`）；10-26 第一次自然執行：replay 經帳本 same、帳本檢查 0 缺 0 多；其餘 6 天未跑）；10a 缺陷（cryptojobslist 的 `feed_built_at` 讓 detail 被拒）已修（`deabd9e`，CI run 40264261136 web／backend 兩個 job success），已部署（`5knxy7mjg`），10-27 自然執行待查；10c 程式完成待驗收（`48e4684`，CI run 40268230155 web／backend 兩個 job success；與 10a 修正一起已上 shadow（`86b62be`，`5knxy7mjg`，VM 不換），10-27 自然執行待查；本機：typecheck、boundaries、build、34 檔 398 個測試、9 個 mutation、對抗式審查改 3 記 1，見 10c 實作狀態；1d 實寄已跑，Gmail 接受 1／拒收 0，Will 確認收到）；10d 取消（D22）；10f 未開始（D22，2026-11-03 新增）；10e 設計已拍板（D18，2026-10-26），拆成 10e1、10e2；10e1 程式完成待驗收（分支 `10e1` 的 `526a1c1`、`f23f2f2`，2026-11-03，本機：typecheck、boundaries、build 0，`pnpm test` 38 檔 447 過、7 skip（審查修正後重跑），10 個 mutation 全紅，設計審查 8 項已分流；真 D1 正式量級已量（改設定 4.5–5.8 秒、一個寫入請求）；CI 過：draft PR #4 run `41584640879`（`0829347`），web、backend、d1 job 全過，d1 對 CI 庫 7 個測試（含新的 `json_each` 與匯入重建）、寫 353 列；見 10e1 實作狀態）；10e2 程式完成待驗收（分支 `10e2`，draft PR #5 疊在 #4 上；CI run `41593863307` web、backend、d1 全過；本機 39 檔 453 過、9 個 mutation 全紅；開工與完成前設計審查、`/code-review` 已分流；真 D1 列讀取量已量（一頁 15,252 列、回饋約 30 列、摘要 19,609 列），量測發現 snapshot 超過 2 MB 會失敗（D22 後不再適用）；真實副本 replay 未跑，見 10e2 實作狀態） | |
| 11 網頁前端第一版（D22、D23 改寫） | 未開始（2026-11-03 起在分支上開工） | | | |
| 12 反向收斂與演練 | 未開始 | | | |
| 13 正式切換 | 未開始 | | | |
| 14 收尾 | 未開始 | | | |
