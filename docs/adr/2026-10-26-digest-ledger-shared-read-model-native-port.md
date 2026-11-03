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

## Amendment (2026-10-26, later the same day): no cross-source merge

R1's "store group membership; make grouping order-independent" is replaced. The single projection for the UI and the digest still holds.

**Context (measured 2026-10-26 on the shadow copy of production, one-off read-only script, counts only).** All 2,447 opportunities carry a URL identity key only; none has a content key (2,130 have no company, 285 no usable body, 32 a body under 80 characters). URL keys of different sources have different hosts, so cross-source merging could only come from content keys: no two rows share a key, and the grouping rule has never merged anything in Python or TS. Equal company and title appear in 16 sets, 1 of them across sources. Equal title alone appears in 55 sets, 7 of them across sources. Content versions: 6, on 3 opportunities.

**Options.**
- **Baseline: dedupe by the source's own id when sources barely overlap.** Single-user multi-site job scrapers key a listing by site and job id (inferred: python-jobspy). Entity resolution (blocking, connected components, survivorship) is for aggregators with heavy overlap (Splink, dedupe, Zingg).
- A1, the R1 text: keep "conflicting conditions stay separate" and maintain groups incrementally in id order. It needs a key index, closure recompute and group tokens, and merges nothing on today's data.
- A2: connected components plus survivorship now. It merges nothing under today's keys unless the match is loosened (for example to the title alone), which risks false merges.

**Decision (A3).**
- Each opportunity is its own one-member group. `members: [self]`, the member token, `observation_fingerprints`, `novelty_keys` and the content-version display (`display_basis`) keep their current shape and formulas. The DTO, the snapshot and Python's rollback rendering are therefore unchanged.
- Only the cross-source merge and its upkeep are removed.
- The projection (B1) is two derived tables: one row per opportunity and one per content version. Each holds content- and settings-derived values. Clock-dependent values are computed at read time.
- The tables are rebuilt by converge, replay and the reverse script.

**Rationale.** A1 and A2 pay upkeep on every write path for duplicates the data does not show. A3's output equals today's on production data. The cost: if cross-source duplicates appear, they show as separate cards until the trigger fires. A normalized `opportunities` schema (B2) would be the baseline for reads, but it waits for the D6 window. Python's rollback reads the SQLite-shaped table (external). The rework at that point is limited to the two projection tables.

**Re-add triggers.**
- The TS daily run counts cross-source pairs with an equal normalized title among the last 7 days' candidates. When the count reaches 3, a manual sample confirms true duplicates, and A2 is then added as a cluster id on the projection.
- A parser starts providing `company` widely, which revives content keys.

Source: the owner's decision on 2026-10-26, after two independent critiques of the option brief.

## Amendment (2026-11-03): the daily digest recomputes its candidates

Expected Outcome's "no full-table recompute remains" is narrowed to page requests. Will accepted it on 2026-11-03 (plan step 10e2).

**Context.** The sentence came from Neon's transfer budget (D13): reading every row on every list request would have passed 1 GB a month. Since D19 the data is on D1, which has no transfer charge. Its budget is 5 million rows read a day.

**Decision.** Page requests (`listPage`, at most 200 listings) read the projection's ranking and their own rows only. The daily digest (`digestCandidates`) ranks every listing in SQL, reads the whole table once, and recomputes its candidates in TS, about 97% of the rows. Each one is checked against the projection's score, so the TS rules stay the only authority. That is about 2,450 rows once a day, inside the daily read budget (inferred, not measured on D1's billing). A ledger pre-filter in SQL, assembling only the not-yet-announced candidates, was not built: it would add a second read path whose suppressed candidates are never checked.

**Revocation trigger.** Two conditions reopen this. One is the digest's step taking over 60 s in production (`workflow inspect`). The other is D1 rows read for the digest passing 10% of the daily free budget. Either one leads to the ledger pre-filter.

## Amendment (2026-11-03, later the same day): no digest

The ledger and everything else of the digest in this record are withdrawn. Will decided it on 2026-11-03 (plan D22): "不需要摘要，也不要寄送 email，我先只要有網頁前端可以看就好".

**Decision.** The TS app builds no digest and sends no mail. Plan step 10f removes the snapshot build, the novelty ledger (`digest_novelty`, dropped by migration `0004`), delivery, and the same-start replay. The one shared projection (R1) stays. It now serves only the web pages, and the previous amendment's digest recompute no longer applies. The Python production system stopped sending the same day (`live_send: false`). Its digests stay `pending`, and its historical `digest_outbox` rows are carried over unchanged. Native port (R3) and the hash guardrails (N2) are unchanged, except that novelty keys are no longer a TS hash point.

**Revocation trigger.** Will asks for a digest or notifications again. Restore from git history (plan steps 10b–10c, PR #5's `76cd816`), and decide the sending channel anew.

## Related

- Amends `docs/adr/2026-10-23-nextjs-vercel-full-stack-rewrite.md`: D0's shadow output parity and D4's permanent byte compatibility (now N2).
- Plan: `docs/plans/2026-10-23-nextjs-vercel-migration.md`, steps 10–14, D13.
- Source: the owner's decision on 2026-10-26, made after an option brief critiqued by an independent reviewer. Two independent ADR drafts were compared before writing.
