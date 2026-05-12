import { LocationsManager } from '@/components/locations/locations-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { LocationsService } from '@/server/services/locations';

import { hasPermission } from '@stockpilot/core';

interface LocationsPageProps {
  searchParams: Promise<{ view?: string }>;
}

export default async function LocationsPage({ searchParams }: LocationsPageProps) {
  const params = await searchParams;
  const isArchivedView = params.view === 'archived';
  const [ctx, svc] = await Promise.all([
    requireOrgContext(),
    LocationsService.forCurrentUser(),
  ]);
  const canManage = hasPermission(ctx.role, 'locations:manage');
  const rows = await svc.list({ includeArchived: isArchivedView });

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Locations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isArchivedView
            ? 'Locations you archived. Restore one to bring it back into pick lists.'
            : 'Warehouses, rooms, shelves, vehicles, job sites — wherever stock lives.'}
        </p>
      </div>
      <LocationsManager
        view={isArchivedView ? 'archived' : 'active'}
        canManage={canManage}
        initial={rows.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          type: (r.type as string | null) ?? null,
          notes: (r.notes as string | null) ?? null,
        }))}
      />
    </div>
  );
}
