---
title: Digest dedup ledger, one shared discovery read model, and a native TypeScript port
project: freelance-agent
date: 2026-10-26
review-date: 2027-01-26
last-reviewed:
status: active
amends: docs/adr/2026-10-23-nextjs-vercel-full-stack-rewrite.md
tags: [freelance-agent, decision, architecture, data-model]
---

# Digest dedup ledger, one shared discovery read model, and a native TypeScript port

## Context

The TypeScript port in `web/` has copied the Python implementation closely, so that shadow rows could be compared byte for byte. On 2026-10-25 that produced a digest build that ran past 10 minutes on production data. The cause was that `unseen()` rebuilt the seen-id set for every candidate; Python does the same, but in C. Step 14 of the plan had collected 12 "copy now, clean up after the rollback window" items, covering about 2,100 lines of Python emulation in `web/src/platform/py/` used by 60 files.

Measured on the 2026-10-25 production copy:
- 39 digest snapshots, 11.2 MB in total, growing about 290 KB a day.
- 2,406 snapshot items; 483 of them (the 12 earliest days) have no stored `novelty_keys`.
- 2,395 opportunities.
- One full `list` or group-feedback read transfers about 8.1 MB (measured in plan step 5).

**Constraints:**

- `external` Neon free plan: 5 GB of transfer a month. An overrun suspends compute, which also stops the digest. The digest re-reads every snapshot daily, so at the measured growth it alone reaches about 1 GB a month in roughly 75 days (inferred).
- `external` A Vercel step stops at 300 s.
- `external` Python is the production writer until cutover and the rollback target for 14 days after it (D6). Python recomputes fingerprints and receipt ids with its own code, so a stored hash TS writes inside that window must be one Python would also compute.
- `external` Historical approvals are invalidated by exact stored hashes (AGENTS.md). Old rows must stay verifiable for as long as they are kept.
- `inherited` A digest snapshot is immutable and complete evidence of what was sent (AGENTS.md). Still holds: it is a product rule, independent of the stack.
- `inherited` D4's purpose: known listings are neither re-collected as new nor re-notified. Still holds as a product requirement. Its chosen means, byte-identical hashing forever, was our own earlier choice and does not bind this decision.
- `inherited` Shadow acceptance by byte-identical rows. Our own tool; it does not bind this decision.
- `inherited` Neon's paid plan (D13-C) was rejected on 2026-10-24 because it leaves the 8 MB-per-request latency. Still holds.

## Options Considered

**Which candidates were already notified**
- **Baseline: a delivery ledger.** Notification systems keep a per-recipient record of each notified (item, version) under a unique index, written in the same transaction as the outbox row, and select with an anti-join ([Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html), [Idempotent Consumer](https://microservices.io/patterns/communication-style/idempotent-consumer.html)). The message stays the audit record, and the ledger is a projection that can be rebuilt from it ([Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)).
- **A. Re-derive "seen" from all prior snapshots** on every digest (current). There is no second structure, but cost and transfer grow with history.
- **B. Consider only the last N days.** Cost is bounded, but a job notified N+1 days ago is mailed again.

**How derived discovery data is read**
- **Baseline: one projection written at change time** ([Fowler, CQRS](https://martinfowler.com/bliki/CQRS.html)).
- **C. Two paths:** narrow stored inputs for the UI, and the full-table `listIn` kept for the digest until the rollback window ends.
- **D. The full table plus a cache.** Every feedback invalidates it, and serverless instances do not share memory.

**How faithfully the port follows Python**
- **Baseline: a native implementation, verified by tests and by shadow diffs whose differences are reviewed** ([Strangler Fig](https://martinfowler.com/bliki/StranglerFigApplication.html), [GitHub Scientist](https://github.com/github/scientist)). Stored identifiers and hashes change only through a versioned migration ([Parallel Change](https://martinfowler.com/bliki/ParallelChange.html)).
- **E. Copy Python until the rollback window ends, then clean up** (previous plan).
- **F. Freeze every hash-feeding behaviour permanently** and go native only elsewhere.

## Decision

- **L1 — Delivery ledger.**
  - Table `digest_novelty(digest_id, key, fingerprint)`. It is written in the same transaction as the snapshot, derived from exactly that snapshot's items, and never updated.
  - Selection joins it with `digest_outbox.status in ('sent','attempted','unknown')`. A pending digest still suppresses nothing, and status keeps a single source.
  - Existing snapshots are backfilled by the same derivation. The 483 items without stored keys go through the ported `novelty()`, after the keys are shown equal to Python's on the production copy.
  - Converge, replay and the reverse script treat the table as derived and rebuild it rather than copy it.
  - A rebuild-and-compare check outlives the replay.
- **R1 — One projection for both the UI and the digest**, replacing full-table `listIn`. The earlier D13 UI-only path is not built.
  - Stored when a listing changes: content-derived values (identity keys, keyword category, the fields evaluation reads) and group membership.
  - Re-projected on a settings change, by settings revision.
  - Clock-dependent values (deadline expiry, freshness, rank) are computed at read time.
  - Grouping becomes independent of input order, so membership can be maintained incrementally from the identity-key index.
- **N1 — Native port; Python's outputs need not be reproduced.**
  - Modules are rewritten natively, judged by the product rules and their tests.
  - Shadow and replay differences are listed and accepted as the plan's completion definition already allows.
  - D4's purpose is kept by two guardrails:
    - Hashes (opportunity id, fingerprint, receipt id, novelty key, approval hash) carry an algorithm version. When a known listing differs only by version, it is re-baselined without a notification.
    - `external_id` stays stable, or ships with an old→new id map.
- **N2 — Stored hash algorithms change only after the rollback window ends.** The v1 functions (canonical JSON plus the hashes) stay, only to verify and compare rows written under v1.

## Rationale

- **L1 over A and B.** A spends transfer and time that grow with history against an external cap. B changes product behaviour to save bytes the ledger saves anyway.
  - L1's cost is a second representation of "what was sent". It is contained because the ledger is a pure function of the immutable snapshots and is rebuilt and compared.
  - Landing it before cutover lets the daily replay check it against Python while Python still exists.
- **R1 over C and D.** C keeps two algorithms for the same derived data, and they drift. D saves nothing on serverless.
  - The independent drafts preferred C, because evaluation depends on the clock and settings and grouping depends on rank order.
  - R1 answers those three causes directly: clock-dependent parts at read time, settings by revision, and order-independent grouping. Python's order dependence was itself a known nondeterminism (`PYTHONHASHSEED`, noted in `groupItems`).
  - R1's cost is projection maintenance on every write path and a re-projection when rules change.
- **N1 over E and F.** E spends the effort twice and caused the incident above.
  - F keeps most of `platform/py` forever, against the one-language goal.
  - N1's cost is that shadow differences are no longer classified automatically by byte inequality. Each needs a reviewed explanation, and the comparator gains normalizers.
- **N2.** Switching hashes inside the window would make a rollback treat every re-fetched listing as updated. Keeping v1 for verification preserves exact-revision approvals.

## Expected Outcome

- The digest's read of history scales with today's candidates. The build stays well under 60 s (`web/tests/scale.test.ts`).
- The UI and the digest read one projection, and no full-table recompute remains. The D13 budget is met at production scale.
- No known listing becomes a new card or a duplicate notification, at cutover or at a later algorithm change.
- After the window, Python emulation remains only in the v1 verification functions.

## Revocation Triggers

- Ledger selection differs from snapshot-scan selection on any replay day or rebuild check: return to A until the cause is known.
- Projection upkeep pushes a write path past Vercel's limits, or the projection drifts from a full recompute in tests: re-evaluate C.
- The first post-cutover run notifies unchanged listings: stop re-baselining and restore v1 writes.
- The rollback window is extended, or a rollback happens: N2 is extended with it.

## Followup

- Plan: add sub-step 10b2 (ledger) before 10c.
- Plan: add a projection step that replaces step 11's D13 item and step 14's `listIn` item.
- Plan: rewrite step 14's emulation list into "native now" and "after the window".
- AGENTS.md: replace "the Python rules are the spec for the TS port".
- On the VM, measure how many current listings would change `external_id` or fingerprint under native code before choosing each module's guardrail. Show the 483 fallback keys equal Python's before the backfill.

## Related

- Amends `docs/adr/2026-10-23-nextjs-vercel-full-stack-rewrite.md`: D0's shadow output parity and D4's permanent byte compatibility (now N2).
- Plan: `docs/plans/2026-10-23-nextjs-vercel-migration.md`, steps 10–14, D13.
- Source: the owner's decision on 2026-10-26, made after an option brief critiqued by an independent reviewer. Two independent ADR drafts were compared before writing.
