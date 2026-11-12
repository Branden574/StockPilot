'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { rethrowControlFlow } from '@/lib/control-flow';
import { OrderAttachmentsService } from '@/server/services/order-attachments';
import { actionErrorResult } from '@/server/lib/action-error-result';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  rethrowControlFlow(error);
  return actionErrorResult(error, 'actions.order_attachments');
}

const addSchema = z.object({
  orderRequestId: z.string().uuid(),
  storagePath: z.string().min(1).max(500),
  fileName: z.string().max(300).nullable(),
  contentType: z.string().max(150).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  kind: z.enum(['signature', 'dropoff_photo', 'location', 'other']).default('other'),
});

export async function addOrderAttachmentAction(input: {
  orderRequestId: string;
  storagePath: string;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  kind?: 'signature' | 'dropoff_photo' | 'location' | 'other';
}): Promise<ActionResult<{ id: string }>> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await OrderAttachmentsService.forCurrentUser();
    const result = await svc.add(parsed.data);
    revalidatePath(`/dashboard/orders/${parsed.data.orderRequestId}`);
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

const deleteSchema = z.object({
  attachmentId: z.string().uuid(),
  orderRequestId: z.string().uuid(),
});

export async function deleteOrderAttachmentAction(input: {
  attachmentId: string;
  orderRequestId: string;
}): Promise<ActionResult<void>> {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderAttachmentsService.forCurrentUser();
    await svc.remove(parsed.data.attachmentId);
    revalidatePath(`/dashboard/orders/${parsed.data.orderRequestId}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
