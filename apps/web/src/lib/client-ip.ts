import 'server-only';

import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

import { env } from '@/lib/env';

/**
 * The caller's address, read in one place. x-forwarded-for is read only on
 * Vercel, where the platform sets it; elsewhere x-real-ip, else the 'unknown'
 * bucket.
 *
 * Both `clientIpFromRequest` (route handlers, which get a real `Request`)
 * and `clientIpFromHeaders` (Server Components, which only get Next's
 * `headers()` — no `Request` object exists there at all) funnel through
 * this ONE implementation so the VERCEL guard / x-real-ip fallback can't
 * drift between the two call shapes (maintenance share-link brief I4 —
 * `/m/[token]/page.tsx` used to hand-roll its own unguarded XFF parse).
 */
function pickClientIp(headers: { get(name: string): string | null }): string {
  const onVercel = process.env.VERCEL === '1';
  const xff = onVercel ? headers.get('x-forwarded-for') : null;
  return xff?.split(',')[0]?.trim() || headers.get('x-real-ip')?.trim() || 'unknown';
}

export function clientIpFromRequest(req: Request): string {
  return pickClientIp(req.headers);
}

/** `headers()`-shaped twin of `clientIpFromRequest` for Server Components,
 *  which have no `Request` to read — only the awaited `next/headers`
 *  `headers()` result (a `ReadonlyHeaders`, which satisfies this shape). */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  return pickClientIp(headers);
}

/**
 * The same address for a stored record: an audit row (audit_logs.ip is inet),
 * a device row (user_login_devices.last_ip), a new-device email. The one rule
 * above, then null for anything that is not an IP literal: the limiter's
 * 'unknown' bucket, or a header value that is not an address, which the inet
 * column would refuse (22P02) and lose the row with it. An IPv6 zone id
 * ("fe80::1%eth0") passes isIP but not inet, so a '%' is refused too.
 */
export function clientIpForRecord(headers: { get(name: string): string | null }): string | null {
  return ipForRecord(pickClientIp(headers));
}

/**
 * An address already in hand, in the form a stored record takes: the value
 * when it is an IP literal inet accepts, else null. The audit writer applies
 * it to every row as the last step before the insert, whoever shaped the row.
 */
export function ipForRecord(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') return null;
  return isIP(ip) && !ip.includes('%') ? ip : null;
}

// ── Place and source, for the security-events record ────────────────────────
// The two functions below are what server/security/events.ts stores about the
// caller of a refused request: a country and city, and a keyed hash of the
// address. The address itself never leaves this file through them.

/** Where a request came from, as Vercel's edge names it; null when unknown. */
export interface ClientPlace {
  country: string | null;
  city: string | null;
}

/** The most characters a stored city may have (the table's own check). */
const CITY_MAX_CHARACTERS = 80;
/**
 * Characters a stored city never holds: control characters (C0, DEL, C1, as
 * the table's [[:cntrl:]] check refuses), the line and paragraph separators,
 * and the bidirectional controls, which could reorder the text around a city
 * on an admin's page.
 */
const CITY_REFUSED = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

function countryOf(raw: string | null): string | null {
  return raw !== null && /^[A-Z]{2}$/.test(raw) ? raw : null;
}

/** Vercel sends the city percent-encoded (UTF-8); anything malformed is no city. */
function cityOf(raw: string | null): string | null {
  if (raw === null) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const city = decoded.trim();
  if (city.length === 0 || CITY_REFUSED.test(city)) return null;
  // Characters as the database counts them (code points, char_length).
  if ([...city].length > CITY_MAX_CHARACTERS) return null;
  return city;
}

/**
 * The caller's country (two capital letters) and city, from Vercel's
 * x-vercel-ip-country and x-vercel-ip-city. Read only on Vercel, by the same
 * trust rule as the address above: elsewhere anyone could send those headers,
 * so there is no place. A value that fails its rule is null on its own.
 */
export function clientPlaceFromHeaders(headers: { get(name: string): string | null }): ClientPlace {
  if (process.env.VERCEL !== '1') return { country: null, city: null };
  return {
    country: countryOf(headers.get('x-vercel-ip-country')),
    city: cityOf(headers.get('x-vercel-ip-city')),
  };
}

/** Names this hash's purpose and version in its day key, so the key serves nothing else. */
const SOURCE_HASH_CONTEXT = 'security-events/source/v1/';

/**
 * A keyed hash of the caller's address (32 hex), to group events from one
 * source within one UTC day: HMAC-SHA256 of the address under the day's key,
 * where the day key is HMAC-SHA256(CRON_SECRET, SOURCE_HASH_CONTEXT +
 * 'YYYY-MM-DD'). The same address on the same day hashes the same; on another
 * day, or under another secret, it does not, and without the secret it cannot
 * be computed back from an address list. Derived from an existing secret so
 * there is no new key to keep; a rotated CRON_SECRET only stops linking across
 * the rotation.
 *
 * Null when there is no CRON_SECRET, or the address (the one rule above) is
 * not an IP literal (the limiter's 'unknown' bucket, a malformed header).
 */
export function clientSourceHash(
  headers: { get(name: string): string | null },
  now: Date = new Date(),
): string | null {
  const address = ipForRecord(pickClientIp(headers));
  if (!address || !Number.isFinite(now.getTime())) return null;
  let secret: string;
  try {
    secret = env.CRON_SECRET ?? '';
  } catch {
    return null;
  }
  if (!secret) return null;
  const day = now.toISOString().slice(0, 10);
  const dayKey = createHmac('sha256', secret).update(SOURCE_HASH_CONTEXT + day).digest();
  return createHmac('sha256', dayKey).update(address.toLowerCase()).digest('hex').slice(0, 32);
}
