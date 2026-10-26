# D20、D21 選項簡報（spike 1f 之後；草稿，待 fresh subagent 審查後交 Will 拍板）

Repo `/Users/will/second-brain/.projects/personal/freelance-agent`（main），計畫 `docs/plans/2026-10-23-nextjs-vercel-migration.md`（D19–D21、步驟 4e、spike 1f），spike 結果 `docs/plans/2026-10-23-nextjs-vercel-migration/spikes.md` §1f（dad5e13）。

## 前提題

被改的是 `web/` 的整個儲存層：`web/src/db/client.ts`（`writeTransaction` 取 `pg_advisory_xact_lock`、`readTransaction` repeatable read）、所有模組的寫入路徑（`ingestIn`、`ingestResendBatch`、`feedback`／`track`、`replaceSettings`、`createDigestIn`、`claimDigest`、daily_runs claim、`recordMail`、帳本回填）、ops 腳本。沒有排定之後再重寫：步驟 4e 本身就是這次重寫，切換（步驟 13）後這就是正式儲存層。Postgres 路徑在 D1 shadow 跑滿 3 天後刪除。

## spike 1f 量到的事實（spikes.md §1f）

- HTTP batch 原子；BEGIN／COMMIT／SAVEPOINT 一律被拒；守衛語句（`changes()` 或先讀前提寫進 CHECK 表）與 trigger RAISE 都能讓整批回滾。
- iad1 → D1 ENAM：單請求 p95 60–90 ms，最大 batch p95 145–640 ms。
- 現行每筆職缺 3–7 個語句；逐句成為 REST 請求時 freelancer 一批約 900–1,900 請求，超過帳號每 5 分鐘 1,200（推論）。按來源批次「預讀＋一個寫入 batch」約 5 請求。
- 寫入列數：每插一列 2–3 列寫入（含索引），刪一列 1 列；shadow「全刪再全載」約 3.5 萬列／天，佔帳號免費 10 萬列的 35–45%（推論）；切換後 shadow 停止。
- 現行並行：每日執行把 25 個來源分成並行的 Vercel step，靠 advisory lock 一次一個寫入；使用者回饋與設定變更也會並行。

## D20 取代全域寫入鎖

- 業界基準：沒有互動式交易的 HTTP 資料存取，標準做法是樂觀並行控制——寫入帶「我讀到的版本」條件，條件不符整批失敗、呼叫端重讀重試或回 Conflict（DynamoDB ConditionExpression、HTTP ETag／If-Match、Cosmos DB ETag、ORM 的 version 欄 optimistic locking）。
- 現有機制為何存在：Python 用 SQLite `BEGIN IMMEDIATE` 保證單一寫入者，TS 用 advisory lock 照搬，因為每條路徑都是「讀、在程式裡比對、再寫」。
- 選項：
  - A1 每條路徑手寫條件：9 條路徑各自寫守衛；`opportunities` 沒有 version 欄，要用 `item = ?`（整份 3.6 KB 比對）或新增 version 欄（反向腳本剝掉）。
  - A2 通用的 unit of work（樂觀並行，做在資料層）：讀取時記下每個讀過的列（表、主鍵、讀到的值或「不存在」），提交時在寫入 batch 最前面自動為每個讀過的列加守衛（值仍相同、或仍不存在），失敗就回 Conflict 讓 step 重跑或回報。路徑程式維持「讀、比對、再寫」，只是讀寫都經 unit of work。
  - B 租約鎖：D1 一列 `writer_lock(holder, expires_at)`；開始前條件式 UPDATE 取得租約，每個寫入 batch 最前面加守衛「租約仍是我的且未過期」。路徑程式不用改語意。代價：持鎖期間其他寫入者等待或失敗（每次寫入 batch 0.1–0.6 秒，持鎖時間小）；租約過期時間的選擇；呼叫端要重試取鎖。
- 建議：A2（業界基準，做成通用機制，不靠每條路徑記得寫條件）。B 可以當 A2 的暫時替代嗎？可以但不建議：它保留了「全域單一寫入者」，在每日並行 step 下會把 25 個來源序列化，還多一個過期時間的參數要調。

| 限制 | 類別 | 來源 |
|---|---|---|
| D1 沒有互動式交易 | REAL | spike 1f (c) |
| 每 5 分鐘 1,200 請求、每查詢 100 參數 | REAL | Cloudflare 文件、spike 1f |
| 現有路徑都寫成「讀、比對、再寫」 | SELF-IMPOSED（我們的程式） | `web/src` |
| `opportunities` 沒有 version 欄 | SELF-IMPOSED，但切換前反向腳本要寫回 Python schema（REAL：D6 回滾窗口） | 計畫步驟 12 |

## D21 存取路徑與額度隔離

- 存取路徑：
  - 業界基準：從平台外存取託管資料庫，用官方 HTTP API 或在資料旁邊放一層 API（Workers + binding）。
  - A REST（現在的 spike 方式）：spike 證明原子、延遲低；限制是帳號每 5 分鐘 1,200 請求（按來源批次後約 150 請求／天）。
  - B 資料存取 Worker 代理：不吃 REST 上限、binding 的 batch 是交易；多一個 Worker 部署、認證與第二個 runtime。
  - 建議 A：REST 的兩個疑慮（原子性、延遲）spike 已排除，請求數在批次化後遠低於上限。觸發改 B：任一天出現 429，或批次化後每日請求數超過上限的 50%。
- 額度隔離（只在切換前的 shadow 期有問題）：
  - 業界基準：複本同步用增量（變更擷取或依主鍵比對差異），不是每天全刪全載。
  - (i) 增量 converge：依主鍵比對副本與 D1，只寫有變的列；每日寫入降到變動量級（推論：數百到數千列）。要寫比對程式，且步驟 12 的反向腳本本來就需要同類的差異比對。
  - (ii) shadow 放另一個 Cloudflare 帳號：免費、不動程式；多一個帳號與 token。
  - (iii) Workers Paid（每月 5 美元，每月 5,000 萬列寫入）：shadow 期付費，切換後可降回免費。
  - (iv) 維持全刪全載、接受接近 50%：任何額外寫入（重跑 converge、測試）都可能讓帳號內所有 D1 被擋到 08:00（台北）。
  - 建議 (i)：業界基準，且和步驟 12 反向腳本共用差異比對；完成前的過渡用 (iii) 或 (ii) 由 Will 選。
