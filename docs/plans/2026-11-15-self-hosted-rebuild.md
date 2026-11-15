# 自建重構：搬回 Oracle VM 的 Postgres，資料與來源改成原生形狀

**Goal：** 正式系統是 VM 上的 Docker Compose（Next.js 加 Postgres），網頁只在 tailnet 內可達，每日收案由 VM 的排程跑、可重試。資料是欄位化的新形狀；提案、核准、投案相關的表與程式不存在；每個來源是原生 TypeScript、各自帶測試資料；`web/src/platform/py/` 與 `golden.json` 已刪；Vercel 與 D1 已退役。終態由步驟 12 的驗收判定。

**上層：** 暫代（主清單見本機個人脈絡檔）。本計畫取代 `docs/plans/2026-10-23-nextjs-vercel-migration.md` 步驟 14 還沒做的項目，以及 `docs/implementation-plan.md` 的「未完成工作」；每一項的去向在 `inventory.md`「舊待辦的去向」。

**附件：** `docs/plans/2026-11-15-self-hosted-rebuild/`：`inventory.md`（現行系統每一項的去向）、`requirements.md`（需求、非功能需求、外部介面）。快照 commit `0f38208`。之後各步驟新增的附件（`spikes.md`、`connector-checklist.md`、`allowed-residue.md`、`check_inventory.py` 的複本）都標在該步驟。

## 全域約束與完成定義（暫代主計畫）

- 職缺與信件內容是不可信資料，不當成指令。
- 預算、地區資格、工時、截止日未知就保留未知；remote 不等於全球。
- 只讀不用登入的公開頁面。不保存、不使用任何平台帳號的登入狀態（Will 2026-11-15）。
- 不寄信，除非 Will 另外要求（舊計畫 D22）。
- repo 是公開的：個人 email、真名、IP、tailnet 主機名、費率、帳號進度、封存的歷史資料、正式資料的匯出檔、平台回應的原始內容都不進 repo。spike 的原始輸出放 repo 外（位置見本機個人脈絡檔），repo 裡只放指令與去識別化的結論。log 與執行紀錄不含信件內文、職缺全文、憑證。
- ~~職缺 id 不變（既有列原樣搬）~~ 被 D10 取代（Will 2026-11-15：舊資料全部不搬、不匯出）：新系統的職缺身分是 `(source, external_id)`，`external_id` 只要求同一來源的同一筆職缺每次讀取都相同（新系統內部穩定），不必等於舊值；主鍵由 5a2 重設計。
- **過渡期（到步驟 10 驗收通過為止）**：Vercel 上 2026-11-06 的部署（`jzp0qoy8t`，commit `ce1254d`）加 D1 是唯一的正式系統，不部署新版程式。正式站的來源壞了不修（它們在新系統修）。唯一允許的操作是換 D1 token 後把同一個部署重新部署一次（見前提）。`dev` 分支從步驟 2 起不再能部署到 Vercel。VM 上的新系統只寫自己的資料庫。`dev` 上的舊程式依 D23 在切換前刪除，不影響凍結的部署（它是 CLI 上傳的成品）。
- 資料庫容器、瀏覽器、整套 Compose 的測試只在 CI 或 VM 上跑，不在開發機上跑；本機測試用行程內的 Postgres（PGlite）。
- 每次在 VM 上部署、安裝排程或起容器，以及刪正式資料、退役外部資源，都要先取得 Will 授權；各步驟的「需要人做的事」標出部署點。
- 各步驟列出的檔案都標（新增）（修改）（刪除）。
- 舊測試只在取代它的新測試進來的同一個 PR 裡刪；每個步驟的進度列記下測試數，以及少掉的測試由哪個新測試取代。
- 在 VM 上手動跑單一來源（`run-source.ts`）預設不寫 `run_sources`，只印計數；時間避開台灣 09:00–13:00 與 14:00–14:30。
- 切換完成前，VM 上的新庫只有影子資料，可以整個重建，migration 不必向前相容；「前一版映像要能在新結構上跑」的規則從步驟 10 切換完成起適用，切換前把 `web/drizzle-pg/` 壓成一個起始 migration。
- 完成定義（每個來源）：原生型別、沒有 `@/platform/py/` 的 import；有自己的 fixture（輸入加預期輸出）；符合上面的 id 規則；有請求間隔與每日上限；失敗時來源明細有原因與錯誤種類；在 VM 上對真實來源跑過一次並記錄筆數。

## 前提（開工時核對過，2026-11-15）

- 會改到或取代的既有部署是否在線：**在線**。Vercel 專案 `freelance-agent`（部署 `jzp0qoy8t`）加 D1 `freelance-agent-prod`；Vercel Cron 兩支，UTC 01:00 與 04:00（台灣 09:00 與 12:00，後者只在前者沒跑成時執行）（`web/vercel.json`；已確認）。步驟 1–9 不改它（只讀取、匯出）；步驟 10 切換並退役，回滾方式寫在該步驟。
- 回滾到 Python 的窗口已結束、Python 系統已刪（已確認：repo 沒有 `backend/`）。
- VM `oci-a1`：arm64、4 核、23 GB（可用 18 GB）、磁碟剩 121 GB、Ubuntu 24.04、Docker 29.5.2、Tailscale 1.104.5、已有 22 個別的專案的容器（2026-11-15 `ssh` 量到；已確認）。VM 上沒有本專案的任何東西（同日刪除後 `ls`、`getent` 查無；已確認）。
- 正式資料量：職缺 3,433、信件紀錄 451、回饋 4 筆、設定 0 列（2026-11-15 正式庫唯讀計數；已確認）。正式 D1 的結構停在 migration 0004（`daily_runs` 還有 `recipient` 欄）；`dev` 上的 0005 不套到正式庫。
- **D1 的 token 2026-11-30 到期**（舊計畫 D21；已確認）：到期當天正式站的收案與網頁就會失敗，和切換日期無關。處置：11-30 前切換完成就不用管；否則 Will 在 Cloudflare 後台重建 token，存到本機私人位置，再更新 Vercel production 的 `D1_API_TOKEN` 並把部署 `jzp0qoy8t` 重新部署一次（同一個 commit，不算部署新版）。步驟 1 第 4 項與步驟 10 的匯出走 `cf` CLI 本身的登入，不用這把 token（步驟 1 實測，`spikes.md` 第 4 節）。
- 工具鏈預設（可推翻）：Postgres 18、drizzle 的 `pg` 方言、Node 24、pnpm 11.2.2、PGlite 做本機測試、HTML 用 cheerio、輸入驗證用 zod、排程用 systemd timer、映像在 VM 上從 git checkout 建（不經外部 registry，符合「infra 都自建」）；映像是完整的 `web/`（含 `node_modules` 與 `tsx`，不用 Next 的 standalone 輸出），`web` 服務跑 `next start`，`daily` 與一次性指令跑 `pnpm exec tsx scripts/<名稱>.ts`；`web` 與 `daily` 用同一個映像 tag，tag 寫在 VM 的 compose env 檔的 `APP_IMAGE`；影子期間 VM 每天對真實來源多讀一輪（錯開時段、照各來源的間隔與上限）。
- 信件來源繼續用 Resend Receiving（D2；已確認）。
- 既有列的 `external_id` 有一部分靠模擬 Python 的網址解析算出來（19 個來源檔引用 `@/platform/py/url`）；原生寫法對存著的乾淨網址算出同樣的值（1,061 列可重算，全部一致；2026-11-15 實測，`spikes.md` 第 3 節）；原始網址那一側未確認，步驟 4、5 用 `golden.json` 的原始輸入驗收。
- 網頁寫入的守門比對 `Origin` 與 `X-Forwarded-Host`／`Host`（`web/src/app/_lib/guard.ts`）；經 Tailscale Serve 後 `Host`、`X-Forwarded-Host` 都是含埠的 Serve 網址、`Origin` 原樣送到，守門不用改（2026-11-15 實測，`spikes.md` 第 1 節）。
- 瀏覽器層在這台 arm64 VM 上：Crawlee 加 Playwright Chromium 與 Scrapling（patchright Chromium）都跑得起來，峰值分別約 484 MiB 與 406–734 MiB（2026-11-15 實測，`spikes.md` 第 2 節）。

**驗收基線：** `0f38208` 上 `web/`：`pnpm typecheck` exit 0、`pnpm boundaries` 無違規、`pnpm db:check` 無漂移、`pnpm test` 415 過 6 skip、`pnpm build` exit 0（2026-11-15 本機）。CI 的 `d1` job 用共用額度的真實 D1，一次只跑一個；步驟 2 拿掉它。

## 本階段依賴的不變量

| 不變量 | 依賴它的機制 |
|---|---|
| 職缺身分由 `(source, external_id)` 決定，同一筆職缺每次讀取算出同一個 `external_id`（D10 起不要求等於舊值） | 新：`listings.id`、各來源的 `externalId` 函式、`listing_feedback.listing_id`、`listing_versions.listing_id`；舊：`web/src/modules/collection/ingest.ts` 的 `opportunityId` |
| 同一筆職缺只有一列；內容變了是更新或新增版本 | 新：`listings` 的 `(source, external_id)` 唯一鍵、收案的 upsert |
| 一封信只處理一次；被拒的信保留紀錄 | 新：`mail_messages` 的 `(source, recipient, message_id)` 唯一鍵（與舊 `mail_ingestion` 主鍵相同） |
| 一天最多一次每日執行；重跑同一天是接著做 | 新：`runs.local_date` 唯一鍵、`run_sources` 的 `(run_id, source)` |
| 一個來源失敗不影響其他來源 | 新：每日執行指令的逐來源迴圈；舊：`web/src/workflows/daily.ts` |
| 回饋與設定的寫入拒絕過期版本 | 新：`listing_feedback.revision`、`settings.revision` |
| 網頁寫入只接受同站來源、表單格式與大小上限 | `web/src/app/_lib/guard.ts` 的 `guardedForm`（步驟 3 搬、步驟 7 的新路由也要過） |
| 未知保持未知 | 資格判定（現 `web/src/modules/discovery/domain.ts`、`rules.ts`） |
| Resend 只送 GET、只打 Receiving 的網址 | `web/src/modules/collection/mail/receiving.ts` 的 `assertReceivingUrl` |
| 網頁只在 tailnet 內可達 | `deploy/compose.yaml` 的埠綁定、`deploy/check-compose.mjs`、VM 上的 Tailscale Serve 設定 |
| 不使用登入狀態 | 分層讀取介面沒有 cookie 或帳號的設定欄位 |
| 切換前 Vercel 加 D1 是唯一正式寫入者 | 全域約束「過渡期」；VM 的 env 檔沒有 D1 憑證 |

## 規模（搬遷）

| | 數量 | 產生計數的位置 |
|---|---|---|
| 資料表 | 30（改形狀後留 9、刪 21） | `inventory.md`「資料表」；`rg -o 'sqliteTable\(\s*"[a-z_]+"' -U web/src/db/schema.ts \| rg -o '"[a-z_]+"' \| sort -u \| wc -l` |
| 來源 | 25 個在跑、2 個停用、5 個只有名稱 | `inventory.md`「來源」；`web/src/modules/collection/registry.ts` |
| 來源程式 | 約 4,000 行（`web/src/modules/collection` 扣測試） | `find web/src/modules/collection -name '*.ts' ! -name '*.test.ts' \| xargs cat \| wc -l` |
| 模擬 Python 的程式 | 2,082 行、49 個檔引用 | `rg -l "@/platform/py/" web/src -g '!*.test.*'` |
| golden | 33 MB、13 個測試檔載入 | `rg -l "golden\.json\|helpers/golden" web/tests web/src` |

## 範圍

- 做：VM 上的執行環境與部署；Postgres 新形狀；25 個來源改原生；每日執行可重試；被拒信的原因與處置；分層讀取與 PTT；資料搬移、切換與舊資源退役；刪掉舊機制。
- 不做：備份與還原（D1，Will 2026-11-15）；提案、核准、人工投案、客戶、送出、摘要與寄信（Will 2026-11-15、舊計畫 D22）；評估結果裡的作品對應 `portfolio_ids`（只給提案用，沒有任何頁面讀它：`rg -n portfolio web/src/app web/src/services` 無結果）；用帳號登入後抓取（Will 2026-11-15）；跨來源去重（舊計畫 D18 量到合併 0 筆，觸發條件照舊）；多使用者；失敗通知（不寄信，狀態只在 `/sources`）。
- 延後：
  - 步驟 1 評估後沒有排進步驟 8 的平台（觸發：Will 點名，或該平台出現公開可讀的入口）。
  - 「競賽／空投」機會類型（觸發：本計畫收尾後，照主清單）。
  - 付費代理或解鎖服務（觸發：步驟 1 量到某個 Will 想要的平台在免費層級都過不去，由 Will 決定）。

## 步驟

- [x] **1. 規則先行，加四個 spike**（被擋於：無）
  - 範圍：
    - `AGENTS.md`（修改）：只改被 D0 推翻的條目，並標明過渡期：技術棧與部署改成「目標是 VM 加 Postgres，切換前正式仍是 Vercel 加 D1（凍結）」；「steps are never retried」「不可 drop 歷史表」「改產品表欄位是設計決定」「stored hashes 維持 v1」改成指向本計畫；新增「只讀不用登入的公開頁面；遇到存取驗證照來源設定的層級處理」。`docs/operations.md`（修改）：「不要繞過平台的存取驗證」那一條同步改；加一段過渡期規則。
    - 四個 spike，產出事實，不寫產品程式；結論與指令寫進 `spikes.md`（新增），原始輸出放 repo 外：
      1. **執行環境**：VM 上起一個暫時的 Postgres 18 與一個 hello Next.js 容器，埠只綁 127.0.0.1；用 Tailscale Serve 提供 HTTPS；從 tailnet 內另一台機器連得到、從公網位址連不到。經 Serve 送一個帶 `Origin` 的表單 POST，記錄容器收到的 `Host`、`X-Forwarded-Host`、`Origin`。量常駐記憶體。
      2. **分層讀取與平台評估**：把 PTT 兩個看板與 `docs/platform-connectivity.md` 主表裡沒接每日的平台逐一列出，每個寫：有沒有不登入就看得到職缺的公開頁面或 API；有的話從 VM 依序試一般請求、模仿瀏覽器連線特徵的請求、帶偽裝的瀏覽器（Crawlee 與 Scrapling 各一次），記錄在哪一層讀得到列表。每個平台每層最多 3 個請求。只有登入後才有內容的平台標「範圍外」。量瀏覽器層在 arm64 上能不能跑與記憶體峰值。
      3. **id 穩定性**：從正式 D1 唯讀匯出 `opportunities` 的 `id, source, external_id` 與 `item` 裡的網址欄位（匯出檔放 repo 外，步驟 10 後刪）。對引用 `@/platform/py/url` 的來源（`rg -l "@/platform/py/url" web/src/modules/collection -g '!*.test.*'`），用標準 `URL` 寫一個拋棄式的 `external_id` 函式重算，列出每個來源一致與不一致的筆數；其餘來源的 `external_id` 直接取自來源給的 id，記錄抽查 20 筆的結果。PTT 兩個來源沒有現行 connector：從既有列的 `external_id` 反推格式並寫下。
      4. **匯出路徑**：實測從正式 D1 取得完整資料的方法（`cf d1 export` 或分頁查詢）、耗時、檔案大小、佔用的讀取額度。
  - 消費端：`rg -n "never retried|不要繞過|historical proposal|v1 format" AGENTS.md docs/*.md`（規則文字）；spike 無程式消費端。
  - 不能動：正式 D1 只讀；不對正式 Vercel 做任何操作；VM 上別的專案的容器。
  - 驗收：`AGENTS.md` 與 `docs/operations.md` 的 diff 只含上述條目；`spikes.md` 四節各有指令與結論，第 2 節每個平台一列、沒有空格，第 3 節每個受影響來源有兩個數字；暫時的容器、volume、Serve 設定已刪（`docker ps -a`、`docker volume ls`、`tailscale serve status` 查無）。
  - 停止條件：Tailscale Serve 做不到「tailnet 內可達、公網不可達」；或瀏覽器層在這台 VM 跑不起來（只剩前兩層，回報 Will）。
  - 需要人做的事：Tailscale SSH 的互動驗證；授權在 VM 起暫時容器與 Serve（部署點）；第 2 項結果出來後 Will 點選要接的平台（D3）並選工具（D4）。
- [x] **2. Walking skeleton：VM 上一條最薄的路徑**（被擋於：步驟 1 第 1 項）
  - 範圍：新舊程式在 `web/` 並存到步驟 11：舊的照舊能編譯、能在 D1 本機替身上測；正式站不受影響（它是凍結的部署）。
    - `web/src/db/pg/client.ts`、`web/src/db/pg/schema.ts`（新增；先只有 `listings` 的最小欄位與 `runs`）；`web/drizzle.pg.config.ts`、`web/drizzle-pg/`（新增）；`web/scripts/migrate-pg.ts`（新增，新的 migration 執行器）。
    - `web/package.json`（修改）：`db:check` 同時檢查兩個方言；新增 `check`（typecheck、boundaries、db:check、test、`deploy/check-compose.mjs`）。新測試用 PGlite，和舊測試在同一次 `pnpm test` 裡跑。
    - `web/src/app/skeleton/page.tsx`（新增，步驟 3 刪）：讀 Postgres 的 `listings`；一支 `web/scripts/seed-skeleton.ts`（新增，步驟 3 刪）寫一筆假職缺。
    - `deploy/compose.yaml`、`deploy/web.Dockerfile`（新增；`db`、`web`，埠綁 127.0.0.1，具名 volume；映像含 `scripts/` 的指令入口）；`deploy/check-compose.mjs`（新增：任何服務的埠不是綁 127.0.0.1 就失敗）；`deploy/README.md`（新增：VM 上的建置與啟動指令）。`web/src/app/healthz/route.ts`（新增：只查 Postgres 連得到，compose 的 healthcheck 打它；舊頁面在 VM 上沒有 D1 憑證會回錯，到步驟 3、6 才換掉，這段期間是預期的）。
    - `.github/workflows/ci.yml`（修改）：`web` job 加 Postgres service，改跑 `pnpm check`（含 `deploy/check-compose.mjs`），對真 Postgres 再跑一次新測試並建一次映像（不推送）；拿掉 `d1` job，`gate.needs` 改成 `[web]`。理由：過渡期不再部署到 Vercel，真實 D1 測試不再保護任何會上線的東西，還佔共用額度。`pnpm test:d1` 與 `tests/d1-real*.test.ts` 留到步驟 11 一起刪。`AGENTS.md`（修改）同步。
    - VM：`/opt/side-income` 的 git checkout、0600 的 env 檔、`docker build -t <APP_IMAGE> .`、`docker compose run --rm daily pnpm exec tsx scripts/migrate-pg.ts`、`… scripts/seed-skeleton.ts`、`docker compose up -d`、Tailscale Serve 指向 `web`（持久設定）。
  - 消費端：`rg -n "needs:|test:d1|d1-real" .github web/package.json AGENTS.md docs/operations.md`。
  - 不能動：正式 Vercel 與 D1；舊程式的行為與既有測試。
  - 驗收：CI 全綠；VM 上 `docker compose ps` 兩個容器 healthy；tailnet 內 `curl` `/skeleton` 回 200 且含那筆假職缺；從公網位址連線失敗；`ss -ltnp` 沒有對外的埠；`docker history` 與 `docker run --rm <映像> env` 不含任何憑證名稱以外的值；mutation：把 `web` 的埠綁定改成 `0.0.0.0`，`deploy/check-compose.mjs` 要失敗。
  - 停止條件：arm64 上映像建不起來或跑不起來。
  - 需要人做的事：授權部署到 VM（部署點）；VM 上放 env 檔；Tailscale Serve 的設定要 root。
- [x] **3. 新形狀：資料模型、收案核心、評估、頁面**（被擋於：步驟 1 第 1、3 項、步驟 2）
  - 子步驟（2026-11-15 拆分，一個 session 做不完）：3a 資料模型與收案核心、3b 評估與排序、3c 頁面與寫入路由、3d VM 驗收（部署點）；各自的範圍與驗收、表的設計、決定題 Q1／Q2 在 `step-3-design.md`（新增，本步驟的附件）。下面的範圍與驗收是四個子步驟的合計。
  - 範圍：開工時先跑 design-review，材料是 schema 草稿與 `inventory.md`，要它特別檢查兩個設計選擇：整張 `source_receipts` 不留（改用唯一鍵 upsert 加內容比對）、評估結果存成 `listings` 的欄位而不是另一張投影表。
    - `web/src/db/pg/schema.ts`（修改）與新 migration：`listings`、`listing_versions`、`listing_feedback`、`listing_feedback_events`、`settings`、`mail_messages`、`mail_cursors`、`runs`、`run_sources`。
    - `web/src/modules/listings/`（新增）：收案核心（一個交易內 upsert 職缺、寫版本）、id 函式。
    - `web/src/modules/evaluation/`（新增）：資格判定與排序，原生型別，規則照 `discovery/domain.ts`、`ranking.ts`、`rules.ts`，但沒有群組外殼、去重 key、新穎度、`portfolio_ids`。
    - `web/src/app/` 四個頁面與兩個寫入路由（修改）：改讀寫新表，頁面直接讀職缺列；`web/src/app/skeleton/`、`seed-skeleton.ts`（刪除）。`web/tests/web-pages.test.tsx`、`web/tests/web-guard.test.ts`（修改：改成對新表與 PGlite；原有的每個案例都要有對應）。`web/src/modules/listings/id.fixtures.json`（新增：合成的 `(source, external_id)` 與預期 `id`，含非 ASCII、引號、反斜線，預期值由現行 `opportunityId` 產生）。`/sources` 頁到步驟 6 才改，這之前它在 VM 上回錯是預期的。
  - 消費端：`rg -n "opportunities|discoveryItems|opportunityTracking|discoverySettings|asGroup|groupItems|novelty|portfolioIds" web/src -g '!*.test.*'`。
  - 不能動：畫面上看得到的行為（四種檢視、排序、收藏／略過、設定儲存後重排）；未知保持未知；寫入守門。
  - 驗收：`pnpm check` 綠；資格與排序用現有 golden 的對應案例轉成原生 fixture 後全過（這一步只搬這兩個模組的案例；預期輸出拿掉群組與 `portfolio_ids` 後其餘欄位不變）；VM 上灌 3,500 筆合成職缺，清單頁伺服器端 20 次取中位數 ≤ 500 ms；VM 上經 Tailscale Serve 實際送一次回饋與一次設定儲存都成功（守門在 Serve 後面成立）；`id.fixtures.json` 全過；mutation：`id` 函式的分隔字元改掉要有測試失敗、拿掉 `(source, external_id)` 唯一鍵要有測試失敗、把過期 revision 的檢查拿掉要有測試失敗、把同站來源檢查拿掉要有測試失敗。
  - 停止條件：步驟 1 量到守門需要的 header 在 Serve 後面拿不到，先回報做法再動。
  - 需要人做的事：授權部署到 VM（部署點）。
- [x] **4. 第一個來源：jobicy 與 remotive，定下每個來源的做法**（被擋於：步驟 3）
  - 子步驟（2026-11-15 拆分：VM 上的執行要另取授權）：4a 程式、fixture、`connector-checklist.md`（本步驟附件）與 `run-source.ts`，驗收是下面除了 VM 那兩項以外的全部；4b VM 驗收（部署點）：部署含 4a 的版本、兩個來源各跑一次、`seen`／`jobs` 與 id 比對。正式庫的基準（2026-11-15 唯讀查詢）：jobicy `seen` 100、`jobs` 1–6，remotive `seen` 13–16、`jobs` 2（11-12 至 11-15）；`jobs` 這麼小，5% 等於要求完全相同，差異逐筆說明。
  - 範圍：`web/src/platform/fetch/`（新增）：分層讀取介面與第 1 層（一般請求、逾時、大小上限、每來源間隔與每日上限）；`web/src/modules/sources/free-jobs/`（新增）：原生 connector 與 `fixtures/`（輸入取自 golden 裡這兩個來源的案例，預期輸出是新形狀）；`connector-checklist.md`（新增附件）給步驟 5、7、8 照做；`web/scripts/run-source.ts`（新增）：在 VM 上對一個來源跑一次並印出計數與 `external_id` 清單的比對結果。`web/tests/structure.test.ts`（修改）：`src/modules/sources/` 底下每個來源目錄各要有測試檔。
  - 消費端：`rg -n "syncFreeJobs|free-jobs" web/src web/tests`。
  - 不能動：這兩個來源既有列的 `external_id`；既有的篩選規則（只收合約類、資格初篩）。
  - 驗收：`pnpm check` 綠；VM 上各跑一次，新系統記下的 `seen` 與 `jobs` 分別和同一天正式庫該來源的 `seen`、`jobs` 相差在 5% 內（正式庫數字用 `cf d1 query` 唯讀查 `daily_runs.result`，由執行的 agent 取得）；**id 比對**：該來源當次在新庫的 `external_id` 集合，對正式庫同來源的 `external_id` 集合，列出「新庫有、正式庫沒有」的筆數，每一筆都要能說明是新職缺（發布時間晚於正式庫最後一次執行）而不是同一筆職缺換了寫法；mutation：解析出的 `external_id` 改一個字元要有測試失敗；把合約類篩選拿掉要有測試失敗。
  - 需要人做的事：授權在 VM 上執行（部署點）。
- [ ] **5. 其餘 17 個公開來源**（被擋於：步驟 4）
  - 拆成子步驟，各一個 PR、各自跑完驗收才算完成（2026-11-15，一個 session 做不完）：**5a** API 類、**5a2** 收案存全部（D9）、**5b** feed 類、**5c** 頁面類；5b、5c 被擋於 5a2（共用的 `shared/` 解析、catalog 與 connector 輸出形狀由 5a、5a2 定下）。
  - **5a2 收案存全部（D9）**（被擋於：5a 程式完成）：
    - 拆成三個子步驟，各一個 PR、各自跑完驗收（2026-11-15，一個 session 做不完；兩天量測要等 connector 改成「標記」之後才量得到「全部讀到的」，現行 connector 在內部就篩掉了）：
      - **5a2-1 D10 清理**（被擋於：無）：代理主鍵加 `(source, external_id)` 唯一鍵與外鍵；刪舊 `id` 算法、`id.fixtures.json`、cryptojobslist／v2ex 相容 id 函式、`legacyToInput` 與依賴它的產生器；改 `AGENTS.md`、checklist §3、步驟 10、11 文字。驗收：`pnpm check`、`pnpm build` 綠；mutation：拿掉唯一鍵要有測試失敗。
      - **5a2-2 D9 收案存全部**（被擋於：5a2-1）：規則欄、`last_seen_at`、`gone_at`、`intakeListings` 寫全部、刪 `refreshOnly` 與 `others`、10 個 connector 改標記、catalog 完整讀取旗標、清單查詢條件、checklist §2。驗收：下面列的前三個 mutation 與 VM 連跑兩次的 `last_seen_at`／`updated_at` 檢查。
        - 部署注意（5a2-1 審查記下）：5a2-1 把 `web/drizzle-pg/` 重產成單一起始 migration，VM 現有新庫（10 個來源的影子資料）無法往前套；5a2-2 第一次部署前要 `compose down -v` 清掉 `db` volume，清空前另取得 Will 確認（刪資料，不含在部署授權內）。
        - 狀態（2026-11-15）：完成。VM 驗收（Will 2026-11-15 授權清庫與部署 `5510db7`）：清空 `db` volume、套 migration 後，taiwanjobs 連跑三次、arbeitnow 連跑兩次；taiwanjobs 998 列最後一次全部 `last_seen_at` 前進、998 列 `updated_at` 等於 `first_seen_at`；arbeitnow 4,173 列全部 `last_seen_at` 等於第二次、4,083 列 `updated_at` 沒動、90 列內容變了（來源每小時更新）、21 列第二次才新出現；`gone_at` 0（arbeitnow 讀到 20 頁上限，截斷不算完整）。做法：connector 回傳全部並帶必填的 `sourceKept`；`listings.source_kept`、`last_seen_at`、`gone_at`；catalog `completeRead` 只有 arbeitnow（getonboard 讀 remote 搜尋，不算）；有擱置（`rejected > 0`）或截斷的讀取不算完整；清單查詢 `shownWhere` 加部分索引 `listings_shown`；`SourceRun` 加 `stored`、`jobIds`（`jobs` 維持舊意義，`run-source.ts --expect` 比對 `jobIds`）。
        - 記下、交給 5a2-3（審查發現）：(1) arbeitnow 讀取中來源刪掉一筆會讓後面一筆被擠到已讀過的頁而漏讀，被誤標 `gone_at`，下次讀到就清掉；保留期限要以「連續消失 N 天」計，不能看一次。(2) 依日期的來源規則（90 天內）只在再讀到時重算，沒再讀到的列 `source_kept` 停在最後一次的值（同舊系統：存下就一直顯示）；5a2-3 定保留期限時一併處理。(3) `listings_shown` 在 `shownWhere` 的 OR 之下可能用不到，5a2-3 在 VM 實量後決定保留、改寫或刪除；版本查詢也還讀全部版本。(5) arbeitnow 是唯一的完整讀取來源，但實際每次都讀到 20 頁上限而截斷，所以目前沒有任何來源會寫 `gone_at`；5a2-3 定保留期限時要先決定：提高 arbeitnow 頁數上限、改用 `last_seen_at` 計算保留，或兩者都做。(4) migration `0001_store_all_listings` 的 `source_kept NOT NULL` 沒有預設值，非空表會失敗：照部署注意先清庫。
        - 同分排序（Will 2026-11-15 決定）：清單同分時新的在前，依 `first_seen_at` 由新到舊，再依代理鍵由大到小（`modules/evaluation/rank.ts` 的 `byRank`）。
      - **5a2-3 量測與保留期限**（被擋於：5a2-2 部署到 VM）：兩天量測（Will 2026-11-15 已授權部署與兩天量測）、定 N、保留期限刪除操作、3,500 列清單頁 ≤ 250 ms。驗收：下面列的保留期限 mutation 與延遲實量。
        - 狀態（2026-11-15）：程式完成、量測第 1 天完成，待第 2 天。做法：`modules/listings/retention.ts` `pruneListings`，刪 `last_seen_at` 早於 N 天且沒有任何 `listing_feedback` 列（含 neutral）的列，版本與回饋事件隨外鍵刪除；可重跑、中斷後重跑無害；以 `last_seen_at` 計（回答 5a2-2 記下的 (1)(5)：不靠 `gone_at`、不提高 arbeitnow 頁數上限，連續 N 天沒讀到才刪；(2) 沒再讀到的列 `source_kept` 最多停留 N 天）。`RETENTION_DAYS` 暫定 30，第 2 天量完依成長確認。測試 5 個（併發 1 個在 `tests/pg-retention.test.ts`）；mutation 4 個全擋（改用 `updated_at`、拿掉回饋條件、邊界差一毫秒、拿掉 `skip locked`）；`pnpm check` 綠。
        - 第 1 天（2026-11-15 台灣 18:40，VM 跑 `5510db7`，10 個來源各一次）：列數／`raw` 平均位元組：arbeitnow 4,191／3,707、freelancer 1,336／1,994、taiwanjobs 999／1,321、getonboard 186／2,580、jobicy 100／4,224、cryptojobslist 100／3,149、himalayas 50／2,783、hackernews 19／1,580、remotive 16／2,784、v2ex 13／1,036；合計 7,010 列、`raw` 21.0 MB、`listings` 含索引 50 MB、整庫 59 MB；清單顯示 300 列。清單頁伺服器端（VM 上 curl 127.0.0.1，20 次）中位數：candidates 45 ms、all 45 ms、saved 14 ms；最大 333 ms（第一次冷啟動）。`EXPLAIN ANALYZE` 清單條件：`listings` 循序掃描 7,010 列 5.6 ms，OR 寫法下 `listings_shown` 沒用到（5a2-2 記下的 (3) 實證；改 UNION 後用上，見下一條）。
        - 上限量測（2026-11-15 台灣 19:00，不等第 2 天）：用最壞假設「每天全部換新」，把第 1 天 7,010 列複製 29 份、`last_seen_at` 分散在 1–29 天前，共 210,300 列（顯示 9,000 列），量完刪除、`vacuum analyze`。OR 寫法：清單頁中位數 candidates 176 ms、all 171 ms、saved 132 ms，達標但其中查詢 106 ms 是全表掃描；改成 UNION 取 id（`shownWhere`）後 `listings_shown` 用上 index-only scan，整句查詢 38 ms。決定：`listings_shown` 保留，`shownWhere` 改 UNION（5a2-2 記下的 (3) 結案）。部署 `866d397` 後（Will 2026-11-15 授權）同樣 210,300 列重量，21 次中位數：candidates 112 ms、all 107 ms、saved 70 ms（OR 寫法 176／171／132），合成列已刪回 7,010 列。
        - `/code-review`（medium）發現 8（blocking 0）：改 2（刪除與 `setFeedback` 競態：候選列先 `for update skip locked`，併發測試 `tests/pg-retention.test.ts` 只在 CI 的真 Postgres 跑（PGlite 單連線）；mutation 拿掉 `skip locked` 在 CI 失敗（PR #35，已關）；相關子查詢改用 `eq`）、記 4、駁回 2。記下：(a) 來源壞掉或停用超過 N 天，它的列會全被刪、恢復後當新列回來並排到前面：步驟 6 有 `run_sources` 後，只刪「該來源 N 天內有成功讀取」的列；(b) 信件來源不會再讀到，套 `last_seen_at` 等於收信後 N 天刪：步驟 7 接信件來源時另定；(c) UNION 寫法只有 VM 實量為證、沒有測試守：步驟 6 的延遲監看一併守；(d) `readRankables` 仍讀全部 `listing_versions`：目前新系統沒有信件版本，步驟 7 一併改成只讀顯示中的 id。駁回：`pruneListings` 沒有呼叫端是計畫的安排（本步範圍「由步驟 6 的每日執行呼叫」）；`last_seen_at` 沒索引：21 萬列全表掃描實量 80 ms，一天一次，不值得每次寫入多維護一個索引。
        - CI（2026-11-15）：真 Postgres 那段原本只重跑 `tests/pg-*`（只有 `pg-base`），其餘 17 個用 `freshPg` 的測試檔只在 PGlite 跑過；改成整套重跑（`.github/workflows/ci.yml`，靠 `fileParallelism: false` 避免清庫互撞），CI 真 Postgres 段 644 過、6 略過。
        - diff 審查第 1 輪發現 2（blocking 0，皆 nit）：改 2（測試註解、測試數）；另提醒改寫後頁面延遲未量，已在部署後量完。
        - 第 2 天（待辦，2026-11-16 台灣 14:30 後）：10 個來源各跑一次，量不重複 `external_id` 的新增數，換算 N 天上限並確認 `RETENTION_DAYS`；若 N 改變，在新上限列數下重量清單頁；N 若改變另開小 PR。程式已先合進 `dev`（PR #34，Will 2026-11-15 要求先合，讓步驟 6、9 可以開工）；VM 現跑 `866d397`。
    - 範圍（D10 追加）：主鍵改成代理主鍵（資料庫產生）加 `(source, external_id)` 唯一鍵，`listing_feedback`、`listing_versions` 的外鍵跟著改；刪舊 `id` 算法與 `id.fixtures.json`、cryptojobslist／v2ex 的相容 id 函式（改用標準 `URL`）、`legacyToInput` 與依賴它的 fixture 產生器（`cases.json` 已產生、保留）；改 `AGENTS.md` 的「stored hashes 維持 v1」「golden 凍結」「切換前不能動歷史表」等條目與 checklist §3；步驟 10、11 的文字照 D10 改寫。
    - 範圍：先在 VM 對 5a 的 8 個來源與 jobicy、remotive 連兩天各跑一次，量不重複 `external_id` 的成長與每列 `raw` 的大小（只輸出計數與位元組數），依此定保留期限 N 與清單查詢要不要先用 SQL 篩。之後：`web/src/db/pg/schema.ts` 的 `listings`（與 `listing_versions` 對應的欄）加來源規則的三態欄、`last_seen_at`、`gone_at`，重產 `web/drizzle-pg/`；`intakeListings` 寫全部、每次讀到都寫 `last_seen_at`、刪 `refreshOnly`；`collectSource` 不再篩，刪 `others` 處理；10 個來源（free-jobs 與 5a 的 8 個）的 connector 由「篩掉」改成「標記」；catalog 加「完整讀取」旗標；`modules/evaluation/list.ts` 的查詢加來源規則與硬性排除的條件；保留期限的刪除寫成可重跑的操作，由步驟 6 的每日執行呼叫；checklist §2 改寫。
    - 消費端：`rg -n "others|refreshOnly|storedExternalIds|screen\(" web/src web/scripts`；`rg -n "listings\b" web/src/modules/evaluation web/src/app`。
    - 不能動：各來源的單筆拒收規則；同一筆職缺每次讀取的 `external_id` 要相同；信件來源的 `listing_versions` 語意（核心選擇 4）。
    - 驗收：`pnpm check`、`pnpm build` 綠；VM 上 3,500 列以上的實量（以量測的兩天資料加合成列補到預估的保留期上限）清單頁中位數 ≤ 250 ms；mutation：來源規則欄不參與查詢條件、`last_seen_at` 只在內容變時寫、不完整讀取也寫 `gone_at`、保留期限刪掉有回饋的列，各要有測試失敗；VM 上同一來源連跑兩次，第二次 `last_seen_at` 前進、內容不變的列 `updated_at` 不變。
    - 需要人做的事：VM 上兩天量測與部署的授權。
  - 範圍：照清單逐個改寫到 `web/src/modules/sources/<來源>/`（新增），分三批各一個 PR：API 類（himalayas、getonboard、cryptojobslist、hackernews、v2ex、freelancer、arbeitnow、taiwanjobs）、feed 類（remoteok、realworkfromanywhere、weworkremotely、workingnomads）、頁面類（nodesk、justremote、dynamitejobs、jobbank518、chickpt）。步驟 1 第 3 項量到不一致的來源，在這裡加它的相容 id 函式與測試。Arbeitnow 先在 VM 上跑一次看錯誤種類再改。
  - 消費端：每個來源 `rg -n "<舊模組名>" web/src web/tests`。
  - 不能動：各來源既有的拒收規則（壞網址、缺欄位、超長正文）與讀取範圍；不為了轉綠放寬。
  - 驗收：每批 `pnpm check` 綠；每個來源符合全域的完成定義；每批在 VM 上對真實來源連跑兩次，第二次同一 `(source, external_id)` 不新增列（D24；切換前正式庫還在時，`seen`、`jobs` 與同日正式值並列當參考，不當門檻）；mutation：每批挑一個來源，把一條拒收規則拿掉要有測試失敗；每個有相容 id 函式的來源，把相容函式換成標準 `URL` 寫法要有測試失敗。
  - 停止條件：某來源的真實回應和 fixture 的形狀不同到解析不出任何一筆，那個來源單獨回報，不擋同批其他來源。
  - 需要人做的事：授權在 VM 上執行（部署點，每批一次）。
- [ ] **6. 每日執行：指令、排程、重試、來源狀態頁**（被擋於：步驟 4）
  - 範圍：`web/scripts/daily.ts`（新增）：claim 當天、逐來源執行、結果寫 `run_sources`、收尾；只重試暫時性錯誤（連線失敗、逾時、HTTP 429 與 5xx），最多 2 次，間隔 30 秒與 120 秒；重跑同一天會跳過已完成的來源。`deploy/compose.yaml`（修改）：步驟 2 已有只在被呼叫時執行的 `daily` 服務（profile `jobs`，同一個映像，目前用來跑 migration 與一次性指令），這一步把它的預設指令改成 `scripts/daily.ts`。`deploy/systemd/freelance-daily.{service,timer}`（新增）：`docker compose run --rm daily`，`Persistent=true`。**影子期間 timer 設在台灣 14:00**，避開正式站 09:00 與 12:00 的兩支 cron，同一個來源一天不被兩個系統同時讀；步驟 10 切換時改成 09:00。`web/src/app/sources/`（修改）：讀 `runs` 與 `run_sources`。`web/tests/daily.test.ts`、`web/tests/write-units.test.ts`（修改：改成對新的每日執行；原有的案例各有對應或寫明為何不再適用）。
  - 消費端：`rg -n "beginDailyRun|finishDaily|syncDailySource|dailyWorkflow" web/src web/tests`。
  - 不能動：一天最多一次；一個來源失敗不影響其他來源。
  - 驗收：`pnpm check` 綠；測試：同一天第二次執行不重跑已完成來源、殺掉執行後重跑會做完剩下的、暫時性錯誤重試後成功、非暫時性錯誤不重試；VM 上連 3 天自然觸發都有一列 `runs`，每次總時間 ≤ 15 分鐘，`docker stats` 常駐容器合計 ≤ 2 GB（此時只含已改寫的來源；步驟 10 隔天再量一次全部來源）；mutation：把「跳過已完成來源」拿掉要有測試失敗。
  - 需要人做的事：授權在 VM 安裝 timer（部署點，root）。
  - 完成後的狀態：VM 每天 14:00 自己收案到新庫（影子，不是正式），此時只含已改寫的公開來源。
  - **6b 執行過期提示**（2026-11-15 追加，被擋於：無；切換前做完）：清單頁與 `/sources` 在最後一次成功的每日執行超過 26 小時時顯示一行提示。業界基準是 dead-man switch（排程沒按時回報就告警）；D22 不寄信，所以只在頁面提示，不接外部服務。驗收：測試涵蓋 25 小時不顯示、27 小時顯示、從未執行顯示；mutation：門檻比較反向要有測試失敗。
  - 實作（分支 `step-6`）：`web/scripts/daily.ts`（session advisory lock，第二個行程回 `busy`，行程被殺時鎖隨連線釋放）、`web/src/services/run-daily.ts`、`web/src/modules/runs/`（新增模組）；`runs.counts`（migration `0002_run_counts`）記 `pruned` 與 `listMs`。systemd 檔名改用 repo 新名 `deploy/systemd/side-income-daily.{service,timer}`；timer 14:00 加 16:00（當天失敗或被殺時接續，成功的那天直接結束）；`EARLIEST_HOUR = 14`：`Persistent` 開機補跑落在 14:00 前就回 `not_due`，不撞正式站 09:00、12:00（步驟 10 改成 9，timer 改 09:00／11:00）。前幾天還是 `running` 的執行在新的一天開始時標成 `failed`／`interrupted`。`run_sources.error` 只存代碼（`http_<status>` 或錯誤類別名），不存訊息：訊息可能引用頁面內容或失敗查詢的職缺參數。保留期限：只刪 30 天內有 `ok` 列的來源（5a2-3 記下的 (a)），同一個 `RETENTION_DAYS` 用在兩邊。清單頁延遲：每次執行後量一次 `listJobs`，`/sources` 超過 250 ms 標示（5a2-3 的 (c)）。
  - 舊測試的對應：`web/tests/daily.test.ts`、`web/tests/write-units.test.ts` 測的是舊的 D1／Vercel Workflow 程式（`web/src/services/daily.ts`、`web/src/workflows/`），照全域約束「舊測試只在取代它的新測試進來的同一個 PR 裡刪」，留到步驟 11 跟舊程式一起刪，本步不改。新系統的對應（`web/src/services/run-daily.test.ts`、`web/src/modules/runs/runs.test.ts`）：兩支 cron 都觸發只跑一次 → 「succeeded 的那天不再跑」；09:00 前不跑 → 「14:00 前回 `not_due`、不寫入」；來源拋錯記失敗、當天失敗 → 「失敗來源不擋其他來源、當天 `failed`」；逐一執行、失敗後繼續 → 同一案；只跑已實作且啟用的來源、照目錄順序 → 「照 `order`、跳過 `disabled`」；partial 算當天失敗 → **不再適用**：截斷與拒收記在 `counts`（`truncated`、`rejected`），來源仍是 `ok`，否則 arbeitnow 每天截斷會讓每天都失敗；`source_details` 的形狀、Python 的 reason 與 D18 量測、D1 用量 → 不再適用（舊結果格式與 D1 專屬量測，新系統用 `run_sources` 欄位）；claim 的日期 → 「依台灣日期」。`write-units.test.ts` 的 lease、批次寫入、過期 token 是 D1 寫入單位的機制（`web/src/db/unit.ts`），新系統在 Postgres 用交易，回饋與設定的過期檢查由 `web/tests/web-pages.test.tsx`、`web/tests/web-guard.test.ts` 守（步驟 3），每日執行不涉及。
- [ ] **7. 六個信件來源與被拒信的處置**（被擋於：步驟 4、步驟 6 的程式）
  - 拆分（D24，2026-11-15）：**7a** 信件共用部分（`mail_messages`、原因代碼、Resend 讀取）加 jobbank104，在切換前做完，是步驟 10 的門檻；**7b** 其餘五個（tasker、cake、talent、glassdoor、linkedin）與「重排」「消掉」兩個路由，切換後做。驗收照下面，各自只算自己的來源。
  - 範圍：`web/src/modules/sources/mail/`（新增）：tasker、cake、jobbank104、talent、glassdoor、linkedin 改原生；`mail_messages` 記原因代碼（每個 parser 的每個檢查一個代碼）；信件來源的例外也記錯誤種類。`web/src/app/sources/` 加兩個寫入路由「重排」與「消掉」（新增），都經 `guardedForm`。LinkedIn 那種被拒的通知補 parser。
  - 消費端：`rg -n "syncMail|readNotification|mailRecords|recordMail" web/src web/tests`。
  - 不能動：只送 GET、只打 Resend Receiving 的網址；一封信只處理一次；單封失敗不撤銷其他信。
  - 驗收：`pnpm check` 綠；現有 66 個信件情境的輸入搬成各來源 fixture，預期輸出是新形狀；重排後下一次執行重讀、消掉後不再計入；VM 上連跑兩次，第二次不新增列（D24；切換前各信件來源的 `messages` 與正式庫同日的值並列當參考），並做步驟 4 的 id 比對；`web/tests/mail-sources.test.ts`（修改）的 66 個情境各有對應；mutation：收件信箱檢查拿掉要有測試失敗、兩個新路由拿掉 `guardedForm` 要有測試失敗。
  - 停止條件：拿不到被拒的 LinkedIn 通知的結構，LinkedIn 那一項單獨留在進行中，不擋其他五個。
  - 需要人做的事：把 `RESEND_API_KEY`、`RESEND_INBOX` 放進 VM 的 env 檔（Will 提供值的來源，agent 不印值）；授權部署（部署點）；LinkedIn 被拒通知的結構（VM 上有 key 之後用診斷腳本只輸出結構，不輸出內容）。
  - 實作 7a（分支 `step-7a`）：`web/src/modules/sources/mail/`（新增）：`receiving.ts`（經來源的 `Fetcher`，只送 GET；網址白名單；只讀剛列出、寄件人相符的信）、`message.ts`（各信件來源共用的信封檢查）、`reasons.ts`（原因代碼，信封 7 個加 104 的 9 個）、`store.ts`（`mail_messages`、`mail_cursors`）、`jobbank104/`（cheerio 的 htmlparser2 模式，巢狀連結看得到；fixture 40 例取自 golden，37 例與舊結果相同，3 例差異逐案寫在 `fixtures/generate.ts`）。`web/src/services/collect-mail.ts`（新增）：`collectSource` 遇到 `kind: "mail"` 的來源轉到這裡；每封信各自一個交易寫入（mode `mail`），寫完才記 `mail_messages`；讀取失敗（含 Resend 429）帶著已存的位置往外丟，由每日執行記錄種類並重試（盤點缺陷 5）；這次讀的信超過一半被拒就整個來源失敗（和單筆擱置同一條規則）。舊的 `waiting` 狀態不搬：沒收到信就是 `messages` 0。`SourceSettings` 改成 `PageSourceSettings | MailSourceSettings`。`deploy/compose.yaml`（修改）：`RESEND_API_KEY`、`RESEND_INBOX` 只傳給 `daily`，缺的時候來源記 `MailConfigError`。前提核對：Resend 的 list／retrieve 回應沒有已讀或處理狀態，讀取不改變信件（官方 API 文件 2026-11-15，推論，未實測）。被拒信的「重排」（`disposition = retry`）與「消掉」在 7b。
- [ ] **8. 分層讀取的上層與新平台**（被擋於：步驟 6；瀏覽器層的平台另等 D3 剩下的點選）
  - 範圍：`web/src/platform/fetch/`（修改）：依 D4 選的工具實作第 2、3 層；瀏覽器層放在另一個只在需要時啟動的映像或服務（`deploy/compose.yaml` 修改）；來源設定加「最高層級」；`web/src/modules/sources/ptt/`（新增）接回兩個看板，id 格式照步驟 1 第 3 項反推的結果；D3 點選的平台逐個加 connector。
  - 消費端：`rg -n "maxTier|fetchTier" web/src`（新介面）。
  - 不能動：不登入；每個來源的間隔與每日上限；升層不提高頻率。
  - 驗收：`pnpm check` 綠；每個新來源在 VM 上連 3 天執行有結果；`run_sources` 記下實際用到的層級；瀏覽器層執行時的記憶體峰值記錄；mutation：把某來源的最高層級設成 1，被擋時要記為失敗而不是往上升。
  - 停止條件：某平台在 D4 選的工具下過不去，列入延後，不加代理。
  - 需要人做的事：授權部署（部署點）。
  - 完成後的狀態：這一步不擋切換；可以排在步驟 10 之前或之後，但要在步驟 12 之前完成。
- [x] **9. 營運：部署流程與文件**（被擋於：步驟 2）
  - 範圍：`deploy/deploy.sh`（新增）：checkout 指定 commit、建映像並打上 commit 的 tag、跑 `migrate-pg`、`up -d`、健康檢查；健康檢查失敗就把 `APP_IMAGE` 改回前一個 tag 並重啟（`web` 與 `daily` 一起回去）。`deploy/compose.yaml`（修改：映像一律用 `${APP_IMAGE}`）。migration 規則（從步驟 10 切換完成起適用，見全域約束）：每個 migration 都要讓前一版映像能在新結構上繼續跑（先加後刪，刪除放到下一次部署）。`docs/operations.md`（修改）：新增 VM 版的章節，寫明沒有備份（D1）以及資料遺失時哪些會由每日執行重新收到、哪些不會；Vercel 版的章節留到步驟 10 退役後才刪。`README.md`、`docs/design.md`（修改）跟上。
  - 消費端：文件連結 `rg -n "operations.md" .`。
  - 驗收：在 VM 上對一個故意讓健康檢查失敗的 commit 跑 `deploy.sh`，服務回到前一個 tag（貼出前後的映像 tag 與健康檢查結果）；對一個故意失敗的 migration，新版不啟動、舊版繼續服務（同樣實際做一次）。
  - 需要人做的事：授權部署（部署點，兩次演練）。
- [ ] **10. 正式切換與舊資源退役（deploy，必須連著做）**（被擋於：步驟 3、5a、5a2、5b、6（含三天驗收）、7a、9；Will 明確授權；D24 目標 2026-11-30 前；5c、7b、8 切換後做）
  - 範圍（步驟 5a2 依 D10 改寫）：不搬資料、不匯出、不封存。新庫從空庫開始，由 VM 的每日執行收案；D1 的職缺、回饋、信件紀錄、執行歷史與歷史表全部隨 D1 刪除。
  - 切換當天的順序（避開台灣 09:00–13:00）：
    1. Will 在 Vercel 後台停用 Cron Jobs。確認沒有執行中的 run：正式庫最新一列 `daily_runs` 不是 `running`，或它的 `started_at` 早於 1 小時前（中斷的 run 會永遠停在 `running`）。
    2. 停 VM 的 timer；清空新庫（影子資料）；把 `web/drizzle-pg/` 壓成的起始 migration 套上（全域約束）。
    3. timer 改成台灣 09:00 並啟用；當天手動觸發一次每日執行（新庫是空的，不等隔天）。
    4. 隔天自然執行驗收通過後，同一天退役（不可逆，執行當下再取得 Will 確認，D10）：刪 Vercel 專案、`freelance-agent-prod`、`freelance-agent-ci-test`、`freelance-agent-spike-1f`、GitHub 的三個 D1 secrets；刪 repo 外 spike 的原始輸出與步驟 1 第 3、4 項的匯出檔（位置見本機個人脈絡檔）。
  - 回滾：只在第 4 小步之前存在：停 VM 的 timer、Will 在後台重新啟用 Vercel Cron；D1 在切換時沒有被改動。第 4 小步之後沒有回滾路徑，也沒有備份（D1、D5、D10）。
  - 驗收：第 3 小步的手動執行與隔天的自然執行各有一列 `runs`、至少 18 個來源成功、總時間 ≤ 15 分鐘、常駐容器 ≤ 2 GB；兩次執行之間同一來源的 `(source, external_id)` 重複讀到時沒有新增列（id 穩定的關卡，各來源在步驟 4、5、7 的 fixture 已各過一次）；清單頁四種檢視都有資料；Will 在 tailnet 內確認看得到資料並按一次回饋。
  - 停止條件：手動執行或隔天沒有完成收案，或同一職缺第二次讀到時多出一列 → 照回滾處理，不做第 4 小步。
  - 需要人做的事：授權切換；在 Vercel 後台停用 Cron；驗收通過後確認退役（不可逆）；切換若晚於 2026-11-30，先照前提換 D1 token。
- [ ] **11. 刪掉舊機制**（被擋於：無（D23 提前到切換前）；步驟 8 不擋它）
  - D23 追加：`app/_lib/usage.ts` 的 `withPageLog` 是新頁面唯一還接舊碼的地方，改寫成只用新系統的紀錄；查正式 D1 用 `cf d1 query`，不靠 repo 裡的 D1 程式。AGENTS.md 中「切換前不能動歷史表」「舊 v1 hash 與 golden 凍結到步驟 11」等條目同一個 PR 改寫。
  - 範圍：`inventory.md` 標「刪除」與「取代」的每一列對應的檔案（刪除），包含 `web/src/platform/py/`、`web/tests/fixtures/golden.json`、`web/tests/helpers/golden.ts`、`web/src/db/{client,schema,usage,migrate,unit}.ts`、`web/src/db/d1/`、`web/drizzle/`、`web/drizzle.config.ts`、`web/src/workflows/`、`web/src/ops/`、`web/src/app/api/cron/`、`web/src/app/_lib/usage.ts`、`web/scripts/{migrate,rebuild-projection,check-storage-triggers}.ts`、`web/src/modules/{legacy,applications,notifications,discovery,collection,preferences}/`、`web/src/services/`（舊的）、`web/tests/d1-*.test.ts`、`test:d1` script、`web/vercel.json`、`next.config.ts` 的 `withWorkflow`（修改）、`workflow` 與 `@vercel/*` 相依套件（修改 `package.json`）；`docs/operations.md` 的 Vercel 章節（刪除）；`AGENTS.md`（修改：拿掉過渡期文字）。附件新增 `allowed-residue.md` 與 `check_inventory.py` 的複本（複本讀同目錄的殘留清單）、`check-deleted.sh`（新增：從 `inventory.md` 取出標刪除的路徑與表名，任何一個還存在就失敗）。
  - 消費端：`rg -n -l "@/platform/py/|golden|@/db/d1|@/db/client|workflow|vercel|sqliteTable|D1_|oci-a1" . -g '!node_modules'`。
  - 需要人做的事：無。
  - 驗收：`inventory.md` 的路徑先統一成 repo 相對路徑，標「改寫」而舊檔要刪的列補上舊檔路徑；`check-deleted.sh` exit 0（先確認它在刪除前會失敗）；`web/.dependency-cruiser.cjs`（修改）沒有指向已刪目錄的規則；上面的搜尋結果交給 `check_inventory.py --residue`，只剩 `allowed-residue.md` 列的命中；`pnpm check` 綠；映像大小記錄前後。
- [ ] **12. 收尾**（被擋於：步驟 5c、7b、8、10、11）：完成定義逐來源核對（每個來源一列的核對表放附件）；獨立設計審查（design-review，材料是 `0f38208` 到收尾的 diff）；長期檢查在 CI（兩個方言只剩一個的 schema 漂移檢查、id 規則的 fixture、`deploy/check-compose.mjs`）；延後項附觸發條件搬回主清單；需要人做的事列給 Will；D0–D5 寫成 `docs/adr/` 的新 ADR 並把 2026-10-23 的 ADR 標成被取代；`docs/implementation-plan.md` 改寫。驗收：核對表每個來源每項都有證據連結；`check-deleted.sh` 與殘留檢查 exit 0；CI 綠；審查發現都有處置。

## 決定

- **D0 方向**（狀態：已決 2026-11-15，Will；擋住步驟：全部）
  - 結論：資料庫用 Postgres；提案、核准、投案功能不要了；infra 全自建在 Oracle VM；網頁只走 Tailscale；遇到存取驗證不停，只讀不用登入的公開頁面；目標平台是 PTT 加其餘未接平台的評估結果。Will 的原話在 `requirements.md` 開頭。這推翻 2026-10-23 ADR「離開 VM」與舊計畫 D19（D1）、D12（PTT 停用），步驟 12 寫成新的 ADR。
- **D1 備份**（狀態：已決 2026-11-15，Will：「不需要備份」；擋住步驟：無）
  - 結論：不做備份，也不做還原演練。VM 的磁碟損毀或資料庫被誤刪時，職缺會由之後的每日執行重新收到，回饋、設定、信件紀錄與執行歷史不會回來。否決：送到另一台自己的機器、送到物件儲存、只留本機副本。
- **D2 信件來源怎麼收**（狀態：已決 2026-11-15，Will：「信件繼續用 Resend」；擋住步驟：無）
  - 結論：繼續用 Resend Receiving。否決：IMAP 直接讀信箱、VM 自己收信。
- **D3 步驟 8 要接哪些平台**（狀態：已決 2026-11-15，Will 照建議；擋住步驟：無；事實：`spikes.md` 第 2 節）
  - 結論：接一般請求就讀得到的 PTT SOHO、PTT CodeJob、Arc、Web3.career、Wellfound、Remote.com Jobs、YC Jobs，以及模仿瀏覽器連線特徵（第 2 層）讀得到的 Remote.co。不接：Reddit r/forhire（官方政策要求 API 核准）、Upwork（服務條款禁止爬取，推論）。只有瀏覽器讀得到的 Idealist、Braintrust、Glassdoor、打工探吉、Turing：未決，Will 另行點選；其餘平台照 `spikes.md` 是範圍外或都沒過，放「延後」的觸發條件。
- **D4 上層讀取用哪個工具**（狀態：已決 2026-11-15，Will 照建議選 A；擋住步驟：無；事實：`spikes.md` 第 2 節：Crawlee 過的平台比 Scrapling 多一個（Glassdoor），峰值 484 MiB 低於 Scrapling 的 406–734 MiB）
  - A：Crawlee 加 Playwright——單一語言。兩者過關率相近時選它。（預設建議）
  - B：Scrapling 包成 VM 上獨立的小服務（給網址、回內容）——多一個 Python 容器；只在它明顯過得多時選。
  - C：只做到第 2 層——不裝瀏覽器，最省資源；需要瀏覽器的平台放棄。
- **D5 切換後的回滾窗口**（狀態：已決 2026-11-15，Will：「切換後不留」；擋住步驟：無）
  - 結論：不留回滾窗口。步驟 10 隔天的自然執行驗收通過，當天就退役 Vercel 專案與 D1；之後出問題只能往前修。否決：7 天、14 天。

- **D6 一般來源內容回到看過的版本**（狀態：已決 2026-11-15，Will 照建議；擋住步驟：無）
  - 結論：以最後一次為準，蓋回。否決：另存看過的 fingerprint 集合、看過就不蓋（舊收據的隱含行為；來源內容來回晃動沒有證據）。細節 `step-3-design.md`。
- **D7 只有日期的截止日用台北日界線**（狀態：已決 2026-11-15，Will 照建議；擋住步驟：無）
  - 結論：截止日 D 在台灣時間 D+1 00:00 起算過期（舊：UTC D+1 00:00）。evaluate fixture 中受影響的預期重算並逐筆記下。否決：照現行 UTC。
- **D8 connector 與評估之間的輸入契約**（狀態：已決 2026-11-15，Will 照建議；擋住步驟：3c 之後各步；子步驟 3b2）
  - 結論：在邊界解析、之後不猜（parse, don't validate）。connector 產出 zod 的 `ListingInput`（欄位以 schema.org `JobPosting` 用到的為準，三態欄位 `boolean | null`）；時間只收 RFC 3339（日期 `YYYY-MM-DD`、時刻必帶 offset），截止日是「日期／時刻／未知（沒時區或格式無效，附原文）」；轉不了的欄位由 connector 寫成未知，不由評估猜。intake 只收通過契約的資料；評估與排序只讀存下來的型別欄位；fingerprint 算在通過契約的內容上；發布時間的來源特例（用收信時間、無時區當 UTC）搬到 connector。舊系統格式的 job JSON（步驟 10 的正式資料、golden 的案例）經一個轉換函式進契約，這個函式保留舊的寬鬆解析，欄位轉不了就轉成未知，絕不整列拒收（只拒收舊系統本身存不進去的資料：非文字 title、非文字或空的 external_id、來源名稱與所屬來源不符；空字串 title 照收，connector 用的契約則不收；3b2 審查後補註）。否決：維持任意 JSON 加評估時容錯（步驟 4 的 connector 會配合寬鬆形狀，債固定下來）；加 schema 但評估仍讀原始 JSON（兩套真相）。

- **D9 收案存全部、挑選交給查詢**（狀態：已決 2026-11-15，Will 照建議；擋住步驟：5a2、5b、5c、6；推翻 `step-3-design.md` 缺陷 B2 的「接受」與同日「收案層保留 `exists ||`」的補丁）
  - 結論：來源讀到、通過單筆契約的每筆職缺都存；來源自己的規則改成每筆一個 boolean 欄位（D10 後沒有搬來的舊列，不需要未知），與設定無關的硬性排除照舊存成欄位，清單查詢用 `WHERE` 篩（加部分索引）再排序。`Collected.others`、`intakeListings` 的 `refreshOnly` 刪除。另加 `last_seen_at`（每次讀到就寫，不只內容變時）與 `gone_at`（只對 catalog 標為完整讀取的來源，完整、未截斷、未失敗的一次讀取沒再出現時寫）、保留期限（已消失且沒有回饋的職缺 N 天後刪，N 依量測定）。單筆格式不合的照「跳過並計數，超過一半整批失敗」（同日 Will 決定），計數依原因寫進 `run_sources.counts`。不做：被拒原始資料表（觸發：同一拒收原因要反覆看原始資料）、每次原始回應的存檔（觸發：parser 錯誤要重跑而 `listings.raw` 不夠）。
  - 業界基準：資料管線與職缺聚合把「收進來」與「挑出來看」分開，相關性在查詢與排序決定；只有存不下時才在入庫篩。舊行為沿用自舊系統，步驟 3 以 B2 自行接受，沒交 Will。
  - 會推翻它的事實：VM 兩天量測的不重複職缺成長遠超估計（例如超過 50 萬列），且 `WHERE` 加索引壓不下排序成本。切換前可反悔（重產 migration）；切換後要搬資料。

- **D10 舊資料全部不搬、不匯出**（狀態：已決 2026-11-15，Will：「舊資料可以不用保留」，範圍選「全部不搬，也不匯出」；擋住步驟：5a2、10、11；推翻全域約束「職缺 id 不變」、D0 的「歷史表封存一次」、步驟 10 的搬移與封存）
  - 結論：正式 D1 的職缺、回饋、信件紀錄、執行歷史與提案／投案等歷史表都不進新系統，也不匯出封存；新系統從空庫開始收。隨之取消：舊 `id` 算法（sha256）的相容、各來源相容 `external_id` 函式、`golden.json` 凍結 hash 的規則、`legacyToInput`、D9 的「搬來舊列為未知」的三態。5a2 一併重設計主鍵（業界基準：代理主鍵加自然鍵唯一約束），並改 `AGENTS.md` 中依賴舊資料的條目。仍然要做：步驟 10 退役 D1 與 Vercel 時刪除是不可逆的，執行當下再取得 Will 確認。repo 外 spike 的原始輸出與匯出檔不再需要，步驟 10 一併刪。

- **D23 舊程式在切換前就刪**（狀態：已決 2026-11-15，Will 照建議；編號接舊計畫的 D22 之後以免撞號；擋住步驟：無；改寫步驟 11 的「被擋於」與全域約束「過渡期」）
  - 結論：步驟 11 提前，不等切換。新程式不 import 舊模組（實測：`git grep` 在 origin/dev `ac1d233` 的 `modules/{listings,sources,evaluation,review}`、`db/pg`、`services/collect.ts`、`scripts/{daily,run-source}.ts` 查無；唯一連結是頁面共用的 `app/_lib/usage.ts` `withPageLog`，步驟 11 改寫）。凍結的正式部署 `jzp0qoy8t` 是 CLI 上傳的成品，來源 commit `ce1254d`（實測：Vercel API `meta.gitCommitSha`），刪 `dev` 上的原始碼不影響它；改寫時要參考舊程式用 `git show ce1254d:<path>`。廢掉「舊測試只能跟取代它的新測試同 PR 刪」。
  - 業界基準：改寫完成的模組不留舊碼陪跑；舊行為以版本控制的 tag 或 commit 查。否決：照原計畫切換後才刪（約 7,500 行加 33 MB `golden.json` 要繼續編譯與測試到步驟 11，理由是自訂的排程）。
  - 可逆：舊碼在 git 歷史，可隨時 `git show`。
- **D24 11-30 前切換，門檻縮小**（狀態：已決 2026-11-15，Will 照建議；擋住步驟：10；改寫步驟 5、7、10、12 的「被擋於」）
  - 結論：步驟 10 的門檻改成步驟 6 驗收、5b、7a（jobbank104），目標在 D1 token 2026-11-30 到期前切換，不重建 token。5c、7b（其餘五個信件來源）、8 改到切換後；這段期間它們中斷。5b、5c、7 的驗收不再要求和正式庫同日數字比對（切換後正式庫不在），改成 fixture 加 VM 上連跑兩次 `(source, external_id)` 穩定；切換前正式庫還在時可並列當參考。
  - 事實（實測，2026-11-15 唯讀查正式 D1 `daily_runs`，11-09 至 11-15）：新系統還沒有的來源 7 天收進的件數：jobbank104 62、weworkremotely 12（7 天都失敗）、realworkfromanywhere 7、jobbank518 7、linkedin 6（7 天都失敗）、nodesk 5、tasker 3、talent 3、remoteok 2，其餘 0；Will 在正式站的回饋全部 4 筆（3 筆 9-28 略過、1 筆 11-14 改回中立）。`jobs` 是每天讀到並留下的件數，同一筆連續幾天會重複算（推論）。
  - 業界基準：單人工具、不搬資料（D10）、不留回滾（D5）時，新系統夠用就切，壞了往前修；平行運行只用在有使用者或資料要搬的系統。影子期在 D5 之下不提供安全，只提供比對數字。否決：照原計畫全部做完才切（11-30 前要 Will 重建 token）；不含 104 就切（缺最大的台灣來源）。
  - 會推翻它的事實：步驟 6 的三天驗收或 7a 在 11-28 前做不完；那時回到「重建 token、照原門檻」。

拍板順序：D0、D1、D2、D5 已決；D3、D4 已決（2026-11-15）；D3 只剩瀏覽器層的五個平台待 Will 點選。

## 進度

狀態值：未開始／進行中／程式完成待驗收／完成。

| 步驟 | 狀態 | 已跑的驗收 | 未跑的驗收與原因 | commit |
|---|---|---|---|---|
| 1 規則與 spike | 完成 | repo 改名 `side-income`（Will 2026-11-15 選定）；規則條目 diff；spike 1–4 各有指令與結論，第 2 節每個平台一列；VM 暫時資源查無 | spike 3 原始網址那一側（移到步驟 4、5 的驗收） | `832d183`、本 PR |
| 2 Walking skeleton | 完成 | CI 全綠（`web`：`pnpm check` 含 PGlite 測試、真 Postgres 18 重跑、build；`image`：arm64 runner 建映像並以 runtime 使用者離線跑 pnpm）；mutation 4 個都被擋（compose 埠改 `0.0.0.0`、拿掉 seed 的衝突保護、拿掉 `runs.status` 的 CHECK、healthz 失敗回 200）；VM：`docker compose ps` 兩個 healthy、tailnet 內 `/skeleton` 200 含假職缺、`/healthz` 200、公網 3347／10443／443 逾時、`ss -ltnp` 只有 127.0.0.1:3347 與 tailscale0 介面、映像 `env` 與 `docker history` 無憑證；seed 跑兩次仍 1 列。測試 415→420 過（+5，無刪除） | 無 | `aa42857`（PR #15）、本 PR |
| 3 新形狀 | 完成（3a、3b、3b2、3c、3d） | 設計稿 design-review 兩輪：發現 10（blocking 0），改 7、記 1、交 Will 2（D6、D7）。3a：`pnpm check`、`pnpm build` 綠；`id.fixtures.json` 20 例全過；mutation 4 個都被擋（id 分隔字元、拿掉 `(source, external_id)` 唯一鍵、信件第二封改覆寫、截止日改回 UTC）；`/code-review` 發現 10（blocking 0）全改。測試 420→435 過（+16；刪 1：skeleton 的 seed／頁面案例，由 `listings.test.ts`「inserts, then leaves the same content unchanged」取代） 3b：`pnpm check`、`pnpm build` 綠；量測 PGlite 3,500 筆中位數 38.4 ms（≤ 250 ms，只留 TS，寫回設計稿核心選擇 1）；fixture evaluate 480、recommendation 192、fromisoformat 61 全過，並測 evaluate 與事實欄位排序的排除、分數一致；B1 回歸測試；mutation 8 個擋 7 個（版本取最低分、候選不看可能、候選不看略過、截止日改回 UTC、版本不濾排除、完成度寫死 3000、頁碼不檢查；存活 1 個是等價變異：recommend 比封頂後分數，現行類別最高 96.5 分到不了封頂，改測可達最高分）；`/code-review` 發現 10（blocking 0）：改 7、不改 3（重複計算與量測測試放在 `pnpm test` 的效能意見、轉換腳本寫死類別）；diff 審查發現 4（blocking 0）：改 1（time fixture 產生腳本進版控）、記 2（VM 量測併入 3d、CI 門檻 500 ms）、交 Will 1（基本格式日期改當日期）。測試 435→452 過（+17，無刪除）。3b 的 VM 量測（Will 2026-11-15 授權）：真 Postgres 中位數 22.2／22.5 ms。3b2（D8）：`pnpm test`、`pnpm build`、typecheck、boundaries 綠（`db:check` 在 commit 後由 CI 跑）；evaluate 480、recommendation 198、fromisoformat 61 全過且預期全是 golden 原值（12 例刻意改變撤回）；mutation 9 個全擋（契約收無時區時刻、轉換把無效截止日整列拒收、合併兩種未知截止日、fingerprint 計入 extra、fingerprint 計入 null、存檔列丟掉截止日、預算下限無效時保留上限、不檢查來源名稱、台北日界線年 0–99）；`/code-review` 發現 10（blocking 0）：改 9、不改 1（received_at 是職缺自身時間，附證據）；diff 審查第 1 輪發現 4（blocking 1：舊列空 title 整列拒收，已改）：改 2、記 2（年份換算超出 1–9999、微秒變毫秒）；第 2 輪 13 列無回歸，新發現 3（blocking 0）全改。測試 452→464 過（+12；刪 0）。3c：`pnpm check`、`pnpm build` 綠；mutation 7 個全擋（回饋不比 revision、設定不比 revision、第一次儲存改 upsert、拿掉同站來源檢查、不寫回饋事件、hasNext 少算一頁、不標示排序依據的版本）；`/code-review` 發現 9（blocking 0）：改 6（差異欄位為空時說明、寫入改經 services、`getPgDb` 移進錯誤處理、Postgres 頁面加耗時記錄、標示排序依據的版本、清單兩次讀取的不一致記下見下）、記 1（清單排序與當頁內容是兩次讀取，中間被改的那筆當頁可能顯示新回饋配舊排序；下次重新整理就一致，3d 若看到再改成同一快照）、不改 2（格式錯的 token 回 409 照舊系統 `modules/preferences/domain.ts:29`；評估重算 2–3 次，當頁 ≤ 50 筆，3d 量測超標才處理）。測試 464→477 過（+13；刪 1：長地點清單，已無清單型顯示欄位）。3d（Will 2026-11-15 授權）：VM 部署 `7c084b2`，`compose down -v` 重建 db 後 migration 成功，`db`、`web` healthy；灌 3,500 筆合成職缺（3,000 頁面、500 信件，100 筆兩個版本，300 筆回饋）：容器內 `rankedPage` 20 次中位數 21.6 ms（最大 43.3）、`listJobs` 30.1 ms（最大 44.5）；經 Tailscale Serve 打 `/` 20 次，伺服器端記錄中位數 37 ms（最大 140），都在 500 ms 內且低於 250 ms，照核心選擇 1 留 TS；經 Serve 送回饋 303、同 token 再送 409、他站 Origin 403、設定儲存 303 且 revision 0→1。量完刪除合成職缺與設定列（listings 0 列） | 無 | 3a `883a7e6`（PR #18）、3b `3055099`（PR #19）、3b2 `c2ffc21`（PR #20）、3c `7c084b2`（PR #21）、3d 本 PR |
| 4 第一個來源 | 完成（4a、4b） | 4a：`pnpm check` 綠、`pnpm build` 綠；fixture 95 例全過（50 例預期等於舊輸出經 `legacyToInput`；9 例刻意改變逐案列在 `fixtures/generate.ts`：D8 未知 6、JSON 數字 1、Unicode 小寫 1、超過 2^53 的 id 拒收 1）；HTML 與舊 html.parser 98 片段差 15，全是舊版錯，新預期在 `shared/html.test.ts`；mutation 15 個全擋（`external_id` 改一字元、拿掉合約類篩選、拿掉網址來源檢查、無時區不當 UTC、拿掉收案初篩、不等間隔、拿掉每次執行上限、大小上限差一、跟隨轉址、拿掉地區排除、拿掉並行排隊、工作類型讀不到不拒收、拿掉重複 id 去重、落單結束標籤不斷字、sources import `platform/py` 被 boundaries 擋）；`/code-review` 發現 10（blocking 0）：改 9、記 1（空白字元定義與 Python 不同，寫在 checklist）。測試 505→523 過（本步驟 +46，無刪除；舊 free-jobs 測試留到步驟 11）。4b（Will 2026-11-15 授權，台灣 13:01 後）：VM 部署 `44a1a07`，`web` healthy、`/healthz` 200；`run-source.ts` 與正式庫 2026-11-15 同日比對：jobicy `seen` 100／`jobs` 2（正式 100／2），remotive 16／2（正式 16／2），差 0%；id 比對 `newOnly` 兩個來源都是 0 筆（正式庫 id 清單 jobicy 119、remotive 5，`expectedNotKept` 是歷史舊職缺，僅供參考）；原始輸出放 repo 外 | 無 | 4a 本 PR（CI 全綠：web 含真 Postgres、image） |
| 5 其餘公開來源 | 進行中（5a 完成；5a2-1 完成（PR #31，CI 綠含真實 Postgres）；5a2-2 完成（PR #33，`5510db7`；VM 連跑驗收通過，數字見 5a2-2 段；`pnpm check` 639 過、`pnpm build` 綠；mutation 22 個全擋，含計畫列的前三個；`/code-review` 發現 10（blocking 0）：改 5、記 5（寫在 5a2-2 段）；diff 審查第 1 輪發現 2（blocking 0）：改 1（擱置的讀取不算完整）、記 1（migration 要先清庫））；5a2-3 進行中（程式已合進 `dev`（PR #34），只剩第 2 天量測確認 N，見 5a2-3 段）；5b、5c 被擋於 5a2） | 5a2-1：代理主鍵加 `(source, external_id)` 唯一鍵、外鍵改 integer；刪 `listingId`、`id.fixtures.json`、`legacyToInput`、9 個依賴它的產生器（8 個 `fixtures/generate.ts` 與 `step-3b/convert-golden.ts`，紀錄在 `9a68d6b`）、`splitUrl`；cryptojobslist／v2ex 改標準 `URL`，fixture 重設基準 3 例（cryptojobslist 37、38 改接受，v2ex 21 改跳過）；`web/drizzle-pg/` 重產成單一起始 migration；`AGENTS.md`、checklist §3、步驟 10 照 D10 改寫；`pnpm check`、`pnpm build` 綠；測試 638→635（刪 `listingId` 2、`legacyToInput` 整檔，加唯一鍵、URL id 邊界、標籤解析）；mutation 2 個全擋（唯一索引改一般索引、拿掉 int4 上限）；`/code-review` 發現 9（blocking 0）：改 6、記 2（VM 清庫、同分排序，寫在 5a2-2 部署注意）、駁回 1（`listing_feedback_events` 有外鍵，`schema.ts:111`）；diff 審查第 1 輪發現 1（blocking 0，should）：改 1（`convert-golden.ts` 未刪）。 5a：himalayas、getonboard、cryptojobslist、hackernews、v2ex、freelancer、arbeitnow、taiwanjobs 改寫到 `web/src/modules/sources/`，接上 `catalog.ts`（順序沿用舊的每日順序 ×10，remotive／jobicy 一併改成 70／60）；`pnpm check`、`pnpm build` 綠；fixture 全過（每個來源的刻意差異逐案列在各自的 `fixtures/generate.ts`）；8 個來源在 golden 原始輸入上 `external_id` 與舊輸出全等，cryptojobslist、v2ex 各加一個相容 id 函式（標準 `URL` 接受 `:443`、結尾空白，且會把非 ASCII 數字路徑轉成百分比編碼）；RFC 2822 日期搬進 `shared/time.ts`，照 Python `email.utils` 步驟改寫，golden `parsedate` 70 例對照（非 ASCII 數字不讀，已接受）；Will 2026-11-15 決定保留舊的 `exists \|\|`：`Collected.others` 只拿來更新已存在的列；讀到頁數上限未讀完時 `Collected.truncated`（舊的 partial），已讀的照寫；`/code-review` 發現 10（blocking 0）：改 6（getonboard／freelancer 截斷沒有訊號、getonboard 類別檢查順序、RFC 2822 解析器窄於舊的且沒經 `shared/time.ts`、connector 重做 `screen` 的類別分數、catalog 順序與註解不符）、記 4（見未跑欄）；diff 審查第 1 輪發現 4（blocking 2）：改 2（`exists \|\|` 交 Will 後實作、3 個目錄補收案測試）、記 2（freelancer 30 秒與 hackernews 90 秒預算不搬，理由寫在 connector 註解與 checklist §2）；第 2 輪 15 列無回歸，新發現 3（blocking 0）：改 1（RFC 2822 接受負的分秒）、記 1（getonboard 已存在列的類別格式變了照樣整批失敗：connector 不知道是否已存在，checklist §2 的格式變更即來源失敗）、不改 1（切字空白集合與 Python 不同，同步驟 4 已接受的那類）；mutation 40 個全擋（含 `others`、`truncated`、收案層只更新不新增、時區表、負分秒）。測試 523→616 過（+93，無刪除；舊 connector 與測試留到步驟 11）。VM 驗收第 1 輪（Will 2026-11-15 授權，部署 `8a16601`）：himalayas 49／33（正式 49／33）、getonboard 186／4（188／6；seen 差推測是 09:15 與 15:00 之間來源變動，jobs 差推測是舊的 `exists ||` 把既有列算進 jobs、VM 新庫是空的，未量）、cryptojobslist 100／0（100／0）、hackernews 19／7（19／7）、v2ex 13／2（14／2），五個 `newOnly` 都是 0；arbeitnow 整批失敗：真實 API 多了 `www.arbeitnow.nl`（每頁 300 筆中 50 筆），補進網域白名單（PR #26）；freelancer、taiwanjobs 整批失敗：真實資料每天有少數壞列（taiwanjobs 1000 筆中 2 筆空標題、freelancer 第一頁 100 筆中 2 筆 `seo_url` 無斜線），Will 2026-11-15 決定「單筆跳過並計數，超過一半整批失敗」，套到全部 10 個 connector（`shared/set-aside.ts`，分母是 `examined`），本 PR；`/code-review` 發現 9（blocking 0）：改 5（分母不一致 4 項合併成 `examined`、`setAside` 也接 ZodError、`run-source.ts` 印出 rejected／truncated、過時註解）、記 1（`others` 的 O(n²)，5a2 刪）、不改 1（命名）；第 2 輪無回歸、無新發現；mutation 14 個全擋（`run-source.ts` 少印欄位沒有測試，已記）。測試 616→638 過。VM 驗收第 2 輪（部署 `81bfbbe`）：taiwanjobs 1000／1（正式 1000／1），rejected 2、newOnly 0；freelancer 1318／236（1323／234），rejected 16、truncated，newOnly 9 筆的 id 全大於正式庫最大 id（40818543），是新案子；arbeitnow 先因 API 的 `from`／`to` 錯（第 2 頁 from 101、兩頁重疊 0）失敗（PR #28 拿掉），再因 `per_page` 每頁不同（第 6 頁 per_page 224、短頁仍有下一頁）失敗，改成只檢查單頁內 `per_page` 為正整數且筆數不超過它，不再跨頁比對（本 PR；`/code-review` 發現 8（blocking 0）：改 5、記 2（跨頁重複且內容相同的職缺被合併時沒有訊號：已接受的取捨，步驟 6 來源狀態頁並列 `seen` 與 `jobs` 時看得出）、不改 1（舊計畫的盤點表只當紀錄，決定寫在這裡））；arbeitnow 第 3 次（部署 `9016cd7`）因「分頁途中內容變了」失敗：實測 20 頁 4,203 筆、跨頁重複 7 筆、其中 3 筆內文不同（來源每小時更新），Will 2026-11-15 決定讀取中重複的留最後讀到的版本、不拒收（本規則寫進 checklist §2；`/code-review` 發現 8（blocking 0）：改 2（checklist、註解引用）、記 3（兩家公司同 slug 會互蓋，實測 7 筆重複都是同一職缺、未見撞號，`external_id` 在 5a2 依 D10 重設計時一併處理；後面頁被跳過時留前面的舊版本；`others` 的 O(n²)）、不改 3（`seen` 逐頁加總同舊 `arbeitnow.ts:171`、golden 案例 3 只驗不拋錯而版本由單元測試與 mutation 守、Map 保留首次位置屬風格））；arbeitnow 第 4 次（部署 `dbc7e9f`）通過：seen 4,210、rejected 2、truncated（20 頁上限）、jobs 7；正式庫 arbeitnow 2026-11-02 起每天 failed、沒有可比的數字；`newOnly` 7 筆發布於 11/08–11/12，早於正式庫最後一次執行，但正式庫這兩週一筆都沒寫進去，34 筆舊 id 也沒有相近的，判讀為正式站漏收而非 id 漂移。VM 上的暫存清單已刪 | 5a 無（VM 驗收四輪都已跑）；`run-source.ts` 的輸出欄位沒有測試；記下的審查發現：兩個 XML 解析器（`shared/xml-feed.ts`、`taiwanjobs/xml.ts`）與兩個保留換行的 HTML 轉文字（arbeitnow `visibleText`、getonboard `fieldText`）以及各 connector 重複的小工具（`codePoints`、`isObject`、Python 空白集合），5b 開工時合併進 `shared/`；hackernews 一次執行最壞約 30 分鐘沒有整體時限，步驟 6 的重試與逾時一併定 | 5a 本 PR |
| 6 每日執行 | 程式完成待驗收（PR #37 已合進 `dev`，CI 綠含真 Postgres；VM 2026-11-15 部署 `bcd7510`（Will 授權），`0002_run_counts` 已套用、`web` healthy、`/sources` 200、清單頁 0.20 s；timer 照 Will 2026-11-15 的安排在 11-16 5a2-3 第 2 天量測後安裝，之後連 3 天量測） | 本機 `pnpm check` 綠（64 檔 657 過、7 跳過）、`pnpm build` 綠；mutation 14 個全擋（跳過已完成來源、不重試、全部重試、失敗即停、保留期限不篩來源 ×2、succeeded 再跑、失敗來源算完成、延遲上限、最早時刻、前日 `running` 不收、寫入失敗不收尾、存錯誤訊息，加第二批重跑跳過已完成來源）；`/code-review`（medium）發現 9（blocking 0）：改 5（當天無人接續：加 16:00 觸發與前日 `interrupted`；`Persistent` 補跑撞正式站：`EARLIEST_HOUR`；寫入失敗留 `running`：收尾成 `failed`；`error` 可能存頁面內容：只存代碼；保留期限兩處視窗：同一常數）、記 3、駁回 1（截斷的讀取不算健康：5a2-3 選 `last_seen_at` 就是因為 arbeitnow 每次截斷，篩掉截斷會讓它永遠不刪）；diff 審查第 1 輪發現 3（blocking 0）：改 2（`error` 寫進職缺參數，同上；舊測試對應寫在本步「舊測試的對應」）、記 1（hackernews 整體時限） | CI 的真 Postgres 重跑（push 後）；VM：連 3 天自然觸發各一列 `runs`、每次 ≤ 15 分鐘、`docker stats` ≤ 2 GB（要授權）。記下的審查發現：(1) `TimeoutStartSec` 只殺 compose 客戶端，容器是否跟著停要在 VM 裝 timer 時實測（`systemctl stop` 後看 `docker ps`）；(2) 重試固定等 30／120 秒、不看 `Retry-After`，且每次重試新建 fetcher，請求上限重算，最多 3 倍：步驟 8 分層讀取時改成跨重試共用請求預算；(3) 每個來源沒有整體時限，hackernews 最壞約 30 分鐘（推算，未量）：VM 連 3 天量測若總時間超過 15 分鐘，再加來源層的 AbortSignal 時限（逾時後放棄的 promise 不能再寫入，所以要從 fetcher 取消，不是 `Promise.race`） | 本 PR |
| 7 信件來源 | 進行中（7a 程式完成待驗收：分支 `step-7a`） | 7a：本機 `pnpm check` 綠（67 檔 678 過、7 跳過）、`pnpm build` 綠；jobbank104 fixture 40 例全過；mutation 9 個中 8 個被擋（收件信箱檢查、`external_id`、重複卡片規則、未列出的信不讀、已記錄不重讀（游標遺失時）、過半被拒失敗、出錯時存位置），存活 1 個：拿掉 `assertReceivingUrl` 的呼叫——網址只由固定的 `ROOT` 加驗過的 UUID 組成，公開介面走不到別的網址，這條是第二道防線，函式本身有直接測試；`/code-review` 發現 10（blocking 1）：改 8（單封讀不了的信改成記為被拒、不再卡住後面的信；設定錯的 inbox 記 `MailConfigError`；收件人清單照舊要求是文字清單；相對網址的職缺連結拒收；已記錄的查詢只查當頁 id；掃描上限要放得進請求上限；compose 共用環境變數；拿掉到不了的大小檢查）、記 1（失敗的信件來源列只記 attempts，寫過的在 `mail_messages`，寫在 `run-daily.ts` 註解）、駁回 1（裸 `href` 與 `href=""` 在 htmlparser2 分不出來，舊版 `href=""` 也算在連結內，golden 無此例） | 7a：CI；VM 連跑兩次第二次不新增列（要先部署，等 Will 授權）；步驟 4 的 id 比對（正式庫 104 的 `external_id` 對照） | `step-7a` |
| 8 分層讀取與新平台 | 未開始 | | | |
| 9 營運 | 完成 | `deploy/test-deploy.mjs` 7 個情境（健康部署、分支名解析成 origin、build／migration 失敗不動、不健康回滾、重建失敗回滾、回滾也不健康、健康狀態卡住逾時）以 stub `docker`／`git`／`flock` 通過並接進 `pnpm check`；mutation 8 個都被擋；`shellcheck` 無警告；`/code-review` 10 項：修 9、接受 1（腳本用目前 checkout 的版本，改 `deploy.sh` 從下一次部署生效，已寫進 `docs/operations.md`）；compose 的 `web`、`daily` 早已只用 `${APP_IMAGE}`（步驟 2），本步不用改 ；VM 演練（2026-11-15 Will 授權）：先以 `deploy.sh` 部署本 PR `28d7d8f`（healthy）；演練 A `/healthz` 故意失敗的 commit `094eb27`：`web unhealthy` → `rolled back to side-income-web:28d7d8f`，exit 1，前後 `APP_IMAGE` 都是 `28d7d8f`、checkout 回 `28d7d8f`、`/healthz` 200；演練 B 先建表再除以零的 migration（`b6b0ce7`）：`division by zero` → `migration failed; side-income-web:28d7d8f keeps serving`，exit 1，`web` 容器 id 前後相同仍 healthy、`drill_probe` 不存在、`__drizzle_migrations` 仍 2 列（整批交易回滾）；演練分支與映像已刪 | `flock` 的互斥沒有在 VM 上實測兩個並行部署 | `28d7d8f`（PR #36）、本 commit |
| 10 搬移、切換與退役 | 未開始 | | | |
| 11 刪舊機制 | 未開始 | | | |
| 12 收尾 | 未開始 | | | |
