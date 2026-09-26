/**
 * Premium, payments and rewards (client side).
 *
 *  - Matching with anyone is free. Choosing "Men" or "Women" needs Premium.
 *  - Paywall: a free trial (once), then honest one-time passes (15 min … 1 month).
 *    Nothing renews by itself.
 *  - Checkout:
 *      web / direct APK → UPI: upi:// link (opens any UPI app) + QR code +
 *                          UTR confirmation.
 *      Play Store build → Google Play Billing through the Android bridge
 *                          (and UPI too only if user choice billing is enrolled).
 *  - Rewards that bring people back without tricks: daily bonus (after one real
 *    chat), invite-a-friend minutes, and "Your world" (countries you've met).
 *
 * Server events: premium:status, premium:expired, reward:event.
 */
import { PLANS, PLAN_BY_ID, STREAK_MINUTES } from '/shared/data.js';
import { t, getLang, fmtNum, fmtDateTime, countryName } from './i18n.js';
import { $, el, flagEl, store } from './util.js';
import { native, nativeCall, usesPlayBilling, upiAllowedHere } from './android.js';

const REMIND_BEFORE_MS = 2 * 60_000;
const REF_RE = /^[A-Z0-9]{4,12}$/;

let ctx = null;        // { getSocket, toast, openModal, closeModals, onActiveChange }
let status = null;     // server premium status
let pay = null;        // server pay config
let playPrices = {};   // productId -> formatted local price (Play build)
let selected = 'week1';
let order = null;
let pendingGender = null;
let remindedFor = 0;
let chipTimer = null;
let wasActive = false;

const P = {
  get active() { return !!(status && status.until > Date.now()); },
  get until() { return status ? status.until : 0; },
};
export const premium = P;

/* -------------------------------------------------------------- helpers */
function emit(event, payload = {}) {
  const socket = ctx.getSocket();
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, error: 'offline' });
    socket.timeout(15_000).emit(event, payload, (err, ack) => resolve(err || !ack ? { ok: false, error: 'generic' } : ack));
  });
}

function inr(amount) {
  try {
    return new Intl.NumberFormat(getLang(), {
      style: 'currency', currency: 'INR',
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `₹${amount}`;
  }
}

/** "12 min", "3 hr", "5 days" in the user's language (Intl unit formatting). */
export function fmtRemaining(ms) {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  const [value, unit] = m < 60 ? [m, 'minute'] : m < 48 * 60 ? [Math.round(m / 60), 'hour'] : [Math.round(m / 1440), 'day'];
  try {
    return new Intl.NumberFormat(getLang(), { style: 'unit', unit, unitDisplay: m < 60 ? 'short' : 'long' }).format(value);
  } catch {
    return `${value} ${unit}`;
  }
}

function payErrorText(code) {
  const k = `pay.err.${code}`;
  const s = t(k);
  return s === k ? t('pay.err.generic') : s;
}

/** Toast with an action button (e.g. "Extend", "Claim"). */
function actionToast(text, actLabel, onAct, ms = 7000) {
  const box = $('toasts');
  const btn = el('button', { class: 'toast-act', type: 'button', text: actLabel });
  const node = el('div', { class: 'toast', role: 'status' }, el('span', { text }), btn);
  const close = () => { node.classList.add('out'); setTimeout(() => node.remove(), 320); };
  btn.addEventListener('click', () => { close(); onAct(); });
  box.append(node);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(close, ms);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = el('textarea', { style: 'position:fixed;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

/* -------------------------------------------------------------- setup */
export function initPremium(options) {
  ctx = options;
  captureReferral();

  $('premChip').addEventListener('click', () => openPaywall());
  $('trialBtn').addEventListener('click', claimTrial);
  $('restoreBtn').addEventListener('click', restorePurchase);
  $('payBack').addEventListener('click', () => showView('plans'));
  $('utrSubmit').addEventListener('click', submitUtr);
  $('utrInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/[^\d]/g, '').slice(0, 12);
    $('payErr').hidden = true;
  });
  $('utrInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitUtr(); });
  $('upiCopy').addEventListener('click', async () => {
    if (await copyText(pay?.upiVpa || '')) ctx.toast(t('pay.copied'), 1600);
  });
  $('upiOpen').addEventListener('click', (e) => {
    if (!order) return;
    e.preventDefault();
    if (native.available) nativeCall('openExternal', { url: order.uri }).catch(() => ctx.toast(payErrorText('generic')));
    else location.href = order.uri;
  });

  $('perkDaily').addEventListener('click', openRewards);
  $('perkInvite').addEventListener('click', openRewards);
  $('perkWorld').addEventListener('click', openRewards);
  $('rwClaim').addEventListener('click', claimDaily);
  $('refShare').addEventListener('click', shareInvite);
  $('refCopy').addEventListener('click', async () => {
    const link = await inviteLink();
    if (link && await copyText(link)) ctx.toast(t('ref.copied'), 1600);
  });

  clearInterval(chipTimer);
  chipTimer = setInterval(tick, 1000);
  renderWorld();
}

/** Called with the welcome payload. */
export async function setServerInfo(w) {
  pay = w.pay || null;
  if (w.premium) setStatus(w.premium);
  if (usesPlayBilling()) {
    try {
      const list = await nativeCall('products', { ids: PLANS.filter((p) => p.play).map((p) => p.play) }, 15_000);
      playPrices = Object.fromEntries((list || []).map((p) => [p.productId, p.price]));
    } catch { playPrices = {}; }
  }
}

export function setStatus(s) {
  if (!s) return;
  status = s;
  const active = P.active;
  if (active !== wasActive) {
    wasActive = active;
    if (active && pendingGender) {
      const g = pendingGender;
      pendingGender = null;
      ctx.onActiveChange(true, g);
    } else {
      ctx.onActiveChange(active, null);
    }
  }
  if (active && P.until - Date.now() > REMIND_BEFORE_MS) remindedFor = 0;
  render();
}

export function onExpired() {
  ctx.toast(t('prem.expired'), 4000);
  wasActive = false;
  ctx.onActiveChange(false, null);
  render();
}

export function onRewardEvent({ kind, minutes } = {}) {
  if (kind === 'daily_unlocked') {
    actionToast(t('rew.unlocked', { n: fmtNum(minutes) }), t('rew.claim', { n: fmtNum(minutes) }), claimDaily, 9000);
  } else if (kind === 'referral') {
    ctx.toast(t('ref.reward', { n: fmtNum(minutes) }), 5000);
  }
}

/* -------------------------------------------------------------- chip, perks, timers */
function tick() {
  if (!status) return;
  const left = P.until - Date.now();
  if (status.active && left <= 0) {
    status = { ...status, active: false, until: 0 };
  }
  if (P.active && left <= REMIND_BEFORE_MS && remindedFor !== P.until) {
    remindedFor = P.until;
    actionToast(t('prem.ending', { n: fmtNum(Math.max(1, Math.ceil(left / 60_000))) }), t('prem.extend'), () => openPaywall(), 10_000);
  }
  renderChip();
}

function renderChip() {
  const chip = $('premChip');
  const active = P.active;
  chip.classList.toggle('is-active', active);
  document.body.classList.toggle('is-premium', active);
  const full = active ? t('prem.left', { time: fmtRemaining(P.until - Date.now()) }) : t('prem.go');
  const narrow = window.matchMedia('(max-width: 640px)').matches; // phones: time only / icon only
  $('premChipText').textContent = narrow ? (active ? fmtRemaining(P.until - Date.now()) : '') : full;
  $('premChipText').hidden = narrow && !active;
  chip.setAttribute('aria-label', full);
  chip.title = full;
}

export function render() {
  renderChip();
  renderPerks();
  if (!$('payModal').hidden && !$('payPlansView').hidden) renderPlans();
  if (!$('rewardsModal').hidden) renderRewards();
}

export function showChip(show) {
  $('premChip').hidden = !show;
}

function renderPerks() {
  if (!status) return;
  const d = status.daily;
  $('perkDailySub').textContent = d.unlocked ? t('perk.claimNow') : d.claimedToday ? t('perk.tomorrow') : t('perk.chatToUnlock');
  $('perkDailyDot').hidden = !d.unlocked;
  const r = status.referral;
  $('perkInviteSub').textContent = r.count ? t('perk.friends', { n: fmtNum(r.count) }) : t('perk.freeMin');
  $('perkWorldSub').textContent = t('perk.countries', { n: fmtNum(world().length) });
}

/* -------------------------------------------------------------- paywall */
function planName(id) { return t(`plan.${id}`); }

function availablePlans() {
  if (usesPlayBilling()) {
    // Play build: Google Play Billing products only (the ₹1 and ₹3 passes are below Play's ₹10 minimum, so they are UPI-only).
    return PLANS.filter((p) => (p.play && playPrices[p.play]) || (!p.play && upiAllowedHere() && pay?.upi));
  }
  return pay?.upi ? PLANS : [];
}

function savePct(plan) {
  const i = PLANS.indexOf(plan);
  if (i <= 0) return 0;
  const prev = PLANS[i - 1];
  const worth = (prev.inr / prev.minutes) * plan.minutes;
  return Math.round((1 - plan.inr / worth) * 100);
}

function priceOf(plan) {
  if (usesPlayBilling() && plan.play && playPrices[plan.play]) return playPrices[plan.play];
  return inr(plan.inr);
}

function subOf(plan) {
  if (usesPlayBilling() && plan.play) return '';
  if (plan.minutes >= 1440) return t('plan.perDay', { price: inr(Math.round((plan.inr / (plan.minutes / 1440)) * 100) / 100) });
  if (plan.minutes > 60) return t('plan.perHour', { price: inr(Math.round((plan.inr / (plan.minutes / 60)) * 100) / 100) });
  return '';
}

export function openPaywall(gender = null) {
  if (gender) pendingGender = gender;
  const plans = availablePlans();
  if (!plans.some((p) => p.id === selected)) selected = plans.find((p) => p.tag === 'popular')?.id || plans[0]?.id || null;
  showView('plans');
  renderPlans();
  ctx.openModal('payModal');
}

function showView(v) {
  $('payPlansView').hidden = v !== 'plans';
  $('payUpiView').hidden = v !== 'upi';
  $('payDoneView').hidden = v !== 'done';
  if (v === 'plans') order = null;
}

function renderPlans() {
  const trial = !!(status && status.trialAvailable && !P.active);
  $('trialBtn').hidden = !trial;
  $('payOr').hidden = !trial;
  if (trial) $('trialBtn').textContent = t('prem.trial', { n: fmtNum(status.trialMinutes) });

  const sub = document.querySelector('#payPlansView .pay-sub');
  sub.textContent = P.active ? t('prem.activeUntil', { time: fmtDateTime(P.until) }) : t('prem.sub');

  const list = $('planList');
  list.replaceChildren();
  for (const plan of availablePlans()) {
    const on = plan.id === selected;
    const save = savePct(plan);
    const subText = subOf(plan);
    const upiOnlyInPlay = usesPlayBilling() && !plan.play;
    const b = el('button', { class: 'plan', type: 'button', role: 'radio', 'aria-checked': String(on), 'data-plan': plan.id },
      el('span', { class: 'plan-radio', 'aria-hidden': 'true' }),
      el('span', { class: 'plan-main' },
        el('span', { class: 'plan-name', text: planName(plan.id) }),
        el('span', { class: 'plan-sub' },
          subText || null,
          subText && save > 0 ? ' · ' : null,
          save > 0 ? el('span', { class: 'plan-save', text: t('plan.save', { n: fmtNum(save) }) }) : null,
          upiOnlyInPlay ? t('plan.upiOnly') : null)),
      el('span', { class: 'plan-price', text: priceOf(plan) }),
      plan.tag ? el('span', { class: 'plan-tag', text: t(plan.tag === 'best' ? 'plan.best' : 'plan.popular') }) : null);
    b.addEventListener('click', () => { selected = plan.id; renderPlans(); });
    list.append(b);
  }
  renderPayActions();
}

function renderPayActions() {
  const box = $('payActions');
  box.replaceChildren();
  const plan = PLAN_BY_ID[selected];
  if (!plan) return;
  const price = priceOf(plan);
  if (usesPlayBilling() && plan.play && playPrices[plan.play]) {
    box.append(el('button', { class: 'btn btn-gold btn-wide', type: 'button', text: t('pay.withPlay', { price }), onclick: () => buyWithPlay(plan) }));
  }
  if (pay?.upi && upiAllowedHere()) {
    const cls = box.children.length ? 'btn btn-ghost btn-wide' : 'btn btn-gold btn-wide';
    box.append(el('button', { class: cls, type: 'button', text: t('pay.withUpi', { price: inr(plan.inr) }), onclick: () => startUpi(plan) }));
  }
}

/* -------------------------------------------------------------- trial */
async function claimTrial() {
  const b = $('trialBtn');
  b.disabled = true;
  const r = await emit('reward:trial');
  b.disabled = false;
  if (!r.ok) {
    ctx.toast(payErrorText(r.error));
    if (status) status.trialAvailable = false;
    renderPlans();
    return;
  }
  status = { ...status, until: r.until, active: true, trialAvailable: false };
  setStatus(status);
  done(t('pay.success', { time: fmtDateTime(r.until) }));
}

function done(text) {
  $('payDoneText').textContent = text;
  showView('done');
}

/* -------------------------------------------------------------- UPI */
async function startUpi(plan) {
  const r = await emit('pay:create', { planId: plan.id });
  if (!r.ok) return ctx.toast(payErrorText(r.error), 4000);
  order = r.order;
  $('upiAmount').textContent = inr(order.inr);
  $('upiPlanName').textContent = planName(order.planId);
  $('upiOpen').href = order.uri;
  $('upiQr').src = order.qr;
  $('upiQr').alt = t('pay.scan');
  $('upiPayee').textContent = t('pay.to', { name: pay.upiName });
  $('upiVpa').textContent = pay.upiVpa;
  $('upiNote').textContent = t('pay.note', { code: order.code });
  $('utrInput').value = '';
  $('payErr').hidden = true;
  showView('upi');
  $('payUpiView').scrollTop = 0;
}

async function submitUtr() {
  if (!order) return;
  const utr = $('utrInput').value.replace(/\D/g, '');
  const err = $('payErr');
  if (utr.length !== 12) {
    err.textContent = payErrorText('utr_invalid');
    err.hidden = false;
    $('utrInput').focus();
    return;
  }
  const btn = $('utrSubmit');
  btn.disabled = true;
  const r = await emit('pay:submit', { orderId: order.id, utr });
  btn.disabled = false;
  if (!r.ok) {
    err.textContent = payErrorText(r.error);
    err.hidden = false;
    return;
  }
  if (r.status === 'active') done(t('pay.success', { time: fmtDateTime(r.until) }));
  else if (r.status === 'partial') done(t('pay.partial', { n: fmtNum(r.grantedMinutes) }));
  else done(t('pay.pending'));
}

/* -------------------------------------------------------------- Google Play */
async function buyWithPlay(plan) {
  let purchase;
  try {
    purchase = await nativeCall('buy', { productId: plan.play, accountId: pay?.playAccountId || '' }, 10 * 60_000);
  } catch (e) {
    if (e.code === 'owned') {
      // A previous purchase was never delivered (app closed mid-purchase): deliver it now.
      const list = await nativeCall('pending', {}, 15_000).catch(() => []);
      await syncPlayPurchases(list);
      return;
    }
    if (e.code !== 'cancelled') ctx.toast(payErrorText(e.code === 'pending' ? 'play_pending' : 'generic'), 4000);
    return;
  }
  const r = await emit('pay:play', { productId: purchase.productId, purchaseToken: purchase.purchaseToken });
  if (!r.ok) {
    ctx.toast(payErrorText(r.error), 5000);
    return;
  }
  // Passes are consumable: consume after the server granted it so it can be bought again.
  nativeCall('consume', { purchaseToken: purchase.purchaseToken }, 30_000).catch(() => {});
  done(t('pay.success', { time: fmtDateTime(r.until) }));
}

/** Purchases the app found on launch that the server has not seen yet (e.g. app killed mid-purchase). */
export async function syncPlayPurchases(list = []) {
  for (const p of list) {
    const r = await emit('pay:play', { productId: p.productId, purchaseToken: p.purchaseToken });
    if (r.ok) nativeCall('consume', { purchaseToken: p.purchaseToken }, 30_000).catch(() => {});
  }
}

/* -------------------------------------------------------------- restore */
async function restorePurchase() {
  const ref = (window.prompt(t('pay.restorePrompt')) || '').trim();
  if (!ref) return;
  const r = await emit('pay:restore', { ref });
  if (!r.ok) return ctx.toast(payErrorText(r.error === 'restore_expired' ? 'restore' : r.error), 4000);
  ctx.toast(t('pay.restored'), 3000);
  ctx.closeModals();
}

/* -------------------------------------------------------------- rewards */
function openRewards() {
  renderRewards();
  ctx.openModal('rewardsModal');
  inviteLink().then(renderRewards);
}

function renderRewards() {
  if (!status) return;
  const d = status.daily;
  const cycle = d.streak ? ((d.streak - 1) % 7) + 1 : 0;
  $('rwStreak').textContent = t('rew.streak', { n: fmtNum(Math.max(1, d.claimedToday ? d.streak : d.streak + 1)) });
  const dots = $('streakDots');
  dots.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const doneDot = d.claimedToday ? i < cycle : i < (cycle === 7 ? 0 : cycle);
    const isNext = !d.claimedToday && i === (cycle === 7 ? 0 : cycle);
    dots.append(el('span', { class: doneDot ? 'done' : isNext ? 'next' : '', text: `+${fmtNum(STREAK_MINUTES[i])}` }));
  }
  const claim = $('rwClaim');
  claim.hidden = !d.unlocked;
  if (d.unlocked) {
    $('rwDailyHint').textContent = t('rew.ready', { n: fmtNum(d.nextMinutes) });
    claim.textContent = t('rew.claim', { n: fmtNum(d.nextMinutes) });
  } else if (d.claimedToday) {
    $('rwDailyHint').textContent = t('rew.claimed', { n: fmtNum(STREAK_MINUTES[d.streak % STREAK_MINUTES.length]) });
  } else {
    $('rwDailyHint').textContent = t('rew.locked', { n: fmtNum(d.nextMinutes) });
  }

  const r = status.referral;
  $('rwInviteHint').textContent = t('ref.hint', { n: fmtNum(r.minutes) });
  $('refLink').textContent = r.code ? linkFor(r.code) : '…';
  $('refCount').textContent = t('ref.count', { n: fmtNum(r.count) });
  renderWorld();
}

async function claimDaily() {
  const b = $('rwClaim');
  b.disabled = true;
  const r = await emit('reward:daily');
  b.disabled = false;
  if (!r.ok) return ctx.toast(t(r.error === 'daily_claimed' ? 'rew.claimed' : 'rew.locked', { n: fmtNum(status?.daily?.nextMinutes || 5) }), 3000);
  ctx.toast(t('rew.got', { n: fmtNum(r.minutes) }), 2600);
}

const linkFor = (code) => `${location.origin}/?ref=${code}`;

async function inviteLink() {
  if (status?.referral?.code) return linkFor(status.referral.code);
  const r = await emit('reward:invite');
  if (!r.ok) return null;
  if (status) status.referral = { ...status.referral, code: r.code };
  return linkFor(r.code);
}

async function shareInvite() {
  const link = await inviteLink();
  if (!link) return ctx.toast(t('err.generic'));
  const text = `${t('ref.message')} ${link}`;
  if (native.available) {
    try { await nativeCall('share', { text }, 60_000); return; } catch { /* fall back */ }
  }
  if (navigator.share) {
    try { await navigator.share({ title: 'Dunia', text: t('ref.message'), url: link }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

/* -------------------------------------------------------------- referral capture */
function captureReferral() {
  try {
    const url = new URL(location.href);
    const code = (url.searchParams.get('ref') || '').toUpperCase();
    if (code) {
      if (REF_RE.test(code) && !store.get('refSent')) store.set('refCode', code);
      url.searchParams.delete('ref');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch { /* ignore */ }
}

/** After the profile is accepted: tell the server who invited us (once). */
export async function afterRegistered() {
  const code = store.get('refCode');
  if (!code || store.get('refSent')) return;
  const r = await emit('reward:referral', { code });
  if (r.ok) {
    store.set('refSent', true);
    store.set('refCode', null);
  }
}

/* -------------------------------------------------------------- "Your world" */
function world() {
  const w = store.get('world');
  return Array.isArray(w) ? w.filter((c) => /^[A-Z]{2}$/.test(c)) : [];
}

/** Record the country of someone we actually talked to. */
export function notePeerCountry(code, own) {
  if (!/^[A-Z]{2}$/.test(code || '')) return;
  const w = world();
  if (w.includes(code)) return;
  w.push(code);
  store.set('world', w);
  if (code !== own) ctx.toast(t('world.new', { country: countryName(code), n: fmtNum(w.length) }), 3200);
  renderPerks();
}

function renderWorld() {
  const w = world();
  $('worldCount').textContent = w.length ? t('world.count', { n: fmtNum(w.length) }) : t('world.empty');
  const box = $('worldFlags');
  box.replaceChildren(...w.map((c) => {
    const f = flagEl(c);
    f.removeAttribute('aria-hidden');
    f.setAttribute('title', countryName(c));
    f.setAttribute('role', 'img');
    f.setAttribute('aria-label', countryName(c));
    return f;
  }));
}

export function resetLocal() {
  pendingGender = null;
}
