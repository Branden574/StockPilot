import { describe, expect, it } from 'vitest';

import { collectReferenceIdsByType, referenceRoute, referenceTypeLabel } from './movement-references';

describe('referenceRoute', () => {
  it('order_request routes to the native order detail screen', () => {
    expect(referenceRoute('order_request', 'ord-1')).toBe('/order/ord-1');
  });

  it('cycle_count routes to the native cycle-count detail screen', () => {
    expect(referenceRoute('cycle_count', 'cc-1')).toBe('/cycle-count/cc-1');
  });

  it('bundle routes to the native bundle detail screen', () => {
    expect(referenceRoute('bundle', 'bun-1')).toBe('/bundles/bun-1');
  });

  it('return has no native detail screen — degrades to null, never a link', () => {
    expect(referenceRoute('return', 'ret-1')).toBeNull();
  });

  it('unknown reference_type degrades to null', () => {
    expect(referenceRoute('purchase_order', 'po-1')).toBeNull();
    expect(referenceRoute('rental', 'rent-1')).toBeNull();
    expect(referenceRoute('something_new', 'x')).toBeNull();
  });

  it('missing type or id degrades to null', () => {
    expect(referenceRoute(null, 'ord-1')).toBeNull();
    expect(referenceRoute('order_request', null)).toBeNull();
    expect(referenceRoute(null, null)).toBeNull();
  });
});

describe('referenceTypeLabel', () => {
  it('known types get their short display name', () => {
    expect(referenceTypeLabel('order_request')).toBe('Order');
    expect(referenceTypeLabel('cycle_count')).toBe('Cycle count');
    expect(referenceTypeLabel('return')).toBe('Return');
    expect(referenceTypeLabel('bundle')).toBe('Bundle');
  });

  it('unrecognized types title-case from snake_case rather than leaking raw code', () => {
    expect(referenceTypeLabel('purchase_order')).toBe('Purchase order');
    expect(referenceTypeLabel('some_future_type')).toBe('Some future type');
  });
});

describe('collectReferenceIdsByType', () => {
  it('groups ids by type, one array per type', () => {
    const rows = [
      { reference_type: 'order_request', reference_id: 'a' },
      { reference_type: 'order_request', reference_id: 'b' },
      { reference_type: 'bundle', reference_id: 'c' },
    ];
    expect(collectReferenceIdsByType(rows)).toEqual({
      order_request: ['a', 'b'],
      bundle: ['c'],
    });
  });

  it('skips rows missing either field', () => {
    const rows = [
      { reference_type: null, reference_id: 'a' },
      { reference_type: 'return', reference_id: null },
      { reference_type: null, reference_id: null },
    ];
    expect(collectReferenceIdsByType(rows)).toEqual({});
  });

  it('empty input returns an empty object', () => {
    expect(collectReferenceIdsByType([])).toEqual({});
  });
});
