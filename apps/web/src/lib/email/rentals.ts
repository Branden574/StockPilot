import 'server-only';

import {
  renderRentalOut,
  renderRentalOverdue,
  renderRentalReturned,
} from './families/rentals';
import { sendEmail } from './resend';
import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';

import { rentalEmailOnFile } from '@stockpilot/core';

import type {
  RentalBaseParams,
  RentalEmailItem,
  RenderedRentalEmail,
} from './families/rentals';

/**
 * Rental notification emails — best-effort, borrower facing.
 *
 * This module is the DISPATCH layer only: it loads the rental context,
 * decides whether to send (borrower-absent skip), and hands render work
 * to the es-layer family templates in `families/rentals.ts`. The old
 * hand-rolled HTML here (a copy-paste clone of the order template) is
 * gone — rentals now compose from the same shared component layer as
 * every other email family.
 *
 * No exported function ever throws or rejects: the whole body is wrapped in
 * try/catch so an email failure can't break rental checkout/return or a cron
 * sweep. Failures log a `console.warn` and return. The checkout and return
 * senders return nothing; the overdue sender returns how the send ended
 * (RentalEmailOutcome), because the daily sweep must not leave a rental
 * marked reminded when no reminder went out (the rental pages print that
 * mark as "Sent <time>").
 *
 * These run server-side from the rental service / cron with the
 * service-role client (the `rentals` + org tables carry RLS), so we use
 * `createAdminClient()` rather than a user-scoped client.
 *
 * FOOTER POLICY — "rental classification decision": rentals have no
 * preference backend, so the family renders the ESSENTIAL footer (no
 * unsubscribe link that couldn't work). See families/rentals.ts for the
 * full flag. Do not add List-Unsubscribe headers here until a real
 * rental preference/suppression exists.
 */

// ─── Row shapes ──────────────────────────────────────────────────────

interface RentalRow {
  id: string;
  organization_id: string;
  borrower_user_id: string | null;
  borrower_name: string | null;
  borrower_email: string | null;
  checked_out_at: string | null;
  expected_return_at: string | null;
  returned_at: string | null;
  warehouse_id: string | null;
  status: string | null;
  notes: string | null;
}

type RentalEmailKind = 'checkout' | 'returned' | 'overdue';

interface RentalContext {
  base: RentalBaseParams;
  row: RentalRow;
}

/**
 * How one send ended.
 *   sent       the email service accepted it (or, with no RESEND_API_KEY, the
 *              dry run logged it)
 *   no_email   the rental has no email on file: there was nothing to send
 *   not_found  the rental is gone
 *   failed     nothing was confirmed sent: the rental read failed, or the
 *              email service refused the message or could not be reached
 */
export type RentalEmailOutcome = 'sent' | 'no_email' | 'not_found' | 'failed';

type LoadedRental =
  | { ok: true; ctx: RentalContext }
  | { ok: false; outcome: Exclude<RentalEmailOutcome, 'sent'> };

// ─── Date labels ─────────────────────────────────────────────────────

// Org-local display timezone. Matches the schedule-reminders cron's
// hard-coded America/Los_Angeles until orgs carry a timezone setting.
const DISPLAY_TZ = 'America/Los_Angeles';

function fmt(iso: string | null, opts: Intl.DateTimeFormatOptions): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US', { ...opts, timeZone: DISPLAY_TZ });
}

/** "Jun 9, 2026" */
function fmtDate(iso: string | null): string | null {
  return fmt(iso, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "Jun 9" — headline-length due label. */
function fmtDateShort(iso: string | null): string | null {
  return fmt(iso, { month: 'short', day: 'numeric' });
}

/** "Jun 2, 10:15 AM" */
function fmtDateTime(iso: string | null): string | null {
  return fmt(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ─── Data fetching ───────────────────────────────────────────────────

async function loadRentalContext(rentalId: string): Promise<LoadedRental> {
  const admin = createAdminClient();

  const { data: rental, error: rentalErr } = await admin
    .from('rentals')
    .select(
      'id, organization_id, borrower_user_id, borrower_name, borrower_email, checked_out_at, expected_return_at, returned_at, warehouse_id, status, notes',
    )
    .eq('id', rentalId)
    .maybeSingle();

  if (rentalErr) {
    console.warn('[rental-email] failed to load rental', rentalId, rentalErr.message);
    return { ok: false, outcome: 'failed' };
  }
  if (!rental) {
    console.warn('[rental-email] rental not found', rentalId);
    return { ok: false, outcome: 'not_found' };
  }

  const row = rental as RentalRow;

  // The rental pages say "no email on file: no receipt or reminders" with
  // this same check (@stockpilot/core rentals/emails.ts).
  const email = rentalEmailOnFile(row.borrower_email);
  if (!email) {
    // Normal: many rentals have no borrower email. Nothing to send.
    return { ok: false, outcome: 'no_email' };
  }

  // Lines joined to inventory_items for display name + SKU (asset tag).
  // Best-effort: an empty/failed lines fetch still yields a valid
  // (item-less) email.
  const { data: lineRows } = await admin
    .from('rental_lines')
    .select('item_id, quantity, inventory_items(name, sku)')
    .eq('rental_id', rentalId);

  type RawLine = {
    item_id: string | null;
    quantity: number | null;
    inventory_items:
      | { name: string | null; sku: string | null }
      | { name: string | null; sku: string | null }[]
      | null;
  };
  const items: RentalEmailItem[] = ((lineRows ?? []) as RawLine[]).map((l) => {
    const rel = l.inventory_items;
    const item = Array.isArray(rel) ? rel[0] : rel;
    return {
      name: (item?.name ?? 'Item').trim() || 'Item',
      qty: Number(l.quantity ?? 0) || 0,
      sku: (item?.sku ?? '').trim() || null,
    };
  });

  // Org + warehouse names, best-effort with '—' fallback.
  const [orgRes, whRes] = await Promise.all([
    admin
      .from('organizations')
      .select('name')
      .eq('id', row.organization_id)
      .maybeSingle(),
    row.warehouse_id
      ? admin
          .from('warehouses')
          .select('name')
          .eq('id', row.warehouse_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const orgName =
    ((orgRes.data as { name?: string | null } | null)?.name ?? '').trim() || '—';
  const warehouseName =
    ((whRes.data as { name?: string | null } | null)?.name ?? '').trim() || '—';

  const borrowerName = (row.borrower_name ?? '').trim() || '—';
  const firstName = borrowerName.split(/\s+/)[0] || null;

  const appUrl = env.NEXT_PUBLIC_APP_URL;
  // FLAG: only account-holding borrowers get a CTA — there is no public
  // rental surface, and /dashboard links dead-end external borrowers on
  // /signin (owner decision pending; see families/rentals.ts).
  const viewUrl = row.borrower_user_id
    ? `${appUrl}/dashboard/rentals/${row.id}`
    : null;

  const base: RentalBaseParams = {
    firstName: firstName === '—' ? null : firstName,
    borrowerName,
    borrowerEmail: email,
    orgName,
    location: warehouseName,
    items,
    checkedOutAt: fmtDateTime(row.checked_out_at) ?? '—',
    due: fmtDate(row.expected_return_at) ?? '—',
    dueShort: fmtDateShort(row.expected_return_at) ?? '—',
    viewUrl,
    urls: {
      support: `${appUrl}/support`,
      privacy: `${appUrl}/privacy`,
      terms: `${appUrl}/terms`,
    },
  };

  return { ok: true, ctx: { base, row } };
}

// ─── Render-by-kind ──────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function renderByKind(kind: RentalEmailKind, ctx: RentalContext): RenderedRentalEmail {
  const { base, row } = ctx;
  switch (kind) {
    case 'checkout':
      return renderRentalOut({ ...base, conditionNote: row.notes });
    case 'returned':
      return renderRentalReturned({
        ...base,
        returnedAt: fmtDateTime(row.returned_at) ?? '—',
      });
    case 'overdue': {
      // Real day counts only: whole days past the expected return,
      // floored at 1 — the daily cron only selects rentals already past
      // due, and "0 days" would read as not-overdue.
      const dueMs = row.expected_return_at ? Date.parse(row.expected_return_at) : NaN;
      const overdueDays = Number.isFinite(dueMs)
        ? Math.max(1, Math.floor((Date.now() - dueMs) / MS_PER_DAY))
        : 1;
      return renderRentalOverdue({
        ...base,
        overdueDays,
        today: fmtDate(new Date().toISOString()) ?? '—',
      });
    }
  }
}

async function sendRentalEmail(
  rentalId: string,
  kind: RentalEmailKind,
): Promise<RentalEmailOutcome> {
  try {
    const loaded = await loadRentalContext(rentalId);
    if (!loaded.ok) return loaded.outcome;

    const rendered = renderByKind(kind, loaded.ctx);
    const result = await sendEmail({
      to: loaded.ctx.base.borrowerEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: rendered.from,
    });
    // sendEmail answers { ok: false } (it does not throw) when Resend refuses
    // the message or cannot be reached. That is not a send. resend.ts has
    // already logged Resend's reply, which can quote the address, so only the
    // rental is named here.
    if (!result.ok) {
      console.warn(`[rental-email] ${kind} email was not accepted for rental ${rentalId}`);
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    // Best-effort: an email failure must never break rental
    // checkout/return or a cron sweep.
    console.warn(
      `[rental-email] ${kind} email failed for rental ${rentalId}:`,
      err instanceof Error ? err.message : err,
    );
    return 'failed';
  }
}

// ─── Public entry points ─────────────────────────────────────────────

/** Confirmation sent when a rental is checked out. Best-effort; never throws. */
export async function sendRentalCheckoutEmail(rentalId: string): Promise<void> {
  await sendRentalEmail(rentalId, 'checkout');
}

/** Thank-you sent when a rental is marked returned. Best-effort; never throws. */
export async function sendRentalReturnedEmail(rentalId: string): Promise<void> {
  await sendRentalEmail(rentalId, 'returned');
}

/**
 * Reminder that a rental is past its expected return date. Best-effort; never
 * throws. Returns how the send ended: the daily sweep keeps its "reminded"
 * stamp only for 'sent' (and for 'no_email', where there is nothing to retry),
 * and hands a 'failed' rental back to the next run.
 */
export async function sendRentalOverdueEmail(rentalId: string): Promise<RentalEmailOutcome> {
  return sendRentalEmail(rentalId, 'overdue');
}
