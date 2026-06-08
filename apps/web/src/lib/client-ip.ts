import 'server-only';

/**
 * Best-effort client IP for rate-limiting keys.
 *
 * We only trust `x-forwarded-for` when running on Vercel (where the platform
 * sets/strips it). Off-Vercel a client can spoof XFF to rotate past a per-IP
 * cap, so we fall back to `x-real-ip` or an `unknown` bucket. Mirrors the
 * battle-tested logic in the public order-request POST handler.
 */
export function clientIpFromRequest(req: Request): string {
  const onVercel = process.env.VERCEL === '1';
  const xff = onVercel ? req.headers.get('x-forwarded-for') : null;
  return xff?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
}
