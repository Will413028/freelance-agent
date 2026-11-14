# 步驟 14 允許留下的殘留

步驟 14 的驗收指令（在 repo 根目錄）：

```bash
rg -n -l "oci-a1|compose|huey|8327|3327|freelance\." . > /tmp/residue.txt
python3 docs/plans/2026-10-23-nextjs-vercel-migration/check_inventory.py --residue /tmp/residue.txt
```

`check_inventory.py` 只讀下面 `globs` 區塊。語法：`**` 跨目錄，`*` 不跨 `/`，路徑相對於 repo 根目錄（開頭的 `./` 會先去掉）。

```globs
docs/plans/**
docs/adr/**
web/pnpm-lock.yaml
web/tests/fixtures/golden.json
web/src/platform/py/unicode-tables.json
```

## 每一項的理由

| glob | 為什麼可以留 |
|---|---|
| `docs/plans/**` | 本計畫、兩份盤點、spike 紀錄與 `check_inventory.py` 本身。它們描述的就是被取代的系統，而且這份清單本身就含這些字。 |
| `docs/adr/**` | ADR 記錄當時的脈絡（`oci-a1`、Compose、Huey），不改寫。 |
| `web/pnpm-lock.yaml` | 生成檔。第三方套件名可能含 `compose`（例如 `@radix-ui/react-compose-refs`），integrity hash 的 base64 也可能剛好含 `8327`、`3327`。lockfile 不會帶部署設定，所以列入不會遮住真正的殘留。 |
| `web/tests/fixtures/golden.json` | 凍結的測試資料（步驟 14 起不能再生）。命中的是合成職缺內文裡的字（2 行，`rg -c` 量到），不是設定或程式。 |
| `web/src/platform/py/unicode-tables.json` | 生成的 Unicode 碼位表，一行數字陣列；命中的是剛好含 `8327`、`3327` 的碼位。 |

## 考慮過但不允許的

| 路徑 | 為什麼不允許 |
|---|---|
| `docs/compose.md` 改名後的操作手冊 | 步驟 14 把它改寫成 Vercel 操作並改名成 `docs/operations.md`。步驟 14 在 D6 窗口結束、VM 退役時才做完，那時已經沒有「重啟 VM 的 Compose」這條回滾路徑，所以操作手冊不需要再提 Compose。舊的回滾程序留在 git 歷史與本計畫。 |
| `AGENTS.md` | 現在第 3、9 行命中：引用 `docs/compose.md`，以及「compose features」這個動詞。步驟 14 收斂遷移期規則時，前者改指操作手冊，後者改寫成「組合 features」。保留它會讓真正的舊規則殘留被放行。 |
| `README.md`、`docs/README.md`、`docs/design.md`、`docs/features.md`、`docs/implementation-plan.md`、`docs/platform-connectivity.md` | 都是描述現況的文件，步驟 14 會改寫。舊部署的段落直接刪除（2026-11-15 步驟 14：`docs/implementation-history.md` 在 2026-10-23 已移到私人封存 repo，這個 repo 沒有它；舊內容留在 git 歷史）。`platform-connectivity.md` 說明 PTT 停用時寫「Vercel 出口被 403 challenge」（D12），不需要寫 VM 主機名。 |
| `backend/**`、`frontend/**`、`deploy/**`、`contracts/**`、`scripts/test_compose.py` 等 | 步驟 14 刪除。 |

新增一項要同時寫進 `globs` 區塊和上面的理由表；理由必須說明這個檔案為什麼不會藏住真正的殘留。
