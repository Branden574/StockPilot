import { ChartersManager } from '@/components/admin/charters-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ChartersService } from '@/server/services/charters';

import { resolveTerminology } from '@stockpilot/core';

// The Liquid Glass settings and administration composition (stage 4:
// pages/admin.css): every rule is scoped to this area's [data-glass-page] root
// and to glass, so Classic never matches it (glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/admin.css';

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
    supabase.from('organizations').select('terminology').eq('id', ctx.organizationId).maybeSingle(),
    (await ChartersService.forCurrentUser()).list({ includeArchived: isArchivedView }),
  ]);

  const term = resolveTerminology(
    (orgRow.data?.terminology as Partial<ReturnType<typeof resolveTerminology>>) ?? null,
  );

  return (
    <div
      data-glass-page="admin"
      data-glass-view="charters"
      className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7"
    >
      <ChartersManager
        view={isArchivedView ? 'archived' : 'active'}
        initial={charters}
        termSingular={term.charter_singular}
        eyebrow="Admin"
        title={term.charter_plural}
        // Bounded, so the view toggle and New sit beside the title block.
        subline={
          <p className="max-w-[72ch]">
            {isArchivedView
              ? `${term.charter_plural} you archived. Restore one to bring it back into the active list.`
              : 'Top-level groupings for warehouses. The label here is configurable — if your company calls them “Regions” or “Divisions”, change it in organization settings.'}
          </p>
        }
      />
    </div>
  );
}
