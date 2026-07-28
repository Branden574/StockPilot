import { Layers } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { can, compareSizeValues } from '@stockpilot/core';

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
 * security_invoker view over `inventory_items`), and the variant rows come from
 * one batched read for the whole page. Neither is a stored column and neither
 * is one query per group.
 *
 * Gated twice, as the module registry declares: the `sports` module must be on
 * AND the viewer must hold `sports:manage`. A non-sports org never reaches this
 * route and sees no change anywhere else either.
 */
export default async function ProductGroupsPage(props: {
  searchParams: Promise<{ q?: string }>;
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

  const { q } = await props.searchParams;
  const search = typeof q === 'string' ? q.trim() : '';

  const svc = new ProductGroupsService(svcCtx);
  const groups = await svc.list({ search: search || undefined, limit: 100 });
  const ids = groups.map((g) => g.id);

  // Three reads for the whole page, never one per group: the aggregate view,
  // the batched variant rows, and the display metadata that carries each
  // group's authored size order.
  const [rollups, variantsByGroup, display] = await Promise.all([
    svc.rollups(ids),
    svc.variantsByGroupIds(ids),
    svc.displayByIds(ids),
  ]);

  const rows = groups.map((g) => {
    const roll = rollups.get(g.id);
    const order = display.get(g.id)?.sizeOrder ?? null;
    const variants = [...(variantsByGroup.get(g.id) ?? [])].sort((a, b) =>
      compareSizeValues(a.variant_size, b.variant_size, order),
    );
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
      // The AUTHORITATIVE roll-up: whole-group figures from the view, not a
      // sum of the rows this page happens to have loaded.
      variantCount: roll?.variantCount ?? 0,
      totalQuantity: roll?.totalQuantity ?? 0,
      variants: variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        name: v.name,
        quantity: Number(v.quantity_on_hand) || 0,
        variantSize: v.variant_size,
        variantSizeSystem: v.variant_size_system,
        variantWidth: v.variant_width,
        variantColor: v.variant_color,
        jerseyNumber: v.jersey_number,
        trackingType: v.tracking_type,
        unitOfMeasure: v.unit_of_measure,
        status: v.status,
      })),
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Product groups</h1>
          <p className="text-[13px] text-[var(--ed-ink-3)]">
            One row per product. Totals are added up from the group&rsquo;s variants every time
            this page loads — a group never holds stock of its own.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard/product-groups/link">Review suggested families</Link>
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={search ? 'No product groups match that search' : 'No product groups yet'}
          description={
            search
              ? 'Try a shorter search, or clear it to see every group.'
              : 'Groups are created when you add a sized product. To bring existing inventory in, open the review tool — nothing is grouped until you say so.'
          }
          cta={
            search
              ? undefined
              : { label: 'Review suggested families', href: '/dashboard/product-groups/link' }
          }
        />
      ) : (
        <ProductGroupRollupList groups={rows} />
      )}
    </div>
  );
}
