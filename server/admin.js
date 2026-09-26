import crypto from 'node:crypto';
import express from 'express';
import { COUNTRY_CODES } from '../shared/data.js';

/**
 * Moderator / operator API. Every route requires
 *   Authorization: Bearer <ADMIN_TOKEN>
 * If ADMIN_TOKEN is not set, the whole API answers 404 (disabled).
 *
 * ctx = { config, safety, metrics, snapshot(), enforceBan(ban), countryCounts() }
 */
export function adminRouter(ctx) {
  const r = express.Router();
  r.use(express.json({ limit: '32kb' }));

  r.use((req, res, next) => {
    if (!ctx.config.adminToken) return res.status(404).json({ error: 'admin_disabled' });
    if (!checkToken(req.get('authorization'), ctx.config.adminToken)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  r.get('/overview', (req, res) => {
    const s = ctx.snapshot();
    const counts = ctx.countryCounts();
    const countries = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([code, n]) => ({ code, n }));
    const m = ctx.metrics;
    res.json({
      ...s,
      matchesLastHour: m.matchesHour.total(),
      reportsLastHour: m.reportsHour.total(),
      reports24h: ctx.safety.countReports(24 * 3600_000),
      openReports: ctx.safety.reports.filter((x) => x.status === 'open').length,
      activeBans: ctx.safety.listBans().length,
      waitP50: m.quantile(m.matchWait, 0.5),
      waitP95: m.quantile(m.matchWait, 0.95),
      avgCallSec: m.callDuration.n ? Math.round(m.callDuration.sum / m.callDuration.n) : 0,
      counters: m.counters,
      countries,
      uptimeSec: Math.round((Date.now() - m.startedAt) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    });
  });

  r.get('/reports', (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const status = ['open', 'actioned', 'dismissed'].includes(req.query.status) ? req.query.status : null;
    res.json({ reports: ctx.safety.listReports({ limit, status }) });
  });

  r.post('/reports/:id/dismiss', (req, res) => {
    const ok = ctx.safety.setReportStatus(req.params.id, 'dismissed');
    res.status(ok ? 200 : 404).json({ ok });
  });

  r.get('/bans', (req, res) => res.json({ bans: ctx.safety.listBans() }));

  /** body: { reportId } or { deviceId, ip }, plus hours (0 = permanent), ipBan, reason */
  r.post('/bans', (req, res) => {
    const b = req.body || {};
    let deviceId = typeof b.deviceId === 'string' ? b.deviceId : null;
    let ip = typeof b.ip === 'string' ? b.ip : null;
    let reportId = null;
    if (b.reportId) {
      const rep = ctx.safety.getReport(String(b.reportId));
      if (!rep) return res.status(404).json({ error: 'report_not_found' });
      deviceId = rep.reported.deviceId;
      ip = rep.reported.ip;
      reportId = rep.id;
      ctx.safety.setReportStatus(rep.id, 'actioned');
    }
    if (!deviceId && !ip) return res.status(400).json({ error: 'target_required' });
    const hours = b.hours === 0 || b.hours === '0' ? null : Math.min(24 * 365, Math.max(1, Number(b.hours) || 24));
    const ban = ctx.safety.addBan({
      deviceId,
      ip,
      ipBan: !!b.ipBan || (!deviceId && !!ip),
      reason: typeof b.reason === 'string' ? b.reason.slice(0, 40) : 'guidelines',
      hours,
      source: 'admin',
      reportId,
    });
    ctx.metrics.inc('bans_total');
    const kicked = ctx.enforceBan(ban);
    res.json({ ban, kicked });
  });

  r.delete('/bans/:id', (req, res) => {
    const ok = ctx.safety.removeBan(req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  });

  r.get('/countries', (req, res) => {
    const counts = ctx.countryCounts();
    res.json({ countries: Object.entries(counts).filter(([c]) => COUNTRY_CODES.has(c)).map(([code, n]) => ({ code, n })) });
  });

  return r;
}

export function checkToken(header, token) {
  if (!header || !token) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
