import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanChat, validateUsername, setBlockedWords } from '../server/moderation.js';
import { Relations } from '../server/relations.js';

test('contact sharing is masked: URLs, e-mails (no leftover), phones, handles', () => {
  const cases = [
    ['go to https://evil.example/pay now', 'go to ••• now'],
    ['visit www.spam.com', 'visit •••'],
    ['mail me at rahul.k@gmail.com', 'mail me at •••'],
    ['call +91 98765 43210', 'call •••'],
    ['my number 555-123-4567 ok', 'my number ••• ok'],
    ['add me @cool_guy99 on insta', 'add me ••• on insta'],
  ];
  for (const [input, expected] of cases) {
    const r = cleanChat(input);
    assert.equal(r.text, expected, input);
    assert.equal(r.filtered, true, input);
  }
});

test('normal messages pass unchanged in any script', () => {
  for (const s of ['I am 25 from Kochi', 'नमस्ते, कैसे हो?', 'こんにちは！', 'مرحبا كيف حالك', 'Olá! Tudo bem?', 'score was 3-1']) {
    const r = cleanChat(s);
    assert.equal(r.text, s);
    assert.equal(r.filtered, false);
  }
});

test('control and bidi-override characters are stripped', () => {
  assert.equal(cleanChat('hi‮evil\u0007').text, 'hi evil');
});

test('contact masking can be turned off', () => {
  assert.equal(cleanChat('www.site.com', { blockContacts: false }).text, 'www.site.com');
});

test('blocked words are masked as whole words only', () => {
  setBlockedWords(['badword', 'spam phrase']);
  assert.equal(cleanChat('this BadWord here').text, 'this ••• here');
  assert.equal(cleanChat('a spam phrase!').text, 'a •••!');
  assert.equal(cleanChat('badwordish is fine').text, 'badwordish is fine');
  setBlockedWords([]);
});

test('usernames: worldwide scripts accepted', () => {
  for (const n of ['Anoop', 'राहुल', 'Анна', '明天', 'محمد', 'José María', 'சிவா', 'Nguyễn']) {
    assert.equal(validateUsername(n).ok, true, n);
  }
});

test('usernames: invalid, reserved, phone-like rejected; "Modi" allowed', () => {
  assert.equal(validateUsername('a').error, 'name_invalid');
  assert.equal(validateUsername('x'.repeat(21)).error, 'name_invalid');
  assert.equal(validateUsername('12345').error, 'name_invalid');
  assert.equal(validateUsername('<script>').error, 'name_invalid');
  assert.equal(validateUsername('Admin').error, 'name_blocked');
  assert.equal(validateUsername('admin_123').error, 'name_blocked');
  assert.equal(validateUsername('mod').error, 'name_blocked');
  assert.equal(validateUsername('Call 9876543210').error, 'name_blocked');
  assert.equal(validateUsername('Modi').ok, true);
  assert.equal(validateUsername('Model Ria').ok, true);
});

test('relations: blocks are hard, recent pairs are soft', () => {
  let t = 0;
  const r = new Relations({ cooldownMs: 60_000, softAfterMs: 30_000, now: () => t });
  const a = { key: 'a', enqueuedAt: 0 };
  const b = { key: 'b', enqueuedAt: 0 };
  r.notePair('a', 'b');
  assert.equal(r.canPair(a, b, 1000), false, 'just met');
  assert.equal(r.canPair(a, b, 31_000), true, 'waited 31 s → cooldown relaxes');
  assert.equal(r.canPair({ key: 'a', enqueuedAt: 60_000 }, { key: 'b', enqueuedAt: 60_000 }, 61_000), true, 'cooldown expired');
  r.block('a', 'c');
  assert.equal(r.canPair({ key: 'c', enqueuedAt: 0 }, a, 10_000_000), false, 'block works in both directions');
  t = 31 * 24 * 3600_000;
  r.prune();
  assert.equal(r.blocks.size, 0, 'expired block pruned');
});
