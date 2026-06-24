import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import { RecoveryService } from './recovery';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RecoveryService.restore — archived clock reset', () => {
  it('resets archived_at when restoring an inventory item (so the cron cannot re-delete it)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.update': { data: { id: 'i1' }, error: null },
    });
    const svc = new RecoveryService(makeServiceContext(stub.client, { role: 'owner' }) as never);

    await svc.restore('inventory_items', 'i1');

    const updArgs = stub.chainArgs.get('inventory_items.update');
    const payload = updArgs?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload?.deleted_at).toBeNull();
    expect(payload?.deleted_by).toBeNull();
    // Fresh retention window — without this the auto-delete cron re-deletes the
    // just-restored item on its next run.
    expect(payload?.archived_at).toBeTruthy();
  });

  it('does NOT set archived_at when restoring a non-inventory entity', async () => {
    const stub = makeSupabaseStub({
      'categories.update': { data: { id: 'c1' }, error: null },
    });
    const svc = new RecoveryService(makeServiceContext(stub.client, { role: 'owner' }) as never);

    await svc.restore('categories', 'c1');

    const updArgs = stub.chainArgs.get('categories.update');
    const payload = updArgs?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload?.deleted_at).toBeNull();
    expect('archived_at' in (payload ?? {})).toBe(false);
  });
});
