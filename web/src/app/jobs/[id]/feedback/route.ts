import { PyDateTime } from "@/platform/py/datetime";
import { handleFeedback } from "../../../_lib/writes";
import { withPageDb } from "../../../_lib/usage";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withPageDb("POST /jobs/[id]/feedback", (db) => handleFeedback(request, id, { db, now: () => PyDateTime.now() }));
}
