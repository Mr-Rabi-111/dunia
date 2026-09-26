/**
 * Matchmaker benchmark with a realistic, skewed population.
 *
 *   npm run bench            (defaults: 200k arrivals)
 *   node bench/matchmaker.bench.js 500000
 *
 * Population model (typical of random video chat):
 *   70% men / 30% women; 45% of men filter for women; 10% of people filter
 *   by country; 5% by language; countries weighted toward the biggest markets.
 */
import { Matchmaker } from '../server/matchmaker.js';
import { COUNTRIES } from '../shared/data.js';

const ARRIVALS = Number(process.argv[2]) || 200_000;

// deterministic PRNG so runs are comparable
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const WEIGHTED = [['IN', 18], ['US', 12], ['BR', 8], ['ID', 6], ['PH', 5], ['MX', 5], ['TR', 4], ['PK', 4], ['EG', 3], ['GB', 3], ['DE', 2], ['FR', 2], ['NG', 2], ['VN', 2]];
const WEIGHT_SUM = WEIGHTED.reduce((s, [, w]) => s + w, 0);
const OTHER = COUNTRIES.map((c) => c[0]).filter((c) => !WEIGHTED.some(([w]) => w === c));
const LANG = { IN: 'hi', US: 'en', BR: 'pt', ID: 'id', PH: 'fil', MX: 'es', TR: 'tr', PK: 'ur', EG: 'ar', GB: 'en', DE: 'de', FR: 'fr', NG: 'en', VN: 'vi' };
const CONT = Object.fromEntries(COUNTRIES.map((c) => [c[0], c[2]]));
const INTERESTS = ['music', 'movies', 'gaming', 'sports', 'travel', 'food', 'tech', 'art', 'books', 'anime', 'fitness', 'languages'];

function country() {
  if (rnd() < 0.2) return pick(OTHER);
  let r = rnd() * WEIGHT_SUM;
  for (const [c, w] of WEIGHTED) { if ((r -= w) < 0) return c; }
  return 'IN';
}

let id = 0;
function arrival() {
  id += 1;
  const c = country();
  const gender = rnd() < 0.7 ? 'male' : 'female';
  const languages = [LANG[c] || 'en'];
  if (languages[0] !== 'en' && rnd() < 0.4) languages.push('en');
  const fg = gender === 'male' ? (rnd() < 0.45 ? 'female' : rnd() < 0.05 ? 'male' : 'any') : (rnd() < 0.1 ? 'male' : 'any');
  const interests = [];
  for (let i = Math.floor(rnd() * 4); i > 0; i--) interests.push(pick(INTERESTS));
  return {
    id: `s${id}`, key: `d${id}`, gender, country: c, continent: CONT[c], languages, interests,
    filters: {
      gender: fg,
      country: rnd() < 0.1 ? c : 'any',
      language: rnd() < 0.05 ? languages[0] : 'any',
    },
  };
}

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const mm = new Matchmaker({ scanLimit: 400 });

// ---- steady-state run ----
const lat = new Float64Array(ARRIVALS);
let matched = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < ARRIVALS; i++) {
  const a = arrival();
  const s = process.hrtime.bigint();
  if (mm.enqueue(a)) matched++;
  lat[i] = Number(process.hrtime.bigint() - s) / 1000; // µs
}
const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
const sorted = Array.from(lat).sort((x, y) => x - y);

const ts = process.hrtime.bigint();
const swept = mm.sweep(200);
const sweepMs = Number(process.hrtime.bigint() - ts) / 1e6;

// ---- adversarial: a huge queue of men who only want women, then open-filter arrivals ----
const adv = new Matchmaker({ scanLimit: 400 });
for (let i = 0; i < 100_000; i++) {
  adv.enqueue({ id: `m${i}`, key: `m${i}`, gender: 'male', country: 'IN', continent: 'AS', languages: ['hi'], interests: [], filters: { gender: 'female', country: 'any', language: 'any' } });
}
const advLat = [];
let advMatched = 0;
for (let i = 0; i < 2000; i++) {
  const s = process.hrtime.bigint();
  if (adv.enqueue({ id: `o${i}`, key: `o${i}`, gender: 'male', country: 'US', continent: 'NA', languages: ['en'], interests: [], filters: { gender: 'any', country: 'any', language: 'any' } })) advMatched++;
  advLat.push(Number(process.hrtime.bigint() - s) / 1000);
}
advLat.sort((x, y) => x - y);

const mem = process.memoryUsage();
const result = {
  arrivals: ARRIVALS,
  opsPerSec: Math.round(ARRIVALS / (totalMs / 1000)),
  enqueueMicros: { p50: +pct(sorted, 0.5).toFixed(1), p99: +pct(sorted, 0.99).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1) },
  pairsFormed: matched,
  stillWaiting: mm.size,
  sweep200Ms: +sweepMs.toFixed(2),
  sweepPairs: swept.length,
  adversarial: {
    queuedMenWantingWomen: 100_000,
    openFilterArrivals: 2000,
    paired: advMatched,
    enqueueMicros: { p50: +pct(advLat, 0.5).toFixed(1), p99: +pct(advLat, 0.99).toFixed(1) },
  },
  heapMb: Math.round(mem.heapUsed / 1048576),
};

console.log(`\nDunia matchmaker benchmark — ${ARRIVALS.toLocaleString()} arrivals (Node ${process.version})`);
console.log(`  throughput            ${result.opsPerSec.toLocaleString()} enqueues/s (single core)`);
console.log(`  enqueue latency       p50 ${result.enqueueMicros.p50} µs · p99 ${result.enqueueMicros.p99} µs · max ${result.enqueueMicros.max} µs`);
console.log(`  pairs formed          ${matched.toLocaleString()}  (still waiting: ${mm.size.toLocaleString()}, mostly men filtering for women)`);
console.log(`  sweep of 200 oldest   ${result.sweep200Ms} ms`);
console.log(`  adversarial queue     100k men-wanting-women ahead; 2,000 open-filter arrivals → ${advMatched} paired, p99 ${result.adversarial.enqueueMicros.p99} µs`);
console.log(`  heap                  ${result.heapMb} MB\n`);
console.log(JSON.stringify(result));
