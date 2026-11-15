# Freelance Agent

把多平台兼職集中到一份清單，減少逐站搜尋。主流程：**每日收集 → 依個人條件評估與排序 → 收藏或略過 → 回原平台查看**。

- 預設單個職缺每週工時上限 30 小時、固定專案最低預算 TWD 3,000，都可在設定頁調整。
- 工時、報酬、地區資格、截止時間不明時保留為未知，標成待確認；remote 不代表全球都能承接。
- 不建提案、不代為應徵、不寄任何信。每日摘要信已停用（遷移計畫決定 D22），程式裡沒有寄信功能。
- 舊系統的人工投案、客戶／聯絡人、提案模板與草稿、外部送出不帶進新系統（自建計畫 D10）。

功能與入口見[功能說明](docs/features.md)，文件分類見[文件入口](docs/README.md)。

## 架構

全部程式在 `web/`，是一個 Next.js 專案加 Postgres，以 Docker Compose 跑在自建 VM，只經 Tailscale 連線（[自建計畫](docs/plans/2026-11-15-self-hosted-rebuild.md)）。切換（計畫步驟 10）前，正式站仍是凍結的 Vercel 部署加 Cloudflare D1，來源 commit `ce1254d`；它的程式已從 `dev` 刪除（計畫 D23），要查用 `git show ce1254d:<路徑>`。

- **資料**：Postgres，結構在 `web/src/db/pg/schema.ts`，migration 在 `web/drizzle-pg/`。
- **每日收案**：VM 上的 systemd timer 跑 `web/scripts/daily.ts`（`deploy/systemd/`）；同一個台灣日期只執行一次，中斷的執行下次接著做完。
- **來源**：公開 API／RSS／頁面；新系統已接的來源見 `web/src/modules/sources/catalog.ts`，逐站狀態見[平台接通主表](docs/platform-connectivity.md)。
- **網頁**：`/` 清單、`/jobs/[id]` 詳情與收藏／略過、`/sources` 來源狀態、`/settings` 篩選設定、`/healthz` 健康檢查。

```text
web/
  src/app/                 頁面與 route：/、/jobs/[id]、/sources、/settings、/healthz
  src/services/            組合多個模組的用例：收案、每日執行、頁面資料
  src/modules/
    listings/              職缺的輸入契約、身分 (source, external_id) 與收案寫入
    sources/               來源目錄與各來源 connector（每個來源一個目錄，fixture 在旁邊）
    evaluation/            資格判定、推薦與排序
    review/                收藏、略過等回饋與篩選設定的寫入
    runs/                  每日執行與每個來源的執行紀錄
  src/db/pg/               Postgres client、schema、migration 套用
  src/platform/            分層讀取（fetch/）、頁面錯誤型別
  scripts/                 daily、run-source、migrate-pg
  drizzle-pg/              migration SQL
  tests/                   頁面與 Postgres 的整合測試
deploy/                    VM 的 compose、映像、部署腳本與 systemd 單元
docs/                      設計、功能、操作、平台狀態、計畫與 ADR
```

模組之間只能經對方的 `public.ts` 引用；邊界由 `pnpm boundaries`（dependency-cruiser）檢查。設計與資料邊界見[設計](docs/design.md)。

## 本機開發

需要 Node.js 24 與 pnpm（版本由 `web/package.json` 的 `packageManager` 指定）。

```bash
cd web
pnpm install --frozen-lockfile
pnpm test
```

`pnpm test` 用行程內的 PGlite 測 Postgres 程式，不需要資料庫、憑證或網路帳號。

`pnpm dev` 會在 `http://127.0.0.1:3347` 啟動網頁，但頁面需要 `DATABASE_URL` 指向一個 Postgres；目前沒有離線示範模式。資料庫容器只在 CI 或 VM 上跑，不在開發機上起。

## 驗證

在 `web/` 執行，與 CI（`.github/workflows/ci.yml`）相同：

```bash
pnpm check   # typecheck、boundaries、db:check（Postgres）、test、deploy/check-compose.mjs、deploy/test-deploy.mjs
pnpm build
```

CI 另外對真的 Postgres 18 重跑 Postgres 測試（`TEST_PG_URL`），並建一次映像（不推送）。VM 上的部署用 `deploy/deploy.sh`（健康檢查失敗自動回前一版），見 [`deploy/README.md`](deploy/README.md) 與[操作手冊](docs/operations.md)的「自建 VM」。

測試全部使用合成資料。測試通過不代表可以改正式資料。

## 部署與操作

VM 的部署、migration 規則與沒有備份時的影響，見[操作手冊](docs/operations.md)。每次正式部署都要先取得授權。

## 文件

[功能說明](docs/features.md) · [設計](docs/design.md) · [現況與待辦](docs/implementation-plan.md) · [操作手冊](docs/operations.md) · [平台接通主表](docs/platform-connectivity.md) · [平台研究](docs/platform-research.md) · [自建計畫](docs/plans/2026-11-15-self-hosted-rebuild.md)
