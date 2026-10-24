import { describe, expect, it } from "vitest";
import { PyDateTime } from "@/platform/py/datetime";
import { encode, floatRepr } from "@/platform/py/json";
import { pyFullmatch, pyRe } from "@/platform/py/re";
import { codePoints, pyFloat } from "@/platform/py/unicode";
import { PyDict, PyError, type PyValue } from "@/platform/py/value";
import { xmlFromBytes, type XmlElement } from "@/platform/py/xml";
import { attempt, attemptAsync, fixture, untag, type Expect, type Tagged } from "../../../../tests/helpers/golden";
import { fetchCommunity, hnJob, v2exJobs } from "./community-jobs";
import { fetchJobs, normalize as gobNormalize } from "./getonboard";
import { fetchListings, normalize as himaNormalize } from "./himalayas";

// Plan step 8, batch 1: himalayas.py, getonboard.py and community_jobs.py (hackernews, v2ex), plus the
// float(), fromtimestamp, re and ElementTree attribute behaviour they rely on, against the ground
// truth gen_golden.py wrote with the production image's Python (3.13.15).

type Case<I, O> = { input: I; expect: Expect<O> };
type Span = { span: number[]; groups: (string | null)[] } | null;
type Pages = Record<string, [number, string]>;
type FetchCase<O> = { pages: Pages; expect: Expect<O> };
const golden = fixture<{
  py_float: Case<string, string>[];
  fromtimestamp: Case<Tagged, string>[];
  py_re: { pattern: string; ignorecase: boolean; input: string; search: Span; fullmatch: Span }[];
  xml_attrib: Case<string, [string, [string, string][]][]>[];
  himalayas_normalize: { payload: Tagged; expect: Expect<string> }[];
  himalayas_fetch: FetchCase<string[]>[];
  getonboard_normalize: { item: Tagged; expect: Expect<string> }[];
  getonboard_modalities: Tagged;
  getonboard_fetch: FetchCase<{ result: string; jobs: string[] }>[];
  hn_job: { p: Tagged; parent: Tagged; expect: Expect<string | null> }[];
  v2ex_jobs: Case<string, string[]>[];
  hn_fetch: FetchCase<string[]>[];
}>("golden.json");

const NOW = new PyDateTime(2026, 9, 28, 1, 0, 0, 0, 0n);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mismatches = <I, O>(cases: Case<I, O>[], run: (c: Case<I, O>) => O) =>
  cases.filter((c) => !same(attempt(() => run(c)), c.expect)).map((c) => ({ input: c.input, expect: c.expect, got: attempt(() => run(c)) }));

/** A fetch seam over the generator's {url: [status, latin-1 body]} map; unknown URLs fail like the fake opener. */
const fake = (pages: Pages) => async (url: string) => {
  if (!Object.hasOwn(pages, url)) throw new PyError("OSError", "unknown url " + url);
  return { status: pages[url][0], body: new Uint8Array(Buffer.from(pages[url][1], "latin1")) };
};
const noPause = async () => {};
/** Fetch-level cases compare results exactly and failures only as failures: every sync catches them all. */
const failed = (e: Expect<unknown>) => ("error" in e ? { error: true } : e);

function spanOf(m: RegExpExecArray | null, s: string): Span {
  if (!m) return null;
  const cp = (i: number) => codePoints(s.slice(0, i)).length;
  return { span: [cp(m.index), cp(m.index + m[0].length)], groups: m.slice(1).map((g) => g ?? null) };
}

function iter(el: XmlElement): XmlElement[] {
  return [el, ...el.children.flatMap(iter)];
}

describe("Python semantics the batch-1 sources use (CPython 3.13.15)", () => {
  it(`float(str): ${golden.py_float.length} strings`, () => {
    expect(mismatches(golden.py_float, (c) => floatRepr(pyFloat(c.input)))).toEqual([]);
  });
  it(`datetime.fromtimestamp(t, utc): ${golden.fromtimestamp.length} values`, () => {
    expect(mismatches(golden.fromtimestamp, (c) => PyDateTime.fromTimestampValue(untag(c.input)).isoformat())).toEqual([]);
  });
  it(`re.search / re.fullmatch: ${golden.py_re.length} pattern × string pairs`, () => {
    const bad = golden.py_re.filter((c) => {
      const search = spanOf(pyRe(c.pattern, c.ignorecase).exec(c.input), c.input);
      const full = spanOf(pyFullmatch(c.pattern, c.input, c.ignorecase), c.input);
      return !same(search, c.search) || !same(full, c.fullmatch);
    });
    expect(bad.map((c) => [c.pattern.slice(0, 40), c.ignorecase, c.input.slice(0, 40)])).toEqual([]);
  });
  it(`ElementTree attrib: ${golden.xml_attrib.length} documents`, () => {
    expect(mismatches(golden.xml_attrib, (c) => iter(xmlFromBytes(Buffer.from(c.input))).map((e) => [e.tag, [...e.attrib]] as [string, [string, string][]]))).toEqual([]);
  });
});

describe("himalayas matches Python", () => {
  it(`normalize: ${golden.himalayas_normalize.length} payloads`, () => {
    const bad = golden.himalayas_normalize.filter((c) => !same(attempt(() => encode(himaNormalize(untag(c.payload)))), c.expect));
    expect(bad.map((c) => [JSON.stringify(c.payload).slice(0, 200), c.expect])).toEqual([]);
  });
  it(`fetch then normalize: ${golden.himalayas_fetch.length} scenarios`, async () => {
    const bad = [];
    for (const c of golden.himalayas_fetch) {
      const got = await attemptAsync(async () => (await fetchListings(fake(c.pages), noPause)).map((p) => encode(himaNormalize(p))));
      if (!same(failed(got), failed(c.expect))) bad.push({ urls: Object.keys(c.pages).length, expect: c.expect, got });
    }
    expect(bad).toEqual([]);
  });
});

describe("getonboard matches Python", () => {
  const modalities = new Map([...(untag(golden.getonboard_modalities) as PyDict)]);
  it(`normalize: ${golden.getonboard_normalize.length} items`, () => {
    const bad = golden.getonboard_normalize.filter((c) => !same(attempt(() => encode(gobNormalize(untag(c.item), modalities))), c.expect));
    expect(bad.map((c) => [JSON.stringify(c.item).slice(0, 200), c.expect, attempt(() => encode(gobNormalize(untag(c.item), modalities)))])).toEqual([]);
  });
  it(`fetch: ${golden.getonboard_fetch.length} scenarios`, async () => {
    const bad = [];
    for (const c of golden.getonboard_fetch) {
      const got = await attemptAsync(async () => {
        const r = await fetchJobs(fake(c.pages), noPause);
        return { result: encode(new PyDict([...r].filter(([k]) => k !== "jobs"))), jobs: (r.req("jobs") as PyDict[]).map((j) => encode(j)) };
      });
      if (!same(failed(got), failed(c.expect))) bad.push({ urls: Object.keys(c.pages), expect: c.expect, got });
    }
    expect(bad).toEqual([]);
  });
});

describe("community_jobs matches Python", () => {
  it(`hn_job: ${golden.hn_job.length} comments`, () => {
    const run = (c: (typeof golden.hn_job)[number]) => attempt(() => {
      const j = hnJob(untag(c.p), untag(c.parent));
      return j === null ? null : encode(j);
    });
    expect(golden.hn_job.filter((c) => !same(run(c), c.expect)).map((c) => [JSON.stringify(c.p).slice(0, 160), c.expect, run(c)])).toEqual([]);
  });
  it(`v2ex_jobs: ${golden.v2ex_jobs.length} feeds`, () => {
    expect(mismatches(golden.v2ex_jobs, (c) => v2exJobs(Buffer.from(c.input), NOW).map((j) => encode(j))).map((m) => ({ ...m, input: m.input.slice(0, 300) }))).toEqual([]);
  });
  it(`hackernews fetch: ${golden.hn_fetch.length} scenarios`, async () => {
    const bad = [];
    for (const c of golden.hn_fetch) {
      const got = await attemptAsync(async () => (await fetchCommunity("hackernews", fake(c.pages), NOW)).map((j) => encode(j)));
      if (!same(failed(got), failed(c.expect))) bad.push({ urls: Object.keys(c.pages).slice(0, 4), expect: c.expect, got });
    }
    expect(bad).toEqual([]);
  });
});

const hima = (changes: Record<string, PyValue> = {}) => PyDict.of({
  title: "AI agent backend engineer", description: "<p>Build AI agents and APIs</p>", employmentType: "Contractor",
  locationRestrictions: [], timezoneRestrictions: [], pubDate: 1789746632n, expiryDate: 1893456000n,
  applicationLink: "https://himalayas.app/companies/example/jobs/engineer", guid: "https://himalayas.app/companies/example/jobs/engineer", ...changes,
});

describe("test_himalayas.py (no store)", () => {
  it("seconds, milliseconds and ISO dates", () => {
    const a = himaNormalize(hima()), b = himaNormalize(hima({ pubDate: 1789746632000n })), c = himaNormalize(hima({ pubDate: a.at("received_at") }));
    expect(a.at("received_at")).toBe(b.at("received_at"));
    expect(a.at("received_at")).toBe(c.at("received_at"));
    expect(a.at("taiwan_eligible")).toBeNull();
    expect(a.at("weekly_hours")).toBeNull();
    expect(a.at("budget_min")).toBeNull();
  });
  it("country and timezone restrictions", () => {
    expect(himaNormalize(hima({ locationRestrictions: [PyDict.of({ alpha2: "US", name: "United States" })] })).at("taiwan_eligible")).toBe(false);
    expect(himaNormalize(hima({ timezoneRestrictions: [-5n, 0n] })).at("timezone_compatible")).toBe(false);
    expect(himaNormalize(hima({ locationRestrictions: ["Taiwan"] })).at("taiwan_eligible")).toBeNull();
  });
  it("untrusted URL, missing body or geography rejected", () => {
    const cases: Record<string, PyValue>[] = [{ applicationLink: "https://evil.example/" }, { description: "" }, { locationRestrictions: null }, { pubDate: true }];
    for (const changes of cases) {
      expect(() => himaNormalize(hima(changes))).toThrow(expect.objectContaining({ pyType: "ValueError" }));
    }
  });
});

const comment = (text: string) => PyDict.of({ id: 123n, type: "comment", parent: 10n, time: 1789746632n, text });
const v2exFeed = (title: string, body = "Build an API", link = "https://www.v2ex.com/t/123#reply1") => Buffer.from(
  `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>${title}</title>
        <link rel="alternate" href="${link}"/><published>2026-09-18T12:00:00Z</published>
        <content>${body}</content></entry></feed>`);

describe("test_community_jobs.py (no store)", () => {
  it("HN: only explicit flexible hiring", () => {
    const j = hnJob(comment("Acme | Remote | part-time backend engineer | Build AI agents"), 10n)!;
    expect(j.at("kind")).toBe("contract");
    expect(j.at("weekly_hours")).toBeNull();
    expect(j.at("taiwan_eligible")).toBeNull();
    for (const text of ["Acme | full-time backend", "SEEKING WORK | part-time backend", "Acme | backend | no contractors", "Acme | full-time only | part-time not available"]) {
      expect(hnJob(comment(text), 10n)).toBeNull();
    }
  });
  it("HN: wrong parent or dead not imported", () => {
    const p = comment("Acme | contract backend API");
    expect(hnJob(p, 11n)).toBeNull();
    expect(hnJob(new PyDict(p).update({ dead: true }), 10n)).toBeNull();
  });
  it("v2ex: demand, not a freelancer ad", () => {
    const jobs = v2exJobs(v2exFeed("寻找后端 API 开发，有项目需求"), NOW);
    expect(jobs.length).toBe(1);
    expect(jobs[0].at("url")).toBe("https://www.v2ex.com/t/123");
    expect(v2exJobs(v2exFeed("承接后端 API 开发，有需求联系"), NOW)).toEqual([]);
  });
  it("v2ex: an empty body is an incomplete lead, not a full description", () => {
    const j = v2exJobs(v2exFeed("招聘兼职 API 开发", ""), NOW)[0];
    expect(j.at("complete")).toBe(false);
    expect(j.at("body_available")).toBe(false);
  });
  it("v2ex: XML entities and a wrong host rejected", () => {
    for (const raw of [Buffer.from('<!DOCTYPE x [<!ENTITY e "bad">]><feed/>'), v2exFeed("找 API 开发", "Build an API", "https://evil.example/t/123")]) {
      expect(() => v2exJobs(raw, NOW)).toThrow(expect.objectContaining({ pyType: "ValueError" }));
    }
  });
  it("HN: self profiles and country limits", () => {
    expect(hnJob(comment("Location: London Remote: Yes Willing to relocate: No | contract backend"), 10n)).toBeNull();
    for (const text of ["Acme | contract backend | USA only", "Acme | part-time API | REMOTE (EU)", "Acme | contract API | Poland or Romanian residents only"]) {
      expect(hnJob(comment(text), 10n)!.at("taiwan_eligible")).toBe(false);
    }
  });
});

describe("test_community_jobs.py: simplified Chinese skills match the same categories", () => {
  it("qualify", async () => {
    const { DEFAULT_HOURS, qualify } = await import("@/modules/discovery/public");
    for (const [title, category] of [["智能代理开发", "AI agent"], ["自动化系统", "AI 整合／自動化"], ["后端开发", "後端／API"], ["全栈网站", "全端 MVP"]]) {
      expect(qualify(PyDict.of({ title }), DEFAULT_HOURS, PyDateTime.now(), 3000n).at("category")).toBe(category);
    }
  });
});
