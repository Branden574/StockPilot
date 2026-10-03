/**
 * Placing an order request: the rules both surfaces share (phone ordering
 * plan, sections 3.3 to 3.6). Pure TypeScript, no React, no network. Safe
 * under Hermes.
 *
 * What is here:
 *   - the caps and the create body's schema (`orderCreateRequestSchema`,
 *     strict), read through `parseOrderCreateRequest`, which names the reason
 *     and puts core's words on every refusal;
 *   - `mintOrderSubmissionKey`, one key per submission;
 *   - the answers' parsers (`parseOrderPlaceAnswer`,
 *     `parseOrderSubmissionStatus`), which throw on a shape they do not know
 *     and tolerate extra keys;
 *   - the idempotency contract: `classifyOrderSubmitResult` (what one send's
 *     answer means), `classifyOrderSettleResult` (a status read or a
 *     withdraw), the `orderSubmission` state machine, the pending record kept
 *     on the device, and `refuseAddWhileLocked`;
 *   - the words for every reason.
 *
 * ═══ SETTLE, NEVER GUESS ═══
 *
 * A send whose answer did not arrive may or may not have placed the order.
 * The cart stays locked, with the same key and the same body, until the key
 * has a FINAL outcome: placed, refused (recorded under the key, or refused on
 * the only send of the key) or withdrawn. A status read that answers `none`
 * only says nothing has committed yet, so it never unlocks. A refusal to a
 * RESEND (raised before the server looked at the key: a signed-out session, a
 * missing permission, a shape refusal) says nothing about the earlier send, so
 * it never unlocks either; "Don't send it" withdraws under the key's lock, and
 * its answer is final.
 *
 * Nothing here decides from message text. Every decision reads the HTTP
 * status, the error code and `details` (pattern #28: the Add items defect
 * came from parsing text).
 */

import { z } from 'zod';

import { NEEDED_BY_IN_PAST_COPY, NEEDED_BY_OUT_OF_RANGE_COPY } from './needed-by-revision';
import { formatOrderNumber } from './order-number';

// ── Caps ────────────────────────────────────────────────────────────────────

/** Lines on one order request. */
export const ORDER_MAX_LINES = 100;
/** Units on one line (after lines of the same item are summed). */
export const ORDER_MAX_UNITS_PER_LINE = 10_000;
/** Units across the whole order request. */
export const ORDER_MAX_UNITS = 10_000;
/** "Manager notes", in characters after trimming. */
export const ORDER_NOTES_MAX = 2000;
/** The on-behalf name, in characters after trimming. */
export const ORDER_ON_BEHALF_NAME_MAX = 120;
/** The on-behalf email, in characters after trimming. */
export const ORDER_EMAIL_MAX = 254;
/** Kits named for the audit note (the web action's cap). */
export const ORDER_MAX_KITS = 100;

/** "10000" -> "10,000", without Intl (the phone's runtime). */
function withCommas(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One @, something on each side, a dot in the domain, no whitespace. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The organization's wall clock, as a datetime-local input gives it. */
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function uuidShaped(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Characters as Postgres counts them (code points, not UTF-16 units), so a
 *  cap means the same thing here and in the database. */
function charCount(s: string): number {
  return Array.from(s).length;
}

/** Whether "YYYY-MM-DDTHH:mm" names a real calendar date and time. Zone-free:
 *  the server converts it in the organization's zone and refuses a time that
 *  does not exist there (the spring-forward hour). */
export function isOrderWallClock(v: string): boolean {
  const m = WALL_CLOCK_RE.exec(v);
  if (!m) return false;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

// ── Keys ────────────────────────────────────────────────────────────────────

/**
 * A random version 4 UUID: `crypto.randomUUID` where the runtime has it, then
 * `crypto.getRandomValues`, then Math.random. A key is a replay identity, not
 * a secret, so the last is enough; it exists because the phone's runtime has
 * not always had the first two. (The phone has this fallback twice today, in
 * order-shortfall-po.ts and exceptions-api.ts; PO-4 points both here.)
 */
export function randomRequestUuid(): string {
  const c = (
    globalThis as {
      crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID().toLowerCase();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One key per submission, minted on the first press of Submit and kept, with
 *  the frozen body, until the key is settled. */
export function mintOrderSubmissionKey(): string {
  return randomRequestUuid();
}

// ── The create body ─────────────────────────────────────────────────────────

/** Why a create body was refused before anything was sent to the database. */
export type OrderCreateShapeReason =
  | 'invalid'
  | 'too_many_lines'
  | 'too_many_units'
  | 'quantity_not_whole'
  | 'notes_too_long'
  | 'on_behalf_invalid'
  | 'delivery_needs_site'
  | 'needed_by_invalid_time';

export interface OrderCreateRefusal {
  reason: OrderCreateShapeReason;
  /** For `invalid`: the body field at fault: `lines` (none), `quantity`,
   *  `itemId`, `line`, `deliveryCharterId` (a site on a pickup),
   *  `idempotencyKey`, `placerUserId`, `body`, or the name of an unknown key. */
  field?: string;
  /** Core's sentence for it. */
  message: string;
}

export const ORDER_LINES_EMPTY_COPY = 'Add at least one item.';
export const ORDER_TOO_MANY_LINES_COPY = `An order request can have at most ${ORDER_MAX_LINES} lines.`;
export const ORDER_TOO_MANY_UNITS_COPY = `An order request can have at most ${withCommas(ORDER_MAX_UNITS)} units.`;
export const ORDER_QUANTITY_NOT_WHOLE_COPY = 'Quantities must be whole numbers.';
export const ORDER_QUANTITY_INVALID_COPY = 'Each quantity must be at least 1.';
export const ORDER_NOTES_TOO_LONG_COPY = `Manager notes can be at most ${withCommas(ORDER_NOTES_MAX)} characters.`;
export const ORDER_ON_BEHALF_INVALID_COPY = `Enter their name (up to ${ORDER_ON_BEHALF_NAME_MAX} characters) and a valid email address.`;
export const ORDER_DELIVERY_NEEDS_SITE_COPY = 'Choose a delivery site.';
export const ORDER_PICKUP_HAS_SITE_COPY = "A pickup order doesn't take a delivery site.";
export const ORDER_NEEDED_BY_INVALID_TIME_COPY =
  "That needed-by date and time doesn't exist. Pick another time.";
/** A body the client built wrong (a missing or malformed key, id or field):
 *  nothing a person can fix by editing the order. */
export const ORDER_BODY_UNREADABLE_COPY =
  "This order request couldn't be read, so it wasn't sent. Reload and start the order again.";

/** Core's sentence for a shape refusal. */
export function orderCreateRefusalCopy(reason: OrderCreateShapeReason, field?: string): string {
  switch (reason) {
    case 'too_many_lines':
      return ORDER_TOO_MANY_LINES_COPY;
    case 'too_many_units':
      return ORDER_TOO_MANY_UNITS_COPY;
    case 'quantity_not_whole':
      return ORDER_QUANTITY_NOT_WHOLE_COPY;
    case 'notes_too_long':
      return ORDER_NOTES_TOO_LONG_COPY;
    case 'on_behalf_invalid':
      return ORDER_ON_BEHALF_INVALID_COPY;
    case 'delivery_needs_site':
      return ORDER_DELIVERY_NEEDS_SITE_COPY;
    case 'needed_by_invalid_time':
      return ORDER_NEEDED_BY_INVALID_TIME_COPY;
    case 'invalid':
      if (field === 'lines') return ORDER_LINES_EMPTY_COPY;
      if (field === 'quantity') return ORDER_QUANTITY_INVALID_COPY;
      if (field === 'deliveryCharterId') return ORDER_PICKUP_HAS_SITE_COPY;
      return ORDER_BODY_UNREADABLE_COPY;
  }
}

type Params = { reason: OrderCreateShapeReason; field?: string };

const why = (reason: OrderCreateShapeReason, field?: string): Params =>
  field ? { reason, field } : { reason };

/** A uuid-shaped string. A refusal names the body field it sits under. */
const uuidField = () =>
  z
    .string({
      required_error: ORDER_BODY_UNREADABLE_COPY,
      invalid_type_error: ORDER_BODY_UNREADABLE_COPY,
    })
    .regex(UUID_RE, { message: ORDER_BODY_UNREADABLE_COPY });

const lineSchema = z
  .object(
    {
      itemId: z
        .string({
          required_error: ORDER_BODY_UNREADABLE_COPY,
          invalid_type_error: ORDER_BODY_UNREADABLE_COPY,
        })
        .regex(UUID_RE, { message: ORDER_BODY_UNREADABLE_COPY }),
      quantity: z
        .number({
          required_error: ORDER_QUANTITY_INVALID_COPY,
          invalid_type_error: ORDER_QUANTITY_INVALID_COPY,
        })
        .int({ message: ORDER_QUANTITY_NOT_WHOLE_COPY })
        .min(1, { message: ORDER_QUANTITY_INVALID_COPY })
        .max(ORDER_MAX_UNITS_PER_LINE, { message: ORDER_TOO_MANY_UNITS_COPY }),
    },
    { invalid_type_error: ORDER_BODY_UNREADABLE_COPY },
  )
  .strict(ORDER_BODY_UNREADABLE_COPY);

const kitSchema = z
  .object(
    {
      bundleId: uuidField(),
      count: z
        .number({
          required_error: ORDER_BODY_UNREADABLE_COPY,
          invalid_type_error: ORDER_BODY_UNREADABLE_COPY,
        })
        .int({ message: ORDER_BODY_UNREADABLE_COPY })
        .min(1, { message: ORDER_BODY_UNREADABLE_COPY })
        .max(ORDER_MAX_UNITS, { message: ORDER_BODY_UNREADABLE_COPY }),
    },
    { invalid_type_error: ORDER_BODY_UNREADABLE_COPY },
  )
  .strict(ORDER_BODY_UNREADABLE_COPY);

const onBehalfSchema = z
  .object(
    {
      name: z
        .string({
          required_error: ORDER_ON_BEHALF_INVALID_COPY,
          invalid_type_error: ORDER_ON_BEHALF_INVALID_COPY,
        })
        .refine((v) => {
          const n = charCount(v.trim());
          return n >= 1 && n <= ORDER_ON_BEHALF_NAME_MAX;
        }, ORDER_ON_BEHALF_INVALID_COPY),
      email: z
        .string({
          required_error: ORDER_ON_BEHALF_INVALID_COPY,
          invalid_type_error: ORDER_ON_BEHALF_INVALID_COPY,
        })
        .refine((v) => {
          const e = v.trim();
          return charCount(e) <= ORDER_EMAIL_MAX && EMAIL_RE.test(e);
        }, ORDER_ON_BEHALF_INVALID_COPY),
    },
    { invalid_type_error: ORDER_ON_BEHALF_INVALID_COPY },
  )
  .strict(ORDER_ON_BEHALF_INVALID_COPY)
  .transform((v) => ({ name: v.name.trim(), email: v.email.trim() }));

/**
 * The create body (plan 3.1), `.strict()`: an unknown key is refused, never
 * ignored. No clock in it: whether a needed-by is still to come is the
 * server's question, asked in the organization's zone. Every key but `kits`
 * is required, null where the plan allows null, so a frozen body says the
 * same thing on every send.
 *
 * Output: notes trimmed (empty is null), the on-behalf name and email
 * trimmed. Lines are as sent; the database sums lines of the same item (and
 * every cap here already holds for the sums).
 *
 * Read it through parseOrderCreateRequest, which names the reason; a direct
 * safeParse gets core's sentence on every issue but no reason.
 */
export const orderCreateRequestSchema = z
  .object(
    {
      idempotencyKey: uuidField(),
      placerUserId: uuidField(),
      warehouseId: uuidField(),
      fulfillmentType: z.enum(['pickup', 'delivery'], {
        errorMap: () => ({ message: ORDER_BODY_UNREADABLE_COPY }),
      }),
      deliveryCharterId: uuidField().nullable(),
      onBehalfOf: onBehalfSchema.nullable(),
      notes: z
        .string({
          required_error: ORDER_BODY_UNREADABLE_COPY,
          invalid_type_error: ORDER_BODY_UNREADABLE_COPY,
        })
        .nullable()
        .refine((v) => v === null || charCount(v.trim()) <= ORDER_NOTES_MAX, {
          message: ORDER_NOTES_TOO_LONG_COPY,
          params: why('notes_too_long'),
        })
        .transform((v) => (v === null ? null : v.trim() || null)),
      neededByLocal: z
        .string({
          required_error: ORDER_NEEDED_BY_INVALID_TIME_COPY,
          invalid_type_error: ORDER_NEEDED_BY_INVALID_TIME_COPY,
        })
        .nullable()
        .refine((v) => v === null || isOrderWallClock(v), ORDER_NEEDED_BY_INVALID_TIME_COPY),
      lines: z
        .array(lineSchema, {
          required_error: ORDER_LINES_EMPTY_COPY,
          invalid_type_error: ORDER_BODY_UNREADABLE_COPY,
        })
        .min(1, { message: ORDER_LINES_EMPTY_COPY })
        .max(ORDER_MAX_LINES, { message: ORDER_TOO_MANY_LINES_COPY }),
      kits: z
        .array(kitSchema, { invalid_type_error: ORDER_BODY_UNREADABLE_COPY })
        .max(ORDER_MAX_KITS, { message: ORDER_BODY_UNREADABLE_COPY })
        .optional(),
    },
    { invalid_type_error: ORDER_BODY_UNREADABLE_COPY, required_error: ORDER_BODY_UNREADABLE_COPY },
  )
  .strict(ORDER_BODY_UNREADABLE_COPY)
  .superRefine((v, ctx) => {
    if (v.fulfillmentType === 'delivery' && v.deliveryCharterId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deliveryCharterId'],
        message: ORDER_DELIVERY_NEEDS_SITE_COPY,
        params: why('delivery_needs_site'),
      });
    }
    if (v.fulfillmentType === 'pickup' && v.deliveryCharterId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deliveryCharterId'],
        message: ORDER_PICKUP_HAS_SITE_COPY,
        params: why('invalid', 'deliveryCharterId'),
      });
    }
    const total = v.lines.reduce((s, l) => s + l.quantity, 0);
    if (total > ORDER_MAX_UNITS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: ORDER_TOO_MANY_UNITS_COPY,
        params: why('too_many_units'),
      });
    }
  });

/** The body as the client sends it. */
export type OrderCreateRequestInput = z.input<typeof orderCreateRequestSchema>;
/** The body as read: trimmed notes (empty is null), trimmed on-behalf. */
export type OrderCreateRequest = z.output<typeof orderCreateRequestSchema>;

/** The reason for one zod issue: its own when it carries one, else by where
 *  it is and what kind it is. */
function refusalOf(issue: z.ZodIssue): { reason: OrderCreateShapeReason; field?: string } {
  if (issue.code === z.ZodIssueCode.custom) {
    const p = issue.params as Partial<Params> | undefined;
    if (p?.reason) return why(p.reason, p.field);
  }
  const [top, index, leaf] = issue.path;
  if (top === undefined) {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return { reason: 'invalid', field: issue.keys[0] ?? 'body' };
    }
    return { reason: 'invalid', field: 'body' };
  }
  switch (top) {
    case 'lines':
      if (index === undefined) {
        return issue.code === z.ZodIssueCode.too_big
          ? { reason: 'too_many_lines' }
          : { reason: 'invalid', field: 'lines' };
      }
      if (leaf === 'quantity') {
        if (issue.code === z.ZodIssueCode.invalid_type && issue.expected === 'integer')
          return { reason: 'quantity_not_whole' };
        if (issue.code === z.ZodIssueCode.too_big) return { reason: 'too_many_units' };
        return { reason: 'invalid', field: 'quantity' };
      }
      if (leaf === 'itemId') return { reason: 'invalid', field: 'itemId' };
      if (issue.code === z.ZodIssueCode.unrecognized_keys)
        return { reason: 'invalid', field: issue.keys[0] ?? 'line' };
      return { reason: 'invalid', field: 'line' };
    case 'onBehalfOf':
      return { reason: 'on_behalf_invalid' };
    case 'notes':
      return { reason: 'invalid', field: 'notes' };
    case 'neededByLocal':
      return { reason: 'needed_by_invalid_time' };
    default:
      return { reason: 'invalid', field: String(top) };
  }
}

export type OrderCreateParse =
  { ok: true; value: OrderCreateRequest } | { ok: false; refusal: OrderCreateRefusal };

/**
 * Read a create body. The first problem found decides the refusal, so a body
 * with one fault always gets the same reason; the order is the body's own
 * (key, placer, warehouse, method, site, on-behalf, notes, needed-by, lines,
 * kits), then the checks across fields (delivery site, total units).
 */
export function parseOrderCreateRequest(raw: unknown): OrderCreateParse {
  const parsed = orderCreateRequestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  const { reason, field } = first
    ? refusalOf(first)
    : { reason: 'invalid' as const, field: 'body' };
  return {
    ok: false,
    refusal: {
      reason,
      ...(field ? { field } : {}),
      message: orderCreateRefusalCopy(reason, field),
    },
  };
}

// ── The answers ─────────────────────────────────────────────────────────────

/** The order an answer names (plan 3.1 `OrderSummary`). */
export interface OrderSummary {
  id: string;
  orderNumber: number | null;
  /** "SO-000123" (core formatOrderNumber), or null with no number. */
  orderLabel: string | null;
  status: string;
  warehouseId: string;
  fulfillmentType: 'pickup' | 'delivery';
  deliveryCharterId: string | null;
  /** The stored needed-by INSTANT (ISO), or null. */
  neededBy: string | null;
  lineCount: number;
  unitCount: number;
  createdAt: string;
  requestedFor: { self: true } | { self: false; name: string; email: string };
}

export interface OrderPlaceAnswer {
  organizationId: string;
  /** True when the key had already placed this order: nothing was written now. */
  replay: boolean;
  order: OrderSummary;
}

/** A recorded refusal, as the status read and the withdraw answer it. */
export interface OrderSubmissionRefusal {
  reason: string;
  detail: unknown;
}

export type OrderSubmissionStatus =
  | { organizationId: string; outcome: 'none' }
  | { organizationId: string; outcome: 'placed'; order: OrderSummary }
  | { organizationId: string; outcome: 'refused'; refusal: OrderSubmissionRefusal }
  | { organizationId: string; outcome: 'withdrawn' };

export class OrderAnswerShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderAnswerShapeError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function idOf(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '')
    throw new OrderAnswerShapeError(`${where} is not an id`);
  return v;
}

function textOf(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '')
    throw new OrderAnswerShapeError(`${where} is missing`);
  return v;
}

function nullableText(v: unknown, where: string): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new OrderAnswerShapeError(`${where} is missing`);
  return v;
}

function countOf(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
    throw new OrderAnswerShapeError(`${where} is not a count`);
  return v;
}

/** Reads an OrderSummary. Throws on a missing or wrong field; extra keys are
 *  ignored, so a later additive change never breaks an older phone. */
export function parseOrderSummary(raw: unknown, where = 'order'): OrderSummary {
  if (!isRecord(raw)) throw new OrderAnswerShapeError(`${where} is not an object`);
  const n = raw.orderNumber;
  if (n !== null && (typeof n !== 'number' || !Number.isInteger(n) || n < 1)) {
    throw new OrderAnswerShapeError(`${where}.orderNumber is not a number`);
  }
  if (raw.fulfillmentType !== 'pickup' && raw.fulfillmentType !== 'delivery') {
    throw new OrderAnswerShapeError(`${where}.fulfillmentType is not pickup or delivery`);
  }
  const rf = raw.requestedFor;
  if (!isRecord(rf)) throw new OrderAnswerShapeError(`${where}.requestedFor is not an object`);
  let requestedFor: OrderSummary['requestedFor'];
  if (rf.self === true) requestedFor = { self: true };
  else {
    if (rf.self !== undefined && rf.self !== false)
      throw new OrderAnswerShapeError(`${where}.requestedFor.self is not true or false`);
    requestedFor = {
      self: false,
      name: textOf(rf.name, `${where}.requestedFor.name`),
      email: textOf(rf.email, `${where}.requestedFor.email`),
    };
  }
  const deliveryCharterId =
    raw.deliveryCharterId === null
      ? null
      : idOf(raw.deliveryCharterId, `${where}.deliveryCharterId`);
  return {
    id: idOf(raw.id, `${where}.id`),
    orderNumber: n,
    orderLabel: nullableText(raw.orderLabel, `${where}.orderLabel`),
    status: textOf(raw.status, `${where}.status`),
    warehouseId: idOf(raw.warehouseId, `${where}.warehouseId`),
    fulfillmentType: raw.fulfillmentType,
    deliveryCharterId,
    neededBy: nullableText(raw.neededBy, `${where}.neededBy`),
    lineCount: countOf(raw.lineCount, `${where}.lineCount`),
    unitCount: countOf(raw.unitCount, `${where}.unitCount`),
    createdAt: textOf(raw.createdAt, `${where}.createdAt`),
    requestedFor,
  };
}

/** Reads `POST /api/v1/orders`' 201 and 200 answer:
 *  `{ organizationId, result: { replay, order } }`. */
export function parseOrderPlaceAnswer(raw: unknown): OrderPlaceAnswer {
  if (!isRecord(raw)) throw new OrderAnswerShapeError('the answer is not an object');
  const organizationId = idOf(raw.organizationId, 'organizationId');
  if (!isRecord(raw.result)) throw new OrderAnswerShapeError('result is not an object');
  if (typeof raw.result.replay !== 'boolean')
    throw new OrderAnswerShapeError('result.replay is not true or false');
  return {
    organizationId,
    replay: raw.result.replay,
    order: parseOrderSummary(raw.result.order, 'result.order'),
  };
}

/** Reads the submission status and withdraw answers:
 *  `{ organizationId, outcome, order?, refusal? }`. */
export function parseOrderSubmissionStatus(raw: unknown): OrderSubmissionStatus {
  if (!isRecord(raw)) throw new OrderAnswerShapeError('the answer is not an object');
  const organizationId = idOf(raw.organizationId, 'organizationId');
  switch (raw.outcome) {
    case 'none':
      return { organizationId, outcome: 'none' };
    case 'withdrawn':
      return { organizationId, outcome: 'withdrawn' };
    case 'placed':
      return { organizationId, outcome: 'placed', order: parseOrderSummary(raw.order) };
    case 'refused': {
      if (!isRecord(raw.refusal)) throw new OrderAnswerShapeError('refusal is not an object');
      return {
        organizationId,
        outcome: 'refused',
        refusal: {
          reason: textOf(raw.refusal.reason, 'refusal.reason'),
          detail: raw.refusal.detail ?? null,
        },
      };
    }
    default:
      throw new OrderAnswerShapeError('outcome is not none, placed, refused or withdrawn');
  }
}

// ── What an answer means (plan 3.4, 3.5) ────────────────────────────────────

/** A recorded refusal (plan 3.5): settled under the key, answered again,
 *  with `replay`, on every resend. */
export type OrderRecordedRefusalReason =
  | 'module_disabled'
  | 'permission'
  | 'warehouse_not_available'
  /** On behalf of someone else without orders:approve (security batch
   *  Slice D's rule; the plan's draft called it on_behalf_managers_only). */
  | 'on_behalf_not_permitted'
  | 'needed_by_past'
  | 'needed_by_out_of_range'
  | 'site_not_available'
  | 'item_not_orderable'
  | 'invalid';

/** Why one item cannot be ordered (`order_items_orderable`, first match). */
export type OrderItemRefusalReason =
  | 'not_visible'
  | 'deleted'
  | 'other_warehouse'
  | 'archived'
  | 'rental'
  | 'awaiting_first_receipt'
  | 'kit_stock';

/** The parts of an error's `details` this module reads. */
export interface OrderRefusalDetails {
  reason: string | null;
  field: string | null;
  /** The refusal is recorded under the key: final. */
  settled: boolean;
  replay: boolean;
  retryable: boolean;
  /** item_not_orderable: itemId → its reason. */
  items: Record<string, string> | null;
  /** site_not_available: 'not_serviced' or 'inactive'. */
  site: string | null;
  /** idempotency_conflict, when the key had placed an order. */
  orderId: string | null;
  orderNumber: number | null;
}

export function readOrderRefusalDetails(raw: unknown): OrderRefusalDetails {
  const d = isRecord(raw) ? raw : {};
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  let items: Record<string, string> | null = null;
  if (isRecord(d.items)) {
    items = {};
    for (const [k, v] of Object.entries(d.items)) if (typeof v === 'string') items[k] = v;
  }
  return {
    reason: str(d.reason),
    field: str(d.field),
    settled: d.settled === true,
    replay: d.replay === true,
    retryable: d.retryable === true,
    items,
    site: str(d.site),
    orderId: str(d.orderId),
    orderNumber:
      typeof d.orderNumber === 'number' && Number.isInteger(d.orderNumber) ? d.orderNumber : null,
  };
}

/**
 * What a call came back with. `ok: true` is a 2xx answer (its status and its
 * parsed JSON body). `ok: false` is what the call threw: on the phone an
 * `ApiError` from api() (status, code, details), a timeout or a network
 * failure; on the web, PO-2 builds the same shape from the action's error
 * (`{ status, code, details }`). Only those three fields are read.
 */
export type OrderCallResult =
  { ok: true; status: number; body: unknown } | { ok: false; error: unknown };

interface ApiErrorShape {
  status: number;
  code: string | null;
  details: unknown;
  /** The body was our JSON error shape (it named a code or details). */
  ours: boolean;
}

function apiErrorOf(e: unknown): ApiErrorShape | null {
  if (typeof e !== 'object' || e === null) return null;
  const { status, code, details } = e as { status?: unknown; code?: unknown; details?: unknown };
  if (typeof status !== 'number' || !Number.isInteger(status)) return null;
  const c = typeof code === 'string' && code !== '' ? code : null;
  return { status, code: c, details, ours: c !== null || details !== undefined };
}

/** Why a key is still unsettled. */
export type OrderUnconfirmedWhy =
  /** No answer: a timeout, a lost connection, the app killed mid-send. */
  | 'no_answer'
  /** 409 busy: the key's lock is held (an earlier send still running). */
  | 'busy'
  /** 409 idempotency_conflict: the key holds a different body. */
  | 'conflict'
  | 'rate_limited'
  | 'server_fault'
  /** A 2xx whose body could not be read. */
  | 'unreadable'
  /** A 404 that is not our JSON (an old server, or the routes reverted). */
  | 'unavailable'
  /** Refused before the key was looked at (a resend, a status read or a
   *  withdraw): says nothing about the earlier send. */
  | 'refused';

export type OrderSubmitOutcome =
  | { final: true; outcome: 'placed'; replay: boolean; organizationId: string; order: OrderSummary }
  | {
      final: true;
      outcome: 'refused';
      reason: string;
      /** Recorded under the key (settled), or refused on the only send. */
      recorded: boolean;
      details: OrderRefusalDetails;
    }
  | { final: true; outcome: 'withdrawn' }
  | {
      final: false;
      why: OrderUnconfirmedWhy;
      reason: string | null;
      details: OrderRefusalDetails | null;
    };

const NO_DETAILS = readOrderRefusalDetails(null);

/**
 * What one SEND of a key came back with (plan 3.4's table). `sends` is how
 * many sends this key has had, counting this one, as written to the device
 * BEFORE it left. Only `sends === 1` lets an unrecorded refusal unlock: on a
 * resend, the earlier send was never checked.
 */
export function classifyOrderSubmitResult(
  result: OrderCallResult,
  opts: { sends: number },
): OrderSubmitOutcome {
  if (result.ok) {
    try {
      const answer = parseOrderPlaceAnswer(result.body);
      return {
        final: true,
        outcome: 'placed',
        replay: answer.replay,
        organizationId: answer.organizationId,
        order: answer.order,
      };
    } catch {
      return { final: false, why: 'unreadable', reason: null, details: null };
    }
  }
  const e = apiErrorOf(result.error);
  if (!e) return { final: false, why: 'no_answer', reason: null, details: null };
  const details = readOrderRefusalDetails(e.details);
  const reason = details.reason ?? e.code;
  const onlySend = opts.sends === 1;
  if (e.status === 409 && details.reason === 'submission_withdrawn')
    return { final: true, outcome: 'withdrawn' };
  if (e.status >= 400 && e.status < 500 && details.settled) {
    return {
      final: true,
      outcome: 'refused',
      reason: reason ?? 'refused',
      recorded: true,
      details,
    };
  }
  if (e.status === 409 && details.reason === 'busy')
    return { final: false, why: 'busy', reason, details };
  if (e.status === 409 && details.reason === 'idempotency_conflict')
    return { final: false, why: 'conflict', reason, details };
  if (e.status === 429) return { final: false, why: 'rate_limited', reason, details };
  if (e.status >= 500) return { final: false, why: 'server_fault', reason, details };
  if (e.status === 404 && !e.ours) {
    return onlySend
      ? {
          final: true,
          outcome: 'refused',
          reason: 'unavailable',
          recorded: false,
          details: NO_DETAILS,
        }
      : { final: false, why: 'unavailable', reason: 'unavailable', details: null };
  }
  if (e.status >= 400 && e.status < 500) {
    return onlySend
      ? { final: true, outcome: 'refused', reason: reason ?? 'refused', recorded: false, details }
      : { final: false, why: 'refused', reason, details };
  }
  return { final: false, why: 'unreadable', reason, details };
}

/**
 * A recorded refusal's `detail` as `details`. The database records
 * item_not_orderable's detail as `{ itemId: reason }` and site_not_available's
 * as 'not_serviced' or 'inactive' (plan 3.2); an answer that already carries
 * the error contract's shape (`items`, `site`) is read as it is.
 */
function recordedRefusalDetails(refusal: OrderSubmissionRefusal): OrderRefusalDetails {
  const d = readOrderRefusalDetails(refusal.detail);
  const base: OrderRefusalDetails = { ...d, reason: refusal.reason, settled: true };
  if (refusal.reason === 'item_not_orderable' && d.items === null && isRecord(refusal.detail)) {
    const items: Record<string, string> = {};
    for (const [k, v] of Object.entries(refusal.detail)) if (typeof v === 'string') items[k] = v;
    return { ...base, items };
  }
  if (refusal.reason === 'site_not_available' && typeof refusal.detail === 'string') {
    return { ...base, site: refusal.detail };
  }
  return base;
}

/**
 * What a STATUS READ or a WITHDRAW came back with. A settled answer (placed,
 * refused, withdrawn) is final. `none`, a refusal of the call itself and no
 * answer are not: the key stays live. Neither call ever sends the order.
 */
export function classifyOrderSettleResult(result: OrderCallResult): OrderSubmitOutcome {
  if (result.ok) {
    let s: OrderSubmissionStatus;
    try {
      s = parseOrderSubmissionStatus(result.body);
    } catch {
      return { final: false, why: 'unreadable', reason: null, details: null };
    }
    switch (s.outcome) {
      case 'placed':
        return {
          final: true,
          outcome: 'placed',
          replay: true,
          organizationId: s.organizationId,
          order: s.order,
        };
      case 'withdrawn':
        return { final: true, outcome: 'withdrawn' };
      case 'refused':
        return {
          final: true,
          outcome: 'refused',
          reason: s.refusal.reason,
          recorded: true,
          details: recordedRefusalDetails(s.refusal),
        };
      case 'none':
        return { final: false, why: 'no_answer', reason: null, details: null };
    }
  }
  const e = apiErrorOf(result.error);
  if (!e) return { final: false, why: 'no_answer', reason: null, details: null };
  const details = readOrderRefusalDetails(e.details);
  const reason = details.reason ?? e.code;
  if (e.status === 409 && details.reason === 'busy')
    return { final: false, why: 'busy', reason, details };
  if (e.status === 429) return { final: false, why: 'rate_limited', reason, details };
  if (e.status >= 500) return { final: false, why: 'server_fault', reason, details };
  if (e.status === 404 && !e.ours)
    return { final: false, why: 'unavailable', reason: 'unavailable', details: null };
  return { final: false, why: 'refused', reason, details };
}

// ── The pending record (plan 3.6) ───────────────────────────────────────────

/**
 * What a surface keeps on the device for a live key: written and awaited
 * BEFORE the request is handed over, already counting that send (judge A-3).
 * If the write fails, nothing is sent (ORDER_DEVICE_SAVE_FAILED_COPY). On a
 * relaunch the record always reads as unconfirmed.
 *
 * The web keeps it under `order-pending:v1:<userId>:<orgId>:<warehouseId>`,
 * the phone inside its account-scoped `workspace.orderDraft.v1...` draft.
 */
export interface PendingOrderSubmission {
  key: string;
  /** The body exactly as sent: frozen while the key is live. */
  body: OrderCreateRequestInput;
  state: 'possibly_sent';
  /** Sends of this key so far, counting one about to leave. */
  sends: number;
  firstSentAt: string;
}

/**
 * Reads a stored pending record for the signed-in user. Null when it cannot
 * be read, or when it belongs to another account (its body's placer is not
 * `sessionUserId`): a record another account left on a shared browser is
 * never shown or sent (judge X-1).
 */
export function parsePendingOrderSubmission(
  raw: unknown,
  sessionUserId: string,
): PendingOrderSubmission | null {
  if (!isRecord(raw) || raw.state !== 'possibly_sent') return null;
  if (!uuidShaped(raw.key)) return null;
  if (typeof raw.sends !== 'number' || !Number.isInteger(raw.sends) || raw.sends < 1) return null;
  if (typeof raw.firstSentAt !== 'string' || raw.firstSentAt === '') return null;
  const body = parseOrderCreateRequest(raw.body);
  if (!body.ok || !isRecord(raw.body)) return null;
  if (body.value.idempotencyKey !== raw.key) return null;
  if (body.value.placerUserId.toLowerCase() !== sessionUserId.toLowerCase()) return null;
  return {
    key: raw.key,
    body: raw.body as OrderCreateRequestInput,
    state: 'possibly_sent',
    sends: raw.sends,
    firstSentAt: raw.firstSentAt,
  };
}

// ── The state machine (plan 3.4) ────────────────────────────────────────────

type NotFinal = Extract<OrderSubmitOutcome, { final: false }>;

export type OrderSubmissionState =
  /** No live key: the cart and the setup can change. */
  | { phase: 'open' }
  /** A send is out. Locked. */
  | { phase: 'sending'; pending: PendingOrderSubmission }
  /** "Don't send it" is out. Locked. */
  | { phase: 'withdrawing'; pending: PendingOrderSubmission; last: NotFinal }
  /** The key may or may not have placed the order. Locked; the panel shows. */
  | { phase: 'unconfirmed'; pending: PendingOrderSubmission; last: NotFinal }
  /** Final: placed. `viaWithdraw` when "Don't send it" found it placed. */
  | { phase: 'placed'; order: OrderSummary; replay: boolean; viaWithdraw: boolean }
  /** Final: refused. Unlocked, the field marked. */
  | { phase: 'refused'; reason: string; recorded: boolean; details: OrderRefusalDetails }
  /** Final: withdrawn. Unlocked. */
  | { phase: 'withdrawn' };

export type OrderSubmissionEvent =
  /** The first press of Submit: a new key and the frozen body. */
  | { type: 'send'; key: string; body: OrderCreateRequestInput; at: string }
  /** "Check and finish": the same key and body again. */
  | { type: 'resend' }
  | { type: 'send-result'; result: OrderCallResult }
  /** "Don't send it". */
  | { type: 'withdraw' }
  | { type: 'withdraw-result'; result: OrderCallResult }
  /** An automatic status read (foreground, open, reconnect). */
  | { type: 'status-result'; result: OrderCallResult }
  /** A pending record found on load. */
  | { type: 'restore'; pending: PendingOrderSubmission }
  /** The success screen, the refusal or the withdrawn notice is done with. */
  | { type: 'dismiss' };

export const ORDER_SUBMISSION_OPEN: OrderSubmissionState = { phase: 'open' };

const NO_ANSWER: NotFinal = { final: false, why: 'no_answer', reason: null, details: null };

function settle(
  outcome: Exclude<OrderSubmitOutcome, NotFinal>,
  viaWithdraw: boolean,
): OrderSubmissionState {
  switch (outcome.outcome) {
    case 'placed':
      return { phase: 'placed', order: outcome.order, replay: outcome.replay, viaWithdraw };
    case 'refused':
      return {
        phase: 'refused',
        reason: outcome.reason,
        recorded: outcome.recorded,
        details: outcome.details,
      };
    case 'withdrawn':
      return { phase: 'withdrawn' };
  }
}

/**
 * The submission's next state. Pure: the surface persists
 * `pendingOrderSubmissionOf(next)` (writing it, or deleting it when null)
 * and only then makes the call, and only commits `next` once that write has
 * succeeded. An event that does not fit the state changes nothing, so a
 * second tap, a late answer or a send with a new key while one is live can
 * never replace the live key.
 *
 * A send or a withdraw happens only on a tap; status reads run on their own,
 * and a status read never unlocks unless it reports a final outcome.
 */
export function orderSubmissionReducer(
  state: OrderSubmissionState,
  event: OrderSubmissionEvent,
): OrderSubmissionState {
  switch (event.type) {
    case 'send':
      if (state.phase !== 'open') return state;
      return {
        phase: 'sending',
        pending: {
          key: event.key,
          body: event.body,
          state: 'possibly_sent',
          sends: 1,
          firstSentAt: event.at,
        },
      };
    case 'resend':
      if (state.phase !== 'unconfirmed') return state;
      return { phase: 'sending', pending: { ...state.pending, sends: state.pending.sends + 1 } };
    case 'send-result': {
      if (state.phase !== 'sending') return state;
      const outcome = classifyOrderSubmitResult(event.result, { sends: state.pending.sends });
      return outcome.final
        ? settle(outcome, false)
        : { phase: 'unconfirmed', pending: state.pending, last: outcome };
    }
    case 'withdraw':
      if (state.phase !== 'unconfirmed') return state;
      return { phase: 'withdrawing', pending: state.pending, last: state.last };
    case 'withdraw-result': {
      if (state.phase !== 'withdrawing') return state;
      const outcome = classifyOrderSettleResult(event.result);
      return outcome.final
        ? settle(outcome, true)
        : { phase: 'unconfirmed', pending: state.pending, last: outcome };
    }
    case 'status-result': {
      if (state.phase !== 'unconfirmed') return state;
      const outcome = classifyOrderSettleResult(event.result);
      return outcome.final ? settle(outcome, false) : state;
    }
    case 'restore':
      if (state.phase !== 'open') return state;
      return { phase: 'unconfirmed', pending: event.pending, last: NO_ANSWER };
    case 'dismiss':
      if (state.phase === 'placed' || state.phase === 'refused' || state.phase === 'withdrawn')
        return ORDER_SUBMISSION_OPEN;
      return state;
  }
}

/** The cart, the setup, the notes, the needed-by, the warehouse switch and
 *  Clear are all locked while this is true. */
export function orderSubmissionLocked(state: OrderSubmissionState): boolean {
  return (
    state.phase === 'sending' || state.phase === 'withdrawing' || state.phase === 'unconfirmed'
  );
}

/** What the device must hold for this state: the live key's record, or null
 *  (delete it) once the key is settled. */
export function pendingOrderSubmissionOf(
  state: OrderSubmissionState,
): PendingOrderSubmission | null {
  return state.phase === 'sending' || state.phase === 'withdrawing' || state.phase === 'unconfirmed'
    ? state.pending
    : null;
}

/**
 * The guard for adding to a cart from outside it ("Order again", "Order this
 * item": P2 entry points). A cart with a live key is frozen: the add is
 * refused with this sentence, which points to the unconfirmed panel. Null
 * when the cart is free.
 */
export function refuseAddWhileLocked(
  pending: PendingOrderSubmission | null | undefined,
): string | null {
  return pending ? ORDER_ADD_WHILE_LOCKED_COPY : null;
}

// ── Words (plan section 6) ──────────────────────────────────────────────────

export type OrderSurface = 'web' | 'phone';

export const ORDER_UNCONFIRMED_TITLE_COPY = 'Your order request is not confirmed';
export const ORDER_UNCONFIRMED_BODY_COPY =
  "We sent it but did not hear back, so it may or may not have been placed. Check and finish sends the same request again: if it was placed, you'll see it; if not, it's placed now, once. Your cart is locked until then.";
export const ORDER_CHECK_AND_FINISH_COPY = 'Check and finish';
export const ORDER_DONT_SEND_COPY = "Don't send it";
export const ORDER_SEE_MY_ORDERS_COPY = 'See my orders';
export const ORDER_BUSY_COPY =
  'Still sending your order request. Wait a moment, then Check and finish.';
export const ORDER_RATE_LIMITED_COPY = 'Too many requests. Wait a moment, then Check and finish.';
export const ORDER_CONFLICT_COPY =
  "We couldn't match this to the order request you sent. See my orders, or choose Don't send it.";
export const ORDER_REFUSED_RESEND_SUFFIX_COPY =
  "The earlier send hasn't been checked yet. Check and finish, or Don't send it.";
export const ORDER_SIGN_IN_COPY = 'Sign in again to finish your order request.';
export const ORDER_PHONE_AAL2_UNCONFIRMED_COPY =
  "Your account uses an authenticator app, and this session hasn't been verified with it. Sign out and sign back in with your code. Signing out empties this cart; the order request stays checkable.";
export const ORDER_PHONE_AAL2_COPY =
  "Your account uses an authenticator app, and this session hasn't been verified with it. Sign out and sign back in with your code.";
export const ORDER_WEB_AAL2_COPY =
  'Verify with your authenticator app to place this order request.';
export const ORDER_MFA_REQUIRED_COPY =
  'Your organization requires two-factor authentication. Set it up on the web, then sign in again.';
export const ORDER_WITHDRAWN_COPY = 'It was not sent. Your cart is unlocked.';
/** "Don't send it" found the order already placed. */
export function orderAlreadyPlacedCopy(
  order: Pick<OrderSummary, 'orderNumber' | 'orderLabel'>,
): string {
  const label = order.orderLabel ?? formatOrderNumber(order.orderNumber);
  return label ? `It had already been placed: ${label}.` : 'It had already been placed.';
}
export const ORDER_REPLAY_COPY = 'This order request was already placed.';
export const ORDER_FAULT_COPY =
  "The order request couldn't be confirmed. Check and finish: if it was placed, you'll see it instead of a second one.";
export const ORDER_DEVICE_SAVE_FAILED_COPY =
  "Couldn't save your order request on this device, so it wasn't sent.";
export const ORDER_PHONE_TURNED_OFF_COPY =
  'Placing orders from the app is turned off right now. Use the web.';
export const ORDER_PHONE_UNAVAILABLE_COPY =
  "Placing orders from the app isn't available right now. Use the web.";
export const ORDER_NEEDS_CONNECTION_COPY = 'Needs a connection.';
export const ORDER_ADD_WHILE_LOCKED_COPY =
  "This cart has an order request that isn't confirmed yet. Check and finish it, or choose Don't send it, before adding items.";

export const ORDER_MODULE_DISABLED_COPY = 'Ordering is turned off for your organization.';
export const ORDER_PERMISSION_COPY = "Your account can't place orders. Ask an admin.";
export const ORDER_WAREHOUSE_NOT_AVAILABLE_COPY =
  "You can't order from this warehouse. Choose another one.";
export const ORDER_ON_BEHALF_NOT_PERMITTED_COPY =
  'Only someone who can approve orders can order for someone else.';
export const ORDER_PLACER_MISMATCH_COPY =
  "This order request was started by a different account, so it wasn't sent.";
export const ORDER_SITE_INACTIVE_COPY = 'That site is no longer active. Choose another site.';
export const ORDER_TIMEZONE_UNREADABLE_COPY = "Your organization's time zone couldn't be read.";
export const ORDER_ITEM_ARCHIVED_COPY = 'This item was archived.';
export const ORDER_ITEM_NOT_AVAILABLE_COPY = "This item isn't available to you here.";

/** "DC4 doesn't deliver to that site anymore. Choose another site." */
export function orderSiteNotServicedCopy(warehouseName: string | null): string {
  return `${warehouseName?.trim() || 'This warehouse'} doesn't deliver to that site anymore. Choose another site.`;
}

/**
 * One item's refusal, named from the CART (never from the server, so an item
 * the person cannot see never leaks a name). The rental, receipt and kit
 * sentences are the ones the web service says today
 * (services/order-requests.ts; place-order.test.ts pins them to it).
 */
export function orderItemRefusalCopy(reason: string, name: string): string {
  switch (reason) {
    case 'rental':
      return `${name} is a rental item. Check it out from Rentals instead of ordering it.`;
    case 'awaiting_first_receipt':
      return `This item hasn't been received yet: ${name}. It can be ordered once its first stock arrives.`;
    case 'kit_stock':
      return `${name} is a pre-assembled kit and can't be put on an order. Order the kit's items instead.`;
    case 'archived':
      return ORDER_ITEM_ARCHIVED_COPY;
    default:
      return ORDER_ITEM_NOT_AVAILABLE_COPY;
  }
}

/** "Some items can't be ordered from here anymore: Backpack, Mug. Remove them
 *  to continue." Names come from the cart; unnamed items are not listed. */
export function orderItemsNotOrderableCopy(names: readonly string[]): string {
  const listed = names.map((n) => n.trim()).filter((n) => n !== '');
  return listed.length > 0
    ? `Some items can't be ordered from here anymore: ${listed.join(', ')}. Remove them to continue.`
    : "Some items can't be ordered from here anymore. Remove them to continue.";
}

export interface OrderWordsContext {
  surface: OrderSurface;
  /** The cart's own name for an item id (null when the cart has no such line). */
  itemName?: (itemId: string) => string | null;
  warehouseName?: string | null;
}

/**
 * The CAUSE of a refusal, in one sentence: a schema reason, a reason the
 * service or the database recorded, or a reason raised before the key. It
 * says nothing about whether an earlier send landed; orderUnconfirmedCopy
 * adds that on a resend.
 */
export function orderRefusalCopy(
  reason: string | null,
  details: OrderRefusalDetails | null,
  ctx: OrderWordsContext,
): string {
  switch (reason) {
    case 'invalid':
      return orderCreateRefusalCopy('invalid', details?.field ?? undefined);
    case 'too_many_lines':
    case 'too_many_units':
    case 'quantity_not_whole':
    case 'notes_too_long':
    case 'on_behalf_invalid':
    case 'delivery_needs_site':
    case 'needed_by_invalid_time':
      return orderCreateRefusalCopy(reason);
    case 'module_disabled':
      return ORDER_MODULE_DISABLED_COPY;
    case 'permission':
      return ORDER_PERMISSION_COPY;
    case 'aal2_required':
      return ctx.surface === 'phone' ? ORDER_PHONE_AAL2_COPY : ORDER_WEB_AAL2_COPY;
    case 'mfa_required':
      return ORDER_MFA_REQUIRED_COPY;
    case 'unauthenticated':
    case 'not_member':
      return ORDER_SIGN_IN_COPY;
    case 'placer_mismatch':
      return ORDER_PLACER_MISMATCH_COPY;
    case 'timezone_unreadable':
      return ORDER_TIMEZONE_UNREADABLE_COPY;
    case 'warehouse_not_available':
      return ORDER_WAREHOUSE_NOT_AVAILABLE_COPY;
    case 'on_behalf_not_permitted':
      return ORDER_ON_BEHALF_NOT_PERMITTED_COPY;
    case 'needed_by_past':
      return NEEDED_BY_IN_PAST_COPY;
    case 'needed_by_out_of_range':
      return NEEDED_BY_OUT_OF_RANGE_COPY;
    case 'site_not_available':
      return details?.site === 'inactive'
        ? ORDER_SITE_INACTIVE_COPY
        : orderSiteNotServicedCopy(ctx.warehouseName ?? null);
    case 'item_not_orderable': {
      const ids = Object.keys(details?.items ?? {});
      const names = ids.flatMap((id) => {
        const n = ctx.itemName?.(id);
        return n ? [n] : [];
      });
      return orderItemsNotOrderableCopy(names);
    }
    case 'submission_withdrawn':
      return ORDER_WITHDRAWN_COPY;
    case 'unavailable':
      return ORDER_PHONE_UNAVAILABLE_COPY;
    case 'busy':
      return ORDER_BUSY_COPY;
    case 'idempotency_conflict':
      return ORDER_CONFLICT_COPY;
    default:
      return ORDER_FAULT_COPY;
  }
}

/** The unconfirmed panel's sentence for why the key is still live. */
export function orderUnconfirmedCopy(last: NotFinal, ctx: OrderWordsContext): string {
  switch (last.why) {
    case 'no_answer':
      return ORDER_UNCONFIRMED_BODY_COPY;
    case 'busy':
      return ORDER_BUSY_COPY;
    case 'rate_limited':
      return ORDER_RATE_LIMITED_COPY;
    case 'conflict':
      return ORDER_CONFLICT_COPY;
    case 'server_fault':
    case 'unreadable':
      return ORDER_FAULT_COPY;
    case 'unavailable':
      return `${ORDER_PHONE_UNAVAILABLE_COPY} ${ORDER_REFUSED_RESEND_SUFFIX_COPY}`;
    case 'refused': {
      if (last.reason === 'unauthenticated' || last.reason === 'not_member')
        return ORDER_SIGN_IN_COPY;
      if (last.reason === 'aal2_required' && ctx.surface === 'phone')
        return ORDER_PHONE_AAL2_UNCONFIRMED_COPY;
      return `${orderRefusalCopy(last.reason, last.details, ctx)} ${ORDER_REFUSED_RESEND_SUFFIX_COPY}`;
    }
  }
}
