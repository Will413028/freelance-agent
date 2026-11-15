import { describe, expect, it } from "vitest";
import { parseIsoTime } from "./legacy-time";
import fixtures from "./legacy-time.fixtures.json";

// Plans steps 3b, 3b2: the legacy ISO parser against Python's fromisoformat cases (legacy-time.fixtures.json).

const shown = (text: string) => {
  const p = parseIsoTime(text);
  return p === null ? null
    : p.kind === "date" ? p
    : p.kind === "aware" ? { kind: "aware", instant: p.instant.toISOString() }
    : { kind: "naive", utcIfAssumed: p.utcIfAssumed.toISOString() };
};

describe("parseIsoTime against fromisoformat", () => {
  it(`${fixtures.cases.length} cases`, () => {
    const wrong = fixtures.cases.filter((c) => JSON.stringify(shown(c.input)) !== JSON.stringify(c.expect));
    expect(wrong.map((c) => ({ input: c.input, got: shown(c.input), expect: c.expect }))).toEqual([]);
  });
});
