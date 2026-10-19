/**
 * The Procedures list's URL state: `q`, `cat`, `wh`, `page` and `view`.
 *
 * Every link the list draws (category chips, the pager, Clear) is built here
 * as a full `/dashboard/procedures...` path. A bare query string is relative
 * to the current URL, and the empty one ("All" with only a category chosen)
 * pointed at the current URL itself, so the chip never cleared the category
 * (seen at 36cb9b619 on the lab: clicking All on `?cat=<Safety>` stayed on
 * Safety).
 */

export const PROCEDURES_PATH = '/dashboard/procedures';

export type RawSearchParams = Record<string, string | string[] | undefined>;

export interface ProcedureListState {
  q: string;
  cat: string;
  wh: string;
  page: number;
  archived: boolean;
}

/**
 * The first value of a search parameter. A parameter repeated in the URL
 * arrives as an array: the filter form used to send `wh` twice (a hidden
 * field and the select), and `.trim()` on that array threw, so the page
 * fell to the error boundary (CONFLICTS D21). Old links of that shape still
 * open the list.
 */
export function firstParam(value: string | string[] | undefined): string {
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === 'string' ? one.trim() : '';
}

export function parseProcedureListParams(params: RawSearchParams): ProcedureListState {
  return {
    q: firstParam(params.q),
    cat: firstParam(params.cat),
    wh: firstParam(params.wh),
    page: Math.max(1, Number.parseInt(firstParam(params.page) || '1', 10) || 1),
    archived: firstParam(params.view) === 'archived',
  };
}

export interface ProcedureListOverrides {
  q?: string;
  cat?: string;
  wh?: string;
  page?: number;
}

/** The list URL for the current state with `overrides` applied. */
export function procedureListHref(
  state: ProcedureListState,
  overrides: ProcedureListOverrides = {},
): string {
  const merged = {
    q: state.q,
    cat: state.cat,
    wh: state.wh,
    page: state.page,
    ...overrides,
  };
  const sp = new URLSearchParams();
  if (merged.q) sp.set('q', merged.q);
  if (merged.cat) sp.set('cat', merged.cat);
  if (merged.wh) sp.set('wh', merged.wh);
  if (merged.page > 1) sp.set('page', String(merged.page));
  if (state.archived) sp.set('view', 'archived');
  const s = sp.toString();
  return s ? `${PROCEDURES_PATH}?${s}` : PROCEDURES_PATH;
}

/** Clear: back to the plain list, keeping the Archived view when it is open. */
export function procedureListClearHref(state: ProcedureListState): string {
  return state.archived ? `${PROCEDURES_PATH}?view=archived` : PROCEDURES_PATH;
}
