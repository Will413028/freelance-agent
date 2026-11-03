import { eq } from "drizzle-orm";
import { read, readAll, type Db } from "@/db/client";
import { discoverySettings } from "@/db/schema";
import { UI_WAIT_MS, writeUnit } from "@/db/unit";
import { Conflict, uiBusy } from "@/platform/errors";
import { encode, loadsDict } from "@/platform/py/json";
import { PyDict, type PyValue } from "@/platform/py/value";
import { defaults, preferences } from "./rules";

// Port of discovery/settings.py: rules owns the contract and defaults, this owns their storage.

export type Settings = { revision: bigint; settings: PyDict };

export const settingsRead = (db: Db) => read(db.select().from(discoverySettings).where(eq(discoverySettings.id, 1)), ([row]): Settings =>
  row ? { revision: BigInt(row.revision), settings: loadsDict(row.settings) } : { revision: 0n, settings: preferences(defaults()) });

export async function readSettings(db: Db): Promise<Settings> {
  return (await readAll(db, [settingsRead(db)]))[0];
}

export const settingsDict = (s: Settings) => PyDict.of({ revision: s.revision, settings: s.settings });

/** A page request: compares the revision the caller saw under the writer lease, then writes the next one. */
export async function replaceSettings(db: Db, revision: PyValue, value: PyValue): Promise<Settings> {
  const settings = preferences(value);
  return writeUnit(db, { waitMs: UI_WAIT_MS, busy: uiBusy }, [settingsRead(db)], ([current], writes) => {
    if (typeof revision !== "bigint" || revision !== current.revision) throw new Conflict("篩選設定已更新，請重新載入");
    const next = { revision: Number(revision + 1n), settings: encode(settings) };
    writes.put(discoverySettings, { kind: "update", target: discoverySettings.id, set: [discoverySettings.revision, discoverySettings.settings] }, "1", { id: 1, ...next }, null);
    return { revision: revision + 1n, settings };
  });
}
