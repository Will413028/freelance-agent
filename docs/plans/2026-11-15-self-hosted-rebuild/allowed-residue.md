# 步驟 11 允許留下的殘留

驗收指令（在 repo 根目錄）：

```bash
rg -n -l "@/platform/py/|golden|@/db/d1|@/db/client|workflow|vercel|sqliteTable|D1_|oci-a1" . -g '!node_modules' > "$TMPDIR/residue.txt"
python3 docs/plans/2026-11-15-self-hosted-rebuild/check_inventory.py --residue "$TMPDIR/residue.txt"
```

`check_inventory.py`（舊計畫同名檔的複本，讀同目錄的本檔）只讀下面 `globs` 區塊。語法：`**` 跨目錄，`*` 不跨 `/`，路徑相對 repo 根目錄。程式檔逐一列出，不用目錄萬用字元，以免遮住新的殘留。

```globs
docs/plans/**
docs/adr/**
docs/README.md
docs/design.md
docs/implementation-plan.md
docs/platform-research.md
README.md
deploy/web.Dockerfile.dockerignore
web/pnpm-lock.yaml
web/src/modules/**/*.fixtures.json
web/src/modules/evaluation/evaluate.ts
web/src/modules/evaluation/evaluate.test.ts
web/src/modules/evaluation/rank.test.ts
web/src/modules/listings/legacy-time.ts
web/src/modules/sources/freelancer/index.ts
web/src/modules/sources/arbeitnow/arbeitnow.test.ts
web/src/modules/sources/community-jobs/community-jobs.test.ts
web/src/modules/sources/cryptojobslist/cryptojobslist.test.ts
web/src/modules/sources/free-jobs/free-jobs.test.ts
web/src/modules/sources/freelancer/freelancer.test.ts
web/src/modules/sources/getonboard/getonboard.test.ts
web/src/modules/sources/himalayas/himalayas.test.ts
web/src/modules/sources/shared/html.test.ts
web/src/modules/sources/taiwanjobs/taiwanjobs.test.ts
web/tests/rank-scale.test.ts
```

## 每一項的理由

| glob | 為什麼可以留 |
|---|---|
| `docs/plans/**` | 兩份計畫、盤點、spike 紀錄與檢查腳本本身；描述的就是被取代的系統，本檔也含這些字。 |
| `docs/adr/**` | ADR 記錄當時的脈絡，不改寫。 |
| `docs/README.md` | 指向舊遷移計畫與 ADR 的歷史連結（「為什麼搬到 Next.js＋Vercel＋D1」）。 |
| `docs/design.md`、`docs/implementation-plan.md` | 仍描述舊系統（Vercel Workflow、D1、golden）。改寫排在步驟 12（`implementation-plan.md` 原本就在；`design.md` 在步驟 11 加進步驟 12）。 |
| `docs/platform-research.md` | 第三方平台介紹裡的「agent workflows」，不是本系統。 |
| `README.md` | 過渡期說明：切換前正式站仍是凍結的 Vercel 部署加 D1；步驟 10 後改寫。 |
| `deploy/web.Dockerfile.dockerignore` | 排除 `.vercel`：主 checkout 在步驟 10 退役前還有 Vercel 連結目錄，不能進映像的建置內容。 |
| `web/pnpm-lock.yaml` | 生成檔；命中的是 `drizzle-orm` 的選用 peer dependency `@vercel/postgres`，不是本專案的相依。 |
| `web/src/modules/**/*.fixtures.json` | 測試資料：合成職缺內文裡的「workflow」，以及 `about` 欄記錄案例出自 golden.json。 |
| 其餘逐一列出的程式與測試檔 | 註解或測試名稱以「golden」說明案例的出處（已搬成各自的 fixture），或合成職缺標題含「workflow」（`rank.test.ts`、`rank-scale.test.ts`）；沒有 import 或讀取舊程式。 |

## 考慮過但不允許的

- `web/src/**`、`web/tests/**` 整個目錄：會遮住真的殘留（例如新寫的程式又 import 舊路徑）。
