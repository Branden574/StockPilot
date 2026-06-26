'use client';

import { Clock } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { PlaceFromStagingDialog } from '@/components/inventory/place-from-staging-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn, formatRelative } from '@/lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────

interface StagedRow {
  itemId: string;
  name: string;
  sku: string;
  itemType: string;
  warehouseId: string | null;
  stagingLocationId: string;
  stagedQuantity: number;
  sourceReceiptId: string | null;
  sourcePoNumber: string | null;
  receiptNumber: string | null;
  receivedAt: string | null;
  ageDays: number | null;
}

interface DestinationOption {
  id: string;
  name: string;
  kind: string;
}

export interface StagingTableProps {
  rows: StagedRow[];
  /** Plain-object map: warehouseId → rack/crate destinations. '__none__' key
   *  holds destinations not tied to any warehouse. */
  destinationsMap: Record<string, DestinationOption[]>;
  /** warehouseId → display name. Rows whose warehouse isn't in this map
   *  (e.g. archived/inactive) fall back to a truncated UUID. */
  warehouseNames: Record<string, string>;
  canPlace: boolean;
  /** 'all' | 'book' | 'non-book' — synced from ?type= URL param. */
  activeItemType: 'all' | 'book' | 'non-book';
}

// ── Helpers ────────────────────────────────────────────────────────────────

const STALE_THRESHOLD_DAYS = 7;

function AgeBadge({ ageDays }: { ageDays: number | null }) {
  if (ageDays === null) return <span className="text-muted-foreground text-sm">—</span>;

  const isStale = ageDays > STALE_THRESHOLD_DAYS;
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-sm tabular-nums">{ageDays}d</span>
      {isStale && (
        <Badge variant="destructive" className="gap-0.5 px-1.5 py-0 text-xs">
          <Clock className="h-2.5 w-2.5" />
          Stale
        </Badge>
      )}
    </span>
  );
}

function SourceCell({
  poNumber,
  receiptNumber,
}: {
  poNumber: string | null;
  receiptNumber: string | null;
}) {
  if (!poNumber && !receiptNumber) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  return (
    <span className="text-sm">
      {poNumber && <span className="font-medium">{poNumber}</span>}
      {poNumber && receiptNumber && (
        <span className="text-muted-foreground"> / </span>
      )}
      {receiptNumber && (
        <span className="text-muted-foreground">{receiptNumber}</span>
      )}
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

type ItemTypeFilter = 'all' | 'book' | 'non-book';

const TYPE_OPTIONS: ReadonlyArray<{ value: ItemTypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'book', label: 'Books' },
  { value: 'non-book', label: 'Items' },
];

export function StagingTable({
  rows,
  destinationsMap,
  warehouseNames,
  canPlace,
  activeItemType,
}: StagingTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setTypeFilter(value: ItemTypeFilter) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === 'all') {
      next.delete('type');
    } else {
      next.set('type', value);
    }
    router.push(`?${next.toString()}`);
  }

  // Resolved current filter — normalise 'all' for the tab highlight
  const currentType: ItemTypeFilter = activeItemType;

  if (rows.length === 0) {
    return (
      <div className="rounded-[10px] border border-border bg-card">
        {/* Filter toolbar */}
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          {TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setTypeFilter(opt.value)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                currentType === opt.value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Empty state */}
        <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
          <p className="text-muted-foreground text-sm">
            Nothing staged — received stock will appear here to place.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[10px] border border-border bg-card">
      {/* Filter toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        {TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setTypeFilter(opt.value)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              currentType === opt.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {opt.label}
          </button>
        ))}
        <span className="text-muted-foreground ml-auto text-sm">
          {rows.length} {rows.length === 1 ? 'item' : 'items'}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="text-muted-foreground px-3 py-2.5 text-xs font-medium uppercase tracking-wide">
                Item
              </th>
              <th className="text-muted-foreground px-3 py-2.5 text-xs font-medium uppercase tracking-wide">
                Staged qty
              </th>
              <th className="text-muted-foreground px-3 py-2.5 text-xs font-medium uppercase tracking-wide">
                Source PO / receipt
              </th>
              <th className="text-muted-foreground px-3 py-2.5 text-xs font-medium uppercase tracking-wide">
                Received
              </th>
              <th className="text-muted-foreground px-3 py-2.5 text-xs font-medium uppercase tracking-wide">
                Age
              </th>
              <th className="text-muted-foreground px-3 py-2.5 text-xs font-medium uppercase tracking-wide">
                Warehouse
              </th>
              {canPlace && (
                <th className="text-muted-foreground px-3 py-2.5 text-xs font-medium uppercase tracking-wide">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const destinations =
                row.warehouseId
                  ? (destinationsMap[row.warehouseId] ?? [])
                  : [];
              const canPlaceRow = canPlace && row.warehouseId !== null;

              return (
                <tr
                  key={row.itemId}
                  className="border-b border-border last:border-0 hover:bg-muted/40 transition-colors"
                >
                  {/* Item name + SKU */}
                  <td className="px-3 py-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium leading-tight">{row.name}</span>
                      <span className="text-muted-foreground text-xs">{row.sku}</span>
                    </div>
                  </td>

                  {/* Staged qty */}
                  <td className="px-3 py-3">
                    <span className="text-sm tabular-nums font-medium">
                      {row.stagedQuantity}
                    </span>
                  </td>

                  {/* Source PO / receipt */}
                  <td className="px-3 py-3">
                    <SourceCell
                      poNumber={row.sourcePoNumber}
                      receiptNumber={row.receiptNumber}
                    />
                  </td>

                  {/* Received date */}
                  <td className="px-3 py-3">
                    {row.receivedAt ? (
                      <span className="text-sm" title={row.receivedAt}>
                        {formatRelative(row.receivedAt)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </td>

                  {/* Age + stale badge */}
                  <td className="px-3 py-3">
                    <AgeBadge ageDays={row.ageDays} />
                  </td>

                  {/* Warehouse — resolved name, falling back to a truncated
                      UUID for warehouses missing from the name map (archived/
                      inactive), or an em dash when the row has no warehouse. */}
                  <td className="px-3 py-3">
                    {row.warehouseId ? (
                      warehouseNames[row.warehouseId] ? (
                        <span className="text-sm">
                          {warehouseNames[row.warehouseId]}
                        </span>
                      ) : (
                        <span className="text-muted-foreground font-mono text-xs">
                          {row.warehouseId.slice(0, 8)}…
                        </span>
                      )
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </td>

                  {/* Place action */}
                  {canPlace && (
                    <td className="px-3 py-3">
                      {canPlaceRow ? (
                        <PlaceFromStagingDialog
                          itemId={row.itemId}
                          itemName={row.name}
                          itemType={row.itemType}
                          stagingLocationId={row.stagingLocationId}
                          warehouseId={row.warehouseId!}
                          stagedQuantity={row.stagedQuantity}
                          destinations={destinations}
                          trigger={
                            <Button size="sm" variant="outline">
                              Place
                            </Button>
                          }
                        />
                      ) : (
                        <Button size="sm" variant="outline" disabled title="No warehouse — cannot place">
                          Place
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
