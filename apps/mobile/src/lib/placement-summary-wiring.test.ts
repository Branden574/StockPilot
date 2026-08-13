import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WIRING PINS — the two native screens that render a book's PLACEMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rules themselves are pure and tested in @stockpilot/core
 * (placement-resolution.test.ts, holdings-contradict-rack.test.ts). Neither
 * screen can be rendered here — the vitest config deliberately excludes app/
 * screens, which import native modules at load — so these source-level
 * assertions pin the wiring, and each encodes a specific defect:
 *
 *  1. app/item/[id].tsx used `resolution.source === 'holdings'` as its
 *     hide-the-summary flag. That is TRUE for the SPLIT arm as well as the
 *     crate arm, so a book split across two racks lost its RACK row, its CRATE
 *     row and its BIN row — three rows main had always shown, for stock whose
 *     label was perfectly true. The rack row now stands down only on a real
 *     refutation (`holdingsContradictRack`), and the crate row on nothing.
 *
 *  2. (drawer)/(tabs)/books.tsx fed `bin_location` into the resolver, which
 *     ranked it ahead of charter and site for any row with no holdings and no
 *     rack pair — a different set of books from the ones the 0335 fix is about,
 *     and a pre-0335 free-text bin is exactly as capable of being stale as the
 *     rack pair was. The card's fallback order is rack, then charter, then site.
 *
 *  3. Neither screen may re-implement the crate rule. One spelling of it lives
 *     in packages/core; a second copy is how the 0335 bug outlived two fix
 *     waves across eleven surfaces.
 */

const read = (rel: string): string => readFileSync(path.resolve(__dirname, rel), 'utf8');

const itemScreen = read('../../app/item/[id].tsx');
const booksScreen = read('../../app/(drawer)/(tabs)/books.tsx');

/** Source with comments stripped — the pins below are about what these files
 *  DO, and their own doc-comments discuss exactly the shapes being pinned out. */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const itemCode = codeOnly(itemScreen);
const booksCode = codeOnly(booksScreen);

describe('native item screen — a SPLIT is not a contradiction', () => {
  it('gates the RACK row on the refutation predicate, never on "the holdings won"', () => {
    expect(itemCode).toContain('holdingsContradictRack(item.rack_label, item.rackHoldings)');
    expect(itemCode).toContain("if (rackStands) rows.push({ label: 'RACK'");
  });

  it('renders the CRATE row unconditionally — nothing here refutes a crate note', () => {
    expect(itemCode).toContain(
      "if (isBookView && (item.crate_color || item.crate_number)) {",
    );
    // The regression shape, spelled out so a re-introduction fails loudly.
    expect(itemCode).not.toContain('holdingsContradictLabel && isBookView');
  });

  it('never reuses resolvePlacement\'s verdict as the hide-the-summary flag', () => {
    expect(itemCode).not.toContain("const holdingsContradictLabel = placement.source === 'holdings'");
  });

  it('still shows the live holdings as their OWN row — added information, not a swap', () => {
    expect(itemCode).toContain("placement.reason === 'split' ? 'SPLIT STOCK' : 'IN CRATE'");
  });

  it('shows BIN only when no rack label stands and no holdings row already named the place', () => {
    expect(itemCode).toContain('if (!rackStands && !holdingsRowShown && item.bin_location)');
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

describe('neither screen owns a second copy of the crate rule', () => {
  const CRATE_ONLY_RULE = /\.every\([\s\S]{0,120}?crate/;
  it.each([
    ['app/item/[id].tsx', itemCode],
    ['app/(drawer)/(tabs)/books.tsx', booksCode],
  ])('%s', (_file, code) => {
    expect(CRATE_ONLY_RULE.test(code)).toBe(false);
  });

  it('...and that check can actually fail', () => {
    expect(CRATE_ONLY_RULE.test("holdings.every((h) => h.kind === 'crate')")).toBe(true);
    expect(CRATE_ONLY_RULE.test("h.kind === 'rack' || h.kind === 'crate'")).toBe(false);
  });
});
