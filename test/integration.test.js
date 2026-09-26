import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioc } from 'socket.io-client';
import { createDunia } from '../server/index.js';

const ADMIN = 'test-admin-token-0123456789abcdef';
let dunia;
let url;
const clients = [];

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dunia-it-'));
  fs.writeFileSync(path.join(dataDir, 'blocked-words.txt'), 'badword\n');
  dunia = await createDunia({
    dataDir, persist: false, adminToken: ADMIN, rematchCooldownSec: 0,
    sweepIntervalMs: 200, maxConnPerIp: 500, autoBanScore: 4,
  });
  const port = await dunia.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const c of clients) c.close();
  await dunia.close();
  await new Promise((r) => dunia.server.close(r));
});

let n = 0;
async function user(profile, extra = {}) {
  n += 1;
  const deviceId = extra.deviceId || `device-${String(n).padStart(6, '0')}-abcdef`;
  // Each simulated person gets their own client IP (the server trusts one proxy hop).
  const ip = extra.ip || `10.9.${n >> 8}.${n & 255}`;
  const s = ioc(url, { transports: ['websocket'], auth: { deviceId }, reconnection: false, extraHeaders: { 'x-forwarded-for': ip }, ...extra.opts });
  clients.push(s);
  s.events = [];
  s.onAny((e, ...a) => s.events.push([e, ...a]));
  await new Promise((resolve, reject) => {
    s.once('welcome', resolve);
    s.once('connect_error', reject);
  });
  if (profile) {
    const ack = await s.timeout(3000).emitWithAck('profile:set', { username: `U${n}`, gender: 'male', country: 'IN', languages: ['en'], ...profile });
    s.profileAck = ack;
  }
  return s;
}
const once = (s, evt, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${evt}`)), ms);
  s.once(evt, (d) => { clearTimeout(t); resolve(d); });
});
const find = (s, filters = {}, interests = []) => s.emit('match:find', { filters: { gender: 'any', country: 'any', language: 'any', ...filters }, interests });
const quiet = (ms) => new Promise((r) => setTimeout(r, ms));
async function stopAll(...ss) { for (const s of ss) s.emit('match:stop'); await quiet(50); }

test('profile validation happens on the server', async () => {
  const s = await user(null);
  const bad = await s.timeout(2000).emitWithAck('profile:set', { username: 'admin', gender: 'male', country: 'IN', languages: ['en'] });
  assert.deepEqual(bad, { ok: false, error: 'name_blocked' });
  const badCountry = await s.timeout(2000).emitWithAck('profile:set', { username: 'Ravi', gender: 'male', country: 'ZZ', languages: ['en'] });
  assert.equal(badCountry.error, 'country');
  const ok = await s.timeout(2000).emitWithAck('profile:set', { username: '  राहुल  ', gender: 'male', country: 'in', languages: ['hi', 'hi', 'xx', 'en'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.profile.username, 'राहुल');
  assert.equal(ok.profile.country, 'IN');
  assert.deepEqual(ok.profile.languages, ['hi', 'en']);
  s.close();
});

test('cannot search without a profile', async () => {
  const s = await user(null);
  find(s);
  const e = await once(s, 'match:error');
  assert.equal(e.error, 'profile_required');
  s.close();
});

test('gender + country filters are mutual, with peer profile delivered', async () => {
  const seeker = await user({ username: 'Asha', gender: 'female', country: 'IN', languages: ['hi', 'en'] });
  const wrong = await user({ username: 'Tom', gender: 'male', country: 'US' });
  const right = await user({ username: 'Arjun', gender: 'male', country: 'IN', languages: ['hi'] });
  find(seeker, { gender: 'male', country: 'IN' }, ['music']);
  await once(seeker, 'match:searching');
  find(wrong);
  await once(wrong, 'match:searching');
  const [a, b] = await Promise.all([once(seeker, 'match:found'), (find(right, {}, ['music']), once(right, 'match:found'))]);
  assert.equal(a.peer.username, 'Arjun');
  assert.equal(b.peer.username, 'Asha');
  assert.equal(a.matchId, b.matchId);
  assert.equal(a.initiator, true, 'the one who waited longer makes the offer');
  assert.deepEqual(a.peer.sharedInterests, ['music']);
  assert.equal(a.peer.deviceId, undefined, 'no identifiers leak to the peer');
  assert.equal(a.peer.ip, undefined);
  await stopAll(seeker, wrong, right);
});

test('signaling relays only to the current partner with the right matchId', async () => {
  const x = await user({});
  const y = await user({});
  find(x);
  await once(x, 'match:searching');
  const found = Promise.all([once(x, 'match:found'), once(y, 'match:found')]);
  find(y);
  const [fx] = await found;
  const got = once(y, 'rtc:signal');
  x.emit('rtc:signal', { matchId: 'stale-id', sdp: { type: 'offer', sdp: 'nope' } });
  x.emit('rtc:signal', { matchId: fx.matchId, sdp: { type: 'offer', sdp: 'v=0 real' }, evil: 'dropped' });
  const sig = await got;
  assert.equal(sig.sdp.sdp, 'v=0 real');
  assert.equal(sig.evil, undefined);
  await stopAll(x, y);
});

test('chat is filtered, acknowledged, and relayed; next ends the chat for the partner', async () => {
  const x = await user({});
  const y = await user({});
  find(x);
  await once(x, 'match:searching');
  const found = Promise.all([once(x, 'match:found'), once(y, 'match:found')]);
  find(y);
  const [fx] = await found;
  const recv = once(y, 'chat:message');
  const ack = await x.timeout(2000).emitWithAck('chat:send', 'hi! badword www.scam.io');
  assert.equal(ack.ok, true);
  assert.equal(ack.filtered, true);
  assert.equal((await recv).text, 'hi! ••• •••');
  const left = once(y, 'peer:left');
  x.emit('match:next');
  assert.equal((await left).matchId, fx.matchId);
  await stopAll(x, y);
});

test('blocking prevents ever being matched again', async () => {
  const x = await user({});
  const y = await user({});
  find(x);
  await once(x, 'match:searching');
  const found = Promise.all([once(x, 'match:found'), once(y, 'match:found')]);
  find(y);
  await found;
  assert.deepEqual(await x.timeout(2000).emitWithAck('block'), { ok: true });
  find(x);
  find(y);
  await quiet(700); // several sweeps
  assert.equal(x.events.filter((e) => e[0] === 'match:found').length, 1);
  assert.equal(y.events.filter((e) => e[0] === 'match:found').length, 1);
  await stopAll(x, y);
});

test('two distinct severe reports restrict the offender live and on reconnect; admin sees it', async () => {
  const offender = await user({ username: 'Offender' }, { deviceId: 'offender-device-000001', ip: '172.20.0.9' });
  const bystander = await user({ username: 'Sibling' }, { ip: '172.20.0.9' }); // same household / CGNAT
  const reporters = [await user({}), await user({})];
  for (const r of reporters) {
    find(offender);
    await once(offender, 'match:searching');
    const found = Promise.all([once(offender, 'match:found'), once(r, 'match:found')]);
    find(r);
    await found;
    const ack = await r.timeout(2000).emitWithAck('report', { reason: 'sexual', snapshot: 'data:image/jpeg;base64,/9j/AA==' });
    assert.equal(ack.ok, true);
  }
  const banned = offender.events.find((e) => e[0] === 'banned') || [null, await once(offender, 'banned')];
  assert.ok(banned[1].until > Date.now());

  await assert.rejects(user(null, { deviceId: 'offender-device-000001' }), /banned/, 'device restricted from any IP');
  await assert.rejects(user(null, { ip: '172.20.0.9' }), /banned/, 'fresh device on the same IP blocked briefly (ban evasion)');
  await quiet(50);
  assert.equal(bystander.connected, true, 'people already online on that IP are NOT disconnected');

  const res = await fetch(`${url}/api/admin/reports?limit=10`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  const { reports } = await res.json();
  const mine = reports.filter((r) => r.reported.deviceId === 'offender-device-000001');
  assert.equal(mine.length, 2);
  assert.ok(mine.every((r) => r.banned));
  assert.ok(mine.some((r) => r.snapshot?.startsWith('data:image/jpeg')));
  for (const r of reporters) r.emit('match:stop');
});

test('admin API requires the token; metrics require it too', async () => {
  assert.equal((await fetch(`${url}/api/admin/overview`)).status, 401);
  assert.equal((await fetch(`${url}/api/admin/overview`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const ok = await fetch(`${url}/api/admin/overview`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal(ok.status, 200);
  const o = await ok.json();
  assert.ok(o.matchesLastHour >= 1);
  assert.equal((await fetch(`${url}/metrics`)).status, 401);
  const m = await (await fetch(`${url}/metrics`, { headers: { Authorization: `Bearer ${ADMIN}` } })).text();
  assert.match(m, /dunia_matches_total \d+/);
  assert.match(m, /dunia_match_wait_seconds_bucket\{le="\+Inf"\}/);
});

test('stats:peek counts people matching a filter', async () => {
  const a = await user({ gender: 'female', country: 'JP', languages: ['ja'] });
  const b = await user({ gender: 'female', country: 'JP', languages: ['ja', 'en'] });
  const c = await user({});
  const r = await c.timeout(2000).emitWithAck('stats:peek', { filters: { gender: 'female', country: 'JP', language: 'ja' } });
  assert.equal(r.ok, true);
  assert.equal(r.matching, 2);
  assert.equal(typeof r.countries, 'object'); // country counts are cached for 5 s by design
  a.close(); b.close(); c.close();
});

test('security headers are sent', async () => {
  const res = await fetch(`${url}/`);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/);
});
