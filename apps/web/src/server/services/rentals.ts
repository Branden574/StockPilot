import 'server-only';

import { audit } from './audit';
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
      .select('id, is_rental, warehouse_id, quantity_on_hand')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', itemIds);
    const itemsById = new Map(
      (
        (rentalItems ?? []) as Array<{
          id: string;
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

    // TODO availability check — for v1 we trust the picker UI's filter.
    // Defense in depth could query stock_reservations + subtract here.

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

    // Insert stock_reservations so the order picker subtracts them.
    const reservationRows = input.lines.map((l) => ({
      organization_id: this.ctx.organizationId,
      item_id: l.itemId,
      quantity: l.quantity,
      reference_type: 'rental',
      reference_id: rentalId,
    }));
    const { error: resvErr } = await this.ctx.supabase
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

    return { id: rentalId };
  }

  async markReturned(input: MarkReturnedInput): Promise<void> {
    assertModuleEnabled(this.ctx, 'rentals');
    assertPermission(this.ctx, 'rentals:create');

    const { data: row } = await this.ctx.supabase
      .from('rentals')
      .select('status, expected_return_at')
      .eq('id', input.id)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    if (!row) throw new ServiceError('not_found', 'Rental not found.');
    const rental = row as { status: RentalStatus; expected_return_at: string };
    if (rental.status !== 'out') {
      // Idempotent — no-op for already-returned/cancelled rentals.
      return;
    }

    const now = new Date();
    const { error: updateErr } = await this.ctx.supabase
      .from('rentals')
      .update({
        status: 'returned',
        returned_at: now.toISOString(),
        returned_by: this.ctx.userId,
        return_notes: input.returnNotes ?? null,
      })
      .eq('id', input.id);
    if (updateErr) throw new ServiceError('internal_error', updateErr.message);

    // Release all reservations.
    await this.ctx.supabase
      .from('stock_reservations')
      .update({ released_at: now.toISOString() })
      .eq('reference_type', 'rental')
      .eq('reference_id', input.id)
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
  }

  async cancel(input: CancelRentalInput): Promise<void> {
    assertModuleEnabled(this.ctx, 'rentals');
    assertPermission(this.ctx, 'rentals:manage');

    const { data: row } = await this.ctx.supabase
      .from('rentals')
      .select('status')
      .eq('id', input.id)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    if (!row) throw new ServiceError('not_found', 'Rental not found.');
    if ((row as { status: RentalStatus }).status !== 'out') {
      return; // Idempotent
    }

    const now = new Date();
    const { error: updateErr } = await this.ctx.supabase
      .from('rentals')
      .update({
        status: 'cancelled',
        cancelled_at: now.toISOString(),
        cancelled_by: this.ctx.userId,
        cancellation_reason: input.reason,
      })
      .eq('id', input.id);
    if (updateErr) throw new ServiceError('internal_error', updateErr.message);

    // Release all reservations.
    await this.ctx.supabase
      .from('stock_reservations')
      .update({ released_at: now.toISOString() })
      .eq('reference_type', 'rental')
      .eq('reference_id', input.id)
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
}
