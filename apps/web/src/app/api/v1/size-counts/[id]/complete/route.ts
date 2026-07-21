import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { SizeCountsService } from '@/server/services/size-counts';
import { sizeCountError } from '../../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Complete (lock) a size-count session. This feature does NOT write inventory
 * (owner decision) — completing just finalizes the per-size review list.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const rl = await checkRateLimit(`size-count-complete:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  try {
    const svc = new SizeCountsService(ctx);
    const session = await svc.completeSession(id);
    return NextResponse.json({ ok: true, session });
  } catch (e) {
    return sizeCountError(e);
  }
}
