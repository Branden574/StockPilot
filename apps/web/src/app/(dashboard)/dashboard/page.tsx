import { ArrowDownRight, ArrowUpRight, Boxes, DollarSign, PackageX, TrendingDown } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/dashboard/empty-state';
import { StatCard } from '@/components/dashboard/stat-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InventoryService } from '@/server/services/inventory';
import { getDashboardSummary, getLowStockItems, MovementsService } from '@/server/services/movements';
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';

export default async function DashboardHome() {
  const [summary, lowStock, recentMovements, inventorySnapshot] = await Promise.all([
    getDashboardSummary(),
    getLowStockItems(8),
    (await MovementsService.forCurrentUser()).list({ limit: 8 }),
    (await InventoryService.forCurrentUser()).list({ limit: 1000, status: 'all' }),
  ]);

  const itemsById = new Map(inventorySnapshot.items.map((i) => [i.id, i]));

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Here&apos;s what&apos;s happening across your inventory.
          </p>
        </div>
        <Button asChild variant="gradient">
          <Link href="/dashboard/inventory/new">+ New item</Link>
        </Button>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Boxes} label="Total items" value={formatNumber(summary.itemCount)} />
        <StatCard
          icon={DollarSign}
          label="Inventory value"
          value={formatCurrency(summary.inventoryValue)}
        />
        <StatCard
          icon={ArrowDownRight}
          label="Low stock"
          value={formatNumber(summary.lowStockCount)}
        />
        <StatCard icon={PackageX} label="Out of stock" value={formatNumber(summary.outOfStockCount)} />
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ArrowUpRight className="h-4 w-4 text-primary" />
              Recent activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {summary.itemCount === 0 ? (
              <EmptyState
                icon={Boxes}
                title="No inventory yet"
                description="Add your first item to start tracking stock, locations, and movements."
                action={
                  <Button asChild variant="gradient">
                    <Link href="/dashboard/inventory/new">Add your first item</Link>
                  </Button>
                }
              />
            ) : recentMovements.length === 0 ? (
              <p className="text-sm text-muted-foreground">No movements yet.</p>
            ) : (
              <ul className="divide-y">
                {recentMovements.map((m) => {
                  const item = itemsById.get(m.item_id as string);
                  const change = Number(m.quantity_change);
                  return (
                    <li key={m.id as string} className="flex items-center gap-3 py-2.5 text-sm">
                      <span
                        className={
                          'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ' +
                          (change > 0
                            ? 'bg-success/15 text-success'
                            : change < 0
                              ? 'bg-destructive/15 text-destructive'
                              : 'bg-muted text-muted-foreground')
                        }
                      >
                        {change > 0 ? '+' : change < 0 ? '−' : '·'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/dashboard/inventory/${m.item_id}`}
                          className="block truncate font-medium hover:underline"
                        >
                          {item?.name ?? 'Unknown item'}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {(m.movement_type as string).replace('_', ' ')}
                          {m.reason ? ` · ${m.reason as string}` : ''}
                        </p>
                      </div>
                      <span className="font-mono text-xs tabular-nums">
                        {change > 0 ? '+' : ''}
                        {formatNumber(change)}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatRelative(m.created_at as string)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingDown className="h-4 w-4 text-warning" />
              Reorder soon
            </CardTitle>
          </CardHeader>
          <CardContent>
            {lowStock.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing below reorder point. Nice.
              </p>
            ) : (
              <ul className="space-y-2">
                {lowStock.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/dashboard/inventory/${row.id}`}
                        className="block truncate font-medium hover:underline"
                      >
                        {row.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {row.primary_location ?? 'No location'}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold tabular-nums text-warning">
                        {formatNumber(row.quantity_on_hand)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        / reorder at {formatNumber(row.reorder_point)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
