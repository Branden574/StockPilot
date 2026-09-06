import 'server-only';

import { assertWarehouseAccess, ForbiddenError } from '@/lib/auth/warehouse';
import { sendRentalCheckoutEmail, sendRentalReturnedEmail } from '@/lib/email/rentals';
import { createAdminClient } from '@/lib/supabase/admin';

import { audit } from './audit';
import { fetchAllRows } from './lib/paginate';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceContext,
  ServiceError,
  withContext,
} from './context';

import type {
  CreateRentalInput,
  MarkReturnedInput,
  CancelRentalInput,
} from '@stockpilot/core';

export type RentalStatus = 'out' | 'returned' | 'cancelled';

export interface RentalRow {
  id: string;
  organization_id: string;
  warehouse_id: string;
  borrower_user_id: string | null;
  borrower_name: string;
  borrower_email: string | null;
  checked_out_at: string;
  expected_return_at: string;
  returned_at: string | null;
  status: RentalStatus;
  notes: string | null;
  created_by: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  returned_by: string | null;
  return_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface RentalLineRow {
  id: string;
  rental_id: string;
  item_id: string;
  quantity: number;
  notes: string | null;
  created_at: string;
}

export interface ListRentalsFilters {
  status?: RentalStatus | 'overdue' | 'all';
  warehouseId?: string;
}

export class RentalsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<RentalsService> {
    return new RentalsService(await withContext());
  }

  /**
   * Lists rentals with optional status filter. 'overdue' is derived
   * (status='out' AND expected_return_at < now()) so consumers don't
   * need to know about the underlying column shape.
   */
  async list(filters: ListRentalsFilters = {}): Promise<{
    rentals: Array<RentalRow & { lines: RentalLineRow[] }>;
  }> {
    assertModuleEnabled(this.ctx, 'rentals');
    // Build base query. We need a typed local variable so we can conditionally
    // attach filters without fighting TS's inference on chained query builders.
    let query = this.ctx.supabase
      .from('rentals')
      .select('*, lines:rental_lines(*)')
      .eq('organization_id', this.ctx.organizationId)
      .order('checked_out_at', { ascending: false })
      .limit(500);

    if (filters.warehouseId) {
      query = query.eq('warehouse_id', filters.warehouseId);
    }
    if (filters.status === 'overdue') {
      query = query.eq('status', 'out').lt('expected_return_at', new Date().toISOString());
    } else if (filters.status && filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }

    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return { rentals: (data ?? []) as Array<RentalRow & { lines: RentalLineRow[] }> };
  }

  async get(id: string): Promise<(RentalRow & { lines: RentalLineRow[] }) | null> {
    assertModuleEnabled(this.ctx, 'rentals');
    const { data, error } = await this.ctx.supabase
      .from('rentals')
      .select('*, lines:rental_lines(*)')
      .eq('id', id)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    return data as (RentalRow & { lines: RentalLineRow[] }) | null;
  }

  async create(input: CreateRentalInput): Promise<{ id: string }> {
    assertModuleEnabled(this.ctx, 'rentals');
    assertPermission(this.ctx, 'rentals:create');

    // Validate: expected_return_at must be in the future or "now-ish"
    // (within 1 hour of past — clock skew tolerance).
    const expected = new Date(input.expectedReturnAt);
    if (Number.isNaN(expected.getTime()) || expected.getTime() < Date.now() - 60 * 60 * 1000) {
      throw new ServiceError('validation_error', 'Expected return date must be in the future.');
    }

    // Resolve borrower name when a member is selected.
    let borrowerName = input.borrowerName;
    if (input.borrowerUserId) {
      const { data: member } = await this.ctx.supabase
        .from('organization_members')
        .select('user:user_profiles(full_name)')
        .eq('user_id', input.borrowerUserId)
        .eq('organization_id', this.ctx.organizationId)
        .maybeSingle();
      const memberFullName = (
        member as { user?: { full_name?: string | null } | null } | null
      )?.user?.full_name;
      if (memberFullName) borrowerName = memberFullName;
    }

    // Validate: every line's item_id must exist + be is_rental=true.
    const itemIds = input.lines.map((l) => l.itemId);
    const { data: rentalItems } = await this.ctx.supabase
      .from('inventory_items')
      // `name` is here for the availability refusal message below — an operator
      // who is told "Projector B: only 2 available" can go find the open rental.
      .select('id, name, is_rental, warehouse_id, quantity_on_hand')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', itemIds);
    const itemsById = new Map(
      (
        (rentalItems ?? []) as Array<{
          id: string;
          name: string | null;
          is_rental: boolean;
          warehouse_id: string;
          quantity_on_hand: number;
        }>
      ).map((i) => [i.id, i]),
    );
    for (const line of input.lines) {
      const it = itemsById.get(line.itemId);
      if (!it) throw new ServiceError('not_found', `Item ${line.itemId} not found.`);
      if (!it.is_rental)
        throw new ServiceError('validation_error', 'One or more items are not rental items.');
      if (it.warehouse_id !== input.warehouseId)
        throw new ServiceError('validation_error', 'All items must be in the rental warehouse.');
    }

    // Availability guard (SP-052). v1 shipped `TODO availability check — for
    // v1 we trust the picker UI's filter`, and the picker does NOT enforce it:
    // it computes `quantityOnHand - reservedQuantity` for its filter/sort chips
    // but caps the cart's '+' at quantity_on_hand alone. So an item with 5 on
    // hand and 3 already out on another rental displayed "2 avail" and happily
    // accepted 5 — 8 units reserved against 5 physical ones, two borrowers
    // recorded as holding the same stock, and nothing ever refused it (posting
    // the server action directly was even easier: the only bound was the
    // schema's max 10_000). Rentals RESERVE rather than decrement on-hand, so
    // this sum IS the availability model — there is no other layer to catch it
    // (no DB constraint bounds stock_reservations against on-hand).
    //
    // Paginated per recurring-pattern #3: PostgREST clamps ANY select to 1000
    // rows, and a long-lived item accumulates reservation rows from orders AND
    // rentals; a truncated read would UNDERCOUNT reservations and wave the
    // over-lend straight through. fetchAllRows throws on a read error, which is
    // the right posture here — this read guards a WRITE, so it fails closed.
    const requestedByItem = new Map<string, number>();
    for (const line of input.lines) {
      requestedByItem.set(line.itemId, (requestedByItem.get(line.itemId) ?? 0) + line.quantity);
    }
    const activeReservations = await fetchAllRows<{ item_id: string; quantity: number | null }>(
      (from, to) =>
        this.ctx.supabase
          .from('stock_reservations')
          .select('id, item_id, quantity')
          .eq('organization_id', this.ctx.organizationId)
          .in('item_id', itemIds)
          .is('released_at', null)
          .order('id')
          .range(from, to),
    );
    const reservedByItem = new Map<string, number>();
    for (const r of activeReservations) {
      reservedByItem.set(r.item_id, (reservedByItem.get(r.item_id) ?? 0) + (r.quantity ?? 0));
    }
    for (const [itemId, requested] of requestedByItem) {
      const it = itemsById.get(itemId)!;
      const onHand = it.quantity_on_hand ?? 0;
      const reserved = reservedByItem.get(itemId) ?? 0;
      const available = Math.max(0, onHand - reserved);
      if (requested > available) {
        throw new ServiceError(
          'validation_error',
          `${it.name ?? 'Item'}: only ${available} available to rent ` +
            `(${onHand} on hand, ${reserved} already reserved) — ${requested} requested.`,
        );
      }
    }

    // Insert rental header.
    const { data: rentalRow, error: rentalErr } = await this.ctx.supabase
      .from('rentals')
      .insert({
        organization_id: this.ctx.organizationId,
        warehouse_id: input.warehouseId,
        borrower_user_id: input.borrowerUserId ?? null,
        borrower_name: borrowerName,
        borrower_email: input.borrowerEmail ?? null,
        expected_return_at: input.expectedReturnAt,
        notes: input.notes ?? null,
        created_by: this.ctx.userId,
        status: 'out',
      })
      .select('id')
      .single();
    if (rentalErr || !rentalRow) {
      throw new ServiceError('internal_error', rentalErr?.message ?? 'Insert failed.');
    }
    const rentalId = (rentalRow as { id: string }).id;

    // Insert lines.
    const lineRows = input.lines.map((l) => ({
      rental_id: rentalId,
      item_id: l.itemId,
      quantity: l.quantity,
      notes: l.notes ?? null,
    }));
    const { error: linesErr } = await this.ctx.supabase
      .from('rental_lines')
      .insert(lineRows);
    if (linesErr) {
      // Best-effort rollback — delete the rental header.
      await this.ctx.supabase.from('rentals').delete().eq('id', rentalId);
      throw new ServiceError('internal_error', linesErr.message);
    }

    // Insert stock_reservations so available-to-promise drops for these units.
    // stock_reservations is RLS write-locked (mig 0119 — only service-role /
    // SECURITY DEFINER paths write it, same as the order approve RPC), and the
    // row shape is (org, item, warehouse, quantity, rental_id) per mig 0263.
    const admin = createAdminClient();
    const reservationRows = input.lines.map((l) => ({
      organization_id: this.ctx.organizationId,
      item_id: l.itemId,
      warehouse_id: input.warehouseId,
      quantity: l.quantity,
      rental_id: rentalId,
    }));
    const { error: resvErr } = await admin
      .from('stock_reservations')
      .insert(reservationRows);
    if (resvErr) {
      // Fail closed. Without the reservation, available-to-promise never
      // drops (rentals reserve stock instead of decrementing on-hand), so
      // a silently-unreserved rental is over-rentable. Roll back the just-
      // created rental — rental_lines cascade-delete with it (0131:
      // rental_lines.rental_id ON DELETE CASCADE) — and throw so the
      // checkout fails loudly instead of leaving phantom availability.
      console.warn('[rentals] reservation insert failed', resvErr.message);
      await this.ctx.supabase.from('rentals').delete().eq('id', rentalId);
      throw new ServiceError('internal_error', resvErr.message);
    }

    void audit(
      {
        event: 'rental.created',
        entityType: 'rental',
        entityId: rentalId,
        extra: {
          borrower: borrowerName,
          line_count: input.lines.length,
          expected_return_at: input.expectedReturnAt,
        },
      },
      this.ctx,
    );

    // Checkout confirmation to the borrower (member or external). Awaited but
    // best-effort — the fn never throws and self-skips with no email on file;
    // awaiting (vs fire-and-forget) guarantees delivery before the serverless
    // function can be torn down after the response.
    await sendRentalCheckoutEmail(rentalId);

    return { id: rentalId };
  }

  async markReturned(input: MarkReturnedInput): Promise<void> {
    assertModuleEnabled(this.ctx, 'rentals');
    assertPermission(this.ctx, 'rentals:create');

    const { data: row } = await this.ctx.supabase
      .from('rentals')
      // warehouse_id feeds the write-access assert below — the SELECT that
      // fetched this row only needed 'read' on that warehouse.
      .select('status, expected_return_at, warehouse_id')
      .eq('id', input.id)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    if (!row) throw new ServiceError('not_found', 'Rental not found.');
    const rental = row as {
      status: RentalStatus;
      expected_return_at: string;
      warehouse_id: string;
    };
    if (rental.status !== 'out') {
      // Idempotent — no-op for already-returned/cancelled rentals.
      return;
    }

    // SP-023 / recurring pattern #4: match the app gate to the RLS floor.
    // 0131 gives rentals_select `user_can_access_warehouse(..,'read')` but
    // rentals_update `..'write'`, and 0310 grants an assigned VIEWER read
    // only. `rentals:create` is per-user grantable (configurable permissions,
    // 0207/0208), so a viewer holding it passed assertPermission, passed the
    // SELECT, and then hit a write the DB silently refused. Assert write
    // access here so that user gets an honest refusal instead.
    await this.assertRentalWriteAccess(rental.warehouse_id);

    const now = new Date();
    // Row-proof the status flip (recurring pattern #2). A 0-row UPDATE — RLS
    // refusing the write, or a concurrent return/cancel already having moved
    // it off 'out' — comes back as `error === null` with NO rows. The old
    // `if (updateErr) throw` guard read that as success and sailed on to
    // release every reservation via the SERVICE ROLE, write the audit row and
    // email the borrower "thanks for returning", while rentals.status stayed
    // 'out': availability over-stated (over-rentable) AND the overdue cron
    // kept nagging. Nothing downstream may run unless a row actually changed.
    const { data: updatedRow, error: updateErr } = await this.ctx.supabase
      .from('rentals')
      .update({
        status: 'returned',
        returned_at: now.toISOString(),
        returned_by: this.ctx.userId,
        return_notes: input.returnNotes ?? null,
      })
      .eq('id', input.id)
      .eq('organization_id', this.ctx.organizationId)
      // Optimistic claim: only the caller who moves it OFF 'out' proceeds, so
      // two simultaneous returns cannot both release + email.
      .eq('status', 'out')
      .select('id')
      .maybeSingle();
    if (updateErr) throw new ServiceError('internal_error', updateErr.message);
    if (!updatedRow) {
      throw new ServiceError(
        'forbidden',
        'Could not mark this rental returned — you may not have write access to its warehouse, or someone else just closed it.',
      );
    }

    // Release all reservations for this rental (service-role — RLS-locked).
    await createAdminClient()
      .from('stock_reservations')
      .update({ released_at: now.toISOString(), released_reason: 'rental_returned' })
      .eq('rental_id', input.id)
      .is('released_at', null);

    const expectedTime = new Date(rental.expected_return_at);
    const onTime = now.getTime() <= expectedTime.getTime();
    const daysOverdue = onTime
      ? null
      : Math.floor((now.getTime() - expectedTime.getTime()) / (24 * 60 * 60 * 1000));

    void audit(
      {
        event: 'rental.returned',
        entityType: 'rental',
        entityId: input.id,
        extra: {
          on_time: onTime,
          ...(daysOverdue !== null ? { days_overdue: daysOverdue } : {}),
        },
      },
      this.ctx,
    );

    // Return thank-you to the borrower (best-effort; self-skips with no email).
    await sendRentalReturnedEmail(input.id);
  }

  async cancel(input: CancelRentalInput): Promise<void> {
    assertModuleEnabled(this.ctx, 'rentals');
    assertPermission(this.ctx, 'rentals:manage');

    const { data: row } = await this.ctx.supabase
      .from('rentals')
      // warehouse_id feeds the write-access assert below (read ≠ write, 0131).
      .select('status, warehouse_id')
      .eq('id', input.id)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    if (!row) throw new ServiceError('not_found', 'Rental not found.');
    const rental = row as { status: RentalStatus; warehouse_id: string };
    if (rental.status !== 'out') {
      return; // Idempotent
    }

    // Same RLS floor as markReturned (SP-023) — see the comment there.
    await this.assertRentalWriteAccess(rental.warehouse_id);

    const now = new Date();
    // Row-proof the status flip — see markReturned. Without it a write RLS
    // refused still released every reservation via the service role and
    // audited a cancellation that never happened.
    const { data: updatedRow, error: updateErr } = await this.ctx.supabase
      .from('rentals')
      .update({
        status: 'cancelled',
        cancelled_at: now.toISOString(),
        cancelled_by: this.ctx.userId,
        cancellation_reason: input.reason,
      })
      .eq('id', input.id)
      .eq('organization_id', this.ctx.organizationId)
      .eq('status', 'out')
      .select('id')
      .maybeSingle();
    if (updateErr) throw new ServiceError('internal_error', updateErr.message);
    if (!updatedRow) {
      throw new ServiceError(
        'forbidden',
        'Could not cancel this rental — you may not have write access to its warehouse, or someone else just closed it.',
      );
    }

    // Release all reservations for this rental (service-role — RLS-locked).
    await createAdminClient()
      .from('stock_reservations')
      .update({ released_at: now.toISOString(), released_reason: 'rental_cancelled' })
      .eq('rental_id', input.id)
      .is('released_at', null);

    void audit(
      {
        event: 'rental.cancelled',
        entityType: 'rental',
        entityId: input.id,
        extra: { reason: input.reason },
      },
      this.ctx,
    );
  }

  /**
   * Warehouse WRITE gate for the rental status flips, translated into a
   * ServiceError. `assertWarehouseAccess` throws ForbiddenError (a different
   * class from ServiceError), which the rentals server actions would surface
   * as a generic `internal_error` — so map it here, the way cycle-counts.ts
   * does at its own warehouse asserts.
   */
  private async assertRentalWriteAccess(warehouseId: string): Promise<void> {
    try {
      await assertWarehouseAccess(warehouseId, 'write', this.ctx);
    } catch (e) {
      if (e instanceof ForbiddenError) {
        throw new ServiceError('forbidden', e.message);
      }
      throw e;
    }
  }
}
