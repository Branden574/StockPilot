'use client';

import { Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  supplierRiskRegisterCsv,
  supplierRiskRegisterCsvFilename,
  type SupplierRiskCsvRow,
} from '@/lib/supplier-risk/register-csv';

/**
 * Download the register as CSV, from the rows the page already shows (nothing
 * is read again). Every cell is guarded against spreadsheet formulas
 * (lib/supplier-risk/register-csv.ts).
 */
export function RegisterCsvButton({
  rows,
  timeZone,
  complete,
}: {
  rows: SupplierRiskCsvRow[];
  /** The organization's zone (resolved): "Reviewed on" is its day. */
  timeZone: string;
  /** Every supplier was read; when not, the file's first line says so. */
  complete: boolean;
}) {
  function download() {
    const blob = new Blob([supplierRiskRegisterCsv(rows, { timeZone, complete })], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = supplierRiskRegisterCsvFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  return (
    <Button type="button" variant="outline" onClick={download} disabled={rows.length === 0}>
      <Download className="h-4 w-4" aria-hidden /> Download CSV
    </Button>
  );
}
