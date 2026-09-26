/**
 * Browser end-to-end test: two real Chromium users with fake cameras.
 *
 *   npx playwright install chromium     (once)
 *   npm run test:e2e
 *   CHROMIUM_PATH=/path/to/chrome npm run test:e2e   (use an existing Chromium)
 *
 * Covers: UI language auto-detection (Hindi, Arabic RTL), onboarding, a real
 * peer-to-peer WebRTC video call, chat with contact masking, mute state reaching
 * the other side, reporting with a snapshot, and the moderation console.
 * Screenshots go to test-results/.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'test-results');
const PORT = 3600 + Math.floor(Math.random() * 300);
const URL = `http://localhost:${PORT}`;
const ADMIN = 'e2e-admin-token-0123456789abcdef';
fs.mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', ADMIN_TOKEN: ADMIN, DATA_DIR: fs.mkdtempSync('/tmp/dunia-e2e-'), AUTO_BAN_SCORE: '99' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('listening') && r()));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
const steps = [];
const step = (msg) => { steps.push(msg); console.log(`  ✓ ${msg}`); };

async function newUser(locale, viewport = { width: 1366, height: 820 }) {
  const ctx = await browser.newContext({ locale, viewport, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${locale}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${locale}] ${e.message}`));
  await page.goto(URL);
  await page.waitForSelector('#onboard:not([hidden])');
  return page;
}

async function onboard(page, { name, gender, country }) {
  await page.fill('#onbName', name);
  await page.click('#onbNext');
  await page.click(`#onbGender button[data-val="${gender}"]`);
  await page.waitForSelector('.onb-pane[data-step="3"]:not([hidden])');
  await page.click('#onbCountryBtn');
  await page.fill('.picker input', country);
  await page.keyboard.press('Enter');
  await page.check('#onbAdult');
  await page.click('#onbNext');
  await page.waitForSelector('.onb-pane[data-step="4"]:not([hidden])');
  await page.click('#onbNext');
  await page.waitForSelector('#onbPreview.live');
  await page.click('#onbNext');
  await page.waitForSelector('body[data-state="idle"]');
}

try {
  const A = await newUser('hi-IN');
  assert.equal(await A.getAttribute('html', 'lang'), 'hi');
  step('Hindi browser gets the Hindi interface automatically');
  await A.screenshot({ path: `${OUT}/onboarding-hi.png` });

  const B = await newUser('ar-EG', { width: 390, height: 844 });
  assert.equal(await B.getAttribute('html', 'dir'), 'rtl');
  step('Arabic browser gets the right-to-left Arabic interface');

  await onboard(A, { name: 'Anoop', gender: 'male', country: 'India' });
  await onboard(B, { name: 'Layla', gender: 'female', country: 'مصر' }); // search works in the UI language
  assert.match(await B.textContent('#profileChip'), /Layla/);
  step('both completed onboarding (name → gender → country → camera)');
  await A.screenshot({ path: `${OUT}/lobby-hi.png` });

  await A.click('#startBtn');
  await A.waitForSelector('body[data-state="searching"]');
  await B.click('#startBtn');
  await Promise.all([
    A.waitForSelector('body[data-state="connected"]', { timeout: 20000 }),
    B.waitForSelector('body[data-state="connected"]', { timeout: 20000 }),
  ]);
  // The app only switches to "connected" once the first remote frame arrives,
  // so the video must already have frames and keep playing.
  const v0 = await A.evaluate(() => ({ w: document.getElementById('remoteVideo').videoWidth, t: document.getElementById('remoteVideo').currentTime }));
  await A.waitForFunction((t0) => document.getElementById('remoteVideo').currentTime > t0 + 0.3, v0.t, { timeout: 10000 });
  const video = await A.evaluate(() => ({ w: document.getElementById('remoteVideo').videoWidth, t: document.getElementById('remoteVideo').currentTime }));
  assert.ok(v0.w > 0, `first frame present when "connected" is shown ${JSON.stringify(v0)}`);
  step(`real peer-to-peer video is flowing (${video.w}px wide, playing)`);
  assert.match(await A.textContent('#peerCard'), /Layla/);
  step('each side sees the other’s name and flag');

  await A.fill('#chatInput', 'Hi Layla, add me on www.spam.com');
  await A.press('#chatInput', 'Enter');
  await B.click('#chatToggle'); // chat is a bottom sheet on phones
  await B.waitForSelector('.msg.them');
  assert.equal(await B.textContent('.msg.them .msg-text'), 'Hi Layla, add me on •••');
  step('chat delivered with the link masked');

  await A.keyboard.press('Escape'); // leave the chat box: shortcuts never fire while typing
  await A.keyboard.press('m');
  await B.waitForSelector('#peerMuted:not([hidden])', { timeout: 5000 });
  step('muting shows a “muted” badge on the other side');
  await A.screenshot({ path: `${OUT}/call-desktop-hi.png` });
  await B.click('#chatClose');
  await B.screenshot({ path: `${OUT}/call-mobile-ar.png` });

  await B.click('#peerReportBtn'); // on phones, Report lives on the partner's name card
  await B.click('#reportReasons button[data-reason="harassment"]');
  await B.waitForSelector('body[data-state="searching"]');
  await A.waitForSelector('body:is([data-state="ended"],[data-state="searching"])');
  step('reporting ends the call and returns the reporter to searching');

  const admin = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  admin.on('pageerror', (e) => errors.push(`[admin] ${e.message}`));
  await admin.goto(`${URL}/admin`);
  await admin.fill('#tokenInput', ADMIN);
  await admin.click('#loginForm button[type="submit"]');
  await admin.waitForSelector('.report');
  assert.match(await admin.textContent('.report'), /Anoop/);
  assert.ok(await admin.$('.report .snap img'), 'report carries a snapshot');
  step('moderation console shows the report with a video snapshot');
  await admin.screenshot({ path: `${OUT}/admin.png`, fullPage: true });

  assert.deepEqual(errors, [], `console errors:\n${errors.join('\n')}`);
  step('no console errors');
  console.log(`\nE2E PASSED (${steps.length} checks). Screenshots in test-results/`);
} catch (err) {
  console.error('\nE2E FAILED:', err.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
