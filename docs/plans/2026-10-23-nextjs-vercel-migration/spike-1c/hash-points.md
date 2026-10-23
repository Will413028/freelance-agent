# Spike 1c：雜湊與序列化點清單

來源指令（2026-10-23，branch `plan/nextjs-vercel-migration`，量到 133 行；計畫寫的 131 行是只搜 `sha256|json.dumps` 的結果）：

```sh
rg -n "sha256|json.dumps|hashlib|md5" backend/src | wc -l      # 133
rg -n "dumps\b|hexdigest|blake2|uuid5|uuid3|hmac\.new|from json import|import json as|JSONEncoder|orjson|model_dump_json" backend/src \
  | rg -v "json\.dumps|sha256\("                                 # 只多出 antigravity_guard.py:29 的 hexdigest，沒有別名匯入
```

`md5`、`blake2`、`uuid5` 都沒有命中。133 行歸成 10 個會持久化的點（9 個雜湊點，加上 1 個只存位元組、不參與雜湊的序列化點），其餘都是暫態。

`json.dumps` 參數的縮寫：`sort` 是 `sort_keys=True`；`ea=F` 是 `ensure_ascii=False`，`ea=T` 是預設值 True；`sep=default` 是 `', '` 與 `': '`；`sep=compact` 是 `(',', ':')`；`nan=F` 是 `allow_nan=False`。所有呼叫都沒有傳 `default=`、`indent` 或 `cls`（列在暫態的 CLI 輸出除外）。雜湊一律是 `sha256(s.encode()).hexdigest()`，也就是嚴格的 UTF-8：孤立 surrogate 會丟出 `UnicodeEncodeError`。

## 持久化（影響已儲存的 ID、receipt、fingerprint、snapshot 或核准雜湊）

| 點 | file:line | 參數 | 雜湊的內容 | 存在哪裡／誰會拿來比對 | 備註 |
|---|---|---|---|---|---|
| HP1 identity_hash | `modules/collection/store.py:10-11`，用在 `:64`、`:65`、`:106-107` | sort, ea=F, sep=default | `[source, external_id]` 當 ID；`job` 去掉 `received_at, receipt_id, evidence_ref, raw_evidence_ref` 當 fingerprint | `opportunities.id`、`fingerprint`、`mail_content_versions`、`source_receipts.opportunity_id`；收案時拿新的 fingerprint 跟已存的比 | 參數相同的還有 `discovery/rules.py:60-61` 的 `_hash`、`legacy/postgres.py:19-20`、`legacy/review.py:34` |
| HP2 receipt（ea=F） | `jobbank518.py:128`、`getonboard.py:53`、`cake_mail.py:97`、`guru.py:100`、`public_feeds.py:158`、`cryptojobslist.py:65`、`arbeitnow.py:82`、`chickpt.py:107`、`ptt_codejob.py:61`、`jobbank104_mail.py:98`、`dynamitejobs.py:100`、`ptt_soho.py:81`、`taiwanjobs.py:80`、`indeed_mail.py:228`、`glassdoor_mail.py:142`、`nodesk.py:108`、`talent_mail.py:220`、`justremote.py:106`（都在 `modules/collection/`） | sort, ea=F, sep=default | 連接器組好的 `job`。`taiwanjobs` 去掉 `received_at`；`ptt_*` 去掉 4 個 evidence／receipt 鍵 | `source_receipts.receipt_id`（dedup：收過的就不再收） | 前綴：`<src>:h`；`getonboard:<identity>:h`；`<source>:str(identity):h`；`arbeitnow:<slug>:h` |
| HP3 receipt（ea=T） | `himalayas.py:67`、`linkedin_mail.py:91`、`free_jobs.py:52`、`community_jobs.py:29` | sort, ea=T, sep=default | 連接器組好的 `job`／`result` | `source_receipts.receipt_id` | 跟 HP2 只差 `ensure_ascii`；`free_jobs` 的前綴是 `source:str(p['id']):h`（id 若是 float 會變成 `7.0`） |
| HP4 submission digest | `modules/submissions/domain.py:12-13`；`submissions/store.py:47`、`:54`、`:66` 會呼叫 | sort, ea=F, sep=compact, nan=F | 送出 envelope | `submission_intents.snapshot_hash`、`approval_hash`；核准與 claim 時會從 `json.loads(snapshot 文字)` 重算 | 解析後再序列化必須無損（int 與 float 分開、大整數） |
| HP5 identity_keys | `modules/discovery/rules.py:64-78`（`text()` 在 `:55-56`） | 經過 `_hash`（同 HP1 的參數） | `url:` + `urlsplit(url)._replace(fragment='').geturl()`；`content:` + `_hash([text(company), text(title), text(body), kind, text(location_evidence or location)])` | `digest_outbox.snapshot.items[].novelty_keys`，透過 HP6 | `text()`：NFKC → `casefold` → `str.split`；非字串會變成 `str(value)`，也就是 Python 的 `repr`（例如 `"{'@type': 'Country'}"`）；`len(body) >= 80` 算的是 code point 數 |
| HP6 novelty | `modules/discovery/rules.py:81-92`；`notifications/store.py:61-66` 會讀寫 | `_hash` | 13 個欄位組成的 content dict，跟 identity_keys 配成 pair；再加上 `(id, fingerprint)` | `digest_outbox.snapshot`；新算出的 pair 跟舊 snapshot 存的 pair 比對，決定「已通知過」 | 不一致的話，舊案會被重新通知 |
| HP7 group member token | `modules/discovery/rules.py:137-141`；`applications/store.py:117`（`f"{id}:{revision}:{deleted_at or ''}"`，`ORDER BY a.id`） | `_hash` | `fp + ':' + str(rev)` [`+ ':' + _hash(sorted(衝突 fps))`] [`+ ':applications:' + _hash(app_token)`] | `proposal_drafts.source_tokens`、submission snapshot 的 `source_tokens`；`bootstrap/store.py:67`、`:118-130` 會跟新算的 token 比對 | `app_token` 的順序由 SQL `ORDER BY a.id` 決定，這是 collation 問題，不是 JSON 問題 |
| HP8 legacy review key | `legacy/review.py:32` | 不排序、ea=T、sep=default，取 `[:24]` | `[source, external_id]` | 舊版 JSON review store 的 ID | 只有舊資料 |
| HP9 純字串 sha256 | `legacy/postgres.py:128`、`legacy/review_service.py:34`、`legacy/review.py:119` | 不經過 JSON | `sha256(proposal.encode())` | 舊版 `approved_hash`（逐版本核准） | 依「保留歷史 proposal 核准」的規則，屬於持久化 |
| HP10 storage encode | `platform/sqlite.py:12-13`，所有 `encode(...)` 寫入都經過它 | 不排序（保留插入順序）、ea=F、sep=default | 不雜湊 | 每個 JSON 文字欄位：`opportunities.item`、`digest_outbox.snapshot`、`submission_intents.snapshot`、`proposal_*`、`request_payload`、`mail_content_versions.job` | 位元組會持久化，之後被 `json.loads` 讀回，再送進 HP4／HP6；replay 用 `json.loads(...) != command` 做語意比較，不比位元組 |

## 暫態（不會存起來，或只在單一行程或單次操作者流程內比對）

| file:line | 是什麼 | 為什麼算暫態 |
|---|---|---|
| `notifications/daily.py:35` | 摘要輸出檔名的後綴 `sha256(recipient)[:12]` | 只是本機檔名；HP9 一併測過 |
| `notifications/gmail_send.py:35`、`resend_send.py:41` | `sha256(str(intent_id))` 當 Message-ID 或 Idempotency-Key | 寄出去就結束（Resend 的 key 有期限）；HP9 一併測過 |
| `daily.py:86`、`gmail_send.py:66`、`:84`、`gmail_smtp.py:15`、`bootstrap/jobs.py:23`、`gmail_smtp_cli.py:27`、`gmail_send_cli.py:41`、`resend_send_cli.py:37` | 整封 MIME 的 `sha256`（預覽雜湊） | 不存 DB；同一個行程內，或由操作者手動帶進 CLI。依賴 Python `email` 套件的 MIME 序列化，本 spike **沒有**重現 |
| `notifications/resend_delivery.py:29`、`resend_send.py:27` | Resend 的 HTTP body（sort, ea=F, compact） | 只當 HTTP body；`resend_send.py:63` 的預覽雜湊同上 |
| `submissions/freelancer.py:27` | Freelancer API 的 body（nan=F） | 只當 HTTP body |
| `notifications/digest.py:41`、`discovery/service.py:38`（`encode` 比較） | 顯示用，以及欄位差異判斷 | 同一個行程內 |
| `resend_preview.py:231`、`intake.py:27`、`scheduler_cli.py:31`、`recovery.py:20`、`:23`、`gmail_smtp_cli.py:31`、`daily_cli.py:51`、`cli.py:51`、`daily.py:34`、`mail_sync.py:118`、`:133`、`resend_send_cli.py:44`、`gmail_send_cli.py:49`、`legacy/ai_worker.py:6` | CLI stdout 或預覽檔 | 給人看 |
| `bootstrap/export.py:14` | `contracts/openapi.json` | 產生出來的契約檔，不是資料 |
| `legacy/antigravity.py:107`、`:139`、`:148`、`:150`、`legacy/antigravity_guard.py:25-29`、`:43-44`、`:63`、`:66`、`:70`、`:98`、`:163`、`:178`、`:211` | 已退役的 AI 子行程協定、執行檔雜湊證明、稽核紀錄 | 已退役；不是產品資料 |
| 其餘 `sha256`／`hashlib` 命中 | `import` 或參數名稱（`expected_sha256`） | 不是雜湊點 |

不經雜湊、但同樣會持久化的 receipt 組法（供參考）：`tasker.py:106` 是 `f'{message_id}:{external_id}'`；`freelancer.py:36` 是 `f"freelancer:{id}:{stamp}"`。
