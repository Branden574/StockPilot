import { parseCycleCountStatusFilter, parsePageParam } from '@stockpilot/core';

export const CYCLE_COUNT_LIST_PATH = '/dashboard/cycle-counts';

/**
 * The one way to spell a history-list URL: `?q=` when searching, `?status=`
 * when filtered, `?page=` only past page 1. The page component, the search
 * box, the status filter, the pager and the detail page's back link all build
 * URLs here, so the same view always has the same URL (and a redirect that
 * canonicalises `?page=` compares like with like).
 */
export function cycleCountListHref(state: {
  q?: string | null;
  status?: string | null;
  page?: number | null;
}): string {
  const sp = new URLSearchParams();
  const q = (state.q ?? '').trim();
  if (q) sp.set('q', q);
  const status = parseCycleCountStatusFilter(state.status);
  if (status) sp.set('status', status);
  const page = state.page ?? 1;
  if (page > 1) sp.set('page', String(page));
  const qs = sp.toString();
  return qs ? `${CYCLE_COUNT_LIST_PATH}?${qs}` : CYCLE_COUNT_LIST_PATH;
}

/**
 * Rebuilds a list URL from a stored query string, keeping ONLY the list's own
 * parameters (q, status, page) and re-serialising them. Anything else in the
 * stored value is dropped, so a tampered session value can at worst change
 * which page of the list the back link opens, never where it points.
 */
export function cycleCountListHrefFromQuery(query: string | null | undefined): string {
  if (!query) return CYCLE_COUNT_LIST_PATH;
  let sp: URLSearchParams;
  try {
    sp = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  } catch {
    return CYCLE_COUNT_LIST_PATH;
  }
  return cycleCountListHref({
    q: sp.get('q'),
    status: sp.get('status'),
    page: parsePageParam(sp.get('page') ?? undefined),
  });
}
