import 'server-only';

import { NextResponse } from 'next/server';

import { checkRateLimit } from './rate-limit';

/**
 * Shared throttle for expensive PDF/CSV export endpoints. One per-user budget
 * across ALL exports (40/hour, fail-CLOSED), so an authenticated user — or a
 * hijacked session — can't spam react-pdf rendering / large CSV generation to
 * exhaust serverless compute (DoS + cost). Security audit 2026-06-09.
 *
 * Usage in a route handler, right after resolving the auth context:
 *   const limited = ctx && (await exportRateLimited(ctx.userId));
 *   if (limited) return limited;
 *
 * Returns a ready 429 NextResponse to return early, or null to proceed. 40/hr
 * is far above a human generating reports but stops scripted abuse.
 */
export async function exportRateLimited(userId: string): Promise<NextResponse | null> {
  const rl = await checkRateLimit(`export:${userId}`, 40, 60 * 60 * 1000, 'closed');
  if (rl.allowed) return null;
  return NextResponse.json(
    { error: 'rate_limited', message: 'Too many exports — please wait a few minutes.' },
    {
      status: 429,
      headers: { 'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) },
    },
  );
}
