import { getPgDb } from "@/db/pg/client";
import { listJobs, listQuery, runStale } from "@/services/pages";
import { withPageLog } from "./_lib/page-log";
import { JobList, NoticeLine, Shell, StaleLine } from "./_lib/views";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

/** The listing page (plan step 3c): one ranked page of a view, candidates first. */
export default async function Page({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const { view, page } = listQuery(params);
  const db = getPgDb(), now = new Date();
  // The stale check stays out of listJobs: the daily run times listJobs as the list query's budget.
  const [data, stale] = await withPageLog(`/?view=${view}&page=${page}`, () => Promise.all([listJobs(db, now, view, page), runStale(db, now)]));
  return <Shell active="jobs">
    <StaleLine stale={stale} />
    <NoticeLine notice={typeof params.notice === "string" ? params.notice : undefined} />
    <JobList data={data} />
  </Shell>;
}
