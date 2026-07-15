import { describe, expect, it } from 'vitest';

import {
  attachReferenceLabels,
  collectReferenceIdsByType,
  mergeReferenceLabelMaps,
  referenceRoute,
  referenceTypeLabel,
} from './movement-references';

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

// ─────────────────────────────────────────────────────────────────────────
// mergeReferenceLabelMaps + attachReferenceLabels — the previously-untested
// batch-fetch → merge → attach wiring from app/item/[id].tsx's loadMovements
// (Unit 3 review finding). These are the pure, dependency-injected halves of
// that pipeline: callers pass in already-fetched "id → label" maps (what
// resolveOrderNumbers/resolveReturnNumbers/resolveBundleNames — which stay
// in the screen — would have returned), so no Supabase mock is needed.
// ─────────────────────────────────────────────────────────────────────────

describe('mergeReferenceLabelMaps', () => {
  it('merges labels from multiple already-fetched per-type maps into one', () => {
    const order = new Map([['req-1', 'SO-000049']]);
    const ret = new Map([['ret-1', 'RMA-1029']]);
    const bundle = new Map([['bun-1', 'Back-to-School Kit']]);
    const merged = mergeReferenceLabelMaps([order, ret, bundle]);
    expect(merged.get('req-1')).toBe('SO-000049');
    expect(merged.get('ret-1')).toBe('RMA-1029');
    expect(merged.get('bun-1')).toBe('Back-to-School Kit');
    expect(merged.size).toBe(3);
  });

  it('empty maps (and an empty list of maps) merge to an empty map', () => {
    expect(mergeReferenceLabelMaps([new Map(), new Map()]).size).toBe(0);
    expect(mergeReferenceLabelMaps([]).size).toBe(0);
  });

  it('tolerates null/undefined entries without throwing', () => {
    const order = new Map([['req-1', 'SO-000049']]);
    const merged = mergeReferenceLabelMaps([order, undefined, null]);
    expect(merged.get('req-1')).toBe('SO-000049');
    expect(merged.size).toBe(1);
  });
});

describe('attachReferenceLabels', () => {
  it('an order_request movement resolves to the order number label + the native /order/[id] route', () => {
    const rows = [{ id: 'm1', reference_type: 'order_request', reference_id: 'req-1' }];
    const labelById = mergeReferenceLabelMaps([new Map([['req-1', 'SO-000049']])]);
    const [attached] = attachReferenceLabels(rows, labelById);
    expect(attached!.reference_label).toBe('SO-000049');
    expect(referenceRoute(attached!.reference_type, attached!.reference_id)).toBe('/order/req-1');
  });

  it('a bundle movement resolves to the bundle name + the native /bundles/[id] route', () => {
    const rows = [{ id: 'm2', reference_type: 'bundle', reference_id: 'bun-1' }];
    const labelById = mergeReferenceLabelMaps([new Map([['bun-1', 'Back-to-School Kit']])]);
    const [attached] = attachReferenceLabels(rows, labelById);
    expect(attached!.reference_label).toBe('Back-to-School Kit');
    expect(referenceRoute(attached!.reference_type, attached!.reference_id)).toBe('/bundles/bun-1');
  });

  it('a return movement resolves to the return number but stays label-only — no native route', () => {
    const rows = [{ id: 'm3', reference_type: 'return', reference_id: 'ret-1' }];
    const labelById = mergeReferenceLabelMaps([new Map([['ret-1', 'RMA-1029']])]);
    const [attached] = attachReferenceLabels(rows, labelById);
    expect(attached!.reference_label).toBe('RMA-1029');
    expect(referenceRoute(attached!.reference_type, attached!.reference_id)).toBeNull();
  });

  it('a movement with no reference (null type/id) degrades to a null label — nothing to render', () => {
    const rows = [{ id: 'm4', reference_type: null, reference_id: null }];
    const [attached] = attachReferenceLabels(rows, new Map());
    expect(attached!.reference_label).toBeNull();
  });

  it('an empty reference-label map degrades every referenced row to null, never throws', () => {
    const rows = [
      { id: 'm5', reference_type: 'order_request', reference_id: 'req-9' },
      { id: 'm6', reference_type: 'cycle_count', reference_id: 'cc-1' },
    ];
    const attached = attachReferenceLabels(rows, new Map());
    expect(attached.map((r) => r.reference_label)).toEqual([null, null]);
  });

  it('a reference_id present on the movement but ABSENT from the fetched map (deleted row) degrades to null, not a crash', () => {
    // Simulates the order_request this movement points to having been
    // deleted after the movement was recorded: resolveOrderNumbers'
    // batched `.in()` query simply never returns it, so labelById has no
    // entry for 'req-deleted' even though the movement still carries it.
    const rows = [{ id: 'm7', reference_type: 'order_request', reference_id: 'req-deleted' }];
    const labelById = mergeReferenceLabelMaps([new Map([['req-other', 'SO-000001']])]);
    const [attached] = attachReferenceLabels(rows, labelById);
    expect(attached!.reference_label).toBeNull();
    // Still routable — referenceRoute only needs type+id, not a resolved
    // label, so the card can link even when the number couldn't be shown.
    expect(referenceRoute(attached!.reference_type, attached!.reference_id)).toBe(
      '/order/req-deleted',
    );
  });

  it('preserves every other row field untouched (pure attach, no mutation of unrelated data)', () => {
    const rows = [
      { id: 'm8', reference_type: 'bundle', reference_id: 'bun-2', movement_type: 'adjust' },
    ];
    const [attached] = attachReferenceLabels(rows, new Map());
    expect(attached!.id).toBe('m8');
    expect(attached!.movement_type).toBe('adjust');
  });
});
