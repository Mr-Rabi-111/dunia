import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Safety } from '../server/safety.js';
import { iceServersFor } from '../server/turn.js';
import { clientIp, detectCountry } from '../server/geo.js';
import crypto from 'node:crypto';

const target = { deviceId: 'victim-device-000001', ip: '1.1.1.1', username: 'Bad', gender: 'male', country: 'IN', ipCountry: 'US' };
const reporter = (n, ip = `9.9.9.${n}`) => ({ deviceId: `reporter-device-${String(n).padStart(4, '0')}`, ip, username: `R${n}`, country: 'BR' });

test('one reporter can never restrict someone alone', () => {
  const s = new Safety({ persist: false });
  for (let i = 0; i < 5; i++) s.addReport({ reason: 'underage', reporter: reporter(1), reported: target });
  assert.equal(s.scoreFor(target.deviceId), 3);
  assert.equal(s.findBan({ deviceId: target.deviceId }), null);
});

test('two distinct reporters for a severe reason → automatic restriction incl. IP', () => {
  const s = new Safety({ persist: false });
  s.addReport({ reason: 'sexual', reporter: reporter(1), reported: target });
  const { autoBan } = s.addReport({ reason: 'sexual', reporter: reporter(2), reported: target });
  assert.ok(autoBan);
  assert.equal(autoBan.ipBan, true);
  assert.ok(s.findBan({ ip: '1.1.1.1' }), 'new connections from the IP are blocked for severe reasons');
  assert.ok(autoBan.until - Date.now() > 23 * 3600_000, 'device restricted 24 h');
  assert.ok(autoBan.ipUntil - Date.now() <= 2 * 3600_000, 'IP restricted only briefly (CGNAT)');
  assert.equal(s.findBan({ ip: '1.1.1.1' }, Date.now() + 3 * 3600_000), null, 'IP free again after 2 h');
  assert.ok(s.findBan({ deviceId: target.deviceId }, Date.now() + 3 * 3600_000), 'device still restricted');
});

test('mild reasons restrict by device only (CGNAT-safe)', () => {
  const s = new Safety({ persist: false });
  for (let i = 1; i <= 4; i++) s.addReport({ reason: 'spam', reporter: reporter(i), reported: target });
  const ban = s.findBan({ deviceId: target.deviceId });
  assert.ok(ban);
  assert.equal(ban.ipBan, false);
  assert.equal(s.findBan({ ip: '1.1.1.1' }), null, 'innocent users on the same IP are not locked out');
});

test('brigading: at most 2 reporters per IP count', () => {
  const s = new Safety({ persist: false });
  for (let i = 1; i <= 6; i++) s.addReport({ reason: 'harassment', reporter: reporter(i, '5.5.5.5'), reported: target });
  assert.equal(s.scoreFor(target.deviceId), 2);
  assert.equal(s.findBan({ deviceId: target.deviceId }), null);
});

test('repeat offenders get the longer restriction', () => {
  const s = new Safety({ persist: false, autoBanHours: 24, repeatBanHours: 168 });
  s.addBan({ deviceId: target.deviceId, hours: 1 });
  s.bans = []; // expired / lifted, history remains
  for (let i = 1; i <= 2; i++) s.addReport({ reason: 'underage', reporter: reporter(i), reported: target });
  const ban = s.findBan({ deviceId: target.deviceId });
  assert.ok(ban.until - Date.now() > 160 * 3600_000);
});

test('dismissed reports stop counting; reporters are rate limited', () => {
  const s = new Safety({ persist: false });
  const { report } = s.addReport({ reason: 'hate', reporter: reporter(1), reported: target });
  s.setReportStatus(report.id, 'dismissed');
  assert.equal(s.scoreFor(target.deviceId), 0);
  const r = reporter(7);
  for (let i = 0; i < 10; i++) s.addReport({ reason: 'spam', reporter: r, reported: { ...target, deviceId: `other-device-${i}-xxxxxx` } });
  assert.equal(s.reporterAllowed(r.deviceId), false);
});

test('bans and reports persist to disk; evidence does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dunia-'));
  const s = new Safety({ dataDir: dir });
  s.addReport({ reason: 'spam', reporter: reporter(1), reported: target, snapshot: 'data:image/jpeg;base64,AAAA' });
  s.addBan({ deviceId: 'persisted-device-00001', hours: 5 });
  s.flush();
  const raw = fs.readFileSync(path.join(dir, 'safety.json'), 'utf8');
  assert.ok(!raw.includes('base64'), 'snapshots are never written to disk');
  const s2 = new Safety({ dataDir: dir }).load();
  assert.equal(s2.reports.length, 1);
  assert.ok(s2.findBan({ deviceId: 'persisted-device-00001' }));
});

test('TURN REST credentials: HMAC-SHA1 over "<expiry>:<user>"', () => {
  const cfg = { stunUrls: ['stun:x'], turnUrls: ['turn:t.example:3478'], turnSecret: 's3cret-s3cret-s3cret', turnTtlSec: 3600 };
  const [, turn] = iceServersFor('device-1', cfg, 1_700_000_000_000);
  assert.equal(turn.username, `${1_700_000_000 + 3600}:device-1`);
  const expected = crypto.createHmac('sha1', cfg.turnSecret).update(turn.username).digest('base64');
  assert.equal(turn.credential, expected);
  assert.equal(iceServersFor('d', { ...cfg, turnUrls: [] }).length, 1, 'STUN only without TURN');
});

test('client IP honours exactly TRUST_PROXY hops; country from edge headers', () => {
  const h = { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }; // spoofed first entry, real client added by our proxy
  assert.equal(clientIp(h, '10.0.0.2', 1), '203.0.113.9');
  assert.equal(clientIp(h, '10.0.0.2', 2), '6.6.6.6');
  assert.equal(clientIp({}, '::ffff:127.0.0.1', 1), '127.0.0.1');
  assert.equal(detectCountry({ 'cf-ipcountry': 'in' }, ''), 'IN');
  assert.equal(detectCountry({ 'cf-ipcountry': 'XX' }, ''), null, 'Cloudflare "unknown" ignored');
  assert.equal(detectCountry({ 'cf-ipcountry': 'T1' }, ''), null, 'Tor ignored');
});
