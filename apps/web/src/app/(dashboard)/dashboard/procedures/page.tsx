import { BookOpen, History } from 'lucide-react';
import Link from 'next/link';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { ArchiveViewToggle } from '@/components/ui/archive-view-toggle';
import { Button } from '@/components/ui/button';
import {
  parseProcedureListParams,
  procedureListHref,
  type RawSearchParams,
} from '@/components/procedures/list-query';
import { ProcedureCard } from '@/components/procedures/procedure-card';
import { ProcedureFilters } from '@/components/procedures/procedure-filters';
import { RestoreButton } from '@/components/procedures/restore-button';
import { requireOrgContext } from '@/lib/auth/session';
import { can } from '@stockpilot/core';
import { ProcedureCategoriesService } from '@/server/services/procedure-categories';
import { ProceduresService } from '@/server/services/procedures';
import { WarehousesService } from '@/server/services/warehouses';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 24;

const PAGE_BOX =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function ProceduresListPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const moduleAccess = await checkModuleAccess('procedures');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="procedures" canManage={moduleAccess.canManage} />;
  }
  // Each parameter is read once, as its first value (a repeated `wh` used to
  // throw: CONFLICTS D21).
  const state = parseProcedureListParams(await searchParams);
  const { q, cat, wh, page } = state;
  const isArchivedView = state.archived;

  const ctx = await requireOrgContext();
  // Procedures is a read-everywhere surface: every org member (incl.
  // viewers) can browse the SOP knowledge base. Writing is gated at
  // the service/action layer on `categories:manage` (manager+), matching
  // the table's RLS. The sidebar still surfaces the entry for everyone.
  const canCreate = can(ctx, 'categories:manage');
  const canRestore = canCreate; // Restore uses the same permission gate as archive.

  const [procService, catService, whService] = await Promise.all([
    ProceduresService.forCurrentUser(),
    ProcedureCategoriesService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);

  const [{ rows, total }, categories, warehouses] = await Promise.all([
    procService.list({
      q: q || null,
      categoryId: cat || null,
      warehouseId: wh || null,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      includeArchived: isArchivedView,
    }),
    catService.list(),
    whService.listNames(),
  ]);

  const hasFilters = q.length > 0 || cat.length > 0 || wh.length > 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className={PAGE_BOX}>
      <PageHeader
        title="Procedures"
        subline={
          isArchivedView
            ? 'Procedures you archived. Restore one to put it back in the active list.'
            : 'Cross-warehouse standard operating procedures, with video walkthroughs and discussion.'
        }
        actions={<ArchiveViewToggle view={isArchivedView ? 'archived' : 'active'} />}
        primaryAction={
          canCreate && !isArchivedView ? (
            <Button asChild variant="gradient">
              <Link href="/dashboard/procedures/new">+ New procedure</Link>
            </Button>
          ) : null
        }
      />

      <ProcedureFilters
        state={state}
        categories={categories.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
      />

      {rows.length === 0 ? (
        hasFilters ? (
          <StatePanel
            kind="no-match"
            icon={BookOpen}
            title="No matches"
            description="Try a broader search or clear the filters."
          />
        ) : isArchivedView ? (
          <StatePanel
            kind="empty"
            icon={History}
            title="No archived procedures"
            description="Procedures you archive show up here so you can restore them later."
          />
        ) : (
          <StatePanel
            kind="empty"
            icon={BookOpen}
            title="No procedures yet"
            description="Start capturing how your warehouses get things done — write the steps and attach a quick video."
            action={
              canCreate ? (
                <Button asChild variant="gradient">
                  <Link href="/dashboard/procedures/new">Create first procedure</Link>
                </Button>
              ) : null
            }
          />
        )
      ) : (
        // One column on a phone (the phone app's users open these pages),
        // then as many 220 px columns as fit: four beside the sidebar at 1280.
        <ul
          role="list"
          data-slot="procedure-grid"
          className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-3"
        >
          {rows.map((row) => (
            <li key={row.id} className="flex min-w-0 flex-col gap-2">
              <ProcedureCard procedure={row} />
              {isArchivedView && canRestore && (
                <div className="flex justify-end">
                  <RestoreButton procedureId={row.id} title={row.title} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <nav
          aria-label="Pagination"
          className="border-border flex flex-wrap items-center justify-between gap-3 border-t pt-4"
        >
          <p className="text-muted-foreground text-[12.5px] tabular-nums">
            Page {page} of {totalPages} · {total} total
          </p>
          <div className="flex gap-2">
            {page > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={procedureListHref(state, { page: page - 1 })}>Previous</Link>
              </Button>
            )}
            {page < totalPages && (
              <Button asChild variant="outline" size="sm">
                <Link href={procedureListHref(state, { page: page + 1 })}>Next</Link>
              </Button>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}
