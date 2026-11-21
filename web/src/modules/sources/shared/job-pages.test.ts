import { describe, expect, it } from "vitest";
import { parseJobInput } from "@/modules/listings/public";
import { FetchError } from "@/platform/fetch";
import { SourceError } from "../types";
import { AccessChallenge, boardUrl, employmentTypes, jobPostings, kindOf, pageHtml, PAGE_BYTES, readDetails } from "./job-pages";

const bytes = (s: string) => new TextEncoder().encode(s);
const listing = (id: string) => parseJobInput({ external_id: id, title: "t", description: "d", url: `https://x.example/${id}`, canonical_url: `https://x.example/${id}`, complete: false });

describe("page sources' shared helpers (plan step 5c)", () => {
  it("refuses an empty, oversize or non-UTF-8 page, and fails the source on an access challenge", () => {
    expect(pageHtml("s", bytes("<p>ok</p>"))).toBe("<p>ok</p>");
    expect(() => pageHtml("s", new Uint8Array())).toThrow(SourceError);
    expect(() => pageHtml("s", new Uint8Array(PAGE_BYTES + 1).fill(32))).toThrow(SourceError);
    expect(() => pageHtml("s", new Uint8Array([0xff]))).toThrow(/not UTF-8/);
    expect(() => pageHtml("s", bytes("<title> Just a moment...</title>"))).toThrow(AccessChallenge);
    expect(() => pageHtml("s", bytes('<div class="captcha-container">'))).toThrow(AccessChallenge);
  });

  it("reads the JobPosting objects of ld+json scripts and refuses a script that is not JSON", () => {
    const html = '<script type="application/ld+json">{"@type":"JobPosting","title":"a"}</script><script type="application/ld+json">{"@type":"Organization"}</script><script>{"@type":"JobPosting"}</script>';
    expect(jobPostings("s", html)).toEqual([{ "@type": "JobPosting", title: "a" }]);
    expect(() => jobPostings("s", '<script type="application/ld+json">{nope</script>')).toThrow(SourceError);
  });

  it("maps employment types to a kind and refuses types that are not text", () => {
    expect(kindOf(["FULL_TIME", "CONTRACTOR"])).toBe("full_time");
    expect(kindOf(["TEMPORARY"])).toBe("contract");
    expect(kindOf(["OTHER"])).toBeNull();
    expect(employmentTypes("s", "PART_TIME", true)).toEqual(["PART_TIME"]);
    expect(employmentTypes("s", [], false)).toEqual([]);
    expect(() => employmentTypes("s", [], true)).toThrow(SourceError);
    expect(() => employmentTypes("s", [1], false)).toThrow(SourceError);
  });

  it("gives one board URL for the spellings of one job and null for other URLs", () => {
    const article = /^\/jobs\/[a-z0-9-]+\/$/;
    const one = (v: string) => boardUrl("https://b.example/", "b.example", article, v);
    for (const v of ["https://b.example/jobs/a-1/", " https://B.example:443/jobs/a-1/?x=1#y", "/jobs/a-1/", "jobs/a-1/"]) expect(one(v)).toBe("https://b.example/jobs/a-1/");
    for (const v of ["http://b.example/jobs/a-1/", "https://evil.example/jobs/a-1/", "https://u:p@b.example/jobs/a-1/", "https://b.example/jobs/a-1", "https://b.example\\jobs/a-1/"]) expect(one(v)).toBeNull();
    expect(boardUrl("https://b.example/", "b.example", article, 7)).toBeNull();
  });

  it("sets aside a detail page that fails to read or normalize, and fails the source on a challenge or 401/403/429", async () => {
    const r = await readDetails(["a", "404", "net", "bad", "b"], async (id) => {
      if (id === "404") throw new FetchError("http_status", "404", 404);
      if (id === "net") throw new FetchError("network", "down");
      if (id === "bad") throw new SourceError("bad");
      return listing(id);
    });
    expect({ ids: r.listings.map((l) => l.external_id), rejected: r.rejected, examined: r.examined, truncated: r.truncated }).toEqual({ ids: ["a", "b"], rejected: 3, examined: 5, truncated: false });
    for (const status of [401, 403, 429]) await expect(readDetails(["x"], async () => { throw new FetchError("http_status", "s", status); })).rejects.toThrow(FetchError);
    await expect(readDetails(["x"], async () => { throw new AccessChallenge("c"); })).rejects.toThrow(AccessChallenge);
    await expect(readDetails(["x"], async () => { throw new TypeError("bug"); })).rejects.toThrow(TypeError);
  });

  it("stops at the request cap and marks the read truncated, keeping what was read", async () => {
    const r = await readDetails(["a", "cap", "b"], async (id) => {
      if (id === "cap") throw new FetchError("request_limit", "cap");
      return listing(id);
    });
    expect({ ids: r.listings.map((l) => l.external_id), rejected: r.rejected, examined: r.examined, truncated: r.truncated }).toEqual({ ids: ["a"], rejected: 0, examined: 1, truncated: true });
  });
});
