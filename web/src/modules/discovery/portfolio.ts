import { PyError } from "@/platform/py/value";

// Portfolio ids each specialty category points to (evaluation.portfolio_ids). The owner's real ids
// are personal data kept outside the repository; production supplies them as
// PORTFOLIO_CATEGORY_PROJECTS, a JSON object {category: [project id, ...]} (the category_projects
// object of the private portfolio.json). Without it the synthetic ids below apply, which are the
// public Python code's values.
const SYNTHETIC: Record<string, string[]> = {
  "AI agent": ["agent-project", "team-product"],
  "AI 整合／自動化": ["agent-project", "team-product"],
  "全端 MVP": ["booking-demo", "side-project"],
  "後端／API": ["team-product"],
};

let cached: { raw: string | undefined; ids: Record<string, string[]> } | undefined;

/** Fails loudly on a malformed value instead of silently storing synthetic ids. */
export function portfolioIds(category: string): string[] {
  const raw = process.env.PORTFOLIO_CATEGORY_PROJECTS;
  if (!cached || cached.raw !== raw) cached = { raw, ids: raw ? parse(raw) : SYNTHETIC };
  return [...(cached.ids[category] ?? [])];
}

function parse(raw: string): Record<string, string[]> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PyError("ValueError", "PORTFOLIO_CATEGORY_PROJECTS is not valid JSON");
  }
  const ok = typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([k, ids]) => Object.hasOwn(SYNTHETIC, k) && Array.isArray(ids) && ids.every((id) => typeof id === "string"));
  if (!ok) throw new PyError("ValueError", "PORTFOLIO_CATEGORY_PROJECTS must map known categories to lists of ids");
  return value as Record<string, string[]>;
}
