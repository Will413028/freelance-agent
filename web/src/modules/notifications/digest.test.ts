import { describe, expect, it } from "vitest";
import { asDict, asList, PyDict, type PyValue } from "@/platform/py/value";
import { attempt, fixture, untag, type Expect, type Tagged } from "../../../tests/helpers/golden";
import { render, type RenderMode } from "./digest";

// Plan step 10b: render() against notifications/digest.py on the cases gen_golden.py built.
type Case = { input: Record<"items" | "sources" | "mode" | "email" | "counts", Tagged>; expect: Expect<string> };
const cases = fixture<{ digest_render: Case[] }>("golden.json").digest_render;

describe("digest render matches Python byte for byte", () => {
  it.each(cases.map((c, n) => [n, c] as const))("case %i", (_, c) => {
    const u = (k: keyof Case["input"]) => untag(c.input[k]);
    const counts = u("counts") as PyValue;
    const got = attempt(() => render(asList(u("items")).map(asDict), asDict(u("sources")),
      { mode: u("mode") as RenderMode, email: u("email") === true, counts: counts === null ? null : (counts as PyDict) }));
    expect(got).toEqual(c.expect);
  });
});
