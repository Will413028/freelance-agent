import { start } from "workflow/api";
import { dailyWorkflow } from "@/workflows/daily";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const run = await start(dailyWorkflow, []);
  return Response.json({ runId: run.runId });
}
