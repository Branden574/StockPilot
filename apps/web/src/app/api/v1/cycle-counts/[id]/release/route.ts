import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { ServiceError } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  // Required non-blank reason (owner decision) — enforced again in the RPC.
  reason: z.string().trim().min(1).max(500),
});

/**
 * Mobile release: the assigned employee (self-release) or a manager+ releases
 * a cycle count they can't complete. A reason is mandatory and audited.
 * Counted lines are preserved; only the assignment clears. Authorization is
 * enforced in the 0282 release_cycle_count RPC.
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

  const rl = await checkRateLimit(`cycle-count-release:${ctx.userId}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'validation_error' },
      { status: 400 },
    );
  }

  try {
    const svc = new CycleCountsService(ctx);
    const row = await svc.release(id, parsed.data.reason);
    return NextResponse.json({ ok: true, cycleCount: row });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status =
        e.code === 'forbidden'
          ? 403
          : e.code === 'not_found'
            ? 404
            : e.code === 'conflict'
              ? 409
              : e.code === 'validation_error'
                ? 400
                : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
