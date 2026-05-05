'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ServiceError } from '@/server/services/context';
import {
  createPoSchema,
  PurchaseOrdersService,
  type CreatePoInput,
} from '@/server/services/purchase-orders';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function createPoAction(input: CreatePoInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createPoSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await PurchaseOrdersService.forCurrentUser();
    const result = await svc.create(parsed.data);
    revalidatePath('/dashboard/purchase-orders');
    return ok({ id: result.id });
  } catch (e) {
    return toResult(e);
  }
}

const setDestinationSchema = z.object({
  poId: z.string().uuid(),
  warehouseId: z.string().uuid(),
});

/**
 * Resolves a destination_location_id for the given warehouse (re-using
 * an existing location or auto-creating one named after the warehouse)
 * and updates the PO. Used to backfill imported POs that were approved
 * before the import flow set this field automatically — the Receive
 * button is gated on this column being non-null.
 */
export async function setPoDestinationWarehouseAction(input: {
  poId: string;
  warehouseId: string;
}): Promise<ActionResult<void>> {
  const parsed = setDestinationSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const ctx = await requireOrgContext();
    const supabase = await createClient();

    // Reuse an existing location for the warehouse, or auto-create one.
    let locationId: string | null = null;
    const { data: existing, error: findErr } = await supabase
      .from('locations')
      .select('id')
      .eq('organization_id', ctx.organizationId)
      .eq('warehouse_id', parsed.data.warehouseId)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (findErr) throw new ServiceError('internal_error', findErr.message);
    if (existing?.id) {
      locationId = existing.id as string;
    } else {
      const { data: warehouse } = await supabase
        .from('warehouses')
        .select('name')
        .eq('organization_id', ctx.organizationId)
        .eq('id', parsed.data.warehouseId)
        .maybeSingle();
      if (!warehouse) {
        return err('not_found', 'Warehouse not found');
      }
      const { data: created, error: insErr } = await supabase
        .from('locations')
        .insert({
          organization_id: ctx.organizationId,
          warehouse_id: parsed.data.warehouseId,
          name: warehouse.name as string,
          type: 'warehouse',
        })
        .select('id')
        .single();
      if (insErr) throw new ServiceError('internal_error', insErr.message);
      locationId = created.id as string;
    }

    const { error: updErr } = await supabase
      .from('purchase_orders')
      .update({ destination_location_id: locationId })
      .eq('organization_id', ctx.organizationId)
      .eq('id', parsed.data.poId);
    if (updErr) throw new ServiceError('internal_error', updErr.message);

    revalidatePath(`/dashboard/purchase-orders/${parsed.data.poId}`);
    revalidatePath('/dashboard/purchase-orders');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function updatePoStatusAction(id: string, status: 'draft' | 'ordered' | 'cancelled'): Promise<ActionResult<void>> {
  try {
    const svc = await PurchaseOrdersService.forCurrentUser();
    await svc.updateStatus(id, status);
    revalidatePath('/dashboard/purchase-orders');
    revalidatePath(`/dashboard/purchase-orders/${id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

