import { UI_LOCALES, COUNTRY_EN, SPOKEN_LANGUAGES } from '/shared/data.js';
import { store } from './util.js';

/**
 * i18n engine
 *  - UI strings: /locales/<code>.json, English is the fallback for any key.
 *  - Country and language NAMES are not translated by hand: Intl.DisplayNames
 *    gives every country/language name in the user's language for free.
 *  - Sets <html lang dir data-script> so RTL (Arabic, Urdu) and non-Latin
 *    typography rules apply automatically.
 */
const LATIN = new Set(['en', 'es', 'pt', 'fr', 'de', 'it', 'tr', 'id', 'vi', 'fil']);
const NATIVE = Object.fromEntries(SPOKEN_LANGUAGES);
const cache = new Map();

let lang = 'en';
let dict = {};
let fallback = {};
let regionNames = null;
let languageNames = null;
let numberFmt = new Intl.NumberFormat('en');
let listFmt = null;
let collator = new Intl.Collator('en');

async function load(code) {
  if (cache.has(code)) return cache.get(code);
  const res = await fetch(`/locales/${code}.json`);
  if (!res.ok) throw new Error(`locale ${code}: ${res.status}`);
  const json = await res.json();
  cache.set(code, json);
  return json;
}

export const isSupported = (code) => UI_LOCALES.some((l) => l[0] === code);

export function normalizeTag(tag) {
  const t = String(tag || '').toLowerCase();
  if (t.startsWith('zh')) return 'zh';
  if (t === 'tl' || t.startsWith('tl-') || t.startsWith('fil')) return 'fil';
  if (t === 'in' || t.startsWith('in-')) return 'id';
  return t.split('-')[0];
}

export function detectLang() {
  const saved = store.get('lang');
  if (saved && isSupported(saved)) return saved;
  for (const l of navigator.languages || [navigator.language]) {
    const code = normalizeTag(l);
    if (isSupported(code)) return code;
  }
  return 'en';
}

function displayNames(code, type) {
  try {
    return new Intl.DisplayNames([code, 'en'], { type, fallback: 'none' });
  } catch {
    return null;
  }
}

export async function initI18n() {
  fallback = await load('en');
  await setLang(detectLang());
}

export async function setLang(code) {
  if (!isSupported(code)) code = 'en';
  try {
    dict = code === 'en' ? fallback : await load(code);
  } catch {
    dict = fallback;
    code = 'en';
  }
  lang = code;
  const meta = UI_LOCALES.find((l) => l[0] === code);
  const root = document.documentElement;
  root.lang = code;
  root.dir = meta?.[2] || 'ltr';
  root.dataset.script = LATIN.has(code) ? 'latin' : 'other';
  regionNames = displayNames(code, 'region');
  languageNames = displayNames(code, 'language');
  numberFmt = new Intl.NumberFormat(code);
  listFmt = Intl.ListFormat ? new Intl.ListFormat(code, { style: 'short', type: 'conjunction' }) : null;
  collator = new Intl.Collator(code);
  store.set('lang', code);
  applyI18n(document);
  document.title = t('meta.title');
}

export const getLang = () => lang;
export const getDir = () => document.documentElement.dir;

export function t(key, vars) {
  let s = dict[key] ?? fallback[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  return s;
}

/** Like t(), but {placeholders} can be DOM nodes (e.g. a link inside a sentence). */
export function tRich(key, nodes) {
  const frag = document.createDocumentFragment();
  const parts = t(key).split(/(\{\w+\})/);
  for (const p of parts) {
    const m = /^\{(\w+)\}$/.exec(p);
    if (m && nodes[m[1]]) frag.append(nodes[m[1]]);
    else if (p) frag.append(p);
  }
  return frag;
}

export function applyI18n(root) {
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((node) => {
    for (const pair of node.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) node.setAttribute(attr, t(key));
    }
  });
}

export function countryName(cc) {
  if (!cc) return '';
  try {
    const n = regionNames?.of(cc);
    if (n && n !== cc) return n;
  } catch { /* unknown code */ }
  return COUNTRY_EN[cc] || cc;
}

export function languageName(code) {
  if (!code) return '';
  try {
    const n = languageNames?.of(code);
    if (n && n !== code) return n.charAt(0).toLocaleUpperCase(lang) + n.slice(1);
  } catch { /* unknown code */ }
  return NATIVE[code] || code;
}

export const nativeLanguageName = (code) => NATIVE[code] || UI_LOCALES.find((l) => l[0] === code)?.[1] || code;
export const fmtNum = (n) => numberFmt.format(n);
export const fmtList = (items) => (listFmt ? listFmt.format(items) : items.join(', '));
export const compare = (a, b) => collator.compare(a, b);
export function fmtDateTime(ms) {
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}
