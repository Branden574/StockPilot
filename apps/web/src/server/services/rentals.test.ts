import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  // No-op the module gate: this suite represents a grandfathered org
  // with the rentals module on. (The dedicated gate test lives in
  // modules.gate.test.ts and exercises the real assertModuleEnabled.)
  assertModuleEnabled: vi.fn(),
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
}));
// Rental emails are best-effort side effects, not part of the service's unit
// contract — stub them so create()/markReturned() tests stay focused.
vi.mock('@/lib/email/rentals', () => ({
  sendRentalCheckoutEmail: vi.fn(async () => undefined),
  sendRentalReturnedEmail: vi.fn(async () => undefined),
}));

// Reservations are RLS write-locked, so the service writes them via the
// service-role client. The mock returns whatever makeCtx last stashed, so the
// admin client shares the same `from()` builder as ctx.supabase (same
// stock_reservations insert/update behaviour, driven by the same opts).
let lastAdminClient: unknown = null;
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => lastAdminClient,
}));

// rentals_update's RLS floor is warehouse 'write' (0131) while rentals_select
// only needs 'read', so the service asserts write access explicitly. Stubbed
// permissive by default; the refusal cases below make it throw.
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class ForbiddenError extends Error {},
}));

import { RentalsService } from './rentals';
import { audit } from './audit';
import { sendRentalReturnedEmail } from '@/lib/email/rentals';
import { assertWarehouseAccess, ForbiddenError } from '@/lib/auth/warehouse';

// ---------------------------------------------------------------------------
// Mock builder
// ---------------------------------------------------------------------------

interface MakeCtxOpts {
  /** The rental row returned by `from('rentals').select().eq().maybeSingle()` */
  rentalRow?: Record<string, unknown> | null;
  /** Error to return from rentals insert */
  rentalInsertError?: { message: string } | null;
  /** Error to return from rental_lines insert */
  linesInsertError?: { message: string } | null;
  /** Error to return from stock_reservations insert */
  reservationInsertError?: { message: string } | null;
  /** Error to return from rentals update (return/cancel) */
  rentalUpdateError?: { message: string } | null;
  /** Member full_name for borrower-name auto-fill */
  memberFullName?: string | null;
  /** inventory_items rows for is_rental validation */
  inventoryItems?: Array<{
    id: string;
    is_rental: boolean;
    warehouse_id: string;
    quantity_on_hand: number;
  }>;
  /** rows returned by from('rentals').select('*, lines:rental_lines(*)') */
  rentalListRows?: Array<Record<string, unknown>>;
  /**
   * Row the status UPDATE's `.select('id').maybeSingle()` row-proof returns.
   * `null` models an RLS-refused / no-match update (0 rows, error null) —
   * the fail-open shape that released reservations for a rental that never
   * flipped status.
   */
  updatedRentalRow?: { id: string } | null;
  /** ACTIVE (released_at IS NULL) stock_reservations for the create availability guard */
  activeReservations?: Array<{ id?: string; item_id: string; quantity: number }>;
  /**
   * Results for the rental functions (migration 0361), by name. Defaults:
   * create_rental -> 'rental-id-1', return_rental -> 'returned',
   * cancel_rental -> 'cancelled'.
   */
  rpcResults?: Record<string, { data: unknown; error: unknown }>;
}

function makeCtx(opts: MakeCtxOpts = {}) {
  const insertedRentalId = 'rental-id-1';
  // Tracks rollback: which rental ids were deleted via .delete().eq('id', x).
  const deletedRentalIds: string[] = [];
  // Tracks the service-role reservation release: which rental_ids were released.
  const releasedRentalIds: string[] = [];
  // SP-094: the full record of each service-role reservation release — the
  // patch AND both filters. `releasedRentalIds` alone only proves *something*
  // was released; the release tests need to prove WHAT and BY WHICH COLUMN.
  const reservationReleases: Array<{
    patch: Record<string, unknown>;
    eq: [string, string];
    is: [string, unknown];
  }> = [];
  // Counts rentals-header inserts, so a refusal can assert nothing was written.
  const rentalInsertCalls: unknown[] = [];
  // Every rpc(name, args) call, in order.
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcDefaults: Record<string, { data: unknown; error: unknown }> = {
    create_rental: { data: insertedRentalId, error: null },
    return_rental: { data: 'returned', error: null },
    cancel_rental: { data: 'cancelled', error: null },
  };

  const supabase = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      const result = opts.rpcResults?.[name] ?? rpcDefaults[name];
      if (!result) throw new Error(`[rentals.test] unexpected rpc: ${name}`);
      return Promise.resolve(result);
    },
    from(table: string) {
      // ----------------------------------------------------------------
      // rentals table
      // ----------------------------------------------------------------
      if (table === 'rentals') {
        return {
          // Unified chainable builder for rentals. Every filter method
          // returns `self` so callers can chain arbitrarily many `.eq()`,
          // `.lt()`, `.is()`, `.order()`, `.limit()` calls before awaiting.
          select(cols: string) {
            const isListQuery = cols.includes('lines:rental_lines');

            // A single chainable object that is also thenable (Promise-like).
            // This lets the service do:
            //   await query (resolves immediately with list data), OR
            //   await query.maybeSingle() (resolves with a single row).
            const chain: Record<string, unknown> = {};

            const self: Record<string, unknown> = {
              eq: (_c: string, _v: unknown) => self,
              lt: (_c: string, _v: unknown) => self,
              is: (_c: string, _v: unknown) => self,
              order: (_c: string, _o?: unknown) => self,
              limit: (_n: number) => self,
              // Thenable: resolves when awaited directly (list path)
              then: (
                resolve: (v: { data: unknown[]; error: null }) => unknown,
                _reject?: unknown,
              ) =>
                Promise.resolve({
                  data: isListQuery ? (opts.rentalListRows ?? []) : [],
                  error: null,
                }).then(resolve),
              // Explicit await target for single-row selects
              maybeSingle: async () => ({
                data: opts.rentalRow ?? null,
                error: null,
              }),
            };

            // Copy self into chain so callers can destructure {data, error}
            Object.assign(chain, self);
            return self;
          },
          // insert chain: .insert({...}).select('id').single()
          insert(row: unknown) {
            rentalInsertCalls.push(row);
            return {
              select(_cols: string) {
                return {
                  single: async () => ({
                    data: opts.rentalInsertError ? null : { id: insertedRentalId },
                    error: opts.rentalInsertError ?? null,
                  }),
                };
              },
            };
          },
          // update chain: .update({...}).eq(...)…[.select('id').maybeSingle()]
          // `then` is kept so the OLD (row-proof-less) shape still resolves —
          // that way the regression test below fails against unfixed code for
          // the right reason (fail-open success) rather than a mock TypeError.
          update(_patch: unknown) {
            const self: Record<string, unknown> = {
              eq: (_col: string, _val: unknown) => self,
              select: (_cols: string) => ({
                maybeSingle: async () => ({
                  data: opts.rentalUpdateError
                    ? null
                    : opts.updatedRentalRow !== undefined
                      ? opts.updatedRentalRow
                      : { id: 'rental-id-1' },
                  error: opts.rentalUpdateError ?? null,
                }),
              }),
              then: (
                resolve: (v: { error: unknown }) => unknown,
                _reject?: unknown,
              ) => Promise.resolve({ error: opts.rentalUpdateError ?? null }).then(resolve),
            };
            return self;
          },
          // delete chain (rollback): .delete().eq('id', id)
          delete() {
            return {
              eq(_col: string, val: string) {
                deletedRentalIds.push(val);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }

      // ----------------------------------------------------------------
      // rental_lines table
      // ----------------------------------------------------------------
      if (table === 'rental_lines') {
        return {
          insert(_rows: unknown) {
            return Promise.resolve({ error: opts.linesInsertError ?? null });
          },
        };
      }

      // ----------------------------------------------------------------
      // stock_reservations table
      // ----------------------------------------------------------------
      if (table === 'stock_reservations') {
        return {
          insert(_rows: unknown) {
            return Promise.resolve({ error: opts.reservationInsertError ?? null });
          },
          // Availability read (create): .select().eq().in().is().order().range()
          // — paginated via fetchAllRows, so the window is a thenable.
          select(_cols: string) {
            const self: Record<string, unknown> = {
              eq: (_c: string, _v: unknown) => self,
              in: (_c: string, _v: unknown) => self,
              is: (_c: string, _v: unknown) => self,
              order: (_c: string, _o?: unknown) => self,
              range: (_from: number, _to: number) => self,
              then: (
                resolve: (v: { data: unknown[]; error: null }) => unknown,
                _reject?: unknown,
              ) =>
                Promise.resolve({
                  data: (opts.activeReservations ?? []).map((r, i) => ({
                    id: r.id ?? `resv-${i}`,
                    item_id: r.item_id,
                    quantity: r.quantity,
                  })),
                  error: null,
                }).then(resolve),
            };
            return self;
          },
          // Release chain: .update({...}).eq('rental_id', id).is('released_at', null)
          //
          // SP-094: this stub used to throw away every argument, so the two
          // 'releases all stock_reservations for this rental' tests could
          // only assert `expect(true).toBe(true)`. Deleting the release
          // block outright — or filtering it on `id` instead of `rental_id`,
          // which matches nothing — left both tests green while returned and
          // cancelled rentals kept their reservations forever: available-to-
          // promise stays depressed and order approval refuses stock that is
          // physically on the shelf. Record patch + both filters so the
          // assertions below can actually see a regression.
          update(patch: Record<string, unknown>) {
            return {
              eq(col: string, val: string) {
                releasedRentalIds.push(val);
                return {
                  is(col2: string, val2: unknown) {
                    reservationReleases.push({
                      patch,
                      eq: [col, val],
                      is: [col2, val2],
                    });
                    return Promise.resolve({ error: null });
                  },
                };
              },
            };
          },
        };
      }

      // ----------------------------------------------------------------
      // organization_members table — borrower name auto-fill
      // ----------------------------------------------------------------
      if (table === 'organization_members') {
        return {
          select(_cols: string) {
            return {
              eq(_col: string, _val: string) {
                return {
                  eq(_col2: string, _val2: string) {
                    return {
                      maybeSingle: async () => ({
                        data:
                          opts.memberFullName !== undefined
                            ? {
                                user: { full_name: opts.memberFullName },
                              }
                            : null,
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      }

      // ----------------------------------------------------------------
      // inventory_items table — is_rental validation
      // ----------------------------------------------------------------
      if (table === 'inventory_items') {
        return {
          // .select().eq().in().order().range() — batched and paged through
          // fetchAllRowsByIds, so the window is a thenable.
          select(_cols: string) {
            const self: Record<string, unknown> = {
              eq: (_c: string, _v: unknown) => self,
              in: (_c: string, _v: unknown) => self,
              order: (_c: string, _o?: unknown) => self,
              range: (_from: number, _to: number) => self,
              then: (
                resolve: (v: { data: unknown[]; error: null }) => unknown,
                _reject?: unknown,
              ) => Promise.resolve({ data: opts.inventoryItems ?? [], error: null }).then(resolve),
            };
            return self;
          },
        };
      }

      throw new Error(`[rentals.test] unexpected table: ${table}`);
    },
  } as unknown;

  // The service-role client shares this same mock (see the '@/lib/supabase/admin'
  // mock above), so reservation writes hit the same stock_reservations builder.
  lastAdminClient = supabase;

  return {
    ctx: {
      supabase,
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'manager',
      mfaRequired: false,
      mfaSatisfied: true,
    } as unknown as ConstructorParameters<typeof RentalsService>[0],
    insertedRentalId,
    deletedRentalIds,
    releasedRentalIds,
    reservationReleases,
    rentalInsertCalls,
    rpcCalls,
  };
}

// ---------------------------------------------------------------------------
// Shared valid create input
// ---------------------------------------------------------------------------
const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const validCreateInput = {
  warehouseId: '00000000-0000-0000-0000-000000000099',
  borrowerName: 'Jane Doe',
  borrowerUserId: null,
  expectedReturnAt: futureDate,
  notes: null,
  lines: [
    {
      itemId: '00000000-0000-0000-0000-000000000001',
      quantity: 2,
      notes: null,
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RentalsService.create', () => {
  beforeEach(() => vi.clearAllMocks());

  // Header, lines and holds are written by ONE call to create_rental
  // (migration 0361), never by the service's own inserts. Its atomicity and
  // locking are proven in pgTAP 0361 (5-7, 17-18).
  it('creates rental + lines + reservations atomically', async () => {
    const { ctx, insertedRentalId, rpcCalls, rentalInsertCalls, releasedRentalIds } = makeCtx();
    const svc = new RentalsService(ctx);
    const result = await svc.create(validCreateInput);
    expect(result.id).toBe(insertedRentalId);
    expect(rpcCalls).toEqual([
      {
        name: 'create_rental',
        args: {
          p_warehouse_id: validCreateInput.warehouseId,
          p_borrower_user_id: null,
          p_borrower_name: 'Jane Doe',
          p_borrower_email: null,
          p_expected_return_at: futureDate,
          p_notes: null,
          p_lines: [{ item_id: '00000000-0000-0000-0000-000000000001', quantity: 2, notes: null }],
        },
      },
    ]);
    expect(rentalInsertCalls).toHaveLength(0);
    expect(releasedRentalIds).toHaveLength(0);
  });

  it('auto-fills borrower_name from member display name when borrowerUserId is set', async () => {
    const { ctx, rpcCalls } = makeCtx({ memberFullName: 'Alice Smith' });
    const svc = new RentalsService(ctx);
    // We test this indirectly: if the member name lookup returns 'Alice Smith'
    // the service must NOT throw and should use that name (it's stored in DB,
    // which we confirm via audit event extra).
    const result = await svc.create({
      ...validCreateInput,
      borrowerUserId: '00000000-0000-0000-0000-000000000050',
      borrowerName: 'Fallback Name',
    });
    expect(result.id).toBeDefined();
    // Verify audit was called with the resolved member name
    const auditMock = vi.mocked(audit);
    expect(auditMock).toHaveBeenCalledOnce();
    const auditCall = auditMock.mock.calls[0]![0];
    expect(auditCall.extra?.borrower).toBe('Alice Smith');
    expect(rpcCalls[0]!.args.p_borrower_name).toBe('Alice Smith');
  });

  it('keeps the provided borrowerName when borrowerUserId is null', async () => {
    const { ctx } = makeCtx();
    const svc = new RentalsService(ctx);
    await svc.create({ ...validCreateInput, borrowerUserId: null, borrowerName: 'External Guy' });
    const auditMock = vi.mocked(audit);
    const auditCall = auditMock.mock.calls[0]![0];
    expect(auditCall.extra?.borrower).toBe('External Guy');
  });

  it('emits rental.created audit event', async () => {
    const { ctx } = makeCtx();
    const svc = new RentalsService(ctx);
    await svc.create(validCreateInput);
    const auditMock = vi.mocked(audit);
    expect(auditMock).toHaveBeenCalledOnce();
    const [payload] = auditMock.mock.calls[0]!;
    expect(payload.event).toBe('rental.created');
    expect(payload.entityType).toBe('rental');
    expect(payload.extra?.line_count).toBe(1);
  });

  // The database rolls a failed checkout back as a whole (pgTAP 0361 17-18);
  // the service must not try its own user-client rollback, and must not
  // audit or email a checkout that did not happen.
  it('fails closed when the checkout function errors — no rollback of its own, no audit', async () => {
    const { ctx, deletedRentalIds } = makeCtx({
      rpcResults: { create_rental: { data: null, error: { message: 'reservation boom' } } },
    });
    const svc = new RentalsService(ctx);
    await expect(svc.create(validCreateInput)).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(deletedRentalIds).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  // SP-052: v1 shipped `// TODO availability check — for v1 we trust the picker
  // UI's filter`, but the picker's '+' caps at quantity_on_hand and ignores
  // reservations, so 5 on hand with 3 already rented out accepted 5 MORE —
  // 8 units reserved against 5 physical ones, two borrowers holding the same
  // stock. The check now lives in create_rental, which counts ACTIVE holds
  // with the items locked (pgTAP 0361 8, 19); the service surfaces its
  // refusal, wording included.
  it('refuses a line that exceeds availability once active reservations are counted', async () => {
    const refusal =
      'Projector: only 2 available to rent (5 on hand, 3 already reserved) — 5 requested.';
    const { ctx, rentalInsertCalls, deletedRentalIds } = makeCtx({
      rpcResults: {
        create_rental: {
          data: null,
          error: { message: refusal, code: '22023', hint: 'rental_invalid' },
        },
      },
    });
    const svc = new RentalsService(ctx);
    await expect(
      svc.create({
        ...validCreateInput,
        lines: [
          { itemId: '00000000-0000-0000-0000-000000000001', quantity: 5, notes: null },
        ],
      }),
    ).rejects.toMatchObject({ code: 'validation_error', message: refusal });
    expect(rentalInsertCalls).toHaveLength(0);
    expect(deletedRentalIds).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('allows a line that fits the remaining availability', async () => {
    const { ctx } = makeCtx();
    const svc = new RentalsService(ctx);
    await expect(
      svc.create({
        ...validCreateInput,
        lines: [
          { itemId: '00000000-0000-0000-0000-000000000001', quantity: 2, notes: null },
        ],
      }),
    ).resolves.toMatchObject({ id: 'rental-id-1' });
  });

  // create_rental sums duplicate lines for one item against one pool (pgTAP
  // 0361 19). The service must pass them through as sent — merging or
  // dropping one here would under-reserve.
  it('sums duplicate lines for the same item against one availability pool', async () => {
    const { ctx, rpcCalls } = makeCtx();
    const svc = new RentalsService(ctx);
    await svc.create({
      ...validCreateInput,
      lines: [
        { itemId: '00000000-0000-0000-0000-000000000001', quantity: 3, notes: null },
        { itemId: '00000000-0000-0000-0000-000000000001', quantity: 3, notes: null },
      ],
    });
    expect(rpcCalls[0]!.args.p_lines).toEqual([
      { item_id: '00000000-0000-0000-0000-000000000001', quantity: 3, notes: null },
      { item_id: '00000000-0000-0000-0000-000000000001', quantity: 3, notes: null },
    ]);
  });

  it('rejects items that are not rental items', async () => {
    const { ctx } = makeCtx({
      rpcResults: {
        create_rental: {
          data: null,
          error: {
            message: 'One or more items are not rental items.',
            code: '22023',
            hint: 'rental_invalid',
          },
        },
      },
    });
    const svc = new RentalsService(ctx);
    await expect(svc.create(validCreateInput)).rejects.toMatchObject({
      code: 'validation_error',
      message: 'One or more items are not rental items.',
    });
  });

  it('maps an item the function cannot find to not_found', async () => {
    const { ctx } = makeCtx({
      rpcResults: {
        create_rental: {
          data: null,
          error: { message: 'One or more items were not found.', code: 'P0002', hint: 'rental_invalid' },
        },
      },
    });
    const svc = new RentalsService(ctx);
    await expect(svc.create(validCreateInput)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('RentalsService.markReturned', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flips status to returned, sets returned_at and returned_by', async () => {
    const { ctx, rpcCalls } = makeCtx({
      rentalRow: { status: 'out', expected_return_at: futureDate },
    });
    const svc = new RentalsService(ctx);
    await expect(
      svc.markReturned({ id: 'rental-id-1', returnNotes: 'scratched lid' }),
    ).resolves.toBeUndefined();
    // return_rental (0361) stamps status, returned_at and returned_by itself.
    expect(rpcCalls).toEqual([
      { name: 'return_rental', args: { p_rental_id: 'rental-id-1', p_return_notes: 'scratched lid' } },
    ]);
  });

  // SP-094 pinned the service-role release (patch AND filters) because a
  // returned rental that keeps its holds depresses available-to-promise
  // forever. The release now happens inside return_rental, in the same
  // transaction as the status flip (pgTAP 0361 22). Pin that the service no
  // longer writes holds itself: a second, service-role release could only
  // run against a rental whose status did not change.
  it('releases all stock_reservations for this rental', async () => {
    const { ctx, reservationReleases, rpcCalls } = makeCtx({
      rentalRow: { status: 'out', expected_return_at: futureDate },
    });
    const svc = new RentalsService(ctx);
    await svc.markReturned({ id: 'rental-id-1' });
    expect(rpcCalls.map((c) => c.name)).toEqual(['return_rental']);
    expect(reservationReleases).toHaveLength(0);
  });

  // SP-023: the status UPDATE used to be `.eq('id', …)` with only an error
  // guard. RLS refusing the write (rentals_update needs warehouse 'write';
  // rentals_select only 'read') returns 0 rows and error null — so the service
  // sailed on and released every reservation via the SERVICE ROLE, audited the
  // return and emailed the borrower while rentals.status stayed 'out'.
  // return_rental answers 'noop' when the rental is no longer out (someone
  // else closed it first); nothing downstream may run.
  it('refuses when the status UPDATE matches no row — releases nothing, no audit, no email', async () => {
    const { ctx, releasedRentalIds } = makeCtx({
      rentalRow: {
        status: 'out',
        expected_return_at: futureDate,
        warehouse_id: '00000000-0000-0000-0000-000000000099',
      },
      rpcResults: { return_rental: { data: 'noop', error: null } },
    });
    const svc = new RentalsService(ctx);
    await expect(svc.markReturned({ id: 'rental-id-1' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(releasedRentalIds).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(vi.mocked(sendRentalReturnedEmail)).not.toHaveBeenCalled();
  });

  it("asserts WRITE access to the rental's warehouse before touching anything", async () => {
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(
      new ForbiddenError('Read-only auditor cannot perform write operations.'),
    );
    const { ctx, releasedRentalIds, rpcCalls } = makeCtx({
      rentalRow: {
        status: 'out',
        expected_return_at: futureDate,
        warehouse_id: '00000000-0000-0000-0000-000000000099',
      },
    });
    const svc = new RentalsService(ctx);
    await expect(svc.markReturned({ id: 'rental-id-1' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(rpcCalls).toHaveLength(0);
    expect(vi.mocked(assertWarehouseAccess)).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000099',
      'write',
      ctx,
    );
    expect(releasedRentalIds).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('is idempotent — already-returned rental returns silently', async () => {
    const { ctx, rpcCalls } = makeCtx({
      rentalRow: { status: 'returned', expected_return_at: futureDate },
    });
    const svc = new RentalsService(ctx);
    await expect(svc.markReturned({ id: 'rental-id-1' })).resolves.toBeUndefined();
    expect(rpcCalls).toHaveLength(0);
    // No audit event emitted for no-op
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('emits rental.returned audit event with on_time flag', async () => {
    const pastDue = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const { ctx } = makeCtx({
      rentalRow: { status: 'out', expected_return_at: pastDue },
    });
    const svc = new RentalsService(ctx);
    await svc.markReturned({ id: 'rental-id-1' });
    const auditMock = vi.mocked(audit);
    expect(auditMock).toHaveBeenCalledOnce();
    const [payload] = auditMock.mock.calls[0]!;
    expect(payload.event).toBe('rental.returned');
    expect(payload.extra?.on_time).toBe(false);
    expect(typeof payload.extra?.days_overdue).toBe('number');
  });
});

describe('RentalsService.cancel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires rentals:manage permission', async () => {
    const { assertPermission } = await import('./context');
    const { ctx } = makeCtx({
      rentalRow: { status: 'out' },
    });
    const svc = new RentalsService(ctx);
    await svc.cancel({ id: 'rental-id-1', reason: 'Changed mind' });
    expect(vi.mocked(assertPermission)).toHaveBeenCalledWith(ctx, 'rentals:manage');
  });

  it('flips status to cancelled, stores reason, sets cancelled_at and cancelled_by', async () => {
    const { ctx, rpcCalls } = makeCtx({
      rentalRow: { status: 'out' },
    });
    const svc = new RentalsService(ctx);
    await expect(
      svc.cancel({ id: 'rental-id-1', reason: 'No longer needed' }),
    ).resolves.toBeUndefined();
    expect(rpcCalls).toEqual([
      { name: 'cancel_rental', args: { p_rental_id: 'rental-id-1', p_reason: 'No longer needed' } },
    ]);
  });

  // SP-094, cancel twin: the release happens inside cancel_rental, with the
  // status flip (pgTAP 0361 28); the service writes no holds itself.
  it('releases all stock_reservations for this rental', async () => {
    const { ctx, reservationReleases, rpcCalls } = makeCtx({
      rentalRow: { status: 'out' },
    });
    const svc = new RentalsService(ctx);
    await svc.cancel({ id: 'rental-id-1', reason: 'Test reason' });
    expect(rpcCalls.map((c) => c.name)).toEqual(['cancel_rental']);
    expect(reservationReleases).toHaveLength(0);
  });

  // Same fail-open shape as markReturned (SP-023).
  it('refuses when the status UPDATE matches no row — releases nothing, no audit', async () => {
    const { ctx, releasedRentalIds } = makeCtx({
      rentalRow: { status: 'out', warehouse_id: '00000000-0000-0000-0000-000000000099' },
      rpcResults: { cancel_rental: { data: 'noop', error: null } },
    });
    const svc = new RentalsService(ctx);
    await expect(
      svc.cancel({ id: 'rental-id-1', reason: 'Changed mind' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(releasedRentalIds).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('emits rental.cancelled audit event with reason', async () => {
    const { ctx } = makeCtx({
      rentalRow: { status: 'out' },
    });
    const svc = new RentalsService(ctx);
    await svc.cancel({ id: 'rental-id-1', reason: 'Budget cut' });
    const auditMock = vi.mocked(audit);
    expect(auditMock).toHaveBeenCalledOnce();
    const [payload] = auditMock.mock.calls[0]!;
    expect(payload.event).toBe('rental.cancelled');
    expect(payload.extra?.reason).toBe('Budget cut');
  });
});

describe('RentalsService.list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('filters by status when provided', async () => {
    const outRental = { id: 'r1', status: 'out', lines: [] };
    const { ctx } = makeCtx({ rentalListRows: [outRental] });
    const svc = new RentalsService(ctx);
    const { rentals } = await svc.list({ status: 'out' });
    expect(rentals).toHaveLength(1);
    expect(rentals[0]?.status).toBe('out');
  });

  it('returns all statuses when status filter omitted', async () => {
    const rows = [
      { id: 'r1', status: 'out', lines: [] },
      { id: 'r2', status: 'returned', lines: [] },
    ];
    const { ctx } = makeCtx({ rentalListRows: rows });
    const svc = new RentalsService(ctx);
    const { rentals } = await svc.list();
    expect(rentals).toHaveLength(2);
  });
});
