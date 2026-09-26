/**
 * In-process metrics: counters, a per-minute ring for "last hour" figures,
 * and simple histograms. Rendered as Prometheus text at /metrics.
 */
const WAIT_BUCKETS = [0.5, 1, 2, 5, 10, 20, 30, 60, 120];
const CALL_BUCKETS = [5, 15, 30, 60, 120, 300, 600, 1800];

function histogram(buckets) {
  return { buckets, counts: new Array(buckets.length + 1).fill(0), sum: 0, n: 0 };
}
function observe(h, v) {
  h.sum += v;
  h.n += 1;
  let i = h.buckets.findIndex((b) => v <= b);
  if (i === -1) i = h.buckets.length;
  h.counts[i] += 1;
}

class MinuteRing {
  constructor(minutes = 60) {
    this.slots = new Array(minutes).fill(0);
    this.stamps = new Array(minutes).fill(0);
  }
  add(n = 1, now = Date.now()) {
    const m = Math.floor(now / 60000);
    const i = m % this.slots.length;
    if (this.stamps[i] !== m) { this.stamps[i] = m; this.slots[i] = 0; }
    this.slots[i] += n;
  }
  total(now = Date.now()) {
    const m = Math.floor(now / 60000);
    let t = 0;
    for (let i = 0; i < this.slots.length; i++) if (m - this.stamps[i] < this.slots.length) t += this.slots[i];
    return t;
  }
}

export const metrics = {
  startedAt: Date.now(),
  counters: {
    connections_total: 0,
    matches_total: 0,
    reports_total: 0,
    bans_total: 0,
    chat_messages_total: 0,
    chat_filtered_total: 0,
    connect_rejected_total: 0,
  },
  matchesHour: new MinuteRing(),
  reportsHour: new MinuteRing(),
  matchWait: histogram(WAIT_BUCKETS),
  callDuration: histogram(CALL_BUCKETS),
  inc(name, n = 1) { this.counters[name] = (this.counters[name] || 0) + n; },
  observeWait(sec) { observe(this.matchWait, sec); },
  observeCall(sec) { observe(this.callDuration, sec); },

  render(gauges) {
    const lines = [];
    for (const [k, v] of Object.entries(this.counters)) {
      lines.push(`# TYPE dunia_${k} counter`, `dunia_${k} ${v}`);
    }
    for (const [k, v] of Object.entries(gauges)) {
      lines.push(`# TYPE dunia_${k} gauge`, `dunia_${k} ${v}`);
    }
    for (const [name, h] of [['match_wait_seconds', this.matchWait], ['call_duration_seconds', this.callDuration]]) {
      lines.push(`# TYPE dunia_${name} histogram`);
      let cum = 0;
      h.buckets.forEach((b, i) => {
        cum += h.counts[i];
        lines.push(`dunia_${name}_bucket{le="${b}"} ${cum}`);
      });
      cum += h.counts[h.buckets.length];
      lines.push(`dunia_${name}_bucket{le="+Inf"} ${cum}`, `dunia_${name}_sum ${h.sum.toFixed(3)}`, `dunia_${name}_count ${h.n}`);
    }
    return lines.join('\n') + '\n';
  },

  /** p50/p95 estimate from histogram buckets (upper bound of bucket). */
  quantile(h, q) {
    if (!h.n) return 0;
    const target = h.n * q;
    let cum = 0;
    for (let i = 0; i < h.counts.length; i++) {
      cum += h.counts[i];
      if (cum >= target) return i < h.buckets.length ? h.buckets[i] : h.buckets[h.buckets.length - 1];
    }
    return 0;
  },
};
