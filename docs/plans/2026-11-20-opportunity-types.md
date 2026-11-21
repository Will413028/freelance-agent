# Opportunity types: generalize listings, then add contests, hackathons, bounties and airdrops

**Goal：** `listings` holds several opportunity types (job, contest, bounty, airdrop; hackathon per D5) in one table with an `opportunity_type` discriminator, per-type CHECK constraints and one evaluator per type. Jobs behave exactly as before. Contests are collected daily from the sources that pass step 1 and appear on their own tab with save/skip. Verified by the closing step's checklist (step 8).

**上層：** 暫代（主清單在 repo 外，見本機個人脈絡檔）。

**附件：** `docs/plans/2026-11-20-opportunity-types/`（step 1 writes `sources.md`: field inventory only, no page content）. Snapshot commit: `d1edd2c`.

## 全域約束與完成定義（暫代主計畫）

- Read only public pages that need no login; access challenges are handled only with the tier the source configuration allows (plain, browser-like, browser). No login, no CAPTCHA solving, no IP rotation (AGENTS.md).
- No system sends mail (self-hosted rebuild plan D22).
- Airdrops are links only: no wallet connection, no signing, nothing executed from a listing.
- Unknown deadline, prize, location eligibility and hours stay unknown (null). Online never means worldwide.
- No merging across sources (self-hosted rebuild D18).
- Every migration lets the previous image run (`deploy/check-migrations.mjs`): add first, constrain or remove in a later deploy, with a `-- contract:` line naming the deploy since which no image breaks it.
- Every production deploy needs Will's authorization at that moment.
- 完成定義（each step that changes behaviour）：`pnpm check` and `pnpm build` green from `web/`; CI green including the Postgres re-run; the mutations named in the step's acceptance fail as expected (run in a copy, never edit-and-restore); `/code-review` run; `docs/design.md` and `docs/implementation-plan.md` updated in the same PR.

## 前提（開工時核對過，2026-11-20）

- 會改到的既有部署在線：the VM runs `d1edd2c` (`/opt/side-income`, compose project `side-income`, daily timer 09:00/11:00) with production Postgres data. Rollback for a deploying step: `deploy/deploy.sh` restores the previous image on failure, or the previous sha is redeployed; the schema is never rolled back, so each migration keeps the previous image working (compatibility window = one deploy). Data migration: existing rows get `opportunity_type = 'job'` through the column default; their stored `raw` has no discriminator and must stay parseable (step 2). A rolled-back image ignores rows of types it does not know: it reads, ranks and re-evaluates only its own types (steps 2 and 5 test this).（來源：local context file, `deploy/README.md`, `deploy/check-migrations.mjs`, 2026-11-20；已確認）
- Will approved the model direction (single table + discriminator + per-type evaluator, D1) on 2026-11-20 in conversation.（已確認）
- Source availability measured 2026-11-20 (plain tier from the development machine, browser tier on the VM through the existing `browser` service, Will authorized): readable at plain tier: Devpost JSON API, MLH, ETHGlobal, HackQuest, Taikai, dev.events RSS, MLContests, DrivenData, AIcrowd, CodaLab, Superteam Earn JSON API, airdrops.io RSS, CoinMarketCap Airdrop; readable only at browser tier: 獎金獵人 (bhuntr), Kaggle; unclear: Tianchi, Zindi, Signate (new URL unknown); blocked: AIdea, clist.by, DappRadar, CryptoRank, DoraHacks, AllHackathons, Gitcoin. "Readable" means status 200 with contest keywords present: inferred, not parsed.（field level 未確認; step 1 confirms）
- Kaggle's official API needs an account token: excluded by the no-login rule; its public page is readable at browser tier.（已確認，2026-11-20）
- Raw pages are not kept: step 1 fetches into a temporary directory outside the repo, records the field inventory in `sources.md` with the command that produced each entry, and deletes the pages; any page can be fetched again. Connector fixtures are synthetic cases shaped on the observed fields (the repo's existing convention, e.g. `modules/sources/himalayas/fixtures/cases.json` uses example companies), never captured pages; live format drift is caught by the daily run's per-source status.（Will 2026-11-21 asked for the industry practice; 已確認 by the existing fixtures）
- Toolchain: existing stack (TypeScript, Next.js, Drizzle, Postgres, zod contract, PGlite tests).（預設（可推翻））

**驗收基線：** `pnpm check` at `d1edd2c` on the development machine, 2026-11-20: vitest 677 passed, 1 skipped; deploy, browser and hook suites pass; exit 0. No known failures. CI on `dev` at `d1edd2c` green (PR #84 merged).

## 本階段依賴的不變量

| 不變量 | 依賴它的機制 |
|---|---|
| A listing's identity is `(source, external_id)`, unique | `listings_source_external_id` (`web/src/db/pg/schema.ts`), `modules/listings/intake.ts`, `modules/listings/id.ts` |
| Every stored `raw` stays parseable by the current contract | `modules/listings/reevaluate.ts` (`reevaluateStale`, `parseListingInput(raw)`), `modules/listings/contract.ts:65`, `intake.ts` (`parseListingInput(storable(value))`) |
| Rows whose `evaluated_with` differs from the current facts version are recomputed (D26 of the rebuild plan) | `reevaluate.ts` (`ne(evaluatedWith, FACTS_VERSION)`), `intake.ts` (writes `evaluatedWith`), `modules/evaluation/facts.ts` (`FACTS_VERSION`), `facts.test.ts` (version/digest pin) |
| Feedback and settings writes reject a stale token or revision | `modules/review/feedback.ts` (`setFeedback`), `modules/review/settings.ts` |
| Every migration lets the previous image run | `deploy/check-migrations.mjs`, `deploy/deploy.sh` rollback |
| Unknown stays null (tri-state facts) | `content()` in `schema.ts`, `modules/evaluation/facts.ts`, `evaluate.ts` |
| A list shows only its own type, on every branch of the shown filter | `modules/evaluation/list.ts` (`shownWhere`: listings, listing_versions and feedback branches), `listings_shown` index |
| One daily run per Asia/Taipei day; run records carry ids, counts, statuses only | `modules/runs/runs.ts`, `services/run-daily.ts`, `services/source-run.ts` |
| Business modules reach each other only through `public.ts` | `pnpm boundaries` |
| A connector's fixture beside its test is its ground truth | `web/src/modules/sources/*/` tests |

## 範圍

- 做：discriminator and per-type constraints on `listings` and `listing_versions`; `ListingInput` as a union on `opportunity_type`; catalog entries declare their type; evaluator and facts version per type; list query, ranking, pages and routes per type; contest type with its fields; first contest sources; bounty type (Superteam Earn); airdrop type subject to D4; settings per type subject to D6.
- 不做：merging duplicates across sources (D18); automatic registration or submission to contests; anything that touches a wallet; mail (D22); Kaggle API (needs a token); renaming `budget_*` (an amount range means the same for prizes; a rename costs two deploys for no behaviour).
- 延後：Zindi is no longer deferred (D13); Tianchi and Signate stay (trigger below); a Devpost read during which one hackathon closes and another is added passes as complete and marks the one never shown as gone for a day (step 5a review, round 2; the next read clears it; trigger: a Devpost listing whose `gone_at` was set and cleared within two days, or Will sees an open hackathon shown as closed: then count a listing as gone only after two complete reads in a row); the shared connector helpers `lastById` and `readDetails` take job listings only (trigger: step 6's 獎金獵人 needs list plus detail pages); `rankedPage` passes the job default settings to the contest ranker, which ignores them (trigger: D6's, a type needs a setting); `readRankables` reads every `listing_versions` row whatever its type (pre-existing; trigger: a list page measured over its 500 ms budget, or step 5's contest versions make the job page slower in the rank-scale test); settings per type (D6; trigger: a type needs a threshold setting); airdrop type (D4; trigger: Will asks again, with a source that reviews listings); Tianchi, Zindi, Signate (trigger: a later measurement shows parseable data at an allowed tier); blocked sources (trigger: the block lifts at an allowed tier); Class Table Inheritance (trigger: more than 5 types, or more than about 10 type-specific columns for one type).

## 步驟

- [x] **1. Spike: opportunity source fields**（被擋於：無）
  - 範圍：for Devpost, 獎金獵人, Kaggle, MLContests, Superteam Earn, airdrops.io and CoinMarketCap Airdrop, read one listing page at the source's lowest working tier and record per source: id field, title, organiser, URL, deadline fields (registration vs submission, format, time zone), prize or reward format (amount, currency, non-cash), eligibility fields (region, age, student, invite-only), online/offline, open/ended state, pagination, total count, robots.txt and terms on automated reading; whether MLContests lists Kaggle competitions with a Kaggle id (D7).
  - Files: new `docs/plans/2026-11-20-opportunity-types/sources.md` (field names, presence and counts only). Pages are read into a temporary directory outside the repo and deleted at the end of the step.
  - 消費端：無（no product code）。
  - 不能動：production; the VM except a browser-tier read through the existing `browser` service, removed afterwards.
  - 驗收：`sources.md` has every listed field for every source, each marked present/absent/unknown with the command that produced it.
  - 停止條件：a source's terms forbid automated reading → mark it excluded and report.
  - 需要人做的事：authorization for browser-tier reads on the VM (Kaggle, 獎金獵人).

- [x] **2. Generalize the model, jobs only (expand; no behaviour change)**（被擋於：無）
  - 範圍：
    - Migration (new `web/drizzle-pg/0002_*.sql`): add `opportunity_type text not null default 'job'` to `listings` and `listing_versions`; replace the `listings_shown` partial index with one on `(opportunity_type, id)` under the same predicate (plain `CREATE INDEX`, allowed by check-migrations).
    - Contract (`modules/listings/contract.ts`, modified): `ListingInput` becomes a zod discriminated union on `opportunity_type` (snake case like every contract field) with a single `job` variant carrying today's fields; a raw without the discriminator parses as `job` through the job variant's `.default("job")`, which zod 4's union applies to a missing discriminator (a separate preprocess was measured redundant and dropped), so every row stored before this step stays parseable. `fingerprint` (`modules/listings/id.ts`) leaves `opportunity_type` out: a source has one type, and stored fingerprints stay valid. Connector fixtures' expected contract outputs gain `opportunity_type: "job"` (re-baseline, no connector change).
    - Facts version (`modules/evaluation/facts.ts`, modified): `FACTS_VERSION` becomes `Record<OpportunityType, number>` with `job: 1` (unchanged digest); `reevaluate.ts` selects stale rows per type in both of its loops, `listings` and `listing_versions` (`opportunity_type = t and evaluated_with <> FACTS_VERSION[t]` for each type the image knows, so an older image never touches rows of a type it does not know); `intake.ts` writes the version of the row's type; `facts.test.ts` pins `job` at 1.
    - Evaluation (new `modules/evaluation/registry.ts`; `evaluate.ts`, `rank.ts` modified): `evaluatorFor(type)` with the job evaluator as the only entry; `rank.ts` ranks per type through the registry.
    - List (`modules/evaluation/list.ts`, modified): `shownWhere` filters by type on the first branch (so it reads `listings_shown`) and on the outer listing row, which covers the listing_versions and feedback branches.
    - Catalog (`modules/sources/catalog.ts`, `types.ts`, modified): each entry gains `opportunityType`; every existing entry is `job`.
    - Pages (`services/pages.ts`, `app/page.tsx`, modified): `rankedPage` takes the type; the home page passes `job`. `app/jobs/[id]` and its feedback route stay as they are.
    - Schema (`db/pg/schema.ts`, modified): `OPPORTUNITY_TYPES` constant and the column in `content()`'s owners.
  - 消費端：`rg -l "ListingInput|listingInputSchema|parseListingInput" web/src` (54 files at `d1edd2c`, 40 non-test); `rg -n "FACTS_VERSION|evaluatedWith" web/src`; `rg -n "shownWhere|listings_shown|readRankables|rankedPage|categoryScore|confirmedBase" web/src`; `rg -l "SOURCES|sourceSettings" web/src`.
  - 不能動：`(source, external_id)` identity; feedback and settings tables; every job's evaluation result (category, score, hard_excluded, confirmed_base) for every fixture; the job facts digest.
  - 驗收：`pnpm check`, `pnpm build`; `evaluate.fixtures.json` and `recommendation.fixtures.json` unchanged and passing; `node deploy/check-migrations.mjs` passes with no `-- contract:` line; new test: a `raw` captured in `d1edd2c`'s format goes through `reevaluateStale` with `unparsable = 0`; new test: a row of type `contest` (inserted directly; no contest code exists yet, and step 3's constraint already admits it) with a listing_versions row and a saved feedback row does not appear in the job list. Mutations: remove the discriminator's default → the old-raw test fails; fingerprint includes the type → the old-raw test fails; drop the outer type filter (keep only the first branch's) → the versions/feedback test fails; make the registry return a stub evaluator → evaluation fixture tests fail.
  - 停止條件：any job fixture's evaluation or the job digest changes.
  - 需要人做的事：deploy authorization (deploy A).
  - 完成後的狀態：deploy A must be live before step 3's constraint migration.

- [x] **3. Type constraints**（被擋於：步驟 2 deployed）
  - 範圍：migration (new `web/drizzle-pg/0003_*.sql`) adds `check (opportunity_type in ('job', 'contest'))` on both tables (contest admitted ahead: the previous image writes only `job`, and step 2's cross-type list test inserts `contest` rows), with `-- contract:` naming deploy A (since then every image writes the column or its default). Schema `typeCheck` helper in `db/pg/schema.ts` (modified) builds the value list from `ADMITTED_OPPORTUNITY_TYPES` (`OPPORTUNITY_TYPES` plus the types admitted ahead of their writer; kept apart because `OPPORTUNITY_TYPES` drives reevaluate and the registry, which have no contest entry yet), so later steps change data, not SQL by hand. Per-type column rules arrive with the first type that has one (step 5, deploy E).
  - 消費端：`rg -n "kindCheck|deadlineChecks|check\(" web/src/db/pg/schema.ts`.
  - 驗收：`pnpm db:check`; a test: `contest` is accepted and another type (`bounty`) is refused by Postgres on both tables. Mutation: drop the CHECK from the schema → that test fails.
  - 需要人做的事：deploy authorization (deploy B).

- [ ] **4. Settings per type**（被擋於：D6）
  - 範圍：if D6 = A, new table `type_settings (opportunity_type pk, revision, …)` (new migration), `modules/review/settings.ts` and `app/settings` (modified) read and write per type, the job row seeded from the singleton; the singleton is removed in a later contract migration (deferred). If D6 = B, this step is skipped and recorded as skipped in 進度.
  - 消費端：`rg -n "settings" web/src/modules/review web/src/app/settings web/src/services`.
  - 不能動：stale-revision rejection.
  - 驗收：review tests for stale revision pass per type. Mutation: remove the revision check from the per-type write → the stale settings test fails.
  - 需要人做的事：deploy authorization (deploy C).

- [ ] **5. Contest type with Devpost (walking skeleton of the new type)**（被擋於：D2, D3, D5；步驟 1, 3, and 4 done or skipped）
  - Split on 2026-11-21 into 5a, 5b and 5c, each with its own acceptance (a deploy and three natural daily runs do not fit one session): **5a** the code of deploy D and every acceptance that needs no deploy; **5b** deploy D on the VM (Will's authorization), two manual runs with the second adding no rows, three natural daily runs with Devpost `ok`; **5c** the deploy E migration (per-type column rules, and D10: the job-only facts become nullable and null on a contest row) once 5b is done, with its own deploy authorization.
  - Settled in 5a (implementation, within D2, D3, D5): the contest columns are `registration_deadline date`, `prize_text text`, `online boolean`, `invite_only boolean`, `hackathon boolean` (migration `0004_contest_columns.sql`); a contest is a candidate while its source has not closed it and still lists it (`gone_at` is null: a contest source lists what is open, so an ended one leaves the list), its submission deadline has not passed and it is not skipped; a date-only deadline expires at the end of that day in Asia/Taipei (rebuild plan D7), which can be hours after the organiser's own deadline (a zone east of Taipei, or a time of day before 16:00 UTC) or up to a day before it, and the detail page says so; the contest tab is `/?type=contest`; Devpost's read is a complete read only when it reached the empty page, every page stated the same total, no hackathon was shown twice and as many were read as that total; a bare `$` prize prefix is read as USD because Devpost writes other dollars with their code (`$CAD`), inferred from 27 hackathons read on 2026-11-21, and a prefix not listed leaves the amount unknown with the text kept.
  - 範圍：
    - Deploy D: new migration `web/drizzle-pg/000N_contest_columns.sql` adds the contest-only columns D5 decides (nullable; the type CHECK already admits `contest`). Modified: `modules/listings/contract.ts` adds the `contest` variant; new `modules/evaluation/contest.ts` evaluator registered in `registry.ts` (modified) (D2 ranking, D3 exclusion) with its own facts version in `facts.ts` (modified); Devpost connector (new `modules/sources/devpost/` with fixture and test) at plain tier, catalog entry `opportunityType: 'contest'`; contest tab on the home page (`app/page.tsx`, `services/pages.ts`, modified); `catalog.ts` (modified); contest detail and feedback reuse `app/jobs/[id]` (the route is keyed by listing id; rename to a type-neutral path is deferred, trigger: a second non-job type ships); `jobDetail` and `setFeedback` answer NotFound for a type the image does not know (step 2 review: a rolled-back image would render a contest with job rules); intake rejects a listing whose `opportunity_type` differs from its source's catalog `opportunityType` (step 2 review: `fingerprint` relies on one type per source); `ListingInput` becomes the union's output with a separate job-only input type for `listingOf` and the job evaluator.
    - Deploy E: new migration `web/drizzle-pg/000N_contest_rules.sql` adds the per-type column rules for contest columns (`-- contract:` names deploy D).
  - 消費端：step 2's commands plus `rg -n "opportunityType" web/src`.
  - 不能動：job evaluation and the job list.
  - 驗收：`pnpm check`, `pnpm build`; Devpost fixture test; incremental intake test (second read inserts no rows); a fixture case with unknown prize and eligibility stores null. New test: an image built without the contest variant (job-only registry) running `reevaluateStale` over a database holding contest rows reports `unparsable = 0` and leaves them untouched (rollback from deploy D). Mutations: map a missing prize to 0 → unknown-prize test fails; drop the type filter → a contest appears in the job list test; drop the per-type filter from reevaluate → the rollback test fails. After deploy D: two manual runs, the second adds no rows; three natural daily runs with Devpost `ok`.
  - 停止條件：step 1 shows Devpost has no stable id.
  - 需要人做的事：deploy authorization for deploys D and E.

- [ ] **6. Remaining contest sources**（被擋於：步驟 5）
  - Rewritten 2026-11-22 (D13): Zindi, DrivenData and CrunchDAO are added as direct sources, and the step is split into three sub-steps, each a session with its own acceptance and deploy. The same competition can then come from its platform and from MLContests; nothing is merged (D18).
  - Common to every sub-step: new `modules/sources/<name>/` each with a synthetic fixture and test; `catalog.ts` (modified) entries at the tier measured in `sources.md`; no migration. 驗收：per-connector fixture tests; an unknown prize, deadline or eligibility stores null; mutation per connector: change the id rule → fixture test fails. After deploy: two manual runs (second adds no rows), three natural daily runs `ok`. 需要人做的事：deploy authorization per sub-step.
  - **6a. MLContests and Zindi** (plain tier). MLContests: the list embedded in the page, `url` as the id (D7 = A). Zindi: the public JSON list of open competitions; `end_time` is an instant; `secret_code_required` or `is_access_restricted` stores `invite_only`; `kind: hackathon` stores the hackathon flag; a reward in points is not a prize amount.
  - **6b. DrivenData and CrunchDAO** (plain tier). DrivenData: the list page gives id, title and prize but no deadline or open state, so the connector first measures the detail page (deadline format and time zone, open or completed) and records it in `sources.md`; 停止條件：the deadline is not readable at plain tier → the source stores an unknown deadline and Will decides whether it is worth listing. CrunchDAO: the public JSON list; only `status: OPEN` and `visibility: PUBLIC`; `end` has no time zone, so it is stored as given and unusable (`no_timezone`) unless the API's documentation states the zone, and a continuous competition has no deadline.
  - **6c. 獎金獵人 and Kaggle** (browser tier), as measured in step 1.

- [ ] **7. Bounty and airdrop types**（被擋於：D4, D8；步驟 5 (needs the type pattern proven by a shipped non-job type)）
  - 範圍：`bounty` per D8 with Superteam Earn (plain JSON); `airdrop` per D4 (a source with listing review such as CoinMarketCap Airdrop, URL to the source's own page only). Each type: `contract.ts`, `registry.ts`, `facts.ts`, `catalog.ts`, `app/page.tsx`, `services/pages.ts` (modified); new evaluator file and `modules/sources/<name>/`; new migrations: one widening the type CHECK (drop and re-add, `-- contract:` naming the previous deploy, which writes only known types) plus type columns, one adding their column rules in the next deploy.
  - 驗收：connector fixture tests; evaluator tests per type. Mutations: break the bounty evaluator's ordering → its test fails; store an airdrop project's own URL → the test that an airdrop URL is on the source host fails.
  - 需要人做的事：deploy authorization per deploy.

- [ ] **8. 收尾**：完成定義逐項核對；獨立設計審查（design-review）; long-lived checks (type constraint tests, check-migrations) in CI; deferred items with triggers moved back to the master list; ADR for D1 (and other decisions with real alternatives) in the project's decisions location; things for Will listed. 驗收：checklist in the step's PR with each item's command or file.

## 決定

- **D1 How several opportunity types are stored**（狀態：已決 2026-11-20，Will；擋住步驟：無）
  - A：one table with a discriminator, per-type CHECK, per-type evaluator (Single Table Inheritance)——shared intake, feedback, versions, retention, runs; few type-specific columns per type.（建議）
  - B：core table plus one detail table per type (Class Table Inheritance)——right when types add many columns.
  - C：separate tables per type——duplicates intake and feedback.
  - 結論：A; move to B when the deferred trigger fires. ADR：written at step 8.
- **D2 How contests are ranked**（狀態：已決 2026-11-21，Will：A；擋住步驟：無）
  - A：sort by submission deadline ascending, unknown deadlines last, no score.（建議: no category fit to compute yet; adding a score later is reversible）
  - B：a score (prize size, deadline, themes vs Will's skills).
- **D3 Invite-only contests**（狀態：已決 2026-11-21，Will：C, show them (store `invite_only` when the source gives it)；擋住步驟：無）
  - A：store and mark hard-excluded (hidden by default, kept for the record).（建議）
  - B：the source's own rule drops them (`source_kept = false`).
  - C：show them.
- **D4 Airdrops**（狀態：已決 2026-11-21，Will：A, deferred; step 7 does bounties only；擋住步驟：無）
  - A：defer airdrops; step 7 does bounties only.（建議: high scam rate; even links can carry phishing）
  - B：CoinMarketCap Airdrop only, link to its own page.
- **D5 Contest fields**（狀態：已決 2026-11-21，Will：as recommended——`deadline_*` = submission deadline; contest columns: registration deadline, `prize_text`, `online`, `invite_only`; hackathon is a contest flag, not a type value；擋住步驟：無）
  - `deadline_*` holds the submission deadline (recommended; the deadline a contestant must meet).
  - Candidate contest-only columns: registration deadline, `prize_text`, `online`, `invite_only`; whether hackathon is a separate type value or a contest flag. Recommendation after step 1.
- **D6 Settings per type**（狀態：已決 2026-11-21，Will：B, step 4 skipped until a type needs settings；擋住步驟：無）
  - A：new table keyed by type (revision per type), job row seeded from the singleton.（建議 if D2 = B）
  - B：contests have no settings yet; step 4 is skipped until a type needs settings.（建議 if D2 = A）
- **D7 Kaggle directly, MLContests, or both**（狀態：已決 2026-11-21，Will：A, both, accepting duplicates (D18)；擋住步驟：無）
  - A：both, accepting duplicates (D18).
  - B：MLContests only, if it covers Kaggle with enough fields.
  - C：Kaggle only.
- **D8 Bounty type**（狀態：已決 2026-11-21，Will：as recommended——reward stored as amount plus token, sorted by deadline ascending like contests, shares the contests tab；擋住步驟：無）
  - Fields (reward amount and token, deadline, compensation type), ranking (deadline vs reward), its own tab or shared with contests. Recommendation after step 1.

- **D9 Sources whose terms forbid automated reading**（狀態：已決 2026-11-21，Will：keep Devpost despite its terms (robots.txt allows `*`, public JSON API, one read a day); step 1's stop condition no longer excludes it；擋住步驟：無）

- **D10 Job-only facts on rows of another type**（狀態：已決 2026-11-21，Will：as recommended, null by rule in step 5c；擋住步驟：5c）
  - A：step 5c makes `category`, `category_score` and `confirmed_base` nullable and its per-type rules require them null on a contest row and present on a job row; the contest evaluator then stores null (its facts version is bumped so stored contests are recomputed).（建議）
  - B：keep the neutral values `其他`/0/0 (a count by category cannot tell a job rated 其他 from a row that is not a job).
- **D13 Direct sources for Zindi, DrivenData and CrunchDAO**（狀態：已決 2026-11-22，Will：add all three to step 6；擋住步驟：無）
  - Measured 2026-11-22: of the 413 entries MLContests lists, 15 have a deadline from today on (Kaggle 8, Codabench 4, CrunchDAO 1, Zindi 1, Synapse 1, DrivenData 0), while Zindi's own list has 10 open and CrunchDAO's 2: the aggregator alone misses most of them. Codabench stays covered through MLContests only (not measured directly; trigger: Will asks, or a Codabench competition he finds is missing).
- **D11 A Devpost prize shown as `$0`**（狀態：已決 2026-11-21，Will：as recommended, stored as amount 0 with the text kept；擋住步驟：無）
  - The source states 0; a hackathon with only non-cash prizes then sorts last by amount if contests are ever sorted by prize.
- **D12 Date-only contest deadlines**（狀態：已決 2026-11-21，Will：keep the existing rule (rebuild plan D7): the end of that day in Asia/Taipei, with the page's note that the organiser's deadline can be hours earlier or later；擋住步驟：無）

拍板順序：all decided (D10 to D12 on 2026-11-21, D13 on 2026-11-22).

## 進度

狀態值：未開始／進行中／程式完成待驗收／完成。

| 步驟 | 狀態 | 已跑的驗收 | 未跑的驗收與原因 | commit |
|---|---|---|---|---|
| 1 Spike: source fields | 完成 | `sources.md` covers all 7 sources, every field marked with its command (2026-11-21; VM browser read authorized by Will, container and temp dir removed) | Kaggle absolute deadline and eligibility: detail page rendered 1 of 3 (`LayoutMissing`), left unknown | |
| 2 Generalize the model | 完成 | 2026-11-21: `pnpm check` exit 0 (vitest 680 passed, 1 skipped; check-migrations ok, no `-- contract:` line); `pnpm build` exit 0; job evaluate/recommendation fixtures and the facts digest unchanged; mutations in copies: discriminator default, type filter on the listing, stub registry, reevaluate type filter, fingerprint with type, all killed; CI green on PR #87 (web incl. Postgres re-run, image, secrets) ; deploy A 2026-11-21 (Will authorized): VM runs `16e36c9`, migration 0002 applied, 15,530 listings all `job`, 0 non-job versions, `listings_shown` on `(opportunity_type, id)`, web 200 ; 2026-11-21 read-only pass on the VM with image `16e36c9`: every stored raw through `parseListingInput`, listings 15,530 and listing_versions 59, unparsable 0 (replaces the natural-run check: `reevaluateStale` reads only rows whose `evaluated_with` differs, and the job version did not change, so that run would report 0 without reading any row) | | PR #87 |
| 3 Type constraints | 完成 | 2026-11-21: constraint test passes (17/17 in `listings.test.ts` alone); check-migrations ok with the `-- contract:` line; mutation in a copy (drop the CHECK from schema and migration) killed; CI green on PR #88 (web incl. Postgres re-run, image, secrets); review: findings 0 (blocking 0), first `/code-review` returned nothing, replacement reviewer NO DEFECTS; deploy B 2026-11-21 (Will authorized): VM runs `8de5a13`, migration 0003 applied, both CHECK constraints present, 15,530 listings all `job`, web 200; rollback target `16e36c9` | local full `pnpm check` hit PGlite hook timeouts under machine load (no assertion failures; CI is the gate) | PR #88 |
| 4 Settings per type | 跳過（D6 B） | | | |
| 5a Contest type: code of deploy D | 完成 | 2026-11-21 on the development machine: typecheck, `pnpm boundaries`, `pnpm db:check`, `check-migrations` (5 files, no `-- contract:` line needed: nullable adds only), `check-compose`, `pnpm build`, all exit 0; the contest, Devpost, catalog, evaluation and contest page tests pass (run file by file); job evaluate/recommendation fixtures and the job facts digest unchanged; 14 mutations in copies, all killed: missing prize as 0, both list type filters dropped, the outer one dropped, the reevaluate type filter dropped, intake accepting another type, collect not passing the source type, contest order reversed, an expired contest still a candidate, a gone contest still a candidate, the detail page and the feedback write accepting an unknown type, Devpost always complete, Devpost ignoring a changing total, a contest rule change without a version bump; review: `/code-review` high, a diff reviewer and a design reviewer, then one round on the fixes: findings 19 (blocking 0), fixed 11, recorded 3, raised 2, rejected 3; CI green on PR #89 (web incl. the full test run and the Postgres re-run, image, secrets, gate) | | PR #89 |
| 5b Deploy D and Devpost runs | 進行中 | deploy D 2026-11-21 (Will authorized): VM runs `936a26b`, rollback target `8de5a13`; migration 0004 applied (the 5 contest columns on both tables), web 200, `/?type=contest` 200; two manual Devpost runs: first `seen 66, rejected 0, truncated false, requests 9, inserted 66`, second `inserted 0, unchanged 66`; stored counts: 66 contests, 15,530 jobs unchanged; all 66 with a usable deadline, 0 invalid; amount read on 63 (USD 57, CAD 3, EUR 3; 32 of them a stated 0) and unknown on 3 with the text kept; online 53, in person 13, unknown 0; invite-only 6; the contest tab renders its first page of 50 | three natural daily runs with Devpost `ok` (2026-11-22 to 2026-11-24) | |
| 5c Contest column rules (deploy E) | 未開始 | | blocked on 5b | |
| 6a MLContests and Zindi | 未開始 | | | |
| 6b DrivenData and CrunchDAO | 未開始 | | | |
| 6c 獎金獵人 and Kaggle | 未開始 | | | |
| 7 Bounty and airdrop types | 未開始 | | | |
| 8 收尾 | 未開始 | | | |
