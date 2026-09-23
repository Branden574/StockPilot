/**
 * The cycle-count HISTORY list on the phone: pure pieces the screen
 * (app/(drawer)/(tabs)/cycle-counts.tsx) is built from, here so the node test
 * runner can exercise them (app/ is excluded from vitest).
 *
 * Online, the list is whatever GET /api/v1/cycle-counts answers for the
 * current search, status and page: the same CycleCountsService.listPage() the
 * web renders, 25 sessions per page, newest first, searched on the server
 * across the whole history the member may see.
 *
 * Offline, the phone can only search what it has DOWNLOADED (the open counts
 * the sync snapshot keeps). That is said on screen ("Searching downloaded
 * counts only"), no page past the downloaded set is requested, and nothing
 * the screen shows is ever handed to the sync code as a complete set: a UI
 * page is not a snapshot, and the snapshot's own cleanup rules are untouched.
 */

import {
  parseCycleCountSearch,
  type CycleCountStatusValue,
  type ListPage,
} from '@stockpilot/core';

import type { CachedCycleCountHeader } from './cycle-count-cache';

/** One count session as the list API returns it. */
export interface CycleCountListItem {
  id: string;
  countNumber: number | null;
  warehouseId: string | null;
  warehouseName: string | null;
  scope: 'warehouse' | 'selection';
  status: string;
  notes: string | null;
  startedBy: string | null;
  startedByName: string | null;
  startedAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  lineTotal: number;
  lineCounted: number;
}

export interface CycleCountListSummary {
  inProgress: number;
  startedToday: number;
  timezone: string;
}

export type CycleCountListResponse = ListPage<CycleCountListItem> & {
  /** The workspace the answer belongs to (a late answer for a workspace the
   *  user has switched away from is dropped). */
  organizationId: string;
  /** Present when asked for; null when the server could not read the totals. */
  summary?: CycleCountListSummary | null;
};

/** What the list is showing: the search box, the status filter, the page. */
export interface CycleCountListView {
  q: string;
  status: CycleCountStatusValue | null;
  page: number;
}

export const INITIAL_LIST_VIEW: CycleCountListView = { q: '', status: null, page: 1 };

/** The request path for a view. `summary` asks for the tile totals too. */
export function cycleCountListPath(view: CycleCountListView, opts: { summary?: boolean } = {}): string {
  const sp = new URLSearchParams();
  const q = view.q.trim();
  if (q) sp.set('q', q);
  if (view.status) sp.set('status', view.status);
  if (view.page > 1) sp.set('page', String(view.page));
  if (opts.summary) sp.set('summary', '1');
  const qs = sp.toString();
  return qs ? `/api/v1/cycle-counts?${qs}` : '/api/v1/cycle-counts';
}

/**
 * True when a list answer may replace what is on screen: it is the newest
 * request (the sequence guard) AND it belongs to the workspace still active.
 * An answer from before a workspace switch, or for an older search or page,
 * is dropped whether it arrives first or last.
 */
export function isCurrentListAnswer(
  answer: Pick<CycleCountListResponse, 'organizationId'>,
  activeOrgId: string | null,
  isNewestRequest: boolean,
): boolean {
  return isNewestRequest && activeOrgId !== null && answer.organizationId === activeOrgId;
}

/**
 * Offline: search the counts this device has downloaded, with the same rules
 * the server applies (a reference-shaped query is an exact number match;
 * other text matches the notes and warehouse name, case-insensitively), in
 * the same order (started_at DESC, id DESC). It can only ever describe the
 * download, which the screen says in words.
 */
export function searchDownloadedCounts(
  cached: CachedCycleCountHeader[],
  view: Pick<CycleCountListView, 'q' | 'status'>,
): CachedCycleCountHeader[] {
  const search = parseCycleCountSearch(view.q);
  const needle = search.kind === 'text' ? search.text.toLocaleLowerCase() : null;
  return cached
    .filter((c) => (view.status ? c.status === view.status : true))
    .filter((c) => {
      if (search.kind === 'all') return true;
      if (search.kind === 'number') return c.countNumber != null && c.countNumber === search.number;
      return (
        (c.notes ?? '').toLocaleLowerCase().includes(needle as string) ||
        (c.warehouseName ?? '').toLocaleLowerCase().includes(needle as string)
      );
    })
    .sort((a, b) => {
      const at = Date.parse(a.startedAt) || 0;
      const bt = Date.parse(b.startedAt) || 0;
      if (at !== bt) return bt - at;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
}

/**
 * The view last shown for each workspace, kept for the life of the app
 * process, so leaving the list (opening a count, visiting another screen)
 * and coming back restores the same search, filter and page even when the
 * screen was unmounted. Per workspace: another workspace starts clean.
 */
const lastViewByOrg = new Map<string, CycleCountListView>();

export function rememberListView(orgId: string | null, view: CycleCountListView): void {
  if (orgId) lastViewByOrg.set(orgId, view);
}

export function recallListView(orgId: string | null): CycleCountListView {
  return (orgId ? lastViewByOrg.get(orgId) : undefined) ?? INITIAL_LIST_VIEW;
}

/** For tests only. */
export function forgetListViews(): void {
  lastViewByOrg.clear();
}
