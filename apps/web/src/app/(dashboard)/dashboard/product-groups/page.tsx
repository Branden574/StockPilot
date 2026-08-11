import { Layers } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { can } from '@stockpilot/core';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { ProductGroupRollupList } from '@/components/inventory/product-group-rollup-list';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { withContext } from '@/server/services/context';
import { ProductGroupsService } from '@/server/services/product-groups';

export const metadata = { title: 'Product groups' };

/**
 * Product groups, each showing its DERIVED roll-up ("6 variants · 52 pairs
 * total") and expanding to its per-variant rows in size order.
 *
 * A group owns NO quantity. Every number on this page is aggregated at read
 * time — the counts and totals come from `product_group_rollups` (a
 * security_invoker view over `inventory_items`), never a stored column. The
 * variant ROWS behind a group are fetched only when that group is expanded, so
 * a collapsed page issues no per-group query at all.
 *
 * Gated twice, as the module registry declares: the `sports` module must be on
 * AND the viewer must hold `sports:manage`. A non-sports org never reaches this
 * route and sees no change anywhere else either.
 *
 * TWO VIEWS, one route. `?status=archived` asks the service for archived groups
 * instead of active ones — the only way an archived group is ever read back, and
 * the place its Restore control lives. Archiving is a soft status change, so a
 * group in this view still has all its variants and all its figures.
 */
export default async function ProductGroupsPage(props: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('sports');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="sports" canManage={moduleAccess.canManage} />;
  }
  const ctx = await requireOrgContext();
  if (!can(ctx, 'sports:manage')) redirect('/dashboard');
  // requireOrgContext carries the role + permission set the gate above needs;
  // the services need the full ServiceContext (supabase client + module set).
  // Both are request-cached, so this is a memo read.
  const svcCtx = await withContext();

  const { q, status } = await props.searchParams;
  const search = typeof q === 'string' ? q.trim() : '';
  // Only 'archived' opts out of the active list; anything else (including a
  // hand-typed value) falls back to the current view rather than showing a
  // third, unlabelled set of rows.
  const showArchived = status === 'archived';

  const svc = new ProductGroupsService(svcCtx);
  const groups = await svc.list({
    search: search || undefined,
    limit: 100,
    status: showArchived ? 'archived' : 'active',
  });
  const ids = groups.map((g) => g.id);
  const searchQuery = search ? `&q=${encodeURIComponent(search)}` : '';

  // TWO reads for the whole page: the groups and the aggregate view. The
  // variant ROWS are not read here at all — the page renders collapsed, every
  // number on it is a server-side aggregate, and a group's rows are fetched
  // only when a human opens it (`loadGroupVariantsAction`). Reading them all
  // up front was both wasted work and capped by PostgREST's max_rows, which
  // let a large page silently under-report an expansion.
  const rollups = await svc.rollups(ids);

  const rows = groups.map((g) => {
    const roll = rollups.get(g.id);
    return {
      id: g.id,
      name: g.name,
      brand: g.brand,
      model: g.model,
      styleNumber: g.style_number,
      team: g.team,
      subcategoryKey: g.subcategory_key,
      trackingMode: g.tracking_mode,
      countingUnit: g.default_counting_unit,
      // The AUTHORITATIVE roll-up: whole-group figures from the view, never a
      // sum of the rows an expansion happens to have loaded.
      variantCount: roll?.variantCount ?? 0,
      totalQuantity: roll?.totalQuantity ?? 0,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {showArchived ? 'Archived product groups' : 'Product groups'}
          </h1>
          <p className="text-[13px] text-[var(--ed-ink-3)]">
            {showArchived
              ? 'Archived groups are hidden from the product-groups list and from the pickers that link items, but nothing about them was deleted. Restore one and it comes back with its variants and its totals intact.'
              : 'One row per product. Totals are added up from the group’s variants every time this page loads — a group never holds stock of its own.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The archived view is the ONLY place an archived group is read back,
              so the way in has to be on the page rather than a URL you have to
              know. Both links carry the current search so switching views does
              not silently widen what is being looked at. */}
          <Button asChild variant="outline" size="sm">
            <Link
              href={
                showArchived
                  ? `/dashboard/product-groups?status=active${searchQuery}`
                  : `/dashboard/product-groups?status=archived${searchQuery}`
              }
            >
              {showArchived ? 'Back to active groups' : 'View archived'}
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/product-groups/link">Review suggested families</Link>
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={
            showArchived
              ? search
                ? 'No archived groups match that search'
                : 'No archived product groups'
              : search
                ? 'No product groups match that search'
                : 'No product groups yet'
          }
          description={
            showArchived
              ? search
                ? 'Try a shorter search, or clear it to see every archived group.'
                : 'Nothing has been archived. Archiving a group hides it from this list and from the item-linking pickers, and it can be restored at any time.'
              : search
                ? 'Try a shorter search, or clear it to see every group.'
                : 'Groups are created when you add a sized product. To bring existing inventory in, open the review tool — nothing is grouped until you say so.'
          }
          cta={
            showArchived
              ? { label: 'Back to active groups', href: '/dashboard/product-groups' }
              : search
                ? undefined
                : { label: 'Review suggested families', href: '/dashboard/product-groups/link' }
          }
        />
      ) : (
        <ProductGroupRollupList groups={rows} archived={showArchived} />
      )}
    </div>
  );
}
