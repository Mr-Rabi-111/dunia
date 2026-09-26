# Deploying Dunia

Three ways to run it, from a laptop to production, plus TURN, Cloudflare, monitoring and upgrades.

## Requirements

- **Node.js 20+** (22 LTS recommended), or Docker.
- **HTTPS in production.** Browsers only allow the camera on `https://` (and `localhost`).
- **A TURN server** for real users (included in the Docker stack). Without one, about 15% of calls fail: people behind
  strict corporate networks, some mobile carriers and symmetric NATs.

## 1. Local development

```bash
npm install
npm run dev            # restarts on file changes
open http://localhost:3000
```

Test a call by opening two windows (one normal, one private, so they get separate profiles). In development the
rematch cooldown is 0, so the same two windows can meet again straight after pressing Next.

Testing on a phone: the camera needs HTTPS, so either deploy, or tunnel your laptop, e.g.
`npx localtunnel --port 3000` or `cloudflared tunnel --url http://localhost:3000`.

Run the checks:

```bash
npm test                                   # 63 unit + integration tests
npx playwright install chromium && npm run test:e2e   # two real browsers, real video call
npm run bench                              # matchmaker benchmark
npm run loadtest -- 2000 30                # 2,000 simulated people for 30 s
```

## 2. Production on one server (recommended start)

Any Linux VM with a public IP: 2 vCPU / 4 GB is plenty to start (see [ARCHITECTURE.md](ARCHITECTURE.md#capacity)).
Pick a region close to most of your users (for India, Mumbai or Singapore).

### Step by step

1. **DNS**: create an `A` record, e.g. `chat.example.com → <server public IP>`. (If you use Cloudflare, set this record
   to **DNS only / grey cloud** for now; see section 4.)
2. **Firewall**: open these ports:

   | Port | Protocol | For |
   |---|---|---|
   | 80, 443 | TCP | HTTPS (Caddy) |
   | 443 | UDP | HTTP/3 (optional) |
   | 3478 | UDP + TCP | TURN |
   | 5349 | TCP | TURN over TLS (optional) |
   | 49160–49999 | UDP | TURN relay range |

3. **Install Docker** (`curl -fsSL https://get.docker.com | sh`) and copy this project to the server.
4. **Configure**:

   ```bash
   cp .env.example .env
   openssl rand -hex 32     # use for ADMIN_TOKEN
   openssl rand -hex 32     # use for TURN_SECRET
   nano .env                # set DOMAIN, PUBLIC_IP, ADMIN_TOKEN, TURN_SECRET
   ```

5. **Start**:

   ```bash
   docker compose up -d --build
   docker compose logs -f app      # expect: "Dunia listening … turn=ephemeral admin=enabled"
   ```

   Caddy fetches the TLS certificate automatically on first request.

6. **Verify**:
   - `https://chat.example.com/healthz` returns `{"ok":true,…}`
   - `https://chat.example.com/admin`: sign in with `ADMIN_TOKEN`
   - TURN: open the [WebRTC Trickle ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/),
     add `turn:chat.example.com:3478` with a username/credential generated like the server does (or temporarily static
     credentials), and check that a `relay` candidate appears.
   - Two phones on different networks (one on mobile data) should connect.

### What runs

| Service | Image | Role |
|---|---|---|
| `app` | built from `Dockerfile` (Node 22 Alpine, non-root, healthcheck) | Dunia |
| `caddy` | `caddy:2` | HTTPS, compression, WebSocket proxy |
| `coturn` | `coturn/coturn` | TURN relay, host networking, private ranges denied |

Data (bans, reports, `blocked-words.txt`) is in the `dunia-data` volume at `/app/data`.

## 3. Platform-as-a-service (Render, Railway, Fly.io, etc.)

Dunia is a single Node process that needs WebSockets:

- Build: `npm ci --omit=dev` · Start: `node server/index.js` · Port: `$PORT`
- Set `NODE_ENV=production`, `ADMIN_TOKEN`, and `TRUST_PROXY=1` (check your platform's proxy depth).
- **Run exactly one instance** (the matchmaker is in memory; see the scaling plan before adding instances).
- Attach a **persistent disk** at `/app/data` (or set `DATA_DIR`) so bans survive deploys.
- PaaS platforms can't host TURN (it needs raw UDP ports). Use a managed TURN provider (for example Cloudflare, Twilio,
  Metered or Xirsys) and set `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`, or run coturn on a small VM with `TURN_SECRET`.

## 4. Behind Cloudflare

Cloudflare in front of the web app gives you free DDoS protection and **country detection** (`CF-IPCountry`), which
powers the "location verified" badge with no GeoIP database.

- Proxy (orange cloud) the **app** hostname, enable **WebSockets** (on by default), SSL mode **Full (strict)**.
- Set `TRUST_PROXY=2` (Cloudflare → Caddy → app).
- Use a **separate DNS-only (grey cloud) hostname for TURN**, e.g. `turn.example.com`, because Cloudflare's proxy doesn't
  carry TURN/UDP. Set `TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp`.

## 5. Country detection without a CDN

Install the optional GeoIP package and restart. It's picked up automatically:

```bash
npm install geoip-lite       # ~100 MB database. Refresh monthly with a free MaxMind licence key:
                             #   cd node_modules/geoip-lite && npm run-script updatedb license_key=YOUR_KEY
```

Set `LOCK_COUNTRY_TO_IP=true` if you want the detected country to override what users pick (stops people spoofing
their country, but travellers and VPN users can't correct it).

## 6. Configuration reference

All settings are environment variables (or `.env`). The full annotated list is in [`.env.example`](../.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | 3000 / 0.0.0.0 | Listen address |
| `NODE_ENV` | — | `production` enables HSTS, the 2-minute rematch cooldown, and stricter defaults |
| `TRUST_PROXY` | 1 | Reverse proxies in front (Caddy = 1; Cloudflare + Caddy = 2) |
| `ADMIN_TOKEN` | — | Enables `/admin` and `/metrics`; must be ≥ 16 chars and not a placeholder |
| `TURN_URLS` + `TURN_SECRET` | — | coturn with short-lived credentials (recommended) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | — | static credentials (managed TURN) |
| `STUN_URLS` | Google STUN | STUN servers |
| `REMATCH_COOLDOWN_SEC` | 120 prod / 0 dev | Keep two people apart after they meet |
| `MATCH_SCAN_LIMIT` / `MATCH_SWEEP_MS` | 400 / 1500 | Matchmaker tuning |
| `LOCK_COUNTRY_TO_IP` | false | Country from IP instead of user choice |
| `MAX_CONN_PER_IP` | 20 | Keep generous: CGNAT puts many users on one IP |
| `BLOCK_CONTACT_SHARING` | true | Mask links/phones/e-mails/handles in chat |
| `REPORT_SNAPSHOTS` | true | Attach a still frame to reports |
| `AUTO_BAN_SCORE` / `AUTO_BAN_HOURS` / `REPEAT_BAN_HOURS` / `IP_BAN_HOURS` | 4 / 24 / 168 / 2 | Automatic restriction policy |
| `DATA_DIR` | `./data` | Where bans/reports are stored |
| `METRICS_PUBLIC` | false | Serve `/metrics` without a token |

## 7. Monitoring

- Point your load balancer or uptime checker at `/healthz`.
- Scrape `/metrics` with Prometheus (`Authorization: Bearer <ADMIN_TOKEN>`). Useful panels: people online, waiting,
  matches per minute, `match_wait_seconds` p95, reports per 1,000 matches, `connect_rejected_total`.
- `docker compose logs -f app` shows one JSON line per report.

## 8. Backups, upgrades, restarts

- **Back up** `/app/data/safety.json` (bans and reports) daily, e.g. `docker compose cp app:/app/data/safety.json ./backup/`.
- **Upgrade**: `git pull && docker compose up -d --build`. On shutdown, Dunia tells every client
  (`server:restarting`), saves safety data, and exits within 8 s. Clients reconnect and resume searching on their own.
- Edit `data/blocked-words.txt` in the volume and restart the app to apply.

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Camera never prompts | Site not on HTTPS |
| Calls connect on Wi-Fi but not on mobile data | TURN missing or ports 3478/49160–49999 UDP blocked |
| Everyone shows the same "country detected" / no verified badges | `TRUST_PROXY` wrong, so the proxy's IP is used; or no country header and no GeoIP |
| `too_many_connections` for many users | Raise `MAX_CONN_PER_IP` (school or carrier NAT) |
| Admin says "turned off" | `ADMIN_TOKEN` unset, shorter than 16 characters, or a placeholder (see the startup warning) |
| Two tabs never match again in production | Rematch cooldown (2 min, relaxes after 30 s of waiting). Expected. |
