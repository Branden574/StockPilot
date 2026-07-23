import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  initialMoveQuantity,
  initialMoveQuantityForSource,
  moveDestinationChoices,
  moveDestinationScope,
  resolveMoveSource,
  type MoveDestination,
  type MoveHolding,
} from './move-stock-form';

/**
 * Native put-away — the hazards that used to be expressible, and the reason
 * each one no longer is.
 *
 * REWRITTEN, deliberately: the earlier version of this file tested a put-away
 * built on DEFAULTS (preselect the tapped holding, scope destinations to a
 * warehouse the caller passed alongside it). Those defaults were the design
 * error. Put-away now FIXES the source to the tapped worklist row, like the web
 * dialog (apps/web/src/components/inventory/place-from-staging-dialog.tsx),
 * which has no source picker at all. Every assertion the old file made is still
 * made here — the whole-holding quantity, the one-warehouse destination list,
 * the untouched free-form transfer — but against the new shape, plus the four
 * moves that are now unexpressible rather than merely guarded.
 *
 * The modal cannot be rendered under vitest (it imports native modules at
 * load), so the "is the modal actually wired to this" half is a source pin.
 */

const modal = readFileSync(
  path.resolve(__dirname, '../components/move-stock-modal.tsx'),
  'utf8',
);
const itemScreen = readFileSync(path.resolve(__dirname, '../../app/item/[id].tsx'), 'utf8');
const stagingScreen = readFileSync(
  path.resolve(__dirname, '../../app/(drawer)/staging.tsx'),
  'utf8',
);

const STAGED: MoveHolding = {
  locationId: 'staging-wh1',
  name: 'Staging',
  kind: 'staging',
  quantity: 20,
  warehouseId: 'wh-1',
};
const OTHER_BUILDING: MoveHolding = {
  locationId: 'rack-wh2',
  name: 'Rack B2',
  kind: 'rack',
  quantity: 400,
  warehouseId: 'wh-2',
};

// ── HAZARD 1 (critical): a cross-warehouse move expressed via the FROM chips ──

describe('hazard: put-away cannot move a DIFFERENT warehouse\'s stock', () => {
  it('resolves put-away to a FIXED source, not a preselection', () => {
    // The old shape returned "the holding to start on"; the user could then tap
    // another chip and keep the first row's destination scope. The resolution
    // now carries the mode, and 'fixed' is what the modal keys the chipless
    // FROM field off.
    const src = resolveMoveSource([STAGED, OTHER_BUILDING], {
      putAwaySourceLocationId: 'staging-wh1',
    });
    expect(src).toEqual({ mode: 'fixed', holding: STAGED });
  });

  it('renders no source picker in put-away mode, so there is nothing to switch', () => {
    // Impossible-by-construction, not guarded: `fromId` reads off the fixed
    // holding and ignores the free-form selection entirely, and the chip list
    // only exists in the else-branch of `fixedSource ? … : …`.
    expect(modal).toContain('const fromId = fixedSource ? fixedSource.locationId : chosenFromId;');
    expect(modal).toContain('{fixedSource ? (');
    // Three calls to the free-form setter and no more: the on-open reset, the
    // initial resolution, and the chip's own onPress. Any fourth would be a way
    // to change the source — which in put-away mode is precisely the move that
    // must not exist. (It would still be inert, since `fromId` above ignores it
    // when a source is fixed; this pins that no one has rewired `fromId` too.)
    expect(modal.match(/setChosenFromId\(/g) ?? []).toHaveLength(3);
    expect(modal).toContain('setChosenFromId(h.locationId);');
    // …and no other code path assigns the source id.
    expect(modal).not.toContain('setFromId(');
  });

  it('keeps the free-form transfer\'s source picker exactly as it was', () => {
    const src = resolveMoveSource([OTHER_BUILDING, STAGED]);
    expect(src).toEqual({ mode: 'choice', holding: OTHER_BUILDING });
    // Every warehouse still offered when nothing is fixed.
    expect(moveDestinationScope(src)).toEqual({ kind: 'all' });
  });
});

// ── HAZARD 2: destination scope pinned to a separately-remembered row ────────

describe('hazard: the destination scope disagreeing with the actual source', () => {
  it('derives the scope from the FIXED holding itself', () => {
    const src = resolveMoveSource([STAGED, OTHER_BUILDING], {
      putAwaySourceLocationId: 'rack-wh2',
    });
    // Scope follows the holding that is actually being emptied — wh-2 here —
    // because it is read off that holding, not off a warehouse id the caller
    // remembered next to a row id.
    expect(moveDestinationScope(src)).toEqual({ kind: 'warehouse', warehouseId: 'wh-2' });
  });

  it('offers no destinations at all for a holding with no warehouse', () => {
    // 'no warehouse' and 'every warehouse' are opposite answers; a nullable id
    // spelled them the same way, which is how an out-of-warehouse rack could
    // reappear in a put-away picker.
    const src = resolveMoveSource([{ ...STAGED, warehouseId: null }], {
      putAwaySourceLocationId: 'staging-wh1',
    });
    expect(moveDestinationScope(src)).toEqual({ kind: 'none' });
    expect(
      moveDestinationChoices(
        [{ id: 'rack-a', name: 'Rack A1', kind: 'rack', warehouseId: 'wh-1' }],
        { scope: { kind: 'none' } },
      ),
    ).toEqual([]);
  });

  it('takes the scope from the resolution in the modal, at query AND at render', () => {
    expect(modal).toContain('const scope = moveDestinationScope(resolved);');
    expect(modal).toContain("destQuery.eq('warehouse_id', scope.warehouseId);");
    expect(modal).toContain('scope: source ? moveDestinationScope(source) : { kind: \'none\' },');
    // The old, forgeable prop is gone from both the modal and its caller.
    expect(modal).not.toContain('restrictToWarehouseId');
    expect(stagingScreen).not.toContain('restrictToWarehouseId');
  });
});

// ── HAZARD 3: silent fallback to an unrelated holding ───────────────────────

describe('hazard: a stale worklist row becoming a different move', () => {
  it('refuses instead of substituting another holding', () => {
    // Someone else placed the staged pile between the list load and the tap.
    // The item still holds 400 units in another building; falling back to that
    // armed a one-tap whole-holding move of stock nobody asked about.
    const src = resolveMoveSource([OTHER_BUILDING], {
      putAwaySourceLocationId: 'staging-wh1',
    });
    expect(src).toEqual({ mode: 'missing' });
    expect(moveDestinationScope(src)).toEqual({ kind: 'none' });
  });

  it('refuses when the item holds nothing at all', () => {
    expect(resolveMoveSource([], { putAwaySourceLocationId: 'staging-wh1' })).toEqual({
      mode: 'missing',
    });
  });

  it('says so in the sheet rather than opening a form', () => {
    expect(modal).toContain('const sourceMissing = source?.mode === \'missing\';');
    expect(modal).toContain(') : sourceMissing ? (');
    expect(modal).toContain('This stock is no longer in that location');
    // There is no `?? holdings[0]` left anywhere in the source resolution.
    expect(modal).not.toContain('?? hs[0]');
    expect(modal).not.toContain('preselected ?? ');
  });
});

// ── HAZARD 4: a whole-holding quantity with an ambiguous subject ─────────────

describe('hazard: the whole-holding default landing on the wrong pile', () => {
  it('seeds from the FIXED holding, and only from it', () => {
    const src = resolveMoveSource([STAGED, OTHER_BUILDING], {
      putAwaySourceLocationId: 'staging-wh1',
    });
    // 20, the tapped row — never 400, the other building's pile.
    expect(initialMoveQuantityForSource(src)).toBe('20');
  });

  it('seeds nothing dangerous when the source is missing', () => {
    expect(
      initialMoveQuantityForSource(
        resolveMoveSource([OTHER_BUILDING], { putAwaySourceLocationId: 'staging-wh1' }),
      ),
    ).toBe('1');
  });

  it('leaves the item screen\'s free-form transfer at 1', () => {
    expect(initialMoveQuantityForSource(resolveMoveSource([OTHER_BUILDING]))).toBe('1');
    expect(initialMoveQuantity(20, { wholeHolding: false })).toBe('1');
    expect(initialMoveQuantity(0, { wholeHolding: false })).toBe('1');
  });

  it('never seeds a value the submit gate would reject', () => {
    // 0/negative/unknown would disable the button with no explanation.
    expect(initialMoveQuantity(0, { wholeHolding: true })).toBe('1');
    expect(initialMoveQuantity(-4, { wholeHolding: true })).toBe('1');
    expect(initialMoveQuantity(null, { wholeHolding: true })).toBe('1');
    expect(initialMoveQuantity(undefined, { wholeHolding: true })).toBe('1');
    expect(initialMoveQuantity(Number.NaN, { wholeHolding: true })).toBe('1');
    // Fractional holdings floor rather than putting "7.5" in a number-pad field.
    expect(initialMoveQuantity(7.5, { wholeHolding: true })).toBe('7');
    expect(initialMoveQuantity(1, { wholeHolding: true })).toBe('1');
    expect(initialMoveQuantity(20, { wholeHolding: true })).toBe('20');
  });

  it('is seeded through the resolution in the modal, not a loose number', () => {
    expect(modal).toContain('setQty(initialMoveQuantityForSource(resolved));');
    // The free-form re-seed on a chip tap stays at 1 — the whole-holding default
    // belongs to a mode that has no chips.
    expect(modal).toContain(
      'setQty(initialMoveQuantity(h.quantity, { wholeHolding: false }));',
    );
    expect(modal).not.toContain('defaultWholeHolding');
  });
});

// ── The destination list itself (unchanged behaviour, new scope shape) ───────

describe('moveDestinationChoices — put-away stays inside one warehouse', () => {
  const dests: MoveDestination[] = [
    { id: 'rack-a', name: 'Rack A1', kind: 'rack', warehouseId: 'wh-1' },
    { id: 'rack-b', name: 'Rack B2', kind: 'rack', warehouseId: 'wh-2' },
    { id: 'crate-c', name: 'Crate C', kind: 'crate', warehouseId: 'wh-1' },
    { id: 'orphan', name: 'Orphan rack', kind: 'rack', warehouseId: null },
  ];

  it('offers only racks in the source holding\'s warehouse', () => {
    expect(
      moveDestinationChoices(dests, {
        scope: { kind: 'warehouse', warehouseId: 'wh-1' },
      }).map((d) => d.id),
    ).toEqual(['rack-a', 'crate-c']);
  });

  it('drops a destination with no warehouse when scoped', () => {
    // An unattributed location cannot be shown to be in the right building.
    expect(
      moveDestinationChoices(dests, {
        scope: { kind: 'warehouse', warehouseId: 'wh-2' },
      }).map((d) => d.id),
    ).toEqual(['rack-b']);
  });

  it('keeps every warehouse for the unscoped item-screen transfer', () => {
    expect(moveDestinationChoices(dests).map((d) => d.id)).toEqual([
      'rack-a',
      'rack-b',
      'crate-c',
      'orphan',
    ]);
    expect(moveDestinationChoices(dests, { scope: { kind: 'all' } })).toHaveLength(4);
  });

  it('never offers the source location as its own destination', () => {
    expect(
      moveDestinationChoices(dests, {
        excludeLocationId: 'rack-a',
        scope: { kind: 'warehouse', warehouseId: 'wh-1' },
      }).map((d) => d.id),
    ).toEqual(['crate-c']);
    expect(
      moveDestinationChoices(dests, { excludeLocationId: 'rack-b' }).map((d) => d.id),
    ).not.toContain('rack-b');
  });
});

// ── The other caller must not have changed ──────────────────────────────────

describe('the item screen\'s free-form Move stock is untouched', () => {
  it('passes none of the put-away props — it opts in to nothing', () => {
    expect(itemScreen).not.toContain('putAwaySourceLocationId');
    expect(itemScreen).not.toContain('initialFromLocationId');
    expect(itemScreen).not.toContain('restrictToWarehouseId');
    expect(itemScreen).not.toContain('defaultWholeHolding');
  });

  it('still passes exactly the props it always did', () => {
    // Whitespace-insensitive: the JSX block, prop for prop.
    const call = itemScreen.slice(itemScreen.indexOf('<MoveStockModal'));
    const props = (call.slice(0, call.indexOf('/>')).match(/^\s*(\w+)=/gm) ?? []).map((p) =>
      p.trim().replace('=', ''),
    );
    expect(props).toEqual([
      'visible',
      'itemId',
      'itemName',
      'itemType',
      'organizationId',
      'canCreateLocation',
      'onClose',
      'onMoved',
    ]);
  });

  it('is opt-in at the type level: put-away mode needs a source id', () => {
    // The mode is not a boolean anyone can forget to pair with an id; the id IS
    // the mode, so "put-away without a fixed source" is not a state.
    expect(modal).toContain('putAwaySourceLocationId?: string;');
    expect(modal).toContain('resolveMoveSource(hs, { putAwaySourceLocationId })');
  });
});

// ── The write path stays the permission-checked route ───────────────────────

describe('the write still goes through the transfer route', () => {
  it('uses transferStock(), never the RPC', () => {
    expect(modal).toContain('await transferStock(itemId, {');
    expect(modal).not.toContain('transfer_stock');
    expect(modal).not.toContain('.rpc(');
  });
});
