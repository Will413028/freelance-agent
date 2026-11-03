import { getDb } from "@/db/client";
import { settingsPage } from "@/services/pages";
import { NoticeLine, ReadOnlyHint, SettingsForm, Shell } from "../_lib/views";
import { writesOn } from "../_lib/guard";

export const dynamic = "force-dynamic";

/** The discovery settings (plan step 11): saving rewrites every listing's evaluation. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  return <Shell active="settings">
    <NoticeLine notice={typeof search.notice === "string" ? search.notice : undefined} />
    <ReadOnlyHint writes={writesOn()} />
    <SettingsForm data={await settingsPage(getDb())} writes={writesOn()} />
  </Shell>;
}
