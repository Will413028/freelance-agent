import { describe, expect, it } from "vitest";
import { describeOnePageSource } from "../../../../tests/helpers/single-page-source";
import { BRAINTRUST_SETTINGS, INDEX, normalizeJob, parseIndex, WAIT_FOR } from ".";

// Plan step 8d-3: Braintrust is a new source (no old reader); the cards below follow the page the browser tier
// rendered from the VM on 2026-11-17 (8d-2): generated class names left out, made-up values.

type J = { id: number | string; title?: string; company?: string | null; type?: string; pay?: string; role?: string; logo?: boolean };
const enc = (s: string) => new TextEncoder().encode(s);
const job = (i: number, o: Partial<J> = {}): J => ({ id: 18000 + i, title: `Web designer ${i}`, company: "Acme", type: "Freelance", pay: "$90 – 130/hr", role: "Design", ...o });
const html = (j: J) => `<div tabindex="0">${j.logo ? `<a href="/jobs/${j.id}"><img alt="cover"></a>` : ""}<div><div><div>${j.company === null ? "" : `<a href="/employers/12/"><div><span title="${j.company}">${j.company}</span><div data-testid="employer-logo"><img alt="logo"></div></div></a>`}</div></div>`
  + `<div><div><a to="/jobs/${j.id}" href="/jobs/${j.id}" target="_blank"><div>${j.title}</div></a></div><div><a href="/jobs/${j.id}" target="_blank">View job<svg></svg></a></div>`
  + `<div><div><span><div><svg></svg>${j.type}</div></span><div><svg></svg><span title="${j.role}">${j.role}</span></div><span>New</span></div></div>`
  + `<div><div><div><div>United States | Dallas, TX, USA</div></div><div><div>39 hrs/wk</div></div></div></div><div><p><span><span>${j.pay}</span></span></p></div></div></div></div>`;
// The app root wraps page chrome and the list (a card must not grow into it), as the rendered page does.
const page = (jobs: J[]) => enc(`<html><body><div id="root"><header><a href="/jobs">Jobs</a><p>Earn $500 for referrals</p><span title="Menu">Menu</span></header><main><div>${jobs.map(html).join("")}</div><a href="/jobs/?page=1">2</a></main></div></body></html>`);
const one = (o: Partial<J> = {}) => normalizeJob(parseIndex(page([job(1, o)]))[0]);

describeOnePageSource({
  settings: BRAINTRUST_SETTINGS, index: INDEX, tier: "browser", request: { maxBytes: 2_000_000, timeoutMs: 60_000, waitFor: WAIT_FOR },
  page, good: (i) => job(i), retitled: (i) => job(i, { title: "Retitled" }), id: (i) => String(18000 + i),
  bad: () => job(99, { title: "" }), broken: enc('<html><body><a href="/jobs/?page=1">2</a></body></html>'),
});

describe("braintrust", () => {
  it("reads each job's own card: title, company, type, pay as evidence, role", () => {
    const got = parseIndex(page([job(1), job(2, { company: "Plaid", type: "Full-time", pay: "$45k – 50k/yr", role: "Finance" })])).map(normalizeJob);
    expect(got.map((l) => [l.external_id, l.url, l.title, l.company, l.kind, l.compensation_evidence, l.extra.roles])).toEqual([
      ["18001", "https://app.usebraintrust.com/jobs/18001", "Web designer 1", "Acme", "contract", "$90 – 130/hr", ["Design"]],
      ["18002", "https://app.usebraintrust.com/jobs/18002", "Web designer 2", "Plaid", "full_time", "$45k – 50k/yr", ["Finance"]],
    ]);
  });

  it("tells neighbouring cards apart when a card shows only its title link", () => {
    const html = new TextDecoder().decode(page([job(1), job(2)])).replace(/<a href="\/jobs\/\d+" target="_blank">View job<svg><\/svg><\/a>/g, "");
    expect(html).not.toContain("View job");
    expect(parseIndex(new TextEncoder().encode(html)).map(normalizeJob).map((l) => [l.external_id, l.company, l.compensation_evidence])).toEqual([["18001", "Acme", "$90 – 130/hr"], ["18002", "Acme", "$90 – 130/hr"]]);
  });

  it("reads one job alone on the page without the page chrome", () => {
    const l = one({ pay: "Rate on request" });
    expect([l.compensation_evidence, l.extra.roles]).toEqual([null, ["Design"]]);
  });

  it("keeps a card whole when it links to its job a third time (a logo link)", () => {
    const got = parseIndex(page([job(1, { logo: true }), job(2, { logo: true })])).map(normalizeJob);
    expect(got.map((l) => [l.external_id, l.title, l.company])).toEqual([["18001", "Web designer 1", "Acme"], ["18002", "Web designer 2", "Acme"]]);
  });

  it("names a job by its number only, not by pagination or employer links", () => {
    expect(parseIndex(page([job(1, { title: "Renamed" })])).map((j) => j.id)).toEqual(["18001"]);
    for (const href of ["https://app.usebraintrust.com/jobs/18001", "/jobs/18001/", " /jobs/18001?ref=list ", "https://APP.usebraintrust.com:443/jobs/18001"]) {
      expect(parseIndex(new TextEncoder().encode(new TextDecoder().decode(page([job(1)])).replaceAll('href="/jobs/18001"', `href="${href}"`))).map((j) => j.id)).toEqual(["18001"]);
    }
    for (const href of ["https://evil.example/jobs/18001", "http://app.usebraintrust.com/jobs/18001"]) {
      expect(() => parseIndex(new TextEncoder().encode(new TextDecoder().decode(page([job(1)])).replaceAll('href="/jobs/18001"', `href="${href}"`)))).toThrow(/no jobs/);
    }
    for (const id of ["018001", "1.5", "x"]) expect(() => parseIndex(page([job(1, { id })]))).toThrow(/no jobs/);
  });

  it("keeps unknown unknown: company, type, pay; location, Taiwan eligibility, publication time, description, budget", () => {
    const l = one({ company: null, type: "Gig", pay: "Rate on request" });
    expect([l.company, l.kind, l.compensation_evidence, l.location, l.taiwan_eligible, l.published_at, l.description, l.budget_min]).toEqual([null, null, null, null, null, null, null, null]);
  });

  it("sets aside a job without a title", () => {
    expect(() => one({ title: "  " })).toThrow(/braintrust: title required/);
  });
});
