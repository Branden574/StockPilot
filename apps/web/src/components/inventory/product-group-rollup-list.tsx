'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  countingUnitLabel,
  groupRollupLabel,
  variantLabel,
  TRACKING_MODE_LABELS,
  type CountingUnit,
  type TrackingMode,
} from '@stockpilot/core';

import { cn, formatNumber } from '@/lib/utils';

/**
 * The product-groups roll-up list: one collapsed row per group, expanding to
 * its variants in size order.
 *
 * Two rules this component exists to hold:
 *
 *  1. **The header roll-up is the GROUP's, not the page's.** `variantCount` and
 *     `totalQuantity` come from `product_group_rollups`, so the header says
 *     what the group actually holds even if a variant row were ever missing
 *     from the expansion. Summing the rendered rows instead would make the
 *     header quietly agree with whatever happened to load.
 *  2. **No blank serial column for quantity products.** The serial column is
 *     rendered only for a group that actually has a serial-tracked variant. A
 *     column of empty cells reads as missing data and is exactly the pressure
 *     that produces fake 'N/A' serials (requirements 12).
 */

export interface RollupVariant {
  id: string;
  sku: string;
  name: string;
  quantity: number;
  variantSize: string | null;
  variantSizeSystem: string | null;
  variantWidth: string | null;
  variantColor: string | null;
  jerseyNumber: string | null;
  trackingType: 'none' | 'lot' | 'serial' | 'serial_optional';
  unitOfMeasure: string | null;
  status: 'active' | 'archived' | 'discontinued';
}

export interface RollupGroup {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
  styleNumber: string | null;
  team: string | null;
  subcategoryKey: string | null;
  trackingMode: string | null;
  countingUnit: CountingUnit;
  /** From the roll-up VIEW — the whole group, not the rows below. */
  variantCount: number;
  totalQuantity: number;
  /** Already size-ordered by the server, which holds the authored size scale. */
  variants: RollupVariant[];
}

/** True when a group has any variant that really carries serials. */
function hasSerials(variants: readonly RollupVariant[]): boolean {
  return variants.some((v) => v.trackingType === 'serial' || v.trackingType === 'serial_optional');
}

const TRACKING_TYPE_LABELS: Record<RollupVariant['trackingType'], string> = {
  none: 'Quantity',
  lot: 'Lot',
  serial: 'Serial',
  serial_optional: 'Serial optional',
};

export function ProductGroupRollupList({ groups }: { groups: RollupGroup[] }) {
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set<string>());

  const toggle = React.useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="border-border divide-border divide-y rounded-lg border">
      {groups.map((g) => (
        <GroupRow key={g.id} group={g} expanded={expanded.has(g.id)} onToggle={() => toggle(g.id)} />
      ))}
    </div>
  );
}

function GroupRow({
  group,
  expanded,
  onToggle,
}: {
  group: RollupGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  // "6 variants · 52 pairs total". The unit is READ from the group; PAIR is a
  // display convention with no conversion behind it, so a surface that guessed
  // would print a number meaning something other than what the group says.
  const rollup = groupRollupLabel(
    group.variantCount,
    group.totalQuantity,
    countingUnitLabel(group.countingUnit, group.totalQuantity),
  );
  const identity = [group.brand, group.model, group.styleNumber, group.team]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join(' · ');
  const showSerialColumn = hasSerials(group.variants);
  const modeLabel =
    group.trackingMode && group.trackingMode in TRACKING_MODE_LABELS
      ? TRACKING_MODE_LABELS[group.trackingMode as TrackingMode]
      : null;

  return (
    <div>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.name} (${rollup})`}
          className="hover:bg-muted hover:text-foreground mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-sm text-[var(--ed-ink-3)] transition-colors"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13.5px] font-medium">{group.name}</span>
            {/* The tracking mode is admin-facing detail; this whole route is
                gated on sports:manage, so it belongs here and nowhere on the
                ordinary inventory list. */}
            {modeLabel && (
              <span className="border-border shrink-0 rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--ed-ink-3)]">
                {modeLabel}
              </span>
            )}
          </div>
          {identity && (
            <p className="truncate text-[11.5px] text-[var(--ed-ink-4)]">{identity}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[12.5px] font-medium tabular-nums">{rollup}</p>
          <p className="text-[11.5px] text-[var(--ed-ink-4)]">
            Added up from this group&rsquo;s variants
          </p>
        </div>
      </div>

      {expanded && (
        <div className="border-border bg-muted/20 overflow-x-auto border-t">
          {group.variants.length === 0 ? (
            <p className="px-10 py-3 text-[12px] text-[var(--ed-ink-4)]">
              No items are linked to this group yet.
            </p>
          ) : (
            <table className="w-full min-w-[560px] text-[12px]">
              <thead className="text-[var(--ed-ink-4)]">
                <tr className="border-border border-b">
                  <th className="py-1.5 pl-10 pr-3 text-left font-medium">Variant</th>
                  <th className="px-3 text-left font-medium">SKU</th>
                  <th className="px-3 text-left font-medium">Tracking</th>
                  {/* Rendered ONLY when a variant genuinely has serials. */}
                  {showSerialColumn && (
                    <th className="px-3 text-left font-medium">Serials</th>
                  )}
                  <th className="px-3 text-right font-medium">On hand</th>
                </tr>
              </thead>
              <tbody>
                {group.variants.map((v) => {
                  const label =
                    variantLabel({
                      jerseyNumber: v.jerseyNumber,
                      size: v.variantSize,
                      width: v.variantWidth,
                      color: v.variantColor,
                    }) ?? v.name;
                  const serialTracked =
                    v.trackingType === 'serial' || v.trackingType === 'serial_optional';
                  return (
                    <tr key={v.id} className="border-border border-b last:border-0">
                      <td className="py-1.5 pl-10 pr-3">
                        <Link
                          href={`/dashboard/inventory/${v.id}`}
                          prefetch={false}
                          className="font-medium hover:underline"
                        >
                          {label}
                        </Link>
                        {v.variantSizeSystem && (
                          <span className="ml-1.5 text-[10.5px] text-[var(--ed-ink-4)]">
                            {v.variantSizeSystem.replace(/_/g, ' ')}
                          </span>
                        )}
                        {v.status !== 'active' && (
                          <span className="ml-1.5 text-[10.5px] text-[var(--ed-ink-4)]">
                            {v.status}
                          </span>
                        )}
                      </td>
                      <td className="px-3 font-mono text-[11px] text-[var(--ed-ink-3)]">{v.sku}</td>
                      <td className="px-3 text-[var(--ed-ink-3)]">
                        {TRACKING_TYPE_LABELS[v.trackingType]}
                      </td>
                      {showSerialColumn && (
                        <td className="px-3 text-[var(--ed-ink-3)]">
                          {serialTracked ? (
                            <Link
                              href={`/dashboard/inventory/${v.id}`}
                              prefetch={false}
                              className="hover:underline"
                            >
                              View
                            </Link>
                          ) : (
                            // A quantity variant has no serial and never gets a
                            // stand-in. An em dash says "not applicable"; 'N/A'
                            // or '0000' would be a fake record.
                            <span aria-label="Not serial tracked">&mdash;</span>
                          )}
                        </td>
                      )}
                      <td className="px-3 text-right tabular-nums">
                        {formatNumber(v.quantity)}{' '}
                        <span className="text-[10.5px] text-[var(--ed-ink-4)]">
                          {countingUnitLabel(group.countingUnit, v.quantity)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
