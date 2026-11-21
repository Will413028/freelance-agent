import { notFound } from "next/navigation";
import { getPgDb } from "@/db/pg/client";
import { NotFound } from "@/platform/errors";
import { listingDetail, type DetailView } from "@/services/pages";
import { withPageLog } from "../../_lib/page-log";
import { ContestDetail, JobDetail, NoticeLine, Shell } from "../../_lib/views";

/** One branch per type: a type added to the loader does not compile until it has its own. */
function view(detail: DetailView) {
  switch (detail.type) {
    case "job": return { active: "jobs" as const, body: <JobDetail job={detail.job} /> };
    case "contest": return { active: "contests" as const, body: <ContestDetail contest={detail.contest} /> };
  }
}

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
  const shown = view(detail);
  return <Shell active={shown.active}>
    <NoticeLine notice={typeof search.notice === "string" ? search.notice : undefined} />
    {shown.body}
  </Shell>;
}
