/**
 * RECURRENCE GUARD — the INVENTORY of placement-metadata touchers is pinned.
 *
 * The 2026-07-23 incident happened because ONE writer disagreed with ONE
 * reader about the shape of a rack label, and nobody knew the full list of
 * either. This file scans apps/web, apps/mobile and packages/core for anything
 * that assigns a durable placement key and fails when a file appears that the
 * lists below have not classified.
 *
 * THREE INVENTORIES, because there are three ways to get this wrong:
 *
 *   1. RACK KEYS   — `rack_number` / `rack_row` / `book_rack_*`. A writer must
 *                    decompose through the shared parser.
 *   2. CRATE KEYS  — `crate_color` / `crate_number` / `book_crate_*`. A writer
 *                    must normalise the colour through the shared write-side
 *                    helper. This arm did not exist, so a module writing the
 *                    DURABLE book_crate_* summary without touching a rack key
 *                    was completely unpoliced — and the mobile item screen
 *                    already names both keys while appearing in neither list.
 *   3. NAME        — the `locations.name` a "+ New rack/crate" mints. That
 *                    string is migration 0270's DEDUPE KEY and the string every
 *                    confirmation shows, so a file that composes one by hand is
 *                    exactly how the phone came to confirm "Create new rack A1?"
 *                    and create "Crate #9".
 *
 * If a scan fails, do NOT just add the path: decide first whether the file
 * WRITES the key (then it must go through the shared helper and belongs in
 * WRITERS) or merely reads/echoes one (READ_ONLY). That decision is the whole
 * point — an unclassified writer is how the next silent divergence ships.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(process.cwd(), '..', '..');

const SCAN_ROOTS = ['apps/web/src', 'apps/mobile/app', 'apps/mobile/src', 'packages/core/src'];

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

/** `grep -rlE` over the source trees, tests and bundles excluded. */
function scan(pattern: string): string[] {
  const out = execFileSync('grep', ['-rlE', pattern, ...SCAN_ROOTS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.includes('.test.'))
    .sort();
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. RACK KEYS
// ═══════════════════════════════════════════════════════════════════════════

/** Writes a rack number/row somewhere durable — MUST use the shared parser. */
const RACK_WRITERS = [
  // locations.rack_number / rack_row (the ONLY insert of those columns)
  'apps/web/src/server/services/locations.ts',
  // item custom_fields: put-away stamp, bulk Set rack, duplicate, sized variants
  'apps/web/src/server/services/inventory.ts',
  // the book edit form's custom_fields composer
  'apps/web/src/components/inventory/book-custom-fields.ts',
  // the item edit form's non-book rack keys + sized-variant payload
  'apps/web/src/components/inventory/item-form.tsx',
  // the native create seam. The rack derivation moved OUT of
  // apps/mobile/app/item/new.tsx here (Task 10): the screen now only collects
  // strings, and this module decomposes them and composes bin_location before
  // the payload reaches POST /api/v1/items.
  'apps/mobile/src/lib/item-create.ts',
] as const;

/**
 * Reads a rack pair, or passes one through to a writer that normalises it.
 * These do not need the parser, but they are listed so the scan below stays
 * exhaustive and a NEW file can never slip in unclassified.
 */
const RACK_READ_ONLY = [
  // display / export only — both compose the label, never store a pair
  'apps/web/src/server/loaders/orders-new-catalog.ts',
  'apps/web/src/lib/inventory-export.ts',
  'apps/mobile/app/(drawer)/(tabs)/books.tsx',
  // THE mapper: the one place a `locations` row becomes a placement
  // destination. It copies the pair into camelCase and hands it to
  // stampPlacementBin, which normalises through the shared parser — so it
  // reads, it never stores. It is listed because the guard's whole promise is
  // that no file naming a rack key is unclassified, and this is now the file
  // future readers are pointed at.
  'apps/web/src/lib/locations/destination-option.ts',
] as const;

/**
 * DELIBERATELY ABSENT, and the reason matters.
 *
 * `apps/web/src/server/actions/inventory.ts` and
 * `apps/web/src/app/api/v1/items/[id]/transfer/route.ts` used to appear in
 * READ_ONLY: each hand-copied the destination's `rack_number` / `rack_row` off
 * a locations row into a PlaceDest, four times over, and each copy
 * independently decided which columns to carry — which is how the crate pair
 * ended up missing from all four.
 *
 * They now call the ONE mapper, `toPlaceDest` in
 * `apps/web/src/lib/locations/destination-option.ts`, so they no longer name a
 * rack key at all and the scan below stops seeing them. That mapper is the
 * only place a locations row becomes a placement destination; it reads the
 * snake_case columns and emits camelCase, then hands the pair to
 * `stampPlacementBin`, which normalises through the shared parser.
 *
 * If either file reappears in the scan, someone re-introduced a hand-rolled
 * copy — send it back to `toPlaceDest` rather than re-adding it here.
 *
 * The mapper ITSELF used to escape the scan too, by accident rather than by
 * design: it declares `rack_number?: string | null` and reads
 * `loc.rack_number as string | null`, and the pattern demanded the key sit
 * immediately before a `:` or `=`. So the guard's promise — "a new file can
 * never slip in unclassified" — did not hold for the very module this comment
 * points at. The pattern now tolerates an optional-property `?`, which brings
 * exactly that one file in (it is classified READ_ONLY above).
 */

describe('rack-shape recurrence guard', () => {
  it('every file that assigns a rack key is classified as a writer or a reader', () => {
    const known = [...RACK_WRITERS, ...RACK_READ_ONLY].sort();
    // `\??` so an OPTIONAL property declaration ("rack_number?: string") counts
    // as naming the key — without it the canonical mapper was invisible to its
    // own guard.
    expect(scan(String.raw`\b(book_)?rack_(number|row)\??[[:space:]]*[:=]`)).toEqual(known);
  });

  it('every rack WRITER decomposes through the shared @stockpilot/core parser', () => {
    for (const file of RACK_WRITERS) {
      const src = read(file);
      expect(
        /normalizeRackFields|parseRackLabel/.test(src),
        `${file} writes a rack key but never calls the shared parser — a user typing "22-B" into the number field would be stored composite and go invisible to its own rack filter (incident 2026-07-23).`,
      ).toBe(true);
      expect(src, `${file} must import the parser from @stockpilot/core`).toContain(
        '@stockpilot/core',
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CRATE KEYS — the arm that did not exist
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Writes a crate colour/number somewhere durable — `locations.crate_color` /
 * `crate_number`, or the item-level `book_crate_*` SUMMARY.
 *
 * MUST normalise the colour through `normalizeCrateColorForWrite`. A colour is
 * compared and rendered through the CRATE_COLORS registry, so a row that stores
 * "Blue" while every other writer stores "blue" reads as an unknown colour and
 * gets DROPPED from the label — which is how a confirmation came to say
 * "recorded in 42 … will change to 42" and invite the user to erase a colour.
 */
const CRATE_WRITERS = [
  // The ONLY insert of locations.crate_color / crate_number.
  'apps/web/src/server/services/locations.ts',
  // The item-level summary: the placement reconciliation (inventory_set_book_
  // storage) and the duplicate-item override path.
  'apps/web/src/server/services/inventory.ts',
  // The book edit form's custom_fields composer — the human-typed twin.
  'apps/web/src/components/inventory/book-custom-fields.ts',
] as const;

/**
 * Names a crate key but only READS it — a display, an export, or the one mapper
 * that turns a `locations` row into a placement destination.
 */
const CRATE_READ_ONLY = [
  // The native item screen. It reads book_crate_color / book_crate_number (and
  // the bare legacy spellings) out of custom_fields and parks them on local
  // component state under snake_case names. It writes NOTHING — but it names
  // both keys, and until this arm existed it sat in no list at all while the
  // guard reported green.
  'apps/mobile/app/item/[id].tsx',
  // CSV / Export Builder columns.
  'apps/web/src/lib/inventory-export.ts',
  // THE mapper — see the rack section's note.
  'apps/web/src/lib/locations/destination-option.ts',
] as const;

describe('crate-shape recurrence guard', () => {
  it('every file that assigns a crate key is classified as a writer or a reader', () => {
    const known = [...CRATE_WRITERS, ...CRATE_READ_ONLY].sort();
    expect(scan(String.raw`\b(book_)?crate_(color|number)\??[[:space:]]*[:=]`)).toEqual(known);
  });

  it('every crate WRITER normalises the colour through the shared helper', () => {
    for (const file of CRATE_WRITERS) {
      const src = read(file);
      expect(
        src.includes('normalizeCrateColorForWrite'),
        `${file} writes a crate colour but never calls normalizeCrateColorForWrite — a row stored as "Blue" compares and renders as an UNKNOWN colour everywhere else, and the label silently drops it.`,
      ).toBe(true);
      expect(src, `${file} must import the helper from @stockpilot/core`).toContain(
        '@stockpilot/core',
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE DESTINATION NAME
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Composes the display/`locations.name` of an inline-created rack or crate.
 *
 * Every one of these MUST delegate to the core planner
 * (packages/core/src/inventory/new-location.ts). Hand-composing is not a style
 * question:
 *
 *   • `${number}-${row}` is the 2026-07-23 shape — the name and the stored
 *     columns drift and items go invisible to their own rack filter;
 *   • `${color} #${n}` is migration 0270's DEDUPE KEY — a second spelling mints
 *     duplicate `locations` rows;
 *   • and a composer that disagrees with the server about which fields win is
 *     how the phone confirmed "Create new rack A1?" and created "Crate #9".
 *
 * This list exists because these files name NO snake_case key, so neither scan
 * above could ever see them. `placement-destination.ts` in particular shipped
 * with no test file at all.
 */
const NAME_COMPOSERS = [
  'apps/web/src/lib/locations/rack-name.ts',
  'apps/web/src/lib/locations/placement-destination.ts',
  'apps/mobile/src/lib/move-stock-form.ts',
] as const;

describe('destination-name recurrence guard', () => {
  it('every name composer delegates to the ONE core planner', () => {
    for (const file of NAME_COMPOSERS) {
      const src = read(file);
      expect(
        /deriveNewLocationName|planNewLocation|deriveLocationName/.test(src),
        `${file} builds a destination name but never delegates to the core planner.`,
      ).toBe(true);
      expect(src, `${file} must import from @stockpilot/core (directly or via rack-name)`).toMatch(
        /@stockpilot\/core|\.\/rack-name/,
      );
    }
  });

  it('no name composer hand-builds either canonical shape', () => {
    for (const file of NAME_COMPOSERS) {
      const src = read(file);
      expect(
        src,
        `${file} composes a crate name by hand ("#\${…}") — that string is migration 0270's dedupe key and must come from formatCrateLocationName via planNewLocation.`,
      ).not.toMatch(/#\$\{/);
      expect(
        src,
        `${file} composes a rack label by hand ("}-\${…}") — use formatRackLabel via planNewLocation (incident 2026-07-23).`,
      ).not.toMatch(/\}-\$\{/);
    }
  });
});
