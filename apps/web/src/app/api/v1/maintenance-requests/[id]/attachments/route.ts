import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceAttachmentsService } from '@/server/services/maintenance-attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mint step of the maintenance-photo upload flow (audit Q8 — mobile Task 19
 * + web Task 13 consume this route directly). The client PUTs bytes straight
 * to Storage with the returned signed URLs, then calls the finalize route
 * (../finalize/route.ts), which is where the bytes actually get verified.
 * This route never sees photo bytes at all.
 */
const mintSchema = z.object({
  fileExt: z.string().trim().min(1).max(5),
  originalFilename: z.string().trim().min(1).max(300),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  // M6 (Task 8 convention): uuid-validate at the untrusted edge, before it
  // ever reaches a `.eq('id', id)` — a malformed id would otherwise surface
  // as an opaque Postgres 22P02 internal_error instead of a clean 400.
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'That request id is not valid.' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = mintSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    const res = await new MaintenanceAttachmentsService(ctx).createUploadUrl(id, parsed.data);
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.attachments.mint' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
