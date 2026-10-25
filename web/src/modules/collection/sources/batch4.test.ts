import { describe, expect, it } from "vitest";
import { PyDateTime } from "@/platform/py/datetime";
import { encode } from "@/platform/py/json";
import { translate } from "@/platform/py/re";
import { codePoints, pyRstrip } from "@/platform/py/unicode";
import { asDict, PyError, type PyValue } from "@/platform/py/value";
import { attempt, attemptAsync, fixture, untag, type Expect, type Tagged } from "../../../../tests/helpers/golden";
import * as arbeitnow from "./arbeitnow";
import * as freelancer from "./freelancer";
import * as taiwanjobs from "./taiwanjobs";

// Plan step 8, the last batch: taiwanjobs.py, arbeitnow.py and freelancer.py, plus the str.rstrip
// and re behaviour they rely on, against the ground truth gen_golden.py wrote with
// the production image's Python (3.13.15). Following batch 1's rule, error classes are compared where a
// caller branches on them (each per-row catch, which shows in the output as rejected rows); envelope
// failures, which every sync turns into one failed source, are compared as failures.

type Case<I, O> = { input: I; expect: Expect<O> };
type Pages = Record<string, [number, string]>;
type Span = { span: number[]; groups: (string | null)[] } | null;
const golden = fixture<{
  py_rstrip: { input: string; expect: string }[];
  b4_re: { pattern: string; ignorecase: boolean; dotall: boolean; mode: "search"; input: string; expect: Span }[];
  taiwanjobs_date: Case<string, string>[];
  taiwanjobs_batch: Case<string, string>[];
  taiwanjobs_strict: Case<string, string>[];
  arbeitnow_normalize: { entry: Tagged; expect: Expect<string> }[];
  arbeitnow_batch: { input: string; page: number; expect: Expect<{ jobs: string[]; rejected: number; next: string | null }> }[];
  arbeitnow_scan: { pages: Pages; kw: { max_pages?: number; max_seconds?: number }; ticks: number[] | null; expect: Expect<string>; calls: [string, number][] }[];
  freelancer_normalize: { project: Tagged; expect: Expect<string> }[];
  freelancer_search: { query: string; pages: Pages; kw: Tagged; ticks: number[] | null; expect: Expect<string>; calls: [string, number][] }[];
}>("golden.json");

const NOW = new PyDateTime(2026, 9, 28, 1, 0, 0, 0, 0n);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const bytes = (latin1: string) => new Uint8Array(Buffer.from(latin1, "latin1"));
const failed = <T,>(e: Expect<T>) => ("error" in e ? { error: true } : e);
function mismatches<C extends { expect: Expect<unknown> }>(cases: C[], run: (c: C) => unknown, strict = false) {
  return cases.map((c) => ({ c, got: attempt(() => run(c)) })).filter(({ c, got }) => !same(strict ? got : failed(got), strict ? c.expect : failed(c.expect)));
}
/** A monotonic clock over the ticks Python's iterator gave, or a clock stuck at 0. */
const clock = (ticks: number[] | null) => {
  let i = 0;
  return () => {
    if (!ticks) return 0;
    if (i >= ticks.length) throw new PyError("StopIteration", "");
    return ticks[i++];
  };
};
/** A GET over {url: [status, body]} that records [url, timeout in seconds]; an unknown URL fails like a network error. */
function site(pages: Pages) {
  const calls: [string, number][] = [];
  const request = async (url: string, timeoutMs: number) => {
    calls.push([url, timeoutMs / 1000]);
    if (!Object.hasOwn(pages, url)) throw new PyError("OSError", "unknown url " + url);
    return { status: pages[url][0], body: bytes(pages[url][1]) };
  };
  return { calls, request };
}

describe("Python semantics the last-batch sources use (CPython 3.13.15)", () => {
  it(`str.rstrip: ${golden.py_rstrip.length} strings`, () => {
    expect(golden.py_rstrip.filter((c) => pyRstrip(c.input) !== c.expect)).toEqual([]);
  });
  it(`re.search: ${golden.b4_re.length} pattern × input pairs on the production objects`, () => {
    const production = [...Object.values(freelancer.regexes()), ...Object.values(taiwanjobs.regexes())];
    const run = (c: (typeof golden.b4_re)[number]) => {
      const re = production.find((r) => r.source === translate(c.pattern, c.ignorecase, c.dotall));
      expect(re, c.pattern).toBeDefined();
      const m = re!.exec(c.input);
      const cp = (i: number) => codePoints(c.input.slice(0, i)).length;
      return m && { span: [cp(m.index), cp(m.index + m[0].length)], groups: m.slice(1).map((g) => g ?? null) };
    };
    expect(golden.b4_re.filter((c) => !same(run(c), c.expect)).map((c) => ({ ...c, got: run(c) }))).toEqual([]);
  });
});

describe("taiwanjobs matches Python", () => {
  it(`date (strptime '%Y%m%d'): ${golden.taiwanjobs_date.length} values`, () => {
    expect(mismatches(golden.taiwanjobs_date, (c) => taiwanjobs.date(c.input).isoformat())).toEqual([]);
  });
  it(`parse_batch: ${golden.taiwanjobs_batch.length} responses (per-row rejections and whole failures)`, () => {
    expect(mismatches(golden.taiwanjobs_batch, (c) => encode(taiwanjobs.parseBatch(bytes(c.input), NOW))).map(({ c, got }) => ({ input: c.input.slice(0, 300), expect: c.expect, got }))).toEqual([]);
  });
  it(`parse (strict): ${golden.taiwanjobs_strict.length} responses`, () => {
    expect(mismatches(golden.taiwanjobs_strict, (c) => encode(taiwanjobs.parse(bytes(c.input), NOW))).map(({ c, got }) => ({ input: c.input.slice(0, 300), expect: c.expect, got }))).toEqual([]);
  });
});

describe("arbeitnow matches Python", () => {
  it(`normalize: ${golden.arbeitnow_normalize.length} listings, error class as parse_batch's catch sees it`, () => {
    expect(mismatches(golden.arbeitnow_normalize, (c) => encode(arbeitnow.normalize(untag(c.entry))), true)).toEqual([]);
  });
  it(`parse_batch: ${golden.arbeitnow_batch.length} pages`, () => {
    expect(mismatches(golden.arbeitnow_batch, (c) => {
      const r = arbeitnow.parseBatch(bytes(c.input), c.page);
      return { jobs: r.jobs.map((j) => encode(j)), rejected: Number(r.rejected), next: r.next };
    }).map(({ c, got }) => ({ input: c.input.slice(0, 300), page: c.page, expect: c.expect, got }))).toEqual([]);
  });
  it(`scan: ${golden.arbeitnow_scan.length} response sets, with the requests and their timeouts`, async () => {
    const bad = [];
    for (const c of golden.arbeitnow_scan) {
      const { calls, request } = site(c.pages);
      const got = await attemptAsync(async () => encode(await arbeitnow.scan({
        reader: arbeitnow.readerOver(request), monotonic: clock(c.ticks), pause: async () => {}, maxPages: c.kw.max_pages, maxSeconds: c.kw.max_seconds,
      }) as unknown as PyValue));
      if (!same(failed(got), failed(c.expect)) || !same(calls, c.calls)) bad.push({ c, got, calls });
    }
    expect(bad).toEqual([]);
  });
});

describe("freelancer matches Python", () => {
  it(`normalize: ${golden.freelancer_normalize.length} projects, error class as search's catch sees it`, () => {
    expect(mismatches(golden.freelancer_normalize, (c) => encode(freelancer.normalize(untag(c.project))), true)).toEqual([]);
  });
  it(`search: ${golden.freelancer_search.length} response sets, with the requests and their timeouts`, async () => {
    const bad = [];
    for (const c of golden.freelancer_search) {
      const { calls, request } = site(c.pages);
      const kw = asDict(untag(c.kw));
      const num = (k: string) => (kw.has(k) ? Number(kw.at(k)) : undefined);
      const got = await attemptAsync(async () => encode(await freelancer.search(c.query, {
        limit: num("limit"), maxPages: num("max_pages"), maxSeconds: num("max_seconds"), request, pause: async () => {}, monotonic: clock(c.ticks),
      })));
      if (!same(got, c.expect) || !same(calls, c.calls)) bad.push({ query: c.query, kw: c.kw, expect: c.expect, got, calls, pyCalls: c.calls });
    }
    expect(bad).toEqual([]);
  });
});
