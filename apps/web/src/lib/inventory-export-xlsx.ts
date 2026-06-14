import 'server-only';

import ExcelJS from 'exceljs';

import { escapeForSpreadsheet } from './csv';
import type { ExportCell } from './inventory-export';

/**
 * Render inventory export rows to a real .xlsx workbook (exceljs). One sheet,
 * bold + frozen header row, sensible column widths. Returns a Node Buffer ready
 * to stream as an attachment.
 */
export async function toInventoryXlsx(
  headers: string[],
  rows: Array<Record<string, ExportCell>>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'StockPilot';
  const ws = wb.addWorksheet('Inventory');

  ws.columns = headers.map((h) => ({
    header: h,
    key: h,
    width: Math.min(Math.max(h.length + 2, 12), 44),
  }));

  for (const r of rows) {
    // Defuse spreadsheet-formula injection on STRING cells (same guard the CSV
    // path applies via toCsv) — a cell like "=cmd|..." must not auto-evaluate
    // when the .xlsx is opened. Numbers pass through as real numbers.
    ws.addRow(
      headers.map((h) => {
        const v = r[h];
        return typeof v === 'string' ? escapeForSpreadsheet(v) : (v ?? '');
      }),
    );
  }

  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle' };
  // Freeze the header so wide inventory dumps stay readable while scrolling.
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
