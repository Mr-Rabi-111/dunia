import { COUNTRY_EN } from '/shared/data.js';
import { $, el } from './util.js';

/**
 * Moderation console. Talks to /api/admin/* with a Bearer token kept in
 * sessionStorage (cleared when the tab closes). Refreshes every 5 s.
 */
const SEVERITY = {
  underage: 'critical', sexual: 'critical',
  violence: 'serious', hate: 'serious',
  harassment: 'warning', spam: 'warning', fake: 'warning',
};
const REASON_LABEL = {
  underage: 'Appears under 18', sexual: 'Nudity / sexual', violence: 'Violence / threats', hate: 'Hate',
  harassment: 'Harassment', spam: 'Spam / scam', fake: 'Fake gender or country',
};
const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const cname = (cc) => (cc ? regionNames?.of(cc) || COUNTRY_EN[cc] || cc : '—');
const nf = new Intl.NumberFormat('en');
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

let token = sessionStorage.getItem('dunia.adminToken') || '';
let status = 'open';
let timer = null;

async function api(path, opts = {}) {
  const res = await fetch(`/api/admin${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) throw Object.assign(new Error('unauthorized'), { code: 401 });
  if (res.status === 404 && path === '/overview') throw Object.assign(new Error('disabled'), { code: 404 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function toast(text) {
  const n = el('div', { class: 'toast', text });
  $('toasts').append(n);
  setTimeout(() => { n.classList.add('out'); setTimeout(() => n.remove(), 300); }, 2400);
}

function flag(cc) {
  return el('span', { class: cc ? `fi fi-${cc.toLowerCase()}` : 'fi fi-globe', 'aria-hidden': 'true' });
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function until(ms) {
  if (ms === null) return 'permanent';
  const h = Math.round((ms - Date.now()) / 3600000);
  return h < 1 ? 'less than 1 h left' : h < 48 ? `${h} h left` : `${Math.round(h / 24)} days left`;
}

function fmtDur(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  return h < 48 ? `${h} h ${Math.floor((sec % 3600) / 60)} min` : `${Math.floor(h / 24)} days`;
}

// ------------------------------------------------------------------ render
function renderKpis(o) {
  const tile = (label, value, sub, hero = false) =>
    el('div', { class: `kpi${hero ? ' kpi-hero' : ''}` },
      el('div', { class: 'kpi-label', text: label }),
      el('div', { class: 'kpi-value', text: value }),
      sub ? el('div', { class: 'kpi-sub', text: sub }) : null);
  const v = (n) => (n >= 10000 ? compact.format(n) : nf.format(n));
  $('kpis').replaceChildren(
    tile('Online now', v(o.online), `${nf.format(o.profiled)} with a profile`, true),
    tile('In calls', v(o.inCall * 2), `${nf.format(o.inCall)} pairs`),
    tile('Waiting for a match', v(o.waiting)),
    tile('Matches, last hour', v(o.matchesLastHour)),
    tile('Open reports', v(o.openReports), `${nf.format(o.reports24h)} in the last 24 h`),
    tile('Active restrictions', v(o.activeBans)),
  );
  $('kpiMeta').textContent =
    `Match wait p50 ≤ ${o.waitP50}s · p95 ≤ ${o.waitP95}s  ·  Average call ${fmtDur(o.avgCallSec)}  ·  ` +
    `Messages filtered ${nf.format(o.counters.chat_filtered_total)} of ${nf.format(o.counters.chat_messages_total)}  ·  ` +
    `Uptime ${fmtDur(o.uptimeSec)}  ·  Memory ${o.memoryMb} MB`;
}

function renderCountries(list) {
  const box = $('countryBars');
  if (!list.length) {
    box.replaceChildren(el('p', { class: 'empty', text: 'Nobody with a profile is online yet.' }));
    return;
  }
  const max = Math.max(...list.map((c) => c.n));
  const total = list.reduce((s, c) => s + c.n, 0);
  box.replaceChildren(...list.slice(0, 15).map((c) => {
    const pct = Math.round((c.n / total) * 100);
    const fill = el('div', { class: 'bar-fill' });
    fill.style.width = `${Math.max(1, (c.n / max) * 100)}%`;
    return el('div', { class: 'bar-row', title: `${cname(c.code)}: ${nf.format(c.n)} online (${pct}% of listed)` },
      el('span', { class: 'bar-name' }, flag(c.code), el('span', { text: cname(c.code) })),
      el('div', { class: 'bar-track' }, fill),
      el('span', { class: 'bar-val', text: nf.format(c.n) }));
  }));
}

function renderReports(reports) {
  const box = $('reports');
  if (!reports.length) {
    box.replaceChildren(el('p', { class: 'empty', text: status === 'open' ? 'No open reports. Nice and quiet.' : 'Nothing here.' }));
    return;
  }
  box.replaceChildren(...reports.map(reportCard));
}

function reportCard(r) {
  const sev = SEVERITY[r.reason] || 'warning';
  const snap = r.snapshot
    ? el('button', { class: 'snap', type: 'button', 'aria-label': 'Enlarge snapshot' }, el('img', { src: r.snapshot, alt: 'Snapshot of the reported video' }))
    : el('div', { class: 'snap', text: 'No image' });
  if (r.snapshot) snap.addEventListener('click', () => { $('lightboxImg').src = r.snapshot; $('lightbox').hidden = false; });

  const rep = r.reported;
  const mismatch = rep.ipCountry && rep.country && rep.ipCountry !== rep.country;
  const facts = el('div', { class: 'r-facts' },
    el('span', { text: rep.gender === 'female' ? 'Female' : rep.gender === 'male' ? 'Male' : 'Unknown gender' }),
    el('span', { text: `Says ${cname(rep.country)}` }),
    rep.ipCountry
      ? el('span', { class: mismatch ? 'warn' : '', text: `Connecting from ${cname(rep.ipCountry)}${mismatch ? ' (does not match)' : ''}` })
      : el('span', { text: 'Connection country unknown' }),
    el('span', {}, 'Score ', el('span', { class: 'r-score', text: `${r.score}` }), ' / auto-restrict at 4'),
    el('span', { text: `Reported by ${r.reporter.username || 'unknown'} (${cname(r.reporter.country)})` }),
  );

  const card = el('article', { class: 'report' },
    snap,
    el('div', {},
      el('div', { class: 'r-top' },
        el('span', { class: `sev sev-${sev}`, text: REASON_LABEL[r.reason] || r.reason }),
        el('span', { class: 'r-time', text: ago(r.at) }),
        el('span', { class: 'r-status', text: r.banned ? 'Restricted' : r.status[0].toUpperCase() + r.status.slice(1) })),
      el('div', { class: 'r-who' }, flag(rep.country), el('strong', { text: rep.username || 'Unknown' })),
      facts,
    ),
  );
  const body = card.lastChild;

  if (r.messages?.length) {
    const list = el('ol', {}, ...r.messages.map((m) => el('li', { text: m.text })));
    body.append(el('details', { class: 'r-msgs' }, el('summary', { text: `Their last ${r.messages.length} message${r.messages.length === 1 ? '' : 's'}` }), list));
  }

  if (!r.banned && r.status !== 'dismissed') {
    const ipBox = el('input', { type: 'checkbox' });
    if (SEVERITY[r.reason] === 'critical') ipBox.checked = true;
    const act = (hours) => async () => {
      try {
        const res = await api('/bans', { method: 'POST', body: JSON.stringify({ reportId: r.id, hours, ipBan: ipBox.checked, reason: r.reason }) });
        toast(`Restricted ${rep.username || 'user'}${res.kicked ? ' and disconnected them' : ''}.`);
        refresh();
      } catch (e) { toast(`Couldn't restrict: ${e.message}`); }
    };
    const b = (label, hours) => el('button', { class: 'btn btn-restrict', type: 'button', text: label, onclick: act(hours) });
    const dismiss = el('button', {
      class: 'btn btn-ghost', type: 'button', text: 'Dismiss',
      onclick: async () => {
        try { await api(`/reports/${r.id}/dismiss`, { method: 'POST' }); toast('Report dismissed.'); refresh(); } catch (e) { toast(e.message); }
      },
    });
    body.append(el('div', { class: 'r-actions' },
      b('Restrict 24 h', 24), b('Restrict 7 days', 168), b('Permanent', 0),
      el('label', {}, ipBox, 'Also restrict their IP'),
      dismiss));
  }
  return card;
}

function renderBans(bans) {
  const box = $('bans');
  if (!bans.length) {
    box.replaceChildren(el('p', { class: 'empty', text: 'No active restrictions.' }));
    return;
  }
  box.replaceChildren(...bans.slice(0, 50).map((b) => {
    const lift = el('button', {
      class: 'btn btn-ghost', type: 'button', text: 'Lift',
      onclick: async () => {
        try { await api(`/bans/${b.id}`, { method: 'DELETE' }); toast('Restriction lifted.'); refresh(); } catch (e) { toast(e.message); }
      },
    });
    const target = b.deviceId ? `Device ${b.deviceId.slice(0, 8)}…` : `IP ${b.ip}`;
    return el('div', { class: 'ban' },
      el('div', { class: 'ban-main' },
        el('strong', { text: `${REASON_LABEL[b.reason] || b.reason} · ${until(b.until)}` }),
        el('span', { text: `${target}${b.ipBan ? ' + IP' : ''} · ${b.source === 'auto' ? 'automatic' : 'by moderator'} · ${ago(b.createdAt)}` })),
      lift);
  }));
}

// ------------------------------------------------------------------- flow
async function refresh() {
  try {
    const [o, reps, bans] = await Promise.all([
      api('/overview'),
      api(`/reports?limit=60${status ? `&status=${status}` : ''}`),
      api('/bans'),
    ]);
    renderKpis(o);
    renderCountries(o.countries);
    renderReports(reps.reports);
    renderBans(bans.bans);
    $('livePill').classList.remove('stale');
    $('liveText').textContent = 'Live';
  } catch (e) {
    if (e.code === 401) return signOut('That token was rejected.');
    $('livePill').classList.add('stale');
    $('liveText').textContent = 'Reconnecting…';
  }
}

function showConsole() {
  $('login').hidden = true;
  $('console').hidden = false;
  $('livePill').hidden = false;
  $('signOut').hidden = false;
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 5000);
}

function signOut(msg) {
  clearInterval(timer);
  token = '';
  sessionStorage.removeItem('dunia.adminToken');
  $('console').hidden = true;
  $('login').hidden = false;
  $('livePill').hidden = true;
  $('signOut').hidden = true;
  if (msg) { $('loginErr').textContent = msg; $('loginErr').hidden = false; }
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = $('tokenInput').value.trim();
  $('loginErr').hidden = true;
  try {
    await api('/overview');
    sessionStorage.setItem('dunia.adminToken', token);
    $('tokenInput').value = '';
    showConsole();
  } catch (err) {
    $('loginErr').textContent = err.code === 404
      ? 'The admin console is turned off. Set ADMIN_TOKEN on the server and restart it.'
      : err.code === 401 ? "That token isn't right." : `Couldn't reach the server (${err.message}).`;
    $('loginErr').hidden = false;
  }
});
$('signOut').addEventListener('click', () => signOut());
$('reportTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-status]');
  if (!b) return;
  status = b.dataset.status;
  $('reportTabs').querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  refresh();
});
$('lightbox').addEventListener('click', () => { $('lightbox').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('lightbox').hidden = true; });

if (token) showConsole();
