import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { forbiddenOrInternalResponse } from '@/server/lib/api-error-response';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { ServiceError } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  assignedTo: z.string().uuid(),
  // Required non-blank reason (owner decision) — enforced again in the RPC.
  reason: z.string().trim().min(1).max(500),
});

/**
 * Manager+ force-reassign of an ACTIVE cycle count to another member, with a
 * required reason (owner decision). Authorization (manager+) + reason are
 * enforced in the 0282 force_reassign_cycle_count RPC.
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

  const rl = await checkRateLimit(`cycle-count-reassign:${ctx.userId}`, 30, 60_000);
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
    const row = await svc.forceReassign(id, parsed.data.assignedTo, parsed.data.reason);
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
    // Anything else is the fixed sentence, and reported (S16); a warehouse
    // refusal is answered as the count routes answer it.
    return forbiddenOrInternalResponse(e, 'api.v1.cycle_counts.reassign', {
      organizationId: ctx.organizationId,
    });
  }
}
