# 來源與收集機制盤點（Next.js／Vercel 改寫用）

日期：2026-10-23。基準 commit：`d994cd2`（`git -C <repo> rev-parse --short HEAD` 實測）。唯讀盤點，舊 Python 系統即規格。

證據標記：**[量]** = 本次指令實測；**[讀]** = 讀程式碼／文件得出；**[推]** = 推論，未執行驗證。正式啟用狀態一律引用 `docs/platform-connectivity.md`（2026-10-01 正式核對，本次未連 VM、未查正式 DB），不是本次觀測。

## 0. 摘要

- 有 runner 的來源 28 個 + 有模組但 runner=None 的 Guru 1 個 = 盤點 29 列 [讀 `source_catalog.py:13-46`]。registry 另有 FlexJobs／Remoters／Toptal 三個只有名稱、沒有模組（runner=None），不列入。
- 存取類型（29 列）：public API 10、RSS 5（NoDesk 為 RSS+HTML 詳情頁）、HTML scrape 7（其中 Guru 未啟用）、Resend Receiving mail 7、Gmail API mail 0 個獨立來源（只有 Tasker 的舊替代路徑，見 §1.3）。
- 正式啟用（依 platform-connectivity）：27 個 = 21 ok + 5 partial（Freelancer、Remote OK、WWR、台灣就業通、Arbeitnow）+ 1 waiting（Glassdoor）。未啟用：Indeed（離線 parser 能力，未接每日入口）、Guru（challenge 擋下，runner=None）。
- 所有 connector 只用 Python 標準函式庫；第三方套件只出現在 API 框架、Huey、Gmail OAuth（選用 extra）與 legacy Postgres。
- 單一來源都有程式碼層級的時間上限，個別都可能放進 300s function；但 daily 是**依序**跑全部來源再建摘要，總和最壞情況遠超 300s（§6）。

## 1. 來源 connector 清單

欄位說明：auth 只寫名稱；LOC 為 `wc -l`；測試數為 `grep -cE '^\s+def test_'`（只計 class 內方法，共用測試檔會重複列出）；去向 在步驟 2 填寫，格式與檢查見 `check_inventory.py`。

### 1.1 Public API／RSS／HTML（免登入）

| source id | file | access type | auth | 非 stdlib | LOC | 測試檔（數） | 正式啟用 | 特殊語意 | 去向 |
|---|---|---|---|---|---|---|---|---|---|
| freelancer | `collection/freelancer.py` | public API（官方 projects/active，JSON） | none | 無 | 121 | `test_freelancer.py`（17） | yes（partial：1636筆/23頁、limited=true） | 3 個固定 query（:12）；offset 分頁 limit=100、每 query max_pages=20、max_seconds=30（:42,:101-108）；同 ID 同時間不同內容 → 整批失敗（:83-84）；offset≥total 時以實際不重複數判 limited（:90-95）；無新 ID 停止；TITLE_SIGNAL／OUT_OF_SCOPE 標題過濾 + score>0（:110-113）；ID=`project.id`，receipt=`freelancer:{id}:{time_updated}`；不用 source_batch，逐筆 `store.ingest` | 改寫：web/src/modules/collection/sources/freelancer.ts（有分頁與時間上限、partial 映射）；步驟 8 最後一批，2026-10-25 程式完成、未排程 |
| jobicy | `collection/free_jobs.py` | public API（JSON） | none | 無 | 80（與 remotive 共用） | `test_free_jobs.py`（6，共用） | yes（ok） | 單次 GET、上限 200 筆／8MB（:56-68）；只收 kind=contract；ID=`id`，receipt=內容 sha256；geo 為 US/UK/EU 等才判 taiwan_eligible=False，其餘保留 None（:38-41）；不用 source_batch；health 直接設 ok（:77） | 改寫：web/src/modules/collection/sources/free-jobs.ts（與 remotive 共用）；步驟 6 試點，2026-10-24 程式完成，部署待授權 |
| remotive | `collection/free_jobs.py` | public API（JSON） | none | 無 | 同上 | 同上 | yes（ok） | 同上，endpoint `category=software-dev&limit=200`（:11） | 改寫：web/src/modules/collection/sources/free-jobs.ts（與 jobicy 共用）；步驟 6 試點，2026-10-24 程式完成，部署待授權 |
| himalayas | `collection/himalayas.py` | public API（JSON search） | none | 無 | 104 | `test_himalayas.py`（6） | yes（ok） | 4 query × 2 employment type = 8 次、各第 1 頁、每頁 ≤20（:12,:71-91）；以 `guid` 去重；**無整體 deadline**，每次 timeout=25（:79）；不用 source_batch | 改寫：web/src/modules/collection/sources/himalayas.ts；步驟 8，2026-10-25 程式完成、未排程 |
| hackernews | `collection/community_jobs.py` | public API（HN Firebase JSON） | none | 無 | 123（與 v2ex 共用） | `test_community_jobs.py`（8，共用） | yes（ok） | `whoishiring` 最近 6 篇中取 62 天內 ≤2 篇 Who is hiring／Freelancer（:94-104）；每篇前 100 則留言（:108）；ThreadPool 8 併發（:97）；90s deadline（:78） | 改寫：web/src/modules/collection/sources/community-jobs.ts（與 v2ex 共用）；步驟 8，2026-10-25 程式完成、未排程 |
| v2ex | `collection/community_jobs.py` | RSS（`/feed/outsourcing.xml`） | none | 無 | 同上 | 同上 | yes（ok） | 單一 feed，2MB 上限（:81-88） | 改寫：web/src/modules/collection/sources/community-jobs.ts（與 hackernews 共用）；步驟 8，2026-10-25 程式完成、未排程 |
| remoteok | `collection/public_feeds.py` | public API（JSON） | none | 無 | 235（4 來源共用） | `test_public_feeds.py`（17，共用） | yes（partial：1 invalid canonical URL） | MAX_ITEMS=200、8MB、25s（:20-23）；禁止 redirect（:26-28）；90 天內 + contract 才新收，既有 ID 一律更新（:220-224）；有 rejected 即 finish('failed')、status=partial（:225-231） | 改寫：web/src/modules/collection/sources/public-feeds.ts（4 來源共用）；步驟 8 |
| realworkfromanywhere | `collection/public_feeds.py` | RSS | none | 無 | 同上 | 同上 | yes（ok） | 同上；URL 須為固定 host/prefix（:122） | 改寫：web/src/modules/collection/sources/public-feeds.ts；步驟 8 |
| weworkremotely | `collection/public_feeds.py` | RSS | none | 無 | 同上 | 同上 | yes（partial：1 筆正文 >200,000 字元） | 同上 | 改寫：web/src/modules/collection/sources/public-feeds.ts；步驟 8 |
| workingnomads | `collection/public_feeds.py` | public API（JSON） | none | 無 | 同上 | 同上 | yes（ok） | 同上 | 改寫：web/src/modules/collection/sources/public-feeds.ts；步驟 8 |
| taiwanjobs | `collection/taiwanjobs.py` | public API（政府開放資料 XML webservice） | none | 無 | 125 | `test_taiwanjobs.py`（11） | yes（partial：complete_scan=false、2 拒收） | 固定 `count=1000`（:13）；45s 整體 deadline，直接操作 `response.fp.raw._sock` 逐塊讀（:85-102，Python 專屬實作）；新 ID 需 90 天內更新 + contract；有 rejected 時**不呼叫 finish**，health 停在 failed（:121-122） | 改寫：web/src/modules/collection/sources/taiwanjobs.ts（`urlopenRead` 的 45 秒整體 deadline；complete_scan／partial 映射）；步驟 8 最後一批，2026-10-25 程式完成、未排程 |
| arbeitnow | `collection/arbeitnow.py` | public API（JSON 分頁） | none | 無 | 189 | `test_arbeitnow.py`（17） | yes（partial：20頁/2451筆、truncated、pagination_consistent=false） | **primary-host pinning**：next 只接受 `www.arbeitnow.com`／`www.arbeitnow.nl`、精確 path 與 `page=N+1`，然後重建為固定 `.com` URL（:105-115）；max_pages=20、max_seconds=120、頁間 sleep 3s（:119-138）；meta.from/to/per_page 一致性檢查（:141-153）；跨頁同 ID 不同 receipt → 整批失敗（:157-160）；complete_scan 需無 next、無 rejected、分頁一致；收錄另需 score>0（:181-183） | 改寫：web/src/modules/collection/sources/arbeitnow.ts（primary-host pinning、分頁一致性）；步驟 8 最後一批，2026-10-25 程式完成、未排程 |
| getonboard | `collection/getonboard.py` | public API（JSON） | none | 無 | 110 | `test_getonboard.py`（5） | yes（ok） | 先讀 modalities taxonomy 且必須 total_pages=1（:71-73）；search 最多 10 頁 × 120（:74）；90s deadline；頁碼一致性檢查；TECH 類別 + remote + contract + 90 天 | 改寫：web/src/modules/collection/sources/getonboard.ts；步驟 8，2026-10-25 程式完成、未排程 |
| cryptojobslist | `collection/cryptojobslist.py` | RSS | none | 無 | 104 | `test_cryptojobslist.py`（4） | yes（ok） | 單一 RSS，25s deadline、timeout 15（:85-90）；拒絕 DOCTYPE／ENTITY（:71）；ID=canonical URL；receipt=內容 sha256，但 received_at=抓取時間（:66）；「contract」標籤不當僱用型態（:52） | 改寫：web/src/modules/collection/sources/cryptojobslist.ts（驗證 source_batch；2026-10-24 程式完成、未部署）；步驟 7 試點 |
| nodesk | `collection/nodesk.py` | RSS + HTML 詳情頁（JobPosting） | none | 無 | 152 | `test_nodesk.py`（7） | yes（ok） | RSS 只取前 20 筆、超過記 truncated（:48,:57）；90 天內才讀詳情，每頁 sleep 1s（:131）；ID=URL | 改寫：web/src/modules/collection/sources/nodesk.ts（共用 `sources/job-pages.ts`）；步驟 8 第 3 批，2026-10-25 程式完成、未排程 |
| ptt_soho | `collection/ptt_soho.py` | HTML scrape | none | 無 | 167 | `test_ptt_soho.py`（13） | yes（ok） | 2 個 index 頁 + 最多 20 篇文章（:132-140）；請求間隔 ≥1s；**closure-only 更新**：已結案標題只更新既有 ID 為 listing_closed（:139,:154-158）；新文分類為「其他」不收 | 刪除：D12 切換後停用（Vercel 出口 403 challenge，spike 1e）；歷史資料照 D4 搬，切換前 VM 照常跑 |
| ptt_codejob | `collection/ptt_codejob.py` | HTML scrape | none | 無 | 130 | `test_ptt_codejob.py`（6） | yes（ok） | 同 ptt_soho；另有全職／否定全職／結案正文 regex（:15-21） | 刪除：D12 切換後停用（同 ptt_soho）；歷史資料照 D4 搬 |
| justremote | `collection/justremote.py` | HTML scrape | none | 無 | 149 | `test_justremote.py`（4） | yes（ok） | index + contract/TECH 詳情頁，sleep 0.6；deadline 用完把剩餘計為 rejected（:126）；需 active/remote/90 天/TECH 證據 | 改寫：web/src/modules/collection/sources/justremote.ts（共用 `sources/job-pages.ts`）；步驟 8 第 3 批，2026-10-25 程式完成、未排程 |
| dynamitejobs | `collection/dynamitejobs.py` | HTML scrape | none | 無 | 149 | `test_dynamitejobs.py`（8） | yes（ok） | 90s deadline、每頁 timeout≤10、sleep 0.6；401/403/429 直接整批失敗（:125）；未讀完記 truncated；ID=URL path | 改寫：web/src/modules/collection/sources/dynamitejobs.ts（共用 `sources/job-pages.ts`）；步驟 8 第 3 批，2026-10-25 程式完成、未排程 |
| jobbank518 | `collection/jobbank518.py` | HTML scrape | none | 無 | 172 | `test_jobbank518.py`（7） | yes（ok；文件記為已確認空結果） | 4 個軟體分類第 1 頁（:17-18）；同 dynamitejobs 的 deadline／封鎖處理；ID=6 碼 job code | 改寫：web/src/modules/collection/sources/jobbank518.ts（iad1 回 200，spike 1e；共用 `sources/job-pages.ts`）；步驟 8 第 3 批，2026-10-25 程式完成、未排程 |
| chickpt | `collection/chickpt.py` | HTML scrape | none | 無 | 150 | `test_chickpt.py`（7） | yes（ok） | 電腦類第 1 頁；reported_total>len(urls) 記 truncated（:133-135）；ID=12 碼 job id | 改寫：web/src/modules/collection/sources/chickpt.ts（共用 `sources/job-pages.ts`）；步驟 8 第 3 批，2026-10-25 程式完成、未排程 |
| guru | `collection/guru.py` | HTML scrape | none | 無 | 156 | `test_guru.py`（6） | **no**（challenge 阻擋；registry runner=None） | 最多 10 頁 index、120s deadline（:105,:117）；SourceBlocked／401/403/429 停止並記 access_blocked | 延後：計畫「延後」第 3 項，`platform-connectivity.md` 把 Guru 改成可啟用時 |

### 1.2 Resend Receiving mail（轉寄進 Resend inbound 的通知信）

共用：`resend_sync._sync`（:39）讀 Resend Receiving API；`ReceivingClient`（`resend_preview.py:66-118`）；auth = Resend API key（`read_key(args.key_file)`，`bootstrap/jobs.py:30`）。寄件者 allowlist 在 `resend_preview.py:23-26`，主旨 gate 在 `matches()`（:121-130）。

| source id | parser file | access type | auth | 非 stdlib | LOC（parser） | 測試檔（數） | 正式啟用 | 特殊語意 | 去向 |
|---|---|---|---|---|---|---|---|---|---|
| tasker | `collection/tasker.py`（+ `mail.py`） | Resend Receiving mail | Resend API key | 無 | 112（+79） | `test_tasker.py`（13）、`test_mail.py`（8） | yes（ok） | 單一職缺模板；ID=URL 末段（:103）；receipt=`{message_id}:{id}`；**唯一不會回 waiting 的 mail 來源**（`resend_sync.py:134-136`） | 改寫：web/src/modules/collection/mail/tasker.ts（+ mail 共用解析），走 web/src/modules/collection/mail/sync.ts；步驟 9 |
| linkedin | `collection/linkedin_mail.py` | Resend Receiving mail | Resend API key | 無 | 92 | `test_linkedin_mail.py`（10）、`bootstrap/test_linkedin_receiving.py`（6） | yes（ok） | 只讀 text 正文（`resend_preview.py:154`）；行政通知／0 職缺記 processed `non_job_notification`（`resend_sync.py:67-70`）；「has been created」主旨排除；同 ID 內容不同 → 拒收 | 改寫：web/src/modules/collection/mail/linkedin.ts（含 `8943ec8` alert header 回歸案例）；步驟 9 |
| cake | `collection/cake_mail.py` | Resend Receiving mail | Resend API key | 無 | 98 | `test_cake_mail.py`（8） | yes（ok） | 主旨須含「刊登了一筆新職缺」；ID=URL；有 base64/zlib 解碼（:2-10） | 改寫：web/src/modules/collection/mail/cake.ts；步驟 9 |
| jobbank104 | `collection/jobbank104_mail.py` | Resend Receiving mail | Resend API key | 無 | 100 | `test_jobbank104_mail.py`（5） | yes（ok） | 主旨 regex `…MM/DD的配對日報，符合職缺N筆`（`resend_preview.py:128`）；卡片缺公司、缺內容或重複 ID → 整封拒收（`parse_104` 的 `MailParseError`） | 改寫：web/src/modules/collection/mail/jobbank104.ts；步驟 9 |
| talent | `collection/talent_mail.py` | Resend Receiving mail | Resend API key | 無 | 222 | `test_talent_mail.py`（11） | yes（ok） | 主旨格式 `subject_format()`；摘要卡、ID=canonical href | 改寫：web/src/modules/collection/mail/talent.ts；步驟 9 |
| glassdoor | `collection/glassdoor_mail.py` | Resend Receiving mail | Resend API key | 無 | 144 | `test_glassdoor_mail.py`（9） | **waiting**（已部署，待首封自然信） | ID=`jobListingId` query（:26-31）；卡片 ID 重複 → 整封拒收（:119） | 改寫：web/src/modules/collection/mail/glassdoor.ts（test_glassdoor_mail.py 回歸案例）；步驟 9 |
| indeed | `collection/indeed_mail.py` | Resend Receiving mail | Resend API key | 無 | 230 | `test_indeed_mail.py`（4）、`test_indeed_new_mail.py`（5） | **no**（離線能力，未接每日入口） | ID=`jk`（:107-112）；一張不支援卡片 → 整封隔離（:4-5,:194） | 延後：計畫「延後」第 3 項，`platform-connectivity.md` 把 Indeed 改成可啟用時 |

Resend 共用 mail 語意（`resend_sync.py`）：
- **增量游標**：`mail_sync_state` 存 `cursor`／`after`／`head`；遇到上次 cursor 即 complete，complete 才把 cursor 前移到 head（:90-122）。
- **上限**：每次 max_messages=20 body reads（`service.py:18`）、max_pages=20、max_seconds=90（:39）；每次 API 呼叫前 sleep 0.6、timeout 20（`resend_preview.py:80,85`）。
- **隔離**：解析失敗記 `rejected`、receipt 衝突記 `conflict`，不阻擋同頁其他好信（:56-84）；`fetch` 階段失敗則中止並保留 after，下次續讀（:62-63,:116）。
- **復原**：`retry_pending=1` 的舊信在主掃描後重讀（:124-129）；`record_mail` 只在 retry_pending=1 時覆寫（`collection/store.py:166-173`）。
- **狀態**：未 complete 或有任何非 processed 記錄 → failed；非 tasker 且從未成功處理職缺信 → waiting（:130-136）。
- **內容版本**：同 ID 新內容不覆寫，存入 `mail_content_versions`；同 receipt 不同內容 → Conflict（`collection/store.py:100-132`）。

### 1.3 Gmail API mail（舊路徑，非獨立來源）

| 路徑 | file | 狀態 | 依據 |
|---|---|---|---|
| Tasker over Gmail API | `collection/gmail.py`（85，QUERY `from:deals@tasker.com.tw newer_than:90d` :6）、`gmail_transport.py`（87）、`gmail_session.py`（79）、`gmail_auth.py`（156）、`gmail_scopes.py`（11） | **dormant** [讀+推] | registry 的 tasker runner 是 `resend_sync`（`source_catalog.py:15`）；Gmail 只由 `bootstrap/mail_sync.py`、`bootstrap/daily_cli.py` 兩個 CLI 呼叫；Docker image 用 `uv sync --locked --no-dev`（`deploy/backend.Dockerfile:8`）未裝 `gmail` extra，故正式 image 內 `google-auth` 不存在 [推] |
| 測試 | `test_gmail.py`（6）、`test_gmail_sync.py`（14）、`test_gmail_transport.py`（10）、`test_gmail_session.py`（8）、`test_gmail_auth.py`（17）、`bootstrap/test_mail_sync_incremental.py`（13） | — | auth = Google OAuth（installed-app flow，token 檔） |

## 2. 共用收集機制

| 機制 | file:line | 行為 |
|---|---|---|
| registry／啟用規則 | `collection/source_catalog.py:13-46`、`:51-62` | 32 個名稱，runner=None 不可選；tasker 永遠啟用，其餘依 group flag 或明確 `sources` 清單；依 `order` 排序 |
| 依序執行 | `collection/service.py:5-23` | 逐一 import runner 呼叫；resend 來源沒有 client 時記 failed；任一非 ok/waiting → 整體 failed |
| source_batch | `collection/store.py:41-45`、`:14-33` | 一個來源一個 DB 交易；`existing_ids`／`existing_jobs`；`ingest` 檢查 source；`finish(status)` 在同交易寫 source_health |
| ingest | `collection/store.py:56-97` | key=hash(source,external_id)；fingerprint 排除 received_at／receipt_id／evidence_ref；同 receipt 已存在則只 refresh；舊通知不覆寫新的（`observation.py:4-13`）；同 fingerprint 只 refresh；否則 evaluate 並新增 observation；receipt 屬其他 opportunity → Conflict |
| 先標 failed | 每個 sync 開頭 `set_source_health(source,'failed')`，例 `arbeitnow.py:172` | 程序中斷時 health 保留 failed，不會殘留舊 ok |
| partial 映射 | 例 `chickpt.py:146-147`、`public_feeds.py:225-231`、`taiwanjobs.py:121-123` | rejected／truncated → DB health 記 `failed`，回傳 status=`partial`；例外 → status=`failed` |
| 既有 ID 永遠更新 | 例 `public_feeds.py:222` | 已收過的 ID 即使已不符篩選也繼續 ingest（更新／結案） |
| intake 篩選 | `discovery/domain.py:78-80` | `qualify(available_hours=None, minimum_budget=0)`：個人價格／工時不在收案時丟棄 |
| qualify 規則 | `discovery/domain.py:11-75` | 分類關鍵字評分；結案、無薪、全職、過期 → excluded；未知工時／資格／時區／截止 → questions（needs_info） |
| unknown 資格保留 | `discovery/domain.py:35-39`；connector 例 `free_jobs.py:38-41` | `taiwan_eligible`／`timezone_compatible` 只有明確 False 才排除，None 一律變確認問題；不從 remote 推 worldwide |
| identity／dedup keys | `discovery/rules.py:64-78` | `url:`（https、去 fragment、保留 query）＋ `content:`（公司+標題+正文≥80字+kind+地點） |
| 跨站分組 | `discovery/rules.py:95-167` | union-find；已知條件衝突（title/company/kind/預算/工時/資格…）不合併；群組 feedback：skipped > interested > neutral |
| novelty／unseen | `discovery/rules.py:81-92`、`:170-175` | 摘要只送未見過的群組；已見 ID 出現新 fingerprint 視為變更 |
| 候選判斷 | `discovery/ranking.py:6` | `is_candidate` 決定是否進摘要 |
| 讀取設定 | `discovery/settings.py:8-29`、`discovery/rules.py:12,24-46` | 預設每週 30h、單案 TWD 3000、4 分類；evaluate 依存檔設定 |
| 偏好／feedback | `preferences/domain.py:4-53`、`preferences/store.py:22`、`discovery/service.py:59-84` | neutral/interested/skipped、stage 轉移；revision 防過期 |

## 3. 通知與排程

| 元件 | file:line | 行為 | 正式／dormant |
|---|---|---|---|
| Huey tick | `bootstrap/queue.py:10-38` | 每分鐘 periodic；台北 ≥09:00 回傳當日；task 再驗 `due_date==day`，過期觸發回 `expired_trigger`；retries=0 | 正式 [讀；compose worker `deploy/compose.yaml:19`] |
| worker 啟動補當天 | `bootstrap/worker.py:58-66` | flock 單一 worker；啟動時若已過 09:00 立即入列當天 | 正式 |
| run_once | `bootstrap/worker.py:30-34` | 已有 daily_run 就回該狀態，不重跑 | 正式 |
| claim_daily_run | `notifications/store.py:112-118` | `INSERT … ON CONFLICT DO NOTHING`，status=running；(local_date,recipient) 唯一 | 正式 |
| run_daily | `notifications/daily.py:17-98` | <09:00 not_due；claim 失敗 → already_run；同日已有 intent 則重用、不再收來源；收來源 → `daily_tick` 建 intent → 寫 HTML（O_EXCL）→ delivery；重用 snapshot 時拒絕寄送（:69-71） | 正式 |
| daily_tick | `notifications/scheduler.py:8-17` | 台北 ≥09:00 呼叫 `create_digest` | 正式 |
| 摘要建立 | `notifications/store.py:54-76` | 同日同 recipient 已有就回傳；分組→候選→排除過去 sent/attempted/unknown snapshot 的 novelty → 插入 pending outbox | 正式 |
| 摘要 HTML | `notifications/digest.py:57`（106 行） | render items／sources／counts | 正式 |
| outbox 狀態機 | `notifications/store.py:93-110` | pending →（claim）attempted → sent／unknown；finish 只接受 sent（需 receipt）或 unknown | 正式 |
| 不確定寄送不自動重試 | `notifications/scheduler.py:20-39` | sender 例外或缺 receipt → unknown；沒有 reset／retry 路徑；被殺留 attempted 需人工核對 | 正式 |
| Gmail SMTP 寄送 | `notifications/gmail_smtp.py:11-25`、`platform/gmail_smtp.py:9-26`（SMTP_SSL smtp.gmail.com:465、timeout 20） | 預覽 sha256 必須相符；snapshot 變動即拒；receipt=`smtp-accepted:{id}` | **正式** [推：`docs/implementation-history.md:437` 記每日 service 加 `--smtp-config`；`docs/design.md:230` 記「Gmail SMTP transport已用於摘要」；本次未讀 worker.json] |
| Resend 寄送（daily） | `notifications/resend_delivery.py:12-65`（`bootstrap/jobs.py:9-16` 以 `--sender` 啟用） | 先查 domains 驗自訂寄件網域，再 POST emails | dormant [推] |
| Resend 寄送（CLI） | `notifications/resend_send.py:18-70`、`bootstrap/resend_send_cli.py` | 單一 intent 手動寄送 | dormant |
| Gmail API 寄送 | `notifications/gmail_send.py:19,78-109`、`bootstrap/gmail_send_cli.py`；`daily.py:81-92` 的 `send_session_factory` | 驗 profile email 後 messages.send；`build_message` 同時被 SMTP 路徑使用（MIME 建構為正式依賴） | 送出路徑 dormant；`build_message` 正式 |
| dashboard operations | `notifications/store.py:20-52` | 最新 run＋outbox 狀態、逐來源 health | 正式（API） |

## 4. Submissions（Email／Freelancer 官方 API）

狀態：程式與部署已完成，外部通道**未配置**（`docs/design.md` 第三階段段落、`docs/platform-connectivity.md:9`）。

| file | LOC | 內容 |
|---|---|---|
| `modules/submissions/domain.py` | 80 | snapshot、revision、accepted_receipt |
| `modules/submissions/store.py` | 118 | prepared→approved→attempted→accepted/rejected/unknown／cancelled；attempted 後不可取消或重試（:62-69,:83）；reconcile 只追加證據（:101-115） |
| `modules/submissions/email.py` | 21 | 透過 `platform/gmail_smtp.open_client` 寄出 |
| `modules/submissions/freelancer.py` | 81 | 固定 host sandbox／live（:7）、禁止 redirect、timeout 20；auth = Freelancer OAuth token（名稱：`oauth_token`） |
| `bootstrap/submission_runtime.py` | 74 | 無設定 → `not_configured`；需 enabled＋verification 相符才可 dispatch（:19-33） |
| `bootstrap/submissions.py`、`submission_operations.py` | 14、24 | 執行與營運 CLI |
| 測試 | — | `bootstrap/test_submissions.py`（14）、`test_submission_transports.py`（6）、`test_submission_runtime.py`（4）、`test_submission_queue.py`（2） |

## 5. 外部相依

正式程式 import 的第三方套件（`pyproject.toml` dependencies＋extras，對照 `uv.lock` 35 個 package）。Node 對應皆為 **[推]**，未評估版本或實測。

| 套件（uv.lock 版本） | 用在哪 | 正式 image 是否安裝 | 可能的 Node/TS 對應 [推] |
|---|---|---|---|
| fastapi 0.141.1（含 starlette 1.7.0） | `bootstrap/api.py`、`bootstrap/http.py` | 是 | Next.js Route Handlers |
| pydantic 2.13.5 | `bootstrap/contracts.py` | 是 | zod（或 valibot）＋ OpenAPI 產生器 |
| uvicorn 0.54.0 | `bootstrap/api.py:5` | 是 | 不需要（Vercel runtime） |
| huey 3.4.0 | `bootstrap/queue.py:7` | 是 | Vercel Cron（Hobby 每日一次）＋ Postgres 狀態表；需要佇列時 QStash／Inngest 類服務 |
| google-auth 2.58.1、google-auth-oauthlib 1.4.1（`gmail` extra） | `collection/gmail_session.py:61-66`、`gmail_auth.py:64-69` | 否（`--no-dev` 未帶 extra，`deploy/backend.Dockerfile:8`） | googleapis／google-auth-library（若要保留 Gmail 路徑） |
| psycopg 3.3.6（`postgres` extra） | `legacy/postgres.py:8-10` | 否 | postgres.js／pg（新系統主 DB 驅動） |
| httpx2（dev group） | 測試 | 否 | — |

正式路徑上需要用 Node 對應取代的 stdlib 能力 [推]：`urllib.request`＋`NoRedirect` → `fetch(..., {redirect:'error'})`＋AbortSignal；`html.parser.HTMLParser` → 逐行移植 CPython 3.13.15 的 tokenizer（`web/src/platform/py/html.ts`；步驟 6 改：描述進 receipt 雜湊，htmlparser2／parse5 切出的文字不同）；`xml.etree.ElementTree`（含 DOCTYPE/ENTITY 拒絕）→ `web/src/platform/py/xml.ts`（saxes；步驟 7 改：fast-xml-parser 對壞 XML 寬鬆，expat 嚴格，會讓整個來源的成敗不同）；`smtplib.SMTP_SSL` → nodemailer；`sqlite3` → Postgres；`zoneinfo` → Intl／date-fns-tz；`hashlib.sha256(json.dumps(sort_keys=True))` → node:crypto＋穩定排序 JSON。**注意**：fingerprint／receipt_id 由 Python `json.dumps(sort_keys=True)` 雜湊（例 `free_jobs.py:52`、`collection/store.py:63`），預設 `ensure_ascii=True` 與部分檔案的 `ensure_ascii=False` 混用；平行比對前 TS 必須逐位元重現序列化，否則所有 receipt 都會不同 [讀+推]。

## 6. Vercel 300s 適配（單一來源 sync）

全部 **[推]**：依程式碼上限推算最壞情況，未實測耗時。urllib `timeout` 是單次 socket 操作的上限，不是整體上限，所以沒有整體 deadline 的來源（himalayas、free_jobs）在慢速傳輸時可能超過估值。不含 Postgres 寫入延遲。

| source | 程式碼上限 | 最壞估計 | 一個 300s function |
|---|---|---|---|
| freelancer | 3 query × max_seconds 30（`freelancer.py:42,101-108`）＋2×0.6s | 每個 query 30s 只限發出新請求，單次請求只限連線與每塊等待 20s（無整體上限，2 MB 慢速回應可更久）；~92s＋逐筆 ingest（2026-10-25 錄到的資料約 303 筆，推論） | 可（觸發條件見計畫步驟 8 最後一批） |
| jobicy／remotive | 單次 timeout 25（`free_jobs.py:60`） | ~25s | 可 |
| himalayas | 8 次 × timeout 25＋0.6s，無整體 deadline（`himalayas.py:79,90`） | ~205s；TS 的 `getCapped` 以 25s 限住整個請求，上界同（推論，未量），加整體 deadline 的條件見計畫步驟 8 | 可但緊 |
| hackernews | 90s deadline（`community_jobs.py:78`），8 併發 | ≤90s | 可 |
| v2ex | 同上 | ≤90s | 可 |
| public_feeds ×4 | 25s deadline（`public_feeds.py:23,34`） | ≤25s | 可 |
| taiwanjobs | 45s deadline（`taiwanjobs.py:86`） | ≤45s（TS `urlopenRead` 傳整體 deadline） | 可 |
| arbeitnow | max_seconds 120、頁間 3s（`arbeitnow.py:119-138`） | ≤120s 才發出新請求；單次只限連線與每塊等待 25s（無整體上限，8 MB 慢速回應可更久） | 可（觸發條件見計畫步驟 8 最後一批） |
| getonboard、nodesk、justremote、dynamitejobs、jobbank518、chickpt、ptt_soho、ptt_codejob | 90s deadline（見 §1 各 file:line） | ≤90s | 可 |
| cryptojobslist | 25s deadline（`cryptojobslist.py:86`） | ≤25s | 可 |
| guru（未啟用） | 120s deadline（`guru.py:105`） | ≤120s | 可 |
| Resend mail ×7 | max_seconds 90、20 body reads、每次呼叫 0.6s＋timeout 20（`resend_sync.py:39`、`resend_preview.py:80,85`）；主迴圈只在 entry 之間檢查時間，retry 迴圈另計 | ~110–130s | 可 |

整個 daily：`collect_sources` 依序跑所有來源（`collection/service.py:10-20`），再建摘要與寄送。把上表最壞值相加（7 個 mail 約 800s，加上公開來源上千秒）遠超 300s [推]。Hobby cron 每日只觸發一次，所以「一次 cron＝一個 function 跑完全部」不可行；需要每個來源一個 invocation 的 fan-out 加上 Postgres 裡的 run／claim 狀態，摘要在全部來源結束後才建。另外 sleep／pacing 也算進 function 時間。

## 7. 重跑指令

```bash
R=/Users/will/second-brain/.projects/personal/freelance-agent
git -C $R rev-parse --short HEAD
# LOC
wc -l $R/backend/src/freelance/modules/{collection,discovery,notifications,submissions,preferences}/*.py | sort -n
# 每檔測試數
for f in $R/backend/tests/{collection,notifications,discovery}/test_*.py $R/backend/tests/bootstrap/test_{submission,submissions,daily_delivery,resend_daily,mail_sync_incremental,linkedin_receiving,huey_runner,worker}*.py; do printf "%s %s\n" "$(grep -cE '^\s+def test_' $f)" "$f"; done
# registry（有 runner 的來源）
grep -nE "^\s+'[a-z0-9_]+': Source\(" $R/backend/src/freelance/modules/collection/source_catalog.py
grep -cE "^\s+'[a-z0-9_]+': Source\(" $R/backend/src/freelance/modules/collection/source_catalog.py   # 全部 32；減去下一行的 runner=None 數 = 28
grep -c ", None, None," $R/backend/src/freelance/modules/collection/source_catalog.py   # runner=None：4
# 非 stdlib import
grep -rhoE "^\s*(import|from) [a-zA-Z_][a-zA-Z0-9_]*" $R/backend/src --include='*.py' | awk '{print $2}' | sort | uniq -c | sort -rn
# 時間／分頁上限
grep -nE "deadline *= *time.monotonic|timeout=|time.sleep\(|pause\(|max_workers|max_seconds=" $R/backend/src/freelance/modules/collection/*.py
# 套件
grep -c '^name = ' $R/backend/uv.lock
grep -n "uv sync" $R/deploy/backend.Dockerfile
# 正式狀態（文件）
sed -n 7,33p $R/docs/platform-connectivity.md
```
