---
title: Rewrite freelance-agent as a Next.js full-stack TypeScript app on Vercel and Neon, leaving the VM
project: freelance-agent
date: 2026-10-23
review-date: 2027-01-23
last-reviewed:
status: active
tags: [freelance-agent, decision, architecture, deployment]
---

# Rewrite freelance-agent as a Next.js full-stack TypeScript app on Vercel and Neon, leaving the VM

## Context

Production runs as Docker Compose on the self-managed Oracle VM `oci-a1`: a Next.js UI, a FastAPI API, one Huey worker and SQLite. The UI is reachable only through an SSH tunnel. Every 09:00 Asia/Taipei the worker ingests 27 sources and sends a digest through Gmail SMTP.

The owner is the only developer and the only user. He wants to stop maintaining the VM and to develop in one language. Measured at `d994cd2`:
- `backend/src` has 9,940 lines of Python and 629 tests.
- The 29 connectors use only the Python standard library.
- The frontend is 33 files and 782 lines of TypeScript.
- On 2026-10-23 the run took about 5 minutes (one sample).

**Constraints:**

- `external` Vercel functions are capped at 300 s on Hobby and 800 s on Pro. They have no persistent filesystem. Hobby cron runs once a day, fires anywhere within the hour, and is best-effort: it can miss a run or fire twice ([limits](https://vercel.com/docs/functions/limitations), [cron](https://vercel.com/docs/cron-jobs/manage-cron-jobs)).
- `external` Production is live and sends one email a day. Delivery evidence and history (19 tables) must survive the move, and no digest may be sent twice.
- `inherited` Product rules in `AGENTS.md`: untrusted listings, unknown stays unknown, no automatic retry of an uncertain delivery, offline demo. Still holds: these are product requirements and do not depend on the stack.
- `inherited` SQLite, Huey and FastAPI were chosen on 2026-09-28 (`docs/design.md`). They do not bind this decision; they are our own earlier choice.
- `inherited` Dedup and receipt fingerprints are hashes of Python `json.dumps` output. Still holds: the stored history depends on them. A new writer must reproduce them byte for byte or re-key the data.

## Options Considered

- **Baseline. One language, push-to-deploy managed hosting, managed scheduler and managed database.** This is the usual setup for a small single-user web app, for example Next.js on Vercel with Postgres and Cron ([Vercel cron guide](https://vercel.com/docs/cron-jobs)). Option C is this baseline.
- **A. Stay on the VM and add CI deploys, offsite DB copies (Litestream) and a one-command release.** Cheapest. Keeps all code and tests. Still leaves host maintenance and two languages.
- **B. Keep Python, Huey and SQLite, and move the containers to Fly.io or Railway with a volume.** Push deploy. Long-running worker fits the 5-minute run. Little rework, about USD 5 a month (inferred from public pricing). Still two languages.
- **E. Keep Python on Vercel as FastAPI functions, with Postgres.** Off the VM with no logic rewrite. Pays all of C's serverless costs (DB swap, per-source fan-out, rebuilt run claims) and keeps two languages.
- **C. Rewrite as a Next.js full-stack TypeScript app on Vercel, with Neon Postgres and Vercel Cron and Workflows** (chosen).

## Decision

- **D0** Option C, migrated in stages. Each source runs in shadow mode against a daily copy of production, writing only to a shadow DB, and must match Python's output before the single production cutover. Plan: `docs/plans/2026-10-23-nextjs-vercel-migration.md`.
- **D1** Vercel Hobby with Neon free tier, function and DB in the same region. Upgrade to Pro if the non-commercial terms or cron precision become a problem.
- **D2** Vercel Cron plus Vercel Workflows, one step per source with retries off for side effects (spike 1b: 27 parallel steps in 65 s, a failing step ran once).
- **D5** Two daily crons, 09:00 and a 12:00 catch-up; the `daily_runs` claim keeps it to one digest per day.
- **D12** Retire `ptt_soho` and `ptt_codejob` at cutover: Vercel egress gets a 403 challenge in both sin1 and iad1, and they produced 3 jobs in total. Region is iad1 for functions and Neon (sin1 also blocked 518).
- **D3** New app in `web/` in this repository. `backend/`, `frontend/` and `contracts/` are deleted after cutover.
- **D4** Move all 25 tables. Fingerprints stay byte-compatible: hashed and snapshotted columns are stored as `text`, not `jsonb`.
- **D6** 14-day rollback window. The VM is stopped but kept, and a reverse Postgres → SQLite convergence script is ready.
- **D7** Submissions (Email/Freelancer sending, never configured) move as data only.
- **D8** Port the `records.py` envelope codec, the `review_status` reads and the historical approval invalidation. Legacy AI and old PG code move as data only.
- **D9** Keep Gmail SMTP for the digest (current transport, measured from `smtp-accepted` receipts); spike 1d must prove Vercel can reach port 465.
- **D10** Zod schemas are the single contract source. OpenAPI generation is dropped.
- **D11** During shadow, a daily production copy is loaded into a Neon shadow branch.
- **D14** (2026-10-25) Mail sources get their shadow run on Vercel with a dedicated full_access Resend key in production env. Resend has no read-only key scope, so this is the one send-capable credential allowed before cutover; it is guarded by code and tests (a runtime allowlist of GET under `/emails/receiving`, one module naming the API) and an exact env key-name allowlist. Rejected: running the TS mail sync on the VM (shadow-only code deleted at cutover) and offline replay only (no natural-mail comparison). Leak response: revoke, then audit API keys, domains and webhooks.

## Rationale

- **C rather than A or B.** A and B fix deploys and hosting, but the owner chose C to work in one language across UI, API and connectors. Only C, or a later rewrite, delivers that. The cost is rewriting about 10k lines and re-proving 629 tests' behaviour. That cost is effort we choose to spend, not an external constraint. Both independent drafts preferred A or B because they assumed the pain was operations only. That premise was put to the owner on 2026-10-23, and he chose C.
- **C rather than E.** E pays every serverless cost of C and keeps two languages. It is a waypoint, not an end state.
- **How the Vercel limits are handled.** Each source runs as its own Workflow step, and spike 1e measures each source on Vercel. A `daily_runs` row claim absorbs duplicate cron fires. A second 12:00 catch-up cron covers missed fires (D5). Trade-off: the digest time moves within 09:00–09:59 on Hobby.
- **How the double-send and history risks are handled.** Python stays the only writer and sender until cutover. Production env holds no send credentials during shadow, except the Resend receiving key of D14, which Resend cannot scope to reading. Byte-compatible hashing is proven in spike 1c before any port; if it fails, D4 is revisited.
- **D4 rather than archiving history.** Re-keying or dropping receipts would make the first post-cutover run treat about 2,200 known jobs as new.

## Expected Outcome

- No VM to maintain. Every push to `main` deploys through Vercel.
- One TypeScript codebase. The CI tests port the Python behaviour cases.
- The same daily digest semantics: at most one per day, no automatic retry of an uncertain send, history preserved.

## Revocation Triggers

- Spike 1b, 1c or 1e fails: Workflows cannot fan out 27 sources, hashes cannot be reproduced byte for byte, or three or more sources block Vercel egress. Re-evaluate B for the worker while keeping the TS UI.
- Vercel or Neon cost on the chosen plan exceeds about USD 25 a month. Re-evaluate B.
- After the pilot (plan step 6), the remaining port is estimated at more than twice the plan's size. Re-evaluate whether to stop at E.

## Amendment (2026-10-26)

D0's requirement that each source "must match Python's output before the single production cutover" and D4's permanent byte compatibility are replaced by `docs/adr/2026-10-26-digest-ledger-shared-read-model-native-port.md`. The port is native; shadow differences are reviewed and accepted rather than forbidden. Stored hash algorithms change only after the D6 window, through versioning, and v1 stays available to verify old rows. Option C and every other decision here still hold.

## Related

- Plan and inventories: `docs/plans/2026-10-23-nextjs-vercel-migration.md` and its directory (snapshot `d994cd2`).
- Amended by: `docs/adr/2026-10-26-digest-ledger-shared-read-model-native-port.md` (D0 parity, D4 byte compatibility).
- Superseded once cutover is complete: `docs/design.md` §現行部署：Docker Compose＋Huey＋SQLite (2026-09-28).
- Source: owner decision on 2026-10-23 after two independent critiques of the option brief, one plan review, and two independent ADR drafts. Both drafts recommended A or B; their arguments are answered under Rationale.
