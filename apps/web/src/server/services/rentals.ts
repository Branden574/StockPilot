import 'server-only';

import { assertWarehouseAccess, ForbiddenError } from '@/lib/auth/warehouse';
import { sendRentalCheckoutEmail, sendRentalReturnedEmail } from '@/lib/email/rentals';

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

    // ONE TRANSACTION (create_rental, migration 0361). The function locks the
    // requested items in id order, checks each against on-hand minus every
    // active hold (order holds and other rentals alike, with duplicate lines
    // for one item summed), and writes the header, the lines and the holds
    // together.
    //
    // This used to be three requests after an unlocked availability read:
    // two checkouts at once could both claim the last unit (SP-052), and a
    // failed hold insert "rolled back" by deleting the header through the
    // user client. Rentals RESERVE rather than decrement on-hand, so the hold
    // IS the availability model; it must never be missing for a rental that
    // is out. The item and availability checks live only in the function now,
    // so there is one copy of that decision (pattern #26); its refusals carry
    // the same wording the service used.
    const { data: rentalId, error: createErr } = await this.ctx.supabase.rpc('create_rental', {
      p_warehouse_id: input.warehouseId,
      p_borrower_user_id: input.borrowerUserId ?? null,
      p_borrower_name: borrowerName,
      p_borrower_email: input.borrowerEmail ?? null,
      p_expected_return_at: input.expectedReturnAt,
      p_notes: input.notes ?? null,
      p_lines: input.lines.map((l) => ({
        item_id: l.itemId,
        quantity: l.quantity,
        notes: l.notes ?? null,
      })),
    });
    if (createErr) throw rentalRpcError(createErr);
    if (typeof rentalId !== 'string' || rentalId.length === 0) {
      throw new ServiceError('internal_error', 'The rental was not created.');
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

    const { data: row, error: readErr } = await this.ctx.supabase
      .from('rentals')
      // warehouse_id feeds the write-access assert below — the SELECT that
      // fetched this row only needed 'read' on that warehouse.
      .select('status, expected_return_at, warehouse_id')
      .eq('id', input.id)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    // A failed read is not a missing rental ("Rental not found" on a blip).
    if (readErr) throw new ServiceError('internal_error', readErr.message);
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

    // One call flips it off 'out' and releases its holds (return_rental,
    // migration 0361). It locks the row, so two simultaneous returns cannot
    // both release and email: the second sees 'noop'. It used to be a user
    // UPDATE and then a service-role release, and nothing downstream may run
    // unless the status really changed (recurring pattern #2).
    const now = new Date();
    const { data: outcome, error: returnErr } = await this.ctx.supabase.rpc('return_rental', {
      p_rental_id: input.id,
      p_return_notes: input.returnNotes ?? null,
    });
    if (returnErr) throw rentalRpcError(returnErr);
    if (outcome !== 'returned') {
      throw new ServiceError(
        'forbidden',
        'Could not mark this rental returned — you may not have write access to its warehouse, or someone else just closed it.',
      );
    }

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

    const { data: row, error: readErr } = await this.ctx.supabase
      .from('rentals')
      // warehouse_id feeds the write-access assert below (read ≠ write, 0131).
      .select('status, warehouse_id')
      .eq('id', input.id)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    // Same as markReturned: a failed read is not a missing rental.
    if (readErr) throw new ServiceError('internal_error', readErr.message);
    if (!row) throw new ServiceError('not_found', 'Rental not found.');
    const rental = row as { status: RentalStatus; warehouse_id: string };
    if (rental.status !== 'out') {
      return; // Idempotent
    }

    // Same RLS floor as markReturned (SP-023) — see the comment there.
    await this.assertRentalWriteAccess(rental.warehouse_id);

    // One call: out -> cancelled and the holds released (cancel_rental,
    // migration 0361). See markReturned.
    const { data: outcome, error: cancelErr } = await this.ctx.supabase.rpc('cancel_rental', {
      p_rental_id: input.id,
      p_reason: input.reason,
    });
    if (cancelErr) throw rentalRpcError(cancelErr);
    if (outcome !== 'cancelled') {
      throw new ServiceError(
        'forbidden',
        'Could not cancel this rental — you may not have write access to its warehouse, or someone else just closed it.',
      );
    }

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

/**
 * The rental functions (migration 0361) refuse with the service's own wording
 * and mark those refusals with hint 'rental_invalid'; their gates raise short
 * tokens. Map both onto ServiceErrors.
 */
function rentalRpcError(err: { message?: string; code?: string; hint?: string | null }): ServiceError {
  const message = err.message ?? '';
  if (err.hint === 'rental_invalid') {
    return new ServiceError(err.code === 'P0002' ? 'not_found' : 'validation_error', message);
  }
  switch (message) {
    case 'forbidden':
      return new ServiceError(
        'forbidden',
        "You don't have write access to this rental's warehouse.",
      );
    case 'warehouse_not_found':
      return new ServiceError('not_found', 'Warehouse not found.');
    case 'rental_not_found':
      return new ServiceError('not_found', 'Rental not found.');
    case 'borrower_not_member':
      return new ServiceError('validation_error', 'The borrower is not a member of this organization.');
    case 'borrower_required':
      return new ServiceError('validation_error', 'Enter who is borrowing the items.');
    case 'lines_required':
    case 'lines_invalid':
      return new ServiceError('validation_error', 'Each line needs an item and a quantity from 1 to 10,000.');
    default:
      return new ServiceError('internal_error', message);
  }
}
