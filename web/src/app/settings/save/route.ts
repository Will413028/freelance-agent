import { getPgDb } from "@/db/pg/client";
import { withPageLog } from "../../_lib/usage";
import { handleSettings } from "../../_lib/writes";

export async function POST(request: Request) {
  return withPageLog("POST /settings/save", () => handleSettings(request, { db: getPgDb, now: () => new Date() }));
}
