import { describe, expect, it } from "vitest";
import { pyIsInstance } from "@/platform/errors";
import { encode } from "@/platform/py/json";
import { pyFindall, pyRe, pyReSplit, pySub, translate } from "@/platform/py/re";
import { codePoints } from "@/platform/py/unicode";
import { PyDict, PyError } from "@/platform/py/value";
import { xmlFromString, type XmlElement } from "@/platform/py/xml";
import { attempt, fixture, untag, type Expect, type Tagged } from "../../../../tests/helpers/golden";
import { fetchFeed, normalize, parseBatch, regexes, type FeedSource } from "./public-feeds";

// Plan step 8, batch 2: public_feeds.py (remoteok, realworkfromanywhere, weworkremotely,
// workingnomads) and the re / ElementTree(str) behaviour it relies on, against the ground truth
// gen_golden.py wrote with the production image's Python (3.13.15).

type Span = { span: number[]; groups: (string | null)[] } | null;
const golden = fixture<{
  xml_str: { input: string; expect: Expect<[string, string | null][]> }[];
  pf_re: { pattern: string; ignorecase: boolean; dotall: boolean; input: string; search: Span; findall: string[] | null; sub: string; split: (string | null)[] }[];
  public_feeds_normalize: { source: FeedSource; entry: Tagged; expect: Expect<string> }[];
  public_feeds_batch: { source: FeedSource; input: string; expect: Expect<{ jobs: string[]; truncated: boolean; rejected: string }> }[];
}>("golden.json");

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const iter = (el: XmlElement): XmlElement[] => [el, ...el.children.flatMap(iter)];
const cp = (s: string, i: number) => codePoints(s.slice(0, i)).length;

/** parse_batch's catch: ValueError/TypeError reject one listing; any other class fails the source. */
function classify(fn: () => string): Expect<string> {
  try {
    return { ok: fn() };
  } catch (e) {
    if (pyIsInstance(e, "ValueError", "TypeError")) return { error: "rejected" };
    return { error: (e as { pyType?: string }).pyType ?? `JS:${(e as Error).message}` };
  }
}

describe("Python semantics public_feeds uses (CPython 3.13.15)", () => {
  it(`ElementTree.fromstring(str): ${golden.xml_str.length} documents`, () => {
    const bad = golden.xml_str.filter((c) => !same(attempt(() => iter(xmlFromString(c.input)).map((e) => [e.tag, e.text])), c.expect));
    expect(bad).toEqual([]);
  });
  it("the parser refuses a DTD even when a caller forgot the pre-check (TS-only backstop; Python callers reject first)", () => {
    expect(attempt(() => xmlFromString('<!DOCTYPE r><r/>'))).toEqual({ error: "ParseError" });
  });
  it(`re search/findall/sub/split: ${golden.pf_re.length} pattern × input pairs, on the production regexes`, () => {
    // Each golden pattern resolves to the production object compiled from it, so a wrong flag there
    // (re.S dropped, say) gives a different source and fails here instead of passing on a test-built copy.
    const production = Object.values(regexes());
    const resolve = (c: (typeof golden.pf_re)[number]) => production.find((re) => re.source === translate(c.pattern, c.ignorecase, c.dotall));
    const patterns = [...new Set(golden.pf_re.filter((c) => c.pattern !== String.raw`/job/go/\d+/`).map((c) => JSON.stringify([c.pattern, c.ignorecase, c.dotall])))];
    expect(patterns.filter((k) => !golden.pf_re.some((c) => JSON.stringify([c.pattern, c.ignorecase, c.dotall]) === k && resolve(c)))).toEqual([]);
    expect(production.length).toBe(patterns.length);
    const bad = golden.pf_re.filter((c) => {
      const re = resolve(c) ?? pyRe(c.pattern, c.ignorecase, false, c.dotall);
      const m = re.exec(c.input);
      const span: Span = m && { span: [cp(c.input, m.index), cp(c.input, m.index + m[0].length)], groups: m.slice(1).map((g) => g ?? null) };
      return !same(span, c.search) || (c.findall !== null && !same(pyFindall(re, c.input), c.findall))
        || pySub(re, c.input, () => "") !== c.sub || !same(pyReSplit(re, c.input), c.split);
    });
    expect(bad.map((c) => [c.pattern, c.input])).toEqual([]);
  });
});

describe("public_feeds matches Python", () => {
  it(`normalize: ${golden.public_feeds_normalize.length} listings, error classes as parse_batch sees them`, () => {
    const bad = golden.public_feeds_normalize.filter((c) => !same(classify(() => encode(normalize(c.source, untag(c.entry)))), c.expect));
    expect(bad.map((c) => ({ ...c, got: classify(() => encode(normalize(c.source, untag(c.entry)))) }))).toEqual([]);
  });
  it("a lone surrogate (not representable in golden.json) rejects only that listing, as UnicodeEncodeError does in Python", () => {
    const entry = PyDict.of({ id: "123", position: "API \ud800 contract", description: "<p>x</p>", url: "https://remoteok.com/remote-jobs/x", tags: [], date: "2026-09-18T12:00:00+00:00" });
    expect(classify(() => encode(normalize("remoteok", entry)))).toEqual({ error: "rejected" });
  });
  it(`parse_batch: ${golden.public_feeds_batch.length} feeds, failures compared only as failures`, () => {
    const run = (c: (typeof golden.public_feeds_batch)[number]) => {
      const r = attempt(() => {
        const { jobs, truncated, rejected } = parseBatch(c.source, Buffer.from(c.input, "latin1"));
        return { jobs: jobs.map((j) => encode(j)), truncated, rejected: rejected.toString() };
      });
      return "error" in r ? { error: true } : r;
    };
    const expected = (c: (typeof golden.public_feeds_batch)[number]) => ("error" in c.expect ? { error: true } : { ok: { ...c.expect.ok, rejected: String(c.expect.ok.rejected) } });
    const bad = golden.public_feeds_batch.filter((c) => !same(run(c), expected(c)));
    expect(bad.map((c) => ({ source: c.source, input: c.input.slice(0, 200), expect: expected(c), got: run(c) }))).toEqual([]);
  });
});

describe("public_feeds.fetch", () => {
  const body = (n: number) => new Uint8Array(n);
  it("sends the source's Accept header and returns the body", async () => {
    const seen: [string, Record<string, string>][] = [];
    const out = await fetchFeed("weworkremotely", async (url, headers) => (seen.push([url, headers]), { status: 200, body: body(3) }));
    expect(out.length).toBe(3);
    expect(seen).toEqual([["https://weworkremotely.com/remote-jobs.rss", { "User-Agent": "freelance-agent/0.1 personal-job-discovery", Accept: "application/rss+xml, application/xml" }]]);
  });
  it("rejects a non-200 (a redirect included) and a body over 8 MB", async () => {
    for (const r of [{ status: 301, body: body(0) }, { status: 204, body: body(0) }, { status: 200, body: body(8_000_001) }]) {
      await expect(fetchFeed("remoteok", async () => r)).rejects.toBeInstanceOf(PyError);
    }
    await expect(fetchFeed("ptt_soho", async () => ({ status: 200, body: body(1) }))).rejects.toBeInstanceOf(PyError);
  });
});
