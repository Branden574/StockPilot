import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
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

  const [access, activeWarehouseId, orgRow, factorsRes, hdrs] = await Promise.all([
    getWarehouseAccess(),
    getActiveWarehouseFilter(),
    supabase
      .from('organizations')
      .select('terminology, mfa_policy')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
    supabase.auth.mfa.listFactors(),
    headers(),
  ]);

  // ── MFA enforcement ────────────────────────────────────────────────
  // Soft gate (option B during onboarding): require an enrolled+verified
  // factor for users in scope of the org policy, but don't force every
  // session through a fresh AAL2 challenge. The challenge happens once
  // at sign-in via /signin/mfa; we don't re-require it on every request.
  // Allowlist the MFA flow pages so the redirect can't loop on itself.
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
  const path = hdrs.get('x-pathname') ?? hdrs.get('referer') ?? '';
  const onMfaFlowPath =
    path.includes('/dashboard/settings/security') ||
    path.includes('/signin/mfa');

  if (mfaRequired && !hasVerifiedFactor && !onMfaFlowPath) {
    redirect('/dashboard/settings/security?enroll=1');
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
    <DashboardShell
      email={ctx.email}
      fullName={ctx.fullName}
      avatarUrl={ctx.avatarUrl}
      organizationName={ctx.organizationName}
      userName={ctx.fullName ?? ctx.email}
      userRole={`${ROLE_LABELS[ctx.role].label} · ${ctx.organizationName}`}
      role={ctx.role}
      warehouseFilter={warehouseFilter}
    >
      {children}
    </DashboardShell>
  );
}
