'use server';
import { z } from 'zod';
import { err, ok, type ActionResult } from '@stockpilot/core';
import { DeliveryTrackingService } from '@/server/services/delivery-tracking';
import { ServiceError } from '@/server/services/context';

const schema = z.object({
  orderId: z.string().uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).optional(),
  accuracy: z.number().nonnegative().optional(),
});

export async function shareDeliveryLocationAction(input: z.input<typeof schema>): Promise<ActionResult<{ ok: true }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid location.');
  try {
    const svc = await DeliveryTrackingService.forCurrentUser();
    const { orderId, ...point } = parsed.data;
    await svc.shareLocation(orderId, point);
    return ok({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
