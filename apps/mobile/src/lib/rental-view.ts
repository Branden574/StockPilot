import {
  formatRentalDateTime,
  isRentalOverdue,
  overdueReminderListMark,
  overdueReminderState,
  overdueRemindersOn,
  RENTAL_BORROWER_NOT_LINKED,
  RENTAL_BORROWER_TEAM_MEMBER,
  RENTAL_NO_EMAIL_NOTE,
  RENTAL_NON_MEMBER_EMAIL_NOTE,
  RENTAL_OVERDUE_SWEEP,
  rentalEmailOnFile,
  formatOrgDate,
  resolveOrgTimezone,
  uuidSchema,
  type Permission,
  type RentalEmailFacts,
} from '@stockpilot/core';

import { CONNECTION_FAILURE_COPY } from './connection-copy';
import { showWriteCta } from './cta-gating';
import { IdBatchReadError, readErrorMessage } from './id-batches';

/**
 * The phone's rental detail and the reminder marks on its rentals list, the
 * twins of web's /dashboard/rentals/[id] and /dashboard/rentals (2026-09-25).
 *
 * The phone reads rentals the way its list always has: straight from the
 * tables, under the caller's own row level security (rentals_select is
 * warehouse read access, 0131), so it shows nothing web would not. What it
 * SAYS about the borrower's emails comes from @stockpilot/core
 * (rentals/emails.ts), the same functions the web pages use and the same rule
 * the daily overdue sweep uses to send the reminder.
 *
 * Two small reads ride along with the rental, and neither can fail the screen:
 *   - the organization's explicit Rentals row (organization_modules, readable
 *     by every member, 0144), which is the sweep's switch. Unreadable is null:
 *     the screen then says it could not check, never "will be sent".
 *   - the organization's time zone, so a reminder time reads as it does on
 *     the web. Unreadable falls back to the device's zone.
 */

/** Just enough of the Supabase client: `from(table)`, typed loosely like id-batches. */
export interface RentalViewClient {
  from(table: string): unknown;
}

interface MaybeSingleChain {
  eq(column: string, value: unknown): MaybeSingleChain;
  maybeSingle(): PromiseLike<{
    data: unknown;
    error: { message?: string | null } | null;
    status?: number | null;
    statusText?: string | null;
  }>;
}

function selectFrom(client: RentalViewClient, table: string, columns: string): MaybeSingleChain {
  return (client.from(table) as { select(columns: string): MaybeSingleChain }).select(columns);
}

// ─── When the server did not answer ──────────────────────────────────────

/**
 * What the rental screens say when a read got no answer at all (offline, a
 * dropped connection): the phone's one sentence for it (connection-copy.ts),
 * also said by the recount sheet and the verification screens. The network
 * layer's own text is never shown: the simulator walk (2026-09-25) found
 * "Could not load this rental. Error: fetch failed: UnexpectedException:
 * Could not connect to the server. (at ExpoModulesCore/Promise.swift:56)".
 */
export const RENTAL_CONNECTION_FAILURE = CONNECTION_FAILURE_COPY;

/**
 * The reason a Supabase read failed, as the rental screens say it. Decided on
 * the status, never on the message text: postgrest-js answers a request that
 * got no HTTP response with status 0 (and the network layer's words as the
 * message). Any real answer keeps its own reason, never empty
 * (readErrorMessage).
 */
export function rentalReadErrorMessage(
  error: { message?: string | null },
  status?: number | null,
  statusText?: string | null,
): string {
  return status === 0 ? RENTAL_CONNECTION_FAILURE : readErrorMessage(error, status, statusText);
}

/**
 * The same for a paged or batched read that threw (settleIdBatchRead's
 * `describe`): an IdBatchReadError carries the failed page's status.
 */
export function rentalReadFailureMessage(err: unknown): string {
  if (err instanceof IdBatchReadError && err.status === 0) return RENTAL_CONNECTION_FAILURE;
  if (err instanceof Error && err.message) return err.message;
  return 'The request failed.';
}

/** Said when a Check out that was sent was not confirmed (see rentalCheckoutFailure). */
export const RENTAL_CHECKOUT_UNCONFIRMED =
  'The app could not confirm this checkout with the server, so this rental may or may not have been checked out. ' +
  'Check your connection, then look for it on the Rentals list before you check out again.';

/** Ends a sentence that has no end mark. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * The alert for a Check out that failed. `sent` is whether api() handed the
 * request to fetch (its onSend hook, as item-adjust.ts uses it).
 *
 *   - Never sent (the body could not be built, the session or the saved
 *     workspace could not be read): nothing reached the server, so it could
 *     not check out, and the reason is given. It used to say "may or may not
 *     have been checked out" here too.
 *   - Sent, with no answer (offline, a dropped connection, api()'s timeout)
 *     or a 5xx: the checkout may have committed before the answer was lost.
 *     A gateway 502, 503 or 504 can arrive after the commit, and so can the
 *     route's 500: create_rental commits in one call, and an answer from the
 *     database lost after that commit reaches the route as an internal error
 *     (services/rentals.ts rentalRpcError). A second Check out would lend the
 *     same units twice (there is no idempotency key yet, S6-B), so it never
 *     says "try again": it says to look first, the way the phone's order
 *     edits and stock adjustments do (add-order-items.ts, item-adjust.ts).
 *   - Sent and refused (a 4xx): nothing was written; the service's own
 *     sentence, written for an operator.
 * Keyed on the status, never on the message text.
 */
export function rentalCheckoutFailure(e: unknown, sent: boolean): { title: string; message: string } {
  if (!sent) {
    const reason = e instanceof Error && e.message.trim() ? e.message : 'The app could not send it.';
    return {
      title: 'Could not check out',
      message: `${sentence(reason)} Nothing was sent, so nothing was checked out.`,
    };
  }
  const status =
    e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'number'
      ? (e as { status: number }).status
      : null;
  if (status === null || status >= 500) {
    return { title: 'Checkout not confirmed', message: RENTAL_CHECKOUT_UNCONFIRMED };
  }
  const message = e instanceof Error && e.message.trim() ? e.message : 'Could not check this rental out.';
  return { title: 'Could not check out', message };
}

/**
 * When a rental typed as DAYS FROM TODAY is due: that many days after `now`,
 * or null when there is nothing to send. Null for anything that is not a
 * whole number of days above zero, and for a number of days so large the
 * date does not exist (999999999 days is an Invalid Date, whose
 * toISOString() throws before the request is even built).
 */
export function rentalExpectedReturn(daysText: string, now: Date): Date | null {
  const days = parseInt(daysText, 10);
  if (Number.isNaN(days) || days <= 0) return null;
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + days);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** The switch and the zone every rental screen needs. */
export interface RentalReminderContext {
  /** overdueRemindersOn() of the explicit Rentals row; null when unreadable. */
  remindersOn: boolean | null;
  /** The organization's zone, or null to use the device's. */
  timeZone: string | null;
}

/**
 * Reads the organization's Rentals row (the sweep's switch) and its time zone.
 * Never throws: each read that fails becomes "unknown" (null).
 */
export async function loadRentalReminderContext(
  client: RentalViewClient,
  orgId: string,
): Promise<RentalReminderContext> {
  const [moduleRow, orgRow] = await Promise.all([
    Promise.resolve(
      selectFrom(client, 'organization_modules', 'enabled')
        .eq('organization_id', orgId)
        .eq('module_id', RENTAL_OVERDUE_SWEEP.moduleId)
        .maybeSingle(),
    ).catch(() => null),
    Promise.resolve(
      selectFrom(client, 'organizations', 'timezone').eq('id', orgId).maybeSingle(),
    ).catch(() => null),
  ]);
  const remindersOn =
    moduleRow && !moduleRow.error
      ? overdueRemindersOn(moduleRow.data as { enabled?: boolean | null } | null)
      : null;
  const rawZone =
    orgRow && !orgRow.error ? (orgRow.data as { timezone?: string | null } | null)?.timezone : null;
  // resolveOrgTimezone turns a zone this runtime cannot format into the
  // documented default rather than letting it throw out of a render.
  const timeZone = typeof rawZone === 'string' && rawZone.trim() ? resolveOrgTimezone(rawZone) : null;
  return { remindersOn, timeZone };
}

// ─── The list ────────────────────────────────────────────────────────────

/** The columns the list's reminder mark needs, added to its select. */
export const RENTAL_LIST_REMINDER_COLUMNS = 'borrower_user_id, overdue_reminder_sent_at';

/** The checkouts the list shows, and the organization they were read for. */
export interface RentalCheckoutsView<Row> {
  /** The organization the rows belong to. After a switch they are not the one on screen. */
  orgId: string;
  rows: Row[];
  /** The reminder switch and zone read with the rows. */
  context: RentalReminderContext;
  /** When the rows were read: "overdue" and the marks use this clock. */
  readAt: number;
  /** No list could be read for this organization ("Could not load rentals."). */
  failed: boolean;
  /** A reload failed and the rows from before it are still shown: why, for the banner. */
  staleReason: string | null;
}

/** One read of the list: the rows, or why there are none. */
export type RentalCheckoutsRead<Row> =
  | { ok: true; rows: Row[]; context: RentalReminderContext; readAt: number }
  | { ok: false; reason: string; context: RentalReminderContext; readAt: number };

/**
 * What the list shows after a read. A read that failed keeps the rows the
 * same organization already shows, with the reason for a banner: the list
 * reloads on focus, and offline, coming back from a rental replaced the list
 * being read with "Could not load rentals." and no rows (review 2026-09-26).
 * With nothing shown for this organization yet, a failure is the failure.
 */
export function settleRentalCheckouts<Row>(
  prev: RentalCheckoutsView<Row> | null,
  orgId: string,
  read: RentalCheckoutsRead<Row>,
): RentalCheckoutsView<Row> {
  if (read.ok) {
    return { orgId, rows: read.rows, context: read.context, readAt: read.readAt, failed: false, staleReason: null };
  }
  if (prev && prev.orgId === orgId && !prev.failed) return { ...prev, staleReason: read.reason };
  return { orgId, rows: [], context: read.context, readAt: read.readAt, failed: true, staleReason: null };
}

/** The banner over rows kept through a failed reload. */
export function rentalListStaleCopy(reason: string): string {
  return `Could not refresh. Showing the rentals as last loaded. ${reason}`;
}

/**
 * Said when no workspace could be loaded (a launch offline, or a failed first
 * read after signing in), beside a Try again that loads it again
 * (use-workspace.ts retryWorkspace).
 */
export const RENTAL_WORKSPACE_UNAVAILABLE =
  'Could not load your workspace. Check your connection and try again.';

/** The rentals list's title for the same case; a pull loads it again. */
export const RENTAL_LIST_NO_WORKSPACE_TITLE = 'Could not load your workspace.';

/**
 * The small mark an OVERDUE row carries ("Reminder sent Sep 26", "No email on
 * file", "Reminders off", "Reminder goes out Sep 27"), or null: not overdue,
 * or nothing true and short to say.
 */
export function rentalListReminderMark(
  rental: RentalEmailFacts,
  context: RentalReminderContext,
  nowMs: number,
): string | null {
  if (!isRentalOverdue(rental, nowMs)) return null;
  return overdueReminderListMark(
    overdueReminderState(rental, context.remindersOn, nowMs),
    context.timeZone,
  );
}

export type RentalPillStatus = 'ok' | 'warn' | 'crit';

/** The status pill the list card and the detail both show. */
export function rentalStatusPill(
  rental: { status: string; expected_return_at: string },
  nowMs: number,
): { label: string; status: RentalPillStatus } {
  if (rental.status === 'returned') return { label: 'RETURNED', status: 'ok' };
  if (rental.status === 'cancelled') return { label: 'CANCELLED', status: 'crit' };
  if (isRentalOverdue(rental, nowMs)) return { label: 'OVERDUE', status: 'crit' };
  return { label: 'OUT', status: 'warn' };
}

// ─── The detail ──────────────────────────────────────────────────────────

/** One rental with everything the detail shows. */
export const RENTAL_DETAIL_SELECT = `id, status, borrower_user_id, borrower_name, borrower_email,
  checked_out_at, expected_return_at, returned_at, cancelled_at, cancellation_reason,
  return_notes, notes, overdue_reminder_sent_at,
  warehouse:warehouses!warehouse_id (name),
  lines:rental_lines (id, item_id, quantity, notes, item:inventory_items (name, sku))`;

export interface RentalDetailLine {
  id: string;
  itemId: string;
  name: string;
  sku: string | null;
  quantity: number;
  notes: string | null;
}

export interface RentalDetail extends RentalEmailFacts {
  id: string;
  borrower_user_id: string | null;
  borrower_name: string;
  checked_out_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  return_notes: string | null;
  notes: string | null;
  warehouseName: string | null;
  lines: RentalDetailLine[];
}

export type RentalDetailLoad =
  | { ok: true; rental: RentalDetail; context: RentalReminderContext }
  | { ok: false; notFound: true }
  | { ok: false; notFound: false; message: string };

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function toDetail(raw: Record<string, unknown>): RentalDetail {
  const warehouse = one(raw.warehouse as { name?: string | null } | { name?: string | null }[] | null);
  const rawLines = Array.isArray(raw.lines) ? (raw.lines as Record<string, unknown>[]) : [];
  return {
    id: String(raw.id),
    status: String(raw.status),
    borrower_user_id: (raw.borrower_user_id as string | null) ?? null,
    borrower_name: String(raw.borrower_name ?? ''),
    borrower_email: (raw.borrower_email as string | null) ?? null,
    checked_out_at: String(raw.checked_out_at),
    expected_return_at: String(raw.expected_return_at),
    returned_at: (raw.returned_at as string | null) ?? null,
    cancelled_at: (raw.cancelled_at as string | null) ?? null,
    cancellation_reason: (raw.cancellation_reason as string | null) ?? null,
    return_notes: (raw.return_notes as string | null) ?? null,
    notes: (raw.notes as string | null) ?? null,
    overdue_reminder_sent_at: (raw.overdue_reminder_sent_at as string | null) ?? null,
    warehouseName: warehouse?.name ?? null,
    lines: rawLines.map((l) => {
      const item = one(l.item as { name?: string | null; sku?: string | null } | null);
      const quantity = Number(l.quantity);
      return {
        id: String(l.id),
        itemId: String(l.item_id),
        // An item the caller may not read (or since removed) still has a line.
        name: item?.name?.trim() || 'Item',
        sku: item?.sku?.trim() || null,
        quantity: Number.isFinite(quantity) ? quantity : 0,
        notes: (l.notes as string | null) ?? null,
      };
    }),
  };
}

/**
 * The rental, scoped to the organization, with the reminder context. A failed
 * rental read says so (never "not found"); a rental the caller cannot see is
 * not found, exactly as row level security answers it.
 *
 * An id that is not a uuid (a mistyped or mangled link,
 * stockpilot://rentals/not-a-real-id) is not found without asking: the
 * database would refuse it with its own text ('invalid input syntax for type
 * uuid'), shown with a Try again that could never work. Checked with core's
 * uuidSchema, as the web's detail pages check their ids.
 */
export async function loadRentalDetail(
  client: RentalViewClient,
  orgId: string,
  rentalId: string,
): Promise<RentalDetailLoad> {
  if (!uuidSchema.safeParse(rentalId).success) return { ok: false, notFound: true };
  const [rentalRes, context] = await Promise.all([
    Promise.resolve(
      selectFrom(client, 'rentals', RENTAL_DETAIL_SELECT)
        .eq('id', rentalId)
        .eq('organization_id', orgId)
        .maybeSingle(),
    ).then(
      (res) => res,
      // A request that rejected got no answer: status 0, as postgrest-js
      // reports a request with no HTTP response.
      (e: unknown) => ({
        data: null,
        error: { message: e instanceof Error ? e.message : '' },
        status: 0,
        statusText: null,
      }),
    ),
    loadRentalReminderContext(client, orgId),
  ]);
  if (rentalRes.error) {
    return {
      ok: false,
      notFound: false,
      message: rentalReadErrorMessage(rentalRes.error, rentalRes.status, rentalRes.statusText),
    };
  }
  if (!rentalRes.data) return { ok: false, notFound: true };
  return { ok: true, rental: toDetail(rentalRes.data as Record<string, unknown>), context };
}

/** Who borrowed it, as the detail's borrower card says it. */
export interface RentalBorrowerView {
  name: string;
  /** "Team member" or "Not linked to a StockPilot account". */
  kind: string;
  isMember: boolean;
  /** The address the rental emails go to, or null. */
  email: string | null;
  /** Under the email: the no-email note, or (for a non-member) the no-link note. */
  note: string | null;
}

export function rentalBorrowerView(rental: {
  borrower_name: string;
  borrower_user_id: string | null;
  borrower_email: string | null;
}): RentalBorrowerView {
  const isMember = Boolean(rental.borrower_user_id);
  const email = rentalEmailOnFile(rental.borrower_email);
  return {
    name: rental.borrower_name.trim() || 'Unnamed borrower',
    kind: isMember ? RENTAL_BORROWER_TEAM_MEMBER : RENTAL_BORROWER_NOT_LINKED,
    isMember,
    email,
    note: email === null ? RENTAL_NO_EMAIL_NOTE : isMember ? null : RENTAL_NON_MEMBER_EMAIL_NOTE,
  };
}

/**
 * "Sep 25, 2026, 5:00 PM" in the organization's zone when it is known, else
 * the device's: core's formatRentalDateTime, the function the web detail
 * prints the expected return with, so the two read the same. It used to be
 * toLocaleString, which Hermes writes as "Sep 25, 2026 at 5:00 PM". An em
 * dash for a missing or unreadable value.
 */
export function rentalTimeLabel(iso: string | null | undefined, timeZone: string | null): string {
  return formatRentalDateTime(iso, timeZone, { withYear: true });
}

const DAY_LABEL_OPTIONS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

/**
 * "Sep 25": the list card's out and due dates, in the organization's zone when
 * it is known, else the device's. The reminder mark under them and the detail
 * screen's EXPECTED RETURN use the organization's zone, so the card does too:
 * with the organization on UTC and the phone in California, a rental due
 * 2026-09-26T00:00Z used to read "due Sep 25" on the card and "Sep 26" one tap
 * away. An em dash for a missing or unreadable value.
 */
export function rentalDayLabel(iso: string | null | undefined, timeZone: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  if (timeZone) return formatOrgDate(d, DAY_LABEL_OPTIONS, timeZone);
  return d.toLocaleDateString('en-US', DAY_LABEL_OPTIONS);
}

/**
 * The detail's button to the web rental page, where returns and cancels
 * happen, worded for what this viewer can do there; null when the web page
 * would offer them nothing. The web shows its actions panel only with
 * rentals:create (Mark returned), and Cancel only with rentals:manage as well
 * (apps/web/src/app/(dashboard)/dashboard/rentals/[id]/page.tsx and
 * components/rentals/rental-actions-panel.tsx). A rentals:read viewer (an
 * auditor, say) used to be offered "Mark returned or cancel on the web" and
 * land on a page with neither. showWriteCta shows the button while the
 * permission set is still loading, like every other write button on the phone;
 * the web page and the server decide.
 */
export function rentalWebActionLabel(
  status: string,
  perms: ReadonlySet<Permission> | undefined,
): string | null {
  if (status !== 'out') return null;
  if (!showWriteCta(perms, 'rentals:create')) return null;
  return showWriteCta(perms, 'rentals:manage')
    ? 'Mark returned or cancel on the web'
    : 'Mark returned on the web';
}
