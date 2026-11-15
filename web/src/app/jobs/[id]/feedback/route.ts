import { getPgDb } from "@/db/pg/client";
import { withPageLog } from "../../../_lib/usage";
import { handleFeedback } from "../../../_lib/writes";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withPageLog("POST /jobs/[id]/feedback", () => handleFeedback(request, id, { db: getPgDb, now: () => new Date() }));
}
