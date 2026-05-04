'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ServiceError } from '@/server/services/context';
import { BinsService, type BinType } from '@/server/services/bins';

import { err, ok, type ActionResult } from '@stockpilot/core';

const createBinSchema = z.object({
  warehouseId: z.string().uuid(),
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  binType: z.enum([
    'receiving',
    'storage',
    'qa_hold',
    'damaged',
    'rejected',
    'shipping',
  ]),
  isDefault: z.boolean().optional(),
});

export async function createBinAction(input: {
  warehouseId: string;
  code: string;
  name: string;
  binType: BinType;
  isDefault?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  const parsed = createBinSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await BinsService.forCurrentUser();
    const result = await svc.create(parsed.data);
    revalidatePath('/dashboard/admin/bins');
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function archiveBinAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await BinsService.forCurrentUser();
    await svc.archive(id);
    revalidatePath('/dashboard/admin/bins');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
