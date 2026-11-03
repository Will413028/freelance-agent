import { getDb } from "@/db/client";
import { PyDateTime } from "@/platform/py/datetime";
import { writesOn } from "../../../_lib/guard";
import { handleFeedback } from "../../../_lib/writes";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleFeedback(request, id, { db: getDb(), now: () => PyDateTime.now(), writes: writesOn() });
}
