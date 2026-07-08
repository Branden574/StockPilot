'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ServiceError } from '@/server/services/context';
import {
  MAX_SERIAL_LENGTH,
  MAX_SERIALS_PER_ADD,
  SERIAL_STATUSES,
  SerialsService,
  type SerialsPage,
  type SerialStatus,
} from '@/server/services/serials';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) {
    return err(error.code, error.message);
  }
  // Never surface a raw exception message (DB / network internals) to the
  // client — log server-side, return a generic string (S13 boundary).
  console.error(error);
  return err('internal_error', 'Something went wrong. Please try again.');
}

/**
 * Revalidate every detail route that renders <ItemDetail> (inventory, books,
 * rentals) so the panel's server-fed first page reflects the write on the
 * next render regardless of which surface the user is on.
 */
function revalidateItemDetail(itemId: string): void {
  revalidatePath(`/dashboard/inventory/${itemId}`);
  revalidatePath(`/dashboard/books/${itemId}`);
  revalidatePath(`/dashboard/rentals/items/${itemId}`);
}

const listSerialsSchema = z.object({
  itemId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
});

export async function listItemSerialsAction(
  itemId: string,
  page: number = 1,
): Promise<ActionResult<SerialsPage>> {
  const parsed = listSerialsSchema.safeParse({ itemId, page });
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await SerialsService.forCurrentUser();
    return ok(await svc.list(parsed.data.itemId, { page: parsed.data.page }));
  } catch (e) {
    return toResult(e);
  }
}

const addSerialsSchema = z.object({
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  // Raw lines from the textarea — the service trims, drops empties, and
  // de-duplicates. Cap the raw list too so an oversized payload never even
  // reaches the service.
  serials: z.array(z.string().max(MAX_SERIAL_LENGTH * 4)).min(1).max(MAX_SERIALS_PER_ADD),
});
export type AddItemSerialsInput = z.infer<typeof addSerialsSchema>;

export async function addItemSerialsAction(
  input: AddItemSerialsInput,
): Promise<ActionResult<{ added: number }>> {
  const parsed = addSerialsSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await SerialsService.forCurrentUser();
    const result = await svc.add(parsed.data.itemId, parsed.data.warehouseId, parsed.data.serials);
    revalidateItemDetail(parsed.data.itemId);
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

const updateSerialSchema = z
  .object({
    id: z.string().uuid(),
    serialNumber: z.string().min(1).max(MAX_SERIAL_LENGTH * 4).optional(),
    status: z.enum(SERIAL_STATUSES).optional(),
  })
  .refine((v) => v.serialNumber !== undefined || v.status !== undefined, {
    message: 'Nothing to update.',
  });
export type UpdateItemSerialInput = z.infer<typeof updateSerialSchema>;

export async function updateItemSerialAction(
  input: UpdateItemSerialInput,
): Promise<ActionResult<{ id: string; serialNumber: string; currentStatus: SerialStatus }>> {
  const parsed = updateSerialSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await SerialsService.forCurrentUser();
    const updated = await svc.updateSerial(parsed.data.id, {
      ...(parsed.data.serialNumber !== undefined
        ? { serialNumber: parsed.data.serialNumber }
        : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    });
    revalidateItemDetail(updated.itemId);
    return ok({
      id: updated.id,
      serialNumber: updated.serialNumber,
      currentStatus: updated.currentStatus,
    });
  } catch (e) {
    return toResult(e);
  }
}

const deleteSerialSchema = z.object({ id: z.string().uuid() });

export async function deleteItemSerialAction(input: {
  id: string;
}): Promise<ActionResult<void>> {
  const parsed = deleteSerialSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await SerialsService.forCurrentUser();
    const { itemId } = await svc.remove(parsed.data.id);
    revalidateItemDetail(itemId);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
