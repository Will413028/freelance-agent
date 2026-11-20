# 盤點：現行系統（`web/`，快照 `0f38208`）每一項的去向

檢查：`python3 docs/plans/2026-11-15-self-hosted-rebuild/check_inventory.py`（每列去向以一個標籤開頭；「改寫」「只搬資料」要寫步驟）。

「延後」指主計畫的「範圍 → 延後」段。列數來源：2026-11-15 對正式 D1 唯讀計數（`cf d1 query <正式庫 id> --sql "select count(*) …"`，每 5 張表一批）。

## 資料表（30 張；最後一列是三張）

2026-11-20（12e W4）照 D10 改寫：原本寫「步驟 10 搬」「先匯出」的列都改成不搬、不匯出；舊庫 D1 已在步驟 10 刪除。

| 表 | 列數 | 去向 |
|---|---|---|
| `opportunities` | 3,433 | 改寫：步驟 3 定成 `listings`（欄位化＋`raw` jsonb）；資料不搬、id 不保留（D10，Will 2026-11-15） |
| `source_receipts` | 3,569 | 刪除：收據的用途是「同一筆投遞不重收」，新系統用 `(source, external_id)` upsert 加內容比對達成；信件的投遞身分改放 `mail_messages`（步驟 3、7） |
| `source_health` | 27 | 改寫：步驟 3 併入 `run_sources`（每次執行每來源一列），`/sources` 讀最近一次 |
| `daily_runs` | 59 | 刪除：資料不搬（D10）；新的 `runs`（步驟 6）從空開始，來源明細在 `run_sources` |
| `opportunity_tracking` | 4 | 改寫：步驟 3 定成 `listing_feedback`；資料不搬（D10） |
| `tracking_events` | 5 | 刪除：資料不搬（D10）；`listing_feedback_events` 從空開始 |
| `discovery_settings` | 0 | 改寫：步驟 3 的 `settings` 單列表 |
| `mail_sync_state` | 6 | 刪除：資料不搬（D10）；`mail_cursors` 從空開始，第一次執行讀現存收件匣 |
| `mail_ingestion` | 451 | 改寫：步驟 3 定成 `mail_messages`（加原因代碼、處置狀態）；資料不搬（D10） |
| `mail_content_versions` | 30 | 改寫：步驟 3 定成 `listing_versions`；資料不搬（D10） |
| `discovery_items` | 3,433 | 刪除：衍生投影，新形狀下評估結果是 `listings` 的欄位，不另存表 |
| `discovery_versions` | 30 | 刪除：同上，併入 `listing_versions` 的欄位 |
| `proposal_revisions` | 559 | 刪除：功能不要了（Will 2026-11-15）；不匯出（D10），D1 已於步驟 10 刪除 |
| `ai_draft_attempts` | 30 | 刪除：同上，不匯出（D10） |
| `digest_outbox` | 50 | 刪除：不寄摘要（舊計畫 D22）；不匯出（D10） |
| `manual_applications` | 0 | 刪除：空表，功能不要了 |
| `manual_application_opportunities` | 0 | 刪除：空表 |
| `manual_application_events` | 0 | 刪除：空表 |
| `clients` | 0 | 刪除：空表 |
| `client_contacts` | 0 | 刪除：空表 |
| `application_parties` | 0 | 刪除：空表 |
| `application_proposals` | 0 | 刪除：空表 |
| `proposal_templates` | 0 | 刪除：空表 |
| `proposal_drafts` | 0 | 刪除：空表 |
| `proposal_draft_revisions` | 0 | 刪除：空表 |
| `submission_intents` | 0 | 刪除：空表 |
| `submission_events` | 0 | 刪除：空表 |
| `writer_lease`／`write_attempts`／`guard` | 1／134／0 | 刪除：Postgres 有交易，租約與守衛不需要 |

## 來源（目錄 32 個名稱）

| 來源 | 現在怎麼讀 | 去向 |
|---|---|---|
| jobicy、remotive | 公開 JSON API（`sources/free-jobs.ts`） | 改寫：步驟 4（第一個小單元，定做法） |
| himalayas、getonboard、cryptojobslist | 公開 API | 改寫：步驟 5 |
| hackernews、v2ex | 公開 API（`community-jobs.ts`） | 改寫：步驟 5 |
| remoteok、realworkfromanywhere、weworkremotely、workingnomads | RSS／JSON feed（`public-feeds.ts`） | 改寫：步驟 5 |
| nodesk、justremote、dynamitejobs | 公開頁面 HTML | 改寫：步驟 5 |
| jobbank518、chickpt | 公開頁面 HTML（台灣） | 改寫：步驟 5 |
| taiwanjobs | 政府開放資料 | 改寫：步驟 5 |
| arbeitnow | 公開分頁 API | 改寫：步驟 5（先查 VM 上的錯誤種類） |
| freelancer | 官方 API、三個查詢分頁 | 改寫：步驟 5 |
| tasker、cake、jobbank104、talent、glassdoor | 職缺通知信，經 Resend Receiving | 改寫：步驟 7 |
| linkedin | 同上；2026-10-27 起每天約 4 封解析被拒 | 改寫：步驟 7（要一封被拒信的結構） |
| ptt_soho、ptt_codejob | 停用（Vercel 出口被擋） | 改寫：步驟 8（VM 上從最低一層試起） |
| flexjobs、remoters、toptal、guru、indeed | 只有名稱、沒有 connector | 延後：步驟 1 的平台評估決定哪些進步驟 8，其餘留在延後段 |

## 頁面與路由

| 項目 | 去向 |
|---|---|
| `/`（清單四檢視、分頁） | 改寫：步驟 3 讀新表；畫面不變 |
| `/jobs/[id]`、`POST /jobs/[id]/feedback` | 改寫：步驟 3；token 改用 `listing_feedback.revision` |
| `/settings`、`POST /settings/save` | 改寫：步驟 3 |
| `/sources` | 改寫：步驟 6（讀 `run_sources`）、步驟 7（被拒信的重排與消掉） |
| `/api/cron` | 刪除：排程改由 VM 的 systemd timer 直接跑指令，不經 HTTP |
| `/.well-known/workflow/*` | 刪除：Vercel Workflow 不用了 |

## 機制

路徑一律相對 repo 根目錄。「改寫」而舊檔要刪的列，在去向末尾以「舊檔：」列出舊檔；`check-deleted.sh` 讀標「刪除」「取代」列的位置欄與「舊檔：」後的路徑，任何一個還存在就失敗。

| 機制 | 位置 | 去向 |
|---|---|---|
| D1 REST client、租約、守衛、寫入單元 | `web/src/db/client.ts`、`web/src/db/d1/`、`web/src/db/unit.ts`、`web/src/db/usage.ts` | 取代：步驟 2 換成 Postgres 連線與一般交易 |
| drizzle sqlite schema 與 6 個 migration、migration 套用 | `web/src/db/schema.ts`、`web/src/db/migrate.ts`、`web/drizzle/`、`web/drizzle.config.ts`、`web/scripts/migrate.ts` | 取代：步驟 2、3 的 Postgres schema 與新 migration 目錄 |
| Vercel Workflow 每日執行（每步不重試）、`/api/cron` | `web/src/workflows/`、`web/src/services/daily.ts`、`web/src/app/api/cron/` | 取代：步驟 6 的指令加重試 |
| Vercel Cron 兩支 | `web/vercel.json` | 取代：步驟 6 的 systemd timer |
| 每次請求的 D1 用量計數、儲存檢討訊號 | `web/src/app/_lib/usage.ts`、`web/src/ops/`、`web/scripts/check-storage-triggers.ts` | 刪除：只為 D1 額度與租約存在；頁面紀錄 `withPageLog` 在步驟 11 改寫成 `web/src/app/_lib/page-log.ts`（D23） |
| 投影重建 | `web/scripts/rebuild-projection.ts`、`web/src/modules/discovery/projection.ts` | 刪除：沒有投影表 |
| 模擬 Python 的型別與函式 | `web/src/platform/py/`（2,082 行） | 刪除：步驟 4、5、7 逐來源換掉，步驟 11 刪目錄 |
| HTTP 讀取（urllib 語意） | `web/src/platform/http.ts`、`web/src/platform/http.test.ts` | 取代：步驟 4 的分層讀取介面 `web/src/platform/fetch/` |
| 頁面錯誤型別（繼承 `PyError`） | `web/src/platform/errors.ts` | 改寫：步驟 11 改成原生錯誤類別，檔案保留 |
| golden 測試資料與讀取 | `web/tests/fixtures/golden.json`（33 MB）、`web/tests/helpers/golden.ts` | 刪除：步驟 4、5、7 把各來源的輸入搬成各自的 fixture；最後一份（parsedate 70 例）在步驟 11 搬成 `web/src/modules/sources/shared/parsedate.fixtures.json`，步驟 12d 刪除（換成 `time.fixtures.json`） |
| 舊程式的測試與輔助 | `web/tests/helpers/db.ts`、`web/tests/helpers/intake.ts`、`web/tests/helpers/jobs.ts`、`web/tests/helpers/reference.ts`、`web/tests/helpers/resend.ts`、`web/tests/d1-paths.test.ts`、`web/tests/d1-real.test.ts`、`web/tests/d1-real-product.test.ts`、`web/tests/schema.test.ts`、`web/tests/write-units.test.ts`、`web/tests/storage-triggers.test.ts`、`web/tests/daily.test.ts`、`web/tests/scenarios.test.ts`、`web/tests/scale.test.ts`、`web/tests/projection.test.ts`、`web/tests/ranking-rounding.test.ts`、`web/tests/batch1-sources.test.ts`、`web/tests/batch3-sources.test.ts`、`web/tests/batch4-sources.test.ts`、`web/tests/cryptojobslist.test.ts`、`web/tests/free-jobs.test.ts`、`web/tests/public-feeds.test.ts`、`web/tests/mail-sources.test.ts` | 刪除：只測舊程式；D23 廢掉「舊測試只能跟取代它的新測試同 PR 刪」，舊行為以 `git show ce1254d:<路徑>` 查 |
| 歷史提案外殼（每筆職缺的 proposal、approved_hash、review_status） | `web/src/modules/legacy/` | 刪除：功能不要了；步驟 3 的新形狀沒有這些欄位 |
| 一人群組、去重 key、新穎度 | `web/src/modules/discovery/rules.ts`（`asGroup`、`identityKeys`、`novelty`）；消費端 `web/src/services/pages.ts`、`web/src/services/discovery.ts` | 改寫：步驟 3 讓頁面直接讀職缺列，不再包成群組；去重 key 與新穎度不搬（舊計畫 D18 量到合併 0 筆、D22 取消摘要）。舊檔：`web/src/services/discovery.ts` |
| 資格判定與排序 | `web/src/modules/discovery/` | 改寫：步驟 3 改原生型別，規則不變（`web/src/modules/evaluation/`）。舊檔：`web/src/modules/discovery/` |
| 人工投案連結排除 | `web/src/modules/applications/` | 刪除：表是空的、功能不要了 |
| 回饋與設定的舊寫入 | `web/src/modules/preferences/` | 取代：步驟 3 的 `web/src/modules/review/` |
| 每日一次的 claim | `web/src/modules/notifications/` | 改寫：步驟 6（唯一鍵加交易；`web/src/modules/runs/`）。舊檔：`web/src/modules/notifications/` |
| 網頁寫入守門（同站來源、格式、大小） | `web/src/app/_lib/guard.ts` | 改寫：步驟 3 原樣搬，測試照留（檔案保留） |
| 舊來源 connector、來源目錄、信件同步與 Resend Receiving client（只送 GET） | `web/src/modules/collection/` | 改寫：步驟 4、5、7 逐來源搬到 `web/src/modules/sources/`，來源顯示名稱在步驟 11 搬成 `web/src/modules/sources/catalog.ts` 每筆的 `label`；還沒搬的來源（5b、5c、7、8）照 `connector-checklist.md` 從 `git show ce1254d:<路徑>` 改寫，限制不變。舊檔：`web/src/modules/collection/` |
| Python 時間解析語意（`fromisoformat`、`parsedate_to_datetime` 的邊角形式） | `web/src/modules/listings/legacy-time.ts`、`web/src/modules/sources/shared/time.ts`、`web/src/modules/sources/shared/parsedate.fixtures.json` | 改寫：步驟 12d 完成，`legacy-time.ts` 與兩份 Python fixture 刪除；`sources/shared/time.ts` 只讀 ISO 8601 擴充格式（RFC 3339 加空格分隔、可省秒、±HHMM）與 RFC 5322 date-time；`time.fixtures.json` 列各來源 fixture 實際出現的格式與出處；7 個 connector 改用 `parseIsoTime`、拿掉 `Z→+00:00` 替換；fixture 裡沒出現的非標準 RFC 2822 寫法（完整月份名、星期後無逗號、單位數小時等）刻意不收，讀成未知（code-review 2026-11-20 記錄） |
| Vercel Workflow 的建置外掛與相依套件 | `web/next.config.ts` 的 `withWorkflow`；`web/package.json` 的 `workflow`、`@vercel/functions`、`test:d1` | 改寫：步驟 11 拿掉（檔案保留） |

## 環境變數與外部資源

| 項目 | 去向 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`D1_API_TOKEN`、`CRON_SECRET`、`DIGEST_RECIPIENT`、`WEB_WRITES` | 刪除：切換後不再需要 |
| `RESEND_API_KEY`、`RESEND_INBOX` | 改寫：步驟 7 放進 VM 的私人 env 檔 |
| Vercel production 上殘留的 `WEB_WRITES`、`DIGEST_RECIPIENT` | 刪除：正式站凍結在仍讀它們的版本，不能先刪；步驟 10 隨 Vercel 專案一起退役 |
| `PORTFOLIO_CATEGORY_PROJECTS` 與評估結果的 `portfolio_ids`（`modules/discovery/domain.ts`、`portfolio.ts`） | 刪除：只給提案功能用，沒有頁面讀它（`rg -n portfolio web/src/app web/src/services` 無結果）；步驟 3 的評估輸出拿掉這一欄 |
| Vercel 專案、D1 `freelance-agent-prod`、`freelance-agent-ci-test`、`freelance-agent-spike-1f` | 刪除：步驟 10 驗收通過當天退役（D5：不留回滾窗口），要 Will 授權 |
| CI 的 `d1` job、`gate.needs` 裡的 `d1` | 刪除：步驟 2 拿掉（過渡期不再部署到 Vercel） |
| GitHub 的三個 D1 secrets、`pnpm test:d1`、`tests/d1-real*.test.ts` | 刪除：secrets 在步驟 10 退役時刪，script 與測試檔在步驟 11 刪 |

## 舊待辦的去向（`docs/implementation-plan.md`「未完成工作」，`0f38208`）

| 舊待辦 | 去向 |
|---|---|
| 回饋簽名（`asGroup` 與 `{id: token}`） | 改寫：步驟 3，token 改成 `listing_feedback.revision` |
| 排序函式的測試專用匯出（`groupItems`） | 刪除：步驟 3 沒有群組，函式不搬 |
| 舊樣式 class（`globals.css`） | 改寫：步驟 3 改頁面時，沒被用到的 class 一起拿掉 |
| 去向表 | 取代：本檔就是新的去向表 |
| `source-catalog.ts` 的 Python 欄位、`REGISTRY`／`RUNNERS`／`FAILURE_REASON` 三張表 | 改寫：步驟 4 定成每個來源一筆設定（名稱、順序、最高層級、間隔、每日上限、停用原因） |
| `AccessBlocked`／`PyError` 歸位、`formatG` | 刪除：步驟 11 隨 `platform/py/` 刪；新程式用原生的錯誤類別 |
| `schema.ts` 檔頭列的沿用（時間戳存文字等） | 改寫：步驟 3 的 Postgres 欄位用 `timestamptz`、`boolean`、`jsonb` |
| `services/daily.ts` 為回滾保留的結果形狀 | 改寫：步驟 6 的 `run_sources` |
| v1 雜湊換版本、golden 拆分 | 改寫：id 照全域約束保留；內容指紋與收據雜湊不搬（步驟 3）；golden 在步驟 3、4、5、7 拆成各自的 fixture，步驟 11 刪 |
| 信件來源內部例外的錯誤種類 | 改寫：步驟 7 |
| 三個每天失敗的來源 | 改寫：Talent.com 的規則已改（PR #11，未部署；新系統步驟 7 帶同樣的規則）、LinkedIn 步驟 7、Arbeitnow 步驟 5 |
| 下一次部署後刪 Vercel 的 `WEB_WRITES`、對正式 D1 套 0005 | 刪除：過渡期不部署新版，0005 不套；步驟 10 整個退役 |
| D1 token 2026-11-30 到期 | 延後：主計畫前提段的有日期待辦（不是本計畫延後段的項目：觸發是日期） |
| 確認 Cloudflare 與 Vercel 帳單 | 延後：步驟 10 退役後由 Will 確認（主計畫延後段沒有對應項，列在步驟 12「需要人做的事」） |

## 新增與沿用機制的必要條件（12e O6、O7）

上面各段只記舊系統每項的去向。這段補新系統新增或照搬的機制：為什麼需要、今天是否成立、什麼時候重新評估。（2026-11-20，design-review 12e。）

| 機制 | 位置 | 必要條件 | 今天是否成立 | 重新評估條件 |
|---|---|---|---|---|
| 部署失敗自動回前一版 | `deploy/deploy.sh` | 單機、沒有藍綠或 registry；壞版不能讓網頁停擺 | 成立：步驟 9 兩次演練 | 改用 registry 或多台機器 |
| 部署互斥鎖 | `deploy.sh` 的 `flock` | 多個 session 可能同時部署到同一台共用 VM | 成立：本機脈絡規定動 VM 前先查別的 session | 改由 CI 單一管道部署 |
| migration 只能先加後刪 | `deploy/check-migrations.mjs`（12e O5） | 回滾只換映像不回 schema，且沒有備份（D1） | 成立 | 加了備份或 schema 回滾 |
| 只在 `migrate` 服務跑 migration | `deploy/compose.yaml`（12e O3） | migration 不需要 Resend key 與 browser 網路 | 成立 | — |
| gitleaks 雙層（pre-push＋CI `secrets`） | `.githooks/pre-push`、`ci.yml` | repo 公開；hook 可被跳過，CI 擋不了已推出去的 | 成立 | repo 改私人 |
| browser 獨立網路 | `deploy/compose.yaml`、`check-compose.mjs` | browser 載入不受信任的頁面，不能碰 `db`、`web` | 成立（步驟 8d 審查） | 不再有 browser 層來源 |
| CI 在 arm64 建映像並渲染一頁 | `ci.yml` 的 `image` job | VM 是 arm64；Apify 映像沒有 arm64（spikes §2） | 成立 | VM 換架構 |
| `gate` 匯總 job（照搬） | `ci.yml` | 分支保護只要指定一個必要檢查，job 增減不用改設定 | 成立（推測：GitHub 分支保護的常見做法） | 分支保護改用 ruleset 列出每個 job |
| 同站來源檢查（照搬） | `web/src/app/_lib/guard.ts` | 原為公開網路上的 Vercel 設計；只走 Tailscale 仍要防瀏覽器端的跨站請求（CSRF） | 成立：tailnet 內任一頁面仍可對它發請求 | — |
| 完整 `web/` 映像（不用 standalone） | `deploy/web.Dockerfile` | `daily` 與一次性指令用 `tsx` 跑 `scripts/*.ts`；只在 VM 本機建置（計畫第 33 行） | 成立；1.47 GB | VM 磁碟吃緊或改走 registry |
| 評估欄位帶規則版本 | `listings.evaluated_with`、`reevaluate.ts`（D26） | 規則改版後舊列要跟著重算；`facts.test.ts` 把版本綁在 fixture 結果的雜湊上 | 成立 | 規則改成依設定或時間變動（那時改成讀取時現算） |
| 重算逐列 UPDATE、`evaluated_with` 無索引 | `reevaluate.ts` | 只在版本調升後跑一次；現有列數為數千（保存 30 天） | 成立（推論：數千列逐列更新遠小於 unit 的 60 分鐘上限） | 調版本後的每日執行 `reevaluated` 花的時間超過 5 分鐘，或列數超過 5 萬：改成每批一條 `UPDATE … FROM (VALUES …)` 並加部分索引 |
| 重算讀不了的列（`unparsable`） | `reevaluate.ts`、`runs.counts.unparsable` | contract 收緊後，舊 `raw` 可能過不了 | 至今 0（新欄位尚未部署） | 每日執行記到 `unparsable > 0`：該列的評估值是舊規則的；修 contract 讓舊 `raw` 仍可讀，或在同一個 PR 寫一次性 migration 刪掉這些列（D9：還在來源上的會在下次收案重新收進來） |
| `check-compose.mjs` 的 key、timer 與容器名檢查 | `deploy/check-compose.mjs`（12e O3、O4、W5） | Resend key 只給 `daily`；timer 首次觸發與 `EARLIEST_HOUR` 是同一事實的兩份；停止時刪的容器要是跑的那個 | 成立 | unit 或排程改由程式產生（單一來源） |
| depcruise `no-unresolvable`、`no-retired-platform`，掃 `src` 與 `scripts` | `web/.dependency-cruiser.cjs`（D27） | 舊系統的路徑與套件不能回來；取代步驟 11 的 grep | 成立 | — |

## 既有缺陷與處置

1. LinkedIn 有一種通知每天約 4 封在解析階段被拒。處置：修（步驟 7；回歸測試：那種通知的 fixture 解析出職缺）。
2. Arbeitnow 在 Vercel 上 6 秒內失敗、本機成功，原因未知。處置：修（步驟 5；回歸測試：VM 上的實際錯誤種類對應的 fixture；若是 Vercel 出口問題，搬到 VM 即消失，記錄量到的結果）。
3. 被拒的信沒有重排或消掉的入口，也沒有原因代碼。處置：修（步驟 7；回歸測試：重排後下一次執行重讀、消掉後不再計入）。
4. 中斷的每日執行永遠停在 `running`。處置：修（步驟 6；回歸測試：殺掉執行後重跑同一天會接著做完）。
5. 信件來源內部接住的例外沒有錯誤種類。處置：修（步驟 7；回歸測試：Resend 回 429 時來源明細帶錯誤種類）。
6. Preview 部署沒有資料庫。處置：隨改寫消失（沒有 Vercel preview）。
