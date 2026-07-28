/**
 * The generic items-CSV import: header mapping + per-row review.
 *
 * Pure and platform-free on purpose. The web screen renders these values, the
 * server action re-derives them before it writes anything, and the two can
 * never drift into different ideas about which column means what or which row
 * is allowed through. (Same posture as `sports/import-results.ts`, whose
 * vocabulary this module REUSES rather than re-declaring — a review row here
 * says `ready` / `add_new_variant` / `missing_required_attribute` in exactly
 * the words the PO-import review table already uses.)
 *
 * WHY IT EXISTS — live verification in Demo Co (2026-07-28) found the screen
 * printing the file's own first eight headers as its review table, echoing an
 * extra column headed `Number` once and then silently dropping it, with Import
 * enabled from the moment the file parsed. Requirements: "Never silently
 * guess: show candidate mappings + confidence, require confirmation, preserve
 * source values, block import until required mappings resolved", and a review
 * row must state WHAT will happen, "Not just Valid/Invalid".
 */

import {
  AMBIGUOUS_COLUMN_MEANINGS,
  type AmbiguousColumnMeaning,
  type LineResult,
} from '../sports/import-results';
import { isValidJerseyNumber, variantLabel } from '../sports/variant-keys';

/**
 * The template's non-sports columns, in order.
 *
 * This list is the mapping vocabulary AND the downloaded template's header, so
 * the app can never offer a column its own importer does not recognise.
 */
export const ITEM_CSV_BASE_COLUMNS = [
  'name',
  'sku',
  'barcode',
  'description',
  'unit_cost',
  'retail_price',
  'quantity_on_hand',
  'reorder_point',
  'reorder_quantity',
  'unit_of_measure',
  'category_name',
  'subcategory_name',
  'warehouse_name',
  'location_name',
  'supplier_name',
] as const;

/** The sports block. Module-gated: an org without the module is never offered
 *  these columns, and never has a header mapped onto one. */
export const ITEM_CSV_SPORTS_COLUMNS = [
  'brand',
  'model',
  'style_number',
  'colorway',
  'team',
  'season',
  'home_away',
  'jersey_number',
  'player_name',
  'size',
  'size_system',
  'width',
  'fit',
  'color',
  'counting_unit',
  'tracking_mode',
  'serial',
  'asset_tag',
] as const;

export type ItemCsvColumn =
  | (typeof ITEM_CSV_BASE_COLUMNS)[number]
  | (typeof ITEM_CSV_SPORTS_COLUMNS)[number];

/**
 * Template column order. The sports block is spliced in FRONT of the location
 * lookups so a sports org's downloaded template is byte-identical to the one
 * that shipped, and `supplier_name` stays out of the download (it is accepted
 * on upload but the screen has never offered it).
 */
export function itemCsvTemplateHeader(sportsEnabled: boolean): string[] {
  const base = ITEM_CSV_BASE_COLUMNS.filter((c) => c !== 'supplier_name');
  const tail: string[] = ['warehouse_name', 'location_name'];
  const head = base.filter((c) => !tail.includes(c));
  return sportsEnabled ? [...head, ...ITEM_CSV_SPORTS_COLUMNS, ...tail] : [...head, ...tail];
}

/**
 * Header normalization for MATCHING only — never for display. A review row
 * always shows the header exactly as the file printed it, because that is what
 * the user has to go and edit.
 */
function normHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[_\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
    .trim();
}

/**
 * Spreadsheet-shaped headers that resolve to a template column WITHOUT a human
 * being asked. Every entry here is unambiguous in isolation: "UPC" is a
 * barcode and nothing else. Anything that could plausibly be two things
 * belongs in `AMBIGUOUS_HEADERS` below instead, not here.
 */
const ALIASES: Record<string, ItemCsvColumn> = {
  'item name': 'name',
  'product name': 'name',
  'item description': 'description',
  'item code': 'sku',
  'product code': 'sku',
  'stock code': 'sku',
  upc: 'barcode',
  ean: 'barcode',
  gtin: 'barcode',
  isbn: 'barcode',
  qty: 'quantity_on_hand',
  quantity: 'quantity_on_hand',
  'qty on hand': 'quantity_on_hand',
  'on hand': 'quantity_on_hand',
  'stock on hand': 'quantity_on_hand',
  cost: 'unit_cost',
  'unit price': 'unit_cost',
  retail: 'retail_price',
  msrp: 'retail_price',
  'sell price': 'retail_price',
  'reorder level': 'reorder_point',
  'min qty': 'reorder_point',
  uom: 'unit_of_measure',
  category: 'category_name',
  subcategory: 'subcategory_name',
  'sub category': 'subcategory_name',
  supplier: 'supplier_name',
  vendor: 'supplier_name',
  warehouse: 'warehouse_name',
  location: 'location_name',
  bin: 'location_name',
  'bin location': 'location_name',
};

/** Sports-only aliases. Resolved only when the module is on, so a non-sports
 *  org never has a column mapped onto a field it has no screen for. */
const SPORTS_ALIASES: Record<string, ItemCsvColumn> = {
  'jersey #': 'jersey_number',
  'jersey no': 'jersey_number',
  'jersey number': 'jersey_number',
  'uniform #': 'jersey_number',
  'uniform no': 'jersey_number',
  'uniform number': 'jersey_number',
  'player #': 'jersey_number',
  'player number': 'jersey_number',
  player: 'player_name',
  athlete: 'player_name',
  colour: 'color',
  colourway: 'colorway',
  'style #': 'style_number',
  'style no': 'style_number',
  'style code': 'style_number',
  'serial #': 'serial',
  'serial no': 'serial',
  'serial number': 'serial',
  'asset #': 'asset_tag',
  'asset number': 'asset_tag',
  'team name': 'team',
  'home away': 'home_away',
  tracking: 'tracking_mode',
};

/**
 * Headers whose meaning cannot be decided without asking.
 *
 * A bare "Number" is the canonical case the requirements call out by name — it
 * could be a jersey number, a quantity, a serial or a style number. The
 * candidate set is drawn from Task 14's `AMBIGUOUS_COLUMN_MEANINGS`, filtered:
 * `line_number` is a PO-document concept with no meaning on an items CSV, and
 * `confirm` answers a whole flagged LINE rather than a column.
 */
const AMBIGUOUS_HEADERS: Record<string, readonly AmbiguousColumnMeaning[]> = {
  number: ['jersey_number', 'quantity', 'serial', 'style_number'],
  no: ['jersey_number', 'quantity', 'serial', 'style_number'],
  num: ['jersey_number', 'quantity', 'serial', 'style_number'],
  '#': ['jersey_number', 'quantity', 'serial', 'style_number'],
};

/** The template column an answered meaning routes its values into. `null`
 *  means "apply nowhere" — the opt-out, and the two PO-only answers. */
export function meaningToItemCsvColumn(m: AmbiguousColumnMeaning): ItemCsvColumn | null {
  switch (m) {
    case 'jersey_number':
      return 'jersey_number';
    case 'quantity':
      return 'quantity_on_hand';
    case 'serial':
      return 'serial';
    case 'style_number':
      return 'style_number';
    default:
      return null;
  }
}

export interface CsvHeaderMapping {
  /** Exactly as the file printed it. This is what the user has to go and edit. */
  header: string;
  /**
   * `mapped`     — resolved to a template column, nothing to ask.
   * `ambiguous`  — needs a human answer; blocks the import until it has one.
   * `duplicate`  — a second header resolving to a column already claimed.
   * `unmapped`   — recognised as nothing; its values are not imported.
   */
  status: 'mapped' | 'ambiguous' | 'duplicate' | 'unmapped';
  field: ItemCsvColumn | null;
  candidates: AmbiguousColumnMeaning[];
}

/**
 * Resolve every detected header against the template vocabulary.
 *
 * Order is preserved and every header comes back, including the ones that mean
 * nothing — the review header strip names them so a user can see that a column
 * they filled in is NOT being imported, rather than discovering it afterwards.
 */
export function resolveItemCsvHeaders(
  headers: readonly string[],
  opts: { sportsEnabled: boolean },
): CsvHeaderMapping[] {
  const allowed = new Set<string>([
    ...ITEM_CSV_BASE_COLUMNS,
    ...(opts.sportsEnabled ? ITEM_CSV_SPORTS_COLUMNS : []),
  ]);
  const aliases: Record<string, ItemCsvColumn> = opts.sportsEnabled
    ? { ...ALIASES, ...SPORTS_ALIASES }
    : ALIASES;

  // A column is claimed by the FIRST header that resolves to it. The canonical
  // spelling wins over an alias even when the alias came first, because the
  // template column is the one the user was told to fill in.
  const claimed = new Set<string>();
  for (const h of headers) {
    const n = normHeader(h);
    if (allowed.has(n.replace(/ /g, '_'))) claimed.add(n.replace(/ /g, '_'));
  }

  const out: CsvHeaderMapping[] = [];
  const taken = new Set<string>();
  for (const header of headers) {
    const n = normHeader(header);
    const canonical = n.replace(/ /g, '_');

    if (allowed.has(canonical)) {
      if (taken.has(canonical)) {
        out.push({ header, status: 'duplicate', field: null, candidates: [] });
      } else {
        taken.add(canonical);
        out.push({ header, status: 'mapped', field: canonical as ItemCsvColumn, candidates: [] });
      }
      continue;
    }

    const ambiguous = AMBIGUOUS_HEADERS[n];
    if (ambiguous) {
      const candidates = ambiguous.filter(
        (m) => opts.sportsEnabled || m !== 'jersey_number',
      );
      out.push({ header, status: 'ambiguous', field: null, candidates: [...candidates, 'ignore'] });
      continue;
    }

    const aliased = aliases[n];
    if (aliased) {
      // Claimed by the canonical header elsewhere in the file, or by an earlier
      // alias: report it rather than mapping the same column twice.
      if (claimed.has(aliased) || taken.has(aliased)) {
        out.push({ header, status: 'duplicate', field: null, candidates: [] });
      } else {
        taken.add(aliased);
        out.push({ header, status: 'mapped', field: aliased, candidates: [] });
      }
      continue;
    }

    out.push({ header, status: 'unmapped', field: null, candidates: [] });
  }
  return out;
}

/** The headers a human still has to answer. */
export function itemCsvAmbiguousHeaders(mappings: readonly CsvHeaderMapping[]): CsvHeaderMapping[] {
  return mappings.filter((m) => m.status === 'ambiguous');
}

/**
 * THE "may this import proceed" predicate for column mapping.
 *
 * One definition, shared by the review screen (which disables Import) and the
 * server action (which refuses the write), so the screen can never offer a
 * button the server will reject — nor hide a block the user could have fixed.
 *
 * An answer that is not one of THAT header's candidates does not resolve it:
 * a client sending `line_number` for a column that was never offered it is
 * treated as no answer at all rather than as an ignore.
 */
export function itemCsvHeaderDecisionsOutstanding(
  mappings: readonly CsvHeaderMapping[],
  decisions: Readonly<Record<string, AmbiguousColumnMeaning>>,
): string[] {
  return itemCsvAmbiguousHeaders(mappings)
    .filter((m) => {
      const answer = decisions[m.header];
      return answer == null || !m.candidates.includes(answer);
    })
    .map((m) => m.header);
}

/**
 * Rewrite one raw CSV row into template columns.
 *
 * Two rules, both of them "preserve source values":
 *  - the source header keeps its own value in the returned object, so nothing
 *    the file said is destroyed on the way to review;
 *  - an alias or a confirmed meaning only FILLS a template column that is
 *    empty. A file carrying both `quantity_on_hand` and `Qty` keeps the
 *    canonical one — an alias never overwrites a value the user typed under
 *    the name the template asked for.
 *
 * An unanswered ambiguous header applies nowhere. That is the whole point:
 * until a human says what `Number` is, its values reach no field.
 */
export function applyItemCsvHeaderDecisions(
  row: Readonly<Record<string, string>>,
  mappings: readonly CsvHeaderMapping[],
  decisions: Readonly<Record<string, AmbiguousColumnMeaning>>,
): Record<string, string> {
  const out: Record<string, string> = { ...row };
  const fill = (column: string, value: string) => {
    if (value.trim() === '') return;
    const existing = out[column];
    if (typeof existing === 'string' && existing.trim() !== '') return;
    out[column] = value;
  };

  for (const m of mappings) {
    const value = row[m.header];
    if (typeof value !== 'string') continue;

    if (m.status === 'mapped' && m.field && m.field !== m.header) {
      fill(m.field, value);
      continue;
    }
    if (m.status === 'ambiguous') {
      const answer = decisions[m.header];
      if (answer == null || !m.candidates.includes(answer)) continue;
      const column = meaningToItemCsvColumn(answer);
      if (column) fill(column, value);
    }
  }
  return out;
}

export interface ItemCsvReviewRow {
  /** The spreadsheet line number: the header is line 1, so data starts at 2. */
  sourceRow: number;
  name: string;
  /** Sports orgs only — the product group this row would land under. */
  group: string | null;
  /** Sports orgs only — the variant within that group. */
  variant: string | null;
  quantity: string;
  result: LineResult;
  message: string | null;
}

/** The group identity a sports row offers, in the order the item form uses. */
function groupLabel(row: Record<string, string>): string | null {
  const pick = (k: string) => row[k]?.trim() || '';
  const brandModel = [pick('brand'), pick('model')].filter(Boolean).join(' ');
  if (brandModel) return brandModel;
  const teamSeason = [pick('team'), pick('season')].filter(Boolean).join(' ');
  if (teamSeason) return teamSeason;
  return pick('style_number') || null;
}

/**
 * Per-row review, before anything is written.
 *
 * Deliberately conservative: it reports only what a CSV can be certain of
 * without touching the database. It never claims `receive_into_existing_variant`
 * or `create_new_group`, because deciding that needs the org's existing groups
 * — and a review row that guesses is exactly the failure this replaces.
 */
export function reviewItemCsvRows(
  rows: ReadonlyArray<Readonly<Record<string, string>>>,
  mappings: readonly CsvHeaderMapping[],
  opts: {
    sportsEnabled: boolean;
    headerDecisions?: Readonly<Record<string, AmbiguousColumnMeaning>>;
  },
): ItemCsvReviewRow[] {
  const decisions = opts.headerDecisions ?? {};
  // File-level: while a column's meaning is unknown, no row can be judged —
  // the same values might be quantities or jersey numbers.
  const blockedByMapping = itemCsvHeaderDecisionsOutstanding(mappings, decisions).length > 0;

  const applied = rows.map((r) => applyItemCsvHeaderDecisions(r, mappings, decisions));

  // SKUs repeated inside one file: both rows are flagged, not just the second.
  const skuCounts = new Map<string, number>();
  for (const r of applied) {
    const sku = (r.sku ?? '').trim().toLowerCase();
    if (sku) skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1);
  }

  return applied.map((r, i) => {
    const name = (r.name ?? '').trim();
    const sku = (r.sku ?? '').trim().toLowerCase();
    const jersey = (r.jersey_number ?? '').trim();
    const group = opts.sportsEnabled ? groupLabel(r) : null;
    const variant = opts.sportsEnabled
      ? variantLabel({
          jerseyNumber: jersey || null,
          size: r.size ?? null,
          width: r.width ?? null,
          color: r.color ?? null,
        })
      : null;

    const base = {
      sourceRow: i + 2,
      name,
      group,
      variant,
      quantity: (r.quantity_on_hand ?? '').trim(),
    };

    if (blockedByMapping) {
      return {
        ...base,
        result: 'mapping_review_required' as LineResult,
        message: 'Confirm what the highlighted column means before importing.',
      };
    }
    if (!name) {
      return {
        ...base,
        result: 'missing_required_attribute' as LineResult,
        message: 'This row has no name. Every item needs one.',
      };
    }
    if (opts.sportsEnabled && jersey && !isValidJerseyNumber(jersey)) {
      return {
        ...base,
        result: 'missing_required_attribute' as LineResult,
        message: `"${jersey}" is not a jersey number (digits only; leading zeroes are kept).`,
      };
    }
    if (sku && (skuCounts.get(sku) ?? 0) > 1) {
      return {
        ...base,
        result: 'possible_duplicate' as LineResult,
        message: `More than one row in this file uses SKU "${(r.sku ?? '').trim()}".`,
      };
    }
    if (variant) {
      return {
        ...base,
        result: 'add_new_variant' as LineResult,
        message: null,
      };
    }
    return { ...base, result: 'ready' as LineResult, message: null };
  });
}

/** Re-exported so a caller never has to reach past this module for the answer
 *  vocabulary it is meant to render. */
export { AMBIGUOUS_COLUMN_MEANINGS };
