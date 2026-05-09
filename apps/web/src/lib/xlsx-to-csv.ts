import 'server-only';

/**
 * Convert an uploaded `.xlsx` workbook buffer into a CSV-shaped string.
 *
 * History: this used to wrap the `xlsx` package (SheetJS CE). That
 * package is unmaintained on npm and ships two CVEs:
 *   • CVE-2023-30533 — prototype pollution on parse (HIGH)
 *   • CVE-2024-22363 — ReDoS (HIGH)
 * Both fire when reading a malicious workbook. Since uploads come from
 * authenticated users (bulk-import + AI ISBN extract), an org-mate
 * could craft a payload to corrupt server-side prototypes.
 *
 * Replaced with `exceljs`, which is npm-maintained and free of those
 * advisories. Output shape (CSV-ish concat of every sheet's rows)
 * stays the same so callers don't change.
 */
export async function xlsxBufferToCsv(buffer: Buffer): Promise<string> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  // exceljs's .load() typings expect a particular Buffer flavor that
  // doesn't match Node's modern Buffer<ArrayBufferLike>. Pass the
  // raw ArrayBuffer slice instead — runtime accepts it identically.
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  await wb.xlsx.load(ab as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const lines: string[] = [];
  wb.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v == null) {
          cells.push('');
        } else if (typeof v === 'string') {
          cells.push(escapeCell(v));
        } else if (typeof v === 'number' || typeof v === 'boolean') {
          cells.push(String(v));
        } else if (v instanceof Date) {
          cells.push(v.toISOString());
        } else if (typeof v === 'object' && 'text' in v && typeof v.text === 'string') {
          // Hyperlinks: { text, hyperlink }
          cells.push(escapeCell(v.text));
        } else if (typeof v === 'object' && 'richText' in v && Array.isArray(v.richText)) {
          // Rich-text runs: collapse to plain text.
          cells.push(
            escapeCell(v.richText.map((r: { text?: string }) => r.text ?? '').join('')),
          );
        } else if (typeof v === 'object' && 'result' in v) {
          // Formula cell: use the cached evaluated result.
          const r = (v as { result?: unknown }).result;
          cells.push(r == null ? '' : escapeCell(String(r)));
        } else {
          cells.push(escapeCell(String(v)));
        }
      });
      lines.push(cells.join(','));
    });
  });
  return lines.join('\n');
}

function escapeCell(s: string): string {
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
