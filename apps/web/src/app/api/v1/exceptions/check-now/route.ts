import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ExceptionOccurrencesService } from '@/server/services/exception-occurrences';

import { exceptionsErrorResponse, exceptionsRateLimitedResponse } from '../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/exceptions/check-now — a manager's "Check now". Cookie or
 * Bearer; managers and above with items:read (403 otherwise).
 *
 * Always 202 and always immediate: the sync is SCHEDULED to run after this
 * response (after()), and nothing here waits for it (owner decision F1 Q9).
 * `scheduled: false` means the org was checked under a minute ago;
 * `retryAfterSeconds` says when another check can be asked for. The client
 * re-reads the list later and shows the new "Checked at".
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = await checkRateLimit(`exceptions-check-now:${ctx.userId}`, 10, 60_000);
  if (!rl.allowed) return exceptionsRateLimitedResponse(rl.resetAt);

  try {
    const result = await new ExceptionOccurrencesService(ctx).requestCheck();
    return NextResponse.json(result, { status: 202 });
  } catch (e) {
    return exceptionsErrorResponse(e, 'api.v1.exceptions.check_now', ctx);
  }
}
