'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError, withContext } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

import { err, isManagerOrAbove, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

/**
 * Bust the storefront catalog cache (60s TTL) after any mutation that moves
 * availability (available = on-hand − reserved): approve/partial-approve and
 * resume RESERVE stock; cancel/deny/close-partial RELEASE it; the signature
 * hand-over DECREMENTS on-hand. Without this the "Place an Order" page shows
 * stale avail pills for up to a minute after an order changes state — the
 * owner expects near-instant. Same global-tag pattern as user-categories
 * (these mutations are orders-of-magnitude rarer than catalog reads, so
 * nuking the tag org-wide is cheap).
 */
function revalidateOrdersCatalog() {
  revalidateTag('orders-new-v2-catalog', 'max');
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
    // Structured needed-by datetime; must be in the future when provided.
    neededBy: z
      .string()
      .datetime({ offset: true })
      .nullish()
      .refine((v) => !v || new Date(v).getTime() > Date.now(), {
        message: 'Needed-by must be in the future.',
      }),
    // Rolling-deploy safety: default to 'pickup' when an older client
    // bundle submits without the field. Mirrors the public POST schema
    // so behavior stays consistent across both create surfaces.
    fulfillmentType: z.enum(['pickup', 'delivery']).default('pickup'),
    requesterPhone: z.string().trim().max(40).nullish(),
    deliveryCharterId: z.string().uuid().nullish(),
    pickupLocationNotes: z.string().trim().max(2000).nullish(),
    onBehalfOf: z
      .object({
        name: z.string().trim().min(1).max(120),
        email: z.string().trim().email().max(254),
      })
      .nullish(),
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
  .refine((v) => v.lines.reduce((s, l) => s + l.quantity, 0) <= MAX_TOTAL_QTY, {
    message: `Total quantity across all lines cannot exceed ${MAX_TOTAL_QTY.toLocaleString()}.`,
    path: ['lines'],
  });

export async function createOrderRequestAction(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<{ id: string; orderNumber: number | null }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  // Cross-field check shared with the public POST route: a delivery
  // fulfillment is meaningless without a site (charter) to ship to.
  if (parsed.data.fulfillmentType === 'delivery' && !parsed.data.deliveryCharterId) {
    return err('validation_error', 'Delivery orders need a site.');
  }
  try {
    // Gate `onBehalfOf` to manager+. The service itself doesn't know
    // who's calling; building the ServiceContext here gives us the
    // caller's role before we even touch the DB.
    if (parsed.data.onBehalfOf) {
      const ctx = await withContext();
      if (!isManagerOrAbove(ctx.role)) {
        return err('forbidden', 'Only managers can create orders on behalf of others.');
      }
    }
    const svc = await OrderRequestsService.forCurrentUser();
    const row = await svc.create({
      warehouseId: parsed.data.warehouseId,
      notes: parsed.data.notes ?? null,
      neededBy: parsed.data.neededBy ?? null,
      fulfillmentType: parsed.data.fulfillmentType,
      requesterPhone: parsed.data.requesterPhone ?? null,
      deliveryCharterId: parsed.data.deliveryCharterId ?? null,
      pickupLocationNotes: parsed.data.pickupLocationNotes ?? null,
      onBehalfOf: parsed.data.onBehalfOf ?? null,
      lines: parsed.data.lines.map((l) => ({
        itemId: l.itemId,
        quantity: l.quantity,
        notes: l.notes ?? null,
      })),
    });
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    // `create()` already returns the full inserted row from
    // `.insert(...).select('*').single()`, and `order_number` is assigned by the
    // BEFORE-INSERT trigger `assign_order_request_number` (migration 0254) under
    // an advisory lock, so it is populated by the time we get here. Returning it
    // is what lets the success screen and the delivery-request email print the
    // SAME handle the orders list prints.
    return ok({ id: row.id, orderNumber: row.order_number ?? null });
  } catch (e) {
    return toResult(e);
  }
}

const setNeededBySchema = z.object({
  id: z.string().uuid(),
  neededBy: z
    .string()
    .datetime({ offset: true })
    .refine((v) => new Date(v).getTime() > Date.now(), {
      message: 'Needed-by must be in the future.',
    }),
});

/**
 * Manager: set/replace a pending order's needed-by deadline (typically from
 * the AI note-parse suggestion). Pending-only — after approval the schedule
 * event already exists and edits belong on the event itself.
 */
export async function setOrderNeededByAction(
  input: z.input<typeof setNeededBySchema>,
): Promise<ActionResult<void>> {
  const parsed = setNeededBySchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const ctx = await withContext();
    const { assertPermission } = await import('@/server/services/context');
    assertPermission(ctx, 'orders:approve');
    const { data: row, error } = await ctx.supabase
      .from('order_requests')
      .update({ needed_by: parsed.data.neededBy })
      .eq('id', parsed.data.id)
      .eq('organization_id', ctx.organizationId)
      .eq('status', 'pending_approval')
      .select('id')
      .maybeSingle();
    if (error) return err('internal_error', error.message);
    if (!row) return err('conflict', 'Order not found or no longer pending.');
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

/**
 * Manager: ask Claude to extract a needed-by datetime from the requester's
 * free-text note ("needed by 7/15 @ 1pm"). SUGGESTION ONLY — the manager
 * applies it explicitly; nothing is written here. Returns null when no
 * parseable deadline, no AI key, or on any error (fail quiet).
 */
export async function suggestNeededByAction(
  orderId: string,
): Promise<ActionResult<{ iso: string | null }>> {
  const idParse = z.string().uuid().safeParse(orderId);
  if (!idParse.success) return err('validation_error', 'Invalid order id');
  try {
    const ctx = await withContext();
    const { assertPermission } = await import('@/server/services/context');
    assertPermission(ctx, 'orders:approve');
    const { resolveAiProvider } = await import('@/lib/ai/provider');
    if (resolveAiProvider() !== 'claude') return ok({ iso: null });
    const { data: row } = await ctx.supabase
      .from('order_requests')
      .select('notes, needed_by, created_at')
      .eq('id', idParse.data)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle();
    const note = (row?.notes as string | null)?.trim();
    if (!row || row.needed_by || !note) return ok({ iso: null });
    const { claudeGenerateJson } = await import('@/lib/ai/claude');
    const out = await claudeGenerateJson<{ iso: string | null }>({
      system:
        'You extract an explicit "needed by" deadline from a warehouse order note. Return iso as a full ISO-8601 datetime with -07:00 offset (America/Los_Angeles). If the note names a date without a time, use 09:00. If there is NO explicit deadline in the note, return iso: null. NEVER guess or invent a date.',
      prompt: `Order submitted at: ${row.created_at}\nRequester note:\n${note.slice(0, 1500)}`,
      schema: {
        type: 'object',
        properties: { iso: { type: 'string' } },
        required: [],
      },
      maxTokens: 200,
      temperature: 0,
    });
    const iso = typeof out?.iso === 'string' ? out.iso : null;
    // Trust nothing: must parse, must be within 1h..1y from now.
    if (!iso) return ok({ iso: null });
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t) || t < Date.now() || t > Date.now() + 365 * 24 * 3600 * 1000) {
      return ok({ iso: null });
    }
    return ok({ iso: new Date(t).toISOString() });
  } catch {
    return ok({ iso: null });
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
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    // Cancel restocks already-picked stock — the cached list view must drop.
    await revalidateInventoryListForCurrentOrg();
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const addLinesSchema = z.object({
  id: z.string().uuid(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantity: z.coerce.number().int().positive().max(100_000),
      }),
    )
    .min(1)
    .max(200),
});

/**
 * Add items to an EXISTING order (last-minute additions). Permitted any time
 * before the order ships, for the requester or an approver — the service
 * enforces both. See OrderRequestsService.addLines.
 */
export async function addOrderRequestLinesAction(
  input: z.input<typeof addLinesSchema>,
): Promise<ActionResult<{ added: number; merged: number; pickSlipStale: boolean }>> {
  const parsed = addLinesSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    const result = await svc.addLines(parsed.data.id, parsed.data.lines);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

const updateLineSchema = z.object({
  id: z.string().uuid(),
  lineId: z.string().uuid(),
  quantity: z.coerce.number().int().positive().max(100_000),
});

/**
 * Correct the quantity on a line already on the order. Same window and same
 * people as adding — the service refuses to drop below what has been handed
 * over or staged. See OrderRequestsService.updateLineQuantity.
 */
export async function updateOrderRequestLineQuantityAction(
  input: z.input<typeof updateLineSchema>,
): Promise<ActionResult<{ pickSlipStale: boolean; quantity: number }>> {
  const parsed = updateLineSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    const result = await svc.updateLineQuantity(
      parsed.data.id,
      parsed.data.lineId,
      parsed.data.quantity,
    );
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

const removeLineSchema = z.object({
  id: z.string().uuid(),
  lineId: z.string().uuid(),
});

/**
 * Take a wrongly-added item back off the order. Refused once the line has any
 * physical history (handed over, staged, returned) or while stock is still
 * reserved for it. See OrderRequestsService.removeLine.
 */
export async function removeOrderRequestLineAction(
  input: z.input<typeof removeLineSchema>,
): Promise<ActionResult<{ pickSlipStale: boolean; removedItemId: string }>> {
  const parsed = removeLineSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    const result = await svc.removeLine(parsed.data.id, parsed.data.lineId);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(result);
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
    revalidateOrdersCatalog();
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
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const generatePickSlipSchema = z.object({ id: z.string().uuid() });

export async function generatePickSlipAction(
  input: z.input<typeof generatePickSlipSchema>,
): Promise<ActionResult<void>> {
  const parsed = generatePickSlipSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.generatePickSlip(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const recordPickedLineSchema = z.object({
  orderId: z.string().uuid(),
  lineId: z.string().uuid(),
  quantity: z.coerce.number().min(0).max(10_000),
});

export async function recordPickedLineAction(
  input: z.input<typeof recordPickedLineSchema>,
): Promise<ActionResult<void>> {
  const parsed = recordPickedLineSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.recordPickedLine(parsed.data.orderId, parsed.data.lineId, parsed.data.quantity);
    revalidatePath(`/dashboard/orders/${parsed.data.orderId}`);
    revalidatePath(`/dashboard/orders/${parsed.data.orderId}/pick`);
    await revalidateInventoryListForCurrentOrg();
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const completePickingSchema = z.object({ id: z.string().uuid() });

export async function completePickingAction(
  input: z.input<typeof completePickingSchema>,
): Promise<ActionResult<void>> {
  const parsed = completePickingSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.completePicking(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    revalidatePath(`/dashboard/orders/${parsed.data.id}/pick`);
    await revalidateInventoryListForCurrentOrg();
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const backorderExitSchema = z.object({ id: z.string().uuid() });

const physicalSignatureSchema = z.object({
  id: z.string().uuid(),
  signerName: z.string().trim().min(1).max(120),
});

/**
 * Record a paper signature at hand-over (manager+ or the assigned driver —
 * the RPC enforces it). Runs the same completed/backordered fork as the
 * digital sign page.
 */
export async function confirmPhysicalSignatureAction(
  input: z.input<typeof physicalSignatureSchema>,
): Promise<ActionResult<void>> {
  const parsed = physicalSignatureSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Signer name is required');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.confirmPhysicalSignature(parsed.data.id, parsed.data.signerName);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function approveOrderPartialAction(
  input: z.input<typeof backorderExitSchema>,
): Promise<ActionResult<void>> {
  const parsed = backorderExitSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.approvePartial(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    await revalidateInventoryListForCurrentOrg();
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function resumeFulfillmentAction(
  input: z.input<typeof backorderExitSchema>,
): Promise<ActionResult<void>> {
  const parsed = backorderExitSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.resumeFulfillment(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const reopenPickingSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().min(1, 'A reason is required.').max(500),
});

/**
 * Manager override: send a picked/packed (pre-signature) order back to
 * picking_in_progress to fix a miscount. Reason is mandatory — the service
 * re-validates it, but the schema's `.min(1)` (after trimming) is the first
 * line of defence against a blank submit. See
 * OrderRequestsService.reopenPicking for the stock/audit/error-mapping
 * details.
 */
export async function reopenPickingAction(
  input: z.input<typeof reopenPickingSchema>,
): Promise<ActionResult<void>> {
  const parsed = reopenPickingSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.reopenPicking(parsed.data.id, parsed.data.reason);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    revalidatePath(`/dashboard/orders/${parsed.data.id}/pick`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function closePartialAction(
  input: z.input<typeof backorderExitSchema>,
): Promise<ActionResult<void>> {
  const parsed = backorderExitSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.closePartial(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
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

export async function rotatePublicRequestTokenAction(): Promise<ActionResult<{ token: string }>> {
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
    await svc.setWarehousePublicOrderable(parsed.data.warehouseId, parsed.data.isPublicOrderable);
    revalidatePath('/dashboard/settings/public-requests');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const generatePackingSlipsSchema = z.object({ id: z.string().uuid() });

export async function generatePackingSlipsAction(
  input: z.input<typeof generatePackingSlipsSchema>,
): Promise<ActionResult<void>> {
  const parsed = generatePackingSlipsSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.generatePackingSlips(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const stageOrderSchema = z.object({
  id: z.string().uuid(),
  target: z.enum(['staged_for_pickup', 'staged_for_delivery']),
});

export async function stageOrderAction(
  input: z.input<typeof stageOrderSchema>,
): Promise<ActionResult<void>> {
  const parsed = stageOrderSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.stageOrder(parsed.data.id, parsed.data.target);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const assignDeliverySchema = z.object({
  id: z.string().uuid(),
  deliveryUserId: z.string().uuid(),
});

export async function assignDeliveryAction(
  input: z.input<typeof assignDeliverySchema>,
): Promise<ActionResult<void>> {
  const parsed = assignDeliverySchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.assignDelivery(parsed.data.id, parsed.data.deliveryUserId);
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

// ── Picking claim / assign / release ────────────────────────────────────────
const claimPickingSchema = z.object({ id: z.string().uuid() });

export async function claimPickingAction(
  input: z.input<typeof claimPickingSchema>,
): Promise<ActionResult<void>> {
  const parsed = claimPickingSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.claimPicking(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    revalidatePath(`/dashboard/orders/${parsed.data.id}/pick`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const assignPickingSchema = z.object({ id: z.string().uuid(), pickerUserId: z.string().uuid() });

export async function assignPickingAction(
  input: z.input<typeof assignPickingSchema>,
): Promise<ActionResult<void>> {
  const parsed = assignPickingSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.assignPicking(parsed.data.id, parsed.data.pickerUserId);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    revalidatePath(`/dashboard/orders/${parsed.data.id}/pick`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const releasePickingSchema = z.object({ id: z.string().uuid() });

export async function releasePickingAction(
  input: z.input<typeof releasePickingSchema>,
): Promise<ActionResult<void>> {
  const parsed = releasePickingSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.releasePicking(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    revalidatePath(`/dashboard/orders/${parsed.data.id}/pick`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const markInTransitSchema = z.object({ id: z.string().uuid() });

export async function markInTransitAction(
  input: z.input<typeof markInTransitSchema>,
): Promise<ActionResult<void>> {
  const parsed = markInTransitSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.markInTransit(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
