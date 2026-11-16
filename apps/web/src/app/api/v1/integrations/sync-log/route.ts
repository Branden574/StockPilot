import { NextResponse, type NextRequest } from 'next/server';

import { apiReadContext } from '@/server/lib/api-read-context';
import { reportError } from '@/lib/error-reporter';
import { ConnectionsService } from '@/server/services/connections';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Operator dead-letter view: list this org's FAILED connector sync-log rows
 * (status in 'error','dead'). Unlike the member-level connections health read,
 * this is gated on an ADMIN manage permission (integrations:manage OR
 * shipping:manage) inside ConnectionsService.listFailedSyncs — the raw error
 * detail + the adjacent replay action are admin-only. A caller lacking the
 * manage permission gets a forbidden ServiceError → 403; a disabled module →
 * module_disabled → 403.
 */
export async function GET(req: NextRequest) {
  const read = await apiReadContext(req);
  if ('response' in read) return read.response;
  const ctx = read.ctx;
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  try {
    const data = await new ConnectionsService(ctx).listFailedSyncs();
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.integrations.sync_log.list' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
