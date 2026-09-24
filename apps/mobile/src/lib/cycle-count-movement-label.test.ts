import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatCycleCountNumber } from '@stockpilot/core';

import { attachReferenceLabels, mergeReferenceLabelMaps, referenceRoute } from './movement-references';

/**
 * A stock movement posted by a cycle count names the count by its reference
 * (CC-000042, server 0358) in the item's Movements and Activity tabs, and
 * still opens the native count. The batched lookup lives in app/item/[id].tsx
 * (not loadable in node), so its wiring is pinned by source text; the label
 * merge and attach are the pure halves exercised here.
 */
const itemScreen = readFileSync(path.join(__dirname, '../../app/item/[id].tsx'), 'utf8');

describe('cycle-count references in item history', () => {
  it('the item screen resolves this page\'s cycle-count ids in the same batch as the others', () => {
    expect(itemScreen).toMatch(/resolveCycleCountNumbers\(orgId, idsByType\.cycle_count \?\? \[\]\)/);
    expect(itemScreen).toMatch(/mergeReferenceLabelMaps\(\[[\s\S]*cycleCountLabels,[\s\S]*\]\)/);
    expect(itemScreen).toMatch(/\.from\('cycle_counts'\)\s*\.select\('id, count_number'\)\s*\.eq\('organization_id', orgId\)/);
  });

  it('labels the movement with the reference and keeps the route by id', () => {
    const labels = mergeReferenceLabelMaps([new Map([['cc-1', formatCycleCountNumber(42)!]])]);
    const [row] = attachReferenceLabels([{ id: 'm1', reference_type: 'cycle_count', reference_id: 'cc-1' }], labels);
    expect(row!.reference_label).toBe('CC-000042');
    expect(referenceRoute(row!.reference_type, row!.reference_id)).toBe('/cycle-count/cc-1');
  });
});
