import { eq } from "drizzle-orm";
import { writeTransaction, type Db, type Executor } from "@/db/client";
import { discoverySettings } from "@/db/schema";
import { Conflict } from "@/platform/errors";
import { encode, loadsDict } from "@/platform/py/json";
import { PyDict, type PyValue } from "@/platform/py/value";
import { defaults, preferences } from "./rules";

// Port of discovery/settings.py: rules owns the contract and defaults, this owns their storage.

export type Settings = { revision: bigint; settings: PyDict };

export async function readSettings(tx: Executor): Promise<Settings> {
  const [row] = await tx.select().from(discoverySettings).where(eq(discoverySettings.id, 1));
  return row ? { revision: BigInt(row.revision), settings: loadsDict(row.settings) } : { revision: 0n, settings: preferences(defaults()) };
}

export const settingsDict = (s: Settings) => PyDict.of({ revision: s.revision, settings: s.settings });

export async function replaceSettings(db: Db, revision: PyValue, value: PyValue): Promise<Settings> {
  const settings = preferences(value);
  return writeTransaction(db, async (tx) => {
    const current = await readSettings(tx);
    if (typeof revision !== "bigint" || revision !== current.revision) throw new Conflict("篩選設定已更新，請重新載入");
    const next = { revision: Number(revision + 1n), settings: encode(settings) };
    await tx.insert(discoverySettings).values({ id: 1, ...next }).onConflictDoUpdate({ target: discoverySettings.id, set: next });
    return { revision: revision + 1n, settings };
  });
}
