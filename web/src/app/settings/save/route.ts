import { PyDateTime } from "@/platform/py/datetime";
import { handleSettings } from "../../_lib/writes";
import { withPageDb } from "../../_lib/usage";

export async function POST(request: Request) {
  return withPageDb("POST /settings/save", (db) => handleSettings(request, { db, now: () => PyDateTime.now() }));
}
