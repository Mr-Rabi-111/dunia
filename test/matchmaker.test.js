import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matchmaker } from '../server/matchmaker.js';

let seq = 0;
function person(over = {}) {
  seq += 1;
  return {
    id: over.id || `s${seq}`,
    key: over.key || `d${seq}`,
    gender: 'male',
    country: 'IN',
    continent: 'AS',
    languages: ['en'],
    interests: [],
    filters: { gender: 'any', country: 'any', language: 'any' },
    ...over,
  };
}

function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test('open filters: first compatible person is matched, queue empties', () => {
  const mm = new Matchmaker();
  assert.equal(mm.enqueue(person({ id: 'a' })), null);
  const p = mm.enqueue(person({ id: 'b' }));
  assert.equal(p.id, 'a');
  assert.equal(mm.size, 0);
});

test('mutual gender filter: a man looking for women never gets a man', () => {
  const mm = new Matchmaker();
  mm.enqueue(person({ id: 'm1', gender: 'male' }));
  const seeker = person({ id: 'm2', gender: 'male', filters: { gender: 'female', country: 'any', language: 'any' } });
  assert.equal(mm.enqueue(seeker), null, 'no woman waiting');
  const w = mm.enqueue(person({ id: 'w1', gender: 'female' }));
  // w1 (open filters) pairs with the longest-waiting compatible person: m1
  assert.equal(w.id, 'm1');
  const w2 = mm.enqueue(person({ id: 'w2', gender: 'female' }));
  assert.equal(w2.id, 'm2');
});

test('filters are mutual: the other side must accept you too', () => {
  const mm = new Matchmaker();
  mm.enqueue(person({ id: 'us', country: 'US', continent: 'NA', filters: { gender: 'any', country: 'US', language: 'any' } }));
  // Indian user with open filters: would accept the American, but the American only wants US.
  assert.equal(mm.enqueue(person({ id: 'in', country: 'IN' })), null);
  const us2 = mm.enqueue(person({ id: 'us2', country: 'US', continent: 'NA' }));
  assert.equal(us2.id, 'us');
});

test('country filter: India only matches India, USA only matches USA', () => {
  const mm = new Matchmaker();
  const IN = { gender: 'any', country: 'IN', language: 'any' };
  const US = { gender: 'any', country: 'US', language: 'any' };
  mm.enqueue(person({ id: 'in1', country: 'IN', filters: IN }));
  mm.enqueue(person({ id: 'us1', country: 'US', continent: 'NA', filters: US }));
  assert.equal(mm.enqueue(person({ id: 'us2', country: 'US', continent: 'NA', filters: US })).id, 'us1');
  assert.equal(mm.enqueue(person({ id: 'in2', country: 'IN', filters: IN })).id, 'in1');
});

// Waiting men who only want women can't pair with each other, so they stay queued.
test('language filter uses the partner’s spoken languages', () => {
  const mm = new Matchmaker();
  mm.enqueue(person({ id: 'en-only', languages: ['en'], filters: { gender: 'female', country: 'any', language: 'any' } }));
  mm.enqueue(person({ id: 'hi-en', languages: ['hi', 'en'], filters: { gender: 'female', country: 'any', language: 'any' } }));
  const seeker = person({ id: 'x', gender: 'female', languages: ['hi'], filters: { gender: 'any', country: 'any', language: 'hi' } });
  assert.equal(mm.enqueue(seeker).id, 'hi-en');
});

test('scoring: shared language beats queue order when nobody has waited long', () => {
  const now = clock();
  const mm = new Matchmaker({ now });
  mm.enqueue(person({ id: 'es', languages: ['es'], country: 'ES', continent: 'EU', filters: { gender: 'female', country: 'any', language: 'any' } }));
  mm.enqueue(person({ id: 'ta', languages: ['ta'], filters: { gender: 'female', country: 'any', language: 'any' } }));
  now.advance(1000);
  assert.equal(mm.enqueue(person({ id: 'seeker', gender: 'female', languages: ['ta'] })).id, 'ta');
});

test('scoring: shared interests are preferred', () => {
  const mm = new Matchmaker();
  mm.enqueue(person({ id: 'plain', filters: { gender: 'female', country: 'any', language: 'any' } }));
  mm.enqueue(person({ id: 'gamer', interests: ['gaming', 'anime'], filters: { gender: 'female', country: 'any', language: 'any' } }));
  assert.equal(mm.enqueue(person({ id: 's', gender: 'female', interests: ['anime'] })).id, 'gamer');
});

test('aging: someone who waited long outranks a merely better-scored newcomer', () => {
  const now = clock();
  const mm = new Matchmaker({ now });
  mm.enqueue(person({ id: 'old', languages: ['fr'], country: 'FR', continent: 'EU', filters: { gender: 'female', country: 'any', language: 'any' } }));
  now.advance(120_000); // 2 minutes
  mm.enqueue(person({ id: 'fresh', languages: ['hi'], filters: { gender: 'female', country: 'any', language: 'any' } }));
  now.advance(500);
  // seeker shares a language (+4) and region (+1) with "fresh", but "old" has waited 2 min:
  // 2*log2(1+12) ≈ 7.4 > 4 + 1 + ~0.1
  assert.equal(mm.enqueue(person({ id: 's', gender: 'female', languages: ['hi'] })).id, 'old');
});

test('canPair hook (blocks / cooldown) is respected', () => {
  const blocked = new Set(['a|b', 'b|a']);
  const mm = new Matchmaker({ canPair: (x, y) => !blocked.has(`${x.key}|${y.key}`) });
  mm.enqueue(person({ id: 'A', key: 'a' }));
  assert.equal(mm.enqueue(person({ id: 'B', key: 'b' })), null);
  assert.equal(mm.enqueue(person({ id: 'C', key: 'c' })).id, 'A');
});

test('gender index finds the one woman among thousands of waiting men (beyond scan limit)', () => {
  const mm = new Matchmaker({ scanLimit: 50 });
  for (let i = 0; i < 3000; i++) {
    mm.enqueue(person({ id: `m${i}`, gender: 'male', filters: { gender: 'female', country: 'any', language: 'any' } }));
  }
  mm.enqueue(person({ id: 'w', gender: 'female', filters: { gender: 'female', country: 'any', language: 'any' } }));
  const seeker = person({ id: 'w2', gender: 'female', filters: { gender: 'female', country: 'any', language: 'any' } });
  assert.equal(mm.enqueue(seeker).id, 'w');
});

test('no head-of-line blocking: 3,000 men filtering for women never hide two open-filter people', () => {
  const mm = new Matchmaker({ scanLimit: 50 });
  for (let i = 0; i < 3000; i++) mm.enqueue(person({ id: `m${i}`, filters: { gender: 'female', country: 'any', language: 'any' } }));
  assert.equal(mm.enqueue(person({ id: 'open1' })), null);
  assert.equal(mm.enqueue(person({ id: 'open2' })).id, 'open1');
});

test('no head-of-line blocking: US-only waiters never hide Indians from each other', () => {
  const mm = new Matchmaker({ scanLimit: 20 });
  for (let i = 0; i < 1000; i++) mm.enqueue(person({ id: `u${i}`, gender: 'female', country: 'US', continent: 'NA', filters: { gender: 'female', country: 'US', language: 'any' } }));
  mm.enqueue(person({ id: 'in1' }));
  assert.equal(mm.enqueue(person({ id: 'in2' })).id, 'in1');
});

test('sweep pairs people once a soft constraint (rematch cooldown) relaxes', () => {
  let cooling = true;
  const mm = new Matchmaker({ canPair: () => !cooling });
  mm.enqueue(person({ id: 'k1' }));
  assert.equal(mm.enqueue(person({ id: 'k2' })), null);
  assert.equal(mm.sweep().length, 0);
  cooling = false;
  const pairs = mm.sweep();
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].map((p) => p.id), ['k1', 'k2']);
  assert.equal(mm.size, 0);
});

test('remove() cleans every index', () => {
  const mm = new Matchmaker();
  mm.enqueue(person({ id: 'r', gender: 'female', country: 'NG', languages: ['en', 'yo'], filters: { gender: 'male', country: 'any', language: 'any' } }));
  assert.equal(mm.remove('r'), true);
  assert.equal(mm.size, 0);
  assert.equal(mm.accept.size, 0);
  assert.equal(mm.acceptByCountry.size, 0);
  assert.equal(mm.byLanguage.size, 0);
});

test('re-enqueueing the same id does not duplicate it', () => {
  const mm = new Matchmaker();
  const p = person({ id: 'dup', filters: { gender: 'female', country: 'any', language: 'any' } });
  mm.enqueue(p);
  mm.enqueue(p);
  assert.equal(mm.size, 1);
});
