import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import { audit } from './audit';
import { archiveExpiredZeroStockItems, parseAutoArchiveSettings } from './auto-archive';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseAutoArchiveSettings', () => {
  it('accepts valid settings unchanged', () => {
    expect(parseAutoArchiveSettings({ enabled: true, dwellDays: 14 })).toEqual({
      enabled: true,
      dwellDays: 14,
    });
  });

  it('falls back to OFF defaults for missing/garbage input', () => {
    expect(parseAutoArchiveSettings(undefined)).toEqual({ enabled: false, dwellDays: 7 });
    expect(parseAutoArchiveSettings(null)).toEqual({ enabled: false, dwellDays: 7 });
    expect(parseAutoArchiveSettings({ enabled: 'yes' })).toEqual({ enabled: false, dwellDays: 7 });
  });

  it('rejects out-of-range dwellDays (below the 1-day floor / above the 365-day ceiling) by falling back to OFF', () => {
    expect(parseAutoArchiveSettings({ enabled: true, dwellDays: 0 })).toEqual({
      enabled: false,
      dwellDays: 7,
    });
    expect(parseAutoArchiveSettings({ enabled: true, dwellDays: 9999 })).toEqual({
      enabled: false,
      dwellDays: 7,
    });
  });
});

describe('archiveExpiredZeroStockItems', () => {
  it('archives the eligible candidates and audits each', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'i1', name: 'Dead Stock A' },
          { id: 'i2', name: 'Dead Stock B' },
        ],
        error: null,
      },
      'stock_reservations.select': { data: [], error: null },
      'inventory_items.update': {
        data: [
          { id: 'i1', name: 'Dead Stock A' },
          { id: 'i2', name: 'Dead Stock B' },
        ],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await archiveExpiredZeroStockItems(ctx, 7);

    expect(res.archived).toBe(2);
    expect(res.ids).toEqual(['i1', 'i2']);
    expect(res.items).toEqual([
      { id: 'i1', name: 'Dead Stock A' },
      { id: 'i2', name: 'Dead Stock B' },
    ]);
    expect(res.truncated).toBe(false);

    // Candidate filter chain: active, never-auto-archived, at/below zero,
    // zero_since set + past cutoff, never a rental, oldest-first.
    const candChain = stub.chains.get('inventory_items.select');
    expect(candChain).toContain('eq'); // organization_id / status / auto_archived / is_rental all via eq
    expect(candChain).toContain('lte'); // quantity_on_hand + zero_since cutoff
    expect(candChain).toContain('not'); // zero_since is not null
    expect(candChain).toContain('order');
    expect(candChain).toContain('limit');
    // Rentals sit at zero while checked out — excluded via is_rental=false
    // (there is no item_type='rental' value; item_type is product/book/
    // asset/consumable), never via .neq('item_type', 'rental').
    expect(candChain).not.toContain('neq');

    const candArgs = stub.chainArgs.get('inventory_items.select') ?? [];
    const eqPairs = candChain
      ?.map((method, i) => [method, candArgs[i]] as const)
      .filter(([m]) => m === 'eq')
      .map(([, a]) => a?.[0]);
    expect(eqPairs).toContain('is_rental'); // rentals excluded via is_rental, NOT item_type
    expect(eqPairs).not.toContain('item_type');

    // Reservation exclusion queried by item_id, open reservations only.
    const resvChain = stub.chains.get('stock_reservations.select');
    expect(resvChain).toContain('in');
    expect(resvChain).toContain('is');

    // Race-guarded UPDATE, never touches an already-restocked/un-archived row.
    const updArgs = stub.chainArgs.get('inventory_items.update');
    const payload = updArgs?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload?.status).toBe('archived');
    expect(payload?.auto_archived).toBe(true);
    expect(payload?.updated_by).toBeDefined();
    const updChain = stub.chains.get('inventory_items.update');
    expect(updChain).toContain('eq'); // organization_id + status + auto_archived race guards
    expect(updChain).toContain('lte'); // quantity_on_hand race guard

    expect(vi.mocked(audit)).toHaveBeenCalledTimes(2);
  });

  it('no-ops (no reservation lookup, no UPDATE, no audit) when nothing is past the dwell window', async () => {
    const stub = makeSupabaseStub({ 'inventory_items.select': { data: [], error: null } });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await archiveExpiredZeroStockItems(ctx, 7);

    expect(res).toEqual({ archived: 0, ids: [], items: [], truncated: false });
    expect(stub.chainsAll.get('stock_reservations.select')).toBeUndefined();
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('excludes items with an open reservation (approved-unpicked order / open rental) — no UPDATE for a fully-reserved batch', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'i1', name: 'Dead Stock A' },
          { id: 'i2', name: 'Dead Stock B' },
        ],
        error: null,
      },
      'stock_reservations.select': {
        data: [{ item_id: 'i1' }, { item_id: 'i2' }],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await archiveExpiredZeroStockItems(ctx, 7, { limit: 2 });

    expect(res.archived).toBe(0);
    expect(res.ids).toEqual([]);
    expect(res.items).toEqual([]);
    // The 2-row select hit the caller-supplied limit, so truncated stays true
    // even though nothing ended up archived (there may be more candidates).
    expect(res.truncated).toBe(true);
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('archives only the non-reserved subset when some candidates are reserved', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'i1', name: 'Dead Stock A' },
          { id: 'i2', name: 'Reserved Item' },
        ],
        error: null,
      },
      'stock_reservations.select': { data: [{ item_id: 'i2' }], error: null },
      'inventory_items.update': {
        data: [{ id: 'i1', name: 'Dead Stock A' }],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await archiveExpiredZeroStockItems(ctx, 7);

    expect(res.archived).toBe(1);
    expect(res.ids).toEqual(['i1']);
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
  });
});
