import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ReportsService } from './reports';
import { ServiceError } from './context';

/**
 * itemCostHistory builds a per-supplier, chronological unit_cost series from
 * two of our OWN tables — purchase_order_items (committed) and receipt_lines
 * (paid) — org-scoped via the ctx client. These tests mock supabase and
 * assert the merge/sort/aggregation logic and the org-scoping filters.
 */
describe('ReportsService.itemCostHistory', () => {
  const ITEM = 'item-1';

  it('merges PO + receipt unit costs into chronological per-supplier series', async () => {
    const stub = makeSupabaseStub({
      'purchase_order_items.select': {
        data: [
          {
            unit_cost: 10,
            purchase_order_id: 'po-1',
            po: {
              id: 'po-1',
              supplier_id: 'sup-a',
              ordered_at: '2026-01-01T00:00:00Z',
              created_at: '2025-12-30T00:00:00Z',
              supplier: { name: 'Acme' },
            },
          },
          {
            unit_cost: 12,
            purchase_order_id: 'po-2',
            po: {
              id: 'po-2',
              supplier_id: 'sup-a',
              ordered_at: '2026-03-01T00:00:00Z',
              created_at: '2026-02-28T00:00:00Z',
              supplier: { name: 'Acme' },
            },
          },
        ],
        error: null,
      },
      'receipt_lines.select': {
        data: [
          {
            unit_cost: 11,
            item_id: ITEM,
            receipt: {
              id: 'rc-1',
              organization_id: 'org-test',
              status: 'posted',
              received_at: '2026-02-01T00:00:00Z',
              po: { supplier_id: 'sup-a', supplier: { name: 'Acme' } },
            },
          },
        ],
        error: null,
      },
    });
    const svc = new ReportsService(makeServiceContext(stub.client));

    const result = await svc.itemCostHistory(ITEM);

    expect(result.itemId).toBe(ITEM);
    expect(result.series).toHaveLength(1);
    const acme = result.series[0]!;
    expect(acme.supplierId).toBe('sup-a');
    expect(acme.supplierName).toBe('Acme');
    // PO(2026-01, 10) → receipt(2026-02, 11) → PO(2026-03, 12), chronological.
    expect(acme.points.map((p) => p.unitCost)).toEqual([10, 11, 12]);
    expect(acme.points.map((p) => p.date)).toEqual([
      '2026-01-01T00:00:00Z',
      '2026-02-01T00:00:00Z',
      '2026-03-01T00:00:00Z',
    ]);
    expect(acme.points.map((p) => p.source)).toEqual([
      'purchase_order',
      'receipt',
      'purchase_order',
    ]);
    // Aggregates across all 3 observations.
    expect(result.pointCount).toBe(3);
    expect(result.lastUnitCost).toBe(12); // newest date
    expect(result.avgUnitCost).toBe((10 + 11 + 12) / 3);
  });

  it('org-scopes both queries — PO by organization_id, receipt_lines via parent receipt', async () => {
    const stub = makeSupabaseStub({
      'purchase_order_items.select': { data: [], error: null },
      'receipt_lines.select': { data: [], error: null },
    });
    const svc = new ReportsService(
      makeServiceContext(stub.client, { organizationId: 'org-9' }),
    );

    await svc.itemCostHistory(ITEM);

    // PO lines: organization_id + item_id eq filters.
    const poArgs = stub.chainArgs.get('purchase_order_items.select') ?? [];
    const poChain = stub.chains.get('purchase_order_items.select') ?? [];
    const poEq = new Map(
      poChain
        .map((m, i) => ({ m, a: poArgs[i] }))
        .filter((c) => c.m === 'eq')
        .map((c) => [c.a![0] as string, c.a![1]]),
    );
    expect(poEq.get('organization_id')).toBe('org-9');
    expect(poEq.get('item_id')).toBe(ITEM);

    // Receipt lines: scoped via the embedded receipt's org + posted status,
    // and filtered to this item.
    const rcArgs = stub.chainArgs.get('receipt_lines.select') ?? [];
    const rcChain = stub.chains.get('receipt_lines.select') ?? [];
    const rcEq = new Map(
      rcChain
        .map((m, i) => ({ m, a: rcArgs[i] }))
        .filter((c) => c.m === 'eq')
        .map((c) => [c.a![0] as string, c.a![1]]),
    );
    expect(rcEq.get('item_id')).toBe(ITEM);
    expect(rcEq.get('receipt.organization_id')).toBe('org-9');
    expect(rcEq.get('receipt.status')).toBe('posted');
  });

  it('separates suppliers and orders series by most-recent observation', async () => {
    const stub = makeSupabaseStub({
      'purchase_order_items.select': {
        data: [
          {
            unit_cost: 5,
            purchase_order_id: 'po-a',
            po: {
              id: 'po-a',
              supplier_id: 'sup-old',
              ordered_at: '2025-01-01T00:00:00Z',
              created_at: '2025-01-01T00:00:00Z',
              supplier: { name: 'Old Co' },
            },
          },
          {
            unit_cost: 7,
            purchase_order_id: 'po-b',
            po: {
              id: 'po-b',
              supplier_id: 'sup-new',
              ordered_at: '2026-05-01T00:00:00Z',
              created_at: '2026-05-01T00:00:00Z',
              supplier: { name: 'New Co' },
            },
          },
        ],
        error: null,
      },
      'receipt_lines.select': { data: [], error: null },
    });
    const svc = new ReportsService(makeServiceContext(stub.client));

    const result = await svc.itemCostHistory(ITEM);

    expect(result.series.map((s) => s.supplierId)).toEqual(['sup-new', 'sup-old']);
    expect(result.series.map((s) => s.supplierName)).toEqual(['New Co', 'Old Co']);
  });

  it('falls back to created_at when a PO has no ordered_at, and buckets null supplier', async () => {
    const stub = makeSupabaseStub({
      'purchase_order_items.select': {
        data: [
          {
            unit_cost: 9,
            purchase_order_id: 'po-x',
            po: {
              id: 'po-x',
              supplier_id: null,
              ordered_at: null,
              created_at: '2026-04-15T00:00:00Z',
              supplier: null,
            },
          },
        ],
        error: null,
      },
      'receipt_lines.select': { data: [], error: null },
    });
    const svc = new ReportsService(makeServiceContext(stub.client));

    const result = await svc.itemCostHistory(ITEM);

    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.supplierId).toBe('__none');
    expect(result.series[0]!.supplierName).toBe('No supplier');
    expect(result.series[0]!.points[0]!.date).toBe('2026-04-15T00:00:00Z');
  });

  it('flattens PostgREST array embeds and skips receipt rows the join filtered out', async () => {
    const stub = makeSupabaseStub({
      'purchase_order_items.select': {
        data: [
          {
            unit_cost: 8,
            purchase_order_id: 'po-1',
            // PostgREST sometimes returns embeds as single-element arrays.
            po: [
              {
                id: 'po-1',
                supplier_id: 'sup-a',
                ordered_at: '2026-01-01T00:00:00Z',
                created_at: '2026-01-01T00:00:00Z',
                supplier: [{ name: 'Acme' }],
              },
            ],
          },
        ],
        error: null,
      },
      'receipt_lines.select': {
        data: [
          // receipt === null means the embedded-join org/status filter
          // excluded this row — must be skipped, not crash.
          { unit_cost: 999, item_id: ITEM, receipt: null },
        ],
        error: null,
      },
    });
    const svc = new ReportsService(makeServiceContext(stub.client));

    const result = await svc.itemCostHistory(ITEM);

    expect(result.pointCount).toBe(1);
    expect(result.series[0]!.supplierName).toBe('Acme');
    expect(result.series[0]!.points[0]!.unitCost).toBe(8);
  });

  it('returns empty series + null aggregates when there is no cost history', async () => {
    const stub = makeSupabaseStub({
      'purchase_order_items.select': { data: [], error: null },
      'receipt_lines.select': { data: [], error: null },
    });
    const svc = new ReportsService(makeServiceContext(stub.client));

    const result = await svc.itemCostHistory(ITEM);

    expect(result.series).toEqual([]);
    expect(result.lastUnitCost).toBeNull();
    expect(result.avgUnitCost).toBeNull();
    expect(result.pointCount).toBe(0);
  });

  it('throws ServiceError when the PO query errors', async () => {
    const stub = makeSupabaseStub({
      'purchase_order_items.select': { data: null, error: { message: 'boom' } },
      'receipt_lines.select': { data: [], error: null },
    });
    const svc = new ReportsService(makeServiceContext(stub.client));

    await expect(svc.itemCostHistory(ITEM)).rejects.toBeInstanceOf(ServiceError);
  });
});
