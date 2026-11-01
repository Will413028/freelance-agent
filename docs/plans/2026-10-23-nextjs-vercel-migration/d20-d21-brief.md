# D20、D21 選項簡報 v2.1（2026-10-26；v1 審查 14 項與 v2 二審 11 項逐項處理後，交 Will 拍板）

**拍板（2026-10-26，Will）**：D21 走 REST、用免費方案（不開 Workers Paid）；之後 Will 再決定 D1 shadow 不每天收斂，只在換過去時載入一次，增量 converge 與額度成長的問題因此消失、切換後 CI 與正式同一個 Cloudflare 帳號。D20：Will 問「個人用的怎麼做比較適合」，回答 B，Will 回「好」。token 直接用現有的帳號層級 user token（不另建帳號擁有的 token）。步驟 4e 已拆成 4e1–4e5。

Repo `/Users/will/second-brain/.projects/personal/freelance-agent`（main），計畫 `docs/plans/2026-10-23-nextjs-vercel-migration.md`（D19–D21、步驟 4e、10e1、10e2），spike 結果 `spikes.md` §1f 與「1f 補充」。v1 的建議（資料層通用樂觀並行 A2、REST、增量 converge）被審查推翻的部分見文末兩張處置表。

## 前提題

- **被改的程式之後會不會被重寫、搬走或刪掉？**
  - `web/` 的儲存層（`web/src/db/client.ts` 的 `writeTransaction`／`readTransaction`、所有寫入路徑、ops 腳本）：不會再重寫。步驟 4e 本身就是這次重寫，切換（步驟 13）後就是正式儲存層。Postgres 路徑在 D1 shadow 跑滿 3 天後刪除。
  - 讀取形狀會變：10e2 把 `list`／`group`／`feedback`／`createDigestIn` 改讀投影並刪 `listIn`（全表讀取）；B2 正規化 `opportunities` 是 D6 回滾窗口結束後的終點。所以 D20 照 **10e2 之後**的讀取形狀設計。4e 到 10e2 之間，`feedback`、`track`、`replaceSettings` 在 `web/` 只有測試呼叫（UI 是步驟 11），`createDigestIn` 只在 shadow 每日執行裡跑；這段期間全表讀取只要在測試與 shadow 下正確，不必最佳化。
  - converge（`web/src/ops/converge.ts`）：切換時停用、步驟 14 刪除。它存在的必要條件是「Python 是唯一正式寫入者，shadow 每天從正式副本重來」，這個條件在切換（步驟 13，我們自己排的）時消失，所以這個排程是 SELF-IMPOSED。在它身上新寫的程式（增量 converge：依主鍵比對各表、不可改表的 drop／create trigger、帳本增量；推估一個 session 的一半，含測試），切換時 100% 丟掉。
  - D1 shadow 會跑多久（推論）：4e 上 shadow 排在 10-31 之後，之後還有 10e1、10e2、10d、11（UI）、12、13，估 4–8 週。這決定 D21 額度的答案。
- **誰會同時寫？**（讀程式得出；單一使用者是產品範圍：個人用的職缺探索工具，`AGENTS.md` 第一行）每日執行依序跑來源（`web/src/workflows/daily.ts:21` 用 `syncInOrder`，`in-order.ts`，commit `eb434e3`，Will 2026-10-24 決定），收信同步也是其中一個 step；同一天只有一個 run（`claimDailyRun` 的 `INSERT … ON CONFLICT DO NOTHING`，12:00 那班和 cron 重複觸發都被它擋下）。切換後和它並行的只有 Will 一個人的 UI 操作（回饋、track、改設定、手動投案紀錄）。ops：converge 只在 shadow、08:30；步驟 12 的反向腳本在停用 cron 後才跑。
- **帳號裡還有誰？**（量到，2026-10-26 晚）`meal-prep-production` 已在 2026-10-26 刪除（meal-prep-agent 專案頁「Cloudflare 清理」）；用 spike token 列帳號的 D1，只剩 `freelance-agent-spike-1f`。切換前 D1 上沒有正式資料：shadow、CI、spike 都不是正式環境；正式資料在切換時才上 D1，同時 shadow 停止。

## 事實

spike 1f（`spikes.md` §1f）：

- 約束或守衛失敗時，HTTP batch 整批回滾（第三句違反 UNIQUE、`changes()` 守衛、先讀前提寫進 CHECK 表、trigger `RAISE(ABORT)` 都測過）；BEGIN／COMMIT／SAVEPOINT 一律被拒（7500）。**沒測過**：回應遺失、30 秒上限、overloaded、大 batch 後段失敗。所以原子性的主張只到「約束或守衛失敗會回滾」；「送出後不知道有沒有提交」是每條寫入路徑都要扛的已知不確定。
- iad1 → D1 ENAM：單請求 p95 60–90 ms，最大 batch p95 145–640 ms。
- 同一 batch 的多條 SELECT 看到一致的資料（樣本小，和文件一致）。
- 每插入一列連同索引算 2–3 列寫入，刪一列算 1 列。

1f 補充（2026-10-26 晚，量到，`spikes.md`「1f 補充」）：

- DDL 可以放進 batch 且一起回滾：`drop trigger`、`delete`、`create trigger` 同一批成功；同樣開頭但第三句違反 UNIQUE 時，刪除回滾、trigger 仍在。
- `DROP TABLE`（990 列、一個唯一索引）`rows_written` 為 0；同樣的表用 `DELETE` 全刪是 1,000。
- D1 query 端點與 token verify 端點都不回 `Ratelimit` 標頭，從回應看不出剩餘額度。
- 正式副本相鄰兩天的差異（VM 上的每日 08:30 副本，依主鍵比對，只輸出計數）：

| 區間 | 新增 | 修改 | 刪除 | 主要的表 |
|---|---|---|---|---|
| 10-24 → 10-25 | 151 | 35 | 0 | opportunities +66／改 2、source_receipts +68、mail_ingestion +15、source_health 改 27 |
| 10-25 → 10-26 | 219 | 34 | 0 | opportunities +103／改 1、source_receipts +104、mail_ingestion +10、source_health 改 27 |

  已有的職缺幾乎不會被改寫（每天 1–2 列），正式系統每天只動約 200–250 列。

讀程式得出：

- 現行每筆職缺 3–7 個語句（讀紀錄、查 receipt 歸屬、讀設定、寫入、寫 receipt、再查歸屬）。逐句成為 REST 請求時，一批 274 筆約 820–1,900 個請求，超過每 5 分鐘 1,200。freelancer、himalayas、free-jobs、community-jobs 目前是每筆各一個交易（例：`freelancer.ts:165`），其他來源用 `sourceBatch` 整批一個交易。
- 各來源先抓網路、再進 `sourceBatch`（例：`cryptojobslist.ts:128-130`、`public-feeds.ts:184-185`），交易內只有讀 DB、計算、寫入。4e 要逐來源確認沒有例外。
- `track` 經 `feedbackChanged`（`legacy/records.ts:45-53`）改寫整份 `opportunities.item`；收案也改寫同一欄。`tracking_events` 有 `unique(opportunity_id, revision)`。
- 所有 workflow step 都是 `maxRetries = 0`（`daily.ts`），而且 Workflow SDK 說 step 本體可能被重送而跑兩次（10c 實作狀態）。

## 寫入路徑分類（照 10e2 之後的讀取形狀）

| 類別 | 路徑 | D1 上的做法 | 需要鎖或守衛嗎 |
|---|---|---|---|
| 1 單一條件語句 | `claimDailyRun`、`finishDailyRun`、`claimDigest`、`finishDigest`、`recordMail`、`saveMailState`、`setSourceHealthIn` | 原樣一條語句 | 不需要：D1 每條語句單執行緒、原子 |
| 1' 比對版本後改一列 | `replaceSettings`（不含投影重算） | `UPDATE … WHERE id = 1 AND revision = ?`，後接 `changes()` 守衛 | 不需要額外的鎖；但 10e1 之後它要在同一批重算整份投影，所以實際歸第 3 類 |
| 2 點讀後改寫 | `track`；10e2 之後的 `feedback`（D18 單一成員：讀一筆投影、它的 tracking、內容版本、投案 token，比對 token 後寫 tracking、`tracking_events`、`opportunities.item`、該筆投影） | 一個讀取 batch、一個寫入 batch | 需要：`opportunities.item` 會被收案同時改寫（遺失更新）；內容版本與投案 token 會被收案或投案改變 |
| 3 大範圍讀取後寫入 | 來源批次收案（讀整個來源的現有紀錄與 receipt 歸屬、設定；寫 N 筆職缺、receipt、健康狀態、10e1 投影）；`ingestResendBatch`（每封信幾筆）；改設定的整份投影重算（讀全部職缺）；`createDigestIn`（讀候選與已通知帳本，只新增 outbox 與帳本列） | 讀取 batch（每 100 個參數一句，同一請求）→ 記憶體計算 → 寫入 batch | 收案與投影重算需要；`createDigestIn` 不需要（理由見 D20 共同基礎第 4 點） |
| 4 ops，不和產品並行 | 帳本回填（converge、replay）、converge、反向腳本 | 各自的 batch | 不需要：時間上錯開（08:30、停用 cron 後） |

真正會發生的競爭只有一種：Will 的 UI 寫入和每日執行同時跑（例如 09:00 那個小時內按回饋）。具體的錯：(R1) 收案和 `track` 都改寫同一筆 `opportunities.item`，後寫的蓋掉先寫的；(R2) 改設定的整份重算和收案的單筆投影維護交錯，留下用舊設定算的投影列（讀取時比對 settings revision 會丟錯，不會默默錯，但清單會壞到下次重算）；(R3) 回饋的 token 檢查之後、寫入之前，收案寫進新內容版本，回饋被套到 Will 沒看過的內容上（token 就是為了擋這個）。

## D20 取代全域寫入鎖

- **業界基準**：沒有互動式交易時，跨多個讀取的「讀、比對、再寫」有兩種標準做法，看競爭程度選：
  - 樂觀並行（OCC），以聚合為單位帶版本：寫入帶「我讀到的版本」條件，不符整批失敗、重讀重試（DDD 的 aggregate version、JPA `@Version`／Rails `lock_version`、DynamoDB ConditionExpression、HTTP ETag／If-Match）。寫入者多、衝突少時的預設。
  - 租約加 fencing token：取得一個有到期時間的租約，每次取得時 token 加一；儲存端在同一個原子寫入裡檢查 token 仍是自己的才接受（Chubby 的 sequencer；Kleppmann 2016〈How to do distributed locking〉；Kubernetes Lease、DynamoDB Lock Client 是租約部分）。正確性只靠「儲存端原子地檢查 token」，不靠時鐘或租約沒過期；適合低競爭、臨界區跨多次讀取的批次工作。
- **現有機制為何存在**：Python 用 SQLite `BEGIN IMMEDIATE` 保證單一寫入者，TS 用 `pg_advisory_xact_lock` 照搬；收案、回饋與 token 檢查都是「讀、比對、再寫」，正確性假設中間沒有別的寫入者（`client.ts:38-43` 的註解）。
- **兩個選項都需要的共同基礎**（不論選哪個都要做）：
  1. 每個第 2、3 類單元改成「讀取 batch → 記憶體計算 → 一個寫入 batch」。必要條件：REST 每 5 分鐘 1,200 請求（逐句移植會超過），以及沒有交易時多次寫入會在中途留下一半。寫入 batch 只送記憶體裡標成有變的列（現行 `refreshRecord` 只在評估或審核狀態變了才存，`records.ts:71`，照舊）。做決定用的讀取都在這個讀取 batch 裡；租約外的預讀（例如收信同步在進單元前的 `existingSourceIds`，`mail/sync.ts:34`）只能用來決定要抓哪些網路資料，單元內重讀後再決定。單一來源的寫入超過一個請求的上限時（上限 4e 量；spike 274 筆、約 1 MB 一個請求沒出錯）分批：每批自帶該批職缺的 receipt 與投影列，健康狀態放最後一批；中途斷掉時已提交的批各自一致、健康狀態仍是舊值，重跑同一批職缺是冪等的（已存在的職缺走 refresh）。
  2. 同一單元裡後面的讀取要看得到前面尚未送出的寫入（同一來源批次裡重複的 `external_id`、receipt 歸屬）：單元內用一層記憶體疊加（unit of work 加 identity map，Fowler PoEAA），路徑程式經這組函式讀寫、不直接下 SQL：`getRecord`、`existingIds`、`recordsForSource`、`receiptOwner`（含 `ingestIn` 在 `ON CONFLICT DO NOTHING` 之後的再查一次，`ingest.ts:62-63`）、`readSettings`、`insertRecord`、`saveRecord`（含 `proposal_revisions`，`records.ts:59`）、`insertReceipt`、`mail_content_versions` 的讀與寫（`ingestResendBatch` 用 `.returning()` 的筆數算新版本數，`ingest.ts:160-167`）、tracking 的讀寫。寫入的結果（`returning` 筆數、衝突後的歸屬）由疊加層預測；這個預測只在沒有別人同時寫的前提下正確，也就是要在鎖或守衛之下。
  3. 原子單位的改變：freelancer、himalayas、free-jobs、community-jobs 從「每筆一個交易」變成「整個來源一個 batch」，中間一筆出錯時前面的不再留下。列為已接受的 shadow 差異（D17）。
  4. `createDigestIn` 的計算與寫入不進鎖：它只新增當天的 outbox 與帳本列，唯一會和它衝突的是同一天另一份摘要，由 `UNIQUE(local_date, recipient)` 擋下：寫入 batch 因唯一鍵失敗時，重讀既有的那份回傳（等同現在「已有就原樣回傳」，`services/digest.ts:13-16`；step 本體被重送跑兩次時兩份都拿到同一份，不會把 run 記成 failed）。它的讀取若在一個 batch 內就是一致的快照，和一個回饋並行時等同「摘要先、回饋後」的順序。讀取超過一個請求時（10e2 之後讀整份投影約 2.25 MB，D18 補充量到；能否一個請求讀完未量），讀取階段要取鎖（選 B）或帶全域版本守衛（選 A）。
  5. 程式內有上限地重試：守衛失敗（Conflict）時重讀、重算、重送，最多 3 次、退避 0.2／0.5／1 秒加抖動；用完時收案記成該來源失敗（`source_unavailable`），UI 回 409「請重新載入」。不靠 step 重跑（`maxRetries = 0`；產品規則「中斷的 run 不自動重試」指的是 run 本身與不確定的寄送，不是單元內被守衛擋下、確定沒提交的寫入）。
  6. 結果不明（逾時、連線中斷、5xx）：不假設已回滾。每個寫入 batch 帶一個隨機 attempt id，batch 最後一句寫進 D1 專屬的 `write_attempts(attempt_id primary key, at)`。讀它之前要先確定原請求之後不可能再提交（在途的請求可能晚一步執行）：選 B 時先重新取得租約（token 加一），再在同一個讀取 batch 讀 `write_attempts`——token 已換，舊請求之後就算執行也會被守衛擋下，所以「有就是已提交、沒有就是不會再提交」；選 A 時要等過 D1 單查詢的 30 秒上限再讀。第 1 類語句照現有語意：`claimDigest` 結果不明就當作可能已 claim、不寄（10c 規則），`finishDailyRun` 讀回狀態。`write_attempts` 不在 `TABLES` 裡，反向腳本不碰；保留 7 天。
- **選項**：
  - **A 聚合版本的樂觀並行**：D1 專屬旁表 `row_rev(aggregate, id, rev)`，由 trigger 在 `opportunities`、`opportunity_tracking`、`tracking_events`、`mail_content_versions`、`source_receipts`、投案相關表、投影表的每次寫入時把該職缺的 rev 加一；設定用既有的 `revision` 欄。單元讀取時一起讀 rev，寫入 batch 開頭加守衛 `insert into guard select count(*) from row_rev where (aggregate, id, rev) in (values …)`，期望值等於筆數（每個聚合 2 個參數，一句約 45 個聚合）。新增的列靠主鍵或唯一鍵自己擋。改設定的整份重算讀了全部職缺，逐筆守衛等於 2,400 個聚合，所以改用一個全域計數 `row_rev('all', '')`（任何職缺寫入都加一）：等於一個樂觀的全域鎖。`item` 裡的 `version` 不能當版本（`refreshRecord` 存檔不加版本），D1 沒有雜湊函式，`item = ?` 比整份 3.6 KB 只適合單列。正確性條件：每條路徑做決定時讀到的每個輸入都被某個聚合的 rev 涵蓋，而且這些表的每次寫入都有 trigger 加 rev。漏一個就是默默的遺失更新，正是鎖要擋的錯。
  - **B 租約加 fencing token**：D1 專屬的一列 `writer_lease(id = 1, holder, token, expires_at)`。單元的第一個請求就是讀取 batch，開頭一句 `UPDATE writer_lease SET holder = ?, token = token + 1, expires_at = unixepoch() + 30 WHERE id = 1 AND (holder IS NULL OR expires_at < unixepoch()) RETURNING token`，後面接這個單元的讀取；沒拿到租約就丟掉讀到的結果、退避再試。寫入 batch 開頭一句守衛 `holder = ? AND token = ?`（只比 token 不夠：釋放只清 holder，釋放後重送的 batch 會通過）並把 `expires_at` 延長 30 秒（分批寫入時每批續期），最後一句釋放（`holder = NULL WHERE holder = ? AND token = ?`）。同一個持有者可以重新取得自己的租約（條件加 `OR holder = ?`，token 照樣加一），結果不明時就靠它（共同基礎第 6 點）。時間用 D1 自己的時鐘（只有一個時鐘）；就算持有者暫停到租約過期、別人拿走了，它的寫入也會被守衛擋下，不會蓋掉別人。
    - 等租約的上限：每日執行的單元最多等 35 秒（租約 30 秒加 5 秒），持有者當掉時下一個來源等到租約過期後照常取得，只慢不失敗；超過才記成該來源失敗。UI 最多等 5 秒，之後回 409「系統忙碌，請稍後再試」。這是單元內有上限的等待，和 4e client 規格的「429、overloaded、每日額度錯誤不在 step 內等待」是兩件事，4e 規格要一併寫清楚。
    - ops（converge、replay 的帳本回填）寫的也是這些表：一樣走租約（converge 開頭取、結束放），不在 client 留豁免口；`writer_lease`、`write_attempts` 是 D1 專屬表，不在 converge 刪除重建的範圍。
    - 正確性條件：(1) 每個會寫第 2、3 類表的 batch 都以守衛開頭：D1 client 結構性保證（沒有租約時寫這些表就丟錯；本機 proxy 也擋），不靠每條路徑記得；(2) 做決定用的讀取都在取得租約之後：client 只在租約物件上提供讀取，但路徑若拿租約外讀到的資料做決定，測試擋不到，靠審查與共同基礎第 1 點的規則。
- **對等比較**：

| | A 聚合版本 | B 租約加 fencing |
|---|---|---|
| 正確性靠什麼 | 做決定的讀取都在讀 rev 的那個 batch 裡、每個讀取都有 rev 涵蓋、每張子表都有 trigger | 做決定的讀取都在取得租約之後、每個寫入 batch 以守衛開頭（後者 client 一處強制） |
| 每單元請求數 | 2（讀＋寫） | 2（取得租約＋讀、守衛＋寫＋釋放） |
| 守衛大小 | 每個聚合 2 個參數；收案 274 筆約 6 句 | 1 句 |
| 大範圍讀取（設定重算） | 退化成全域計數，等同樂觀的全域鎖 | 同一把租約 |
| 漏寫時的後果 | 漏 rev 涵蓋或漏 trigger：默默的遺失更新 | 漏守衛：client 丟錯，測試會紅；讀取放在租約外：默默的遺失更新（和 A 一樣） |
| 競爭時 | 一方重試 | 另一方等；持有時間是一次讀取＋計算＋一次寫入（約 0.2–1 秒；設定重算待量） |
| 持有者當掉 | 無影響 | 其他寫入等到租約過期（最多 30 秒），只慢不失敗 |
| 改動量 | 旁表、約 8 個 trigger、每條路徑組守衛、mutation 逐 trigger 逐路徑 | 一張表、client 包裝；路徑仍是「讀、比對、再寫」，4e 既有的「拿掉鎖測試要紅」照用 |

- **建議 B**，範圍限在第 2、3 類會寫的表（`opportunities`、`proposal_revisions`、`source_receipts`、`mail_content_versions`、`opportunity_tracking`、`tracking_events`、`discovery_settings`、投影表、投案相關表）；第 1 類語句與 `createDigestIn` 的寫入不進租約。理由：實際競爭只有一個人對一個依序執行的 run；兩者都要求做決定的讀取在保護之內，但 B 另外只多一個 client 能強制的條件，A 另外要逐路徑列出讀取集合、逐表維護 trigger，漏一個就默默出錯，而且 A 在設定重算這條路上本來就退化成全域計數。v1 用「B 會把並行的 25 個來源序列化」否決 B，前提是錯的（來源本來就依序跑）。
- **終點與觸發**：終點是 A（聚合版本）。觸發條件任一成立時改：重新讓來源並行、有第二個使用者或對外 API；或每日執行記錄的租約等待（`daily_runs.result` 頂層 `lease_wait_ms`，和 `d1_requests` 同一處）7 天內 p95 超過 2 秒，或出現一次等租約逾時。（2026-10-26 Will 改成逐次檢查：任一次執行等租約超過 2 秒即觸發，現行條件以計畫 D20 為準。）B2 正規化（D6 窗口結束後）時重新評估。

| 限制 | 類別 | 來源 |
|---|---|---|
| D1 沒有互動式交易 | REAL | spike 1f (c) |
| REST 每 5 分鐘 1,200 請求、每條查詢 100 個參數、SQL 100 KB | REAL | Cloudflare 文件、spike 1f |
| Python 的表結構在 D6 回滾窗口內不能改（`opportunities` 不能加版本欄） | REAL：回滾時正在跑的 Python release 要讀這些表 | D6、計畫步驟 12 |
| UI 寫入者只有一個使用者 | REAL：產品範圍是個人工具 | `AGENTS.md` 第一行 |
| 每日執行依序跑來源 | SELF-IMPOSED（`eb434e3`，為了避開舊的鎖逾時）；改回並行就是終點的觸發 | `daily.ts:21`、計畫步驟 7 的「寫入鎖與 fan-out」 |
| 路徑程式寫成「讀、比對、再寫」 | SELF-IMPOSED | `web/src` |
| step 不重試（`maxRetries = 0`） | SELF-IMPOSED（中斷的 run 不自動重試是產品規則，但單元內確定沒提交的重試不違反它） | AGENTS.md、`daily.ts` |

## D21 存取路徑與額度隔離

### 存取路徑

- **業界基準**：從平台外存取託管資料庫，用官方 HTTP API，或在資料旁邊放一層自己的 API（Workers 加 binding）；給服務用的憑證不綁在個人使用者上（service account）。
- **A REST**（現在 spike 的方式）：原子性（限約束或守衛失敗）與延遲 spike 已量；每日執行約 25 個來源 × 2–4 個請求，加上 claim、收尾、收信，一次 run 約 60–120 個請求（推論）。1,200 的上限是**每個使用者**，和 Will 的 `cf` CLI、dashboard 共用；超過時這個使用者的所有 API 擋 5 分鐘，也就是正式系統會擋到 Will 的操作，反之亦然。Cloudflare 的限制表寫「Client API per user/account token 1200/5 minutes」，帳號擁有的 token 可能有自己的額度（未驗證；回應沒有 `Ratelimit` 標頭可以看）。
- **B 資料存取 Worker 代理**：binding 只綁一個資料庫，Vercel 不必持有能碰整個帳號 D1 的 token；不吃 REST 上限；binding 的 `batch()` 一樣不是互動式交易，D20 照樣需要。代價：第二個 runtime 與部署、Vercel 到 Worker 的認證；Workers Free 每請求 10 ms CPU，1 MB batch 的 JSON 解析未量（Workers Paid 是 30 秒）。最小權限的好處目前小：帳號裡只剩 freelance-agent 自己的資料庫（量到）。
- **建議 A，正式環境的 token 用帳號擁有的 token**（不綁 Will 的使用者；若限制表的意思成立，也不和 `cf` CLI 共用額度）。改 B 的觸發：任一次 429；一次每日執行的請求總數超過 600（`d1_requests` 是整個 run 的總數，拿它當尖峰 5 分鐘的保守上界）；帳號裡加入別的專案的資料庫而需要只限一個資料庫的憑證。

### 額度隔離

- **業界基準**：環境隔離用不同帳號或專案（每個環境一個帳號），一個環境的失控不會擋住另一個；副本同步用增量（依主鍵比對差異或變更擷取），不是每天全刪全載。
- **重新算的用量**（推論，用上面量到的正式列數與每列寫入係數）：

| 時期 | 寫入來源 | 每日列寫入 | 佔免費 10 萬 |
|---|---|---|---|
| 切換前（shadow） | converge 用 `DROP TABLE` 重建再全載：opportunities 2,395×3、receipts 2,475×2、帳本約 4,900×2、mail 257×2、投影約 2,400×3、小表 | 約 3.0–3.3 萬 | 30–33% |
| 切換前（shadow） | TS 每日執行（約 250 列變動＋投影＋摘要與帳本；前提是寫入 batch 只送有變的列，見 D20 共同基礎第 1 點） | 約 0.1–0.2 萬 | 1–2% |
| 切換前（shadow） | converge 中斷後重跑（4e 規定「重跑、驗證、才放行」；D1 上 converge 不再是單一交易） | 每次再 +3 萬 | +30%／次 |
| 切換前（shadow） | replay、比對器、帳本檢查（4e 規定在 VM 上對 SQLite 副本跑本機 proxy） | 0 | 0 |
| 切換前（shadow） | 每天成長：職缺約 +100、receipt +100、帳本 +110 | 每過一天約 +0.1 萬 | 約 18 天後到 50%、5 週後到 70% |
| 切換後 | 每日執行加 20 次回饋 | 約 0.2 萬 | 2% |
| 切換後 | 每改一次設定（整份投影重算） | 約 0.7 萬／次 | 7%／次 |
| 兩期 | CI 對真 D1 的整合測試 | 未量，4e 量 | — |

  其他額度（推論）：列讀取免費每天 500 萬，converge 的比對、每日執行的預讀、清單與摘要每天合計估數萬列，低於 1%；儲存空間單一資料庫 500 MB，正式副本 24.8 MB（量到，10-26 的 08:30 副本），約 5%，每天約 +0.1 MB。

  v1 的 35–45% 用的是 `DELETE` 全刪（約 1.1 萬列）加合成資料；`DROP TABLE` 不算寫入（量到），而現在的 converge 本來就是 drop schema 再載入，D1 上照搬就是 drop table。
- **影響範圍**：切換前 D1 上沒有正式資料，額度用完的代價是 shadow 少一天、CI 紅；切換後才會擋到正式系統。免費方案超過額度時，升級 Workers Paid「通常幾分鐘內」解除（Cloudflare D1 pricing FAQ）。
- **選項**：
  - (i) 增量 converge（副本同步的業界基準）：依主鍵比對、只寫有變的列；不可改的表（`digest_outbox`、帳本）用同一批「drop trigger、刪掉 shadow 自己的當天列、載入、create trigger」處理（量到可行）。每日約 0.2–0.5 萬列（推論：正式每天變動約 250 列，shadow 自己寫的列也要覆寫，再加當天摘要與帳本）。免費、額度不再成長。代價：約半個 session（含測試），程式在切換時 100% 丟掉（前提題，SELF-IMPOSED 的排程）；步驟 12 的反向腳本是寫到本機 SQLite 的全量 upsert，不共用。
  - (ii) shadow 與 CI 放另一個 Cloudflare 帳號：免費；多一個帳號與 token。切換前它只隔離「shadow、CI」和「沒有東西」；切換後真正的用處是讓 CI 不和正式資料同帳號：D1 權限只能設到帳號層級（D19 量到），CI 的 token 放在 GitHub secrets，同帳號就能寫正式資料庫。
  - (iii) Workers Paid（每月 5 美元，每月 5,000 萬列寫入，超出每百萬列 1 美元、不封鎖）：不改程式；切換前不再有成長期限，切換後 CI 或程式錯誤不會封鎖正式資料庫，變成計費。
  - (iv) converge 照現在的全刪全載，用 `DROP TABLE`：不多寫程式；約 30% 起跳、每天成長，大約 18 天後到 50%（推論）。D1 shadow 估 4–8 週，所以多半撐不到切換。
- **建議**：converge 用 drop table 重建再全載（就是現有 drop schema 的直譯，不是額外工作），D1 shadow 上線時同時開 (iii) Workers Paid，不做 (i)。這偏離副本同步的業界基準 (i)，理由不是 REAL 限制，是成本取捨：(i) 約半個 session、切換時全部丟掉，(iii) 在 4–8 週的 shadow 期約 5–10 美元、不寫程式，還一併解掉切換後「CI 或程式錯誤封鎖正式資料庫」的問題。Will 不想付費時選 (i)，不選 (iv)（多半撐不到切換）。
  - 這會改掉計畫 spike 1f 的撤回觸發（計畫步驟 1f 的「正式加 shadow 的每日列寫入估計超過帳號免費額度的 50%」）：(iii) 下額度不再是撤回 D1 的理由，改成「每月列寫入超過 5,000 萬（含額度）時檢討」；選 (i) 時觸發照舊，用 (i) 的用量算。需要 Will 一起拍板。
  - 切換後（步驟 13 前決定）：CI 的真 D1 測試資料庫放 (ii) 另一個帳號（業界基準的環境隔離；REAL：D1 token 無法限到單一資料庫，同帳號的 CI token 能寫正式資料）。正式帳號是否留在 (iii)：用 shadow 期量到的正式寫入量，7 天最大值低於 2 萬列（20%）才考慮降回免費。

| 限制 | 類別 | 來源 |
|---|---|---|
| 免費每日 10 萬列寫入、整個帳號共用、超過封鎖到 00:00 UTC | REAL | D1 pricing、limits |
| D1 權限只能設到帳號層級 | REAL | D19（`cf user tokens permission-groups list`） |
| REST 上限以使用者計，和 `cf` CLI、dashboard 共用 | REAL | Cloudflare API rate limits |
| converge 切換時停用、步驟 14 刪除 | SELF-IMPOSED（我們排的步驟 13；它讓 (i) 的程式變成丟棄品，是成本取捨的依據，不是硬限制） | 計畫步驟 13、14 |
| converge 全刪全載 | SELF-IMPOSED | `web/src/ops/converge.ts` |

## 仍不確定

- REST batch 的語句數與 body 上限、回應大小上限（spike 到 75 句、約 1 MB 沒出錯）；4e 到 10e2 之間 `createDigestIn` 全表讀取約 8.6 MB、10e2 之後讀整份投影約 2.25 MB，能否一個請求讀完。
- Workflow SDK 重送 step 本體時，兩份會不會同時跑（影響等租約與摘要唯一鍵的情境有多常見；兩者的正確性不靠它）。
- 投影表每列算幾列寫入（表結構與索引 4e／10e1 才定，用量表用 3）。
- 帳號擁有的 token 是否有獨立的 1,200 額度。
- 結果不明的提交實際多常見（`write_attempts` 是保險，不是量到的需求）。
- 改設定時整份投影重算的持有時間（讀全部職缺＋計算＋75 句寫入）。
- CI 一次整合測試的列寫入。

## v1 審查結果的處置（2026-10-26，fresh subagent 14 項）

| # | 嚴重度 | 審查意見（摘要） | 處置 |
|---|---|---|---|
| 1 | HIGH | 25 個來源其實依序跑（`syncInOrder`），B 被否決的理由不成立 | 改：前提題寫明並行寫入者；B 的否決理由刪除，改為建議 B |
| 2 | HIGH | B 漏了業界基準（租約加 fencing），要和 A2 對等比較 | 改：補 Chubby、Kleppmann、Kubernetes Lease；加對等比較表 |
| 3 | HIGH | A2 擋不住全表讀、幻讀、大量假衝突 | 改：A2（對所有讀過的列加守衛）撤下，A 改成聚合版本；大範圍讀取另外處理（設定重算用全域計數；`createDigestIn` 靠一致快照與唯一鍵） |
| 4 | HIGH | 沒按路徑類型分 | 改：新增寫入路徑分類表 |
| 5 | HIGH | 前提題漏了 10e2 的讀取形狀 | 改：前提題寫明照 10e2 之後設計，4e 到 10e2 之間的過渡只求正確 |
| 6 | MED | 「回 Conflict 讓 step 重跑」錯，step 都是 `maxRetries = 0` | 改：共同基礎第 5、6 點（程式內有上限重試、結果不明用 `write_attempts` 判斷） |
| 7 | MED | 同一批內後面的職缺依賴前面的寫入 | 改：共同基礎第 2 點（記憶體疊加） |
| 8 | MED | 較便宜的守衛：D1 專屬旁表；缺 version 欄是 SELF-IMPOSED，REAL 的只有不改 Python 的表 | 改：A 用 `row_rev` 旁表；限制表改寫 |
| 9 | MED | 原子性證據的範圍太寬 | 改：事實段限縮成「約束或守衛失敗會回滾」，結果不明列為已知不確定；另補量 DDL 在 batch 內的回滾 |
| 10 | MED | 1,200 是每個使用者，和 `cf` CLI 共用；觸發要看尖峰 5 分鐘；帳號擁有的 token 可能另計 | 改：存取路徑段改寫；建議正式用帳號擁有的 token；觸發改成尖峰 5 分鐘 |
| 11 | MED | D21-B 低估：binding 只綁一個資料庫；Workers Free 10 ms CPU 未量 | 改：B 的優缺點補上；另量到 `meal-prep-production` 已刪、帳號只剩本專案的資料庫，所以最小權限的好處目前小 |
| 12 | MED | 增量 converge 偏弱；差異量是猜的；Workers Paid 應列為正式候選 | 改：量了相鄰兩天副本的差異；不可改的表用同一批 drop／create trigger（量到可行）；但因 converge 切換時刪除，不建議 (i)；(iii) 列為正式選項與觸發後的升級；改用 drop table（量到不算寫入） |
| 13 | MED | 額度帳漏了切換後的寫入與 CI | 改：用量表分切換前後，含設定重算與 CI（CI 待量） |
| 14 | MED | 請求數修正；freelancer 每筆一個交易，批次化會改變原子單位；多個讀取可放同一 batch | 改：事實段改成 820–1,900；共同基礎第 3 點列為已接受差異；讀取 batch 寫進共同基礎第 1 點 |

## v2 二審結果的處置（2026-10-26，fresh subagent 11 項）

| # | 嚴重度 | 審查意見（摘要） | 處置 |
|---|---|---|---|
| 1 | HIGH | 「converge 切換時刪除」依定義是 SELF-IMPOSED；沒換算工作量、沒估 shadow 天數；計畫 1f 的 50% 撤回觸發被悄悄換掉 | 改：前提題與限制表改標 SELF-IMPOSED，補工作量（約半個 session）與 shadow 天數（4–8 週，推論）；建議改成 D1 shadow 上線時開 Workers Paid，明寫偏離基準 (i) 是成本取捨；明列要改的 1f 撤回觸發，請 Will 一起拍板 |
| 2 | MED | 守衛只比 token，釋放後重送會通過；「沒有＝沒提交」在途請求會晚一步提交 | 改：守衛改 `holder AND token`；結果不明時先重新取得自己的租約（token 加一）再讀 `write_attempts`，舊請求之後必被擋；選 A 時等過 30 秒 |
| 3 | MED | 等租約沒有上限規格，和 4e「不在 step 內等待」衝突 | 改：每日執行單元最多等 35 秒、UI 5 秒；持有者當掉時下一個來源只慢不失敗；註明和 4e 的 429 規格是兩件事，4e 一併寫清楚 |
| 4 | MED | B 也擋不了「做決定的讀取在租約外」，ops 寫的就是被守衛的表 | 改：比較表兩欄對稱寫出；B 的正確性條件補第 2 條；ops 也走租約、不留豁免口 |
| 5 | MED | 疊加層函式清單不完整，漏 `proposal_revisions` | 改：清單補 `existingIds`、`recordsForSource`、再查歸屬、`mail_content_versions` 與 `returning` 筆數、tracking；寫入結果由疊加層預測、只在保護下正確；被守衛的表補 `proposal_revisions` |
| 6 | MED | 分批寫入失去原子性、租約不續期；10e2 後 2.25 MB 讀取也未量 | 改：分批規則（每批自帶 receipt 與投影、健康狀態最後、重跑冪等）、每個寫入 batch 續期；2.25 MB 列入仍不確定與共同基礎第 4 點 |
| 7 | MED | 用量表漏 replay／compare、converge 重跑、列讀取、儲存 | 改：用量表補 converge 重跑（+3 萬／次）、replay 等在 VM 上（0）；另補列讀取與儲存的推論 |
| 8 | LOW | 改靠 UNIQUE 後，step 重送時第二份會丟錯、run 記成 failed | 改：唯一鍵失敗時重讀既有的那份回傳 |
| 9 | LOW | 「事實，但是我們的設計」是定義外的第三類 | 改：拆成「單一使用者」REAL、「依序執行」SELF-IMPOSED |
| 10 | LOW | `d1_requests` 換算不出尖峰 5 分鐘 | 改：觸發改成「一次 run 的總數超過 600」當保守上界 |
| 11 | LOW | 「約 250 列」的前提是只寫有變的列 | 改：寫成共同基礎第 1 點的規格（照 `refreshRecord` 現行語意），用量表註明 |
