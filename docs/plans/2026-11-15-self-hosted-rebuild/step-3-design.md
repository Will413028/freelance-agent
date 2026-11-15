# 步驟 3 設計稿：新資料模型、評估與排序的放法

狀態：design-review 兩輪後定稿（2026-11-15）；Q1、Q2 已決（計畫 D6、D7）。行為的依據是現行程式（快照 `81cd847`），引用寫成 `web/` 下的路徑。

## 核心選擇

1. **評估分成「與設定、時間無關」與「與設定或時間有關」兩半。** 與設定、時間無關的部分在寫入時算好存成 `listings` 的欄位（類別、類別分數、硬性排除、已確認條件數、可比的 TWD 固定案上限、截止時刻、發布時刻）；與設定或時間有關的部分（工時上限、預算底價、類別篩選、截止日到期、新鮮度、收藏加分）在清單查詢裡用 `settings` 單列直接算。
   - 取代：舊的 `discovery_items`／`discovery_versions` 投影表，以及存設定時重寫整張表、每列帶 `settings_revision`、讀到舊 revision 就拒讀的機制（`web/src/modules/discovery/projection.ts`）。
   - 必要條件：清單頁要在 SQL 裡排序分頁（3,500 筆、≤ 500 ms），不能每次在 TS 算完全部再排；存的欄位只要與設定、時間無關，就不會因存設定而過期，所以不需要投影表與 revision 欄。
   - 這個必要條件還沒量過（審查第 1 輪）：3b 第一件事是量「讀 3,500 列加 TS 全量排序」的伺服器端時間（PGlite 與 VM 各一次）。在 500 ms 預算的一半內，就只留 TS 一份實作，SQL 只撈列，上面的評估欄位只留顯示與篩選要用的；超過才採用下面的 SQL 算式。結論寫回本節。
   - **3b 量測結論（2026-11-15）：只留 TS。** PGlite 上 3,500 筆（500 筆信件職缺、100 筆有兩個版本、300 筆有回饋）讀全部事實欄位加 TS 排序，20 次中位數 38.4 ms、最大 75.2 ms（`web/tests/rank-scale.test.ts`；審查者另跑一次 41.6／50.4 ms）。SQL 只撈列（`modules/evaluation/list.ts`），排序在 `rank.ts`；下面「清單查詢」段的算式改由 `rank.ts` 實作，不寫成 SQL，也就沒有 TS／SQL 一致測試。存的評估欄位仍全部需要（排序要讀）。VM（Will 2026-11-15 授權，暫時容器量完即刪）：真 Postgres 18.7 上同一測試兩輪中位數 22.2／22.5 ms、最大 28.6／29.0 ms，結論相同。3d 的清單頁中位數若超過 250 ms，且主要花在這段讀取與排序，就回到 SQL 算式。CI 的守門門檻是 500 ms（250 ms 在共用 CI 機器上會偶發失敗），所以 250–500 ms 之間的退化 CI 抓不到，要看測試印出的中位數。
   - 若採用 SQL 算式，兩份實作（TS 的 `evaluate`／排序與 SQL 查詢）的一致性：用測試守（同一批 fixture 跑 TS 與 PGlite 上的 SQL，排序與分數要相同），不在每次讀取時比對（舊的 `ProjectionMismatch` 執行期檢查與重試刪除）。頁面上的理由、待確認問題文字仍在 TS 對當頁 50 筆算。
2. **`source_receipts` 不留。** 同一筆不重收靠 `listings (source, external_id)` 唯一鍵 upsert，加上 `fingerprint` 比對決定是否記新內容。信件的投遞身分（哪封信處理過）放 `mail_messages (source, recipient, message_id)`。舊的 `receipt_collision`（同一封信的收據被兩筆職缺搶）在沒有收據後不存在，`mail_messages.status` 不留 `conflict`；正式庫 `mail_ingestion` 2026-11-15 唯讀計數 `conflict` 0 列（processed 381、rejected 77），所以不另加批內檢查；步驟 7 的 parser 若出現同一封信解析出重複 `external_id`，在那裡加批內唯一檢查。
   - 收據原本還擋兩件事（審查第 1 輪指出）：
     - **晚到的舊通知不蓋新內容**（`collection/observation.ts` `olderNotification`）：新設計不需要另設機制（審查第 2 輪）。信件來源只有第一次建列時寫職缺列，之後收到不同內容一律記進 `listing_versions`（核心選擇 4），兩份並列給人看，先後不影響結果；一般來源的內容只在每次抓取時寫入，抓取時刻本身單調。所以不加 `observed_at` 單調條件，`olderNotification` 不搬。3a 驗收：同一信件職缺先收新信再收舊信，職缺列不變、版本多一列。
     - **內容回到看過的版本（A→B→A）不蓋回**：多數來源的 `receipt_id` 含內容雜湊，所以舊系統對回頭內容只重算、不採用。新設計以最後一次為準、蓋回（D6）。
3. **職缺內容的身分 `fingerprint`** 改成原生：對通過契約的 `ListingInput`（去掉 `extra`、值為 null 的欄位不計）的正規化 JSON 取 sha256（3b2／D8 修訂；原寫「對職缺 JSON 去掉 `received_at` 等觀察欄位」）。它只用來判斷內容變了沒，不跨系統比對，步驟 10 搬資料時對舊列重算，不沿用 v1 值。`id` 照全域約束維持舊算法（`id.fixtures.json` 守）。
4. **內容版本 `listing_versions`** 照現行語意（正式庫 30 列；保留理由：同一職缺的通知信會在不同信裡給出互相矛盾的內容，而信件沒有「目前狀態」可查，兩份都要給人看；一般來源的頁面就是目前狀態，覆寫即可）：只有信件來源在同一職缺收到不同內容時記下（原內容與新內容各一列），職缺列本身不改；一般來源收到新內容就覆寫職缺列，不留版本。版本列帶同一組評估欄位，排序取「仍可能的版本中最高分」。
5. **回饋的防過期 token 只用 `listing_feedback.revision`**（盤點表已定）。舊 token 另含職缺 fingerprint 與版本集合的雜湊，代表「職缺內容變了，開著的頁面按鈕就失效」；新做法下內容變了不擋收藏／略過。理由：收藏與略過不依賴內容細節，舊行為讓每日收案後開著的頁面全部 409。
6. **舊的 `review_status = skipped`** 不進新表；步驟 10 搬資料時併成 `listing_feedback.state = skipped`。

## 表

全部在 `web/src/db/pg/schema.ts`。時間一律 `timestamptz`。三態欄位用可為 null 的 boolean，null 是未知。

### `listings`

| 欄 | 型別 | 說明 |
|---|---|---|
| `id` | text PK | 舊算法，原樣 |
| `source`、`external_id` | text not null | unique `(source, external_id)` |
| `fingerprint` | text not null | 原生內容雜湊 |
| `raw` | jsonb not null | 來源給的整份職缺（含非公開的 evidence 欄位） |
| `title`、`company`、`description`、`url`、`canonical_url`、`location` | text | 頁面顯示用；`title` not null |
| `kind` | text | check in fixed/hourly/contract/full_time，null 未知 |
| `currency` | text | |
| `budget_min`、`budget_max`、`weekly_hours` | numeric | null 未知 |
| `taiwan_eligible`、`timezone_compatible`、`complete`、`listing_closed` | boolean | null 未知 |
| `published_at` | timestamptz | 依各來源規則解析出的發布時刻（`ranking.ts` 的 `publishedAt`）；解析不了為 null |
| `deadline_at` | timestamptz | 截止時刻；只有日期的存「該日次日 00:00 Asia/Taipei」（D7，修缺陷 B1）；沒有或解析不了為 null |
| `category`、`category_score` | text、smallint not null | 類別與分數（95/85/75/70，「其他」0） |
| `hard_excluded` | boolean not null | 有任何與設定、時間無關的排除理由（結案、無薪、無類別、全職、台灣資格或時區明確不符） |
| `confirmed_base` | smallint not null | 台灣資格、時區、完整需求三者為 true 的數量（工時那一項在查詢裡依設定算） |
| `fixed_twd_max` | numeric | 固定案、TWD、預算區間有效時的上限；否則 null（查詢用它比底價） |
| `first_seen_at` | timestamptz | 新列預設 now；步驟 10 搬來的舊列為 null（舊系統沒有記） |
| `updated_at` | timestamptz not null | 最後一次內容變更 |

索引：`(source, external_id)` unique；清單查詢若量到需要再加，不預先加。

### `listing_versions`

`(listing_id FK, fingerprint)` PK；`raw` jsonb、`observed_at`，以及與 `listings` 相同的顯示與評估欄位（schema 用同一組欄位定義展開）。

### `listing_feedback` 與 `listing_feedback_events`

- `listing_feedback`：`listing_id` PK FK、`state` text check in neutral/interested/skipped、`revision` int not null（每次寫入 +1）、`updated_at`。沒有列等於 neutral、revision 0。舊 state JSON 的 stage／reason／note／evidence 不留（頁面從未設定；note/evidence 在正式庫 4 列中的值於步驟 10 核對後決定，見待確認）。
- `listing_feedback_events`：identity PK、`listing_id`、`revision`、`state`、`created_at`；unique `(listing_id, revision)`。同一交易寫入。

### `settings`

單列：`id` smallint PK check `= 1`、`revision` int、`max_weekly_hours` smallint null（check 1–168）、`min_fixed_twd` integer（check 0–10,000,000）、`categories` text[]（check 非空、是四類的子集；不重複由應用層驗證）。沒有列時用預設 30／3000／四類、revision 0。存檔：`update … where revision = $seen`，0 列受影響就 409；第一次存用 `insert … on conflict do nothing` 搭配 revision 0 判斷。

### `mail_messages`、`mail_cursors`

- `mail_messages`：PK `(source, recipient, message_id)`；`status` check in processed/rejected；`reason` text（原因代碼：解析階段，或 `non_job_notification`、`content_changed`）；`disposition` check in none/retry/dismissed（步驟 7 的重排與消掉；取代 `retry_pending`）；`checked_at`。
- `mail_cursors`：PK `(source, recipient)`；`cursor`、`after`、`head` text null（語意照 `mail/sync.ts`）。

### `runs`、`run_sources`

- `runs` 照步驟 2，加 `reason` text。
- `run_sources`：PK `(run_id FK, source)`；`status` check in ok/waiting/failed；`reason`、`error`（`http_NNN` 或錯誤類別）、`tier`（plain/browser_like/browser，步驟 8 前都是 plain）；`started_at`、`finished_at`；`counts` jsonb（來源自己的計數，鍵與值的格式沿用 `run-source.ts` 的限制）。`/sources` 讀最近一次（步驟 6）。舊 `source_details` 把頂層 status/reason 與來源鍵混在同一層的問題因此消失。

## 清單查詢（SQL 要算的部分）

`now` 與 `settings` 是參數：

- `hours_ok = weekly_hours > 0 and (max_weekly_hours is null or weekly_hours <= max_weekly_hours)`
- `excluded = hard_excluded or (weekly_hours > 0 and weekly_hours > max) or fixed_twd_max < min_fixed_twd or category <> all(categories) or deadline_at <= now`
- `base_tenths = category_score*7 + 25*(confirmed_base + hours_ok)`；`fresh = 100`（0 ≤ now−published ≤ 2 天）／`60`（2–7 天）／`0`
- 版本取最高分照 `projection.ts:177-212`；`score = least(1000, best + 100*interested)`
- `candidate = (可能 or 有可能的版本) and feedback <> skipped`；四種檢視與排序 `candidate desc, score desc, id asc`、每頁 50 照舊。

## 既有缺陷與處置

| # | 缺陷 | 建議處置 |
|---|---|---|
| B1 | 只有日期的截止日以 UTC 次日 00:00 到期（台灣時間 08:00），比台灣日界線晚 8 小時才顯示「已過期」 | 修（D7）：改台北日界線；回歸測試：截止日 D、`now` = D+1 台北 00:30（UTC D 16:30）要判過期，舊寫法不判 |
| B2 | 收案初篩（`qualifyForIntake`）把當下被排除的新職缺直接丟掉，之後改設定救不回 | ~~接受，步驟 4、5 各來源照現行；它只丟與設定無關的排除~~ 被計畫 D9（Will 2026-11-15）取代：收案存全部，挑選交給查詢，由步驟 5a2 實作 |
| B3 | `remote_scope` 在公開欄位白名單但沒有來源會填 | 修：不建欄位，留在 `raw` |

## 子步驟（一個 session 做不完，拆成各有驗收的子步驟）

- **3a 資料模型與收案核心**：schema 與 migration；`modules/listings/`（id 函式、fingerprint、`upsertListing` 一個交易內寫職缺／版本、評估欄位的寫入端計算）；`id.fixtures.json`。驗收：`pnpm check`；`id.fixtures.json` 全過；信件職缺先新後舊兩封：職缺列不變、版本多一列；一般來源 A→B→A 最後是 A（D6）；mutation（id 分隔字元、拿掉唯一鍵、信件第二封改成覆寫職缺列）各有測試失敗。
  - 實作紀錄（2026-11-15）：`web/drizzle-pg/` 重新產生成單一 `0000_init.sql`（切換前可重建，計畫全域約束）；VM 上步驟 2 的庫有舊 `0000` 的紀錄，3d 部署時要整個重建 db volume，不是跑 migration。walking skeleton 的 `/skeleton` 頁、`seed-skeleton.ts` 與 `services/skeleton.ts` 提前在 3a 刪除（新 `listings` 欄位讓 skeleton 的寫入不成立）；它唯一的測試案例（seed 兩次仍一列並顯示在頁面）由 `listings.test.ts`「inserts, then leaves the same content unchanged」取代，其餘案例留在 `tests/pg-base.test.ts`。評估事實放 `web/src/modules/evaluation/facts.ts`（3b 在同一模組加評估與排序）。
- **3b 評估與排序**：`modules/evaluation/`（原生型別的 evaluate、排序、清單查詢）；golden 的 `evaluate` 492 例與 `recommendation` 198 例轉成原生 fixture（拿掉 `portfolio_ids` 與群組欄）；先量「讀 3,500 列加 TS 全量排序」（核心選擇 1），依結果二選一：≤ 250 ms 只留 TS 排序、SQL 只撈列；否則採 SQL 算式並加 TS 與 SQL 同 fixture 一致的測試。截止日改台北日界線（D7），受影響的 fixture 預期逐筆記下。驗收：量測數字寫回核心選擇 1；fixture 全過；B1 回歸測試；mutation：把版本取最高分或候選條件改掉要有測試失敗。
  - 實作紀錄（2026-11-15）：`modules/evaluation/` 加 `rank.ts`（以事實欄位算排除、分數十分位、候選、排序）、`evaluate.ts`（帶文字的 evaluate 與 recommend，給頁面的 50 筆用，排除與分數都由 `rank.ts` 判，fixture 測兩者一致）、`list.ts`（讀設定、讀全部事實、分頁四種檢視）。fixture：evaluate 492 例帶 480、recommendation 198 例帶 192、fromisoformat 61 例全帶（其中 11 例 native 刻意拒絕）；捨棄 18 例（Python 拋例外 12、輸入是 NaN 6），每例原因寫在 fixture 的 `dropped`；刻意改變 12 例寫在 `step-3b/changes.json` 並標在案例的 `change`（基本格式日期 `20991231` 改當日期、ISO 週日期改問有效截止日）。（3b2 撤回：輸入改經 `legacyToInput`，這 12 例回到 golden 的預期，`changes.json` 刪除。）D7 的台北日界線在 golden 的 now（台北 09:00）下影響 0 例。轉換腳本在 `step-3b/`。golden 的 recommendation 沒有任何內容版本案例，版本行為由 `rank.test.ts` 手寫案例守。完成度的固定案預算欄位改用設定的底價（舊碼寫死 3000，設定可改後會誤導）。
- **3b2 輸入契約**（計畫 D8；3b 審查後插入）：`modules/listings/contract.ts` 的 zod `ListingInput`；`modules/listings/legacy.ts` 把舊格式 job JSON 轉進契約（舊的寬鬆時間解析與發布時間來源特例搬到這裡，供步驟 10 與 fixture 轉換用）；`listings` 加欄位 `compensation_evidence`、`deadline_kind`（date／instant／no_timezone／invalid）、`deadline_text`；`evaluation/` 的事實、evaluate、recommend 只吃型別化的 `Listing`（契約或存檔列），不再讀 `raw`、不看來源名稱；fingerprint 算在契約內容上；fixture 的輸入改成舊格式 job 經轉換後的契約，golden 的預期不改（12 例「刻意改變」撤回），golden 裡型別邊界的案例（非文字 title、NaN 等）改成契約與轉換的測試。驗收：`pnpm check`；evaluate、recommendation、fromisoformat fixture 全過且沒有 `change`；契約拒收、轉換轉成未知各有測試；mutation：契約接受無 offset 的時刻、轉換把格式無效整列拒收、評估改回讀 `raw` 的截止日、fingerprint 改回算 `raw`，各要有測試失敗。
  - 實作紀錄（2026-11-15）：zod 4.6.7。`listings/contract.ts`（`ListingInput`，strict，來源特有欄位放 `extra`）、`listings/legacy.ts`（`legacyToInput`）、`listings/legacy-time.ts`（舊的寬鬆解析，從 `evaluation/time.ts` 移來，補上週日期、任意分隔字元、`:` 小數，fromisoformat 61 例全部與 Python 一致，不再有刻意拒絕）。`evaluation/` 只吃 `Listing`（`listing.ts`），`facts.ts` 不再有 `source` 參數與發布時間的來源特例。`listings` 與 `listing_versions` 加 `compensation_evidence`、`deadline_kind`、`deadline_text`，CHECK 保證 `deadline_at` 只在日期或時刻時存在、`deadline_text` 只在有給截止日時存在；`drizzle-pg/0000_init.sql` 重產。fixture：evaluate 帶 480 例、recommendation 帶 198 例（NaN 經轉換成未知，6 例回來），預期全部是 golden 原值；捨棄 12 例，都是 Python 拋例外（非文字 title 或 description）。契約允許空字串 title（舊系統存得下）；`legacyToInput` 只拒收非文字 title／external_id 與來源名稱不符的列，這些是舊系統的評估會直接拋錯、存不進去的資料（正式庫 2026-11-15 唯讀計數：3,475 列中非文字或空 title 0 列）。fingerprint 不計值為 null 的欄位，以後契約加欄位不會讓既有職缺全部變成新內容；信件路徑把原內容記成版本時用存好的欄位，不重新解析 `raw`。正式庫同日唯讀計數：`deadline` 帶時區 226、純日期 3、null 3,246、其他 0；`published_at` 帶時區 62、純日期 1（jobbank518，舊規則讀成未知）、缺或 null 3,412。
- **3c 頁面與寫入路由**：四個頁面、回饋與設定路由改讀寫新表；刪 `app/skeleton/`、`seed-skeleton.ts`；`web-pages`、`web-guard` 測試改對 PGlite（每個原案例都有對應，D1 專屬的用量記錄與儲存訊號兩案例刪除並記下）。驗收：`pnpm check`；mutation：過期 revision 檢查、同站來源檢查各拿掉要有測試失敗。
  - 實作紀錄（2026-11-15）：清單、詳情、設定三頁與兩個寫入路由改讀寫 Postgres（`getPgDb`）；`/sources` 照計畫步驟 3 範圍留在 D1 到步驟 6，所以「四個頁面」實際改三個。寫入在新模組 `modules/review/`：回饋的 token 是 `listing_feedback.revision`（沒有列時 0），交易內鎖職缺列、比對 revision、寫狀態並加一筆事件；設定用單一語句（revision 0 時 `insert … on conflict do nothing`，否則 `update … where revision = 期望值`），兩個同時的第一次儲存只有一個成功；範圍與文字照舊的 `preferences()`。頁面只對當頁 ≤ 50 筆讀列、版本與回饋（`modules/listings/read.ts`），理由與待確認問題用 `evaluate`／`recommend` 算。拿掉的顯示：`display_basis`（D18 不跨來源合併，沒有主卡依據）、`location_evidence`（不是契約欄位，在 `extra`）。測試對應：舊 `web-pages` 的清單、詳情、回饋、設定、markup 案例都搬到 PGlite（`tests/web-pages.test.tsx`），其中「長地點清單顯示前幾項」因為已沒有清單型的顯示欄位而刪除，「儲存資料損壞回 500」改成「事件與回饋列不一致時寫入撞唯一鍵回 500」；`/sources` 的兩個案例與 D1 用量記錄案例沒有刪，跟著仍在 D1 的 `/sources` 移到 `tests/web-sources.test.tsx`（設計稿原寫刪除，但它們測的程式這一步沒動）。新增：設定儲存後重排、未知保持未知、信件版本差異顯示與排序、超前與格式錯的 token、第一次儲存前 revision 非 0。`web-guard.test.ts` 不必改（守門程式沒動）。
- **3d VM 驗收**（部署點，要 Will 授權）：灌 3,500 筆合成職缺，清單頁伺服器端 20 次中位數 ≤ 500 ms，其中讀取加排序（`rankedPage`）另記；超過 250 ms 照核心選擇 1 回到 SQL 算式；經 Tailscale Serve 送一次回饋與一次設定儲存都成功。

## 決定題（交 Will）

- **Q1 內容回到看過的版本（A→B→A）怎麼處理**（已決 2026-11-15，Will 選 A：以最後一次為準；計畫 D6）
  - A：以最後一次為準，蓋回 A。一般來源的頁面就是目前狀態，來源真的改回去就該跟著改。（建議）
  - B：查 `listing_versions` 或另存看過的 fingerprint 集合，看過就不蓋。照舊行為，但一般來源也要記 fingerprint 集合，多一個機制，而它擋的「來源內容來回晃動」目前沒有證據。
- **Q2 只有日期的截止日用哪條日界線**（已決 2026-11-15，Will 選 B：台北日界線；計畫 D7）
  - A：照現行（UTC 次日 00:00）。fixture 照搬不用改。
  - B：台北日界線（台灣當日 24:00 到期）。更貼近使用者看到的日期；evaluate fixture 中跟日期型截止日有關的預期要重算並逐筆記下。（建議：使用者與多數台灣來源都以台灣日期寫截止日）

## 待確認

- 正式庫 `opportunity_tracking` 4 列的 note/evidence 有沒有值：步驟 10 前唯讀查一次；有值才考慮留欄。
