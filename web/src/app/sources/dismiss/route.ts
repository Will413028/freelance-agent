import { getPgDb } from "@/db/pg/client";
import { withPageLog } from "../../_lib/page-log";
import { handleMailDisposition } from "../../_lib/writes";

export async function POST(request: Request) {
  return withPageLog("POST /sources/dismiss", () => handleMailDisposition(request, "dismissed", { db: getPgDb, now: () => new Date() }));
}
