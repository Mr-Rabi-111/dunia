/**
 * Fixed-window rate limiter stored on the socket itself (no global map to
 * leak). Returns true when the caller should be REJECTED.
 */
export function limited(socket, key, max, windowMs, now = Date.now()) {
  const store = (socket.data.rl ||= {});
  let b = store[key];
  if (!b || now >= b.reset) b = store[key] = { n: 0, reset: now + windowMs };
  b.n += 1;
  return b.n > max;
}

/** Per-IP connection counter used by the handshake middleware. */
export class ConnectionCounter {
  constructor() { this.map = new Map(); }
  count(ip) { return this.map.get(ip) || 0; }
  inc(ip) { this.map.set(ip, this.count(ip) + 1); }
  dec(ip) {
    const n = this.count(ip) - 1;
    if (n <= 0) this.map.delete(ip); else this.map.set(ip, n);
  }
}
