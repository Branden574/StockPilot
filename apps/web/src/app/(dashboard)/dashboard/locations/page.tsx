import { LocationsManager } from '@/components/locations/locations-manager';
import { LocationsService } from '@/server/services/locations';

export default async function LocationsPage() {
  const svc = await LocationsService.forCurrentUser();
  const rows = await svc.list();

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Locations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Warehouses, rooms, shelves, vehicles, job sites — wherever stock lives.
        </p>
      </div>
      <LocationsManager
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
