'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ServiceError } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

// Per-line cap matches the public endpoint so a viewer can't drain an
// entire SKU's reservations in a single submit. Total-qty refine adds
// a second guard against split-across-many-lines abuse.
const MAX_QTY_PER_LINE = 10_000;
const MAX_TOTAL_QTY = 10_000;

const createSchema = z
  .object({
    warehouseId: z.string().uuid(),
    notes: z.string().max(2000).nullable().optional(),
    lines: z
      .array(
        z.object({
          itemId: z.string().uuid(),
          // I14: every order line is an integer count of books — fractional
          // requests like 1.5 don't represent anything sensible and would
          // confuse downstream stock-movement math. `.int()` rejects them
          // outright; `.coerce` keeps tolerating string inputs from form
          // posts.
          quantity: z.coerce.number().int().positive().max(MAX_QTY_PER_LINE),
          notes: z.string().max(500).nullable().optional(),
        }),
      )
      .min(1)
      .max(100),
  })
  .refine(
    (v) => v.lines.reduce((s, l) => s + l.quantity, 0) <= MAX_TOTAL_QTY,
    {
      message: `Total quantity across all lines cannot exceed ${MAX_TOTAL_QTY.toLocaleString()}.`,
      path: ['lines'],
    },
  );

export async function createOrderRequestAction(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    const row = await svc.create({
      warehouseId: parsed.data.warehouseId,
      notes: parsed.data.notes ?? null,
      lines: parsed.data.lines.map((l) => ({
        itemId: l.itemId,
        quantity: l.quantity,
        notes: l.notes ?? null,
      })),
    });
    revalidatePath('/dashboard/orders');
    return ok({ id: row.id });
  } catch (e) {
    return toResult(e);
  }
}

const cancelSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().max(500).nullable().optional(),
});

export async function cancelOrderRequestAction(
  input: z.input<typeof cancelSchema>,
): Promise<ActionResult<void>> {
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.cancel(parsed.data.id, parsed.data.reason ?? null);
    revalidatePath('/dashboard/orders');
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const approveSchema = z.object({
  id: z.string().uuid(),
  internalNotes: z.string().max(2000).nullable().optional(),
});

export async function approveOrderRequestAction(
  input: z.input<typeof approveSchema>,
): Promise<ActionResult<void>> {
  const parsed = approveSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.approve(parsed.data.id, parsed.data.internalNotes ?? null);
    revalidatePath('/dashboard/orders');
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const denySchema = z.object({
  id: z.string().uuid(),
  reason: z.string().min(1).max(500),
});

export async function denyOrderRequestAction(
  input: z.input<typeof denySchema>,
): Promise<ActionResult<void>> {
  const parsed = denySchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Reason required');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.deny(parsed.data.id, parsed.data.reason);
    revalidatePath('/dashboard/orders');
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const setStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['packing_slip_generated', 'staged_for_delivery']),
});

export async function setOrderRequestStatusAction(
  input: z.input<typeof setStatusSchema>,
): Promise<ActionResult<void>> {
  const parsed = setStatusSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.setStatus(parsed.data.id, parsed.data.status);
    revalidatePath('/dashboard/orders');
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function markOrderRequestDeliveredAction(
  id: string,
): Promise<ActionResult<void>> {
  if (!z.string().uuid().safeParse(id).success)
    return err('validation_error', 'Invalid id');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.markDelivered(id);
    revalidatePath('/dashboard/orders');
    revalidatePath(`/dashboard/orders/${id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const internalNotesSchema = z.object({
  id: z.string().uuid(),
  notes: z.string().max(2000).nullable(),
});

export async function setOrderInternalNotesAction(
  input: z.input<typeof internalNotesSchema>,
): Promise<ActionResult<void>> {
  const parsed = internalNotesSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.setInternalNotes(parsed.data.id, parsed.data.notes);
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function rotatePublicRequestTokenAction(): Promise<
  ActionResult<{ token: string }>
> {
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    const out = await svc.rotatePublicToken();
    revalidatePath('/dashboard/settings/public-requests');
    return ok(out);
  } catch (e) {
    return toResult(e);
  }
}

const blurbSchema = z.object({
  blurb: z.string().max(1000).nullable(),
});

export async function setPublicRequestBlurbAction(
  input: z.input<typeof blurbSchema>,
): Promise<ActionResult<void>> {
  const parsed = blurbSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.setBlurb(parsed.data.blurb);
    revalidatePath('/dashboard/settings/public-requests');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const warehousePublicSchema = z.object({
  warehouseId: z.string().uuid(),
  isPublicOrderable: z.boolean(),
});

export async function setWarehousePublicOrderableAction(
  input: z.input<typeof warehousePublicSchema>,
): Promise<ActionResult<void>> {
  const parsed = warehousePublicSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.setWarehousePublicOrderable(
      parsed.data.warehouseId,
      parsed.data.isPublicOrderable,
    );
    revalidatePath('/dashboard/settings/public-requests');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
