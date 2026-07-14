import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  ClipboardCheck,
  Edit3,
  History,
  PackageMinus,
  PackagePlus,
  Plus,
  RefreshCcw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import { cn, formatNumber, formatRelative } from '@/lib/utils';

import type { ActivityEvent } from '@/server/services/activity';

interface ActivityFeedProps {
  events: ActivityEvent[];
  /**
   * Optional location id → display name map. When provided, transfer events
   * render their route ("A → B") in the meta line. item-detail already holds
   * the org's full location list for the transfer dialog, so the map is free.
   */
  locationNames?: Record<string, string>;
}

interface VisualSpec {
  Icon: LucideIcon;
  label: string;
  tone: 'pos' | 'neg' | 'neutral' | 'warn';
}

function specFor(e: ActivityEvent): VisualSpec {
  if (e.kind === 'movement') {
    const delta = e.delta ?? 0;
    if (e.type === 'transfer') {
      return { Icon: ArrowRightLeft, label: 'Stock transferred', tone: 'neutral' };
    }
    if (e.type === 'cycle_count') {
      return { Icon: ClipboardCheck, label: 'Cycle count posted', tone: 'neutral' };
    }
    // NB: the receipt writer (post_receipt_v2 → adjust_stock) records
    // movement_type='receive_po' — 'receipt' was a dead branch.
    if (e.type === 'receive_po' || delta > 0) {
      return { Icon: PackagePlus, label: 'Stock received', tone: 'pos' };
    }
    if (delta < 0) {
      return { Icon: PackageMinus, label: 'Stock removed', tone: 'neg' };
    }
    return { Icon: RefreshCcw, label: 'Stock adjusted', tone: 'neutral' };
  }

  switch (e.type) {
    case 'inventory.item.created':
      return { Icon: Plus, label: 'Item created', tone: 'pos' };
    case 'inventory.item.updated':
      return { Icon: Edit3, label: 'Item edited', tone: 'neutral' };
    case 'inventory.item.archived':
      return { Icon: Archive, label: 'Item archived', tone: 'warn' };
    case 'inventory.item.restored':
      return { Icon: ArchiveRestore, label: 'Item restored', tone: 'pos' };
    case 'inventory.item.deleted':
      return { Icon: Trash2, label: 'Item deleted', tone: 'neg' };
    case 'item.tracking_type.changed':
      return { Icon: RefreshCcw, label: 'Tracking changed', tone: 'neutral' };
    default:
      return { Icon: History, label: e.type.replace(/\./g, ' '), tone: 'neutral' };
  }
}

export function ActivityFeed({ events, locationNames }: ActivityFeedProps) {
  if (events.length === 0) {
    return (
      <div className="text-muted-foreground py-10 text-center text-sm">
        No activity yet. Adjust stock, edit fields, or add an image to start the timeline.
      </div>
    );
  }

  return (
    <ol className="relative space-y-0">
      {events.map((e, i) => {
        const spec = specFor(e);
        const isLast = i === events.length - 1;
        // Transfers are net-zero on hand (delta is ALWAYS 0 — the ledger
        // must sum to quantity_on_hand), so the ±delta slot is meaningless
        // for them. Show the physical qty moved instead (moved_quantity,
        // mig 0231); pre-0231 rows have none → show no number, never "0".
        const isTransfer = e.kind === 'movement' && e.type === 'transfer';
        const fromName =
          isTransfer && e.fromLocationId ? locationNames?.[e.fromLocationId] : undefined;
        const toName =
          isTransfer && e.toLocationId ? locationNames?.[e.toLocationId] : undefined;
        const route = fromName && toName ? `${fromName} → ${toName}` : null;
        return (
          <li key={e.id} className="relative flex gap-3 pl-2 pr-1">
            {!isLast && (
              <span
                aria-hidden
                className="bg-border absolute left-[19px] top-9 h-[calc(100%-1.25rem)] w-px"
              />
            )}
            <div
              className={cn(
                'relative z-10 mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full border',
                spec.tone === 'pos' && 'border-success/30 bg-success/10 text-success',
                spec.tone === 'neg' && 'border-destructive/30 bg-destructive/10 text-destructive',
                spec.tone === 'warn' && 'border-warning/30 bg-warning/10 text-warning',
                spec.tone === 'neutral' && 'border-border bg-muted text-foreground',
              )}
            >
              <spec.Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
            </div>

            <div className="flex-1 border-b border-border/60 pb-3 pt-1.5 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium">{spec.label}</span>
                {isTransfer ? (
                  e.movedQuantity !== null && (
                    <span className="font-mono text-xs tabular-nums">
                      {formatNumber(e.movedQuantity)}
                    </span>
                  )
                ) : (
                  e.delta !== null && (
                    <span
                      className={cn(
                        'font-mono text-xs tabular-nums',
                        e.delta > 0 && 'text-success',
                        e.delta < 0 && 'text-destructive',
                      )}
                    >
                      {e.delta > 0 ? '+' : ''}
                      {formatNumber(e.delta)}
                    </span>
                  )
                )}
                {e.quantityAfter !== null && (
                  <span className="text-muted-foreground text-[11px]">
                    → {formatNumber(e.quantityAfter)} on hand
                  </span>
                )}
              </div>
              <div className="text-muted-foreground mt-0.5 text-xs">
                <span>{e.actor}</span>
                <span className="mx-1.5">·</span>
                <span>{formatRelative(e.createdAt)}</span>
                {route && (
                  <>
                    <span className="mx-1.5">·</span>
                    <span>{route}</span>
                  </>
                )}
                {e.summary && (
                  <>
                    <span className="mx-1.5">·</span>
                    <span className="italic">{e.summary}</span>
                  </>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
