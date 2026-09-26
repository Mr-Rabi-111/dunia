import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPORT_REASONS } from '../shared/data.js';

/**
 * Reports and bans (full design in docs/SAFETY.md).
 *
 * Auto-restriction: every report carries a weight (underage 3, sexual 2,
 * violence 2, hate 2, others 1). Within a 24 h window we sum the highest weight
 * each DISTINCT reporter gave a person. At most 2 reporters per IP address are
 * counted, so one person with several devices can't brigade someone off the
 * platform, while many real users behind the same carrier-grade NAT still
 * count. When the score reaches AUTO_BAN_SCORE the person is restricted for
 * AUTO_BAN_HOURS (REPEAT_BAN_HOURS if they were restricted before).
 *
 * Bans always match the device id. They also match the IP address only when
 * the reason is severe (underage / sexual) or a moderator chooses it, and even
 * then only for IP_BAN_HOURS (default 2 h) and only for NEW connections — no
 * one else on that IP is disconnected. In India, Indonesia, Nigeria and many
 * other markets thousands of mobile users share one public IP (CGNAT), so a
 * long or broad IP ban would lock out innocent people. The short IP window
 * exists to slow down ban evasion by clearing browser storage.
 *
 * Persistence: bans, report metadata and ban history go to DATA_DIR/safety.json
 * (debounced). Snapshots and chat evidence stay in memory only and expire.
 */
const WINDOW_MS = 24 * 3600_000;
const MAX_REPORTS = 5000;
const MAX_EVIDENCE = 300;
const EVIDENCE_TTL_MS = 48 * 3600_000;
const REPORTS_PER_HOUR = 10;
const MAX_COUNTED_PER_IP = 2;

export class Safety {
  constructor({ dataDir, autoBanScore = 4, autoBanHours = 24, repeatBanHours = 168, ipBanHours = 2, now = () => Date.now(), persist = true } = {}) {
    this.file = dataDir ? path.join(dataDir, 'safety.json') : null;
    this.autoBanScore = autoBanScore;
    this.autoBanHours = autoBanHours;
    this.repeatBanHours = repeatBanHours;
    this.ipBanHours = ipBanHours;
    this.now = now;
    this.persist = persist && !!this.file;
    this.bans = [];            // {id, deviceId, ip, ipBan, reason, source, createdAt, until, reportId}
    this.reports = [];         // newest last
    this.banHistory = {};      // deviceId -> count
    this.evidence = new Map(); // reportId -> {snapshot, messages, at}
    this.reporterLog = new Map(); // deviceId -> [timestamps]
    this._saveTimer = null;
  }

  load() {
    if (!this.persist) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.bans = Array.isArray(raw.bans) ? raw.bans : [];
      this.reports = Array.isArray(raw.reports) ? raw.reports : [];
      this.banHistory = raw.banHistory && typeof raw.banHistory === 'object' ? raw.banHistory : {};
    } catch {
      /* first run */
    }
    this.prune();
    return this;
  }

  _scheduleSave() {
    if (!this.persist || this._saveTimer) return;
    this._saveTimer = setTimeout(() => this.flush(), 1000);
    this._saveTimer.unref?.();
  }

  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (!this.persist) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ bans: this.bans, reports: this.reports, banHistory: this.banHistory }));
      fs.renameSync(tmp, this.file); // atomic replace
    } catch (err) {
      console.error('[safety] could not save:', err.message);
    }
  }

  prune(now = this.now()) {
    const before = this.bans.length;
    this.bans = this.bans.filter((b) => b.until === null || b.until > now);
    if (this.reports.length > MAX_REPORTS) this.reports.splice(0, this.reports.length - MAX_REPORTS);
    for (const [id, ev] of this.evidence) if (now - ev.at > EVIDENCE_TTL_MS) this.evidence.delete(id);
    for (const [k, ts] of this.reporterLog) {
      const kept = ts.filter((t) => now - t < 3600_000);
      if (kept.length) this.reporterLog.set(k, kept); else this.reporterLog.delete(k);
    }
    if (this.bans.length !== before) this._scheduleSave();
  }

  // ---------------------------------------------------------------- bans
  findBan({ deviceId, ip }, now = this.now()) {
    return (
      this.bans.find(
        (b) =>
          (deviceId && b.deviceId === deviceId && (b.until === null || b.until > now)) ||
          (b.ipBan && ip && b.ip === ip && b.ipUntil > now),
      ) || null
    );
  }

  addBan({ deviceId = null, ip = null, ipBan = false, reason = 'guidelines', hours = this.autoBanHours, source = 'admin', reportId = null }) {
    const now = this.now();
    const until = hours === null || hours <= 0 ? null : now + hours * 3600_000; // null = permanent
    const ipHours = Math.min(this.ipBanHours, until === null ? Infinity : hours);
    const ban = {
      id: crypto.randomUUID(),
      deviceId,
      ip,
      ipBan: !!(ipBan && ip),
      reason,
      source,
      reportId,
      createdAt: now,
      until,
      ipUntil: ipBan && ip ? now + ipHours * 3600_000 : null,
    };
    this.bans.push(ban);
    if (deviceId) this.banHistory[deviceId] = (this.banHistory[deviceId] || 0) + 1;
    this._scheduleSave();
    return ban;
  }

  removeBan(id) {
    const i = this.bans.findIndex((b) => b.id === id);
    if (i === -1) return false;
    this.bans.splice(i, 1);
    this._scheduleSave();
    return true;
  }

  listBans(now = this.now()) {
    return this.bans.filter((b) => b.until === null || b.until > now).slice().reverse();
  }

  // ------------------------------------------------------------- reports
  reporterAllowed(deviceId, now = this.now()) {
    const ts = (this.reporterLog.get(deviceId) || []).filter((t) => now - t < 3600_000);
    this.reporterLog.set(deviceId, ts);
    return ts.length < REPORTS_PER_HOUR;
  }

  /**
   * @param {object} r
   * @param {string} r.reason  key of REPORT_REASONS
   * @param {object} r.reporter {deviceId, ip, username, country}
   * @param {object} r.reported {deviceId, ip, username, gender, country, ipCountry}
   * @param {string} [r.snapshot] data:image/jpeg;base64,...
   * @param {Array}  [r.messages] recent messages the reported person sent
   * @returns {{ report: object, autoBan: object|null, score: number }}
   */
  addReport({ reason, reporter, reported, snapshot = null, messages = [] }) {
    const now = this.now();
    const def = REPORT_REASONS[reason];
    if (!def) throw new Error('unknown reason');
    (this.reporterLog.get(reporter.deviceId) || this.reporterLog.set(reporter.deviceId, []).get(reporter.deviceId)).push(now);

    const report = {
      id: crypto.randomUUID(),
      at: now,
      reason,
      weight: def.weight,
      status: 'open',
      reporter: { deviceId: reporter.deviceId, ip: reporter.ip, username: reporter.username, country: reporter.country },
      reported: {
        deviceId: reported.deviceId,
        ip: reported.ip,
        username: reported.username,
        gender: reported.gender,
        country: reported.country,
        ipCountry: reported.ipCountry || null,
      },
      hasSnapshot: !!snapshot,
      messageCount: messages.length,
    };
    this.reports.push(report);
    if (snapshot || messages.length) {
      this.evidence.set(report.id, { snapshot, messages: messages.slice(-15), at: now });
      if (this.evidence.size > MAX_EVIDENCE) this.evidence.delete(this.evidence.keys().next().value);
    }

    const score = this.scoreFor(reported.deviceId, now);
    let autoBan = null;
    if (score >= this.autoBanScore && !this.findBan({ deviceId: reported.deviceId }, now)) {
      const recent = this._recentReportsAgainst(reported.deviceId, now);
      const severe = recent.some((r) => REPORT_REASONS[r.reason]?.ipBan);
      const repeat = (this.banHistory[reported.deviceId] || 0) > 0;
      autoBan = this.addBan({
        deviceId: reported.deviceId,
        ip: reported.ip,
        ipBan: severe,
        reason,
        hours: repeat ? this.repeatBanHours : this.autoBanHours,
        source: 'auto',
        reportId: report.id,
      });
      for (const r of recent) if (r.status === 'open') r.status = 'actioned';
    }
    this._scheduleSave();
    return { report, autoBan, score };
  }

  _recentReportsAgainst(deviceId, now) {
    return this.reports.filter((r) => r.reported.deviceId === deviceId && now - r.at < WINDOW_MS && r.status !== 'dismissed');
  }

  /** Weighted score from distinct reporters, max 2 counted per reporter IP. */
  scoreFor(deviceId, now = this.now()) {
    const byReporter = new Map(); // reporter deviceId -> {ip, weight}
    for (const r of this._recentReportsAgainst(deviceId, now)) {
      const prev = byReporter.get(r.reporter.deviceId);
      if (!prev || r.weight > prev.weight) byReporter.set(r.reporter.deviceId, { ip: r.reporter.ip, weight: r.weight });
    }
    const perIp = new Map();
    let score = 0;
    for (const { ip, weight } of [...byReporter.values()].sort((a, b) => b.weight - a.weight)) {
      const n = perIp.get(ip) || 0;
      if (n >= MAX_COUNTED_PER_IP) continue;
      perIp.set(ip, n + 1);
      score += weight;
    }
    return score;
  }

  listReports({ limit = 50, status = null } = {}) {
    const out = [];
    for (let i = this.reports.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.reports[i];
      if (status && r.status !== status) continue;
      const ev = this.evidence.get(r.id);
      out.push({
        ...r,
        score: this.scoreFor(r.reported.deviceId),
        banned: !!this.findBan({ deviceId: r.reported.deviceId }),
        snapshot: ev?.snapshot || null,
        messages: ev?.messages || [],
      });
    }
    return out;
  }

  getReport(id) {
    return this.reports.find((r) => r.id === id) || null;
  }

  setReportStatus(id, status) {
    const r = this.getReport(id);
    if (!r) return false;
    r.status = status;
    this._scheduleSave();
    return true;
  }

  countReports(sinceMs, now = this.now()) {
    let n = 0;
    for (let i = this.reports.length - 1; i >= 0; i--) {
      if (now - this.reports[i].at > sinceMs) break;
      n++;
    }
    return n;
  }
}
