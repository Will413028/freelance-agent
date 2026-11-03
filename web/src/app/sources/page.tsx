import { sourcesPage } from "@/services/pages";
import { Shell, SourcesTable } from "../_lib/views";
import { withPageDb } from "../_lib/usage";

export const dynamic = "force-dynamic";

/** Source health and the latest daily run (moved from `/` in plan step 11). */
export default async function Page() {
  return <Shell active="sources"><SourcesTable data={await withPageDb("/sources", sourcesPage)} /></Shell>;
}
