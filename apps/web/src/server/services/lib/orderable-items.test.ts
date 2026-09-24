import { describe, expect, it } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { whereOrderableItem, whereReorderCandidate } from './orderable-items';

// The one predicate the reorder reads share (planning, the reorder-forecast
// report, "Draft PO from suggestions" and the daily auto-reorder) and the one
// the explicit Items selection and the recurring-PO cron use. Each call site
// has its own chain assertion; this pins the predicate itself, by the filters
// it applies and by the rows those filters leave.

const ORG = 'org-test';

/** One inventory_items row, orderable and a reorder candidate unless overridden. */
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  organization_id: ORG,
  deleted_at: null,
  is_bundle: false,
  status: 'active',
  is_rental: false,
  reorder_point: 5,
  ...over,
});

const ROWS = [
  row('plain'),
  row('kit', { is_bundle: true }), // a kit's pre-assembled stock
  row('deleted', { deleted_at: '2026-09-01T00:00:00Z' }),
  row('archived', { status: 'archived' }),
  row('rental', { is_rental: true }),
  row('no-point', { reorder_point: 0 }),
  row('other-org', { organization_id: 'org-other' }),
];

async function idsFor(apply: (q: never) => unknown): Promise<string[]> {
  const stub = makeSupabaseStub({ 'inventory_items.select': servedLikePostgrest(ROWS) });
  const q = apply(stub.client.from('inventory_items').select('id') as never) as PromiseLike<{
    data: Array<{ id: string }>;
  }>;
  const { data } = await q;
  return data.map((r) => r.id).sort();
}

function filtersOf(apply: (q: never) => unknown): Array<[string, unknown[]]> {
  const stub = makeSupabaseStub({});
  apply(stub.client.from('inventory_items').select('id') as never);
  const methods = stub.chains.get('inventory_items.select') ?? [];
  const args = stub.chainArgs.get('inventory_items.select') ?? [];
  return methods.map((m, i) => [m, args[i] ?? []] as [string, unknown[]]).filter(([m]) => m !== 'select');
}

describe('whereOrderableItem', () => {
  it('keeps this org\'s items that are not deleted and not a kit\'s pre-assembled stock', async () => {
    expect(filtersOf((q) => whereOrderableItem(q, ORG))).toEqual([
      ['eq', ['organization_id', ORG]],
      ['is', ['deleted_at', null]],
      ['eq', ['is_bundle', false]],
    ]);
    // Archived, rental and no-reorder-point items stay orderable: a buyer may
    // choose them explicitly.
    expect(await idsFor((q) => whereOrderableItem(q, ORG))).toEqual(
      ['archived', 'no-point', 'plain', 'rental'].sort(),
    );
  });
});

describe('whereReorderCandidate', () => {
  it('adds active and not-a-rental, and a reorder point only when asked', async () => {
    expect(filtersOf((q) => whereReorderCandidate(q, ORG, { withReorderPoint: true }))).toEqual([
      ['eq', ['organization_id', ORG]],
      ['is', ['deleted_at', null]],
      ['eq', ['is_bundle', false]],
      ['eq', ['status', 'active']],
      ['eq', ['is_rental', false]],
      ['gt', ['reorder_point', 0]],
    ]);
    expect(await idsFor((q) => whereReorderCandidate(q, ORG, { withReorderPoint: true }))).toEqual([
      'plain',
    ]);
    // Planning ranks every candidate, including ones with no reorder point yet.
    expect(await idsFor((q) => whereReorderCandidate(q, ORG, { withReorderPoint: false }))).toEqual(
      ['no-point', 'plain'].sort(),
    );
  });
});
