/**
 * Minimal CSV parser and serializer. Handles quoted fields, escaped quotes,
 * and commas inside fields. No external dependency.
 */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let current: string[] = [];
  let cell = '';
  let inQuotes = false;

  const pushCell = () => {
    current.push(cell);
    cell = '';
  };
  const pushRow = () => {
    if (current.length === 1 && current[0] === '') {
      // skip blank lines
    } else {
      rows.push(current);
    }
    current = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') pushCell();
      else if (c === '\r') {
        // ignore — handled by \n
      } else if (c === '\n') {
        pushCell();
        pushRow();
      } else {
        cell += c;
      }
    }
  }
  if (cell.length > 0 || current.length > 0) {
    pushCell();
    pushRow();
  }

  if (rows.length === 0) return { header: [], rows: [] };
  const [headerRow, ...dataRows] = rows;
  return { header: (headerRow ?? []).map((h) => h.trim()), rows: dataRows };
}

export function rowsToObjects<T extends Record<string, string>>(
  header: string[],
  rows: string[][],
): T[] {
  return rows.map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((key, idx) => {
      obj[key] = (r[idx] ?? '').trim();
    });
    return obj as T;
  });
}

/** Build a date-stamped CSV filename, e.g. "inventory-valuation-2026-05-05.csv". */
export function csvFilename(slug: string, suffix?: string): string {
  const safe = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const stamp = new Date().toISOString().slice(0, 10);
  const tail = suffix ? `-${suffix}` : '';
  return `${safe}-${stamp}${tail}.csv`;
}

/**
 * Spreadsheet-formula-injection guard. Cells starting with =, +, -, @,
 * tab, or carriage return are interpreted as formulas by Excel /
 * LibreOffice / Google Sheets; prefixing with a single quote makes
 * the spreadsheet treat them as plain text. Applied automatically by
 * toCsv() to every string cell so callers don't need to remember.
 *
 * The tab/carriage-return additions cover OWASP CSV-injection
 * variants where a leading whitespace + formula char still triggers
 * formula evaluation in some spreadsheet versions.
 */
export function escapeForSpreadsheet(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  if (s.length === 0) return s;
  const first = s[0]!;
  if (
    first === '=' ||
    first === '+' ||
    first === '-' ||
    first === '@' ||
    first === '\t' ||
    first === '\r'
  ) {
    return `'${s}`;
  }
  return s;
}

/**
 * One CSV cell: formula-injection guard first, then RFC 4180 quoting when
 * the value holds a quote, a comma, a line feed or a carriage return. A bare
 * \r must quote too: without it a value containing one ends the row in
 * readers that accept CR line endings, and the rest of the value becomes a
 * new row.
 */
export function csvCell(v: unknown): string {
  // Step 1: defuse spreadsheet-formula injection. Numbers passed as
  // numbers (not strings) are unaffected; only string-shaped cells
  // ever start with =/+/-/@/\t/\r.
  const safe = escapeForSpreadsheet(v);
  if (safe.length === 0) return '';
  // Step 2: standard CSV quoting for commas/quotes/newlines.
  if (safe.includes('"') || safe.includes(',') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/** One data row, in `header` order, every cell through csvCell. */
export function csvRow(
  header: readonly string[],
  row: Record<string, string | number | null | undefined>,
): string {
  return header.map((h) => csvCell(row[h])).join(',');
}

export function toCsv(
  header: string[],
  rows: Array<Record<string, string | number | null | undefined>>,
): string {
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(csvRow(header, row));
  }
  return lines.join('\n');
}

/** Longest value a metadata line carries before it is cut with an ellipsis. */
export const CSV_META_VALUE_MAX = 200;
/** Longest label (the caller's own sentence) a metadata line carries. */
export const CSV_META_LINE_MAX = 1000;

/**
 * Text that is safe inside ONE metadata line: every C0 control (U+0000 to
 * U+001F, which includes tab, CR and LF), DEL and the Unicode line and
 * paragraph separators become a space; runs of spaces collapse; the result
 * is trimmed and cut at CSV_META_VALUE_MAX characters with an ellipsis. A
 * name or search typed by a person can then never end the line and start a
 * new row.
 */
export function sanitizeCsvText(value: unknown, max: number = CSV_META_VALUE_MAX): string {
  if (value === null || value === undefined) return '';
  const flat = String(value)
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One metadata line above a CSV table: `# <label>: <value>`, the value
 * sanitized (sanitizeCsvText), the whole line passed through the
 * formula-injection guard (a no-op, since it starts with '#', kept as a
 * guard) and ALWAYS emitted as a single RFC 4180 quoted cell, so a comma or
 * quote in a warehouse name, a category or a search can never split the line
 * into further cells. `value` omitted: the line is `# <label>`.
 */
export function csvMetaLine(label: string, value?: unknown): string {
  // The label is the caller's own wording (a sentence may run past the value
  // cap); it is still flattened to one line. The value is capped.
  const head = sanitizeCsvText(label, CSV_META_LINE_MAX);
  const text = value === undefined ? `# ${head}` : `# ${head}: ${sanitizeCsvText(value)}`;
  const guarded = escapeForSpreadsheet(text);
  return `"${guarded.replace(/"/g, '""')}"`;
}
