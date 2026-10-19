'use client';

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  ListChecks,
  Loader2,
  Upload,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  AMBIGUOUS_COLUMN_MEANING_LABELS,
  itemCsvTemplateHeader,
  LINE_RESULT_LABELS,
  resolveItemCsvHeaders,
  type AmbiguousColumnMeaning,
} from '@stockpilot/core';

import { DetailSection } from '@/components/patterns/detail-section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { parseCsv, rowsToObjects, toCsv } from '@/lib/csv';
import { importItemsAction, prepareItemImportAction } from '@/server/actions/import';
import { cn } from '@/lib/utils';

import type { ImportSummary, ItemImportPreview } from '@/server/actions/import';

/**
 * The template columns.
 *
 * MODULE-GATED (final-review fix). The sports block (Task 13) is what lets a
 * size run arrive as a size run instead of N unrelated rows — but it was in the
 * template, and in the "Applied on import" note, for EVERY org. An org with no
 * sports module downloaded a 32-column template naming jerseys, colorways and
 * size systems it has no screens for, and read a paragraph about product-group
 * identity that means nothing to it. Same gate as every other sports surface:
 * the columns appear when the module is on, and the base template is the exact
 * pre-branch one when it is off.
 *
 * Two tiers within the sports block, and the difference is visible to the user
 * in the note below rather than hidden here: `size`…`player_name` are applied to
 * the created item today, while the group-identity columns (brand, model,
 * style_number, colorway, team, season, home_away) plus counting_unit /
 * tracking_mode / serial / asset_tag are accepted and validated but not yet
 * applied — creating product groups or serial units from a bulk CSV is identity
 * creation, and the owner decision routes that through the review tool, never a
 * heuristic import.
 *
 * The SERVER is unchanged either way: `importItemsAction` accepts and validates
 * the same columns for every org, so a hand-built CSV carrying them behaves
 * exactly as it did. This is what the template OFFERS, not what is allowed.
 *
 * ONE VOCABULARY (wave-2 fix). The column list now lives in
 * `@stockpilot/core`'s `itemCsvTemplateHeader`, which is the SAME list the
 * header-mapping resolver matches against. They used to be separate arrays in
 * this file, which is exactly how a template can come to offer a column its own
 * importer does not recognise.
 */
const templateHeader = itemCsvTemplateHeader;

/** The columns a row's value actually reaches the created item through. */
const BASE_APPLIED_COLUMNS = [
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
  // Applied since the live-verification fix: it resolves ORG-SCOPED by name and
  // overrides the destination picked below, per row. It sat in this template
  // being validated and then ignored while every row failed for want of a
  // warehouse, so naming it here is part of the fix, not decoration.
  'warehouse_name',
];

const SPORTS_APPLIED_COLUMNS = [
  'size',
  'size_system',
  'width',
  'fit',
  'color',
  'jersey_number',
  'player_name',
];

/** The plain sample row every org gets. */
const BASE_SAMPLE = [
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

/** The second sample row exists to demonstrate the sports columns, so it ships
 *  only when they do. */
const SPORTS_SAMPLE = [
  {
    name: 'Falcons Home Jersey - M',
    sku: 'FALC-HOME-M-07',
    description: 'Home jersey, number 07',
    unit_cost: 42,
    retail_price: 0,
    quantity_on_hand: 3,
    reorder_point: 0,
    reorder_quantity: 0,
    unit_of_measure: 'each',
    brand: 'Nike',
    team: 'Falcons',
    season: '2026',
    home_away: 'home',
    // Leading zeroes are kept: 07 and 7 are different uniforms. Type this
    // column as TEXT in your spreadsheet, or Excel will drop the zero.
    jersey_number: '07',
    player_name: 'A. Rosas',
    size: 'M',
    size_system: 'ALPHA',
    fit: 'mens',
    color: 'Red/Black',
    counting_unit: 'each',
  },
];

export function CsvImport({
  sportsEnabled = false,
  warehouses = [],
  forcedWarehouseId = null,
  warehouseLabel = 'Warehouse',
}: {
  sportsEnabled?: boolean;
  /**
   * The org's active warehouses. Every created item must belong to one
   * (`InventoryService.create()` has refused otherwise since d4550449), and
   * this screen never asked — so every CSV row failed with
   * "A warehouse must be selected before creating an item." until now.
   */
  warehouses?: Array<{ id: string; name: string }>;
  /** A warehouse-scoped user's assignment. The server forces it regardless, so
   *  the picker shows it locked rather than pretending there is a choice. */
  forcedWarehouseId?: string | null;
  /** Org terminology for "warehouse" (some orgs call them sites/campuses). */
  warehouseLabel?: string;
}) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = React.useState<string>(
    forcedWarehouseId ?? warehouses[0]?.id ?? '',
  );
  const header = React.useMemo(() => templateHeader(sportsEnabled), [sportsEnabled]);
  const sample = React.useMemo(
    () => (sportsEnabled ? [...BASE_SAMPLE, ...SPORTS_SAMPLE] : BASE_SAMPLE),
    [sportsEnabled],
  );
  const appliedColumns = sportsEnabled
    ? [...BASE_APPLIED_COLUMNS, ...SPORTS_APPLIED_COLUMNS]
    : BASE_APPLIED_COLUMNS;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [parsed, setParsed] = React.useState<{
    header: string[];
    rows: Record<string, string>[];
    fileName: string;
  } | null>(null);
  /**
   * The finished import, and ONLY a finished one.
   *
   * OWNER, live prod: "showed imported those 4 items but its still on the same
   * screen". The result used to be appended below a Step 3 that stayed mounted
   * with the same file, the same review table and an Import button that
   * re-enabled the instant `importing` went false — so a completed import read
   * as "nothing happened", and the obvious next click re-submitted a file that
   * had already landed. Setting this is what ENDS the flow: the Step 3 card is
   * unmounted with it (see `setParsed(null)` in `runImport`), so there is
   * nothing left to click.
   */
  const [done, setDone] = React.useState<ImportSummary | null>(null);
  /**
   * The synchronous double-submit latch. `disabled={importing}` is a RENDER,
   * and two clicks landing in the same tick both pass it before React has
   * re-rendered anything — which is exactly how one file becomes two imports.
   * A ref flips before the first await, so the second click has nothing to do.
   */
  const submitting = React.useRef(false);
  /**
   * The SERVER's review of this file. Everything the table shows — the per-row
   * Result, the group/variant columns, the ambiguous headers and the duplicate
   * warning — is computed by `prepareItemImportAction` from the same functions
   * the write uses, so the screen can never promise one outcome and the import
   * perform another.
   */
  const [preview, setPreview] = React.useState<ItemImportPreview | null>(null);
  const [reviewing, setReviewing] = React.useState(false);
  /** The human's answers, keyed by the header exactly as the file printed it. */
  const [decisions, setDecisions] = React.useState<Record<string, AmbiguousColumnMeaning>>({});
  /** The explicit same-file override. Never defaulted on. */
  const [acknowledgeDuplicate, setAcknowledgeDuplicate] = React.useState(false);

  /** Re-run the server review. Called on upload and after every answer. */
  const review = React.useCallback(
    async (
      file: { header: string[]; rows: Record<string, string>[]; fileName: string },
      nextDecisions: Record<string, AmbiguousColumnMeaning>,
    ) => {
      setReviewing(true);
      const res = await prepareItemImportAction({
        rows: file.rows,
        headers: file.header,
        headerDecisions: nextDecisions,
        fileName: file.fileName,
      });
      setReviewing(false);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setPreview(res.data);
    },
    [],
  );

  function downloadTemplate() {
    const csv = toCsv(header, sample);
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
      // Mapping-aware (wave-2 fix). This used to demand a LITERAL `name`
      // header, which would now reject a file the importer can read perfectly
      // well — "Item Name" and "Product Name" resolve to `name` through the
      // same vocabulary the server uses. The check asks the resolver rather
      // than the string, so the screen and the importer agree on what counts.
      const hasName = resolveItemCsvHeaders(header, { sportsEnabled }).some(
        (m) => m.field === 'name',
      );
      if (!hasName) {
        toast.error(
          'CSV must include a name column (name, Item Name or Product Name). Add it and re-upload.',
        );
        return;
      }
      const next = { header, rows: objects, fileName: file.name };
      setParsed(next);
      setDone(null);
      setPreview(null);
      setDecisions({});
      setAcknowledgeDuplicate(false);
      await review(next, {});
    } finally {
      setParsing(false);
    }
  }

  /** Answering a column re-reviews the whole file: a confirmed meaning can
   *  change every row's Result, not just the header strip. */
  async function answerHeader(header: string, meaning: AmbiguousColumnMeaning) {
    const next = { ...decisions, [header]: meaning };
    setDecisions(next);
    if (parsed) await review(parsed, next);
  }

  async function runImport() {
    // Latched BEFORE the first await — see `submitting`.
    if (submitting.current) return;
    if (!parsed) return;
    if (!warehouseId) {
      toast.error(`Pick a ${warehouseLabel.toLowerCase()} before importing items.`);
      return;
    }
    submitting.current = true;
    setImporting(true);
    try {
      const res = await importItemsAction({
        rows: parsed.rows,
        headers: parsed.header,
        headerDecisions: decisions,
        fileName: parsed.fileName,
        acknowledgeDuplicate,
        warehouseId,
      });
      if (!res.ok) {
        // A failure is not a completion: the file, its answers and its
        // duplicate override all stay put so the same click can be retried.
        toast.error(res.error.message);
        return;
      }
      // END THE FLOW. Step 3 unmounts with `parsed`, so the file cannot be
      // submitted a second time — by a stray click or by a reloaded tab.
      setDone(res.data);
      setParsed(null);
      setPreview(null);
      setDecisions({});
      setAcknowledgeDuplicate(false);
      toast.success(`Imported ${res.data.created} of ${res.data.total} rows.`);
      router.refresh();
    } finally {
      setImporting(false);
      submitting.current = false;
    }
  }

  const ambiguous = (preview?.mappings ?? []).filter((m) => m.status === 'ambiguous');
  const unmapped = (preview?.mappings ?? []).filter(
    (m) => m.status === 'unmapped' || m.status === 'duplicate',
  );
  const duplicate = preview?.duplicate ?? null;
  const showSportsColumns = Boolean(preview?.sportsEnabled);
  // Import is blocked by ANY of: an unanswered column, an unacknowledged
  // re-upload, no destination, or a review still in flight.
  // `preview == null` is NOT optional: a failed review must not fall through to
  // an enabled Import over an empty table. Reviewing before committing is the
  // requirement, so no review means no import.
  const blocked =
    !warehouseId ||
    reviewing ||
    preview == null ||
    preview.unresolvedHeaders.length > 0 ||
    (duplicate != null && !acknowledgeDuplicate);

  return (
    <div className="space-y-4">
      <DetailSection
        bodyClassName="space-y-3"
        title={
          <span className="flex items-center gap-2">
            <FileSpreadsheet aria-hidden className="text-muted-foreground h-4 w-4" />
            Step 1 — download the template
          </span>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p className="text-muted-foreground text-[13px]">
            Required columns: <code className={CODE}>name</code>. Everything else is optional.
          </p>
          <Button variant="outline" onClick={downloadTemplate}>
            <Download className="h-4 w-4" /> Download CSV template
          </Button>
        </div>
        <p className="text-muted-foreground text-[12px] leading-[18px]">
          Applied on import: {appliedColumns.join(', ')}. Leave{' '}
          <code className={CODE}>warehouse_name</code> blank to use the{' '}
          {warehouseLabel.toLowerCase()} chosen below, or name one exactly as it appears in{' '}
          {warehouseLabel}s to send that row somewhere else. The remaining template columns
          {sportsEnabled
            ? ' (product group identity, counting unit, tracking mode, serial, asset tag, and the category / location lookups)'
            : ' (the category / location lookups)'}{' '}
          are accepted and checked, but are set through the item
          {sportsEnabled ? ' and product-group screens' : ' screens'} rather than a bulk import.
          {sportsEnabled ? (
            <>
              {' '}
              Keep <code className={CODE}>jersey_number</code> formatted as text so leading zeroes
              survive.
            </>
          ) : null}
        </p>
      </DetailSection>

      <DetailSection
        bodyClassName="space-y-4"
        title={
          <span className="flex items-center gap-2">
            <Upload aria-hidden className="text-muted-foreground h-4 w-4" />
            Step 2 — upload your CSV
          </span>
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="csv-warehouse">Destination {warehouseLabel.toLowerCase()}</Label>
          <Select
            value={warehouseId}
            onValueChange={setWarehouseId}
            disabled={Boolean(forcedWarehouseId) || warehouses.length === 0}
          >
            <SelectTrigger id="csv-warehouse" className="sm:max-w-sm">
              <SelectValue placeholder={`Pick a ${warehouseLabel.toLowerCase()}`} />
            </SelectTrigger>
            <SelectContent>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-[12px] leading-[17px]">
            {warehouses.length === 0
              ? `Create a ${warehouseLabel.toLowerCase()} first — every item has to live somewhere.`
              : `Where these items land unless a row names its own ${warehouseLabel.toLowerCase()}.`}
          </p>
        </div>
        <label
          htmlFor="csv-upload"
          className={cn(
            // The inset drop zone (the shared upload look): a quiet dashed
            // box on the stronger hairline over the recessed fill.
            'border-line-strong bg-sunk hover:bg-muted flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center transition-colors',
          )}
        >
          {parsing ? (
            <Loader2 aria-hidden className="text-muted-foreground h-5 w-5 animate-spin" />
          ) : (
            <FileSpreadsheet aria-hidden className="text-muted-foreground h-5 w-5" />
          )}
          <p className="text-[13.5px] font-medium">
            {parsing ? 'Parsing…' : 'Drop or click to choose a CSV'}
          </p>
          <p className="text-muted-foreground text-[12px]">UTF-8 encoded · up to 5,000 rows</p>
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
      </DetailSection>

      {parsed && (
        <DetailSection
          bodyClassName="space-y-4"
          title={
            <span className="flex items-center gap-2">
              <ListChecks aria-hidden className="text-muted-foreground h-4 w-4" />
              Step 3 — review & import
            </span>
          }
        >
          <div className="border-border bg-sunk rounded-md border px-4 py-3 text-[13px]">
            <p>
              Detected <strong>{parsed.rows.length}</strong> rows in{' '}
              <span className="font-mono text-[12px] [overflow-wrap:anywhere]">
                {parsed.fileName}
              </span>
              {unmapped.length > 0 && (
                <>
                  {' '}
                  · not imported:{' '}
                  <span className="font-mono text-[12px] [overflow-wrap:anywhere]">
                    {unmapped.map((m) => m.header).join(', ')}
                  </span>
                </>
              )}
            </p>
          </div>

          {/*
              THE MAPPING STEP. Requirements: "Never silently guess: show
              candidate mappings, require confirmation, preserve source values,
              block import until required mappings resolved." The live run found
              a column headed `Number` echoed once and then dropped, with Import
              enabled from the moment the file parsed.
            */}
          {ambiguous.length > 0 && (
            <section className={CAUTION}>
              <div className="flex items-start gap-2">
                <AlertTriangle aria-hidden className="text-warning mt-0.5 h-4 w-4 shrink-0" />
                <div className="space-y-1">
                  <h3 className="text-[13.5px] font-medium">
                    Confirm what {ambiguous.length} column
                    {ambiguous.length === 1 ? ' means' : 's mean'}
                  </h3>
                  <p className="text-muted-foreground text-[12px] leading-[18px]">
                    A column headed something like &ldquo;Number&rdquo; could be a
                    {showSportsColumns ? ' jersey number, a' : ''} quantity, a serial or a style
                    number. Rather than guess, this import waits for you to say. Choosing{' '}
                    <span className="font-medium">Ignore</span> leaves the column out entirely — its
                    values are never applied to a field you did not name.
                  </p>
                </div>
              </div>
              <div className="divide-border border-border bg-card divide-y rounded-md border">
                {ambiguous.map((m) => (
                  <div
                    key={m.header}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-[12.5px]"
                  >
                    <span className="font-mono font-medium">{m.header}</span>
                    <span className="text-muted-foreground min-w-0 max-w-[280px] truncate">
                      e.g.{' '}
                      {parsed.rows
                        .slice(0, 3)
                        .map((r) => r[m.header])
                        .filter((v) => (v ?? '').trim() !== '')
                        .join(', ') || '—'}
                    </span>
                    <div className="ml-auto w-full sm:w-auto sm:min-w-[220px]">
                      <Select
                        value={decisions[m.header] ?? ''}
                        onValueChange={(v) => answerHeader(m.header, v as AmbiguousColumnMeaning)}
                        disabled={reviewing}
                      >
                        <SelectTrigger
                          className="text-[12.5px]"
                          aria-label={`What does the column ${m.header} mean?`}
                        >
                          <SelectValue placeholder="What is this column?" />
                        </SelectTrigger>
                        <SelectContent>
                          {m.candidates.map((c) => (
                            <SelectItem key={c} value={c}>
                              {AMBIGUOUS_COLUMN_MEANING_LABELS[c]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/*
              THE DUPLICATE WARNING. A byte-identical re-upload used to show
              nothing at all and offer Import again. The hash is never a dead
              end: a human who means it ticks the box and the predecessor is
              superseded.
            */}
          {duplicate && (
            <section className={CAUTION}>
              <div className="flex items-start gap-2">
                <AlertTriangle aria-hidden className="text-warning mt-0.5 h-4 w-4 shrink-0" />
                <div className="space-y-1">
                  <h3 className="text-[13.5px] font-medium">This file was already imported</h3>
                  <p className="text-muted-foreground text-[12px] leading-[18px]">
                    The same {duplicate.rowCount} rows were imported on{' '}
                    {new Date(duplicate.importedAt).toLocaleString()} and created{' '}
                    {duplicate.createdCount} item
                    {duplicate.createdCount === 1 ? '' : 's'}. Importing again creates them a second
                    time. If this really is a second shipment rather than a repeated upload, confirm
                    below.
                  </p>
                </div>
              </div>
              {/* The shared checkbox; its words are part of the one control. */}
              <Checkbox
                className="font-medium"
                checked={acknowledgeDuplicate}
                onCheckedChange={setAcknowledgeDuplicate}
              >
                Import it again anyway
              </Checkbox>
            </section>
          )}

          {/*
              THE REVIEW TABLE. Source row / Name / Group / Variant / Qty /
              Result — not the file's own first eight raw headers, and never a
              bare Valid/Invalid. Group and Variant are module-gated.
            */}
          {/* The review table in the shared table look: uppercase quiet
                headers, hairline rows, contained horizontal scroll. */}
          <div className="border-border overflow-x-auto rounded-md border">
            <table className="w-full min-w-[480px] text-[13px]">
              <thead>
                <tr className="border-border border-b">
                  {[
                    'Row',
                    'Name',
                    ...(showSportsColumns ? ['Group', 'Variant'] : []),
                    'Qty',
                    'Result',
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-muted-foreground whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.06em] first:pl-4 last:pr-4"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(preview?.rows ?? []).slice(0, 20).map((r) => (
                  <tr
                    key={r.sourceRow}
                    className="border-border border-b align-top last:border-b-0"
                  >
                    <td className="text-muted-foreground py-2.5 pl-4 pr-3 font-mono text-[12px] tabular-nums">
                      {r.sourceRow}
                    </td>
                    <td className="px-3 py-2.5 [overflow-wrap:anywhere]">{r.name || '—'}</td>
                    {showSportsColumns && (
                      <>
                        <td className="px-3 py-2.5">{r.group ?? '—'}</td>
                        <td className="px-3 py-2.5">{r.variant ?? '—'}</td>
                      </>
                    )}
                    <td className="px-3 py-2.5 tabular-nums">{r.quantity || '—'}</td>
                    <td className="py-2.5 pl-3 pr-4">
                      <Badge
                        variant={
                          r.result === 'ready' || r.result === 'add_new_variant'
                            ? 'success'
                            : 'warning'
                        }
                        className="align-middle"
                      >
                        {LINE_RESULT_LABELS[r.result]}
                      </Badge>
                      {r.message && (
                        <span className="text-muted-foreground ml-2 text-[12px]">{r.message}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(preview?.rows.length ?? 0) > 20 && (
              <p className="border-border text-muted-foreground border-t px-4 py-2 text-[12px]">
                …and {(preview?.rows.length ?? 0) - 20} more
              </p>
            )}
          </div>
          <div className="border-border -mx-[18px] -mb-[18px] flex items-center justify-end gap-3 border-t px-[18px] py-3">
            {reviewing && <span className="text-muted-foreground text-[12px]">Reviewing…</span>}
            {/* Committing the reviewed file: the ink primary. */}
            <Button onClick={runImport} disabled={importing || blocked}>
              {importing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                `Import ${parsed.rows.length} items`
              )}
            </Button>
          </div>
        </DetailSection>
      )}

      {/*
        THE COMPLETION STATE. It replaces the old bare "Result" panel, which
        printed three numbers under a still-live Step 3 and offered nothing to
        do next. This one says the import is over, in a sentence, and hands the
        user the only thing they actually wanted: the items.
      */}
      {done && (
        <DetailSection
          bodyClassName="space-y-3"
          title={
            <span className="flex items-center gap-2">
              {done.created > 0 ? (
                <CheckCircle2 aria-hidden className="text-success h-4 w-4" />
              ) : (
                <AlertTriangle aria-hidden className="text-warning h-4 w-4" />
              )}
              {done.created > 0
                ? `Imported ${done.created} item${done.created === 1 ? '' : 's'}`
                : 'No items were imported'}
            </span>
          }
        >
          <p className="text-muted-foreground text-[13px]">
            {done.created > 0
              ? `${done.created} of ${done.total} row${done.total === 1 ? '' : 's'} became items.`
              : `All ${done.total} row${done.total === 1 ? '' : 's'} were rejected — nothing was written.`}
            {done.failed > 0 && ` ${done.failed} row${done.failed === 1 ? '' : 's'} failed.`}
            {' Upload another file above to import more.'}
          </p>
          {done.errors.length > 0 && (
            <details open={done.created === 0}>
              <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-[13px]">
                Show {done.errors.length} error{done.errors.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-[12px]">
                {done.errors.map((e, i) => (
                  <li key={i} className="bg-destructive-wash text-destructive rounded px-2 py-1">
                    Row {e.row}: {e.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {done.created > 0 && (
            <Button
              // Newest first, so the rows that just landed are the rows at the
              // top of the list. `created_desc` is an existing, validated sort
              // on /dashboard/inventory — no new URL vocabulary here.
              onClick={() => router.push('/dashboard/inventory?sort=created_desc')}
            >
              View imported items <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </DetailSection>
      )}
    </div>
  );
}

/** An inline code chip (a column name). */
const CODE = 'bg-sunk rounded px-1 py-0.5 font-mono text-[12px]';
/** A caution panel that blocks the import until it is answered. */
const CAUTION = 'border-warning/40 bg-warning-wash space-y-3 rounded-lg border p-4';
