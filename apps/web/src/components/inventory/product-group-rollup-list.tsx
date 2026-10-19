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
import {
  archiveProductGroupAction,
  loadGroupVariantsAction,
  restoreProductGroupAction,
  type GroupVariantRow,
} from '@/server/actions/product-groups';

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
 *
 * Archive lives on the GROUP row, for the same reason: the group is the thing
 * being retired. It is SOFT and reversible (`status = 'archived'`, never a
 * delete), it is audited, and it never touches stock either — so unlike Unlink
 * it asks for no reason, only a confirmation. A group whose sizes are still
 * linked is REFUSED by the server, and the refusal becomes an explicit
 * "Archive anyway" here rather than a dead-end toast (the same shape the bulk
 * item archive uses for its stock guard). The archived view swaps the control
 * for Restore.
 */

export type RollupVariant = GroupVariantRow;

/** A variant-table header cell: 11 px uppercase in the quiet ink (DESIGN-SPEC 6.9). */
const TH = 'whitespace-nowrap px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.06em]';

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

export function ProductGroupRollupList({
  groups,
  /**
   * True when this list is the ARCHIVED view. It changes one thing: the group
   * row offers Restore instead of Archive. The page decides which set of rows it
   * asked the server for; this component never mixes the two.
   */
  archived = false,
}: {
  groups: RollupGroup[];
  archived?: boolean;
}) {
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
    // The table-card language (DESIGN-SPEC 6.9 and 6.21): one card, a row per
    // group in the group-header recipe, hairlines between.
    <div
      data-slot="product-group-list"
      className="border-border bg-card divide-border divide-y overflow-hidden rounded-lg border"
    >
      {groups.map((g) => (
        <GroupRow
          key={g.id}
          group={g}
          archived={archived}
          expanded={expanded.has(g.id)}
          onToggle={() => toggle(g.id)}
        />
      ))}
    </div>
  );
}

function GroupRow({
  group,
  archived,
  expanded,
  onToggle,
}: {
  group: RollupGroup;
  archived: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const router = useRouter();
  // null = never loaded. Loading is per group and happens once per visit.
  const [variants, setVariants] = React.useState<RollupVariant[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [unlinking, setUnlinking] = React.useState<string | null>(null);
  // null = the archive strip is closed. `{ blocked: null }` = asking for a plain
  // confirmation. `{ blocked: <server message> }` = the variant guard refused,
  // so the strip now shows what it said and offers the explicit override.
  const [archiving, setArchiving] = React.useState<{ blocked: string | null } | null>(null);
  // Which lifecycle write is in flight, for the LABELS only. `pending` covers
  // every transition on this row (an expansion, an unlink), so using it to word a
  // button would make Restore say "Restoring…" because something else was busy.
  // Disabling still keys off `pending` — any in-flight write should block them
  // all.
  const [busy, setBusy] = React.useState<'archive' | 'restore' | null>(null);
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
        // A conflict can follow a write (the item left, but its SKU's record
        // on another rack could not follow): read the rows and header again.
        if (res.error.code === 'conflict') {
          setUnlinking(null);
          load();
          router.refresh();
        }
        return;
      }
      // Drop the row locally so the expansion agrees with what just happened;
      // the header's figures come from the roll-up view, so refresh re-reads
      // them rather than this component guessing at the new total.
      // The other racks' records of its SKU left the family with it (owner
      // 2026-10-12, "Move them together"): their rows go too, and it is said.
      const others = new Set(res.data.skuSiblingIds);
      setVariants((prev) =>
        prev ? prev.filter((v) => v.id !== itemId && !others.has(v.id)) : prev,
      );
      setUnlinking(null);
      const n = others.size;
      toast.success(
        n > 0
          ? `Item unlinked from this product group, with ${n} other record${n === 1 ? '' : 's'} of its SKU (the same size on another rack).`
          : 'Item unlinked from this product group.',
      );
      router.refresh();
    });
  }

  function archive(acknowledgeActiveVariants: boolean) {
    setBusy('archive');
    startTransition(async () => {
      const res = await archiveProductGroupAction(
        group.id,
        acknowledgeActiveVariants ? { acknowledgeActiveVariants: true } : {},
      );
      setBusy(null);
      if (!res.ok) {
        // The variant guard is the ONLY validation_error this action raises, so
        // a validation_error on a non-acknowledged attempt is unambiguously
        // "sizes are still linked to this group". Show what the server said and
        // offer the override, rather than a toast the operator cannot act on.
        if (!acknowledgeActiveVariants && res.error.code === 'validation_error') {
          setArchiving({ blocked: res.error.message });
          return;
        }
        toast.error(res.error.message);
        return;
      }
      setArchiving(null);
      // The row leaves this list on refresh (the page asked the server for
      // active groups), so the toast has to say where it went.
      toast.success('Product group archived. It is in the archived view if you need it back.');
      router.refresh();
    });
  }

  function restore() {
    setBusy('restore');
    startTransition(async () => {
      const res = await restoreProductGroupAction(group.id);
      setBusy(null);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success('Product group restored.');
      router.refresh();
    });
  }

  return (
    <div>
      <div
        data-slot="product-group-row"
        className={cn(
          'hover:bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors sm:flex-nowrap',
          expanded && 'bg-sunk hover:bg-sunk',
        )}
      >
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.name} (${rollup})`}
          // The group-header chevron: 24 x 24, radius 6, a 14 px chevron that
          // turns a quarter when the group is open (44 px to touch below sm).
          className="text-muted-foreground hover:bg-muted hover:text-foreground relative grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors before:absolute before:left-1/2 before:top-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-none max-sm:before:content-[''] pointer-coarse:before:content-['']"
        >
          <ChevronRight
            aria-hidden
            strokeWidth={1.8}
            className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')}
          />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-[13.5px] font-medium">{group.name}</span>
            {/* The tracking mode is admin-facing detail; this whole route is
                gated on sports:manage, so it belongs here and nowhere on the
                ordinary inventory list. */}
            {modeLabel && (
              <span className="border-line-strong text-muted-foreground shrink-0 rounded-full border px-1.5 text-[11px] leading-[18px]">
                {modeLabel}
              </span>
            )}
          </div>
          {identity && (
            <p className="text-muted-foreground truncate text-[12px]">{identity}</p>
          )}
        </div>
        {/* On a phone the roll-up and the action drop under the name,
            indented to it; from sm up they sit on the row's right. */}
        <div className="ml-9 min-w-0 text-left sm:ml-0 sm:shrink-0 sm:text-right">
          <p className="text-[13px] font-medium tabular-nums">{rollup}</p>
          <p className="text-muted-foreground text-[12px]">
            Added up from this group&rsquo;s variants
          </p>
        </div>
        <div className="ml-auto shrink-0 sm:ml-0">
          {archived ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={restore}
              aria-label={`Restore ${group.name}`}
            >
              {busy === 'restore' ? 'Restoring…' : 'Restore'}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setArchiving(archiving ? null : { blocked: null })}
              aria-label={`Archive ${group.name}`}
            >
              Archive
            </Button>
          )}
        </div>
      </div>

      {archiving && (
        <div className="border-border bg-sunk border-t py-3 pl-4 pr-4 sm:pl-[52px]">
          <ArchiveRow
            groupName={group.name}
            blocked={archiving.blocked}
            pending={pending}
            archivingNow={busy === 'archive'}
            onCancel={() => setArchiving(null)}
            onConfirm={() => archive(archiving.blocked !== null)}
          />
        </div>
      )}

      {expanded && (
        // The nested member rows: the card surface under the open header, the
        // first column indented so a variant sits under its group's name.
        <div className="border-border bg-card overflow-x-auto border-t">
          {loading || variants === null ? (
            loadError ? (
              <div
                role="alert"
                className="text-destructive flex flex-wrap items-center gap-2 py-3 pl-4 pr-4 text-[12.5px] sm:pl-[52px]"
              >
                <span>{loadError}</span>
                <Button type="button" variant="outline" size="sm" onClick={load}>
                  Try again
                </Button>
              </div>
            ) : (
              <p
                role="status"
                className="text-muted-foreground py-3 pl-4 pr-4 text-[12.5px] sm:pl-[52px]"
              >
                Loading variants…
              </p>
            )
          ) : variants.length === 0 ? (
            <p className="text-muted-foreground py-3 pl-4 pr-4 text-[12.5px] sm:pl-[52px]">
              No items are linked to this group yet.
            </p>
          ) : (
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="text-muted-foreground">
                <tr className="border-border border-b">
                  <th className={cn(TH, 'pl-4 text-left sm:pl-[52px]')}>Variant</th>
                  <th className={cn(TH, 'text-left')}>SKU</th>
                  <th className={cn(TH, 'text-left')}>Tracking</th>
                  {/* Rendered ONLY when a variant genuinely has serials. */}
                  {showSerialColumn && <th className={cn(TH, 'text-left')}>Serials</th>}
                  <th className={cn(TH, 'text-right')}>On hand</th>
                  <th className={cn(TH, 'pr-4 text-right')}>
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
                      <tr className="border-border hover:bg-muted/60 border-b transition-colors last:border-0">
                        <td className="py-2 pl-4 pr-3 sm:pl-[52px]">
                          <Link
                            href={`/dashboard/inventory/${v.id}`}
                            prefetch={false}
                            className="font-medium hover:underline"
                          >
                            {label}
                          </Link>
                          {v.variantSizeSystem && (
                            <span className="text-muted-foreground ml-1.5 text-[11px]">
                              {v.variantSizeSystem.replace(/_/g, ' ')}
                            </span>
                          )}
                          {v.status !== 'active' && (
                            <span className="text-muted-foreground ml-1.5 text-[11px]">
                              {v.status}
                            </span>
                          )}
                        </td>
                        <td className="text-muted-foreground px-3 font-mono text-[12px]">{v.sku}</td>
                        <td className="text-muted-foreground px-3">
                          {TRACKING_TYPE_LABELS[v.trackingType]}
                        </td>
                        {showSerialColumn && (
                          <td className="text-muted-foreground px-3">
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
                          <span className="text-muted-foreground text-[11px]">
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
                        <tr className="border-border bg-sunk border-b last:border-0">
                          <td colSpan={columns} className="py-2.5 pl-4 pr-4 sm:pl-[52px]">
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
 * The archive confirmation, in the same inline strip Unlink uses.
 *
 * TWO STATES, and the second one is the point. `blocked === null` is the plain
 * "archive this group?" confirmation. Once the server has refused because the
 * group still has variants linked, `blocked` carries the server's own sentence —
 * which names the count — and the confirm becomes an explicit "Archive anyway".
 * The refusal is never re-worded here: the number in it is the server's, and a
 * client-side paraphrase would be one more thing that can drift out of date.
 *
 * NO REASON FIELD, unlike Unlink. Unlinking rewrites an item's identity, which
 * the audit trail has to be able to explain; archiving hides a group and changes
 * nothing else, and Restore puts it back exactly as it was.
 */
function ArchiveRow({
  groupName,
  blocked,
  pending,
  archivingNow,
  onCancel,
  onConfirm,
}: {
  groupName: string;
  blocked: string | null;
  /** Any write on this row is in flight — the buttons are disabled either way. */
  pending: boolean;
  /** THIS archive is the write in flight — only then does the label change. */
  archivingNow: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <p className="text-muted-foreground max-w-xl flex-1 text-[12.5px]">
        {blocked ??
          `Archive ${groupName}? It leaves the product-groups list and stops being offered when ` +
            'items are linked. Its variants keep their stock and stay where they are, and you can ' +
            'restore the group from the archived view.'}
      </p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant={blocked ? 'destructive' : 'default'}
          disabled={pending}
          onClick={onConfirm}
          aria-label={
            blocked
              ? `Archive ${groupName} anyway, with its variants still linked`
              : `Confirm archive of ${groupName}`
          }
        >
          {archivingNow ? 'Archiving…' : blocked ? 'Archive anyway' : 'Confirm archive'}
        </Button>
      </div>
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
      <label className="text-muted-foreground flex min-w-[220px] flex-1 flex-col gap-1 text-[12.5px]">
        Why is {label} not part of this product? (required — it is stored on the audit trail)
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Different style, grouped by mistake"
          aria-label={`Reason for unlinking ${label}`}
          className="text-foreground"
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
