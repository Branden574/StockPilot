import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ExceptionEvidenceService } from '@/server/services/exception-evidence';

import { exceptionsErrorResponse, exceptionsRateLimitedResponse } from '../../../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  reason: z.string().max(2000).nullish(),
});

/**
 * DELETE /api/v1/exceptions/[id]/evidence/[evidenceId] — remove a photo
 * (F1-4). Cookie or Bearer.
 *
 * A SOFT remove: the photo leaves the gallery, the timeline records "Photo
 * removed by X" with the reason, and the stored file is kept. The uploader or
 * a manager, through the act gate, while the occurrence is open. Removing a
 * photo that is already removed answers 200 again and records nothing new.
 *
 * Body (optional): `{ reason?: string }`, up to 500 characters.
 *
 * Answers: 200 `{ evidence: { id, removedAt } }`; 400 bad body or reason too
 * long; 403 not allowed (not the uploader and not a manager, or no write
 * access); 404 not found or not visible; 409 `details.reason` =
 * occurrence_resolved; 429 too many requests.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; evidenceId: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id, evidenceId } = await params;
  if (
    !z.string().uuid().safeParse(id).success ||
    !z.string().uuid().safeParse(evidenceId).success
  ) {
    return NextResponse.json(
      { error: 'validation_error', message: 'That photo id is not valid.' },
      { status: 400 },
    );
  }

  const rl = await checkRateLimit(`exceptions-act:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) return exceptionsRateLimitedResponse(rl.resetAt);

  // The body is optional: an empty DELETE removes with no reason.
  let reason: string | null = null;
  const raw = await req.text();
  if (raw.trim() !== '') {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return NextResponse.json(
        { error: 'validation_error', message: 'The request body is not valid JSON.' },
        { status: 400 },
      );
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: 'The reason must be text.' },
        { status: 400 },
      );
    }
    reason = parsed.data.reason ?? null;
  }

  try {
    const evidence = await new ExceptionEvidenceService(ctx).remove(id, evidenceId, reason);
    return NextResponse.json({ evidence });
  } catch (e) {
    return exceptionsErrorResponse(e, 'api.v1.exceptions.evidence.remove', ctx);
  }
}
