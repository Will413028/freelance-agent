# Compose 操作與回復

目前進度／實際上線版本以 [implementation-plan](implementation-plan.md) 為準。本頁描述目標操作，不以文件存在宣稱已部署。

## 資源邊界

- `worker`：Huey scheduler＋單一 worker；API 與 worker 使用相同、固定 release image。
- `api`、`web`：`ui` profile。使用者已授權部署至 VM；API 不發布主機 port，Web 僅 `127.0.0.1:3327`，透過 SSH tunnel 存取。
- `DATA_DIR`：現有產品資料與摘要輸出，檔案保持原名 `freelance-agent.sqlite3`。API／worker 的非 root UID／GID 必須匹配資料擁有者。
- `QUEUE_DIR`：Huey queue.sqlite 與 queue.lock。預設只供 worker 使用；啟用submission override時API也是producer，仍只有一個consumer。替換container不刪除queue。
- `CONFIG_DIR`：唯讀 worker.json 及原有 credentials；不進 Git／image／日誌。
- SQLite 以目錄掛載，包含 journal／WAL sidecars。產品庫與 queue 庫分開，不提供跨庫原子提交。

## 隔離驗收儲存

`scripts/test_compose.py` 使用唯一 Compose project 的專屬 Linux volumes，初始化擁有者後以非 root 執行服務；重建容器仍保留合成資料，結束時只移除該驗收的 containers／network／volumes。正式 VM 沿用既有 Linux 目錄掛載。macOS Docker Desktop 的 host bind mount 已重現持鎖時探測仍能取得鎖，不能用來驗證正式 `flock`／SQLite 語意。初始化容器僅暫時加入 CHOWN／FOWNER；正式服務保留 `cap_drop: ALL`。

## Worker 設定格式

以下為合成格式範例，不是可直接寄信的正式設定。實際値由既有已核准的來源／收件設定轉換，不能讀出或複製到文件。

```json
{
  "database": "/data/freelance-agent.sqlite3",
  "output_dir": "/data",
  "key_file": "/run/config/resend.json",
  "inbox": "synthetic@example.invalid",
  "recipient": "synthetic@example.invalid",
  "live_read": true,
  "live_send": false,
  "free_boards": false,
  "freelancer_read": false,
  "linkedin_read": false,
  "cake_read": false,
  "jobbank104_read": false,
  "talent_read": false
}
```

`live_send` 預設 false；若正式流程已核准寄送，必須指定且只指定 `smtp_config` 或 `sender` 之一。scheduler 本身不讀憑證；用例實際收信／送信時才由 adapter 讀取。中斷的 run 不會因重啟而重新進行來源或寄送呼叫。

## 排程與觀測

前端存取：在自己的電腦執行 `ssh -N -L 127.0.0.1:3327:127.0.0.1:3327 oci-a1`，保持連線後開啟 `http://127.0.0.1:3327`。本機端口必須未被其他服務占用。VM 操作需帶正式 env file，例如 `sudo docker compose --env-file /var/lib/freelance/.config/freelance-agent/compose.env -f /opt/freelance-agent/deploy/compose.yaml -f /var/lib/freelance/.config/freelance-agent/compose.ui.yaml --profile ui ps`。正式 override 顯式回報已啟用收案／Email 排程；這兩個 API flags 只影響顯示，不會啟動收案或寄送。API／Web 的單獨啟停使用 `up -d --wait api web`／`stop api web`，不停止 worker。

台北時間 09:00 後每分鐘觸發檢查，產品 DB 的同日／同 recipient claim 決定能否執行。重啟補當天，排隊的過期日期跳過。`running` 留存代表中斷或尚未結束，必須核對程序與 outbox；不能直接刪 row 讓它重跑。sent、attempted、unknown 的寄送證據不可重設。

容器存活不是工作成功。用 `docker compose -f deploy/compose.yaml ps`／`logs worker` 查程序；業務結果查產品 DB 的 daily_runs、source_health、digest_outbox。來源 partial 與寄送結論分別驗收。API healthcheck 只驗查詢可用；worker healthcheck 只驗 consumer 持有 queue 鎖。兩者都不代表當日來源完整或 Email 送達，unhealthy 不授權重新寄送。

## 切換

1. 核對版本、目前 scheduler／writer、資料權限與實際表狀態；以 SQLite backup API 做一致備份。
2. 新 image 在副本驗 migrate／投影／內容指紋，合成 Compose 驗收通過。正式使用固定 image tag／digest，不掛載應用程式原始碼。
3. 停本專案 API／worker／Web，確認無 writer；重新核對備份與正式資料指紋，必要時建立最新一致備份。顯式 migrate 正式 DB，再切換固定 backend／Web image 與 release symlink，啟用唯一 Huey worker。worker 使用最新正式 DB；不另建會獨立寄送的正式資料副本。
4. 驗容器 UID、掛載、queue.lock、SQLite integrity/FK、既有資料未變及當天已跑不重送；再驗下一次自然排程。
5. 保留切換前 image／release／private env 作回復材料；不變更其他專案或 Docker daemon 的主機管理。

## 回復

先停本專案 API／worker／Web，確認無 writer，核對 run／outbox。將 release symlink、private env 與 backend／Web image 恢復至切換前版本，保留最新產品 DB、新增資料表與原 queue；再啟動唯一 Compose worker 及 API／Web。禁止用部署前備份覆蓋切換後新增的職缺／偏好／投案／寄送證據。新版本 task 名稱或 payload 改變時先處理 pending queue 的相容性，再切 image；不能讓無法辨識的任務靜默遺失。

## 外部提案通道（預設關閉）

本輪使用者選擇先完成程式、不登入或配置；正式Compose維持原flags，沒有掛載submission配置或啟用送出。`deploy/compose.submissions.yaml`僅供後續明確啟用：追加此override讓API掛載queue與唯讀private config，API只入列、唯一worker才讀憑證及呼叫provider。這不改每天摘要的核准或outbox。

`submissions.json`必須是owner擁有的regular 0600檔案，頂層只允許email／freelancer。各通道包含enabled、account、environment、credential_path及verification。Email account為寄件地址、environment只用live，憑證格式沿用既有Gmail SMTP設定；Freelancer account為bidder ID字串、environment為sandbox或live，private credential JSON包含account、environment、oauth_token。不得把實際值寫入Git、image或日誌。

verification是操作者在真實驗收後留下的宣告，不是自動驗證：status為sandbox_verified或live_ready、account／environment須與通道一致，checked_at與evidence須記錄驗收日期及證據。缺驗收時只顯示configured_unverified且不能dispatch。合成測試不能作為正式驗收證據。

不確定Freelancer投標可由已驗帳號執行唯讀查證：

```bash
python -m freelance.bootstrap.submission_operations --database /absolute/path/cases.sqlite3 verify-bid --config /absolute/path/submissions.json --intent UUID --revision 3 --bid 123
```

該操作只GET本人帳號與既有bid，核對案件／bidder／金額／期程／正文再追加provider_verified_accepted；原unknown／attempted結果保留。找不到bid不能推定未投標，不會POST重送。Email人工核對只記user_reported，不宣稱已送達或已讀。

回復到沒有submission_v1的舊worker時：先停止API producer與唯一worker；在新版image執行`submission_operations --database ... cancel-for-rollback`取消尚未attempted的核准。保存最新產品DB及原queue整個目錄（含sidecars），舊daily-only consumer使用另一個owner-only queue目錄；不能讓舊consumer讀取新任務。恢復新版再使用原queue，取消或已attempted的intent不產生外部效果。不能重設attempted／unknown來補送。

## 明確來源設定

worker.json 可改以 `"sources": ["tasker", "linkedin", "talent", "remotive"]` 選取已配置來源；使用此欄位時移除或關閉 freelancer_read/free_boards/linkedin_read/cake_read/jobbank104_read/talent_read。省略sources沿用舊flags與Tasker預設，不會因升版擴大讀取來源。來源ID及runner以 `backend/src/freelance/modules/collection/source_catalog.py` 為準；未有runner者拒絕啟用。CLI相同使用 `--sources tasker linkedin talent remotive`。

前端的設定宣告不等於worker存活；最近每日執行與Email結果由產品run/outbox提供，source最新檢查與較舊每日統計分開標日期。單來源修復不會覆蓋歷史run或冒充重新寄送。

## SQLite 資料與修復

SQLite 是目前單機正式 store，使用 Python 標準函式庫、owner-only 0600 檔案。資料位置由 `--database` 明確指定；文件中的路徑只是範例，不宣稱本機或 VM 有特定筆數。

### SQLite：建表／升級與啟動

先停止該 DB 的 writer、備份，再顯式 migrate；操作可重跑且保留既有資料：

```bash
backend/.venv/bin/python -m freelance.bootstrap.store --migrate --database /absolute/path/cases.sqlite3
backend/.venv/bin/python -m freelance.bootstrap.api --mode sqlite --database /absolute/path/cases.sqlite3
```

API 不自動建 DB 或 fallback Demo。Next.js 開啟方式見 [README](../README.md)。新 DB 不會自動讀任何信件。

本輪新增 `discovery_settings`、`mail_sync_state`、`mail_ingestion`、`mail_content_versions`；原始 source IDs、proposal revisions、tracking、outbox 保留。收藏沿用既有 tracking 表，不建立第二套人工狀態；新職缺不新增 proposal revision。同來源 ID 的每份不同內容以 `(opportunity_id, fingerprint)` 存一筆正規化版本，原職缺列不覆寫。

### SQLite：人工投案

`manual_applications` 管理本人填寫的四階段與日期；`manual_application_opportunities` 關聯來源列；`manual_application_events` 追加稽核事件。建立／更正／軟刪除與事件同交易，request_id防重送，revision防過期覆寫。來源關聯在同交易核對整組member tokens，不以可重算群組ID作主鍵。

不雙寫歷史tracking，不自動推測歷史投案日期；統計只含新人工紀錄。新關聯的ID／revision／deleted_at參與探索操作token，清單與新摘要沿同一排除投影；舊摘要保持不變。手動機會不建立假職缺或receipt。升級只新增表與索引；程式回復保留新表與最新資料。

### SQLite：第三階段工作台

新增九表：`clients`、`client_contacts`、`application_parties`、`proposal_templates`、`proposal_drafts`、`proposal_draft_revisions`、`submission_intents`、`submission_events`、`application_proposals`。客戶名稱不是identity；封存保留歷史快照。模板更正不改既有正文版本；版本、送出快照及追加事件由SQLite triggers保護不可覆寫。

投案階段與跟進日期仍由manual_applications管理。accepted送出證據與人工投案關聯同交易，submission identity防止重複關聯；紀錄失敗不撤銷原送出證據。送出attempt先提交，再離開DB交易連外；attempted／unknown不能自動重送。核對只追加user_reported／provider_verified_accepted，保留原transport結果。

### SQLite：交易

每次操作獨立連線並啟用 foreign keys。寫入使用 BEGIN IMMEDIATE，最多等鎖 5 秒，失敗 rollback；探索清單、偏好、來源與郵件同步紀錄的查詢使用唯讀連線與 BEGIN，不取得預留寫鎖。單機預設 rollback journal；目前沒有需要維護 WAL 或外部資料庫服務的理由。

來源 receipt、職缺與內容版本同一交易；分組收藏的所有 members 同一交易。設定有 revision、人工狀態有 fingerprint + revision token；出現新內容版本也會使舊 token 過期。讀取時使用當前偏好重算資格，只建立回傳投影，不更新舊提案／核准／版本；歷史操作仍在寫入時重新驗證資格。

每日摘要同日／收件者唯一，snapshot 不改；attempt 在 sender 前提交，sent／attempted／unknown 不自動重寄。傳輸失敗不以新 intent 掩蓋舊的未知結果。

### SQLite：備份

使用 SQLite backup API 取得一致快照。範例目標必須是新檔：

```python
import os, sqlite3
from pathlib import Path
source = Path('/absolute/path/cases.sqlite3')
target = Path('/absolute/path/pre-discovery.sqlite3')
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.close(fd)
src = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)
dst = sqlite3.connect(target)
try:
    src.backup(dst)
    assert dst.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert dst.execute('PRAGMA foreign_key_check').fetchall() == []
finally:
    dst.close()
    src.close()
```

回復程式不需要刪除新增表。若必須回復資料，先保存當下 DB 並停止 writer，核對備份之後新增的職缺／收藏／outbox；不能直接以舊檔覆蓋新的人工作業或送信證據。

### SQLite：隔離信件修復

```bash
backend/.venv/bin/python -m freelance.bootstrap.recovery --database /absolute/path/cases.sqlite3 --source tasker --recipient example@inbox.resend.app
backend/.venv/bin/python -m freelance.bootstrap.recovery --database /absolute/path/cases.sqlite3 --source tasker --recipient example@inbox.resend.app --retry MESSAGE_UUID
```

僅列 message ID、狀態、失敗階段與 retry_pending，不列信件正文。重排只接受 rejected ID，保留失敗紀錄與正常掃描游標；下一次原有同步先掃新信，再以剩餘 body／時間預算重讀指定 ID，沿用來源 opt-in 與收件者檢查。暫時讀取失敗保留待重試，不阻擋新信；格式仍不支援則再次隔離。同職缺內容差異的信件是 processed，版本與差異可在清單查看，不用 parser 重試；receipt 碰撞會隔離，須另查證據。修復命令不連外。

### SQLite：歷史邊界

PostgreSQL adapter、舊 proposal 與 application 功能不是目前 UI/API 的選項；保留程式與離線安全測試，不以新探索需求啟用。舊部署證據見 completion-status（私人封存 repo 的 `docs/implementation-history.md`） 的歷史段落，本輪上線步驟見 [implementation-plan](implementation-plan.md)。
