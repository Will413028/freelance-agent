import { notFound } from "next/navigation";
import { getPgDb } from "@/db/pg/client";
import { NotFound } from "@/platform/errors";
import { listingDetail } from "@/services/pages";
import { withPageLog } from "../../_lib/page-log";
import { ContestDetail, JobDetail, NoticeLine, Shell } from "../../_lib/views";

export const dynamic = "force-dynamic";

/**
 * One listing of any type (plan step 3c; opportunity types plan step 5: the route is keyed by listing id, so
 * a contest is shown here too): its content, evaluation, mail versions and feedback.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  let detail;
  try {
    detail = await withPageLog("/jobs/[id]", () => listingDetail(getPgDb(), new Date(), id));
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }
  return <Shell active={detail.type === "job" ? "jobs" : "contests"}>
    <NoticeLine notice={typeof search.notice === "string" ? search.notice : undefined} />
    {detail.type === "job" ? <JobDetail job={detail.job} /> : <ContestDetail contest={detail.contest} />}
  </Shell>;
}
