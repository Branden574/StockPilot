'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ServiceError, withContext } from '@/server/services/context';
import {
  importItemsFromIntacct,
  type IntacctImportSummary,
} from '@/server/services/intacct-import';

import { err, ok, type ActionResult } from '@stockpilot/core';

const inputSchema = z.object({
  /** Target warehouse for the imported items. Optional only when the org has
   *  exactly one writable warehouse (the service resolves that case). */
  warehouseId: z.string().uuid().optional(),
});

/**
 * "Import items from Sage Intacct" (Integrations panel). Permission +
 * module gating live in the service (integrations:manage + items:import);
 * the action is a thin boundary.
 */
export async function importFromIntacctAction(
  input: z.infer<typeof inputSchema> = {},
): Promise<ActionResult<IntacctImportSummary>> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const ctx = await withContext();
    const summary = await importItemsFromIntacct(ctx, parsed.data);
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/settings/integrations');
    return ok(summary);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
