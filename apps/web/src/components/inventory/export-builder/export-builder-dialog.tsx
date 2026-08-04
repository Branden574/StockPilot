'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  downloadInventoryExport,
  fetchExportPreview,
  type ExportPreviewResponse,
  type ExportStage,
  type InventoryExportRequest,
} from '@/lib/download-export';
import { exportItemTypeKind } from '@/lib/exports/export-request';

import { ExportBuilderFields } from './export-builder-fields';
import { ExportBuilderPreview } from './export-builder-preview';
import { presetsFor, type ExportPreset } from './export-builder-presets';
import {
  builderSummaryParts,
  CUSTOM_PRESET_ID,
  initialExportBuilderState,
  moveField,
  restoreDefaults,
  scopeSummary,
  setFormat,
  setOptions,
  toExportRequest,
  toggleField,
  validateExportBuilder,
  type ExportBuilderState,
} from './export-builder-state';

/**
 * The ONE export configuration surface (Brief sections 2, 4, 5, 6).
 *
 * Mounted from the inventory toolbar (filtered / all) AND the bulk-selection
 * bar (selected), for Books and Items alike. There is no second configuration
 * UI anywhere: inventory-table.tsx and bulk-actions.tsx each render this.
 */

const FORMATS: Array<{
  value: 'pdf' | 'xlsx' | 'csv';
  label: string;
  description: string;
}> = [
  {
    value: 'pdf',
    label: 'PDF',
    description: 'Formatted document for printing, sharing, and visual inventory reviews.',
  },
  {
    value: 'xlsx',
    label: 'Excel',
    description: 'Editable spreadsheet with filters, formatting, column widths, and optional images.',
  },
  {
    value: 'csv',
    label: 'CSV',
    description: 'Simple data file for imports, databases, and spreadsheet applications.',
  },
];

export interface ExportBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: 'selected' | 'filtered' | 'all';
  itemType: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  selectedIds?: string[];
  filters?: InventoryExportRequest['filters'];
  /** Row count already on screen, shown until the preview reports the truth. */
  rowCountHint?: number | null;
}

function Checkbox({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  id?: string;
}) {
  // The house idiom: there is no shared checkbox.tsx in this repo, and the
  // inventory table has always used a role="checkbox" button.
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-[13.5px] text-[var(--ed-ink-2)]"
    >
      <span
        aria-hidden
        className={`inline-grid h-4 w-4 place-items-center rounded-[4px] border ${
          checked ? 'border-foreground bg-foreground' : 'border-border bg-background'
        }`}
      >
        {checked ? (
          <span className="h-[9px] w-[5px] -translate-y-px rotate-45 border-b-2 border-r-2 border-background" />
        ) : null}
      </span>
      {label}
    </button>
  );
}

export function ExportBuilderDialog({
  open,
  onOpenChange,
  scope,
  itemType,
  selectedIds,
  filters,
  rowCountHint = null,
}: ExportBuilderDialogProps) {
  const itemTypeKind = exportItemTypeKind(itemType);
  const [state, setState] = React.useState<ExportBuilderState>(() =>
    initialExportBuilderState(itemTypeKind),
  );
  const [preview, setPreview] = React.useState<ExportPreviewResponse | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [stage, setStage] = React.useState<ExportStage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [presets, setPresets] = React.useState<ExportPreset[]>(() => presetsFor(itemTypeKind));
  // Remounts ExportBuilderFields at the start of every export attempt so its
  // own internal "X moved to…" reorder announcement (a role="status" region
  // that field-picker never clears once set) cannot re-surface once `busy`
  // drops back to false — which a FAILED export does, right in front of the
  // user, while a stale announcement from an earlier reorder is still sitting
  // in state. Bumping this key is a full unmount+remount, which resets that
  // component's internal state (the announcement AND the field search box)
  // without needing a resettable prop on export-builder-fields.tsx itself.
  const [fieldsResetKey, setFieldsResetKey] = React.useState(0);

  const rowCount = preview?.total ?? rowCountHint;
  const validation = validateExportBuilder(state);

  // Focus restore on close (Brief 26): the trigger is always a plain button
  // in the CALLER (inventory-table.tsx's ExportMenu, bulk-actions.tsx, or a
  // test harness) — never a <DialogTrigger> rendered by this component — so
  // Radix's own context.triggerRef (the target its default onCloseAutoFocus
  // focuses) is never populated and that default restore silently no-ops,
  // dropping focus to <body> on close (Escape included). Same fix as
  // delivery-request-action.tsx's preview dialog (Bug 2), adapted for a
  // trigger that lives in a DIFFERENT component: onOpenAutoFocus fires the
  // instant the content mounts, BEFORE Radix's own FocusScope has moved
  // focus into it, so document.activeElement there is still whatever was
  // focused right before the dialog opened. Read it in that callback (not
  // during render — a ref write during render is only sanctioned for
  // one-time lazy init, and react-hooks/refs correctly flags anything more
  // than that), then hand it back on close.
  const triggerElRef = React.useRef<HTMLElement | null>(null);

  // One preview fetch per scope/filter change — NOT per field toggle. The
  // sample rows are formatted locally through the registry, so changing fields
  // or their order re-renders instantly with zero requests.
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPresets(presetsFor(itemTypeKind));
    fetchExportPreview(
      {
        scope,
        itemType,
        ...(scope === 'selected' ? { ids: selectedIds ?? [] } : {}),
        ...(scope === 'filtered' ? { filters } : {}),
      },
      controller.signal,
    )
      .then(setPreview)
      .catch(() => {
        // A failed preview must never block an export — the dialog just shows
        // the on-screen count and no readiness panel.
        setPreview(null);
      });
    return () => controller.abort();
    // filters is a new object each render at the call site; serialise it so the
    // effect keys off its VALUE, not its identity.
  }, [open, scope, itemType, itemTypeKind, JSON.stringify(filters), JSON.stringify(selectedIds)]);

  const applyPreset = (preset: ExportPreset) => {
    if (preset.id === CUSTOM_PRESET_ID) {
      setState((s) => ({ ...s, presetId: CUSTOM_PRESET_ID }));
      return;
    }
    setState((s) => {
      const withFields: ExportBuilderState = {
        ...s,
        fieldKeys: [...preset.fieldKeys],
        presetId: preset.id,
        options: {
          ...s.options,
          ...(preset.options ?? {}),
          includeImages: preset.fieldKeys.includes('image'),
          pdf: { ...s.options.pdf, ...(preset.options?.pdf ?? {}) },
          xlsx: { ...s.options.xlsx, ...(preset.options?.xlsx ?? {}) },
        },
      };
      return setFormat(withFields, s.format, itemTypeKind);
    });
  };

  const activePreset = presets.find((p) => p.id === state.presetId) ?? null;

  async function runExport() {
    if (busy || !validation.ok) return;
    setBusy(true);
    setError(null);
    setFieldsResetKey((k) => k + 1);
    try {
      await downloadInventoryExport(
        toExportRequest(state, {
          scope,
          itemType,
          ids: selectedIds,
          filters,
          // "Custom" is not a preset name, it is the absence of one — the
          // filename falls back to slug-scope-date for it.
          presetName:
            activePreset && activePreset.id !== CUSTOM_PRESET_ID ? activePreset.name : null,
        }),
        { onStage: setStage },
      );
      onOpenChange(false);
    } catch (e) {
      // Inside the dialog, never a toast that disappears with the settings.
      setError(e instanceof Error ? e.message : 'Export failed. Please try again.');
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  const stageLabel =
    stage === 'preparing'
      ? `Preparing ${rowCount ?? ''} ${itemTypeKind === 'book' ? 'books' : 'items'}…`.replace('  ', ' ')
      : stage === 'downloading'
        ? 'Downloading…'
        : null;

  return (
    <Dialog open={open} onOpenChange={busy ? () => {} : onOpenChange}>
      <DialogContent
        className="flex max-h-[92vh] w-[min(1180px,96vw)] max-w-[min(1180px,96vw)] flex-col gap-4 overflow-y-auto"
        onOpenAutoFocus={() => {
          triggerElRef.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerElRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Customize export</DialogTitle>
          <DialogDescription>
            {itemTypeKind === 'book'
              ? 'Choose the file format, book information, images, and layout to include in your export.'
              : 'Choose the file format, inventory information, images, and layout to include in your export.'}
          </DialogDescription>
        </DialogHeader>

        <p className="text-[13.5px] font-medium text-[var(--ed-ink-2)]">
          {scopeSummary({ scope, count: rowCount, itemTypeKind })}
        </p>

        <div role="radiogroup" aria-label="File format" className="grid gap-2 sm:grid-cols-3">
          {FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={state.format === f.value}
              aria-label={f.label}
              onClick={() => setState((s) => setFormat(s, f.value, itemTypeKind))}
              className={`rounded-md border p-3 text-left transition-colors ${
                state.format === f.value
                  ? 'border-foreground bg-muted'
                  : 'border-border bg-background hover:border-[var(--ed-line-strong)]'
              }`}
            >
              <span className="block text-[14px] font-medium">{f.label}</span>
              <span className="mt-1 block text-[12.5px] text-[var(--ed-ink-3)]">
                {f.description}
              </span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={state.presetId}
            onValueChange={(id) => {
              const preset = presets.find((p) => p.id === id);
              if (preset) applyPreset(preset);
            }}
          >
            <SelectTrigger aria-label="Export preset" className="w-[240px]">
              <SelectValue placeholder="Preset" />
            </SelectTrigger>
            <SelectContent>
              {presets.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => setState((s) => restoreDefaults(s, itemTypeKind))}
            className="text-[13px] text-[var(--ed-ink-3)] underline-offset-2 hover:underline"
          >
            Restore recommended defaults
          </button>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ExportBuilderFields
            key={fieldsResetKey}
            state={state}
            itemTypeKind={itemTypeKind}
            onToggle={(key) => setState((s) => toggleField(s, key))}
            onMove={(key, direction) => setState((s) => moveField(s, key, direction))}
            busy={busy}
          />
          <div className="flex flex-col gap-3">
            {/* Per-format settings */}
            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-[12.5px] font-medium text-[var(--ed-ink-3)]">
                {state.format === 'pdf'
                  ? 'PDF layout'
                  : state.format === 'xlsx'
                    ? 'Excel options'
                    : 'CSV options'}
              </legend>
              <div className="flex flex-col gap-2">
                {state.format === 'csv' ? (
                  <Checkbox
                    label="Include image URL"
                    checked={state.fieldKeys.includes('image')}
                    onChange={() => setState((s) => toggleField(s, 'image'))}
                  />
                ) : (
                  <Checkbox
                    label={itemTypeKind === 'book' ? 'Include cover images' : 'Include images'}
                    checked={state.fieldKeys.includes('image')}
                    onChange={() => setState((s) => toggleField(s, 'image'))}
                  />
                )}

                {state.format !== 'csv' && state.fieldKeys.includes('image') ? (
                  <label className="flex items-center gap-2 text-[13px]">
                    Image size
                    <select
                      aria-label="Image size"
                      value={state.options.imageSize}
                      onChange={(e) =>
                        setState((s) =>
                          setOptions(s, {
                            imageSize: e.target.value as 'small' | 'medium' | 'large',
                          }),
                        )
                      }
                      className="rounded-sm border border-border bg-background px-2 py-1"
                    >
                      <option value="small">Small</option>
                      <option value="medium">Medium</option>
                      <option value="large">Large</option>
                    </select>
                  </label>
                ) : null}

                {state.format === 'pdf' ? (
                  <>
                    <label className="flex items-center gap-2 text-[13px]">
                      Paper size
                      <select
                        aria-label="Paper size"
                        value={state.options.pdf.paperSize}
                        onChange={(e) =>
                          setState((s) =>
                            setOptions(s, {
                              pdf: { paperSize: e.target.value as 'letter' | 'legal' },
                            }),
                          )
                        }
                        className="rounded-sm border border-border bg-background px-2 py-1"
                      >
                        <option value="letter">Letter</option>
                        <option value="legal">Legal</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-[13px]">
                      Orientation
                      <select
                        aria-label="Orientation"
                        value={state.options.pdf.orientation}
                        onChange={(e) =>
                          setState((s) =>
                            setOptions(s, {
                              pdf: {
                                orientation: e.target.value as 'auto' | 'portrait' | 'landscape',
                              },
                            }),
                          )
                        }
                        className="rounded-sm border border-border bg-background px-2 py-1"
                      >
                        <option value="auto">Auto</option>
                        <option value="portrait">Portrait</option>
                        <option value="landscape">Landscape</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-[13px]">
                      Row density
                      <select
                        aria-label="Row density"
                        value={state.options.pdf.density}
                        onChange={(e) =>
                          setState((s) =>
                            setOptions(s, {
                              pdf: {
                                density: e.target.value as
                                  | 'compact'
                                  | 'comfortable'
                                  | 'image-friendly',
                              },
                            }),
                          )
                        }
                        className="rounded-sm border border-border bg-background px-2 py-1"
                      >
                        <option value="compact">Compact</option>
                        <option value="comfortable">Comfortable</option>
                        <option value="image-friendly">Image-friendly</option>
                      </select>
                    </label>
                    {itemTypeKind === 'book' ? (
                      <label className="flex items-center gap-2 text-[13px]">
                        Layout
                        <select
                          aria-label="Layout"
                          value={
                            state.options.pdf.layout === 'catalog'
                              ? `catalog-${state.options.pdf.catalogColumns}`
                              : 'table'
                          }
                          onChange={(e) => {
                            const v = e.target.value;
                            setState((s) =>
                              setOptions(s, {
                                pdf:
                                  v === 'table'
                                    ? { layout: 'table' }
                                    : {
                                        layout: 'catalog',
                                        catalogColumns: Number(v.split('-')[1]) as 1 | 2 | 3,
                                      },
                              }),
                            );
                          }}
                          className="rounded-sm border border-border bg-background px-2 py-1"
                        >
                          <option value="table">Table</option>
                          <option value="catalog-1">Book catalog — single column</option>
                          <option value="catalog-2">Book catalog — two columns</option>
                          <option value="catalog-3">Book catalog — three columns</option>
                        </select>
                      </label>
                    ) : null}
                    <Checkbox
                      label="Repeat table headings on every page"
                      checked={state.options.pdf.repeatHeaders}
                      onChange={(next) =>
                        setState((s) => setOptions(s, { pdf: { repeatHeaders: next } }))
                      }
                    />
                    <Checkbox
                      label="Show page numbers"
                      checked={state.options.pdf.pageNumbers}
                      onChange={(next) =>
                        setState((s) => setOptions(s, { pdf: { pageNumbers: next } }))
                      }
                    />
                    <Checkbox
                      label="Wrap long text"
                      checked={state.options.pdf.wrapText}
                      onChange={(next) =>
                        setState((s) => setOptions(s, { pdf: { wrapText: next } }))
                      }
                    />
                  </>
                ) : null}

                {state.format === 'xlsx' ? (
                  <>
                    <Checkbox
                      label="Freeze header row"
                      checked={state.options.xlsx.freezeHeader}
                      onChange={(next) =>
                        setState((s) => setOptions(s, { xlsx: { freezeHeader: next } }))
                      }
                    />
                    <Checkbox
                      label="Add filters to the header row"
                      checked={state.options.xlsx.autoFilter}
                      onChange={(next) =>
                        setState((s) => setOptions(s, { xlsx: { autoFilter: next } }))
                      }
                    />
                    <Checkbox
                      label="Include summary sheet"
                      checked={state.options.xlsx.includeSummarySheet}
                      onChange={(next) =>
                        setState((s) => setOptions(s, { xlsx: { includeSummarySheet: next } }))
                      }
                    />
                  </>
                ) : null}
              </div>
            </fieldset>

            <ExportBuilderPreview
              state={state}
              itemTypeKind={itemTypeKind}
              preview={preview}
              rowCount={rowCount}
            />
          </div>
        </div>

        <p className="text-[12.5px] text-[var(--ed-ink-3)]">
          {builderSummaryParts({ state, itemTypeKind, rowCount }).join(' · ')}
        </p>

        {!validation.ok ? (
          <p role="alert" className="text-[13px] text-[var(--ed-danger,#b3261e)]">
            {validation.message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[13px] text-[var(--ed-danger,#b3261e)]">
            {error}
          </p>
        ) : null}
        {stageLabel ? (
          <p role="status" aria-live="polite" className="text-[13px] text-[var(--ed-ink-3)]">
            {stageLabel}
            {state.fieldKeys.includes('image')
              ? ' Cover images make this slower.'
              : ''}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={runExport} disabled={busy || !validation.ok}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Export file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
