'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ForbiddenError } from '@/lib/auth/warehouse';
import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  // ForbiddenError comes out of assertWarehouseAccess when the caller
  // isn't allowed to touch the warehouse. Map it to the 'forbidden'
  // ActionResult code so the client toast says "permission denied"
  // instead of a generic "Unknown error".
  if (error instanceof ForbiddenError) return err('forbidden', error.message);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

const startSchema = z
  .object({
    // 'group' counts BY VARIANT: the service expands each product group into
    // its variant items, then runs the ordinary selection path.
    scope: z.enum(['warehouse', 'selection', 'group']).default('warehouse'),
    warehouseId: z.string().uuid().nullable(),
    itemIds: z.array(z.string().uuid()).max(1000).optional(),
    groupIds: z.array(z.string().uuid()).max(200).optional(),
    notes: z.string().max(2000).optional().nullable(),
    assignedTo: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.scope !== 'selection' || (v.itemIds?.length ?? 0) > 0, {
    message: 'Pick at least one item to count.',
    path: ['itemIds'],
  })
  .refine((v) => v.scope !== 'group' || (v.groupIds?.length ?? 0) > 0, {
    message: 'Pick at least one product group to count.',
    path: ['groupIds'],
  });

export async function startCycleCountAction(input: {
  scope?: 'warehouse' | 'selection' | 'group';
  warehouseId: string | null;
  itemIds?: string[];
  groupIds?: string[];
  notes?: string | null;
  assignedTo?: string | null;
}): Promise<ActionResult<{ id: string; lineCount: number; skipped: number }>> {
  const parsed = startSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await CycleCountsService.forCurrentUser();
    const result = await svc.start(parsed.data);
    revalidatePath('/dashboard/cycle-counts');
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

const recordCountSchema = z.object({
  cycleCountId: z.string().uuid(),
  lineId: z.string().uuid(),
  countedQuantity: z.coerce.number().min(0).max(1_000_000_000),
  reason: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export async function recordCycleCountLineAction(input: {
  cycleCountId: string;
  lineId: string;
  countedQuantity: number;
  reason?: string | null;
  notes?: string | null;
}): Promise<ActionResult<void>> {
  const parsed = recordCountSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await CycleCountsService.forCurrentUser();
    await svc.recordCount(parsed.data);
    revalidatePath(`/dashboard/cycle-counts/${parsed.data.cycleCountId}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const clearCountSchema = z.object({
  cycleCountId: z.string().uuid(),
  lineId: z.string().uuid(),
});

export async function clearCycleCountLineAction(input: {
  cycleCountId: string;
  lineId: string;
}): Promise<ActionResult<void>> {
  const parsed = clearCountSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await CycleCountsService.forCurrentUser();
    await svc.clearCount(parsed.data);
    revalidatePath(`/dashboard/cycle-counts/${parsed.data.cycleCountId}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function cancelCycleCountAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await CycleCountsService.forCurrentUser();
    await svc.cancel(id);
    revalidatePath('/dashboard/cycle-counts');
    revalidatePath(`/dashboard/cycle-counts/${id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function postCycleCountAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await CycleCountsService.forCurrentUser();
    await svc.post(id);
    revalidatePath('/dashboard/cycle-counts');
    revalidatePath(`/dashboard/cycle-counts/${id}`);
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const assignSchema = z.object({
  id: z.string().uuid(),
  assignedTo: z.string().uuid().nullable(),
  expectedAssignee: z.string().uuid().nullable().optional(),
});

/**
 * Manager+ only — set or clear the assignee on a cycle count. Server-side
 * permission gate is the new 'cycle_counts:assign' permission; staff /
 * viewers will see "Permission denied" come back through ServiceError.
 *
 * `expectedAssignee` is an optional optimistic-concurrency guard — pass
 * what the client thinks the current assignee is. If a teammate changed
 * it in the meantime, the action returns a validation_error instead of
 * silently overwriting their pick. Pass undefined to skip the check.
 */
export async function assignCycleCountAction(input: {
  id: string;
  assignedTo: string | null;
  expectedAssignee?: string | null;
}): Promise<ActionResult<{ id: string; assignedTo: string | null }>> {
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await CycleCountsService.forCurrentUser();
    const row = await svc.assign(
      parsed.data.id,
      parsed.data.assignedTo,
      parsed.data.expectedAssignee,
    );
    revalidatePath('/dashboard/cycle-counts');
    revalidatePath(`/dashboard/cycle-counts/${parsed.data.id}`);
    return ok({ id: row.id, assignedTo: row.assigned_to });
  } catch (e) {
    return toResult(e);
  }
}
