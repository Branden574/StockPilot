import { describe, expect, it } from 'vitest';

import { dedupeItemsBySku } from './dedupe-items';

function row(id: string, sku: string | null, createdAt: string, extra: Record<string, unknown> = {}) {
  return { id, sku, createdAt, name: `Item ${id}`, ...extra };
}

describe('dedupeItemsBySku', () => {
  it('collapses same-SKU rows to the OLDEST row (min createdAt)', () => {
    const oldest = row('c', 'SP-8N8LR-8ND', '2024-01-01T00:00:00Z');
    const mid = row('a', 'SP-8N8LR-8ND', '2025-06-01T00:00:00Z');
    const newest = row('b', 'SP-8N8LR-8ND', '2026-01-01T00:00:00Z');
    // Oldest deliberately NOT first in the input.
    expect(dedupeItemsBySku([mid, newest, oldest])).toEqual([oldest]);
  });

  it('normalizes SKUs with lower(trim()) — case/whitespace variants group together', () => {
    const older = row('a', '  sku-1 ', '2024-01-01T00:00:00Z');
    const newer = row('b', 'SKU-1', '2025-01-01T00:00:00Z');
    const result = dedupeItemsBySku([newer, older]);
    expect(result).toEqual([older]);
  });

  it('never groups rows with empty/null/whitespace SKUs — each stands alone', () => {
    const a = row('a', '', '2024-01-01T00:00:00Z');
    const b = row('b', '', '2025-01-01T00:00:00Z');
    const c = row('c', null, '2024-01-01T00:00:00Z');
    const d = row('d', '   ', '2024-01-01T00:00:00Z');
    expect(dedupeItemsBySku([a, b, c, d])).toEqual([a, b, c, d]);
  });

  it('tie-breaks equal createdAt by ascending id, deterministically for any input order', () => {
    const winner = row('item-1', 'SKU-T', '2025-01-01T00:00:00Z');
    const loser = row('item-2', 'SKU-T', '2025-01-01T00:00:00Z');
    expect(dedupeItemsBySku([winner, loser])).toEqual([winner]);
    expect(dedupeItemsBySku([loser, winner])).toEqual([winner]);
  });

  it('preserves ungrouped rows and first-appearance order', () => {
    const solo1 = row('s1', 'SKU-A', '2024-01-01T00:00:00Z');
    const dupNew = row('d2', 'SKU-B', '2026-01-01T00:00:00Z');
    const solo2 = row('s2', 'SKU-C', '2024-01-01T00:00:00Z');
    const dupOld = row('d1', 'SKU-B', '2024-01-01T00:00:00Z');
    // Group slot stays where SKU-B first appeared, but holds the oldest row.
    expect(dedupeItemsBySku([solo1, dupNew, solo2, dupOld])).toEqual([solo1, dupOld, solo2]);
  });

  it('an unparseable createdAt never beats a real timestamp', () => {
    const real = row('b', 'SKU-X', '2026-01-01T00:00:00Z');
    const junk = row('a', 'SKU-X', 'not-a-date');
    expect(dedupeItemsBySku([junk, real])).toEqual([real]);
  });

  it('returns extra fields of the winning row untouched (pure pass-through)', () => {
    const older = row('a', 'SKU-1', '2024-01-01T00:00:00Z', { quantityOnHand: 7 });
    const newer = row('b', 'SKU-1', '2025-01-01T00:00:00Z', { quantityOnHand: 3 });
    expect(dedupeItemsBySku([newer, older])).toEqual([older]);
  });
});
