import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

import { resolveEffectivePlan, type EffectivePlan } from '@stockpilot/core';

/**
 * Cross-org READ services for the Platform Super-Admin Console.
 *
 * This is the ONLY place that crosses organization boundaries, and it does
 * so deliberately: every function uses the SERVICE-ROLE admin client (which
 * bypasses RLS) and returns plain DTOs. There is NO RLS weakening anywhere —
 * tenant isolation for the normal app is untouched. The CALLER must have
 * passed `requirePlatformAdmin()` (the gate) before invoking these; these
 * functions assume that and do not re-fetch the session.
 *
 * Read-only by design (Phase 1 viewing). Mutations (billing, password reset,
 * act-as) live in their own services with their own audit + step-up.
 */

export interface PlatformOrgSummary {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  createdAt: string;
  effective: EffectivePlan;
  /** Raw billing-arrangement label as stored (for badges). */
  billingArrangement: string;
  memberCount: number;
  itemCount: number;
}

/**
 * Lists every organization on the platform (newest first), with the resolved
 * effective plan + member/item counts for the Org Directory. `search` filters
 * by name or slug (case-insensitive). Bounded to 500 rows — the directory is
 * an operator tool, not a paginated public list; if the platform ever exceeds
 * that, add keyset pagination (disclosed cap, not a silent slice).
 */
export async function listOrgsForPlatform(
  search?: string,
  now: number = Date.now(),
): Promise<{ orgs: PlatformOrgSummary[]; capped: boolean }> {
  const admin = createAdminClient();
  const LIMIT = 500;

  let q = admin
    .from('organizations')
    .select(
      'id, name, slug, industry, created_at, plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
    )
    .order('created_at', { ascending: false })
    .limit(LIMIT + 1);

  const term = search?.trim();
  if (term) {
    // ilike on name OR slug — escape PostgREST's % and , metacharacters.
    const safe = term.replace(/[%,()]/g, ' ');
    q = q.or(`name.ilike.%${safe}%,slug.ilike.%${safe}%`);
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const capped = rows.length > LIMIT;
  const page = capped ? rows.slice(0, LIMIT) : rows;
  const ids = page.map((r) => r.id as string);

  // Counts in two grouped passes (head+count per org would be N+1). Use the
  // admin client + a single in() select, then tally client-side. Bounded by
  // the ≤500 org cap above.
  const [members, items] = await Promise.all([
    admin
      .from('organization_members')
      .select('organization_id')
      .in('organization_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
      .not('accepted_at', 'is', null),
    admin
      .from('inventory_items')
      .select('organization_id')
      .in('organization_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
      .is('deleted_at', null),
  ]);

  const memberCounts = tally((members.data ?? []) as Array<{ organization_id: string }>);
  const itemCounts = tally((items.data ?? []) as Array<{ organization_id: string }>);

  const orgs: PlatformOrgSummary[] = page.map((r) => {
    const id = r.id as string;
    return {
      id,
      name: r.name as string,
      slug: r.slug as string,
      industry: (r.industry as string | null) ?? null,
      createdAt: r.created_at as string,
      effective: resolveEffectivePlan(
        {
          plan: (r.plan as string | null) ?? null,
          access_tier: (r.access_tier as string | null) ?? null,
          billing_arrangement: (r.billing_arrangement as string | null) ?? null,
          stripe_subscription_id: (r.stripe_subscription_id as string | null) ?? null,
          trial_ends_at: (r.trial_ends_at as string | null) ?? null,
          trial_tier: (r.trial_tier as string | null) ?? null,
        },
        now,
      ),
      billingArrangement: (r.billing_arrangement as string | null) ?? 'standard',
      memberCount: memberCounts.get(id) ?? 0,
      itemCount: itemCounts.get(id) ?? 0,
    };
  });

  return { orgs, capped };
}

/**
 * Counts grouped rows by organization_id. The select is capped by the ≤500
 * org filter, but a busy org could itself exceed PostgREST's 1000-row cap on
 * the members/items selects. We accept undercounting on the directory summary
 * (a display nicety, not an enforcement number) rather than paginating here;
 * the per-org detail page (Phase 1) shows exact counts.
 */
function tally(rows: Array<{ organization_id: string }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.organization_id, (m.get(r.organization_id) ?? 0) + 1);
  return m;
}
