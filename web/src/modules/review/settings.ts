import { and, eq } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { CATEGORIES, settings } from "@/db/pg/schema";
import type { Settings } from "@/modules/evaluation/public";
import { Conflict, InvalidSettings } from "@/platform/errors";

// The settings write (step-3-design.md, settings): one row, replaced only at the revision the page
// showed. Nothing else is rewritten: ranking reads the settings at query time (core choice 1).

export const STALE_SETTINGS = "篩選設定已更新，請重新載入";

/** The ranges and wording of the old preferences() (web/src/modules/discovery/rules.ts). */
export function validSettings(s: Settings): Settings {
  const h = s.maxWeeklyHours, b = s.minFixedTwd, c = s.categories as readonly string[];
  if (h !== null && !(Number.isInteger(h) && h >= 1 && h <= 168)) throw new InvalidSettings("工時上限需為 1–168 小時，或不限");
  if (!(Number.isInteger(b) && b >= 0 && b <= 10_000_000)) throw new InvalidSettings("最低固定案預算不符範圍");
  if (!c.length || c.some((x) => !(CATEGORIES as readonly string[]).includes(x)) || new Set(c).size !== c.length) {
    throw new InvalidSettings("請至少選擇一種專長分類");
  }
  return { maxWeeklyHours: h, minFixedTwd: b, categories: [...s.categories] };
}

/** Replaces the settings when `revision` is the stored one (0: none saved yet); returns the new revision. */
export async function saveSettings(db: PgDb, revision: number, given: Settings): Promise<number> {
  const s = validSettings(given);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Conflict(STALE_SETTINGS);
  const values = { maxWeeklyHours: s.maxWeeklyHours, minFixedTwd: s.minFixedTwd, categories: [...s.categories], revision: revision + 1 };
  // One statement either way, so two first saves cannot both win: the second insert finds the row.
  const written = revision === 0
    ? await db.insert(settings).values({ id: 1, ...values }).onConflictDoNothing().returning({ revision: settings.revision })
    : await db.update(settings).set(values).where(and(eq(settings.id, 1), eq(settings.revision, revision))).returning({ revision: settings.revision });
  if (!written.length) throw new Conflict(STALE_SETTINGS);
  return written[0].revision;
}
