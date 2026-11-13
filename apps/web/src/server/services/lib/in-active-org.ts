import 'server-only';

import { ServiceError, type ServiceContext } from '../context';

/** The tables a write keyed by a row id reads in the active organization first (S39, S41). */
export type ActiveOrgTable =
  | 'order_requests'
  | 'cycle_counts'
  | 'purchase_orders'
  | 'receipts'
  | 'warehouses'
  | 'bundles'
  | 'stock_movements'
  | 'price_lists'
  | 'customers';

/**
 * The row read in the ACTIVE organization, before a write that names it by id
 * runs (S39).
 *
 * A person can belong to more than one organization, and switching changes the
 * active one for every open tab (the switcher rewrites the default for the
 * whole account) while a phone screen keeps its row. A page left open on
 * organization B's row then sends B's id with A's context. The functions
 * behind these writes decide on the ROW's own organization, so for a member of
 * both the change ran in B, under A's gates, while the service wrote the audit
 * row, the webhook, the notices and the cache invalidation into A. A miss here
 * answers like a missing row, before anything runs: the rule the returns
 * service applies before every RMA function (returns.ts factsInActiveOrg).
 *
 * Reads through the caller's own client, so RLS applies and the row is visible
 * exactly when the screens show it. Takes the context explicitly and never
 * resolves one (requireOrgContext redirects inside an /api route or the AI
 * tool, pattern #23). A failed read throws internal_error, never not_found: a
 * gate in a write never proceeds on, or answers from, a read that did not
 * happen.
 *
 * `columns` selects what the caller decides on as well (cancel reads the
 * requester and the status); `notFound` is the caller's own sentence, so the
 * code stays not_found (404) and each site keeps its words.
 */
export async function readInActiveOrg<Row = { id: string }>(
  ctx: Pick<ServiceContext, 'supabase' | 'organizationId'>,
  table: ActiveOrgTable,
  id: string,
  notFound: string,
  columns = 'id',
): Promise<Row> {
  const { data, error } = await ctx.supabase
    .from(table)
    .select(columns)
    .eq('organization_id', ctx.organizationId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new ServiceError('internal_error', error.message);
  if (!data) throw new ServiceError('not_found', notFound);
  return data as unknown as Row;
}
