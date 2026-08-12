import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bookCrateAlertMessage,
  bookCrateRefusal,
  decideNewRackPlacement,
  initialMoveQuantity,
  initialMoveQuantityForSource,
  moveDestinationChoices,
  moveDestinationScope,
  newLocationFields,
  newLocationReady,
  newRackLabel,
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
    expect(modal).toContain('await transferStock(itemId, {');
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

  it('the CRATE branch never borrows the rack number, however it was typed', () => {
    // The old fallback made "rack 7 + colour Blue" mint "Blue #7". A crate is
    // identified by its OWN number; without one there is nothing to name and
    // the form is not ready to submit.
    expect(newRackLabel({ kind: 'crate', rackNumber: '7', crateColor: 'Blue' }).label).toBe('');
    expect(newLocationReady({ kind: 'crate', rackNumber: '7', crateColor: 'Blue' })).toBe(false);
  });

  it('the RACK branch never borrows the crate fields', () => {
    // REPRO A: "RACK NUMBER A1" + "CRATE NUMBER 9" minted "Crate #9" and moved
    // stock into it. The chosen branch is now the only thing that speaks.
    expect(
      newRackLabel({ kind: 'rack', rackNumber: 'A1', rackRow: 'Row 3', crateNumber: '9' }),
    ).toEqual({ label: 'A1-Row 3', noun: 'rack' });
  });

  it('the payload carries ONE branch — the server refuses both together', () => {
    expect(
      newLocationFields({ kind: 'rack', rackNumber: 'A1', rackRow: 'Row 3', crateNumber: '9' }),
    ).toEqual({ rackNumber: 'A1', rackRow: 'Row 3' });
    expect(
      newLocationFields({ kind: 'crate', rackNumber: 'A1', crateColor: 'blue', crateNumber: '9' }),
    ).toEqual({ crateColor: 'blue', crateNumber: '9' });
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

describe('the move-stock sheet expresses rack XOR crate', () => {
  it('asks for the new location TYPE explicitly, for books', () => {
    // It used to render "RACK NUMBER *" plus two optional crate boxes and no
    // toggle at all, so the single field deciding locations.kind — and
    // migration 0270's kind-scoped dedupe bucket — was never actually asked
    // about, and rack+crate together was expressible with one tap.
    expect(modal).toContain('NEW LOCATION TYPE');
    expect(modal).toContain("setNewKind('rack')");
    expect(modal).toContain("setNewKind('crate')");
  });

  it('the CRATE branch requires its own number and offers no rack fields', () => {
    expect(modal).toContain('CRATE NUMBER *');
    // The rack fields sit in the other half of the same ternary, so only one
    // branch can ever be on screen.
    expect(modal).toContain("!isBook || newKind === 'rack' ? (");
  });

  it('submit readiness and the payload both come from the shared helpers', () => {
    // Not `rackNumber.trim().length > 0` — that gate is what made a
    // number-only crate unreachable however the form was filled in.
    expect(modal).toContain('newLocationReady(newLocation)');
    expect(modal).toContain('newLocationFields(newLocation)');
    expect(modal).not.toContain('rackNumber.trim().length > 0');
  });

  it('the confirmation and the payload are derived from the SAME object', () => {
    // REPRO A': the sheet confirmed "Create new rack A1?" and created
    // "Crate #9". One object now feeds decideNewRackPlacement and the body.
    expect(modal).toContain('rack: newLocation,');
  });
});

describe('the sheet answers the book-crate gate', () => {
  it('re-asks from the SERVER payload and retries with a scoped acknowledgement', () => {
    // POST /api/v1/items/<id>/transfer now runs the same gate web runs, so the
    // phone must be able to answer or every crated book dead-ends on a toast.
    expect(modal).toContain('bookCrateRefusal(e)');
    expect(modal).toContain('toBookCrateAcknowledgement(detail.items)');
    expect(modal).toContain('acknowledgedCrateChanges');
    // Asked at most once more — a refusal that survives an acknowledgement
    // matching the server's own labels is a real error, not a loop.
    expect(modal).toContain('bookCrateAcknowledgementsMatch(opts.acknowledged, fresh)');
  });

  it('says when the stock moved but the crate label did not follow', () => {
    expect(modal).toContain('res.crateSyncFailed');
    expect(modal).toContain('res.crateSyncStale');
    expect(modal).toContain('res.crateSyncSkipped');
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
