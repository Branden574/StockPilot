/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOUR FIELDS MEAN THE SAME THING ON THE WEB AND ON THE PHONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `apps/web/src/lib/locations/placement-destination.ts` and
 * `apps/mobile/src/lib/move-stock-form.ts` each carry a hand-copied set of the
 * same decisions: how a book's recorded storage seeds the four boxes, how an
 * existing row fills them, when the boxes still equal that row, what the boxes
 * DESCRIBE (an existing row by id, a crate on a position, a bare rack, or
 * nothing), what that destination is CALLED, whether it is complete, what the
 * inline refusal says, whether it is exactly the recorded storage, and — since
 * D1 — who may mint it. Two copies, on two surfaces, of one rule set.
 *
 * Both files' own suites pin their copy against the same fixtures by hand, and
 * that is exactly how they could drift: each suite would keep passing while the
 * two copies quietly disagreed. So this file imports BOTH copies into one
 * process (the mobile module is pure — its only value import is
 * @stockpilot/core, which the web suite already resolves) and drives the same
 * fixtures through both, asserting field-by-field agreement over the whole
 * matrix. A decision changed on one surface and not the other fails HERE.
 *
 * WHAT IS COMPARED, and how the two shapes are projected onto one:
 *   • seed:      seedDestinationFields  ≡ seedDestinationFromStorage   (same shape)
 *   • fill:      fieldsFromOption       ≡ fieldsFromDestination        (same shape)
 *   • match:     destinationMatchesOption on both                     (boolean)
 *   • describe:  destinationFromFields  ≡ bookDestination — projected to
 *                { mode, id?, kind?, the four fields, label, ready, problem }
 *                (web: destinationLabel / newDestinationReady /
 *                 newDestinationProblem; phone: newRackLabel /
 *                 newLocationReady / newLocationProblem)
 *   • recorded:  destinationIsRecordedStorage ≡ bookDestinationIsRecordedStorage
 *   • gate:      canMintPlacementDestination on both (D1)
 *
 * The web `DestinationOption` and the phone `MoveDestination` are the same
 * `locations` row seen from two clients; `asOption` / `asDestination` build
 * both from one fixture so the row under test is identical on both sides.
 */
import { describe, expect, it } from 'vitest';

import type { BookStorageInfo, Permission, Role } from '@stockpilot/core';

import type { DestinationOption } from './destination-option';
// The WEB's copy.
import {
  canMintPlacementDestination as webCanMint,
  destinationFromFields as webDestinationFromFields,
  destinationIsRecordedStorage as webIsRecorded,
  destinationLabel as webLabel,
  destinationMatchesOption as webMatches,
  fieldsFromOption as webFill,
  newDestinationProblem as webProblem,
  newDestinationReady as webReady,
  seedDestinationFields as webSeed,
  type DestinationFields as WebFields,
} from './placement-destination';

// ── The PHONE's copy ────────────────────────────────────────────────────────
//
// Loaded at RUNTIME through a non-literal specifier, on purpose. A static
// `import … from '../../../../mobile/src/lib/move-stock-form'` resolves and
// runs fine under vitest (the module is pure), but `tsc` follows every import
// it can see — including the module's TYPE-only imports of ./stock-api → ./api
// → ./supabase — and type-checks those Expo files under the WEB compiler
// options, where `__DEV__` is undeclared and noUncheckedIndexedAccess bites.
// A path tsc cannot statically resolve keeps the web typecheck honest about
// web code and leaves the mobile module to its own tsconfig; vitest still
// resolves it relative to this file, and a rename on the phone fails HERE at
// runtime (undefined is not a function), which is the pin working.
//
// The shape below is the SUBSET this file drives. It is declared by hand so
// the web half of every comparison stays fully typed; the phone half is typed
// through it (a signature drift on the phone shows up as a runtime failure of
// the comparison, not as a silent `any`).
interface MoveDestination {
  id: string;
  name: string;
  kind: string | null;
  warehouseId: string | null;
  rackNumber?: string | null;
  rackRow?: string | null;
  crateColor?: string | null;
  crateNumber?: string | null;
}
interface MobileFields {
  rackNumber: string;
  rackRow: string;
  crateColor: string;
  crateNumber: string;
}
interface NewRackInput {
  kind: 'rack' | 'crate';
  rackNumber: string;
  rackRow?: string | null;
  crateColor?: string | null;
  crateNumber?: string | null;
}
type BookDestination =
  { mode: 'existing'; destination: MoveDestination } | { mode: 'new'; input: NewRackInput };
interface MobileModule {
  seedDestinationFromStorage(storage: BookStorageInfo | null | undefined): {
    fields: MobileFields;
    unknownCrateColor: string | null;
  };
  fieldsFromDestination(d: MoveDestination): MobileFields;
  destinationMatchesOption(fields: MobileFields, d: MoveDestination): boolean;
  bookDestination(fields: MobileFields, selected: MoveDestination | null): BookDestination | null;
  bookDestinationIsRecordedStorage(
    dest: BookDestination,
    storage: BookStorageInfo | null | undefined,
  ): boolean;
  newRackLabel(n: NewRackInput): { label: string; noun: 'rack' | 'crate' };
  newLocationReady(n: NewRackInput): boolean;
  newLocationProblem(n: NewRackInput): string | null;
  canMintPlacementDestination(ctx: {
    role: Role | null;
    permissions?: ReadonlySet<Permission>;
  }): boolean;
}
const MOBILE_MODULE_PATH = ['..', '..', '..', '..', 'mobile', 'src', 'lib', 'move-stock-form'].join(
  '/',
);
const mobile = (await import(/* @vite-ignore */ MOBILE_MODULE_PATH)) as MobileModule;
const {
  bookDestination: mobileBookDestination,
  bookDestinationIsRecordedStorage: mobileIsRecorded,
  canMintPlacementDestination: mobileCanMint,
  destinationMatchesOption: mobileMatches,
  fieldsFromDestination: mobileFill,
  newLocationProblem: mobileProblem,
  newLocationReady: mobileReady,
  newRackLabel: mobileLabel,
  seedDestinationFromStorage: mobileSeed,
} = mobile;

// ── ONE row, seen from both clients ─────────────────────────────────────────

interface Row {
  id: string;
  name: string;
  kind: 'rack' | 'crate';
  rackNumber: string | null;
  rackRow: string | null;
  crateColor: string | null;
  crateNumber: string | null;
}

function asOption(r: Row): DestinationOption {
  return { ...r };
}
function asDestination(r: Row): MoveDestination {
  return { ...r, warehouseId: 'wh-1' };
}

const RACK_38B: Row = {
  id: 'rack-38b',
  name: '38-B',
  kind: 'rack',
  rackNumber: '38',
  rackRow: 'B',
  crateColor: null,
  crateNumber: null,
};
const RACK_22_BARE: Row = {
  id: 'rack-22',
  name: '22',
  kind: 'rack',
  rackNumber: '22',
  rackRow: null,
  crateColor: null,
  crateNumber: null,
};
const YELLOW_6_ON_38B: Row = {
  id: 'crate-y6',
  name: 'Yellow #6 on rack 38-B',
  kind: 'crate',
  rackNumber: '38',
  rackRow: 'B',
  crateColor: 'yellow',
  crateNumber: '6',
};
const RED_4_ON_38B_LEGACY_CASE: Row = {
  id: 'crate-r4',
  name: 'Red #4 on rack 38-B',
  kind: 'crate',
  rackNumber: '38',
  rackRow: 'B',
  crateColor: 'Red', // legacy spelling — the slug is 'red'
  crateNumber: ' 4 ', // stored with whitespace
};
const BLUE_SHELF_POSITIONLESS: Row = {
  id: 'crate-blue-shelf',
  name: 'Blue #Shelf',
  kind: 'crate',
  rackNumber: null,
  rackRow: null,
  crateColor: 'blue',
  crateNumber: 'Shelf',
};
const LEGACY_CRATE_NO_COLUMNS: Row = {
  id: 'crate-legacy',
  name: 'Blue #42',
  kind: 'crate',
  rackNumber: null,
  rackRow: null,
  crateColor: null,
  crateNumber: null,
};
const UNKNOWN_COLOUR_CRATE: Row = {
  id: 'crate-mauve',
  name: 'Mauve #2 on rack 40-A',
  kind: 'crate',
  rackNumber: '40',
  rackRow: 'A',
  crateColor: 'mauve', // not in CRATE_COLORS
  crateNumber: '2',
};

const ROWS: Row[] = [
  RACK_38B,
  RACK_22_BARE,
  YELLOW_6_ON_38B,
  RED_4_ON_38B_LEGACY_CASE,
  BLUE_SHELF_POSITIONLESS,
  LEGACY_CRATE_NO_COLUMNS,
  UNKNOWN_COLOUR_CRATE,
];

// ── Recorded storages ───────────────────────────────────────────────────────

function storage(over: Partial<BookStorageInfo>): BookStorageInfo {
  return {
    rackNumber: null,
    rackRow: null,
    crateColor: null,
    crateNumber: null,
    grade: null,
    rackLabel: null,
    crateLabel: null,
    ...over,
  };
}

const STORAGES: Array<[string, BookStorageInfo | null | undefined]> = [
  [
    'yellow 6 on 38-B',
    storage({ rackNumber: '38', rackRow: 'B', crateColor: 'yellow', crateNumber: '6' }),
  ],
  [
    'red 4 on 38-B, legacy case + whitespace',
    storage({ rackNumber: ' 38', rackRow: 'B ', crateColor: 'Red', crateNumber: ' 4 ' }),
  ],
  ['rack only 38-B', storage({ rackNumber: '38', rackRow: 'B' })],
  ['bare rack 22', storage({ rackNumber: '22' })],
  ['position-less blue Shelf', storage({ crateColor: 'blue', crateNumber: 'Shelf' })],
  ['number-only crate 9', storage({ crateNumber: '9' })],
  [
    'unknown colour mauve 2 on 40-A',
    storage({ rackNumber: '40', rackRow: 'A', crateColor: 'mauve', crateNumber: '2' }),
  ],
  ['colour only (no number) green', storage({ crateColor: 'green' })],
  ['nothing recorded', storage({})],
  ['null', null],
  ['undefined', undefined],
];

// ── The four boxes, as an operator might leave them ─────────────────────────

const FIELD_SETS: Array<[string, WebFields & MobileFields]> = [
  ['blank', { rackNumber: '', rackRow: '', crateColor: '', crateNumber: '' }],
  ['rack 38-B', { rackNumber: '38', rackRow: 'B', crateColor: '', crateNumber: '' }],
  [
    'rack 38-B typed into the number box',
    { rackNumber: '38-B', rackRow: '', crateColor: '', crateNumber: '' },
  ],
  ['bare rack 22', { rackNumber: '22', rackRow: '', crateColor: '', crateNumber: '' }],
  ['row only (no rack number)', { rackNumber: '', rackRow: 'B', crateColor: '', crateNumber: '' }],
  ['yellow 6 on 38-B', { rackNumber: '38', rackRow: 'B', crateColor: 'yellow', crateNumber: '6' }],
  [
    'yellow 6, lower-cased row',
    { rackNumber: '38', rackRow: 'b', crateColor: 'yellow', crateNumber: '6' },
  ],
  ['red 4 on 38-B', { rackNumber: '38', rackRow: 'B', crateColor: 'red', crateNumber: '4' }],
  [
    'colour only on 38-B (unnameable)',
    { rackNumber: '38', rackRow: 'B', crateColor: 'green', crateNumber: '' },
  ],
  [
    'number-only crate 9, no position',
    { rackNumber: '', rackRow: '', crateColor: '', crateNumber: '9' },
  ],
  [
    'blue Shelf, no position',
    { rackNumber: '', rackRow: '', crateColor: 'blue', crateNumber: 'Shelf' },
  ],
  [
    'crate 9 on row only (unnameable)',
    { rackNumber: '', rackRow: 'B', crateColor: '', crateNumber: '9' },
  ],
  [
    'whitespace everywhere',
    { rackNumber: ' 38 ', rackRow: ' B ', crateColor: 'yellow', crateNumber: ' 6 ' },
  ],
];

// ── The projection both "describe" shapes are compared through ─────────────

interface Described {
  mode: 'existing' | 'new' | null;
  id: string | null;
  kind: 'rack' | 'crate' | null;
  rackNumber: string | null;
  rackRow: string | null;
  crateColor: string | null;
  crateNumber: string | null;
  label: string;
  ready: boolean;
  problem: string | null;
}

function webDescribe(fields: WebFields, selected: Row | null): Described {
  const dest = webDestinationFromFields(fields, selected ? asOption(selected) : null);
  if (dest === null) {
    return {
      mode: null,
      id: null,
      kind: null,
      rackNumber: null,
      rackRow: null,
      crateColor: null,
      crateNumber: null,
      label: '',
      ready: false,
      problem: null,
    };
  }
  if (dest.mode === 'existing') {
    return {
      mode: 'existing',
      id: dest.option.id,
      kind: null,
      rackNumber: null,
      rackRow: null,
      crateColor: null,
      crateNumber: null,
      label: webLabel(dest),
      ready: webReady(dest),
      problem: webProblem(dest),
    };
  }
  return {
    mode: 'new',
    id: null,
    kind: dest.mode === 'new-crate' ? 'crate' : 'rack',
    rackNumber: dest.rackNumber,
    rackRow: dest.rackRow,
    crateColor: dest.mode === 'new-crate' ? dest.crateColor : null,
    crateNumber: dest.mode === 'new-crate' ? dest.crateNumber : null,
    label: webLabel(dest),
    ready: webReady(dest),
    problem: webProblem(dest),
  };
}

function mobileDescribe(fields: MobileFields, selected: Row | null): Described {
  const dest = mobileBookDestination(fields, selected ? asDestination(selected) : null);
  if (dest === null) {
    return {
      mode: null,
      id: null,
      kind: null,
      rackNumber: null,
      rackRow: null,
      crateColor: null,
      crateNumber: null,
      label: '',
      ready: false,
      problem: null,
    };
  }
  if (dest.mode === 'existing') {
    return {
      mode: 'existing',
      id: dest.destination.id,
      kind: null,
      rackNumber: null,
      rackRow: null,
      crateColor: null,
      crateNumber: null,
      // An existing chip is called by its row's name and is complete by
      // definition; the phone has no separate ready/problem for it, exactly
      // as the web's planners answer for `mode: 'existing'`.
      label: dest.destination.name,
      ready: true,
      problem: null,
    };
  }
  const input = dest.input;
  return {
    mode: 'new',
    id: null,
    kind: input.kind,
    rackNumber: input.rackNumber,
    rackRow: input.rackRow ?? null,
    crateColor: input.kind === 'crate' ? (input.crateColor ?? null) : null,
    crateNumber: input.kind === 'crate' ? (input.crateNumber ?? null) : null,
    label: mobileLabel(input).label,
    ready: mobileReady(input),
    problem: mobileProblem(input),
  };
}

// ── The matrix ──────────────────────────────────────────────────────────────

describe('web placement-destination ≡ mobile move-stock-form — the four fields decide the same thing on both surfaces', () => {
  it('SEED: every recorded storage seeds the same four boxes and the same unknown-colour note', () => {
    for (const [name, s] of STORAGES) {
      expect(webSeed(s), `seed(${name})`).toEqual(mobileSeed(s));
    }
    // Vacuity control: the seed matrix contains at least one row that seeds
    // something and one that seeds nothing, and one unknown colour.
    expect(webSeed(STORAGES[0]![1]).fields.crateColor).toBe('yellow');
    expect(webSeed(null).fields).toEqual({
      rackNumber: '',
      rackRow: '',
      crateColor: '',
      crateNumber: '',
    });
    expect(webSeed(STORAGES[6]![1]).unknownCrateColor).toBe('mauve');
  });

  it('FILL: every existing row fills the same four boxes', () => {
    for (const r of ROWS) {
      expect(webFill(asOption(r)), `fill(${r.name})`).toEqual(mobileFill(asDestination(r)));
    }
    // Vacuity control: a legacy spelling is slugged, and an unknown colour blanks.
    expect(webFill(asOption(RED_4_ON_38B_LEGACY_CASE)).crateColor).toBe('red');
    expect(webFill(asOption(UNKNOWN_COLOUR_CRATE)).crateColor).toBe('');
  });

  it('MATCH: every (fields × row) pair answers "still equal to the row?" the same way', () => {
    let trues = 0;
    for (const [fname, f] of FIELD_SETS) {
      for (const r of ROWS) {
        const w = webMatches(f, asOption(r));
        const m = mobileMatches(f, asDestination(r));
        expect(w, `matches(${fname}, ${r.name})`).toBe(m);
        if (w) trues += 1;
      }
    }
    // Vacuity control: the matrix contains matches (yellow 6 ↔ its row, and
    // the lower-cased row; rack 38-B ↔ its row) as well as non-matches.
    expect(trues).toBeGreaterThanOrEqual(4);
    expect(trues).toBeLessThan(FIELD_SETS.length * ROWS.length);
  });

  it('DESCRIBE: every (fields × selected) pair describes the same destination — mode, id, kind, four fields, label, readiness, refusal', () => {
    const selections: Array<Row | null> = [null, ...ROWS];
    let existing = 0;
    let created = 0;
    let unready = 0;
    for (const [fname, f] of FIELD_SETS) {
      for (const sel of selections) {
        const w = webDescribe(f, sel);
        const m = mobileDescribe(f, sel);
        expect(w, `describe(${fname}, selected=${sel?.name ?? 'none'})`).toEqual(m);
        if (w.mode === 'existing') existing += 1;
        if (w.mode === 'new') created += 1;
        if (w.mode === 'new' && !w.ready) unready += 1;
      }
    }
    // Vacuity controls: the matrix reaches all three shapes, including
    // described-but-unnameable destinations (whose refusal text is compared).
    expect(existing).toBeGreaterThan(0);
    expect(created).toBeGreaterThan(0);
    expect(unready).toBeGreaterThan(0);
  });

  it('DESCRIBE, spot pins: the label both surfaces would confirm and create is the same string', () => {
    const yellow = FIELD_SETS.find(([n]) => n === 'yellow 6 on 38-B')![1];
    expect(webDescribe(yellow, null).label).toBe('Yellow #6 on rack 38-B');
    expect(mobileDescribe(yellow, null).label).toBe('Yellow #6 on rack 38-B');
    const typed = FIELD_SETS.find(([n]) => n === 'rack 38-B typed into the number box')![1];
    expect(webDescribe(typed, null).label).toBe('38-B');
    expect(mobileDescribe(typed, null).label).toBe('38-B');
    // The selected row wins while the boxes still equal it — by id, on both.
    expect(webDescribe(yellow, YELLOW_6_ON_38B).id).toBe('crate-y6');
    expect(mobileDescribe(yellow, YELLOW_6_ON_38B).id).toBe('crate-y6');
    // ...and stops winning the moment a box changes.
    const red = FIELD_SETS.find(([n]) => n === 'red 4 on 38-B')![1];
    expect(webDescribe(red, YELLOW_6_ON_38B).mode).toBe('new');
    expect(mobileDescribe(red, YELLOW_6_ON_38B).mode).toBe('new');
  });

  it('RECORDED: every (destination × storage) pair answers "is this exactly where the book is recorded?" the same way', () => {
    let trues = 0;
    for (const [fname, f] of FIELD_SETS) {
      for (const sel of [null, ...ROWS]) {
        const w = webDestinationFromFields(f, sel ? asOption(sel) : null);
        const m = mobileBookDestination(f, sel ? asDestination(sel) : null);
        // Both null or both non-null is already pinned by DESCRIBE.
        if (w === null || m === null) continue;
        for (const [sname, s] of STORAGES) {
          const wr = webIsRecorded(w, s);
          const mr = mobileIsRecorded(m, s);
          expect(wr, `recorded(${fname}, selected=${sel?.name ?? 'none'}, storage=${sname})`).toBe(
            mr,
          );
          if (wr) trues += 1;
        }
      }
    }
    // Vacuity control: the recorded truth (yellow 6 on 38-B, typed or as the
    // existing row) matches its storage on both, and plenty do not.
    expect(trues).toBeGreaterThanOrEqual(2);
  });

  it('GATE (D1): every role × effective-set answers "may this user mint the destination?" the same way', () => {
    const roles = ['owner', 'admin', 'manager', 'staff', 'viewer'] as const;
    const sets: Array<ReadonlySet<Permission> | undefined> = [
      undefined,
      new Set<Permission>(),
      new Set<Permission>(['stock:transfer']),
      new Set<Permission>(['locations:manage']),
      new Set<Permission>(['items:read', 'stock:adjust']),
      new Set<Permission>(['stock:transfer', 'locations:manage']),
    ];
    let trues = 0;
    for (const role of roles) {
      for (const permissions of sets) {
        const w = webCanMint({ role, permissions });
        const m = mobileCanMint({ role, permissions });
        expect(w, `canMint(${role}, ${permissions ? [...permissions].join('|') : 'static'})`).toBe(
          m,
        );
        if (w) trues += 1;
      }
    }
    // The phone alone knows a null role (signed out); it may do nothing.
    expect(mobileCanMint({ role: null })).toBe(false);
    // Vacuity controls: staff-static is TRUE on both (the D1 change), viewer-static FALSE on both.
    expect(webCanMint({ role: 'staff' })).toBe(true);
    expect(mobileCanMint({ role: 'staff' })).toBe(true);
    expect(webCanMint({ role: 'viewer' })).toBe(false);
    expect(mobileCanMint({ role: 'viewer' })).toBe(false);
    expect(trues).toBeGreaterThan(0);
    expect(trues).toBeLessThan(roles.length * sets.length);
  });
});
