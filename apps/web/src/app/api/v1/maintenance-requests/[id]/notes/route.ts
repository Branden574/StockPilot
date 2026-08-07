import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Internal notes thread — manage-only in BOTH directions (0314 RLS +
 * listNotes()'s own assertPermission), NEVER visible to the requester,
 * NEVER synced anywhere. Mobile parity for MaintenanceNotesPanel. Never log
 * note bodies (GC 16/27 posture) — this route only ever reports a caught
 * non-ServiceError via reportError, which never receives note text.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'That request id is not valid.' }, { status: 400 });
  }

  try {
    const notes = await new MaintenanceRequestsService(ctx).listNotes(id);
    return NextResponse.json({ notes });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.notes.list' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

/**
 * Body-SHAPE gate only (same posture as assign-owner's schema): `addNote(id,
 * body: string)` takes a typed string, not `unknown`. The 1-4,000 character
 * trim/length rule and its error message live entirely in addNote() itself.
 */
const addNoteBodySchema = z.object({ body: z.string() }).strict();

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
  const parsed = addNoteBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    const res = await new MaintenanceRequestsService(ctx).addNote(id, parsed.data.body);
    return NextResponse.json({ id: res.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.notes.add' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
