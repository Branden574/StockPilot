import { CategoriesManager } from '@/components/categories/categories-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { CategoriesService } from '@/server/services/categories';

import { hasPermission } from '@stockpilot/core';

interface CategoriesPageProps {
  searchParams: Promise<{ view?: string }>;
}

export default async function CategoriesPage({ searchParams }: CategoriesPageProps) {
  const params = await searchParams;
  const isArchivedView = params.view === 'archived';
  const [ctx, svc] = await Promise.all([
    requireOrgContext(),
    CategoriesService.forCurrentUser(),
  ]);
  const canManage = hasPermission(ctx.role, 'categories:manage');
  const rows = await svc.list({ includeArchived: isArchivedView });

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Categories</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isArchivedView
            ? 'Categories you archived. Restore one to bring it back into filters and item forms.'
            : 'Group items so filters and reports stay tidy.'}
        </p>
      </div>
      <CategoriesManager
        view={isArchivedView ? 'archived' : 'active'}
        canManage={canManage}
        initial={rows.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          description: (r.description as string | null) ?? null,
          color: (r.color as string | null) ?? null,
          supports_sizes: Boolean(r.supports_sizes),
        }))}
      />
    </div>
  );
}
