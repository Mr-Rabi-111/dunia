import crypto from 'node:crypto';

/**
 * ICE servers handed to each browser.
 *
 * STUN alone connects roughly 80–85% of calls. The rest (symmetric NAT,
 * corporate firewalls, many mobile carriers) need a TURN relay.
 *
 * Preferred: coturn with `use-auth-secret` (the "TURN REST API"). Each user
 * gets a short-lived username/password derived from a shared secret, so the
 * credentials in the browser are useless after TURN_TTL_SEC and can't be
 * scraped to relay other people's traffic on your bill.
 *
 *   username   = "<unix-expiry>:<user-key>"
 *   credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
 */
export function iceServersFor(userKey, cfg, now = Date.now()) {
  const servers = [{ urls: cfg.stunUrls }];
  if (!cfg.turnUrls.length) return servers;

  if (cfg.turnSecret) {
    const username = `${Math.floor(now / 1000) + cfg.turnTtlSec}:${String(userKey).slice(0, 32)}`;
    const credential = crypto.createHmac('sha1', cfg.turnSecret).update(username).digest('base64');
    servers.push({ urls: cfg.turnUrls, username, credential });
  } else if (cfg.turnUsername) {
    servers.push({ urls: cfg.turnUrls, username: cfg.turnUsername, credential: cfg.turnCredential });
  }
  return servers;
}
