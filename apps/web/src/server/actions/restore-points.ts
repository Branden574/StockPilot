'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError, withContext } from '@/server/services/context';
import {
  createSnapshot,
  restoreSnapshot,
  type RestoreResult,
} from '@/server/services/restore-points';

import { err, ok, type ActionResult } from '@stockpilot/core';

const createSchema = z.object({ label: z.string().trim().max(120).optional() });
const restoreSchema = z.object({ id: z.string().uuid(), confirm: z.string().max(40) });

/**
 * Create a manual restore point (snapshot of items + stock). Gating
 * (Business+, owner/admin, MFA) lives in the service via
 * assertRestorePointsAccess.
 */
export async function createRestorePointAction(
  input: z.infer<typeof createSchema>,
): Promise<ActionResult<{ id: string; itemCount: number; capped: boolean }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid label');
  try {
    const ctx = await withContext();
    const res = await createSnapshot(ctx, { kind: 'manual', label: parsed.data.label ?? null });
    revalidatePath('/dashboard/settings/restore-points');
    return ok(res);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

/**
 * Restore inventory to a snapshot (safe reconcile). DANGEROUS — gated in the
 * service by owner/admin + Business+ + a fresh MFA step-up + the typed confirm
 * phrase. Returns `aal2_required` so the UI can re-prompt for MFA.
 */
export async function restoreFromPointAction(
  input: z.infer<typeof restoreSchema>,
): Promise<ActionResult<RestoreResult>> {
  const parsed = restoreSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const ctx = await withContext();
    const res = await restoreSnapshot(ctx, { id: parsed.data.id, confirm: parsed.data.confirm });
    revalidatePath('/dashboard/settings/restore-points');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    return ok(res);
  } catch (e) {
    if (e instanceof ServiceError) {
      const reason =
        e.details && typeof e.details === 'object'
          ? (e.details as { reason?: string }).reason
          : undefined;
      return err(e.code, e.message, reason ? { reason } : undefined);
    }
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
