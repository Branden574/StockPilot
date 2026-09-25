import {
  formatOrgDateTime,
  isRentalOverdue,
  overdueReminderListMark,
  overdueReminderState,
  overdueRemindersOn,
  RENTAL_BORROWER_NOT_IN_STOCKPILOT,
  RENTAL_BORROWER_TEAM_MEMBER,
  RENTAL_NO_EMAIL_NOTE,
  RENTAL_NON_MEMBER_EMAIL_NOTE,
  RENTAL_OVERDUE_SWEEP,
  rentalEmailOnFile,
  resolveOrgTimezone,
  type RentalEmailFacts,
} from '@stockpilot/core';

import { readErrorMessage } from './id-batches';

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
 */
export async function loadRentalDetail(
  client: RentalViewClient,
  orgId: string,
  rentalId: string,
): Promise<RentalDetailLoad> {
  const [rentalRes, context] = await Promise.all([
    Promise.resolve(
      selectFrom(client, 'rentals', RENTAL_DETAIL_SELECT)
        .eq('id', rentalId)
        .eq('organization_id', orgId)
        .maybeSingle(),
    ).then(
      (res) => res,
      (e: unknown) => ({
        data: null,
        error: { message: e instanceof Error ? e.message : 'Could not reach the server.' },
        status: null,
        statusText: null,
      }),
    ),
    loadRentalReminderContext(client, orgId),
  ]);
  if (rentalRes.error) {
    return {
      ok: false,
      notFound: false,
      message: readErrorMessage(rentalRes.error, rentalRes.status, rentalRes.statusText),
    };
  }
  if (!rentalRes.data) return { ok: false, notFound: true };
  return { ok: true, rental: toDetail(rentalRes.data as Record<string, unknown>), context };
}

/** Who borrowed it, as the detail's borrower card says it. */
export interface RentalBorrowerView {
  name: string;
  /** "Team member" or "Not in StockPilot". */
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
    kind: isMember ? RENTAL_BORROWER_TEAM_MEMBER : RENTAL_BORROWER_NOT_IN_STOCKPILOT,
    isMember,
    email,
    note: email === null ? RENTAL_NO_EMAIL_NOTE : isMember ? null : RENTAL_NON_MEMBER_EMAIL_NOTE,
  };
}

const TIME_LABEL_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * "Sep 25, 2026, 5:00 PM" in the organization's zone when it is known (as the
 * web detail prints the expected return), else the device's. An em dash for a
 * missing or unreadable value.
 */
export function rentalTimeLabel(iso: string | null | undefined, timeZone: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  if (timeZone) return formatOrgDateTime(d, TIME_LABEL_OPTIONS, timeZone);
  return d.toLocaleString('en-US', TIME_LABEL_OPTIONS);
}
