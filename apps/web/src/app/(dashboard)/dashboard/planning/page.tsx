import { DraftPosFromReorderButton } from '@/components/reports/draft-pos-from-reorder-button';
import { AutoReorderPanel } from '@/components/settings/auto-reorder-panel';
import { PlanningParamsPanel } from '@/components/settings/planning-params-panel';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireOrgContext } from '@/lib/auth/session';
import { reportError } from '@/lib/error-reporter';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { cn, formatNumber } from '@/lib/utils';
import { createClient } from '@/lib/supabase/server';
import { readAutoReorderSettings } from '@/server/services/auto-reorder';
import { PLANNING_MAX_ITEMS, PlanningService } from '@/server/services/planning';

import { planAllowsAutoReorder, type OrgBillingState } from '@stockpilot/core';

/** The page area (DESIGN-SPEC 5.3 and 4): max 1320, 16 px gutters on a phone. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** A figure column: right-aligned mono, as the reference's On hand. */
const NUM = 'whitespace-nowrap text-right font-mono text-[13px] tabular-nums';

/**
 * Reorder Planning — velocity-ranked reorder surface. Lists active items by
 * urgency (lowest days-of-cover first) using the demand-planning engine, and
 * lets a buyer draft POs for the below-par set in one click. Gated behind the
 * `planning` module (which dependsOn inventory + purchase_orders).
 */
export default async function PlanningPage() {
  const moduleAccess = await checkModuleAccess('planning');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="planning" canManage={moduleAccess.canManage} />;
  }

  const ctx = await requireOrgContext();
  const supabase = await createClient();
  const svc = await PlanningService.forCurrentUser();
  const [plan, params, autoReorder, orgBillingRes, openPoItems] = await Promise.all([
    svc.getReorderSuggestions(),
    svc.readParams(),
    readAutoReorderSettings(supabase, ctx.organizationId),
    supabase
      .from('organizations')
      .select(
        'plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
      )
      .eq('id', ctx.organizationId)
      .maybeSingle(),
    // Items already on an open PO, which the draft button skips. A failed read
    // is NOT an empty set (that would overstate what the button drafts as if
    // it were checked): it becomes null, the page keeps the unfiltered count
    // and says it could not check. The button itself re-reads and fails
    // closed, so it can never draft a duplicate either way.
    svc.itemIdsOnOpenPurchaseOrders().catch((err: unknown) => {
      void reportError(err, {
        tag: 'planning.open_po_items',
        organizationId: ctx.organizationId,
        level: 'warning',
      });
      return null;
    }),
  ]);
  const { suggestions, truncated } = plan;
  const autoReorderEntitled = planAllowsAutoReorder(
    ((orgBillingRes.data as OrgBillingState | null) ?? { plan: null }) as OrgBillingState,
  );

  // The auto-draft path uses the canonical below-par filter (reorder_point > 0,
  // on-hand at/below it) and skips items already on an open PO; count the same
  // set here so the button mirrors what it will do. When the plan is
  // truncated this counts only the ranked items (the button itself drafts
  // from every item), which the coverage note below says.
  const belowPar = suggestions.filter(
    (s) => s.currentReorderPoint > 0 && s.quantityOnHand <= s.currentReorderPoint,
  );
  const onOpenPoCount =
    openPoItems === null ? null : belowPar.filter((s) => openPoItems.has(s.itemId)).length;
  const draftableCount = belowPar.length - (onOpenPoCount ?? 0);

  return (
    <div className={PAGE}>
      <PageHeader
        back={
          <PageHeaderBackLink href="/dashboard/purchase-orders">
            ← Purchase orders
          </PageHeaderBackLink>
        }
        title="Reorder Planning"
        subline="Items ranked by urgency from actual demand velocity. Lowest days-of-cover first; non-moving items sink to the bottom."
        commitAction={
          <div className="flex flex-col items-start gap-1">
            <DraftPosFromReorderButton itemCount={draftableCount} countIsPartial={truncated} />
            {onOpenPoCount === null ? (
              <p role="status" className="text-warning max-w-xs text-[12px] leading-[18px]">
                Couldn&apos;t check which of the {formatNumber(belowPar.length)} below-par items are
                already on open purchase orders. Drafting checks again and skips those.
              </p>
            ) : onOpenPoCount > 0 ? (
              <p className="text-muted-foreground max-w-xs text-[12px] leading-[18px]">
                {formatNumber(draftableCount)} to draft · {formatNumber(onOpenPoCount)} already on
                open POs (skipped)
              </p>
            ) : null}
          </div>
        }
      />

      {truncated && (
        <p
          role="status"
          data-testid="planning-coverage-note"
          className="border-warning/40 bg-warning-wash text-foreground rounded-lg border px-3.5 py-2.5 text-[13.5px] leading-[20.25px]"
        >
          This organization has more than {formatNumber(PLANNING_MAX_ITEMS)} items to plan, so only{' '}
          {formatNumber(PLANNING_MAX_ITEMS)} of them are ranked below, and they are not picked by
          urgency: an urgent item can be missing here, and the below-par count covers only the items
          shown. &ldquo;Draft PO from suggestions&rdquo; still checks every item.
        </p>
      )}

      {/* Distinct from Reports > Reorder forecast: this ranks by demand
          velocity. Up to PLANNING_MAX_ITEMS rows in one server-rendered table
          that scrolls sideways inside its card on a narrow screen. */}
      <DetailSection title="Reorder suggestions" flush data-slot="planning-suggestions">
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent [&>th]:whitespace-nowrap xl:[&>th]:whitespace-normal">
              <TableHead>Item</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Units/day</TableHead>
              <TableHead className="text-right">Days of cover</TableHead>
              <TableHead className="text-right">Reorder at</TableHead>
              <TableHead className="text-right">Suggested point</TableHead>
              <TableHead className="text-right">Suggested qty</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {suggestions.map((s) => (
              <TableRow key={s.itemId}>
                <TableCell className="text-foreground max-w-[200px] truncate font-medium">
                  {s.name}
                </TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap font-mono text-[12px]">
                  {s.sku ?? '—'}
                </TableCell>
                <TableCell className="text-ink-2 min-w-[140px] text-[12.5px]">
                  {s.supplierName ?? '—'}
                </TableCell>
                <TableCell className={cn(NUM, 'text-foreground font-medium')}>
                  {formatNumber(s.quantityOnHand)}
                </TableCell>
                <TableCell className={cn(NUM, 'text-ink-2')}>{s.unitsPerDay.toFixed(2)}</TableCell>
                <TableCell className={NUM}>
                  {s.daysOfStockRemaining === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span
                      className={
                        s.daysOfStockRemaining <= 14
                          ? 'text-warning font-medium'
                          : 'text-foreground'
                      }
                    >
                      {formatNumber(s.daysOfStockRemaining)}
                    </span>
                  )}
                </TableCell>
                <TableCell className={cn(NUM, 'text-ink-2')}>
                  {formatNumber(s.currentReorderPoint)}
                </TableCell>
                <TableCell className={cn(NUM, 'text-foreground')}>
                  {formatNumber(s.suggestedReorderPoint)}
                </TableCell>
                <TableCell className={cn(NUM, 'text-foreground')}>
                  {formatNumber(s.suggestedReorderQty)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {/* Outside the table's scroll wrapper, so the line centres in the
            card's visible width on a phone instead of across 860 px. */}
        {suggestions.length === 0 ? (
          <div className="border-border border-t">
            <StatePanel
              kind="empty"
              surface="plain"
              headingLevel={null}
              icon={null}
              title="No active items to plan. Add stock movements to build velocity."
            />
          </div>
        ) : null}
      </DetailSection>

      {moduleAccess.canManage && (
        <div data-slot="planning-settings" className="flex flex-col gap-4">
          <PlanningParamsPanel initial={params} />
          <AutoReorderPanel initial={autoReorder} entitled={autoReorderEntitled} />
        </div>
      )}
    </div>
  );
}
