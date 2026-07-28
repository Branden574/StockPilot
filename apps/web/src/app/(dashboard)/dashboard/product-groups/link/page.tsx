import { Layers } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { can, SPORTS_SUBCATEGORIES } from '@stockpilot/core';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { GroupLinkingReview } from '@/components/inventory/group-linking-review';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { withContext } from '@/server/services/context';
import { suggestFamilies } from '@/server/services/product-group-linking';
import { ProductGroupsService } from '@/server/services/product-groups';

export const metadata = { title: 'Review product families' };

/**
 * The opt-in group-linking review tool.
 *
 * This page PROPOSES and the human DISPOSES. `suggestFamilies` reads; nothing
 * on this route writes until a reviewer presses Link on a family they have
 * looked at, and each press carries the exact item ids and a reason.
 *
 * There is no "link everything" action and no select-all-then-apply default,
 * on purpose: owner decision 2026-07-27 refused a name-heuristic backfill
 * because it "would bake wrong groupings into persistent identity", and a
 * one-click accept-all is that backfill with an extra step.
 */
export default async function ProductGroupLinkPage() {
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

  const svc = new ProductGroupsService(svcCtx);
  // The destination dropdown used `list({ limit: 200 })`, whose own clamp IS 200
  // — so an org past that offered the first 200 groups alphabetically and gave a
  // reviewer no way to reach group 201, with nothing on screen saying so. This
  // read is paged and reports its (much higher) cap, and the picker discloses it
  // when it is ever hit (recurring bug pattern #18).
  const [suggestions, picker] = await Promise.all([
    suggestFamilies({ supabase: svcCtx.supabase, organizationId: svcCtx.organizationId }),
    svc.listForPicker(),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="text-xl font-semibold">Review product families</h1>
          {/* The header states plainly that nothing is linked until Link is
              pressed — the whole opt-in promise, in the first thing read. */}
          <p className="text-[13px] text-[var(--ed-ink-3)]">
            These are suggestions based on item names alone. Nothing is linked until you press
            Link on a family. Names can mislead, so check each one before you accept it — a link
            becomes the product identity that receiving, counting and purchase-order matching all
            use.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard/product-groups">Back to product groups</Link>
        </Button>
      </div>

      {suggestions.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No families to review"
          description="No ungrouped items share a name base with a size on the end. Items created through the sized-product form are grouped as they are made, so there is nothing here to bring in."
          cta={{ label: 'Back to product groups', href: '/dashboard/product-groups' }}
        />
      ) : (
        <GroupLinkingReview
          suggestions={suggestions}
          existingGroups={picker.groups}
          groupsTruncated={picker.truncated}
          subcategoryKeys={[...SPORTS_SUBCATEGORIES]}
        />
      )}
    </div>
  );
}
