import { PyDateTime } from "@/platform/py/datetime";
import { listJobs, listQuery } from "@/services/pages";
import { JobList, NoticeLine, Shell } from "./_lib/views";
import { withPageDb } from "./_lib/usage";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

/** The discovery list (plan step 11): one ranked page of a view, candidates first. */
export default async function Page({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const { view, page } = listQuery(params);
  const data = await withPageDb(`/?view=${view}&page=${page}`, (db) => listJobs(db, PyDateTime.now(), view, page));
  return <Shell active="jobs">
    <NoticeLine notice={typeof params.notice === "string" ? params.notice : undefined} />
    <JobList data={data} />
  </Shell>;
}
