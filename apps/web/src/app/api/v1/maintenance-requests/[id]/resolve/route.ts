import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Manage-only close-out (mobile parity for the web Resolve dialog). Body is
 * `{ note: string }` — this route does NOT re-parse it;
 * MaintenanceRequestsService.resolve() owns the schema
 * (`maintenanceResolveSchema`, packages/core/src/schemas/maintenance.ts,
 * `.strict()`), the SAME shared schema the web dialog validates against —
 * this route only validates the id shape and delegates. Matches the PATCH
 * precedent ([id]/route.ts) and resolve()'s own doc comment: the raw body
 * is forwarded straight through, so `maintenanceResolveSchema` stays the
 * SINGLE authority for what a resolution note may look like.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  // Uuid-validate at the untrusted edge, before it ever reaches a
  // `.eq('id', id)` — a malformed id would otherwise surface as an opaque
  // Postgres 22P02 internal_error instead of a clean 400 (Task 8 convention).
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'That request id is not valid.' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    await new MaintenanceRequestsService(ctx).resolve(id, body);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.resolve' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
