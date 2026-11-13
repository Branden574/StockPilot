'use server';

import { revalidatePath } from 'next/cache';

import { UomConversionsService } from '@/server/services/uom-conversions';
import { actionErrorResult } from '@/server/lib/action-error-result';

import {
  err,
  ok,
  upsertUomConversionSchema,
  type ActionResult,
  type UpsertUomConversionInput,
} from '@stockpilot/core';

export async function upsertUomConversionAction(
  input: UpsertUomConversionInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = upsertUomConversionSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await UomConversionsService.forCurrentUser();
    const result = await svc.upsert(parsed.data);
    revalidatePath('/dashboard/admin/uom-conversions');
    return ok(result);
  } catch (e) {
    return actionErrorResult(e, 'actions.uom_conversions.upsert_uom_conversion');
  }
}

export async function deleteUomConversionAction(
  id: string,
): Promise<ActionResult<void>> {
  try {
    const svc = await UomConversionsService.forCurrentUser();
    await svc.delete(id);
    revalidatePath('/dashboard/admin/uom-conversions');
    return ok(undefined);
  } catch (e) {
    return actionErrorResult(e, 'actions.uom_conversions.delete_uom_conversion');
  }
}
