import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile post-count endpoint (SP-055).
 *
 * The phone used to call the `post_cycle_count` RPC directly. That applies the
 * variance adjustments, but it is only half of what posting means: the RPC
 * knows nothing about the cycle_counts MODULE gate, the caller's warehouse
 * write scope, the `cycle_count.posted` audit row or the
 * `cycle_count.completed` integration event. So a count posted from a phone
 * moved real stock while the audit console and every connector stayed silent,
 * and an org with the module disabled could still post from a stale build.
 *
 * This route is the Bearer twin of the web's postCycleCountAction: all of that
 * lives in CycleCountsService.post(), which also maps the RPC's stable raise
 * codes (cycle_count_stale_line, cycle_count_negative_result, …) to sentences —
 * so `message` here is safe to show a person verbatim.
 *
 * No body: the id in the path is the whole request. Mirrors release/route.ts
 * for auth, id validation and rate limiting.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const rl = await checkRateLimit(`cycle-count-post:${ctx.userId}`, 30, 60_000);
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
    const row = await svc.post(id);
    return NextResponse.json({ ok: true, cycleCount: row });
  } catch (e) {
    if (e instanceof ServiceError) {
      // serviceErrorStatus covers module_disabled (403) and plan limits too —
      // the hand-rolled ladders in the sibling routes predate it.
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
