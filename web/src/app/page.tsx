import { getPgDb, type PgDb } from "@/db/pg/client";
import type { OpportunityType } from "@/db/pg/schema";
import type { View } from "@/modules/evaluation/public";
import { listContests, listJobs, listQuery, runStale } from "@/services/pages";
import { withPageLog } from "./_lib/page-log";
import { ContestList, JobList, NoticeLine, Shell, StaleLine } from "./_lib/views";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

/** One loader per type: a type added to OPPORTUNITY_TYPES does not compile until it has its own. */
async function load(type: OpportunityType, db: PgDb, now: Date, view: View, page: number) {
  switch (type) {
    case "job": return { type, jobs: await listJobs(db, now, view, page) };
    case "contest": return { type, contests: await listContests(db, now, view, page) };
  }
}
const ACTIVE = { job: "jobs", contest: "contests" } as const satisfies Record<OpportunityType, string>;

/** The listing page (plan step 3c): one ranked page of a view of one opportunity type (`?type=`, jobs when left out), candidates first. */
export default async function Page({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const { type, view, page } = listQuery(params);
  const db = getPgDb(), now = new Date();
  // The stale check stays out of listJobs: the daily run times listJobs as the list query's budget.
  const [data, stale] = await withPageLog(`/?type=${type}&view=${view}&page=${page}`, () => Promise.all([
    load(type, db, now, view, page),
    runStale(db, now),
  ]));
  return <Shell active={ACTIVE[data.type]}>
    <StaleLine stale={stale} />
    <NoticeLine notice={typeof params.notice === "string" ? params.notice : undefined} />
    {data.type === "job" ? <JobList data={data.jobs} /> : <ContestList data={data.contests} />}
  </Shell>;
}
