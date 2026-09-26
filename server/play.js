import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Google Play purchase verification (server side — never trust the app).
 *
 * Uses a Google Cloud service account that has been granted access in
 * Play Console (Users and permissions → "View financial data" + "Manage orders").
 * Configure with PLAY_PACKAGE_NAME and PLAY_SERVICE_ACCOUNT_JSON (a file path
 * or the JSON itself). No Google SDK needed: we sign the OAuth JWT ourselves.
 *
 * API: GET androidpublisher/v3/applications/{pkg}/purchases/products/{product}/tokens/{token}
 *   purchaseState 0 = purchased, 1 = cancelled, 2 = pending
 */
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function loadServiceAccount(value) {
  if (!value) return null;
  try {
    const text = value.trim().startsWith('{') ? value : fs.readFileSync(value, 'utf8');
    const sa = JSON.parse(text);
    return sa.client_email && sa.private_key ? sa : null;
  } catch {
    return null;
  }
}

export class PlayVerifier {
  constructor({ packageName, serviceAccount, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.packageName = packageName;
    this.sa = serviceAccount;
    this.fetch = fetchImpl;
    this.now = now;
    this.token = null;
  }

  get enabled() { return !!(this.packageName && this.sa); }

  async accessToken() {
    if (this.token && this.token.exp - 60_000 > this.now()) return this.token.value;
    const iat = Math.floor(this.now() / 1000);
    const aud = this.sa.token_uri || 'https://oauth2.googleapis.com/token';
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: this.sa.client_email, scope: SCOPE, aud, iat, exp: iat + 3600 }));
    const signature = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(this.sa.private_key));
    const res = await this.fetch(aud, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
    });
    if (!res.ok) throw new Error(`oauth ${res.status}`);
    const j = await res.json();
    this.token = { value: j.access_token, exp: this.now() + (j.expires_in || 3600) * 1000 };
    return this.token.value;
  }

  /**
   * @returns {Promise<{ ok: boolean, orderId?: string, reason?: string }>}
   */
  async verifyProduct(productId, purchaseToken, expectedAccountId) {
    if (!this.enabled) return { ok: false, reason: 'play_unconfigured' };
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(this.packageName)}` +
      `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
    const res = await this.fetch(url, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (res.status === 404 || res.status === 400) return { ok: false, reason: 'not_found' };
    if (!res.ok) throw new Error(`play ${res.status}`);
    const p = await res.json();
    if (p.purchaseState !== 0) return { ok: false, reason: p.purchaseState === 2 ? 'pending' : 'cancelled' };
    if (expectedAccountId && p.obfuscatedExternalAccountId && p.obfuscatedExternalAccountId !== expectedAccountId) {
      return { ok: false, reason: 'account_mismatch' };
    }
    return { ok: true, orderId: p.orderId };
  }
}

/** Stable, non-reversible account id to pass to Play (max 64 chars). */
export const playAccountId = (deviceId) => crypto.createHash('sha256').update(`dunia:${deviceId}`).digest('hex').slice(0, 64);
