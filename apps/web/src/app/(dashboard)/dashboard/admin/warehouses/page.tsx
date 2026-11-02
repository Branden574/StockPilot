import { WarehousesManager } from '@/components/admin/warehouses-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ChartersService } from '@/server/services/charters';
import { WarehousesService } from '@/server/services/warehouses';

import { canEditOrganizationSetup, resolveTerminology } from '@stockpilot/core';

export default async function WarehousesAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const ctx = await requireOrgContext();
  const supabase = await createClient();
  const params = await searchParams;
  const isArchivedView = params.view === 'archived';
  // The Admin layout lets in anyone holding organization:update, but only an
  // owner's or an admin's change to a warehouse is saved (B99). Everyone else
  // gets the list without New, Edit, Archive or Restore.
  const canManage = canEditOrganizationSetup(ctx);

  const [orgRow, warehouses, charters, members] = await Promise.all([
    supabase.from('organizations').select('terminology').eq('id', ctx.organizationId).maybeSingle(),
    (await WarehousesService.forCurrentUser()).list({ includeArchived: isArchivedView }),
    (await ChartersService.forCurrentUser()).list(),
    // Only the editor's Manager list uses the members.
    canManage
      ? supabase
          .from('organization_members')
          .select('user_id, role, user:user_profiles!user_id (id, full_name, email)')
          .eq('organization_id', ctx.organizationId)
          .in('role', ['owner', 'admin', 'manager'])
          .not('accepted_at', 'is', null)
      : Promise.resolve({ data: [] }),
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
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <WarehousesManager
        view={isArchivedView ? 'archived' : 'active'}
        initial={warehouses}
        charters={charters.map((c) => ({ id: c.id, name: c.name }))}
        managers={managerOptions}
        termSingular={term.warehouse_singular}
        charterSingular={term.charter_singular}
        canManage={canManage}
        eyebrow="Admin"
        title={term.warehouse_plural}
        // Bounded, so the view toggle and New sit beside the title block.
        subline={
          <>
            <p className="max-w-[72ch]">
              {`Physical locations stock lives in. Each ${term.warehouse_singular.toLowerCase()} can service multiple ${term.charter_plural.toLowerCase()} and have a manager.`}
            </p>
            {canManage ? null : (
              <p className="max-w-[72ch]">
                {`Only owners and admins can add or change ${term.warehouse_plural.toLowerCase()}.`}
              </p>
            )}
          </>
        }
      />
    </div>
  );
}
