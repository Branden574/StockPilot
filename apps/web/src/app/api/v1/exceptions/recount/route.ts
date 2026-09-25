import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ExceptionRecountService } from '@/server/services/exception-recount';

import { exceptionsErrorResponse, exceptionsRateLimitedResponse } from '../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The body. Loose bounds only: the service applies the exact rules (at most
 * 200 exceptions and 200 items, valid ids, a key of at most 200 characters)
 * with the same wording the web action gets.
 */
const bodySchema = z.object({
  occurrenceIds: z.array(z.string().max(100)).max(1000).nullish(),
  itemIds: z.array(z.string().max(100)).max(1000).nullish(),
  assignedTo: z.string().max(100).nullish(),
  idempotencyKey: z.string().max(400).nullish(),
});

/**
 * POST /api/v1/exceptions/recount — start a targeted recount (F1-2) from
 * exceptions and/or items. Cookie or Bearer.
 *
 * Who: managers and above with the cycle_counts module, cycle_counts:assign
 * and stock:adjust (and write access to the items' warehouses);
 * start_targeted_recount re-checks it.
 *
 * Body: `{ occurrenceIds?, itemIds?, assignedTo?, idempotencyKey? }`. Mint
 * `idempotencyKey` once per submission and send the SAME key when retrying:
 * a repeat answers with the first call's count (`replay: true`) instead of
 * starting a second one.
 *
 * Answers:
 *   201 a count was started; 200 nothing new was needed (every item was
 *       already being counted, or skipped), or a replay. The body is the
 *       service result: `{ cycleCountId, countNumber, reference, lineCount,
 *       created, replay, assignedTo, assignmentFailed, notes, linked,
 *       linkedExisting[], skipped[] }`.
 *   400 validation_error (`details.reason`: recount_nothing_selected,
 *       recount_too_many_items, invalid_argument, not_recountable, …);
 *   403 forbidden / module_disabled; 404 an exception or item not found or
 *       not visible;
 *   409 conflict: `details.reason` idempotency_conflict (the key was used
 *       for another selection) or recount_already_linked; with
 *       `details.retryable: true` (recount_busy, recount_items_changed, …)
 *       nothing was saved and sending the same request again is safe.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = await checkRateLimit(`exceptions-recount:${ctx.userId}`, 20, 60_000);
  if (!rl.allowed) return exceptionsRateLimitedResponse(rl.resetAt);

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'validation_error',
          message: 'Send the exceptions and items to recount as lists of ids.',
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
    const result = await new ExceptionRecountService(ctx).start({
      occurrenceIds: body.occurrenceIds ?? null,
      itemIds: body.itemIds ?? null,
      assignedTo: body.assignedTo ?? null,
      idempotencyKey: body.idempotencyKey ?? null,
    });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (e) {
    return exceptionsErrorResponse(e, 'api.v1.exceptions.recount', ctx);
  }
}
