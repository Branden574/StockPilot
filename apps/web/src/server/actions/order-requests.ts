'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { z } from 'zod';

import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError, withContext } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

import {
  err,
  formatWallClock,
  HOLD_FAILED_COPY,
  mintOrderSubmissionKey,
  NEEDED_BY_FAILED_COPY,
  NEEDED_BY_SUGGESTION_REASON,
  ok,
  ORDER_BODY_UNREADABLE_COPY,
  ORDER_FAULT_COPY,
  parseWallClock,
  wallClockToInstant,
  type ActionResult,
  type HoldOrderStockResult,
  type HoldOutcome,
  type NeededByRevisionOutcome,
  type OrderCreateRequestInput,
  type OrderPlaceAnswer,
  type OrderSubmissionStatus,
  type OrderSummary,
} from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  // The order service refuses a change outside the caller's warehouses with
  // assertWarehouseAccess's ForbiddenError (every route answers it 403), not a
  // ServiceError. It is a refusal with a sentence for people, never a fault:
  // as 'internal_error' the Approve partial and Resume dialog said "Try again"
  // (small fixes slice 2 review). The cycle-count and attachment actions
  // already answer it this way.
  if (error instanceof ForbiddenError) return err('forbidden', error.message);
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
 * nuking the tag org-wide is cheap). Placing an order reserves nothing, so
 * createOrderRequestAction does NOT call this (phone ordering PO-2: it used
 * to empty every warm catalog on every order).
 */
function revalidateOrdersCatalog() {
  revalidateTag('orders-new-v2-catalog', 'max');
}

/**
 * The body a New order tab opened BEFORE the PO-2 deploy still sends (no
 * submission key; needed-by as an instant). Read for ONE release by the
 * legacy branch below, then removed (phone ordering plan, follow-up 9). Such
 * a tab has no retry protection, the same as before the deploy.
 *
 * When it can arrive (review round 1, checked in next 16.3.5): a server
 * action's id is a hash salted with the build's encryption key, which `next
 * build` keeps in `.next/cache/.rscinfo` for 14 days and reuses while the
 * build cache is restored (NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is not set).
 * Under Vercel Skew Protection (on, 12 hours) a tab from the previous
 * deployment is pinned to THAT deployment, so for up to 12 hours an old tab
 * runs the OLD action, which calls create_order_request directly and writes
 * no order_submissions row. After that, an old tab reaches this branch only
 * while the build key is unchanged; otherwise it gets "Failed to find Server
 * Action" (it was never protected, and nothing is placed).
 */
const legacyCreateSchema = z.object({
  warehouseId: z.string().uuid(),
  notes: z.string().max(2000).nullable().optional(),
  neededBy: z.string().datetime({ offset: true }).nullish(),
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
        quantity: z.coerce.number(),
        notes: z.string().max(500).nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
  kits: z
    .array(z.object({ bundleId: z.string().uuid(), count: z.number().int().positive().max(10_000) }))
    .max(100)
    .optional(),
});

/** An action error from the order submission service: the service's code,
 *  core's sentence and its details (reason, settled, replay, items...), so
 *  the storefront classifies it exactly as the phone classifies the route's
 *  answer. A fault is core's "couldn't be confirmed" sentence (reported). */
function orderSubmissionActionError(
  e: unknown,
  tag: string,
  organizationId: string | null,
): ActionResult<never> {
  // The organization that answered, on every refusal it made (none before the
  // session was read), so a tab left in another workspace drops it (core
  // orderCallResultForOrganization; review round 1).
  const answeredBy = organizationId ? { organizationId } : {};
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    return err(e.code, e.message, { ...(e.details ?? {}), ...answeredBy });
  }
  void reportError(e instanceof ServiceError && e.internalDetail ? new Error(e.internalDetail) : e, { tag });
  return err('internal_error', ORDER_FAULT_COPY, { reason: 'failed', ...answeredBy });
}

/** The organization a New order page was opened in (core's create body does
 *  not carry it: the phone names it in X-Organization-Id). */
const pageOrganizationSchema = z.object({ organizationId: z.string().trim().min(1).max(100) });

/**
 * Place an order request from the New order page (phone ordering PO-2). The
 * body is core's create body (orderCreateRequestSchema: the submission key
 * minted on the first press and kept, the placer, the wall-clock needed-by),
 * read and refused in the service with core's words; it goes to the database
 * through the same service method as the phone's POST /api/v1/orders.
 *
 * Answers `{ organizationId, result: { replay, order } }`, the body POST
 * /api/v1/orders answers (core parseOrderPlaceAnswer reads both), with
 * `replay: true` when the key had already placed the order. A refusal carries the service's details, `settled: true` when it is
 * recorded under the key. revalidatePath('/dashboard/orders') stays; the
 * storefront catalog is NOT revalidated (placing reserves nothing).
 *
 * `page` names the organization the page was opened in. The account's
 * organization is its default one, which a workspace switch in another tab
 * changes for every open tab, so a send from a tab left in another
 * organization is refused organization_changed before any key work (never
 * recorded, never settled), and every refusal names the organization that
 * answered (review round 1).
 *
 * LEGACY BRANCH (one release): a body without a key comes from a tab opened
 * before the deploy (see legacyCreateSchema for when one can arrive). It gets
 * a server-minted key and the session as placer, and its needed-by instant
 * passes through unconverted. No pending record exists for it, so it has no
 * retry protection, as before; it names no organization.
 */
export async function createOrderRequestAction(
  input: OrderCreateRequestInput | z.input<typeof legacyCreateSchema>,
  page?: z.input<typeof pageOrganizationSchema>,
): Promise<ActionResult<{ organizationId: string; result: { replay: boolean; order: OrderSummary } }>> {
  let organizationId: string | null = null;
  try {
    const keyed = !!input && typeof input === 'object' && 'idempotencyKey' in input;
    const scope = keyed ? pageOrganizationSchema.safeParse(page) : null;
    if (scope && !scope.success) {
      return err('validation_error', ORDER_BODY_UNREADABLE_COPY, { reason: 'invalid', field: 'organizationId' });
    }
    const svc = await OrderRequestsService.forCurrentUser();
    organizationId = svc.organizationId;
    let answer: OrderPlaceAnswer;
    if (keyed && scope?.success) {
      answer = await svc.create({
        body: input,
        surface: 'web',
        expectedOrganizationId: scope.data.organizationId,
      });
    } else {
      const legacy = legacyCreateSchema.safeParse(input);
      if (!legacy.success) {
        return err('validation_error', ORDER_BODY_UNREADABLE_COPY, { reason: 'invalid', field: 'body' });
      }
      const ctx = await withContext();
      const l = legacy.data;
      answer = await svc.create({
        body: {
          idempotencyKey: mintOrderSubmissionKey(),
          placerUserId: ctx.userId,
          warehouseId: l.warehouseId,
          fulfillmentType: l.fulfillmentType,
          deliveryCharterId: l.fulfillmentType === 'delivery' ? (l.deliveryCharterId ?? null) : null,
          onBehalfOf: l.onBehalfOf ?? null,
          notes: l.notes ?? null,
          neededByLocal: null,
          lines: l.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
          ...(l.kits && l.kits.length > 0 ? { kits: l.kits } : {}),
        },
        surface: 'web',
        legacyNeededBy: l.neededBy ?? null,
      });
    }
    revalidatePath('/dashboard/orders');
    return ok({ organizationId: answer.organizationId, result: { replay: answer.replay, order: answer.order } });
  } catch (e) {
    return orderSubmissionActionError(e, 'actions.orders.create', organizationId);
  }
}

/** A settle call names the key, the organization the page was opened in and
 *  the account that sent the key (the pending record's placer): a tab left in
 *  another workspace or under another account is refused before the function
 *  runs, never settled (review round 1). */
const submissionKeySchema = z.object({
  warehouseId: z.string().uuid(),
  key: z.string().uuid(),
  organizationId: z.string().trim().min(1).max(100),
  placerUserId: z.string().uuid(),
});

/** A settle call's input that does not read: the first field it names. */
function submissionKeyRefusal(error: z.ZodError): ActionResult<never> {
  const first = error.issues[0]?.path[0];
  const field = first === 'organizationId' || first === 'placerUserId' || first === 'warehouseId' ? first : 'idempotencyKey';
  return err('validation_error', ORDER_BODY_UNREADABLE_COPY, { reason: 'invalid', field });
}

/**
 * What happened to the caller's own submission key (the New order page's
 * automatic check after a reload, and "Check" on the unconfirmed panel's
 * status line). A read: `none` never unlocks the cart. Membership only.
 */
export async function getOrderSubmissionAction(
  input: z.input<typeof submissionKeySchema>,
): Promise<ActionResult<OrderSubmissionStatus>> {
  const parsed = submissionKeySchema.safeParse(input);
  if (!parsed.success) return submissionKeyRefusal(parsed.error);
  let organizationId: string | null = null;
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    organizationId = svc.organizationId;
    const { key, organizationId: pageOrganizationId, placerUserId } = parsed.data;
    return ok(await svc.submissionStatus(key, { organizationId: pageOrganizationId, placerUserId }));
  } catch (e) {
    return orderSubmissionActionError(e, 'actions.orders.submission_status', organizationId);
  }
}

/**
 * "Don't send it": settle the caller's own submission key for good. Its
 * answer is final: withdrawn, or the order it had already placed, or the
 * refusal recorded for it. Membership only.
 */
export async function withdrawOrderSubmissionAction(
  input: z.input<typeof submissionKeySchema>,
): Promise<ActionResult<OrderSubmissionStatus>> {
  const parsed = submissionKeySchema.safeParse(input);
  if (!parsed.success) return submissionKeyRefusal(parsed.error);
  let organizationId: string | null = null;
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    organizationId = svc.organizationId;
    const { key, organizationId: pageOrganizationId, placerUserId } = parsed.data;
    return ok(
      await svc.withdrawSubmission(key, 'web', { organizationId: pageOrganizationId, placerUserId }),
    );
  } catch (e) {
    return orderSubmissionActionError(e, 'actions.orders.submission_withdraw', organizationId);
  }
}

// A timestamp as PostgREST prints it (offset, any fractional precision): the
// needed-by a screen started from, passed to the function exactly as read.
const expectedNeededBySchema = z.string().datetime({ offset: true }).nullable();

/**
 * A needed-by revision's refusal as an ActionResult: the service's code,
 * core's sentence and its `details` (reason, and for needed_by_changed the
 * current value), so the dialog can load the current date and say so. A fault
 * is core's "couldn't be changed" sentence (the service reported its cause).
 */
function neededByActionError(e: unknown): ActionResult<never> {
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    return err(e.code, e.message, e.details);
  }
  if (!(e instanceof ServiceError)) void reportError(e, { tag: 'actions.orders.needed_by' });
  return err('internal_error', NEEDED_BY_FAILED_COPY, { reason: 'failed' });
}

function revalidateAfterNeededBy(id: string, outcome: NeededByRevisionOutcome) {
  if (!outcome.changed) return;
  revalidatePath('/dashboard/orders');
  revalidatePath(`/dashboard/orders/${id}`);
  // The order's Schedule entry moved or was created with it.
  if (outcome.schedule === 'moved' || outcome.schedule === 'created') {
    revalidatePath('/dashboard/schedule');
  }
}

const reviseNeededBySchema = z.object({
  id: z.string().uuid(),
  // "YYYY-MM-DDTHH:mm" in the ORG's zone (the dialog's datetime-local). The
  // service reads it strictly, in the org zone, and words any refusal.
  neededByLocal: z.string().trim().min(1).max(40),
  expectedNeededBy: expectedNeededBySchema,
  // Checked by the service (1 to 500 characters after trimming, core's words);
  // this bound only stops an absurd payload.
  reason: z.string().max(5000),
});

/**
 * Approver: change an open order's needed-by date, with a reason (F2-4). The
 * order's Schedule entry moves with it and its reminders are armed again; no
 * email is sent. A stale edit (someone saved another date first) is refused
 * as `conflict` with `details: { reason: 'needed_by_changed', current }`.
 */
export async function reviseOrderNeededByAction(
  input: z.input<typeof reviseNeededBySchema>,
): Promise<ActionResult<NeededByRevisionOutcome>> {
  const parsed = reviseNeededBySchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input', { reason: 'failed' });
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    const outcome = await svc.reviseNeededBy({
      id: parsed.data.id,
      neededByLocal: parsed.data.neededByLocal,
      expectedNeededBy: parsed.data.expectedNeededBy,
      reason: parsed.data.reason,
    });
    revalidateAfterNeededBy(parsed.data.id, outcome);
    return ok(outcome);
  } catch (e) {
    return neededByActionError(e);
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
  // The needed-by the manager saw. The suggestion is offered only on an order
  // with none, so an older tab that does not send it means null: a date
  // someone set in the meantime is never overwritten by the AI's reading.
  expectedNeededBy: expectedNeededBySchema.optional(),
});

/**
 * Manager: apply the AI suggestion's needed-by to a PENDING order (the
 * requester's note, read by suggestNeededByAction). Through the same service
 * as every revision (F2-4): the same gates, the stale-version check, an audit
 * entry with the reason "Set from the requester's note". Still pending-only,
 * as it has always been; a later change is the order page's Change.
 */
export async function setOrderNeededByAction(
  input: z.input<typeof setNeededBySchema>,
): Promise<ActionResult<void>> {
  const parsed = setNeededBySchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    const outcome = await svc.reviseNeededBy({
      id: parsed.data.id,
      neededByAt: parsed.data.neededBy,
      expectedNeededBy: parsed.data.expectedNeededBy ?? null,
      reason: NEEDED_BY_SUGGESTION_REASON,
      onlyWhenPending: true,
    });
    revalidateAfterNeededBy(parsed.data.id, outcome);
    return ok(undefined);
  } catch (e) {
    return neededByActionError(e);
  }
}

/**
 * The AI needed-by suggestion's wall clock, read in the ORG's zone.
 *
 * WHY (2026-09, SP-047). `suggestNeededByAction` used to tell the model to
 * emit "a full ISO-8601 datetime with -07:00 offset (America/Los_Angeles)".
 * That is wrong twice over: -07:00 is Pacific DAYLIGHT time, so any winter
 * deadline came back an hour early (a January "1pm" landed at 12:00 PST), and
 * every org that is not in California got Pacific wall-clock times outright
 * (3-4 hours off for America/New_York). The applied value becomes the order's
 * needed-by, and the schedule event and reminders follow it, so the drift
 * reached the ping the requester actually receives.
 *
 * The model now returns a ZONE-LESS wall clock ("2027-01-15T13:00") and the
 * server converts it in the ORG's timezone (resolveOrgTimezone, the one
 * expression of that decision; never re-defaulted here). The zone arithmetic
 * (zonedParts, zoneOffsetMs, wallClockToInstant, formatWallClock) moved to
 * core in F2-4 (packages/core/src/time/zoned-wall-clock.ts), where the
 * needed-by revision uses the same copy; SP-047's cases moved with it.
 */

// Anything the model returns carrying its own zone (…Z or …±HH:MM) is already
// an absolute instant — accept it as-is rather than re-interpreting it.
const HAS_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Resolve the model's answer to an absolute epoch-ms, interpreting a zone-less
 * value in `zone`. Returns null when it is not a datetime we recognise. A
 * date-only answer means 09:00 local (what the prompt asks for). SP-047's
 * lenient conversion is kept (strict: false): the suggestion is only shown,
 * and the manager applies it explicitly.
 */
function resolveSuggestedInstant(raw: string, zone: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  if (HAS_OFFSET_RE.test(value)) {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const wall = parseWallClock(value, { dateOnlyHour: 9 });
  if (!wall) return null;
  return wallClockToInstant(wall, zone, { strict: false });
}

/**
 * Manager: ask Claude to extract a needed-by datetime from the requester's
 * free-text note ("needed by 7/15 @ 1pm"). SUGGESTION ONLY — the manager
 * applies it explicitly; nothing is written here. Returns null when no
 * parseable deadline, no AI key, or on any error (fail quiet).
 *
 * The extracted time is a WALL CLOCK in the ORG's timezone — see
 * `resolveSuggestedInstant` above for the incident this closes.
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
    // The org's operational zone, through the ONE resolver (getCachedOrgTimezone
    // already wraps resolveOrgTimezone) so a missing/invalid stored value
    // degrades exactly the way every other surface degrades.
    const { getCachedOrgTimezone } = await import('@/lib/dashboard/cached-org');
    const zone = await getCachedOrgTimezone(ctx.organizationId);
    const now = Date.now();
    const submittedMs = new Date(row.created_at as string).getTime();
    const { claudeGenerateJson } = await import('@/lib/ai/claude');
    const out = await claudeGenerateJson<{ iso: string | null }>({
      system:
        'You extract an explicit "needed by" deadline from a warehouse order note. Return iso as a LOCAL wall-clock datetime formatted exactly YYYY-MM-DDTHH:mm, with NO timezone offset and NO trailing Z — the server interprets it in the warehouse timezone given in the prompt. If the note names a date without a time, use 09:00. Resolve relative wording ("tomorrow", "next Friday") against the current local date and time given in the prompt. If there is NO explicit deadline in the note, return iso: null. NEVER guess or invent a date.',
      prompt: [
        `Warehouse timezone: ${zone}`,
        `Current local date and time: ${formatWallClock(now, zone)}`,
        `Order submitted (local): ${
          Number.isFinite(submittedMs) ? formatWallClock(submittedMs, zone) : 'unknown'
        }`,
        `Requester note:\n${note.slice(0, 1500)}`,
      ].join('\n'),
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
    const t = resolveSuggestedInstant(iso, zone);
    if (
      t === null ||
      !Number.isFinite(t) ||
      t < Date.now() ||
      t > Date.now() + 365 * 24 * 3600 * 1000
    ) {
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
 * enforces both. See OrderRequestsService.addLines. `hold` is the automatic
 * top-up's outcome (F2-2): null when none was attempted (not an approver, or
 * not a hold status), else what was held or why nothing was.
 */
export async function addOrderRequestLinesAction(
  input: z.input<typeof addLinesSchema>,
): Promise<
  ActionResult<{ added: number; merged: number; pickSlipStale: boolean; hold: HoldOutcome | null }>
> {
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
 * over or staged. See OrderRequestsService.updateLineQuantity. A raise carries
 * `hold` as addOrderRequestLinesAction does; a lowering carries null.
 */
export async function updateOrderRequestLineQuantityAction(
  input: z.input<typeof updateLineSchema>,
): Promise<ActionResult<{ pickSlipStale: boolean; quantity: number; hold: HoldOutcome | null }>> {
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

const holdStockSchema = z.object({ id: z.string().uuid() });

/**
 * "Hold available stock" on the order page's readiness strip (F2-2): tops the
 * order's holds up to what its lines still owe, as far as free stock allows
 * (OrderRequestsService.holdStock, hold_order_stock 0378). For lines added
 * before holds were topped up, or by someone who may not approve orders. Holds
 * change what the storefront shows as available, so its catalog is refreshed.
 * Every refusal comes back in the service's words (core HOLD_* copy).
 */
export async function holdOrderStockAction(
  input: z.input<typeof holdStockSchema>,
): Promise<ActionResult<HoldOrderStockResult>> {
  const parsed = holdStockSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    const result = await svc.holdStock(parsed.data.id, 'manual');
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(result);
  } catch (e) {
    // A fault is core's "couldn't be held" sentence, as on the phone (the
    // service has reported it with its cause); a refusal comes in its own
    // words.
    if (e instanceof ServiceError && e.code === 'internal_error') return err('internal_error', HOLD_FAILED_COPY);
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
 * digital sign page, and answers the status it left, so the panel says
 * whether the order completed or the rest stays on backorder.
 */
export async function confirmPhysicalSignatureAction(
  input: z.input<typeof physicalSignatureSchema>,
): Promise<ActionResult<{ status: string | null }>> {
  const parsed = physicalSignatureSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Signer name is required');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    const row = await svc.confirmPhysicalSignature(parsed.data.id, parsed.data.signerName);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok({ status: row?.status ?? null });
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
