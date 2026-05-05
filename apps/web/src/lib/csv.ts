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

export function toCsv(header: string[], rows: Array<Record<string, string | number | null | undefined>>): string {
  const escape = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}
