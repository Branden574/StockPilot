import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));

vi.mock('./item-images', () => ({
  ItemImagesService: class {
    async primaryImagesForItems() {
      return new Map<string, string>();
    }
  },
}));

import { RecurringPoTemplatesService, recurringRunNotice, type RecurringRunSummary } from './recurring-pos';

const NOW = new Date('2026-06-18T07:00:00.000Z');
const DUE_AT = new Date('2026-06-18T06:00:00.000Z'); // before NOW → due
const FUTURE_AT = new Date('2026-06-19T07:00:00.000Z'); // after NOW → not due

const TEMPLATE_BASE = {
  id: 'tpl-1',
  organization_id: 'org-test',
  supplier_id: 'sup-1',
  destination_location_id: null,
  name: 'Weekly Supplies',
  enabled: true,
  cadence: 'weekly' as const,
  custom_days: null,
  send_mode: 'draft' as const,
  max_auto_send_cents: null,
  line_items: [{ itemId: 'item-1', quantityOrdered: 5, unitCost: 10 }],
  notes: null,
  last_run_at: null,
  next_run_at: DUE_AT.toISOString(),
  created_by: 'user-test',
  updated_by: 'user-test',
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
};

/** The orderable-items read answering that item-1 may still be ordered. */
const ORDERABLE_ITEM_1 = { data: [{ id: 'item-1' }], error: null };

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────
// runDueTemplates
// ─────────────────────────────────────────────────────────────────

describe('RecurringPoTemplatesService.runDueTemplates', () => {
  it('draft mode: creates PO as draft, advances next_run_at, stamps last_run_at', async () => {
    const template = { ...TEMPLATE_BASE, send_mode: 'draft' as const };
    const stub = makeSupabaseStub({
      // fetchAllRows issues two selects on recurring_po_templates — first page has data, second is empty
      'recurring_po_templates.select': { data: [template], error: null },
      // The template's items are still orderable (not deleted, not a kit).
      'inventory_items.select': ORDERABLE_ITEM_1,
      'rpc:save_purchase_order_draft': { data: { id: 'po-new', stamped: 0, stamp_error: null }, error: null },
      'purchase_orders.update': { data: { id: 'po-new' }, error: null },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      // supplier_id 'sup-1' is in-org — assertSupplierInOrg must find it
      'suppliers.select': { data: { id: 'sup-1' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);
    const result = await svc.runDueTemplates(NOW);

    expect(result.created).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.heldForReview).toBe(0);
    expect(result.failures).toBe(0);
    // Schedule must have advanced (update call happened)
    expect(stub.chainsAll.get('recurring_po_templates.update')).toBeDefined();
    // The PO is saved in one call; the cron's actor rides along as p_actor so
    // a service-role save keeps its created_by (auth.uid() is null there).
    const save = stub.rpcCalls.find((c) => c.name === 'save_purchase_order_draft');
    expect(save?.args).toMatchObject({ p_po_id: null, p_actor: 'user-test', p_supplier_id: 'sup-1' });
  });

  it('send mode within cap and approval threshold: auto-sends the PO', async () => {
    const template = {
      ...TEMPLATE_BASE,
      send_mode: 'send' as const,
      max_auto_send_cents: 20000, // $200 cap
      // total = 5 * 10 = $50
    };
    const stub = makeSupabaseStub({
      'recurring_po_templates.select': { data: [template], error: null },
      // The template's items are still orderable (not deleted, not a kit).
      'inventory_items.select': ORDERABLE_ITEM_1,
      'rpc:save_purchase_order_draft': { data: { id: 'po-new', stamped: 0, stamp_error: null }, error: null },
      // updateStatus reads the PO first, then updates it
      'purchase_orders.select': {
        data: { id: 'po-new', po_number: 'PO-100', status: 'draft', total: 50, destination: null },
        error: null,
      },
      'purchase_orders.update': { data: { id: 'po-new' }, error: null },
      'purchase_order_items.select': { data: [], error: null },
      // module settings read for approval threshold — threshold = $500 (above $50 total)
      'organization_modules.select': {
        data: { settings: { approvalThresholdAmount: 500 } },
        error: null,
      },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      'rpc:publish_outbox': { data: null, error: null },
      // supplier_id 'sup-1' is in-org — assertSupplierInOrg must find it
      'suppliers.select': { data: { id: 'sup-1' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);
    const result = await svc.runDueTemplates(NOW);

    expect(result.created).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.heldForReview).toBe(0);
    expect(result.failures).toBe(0);
  });

  it('send mode over cap: holds as draft', async () => {
    const template = {
      ...TEMPLATE_BASE,
      send_mode: 'send' as const,
      max_auto_send_cents: 1000, // $10 cap — total $50 is over cap
    };
    const stub = makeSupabaseStub({
      'recurring_po_templates.select': { data: [template], error: null },
      // The template's items are still orderable (not deleted, not a kit).
      'inventory_items.select': ORDERABLE_ITEM_1,
      'rpc:save_purchase_order_draft': { data: { id: 'po-new', stamped: 0, stamp_error: null }, error: null },
      'organization_modules.select': {
        data: { settings: { approvalThresholdAmount: 500 } },
        error: null,
      },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      'suppliers.select': { data: { id: 'sup-1' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);
    const result = await svc.runDueTemplates(NOW);

    expect(result.created).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.heldForReview).toBe(1);
    // PO status update to 'ordered' should NOT have been called for this PO
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
  });

  it('send mode at/over approval threshold: holds as draft', async () => {
    const template = {
      ...TEMPLATE_BASE,
      send_mode: 'send' as const,
      max_auto_send_cents: 20000, // $200 cap — total $50 is under cap
      // but approval threshold = $30, total $50 >= $30 → hold
    };
    const stub = makeSupabaseStub({
      'recurring_po_templates.select': { data: [template], error: null },
      // The template's items are still orderable (not deleted, not a kit).
      'inventory_items.select': ORDERABLE_ITEM_1,
      'rpc:save_purchase_order_draft': { data: { id: 'po-new', stamped: 0, stamp_error: null }, error: null },
      'organization_modules.select': {
        data: { settings: { approvalThresholdAmount: 30 } },
        error: null,
      },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      'suppliers.select': { data: { id: 'sup-1' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);
    const result = await svc.runDueTemplates(NOW);

    expect(result.created).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.heldForReview).toBe(1);
  });

  it('approval-threshold read failure: holds as draft (fail-closed)', async () => {
    const template = {
      ...TEMPLATE_BASE,
      send_mode: 'send' as const,
      max_auto_send_cents: 20000,
    };
    const stub = makeSupabaseStub({
      'recurring_po_templates.select': { data: [template], error: null },
      // The template's items are still orderable (not deleted, not a kit).
      'inventory_items.select': ORDERABLE_ITEM_1,
      'rpc:save_purchase_order_draft': { data: { id: 'po-new', stamped: 0, stamp_error: null }, error: null },
      'organization_modules.select': { data: null, error: { message: 'DB error' } },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      'suppliers.select': { data: { id: 'sup-1' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);
    const result = await svc.runDueTemplates(NOW);

    expect(result.created).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.heldForReview).toBe(1);
    // No status update to 'ordered'
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
  });

  it('not-yet-due template: skipped, not created, schedule unchanged', async () => {
    // FUTURE_AT is after NOW — the DB query filters it out (next_run_at <= now).
    // We stub the select to return empty (as the real DB would) to verify no PO is created.
    void FUTURE_AT; // referenced for documentation only; not used in stub
    const stub = makeSupabaseStub({
      // The query filters next_run_at <= now, so this template never comes back
      'recurring_po_templates.select': { data: [], error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);
    const result = await svc.runDueTemplates(NOW);

    expect(result.created).toBe(0);
    expect(result.sent).toBe(0);
    expect(result.heldForReview).toBe(0);
    expect(result.failures).toBe(0);
    // No template update — schedule unchanged
    expect(stub.chainsAll.get('recurring_po_templates.update')).toBeUndefined();
    // No PO created
    expect(stub.fromCalls.includes('purchase_orders')).toBe(false);
  });

  it('lost claim: a template whose conditional advance matches 0 rows is skipped without creating a PO', async () => {
    // Two invocations of the runner overlapped (an operator hit the cron route
    // manually, or Vercel retried, while the daily run was still going). The
    // OTHER invocation already advanced this template, so our conditional claim
    // -- .eq('next_run_at', <the value we read>) -- matches 0 rows. That means
    // "someone else owns this period": skip silently and, above all, do NOT
    // create (or auto-send) a second PO for it.
    const template = {
      ...TEMPLATE_BASE,
      send_mode: 'send' as const,
      max_auto_send_cents: 20000,
    };
    const stub = makeSupabaseStub({
      'recurring_po_templates.select': { data: [template], error: null },
      // The template's items are still orderable (not deleted, not a kit).
      'inventory_items.select': ORDERABLE_ITEM_1,
      // 0 rows matched — another invocation already advanced the schedule.
      'recurring_po_templates.update': { data: null, error: null },
      'rpc:save_purchase_order_draft': { data: { id: 'po-new', stamped: 0, stamp_error: null }, error: null },
      'organization_modules.select': {
        data: { settings: { approvalThresholdAmount: 500 } },
        error: null,
      },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      'suppliers.select': { data: { id: 'sup-1' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);
    const result = await svc.runDueTemplates(NOW);

    expect(result.created).toBe(0);
    expect(result.sent).toBe(0);
    expect(result.heldForReview).toBe(0);
    // A lost claim is not an error — the other invocation is doing the work.
    expect(result.failures).toBe(0);
    // Nothing was even attempted against purchase_orders.
    expect(stub.fromCalls.includes('purchase_orders')).toBe(false);

    // The claim MUST carry the next_run_at predicate — without it the update
    // matches unconditionally and both invocations sail past it.
    const claimChain = stub.chainsAll.get('recurring_po_templates.update')?.[0] ?? [];
    const claimArgs = stub.chainArgsAll.get('recurring_po_templates.update')?.[0] ?? [];
    const eqFilters = claimChain
      .map((method, idx) => ({ method, args: claimArgs[idx] }))
      .filter((c) => c.method === 'eq')
      .map((c) => c.args);
    expect(eqFilters).toContainEqual(['next_run_at', TEMPLATE_BASE.next_run_at]);
  });

  it('claim failure: schedule advance errors before create — no PO, surfaced as a failure', async () => {
    // Previously the PO was created FIRST and a failed advance was merely
    // counted; that left a real PO behind that the next run would re-create.
    // Now the claim comes first: if it errors we cannot guarantee at-most-once,
    // so we create nothing and report the failure for the cron summary.
    const template = { ...TEMPLATE_BASE, send_mode: 'draft' as const };
    const stub = makeSupabaseStub({
      'recurring_po_templates.select': { data: [template], error: null },
      // The template's items are still orderable (not deleted, not a kit).
      'inventory_items.select': ORDERABLE_ITEM_1,
      'recurring_po_templates.update': { data: null, error: { message: 'advance failed' } },
      'rpc:save_purchase_order_draft': { data: { id: 'po-new', stamped: 0, stamp_error: null }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      'suppliers.select': { data: { id: 'sup-1' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);
    const result = await svc.runDueTemplates(NOW);

    expect(result.created).toBe(0);
    expect(result.failures).toBe(1);
    expect(stub.fromCalls.includes('purchase_orders')).toBe(false);
  });

  it('seedFromPo copies supplier_id and line items from an existing PO', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.select': {
        data: {
          id: 'po-src',
          organization_id: 'org-test',
          supplier_id: 'sup-abc',
          destination_location_id: 'loc-1',
          status: 'draft',
          destination: null,
        },
        error: null,
      },
      'purchase_order_items.select': {
        data: [
          { id: 'line-1', item_id: 'item-x', quantity_ordered: 3, quantity_received: 0, unit_cost: 15, line_total: 45 },
          { id: 'line-2', item_id: 'item-y', quantity_ordered: 1, quantity_received: 0, unit_cost: 25, line_total: 25 },
        ],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client, { role: 'admin' });
    const svc = new RecurringPoTemplatesService(ctx as never);
    const payload = await svc.seedFromPo('po-src');

    expect(payload.supplierId).toBe('sup-abc');
    expect(payload.destinationLocationId).toBe('loc-1');
    expect(payload.lineItems).toHaveLength(2);
    expect(payload.lineItems[0]).toEqual({ itemId: 'item-x', quantityOrdered: 3, unitCost: 15 });
    expect(payload.lineItems[1]).toEqual({ itemId: 'item-y', quantityOrdered: 1, unitCost: 25 });
  });
});

// ─────────────────────────────────────────────────────────────────
// create — destinationLocationId org-verification
// ─────────────────────────────────────────────────────────────────

const CREATE_INPUT_BASE = {
  name: 'Test Template',
  cadence: 'weekly' as const,
  sendMode: 'draft' as const,
  lineItems: [{ itemId: '00000000-0000-0000-0000-000000000001', quantityOrdered: 1, unitCost: 10 }],
};

// ─────────────────────────────────────────────────────────────────
// A template line whose item is deleted or a kit's pre-assembled stock
// ─────────────────────────────────────────────────────────────────

describe('RecurringPoTemplatesService.runDueTemplates — lines that can no longer be ordered', () => {
  /** inventory_items rows as the database holds them. */
  const dbItem = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    organization_id: 'org-test',
    deleted_at: null,
    is_bundle: false,
    ...over,
  });

  function stubWith(lineItems: Array<{ itemId: string; quantityOrdered: number; unitCost: number }>) {
    const template = { ...TEMPLATE_BASE, send_mode: 'draft' as const, line_items: lineItems };
    return makeSupabaseStub({
      'recurring_po_templates.select': { data: [template], error: null },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
      'inventory_items.select': servedLikePostgrest([
        dbItem('item-1'),
        dbItem('item-gone', { deleted_at: '2026-09-01T00:00:00Z' }),
        dbItem('item-kit', { is_bundle: true }),
      ]),
      'rpc:save_purchase_order_draft': { data: { id: 'po-new', stamped: 0, stamp_error: null }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      'suppliers.select': { data: { id: 'sup-1' }, error: null },
    });
  }

  it('orders the rest of the template and leaves off a deleted item and a kit (the save would refuse the whole PO)', async () => {
    const stub = stubWith([
      { itemId: 'item-1', quantityOrdered: 5, unitCost: 10 },
      { itemId: 'item-gone', quantityOrdered: 1, unitCost: 1 },
      { itemId: 'item-kit', quantityOrdered: 1, unitCost: 1 },
    ]);
    const svc = new RecurringPoTemplatesService(makeServiceContext(stub.client, { role: 'owner' }) as never);

    const result = await svc.runDueTemplates(NOW);

    expect(result).toMatchObject({ created: 1, failures: 0 });
    const save = stub.rpcCalls.find((c) => c.name === 'save_purchase_order_draft');
    expect((save?.args as { p_lines: Array<{ item_id: string }> }).p_lines.map((l) => l.item_id)).toEqual([
      'item-1',
    ]);
    // ... and reports what it left off (never silent).
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'recurring_pos.unorderable_lines',
        extra: expect.objectContaining({ templateId: 'tpl-1', linesLeftOff: 2, linesKept: 1 }),
      }),
    );
  });

  it('a template with nothing orderable left creates no PO and counts a failure', async () => {
    const stub = stubWith([{ itemId: 'item-gone', quantityOrdered: 1, unitCost: 1 }]);
    const svc = new RecurringPoTemplatesService(makeServiceContext(stub.client, { role: 'owner' }) as never);

    const result = await svc.runDueTemplates(NOW);

    expect(result).toMatchObject({ created: 0, failures: 1 });
    expect(stub.rpcCalls.some((c) => c.name === 'save_purchase_order_draft')).toBe(false);
  });

  it('a failed item read creates no PO (never mistaken for "all orderable")', async () => {
    const template = { ...TEMPLATE_BASE, send_mode: 'draft' as const };
    const stub = makeSupabaseStub({
      'recurring_po_templates.select': { data: [template], error: null },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
      'inventory_items.select': { data: null, error: { message: 'statement timeout' } },
      'rpc:save_purchase_order_draft': { data: { id: 'po-new', stamped: 0, stamp_error: null }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
    });
    const svc = new RecurringPoTemplatesService(makeServiceContext(stub.client, { role: 'owner' }) as never);

    const result = await svc.runDueTemplates(NOW);

    expect(result).toMatchObject({ created: 0, failures: 1 });
    expect(stub.rpcCalls.some((c) => c.name === 'save_purchase_order_draft')).toBe(false);
  });
});

describe('RecurringPoTemplatesService.create — destinationLocationId org-verify', () => {
  it('rejects a destinationLocationId from a foreign org and does NOT insert', async () => {
    const stub = makeSupabaseStub({
      // maybeSingle returns data=null when the array has no match (location not in caller's org)
      'locations.select': { data: null, error: null },
      // insert should never be reached — include stub anyway to detect accidental calls
      'recurring_po_templates.insert': { data: { id: 'tpl-x' }, error: null },
      'rpc:next_po_number': { data: 'PO-999', error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);

    await expect(
      svc.create({
        ...CREATE_INPUT_BASE,
        destinationLocationId: 'aaaaaaaa-0000-0000-0000-000000000001',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    // The insert must NOT have been called
    expect(stub.chainsAll.get('recurring_po_templates.insert')).toBeUndefined();
  });

  it('succeeds when destinationLocationId belongs to the caller\'s org', async () => {
    const SAME_ORG_LOC_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
    const stub = makeSupabaseStub({
      // location found in org → maybeSingle returns the row
      'locations.select': { data: { id: SAME_ORG_LOC_ID }, error: null },
      'recurring_po_templates.insert': { data: { id: 'tpl-new' }, error: null },
      'rpc:next_po_number': { data: 'PO-999', error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);

    const result = await svc.create({
      ...CREATE_INPUT_BASE,
      destinationLocationId: SAME_ORG_LOC_ID,
    });

    expect(result.id).toBe('tpl-new');
    // The location lookup was performed
    expect(stub.fromCalls).toContain('locations');
    // The insert was performed
    expect(stub.chainsAll.get('recurring_po_templates.insert')).toBeDefined();
  });

  it('skips the location lookup entirely when destinationLocationId is null/omitted', async () => {
    const stub = makeSupabaseStub({
      'recurring_po_templates.insert': { data: { id: 'tpl-no-loc' }, error: null },
      'rpc:next_po_number': { data: 'PO-999', error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);

    const result = await svc.create({
      ...CREATE_INPUT_BASE,
      destinationLocationId: null,
    });

    expect(result.id).toBe('tpl-no-loc');
    // No locations query at all
    expect(stub.fromCalls).not.toContain('locations');
    // Insert happened
    expect(stub.chainsAll.get('recurring_po_templates.insert')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// create — supplierId org-verification
// ─────────────────────────────────────────────────────────────────

const SUPPLIER_UUID = 'ffffffff-0000-0000-0000-000000000001';

describe('RecurringPoTemplatesService.create — supplierId org-verify', () => {
  it('rejects a supplierId from a foreign org and does NOT insert', async () => {
    const stub = makeSupabaseStub({
      // suppliers lookup returns null → not in this org
      'suppliers.select': { data: null, error: null },
      'recurring_po_templates.insert': { data: { id: 'tpl-x' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);

    await expect(
      svc.create({
        ...CREATE_INPUT_BASE,
        supplierId: SUPPLIER_UUID,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    // The insert must NOT have been called
    expect(stub.chainsAll.get('recurring_po_templates.insert')).toBeUndefined();
  });

  it('proceeds when supplierId belongs to the caller\'s org', async () => {
    const stub = makeSupabaseStub({
      // suppliers lookup finds the row → in this org
      'suppliers.select': { data: { id: SUPPLIER_UUID }, error: null },
      'recurring_po_templates.insert': { data: { id: 'tpl-new' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);

    const result = await svc.create({
      ...CREATE_INPUT_BASE,
      supplierId: SUPPLIER_UUID,
    });

    expect(result.id).toBe('tpl-new');
    // The suppliers lookup was org-scoped.
    const supplierArgs = (stub.chainArgsAll.get('suppliers.select') ?? []).flat(Infinity);
    expect(supplierArgs).toContain('organization_id');
    expect(supplierArgs).toContain('org-test');
    // The insert was performed
    expect(stub.chainsAll.get('recurring_po_templates.insert')).toBeDefined();
  });

  it('skips the suppliers lookup entirely when supplierId is null', async () => {
    const stub = makeSupabaseStub({
      'recurring_po_templates.insert': { data: { id: 'tpl-null-sup' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);

    const result = await svc.create({
      ...CREATE_INPUT_BASE,
      supplierId: null,
    });

    expect(result.id).toBe('tpl-null-sup');
    // No suppliers query at all
    expect(stub.fromCalls).not.toContain('suppliers');
    // Insert happened
    expect(stub.chainsAll.get('recurring_po_templates.insert')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// update — supplierId org-verification
// ─────────────────────────────────────────────────────────────────

describe('RecurringPoTemplatesService.update — supplierId org-verify', () => {
  it('rejects a foreign-org supplierId and does NOT update', async () => {
    const stub = makeSupabaseStub({
      // suppliers lookup returns null → foreign org
      'suppliers.select': { data: null, error: null },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);

    await expect(
      svc.update('tpl-1', {
        ...CREATE_INPUT_BASE,
        supplierId: SUPPLIER_UUID,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    // The update must NOT have been called
    expect(stub.chainsAll.get('recurring_po_templates.update')).toBeUndefined();
  });

  it('proceeds on update when supplierId belongs to the caller\'s org', async () => {
    const stub = makeSupabaseStub({
      // suppliers lookup finds the row → same org
      'suppliers.select': { data: { id: SUPPLIER_UUID }, error: null },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);

    const result = await svc.update('tpl-1', {
      ...CREATE_INPUT_BASE,
      supplierId: SUPPLIER_UUID,
    });

    expect(result.id).toBe('tpl-1');
    // The update was performed
    expect(stub.chainsAll.get('recurring_po_templates.update')).toBeDefined();
  });

  it('skips the suppliers lookup on update when supplierId is null', async () => {
    const stub = makeSupabaseStub({
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);

    const result = await svc.update('tpl-1', {
      ...CREATE_INPUT_BASE,
      supplierId: null,
    });

    expect(result.id).toBe('tpl-1');
    expect(stub.fromCalls).not.toContain('suppliers');
  });
});

// ─────────────────────────────────────────────────────────────────
// Template save: a line whose item can never be ordered is refused
// ─────────────────────────────────────────────────────────────────

const KIT_ID = '00000000-0000-0000-0000-0000000000a1';
const GONE_ID = '00000000-0000-0000-0000-0000000000a2';
const PLAIN_ID = '00000000-0000-0000-0000-0000000000a3';

/** inventory_items rows the caller can see, for the name read. */
const namedItems = servedLikePostgrest([
  { id: KIT_ID, organization_id: 'org-test', name: 'Reading Kit' },
  { id: GONE_ID, organization_id: 'org-test', name: 'Blue pens' },
  { id: PLAIN_ID, organization_id: 'org-test', name: 'Pencils' },
]);

function lines(...ids: string[]) {
  return ids.map((itemId) => ({ itemId, quantityOrdered: 1, unitCost: 1 }));
}

describe('RecurringPoTemplatesService.create/update — lines that can never be ordered', () => {
  it('refuses a template holding a kit, naming it, and does NOT insert', async () => {
    const stub = makeSupabaseStub({
      'rpc:po_line_items_not_orderable': { data: [{ item_id: KIT_ID, refusal: 'po_line_bundle' }], error: null },
      'inventory_items.select': namedItems,
      'recurring_po_templates.insert': { data: { id: 'tpl-x' }, error: null },
    });
    const svc = new RecurringPoTemplatesService(makeServiceContext(stub.client, { role: 'owner' }) as never);

    await expect(svc.create({ ...CREATE_INPUT_BASE, lineItems: lines(PLAIN_ID, KIT_ID) })).rejects.toMatchObject({
      code: 'validation_error',
      message:
        '"Reading Kit" is a pre-assembled kit, and kits can\'t be ordered on a purchase order: they are built from their components. Order the components instead.',
    });
    expect(stub.chainsAll.get('recurring_po_templates.insert')).toBeUndefined();
    // The database's own rule decides, for this org and these ids.
    expect(stub.rpcCalls.find((c) => c.name === 'po_line_items_not_orderable')?.args).toEqual({
      p_org_id: 'org-test',
      p_item_ids: [PLAIN_ID, KIT_ID],
    });
  });

  it('names the FIRST such line in line order, whatever order the database answers in', async () => {
    const stub = makeSupabaseStub({
      'rpc:po_line_items_not_orderable': {
        data: [
          { item_id: KIT_ID, refusal: 'po_line_bundle' },
          { item_id: GONE_ID, refusal: 'po_line_deleted' },
        ],
        error: null,
      },
      'inventory_items.select': namedItems,
    });
    const svc = new RecurringPoTemplatesService(makeServiceContext(stub.client, { role: 'owner' }) as never);

    await expect(svc.create({ ...CREATE_INPUT_BASE, lineItems: lines(GONE_ID, KIT_ID) })).rejects.toMatchObject({
      code: 'validation_error',
      message: '"Blue pens" was deleted, so it can\'t be ordered. Remove it from the template and save again.',
    });
  });

  it('refuses an update the same way and does NOT update', async () => {
    const stub = makeSupabaseStub({
      'rpc:po_line_items_not_orderable': { data: [{ item_id: GONE_ID, refusal: 'po_line_deleted' }], error: null },
      'inventory_items.select': namedItems,
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
    });
    const svc = new RecurringPoTemplatesService(makeServiceContext(stub.client, { role: 'owner' }) as never);

    await expect(svc.update('tpl-1', { ...CREATE_INPUT_BASE, lineItems: lines(GONE_ID) })).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.chainsAll.get('recurring_po_templates.update')).toBeUndefined();
  });

  it('an item the caller cannot see is refused unnamed (the check reads past RLS, the name does not)', async () => {
    const stub = makeSupabaseStub({
      'rpc:po_line_items_not_orderable': { data: [{ item_id: KIT_ID, refusal: 'po_line_bundle' }], error: null },
      'inventory_items.select': { data: null, error: null },
    });
    const svc = new RecurringPoTemplatesService(makeServiceContext(stub.client, { role: 'owner' }) as never);

    await expect(svc.create({ ...CREATE_INPUT_BASE, lineItems: lines(KIT_ID) })).rejects.toMatchObject({
      message: expect.stringMatching(/^An item on this template is a pre-assembled kit/),
    });
  });

  it('a failed check refuses the save: "could not check" is never "nothing to refuse"', async () => {
    const stub = makeSupabaseStub({
      'rpc:po_line_items_not_orderable': { data: null, error: { message: 'statement timeout' } },
      'recurring_po_templates.insert': { data: { id: 'tpl-x' }, error: null },
    });
    const svc = new RecurringPoTemplatesService(makeServiceContext(stub.client, { role: 'owner' }) as never);

    await expect(svc.create({ ...CREATE_INPUT_BASE, lineItems: lines(PLAIN_ID) })).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(stub.chainsAll.get('recurring_po_templates.insert')).toBeUndefined();
  });

  it('saves when nothing is refused (archived and rental items are orderable)', async () => {
    const stub = makeSupabaseStub({
      'rpc:po_line_items_not_orderable': { data: [], error: null },
      'recurring_po_templates.insert': { data: { id: 'tpl-new' }, error: null },
    });
    const svc = new RecurringPoTemplatesService(makeServiceContext(stub.client, { role: 'owner' }) as never);

    await expect(svc.create({ ...CREATE_INPUT_BASE, lineItems: lines(PLAIN_ID) })).resolves.toEqual({ id: 'tpl-new' });
  });
});

describe('RecurringPoTemplatesService.seedFromPo — lines that can never be ordered', () => {
  it('leaves out a deleted item and a kit, and says how many', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.select': {
        data: { id: 'po-src', organization_id: 'org-test', supplier_id: 'sup-abc', destination_location_id: null },
        error: null,
      },
      'purchase_order_items.select': {
        data: [
          { item_id: PLAIN_ID, quantity_ordered: 3, unit_cost: 15 },
          { item_id: GONE_ID, quantity_ordered: 1, unit_cost: 2 },
          { item_id: KIT_ID, quantity_ordered: 1, unit_cost: 2 },
        ],
        error: null,
      },
      'rpc:po_line_items_not_orderable': {
        data: [
          { item_id: GONE_ID, refusal: 'po_line_deleted' },
          { item_id: KIT_ID, refusal: 'po_line_bundle' },
        ],
        error: null,
      },
    });
    const svc = new RecurringPoTemplatesService(makeServiceContext(stub.client, { role: 'admin' }) as never);

    const seed = await svc.seedFromPo('po-src');

    expect(seed.lineItems).toEqual([{ itemId: PLAIN_ID, quantityOrdered: 3, unitCost: 15 }]);
    expect(seed.linesLeftOff).toBe(2);
  });
});

describe('RecurringPoTemplatesService.runDueTemplates — what was left off reaches the summary', () => {
  const dbItem = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    organization_id: 'org-test',
    deleted_at: null,
    is_bundle: false,
    ...over,
  });

  it('counts the lines left off and names the templates, including one that ordered nothing', async () => {
    const templates = [
      {
        ...TEMPLATE_BASE,
        id: 'tpl-1',
        name: 'Weekly Supplies',
        line_items: [
          { itemId: 'item-1', quantityOrdered: 5, unitCost: 10 },
          { itemId: 'item-kit', quantityOrdered: 1, unitCost: 1 },
        ],
      },
      {
        ...TEMPLATE_BASE,
        id: 'tpl-2',
        name: 'Monthly Pens',
        next_run_at: new Date(DUE_AT.getTime() + 1000).toISOString(),
        line_items: [{ itemId: 'item-gone', quantityOrdered: 1, unitCost: 1 }],
      },
    ];
    const stub = makeSupabaseStub({
      'recurring_po_templates.select': servedLikePostgrest(templates),
      'recurring_po_templates.update': { data: { id: 'tpl' }, error: null },
      'inventory_items.select': servedLikePostgrest([
        dbItem('item-1'),
        dbItem('item-gone', { deleted_at: '2026-09-01T00:00:00Z' }),
        dbItem('item-kit', { is_bundle: true }),
      ]),
      'rpc:save_purchase_order_draft': { data: { id: 'po-new', stamped: 0, stamp_error: null }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      'suppliers.select': { data: { id: 'sup-1' }, error: null },
    });
    const svc = new RecurringPoTemplatesService(makeServiceContext(stub.client, { role: 'owner' }) as never);

    const summary = await svc.runDueTemplates(NOW);

    expect(summary).toMatchObject({
      created: 1,
      failures: 1,
      linesLeftOff: 2,
      templatesWithLinesLeftOff: ['Weekly Supplies', 'Monthly Pens'],
      templatesWithNothingOrderable: ['Monthly Pens'],
    });
  });
});

describe('recurringRunNotice — what the admins are told', () => {
  const base: RecurringRunSummary = {
    created: 0,
    sent: 0,
    heldForReview: 0,
    failures: 0,
    linesLeftOff: 0,
    templatesWithLinesLeftOff: [],
    templatesWithNothingOrderable: [],
  };

  it('nothing created and nothing left off: no notification (as before)', () => {
    expect(recurringRunNotice(base)).toBeNull();
  });

  it('a run that created POs, unchanged when nothing was left off', () => {
    expect(recurringRunNotice({ ...base, created: 2, sent: 1 })).toEqual({
      title: 'Recurring purchase orders ran',
      body: 'Recurring purchase orders created 2 purchase orders, 1 sent.',
    });
  });

  it('says which template left a line off, even when its PO was created', () => {
    expect(
      recurringRunNotice({ ...base, created: 1, sent: 1, linesLeftOff: 1, templatesWithLinesLeftOff: ['Weekly Supplies'] }),
    ).toEqual({
      title: 'Recurring purchase orders ran',
      body:
        'Recurring purchase orders created 1 purchase order, 1 sent. 1 template line was left off ("Weekly Supplies") because the item was deleted or is a pre-assembled kit, which is never ordered. Edit the template to remove it.',
    });
  });

  it('a template with nothing orderable, which created nothing, still notifies', () => {
    expect(
      recurringRunNotice({
        ...base,
        failures: 1,
        linesLeftOff: 1,
        templatesWithLinesLeftOff: ['Monthly Pens'],
        templatesWithNothingOrderable: ['Monthly Pens'],
      }),
    ).toEqual({
      title: 'Recurring purchase orders need attention',
      body:
        '1 template line was left off ("Monthly Pens") because the item was deleted or is a pre-assembled kit, which is never ordered. Edit the template to remove it. "Monthly Pens" created no purchase order: none of its items can be ordered any more. Edit or disable it.',
    });
  });

  it('names at most three templates', () => {
    const notice = recurringRunNotice({
      ...base,
      linesLeftOff: 5,
      templatesWithLinesLeftOff: ['A', 'B', 'C', 'D', 'E'],
    });
    expect(notice?.body).toContain('5 template lines were left off ("A", "B", "C" and 2 more)');
    expect(notice?.body).toContain('Edit the templates to remove them.');
  });
});
