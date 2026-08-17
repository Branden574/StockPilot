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
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT "NAMES A KEY" MEANS, and why it took three shapes to say it
 * ───────────────────────────────────────────────────────────────────────────
 *
 * The scan used to be a single grep for `key` immediately before a `:` or `=`.
 * That is one of the three ways real shipped code touches these keys, and the
 * other two walked straight past it:
 *
 *   • A GUARDED READ — `cf.book_rack_number ? String(cf.book_rack_number) : null`.
 *     The native scan screen's own `readBookStorage` is four consecutive lines
 *     of exactly this, plus a hand-joined `${number}-${row}` rack label, and it
 *     sat in NEITHER list while the guard reported green. The old pattern
 *     demanded a `:` or `=` right after the key; here the next character is the
 *     `?` of a ternary, so the key was invisible.
 *
 *   • BRACKET SYNTAX — `cf['book_crate_color'] = color`. A writer spelled this
 *     way was invisible to every earlier pattern, so a new module could have
 *     landed mixed-case colours in the DURABLE book_crate_* summary — the exact
 *     failure the crate arm exists to prevent — without the guard noticing.
 *
 * A grep alone cannot separate those from PROSE: half the codebase's doc
 * comments name `locations.rack_number` in a sentence, and policing prose is
 * how a guard trains people to paste paths in without thinking. So the scan is
 * now two-stage — grep picks candidates fast, then each candidate's COMMENTS
 * are stripped and the three code shapes are matched against what is left.
 *
 * Deliberately NOT matched: a bare string literal (`'book_rack_number'` in a
 * reserved-key set or an export column id). Those name the key without touching
 * a field, and pulling them in was what made the widened scan unusable.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { destinationLabel } from '@/lib/locations/placement-destination';
import { deriveLocationName } from '@/lib/locations/rack-name';

const REPO_ROOT = path.resolve(process.cwd(), '..', '..');

const SCAN_ROOTS = ['apps/web/src', 'apps/mobile/app', 'apps/mobile/src', 'packages/core/src'];

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

/**
 * Drop comments so the scan below matches CODE, never prose.
 *
 * Line-based and deliberately timid: it only removes a line that STARTS a
 * comment (`//`, `/*`, or JSX's `{/*`) and the lines inside an open block. It
 * never touches the tail of a line that begins with code, so it cannot swallow
 * a `//` inside a URL string and hide a real key — the failure mode that
 * matters here is a false NEGATIVE, and this direction of imprecision only ever
 * produces false positives (a trailing `// see cf.book_rack_number` still
 * counts, and the file gets classified).
 */
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

/** `'`, `"` or a backtick — the three ways a bracket key can be quoted. */
const QUOTE = "['\"`]";

/**
 * The three shapes that count as a file NAMING a placement key in code.
 * `key` is a JS regex fragment, e.g. `(?:book_)?rack_(?:number|row)`.
 */
function namesKey(key: string): RegExp {
  return new RegExp(
    [
      // 1. `cf.book_rack_number` / `cf?.book_rack_number` — a member read. The
      //    ternary shape the old pattern could not see.
      String.raw`\.${key}\b`,
      // 2. `cf['book_crate_color'] = color` — bracket syntax. The leading
      //    identifier/`)`/`]` is what separates a member access from an ARRAY
      //    LITERAL of key names (`changed_keys: ['book_crate_color', …]`, or a
      //    reserved-key `new Set([...])`), which names but never touches a field.
      `[A-Za-z0-9_$)\\]][ \\t]*\\[[ \\t]*${QUOTE}${key}${QUOTE}`,
      // 3. `book_rack_number:` / `book_rack_number?:` / `book_rack_number =` —
      //    a property key, an optional-property declaration, an assignment.
      `\\b${key}\\??[ \\t]*[:=]`,
    ].join('|'),
  );
}

/**
 * Two-stage scan: `grep -rlE` for the bare key picks candidates across four
 * trees in one process, then each candidate is de-commented and matched against
 * the three code shapes. Tests and bundles excluded.
 */
function scan(bareKey: string, key: string): string[] {
  const out = execFileSync('grep', ['-rlE', String.raw`\b${bareKey}\b`, ...SCAN_ROOTS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const shape = namesKey(key);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.includes('.test.'))
    .filter((file) => shape.test(stripComments(read(file))))
    .sort();
}

describe('the scan machinery itself', () => {
  it('strips comment lines but never the tail of a line that starts with code', () => {
    const src = [
      '/**',
      ' * locations.rack_number is named here in PROSE only.',
      ' */',
      "const a = cf.book_rack_number ?? null;",
      '// const b = cf.rack_row;',
      '{/* a JSX comment naming locations.crate_color',
      '    across two lines */}',
      "const c = 1; // trailing note about cf.crate_number",
    ].join('\n');
    expect(stripComments(src).split('\n').filter(Boolean)).toEqual([
      "const a = cf.book_rack_number ?? null;",
      "const c = 1; // trailing note about cf.crate_number",
    ]);
  });

  it('sees a guarded read and a bracket write, and ignores a bare string literal', () => {
    const rack = namesKey(String.raw`(?:book_)?rack_(?:number|row)`);
    const crate = namesKey(String.raw`(?:book_)?crate_(?:color|number)`);
    // BLIND SPOT 1 — the native scan screen's readBookStorage.
    expect(rack.test("const n = f.book_rack_number ? String(f.book_rack_number) : null;")).toBe(
      true,
    );
    // BLIND SPOT 2 — a bracket-syntax writer.
    expect(crate.test("cf['book_crate_color'] = color;")).toBe(true);
    expect(crate.test('cf["book_crate_number"] = n;')).toBe(true);
    // Still caught: the original property/assignment shape.
    expect(rack.test('  book_rack_row: parts.row,')).toBe(true);
    expect(rack.test('  rack_number?: string | null;')).toBe(true);
    // NOT a field touch: key names as bare string literals.
    expect(crate.test("changed_keys: ['book_crate_color', 'book_crate_number'],")).toBe(false);
    expect(rack.test("const key = view === 'books' ? 'book_rack_number' : 'rack_number';")).toBe(
      false,
    );
  });
});

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
  // THE canonical reader: readItemRack / readBookStorage lift the pair out of
  // custom_fields and join the display label. It writes nothing durable — it is
  // the helper every other reader below should be delegating to.
  'packages/core/src/inventory/book-storage.ts',
  // The native ITEM screen. Its hand-rolled reader is GONE — it now calls
  // `readDisplayStorage` (packages/core) like the scan sheet does. It stays
  // classified because it still NAMES the pair: it maps the reader's output
  // onto its own `rack_number:` / `rack_row:` payload keys for the placement
  // formatter. Reads only; it stores nothing.
  'apps/mobile/app/item/[id].tsx',
  // THE mapper: the one place a `locations` row becomes a placement
  // destination. It copies the pair into camelCase and hands it to
  // stampPlacementBin, which normalises through the shared parser — so it
  // reads, it never stores. It is listed because the guard's whole promise is
  // that no file naming a rack key is unclassified, and this is now the file
  // future readers are pointed at.
  'apps/web/src/lib/locations/destination-option.ts',
  // The native Move stock sheet (2026-08-17). It reads the destination rows'
  // own `rack_number` / `rack_row` off the `locations` query so tapping a chip
  // can FILL a book's four destination fields (fieldsFromDestination in
  // src/lib/move-stock-form.ts). It stores nothing: the typed pair reaches the
  // row through POST /api/v1/…/transfer, whose planner and LocationsService
  // decompose through the shared parser. Reads only.
  'apps/mobile/src/components/move-stock-modal.tsx',
] as const;

/**
 * DELIBERATELY ABSENT (1) — they stopped naming a rack key when the PLACEMENT
 * PRECEDENCE was extracted.
 *
 * `apps/mobile/app/(drawer)/(tabs)/books.tsx` and
 * `apps/web/src/app/(dashboard)/dashboard/rentals/new/page.tsx` each used to
 * lift `rack_number` / `book_rack_row` off `custom_fields` by hand to label a
 * row — two more hand-rolled copies of a reader, and two more places that
 * decided on their own which of the rack pair / `bin_location` / the holdings
 * wins. Both now call `resolvePlacement` (packages/core), which reads the pair
 * through `readBookStorage` / `readItemRack`, so neither file names a key any
 * more and the scan stops seeing them.
 *
 * If either reappears here, someone re-introduced a hand-rolled read — send it
 * back to `resolvePlacement` rather than re-adding it to READ_ONLY. The
 * cross-formatter guard (apps/web/src/lib/placement-label.guard.test.ts) is the
 * arm that polices the DECISION; this one polices the KEY.
 *
 * `apps/mobile/app/(drawer)/(tabs)/scan.tsx` joined them. It carried its own
 * `readBookStorage` — four `cf.book_rack_number ? String(…) : null` reads and
 * its own `[number, row].join('-')` — which was canonical-only, so a book
 * recorded under a legacy key showed a blank rack on the scan sheet while the
 * item screen showed it. It now calls `readDisplayStorage` (packages/core) and
 * names no rack or crate key at all.
 *
 * That reader is DELIBERATELY not `readBookStorage`. The legacy spellings live
 * in a display-only reader because the canonical one feeds the acknowledgement
 * FINGERPRINTS: teaching it `rackLabel` / `rack_label` / `rack` would make the
 * server fingerprint a pair no shipped client can compute, and every live
 * device's acknowledgement would dead-end. If a future cleanup proposes
 * merging the two readers, that is the reason not to — and
 * packages/core/src/inventory/display-storage.test.ts fails if it happens.
 *
 * DELIBERATELY ABSENT (2), and the reason matters.
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
    expect(
      scan(String.raw`(book_)?rack_(number|row)`, String.raw`(?:book_)?rack_(?:number|row)`),
    ).toEqual(known);
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
  // THE canonical reader — readBookStorage lifts the crate pair out of
  // custom_fields and renders it through formatCrateLabel, which resolves the
  // colour against the CRATE_COLORS registry. Reads only.
  'packages/core/src/inventory/book-storage.ts',
  // The item edit form. It names book_crate_color / book_crate_number ONLY to
  // seed its two input states from the item's existing custom_fields; the
  // durable write is composeBookCustomFields in book-custom-fields.ts, which
  // normalises. (Its RACK twin is a genuine writer — see RACK_WRITERS.)
  'apps/web/src/components/inventory/item-form.tsx',
  // The native Move stock sheet (2026-08-17). It reads the destination rows'
  // own `crate_color` / `crate_number` off the `locations` query so tapping a
  // chip can FILL a book's four destination fields, and hands them to
  // fieldsFromDestination (src/lib/move-stock-form.ts) in camelCase. It writes
  // NOTHING durable — the crate reaches the row through POST /api/v1/…/transfer
  // and LocationsService.create, which normalises. Reads only.
  'apps/mobile/src/components/move-stock-modal.tsx',
] as const;

describe('crate-shape recurrence guard', () => {
  it('every file that assigns a crate key is classified as a writer or a reader', () => {
    const known = [...CRATE_WRITERS, ...CRATE_READ_ONLY].sort();
    expect(
      scan(String.raw`(book_)?crate_(color|number)`, String.raw`(?:book_)?crate_(?:color|number)`),
    ).toEqual(known);
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

/**
 * ...and the BEHAVIOURAL half, because the two checks above are literal-shape
 * checks and a hand-composition can dodge both.
 *
 * `[number, row].filter(Boolean).join('-')` inside `destinationLabel` matches
 * neither `#${` nor `}-${`, and the file would still contain the word
 * `deriveLocationName` (its crate branch calls it), so all three static checks
 * stay green — while the confirmation starts naming something the server will
 * not create. That is the same 2026-07-23 divergence wearing different syntax.
 *
 * So the names are PINNED TO LITERALS here, not compared against
 * `deriveLocationName` — asserting `destinationLabel(x) === deriveLocationName(x)`
 * would pass for any implementation that calls it and is a tautology dressed as
 * a guard. Every row below is an input where a hand-rolled join DISAGREES with
 * the planner, using values production actually holds.
 */
describe('destination-name recurrence guard: the label IS the planner, by value', () => {
  const NEW_RACK: Array<[{ rackNumber: string; rackRow: string }, string]> = [
    // A whole label typed into the number box. A join would render "22-B-" for
    // this input once the empty row is appended without filtering.
    [{ rackNumber: '22-B', rackRow: '' }, '22-B'],
    // DOUBLE ENTRY — "22-B" typed AND "B" picked. normalizeRackFields drops the
    // duplicated segment; a join renders "22-B-B".
    [{ rackNumber: '22-B', rackRow: 'B' }, '22-B'],
    // Padding is the operator's, not the rack's. A join keeps it: " 22 - B ".
    [{ rackNumber: ' 22 ', rackRow: ' B ' }, '22-B'],
    // A ROW WITH NO NUMBER NAMES NOTHING. planNewLocation refuses it outright;
    // a `filter(Boolean).join('-')` happily invents the rack "B" and the
    // confirmation offers to create it.
    [{ rackNumber: '', rackRow: 'B' }, ''],
    // Split is on the LAST dash: a rack legitimately called "E2E-RACK" row "1".
    [{ rackNumber: 'E2E-RACK-1', rackRow: '' }, 'E2E-RACK-1'],
    [{ rackNumber: 'A1', rackRow: 'Row 3' }, 'A1-Row 3'],
  ];

  it.each(NEW_RACK)('new rack %o is named %o', (fields, expected) => {
    expect(destinationLabel({ mode: 'new-rack', ...fields })).toBe(expected);
    // The server action mints the row from this same helper; if the two ever
    // part company the confirmation stops matching what gets created.
    expect(deriveLocationName(fields)).toBe(expected);
  });

  type CrateFields = { crateColor: string; crateNumber: string; rackNumber: string; rackRow: string };
  const crate = (over: Partial<CrateFields>): CrateFields => ({
    crateColor: '',
    crateNumber: '',
    rackNumber: '',
    rackRow: '',
    ...over,
  });
  const NEW_CRATE: Array<[CrateFields, string]> = [
    [crate({ crateColor: 'blue', crateNumber: '42' }), 'Blue #42'],
    // Production colours are already mixed case. The registry LABEL wins, so
    // the 0270 dedupe key stays one spelling; `${color} #${n}` yields "BLUE #Bin"
    // and mints a second locations row for the same crate.
    [crate({ crateColor: 'BLUE', crateNumber: 'Bin' }), 'Blue #Bin'],
    // A crate number is free text: production holds 0, 1..16, "Bin", "BIN",
    // "Blue Shelf". "0" is truthy as a STRING — a falsy check on it names ''.
    [crate({ crateNumber: '0' }), 'Crate #0'],
    [crate({ crateNumber: 'Blue Shelf' }), 'Crate #Blue Shelf'],
    // A colour with no number is not a crate identity — it used to fall back to
    // the rack number and mint "Blue #A1". A POSITION does not rescue it either:
    // where a crate sits is not what it is called.
    [crate({ crateColor: 'blue' }), ''],
    [crate({ crateColor: 'blue', rackNumber: '38', rackRow: 'B' }), ''],
    // ── THE CRATE SITS ON A RACK ──────────────────────────────────────────
    // The position is part of the NAME, which is the 0270 dedupe key: "gray
    // BIN" is FIVE physically distinct bins in production (43-B, 43-C, 42-B,
    // 42-C, 41-C), and a position-blind name collapses them into one row.
    [
      crate({ crateColor: 'gray', crateNumber: 'BIN', rackNumber: '43', rackRow: 'B' }),
      'Gray #BIN on rack 43-B',
    ],
    [
      crate({ crateColor: 'gray', crateNumber: 'BIN', rackNumber: '41', rackRow: 'C' }),
      'Gray #BIN on rack 41-C',
    ],
    // A whole rack label typed into the crate form's "On rack" box decomposes
    // exactly as it does for a rack — a hand-rolled join renders "38-B-" or
    // "38-B-B" and drifts from the columns stored (incident 2026-07-23).
    [crate({ crateNumber: '13', rackNumber: '38-B' }), 'Crate #13 on rack 38-B'],
    [crate({ crateNumber: '13', rackNumber: '38-B', rackRow: 'B' }), 'Crate #13 on rack 38-B'],
    // Padding is the operator's, not the crate's.
    [crate({ crateNumber: '13', rackNumber: ' 38 ', rackRow: ' B ' }), 'Crate #13 on rack 38-B'],
    // BACKWARD COMPATIBILITY: no position, byte-identical to the shipped name,
    // so every crate row already in production is still FOUND and REUSED.
    [crate({ crateColor: 'blue', crateNumber: 'Shelf' }), 'Blue #Shelf'],
  ];

  it.each(NEW_CRATE)('new crate %o is named %o', (fields, expected) => {
    expect(destinationLabel({ mode: 'new-crate', ...fields })).toBe(expected);
    expect(deriveLocationName(fields)).toBe(expected);
  });
});
