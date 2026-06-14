import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { MfaRequiredBanner } from '@/components/dashboard/mfa-required-banner';
import { ImpersonationBanner } from '@/components/platform/impersonation-banner';
import { InventoryRealtime } from '@/components/realtime/inventory-realtime';
import { requireOrgContext } from '@/lib/auth/session';
import {
  getMfaFactorsForRequest,
  getModulesForRequest,
  getOrgRowForRequest,
  getWarehousesForRequest,
} from '@/lib/dashboard/request-cache';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { createClient } from '@/lib/supabase/server';

import { ROLE_LABELS, resolveTerminology } from '@stockpilot/core';

// Override the root layout's marketing title for everything under
// /dashboard. Without this, every dashboard page that doesn't export
// its own `metadata.title` inherits "StockPilot — Inventory you'll
// actually enjoy using" — confusing in the browser tab when the user
// is deep in /dashboard/inventory or /dashboard/orders.
//
// Pages that DO export a title still get the root layout's
// `%s · StockPilot` template; pages that DON'T fall back to
// "Dashboard · StockPilot" instead of the marketing string.
export const metadata: Metadata = {
  title: {
    // Just "Dashboard" — the root layout's `%s · StockPilot` template
    // wraps this into "Dashboard · StockPilot". Putting the full
    // "Dashboard · StockPilot" here was double-wrapping into
    // "Dashboard · StockPilot · StockPilot".
    default: 'Dashboard',
    template: '%s · StockPilot',
  },
};

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Cached: this resolves with the same data the page will use in the
  // same render — zero extra DB round trips beyond the page's own.
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  // Layout-blocking parallel fan-out. Org row, warehouses list, and MFA
  // factors go through request-cached helpers so the dashboard page (or
  // any other page in this layout) reuses the same fetch instead of
  // re-issuing the same Supabase queries in its own Promise.all.
  const [
    access,
    activeWarehouseId,
    orgRow,
    mfaFactors,
    membershipsRes,
    unreadRes,
    warehousesList,
    enabledModuleSet,
  ] = await Promise.all([
    getWarehouseAccess(),
    getActiveWarehouseFilter(),
    getOrgRowForRequest(ctx.organizationId),
    getMfaFactorsForRequest(),
    supabase
      .from('organization_members')
      .select('role, organizations:organization_id (id, name, logo_url)')
      .eq('user_id', ctx.userId)
      .not('accepted_at', 'is', null),
    supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', ctx.userId)
      .eq('organization_id', ctx.organizationId)
      .is('read_at', null),
    getWarehousesForRequest(ctx.organizationId),
    // Request-cached: shares ONE organization_modules round-trip with
    // withContext() in the same render. The helper logs + fails closed
    // (empty set = core-only nav) on a query error, same as the prior
    // inline query did.
    getModulesForRequest(ctx.organizationId),
  ]);
  const initialUnreadNotifications = unreadRes.count ?? 0;

  // Module IDs enabled for this org, serialized as plain strings so the
  // client DashboardShell/Sidebar can reconstruct a Set across the RSC
  // boundary. Core modules are always treated as enabled by the resolver
  // regardless of this list, so a grandfathered org with no rows still gets
  // the full core nav.
  //
  // Fail CLOSED on a query error: `getModulesForRequest` logs the failure and
  // returns an empty set → core-only nav (optional modules hidden), never a
  // fuller nav than the org is entitled to (mirrors resolveMfaState /
  // resolveApiEnabledModules).
  const enabledModules = Array.from(enabledModuleSet);

  const memberships = (membershipsRes.data ?? [])
    .map((row) => {
      const r = row as {
        role: string;
        organizations: { id: string; name: string; logo_url: string | null }
          | { id: string; name: string; logo_url: string | null }[]
          | null;
      };
      const org = Array.isArray(r.organizations) ? r.organizations[0] : r.organizations;
      if (!org) return null;
      return {
        id: org.id,
        name: org.name,
        logoUrl: org.logo_url ?? null,
        role: r.role,
      };
    })
    .filter((m): m is { id: string; name: string; logoUrl: string | null; role: string } => Boolean(m))
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── MFA enforcement ────────────────────────────────────────────────
  // Banner instead of redirect: the previous redirect-on-every-page-load
  // approach raced with Chrome's prefetch behavior and triggered the
  // "Throttling navigation to prevent the browser from hanging" warning,
  // which renders as a black/blank screen on certain sections (Andrew,
  // Chrome, no MFA enrolled). The banner is always visible above the
  // page content until the user enrolls; can't loop, can't throttle,
  // and behaves the same across browsers.
  const policy = (orgRow?.mfa_policy as
    | 'optional'
    | 'admins_required'
    | 'all_required'
    | undefined) ?? 'optional';
  const isAdmin = ctx.role === 'owner' || ctx.role === 'admin';
  const mfaRequired =
    policy === 'all_required' || (policy === 'admins_required' && isAdmin);
  const hasVerifiedFactor = mfaFactors.some((f) => f.status === 'verified');
  const showMfaBanner = mfaRequired && !hasVerifiedFactor;

  // Hard gate for the strictest policy: when policy === 'all_required'
  // and the user has no verified factor, the banner alone isn't enough
  // — they can still navigate. Redirect to security settings (which is
  // exempt from the gate so enrollment still works) instead of showing
  // the full dashboard. assertPermission in services already blocks
  // mutating actions at AAL1, but this prevents read-only data leakage
  // across the rest of the dashboard until they enroll.
  if (policy === 'all_required' && !hasVerifiedFactor) {
    const h = await headers();
    const pathname = h.get('x-pathname') ?? '';
    if (!pathname.startsWith('/dashboard/settings/security')) {
      redirect('/dashboard/settings/security?mfa=required');
    }
  }

  const term = resolveTerminology(
    (orgRow?.terminology as Partial<ReturnType<typeof resolveTerminology>>) ?? null,
  );

  // Only managers/admins get the topbar filter — warehouse-scoped users
  // have a forced warehouse and the filter would be a UX dead-end for
  // them. Warehouses list itself comes from the cached helper in the
  // Promise.all above, so this branch is just a no-DB shape mapping.
  const warehouseFilter = access.hasAllAccess
    ? {
        warehouses: warehousesList,
        activeId: activeWarehouseId,
        warehouseLabel: term.warehouse_singular,
      }
    : undefined;

  return (
    <>
      <InventoryRealtime organizationId={ctx.organizationId} />
      <DashboardShell
        email={ctx.email}
        fullName={ctx.fullName}
        avatarUrl={ctx.avatarUrl}
        userId={ctx.userId}
        initialUnreadNotifications={initialUnreadNotifications}
        organizationId={ctx.organizationId}
        organizationName={ctx.organizationName}
        organizationLogoUrl={orgRow?.logo_url ?? null}
        memberships={memberships}
        userName={ctx.fullName ?? ctx.email}
        userRole={`${ROLE_LABELS[ctx.role].label} · ${ctx.organizationName}`}
        role={ctx.role}
        enabledModules={enabledModules}
        navOverrides={orgRow?.nav_overrides ?? null}
        orderStatusConfig={orgRow?.order_status_config ?? null}
        warehouseFilter={warehouseFilter}
      >
        <ImpersonationBanner />
        {showMfaBanner && <MfaRequiredBanner />}
        {children}
      </DashboardShell>
    </>
  );
}
