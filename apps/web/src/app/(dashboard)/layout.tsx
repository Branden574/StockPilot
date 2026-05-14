import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { MfaRequiredBanner } from '@/components/dashboard/mfa-required-banner';
import { InventoryRealtime } from '@/components/realtime/inventory-realtime';
import { requireOrgContext } from '@/lib/auth/session';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { createClient } from '@/lib/supabase/server';

import { ROLE_LABELS, resolveTerminology } from '@stockpilot/core';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Cached: this resolves with the same data the page will use in the
  // same render — zero extra DB round trips beyond the page's own.
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  const [access, activeWarehouseId, orgRow, factorsRes, membershipsRes, unreadRes] = await Promise.all([
    getWarehouseAccess(),
    getActiveWarehouseFilter(),
    supabase
      .from('organizations')
      .select('terminology, mfa_policy, logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
    supabase.auth.mfa.listFactors(),
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
  ]);
  const initialUnreadNotifications = unreadRes.count ?? 0;

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
  const policy = (orgRow.data?.mfa_policy as
    | 'optional'
    | 'admins_required'
    | 'all_required'
    | undefined) ?? 'optional';
  const isAdmin = ctx.role === 'owner' || ctx.role === 'admin';
  const mfaRequired =
    policy === 'all_required' || (policy === 'admins_required' && isAdmin);
  const hasVerifiedFactor = (factorsRes.data?.all ?? []).some(
    (f) => f.status === 'verified',
  );
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
    (orgRow.data?.terminology as Partial<ReturnType<typeof resolveTerminology>>) ?? null,
  );

  // Only managers/admins get the topbar filter — warehouse-scoped users have
  // a forced warehouse and the filter would be a UX dead-end for them.
  let warehouseFilter:
    | {
        warehouses: Array<{ id: string; name: string }>;
        activeId: string | null;
        warehouseLabel: string;
      }
    | undefined;
  if (access.hasAllAccess) {
    const { data } = await supabase
      .from('warehouses')
      .select('id, name')
      .eq('organization_id', ctx.organizationId)
      .neq('status', 'archived')
      .order('name', { ascending: true });
    warehouseFilter = {
      warehouses: (data ?? []) as Array<{ id: string; name: string }>,
      activeId: activeWarehouseId,
      warehouseLabel: term.warehouse_singular,
    };
  }

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
        organizationLogoUrl={(orgRow.data?.logo_url as string | null) ?? null}
        memberships={memberships}
        userName={ctx.fullName ?? ctx.email}
        userRole={`${ROLE_LABELS[ctx.role].label} · ${ctx.organizationName}`}
        role={ctx.role}
        warehouseFilter={warehouseFilter}
      >
        {showMfaBanner && <MfaRequiredBanner />}
        {children}
      </DashboardShell>
    </>
  );
}
