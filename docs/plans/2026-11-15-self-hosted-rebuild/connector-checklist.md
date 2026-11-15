# 每個來源的做法（步驟 4 定下，步驟 5、7、8 照做）

範本是 `web/src/modules/sources/free-jobs/`（jobicy、remotive）。每接一個來源，逐項做完；做不到的項目寫進該步驟的進度列並說明。

## 1. 位置與設定

- 程式放 `web/src/modules/sources/<來源或來源族>/`，`index.ts` 匯出 connector（`(fetcher, now) => Promise<{ seen, listings }>`）。共用的解析放 `sources/shared/`，來源之間不互相 import。
- `web/src/modules/sources/catalog.ts` 加一筆：`name`、`order`、`maxTier`（步驟 8 之前都是 `"plain"`，名稱與 `run_sources.tier` 相同）、`minIntervalMs`（≥ 1000）、`maxRequestsPerRun`（這個來源一次執行最多送幾個請求）、`disabled`（長期被擋時寫原因，否則 `null`）。`catalog.test.ts` 會擋缺項。
- 一天只有一次每日執行（`runs` 以台北日期 claim），所以「每次執行上限」就是排程的每日上限；手動 `run-source.ts` 最多再多一次執行的量。
- 讀取只經 `createFetcher(設定)` 拿到的 `Fetcher`，不直接呼叫 `fetch`：間隔、上限、逾時、大小上限、不跟隨轉址、錯誤種類（`invalid_url`、`network`、`timeout`、`http_status`、`too_large`、`request_limit`）都在那裡。
- 不 import `@/platform/py/`（`pnpm boundaries` 的 `sources-are-native` 規則擋；`fixtures/` 底下的產生器例外，因為要讀 `golden.json`）。HTML 轉文字用 `shared/html.ts`（cheerio，照 HTML 標準解析）；時間用 `shared/time.ts`。

## 2. 輸出：D8 契約

- 每筆職缺經 `parseListingInput` 產出 `ListingInput`。
- 單筆擱置、太多才失敗（Will 2026-11-15，步驟 5a 在 VM 實跑：taiwanjobs 1000 筆裡 2 筆標題空白、freelancer 第 1 頁 100 筆裡 2 筆 `seo_url` 沒有斜線，照舊規則兩個來源天天整批失敗、一筆都收不到）：
  - 正規化**一筆**職缺時丟出的拒收（身分欄位 id、標題、內文、來源自己的網址缺或格式不對；來源自己的篩選規則要讀的欄位讀不到，例：工作類型）：這一筆擱置、計入 `Collected.rejected`，其他照收。拒收規則本身不變，只是範圍從整批改成單筆。共用的 `shared/set-aside.ts` 只接 `SourceError` 與清單契約（`parseListingInput`）丟的 `ZodError`，其他錯誤照樣往外丟；它回傳 `{ listings, rejected, examined }`，`examined` 是它跑過正規化的筆數（收下、被來源規則略過、擱置都算）。
  - 整批層級的問題仍丟 `SourceError`、整批失敗、不寫任何一筆：內文解不了碼或不是 JSON／XML、外層或清單不在、超量、單頁自己的分頁資訊不合理、同一個 id 在同一頁或同一次查詢裡有互相衝突的版本、舊程式整批拒收的重複 id、請求失敗。
  - 分頁讀取途中同一筆在後面的頁又出現：留最後讀到的版本，不拒收（來源在讀取中更新；arbeitnow VM 實測 20 頁 7 筆重複、3 筆內文不同，Will 2026-11-15）。來源的分頁資訊（`from`／`to`／每頁筆數）不跨頁比對，除非該來源實測可靠。
  - 這條適用每一個來源，沒有個別例外：舊程式為了一筆壞資料整批拒收的來源（himalayas、hackernews、v2ex、jobicy、remotive）也改成單筆擱置，這是刻意的改變（Will 2026-11-15）；fixture 產生器把這類案例的預期改成「其他筆照收加上 `rejected`」，理由寫「old refused the batch for one listing; Will 2026-11-15 set aside and count」。
  - 門檻的分母是 `Collected.examined`：把每次 `setAside` 回傳的 `examined` 加總，和 `rejected` 同一層級計數（同一筆在好幾頁或好幾個查詢出現，兩邊都各算一次）。`seen` 維持各來源原本的回報意義，不為門檻加上擱置數。擱置的超過一半（`rejected * 2 > examined`）時 `collectSource` 在寫入前丟 `SourceError`（`<來源>: <n> of <examined> listings refused`），所以格式真的變了仍是「來源失敗」；剛好一半照寫。`rejected > 0` 卻沒給 `examined` 是 connector 的程式錯誤，丟一般 `Error`。`SourceRun.rejected` 回報擱置數，步驟 6 把 `truncated || rejected > 0` 記成 partial。
- 同一個 id 在一次回應裡出現兩次：留最後一筆（收案核心拒收重複的批次）。
- `Fetcher` 依呼叫順序一次服務一個請求，connector 可以並行呼叫，間隔與上限仍成立。
- 其他欄位轉不了：寫 `null`（未知），不猜、不拒收（D8）。三態欄位只在來源明說時寫 `true`／`false`；remote、worldwide 不等於台灣可接。
- 時間：有時區的照轉；沒時區的，照來源的規則決定（例：jobicy、remotive 以 UTC 發布，`utcInstant`），規則寫在 connector 的註解裡。截止日照契約的四種形狀。
- 來源自己的篩選規則（例：只收合約類）放在 connector；與設定無關的資格初篩是共用的，在 `web/src/services/collect.ts` 的 `screen`，connector 不重做。舊程式的 `qualifyForIntake(...).score > 0` 也是 `screen` 的事：`evaluate` 對類別分數 0 加排除理由「不在目前接案專長範圍」（`web/src/modules/evaluation/evaluate.ts`），connector 不另寫（步驟 5a）。
- 舊程式有 `exists ||`（已存在的職缺不套篩選、照樣更新）的來源：connector 把讀到但自己的規則沒留下的職缺放進 `Collected.others`；`collectSource` 只拿它們和被 `screen` 擋下的職缺去更新已存在的列，從不新增（Will 2026-11-15，步驟 5a）。舊程式沒有這條的來源不設 `others`。
- 讀到來源自己的讀取上限（頁數）還沒讀完：已讀的照寫，`Collected.truncated = true`（舊的 partial），`collectSource` 回報在 `SourceRun.truncated`，步驟 6 記到執行列。分頁不一致仍是整批失敗；單筆身分壞掉照上面的擱置規則。
- 舊程式為了 serverless 時限設的整個來源的時間預算不搬：讀取範圍由請求上限界定；`Fetcher` 一次一個請求、間隔至少 1 秒，舊的預算在這裡只會讓執行失敗（步驟 5a：hackernews、freelancer）。
- `extra` 只放 connector 讀到、契約沒有欄位、之後稽核用得到的東西（例：原始的工作類型、原始的發布時間字串）。不放全文副本。

## 3. id 穩定（D10 後，步驟 5a2 改寫）

- 新系統不承接舊資料（D10），`external_id` 不必等於舊值；只要求同一來源的同一筆職缺每次讀取都算出同一個值。主鍵是資料庫產生的代理鍵，`(source, external_id)` 唯一。
- 網址型 id 用標準 `URL` 解析並組回固定形狀（例如去掉預設埠、只留路徑）；不寫相容函式、不比對 `golden.json` 的舊值。
- fixture 至少有一個案例證明同一筆職缺的不同寫法（預設埠、前後空白、大小寫不同的主機名）得到同一個 id，以及一個不合格網址被跳過。
- 網址欄位（`url`、`canonical_url`）照該來源 fixture 的既有形狀：舊 connector 存原文的照存原文（不讓 `URL` 把非 ASCII 路徑轉成百分比編碼），舊 connector 存正規化網址的（例如 cryptojobslist）照存正規化網址。

## 4. Fixture

- `fixtures/generate.ts` 從 `golden.json` 產生 `fixtures/cases.json`：輸入是 golden 的 payload（JSON），預期輸出是舊系統的結果經 `legacyToInput`（步驟 10 的轉換函式）轉成契約，跟新 connector 無關，所以是獨立的對照。只跑一次；之後 golden 在步驟 11 刪除，`cases.json` 留著。
- 新 connector 與舊結果不同的案例，一律在產生器裡逐案列出並寫理由，不手改 `cases.json`。分四類（`free-jobs` 的數量供參考）：
  - `D8_UNKNOWN`：舊的拒收，D8 改成「該欄位未知、職缺照收」（6 例：地區、發布時間的型別不對或讀不出來）。
  - `ACCEPTED`：舊的拒收，新的因語言差異照收（1 例：JSON 數字在 JavaScript 不分整數與浮點數，id `1.0` 就是 1）。
  - `PATCHED`：舊結果的某欄位刻意改變（1 例：Python 與 V8 的 Unicode 小寫版本不同，只影響不認得的工作類型字串）。
  - `REFUSED`：舊的照收，新的拒收（1 例：超過 2^53 的 id，JavaScript 的數字存不準，拒收才能保住 `external_id`）。
- connector 新增的欄位（例：`location` 改填來源的地區文字）也在產生器裡寫明。
- HTML 轉文字與舊的 html.parser 移植版在 98 個片段中有 15 個不同，全是舊版錯（結尾未完的文字被丟掉、顯示瀏覽器不會顯示的內容）；落單的區塊結束標籤（`</p>`、`</br>`）照舊當斷字。空白字元用 JavaScript 的 `\s`，與 Python `str.split()` 在 NEL、U+001C–U+001F、BOM 上不同（已接受，步驟 4 審查）。新預期寫在 `shared/html.test.ts`。時間一律經 `shared/time.ts`，它用 `listings` 的同一個 ISO 解析器，不另寫；RFC 2822 日期用 `rfc2822Instant`／`pubDateInstant`（照 Python `email.utils.parsedate_to_datetime` 的步驟，golden `parsedate` 70 例對照；非 ASCII 數字不讀，已接受）。

## 5. 測試與 mutation

- 每個來源目錄要有自己的 `*.test.ts`（`web/tests/structure.test.ts` 擋）。
- 至少要有：fixture 全過；整批失敗（非 JSON、清單不在、超量）；一筆缺身分夾在好的之間：好的照收、`rejected: 1`（Will 2026-11-15，步驟 5a VM 實跑）；未知保持未知；來源自己的篩選；`services/collect.test.ts` 型的收案案例（只寫通過篩選的、失敗時一筆都不寫、擱置超過 `examined` 一半時拒收且一筆都不寫、剛好一半照寫、重跑同一份不變）；多頁或多查詢的來源，要有「同一筆壞資料在每一頁／每個查詢都出現、好的也一樣」不被拒收的案例。
- fixture 產生器裡，舊程式單筆擱置（`rejected_count`）的案例，預期值就是舊結果加上擱置數（標 `SET_ASIDE`），不再列為 `REFUSED`。
- mutation（用複本跑，不在工作目錄改了再還原）至少：`external_id` 改一個字元、拿掉一條拒收規則、拿掉來源自己的篩選、拿掉單筆擱置（改回整批失敗），各要有測試失敗；有相容 id 函式的再加上面那條。
- 舊 connector 與它的測試不在這一步刪：舊的每日執行在步驟 6 之前還用它們，步驟 11 一起刪。

## 6. VM 上的驗收（部署點，先取得 Will 授權）

- 時間避開台灣 09:00–13:00 與 14:00–14:30，並排在正式站當天的每日執行之後。
- 正式庫的數字（唯讀，只輸出狀態與計數）：
  - 當天的 `seen`、`jobs`：`cf d1 query <id> --sql "select json_extract(result,'$.source_details.<來源>') from daily_runs where local_date='<YYYY-MM-DD>'"`。
  - 該來源的 `external_id` 清單，存到 repo 外（本機個人脈絡檔記的 spike 原始輸出位置），複製到 VM 的暫存檔：`cf d1 query <id> --json --sql "select external_id from opportunities where source='<來源>'"`。
- 在 VM 上（先部署含這個來源的版本，見 `deploy/README.md`）：用 README 的 `compose` 函式跑 `compose run --rm -v <清單檔>:/tmp/expect.txt:ro daily pnpm exec tsx scripts/run-source.ts <來源> --expect /tmp/expect.txt`，跑完刪清單檔。輸出只有計數、id 與時間。
- 判讀：`seen`、`jobs` 與正式庫同日差距在步驟寫的範圍內（步驟 4 是 5%、步驟 5 是 20%）；`newOnly` 的每一筆，發布時間要晚於正式庫該來源最後一次執行，否則就是同一筆職缺換了 id 寫法，停下來查。結果記在該步驟的進度列，原始輸出放 repo 外。
