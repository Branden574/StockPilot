import { toCsv } from '@/lib/csv';

import { fieldHeading, type InventoryExportField } from './field-registry';
import type { InventoryExportSourceRow } from './source-row';

/**
 * Field-driven CSV (Brief section 15).
 *
 * Quoting and formula-injection escaping are NOT reimplemented here: toCsv in
 * lib/csv.ts already applies escapeForSpreadsheet then RFC-4180 quoting, and
 * that is the one place those rules live. This module only decides WHICH
 * columns exist, in what order, and under what heading.
 *
 * No UTF-8 BOM. The brief allows one only after verifying current consumers,
 * and every CSV this product has ever emitted is BOM-less — adding one would
 * change what every existing importer reads.
 */
export interface InventoryCsvInput {
  fields: readonly InventoryExportField[];
  rows: readonly InventoryExportSourceRow[];
  itemTypeKind: 'book' | 'other';
  /** e.g. '# truncated at 10000 rows of 41230'. Appended as a final line. */
  truncatedNote?: string;
}

export function toInventoryCsv(input: InventoryCsvInput): string {
  const headings = input.fields.map((field) =>
    fieldHeading(field, { format: 'csv', itemType: input.itemTypeKind }),
  );

  const rows = input.rows.map((row) => {
    const record: Record<string, string | number> = {};
    input.fields.forEach((field, index) => {
      const value = field.value(row);
      // '' rather than null/undefined: toCsv would render either as an empty
      // cell anyway, but keeping the type narrow means no path can ever emit
      // the literal text "undefined".
      record[headings[index]!] = value === null || value === undefined ? '' : value;
    });
    return record;
  });

  const body = toCsv(headings, rows);
  return input.truncatedNote ? `${body}\n${input.truncatedNote}` : body;
}
