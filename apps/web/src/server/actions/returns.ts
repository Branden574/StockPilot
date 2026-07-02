'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import {
  RMAService,
  type ReturnRow,
  type ReturnWithLines,
} from '@/server/services/returns';
import { ShippingService, type CarrierShipmentRow } from '@/server/services/shipping';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * Server actions wrapping RMAService. Every method on the service already
 * gates on the `returns` module being enabled AND the caller holding
 * `returns:manage` (it throws a ServiceError otherwise), so these actions stay
 * thin — parse, call, revalidate, map errors to an ActionResult.
 */

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

const createLineSchema = z.object({
  orderRequestLineId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  disposition: z.enum(['restock', 'scrap']),
});

const createFromOrderSchema = z.object({
  orderRequestId: z.string().uuid(),
  reasonCode: z
    .enum(['damaged', 'wrong_item', 'end_of_year', 'overage', 'other'])
    .optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(createLineSchema).min(1),
});

export async function createReturnFromOrderAction(input: {
  orderRequestId: string;
  reasonCode?: 'damaged' | 'wrong_item' | 'end_of_year' | 'overage' | 'other';
  notes?: string;
  lines: Array<{
    orderRequestLineId: string;
    quantity: number;
    disposition: 'restock' | 'scrap';
  }>;
}): Promise<ActionResult<ReturnWithLines>> {
  const parsed = createFromOrderSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await RMAService.forCurrentUser();
    const result = await svc.createFromOrder(parsed.data.orderRequestId, {
      reasonCode: parsed.data.reasonCode,
      notes: parsed.data.notes,
      lines: parsed.data.lines,
    });
    revalidatePath('/dashboard/returns');
    revalidatePath(`/dashboard/orders/${parsed.data.orderRequestId}`);
    revalidatePath(`/dashboard/returns/${result.id}`);
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

const idSchema = z.string().uuid();

function revalidateReturn(id: string) {
  revalidatePath('/dashboard/returns');
  revalidatePath(`/dashboard/returns/${id}`);
}

export async function approveReturnAction(id: string): Promise<ActionResult<ReturnRow>> {
  if (!idSchema.safeParse(id).success) return err('validation_error', 'Invalid return id');
  try {
    const svc = await RMAService.forCurrentUser();
    const row = await svc.approve(id);
    revalidateReturn(id);
    return ok(row);
  } catch (e) {
    return toResult(e);
  }
}

const denySchema = z.object({
  id: z.string().uuid(),
  reason: z.string().max(500).optional().nullable(),
});

export async function denyReturnAction(input: {
  id: string;
  reason?: string | null;
}): Promise<ActionResult<ReturnRow>> {
  const parsed = denySchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await RMAService.forCurrentUser();
    const row = await svc.deny(parsed.data.id, parsed.data.reason ?? null);
    revalidateReturn(parsed.data.id);
    return ok(row);
  } catch (e) {
    return toResult(e);
  }
}

export async function receiveReturnAction(id: string): Promise<ActionResult<ReturnRow>> {
  if (!idSchema.safeParse(id).success) return err('validation_error', 'Invalid return id');
  try {
    const svc = await RMAService.forCurrentUser();
    const row = await svc.receive(id);
    revalidateReturn(id);
    return ok(row);
  } catch (e) {
    return toResult(e);
  }
}

/**
 * received → closed. This is the only action that moves inventory (the service
 * runs the process_return_disposition RPC). Also revalidate inventory so the
 * restock/scrap shows up immediately.
 */
export async function closeReturnAction(id: string): Promise<ActionResult<ReturnRow>> {
  if (!idSchema.safeParse(id).success) return err('validation_error', 'Invalid return id');
  try {
    const svc = await RMAService.forCurrentUser();
    const row = await svc.close(id);
    revalidateReturn(id);
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard');
    return ok(row);
  } catch (e) {
    return toResult(e);
  }
}

export async function cancelReturnAction(id: string): Promise<ActionResult<ReturnRow>> {
  if (!idSchema.safeParse(id).success) return err('validation_error', 'Invalid return id');
  try {
    const svc = await RMAService.forCurrentUser();
    const row = await svc.cancel(id);
    revalidateReturn(id);
    return ok(row);
  } catch (e) {
    return toResult(e);
  }
}

/**
 * Buy a reverse (RMA) EasyPost label for an approved/received return. Delegates
 * to ShippingService.buyReturnLabel, which gates on the `shipping` module being
 * enabled AND `shipping:manage` (owner/admin) — independently of the `returns`
 * gate already applied to render this page — and is idempotent (an existing
 * purchased return label short-circuits, so a retry never double-charges).
 */
export async function buyReturnLabelAction(
  id: string,
): Promise<ActionResult<CarrierShipmentRow>> {
  if (!idSchema.safeParse(id).success) return err('validation_error', 'Invalid return id');
  try {
    const svc = await ShippingService.forCurrentUser();
    const shipment = await svc.buyReturnLabel(id);
    revalidateReturn(id);
    return ok(shipment);
  } catch (e) {
    return toResult(e);
  }
}
