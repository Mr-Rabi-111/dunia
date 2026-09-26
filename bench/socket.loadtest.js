/**
 * End-to-end socket load test: spawns a real Dunia server process and drives
 * N simulated people through connect → profile → find → chat → next, for D
 * seconds. Reports match latency, throughput, and server CPU/memory.
 *
 *   npm run loadtest                    (1000 people, 30 s)
 *   node bench/socket.loadtest.js 3000 60
 *   TARGET=https://your.domain node bench/socket.loadtest.js 500 30   (existing server; needs ADMIN_TOKEN for stats)
 *
 * Note: all clients run in ONE process here, so the client side is often the
 * bottleneck before the server is. Watch the server CPU figure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const N = Number(process.argv[2]) || 1000;
const DURATION = (Number(process.argv[3]) || 30) * 1000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = process.env.ADMIN_TOKEN || 'loadtest-admin-token-0123456789';
const PORT = 3700 + Math.floor(Math.random() * 200);
let TARGET = process.env.TARGET;
let server = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const COUNTRIES = ['IN', 'US', 'BR', 'ID', 'PH', 'MX', 'TR', 'PK', 'GB', 'DE', 'NG', 'VN'];

function cpuTicks(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return Number(f[11]) + Number(f[12]); // utime + stime (clock ticks)
  } catch { return null; }
}
function rssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return Math.round(Number(m[1]) / 1024);
  } catch { return null; }
}

async function main() {
  if (!TARGET) {
    server = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', MAX_CONN_PER_IP: '1000000', ADMIN_TOKEN: ADMIN, REMATCH_COOLDOWN_SEC: '0', DATA_DIR: fs.mkdtempSync('/tmp/dunia-lt-') },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); }));
    TARGET = `http://127.0.0.1:${PORT}`;
  }

  const stats = { connected: 0, matches: 0, chats: 0, nexts: 0, errors: 0, matchWait: [] };
  const clients = [];
  const t0 = Date.now();

  // Connect in waves to avoid a SYN flood on localhost.
  for (let i = 0; i < N; i++) {
    const s = io(TARGET, {
      transports: ['websocket'],
      reconnection: false,
      auth: { deviceId: `loadtest-device-${String(i).padStart(8, '0')}` },
      extraHeaders: { 'x-forwarded-for': `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` },
    });
    clients.push(s);
    s.on('connect_error', () => { stats.errors++; });
    s.on('welcome', async () => {
      stats.connected++;
      const female = i % 2 === 0;
      await s.emitWithAck('profile:set', {
        username: `Load${i}`, gender: female ? 'female' : 'male',
        country: COUNTRIES[i % COUNTRIES.length], languages: i % 3 ? ['en'] : ['en', 'hi'],
      });
      const filters = { gender: i % 10 === 1 ? 'female' : 'any', country: 'any', language: 'any' };
      s.searchStart = Date.now();
      s.emit('match:find', { filters, interests: i % 4 ? [] : ['music'] });
    });
    s.on('match:found', () => {
      stats.matches++;
      stats.matchWait.push(Date.now() - s.searchStart);
      s.talking = setTimeout(async () => {
        const ack = await s.timeout(5000).emitWithAck('chat:send', 'hello from the load test').catch(() => null);
        if (ack?.ok) stats.chats++;
        s.searchStart = Date.now();
        stats.nexts++;
        s.emit('match:next');
      }, 1500 + Math.random() * 3000);
    });
    s.on('peer:left', () => {
      clearTimeout(s.talking);
      s.searchStart = Date.now();
      s.emit('match:next');
    });
    if (i % 200 === 199) await sleep(100);
  }
  const connectMs = Date.now() - t0;

  const cpu0 = server ? cpuTicks(server.pid) : null;
  const w0 = Date.now();
  let peakRss = 0;
  while (Date.now() - w0 < DURATION) {
    await sleep(1000);
    if (server) peakRss = Math.max(peakRss, rssMb(server.pid) || 0);
  }
  const wall = (Date.now() - w0) / 1000;
  const cpu1 = server ? cpuTicks(server.pid) : null;
  const serverCpu = cpu0 !== null && cpu1 !== null ? Math.round(((cpu1 - cpu0) / 100 / wall) * 100) : null;

  let overview = null;
  try {
    overview = await (await fetch(`${TARGET}/api/admin/overview`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
  } catch { /* stats need ADMIN_TOKEN */ }

  const waits = stats.matchWait.sort((a, b) => a - b);
  const summary = {
    people: N,
    connected: stats.connected,
    connectErrors: stats.errors,
    connectAllMs: connectMs,
    durationSec: Math.round(wall),
    matches: stats.matches / 2,
    matchesPerSec: +((stats.matches / 2) / wall).toFixed(1),
    chatMessages: stats.chats,
    matchWaitMs: { p50: pct(waits, 0.5), p95: pct(waits, 0.95), p99: pct(waits, 0.99) },
    serverCpuPercentOfOneCore: serverCpu,
    serverPeakRssMb: server ? peakRss : overview?.memoryMb ?? null,
    serverView: overview && { online: overview.online, inCall: overview.inCall, waiting: overview.waiting, matchesLastHour: overview.matchesLastHour },
  };
  console.log(`\nDunia socket load test — ${N} simulated people for ${summary.durationSec}s`);
  console.log(`  connected           ${stats.connected}/${N} (${stats.errors} errors) in ${connectMs} ms`);
  console.log(`  matches             ${summary.matches} (${summary.matchesPerSec}/s), chat messages ${stats.chats}`);
  console.log(`  time to match       p50 ${summary.matchWaitMs.p50} ms · p95 ${summary.matchWaitMs.p95} ms · p99 ${summary.matchWaitMs.p99} ms`);
  if (server) console.log(`  server              ${serverCpu}% of one core · peak RSS ${peakRss} MB`);
  console.log(JSON.stringify(summary));

  for (const s of clients) s.close();
  if (server) server.kill('SIGTERM');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  if (server) server.kill('SIGTERM');
  process.exit(1);
});
