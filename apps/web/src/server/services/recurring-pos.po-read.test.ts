import { describe, expect, it, vi } from 'vitest';

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
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));

import { ServiceError } from './context';
import { RecurringPoTemplatesService } from './recurring-pos';

/**
 * A recurring template is a standing purchase order: the daily run turns it
 * into one as an owner and, in send mode under its cap, places it. Since
 * migration 0423 writing a purchase order needs View purchase orders, and the
 * template write policies now need it too, so every template change is
 * refused in the permission's words before anything is read or written.
 */

const TEMPLATE = {
  name: 'Weekly supplies',
  cadence: 'weekly' as const,
  sendMode: 'draft' as const,
  lineItems: [{ itemId: '00000000-0000-0000-0000-000000000001', quantityOrdered: 2, unitCost: 10 }],
};

function svcWith(stub: ReturnType<typeof makeSupabaseStub>, permissions: ReadonlySet<string>) {
  return new RecurringPoTemplatesService(
    makeServiceContext(stub.client, { role: 'manager', permissions }) as never,
  );
}

const WITHOUT_READ = new Set(['purchase_orders:manage']);

describe('RecurringPoTemplatesService: every template change needs purchase_orders:read', () => {
  const calls: Array<[string, (s: RecurringPoTemplatesService) => Promise<unknown>]> = [
    ['list', (s) => s.list()],
    ['create', (s) => s.create(TEMPLATE)],
    ['update', (s) => s.update('tpl-1', TEMPLATE)],
    ['setEnabled', (s) => s.setEnabled('tpl-1', true)],
    ['remove', (s) => s.remove('tpl-1')],
    ['seedFromPo', (s) => s.seedFromPo('po-1')],
  ];

  it.each(calls)(
    '%s refuses a manager without it before any read or write',
    async (_name, call) => {
      const stub = makeSupabaseStub({});

      const err = await call(svcWith(stub, WITHOUT_READ)).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('forbidden');
      expect((err as ServiceError).message).toBe('Missing permission: purchase_orders:read');
      expect(stub.fromCalls).toEqual([]);
      expect(stub.rpcCalls).toEqual([]);
    },
  );

  it('a manager holding it still pauses a template', async () => {
    const stub = makeSupabaseStub({
      'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
    });

    await expect(
      svcWith(stub, new Set(['purchase_orders:manage', 'purchase_orders:read'])).setEnabled(
        'tpl-1',
        false,
      ),
    ).resolves.toEqual({ id: 'tpl-1' });
    expect(stub.fromCalls).toEqual(['recurring_po_templates']);
  });
});

/**
 * Every member still reads every template (docket S10 5.1), so the page can
 * list one going to a warehouse outside the member's own. Since 0423 the
 * database writes such a template for nobody below manager, and the write
 * matches no row. The refusal says so, instead of calling a template on the
 * screen "not found".
 */
describe('RecurringPoTemplatesService: a template write the database refuses says why', () => {
  const BOTH = new Set(['purchase_orders:manage', 'purchase_orders:read']);
  const writes: Array<
    [string, 'update' | 'delete', (s: RecurringPoTemplatesService) => Promise<unknown>]
  > = [
    ['update', 'update', (s) => s.update('tpl-1', TEMPLATE)],
    ['setEnabled', 'update', (s) => s.setEnabled('tpl-1', false)],
    ['remove', 'delete', (s) => s.remove('tpl-1')],
  ];

  it.each(writes)(
    '%s: a template the member reads but may not change is refused in words',
    async (_name, op, call) => {
      const stub = makeSupabaseStub({
        [`recurring_po_templates.${op}`]: { data: null, error: null },
        'recurring_po_templates.select': { data: { id: 'tpl-1' }, error: null },
      });

      const err = await call(svcWith(stub, BOTH)).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('forbidden');
      expect((err as ServiceError).message).toBe(
        'You can change only the recurring purchase orders that go to your warehouses.',
      );
    },
  );

  it.each(writes)('%s: a template that is gone is still not found', async (_name, op, call) => {
    const stub = makeSupabaseStub({
      [`recurring_po_templates.${op}`]: { data: null, error: null },
      'recurring_po_templates.select': { data: null, error: null },
    });

    const err = await call(svcWith(stub, BOTH)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('not_found');
    expect((err as ServiceError).message).toBe('Recurring PO template not found');
  });
});
