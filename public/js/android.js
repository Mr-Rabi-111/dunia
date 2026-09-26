/**
 * Bridge to the Dunia Android app (android/ in this repo).
 *
 * The app injects `window.DuniaNative` with androidx.webkit's
 * WebViewCompat.addWebMessageListener — only for Dunia's own origin, so no
 * other page can reach it. Messages are JSON:
 *   web → app:  { id, cmd, args }
 *   app → web:  { id, ok: true, result } | { id, ok: false, error }
 *
 * Commands: hello, products, buy, consume, keepAwake, share, openExternal.
 * In a normal browser `native.available` is false and every call rejects.
 */
const N = typeof window !== 'undefined' ? window.DuniaNative : undefined;
const pending = new Map();
let seq = 0;

export const native = {
  available: !!(N && typeof N.postMessage === 'function'),
  /** { flavor: 'play' | 'direct', version, billing: boolean, upiAllowed: boolean } */
  info: null,
};

if (native.available) {
  const onMessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(Object.assign(new Error(m.error || 'native_error'), { code: m.error || 'native_error' }));
  };
  if (typeof N.addEventListener === 'function') N.addEventListener('message', onMessage);
  else N.onmessage = onMessage;
}

export function nativeCall(cmd, args = {}, timeoutMs = 120_000) {
  if (!native.available) return Promise.reject(Object.assign(new Error('no_native'), { code: 'no_native' }));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = timeoutMs ? setTimeout(() => {
      if (pending.delete(id)) reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
    }, timeoutMs) : null;
    pending.set(id, { resolve, reject, timer });
    N.postMessage(JSON.stringify({ id, cmd, args }));
  });
}

export async function initNative() {
  if (!native.available) return null;
  try { native.info = await nativeCall('hello', {}, 5000); } catch { native.info = null; }
  if (native.info) document.documentElement.dataset.app = native.info.flavor || 'app';
  return native.info;
}

/** True when purchases must go through Google Play Billing (Play Store build). */
export const usesPlayBilling = () => !!(native.info && native.info.flavor === 'play' && native.info.billing);
/** In the Play build, UPI is offered only when the developer enrolled in user choice billing. */
export const upiAllowedHere = () => !native.info || native.info.flavor !== 'play' || !!native.info.upiAllowed;
