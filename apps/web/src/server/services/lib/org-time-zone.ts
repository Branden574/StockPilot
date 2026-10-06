import 'server-only';

import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { reportError } from '@/lib/error-reporter';

import { resolveOrgTimezone } from '@stockpilot/core';

import type { ServiceContext } from '../context';

/**
 * The organization's zone (organizations.timezone) for a service that decides
 * a DAY in it: a purchase order is overdue, and a delivery late, only after its
 * expected date has passed in the organization's zone (core isPastExpectedDay).
 * Never null and never a throw.
 *
 * WHERE IT COMES FROM. On the request's own cookie session (a withContext()
 * context whose client IS the cookie client it made, compared by identity as
 * getWarehouseAccess does), the request-cached org row the dashboard layout
 * and the pages already read, normally in hand from the membership bundle, so
 * a page pays no round trip for it. Any other client (a phone's Bearer call, a
 * cron's service role) reads the row through that client: a member reads their
 * own organization's row, the service role every row.
 *
 * A FAILED READ is the documented default zone (resolveOrgTimezone, as every
 * org-time surface degrades) and is reported under the caller's tag, as the
 * calendar page does, instead of failing the count. A missing row, an empty
 * zone or one this runtime does not know is the default too, without a
 * report (resolveOrgTimezone's own rule).
 */
export async function orgTimeZoneFor(ctx: ServiceContext, tag: string): Promise<string> {
  try {
    if (ctx.cookieClient !== undefined && ctx.cookieClient === ctx.supabase) {
      const org = await getOrgRowForRequest(ctx.organizationId);
      return resolveOrgTimezone(org?.timezone);
    }
    const { data, error } = await ctx.supabase
      .from('organizations')
      .select('timezone')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    if (error) throw new Error(`organizations.timezone read failed: ${error.message}`);
    return resolveOrgTimezone((data as { timezone?: string | null } | null)?.timezone);
  } catch (e) {
    void reportError(e, { tag, level: 'warning', organizationId: ctx.organizationId });
    return resolveOrgTimezone(null);
  }
}
