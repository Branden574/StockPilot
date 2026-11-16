import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import { BundlesService, RECENT_DISTRIBUTION_COLUMNS } from './bundles';

/**
 * The kit page's distribution history reads only the columns it shows: the
 * id, the warehouse, the quantity, the event and shortage flags, the notes and
 * the time. A distribution's retry key is never read for it.
 */

const KIT_ID = '00000000-0000-4000-8000-0000000000b1';

const ROW = {
  id: '00000000-0000-4000-8000-0000000000d1',
  warehouse_id: '00000000-0000-4000-8000-0000000000c1',
  quantity: 2,
  schedule_event_id: null,
  notes: 'Example hand-out',
  shortage_recorded: false,
  distributed_at: '2026-11-02T10:00:00.000Z',
};

describe('BundlesService.recentDistributions', () => {
  it('selects the listed columns only, scoped to the organization and kit', async () => {
    const stub = makeSupabaseStub({ 'bundle_distributions.select': { data: [ROW], error: null } });
    const svc = new BundlesService(makeServiceContext(stub.client, { organizationId: 'org-A' }));

    const rows = await svc.recentDistributions({ bundleId: KIT_ID, limit: 20 });

    expect(rows).toEqual([ROW]);
    const args = stub.chainArgs.get('bundle_distributions.select') ?? [];
    const methods = stub.chains.get('bundle_distributions.select') ?? [];
    expect(args[methods.indexOf('select')]).toEqual([RECENT_DISTRIBUTION_COLUMNS]);
    expect(RECENT_DISTRIBUTION_COLUMNS).toBe(
      'id, warehouse_id, quantity, schedule_event_id, notes, shortage_recorded, distributed_at',
    );
    expect(RECENT_DISTRIBUTION_COLUMNS).not.toMatch(/\*|idempotency_key/);
    const eqs = methods.flatMap((m, i) => (m === 'eq' ? [args[i]] : []));
    expect(eqs).toEqual([
      ['organization_id', 'org-A'],
      ['bundle_id', KIT_ID],
    ]);
  });

  it('still needs items:read', async () => {
    const stub = makeSupabaseStub({ 'bundle_distributions.select': { data: [ROW], error: null } });
    const svc = new BundlesService(
      makeServiceContext(stub.client, { organizationId: 'org-A', permissions: new Set<string>() }),
    );
    await expect(svc.recentDistributions()).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.fromCalls).not.toContain('bundle_distributions');
  });
});
