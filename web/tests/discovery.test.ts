import { describe, expect, it } from "vitest";
import { qualify } from "@/modules/discovery/domain";
import { recommendation } from "@/modules/discovery/ranking";
import { evaluate, groupItems, identityKeys, novelty } from "@/modules/discovery/rules";
import { PyDateTime } from "@/platform/py/datetime";
import { encode } from "@/platform/py/json";
import { asDict, asList, PyDict, py, type PyValue } from "@/platform/py/value";
import { job } from "./helpers/jobs";
import { attempt, fixture, hashPoints as loadHashPoints, untag, type Tagged } from "./helpers/golden";

const golden = fixture("golden.json");
const hashPoints = loadHashPoints();
const point = (name: string) => hashPoints.points.find((p) => p.name === name)!.cases;
const NOW = new PyDateTime(2026, 9, 28, 1, 0, 0, 0, 0n);

/** Compare each case the way the Python generator recorded it: encode() text or the exception type. */
function mismatches(cases: { expect: { ok?: unknown; error?: string } }[], run: (c: any) => unknown) {
  return cases.flatMap((c, n) => {
    const got = attempt(() => run(c));
    const same = "error" in c.expect ? "error" in got && got.error === c.expect.error : "ok" in got && got.ok === c.expect.ok;
    return same ? [] : [{ n, case: JSON.stringify(c).slice(0, 400), want: c.expect, got }];
  });
}

describe("evaluate matches the Python rules byte for byte", () => {
  it(`${golden.evaluate.length} job × settings cases`, () => {
    expect(mismatches(golden.evaluate, (c) => encode(evaluate(asDict(untag(c.job)), asDict(untag(c.settings)), NOW)))).toEqual([]);
  });
});

describe("recommendation matches the Python ranking byte for byte", () => {
  it(`${golden.recommendation.length} item cases`, () => {
    expect(mismatches(golden.recommendation, (c) => encode(recommendation(asDict(untag(c.input)), NOW)))).toEqual([]);
  });
});

describe("spike 1c hash points owned by discovery", () => {
  const same = (cases: any[], run: (c: any) => unknown) =>
    cases.flatMap((c, n) => {
      const got = attempt(() => run(c));
      return JSON.stringify("error" in c.expect ? { error: "error" in got } : got) === JSON.stringify("error" in c.expect ? { error: true } : c.expect)
        ? [] : [{ n, want: c.expect, got }];
    });

  it("HP5 identity_keys", () => {
    expect(same(point("HP5.identity_keys"), (c) => ({ keys: identityKeys(asDict(untag(c.input as Tagged))) }))).toEqual([]);
  });

  it("HP6 novelty", () => {
    expect(same(point("HP6.novelty"), (c) => {
      const item = PyDict.of({ id: "opp-1", fingerprint: "f".repeat(64), job: untag(c.input) });
      return { novelty: [...novelty(item).values()].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)).map((t) => t) };
    }).filter((m) => !sameSorted(m))).toEqual([]);
  });

  it("HP7 group member tokens", () => {
    expect(same(point("HP7.group_token"), (c) => {
      const items = (c.input as { fp: string; rev: number | null; conflicts: string[]; app: string[] | null }[]).map((s, n) => {
        const item = PyDict.of({
          id: `id-${n}`, fingerprint: s.fp, job: py({ source: "s", title: `t${n}` }), evaluation: PyDict.of({ status: "qualified", score: 0n }),
          review_status: "draft", recommendation: PyDict.of({ basis_fingerprint: s.fp, score: 0n }),
          content_conflicts: s.conflicts.length ? [PyDict.of({ versions: s.conflicts.map((fp) => PyDict.of({ fingerprint: fp, evaluation: PyDict.of({ status: "qualified" }) })) })] : [],
        });
        if (s.rev !== null) item.set("tracking", PyDict.of({ revision: BigInt(s.rev) }));
        if (s.app !== null) item.set("application_token", s.app);
        return item;
      });
      const tokens: Record<string, PyValue> = {};
      for (const g of groupItems(items)) for (const m of asList(g.req("members")).map(asDict)) tokens[m.str("id")] = m.req("token");
      return { tokens };
    })).toEqual([]);
  });
});

// HP6 compares sorted pair lists; the helper above sorts by JSON text, so re-check with Python order.
function sameSorted(m: { want: any; got: any }) {
  const sort = (pairs: string[][]) => [...pairs].sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  const cmp = (a: string, b: string) => { const x = [...a].map((c) => c.codePointAt(0)!), y = [...b].map((c) => c.codePointAt(0)!);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
  return "ok" in m.got && JSON.stringify(sort(m.got.ok.novelty)) === JSON.stringify(m.want.ok.novelty);
}

// Readable ports of backend/tests/discovery/test_domain.py (QualificationTests).
describe("qualification rules", () => {
  const now = new PyDateTime(2026, 9, 17, 0, 0, 0, 0, 0n);
  const status = (changes: Record<string, unknown> = {}, at = now) => qualify(job(changes), 30n, at, 3000n);

  it("excludes a budget below the floor", () => expect(status({ budget_min: 2000n, budget_max: 2999n }).req("status")).toBe("excluded"));
  it("never passes an unknown country", () => {
    const result = status({ taiwan_eligible: null });
    expect(result.req("status")).toBe("needs_info");
    expect(asList(result.req("questions")).join(" ")).toContain("台灣接案資格");
  });
  it("excludes over-capacity and full-time work", () => {
    expect(status({ weekly_hours: 40n }).req("status")).toBe("excluded");
    expect(status({ kind: "full_time" }).req("status")).toBe("excluded");
  });
  it("does not apply the total budget floor to hourly work", () => {
    const result = status({ kind: "hourly", currency: "USD", budget_min: 30n, budget_max: 50n });
    expect(result.req("status")).toBe("needs_info");
    expect(asList(result.req("reasons")).join(" ")).not.toContain("低於單案底價");
  });
  it("keeps a foreign budget without a rate unknown", () => expect(status({ currency: "USD", budget_max: 1000n }).req("status")).toBe("needs_info"));
  it("does not pass expired or incomplete listings", () => {
    expect(status({ deadline: "2026-09-16" }).req("status")).toBe("excluded");
    expect(status({ complete: false }).req("status")).toBe("needs_info");
  });
  it("prefers agent work and keeps portfolio ids truthful", () => {
    const agent = status(), backend = status({ title: "Backend API", description: "REST API integration" });
    expect((agent.req("score") as bigint) > (backend.req("score") as bigint)).toBe(true);
    expect(asList(agent.req("portfolio_ids"))).toContain("agent-project");
  });
  it("does not recommend unrelated roles", () => expect(status({ title: "Graphic designer", description: "Draw a logo" }).req("status")).toBe("excluded"));
  it("does not read 'storage' as RAG", () => expect(status({ title: "Storage unit manager", description: "Manage warehouse inventory" }).req("status")).toBe("excluded"));
  it("expires intraday by timestamp", () => {
    expect(status({ deadline: "2026-09-17T08:00:00Z" }, new PyDateTime(2026, 9, 17, 10, 0, 0, 0, 0n)).req("status")).toBe("excluded");
  });
  it("keeps a naive datetime with a space unknown", () => expect(status({ deadline: "2026-09-17 08:00:00" }).req("status")).toBe("needs_info"));
  it("does not qualify an inverted budget", () => expect(status({ budget_min: 9000n, budget_max: 3000n }).req("status")).toBe("needs_info"));
});

// Python iterates identity_keys as a set whose order follows PYTHONHASHSEED; for this shape the
// Python partition changes between processes (measured: 5 of 10 seeds each way). The port sorts
// the keys, so the content key ("content:…" < "url:…") always decides first.
describe("grouping order when one listing bridges two incompatible groups", () => {
  const body = "Build an agent integration with API, database, tests and deployment. ".repeat(3);
  const item = (i: number, changes: Record<string, unknown>) => PyDict.of({
    id: `id-${i}`, fingerprint: String(i),
    job: job({ source: "s", external_id: String(i), title: "Agent", company: "Example", description: body, ...changes }),
    evaluation: PyDict.of({ status: "qualified", score: 1n }), review_status: "draft",
    recommendation: PyDict.of({ score: 1n, basis_fingerprint: String(i) }),
  });
  it("is deterministic and lets the content key win", () => {
    const a = item(0, { url: "https://x.example/a", description: "short", taiwan_eligible: true });
    const b = item(1, { url: "https://y.example/b", taiwan_eligible: false });
    const c = item(2, { url: "https://x.example/a", taiwan_eligible: null });
    const partition = groupItems([a, b, c]).map((g) => asList(g.req("member_ids")).join(",")).sort();
    expect(partition).toEqual(["id-0", "id-1,id-2"]);
  });
});
