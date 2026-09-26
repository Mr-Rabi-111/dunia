/**
 * Who should NOT be matched with whom.
 *
 *  - Blocks are hard: once A blocks B, they are never paired again (either
 *    direction) until the block expires (default 30 days).
 *  - Recent pairs are soft: two people who just met are kept apart for
 *    `cooldownMs`, so pressing Next doesn't bounce you back to the same face.
 *    If either person has already waited `softAfterMs`, the cooldown is
 *    ignored — in a tiny pool, meeting someone again beats waiting forever.
 *
 * Keys are stable device identifiers (not socket ids), so relations survive
 * reconnects and page reloads. Memory is bounded per key.
 */
const MAX_PER_KEY = 300;

export class Relations {
  constructor({ cooldownMs = 120_000, softAfterMs = 30_000, blockTtlMs = 30 * 24 * 3600_000, now = () => Date.now() } = {}) {
    this.cooldownMs = cooldownMs;
    this.softAfterMs = softAfterMs;
    this.blockTtlMs = blockTtlMs;
    this.now = now;
    /** @type {Map<string, Map<string, number>>} key -> (otherKey -> expiresAt) */
    this.blocks = new Map();
    this.recent = new Map();
  }

  block(aKey, bKey) {
    if (!aKey || !bKey) return;
    put(this.blocks, aKey, bKey, this.now() + this.blockTtlMs);
  }

  notePair(aKey, bKey) {
    if (!aKey || !bKey || this.cooldownMs <= 0) return;
    const exp = this.now() + this.cooldownMs;
    put(this.recent, aKey, bKey, exp);
    put(this.recent, bKey, aKey, exp);
  }

  isBlocked(aKey, bKey, now = this.now()) {
    return live(this.blocks, aKey, bKey, now) || live(this.blocks, bKey, aKey, now);
  }

  /** Matchmaker constraint. `a`/`b` are queue entries with .key and .enqueuedAt */
  canPair(a, b, now = this.now()) {
    if (this.isBlocked(a.key, b.key, now)) return false;
    if (live(this.recent, a.key, b.key, now)) {
      const waited = Math.max(now - (a.enqueuedAt ?? now), now - (b.enqueuedAt ?? now));
      if (waited < this.softAfterMs) return false;
    }
    return true;
  }

  prune(now = this.now()) {
    for (const map of [this.blocks, this.recent]) {
      for (const [k, inner] of map) {
        for (const [o, exp] of inner) if (exp <= now) inner.delete(o);
        if (inner.size === 0) map.delete(k);
      }
    }
  }
}

function put(map, a, b, exp) {
  let inner = map.get(a);
  if (!inner) map.set(a, (inner = new Map()));
  inner.delete(b);            // re-insert to refresh LRU position
  inner.set(b, exp);
  if (inner.size > MAX_PER_KEY) inner.delete(inner.keys().next().value);
}

function live(map, a, b, now) {
  const exp = map.get(a)?.get(b);
  return exp !== undefined && exp > now;
}
