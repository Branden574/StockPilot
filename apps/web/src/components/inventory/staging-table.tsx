'use client';

import { Clock, History, PackageCheck, Search, X } from 'lucide-react';
import Link from 'next/link';
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
import { FilterBar } from '@/components/patterns/filter-bar';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { StatePanel } from '@/components/patterns/state-panel';
import { touchTargetClass } from '@/components/patterns/touch-target';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { stagingReturnedSourceLabel, type BookStorageInfo } from '@stockpilot/core';

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
  /** Returns RX-1: the RMA when a return restocked this stock into Staging. */
  sourceReturnId?: string | null;
  sourceReturnNumber?: string | null;
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
  /**
   * Leave out the table's own "Nothing to place" when there are no rows: the
   * page already says it (F2-3, a list filtered to an order's items, whose
   * chip says "No Staging or Unplaced stock is listed for these items.").
   * The filters' own empty state is unaffected.
   */
  hideEmptyState?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

function AgeBadge({ ageDays }: { ageDays: number | null }) {
  if (ageDays === null) return <Dash />;

  // The SAME predicate the Age filter's Stale bucket uses (staging-filters.ts),
  // not a re-typed comparison, so the badge and the filter cannot drift apart.
  const isStale = isStaleAge(ageDays);
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <span className="font-mono text-[12.5px] tabular-nums">{ageDays}d</span>
      {isStale && (
        <Badge variant="destructive" className="gap-1 px-1.5">
          <Clock aria-hidden className="h-3 w-3" strokeWidth={1.8} />
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
  returnId,
  returnNumber,
  onFilterByPo,
  onSearchReceipt,
}: {
  poNumber: string | null;
  receiptNumber: string | null;
  returnId?: string | null;
  returnNumber?: string | null;
  onFilterByPo: (po: string) => void;
  onSearchReceipt: (receipt: string) => void;
}) {
  if (returnId) {
    return (
      <Link
        href={`/dashboard/returns/${returnId}`}
        onClick={(e) => e.stopPropagation()}
        className="text-foreground underline-offset-2 hover:underline"
      >
        {stagingReturnedSourceLabel(returnNumber ?? null)}
      </Link>
    );
  }
  if (!poNumber && !receiptNumber) {
    return <Dash />;
  }
  return (
    <span className="whitespace-nowrap font-mono text-[12.5px]">
      {poNumber && (
        <button
          type="button"
          title={`Show all staging items from ${poNumber}`}
          onClick={(e) => {
            e.stopPropagation();
            onFilterByPo(poNumber);
          }}
          className="text-foreground focus-visible:ring-ring rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2"
        >
          {poNumber}
        </button>
      )}
      {poNumber && receiptNumber && <span className="text-muted-foreground"> / </span>}
      {receiptNumber && (
        <button
          type="button"
          title={`Search for receipt ${receiptNumber}`}
          onClick={(e) => {
            e.stopPropagation();
            onSearchReceipt(receiptNumber);
          }}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2"
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

/** A filter select in the toolbar: full width on a phone, its own width from
 *  sm, the quiet label then the value, and the chevron at the far end. */
const FILTER_SELECT = 'w-full justify-start gap-1.5 sm:w-auto [&>svg]:ml-auto';

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
  hideEmptyState = false,
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
    <div className="flex min-w-0 flex-col gap-3">
      {/* Filter toolbar (DESIGN-SPEC 6.4, 6.5): the type tabs on the left,
          search and the three filters on the right. Always rendered, including
          over an empty result, so the user can always widen a filter that hid
          everything. */}
      <FilterBar
        leading={
          // Server-side filter (?type=): a group of toggle buttons, exactly as
          // before (no links: the push keeps every other param).
          <SegmentedTabs
            semantics="nav"
            aria-label="Item type"
            activeId={currentType}
            items={TYPE_OPTIONS.map((opt) => ({ id: opt.value, label: opt.label }))}
            onSelect={(id) => setTypeFilter(id as ItemTypeFilter)}
          />
        }
      >
        <div className="relative w-full sm:w-[264px]">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
            strokeWidth={1.8}
          />
          <Input
            type="search"
            value={filters.query}
            onChange={(e) => updateFilters({ query: e.target.value })}
            placeholder="Search item, SKU, PO or receipt..."
            aria-label="Search staging items"
            className={cn(
              'pl-8 [&::-webkit-search-cancel-button]:appearance-none',
              filters.query ? 'pr-9' : 'pr-2.5',
            )}
          />
          {filters.query && (
            <button
              type="button"
              onClick={() => updateFilters({ query: '' })}
              aria-label="Clear staging search"
              // The touch target first: its `relative` must lose to `absolute`.
              className={cn(
                touchTargetClass,
                'text-muted-foreground hover:bg-muted hover:text-foreground absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded transition-colors',
              )}
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <Select
          value={poSelectValue}
          onValueChange={(v) => updateFilters({ poNumber: v === ALL_POS ? null : v })}
        >
          <SelectTrigger
            className={cn(FILTER_SELECT, 'sm:w-[220px]')}
            aria-label="Filter by purchase order"
          >
            <FilterSelectLabel>PO</FilterSelectLabel>
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

        <Select
          value={filters.source}
          onValueChange={(v) => updateFilters({ source: v as StagingSourceFilter })}
        >
          <SelectTrigger className={cn(FILTER_SELECT, 'sm:w-[176px]')} aria-label="Filter by source">
            <FilterSelectLabel>Source</FilterSelectLabel>
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

        <Select
          value={filters.age}
          onValueChange={(v) => updateFilters({ age: v as StagingAgeFilter })}
        >
          <SelectTrigger className={cn(FILTER_SELECT, 'sm:w-[204px]')} aria-label="Filter by age">
            <FilterSelectLabel>Age</FilterSelectLabel>
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
      </FilterBar>

      {/* The active filters (chips that each remove one) and the live count. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {filtersActive && (
          <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="staging-active-filters">
            {normalizeStagingText(filters.query) !== '' && (
              <ActiveFilterChip
                label={`Search: ${filters.query.trim()}`}
                onRemove={() => updateFilters({ query: '' })}
              />
            )}
            {filters.poNumber !== null && (
              <ActiveFilterChip
                label={`PO: ${poChipLabel}`}
                onRemove={() => updateFilters({ poNumber: null })}
              />
            )}
            {filters.source !== 'all' && (
              <ActiveFilterChip
                label={`Source: ${sourceChipLabel}`}
                onRemove={() => updateFilters({ source: 'all' })}
              />
            )}
            {ageChipLabel && (
              <ActiveFilterChip
                label={`Age: ${ageChipLabel}`}
                onRemove={() => updateFilters({ age: 'all' })}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="text-muted-foreground font-normal"
            >
              <X aria-hidden /> Clear filters
            </Button>
          </div>
        )}
        <span
          className="text-muted-foreground ml-auto text-[12.5px] tabular-nums"
          aria-live="polite"
          data-testid="staging-count"
        >
          {formatStagingCount(visibleRows.length, rows.length)}
        </span>
      </div>

      {rows.length === 0 ? (
        /* True empty: nothing staged or unplaced at all (for this type/warehouse).
           Left out when the page already says so (hideEmptyState). */
        hideEmptyState ? null : (
          <StatePanel
            kind="empty"
            icon={PackageCheck}
            headingLevel={null}
            title="Nothing to place — received (staged) or unplaced stock appears here."
          />
        )
      ) : visibleRows.length === 0 ? (
        /* Filtered empty: rows exist, the active filters hide all of them. */
        <StatePanel
          kind="no-match"
          headingLevel={null}
          data-testid="staging-filtered-empty"
          title="No staging items match these filters."
          action={
            <Button size="sm" variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="border-border bg-card min-w-0 overflow-hidden rounded-lg border">
          {/* Bulk-place bar (DESIGN-SPEC 6.21) — appears when VISIBLE rows are
              selected, as a strip at the top of the table card. */}
          {canPlace && selectedRows.length > 0 && (
            <div
              data-slot="staging-bulk-bar"
              className="border-border bg-sunk flex flex-wrap items-center gap-2 border-b px-4 py-2"
            >
              <span className="text-foreground font-mono text-[12.5px] tabular-nums">
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
                  <Button size="sm">
                    <PackageCheck aria-hidden />
                    Place selected
                  </Button>
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearSelection}
                className="text-muted-foreground ml-auto font-normal"
              >
                Clear
              </Button>
            </div>
          )}

          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {canPlace && (
                  <TableHead className="w-[52px]">
                    <Checkbox
                      checked={allSelected}
                      disabled={placeableKeys.length === 0}
                      onCheckedChange={toggleAll}
                      label="Select all placeable rows"
                    />
                  </TableHead>
                )}
                <TableHead>
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
                </TableHead>
                <TableHead className="text-right">Qty to place</TableHead>
                <TableHead>Source PO / receipt</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Age</TableHead>
                <TableHead>Warehouse</TableHead>
                {/* Always rendered: History is available to anyone who can read
                    this page (the route already gates on 'items:read'), while
                    Place additionally needs 'stock:transfer'. */}
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => {
                const destinations = row.warehouseId
                  ? (destinationsMap[row.warehouseId] ?? [])
                  : [];
                const canPlaceRow = canPlace && row.warehouseId !== null;
                const key = rowKey(row);
                const selected = selectedKeys.has(key);

                return (
                  <TableRow
                    // Same composite identity as selection (rowKey): one item can
                    // have BOTH a staging and an unplaced holding, and one location
                    // holds many items — so neither field alone is unique.
                    key={key}
                    data-state={selected ? 'selected' : undefined}
                  >
                    {canPlace && (
                      <TableCell>
                        <Checkbox
                          checked={selected}
                          disabled={!canPlaceRow}
                          onCheckedChange={() => toggleRow(key)}
                          label={`Select ${row.name}`}
                        />
                      </TableCell>
                    )}
                    {/* Item name, then the SKU and the source-bucket badge */}
                    <TableCell className="min-w-[220px]">
                      <div className="text-foreground text-[13.5px] font-medium leading-5">
                        {row.name}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-muted-foreground font-mono text-[11.5px] leading-[17.25px]">
                          {row.sku}
                        </span>
                        <Badge
                          variant={row.sourceKind === 'unplaced' ? 'outline' : 'secondary'}
                          className="px-1.5 text-[11px] leading-4 capitalize"
                        >
                          {row.sourceKind}
                        </Badge>
                      </div>
                    </TableCell>

                    {/* Qty to place */}
                    <TableCell className="text-right">
                      <span className="font-mono text-[13.5px] font-medium tabular-nums">
                        {row.quantity}
                      </span>
                    </TableCell>

                    {/* Source PO / receipt — the PO is click-to-filter */}
                    <TableCell>
                      <SourceCell
                        poNumber={row.sourcePoNumber}
                        receiptNumber={row.receiptNumber}
                        returnId={row.sourceReturnId ?? null}
                        returnNumber={row.sourceReturnNumber ?? null}
                        onFilterByPo={filterByPo}
                        onSearchReceipt={(receipt) => updateFilters({ query: receipt })}
                      />
                    </TableCell>

                    {/* Received date */}
                    <TableCell className="whitespace-nowrap">
                      {row.receivedAt ? (
                        // Rendered on the server, hydrated a minute later:
                        // tolerate the drift instead of React error #418.
                        <span
                          className="text-muted-foreground text-[12.5px]"
                          title={row.receivedAt}
                          suppressHydrationWarning
                        >
                          {formatRelative(row.receivedAt)}
                        </span>
                      ) : (
                        <Dash />
                      )}
                    </TableCell>

                    {/* Age + stale badge */}
                    <TableCell>
                      <AgeBadge ageDays={row.ageDays} />
                    </TableCell>

                    {/* Warehouse — resolved name, falling back to a truncated
                        UUID for warehouses missing from the name map (archived/
                        inactive), or an em dash when the row has no warehouse. */}
                    <TableCell className="text-ink-2">
                      {row.warehouseId ? (
                        warehouseNames[row.warehouseId] ? (
                          <span>{warehouseNames[row.warehouseId]}</span>
                        ) : (
                          <span className="text-muted-foreground font-mono text-[12px]">
                            {row.warehouseId.slice(0, 8)}…
                          </span>
                        )
                      ) : (
                        <Dash />
                      )}
                    </TableCell>

                    {/* Actions — History for everyone, Place when permitted.
                        The em dash in the Source column only ever meant "this
                        stock did not arrive on a PO"; History is where the rest
                        of the story (who, when, where from, why) actually lives,
                        so it must not be hidden behind the place permission.
                        8 px between the two 28 px buttons: the Button touch
                        rule for dense small buttons. */}
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <ItemHistoryDialog
                          itemId={row.itemId}
                          itemName={row.name}
                          itemSku={row.sku}
                          trigger={
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`View history for ${row.name}`}
                              className="text-ink-2"
                            >
                              <History aria-hidden className="h-4 w-4" />
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
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/** The quiet label inside a filter select ("PO", "Source", "Age"): the
 *  filter-trigger recipe's "Label: value" form (DESIGN-SPEC 6.4, 6.21). */
function FilterSelectLabel({ children }: { children: React.ReactNode }) {
  return (
    <span aria-hidden className="text-muted-foreground shrink-0">
      {children}:
    </span>
  );
}

// An active-filter chip with its own remove control. The label and the remove
// button are siblings, never one inside the other.
function ActiveFilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="text-foreground inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-[var(--ed-line-strong)] bg-transparent pl-2.5 pr-1 text-[12.5px]">
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className={cn(
          touchTargetClass,
          'text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full transition-colors',
        )}
      >
        <X aria-hidden className="h-3 w-3" />
      </button>
    </span>
  );
}
