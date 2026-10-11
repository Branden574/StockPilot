import 'server-only';

import { createHash } from 'node:crypto';

/**
 * Rate-limit keys for the public return surfaces (returns RX-1). The token
 * bucket is keyed by sha256(token), so a raw return token never lands in the
 * rate-limit table (plan RX-1: "the token bucket key becomes sha256(token)").
 */
export function returnTokenBucketKey(token: string): string {
  return `public-return-request:token:${createHash('sha256').update(token.toLowerCase()).digest('hex')}`;
}

/** Per-IP bucket for the public request page's GET (plan RX-1). */
export function returnPageIpBucketKey(ip: string): string {
  return `public-return-page:${ip}`;
}

/** Page views per IP per hour before the request page answers "too many". */
export const RETURN_PAGE_VIEWS_PER_IP_PER_HOUR = 120;

/**
 * The public options read (returns RX-3, POST /api/v1/public/returns/options):
 * its own fail-closed buckets, 120 an hour per IP and 600 an hour per
 * token, the token bucket keyed by sha256(token) like the submit's, so the
 * raw token never lands in the rate-limit table.
 */
export function returnOptionsTokenBucketKey(token: string): string {
  return `public-return-options:token:${createHash('sha256').update(token.toLowerCase()).digest('hex')}`;
}

export function returnOptionsIpBucketKey(ip: string): string {
  return `public-return-options:ip:${ip}`;
}

export const RETURN_OPTIONS_PER_IP_PER_HOUR = 120;
export const RETURN_OPTIONS_PER_TOKEN_PER_HOUR = 600;

/**
 * The caller's address for a public bucket: x-forwarded-for only on Vercel
 * (elsewhere a client could rotate it), else x-real-ip, else 'unknown'.
 */
export function publicRequestIp(headers: Pick<Headers, 'get'>, env: Record<string, string | undefined> = process.env): string {
  const xff = env.VERCEL === '1' ? headers.get('x-forwarded-for') : null;
  return xff?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown';
}
