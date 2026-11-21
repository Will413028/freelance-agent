# 現況與待辦

本頁只寫現在的狀態與還沒做的事。過程、驗收證據與每個決定的理由在[自建重構計畫](plans/2026-11-15-self-hosted-rebuild.md)；更早的 Vercel／D1 系統與 Python 系統只留在 git 歷史與[舊遷移計畫](plans/2026-10-23-nextjs-vercel-migration.md)（只當紀錄）。

## 現況（2026-11-20）

- 正式系統是自建 VM 上的 `web/` 加 Postgres（Docker Compose），只經 Tailscale 可達；每日執行由 systemd timer 在台灣時間 09:00、11:00 啟動。架構見[設計](design.md)，部署與操作見[操作手冊](operations.md)。
- 2026-11-17 切換（計畫步驟 10）；舊的 Vercel 專案、D1 資料庫與 GitHub 的 D1 secrets 已在 2026-11-18 退役（退役紀錄，見計畫步驟 10）。
- 2026-11-20 的每日執行 34／34 個來源 `ok`。逐來源狀態見 `/sources` 與[平台接通主表](platform-connectivity.md)。
- 網頁有清單、詳情與收藏／略過、來源狀態（含信件 dead-letter 的重讀與略過）、篩選設定。功能範圍見[功能說明](features.md)。
- 沒有任何系統寄信（舊計畫 D22）。

## 未完成工作

自建重構計畫已完成（2026-11-20）。12d、12e 的程式還沒部署到 VM，部署要 Will 授權。

進行中：[機會類型計畫](plans/2026-11-20-opportunity-types.md)（競賽、任務獎金）。步驟 2（資料模型加 `opportunity_type`，只有 job，行為不變）已部署（deploy A，VM 跑 `16e36c9`）。步驟 3（`opportunity_type` 只收 `job`、`contest` 的 CHECK，migration 0003）已部署（deploy B，VM 跑 `8de5a13`）。步驟 5 拆成 5a／5b／5c：5a（競賽類型的程式：契約、評估、Devpost 來源、競賽分頁，migration 0004 只加可為空的欄位）已合併（PR #89），還沒部署；下一步 5b（部署 D，要 Will 授權，之後手動連跑兩次、再看三天每日執行），再來 5c（競賽欄位的 CHECK，部署 E）。

## 延後、有觸發條件才做的項目

- 每日摘要與寄信：Will 要求時才做（舊計畫 D22）。
- 跨來源去重：Will 在頁面上看到同一職缺跨來源重複、提出要合併時（計畫 D28；原條件依賴新系統沒有的量測）。
- 備份與還原：計畫範圍列為不做（計畫決定「D1 備份」，Will 2026-11-15）。
- 計畫「範圍」一節的延後平台（Glassdoor、Turing、Remote.co 等）與付費代理：觸發條件寫在該節。

來源每站的限制與下一關卡只更新[平台接通主表](platform-connectivity.md)，不在這裡重複。
