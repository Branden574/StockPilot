'use client';

import * as React from 'react';

import {
  countingUnitLabel,
  splitIntoSizeRuns,
  type CountingUnit,
  type SizeOrderIndex,
  type SizeRunBlock,
} from '@stockpilot/core';

import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A PO receive line, plus the two variant columns that make a size run
 * expressible. Both are NULL on every line in every non-sports org.
 */
export interface ReceiveRunLine {
  id: string;
  name: string;
  sku: string;
  quantityOrdered: number;
  quantityReceived: number;
  trackingType: 'none' | 'lot' | 'serial' | 'serial_optional';
  /** `inventory_items.group_id` (0298). NULL = an ordinary standalone line. */
  groupId: string | null;
  /** `inventory_items.variant_size` (0298). */
  variantSize: string | null;
}

/** Display metadata for one product group, resolved server-side. */
export interface SizeRunGroup {
  name: string;
  /**
   * `product_groups.default_counting_unit`. READ, never inferred — PAIR is a
   * display convention and there is no conversion anywhere (requirements 5).
   */
  countingUnit: CountingUnit;
  /** The group's size scale order, when its category carries one. */
  sizeOrder?: SizeOrderIndex | null;
}

/** What the dialog knows about a line mid-edit. Only `received` matters here. */
interface RunEntry {
  received: number;
}

/** One rendered block: either a size run, or a line that stands on its own. */
export type ReceiveBlock = SizeRunBlock<ReceiveRunLine>;

/**
 * Group receive lines by product group so a size run reads as one block with
 * per-size ordered/received, instead of N unrelated rows.
 *
 * Lines whose item has no `group_id` fall through to the existing flat
 * renderer untouched, which is every line for every non-sports org.
 *
 * The grouping RULE itself lives in `@stockpilot/core` so web and Expo can
 * never disagree about what a run is; this wrapper only resolves each group's
 * size order out of the display map the page loaded.
 */
export function splitIntoRuns(
  lines: readonly ReceiveRunLine[],
  groups: Readonly<Record<string, SizeRunGroup>> = {},
): ReceiveBlock[] {
  return splitIntoSizeRuns(lines, (groupId) => groups[groupId]?.sizeOrder);
}

/** Outstanding quantity for one size. Never negative — over-receipt is allowed
 *  (mig 0285) but "receive all ordered" must not propose a negative fill. */
function outstanding(l: ReceiveRunLine): number {
  return Math.max(0, l.quantityOrdered - l.quantityReceived);
}

/**
 * Variance for one size: what's left after THIS receipt is posted. Positive =
 * still outstanding, zero = fully received, negative = over-received. Unlike
 * `outstanding`, this is NOT clamped — a negative value is the signal that
 * over-receipt happened (mig 0285 allows it) and the run rows must show it
 * exactly like the flat renderer does.
 */
function variance(l: ReceiveRunLine, entered: number): number {
  return l.quantityOrdered - l.quantityReceived - entered;
}

/**
 * The variance tone, shared with the receive dialog's flat rows: caution while
 * stock is still to come, danger past what was ordered, success once fully
 * received. The tokens hold their contrast in both themes (the fixed amber and
 * emerald did not), and the figure's sign and the flat row's caption say the
 * same in words, so colour is never the only cue.
 */
export function varianceToneClass(v: number): string {
  if (v > 0) return 'text-warning';
  if (v < 0) return 'text-destructive';
  return 'text-success';
}

/**
 * One figure of a size row. Wider than a phone the grid's column labels name
 * it; on a phone, where the row stacks, it carries its own label above it.
 * The figure keeps its own element (and test id) apart from that label.
 */
function RunFigure({
  label,
  testId,
  className,
  valueClassName,
  children,
}: {
  label: string;
  testId: string;
  className?: string;
  valueClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <span className="text-muted-foreground block text-[11px] leading-4 sm:hidden">{label}</span>
      <span
        className={cn('block font-mono text-[12.5px] tabular-nums', valueClassName)}
        data-testid={testId}
      >
        {children}
      </span>
    </div>
  );
}

export interface SizeRunReceiveGridProps {
  groupId: string;
  group: SizeRunGroup;
  /** Already sorted by `splitIntoRuns`; rendered in the order given. */
  lines: readonly ReceiveRunLine[];
  entries: Readonly<Record<string, RunEntry>>;
  onChange: (lineId: string, patch: { received: number }) => void;
  /**
   * Per-size slot for the dialog's lot / serial capture panels, so a `serial`
   * item inside a run keeps exactly the capture UI it has outside one.
   */
  renderExtras?: (line: ReceiveRunLine) => React.ReactNode;
}

/**
 * One size run: a heading, one row per size, and a subtotal in the group's own
 * counting unit.
 *
 * Each size still posts as its own `p_lines` entry — this component only
 * changes how the rows are LAID OUT. `post_receipt_v2` sees exactly the
 * recordset it sees today, which is why Task 16 needs no migration and no RPC
 * change on the sixth rewrite of the most prod-hardened seam in the app.
 *
 * Accepted and Rejected are shown DERIVED (accepted = what you entered,
 * rejected = 0), matching the flat renderer's long-standing behaviour:
 * everything you receive goes into usable stock and the dialog does not ask
 * for a split. Making them editable here and nowhere else would give a size
 * run a rejection workflow the rest of receiving does not have.
 */
export function SizeRunReceiveGrid({
  groupId,
  group,
  lines,
  entries,
  onChange,
  renderExtras,
}: SizeRunReceiveGridProps) {
  const receivedOf = React.useCallback(
    (id: string) => Math.max(0, entries[id]?.received ?? 0),
    [entries],
  );

  const subtotal = React.useMemo(() => {
    let quantity = 0;
    let sizes = 0;
    for (const l of lines) {
      const r = receivedOf(l.id);
      if (r <= 0) continue;
      quantity += r;
      sizes += 1;
    }
    return { quantity, sizes };
  }, [lines, receivedOf]);

  function receiveAllOrdered() {
    for (const l of lines) onChange(l.id, { received: outstanding(l) });
  }

  const totalOrdered = lines.reduce((s, l) => s + l.quantityOrdered, 0);

  // One card per run (the grouped rows of the Items list, X-SEL): the run's
  // name and size count in its header with Receive all ordered, then one row
  // per size and the subtotal. Wider than a phone the sizes form the seven
  // columns under their labels; on a phone each size stacks (size, ordered and
  // already, the field, then accepted, rejected and variance, each labelled),
  // so every figure stays on screen without scrolling sideways.
  return (
    <div
      className="border-border bg-card overflow-hidden rounded-lg border"
      data-testid="size-run"
      data-group-id={groupId}
    >
      <div className="border-border flex flex-wrap items-start justify-between gap-2 border-b px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium leading-5 [overflow-wrap:anywhere]">
            {group.name}
          </p>
          <p className="text-muted-foreground text-[12px] leading-[18px]">
            Size run · {lines.length} sizes · {totalOrdered}{' '}
            {countingUnitLabel(group.countingUnit, totalOrdered)} ordered
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={receiveAllOrdered}>
          Receive all ordered
        </Button>
      </div>

      <div className="text-muted-foreground hidden grid-cols-12 gap-2 px-3 pt-2 text-[11px] font-medium uppercase leading-[16.5px] tracking-[0.06em] sm:grid">
        <div className="col-span-2">Size</div>
        <div className="col-span-1 text-right">Ordered</div>
        <div className="col-span-1 text-right">Already</div>
        <div className="col-span-3">Receiving</div>
        <div className="col-span-1 text-right">Accepted</div>
        <div className="col-span-1 text-right">Rejected</div>
        <div className="col-span-3 text-right">Variance</div>
      </div>

      <div className="divide-border divide-y">
        {lines.map((l) => {
          const received = receivedOf(l.id);
          const lineVariance = variance(l, received);
          return (
            <div key={l.id} className="px-3 py-2" data-testid="size-run-row">
              <div className="grid grid-cols-6 items-end gap-2 sm:grid-cols-12 sm:items-center">
                <div className="col-span-6 min-w-0 sm:col-span-2">
                  <p className="font-medium tabular-nums" data-testid="size-run-size">
                    {l.variantSize?.trim() ? l.variantSize : 'No size'}
                  </p>
                  <p className="text-muted-foreground truncate font-mono text-[11px]">{l.sku}</p>
                </div>
                <RunFigure
                  label="Ordered"
                  testId="size-run-ordered"
                  className="col-span-3 sm:col-span-1 sm:text-right"
                >
                  {l.quantityOrdered}
                </RunFigure>
                <RunFigure
                  label="Already"
                  testId="size-run-already"
                  className="col-span-3 sm:col-span-1 sm:text-right"
                >
                  {l.quantityReceived}
                </RunFigure>
                <div className="col-span-6 min-w-0 sm:col-span-3">
                  <span
                    aria-hidden="true"
                    className="text-muted-foreground mb-1 block text-[11px] leading-4 sm:hidden"
                  >
                    Receiving
                  </span>
                  <BlankZeroNumberInput
                    min={0}
                    step={1}
                    aria-label={`Receiving size ${l.variantSize ?? l.sku}`}
                    value={received}
                    onValueChange={(v) => onChange(l.id, { received: Math.max(0, v) })}
                    className="font-mono"
                  />
                </div>
                <RunFigure
                  label="Accepted"
                  testId="size-run-accepted"
                  className="col-span-2 sm:col-span-1 sm:text-right"
                >
                  {received}
                </RunFigure>
                <RunFigure
                  label="Rejected"
                  testId="size-run-rejected"
                  className="col-span-2 sm:col-span-1 sm:text-right"
                  valueClassName="text-muted-foreground"
                >
                  0
                </RunFigure>
                <RunFigure
                  label="Variance"
                  testId="size-run-variance"
                  className="col-span-2 sm:col-span-3 sm:text-right"
                  valueClassName={varianceToneClass(lineVariance)}
                >
                  {lineVariance}
                </RunFigure>
              </div>
              {renderExtras?.(l)}
            </div>
          );
        })}
      </div>

      <div
        className="border-border bg-sunk border-t px-3 py-2 text-[12px] leading-[18px]"
        data-testid="size-run-subtotal"
      >
        {subtotal.sizes === 0 ? (
          <span className="text-muted-foreground">Nothing entered yet for this run.</span>
        ) : (
          <span className="font-medium">
            Receiving {subtotal.quantity} {countingUnitLabel(group.countingUnit, subtotal.quantity)}{' '}
            across {subtotal.sizes} {subtotal.sizes === 1 ? 'size' : 'sizes'}
          </span>
        )}
      </div>
    </div>
  );
}
