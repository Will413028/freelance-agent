# 操作手冊：自建 VM、Vercel 與 Cloudflare D1

正式系統是 `web/` 這個 Next.js 專案：跑在 Vercel（區域 `iad1`），資料在 Cloudflare D1 資料庫 `freelance-agent-prod`。本頁只寫能從程式或遷移計畫對到的程序；引用計畫的地方標了段落。「計畫」指 [`docs/plans/2026-10-23-nextjs-vercel-migration.md`](plans/2026-10-23-nextjs-vercel-migration.md)。

## 過渡期規則（到自建計畫步驟 10 切換為止）

[`docs/plans/2026-11-15-self-hosted-rebuild.md`](plans/2026-11-15-self-hosted-rebuild.md) 把系統搬回自建 VM 加 Postgres。切換前：

- 本頁的 Vercel 部署（`jzp0qoy8t`，commit `ce1254d`）加 D1 是唯一的正式系統，凍結：不部署新版程式，正式站的來源壞了不修。唯一允許的操作是 D1 token 換新後把同一個部署重新部署一次。
- 正式 D1 對這項工作只讀；`dev` 上的 migration 0005 不套到正式庫。
- VM 上的新系統只寫自己的資料庫；在 VM 起容器、裝排程或設定 Tailscale Serve 都要先取得 Will 授權。

沒有回滾到舊系統的路徑：舊的 Python 系統已從 repo 刪除，回滾窗口已結束。出問題只能往前修。

## 自建 VM（新系統）

切換（計畫步驟 10）前，VM 上只有影子資料；切換後這一節是正式系統的操作，下面 Vercel 的章節在步驟 10 退役後刪除。VM 的檔案位置、env 檔與 Tailscale Serve 設定見 [`deploy/README.md`](../deploy/README.md)。每次在 VM 部署都要先取得 Will 授權。

### 部署

以 root 執行 `/opt/side-income/deploy/deploy.sh <sha 或 origin 的分支名>`（commit 先在 CI 綠燈；分支名一律解析成剛 fetch 的 `origin/<分支>`）。同時只能有一個部署（`flock` 鎖 env 檔旁的 `.lock`）。腳本用的是**目前** checkout 裡的版本：改 `deploy.sh` 本身的 commit，從下一次部署才生效。它依序：

1. 把 checkout 切到該 commit（detached），建映像 `side-income-web:<短 sha>`。
2. 用**新**映像跑 `migrate-pg`。失敗就停：env 檔的 `APP_IMAGE` 和正在跑的 `web` 都沒動，checkout 切回原本的 commit。drizzle 把所有待套的 migration 放在同一個交易裡，失敗時結構維持原樣。
3. 把 `APP_IMAGE` 改成新 tag、重建 `web`，等 compose 的健康檢查（`/healthz`，最多 180 秒）。
4. 重建失敗或不健康就把 `APP_IMAGE` 和 checkout 改回前一個、重建 `web`，以 exit 1 結束。`web` 與 `daily` 讀同一個 `APP_IMAGE`，所以回滾兩者一起回去。

輸出最後一行是 `deployed …`、`rolled back to …` 或 `ROLLBACK UNHEALTHY`（前一版也起不來，要人看 `compose ps` 與 log）。回滾不會撤銷已套用的 migration，所以下一條規則才是讓回滾安全的前提。

### 信件來源

`compose.yaml` 只把 env 檔的 `RESEND_API_KEY`、`RESEND_INBOX` 傳給 `daily` 服務（`web` 拿不到）。缺任一個時，信件來源在 `run_sources` 記為 `failed`、`error` 是 `MailConfigError`，其他來源照跑。key 是完整權限（Resend 沒有唯讀），防護在程式：只送 GET、只打 `https://api.resend.com/emails/receiving` 底下的網址（`web/src/modules/sources/mail/receiving.ts`）；Resend 的讀取不改變信件狀態，和凍結的正式站讀同一個信箱互不影響。

每封信只處理一次，記在 `mail_messages`：`processed`（`reason` 為 `content_changed` 表示同一筆職缺的內容和先前不同，另存成版本）或 `rejected`（`reason` 是哪一項檢查沒過，代碼列在 `web/src/modules/sources/mail/reasons.ts`）。被拒的信不會自動重讀；「重排」「消掉」的入口在計畫步驟 7b。這次執行讀的信超過一半被拒時整個來源記為失敗（通常是信的版型改了）。Resend 回 429 或 5xx 時照每日執行的規則重試，已記錄的信不會重讀。

### Migration 規則

SQL 在 `web/drizzle-pg/`，由 `migrate-pg`（`web/scripts/migrate-pg.ts`）套用；套過的記在 `drizzle.__drizzle_migrations`，重跑是 no-op。

- 切換前：新庫只有影子資料，可以整個重建，migration 可以就地重新產生（步驟 10 前壓成一個起始 migration；操作見 `deploy/README.md`）。
- **切換完成起：每個 migration 都要讓前一版映像能在新結構上繼續跑。** 先加後刪：新增欄位要可為 null 或有預設值；改名或改型別拆成「加新欄、程式改用新欄」與「下一次部署再刪舊欄」兩次；刪欄、刪表、加 NOT NULL 只在已經沒有任何上線版本讀寫它之後的那次部署做。

### 沒有備份（D1）

計畫 D1 決定不做備份。資料庫 volume（`pgdata`）遺失時：

| 資料 | 會不會回來 |
|---|---|
| 來源上仍然公開的職缺 | 會：下一次每日執行重新收進來，但 id 是新的，`first_seen_at` 從那天算 |
| 已經從來源下架的職缺、職缺的歷史版本 | 不會 |
| 回饋（儲存／略過）、設定 | 不會，要重新操作 |
| 每日執行與來源明細的紀錄 | 不會 |
| 信件來源的信 | 只有 Resend Receiving 還保有的那些會再收到（Resend 的保留期未查證） |


## 資源

| 資源 | 內容 |
|---|---|
| Vercel 專案 | Next.js，區域 `iad1`（`web/vercel.json`）；Vercel Authentication 套用在所有部署，沒登入看不到（計畫前提、步驟 1a） |
| D1 資料庫 | `freelance-agent-prod`；經 REST API 讀寫，沒有互動式交易（計畫 D19、D21） |
| 排程 | Vercel Cron 兩支：`0 1 * * *` 與 `0 4 * * *`（UTC），都打 `/api/cron` |
| 每日執行 | Vercel Workflow `web/src/workflows/daily.ts` |
| 信件來源 | Resend Receiving，只送 GET（`web/src/modules/collection/mail/receiving.ts`） |

所有指令都在 `web/` 執行。

## 環境變數

只列名稱。值放在 Vercel 的 Sensitive Environment Variables 或本機私人儲存，不進 repo、不印出來、不寫進文件或 log。

| 名稱 | 用途 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`D1_API_TOKEN` | 連 D1（`web/src/db/client.ts` 的 `getDb`）；三個缺一就丟錯 |
| `CRON_SECRET` | `/api/cron` 檢查 `Authorization: Bearer …`；不符回 401 |
| `PORTFOLIO_CATEGORY_PROJECTS` | 各專長分類對應的作品 ID（JSON 物件）；沒設時用程式裡的合成範例 ID，格式錯誤會丟錯 |
| `RESEND_API_KEY`、`RESEND_INBOX` | 讀 Resend Receiving 的信件來源；缺任一個時信件來源記為 `failed`／`source_unavailable` |

正式環境只允許上面這些名稱，不放任何寄送憑證（計畫「全域約束」）。`RESEND_API_KEY` 技術上是完整權限的 key，防護在程式：只送 GET、只打 `https://api.resend.com/emails/receiving` 底下的網址。

`D1_DATABASE_ID` 只設在 Production。Preview 沒有這個值（原本指向的 shadow 資料庫已在 2026-11-15 刪除），所以 preview 部署連不到任何資料庫，需要資料的頁面會失敗；要讓 preview 可用，先建一個專用的 D1 資料庫再設定，不要指向正式庫。

`D1_API_TOKEN` 用的 token 在 2026-11-30 到期，到期前要重建並換掉各處的值（計畫 D21）。

## 部署

每次正式部署都要 Will 先授權。

1. 在 `web/` 跑過 `pnpm typecheck`、`pnpm boundaries`、`pnpm test`、`pnpm build`，CI 綠燈。
2. 這次部署的程式需要新的 migration 時，**先**套 migration（見下一節）。
3. `vercel deploy --prod`。
4. 這次部署改了清單投影的算法時，部署後跑 `rebuild-projection`（見「清單投影重建」）。
5. 驗收：開正式網址確認清單有資料（計畫步驟 13 的做法）；下一次每日執行後看結果（見「查看一次執行」）。

## Migration

- SQL 檔在 `web/drizzle/`，由 `pnpm db:generate`（drizzle-kit）產生。drizzle-kit 只負責產生，不拿來套用。
- 套用只有一條路：`web/scripts/migrate.ts`。它把所有待套的 migration 和紀錄列放進同一個請求，失敗不會留下套到一半的狀態；資料庫已有寫入租約時，這個請求走在租約守衛後面，不會和每日執行交錯（`web/src/db/migrate.ts`）。

```bash
CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… pnpm exec tsx scripts/migrate.ts
```

- 輸出 `migrations applied: N`；已是最新時不做事。目前有 6 個（`0000_schema` 到 `0005_daily_runs_key`）。
- `0005_daily_runs_key` 會重建 `daily_runs`（主鍵從日期加收件人改成只有日期，拿掉 `recipient` 欄）。套用後舊版程式讀寫這張表會失敗，所以要緊接著部署，並避開台灣時間 09:00–13:00 的排程時段；套了就不能 promote 回更早的版本。
- 待套的語句超過一個請求的上限時腳本會拒絕，要把 migration 拆開。
- 結構的唯一權威是 `web/src/db/schema.ts` 加這裡的 migration。兩道檢查，CI 都跑：`pnpm db:check` 比對 `schema.ts` 與 drizzle 的快照（`drizzle-kit generate` 不該產生新檔）；`tests/schema.test.ts` 比對「migration 實際建出來的表與欄位」與 `schema.ts`，所以手寫的 migration 動到任何一張表都會被擋。改 25 張產品表的欄位是要先設計的決定，不是例行 migration。

## 排程與每日執行

- 兩支 cron 對應台灣時間 09:00 與 12:00（計畫 D5）。Vercel Hobby 的 cron 會在該小時內某個時間觸發，不保證準點（計畫 D1）。
- `/api/cron` 驗過 `CRON_SECRET` 後啟動 workflow，回傳 `runId`。
- workflow 的步驟（`web/src/workflows/daily.ts`、`web/src/services/daily.ts`）：
  1. **claim**：台灣時間未滿 09:00 回 `not_due`；否則在 `daily_runs` 插入當天一列（`running`）。當天已有列就回 `already_run`，整個 run 結束。所以 12:00 那支只有在 09:00 沒跑成時才真的執行。
  2. **來源清單**：來源目錄裡有 connector 且沒有 `disabled` 原因的來源，依目錄順序。
  3. **逐一同步**：一個來源一個 step，依序執行不並行。每個來源開始前先把 `source_health` 標成 `failed`，成功才改回，所以中斷不會留下過期的 `ok`。一個來源失敗不影響下一個。
  4. **finish**：全部來源成功（`ok` 或 `waiting`）記 `complete`，否則記 `failed`；結果 JSON 寫進 `daily_runs.result`，包含每個來源的狀態與計數，以及這次執行的 D1 用量。
- 每個 step 的 `maxRetries` 都是 0：不自動重試。中斷的執行會停在 `running`，那一天不會再跑。
- step 的輸入輸出只有日期、來源 ID、狀態與計數，因為 Vercel Workflow 會記錄它們（計畫「全域約束」）。

## 查看一次執行

**業務結果看資料，不看平台狀態。** workflow 顯示 `completed` 只代表流程走完，不代表每個來源都成功。

- 網頁 `/sources`：最近一次每日執行的日期、狀態、起訖時間、原因，以及每個來源的健康狀態與當次計數；另有一區顯示近 7 天的儲存檢討訊號。
- D1 的 `daily_runs`：每天一列，`status` 是 `running`／`complete`／`failed`，`result` 是結果 JSON。`source_health` 是每個來源最近一次檢查。
- workflow 的 run 與各 step 耗時：

```bash
pnpm exec workflow inspect runs -b vercel -j
```

- runtime log：Vercel Hobby 只留約 1 小時（計畫步驟 10「10-26 自然執行」），要看就在執行後馬上看。每個頁面請求會寫一行 `page usage …`（路徑、結果、耗時、D1 請求數、讀寫列數、讀取重試、等租約時間；`web/src/app/_lib/usage.ts`）。

## 執行失敗時怎麼辦

先看 `/sources` 或 `daily_runs` 那一列，分清是哪一種。

| 現象 | 意思 | 處理 |
|---|---|---|
| `status = failed`，`result.status = source_failed` | 一個以上來源失敗，其他來源照常收進來 | 看 `result.source_details` 各來源的 `reason`（見下）。當天不會重跑；收案是增量的，隔天的執行會再讀。切換後 11-06 到 11-13 每天都是這個狀態，固定有 3–4 個來源失敗（計畫步驟 13 驗收） |
| `status = failed`，`reason = daily_processing_failed` | 來源跑完了，但組結果或記錄用量時出錯 | 來源資料已寫入；看當時的 log 找原因 |
| 過了執行時段仍是 `running` | 執行中斷（step 逾時或當掉） | 那一天不會自動重跑，兩支 cron 都會回 `already_run`。用 `workflow inspect` 看停在哪個 step、`source_health` 看哪些來源完成。程式沒有「重跑某一天」的工具；要不要人工改那一列由 Will 決定 |
| 當天沒有列 | cron 沒觸發、`CRON_SECRET` 不符（401）、或 claim 之前就失敗（D1 三個變數沒設） | 12:00 那支會補跑。兩支都過了還沒有列時，同一天內帶正確的 bearer 再打一次 `/api/cron` 會照常 claim 並執行；這是對正式資料的寫入，先取得授權 |

來源的 `reason`（`web/src/modules/collection/run-source.ts`、`registry.ts`）：

- `<來源>_unavailable_or_unsupported`、`public_feed_unavailable_or_unsupported` 等：connector 抓取或解析失敗。來源改版、暫時連不上都會是這個。
- `storage_<種類>`：不是來源的問題，是 D1 或寫入租約失敗。`storage_rate_limited`、`storage_daily_limit` 是撞到額度（見下一節）；`storage_lease_wait`、`storage_lease_lost` 是等不到或被搶走租約。
- `source_unavailable`：step 整個當掉沒有回傳，或信件來源缺 Resend 的環境變數。
- connector 丟出例外而失敗的來源另有 `error` 欄位（信件來源自己接住例外、回 `source_or_reconciliation_failed` 的那條路還沒有，見[現況與待辦](implementation-plan.md)），記錯誤的種類：`http_<狀態碼>` 是來源回的 HTTP 狀態，其他是錯誤類別（例如 `valueerror` 是內容不符預期、`oserror` 是連線失敗）。不記錯誤訊息，因為訊息可能帶來源內容。`/sources` 頁會顯示。
- `invalid_source_result`：connector 回傳的結果含不允許的值，被擋在 workflow 之外。

信件來源的 `quarantined` 是歷來被隔離的信的累計數，不代表這次失敗；這次的問題看 `error_count` 與 `error_stages`。

來源的 `partial` 與 `waiting` 不是故障：`partial` 是有限讀取或有個別項目被拒收，`waiting` 是信件來源還沒收到有效的職缺通知。

網頁寫入的錯誤：

- 409「系統忙碌，請稍後再試」：等寫入租約超過 5 秒（多半是每日執行正在寫）。稍後再試。
- 409「…已更新，請重新載入」：頁面上的 token 或設定版本過期。重新載入再操作。
- 500「結果未知，請重新載入確認是否已儲存」：D1 是經 HTTP 連的，請求失敗時那一批可能已經寫入。重新載入看實際狀態，不要直接重送。
- 403「不允許的來源」：請求的 Origin 和站台不同。
- 清單頁讀取失敗，log 有 `discovery projection out of date`：清單投影和職缺資料對不上，見「清單投影重建」。

## D1 免費額度

數字來自計畫 D19（2026-10-26 查 Cloudflare 官方文件）。額度是整個 Cloudflare 帳號共用，CI 的測試資料庫也算在內（計畫 D21）。

| 限制 | 數值 | 超過時 |
|---|---|---|
| 每日列讀取 | 500 萬列 | 帳號內所有 D1 查詢被擋到 00:00 UTC |
| 每日列寫入 | 10 萬列 | 同上 |
| 單一資料庫大小 | 500 MB | — |
| 每條查詢 | 100 個綁定參數、SQL 100 KB、30 秒 | 該查詢被拒 |
| Cloudflare API 請求 | 每個使用者每 5 分鐘 1,200 個 | 全部 API 被擋 5 分鐘 |

量到的用量（計畫步驟 11「D13 頁面量測」，正式環境各量一次）：待看清單第 1 頁讀 20,687 列、全部清單第 1 頁 17,956 列、收藏 11,580 列、詳情 12 列、設定 1 列、來源狀態 30 列（2026-11-15 起這頁多一次 `daily_runs` 讀取，最多再讀約 7 列，還沒重量）。清單頁是讀取額度的主要消耗，讀取列數會隨職缺數成長。

撞到額度時程式不等待也不重試（`web/src/db/client.ts` 的 `retrying` 只重試「結果不明」的請求），該來源或該頁面直接失敗。

## 儲存觸發條件檢查

`web/scripts/check-storage-triggers.ts` 讀 `daily_runs.result` 裡每次執行的用量，檢查計畫 D18、D20、D21 訂的「該重新檢討決定」的條件。

```bash
CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… pnpm exec tsx scripts/check-storage-triggers.ts [--since YYYY-MM-DD]
```

`--since` 預設是昨天（UTC）。每個訊號印一行（日期、決定、訊號名、數值），最後一行是摘要。有任何要重新檢討的訊號時 exit 1。

| 訊號 | 條件 | 指向 |
|---|---|---|
| `lease_wait_over_limit` | 一次執行等租約合計超過 2 秒 | D20（寫入租約是否改成逐筆版本控制） |
| `lease_timeout`、`lease_lost` | 出現任何一次 | D20 |
| `rate_limited` | 出現任何一次 429 | D21（REST 是否改成資料存取 Worker） |
| `requests_over_limit` | 一次執行超過 600 個 D1 請求 | D21 |
| `read_retries` | 清單頁的讀取重來過 | 清單投影的讀取方式 |
| `cross_source_title_pairs` | 近 7 天候選裡跨來源同職稱達 3 組 | D18（是否加回跨來源去重；先人工抽樣確認是同一職缺） |
| `cross_source_unmeasured` | 那次執行沒量到上一項 | D18 |
| `lost_steps` | 有 step 沒回傳用量 | 只表示該次用量是下限，不算要檢討的訊號 |

出現訊號時不要自行改架構，回報 Will；對應的選項寫在計畫的 D18、D20、D21。

`/sources` 頁每次載入都會對「到最近一次執行為止的 7 天」跑同一套判斷並顯示結果，所以平常看網頁就夠；這支腳本用來查更早的日期。

## 清單投影重建

清單頁讀的是衍生表 `discovery_items`、`discovery_versions`，由職缺、信件內容版本與設定算出來，平常隨每次寫入維護（計畫 D16、D18）。兩種情況要整個重建：部署改了投影的算法，或讀取回報投影過期。

```bash
CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… pnpm exec tsx scripts/rebuild-projection.ts
```

- 整個過程握著寫入租約，所以台灣時間 09:00–09:59 會拒絕執行。
- 成功時最後印 `projection ok`。中途失敗會留下不完整的投影，清單頁會拒絕讀取；再跑一次即可。
- 這是對正式資料庫的寫入（刪掉再重寫兩張衍生表），先取得授權。它不動 25 張產品表。

## 資料表分三類

| 類別 | 表 | 規則 |
|---|---|---|
| 產品表（25 張） | `web/src/db/schema.ts` 裡衍生表與記帳表以外的那些 | 權威資料。歷史的提案、投案、客戶、送出、摘要表也在內，沒有畫面但必須保留 |
| 衍生表 | `discovery_items`、`discovery_versions` | 可由產品表重建 |
| D1 專屬記帳表 | `writer_lease`、`write_attempts`、`guard` | 寫入租約與守衛用，不是產品資料 |

寫入租約一期 30 秒，每個寫入批次會續期。每日執行的寫入最多等 35 秒，網頁寫入等 5 秒（`web/src/db/unit.ts`）。

## 不要做的事

- 不要把寄信功能或任何寄送憑證加回正式環境，除非 Will 要求。
- 不要把 `pnpm test:d1` 指向正式資料庫：它會清空所有表。
- 不要為了讓某一天重跑而刪 `daily_runs` 的列，除非 Will 決定。
- 只讀不用登入的公開頁面；遇到存取驗證照來源設定允許的層級處理（一般請求、模仿瀏覽器的請求、瀏覽器；[`docs/plans/2026-11-15-self-hosted-rebuild.md`](plans/2026-11-15-self-hosted-rebuild.md) 步驟 8），不登入、不解 CAPTCHA、不換 IP。PTT 兩個來源在正式站（Vercel 出口被 403 challenge）維持停用，新系統在步驟 8 接回。
