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
 *
 * ═══ IMPORTING THIS MODULE RUNS NOTHING ═══
 *
 * Core's index re-exports this file, so every web page that bundles core
 * evaluates its top level, and so does the phone at start-up (Metro does not
 * tree-shake). The top level therefore holds only declarations and literals:
 * the zod schema is built on first use (`orderCreateRequestSchema()`), and
 * the cap sentences are written out. place-order.test.ts fails on any call
 * at the top level. (The PO-1 review measured +3.6 KB on 129 web routes when
 * the schema was built on import.)
 */

import { z } from 'zod';

import { NEEDED_BY_IN_PAST_COPY, NEEDED_BY_OUT_OF_RANGE_COPY } from './needed-by-words';
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The on-behalf email rule the web applies today: zod 3's `.email()` pattern,
 * after trimming (apps/web/src/server/actions/order-requests.ts reads the
 * email with z.string().trim().email().max(254)), so moving the web onto core
 * in PO-2 accepts and refuses exactly what it does now. ASCII letters, digits
 * and _ ' + - . before the @ (not starting or ending with a dot, no two dots
 * in a row), dot-separated labels after it that start with a letter or digit,
 * and a top-level domain of two or more letters. Postgres AREs support these
 * lookaheads, so M1 uses the same pattern with `~*`. place-order.test.ts pins
 * it to zod's own over a corpus.
 */
const EMAIL_RE = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;
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

function onBehalfNameValid(v: string): boolean {
  const n = charCount(v.trim());
  return n >= 1 && n <= ORDER_ON_BEHALF_NAME_MAX;
}

function onBehalfEmailValid(v: string): boolean {
  const e = v.trim();
  return charCount(e) <= ORDER_EMAIL_MAX && EMAIL_RE.test(e);
}

/**
 * The person an order is for, by the create schema's own rule (the schema
 * uses these two checks): a name of 1 to ORDER_ON_BEHALF_NAME_MAX characters
 * and a valid email, both trimmed. A client refuses with
 * ORDER_ON_BEHALF_INVALID_COPY before sending what the route would refuse
 * (phone desk check F11).
 */
export function isOrderOnBehalfValid(who: { name: string; email: string }): boolean {
  return onBehalfNameValid(who.name) && onBehalfEmailValid(who.email);
}

/**
 * Whether "YYYY-MM-DDTHH:mm" names a real calendar date and time. Zone-free:
 * the server converts it in the organization's zone with core
 * `wallClockToInstant`, which can still answer null for a wall clock this
 * accepts: the spring-forward hour, and years 0000 to 0099 (Date.UTC reads
 * them as 1900 to 1999). The service (PO-2) answers that null with
 * `needed_by_invalid_time`, never converts in a guessed zone, and never
 * passes a null on as "no needed-by".
 */
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
  /** For `invalid`: what is at fault: `lines` (none), `quantity`, `itemId`,
   *  `line`, `pickupSite` (a site on a pickup order), `deliveryCharterId` (a
   *  missing or malformed site id), `idempotencyKey`, `placerUserId`,
   *  `warehouseId`, `fulfillmentType`, `notes`, `kits`, `body`, or the name
   *  of an unknown key (`body` when that name is one with words of its own:
   *  `lines`, `quantity`, `pickupSite`). */
  field?: string;
  /** Core's sentence for it. */
  message: string;
}

export const ORDER_LINES_EMPTY_COPY = 'Add at least one item.';
export const ORDER_TOO_MANY_LINES_COPY = `An order request can have at most ${ORDER_MAX_LINES} lines.`;
// Written out, not formatted at load (see the header); the test pins both
// numbers to the caps.
export const ORDER_TOO_MANY_UNITS_COPY = 'An order request can have at most 10,000 units.';
export const ORDER_QUANTITY_NOT_WHOLE_COPY = 'Quantities must be whole numbers.';
export const ORDER_QUANTITY_INVALID_COPY = 'Each quantity must be at least 1.';
export const ORDER_NOTES_TOO_LONG_COPY = 'Manager notes can be at most 2,000 characters.';
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
      if (field === 'pickupSite') return ORDER_PICKUP_HAS_SITE_COPY;
      return ORDER_BODY_UNREADABLE_COPY;
  }
}

/** An `invalid` field with words of its own (orderCreateRefusalCopy). An
 *  unknown key with one of these names is reported as `body`, so it never
 *  borrows them. */
function hasOwnWords(field: string): boolean {
  return field === 'lines' || field === 'quantity' || field === 'pickupSite';
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

function buildOrderCreateRequestSchema() {
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
          .refine(onBehalfNameValid, ORDER_ON_BEHALF_INVALID_COPY),
        email: z
          .string({
            required_error: ORDER_ON_BEHALF_INVALID_COPY,
            invalid_type_error: ORDER_ON_BEHALF_INVALID_COPY,
          })
          .refine(onBehalfEmailValid, ORDER_ON_BEHALF_INVALID_COPY),
      },
      { invalid_type_error: ORDER_ON_BEHALF_INVALID_COPY },
    )
    .strict(ORDER_ON_BEHALF_INVALID_COPY)
    .transform((v) => ({ name: v.name.trim(), email: v.email.trim() }));

  return z
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
      {
        invalid_type_error: ORDER_BODY_UNREADABLE_COPY,
        required_error: ORDER_BODY_UNREADABLE_COPY,
      },
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
          params: why('invalid', 'pickupSite'),
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
}

type OrderCreateRequestSchema = ReturnType<typeof buildOrderCreateRequestSchema>;
let builtOrderCreateRequestSchema: OrderCreateRequestSchema | null = null;

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
 *
 * Built on the first call and kept, never when the module loads (see the
 * header). The plan names this `orderCreateRequestSchema`; it is a function
 * returning the schema.
 *
 * Only the new body. The web action's legacy branch (PO-2, one release, for
 * tabs opened before the deploy) receives today's body (`neededBy` as an
 * instant, `requesterPhone` and `pickupLocationNotes` null) and reads it with
 * its own legacy schema; `.strict()` refuses that body here, by design.
 */
export function orderCreateRequestSchema(): OrderCreateRequestSchema {
  if (builtOrderCreateRequestSchema === null) {
    builtOrderCreateRequestSchema = buildOrderCreateRequestSchema();
  }
  return builtOrderCreateRequestSchema;
}

/** The body as the client sends it. */
export type OrderCreateRequestInput = z.input<OrderCreateRequestSchema>;
/** The body as read: trimmed notes (empty is null), trimmed on-behalf. */
export type OrderCreateRequest = z.output<OrderCreateRequestSchema>;

/** The reason for one zod issue: its own when it carries one, else by where
 *  it is and what kind it is. */
function refusalOf(issue: z.ZodIssue): { reason: OrderCreateShapeReason; field?: string } {
  if (issue.code === z.ZodIssueCode.custom) {
    const p = issue.params as Partial<Params> | undefined;
    if (p?.reason) return why(p.reason, p.field);
  }
  const [top, index, leaf] = issue.path;
  const unknownKey = (keys: string[], otherwise: string) => {
    const k = keys[0];
    return {
      reason: 'invalid' as const,
      field: k === undefined ? otherwise : hasOwnWords(k) ? 'body' : k,
    };
  };
  if (top === undefined) {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) return unknownKey(issue.keys, 'body');
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
      if (issue.code === z.ZodIssueCode.unrecognized_keys) return unknownKey(issue.keys, 'line');
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
  const parsed = orderCreateRequestSchema().safeParse(raw);
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

/**
 * A web server action's answer as a call result. Actions answer
 * `{ ok: false, error: { code, message, details } }` with no HTTP status, and
 * the classifiers read the status first: an error with none reads as no
 * answer (locked, the safe side, but every web refusal, settled ones
 * included, would sit behind the "not confirmed" panel). PO-2 passes
 * `serviceErrorStatus` (apps/web/src/server/services/context.ts), so a web
 * refusal classifies exactly as the phone's ApiError for the same code does.
 * A success's `data` is the create, status or withdraw answer.
 */
export function orderCallResultFromAction(
  res: { ok: true; data: unknown } | { ok: false; error: { code: string; details?: unknown } },
  statusForCode: (code: string) => number,
): OrderCallResult {
  if (res.ok) return { ok: true, status: 200, body: res.data };
  const { code, details } = res.error;
  return { ok: false, error: { status: statusForCode(code), code, details } };
}

/**
 * An answer as the surface that sent the call for `organizationId` must read
 * it (review round 1). Apply it to EVERY create, status and withdraw answer
 * before classifying (the web hook does; the phone must too).
 *
 * The web's organization is the account's default one, which a workspace
 * switch in another tab or on another computer changes for every open tab;
 * the phone names its organization in a header, but a switch can still land
 * between a send and its resend. An answer for another organization says
 * nothing about this organization's key:
 *   - a success that does not name this organization is no answer (the key
 *     stays live; an order it names belongs to the other organization);
 *   - a refusal (4xx) that names another organization in `details` becomes
 *     an `organization_changed` refusal that is never recorded here: on the
 *     only send it is final (that send never reached this organization), on a
 *     resend or a settle call it keeps the key live, even when the other
 *     organization recorded it as settled;
 *   - a fault, a refusal that names this organization or none, and a lost
 *     call are classified as they are.
 * The servers refuse a mismatch themselves before any key work (the web
 * action compares the page's organization; the routes answer for the
 * X-Organization-Id they are sent); this is the client's half.
 */
export function orderCallResultForOrganization(
  result: OrderCallResult,
  organizationId: string,
): OrderCallResult {
  const wanted = organizationId.toLowerCase();
  const isThis = (v: unknown) => typeof v === 'string' && v.toLowerCase() === wanted;
  if (result.ok) {
    if (isRecord(result.body) && isThis(result.body.organizationId)) return result;
    return { ok: false, error: new Error('The answer was for another organization.') };
  }
  const e = apiErrorOf(result.error);
  if (!e || e.status < 400 || e.status >= 500 || !isRecord(e.details)) return result;
  const named = e.details.organizationId;
  if (named === undefined || named === null || isThis(named)) return result;
  return {
    ok: false,
    error: {
      status: 409,
      code: 'conflict',
      details: {
        reason: 'organization_changed',
        ...(typeof named === 'string' ? { organizationId: named } : {}),
      },
    },
  };
}

/**
 * A shape refusal the DATABASE raised (M1 step 3: 22023 with hint
 * `order_invalid` and a field in its detail, `delivery_needs_site`,
 * `idempotency_key_required` or `idempotency_key_invalid`) as core's reason,
 * so the service's 400 carries the same reason and words whichever engine
 * refused. The route reads every body with core's schema first, so the
 * database refusing a shape core accepted means the engines disagree (the
 * parity fixture exists to stop that). A field that stands for several core
 * reasons (`lines`, `quantity`), a field the service sets (`surface`) and
 * anything unknown answer `invalid`/`body` ("couldn't be read") rather than
 * guess. The parity test checks every pairing in the fixture.
 */
export function orderShapeRefusalFromSql(
  hint: string,
  field: string | null,
): { reason: OrderCreateShapeReason; field?: string } {
  const body = { reason: 'invalid' as const, field: 'body' };
  switch (hint) {
    case 'delivery_needs_site':
      return { reason: 'delivery_needs_site' };
    case 'idempotency_key_required':
    case 'idempotency_key_invalid':
      return { reason: 'invalid', field: 'idempotencyKey' };
    case 'order_invalid':
      break;
    default:
      return body;
  }
  switch (field) {
    case 'notes':
      return { reason: 'notes_too_long' };
    case 'on_behalf':
      return { reason: 'on_behalf_invalid' };
    case 'needed_by':
      return { reason: 'needed_by_invalid_time' };
    case 'total':
      return { reason: 'too_many_units' };
    case 'fulfillment_type':
      return { reason: 'invalid', field: 'fulfillmentType' };
    case 'warehouse':
      return { reason: 'invalid', field: 'warehouseId' };
    case 'site':
      return { reason: 'invalid', field: 'deliveryCharterId' };
    default:
      return body;
  }
}

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
          details: readOrderRefusalDetails(null),
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
 *
 * `bodyUnreadable` is set only by parsePendingOrderSubmission, for a record of
 * this account whose body today's schema no longer reads (an earlier build
 * wrote it). Its key may still have placed an order, so it stays live and
 * locked: status reads and "Don't send it" settle it, and "Check and finish"
 * is not offered (the server would refuse that body before it looked at the
 * key). Narrow on it before sending `body`.
 */
export type PendingOrderSubmission = {
  key: string;
  state: 'possibly_sent';
  /** Sends of this key so far, counting one about to leave. */
  sends: number;
  firstSentAt: string;
} & (
  | {
      /** The body exactly as sent: frozen while the key is live. */
      body: OrderCreateRequestInput;
      bodyUnreadable?: undefined;
    }
  | {
      /** The stored body as it was: never sent again. */
      body: Record<string, unknown>;
      bodyUnreadable: true;
    }
);

/**
 * Reads a stored pending record for the signed-in user.
 *
 * Null only when nothing ties it to this account and this key: it is not a
 * record, its key is not uuid-shaped, its send count or first-sent time is
 * unusable, its body is not an object, its body names another key, or its
 * body's placer is not `sessionUserId` (a record another account left on a
 * shared browser is never shown or sent, judge X-1).
 *
 * A record of this account whose body fails TODAY's schema (written by an
 * earlier build before an answer was lost) is returned flagged
 * `bodyUnreadable`, never dropped: dropping it would unlock the cart and
 * forget a key that may have placed an order. The flag is worked out on every
 * read; a stored one is ignored.
 */
export function parsePendingOrderSubmission(
  raw: unknown,
  sessionUserId: string,
): PendingOrderSubmission | null {
  if (!isRecord(raw) || raw.state !== 'possibly_sent') return null;
  if (!uuidShaped(raw.key)) return null;
  if (typeof raw.sends !== 'number' || !Number.isInteger(raw.sends) || raw.sends < 1) return null;
  if (typeof raw.firstSentAt !== 'string' || raw.firstSentAt === '') return null;
  const stored = raw.body;
  if (!isRecord(stored)) return null;
  // Ownership and the key, apart from the schema.
  if (stored.idempotencyKey !== raw.key) return null;
  if (typeof stored.placerUserId !== 'string') return null;
  if (stored.placerUserId.toLowerCase() !== sessionUserId.toLowerCase()) return null;
  const base = {
    key: raw.key,
    state: 'possibly_sent' as const,
    sends: raw.sends,
    firstSentAt: raw.firstSentAt,
  };
  return parseOrderCreateRequest(stored).ok
    ? { ...base, body: stored as OrderCreateRequestInput }
    : { ...base, body: stored, bodyUnreadable: true };
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
 *
 * The key tracked is always the key in the body: a send or a restore whose
 * body names another key changes nothing (the server places under the
 * body's key while the status read and the withdraw use the tracked one, so
 * a mismatch could settle the wrong key as "not sent"). A record whose body
 * this build cannot read is never resent.
 */
export function orderSubmissionReducer(
  state: OrderSubmissionState,
  event: OrderSubmissionEvent,
): OrderSubmissionState {
  switch (event.type) {
    case 'send':
      if (state.phase !== 'open') return state;
      if (event.body.idempotencyKey !== event.key) return state;
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
      if (!orderSubmissionCanResend(state)) return state;
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
      if (event.pending.body.idempotencyKey !== event.pending.key) return state;
      return { phase: 'unconfirmed', pending: event.pending, last: NO_ANSWER };
    case 'dismiss':
      if (state.phase === 'placed' || state.phase === 'refused' || state.phase === 'withdrawn')
        return ORDER_SUBMISSION_OPEN;
      return state;
  }
}

/** Whether "Check and finish" is offered: the key is unconfirmed and its body
 *  can be sent again (not a record an earlier build wrote that today's schema
 *  no longer reads). "Don't send it" is always offered while unconfirmed. */
export function orderSubmissionCanResend(
  state: OrderSubmissionState,
): state is Extract<OrderSubmissionState, { phase: 'unconfirmed' }> {
  return state.phase === 'unconfirmed' && state.pending.bodyUnreadable !== true;
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
/** An outcome that is NOT known (a fault, an unreadable answer): the key
 *  stays live, so it points at Check and finish. */
export const ORDER_FAULT_COPY =
  "The order request couldn't be confirmed. Check and finish: if it was placed, you'll see it instead of a second one.";
/** A FINAL refusal whose reason core has no sentence for (an edge's HTML
 *  403 or 413, a 400 with no reason): refused on the only send, so nothing
 *  was placed and the cart is unlocked. There is no Check and finish then. */
export const ORDER_REFUSED_FINAL_COPY = "It wasn't sent. Check the order and submit it again.";
/** The cause, on a RESEND, when core has no sentence for the reason; the
 *  unconfirmed panel adds ORDER_REFUSED_RESEND_SUFFIX_COPY. */
export const ORDER_RESEND_REFUSED_COPY = "This send wasn't accepted.";
/** The unconfirmed panel for a record an earlier build wrote whose body this
 *  build cannot read (PendingOrderSubmission.bodyUnreadable). */
export const ORDER_UNCONFIRMED_STALE_BODY_COPY =
  "We sent it but did not hear back, so it may or may not have been placed. StockPilot was updated since, so it can't be sent again. Choose Don't send it: if it was placed, you'll see it; if not, your cart is unlocked.";
export const ORDER_DEVICE_SAVE_FAILED_COPY =
  "Couldn't save your order request on this device, so it wasn't sent.";
export const ORDER_PHONE_TURNED_OFF_COPY =
  'Placing orders from the app is turned off right now. Use the web.';
export const ORDER_PHONE_UNAVAILABLE_COPY =
  "Placing orders from the app isn't available right now. Use the web.";
/** The phone storefront's reads (PO-3): a read that failed, which nothing
 *  depends on, so pulling down reads it again. */
export const ORDER_STOREFRONT_LOAD_FAILED_COPY = "Ordering couldn't be loaded. Pull down to try again.";
export const ORDER_STOREFRONT_RATE_LIMITED_COPY =
  'Too many requests. Wait a moment, then pull down to try again.';
export const ORDER_STOREFRONT_SIGN_IN_COPY = 'Sign in again to place an order.';
export const ORDER_NEEDS_CONNECTION_COPY = 'Needs a connection.';
export const ORDER_ADD_WHILE_LOCKED_COPY =
  "This cart has an order request that isn't confirmed yet. Check and finish it, or choose Don't send it, before adding items.";

/** The only send was answered for another organization (the account's
 *  workspace was switched in another tab or window): nothing was placed. */
export const ORDER_ORGANIZATION_CHANGED_COPY =
  "You switched to another organization in another tab or window, so it wasn't sent. Switch back to send it, or reload the page.";
/** A resend, a status read or a withdraw was answered for another
 *  organization: the key may have placed the order in the one it was sent
 *  from, and only that organization can settle it. */
export const ORDER_ORGANIZATION_CHANGED_UNCONFIRMED_COPY =
  'You switched to another organization in another tab or window. Switch back to the organization this order request was sent from to finish it.';
/** A resend, a status read or a withdraw from a page another account's
 *  session now answers for (a shared browser, a tab left open). */
export const ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY =
  "You're signed in as a different account than the one that sent this order request. Sign in as that account to finish it.";
/** The web page is older than the server it calls (its server action is
 *  gone after a deploy), so the call never ran. The key stays live. */
export const ORDER_PAGE_OUT_OF_DATE_COPY =
  'StockPilot was updated since this page was opened. Reload the page to finish your order request.';
/** The same, on the only send: nothing ran, so nothing was placed. */
export const ORDER_PAGE_OUT_OF_DATE_FINAL_COPY =
  "StockPilot was updated since this page was opened, so it wasn't sent. Reload the page, then submit it again.";

export const ORDER_MODULE_DISABLED_COPY = 'Ordering is turned off for your organization.';
export const ORDER_PERMISSION_COPY = "Your account can't place orders. Ask an admin.";
export const ORDER_WAREHOUSE_NOT_AVAILABLE_COPY =
  "You can't order from this warehouse. Choose another one.";
export const ORDER_ON_BEHALF_NOT_PERMITTED_COPY =
  'Only someone who can approve orders can order for someone else.';
export const ORDER_PLACER_MISMATCH_COPY =
  "This order request was started by a different account, so it wasn't sent.";
export const ORDER_SITE_INACTIVE_COPY = 'That site is no longer active. Choose another site.';
/** The cause. A final refusal adds what to do (orderRefusalCopy); on a
 *  resend the unconfirmed panel adds the way out. */
export const ORDER_TIMEZONE_UNREADABLE_COPY = "Your organization's time zone couldn't be read.";
export const ORDER_TIMEZONE_UNREADABLE_FINAL_COPY =
  "Your organization's time zone couldn't be read, so it wasn't sent. Wait a moment, then submit it again.";
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
  /** The live key's record has a body this build cannot read
   *  (PendingOrderSubmission.bodyUnreadable): Check and finish is not
   *  offered, so the panel says what settles it instead. */
  bodyUnreadable?: boolean;
}

/**
 * The CAUSE of a refusal, in one sentence: a schema reason, a reason the
 * service or the database recorded, or a reason raised before the key. Null
 * when core has no sentence for the reason. It says nothing about whether an
 * earlier send landed.
 */
function refusalCauseCopy(
  reason: string | null,
  details: OrderRefusalDetails | null,
  ctx: OrderWordsContext,
): string | null {
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
    case 'failed':
      return ORDER_FAULT_COPY;
    default:
      return null;
  }
}

/**
 * The words for a FINAL refusal (the `refused` phase: recorded under the key,
 * or refused on the only send, so nothing was placed and the cart is
 * unlocked). A reason core has no sentence for says it wasn't sent and to
 * submit again; it never points at Check and finish, which that state does
 * not show. On a resend, the unconfirmed panel's words come from
 * orderUnconfirmedCopy instead.
 */
export function orderRefusalCopy(
  reason: string | null,
  details: OrderRefusalDetails | null,
  ctx: OrderWordsContext,
): string {
  if (reason === 'timezone_unreadable') return ORDER_TIMEZONE_UNREADABLE_FINAL_COPY;
  if (reason === 'organization_changed') return ORDER_ORGANIZATION_CHANGED_COPY;
  if (reason === 'page_out_of_date') return ORDER_PAGE_OUT_OF_DATE_FINAL_COPY;
  return refusalCauseCopy(reason, details, ctx) ?? ORDER_REFUSED_FINAL_COPY;
}

/** The unconfirmed panel's sentence for why the key is still live. */
export function orderUnconfirmedCopy(last: NotFinal, ctx: OrderWordsContext): string {
  const signIn =
    last.why === 'refused' && (last.reason === 'unauthenticated' || last.reason === 'not_member');
  // Refused for the session or the page, not the order: Check and finish and
  // Don't send it get the same answer until it is put right, so the sentence
  // says what puts it right and offers neither.
  if (last.why === 'refused') {
    if (last.reason === 'organization_changed') return ORDER_ORGANIZATION_CHANGED_UNCONFIRMED_COPY;
    if (last.reason === 'placer_mismatch') return ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY;
    if (last.reason === 'page_out_of_date') return ORDER_PAGE_OUT_OF_DATE_COPY;
  }
  if (ctx.bodyUnreadable) {
    if (signIn) return ORDER_SIGN_IN_COPY;
    if (last.why === 'refused' && last.reason === 'aal2_required' && ctx.surface === 'phone')
      return ORDER_PHONE_AAL2_UNCONFIRMED_COPY;
    return ORDER_UNCONFIRMED_STALE_BODY_COPY;
  }
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
      if (signIn) return ORDER_SIGN_IN_COPY;
      if (last.reason === 'aal2_required' && ctx.surface === 'phone')
        return ORDER_PHONE_AAL2_UNCONFIRMED_COPY;
      const cause = refusalCauseCopy(last.reason, last.details, ctx) ?? ORDER_RESEND_REFUSED_COPY;
      return `${cause} ${ORDER_REFUSED_RESEND_SUFFIX_COPY}`;
    }
  }
}
