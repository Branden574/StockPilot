'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ServiceError } from '@/server/services/context';
import { PoAttachmentsService } from '@/server/services/po-attachments';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

const addSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  storagePath: z.string().min(1).max(500),
  fileName: z.string().max(300).nullable(),
  contentType: z.string().max(150).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
});

export async function addPoAttachmentAction(input: {
  purchaseOrderId: string;
  storagePath: string;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
}): Promise<ActionResult<{ id: string }>> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await PoAttachmentsService.forCurrentUser();
    const result = await svc.add(parsed.data);
    revalidatePath(`/dashboard/purchase-orders/${parsed.data.purchaseOrderId}`);
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

const deleteSchema = z.object({
  attachmentId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
});

export async function deletePoAttachmentAction(input: {
  attachmentId: string;
  purchaseOrderId: string;
}): Promise<ActionResult<void>> {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await PoAttachmentsService.forCurrentUser();
    await svc.delete(parsed.data.attachmentId, parsed.data.purchaseOrderId);
    revalidatePath(`/dashboard/purchase-orders/${parsed.data.purchaseOrderId}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
