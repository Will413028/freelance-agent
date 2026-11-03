import { PyDateTime } from "@/platform/py/datetime";
import { listJobs, listQuery } from "@/services/pages";
import { JobList, NoticeLine, ReadOnlyHint, Shell } from "./_lib/views";
import { writesOn } from "./_lib/guard";
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
    <ReadOnlyHint writes={writesOn()} />
    <JobList data={data} />
  </Shell>;
}
