import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import { audit } from './audit';
import { parseAutoDeleteArchivedSettings, purgeExpiredArchivedItems } from './archive-cleanup';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseAutoDeleteArchivedSettings', () => {
  it('accepts valid settings unchanged', () => {
    expect(parseAutoDeleteArchivedSettings({ enabled: true, days: 90 })).toEqual({
      enabled: true,
      days: 90,
    });
  });

  it('falls back to OFF defaults for missing/garbage input', () => {
    expect(parseAutoDeleteArchivedSettings(undefined)).toEqual({ enabled: false, days: 90 });
    expect(parseAutoDeleteArchivedSettings(null)).toEqual({ enabled: false, days: 90 });
    expect(parseAutoDeleteArchivedSettings({ enabled: 'yes' })).toEqual({ enabled: false, days: 90 });
  });

  it('rejects out-of-range days (below the 7-day floor) by falling back to OFF', () => {
    expect(parseAutoDeleteArchivedSettings({ enabled: true, days: 1 })).toEqual({
      enabled: false,
      days: 90,
    });
    expect(parseAutoDeleteArchivedSettings({ enabled: true, days: 99999 })).toEqual({
      enabled: false,
      days: 90,
    });
  });
});

describe('purgeExpiredArchivedItems', () => {
  it('soft-deletes the expired archived candidates and audits each', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'i1', name: 'Old Tote' },
          { id: 'i2', name: 'Old Flag' },
        ],
        error: null,
      },
      'inventory_items.update': {
        data: [
          { id: 'i1', name: 'Old Tote' },
          { id: 'i2', name: 'Old Flag' },
        ],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await purgeExpiredArchivedItems(ctx, 90);

    expect(res.deleted).toBe(2);
    expect(res.ids).toEqual(['i1', 'i2']);
    // The UPDATE sets deleted_at (soft delete), never a hard delete.
    const updArgs = stub.chainArgs.get('inventory_items.update');
    const payload = updArgs?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload?.deleted_at).toBeTruthy();
    expect(payload?.deleted_by).toBeDefined();
    // One audit row per deleted item.
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(2);
  });

  it('no-ops (no UPDATE, no audit) when nothing is past the retention window', async () => {
    const stub = makeSupabaseStub({ 'inventory_items.select': { data: [], error: null } });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await purgeExpiredArchivedItems(ctx, 90);

    expect(res.deleted).toBe(0);
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
