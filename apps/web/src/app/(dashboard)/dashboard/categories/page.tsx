import { CategoriesManager } from '@/components/categories/categories-manager';
import { CategoriesService } from '@/server/services/categories';

export default async function CategoriesPage() {
  const svc = await CategoriesService.forCurrentUser();
  const rows = await svc.list();

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Categories</h1>
        <p className="mt-1 text-sm text-muted-foreground">Group items so filters and reports stay tidy.</p>
      </div>
      <CategoriesManager
        initial={rows.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          description: (r.description as string | null) ?? null,
          color: (r.color as string | null) ?? null,
        }))}
      />
    </div>
  );
}
