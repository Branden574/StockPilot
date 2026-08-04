'use client';

import type { ExportPreviewResponse } from '@/lib/download-export';
import {
  fieldHeading,
  getExportField,
  type InventoryExportField,
} from '@/lib/exports/field-registry';

import type { ExportBuilderState } from './export-builder-state';

/**
 * Live preview (Brief section 19) and export readiness (section 20).
 *
 * The sample rows come from ONE preview request per scope/filter change; every
 * field toggle and every reorder re-renders from that same sample through the
 * registry, so configuring an export costs no further round trips.
 *
 * The image cell shows a neutral labelled placeholder rather than a picture:
 * the preview endpoint deliberately signs nothing, so there is no URL to draw
 * and none can leak into the DOM.
 */

const EM_DASH = '—';

export interface ExportBuilderPreviewProps {
  state: ExportBuilderState;
  itemTypeKind: 'book' | 'other';
  preview: ExportPreviewResponse | null;
  rowCount: number | null;
}

export function ExportBuilderPreview({
  state,
  itemTypeKind,
  preview,
  rowCount,
}: ExportBuilderPreviewProps) {
  const fields = state.fieldKeys
    .map((key) => getExportField(key))
    .filter((f): f is InventoryExportField => Boolean(f));
  const headingFor = (field: InventoryExportField) =>
    fieldHeading(field, { format: state.format, itemType: itemTypeKind });

  const noun = itemTypeKind === 'book' ? 'books' : 'items';
  const showCoverReadiness = state.fieldKeys.includes('image');

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-md border border-border">
        {preview === null ? (
          <p className="p-3 text-[12px] text-[var(--ed-ink-4)]">Loading a sample of this export…</p>
        ) : (
          <table aria-label="Export preview" className="w-full text-[11.5px]">
            <thead>
              <tr className="bg-muted text-left">
                {fields.map((field) => (
                  <th key={field.key} scope="col" className="whitespace-nowrap px-2 py-1 font-medium">
                    {headingFor(field)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.sampleRows.slice(0, 5).map((row) => (
                <tr key={row.id} className="border-t border-border">
                  {fields.map((field) => {
                    if (field.key === 'image') {
                      return (
                        <td key={field.key} className="px-2 py-1 text-[var(--ed-ink-4)]">
                          {headingFor(field) === 'Image URL' ? 'Image URL' : 'Image'}
                        </td>
                      );
                    }
                    const value = field.value(row);
                    return (
                      <td key={field.key} className="px-2 py-1">
                        {value === null || value === undefined || value === ''
                          ? EM_DASH
                          : String(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {preview ? (
        <div
          role="group"
          aria-label="Export readiness"
          className="rounded-md border border-border p-2 text-[12px] text-[var(--ed-ink-3)]"
        >
          <p>
            {preview.readiness.withIsbn} of {preview.readiness.rows} {noun} have an ISBN
            {preview.readiness.missingIsbn > 0
              ? ` · ${preview.readiness.missingIsbn} missing ISBN`
              : ''}
          </p>
          {showCoverReadiness ? (
            <p>
              {preview.readiness.withImage} of {preview.readiness.rows} have a cover
              {preview.readiness.missingImage > 0
                ? ` · ${preview.readiness.missingImage} missing cover`
                : ''}
            </p>
          ) : null}
          {/* Never a blocker: a missing cover or ISBN is a data gap, not an
              export error, and the file prints a placeholder either way. */}
          <p className="mt-1 text-[11px] text-[var(--ed-ink-4)]">
            Missing values are left blank in the file. They never stop an export.
          </p>
          {preview.truncated ? (
            <p className="mt-1">Only the first 10,000 records are included in this export.</p>
          ) : null}
        </div>
      ) : null}

      {rowCount !== null && preview === null ? (
        <p className="text-[11.5px] text-[var(--ed-ink-4)]">{rowCount} {noun} on screen.</p>
      ) : null}
    </div>
  );
}
