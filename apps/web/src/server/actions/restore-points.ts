'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { rethrowControlFlow } from '@/lib/control-flow';
import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError, withContext } from '@/server/services/context';
import {
  createSnapshot,
  restorePointSkuChanges,
  restoreSnapshot,
  type RestorePointSkuChanges,
  type RestoreResult,
} from '@/server/services/restore-points';

import { err, ok, type ActionResult } from '@stockpilot/core';

const createSchema = z.object({ label: z.string().trim().max(120).optional() });
const restoreSchema = z.object({ id: z.string().uuid(), confirm: z.string().max(40) });
const pointSchema = z.object({ id: z.string().uuid() });

/**
 * A refusal as the browser gets it (Ungroup PR stage, security review SEC-T2).
 * An internal error's text is database or network detail, so it stays in the
 * server log and the browser gets the fixed words, with no details; every
 * other refusal keeps the words the service wrote for people, and its reason
 * (the MFA step-up, the audit log the SKU-change check cannot read), which the
 * screens act on.
 */
function refusal(e: unknown, internalWords: string): ActionResult<never> {
  rethrowControlFlow(e);
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    const reason =
      e.details && typeof e.details === 'object'
        ? (e.details as { reason?: unknown }).reason
        : undefined;
    return err(e.code, e.message, typeof reason === 'string' ? { reason } : undefined);
  }
  console.error(e);
  return err('internal_error', internalWords);
}

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
    return refusal(e, 'Could not create the restore point. Please try again.');
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
    return refusal(e, 'Could not restore this point. Please try again.');
  }
}

/**
 * Ungroup D1 (b): which records changed SKU after a restore point was taken,
 * read when its Restore row opens so the warning shows before the typed
 * confirm. A version 2 point (record ids) answers with no changes. Same gate
 * as the restore (owner/admin + Business), through the caller's RLS; a caller
 * who cannot view the audit log is refused with reason audit_log_hidden, which
 * the row says plainly (PR stage, DATA-1).
 */
export async function restorePointSkuChangesAction(
  input: z.infer<typeof pointSchema>,
): Promise<ActionResult<RestorePointSkuChanges>> {
  const parsed = pointSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const ctx = await withContext();
    return ok(await restorePointSkuChanges(ctx, parsed.data.id));
  } catch (e) {
    return refusal(e, 'Could not check for SKU changes. Please try again.');
  }
}
