import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ExceptionOccurrencesService } from '@/server/services/exception-occurrences';

import { exceptionsErrorResponse } from '../../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The body. Loose bounds only: the service applies the exact rules (a note of
 * 1 to 1,000 characters after trimming, required for `note`; a client event
 * id of at most 200), with the same wording the web action gets.
 */
const bodySchema = z.object({
  action: z.enum(['acknowledge', 'note']),
  note: z.string().max(4000).nullish(),
  clientEventId: z.string().max(400).nullish(),
});

/**
 * POST /api/v1/exceptions/[id]/act — acknowledge an occurrence, or add a
 * note. Cookie or Bearer. Nobody can resolve an occurrence; the system does
 * that when the condition is gone.
 *
 * Who: stock:adjust and write access to the occurrence's warehouse (a manager
 * when it has none); viewers read only. exception_occurrence_act re-checks
 * all of it.
 *
 * Answers: 200 `{ occurrence }`; 400 bad body; 403 not allowed; 404 not
 * found or not visible; 409 `details.reason` = occurrence_resolved (already
 * resolved) or client_event_id_conflict. A replayed `clientEventId` (the
 * phone retrying) adds nothing and returns the row.
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

  const rl = await checkRateLimit(`exceptions-act:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: 'Choose acknowledge or note, with an optional note.' },
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
    const occurrence = await new ExceptionOccurrencesService(ctx).act(id, {
      action: body.action,
      note: body.note ?? null,
      clientEventId: body.clientEventId ?? null,
    });
    return NextResponse.json({ occurrence });
  } catch (e) {
    return exceptionsErrorResponse(e, 'api.v1.exceptions.act', ctx);
  }
}
