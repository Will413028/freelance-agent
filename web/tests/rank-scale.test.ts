import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { DEFAULT_SETTINGS, rankedPage, readRankables } from "@/modules/evaluation/public";
import { intakeListings } from "@/modules/listings/public";
import { freshPg } from "./helpers/pg";

// The listing page's read at the plan's scale (step-3-design.md core choice 1): 3,500 listings the
// page shows (none hard-excluded, so none filtered out), some mail listings with versions, some
// feedback, beside as many stored listings the source's rule drops (plan D9: stored, never read by
// the page); read the shown rows and rank in TS. The decision criterion
// was ≤ 250 ms (half the 500 ms page budget); this guard fails at the budget itself so a slow CI
// machine does not flake, and prints the median for the record.
const LISTINGS = 3_500, RUNS = 20;
const now = new Date("2026-11-15T01:00:00Z");
let db: PgDb, close: () => Promise<void>;

const job = (i: number, extra: Record<string, unknown> = {}) => ({
  external_id: `s${i}`, title: `${["AI agent workflow", "RAG chatbot", "Backend API", "Fullstack MVP", "Zapier automation"][i % 5]} ${i}`,
  description: `Build something ${i}`, url: `https://example.com/jobs/${i}`, kind: ["fixed", "hourly", "contract", "contract"][i % 4],
  currency: i % 3 ? "TWD" : "USD", budget_min: 1000 + (i % 7) * 500, budget_max: 2000 + (i % 11) * 1000, weekly_hours: i % 6 ? (i % 50) : null,
  taiwan_eligible: [true, null, null][i % 3], timezone_compatible: i % 4 ? true : null, complete: i % 2 === 0,
  published_at: new Date(now.getTime() - (i % 10) * 86_400_000).toISOString(), deadline: i % 9 ? null : { kind: "date", date: `2026-11-${10 + (i % 10)}` }, ...extra,
});

beforeAll(async () => {
  ({ db, close } = await freshPg());
  const page = Array.from({ length: LISTINGS - 500 }, (_, i) => job(i));
  await intakeListings(db, "jobicy", page, "page", now);
  await intakeListings(db, "himalayas", Array.from({ length: LISTINGS }, (_, i) => job(200_000 + i)), "page", now, { sourceKept: () => false });
  const mail = Array.from({ length: 500 }, (_, i) => job(100_000 + i));
  await intakeListings(db, "tasker", mail, "mail", now);
  // One in five mail listings gets a second, different content: two version rows each.
  await intakeListings(db, "tasker", mail.filter((_, i) => i % 5 === 0).map((j) => ({ ...j, budget_max: 99_000 })), "mail", now);
  await db.execute(sql`insert into listing_feedback (listing_id, state, revision)
    select id, case when row_number() over (order by id) % 2 = 0 then 'interested' else 'skipped' end, 1 from listings where source <> 'himalayas' order by id limit 300`);
}, 600_000);
afterAll(async () => close());

describe("ranked read at plan scale", () => {
  it(`reads and ranks ${LISTINGS} listings within the page budget`, async () => {
    expect((await readRankables(db, "job")).length).toBe(LISTINGS);
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const started = performance.now();
      await rankedPage(db, "job", DEFAULT_SETTINGS, now, "all", 0);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const median = times[RUNS / 2];
    process.stderr.write(`rankedPage: ${LISTINGS} listings, median ${median.toFixed(1)} ms, max ${times.at(-1)!.toFixed(1)} ms over ${RUNS} runs\n`);
    expect(median).toBeLessThan(500);
  });
});
