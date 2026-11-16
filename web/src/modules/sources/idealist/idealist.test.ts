import { describe, expect, it } from "vitest";
import { describeOnePageSource } from "../../../../tests/helpers/single-page-source";
import { IDEALIST_SETTINGS, INDEX, normalizeCard, parseIndex, WAIT_FOR } from ".";

// Plan step 8d-3: Idealist is a new source (no old reader); the cards below follow the page the browser tier
// rendered from the VM on 2026-11-17 (8d-2), with made-up values.

type J = { id?: string; kind?: string; title?: string; href?: string; tags?: string[]; company?: string };
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (i: number) => i.toString(16).padStart(32, "0");
const card = (i: number, o: J = {}): J => ({ id: hex(i), kind: "nonprofit-job", title: `Program officer ${i}`, company: "Helping Hands", tags: ["Remote", "@Nepal", "Contract/Freelance", "USD&nbsp;$5 - $20 / hour"], ...o });
const tag = (t: string) => t.startsWith("@")
  ? `<span data-variant="default" data-size="micro"><span><div role="img" aria-label="location-filled icon"></div></span><span>${t.slice(1)}</span></span>`
  : `<span data-variant="default" data-size="micro"><span></span><span>${t}</span></span>`;
const html = (j: J) => `<div id="search-hit-${j.id}" data-qa-id="search-result"><div><a href="/en/nonprofit/helping-hands">org</a><a href="${j.href ?? `/en/${j.kind}/${j.id}-program-officer`}"><div><h3><div><span data-qa-id="search-result-link">${j.title}</span></div></h3><h4><div>${j.company}</div></h4></div><div>${(j.tags ?? []).map(tag).join("")}</div><div><div><span>Posted 3 days ago</span></div></div></a></div></div>`;
const page = (cards: J[]) => enc(`<html><body><main>${cards.map(html).join("")}</main></body></html>`);
const one = (o: J = {}) => normalizeCard(parseIndex(page([card(1, o)]))[0]);

describeOnePageSource({
  settings: IDEALIST_SETTINGS, index: INDEX, tier: "browser", request: { maxBytes: 2_000_000, timeoutMs: 60_000, waitFor: WAIT_FOR },
  page, good: (i) => card(i), retitled: (i) => card(i, { title: "Retitled" }), id: hex,
  bad: () => card(99, { href: "/en/volunteer-opportunity/abc" }), broken: enc("<html><body><p>no results</p></body></html>"),
});

describe("idealist", () => {
  it("reads the card: link, organization, place by its icon, type, pay as evidence", () => {
    const l = one();
    expect([l.url, l.company, l.location, l.kind, l.compensation_evidence]).toEqual([`https://www.idealist.org/en/nonprofit-job/${hex(1)}-program-officer`, "Helping Hands", "Nepal", "contract", "USD $5 - $20 / hour"]);
    expect(l.extra).toEqual({ tags: ["Remote", "Nepal", "Contract/Freelance", "USD $5 - $20 / hour"], posted: "Posted 3 days ago" });
    expect([one({ tags: ["Full Time", "At least MYR 1,900 / month"] }).compensation_evidence, one({ tags: ["Full Time"] }).kind]).toEqual(["At least MYR 1,900 / month", "full_time"]);
  });

  it("takes pay only from a tag ending in an amount per period", () => {
    expect([one({ tags: ["NYC 10001", "Full Time"] }).compensation_evidence, one({ tags: ["@NYC 10001", "USD $20 - $30 / day"] }).compensation_evidence]).toEqual([null, "USD $20 - $30 / day"]);
  });

  it("reads government and other job pages too", () => {
    expect([one({ kind: "government-job" }).url, one({ kind: "job" }).external_id]).toEqual([`https://www.idealist.org/en/government-job/${hex(1)}-program-officer`, hex(1)]);
  });

  it("names a job by its hex id, whatever the slug or the way the link is written", () => {
    const id = hex(1);
    for (const href of [`/en/nonprofit-job/${id}-renamed`, `https://WWW.idealist.org:443/en/nonprofit-job/${id}-program-officer`, ` /en/nonprofit-job/${id}-program-officer?utm=x `, `/en/nonprofit-job/${id}-coordinación_Programas`]) expect(one({ href }).external_id).toBe(id);
  });

  it("keeps unknown unknown: no place tag, unknown type, no pay; Taiwan eligibility, publication time, description, budget", () => {
    const l = one({ tags: ["Remote", "Internship"] });
    expect([l.location, l.kind, l.compensation_evidence, l.taiwan_eligible, l.published_at, l.description, l.budget_min]).toEqual([null, null, null, null, null, null, null]);
  });

  it("sets aside a card without a job link or title", () => {
    for (const o of [{ href: "https://evil.example/en/nonprofit-job/" + hex(1) + "-x" }, { href: "/en/nonprofit-job/XYZ-x" }, { href: "/en/volunteer-opportunity/" + hex(1) + "-x" }, { title: " " }]) expect(() => one(o)).toThrow(/idealist/);
  });
});
