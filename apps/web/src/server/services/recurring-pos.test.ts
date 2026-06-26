import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

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

vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));

vi.mock('./item-images', () => ({
  ItemImagesService: class {
    async primaryImagesForItems() {
      return new Map<string, string>();
    }
  },
}));

import { RecurringPoTemplatesService } from './recurring-pos';

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
      'purchase_orders.insert': { data: { id: 'po-new' }, error: null },
      'purchase_order_items.insert': { data: [], error: null },
      'purchase_orders.update': { data: { id: 'po-new' }, error: null },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
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
      'purchase_orders.insert': { data: { id: 'po-new' }, error: null },
      'purchase_order_items.insert': { data: [], error: null },
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
      'purchase_orders.insert': { data: { id: 'po-new' }, error: null },
      'purchase_order_items.insert': { data: [], error: null },
      'organization_modules.select': {
        data: { settings: { approvalThresholdAmount: 500 } },
        error: null,
      },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
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
      'purchase_orders.insert': { data: { id: 'po-new' }, error: null },
      'purchase_order_items.insert': { data: [], error: null },
      'organization_modules.select': {
        data: { settings: { approvalThresholdAmount: 30 } },
        error: null,
      },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
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
      'purchase_orders.insert': { data: { id: 'po-new' }, error: null },
      'purchase_order_items.insert': { data: [], error: null },
      'organization_modules.select': { data: null, error: { message: 'DB error' } },
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
      'rpc:next_po_number': { data: 'PO-100', error: null },
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

  it('schedule-advance failure on a created PO: surfaced as a failure (no silent double-fire)', async () => {
    const template = { ...TEMPLATE_BASE, send_mode: 'draft' as const };
    const stub = makeSupabaseStub({
      'recurring_po_templates.select': { data: [template], error: null },
      'purchase_orders.insert': { data: { id: 'po-new' }, error: null },
      'purchase_order_items.insert': { data: [], error: null },
      // The schedule-advance update matches 0 rows / errors → must be surfaced.
      'recurring_po_templates.update': { data: null, error: { message: 'advance failed' } },
      'rpc:next_po_number': { data: 'PO-100', error: null },
    });
    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const svc = new RecurringPoTemplatesService(ctx as never);
    const result = await svc.runDueTemplates(NOW);

    // PO was created, but the schedule didn't advance → flagged as a failure so
    // the cron summary/notification surfaces the duplicate-spend risk.
    expect(result.created).toBe(1);
    expect(result.failures).toBe(1);
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
