# Trust & Safety design

Random video chat puts strangers face to face with no history, so safety has to be designed in, not bolted on.
This document describes what the code does today, how moderators use it, and what a responsible launch still needs.

## Principles

1. **Leaving must be instant.** Next is one tap or `Esc`, everywhere, always.
2. **Reporting must be effortless and protect the reporter.** Two taps, and the reported person is never told.
3. **Evidence, not recordings.** Nothing is recorded by default. A report captures just enough (one still frame and
   recent messages) for a moderator to decide, and it expires.
4. **Collective signal over individual claims.** One angry user can't remove someone; several independent people can.
5. **Proportionate enforcement.** Restrictions escalate, IP measures are short and narrow, and humans can review and
   reverse.

## The safety toolkit in the product

| Feature | Where | Detail |
|---|---|---|
| 18+ gate | Onboarding step 3 | Explicit confirmation plus Community Guidelines link. (See "age assurance" below for what a checkbox can't do.) |
| Report | Call bar / partner card | 7 reasons: under 18, sexual, harassment, hate, violence, spam/scam, fake gender/country. Reporting also blocks. |
| Block | Call bar / report sheet | 30-day mutual block; the pair is never matched again. |
| Safe view | Settings | Blurs each new partner's video until the user taps it. |
| Contact-sharing masking | Server, every message | URLs, e-mails, phone numbers and @handles become `•••`. Stops the #1 route to scams, sextortion and grooming: moving the conversation off-platform. `BLOCK_CONTACT_SHARING=false` disables it. |
| Blocked words | `data/blocked-words.txt` | Whole-word, case-insensitive, any script. Masks in chat, rejects usernames. Ship per-market lists. |
| Username rules | Server | 2–20 Unicode letters/digits; no staff-like names (admin, moderator, support…); no phone-number names. |
| Bidi and control stripping | Server | Removes characters used to disguise text. |
| Rate limits | Server, per event | Chat 20/10 s, reactions 15/10 s, searches 30/10 s, reports 10/hour (extra reports are silently not counted). |

## Reports and automatic restriction

When someone is reported the server stores:

- **Metadata** (persisted): time, reason, reporter (device, IP, name, country), reported person (device, IP, name,
  declared gender and country, **country detected from their connection**).
- **Evidence** (memory only, 48 h, max 300 reports): a 360-px JPEG of the reported person's video at that moment
  and the last 15 messages they sent in that conversation.

### The score

```
score(person) = Σ over DISTINCT reporters in the last 24 h of the highest weight they reported
                (at most 2 reporters counted per reporter IP; dismissed reports don't count)

weights: underage 3 · sexual 2 · violence 2 · hate 2 · harassment 1 · spam 1 · fake 1
restrict when score ≥ AUTO_BAN_SCORE (default 4)
```

| Situation | Score | Outcome |
|---|---|---|
| 1 person reports "under 18" five times | 3 | no action (one reporter can't restrict alone) |
| 2 different people report "sexual" | 4 | restricted |
| 2 people report "under 18" | 6 | restricted |
| 4 different people report "spam" | 4 | restricted |
| 6 devices on one IP report "harassment" | 2 | no action (brigading limited to 2 per IP) |

Durations: **24 hours** the first time, **7 days** for repeat offenders (`AUTO_BAN_HOURS`, `REPEAT_BAN_HOURS`).
The restricted device is disconnected immediately and shown when it can return.

### Why IP bans are short and narrow (CGNAT)

In India, Indonesia, Nigeria, the Philippines and many other markets, mobile carriers put thousands of users behind
one public IP (carrier-grade NAT). A long IP ban there would lock out a whole neighbourhood. So Dunia:

- always restricts the **device** (for the full duration);
- adds an **IP restriction only for severe reasons** (under 18, sexual) or when a moderator ticks it;
- keeps the IP part **short** (`IP_BAN_HOURS`, default 2 h) and applies it only to **new connections**. Nobody already
  online on that IP is disconnected.

The IP window exists to slow down the obvious evasion: clearing browser storage to get a new device id. Strong evasion
resistance needs accounts or phone verification (roadmap).

## Moderator workflow (`/admin`)

1. Sign in with `ADMIN_TOKEN` (kept only in that browser tab).
2. **Open reports** is the queue, newest first. Each card shows:
   - severity badge (critical: under 18, sexual · serious: violence, hate · warning: others);
   - snapshot (click to enlarge) and the reported person's last messages;
   - declared country versus the country their connection comes from, highlighted when they differ (useful for
     "lied about country" reports);
   - current score and whether they're already restricted.
3. Actions: **Restrict 24 h**, **Restrict 7 days**, **Permanent**, optionally **also restrict their IP** (pre-ticked for
   critical reasons), or **Dismiss** (removes the report from the score).
4. **Active restrictions** lists everything in force; **Lift** reverses a mistake.
5. The console refreshes every 5 seconds.

### Suggested triage targets

| Severity | Target time to review | Notes |
|---|---|---|
| Critical (under 18, sexual) | < 15 minutes, 24/7 | Child-safety reports may carry legal reporting duties |
| Serious (violence, hate) | < 2 hours | |
| Warning (spam, harassment, fake) | < 24 hours | Mostly handled by automation; sample for quality |

## Launch checklist

The code is a foundation. Before opening to the public, work through this with legal counsel for every market you
launch in:

- [ ] **Moderators on shift** for your peak hours, with wellbeing support (reviewing this content is hard on people).
- [ ] **CSAM detection and reporting.** Hash-match report snapshots against known-CSAM databases (for example
      PhotoDNA or a vendor API) and set up mandatory reporting where required (for example NCMEC in the US).
- [ ] **Age assurance** beyond a checkbox where the law expects it (UK Online Safety Act, some US states): age
      estimation, ID checks or accounts.
- [ ] **Automated nudity detection** (client-side classifier on sampled frames, feeding safe-blur and report priority).
- [ ] **India IT Rules 2021**: publish a Grievance Officer and a complaint process with the required response times;
      larger platforms have more duties. **DPDP Act** privacy obligations.
- [ ] **EU DSA / GDPR**: notice-and-action, statement of reasons for restrictions, an appeals route, a data controller,
      and a DPO or EU representative if required.
- [ ] **Appeals mailbox** and a documented review process (the restriction screen and guidelines point to it).
- [ ] **Blocked-word lists** for every launch language (slurs, sexual solicitation, scam phrases).
- [ ] **Law-enforcement request process** and data retention schedule. Fill the `[bracketed]` items in `/legal`.
- [ ] **Transparency reporting**: reports received, actions taken, response times.

## Where each piece lives in code

| Concern | File |
|---|---|
| Report reasons and weights | `shared/data.js` → `REPORT_REASONS` |
| Scoring, restrictions, persistence | `server/safety.js` |
| Report handler, enforcement, rate limits | `server/index.js` |
| Chat and username filters | `server/moderation.js`, `data/blocked-words.txt` |
| Blocks and cooldowns | `server/relations.js` |
| Moderator API and console | `server/admin.js`, `public/admin.html`, `public/js/admin.js` |
| Tests | `test/safety.test.js`, `test/moderation.test.js`, `test/integration.test.js` |
