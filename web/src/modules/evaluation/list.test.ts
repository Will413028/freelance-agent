import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { intakeListings, listingBy } from "@/modules/listings/public";
import { DEFAULT_SETTINGS, rankedPage, readRankables } from "./public";
import { freshPg } from "../../../tests/helpers/pg";

// Plan D9: intake stores every listing read; the listing query picks the ones the page considers.

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => db.execute(sql`truncate listings cascade`));

const now = new Date("2026-11-15T01:00:00Z");
const job = (id: string, changes: Record<string, unknown> = {}) => ({
  external_id: id, title: `AI agent backend ${id}`, description: "Build an API", url: `https://example.com/${id}`, kind: "contract", ...changes,
});
const shownIds = async () => {
  const ids = new Set((await readRankables(db)).map((r) => r.id));
  const out: string[] = [];
  for (const id of ["kept", "dropped", "excluded", "dropped-saved", "mail"]) {
    const row = await listingBy(db, id === "mail" ? "tasker" : "jobicy", id);
    if (row && ids.has(row.id)) out.push(id);
  }
  return out;
};

describe("which stored listings the page considers", () => {
  it("those the source's rule keeps and no hard reason excludes, those with a usable mail version, and any with feedback", async () => {
    await intakeListings(db, "jobicy", [job("kept"), job("dropped"), job("dropped-saved"), job("excluded", { kind: "full_time" })], "page", now,
      { sourceKept: (id) => !id.startsWith("dropped") });
    // A mail listing first seen hard-excluded, then with a content that is not: the version keeps it in.
    await intakeListings(db, "tasker", [job("mail", { kind: "full_time" })], "mail", now);
    await intakeListings(db, "tasker", [job("mail")], "mail", now);
    const saved = await listingBy(db, "jobicy", "dropped-saved");
    await db.execute(sql`insert into listing_feedback (listing_id, state, revision) values (${saved!.id}, 'interested', 1)`);
    expect(await shownIds()).toEqual(["kept", "dropped-saved", "mail"]);
    const all = await rankedPage(db, DEFAULT_SETTINGS, now, "all", 0);
    expect(all.total).toBe(3);
  });
});
