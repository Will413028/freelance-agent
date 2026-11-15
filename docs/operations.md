# 操作手冊：自建 VM

新系統是 `web/` 這個 Next.js 專案加 Postgres，以 Docker Compose 跑在自建 VM，只經 Tailscale 連線（[`docs/plans/2026-11-15-self-hosted-rebuild.md`](plans/2026-11-15-self-hosted-rebuild.md)，以下稱「計畫」）。本頁只寫能從程式或計畫對到的程序。

## 過渡期規則（到計畫步驟 10 切換為止）

- 正式系統仍是凍結的 Vercel 部署（`jzp0qoy8t`，commit `ce1254d`）加 Cloudflare D1 `freelance-agent-prod`：不部署新版程式，正式站的來源壞了不修。那個部署是 CLI 上傳的成品，`dev` 上已經沒有它的原始碼（計畫 D23）；它的操作手冊與程式用 `git show ce1254d:docs/operations.md`、`git show ce1254d:<路徑>` 查。
- 正式 D1 對這項工作只讀，查詢用 `cf d1 query <資料庫 id> --sql "…"`，只輸出狀態與計數。
- VM 上的新系統只寫自己的資料庫；在 VM 起容器、裝排程或設定 Tailscale Serve 都要先取得 Will 授權。

沒有回滾到舊系統的路徑（計畫 D5）。出問題只能往前修。

## 自建 VM（新系統）

切換（計畫步驟 10）前，VM 上只有影子資料；切換後這一節是正式系統的操作。VM 的檔案位置、env 檔與 Tailscale Serve 設定見 [`deploy/README.md`](../deploy/README.md)。每次在 VM 部署都要先取得 Will 授權。

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

### 沒有備份（計畫 D1）

計畫 D1 決定不做備份。資料庫 volume（`pgdata`）遺失時：

| 資料 | 會不會回來 |
|---|---|
| 來源上仍然公開的職缺 | 會：下一次每日執行重新收進來，但 id 是新的，`first_seen_at` 從那天算 |
| 已經從來源下架的職缺、職缺的歷史版本 | 不會 |
| 回饋（儲存／略過）、設定 | 不會，要重新操作 |
| 每日執行與來源明細的紀錄 | 不會 |
| 信件來源的信 | 只有 Resend Receiving 還保有的那些會再收到（Resend 的保留期未查證） |


## 不要做的事

- 不要把寄信功能或任何寄送憑證加回正式環境，除非 Will 要求。
- 不要為了讓某一天重跑而刪 `daily_runs` 的列，除非 Will 決定。
- 只讀不用登入的公開頁面；遇到存取驗證照來源設定允許的層級處理（一般請求、模仿瀏覽器的請求、瀏覽器；[`docs/plans/2026-11-15-self-hosted-rebuild.md`](plans/2026-11-15-self-hosted-rebuild.md) 步驟 8），不登入、不解 CAPTCHA、不換 IP。PTT 兩個來源在正式站（Vercel 出口被 403 challenge）維持停用，新系統在步驟 8 接回。
