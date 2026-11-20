import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { mailMessages } from "@/db/pg/schema";
import { handleMailDisposition, type WriteDeps } from "@/app/_lib/writes";
import { SourcesTable } from "@/app/_lib/views";
import { POST as retryRoute } from "@/app/sources/retry/route";
import { POST as dismissRoute } from "@/app/sources/dismiss/route";
import { sourcesPage } from "@/services/pages";
import { freshPg } from "./helpers/pg";

// Plan step 7b: the two /sources writes on rejected mail, grouped by source and reason, through guardedForm.

let db: PgDb, close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await freshPg()));
afterAll(async () => close());
beforeEach(async () => {
  await db.execute(sql`truncate mail_messages`);
  const row = (n: number, reason: string, source = "jobbank104") =>
    ({ source, recipient: "box@example.resend.app", messageId: `m${n}`, status: "rejected" as const, reason, checkedAt: new Date("2026-11-17T01:00:00Z") });
  await db.insert(mailMessages).values([row(1, "104_incomplete_digest"), row(2, "104_incomplete_digest"), row(3, "body_too_large"), row(4, "tasker_body", "tasker"), row(5, "message_gone")]);
});

const deps = (): WriteDeps => ({ db: () => db, now: () => new Date() });
const form = (path: string, fields: [string, string][], headers: Record<string, string> = {}) =>
  new Request(`https://fa.example${path}`, {
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: { host: "fa.example", origin: "https://fa.example", "content-type": "application/x-www-form-urlencoded", ...headers },
  });
const fields = (reason: string, source = "jobbank104"): [string, string][] => [["source", source], ["reason", reason], ["back", "/sources"]];
const dispositions = async () => Object.fromEntries((await db.select().from(mailMessages)).map((r) => [r.messageId, r.disposition]));

describe("rejected mail actions", () => {
  it("retry marks one source's messages of one reason and answers 303 back to /sources with a notice", async () => {
    const res = await handleMailDisposition(form("/sources/retry", fields("104_incomplete_digest")), "retry", deps());
    expect([res.status, res.headers.get("location")]).toEqual([303, "/sources?notice=retried"]);
    expect(await dispositions()).toEqual({ m1: "retry", m2: "retry", m3: "none", m4: "none", m5: "none" });
  });

  it("dismiss takes the group out of the page's count", async () => {
    const res = await handleMailDisposition(form("/sources/dismiss", fields("body_too_large")), "dismissed", deps());
    expect(res.headers.get("location")).toBe("/sources?notice=dismissed");
    const view = await sourcesPage(db, new Date());
    expect(view.rejectedMail.map((g) => [g.source, g.reason, g.open, g.retry])).toEqual([["jobbank104", "104_incomplete_digest", 2, 0], ["jobbank104", "message_gone", 1, 0], ["tasker", "tasker_body", 1, 0]]);
    const html = renderToStaticMarkup(<SourcesTable data={view} />);
    expect(html).toContain("被拒的信");
    expect(html).toContain('action="/sources/retry"');
    expect(html).toContain('action="/sources/dismiss"');
    expect(html).not.toContain("body_too_large");
    expect(html.match(/action="\/sources\/retry"/g)).toHaveLength(2); // not for message_gone
  });

  it("shows each group's oldest rejected message age, so a stuck group is visible before Resend drops it", async () => {
    await db.insert(mailMessages).values({ source: "jobbank104", recipient: "box@example.resend.app", messageId: "m6", status: "rejected", reason: "104_incomplete_digest", disposition: "retry", checkedAt: new Date("2026-11-10T01:00:00Z") });
    const view = await sourcesPage(db, new Date("2026-11-20T03:00:00Z"));
    const group = view.rejectedMail.find((g) => g.reason === "104_incomplete_digest");
    expect(group?.oldestDays).toBe(10);
    expect(view.rejectedMail.find((g) => g.reason === "tasker_body")?.oldestDays).toBe(3);
    const html = renderToStaticMarkup(<SourcesTable data={view} />);
    expect(html).toContain("<th>最舊</th>");
    expect(html).toContain("<td>10 天</td>");
  });

  it("refuses an unknown or non-mail source and an unknown reason with 400, changing nothing", async () => {
    for (const f of [fields("104_incomplete_digest", "jobicy"), fields("104_incomplete_digest", "nope"), fields("not_a_reason"), fields("104_incomplete_digest", "tasker")]) {
      expect((await handleMailDisposition(form("/sources/retry", f), "retry", deps())).status).toBe(400);
    }
    expect((await handleMailDisposition(form("/sources/retry", fields("message_gone")), "retry", deps())).status).toBe(400);
    expect(Object.values(await dispositions())).toEqual(["none", "none", "none", "none", "none"]);
  });

  it("a write that changes nothing (a stale tab, a double submit) says so", async () => {
    await handleMailDisposition(form("/sources/dismiss", fields("tasker_body", "tasker")), "dismissed", deps());
    const again = await handleMailDisposition(form("/sources/dismiss", fields("tasker_body", "tasker")), "dismissed", deps());
    expect(again.headers.get("location")).toBe("/sources?notice=unchanged");
  });

  it("both routes refuse a write from another origin before touching the database (guardedForm)", async () => {
    for (const route of [retryRoute, dismissRoute]) {
      const res = await route(form("/sources/retry", fields("104_incomplete_digest"), { origin: "https://evil.example" }));
      expect(res.status).toBe(403);
    }
    expect(Object.values(await dispositions())).toEqual(["none", "none", "none", "none", "none"]);
  });
});
