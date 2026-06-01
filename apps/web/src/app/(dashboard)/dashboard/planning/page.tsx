import { TrendingUp } from 'lucide-react';
import Link from 'next/link';

import { DraftPosFromReorderButton } from '@/components/reports/draft-pos-from-reorder-button';
import { PlanningParamsPanel } from '@/components/settings/planning-params-panel';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { formatNumber } from '@/lib/utils';
import { PlanningService } from '@/server/services/planning';

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

  const svc = await PlanningService.forCurrentUser();
  const [suggestions, params] = await Promise.all([
    svc.getReorderSuggestions(),
    svc.readParams(),
  ]);

  // The auto-draft path uses the canonical below-par filter (reorder_point > 0,
  // on-hand at/below it); count those here so the button mirrors what it will do.
  const belowParCount = suggestions.filter(
    (s) => s.currentReorderPoint > 0 && s.quantityOnHand <= s.currentReorderPoint,
  ).length;

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/purchase-orders"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Purchase orders
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3 sm:gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <TrendingUp className="h-6 w-6" /> Reorder Planning
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Items ranked by urgency from actual demand velocity. Lowest
              days-of-cover first; non-moving items sink to the bottom.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DraftPosFromReorderButton itemCount={belowParCount} />
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reorder suggestions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
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
              {suggestions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-muted-foreground py-8 text-center text-xs">
                    No active items to plan. Add stock movements to build velocity.
                  </TableCell>
                </TableRow>
              )}
              {suggestions.map((s) => (
                <TableRow key={s.itemId}>
                  <TableCell className="max-w-[260px] truncate">{s.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{s.sku ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{s.supplierName ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(s.quantityOnHand)}</TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">
                    {s.unitsPerDay.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.daysOfStockRemaining === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className={s.daysOfStockRemaining <= 14 ? 'text-warning font-medium' : ''}>
                        {formatNumber(s.daysOfStockRemaining)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">
                    {formatNumber(s.currentReorderPoint)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(s.suggestedReorderPoint)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(s.suggestedReorderQty)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {moduleAccess.canManage && (
        <div className="mt-6">
          <PlanningParamsPanel initial={params} />
        </div>
      )}
    </div>
  );
}
