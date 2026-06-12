'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { parseCsv } from '@/lib/csv';
import {
  applySage50Valuation,
  detectSage50Kind,
  mapSage50Items,
  mapSage50Valuation,
  mapSage50Vendors,
  type Sage50Item,
  type Sage50Vendor,
} from '@/lib/sage50';
import { importSage50Action, type Sage50ImportSummary } from '@/server/actions/sage50-import';

interface LoadedFiles {
  items: {
    fileName: string;
    items: Sage50Item[];
    skipped: number;
    clampedNegative: number;
  } | null;
  valuation: { fileName: string; count: number; map: Map<string, { qty: number; avgCost: number | null }> } | null;
  vendors: { fileName: string; vendors: Sage50Vendor[]; skipped: number } | null;
  unknown: string[];
}

const EMPTY: LoadedFiles = { items: null, valuation: null, vendors: null, unknown: [] };

/** Items per server-action call — bounds the request body AND keeps each call
 *  comfortably inside the function timeout (each item is a few DB writes). */
const CHUNK_SIZE = 250;

/**
 * Guided "Migrate from Sage 50" wizard. The user exports up to three CSVs from
 * Sage 50 (Inventory Item List, Inventory Valuation report, Vendor List),
 * drops them all here in any order — file kinds are AUTO-DETECTED from their
 * headers — picks the destination warehouse, and imports in one click. Parsing
 * + mapping run entirely client side (lib/sage50.ts); the server action
 * receives normalized rows only, in CHUNK_SIZE chunks (vendors ride along with
 * every chunk so cross-chunk items still link — the server reuses by name, so
 * no duplicates).
 */
export function Sage50ImportWizard({
  warehouses,
}: {
  warehouses: { id: string; name: string }[];
}) {
  const [loaded, setLoaded] = React.useState<LoadedFiles>(EMPTY);
  const [summary, setSummary] = React.useState<Sage50ImportSummary | null>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [warehouseId, setWarehouseId] = React.useState<string>(warehouses[0]?.id ?? '');
  const [importing, startImport] = React.useTransition();
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setSummary(null);

    const next: LoadedFiles = { ...loaded, unknown: [...loaded.unknown] };
    for (const file of Array.from(files)) {
      let text: string;
      try {
        text = await file.text();
      } catch {
        next.unknown.push(`${file.name} (unreadable)`);
        continue;
      }
      const { header, rows } = parseCsv(text);
      const kind = detectSage50Kind(header);
      if (kind === 'items') {
        const mapped = mapSage50Items(header, rows);
        next.items = {
          fileName: file.name,
          items: mapped.items,
          skipped: mapped.skipped.length,
          clampedNegative: mapped.clampedNegative,
        };
      } else if (kind === 'valuation') {
        const map = mapSage50Valuation(header, rows);
        next.valuation = { fileName: file.name, count: map.size, map };
      } else if (kind === 'vendors') {
        const mapped = mapSage50Vendors(header, rows);
        next.vendors = { fileName: file.name, vendors: mapped.vendors, skipped: mapped.skipped.length };
      } else {
        next.unknown.push(file.name);
      }
    }
    setLoaded(next);
    if (inputRef.current) inputRef.current.value = '';
  }

  function runImport() {
    if (!loaded.items || !warehouseId) return;
    startImport(async () => {
      setProgress(null);
      // Deep-copy so the valuation overlay never double-applies across retries.
      const items = loaded.items!.items.map((i) => ({ ...i }));
      let valuationNote: string | null = null;
      if (loaded.valuation) {
        const { matched, clampedNegative } = applySage50Valuation(items, loaded.valuation.map);
        valuationNote = `${matched} quantities applied from the valuation report${
          clampedNegative ? ` (${clampedNegative} negative → 0)` : ''
        }`;
      }
      const vendors = loaded.vendors?.vendors ?? [];

      // Chunked submission: aggregate per-chunk summaries. Supplier stats come
      // from the FIRST chunk only (later chunks resend the vendor list purely
      // so their items can link; the server reuses by name).
      const agg: Sage50ImportSummary = {
        items: { total: 0, created: 0, failed: 0, errors: [] },
        suppliers: { total: 0, created: 0, reused: 0, failed: 0, skipped: false, skippedReason: null },
      };
      try {
        for (let offset = 0; offset < items.length; offset += CHUNK_SIZE) {
          const chunk = items.slice(offset, offset + CHUNK_SIZE);
          if (items.length > CHUNK_SIZE) {
            setProgress(
              `Importing ${Math.min(offset + chunk.length, items.length)} of ${items.length}…`,
            );
          }
          const res = await importSage50Action({
            warehouseId,
            rowOffset: offset,
            items: chunk,
            vendors,
          });
          if (!res.ok) {
            toast.error(res.error.message);
            // Surface what DID land before the failing chunk.
            if (agg.items.total > 0) setSummary(agg);
            setProgress(null);
            return;
          }
          agg.items.total += res.data.items.total;
          agg.items.created += res.data.items.created;
          agg.items.failed += res.data.items.failed;
          agg.items.errors = [...agg.items.errors, ...res.data.items.errors].slice(0, 50);
          if (offset === 0) agg.suppliers = res.data.suppliers;
        }
      } catch (e) {
        // Transport-level failure (offline, body too large, timeout) — keep the
        // parsed state and show a toast instead of crashing to the error page.
        toast.error(e instanceof Error ? e.message : 'Import failed — please try again.');
        if (agg.items.total > 0) setSummary(agg);
        setProgress(null);
        return;
      }
      setProgress(null);
      setSummary(agg);
      toast.success(
        `Imported ${agg.items.created} of ${agg.items.total} items` +
          (valuationNote ? ` — ${valuationNote}` : ''),
      );
    });
  }

  const fileBadge = (label: string, value: string | null) => (
    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {value ? (
        <Badge variant="default" className="text-[10px]">{value}</Badge>
      ) : (
        <Badge variant="outline" className="text-[10px]">not loaded</Badge>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1 · Export from Sage 50</CardTitle>
          <CardDescription>
            In Sage 50: <span className="font-medium text-foreground">File → Select Import/Export</span>{' '}
            → export the <span className="font-medium text-foreground">Inventory Item List</span> and{' '}
            <span className="font-medium text-foreground">Vendor List</span> as CSV. For accurate stock
            counts, also open the <span className="font-medium text-foreground">Inventory Valuation
            report</span> and export it to CSV (the item list&apos;s quantity column is unreliable —
            the valuation report is the true snapshot).
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">2 · Drop the files here</CardTitle>
          <CardDescription>
            Add all the CSVs at once or one at a time — each file&apos;s type is detected
            automatically from its headers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            multiple
            onChange={(e) => void handleFiles(e.target.files)}
            className="text-muted-foreground file:bg-foreground file:text-background block w-full cursor-pointer text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-xs file:font-medium"
          />
          <div className="grid gap-2 sm:grid-cols-3">
            {fileBadge(
              'Item list',
              loaded.items ? `${loaded.items.items.length} items` : null,
            )}
            {fileBadge(
              'Valuation (stock)',
              loaded.valuation ? `${loaded.valuation.count} quantities` : null,
            )}
            {fileBadge(
              'Vendor list',
              loaded.vendors ? `${loaded.vendors.vendors.length} vendors` : null,
            )}
          </div>
          {(loaded.items?.skipped || loaded.vendors?.skipped) ? (
            <p className="text-muted-foreground text-xs">
              Skipped rows with blank IDs:{' '}
              {[
                loaded.items?.skipped ? `${loaded.items.skipped} item` : null,
                loaded.vendors?.skipped ? `${loaded.vendors.skipped} vendor` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
          {loaded.items && loaded.items.clampedNegative > 0 && (
            <p className="text-muted-foreground text-xs">
              {loaded.items.clampedNegative} item{loaded.items.clampedNegative === 1 ? '' : 's'} had
              negative quantities or costs in the item list — those values open at 0 (correct via
              cycle count, or load the valuation report for true quantities).
            </p>
          )}
          {loaded.unknown.length > 0 && (
            <p className="text-destructive text-xs">
              Not recognized as a Sage 50 export: {loaded.unknown.join(', ')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">3 · Import</CardTitle>
          <CardDescription>
            {loaded.items
              ? `${loaded.items.items.length} items${
                  loaded.vendors ? ` + ${loaded.vendors.vendors.length} vendors (as suppliers)` : ''
                }${loaded.valuation ? ', with stock quantities from the valuation report' : ''}.
                Items whose SKU already exists will fail individually and are listed below — nothing
                gets overwritten.`
              : 'Load the Inventory Item List first — it is the only required file.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {warehouses.length === 0 ? (
            <p className="text-destructive text-sm">
              Create a warehouse first — imported items need one to belong to.
            </p>
          ) : (
            warehouses.length > 1 && (
              <div className="max-w-xs space-y-1">
                <Label htmlFor="sage50-warehouse" className="text-xs">
                  Destination warehouse
                </Label>
                <Select value={warehouseId} onValueChange={setWarehouseId}>
                  <SelectTrigger id="sage50-warehouse">
                    <SelectValue placeholder="Select a warehouse" />
                  </SelectTrigger>
                  <SelectContent>
                    {warehouses.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          )}
          <Button onClick={runImport} disabled={!loaded.items || !warehouseId || importing}>
            {importing ? (progress ?? 'Importing…') : 'Import into StockPilot'}
          </Button>

          {summary && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <p>
                <span className="font-medium">Items:</span> {summary.items.created} created ·{' '}
                {summary.items.failed} failed (of {summary.items.total})
              </p>
              <p>
                <span className="font-medium">Suppliers:</span>{' '}
                {summary.suppliers.skipped
                  ? `skipped — ${summary.suppliers.skippedReason ?? 'unavailable'} (items imported unlinked)`
                  : `${summary.suppliers.created} created · ${summary.suppliers.reused} matched existing${
                      summary.suppliers.failed ? ` · ${summary.suppliers.failed} failed` : ''
                    }`}
              </p>
              {summary.items.errors.length > 0 && (
                <details className="text-xs">
                  <summary className="text-muted-foreground cursor-pointer">
                    First {summary.items.errors.length} errors
                  </summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {summary.items.errors.map((e) => (
                      <li key={`${e.row}-${e.sku}`}>
                        {e.sku}: {e.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
