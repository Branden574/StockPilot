import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ExceptionOccurrencesService } from '@/server/services/exception-occurrences';

import { exceptionsErrorResponse, exceptionsRateLimitedResponse } from '../../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The body: the count and the counted number the person was shown (the
 * detail's countConfirm block sends both back), and an optional note. Loose
 * bounds only: the service applies the exact rules (a note of at most 1,000
 * characters after trimming) with the same wording the web action gets. No
 * client event id: a lost answer is resent as is, and the database answers
 * the resend as a replay from what it stored.
 */
const bodySchema = z.object({
  cycleCountId: z.string().uuid(),
  countedQuantity: z.number().finite(),
  note: z.string().max(4000).nullish(),
});

/**
 * POST /api/v1/exceptions/[id]/confirm-count — confirm the counted number of
 * a count difference (count_variance), which closes it at once without a
 * second count (migration 0386). Cookie or Bearer.
 *
 * Who: the person who recorded the counted line, or a manager, who also has
 * stock:adjust and write access to the item's warehouse (a manager when it
 * has none). exception_confirm_count re-checks all of it, and that the count
 * shown is still the item's latest, that no linked recount or other count in
 * progress is about to settle it, that the item can still be counted, and
 * that the stock on record still equals the counted number.
 *
 * Rate limit: the act bucket (`exceptions-act:<user>`, 60 a minute), shared
 * with acknowledge and note and with the web action.
 *
 * Answers: 200 `{ occurrence, replay }`; 400 bad id or body; 401; 403
 * `details.reason` not_counter | not_permitted; 404 not found or not visible;
 * 409 `details.reason` occurrence_resolved | count_changed |
 * recount_in_progress | count_in_progress | not_countable | stock_moved |
 * already_confirmed | not_confirmable | busy | unavailable | unknown; 429.
 * `unavailable` also answers while confirming is switched off
 * (EXCEPTION_COUNT_CONFIRM_ENABLED).
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
  if (!rl.allowed) return exceptionsRateLimitedResponse(rl.resetAt);

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'validation_error',
          message: 'Send the count and the counted number that were shown, with an optional note.',
        },
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
    const result = await new ExceptionOccurrencesService(ctx).confirmCount(id, {
      cycleCountId: body.cycleCountId,
      countedQuantity: body.countedQuantity,
      note: body.note ?? null,
    });
    return NextResponse.json({ occurrence: result.occurrence, replay: result.replay });
  } catch (e) {
    return exceptionsErrorResponse(e, 'api.v1.exceptions.confirm_count', ctx);
  }
}
