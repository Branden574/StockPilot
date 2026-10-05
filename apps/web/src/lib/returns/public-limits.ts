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
