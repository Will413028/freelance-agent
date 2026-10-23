# 免費兼職與遠端平台完整研究

**現行接通狀態已於2026-09-29同步至 [platform-connectivity.md](platform-connectivity.md)：61項中26項配置每日監看（21 ok、4 failed、1 waiting），34項未接每日，1111由使用者排除；正式庫611案。Freelancer擴大實讀仍partial，LinkedIn／Cake／104已實際處理通知，Talent.com仍waiting。此處保留研究日期的費用、資格與歷史判斷；下方早期「未接通」不是現行部署狀態，操作判斷以接通主表為準。**

查核日期：2026-09-19。已覆蓋原目錄55項及原始需求／待查段落6項（Toptal、PTT CodeJob、PTT Soft_Job、1111 CASE+、PRO360、Remote.co），**共61項研究對象**。其中含社群、人才庫與停站服務，不是61個有效案源，也不是61個connector。

範圍：公開官方網站、FAQ、費用頁、開發者文件與官方搜尋索引；沒有登入、註冊、申請API key、訂閱通知、付費或聯絡平台。費用未公開者已列具體未知項，未假稱研究可取代本人資格審核。全文是研究與選擇依據，不把平台研究算成已接通的來源。

## 平台資訊核對進度（2026-09-25）

**61 項都有 9/19 的逐站公開資訊**，見下方四張表：台灣 14 項、海外職缺板 21 項、人才／任務網絡 12 項、費用限制與社群 14 項。每列分別記錄費用、台灣／兼職條件、帳號或審核門檻，以及案件取得方式與官方依據。今天重新核對的是下列容易影響免費使用判斷的官方頁；其餘逐站結論沿用 9/19 的日期，**沒有聲稱 61 站今天都完成帳號內驗證**。

| 取得方式／現況 | 平台與資訊 | 仍須核實 |
|---|---|---|
| 已由 VM 每日連接 | 出任務、Jobicy、Remotive、Himalayas、Hacker News、V2EX、PTT SOHO、PTT CodeJob、Remote OK、Real Work From Anywhere、台灣就業通、We Work Remotely、Working Nomads、Freelancer、Arbeitnow、NoDesk、Get on Board、JustRemote、CryptoJobsList；前15個已有排程執行紀錄（含失敗／partial），NoDesk／Get on Board已首次匯入，JustRemote真實收案0候選，待9/27自然排程 | 每案台灣資格、工時、預算與是否仍開放；Remote OK／台灣就業通壞紀錄仍partial；WWR／Working Nomads免費應徵資格逐案確認；Freelancer投標有餘額門檻，Arbeitnow首250筆目前0匹配且有下一頁 |
| 可取得免費官方通知、尚未接入 | [Working Nomads](https://www.workingnomads.com/subscribe)日／週信可選 Development、Part-time、Freelance/Contract、地區與關鍵字，但目前已用[公開API](https://www.workingnomads.com/api/exposed_jobs/)接每日，不必等訂閱；[Remoters](https://remoters.net/remote-job-board-faqs/)分類免費提醒；[NoDesk](https://nodesk.co/newsletter/)免費週信；[LinkedIn](https://www.linkedin.com/help/talent-insights/answer/a511279)帳號內日／週提醒最多20組，已建一組目標提醒 | Remoters／NoDesk須實際通知樣本；LinkedIn等新提醒與安全轉寄後才可接VM，不抓取LinkedIn網站 |
| 公開免費入口，可人工逐案確認 | [Tasker](https://www.tasker.com.tw/taskergo)一般提案免費、搶先提案需 T Points；[JustRemote](https://justremote.co/remote-developer-jobs)公開 Developer 列表可選 Contract；[We Work Remotely](https://weworkremotely.com/frequently-asked-questions) Boosted Jobs 可免 Pro 直接申請；[NoDesk](https://nodesk.co/remote-jobs/)公開閱讀／申請不需帳號 | 雇主外站、免費聊聊額度、台灣資格和實際週工時逐案核對 |
| 先入人才庫，再由平台媒合 | [Arc](https://arc.dev/talent)人才端免費、Freelance 合約通常 20–40h／週；[NomadBridge](https://nomadbridge.dna.org.tw/) Early Access、先前後端，申請表收可投入時數；[Toptal](https://www.toptal.com/talent/apply)需通過審核 | 本人資料／測驗、是否接受台灣、實際案量；NomadBridge 的加入／代開票費用仍未公開確認；Toptal 尚未通過審核 |
| 免費瀏覽不等於零支出投案 | [Guru](https://www.guru.com/pricing-freelancer/) Basic 10 bids／月、9% job fee，另有 [US$4.95 ID 驗證費](https://www.guru.com/help/freelancer/about-id-verification-freelancer/)；[Freelancer](https://www.freelancer.com/feesandcharges) 初始 6 bids／月，但標準投標前須可用餘額 US$20；[Upwork](https://support.upwork.com/hc/en-us/articles/211062898-Understanding-and-using-Connects) Basic 免費，10 個免費 Connects 依帳號優惠而定；[FlexJobs](https://www.flexjobs.com/faq) 完整職缺／應徵需付費訂閱 | 不假設本人已滿足驗證、餘額或 Connects，也不為取得資料而付款 |

補充核對：[Contra](https://contra.com/how-it-works/independents) 可免費建 profile、找工作與收取零平台抽成款項，Pro 提供額外曝光／功能；[出任務免費方案](https://www.tasker.com.tw/pricing)可同時刊登 3 項服務，免費聊聊有月額限制。[JustRemote PowerSearch](https://justremote.co/power-search) 首月 US$6；公開列表與加值搜尋應分開。[Freelancer 費用表](https://www.freelancer.com/feesandcharges) 現寫標準 US$20 餘額適用於投標前，較舊 Help 頁對「部分案件」的措辭保守；以投標畫面與最新費用表確認個案。這些官方頁的價格、額度可能再變，引用時保留查核日期。

**公開資訊的界線：** 61 站的公開研究已可用來排除付費或不適配選項；能否在本人帳號免費提案、收到哪種通知、通過人才庫審核、是否有適合 20–30h 的即時案件，仍須帳號內畫面或真實通知／案件證據。研究完成不等於已註冊、訂閱、接入每日或應徵。

本人確認已有 LinkedIn、104、Cake、Working Nomads、Remoters、Arc 帳號，原表示六站皆未設定符合本專案的新案 Email 提醒。對其 Gmail 近90天唯讀核對：LinkedIn 有既存 `jobalerts-noreply@linkedin.com` 職缺摘要，正文有可去追蹤參數的職缺 ID；Cake 有 `notifications@no-reply.cake.me` 的追蹤公司新職缺通知，但案件按鈕只有郵件追蹤轉址，不能直接保存為 canonical job URL；104 僅找到廣告信，Working Nomads／Remoters／Arc 未找到通知。9/25 隨後在已登入 LinkedIn 官方介面**新建 AI agent／Asia／Remote／Part-time 或 Contract 每日 Email 通知**，管理頁確認啟用；尚未收到新提醒樣本，也未轉入 VM。Arc 另需區分人才媒合資格與一般搜尋提醒。其他研究對象仍依逐站表格的免費資格、官方資料介面與網站用途判斷；付費門檻、停站與純社群不能為湊 61 個來源而假裝接通。

## 歷史研究：建議優先順序（現行工作以接通主表為準）

以下排序是依你的條件作出的判斷：AI agent開發優先、AI整合／後端API／MVP、台灣UTC+8、每週20–30小時、固定案至少NT$3,000、免費優先。固定案最低金額不能套成時薪。

| 工作線 | 優先對象 | 下一步與實際限制 |
|---|---|---|
| 維持已運作 | 出任務、PTT SOHO、Hacker News、V2EX、Himalayas、Jobicy、Remotive | 已接通仍要篩資格／工時／預算；此輪未重跑daily或新增案件 |
| 下一批資料介面評估 | Real Work From Anywhere RSS → PTT CodeJob公開板 → 台灣就業通Open Data | 第一項有正式免費RSS；第二項技術外包適配高但需另驗有限收案；第三項介面正式但技術兼職密度與新鮮度待實測。不是看到API就先加大量低適配資料 |
| 下一批官方通知評估 | Working Nomads、Remoters、NoDesk、104、Cake、Yourator、LinkedIn | 有免費部分／官方通知證據；需本人既有帳號或訂閱及樣本，解析完成前不算接通。LinkedIn只走官方通知或人工搜尋 |
| 人才平台入網 | Arc → NomadBridge（先確認費用）→ Braintrust → Toptal → A.Team → Gun.io | Arc有台灣人才與兼職證據；NomadBridge符合跨境偏好但費用未知；Toptal目前未通過審核；A.Team題目對口但重production實績。作品kit已備妥，審核需本人完成 |
| 次要資料介面 | Remote OK免費API、Web3.career、CryptoJobsList、Arbeitnow | Remote OK免費應徵範圍逐案；Web3兩站需API申請／題材適配；Arbeitnow多德國工作權限制。未申請key或實作 |
| 額外收入而非agent作品 | Outlier、TELUS；DataAnnotation台灣資格待明確 | 前兩者有台灣入口，主要AI評估／資料任務，與企業AI agent建置分開；不保證穩定每週20–30h |
| 暫不優先 | FlexJobs、Freelancer、Guru、Upwork、PRO360；Proxify時區待答覆 | 分別有訂閱、投標餘額、驗證費／抽成、Connects、聯繫報價費或UTC+8不明；詳細差異見表，不把所有費用叫提案費 |
| 排除／改用途 | CASE+；Soft_Job；TDNA | CASE+已停站；Soft_Job不作短期發包主力；TDNA作交流而非獨立案件池 |

## 重要更正

- 出任務有官方免費提案說明；提案、接受後聊聊、搶先／自動提案與加值額度是不同環節，不宣稱無限制全免費。
- Working Nomads有免費公開應徵與免費日／週提醒；WWR有免訂閱Boosted Jobs子集；Remote OK有免費API。三者都不能因存在Premium而整站排除。
- Freelancer投標前標準最低可用餘額US$20；Guru有US$4.95 ID驗證費；Upwork免費Connects非人人固定發放。
- CASE+官方公告2025-08-29下線；Soft_Job板規將發包與短期徵人導向CodeJob。
- Taiwan／APAC／Contract只是初篩欄位；Contract仍可能40h全職，人才目錄出現台灣工程師也不等於每個任務接受台灣。
- Himalayas官方MCP/API/RSS可讀公共資料，但官方文件明確說目前不能直接代用戶投遞；tracker更新不等於已應徵。[官方AI介面文件](https://himalayas.app/docs/ai-agents)

## 研究完成的界線

每一項都有費用／資格／收案路徑或明確未知結論與官方依據。未完成的是帳號資格、私有費率、本人測驗、實際通知樣本、API key申請與connector實作；這些不以公開資料推定已通過。研究後新增的具體案件仍須回到原雇主確認是否在募，不能拿搜尋索引的舊職缺當今天新案。

## 台灣案源研究（2026-09-19）

純公開資料研究，未登入、申請、提案、付費或實作。目標：台灣 UTC+8、每週 20–30 小時，AI agent 優先，再 AI 整合／後端 API／全端 MVP；固定案 TWD 3,000 為使用者篩選底線，不是平台最低保障。下表適配是研究判斷，所有案件仍須逐筆確認遠端、工時、預算與開放狀態。「未查得 API/RSS」只表示本次沒找到官方公開開發者文件，不能推定不存在或允許爬取。信心對公開政策，不代表已驗證帳號流程。

| 平台 | 搜尋／應徵／成交費 | 台灣、遠端、兼職與適配 | 帳號／審核 | 收案途徑與官方依據 | 信心／待確認 |
|---|---|---|---|---|---|
| 104 | 官方求職會員服務免費；一般求職非報價競標，未見求職成交抽成條款 | 台灣職缺及兼職入口；技術職適配中高，但 remote 不自動等於 20–30h | Email 驗證、啟用找工作與履歷 | 手動搜尋、配對信／App；未查得公開求職收案 API/RSS。[會員FAQ](https://www.104.com.tw/faq/member)、[通知FAQ入口](https://www.104.com.tw/faq/index) | 高；個別職缺工時與實際通知格式待驗 |
| Cake | 官方求職／作品集免費；一份免費履歷，更多履歷功能另付費；一般求職未見成交抽成 | 台灣／跨國科技職，篩兼職、接案、遠端；適配中高，逐案確認台灣雇用資格 | 平台帳號、履歷／profile；未查得普遍技術入網審核 | 可儲存搜尋條件，定期職缺推播；公司追蹤通知；未查得公開收案 API/RSS。[官方App FAQ](https://www.cake.me/app?locale=zh-TW)、[通知教學](https://help.cake.me/zh-TW/articles/11532180-如何掌握最新職缺資訊) | 高；跨國職缺地區與20–30h待驗 |
| 出任務 Tasker | 免費瀏覽／註冊、保留使用者確認之平台免費提案；官方一般提案「任何專家皆可使用」，pricing亦提免費提案被接受的聊聊。付費搶先／自動提案、曝光與聊聊另計；成交抽成完整條款未知 | 台灣商業外包，程式／API／網站需求，適配高；預算及遠端逐案篩 | 專家帳號／工作室；Top專家有身分與成交品質篩選，不能把Top門檻當所有人的技術入網審核 | 案件列表、平台通知（現有目錄記已接通知，非本次驗收）；未查得公開API/RSS。[提案教學](https://tasker.com.tw/help/article/110)、[方案](https://www.tasker.com.tw/pricing)、[關於](https://tasker.com.tw/about-us) | 高：免費路徑存在；方案同時有舊字樣／限時聊聊額度，完整免費提案限制待本人既有介面核對；不得因此排除 |
| Yourator | 官方企業方案頁明示旗下求職服務不向求職者收任何服務費；不應列費用未知 | 新創／數位人才，科技職適配中高；台灣公司多，兼職／遠端依職缺 | 帳號與履歷、企業自行甄選；未見普遍技術入網審核 | 手動職缺、每週職涯成長報（含職缺，非精準API）；未查得公開API/RSS。[費用聲明](https://www.plans.yourator.co/job-posting-pricing)、[電子報](https://www.yourator.co/articles/515)、[求職規約](https://www.yourator.co/privacy) | 高費用／中適配；精準職缺通知規格待驗 |
| 1111（使用者已排除，僅歷史研究） | **2026-09-26 使用者決定不使用，移出接通清單。** 官方明示註冊、履歷、投遞與求職服務全免費；一般求職非成交抽佣 | 台灣兼職／打工／實習與全職；技術兼職適配中，排除必須全職者 | 真實姓名與身分資料、驗證、履歷；外籍可護照／居留證 | 每日多組職缺配對通報、企业通知、手動搜尋；未查得公开API/RSS。[官方FAQ](https://www.1111.com.tw/QA/faq_search?ks=%E8%A8%BB%E5%86%8A) | 高；職缺型態與時數待逐案核實 |
| 518熊班 | 求職規約明示免費履歷／瀏覽／配對；本次未找到應徵或成交另收費證據，但不把有限免費文字擴成所有產品零費用 | 台灣兼職為可用補充，一般工作多，AI／API適配偏低 | 求職帳號、履歷；本次未核實最新驗證流程 | 手動搜尋、收藏／配對服務；未查得公開API/RSS。[求職規約](https://www.518.com.tw/help-helpser.html?p=rule)、[兼職入口](https://www.518.com.tw/job-index.html?ai=2) | 中；應徵免費的獨立完整條款／通知交付形式待補 |
| 小雞上工 | 官方規約明示免費履歷／瀏覽與配對；未查得求職成交抽成，企業加值收費不能套用求職者 | 台灣短期／兼職，官網有遠端在家篩選，AI／軟體案適配偏低 | 主要App求職流程；帳號／履歷，最新求職驗證細節未核實 | 手動網頁／App、收藏配對；部分進階篩選提示須App；未查得公開API/RSS。[規約](https://app.chickpt.com.tw/rule)、[入口](https://www.chickpt.com.tw/) | 中；完整應徵費用與通知設定待補，不假稱已登入 |
| 打工探吉 | 官方明示註冊、履歷、主動聯絡企業及求職服務免費 | 台灣打工，技術案適配低；104旗下，來源需去重 | 共用104帳號；身分資料、履歷，可匯入104履歷 | 手動搜尋／應徵、公司回覆Email通知；未查得公開API/RSS。[完整FAQ](https://tanji.104.com.tw/c/faq) | 高；通知為公司回覆，不應誤稱新案件訂閱 |
| 台灣就業通 | 官方求職求才全免費；官方Open Data亦免費 | 台灣職缺、兼職依職務性質；AI案適配中低但可低成本篩選 | 網站應徵需一般會員／履歷；公開資料集不等於需要求職登入 | **官方API／CSV／JSON**，含職務性質、時間、薪資、內容、截止日、更新日；單次最多1000筆，另手動求職／媒合。[求職FAQ](https://job.taiwanjobs.gov.tw/internet/index/docList.aspx?uk=1420)、[政府官方資料集](https://data.gov.tw/dataset/44062)、[介接說明](https://free.taiwanjobs.gov.tw/webservice_taipei/A17000000J-030144-Taiwanjobs-OpenData.pdf) | 高API文件；未實測端點新鮮度／分页，metadata更新頻率寫每年，不保證即時 |
| PTT SOHO | PTT免費平台，公開讀文無提案代幣／成交流程；案主依文中聯絡方式直接接洽 | 台灣自雇外包，技術徵才適配高；排自介、公告、閉案、低於TWD3000 | 公開閱讀免登入；站內信／發文需認證帳號與各板權限 | 公開列表／正文手動讀取，未查得官方RSS／收案API；現有目錄記已接有限讀取，非本次部署。[板入口](https://www.ptt.cc/bbs/soho/index.html)、[板規](https://www.ptt.cc/bbs/soho/M.1471033318.A.3B2.html)、[帳號認證教學](https://www.ptt.cc/bbs/AppsForBBS/M.1627276910.A.F17.html) | 中高；本次列表403不代表不可用；發文權限與聯絡法逐案確認 |
| PTT CodeJob | 免費公開論壇，非平台報價／支付抽成流程 | 程式外包直接適配高，官方列表可見AI後端／全端需求；排自介、學業代作與閉案 | 同PTT；若案文給Email可依文中方式聯繫，只有站內信則需帳號 | 官方公開列表／正文，未查得官方RSS／API。[官方列表搜尋索引](https://www.ptt.cc/bbs/CodeJob/index.html)、[帳號認證](https://www.ptt.cc/bbs/AppsForBBS/M.1627276910.A.F17.html) | 中高；本次官方索引可讀、直接open403，非停站；索引較舊不可當最新在募案 |
| PTT Soft_Job | 官方板規明示PTT免費平台；徵才直接聯繫，非支付平台 | **低優先：置底禁止發包、短期徵人及派遣並導向CodeJob**；可補充長期技術職，但不能列短期外包主力 | 同PTT；公開讀文／各板發文權限分開 | 官方列表／[徵才]手動；未查得官方RSS／API。[官方置底板規](https://www.ptt.cc/bbs/Soft_Job/M.1501827536.A.DF2.html) | 高規則內容；置底原始日期舊且有2021更新，正式上線前再核對最新置底 |
| 1111 CASE+ | **停止列可用來源**；官方網域索引「終止服務公告」明列2025-08-29正式下線、不再提供任何服務 | 舊程式外包類別／免費行銷資料僅歷史，不是現在案源 | 不研究註冊／投案，已下線 | 無新增收案路徑。[官方終止公告索引所指頁](https://case.1111.com.tw/FindTalent/TalentInfo?Id=4202505300010) | 中高：官方搜尋索引直接載明；本次直開timeout／首頁502，停站判斷依公告而非錯誤碼 |
| PRO360 | 免費瀏覽新案；**手動報價付費**取得聯絡；推廣服務估價免費但客戶首次主動聯繫收費；一般模式成交後不再抽成 | 台灣兼職接案可用，服務範圍／遠端依設定及案件；技術適配中但免費優先時不列免費投案主力 | 專家帳號、服務項目／地區／方式；完整身分核驗細節待驗 | 平台媒合／通知、手動瀏覽；未查得官方收案API/RSS。[運作方式](https://www.pro360.com.tw/pro/guide/how-pro360-work/)、[費用](https://www.pro360.com.tw/pro/guide/memebrship/)、[比較](https://www.pro360.com.tw/pro/quote_compare/) | 高；每案聯繫價格／退費條件個別看；特约專家是另約分潤，勿混一般模式 |

### 台灣平台優先判斷與修正

1. 保留 Tasker 免費提案；SOHO、CodeJob 為台灣技術外包主力候選。104、Cake、Yourator 為技術兼職通知補充。這是來源適配排序，不代表本次找到正在募且符合所有條件的具體案件。
2. 台灣就業通有此前目錄漏列的正式免費 Open Data API，技術接入可行性較清晰，但職缺品質／新鮮度及涵蓋率仍要實測。
3. CASE+ 從「無法開啟／待查」改為「官方公告2025-08-29下線」；本次公告來自官方頁搜尋索引，直讀未成功，保留證據限制。
4. PRO360 費用已可查：付費聯繫、成交一般不抽成，不能列免費提案主力。Soft_Job 不適合當外包板，官方規則明確轉向 CodeJob。
5. 518與小雞已查到官方免費履歷／瀏覽規約，尚未以登入流程確認所有應徵功能無費用；不靠企業免費刊登的行銷文字代替求職費用證據。


## 海外職缺板逐站研究（2026-09-19）

範圍：台灣 UTC+8、每週20–30h，AI agent > AI整合 > backend/API > fullstack/MVP，免費申請優先。全部21站已使用web官方頁面或官方搜尋索引研究；未登入、申請、訂閱、下載或實作。下列「未知」是未取得明示官方證據，不代表收費或不可用。職缺板的成交費欄不等同跨境收款成本；外部雇主申請系統另依其要求。每案仍需證實台灣可受僱／承攬及20–30h，Contract不等於Part-time，網站remote標籤不等於worldwide。無明示官方API/RSS時採手動或官方提醒，不推定允許crawler。

| 平台 | 免費搜尋／申請／成交費 | 帳號、台灣與20–30h適配 | 整合研究結論與直接官方證據 |
|---|---|---|---|
| LinkedIn | Basic免費；基本求職可用；未取得逐項申請/成交費明文，Premium為加值而非基本帳號必要 | Easy Apply/提醒需帳號；台灣與遠端兼職逐案，優先精準AI/contract搜尋 | [Basic](https://www.linkedin.com/help/linkedin/answer/a545596/linkedin-free-and-upgraded-premium-accounts?lang=en)、[job alerts](https://www.linkedin.com/help/linkedin/answer/a511279/job-alerts-on-linkedin?lang=en)可20組、日/週email或app；[官方明禁scraping及第三方自動化](https://www.linkedin.com/help/linkedin/answer/a1340567/automated-activity-on-linkedin?lang=en)，採本人搜尋/官方通知，未確認公開求職讀取API。 |
| Indeed | 可公開搜尋；本次未取得現行官方完整免費申請/成交費明文，不能用雇主免費刊登替代 | 站內申請/提醒須帳號；雇主外站可能另註冊；跨國與工時逐案，泛職缺噪音高 | [官方流程](https://www.indeed.com/help/job-seekers/guides/getting-started-with-your-job-search)、[提醒說明](https://support.indeed.com/hc/en-gb/articles/204488890-Starting-stopping-and-managing-Job-Alerts)：有日/週email，跨國搜尋可能不能建立提醒。讀取API/RSS授權未知，先通知/手動。 |
| Glassdoor | [官方About](https://www.glassdoor.com/about/)明示job seekers never pay；搜尋/媒合免費，成交費無另列 | 提醒需帳號；職缺由Indeed供應，必須去重；台灣/20–30h逐案 | [官方提醒](https://help.glassdoor.com/articles/en_US/Article/Job-Alerts-on-Glassdoor)日/週、每天最多建立10組；其他filters不會套入alert，remote不能直接當提醒地點。手動/通知，公開API/RSS未知。 |
| SimplyHired | 公開搜尋；完整免費申請與成交費本次官方未知 | [首頁](https://www.simplyhired.com/)明示與Indeed共用帳號，Quick Apply與外站申請並存；美國城市/州市場為主，台灣與20–30h逐案 | 不應當成全新獨立案源，先處理Indeed去重；[公開搜尋頁](https://www.simplyhired.com/search?q=jobs)有latest job alert入口，頻率與免費細則未知；求職讀取API/RSS未確認，手動備選。 |
| Talent.com | [官方明示](https://helpcenter.talent.com/hc/en-gb/articles/49966854548372-Is-Talent-com-free)搜尋、提醒、申請均完全免費，從不向求職者收費；平台成交費0（依此明文），第三方另算 | 帳號是否每種投遞必須未知；台灣與20–30h逐案；官方入口此次依地區redirect UK，不能判為台灣不可用 | 免費個人化job alerts已確認；公開讀取API/RSS未確認，手動/官方提醒。 |
| Wellfound | [官方](https://wellfound.com/candidates/overview)明示建檔與所有應徵always free，人才端免費；無另列成交費 | 需profile；AI/工程新創適配佳，但工時須找part-time/contract；[Hires Remotely From](https://help.wellfound.com/article/762-remote-job-search-filters)才是台灣資格依據，HQ地點不是受僱地點；auto-posted可能含不合資格案 | 用真實台灣profile location與官方篩選；未確認求職者可用公開API/RSS，先手動/帳號內推薦，通知細則待確認。 |
| Himalayas | [Pricing](https://himalayas.app/pricing)：Free可搜尋/申請、週提醒；付費Plus/Max為AI工具/日提醒；官方FAQ無隱藏費用，成交費未另列 | 公開資料不用帳號，profile/tracker需OAuth；location/timezone/employment type逐案，適合AI/backend篩選但不把remote當全世界 | [官方AI agents文件](https://himalayas.app/docs/ai-agents)：免費無key MCP https://mcp.himalayas.app/mcp、JSON https://himalayas.app/jobs/api、RSS https://himalayas.app/jobs/rss；RSS最近100筆，JSON全量分頁以nextCursor，24h更新；顯示資料須核對attribution條件。既有connector要以現行文件查核，未在此次修改。 |
| NoDesk | [官方列表](https://nodesk.co/remote-jobs/)明示免費瀏覽／申請；[條款](https://nodesk.co/legal/terms/)另有付費subscription，免費公開部分與加值分開 | 按JobPosting employmentType篩選；FULL_TIME優先排除，TEMPORARY／CONTRACTOR不保證20–30h；台灣資格仍unknown | **已接VM第16來源**：官方頁alternate link宣告[RSS](https://nodesk.co/remote-jobs/index.xml)，只修兩種已觀察HTML entity，再讀10篇公開JobPosting；新增1筆網站伙伴合作待確認案。首輪9/27自然排程待驗；非全站feed。 |
| Remoters | [FAQ](https://remoters.net/remote-job-board-faqs/)完整免費存取與Apply Now，另有免費分類提醒；未列人才成交費（不推定0） | 申請導外部URL/email；瀏覽流程未要求Remoters帳號，外站另定；[首頁](https://remoters.net/jobs/)明示part/full-time，台灣與時區逐案 | 官方分類email alerts最具證據；API/RSS未有官方授權文件，既有/jobs/feed/空回應不代表無案。適合software/AI整合分類通知，先研究收信內容，不登入訂閱。 |
| Jobicy | [官方自述](https://jobicy.com/flexjobs-alternative)明示求職者免費瀏覽、看公司及應徵；成交抽成未另明列 | 公開API無帳號，申請帳號依外站；geo=apac/anywhere只是初篩，jobType再判20–30h | [官方repository](https://github.com/Jobicy/remote-jobs-api)：API免auth https://jobicy.com/api/v2/remote-jobs ，最大200；新分類用engineering等須taxonomy查詢；RSS https://jobicy.com/jobs/feed 可type=part-time/contract/freelance；不超過每小時poll一次、保留canonical URL；既有來源值得持續用。 |
| Dynamite Jobs | [官方profile](https://dynamitejobs.com/candidate-pro/)免費建檔；公開搜尋，完整申請/成交費未另明列 | 需candidate profile收匹配通知；[首頁](https://dynamitejobs.com/)實見Part Time職缺也有US-only Full Time，不能被work anywhere行銷誤導；20–30h與台灣逐案 | [官方alerts](https://dynamitejobs.com/blog/customizing-your-job-alerts-get-relevant-job-opportunities-in-your-inbox)帳號最多5類/子類、日/週/即時email；未確認公開API/RSS，通知優先。 |
| Real Work From Anywhere | 公開搜尋；RSS明示完全免費；申請與成交費未有獨立明文 | 瀏覽/RSS無需帳號；[part-time頁](https://www.realworkfromanywhere.com/remote-part-time-jobs)此次僅見1筆兩個月前regional lead（非工程）；網站worldwide承諾仍須以原雇主正文核對 | [官方RSS文件](https://www.realworkfromanywhere.com/rss-feeds)確認免費無帳號、全量與backend/fullstack分類feed、完整描述/地點/application link；https://www.realworkfromanywhere.com/rss.xml 。工具直讀XML失敗不等於不可用。新增研究優先級中高（接口明確但兼職工程供給弱）；[newsletter](https://www.realworkfromanywhere.com/newsletter)週信。 |
| Remote.com Jobs（2026-09-26使用者選擇僅公開搜尋、暫不建帳） | [官方註冊](https://support.remote.com/hc/en-us/articles/20983397304589-How-can-I-sign-up-as-a-job-seeker)明示免費帳號；完整申請/成交費未獨立證明 | 需email驗證，可共用Remote帳號；每案台灣、簽證、contract/20–30h查核 | 可用官方平台手動；[ATS官方文件](https://support.remote.com/hc/en-us/articles/37880478737037-Accepting-Applications-with-Remote-s-ATS)有visa mismatch提示，但雇主ATS免費不能當求職費證據。9/26公開列表／JobPosting可讀，但[條款Usage restrictions](https://remote.com/policy/terms-of-use)禁止自動化／資料擷取，未部署crawler；改官方提醒或授權途徑。 |
| YC Jobs（含Work at a Startup） | [官方入口](https://www.ycombinator.com/jobs/)公開瀏覽與single profile應徵；本次未取得免費申請/成交費明文 | 應徵用profile；實見工程多Full-time+城市；AI新創匹配高但每週20–30h適配低，台灣remote逐案 | 不重複計Work at a Startup；官方public求職API/RSS未確認，手動精選AI/contract，profile會讓YC founders聯繫。 |
| Welcome to the Jungle | [2026-04-27條款](https://www.welcometothejungle.com/en/pages/terms)明示Candidates access/use無費用（涵蓋搜尋與平台申請），成交費無另列 | 部分功能/招募對話需帳號且18+，外站另定；profile預設招募方可見；台灣/20–30h逐案 | [每日提醒](https://help.welcometothejungle.com/en/following-companies-on-welcome-to-the-jungle-%EF%B8%8F)追蹤公司/儲存搜尋，頻率不能改；API/RSS求職讀取未確認，手動/提醒。 |
| Arbeitnow | 公開搜尋；[官方API](https://www.arbeitnow.com/blog/job-board-api)免費免key；申請/成交費未完整明文 | 德國市場；remote可能仍需德國居住/工作權，對台灣UTC+8 20–30h低優先；投遞可走合作JOIN外站 | 已接每日首250筆公開API，實讀250／0技術兼職；有下一頁，不能聲稱全站覆蓋。[官方terms](https://www.arbeitnow.com/terms)要求回鏈且可撤銷；不自動投遞。 |
| Get on Board | [官方公開API](https://www.getonbrd.com/user-manual/get-on-board-s-api)免認證取得已發布職缺，與雇主付費API／MCP分開；求職profile免費 | LatAm導向；以公開taxonomy篩兼職／freelance及技術分類。語言、台灣資格、週工時逐案待確認 | **已接VM第17來源**：modalities＋remote search實讀2頁203筆，新增10件初篩候選；未截斷。最多10頁、90秒，並非全站。首輪9/27自然排程待驗。 |
| Web3.career | 官方註冊導流頁搜尋結果顯示免費建檔／應徵／Email提醒；[API官方頁](https://web3.career/web3-jobs-api)明示API免費。一般帳號完整費用與成交費仍待驗，未用邀請碼註冊 | 免費帳號投遞/提醒；web3背景額外門檻，優先AI/backend非純鏈開發；台灣/20–30h逐案 | [官方Jobs API](https://web3.career/web3-jobs-api)明示免費、1–100筆、full description/role/location filter；入口要求email與使用網站，未申請，auth/rate/回鏈細則待文件。可列介面確定但需本人授權申請，不用crawler。 |
| CryptoJobsList | 公開搜尋/應徵入口；本次未得候選人申請/成交費正式明文，不與API免費混為一談 | 申請帳號要求未驗；Web3/AI×crypto與backend可備選，台灣20–30h逐案 | **已接VM第19來源**：官網alternate link宣告[公開RSS](https://api.cryptojobslist.com/jobs.rss)，100筆含全文、0拒絕、新增1件freelance候選。無逐案日期與部分地點，維持unknown；非全站。完整搜尋API仍須申請key，本次未申請。 |
| Idealist | [官方](https://www.idealist.org/en/help/do-i-have-to-sign-up-to-use-idealist)無帳號也能用、註冊免費；[terms §8](https://www.idealist.org/en/terms-of-service)付費服務列組織刊登/會員，未列人才申請/成交費，但不把未列當0 | alert/存履歷需帳號；非營利含志工實習，需明確paid tech contract/part-time與台灣資格；AI工程供給未證實 | [通知設定](https://www.idealist.org/en/help/how-do-i-unsubscribe)可日/週/月；官方提到RSS分發但未找到供求職者用的正式端點/API，優先手動/通知。 |
| Remote.co | 9/26 Chrome未登入可讀[真實職缺全文與Workable Apply連結](https://remote.co/job-details/senior-website-project-manager-04234f53-01f4-48b3-975c-c79ce1670015)；web文字擷取曾呈鎖定，不能據此判付費牆。未實際提交申請；[terms](https://remote.co/tos)仍有付費服務 | 抽樣限美加、全職，不符合；有part-time類別，台灣/20–30h逐案 | Terms明示未經授權不可scrape，故不部署每日crawler；待官方feed/提醒/存取許可。公開可讀不等於自動收案已接通，勿混同Remote.com。 |

研究排序（推論而非職缺保證）：既有Himalayas/Jobicy維持；新增優先了解NoDesk/Remoters官方通知、Real Work From Anywhere官方RSS與實際工程兼職供給、Wellfound真實地區profile篩選。LinkedIn用官方提醒。Web3.career/CryptoJobsList API明確但主題次要、申請介面需要後續授權。Arbeitnow/Get on Board/YC Jobs接口或AI題材不能抵銷地區及全職限制。Indeed/Glassdoor/SimplyHired/Talent聚合需去重。


## Freelance talent networks 官方研究（2026-09-19）

判準：台灣 UTC+8、每週 20–30 小時，優先 AI agent 開發，其次 AI 整合／backend／API／full-stack，免費優先。以下是公開官網查證；未登入、註冊、送申請、聯絡或實作。未知表示本次官方公開資料不能確認，不代表不存在。公開網頁／搜尋引擎索引不等於授權 crawler/API。

建議順序（研究判斷）：Arc → NomadBridge（費用先確認）→ Braintrust → Toptal → A.Team（資深 production AI 挑戰型）→ Gun.io。Turing 須先找到 20–30h 合約；Proxify 因 UTC+8 官方矛盾先擱置。Outlier、TELUS 是額外收入用 AI 評估來源；DataAnnotation 台灣资格未確認。TDNA 是社群渠道，避免與 NomadBridge 重複計數。

| 平台／工作內容 | 人才費用、抽成與付款成本 | 台灣／UTC+8、20–30h 適配 | 門檻／測驗 | 官方申請、通知與 API 狀態 | 官方來源 |
|---|---|---|---|---|---|
| Arc：工程開發、AI／backend／full-stack | 人才加入、使用與成功找到工作均免費；依自訂時薪付費，協助合約收款；人才跨境收款／換匯附加費未公開確認，不能把平台免費延伸成零銀行成本 | **台灣有官方人才目錄，明列 UTC+8、Freelance**；明確有 part-time/full-time 合約。實際重疊時段及工時逐案 | 溝通測驗＋freelance 領域技術面試；官方說 5+ 年經驗且英語良好者表現較好，並非硬性年資門檻 | 從 talent 頁 Join；完成後收取工作媒合、面試邀請。公開求職 API/RSS 未找到；可先人工追蹤／本人授權後接既有邀請通知，尚未驗證通知格式 | [Talent/費用/測驗](https://arc.dev/talent)、[台灣 UTC+8 人才](https://arc.dev/en-tw/hire-developers)、[條款](https://arc.dev/terms) |
| NomadBridge：台日韓跨境專案、法人開票支援；Early Access 先前後端，AI 測驗仍屬後續 | 加入費、人才抽成、代開票費、付款方式與換匯費**全未知**；薪酬級距是官網展示，不是保證收入 | 台灣是明確目標市場；台日韓時差小（UTC+8/+9）。申請收可投入時數，短期／長期專案及派遣皆列出；**20–30h 案源未確認** | 前／後端各約 30 分鐘線上測驗、A/B/C 等級，收年資與作品；英文／日文硬性要求未列 | 9/26本人回報已填好並送出 Google Forms 申請，待平台聯繫；不重送或重問年資／語言／時薪。尚未核准入網或取得案件；公開通知訂閱、API/RSS 未找到 | [官方計畫／FAQ／入口](https://nomadbridge.dna.org.tw/) |
| Braintrust：工程合約與全職；亦招 AI 訓練 contributor，應按職缺內容分類 | 加入免費、人才零平台費。**服務費條款要求人才自行承擔 Payment Processor 提款、信用卡及換匯等費用**；客戶另付 15% 平台費（2023條款）；付款可能須等客戶款入帳 | 宣稱 worldwide／work anywhere；未查得明確台灣專用资格頁。Contract 不保證 part-time；UTC+8、20–30h 須按職缺確認 | 最新人才頁：profile → AI skills interview → ID verification/certification → matching。固定年資／英語分數未列，按角色 | 匿名瀏覽器已實讀 /jobs 列表及 /jobs/16729 正文；官方 Saved Search 可寄新案 Email，須登入驗收。使用者已選只保留公開搜尋，暫不建帳或訂閱；註冊待辦關閉。公開人才 jobs API/RSS 未確認，AIR/ATS API 不等於公開案件 API | [人才流程](https://www.usebraintrust.com/for-talent)、[費用與付款條款](https://www.usebraintrust.com/site-service-fees-terms)、[官方儲存搜尋通知](https://support.usebraintrust.com/hc/en-us/articles/14302837343767-How-do-I-get-email-notifications-for-my-saved-job-searches)、[目前 pricing](https://www.usebraintrust.com/pricing) |
| A.Team：高度符合 AI agent，明列 production RAG、multi-agent、agent workflows、AI engineer/architect | 自訂費率、不扣報價；每月兩次 Net-15，自第一個 mission 小時起支付；支援 C2C/1099。加入／銀行／換匯附費未明示完整費表，不能推定全免費 | 大多 remote，少數任務有資料／稅務／合規地點限制；9/26現行/join FAQ列常見10–20h/week或full-time、多數12–18月。台灣接案资格、UTC+8 重疊時數與20–30h具體任務仍待確認 | 重實際上線與成效；9/26現行/join頁為30–45分鐘真人團隊面談，談2–3項專案（取代舊AI evaluation描述）；頁面自述錄取 <2%。10+年是同儕描述，未寫作申請硬門檻；英語規格未公開 | [官方人才頁](https://www.a.team/join)；9/26已以Chrome實讀官方onboarding.a.team/builder表單（Email／姓名／新密碼／條款），未提交；本人已選申請，待自行完成新密碼步驟與控制連線恢復；審核後進平台申請 curated missions。公開 job feed/API/RSS 未找到；不能把開放 onboarding 當已入網 | [AI jobs/FAQ](https://www.a.team/ai-jobs) |
| Gun.io：資深工程、長期 remote；AI agent 精準案量未確認 | 人才保留自訂報價 100%，平台費由客戶負擔；平台協助請款並承諾付款。加入費及收款／換匯附加費未另列完整說明 | 以長期遠端為主；台灣資格、UTC+8 重疊要求、20–30h案源**未確認**。Testimonials 不當作當期兼職供給證據 | 完整 profile、工作史／語言；senior developers 評閱背景，shortlist 後平台訪談、客戶 live interview。官網強調履歷實績勝過一堆 code tests；未列固定年資、英語測驗分數 | [官方 account 入口](https://app.gun.io/)；媒合後團隊聯絡；公開/jobs有4角色摘要但缺個別ID／工時／地區；app註冊到Create talent profile前；本人已選申請，尚未驗帳號建立。Find Work newsletter未證實含職缺；條款§5限制自動擷取。公開案件 API/RSS 未查得 | [人才流程／費用／newsletter](https://gun.io/find-work/) |
| Proxify：長期軟體、data、AI professional roles | 加入免費；協商月薪，通常每月22日經 Deel 付款。人才報價抽成與 Deel 提款／換匯實際費率未確認，不以加入免費推定零抽成 | **暫不優先**：career頁同時寫 worldwide 與居住時區 +4GMT 至 -10GMT；UTC+8 不在所列範圍。多數40h，官方KB確認也有4h/day、20h/week | 3+年商業經驗、英文B2、technical assessment/interview；重新申請須間隔6個月，不能重复申请 | [Apply](https://talent.proxify.io/)；由平台 staffing/matching。公開人才 jobs API/RSS 未找到；未處理登入或審核 | [時區／免費加入](https://career.proxify.io/)、[資格／20h／Deel付款](https://knowledge.proxify.io/about-proxify) |
| TDNA：社群 networking、活動、職涯／創業資源；不是獨立工程案件市場 | 活動費逐場；會員費／案件抽成無可套用統一公開費表。不要將社群活動或友善標章免費等同接案服務免費 | 台灣根植，線上／實體活動逐場；無固定兼職工作供給、無20–30h聘用承諾 | 一般社群活動未列工程年資／英文測驗；依活動。NomadBridge有獨立能力評估 | 官方網站 Latest News、Meetup、Facebook community；可人工追蹤官方活動。未確認公開工作 API/RSS；NomadBridge、Gridge、ALION 不另算重複案件池 | [TDNA官方社群入口](https://dna.org.tw/en/home_en/)、[伙伴](https://dna.org.tw/en/partners/)、[NomadBridge發起及合作關係](https://nomadbridge.dna.org.tw/) |
| Toptal：software／AI engineering 人才網路 | 自訂費率，**不從人才報價抽成**，USD支付，平台處理billing。申請費及銀行／換匯費未由FAQ全面確認。客戶 $79/月 subscription **不是人才費** | 官方有台北 verified developer profiles，證實網內有台灣人才，仍不等於任何職缺可接；大量20h/week兼職與hourly，availability可設0–50h。客戶多在美國／西歐，重疊逐案 | 建議2–3+年相關經驗；多階段篩選通常數週、domain/professionalism/communication及test project；需英語溝通，未列CEFR固定分數 | [Apply as freelancer](https://www.toptal.com/talent/apply)；通過後可搜尋 eligible jobs、收job interest requests。未查得公開人才案件API/RSS | [Talent FAQ](https://www.toptal.com/freelance-jobs/faq)、[台北人才存在證據](https://www.toptal.com/developers/resume/yi-lin-juang)、[客戶費用／篩選](https://www.toptal.com/faq) |
| Turing：**兩軌** application engineering（copilot、automation、knowledge bots）及AI advancement（模型訓練／評估）；不可把全部AI角色當agent開發 | 官方software developer FAQ說人才服務免費，銀行可能收transaction fee；付款／換匯依方案，具體數字未知 | 全球 remote 行銷但台灣明確資格未查得；傳統web工程職缺要求**40h/week＋美國時區重疊4h**，不適合當前20–30h。新AI角色不能一概套40h，須逐職缺確定 | 新人才頁年資依role；英文說寫能力必要，skill assessments及live interviews。傳統工程頁多3+年，可破格，非所有AI角色統一門檻 | [官方 Apply](https://developers.turing.com/)；profile含rate/skills，收個人化job recommendations，也可挑role。9/26 Chrome匿名work.turing.com/jobs實讀首批12卡（總253），job94814 LangGraph正文限India；不是適合台灣的證據。條款§6限制scraping；公開案件API/RSS未確認，Turing RL gym API不是求職feed | [目前兩軌與流程](https://www.turing.com/jobs)、[免費與銀行費](https://www.turing.com/jobs/software-developer-jobs)、[40h與4h重疊例](https://www.turing.com/jobs/web-developer-jobs) |
| Outlier：人類回饋、評比AI輸出、寫prompt／繁中文本；**不是承接企業agent建置** | Taiwan繁中頁core工作最高US$20/h，非核心／onboarding等可能較低；每週PayPal/Airtm，FAQ另列ACH但未確認台灣。加入／抽成／付款處理費完整費表未知 | **官方繁中頁明列Taiwan remote**，一般5–10h可到40h；FAQ無最低時數、可與其他工作並行。20–30h排程可行不等於保證任務量 | 繁中讀寫評估能力，translation/writing／人文學歷為ideal qualifications；需要ID/phone驗證及技能評估。一般英語硬門檻於本次最新FAQ未確認 | 從 [繁中官方入口](https://outlier.ai/languages/zh-tw) Apply；profile資料可用於機會通知，dashboard任務為主。公開求職/任務API/RSS未查得 | [Taiwan角色／費率／申請](https://outlier.ai/languages/zh-tw)、[工時／付款／資格](https://outlier.ai/faq) |
| DataAnnotation：chatbot評估、AI code review/debug、prompt等模型訓練；不是agent交付案件 | 官方FAQ確認零signup fee、PayPal出款；抽成與PayPal收款／換匯費未公開完整說明，不能推定到手零成本 | 24/7、無最低工時，20–30h排程相容；**台灣資格未確認**：本次最新首頁／FAQ未列可招募國家，不能套舊版六國列表當2026現況，也不能用globally推定台灣可用 | Starter Assessment僅一次；另按技能qualification，coding需程式經驗，專業/STEM有資格門檻；英語測驗與台灣軌未確認，identity verification | [官網Apply](https://www.dataannotation.tech/) → app.dataannotation.tech；FAQ說email通知審核，通過後平台選任務；公開API/RSS未找到 | [最新FAQ](https://www.dataannotation.tech/faqs)、[首頁入口](https://www.dataannotation.tech/) |
| TELUS Digital AI Community：搜尋／媒體內容評估、AI資料；不是AI agent開發 | 現行Taiwan職缺未公開薪酬、付款周期／付款商、招募费／抽成／匯費完整細節，皆保留未知 | **當期Taipei官方搜尋有1項** Media Search Analyst—Chinese_Traditional (Taiwan)，part-time remote long-term；明確台灣，但每週上限／20–30h供給未知 | 該職缺：台灣過去1年居住、English＋繁中full professional proficiency、Apple ID/Apple產品熟悉度；無需先前專業經驗、open-book exam＋ID驗證。其他職缺曾要求5年居住，不能混用 | [台北目前職缺](https://jobs.telusdigital.com/search/jobs/in/taipei) → Apply for this job；有Join our Talent Network。公開job API/RSS未確認，不把career ATS底層接口視為正式API | [目前列表](https://jobs.telusdigital.com/search/jobs/in/taipei)、[該角色完整資格](https://jobs.telusdigital.com/jobs/18135784-media-search-analyst-chinese-traditional-taiwan)、[AI Community入口](https://www.telusdigital.com/careers/ai-community) |

### 人才平台矛盾與不確定性

- Proxify 的 worldwide 與 +4GMT 到 -10GMT 同頁矛盾尚未消失；不要寫成已確認接受台灣。20h存在不能消除時區限制。
- Braintrust 人才零平台費与 Payment Processor 成本可並存；最新人才頁寫AI面試/ID驗證，舊community文件的四題10分鐘錄影流程不宜當現行唯一流程。舊community稱客戶10%，服務費條款及support說15%，當前pricing另寫flexible；人才端研究应主述零平台費＋支付費未知，客戶%勿當所有現行方案固定。
- Toptal 客戶subscription、Proxify客戶轉正費、Braintrust客戶15%均不能誤算到人才抽成；「不扣報價」也不能推導銀行與換匯免費。
- NomadBridge 官網目前仍Early Access、AI能力測驗是未來；正式可用案件數、免費與法人服務費未公開。官網所有申請按鈕共享Google Form是觀察到的連結情況，未開表單填寫。
- Outlier繁中頁一處寫No contracts，頁尾又明列1099 contract opportunity；應按獨立合約關係理解，不能承諾無合約。最高費率與宣稱可到40h皆非實際保證。
- TELUS旧Internet Domain Assessor頁要求台灣5年且有Google+舊字樣；本次優先採目前列表的Media Search Analyst（過去1年），不把舊職缺當新資格來源。
- DataAnnotation舊常見六國限制沒有在本次現行官方入口查得；保留台灣未知，不引用第三方推論放行。FAQ目前說email通知，舊版只說符合且有工作才聯繫，未登入驗證實際審核SLA。
- 這12來源沒有確認可直接使用的公開**人才案件**API。各平台AI產品API、blog程式碼、可索引人才profile、Turing測試環境Swagger都不是求職API。後續整合宜先官方通知或人工review，須另核通知內容及讀取授權。

### 人才平台待本人資料（不阻擋研究結案）

共用英文／中文履歷、實際商業年資、英文口說程度、時薪底線、可重疊時間與production案例。NomadBridge另問加入/抽成/開票成本；Braintrust／A.Team／Gun.io確認台灣和付款；Proxify先得到UTC+8資格明確答覆才投入測驗。此處列待確認項，不代表已聯絡。


## 付費限制與社群來源（14項）

本節於2026-09-19查官方費用頁、FAQ及API文件。判斷「優先」依Will的免費優先、台灣UTC+8、每週20–30h及AI agent／API／MVP需求；不是平台錄取或案件保證。所有海外案仍須逐案核對台灣資格、工時、幣別與預算。表中未找到公開API不代表不存在。

| 來源 | 免費／費用查核 | 兼職、帳號與台灣適配 | 收案方式與結論 |
|---|---|---|---|
| Working Nomads | 免費公開職缺、瀏覽與應徵不需帳號；Premium擴大職缺庫。另有明示Free Job Alerts，不能因Premium含alerts就認定提醒全付費。[FAQ](https://www.workingnomads.com/faq)、[免費提醒](https://www.workingnomads.com/subscribe) | 有Part-time與Freelance/Contract，提醒可選類型、Anywhere／地區、關鍵字。雇主外部ATS可能需帳號。 | **優先通知整合候選**：免費每日／每週Email；只處理免費清單，不訂Premium、不假設付費庫可取。尚未訂閱或接通。 |
| JustRemote | 公開developer列表可讀；PowerSearch為付費擴充，頁列首月US$6，後續結算條件需看訂閱介面。[公開開發職缺](https://justremote.co/remote-developer-jobs)、[PowerSearch](https://justremote.co/power-search) | 需篩Contract、接受台灣／時區；公開頁存在不代表所有應徵流程已驗證。 | **已接VM第18來源**：公開HTML listing state83筆、20篇技術／合約正文，0候選、0拒絕；9/27首輪自然排程待驗，非全站覆蓋。PowerSearch未使用。 |
| Remotive | 公共API免費、資料延遲24h；需標Remotive及回鏈，不可轉投第三方職缺聚合站或以註冊牆換取列表。[API及規範](https://remotive.com/remote-jobs/api) | 有地區／職類欄位，remote不能推定台灣可用；網站完整庫與加值功能另計。 | **已接通**：保留官方API及來源URL；官方也有RSS。不能以API免費宣稱網站所有應徵功能免費。 |
| Contra | Free有Limited job opportunities，Pro unlimited；人才commission-free，但標準／快速／crypto提款及付款費用不同。[Pricing](https://contra.com/pricing) | 適合按專案服務，需profile；台灣提款管道、驗證與實際免費job額度未完整公開核實。 | **備選**：先整理AI agent服務作品；免費帳號內工作機會／通知待本人登入驗證，未找到可用公開職缺API。 |
| Fiverr | 完成訂單人才保留80%（含加購與小費），不屬零抽成。[Earnings](https://help.fiverr.com/hc/en-us/articles/9234443621137-Your-earnings-page) | 以建立Gig／profile讓客戶找你為主，非每日公開投標板；需完成seller onboarding，合作排程自訂。[Freelancer流程](https://help.fiverr.com/hc/en-us/articles/34069565843985-How-Fiverr-works-for-freelancers) | **備選服務入口**：可將agent/API服務產品化；追蹤平台詢問，不把它當公開crawler來源。台灣收款方式需帳號確認。 |
| Freelancer | 初始免費會員6 bids/月，但投標前最低可用餘額US$20，風險／高價案可能更高；固定價成交10%或US$5取高、時薪10%。這是餘額要求，不能誤寫US$20不可退提案費。[官方費用](https://www.freelancer.com/feesandcharges)、[Bidding FAQ](https://www.freelancer.com/faq/topic.php?id=5) | 固定／時薪專案、需會員與投標資格；使用者有帳號不等於餘額／驗證已滿足。台灣与工時逐案。 | 已啟用VM每日公開搜尋，三組查詢各最多20筆；副本實讀48筆去重後新增7件。只讀案件、不加值、不投標；搜尋顯示仍有更多頁，非全站覆蓋。 |
| Guru | Basic免費、10 bids/月、9% job fee；官方要求ID驗證並列US$4.95处理費。[Pricing](https://www.guru.com/pricing-freelancer/)、[ID驗證](https://www.guru.com/help/freelancer/about-id-verification-freelancer) | 需帳號、身份及信用卡驗證；固定／時薪合作仍需確認台灣支付與工時。價格頁/Help部分直開失敗，以本次官方索引核對，不聲稱已走完驗證。 | **部分資料可讀，未接每日**：9/26公開分類3頁59 URL、8篇JobPosting成功，其他回無效頁，抽查HTTP200防機器人challenge。已停止、不繞過；舊RSS404，替代官方通知／授權通道待驗。不得視為已接通。 |
| Upwork | Basic US$0但Connects非保證每月贈送；官方pricing列基本monthly0，部分帳號可能獲10。買Connects US$0.15/個；服務費依合約0–15%。[Pricing](https://www.upwork.com/pricing/freelancer)、[Connects規則](https://support.upwork.com/hc/en-us/articles/211062898-Understanding-and-using-Connects) | 有hourly/fixed；需profile及平台要求的驗證，投案需Connects、台灣資格和時區逐案。 | **暫不主推**：不把免費註冊當免費大量投遞；平台通知／手動使用，API授權與可用範圍未在本次登入確認。 |
| We Work Remotely | Basic免費；Pro無限制應徵付費，但**Boosted Jobs明示可免訂閱直接應徵**，應修正整站排除。Pro FAQ列12月承諾。[官方FAQ](https://weworkremotely.com/frequently-asked-questions) | FAQ要求帳號；留意Anywhere/region及Contract，不將合約自動當20h。 | **只評估免費子集**：Boosted標籤與直接申請入口須逐案確認；尚未接通。付費TopAccess不保證Toptal/Arc等錄取，也不是加入它們的必經付費路徑。 |
| Remote OK | 官方免費無鑑權JSON/RSS；Premium為提早看新案、進階篩選等。FAQ有外部apply URL/email，但未明示所有職缺完整免費應徵。[FAQ](https://remoteok.com/faq) | 可公開取資料、需逐案確認申請入口及country/timezone；不能僅因有訂閱就排除免費API。 | **API研究候選**：`https://remoteok.com/api`、`https://remoteok.com/remote-jobs.rss`，需署名回鏈；保留free_apply=unknown直到免費入口核對，不穿付費牆。 |
| FlexJobs | 完整雇主、全文與應徵須付費訂閱，試用也付費；免費職涯內容不等於免費工作庫。[FAQ](https://www.flexjobs.com/faq) | 有remote/part-time但需付費會員，台灣工作資格逐案。 | **不列免費主力**：保留研究紀錄，不訂閱、不接受限資料。 |
| Hacker News | 官方公開Firebase API，免鑑權讀取；無平台投標點數。徵人由留言雇主各自處理。[官方API](https://github.com/HackerNews/API) | 只取Who is hiring／Freelancer的需求，排SEEKING WORK；地區／工時在正文，聯絡方式由雇主提供。 | **已接通**：API讀取與每月主題發現；保留手動聯絡，不把所有技術討論當案源。 |
| V2EX | 外包／酷工作公開閱讀；API v2使用Personal Access Token，不能將公開Atom與帳號API混為一談。[外包板](https://www.v2ex.com/go/outsourcing)、[API](https://www.v2ex.com/help/api) | 中文外包適合補充；站內互動需帳號，是否接受台灣收款／合作逐案，跨境人民幣價格不直接當TWD。 | **已接通外包Atom**；API token未申請。只取徵人、排自介與討論，缺正文標不完整。 |
| Reddit r/forhire | 本次可公開閱讀Hiring與For Hire混合列表；應排自薦。平台未提供此社群統一交易／抽成保障。[社群](https://www.reddit.com/r/forhire/) | 發文／私訊需帳號及社群資格；本次rules介面未回完整細則，帳齡/karma門檻保留未知，不能借別社群規則套用。地區由每篇指定。 | **先手動**：Reddit API需事先申請並取得明確批准，不把JSON/RSS可取當獲准。依[Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)，本次不申請、不接crawler。 |

主要改正：Freelancer有投標餘額門檻；Working Nomads有免費精準提醒；WWR有免費Boosted子集；Remote OK免費API與付費功能分開；Reddit API授權不可省略。以上未改動production connector，也未新增訂閱或訊息。

## 2026-09-26 接入限制複查

Remote.com公開合約正文可讀，但Contract／Anywhere樣本正文實為全職及CET±3；未證實Email職缺通知。Contra公開摘要可讀，點案要求帳號、全Job feed需Pro，官方MCP未證明支援求職feed。Upwork RSS已停用且Job Digest有徽章條件；Fiverr Briefs依賣家服務／配對；PRO360免費配對Email已確認，報價仍付費。證據與下一步統一見`docs/platform-connectivity.md`20:26節，不新增第二份執行清單。
