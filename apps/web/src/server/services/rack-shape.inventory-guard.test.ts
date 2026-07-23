/**
 * RECURRENCE GUARD — the INVENTORY of rack-key touchers is pinned.
 *
 * The 2026-07-23 incident happened because ONE writer disagreed with ONE
 * reader about the shape of a rack label, and nobody knew the full list of
 * either. This test scans apps/web, apps/mobile and packages/core for anything
 * that assigns a `rack_number` / `rack_row` / `book_rack_*` key and fails when
 * a file appears that this list has not classified.
 *
 * If it fails, do NOT just add the path: decide first whether the file WRITES a
 * rack (then it must decompose through @stockpilot/core's parser and belongs in
 * WRITERS) or merely reads/echoes one (READ_ONLY). That decision is the whole
 * point — an unclassified writer is how the next silent divergence ships.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(process.cwd(), '..', '..');

/** Writes a rack number/row somewhere durable — MUST use the shared parser. */
const WRITERS = [
  // locations.rack_number / rack_row (the ONLY insert of those columns)
  'apps/web/src/server/services/locations.ts',
  // item custom_fields: put-away stamp, bulk Set rack, duplicate, sized variants
  'apps/web/src/server/services/inventory.ts',
  // the book edit form's custom_fields composer
  'apps/web/src/components/inventory/book-custom-fields.ts',
  // the item edit form's non-book rack keys + sized-variant payload
  'apps/web/src/components/inventory/item-form.tsx',
  // mobile "new item" screen writes custom_fields directly
  'apps/mobile/app/item/new.tsx',
  // the rack's display NAME, composed from the same pair
  'apps/web/src/lib/locations/rack-name.ts',
] as const;

/**
 * Reads a rack pair, or passes one through to a writer that normalises it.
 * These do not need the parser, but they are listed so the scan below stays
 * exhaustive and a NEW file can never slip in unclassified.
 */
const READ_ONLY = [
  // hands the destination location's pair to stampPlacementBin (normalises)
  'apps/web/src/app/api/v1/items/[id]/transfer/route.ts',
  'apps/web/src/server/actions/inventory.ts',
  // display / export only — both compose the label, never store a pair
  'apps/web/src/server/loaders/orders-new-catalog.ts',
  'apps/web/src/lib/inventory-export.ts',
  'apps/mobile/app/(drawer)/(tabs)/books.tsx',
] as const;

function scanRackKeyFiles(): string[] {
  // -l: names only. Sources only; tests and built bundles are not writers.
  const out = execFileSync(
    'grep',
    [
      '-rlE',
      String.raw`\b(book_)?rack_(number|row)[[:space:]]*[:=]`,
      'apps/web/src',
      'apps/mobile/app',
      'apps/mobile/src',
      'packages/core/src',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.includes('.test.'))
    .sort();
}

describe('rack-shape recurrence guard', () => {
  it('every file that assigns a rack key is classified as a writer or a reader', () => {
    // rack-name.ts is a WRITER of the display label but only ever touches the
    // camelCase form (rackNumber/rackRow), so the snake_case scan never sees it.
    const known = [...WRITERS, ...READ_ONLY]
      .filter((f) => f !== 'apps/web/src/lib/locations/rack-name.ts')
      .sort();
    expect(scanRackKeyFiles()).toEqual(known);
  });

  it('every WRITER decomposes through the shared @stockpilot/core parser', () => {
    for (const file of WRITERS) {
      const src = readFileSync(path.join(REPO_ROOT, file), 'utf8');
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
