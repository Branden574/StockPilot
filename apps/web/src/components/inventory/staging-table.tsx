'use client';

import { Clock, History, Search, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { BulkPlaceDialog } from '@/components/inventory/bulk-place-dialog';
import { ItemHistoryDialog } from '@/components/inventory/item-history-dialog';
import { PlaceFromStagingDialog } from '@/components/inventory/place-from-staging-dialog';
import {
  EMPTY_STAGING_FILTERS,
  NO_PO,
  STALE_THRESHOLD_DAYS,
  buildPoOptions,
  filterStagingRows,
  formatStagingCount,
  hasActiveStagingFilters,
  isSamePoNumber,
  isStaleAge,
  normalizeStagingText,
  type StagingAgeFilter,
  type StagingFilters,
  type StagingSourceFilter,
} from '@/components/inventory/staging-filters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { BookStorageInfo } from '@stockpilot/core';

import { cn, formatRelative } from '@/lib/utils';
import type { DestinationOption } from '@/lib/locations/destination-option';
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
  /**
   * Searchable identifiers only (the toolbar search box): a book's ISBN lives
   * in `barcode`; `modelNumber` is the manufacturer part number. Neither is
   * rendered as a column. Both ride the worklist's existing item embed.
   */
  barcode: string | null;
  modelNumber: string | null;
  /**
   * A BOOK's current rack/crate SUMMARY, or null for a non-book. Comes from
   * stagedWorklist (derived from the custom_fields it already fetched — no
   * extra query). DISPLAY ONLY: the server re-reads the item's real crate from
   * the DB before it writes anything, so nothing sent back from here is
   * treated as proof of state.
   */
  bookStorage: BookStorageInfo | null;
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
  /**
   * Whether this user may MINT the rack/crate a put-away places into
   * (`canMintPlacementDestination`: manager-or-above, or `stock:transfer`, or
   * `locations:manage` — migration 0340, owner decision D1). The book put-away
   * dialogs place INTO the recorded crate by default, minting the row when it
   * does not exist; a user who cannot mint is told so inline rather than by a
   * server refusal. Defaults to true (today's behaviour) for callers that
   * predate it.
   */
  canMintDestination?: boolean;
  /** 'all' | 'book' | 'non-book' — synced from ?type= URL param. */
  activeItemType: 'all' | 'book' | 'non-book';
}

// ── Helpers ────────────────────────────────────────────────────────────────

function AgeBadge({ ageDays }: { ageDays: number | null }) {
  if (ageDays === null) return <span className="text-muted-foreground text-sm">—</span>;

  // The SAME predicate the Age filter's Stale bucket uses (staging-filters.ts),
  // not a re-typed comparison, so the badge and the filter cannot drift apart.
  const isStale = isStaleAge(ageDays);
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

/**
 * The "Source PO / receipt" cell. The PO number is a BUTTON that narrows the
 * table to that PO (click-to-filter) — it stays on this page and never
 * navigates. The receipt number likewise drops itself into the search box.
 * Both stop propagation so a future row-level click handler could never read
 * a filter click as a row selection.
 */
function SourceCell({
  poNumber,
  receiptNumber,
  onFilterByPo,
  onSearchReceipt,
}: {
  poNumber: string | null;
  receiptNumber: string | null;
  onFilterByPo: (po: string) => void;
  onSearchReceipt: (receipt: string) => void;
}) {
  if (!poNumber && !receiptNumber) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  return (
    <span className="text-sm">
      {poNumber && (
        <button
          type="button"
          title={`Show all staging items from ${poNumber}`}
          onClick={(e) => {
            e.stopPropagation();
            onFilterByPo(poNumber);
          }}
          className="rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {poNumber}
        </button>
      )}
      {poNumber && receiptNumber && (
        <span className="text-muted-foreground"> / </span>
      )}
      {receiptNumber && (
        <button
          type="button"
          title={`Search for receipt ${receiptNumber}`}
          onClick={(e) => {
            e.stopPropagation();
            onSearchReceipt(receiptNumber);
          }}
          className="text-muted-foreground rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {receiptNumber}
        </button>
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

const SOURCE_OPTIONS: ReadonlyArray<{ value: StagingSourceFilter; label: string }> = [
  { value: 'all', label: 'All sources' },
  { value: 'staging', label: 'Staged' },
  { value: 'unplaced', label: 'Unplaced' },
];

const AGE_OPTIONS: ReadonlyArray<{ value: StagingAgeFilter; label: string }> = [
  { value: 'all', label: 'Any age' },
  { value: 'recent', label: `Recent (${STALE_THRESHOLD_DAYS}d or less)` },
  { value: 'stale', label: `Stale (over ${STALE_THRESHOLD_DAYS}d)` },
];

/** Radix Select cannot hold an empty-string value, so "no PO filter" gets a
 *  sentinel of its own (distinct from NO_PO = the "unattributed rows" option). */
const ALL_POS = '__all__';

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
  canMintDestination = true,
  activeItemType,
}: StagingTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── Client-side filters (search / PO / source / age) ─────────────────────
  // Local component state, deliberately NOT in the URL: every keystroke
  // filters the already-loaded rows in memory (useMemo) — no router
  // navigation, no server request. The item-type tab is the one filter that
  // stays server-side (?type=), because the page fetches by it.
  const [filters, setFilters] = React.useState<StagingFilters>(EMPTY_STAGING_FILTERS);
  const visibleRows = React.useMemo(() => filterStagingRows(rows, filters), [rows, filters]);
  const poOptions = React.useMemo(() => buildPoOptions(rows), [rows]);
  const filtersActive = hasActiveStagingFilters(filters);

  // Multi-select for bulk-place. Keyed by the composite rowKey. INVARIANT: the
  // set only ever holds keys of rows that are currently VISIBLE — every filter
  // change re-intersects it against the rows the new filters will show, so a
  // row hidden by a filter is deselected (not silently carried into "Place
  // selected"), and selectedRows below is additionally derived from
  // visibleRows so a stale key after a refresh simply drops out.
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(new Set());

  function updateFilters(patch: Partial<StagingFilters>) {
    const next: StagingFilters = { ...filters, ...patch };
    setFilters(next);
    // A key survives only if its row is visible BOTH now and under the new
    // filters. The "now" half matters after a rows refresh: a selected row the
    // fresh data no longer matches (e.g. it aged past the Stale line under
    // Age=Recent) is already invisible and must not come back selected when the
    // user widens the filter.
    const visibleNow = new Set(visibleRows.map(rowKey));
    const visibleNext = new Set(filterStagingRows(rows, next).map(rowKey));
    setSelectedKeys((prev) => {
      const pruned = new Set([...prev].filter((k) => visibleNow.has(k) && visibleNext.has(k)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }
  function clearFilters() {
    updateFilters(EMPTY_STAGING_FILTERS);
  }
  /** Click-to-filter from a row's PO cell: snap to the picker's canonical
   *  spelling of that PO so the Select shows it as chosen. */
  function filterByPo(po: string) {
    const canonical = poOptions.options.find((o) => isSamePoNumber(o.value, po))?.value ?? po.trim();
    updateFilters({ poNumber: canonical });
  }

  const placeableKeys = React.useMemo(
    () => visibleRows.filter((r) => canPlace && r.warehouseId !== null).map(rowKey),
    [visibleRows, canPlace],
  );
  const selectedRows = visibleRows.filter((r) => selectedKeys.has(rowKey(r)));
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

  const poSelectValue =
    filters.poNumber === null ? ALL_POS : filters.poNumber;
  const poChipLabel =
    filters.poNumber === NO_PO ? 'No PO' : filters.poNumber;
  const sourceChipLabel = SOURCE_OPTIONS.find((o) => o.value === filters.source)?.label;
  const ageChipLabel = filters.age === 'recent' ? 'Recent' : filters.age === 'stale' ? 'Stale' : null;

  return (
    <div className="rounded-[10px] border border-border bg-card">
      {/* Filter toolbar — always rendered, including over an empty result, so
          the user can always widen a filter that hid everything. */}
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] max-w-md flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
            <Input
              type="search"
              value={filters.query}
              onChange={(e) => updateFilters({ query: e.target.value })}
              placeholder="Search item, SKU, PO or receipt..."
              aria-label="Search staging items"
              className="h-9 pl-8 pr-8 text-[13px]"
            />
            {filters.query && (
              <button
                type="button"
                onClick={() => updateFilters({ query: '' })}
                aria-label="Clear staging search"
                className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <span
            className="text-muted-foreground ml-auto text-sm tabular-nums"
            aria-live="polite"
            data-testid="staging-count"
          >
            {formatStagingCount(visibleRows.length, rows.length)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1" role="group" aria-label="Item type">
            {TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTypeFilter(opt.value)}
                aria-pressed={currentType === opt.value}
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
          <span className="bg-border mx-1 hidden h-5 w-px sm:block" aria-hidden />

          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            PO
            <Select
              value={poSelectValue}
              onValueChange={(v) => updateFilters({ poNumber: v === ALL_POS ? null : v })}
            >
              <SelectTrigger className="h-8 w-[190px] text-[13px]" aria-label="Filter by purchase order">
                <SelectValue placeholder="All POs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_POS}>All POs</SelectItem>
                {poOptions.options.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.value} ({opt.count})
                  </SelectItem>
                ))}
                {poOptions.unattributedCount > 0 && (
                  <SelectItem value={NO_PO}>
                    No PO / Unattributed ({poOptions.unattributedCount})
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            Source
            <Select
              value={filters.source}
              onValueChange={(v) => updateFilters({ source: v as StagingSourceFilter })}
            >
              <SelectTrigger className="h-8 w-[130px] text-[13px]" aria-label="Filter by source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            Age
            <Select
              value={filters.age}
              onValueChange={(v) => updateFilters({ age: v as StagingAgeFilter })}
            >
              <SelectTrigger className="h-8 w-[170px] text-[13px]" aria-label="Filter by age">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {filtersActive && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="staging-active-filters">
            {normalizeStagingText(filters.query) !== '' && (
              <FilterChip
                label={`Search: ${filters.query.trim()}`}
                onRemove={() => updateFilters({ query: '' })}
              />
            )}
            {filters.poNumber !== null && (
              <FilterChip
                label={`PO: ${poChipLabel}`}
                onRemove={() => updateFilters({ poNumber: null })}
              />
            )}
            {filters.source !== 'all' && (
              <FilterChip
                label={`Source: ${sourceChipLabel}`}
                onRemove={() => updateFilters({ source: 'all' })}
              />
            )}
            {ageChipLabel && (
              <FilterChip
                label={`Age: ${ageChipLabel}`}
                onRemove={() => updateFilters({ age: 'all' })}
              />
            )}
            <button
              type="button"
              onClick={clearFilters}
              className="text-muted-foreground hover:text-foreground ml-1 inline-flex items-center gap-1 text-xs"
            >
              <X className="h-3 w-3" /> Clear filters
            </button>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        /* True empty: nothing staged or unplaced at all (for this type/warehouse). */
        <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
          <p className="text-muted-foreground text-sm">
            Nothing to place — received (staged) or unplaced stock appears here.
          </p>
        </div>
      ) : visibleRows.length === 0 ? (
        /* Filtered empty: rows exist, the active filters hide all of them. */
        <div
          className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center"
          data-testid="staging-filtered-empty"
        >
          <p className="text-muted-foreground text-sm">
            No staging items match these filters.
          </p>
          <Button size="sm" variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      ) : (
        <>
          {/* Bulk-place action bar — appears when VISIBLE rows are selected */}
          {canPlace && selectedRows.length > 0 && (
            <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-3 py-2">
              <span className="text-sm font-medium">
                {selectedRows.length} selected
              </span>
              <BulkPlaceDialog
                // itemType and bookStorage travel WITH the row. Dropping them was
                // why the bulk dialog could not tell a book from a Chromebook —
                // and therefore could neither offer a crate nor warn that it was
                // about to overwrite one.
                rows={selectedRows.map((r) => ({
                  itemId: r.itemId,
                  name: r.name,
                  itemType: r.itemType,
                  sourceLocationId: r.sourceLocationId,
                  quantity: r.quantity,
                  warehouseId: r.warehouseId,
                  bookStorage: r.bookStorage,
                }))}
                destinationsMap={destinationsMap}
                warehouseNames={warehouseNames}
                canMintDestination={canMintDestination}
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
                {visibleRows.map((row) => {
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

                      {/* Source PO / receipt — the PO is click-to-filter */}
                      <td className="px-3 py-3">
                        <SourceCell
                          poNumber={row.sourcePoNumber}
                          receiptNumber={row.receiptNumber}
                          onFilterByPo={filterByPo}
                          onSearchReceipt={(receipt) => updateFilters({ query: receipt })}
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
                                bookStorage={row.bookStorage}
                                canMintDestination={canMintDestination}
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
        </>
      )}
    </div>
  );
}

// An active-filter chip with its own remove control.
function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="bg-muted text-foreground inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="text-muted-foreground hover:text-foreground rounded-full"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
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
