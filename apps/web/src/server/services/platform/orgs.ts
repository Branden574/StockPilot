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

// ── Per-org detail reads (Phase 1) — all read-only, service-role, gated ──────

/** Disclosed preview cap for the detail tabs — an operator overview, not the
 *  full app. Exact totals come from the head-count queries in the overview. */
export const DETAIL_PREVIEW_LIMIT = 100;

export interface PlatformOrgOverview {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  size: string | null;
  timezone: string | null;
  currency: string | null;
  createdAt: string;
  ownerEmail: string | null;
  effective: EffectivePlan;
  billingArrangement: string;
  counts: { members: number; items: number; orders: number; warehouses: number };
}

/** Full overview for one org. Returns null when the org id doesn't exist. */
export async function getOrgOverview(
  orgId: string,
  now: number = Date.now(),
): Promise<PlatformOrgOverview | null> {
  const admin = createAdminClient();
  const { data: org, error } = await admin
    .from('organizations')
    .select(
      'id, name, slug, industry, size, timezone, currency, created_at, plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
    )
    .eq('id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!org) return null;
  const r = org as Record<string, unknown>;

  const [members, items, orders, warehouses, owner] = await Promise.all([
    admin
      .from('organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .not('accepted_at', 'is', null),
    admin
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .is('deleted_at', null),
    admin
      .from('order_requests')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId),
    admin
      .from('warehouses')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .neq('status', 'archived'),
    admin
      .from('organization_members')
      .select('user_profiles:user_id (email)')
      .eq('organization_id', orgId)
      .eq('role', 'owner')
      .not('accepted_at', 'is', null)
      .limit(1)
      .maybeSingle(),
  ]);

  const ownerProfile = (owner.data as { user_profiles: { email: string } | { email: string }[] | null } | null)
    ?.user_profiles;
  const ownerEmail = Array.isArray(ownerProfile)
    ? (ownerProfile[0]?.email ?? null)
    : (ownerProfile?.email ?? null);

  return {
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    industry: (r.industry as string | null) ?? null,
    size: (r.size as string | null) ?? null,
    timezone: (r.timezone as string | null) ?? null,
    currency: (r.currency as string | null) ?? null,
    createdAt: r.created_at as string,
    ownerEmail,
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
    counts: {
      members: members.count ?? 0,
      items: items.count ?? 0,
      orders: orders.count ?? 0,
      warehouses: warehouses.count ?? 0,
    },
  };
}

export interface PlatformOrgBillingState {
  accessTier: string | null;
  arrangement: string;
  customPriceCents: number | null;
  customPriceInterval: 'month' | 'year' | null;
  allModulesComp: boolean;
  billingNotes: string | null;
  trialTier: string | null;
  trialEndsAt: string | null;
  hasStripeSubscription: boolean;
  effective: EffectivePlan;
}

/** Raw stored billing override fields for the billing panel form. */
export async function getOrgBillingState(
  orgId: string,
  now: number = Date.now(),
): Promise<PlatformOrgBillingState | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('organizations')
    .select(
      'plan, access_tier, billing_arrangement, custom_price_cents, custom_price_interval, all_modules_comp, billing_notes, trial_tier, trial_ends_at, stripe_subscription_id',
    )
    .eq('id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    accessTier: (r.access_tier as string | null) ?? null,
    arrangement: (r.billing_arrangement as string | null) ?? 'standard',
    customPriceCents: r.custom_price_cents == null ? null : Number(r.custom_price_cents),
    customPriceInterval: (r.custom_price_interval as 'month' | 'year' | null) ?? null,
    allModulesComp: Boolean(r.all_modules_comp),
    billingNotes: (r.billing_notes as string | null) ?? null,
    trialTier: (r.trial_tier as string | null) ?? null,
    trialEndsAt: (r.trial_ends_at as string | null) ?? null,
    hasStripeSubscription: Boolean(r.stripe_subscription_id),
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
  };
}

export interface PlatformOrgItem {
  id: string;
  name: string;
  sku: string | null;
  quantityOnHand: number;
  unitCost: number | null;
  status: string | null;
}

/** Top items for the inventory tab (preview-capped, read-only). */
export async function getOrgInventory(orgId: string): Promise<PlatformOrgItem[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('inventory_items')
    .select('id, name, sku, quantity_on_hand, unit_cost, status')
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .order('name', { ascending: true })
    .limit(DETAIL_PREVIEW_LIMIT);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    sku: (r.sku as string | null) ?? null,
    quantityOnHand: Number(r.quantity_on_hand) || 0,
    unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
    status: (r.status as string | null) ?? null,
  }));
}

export interface PlatformOrgMember {
  userId: string | null;
  email: string | null;
  fullName: string | null;
  role: string;
  joinedAt: string | null;
}

/** Members for the users tab — includes the user id so the reset button can target it. */
export async function getOrgMembers(orgId: string): Promise<PlatformOrgMember[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('organization_members')
    .select('user_id, role, accepted_at, user_profiles:user_id (email, full_name)')
    .eq('organization_id', orgId)
    .not('accepted_at', 'is', null)
    .order('accepted_at', { ascending: true })
    .limit(DETAIL_PREVIEW_LIMIT);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const prof = r.user_profiles as { email: string; full_name: string | null } | { email: string; full_name: string | null }[] | null;
    const p = Array.isArray(prof) ? (prof[0] ?? null) : prof;
    return {
      userId: (r.user_id as string | null) ?? null,
      email: p?.email ?? null,
      fullName: p?.full_name ?? null,
      role: r.role as string,
      joinedAt: (r.accepted_at as string | null) ?? null,
    };
  });
}

export interface PlatformOrgOrder {
  id: string;
  status: string;
  requester: string | null;
  createdAt: string;
}

/** Recent orders for the orders tab (preview-capped, read-only). */
export async function getOrgOrders(orgId: string): Promise<PlatformOrgOrder[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('order_requests')
    .select('id, status, requester_name, requester_email, created_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(DETAIL_PREVIEW_LIMIT);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    status: r.status as string,
    requester: (r.requester_name as string | null) ?? (r.requester_email as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}
