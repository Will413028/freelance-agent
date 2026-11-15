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
- 身分欄位（id、標題、內文、來源自己的網址）缺或格式不對：丟 `SourceError`，整批失敗，不寫任何一筆。來源自己的篩選規則要讀的欄位（例：工作類型）也算：它讀不到時會整批篩光，變成「成功但 0 筆」。格式變了要變成「來源失敗」。
- 同一個 id 在一次回應裡出現兩次：留最後一筆（收案核心拒收重複的批次）。
- `Fetcher` 依呼叫順序一次服務一個請求，connector 可以並行呼叫，間隔與上限仍成立。
- 其他欄位轉不了：寫 `null`（未知），不猜、不拒收（D8）。三態欄位只在來源明說時寫 `true`／`false`；remote、worldwide 不等於台灣可接。
- 時間：有時區的照轉；沒時區的，照來源的規則決定（例：jobicy、remotive 以 UTC 發布，`utcInstant`），規則寫在 connector 的註解裡。截止日照契約的四種形狀。
- 來源自己的篩選規則（例：只收合約類）放在 connector；與設定無關的資格初篩是共用的，在 `web/src/services/collect.ts` 的 `screen`，connector 不重做。
- `extra` 只放 connector 讀到、契約沒有欄位、之後稽核用得到的東西（例：原始的工作類型、原始的發布時間字串）。不放全文副本。

## 3. id 不變

- `external_id` 對該來源既有列的輸入要算出既有的值。用 fixture 證明：輸入取自 `golden.json` 該來源的案例，預期值來自舊輸出。
- 舊程式用 `@/platform/py/url` 算 id 的來源：先用標準 `URL` 寫；fixture 有案例不一致時，寫一個原生、有測試的相容函式，並加一個 mutation「把相容函式換成標準 `URL` 寫法要有測試失敗」。
- 網址欄位保留來源的拼法（WHATWG `URL` 會把非 ASCII 路徑轉成百分比編碼，跟既有值不同）；`URL` 只拿來驗證。

## 4. Fixture

- `fixtures/generate.ts` 從 `golden.json` 產生 `fixtures/cases.json`：輸入是 golden 的 payload（JSON），預期輸出是舊系統的結果經 `legacyToInput`（步驟 10 的轉換函式）轉成契約，跟新 connector 無關，所以是獨立的對照。只跑一次；之後 golden 在步驟 11 刪除，`cases.json` 留著。
- 新 connector 與舊結果不同的案例，一律在產生器裡逐案列出並寫理由，不手改 `cases.json`。分四類（`free-jobs` 的數量供參考）：
  - `D8_UNKNOWN`：舊的拒收，D8 改成「該欄位未知、職缺照收」（6 例：地區、發布時間的型別不對或讀不出來）。
  - `ACCEPTED`：舊的拒收，新的因語言差異照收（1 例：JSON 數字在 JavaScript 不分整數與浮點數，id `1.0` 就是 1）。
  - `PATCHED`：舊結果的某欄位刻意改變（1 例：Python 與 V8 的 Unicode 小寫版本不同，只影響不認得的工作類型字串）。
  - `REFUSED`：舊的照收，新的拒收（1 例：超過 2^53 的 id，JavaScript 的數字存不準，拒收才能保住 `external_id`）。
- connector 新增的欄位（例：`location` 改填來源的地區文字）也在產生器裡寫明。
- HTML 轉文字與舊的 html.parser 移植版在 98 個片段中有 15 個不同，全是舊版錯（結尾未完的文字被丟掉、顯示瀏覽器不會顯示的內容）；落單的區塊結束標籤（`</p>`、`</br>`）照舊當斷字。空白字元用 JavaScript 的 `\s`，與 Python `str.split()` 在 NEL、U+001C–U+001F、BOM 上不同（已接受，步驟 4 審查）。新預期寫在 `shared/html.test.ts`。時間一律經 `shared/time.ts`，它用 `listings` 的同一個 ISO 解析器，不另寫。

## 5. 測試與 mutation

- 每個來源目錄要有自己的 `*.test.ts`（`web/tests/structure.test.ts` 擋）。
- 至少要有：fixture 全過；整批失敗（非 JSON、清單不在、超量、一筆缺身分）；未知保持未知；來源自己的篩選；`services/collect.test.ts` 型的收案案例（只寫通過篩選的、失敗時一筆都不寫、重跑同一份不變）。
- mutation（用複本跑，不在工作目錄改了再還原）至少：`external_id` 改一個字元、拿掉一條拒收規則、拿掉來源自己的篩選，各要有測試失敗；有相容 id 函式的再加上面那條。
- 舊 connector 與它的測試不在這一步刪：舊的每日執行在步驟 6 之前還用它們，步驟 11 一起刪。

## 6. VM 上的驗收（部署點，先取得 Will 授權）

- 時間避開台灣 09:00–13:00 與 14:00–14:30，並排在正式站當天的每日執行之後。
- 正式庫的數字（唯讀，只輸出狀態與計數）：
  - 當天的 `seen`、`jobs`：`cf d1 query <id> --sql "select json_extract(result,'$.source_details.<來源>') from daily_runs where local_date='<YYYY-MM-DD>'"`。
  - 該來源的 `external_id` 清單，存到 repo 外（本機個人脈絡檔記的 spike 原始輸出位置），複製到 VM 的暫存檔：`cf d1 query <id> --json --sql "select external_id from opportunities where source='<來源>'"`。
- 在 VM 上（先部署含這個來源的版本，見 `deploy/README.md`）：用 README 的 `compose` 函式跑 `compose run --rm -v <清單檔>:/tmp/expect.txt:ro daily pnpm exec tsx scripts/run-source.ts <來源> --expect /tmp/expect.txt`，跑完刪清單檔。輸出只有計數、id 與時間。
- 判讀：`seen`、`jobs` 與正式庫同日差距在步驟寫的範圍內（步驟 4 是 5%、步驟 5 是 20%）；`newOnly` 的每一筆，發布時間要晚於正式庫該來源最後一次執行，否則就是同一筆職缺換了 id 寫法，停下來查。結果記在該步驟的進度列，原始輸出放 repo 外。
