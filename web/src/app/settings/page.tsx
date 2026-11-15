import { getPgDb } from "@/db/pg/client";
import { settingsPage } from "@/services/pages";
import { withPageLog } from "../_lib/usage";
import { NoticeLine, SettingsForm, Shell } from "../_lib/views";

export const dynamic = "force-dynamic";

/** The settings (plan step 3c): ranking reads them at query time, so saving rewrites nothing else. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  return <Shell active="settings">
    <NoticeLine notice={typeof search.notice === "string" ? search.notice : undefined} />
    <SettingsForm data={await withPageLog("/settings", () => settingsPage(getPgDb()))} />
  </Shell>;
}
