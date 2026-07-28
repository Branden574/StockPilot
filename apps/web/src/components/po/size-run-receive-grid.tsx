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

  return (
    <div className="rounded-md border" data-testid="size-run" data-group-id={groupId}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b px-3 py-2">
        <div>
          <p className="font-medium">{group.name}</p>
          <p className="text-muted-foreground text-xs">
            Size run · {lines.length} sizes · {totalOrdered}{' '}
            {countingUnitLabel(group.countingUnit, totalOrdered)} ordered
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={receiveAllOrdered}>
          Receive all ordered
        </Button>
      </div>

      <div className="text-muted-foreground grid grid-cols-12 gap-2 px-3 pt-2 text-[11px] font-medium">
        <div className="col-span-2">Size</div>
        <div className="col-span-2 text-right">Ordered</div>
        <div className="col-span-2 text-right">Already</div>
        <div className="col-span-3">Receiving</div>
        <div className="col-span-2 text-right">Accepted</div>
        <div className="col-span-1 text-right">Rejected</div>
      </div>

      <div className="divide-y">
        {lines.map((l) => {
          const received = receivedOf(l.id);
          return (
            <div key={l.id} className="px-3 py-2" data-testid="size-run-row">
              <div className="grid grid-cols-12 items-center gap-2">
                <div className="col-span-2">
                  <p className="font-medium tabular-nums" data-testid="size-run-size">
                    {l.variantSize?.trim() ? l.variantSize : 'No size'}
                  </p>
                  <p className="text-muted-foreground truncate font-mono text-[11px]">{l.sku}</p>
                </div>
                <div className="col-span-2 text-right tabular-nums" data-testid="size-run-ordered">
                  {l.quantityOrdered}
                </div>
                <div className="col-span-2 text-right tabular-nums" data-testid="size-run-already">
                  {l.quantityReceived}
                </div>
                <div className="col-span-3">
                  <BlankZeroNumberInput
                    min={0}
                    step={1}
                    aria-label={`Receiving size ${l.variantSize ?? l.sku}`}
                    value={received}
                    onValueChange={(v) => onChange(l.id, { received: Math.max(0, v) })}
                  />
                </div>
                <div
                  className="col-span-2 text-right tabular-nums"
                  data-testid="size-run-accepted"
                >
                  {received}
                </div>
                <div
                  className="text-muted-foreground col-span-1 text-right tabular-nums"
                  data-testid="size-run-rejected"
                >
                  0
                </div>
              </div>
              {renderExtras?.(l)}
            </div>
          );
        })}
      </div>

      <div className="bg-muted/30 border-t px-3 py-2 text-xs" data-testid="size-run-subtotal">
        {subtotal.sizes === 0 ? (
          <span className="text-muted-foreground">
            Nothing entered yet for this run.
          </span>
        ) : (
          <span className="font-medium">
            Receiving {subtotal.quantity}{' '}
            {countingUnitLabel(group.countingUnit, subtotal.quantity)} across{' '}
            {subtotal.sizes} {subtotal.sizes === 1 ? 'size' : 'sizes'}
          </span>
        )}
      </div>
    </div>
  );
}
