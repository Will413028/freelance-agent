import { getDb } from "@/db/client";
import { PyDateTime } from "@/platform/py/datetime";
import { writesOn } from "../../_lib/guard";
import { handleSettings } from "../../_lib/writes";

export async function POST(request: Request) {
  return handleSettings(request, { db: getDb(), now: () => PyDateTime.now(), writes: writesOn() });
}
