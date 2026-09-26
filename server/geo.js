import { COUNTRY_CODES } from '../shared/data.js';

/**
 * Where is this connection coming from?
 *
 * 1. CDN / edge headers (free and accurate): Cloudflare, Vercel, CloudFront,
 *    Google App Engine, Fastly (custom header), or any proxy that sets
 *    X-Country-Code.
 * 2. Optional local GeoIP database: `npm install geoip-lite` and it is used
 *    automatically (≈100 MB, refresh monthly — see docs/DEPLOYMENT.md).
 * 3. Otherwise unknown (null). The user's self-declared country is then used
 *    and simply shown without the "location verified" badge.
 */
const COUNTRY_HEADERS = [
  'cf-ipcountry',
  'x-vercel-ip-country',
  'cloudfront-viewer-country',
  'x-appengine-country',
  'fastly-geo-country',
  'x-country-code',
];

let geoip = null;

export async function initGeo() {
  try {
    const mod = await import('geoip-lite');
    geoip = mod.default || mod;
    return 'geoip-lite';
  } catch {
    return 'headers-only';
  }
}

/** Real client IP, honouring exactly `trustProxy` hops of X-Forwarded-For. */
export function clientIp(headers, remoteAddress, trustProxy = 1) {
  let ip = remoteAddress || '';
  const xff = headers['x-forwarded-for'];
  if (trustProxy > 0 && typeof xff === 'string' && xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const idx = parts.length - trustProxy;
    ip = parts[Math.max(0, idx)] || ip;
  }
  return ip.replace(/^::ffff:/, '');
}

export function detectCountry(headers, ip) {
  for (const h of COUNTRY_HEADERS) {
    const v = headers[h];
    if (typeof v === 'string') {
      const cc = v.trim().toUpperCase();
      if (COUNTRY_CODES.has(cc)) return cc;
    }
  }
  if (geoip && ip) {
    const cc = geoip.lookup(ip)?.country;
    if (cc && COUNTRY_CODES.has(cc)) return cc;
  }
  return null;
}
