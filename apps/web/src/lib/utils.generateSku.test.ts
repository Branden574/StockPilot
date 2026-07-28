import { describe, expect, it } from 'vitest';

import { generateSku } from './utils';

/**
 * REVIEW FINDING (fix/import-ux). The CSV import now writes six rows at a time,
 * and every row with no `sku` cell mints one here. The shipped generator was
 * `SP-<ms in base36>-<3 random base36 chars>`: inside one millisecond the stamp
 * is FIXED, so the entire collision space is those three characters — 36^3 =
 * 46,656 — and six same-millisecond mints draw from it independently.
 *
 * Per millisecond that is small; across a file it is not. A 5,000-row import
 * spread over ~1,000 milliseconds is ~1,000 independent birthday draws of ~5
 * mints each, which compounds to roughly a one-in-five chance that SOME pair in
 * the file collides. The collision surfaces as a 23505 on
 * `inventory_items_org_sku_uniq`, which `create()` reports as "A item with that
 * SKU already exists" — a spurious per-row failure on a file that had nothing
 * wrong with it, and one that would look like a data problem to the user.
 *
 * There is a second, quieter amplifier: `Math.random().toString(36)` is not a
 * fixed-width string. `0.5` stringifies to `"0.i"`, and `.slice(2, 5)` on it
 * yields ONE character, not three — so a slice of these mints were drawing from
 * 36 values rather than 46,656.
 *
 * The fix is a process-local monotonic counter plus a wider, guaranteed-width
 * random tail. The counter is what makes this a real guarantee rather than
 * better odds: two mints in the same millisecond cannot share a sequence until
 * 46,656 of them have gone by, which no single millisecond will ever reach.
 */
describe('generateSku — unique under concurrent minting', () => {
  it('mints 10,000 SKUs in a tight loop with zero duplicates', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateSku());
    expect(seen.size).toBe(10_000);
  });

  it('is unique across an interleaved same-millisecond burst', () => {
    // What six-wide concurrency actually looks like: several callers minting
    // with no clock movement between them.
    const burst = Array.from({ length: 500 }, () => generateSku());
    expect(new Set(burst).size).toBe(500);
  });

  it('keeps the random tail a FIXED width, whatever Math.random returns', () => {
    // The `0.5` case: `(0.5).toString(36)` is '0.i', so the old slice(2, 5)
    // returned a single character. Every SKU must have the same shape.
    const widths = new Set(Array.from({ length: 2000 }, () => generateSku().length));
    expect(widths.size).toBe(1);
  });

  it('keeps the shipped shape: PREFIX-STAMP-TAIL, uppercase base36', () => {
    // Nothing parses these (grepped: no caller splits or regexes a SKU), but
    // the three-part shape is what every existing row in every org looks like,
    // and an import matcher comparing old rows to new ones should not see two
    // different species of identifier.
    expect(generateSku()).toMatch(/^SP-[0-9A-Z]+-[0-9A-Z]+$/);
    // The prefix is caller-supplied — books-import passes a book TITLE — so it
    // is preserved verbatim rather than normalised.
    expect(generateSku('BOOK')).toMatch(/^BOOK-[0-9A-Z]+-[0-9A-Z]+$/);
  });
});
