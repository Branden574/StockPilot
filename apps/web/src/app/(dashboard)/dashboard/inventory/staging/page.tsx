import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { StagingTableSection } from '@/components/inventory/staging-table-section';
import { TableBodySkeleton } from '@/components/dashboard/skeletons';
import { can, parseStagingItemFilter } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { canMintPlacementDestination } from '@/lib/locations/placement-destination';
import { PageTour } from '@/components/onboarding/page-tour';
import { STAGING_TOUR } from '@/lib/onboarding/tours';

export const metadata: Metadata = { title: 'Staging' };

type StagingSearchParams = {
  type?: string;
  /** F2-3, put away from an order: the items to show (repeatable), and the
   *  order they came from. Read only, never rewritten (pattern #18). */
  item?: string | string[];
  order?: string | string[];
};

export default async function StagingPage({
  searchParams,
}: {
  searchParams: Promise<StagingSearchParams>;
}) {
  const params = await searchParams;

  // Resolve the page shell synchronously (React-cached — same cost as the
  // dashboard layout's requireOrgContext call). Gates the Place button.
  const sessionCtx = await requireOrgContext();

  // Explicit route-level gate. The registry placement carries
  // `requires: 'items:read'` so the nav link is hidden from roles without
  // it, but the URL is still directly reachable — RLS alone would 200 an
  // empty page rather than refuse. notFound() matches the placement gate
  // and hides the route's existence from unauthorized roles.
  if (!can(sessionCtx, 'items:read')) notFound();

  // Gate the Place / Place-selected buttons on the permission the action
  // actually asserts (transferStock → 'stock:transfer'), NOT 'items:create'.
  // With per-role/user permission overrides the two can diverge, which would
  // otherwise show a Place button that always fails server-side.
  const canPlace = can(sessionCtx, 'stock:transfer');
  // The book put-away places INTO the recorded crate by default and mints the
  // row when none exists — under 'stock:transfer' (or 'locations:manage'),
  // through the placement path's own SECURITY DEFINER resolve-or-create
  // (mint_placement_location, 0340; owner decision D1). ONE derivation, shared
  // with the item detail; passed down so a dialog can say so inline instead of
  // failing on submit.
  const canMintDestination = canMintPlacementDestination(sessionCtx);

  const itemTypeParam =
    params.type === 'book' ? 'book' : params.type === 'non-book' ? 'non-book' : undefined;
  // Put away from an order (F2-3): ?item= (repeatable) and ?order=, parsed by
  // core (the phone reads its itemIds / orderId the same way). An unusable
  // list shows every item and says why; it never narrows or widens silently.
  const itemFilter = parseStagingItemFilter({ item: params.item, order: params.order });

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Staging</h1>
          <PageTour tour={STAGING_TOUR} />
          <p className="text-muted-foreground mt-1 text-sm">
            Stock waiting to be placed into a rack or crate — received from POs
            (staged) or on hand but never placed (unplaced).
          </p>
        </div>
      </div>

      <div className="mt-8">
        <Suspense fallback={<TableBodySkeleton rows={8} />}>
          <StagingTableSection
            itemType={itemTypeParam}
            filter={itemFilter}
            canPlace={canPlace}
            canMintDestination={canMintDestination}
          />
        </Suspense>
      </div>
    </div>
  );
}
