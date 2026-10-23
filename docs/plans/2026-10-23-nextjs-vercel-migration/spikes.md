# Spike 紀錄（步驟 1）

日期：2026-10-23。spike 專案：Vercel `will413028s-projects/freelance-agent-spike`（Hobby），程式在 session scratchpad，不進 repo。套件：`next@16.3.5`、`workflow@5.2.3`。

## 1a 存取控管：成立

測法：先用 `vercel api /v9/projects/freelance-agent-spike -X PATCH`，送 `{"ssoProtection":{"deploymentType":"all"}}`，回應是 `{'deploymentType': 'all'}`。接著沒登入直接 curl：

```
https://freelance-agent-spike.vercel.app/ -> 302 https://vercel.com/sso-api?url=...
https://freelance-agent-spike-reo7ykmo1-will413028s-projects.vercel.app/ -> 302 https://vercel.com/sso-api?url=...
https://freelance-agent-spike.vercel.app/api/egress -> 302 https://vercel.com/sso-api?url=...
```

cron 能穿過保護：用 `vercel crons run /api/cron` 觸發，handler 會核對 `Authorization: Bearer $CRON_SECRET`。log 顯示 `/api/cron 200`，workflow run 也有建立（見 1b）。

結論：Hobby 方案也能讓正式網址只有登入 Vercel 帳號才看得到，而且 cron 照樣能觸發。

## 1b fan-out：成立

測法：用 cron 觸發一個 workflow，裡面是 27 個 `"use step"`。每個 step 睡 60 秒，id=5 故意丟一般的 `Error`。step 函式設 `fakeSource.maxRetries = 0`，workflow 用 `Promise.allSettled` 收集結果。

```
run wrun_41M5MBTJKQ90GY3W0EEBSA3CHZ  status=completed  region=sin1
startedAt 12:29:59.881Z  completedAt 12:31:05.364Z
steps: 26 "status": "completed" / 1 "status": "failed" / 27 "attempt": 1
input/output: "🔒 Encrypted"（workflowEncryptionEnabled: true）
```

結論：
- 27 個 step 平行跑，全部 65 秒跑完。
- 失敗的 step 不影響其他 step，也只跑 1 次，證明 `maxRetries = 0` 有效。
- step 的輸入輸出在 Vercel 端加密存放。「step 只傳 ID」這條不變量照樣保留，用來縮小可能外洩的資料。
- 用量（推算）：最後一個 event 的 ID 是 `evnt_…84`，所以每次 run 約 84 個 event。一個月約 2,600 個，Hobby 每月含 50,000 個（[Workflows pricing](https://vercel.com/docs/workflows/pricing)）。

## 1c 指紋相容：合成資料成立

雜湊點清單在 `spike-1c/hash-points.md`：9 個會存進資料庫的雜湊點，加 1 個存進資料庫的序列化點。各點規則與給正式實作的建議見 `spike-1c/RESULT.md`。

主 session 重跑（2026-10-23）：

```
backend/.venv/bin/python -I -B .../spike-1c/gen_expected.py   → exit 0，expected.json sha256 620ec891…02ade（與 subagent 相同）
node .../spike-1c/verify.ts                                     → TOTAL 707/707，exit 0
反向對照（SPIKE_CONTROL=…）：no-sort 640、utf16-sort 693、wrong-separators 583、js-float 516、
json-parse 668、tolower 695、utf16-length 705、raw-nfkc 705（都是 /707，每一種都會失敗）
```

結論：
- TS 能逐位元重現所有會存進資料庫的雜湊，D4-A 不用改。
- 正式實作有三條不能省的規則：讀已存 JSON 要用無損解析、key 依 code point 排序、Unicode 表凍結成 CPython 15.1 的版本。
- 寄信前算的整封 MIME 預覽 sha256 只在執行當下用、不存資料庫，所以沒有重現。切換後由 TS 自己算，不沿用 Python 算的值。
- 還沒做：用正式副本做一次性驗證，要等 Will 授權讀副本。

## 1d 寄送通道：部分成立

- 從 Vercel 函式用 TLS 連 `smtp.gmail.com:465`，兩個區域都收到 `220` 回應：sin1 1063 ms、iad1 21 ms。
- Resend Receiving API 連得到：不帶 key 時回 401。
- 還沒測：真的登入並寄出一封合成信。要等 Will 把 SMTP 憑證存進 spike 專案的 env，存好回 `done`。

## 1e 出口與時間：只有 PTT 被擋

測法：從 Vercel 函式對每個來源的列表端點各發一次 GET，User-Agent 和 Python 版相同，逾時 25 秒。信件來源不會從 Vercel 主動連來源網站，只連 Resend，所以只測 Resend。

不是 200 的結果：

| 來源 | sin1 | iad1 | VM（oci-a1） | Mac |
|---|---|---|---|---|
| ptt_soho | 403（challenge） | 403（challenge） | 200 | 200 |
| ptt_codejob | 403（challenge） | 403（challenge） | 200 | — |
| jobbank518 | 403 | 200 | 200 | 200 |
| resend_api（不帶 key） | 401 | 401 | — | — |

其餘 19 個端點都是 200，而且沒有 challenge。最慢的是 dynamitejobs，8.5 秒（sin1）。每個請求都遠低於 300 秒。

結論：
- 換到 iad1 區域，被擋的只剩 PTT 兩個版，沒達到停止條件（3 個以上）。
- PTT 的 challenge 依規則不繞過，PTT 的去向要另外決定，見 D12。
- region 選 iad1，Neon 也選 us-east 區域。D1 原本只說「同一區」，這是在那個範圍內選定的區域。
