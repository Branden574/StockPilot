import { describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { PoImportsService } from './po-imports';

/**
 * Re-import lineage resolution (migs 0286/0287).
 *
 * A PO import is fingerprinted by file sha256. When the purchase order an
 * import produced is cancelled, the file may be imported again: the NEW import
 * carries reimported_from_id pointing at its predecessor, and the OLD import is
 * stamped superseded_at. Neither column changes status, so nothing in the UI
 * could tell the two apart from an ordinary approved import.
 *
 * get() resolves both edges for display. The invariant this file guards hardest
 * is the COST: an import with neither column set must issue no extra query at
 * all, and an import with lineage must issue at most two.
 */

const SELF = '11111111-1111-1111-1111-111111111111';
const PRED = '22222222-2222-2222-2222-222222222222';
const SUCC = '33333333-3333-3333-3333-333333333333';

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (PoImportsService as unknown as new (ctx: unknown) => PoImportsService)(
    makeServiceContext(stub.client, {
      role: 'admin',
      organizationId: 'org-1',
      enabledModules: new Set<ModuleId>(['po_imports']),
    }),
  );
}

/** The header read uses .maybeSingle(), which the stub keys separately from the
 *  plain awaited lineage select — so the two po_imports reads stay distinct
 *  without any call counting. */
function stubGet(
  header: Record<string, unknown>,
  siblings: Array<Record<string, unknown>> = [],
  pos: Array<Record<string, unknown>> = [],
  overrides: Record<string, { data: unknown; error: { message: string } | null }> = {},
) {
  return makeSupabaseStub({
    'po_imports.select.maybeSingle': { data: header, error: null },
    'po_imports.select': { data: siblings, error: null },
    'po_import_lines.select': { data: [], error: null },
    'purchase_orders.select': { data: pos, error: null },
    ...overrides,
  });
}

function baseHeader(over: Record<string, unknown> = {}) {
  return {
    id: SELF,
    organization_id: 'org-1',
    file_name: 'PO-CVW-002201.pdf',
    status: 'approved',
    approved_po_id: null,
    reimported_from_id: null,
    superseded_at: null,
    created_at: '2026-07-20T00:00:00Z',
    ...over,
  };
}

/** Flattened chain args for a (table, op), so a test can assert a filter was used. */
function argsFor(stub: ReturnType<typeof makeSupabaseStub>, key: string, index: number) {
  const all = stub.chainArgsAll.get(key);
  return all?.[index] ?? [];
}

describe('PoImportsService.get — re-import lineage', () => {
  it('pays NOTHING when neither lineage column is set', async () => {
    const stub = stubGet(baseHeader());
    const res = await svc(stub).get(SELF);

    expect(res.lineage).toEqual({ predecessor: null, successors: [] });
    // The header read is the ONLY po_imports query, and purchase_orders is
    // never touched. This is the regression a future refactor breaks silently.
    expect(stub.fromCalls.filter((t) => t === 'po_imports')).toHaveLength(1);
    expect(stub.fromCalls).not.toContain('purchase_orders');
  });

  it('resolves the predecessor and its cancelled PO on a re-import', async () => {
    const stub = stubGet(
      baseHeader({ reimported_from_id: PRED }),
      [
        {
          id: PRED,
          file_name: 'PO-CVW-002201.pdf',
          display_name: 'July Curriculum Restock',
          created_at: '2026-07-01T00:00:00Z',
          status: 'approved',
          approved_po_id: 'po-1',
          reimported_from_id: null,
        },
      ],
      [{ id: 'po-1', po_number: 'CVW-002201', status: 'cancelled' }],
    );
    const res = await svc(stub).get(SELF);

    expect(res.lineage.predecessor).toEqual({
      id: PRED,
      fileName: 'PO-CVW-002201.pdf',
      // mig 0333: the human name rides along so the lineage notice can label
      // the predecessor by it instead of the raw camera filename.
      displayName: 'July Curriculum Restock',
      createdAt: '2026-07-01T00:00:00Z',
      status: 'approved',
      poId: 'po-1',
      poNumber: 'CVW-002201',
      poStatus: 'cancelled',
    });
    expect(res.lineage.successors).toEqual([]);
    // Single-direction lookup: matched by id, no .or() tree.
    expect(argsFor(stub, 'po_imports.select', 1)).toContainEqual(['id', PRED]);
    expect(stub.chainsAll.get('po_imports.select')?.[1]).not.toContain('or');
  });

  it('resolves the successor via the reverse FK on a superseded import', async () => {
    const stub = stubGet(
      baseHeader({ superseded_at: '2026-07-21T00:00:00Z', approved_po_id: 'po-1' }),
      [
        {
          id: SUCC,
          file_name: 'PO-CVW-002201.pdf',
          created_at: '2026-07-21T00:00:00Z',
          status: 'parsed',
          approved_po_id: null,
          reimported_from_id: SELF,
        },
      ],
    );
    const res = await svc(stub).get(SELF);

    expect(res.lineage.predecessor).toBeNull();
    expect(res.lineage.successors).toHaveLength(1);
    expect(res.lineage.successors[0]?.id).toBe(SUCC);
    expect(res.lineage.successors[0]?.poNumber).toBeNull();
    // Reverse-FK form, not .or().
    expect(argsFor(stub, 'po_imports.select', 1)).toContainEqual(['reimported_from_id', SELF]);
    // No successor has an approved_po_id, so the PO lookup is skipped entirely.
    expect(stub.fromCalls).not.toContain('purchase_orders');
  });

  it('returns BOTH directions for an import in the middle of a chain', async () => {
    const stub = stubGet(
      baseHeader({
        reimported_from_id: PRED,
        superseded_at: '2026-07-21T00:00:00Z',
        approved_po_id: 'po-2',
      }),
      [
        {
          id: PRED,
          file_name: 'PO-CVW-002201.pdf',
          created_at: '2026-07-01T00:00:00Z',
          status: 'approved',
          approved_po_id: 'po-1',
          reimported_from_id: null,
        },
        {
          id: SUCC,
          file_name: 'PO-CVW-002201.pdf',
          created_at: '2026-07-21T00:00:00Z',
          status: 'approved',
          approved_po_id: 'po-3',
          reimported_from_id: SELF,
        },
      ],
      [
        { id: 'po-1', po_number: 'CVW-002201', status: 'cancelled' },
        { id: 'po-3', po_number: 'CVW-002299', status: 'active' },
      ],
    );
    const res = await svc(stub).get(SELF);

    expect(res.lineage.predecessor?.id).toBe(PRED);
    expect(res.lineage.predecessor?.poStatus).toBe('cancelled');
    expect(res.lineage.successors).toHaveLength(1);
    expect(res.lineage.successors[0]?.id).toBe(SUCC);
    expect(res.lineage.successors[0]?.poNumber).toBe('CVW-002299');
    // The row matched by id must NOT also be counted as a successor.
    expect(res.lineage.successors.map((s) => s.id)).not.toContain(PRED);
    // Both directions in ONE query: the .or() form.
    const chain = stub.chainsAll.get('po_imports.select')?.[1] ?? [];
    expect(chain).toContain('or');
    expect(argsFor(stub, 'po_imports.select', 1)).toContainEqual([
      `id.eq.${PRED},reimported_from_id.eq.${SELF}`,
    ]);
  });

  it('spends at most two extra queries even with both directions live', async () => {
    const stub = stubGet(
      baseHeader({ reimported_from_id: PRED, superseded_at: '2026-07-21T00:00:00Z' }),
      [
        {
          id: PRED,
          file_name: 'a.pdf',
          created_at: '2026-07-01T00:00:00Z',
          status: 'approved',
          approved_po_id: 'po-1',
          reimported_from_id: null,
        },
        {
          id: SUCC,
          file_name: 'a.pdf',
          created_at: '2026-07-21T00:00:00Z',
          status: 'approved',
          approved_po_id: 'po-3',
          reimported_from_id: SELF,
        },
      ],
      [{ id: 'po-1', po_number: 'CVW-002201', status: 'cancelled' }],
    );
    await svc(stub).get(SELF);

    // 1 header + 1 lineage read, and exactly one PO lookup for both refs.
    expect(stub.fromCalls.filter((t) => t === 'po_imports')).toHaveLength(2);
    expect(stub.fromCalls.filter((t) => t === 'purchase_orders')).toHaveLength(1);
  });

  it('org-scopes both lineage queries', async () => {
    const stub = stubGet(
      baseHeader({ reimported_from_id: PRED }),
      [
        {
          id: PRED,
          file_name: 'a.pdf',
          created_at: '2026-07-01T00:00:00Z',
          status: 'approved',
          approved_po_id: 'po-1',
          reimported_from_id: null,
        },
      ],
      [{ id: 'po-1', po_number: 'CVW-002201', status: 'cancelled' }],
    );
    await svc(stub).get(SELF);

    expect(argsFor(stub, 'po_imports.select', 1)).toContainEqual(['organization_id', 'org-1']);
    expect(argsFor(stub, 'purchase_orders.select', 0)).toContainEqual([
      'organization_id',
      'org-1',
    ]);
  });

  it('degrades to no lineage when the lineage query fails, never throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = stubGet(baseHeader({ reimported_from_id: PRED }), [], [], {
      'po_imports.select': { data: null, error: { message: 'boom' } },
    });

    const res = await svc(stub).get(SELF);

    expect(res.header.id).toBe(SELF);
    expect(res.lineage).toEqual({ predecessor: null, successors: [] });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('handles a superseded import whose successor row is gone', async () => {
    const stub = stubGet(baseHeader({ superseded_at: '2026-07-21T00:00:00Z' }), []);
    const res = await svc(stub).get(SELF);

    expect(res.lineage).toEqual({ predecessor: null, successors: [] });
    expect(stub.fromCalls).not.toContain('purchase_orders');
  });

  it('never interpolates a non-uuid reimported_from_id into the .or() filter', async () => {
    const junk = 'not-a-uuid,or(evil.eq.1)';
    const stub = stubGet(
      baseHeader({ reimported_from_id: junk, superseded_at: '2026-07-21T00:00:00Z' }),
      [],
    );
    await svc(stub).get(SELF);

    const chain = stub.chainsAll.get('po_imports.select')?.[1] ?? [];
    expect(chain).not.toContain('or');
    // Falls back to the successor-only form rather than building a filter
    // string out of an untrusted value.
    expect(argsFor(stub, 'po_imports.select', 1)).toContainEqual(['reimported_from_id', SELF]);
    expect(JSON.stringify(argsFor(stub, 'po_imports.select', 1))).not.toContain('evil');
  });
});
