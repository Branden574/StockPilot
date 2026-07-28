'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  countingUnitLabel,
  groupRollupLabel,
  variantLabel,
  TRACKING_MODE_LABELS,
  type CountingUnit,
  type TrackingMode,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn, formatNumber } from '@/lib/utils';
import { unlinkItemsAction } from '@/server/actions/product-group-linking';
import { loadGroupVariantsAction, type GroupVariantRow } from '@/server/actions/product-groups';

/**
 * The product-groups roll-up list: one collapsed row per group, expanding to
 * its variants in size order.
 *
 * Three rules this component exists to hold:
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
 *  3. **Variants load WHEN A GROUP IS OPENED.** A collapsed page needs no
 *     variant rows — every number on it is a server-side aggregate — so it
 *     reads none. One group's rows are fetched by `loadGroupVariantsAction`
 *     the first time a human expands it and then kept for the visit.
 *
 * Unlink lives on the variant row because that is where the mistake is
 * visible: the reviewer sees a size that does not belong to this product and
 * takes it out. It is the exact undo of the linking tool's Link — a reason is
 * required, it is audited, and it never touches stock.
 */

export type RollupVariant = GroupVariantRow;

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
  const router = useRouter();
  // null = never loaded. Loading is per group and happens once per visit.
  const [variants, setVariants] = React.useState<RollupVariant[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [unlinking, setUnlinking] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const load = React.useCallback(() => {
    setLoading(true);
    setLoadError(null);
    startTransition(async () => {
      const res = await loadGroupVariantsAction(group.id);
      setLoading(false);
      if (!res.ok) {
        setLoadError(res.error.message);
        return;
      }
      setVariants(res.data.variants);
    });
  }, [group.id]);

  // Fetch from the CLICK, not from an effect: opening a group is the event,
  // and an effect that setState()s on render just adds a cascading render to
  // say the same thing. A collapsed group costs nothing; a second expand
  // re-reads nothing (the rows are already here).
  function handleToggle() {
    if (!expanded && variants === null && !loading) load();
    onToggle();
  }

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
  const showSerialColumn = hasSerials(variants ?? []);
  const modeLabel =
    group.trackingMode && group.trackingMode in TRACKING_MODE_LABELS
      ? TRACKING_MODE_LABELS[group.trackingMode as TrackingMode]
      : null;

  function unlink(itemId: string, reason: string) {
    startTransition(async () => {
      const res = await unlinkItemsAction({ itemIds: [itemId], reason });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      // Drop the row locally so the expansion agrees with what just happened;
      // the header's figures come from the roll-up view, so refresh re-reads
      // them rather than this component guessing at the new total.
      setVariants((prev) => (prev ? prev.filter((v) => v.id !== itemId) : prev));
      setUnlinking(null);
      toast.success('Item unlinked from this product group.');
      router.refresh();
    });
  }

  return (
    <div>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={handleToggle}
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
          {loading || variants === null ? (
            loadError ? (
              <div className="flex flex-wrap items-center gap-2 px-10 py-3 text-[12px] text-[var(--ed-ink-3)]">
                <span>{loadError}</span>
                <Button type="button" variant="outline" size="sm" onClick={load}>
                  Try again
                </Button>
              </div>
            ) : (
              <p className="px-10 py-3 text-[12px] text-[var(--ed-ink-4)]">Loading variants…</p>
            )
          ) : variants.length === 0 ? (
            <p className="px-10 py-3 text-[12px] text-[var(--ed-ink-4)]">
              No items are linked to this group yet.
            </p>
          ) : (
            <table className="w-full min-w-[640px] text-[12px]">
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
                  <th className="px-3 pr-4 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {variants.map((v) => {
                  const label =
                    variantLabel({
                      jerseyNumber: v.jerseyNumber,
                      size: v.variantSize,
                      width: v.variantWidth,
                      color: v.variantColor,
                    }) ?? v.name;
                  const serialTracked =
                    v.trackingType === 'serial' || v.trackingType === 'serial_optional';
                  const columns = showSerialColumn ? 6 : 5;
                  return (
                    <React.Fragment key={v.id}>
                      <tr className="border-border border-b last:border-0">
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
                        <td className="px-3 pr-4 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => setUnlinking(unlinking === v.id ? null : v.id)}
                            aria-label={`Unlink ${label} from ${group.name}`}
                          >
                            Unlink
                          </Button>
                        </td>
                      </tr>
                      {unlinking === v.id && (
                        <tr className="border-border bg-background border-b last:border-0">
                          <td colSpan={columns} className="py-2 pl-10 pr-4">
                            <UnlinkRow
                              label={label}
                              pending={pending}
                              onCancel={() => setUnlinking(null)}
                              onConfirm={(reason) => unlink(v.id, reason)}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
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

/**
 * The unlink confirmation. A reason is REQUIRED for the same reason the link
 * needed one: the audit trail has to answer why an identity changed, and "the
 * tool did it" is not an answer.
 */
function UnlinkRow({
  label,
  pending,
  onCancel,
  onConfirm,
}: {
  label: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState('');
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-1 flex-col gap-1 text-[11.5px] text-[var(--ed-ink-3)]">
        Why is {label} not part of this product? (required — it is stored on the audit trail)
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Different style, grouped by mistake"
          aria-label={`Reason for unlinking ${label}`}
          className="h-8 text-[12px]"
        />
      </label>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
        Cancel
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={pending || reason.trim().length === 0}
        onClick={() => onConfirm(reason.trim())}
      >
        {pending ? 'Unlinking…' : 'Confirm unlink'}
      </Button>
    </div>
  );
}
