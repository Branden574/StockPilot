import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { ExceptionEvidenceService } from '@/server/services/exception-evidence';

import { exceptionsErrorResponse } from '../../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  fileExt: z.string().min(1).max(16),
});

/**
 * POST /api/v1/exceptions/[id]/evidence — start a photo upload (F1-4).
 * Cookie or Bearer. Online only: there is no offline photo queue.
 *
 * Who: the act gate (stock:adjust and write access to the occurrence's
 * warehouse, a manager when it has none), on an OPEN occurrence.
 *
 * Body: `{ fileExt: 'jpg' | 'jpeg' | 'png' | 'webp' }` (HEIC is converted on
 * the device first).
 *
 * Answers: 200 `{ path, signedUrl, token, contentType, maxBytes }` — PUT the
 * photo to `signedUrl` with `Content-Type: contentType`, then call
 * `…/evidence/finalize` with `path`. 400 bad body or extension; 403 not
 * allowed; 404 not found or not visible; 409 `details.reason` =
 * occurrence_resolved, evidence_limit_reached (8 live photos) or
 * rate_limited (60 uploads an hour per person; also when the limiter itself
 * cannot answer).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'That exception id is not valid.' },
      { status: 400 },
    );
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: 'Say which kind of photo: jpg, png or webp.' },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json(
      { error: 'validation_error', message: 'The request body is not valid JSON.' },
      { status: 400 },
    );
  }

  try {
    const ticket = await new ExceptionEvidenceService(ctx).createUploadUrl(id, {
      fileExt: body.fileExt,
    });
    return NextResponse.json(ticket, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    return exceptionsErrorResponse(e, 'api.v1.exceptions.evidence.mint', ctx);
  }
}
