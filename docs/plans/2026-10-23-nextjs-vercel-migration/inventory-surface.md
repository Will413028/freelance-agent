# 舊系統表面清單（Python backend → Next.js／Vercel／Postgres 改寫用）

基準：commit `d994cd2`（`git -C <repo> rev-parse --short HEAD` 實測）。唯讀盤點，未執行 app、未讀 runtime／credential 檔。所有 file:line 相對於 repo 根目錄；`去向` 欄在步驟 2 填寫，格式與檢查見 `check_inventory.py`。

證據等級：表名、route、CLI、task、測試數量都是用下方「重跑指令」實測。「production／ops／legacy」的分類是根據 `deploy/compose*.yaml`、`docs/compose.md`、README 及 import 追蹤推論的，屬於 inferred，不是看正式 VM 得到的結果。

---

## 1. SQLite 資料表

來源：`backend/src/freelance/platform/schema/001_sqlite.sql`（產品 SQLite 的唯一 schema 檔，共 25 個 `CREATE TABLE`、6 個 trigger）。「歷史資料」欄標 **保留** 的表，存的是不可重建的歷史紀錄或證據（proposals、outbox、tracking、receipts、applications、submissions）。

| item | where (file:line) | what it does in one line | owner module | 歷史資料 | 去向 |
|---|---|---|---|---|---|
| opportunities | platform/schema/001_sqlite.sql:1 | 來源職缺列，`(source, external_id)` 唯一，`item` 是 JSON envelope（含 legacy review_status／proposal 欄位） | collection（寫入透過 legacy/records.py） | 保留 | 改寫：web/src/db/schema.ts `opportunities`（`item` 存 text，D4、spike 1c 規則 1），讀寫只經 web/src/modules/legacy/records.ts（D8）；步驟 4a 建表、4b codec、4c 收斂搬資料 |
| proposal_revisions | 001_sqlite.sql:8 | 舊 AI／人工提案正文版本，`(opportunity_id, version)` | legacy/records.py | 保留 | 改寫：web/src/db/schema.ts `proposal_revisions`（`proposal`、`fingerprint` 存 text）；唯一寫入點是 records.ts `save` 對已有 proposal 的歷史列（D8）；步驟 4a／4b，資料步驟 4c 搬 |
| source_receipts | 001_sqlite.sql:16 | 每個來源 receipt ID 對應到職缺，用來防止重複匯入 | collection | 保留 | 改寫：web/src/db/schema.ts `source_receipts`，由 web/src/modules/collection/ingest.ts 寫入並查重；步驟 4a／4b，資料步驟 4c 搬 |
| source_health | 001_sqlite.sql:23 | 每個來源最新的檢查狀態（not_connected/ok/failed/waiting） | collection | 否（可重建） | 改寫：web/src/db/schema.ts `source_health`（第一個 migration）＋web/src/modules/collection/source-health.ts；步驟 3 建、步驟 4c 搬值（D4 全表搬） |
| digest_outbox | 001_sqlite.sql:28 | 每日摘要 intent，同日同收件者唯一，snapshot 不可變，trigger 擋不安全的轉移 | notifications | 保留 | 改寫：web/src/db/schema.ts `digest_outbox`（`snapshot` 存 text）＋`digest_immutable` 等價 trigger（步驟 4a）；狀態機 web/src/modules/notifications/outbox.ts（步驟 10）；資料步驟 4c 搬，反向腳本回寫 `status`（步驟 12） |
| daily_runs | 001_sqlite.sql:51 | 每日執行 claim，`(local_date, recipient)` 主鍵，running/complete/failed | notifications | 保留 | 改寫：web/src/db/schema.ts `daily_runs`，主鍵 `(local_date, recipient)`；claim 在 web/src/modules/notifications/daily-runs.ts（步驟 5）、finish（步驟 10）；資料步驟 4c 搬 |
| opportunity_tracking | 001_sqlite.sql:60 | 每個職缺目前的人工狀態（收藏／略過／歷史 applied 等） | preferences | 保留 | 改寫：web/src/db/schema.ts＋web/src/modules/preferences/store.ts；步驟 4b，資料步驟 4c 搬，反向腳本回寫 `state`（步驟 12） |
| tracking_events | 001_sqlite.sql:64 | tracking 的追加 revision ledger | preferences | 保留 | 改寫：web/src/db/schema.ts＋web/src/modules/preferences/store.ts（revision ledger 只追加）；步驟 4b，資料步驟 4c 搬 |
| ai_draft_attempts | 001_sqlite.sql:72 | 舊 AI 背景擬稿的嘗試紀錄 | legacy/ai_drafts.py | 保留（只讀歷史） | 只搬資料：web/src/db/schema.ts 建表（步驟 4a）、收斂腳本 v1 搬入（步驟 4c）、反向腳本原樣保留（步驟 12）；legacy/ai_drafts.py 不改寫（D8） |
| discovery_settings | 001_sqlite.sql:86 | 單列（id=1）探索設定 JSON 加上 revision | discovery（modules/discovery/settings.py） | 否（設定，需搬值） | 改寫：web/src/db/schema.ts＋web/src/modules/discovery/settings.ts（revision 防過期）；步驟 4b，值由步驟 4c 搬 |
| mail_sync_state | 001_sqlite.sql:91 | Resend 收信游標（每個 source／recipient 一列） | collection | 否（但遺失會重讀） | 改寫：web/src/db/schema.ts＋web/src/modules/collection/mail/cursor.ts；步驟 9（表在 4a 建、值 4c 搬、反向腳本回寫 `cursor` 在步驟 12） |
| mail_ingestion | 001_sqlite.sql:97 | 逐封 processed/rejected/conflict 與 retry_pending | collection | 保留（隔離證據） | 改寫：web/src/db/schema.ts＋web/src/modules/collection/mail/ingestion.ts（processed／rejected／conflict、retry_pending）；步驟 9 |
| mail_content_versions | 001_sqlite.sql:107 | 同來源 ID 不同內容的正規化版本，`(opportunity_id, fingerprint)` | collection | 保留 | 改寫：web/src/db/schema.ts＋web/src/modules/collection/mail/content-versions.ts；步驟 9 |
| manual_applications | 001_sqlite.sql:113 | 本人填寫的投案（四階段、跟進日、revision、request_id 冪等） | applications | 保留 | 改寫：web/src/db/schema.ts＋web/src/modules/applications/store.ts（request_id 冪等、revision）；步驟 11（表 4a、資料 4c） |
| manual_application_opportunities | 001_sqlite.sql:129 | 投案與來源職缺的關聯 | applications | 保留 | 改寫：web/src/modules/applications/store.ts；步驟 11（表 4a、資料 4c） |
| manual_application_events | 001_sqlite.sql:135 | 投案的追加稽核事件 | applications | 保留 | 改寫：web/src/modules/applications/store.ts（事件只追加）；步驟 11（表 4a、資料 4c） |
| clients | 001_sqlite.sql:143 | 客戶（revision、封存、request_payload 冪等） | relationships | 保留 | 改寫：web/src/db/schema.ts＋web/src/modules/relationships/store.ts（revision、封存、request_payload 冪等）；步驟 11（表 4a、資料 4c） |
| client_contacts | 001_sqlite.sql:154 | 聯絡人，屬於某個客戶 | relationships | 保留 | 改寫：web/src/modules/relationships/store.ts；步驟 11（表 4a、資料 4c） |
| application_parties | 001_sqlite.sql:168 | 投案對客戶／聯絡人的關聯及名稱 snapshot | applications | 保留 | 改寫：web/src/modules/applications/store.ts（名稱 snapshot 存 text）；步驟 11（表 4a、資料 4c） |
| proposal_templates | 001_sqlite.sql:175 | 本人模板（純文字、revision、封存） | proposals（新模組） | 保留 | 改寫：web/src/db/schema.ts＋web/src/modules/proposals/store.ts；步驟 11（表 4a、資料 4c） |
| proposal_drafts | 001_sqlite.sql:180 | 草稿 metadata、來源 tokens 與 snapshot、party | proposals | 保留 | 改寫：web/src/modules/proposals/store.ts（來源 tokens 與 snapshot 存 text）；步驟 11（表 4a、資料 4c） |
| proposal_draft_revisions | 001_sqlite.sql:186 | 不可變的草稿版本（trigger 禁止 UPDATE／DELETE，:192、:194） | proposals | 保留 | 改寫：web/src/db/schema.ts＋`draft_revision_immutable`／`draft_revision_retained` 等價 trigger（步驟 4a）；web/src/modules/proposals/store.ts 只追加（步驟 11）；反向腳本只追加（步驟 12） |
| submission_intents | 001_sqlite.sql:196 | 精確核准送出 intent，snapshot 不可變，狀態轉移由 trigger 守（:209） | submissions | 保留 | 只搬資料：web/src/db/schema.ts 建表、snapshot 存 text、`submission_immutable` 等價 trigger（步驟 4a）；收斂腳本 v1 搬入（步驟 4c）；送出程式不改寫（D7） |
| submission_events | 001_sqlite.sql:205 | 送出事件 ledger（trigger 禁止 UPDATE／DELETE，:222、:224） | submissions | 保留 | 只搬資料：web/src/db/schema.ts＋`submission_event_immutable`／`submission_event_retained` 等價 trigger（步驟 4a）；收斂腳本 v1（步驟 4c）、反向腳本只追加（步驟 12）；D7 |
| application_proposals | 001_sqlite.sql:226 | 投案對草稿版本／submission 的關聯及證據 snapshot | applications | 保留 | 改寫：web/src/db/schema.ts＋web/src/modules/applications/store.ts（證據 snapshot 存 text）；既有指向 submission 的關聯只讀，新的 submission 關聯延後（D7）；步驟 11 |

Trigger（共 6 個）：`digest_immutable` :41、`draft_revision_immutable` :192、`draft_revision_retained` :194、`submission_immutable` :209、`submission_event_immutable` :222、`submission_event_retained` :224。Postgres 端必須有等價機制（trigger 或 CHECK 加上應用層），否則不可變性會失守。

### 1b. 其他 schema 來源與遷移機制

| item | where (file:line) | what it does in one line | 去向 |
|---|---|---|---|
| `Database.migrate()` | backend/src/freelance/platform/sqlite.py:47 | 檔案不存在時建立 0600 新檔，然後整份執行 `001_sqlite.sql`（全部 `CREATE ... IF NOT EXISTS`），包在 `BEGIN IMMEDIATE` 裡 | 取代：Drizzle 版本化 migration（web/drizzle/，步驟 4a），不再整份 `IF NOT EXISTS` 重跑 |
| source_health 重建 | platform/sqlite.py:57-67 | 舊表 CHECK 缺 `'waiting'` 時，建 `source_health_with_waiting`、搬資料、DROP 舊表、RENAME | 刪除：只為升級舊 SQLite 檔；Postgres 直接以最終形狀建表（步驟 4a），收斂腳本讀的是已重建後的現行 schema |
| ai_draft_attempts 重建 | platform/sqlite.py:68-88 | 缺 `priority` 欄或主鍵形狀不對時，RENAME 成 `_legacy`、重建、搬資料（priority 預設 'legacy'） | 刪除：同 source_health 重建；ai_draft_attempts 只搬資料（D8） |
| 版本機制 | （沒有） | 沒有 `schema_version` 表，也不用 `PRAGMA user_version`；升級靠 idempotent 的 IF NOT EXISTS 加上兩段內省重建 | 取代：Drizzle migration journal（drizzle-kit 的 migrations 表），步驟 4a |
| 遷移入口 | bootstrap/store.py:226（`python -m freelance.bootstrap.store --migrate --database ...`） | 唯一的正式顯式 migrate；API／worker 不會自動 migrate | 取代：`pnpm db:migrate`（drizzle-kit migrate）對 Neon branch 執行，步驟 4a；正式 branch 的執行時點見「計畫缺口」1 |
| 連線語意 | platform/sqlite.py:24-44 | 檔案必須是 owner-only 0600 regular file；寫入用 `BEGIN IMMEDIATE`、timeout 5 秒；讀取用 `mode=ro` 加 `BEGIN`；開啟 foreign_keys | 取代：Postgres 交易＋`daily_runs` row claim 與 advisory lock（步驟 4a、5）；0600 檔案權限改由 Neon 連線字串放 Sensitive env 保護 |
| MemoryDatabase | platform/sqlite.py:95-122 | Demo 用的 in-memory SQLite，套同一份 schema | 取代：PGlite 加 network guard 的離線 demo（步驟 11） |
| 001_initial.sql（Postgres） | platform/schema/001_initial.sql:1,8,16,23,28 | 舊 PostgreSQL schema，5 張表（opportunities、proposal_revisions、source_receipts、source_health、digest_outbox），只有 legacy/postgres.py:33 讀它 | 刪除：只有 legacy/postgres.py 讀，舊 PG adapter 不改寫（D8）；5 張表在 001_sqlite.sql 都有現行版本 |
| 升級 gate | scripts/test_workbench_upgrade.py | 在 DB 副本上驗兩次升級、舊表指紋、新舊版回讀 | 刪除：步驟 12 先用它驗回寫的 SQLite 副本，步驟 14 刪除（計畫步驟 14 刪除清單） |

---

## 2. HTTP API

一共 42 個 operation（`contracts/openapi.json` 實測 42 個 operation、32 個 path）。路由註冊只出現在 `bootstrap/http.py`（11 個）和 `bootstrap/workbench_http.py`（31 個）。全域行為：`LocalBoundary` middleware（http.py:19）檢查 Host 白名單；POST／PATCH／DELETE 要求 Origin 為 `127.0.0.1:3327`／`localhost:3327`、`application/json`、body 64 KiB 上限、5 秒讀取 timeout、body 必須是 JSON 物件；所有回應加 `no-store`／`nosniff`；錯誤統一為 `Error` 並對應 400/403/404/409/413/415/503（http.py:114-130）。422 被從 OpenAPI 移除（http.py:192-200）。`openapi_url=None`，契約只能透過 `bootstrap/export.py` 匯出。

| item | where (file:line) | what it does in one line | request → response contract | 去向 |
|---|---|---|---|---|
| GET /dashboard | bootstrap/http.py:135 | 分組後的職缺、來源狀態、偏好、分類、排程旗標、operations | — → Dashboard | 改寫：web/src/app/page.tsx 的 server component 呼叫 web/src/modules/discovery/queries.ts `getDashboard`（operations 投影來自 notifications 公開契約）；步驟 11 |
| GET /opportunities/{key} | http.py:145 | 單一職缺（群組）的公開投影 | — → Item | 改寫：web/src/modules/discovery/queries.ts `getOpportunity`，由 server component 直接呼叫；步驟 11 |
| GET /digest | http.py:149 | 依目前清單即時算出 HTML 摘要預覽（不寫 outbox） | — → HTMLResponse（無 model） | 改寫：route handler web/src/app/digest/route.ts 回 HTML，render 用 web/src/modules/notifications/digest.ts（步驟 10，見計畫缺口 5）；步驟 11 |
| POST /preferences | http.py:153 | 以 revision 防過期的方式寫設定 | PreferencesView → PreferencesView | 改寫：server action web/src/modules/preferences/actions.ts `updatePreferences`（zod 驗證，D10；revision 防過期）；步驟 11 |
| POST /feedback/{key} | http.py:157 | 對整組 members 收藏／略過，要帶 member token | FeedbackCommand → Saved | 改寫：server action web/src/modules/preferences/actions.ts `updateFeedback`（zod 驗證，D10；member token、沿用呼叫端交易）；步驟 11 |
| GET /applications | http.py:161 | 投案清單（stage、due、client_id、分頁） | query → ApplicationList | 改寫：web/src/modules/applications/queries.ts `listApplications`，由 server component 直接呼叫；步驟 11 |
| GET /applications/summary | http.py:165 | 週統計與今日／逾期跟進數 | — → ApplicationSummary | 改寫：web/src/modules/applications/queries.ts `getApplicationSummary`，由 server component 直接呼叫；步驟 11 |
| POST /applications | http.py:169 | 建立人工投案（可附 versions、party、proposal、submission） | ApplicationCreate → ApplicationView | 改寫：server action web/src/modules/applications/actions.ts `createApplication`（zod 驗證，D10；request_id 冪等；附 submission 的分支延後，D7）；步驟 11 |
| PATCH /applications/{key} | http.py:176 | 更正投案 | ApplicationUpdate → ApplicationView | 改寫：server action web/src/modules/applications/actions.ts `updateApplication`（zod 驗證，D10）；步驟 11 |
| GET /applications/{key} | http.py:180 | 單筆投案 | — → ApplicationView | 改寫：web/src/modules/applications/queries.ts `getApplication`，由 server component 直接呼叫；步驟 11 |
| DELETE /applications/{key} | http.py:184 | 軟刪除（DELETE 帶 JSON body） | ApplicationDelete → Saved | 改寫：server action web/src/modules/applications/actions.ts `deleteApplication`（zod 驗證，D10；軟刪除，不再需要帶 body 的 DELETE）；步驟 11 |
| GET /clients | bootstrap/workbench_http.py:8 | 客戶分頁清單 | query → ClientList | 改寫：web/src/modules/relationships/queries.ts `listClients`，由 server component 直接呼叫；步驟 11 |
| POST /clients | workbench_http.py:12 | 建立客戶（request_id 冪等） | ClientCreate → ClientView | 改寫：server action web/src/modules/relationships/actions.ts `createClient`（zod 驗證，D10；request_id 冪等）；步驟 11 |
| GET /clients/{key} | workbench_http.py:15 | 單一客戶 | — → ClientView | 改寫：web/src/modules/relationships/queries.ts `getClient`，由 server component 直接呼叫；步驟 11 |
| PATCH /clients/{key} | workbench_http.py:18 | 更新客戶 | ClientUpdate → ClientView | 改寫：server action web/src/modules/relationships/actions.ts `updateClient`（zod 驗證，D10）；步驟 11 |
| POST /clients/{key}/archive | workbench_http.py:21 | 封存客戶 | RevisionCommand → ClientView | 改寫：server action web/src/modules/relationships/actions.ts `archiveClient`（zod 驗證，D10）；步驟 11 |
| GET /clients/{key}/contacts | workbench_http.py:24 | 客戶的聯絡人分頁 | query → ContactList | 改寫：web/src/modules/relationships/queries.ts `listContacts`，由 server component 直接呼叫；步驟 11 |
| POST /contacts | workbench_http.py:28 | 建立聯絡人 | ContactCreate → ContactView | 改寫：server action web/src/modules/relationships/actions.ts `createContact`（zod 驗證，D10）；步驟 11 |
| GET /contacts/{key} | workbench_http.py:31 | 單一聯絡人 | — → ContactView | 改寫：web/src/modules/relationships/queries.ts `getContact`，由 server component 直接呼叫；步驟 11 |
| PATCH /contacts/{key} | workbench_http.py:34 | 更新聯絡人 | ContactUpdate → ContactView | 改寫：server action web/src/modules/relationships/actions.ts `updateContact`（zod 驗證，D10）；步驟 11 |
| POST /contacts/{key}/archive | workbench_http.py:37 | 封存聯絡人 | RevisionCommand → ContactView | 改寫：server action web/src/modules/relationships/actions.ts `archiveContact`（zod 驗證，D10）；步驟 11 |
| POST /applications/{key}/party | workbench_http.py:40 | 指定或更正投案的客戶／聯絡人 | ApplicationPartyCommand → ApplicationView | 改寫：server action web/src/modules/applications/actions.ts `setApplicationParty`（zod 驗證，D10）；步驟 11 |
| GET /proposal-templates | workbench_http.py:43 | 模板清單 | query → TemplateList | 改寫：web/src/modules/proposals/queries.ts `listTemplates`，由 server component 直接呼叫；步驟 11 |
| POST /proposal-templates | workbench_http.py:47 | 建立模板 | TemplateCreate → TemplateView | 改寫：server action web/src/modules/proposals/actions.ts `createTemplate`（zod 驗證，D10）；步驟 11 |
| POST /proposal-templates/preview | workbench_http.py:50 | 純函式渲染預覽（不讀 DB） | TemplatePreview → RenderedTemplate | 改寫：純函式 web/src/modules/proposals/render.ts `previewTemplate`（不讀 DB），由 server action 包裝；步驟 11 |
| GET /proposal-templates/{key} | workbench_http.py:53 | 單一模板 | — → TemplateView | 改寫：web/src/modules/proposals/queries.ts `getTemplate`，由 server component 直接呼叫；步驟 11 |
| PATCH /proposal-templates/{key} | workbench_http.py:56 | 更新模板 | TemplateUpdate → TemplateView | 改寫：server action web/src/modules/proposals/actions.ts `updateTemplate`（zod 驗證，D10）；步驟 11 |
| POST /proposal-templates/{key}/archive | workbench_http.py:59 | 封存模板 | RevisionCommand → TemplateView | 改寫：server action web/src/modules/proposals/actions.ts `archiveTemplate`（zod 驗證，D10）；步驟 11 |
| GET /proposals | workbench_http.py:62 | 草稿清單 | query → ProposalList | 改寫：web/src/modules/proposals/queries.ts `listProposals`，由 server component 直接呼叫；步驟 11 |
| POST /proposals | workbench_http.py:66 | 建立草稿（來源草稿會核對 discovery tokens） | ProposalCreate → ProposalView | 改寫：server action web/src/modules/proposals/actions.ts `createProposal`（zod 驗證，D10；核對 discovery tokens）；步驟 11 |
| GET /proposals/{key} | workbench_http.py:69 | 單一草稿與其版本 | — → ProposalView | 改寫：web/src/modules/proposals/queries.ts `getProposal`，由 server component 直接呼叫；步驟 11 |
| POST /proposals/{key}/versions | workbench_http.py:72 | 追加不可變版本 | ProposalAppend → ProposalView | 改寫：server action web/src/modules/proposals/actions.ts `appendProposalVersion`（zod 驗證，D10；不可變版本）；步驟 11 |
| POST /proposals/{key}/template | workbench_http.py:75 | 重新套模板，產生新版本 | ProposalApplyTemplate → ProposalView | 改寫：server action web/src/modules/proposals/actions.ts `applyProposalTemplate`（zod 驗證，D10）；步驟 11 |
| POST /proposals/{key}/archive | workbench_http.py:78 | 封存草稿 | RevisionCommand → ProposalView | 改寫：server action web/src/modules/proposals/actions.ts `archiveProposal`（zod 驗證，D10）；步驟 11 |
| GET /submission-capabilities | workbench_http.py:81 | email／freelancer 通道狀態（沒有 runtime 時一律 not_configured） | — → SubmissionCapabilities | 改寫：web/src/app/submissions/page.tsx 靜態顯示 email／freelancer「未配置」，不建 route（D7）；步驟 11 |
| GET /submissions | workbench_http.py:86 | 送出 intent 清單 | query → SubmissionList | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；歷史列由 submission_intents 只搬資料保存 |
| POST /submissions | workbench_http.py:89 | 從草稿版本建立 prepared intent | SubmissionCreate → SubmissionView | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| GET /submissions/{key} | workbench_http.py:92 | 單一 intent | — → SubmissionView | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| POST /submissions/{key}/approve | workbench_http.py:95 | 核准 snapshot hash（prepared→approved） | SubmissionApprove → SubmissionView | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| POST /submissions/{key}/cancel | workbench_http.py:98 | 取消未 attempted 的 intent | RevisionCommand → SubmissionView | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| POST /submissions/{key}/reconcile | workbench_http.py:101 | 追加 user_reported 核對 | SubmissionReconcile → SubmissionView | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| POST /submissions/{key}/dispatch | workbench_http.py:104 | 入列 Huey `submission_v1`（沒有 runtime 時回 409） | RevisionCommand → DispatchView | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；屆時用 Workflows step 改寫，不沿用 Huey（D2） |

`bootstrap/contracts.py` 共有 62 個 class（`rg -c "^class "`）。Item、Job、Evaluation、Recommendation、Member、ContentVersion、ContentConflict、DisplayBasis、Tracking、Operations、SourceRun、SourceCheck、DailyRun 等巢狀 DTO 沒有出現在上表，但都是 response 形狀的一部分。

---

## 3. 前端呼叫點

架構：瀏覽器 → `openapi-fetch` client（`baseUrl: '/api'`）→ Next route handler `src/app/api/[...path]/route.ts`（同源 proxy，以 regex 白名單轉發到 `http://127.0.0.1:8327` 或 `http://api:8327`，timeout 8 秒）→ FastAPI。

### 3a. Proxy 與 typed client（API 表面的第二份登記處）

| item | where (file:line) | what it does in one line | 去向 |
|---|---|---|---|
| proxy upstream | frontend/src/app/api/[...path]/route.ts:3 | `FREELANCE_CONTAINER=1` 時指向 `api:8327`，否則 `127.0.0.1:8327` | 刪除：全端同源後沒有上游 API（D10），步驟 11 移除 proxy |
| Host 檢查 | route.ts:6-8 | 只接受 `127.0.0.1:3327`／`localhost:3327` | 取代：Vercel Authentication（All Deployments，spike 1a）＋route 層 Origin 檢查（步驟 11） |
| route 白名單 | route.ts:11-22 | 手寫 regex 列出 GET／POST／PATCH／DELETE 可走的 path；opportunity／feedback ID 限 24 或 64 位 hex，其他實體限 UUID | 刪除：步驟 11 移除 proxy 白名單；route handler 與 server action 本身就是唯一登記處（缺陷 2） |
| Origin、大小、轉發 | route.ts:23-39 | 非 GET 要求 Origin 同源，64 KiB 上限，失敗回 503「請先啟動 Python API」 | 改寫：web/src/shared/http/guard.ts 對 route handler 檢查 Origin 與 64 KiB body 上限；server action 用 Next 內建 Origin 檢查與 `serverActions.bodySizeLimit`；步驟 11 |
| typed client 定義 | frontend/src/shared/api/client.ts:20 | `createClient<paths>({ baseUrl: '/api' })` | 刪除：D10 移除 openapi-fetch 與生成契約 |
| client.ts 包裝函式 | shared/api/client.ts:29-42 | 10 個函式：dashboard、opportunity、preferences、feedback、applications ×6 | 取代：直接呼叫各模組的 queries.ts／actions.ts（D10），步驟 11 |
| workbench.ts 包裝函式 | shared/api/workbench.ts:13-43 | 31 個函式，與 workbench_http.py 的 31 個 route 一一對應 | 取代：直接呼叫 applications／relationships／proposals 模組的 queries.ts／actions.ts（D10），步驟 11 |

### 3b. Feature 呼叫點（file:line → route）

| item | where (file:line) | what it does in one line | 去向 |
|---|---|---|---|
| getDashboard | features/discovery/discovery-page.tsx:24 | GET /dashboard | 改寫：web/src/features/discovery/discovery-page.tsx 由 web/src/app/page.tsx 傳入 `getDashboard` 結果；步驟 11 |
| updateFeedback | features/discovery/discovery-page.tsx:59 | POST /feedback/{key} | 改寫：web/src/features/discovery/discovery-page.tsx 呼叫 server action `updateFeedback`；步驟 11 |
| 摘要預覽連結 | features/discovery/discovery-page.tsx:71 | `<a href="/api/digest">`，GET /digest（未經 typed client） | 改寫：web/src/features/discovery/discovery-page.tsx 連到 `/digest` route handler；步驟 11 |
| updatePreferences | features/discovery/discovery-page.tsx:90 | POST /preferences | 改寫：web/src/features/discovery/discovery-page.tsx 呼叫 server action `updatePreferences`；步驟 11 |
| getApplications、getApplicationSummary | features/applications/applications-page.tsx:24 | GET /applications、GET /applications/summary | 改寫：web/src/features/applications/applications-page.tsx 由頁面 server component 取 `listApplications`、`getApplicationSummary`；步驟 11 |
| updateApplication | features/applications/applications-page.tsx:33 | PATCH /applications/{key} | 改寫：web/src/features/applications/applications-page.tsx 呼叫 server action `updateApplication`；步驟 11 |
| deleteApplication | features/applications/applications-page.tsx:40 | DELETE /applications/{key} | 改寫：web/src/features/applications/applications-page.tsx 呼叫 server action `deleteApplication`；步驟 11 |
| getApplication | features/applications/applications-page.tsx:53 | GET /applications/{key} | 改寫：web/src/features/applications/applications-page.tsx 由 server component 取 `getApplication`；步驟 11 |
| setApplicationParty | features/applications/application-party.tsx:11 | POST /applications/{key}/party | 改寫：web/src/features/applications/application-party.tsx 呼叫 server action `setApplicationParty`；步驟 11 |
| getApplication | features/applications/application-party.tsx:13 | GET /applications/{key} | 改寫：web/src/features/applications/application-party.tsx 由 server component 取 `getApplication`；步驟 11 |
| getSubmission | features/applications/new-application-page.tsx:28 | GET /submissions/{key} | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；新投案頁在通道配置前不提供「從 submission 建投案」 |
| getProposal | features/applications/new-application-page.tsx:30 | GET /proposals/{key} | 改寫：web/src/features/applications/new-application-page.tsx 由 server component 取 `getProposal`；步驟 11 |
| getApplicationSummary、getOpportunity | features/applications/new-application-page.tsx:32 | GET /applications/summary、GET /opportunities/{key} | 改寫：web/src/features/applications/new-application-page.tsx 由 server component 取 `getApplicationSummary`、`getOpportunity`；步驟 11 |
| createApplication | features/applications/new-application-page.tsx:47 | POST /applications | 改寫：web/src/features/applications/new-application-page.tsx 呼叫 server action `createApplication`；步驟 11 |
| getClients | features/relationships/clients-page.tsx:17 | GET /clients | 改寫：web/src/features/relationships/clients-page.tsx 由 server component 取 `listClients`；步驟 11 |
| getClient、getContacts、getApplications | features/relationships/clients-page.tsx:18 | GET /clients/{key}、GET /clients/{key}/contacts、GET /applications?client_id | 改寫：web/src/features/relationships/clients-page.tsx 由 server component 取 `getClient`、`listContacts`、`listApplications({clientId})`；步驟 11 |
| createClient、updateClient | features/relationships/clients-page.tsx:23 | POST /clients、PATCH /clients/{key} | 改寫：web/src/features/relationships/clients-page.tsx 呼叫 server action `createClient`、`updateClient`；步驟 11 |
| createContact、updateContact | features/relationships/clients-page.tsx:24 | POST /contacts、PATCH /contacts/{key} | 改寫：web/src/features/relationships/clients-page.tsx 呼叫 server action `createContact`、`updateContact`；步驟 11 |
| getClient | features/relationships/clients-page.tsx:25,27 | GET /clients/{key} | 改寫：web/src/features/relationships/clients-page.tsx 由 server component 取 `getClient`（action 後 revalidate）；步驟 11 |
| getContact | features/relationships/clients-page.tsx:26 | GET /contacts/{key} | 改寫：web/src/features/relationships/clients-page.tsx 由 server component 取 `getContact`；步驟 11 |
| archiveClient | features/relationships/clients-page.tsx:36 | POST /clients/{key}/archive | 改寫：web/src/features/relationships/clients-page.tsx 呼叫 server action `archiveClient`；步驟 11 |
| archiveContact | features/relationships/clients-page.tsx:43 | POST /contacts/{key}/archive | 改寫：web/src/features/relationships/clients-page.tsx 呼叫 server action `archiveContact`；步驟 11 |
| getClients | features/relationships/party-picker.tsx:9 | GET /clients | 改寫：web/src/features/relationships/party-picker.tsx 由 server component 傳入 `listClients`；步驟 11 |
| getClient | features/relationships/party-picker.tsx:10 | GET /clients/{key} | 改寫：web/src/features/relationships/party-picker.tsx 由 server component 傳入 `getClient`；步驟 11 |
| getContacts | features/relationships/party-picker.tsx:11 | GET /clients/{key}/contacts | 改寫：web/src/features/relationships/party-picker.tsx 由 server component 傳入 `listContacts`；步驟 11 |
| getProposals | features/proposals/proposals-page.tsx:17 | GET /proposals | 改寫：web/src/features/proposals/proposals-page.tsx 由 server component 取 `listProposals`；步驟 11 |
| getOpportunity | features/proposals/proposals-page.tsx:19 | GET /opportunities/{key} | 改寫：web/src/features/proposals/proposals-page.tsx 由 server component 取 `getOpportunity`；步驟 11 |
| getTemplates | features/proposals/proposals-page.tsx:23 | GET /proposal-templates | 改寫：web/src/features/proposals/proposals-page.tsx 由 server component 取 `listTemplates`；步驟 11 |
| getProposal | features/proposals/proposals-page.tsx:24,40 | GET /proposals/{key} | 改寫：web/src/features/proposals/proposals-page.tsx 由 server component 取 `getProposal`；步驟 11 |
| createProposal | features/proposals/proposals-page.tsx:25 | POST /proposals | 改寫：web/src/features/proposals/proposals-page.tsx 呼叫 server action `createProposal`；步驟 11 |
| appendProposal | features/proposals/proposals-page.tsx:26 | POST /proposals/{key}/versions | 改寫：web/src/features/proposals/proposals-page.tsx 呼叫 server action `appendProposalVersion`；步驟 11 |
| applyProposalTemplate | features/proposals/proposals-page.tsx:27 | POST /proposals/{key}/template | 改寫：web/src/features/proposals/proposals-page.tsx 呼叫 server action `applyProposalTemplate`；步驟 11 |
| previewTemplate | features/proposals/proposals-page.tsx:34 | POST /proposal-templates/preview | 改寫：web/src/features/proposals/proposals-page.tsx 呼叫包裝 `previewTemplate` 的 server action；步驟 11 |
| archiveProposal | features/proposals/proposals-page.tsx:42 | POST /proposals/{key}/archive | 改寫：web/src/features/proposals/proposals-page.tsx 呼叫 server action `archiveProposal`；步驟 11 |
| getTemplates | features/proposals/templates.tsx:10 | GET /proposal-templates | 改寫：web/src/features/proposals/templates.tsx 由 server component 傳入 `listTemplates`；步驟 11 |
| createTemplate、updateTemplate | features/proposals/templates.tsx:12 | POST /proposal-templates、PATCH /proposal-templates/{key} | 改寫：web/src/features/proposals/templates.tsx 呼叫 server action `createTemplate`、`updateTemplate`；步驟 11 |
| getTemplate | features/proposals/templates.tsx:13 | GET /proposal-templates/{key} | 改寫：web/src/features/proposals/templates.tsx 由 server component 取 `getTemplate`；步驟 11 |
| archiveTemplate | features/proposals/templates.tsx:18 | POST /proposal-templates/{key}/archive | 改寫：web/src/features/proposals/templates.tsx 呼叫 server action `archiveTemplate`；步驟 11 |
| getSubmissionCapabilities、getSubmissions | features/submissions/submissions-page.tsx:13 | GET /submission-capabilities、GET /submissions | 改寫：web/src/app/submissions/page.tsx 只顯示「未配置」（D7），不呼叫任何查詢；步驟 11 |
| getProposal、getSubmission | features/submissions/submissions-page.tsx:14 | GET /proposals/{key}、GET /submissions/{key} | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| getSubmission | features/submissions/submissions-page.tsx:16,17,40,42 | GET /submissions/{key} | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| prepareSubmission | features/submissions/submissions-page.tsx:18 | POST /submissions | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| approveSubmission | features/submissions/submissions-page.tsx:39 | POST /submissions/{key}/approve | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| dispatchSubmission | features/submissions/submissions-page.tsx:40 | POST /submissions/{key}/dispatch | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| cancelSubmission | features/submissions/submissions-page.tsx:41 | POST /submissions/{key}/cancel | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| reconcileSubmission | features/submissions/submissions-page.tsx:45 | POST /submissions/{key}/reconcile | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| getApplicationSummary | features/workbench/navigation.tsx:9 | GET /applications/summary（導覽列的跟進數） | 改寫：web/src/features/workbench/navigation.tsx 由 web/src/app/layout.tsx 取 `getApplicationSummary` 傳入；步驟 11 |

App 頁面（薄路由）：`src/app/page.tsx`→discovery、`applications/page.tsx`、`applications/new/page.tsx`→applications、`clients/page.tsx`→relationships、`proposals/page.tsx`→proposals、`submissions/page.tsx`→submissions、`layout.tsx`→workbench navigation。42 個 operation 中，前端用到 41 個 typed 包裝函式，`/digest` 走裸連結，所以 42 個都有被前端使用。

### 3c. 對生成契約 `contracts/api.d.ts` 的依賴

| item | where (file:line) | what it does in one line | 去向 |
|---|---|---|---|
| `paths` 型別 | shared/api/client.ts:2,20 | openapi-fetch 的 path／method／body 都由生成的 `paths` 檢查型別 | 取代：zod schema（web/src/modules/<module>/contracts.ts）當唯一契約來源（D10），步驟 11 |
| `components['schemas']` 別名 | shared/api/client.ts:5-14、shared/api/workbench.ts:4-11 | Dashboard、Item、Job、Settings、ApplicationView、ClientView、ProposalView、SubmissionView、PartySelection 等型別別名，所有 feature 透過它們拿型別 | 取代：各模組 contracts.ts 匯出的 `z.infer` 型別（D10），步驟 11 |
| 錯誤型別 | shared/api/client.ts:23 | `components['schemas']['Error']` 決定錯誤訊息欄位 `error` | 取代：web/src/shared/result.ts 的錯誤結果型別，由 zod schema 定義（D10），步驟 11 |
| 生成工具 | frontend/tools/contracts/generate.mjs（openapi-typescript 7.13.0 + TS 5.9.3） | 讀 `contracts/openapi.json`，寫出 `contracts/api.d.ts`；`--check` 檢查有無漂移 | 刪除：D10 移除 OpenAPI 生成；frontend/ 在步驟 14 刪除 |
| 編譯期負向測試 | frontend/tests/contracts.ts:1-15（4 個 `@ts-expect-error`） | 契約若被放寬，typecheck 會失敗（tsconfig 的 include 涵蓋 `**/*.ts`） | 取代：zod 的型別測試（Vitest `expectTypeOf`／`@ts-expect-error`，D10），步驟 11 |
| OpenAPI 匯出 | backend/src/freelance/bootstrap/export.py:8 | 用合成資料建 app 並輸出 openapi.json；`--check` 比對差異 | 刪除：D10 移除 OpenAPI 生成 |

---

## 4. CLI 入口

`backend/pyproject.toml:8-12` 定義 4 個 console script；有 `__main__` guard 的 module 共 19 個。分類依據是 compose.yaml 和 docs 引用（inferred）。

| item | where (file:line) | what it does in one line | 使用場景 | 去向 |
|---|---|---|---|---|
| `python -m freelance.bootstrap.worker`（`freelance-worker`） | bootstrap/worker.py:50 | 取得 queue.lock flock，啟動 Huey consumer（1 thread，含 periodic），啟動時立即入列當天 daily | **production**（compose.yaml:19；compose.submissions.yaml:10 加 `--submissions-config`） | 取代：Vercel Cron（09:00＋12:00，D5）觸發 Vercel Workflows（D2），入口 web/src/app/api/cron/daily/route.ts；步驟 5 |
| `python -m freelance.bootstrap.api`（`freelance-api`） | bootstrap/api.py:50 | uvicorn loopback API，demo／sqlite 模式；可選 `--queue --submissions-config` 成為 producer | **production**（compose.yaml:34；compose.submissions.yaml:4）＋本機 demo | 取代：Next.js 全端 app 的 route handler／server action（D10，步驟 11）；demo 模式改 PGlite（步驟 11） |
| `python -m freelance.bootstrap.store --migrate` | bootstrap/store.py:226 | 顯式 SQLite migrate | **production 切換步驟**（docs/compose.md:95、README:58） | 取代：Drizzle migrate（`pnpm db:migrate`，步驟 4a） |
| `python -m freelance.bootstrap.daily`（`freelance-daily`） | bootstrap/daily.py:32 | 手動跑一次每日用例（收信、摘要、可選寄送），參數與 worker.json 相同 | ops（手動補跑；與 worker 共用 jobs.execute_daily） | 取代：`vercel crons run` 手動觸發同一個 cron route（spike 1a 驗過），`daily_runs` claim 保證不重跑（D2、D5） |
| `python -m freelance.bootstrap.cli`（`freelance-jobs`） | bootstrap/cli.py:12 | 終端 list/summary/feedback/preferences，不連網 | ops／本機（README:60） | 刪除：list／summary／feedback／preferences 都在 Web UI（步驟 11）；它是 legacy/review.py 例外類別唯一的 production 依賴，刪除後該依賴消失 |
| `python -m freelance.bootstrap.recovery` | bootstrap/recovery.py:8 | 列出隔離的信件 ID，或以 `--retry` 重排一封 rejected | ops／recovery（docs/compose.md:150-151） | 改寫：受保護頁面 web/src/app/ops/recovery/page.tsx＋server action（列出隔離信件、把一封 rejected 標回 retry_pending），邏輯在 web/src/modules/collection/mail/ingestion.ts；步驟 10（計畫步驟 10 的 recovery 項） |
| `python -m freelance.bootstrap.submission_operations` | bootstrap/submission_operations.py:7 | `verify-bid`（唯讀查 Freelancer bid）、`cancel-for-rollback` | ops／recovery（docs/compose.md:73,78） | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；verify-bid 與 cancel-for-rollback 隨送出改寫 |
| `python -m freelance.bootstrap.export` | bootstrap/export.py:8 | 匯出或檢查 OpenAPI | build／CI（README:86） | 刪除：D10 移除 OpenAPI 生成 |
| `python -m freelance.bootstrap.mail_sync` | bootstrap/mail_sync.py:80 | 舊 Tasker Gmail 單次 preview／import，`--backend` **預設 postgres** | legacy（只有 implementation-history 提到） | 刪除：Gmail 路徑 dormant（inventory-sources §1.3），舊 PG backend 不改寫（D8）；見缺陷 3 |
| `python -m freelance.bootstrap.daily_cli` | bootstrap/daily_cli.py:16 | 舊的 Gmail token 版每日 Tasker 收信加摘要 | legacy（docs 無引用，有 3 個測試檔引用） | 刪除：Tasker 已改走 resend_sync（source_catalog.py:15），docs 無引用，只有測試呼叫 |
| `python -m freelance.bootstrap.scheduler_cli` | bootstrap/scheduler_cli.py:5 | 跑一次 daily_tick 建 intent、不寄送，`--backend` **預設 postgres** | legacy | 刪除：legacy，`--backend` 預設 postgres（D8 舊 PG 不改寫）；daily_tick 本身在步驟 10 改寫 |
| `python -m freelance.bootstrap.gmail_send_cli` | bootstrap/gmail_send_cli.py:18 | 預覽或顯式以 Gmail API 寄出既有摘要 intent | legacy／ops（systemd 時代） | 刪除：D9 選 Gmail SMTP，Gmail API 寄送 dormant |
| `python -m freelance.bootstrap.gmail_smtp_cli` | bootstrap/gmail_smtp_cli.py:14 | 預覽或以 Gmail SMTP 寄既有 intent（要求 expected sha256） | legacy／ops | 改寫：受保護頁面 web/src/app/ops/digest/page.tsx＋server action：預覽 MIME 並顯示 sha256，帶相符的 expected sha256 才寄既有 pending intent，重試 0 次（D9）；步驟 10（見計畫缺口 3） |
| `python -m freelance.bootstrap.resend_send_cli` | bootstrap/resend_send_cli.py:14 | 預覽或以 Resend 寄既有 intent | legacy／ops | 刪除：D9 不用 Resend 寄送 |
| `python -m freelance.modules.collection.resend_preview` | modules/collection/resend_preview.py:212 | 有上限的 Resend Receiving 預覽，不寫 DB | ops（接新來源時的偵查） | 刪除：只在接新信件來源時偵查，本計畫不新增來源；同檔的 ReceivingClient、寄件者 allowlist 與 `matches()` 是 resend_sync 的依賴，步驟 9 改寫到 web/src/modules/collection/mail/receiving.ts |
| `python -m freelance.modules.collection.gmail_auth` | modules/collection/gmail_auth.py:140 | 一次性 Gmail OAuth bootstrap | legacy（碰憑證） | 刪除：Gmail 路徑 dormant，正式 image 沒裝 google-auth；碰憑證 |
| `python -m freelance.modules.collection.intake` | modules/collection/intake.py:16 | 從 stdin 讀 Tasker 通知，離線預覽 parse 加 qualify | 開發工具 | 刪除：開發用離線預覽；Tasker 已走 Resend，parse＋qualify 由步驟 9 的 Vitest fixture 涵蓋 |
| `python -m freelance.legacy.postgres --migrate` | legacy/postgres.py:192 | 用 `FREELANCE_DATABASE_URL` 做 PostgreSQL migrate（001_initial.sql） | legacy | 刪除：舊 PG adapter 不改寫（D8） |
| `python -m freelance.legacy.ai_worker` | legacy/ai_worker.py:5 | 只印出 `retired` 並 exit 2 | legacy（退役 stub） | 刪除：退役 stub（D8） |

Repo 層級腳本（不是 package 入口）：`scripts/check_boundaries.py`、`scripts/test_installed.py`、`scripts/test_compose.py`、`scripts/test_workbench_upgrade.py`、`scripts/verify_cutover.py`。

---

## 5. Huey task、排程與狀態機

### 5a. Task 與排程

| item | where (file:line) | what it does in one line | 去向 |
|---|---|---|---|
| SqliteHuey queue | bootstrap/queue.py:24 | `SqliteHuey('freelance', filename=queue.sqlite, results=False)`，檔案必須是 owner-only 0600 | 取代：Vercel Workflows（D2）；run 狀態在 Postgres `daily_runs` |
| `daily(day)` task | bootstrap/queue.py:26 | retries=0；`due_date(now) != day` 時回 `expired_trigger`，不補跑跨日 | 取代：web/src/bootstrap/daily-workflow.ts 的 workflow，入口驗 `dueDate(now) == day`，跨日不補（D2、D5），步驟 5 |
| `tick` periodic | bootstrap/queue.py:32 | `crontab(minute='*')`，台北 09:00 後每分鐘入列 `daily(today)` | 取代：Vercel Cron 09:00 與 12:00 兩支（D5），步驟 5 |
| `due_date` | bootstrap/queue.py:10 | Asia/Taipei，hour ≥ 9 才回日期 | 改寫：web/src/modules/notifications/schedule.ts `dueDate`（Asia/Taipei、hour ≥ 9）；步驟 5 |
| `submission_v1` task | bootstrap/queue.py:42 | retries=0；payload 必須剛好是 `{schema_version:1, intent_id}`，否則回 `unsupported_task` | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；屆時用 Workflows step，不沿用 Huey（D2） |
| 啟動時入列 | bootstrap/worker.py:62-64 | consumer 啟動前若已過 09:00，直接入列當天 daily | 取代：12:00 補跑 cron（D5），步驟 5 |
| 單一 consumer 鎖 | bootstrap/worker.py:18-27,58 | `fcntl.flock(queue.lock)`，第二個 worker 會拒絕啟動 | 取代：`daily_runs` row claim＋Postgres advisory lock（計畫不變量表），步驟 5 |
| `run_once` 去重 | bootstrap/worker.py:30-34 | 產品 DB 已有該日 daily_run 就直接回傳其狀態，不再執行 | 改寫：cron handler web/src/app/api/cron/daily/route.ts 入口的 `daily_runs` claim，已有 run 直接返回；步驟 5 |
| consumer 設定 | bootstrap/worker.py:65-66 | workers=1、thread、periodic=True、shutdown_timeout=30 | 取代：Workflows step `maxRetries = 0`（D2、spike 1b） |
| submission task 註冊 | bootstrap/worker.py:60-61 | **一律註冊**；沒有 `--submissions-config` 時 runtime 回 not_configured | 刪除：Huey 專屬接線（D2）；送出改寫延後（D7） |
| API 端 producer | bootstrap/submission_runtime.py:35-49 | `bind_queue` 建同一個 queue（daily handler 為 no-op），`enqueue` 在交易內重驗後才入列 | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| worker healthcheck | deploy/compose.yaml:27、worker.py:37 | 只檢查 queue.lock 是否被持有 | 取代：Vercel Workflows run 狀態與 `source_health` 頁面（D2），步驟 5 |

### 5b. daily_runs 狀態機

狀態：`running`、`complete`、`failed`（CHECK 在 001_sqlite.sql:54）。資料庫沒有 trigger，轉移由程式守住。

| item | where (file:line) | what it does in one line | 去向 |
|---|---|---|---|
| ∅ → running | modules/notifications/store.py:112-115（claim_daily_run，`INSERT ... ON CONFLICT DO NOTHING`） | 同日同收件者只會有一個 claim；claim 不到就回 `already_run` | 改寫：web/src/modules/notifications/daily-runs.ts `claimDailyRun`（`INSERT … ON CONFLICT DO NOTHING`）；步驟 5 |
| claim 呼叫點 | modules/notifications/daily.py:37 | 搶不到 claim 時回 `{'status':'already_run','run_status':...}` | 改寫：web/src/app/api/cron/daily/route.ts 入口，搶不到回 already_run；步驟 5 |
| running → complete／failed | modules/notifications/store.py:127-133（`WHERE status='running'`） | 寫入 result JSON 與 finished_at | 改寫：daily-runs.ts `finishDailyRun`（`WHERE status='running'`）；步驟 10 |
| finish 呼叫點 | modules/notifications/daily.py:97 | 來源 ok 或沿用既有 digest 時為 complete；來源失敗、寄送非 sent、例外時為 failed | 改寫：web/src/bootstrap/daily-workflow.ts 最後一個 step；步驟 10 |
| running 卡住 | （沒有轉移） | 程序中斷會留下 running，只能人工核對，沒有自動重跑（docs/compose.md:46） | 改寫：維持沒有自動轉移（AGENTS.md：中斷的 run 不自動重試）；web/src/app/ops/recovery/page.tsx 列出卡住的 run 供人工核對；步驟 10 |

### 5c. digest_outbox 狀態機

狀態：`pending` → `attempted` → `sent`｜`unknown`。trigger `digest_immutable`（001_sqlite.sql:41-50）擋其他轉移，並禁止改 id、date、recipient、snapshot；`sent` 必須有 delivery_receipt（:38）。

| item | where (file:line) | what it does in one line | 去向 |
|---|---|---|---|
| ∅ → pending | modules/notifications/store.py:54-75（create_digest） | 同日已有就回既有的；否則算 candidates，扣掉 sent／attempted／unknown 歷史 snapshot 的 novelty 後 INSERT | 改寫：web/src/modules/notifications/outbox.ts `createDigest`（novelty 用 canonical-json，snapshot 存 text）；步驟 10 |
| pending → attempted | modules/notifications/store.py:93-97（claim_digest，`WHERE status='pending'`） | 送出前先提交 attempt | 改寫：outbox.ts `claimDigest`（`WHERE status='pending'`）；步驟 10 |
| attempted → sent／unknown | modules/notifications/store.py:101-108（finish_digest，`WHERE status='attempted'`） | sent 必須有 receipt | 改寫：outbox.ts `finishDigest`（sent 必須有 receipt）；步驟 10 |
| 送出編排 | modules/notifications/scheduler.py:20-39（dispatch） | claim → sender（在交易外）→ 沒有 message_id 或拋例外就標 unknown | 改寫：web/src/modules/notifications/dispatch.ts，寄送 step `maxRetries = 0`（D2、spike 1b）；步驟 10 |
| 寄送 adapter | modules/notifications/resend_delivery.py:65、gmail_smtp.py:22、gmail_send.py:107、resend_send.py:70 | 都經過 `scheduler.dispatch` | 改寫：只改寫 gmail_smtp → web/src/modules/notifications/gmail-smtp.ts（D9），`build_message` → notifications/mime.ts；resend_delivery、resend_send、gmail_send 的送出部分刪除（D9）；步驟 10 |
| daily 內寄送 | modules/notifications/daily.py:68-92、bootstrap/jobs.py:7-36 | worker 依 `live_send` 加 `sender`（Resend）或 `smtp_config` 二選一 | 改寫：daily-workflow.ts 的寄送 step，只有 SMTP 一條（D9）；shadow 期缺憑證，結構上無法寄出；步驟 10 |

### 5d. submission_intents 狀態機

狀態：`prepared`、`approved`、`attempted`、`accepted`、`rejected`、`unknown`、`cancelled`（001_sqlite.sql:199）。trigger `submission_immutable`（:209-221）只允許 prepared→approved／cancelled、approved→attempted／cancelled、attempted→accepted／rejected／unknown。每次轉移都會在 `submission_events` 追加一筆。

| item | where (file:line) | what it does in one line | 去向 |
|---|---|---|---|
| ∅ → prepared | modules/submissions/store.py:41-48（prepare_in） | 從草稿版本建立不可變 snapshot 加 hash，request_id 冪等 | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；資料表與 trigger 在步驟 4a 照搬 |
| prepared → approved | modules/submissions/store.py:50-58（approve） | 核對 snapshot_hash 後寫 approval_hash | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；資料表與 trigger 在步驟 4a 照搬 |
| approved → attempted | modules/submissions/store.py:60-69（claim_in） | 重驗 provider、環境、帳號與 approval_hash；終態直接回傳、不 claim | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；資料表與 trigger 在步驟 4a 照搬 |
| attempted → accepted／rejected／unknown | modules/submissions/store.py:71-78（finish）；判定在 modules/submissions/domain.py:65-79（accepted_receipt） | 沒有可驗證 receipt 一律 unknown | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；資料表與 trigger 在步驟 4a 照搬 |
| prepared／approved → cancelled | modules/submissions/store.py:80-85（cancel） | 已 attempt 的不可取消 | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；資料表與 trigger 在步驟 4a 照搬 |
| rollback 取消 | modules/submissions/store.py:87-93（cancel_pending_for_rollback） | 把所有 approved 改成 cancelled | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；資料表與 trigger 在步驟 4a 照搬 |
| 核對（不改 status） | modules/submissions/store.py:95-106（reconcile，user_reported）、:108-118（reconcile_verified，provider_verified_accepted） | 只寫 reconciliation 欄並追加 event；attempted／unknown 狀態保留 | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；資料表與 trigger 在步驟 4a 照搬 |
| 跨模組編排 | bootstrap/submissions.py:4-14（execute） | 交易內 validate 加 claim，交易外 send，然後 finish | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；資料表與 trigger 在步驟 4a 照搬 |
| 入列 | bootstrap/submission_runtime.py:40-49（enqueue） | approved 且通道已驗證、帳號與環境相符才入列；入列不改 status | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；資料表與 trigger 在步驟 4a 照搬 |
| worker dispatch | bootstrap/submission_runtime.py:51-62 | worker 讀憑證，然後呼叫 EmailSender／FreelancerSender | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；資料表與 trigger 在步驟 4a 照搬 |
| 投案關聯 | bootstrap/store.py（application_proposal_in，:52） | accepted 或有 reconciliation 的 intent 才能關聯到人工投案 | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；資料表與 trigger 在步驟 4a 照搬 |

---

## 6. 測試

Backend：74 個測試檔，629 個 `def test_`（`rg -c "def test_" backend/tests` 加總）。另有 `backend/tests/fixtures/` 存放共用資料。`backend/tests/preferences/` **是空目錄**，偏好的測試散在 bootstrap 與 discovery。

| item | where (file:line) | what it does in one line | 去向 |
|---|---|---|---|
| test_api_contract.py (8) | backend/tests/bootstrap/ | HTTP 契約與 OpenAPI | 取代：zod schema 型別測試與 server action 輸入驗證測試（D10），步驟 11 |
| test_applications_http.py (2) | bootstrap/ | 投案 HTTP | 改寫：web/src/modules/applications/actions.test.ts；步驟 11 |
| test_applications.py (11) | bootstrap/ | applications 用例（冪等、revision、tokens） | 改寫：web/src/modules/applications/store.test.ts（冪等、revision、tokens）；步驟 11 |
| test_architecture.py (10) | bootstrap/ | 模組邊界與組裝 | 取代：dependency-cruiser 規則（計畫前提「工具鏈預設」），步驟 3 接進 CI |
| test_daily_delivery.py (5) | bootstrap/ | daily 加寄送 | 改寫：web/src/bootstrap/daily-workflow.test.ts（daily 加寄送）；步驟 10 |
| test_gmail_postgres.py (4) | bootstrap/ | legacy Gmail 加 Postgres 路徑 | 刪除：Gmail 路徑 dormant、舊 PG adapter 不改寫（D8） |
| test_huey_runner.py (4) | bootstrap/ | Huey queue／tick／expired | 取代：Vercel Cron＋Workflows（D2、D5）；其中「過期日期不執行」案例移到 schedule.test.ts（步驟 5） |
| test_linkedin_receiving.py (6) | bootstrap/ | LinkedIn Resend 接收 | 改寫：web/src/modules/collection/mail/linkedin.test.ts；步驟 9 |
| test_mail_sync_incremental.py (13) | bootstrap/ | 增量收信游標 | 改寫：web/src/modules/collection/mail/cursor.test.ts（實際測的是 resend_sync 的增量游標，見缺陷 15）；步驟 9 |
| test_optimization.py (15) | bootstrap/ | 查詢與投影效能／行為 | 改寫：依案例分到 web/src/modules/discovery（步驟 4b）、preferences（步驟 4b）、applications（步驟 11）的 *.test.ts；CLI 案例隨 cli 刪除 |
| test_proposals.py (9) | bootstrap/ | 模板與草稿 | 改寫：web/src/modules/proposals/store.test.ts；步驟 11 |
| test_relationships.py (10) | bootstrap/ | 客戶與聯絡人 | 改寫：web/src/modules/relationships/store.test.ts；步驟 11 |
| test_resend_daily.py (19) | bootstrap/ | Resend daily 流程 | 改寫：web/src/modules/collection/mail/*.test.ts（步驟 9）與 daily-workflow.test.ts（步驟 10） |
| test_server_sqlite.py (1) | bootstrap/ | 真 SQLite server | 取代：CI 的 Postgres service container 上跑 Vitest（步驟 3） |
| test_server.py (6) | bootstrap/ | LocalBoundary／server | 改寫：web/src/shared/http/guard.test.ts（Origin、body 上限、回應標頭；見計畫缺口 4）；步驟 11 |
| test_sqlite.py (21) | bootstrap/ | SQLite store、migrate、交易 | 改寫：web/src/platform/db/*.test.ts（交易、約束、trigger 案例）；migrate 案例由 Drizzle 取代；步驟 4a |
| test_storage_codec.py (3) | bootstrap/ | JSON codec | 改寫：web/src/shared/canonical-json.test.ts（HP10，spike 1c expected.json）；步驟 4b |
| test_submission_queue.py (2) | bootstrap/ | submission_v1 task | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| test_submission_runtime.py (4) | bootstrap/ | capabilities 與 enqueue | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| test_submission_transports.py (6) | bootstrap/ | Email 與 Freelancer sender | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7） |
| test_submissions.py (14) | bootstrap/ | submission 狀態機 | 延後：計畫「延後」第 1 項：Will 決定要配置 Email 或 Freelancer 通道（D7）；trigger 層的不可變測試在步驟 4a 另寫 |
| test_tracking_http.py (2) | bootstrap/ | feedback HTTP | 改寫：web/src/modules/preferences/actions.test.ts；步驟 11 |
| test_workbench_http.py (3) | bootstrap/ | workbench HTTP | 改寫：applications／relationships／proposals 的 actions.test.ts；步驟 11 |
| test_worker.py (2) | bootstrap/ | worker 鎖與 run_once | 取代：`daily_runs` claim 測試（重複觸發只跑一次，D2、D5），步驟 5 |
| collection/ 共 36 檔、312 個測試 | backend/tests/collection/ | 各來源 parser 與 connector（arbeitnow 17、cake_mail 8、chickpt 7、community_jobs 8、cryptojobslist 4、dynamitejobs 8、free_jobs 6、freelancer 17、getonboard 5、glassdoor_mail 9、gmail_auth 17、gmail_session 8、gmail_sync 14、gmail_transport 10、gmail 6、guru 6、himalayas 6、indeed_mail 4、indeed_new_mail 5、intake 3、jobbank104_mail 5、jobbank518 7、justremote 4、linkedin_mail 10、mail 8、nodesk 7、ptt_codejob 6、ptt_soho 13、public_feeds 17、resend_preview 12、resend_sync 12、source_batch 3、source_registry 5、taiwanjobs 11、talent_mail 11、tasker 13） | 改寫：web/src/modules/collection/**/*.test.ts，依來源分到步驟 6（free_jobs）、7（cryptojobslist）、8（其餘免登入）、9（mail、resend_sync）、4b（source_batch）、5（source_registry，見計畫缺口 2）；例外：gmail_* 5 檔與 intake、resend_preview 的 CLI 案例刪除（Gmail dormant），ptt_* 刪除（D12），guru、indeed_* 延後（計畫「延後」第 3 項） |
| test_discovery.py (14) | backend/tests/discovery/ | 分組、排序、投影 | 改寫：web/src/modules/discovery/rules.test.ts（分組、排序、投影）；步驟 4b |
| test_domain.py (12) | discovery/ | 資格規則（未知保持未知） | 改寫：web/src/modules/discovery/domain.test.ts（未知保持未知）；步驟 4b |
| test_ai_drafts.py (13) | backend/tests/legacy/ | 舊 AI 擬稿 | 刪除：legacy AI 擬稿不改寫（D8），只有測試呼叫 |
| test_antigravity_guard.py (10) | legacy/ | 舊 CLI 擬稿 guard | 刪除：legacy 擬稿不改寫（D8） |
| test_antigravity.py (8) | legacy/ | 舊 CLI 擬稿 | 刪除：legacy 擬稿不改寫（D8） |
| test_postgres.py (17) | legacy/ | Postgres adapter（需 `FREELANCE_TEST_DSN`，空值時跳過） | 刪除：舊 PG adapter 不改寫（D8） |
| test_review.py (11) | legacy/ | 歷史 review 與核准失效 | 改寫：web/src/modules/legacy/review.test.ts，11 個案例全部移植（D8）；步驟 11 |
| test_daily.py (11) | backend/tests/notifications/ | daily run 狀態機 | 改寫：web/src/bootstrap/daily-workflow.test.ts 與 daily-runs.test.ts；claim 案例步驟 5，其餘步驟 10 |
| test_digest.py (7) | notifications/ | 摘要渲染與 novelty | 改寫：web/src/modules/notifications/digest.test.ts（渲染與 novelty）；步驟 10 |
| test_gmail_send.py (10) | notifications/ | Gmail API 寄送 | 刪除：Gmail API 寄送 dormant（D9）；其中 MIME 建構的案例移到 web/src/modules/notifications/mime.test.ts（步驟 10） |
| test_gmail_smtp.py (5) | notifications/ | SMTP 寄送 | 改寫：web/src/modules/notifications/gmail-smtp.test.ts；步驟 10 |
| test_operations.py (3) | notifications/ | dashboard operations 投影 | 改寫：web/src/modules/notifications/operations.test.ts（dashboard operations 投影）；步驟 11 |
| test_resend_delivery.py (5) | notifications/ | Resend delivery | 刪除：D9 不用 Resend 寄送 |
| test_resend_send.py (11) | notifications/ | Resend 寄送 | 刪除：D9 不用 Resend 寄送 |

小計：bootstrap 24 檔 180 個、collection 36 檔 312 個、discovery 2 檔 26 個、legacy 5 檔 59 個、notifications 7 檔 52 個，合計 629。

Frontend：

| item | where (file:line) | what it does in one line | 去向 |
|---|---|---|---|
| contracts.ts | frontend/tests/contracts.ts | 編譯期負向測試，4 個 `@ts-expect-error` | 取代：zod 型別測試（D10），步驟 11 |
| smoke.mjs | frontend/tests/smoke.mjs（221 行，43 個 assert） | Playwright 加暫存合成 SQLite：探索、分組、版本差異、收藏／略過、偏好、投案；也驗 proxy 拒絕 `/api/review/*` | 改寫：web/e2e/smoke.spec.ts（Playwright 對合成 Postgres）；「拒絕 `/api/review/*`」改成驗該路徑不存在（404）；步驟 11 |
| workbench.mjs | frontend/tests/workbench.mjs（70 行，9 個 assert） | 客戶、提案、送出流程（route mock `**/api/**`） | 改寫：web/e2e/workbench.spec.ts（送出流程只驗「未配置」，D7）；步驟 11 |
| manual-application-load.mjs | frontend/tests/manual-application-load.mjs（23 行，2 個 assert） | 手動轉介不依賴 discovery 服務 | 改寫：web/e2e/manual-application-load.spec.ts；步驟 11 |

---

## 7. Legacy 程式碼

| item | where (file:line) | what it does in one line | 狀態 | 去向 |
|---|---|---|---|---|
| legacy/records.py | backend/src/freelance/legacy/records.py:7-59 | 舊 opportunity／proposal 列 envelope codec：new_observation、refresh、feedback_changed、save（有 proposal 時寫 proposal_revisions，:46） | **仍在 production 路徑**：collection/store.py:77-89（每次 ingest）、preferences/store.py:36（每次 feedback）、bootstrap/store.py:23,137 | 改寫：web/src/modules/legacy/records.ts（new_observation／refresh／feedback_changed／save，D8）；步驟 4b |
| review_status 欄位 | modules/discovery/ranking.py:13、modules/discovery/rules.py:51-52,160-161,181 | 探索的候選判斷與分組仍讀 envelope 裡的 legacy `review_status`（skipped／sent／delivered 會壓住候選） | **仍在 production 路徑** | 改寫：web/src/modules/discovery/rules.ts 與 ranking.ts 讀 envelope 的 `review_status`（D8）；步驟 4b |
| legacy/review_service.py | legacy/review_service.py:9（`class Legacy`） | 歷史提案審核與 tracking 統計 | 在 bootstrap/store.py:31 實例化，但 `store.review()`（:221）與 `tracking_summary()`（:223）在 src 內**沒有呼叫者**，只有測試在用 | 改寫：只移植 `review()` 的狀態轉移為純函式 web/src/modules/legacy/review.ts，承載 test_review.py 11 個案例，不建 route（D8）；`tracking_summary()` 不移植（缺陷 1）；步驟 11 |
| legacy/review.py | legacy/review.py | 舊 review 的 Conflict／InvalidAction 等 | bootstrap/cli.py:9 import 例外類別（production CLI 有依賴） | 改寫：Conflict／InvalidAction 與 ReviewStore 轉移規則併入 web/src/modules/legacy/review.ts（D8）；cli 刪除後沒有 production 依賴；步驟 11 |
| legacy/ai_drafts.py | legacy/ai_drafts.py:108（run） | 舊 AI 背景擬稿，寫 ai_draft_attempts | 只有 legacy 測試使用，src 內沒有呼叫者 | 刪除：只有 legacy 測試使用（D8） |
| legacy/ai_worker.py | legacy/ai_worker.py:5 | 退役 stub，exit 2 | 不執行任何工作 | 刪除：退役 stub（D8） |
| legacy/antigravity.py、antigravity_guard.py | legacy/antigravity*.py | 舊外部 CLI 擬稿與 deny hook | 只有 legacy 測試使用 | 刪除：只有 legacy 測試使用（D8） |
| legacy/proposals.py、portfolio.py | legacy/proposals.py:1、portfolio.py:1 | 舊提案模板與作品集事實 | 只有 ai_drafts.py:7、postgres.py:12 使用 | 刪除：只有 ai_drafts.py 與 postgres.py 使用，兩者都刪（D8） |
| legacy/postgres.py | legacy/postgres.py | PostgreSQL repository 與 migrate（001_initial.sql） | 只有 legacy CLI（scheduler_cli.py:26、mail_sync.py:129，兩者的 `--backend` 預設都是 postgres）與 legacy 測試使用；optional dep `postgres` | 刪除：只有 legacy CLI 與測試使用（D8）；optional dep `postgres` 一併移除 |
| ai_draft_attempts／proposal_revisions 表 | 001_sqlite.sql:72、:8 | 歷史 AI 嘗試與提案版本 | 只保留歷史資料；新職缺不會產生 proposal（records.save 只在 `item.proposal` 存在時寫入） | 只搬資料：兩表照 §1 的去向建表與收斂（步驟 4a、4c）；不產生新的 AI 嘗試；proposal_revisions 只在歷史列被 records.ts `save` 時追加（D8） |
| modules/proposals（新） | backend/src/freelance/modules/proposals/ | 第三階段的人工模板與草稿，**不是** legacy | production（workbench API） | 改寫：web/src/modules/proposals/（模板、草稿、不可變版本）；步驟 11 |

---

## 重跑指令

在 repo 根目錄執行：

```bash
git rev-parse --short HEAD                                   # d994cd2
rg -n -i "create table" backend/src                          # 25 (001_sqlite.sql) + 5 (001_initial.sql) + 2 (sqlite.py rebuilds)
rg -c -i "create table" backend/src
rg -n "CREATE TRIGGER" backend/src/freelance/platform/schema/001_sqlite.sql   # 6
rg -n "@(app|router|api)\.(get|post|put|patch|delete)|add_api_route|APIRouter|include_router" backend/src   # 11 + 31
python3 -c "import json;d=json.load(open('contracts/openapi.json'));print(sum(len([m for m in v if m in('get','post','patch','delete','put')]) for v in d['paths'].values()), len(d['paths']))"   # 42 32
rg -c "^class " backend/src/freelance/bootstrap/contracts.py # 62
rg -n "fetch\(|/api/" frontend/src | grep -v shared/api
rg -n -o "\b(get|create|update|delete|archive|set|append|apply|preview|prepare|approve|dispatch|cancel|reconcile)[A-Z][A-Za-z]*\(" frontend/src/features | sort -u
rg -n "contracts/api|shared/api" frontend/src frontend/tests
rg -n "__name__ *== *['\"]__main__" backend/src              # 19
sed -n '/\[project.scripts\]/,/^$/p' backend/pyproject.toml  # 4
rg -n "huey|\.task\(|periodic_task|crontab" backend/src --glob '*.py'
rg -n "claim_daily_run|finish_daily_run|claim_digest|finish_digest|status='attempted'|status='approved'|status='cancelled'" backend/src
rg -c "def test_" backend/tests | sort
rg -c "def test_" backend/tests | awk -F: '{s+=$2; n++} END {print n" files, "s" tests"}'   # 74 files, 629 tests
rg -c "assert" frontend/tests/*.mjs; rg -c "ts-expect-error" frontend/tests/contracts.ts
rg -n "freelance\.legacy" backend/src/freelance/bootstrap backend/src/freelance/modules backend/src/freelance/platform
rg -n "records\.(save|new_observation|feedback_changed|refresh|insert)" backend/src
rg -n "\.review\(|tracking_summary" backend/src             # only definitions in bootstrap/store.py
```

---

## 計畫缺口

下列列已填 `改寫` 並指向最接近的步驟，但計畫的步驟範圍沒有明寫。步驟 2 不改計畫，由 Will 決定是否補進對應步驟。

1. **Neon 正式 branch 的 migration 執行時點。** 步驟 4a 只寫「版本化 migration」，步驟 13 第 4 小步直接「跑收斂腳本到 Neon 的 prod branch」，沒有寫先跑 migration。相關列：§1b `Database.migrate()`、`遷移入口`，§4 `store --migrate`。最接近：步驟 4a（建 `pnpm db:migrate`）與步驟 13 第 4 小步（執行）。
2. **來源 registry 與啟用規則。** `source_catalog.py` 的 tasker 永遠啟用、group flag、`order` 排序，以及 D12 後不含 PTT 的清單，沒有步驟明列；步驟 4b 只列 `source_batch`／`ingest`。相關列：§6 collection 測試列的 source_registry。最接近：步驟 5（fan-out 需要來源清單）。
3. **手動寄出既有 pending intent。** `gmail_smtp_cli` 的替代（預覽 sha256、帶 expected sha256 才寄）不在步驟 10 的範圍文字裡，步驟 10 只寫寄送與「人工核對」。相關列：§4 `gmail_smtp_cli`。最接近：步驟 10。
4. **回應標頭與錯誤碼對應。** `LocalBoundary` 的 `no-store`／`nosniff` 標頭、400/403/404/409/413/415 對應（`http.py:114-130`）不在步驟 11 的範圍；步驟 11 只寫 Origin 檢查與 body 上限。相關列：§6 `test_server.py`。最接近：步驟 11。
5. **`/digest` 預覽依賴步驟 10。** 步驟 11 可以和 6–10 並行，但 `/digest` route 要用步驟 10 的摘要 render。相關列：§2 `GET /digest`。最接近：步驟 11，排在步驟 10 之後做這一條。
6. **切換時 Python 留下的 pending digest。** spike 1c 的結論要求切換前讓 pending 的 digest 清空或由 TS 重新預覽，但步驟 13 第 2 小步只檢查沒有 attempted 或 unknown。相關缺陷：12。最接近：步驟 12（演練腳本加檢查）與步驟 13 第 2 小步。

## 既有缺陷與處置

處置只有三種：**修**（附會在舊行為上失敗的回歸測試）、**接受**（附理由）、**隨改寫消失**（附步驟）。

1. **`store.review()`、`tracking_summary()` 只有測試在呼叫**（`bootstrap/store.py:221,223`；`legacy/review_service.py` 在 `:31` 實例化）。處置：隨改寫消失（步驟 11）。`tracking_summary()` 不移植；`review()` 的轉移規則只以純函式 `web/src/modules/legacy/review.ts` 移植，用來承載 D8 要求的 `test_review.py` 11 個案例，不建 route、不建 UI。
2. **proxy 的 regex 白名單是 API 的第二份登記處**（`frontend/src/app/api/[...path]/route.ts:11-22`），新增 route 要改兩處，漏改就 404。處置：隨改寫消失（步驟 11）。proxy 整個移除，server action 與 route handler 本身就是唯一登記處；`smoke.mjs` 的「拒絕 `/api/review/*`」改成驗該路徑不存在。
3. **`--backend` 預設是 postgres**（`bootstrap/mail_sync.py`、`bootstrap/scheduler_cli.py`），忘了帶參數就連舊 PG。處置：隨改寫消失（步驟 14 刪除 `backend/`）。兩支 CLI 不移植（§4）；在那之前正式路徑不呼叫它們。
4. **`backend/tests/preferences/` 是空目錄**，偏好的測試散在 bootstrap 與 discovery，模組沒有自己的測試。處置：修（步驟 4b）。`web/src/modules/preferences/` 的案例放在該模組自己的 `*.test.ts`。回歸測試：CI 加一個檢查，`web/src/modules/*/` 每個模組目錄至少有一個 `*.test.ts`；套在舊的形狀（preferences 沒有測試）會失敗。
5. **`daily_runs` 自 2026-10-16 起每天 `failed`**（部分來源失敗，信仍寄出）。處置：接受。計畫「範圍／不做」明列另開工作；比對器以 Python 的實際輸出為準。
6. **`running` 卡住沒有任何轉移**（§5b），程序中斷只能人工核對。處置：接受。這是產品規則（`AGENTS.md`：中斷的 run 不自動重試）；TS 版在步驟 10 的 recovery 頁面列出卡住的 run。
7. **himalayas、free_jobs 沒有整體 deadline**，urllib `timeout` 只限單次 socket 操作（inventory-sources §6）。處置：接受。Vercel 函式的 300 秒上限就是整體上限，每個 sync 開頭先標 failed，被殺時 health 停在 failed；spike 1e 量到每個端點都遠低於 300 秒；步驟 8 的停止條件處理超時。
8. **taiwanjobs 有 rejected 時不呼叫 `finish`**（`taiwanjobs.py:121-122`），和其他來源的 partial 映射寫法不同。處置：接受。結果一樣是 health 停在 failed、回傳 partial；比對器要求行為一致，TS 照原樣移植。
9. **各雜湊點的 `json.dumps` 參數不一致**（`ensure_ascii`、separators、`sort_keys` 共四組）。處置：接受。統一就等於換掉既有指紋，違反 D4；TS 每個點固定一組參數（spike 1c 規則 6）。
10. **`text()` 依賴執行中 CPython 的 Unicode 版本**（NFKC、casefold、isspace），升級 Python 會讓指紋漂移。處置：修（步驟 4b）。TS 用凍結的 CPython 15.1 表（`spike-1c/unicode-tables.json`）。回歸測試：`canonical-json.test.ts` 跑 spike 1c 的 `expected.json`；改用 ICU 的 `normalize('NFKC')` 或 `toLowerCase` 時會失敗（spike 1c 反向對照：705/707、695/707）。
11. **HP7 的 `application_token` 依 `ORDER BY a.id` 排序**，Postgres 預設 collation 和 SQLite BINARY 可能不同序（spike 1c 規則 9，未驗證）。處置：修（步驟 4a）。排序加 `COLLATE "C"`。回歸測試：插入兩個在 `en_US` collation 與 `C` collation 下順序相反的 id（例如只差在 `-` 位置的字串），token 必須等於 Python 期望值；拿掉 `COLLATE "C"` 時失敗。
12. **MIME 預覽 sha256 無法由 TS 重現**（spike 1c「無法重現」第 1 項），Python 建好但未寄的 pending intent 在切換後無法用舊的 expected sha256 寄出。處置：修（步驟 12）。切換演練腳本在 `digest_outbox` 有任何 `pending` 時拒絕往下走，TS 寄送只接受自己重新預覽的 sha256。回歸測試：演練腳本對含一筆 `pending` 的副本執行要 exit 非 0；寄送 action 收到與 TS 預覽不符的 sha256 要拒寄。另見計畫缺口 6。
13. **worker healthcheck 只檢查 `queue.lock` 是否被持有**（`deploy/compose.yaml:27`），不代表當天有跑。處置：隨改寫消失（步驟 5 改看 Workflows run 狀態與 `source_health`；步驟 14 刪 `deploy/`）。
14. **`submission_v1` task 一律註冊**（`bootstrap/worker.py:60-61`），沒有設定時才回 not_configured。處置：隨改寫消失（步驟 14 刪 Huey；送出改寫延後，D7）。
15. **inventory-sources §1.3 把 `bootstrap/test_mail_sync_incremental.py` 列成 Gmail 測試**，實際上它測的是 `resend_sync.sync_tasker` 的增量游標。處置：接受。事實欄步驟 2 不改；§6 的去向依程式填成步驟 9 改寫。
16. **`docs/implementation-plan.md:20` 的正式資料量是 9/28 的舊數字**（708／726，現在是 2,226／2,303）。處置：隨改寫消失（步驟 14 改寫該文件）。
17. **`DELETE /applications/{key}` 帶 JSON body**，不是常見的 HTTP 用法，proxy 與 client 都要特別處理。處置：隨改寫消失（步驟 11 改成 server action）。
18. **Gmail API 收信路徑 dormant 但程式與 6 個測試檔還在**，正式 image 沒裝 `google-auth`（inventory-sources §1.3）。處置：隨改寫消失（不移植；步驟 14 刪除 `backend/`）。
19. **registry 有 FlexJobs、Remoters、Toptal 三個只有名稱的來源**（runner=None）。處置：隨改寫消失（步驟 5 的 TS registry 只列已改寫的來源，見計畫缺口 2）。
20. **Resend 收信主迴圈只在 entry 之間檢查時間，retry 迴圈另計**（`resend_sync.py:39`，inventory-sources §6），實際可超過 `max_seconds=90`。處置：接受。最壞約 110–130 秒，低於 300 秒；TS 照原樣移植以維持比對一致。
21. **`group_items` 走訪 `identity_keys` 的 set，順序受每個行程隨機的 `PYTHONHASHSEED` 影響**（`discovery/rules.py:117`）。一筆職缺的 URL key 與內容 key 各命中一個彼此不相容的群組時，先走到的 key 決定分組；同一份資料在不同行程（API、worker、重啟後）可能分成不同群組，群組 token 也跟著不同（2026-10-24 量到：同一組三筆資料，10 個 seed 中 5 次分成一種、5 次分成另一種）。處置：修（步驟 4b）。TS 依排序後的 key 走訪（`content:` 先於 `url:`），結果固定；比對器遇到這種形狀的分組差異屬於 Python 端的不確定性，不算 TS 邏輯差異。回歸測試：`web/src/modules/discovery/discovery.test.ts` 的「grouping order when one listing bridges two incompatible groups」。
22. **公開版 Python 無法重現正式環境的 `evaluation.portfolio_ids`**：正式 VM 跑的 `d994cd2`（archive 時期）把真實作品 ID 寫在程式裡，公開 repo 改成合成值，也沒有讀私人設定的機制（2026-10-24 量到：正式副本 2,226 筆中 2,176 筆 evaluation 只差在這個欄位，對齊後 0 差異）。處置：修（步驟 4b）。TS 從 `PORTFOLIO_CATEGORY_PROJECTS`（私人 `portfolio.json` 的 `category_projects`）讀對應，沒設用合成值，格式錯誤直接失敗；步驟 5 把它放進 Vercel env。回歸測試：`discovery.test.ts` 的「portfolio ids」。
23. **`free_jobs.Text` 只呼叫 `feed()` 不呼叫 `close()`**（`free_jobs.py:28`；`himalayas.py`、`community_jobs.py` 共用），`html.parser` 留在緩衝區的尾端整段消失：沒關閉的 `<script>` 之後的文字、結尾 34 字內沒有空白或分號的 `&name`、沒有 `>` 的標籤（2026-10-24 用 3.13.15 量到）。處置：接受。描述進 receipt 雜湊與指紋，切換前與 D6 窗口內 TS 照原樣移植（`web/src/platform/py/html.ts`）；D6 後是否換 parser 一起修，見計畫步驟 14。
24. **正式映像的 Python 小版本沒有釘住**（`deploy/backend.Dockerfile` 的 `python:3.13-slim`），重建就換版本，而 `html.parser`、`fromisoformat`、`urlsplit` 在 3.13.13 與 3.13.15 之間行為不同（2026-10-24 量到）。處置：修（步驟 6）。TS 以正式映像的 3.13.15 為規格，`gen_golden.py` 不是 3.13.15 就拒跑。回歸測試：`free-jobs.test.ts` 的 golden 含 `<!-->a-->b` 等 3.13.13 會給不同結果的片段，`discovery.test.ts` 的 `fromisoformat` golden 含 `+00:00:00.5`；改回 3.13.13 的寫法會失敗。2026-10-24 Will 決定釘住：`deploy/backend.Dockerfile` 改 `python:3.13.15-slim`，下次重建正式映像才生效。
