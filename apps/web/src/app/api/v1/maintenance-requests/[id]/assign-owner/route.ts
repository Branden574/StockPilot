import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Body-SHAPE gate only — `assignLocalOwner(id, userId)` takes a typed
 * `string | null`, not `unknown` (unlike resolve()/update(), which own a
 * `.strict()` core schema in packages/core), so this route needs some
 * schema just to narrow the untyped JSON body before the call. It exists
 * to satisfy TypeScript, NOT to duplicate business validation: uuid-format
 * checking, the cross-org membership check, and every associated error
 * message live entirely in assignLocalOwner() itself, and this schema never
 * repeats them.
 */
const assignOwnerBodySchema = z.object({ userId: z.string().nullable() }).strict();

/**
 * Manage-only "StockPilot local owner" assignment (never a Zendesk
 * assignee — permissions.ts doc comment) — mobile parity for the web
 * AssignOwnerSelect. `userId: null` clears the assignment.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'That request id is not valid.' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = assignOwnerBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    await new MaintenanceRequestsService(ctx).assignLocalOwner(id, parsed.data.userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.assign-owner' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
