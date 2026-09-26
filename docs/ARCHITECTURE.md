# Dunia architecture

How Dunia is built, why it's built that way, what one server can carry, and the path to millions of people online.

## The one decision that makes it cheap

**Video and audio never pass through Dunia's servers.** Browsers connect to each other directly with WebRTC. The
server only does three small jobs:

1. **Matchmaking**: decides who talks to whom (in memory, microseconds).
2. **Signaling**: forwards the few kilobytes two browsers need to find each other (SDP offer/answer, ICE candidates).
3. **Chat, reactions, safety**: small text messages, reports and bans.

A connected person costs the server roughly **50 KB of memory and a trickle of CPU**. The only component that
carries media is the **TURN relay**, and only for the ~15% of calls whose networks block direct connections.

```
                          ┌──────────────── Dunia server (Node.js) ────────────────┐
  Browser A ──HTTPS/WSS──▶│  Express: static app, /healthz, /metrics, /api/admin   │
      │                   │  Socket.IO: profile · match · signal · chat · report   │◀──WSS── Browser B
      │                   │  Matchmaker (in-memory indexes) · Relations · Safety   │           │
      │                   └───────────────────────┬────────────────────────────────┘           │
      │                                           │ data/safety.json (bans, reports)            │
      │                                                                                         │
      └───────────── encrypted video/audio, peer-to-peer (DTLS-SRTP) ◀────────────────────────┘
                     └─ or, if a network blocks P2P, through the TURN relay (coturn) — still encrypted
```

## Components

| Component | File | Responsibility |
|---|---|---|
| HTTP layer | `server/index.js` | Static files (compressed, cache-revalidated), security headers (CSP, frame, permissions), health, metrics, admin API mount |
| Socket layer | `server/index.js` | Handshake (device id, IP, ban check, per-IP cap, geo), event handlers, rate limits, pairing, ban enforcement |
| Matchmaker | `server/matchmaker.js` | Acceptance-indexed queue, scoring, sweep ([MATCHING.md](MATCHING.md)) |
| Relations | `server/relations.js` | Blocks (30 days) and rematch cooldown, memory-bounded |
| Safety | `server/safety.js` | Reports, weighted auto-restriction, bans, JSON persistence, in-memory evidence |
| Moderation | `server/moderation.js` | Chat and username filtering, contact-sharing masking |
| Geo | `server/geo.js` | Real client IP behind proxies, country from CDN headers or optional GeoIP |
| TURN creds | `server/turn.js` | Short-lived HMAC credentials for coturn |
| Web app | `public/` | Vanilla ES modules, no build step, ~62 KB gzipped + fonts |
| Shared data | `shared/data.js` | Countries, languages, interests, report reasons (imported by server and browser) |

**Why no framework or build step?** The target markets are dominated by low-end Android phones on mobile data. The
whole app is ~62 KB gzipped (130 KB with fonts), loads as native ES modules, and anyone can edit it without a
toolchain. Socket.IO was chosen over raw WebSockets for automatic reconnection and a long-polling fallback on
restrictive networks (some schools, offices and carriers block WebSockets).

## Connection lifecycle and protocol

### Handshake

The browser connects with `auth: { deviceId }`, a random UUID kept in localStorage. The server:

1. derives the real client IP from `X-Forwarded-For`, trusting exactly `TRUST_PROXY` hops;
2. rejects banned devices (and, briefly, new devices from an IP under a severe ban) with `connect_error: banned`;
3. rejects more than `MAX_CONN_PER_IP` (default 20) connections per IP;
4. detects the country (CDN header or GeoIP) and sends `welcome` with ICE servers and the detected country.

### Events

| Direction | Event | Payload | Notes |
|---|---|---|---|
| S→C | `welcome` | `{deviceId, iceServers, detectedCountry, lockCountry, online, reportSnapshots}` | on every (re)connect |
| C→S | `profile:set` (ack) | `{username, gender, country, languages}` | validated server-side; returns sanitized profile or `{error}` |
| C→S | `match:find` | `{filters, interests}` | enters the queue (ends any current match) |
| C→S | `match:next` / `match:stop` | — | skip (re-queue) / leave |
| S→C | `match:searching` · `match:found` · `match:error` | `{matchId, initiator, peer}` on found | peer = public profile only, never ids or IPs |
| C↔S | `rtc:signal` | `{matchId, sdp}` or `{matchId, candidate}` | relayed only to the current partner with the same `matchId`; fields whitelisted |
| C→S | `chat:send` (ack) | text | filtered; ack returns the cleaned text |
| S→C | `chat:message` | `{id, text}` | |
| C↔S | `chat:typing` · `react` · `peer:state` | bool · emoji · `{mic, cam}` | rate-limited, relayed |
| C→S | `report` (ack) | `{reason, snapshot?}` | snapshot = 360-px JPEG of the partner's video |
| C→S | `block` (ack) | — | |
| C→S | `stats:peek` (ack) | `{filters}` | returns `{online, matching, countries}` (cached) |
| S→C | `peer:left` | `{matchId}` | the partner is only ever told "left", never "reported" or "blocked" |
| S→C | `banned` · `online` · `server:restarting` | | `online` is broadcast at most every 5 s |

### Call setup

```
A (waited longer)            server                    B
 │── match:find ────────────▶ │                         │
 │                            │ ◀──────────── match:find│
 │◀─ match:found(initiator) ─ │ ─ match:found ─────────▶│
 │── rtc:signal(offer) ─────▶ │ ─ rtc:signal ──────────▶│
 │◀─ rtc:signal ──────────── │ ◀─ rtc:signal(answer) ──│
 │◀═══ ICE candidates both ways (trickle) ═════════════▶│
 │◀═════════ DTLS-SRTP media, peer-to-peer or via TURN ═▶│
 "Connecting…" stays until the first video frame arrives (3.5 s fallback)
```

Resilience built into the client: queued ICE candidates until the remote description arrives; one **ICE restart**
by the initiator on failure; 20 s connect timeout → auto-skip; 8 s tolerance for `disconnected`; after a lost
signaling connection the client reconnects, re-registers its profile and **resumes searching** automatically.

## State: what lives where

| Data | Where | Survives restart? |
|---|---|---|
| Waiting queue, current pairs | server memory | no (clients reconnect and resume) |
| Blocks, rematch cooldowns | server memory, bounded per device | no |
| Bans, report metadata, ban history | `data/safety.json` (atomic writes, debounced) | yes |
| Report evidence (snapshot, last 15 messages) | server memory, 48 h, max 300 | no, by design (privacy) |
| Profile, settings, device id | the user's browser (localStorage) | yes |

## Capacity

### Measured

2-vCPU cloud sandbox, Node 22, server in its own process, load generated from the same machine
(`npm run loadtest`):

| People online | Behaviour | Server CPU | Server memory | Matches/s | Time to match (p95) |
|---|---|---|---|---|---|
| 2,000 | everyone skips every 1.5–4.5 s | 19% of one core | 152 MB | 424 | 9 ms |
| 5,000 | same | 33% of one core | 293 MB | 1,102 | 11 ms |

That load is extreme: every person skips every ~3 seconds. Real users talk for 30 seconds to several minutes, so
real-world churn per person is about 10× lower.

### Planning numbers (single instance)

- Memory: ≈ 60 MB baseline + ≈ 47 KB per connected person (measured: 152 MB at 2,000 and 293 MB at 5,000),
  so 30,000 people ≈ 1.5 GB.
- A **2 vCPU / 4 GB** instance: plan for **20,000–30,000 people online**. The limit is WebSocket fan-in and
  Node's single thread, not matching.
- A **4 vCPU / 8 GB** instance: ~40,000–60,000, but beyond ~30k it's better to scale out (next section)
  than up, because one Node process uses one core for socket handling.
- Rule of thumb for the peak you need: people online ≈ daily active users × average minutes per day ÷ 1,440 × peak factor (≈ 3).

### The real cost: TURN bandwidth

Signaling bandwidth is negligible. The TURN relay carries both directions of ~15% of calls:

```
relay egress (Mbit/s) ≈ concurrent calls × 0.15 × 2 streams × stream bitrate (≈ 1 Mbit/s at 720p, less on mobile)
```

Example: 5,000 concurrent calls → 750 relayed → ≈ 1.5 Gbit/s of relay egress, about 675 GB per hour at peak.
Hyperscaler egress pricing makes that expensive; **bandwidth-included or unmetered hosts** (and managed TURN
networks priced per GB) are much cheaper. Always check current prices. Keep TURN on its own boxes, close to users
(one per region), and cap per-user bitrate if needed.

## Scaling plan

### Stage 1: one server (0 → ~30k online) ✅ implemented

`docker compose up`: Dunia + Caddy + coturn on one VM, or Dunia on a PaaS with a managed TURN provider.
Everything in this repository targets this stage and is tested.

### Stage 2: horizontal (~30k → ~300k online)

Split the process along the seams that already exist in the code:

```
            ┌──────────┐    ┌──────────┐    ┌──────────┐
 users ───▶ │ edge #1  │    │ edge #2  │    │ edge #N  │   stateless socket servers
            └────┬─────┘    └────┬─────┘    └────┬─────┘   (sticky sessions at the load balancer)
                 │  enqueue / remove / pair events  │
                 └────────────► Redis ◄─────────────┘      pub/sub + Socket.IO Redis adapter
                                  │                        (io.to(socketId).emit crosses edges)
                          ┌───────┴────────┐
                          │  matchmaker    │               one process (hot standby); already
                          │  service       │               a pure module: ~28k searches/s/core
                          └────────────────┘
       Postgres: bans, reports, ban history      Redis (TTL keys): blocks, cooldowns
```

What changes: the socket handlers publish `enqueue`/`remove` to the matchmaker instead of calling it directly;
`partnerOf()` looks up the partner's socket id from Redis; relations move to Redis keys with TTLs; `Safety`
persists to Postgres. The matchmaker core, protocol and client stay the same.

### Stage 3: global (300k+ online)

- **Regional edges** (for example Mumbai, Singapore, Frankfurt, Virginia, São Paulo) behind GeoDNS or anycast, each
  with its own TURN pool, so signaling and relayed media stay close to users.
- **One logical global matchmaker.** Matching is cheap enough to stay central (one core per ~850k people online at one
  search per 30 s), which keeps cross-country filters ("meet people in the US" from India) working. If ever needed,
  shard by pool (for example open filters per region plus a global pool for filtered searches).
- Region preference is already in the score (`sameContinent`); swap it for measured inter-region RTT.

## Security

| Threat | Mitigation in this codebase |
|---|---|
| XSS / injection | Strict CSP (`script-src 'self'`, no inline scripts), all user text rendered with `textContent`, server-side validation of every field |
| Clickjacking | `X-Frame-Options: DENY`, `frame-ancestors 'none'` |
| Flooding / abuse | Per-event rate limits on every socket event, per-IP connection cap, message length caps, 400 KB socket frame cap |
| Signaling spoofing | Relay only to the current partner, `matchId` check, SDP/candidate fields whitelisted and length-capped |
| Privacy leaks | Peers receive no device ids or IPs; admin API behind a constant-time bearer token; fonts and flags self-hosted (no third-party requests) |
| TURN abuse | Short-lived HMAC credentials (`use-auth-secret`), quotas, and **private address ranges denied** in `turnserver.conf` (prevents using your relay to reach internal networks) |
| Misconfiguration | Server refuses placeholder or short `ADMIN_TOKEN`/`TURN_SECRET` and logs a warning; HSTS in production; admin disabled unless configured |
| Bidi spoofing | Bidi override characters stripped from chat; user names isolated (`dir=auto`, FSI/PDI) in translated sentences |

## Observability

- `GET /healthz`: `{ok, online, profiled, waiting, inCall, uptimeSec}`, for load balancer checks.
- `GET /metrics` (bearer token, or `METRICS_PUBLIC=true`): Prometheus counters (`connections_total`, `matches_total`,
  `reports_total`, `bans_total`, `chat_messages_total`, `chat_filtered_total`, `connect_rejected_total`), gauges
  (`online`, `waiting`, `in_call_pairs`, `active_bans`), histograms (`match_wait_seconds`, `call_duration_seconds`).
- Structured JSON log line per report: `{"evt":"report","id":…,"reason":…,"score":…,"autoBan":…}`.
- Suggested alerts: `match_wait_seconds` p95 > 10 s; `connect_rejected_total` rate spike (attack or bad deploy);
  reports per match rising (quality problem); memory > 80%.

## Roadmap (suggested order)

1. **Automated nudity detection** in the browser (a small image classifier on periodic frames) to trigger "safe blur"
   and pre-flag reports; server-side **CSAM hash matching** on report snapshots (see SAFETY.md).
2. **Reputation-aware matching** (clean, long-call users matched first; reported users shadow-queued).
3. Optional **phone or social sign-in** for persistent reputation and ban evasion resistance.
4. **Stage 2 scaling** (Redis + matchmaker service + Postgres).
5. **Text-only and audio-only modes** as separate pools, for people without cameras or on slow data.
6. "Stay in touch": mutual friend request at the end of a good call.
