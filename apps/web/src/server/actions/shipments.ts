'use server';

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';
import { ShipmentsService } from '@/server/services/shipments';

import {
  createShipmentFromOrderRequestSchema,
  manualCreateShipmentSchema,
  err,
  ok,
  type ActionResult,
  type CreateShipmentFromOrderRequestInput,
  type ManualCreateShipmentInput,
} from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function createShipmentFromOrderRequestAction(
  input: CreateShipmentFromOrderRequestInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createShipmentFromOrderRequestSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await ShipmentsService.forCurrentUser();
    const result = await svc.createFromOrderRequest({
      orderRequestId: parsed.data.orderRequestId,
      sourceWarehouseId: parsed.data.sourceWarehouseId,
      destinationCharterId: parsed.data.destinationCharterId,
      attentionToName: parsed.data.attentionToName ?? null,
      notes: parsed.data.notes ?? null,
      ccEmails: parsed.data.ccEmails ?? [],
    });
    revalidatePath('/dashboard/shipments');
    revalidatePath(`/dashboard/orders/${parsed.data.orderRequestId}`);
    return ok({ id: result.id });
  } catch (e) {
    return toResult(e);
  }
}

export async function manualCreateShipmentAction(
  input: ManualCreateShipmentInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = manualCreateShipmentSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await ShipmentsService.forCurrentUser();
    const result = await svc.manualCreate({
      sourceWarehouseId: parsed.data.sourceWarehouseId,
      destinationCharterId: parsed.data.destinationCharterId,
      attentionToName: parsed.data.attentionToName ?? null,
      notes: parsed.data.notes ?? null,
      ccEmails: parsed.data.ccEmails ?? [],
      lines: parsed.data.lines,
    });
    revalidatePath('/dashboard/shipments');
    return ok({ id: result.id });
  } catch (e) {
    return toResult(e);
  }
}

export async function markShipmentShippedAction(
  id: string,
): Promise<ActionResult<void>> {
  try {
    const svc = await ShipmentsService.forCurrentUser();
    await svc.markShipped(id);
    revalidatePath('/dashboard/shipments');
    revalidatePath(`/dashboard/shipments/${id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function markShipmentCancelledAction(
  id: string,
): Promise<ActionResult<void>> {
  try {
    const svc = await ShipmentsService.forCurrentUser();
    await svc.markCancelled(id);
    revalidatePath('/dashboard/shipments');
    revalidatePath(`/dashboard/shipments/${id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function markShipmentDeliveredAction(args: {
  id: string;
  receiverName: string;
  deliveredAt?: string | null;
}): Promise<ActionResult<void>> {
  try {
    const svc = await ShipmentsService.forCurrentUser();
    await svc.markDelivered(args.id, {
      receiverName: args.receiverName,
      deliveredAt: args.deliveredAt ?? null,
    });
    revalidatePath('/dashboard/shipments');
    revalidatePath(`/dashboard/shipments/${args.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
