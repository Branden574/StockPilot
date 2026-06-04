import 'server-only';

import ExcelJS from 'exceljs';

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
    ws.addRow(headers.map((h) => r[h] ?? ''));
  }

  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle' };
  // Freeze the header so wide inventory dumps stay readable while scrolling.
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
