'use server';

import { revalidatePath } from 'next/cache';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import { ReceivingService } from '@/server/services/receiving';

import {
  err,
  ok,
  postReceiptSchema,
  reverseReceiptSchema,
  type ActionResult,
  type PostReceiptInput,
  type ReverseReceiptInput,
} from '@stockpilot/core';

export async function postReceiptAction(
  input: PostReceiptInput,
): Promise<ActionResult<{ receiptId: string; receiptNumber: string }>> {
  const parsed = postReceiptSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await ReceivingService.forCurrentUser();
    const receipt = await svc.postReceipt(parsed.data);
    revalidatePath(`/dashboard/purchase-orders/${parsed.data.purchaseOrderId}`);
    revalidatePath('/dashboard/purchase-orders');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    return ok({ receiptId: receipt.id, receiptNumber: receipt.receipt_number });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function reverseReceiptAction(
  input: ReverseReceiptInput,
): Promise<ActionResult<{ reversalReceiptId: string }>> {
  const parsed = reverseReceiptSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await ReceivingService.forCurrentUser();
    const reversal = await svc.reverseReceipt(parsed.data);
    revalidatePath(`/dashboard/purchase-orders/${reversal.purchase_order_id}`);
    revalidatePath('/dashboard/purchase-orders');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    return ok({ reversalReceiptId: reversal.id });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
