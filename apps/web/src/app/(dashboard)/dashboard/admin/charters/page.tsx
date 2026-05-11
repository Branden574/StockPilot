import { ChartersManager } from '@/components/admin/charters-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ChartersService } from '@/server/services/charters';

import { resolveTerminology } from '@stockpilot/core';

export default async function ChartersAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const ctx = await requireOrgContext();
  const supabase = await createClient();
  const params = await searchParams;
  const isArchivedView = params.view === 'archived';

  const [orgRow, charters] = await Promise.all([
    supabase
      .from('organizations')
      .select('terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
    (await ChartersService.forCurrentUser()).list({ includeArchived: isArchivedView }),
  ]);

  const term = resolveTerminology(
    (orgRow.data?.terminology as Partial<ReturnType<typeof resolveTerminology>>) ?? null,
  );

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 pb-20 pt-7">
      <div className="mb-6 border-b border-border pb-4">
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
          Admin
        </p>
        <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">{term.charter_plural}</h1>
        <p className="mt-1 text-[13.5px] text-[var(--ed-ink-3)]">
          {isArchivedView
            ? `${term.charter_plural} you archived. Restore one to bring it back into the active list.`
            : 'Top-level groupings for warehouses. The label here is configurable — if your company calls them “Regions” or “Divisions”, change it in organization settings.'}
        </p>
      </div>
      <ChartersManager
        view={isArchivedView ? 'archived' : 'active'}
        initial={charters}
        termSingular={term.charter_singular}
      />
    </div>
  );
}
