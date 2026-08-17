import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bookCrateAlertMessage,
  bookCrateRefusal,
  bookDestination,
  bookDestinationIsRecordedStorage,
  bookDestinationNeedsMint,
  bookRackRefusal,
  canMintPlacementDestination,
  rackAcknowledgementField,
  transferRequestBody,
  crateSyncWarning,
  decideNewRackPlacement,
  destinationMatchesOption,
  EMPTY_DESTINATION_FIELDS,
  fieldsFromDestination,
  placementRefusalAlert,
  initialMoveQuantity,
  initialMoveQuantityForSource,
  moveDestinationChoices,
  moveDestinationScope,
  newLocationFields,
  newLocationReady,
  newRackLabel,
  removeStockCrateWarning,
  resolveMoveSource,
  seedDestinationFromStorage,
  type MoveDestination,
  type MoveHolding,
} from './move-stock-form';
// Type-only, so this pure test never pulls './api' (and the Supabase client)
// into the node environment. `typeof` on a type-only import is the whole point:
// the write-off sheet can only branch on what this function RETURNS.
import type { removeStockFromLocation } from './stock-api';
import type {
  BookCrateChangeDetail,
  BookRackChangeDetail,
  BookStorageInfo,
  Permission,
} from '@stockpilot/core';

type WriteOffBody = Awaited<ReturnType<typeof removeStockFromLocation>>;

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
const removeModal = readFileSync(
  path.resolve(__dirname, '../components/remove-from-rack-modal.tsx'),
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

  // 2026-07-23 review: in FREE-FORM move mode the destination list spans every
  // warehouse the user can read, so the new-rack existence check must be scoped
  // to the SOURCE holding's warehouse (where the server actually creates) or a
  // same-named rack elsewhere falsely reads as "exists" and the confirmation is
  // skipped while the server mints a brand-new rack anyway.
  it('scopes the new-rack existence check to the SOURCE warehouse, not all warehouses', () => {
    // existingLabels is filtered by the source holding's warehouse before the
    // decision is taken.
    expect(modal).toContain('const sourceWarehouseId = selected?.warehouseId ?? null;');
    expect(modal).toContain('d.warehouseId === sourceWarehouseId');
    expect(modal).toContain('existingLabels,');
    // and it is NOT the old all-warehouses map.
    expect(modal).not.toContain('existingLabels: destinations.map((d) => d.name)');
    // Android's 3-button AlertDialog cap is honoured.
    expect(modal).toContain("Platform.OS === 'android' ? 1 : 2");
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
    // REWRITTEN (reason): this asserted the inline object literal
    // `await transferStock(itemId, {`. The body moved into
    // transferRequestBody() in src/lib precisely so the harness could reach
    // it -- a verifier flipped the rack key's spread to conditional (the
    // shipped bug) and the whole suite stayed green while the body was
    // inline. The INTENT here is unchanged and still worth pinning: the write
    // goes through the HTTP route, never a direct RPC.
    expect(modal).toContain('await transferStock(');
    expect(modal).toContain('transferRequestBody({');
    expect(modal).not.toContain('.rpc(');
    expect(modal).not.toContain('transfer_stock');
    expect(modal).not.toContain('.rpc(');
  });
});

// ── New-rack confirmation — the 2026-07-23 guard, mirrored on the phone ──────

describe('newRackLabel', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // WHAT THESE USED TO PIN, AND WHY IT WAS THE BUG.
  //
  // `newRackLabel` decided crate-vs-rack from the COLOUR alone
  // (`crateColor ? 'crate' : 'rack'`) — the exact heuristic the server removed
  // in afcc5d82 — and fell back to the RACK number when no crate number was
  // typed. The old cases here asserted both behaviours, so the defect was
  // pinned rather than caught: a crate identified only by its number rendered
  // as a rack, and "rack 7 + colour Blue" rendered "Blue #7", a crate the user
  // never asked for.
  //
  // The branch is now an EXPLICIT `kind`, and the label comes from the ONE core
  // planner the SERVER names the row with — so the sheet cannot confirm one
  // string and create another (REPRO A').
  // ─────────────────────────────────────────────────────────────────────────

  it('renders a rack with a row', () => {
    expect(newRackLabel({ kind: 'rack', rackNumber: '22', rackRow: 'B' })).toEqual({
      label: '22-B',
      noun: 'rack',
    });
  });

  it('renders a bare rack number when there is no row', () => {
    expect(newRackLabel({ kind: 'rack', rackNumber: '100-A' })).toEqual({
      label: '100-A',
      noun: 'rack',
    });
  });

  it('a NUMBER-ONLY crate is a crate — the colour is optional', () => {
    // Unreachable before: the label keyed off the colour, so this rendered a
    // rack, and submit was gated on a rack number that this branch never asks
    // for.
    expect(newRackLabel({ kind: 'crate', rackNumber: '', crateNumber: '42' })).toEqual({
      label: 'Crate #42',
      noun: 'crate',
    });
    expect(
      newRackLabel({ kind: 'crate', rackNumber: '', crateColor: 'Blue', crateNumber: '42' }),
    ).toEqual({ label: 'Blue #42', noun: 'crate' });
  });

  it('the CRATE branch never borrows the rack number as its IDENTITY', () => {
    // The old fallback made "rack 7 + colour Blue" mint "Blue #7". A crate is
    // identified by its OWN number; without one there is nothing to name and
    // the form is not ready to submit — a POSITION does not rescue it, because
    // where a crate sits is not what it is called.
    expect(newRackLabel({ kind: 'crate', rackNumber: '7', crateColor: 'Blue' }).label).toBe('');
    expect(newLocationReady({ kind: 'crate', rackNumber: '7', crateColor: 'Blue' })).toBe(false);
  });

  it('the CRATE branch DOES take the rack as its POSITION, and names both', () => {
    // A crate sits on a rack. "gray BIN" names five different bins in this
    // warehouse, so the position is what tells them apart — in the label the
    // sheet confirms and in the name the server creates.
    expect(
      newRackLabel({ kind: 'crate', rackNumber: '38', rackRow: 'B', crateNumber: '13' }),
    ).toEqual({ label: 'Crate #13 on rack 38-B', noun: 'crate' });
    expect(
      newRackLabel({ kind: 'crate', rackNumber: '43', rackRow: 'B', crateColor: 'gray', crateNumber: 'BIN' }),
    ).toEqual({ label: 'Gray #BIN on rack 43-B', noun: 'crate' });
  });

  it('the RACK branch never borrows the crate fields', () => {
    // A rack is not a crate: the rack branch speaks only for itself.
    expect(
      newRackLabel({ kind: 'rack', rackNumber: 'A1', rackRow: 'Row 3', crateNumber: '9' }),
    ).toEqual({ label: 'A1-Row 3', noun: 'rack' });
  });

  it('the payload carries the crate AND its position — never a dropped rack', () => {
    // REPRO A: "RACK NUMBER A1" + "CRATE NUMBER 9" minted "Crate #9" and moved
    // stock into it, silently discarding A1. This assertion used to pin the
    // fix-by-forbidding — `.toEqual({ crateColor, crateNumber })`, i.e. the
    // rack dropped on purpose — which made a positioned crate unexpressible
    // from the phone. Both halves now travel.
    expect(
      newLocationFields({ kind: 'rack', rackNumber: 'A1', rackRow: 'Row 3', crateNumber: '9' }),
    ).toEqual({ rackNumber: 'A1', rackRow: 'Row 3' });
    expect(
      newLocationFields({ kind: 'crate', rackNumber: 'A1', crateColor: 'blue', crateNumber: '9' }),
    ).toEqual({ crateColor: 'blue', crateNumber: '9', rackNumber: 'A1' });
    expect(
      newLocationFields({ kind: 'crate', rackNumber: '38', rackRow: 'B', crateNumber: '13' }),
    ).toEqual({ crateNumber: '13', rackNumber: '38', rackRow: 'B' });
  });

  it('a crate with NO position sends no rack keys — the legacy row stays matched', () => {
    // Production holds blue "Blue Shelf" with rack NULL, and every crate row in
    // the database is position-less. Omitting the keys is what keeps
    // findOrCreateRackOrCrate matching "Blue #Shelf" instead of minting a
    // second row for the same bin.
    expect(
      newLocationFields({ kind: 'crate', rackNumber: '  ', crateColor: 'blue', crateNumber: 'Shelf' }),
    ).toEqual({ crateColor: 'blue', crateNumber: 'Shelf' });
  });

  it('a rack needs a number; a crate needs a number', () => {
    expect(newLocationReady({ kind: 'rack', rackNumber: '   ' })).toBe(false);
    expect(newLocationReady({ kind: 'rack', rackNumber: '22' })).toBe(true);
    expect(newLocationReady({ kind: 'crate', rackNumber: '', crateNumber: '' })).toBe(false);
    expect(newLocationReady({ kind: 'crate', rackNumber: '', crateNumber: 'Bin' })).toBe(true);
  });
});

describe('decideNewRackPlacement', () => {
  // The incident warehouse: 1-A exists, 100-A does not.
  const EXISTING = ['1-A', '22-B', '35', '40-A'];

  it('a typed label that already exists is NOT a creation — no confirmation', () => {
    const d = decideNewRackPlacement({
      rack: { kind: 'rack', rackNumber: '22', rackRow: 'b' },
      warehouseName: 'Main',
      quantity: 5,
      existingLabels: EXISTING,
    });
    expect(d.exists).toBe(true);
  });

  it('a slipped "100-A" asks, names the warehouse and count, and offers 1-A', () => {
    const d = decideNewRackPlacement({
      rack: { kind: 'rack', rackNumber: '100', rackRow: 'A' },
      warehouseName: 'Main Warehouse',
      quantity: 242,
      existingLabels: EXISTING,
    });
    expect(d.exists).toBe(false);
    expect(d.title).toBe('Create new rack 100-A?');
    expect(d.message).toContain('does not exist in Main Warehouse yet');
    expect(d.message).toContain('242 units');
    expect(d.suggestions).toContain('1-A');
  });
});

// ── Modal wiring: the guard is actually invoked, and the common path isn't ───

describe('the put-away modal wires the confirmation', () => {
  it('gates a new rack through the shared decision + an Alert, not a direct write', () => {
    // The new-rack branch must ask decideNewRackPlacement first…
    expect(modal).toContain('decideNewRackPlacement({');
    // …and present it as an Alert with a deliberate create action…
    expect(modal).toContain("Alert.alert(decision.title, decision.message");
    expect(modal).toContain('Create and put away');
    // …only proceeding when the destination already exists.
    expect(modal).toContain('if (decision.exists)');
  });

  it('an existing destination still writes with no confirmation (common path unchanged)', () => {
    // Picking an existing rack goes straight to the write.
    expect(modal).toContain('void performMove({ toLocationId: toId });');
  });

  it('the near-match alternative places into an existing rack, creating nothing', () => {
    expect(modal).toContain('Use ${label} instead');
    expect(modal).toContain('performMove({ toLocationId: match.id })');
  });
});

// ── The sheet asks rack-or-crate, and can answer the book-crate gate ─────────

describe('the move-stock sheet: the four fields ARE the destination (books)', () => {
  // WIRING PINS. The decisions are asserted by value in the blocks below (and
  // in "the four fields are the destination" at the end of this file); these
  // prove the sheet is plugged into them and did not keep a second copy.
  it('seeds the four fields from the recorded storage, and reads it for the item screen', () => {
    // The staging worklist hands `bookStorage` in; the item screen does not, so
    // the sheet reads the item's custom_fields once on open through the
    // CANONICAL reader (it feeds the acknowledgement fingerprints).
    expect(modal).toContain('seedDestinationFromStorage(recorded)');
    expect(modal).toContain("if (itemType === 'book')");
    expect(modal).toContain('readBookStorage(cf ?? null)');
    expect(modal).toContain('bookStorage !== undefined');
  });

  it('a chip FILLS the fields for a book, and there is no "+ New" chip or Rack|Crate toggle for one', () => {
    expect(modal).toContain('setFields(fieldsFromDestination(d))');
    expect(modal).toContain('{!isBook && canCreateLocation ? (');
    expect(modal).not.toContain('NEW LOCATION TYPE');
    expect(modal).not.toContain('setNewKind(');
    // Both facts on screen at once — a crate SITS ON a rack.
    expect(modal).toContain('PLACE INTO');
    expect(modal).toContain('label="RACK NUMBER"');
    expect(modal).toContain('label="CRATE NUMBER"');
    expect(modal).toContain('CRATE_COLOR_OPTIONS.map');
  });

  it('the destination, its readiness, the recorded-storage suppression and the payload come from the shared helpers', () => {
    expect(modal).toContain('bookDestination(fields, selectedChip)');
    expect(modal).toContain('newLocationReady(bookDest.input)');
    expect(modal).toContain('bookDestinationIsRecordedStorage(bookDest, storage)');
    expect(modal).toContain('newLocationFields(bookDest.input) as NewRack');
    expect(modal).toContain('bookDestinationNeedsMint(bookDest, existingLabels)');
    // Not `rackNumber.trim().length > 0` — that gate is what made a
    // number-only crate unreachable however the form was filled in.
    expect(modal).not.toContain('rackNumber.trim().length > 0');
  });

  it('the confirmation and the payload are derived from the SAME object', () => {
    // REPRO A': the sheet confirmed "Create new rack A1?" and created
    // "Crate #9". One object feeds decideNewRackPlacement and the body, on
    // both the book path and the non-book "+ New rack…" path.
    expect(modal).toContain('rack: input,');
    expect(modal).toContain('confirmCreationThenMove(bookDest.input, newRack)');
    expect(modal).toContain(
      'confirmCreationThenMove(newLocation, newLocationFields(newLocation) as NewRack)',
    );
  });
});

describe('the sheet answers the book-crate gate', () => {
  it('re-asks from the SERVER payload and retries with a scoped acknowledgement', () => {
    // POST /api/v1/items/<id>/transfer now runs the same gate web runs, so the
    // phone must be able to answer or every crated book dead-ends on a toast.
    expect(modal).toContain('bookCrateRefusal(e)');
    expect(modal).toContain('toBookCrateAcknowledgement(detail.items)');
    // The key names now live in transferRequestBody() (src/lib), where
    // move-stock-form.test.ts asserts the two keys' asymmetry by VALUE. What
    // stays here is the half a value assertion cannot reach: that the sheet
    // hands its answer to that seam rather than re-typing a payload.
    expect(modal).toContain('acknowledged: opts.acknowledged');
    // Asked at most once more — a refusal that survives an acknowledgement
    // matching the server's own labels is a real error, not a loop.
    expect(modal).toContain('bookCrateAcknowledgementsMatch(opts.acknowledged, fresh)');
  });

  it('renders the crate-sync verdict as an Alert, and owns no copy of its own', () => {
    // WIRING PIN ONLY. The four cases are asserted for real in the
    // `crateSyncWarning` block below — this just proves the modal is plugged
    // into that decision and did not keep a second, untested copy of the rules.
    //
    // Matched by SHAPE, not by the names of two locals: pinning the literal
    // `res.crateSyncStale` is what made the old assertions fail on a correct
    // rename while passing on an empty branch. Both locals may be called
    // anything; what may not change is that the verdict comes from the helper
    // and is what the Alert renders.
    const flatModal = modal.replace(/\s+/g, ' ');
    expect(flatModal).toMatch(/const (\w+) = crateSyncWarning\(\w+, itemName\); if \(\1\) \{/);
    expect(flatModal).toMatch(/Alert\.alert\((\w+)\.title, \1\.message\)/);
    // No inline branch survives: every crateSync* read now lives in the helper,
    // so there is nothing left in this component to test by reading it.
    expect(modal).not.toMatch(/\.crateSync/);
  });
});

// ── The four SILENT SUCCESSES — what the phone actually SAYS ─────────────────
//
// These four used to be "tested" by asserting that move-stock-modal.tsx's source
// text CONTAINS the strings 'res.crateSyncStale' & co. That is not coverage: it
// passes against a branch whose body is empty, passes against a branch that
// alerts the wrong words, passes against an else-if chain in an order that makes
// one case unreachable — and FAILS on a correct rename. It was also the only
// coverage the mobile client's crate-warning path had.
//
// Rendering the modal is genuinely impossible in this harness: apps/mobile runs
// vitest with `environment: 'node'` and `include: ['src/**/*.test.ts']`, has no
// react-test-renderer, no @testing-library/react-native, and no `@/` alias for
// vitest to resolve the component's imports with. So the branches were moved to
// the pure decision function the modal now delegates to, and the assertions
// below pin its user-visible output the way the web dialog specs pin theirs
// (apps/web/src/components/inventory/place-from-staging-dialog.test.tsx,
// bulk-place-dialog.test.tsx): literal, whole strings, no substring matching.

describe('crateSyncWarning — a move that succeeded is never silent about the label', () => {
  const BOOK = 'The Outsiders';

  it('a clean move says nothing at all', () => {
    // The common path: no Alert. If this ever returns an object, every ordinary
    // put-away grows a modal the picker has to dismiss.
    expect(crateSyncWarning({ toLocationId: 'rack-a1' }, BOOK)).toBeNull();
    expect(crateSyncWarning({}, BOOK)).toBeNull();
  });

  // ═══ crateSyncFailed — the write itself errored ═══
  it('says the label could not be written, and names the book', () => {
    expect(crateSyncWarning({ toLocationId: 'c-blue4', crateSyncFailed: true }, BOOK)).toEqual({
      title: 'Moved, but the crate label did not update',
      message:
        "The Outsiders was moved. Its crate label could not be written — check the book's details.",
    });
  });

  // ═══ crateSyncUnplaced — nothing left for the label to follow ═══
  // The reconciliation writes only when the book's stock resolves to ONE
  // rack/crate. When it resolves to NONE — every unit still in a bucket after a
  // partial move, or the stock picked away underneath it — there is nothing
  // authoritative to write. Server-side this used to be a bare `continue`: no
  // flag, no alert, plain success on the phone, item still naming a crate that
  // holds none of it.
  it('says the label may now be wrong when no stock is in a rack or crate', () => {
    expect(crateSyncWarning({ toLocationId: 'c-blue4', crateSyncUnplaced: true }, BOOK)).toEqual({
      title: 'Moved — crate label may now be wrong',
      message:
        'The Outsiders has no stock in a rack or crate now, so its crate label was left unchanged.',
    });
  });

  // ═══ crateSyncStale — someone else re-recorded the crate mid-move ═══
  it('says someone else changed the crate, and that their label stands', () => {
    expect(crateSyncWarning({ toLocationId: 'c-blue4', crateSyncStale: true }, BOOK)).toEqual({
      title: 'Moved — someone else changed the crate',
      message:
        'The Outsiders was moved, but its crate was changed by someone else while it was moving. The label was left as they set it.',
    });
  });

  // ═══ crateSyncSkipped — the title is now split across locations ═══
  it('says the label was left alone when the stock sits in more than one place', () => {
    expect(crateSyncWarning({ toLocationId: 'c-blue4', crateSyncSkipped: true }, BOOK)).toEqual({
      title: 'Moved — crate label left unchanged',
      message:
        'The Outsiders now has stock in more than one location, so its crate label was left as it was.',
    });
  });

  it('interpolates the item it was actually given, not a generic noun', () => {
    // The Alert fires AFTER onClose(), so "this item" has no on-screen referent
    // by the time it is read. A hard-coded noun would be indistinguishable from
    // a correct message in a source-text assertion — and useless on the phone.
    expect(crateSyncWarning({ crateSyncStale: true }, 'Persepolis')?.message).toBe(
      'Persepolis was moved, but its crate was changed by someone else while it was moving. The label was left as they set it.',
    );
    expect(crateSyncWarning({ crateSyncSkipped: true }, 'Persepolis')?.message).toBe(
      'Persepolis now has stock in more than one location, so its crate label was left as it was.',
    );
  });

  it('says ONE thing when the route reports several, worst first', () => {
    // A native Alert is modal and stacks badly; the route can legitimately set
    // more than one flag for a multi-book move. The order is the point: an
    // else-if chain in the wrong order makes a case unreachable, and a source
    // pin cannot see the difference because all four names are still present.
    const all = {
      crateSyncFailed: true,
      crateSyncUnplaced: true,
      crateSyncStale: true,
      crateSyncSkipped: true,
    };
    expect(crateSyncWarning(all, BOOK)?.title).toBe('Moved, but the crate label did not update');
    expect(crateSyncWarning({ ...all, crateSyncFailed: false }, BOOK)?.title).toBe(
      'Moved — crate label may now be wrong',
    );
    expect(
      crateSyncWarning({ crateSyncStale: true, crateSyncSkipped: true }, BOOK)?.title,
    ).toBe('Moved — someone else changed the crate');
  });

  it('treats an absent flag as absent, not as a warning', () => {
    // The route omits the key entirely on the clean path; an explicit false is
    // what a caller building the body by hand produces. Neither may speak.
    expect(
      crateSyncWarning(
        {
          crateSyncFailed: false,
          crateSyncUnplaced: false,
          crateSyncStale: false,
          crateSyncSkipped: false,
          crateSyncRackPreserved: false,
        },
        BOOK,
      ),
    ).toBeNull();
  });

  // ═══ crateSyncRackPreserved — the OTHER label, kept because nobody was asked ═══
  //
  // THE GAP THIS CLOSES: the route has emitted this flag on all four write paths
  // since the rack channel shipped, and both web dialogs render it. The phone
  // had no branch for it at all, so a move that left a hand-typed rack label
  // pointing at a rack the stock has left reported a bare "Moved" — the exact
  // failure class the whole feature exists to eliminate, arriving on the one
  // surface that could not answer the question either.
  it('says the RACK label was kept and may now be wrong', () => {
    expect(
      crateSyncWarning({ toLocationId: 'c-blue-shelf', crateSyncRackPreserved: true }, BOOK),
    ).toEqual({
      title: 'Moved — rack label may now be wrong',
      message:
        'The Outsiders was moved, but its rack label was left as it was — nobody was asked about clearing it, so it may now name a rack this stock has left.',
    });
  });

  it('distinguishes the RACK label being kept from the CRATE label being kept', () => {
    // Two different labels, two different causes, two different repairs. If
    // these ever collapse to one sentence the operator is sent to check the
    // wrong field: `skipped` means the stock is split, `rackPreserved` means an
    // erasure was withheld for want of an answer.
    const preserved = crateSyncWarning({ crateSyncRackPreserved: true }, BOOK)!;
    const skipped = crateSyncWarning({ crateSyncSkipped: true }, BOOK)!;
    expect(preserved.title).not.toBe(skipped.title);
    expect(preserved.message).not.toBe(skipped.message);
    expect(preserved.message).toContain('rack label');
    expect(skipped.message).toContain('crate label');
  });

  it('interpolates the book into the rack sentence too', () => {
    expect(crateSyncWarning({ crateSyncRackPreserved: true }, 'Persepolis')?.message).toBe(
      'Persepolis was moved, but its rack label was left as it was — nobody was asked about clearing it, so it may now name a rack this stock has left.',
    );
  });

  it('lets a crate outcome outrank the preserved rack, and never the reverse', () => {
    // `rackPreservedItemIds ⊆ syncedItemIds` server-side, so for the single-item
    // body this sheet always sends the case is disjoint outright. In a batch it
    // is not, and the crate outcome is the more specific thing to say.
    expect(
      crateSyncWarning({ crateSyncSkipped: true, crateSyncRackPreserved: true }, BOOK)?.title,
    ).toBe('Moved — crate label left unchanged');
    expect(
      crateSyncWarning({ crateSyncFailed: true, crateSyncRackPreserved: true }, BOOK)?.title,
    ).toBe('Moved, but the crate label did not update');
    // …but alone it must still speak. An else-if chain that swallowed it here
    // would be indistinguishable from the gap this closes.
    expect(crateSyncWarning({ crateSyncRackPreserved: true }, BOOK)).not.toBeNull();
  });

  // ═══ crateSyncCratePreserved — the CRATE label, kept because nobody was asked ═══
  //
  // Maus I, 2026-08-17: a ten-unit put-away onto plain rack 38-B erased a crate
  // label (yellow 6) that existed ONLY as that label. The server now KEEPS the
  // crate label on a plain-rack move unless the body acknowledged the clear, and
  // reports it. This is the phone's sentence for that report.
  it('says the CRATE label was kept and may now be wrong', () => {
    expect(
      crateSyncWarning({ toLocationId: 'r-38b', crateSyncCratePreserved: true }, BOOK),
    ).toEqual({
      title: 'Moved — crate label was kept',
      message:
        "The Outsiders was placed. The crate label was kept — nobody was asked about clearing it — so it may now name a crate this stock has left. Check the book's details.",
    });
  });

  it('a kept CRATE label outranks a kept RACK label, and both lose to a crate outcome', () => {
    expect(
      crateSyncWarning({ crateSyncCratePreserved: true, crateSyncRackPreserved: true }, BOOK)
        ?.title,
    ).toBe('Moved — crate label was kept');
    expect(
      crateSyncWarning({ crateSyncSkipped: true, crateSyncCratePreserved: true }, BOOK)?.title,
    ).toBe('Moved — crate label left unchanged');
    // Distinct from `skipped` (split) and from `rackPreserved` (other label).
    const kept = crateSyncWarning({ crateSyncCratePreserved: true }, BOOK)!;
    expect(kept.message).not.toBe(crateSyncWarning({ crateSyncSkipped: true }, BOOK)!.message);
    expect(kept.message).not.toBe(
      crateSyncWarning({ crateSyncRackPreserved: true }, BOOK)!.message,
    );
    expect(kept.message).toContain('crate label');
  });

  it('leaves NO flag the transfer route can emit without a sentence', () => {
    // THE MATRIX PIN. A flag no client surfaces is a silent failure by
    // construction, and this feature has shipped that shape more than once. The
    // list is exactly what apps/web/src/app/api/v1/items/[id]/transfer/route.ts
    // spreads onto its 2xx body; every one of them must produce something the
    // operator can read.
    const emitted = [
      'crateSyncFailed',
      'crateSyncSkipped',
      'crateSyncStale',
      'crateSyncUnplaced',
      'crateSyncRackPreserved',
      'crateSyncCratePreserved',
    ] as const;
    for (const flag of emitted) {
      const said = crateSyncWarning({ [flag]: true }, BOOK);
      expect(said, `${flag} is emitted by the transfer route but says nothing`).not.toBeNull();
      expect(said!.title.length, `${flag} has an empty title`).toBeGreaterThan(0);
      expect(said!.message, `${flag} does not name the book`).toContain(BOOK);
    }
    // …and every sentence is distinct, so no two outcomes read the same.
    const titles = emitted.map((f) => crateSyncWarning({ [f]: true }, BOOK)!.title);
    expect(new Set(titles).size).toBe(emitted.length);
  });
});

// ── THE WRITE-OFF SAID NOTHING AT ALL ───────────────────────────────────────
//
// POST /api/v1/items/<id>/remove-stock answers with the same four crate flags
// the transfer route does, plus one the transfer route has no use for: the
// label was rewritten AND its value really changed. `removeStockFromLocation`
// declared `Promise<void>` and threw the whole body away, so a write-off from
// the phone could drain crate Blue 4 — or rewrite Blue 4 to Red 7 — and show a
// sheet that simply closed. Web reports every one of those five
// (apps/web/src/components/inventory/remove-from-rack-dialog.tsx); a web
// feature ships native unless it is web-only, and this one is not.
//
// Same harness limits as the block above: the sheet cannot be rendered under
// vitest, so the words live in a pure function and are asserted here in full.

describe('removeStockCrateWarning — a write-off is never silent about the label', () => {
  const BOOK = 'The Outsiders';

  it('a clean write-off says nothing at all', () => {
    expect(removeStockCrateWarning({}, BOOK)).toBeNull();
    expect(
      removeStockCrateWarning(
        {
          crateSyncFailed: false,
          crateSyncUnplaced: false,
          crateSyncStale: false,
          crateSyncSkipped: false,
          crateSyncUpdated: false,
        },
        BOOK,
      ),
    ).toBeNull();
  });

  it('says the label could not be written, and names the book', () => {
    expect(removeStockCrateWarning({ crateSyncFailed: true }, BOOK)).toEqual({
      title: 'Removed, but the crate label did not update',
      message: "The crate label on The Outsiders could not be updated — check the book's details.",
    });
  });

  it('says the label may now be wrong when no stock is in a rack or crate', () => {
    // The drained-crate case: every copy has left, so there is nothing
    // authoritative to write and the summary still names Blue 4.
    expect(removeStockCrateWarning({ crateSyncUnplaced: true }, BOOK)).toEqual({
      title: 'Removed — crate label may now be wrong',
      message:
        'The Outsiders has no stock in a rack or crate now, so its crate label was left unchanged.',
    });
  });

  it('says someone else changed the crate, and that their label stands', () => {
    expect(removeStockCrateWarning({ crateSyncStale: true }, BOOK)).toEqual({
      title: 'Removed — someone else changed the crate',
      message:
        'Someone else changed the crate on The Outsiders while the stock was being removed. The label was left as they set it.',
    });
  });

  it('says the label was left alone when the stock sits in more than one place', () => {
    expect(removeStockCrateWarning({ crateSyncSkipped: true }, BOOK)).toEqual({
      title: 'Removed — crate label left unchanged',
      message:
        'The Outsiders still has stock in more than one location, so its crate label was left as it was.',
    });
  });

  it('reports a label the app CHANGED as a caution, not as good news', () => {
    // Draining one of two placed holdings re-points the summary at the crate
    // the rest of the stock is in — "Blue 4" becomes "Red 7" with no prompt.
    // The reconciliation is right; announcing it as a success while its four
    // neighbours warn is what makes the one outcome that changed the
    // operator's own data look like the one where nothing happened.
    expect(removeStockCrateWarning({ crateSyncUpdated: true }, BOOK)).toEqual({
      title: 'Removed — the crate label changed',
      message: 'The crate label on The Outsiders was changed to follow the stock it has left.',
    });
  });

  it('never says a write-off MOVED anything', () => {
    // The move sheet's words are the wrong words here: the stock did not go
    // anywhere, it left. Reusing them verbatim would be its own small lie, and
    // it is the reason this twin exists rather than a second call to
    // crateSyncWarning.
    for (const flag of [
      'crateSyncFailed',
      'crateSyncUnplaced',
      'crateSyncStale',
      'crateSyncSkipped',
      'crateSyncUpdated',
    ] as const) {
      const said = removeStockCrateWarning({ [flag]: true }, BOOK)!;
      expect(said.title.startsWith('Removed')).toBe(true);
      expect(`${said.title} ${said.message}`).not.toMatch(/\bmoved\b/i);
    }
  });

  it('interpolates the item it was actually given, not a generic noun', () => {
    expect(removeStockCrateWarning({ crateSyncUpdated: true }, 'Persepolis')?.message).toBe(
      'The crate label on Persepolis was changed to follow the stock it has left.',
    );
    expect(removeStockCrateWarning({ crateSyncSkipped: true }, 'Persepolis')?.message).toBe(
      'Persepolis still has stock in more than one location, so its crate label was left as it was.',
    );
  });

  it('says ONE thing when the route reports several, in the SAME order the move sheet uses', () => {
    // One precedence chain serves both sheets, so the two can differ in words
    // and never in which outcome wins. A native Alert is modal and stacks
    // badly; an else-if in the wrong order makes a case unreachable.
    const all = {
      crateSyncFailed: true,
      crateSyncUnplaced: true,
      crateSyncStale: true,
      crateSyncSkipped: true,
      crateSyncUpdated: true,
    };
    expect(removeStockCrateWarning(all, BOOK)?.title).toBe(
      'Removed, but the crate label did not update',
    );
    expect(removeStockCrateWarning({ ...all, crateSyncFailed: false }, BOOK)?.title).toBe(
      'Removed — crate label may now be wrong',
    );
    expect(
      removeStockCrateWarning({ ...all, crateSyncFailed: false, crateSyncUnplaced: false }, BOOK)
        ?.title,
    ).toBe('Removed — someone else changed the crate');
    expect(
      removeStockCrateWarning({ crateSyncSkipped: true, crateSyncUpdated: true }, BOOK)?.title,
    ).toBe('Removed — crate label left unchanged');
  });

  it('reads the route body the API client actually returns', () => {
    // TYPE-LEVEL, and the point of the annotation: `removeStockFromLocation`
    // used to declare `Promise<void>`, which type-ERASED these flags before any
    // screen could branch on them. Restoring that signature makes this
    // assignment a compile error, which `pnpm typecheck` gates on — the same
    // way the move sheet's verdict is pinned to TransferStockResult.
    const body: WriteOffBody = { crateSyncUpdated: true };
    expect(removeStockCrateWarning(body, BOOK)).toEqual({
      title: 'Removed — the crate label changed',
      message: 'The crate label on The Outsiders was changed to follow the stock it has left.',
    });
  });
});

describe('the write-off sheet renders that verdict', () => {
  it('alerts the helper’s words, and owns no copy of its own', () => {
    // WIRING PIN ONLY — the five cases are asserted for real above. Matched by
    // SHAPE, never by a local's name: pinning names is what made the old
    // assertions fail on a correct rename while passing on an empty branch.
    const flat = removeModal.replace(/\s+/g, ' ');
    const captured = /const (\w+) = await removeStockFromLocation\(/.exec(flat);
    expect(captured, 'the write-off sheet discards the route body again').not.toBeNull();
    expect(flat).toMatch(
      new RegExp(
        `const (\\w+) = removeStockCrateWarning\\(${captured![1]}, itemName\\); if \\(\\1\\) \\{ Alert\\.alert\\(\\1\\.title, \\1\\.message\\)`,
      ),
    );
    // No inline branch survives: every crateSync* read lives in the helper, so
    // there is nothing left in this component to test by reading it.
    expect(removeModal).not.toMatch(/\.crateSync/);
  });
});

describe('bookCrateAlertMessage', () => {
  it('names every book, where it is recorded and where this move puts it', () => {
    expect(
      bookCrateAlertMessage({
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
        items: [
          {
            itemId: 'i1',
            itemName: 'Persepolis',
            currentLabel: 'Blue 4',
            nextLabel: null,
            currentFingerprint: '["blue","4"]',
          },
        ],
      }),
    ).toBe('Persepolis is recorded in Blue 4 — this move records it in no crate.');
  });

  it('speaks the RACK the move erases, when the server predicted one', () => {
    // The phone must not derive this. Whether the pair clears depends on the
    // live holdings after the move, which only the gate has read — so it ships
    // the sentence on the payload and the sheet prints what it was told.
    expect(
      bookCrateAlertMessage({
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
        items: [
          {
            itemId: 'i1',
            itemName: 'The Catcher in the Rye',
            currentLabel: 'Orange 13',
            nextLabel: 'Blue Shelf',
            currentFingerprint: '["orange","13"]',
            rackLine: 'Rack 38-A will be cleared.',
          },
        ],
      }),
    ).toBe(
      'The Catcher in the Rye is recorded in Orange 13 — this move records it in Blue Shelf. Rack 38-A will be cleared.',
    );
  });

  it('reads exactly as before when no rack sentence was supplied', () => {
    // A split move, a rack the gate could not predict, or a server older than
    // this field: all three arrive without one, and none may become a dangling
    // fragment or the word "undefined" in a modal Alert.
    const line = (rackLine: string | null | undefined) =>
      bookCrateAlertMessage({
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
        items: [
          {
            itemId: 'i1',
            itemName: 'Persepolis',
            currentLabel: 'Blue 4',
            nextLabel: 'Green 2',
            currentFingerprint: '["blue","4"]',
            ...(rackLine === undefined ? {} : { rackLine }),
          },
        ],
      });
    const expected = 'Persepolis is recorded in Blue 4 — this move records it in Green 2.';
    expect(line(undefined)).toBe(expected);
    expect(line(null)).toBe(expected);
  });
});

describe('bookCrateRefusal', () => {
  it('recognises the structured payload on an ApiError', () => {
    const err = Object.assign(new Error('nope'), {
      details: {
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
        items: [
          {
            itemId: 'i1',
            itemName: 'Persepolis',
            currentLabel: 'Blue 4',
            nextLabel: 'Green 2',
            currentFingerprint: '["blue","4"]',
          },
        ],
      },
    });
    expect(bookCrateRefusal(err)?.items).toHaveLength(1);
  });

  it('returns null for an ordinary error, so the message shows as-is', () => {
    expect(bookCrateRefusal(new Error('Insufficient stock'))).toBeNull();
    expect(bookCrateRefusal(null)).toBeNull();
  });

  it('rejects a payload whose line cannot be acknowledged', () => {
    // A change line with no fingerprint would render a Continue button whose
    // acknowledgement matches nothing and be refused forever.
    const err = Object.assign(new Error('nope'), {
      details: {
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
        items: [{ itemId: 'i1', itemName: 'Persepolis', currentLabel: 'Blue 4', nextLabel: null }],
      },
    });
    expect(bookCrateRefusal(err)).toBeNull();
  });
});

// ── THE PHONE COULD NOT ASK THE RACK QUESTION AT ALL ─────────────────────────
//
// `grep -rn acknowledgedRackChanges apps/mobile/src` returned ZERO hits: the
// native sheet never sent the rack acknowledgement, so the route read every
// request as "this caller cannot answer" and took the fail-safe path — keep the
// rack, report crateSyncRackPreserved — on EVERY move. No data was lost (the
// server preserves rather than erases), but the operator was never once offered
// the choice, and until the branch above existed was never even told.
//
// These pin the two halves the sheet needs to ask: recognising the rack payload
// on the error, and turning it into ONE Alert.

describe('removeStockCrateWarning — the RACK label a write-off keeps', () => {
  const BOOK = 'The Outsiders';

  // A write-off has no destination, so it has no confirmation gate, so a rack
  // erasure can never be agreed to on this path — draining one of two holdings
  // can leave the book in a single position-less crate, which would clear a rack
  // a human typed, and the reconciliation always withholds that clear. The
  // service reported it; the action and the route dropped it before any client
  // saw it, so the phone showed a bare "Removed".
  it('says the rack label was kept and may now be wrong', () => {
    expect(removeStockCrateWarning({ crateSyncRackPreserved: true }, BOOK)).toEqual({
      title: 'Removed — rack label may now be wrong',
      message:
        'The rack label on The Outsiders was left as it was — nobody was asked about clearing it, so it may now name a rack this stock has left.',
    });
  });

  it('keeps the write-off VERBS — nothing here was moved', () => {
    // Saying "Moved" about a write-off is its own small lie: the stock did not
    // go anywhere, it left. The move sheet's sentence for the same flag must not
    // leak onto this screen.
    const writeOff = removeStockCrateWarning({ crateSyncRackPreserved: true }, BOOK)!;
    const move = crateSyncWarning({ crateSyncRackPreserved: true }, BOOK)!;
    expect(writeOff.title.startsWith('Removed')).toBe(true);
    expect(writeOff.message).not.toContain('was moved');
    expect(writeOff.message).not.toBe(move.message);
  });

  it('outranks the crate label CHANGING, and is outranked by a crate label we could not fix', () => {
    // These two genuinely co-occur on this path, and often: draining Blue 4 into
    // a position-less Green 2 rewrites the crate (updated) AND withholds the
    // rack clear (rackPreserved). One message fires, so the order decides what
    // the operator hears.
    //
    // A label that is now WRONG beats a label that was correctly rewritten. The
    // stale rack sends a picker to the wrong bay; the new crate value is right,
    // and the only reason it is mentioned at all is consent.
    expect(
      removeStockCrateWarning({ crateSyncUpdated: true, crateSyncRackPreserved: true }, BOOK)?.title,
    ).toBe('Removed — rack label may now be wrong');
    // …but the four crate outcomes above it still win: those say the CRATE label
    // could not be made right at all, which is more actionable still.
    expect(
      removeStockCrateWarning({ crateSyncUnplaced: true, crateSyncRackPreserved: true }, BOOK)
        ?.title,
    ).toBe('Removed — crate label may now be wrong');
    expect(removeStockCrateWarning({ crateSyncRackPreserved: true }, BOOK)).not.toBeNull();
  });

  it('says the CRATE label was kept when the write-off drained the crate holding', () => {
    // Draining Blue 4 and leaving the book on plain rack 22-B would have CLEARED
    // the crate label; a write-off has no gate to ask, so the server keeps it
    // (Maus I) and this is what the operator hears.
    expect(removeStockCrateWarning({ crateSyncCratePreserved: true }, BOOK)).toEqual({
      title: 'Removed — crate label was kept',
      message:
        'The crate label on The Outsiders was left as it was — nobody was asked about clearing it, so it may now name a crate this stock has left.',
    });
    // Outranks `updated` (a kept-and-maybe-wrong label beats a correctly
    // rewritten one) and loses to the four crate outcomes above it.
    expect(
      removeStockCrateWarning({ crateSyncUpdated: true, crateSyncCratePreserved: true }, BOOK)
        ?.title,
    ).toBe('Removed — crate label was kept');
    expect(
      removeStockCrateWarning({ crateSyncStale: true, crateSyncCratePreserved: true }, BOOK)
        ?.title,
    ).toBe('Removed — someone else changed the crate');
  });

  it('leaves NO flag the write-off route can emit without a sentence', () => {
    // THE MATRIX PIN for this route. The list is exactly what
    // apps/web/src/app/api/v1/items/[id]/remove-stock/route.ts spreads onto its
    // 2xx body.
    const emitted = [
      'crateSyncFailed',
      'crateSyncSkipped',
      'crateSyncStale',
      'crateSyncUnplaced',
      'crateSyncUpdated',
      'crateSyncRackPreserved',
      'crateSyncCratePreserved',
    ] as const;
    for (const flag of emitted) {
      const said = removeStockCrateWarning({ [flag]: true }, BOOK);
      expect(said, `${flag} is emitted by the write-off route but says nothing`).not.toBeNull();
      expect(said!.message, `${flag} does not name the book`).toContain(BOOK);
    }
    const titles = emitted.map((f) => removeStockCrateWarning({ [f]: true }, BOOK)!.title);
    expect(new Set(titles).size).toBe(emitted.length);
  });
});

describe('bookRackRefusal', () => {
  const rackItem = {
    itemId: 'i1',
    itemName: 'The Catcher in the Rye',
    currentLabel: '38-A',
    line: 'Rack 38-A will be cleared.',
    currentFingerprint: '["38","a"]',
  };

  it('recognises a RACK-ONLY refusal — the reported defect\'s own case', () => {
    // Crate "Blue Shelf" into the position-less crate ('blue','Shelf') is the
    // SAME crate, so the crate half is silent and `parseBookCrateChangeDetail`
    // yields nothing. A client that only parses the crate half reads this as
    // "no question here" while a hand-typed rack dies underneath it.
    const err = Object.assign(new Error('nope'), {
      details: { reason: 'BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION', rackItems: [rackItem] },
    });
    expect(bookCrateRefusal(err)).toBeNull();
    expect(bookRackRefusal(err)?.items).toEqual([rackItem]);
  });

  it('reads rackItems out of a payload that names the CRATE reason', () => {
    // One placement can raise both halves, and the server then sends ONE payload
    // keeping the crate reason so every already-shipped client parses it exactly
    // as it always did. Keying off `reason` alone would drop the rack half of
    // every combined refusal.
    const err = Object.assign(new Error('nope'), {
      details: {
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
        items: [
          {
            itemId: 'i1',
            itemName: 'The Catcher in the Rye',
            currentLabel: 'Orange 13',
            nextLabel: 'Blue Shelf',
            currentFingerprint: '["orange","13"]',
          },
        ],
        rackItems: [rackItem],
      },
    });
    expect(bookRackRefusal(err)?.items).toEqual([rackItem]);
  });

  it('returns null for an ordinary error and for a crate-only payload', () => {
    expect(bookRackRefusal(new Error('Insufficient stock'))).toBeNull();
    expect(bookRackRefusal(null)).toBeNull();
    expect(
      bookRackRefusal(
        Object.assign(new Error('nope'), {
          details: {
            reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
            items: [
              {
                itemId: 'i1',
                itemName: 'Persepolis',
                currentLabel: 'Blue 4',
                nextLabel: 'Green 2',
                currentFingerprint: '["blue","4"]',
              },
            ],
          },
        }),
      ),
    ).toBeNull();
  });

  it('rejects a rack line that cannot be acknowledged', () => {
    // No fingerprint means Continue would send an acknowledgement matching
    // nothing and be refused forever. Falling back to the plain error is honest.
    const err = Object.assign(new Error('nope'), {
      details: {
        reason: 'BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION',
        rackItems: [{ ...rackItem, currentFingerprint: undefined }],
      },
    });
    expect(bookRackRefusal(err)).toBeNull();
  });
});

describe('placementRefusalAlert — one Alert, however many questions', () => {
  const crateOnly: BookCrateChangeDetail = {
    reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
    items: [
      {
        itemId: 'i1',
        itemName: 'Persepolis',
        currentLabel: 'Blue 4',
        nextLabel: 'Green 2',
        currentFingerprint: '["blue","4"]',
      },
    ],
  };

  const rackOnly: BookRackChangeDetail = {
    reason: 'BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION',
    items: [
      {
        itemId: 'i1',
        itemName: 'The Catcher in the Rye',
        currentLabel: '38-A',
        line: 'Rack 38-A will be cleared.',
        currentFingerprint: '["38","a"]',
      },
    ],
  };

  it('has nothing to say when neither half is present', () => {
    expect(placementRefusalAlert({ crate: null, rack: null })).toBeNull();
  });

  it('asks about the CRATE when the crate is what changes', () => {
    expect(placementRefusalAlert({ crate: crateOnly, rack: null })).toEqual({
      title: "Change this book's crate?",
      message: 'Persepolis is recorded in Blue 4 — this move records it in Green 2.',
    });
  });

  it('asks about the RACK, and does not claim the crate is changing', () => {
    // The title is the whole point of the rack-only case: the crate is
    // IDENTICAL, so "Change this book's crate?" names a change that is not
    // happening and an operator who understood it would still tap Continue.
    const ask = placementRefusalAlert({ crate: null, rack: rackOnly })!;
    expect(ask).toEqual({
      title: "Clear this book's rack?",
      message: 'Rack 38-A will be cleared.',
    });
    expect(ask.title).not.toContain('crate');
  });

  it('says the rack sentence ONCE when it arrives by both routes', () => {
    // `describeRackChange` composes both, so the disclosure riding on the crate
    // line and the answerable rack line are the SAME string. Printed twice in
    // one Alert, an operator learns to skim the loudest sentence in it.
    const both = placementRefusalAlert({
      crate: {
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
        items: [
          {
            itemId: 'i1',
            itemName: 'The Catcher in the Rye',
            currentLabel: 'Orange 13',
            nextLabel: 'Blue Shelf',
            currentFingerprint: '["orange","13"]',
            rackLine: 'Rack 38-A will be cleared.',
          },
        ],
      },
      rack: rackOnly,
    })!;
    expect(both.title).toBe("Change this book's crate?");
    expect(both.message).toBe(
      'The Catcher in the Rye is recorded in Orange 13 — this move records it in Blue Shelf. Rack 38-A will be cleared.',
    );
    expect(both.message.split('Rack 38-A will be cleared.').length - 1).toBe(1);
  });

  it('still says a rack sentence the crate half did NOT disclose', () => {
    // Dedupe may only remove a sentence this Alert is provably already showing.
    // A filter that dropped the rack lines whenever a crate half existed would
    // pass the test above and silently delete the question here.
    const both = placementRefusalAlert({ crate: crateOnly, rack: rackOnly })!;
    expect(both.message).toBe(
      'Persepolis is recorded in Blue 4 — this move records it in Green 2.\nRack 38-A will be cleared.',
    );
  });

  it('collapses one rack losing many books into a single sentence', () => {
    // 200 books off rack 38-A into one position-less crate share one sentence.
    // Repeated 200 times in a native Alert it buries every line that differs.
    const many: BookRackChangeDetail = {
      reason: 'BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION',
      items: [
        { itemId: 'a', itemName: 'A', currentLabel: '38-A', line: 'Rack 38-A will be cleared.', currentFingerprint: '["38","a"]' },
        { itemId: 'b', itemName: 'B', currentLabel: '38-A', line: 'Rack 38-A will be cleared.', currentFingerprint: '["38","a"]' },
        { itemId: 'c', itemName: 'C', currentLabel: '22-B', line: 'Rack 22-B will be cleared.', currentFingerprint: '["22","b"]' },
      ],
    };
    const ask = placementRefusalAlert({ crate: null, rack: many })!;
    expect(ask.message).toBe('Rack 38-A will be cleared.\nRack 22-B will be cleared.');
  });
});

describe('rackAcknowledgementField — presence IS the capability declaration', () => {
  it('sends the key on a first request that acknowledges nothing', () => {
    // THE BUG THIS CLOSES. `grep -rn acknowledgedRackChanges apps/mobile/src`
    // returned nothing, so every request the phone made looked to the route like
    // a caller that could not answer — and the route then preserved the rack and
    // never asked. `[]` and absent are DIFFERENT MESSAGES on this wire.
    const body = rackAcknowledgementField();
    expect(Object.hasOwn(body, 'acknowledgedRackChanges')).toBe(true);
    expect(body.acknowledgedRackChanges).toEqual([]);
  });

  it('sends the key for every falsy input a caller can produce', () => {
    // `undefined` is the first attempt, `null` a caller clearing it, `[]` an
    // explicit nothing. None of the three may drop the key: an object spread of
    // `{}` is exactly the shape that made the phone unaskable.
    for (const input of [undefined, null, []] as const) {
      expect(Object.hasOwn(rackAcknowledgementField(input), 'acknowledgedRackChanges')).toBe(true);
    }
  });

  it('carries the acknowledgement through on the retry', () => {
    // The Continue tap must send back exactly what the SERVER named, or the
    // second attempt is refused for the same reason as the first and the
    // operator sits in a loop they answered correctly.
    const ack = [{ itemId: 'i1', currentFingerprint: '["38","a"]' }];
    expect(rackAcknowledgementField(ack).acknowledgedRackChanges).toEqual(ack);
  });

  it('copies rather than aliasing the caller\'s array', () => {
    // The body outlives the call; a shared reference lets a later render mutate
    // an acknowledgement already in flight.
    const ack = [{ itemId: 'i1', currentFingerprint: '["38","a"]' }];
    expect(rackAcknowledgementField(ack).acknowledgedRackChanges).not.toBe(ack);
  });
});

/**
 * THE WIRING PIN THAT DID NOT EXIST.
 *
 * A verifier changed the sheet's spread of the rack key from unconditional to
 * conditional -- the shipped bug, restored -- and the ENTIRE mobile suite
 * stayed green, typecheck included, because the field is optional. The rule
 * lived in rackAcknowledgementField (pinned) but the WIRING that calls it was
 * pinned by nothing, so "the phone asks at all" rested on one unprotected line.
 *
 * These assert the BODY that actually goes on the wire. The asymmetry between
 * the two keys is the property under test, not an accident:
 *   - the RACK key is always present, because its presence IS the capability
 *     declaration; absent, the server fail-safes forever and nobody is asked.
 *   - the CRATE key appears only when non-empty, because that is the shape
 *     already shipped to devices in the field.
 */
describe('transferRequestBody — the two keys are asymmetric, and that is load-bearing', () => {
  const base = {
    fromLocationId: 'loc-1',
    quantity: 3,
    destination: { toLocationId: 'loc-2' },
  };

  it('ALWAYS sends the rack key, even with nothing acknowledged — presence is the capability signal', () => {
    const body = transferRequestBody(base);
    expect(body).toHaveProperty('acknowledgedRackChanges');
    expect(body.acknowledgedRackChanges).toEqual([]);
  });

  it('still sends the rack key when the list is explicitly null or undefined', () => {
    expect(transferRequestBody({ ...base, acknowledgedRacks: null })).toHaveProperty(
      'acknowledgedRackChanges',
    );
    expect(transferRequestBody({ ...base, acknowledgedRacks: undefined })).toHaveProperty(
      'acknowledgedRackChanges',
    );
  });

  it('echoes back the rack acknowledgement it was given', () => {
    const ack = [{ itemId: 'i-1', currentFingerprint: '["38","a"]' }];
    expect(transferRequestBody({ ...base, acknowledgedRacks: ack }).acknowledgedRackChanges).toEqual(
      ack,
    );
  });

  it('OMITS the crate key when empty — the shape the live OTA already sends', () => {
    expect(transferRequestBody(base)).not.toHaveProperty('acknowledgedCrateChanges');
    expect(transferRequestBody({ ...base, acknowledged: [] })).not.toHaveProperty(
      'acknowledgedCrateChanges',
    );
  });

  it('sends the crate key when there is something to acknowledge', () => {
    const ack = [{ itemId: 'i-1', currentFingerprint: '["blue","4"]' }];
    expect(transferRequestBody({ ...base, acknowledged: ack }).acknowledgedCrateChanges).toEqual(ack);
  });

  it('carries the destination and omits blank notes', () => {
    const body = transferRequestBody({ ...base, notes: '' });
    expect(body.toLocationId).toBe('loc-2');
    expect(body).not.toHaveProperty('notes');
    expect(transferRequestBody({ ...base, notes: 'why' }).notes).toBe('why');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE FOUR FIELDS ARE THE DESTINATION — Maus I / The Joy Luck Club, 2026-08-17
//
// The web dialogs pin the same rules in
// apps/web/src/lib/locations/placement-destination.test.ts; these are the
// phone's copy. Same fixtures, same literals, so the two clients cannot drift.
// ═══════════════════════════════════════════════════════════════════════════

const RED_4_ON_38B: BookStorageInfo = {
  rackNumber: '38',
  rackRow: 'B',
  crateColor: 'red',
  crateNumber: '4',
  grade: null,
  rackLabel: '38-B',
  crateLabel: 'Red 4',
};
const RACK_38B: MoveDestination = {
  id: 'r-38b',
  name: '38-B',
  kind: 'rack',
  warehouseId: 'wh-1',
  rackNumber: '38',
  rackRow: 'B',
  crateColor: null,
  crateNumber: null,
};
const CRATE_BLUE_0_ON_38B: MoveDestination = {
  id: 'c-blue0',
  name: 'Blue #0 on rack 38-B',
  kind: 'crate',
  warehouseId: 'wh-1',
  rackNumber: '38',
  rackRow: 'B',
  crateColor: 'Blue',
  crateNumber: '0',
};

describe('seedDestinationFromStorage — the default destination is where the book already lives', () => {
  it('pre-fills all four boxes from the recorded storage', () => {
    expect(seedDestinationFromStorage(RED_4_ON_38B)).toEqual({
      fields: { rackNumber: '38', rackRow: 'B', crateColor: 'red', crateNumber: '4' },
      unknownCrateColor: null,
    });
  });
  it('a recorded colour is seeded as its slug, whatever the stored case', () => {
    expect(seedDestinationFromStorage({ ...RED_4_ON_38B, crateColor: ' Red ' }).fields.crateColor).toBe('red');
  });
  it('an UNKNOWN recorded colour leaves the box blank and hands the raw text back', () => {
    expect(seedDestinationFromStorage({ ...RED_4_ON_38B, crateColor: 'taupe' })).toEqual({
      fields: { rackNumber: '38', rackRow: 'B', crateColor: '', crateNumber: '4' },
      unknownCrateColor: 'taupe',
    });
  });
  it('nothing recorded (or a non-book) seeds nothing', () => {
    expect(seedDestinationFromStorage(null).fields).toEqual(EMPTY_DESTINATION_FIELDS);
    expect(seedDestinationFromStorage(undefined).fields).toEqual(EMPTY_DESTINATION_FIELDS);
  });
});

describe('fieldsFromDestination — a chip FILLS the boxes', () => {
  it('a rack chip fills the rack pair and BLANKS the crate', () => {
    expect(fieldsFromDestination(RACK_38B)).toEqual({
      rackNumber: '38',
      rackRow: 'B',
      crateColor: '',
      crateNumber: '',
    });
  });
  it('a positioned crate chip fills all four (colour as its slug)', () => {
    expect(fieldsFromDestination(CRATE_BLUE_0_ON_38B)).toEqual({
      rackNumber: '38',
      rackRow: 'B',
      crateColor: 'blue',
      crateNumber: '0',
    });
  });
  it('a chip with no columns (older caller, legacy crate) fills nothing', () => {
    expect(fieldsFromDestination({ id: 'x', name: 'Old', kind: 'crate', warehouseId: null })).toEqual(
      EMPTY_DESTINATION_FIELDS,
    );
  });
  it('destinationMatchesOption compares by fingerprint, not bytes', () => {
    expect(
      destinationMatchesOption(
        { rackNumber: '38', rackRow: 'b', crateColor: 'blue', crateNumber: '0' },
        CRATE_BLUE_0_ON_38B,
      ),
    ).toBe(true);
    expect(
      destinationMatchesOption(
        { rackNumber: '38', rackRow: 'B', crateColor: 'blue', crateNumber: '1' },
        CRATE_BLUE_0_ON_38B,
      ),
    ).toBe(false);
  });
});

describe('bookDestination — what the four boxes describe', () => {
  const RED_4_FIELDS = { rackNumber: '38', rackRow: 'B', crateColor: 'red', crateNumber: '4' };

  it('the seeded record, no chip → a CRATE on that rack, named as the row 0270 dedupes on', () => {
    const dest = bookDestination(RED_4_FIELDS, null)!;
    expect(dest).toEqual({
      mode: 'new',
      input: { kind: 'crate', rackNumber: '38', rackRow: 'B', crateColor: 'red', crateNumber: '4' },
    });
    const input = dest.mode === 'new' ? dest.input : ({} as never);
    expect(newRackLabel(input).label).toBe('Red #4 on rack 38-B');
    // …and the payload the route receives is the crate WITH its position.
    expect(newLocationFields(input)).toEqual({
      crateNumber: '4',
      crateColor: 'red',
      rackNumber: '38',
      rackRow: 'B',
    });
  });

  it('a selected chip whose columns still equal the boxes → EXISTING by id', () => {
    expect(bookDestination(fieldsFromDestination(RACK_38B), RACK_38B)).toEqual({
      mode: 'existing',
      destination: RACK_38B,
    });
    // Spelling and case do not un-match a chip: "Blue"/"0" vs blue/0.
    expect(bookDestination(fieldsFromDestination(CRATE_BLUE_0_ON_38B), CRATE_BLUE_0_ON_38B)?.mode).toBe(
      'existing',
    );
  });

  it('typing over a selected chip demotes it to the fields — the boxes win', () => {
    expect(bookDestination({ ...fieldsFromDestination(RACK_38B), crateNumber: '4' }, RACK_38B)).toEqual({
      mode: 'new',
      input: { kind: 'crate', rackNumber: '38', rackRow: 'B', crateColor: '', crateNumber: '4' },
    });
  });

  it('rack boxes only → a bare RACK (the one choice that clears a recorded crate)', () => {
    expect(bookDestination({ rackNumber: '38', rackRow: 'B', crateColor: '', crateNumber: '' }, null)).toEqual({
      mode: 'new',
      input: { kind: 'rack', rackNumber: '38', rackRow: 'B' },
    });
  });

  it('a colour with no number is a crate choice the planner refuses — not ready', () => {
    const dest = bookDestination({ rackNumber: '', rackRow: '', crateColor: 'red', crateNumber: '' }, null)!;
    expect(dest.mode).toBe('new');
    expect(newLocationReady(dest.mode === 'new' ? dest.input : ({} as never))).toBe(false);
  });

  it('all blank → nothing to submit', () => {
    expect(bookDestination(EMPTY_DESTINATION_FIELDS, null)).toBeNull();
  });
});

describe('bookDestinationIsRecordedStorage — suppress the typo guard for the recorded truth', () => {
  it('the seeded fields ARE the recorded storage', () => {
    const dest = bookDestination(seedDestinationFromStorage(RED_4_ON_38B).fields, null)!;
    expect(bookDestinationIsRecordedStorage(dest, RED_4_ON_38B)).toBe(true);
  });
  it('a different crate, or the same crate elsewhere, or rack-only, is NOT', () => {
    expect(
      bookDestinationIsRecordedStorage(
        { mode: 'new', input: { kind: 'crate', rackNumber: '38', rackRow: 'B', crateColor: 'red', crateNumber: '5' } },
        RED_4_ON_38B,
      ),
    ).toBe(false);
    expect(
      bookDestinationIsRecordedStorage(
        { mode: 'new', input: { kind: 'crate', rackNumber: '40', rackRow: 'A', crateColor: 'red', crateNumber: '4' } },
        RED_4_ON_38B,
      ),
    ).toBe(false);
    expect(
      bookDestinationIsRecordedStorage(
        { mode: 'new', input: { kind: 'rack', rackNumber: '38', rackRow: 'B' } },
        RED_4_ON_38B,
      ),
    ).toBe(false);
  });
  it('an existing chip equal to the record counts; nothing recorded matches nothing', () => {
    const chip: MoveDestination = {
      id: 'c-red4',
      name: 'Red #4 on rack 38-B',
      kind: 'crate',
      warehouseId: 'wh-1',
      rackNumber: '38',
      rackRow: 'B',
      crateColor: 'red',
      crateNumber: '4',
    };
    expect(bookDestinationIsRecordedStorage({ mode: 'existing', destination: chip }, RED_4_ON_38B)).toBe(true);
    expect(bookDestinationIsRecordedStorage({ mode: 'existing', destination: chip }, null)).toBe(false);
    const blank: BookStorageInfo = {
      rackNumber: null,
      rackRow: null,
      crateColor: null,
      crateNumber: null,
      grade: null,
      rackLabel: null,
      crateLabel: null,
    };
    expect(bookDestinationIsRecordedStorage({ mode: 'existing', destination: chip }, blank)).toBe(false);
  });
});

describe('bookDestinationNeedsMint — said inline for a user who cannot create rows', () => {
  it('a described destination whose planned name is not among the labels needs a mint', () => {
    const dest = bookDestination(seedDestinationFromStorage(RED_4_ON_38B).fields, null)!;
    expect(bookDestinationNeedsMint(dest, ['38-B', 'Blue #0 on rack 38-B'])).toBe(true);
    expect(bookDestinationNeedsMint(dest, ['red #4 on rack 38-b'])).toBe(false);
  });
  it('an existing chip never needs a mint; an unnameable form does not either', () => {
    expect(bookDestinationNeedsMint({ mode: 'existing', destination: RACK_38B }, [])).toBe(false);
    expect(
      bookDestinationNeedsMint(
        { mode: 'new', input: { kind: 'crate', rackNumber: '', crateColor: 'red', crateNumber: '' } },
        [],
      ),
    ).toBe(false);
  });
});

// ── D1: the phone offers the default path to STAFF ──────────────────────────
//
// Owner decision D1 (2026-08-17): a put-away may resolve-or-create the crate a
// book's label names under stock:transfer (server: mint_placement_location,
// migration 0340, invoked only from the placement path). The Staff preset holds
// stock:transfer and NOT locations:manage, so the old `canCreateLocation`
// derivation (manager OR locations:manage) hid the sheet's default path from
// every staff member and pushed them onto the bare rack — the crate-erasing
// path. `canMintPlacementDestination` is the ONE derivation both screens now
// hand the sheet.

describe('canMintPlacementDestination — the phone mirrors the server placement gate', () => {
  const none = new Set<Permission>();
  it('STAFF (static preset: stock:transfer, no locations:manage) may mint — the D1 pin', () => {
    expect(canMintPlacementDestination({ role: 'staff' })).toBe(true);
  });
  it('manager-or-above always may', () => {
    expect(canMintPlacementDestination({ role: 'manager', permissions: none })).toBe(true);
    expect(canMintPlacementDestination({ role: 'admin', permissions: none })).toBe(true);
    expect(canMintPlacementDestination({ role: 'owner', permissions: none })).toBe(true);
  });
  it('a VIEWER (neither permission) may not; a null role may not', () => {
    expect(canMintPlacementDestination({ role: 'viewer' })).toBe(false);
    expect(canMintPlacementDestination({ role: null })).toBe(false);
    expect(
      canMintPlacementDestination({ role: null, permissions: new Set<Permission>(['stock:transfer']) }),
    ).toBe(false);
  });
  it('the EFFECTIVE set wins over the preset: a viewer GRANTED stock:transfer may, a staff member with it REVOKED may not', () => {
    expect(
      canMintPlacementDestination({
        role: 'viewer',
        permissions: new Set<Permission>(['stock:transfer']),
      }),
    ).toBe(true);
    expect(
      canMintPlacementDestination({
        role: 'staff',
        permissions: new Set<Permission>(['items:read', 'stock:adjust']),
      }),
    ).toBe(false);
  });
  it('locations:manage alone still suffices (the wider grant the insert policy already honours)', () => {
    expect(
      canMintPlacementDestination({
        role: 'viewer',
        permissions: new Set<Permission>(['locations:manage']),
      }),
    ).toBe(true);
  });
  it('is the ONE derivation both screens hand the sheet, and neither keeps a locations:manage copy', () => {
    // Behaviour is pinned above; this pins the WIRING — the value the sheet
    // receives is this function's, on both screens, and the old derivation
    // (which would 403-proof staff out of the default path) is gone from both.
    for (const src of [itemScreen, stagingScreen]) {
      expect(src).toContain('const canCreateLocation = canMintPlacementDestination({');
      expect(src).toContain("import { canMintPlacementDestination } from '@/lib/move-stock-form';");
      // The old derivation, verbatim — the expression that hid the default
      // path from staff. Not the string 'locations:manage' alone: the comments
      // beside the new derivation legitimately name the wider grant.
      expect(src).not.toContain("can({ role: role as Role, permissions }, 'locations:manage')");
    }
    // The sheet's inline refusal names the permission that now decides.
    expect(modal).toContain('needs the Transfer stock permission');
    expect(modal).not.toContain('needs the Manage locations permission');
  });
});
