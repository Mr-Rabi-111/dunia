import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { Server } from 'socket.io';

import { config as baseConfig, ROOT, describeConfig, configWarnings } from './config.js';
import { Matchmaker } from './matchmaker.js';
import { Relations } from './relations.js';
import { Safety } from './safety.js';
import { cleanChat, validateUsername, loadBlockedWords } from './moderation.js';
import { clientIp, detectCountry, initGeo } from './geo.js';
import { iceServersFor } from './turn.js';
import { limited, ConnectionCounter } from './rate-limit.js';
import { metrics } from './metrics.js';
import { adminRouter, checkToken } from './admin.js';
import { Premium, PayError } from './premium.js';
import { PlayVerifier, loadServiceAccount, playAccountId } from './play.js';
import QRCode from 'qrcode';
import {
  COUNTRY_CODES, CONTINENT_OF, SPOKEN_CODES, INTERESTS, GENDERS, REPORT_REASONS, REACTIONS,
} from '../shared/data.js';

const ANY_FILTERS = Object.freeze({ gender: 'any', country: 'any', language: 'any' });
const DEVICE_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const SNAPSHOT_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * Build a complete Dunia server. Exported so tests can start isolated
 * instances on random ports with config overrides.
 */
export async function createDunia(overrides = {}) {
  const config = { ...baseConfig, ...overrides };
  const geoMode = await initGeo();
  const blockedWordCount = loadBlockedWords(config.dataDir);

  const safety = new Safety({
    dataDir: config.dataDir,
    autoBanScore: config.autoBanScore,
    autoBanHours: config.autoBanHours,
    repeatBanHours: config.repeatBanHours,
    ipBanHours: config.ipBanHours,
    persist: overrides.persist ?? true,
  }).load();
  const relations = new Relations({ cooldownMs: config.rematchCooldownSec * 1000 });
  const mm = new Matchmaker({
    scanLimit: config.scanLimit,
    canPair: (a, b, now) => relations.canPair(a, b, now),
  });
  const conns = new ConnectionCounter();
  const premium = new Premium({
    dataDir: config.dataDir,
    persist: overrides.persist ?? true,
    upiVpa: config.upiVpa,
    upiName: config.upiName,
    verifyMode: config.upiVerify,
    provisionalMaxMin: config.provisionalMaxMin,
    trialMin: config.trialMin,
    referralMin: config.referralMin,
    dayOffsetMin: config.rewardDayOffsetMin,
  }).load();
  const play = overrides.playVerifier || new PlayVerifier({
    packageName: config.playPackage,
    serviceAccount: loadServiceAccount(config.playServiceAccount),
  });

  // ------------------------------------------------------------------ HTTP
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), display-capture=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    if (config.isProd) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // gzip/brotli is usually done by the reverse proxy (Caddy); this covers PaaS hosts that don't.
  app.use(compression({ threshold: 1024 }));

  const revalidate = (res, file) => {
    if (/\.(html|js|css|json|webmanifest)$/.test(file)) res.set('Cache-Control', 'no-cache');
  };
  app.use('/shared', express.static(path.join(ROOT, 'shared'), { setHeaders: revalidate }));
  const flagDir = path.join(ROOT, 'node_modules', 'flag-icons');
  app.use('/vendor/flag-icons/css', express.static(path.join(flagDir, 'css'), { maxAge: '7d' }));
  app.use('/vendor/flag-icons/flags', express.static(path.join(flagDir, 'flags'), { maxAge: '30d', immutable: true }));
  // Fonts are self-hosted: faster, works offline/behind firewalls, and no visitor
  // IPs are sent to Google (embedding Google Fonts has been ruled a GDPR breach in the EU).
  const fontDir = path.join(ROOT, 'node_modules', '@fontsource-variable');
  app.use('/vendor/fonts/bricolage', express.static(path.join(fontDir, 'bricolage-grotesque'), { maxAge: '30d' }));
  app.use('/vendor/fonts/jakarta', express.static(path.join(fontDir, 'plus-jakarta-sans'), { maxAge: '30d' }));
  app.use(express.static(path.join(ROOT, 'public'), { setHeaders: revalidate, extensions: ['html'] }));

  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...snapshot(), uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000) });
  });

  // Android App Links: lets https://<domain>/?ref=CODE invite links open the Dunia app.
  app.get('/.well-known/assetlinks.json', (req, res) => {
    const fps = config.androidCertSha256;
    res.json(fps.length ? config.androidPackages.map((pkg) => ({
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps },
    })) : []);
  });

  // UPI QR for a payment order (order ids are unguessable UUIDs).
  app.get('/api/pay/qr/:id.svg', async (req, res) => {
    const o = premium.getOrder(req.params.id);
    if (!o || o.channel !== 'upi') return res.status(404).end();
    const svg = await QRCode.toString(premium.upiUri(o), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0D1322', light: '#FFFFFF' } });
    res.set('Cache-Control', 'no-store').type('image/svg+xml').send(svg);
  });

  app.get('/metrics', (req, res) => {
    if (!config.metricsPublic && !checkToken(req.get('authorization'), config.adminToken)) {
      return res.status(config.adminToken ? 401 : 404).end();
    }
    const s = snapshot();
    res.type('text/plain; version=0.0.4').send(
      metrics.render({ online: s.online, waiting: s.waiting, in_call_pairs: s.inCall, active_bans: safety.listBans().length }),
    );
  });

  // --------------------------------------------------------------- Sockets
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: config.corsOrigin ? { origin: config.corsOrigin } : undefined,
    maxHttpBufferSize: 400_000, // report snapshots are ~20-60 KB
    pingInterval: 20_000,
    pingTimeout: 25_000,
    perMessageDeflate: false,   // CPU > bandwidth for tiny signaling messages
  });

  const sockets = () => io.of('/').sockets;
  const onlineCount = () => sockets().size;

  function snapshot() {
    let inCall = 0;
    let profiled = 0;
    for (const s of sockets().values()) {
      if (s.data.partnerId) inCall++;
      if (s.data.profile) profiled++;
    }
    return { online: onlineCount(), profiled, waiting: mm.size, inCall: inCall / 2 };
  }

  // Country counts are shown in the country picker; cache so a burst of
  // pickers opening doesn't turn into N full scans.
  let countryCache = { at: 0, counts: {} };
  function countryCounts() {
    const now = Date.now();
    if (now - countryCache.at < 5000) return countryCache.counts;
    const counts = {};
    for (const s of sockets().values()) {
      const c = s.data.profile?.country;
      if (c) counts[c] = (counts[c] || 0) + 1;
    }
    countryCache = { at: now, counts };
    return counts;
  }

  const matchCountCache = new Map();
  function countMatching(filters) {
    const key = `${filters.gender}|${filters.country}|${filters.language}`;
    const now = Date.now();
    const hit = matchCountCache.get(key);
    if (hit && now - hit.at < 3000) return hit.n;
    let n = 0;
    for (const s of sockets().values()) {
      const p = s.data.profile;
      if (p && Matchmaker.satisfies(p, { filters })) n++;
    }
    matchCountCache.set(key, { at: now, n });
    if (matchCountCache.size > 2000) matchCountCache.clear();
    return n;
  }

  function partnerOf(socket) {
    const pid = socket.data.partnerId;
    if (!pid) return null;
    const p = sockets().get(pid);
    return p && p.data.partnerId === socket.id ? p : null;
  }

  function resetMatch(d) {
    d.partnerId = null;
    d.matchId = null;
    d.matchedAt = 0;
    d.messages = [];
  }

  /** End the current conversation. The partner is only ever told "left". */
  function endMatch(socket) {
    const d = socket.data;
    if (!d.partnerId) return;
    const partner = sockets().get(d.partnerId);
    const matchId = d.matchId;
    const seconds = d.matchedAt ? (Date.now() - d.matchedAt) / 1000 : 0;
    if (d.matchedAt) metrics.observeCall(seconds);
    resetMatch(d);
    const paired = partner && partner.data.partnerId === socket.id;
    if (paired) {
      resetMatch(partner.data);
      partner.emit('peer:left', { matchId });
    }
    // Rewards: unlock today's daily reward, pay referral bonuses.
    for (const devId of paired ? [d.deviceId, partner.data.deviceId] : [d.deviceId]) {
      for (const p of premium.noteCall(devId, seconds)) notifyReward(p);
    }
  }

  function socketsOfDevice(deviceId) {
    return [...sockets().values()].filter((s) => s.data.deviceId === deviceId);
  }
  function pushPremium(deviceId) {
    const status = premium.status(deviceId);
    for (const s of socketsOfDevice(deviceId)) s.emit('premium:status', status);
  }
  function notifyReward({ deviceId, minutes, kind }) {
    for (const s of socketsOfDevice(deviceId)) s.emit('reward:event', { kind, minutes });
    pushPremium(deviceId);
  }

  function publicPeer(target, viewer) {
    const p = target.data.profile;
    return {
      username: p.username,
      gender: p.gender,
      country: p.country,
      languages: p.languages,
      verified: p.verified,
      premium: premium.isActive(target.data.deviceId),
      sharedInterests: target.data.interests.filter((t) => viewer.data.interests.includes(t)),
    };
  }

  function entryFor(socket) {
    const d = socket.data;
    return {
      id: socket.id,
      key: d.deviceId,
      gender: d.profile.gender,
      country: d.profile.country,
      continent: d.profile.continent,
      languages: d.profile.languages,
      interests: d.interests,
      filters: d.filters,
      premium: premium.isActive(d.deviceId),
    };
  }

  function enqueue(socket) {
    const d = socket.data;
    if (!d.profile || d.partnerId || !socket.connected) return;
    const entry = entryFor(socket);
    const partner = mm.enqueue(entry);
    if (partner) pair(partner, { ...entry, enqueuedAt: Date.now() });
    else socket.emit('match:searching');
  }

  /** a waited longer → a creates the WebRTC offer. */
  function pair(a, b) {
    const sa = sockets().get(a.id);
    const sb = sockets().get(b.id);
    if (!sa || !sb || sa.data.partnerId || sb.data.partnerId) {
      if (sa && !sa.data.partnerId) enqueue(sa);
      if (sb && !sb.data.partnerId) enqueue(sb);
      return;
    }
    const now = Date.now();
    const matchId = crypto.randomUUID();
    for (const [s, other] of [[sa, sb], [sb, sa]]) {
      s.data.partnerId = other.id;
      s.data.matchId = matchId;
      s.data.matchedAt = now;
      s.data.messages = [];
    }
    relations.notePair(a.key, b.key);
    metrics.inc('matches_total');
    metrics.matchesHour.add();
    metrics.observeWait(Math.max(0, now - (a.enqueuedAt || now)) / 1000);
    metrics.observeWait(Math.max(0, now - (b.enqueuedAt || now)) / 1000);
    sa.emit('match:found', { matchId, initiator: true, peer: publicPeer(sb, sa) });
    sb.emit('match:found', { matchId, initiator: false, peer: publicPeer(sa, sb) });
  }

  /**
   * Disconnect the banned device's live sessions. Other people who merely
   * share the IP (CGNAT, campus Wi-Fi) are never kicked; the IP part of a
   * ban only stops NEW connections for a short window.
   */
  function enforceBan(ban) {
    let kicked = 0;
    for (const s of [...sockets().values()]) {
      const hit = ban.deviceId ? s.data.deviceId === ban.deviceId : ban.ipBan && ban.ip && s.data.ip === ban.ip;
      if (!hit) continue;
      endMatch(s);
      mm.remove(s.id);
      s.emit('banned', { until: ban.until, reason: ban.reason });
      s.disconnect(true);
      kicked++;
    }
    return kicked;
  }

  // Handshake: identity, bans, per-IP connection cap, location.
  io.use((socket, next) => {
    const h = socket.handshake.headers;
    const ip = clientIp(h, socket.handshake.address, config.trustProxy);
    const auth = socket.handshake.auth || {};
    const deviceId = typeof auth.deviceId === 'string' && DEVICE_ID_RE.test(auth.deviceId) ? auth.deviceId : crypto.randomUUID();

    const ban = safety.findBan({ deviceId, ip });
    if (ban) {
      metrics.inc('connect_rejected_total');
      const err = new Error('banned');
      err.data = { until: ban.until, reason: ban.reason };
      return next(err);
    }
    if (conns.count(ip) >= config.maxConnPerIp) {
      metrics.inc('connect_rejected_total');
      return next(new Error('too_many_connections'));
    }
    socket.data.ip = ip;
    socket.data.deviceId = deviceId;
    socket.data.ipCountry = detectCountry(h, ip);
    next();
  });

  io.on('connection', (socket) => {
    const d = socket.data;
    conns.inc(d.ip);
    metrics.inc('connections_total');
    Object.assign(d, { profile: null, filters: ANY_FILTERS, interests: [] });
    resetMatch(d);
    premium.touch(d.deviceId, d.ip);

    socket.emit('welcome', {
      deviceId: d.deviceId,
      iceServers: iceServersFor(d.deviceId, config),
      detectedCountry: d.ipCountry,
      lockCountry: config.lockCountryToIp && !!d.ipCountry,
      online: onlineCount(),
      reportSnapshots: config.reportSnapshots,
      premium: premium.status(d.deviceId),
      pay: {
        upi: !!config.upiVpa,
        upiVpa: config.upiVpa,
        upiName: config.upiName,
        verifyMode: premium.verifyMode,
        provisionalMaxMin: config.provisionalMaxMin,
        play: play.enabled,
        playAccountId: playAccountId(d.deviceId),
      },
    });

    const ackFn = (a) => (typeof a === 'function' ? a : () => {});

    socket.on('profile:set', (p, ack) => {
      ack = ackFn(ack);
      p = p && typeof p === 'object' ? p : {};
      if (limited(socket, 'profile', 12, 60_000)) return ack({ ok: false, error: 'rate_limited' });
      const name = validateUsername(p.username);
      if (!name.ok) return ack({ ok: false, error: name.error });
      if (!GENDERS.includes(p.gender)) return ack({ ok: false, error: 'gender' });
      let country = typeof p.country === 'string' ? p.country.toUpperCase() : '';
      if (config.lockCountryToIp && d.ipCountry) country = d.ipCountry;
      if (!COUNTRY_CODES.has(country)) return ack({ ok: false, error: 'country' });
      const languages = [...new Set(Array.isArray(p.languages) ? p.languages.filter((l) => SPOKEN_CODES.has(l)) : [])].slice(0, 3);
      if (!languages.length) return ack({ ok: false, error: 'languages' });

      d.profile = {
        username: name.name,
        gender: p.gender,
        country,
        continent: CONTINENT_OF[country],
        languages,
        verified: !!d.ipCountry && d.ipCountry === country,
      };
      mm.remove(socket.id); // profile changed: any queued search is stale
      ack({ ok: true, profile: d.profile });
    });

    socket.on('match:find', (p) => {
      p = p && typeof p === 'object' ? p : {};
      if (!d.profile) return socket.emit('match:error', { error: 'profile_required' });
      if (limited(socket, 'find', 30, 10_000)) return socket.emit('match:error', { error: 'rate_limited' });
      const filters = cleanFilters(p.filters);
      // Meeting anyone is free; choosing men-only or women-only needs Premium.
      if (filters.gender !== 'any' && !premium.isActive(d.deviceId)) {
        return socket.emit('match:error', { error: 'premium_required' });
      }
      d.filters = filters;
      d.interests = cleanInterests(p.interests);
      endMatch(socket);
      enqueue(socket);
    });

    socket.on('match:next', () => {
      if (limited(socket, 'find', 30, 10_000)) return socket.emit('match:error', { error: 'rate_limited' });
      endMatch(socket);
      enqueue(socket);
    });

    socket.on('match:stop', () => {
      endMatch(socket);
      mm.remove(socket.id);
      socket.emit('match:stopped');
    });

    socket.on('rtc:signal', (msg) => {
      if (!msg || typeof msg !== 'object' || limited(socket, 'signal', 400, 10_000)) return;
      const partner = partnerOf(socket);
      if (!partner || msg.matchId !== d.matchId) return;
      const out = { matchId: d.matchId };
      const { sdp, candidate } = msg;
      if (sdp && typeof sdp === 'object' && typeof sdp.sdp === 'string' && (sdp.type === 'offer' || sdp.type === 'answer')) {
        out.sdp = { type: sdp.type, sdp: sdp.sdp.slice(0, 60_000) };
      } else if (candidate && typeof candidate === 'object' && typeof candidate.candidate === 'string') {
        out.candidate = {
          candidate: candidate.candidate.slice(0, 1000),
          sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid.slice(0, 64) : null,
          sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null,
          usernameFragment: typeof candidate.usernameFragment === 'string' ? candidate.usernameFragment.slice(0, 256) : null,
        };
      } else return;
      partner.emit('rtc:signal', out);
    });

    socket.on('chat:send', (text, ack) => {
      ack = ackFn(ack);
      const partner = partnerOf(socket);
      if (!partner) return ack({ ok: false, error: 'no_partner' });
      if (limited(socket, 'chat', 20, 10_000)) return ack({ ok: false, error: 'rate_limited' });
      const clean = cleanChat(text, { blockContacts: config.blockContactSharing });
      if (!clean.text) return ack({ ok: false, error: 'empty' });
      const id = crypto.randomUUID();
      d.messages.push({ text: clean.text, at: Date.now() });
      if (d.messages.length > 15) d.messages.shift();
      metrics.inc('chat_messages_total');
      if (clean.filtered) metrics.inc('chat_filtered_total');
      partner.emit('chat:message', { id, text: clean.text });
      ack({ ok: true, id, text: clean.text, filtered: clean.filtered });
    });

    socket.on('chat:typing', (typing) => {
      if (limited(socket, 'typing', 20, 10_000)) return;
      partnerOf(socket)?.emit('chat:typing', !!typing);
    });

    socket.on('react', (emoji) => {
      if (!REACTIONS.includes(emoji) || limited(socket, 'react', 15, 10_000)) return;
      partnerOf(socket)?.emit('react', emoji);
    });

    socket.on('peer:state', (s) => {
      if (!s || typeof s !== 'object' || limited(socket, 'state', 30, 10_000)) return;
      partnerOf(socket)?.emit('peer:state', { mic: !!s.mic, cam: !!s.cam });
    });

    socket.on('report', (p, ack) => {
      ack = ackFn(ack);
      p = p && typeof p === 'object' ? p : {};
      const partner = partnerOf(socket);
      if (!partner) return ack({ ok: false, error: 'no_partner' });
      if (!REPORT_REASONS[p.reason]) return ack({ ok: false, error: 'reason' });
      const pd = partner.data;
      relations.block(d.deviceId, pd.deviceId); // reporting implies "never again"

      // Over-reporting is accepted silently but not counted (no feedback to abusers).
      if (!safety.reporterAllowed(d.deviceId)) {
        endMatch(socket);
        return ack({ ok: true });
      }
      const snapshot =
        config.reportSnapshots && typeof p.snapshot === 'string' && p.snapshot.length < 380_000 && SNAPSHOT_RE.test(p.snapshot)
          ? p.snapshot
          : null;
      const { report, autoBan, score } = safety.addReport({
        reason: p.reason,
        reporter: { deviceId: d.deviceId, ip: d.ip, username: d.profile?.username, country: d.profile?.country },
        reported: {
          deviceId: pd.deviceId, ip: pd.ip, username: pd.profile?.username, gender: pd.profile?.gender,
          country: pd.profile?.country, ipCountry: pd.ipCountry,
        },
        snapshot,
        messages: pd.messages,
      });
      metrics.inc('reports_total');
      metrics.reportsHour.add();
      endMatch(socket);
      if (autoBan) {
        metrics.inc('bans_total');
        enforceBan(autoBan);
      }
      console.log(JSON.stringify({ evt: 'report', id: report.id, reason: p.reason, score, autoBan: !!autoBan }));
      ack({ ok: true });
    });

    socket.on('block', (ack) => {
      ack = ackFn(ack);
      const partner = partnerOf(socket);
      if (partner) relations.block(d.deviceId, partner.data.deviceId);
      endMatch(socket);
      ack({ ok: !!partner });
    });

    socket.on('stats:peek', (p, ack) => {
      ack = ackFn(ack);
      if (limited(socket, 'peek', 12, 10_000)) return ack({ ok: false, error: 'rate_limited' });
      const filters = cleanFilters(p && p.filters);
      let matching = countMatching(filters);
      if (d.profile && Matchmaker.satisfies(d.profile, { filters })) matching = Math.max(0, matching - 1);
      ack({ ok: true, online: onlineCount(), matching, countries: countryCounts() });
    });

    // ------------------------------------------------ premium & payments
    const payHandler = (name, max, windowMs, fn) => socket.on(name, async (p, ack) => {
      if (typeof p === 'function') { ack = p; p = {}; } // emitted without a payload
      ack = ackFn(ack);
      if (limited(socket, name, max, windowMs)) return ack({ ok: false, error: 'rate_limited' });
      try {
        ack({ ok: true, ...(await fn(p && typeof p === 'object' ? p : {})) });
        pushPremium(d.deviceId);
      } catch (err) {
        if (!(err instanceof PayError)) console.error(`[${name}]`, err);
        ack({ ok: false, error: err instanceof PayError ? err.code : 'generic' });
      }
    });

    payHandler('pay:create', 10, 60_000, ({ planId }) => {
      const o = premium.createOrder(d.deviceId, planId);
      metrics.inc('payments_created_total');
      return { order: { id: o.id, code: o.code, inr: o.inr, planId: o.planId, uri: o.uri, qr: `/api/pay/qr/${o.id}.svg`, expiresAt: o.expiresAt } };
    });

    payHandler('pay:submit', 10, 60_000, ({ orderId, utr }) => {
      const r = premium.submitUtr(d.deviceId, String(orderId || ''), utr);
      metrics.inc('payments_submitted_total');
      console.log(JSON.stringify({ evt: 'payment', id: r.order.id, code: r.order.code, inr: r.order.inr, status: r.status }));
      return { status: r.status, grantedMinutes: r.grantedMinutes, until: r.until };
    });

    payHandler('pay:play', 10, 60_000, async ({ productId, purchaseToken }) => {
      if (typeof productId !== 'string' || typeof purchaseToken !== 'string' || purchaseToken.length > 4096) throw new PayError('order');
      if (!premium.productToPlan(productId)) throw new PayError('plan');
      const v = await play.verifyProduct(productId, purchaseToken, playAccountId(d.deviceId));
      if (!v.ok) throw new PayError(v.reason === 'pending' ? 'play_pending' : 'play_invalid');
      const r = premium.grantPlay(d.deviceId, { productId, token: purchaseToken, orderId: v.orderId });
      metrics.inc('payments_approved_total');
      return { until: r.until };
    });

    payHandler('pay:restore', 5, 60_000, ({ ref }) => ({ until: premium.restore(d.deviceId, ref) }));

    payHandler('reward:trial', 5, 60_000, () => ({ until: premium.claimTrial(d.deviceId, d.ip) }));
    payHandler('reward:daily', 5, 60_000, () => premium.claimDaily(d.deviceId));
    payHandler('reward:invite', 10, 60_000, () => ({ code: premium.referralCode(d.deviceId) }));
    payHandler('reward:referral', 5, 60_000, ({ code }) => ({ accepted: premium.setReferrer(d.deviceId, code, d.ip) }));
    payHandler('premium:get', 20, 60_000, () => ({ status: premium.status(d.deviceId) }));

    socket.on('me:delete', (ack) => {
      ack = ackFn(ack);
      if (limited(socket, 'delete', 3, 60_000)) return ack({ ok: false });
      endMatch(socket);
      mm.remove(socket.id);
      premium.deleteDevice(d.deviceId);
      ack({ ok: true });
    });

    socket.on('disconnect', () => {
      conns.dec(d.ip);
      mm.remove(socket.id);
      endMatch(socket);
    });
  });

  // ----------------------------------------------------------- Background
  const timers = [];
  timers.push(setInterval(() => {
    for (const [a, b] of mm.sweep(200)) pair(a, b);
  }, config.sweepIntervalMs));

  let lastOnline = -1;
  timers.push(setInterval(() => {
    const n = onlineCount();
    if (n !== lastOnline) {
      lastOnline = n;
      io.emit('online', n); // throttled: never per connect/disconnect (O(n²) at scale)
    }
  }, 5000));

  timers.push(setInterval(() => {
    relations.prune();
    safety.prune();
  }, 60_000));

  // Premium ran out: turn the gender filter off (never interrupts a live call).
  timers.push(setInterval(() => {
    for (const s of sockets().values()) {
      const f = s.data.filters;
      if (!f || f.gender === 'any' || premium.isActive(s.data.deviceId)) continue;
      s.data.filters = { ...f, gender: 'any' };
      if (mm.has(s.id)) { mm.remove(s.id); enqueue(s); }
      s.emit('premium:expired');
      s.emit('premium:status', premium.status(s.data.deviceId));
    }
  }, overrides.premiumWatchMs || 10_000));

  app.use('/api/admin', adminRouter({ config, safety, metrics, snapshot, enforceBan, countryCounts, premium, pushPremium }));

  return {
    app, server, io, mm, safety, relations, premium, config, geoMode, blockedWordCount,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    async close() {
      timers.forEach(clearInterval);
      safety.flush();
      premium.flush();
      io.emit('server:restarting');
      await new Promise((r) => io.close(() => r()));
    },
  };
}

function cleanFilters(f) {
  f = f && typeof f === 'object' ? f : {};
  return {
    gender: f.gender === 'male' || f.gender === 'female' ? f.gender : 'any',
    country: typeof f.country === 'string' && COUNTRY_CODES.has(f.country) ? f.country : 'any',
    language: typeof f.language === 'string' && SPOKEN_CODES.has(f.language) ? f.language : 'any',
  };
}

function cleanInterests(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((t) => INTERESTS.includes(t)))].slice(0, 5);
}

// ------------------------------------------------------------------- main
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dunia = await createDunia();
  const port = await dunia.listen();
  console.log(`Dunia listening on http://localhost:${port}  (${describeConfig()} geo=${dunia.geoMode} blockedWords=${dunia.blockedWordCount})`);
  for (const w of configWarnings) console.warn(`WARNING: ${w}`);
  if (!dunia.config.turnUrls.length) {
    console.warn('No TURN server configured: ~15% of calls (strict NAT / mobile carriers) will fail to connect. See docs/DEPLOYMENT.md.');
  }

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${sig} received, shutting down gracefully…`);
    const force = setTimeout(() => process.exit(1), 8000);
    force.unref();
    await dunia.close();
    dunia.server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
