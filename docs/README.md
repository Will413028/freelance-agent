# 文件入口

日常先看功能說明；維護時按下表選一份主文件。`docs/`共9份，不另設歷史目錄。

| 想知道什麼 | 主文件 |
|---|---|
| 現在有哪些功能、怎麼操作 | [功能說明](features.md) |
| 產品範圍、模組責任與資料契約 | [設計](design.md) |
| 正式版本、驗收、未完成工作與release備份 | [進度與部署狀態](implementation-plan.md) |
| Compose／SQLite、排程、備份、修復與回復 | [操作手冊](compose.md) |
| 哪些平台已接入、限制與下一關卡 | [唯一平台接通主表](platform-connectivity.md) |
| 各平台費用、資格與官方取得方式 | [平台研究](platform-research.md) |
| 舊計畫、決策脈絡及歷次實查／驗收 | 歷史紀錄（私人封存 repo 的 `docs/implementation-history.md`） |

本頁是第9份索引。[根README](../README.md)只保留專案介紹、開發及驗證入口。

## 維護方式

- 功能與操作寫入對應主文件，避免每輪工作另開同類文件。
- 未完成工作只列implementation-plan；平台逐站關卡只列platform-connectivity主表。
- 完成的TDD／部署過程與被替換方案記在私人封存 repo 或 second-brain，不放公開 repo；也不讓舊待辦或舊主機指令冒充現況。
- 歷史全文保留；原始檔可由Git `99b78b3:docs/<原檔名>`取回。
