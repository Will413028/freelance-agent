# Spike 1c 結果：指紋相容

**結論：成立。** 9 個會持久化的雜湊點，加上 1 個會持久化的序列化點，TypeScript 都能逐位元重現：合成 corpus 707/707 相符（量到）。前提是下面列的實作規則，其中三條不能省：無損解析、code point 排序，以及凍結成 CPython 版本的 Unicode 表。沒有碰到計畫裡寫的停止條件「有雜湊點無法逐位元重現」，D4-A（指紋逐位元延續）可以照原案走。

環境：Python 3.13.13（unicodedata 15.1.0），Node v26.10.0（ICU Unicode 17.0）。只用合成資料，沒有讀正式 DB 與 `runtime/`，也沒有連網路。`pnpm install` 不需要，因為 Node 26 原生支援 type stripping。

## 各雜湊點結果

點的定義見 `hash-points.md`。「real」是直接 import `backend/src` 裡的 Python 函式；「replica」是把那一行 `json.dumps` 原封不動抄進 generator，因為那一行包在連接器的解析函式或 class 方法裡，直接呼叫要準備整份上游 payload。

| 點 | Python 來源 | 案例 | 相符 |
|---|---|---|---|
| HP1 `identity_hash` | real | 74 | 74 |
| HP1b `rules._hash` | real | 72 | 72 |
| HP1c `legacy/postgres._hash` | replica（缺 psycopg 模組，無法 import） | 69 | 69 |
| HP1d opportunity id 與 fingerprint 的組法 | real `identity_hash`；組法照 `store.py:64-65` | 3 | 3 |
| HP1e 從已存文字重算的 `identity_hash`（novelty 讀回 job 的路徑） | real | 72 | 72 |
| HP2 receipt（ea=F，含前綴與排除鍵） | `ptt_codejob`／`ptt_soho` 用 real `receipt()`，其餘 replica | 7 | 7 |
| HP3 receipt（ea=T） | replica | 74 | 74 |
| HP4 submission `digest` | real | 74 | 74 |
| HP4b `digest(json.loads(已存文字))` | real | 69 | 69 |
| HP5 `identity_keys`（urlsplit、`text()`、repr） | real | 62 | 62 |
| HP6 `novelty` | real | 23 | 23 |
| HP7 group member token | real `group_items` | 5 | 5 |
| HP8 legacy review key | replica | 3 | 3 |
| HP9 純字串 sha256（加上暫態的 intent key 與檔名後綴） | replica | 26 | 26 |
| HP10 `platform.sqlite.encode` | real | 74 | 74 |

錯誤案例也算進比對：Python 丟例外的案例，TS 也必須丟。這些案例包括 ea=F 遇到孤立 surrogate 時的 `UnicodeEncodeError`、HP4 遇到 NaN 或 Infinity 時的 `ValueError`，以及 receipt 收到非 dict 時的 `KeyError`／`AttributeError`。

**反向對照（量到）。** 用 `SPIKE_CONTROL=<x>` 把每條規則換回 JS 的天真做法，確認測試真的會失敗：

| 換回的天真做法 | 相符數 |
|---|---|
| 不排序 key | 640/707 |
| 用 UTF-16 排序 | 693/707 |
| separators 改錯 | 583/707 |
| 用 `String(x)` 格式化 float | 516/707 |
| 用 `JSON.parse` 讀已存文字 | 668/707（HP4b 只剩 51/69） |
| 用 `toLowerCase` 取代 casefold | 695/707 |
| 用 `.length` 數 body 長度 | 705/707 |
| 直接用 ICU 的 NFKC | 705/707 |

計畫第 223 行要求「不排序或 separators 改錯時測試要失敗」，這兩項都確認會失敗。

## 無法重現的案例

**在範圍內：沒有。** 範圍外，或有條件才能重現的有下面幾項：

1. **MIME 預覽雜湊沒有重現。** 這個點是 `sha256(build_message(...))`，依賴 Python `email` 套件的 MIME 序列化，例如 header folding 與 base64 換行。它是暫態，不存 DB，所以不擋路。規則是：切換當下不能拿 Python 算的預覽雜湊去讓 TS 寄信。切換前讓 pending 的 digest 清空，或在 TS 端重新預覽。
2. **NFKC 版本漂移。** 直接用 Node 的 `String.normalize('NFKC')`（Unicode 17），有 37 個 code point 跟 CPython（15.1）不同，例如 U+1CCD6 OUTLINED LATIN 字母，ICU 會把它變成 `a`。這 37 個全部是 CPython 視為未指派的字元，已指派的字元 0 個不同。`nfkcPy()` 讓這些字元原樣通過，修正後是 0 個不同（量到，逐一比對全部 code point）。
3. **casefold 與 isspace。** JS 的 `toLowerCase` 跟 `str.casefold()` 有 352 個 code point 不同，例如 `ß`、`ς`、Cherokee `ꭰ` 以及 Unicode 16 以後新增的大寫字母。JS 的 `/\s/` 跟 `str.isspace()` 在 BMP 有 6 個不同，例如 `\x1c-\x1f`、`\x85`、`﻿`。所以 TS 用 Python 產生的凍結表（`unicode-tables.json`），不用 JS 內建行為。
4. **連接器怎麼組 `job` dict 不在 1c 範圍。** receipt 與 fingerprint 雜湊的是連接器組出來的 dict。TS 版連接器必須組出同樣的鍵與同樣的值型別，例如 `datetime.isoformat()` 的格式、`float(offset)`、`sorted(types)`，以及 int 與 float 的區別。1c 只證明「同一個值序列化後雜湊相同」。各連接器的 golden fixture 要在搬連接器的那一步補上（推論）。

## 給正式實作的規則

1. **儲存：HP10 的欄位一律用 `text`，不用 `jsonb`。** 舊資料逐位元複製。原因是 jsonb 會重排 key、去掉重複 key、拒絕 `NaN`／`Infinity` 與 `\u0000`，而 pg driver 會把 json／jsonb 自動 `JSON.parse`。反過來，`text` 欄位存的是 `encode()` 的輸出，控制字元已經跳脫成 `\u0000`，所以 Postgres `text` 不收 NUL 的限制不會碰到（推論，依 `encode` 的參數）。
2. **值模型：** 中間表示要帶 Python 型別，也就是 `canonical-json.ts` 的 `Py`。int 用 `bigint`，float 用 `number`，物件用有序的 entry 陣列，因為 JS 物件會把 `"1"`、`"10"` 這類整數鍵往前排。**讀已存的 JSON 文字一律用無損的 `loads()`，禁用 `JSON.parse`。** 因為 `1.0` 會變成 `1`、超過 2^53 的整數會失準，HP4 的核准與 HP6 的 novelty 就會跟著失效。
3. **float：** 照 CPython 的 `repr` 輸出。尾數取最短 round-trip，`decpt <= -4 or > 16` 時用科學記號，指數至少兩位並帶正負號（`1e+16`、`1e-05`、`1.0`、`-0.0`）。允許 NaN 的點輸出 `NaN`／`Infinity`，HP4 則丟例外。不要在任何雜湊路徑上把 float 正規化成 int。
4. **字串：** `ensure_ascii=True` 依 UTF-16 code unit 跳脫成小寫 `\uXXXX`，`0x7f` 也要跳脫。`ensure_ascii=False` 只跳脫 `"`、`\` 與 `< 0x20`。編碼用嚴格 UTF-8（`isWellFormed()`），孤立 surrogate 要丟例外，不能被換成 U+FFFD。
5. **key 排序：** 依 code point 排序（`cmpCodePoint`），不能用預設的 `sort()`。
6. **每個點固定一組參數，不要做成「一個 canonical 函式」。** 目前共有四組：HP1／HP2 是 sort+ea=F+default；HP3 是 sort+ea=T；HP4 是 sort+ea=F+compact+nan=F；HP8 是不排序+ea=T。把它們統一，就是換掉既有的指紋。
7. **`text()`：** 依序是 `str()`，非字串走 Python `repr`（含可印字元表），然後是 `nfkcPy`，再用凍結表做 casefold，最後用凍結的 isspace 切開。body 長度數 code point。Unicode 表由固定版本的 CPython 產生並進 git。CPython 升級也會讓 Python 端漂移，現在的系統本身就有這個脆弱點。
8. **URL key：** 移植的是 `urllib.parse.urlsplit`／`urlunsplit` 的語意，不用 WHATWG `URL`。WHATWG 會把 host 轉小寫、加 `/`、做 percent-encode，例如 `https://x.com` 會變成 `https://x.com/`。
9. **SQL 排序：** HP7 的 `application_token` 依 `ORDER BY a.id` 排序。Postgres 要用 `COLLATE "C"`，跟 SQLite 的 BINARY 一致。目前 id 是 uuid4 小寫，用預設 collation 很可能也同序，但沒有驗證（推論）。
10. **測試：** `expected.json` 的格式可以直接搬進 Vitest，當作 `canonical-json.ts` 的合成期望值測試。正式副本的一次性驗證（計畫 1c 第 4 點）還沒做，需要 Will 授權。

## 重跑指令（在 repository 根目錄）

```sh
# 1. Python 期望值（-I 隔離環境；-B 不在 backend/src 寫 .pyc）。輸出是決定性的：
#    expected.json sha256 = 620ec891cab45b84d38bb4c73bfbcc9528bf2bb18c5c1d571dfc12091e702ade
backend/.venv/bin/python -I -B docs/plans/2026-10-23-nextjs-vercel-migration/spike-1c/gen_expected.py
# 2. TS 比對（Node >= 22.18；退出碼 0 代表全部相符）
node docs/plans/2026-10-23-nextjs-vercel-migration/spike-1c/verify.ts
# 3. 反向對照（每一項都應該出現 FAIL）
for c in no-sort utf16-sort wrong-separators js-float json-parse tolower utf16-length raw-nfkc; do
  SPIKE_CONTROL=$c node docs/plans/2026-10-23-nextjs-vercel-migration/spike-1c/verify.ts | grep TOTAL; done
```

檔案：`hash-points.md`（清單）、`gen_expected.py`、`expected.json`、`unicode-tables.json`（CPython 15.1 的凍結表）、`canonical-json.ts`、`verify.ts`。
