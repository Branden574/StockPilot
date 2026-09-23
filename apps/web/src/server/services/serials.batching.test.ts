import { describe, expect, it, vi } from 'vitest';

/**
 * The serial pre-check batches by encoded length.
 *
 * add() takes up to 500 serials of up to 128 characters. In one `.in()` that
 * is ~64 KB of URL: a 414 locally and "fetch failed" in production after ~7 s
 * of retries, so a large paste could never register. The check decides
 * whether the insert may run, so a failed batch throws.
 */

vi.mock('./audit', () => ({ audit: vi.fn() }));

import { encodedInValueLength, IN_FILTER_MAX_ENCODED_CHARS } from '@/lib/supabase/in-filter';
import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { ServiceError, type ServiceContext } from './context';
import { SerialsService } from './serials';

const ITEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WAREHOUSE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** 500 distinct 128-character serials, some carrying reserved characters. */
const serials = Array.from({ length: 500 }, (_, i) =>
  `${String(i).padStart(4, '0')}${i % 3 === 0 ? ',(x)' : '-abc'}${'S'.repeat(120)}`.slice(0, 128),
);

function service(registry: (call: MockCall) => { data: unknown; error: unknown }) {
  const stub = makeSupabaseStub({
    'inventory_items.select': { data: [{ id: ITEM_ID }], error: null },
    'warehouses.select': { data: [{ id: WAREHOUSE_ID }], error: null },
    'serial_registry.select': registry as never,
    'serial_registry.insert': { data: null, error: null },
  });
  const ctx = makeServiceContext(stub.client) as unknown as ServiceContext;
  return { svc: new SerialsService(ctx), stub };
}

function listOf(call: MockCall): string[] {
  return (inFilters(call).find(([c]) => c === 'serial_number')?.[1] ?? []) as string[];
}

describe('SerialsService.add with 500 serials of 128 characters', () => {
  it('checks them in batches that each stay within the URL budget, then inserts', async () => {
    const lists: string[][] = [];
    const { svc, stub } = service((call) => {
      lists.push(listOf(call));
      return { data: [], error: null };
    });
    const res = await svc.add(ITEM_ID, WAREHOUSE_ID, serials);
    expect(res.added).toBe(500);
    expect(lists.length).toBeGreaterThan(10);
    expect(lists.flat()).toHaveLength(500);
    for (const l of lists) {
      const chars = l.reduce((n, v) => n + encodedInValueLength(v) + 3, 0);
      expect(chars).toBeLessThanOrEqual(IN_FILTER_MAX_ENCODED_CHARS);
    }
    expect(stub.chainsAll.get('serial_registry.insert')).toHaveLength(1);
  });

  it('names a duplicate found in the last batch', async () => {
    const last = serials[499] as string;
    const { svc, stub } = service((call) => {
      const l = listOf(call);
      return { data: l.includes(last) ? [{ serial_number: last }] : [], error: null };
    });
    const err = await svc.add(ITEM_ID, WAREHOUSE_ID, serials).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('conflict');
    expect((err as ServiceError).message).toContain(last);
    expect(stub.chainsAll.get('serial_registry.insert')).toBeUndefined();
  });

  it('throws internal_error and inserts nothing when a batch fails', async () => {
    let n = 0;
    const { svc, stub } = service(() => {
      n += 1;
      return n === 4
        ? { data: null, error: { message: 'URI too long' } }
        : { data: [], error: null };
    });
    const err = await svc.add(ITEM_ID, WAREHOUSE_ID, serials).catch((e: unknown) => e);
    expect((err as ServiceError).code).toBe('internal_error');
    expect(stub.chainsAll.get('serial_registry.insert')).toBeUndefined();
  });
});
