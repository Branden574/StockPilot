// @vitest-environment node
import { revalidateTag } from 'next/cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { expectCatalogExpiryReaches } from '@/test/orders-catalog-tags';

import {
  expireOrdersCatalogAfterOrderWrite,
  expireOrganizationOrdersCatalog,
  orderCatalogWarehouseOf,
  ordersCatalogTagForOrder,
} from './orders-catalog-expiry';

vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b';
const WH = '00000000-0000-4000-8000-0000000000c1';
const OTHER_WH = '00000000-0000-4000-8000-0000000000c2';

const expired = () => vi.mocked(revalidateTag).mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('orderCatalogWarehouseOf', () => {
  it("names the warehouse of this organization's order row", () => {
    expect(orderCatalogWarehouseOf(ORG, { organization_id: ORG, warehouse_id: WH })).toBe(WH);
    expect(
      orderCatalogWarehouseOf(ORG, { organization_id: ORG, warehouse_id: WH.toUpperCase() }),
    ).toBe(WH);
  });

  it("is null for another organization's row, a missing or malformed warehouse, or no row", () => {
    expect(
      orderCatalogWarehouseOf(ORG, { organization_id: OTHER_ORG, warehouse_id: WH }),
    ).toBeNull();
    expect(orderCatalogWarehouseOf(ORG, { organization_id: ORG, warehouse_id: null })).toBeNull();
    expect(orderCatalogWarehouseOf(ORG, { organization_id: ORG, warehouse_id: 'wh-1' })).toBeNull();
    expect(orderCatalogWarehouseOf(ORG, { warehouse_id: WH })).toBeNull();
    expect(orderCatalogWarehouseOf(ORG, null)).toBeNull();
    expect(orderCatalogWarehouseOf(ORG, undefined)).toBeNull();
    expect(orderCatalogWarehouseOf(ORG, 'x')).toBeNull();
  });
});

describe('expireOrdersCatalogAfterOrderWrite', () => {
  it("expires only the order's warehouse catalog in its organization, now", () => {
    expireOrdersCatalogAfterOrderWrite(ORG, { organization_id: ORG, warehouse_id: WH });
    expect(vi.mocked(revalidateTag).mock.calls).toEqual([
      [`orders-new-v2-catalog:${ORG}:${WH}`, { expire: 0 }],
    ]);
    expectCatalogExpiryReaches(expired(), {
      hits: [[ORG, WH]],
      misses: [
        [ORG, OTHER_WH],
        [OTHER_ORG, WH],
        [OTHER_ORG, OTHER_WH],
      ],
    });
  });

  it("without a row, the organization's catalog: every warehouse of it, no other organization's", () => {
    expireOrdersCatalogAfterOrderWrite(ORG);
    expect(vi.mocked(revalidateTag).mock.calls).toEqual([
      [`orders-new-v2-catalog:${ORG}`, { expire: 0 }],
    ]);
    expectCatalogExpiryReaches(expired(), {
      hits: [
        [ORG, WH],
        [ORG, OTHER_WH],
      ],
      misses: [[OTHER_ORG, WH]],
    });
  });

  it("a row of another organization never names that organization's catalog", () => {
    expect(ordersCatalogTagForOrder(ORG, { organization_id: OTHER_ORG, warehouse_id: WH })).toBe(
      `orders-new-v2-catalog:${ORG}`,
    );
  });

  it('never the global tag', () => {
    expireOrdersCatalogAfterOrderWrite(ORG, { organization_id: ORG, warehouse_id: WH });
    expireOrdersCatalogAfterOrderWrite(ORG);
    expect(expired()).not.toContain('orders-new-v2-catalog');
  });

  it('never throws: outside a request scope it warns and the TTL is the bound', () => {
    vi.mocked(revalidateTag).mockImplementationOnce(() => {
      throw new Error('Invariant: static generation store missing');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => expireOrdersCatalogAfterOrderWrite(ORG)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      '[orders-catalog] refresh skipped after order write:',
      'Invariant: static generation store missing',
    );
    warn.mockRestore();
  });
});

describe('expireOrganizationOrdersCatalog', () => {
  it("expires the organization's tag now: each of its warehouses, no other organization's", () => {
    expireOrganizationOrdersCatalog(ORG, 'test');
    expect(vi.mocked(revalidateTag).mock.calls).toEqual([
      [`orders-new-v2-catalog:${ORG}`, { expire: 0 }],
    ]);
    expectCatalogExpiryReaches(expired(), {
      hits: [
        [ORG, WH],
        [ORG, OTHER_WH],
      ],
      misses: [[OTHER_ORG, WH]],
    });
  });
});
