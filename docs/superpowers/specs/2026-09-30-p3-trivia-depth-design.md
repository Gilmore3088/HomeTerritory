# Phase 3 (Trivia Depth) — Design: the question factory

Date: 2026-09-30. Status: DESIGN — approved direction, implementation plan in
`docs/superpowers/plans/2026-09-30-p3-trivia-depth.md`.

## The north star, made falsifiable

"If a hundred people play this, a hundred people should have a hundred
different questions every single time." As requirements:

1. **No player ever sees a question twice** — not per season, per lifetime.
   A permanent per-user ledger, not the current 7-day window.
2. **No player ever sees a *near-duplicate*** — "Who plays at Lambeau Field?"
   and "Which NFL team's home is Lambeau Field?" are the same question in
   different clothes. Dedupe by question *family*, not question id.
3. **Two players fighting over the same state get different questions** —
   already true mechanically (each session picks fresh), but only meaningful
   when the per-state pool is deep enough that overlap is rare.
4. **The pool outruns consumption forever.** A 30-day season at full
   engagement burns ~40–60 questions per player. Eight players × consecutive
   seasons ≈ 3,000–5,000 questions/league/year. The pool must hold **100k+
   active questions at launch** (≥1,500 per state average, ≥500 minimum for
   the thinnest state) and **grow nightly** from fresh data.
5. **Every question is traceable.** Every generated question carries
   references to the fact rows it was compiled from, and every fact carries
   its source, retrieval date, and verification status. No LLM ever invents
   a fact; LLMs only phrase, review, and flag.
6. **Yesterday happened.** Facts ingest nightly, so "who scored the
   game-winner last night" class questions are possible within 24 hours.

The current 550-question hand-written bank cannot meet any of these. The fix
is not a bigger bank — it is a **question factory**: a facts warehouse fed by
public sports data, a template compiler that turns facts into verified
questions at scale, and a serving layer with lifetime no-repeat guarantees.

## Architecture: three layers

```
┌────────────────────────────────────────────────────────────────────┐
│ 1. FACTS WAREHOUSE  (schema `facts`, Supabase)                     │
│    nightly ETL from public sports data → typed, state-linked,      │
│    provenance-stamped fact rows                                    │
├────────────────────────────────────────────────────────────────────┤
│ 2. QUESTION COMPILER  (templates × facts → public.questions)       │
│    parameterized templates, deterministic answers + distractors,   │
│    alias synthesis, difficulty model, 4-gate validation            │
├────────────────────────────────────────────────────────────────────┤
│ 3. SERVING  (extends the existing picker)                          │
│    lifetime per-user ledger, family dedupe, freshness mix,         │
│    telemetry-driven retirement                                     │
└────────────────────────────────────────────────────────────────────┘
```

The game engine (claims, attacks, defenses, scoring) does not change. The
factory feeds the same `public.questions` table the picker already reads, so
every gameplay path, RLS rule, and answer-secrecy guarantee stays intact.

## Layer 1 — the facts warehouse

### Schema (`facts.*`, service-role only, never client-readable)

Entity tables, all carrying the provenance block
(`source text, source_key text, source_url text, retrieved_at timestamptz,
confidence text check (confidence in ('gold','cross_verified','single_source')),
as_of date`):

| Table | What it holds | Example row |
|---|---|---|
| `facts.athletes` | name, birth city/state/date, death date, positions, sports, career span, colleges, pro teams (jsonb career stops), hall_of_fame, jersey_numbers, nicknames | Walter Payton, b. Columbia MS 1954, Jackson State → Bears 1975-87, HOF 1993, "Sweetness" |
| `facts.teams` | franchise id, league, current + historical names/cities (relocation history as jsonb timeline), founded, colors, division | Winnipeg Jets → Phoenix Coyotes (1996) → Arizona Coyotes (2014) |
| `facts.venues` | name history, team tenants + years, city/state, lat/long, **elevation**, capacity, opened/closed/demolished, quirks | Lambeau Field, Green Bay WI, opened 1957, 81,441 |
| `facts.championships` | league, season/year, winner, loser, series score, MVP, venue of clincher | 1997 World Series: Marlins over Indians in 7 |
| `facts.awards` | award name, league, year, winner, team/college at the time | 1985 Heisman: Bo Jackson, Auburn |
| `facts.drafts` | league, year, round, overall pick, player, drafting team, college | 1998 NFL #1 Peyton Manning (Tennessee) → Colts, #2 Ryan Leaf (WSU) → Chargers |
| `facts.season_results` | team, season, W-L, finish, playoff result, notable (streaks, records) | 1972 Dolphins 14-0, won SB VII |
| `facts.leaders` | scope (career/season/game), league, stat, holder, value, year(s) | MLB career strikeouts: Nolan Ryan, 5,714 |
| `facts.events` | one-off notable moments: perfect games, miracle finishes, famous plays, Olympic moments — typed, dated, located | Music City Miracle, Jan 2000, Nashville |
| `facts.colleges` | school, state, nicknames, conference history, rivalry games + trophy names | Wyoming–Colorado State, "Border War", Bronze Boot |
| `facts.geo` | sports-relevant geography: venue elevations/coordinates (denormalized for compare queries), state counts of major teams, event host cities | Highest MLB park: Coors Field 5,200 ft |

**`facts.state_links(entity_type, entity_id, state char(2), link_kind, strength)`**
is the spine that ties everything to the map. `link_kind`:
`team_plays_in`, `born_in`, `raised_in`, `college_in`, `venue_in`,
`champion_from`, `drafted_out_of`, `event_hosted_in`, `hof_from`.
`strength` (primary/secondary) keeps "Bo Jackson → Alabama (Auburn)" primary
while "Bo Jackson → California (Raiders)" stays secondary, so questions feel
*of the state* the way the hand-written bank does.

**`facts.aliases(entity_type, entity_id, alias, alias_kind)`** — synthesized
from Wikidata `skos:altLabel`, nicknames, last names, city-only and
nickname-only team forms. This is what feeds `questions.aliases` so free-fill
answers stay forgiving without hand-writing alias lists.

**`facts.prominence(entity_type, entity_id, score, signals jsonb)`** — the
difficulty engine's input (below).

### Sources (verified live 2026-09-30)

Ordered by role. *Gold* = official/curated, a single gold source suffices;
everything else needs cross-verification or stays flagged `single_source`.

| Source | Access | Role | Notes |
|---|---|---|---|
| **Wikidata SPARQL** | free, CC0 | THE backbone: athletes (birthplace, teams, college, HOF), teams, venues (coords, elevation, capacity), championships, **aliases** | CC0 = zero licensing risk; batch SPARQL nightly |
| **MLB Stats API** (statsapi.mlb.com) | free, official | gold for MLB: teams, rosters, schedules, historical results | review MLB's terms for the app's posture (hobby use is the norm) |
| **NHL API** (api-web.nhle.com) | free, official | gold for NHL | |
| **nflverse** (GitHub releases) | free, open | gold for NFL: play-by-play 1999+, rosters, **draft picks**, schedules | bulk parquet/CSV, ingest as fixtures |
| **Lahman Database** | free download | gold for MLB history to 1871: every player, team, award, HOF vote | one-time seed + annual refresh |
| **Retrosheet** | free w/ attribution notice | MLB game logs, no-hitters, oddities | attribution string required in app |
| **CollegeFootballData API** | free w/ key | gold for CFB: games, teams, rankings, **recruiting**, talent | key is an owner action (free signup) |
| **ESPN site JSON API** | free, no key, *unofficial* | current-season scores/schedules/rosters, all four majors + college | cache aggressively, treat as replaceable; no ToS to rely on |
| **balldontlie** | free tier w/ key | NBA depth + multi-league current data (now 20+ leagues) | free tier is per-sport rate-limited |
| **TheSportsDB** | free tier; $9/mo premium | venues, artwork, cross-sport fills | crowd-sourced → never sole source for a fact |
| **Kaggle open datasets** | free | one-time seeds: NCAA tournament history, Olympic history 1896→, Stanley Cup 1918→, F1 | snapshot into fixtures |
| **Wikipedia pageviews API** | free | prominence signal only, never facts | |
| Sports Reference family | ToS prohibits scraping | **manual verification only** — never automated ingestion | |

Legal posture: pure facts are not copyrightable (Feist v. Rural), but API
terms of service still bind. Every automated source above is either open
data, officially free, or keyless-public; Sports Reference is explicitly
excluded from automation. The app ships a "Data sources" attribution page
(Retrosheet requires it; the others deserve it).

### Ingestion mechanics

- `etl/` directory of TypeScript scripts, one per source, each idempotent
  (upsert by `(source, source_key)`), rate-limited, and snapshotting raw
  responses to Supabase Storage for reproducibility.
- **Nightly GitHub Actions workflow** (`etl.yml`, cron) runs incremental
  sources (ESPN, MLB, NHL, balldontlie, CFBD deltas, Wikidata refresh) then
  triggers the compiler. Bulk historical sources (Lahman, nflverse dumps,
  Kaggle seeds) are one-time `etl/seed-*` scripts run manually per release.
- Entity resolution: a small resolver keyed on Wikidata QIDs where possible
  (most league APIs → names → QID match with birthdate/team disambiguation);
  unresolved entities land in a review queue rather than the warehouse.
- Cross-verification job: a fact reaches `cross_verified` when two
  independent sources agree on its value; conflicts land in the review
  queue with both values shown.

## Layer 2 — the question compiler

### Templates

`facts.question_templates` — a template is data, not code:

```
id, sport, link_type, format ('multiple_choice'|'free_fill'),
tier_base int, family_key_expr,           -- what makes two instances "the same question"
text_template,                            -- 'Which {league} team plays its home games at {venue}?'
answer_sql,                               -- parameterized SELECT over facts.* returning (params, answer_entity)
distractor_sql,                           -- same-class near-misses for MC options
constraints jsonb,                        -- min prominence, era range, states allowed, min pool size
enabled bool, created_at, retired_reason
```

The compiler job cross-joins each enabled template with its `answer_sql`
result set, renders text, pulls 1 or 3 distractors (`distractor_sql` with
plausibility ordering: same league → same division/era → same state), pulls
aliases from `facts.aliases`, computes tier (below), hashes
`family_key` = f(template.family_key_expr, entity ids), and upserts into
`public.questions` with new columns:

```
alter table public.questions add column template_id uuid,   -- null = hand-written
  add column fact_refs jsonb,        -- [{table, id, source}] provenance chain
  add column family_key text,        -- near-duplicate suppression
  add column prominence numeric;     -- serving weight input
create index on public.questions(territory_id, family_key) where active;
```

Idempotent by `(template_id, family_key)` — re-runs refresh, never duplicate.

### Template catalog v1 (~50 templates; the scale math)

Illustrative families and their instance counts, per current warehouse
scope (four majors + CFB/CBB + Olympic/other, ~1900→present):

| Family | Example | Instances |
|---|---|---|
| Award winners by year | "Who won the {award} in {year}?" | ~15 awards × 60–90 yrs ≈ **1,100** |
| Championship results | "Who did {champion} beat in the {year} {title}?" / "Who won...?" ×4 phrasings-as-families | 4 leagues × ~100 yrs × 3 ≈ **1,000** |
| Draft picks | "Which team took {player} at #{pick} overall in {year}?" (top-10 picks, prominence-gated) | 3 leagues × 60 yrs × 10 ≈ **1,800** |
| Venue tenants / names / cities | 3 families over ~450 current+historical venues | **1,300** |
| Birthplaces & hometowns | "{athlete} was born in which city/state?" prominence-gated | ~4,000 notable athletes ≈ **4,000** |
| College → pro | "Where did {athlete} play college ball?" | **3,000** |
| Career stops | "{athlete} won the {year} title with which team?" | **2,500** |
| Leaders & records | career/season stat leaders, per league per stat | **800** |
| Notable events | dated one-offs from `facts.events` | **1,500+, grows** |
| Franchise history | relocations, renames, expansion years, "first season" | **600** |
| Rivalries & trophies | name the trophy / name the opponent | **300** |
| Numbers | retired numbers, famous jersey numbers | **1,200** |
| Comparative/geo | "Which of these stadiums sits at the highest elevation?", "northernmost/oldest/largest of these four", "which came first" | combinatorial: effectively **unbounded** (capped per family per state) |
| Season results | "How did the {year} {team} season end?", undefeated/worst/streak seasons | **2,000** |
| Fresh (nightly) | "Who won last night's {matchup}?", weekly leaders | **~50/day in season** |

Conservative launch total: **≥60k unique (template, entity) families**, with
comparative templates able to top any thin state up to its 500 floor. Every
state's pool is monitored (`state × tier` coverage view); a state below
floor triggers compiler backfill from lower-prominence entities before it
ever triggers the picker's repeat fallback.

### Difficulty engine

`prominence(entity)` = weighted blend of Wikipedia pageviews (12-month
median), HOF membership, championships/awards count, career length, league
class (major pro > power college > other). Tier assignment at compile time:

- **Tier 1** (2-option MC): high-prominence entity + direct association
  (team↔venue, famous champion).
- **Tier 2** (4-option MC): medium prominence, or high prominence with an
  indirect association (draft year, opponent, city detail).
- **Tier 3** (free-fill): precise recall — names, trophies, "who exactly".

Compile-time tiers are a prior; the **live calibration loop** owns the
truth: the existing `attempt_count`/`correct_count` telemetry re-tiers via
`adaptive_tier` (already shipped), and a nightly job **retires** outliers
(t1 with <30% correct after 25 attempts, t3 with >95%, any question with
report ≥2 pending review) and flags their template if a pattern emerges.

### Validation gates (nothing reaches players unproven)

- **Gate A — lint** (compile time, hard fail): answer string not contained
  in question text; options distinct after normalization; exactly one option
  matches `answer_matches` (catches alias collisions between the answer and
  a distractor); free-fill answer survives its own alias round-trip; text
  length/encoding checks.
- **Gate B — provenance** (hard fail): every fact ref is `gold` or
  `cross_verified`; `single_source` facts compile only into a quarantine
  pool that is not served.
- **Gate C — adversarial LLM review** (advisory, batched): Claude reviews
  batches for ambiguity ("is another answer defensible?"), era traps
  (facts that changed: renamed venues, moved teams — must be time-anchored
  "in {year}" phrasing), and unnatural phrasing. Flags route to the review
  queue; nothing auto-publishes on LLM say-so and nothing auto-dies either.
  Est. cost: ~$10–25 per 10k questions with a small model — one-time-ish.
- **Gate D — canary serving**: newly compiled questions carry a low serving
  weight until 10 clean attempts league-wide; the existing 3-report
  quarantine now also increments a counter on the template and the fact, so
  systematic errors kill the *source* of bad questions, not one symptom.

**Reviewer UI** (finally closing that backlog item): a `/review` route,
gated to an `is_reviewer` flag (owner-set), showing the report queue, the
fact-conflict queue, and Gate C flags, with actions: edit aliases, retire
question, retire family, mark fact disputed, reactivate. All actions via
service-role RPCs mirroring `reactivate_question`.

## Layer 3 — serving with lifetime guarantees

- **`public.user_question_history(user_id, question_id, family_key,
  served_at)`** — permanent, cross-season, written by `pick_next_question`
  alongside the existing per-season table (which stays for the in-season
  7-day window and streak logic).
- Picker exclusion order: (1) same `family_key` ever seen by this user —
  the near-duplicate guarantee; (2) same question id ever; (3) existing
  in-season/in-streak rules. Fallback ladder unchanged in spirit but now
  logged: any fallback past level 1 emits a `pool_thin` event so the
  compiler backfills that state before players ever notice.
- **Serving mix** per pick: weighted by league sport preferences (exists),
  tier match (exists), then novelty — 70% deep-catalog, 20% recent-decade,
  10% fresh (last-30-days facts) when available, so the game feels alive
  in-season without becoming a news quiz.
- Scale check: 100k questions, 8-player league consuming 5k/year, lifetime
  ledger per user — a player exhausts their *personal* pool only after ~20
  years at the floor state, and the pool grows nightly. Requirement 1 holds.

## PvP depth (the "robust game with friends" half)

Engine mechanics stay server-authoritative; these are additive modes:

1. **Live duels.** When attacker and defender are both online at resolution
   time, the defense becomes a head-to-head: same question pushed to both
   over Realtime, first correct answer wins the state (server timestamps,
   already-authoritative grading). Async play remains the default path —
   duels are an upgrade when presence overlaps, shown with a "⚔ live"
   banner. Presence via Supabase Realtime presence channels (in stack).
2. **Defender's choice.** A defender picks the sport of their defense
   question from the league's sport set — strategy (defend with your best
   subject) and a natural difficulty dial.
3. **Wager attacks.** Spend 2 actions: attack asks tier-3 free-fill only,
   but a successful defense doesn't raise the defender's garrison. High
   risk, high respect.
4. **Daily gauntlet.** One shared 5-question set per league per day, same
   for everyone (the one deliberate exception to uniqueness — it exists to
   be argued about in the group chat), drawn heavily from fresh facts;
   bonus points, separate leaderboard line. This is where nightly ingestion
   becomes *visible* fun.
5. **Rivalry ledger.** `pvp_ledger(user_a, user_b, wins_a, wins_b, ...)`
   lifetime across seasons: head-to-head attack/defense records surfaced on
   standings and season recaps ("You are 7–3 lifetime against Dana").
6. **Season awards** in the recap: Best Defender, Sharpest Sport (accuracy
   by sport), Fastest Gun (median answer time), Upset of the Season
   (lowest-probability successful attack).
7. **Fair-play instrumentation.** Store time-to-answer per attempt
   (column exists via timestamps): median-time outliers on t3 free-fill
   flag for the reviewer; MC timers tighten at high tiers; duels are
   inherently lookup-proof (speed wins).

## What stays true

- The browser still never sees an answer before grading. Facts and
  templates live in a schema clients cannot read.
- Reports still refund and quarantine; they just got a supply chain behind
  them.
- The hand-written `starter_seed_v2` bank stays active until every state
  clears the 500-question generated floor, then retires with honor
  (deactivated, kept as history — same pattern as v1).

## Owner actions this plan needs

- Free API keys: CollegeFootballData, balldontlie (both 2-minute signups) →
  GitHub Actions secrets + Supabase function env.
- An Anthropic API key + small budget for Gate C review batches.
- Optional: TheSportsDB premium ($9/mo) if artwork/venue depth proves worth it.
- A one-time read of MLB's stats API terms to confirm comfort for this
  app's posture; a "Data sources" page ships regardless.
- Decide reviewer(s): who gets the `is_reviewer` flag besides you.
