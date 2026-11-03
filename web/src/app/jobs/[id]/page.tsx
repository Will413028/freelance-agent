import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { NotFound } from "@/platform/errors";
import { PyDateTime } from "@/platform/py/datetime";
import { jobDetail } from "@/services/pages";
import { JobDetail, NoticeLine, ReadOnlyHint, Shell } from "../../_lib/views";
import { writesOn } from "../../_lib/guard";

export const dynamic = "force-dynamic";

/** One listing (plan step 11): its content, evaluation, content versions and feedback. */
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  let job;
  try {
    job = await jobDetail(getDb(), PyDateTime.now(), id);
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }
  return <Shell active="jobs">
    <NoticeLine notice={typeof search.notice === "string" ? search.notice : undefined} />
    <ReadOnlyHint writes={writesOn()} />
    <JobDetail job={job} writes={writesOn()} />
  </Shell>;
}
