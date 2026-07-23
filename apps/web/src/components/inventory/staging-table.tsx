'use client';

import { Clock, History } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { BulkPlaceDialog } from '@/components/inventory/bulk-place-dialog';
import { ItemHistoryDialog } from '@/components/inventory/item-history-dialog';
import { PlaceFromStagingDialog } from '@/components/inventory/place-from-staging-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn, formatRelative } from '@/lib/utils';
import { HelpTip } from '@/components/onboarding/help-tip';

// ── Types ──────────────────────────────────────────────────────────────────

interface StagedRow {
  itemId: string;
  name: string;
  sku: string;
  itemType: string;
  warehouseId: string | null;
  sourceLocationId: string;
  sourceKind: 'staging' | 'unplaced';
  quantity: number;
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

// Per-row selection identity. Neither field is unique on its own: one item can
// hold stock in BOTH staging and unplaced (two rows, same itemId), and one
// staging LOCATION holds many items (many rows, same sourceLocationId). Key
// selection by the composite — the same identity the <tr> key uses — so
// checking one row never selects its neighbours sharing a location.
const rowKey = (r: { itemId: string; sourceLocationId: string }) =>
  `${r.itemId}::${r.sourceLocationId}`;

export function StagingTable({
  rows,
  destinationsMap,
  warehouseNames,
  canPlace,
  activeItemType,
}: StagingTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Multi-select for bulk-place. Keyed by the row's source holding location
  // (unique per row — an item with both a staging and unplaced holding has two
  // rows). Only rows that CAN be placed (canPlace + a real warehouse) are
  // selectable. Stale keys after a filter/refresh are harmless: selectedRows
  // filters against the current rows, so a vanished key simply drops out.
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(new Set());
  const placeableKeys = React.useMemo(
    () => rows.filter((r) => canPlace && r.warehouseId !== null).map(rowKey),
    [rows, canPlace],
  );
  const selectedRows = rows.filter((r) => selectedKeys.has(rowKey(r)));
  const allSelected =
    placeableKeys.length > 0 && placeableKeys.every((k) => selectedKeys.has(k));
  function toggleRow(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleAll() {
    setSelectedKeys(allSelected ? new Set() : new Set(placeableKeys));
  }
  function clearSelection() {
    setSelectedKeys(new Set());
  }

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
            Nothing to place — received (staged) or unplaced stock appears here.
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

      {/* Bulk-place action bar — appears when rows are selected */}
      {canPlace && selectedRows.length > 0 && (
        <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium">
            {selectedRows.length} selected
          </span>
          <BulkPlaceDialog
            rows={selectedRows.map((r) => ({
              itemId: r.itemId,
              name: r.name,
              sourceLocationId: r.sourceLocationId,
              quantity: r.quantity,
              warehouseId: r.warehouseId,
            }))}
            destinationsMap={destinationsMap}
            warehouseNames={warehouseNames}
            onPlaced={clearSelection}
            trigger={
              <Button size="sm" variant="outline">
                Place selected
              </Button>
            }
          />
          <button
            type="button"
            onClick={clearSelection}
            className="text-muted-foreground hover:text-foreground ml-auto text-sm"
          >
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-border text-left">
              {canPlace && (
                <th className="w-8 px-3 py-2.5">
                  <StagingCheckbox
                    checked={allSelected}
                    disabled={placeableKeys.length === 0}
                    onChange={toggleAll}
                    label="Select all placeable rows"
                  />
                </th>
              )}
              <th className="text-muted-foreground px-3 py-2.5 text-xs font-medium uppercase tracking-wide">
                <span className="inline-flex items-center gap-1.5">
                  Item
                  <HelpTip label="the staged / unplaced badge">
                    <p>
                      <strong>staged</strong> = received from a purchase order into
                      staging. <strong>unplaced</strong> = on-hand stock that was never
                      put into a rack or crate. Either way it counts in your totals but
                      cannot be picked until you place it.
                    </p>
                  </HelpTip>
                </span>
              </th>
              <th className="text-muted-foreground px-3 py-2.5 text-xs font-medium uppercase tracking-wide">
                Qty to place
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
              {/* Always rendered: History is available to anyone who can read
                  this page (the route already gates on 'items:read'), while
                  Place additionally needs 'stock:transfer'. */}
              <th className="text-muted-foreground px-3 py-2.5 text-xs font-medium uppercase tracking-wide">
                Actions
              </th>
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
                  // Same composite identity as selection (rowKey): one item can
                  // have BOTH a staging and an unplaced holding, and one location
                  // holds many items — so neither field alone is unique.
                  key={rowKey(row)}
                  className="border-b border-border last:border-0 hover:bg-muted/40 transition-colors"
                >
                  {canPlace && (
                    <td className="px-3 py-3">
                      <StagingCheckbox
                        checked={selectedKeys.has(rowKey(row))}
                        disabled={!canPlaceRow}
                        onChange={() => toggleRow(rowKey(row))}
                        label={`Select ${row.name}`}
                      />
                    </td>
                  )}
                  {/* Item name + SKU + source-bucket badge */}
                  <td className="px-3 py-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-sm font-medium leading-tight">{row.name}</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground text-xs">{row.sku}</span>
                        <Badge
                          variant={row.sourceKind === 'unplaced' ? 'outline' : 'secondary'}
                          className="px-1.5 py-0 text-[10px] font-normal capitalize"
                        >
                          {row.sourceKind}
                        </Badge>
                      </div>
                    </div>
                  </td>

                  {/* Qty to place */}
                  <td className="px-3 py-3">
                    <span className="text-sm tabular-nums font-medium">
                      {row.quantity}
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

                  {/* Actions — History for everyone, Place when permitted.
                      The em dash in the Source column only ever meant "this
                      stock did not arrive on a PO"; History is where the rest
                      of the story (who, when, where from, why) actually lives,
                      so it must not be hidden behind the place permission. */}
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <ItemHistoryDialog
                        itemId={row.itemId}
                        itemName={row.name}
                        itemSku={row.sku}
                        trigger={
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`View history for ${row.name}`}
                          >
                            <History className="h-4 w-4" />
                            History
                          </Button>
                        }
                      />
                      {canPlace &&
                        (canPlaceRow ? (
                          <PlaceFromStagingDialog
                            itemId={row.itemId}
                            itemName={row.name}
                            itemType={row.itemType}
                            sourceLocationId={row.sourceLocationId}
                            sourceKind={row.sourceKind}
                            warehouseId={row.warehouseId!}
                            warehouseName={warehouseNames[row.warehouseId!]}
                            availableQuantity={row.quantity}
                            destinations={destinations}
                            trigger={
                              <Button size="sm" variant="outline">
                                Place
                              </Button>
                            }
                          />
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled
                            title="No warehouse — cannot place"
                          >
                            Place
                          </Button>
                        ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Small inline checkbox for row selection — mirrors the inventory table's
// control so the two pages feel consistent. Disabled rows (no warehouse) can't
// be bulk-placed.
function StagingCheckbox({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'inline-grid h-5 w-5 place-items-center rounded-[5px] border bg-card transition-colors',
        disabled
          ? 'cursor-not-allowed border-border opacity-40'
          : checked
            ? 'border-foreground bg-foreground'
            : 'border-[var(--ed-line-strong)]',
      )}
    >
      {checked && !disabled && (
        <span
          aria-hidden
          // CSS-drawn ✓: bottom+RIGHT borders rotated +45° (bottom+LEFT at
          // -45° mirrors the mark — same fix as inventory-table.tsx).
          className="h-[11px] w-[6px] -translate-y-px rotate-45 border-b-2 border-r-2 border-background"
        />
      )}
    </button>
  );
}
