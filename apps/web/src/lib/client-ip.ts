import 'server-only';

/**
 * Best-effort client IP for rate-limiting keys.
 *
 * We only trust `x-forwarded-for` when running on Vercel (where the platform
 * sets/strips it). Off-Vercel a client can spoof XFF to rotate past a per-IP
 * cap, so we fall back to `x-real-ip` or an `unknown` bucket. Mirrors the
 * battle-tested logic in the public order-request POST handler.
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
  return xff?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown';
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
