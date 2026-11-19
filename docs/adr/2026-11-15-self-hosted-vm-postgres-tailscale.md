---
title: Self-host on the VM with Postgres behind Tailscale, read public pages through an escalating tier, no backups and no rollback window
project: side-income
date: 2026-11-15
review-date: 2027-05-15
last-reviewed:
status: active
supersedes: docs/adr/2026-10-23-nextjs-vercel-full-stack-rewrite.md
tags: [side-income, decision, architecture, deployment]
---

# Self-host on the VM with Postgres behind Tailscale, read public pages through an escalating tier, no backups and no rollback window

## Context

Since 2026-11-06 production was the 2026-10-23 design: Next.js on Vercel Hobby, Cloudflare D1, Vercel Cron and Workflows, a daily digest email. The owner is the only developer and the only user. On 2026-11-15 the owner restated the requirements (`docs/plans/2026-11-15-self-hosted-rebuild/requirements.md`, S1–S7): Postgres; drop proposals, approvals and manual submissions; self-host everything on the owner's Oracle VM; keep reading when a source answers with an access challenge, but only public pages that need no login, including PTT; the web UI reachable only through Tailscale; no backups; mail stays on Resend Receiving; no rollback window after cutover.

**Constraints:**

- `external` Vercel egress gets a 403 challenge from PTT in both regions tried (2026-10-23 ADR, D12). Reading PTT, and any source that needs a real browser, cannot happen from Vercel functions.
- `external` Vercel Hobby functions stop at 300 s and Hobby cron is best-effort. A headless browser does not fit in a function.
- `external` The production D1 API token expires on 2026-11-30 and cannot be renewed from the CLI login. Cutover had to finish before that date or the token had to be rebuilt by hand.
- `external` Only public, login-free pages may be read; no logging in, no CAPTCHA solving, no IP rotation (owner's rule, also in `AGENTS.md`).
- `external` The repository is public: no addresses, hostnames or account details in it.
- `inherited` The 2026-10-23 reason for leaving the VM was "stop maintaining a host and develop in one language". One language still holds (all code is TypeScript). Host maintenance is now accepted by the owner as the price of S3–S5. It no longer constrains the choice.
- `inherited` Byte-compatible Python fingerprints and moving all 25 tables (2026-10-23, D4). Dropped: the owner decided on 2026-11-15 that no old data is carried over (plan D10), so the old hashes have no reader.

## Options Considered

- **Baseline. Managed platform plus a managed browser API.** Keep Vercel and a managed database, and send challenged sources through a hosted scraping or browser service (for example Browserless or a scraping API). This is the common setup for a small app that needs a few rendered pages ([Browserless](https://www.browserless.io/), [Vercel functions limits](https://vercel.com/docs/functions/limitations)). Rejected: every hosted scraping service rotates or proxies IPs, which the access rule forbids, and S3 asks for self-hosting.
- **B. Keep Vercel for the UI and run only the crawler on the VM.** Smallest move for the PTT problem. Rejected: two deploy targets and two runtimes for one user, and the database still has to live on one side and be reached from the other over the internet, against S5.
- **C. Everything on the VM: Docker Compose with Next.js, Postgres and a separate browser service, a systemd timer for the daily run, Tailscale Serve for access** (chosen).
- **Backups.** Rejected: copies to another machine, to object storage, or local dumps only. Chosen: none.
- **Mail intake.** Rejected: IMAP on the mailbox, receiving mail on the VM. Chosen: Resend Receiving, read with GET only.
- **Challenged sources.** Rejected for the browser tier: Scrapling in a Python service (passed one platform fewer than Crawlee in the VM spike, 406–734 MiB peak against 484 MiB). Rejected: stopping at the browser-like tier with no browser (cheapest, but browser-only platforms are lost). Rejected for the browser-like tier: a Python curl_cffi service (the rule was three passing days on the VM; Remote.co blocked it on day 2, 2026-11-18) and a Node binding to curl-impersonate (package maturity unproven, and it would only have served Remote.co). Chosen: plain request, then impit with a Firefox fingerprint, then Crawlee with Playwright, picked per source in its catalog entry.
- **Rollback window after cutover.** Rejected: 7 or 14 days with Vercel and D1 kept. Chosen: none.

## Decision

- **D0** Option C. Postgres in Compose, Next.js `web`, one `daily` job, a `browser` render service, web bound to 127.0.0.1 and published only through Tailscale Serve. Proposal, approval, submission and digest tables and code are removed. Targets are PTT SOHO, PTT CodeJob plus the platforms the VM spike could read.
- **D1** No backups and no restore drills. A lost disk loses feedback, settings, mail records and run history; listings come back with the next daily run.
- **D2** Resend Receiving for the mail sources.
- **D3** Platforms: PTT SOHO, PTT CodeJob, Arc, Web3.career, Wellfound, Remote.com, YC Jobs on the plain tier; Idealist and Braintrust on the browser tier (Glassdoor and Turing were also chosen but failed the VM measurement, step 8d-2). Not Reddit r/forhire (API approval required) or Upwork (terms forbid scraping). Remote.co is deferred (blocked on the VM by every tier).
- **D4** Browser tier is Crawlee plus Playwright. **D4a** Browser-like tier stays impit; no curl_cffi service.
- **D5** No rollback window. Vercel and D1 were retired the day after the cutover's next-day run passed.

## Rationale

C is the only option that reads PTT and browser-only sources without breaking the access rule, keeps one language, and keeps the UI off the public internet. It costs host maintenance, a single machine with no redundancy, and a memory budget shared with the browser. No backups trades the owner's own feedback history for zero operational work; the listings, which are most of the data, regenerate. No rollback window trades a safety net for not keeping D1 alive past its token expiry and not maintaining two systems.

## Expected Outcome

- One daily run per day from the timer, all enabled sources `ok` (measured on the VM 2026-11-18: 34 of 34 sources ok in 6 min 44 s).
- The web UI answers only inside the tailnet; public ports time out.
- No Vercel project or D1 database for this app exists.

## Revocation Triggers

- The VM is lost or its memory cannot hold the browser tier next to Postgres and web.
- A source the owner needs can only be read with a login, a CAPTCHA or a rotated IP.
- Losing feedback history becomes unacceptable: revisit D1.
- Resend Receiving keeps received mail too briefly to re-read rejected messages (checked once a rejected message is 14 days old): revisit the re-read part of mail intake.

## Followup

- Revoke the remaining Vercel spike project, the D1 token and the old Resend sending key (owner, outside the repository).
- Remote.co: re-test when a tier that respects the access rule can read it from the VM.

## Related

- Plan: `docs/plans/2026-11-15-self-hosted-rebuild.md` (decision table D0–D5, D4a; spikes in `spikes.md`).
- Superseded: `docs/adr/2026-10-23-nextjs-vercel-full-stack-rewrite.md`.
