/**
 * Dunia matchmaking engine — pure, synchronous, network-free.
 *
 * Algorithm (full write-up in docs/MATCHING.md):
 *
 *  1. HARD constraints — a pair is only possible when BOTH people pass:
 *       - each side's gender filter   (any | male | female)
 *       - each side's country filter  (any | ISO code)
 *       - each side's language filter (any | spoken-language code)
 *       - canPair(): not blocked, not a recent rematch (soft after a wait)
 *
 *  2. ACCEPTANCE INDEX — people are bucketed by who they are AND who they
 *     accept:   gender | genderFilter | countryFilter | languageFilter
 *     (plus a second copy keyed by country). A searcher only reads the buckets
 *     whose members it wants and who want it back, so the typical skew on
 *     random-chat platforms (many men filtering for women) can never bury
 *     compatible people behind thousands of incompatible ones. Buckets are
 *     merged oldest-first (k-way merge on enqueue time) and the scan is
 *     bounded by `scanLimit`, which keeps a search O(1)-ish at any scale.
 *
 *  3. SOFT scoring among compatible candidates (highest wins, ties -> oldest):
 *       score = 3·sharedInterests(≤3) + 4·sharesALanguage + 1·sameContinent
 *             + 2·log2(1 + waitSeconds/10) + 2·premium
 *     The wait term grows without bound, so nobody starves: after ~30 s a
 *     waiting person outranks a stranger who merely shares a language.
 *
 *  4. SWEEP — a periodic pass re-tries the longest-waiting people. It pairs
 *     people whose soft constraints (rematch cooldown) have since relaxed and
 *     anything the scan bound skipped.
 */

const DEFAULT_WEIGHTS = { interest: 3, language: 4, region: 1, wait: 2, premium: 2 };
const GENDERS = ['male', 'female'];

export class Matchmaker {
  /**
   * @param {object}   opts
   * @param {number}   [opts.scanLimit=400]  max candidates examined per search
   * @param {Function} [opts.now]            clock (injectable for tests)
   * @param {Function} [opts.canPair]        (a, b, now) => boolean extra constraint
   * @param {object}   [opts.weights]        scoring weights
   */
  constructor({ scanLimit = 400, now = () => Date.now(), canPair = () => true, weights = {} } = {}) {
    this.scanLimit = scanLimit;
    this.now = now;
    this.canPair = canPair;
    this.w = { ...DEFAULT_WEIGHTS, ...weights };

    /** @type {Map<string, object>} id -> entry (insertion order = FIFO) */
    this.waiting = new Map();
    /** @type {Map<string, Set<string>>} "g|fg|fc|fl" -> ids */
    this.accept = new Map();
    /** @type {Map<string, Set<string>>} "country|g|fg|fc|fl" -> ids */
    this.acceptByCountry = new Map();
    /** @type {Map<string, Set<string>>} spoken language -> ids */
    this.byLanguage = new Map();

    this.stats = { enqueued: 0, matched: 0, scanned: 0 };
  }

  get size() { return this.waiting.size; }
  has(id) { return this.waiting.has(id); }
  get(id) { return this.waiting.get(id); }

  /** Does `cand` satisfy the filters of `seeker`? (one direction) */
  static satisfies(cand, seeker) {
    const f = seeker.filters;
    if (f.gender !== 'any' && cand.gender !== f.gender) return false;
    if (f.country !== 'any' && cand.country !== f.country) return false;
    if (f.language !== 'any' && !cand.languages.includes(f.language)) return false;
    return true;
  }

  /** Mutual compatibility: both filters satisfied + external constraints. */
  compatible(a, b, now = this.now()) {
    return (
      a.id !== b.id &&
      Matchmaker.satisfies(b, a) &&
      Matchmaker.satisfies(a, b) &&
      this.canPair(a, b, now)
    );
  }

  /** Soft preference score of `cand` from `seeker`'s point of view. */
  score(seeker, cand, now = this.now()) {
    let shared = 0;
    for (const t of seeker.interests) if (cand.interests.includes(t)) shared++;
    const sharesLanguage = seeker.languages.some((l) => cand.languages.includes(l)) ? 1 : 0;
    const sameRegion = seeker.continent && seeker.continent === cand.continent ? 1 : 0;
    const waitSec = Math.max(0, (now - cand.enqueuedAt) / 1000);
    return (
      this.w.interest * Math.min(shared, 3) +
      this.w.language * sharesLanguage +
      this.w.region * sameRegion +
      this.w.wait * Math.log2(1 + waitSec / 10) +
      this.w.premium * (cand.premium ? 1 : 0)      // Premium: matched a little faster
    );
  }

  /**
   * Buckets holding exactly the people whose gender/country the seeker wants
   * AND whose gender/country/language filters accept the seeker.
   */
  _acceptSets(seeker) {
    const f = seeker.filters;
    const genders = f.gender === 'any' ? GENDERS : [f.gender];
    const fgs = ['any', seeker.gender];
    const fcs = ['any', seeker.country];
    const fls = ['any', ...seeker.languages];
    const sets = [];
    for (const g of genders) {
      for (const fg of fgs) {
        for (const fc of fcs) {
          for (const fl of fls) {
            const s = f.country === 'any'
              ? this.accept.get(`${g}|${fg}|${fc}|${fl}`)
              : this.acceptByCountry.get(`${f.country}|${g}|${fg}|${fc}|${fl}`);
            if (s && s.size) sets.push(s);
          }
        }
      }
    }
    return sets;
  }

  _candidateSets(seeker) {
    const sets = this._acceptSets(seeker);
    if (seeker.filters.language !== 'any') {
      // The language index may be smaller for a rare language: use whichever is smaller.
      const lang = this.byLanguage.get(seeker.filters.language);
      const acceptSize = sets.reduce((n, s) => n + s.size, 0);
      if (!lang) return [];
      if (lang.size < acceptSize) return [lang];
    }
    return sets;
  }

  /** Oldest-first k-way merge of insertion-ordered id sets. */
  *_merged(sets) {
    if (sets.length === 1) { yield* sets[0]; return; }
    const heads = [];
    for (const s of sets) {
      const it = s.values();
      const cur = it.next();
      if (!cur.done) heads.push({ it, id: cur.value });
    }
    const at = (id) => this.waiting.get(id)?.enqueuedAt ?? 0;
    while (heads.length) {
      let bi = 0;
      let best = at(heads[0].id);
      for (let i = 1; i < heads.length; i++) {
        const t = at(heads[i].id);
        if (t < best) { best = t; bi = i; }
      }
      const h = heads[bi];
      yield h.id;
      const nxt = h.it.next();
      if (nxt.done) heads.splice(bi, 1); else h.id = nxt.value;
    }
  }

  /** Find the best partner for `seeker` among waiting people. Does not mutate. */
  findFor(seeker, limit = this.scanLimit) {
    const now = this.now();
    let best = null;
    let bestScore = -Infinity;
    let scanned = 0;
    for (const id of this._merged(this._candidateSets(seeker))) {
      if (id === seeker.id) continue;
      if (scanned >= limit) break;
      scanned++;
      const cand = this.waiting.get(id);
      if (!cand || !this.compatible(seeker, cand, now)) continue;
      const s = this.score(seeker, cand, now);
      if (s > bestScore) { best = cand; bestScore = s; } // strict > keeps oldest on ties
    }
    this.stats.scanned += scanned;
    return best;
  }

  /**
   * Try to match `entry` immediately. On success the partner is removed from
   * the queue and returned; otherwise `entry` joins the queue and null is returned.
   */
  enqueue(entry) {
    this.remove(entry.id);
    const e = normalizeEntry(entry, this.now());
    this.stats.enqueued++;
    const partner = this.findFor(e);
    if (partner) {
      this.remove(partner.id);
      this.stats.matched++;
      return partner;
    }
    this._insert(e);
    return null;
  }

  /**
   * Re-try the `max` longest-waiting people with a wider scan. Returns
   * [[older, newer], ...]. Map iteration tolerates deletions.
   */
  sweep(max = 200) {
    const pairs = [];
    let n = 0;
    for (const [id, entry] of this.waiting) {
      if (n++ >= max) break;
      if (!this.waiting.has(id)) continue;
      const partner = this.findFor(entry, this.scanLimit * 2);
      if (partner) {
        this.remove(id);
        this.remove(partner.id);
        this.stats.matched++;
        pairs.push([entry, partner]);
      }
    }
    return pairs;
  }

  remove(id) {
    const e = this.waiting.get(id);
    if (!e) return false;
    this.waiting.delete(id);
    for (const [map, key] of indexKeys(e)) delFrom(map === 'a' ? this.accept : map === 'c' ? this.acceptByCountry : this.byLanguage, key, id);
    return true;
  }

  _insert(e) {
    this.waiting.set(e.id, e);
    for (const [map, key] of indexKeys(e)) addTo(map === 'a' ? this.accept : map === 'c' ? this.acceptByCountry : this.byLanguage, key, e.id);
  }
}

function indexKeys(e) {
  const f = e.filters;
  const k = `${e.gender}|${f.gender}|${f.country}|${f.language}`;
  const keys = [['a', k], ['c', `${e.country}|${k}`]];
  for (const l of e.languages) keys.push(['l', l]);
  return keys;
}

function normalizeEntry(entry, now) {
  const f = entry.filters || {};
  return {
    ...entry,
    languages: Array.isArray(entry.languages) ? entry.languages : [],
    interests: Array.isArray(entry.interests) ? entry.interests : [],
    filters: {
      gender: f.gender || 'any',
      country: f.country || 'any',
      language: f.language || 'any',
    },
    enqueuedAt: entry.enqueuedAt ?? now,
  };
}

function addTo(map, key, id) {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(id);
}
function delFrom(map, key, id) {
  const s = map.get(key);
  if (!s) return;
  s.delete(id);
  if (s.size === 0) map.delete(key);
}
