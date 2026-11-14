import { settingsPage } from "@/services/pages";
import { NoticeLine, SettingsForm, Shell } from "../_lib/views";
import { withPageDb } from "../_lib/usage";

export const dynamic = "force-dynamic";

/** The discovery settings (plan step 11): saving rewrites every listing's evaluation. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  return <Shell active="settings">
    <NoticeLine notice={typeof search.notice === "string" ? search.notice : undefined} />
    <SettingsForm data={await withPageDb("/settings", settingsPage)} />
  </Shell>;
}
