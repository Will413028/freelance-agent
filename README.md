# Freelance Agent

把多平台兼職集中到一份清單，減少逐站搜尋。主流程：**每日收集 → 依個人條件評估與排序 → 收藏或略過 → 回原平台查看**。

- 預設單個職缺每週工時上限 30 小時、固定專案最低預算 TWD 3,000，都可在設定頁調整。
- 工時、報酬、地區資格、截止時間不明時保留為未知，標成待確認；remote 不代表全球都能承接。
- 不建提案、不代為應徵、不寄任何信。每日摘要信已停用（遷移計畫決定 D22），程式裡沒有寄信功能。
- 舊系統的人工投案、客戶／聯絡人、提案模板與草稿、外部送出，目前沒有畫面；資料保留在資料庫的歷史表。

功能與入口見[功能說明](docs/features.md)，文件分類見[文件入口](docs/README.md)。

## 架構

全部程式在 `web/`，是一個 Next.js 專案，部署在 Vercel（區域 `iad1`，以 Vercel Authentication 限定登入後才能看）。

- **資料**：Cloudflare D1 資料庫，經 D1 的 REST API 讀寫。D1 沒有互動式交易，寫入以「寫入租約」（writer lease，同一時間只讓一個寫入者送出批次的鎖）保護。
- **每日收案**：Vercel Cron 依 `web/vercel.json` 在 01:00 與 04:00 UTC（台灣時間 09:00 與 12:00）呼叫 `/api/cron`，啟動 Vercel Workflow `web/src/workflows/daily.ts`。同一天只有第一次會執行，第二次是補跑用。
- **來源**：公開 API／RSS／頁面，以及轉進 Resend Receiving 的職缺通知信（只讀）。逐站狀態見[平台接通主表](docs/platform-connectivity.md)。
- **網頁**：`/` 清單、`/jobs/[id]` 詳情與收藏／略過、`/sources` 來源狀態、`/settings` 篩選設定。

```text
web/
  src/app/                 頁面與 route：/、/jobs/[id]、/sources、/settings、/api/cron
  src/workflows/           每日收案的 workflow 與步驟
  src/services/            組合多個模組的用例：每日執行、探索讀寫、頁面資料
  src/modules/
    collection/            來源目錄、各來源 connector、信件同步、收案寫入
    discovery/             資格規則、排序、設定、清單投影
    preferences/           收藏、略過等個人回饋
    notifications/         daily_runs：每天一次的執行紀錄（不寄信）
    applications/          歷史人工投案的唯讀投影
    legacy/                歷史職缺列格式的讀寫
  src/db/                  D1 client、schema、寫入單元與租約、migration 套用
  src/platform/            HTTP、錯誤型別、v1 雜湊相容所需的解析（py/）
  src/ops/                 儲存觸發條件檢查
  scripts/                 migrate、rebuild-projection、check-storage-triggers
  drizzle/                 migration SQL
  tests/                   整合測試；fixtures/ 是凍結的 golden.json
docs/                      設計、功能、操作、平台狀態、遷移計畫與 ADR
```

模組之間只能經對方的 `public.ts` 引用；邊界由 `pnpm boundaries`（dependency-cruiser）檢查。設計與資料邊界見[設計](docs/design.md)。

## 本機開發

需要 Node.js 24 與 pnpm（版本由 `web/package.json` 的 `packageManager` 指定）。

```bash
cd web
pnpm install --frozen-lockfile
pnpm test
```

`pnpm test` 用本機的 D1 替身（`web/src/db/d1/local.ts`，以 `node:sqlite` 模擬 D1 的限制）測舊程式、用行程內的 PGlite 測新的 Postgres 程式，不需要資料庫、憑證或網路帳號。

`pnpm dev` 會在 `http://127.0.0.1:3347` 啟動網頁，但頁面需要 `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`D1_API_TOKEN` 指向一個真的 D1 資料庫；目前沒有離線示範模式。不要把本機指向正式資料庫做實驗。

## 驗證

在 `web/` 執行，與 CI（`.github/workflows/ci.yml`）相同：

```bash
pnpm check   # typecheck、boundaries、db:check（D1 與 Postgres 兩套）、test、deploy/check-compose.mjs、deploy/test-deploy.mjs
pnpm build
```

CI 另外對真的 Postgres 18 重跑 Postgres 測試（`TEST_PG_URL`），並建一次映像（不推送）。VM 上的部署用 `deploy/deploy.sh`（健康檢查失敗自動回前一版），見 [`deploy/README.md`](deploy/README.md) 與[操作手冊](docs/operations.md)的「自建 VM」。

`pnpm test:d1` 對真的 D1 跑整合測試，**會先清空該資料庫的所有表**。只能指向名稱是 `freelance-agent-*-test` 的資料庫（CI 已不跑它，計畫步驟 11 刪除），絕不能指向正式資料庫；它另外要求 `D1_DESTRUCTIVE_TEST` 與 `D1_DATABASE_ID` 相同才會執行。

測試全部使用合成資料。測試通過不代表可以改正式資料。

## 部署與操作

部署、環境變數名稱、migration、每日執行的查看與失敗處理，見[操作手冊](docs/operations.md)。每次正式部署都要先取得授權。

## 文件

[功能說明](docs/features.md) · [設計](docs/design.md) · [現況與待辦](docs/implementation-plan.md) · [操作手冊](docs/operations.md) · [平台接通主表](docs/platform-connectivity.md) · [平台研究](docs/platform-research.md) · [遷移計畫](docs/plans/2026-10-23-nextjs-vercel-migration.md)
