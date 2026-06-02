'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { err, ok, type ActionResult } from '@stockpilot/core';
import { LotsService } from '@/server/services/lots';
import { ServiceError } from '@/server/services/context';

const schema = z.object({
  orderRequestId: z.string().nullable(),
  orderRequestLineId: z.string().nullable(),
  itemId: z.string().min(1),
  picks: z
    .array(
      z.object({
        lotNumber: z.string().min(1),
        qty: z.coerce.number().positive(),
        expirationDate: z.string().nullable(),
      }),
    )
    .min(1),
});

export async function recordLotPicksAction(
  input: z.input<typeof schema>,
): Promise<ActionResult<{ recorded: number }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid lot picks.');
  }
  try {
    const svc = await LotsService.forCurrentUser();
    await svc.recordLotPicks(parsed.data);
    if (parsed.data.orderRequestId) {
      revalidatePath(`/dashboard/orders/${parsed.data.orderRequestId}/pick`);
      revalidatePath(`/dashboard/orders/${parsed.data.orderRequestId}`);
    }
    return ok({ recorded: parsed.data.picks.length });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
