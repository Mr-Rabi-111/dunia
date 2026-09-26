import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PLANS, PLAN_BY_ID, STREAK_MINUTES } from '../shared/data.js';

/**
 * Premium passes, payments and rewards.
 *
 * Premium = time-limited access to the gender filter (plus faster matching and
 * a badge). Passes are one-time purchases that ADD time — nothing renews.
 *
 * Payment channels
 *  - UPI (web / direct APK): the server creates an order with a unique note
 *    code and a upi://pay link + QR for the configured UPI ID. The user pays
 *    in any UPI app, then submits the 12-digit UTR (UPI reference).
 *    A personal UPI ID gives the server no way to see payments, so:
 *      provisional (default): up to PROVISIONAL_MAX_MIN starts immediately;
 *        the rest of the pass starts when an admin approves the UTR (or pastes
 *        the day's bank statement UTRs into "Reconcile").
 *      manual: nothing starts until approval.
 *    Fraud limits: unique UTRs, orders expire after 30 min, one unverified
 *    provisional grant per device, max 3 unverified orders per device,
 *    3 rejected UTRs → payments blocked for that device.
 *    For fully automatic confirmation, use a payment gateway (docs/MONETIZATION.md).
 *  - Google Play Billing (Android Play build): the purchase token is verified
 *    with Google's Play Developer API before time is granted (server/play.js).
 *
 * Rewards (engagement without dark patterns)
 *  - Free trial: TRIAL_MIN once per device (max 3 per IP per day).
 *  - Daily reward: after finishing a chat (≥30 s) each day, claim minutes that
 *    grow with the streak (5,5,10,10,15,15,30).
 *  - Referral: when an invited new device finishes its first ≥60 s chat, both
 *    people get REFERRAL_MIN minutes.
 */

const DAY_MS = 86_400_000;
const ORDER_TTL_MS = 30 * 60_000;
const MAX_UNVERIFIED = 3;
const MAX_REJECTS = 3;
const TRIALS_PER_IP_PER_DAY = 3;
const MAX_REFERRAL_REWARDS = 100;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class PayError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function code(n) {
  const b = crypto.randomBytes(n);
  return [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}

export class Premium {
  constructor({
    dataDir = null, persist = true, now = () => Date.now(),
    upiVpa = '', upiName = 'Dunia', verifyMode = 'provisional', provisionalMaxMin = 60,
    trialMin = 10, referralMin = 30, dayOffsetMin = 330, premiumBoost = true,
  } = {}) {
    this.file = dataDir ? path.join(dataDir, 'premium.json') : null;
    this.persist = persist && !!this.file;
    this.now = now;
    this.upiVpa = upiVpa;
    this.upiName = upiName;
    this.verifyMode = verifyMode === 'manual' ? 'manual' : 'provisional';
    this.provisionalMaxMin = provisionalMaxMin;
    this.trialMin = trialMin;
    this.referralMin = referralMin;
    this.dayOffsetMs = dayOffsetMin * 60_000;
    this.premiumBoost = premiumBoost;
    this.devices = new Map(); // deviceId -> record
    this.orders = [];         // newest last
    this.orderById = new Map();
    this.utrIndex = new Map(); // utr -> orderId
    this.codeIndex = new Map(); // referral code -> deviceId
    this.playTokens = new Map(); // purchaseToken -> orderId
    this.trialIps = new Map(); // `${day}|${ip}` -> count
    this._t = null;
  }

  // ------------------------------------------------------------ persistence
  load() {
    if (!this.persist) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [id, d] of Object.entries(raw.devices || {})) this.devices.set(id, d);
      for (const o of raw.orders || []) this._indexOrder(o);
      for (const [id, d] of this.devices) if (d.refCode) this.codeIndex.set(d.refCode, id);
    } catch { /* first run */ }
    return this;
  }

  _indexOrder(o) {
    this.orders.push(o);
    this.orderById.set(o.id, o);
    if (o.utr) this.utrIndex.set(o.utr, o.id);
    if (o.playToken) this.playTokens.set(o.playToken, o.id);
  }

  _save() {
    if (!this.persist || this._t) return;
    this._t = setTimeout(() => this.flush(), 1000);
    this._t.unref?.();
  }

  flush() {
    if (this._t) { clearTimeout(this._t); this._t = null; }
    if (!this.persist) return;
    const now = this.now();
    const devices = {};
    for (const [id, d] of this.devices) {
      // Only keep devices that carry state worth keeping (bounded file size).
      const meaningful = d.until > now - 60 * DAY_MS || d.refCode || d.trialUsed || d.orders || d.referredBy || d.payBlocked;
      if (meaningful) devices[id] = d;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ devices, orders: this.orders }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[premium] could not save:', err.message);
    }
  }

  // ---------------------------------------------------------------- devices
  day(ms = this.now()) {
    return new Date(ms + this.dayOffsetMs).toISOString().slice(0, 10);
  }

  device(id, create = true) {
    let d = this.devices.get(id);
    if (!d && create) {
      d = { until: 0, firstSeen: this.now() };
      this.devices.set(id, d);
    }
    return d || null;
  }

  touch(id, ip) {
    const d = this.device(id);
    d.lastIp = ip;
    d.lastSeen = this.now();
    return d;
  }

  isActive(id) {
    const d = this.devices.get(id);
    return !!d && d.until > this.now();
  }

  until(id) {
    return this.devices.get(id)?.until || 0;
  }

  grant(id, minutes, source) {
    const d = this.device(id);
    const now = this.now();
    d.until = Math.max(now, d.until || 0) + minutes * 60_000;
    d.lastGrant = { minutes, source, at: now };
    this._save();
    return d.until;
  }

  _revoke(id, minutes) {
    const d = this.device(id);
    const now = this.now();
    d.until = Math.max(now, (d.until || 0) - minutes * 60_000);
    if (d.until <= now) d.until = 0;
    this._save();
  }

  referralCode(id) {
    const d = this.device(id);
    if (!d.refCode) {
      let c;
      do { c = code(6); } while (this.codeIndex.has(c));
      d.refCode = c;
      this.codeIndex.set(c, id);
      this._save();
    }
    return d.refCode;
  }

  status(id) {
    const d = this.device(id);
    const now = this.now();
    const today = this.day(now);
    const yesterday = this.day(now - DAY_MS);
    const streakAlive = d.lastClaimDay === today || d.lastClaimDay === yesterday;
    const nextStreak = d.lastClaimDay === today ? d.streak : streakAlive ? (d.streak || 0) + 1 : 1;
    return {
      until: d.until > now ? d.until : 0,
      active: d.until > now,
      trialAvailable: !d.trialUsed && !d.orders,
      trialMinutes: this.trialMin,
      daily: {
        claimedToday: d.lastClaimDay === today,
        unlocked: d.lastCallDay === today && d.lastClaimDay !== today,
        streak: streakAlive ? d.streak || 0 : 0,
        nextMinutes: STREAK_MINUTES[(Math.max(1, nextStreak) - 1) % STREAK_MINUTES.length],
      },
      referral: { code: d.refCode || null, count: d.referrals || 0, minutes: this.referralMin },
      paymentsBlocked: !!d.payBlocked,
    };
  }

  // ----------------------------------------------------------------- UPI
  upiUri(order) {
    const q = new URLSearchParams({
      pa: this.upiVpa,
      pn: this.upiName,
      am: order.inr.toFixed(2),
      cu: 'INR',
      tn: `Dunia ${order.code}`,
    });
    return `upi://pay?${q.toString().replace(/\+/g, '%20')}`;
  }

  createOrder(deviceId, planId) {
    if (!this.upiVpa) throw new PayError('upi_disabled');
    const plan = PLAN_BY_ID[planId];
    if (!plan) throw new PayError('plan');
    const d = this.device(deviceId);
    if (d.payBlocked) throw new PayError('blocked');
    const now = this.now();
    const order = {
      id: crypto.randomUUID(),
      code: `DN${code(6)}`,
      deviceId,
      planId,
      minutes: plan.minutes,
      inr: plan.inr,
      channel: 'upi',
      status: 'created',
      createdAt: now,
      expiresAt: now + ORDER_TTL_MS,
    };
    this._indexOrder(order);
    this._pruneCreated();
    this._save();
    return { ...order, uri: this.upiUri(order) };
  }

  _pruneCreated() {
    // Unpaid orders are noise: drop "created" orders older than a day.
    const cutoff = this.now() - DAY_MS;
    if (this.orders.length < 5000) return;
    this.orders = this.orders.filter((o) => {
      const keep = !(o.status === 'created' && o.createdAt < cutoff);
      if (!keep) this.orderById.delete(o.id);
      return keep;
    });
  }

  getOrder(id) { return this.orderById.get(id) || null; }

  submitUtr(deviceId, orderId, utrRaw) {
    const utr = String(utrRaw || '').replace(/\s+/g, '');
    const o = this.orderById.get(orderId);
    if (!o || o.deviceId !== deviceId || o.channel !== 'upi') throw new PayError('order');
    const d = this.device(deviceId);
    if (d.payBlocked) throw new PayError('blocked');
    if (!/^\d{12}$/.test(utr)) throw new PayError('utr_invalid');
    if (o.status !== 'created') throw new PayError('order');
    if (this.now() > o.expiresAt) throw new PayError('expired');
    if (this.utrIndex.has(utr)) throw new PayError('utr_used');
    const unverified = this.orders.filter((x) => x.deviceId === deviceId && x.status === 'submitted');
    if (unverified.length >= MAX_UNVERIFIED) throw new PayError('too_many');

    o.utr = utr;
    o.status = 'submitted';
    o.submittedAt = this.now();
    this.utrIndex.set(utr, o.id);
    d.orders = (d.orders || 0) + 1;

    let granted = 0;
    const hasProvisional = unverified.some((x) => x.provisionalMin > 0);
    if (this.verifyMode === 'provisional' && !hasProvisional) {
      granted = Math.min(o.minutes, this.provisionalMaxMin);
      o.provisionalMin = granted;
      this.grant(deviceId, granted, 'upi-provisional');
    }
    // Small passes (≤ provisional window) are fully active right away; approval just confirms.
    this._save();
    return { status: granted >= o.minutes ? 'active' : granted > 0 ? 'partial' : 'pending', grantedMinutes: granted, until: this.until(deviceId), order: o };
  }

  approve(orderId, by = 'admin') {
    const o = this.orderById.get(orderId);
    if (!o || o.status !== 'submitted') return null;
    const remaining = o.minutes - (o.provisionalMin || 0);
    if (remaining > 0) this.grant(o.deviceId, remaining, `${o.channel}-approved`);
    o.status = 'approved';
    o.decidedAt = this.now();
    o.decidedBy = by;
    o.accessUntil = this.until(o.deviceId);
    this._save();
    return o;
  }

  reject(orderId, { block = false } = {}) {
    const o = this.orderById.get(orderId);
    if (!o || o.status !== 'submitted') return null;
    if (o.provisionalMin) this._revoke(o.deviceId, o.provisionalMin);
    o.status = 'rejected';
    o.decidedAt = this.now();
    const d = this.device(o.deviceId);
    d.rejects = (d.rejects || 0) + 1;
    if (block || d.rejects >= MAX_REJECTS) d.payBlocked = true;
    this._save();
    return o;
  }

  /** Approve every submitted order whose UTR appears in a pasted bank/UPI statement. */
  reconcile(utrs) {
    const set = new Set((utrs || []).map((u) => String(u).replace(/\D/g, '')).filter((u) => u.length === 12));
    const approved = [];
    for (const o of this.orders) {
      if (o.status === 'submitted' && set.has(o.utr)) approved.push(this.approve(o.id, 'reconcile'));
    }
    return approved;
  }

  /** Move a paid pass to a new device (reinstall / cleared browser). */
  restore(deviceId, ref) {
    const r = String(ref || '').trim();
    const id = this.utrIndex.get(r.replace(/\s+/g, '')) || this.orders.find((o) => o.playOrderId && o.playOrderId === r)?.id;
    const o = id && this.orderById.get(id);
    if (!o || !['approved', 'submitted'].includes(o.status)) throw new PayError('restore');
    o.restores = o.restores || [];
    if (o.restores.length >= 3) throw new PayError('restore');
    const end = o.accessUntil || (o.submittedAt || o.createdAt) + o.minutes * 60_000;
    if (end <= this.now()) throw new PayError('restore_expired');
    const d = this.device(deviceId);
    d.until = Math.max(d.until || 0, end);
    d.orders = (d.orders || 0) + 1;
    o.restores.push({ deviceId, at: this.now() });
    this._save();
    return d.until;
  }

  // ------------------------------------------------------------ Google Play
  productToPlan(productId) {
    return PLANS.find((p) => p.play === productId) || null;
  }

  /** Called after server-side verification succeeded. Idempotent per purchase token. */
  grantPlay(deviceId, { productId, token, orderId }) {
    const plan = this.productToPlan(productId);
    if (!plan) throw new PayError('plan');
    if (this.playTokens.has(token)) {
      const prev = this.orderById.get(this.playTokens.get(token));
      if (prev.deviceId !== deviceId) throw new PayError('order');
      return { until: this.until(deviceId), duplicate: true };
    }
    const o = {
      id: crypto.randomUUID(), code: orderId || 'PLAY', deviceId, planId: plan.id, minutes: plan.minutes,
      inr: null, channel: 'play', status: 'approved', playToken: token, playOrderId: orderId || null,
      createdAt: this.now(), decidedAt: this.now(), decidedBy: 'google-play',
    };
    this._indexOrder(o);
    const d = this.device(deviceId);
    d.orders = (d.orders || 0) + 1;
    this.grant(deviceId, plan.minutes, 'play');
    o.accessUntil = this.until(deviceId);
    this._save();
    return { until: this.until(deviceId), duplicate: false };
  }

  // ---------------------------------------------------------------- rewards
  claimTrial(deviceId, ip) {
    const d = this.device(deviceId);
    if (d.trialUsed || d.orders) throw new PayError('trial_used');
    const key = `${this.day()}|${ip}`;
    const n = this.trialIps.get(key) || 0;
    if (n >= TRIALS_PER_IP_PER_DAY) throw new PayError('trial_limit');
    this.trialIps.set(key, n + 1);
    if (this.trialIps.size > 50_000) this.trialIps.clear();
    d.trialUsed = true;
    return this.grant(deviceId, this.trialMin, 'trial');
  }

  claimDaily(deviceId) {
    const d = this.device(deviceId);
    const today = this.day();
    if (d.lastClaimDay === today) throw new PayError('daily_claimed');
    if (d.lastCallDay !== today) throw new PayError('daily_locked');
    d.streak = d.lastClaimDay === this.day(this.now() - DAY_MS) ? (d.streak || 0) + 1 : 1;
    d.lastClaimDay = today;
    const minutes = STREAK_MINUTES[(d.streak - 1) % STREAK_MINUTES.length];
    this.grant(deviceId, minutes, 'daily');
    return { minutes, streak: d.streak, until: d.until };
  }

  /** Record an invite code for a NEW device. Returns true if accepted. */
  setReferrer(deviceId, refCode, ip) {
    const inviterId = this.codeIndex.get(String(refCode || '').toUpperCase());
    const d = this.device(deviceId);
    if (!inviterId || inviterId === deviceId || d.referredBy || d.orders) return false;
    if (this.now() - (d.firstSeen || 0) > DAY_MS) return false; // only brand-new devices
    const inviter = this.devices.get(inviterId);
    if (!inviter || (ip && inviter.lastIp === ip)) return false; // same network: likely self-referral
    d.referredBy = inviterId;
    this._save();
    return true;
  }

  /**
   * A call ended. Unlocks today's daily reward (≥30 s) and pays the referral
   * reward once (≥60 s). Returns payouts [{deviceId, minutes, kind}].
   */
  noteCall(deviceId, seconds) {
    const d = this.device(deviceId);
    const payouts = [];
    if (seconds >= 30 && d.lastCallDay !== this.day()) {
      d.lastCallDay = this.day();
      payouts.push({ deviceId, minutes: 0, kind: 'daily_unlocked' });
    }
    if (seconds >= 60 && d.referredBy && !d.referralPaid) {
      d.referralPaid = true;
      const inviter = this.devices.get(d.referredBy);
      this.grant(deviceId, this.referralMin, 'referral-invitee');
      payouts.push({ deviceId, minutes: this.referralMin, kind: 'referral' });
      if (inviter && (inviter.referrals || 0) < MAX_REFERRAL_REWARDS) {
        inviter.referrals = (inviter.referrals || 0) + 1;
        this.grant(d.referredBy, this.referralMin, 'referral-inviter');
        payouts.push({ deviceId: d.referredBy, minutes: this.referralMin, kind: 'referral' });
      }
    }
    if (payouts.length) this._save();
    return payouts;
  }

  /** "Delete my data": forget rewards/premium state. Payment records are kept as accounting requires. */
  deleteDevice(deviceId) {
    const d = this.devices.get(deviceId);
    if (d?.refCode) this.codeIndex.delete(d.refCode);
    this.devices.delete(deviceId);
    for (const o of this.orders) if (o.deviceId === deviceId) o.deviceId = 'deleted';
    this._save();
  }

  // ------------------------------------------------------------------ admin
  listOrders({ status = null, limit = 100 } = {}) {
    const out = [];
    for (let i = this.orders.length - 1; i >= 0 && out.length < limit; i--) {
      const o = this.orders[i];
      if (status ? o.status === status : o.status !== 'created') out.push(o);
    }
    return out;
  }

  summary() {
    const now = this.now();
    const today = this.day(now);
    let todayInr = 0, weekInr = 0, totalInr = 0, pending = 0, pendingInr = 0, playCount = 0;
    for (const o of this.orders) {
      if (o.status === 'submitted') { pending++; pendingInr += o.inr || 0; }
      if (o.status !== 'approved') continue;
      if (o.channel === 'play') { playCount++; continue; }
      totalInr += o.inr;
      if (now - o.decidedAt < 7 * DAY_MS) weekInr += o.inr;
      if (this.day(o.decidedAt) === today) todayInr += o.inr;
    }
    let premiumActive = 0;
    for (const d of this.devices.values()) if (d.until > now) premiumActive++;
    return { todayInr, weekInr, totalInr, pending, pendingInr, playCount, premiumActive, verifyMode: this.verifyMode };
  }
}
