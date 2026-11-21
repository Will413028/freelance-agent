import { getPgDb } from "@/db/pg/client";
import { listContests, listJobs, listQuery, runStale } from "@/services/pages";
import { withPageLog } from "./_lib/page-log";
import { ContestList, JobList, NoticeLine, Shell, StaleLine } from "./_lib/views";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

/** The listing page (plan step 3c): one ranked page of a view of one opportunity type (`?type=`, jobs when left out), candidates first. */
export default async function Page({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const { type, view, page } = listQuery(params);
  const db = getPgDb(), now = new Date();
  // The stale check stays out of listJobs: the daily run times listJobs as the list query's budget.
  const [data, stale] = await withPageLog(`/?type=${type}&view=${view}&page=${page}`, () => Promise.all([
    type === "job" ? listJobs(db, now, view, page).then((jobs) => ({ type, jobs })) : listContests(db, now, view, page).then((contests) => ({ type, contests })),
    runStale(db, now),
  ]));
  return <Shell active={type === "job" ? "jobs" : "contests"}>
    <StaleLine stale={stale} />
    <NoticeLine notice={typeof params.notice === "string" ? params.notice : undefined} />
    {data.type === "job" ? <JobList data={data.jobs} /> : <ContestList data={data.contests} />}
  </Shell>;
}
