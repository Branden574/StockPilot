'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ServiceError, withContext } from '@/server/services/context';
import { createSnapshot } from '@/server/services/restore-points';

import { err, ok, type ActionResult } from '@stockpilot/core';

const createSchema = z.object({ label: z.string().trim().max(120).optional() });

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
