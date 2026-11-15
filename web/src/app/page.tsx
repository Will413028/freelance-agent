import { getPgDb } from "@/db/pg/client";
import { listJobs, listQuery } from "@/services/pages";
import { withPageLog } from "./_lib/page-log";
import { JobList, NoticeLine, Shell } from "./_lib/views";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

/** The listing page (plan step 3c): one ranked page of a view, candidates first. */
export default async function Page({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const { view, page } = listQuery(params);
  const data = await withPageLog(`/?view=${view}&page=${page}`, () => listJobs(getPgDb(), new Date(), view, page));
  return <Shell active="jobs">
    <NoticeLine notice={typeof params.notice === "string" ? params.notice : undefined} />
    <JobList data={data} />
  </Shell>;
}
