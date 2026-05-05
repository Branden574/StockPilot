'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

const startSchema = z.object({
  warehouseId: z.string().uuid().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export async function startCycleCountAction(input: {
  warehouseId: string | null;
  notes?: string | null;
}): Promise<ActionResult<{ id: string; lineCount: number }>> {
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
    revalidatePath('/dashboard');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
