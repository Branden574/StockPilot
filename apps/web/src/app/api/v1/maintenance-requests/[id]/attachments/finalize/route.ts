import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { MAINTENANCE_ATTACHMENT_KINDS } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceAttachmentsService } from '@/server/services/maintenance-attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Finalize step (audit Q8): downloads the just-uploaded object, sniffs its
 * REAL magic bytes (never the client's `declaredMime`), and only then
 * records the row. A body that fails the sniff is deleted server-side and
 * this returns 400 { error: 'invalid_image' } — the route contract every
 * upload UI (web Task 13, mobile Task 19) is built against.
 *
 * CRITICAL 1c (security fix wave, Task 9 review): `thumbPath` is NOT part of
 * this contract. The service derives it deterministically from `path`
 * server-side — accepting it from the client was an unnecessary second
 * place for a hostile path to slip through the org/request boundary check.
 * Tasks 13/19 (web/mobile upload UI) must NOT send a thumbPath field; the
 * mint response's `thumbPath` is still correct to PUT the actual thumbnail
 * bytes to, since it is the exact path the service re-derives at finalize.
 */
const finalizeSchema = z.object({
  path: z.string().min(1).max(500),
  originalFilename: z.string().trim().min(1).max(300),
  declaredMime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  // Optional (migration 0317/spec §2.2) — omitted keeps today's behavior
  // byte-for-byte (the service defaults to 'requester'). Forwarded verbatim;
  // the service is the one place kind='resolution' gets manage-gated.
  kind: z.enum(MAINTENANCE_ATTACHMENT_KINDS).optional(),
});

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
  const parsed = finalizeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    const res = await new MaintenanceAttachmentsService(ctx).finalize(id, {
      path: parsed.data.path,
      originalFilename: parsed.data.originalFilename,
      declaredMime: parsed.data.declaredMime,
      kind: parsed.data.kind,
    });
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    }
    void reportError(e, { tag: 'api.v1.maintenance-requests.attachments.finalize' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
