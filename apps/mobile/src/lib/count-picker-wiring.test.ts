import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Embedded cycle-count picker — WIRING PINS for app/cycle-count/new.tsx.
 * The query PLAN is pure + tested in count-picker.test.ts, but the screen
 * applies it to the Supabase builder inline (the vitest config deliberately
 * excludes app/ screens from compilation — same seam as
 * expected-exclusion-screens.test.ts). These source-level assertions pin
 * the load-bearing wiring so a refactor can't silently drop it:
 *
 *   1. the screen queries through the tested plan (countPickerPlan) and
 *      applies ALL of its visibility predicates — active lifecycle, not
 *      deleted, not awaiting first receipt, workspace warehouse scope;
 *   2. checked state reads/writes the SHARED count-selection store, so the
 *      legacy Items/Books select-mode path converges (arrives pre-checked);
 *   3. the dead-end "go to Items and come back" copy is gone.
 */

const screen = readFileSync(
  path.resolve(__dirname, '../../app/cycle-count/new.tsx'),
  'utf8',
);

describe('cycle-count/new.tsx — embedded picker wiring (mobile twin of 7b738cdc)', () => {
  it('queries through the tested plan and applies every visibility predicate', () => {
    expect(screen).toContain('countPickerPlan(tab, q, offset)');
    expect(screen).toContain(".eq('awaiting_first_receipt', plan.awaitingFirstReceipt)");
    expect(screen).toContain(".is('deleted_at', null)");
    expect(screen).toContain(".eq('status', plan.lifecycle)");
    expect(screen).toContain('.range(plan.range.from, plan.range.to)');
    // Word-AND search: every plan or-group must reach the builder.
    expect(screen).toContain('for (const group of plan.orGroups) req = req.or(group);');
  });

  it('scopes to the workspace warehouse, matching the tabs\' select-mode path', () => {
    expect(screen).toContain("if (activeWarehouseId) req = req.eq('warehouse_id', activeWarehouseId);");
  });

  it('checked state IS the shared count-selection store (both entry paths converge)', () => {
    // Toggling writes the store the Items/Books select-mode uses…
    expect(screen).toContain('countSelection.toggle(pickFromRow(row))');
    // …and each row subscribes per-id, so Items-tab picks arrive pre-checked.
    expect(screen).toContain('useIsPicked(row.id)');
  });

  it('the dead-end copy is gone and Start stays disabled at zero picks', () => {
    expect(screen).not.toContain('Go to Items or Books');
    expect(screen).not.toContain('then come back');
    expect(screen).toContain('disabled={busy || picks.length === 0}');
    // The unchanged start contract: scope='selection' via POST /api/v1/cycle-counts.
    expect(screen).toContain("scope: 'selection'");
    expect(screen).toContain("'/api/v1/cycle-counts'");
  });
});
