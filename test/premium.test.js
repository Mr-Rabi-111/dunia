import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Premium, PayError } from '../server/premium.js';
import { PlayVerifier, playAccountId } from '../server/play.js';
import { PLANS } from '../shared/data.js';

const MIN = 60_000;
function clock(start = Date.UTC(2026, 8, 26, 6, 0)) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}
const mk = (over = {}) => new Premium({ persist: false, upiVpa: 'abirkumar111@ybl', upiName: 'Dunia', ...over });
const code = (fn) => { try { fn(); } catch (e) { return e instanceof PayError ? e.code : e.message; } return 'no-error'; };

test('plans form an honest volume discount (price per hour always falls)', () => {
  for (let i = 1; i < PLANS.length; i++) {
    assert.ok(PLANS[i].inr / PLANS[i].minutes < PLANS[i - 1].inr / PLANS[i - 1].minutes, PLANS[i].id);
  }
  assert.equal(PLANS[0].inr, 1);
  assert.equal(PLANS[0].minutes, 15);
});

test('UPI order: upi:// link works in any UPI app (pa, am, cu, note with order code)', () => {
  const p = mk();
  const o = p.createOrder('device-aaaaaaaaaaaaaaaa', 'min15');
  const u = new URL(o.uri);
  assert.equal(u.protocol, 'upi:');
  assert.equal(u.searchParams.get('pa'), 'abirkumar111@ybl');
  assert.equal(u.searchParams.get('am'), '1.00');
  assert.equal(u.searchParams.get('cu'), 'INR');
  assert.equal(u.searchParams.get('tn'), `Dunia ${o.code}`);
  assert.match(o.code, /^DN[A-Z2-9]{6}$/);
});

test('provisional: a ₹1 / 15 min pass starts instantly after a valid UTR', () => {
  const now = clock();
  const p = mk({ now });
  const o = p.createOrder('dev-1-aaaaaaaaaaaaaa', 'min15');
  const r = p.submitUtr('dev-1-aaaaaaaaaaaaaa', o.id, '412345678901');
  assert.equal(r.status, 'active');
  assert.equal(p.until('dev-1-aaaaaaaaaaaaaa'), now() + 15 * MIN);
  assert.ok(p.isActive('dev-1-aaaaaaaaaaaaaa'));
});

test('provisional: a monthly pass gives 1 hour now, the rest only after approval', () => {
  const now = clock();
  const p = mk({ now });
  const dev = 'dev-2-aaaaaaaaaaaaaa';
  const o = p.createOrder(dev, 'month1');
  const r = p.submitUtr(dev, o.id, '412345678902');
  assert.equal(r.status, 'partial');
  assert.equal(p.until(dev), now() + 60 * MIN);
  p.approve(o.id);
  assert.equal(p.until(dev), now() + 30 * 1440 * MIN);
});

test('fake UTR: rejection takes the provisional time back; 3 rejections block payments', () => {
  const now = clock();
  const p = mk({ now });
  const dev = 'dev-3-aaaaaaaaaaaaaa';
  for (let i = 0; i < 3; i++) {
    const o = p.createOrder(dev, 'hour1');
    p.submitUtr(dev, o.id, `50000000000${i}`);
    p.reject(o.id);
    assert.equal(p.isActive(dev), false);
  }
  assert.equal(code(() => p.createOrder(dev, 'min15')), 'blocked');
});

test('UTR rules: 12 digits, single use, order expires after 30 min, own orders only', () => {
  const now = clock();
  const p = mk({ now });
  const a = 'dev-4-aaaaaaaaaaaaaa';
  const b = 'dev-5-aaaaaaaaaaaaaa';
  const o1 = p.createOrder(a, 'min15');
  assert.equal(code(() => p.submitUtr(a, o1.id, '12345')), 'utr_invalid');
  assert.equal(code(() => p.submitUtr(b, o1.id, '111122223333')), 'order');
  p.submitUtr(a, o1.id, '111122223333');
  const o2 = p.createOrder(b, 'min15');
  assert.equal(code(() => p.submitUtr(b, o2.id, '1111 2222 3333')), 'utr_used');
  const o3 = p.createOrder(b, 'min15');
  now.advance(31 * MIN);
  assert.equal(code(() => p.submitUtr(b, o3.id, '999988887777')), 'expired');
});

test('only one unverified provisional grant at a time; manual mode grants nothing until approval', () => {
  const p = mk();
  const dev = 'dev-6-aaaaaaaaaaaaaa';
  const o1 = p.createOrder(dev, 'day1');
  assert.equal(p.submitUtr(dev, o1.id, '100000000001').grantedMinutes, 60);
  const o2 = p.createOrder(dev, 'day1');
  assert.equal(p.submitUtr(dev, o2.id, '100000000002').grantedMinutes, 0, 'second unverified order waits');
  const m = mk({ verifyMode: 'manual' });
  const o3 = m.createOrder(dev, 'min15');
  assert.equal(m.submitUtr(dev, o3.id, '100000000003').status, 'pending');
  assert.equal(m.isActive(dev), false);
  m.approve(o3.id);
  assert.equal(m.isActive(dev), true);
});

test('reconcile approves every submitted order whose UTR is in a pasted statement', () => {
  const p = mk();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const dev = `dev-r${i}-aaaaaaaaaaaaa`;
    const o = p.createOrder(dev, 'week1');
    p.submitUtr(dev, o.id, `30000000000${i}`);
    ids.push(o.id);
  }
  const approved = p.reconcile(['300000000000', 'junk', '300000000002']);
  assert.equal(approved.length, 2);
  assert.equal(p.getOrder(ids[1]).status, 'submitted');
  const s = p.summary();
  assert.equal(s.totalInr, 138);
  assert.equal(s.pending, 1);
});

test('passes stack, and restore moves a paid pass to a new device', () => {
  const now = clock();
  const p = mk({ now });
  const dev = 'dev-7-aaaaaaaaaaaaaa';
  const o = p.createOrder(dev, 'hour1');
  p.submitUtr(dev, o.id, '700000000001');
  p.approve(o.id);
  p.grant(dev, 15, 'test');
  assert.equal(p.until(dev), now() + 75 * MIN);
  const fresh = 'dev-8-aaaaaaaaaaaaaa';
  assert.ok(p.restore(fresh, '700000000001') > now());
  assert.equal(code(() => p.restore(fresh, '000000000000')), 'restore');
});

test('free trial once per device and at most 3 per IP per day', () => {
  const p = mk();
  p.claimTrial('dev-t0-aaaaaaaaaaaaa', '9.9.9.9');
  assert.equal(code(() => p.claimTrial('dev-t0-aaaaaaaaaaaaa', '9.9.9.9')), 'trial_used');
  p.claimTrial('dev-t1-aaaaaaaaaaaaa', '9.9.9.9');
  p.claimTrial('dev-t2-aaaaaaaaaaaaa', '9.9.9.9');
  assert.equal(code(() => p.claimTrial('dev-t3-aaaaaaaaaaaaa', '9.9.9.9')), 'trial_limit');
  assert.equal(p.status('dev-t0-aaaaaaaaaaaaa').trialAvailable, false);
});

test('daily reward: unlocked by a real chat, streak grows 5→5→10…, breaks after a missed day', () => {
  const now = clock();
  const p = mk({ now });
  const dev = 'dev-d-aaaaaaaaaaaaaa';
  assert.equal(code(() => p.claimDaily(dev)), 'daily_locked');
  p.noteCall(dev, 10);
  assert.equal(code(() => p.claimDaily(dev)), 'daily_locked', 'a 10-second skip does not count');
  p.noteCall(dev, 45);
  assert.deepEqual([p.claimDaily(dev).minutes, p.status(dev).daily.streak], [5, 1]);
  assert.equal(code(() => p.claimDaily(dev)), 'daily_claimed');
  const mins = [];
  for (let day = 2; day <= 4; day++) { now.advance(86_400_000); p.noteCall(dev, 60); mins.push(p.claimDaily(dev).minutes); }
  assert.deepEqual(mins, [5, 10, 10]);
  now.advance(2 * 86_400_000);
  p.noteCall(dev, 60);
  assert.deepEqual([p.claimDaily(dev).streak], [1], 'missed a day → streak restarts');
});

test('referral: both get minutes after the new friend’s first real chat; self-referral blocked', () => {
  const p = mk();
  const inviter = 'dev-inv-aaaaaaaaaaaa';
  p.touch(inviter, '1.1.1.1');
  const c = p.referralCode(inviter);
  const friend = 'dev-frd-aaaaaaaaaaaa';
  p.touch(friend, '2.2.2.2');
  assert.equal(p.setReferrer(friend, c, '2.2.2.2'), true);
  assert.equal(p.noteCall(friend, 20).filter((x) => x.kind === 'referral').length, 0);
  const pays = p.noteCall(friend, 90).filter((x) => x.kind === 'referral');
  assert.equal(pays.length, 2);
  assert.ok(p.isActive(inviter) && p.isActive(friend));
  assert.equal(p.status(inviter).referral.count, 1);
  assert.equal(p.noteCall(friend, 90).filter((x) => x.kind === 'referral').length, 0, 'paid once');
  const sneaky = 'dev-snk-aaaaaaaaaaaa';
  p.touch(sneaky, '1.1.1.1');
  assert.equal(p.setReferrer(sneaky, c, '1.1.1.1'), false, 'same network as inviter');
  assert.equal(p.setReferrer(inviter, c, '3.3.3.3'), false, 'own code');
});

test('Google Play: purchase verified with a signed service-account JWT; token is single-use', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'dunia@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.example/token' };
  const dev = 'dev-play-aaaaaaaaaaa';
  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push(url);
    if (url === sa.token_uri) {
      const [h, c, sig] = new URLSearchParams(opts.body).get('assertion').split('.');
      const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'));
      assert.ok(ok, 'JWT signature verifies');
      assert.equal(JSON.parse(Buffer.from(c, 'base64url')).scope, 'https://www.googleapis.com/auth/androidpublisher');
      return { ok: true, json: async () => ({ access_token: 'ya29.test', expires_in: 3600 }) };
    }
    assert.equal(opts.headers.Authorization, 'Bearer ya29.test');
    const state = url.includes('tokens/pending') ? 2 : 0;
    return { ok: true, status: 200, json: async () => ({ purchaseState: state, orderId: 'GPA.1234-5678', obfuscatedExternalAccountId: playAccountId(dev) }) };
  };
  const v = new PlayVerifier({ packageName: 'app.dunia.chat', serviceAccount: sa, fetchImpl: fakeFetch });
  const res = await v.verifyProduct('dunia_pass_week1', 'tok-1', playAccountId(dev));
  assert.deepEqual(res, { ok: true, orderId: 'GPA.1234-5678' });
  assert.equal((await v.verifyProduct('dunia_pass_week1', 'pending', playAccountId(dev))).reason, 'pending');
  assert.equal(calls.filter((u) => u === sa.token_uri).length, 1, 'access token cached');
  assert.equal((await v.verifyProduct('dunia_pass_week1', 'tok-2', 'someone-else')).reason, 'account_mismatch');

  const p = mk();
  const first = p.grantPlay(dev, { productId: 'dunia_pass_week1', token: 'tok-1', orderId: res.orderId });
  const again = p.grantPlay(dev, { productId: 'dunia_pass_week1', token: 'tok-1', orderId: res.orderId });
  assert.equal(again.duplicate, true);
  assert.equal(again.until, first.until, 'no double credit');
  assert.ok(p.restore('dev-new-aaaaaaaaaaaa', 'GPA.1234-5678'), 'restore with Google order id');
});
