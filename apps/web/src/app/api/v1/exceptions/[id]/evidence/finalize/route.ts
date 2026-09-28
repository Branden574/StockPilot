import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { ExceptionEvidenceService } from '@/server/services/exception-evidence';

import { exceptionsErrorResponse, exceptionsRateLimitedResponse } from '../../../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Loose bounds only; the service applies the exact rules (the strict path
 * shape, a note of at most 500 characters, a readable capture time) with the
 * same wording the web action gets.
 */
const bodySchema = z.object({
  path: z.string().min(1).max(400),
  declaredMime: z.string().min(1).max(64),
  capturedAt: z.string().max(64).nullish(),
  note: z.string().max(2000).nullish(),
});

/**
 * POST /api/v1/exceptions/[id]/evidence/finalize — record an uploaded photo
 * (F1-4). Cookie or Bearer.
 *
 * The server checks the bytes (sniffed type against `declaredMime`, at most
 * 10 MB), re-encodes the photo WITHOUT its metadata (EXIF, including GPS
 * location), makes the thumbnail itself, and records it through
 * exception_evidence_record, which re-checks the act gate, the open state,
 * the path and the cap of 8 under a lock.
 *
 * On a refusal nothing is recorded and the upload is deleted, with three
 * exceptions: a path of the wrong shape (nothing is touched), a finalize the
 * per-person limit refused (429: the same finalize can be sent again), and an
 * upload that turns out to be recorded already (its file is kept, and the
 * answer is 409 already_recorded, which a client reads as success). The limit
 * (30 a minute, refusing when the limiter itself fails) is the service's, so
 * the web action shares it.
 *
 * Body: `{ path, declaredMime, capturedAt?, note? }`. `capturedAt` is the
 * device's clock (ISO 8601); a time more than 5 minutes ahead of the server
 * is dropped. `note` is up to 500 characters.
 *
 * Answers: 201 `{ evidence: { id, contentType, byteSize, width, height,
 * capturedAt, uploadedAt } }`. 400 `details.reason` = invalid_image (not the
 * photo it claims to be, or too large), note_too_long, invalid_captured_at;
 * 403 not allowed or a path outside this occurrence; 404 not found or not
 * visible; 409 `details.reason` = occurrence_resolved, evidence_limit_reached,
 * already_recorded, busy; 429 too many requests.
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
        { error: 'validation_error', message: 'Send the upload path and the photo type.' },
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
    const evidence = await new ExceptionEvidenceService(ctx).finalize(id, {
      path: body.path,
      declaredMime: body.declaredMime,
      capturedAt: body.capturedAt ?? null,
      note: body.note ?? null,
    });
    return NextResponse.json({ evidence }, { status: 201 });
  } catch (e) {
    // The service's finalize limit: a 429 with Retry-After, so the phone
    // resends this same finalize later (the upload is kept).
    if (
      e instanceof ServiceError &&
      e.details?.reason === 'rate_limited' &&
      typeof e.details.retryAt === 'number'
    ) {
      return exceptionsRateLimitedResponse(e.details.retryAt);
    }
    return exceptionsErrorResponse(e, 'api.v1.exceptions.evidence.finalize', ctx);
  }
}
