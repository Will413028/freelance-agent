import { notFound } from "next/navigation";
import { getPgDb } from "@/db/pg/client";
import { NotFound } from "@/platform/errors";
import { jobDetail } from "@/services/pages";
import { withPageLog } from "../../_lib/page-log";
import { JobDetail, NoticeLine, Shell } from "../../_lib/views";

export const dynamic = "force-dynamic";

/** One listing (plan step 3c): its content, evaluation, mail versions and feedback. */
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  let job;
  try {
    job = await withPageLog("/jobs/[id]", () => jobDetail(getPgDb(), new Date(), id));
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }
  return <Shell active="jobs">
    <NoticeLine notice={typeof search.notice === "string" ? search.notice : undefined} />
    <JobDetail job={job} />
  </Shell>;
}
