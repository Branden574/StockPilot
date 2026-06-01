import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ConnectionsService } from '@/server/services/connections';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const idSchema = z.string().uuid();

/**
 * Operator replay: re-queue a dead-lettered/errored connector export. Resets the
 * connection_sync_log row to status='pending' (attempts=0, next_attempt_at=null)
 * so the cron drainer re-picks it next tick. Same admin gating as the list view
 * (integrations:manage OR shipping:manage) + org-scoped — enforced inside
 * ConnectionsService.replaySync and by the 0152 admin-only RLS policy.
 *
 * A non-uuid `id` segment is a request-shape error (400). An id that doesn't
 * resolve to a replayable failed row for this org → not_found → 404 (never
 * leaks whether another org owns it).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'Invalid sync-log id.' },
      { status: 400 },
    );
  }

  try {
    await new ConnectionsService(ctx).replaySync(parsed.data);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.integrations.sync_log.replay' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
