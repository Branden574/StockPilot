import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * The recurring daily run (runDueTemplates) when a template's purchase order
 * cannot be saved. Until 2026-10-11 a refusal was counted in `failures` and
 * nothing else: no notification (recurringRunNotice ignored failures), no
 * report, no audit row, while the claim had already stamped last_run_at, so
 * the Recurring page said the template ran. And a destination deleted AFTER
 * the template was saved was not refused at all: the purchase order was
 * created to it (PurchaseOrdersService accepted a deleted location linked to
 * a warehouse). Small fixes slice 8, item C.
 *
 * Now the purchase order save refuses a deleted destination
 * (purchase-orders.deleted-destination.test.ts), and the run skips any
 * template whose save is refused or fails, with the reason: in the summary
 * (which the cron sends to the organization's owners and admins and the
 * template's creator), in error reporting and in the audit log. One
 * template's refusal never stops the others.
 */

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
  requireOrgContext: vi.fn(async () => ({ userId: 'user-test', organizationId: 'org-test', role: 'admin' })),
}));

const { audit, reportError } = vi.hoisted(() => ({
  audit: vi.fn(async () => {}),
  reportError: vi.fn(async () => {}),
}));
vi.mock('./audit', () => ({ audit }));
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

const NOW = new Date('2026-10-12T14:00:00.000Z');
const DUE_AT = '2026-10-12T13:00:00.000Z';

const LOC = {
  site: 'dddddddd-0000-4000-8000-000000000001',
  deleted: 'dddddddd-0000-4000-8000-000000000002',
  noWarehouse: 'dddddddd-0000-4000-8000-000000000003',
} as const;

const LOCATIONS = [
  { id: LOC.site, organization_id: 'org-test', name: 'Main Warehouse', kind: null, type: 'warehouse', warehouse_id: 'wh-a', deleted_at: null },
  // Deleted AFTER the template was saved; it kept its warehouse.
  { id: LOC.deleted, organization_id: 'org-test', name: 'Old Annex', kind: null, type: 'warehouse', warehouse_id: 'wh-a', deleted_at: '2026-10-05T00:00:00Z' },
  { id: LOC.noWarehouse, organization_id: 'org-test', name: 'District Office', kind: null, type: 'warehouse', warehouse_id: null, deleted_at: null },
];

function template(over: Record<string, unknown>) {
  return {
    id: 'tpl-1',
    organization_id: 'org-test',
    supplier_id: null,
    destination_location_id: LOC.site,
    name: 'Weekly Supplies',
    enabled: true,
    cadence: 'weekly',
    custom_days: null,
    send_mode: 'draft',
    max_auto_send_cents: null,
    line_items: [{ itemId: 'item-1', quantityOrdered: 5, unitCost: 10 }],
    notes: null,
    next_run_at: DUE_AT,
    created_by: 'user-creator',
    ...over,
  };
}

function stubFor(templates: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'recurring_po_templates.select': servedLikePostgrest(templates),
    'recurring_po_templates.update': { data: { id: 'claimed' }, error: null },
    'inventory_items.select': servedLikePostgrest([
      { id: 'item-1', organization_id: 'org-test', deleted_at: null, is_bundle: false },
    ]),
    'locations.select': servedLikePostgrest(LOCATIONS),
    'rpc:next_po_number': { data: 'PO-100', error: null },
    'rpc:save_purchase_order_draft': { data: { id: 'po-new', stamped: 0, stamp_error: null }, error: null },
    ...over,
  });
}

async function run(templates: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  const stub = stubFor(templates, over);
  const svc = new RecurringPoTemplatesService(makeServiceContext(stub.client, { role: 'owner' }) as never);
  const summary = await svc.runDueTemplates(NOW);
  const saves = stub.rpcCalls.filter((c) => c.name === 'save_purchase_order_draft');
  return { summary, saves, stub };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runDueTemplates: a template whose purchase order is refused is skipped, with the reason told', () => {
  it('a destination deleted after the template was saved: no purchase order, and the template is named with why', async () => {
    const { summary, saves, stub } = await run([template({ destination_location_id: LOC.deleted })]);

    expect(saves).toHaveLength(0);
    expect(summary).toMatchObject({ created: 0, failures: 1 });
    expect(summary.templatesSkipped).toEqual([
      {
        templateId: 'tpl-1',
        name: 'Weekly Supplies',
        reason: 'Its destination, "Old Annex", was deleted. Edit the template and choose another destination.',
        createdBy: 'user-creator',
      },
    ]);
    // The schedule still moved on (the claim), so it is not retried in a loop.
    expect(stub.chainsAll.get('recurring_po_templates.update')).toHaveLength(1);
    // Logged: error reporting (a warning: a refusal, not a crash) ...
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'recurring_pos.template_skipped',
        level: 'warning',
        organizationId: 'org-test',
        extra: { templateId: 'tpl-1', refusal: 'destination_deleted' },
      }),
    );
    // ... and the audit log, on the template.
    expect(audit).toHaveBeenCalledWith(
      {
        event: 'recurring_po_template.run_skipped',
        entityType: 'recurring_po_template',
        entityId: 'tpl-1',
        reason: 'Its destination, "Old Annex", was deleted. Edit the template and choose another destination.',
        extra: { name: 'Weekly Supplies', refusal: 'destination_deleted' },
      },
      expect.objectContaining({ organizationId: 'org-test' }),
    );
  });

  it("any other refusal is told in the save's own words: a destination linked to no warehouse", async () => {
    const { summary, saves } = await run([template({ destination_location_id: LOC.noWarehouse })]);

    expect(saves).toHaveLength(0);
    expect(summary.templatesSkipped).toEqual([
      {
        templateId: 'tpl-1',
        name: 'Weekly Supplies',
        reason:
          "That destination location isn't linked to a warehouse, so received stock would have nowhere to go. Pick a warehouse-backed location.",
        createdBy: 'user-creator',
      },
    ]);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'recurring_pos.template_skipped', extra: { templateId: 'tpl-1', refusal: 'validation_error' } }),
    );
  });

  it('an unexpected failure is told without its internals, and reported as an error', async () => {
    const { summary } = await run([template({})], {
      'rpc:save_purchase_order_draft': { data: null, error: { message: 'permission denied for table purchase_orders' } },
    });

    expect(summary).toMatchObject({ created: 0, failures: 1 });
    expect(summary.templatesSkipped).toEqual([
      {
        templateId: 'tpl-1',
        name: 'Weekly Supplies',
        reason: 'An unexpected error stopped it. It runs again on its next date.',
        createdBy: 'user-creator',
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain('permission denied');
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'recurring_pos.template_failed', extra: { templateId: 'tpl-1' } }),
    );
  });

  it('one template skipped never stops the others in the same run', async () => {
    const { summary, saves } = await run([
      template({ id: 'tpl-1', name: 'Annex Paper', destination_location_id: LOC.deleted }),
      template({ id: 'tpl-2', name: 'Weekly Supplies', next_run_at: '2026-10-12T13:30:00.000Z' }),
    ]);

    expect(saves).toHaveLength(1);
    expect((saves[0]!.args as { p_destination_location_id: string }).p_destination_location_id).toBe(LOC.site);
    expect(summary).toMatchObject({ created: 1, failures: 1 });
    expect(summary.templatesSkipped.map((s) => s.name)).toEqual(['Annex Paper']);
  });

  it('a template created by nobody still in the record is skipped the same way, with no creator', async () => {
    const { summary } = await run([template({ destination_location_id: LOC.deleted, created_by: null })]);
    expect(summary.templatesSkipped[0]).toMatchObject({ templateId: 'tpl-1', createdBy: null });
  });
});

describe('recurringRunNotice: the skipped templates are named with why', () => {
  const base: RecurringRunSummary = {
    created: 0,
    sent: 0,
    heldForReview: 0,
    failures: 0,
    linesLeftOff: 0,
    templatesWithLinesLeftOff: [],
    templatesWithNothingOrderable: [],
    templatesSkipped: [],
  };
  const skipped = (name: string, reason = 'Its destination, "Old Annex", was deleted. Edit the template and choose another destination.') => ({
    templateId: `id-${name}`,
    name,
    reason,
    createdBy: null,
  });

  it('a run that only skipped a template still notifies, as needing attention', () => {
    expect(recurringRunNotice({ ...base, failures: 1, templatesSkipped: [skipped('Annex Paper')] })).toEqual({
      title: 'Recurring purchase orders need attention',
      body: '"Annex Paper" created no purchase order. Its destination, "Old Annex", was deleted. Edit the template and choose another destination.',
    });
  });

  it('beside purchase orders that were created', () => {
    expect(
      recurringRunNotice({ ...base, created: 1, failures: 1, templatesSkipped: [skipped('Annex Paper')] }),
    ).toEqual({
      title: 'Recurring purchase orders ran',
      body:
        'Recurring purchase orders created 1 purchase order. "Annex Paper" created no purchase order. Its destination, "Old Annex", was deleted. Edit the template and choose another destination.',
    });
  });

  it('names three, then counts the rest', () => {
    const body = recurringRunNotice({
      ...base,
      failures: 5,
      templatesSkipped: ['A', 'B', 'C', 'D', 'E'].map((n) => skipped(n, 'An unexpected error stopped it. It runs again on its next date.')),
    })?.body;
    expect(body).toContain('"A" created no purchase order. An unexpected error stopped it.');
    expect(body).toContain('"C" created no purchase order.');
    expect(body).not.toContain('"D"');
    expect(body).toContain('2 more templates created no purchase order.');
  });

  it('nothing created, nothing left off and nothing skipped: still no notification', () => {
    expect(recurringRunNotice(base)).toBeNull();
  });
});
