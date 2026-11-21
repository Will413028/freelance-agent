import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { intakeListings, listingBy } from "@/modules/listings/public";
import { NotFound } from "@/platform/errors";
import { listContests, listingDetail, listJobs, listQuery, writeFeedback } from "@/services/pages";
import { ContestDetail, ContestList, Shell } from "@/app/_lib/views";
import { freshPg } from "./helpers/pg";

// Opportunity types plan step 5: the contest tab, a contest's detail and feedback on the route keyed by
// listing id, and a listing of a type this image does not know.

const now = new Date("2026-11-21T02:00:00Z");
const contest = (id: string, changes: Record<string, unknown> = {}) => ({
  opportunity_type: "contest", external_id: id, title: `Hackathon ${id}`, company: "Example Org", url: `https://${id}.devpost.com/`, ...changes,
});
const job = (id: string) => ({ external_id: id, title: "Backend API contractor", description: "Build an LLM automation backend", url: `https://example.com/jobs/${id}`, kind: "contract" });

let db: PgDb, close: () => Promise<void>;
const key = async (externalId: string, source = "devpost") => String((await listingBy(db, source, externalId))!.id);
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => {
  await db.execute(sql`truncate listings, settings cascade`);
  await intakeListings(db, "devpost", [
    contest("late", { deadline: { kind: "date", date: "2027-01-15" }, prize_text: "$10,000", budget_max: 10000, currency: "USD", online: true, hackathon: true, invite_only: false }),
    contest("soon", { deadline: { kind: "date", date: "2026-11-25" }, invite_only: true, online: false, location: "Taipei, Taiwan" }),
    contest("unknown"),
    contest("past", { deadline: { kind: "date", date: "2026-11-01" } }),
  ], "page", now, { opportunityType: "contest" });
  await intakeListings(db, "jobicy", [job("j1")], "page", now);
});

describe("contest tab", () => {
  it("reads the type from the query, jobs when it is left out or unknown", () => {
    expect(listQuery({ type: "contest", view: "all", page: "2" })).toEqual({ type: "contest", view: "all", page: 2 });
    expect(listQuery({})).toEqual({ type: "job", view: "candidates", page: 1 });
    expect(listQuery({ type: "bounty" }).type).toBe("job");
  });

  it("lists the contests by deadline with the unknown one last, and no job; the job list has no contest", async () => {
    const data = await listContests(db, now, "candidates", 1);
    expect(data.contests.map((c) => c.contest.title)).toEqual(["Hackathon soon", "Hackathon late", "Hackathon unknown"]);
    expect((await listContests(db, now, "all", 1)).contests.map((c) => [c.contest.title, c.state]).at(-1)).toEqual(["Hackathon past", "expired"]);
    expect((await listJobs(db, now, "all", 1)).jobs.map((j) => j.job.title)).toEqual(["Backend API contractor"]);
  });

  it("shows unknown prize, deadline and place as unknown, and marks an invite-only contest", async () => {
    const html = renderToStaticMarkup(<ContestList data={await listContests(db, now, "candidates", 1)} />);
    expect(html).toContain("獎金待確認");
    expect(html).toContain("截止日待確認");
    expect(html).toContain("地點待確認");
    expect(html).toContain("僅限受邀");
    expect(html).toContain("$10,000");
    expect(html).toContain("截止 2027-01-15");
    expect(html).toContain("Taipei, Taiwan");
    expect(html).not.toContain("Backend API contractor");
    expect(html).toContain(`href="/?type=contest&amp;view=saved"`);
    expect(renderToStaticMarkup(<Shell active="contests"><p /></Shell>)).toContain(`<a href="/?type=contest" class="nav-active">競賽清單</a>`);
  });
});

describe("contest detail and feedback", () => {
  it("shows a contest on the listing route and saves it into the contests' saved view only", async () => {
    const id = await key("soon");
    const detail = await listingDetail(db, now, id);
    if (detail.type !== "contest") throw new Error("not a contest");
    expect(detail.contest).toMatchObject({ state: "open", candidate: null, feedback: "neutral", token: "0" });
    const html = renderToStaticMarkup(<ContestDetail contest={detail.contest} />);
    expect(html).toContain("僅限受邀");
    expect(html).toContain(`action="/jobs/${id}/feedback"`);
    expect(html).toContain(`href="https://soon.devpost.com/"`);
    await writeFeedback(db, id, detail.contest.token, "interested", now);
    expect((await listContests(db, now, "saved", 1)).contests.map((c) => c.contest.title)).toEqual(["Hackathon soon"]);
    expect((await listJobs(db, now, "saved", 1)).jobs).toEqual([]);
    expect((await listingDetail(db, now, await key("j1", "jobicy"))).type).toBe("job");
  });

  it("answers not found, page and feedback, for a listing of a type this image does not know (after a rollback)", async () => {
    const id = await key("late");
    // As a newer image would have written it; the CHECK of this image's schema is lifted for the test only.
    await db.execute(sql`alter table listings drop constraint listings_opportunity_type`);
    try {
      await db.execute(sql`update listings set opportunity_type = 'bounty' where id = ${Number(id)}`);
      await expect(listingDetail(db, now, id)).rejects.toBeInstanceOf(NotFound);
      await expect(writeFeedback(db, id, "0", "interested", now)).rejects.toBeInstanceOf(NotFound);
      expect((await listContests(db, now, "all", 1)).contests.map((c) => c.contest.title)).not.toContain("Hackathon late");
    } finally {
      await db.execute(sql`truncate listings cascade`);
      await db.execute(sql`alter table listings add constraint listings_opportunity_type check (opportunity_type in ('job', 'contest'))`);
    }
  });
});
