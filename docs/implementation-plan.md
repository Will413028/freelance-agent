# 接案助理 Implementation Plan

## 現行版本與驗收

使用者選完整Email＋Freelancer官方API範圍，並選「先完成程式，暫不登入或配置」。本輪交付程式；真實帳號與sandbox驗收另列後續，不以disabled adapter宣稱已接通。詳細契約見[接案工作台設計](design.md#接案工作台契約)。

- [x] RED／GREEN完成客戶／聯絡人、人工投案關聯、模板白名單、不可覆寫草稿版本、精確核准與送出ledger；跨模組共用caller transaction，生成OpenAPI／TypeScript契約。
- [x] Email及Freelancer官方HTTP adapter、固定目的地、單次attempt、unknown追加查證；Huey固定task與payload版本、retries=0。預設不讀憑證、不送出。
- [x] Web客戶／提案／送出頁、跟進提醒、選中舊正文版本、過期核對、完整預覽與獨立核准／送出；手動機會不讀Dashboard。
- [x] 開始前獨立design-review改P1 queue回復與P2 unknown權威；程式複核改B指定職缺整包Dashboard耦合，使用共用單組query。累積帳見詳細計畫。
- [x] 後端626項（22PG略過）、Python boundary、TypeScript／production build、生成契約check、依賴check、repo外installed wheel。
- [x] 正式build三份合成瀏覽器流程：既有探索／投案、discovery不可用時手動轉介、新工作台及手機寬度。
- [x] 隔離Compose：真Web proxy、客戶／聯絡人／草稿版本持久化、精確核准／disabled通道、revision guards及pending-task rollback隔離。
- [x] 本機原庫只讀副本：先補舊版schema，再升級九表兩次；舊表指紋、新舊探索／偏好／來源投影相同，原庫未變、integrity／FK valid。
- [x] 正式庫owner-only唯讀快照：同樣升級兩次、17表（含sqlite_sequence）指紋不變，新舊版投影相同、integrity／FK valid。
- [x] 固定b4dd278 ARM64 image正式切換：API／worker healthy、Web新頁及proxy HTTP200、唯一worker。九張新表空，708案／726 receipts、daily14／outbox14及既有17表（含sqlite_sequence）指紋／投影不變；外部通道未配置。

實作前唯讀核對：本機37案／6表；正式708案／726 receipts、17表（含SQLite內部sequence），manual三表空、daily14／outbox14。正式切換新增九張空表，沒有新增正式投案或送出證據。

### 第三階段部署證據與回復

正式release `/opt/freelance-agent.b4dd278`；API／worker固定image `sha256:19bed9072cda0b2201d476de6a1191f63959d892c7e12d7a6130ade7afdec789`，Web `sha256:b88e3868e69f324c906cad980f32922aceb7acd17439675e35b2c19ef06b4ef3`。VM容器45項離線測試通過；新舊image在正式副本migrate兩次／回讀通過，切換停writer後重做最新備份。正式user 996:987、產品／queue目錄持久掛載，API沒有queue／submission config掛載，唯一worker沒有--submissions-config；原worker設定hash不變。

停writer備份：`/var/lib/freelance/runtime/compose-stage3b4dd278-stopped-backup.sqlite3`、`compose-stage3b4dd278-queue-backup.sqlite3`；private env回復材料 `/var/lib/freelance/.config/freelance-agent/compose.pre-stage3b4dd278.env`。需要回復時停服務、恢復此env與symlink `/opt/freelance-agent.1b8e22a`，回到backend316e9f6／Web1b8e22a，保留最新產品DB及新增表。此次未啟用submission producer；未來啟用新任務後須遵守compose.md的隔離queue回復程序。本輪未觸發回復，舊image對升級副本回讀已驗證。

目前正式（2026-10-25）：release `/opt/freelance-agent.d994cd2-jb518`，API／worker image `freelance-agent-backend:d994cd2-jb518`（`sha256:42b166903a2274375721902403ddf4c93dd35e9a9018445730ef8c4841f04bf4`），Web 仍 `freelance-agent-web:b4dd278`。與前一版 `d994cd2` 只差 jobbank518.py；停writer備份 `runtime/compose-jb518-d994cd2-backup.sqlite3`，回復改回 symlink `/opt/freelance-agent.d994cd2` 與 `BACKEND_IMAGE=freelance-agent-backend:d994cd2`。經過與驗證見 `docs/plans/2026-10-23-nextjs-vercel-migration.md` 步驟 8 第 3 批「Python 上 VM」。

驗收GET：`/`、`/applications`、`/clients`、`/proposals`、`/submissions`與`/api/submission-capabilities`、`/api/clients`、`/api/proposals`、`/api/submissions`均HTTP200；新清單為空、兩通道not_configured／can_dispatch false。不以HTTP／container健康宣稱下一次自然收案或摘要寄達；本輪不手動重跑daily。

## 未完成工作

- [ ] 使用者後續啟用：Email真實帳號驗收、Freelancer OAuth／sandbox合成投標及正式唯讀能力；本輪不登入、不配置、不投真案。
- [ ] 調整後自然通知：9/30限定Gmail查詢尚無新信；驗命中品質與可解析性後才部署／啟用。正式Resend唯讀43 metadata／3封Indeed，三封headers均無List-ID、recipient正確。Will明確選擇現有Resend驗證方式，Gmail List-ID規則保留；新parse改精確sender／subject，舊inspect List-ID契約保留。
- [ ] 自然Resend首封通知與daily匯入驗收；已配置27包含Glassdoor waiting，不當作成功取得案件，不補轉舊信或重跑daily。

來源每站的限制與下一關卡只更新[平台接通主表](platform-connectivity.md)。已完成輪次、原始TDD與較舊image證據集中在歷史紀錄（私人封存 repo 的 `docs/implementation-history.md`）；不從歷史勾選框恢復待辦。
