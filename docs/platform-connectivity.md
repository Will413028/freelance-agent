# 平台連線與資料取得驗證 — 現況同步 2026-10-01

**目前帳號／範圍：** 104首封轉寄至Resend的真實配對日報已正式匯入12筆初篩職缺。Remoters訂閱已確認、待首封職缺信；Glassdoor、SimplyHired、Wellfound通知已啟用。Glassdoor已部署通知卡parser及限定未來信轉寄、worker已啟用，待首封Resend自然職缺信；SimplyHired已有首封真實通知，但卡片連結仍是無可提取職缺ID的追蹤URL；Wellfound仍待樣本。Arc既有通知已驗，Yourator已訂週報，均待真實職缺內容。Indeed新每日信已有22個`jk`職缺ID，四個去追蹤連結在瀏覽器導到不同雇主正文；新模板只有職稱／公司／地點，22卡訊號多不對焦，已部署離線parser能力但未啟用每日入口。Talent.com英文通知已由9/29自然排程完成Resend真信驗收，1封通知匯入2案。WTTJ登入後明示通知功能改版暫停。Remote.com與Braintrust依使用者決定只保留公開搜尋；NomadBridge本人已送出申請、待平台聯繫；1111排除。Contra／Upwork／Fiverr／PRO360無既有帳號，未新建。YC／Remote.co詢問信已取消，不寄送。

本文件記錄實際連線驗收；61項平台的費用、資格與取得方式仍以`docs/platform-research.md`逐站表格為準。研究、登入帳號、收到一封通知、公開網頁可讀與VM每日收案是不同狀態。

## 最新運作狀態（2026-10-01 正式核對）

第三階段b4dd278已部署API／worker／Web，外部送出通道未配置；正式版本、驗收及回復材料以[implementation-plan](implementation-plan.md)為準。本頁管理來源接通狀態，搜尋／收案與平台投案通道是不同能力。

**本頁「全清單驗收對帳」是全部 61 平台接通狀態的唯一主表。** 已配置每日來源27個＝21 `ok`＋5 `failed`（這5個最新有限讀取結果均為partial）＋1 `waiting`（Glassdoor）；其餘33項未接每日，1111另由使用者排除。dashboard registry另有5個`not_connected`（含Indeed離線能力），共32名稱，不是61平台全清單。

前輪Glassdoor發布時API／worker為ac08c78、Web為6bd8596；559項測試（22PG略過）、VM14項／boundary／OpenAPI／wheel通過。新增source projection之外，既有投影及部署切換14表指紋不變。個人Gmail已保存限定sender＋兩種已驗主旨的未來轉寄，舊信未勾選；本人passkey驗證已結束，無待登入交接。worker用sources保留原26項並加入Glassdoor；有限實讀43筆Resend metadata、0matching／0body，source-only結果waiting，只變mail_sync_state／source_health。下一封自然通知與daily匯入仍待驗，不以waiting當成功收案。部署／設定回復見現行plan。

9/30 09:00自然run已結束，daily=`failed`、outbox=`sent`（僅DB寄送證據，本輪未核對Gmail收件）。當時正式706案／724 receipts。本輪來源修復後708案／726 receipts；只做受限source-only續讀，不重跑daily或寄信。

| 本次狀態 | 平台 | 最新source-only／9/30 daily 證據 |
|---|---|---|
| ok（21） | Tasker、LinkedIn、Cake、104、Talent.com、Jobicy、Remotive、Himalayas、Hacker News、V2EX、PTT SOHO、PTT CodeJob、Real Work From Anywhere、Working Nomads、NoDesk、Get on Board、JustRemote、CryptoJobsList、Dynamite Jobs、518熊班、小雞上工 | 有限來源查詢成功，不代表全站完整 |
| partial | Freelancer | 1636筆／23頁、322初篩、6拒收、limited=true |
| partial | Remote OK | 99筆、1拒收 |
| partial | We Work Remotely | 89筆、1拒收 |
| partial | 台灣就業通 | 1000筆、2拒收、complete_scan=false |
| partial | Arbeitnow | 本輪已恢復20頁／2451筆／3初篩、5拒收（4正文正規化為空、1網址指向preiswecker.com而非本站職缺路徑）；truncated=true、pagination_consistent=false。正式與相同輸入重播0新增，舊09:00來源failed紀錄保留 |
| 恢復ok | Talent.com | 09:00為fetch失敗；本輪副本與正式續讀2封、2初篩／2新案、0error／0quarantine、complete_scan=true。daily／outbox／舊案／人工狀態保留，未人工寄信 |

核對命令：SQLite唯讀 `SELECT status,COUNT(*) FROM source_health GROUP BY status`、`SELECT COUNT(*) FROM opportunities`、`SELECT COUNT(*) FROM source_receipts`；目前run／delivery／逐來源觀測由正式 `GET /api/dashboard` 的 `operations`核對。

9/30來源修復已部署：API／worker固定image `cc04a9d`、Web `6bd8596`。Arbeitnow第11頁官方`.com`API回傳next主機`.nl`，原strict gate中止整批；修正只接受這個已觀察exact alias，驗path／頁碼／query後重建固定`.com`URL，20個實際request均在primary。`.nl`公開站也連回primary API；不使用wildcard、不跟隨redirect、不擴充職缺canonical hosts。

556本機測試（22PG略過）、boundary／wheel通過；VM17項Arbeitnow測試通過，positive驗實際requests只到primary，negative仍拒絕evil／suffix／回圈／額外query。部署副本新舊投影同、切換指紋不變，單worker healthy、API healthy、Web200。Source-only收案與重播均驗保護表不變；最新備份prefix`runtime/compose-arbeitnowcc04a9d-`、env回復`compose.pre-cc04a9d.env`，保留最新product與queue DB。Talent前置備份`runtime/compose-recovery20260930-`。詳細執行證據見implementation-plan。

其餘partial已唯讀核對：Remote OK99筆中1個invalid canonical URL；WWR89筆中1筆正文超過200,000字元；台灣就業通998有效／2筆缺必要欄位或超過欄位長度。Freelancer三查詢677／546／937有效，reported totals683／549／953、各limited；6拒收＝4 invalid project URL＋2非公開／inactive。這些拒收與未知資格規則維持，沒有為轉綠放寬。

## 全清單驗收對帳 — 更新至 2026-09-30

依 platform-research 四張逐站表逐列對帳：台灣14＋海外21＋人才12＋其他14＝61。以下分類互斥；27項已配置、33項未接每日、1項使用者排除。最新健康與讀取範圍以本頁最上方正式狀態表為準。

| 狀態／數量 | 全部對應平台 | 尚缺的完成證據／下一步 |
|---|---|---|
| 已配置每日讀取 22 | 出任務、Freelancer、Jobicy、Remotive、Himalayas、Hacker News、V2EX、PTT SOHO、PTT CodeJob、Remote OK、Real Work From Anywhere、台灣就業通、We Work Remotely、Working Nomads、Arbeitnow、NoDesk、Get on Board、JustRemote、CryptoJobsList、Dynamite Jobs、518熊班、小雞上工 | 9/29自然run已核對，518仍為已確認空結果；Freelancer／Remote OK／台灣就業通／Arbeitnow／We Work Remotely為partial，Tasker單來源恢復成功，其餘正常。仍不代表全站全量 |
| 郵件每日真實收信已驗 4 | LinkedIn、Cake、104、Talent.com | 四站health=ok。Talent於9/29自然排程首次由Resend匯入1封／2案；LinkedIn管理連結模板已修復，停用提醒記為非職缺通知，隔離歸零。缺正文及未知資格／工時保留unknown |
| 訂閱成功待內容 1 | Yourator | 首封含職缺的週報及parser，不以訂閱確認信驗收 |
| 已登入實讀待通知 1 | Arc | 既有Email提醒啟用，但未有職缺信；Account Email已驗證 |
| 訂閱已確認、待職缺通知 1 | Remoters | 本輪讀到9/27確認信，沿已授權訂閱點擊確認，官方頁顯示 Subscription Confirmed；待第一封實際職缺信才能驗parser／轉寄／daily整合 |
| 使用者排除 1 | 1111 | 2026-09-26 明確不使用，已移出待接通清單；不再要求登入、訂閱或整合 |
| API先決條件未完成 2 | Idealist、Web3.career | Idealist免費申請已寄，等核發；Web3申請必填真實使用網站URL，私人VM目前無對應網址，未提交 |
| 存取驗證阻擋 1 | Guru | 已讀8正文但遭challenge停止；需官方通知／授權通道，不換IP繞過 |
| 已配置通知等待首封 1 | Glassdoor | ac08c78 parser及共用增量sync已部署；限定未來轉寄已保存、原26來源不變、新增Glassdoor opt-in。正式有限檢查43 metadata／0匹配、waiting，待自然Resend通知／daily匯入。新信13個ID已驗；同ID去追蹤詳情起初challenge，後續同分頁可讀全職QA正文，不接crawler |
| 通知已訂閱待接入 2 | SimplyHired、Wellfound | SimplyHired 9/28首封20張摘要卡只有不透明`engage.indeed.com`追蹤URL；Wellfound待樣本。不重建訂閱 |
| 使用者選擇僅公開搜尋 2 | Remote.com Jobs、Braintrust | 暫不建帳或訂閱、不接每日crawler，帳號問題已結束 |
| 其他官方通道尚未驗收 5 | 打工探吉、Indeed、YC Jobs（含Work at a Startup）、Welcome to the Jungle、Remote.co | 打工探吉未找到Email職缺通知；Indeed已於9/30將既有提醒改為「軟體 兼職」／台灣／每日，重新載入確認已啟動且提醒ID不變；待調整後自然通知驗命中品質。舊新模板有穩定`jk`、可用通知卡needs_info路徑，但尚未建立每日connector；YC／Remote.co詢問信已取消，兩站不抓取；WTTJ官方通知改版暫停 |
| 本人申請已送、待聯繫 1 | NomadBridge | 本人回報9/26已送出，不重送；費用／入網／案件仍待平台確認 |
| 本人入網／資格／個人任務 8 | A.Team、Gun.io、Proxify、Toptal、Turing、Outlier、DataAnnotation、TELUS Digital AI Community | 需本人入網、資格或測驗；個別帳號進度屬個人資料，不記在公開 repo。公開職缺不等於私人任務池已接通 |
| 帳號市場或賣方服務 4 | Contra、Fiverr、Upwork、PRO360 | 本人確認四站皆無帳號，該問題結束。Contra全feed需Pro；Upwork摘要徽章條件；Fiverr服務配對；PRO360免費配對信但報價付費。未新建帳或公開上架 |
| API需核准 1 | Reddit r/forhire | 官方Responsible Builder政策要求核准，未有資格／授權；不把能讀RSS當已獲准 |
| 不符合免費每日案件來源用途 4 | PTT Soft_Job、TDNA、1111 CASE+、FlexJobs | Soft_Job禁止短期發包（導CodeJob），可另看長期職缺；TDNA是社群；CASE+已停站；FlexJobs完整庫付費。保留資訊，但無法在免費條件下把四者都當每日案件API |

全部61項均已對應，不新增第二份master list。更新至9/30：26項已驗列表／通知讀取（518分類當前0結果），Glassdoor另1項每日監看等待首封正式通知，1項（1111）由使用者排除，其餘33項未接入每日運作；後者包括不適用來源，不代表33項都能做成connector。仍可執行的工作包括適用官方通道的帳號驗收、現有來源覆蓋改善；涉及本人測驗／未知身份資料／供應商核發的部分無法用代碼完成。

## 歷史證據

各次平台實查、通知設定及部署過程保存在歷史紀錄（私人封存 repo 的 `docs/implementation-history.md`）；歷史waiting與版本不覆蓋本頁現況。
