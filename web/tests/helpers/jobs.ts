import { PyDict, py } from "@/platform/py/value";

/** backend/tests/fixtures/domain.py:job — integers as bigint, like the Python ints they stand for. */
export function job(changes: Record<string, unknown> = {}): PyDict {
  const base = py({
    source: "freelancer", external_id: "101", title: "AI agent workflow",
    description: "Build an agent with tool calling and API integration.",
    url: "https://www.freelancer.com/projects/example-101", kind: "fixed",
    currency: "TWD", budget_min: 4000n, budget_max: 8000n,
    weekly_hours: 10n, taiwan_eligible: true, timezone_compatible: true,
    deadline: "2099-01-01", language: "en", complete: true,
  }) as PyDict;
  if ("external_id" in changes && !("url" in changes)) base.set("url", "https://www.freelancer.com/projects/example-" + String(changes.external_id));
  for (const [k, v] of Object.entries(changes)) base.set(k, py(v));
  return base;
}
