'use client';

import {
  TRACKING_MODE_LABELS,
  countingUnitLabel,
  type CountingUnit,
  type TrackingMode,
} from '@stockpilot/core';

/**
 * The Add Item "this will be saved as" card (Sports Task 11).
 *
 * Display-only — every value here is a PREVIEW computed by the caller from
 * the resolved tracking profile and the core key builders. The server always
 * recomputes group/variant identity independently on save (variant_key /
 * group_key are never accepted from a client — see variant-keys.ts), so a
 * stale or wrong preview can never corrupt data; at worst it surprises the
 * user for a moment before the real save reconciles it.
 *
 * The "Serial: not required" line is the reassurance that stops staff from
 * inventing placeholder serials ('N/A', '0000') for a quantity-tracked
 * product — requirement 12.
 */
export interface GroupingPreviewProps {
  groupName: string | null;
  variantLabel: string | null;
  mode: TrackingMode;
  countingUnit: CountingUnit;
  /** Existing groups that look close. Advisory only — never auto-linked. */
  candidates?: Array<{ id: string; name: string }>;
  onUseCandidate?: (id: string) => void;
}

export function GroupingPreview({
  groupName,
  variantLabel,
  mode,
  countingUnit,
  candidates = [],
  onUseCandidate,
}: GroupingPreviewProps) {
  const serialLine =
    mode === 'SERIALIZED' || mode === 'INDIVIDUALLY_TAGGED'
      ? 'Serial: required, one per unit'
      : mode === 'OPTIONAL_SERIALIZED'
        ? 'Serial: optional'
        : 'Serial: not required';

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
      <div className="mb-2 font-medium">This will be saved as</div>
      <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
        <dt className="text-muted-foreground">Product group</dt>
        <dd>{groupName ?? 'New group'}</dd>
        <dt className="text-muted-foreground">Variant</dt>
        <dd>{variantLabel ?? 'Single variant'}</dd>
        <dt className="text-muted-foreground">Tracking</dt>
        <dd>{TRACKING_MODE_LABELS[mode]}</dd>
        <dt className="text-muted-foreground">Counting unit</dt>
        <dd>{countingUnitLabel(countingUnit, 2)}</dd>
        <dt className="text-muted-foreground">Serial</dt>
        <dd>{serialLine}</dd>
      </dl>

      {candidates.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-1 text-xs text-muted-foreground">
            These existing groups look similar. Nothing is linked automatically.
          </div>
          <ul className="space-y-1">
            {candidates.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2">
                <span>{c.name}</span>
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => onUseCandidate?.(c.id)}
                >
                  Use this group
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
