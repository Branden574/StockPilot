import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Manage-only re-bucket (owner decision D1) — mobile parity for the web
 * Archive action. No body: archive() takes only the id, and (GC 12 —
 * history is sacred) its update object never touches resolved_at/
 * resolved_by/resolved_by_name_snapshot/resolution_note/cancelled_at, so
 * this route has nothing to parse or forward. Accepts both a cancelled and
 * a resolved row (D1) — archive is a re-bucket, not a second closed state.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'That request id is not valid.' }, { status: 400 });
  }

  try {
    await new MaintenanceRequestsService(ctx).archive(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.archive' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
