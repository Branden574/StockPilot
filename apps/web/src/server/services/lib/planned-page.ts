import 'server-only';

import type { DisplayGroupRef } from '@stockpilot/core';

import {
  planGroupAwarePage,
  type InstantModeSort,
  type PlannedServerPage,
} from '@/lib/inventory/instant-mode';
import { IN_FILTER_MAX_VALUES } from '@/lib/supabase/in-filter';

import type { InventoryService, ItemListFilters } from '../inventory';

import { readDisplayGroupsForOrgAsMember } from './display-groups';

/**
 * Phase 2 of the grouping brief (owner 2026-10-11, go to start 2026-10-12):
 * the Items and Books lists' LIVE path (staff, viewers, and anyone over the
 * shared cache) used to read fixed 30-row slices sorted by last update, and
 * the table grouped size runs, SKU families and display groups over the page
 * it had, so a unit whose records sorted far apart was split across pages:
 * the reported XS of a T-shirt alone on page 2 while its seven other sizes
 * showed as the run on page 1, and a staff member ordered every size but XS.
 *
 * planLivePage reads the WHOLE filtered view as light rows (listPlanRows,
 * through the caller's own client, capped at the instant-mode limit) and the
 * organization's display group memberships (through the caller's own client)
 * in parallel, and plans the page with the rule managers' instant mode pages
 * with (planGroupAwarePage), so a staff member's page holds the same units,
 * in the same order, as a manager's. readPlannedPage then reads exactly that
 * page in full. Over the cap, or when the scan fails, there is no plan and
 * the page keeps its fixed slices. The memberships serve the page's rows
 * either way.
 */

type ListResult = Awaited<ReturnType<InventoryService['list']>>;
type Tag = <T>(label: string, p: Promise<T>) => Promise<T>;

const untagged: Tag = (_label, p) => p;

export interface LivePagePlan {
  /** The planned page, or null (over the cap, or the scan failed). */
  plannedPage: PlannedServerPage | null;
  /** The whole view's totals the plan was made over (null with no plan). */
  totals: { total: number; valueOnHand: number } | null;
  /** The organization's memberships the caller can read (empty when the read
   *  failed: the records render ungrouped). */
  displayGroups: Map<string, DisplayGroupRef>;
}

export async function planLivePage(args: {
  inventorySvc: InventoryService;
  viewFilters: ItemListFilters;
  sort: InstantModeSort;
  page: number;
  pageSize: number;
  view: 'items' | 'books';
  client: Parameters<typeof readDisplayGroupsForOrgAsMember>[0];
  organizationId: string;
  /** Where a failed scan is logged from ("[inventory page]"). */
  logLabel: string;
  tag?: Tag;
}): Promise<LivePagePlan> {
  const tag = args.tag ?? untagged;
  const [planRows, displayGroups] = await Promise.all([
    tag('inventorySvc.listPlanRows', args.inventorySvc.listPlanRows(args.viewFilters)).catch(
      (err: unknown) => {
        console.warn(`${args.logLabel} page plan unavailable, using fixed pages:`, err);
        return null;
      },
    ),
    tag(
      'displayGroups.forOrgAsMember',
      readDisplayGroupsForOrgAsMember(args.client, args.organizationId),
    ),
  ]);
  if (!planRows) return { plannedPage: null, totals: null, displayGroups };
  const plannedPage = planGroupAwarePage(
    planRows.rows.map((r) => ({
      ...r,
      primary_location_id: null,
      charter_id: null,
      display_group_id: displayGroups.get(r.id)?.id ?? null,
    })),
    args.sort,
    args.page,
    args.pageSize,
    args.view,
  );
  return {
    plannedPage,
    totals: { total: planRows.total, valueOnHand: planRows.valueOnHand },
    displayGroups,
  };
}

/**
 * Read a planned page in full: exactly its records, in at most
 * IN_FILTER_MAX_VALUES ids per read (a page runs long to keep a unit whole,
 * and a display group holds up to 200 records), every read with the view's
 * filters and the planned totals so none scans the view again. The rows come
 * back in the planned order.
 */
export async function readPlannedPage(
  inventorySvc: InventoryService,
  viewFilters: ItemListFilters,
  pageIds: readonly string[],
  totals: { total: number; valueOnHand: number },
): Promise<ListResult> {
  if (pageIds.length === 0) {
    return {
      items: [],
      total: totals.total,
      valueOnHand: totals.valueOnHand,
      elsewhereUnavailable: false,
    };
  }
  const reads: Array<Promise<ListResult>> = [];
  for (let i = 0; i < pageIds.length; i += IN_FILTER_MAX_VALUES) {
    const ids = pageIds.slice(i, i + IN_FILTER_MAX_VALUES);
    reads.push(
      inventorySvc.list({
        ...viewFilters,
        ids,
        limit: ids.length,
        offset: 0,
        plannedTotals: { total: totals.total, valueOnHand: totals.valueOnHand },
        // The placement columns add holdings up next to on hand, so they
        // need the stock a staff member or viewer cannot see (0371).
        withElsewhere: true,
      }),
    );
  }
  const parts = await Promise.all(reads);
  const byId = new Map(parts.flatMap((p) => p.items).map((it) => [it.id, it]));
  const items = pageIds.flatMap((id) => {
    const it = byId.get(id);
    return it ? [it] : [];
  });
  return {
    items,
    total: totals.total,
    valueOnHand: totals.valueOnHand,
    elsewhereUnavailable: parts.some((p) => p.elsewhereUnavailable),
  };
}
