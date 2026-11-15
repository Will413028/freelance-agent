import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { readSettings } from "@/modules/evaluation/public";
import { intakeListings, listingId } from "@/modules/listings/public";
import { Conflict, InvalidSettings, NotFound } from "@/platform/errors";
import { saveSettings, setFeedback, validSettings } from "./public";
import { freshPg } from "../../../tests/helpers/pg";

// Plan step 3c: the feedback and settings writes on Postgres; the routes over them are in tests/web-pages.test.tsx.

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => {
  await db.execute(sql`truncate listings, settings cascade`);
  await intakeListings(db, "jobicy", [{ external_id: "a", title: "API work", kind: "contract" }], "page");
});

const id = listingId("jobicy", "a");
const s = { maxWeeklyHours: 20, minFixedTwd: 3000, categories: ["AI agent"] as const };

describe("setFeedback", () => {
  it("counts revisions from 0 and refuses the token it replaced", async () => {
    expect(await setFeedback(db, id, "0", "interested")).toBe(1);
    expect(await setFeedback(db, id, "1", "skipped")).toBe(2);
    await expect(setFeedback(db, id, "1", "neutral")).rejects.toBeInstanceOf(Conflict);
  });

  it("lets only one of two writes at the same token through", async () => {
    const results = await Promise.allSettled([setFeedback(db, id, "0", "interested"), setFeedback(db, id, "0", "skipped")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(Conflict);
  });

  it("says NotFound for a listing that does not exist", async () => {
    await expect(setFeedback(db, "missing", "0", "interested")).rejects.toBeInstanceOf(NotFound);
  });
});

describe("saveSettings", () => {
  it("saves at revision 0, then only at the stored revision", async () => {
    expect(await saveSettings(db, 0, s)).toBe(1);
    await expect(saveSettings(db, 0, s)).rejects.toBeInstanceOf(Conflict);
    await expect(saveSettings(db, 2, s)).rejects.toBeInstanceOf(Conflict);
    expect(await saveSettings(db, 1, { ...s, maxWeeklyHours: null })).toBe(2);
    expect(await readSettings(db)).toEqual({ revision: 2, settings: { ...s, maxWeeklyHours: null, categories: ["AI agent"] } });
  });

  it("lets only one of two first saves through", async () => {
    const results = await Promise.allSettled([saveSettings(db, 0, s), saveSettings(db, 0, { ...s, minFixedTwd: 0 })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(Conflict);
  });

  it("checks the old preferences() ranges", () => {
    for (const bad of [{ maxWeeklyHours: 0 }, { maxWeeklyHours: 169 }, { maxWeeklyHours: 2.5 }, { minFixedTwd: -1 }, { minFixedTwd: 10_000_001 },
      { categories: [] }, { categories: ["設計"] }, { categories: ["AI agent", "AI agent"] }]) {
      expect(() => validSettings({ ...s, ...bad } as never), JSON.stringify(bad)).toThrow(InvalidSettings);
    }
    expect(validSettings({ ...s, maxWeeklyHours: 168, minFixedTwd: 10_000_000 })).toMatchObject({ maxWeeklyHours: 168 });
  });
});
