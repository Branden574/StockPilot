'use client';

import * as React from 'react';

import { StatePanel } from '@/components/patterns/state-panel';
import { Pagination } from '@/components/ui/pagination';
import type { MovementsFilterQuery } from '@/lib/movements-filters';

import {
  MovementsExportButton,
  movementsExportHref,
  useInstantMovementsFilters,
} from './movements-export';
import { MovementsFilterBar } from './movements-filter-bar';
import { MovementsTable, type MovementDisplayRow } from './movements-table';

export type { MovementDisplayRow } from './movements-table';

const PAGE_SIZE = 50;
const EMPTY_FILTERS: MovementsFilterQuery = { q: '', type: '', from: '', to: '' };

/**
 * Instant, zero-latency movements ledger — the Items/Books pattern. The
 * server hands us the whole (warehouse-scoped) ledger when it's small enough
 * (see the page's MOVEMENTS_INSTANT_CAP); this filters by item name/SKU,
 * movement type, and date range as the user picks them, plus paginates,
 * entirely client-side, so every change is instant. The CSV export link
 * still re-queries the server with the SAME filter values (via
 * buildMovementsQueryString) rather than dumping what's already in memory,
 * so a single export code path (the route + MovementsService.exportRows)
 * stays the source of truth for both page modes.
 *
 * Inside the page's MovementsInstantFiltersProvider the filters are shared
 * with the page header, whose Export CSV follows them; on its own (no
 * provider) the table keeps them itself and prints Export CSV beside its
 * pager, as it always did.
 */
export function MovementsInstantTable({
  rows,
  canEditNotes = false,
}: {
  rows: MovementDisplayRow[];
  /** Managers+/granted users get the add/edit-note affordance on each row. */
  canEditNotes?: boolean;
}) {
  const shared = useInstantMovementsFilters();
  const [ownFilters, setOwnFilters] = React.useState<MovementsFilterQuery>(EMPTY_FILTERS);
  const filters = shared ? shared.filters : ownFilters;
  const setFilters = shared ? shared.setFilters : setOwnFilters;
  const [page, setPage] = React.useState(1);

  const filtered = React.useMemo(() => {
    const needle = filters.q.trim().toLowerCase();
    const type = filters.type || null;
    // Same inclusive-of-whole-day semantics as the server path
    // (lib/movements-filters parseFromDateParam/parseToDateParam).
    const sinceMs = filters.from ? Date.parse(`${filters.from}T00:00:00.000Z`) : null;
    const untilMs = filters.to
      ? Date.parse(`${filters.to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000
      : null;
    return rows.filter((m) => {
      if (
        needle &&
        !(m.itemName ?? '').toLowerCase().includes(needle) &&
        !(m.itemSku ?? '').toLowerCase().includes(needle)
      ) {
        return false;
      }
      if (type && m.movementType !== type) return false;
      if (sinceMs != null || untilMs != null) {
        const createdMs = Date.parse(m.createdAt);
        if (sinceMs != null && createdMs < sinceMs) return false;
        if (untilMs != null && createdMs >= untilMs) return false;
      }
      return true;
    });
  }, [filters, rows]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Reset to page 1 on any filter change.
  function updateFilters(next: MovementsFilterQuery) {
    setFilters(next);
    setPage(1);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <MovementsFilterBar
        mode="client"
        // The filters in effect (the bar reads them once, when it mounts):
        // with the page's provider they can outlive this table, so a bar
        // mounted again must show the filters the rows and the header's
        // Export CSV still use, never blank ones.
        initial={filters}
        onChange={updateFilters}
        trailing={
          <>
            {shared ? null : <MovementsExportButton href={movementsExportHref(filters)} />}
            <Pagination
              page={safePage}
              pageSize={PAGE_SIZE}
              total={filtered.length}
              onPageChange={setPage}
              className="flex-wrap"
            />
          </>
        }
      />

      {visible.length === 0 ? (
        <StatePanel
          kind="no-match"
          title="No movements match"
          description="Nothing found for the current filters. Try a different search, type, or date range."
        />
      ) : (
        <MovementsTable
          rows={visible}
          canEditNotes={canEditNotes}
          // Bottom pager. The server-mode page (dashboard/movements/page.tsx)
          // renders one above AND below the table; instant mode only had the
          // top one, so on any ledger under MOVEMENTS_INSTANT_CAP — i.e. most
          // of the time — you scrolled to the end of a full page and had to go
          // back up to advance. Same props as the top instance so both stay in
          // lockstep.
          footer={
            <Pagination
              page={safePage}
              pageSize={PAGE_SIZE}
              total={filtered.length}
              onPageChange={setPage}
            />
          }
        />
      )}
    </div>
  );
}
