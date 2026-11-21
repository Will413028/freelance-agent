# Step 1: opportunity source fields

Measured 2026-11-21 from the development machine, plain tier (`curl -sL` with a desktop browser User-Agent). Field names, presence and counts only; no page content is kept. Pages were read into a temporary directory outside the repo and deleted afterwards. Marks: **present** (seen in the response), **absent** (not in the response), **unknown** (not measured).

Browser-tier sources (Kaggle, 獎金獵人) were read on the VM through the existing `browser` service (Will authorized 2026-11-21): `docker compose … --profile jobs up -d --wait browser`, then `POST http://localhost:3100/render {url, timeoutMs, waitFor}` from inside the container; pages saved to a 0700 temp dir on the VM, analysed there printing only field names and counts, then the dir and the container were removed. robots.txt and terms were read from the development machine with `curl -sL`.

## Summary

| Source | Tier | Usable | Reason |
|---|---|---|---|
| Devpost | plain (JSON API) | yes (Will 2026-11-21) | terms forbid automated access; kept by Will's decision 2026-11-21 (robots.txt allows, public JSON, one read a day) |
| MLContests | plain (HTML, embedded JSON) | yes | structured list, no prohibiting clause found |
| Superteam Earn | plain (JSON API) | yes (bounties) | terms page not found (unknown) |
| airdrops.io | plain (RSS) | no | the RSS feed carries blog posts, not airdrop listings (airdrops deferred, D4) |
| CoinMarketCap Airdrop | plain (HTML) | no | listings are loaded client-side, not in the HTML; terms forbid automated access (airdrops deferred, D4) |
| Kaggle | browser | list only | list renders with `waitFor`; detail pages failed 2 of 3 (`LayoutMissing`); MLContests carries Kaggle slugs with absolute deadlines (D7) |
| 獎金獵人 | browser | yes | list and detail render without `waitFor`; detail has period, TWD prize, eligibility |

## Devpost

Command: `curl -sL "https://devpost.com/api/hackathons?status[]=open&page=1"`; page 7 via `&page=7`; terms via `curl -sL https://info.devpost.com/terms` searched for `scrap|crawl|robot|spider`.

| Field | Mark | Notes |
|---|---|---|
| id | present | `id` (integer) |
| title | present | `title` |
| organiser | present | `organization_name` |
| URL | present | `url` (per-hackathon subdomain) |
| deadline | present, text only | `submission_period_dates` (e.g. `Mon DD - Mon DD, YYYY`, no time or time zone; of the 27 read in step 5a: 15 `Mon DD - Mon DD, YYYY`, 7 `Mon DD - DD, YYYY`, 5 `Mon DD, YYYY - Mon DD, YYYY`), `time_left_to_submission` (relative text). No registration deadline field. No ISO date in the list. |
| prize | present, HTML string | `prize_amount` (`$<span data-currency-value>N</span>`, USD shown; prefixes of the 27 read in step 5a: `$` 24, `€` 2, `$CAD ` 1), `prizes_counts` `{cash, other}` |
| eligibility: region / age / student | absent | not in the list response |
| eligibility: invite-only | present | `invite_only` (bool), `eligibility_requirement_invite_only_description` |
| online/offline | present | `displayed_location.location` (all 9 on page 1 were `Online`); `displayed_location.icon`: `globe` on 22 and `map-marker-alt` on 5 of the 27 read on pages 1, 2 and 7 (step 5a, same command) |
| open/ended | present | `open_state`, `winners_announced` |
| pagination | present | `page=N`, 9 per page (`meta.per_page`) |
| total count | present | `meta.total_count` = 62 open |
| robots.txt | allows `*` | `Disallow:` empty for `*` |
| terms | **forbid** (kept: Will 2026-11-21) | clause: users may not use "automated software, devices, scripts robots … to access, 'scrape,' 'crawl' or 'spider' the Site" |

## MLContests

Command: `curl -sL https://mlcontests.com/`; the list is a JSON array in the `data-competitions` attribute (HTML-entity escaped). Terms: `curl -sL https://mlcontests.com/terms/` (no `scrap|crawl|robot|automated` clause found).

| Field | Mark | Notes |
|---|---|---|
| id | absent | no id field; `url` (with `?ref=mlcontests`) is the only stable key |
| title | present | `name` |
| organiser | present | `platform` (Kaggle 119, Zindi 68, Independent 44, Codabench 36, …), `sponsor` (nullable) |
| URL | present | `url`, `additional-urls` |
| deadline | present | `deadline` (`D Mon YYYY` / `DD Mon YYYY`, date only, no time zone; 1 of 413 is a range), `registration-deadline` (null in 109 of 413), `launched`, `added` |
| prize | present | `prize` (`$N,NNN` string, USD; null in 42 of 413), `additional-prizes` |
| eligibility (region, age, student, invite-only) | absent | only free-text `note` |
| online/offline | absent | all are online ML competitions (inferred) |
| open/ended | absent as a field | derived from `deadline`: 16 of 413 have `deadline` ≥ 2026-11-21 |
| pagination | none | one page holds all 413 (current and past) |
| total count | 413 | array length |
| robots.txt | absent | 404 |
| terms | no prohibiting clause found | |
| **D7: Kaggle ids** | **present** | 119 entries with `platform` Kaggle; 118 carry a `kaggle.com/competitions/<slug>` URL (108 in `url`, the rest in `additional-urls`); 8 of the 16 open entries are Kaggle |

## Superteam Earn

Command: `curl -sL "https://earn.superteam.fun/api/listings?take=100"`; detail: `curl -sL https://earn.superteam.fun/api/listings/details/<slug>`. The `type=` and `take=` query values did not change the answer (always 12 rows, all `bounty`).

| Field | Mark | Notes |
|---|---|---|
| id | present | `id` (UUID), `slug` |
| title | present | `title` |
| organiser | present | `sponsor.name` |
| URL | derived | from `slug` (no URL field) |
| deadline | present | `deadline` (ISO 8601 UTC); single deadline, no registration deadline |
| prize | present | `rewardAmount` (number), `token` (USDC 7, USDG 2, NOS 2, other 1 of 12), `compensationType` (`fixed` in all 12); detail `rewards` per place |
| eligibility: region | detail only | `region` in the detail response (e.g. `Global`), absent from the list |
| eligibility: age / student | absent | detail `eligibility` holds submission questions, not eligibility rules |
| eligibility: invite-only | detail only | `isPrivate` |
| online/offline | absent | online by nature (inferred) |
| open/ended | present | `status` (`OPEN`), `isWinnersAnnounced` |
| pagination | unknown | list returns 12 regardless of `take` |
| total count | absent | |
| robots.txt | allows `/` | disallows dashboard and auth paths only |
| terms | unknown | `/terms-of-use` returns 404 |

## airdrops.io

Command: `curl -sL https://airdrops.io/feed/`. The 10 items all carry category `Blog`: the feed is the blog, not the airdrop list. Item fields: `title`, `link`, `guid` (`?p=N`), `pubDate`, `category`, `content:encoded`. No airdrop fields (deadline, reward, eligibility) as structured data. robots.txt allows `*` except admin, `/visit/`, `/search/`. Terms: `/terms-of-use/` 404 (unknown). Every other field: absent.

## CoinMarketCap Airdrop

Command: `curl -sL https://coinmarketcap.com/airdrop/`. `__NEXT_DATA__` holds only translations and global metrics (`pageProps` keys: `namespacesRequired`, `reqLang`, `globalMetrics`, `pageSharedData`, `pageSize`, `noindex`); no `/currencies/*/airdrop` link in the HTML. Listing fields: absent at plain tier. robots.txt allows `/airdrop/`. Terms: forbid "data mining, crawling, 'scraping', robot or similar automated … extraction".

## Kaggle

Commands: render `https://www.kaggle.com/competitions` with `waitFor: 'a[href^="/competitions/"]'` (without `waitFor` the response is a 25 KB shell with no listings); detail `https://www.kaggle.com/competitions/<slug>` with `waitFor: 'a[href$="/leaderboard"]'` (1 of 3 attempts rendered: a Getting Started competition; `waitFor: 'h1'` and the second Featured slug returned 422 `LayoutMissing`).

| Field | Mark | Notes |
|---|---|---|
| id | present | slug in `href="/competitions/<slug>"` (34 distinct on the list page) |
| title | present | card text |
| organiser | detail only | `Host` section on the rendered detail |
| URL | derived | `https://www.kaggle.com/competitions/<slug>` |
| deadline | relative only | list shows `N days/months to go` (22 cards); no absolute date or time zone in the rendered list or the one rendered detail; absolute deadline: unknown |
| prize | present | `$N,NNN` text on cards (USD); non-cash shown as `Knowledge`, `Swag`, `Kudos` |
| category | present | `Featured`, `Research`, `Playground`, `Getting Started`, `Community` labels |
| eligibility (region, age, student, invite-only) | unknown | detail page not rendered for a prize competition |
| online/offline | absent | online by nature (inferred) |
| open/ended | partial | `to go` vs `ago`; `Ongoing` for Getting Started |
| pagination | unknown | one rendered page; infinite scroll not measured |
| total count | unknown | |
| robots.txt | unknown | `curl` returned 200 but no `User-agent`/`Disallow` lines (likely an app shell) |
| terms | unknown | `/terms` is a JavaScript shell without the terms text |

## 獎金獵人 (bhuntr)

Commands: render `https://bhuntr.com/tw/competitions` and one detail `https://bhuntr.com/tw/competitions/<id>`, no `waitFor` needed.

| Field | Mark | Notes |
|---|---|---|
| id | present | `/tw/competitions/<id>` (lowercase alphanumeric, 18 chars; 26 distinct on the list page) |
| title | present | card and detail heading |
| organiser | detail only | `主辦單位`, `協辦單位` |
| URL | present | detail href |
| deadline | detail | `徵件期間 YYYY-MM-DD HH:MM 至 YYYY-MM-DD HH:MM`; the list shows `N 天` left and a `截止` badge. **Time zone: rendered in the browser's zone** (the container is UTC: an end time of `15:59` is 23:59 Asia/Taipei), so the connector must fix the zone or read a zone-free source; registration vs submission: one period (`徵件期間`), no separate registration deadline seen |
| prize | present | list `總獎金` (`N 萬` and full number), detail `N TWD`; per-place amounts in the description |
| eligibility: student | present | `參加資格 / 身分限制` (education levels, e.g. 大學, 碩士 (一般生)) |
| eligibility: region | present | `國籍/地區限制` (e.g. `不限`) |
| eligibility: age / invite-only | absent | not as fields (free text only) |
| online/offline | absent | not as a field |
| open/ended | present | state tag (e.g. `投稿中`) |
| other | present | `刊登時間`, `最後更新`, category tags, schema.org JSON-LD (`@graph`) |
| pagination | unknown | one list page read |
| total count | unknown | |
| robots.txt | allows `*` | disallows archives, `/*/user/`, `/*/portal/`, reset pages only |
| terms | no prohibiting clause found | `/tw/terms` served 7.5 KB of text, no `爬蟲|自動化|scrap|crawl|robot` match (may be partial) |
