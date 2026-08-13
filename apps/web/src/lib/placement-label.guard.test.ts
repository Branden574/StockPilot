/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RECURRENCE GUARD — every picker-facing formatter agrees on WHERE THE STOCK IS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS
 *
 * Thirteen surfaces in this repo compose a label that sends a human to a
 * physical shelf: two order slips, a cycle-count sheet, its picker, a rental
 * catalog, an orders storefront, an inventory table, an item detail card, three
 * native screens, and the export builder. Each was written where it renders,
 * and each therefore grew its own copy of the precedence.
 *
 * Copies do not stay in sync. Migration 0335 stopped a position-less crate
 * put-away from erasing an item's rack keys (erasing them was worse — a PARTIAL
 * put-away leaves the rest of the stock on a rack nobody mentioned), so those
 * keys began SURVIVING a move they no longer describe. Every copy that
 * preferred them started printing rack 38-A for stock entirely inside "Blue
 * Shelf". TWO fix waves ran before this one; each repaired the copy it was
 * pointed at and left the siblings wrong, because nobody held the list.
 *
 * ═══ WHAT WAS DONE, AND WHY BOTH HALVES WERE NEEDED ═══
 *
 * The brief offered a choice: extract one shared formatter, OR add a guard test.
 * Both shipped, because each alone leaves a real hole:
 *
 *   • EXTRACTION alone (`resolvePlacement` in packages/core) removes the
 *     precedence from the call sites — but nothing stops the FOURTEENTH surface
 *     from being written next month with a fresh hand-rolled copy. That is
 *     exactly how the thirteen got here.
 *
 *   • A GUARD alone would leave thirteen hand-written copies that merely happen
 *     to agree on the six inputs someone thought to write down.
 *
 * So: the rule lives once (ARM 1 checks the formatters still agree BY VALUE),
 * and the population is pinned (ARM 2 fails when an unclassified file starts
 * composing one of these labels).
 *
 * ═══ WHY THE EXPECTATIONS ARE LITERALS ═══
 *
 * The sibling guard (server/services/rack-shape.inventory-guard.test.ts) learned
 * this the hard way and says so in its own comments: asserting
 * `formatterA(x) === resolvePlacement(x)` PASSES FOR ANY IMPLEMENTATION THAT
 * CALLS THE RESOLVER, which is a tautology dressed as a guard. Now that every
 * formatter below delegates, comparing them to each other would be the same
 * tautology.
 *
 * So every expectation here is a LITERAL STRING, written out by hand from what
 * the surface should physically print. A formatter that stops delegating and
 * re-implements the old precedence fails on the literal, not on an identity
 * that its own delegation guarantees.
 *
 * ═══ MUTATION-PROVEN ═══
 *
 * A guard that cannot fail is not a guard. Three mutations were run against
 * this file before it shipped; each was reverted after:
 *
 *   1. Re-introduced the pre-0335 split-only rule (`if (holdings.length > 1)`)
 *      in lib/pdf/slip-location.ts. -> 7 failures, including
 *      "a formatter still names rack 38-A: expected 'Rack 38-A' not to contain
 *      '38-A'". The SPLIT fixture still passed, which is the point: the guard
 *      discriminates rather than failing wholesale.
 *
 *   2. Re-forked `locationFor` as a private copy inside packing-slip-shared.tsx
 *      that still DELEGATED, so every behavioural assertion stayed green.
 *      -> caught by the identity check alone
 *      ("expected [Function locationFor] to be [Function locationFor]").
 *      That is why the identity check exists: it catches a fork the day it is
 *      created, not the day someone edits divergence into it.
 *
 *   3. Added a new unclassified surface with its own hand-rolled precedence
 *      (components/inventory/new-shelf-label.tsx). -> ARM 2 failed with the new
 *      path in the diff. This is the failure the previous two fix waves needed
 *      and did not have.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { bookRackLabelFor } from '@/components/inventory/inventory-table';
import { countSheetLocationLabel } from '@/lib/pdf/count-sheet-location';
import { locationFor as packingSlipLocationFor } from '@/lib/pdf/packing-slip-shared';
import { locationFor as pickSlipLocationFor } from '@/lib/pdf/pick-slip';
import { locationFor as sharedLocationFor } from '@/lib/pdf/slip-location';
import { rackLabelFor as ordersCatalogRackLabelFor } from '@/server/loaders/orders-new-catalog';
import type { OrderRequestLineWithItem } from '@/server/services/order-requests';

import { formatPlacementLabel, resolvePlacement, type RackHoldingLike } from '@stockpilot/core';

// ═══════════════════════════════════════════════════════════════════════════
// THE FIXTURE SET — one physical situation per row, fed to every formatter
// ═══════════════════════════════════════════════════════════════════════════

interface Fixture {
  what: string;
  itemType: 'book' | 'product';
  customFields: Record<string, unknown>;
  binLocation: string | null;
  holdings: RackHoldingLike[];
  /**
   * The location names a human should walk to for this fixture — the ONE fact
   * every formatter must agree on, however differently each spells it.
   * Written by hand from the situation, never derived from any formatter.
   */
  walkTo: string[];
}

const FIXTURES: Fixture[] = [
  {
    // THE DEFECT, non-book arm. Every unit moved into a position-less crate;
    // mig 0335 leaves rack 38-A on the item on purpose. Anything that prints
    // "38-A" here is walking a picker to an aisle the stock has left.
    what: 'non-book moved entirely into a position-less crate',
    itemType: 'product',
    customFields: { rack_number: '38', rack_row: 'A' },
    binLocation: 'Blue Shelf',
    holdings: [{ name: 'Blue Shelf', quantity: 12, kind: 'crate' }],
    walkTo: ['Blue Shelf'],
  },
  {
    // THE DEFECT, book arm. "Rack 40-B · Crate Gray BIN" is the verbatim string
    // the regression printed on a pick slip.
    what: 'book moved entirely into a position-less crate',
    itemType: 'book',
    customFields: {
      book_rack_number: '40',
      book_rack_row: 'B',
      book_crate_color: 'gray',
      book_crate_number: 'BIN',
    },
    binLocation: 'Gray #BIN',
    holdings: [{ name: 'Gray #BIN', quantity: 5, kind: 'crate' }],
    walkTo: ['Gray #BIN'],
  },
  {
    // DO NOT OVER-CORRECT. A positioned crate's own NAME carries its rack
    // (formatCrateLocationName), so preferring the holding loses no position.
    what: 'book in a POSITIONED crate — the position must survive',
    itemType: 'book',
    customFields: { book_rack_number: '43', book_rack_row: 'B' },
    binLocation: 'Gray #BIN on rack 43-B',
    holdings: [{ name: 'Gray #BIN on rack 43-B', quantity: 5, kind: 'crate' }],
    walkTo: ['Gray #BIN on rack 43-B'],
  },
  {
    // UNCHANGED BEHAVIOUR. The narrowing is crates only — a single rack holding
    // and the item's own label name the same shelf.
    what: 'item on a plain rack, single holding',
    itemType: 'product',
    customFields: { rack_number: '2', rack_row: 'C' },
    binLocation: '2-C',
    holdings: [{ name: '2-C', quantity: 12, kind: 'rack' }],
    walkTo: ['2-C'],
  },
  {
    // UNCHANGED BEHAVIOUR. Split stock predates 0335 and must keep working.
    what: 'item split across two holdings',
    itemType: 'product',
    customFields: { rack_number: '2', rack_row: 'C' },
    binLocation: '2-C',
    holdings: [
      { name: '5-A', quantity: 5, kind: 'rack' },
      { name: '2-C', quantity: 20, kind: 'rack' },
    ],
    walkTo: ['2-C', '5-A'],
  },
  {
    // NO HOLDINGS AT ALL. Nothing contradicts the label, so the label stands —
    // this is the "additive" promise that let the resolver be adopted one
    // caller at a time.
    what: 'item with no holdings data',
    itemType: 'product',
    customFields: { rack_number: '2', rack_row: 'C' },
    binLocation: '2-C',
    holdings: [],
    walkTo: ['2-C'],
  },
];

const byWhat = (what: string): Fixture => {
  const f = FIXTURES.find((x) => x.what === what);
  if (!f) throw new Error(`no fixture "${what}"`);
  return f;
};

/** Shapes a fixture as an order line for the two slips. */
function asLine(f: Fixture) {
  return {
    id: 'L1',
    order_request_id: 'req-1',
    item_id: 'i1',
    quantity_requested: 1,
    quantity_fulfilled: 0,
    quantity_picked: null,
    unit_cost_at_request: 0,
    notes: null,
    item: {
      id: 'i1',
      name: 'Widget',
      sku: 'SKU-1',
      quantity_on_hand: 10,
      barcode: null,
      model_number: null,
      item_type: f.itemType,
      custom_fields: f.customFields,
    },
  } as unknown as OrderRequestLineWithItem;
}

const holdingsMap = (f: Fixture) => new Map([['i1', f.holdings]]);

// ═══════════════════════════════════════════════════════════════════════════
// ARM 1a — the two order slips are ONE function, not two copies
// ═══════════════════════════════════════════════════════════════════════════

describe('the pick slip and the packing slip cannot diverge again', () => {
  it('both export the SAME function object', () => {
    // The strongest possible statement of "the copy is gone": not "they agree
    // on my fixtures" but "there is only one of them". A future re-fork fails
    // here immediately, before any behavioural test has to notice.
    expect(pickSlipLocationFor).toBe(sharedLocationFor);
    expect(packingSlipLocationFor).toBe(sharedLocationFor);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM 1b — every formatter, every fixture, PINNED TO LITERALS
// ═══════════════════════════════════════════════════════════════════════════

describe('cycle-count sheet — countSheetLocationLabel', () => {
  const label = (f: Fixture) =>
    countSheetLocationLabel({
      item_type: f.itemType,
      custom_fields: f.customFields,
      bin_location: f.binLocation,
      primaryLocationName: 'DC4',
      rackHoldings: f.holdings,
    });

  it.each([
    ['non-book moved entirely into a position-less crate', 'Blue Shelf ×12'],
    ['book moved entirely into a position-less crate', 'Gray #BIN ×5'],
    ['book in a POSITIONED crate — the position must survive', 'Gray #BIN on rack 43-B ×5'],
    ['item on a plain rack, single holding', 'Rack 2-C'],
    ['item split across two holdings', '2-C ×20 · 5-A ×5'],
    ['item with no holdings data', 'Rack 2-C'],
  ])('%s -> %s', (what, expected) => {
    expect(label(byWhat(what))).toBe(expected);
  });
});

describe('order slips — locationFor (pick slip + warehouse packing slip)', () => {
  const loc = (f: Fixture) => sharedLocationFor(asLine(f), holdingsMap(f));

  it.each<[string, { primary: string | null; secondary: string | null }]>([
    [
      'non-book moved entirely into a position-less crate',
      { primary: 'Blue Shelf ×12', secondary: null },
    ],
    [
      'book moved entirely into a position-less crate',
      // NOT { primary: 'Rack 40-B', secondary: 'Crate Gray BIN' } — the exact
      // pair the regression printed.
      { primary: 'Gray #BIN ×5', secondary: null },
    ],
    [
      'book in a POSITIONED crate — the position must survive',
      { primary: 'Gray #BIN on rack 43-B ×5', secondary: null },
    ],
    ['item on a plain rack, single holding', { primary: 'Rack 2-C', secondary: null }],
    ['item split across two holdings', { primary: '2-C ×20 · 5-A ×5', secondary: null }],
    ['item with no holdings data', { primary: 'Rack 2-C', secondary: null }],
  ])('%s -> %o', (what, expected) => {
    expect(loc(byWhat(what))).toEqual(expected);
  });

  it('keeps a book CRATE SUMMARY on the second line when the rack still stands', () => {
    // The one case `secondary` exists for. Not in the matrix above because no
    // fixture there is both book-typed and uncontradicted.
    const line = asLine({
      ...byWhat('item on a plain rack, single holding'),
      itemType: 'book',
      customFields: {
        book_rack_number: '39',
        book_rack_row: 'B',
        book_crate_color: 'red',
        book_crate_number: '5',
      },
    });
    expect(sharedLocationFor(line, new Map([['i1', [{ name: '39-B', quantity: 4, kind: 'rack' }]]])))
      .toEqual({ primary: 'Rack 39-B', secondary: 'Crate Red 5' });
  });
});

describe('inventory table, BOOKS view — bookRackLabelFor', () => {
  const label = (f: Fixture) =>
    bookRackLabelFor({ custom_fields: f.customFields, placed_holdings: f.holdings });

  it.each([
    // The books layout renders no quantities in this cell — names only.
    ['book moved entirely into a position-less crate', 'Gray #BIN'],
    ['book in a POSITIONED crate — the position must survive', 'Gray #BIN on rack 43-B'],
  ])('%s -> %s', (what, expected) => {
    expect(label(byWhat(what))).toBe(expected);
  });

  it('a book still on its rack shows the bare rack label', () => {
    expect(
      bookRackLabelFor({
        custom_fields: { book_rack_number: '39', book_rack_row: 'B' },
        placed_holdings: [{ name: '39-B', quantity: 4, kind: 'rack' }],
      }),
    ).toBe('39-B');
  });

  it('shows every name when the stock is split', () => {
    expect(
      bookRackLabelFor({
        custom_fields: { book_rack_number: '39', book_rack_row: 'B' },
        placed_holdings: [
          { name: '5-A', quantity: 5, kind: 'rack' },
          { name: '39-B', quantity: 4, kind: 'rack' },
        ],
      }),
    ).toBe('39-B, 5-A');
  });
});

describe('the core render — formatPlacementLabel(resolvePlacement(…))', () => {
  // The rendering the cycle-count PICKER and the native screens use directly,
  // so it is pinned here rather than only inside packages/core.
  const label = (f: Fixture) =>
    formatPlacementLabel(
      resolvePlacement({
        itemType: f.itemType,
        customFields: f.customFields,
        binLocation: f.binLocation,
        holdings: f.holdings,
      }),
    );

  it.each([
    ['non-book moved entirely into a position-less crate', 'Blue Shelf ×12'],
    ['book moved entirely into a position-less crate', 'Gray #BIN ×5'],
    ['book in a POSITIONED crate — the position must survive', 'Gray #BIN on rack 43-B ×5'],
    ['item on a plain rack, single holding', 'Rack 2-C'],
    ['item split across two holdings', '2-C ×20 · 5-A ×5'],
    ['item with no holdings data', 'Rack 2-C'],
  ])('%s -> %s', (what, expected) => {
    expect(label(byWhat(what))).toBe(expected);
  });
});

describe('orders storefront — rackLabelFor (THE deliberate exception)', () => {
  // BIN-FIRST, because this loader carries no holdings and `bin_location` is
  // the freshest thing it has post-0335. Pinned by value so nobody
  // "harmonises" it into the majority rule and thereby breaks it — and so that
  // the day it gains holdings, this test is the thing that has to be
  // deliberately rewritten rather than silently satisfied.
  const label = (f: Fixture) =>
    ordersCatalogRackLabelFor({
      item_type: f.itemType,
      bin_location: f.binLocation,
      rack_number: (f.customFields.rack_number as string) ?? null,
      rack_row: (f.customFields.rack_row as string) ?? null,
      book_rack_number: (f.customFields.book_rack_number as string) ?? null,
      book_rack_row: (f.customFields.book_rack_row as string) ?? null,
    });

  it.each([
    // Lands on the crate — via bin_location, not via the holdings it lacks.
    ['non-book moved entirely into a position-less crate', 'Blue Shelf'],
    ['book moved entirely into a position-less crate', 'Gray #BIN'],
    ['book in a POSITIONED crate — the position must survive', 'Gray #BIN on rack 43-B'],
    ['item on a plain rack, single holding', '2-C'],
    ['item split across two holdings', '2-C'],
    ['item with no holdings data', '2-C'],
  ])('%s -> %s', (what, expected) => {
    expect(label(byWhat(what))).toBe(expected);
  });

  it('falls back to the rack pair only when bin_location is blank', () => {
    expect(
      ordersCatalogRackLabelFor({
        item_type: 'product',
        bin_location: '   ',
        rack_number: '38',
        rack_row: 'A',
        book_rack_number: null,
        book_rack_row: null,
      }),
    ).toBe('38-A');
  });

  it('KNOWN LIMIT: with a blank label it still names a departed rack', () => {
    // Recorded rather than hidden. A row never touched by a put-away has no
    // bin_location, so this loader has nothing fresher than the pair. Fixing it
    // needs holdings — see the doc on rackLabelFor. If this expectation ever
    // flips to 'Blue Shelf', the loader gained holdings and the exception above
    // should be retired.
    expect(
      ordersCatalogRackLabelFor({
        item_type: 'product',
        bin_location: null,
        rack_number: '38',
        rack_row: 'A',
        book_rack_number: null,
        book_rack_row: null,
      }),
    ).toBe('38-A');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM 1c — THE AGREEMENT. Different spellings, same physical place.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reduces a rendered label to the set of location NAMES inside it, so
 * "Rack 2-C", "2-C", "2-C ×12" and "2-C, 5-A" all compare equal to ['2-C'] /
 * ['2-C','5-A'].
 *
 * Deliberately a dumb string reducer, NOT a call into the resolver: its whole
 * job is to be independent of the thing under test.
 */
function namesIn(label: string | null): string[] {
  if (!label) return [];
  return label
    .split(/ · |, /)
    .map((part) => part.replace(/ ×\d+$/, '').replace(/^(?:Rack|Crate) /, '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

describe('the reducer the agreement check depends on', () => {
  // A comparator that silently returns [] for everything would make the
  // agreement check below pass for any input. Pin it.
  it.each([
    ['Rack 2-C', ['2-C']],
    ['2-C ×12', ['2-C']],
    ['2-C ×20 · 5-A ×5', ['2-C', '5-A']],
    ['39-B, 5-A', ['39-B', '5-A']],
    ['Gray #BIN on rack 43-B ×5', ['Gray #BIN on rack 43-B']],
    ['Blue Shelf', ['Blue Shelf']],
    [null, []],
  ] as Array<[string | null, string[]]>)('%o -> %o', (input, expected) => {
    expect(namesIn(input)).toEqual(expected);
  });
});

describe('every formatter names the SAME physical location', () => {
  it.each(FIXTURES.map((f) => [f.what, f] as const))('%s', (_what, f) => {
    const countSheet = countSheetLocationLabel({
      item_type: f.itemType,
      custom_fields: f.customFields,
      bin_location: f.binLocation,
      primaryLocationName: 'DC4',
      rackHoldings: f.holdings,
    });
    const slip = sharedLocationFor(asLine(f), holdingsMap(f));
    const core = formatPlacementLabel(
      resolvePlacement({
        itemType: f.itemType,
        customFields: f.customFields,
        binLocation: f.binLocation,
        holdings: f.holdings,
      }),
    );
    const storefront = ordersCatalogRackLabelFor({
      item_type: f.itemType,
      bin_location: f.binLocation,
      rack_number: (f.customFields.rack_number as string) ?? null,
      rack_row: (f.customFields.rack_row as string) ?? null,
      book_rack_number: (f.customFields.book_rack_number as string) ?? null,
      book_rack_row: (f.customFields.book_rack_row as string) ?? null,
    });

    // `walkTo` is hand-written on the fixture, so this is a check against the
    // SITUATION, not against whichever formatter happened to run first.
    expect(namesIn(countSheet), 'cycle-count sheet').toEqual(f.walkTo);
    expect(namesIn(slip.primary), 'order slips').toEqual(f.walkTo);
    expect(namesIn(core), 'core render').toEqual(f.walkTo);

    // The storefront is bin-first and holdings-blind, so it agrees on WHERE but
    // legitimately shows only one name for split stock (its bin_location).
    expect(f.walkTo).toEqual(expect.arrayContaining(namesIn(storefront)));
    expect(namesIn(storefront).length).toBeGreaterThan(0);
  });

  it('the books table agrees too, on the fixtures its layout can render', () => {
    // Books-only layout, so the two book fixtures.
    for (const what of [
      'book moved entirely into a position-less crate',
      'book in a POSITIONED crate — the position must survive',
    ]) {
      const f = byWhat(what);
      expect(
        namesIn(bookRackLabelFor({ custom_fields: f.customFields, placed_holdings: f.holdings })),
        what,
      ).toEqual(f.walkTo);
    }
  });

  it('NONE of them prints a rack the stock has left', () => {
    // The single sentence the whole file exists for, asserted directly.
    for (const what of [
      'non-book moved entirely into a position-less crate',
      'book moved entirely into a position-less crate',
    ]) {
      const f = byWhat(what);
      const departed = f.itemType === 'book' ? '40-B' : '38-A';
      const rendered = [
        countSheetLocationLabel({
          item_type: f.itemType,
          custom_fields: f.customFields,
          bin_location: f.binLocation,
          primaryLocationName: 'DC4',
          rackHoldings: f.holdings,
        }),
        sharedLocationFor(asLine(f), holdingsMap(f)).primary,
        sharedLocationFor(asLine(f), holdingsMap(f)).secondary,
        formatPlacementLabel(
          resolvePlacement({
            itemType: f.itemType,
            customFields: f.customFields,
            binLocation: f.binLocation,
            holdings: f.holdings,
          }),
        ),
        bookRackLabelFor({ custom_fields: f.customFields, placed_holdings: f.holdings }),
        ordersCatalogRackLabelFor({
          item_type: f.itemType,
          bin_location: f.binLocation,
          rack_number: (f.customFields.rack_number as string) ?? null,
          rack_row: (f.customFields.rack_row as string) ?? null,
          book_rack_number: (f.customFields.book_rack_number as string) ?? null,
          book_rack_row: (f.customFields.book_rack_row as string) ?? null,
        }),
      ];
      for (const label of rendered) {
        expect(label ?? '', `${what}: a formatter still names rack ${departed}`).not.toContain(
          departed,
        );
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM 2 — THE INVENTORY. A fourteenth copy cannot land unnoticed.
// ═══════════════════════════════════════════════════════════════════════════
//
// Arm 1 proves the formatters it KNOWS ABOUT agree. It is blind to the one
// failure that actually happened twice: a surface nobody remembered. So the
// population is pinned here — every file that reads the rack pair for display,
// or that renders a placement through the shared helpers, must appear in
// exactly one list below, and every file in DELEGATES_TO_RESOLVER must really
// call the resolver in CODE (not merely name it in a comment, which is how two
// files looked like delegates on a first grep).
//
// If this fails, do NOT just paste the path in. Decide first: does the file
// COMPOSE a walk-to label (then it belongs in DELEGATES_TO_RESOLVER and must
// call resolvePlacement), or does it merely PROJECT a stored field / RENDER a
// label someone else computed? That decision is the entire point.

/** Drop comments so the checks below match CODE, never prose. Same shape (and
 *  same deliberate timidity) as rack-shape.inventory-guard.test.ts. */
function stripComments(src: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('/*') || trimmed.startsWith('{/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

const REPO_ROOT = path.resolve(process.cwd(), '..', '..');
const SCAN_ROOTS = ['apps/web/src', 'apps/mobile/app', 'apps/mobile/src', 'packages/core/src'];

/** Anything that reads the rack pair for display, or renders a placement. */
const PLACEMENT_SYMBOLS =
  'readBookStorage|readItemRack|rackLabel|resolvePlacement|holdingsContradictRack|formatPlacementLabel|countSheetLocationLabel';

function scanPlacementFiles(): string[] {
  const out = execFileSync('grep', ['-rlE', String.raw`\b(${PLACEMENT_SYMBOLS})\b`, ...SCAN_ROOTS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const shape = new RegExp(String.raw`\b(${PLACEMENT_SYMBOLS})\b`);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.includes('.test.'))
    .filter((file) => shape.test(stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'))))
    .sort();
}

/**
 * COMPOSES a walk-to label, or decides whether a stored one still holds. Must
 * reach placement-resolution.ts IN CODE — enforced below, not merely requested.
 *
 * REWRITTEN (reason): the module now has TWO entry points, because the two
 * questions are genuinely different and conflating them caused a regression.
 * `resolvePlacement` answers "where do I send a picker" for a surface with one
 * cell; `holdingsContradictRack` answers "is this stored rack still true" for a
 * card with room for the summary AND the live holdings. The item cards used the
 * first as a stand-in for the second and so blanked the Rack and Crate rows of
 * every SPLIT item — rows main always showed. The check below therefore accepts
 * either call. What it still refuses is a file deciding for itself: the
 * hand-rolled-crate-rule check underneath is unchanged and applies to both.
 */
const DELEGATES_TO_RESOLVER = [
  'apps/mobile/app/(drawer)/(tabs)/books.tsx',
  'apps/mobile/app/(drawer)/(tabs)/scan.tsx',
  // The native item screen's row list was EXTRACTED here so it could be tested:
  // apps/mobile's vitest config is environment 'node' with include
  // ['src/**/*.test.ts'], so a .tsx screen is unreachable but a src/lib module
  // is not. This module owns the precedence; the screen it serves renders the
  // rows and now appears under RENDERS_PRECOMPUTED.
  'apps/mobile/src/lib/placement-rows.ts',
  'apps/web/src/app/(dashboard)/dashboard/rentals/new/page.tsx',
  'apps/web/src/components/cycle-counts/count-item-picker.tsx',
  'apps/web/src/components/inventory/inventory-table.tsx',
  'apps/web/src/components/inventory/item-detail.tsx',
  'apps/web/src/lib/pdf/count-sheet-location.ts',
  'apps/web/src/lib/pdf/slip-location.ts',
] as const;

/** THE RULE itself, and the readers it is built on. */
const THE_RULE_AND_ITS_READERS = [
  'apps/web/src/lib/book-storage.ts',
  'packages/core/src/inventory/book-storage.ts',
  'packages/core/src/inventory/placement-resolution.ts',
] as const;

/**
 * BIN-FIRST BY DESIGN, and the only exception in the repo. It carries no
 * holdings, so the resolver would make it WORSE, not better — see the doc on
 * `rackLabelFor` and the literal pins in Arm 1b.
 */
const BIN_FIRST_EXCEPTION = ['apps/web/src/server/loaders/orders-new-catalog.ts'] as const;

/**
 * RAW FIELD PROJECTIONS — export columns named after the STORED keys, not
 * walk-to labels, and deliberately left alone.
 *
 * A column headed "Rack number" whose value is not `custom_fields.rack_number`
 * is lying about what it is; and `/api/inventory/export.csv` is contractually
 * byte-frozen (see the notes in inventory-export.ts and source-row.ts). Neither
 * is a document a picker walks the warehouse with, which was the severity test
 * that made the slips urgent.
 *
 * The consequence is real and is recorded here rather than hidden: an Export
 * Builder "Rack" column CAN name a rack the stock has left. Fixing it needs a
 * new holdings-derived SOURCE FIELD on InventoryExportSourceRow (which carries
 * neither holdings nor bin_location today) plus a new column — an additive
 * feature with its own preset/width tests, not a predicate change.
 */
const RAW_FIELD_PROJECTIONS = [
  'apps/web/src/lib/exports/field-registry.ts',
  'apps/web/src/lib/exports/source-row.ts',
  'apps/web/src/lib/inventory-export.ts',
] as const;

/** Renders a `rackLabel` computed upstream (by a delegate or the exception).
 *  Owns no precedence of its own. */
const RENDERS_PRECOMPUTED = [
  // MOVED here from DELEGATES_TO_RESOLVER (reason): the screen no longer decides
  // anything — it calls buildPlacementRows() and renders what comes back. It
  // still matches the scan because it names `rackLabel` in code, so it must stay
  // classified; it simply is not a delegate any more. If it ever re-grows its own
  // precedence, the delegate arm below will not catch it — the hand-rolled-rule
  // check will.
  'apps/mobile/app/item/[id].tsx',
  'apps/web/src/components/orders/storefront/storefront-overlays.tsx',
  'apps/web/src/components/orders/v2/item-card.tsx',
  'apps/web/src/components/orders/v2/types.ts',
] as const;

/**
 * INTENTIONALLY SHOWS THE STORED SUMMARY. `CurrentStorageSummary` is context
 * for a put-away decision, shown beside the live destination picker — its own
 * doc calls it "context for the decision, never an input". It will show a stale
 * rack, and that is the point: it is reporting what the item currently says,
 * which is what the operator is about to change.
 */
const STORED_SUMMARY_BY_DESIGN = [
  'apps/web/src/components/inventory/crate-fields.tsx',
  // The SERVICE side of the same idea. `readBookStorage` appears twice in
  // InventoryService: once to build the "currently recorded as…" summary the
  // placement gate shows an operator, and once on the staged worklist for the
  // same purpose. Both report what the item SAYS, next to the control that is
  // about to change it. Neither composes a walk-to label, and neither should
  // start; if one does, it moves to DELEGATES_TO_RESOLVER.
  'apps/web/src/server/services/inventory.ts',
] as const;

/**
 * CALLS a shared formatter and renders the result. Owns no precedence — listed
 * so the population stays exhaustive and a route that starts composing its own
 * label cannot hide behind "it only calls the helper".
 */
const CALLS_SHARED_FORMATTER = ['apps/web/src/app/api/cycle-counts/[id]/pdf/route.tsx'] as const;

describe('placement-label inventory guard', () => {
  it('every file that composes or renders a placement label is classified', () => {
    const known = [
      ...DELEGATES_TO_RESOLVER,
      ...THE_RULE_AND_ITS_READERS,
      ...BIN_FIRST_EXCEPTION,
      ...RAW_FIELD_PROJECTIONS,
      ...RENDERS_PRECOMPUTED,
      ...STORED_SUMMARY_BY_DESIGN,
      ...CALLS_SHARED_FORMATTER,
    ].sort();
    expect(scanPlacementFiles()).toEqual(known);
  });

  it('every delegate really CALLS the shared rule, not just mentions it', () => {
    for (const file of DELEGATES_TO_RESOLVER) {
      const code = stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      expect(
        /\b(?:resolvePlacement|holdingsContradictRack)\s*\(/.test(code),
        `${file} is listed as a delegate but never calls resolvePlacement() or holdingsContradictRack() in code. A hand-rolled precedence here is how the 0335 stale-rack bug reached eleven surfaces.`,
      ).toBe(true);
    }
  });

  it('no delegate re-implements the CRATE-ONLY rule by hand', () => {
    // The exact shape to keep out is `holdings.every(h => h.kind === 'crate')`
    // — a formatter deciding for itself what a crate-only holding means. There
    // is one spelling of that rule and it lives in packages/core.
    //
    // NOT matched: a bare `kind === 'crate'`, which is how several of these
    // files legitimately FILTER holdings down to rack/crate rows (the same
    // narrowing fetchRackHoldingsByItem does in SQL). Selecting which holdings
    // to pass in is the caller's job; deciding what they MEAN is not.
    const CRATE_ONLY_RULE = /\.every\([\s\S]{0,120}?crate/;
    for (const file of DELEGATES_TO_RESOLVER) {
      const code = stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      expect(
        CRATE_ONLY_RULE.test(code),
        `${file} decides for itself what an all-crate holding set means — that predicate belongs to resolvePlacement, and a second copy of it is exactly how the 0335 bug outlived two fix waves.`,
      ).toBe(false);
    }
  });

  it('...and that check can actually fail', () => {
    // A guard that cannot fail is not a guard. Pin the pattern against the real
    // pre-extraction spelling and against the shapes it must NOT flag.
    const CRATE_ONLY_RULE = /\.every\([\s\S]{0,120}?crate/;
    expect(CRATE_ONLY_RULE.test("holdings.every((h) => h.kind === 'crate')")).toBe(true);
    expect(CRATE_ONLY_RULE.test("hs.every(h => h.kind === \"crate\")")).toBe(true);
    // Selection, not the rule.
    expect(CRATE_ONLY_RULE.test("holdings.filter((h) => h.kind === 'crate')")).toBe(false);
    expect(CRATE_ONLY_RULE.test("h.kind === 'rack' || h.kind === 'crate'")).toBe(false);
  });

  it('the bin-first exception is the ONLY file outside core deciding precedence', () => {
    expect(BIN_FIRST_EXCEPTION).toHaveLength(1);
  });

  it('placementPhysicalNames has a PRODUCTION caller, and it is not this guard', () => {
    // It shipped with a doc claiming "this is what the cross-formatter guard
    // compares" and no caller but its own unit test — a dead export whose
    // comment described a relationship that did not exist. The guard reduces
    // labels with its OWN dumb string reducer (`namesIn`) on purpose: every
    // formatter under test delegates to the resolver, so comparing them against
    // a second reader of the resolution would be the tautology this file's
    // header warns about. The honest fix was a real caller — the books
    // SKU-group header, which needs the names UN-JOINED to count distinct
    // racks. Pin that, so the export cannot quietly become dead again.
    const callers = execFileSync(
      'grep',
      ['-rlE', String.raw`\bplacementPhysicalNames\s*\(`, ...SCAN_ROOTS],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes('.test.'))
      .filter((l) => !l.endsWith('placement-resolution.ts'))
      .sort();
    expect(callers).toEqual(['apps/web/src/components/inventory/inventory-table.tsx']);
    // ...and the guard still compares with its own reducer, not with that one.
    const self = readFileSync(
      path.join(REPO_ROOT, 'apps/web/src/lib/placement-label.guard.test.ts'),
      'utf8',
    );
    expect(/placementPhysicalNames\s*\(/.test(stripComments(self))).toBe(false);
  });
});
