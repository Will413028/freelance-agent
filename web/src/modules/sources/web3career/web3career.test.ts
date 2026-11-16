import { describe, expect, it } from "vitest";
import { describeOnePageSource } from "../../../../tests/helpers/single-page-source";
import { INDEX, normalizeRow, parseIndex, WEB3CAREER_SETTINGS, type Row } from ".";

// Plan step 8b: Web3.career is a new source (no old reader or golden pages); the rows below follow the
// page read on 2026-11-17 (spikes.md §2), with made-up values.

type R = { id: string; slug: string; title: string; company: string; places: string[]; time: string; ld?: Record<string, unknown> | null };
const enc = (s: string) => new TextEncoder().encode(s);
const row = (i: number, o: Partial<R> = {}): R => ({ id: String(150000 + i), slug: `ai-agent-engineer-acme`, title: `AI agent engineer ${i}`, company: "Acme", places: ["Lausanne", "Switzerland"], time: "2026-11-16 09:11:02+07:00", ...o });
const tr = (r: R) => `<tr data-jobid=${r.id} class="table_row"><td><a href="/${r.slug}/${r.id}"><h2> ${r.title} </h2></a><a href="/${r.slug}/${r.id}"><h3> ${r.company} </h3></a>`
  + `<span class=job-location-mobile>${r.places.map((p) => `<a href="/web3-jobs-x">${p}</a>`).join(", ")}</span></td><td><time datetime="${r.time}"> 7h </time></td>`
  + `<td><p title="Estimated salary based on similar jobs"> $98k - $150k </p></td></tr>`;
const ld = (r: R) => r.ld === null ? "" : `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: r.title, hiringOrganization: { name: r.company }, description: `<p>Build ${r.title}</p>`, ...r.ld })}</script>`;
const page = (rows: R[]) => enc(`<html><table>${rows.map(tr).join("")}</table>${rows.map(ld).join("")}</html>`);
const one = (o: Partial<R> = {}, extra: R[] = []) => {
  const { rows, descriptions } = parseIndex(page([row(1, o), ...extra]));
  return normalizeRow(rows[0], descriptions);
};

describeOnePageSource({
  settings: WEB3CAREER_SETTINGS, index: INDEX, page, good: (i) => row(i), retitled: (i) => row(i, { title: "Retitled" }), id: (i) => String(150000 + i),
  bad: () => row(99, { id: "x" }), broken: enc("<html><body>no table</body></html>"),
});

describe("web3.career rows", () => {
  it("reads the row: link, title, company, places, time with its offset; the site's estimated salary is not kept", () => {
    const l = one();
    expect([l.url, l.title, l.company, l.location, l.published_at, l.compensation_evidence, l.budget_min]).toEqual(["https://web3.career/ai-agent-engineer-acme/150001", "AI agent engineer 1", "Acme", "Lausanne, Switzerland", "2026-11-16T02:11:02.000Z", null, null]);
  });

  it("takes the description of the one JobPosting with the same title and company, ignoring punctuation and an extra escape", () => {
    expect(one().description).toBe("Build AI agent engineer 1");
    expect(one({ title: "Data Engineer NYC", company: "Node &amp; Vector", ld: { title: "Data Engineer, NYC", hiringOrganization: { name: "Node &amp;amp; Vector" } } }).description).toBe("Build Data Engineer NYC");
    expect(one({ ld: null }).description).toBeNull();
    // Two postings for the same title and company cannot be told apart: unknown.
    expect(one({}, [row(2, { title: "AI agent engineer 1" })]).description).toBeNull();
  });

  it("names a row by its id only", () => {
    expect(one({ title: "Renamed", slug: "renamed-acme" }).external_id).toBe("150001");
  });

  it("keeps unknown unknown: a time without offset, no places, eligibility, kind", () => {
    const l = one({ time: "2026-11-16 09:11:02", places: [] });
    expect([l.published_at, l.location, l.taiwan_eligible, l.kind]).toEqual([null, null, null, null]);
  });

  it("sets aside a row without id, title or a link ending with its id", () => {
    const bad = (r: Row) => () => normalizeRow(r, new Map());
    const good: Row = { id: "150001", href: "/x/150001", title: "T", company: "C", places: [], time: "" };
    for (const o of [{ id: "x" }, { href: "/x/150002" }, { href: "https://evil.example/x/150001" }, { title: " " }]) expect(bad({ ...good, ...o })).toThrow(/web3career/);
    expect(bad(good)).not.toThrow();
  });
});
