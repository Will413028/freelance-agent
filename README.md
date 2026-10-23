# Freelance Agent

把多平台兼職集中起來，減少逐站搜尋。主流程：**收集 → 篩選／分組 → 收藏或略過 → 每日摘要 → 回原平台查看**。

預設單個職缺每週工時上限 30 小時，可調整或取消；未知資格保持未知。同職缺不同通知內容並存、標示差異，不用轉寄時間推定最新版本。新收案不建提案、不啟動 AI、不代為應徵；歷史資料保留。

目前已部署探索、人工投案、客戶／聯絡人、提案模板與草稿版本、站內跟進工作台；Email／Freelancer 外部送出通道尚未啟用。完整功能與入口見[目前功能說明](docs/features.md)，發布狀態以 [implementation-plan](docs/implementation-plan.md) 為準。原私人投案表（私人封存 repo 的 `docs/implementation-history.md`）保留為備援。

完整文件分類見[文件入口](docs/README.md)。

## 架構與現況

Docker Compose＋Huey＋SQLite；FastAPI／Pydantic 定義 API，OpenAPI 產生前端型別。Next.js 只負責畫面與同源 proxy。API 與 worker 共用可安裝 Python 套件及同一 backend image。

```text
frontend/src/              app、features、shared
backend/src/freelance/
  bootstrap/               API／CLI／Huey 組裝與設定
  modules/collection/      來源解析、增量同步與內容版本
  modules/discovery/       資格、分組、排序與投影
  modules/preferences/     個人設定、收藏與略過
  modules/notifications/   每日用例、摘要與寄送狀態
  modules/applications/    本人填寫的投案、跟進與稽核事件
  modules/relationships/   客戶、聯絡人與歷史關聯
  modules/proposals/       人工模板與不可覆寫的草稿版本
  modules/submissions/     精確核准、送出及核對證據
  platform/                SQLite 交易與打包 schema
  legacy/                  歷史提案、AI、PostgreSQL 相容
backend/tests/             按功能分組；fixtures 共用資料
contracts/                生成 OpenAPI／Web 型別
scripts/                  邊界、套件與容器驗證
deploy/                   Dockerfiles 與 Compose
```

本輪重構進度、RED／GREEN 證據及**實際部署版本**以 [implementation-plan](docs/implementation-plan.md) 為準；程式碼完成不代表正式切換。Web 仍以本機使用為範圍；來源狀態見 [平台接通清單](docs/platform-connectivity.md)，不把局部讀取宣稱成全平台覆蓋。

## 本機開發

在專案根目錄：

```bash
uv sync --project backend --locked
cd frontend
pnpm install --frozen-lockfile
```

回到專案根目錄啟動合成 Demo（不讀憑證、不接來源、不寄信）：

```bash
backend/.venv/bin/python -m freelance.bootstrap.api --mode demo
```

另一終端在 `frontend` 執行 `pnpm run build`、`pnpm start`，開啟 http://127.0.0.1:3327。API 使用 127.0.0.1:8327。

使用既有 SQLite 前先備份、顯式 migrate，再啟動 persistent API：

```bash
backend/.venv/bin/python -m freelance.bootstrap.store --migrate --database /absolute/path/cases.sqlite3
backend/.venv/bin/python -m freelance.bootstrap.api --mode sqlite --database /absolute/path/cases.sqlite3
backend/.venv/bin/python -m freelance.bootstrap.cli --database /absolute/path/cases.sqlite3 list
```

API 不收信、不寄信、不啟動排程。`--container` 僅用於隔離容器網路，Compose 不公開 API port。UI 只發布到主機 loopback。

## 排程與資料

Huey consumer 同時執行 scheduler 與單一 worker；使用檔案鎖阻擋同 queue 的第二個 consumer。09:00 後每分鐘檢查當天，重啟可補當天，跨日不補寄。已有任何 daily run 就不重跑；中斷留下的 running、attempted／unknown 須人工核對。

產品資料與 queue 使用分開的持久化 SQLite 檔案，不宣稱跨庫原子交易。產品 daily run／outbox 是權威；queue 只是派送。先持久化 attempt 再送信，unknown 不自動重寄。Compose 的容器 restart 不等於允許重送。

部署、worker 設定格式與回復見 [Compose 操作](docs/compose.md)。正式使用唯一 Compose worker；切換先停本專案 writers、備份並驗遷移，再恢復同版 API／worker 及固定 Web image。

## 接案工作台

`/clients`維護客戶與聯絡人；`/proposals`建立模板與人工草稿、選擇不可覆寫的正文版本；`/submissions`核對收件者／平台案件、帳號、環境與完整正文，再分別核准及要求送出。導航的跟進提醒沿用人工投案日期；收藏、草稿與核准不計為已投案。送出後須明確記錄投案，保留原版本及送出證據，不再次傳送。

預設Email與Freelancer皆未配置；離線Demo不讀憑證、不連外。使用者本輪選擇先完成程式、暫不登入或配置。真正啟用通道需另外完成帳號／環境驗收與private runtime配置，操作及回復見[Compose](docs/compose.md)；設計見[接案工作台契約](docs/design.md#接案工作台契約)。

## 驗證

在 repo 根目錄（全為合成資料，歷史 PostgreSQL 整合需專用 DSN）：

```bash
FREELANCE_TEST_DSN='' backend/.venv/bin/python -B -m unittest discover -s backend/tests -q
backend/.venv/bin/python scripts/check_boundaries.py
backend/.venv/bin/python -m freelance.bootstrap.export --check --output contracts/openapi.json
uv build --project backend --out-dir /tmp/freelance-wheels
```

將 wheel 安裝到獨立 venv，再用該 interpreter 執行 `scripts/test_installed.py`；此檢查從 repo 外驗 schema、SQLite 與 Demo，不靠 PYTHONPATH。`uv pip check --python backend/.venv/bin/python` 檢查依賴。

在 `frontend` 執行：

```bash
pnpm run contracts:check
pnpm run typecheck
pnpm run build
pnpm exec next start --hostname 127.0.0.1 --port 3337
```

另一終端執行 `UI_URL=http://127.0.0.1:3337 node tests/smoke.mjs` 及 `UI_URL=http://127.0.0.1:3337 node tests/manual-application-load.mjs`（手動轉介不依賴探索服務）。Smoke 使用 backend/.venv 與暫存合成 SQLite；PYTHON 可指定已安裝套件的 interpreter。

容器驗證先 `docker compose -f deploy/compose.yaml build worker web`，再 `python3 scripts/test_compose.py`。使用獨立 Compose project、專屬 Linux volumes 與 fake sender，結束刪除自己的容器及 volumes；若 3327 已被使用會停止，不關閉既有服務。

[設計](docs/design.md) · [TDD 計畫](docs/implementation-plan.md) · [平台研究](docs/platform-research.md)

第三階段瀏覽器驗證：`UI_URL=http://127.0.0.1:3337 node tests/workbench.mjs`，同樣只用temporary合成庫。可用`PLAYWRIGHT_CHROMIUM_EXECUTABLE`指定已安裝Chrome，以獨立headless profile驗收，不操作登入帳號。資料庫副本升級gate：`backend/.venv/bin/python scripts/test_workbench_upgrade.py --database /absolute/path/snapshot.sqlite3 --previous-source /absolute/path/previous/backend/src`；只改暫存副本，驗兩次升級、舊表指紋及新舊版回讀。
