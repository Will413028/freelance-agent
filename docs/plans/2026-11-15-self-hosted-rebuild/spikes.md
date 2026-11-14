# 步驟 1 的 spike 結果

計畫：[`../2026-11-15-self-hosted-rebuild.md`](../2026-11-15-self-hosted-rebuild.md) 步驟 1。原始輸出（匯出檔、頁面片段、log）不進 repo，位置記在本機個人脈絡檔；步驟 10 後刪。日期都是 2026-11-15，標「實測」的是當天跑過的結果，標「推論」的沒有直接量。

## 1. 執行環境（Postgres、Next.js、Tailscale Serve）

指令（在 VM 上，暫時資源都以 `fa-spike1-` 開頭）：

```sh
docker run -d --name fa-spike1-pg -e POSTGRES_PASSWORD=… -v fa-spike1-pgdata:/var/lib/postgresql -p 127.0.0.1:38432:5432 postgres:18-alpine
docker build -t fa-spike1-web .            # node:24-alpine，Next.js 16.0.3，一個頁面加一個回顯 header 的 POST route
docker run -d --name fa-spike1-web -p 127.0.0.1:38080:3000 fa-spike1-web
sudo tailscale serve --bg --https=10443 http://127.0.0.1:38080
# tailnet 內另一台機器：
curl -X POST -H "Origin: https://<vm>.<tailnet>.ts.net:10443" -d x=1 https://<vm>.<tailnet>.ts.net:10443/api/echo
# 公網位址：curl https://<公網 IP>:{10443,38080,38432,443}
docker stats --no-stream
# 清除：tailscale serve --https=10443 off；docker rm -f、volume rm、rmi
```

結論：

- Postgres 18.4（aarch64）起得來（實測）。
- tailnet 內可達：經 Serve 的 POST 回 200（實測）。公網不可達：公網位址的 10443、38080、38432、443 都連不上（實測，連線逾時）。埠只綁 127.0.0.1（`ss -ltn` 實測）。
- 容器經 Serve 收到的 header（實測）：`Host` 與 `X-Forwarded-Host` 都是 `<vm>.<tailnet>.ts.net:10443`（含埠），`Origin` 原樣送到，`X-Forwarded-Proto: https`，`X-Forwarded-For` 是 tailnet 內的來源位址，另有 `Tailscale-User-Login`。`web/src/app/_lib/guard.ts` 比對的是 `X-Forwarded-Host`（或 `Host`）與 `new URL(origin).host`，兩邊都含埠，所以**守門不用改**（推論：由 header 值與程式碼對照；預設 443 時兩邊都不帶埠，同樣相等）。
- 常駐記憶體（實測，閒置）：Next.js 73 MiB、Postgres 34 MiB。映像 977 MB（含完整 `node_modules`，未瘦身）。
- 清除後 `docker ps -a`、`docker volume ls`、`tailscale serve status` 查無 `fa-spike1`／10443（實測）。VM 上原有的三組 Serve 設定未動。
- 附帶事實：`Tailscale-User-Login` 可以當成「誰在用」的依據，Serve 只對 tailnet 開放，不需要另做登入（推論）。

## 2. 分層讀取與平台評估

從 VM 送請求，每個平台每層 1 個請求，同一主機間隔 ≥ 3 秒。只有一般請求拿不到才試下一層。T1 是一般 `curl`，T2 是 `curl_cffi` 模擬 Chrome 的連線指紋，T3 是無頭瀏覽器。「N 筆」是回應裡不重複的職缺連結數，並抽查過確實有職缺標題；HTTP 200 但沒有職缺的頁面算失敗。標「推論」的沒有送請求。

| 平台 | 公開入口 | T1 | T2 | T3 Crawlee | 最低可用層級 | 存取驗證 | 備註 |
|---|---|---|---|---|---|---|---|
| PTT SOHO | `www.ptt.cc/bbs/soho/index.html`，帶 `over18=1` cookie | 200，18 筆 | — | — | T1（實測） | 無 | over18 cookie 不算登入；Vercel 出口被擋，VM 出口沒被擋 |
| PTT CodeJob | `/bbs/CodeJob/index.html` | 200，21 筆 | — | — | T1（實測） | 無 | |
| PTT Soft_Job | `/bbs/Soft_Job/index.html` | 200，6 筆 | — | — | T1（實測） | 無 | 這個板以討論文為主，禁止短期發包 |
| Arc | `arc.dev/remote-jobs` | 200，10 筆 | — | — | T1（實測） | 無 | |
| Web3.career | `web3.career/` | 200，17 筆 | — | — | T1（實測） | 無 | |
| Wellfound | `wellfound.com/jobs` | 200，48 筆 | — | — | T1（實測） | 這次沒觸發 | 已知有 DataDome（推論） |
| Remote.com Jobs | `remote.com/jobs/all` | 200，20 筆 | — | — | T1（實測） | 無 | |
| YC | `ycombinator.com/jobs` | 200，20 筆 | — | — | T1（實測） | 無 | |
| Reddit r/forhire | `/r/forhire/new/.rss` | 200，25 筆 | — | — | T1（實測） | 無 | 官方政策要求 API 核准（見平台主表） |
| Remote.co | `remote.co/remote-jobs/` | 連線被重置 | 200，52 筆 | — | T2（實測） | 依連線指紋（推論） | |
| Idealist | `idealist.org/en/jobs` | 200，0 筆（前端渲染） | 200，0 筆 | 200，16 筆 | T3（實測） | 無 | |
| Braintrust | `app.usebraintrust.com/jobs/` | 200，0 筆 | 200，0 筆 | 200，20 筆 | T3（實測） | 無 | |
| Glassdoor | `/Job/remote-jobs-SRCH_IL.0,6_IS11047.htm` | 403 | 403 | 200，30 筆 | T3（實測） | Cloudflare | |
| Upwork | `/nx/search/jobs/?q=…` | 403 | 403 | 200，10 筆 | T3（實測） | Cloudflare | 服務條款禁止爬取（推論），官方有 API |
| Yourator | `yourator.co/jobs` | 403 | 403 | 403 | 都沒過（實測） | Cloudflare | |
| Guru | `guru.com/d/jobs/` | 403 | 403 | 403 | 都沒過（實測） | Imperva Incapsula | |
| SimplyHired | `/search?q=…&l=remote` | 403 | 403 | 403 | 都沒過（實測） | Cloudflare | |
| Indeed TW | `tw.indeed.com/jobs?q=兼職` | 403 | 403 | 403 | 都沒過（實測） | Cloudflare | |
| Welcome to the Jungle | `/en/jobs` | 200，0 筆 | 200，0 筆 | 被擋（CloudFront「Request blocked」） | 都沒過（實測） | AWS WAF | |
| FlexJobs | `/search?searchkeyword=…` | 連線被重置 | Akamai 挑戰頁 | HTTP/2 錯誤 | 都沒過（實測） | Akamai Bot Manager | 完整職缺要付費會員 |
| Remoters | `remoters.net/jobs/` | 只有分類頁 | 同左 | 200，2 筆 | 未定（實測不足 3 筆） | 無 | 可能有 WP Job Manager 的 RSS（推論，未測） |
| Turing | `turing.com/jobs` | 200，0 筆 | 200，0 筆 | 200，0 筆 | 未定（入口可能選錯） | 回應裡有 Incapsula 字樣 | 真正的清單可能在 `work.turing.com`（推論，未測） |
| Contra | `contra.com/jobs` | 200，0 筆 | 200，0 筆 | 200，0 筆 | 未定（入口可能選錯） | 無 | 全部清單要 Pro（平台主表） |
| A.Team、Gun.io、Proxify、Toptal、Outlier、DataAnnotation、TELUS AI Community | 範圍外：人才平台，要入網（推論） | 未送 | 未送 | 未送 | 不適用 | — | 照規則應各送一次確認請求，這輪沒做 |
| Fiverr、PRO360 | 範圍外：案主需求要登入（推論） | 未送 | 未送 | 未送 | 不適用 | — | 同上 |
| 打工探吉 | 主要是 App，網頁入口沒確認（推論） | 未送 | 未送 | 未送 | 不適用 | — | |
| NomadBridge、TDNA | 找不到職缺網站 | 未送 | 未送 | 未送 | 不適用 | — | TDNA 是社群（平台主表） |

第二輪（同日）補量。Scrapling 一欄與第二輪重試的結果（實測，除非標推論）：

| 平台 | 入口 | 第二輪結果 | 最低可用層級（兩輪合計） | 存取驗證 |
|---|---|---|---|---|
| Idealist | `/en/jobs` | Crawlee 17 筆、Scrapling 17 筆 | T3 | 無 |
| Braintrust | `/jobs/` | Crawlee 20、Scrapling 20 | T3 | 無 |
| Glassdoor | remote 搜尋 | Crawlee 30；Scrapling 403「Just a moment」 | T3（只有 Crawlee） | Cloudflare（Scrapling 被擋） |
| Upwork | `/nx/search/jobs/?q=…` | Crawlee 10、Scrapling 10 | T3 | 無 |
| Yourator | `/jobs` | Scrapling 403 | 都沒過 | Cloudflare |
| Guru | `/d/jobs/` | Scrapling 200 但只有分類連結 | 都沒過 | — |
| SimplyHired | 搜尋 | Scrapling 403 | 都沒過 | Cloudflare |
| Indeed TW | `/jobs?q=兼職` | Scrapling 403 | 都沒過 | Cloudflare |
| Welcome to the Jungle | `/en/jobs` | Scrapling 200 但 0 筆 | 都沒過 | — |
| FlexJobs | 搜尋 | Scrapling 403 | 都沒過 | 廠商不明 |
| 打工探吉 | `tanji.104.com.tw` | T1、T2 只拿到空殼；Crawlee 20 筆 | T3 | 無 |
| Turing | `work.turing.com/jobs` | T1、T2 空殼；Crawlee 至少 8 個職稱（不是一般連結，要處理 DOM） | T3 | 頁面載入 Incapsula，沒擋 |
| Remoters | RSS、WP Job Manager AJAX 幾種路徑 | 都沒有 feed（回一般頁面或 404） | 都沒過（第一輪 T3 只有 2 筆） | 無 |
| Contra | `/opportunities` | T1、T2 空殼；Crawlee 顯示登入頁 | 範圍外：要登入 | 無 |
| A.Team | `/missions` | T1 404 | 範圍外：沒有公開清單 | 無 |
| Gun.io | `/find-work/`、`/jobs/` | T1、T2 0 筆；Crawlee 403 | 都沒過 | 403「Request blocked」 |
| Proxify | `/jobs` | T1 403 | 都沒過（只試 T1） | Cloudflare |
| Toptal | `/freelance-jobs` | T1 403 | 都沒過（只試 T1） | 廠商不明 |
| Outlier | `/opportunities` | T1 404；網站導向 app 登入 | 範圍外：要登入 | 無 |
| DataAnnotation | `/` | 只有招募頁，沒有案件 | 範圍外：案件要登入（推論） | 無 |
| TELUS Digital AI Community | `/careers/ai-community` | T1 403 | 都沒過（只試 T1） | 廠商不明 |
| Fiverr | `/briefs` | T1 403，PerimeterX CAPTCHA | 都沒過（只試 T1） | PerimeterX |
| PRO360 | `/requests`（猜的路徑） | T1 404 | 範圍外：沒找到公開需求清單 | 無 |
| 打工趣 | 找不到網頁版 | 只有 App | 範圍外：只有 App | — |

Proxify、Toptal、TELUS、Fiverr 是確認請求（每個只送 T1），沒有往上試；這幾個屬於人才平台或賣方服務，就算過了也很可能只有招募頁（推論）。

T3 工具在 arm64（實測）：

- **Crawlee**：官方映像（`apify/actor-node-playwright-chrome`）沒有 arm64 版；`mcr.microsoft.com/playwright:v1.56.1-noble` 加 Chromium 可以跑，映像 3.58 GB。一個容器跑 4 個平台，峰值 **484 MiB**，46 秒。node 程序跑完不會自己結束，要明確呼叫 `teardown()` 與結束程序。
- **Scrapling 0.5.1**：StealthyFetcher 現在用 patchright Chromium，不用 Camoufox，所以 Camoufox 沒有 arm64 版不影響。能跑的安裝步驟：`pip install "scrapling[fetchers]"`、`apt-get install -y libatomic1`（第一輪 exit 127 的原因）、`python -m playwright install --with-deps chromium`、`scrapling install`、`python -m patchright install chromium`。映像 3.58 GB。每個平台一個容器，峰值 406–692 MiB；被 Cloudflare 挑戰的頁面要 74–80 秒，峰值 706–734 MiB。
- 兩者比較（各試一次，樣本小）：Crawlee 過了 Glassdoor，Scrapling 沒過；其餘相同。Crawlee 記憶體較低。

暫時容器、映像與 `/tmp` 目錄兩輪都已刪，查無 `fa-spike2`（實測）。

## 3. id 穩定性

資料：第 4 項的匯出，`opportunities` 3,433 列。資料庫欄位 `external_id` 與 `item.job.external_id` 3,433/3,433 相同（實測）。拋棄式腳本用標準 `URL`／`URLSearchParams` 從存著的 `canonical_url`／`url` 重算，只輸出計數。

受影響的檔（`rg -l "@/platform/py/url" web/src/modules/collection -g '!*.test.*'`，19 個）與結果（實測）：

| source | 檔 | 列數 | 一致 | 不一致 | external_id 的來源 |
|---|---|---|---|---|---|
| linkedin | mail/linkedin.ts | 227 | 227 | 0 | path `/jobs/view/<數字>` |
| jobbank104 | mail/jobbank104.ts | 130 | 130 | 0 | path `/job/<英數>` |
| tasker | mail/tasker.ts | 56 | 56 | 0 | path `/cases/<英數>` |
| glassdoor | mail/glassdoor.ts | 10 | 10 | 0 | query `jobListingId` |
| talent | mail/talent.ts | 6 | 6 | 0 | query `id` |
| cake | mail/cake.ts | 6 | 6 | 0 | 網址本身（去尾斜線） |
| arbeitnow | sources/arbeitnow.ts | 34 | 34 | 0 | 來源給的 slug；網址只驗證 |
| getonboard | sources/getonboard.ts | 11 | 11 | 0 | 來源給的 id；網址只驗證 |
| himalayas | sources/himalayas.ts | 225 | 225 | 0 | 來源給的 guid（等於去 query 的網址） |
| jobicy | sources/free-jobs.ts | 117 | 117 | 0 | 來源給的數字 id，117 列的 path 都含它 |
| remotive | sources/free-jobs.ts | 5 | 5 | 0 | 同上 |
| weworkremotely | sources/public-feeds.ts | 9 | 9 | 0 | canonical 網址 |
| realworkfromanywhere | sources/public-feeds.ts | 1 | 1 | 0 | canonical 網址 |
| remoteok | sources/public-feeds.ts | 2 | 2 | 0 | 來源給的數字 id |
| v2ex | sources/community-jobs.ts | 5 | 5 | 0 | path `/t/<數字>` |
| chickpt | sources/chickpt.ts、job-pages.ts | 2 | 2 | 0 | path `/job-<英數>` |
| jobbank518 | sources/jobbank518.ts、job-pages.ts | 1 | 1 | 0 | path `/job-<英數>.html` |
| nodesk | sources/nodesk.ts | 1 | 1 | 0 | canonical 網址 |
| cryptojobslist | sources/cryptojobslist.ts | 1 | 1 | 0 | canonical 網址 |
| taiwanjobs | sources/taiwanjobs.ts | 2 | 2 | 0 | query `EMPLOYER_ID:HIRE_ID` |
| dynamitejobs | sources/dynamitejobs.ts | 0 | — | — | 正式庫沒有這個來源的列 |

jobicy、remotive、remoteok 的「一致」是「來源 id 出現在網址裡」，不是從網址重算（它們的 id 本來就不從網址算）。

不經 `py/url` 的來源：hackernews 22/22 一致（id 等於網址的 `item?id=`）；freelancer 2,557 列的 `item` 只存正規化後的資料、沒有原始 id 欄位，無法抽查比對，改查格式：全部是 8 位數字（實測）。

PTT（`ptt_soho` 2 列、`ptt_codejob` 1 列）：`external_id` 是文章檔名，符合 `^M\.\d{10}\.A\.[0-9A-F]{3}\.html$`，等於網址 `https://www.ptt.cc/bbs/<看板>/<檔名>` 的最後一段（實測 3/3）。步驟 8 照這個格式接回。

限制與後續（推論）：存著的網址都是 `py/url` 正規化過的乾淨形式，所以這裡只證明「乾淨網址」兩邊算出同樣的值。Python 與 WHATWG `URL` 的差異只在原始輸入髒的時候出現（大寫 host、percent-encoding、追蹤參數、重導網址）。風險最高的是直接拿網址當 id 的來源（cake、nodesk、cryptojobslist、weworkremotely、realworkfromanywhere）。**步驟 4、5 改寫這些來源時，驗收要拿 `web/tests/fixtures/golden.json` 裡該來源的原始輸入，比對新舊 `external_id` 全等**；不等的才加相容 id 函式。

## 4. 匯出路徑

做法：分頁唯讀查詢，不用 D1 的 export API（那個會在匯出期間擋住資料庫的其他請求，正式站凍結期間不冒這個險）。每張表 `select rowid as __rowid, * from "<表>" where rowid > ? order by rowid limit 500`，經 `cf d1 query` 逐頁取，存成一個 JSON（含 `sqlite_master` 的結構）。

結果（實測）：31 張表，51 次查詢，55.6 秒，`rows_read` 合計 11,840，檔案 31.4 MB（JSON；D1 回報的資料庫大小 33.9 MB）。各表列數與計數查詢相符（如 `opportunities` 3,433、`mail_ingestion` 451、`opportunity_tracking` 4、`discovery_settings` 0）。讀取額度：Workers 免費層每天 500 萬列，這次佔約 0.24%。

步驟 10 用同一支方法。這次走的是 `cf` CLI 本身的登入，不是 11-30 到期的 `D1_API_TOKEN`，所以匯出不受那把 token 到期影響（推論：兩者是不同的憑證；token 到期只影響正式站自己）。
