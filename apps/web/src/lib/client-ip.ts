import 'server-only';

import { isIP } from 'node:net';

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
