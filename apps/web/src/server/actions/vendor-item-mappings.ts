'use server';

import { revalidatePath } from 'next/cache';

import { VendorItemMappingsService } from '@/server/services/vendor-item-mappings';
import { actionErrorResult } from '@/server/lib/action-error-result';

import {
  err,
  ok,
  upsertVendorItemMappingSchema,
  type ActionResult,
  type UpsertVendorItemMappingInput,
} from '@stockpilot/core';

export async function upsertVendorItemMappingAction(
  input: UpsertVendorItemMappingInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = upsertVendorItemMappingSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await VendorItemMappingsService.forCurrentUser();
    const result = await svc.upsert(parsed.data);
    revalidatePath('/dashboard/admin/vendor-mappings');
    return ok(result);
  } catch (e) {
    return actionErrorResult(e, 'actions.vendor_item_mappings.upsert_vendor_item_mapping');
  }
}

export async function deleteVendorItemMappingAction(
  id: string,
): Promise<ActionResult<void>> {
  try {
    const svc = await VendorItemMappingsService.forCurrentUser();
    await svc.delete(id);
    revalidatePath('/dashboard/admin/vendor-mappings');
    return ok(undefined);
  } catch (e) {
    return actionErrorResult(e, 'actions.vendor_item_mappings.delete_vendor_item_mapping');
  }
}
