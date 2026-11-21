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
  const ids = new Set((await readRankables(db, "job")).map((r) => r.id));
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
    // A neutral feedback row (saved, then set back) keeps nothing in.
    await db.execute(sql`update listing_feedback set state = 'neutral' where listing_id = ${saved!.id}`);
    expect(await shownIds()).toEqual(["kept", "mail"]);
    await db.execute(sql`update listing_feedback set state = 'interested' where listing_id = ${saved!.id}`);
    const all = await rankedPage(db, "job", DEFAULT_SETTINGS, now, "all", 0);
    expect(all.total).toBe(3);
  });

  it("only listings of the asked type, on every branch: kept, mail version and feedback (opportunity types plan D1)", async () => {
    await intakeListings(db, "jobicy", [job("kept"), job("dropped-saved")], "page", now, { sourceKept: (id) => !id.startsWith("dropped") });
    await intakeListings(db, "tasker", [job("mail", { kind: "full_time" })], "mail", now);
    await intakeListings(db, "tasker", [job("mail")], "mail", now);
    const saved = await listingBy(db, "jobicy", "dropped-saved");
    await db.execute(sql`insert into listing_feedback (listing_id, state, revision) values (${saved!.id}, 'interested', 1)`);
    expect(await shownIds()).toEqual(["kept", "dropped-saved", "mail"]);
    // Written by a newer image: no contest code exists yet, so the rows are set directly.
    await db.execute(sql`update listings set opportunity_type = 'contest'`);
    await db.execute(sql`update listing_versions set opportunity_type = 'contest'`);
    expect(await shownIds()).toEqual([]);
    expect((await rankedPage(db, "job", DEFAULT_SETTINGS, now, "all", 0)).total).toBe(0);
  });
});

