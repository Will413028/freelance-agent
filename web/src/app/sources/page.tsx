import { getPgDb } from "@/db/pg/client";
import { sourcesPage } from "@/services/pages";
import { NoticeLine, Shell, SourcesTable } from "../_lib/views";
import { withPageLog } from "../_lib/page-log";

export const dynamic = "force-dynamic";

/** Source health and the latest daily run, from runs and run_sources (plan step 6). */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const data = await withPageLog("/sources", () => sourcesPage(getPgDb(), new Date()));
  return <Shell active="sources">
    <NoticeLine notice={typeof search.notice === "string" ? search.notice : undefined} />
    <SourcesTable data={data} />
  </Shell>;
}
