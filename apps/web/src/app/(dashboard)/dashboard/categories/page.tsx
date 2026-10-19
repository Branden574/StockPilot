import type { Metadata } from 'next';
import { Suspense } from 'react';

import { CategoriesGridSkeleton } from '@/components/categories/categories-grid-skeleton';
import { CategoriesHeader } from '@/components/categories/categories-header';
import { CategoriesManager } from '@/components/categories/categories-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { CategoriesService } from '@/server/services/categories';

import { can, type SubcategoryTrackingProfile, type TrackingMode } from '@stockpilot/core';

// The tab names the page ("Categories · StockPilot"); before, it read the
// group's "Dashboard" (CONFLICTS D16).
export const metadata: Metadata = { title: 'Categories' };

/** The page area (DESIGN-SPEC 4 and 5.3), the same box the other pages use. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

interface CategoriesPageProps {
  searchParams: Promise<{ view?: string }>;
}

export default async function CategoriesPage({ searchParams }: CategoriesPageProps) {
  const params = await searchParams;
  const isArchivedView = params.view === 'archived';

  const view = isArchivedView ? 'archived' : 'active';

  return (
    <div className={PAGE}>
      {/* The header paints at once: the fallback draws it with the toggle,
          and the manager draws the same header with its buttons (they open
          its dialogs) when the list arrives. Only the cards stream. */}
      <Suspense
        fallback={
          <>
            <CategoriesHeader view={view} />
            <CategoriesGridSkeleton />
          </>
        }
      >
        <CategoriesSection isArchivedView={isArchivedView} />
      </Suspense>
    </div>
  );
}

/**
 * Inner async Server Component: the awaited category list fetch lives here so
 * the page heading and description paint immediately (the Suspense fallback
 * draws them) and only the cards stream. Same component, same props as before.
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
        default_unit_of_measure: (r.default_unit_of_measure as string | null) ?? null,
      }))}
    />
  );
}
