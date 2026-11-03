import { readAll, type Db } from "@/db/client";
import { applicationProjectionsRead } from "@/modules/applications/public";
import { contentVersionsRead } from "@/modules/collection/public";
import { rankOrder, settingsRead } from "@/modules/discovery/public";
import { allRecordsRead } from "@/modules/legacy/public";
import { trackingStatesRead } from "@/modules/preferences/public";
import type { PyDateTime } from "@/platform/py/datetime";
import type { PyDict } from "@/platform/py/value";
import { assembleItems, listPage, MAX_PAGE } from "@/services/discovery";

/**
 * list_in as it was before the projection (plan step 10e2 removed it from the product): every row
 * read and evaluated, recommended and ranked in TS. The reference the projection read is held to.
 */
export async function referenceList(db: Db, now: PyDateTime): Promise<PyDict[]> {
  const [rows, s, contentRows, states, applications] = await readAll(db,
    [allRecordsRead(db), settingsRead(db), contentVersionsRead(db), trackingStatesRead(db), applicationProjectionsRead(db)]);
  return rankOrder(assembleItems(rows, s.settings, contentRows, states, applications, now));
}

/** The whole list through the product read (the projection), page by page, for tests that look at every listing. */
export async function list(db: Db, now: PyDateTime): Promise<PyDict[]> {
  const out: PyDict[] = [];
  for (let offset = 0; ; offset += MAX_PAGE) {
    const page = await listPage(db, now, { offset, limit: MAX_PAGE });
    out.push(...page);
    if (page.length < MAX_PAGE) return out;
  }
}
