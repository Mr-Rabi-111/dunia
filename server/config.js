import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader (KEY=VALUE per line, # comments). Real env vars win. */
function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, ''); // inline comment on an unquoted value
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const isProd = env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  // How many reverse proxies sit in front of Node (Caddy/Nginx/Cloudflare = 1..2).
  trustProxy: int(env.TRUST_PROXY, 1),
  corsOrigin: env.CORS_ORIGIN || (isProd ? false : '*'),
  dataDir: env.DATA_DIR || path.join(ROOT, 'data'),

  // --- Admin / observability ---
  adminToken: env.ADMIN_TOKEN || '',
  metricsPublic: bool(env.METRICS_PUBLIC, false),

  // --- WebRTC ICE ---
  stunUrls: list(env.STUN_URLS).length ? list(env.STUN_URLS) : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
  turnUrls: list(env.TURN_URLS),
  turnSecret: env.TURN_SECRET || '',          // coturn "use-auth-secret" (recommended)
  turnUsername: env.TURN_USERNAME || '',      // or static credentials
  turnCredential: env.TURN_CREDENTIAL || '',
  turnTtlSec: int(env.TURN_TTL_SEC, 6 * 3600),

  // --- Matching ---
  rematchCooldownSec: int(env.REMATCH_COOLDOWN_SEC, isProd ? 120 : 0),
  scanLimit: int(env.MATCH_SCAN_LIMIT, 400),
  sweepIntervalMs: int(env.MATCH_SWEEP_MS, 1500),

  // --- Location ---
  // true = when the IP country is known, it overrides the country the user picks
  lockCountryToIp: bool(env.LOCK_COUNTRY_TO_IP, false),

  // --- Safety ---
  maxConnPerIp: int(env.MAX_CONN_PER_IP, 20),
  blockContactSharing: bool(env.BLOCK_CONTACT_SHARING, true),
  reportSnapshots: bool(env.REPORT_SNAPSHOTS, true),
  autoBanScore: int(env.AUTO_BAN_SCORE, 4),
  autoBanHours: int(env.AUTO_BAN_HOURS, 24),
  repeatBanHours: int(env.REPEAT_BAN_HOURS, 24 * 7),
  ipBanHours: int(env.IP_BAN_HOURS, 2),
};

// Refuse placeholder / weak secrets: a copied .env.example must never expose
// the moderation console or a TURN relay with a publicly known password.
export const configWarnings = [];
const weak = (s) => !s || s.length < 16 || /^change-me/i.test(s);
if (config.adminToken && weak(config.adminToken)) {
  configWarnings.push('ADMIN_TOKEN is a placeholder or shorter than 16 characters, so the admin console is DISABLED. Generate one with: openssl rand -hex 32');
  config.adminToken = '';
}
if (config.turnSecret && weak(config.turnSecret)) {
  configWarnings.push('TURN_SECRET is a placeholder or shorter than 16 characters. Generate one with: openssl rand -hex 32');
  if (isProd) config.turnSecret = '';
}

export function describeConfig() {
  return [
    `mode=${isProd ? 'production' : 'development'}`,
    `turn=${config.turnUrls.length ? (config.turnSecret ? 'ephemeral' : 'static') : 'none'}`,
    `rematchCooldown=${config.rematchCooldownSec}s`,
    `admin=${config.adminToken ? 'enabled' : 'disabled'}`,
    `lockCountryToIp=${config.lockCountryToIp}`,
  ].join(' ');
}
