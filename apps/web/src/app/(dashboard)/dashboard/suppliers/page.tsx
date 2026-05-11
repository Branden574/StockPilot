import { SuppliersManager } from '@/components/suppliers/suppliers-manager';
import { SuppliersService } from '@/server/services/suppliers';

interface SuppliersPageProps {
  searchParams: Promise<{ view?: string }>;
}

export default async function SuppliersPage({ searchParams }: SuppliersPageProps) {
  const params = await searchParams;
  const isArchivedView = params.view === 'archived';
  const svc = await SuppliersService.forCurrentUser();
  const rows = await svc.list({ includeArchived: isArchivedView });

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isArchivedView
            ? 'Suppliers you archived. Restore one to bring it back into pick lists.'
            : 'Vendors, contacts, and where to reorder from.'}
        </p>
      </div>
      <SuppliersManager
        view={isArchivedView ? 'archived' : 'active'}
        initial={rows.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          contact_name: (r.contact_name as string | null) ?? null,
          email: (r.email as string | null) ?? null,
          phone: (r.phone as string | null) ?? null,
          website: (r.website as string | null) ?? null,
          notes: (r.notes as string | null) ?? null,
        }))}
      />
    </div>
  );
}
