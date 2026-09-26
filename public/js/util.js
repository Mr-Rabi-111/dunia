export const $ = (id) => document.getElementById(id);

/** Tiny element builder: el('span', { class: 'x', text: 'hi' }, child, ...) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

export function icon(id, cls = 'ic') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

/** Flag for an ISO country code (SVG from flag-icons); globe for "anywhere". */
export function flagEl(code, round = false) {
  const s = document.createElement('span');
  if (code && /^[A-Z]{2}$/.test(code)) {
    s.className = `fi fi-${code.toLowerCase()}${round ? ' fis' : ''}`;
  } else {
    s.className = `fi fi-globe${round ? ' fis' : ''}`;
    s.append(icon('i-globe'));
  }
  s.setAttribute('aria-hidden', 'true');
  return s;
}

/** localStorage wrapper: namespaced, JSON, never throws (private mode, quotas). */
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`dunia.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, val) {
    try { localStorage.setItem(`dunia.${key}`, JSON.stringify(val)); } catch { /* ignore */ }
  },
  clear() {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('dunia.')).forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  },
};

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Search-friendly folding: lowercase, strip accents. */
export function fold(s) {
  return String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const ADJ = ['Sunny', 'Brave', 'Cosmic', 'Lucky', 'Swift', 'Calm', 'Bright', 'Happy', 'Wild', 'Chill', 'Golden', 'Clever', 'Gentle', 'Bold', 'Misty', 'Neon', 'Jolly', 'Quiet', 'Rapid', 'Silver'];
const NOUN = ['Otter', 'Falcon', 'Panda', 'Comet', 'Tiger', 'Koala', 'Maple', 'River', 'Lotus', 'Orbit', 'Mango', 'Harbor', 'Pixel', 'Nomad', 'Robin', 'Cedar', 'Dolphin', 'Lynx', 'Sparrow', 'Nova'];
export function randomName() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return `${pick(ADJ)}${pick(NOUN)}${Math.floor(Math.random() * 90 + 10)}`;
}
