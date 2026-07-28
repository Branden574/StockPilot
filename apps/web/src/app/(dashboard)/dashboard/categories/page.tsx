import { Suspense } from 'react';

import { CategoriesManager } from '@/components/categories/categories-manager';
import { TableBodySkeleton } from '@/components/dashboard/skeletons';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { CategoriesService } from '@/server/services/categories';

import { can, type SubcategoryTrackingProfile, type TrackingMode } from '@stockpilot/core';

interface CategoriesPageProps {
  searchParams: Promise<{ view?: string }>;
}

export default async function CategoriesPage({ searchParams }: CategoriesPageProps) {
  const params = await searchParams;
  const isArchivedView = params.view === 'archived';

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
      <Suspense fallback={<TableBodySkeleton rows={6} />}>
        <CategoriesSection isArchivedView={isArchivedView} />
      </Suspense>
    </div>
  );
}

/**
 * Inner async Server Component: the awaited category list fetch lives here so
 * the page heading/description above paint immediately and only the manager
 * table streams. Same component, same props as before — relocated behind
 * <Suspense>.
 */
async function CategoriesSection({ isArchivedView }: { isArchivedView: boolean }) {
  const [ctx, svc] = await Promise.all([
    requireOrgContext(),
    CategoriesService.forCurrentUser(),
  ]);
  const canManage = can(ctx, 'categories:manage');
  // Public-catalog visibility (P3): the per-category Public / Internal-only
  // toggle is gated on public_links:manage (the server action re-asserts).
  const canManagePublicVisibility = can(ctx, 'public_links:manage');
  // Sports Task 12: subcategory + tracking-profile administration is gated on
  // the sports module AND sports:manage. The server re-asserts both on every
  // write (CategoriesService.assertSportsWriteAllowed / setupSportsDefaults).
  const [{ enabled: sportsEnabled }, rows] = await Promise.all([
    checkModuleAccess('sports'),
    svc.list({ includeArchived: isArchivedView }),
  ]);
  const canManageSports = can(ctx, 'sports:manage');

  return (
    <CategoriesManager
      view={isArchivedView ? 'archived' : 'active'}
      canManage={canManage}
      canManagePublicVisibility={canManagePublicVisibility}
      sportsEnabled={sportsEnabled}
      canManageSports={canManageSports}
      initial={rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        description: (r.description as string | null) ?? null,
        color: (r.color as string | null) ?? null,
        supports_sizes: Boolean(r.supports_sizes),
        public_visibility:
          ((r.public_visibility as string | null) ?? 'public') === 'internal_only'
            ? ('internal_only' as const)
            : ('public' as const),
        parent_id: (r.parent_id as string | null) ?? null,
        tracking_mode: (r.tracking_mode as TrackingMode | null) ?? null,
        sports_subcategory_key: (r.sports_subcategory_key as string | null) ?? null,
        tracking_profile: (r.tracking_profile as SubcategoryTrackingProfile | null) ?? null,
      }))}
    />
  );
}
