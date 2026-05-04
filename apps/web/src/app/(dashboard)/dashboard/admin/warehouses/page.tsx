import { WarehousesManager } from '@/components/admin/warehouses-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ChartersService } from '@/server/services/charters';
import { WarehousesService } from '@/server/services/warehouses';

import { resolveTerminology } from '@stockpilot/core';

export default async function WarehousesAdminPage() {
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  const [orgRow, warehouses, charters, members] = await Promise.all([
    supabase
      .from('organizations')
      .select('terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
    (await WarehousesService.forCurrentUser()).list(),
    (await ChartersService.forCurrentUser()).list(),
    supabase
      .from('organization_members')
      .select('user_id, role, user:user_profiles!user_id (id, full_name, email)')
      .eq('organization_id', ctx.organizationId)
      .in('role', ['owner', 'admin', 'manager'])
      .not('accepted_at', 'is', null),
  ]);

  const term = resolveTerminology(
    (orgRow.data?.terminology as Partial<ReturnType<typeof resolveTerminology>>) ?? null,
  );

  // Flatten the joined user_profile (Supabase returns array on relation embed).
  const managerOptions = (members.data ?? []).map((m) => {
    const userField = (m as { user?: unknown }).user;
    const u = Array.isArray(userField) ? userField[0] : userField;
    const obj = u as { id?: string; full_name?: string | null; email?: string | null } | null;
    return {
      id: (obj?.id ?? (m as { user_id: string }).user_id) as string,
      name: obj?.full_name ?? obj?.email ?? 'Unknown',
    };
  });

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 pb-20 pt-7">
      <div className="mb-6 border-b border-border pb-4">
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
          Admin
        </p>
        <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">
          {term.warehouse_plural}
        </h1>
        <p className="mt-1 text-[13.5px] text-[var(--ed-ink-3)]">
          Physical locations stock lives in. Each {term.warehouse_singular.toLowerCase()} can
          service multiple {term.charter_plural.toLowerCase()} and have a manager.
        </p>
      </div>

      <WarehousesManager
        initial={warehouses}
        charters={charters.map((c) => ({ id: c.id, name: c.name }))}
        managers={managerOptions}
        termSingular={term.warehouse_singular}
        charterSingular={term.charter_singular}
      />
    </div>
  );
}
