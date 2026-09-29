'use server';

import { z } from 'zod';

import {
  can,
  READINESS_FORBIDDEN_COPY,
  READINESS_ORDER_NOT_FOUND_COPY,
  type OrderReadinessResult,
} from '@stockpilot/core';

import { withContext, type ServiceContext } from '@/server/services/context';
import { OrderReadinessService } from '@/server/services/order-readiness';

const readSchema = z.object({ id: z.string().uuid() });

/** What a failed context (signed out, no organization) reads as. */
const READ_FAILED_MESSAGE = 'Could not check readiness.';

/**
 * Read an order's readiness AGAIN, after "Approve partial" or "Resume
 * fulfillment" committed (F2-3, the order page's approve-partial dialog).
 *
 * The dialog's message is computed from THIS read (core describePartialResult,
 * the order's own holds, `heldOwn`), never from the preview it showed before
 * the commit: the commit re-checks stock inside its own transaction, and stock
 * can move in between. The same read the order page makes
 * (OrderReadinessService.result: order_readiness_facts as the caller, judged
 * by core), so the dialog and the strip under it say the same thing.
 *
 * READ ONLY. It writes nothing, and it never throws: any failure is
 * `{ state: 'failed' }` (the service reports its own faults), which the dialog
 * words as "What is held now couldn't be checked", claiming no number. A
 * missing session does not redirect from here: the commit already happened,
 * and the message says it could not be checked.
 *
 * WHO. Its only caller follows approve partial and resume, which both assert
 * `orders:approve`; anyone else is refused before any read. The facts function
 * gates every field for the reader in its own body (0377).
 */
export async function readOrderReadinessAction(
  input: z.input<typeof readSchema>,
): Promise<OrderReadinessResult> {
  const parsed = readSchema.safeParse(input);
  if (!parsed.success) return { state: 'failed', message: READINESS_ORDER_NOT_FOUND_COPY };
  let ctx: ServiceContext;
  try {
    ctx = await withContext();
  } catch {
    return { state: 'failed', message: READ_FAILED_MESSAGE };
  }
  if (!can(ctx, 'orders:approve')) return { state: 'failed', message: READINESS_FORBIDDEN_COPY };
  return new OrderReadinessService(ctx).result(parsed.data.id);
}
