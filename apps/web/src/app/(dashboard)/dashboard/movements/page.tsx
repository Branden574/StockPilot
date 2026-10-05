import { ArrowLeftRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import {
  MovementsExportButton,
  MovementsInstantFiltersProvider,
} from '@/components/movements/movements-export';
import { MovementsFilterBar } from '@/components/movements/movements-filter-bar';
import { MovementsInstantTable } from '@/components/movements/movements-instant-table';
import {
  MOVEMENTS_TITLE_ID,
  MovementsTable,
  type MovementDisplayRow,
} from '@/components/movements/movements-table';
import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { PerfUseful } from '@/components/perf/perf-useful';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { movementActorLabel } from '@/lib/movements/actor-label';
import {
  buildMovementsQueryString,
  parseFromDateParam,
  parseMovementTypeParam,
  parseToDateParam,
} from '@/lib/movements-filters';
import { MovementsService, type MovementWithItem } from '@/server/services/movements';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';

import {
  can,
  formatMovementWhen,
  isReceiptNoteSentinel,
  resolveOrgTimezone,
  userMovementNote,
} from '@stockpilot/core';

// The tab says what the page is: "Stock movements · StockPilot" through the
// (dashboard) layout's title template. With no title of its own the tab read
// the group's default, "Dashboard · StockPilot" (CONFLICTS D16).
export const metadata: Metadata = { title: 'Stock movements' };

const PAGE_SIZE = 50;

/**
 * Instant-search threshold. At or below this many movements (warehouse-scoped),
 * the whole ledger loads and search + paging run client-side (zero-latency,
 * matching Items/Books). Above it, server-side search + numbered pages hold —
 * the ledger can reach millions of rows and must not all cross the wire.
 */
const MOVEMENTS_INSTANT_CAP = 1000;

// Receipt rows stash an internal receipt UUID in `notes` (the service
// deliberately keeps it raw there for stagedWorklist — see MovementsService.
// list). It's a sentinel, NOT user text, so it is never displayed nor
// pre-filled into the editor; the resolved reason still shows as the read-only
// fallback. `list()` resolves the raw reason to a 'PO {n}' display string, so
// the reliable per-row signal on this surface is the sentinel's SHAPE in the
// raw notes column.
//
// This page's local copy of that test is gone: the shape test and the masking
// now live in @stockpilot/core (`movement-note-sentinel`), which the item
// Activity feed and mobile call too. The old comment here claimed it mirrored
// activity.ts — it did not, and that gap is the leak this shared module closes.
function userNote(rawNotes: unknown): string | null {
  return userMovementNote(rawNotes as string | null);
}

function isReceiptLineNote(rawNotes: unknown): boolean {
  return isReceiptNoteSentinel(rawNotes as string | null);
}

// An order-pick / order-cancelled reason names a real record, so the cell that
// shows it links there. `order_ref_id` is resolved by MovementsService.list()
// from the reference columns (0306+ rows) or from the legacy uuid still inside
// older rows' reason text — null means "render plain text", never a dead link.
function orderHref(orderRefId: string | null | undefined): string | null {
  return orderRefId ? `/dashboard/orders/${orderRefId}` : null;
}

/**
 * One ledger row as the table prints it. Both modes go through this one
 * mapping and the one MovementsTable, so the server-paged ledger and the
 * instant ledger can no longer print the same movement differently.
 */
function toDisplayRow(m: MovementWithItem, timeZone: string): MovementDisplayRow {
  return {
    id: m.id as string,
    movementType: m.movement_type as string,
    quantityChange: Number(m.quantity_change),
    newQuantity: Number(m.new_quantity),
    movedQuantity: m.moved_quantity == null ? null : Number(m.moved_quantity),
    // reason (read-only "why") and note (editable free text) are carried as
    // TWO fields now — the note cell edits `note` and falls back to showing
    // `reason` when there's no note (see EditableMovementNote).
    reason: (m.reason as string | null) ?? null,
    reasonHref: orderHref(m.order_ref_id),
    note: userNote(m.notes),
    // receipt_line rows carry a system-managed note (the RPC rejects edits)
    // — never expose the add/edit affordance on them.
    noteEditable: !isReceiptLineNote(m.notes),
    createdAt: m.created_at as string,
    // When it happened, in the ORGANIZATION's zone (L7), made here on the
    // server for both modes: see the page's timeZone.
    createdAtLabel: formatMovementWhen(m.created_at as string, timeZone),
    itemName: m.item?.name ?? null,
    itemSku: m.item?.sku ?? null,
    actorLabel: movementActorLabel(m),
    actorEmail: m.actor?.fullName && m.actor?.email ? m.actor.email : null,
  };
}

const NO_MATCH = {
  title: 'No movements match',
  description:
    'Nothing found for the current filters. Try a different search, type, or date range.',
};

const EMPTY_LEDGER = {
  title: 'No movements yet',
  description:
    "Every stock change gets recorded here — create an item, adjust quantity, or receive a PO and it'll show up.",
};

/**
 * A state panel's way out, a real link: the flat accent button every
 * EmptyState draws its call to action with (the `gradient` variant), so these
 * states keep the button they had and look like every other empty list.
 */
function StateLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="gradient">
      <Link href={href}>{children}</Link>
    </Button>
  );
}

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; type?: string; from?: string; to?: string }>;
}) {
  // Movements is the org-wide stock_movements ledger — viewer doesn't
  // have activity_logs:read, so they get bounced back to the dashboard
  // if they type the URL. Sidebar already hides this entry for them.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'activity_logs:read')) {
    redirect('/dashboard');
  }
  // Managers+ (or anyone granted the FULLY_GRANTABLE `movements:edit_notes`)
  // may add/edit the free-text note on a movement; everyone else sees the
  // note read-only. Override-aware (per-user grants take effect); the server
  // action + the SECURITY DEFINER RPC re-gate regardless.
  const canEditNotes = can(ctx, 'movements:edit_notes');

  const params = await searchParams;
  const page = clampPage(params.page);
  const offset = (page - 1) * PAGE_SIZE;
  const search = (params.q ?? '').trim();
  // Garbage type/date params are dropped (undefined) rather than thrown —
  // see lib/movements-filters. `rawType`/`rawFrom`/`rawTo` keep only the
  // values that actually parsed, so a mangled param never round-trips into
  // the filter bar or the export link.
  const typeFilter = parseMovementTypeParam(params.type);

  const [movementsSvc, warehouseFilter, orgRow] = await Promise.all([
    MovementsService.forCurrentUser(),
    getActiveWarehouseFilter(),
    // The org's zone, request-cached (normally already in hand from the
    // request context). A failed read never fails the ledger: it prints in
    // core's documented default zone.
    getOrgRowForRequest(ctx.organizationId).catch(() => null),
  ]);
  const warehouseId = warehouseFilter ?? undefined;
  // MOVEMENT TIMES IN THE ORGANIZATION'S ZONE (owner decision Q1, 2026-10-05;
  // L7), like counts, exceptions and orders. Both modes print through
  // MovementsTable's When cell, which used <LocalDateTime>, the viewer's zone,
  // filled in after hydration. The text is now made HERE, once, on the server
  // (toDisplayRow), and both tables are handed it as a string, so the server
  // and the browser cannot print two different days.
  const timeZone = resolveOrgTimezone(orgRow?.timezone);
  // FROM AND TO CUT DAYS IN THAT SAME ZONE (slice 3 review F4; SP-079). They
  // cut at UTC midnight, so From=To=2026-10-10 left out a movement this page
  // prints as 6:30 PM on Oct 10 (01:30Z on the 11th) and kept the evening of
  // the 9th. The instant table and the CSV export cut in the same zone.
  const since = parseFromDateParam(params.from, timeZone);
  const until = parseToDateParam(params.to, timeZone);
  const rawType = typeFilter ?? '';
  const rawFrom = since ? (params.from ?? '') : '';
  const rawTo = until ? (params.to ?? '') : '';
  // Any of the four filter dimensions actually parsed to something active.
  // Drives whether a zero result should read as "ledger's empty" vs "no
  // match for these filters" — see the empty-state branching below.
  const hasActiveFilters = Boolean(search || typeFilter || since || until);

  // Instant mode: when the whole warehouse-scoped ledger fits under the cap,
  // load it all and let the client filter + page with zero latency (like
  // Items/Books). Decided on the UNFILTERED count since instant mode ignores
  // the server ?q/?type/?from/?to (those are applied client-side there).
  //
  // The count and the SPECULATIVE instant page run in ONE Promise.all — the
  // old serial count→list added a full extra DB round trip to every visit
  // (2026-07-16 perf sweep). Orgs over the cap discard the speculative page
  // and pay the server-mode pair below; everyone else (the common case)
  // renders one round trip sooner.
  const [totalAll, speculativeAll] = await Promise.all([
    movementsSvc.count({ warehouseId }).catch(() => null),
    movementsSvc
      .list({ limit: MOVEMENTS_INSTANT_CAP, offset: 0, warehouseId })
      .catch(() => null),
  ]);
  const instant =
    totalAll != null && totalAll <= MOVEMENTS_INSTANT_CAP && speculativeAll != null;

  let instantRows: MovementDisplayRow[] = [];
  let visible: Awaited<ReturnType<typeof movementsSvc.list>> = [];
  let total: number | null = totalAll;
  let hasNext = false;
  let totalPages: number | undefined;

  if (instant) {
    instantRows = speculativeAll.map((m) => toDisplayRow(m, timeZone));
  } else {
    // One extra row detects a next page even if the count is unavailable; the
    // count drives the numbered pager. Server-side search + type/date here.
    const [movements, cnt] = await Promise.all([
      movementsSvc.list({
        limit: PAGE_SIZE + 1,
        offset,
        warehouseId,
        search: search || undefined,
        types: typeFilter ? [typeFilter] : undefined,
        since,
        until,
      }),
      movementsSvc
        .count({
          warehouseId,
          search: search || undefined,
          types: typeFilter ? [typeFilter] : undefined,
          since,
          until,
        })
        .catch(() => null),
    ]);
    hasNext = movements.length > PAGE_SIZE;
    visible = hasNext ? movements.slice(0, PAGE_SIZE) : movements;
    total = cnt;
    totalPages = cnt != null ? Math.max(1, Math.ceil(cnt / PAGE_SIZE)) : undefined;
  }

  const activeFilters = { q: search, type: rawType, from: rawFrom, to: rawTo };

  // Preserve the active filters across (server-mode) page links. SERIALIZABLE
  // props only: this is a server component rendering a 'use client' pager,
  // and a function prop (hrefForPage) crashes any non-empty list at runtime —
  // RSC refuses to serialize functions (digest 3969804129; see
  // dashboard/maintenance/page.tsx's fix, Task 25 fast-follow BUG 1 sibling).
  // baseParams reuses buildMovementsQueryString — the same query-string
  // builder the Export CSV link uses — so the pager and the export can never
  // drift on the filter shape.
  const movementsBaseParams = Object.fromEntries(
    new URLSearchParams(buildMovementsQueryString(activeFilters)),
  );

  const exportQs = buildMovementsQueryString(activeFilters);
  const exportHref = exportQs ? `/api/movements/export.csv?${exportQs}` : '/api/movements/export.csv';

  // The instant ledger draws its own controls; an empty ledger has none.
  const instantLedger = instant && total !== 0;
  // Server mode keeps its controls whenever there is a ledger to filter, or
  // filters to clear: a no-match filter must stay visible (and clearable).
  const serverControls = !instant && (total !== 0 || hasActiveFilters);

  return (
    // The page area (DESIGN-SPEC 4 and 5.3): 1320 wide at most, 28 / 32 / 64
    // around it and a 16 px gutter on a phone, as the route's skeleton draws.
    // The provider only shares the instant ledger's filters with the header's
    // Export CSV; it reads nothing.
    <MovementsInstantFiltersProvider>
      <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
        {/* Performance marker. No Suspense split on this page: the ledger rows
            (instant or server mode) are awaited above, so this markup only
            exists once they are in hand. loading.tsx is the skeleton and never
            renders this; every empty state below is a finished page and counts. */}
        <PerfUseful />
        <PageHeader
          title="Stock movements"
          titleId={MOVEMENTS_TITLE_ID}
          subline="Every quantity change, audited. The ledger is append-only."
          actions={
            instantLedger ? (
              <MovementsExportButton />
            ) : serverControls ? (
              <MovementsExportButton href={exportHref} />
            ) : undefined
          }
        />

        {/* Server mode: the type chips, then search, dates and the top pager,
            the same rows MovementsInstantTable renders in instant mode. */}
        {serverControls && (
          <MovementsFilterBar
            mode="server"
            initial={activeFilters}
            trailing={
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={total}
                totalPages={totalPages}
                hasNext={hasNext}
                basePath="/dashboard/movements"
                baseParams={movementsBaseParams}
                className="flex-wrap"
              />
            }
          />
        )}

        {!instant && total === 0 && hasActiveFilters ? (
          // Server mode, filtered count is 0: a no-match filter must stay
          // visible (and clearable), not get swallowed by the "ledger's
          // truly empty" state below — otherwise the user can't tell why
          // nothing showed up or how to get back to an unfiltered view.
          <StatePanel
            kind="no-match"
            title={NO_MATCH.title}
            description={NO_MATCH.description}
            action={<StateLink href="/dashboard/movements">Clear filters</StateLink>}
          />
        ) : total === 0 ? (
          <StatePanel
            kind="empty"
            icon={ArrowLeftRight}
            title={EMPTY_LEDGER.title}
            description={EMPTY_LEDGER.description}
            action={<StateLink href="/dashboard/inventory">Go to inventory</StateLink>}
          />
        ) : instant ? (
          <MovementsInstantTable rows={instantRows} canEditNotes={canEditNotes} timeZone={timeZone} />
        ) : visible.length === 0 ? (
          hasActiveFilters ? (
            <StatePanel
              kind="no-match"
              title={NO_MATCH.title}
              description={NO_MATCH.description}
              action={<StateLink href="/dashboard/movements">Clear filters</StateLink>}
            />
          ) : page === 1 ? (
            <StatePanel
              kind="empty"
              icon={ArrowLeftRight}
              title={EMPTY_LEDGER.title}
              description={EMPTY_LEDGER.description}
              action={<StateLink href="/dashboard/inventory">Go to inventory</StateLink>}
            />
          ) : (
            <StatePanel
              kind="empty"
              icon={ArrowLeftRight}
              title="End of the ledger"
              description="You've scrolled past the oldest movement. Head back to page one to see recent activity."
              action={<StateLink href="/dashboard/movements">Back to newest</StateLink>}
            />
          )
        ) : (
          <MovementsTable
            rows={visible.map((m) => toDisplayRow(m, timeZone))}
            canEditNotes={canEditNotes}
            footer={
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={total}
                totalPages={totalPages}
                hasNext={hasNext}
                basePath="/dashboard/movements"
                baseParams={movementsBaseParams}
              />
            }
          />
        )}
      </div>
    </MovementsInstantFiltersProvider>
  );
}

function clampPage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.max(Math.floor(n), 1), 10_000);
}
