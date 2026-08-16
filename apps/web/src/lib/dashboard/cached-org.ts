import 'server-only';

import {
  parseOrgEmailRouting,
  resolveOrgTimezone,
  type OrgEmailRoutingFeature,
  type OrgEmailRoutingReadState,
} from '@stockpilot/core';

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Org-level lookups for the (dashboard) layout + PDF routes.
 *
 * NOTE on caching: this file previously wrapped these queries in
 * `unstable_cache(...)`, but that triggered digest-only 500s in the
 * Server Action POST response render under Next.js 16 (chased through
 * commits 91806fe / 9ae5251). Until we land a confirmed-safe caching
 * pattern, these are direct queries. The DB hit is small (single row
 * by primary key) and the layout's other 4 parallel queries dominate
 * the layout's latency anyway.
 *
 * Function names kept intentionally so call sites don't need to
 * change — only the implementation differs.
 */
export async function getCachedOrgDashboardRow(organizationId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('organizations')
    .select('terminology, mfa_policy, logo_url, timezone')
    .eq('id', organizationId)
    .maybeSingle();
  if (error) return null;
  return data as {
    terminology: unknown;
    mfa_policy: 'optional' | 'admins_required' | 'all_required' | null;
    logo_url: string | null;
    timezone: string | null;
  } | null;
}

export async function getCachedOrgWarehouses(organizationId: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('warehouses')
    .select('id, name')
    .eq('organization_id', organizationId)
    .neq('status', 'archived')
    .order('name', { ascending: true });
  return (data ?? []) as Array<{ id: string; name: string }>;
}

/**
 * The org's display timezone, never null and never ''.
 *
 * THE FALLBACK IS `resolveOrgTimezone`'s, NOT THIS FILE'S (changed 2026-08-13;
 * this used to return a hardcoded `'UTC'`).
 *
 * The hardcoded default was a SECOND answer to a question core already
 * answered. Mobile's delivery-request mapping resolved the same missing read to
 * `ORG_TIMEZONE_DEFAULT` (America/Los_Angeles), so one order stated a Pacific
 * needed-by time on the phone and a UTC one on the web — 7-8 hours apart, and a
 * different CALENDAR DAY for any needed-by after 16:00 Pacific — in mail to the
 * same warehouse. Deleting the duplicate is what makes the two agree; picking
 * which one survives is argued on `resolveOrgTimezone`.
 *
 * WHEN THIS ACTUALLY CHANGES ANYTHING: `organizations.timezone` is NOT NULL
 * DEFAULT 'UTC', so an org that never touched the setting still reads a real
 * stored 'UTC' and is returned unchanged. The fallback only fires when the ROW
 * does not come back — org missing, or `getCachedOrgDashboardRow` swallowing a
 * query error — and for the 3 orgs in prod (all 'America/Los_Angeles',
 * 2026-08-13) it fires never. The callers that move with it are the three
 * packing/pick-slip PDF routes, the order print page, the storefront and the
 * order detail page: all of them render org-local times, and all of them now
 * degrade to the same zone as every other surface instead of to a zone nobody
 * operates on.
 */
export async function getCachedOrgTimezone(organizationId: string): Promise<string> {
  const row = await getCachedOrgDashboardRow(organizationId);
  return resolveOrgTimezone(row?.timezone);
}

/**
 * The org's per-feature compose-email routing (`organizations.email_routing`,
 * migration 0337), resolved through core's ONE parser.
 *
 * DIRECT query, not unstable_cache — this file's header note applies, and
 * freshness matters here specifically: an admin's routing edit must be
 * visible on the next page load, because the value decides where warehouse
 * mail is addressed.
 *
 * DEPLOY-ORDER SAFETY: this feature must FAIL OPEN to pre-feature behavior
 * during the code-before-migration window. A read of the not-yet-existing
 * column errors with Postgres 42703 (undefined_column, surfaced verbatim by
 * PostgREST), and ONLY that error maps to `{ state: 'fallback' }` — which
 * readers resolve to the compiled L4L constants, byte-identical to what
 * shipped before this feature. Once the column exists, that arm is never
 * taken: an org with no stored value is 'unset' and its email action is
 * HIDDEN, and an org with an invalid stored value is 'invalid' and fails
 * CLOSED (never silently re-routed to another tenant's mailboxes).
 *
 * Any OTHER read failure (row missing, transient query error) resolves to
 * 'unset' — the action hides for a beat rather than composing mail against
 * recipients we could not read.
 */
export async function getOrgEmailRouting(
  organizationId: string,
  feature: OrgEmailRoutingFeature,
): Promise<OrgEmailRoutingReadState> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('organizations')
    .select('email_routing')
    .eq('id', organizationId)
    .maybeSingle();
  if (error) {
    if (error.code === '42703') return { state: 'fallback' };
    console.error('[email-routing] read failed', error.code, error.message);
    return { state: 'unset' };
  }
  if (!data) return { state: 'unset' };
  return parseOrgEmailRouting((data as { email_routing?: unknown }).email_routing, feature);
}
