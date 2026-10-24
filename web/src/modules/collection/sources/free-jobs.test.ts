import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCapped, loadsBytes } from "@/platform/http";
import { fromisoformat, PyDateTime } from "@/platform/py/datetime";
import { encode } from "@/platform/py/json";
import { PyDict, type PyValue } from "@/platform/py/value";
import { qualify } from "@/modules/discovery/public";
import { attempt, fixture, untag, type Expect, type Tagged } from "../../../../tests/helpers/golden";
import { normalize } from "./free-jobs";
import { htmlText } from "./text";

// Plan step 6: collection/free_jobs.py against the ground truth gen_golden.py wrote with the
// production image's Python (3.13.15), plus the six cases of backend/tests/collection/test_free_jobs.py
// that need no store (the store ones are in web/tests/free-jobs.test.ts).

const golden = fixture<{
  html_text: { input: string; expect: Expect<string> }[];
  free_jobs_normalize: { source: string; payload: Tagged; expect: Expect<{ job: string; received_at: string | null }> }[];
}>("golden.json");

const NOW = new PyDateTime(2026, 9, 28, 1, 0, 0, 0, 0n);
const without = (d: PyDict, key: string) => new PyDict([...d].filter(([k]) => k !== key));

describe("free_jobs.Text matches CPython 3.13.15 html.parser", () => {
  it(`${golden.html_text.length} fragments`, () => {
    const bad = golden.html_text.filter((c) => JSON.stringify(attempt(() => htmlText(c.input))) !== JSON.stringify(c.expect));
    expect(bad.map((c) => c.input)).toEqual([]);
  });
});

describe("free_jobs.normalize matches Python", () => {
  it(`${golden.free_jobs_normalize.length} payloads`, () => {
    const bad = golden.free_jobs_normalize.filter((c) => {
      const got = attempt(() => {
        const payload = untag(c.payload);
        const j = normalize(c.source, payload, NOW);
        const key = c.source === "remotive" ? "publication_date" : "pubDate";
        const aware = fromisoformat(((payload as PyDict).at(key) as string).replaceAll("Z", "+00:00")).aware;
        return { job: encode(without(j, "received_at")), received_at: aware ? j.at("received_at") : null };
      });
      return JSON.stringify(got) !== JSON.stringify(c.expect);
    });
    expect(bad.map((c) => [c.source, JSON.stringify(c.payload).slice(0, 160)])).toEqual([]);
  });
});

const rem = (changes: Record<string, PyValue> = {}) => PyDict.of({
  id: 1n, url: "https://remotive.com/remote-jobs/software-dev/backend-1", title: "Backend API engineer",
  description: "<p>Build an API</p>", job_type: "part_time", publication_date: "2026-09-18T12:00:00",
  candidate_required_location: "Worldwide", ...changes,
});

describe("test_free_jobs.py", () => {
  it("part time, unknown hours and geography not assumed", () => {
    const j = normalize("remotive", rem());
    expect(j.at("kind")).toBe("contract");
    expect(j.at("weekly_hours")).toBeNull();
    expect(j.at("taiwan_eligible")).toBeNull();
    expect(j.at("description")).toBe("Build an API");
  });

  it("full time and a known country are excluded", () => {
    expect(qualify(normalize("remotive", rem({ job_type: "full_time" })), 30n, PyDateTime.now(), 3000n).at("status")).toBe("excluded");
    expect(normalize("remotive", rem({ candidate_required_location: "USA" })).at("taiwan_eligible")).toBe(false);
  });

  it("a Jobicy salary is not a total project price", () => {
    const j = normalize("jobicy", PyDict.of({
      id: 2n, url: "https://jobicy.com/jobs/2-python", jobTitle: "Python API", jobDescription: "<p>API</p>", jobType: ["contract"],
      jobGeo: "Anywhere", pubDate: "2026-09-18T12:00:00+00:00", salaryMin: 100000n, salaryPeriod: "yearly",
    }));
    expect(j.at("budget_min")).toBeNull();
    expect(j.at("kind")).toBe("contract");
  });

  it("requires the board's URL and a full description", () => {
    for (const c of [{ url: "https://evil.example/" }, { description: null }] as Record<string, PyValue>[]) {
      expect(() => normalize("remotive", rem(c))).toThrow();
    }
  });
});

describe("feed transport", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") res.writeHead(302, { location: "/ok" }).end();
      else if (req.url === "/big") res.writeHead(200).end("x".repeat(2048));
      else res.writeHead(200).end('{"jobs": []}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("does not follow redirects", async () => {
    expect((await getCapped(`${base}/redirect`, {}, 1024, 5000)).status).toBe(302);
  });

  it("stops reading past the cap so the caller can reject cap + 1", async () => {
    const r = await getCapped(`${base}/big`, {}, 1024, 5000);
    expect(r.body.length).toBeGreaterThan(1024);
    expect(r.body.length).toBeLessThanOrEqual(2048);
  });

  it("loads JSON bytes the way json.loads(bytes) detects encodings", () => {
    const text = '{"jobs": [1]}';
    const utf16le = Buffer.from("﻿" + text, "utf16le");
    for (const b of [Buffer.from(text), Buffer.from("﻿" + text), utf16le, Buffer.from(text, "utf16le")]) {
      expect(encode(loadsBytes(b))).toBe('{"jobs": [1]}');
    }
    expect(() => loadsBytes(Buffer.from([0x7b, 0xff, 0x7d]))).toThrow();
  });
});
