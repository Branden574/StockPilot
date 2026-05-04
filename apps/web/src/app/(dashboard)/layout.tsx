import type { ReactNode } from 'react';

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

  const [access, activeWarehouseId, orgRow] = await Promise.all([
    getWarehouseAccess(),
    getActiveWarehouseFilter(),
    supabase
      .from('organizations')
      .select('terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
  ]);

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
