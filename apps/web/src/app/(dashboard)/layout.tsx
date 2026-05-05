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

  const [access, activeWarehouseId, orgRow, factorsRes, aalRes, hdrs] = await Promise.all([
    getWarehouseAccess(),
    getActiveWarehouseFilter(),
    supabase
      .from('organizations')
      .select('terminology, mfa_policy')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    headers(),
  ]);

  // ── MFA enforcement ────────────────────────────────────────────────
  // Two-stage gate. We need both an enrolled factor AND a session at
  // AAL2 (challenge passed for this session). The previous version
  // checked only "has verified factor", which could leave a user at
  // AAL1 with a verified factor — silently failing some downstream
  // gate and leaving them stuck.
  //
  // Allowlist the pages that are part of the MFA flow itself, otherwise
  // we'd redirect users away from the only place they can satisfy the
  // gate, creating a loop. Allowlist match is permissive (multiple
  // signals) so that a missing x-pathname header doesn't trip the loop.
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
  const currentAal = aalRes.data?.currentLevel ?? null;
  const path = hdrs.get('x-pathname') ?? hdrs.get('referer') ?? '';
  const onMfaFlowPath =
    path.includes('/dashboard/settings/security') ||
    path.includes('/signin/mfa');

  if (mfaRequired && !onMfaFlowPath) {
    if (!hasVerifiedFactor) {
      redirect('/dashboard/settings/security?enroll=1');
    } else if (currentAal === 'aal1') {
      redirect('/signin/mfa');
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
