'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import { BundlesService } from '@/server/services/bundles';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

const componentInputSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.coerce.number().positive().max(1_000_000),
  isOptional: z.boolean().optional(),
});

const createBundleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().max(64).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  preassemblyEnabled: z.boolean().optional(),
  components: z.array(componentInputSchema).min(1).max(100),
});

export async function createBundleAction(
  input: z.input<typeof createBundleSchema>,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createBundleSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await BundlesService.forCurrentUser();
    const detail = await svc.create(parsed.data);
    revalidatePath('/dashboard/bundles');
    return ok({ id: detail.bundle.id });
  } catch (e) {
    return toResult(e);
  }
}

const updateBundleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  sku: z.string().trim().max(64).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
  preassemblyEnabled: z.boolean().optional(),
  components: z.array(componentInputSchema).min(1).max(100).optional(),
});

export async function updateBundleAction(
  input: z.input<typeof updateBundleSchema>,
): Promise<ActionResult<void>> {
  const parsed = updateBundleSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await BundlesService.forCurrentUser();
    const { id, ...patch } = parsed.data;
    await svc.update(id, patch);
    revalidatePath('/dashboard/bundles');
    revalidatePath(`/dashboard/bundles/${id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function archiveBundleAction(id: string): Promise<ActionResult<void>> {
  if (!z.string().uuid().safeParse(id).success) return err('validation_error', 'Invalid id');
  try {
    const svc = await BundlesService.forCurrentUser();
    await svc.archive(id);
    revalidatePath('/dashboard/bundles');
    revalidatePath(`/dashboard/bundles/${id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function restoreBundleAction(id: string): Promise<ActionResult<void>> {
  if (!z.string().uuid().safeParse(id).success) return err('validation_error', 'Invalid id');
  try {
    const svc = await BundlesService.forCurrentUser();
    await svc.restore(id);
    revalidatePath('/dashboard/bundles');
    revalidatePath(`/dashboard/bundles/${id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const setActiveSchema = z.object({
  id: z.string().uuid(),
  isActive: z.boolean(),
});

export async function setBundleActiveAction(
  input: z.input<typeof setActiveSchema>,
): Promise<ActionResult<void>> {
  const parsed = setActiveSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await BundlesService.forCurrentUser();
    await svc.setActive(parsed.data.id, parsed.data.isActive);
    revalidatePath('/dashboard/bundles');
    revalidatePath(`/dashboard/bundles/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const assembleSchema = z.object({
  id: z.string().uuid(),
  quantity: z.coerce.number().positive().max(1_000_000),
  warehouseId: z.string().uuid(),
  notes: z.string().max(2000).nullable().optional(),
});

export async function assembleBundleAction(
  input: z.input<typeof assembleSchema>,
): Promise<ActionResult<{ phantomItemId: string; phantomQty: number }>> {
  const parsed = assembleSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await BundlesService.forCurrentUser();
    const out = await svc.assemble(
      parsed.data.id,
      parsed.data.quantity,
      parsed.data.warehouseId,
      parsed.data.notes ?? null,
    );
    revalidatePath(`/dashboard/bundles/${parsed.data.id}`);
    await revalidateInventoryListForCurrentOrg();
    return ok(out);
  } catch (e) {
    return toResult(e);
  }
}

const distributeSchema = z.object({
  id: z.string().uuid(),
  quantity: z.coerce.number().positive().max(1_000_000),
  warehouseId: z.string().uuid(),
  scheduleEventId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  allowShortage: z.boolean().optional(),
});

export async function distributeBundleAction(
  input: z.input<typeof distributeSchema>,
): Promise<ActionResult<{ distributionId: string }>> {
  const parsed = distributeSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await BundlesService.forCurrentUser();
    const out = await svc.distribute(parsed.data.id, {
      quantity: parsed.data.quantity,
      warehouseId: parsed.data.warehouseId,
      scheduleEventId: parsed.data.scheduleEventId ?? null,
      notes: parsed.data.notes ?? null,
      allowShortage: parsed.data.allowShortage ?? false,
    });
    revalidatePath(`/dashboard/bundles/${parsed.data.id}`);
    revalidatePath('/dashboard/bundles');
    await revalidateInventoryListForCurrentOrg();
    return ok(out);
  } catch (e) {
    return toResult(e);
  }
}

const previewSchema = z.object({
  id: z.string().uuid(),
  quantity: z.coerce.number().positive().max(1_000_000),
  warehouseId: z.string().uuid(),
});

export async function previewBundleDistributionAction(
  input: z.input<typeof previewSchema>,
) {
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await BundlesService.forCurrentUser();
    const preview = await svc.preview(
      parsed.data.id,
      parsed.data.quantity,
      parsed.data.warehouseId,
    );
    return ok(preview);
  } catch (e) {
    return toResult(e);
  }
}
