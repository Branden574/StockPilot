import { NextResponse, type NextRequest } from 'next/server';

import { isUuid } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Phone count screen: clear a line's saved count, so the line is uncounted
 * again and a post skips it. The phone's twin of the web count screen's
 * emptied box (clearCycleCountLineAction): the same CycleCountsService
 * clearCount, so the same module, permission, warehouse and assignee checks
 * and the same database rules (0339 puts the expected quantity back to the
 * one at the start of the count, 0369 forgets the capture time).
 *
 * Before this route the phone could not clear a count at all: an emptied box
 * kept the count saved before, and Post applied that number while the box
 * showed nothing. The phone queues a clear in its count outbox like a count
 * (one live edit per line, the newest wins) and sends it here, online or when
 * it is back online. No body: a repeat is harmless, since clearing a line
 * with no count leaves it with none.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; lineId: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { id, lineId } = await params;
  if (!isUuid(id) || !isUuid(lineId)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  // The record route's own budget, shared: a clear is a line write like a
  // count, so sending both never doubles what one person can send a minute.
  const rl = await checkRateLimit(`cycle-count-record:${ctx.userId}`, 120, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }

  try {
    const svc = new CycleCountsService(ctx);
    await svc.clearCount({ cycleCountId: id, lineId });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      // The shared mapping: a refusal (the module off, no permission, a count
      // that is closed or held by someone else, a line that is gone) is a 4xx
      // with its code, which the phone's drain treats as final; anything else
      // is a 5xx it sends again. An internal error's message is generic (S13).
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
