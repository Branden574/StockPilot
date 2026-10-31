'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox as SharedCheckbox } from '@/components/ui/checkbox';
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  downloadInventoryExport,
  fetchExportPreview,
  type ExportPreviewRequest,
  type ExportPreviewResponse,
  type ExportStage,
  type InventoryExportRequest,
} from '@/lib/download-export';
import { isControlFlow } from '@/lib/control-flow';
import { exportItemTypeKind } from '@/lib/exports/export-request';
import { droppedFieldsNote, type SharedExportPresetConfig } from '@/lib/exports/preset-config';
import {
  deleteSharedExportPresetAction,
  listSharedExportPresetsAction,
  saveSharedExportPresetAction,
  type SharedExportPresetDto,
} from '@/server/actions/export-presets';

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
    description:
      'Editable spreadsheet with filters, formatting, column widths, and optional images.',
  },
  {
    value: 'csv',
    label: 'CSV',
    description: 'Simple data file for imports, databases, and spreadsheet applications.',
  },
];

/** What a preview answer is filed under: the request's JSON and the attempt. */
function previewKeyOf(attempt: number, requestJson: string): string {
  return `${attempt}:${requestJson}`;
}

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
  // The shared checkbox (components/ui/checkbox): one role="checkbox" button
  // whose visible words are its name, as this option always was.
  return (
    <SharedCheckbox
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      className="text-[13px] text-[var(--ed-ink-2)]"
    >
      {label}
    </SharedCheckbox>
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
  // The preview request as it is sent. Its JSON keys the fetch below: the call
  // sites build a new `filters` object (and ids array) on every render, so the
  // fetch follows their VALUES, never their identity.
  const previewRequestJson = JSON.stringify({
    scope,
    itemType,
    ...(scope === 'selected' ? { ids: selectedIds ?? [] } : {}),
    ...(scope === 'filtered' ? { filters } : {}),
  } satisfies ExportPreviewRequest);
  // Bumped by Try again after a failed preview.
  const [previewAttempt, setPreviewAttempt] = React.useState(0);
  // The last answer, tagged with the request (and attempt) it answers. Only an
  // answer to the CURRENT request counts; anything else reads as loading.
  // `preview: null` is a failed request.
  const [previewAnswer, setPreviewAnswer] = React.useState<{
    key: string;
    preview: ExportPreviewResponse | null;
  } | null>(null);
  const currentAnswer =
    previewAnswer?.key === previewKeyOf(previewAttempt, previewRequestJson) ? previewAnswer : null;
  const preview = currentAnswer?.preview ?? null;
  const previewFailed = currentAnswer !== null && currentAnswer.preview === null;
  const [busy, setBusy] = React.useState(false);
  const [stage, setStage] = React.useState<ExportStage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [presets, setPresets] = React.useState<ExportPreset[]>(() => presetsFor(itemTypeKind));
  // Org-shared presets (export_presets, migration 0338). null = not loaded or
  // not available (table missing in the code-before-migration window, or the
  // list call failed): the dialog renders EXACTLY as it did before shared
  // presets existed.
  const [shared, setShared] = React.useState<SharedExportPresetDto[] | null>(null);
  // The visible "this preset lost fields to registry evolution" note.
  const [sharedNote, setSharedNote] = React.useState<string | null>(null);
  const [saveFormOpen, setSaveFormOpen] = React.useState(false);
  const [saveName, setSaveName] = React.useState('');
  const [saveBusy, setSaveBusy] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
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
    const key = previewKeyOf(previewAttempt, previewRequestJson);
    const controller = new AbortController();
    fetchExportPreview(JSON.parse(previewRequestJson) as ExportPreviewRequest, controller.signal)
      .then((answer) => setPreviewAnswer({ key, preview: answer }))
      .catch(() => {
        // Superseded by a newer request, or the dialog closed: nothing failed.
        if (controller.signal.aborted) return;
        // A failed preview must never block an export: the preview says the
        // sample could not load and offers Try again; the on-screen count stays.
        setPreviewAnswer({ key, preview: null });
      });
    return () => controller.abort();
  }, [open, previewAttempt, previewRequestJson]);

  // Load the org's shared presets once per open. Any failure — table not
  // migrated yet (available:false), permission refusal, network — leaves
  // `shared` null and the dialog exactly as it was before this feature.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listSharedExportPresetsAction()
      .then((res) => {
        if (cancelled) return;
        setShared(res.ok && res.data.available ? res.data.presets : null);
        // Reset the shared-preset chrome from any previous session HERE (in
        // the resolution, never synchronously in the effect body — the
        // react-hooks set-state-in-effect rule): a reopened dialog starts
        // with no stale note, no half-open save form, no pending confirm.
        setSharedNote(null);
        setSaveFormOpen(false);
        setSaveError(null);
        setConfirmingDelete(false);
      })
      .catch((e: unknown) => {
        // A redirect (the session ended): the router is already navigating.
        if (isControlFlow(e)) return;
        if (!cancelled) setShared(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Only presets FOR this export (books vs items) with a readable config are
  // offered; unreadable rows (out-of-band writes) are deliberately absent.
  const sharedPresets = React.useMemo(
    () =>
      (shared ?? []).filter(
        (p): p is SharedExportPresetDto & { config: SharedExportPresetConfig } =>
          p.config !== null && p.config.itemTypeKind === itemTypeKind,
      ),
    [shared, itemTypeKind],
  );

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

  const applySharedPreset = (
    preset: SharedExportPresetDto & { config: SharedExportPresetConfig },
  ) => {
    const cfg = preset.config;
    setState((s) => {
      const merged: ExportBuilderState = {
        ...s,
        fieldKeys: [...cfg.fieldKeys],
        presetId: `shared-${preset.id}`,
        options: {
          ...s.options,
          ...(cfg.options ?? {}),
          includeImages: cfg.fieldKeys.includes('image'),
          pdf: { ...s.options.pdf, ...(cfg.options?.pdf ?? {}) },
          xlsx: { ...s.options.xlsx, ...(cfg.options?.xlsx ?? {}) },
        },
      };
      return setFormat(merged, cfg.format ?? s.format, itemTypeKind);
    });
    // The visible note the load contract owes: fields the registry no longer
    // knows were dropped, and the user is told which.
    setSharedNote(preset.droppedFieldKeys.length > 0 ? droppedFieldsNote(preset) : null);
    setConfirmingDelete(false);
  };

  const activePreset = presets.find((p) => p.id === state.presetId) ?? null;
  const activeSharedPreset = sharedPresets.find((p) => `shared-${p.id}` === state.presetId) ?? null;

  async function saveSharedPreset() {
    if (saveBusy) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      const res = await saveSharedExportPresetAction({
        name: saveName,
        config: {
          itemTypeKind,
          fieldKeys: [...state.fieldKeys],
          format: state.format,
          options: state.options,
        },
      });
      if (!res.ok) {
        setSaveError(res.error.message);
        return;
      }
      setShared((prev) => [...(prev ?? []), res.data].sort((a, b) => a.name.localeCompare(b.name)));
      setState((s) => ({ ...s, presetId: `shared-${res.data.id}` }));
      setSaveFormOpen(false);
      setSaveName('');
      setSharedNote(null);
    } catch (e) {
      // A redirect (the session ended): the router is already navigating.
      if (isControlFlow(e)) return;
      setSaveError(e instanceof Error ? e.message : 'Saving the preset failed. Please try again.');
    } finally {
      setSaveBusy(false);
    }
  }

  async function deleteSharedPreset(preset: SharedExportPresetDto) {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      const res = await deleteSharedExportPresetAction({ id: preset.id });
      if (!res.ok) {
        setSharedNote(res.error.message);
        return;
      }
      setShared((prev) => (prev ?? []).filter((p) => p.id !== preset.id));
      setState((s) =>
        s.presetId === `shared-${preset.id}` ? { ...s, presetId: CUSTOM_PRESET_ID } : s,
      );
      setSharedNote(null);
    } catch (e) {
      // A redirect (the session ended): the router is already navigating.
      if (isControlFlow(e)) return;
      setSharedNote(
        e instanceof Error ? e.message : 'Deleting the preset failed. Please try again.',
      );
    } finally {
      setDeleteBusy(false);
      setConfirmingDelete(false);
    }
  }

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
          presetName: activeSharedPreset
            ? activeSharedPreset.name
            : activePreset && activePreset.id !== CUSTOM_PRESET_ID
              ? activePreset.name
              : null,
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
      ? `Preparing ${rowCount ?? ''} ${itemTypeKind === 'book' ? 'books' : 'items'}…`.replace(
          '  ',
          ' ',
        )
      : stage === 'downloading'
        ? 'Downloading…'
        : null;

  return (
    <Dialog open={open} onOpenChange={busy ? () => {} : onOpenChange}>
      <DialogContent
        className="flex max-h-[92vh] w-[min(1180px,96vw)] max-w-[min(1180px,96vw)] flex-col gap-4 overflow-y-auto"
        onOpenAutoFocus={() => {
          triggerElRef.current = document.activeElement as HTMLElement | null;
          // Each time the dialog opens: personal presets live in this
          // browser's storage, so read them again (a preset saved in another
          // tab is offered), and start from a fresh sample rather than the
          // answer, or failure, of an earlier open. The open event, not an
          // effect: no render that is then corrected.
          setPresets(presetsFor(itemTypeKind));
          setPreviewAnswer(null);
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
              className={`rounded-lg border p-3 text-left transition-colors ${
                state.format === f.value
                  ? 'border-foreground bg-card shadow-[0_0_0_1px_hsl(var(--foreground))]'
                  : 'bg-card hover:bg-muted border-[var(--ed-line-strong)]'
              }`}
            >
              <span className="block text-[13.5px] font-medium">{f.label}</span>
              <span className="text-muted-foreground mt-1 block text-[12.5px]">
                {f.description}
              </span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={state.presetId}
            onValueChange={(id) => {
              if (id.startsWith('shared-')) {
                const sharedPreset = sharedPresets.find((p) => `shared-${p.id}` === id);
                if (sharedPreset) applySharedPreset(sharedPreset);
                return;
              }
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
              {sharedPresets.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>Team presets</SelectLabel>
                  {sharedPresets.map((p) => (
                    <SelectItem key={`shared-${p.id}`} value={`shared-${p.id}`}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => setState((s) => restoreDefaults(s, itemTypeKind))}
            className="text-muted-foreground hover:text-foreground text-[13px] underline-offset-2 hover:underline"
          >
            Restore recommended defaults
          </button>
          {shared !== null && !saveFormOpen ? (
            <button
              type="button"
              onClick={() => {
                setSaveFormOpen(true);
                setSaveError(null);
                setSaveName(activeSharedPreset ? '' : saveName);
              }}
              disabled={busy}
              className="text-muted-foreground hover:text-foreground text-[13px] underline-offset-2 hover:underline"
            >
              Save as team preset
            </button>
          ) : null}
          {activeSharedPreset?.canDelete && !confirmingDelete ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy || deleteBusy}
              className="text-muted-foreground hover:text-foreground text-[13px] underline-offset-2 hover:underline"
            >
              Delete preset
            </button>
          ) : null}
        </div>

        {/* Shared-preset affordances: empty state, save form, delete confirm,
            and the dropped-fields note the load contract owes. All of it is
            absent while `shared` is null (table not migrated, list failed). */}
        {shared !== null && sharedPresets.length === 0 && !saveFormOpen ? (
          <p className="text-muted-foreground text-[12.5px]">
            No team presets yet. Set up an export and choose Save as team preset to share it with
            your organization.
          </p>
        ) : null}

        {saveFormOpen ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[13px]">
              Preset name
              <input
                type="text"
                aria-label="Preset name"
                value={saveName}
                maxLength={60}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void saveSharedPreset();
                  }
                }}
                className="bg-card focus-visible:ring-ring h-8 w-[220px] max-w-full rounded-md border border-[var(--ed-line-strong)] px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 max-sm:h-11 max-sm:text-base"
              />
            </label>
            <Button
              size="sm"
              onClick={() => void saveSharedPreset()}
              disabled={saveBusy || saveName.trim().length === 0}
            >
              {saveBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Save preset
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSaveFormOpen(false);
                setSaveError(null);
              }}
              disabled={saveBusy}
            >
              Cancel
            </Button>
          </div>
        ) : null}
        {saveError ? (
          <p role="alert" className="text-destructive text-[13px]">
            {saveError}
          </p>
        ) : null}

        {confirmingDelete && activeSharedPreset ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-[var(--ed-ink-2)]">
              Delete “{activeSharedPreset.name}” for everyone in your organization?
            </span>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void deleteSharedPreset(activeSharedPreset)}
              disabled={deleteBusy}
            >
              {deleteBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Delete preset
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmingDelete(false)}
              disabled={deleteBusy}
            >
              Keep it
            </Button>
          </div>
        ) : null}

        {sharedNote ? (
          <p role="status" className="text-[13px] text-[var(--ed-ink-2)]">
            {sharedNote}
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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
            <fieldset className="border-border rounded-lg border p-3">
              <legend className="text-muted-foreground px-1 text-[12.5px] font-medium">
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
                      className="bg-card focus-visible:ring-ring h-8 rounded-md border border-[var(--ed-line-strong)] px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 max-sm:h-11 max-sm:text-base"
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
                        className="bg-card focus-visible:ring-ring h-8 rounded-md border border-[var(--ed-line-strong)] px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 max-sm:h-11 max-sm:text-base"
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
                        className="bg-card focus-visible:ring-ring h-8 rounded-md border border-[var(--ed-line-strong)] px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 max-sm:h-11 max-sm:text-base"
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
                                  'compact' | 'comfortable' | 'image-friendly',
                              },
                            }),
                          )
                        }
                        className="bg-card focus-visible:ring-ring h-8 rounded-md border border-[var(--ed-line-strong)] px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 max-sm:h-11 max-sm:text-base"
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
                          className="bg-card focus-visible:ring-ring h-8 rounded-md border border-[var(--ed-line-strong)] px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 max-sm:h-11 max-sm:text-base"
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
              failed={previewFailed}
              onRetry={() => setPreviewAttempt((n) => n + 1)}
              rowCount={rowCount}
            />
          </div>
        </div>

        <p className="text-muted-foreground text-[12.5px]">
          {builderSummaryParts({ state, itemTypeKind, rowCount }).join(' · ')}
        </p>

        {!validation.ok ? (
          <p role="alert" className="text-destructive text-[13px]">
            {validation.message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-[13px]">
            {error}
          </p>
        ) : null}
        {stageLabel ? (
          <p role="status" aria-live="polite" className="text-muted-foreground text-[13px]">
            {stageLabel}
            {state.fieldKeys.includes('image') ? ' Cover images make this slower.' : ''}
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
