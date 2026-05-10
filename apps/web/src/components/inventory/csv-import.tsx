'use client';

import { Download, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { parseCsv, rowsToObjects, toCsv } from '@/lib/csv';
import { importItemsAction } from '@/server/actions/import';
import { cn } from '@/lib/utils';

const TEMPLATE_HEADER = [
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
];

const TEMPLATE_SAMPLE = [
  {
    name: 'Wireless Mouse',
    sku: 'SP-MOUSE-001',
    barcode: '0123456789012',
    description: 'Bluetooth mouse, black',
    unit_cost: 12.5,
    retail_price: 29.99,
    quantity_on_hand: 50,
    reorder_point: 10,
    reorder_quantity: 25,
    unit_of_measure: 'unit',
  },
];

export function CsvImport() {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [parsed, setParsed] = React.useState<{ header: string[]; rows: Record<string, string>[] } | null>(null);
  const [summary, setSummary] = React.useState<Awaited<ReturnType<typeof importItemsAction>> | null>(null);

  function downloadTemplate() {
    const csv = toCsv(TEMPLATE_HEADER, TEMPLATE_SAMPLE);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stockpilot-items-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleFile(file: File) {
    setParsing(true);
    try {
      const text = await file.text();
      const { header, rows } = parseCsv(text);
      const objects = rowsToObjects<Record<string, string>>(header, rows);
      if (objects.length === 0) {
        toast.error('The CSV file is empty. Add at least one row and try again.');
        return;
      }
      if (!header.includes('name')) {
        toast.error('CSV must include a "name" column. Add it and re-upload.');
        return;
      }
      setParsed({ header, rows: objects });
      setSummary(null);
    } finally {
      setParsing(false);
    }
  }

  async function runImport() {
    if (!parsed) return;
    setImporting(true);
    const res = await importItemsAction({ rows: parsed.rows });
    setImporting(false);
    setSummary(res);
    if (res.ok) {
      toast.success(`Imported ${res.data.created} of ${res.data.total} rows.`);
      router.refresh();
    } else {
      toast.error(res.error.message);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="h-4 w-4" />
            Step 1 — download the template
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">
            Required columns: <code className="rounded bg-muted px-1 py-0.5 text-xs">name</code>. Everything else is optional.
          </p>
          <Button variant="outline" size="sm" onClick={downloadTemplate}>
            <Download className="h-4 w-4" /> Download CSV template
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Step 2 — upload your CSV</CardTitle>
        </CardHeader>
        <CardContent>
          <label
            htmlFor="csv-upload"
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/20 px-6 py-10 transition-colors hover:border-primary/40 hover:bg-muted/40',
            )}
          >
            {parsing ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <Upload className="h-5 w-5 text-muted-foreground" />
            )}
            <p className="text-sm font-medium">{parsing ? 'Parsing…' : 'Drop or click to choose a CSV'}</p>
            <p className="text-xs text-muted-foreground">UTF-8 encoded · up to 5,000 rows</p>
            <input
              id="csv-upload"
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = '';
              }}
            />
          </label>
        </CardContent>
      </Card>

      {parsed && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 3 — review & import</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm">
              <p>
                Detected <strong>{parsed.rows.length}</strong> rows · headers:{' '}
                <span className="font-mono text-xs">{parsed.header.join(', ')}</span>
              </p>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    {parsed.header.slice(0, 8).map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 5).map((r, i) => (
                    <tr key={i} className="border-t">
                      {parsed.header.slice(0, 8).map((h) => (
                        <td key={h} className="truncate px-3 py-2 text-xs">
                          {r[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.rows.length > 5 && (
                <p className="border-t bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
                  …and {parsed.rows.length - 5} more
                </p>
              )}
            </div>
            <div className="flex justify-end">
              <Button variant="gradient" onClick={runImport} disabled={importing}>
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : `Import ${parsed.rows.length} items`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {summary?.ok && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Result</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              Imported <strong className="text-success">{summary.data.created}</strong> · Failed{' '}
              <strong className={summary.data.failed > 0 ? 'text-destructive' : ''}>{summary.data.failed}</strong> ·{' '}
              Total {summary.data.total}
            </p>
            {summary.data.errors.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Show {summary.data.errors.length} error{summary.data.errors.length === 1 ? '' : 's'}
                </summary>
                <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs">
                  {summary.data.errors.map((e, i) => (
                    <li key={i} className="rounded bg-destructive/10 px-2 py-1 text-destructive">
                      Row {e.row}: {e.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
