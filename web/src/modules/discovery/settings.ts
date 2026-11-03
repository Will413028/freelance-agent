import { eq } from "drizzle-orm";
import { read, readAll, type Db } from "@/db/client";
import { discoverySettings } from "@/db/schema";
import type { Writes } from "@/db/unit";
import { Conflict } from "@/platform/errors";
import { encode, loadsDict } from "@/platform/py/json";
import { PyDict, type PyValue } from "@/platform/py/value";
import { defaults, preferences } from "./rules";

// Port of discovery/settings.py: rules owns the contract and defaults, this owns their storage.

export type Settings = { revision: bigint; settings: PyDict };

/** The stored settings row, or the defaults at revision 0 before the first change. */
export const settingsOf = (row: { revision: number; settings: string } | null | undefined): Settings =>
  row ? { revision: BigInt(row.revision), settings: loadsDict(row.settings) } : { revision: 0n, settings: preferences(defaults()) };

export const settingsRead = (db: Db) => read(db.select().from(discoverySettings).where(eq(discoverySettings.id, 1)), ([row]): Settings => settingsOf(row));

export async function readSettings(db: Db): Promise<Settings> {
  return (await readAll(db, [settingsRead(db)]))[0];
}

export const settingsDict = (s: Settings) => PyDict.of({ revision: s.revision, settings: s.settings });

/**
 * The settings write of a settings change, in the caller's unit: compares the revision the caller saw
 * with the one the unit read under the writer lease, then writes the next one. The caller rewrites
 * the projection's settings columns in the same unit (services/discovery.ts replaceSettings).
 */
export function putSettings(writes: Writes, current: Settings, revision: PyValue, settings: PyDict): Settings {
  if (typeof revision !== "bigint" || revision !== current.revision) throw new Conflict("篩選設定已更新，請重新載入");
  writes.put(discoverySettings, { kind: "update", target: discoverySettings.id, set: [discoverySettings.revision, discoverySettings.settings] }, "1",
    { id: 1, revision: Number(revision + 1n), settings: encode(settings) }, null);
  return { revision: revision + 1n, settings };
}
