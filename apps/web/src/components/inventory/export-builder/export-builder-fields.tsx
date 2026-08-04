'use client';

import { ChevronDown, ChevronsDown, ChevronsUp, ChevronUp } from 'lucide-react';
import * as React from 'react';

import { INVENTORY_EXPORT_MAX_FIELDS } from '@/lib/exports/export-request';
import {
  fieldHeading,
  type InventoryExportField,
  type InventoryExportFieldGroup,
  type InventoryExportFieldKey,
  IDENTIFYING_FIELD_KEYS,
} from '@/lib/exports/field-registry';
import { computeExportPdfLayout } from '@/lib/exports/pdf-layout';

import { availableFieldsFor, type ExportBuilderState } from './export-builder-state';

/**
 * Field selection and ordering (Brief sections 7, 10 and 13).
 *
 * Reordering is KEYBOARD-FIRST. There is no drag-and-drop dependency anywhere
 * in this repo, and the brief requires keyboard controls whether or not drag
 * exists — so four explicit buttons per row are the primary mechanism, not a
 * fallback. Every control is a real button with a real accessible name.
 *
 * Two things beyond the literal brief text, both carried forward from Task
 * 14's review as explicit acceptance criteria:
 *   - INVENTORY_EXPORT_MAX_FIELDS (export-request.ts) is enforced HERE, not
 *     only by the server's zod schema: an unchecked field is disabled once
 *     30 are already selected, and "Select all" stops adding once it hits
 *     the same limit. The registry only has 29 real fields today, so this
 *     is defense-in-depth for the fields Brief section 7 lists as
 *     "verify schema" and not yet built (Model Number, Manufacturer, Tags,
 *     Description, Unit of Measure, Custom Attributes) — unreachable today,
 *     load-bearing the day one of those ships.
 *   - Moving a field to an end of the list disables the control that was
 *     just used (e.g. "move up" once a field is first) — and a disabled
 *     button cannot hold browser focus. Without deliberate handling here,
 *     that silently drops keyboard focus to <body>, which fails Brief
 *     section 26. The row's ref map + a post-move effect below re-targets
 *     focus at whichever control in the same row is still enabled.
 */

const GROUP_LABELS: Record<InventoryExportFieldGroup, string> = {
  common: 'Common fields',
  book: 'Book fields',
  financial: 'Financial fields',
  system: 'System fields',
};
const GROUP_ORDER: InventoryExportFieldGroup[] = ['common', 'book', 'financial', 'system'];

export interface ExportBuilderFieldsProps {
  state: ExportBuilderState;
  itemTypeKind: 'book' | 'other';
  onToggle: (key: InventoryExportFieldKey) => void;
  onMove: (key: InventoryExportFieldKey, direction: 'up' | 'down' | 'top' | 'bottom') => void;
  /**
   * True while the dialog's own export is in flight.
   *
   * The dialog mounts its OWN `role="status"` region for the export stage
   * ("Preparing…"/"Downloading…") the moment busy goes true. This
   * component's move announcement ("X moved to…") is a SEPARATE
   * `role="status"` region that, once a user has reordered a field, stays
   * mounted indefinitely — nothing here ever clears it. Left alone, both
   * regions hold content at once as soon as a reorder is followed by an
   * export, which is two competing live-region announcements screen reader
   * users hear simultaneously. Suppressing this region while busy keeps the
   * invariant that at most one status region has content at a time.
   */
  busy?: boolean;
}

export function ExportBuilderFields({
  state,
  itemTypeKind,
  onToggle,
  onMove,
  busy = false,
}: ExportBuilderFieldsProps) {
  const [query, setQuery] = React.useState('');
  const [announcement, setAnnouncement] = React.useState('');
  const rowRefs = React.useRef(new Map<InventoryExportFieldKey, HTMLLIElement>());
  const pendingFocusKey = React.useRef<InventoryExportFieldKey | null>(null);

  const available = availableFieldsFor(itemTypeKind, state.format);
  const headingFor = (field: InventoryExportField) =>
    fieldHeading(field, { format: state.format, itemType: itemTypeKind });

  const matches = (field: InventoryExportField) =>
    query.trim().length === 0 ||
    headingFor(field).toLowerCase().includes(query.trim().toLowerCase());

  const selected = state.fieldKeys
    .map((key) => available.find((f) => f.key === key))
    .filter((f): f is InventoryExportField => Boolean(f));

  const atFieldCap = state.fieldKeys.length >= INVENTORY_EXPORT_MAX_FIELDS;

  const warnings =
    state.format === 'pdf'
      ? computeExportPdfLayout({
          fields: selected,
          itemTypeKind,
          includeImages: state.options.includeImages,
          imageSize: state.options.imageSize,
          orientation: state.options.pdf.orientation,
          paperSize: state.options.pdf.paperSize,
          density: state.options.pdf.density,
          wrapText: state.options.pdf.wrapText,
          layout: state.options.pdf.layout,
          catalogColumns: state.options.pdf.catalogColumns,
        }).warnings
      : [];

  const move = (field: InventoryExportField, direction: 'up' | 'down' | 'top' | 'bottom') => {
    onMove(field.key, direction);
    pendingFocusKey.current = field.key;
    setAnnouncement(
      `${headingFor(field)} moved ${direction === 'top' ? 'to the top' : direction === 'bottom' ? 'to the bottom' : direction}.`,
    );
  };

  // Runs after every render where the selected-fields order changed. Only
  // does anything right after a move (pendingFocusKey is set in `move`
  // above); every other render it is a no-op. Re-targets focus at whichever
  // control in the moved field's row is still enabled, because the control
  // the user was just on may have become `disabled` by the reorder itself
  // (e.g. "move up" once the field reaches the top) — and a disabled button
  // cannot hold focus, so without this the browser silently blurs to <body>.
  React.useEffect(() => {
    const key = pendingFocusKey.current;
    if (!key) return;
    pendingFocusKey.current = null;
    const row = rowRefs.current.get(key);
    if (!row) return;
    const stillEnabled = row.querySelector<HTMLButtonElement>('button:not([disabled])');
    (stillEnabled ?? row).focus();
  }, [state.fieldKeys]);

  const visibleGroups = GROUP_ORDER.map((group) => ({
    group,
    fields: available.filter((f) => f.group === group && matches(f)),
  })).filter((g) => g.fields.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          role="searchbox"
          aria-label="Search fields"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search fields"
          className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-[12.5px]"
        />
        <button
          type="button"
          onClick={() => {
            let count = state.fieldKeys.length;
            for (const field of available) {
              if (count >= INVENTORY_EXPORT_MAX_FIELDS) break;
              if (!state.fieldKeys.includes(field.key)) {
                onToggle(field.key);
                count += 1;
              }
            }
          }}
          className="text-[12px] text-[var(--ed-ink-3)] underline-offset-2 hover:underline"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => {
            // "Optional" means everything except ONE identifying field — the
            // export stays valid, so the user is never left in an error state
            // by a convenience button.
            const keep = state.fieldKeys.find((k) => IDENTIFYING_FIELD_KEYS.includes(k));
            for (const key of state.fieldKeys) {
              if (key !== keep) onToggle(key);
            }
          }}
          className="text-[12px] text-[var(--ed-ink-3)] underline-offset-2 hover:underline"
        >
          Clear optional
        </button>
      </div>

      {warnings.length > 0 ? (
        <p role="alert" className="text-[12px] text-[var(--ed-warn,#8a6d00)]">
          {warnings[0]}
        </p>
      ) : null}

      <div className="max-h-[240px] overflow-y-auto rounded-md border border-border p-2">
        {visibleGroups.length === 0 ? (
          <p className="p-2 text-[12px] text-[var(--ed-ink-4)]">No fields match that search.</p>
        ) : (
          visibleGroups.map(({ group, fields }) => (
            <div key={group} role="group" aria-label={GROUP_LABELS[group]} className="mb-2">
              <p className="px-1 py-1 text-[11px] uppercase tracking-wide text-[var(--ed-ink-4)]">
                {GROUP_LABELS[group]}
              </p>
              {fields.map((field) => {
                const checked = state.fieldKeys.includes(field.key);
                const disabledByCap = !checked && atFieldCap;
                return (
                  <button
                    key={field.key}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-disabled={disabledByCap}
                    aria-label={headingFor(field)}
                    disabled={disabledByCap}
                    onClick={() => onToggle(field.key)}
                    className="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-[12.5px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
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
                    {headingFor(field)}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--ed-ink-4)]">
          Column order
        </p>
        <ol
          aria-label="Selected fields, in export order"
          className="flex flex-col gap-1 rounded-md border border-border p-2"
        >
          {selected.map((field, index) => (
            <li
              key={field.key}
              ref={(el) => {
                if (el) rowRefs.current.set(field.key, el);
                else rowRefs.current.delete(field.key);
              }}
              tabIndex={-1}
              className="flex items-center gap-2 text-[12.5px]"
            >
              <span className="w-5 text-right font-mono text-[11px] text-[var(--ed-ink-4)]">
                {index + 1}
              </span>
              <span className="flex-1">{headingFor(field)}</span>
              <button
                type="button"
                aria-label={`Move ${headingFor(field)} to top`}
                disabled={index === 0}
                onClick={() => move(field, 'top')}
                className="rounded-sm border border-border p-1 disabled:opacity-40"
              >
                <ChevronsUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={`Move ${headingFor(field)} up`}
                disabled={index === 0}
                onClick={() => move(field, 'up')}
                className="rounded-sm border border-border p-1 disabled:opacity-40"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={`Move ${headingFor(field)} down`}
                disabled={index === selected.length - 1}
                onClick={() => move(field, 'down')}
                className="rounded-sm border border-border p-1 disabled:opacity-40"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={`Move ${headingFor(field)} to bottom`}
                disabled={index === selected.length - 1}
                onClick={() => move(field, 'bottom')}
                className="rounded-sm border border-border p-1 disabled:opacity-40"
              >
                <ChevronsDown className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ol>
        {announcement && !busy ? (
          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>
        ) : null}
      </div>
    </div>
  );
}
