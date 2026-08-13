import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WIRING PINS — the three native screens that render a book's PLACEMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rules themselves are pure and tested in @stockpilot/core
 * (placement-resolution.test.ts, holdings-contradict-rack.test.ts). None of the
 * screens can be rendered here — the vitest config deliberately excludes app/
 * screens, which import native modules at load — so these source-level
 * assertions pin the wiring, and each encodes a specific defect.
 *
 * They are source pins ON PURPOSE, not a fallback. What was wrong in every case
 * below is WHICH QUESTION THE SCREEN ASKED, and the answers to both questions
 * are already covered behaviourally in core. Re-testing the predicate through a
 * screen-shaped wrapper would assert core's own test again; the only claim left
 * to make is about the call the screen actually writes.
 *
 *  1. app/item/[id].tsx used `resolution.source === 'holdings'` as its
 *     hide-the-summary flag. That is TRUE for the SPLIT arm as well as the
 *     crate arm, so a book split across two racks lost its RACK row, its CRATE
 *     row and its BIN row — three rows main had always shown, for stock whose
 *     label was perfectly true. The rack row now stands down only on a real
 *     refutation (`holdingsContradictRack`), and the crate row on nothing.
 *
 *     WHY THIS BLOCK IS THINNER THAN IT WAS. The fix above was pinned HERE, as
 *     source text, and the pin held while the behaviour was wrong: the screen
 *     was passing its DISPLAY label ("38 · A", a middle dot) into a predicate
 *     that canonicalises by splitting on the last DASH, so the refutation
 *     answered "contradicted" for essentially every item with a holding and the
 *     RACK row vanished — including the positioned-crate row this pin was
 *     written to protect. A pin that spells the call cannot see what the call is
 *     handed. The row semantics therefore moved to src/lib/placement-rows.ts,
 *     where placement-rows.test.ts asserts on the ROWS THEMSELVES; what is left
 *     here is the one thing that file cannot check — that the screen still
 *     delegates and owns no second copy.
 *
 *  2. (drawer)/(tabs)/books.tsx fed `bin_location` into the resolver, which
 *     ranked it ahead of charter and site for any row with no holdings and no
 *     rack pair — a different set of books from the ones the 0335 fix is about,
 *     and a pre-0335 free-text bin is exactly as capable of being stale as the
 *     rack pair was. The card's fallback order is rack, then charter, then site.
 *
 *  3. (drawer)/(tabs)/scan.tsx — the THIRD card of defect 1, missed by the wave
 *     that fixed the other two. It folded its Rack and Crate rows on
 *     `placement.source === 'structured'`, the same verdict-as-hide-flag shape
 *     wearing the other polarity: false for every SPLIT, so a book split across
 *     two racks scanned with no Rack and no Crate row beside its "Split stock"
 *     line. That was a regression against main, which drew both rows
 *     unconditionally. The scan sheet is the surface core's own doc reserves
 *     for this predicate ("a card with room to show the summary AND the
 *     holdings") and it never called it.
 *
 *  4. The value handed to `holdingsContradictRack` must be a STRUCTURED rack
 *     label, never a rendered one: the predicate canonicalises through
 *     `parseRackLabel`, which splits on the last DASH, so a display join like
 *     "38 · A" parses as a row-less number, matches no holding, and reports
 *     every true label as refuted. Silent, and in the direction of blanking
 *     rows — the exact failure this file exists to stop.
 *
 *  5. No screen may re-implement the crate rule. One spelling of it lives in
 *     packages/core; a second copy is how the 0335 bug outlived two fix waves
 *     across eleven surfaces.
 */

const read = (rel: string): string => readFileSync(path.resolve(__dirname, rel), 'utf8');

const itemScreen = read('../../app/item/[id].tsx');
const booksScreen = read('../../app/(drawer)/(tabs)/books.tsx');
const scanScreen = read('../../app/(drawer)/(tabs)/scan.tsx');

/** Source with comments stripped — the pins below are about what these files
 *  DO, and their own doc-comments discuss exactly the shapes being pinned out. */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const itemCode = codeOnly(itemScreen);
const booksCode = codeOnly(booksScreen);
const scanCode = codeOnly(scanScreen);

describe('native item screen — the rows are DELEGATED, and the screen keeps the pair', () => {
  // The row semantics themselves — a split keeps its RACK row, a positioned
  // crate keeps its RACK row, a departed rack loses it, BIN fills in only for
  // an item nothing else describes — are asserted on the ROWS in
  // placement-rows.test.ts. Left here: the claims only the source can make.
  it('delegates to the shared row builder and owns no rule of its own', () => {
    expect(itemCode).toContain('buildPlacementRows({');
    expect(itemCode).not.toContain('holdingsContradictRack(');
    expect(itemCode).not.toContain('resolvePlacement(');
  });

  it('hands over the rack PAIR, never a rendered label', () => {
    // The regression, spelled out so a re-introduction fails loudly: the screen
    // used to pass its display string ("38 · A") into a predicate that splits
    // on the last DASH, and every true rack read as refuted.
    expect(itemCode).toContain('rackNumber: item.rack_number');
    expect(itemCode).toContain('rackRow: item.rack_row');
    expect(itemCode).not.toMatch(/item\.rack_label\b/);
    // A whole-label field cannot come back under another name either: this
    // screen no longer joins the rack pair into a label AT ALL. (Unrelated
    // joins are none of this pin's business — the header line really does
    // join category and barcode with the same separator.)
    expect(itemCode).not.toMatch(/\[\s*rackNum\s*,\s*rackRow\s*\][\s\S]{0,40}?\.join\(/);
  });

  it('still carries the live holdings, without which the crate rule cannot fire', () => {
    expect(itemCode).toContain('holdings: item.rackHoldings');
    expect(itemCode).toContain("select('quantity, locations!inner(name, kind)')");
  });

  it('...and those checks can actually fail', () => {
    // A guard that cannot fail is not a guard. The shapes below are the real
    // before-and-after spellings of this very screen.
    const PAIR_JOIN = /\[\s*rackNum\s*,\s*rackRow\s*\][\s\S]{0,40}?\.join\(/;
    expect(/item\.rack_label\b/.test('holdingsContradictRack(item.rack_label, x)')).toBe(true);
    expect(/item\.rack_label\b/.test('legacyRackLabel: item.legacy_rack_label,')).toBe(false);
    expect(PAIR_JOIN.test("[rackNum, rackRow].filter(Boolean).join(' · ')")).toBe(true);
    expect(PAIR_JOIN.test("[item.category_name, item.barcode].filter(Boolean).join(' · ')")).toBe(
      false,
    );
  });
});

describe('the shared row builder — the two alphabets stay separated', () => {
  const rowsCode = codeOnly(read('./placement-rows.ts'));

  it('compares a canonical label built from the PAIR, not the rendered one', () => {
    expect(rowsCode).toContain('holdingsContradictRack(rackKey, input.holdings)');
    expect(rowsCode).toContain('formatRackPosition({ rackNumber: input.rackNumber, rackRow: input.rackRow })');
    // rackDisplay is what a human reads. It must never reach the predicate.
    expect(rowsCode).not.toMatch(/holdingsContradictRack\(\s*rackDisplay/);
    expect(rowsCode).not.toMatch(/holdingsContradictRack\(\s*formatPlacementLabel/);
  });

  it('keeps the display separator it has had since 42cacb9b', () => {
    // Not a "fix" this bug is allowed to make: what a user sees a rack called
    // is unrelated to why the comparison missed.
    expect(rowsCode).toMatch(/join\(\s*' · '\s*\)/);
  });
});

describe('native books list — the card fallback order is unchanged by the 0335 fix', () => {
  it('does not feed bin_location into the resolver, and does not select the column', () => {
    expect(booksCode).not.toContain('binLocation:');
    expect(booksCode).not.toContain('bin_location');
  });

  it('falls back rack, then charter, then site', () => {
    expect(booksCode).toContain('return res.rackLabel ?? charter ?? loc;');
    expect(booksCode).toContain('return charter ?? loc;');
  });

  it('still resolves through the shared rule, so a departed rack never prints', () => {
    expect(booksCode).toContain('resolvePlacement({');
    expect(booksCode).toContain('holdings: holdings.get(b.id)');
  });
});

describe('native scan sheet — the third card of the same fold', () => {
  it('gates the RACK row on the refutation predicate, never on the resolver verdict', () => {
    expect(scanCode).toContain('holdingsContradictRack(summaryRack, item?.rackHoldings)');
    expect(scanCode).toContain('{structuredRack && <LocRow label="Rack" value={structuredRack} mono />}');
  });

  it('renders the CRATE row unconditionally — nothing here refutes a crate note', () => {
    expect(scanCode).toContain('{storage?.crateNumber && (');
    // The regression shape, spelled out so a re-introduction fails loudly. The
    // sheet gated BOTH rows on a flag that is false for every split.
    expect(scanCode).not.toContain('showStructured');
  });

  it("never reuses resolvePlacement's verdict as the hide-the-summary flag", () => {
    expect(scanCode).not.toContain("placement?.source === 'structured' ? placement.rackLabel");
    expect(scanCode).not.toContain("const showStructured = placement?.source === 'structured'");
  });

  it('still shows the live holdings as their OWN row — added information, not a swap', () => {
    expect(scanCode).toContain("placement.reason === 'split' ? 'Split stock' : 'In crate'");
  });

  it('reads the summary rack from the STRUCTURED arm, not from a rendered label', () => {
    expect(scanCode).toContain("summary?.source === 'structured' ? summary.rackLabel : null");
    // formatPlacementLabel joins with a middle dot; parseRackLabel splits on a
    // dash. Feeding the first into the predicate makes every comparison miss.
    expect(scanCode).not.toMatch(/holdingsContradictRack\(\s*formatPlacementLabel/);
  });

  it('builds no rack label of its own with a display separator', () => {
    expect(scanCode).not.toMatch(/join\(\s*' · '\s*\)/);
  });

  it('...and that separator check can actually fail', () => {
    // A guard that cannot fail is not a guard. Pin it against the live spelling
    // in app/item/[id].tsx, which really does join a rack pair this way.
    expect(/join\(\s*' · '\s*\)/.test("[rackNum, rackRow].filter(Boolean).join(' · ')")).toBe(true);
    expect(/join\(\s*' · '\s*\)/.test("[rackNum, rackRow].filter(Boolean).join('-')")).toBe(false);
  });
});

describe('no screen owns a second copy of the crate rule', () => {
  const CRATE_ONLY_RULE = /\.every\([\s\S]{0,120}?crate/;
  it.each([
    ['app/item/[id].tsx', itemCode],
    ['app/(drawer)/(tabs)/books.tsx', booksCode],
    ['app/(drawer)/(tabs)/scan.tsx', scanCode],
    // The item screen's rows moved here; the rule must not have moved with them.
    ['src/lib/placement-rows.ts', codeOnly(read('./placement-rows.ts'))],
  ])('%s', (_file, code) => {
    expect(CRATE_ONLY_RULE.test(code)).toBe(false);
  });

  it('...and that check can actually fail', () => {
    expect(CRATE_ONLY_RULE.test("holdings.every((h) => h.kind === 'crate')")).toBe(true);
    expect(CRATE_ONLY_RULE.test("h.kind === 'rack' || h.kind === 'crate'")).toBe(false);
  });
});
