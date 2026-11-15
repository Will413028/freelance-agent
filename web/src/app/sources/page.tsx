import { getPgDb } from "@/db/pg/client";
import { sourcesPage } from "@/services/pages";
import { Shell, SourcesTable } from "../_lib/views";
import { withPageLog } from "../_lib/page-log";

export const dynamic = "force-dynamic";

/** Source health and the latest daily run, from runs and run_sources (plan step 6). */
export default async function Page() {
  return <Shell active="sources"><SourcesTable data={await withPageLog("/sources", () => sourcesPage(getPgDb()))} /></Shell>;
}
