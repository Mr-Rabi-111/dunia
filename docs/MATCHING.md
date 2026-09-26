# The Dunia matching algorithm

Everything here is implemented in [`server/matchmaker.js`](../server/matchmaker.js) (pure logic, no networking) and
[`server/relations.js`](../server/relations.js) (blocks and cooldowns), and tested in
[`test/matchmaker.test.js`](../test/matchmaker.test.js).

## Goals

1. **Respect everyone's filters, in both directions.** A filter is a promise to the person who set it.
2. **Match fast.** Most people should be talking within a second, even with hundreds of thousands waiting.
3. **Match well.** Among valid partners, prefer people who can talk to each other (shared language) and have
   something in common (shared interests).
4. **Be fair.** Nobody waits forever because others keep "winning" the scoring.
5. **Scale.** Work per search must not grow with the number of people waiting.

## The inputs

Every person in the queue is an **entry**:

```js
{
  id, key,                        // socket id; stable device id (for blocks/cooldowns)
  gender: 'male' | 'female',
  country: 'IN',  continent: 'AS',
  languages: ['hi', 'en'],        // up to 3 spoken languages
  interests: ['music', 'anime'],  // up to 5 canonical interest ids
  filters: { gender: 'any'|'male'|'female', country: 'any'|'US'|…, language: 'any'|'ja'|… },
  enqueuedAt                      // when they started waiting
}
```

Interests are **canonical ids**, not free text, so a Spanish speaker's "Música" matches a Hindi speaker's "संगीत".

## Step 1: hard constraints (both directions)

Two people **A** and **B** can be paired only if **all** of these hold:

```
satisfies(B, A.filters)  and  satisfies(A, B.filters)  and  canPair(A, B)

satisfies(X, f) =  (f.gender  = any or X.gender  = f.gender)
               and (f.country = any or X.country = f.country)
               and (f.language = any or f.language ∈ X.languages)

canPair(A, B)   =  not blocked(A, B)  and  (not recentlyPaired(A, B) or someone has waited ≥ 30 s)
```

Examples:

| A (wants) | B (is / wants) | Match? | Why |
|---|---|---|---|
| man in India → women | woman in India → anyone | ✅ | both filters satisfied |
| man in India → women | man in India → anyone | ❌ | B is not a woman |
| anyone in India → anyone | person in US → **US only** | ❌ | A fails **B's** filter |
| woman in US → Japanese speakers | man in Japan speaking ja, en → anyone | ✅ | B speaks Japanese |
| A blocked B last week | — | ❌ | blocks are permanent (30 days) |
| A and B just skipped each other | both waited 5 s | ❌ | rematch cooldown (2 min) |
| same, but one has waited 31 s | — | ✅ | cooldown relaxes: meeting again beats waiting forever |

## Step 2: finding candidates without scanning everyone

A naive matcher scans every waiting person for every search. That's O(n) per search and fails in exactly the
situation random-chat platforms always have: **many men filtering for women**. If 50,000 of them are waiting, a
naive bounded scan (look at the first 400) sees only them, and two open-filter people behind them never find each
other. This is called *head-of-line blocking*.

Dunia avoids it with an **acceptance index**. Each waiting person is filed under a key describing who they are
*and who they accept*:

```
gender | genderFilter | countryFilter | languageFilter       e.g.  "male|female|any|any"
country | gender | genderFilter | countryFilter | languageFilter    (second copy, for country searches)
```

For a searcher S, the only buckets that can hold valid partners are:

```
for g  in (S.filters.gender = any ? [male, female] : [S.filters.gender])   ← people S wants
for fg in [any, S.gender]                                                  ← people who accept S's gender
for fc in [any, S.country]                                                 ← people who accept S's country
for fl in [any, …S.languages]                                              ← people who accept a language S speaks
```

That's at most 2 × 2 × 2 × 4 = 32 buckets. When S has a country filter, the country-keyed copy is used, so only
people *in* that country are read. When S has a language filter and the "people who speak it" index is smaller,
that index is read instead.

The result: **every person S reads already wants S back** on gender, country and language. The thousands of men who
only want women never appear in another man's search at all.

Buckets are insertion-ordered sets. The searcher reads them through a **k-way merge on `enqueuedAt`**, so candidates
come out oldest-first across all buckets, and stops after `scanLimit` (400) candidates. Work per search is therefore
bounded no matter how many people are waiting.

## Step 3: scoring the compatible candidates

Among compatible candidates, the highest score wins (ties go to whoever waited longest):

```
score(S, C) =  3 × min(sharedInterests, 3)
            +  4 × (S and C share a spoken language ? 1 : 0)
            +  1 × (same continent ? 1 : 0)                 ← lower latency, better video
            +  2 × log2(1 + C.waitSeconds / 10)             ← fairness ("aging")
            +  2 × (C has Premium ? 1 : 0)                  ← Premium: matched a little faster
```

**Premium and the gender filter.** Choosing Men or Women (`filters.gender ≠ any`) needs an active
Premium pass: the server answers `match:find` with `premium_required` otherwise, and when a pass
expires while someone is waiting, the server switches their gender filter back to `any` and re-queues
them. Premium never breaks mutuality: a Premium user still only meets people whose own filters
accept them. The +2 bonus is the same as 10 seconds of waiting, so it moves Premium users up the line
without letting anyone starve. See [MONETIZATION.md](MONETIZATION.md).

### Why the aging term matters

Without it, a person nobody shares a language with could lose to "better" newcomers indefinitely. The wait term grows
without limit, just slowly:

| C has waited | wait bonus | beats a newcomer who shares… |
|---|---|---|
| 0 s | 0 | — |
| 10 s | 2.0 | one interest (3)? no |
| 30 s | 4.0 | a language (4)? tie, and ties go to the older person |
| 70 s | 6.0 | a language + same continent (5) |
| 150 s | 8.0 | a language + an interest (7) |

So preferences shape the first half-minute, and after that, time waited wins.

### Worked example

S is a woman in India who speaks Hindi and English, likes Music, and filters for "anyone". Waiting, all compatible:

| Candidate | Shared interests | Shares language | Same continent | Waited | Score |
|---|---|---|---|---|---|
| Ravi (IN, hi) | Music (1) → 3 | yes → 4 | yes → 1 | 5 s → 1.2 | **9.2** ✅ |
| Tom (US, en) | 0 | yes (en) → 4 | no | 40 s → 4.6 | 8.6 |
| Kenji (JP, ja) | Music → 3 | no | yes → 1 | 20 s → 3.2 | 7.2 |

Ravi wins. If Tom had waited 70 s (bonus 6.0 → 10.0), Tom would win.

## Step 4: the sweep

Every 1.5 s, the server re-tries the 200 longest-waiting people with twice the scan limit. This pairs:

- people whose **rematch cooldown** has just relaxed (after 30 s of waiting),
- anything a bounded scan missed (for example a rare language filter behind many non-speakers).

## The whole thing in pseudocode

```
enqueue(S):
    remove S if already queued
    best = null
    for C in mergeOldestFirst(candidateBuckets(S)), at most scanLimit:
        if C ≠ S and satisfies(C, S) and satisfies(S, C) and canPair(S, C):
            if score(S, C) > score(S, best): best = C
    if best: remove best from queue; return pair(best, S)    // best waited longer → makes the WebRTC offer
    else:    insert S into every index; return "searching"

every 1.5 s:
    for S in 200 oldest waiting:
        C = findFor(S, 2 × scanLimit)
        if C: pair(S, C)
```

## After a match

- The person who **waited longer creates the WebRTC offer**, so there is never "offer glare".
- Each side receives only public profile data: name, gender, country, languages, the "location verified" flag and
  shared interests. Never device ids or IP addresses.
- The pair is noted for the **rematch cooldown** (2 minutes; 0 in development so you can test with two tabs).
- A **report** or **block** adds a 30-day block in both directions.

## User-facing helpers

- **"People online who match: N"** counts connected people satisfying *your* filters (cached 3 s per filter set).
- **"It's quiet… Search everywhere"** appears after 20 s of a filtered search; it re-queues with all filters off
  for the rest of that session.
- The **country picker** shows live counts per country (cached 5 s) and lists the busiest countries first.

## Complexity and measured performance

| Operation | Cost |
|---|---|
| Enqueue / search | O(scanLimit × log-free merge of ≤ 32 buckets) → effectively constant |
| Remove (skip, disconnect) | O(1) per index (≤ 5 sets) |
| Sweep | O(200 × 2 × scanLimit) every 1.5 s, worst case |
| Memory | one entry + ≤ 5 set memberships per waiting person |

Benchmarked (`npm run bench`) on a realistic population (70% men, 45% of them filtering for women, 10% country
filters, 5% language filters), on one core of a 2-vCPU cloud machine:

- **28,490 searches per second**, median 6 µs, p99 0.19 ms, 200,000 arrivals, 98,213 pairs formed
- With **100,000 men-filtering-for-women already waiting**, 2,000 open-filter arrivals still paired instantly (p99 33 µs)

For scale: if the average person presses Next every 30 seconds, one core of matchmaking serves roughly
**850,000 people online**. Matching is not the bottleneck; WebSocket connections are (see ARCHITECTURE.md).

## Tuning knobs

| Env var | Default | Effect |
|---|---|---|
| `MATCH_SCAN_LIMIT` | 400 | Candidates read per search. Higher = better scores, more CPU |
| `MATCH_SWEEP_MS` | 1500 | How often the sweep runs |
| `REMATCH_COOLDOWN_SEC` | 120 (prod), 0 (dev) | How long two people are kept apart after meeting |
| weights (code) | 3 / 4 / 1 / 2 | `new Matchmaker({ weights: { interest, language, region, wait } })` |

## Ideas for later

- **Reputation-aware matching**: people with no reports and long average calls get matched with each other first;
  frequently reported people wait longer (a shadow queue). This is the single most effective quality lever on
  random-chat platforms.
- **Preference learning**: raise the language or region weight per market from call-length data.
- **Geo-latency**: replace "same continent" with measured RTT between regions.
