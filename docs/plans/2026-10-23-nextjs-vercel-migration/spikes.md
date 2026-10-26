# Spike 紀錄（步驟 1）

日期：2026-10-23。spike 專案：Vercel `will413028s-projects/freelance-agent-spike`（Hobby），程式在 session scratchpad，不進 repo。套件：`next@16.3.5`、`workflow@5.2.3`。

## 1a 存取控管：成立

測法：先用 `vercel api /v9/projects/freelance-agent-spike -X PATCH`，送 `{"ssoProtection":{"deploymentType":"all"}}`，回應是 `{'deploymentType': 'all'}`。接著沒登入直接 curl：

```
https://freelance-agent-spike.vercel.app/ -> 302 https://vercel.com/sso-api?url=...
https://freelance-agent-spike-reo7ykmo1-will413028s-projects.vercel.app/ -> 302 https://vercel.com/sso-api?url=...
https://freelance-agent-spike.vercel.app/api/egress -> 302 https://vercel.com/sso-api?url=...
```

cron 能穿過保護：用 `vercel crons run /api/cron` 觸發，handler 會核對 `Authorization: Bearer $CRON_SECRET`。log 顯示 `/api/cron 200`，workflow run 也有建立（見 1b）。

結論：Hobby 方案也能讓正式網址只有登入 Vercel 帳號才看得到，而且 cron 照樣能觸發。

## 1b fan-out：成立

測法：用 cron 觸發一個 workflow，裡面是 27 個 `"use step"`。每個 step 睡 60 秒，id=5 故意丟一般的 `Error`。step 函式設 `fakeSource.maxRetries = 0`，workflow 用 `Promise.allSettled` 收集結果。

```
run wrun_41M5MBTJKQ90GY3W0EEBSA3CHZ  status=completed  region=sin1
startedAt 12:29:59.881Z  completedAt 12:31:05.364Z
steps: 26 "status": "completed" / 1 "status": "failed" / 27 "attempt": 1
input/output: "🔒 Encrypted"（workflowEncryptionEnabled: true）
```

結論：
- 27 個 step 平行跑，全部 65 秒跑完。
- 失敗的 step 不影響其他 step，也只跑 1 次，證明 `maxRetries = 0` 有效。
- step 的輸入輸出在 Vercel 端加密存放。「step 只傳 ID」這條不變量照樣保留，用來縮小可能外洩的資料。
- 用量（推算）：最後一個 event 的 ID 是 `evnt_…84`，所以每次 run 約 84 個 event。一個月約 2,600 個，Hobby 每月含 50,000 個（[Workflows pricing](https://vercel.com/docs/workflows/pricing)）。

## 1c 指紋相容：合成資料成立

雜湊點清單在 `spike-1c/hash-points.md`：9 個會存進資料庫的雜湊點，加 1 個存進資料庫的序列化點。各點規則與給正式實作的建議見 `spike-1c/RESULT.md`。

主 session 重跑（2026-10-23）：

```
backend/.venv/bin/python -I -B .../spike-1c/gen_expected.py   → exit 0，expected.json sha256 620ec891…02ade（與 subagent 相同）
node .../spike-1c/verify.ts                                     → TOTAL 707/707，exit 0
反向對照（SPIKE_CONTROL=…）：no-sort 640、utf16-sort 693、wrong-separators 583、js-float 516、
json-parse 668、tolower 695、utf16-length 705、raw-nfkc 705（都是 /707，每一種都會失敗）
```

結論：
- TS 能逐位元重現所有會存進資料庫的雜湊，D4-A 不用改。
- 正式實作有三條不能省的規則：讀已存 JSON 要用無損解析、key 依 code point 排序、Unicode 表凍結成 CPython 15.1 的版本。
- 寄信前算的整封 MIME 預覽 sha256 只在執行當下用、不存資料庫，所以沒有重現。切換後由 TS 自己算，不沿用 Python 算的值。
- 還沒做：用正式副本做一次性驗證，要等 Will 授權讀副本。

## 1d 寄送通道：成立

- 從 Vercel 函式用 TLS 連 `smtp.gmail.com:465`，兩個區域都收到 `220` 回應：sin1 1063 ms、iad1 21 ms。
- Resend Receiving API 連得到：不帶 key 時回 401。
- 實寄（2026-10-26，Will 授權；步驟 10c 完成後做）：spike 專案部署 `web/`（`48e4684` 之後的版本）的副本，只把 `/api/cron` 換成 1d handler：用正式程式的 `buildMessage`（沒有職缺、來源只有 `spike_1d: demo` 的合成摘要）與 `openGmail`，寄給 Gmail 帳號自己，不連 DB，只 log 計數。憑證由 Will 選擇從 VM 的正式設定檔（`gmail-smtp.json`）經管線送進 spike 的 `GMAIL_APP_PASSWORD`、`DIGEST_RECIPIENT`（Sensitive，值沒有顯示）。用 `vercel crons run /api/cron` 觸發，runtime log：

```
spike-1d {"delivery":"accepted","accepted":1,"rejected":0,"bytes":1892,"sha256":"8449612eb79c70c95737704c6c072d37f8096dbd3cf701aa1ee99fb7a4426aef","loginMs":225,"totalMs":582,"region":"iad1"}
```

  第一次觸發（12:45）handler 還沒有 log，回 200 但看不到結果，所以加 log 後再觸發一次（12:46）；信箱可能有兩封相同的合成信。之後兩個 env 從 spike 移除並重新部署，再觸發回 `{"delivery":"not_configured"}`。收件匣：Will 2026-10-26 確認收到兩封、顯示正常。

## 1e 出口與時間：只有 PTT 被擋

測法：從 Vercel 函式對每個來源的列表端點各發一次 GET，User-Agent 和 Python 版相同，逾時 25 秒。信件來源不會從 Vercel 主動連來源網站，只連 Resend，所以只測 Resend。

不是 200 的結果：

| 來源 | sin1 | iad1 | VM（oci-a1） | Mac |
|---|---|---|---|---|
| ptt_soho | 403（challenge） | 403（challenge） | 200 | 200 |
| ptt_codejob | 403（challenge） | 403（challenge） | 200 | — |
| jobbank518 | 403 | 200 | 200 | 200 |
| resend_api（不帶 key） | 401 | 401 | — | — |

其餘 19 個端點都是 200，而且沒有 challenge。最慢的是 dynamitejobs，8.5 秒（sin1）。每個請求都遠低於 300 秒。

結論：
- 換到 iad1 區域，被擋的只剩 PTT 兩個版，沒達到停止條件（3 個以上）。
- PTT 的 challenge 依規則不繞過，PTT 的去向要另外決定，見 D12。
- region 選 iad1，Neon 也選 us-east 區域。D1 原本只說「同一區」，這是在那個範圍內選定的區域。

## 1f D1 over HTTP（2026-10-26）：成立，條件是寫入要按來源批次合併

測法：spike D1 `freelance-agent-spike-1f`（ENAM）、帳號層級 token。(b)–(e)、(g)、(h) 從 Mac 直接打 REST query 端點（和地點無關的語意與列數）；(a)、(f) 從 Vercel spike 專案的 preview 部署（`VERCEL_REGION=iad1`）打同一個端點。程式在 session scratchpad，數字以下為原始輸出摘要。

- **schema**：Python 的 `001_sqlite.sql` 原樣套用成功，一次請求 35 個語句，建出 25 張表、4 個索引、6 個 trigger。
- **(a) 延遲（iad1 → D1 ENAM，ms）**：

| 請求 | n | p50 | p95 | max |
|---|---|---|---|---|
| `select 1` | 20 | 63 | 86 | 89 |
| 10 個語句的 batch | 20 | 59 | 73 | 86 |
| 100 列寫入（4 個語句、每句 100 參數） | 20 | 74 | 89 | 92 |
| 一個來源批次 274 筆（每筆 3.6 KB、upsert，11 個語句） | 10 | 178 | 258 | 258 |
| 投影重算 2,450 列（`UPDATE … FROM (VALUES …)`，75 個語句） | 10 | 110 | 638 | 638 |
| 225 KB snapshot＋110 列帳本 | 10 | 108 | 145 | 145 |

  每條語句都在 100 個綁定參數以內，沒有錯誤。成立（撤回門檻是 p95 300 ms 乘請求數不超過 150 秒）。
- **(b) HTTP batch 原子性**：`batch` 欄位與分號串接的 `sql` 兩種寫法，第三句違反 UNIQUE 時整批失敗，前兩句不留下（0 列）。成立。
- **(c) 交易語句**：單獨送 `BEGIN`、`BEGIN TRANSACTION`、`SAVEPOINT`、`COMMIT`、`ROLLBACK`，或放進 batch，全部回 7500「To execute a transaction, please use the state.storage.transaction() … instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements」。沒有互動式交易，確定。
- **(d) 條件寫入**：`UPDATE … WHERE` 不符時 `meta.changes` 為 0、請求仍成功；`INSERT … ON CONFLICT DO NOTHING RETURNING` 衝突時回 0 列、新增時回 1 列。守衛語句可以讓整批回滾：前一句影響 0 列時 `insert into guard(ok) select case when changes() = 0 then 0 else 1 end`（CHECK `ok = 1`），或先讀前提 `insert into guard(ok) select count(*) from t where id = ? and rev = ?`，兩種都讓 batch 失敗、前面寫入的標記列不留下；前提成立時整批提交。trigger 的 `RAISE(ABORT, …)` 同樣讓整批回滾。成立。
- **(e) 值的往返**：`params` 送 JSON 值。數字寫進沒有型別的欄位會存成 REAL；寫進 INTEGER 欄位時由欄位 affinity 轉回 integer。大於 2^53 的整數用字串寫入 INTEGER 欄位能精確保存（`cast(n as text)` 讀回 `9007199254740993`），用 JSON 數字寫入或讀回都會失真成 `9007199254740992`。布林值存成文字 `'true'`，要送 0／1。非 BMP 字元、U+0000、U+2028、JSON 文字逐位元相同；孤立 surrogate 讀回不同（UTF-8 帶不了，和 Python 端寫不進 golden 的已知限制同類）。條件成立：大整數一律以文字讀寫、布林送 0／1。
- **(f) 同一 batch 的多條 SELECT**：並行 15 次寫入時做 15 次「count／其他查詢／count」的 batch，0 次前後不一致。成立（樣本小；和「batch 是交易、資料庫單執行緒」的文件一致）。
- **(g) SQL 函式**：`sqlite_version()` 不可用（7500 not authorized）；`json_extract`、`json_valid`、`json`、`json_group_array`、`json_each`、`changes`、`last_insert_rowid`、`datetime`、`strftime`、`unixepoch`、`date(…, '+1 day')`、`julianday`、`coalesce`、`iif`、`lower`、`instr`、`substr`、`length`、`hex`、`printf`、`format`、`random`、`group_concat`、`typeof`、`abs`、`max`、`round`、`unicode`、`char`、`trim`、`replace` 都可用。
- **(h) 列寫入與請求數（合成的正式量級副本，Python schema）**：每插入一列，連同主鍵與唯一索引算 2–3 列寫入，刪除一列算 1 列。

| 動作 | 請求 | rows_written |
|---|---|---|
| 匯入 opportunities 2,450 筆（每筆 3.6 KB） | 10 | 7,350 |
| 匯入 source_receipts 3,000 列 | 1 | 6,000 |
| 匯入 digest_outbox 40 份（每份約 285 KB） | 3 | 120 |
| 匯入帳本 4,815 列 | 1 | 9,630 |
| 匯入 mail_ingestion 600 列 | 1 | 1,200 |
| **完整匯入合計** | 16 | 24,300 |
| 帳本重建（全刪＋重灌） | 2 | 14,445 |
| 全刪上述五張表 | 5 | 10,905 |

  換算（推論）：shadow 每日 converge 照現在「全刪再全載」約 3.5 萬列寫入，加上 10e 投影表與 tracking 等小表約再 0.5–1 萬；正式每日執行另計。只看 shadow 就佔帳號每日免費額度（10 萬列）的 35–45%，加上正式寫入會碰到撤回觸發的 50%。這只在切換前的 shadow 期成立，交 D21。
- **請求數（推論，讀 `ingestIn` 的程式）**：每筆職缺目前要 3–7 個語句（讀紀錄、查 receipt、讀設定、寫入、寫 receipt、再查 owner）。逐句變成一個 REST 請求時，freelancer 一批 274 筆約 900–1,900 個請求，超過每 5 分鐘 1,200 的帳號上限。改成每個來源批次「一次預讀（每 100 個參數一個請求）＋一個帶守衛的寫入 batch」約 5 個請求，25 個來源一天約 150 個。結論：逐句移植不可行，按來源批次合併後成立。這直接影響 D20。

結論：撤回觸發都沒成立：HTTP batch 原子、守衛可回滾、延遲遠低於門檻、值能往返（條件見 (e)）。每日列寫入在 shadow 期接近 50%，要在 D21 處理。spike 資料庫與 Vercel spike 專案在 D20、D21 拍板前保留，之後刪除。

## 1f 補充（2026-10-26 晚，D20、D21 簡報 v2 用）

- **DDL 在 batch 內**（Mac → spike D1，暫用表 `zz_a`、`zz_b`，測完已 drop）：表上有擋 DELETE 的 trigger 時，單獨 `delete` 回 `SQLITE_CONSTRAINT_TRIGGER`；同一個 batch 送 `drop trigger`、`delete`（10 列）、`create trigger` 成功；同樣開頭、第三句改成違反 UNIQUE 的 insert 時整批失敗，之後查到 990 列（第二批的刪除回滾）且 trigger 仍在。DDL 和資料寫入一起回滾。
- **列寫入**：`DROP TABLE`（990 列、一個唯一索引）`rows_written` 0；同結構 1,000 列 `DELETE FROM` 是 1,000；`CREATE TABLE` 3、`CREATE TRIGGER` 1、插 1,000 列（主鍵＋唯一索引）2,000。
- **速率標頭**：D1 query 端點、`GET /d1/database/{id}`、`/user/tokens/verify` 都不回 `Ratelimit`／`Ratelimit-Policy` 標頭，剩餘額度從回應看不到。
- **帳號內的 D1**：用 spike token 列 `GET /accounts/{id}/d1/database`，只有 `freelance-agent-spike-1f`；`meal-prep-production` 已於 2026-10-26 刪除（meal-prep-agent 專案的 Cloudflare 清理）。
- **正式副本相鄰兩天的差異**（VM `/var/lib/freelance-shadow/copies/` 的 08:30 副本，Python 以 `mode=ro&immutable=1` 開啟、依主鍵比對整列，只輸出計數）：

| 區間 | 新增 | 修改 | 刪除 | 有變的表 |
|---|---|---|---|---|
| 10-24 → 10-25 | 151 | 35 | 0 | daily_runs +1、digest_outbox +1、mail_ingestion +15、mail_sync_state 改 6、opportunities +66／改 2、source_health 改 27、source_receipts +68 |
| 10-25 → 10-26 | 219 | 34 | 0 | daily_runs +1、digest_outbox +1、mail_ingestion +10、mail_sync_state 改 6、opportunities +103／改 1、source_health 改 27、source_receipts +104 |

  10-26 副本的列數：opportunities 2,395、source_receipts 2,475、mail_ingestion 257、digest_outbox 39。已有職缺幾乎不被改寫（每天 1–2 列）。
