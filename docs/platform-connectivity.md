# 平台連線與資料取得驗證

本文件記錄實際連線驗收；61項平台的費用、資格與取得方式以[平台研究](platform-research.md)逐站表格為準。研究、登入帳號、收到一封通知、公開網頁可讀與每日收案是不同狀態。本頁只管來源接通；系統怎麼運作見[設計](design.md)，怎麼查每日執行見[操作手冊](operations.md)。

**通知與帳號範圍（2026-10-01 核對，之後未重新逐站核對）：** 104首封轉寄至Resend的真實配對日報已正式匯入12筆初篩職缺。Remoters訂閱已確認、待首封職缺信；Glassdoor、SimplyHired、Wellfound通知已啟用。Glassdoor已有通知卡parser及限定未來信轉寄、已排入每日收案，待首封Resend自然職缺信；SimplyHired已有首封真實通知，但卡片連結仍是無可提取職缺ID的追蹤URL；Wellfound仍待樣本。Arc既有通知已驗，Yourator已訂週報，均待真實職缺內容。Indeed新每日信已有22個`jk`職缺ID，四個去追蹤連結在瀏覽器導到不同雇主正文；新模板只有職稱／公司／地點，22卡訊號多不對焦；Indeed的parser沒有移植到現行系統，未排入每日收案。Talent.com英文通知已由9/29自然排程完成Resend真信驗收，1封通知匯入2案。WTTJ登入後明示通知功能改版暫停。Remote.com與Braintrust依使用者決定只保留公開搜尋；NomadBridge本人已送出申請、待平台聯繫；1111排除。Contra／Upwork／Fiverr／PRO360無既有帳號，未新建。YC／Remote.co詢問信已取消，不寄送。

## 現行運作狀態（2026-11-06 切換後）

**本頁「全清單驗收對帳」是全部 61 平台接通狀態的唯一主表。**

- 每日收案的來源共 25 個：來源目錄（`web/src/modules/collection/source-catalog.ts`）裡有 connector 且沒有停用原因的那些。其中 6 個是信件來源（出任務、LinkedIn、Cake、104、Talent.com、Glassdoor），經 Resend Receiving 讀取；其餘 19 個讀公開 API、RSS 或頁面。
- **PTT SOHO、PTT CodeJob 已停用**：Vercel 出口對 PTT 取得 403 challenge，依規則不繞過（遷移計畫 D12）。歷史資料保留。
- 來源目錄另有 5 個沒有 connector 的名稱（FlexJobs、Remoters、Toptal、Guru、Indeed），在 `/sources` 顯示「尚未接通」。目錄共 32 個名稱，不是 61 平台全清單。
- 其餘 33 項未接每日，1111 由使用者排除。

切換後的每日執行（遷移計畫步驟 13 驗收，2026-11-13 查正式資料庫的狀態與計數）：

| 日期 | 結果 |
|---|---|
| 11-06 | ok 20、partial 2（Freelancer、We Work Remotely）、failed 3（LinkedIn、Talent.com、Arbeitnow） |
| 11-07 到 11-13 | 每天 ok 18–19、failed 3–4：同樣三個來源，11-07 另加台灣就業通 |

這三個來源各自失敗的原因尚未逐一查明，本頁不推定。最新狀態看網頁 `/sources`，或正式資料庫的 `source_health` 與 `daily_runs`；不以排程有跑推定來源完整。

## 各來源的讀取限制（2026-09-30 逐來源核對）

以下是切換前最後一次逐來源核對的結果。限制來自來源本身與 connector 的讀取範圍；各 connector 移植時以真實回應比對過輸出相同（遷移計畫步驟 6–9）。筆數是當時的數字。

| 當時狀態 | 平台 | 證據 |
|---|---|---|
| ok | Tasker、LinkedIn、Cake、104、Talent.com、Jobicy、Remotive、Himalayas、Hacker News、V2EX、Real Work From Anywhere、Working Nomads、NoDesk、Get on Board、JustRemote、CryptoJobsList、Dynamite Jobs、518熊班、小雞上工 | 有限來源查詢成功，不代表全站完整。PTT SOHO、PTT CodeJob 當時也是 ok，現已停用 |
| partial | Freelancer | 1636筆／23頁、322初篩、6拒收、limited=true |
| partial | Remote OK | 99筆、1拒收 |
| partial | We Work Remotely | 89筆、1拒收 |
| partial | 台灣就業通 | 1000筆、2拒收、complete_scan=false |
| partial | Arbeitnow | 20頁／2451筆／3初篩、5拒收（4正文正規化為空、1網址指向preiswecker.com而非本站職缺路徑）；truncated=true、pagination_consistent=false |

Arbeitnow：官方`.com` API第11頁回傳的next主機是`.nl`。connector只接受`www.arbeitnow.com`與這個已觀察到的`www.arbeitnow.nl`兩個確切主機，不使用wildcard（`web/src/modules/collection/sources/arbeitnow.ts`）。

其餘partial已唯讀核對：Remote OK99筆中1個invalid canonical URL；WWR89筆中1筆正文超過200,000字元；台灣就業通998有效／2筆缺必要欄位或超過欄位長度。Freelancer三查詢677／546／937有效，reported totals683／549／953、各limited；6拒收＝4 invalid project URL＋2非公開／inactive。這些拒收與未知資格規則維持，沒有為轉綠放寬。

## 全清單驗收對帳 — 更新至 2026-09-30

依 platform-research 四張逐站表逐列對帳：台灣14＋海外21＋人才12＋其他14＝61。以下分類互斥；25項每日收案、2項停用（PTT）、33項未接每日、1項使用者排除。各列的帳號與通知證據是2026-09-30的核對結果；最新健康狀態以`/sources`為準。

| 狀態／數量 | 全部對應平台 | 尚缺的完成證據／下一步 |
|---|---|---|
| 已配置每日讀取 20 | 出任務、Freelancer、Jobicy、Remotive、Himalayas、Hacker News、V2EX、Remote OK、Real Work From Anywhere、台灣就業通、We Work Remotely、Working Nomads、Arbeitnow、NoDesk、Get on Board、JustRemote、CryptoJobsList、Dynamite Jobs、518熊班、小雞上工 | 9/29自然run已核對，518仍為已確認空結果；Freelancer／Remote OK／台灣就業通／Arbeitnow／We Work Remotely為partial，Tasker單來源恢復成功，其餘正常。仍不代表全站全量 |
| 停用 2 | PTT SOHO、PTT CodeJob | Vercel 出口對 PTT 取得 403 challenge（遷移計畫 D12）；不繞過存取驗證，維持停用。歷史職缺保留 |
| 郵件每日真實收信已驗 4 | LinkedIn、Cake、104、Talent.com | 四站health=ok。Talent於9/29自然排程首次由Resend匯入1封／2案；LinkedIn管理連結模板已修復，停用提醒記為非職缺通知，隔離歸零。缺正文及未知資格／工時保留unknown |
| 訂閱成功待內容 1 | Yourator | 首封含職缺的週報及parser，不以訂閱確認信驗收 |
| 已登入實讀待通知 1 | Arc | 既有Email提醒啟用，但未有職缺信；Account Email已驗證 |
| 訂閱已確認、待職缺通知 1 | Remoters | 本輪讀到9/27確認信，沿已授權訂閱點擊確認，官方頁顯示 Subscription Confirmed；待第一封實際職缺信才能驗parser／轉寄／daily整合 |
| 使用者排除 1 | 1111 | 2026-09-26 明確不使用，已移出待接通清單；不再要求登入、訂閱或整合 |
| API先決條件未完成 2 | Idealist、Web3.career | Idealist免費申請已寄，等核發；Web3申請必填真實使用網站URL，本專案沒有可提供的公開網址，未提交 |
| 存取驗證阻擋 1 | Guru | 已讀8正文但遭challenge停止；需官方通知／授權通道，不換IP繞過 |
| 已配置通知等待首封 1 | Glassdoor | 通知卡parser與共用增量同步已在每日收案內；限定未來轉寄已保存。2026-10-01有限檢查43 metadata／0匹配、waiting，待自然Resend通知／daily匯入。新信13個ID已驗；同ID去追蹤詳情起初challenge，後續同分頁可讀全職QA正文，不接crawler |
| 通知已訂閱待接入 2 | SimplyHired、Wellfound | SimplyHired 9/28首封20張摘要卡只有不透明`engage.indeed.com`追蹤URL；Wellfound待樣本。不重建訂閱 |
| 使用者選擇僅公開搜尋 2 | Remote.com Jobs、Braintrust | 暫不建帳或訂閱、不接每日crawler，帳號問題已結束 |
| 其他官方通道尚未驗收 5 | 打工探吉、Indeed、YC Jobs（含Work at a Startup）、Welcome to the Jungle、Remote.co | 打工探吉未找到Email職缺通知；Indeed已於9/30將既有提醒改為「軟體 兼職」／台灣／每日，重新載入確認已啟動且提醒ID不變；待調整後自然通知驗命中品質。舊新模板有穩定`jk`，但現行系統沒有Indeed的parser與每日connector；YC／Remote.co詢問信已取消，兩站不抓取；WTTJ官方通知改版暫停 |
| 本人申請已送、待聯繫 1 | NomadBridge | 本人回報9/26已送出，不重送；費用／入網／案件仍待平台確認 |
| 本人入網／資格／個人任務 8 | A.Team、Gun.io、Proxify、Toptal、Turing、Outlier、DataAnnotation、TELUS Digital AI Community | 需本人入網、資格或測驗；個別帳號進度屬個人資料，不記在公開 repo。公開職缺不等於私人任務池已接通 |
| 帳號市場或賣方服務 4 | Contra、Fiverr、Upwork、PRO360 | 本人確認四站皆無帳號，該問題結束。Contra全feed需Pro；Upwork摘要徽章條件；Fiverr服務配對；PRO360免費配對信但報價付費。未新建帳或公開上架 |
| API需核准 1 | Reddit r/forhire | 官方Responsible Builder政策要求核准，未有資格／授權；不把能讀RSS當已獲准 |
| 不符合免費每日案件來源用途 4 | PTT Soft_Job、TDNA、1111 CASE+、FlexJobs | Soft_Job禁止短期發包（導CodeJob），可另看長期職缺；TDNA是社群；CASE+已停站；FlexJobs完整庫付費。保留資訊，但無法在免費條件下把四者都當每日案件API |

全部61項均已對應，不新增第二份master list。24項已驗列表／通知讀取（518分類在9/30為0結果），Glassdoor另1項每日監看等待首封正式通知，PTT 2項停用，1項（1111）由使用者排除，其餘33項未接入每日運作；後者包括不適用來源，不代表33項都能做成connector。仍可執行的工作包括適用官方通道的帳號驗收、現有來源覆蓋改善；涉及本人測驗／未知身份資料／供應商核發的部分無法用代碼完成。

## 歷史證據

各次平台實查與通知設定的過程不放在公開 repo；舊版本頁可從 git 歷史取回。歷史的 waiting 與版本不覆蓋本頁現況。
