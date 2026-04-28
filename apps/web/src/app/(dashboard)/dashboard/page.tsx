import { Boxes, ChevronRight, Download, Plus, Zap } from 'lucide-react';
import Link from 'next/link';

import { BigChart, MiniBarChart } from '@/components/dashboard/big-chart';
import { EmptyState } from '@/components/dashboard/empty-state';
import { StatCard } from '@/components/dashboard/stat-card';
import { Button } from '@/components/ui/button';
import { Sparkline } from '@/components/ui/sparkline';
import { StockBar } from '@/components/ui/stock-bar';
import { getDashboardSummary, getLowStockItems, MovementsService } from '@/server/services/movements';
import { requireOrgContext } from '@/lib/auth/session';
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';
import { cn } from '@/lib/utils';

const TODAY_LABEL = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export default async function DashboardHome() {
  const ctx = await requireOrgContext();

  // One PostgREST round trip per Promise.all branch; cache() de-dupes the
  // identity load across them.
  const movementsSvc = await MovementsService.forCurrentUser();
  const [summary, lowStock, recentMovements] = await Promise.all([
    getDashboardSummary(), // 1 RPC: combined item count, OOS, low-stock, value
    getLowStockItems(5), // 1 RPC
    movementsSvc.list({ limit: 6 }), // 1 query, items embedded via FK
  ]);

  // Build a synthetic 30-day inventory-value series until a real time-series
  // RPC ships. Cheap, render-only.
  const valueSeries = Array.from({ length: 30 }, (_, i) => {
    const base = summary.inventoryValue || 1000;
    const sin = Math.sin(i / 4) * base * 0.04;
    return { value: Math.round(base + sin + (i / 30) * base * 0.06), label: `D-${30 - i}` };
  });

  // Synthetic 30-day movement bar values
  const barValues = [12, 18, 16, 9, 14, 22, 17, 19, 11, 15, 21, 16, 18, 4, 8, 12, 11, 17, 19, 22, 18, 15, 13, 9, 12, 14, 17, 19, 11, 8];

  const breakdownRows = [
    { label: 'Receive', share: 0.42, val: 14 },
    { label: 'Sale', share: 0.66, val: 22 },
    { label: 'Transfer', share: 0.27, val: 9 },
    { label: 'Adjust', share: 0.12, val: 4 },
  ];

  const today = TODAY_LABEL.format(new Date());

  return (
    <div className="mx-auto w-full max-w-[1480px] px-8 pb-20 pt-7">
      <div className="mb-5 flex items-end justify-between gap-6 border-b border-border pb-4">
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
            {today}
          </p>
          <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">
            {ctx.fullName ? `Good morning, ${ctx.fullName.split(' ')[0]}.` : 'Welcome back.'}
          </h1>
          <p className="mt-1 text-[13.5px] text-[var(--ed-ink-3)]">
            {summary.lowStockCount > 0
              ? `${summary.lowStockCount} item${summary.lowStockCount === 1 ? '' : 's'} need attention.`
              : 'Nothing critical right now. Quiet shift.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard/reports">
              <Download className="h-3 w-3" /> Export
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard/inventory/new">
              <Plus className="h-3 w-3" /> New item
            </Link>
          </Button>
          <Button size="sm" asChild>
            <Link href="/dashboard/purchase-orders/new">
              <Zap className="h-3 w-3" /> Receive stock
            </Link>
          </Button>
        </div>
      </div>

      {/* Stat row */}
      <div className="mb-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Inventory value"
          value={formatCurrency(summary.inventoryValue)}
          delta={{ value: '+4.8%', direction: 'up' }}
          series={valueSeries.slice(-14).map((d) => d.value)}
          foot="vs. 30-day avg"
        />
        <StatCard
          label="Items on hand"
          value={formatNumber(summary.itemCount)}
          delta={{ value: '+1.2%', direction: 'up' }}
          series={[310, 312, 314, 318, 322, 319, 321, 326, 332, 330, 334, 338, 342, 344]}
          foot={`${summary.itemCount} active SKUs`}
        />
        <StatCard
          label="Low / out of stock"
          value={formatNumber(summary.lowStockCount + summary.outOfStockCount)}
          delta={{ value: `+${summary.lowStockCount}`, direction: 'down' }}
          series={[3, 3, 4, 4, 4, 4, 5, 5, 5, 6, 6, 6, 6, 7]}
          foot={`${summary.outOfStockCount} critical · ${summary.lowStockCount} below par`}
        />
        <StatCard
          label="Movements today"
          value={formatNumber(recentMovements.length)}
          delta={{ value: '—', direction: 'flat' }}
          series={[12, 18, 9, 14, 22, 17, 19, 11, 15, 21, 16, 18, 20, 4]}
          foot="across all locations"
        />
      </div>

      {/* Big chart + movement breakdown */}
      <div className="mb-4 grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        <Card className="lg:col-span-8">
          <CardHead
            title="Inventory value · 30 days"
            subtitle="USD · cost basis · all locations"
            chips={['All locations', 'Cost basis', '+ Compare']}
          />
          <BigChart data={valueSeries} height={240} />
          <div className="flex justify-between px-5 pb-3.5 font-mono text-[11px] text-[var(--ed-ink-4)]">
            <span>30 days ago</span>
            <span>3 weeks ago</span>
            <span>2 weeks ago</span>
            <span>1 week ago</span>
            <span>Today</span>
          </div>
        </Card>

        <Card className="lg:col-span-4">
          <CardHead title="Movements · 30 days" subtitle="Receive · sale · transfer · adjust" />
          <div className="px-5 pb-4">
            <MiniBarChart values={barValues} height={120} />
            <hr className="my-4 border-border" />
            <div className="flex flex-col gap-3">
              {breakdownRows.map((r) => (
                <div key={r.label} className="flex items-center justify-between">
                  <span className="text-[12.5px]">{r.label}</span>
                  <div className="flex items-center gap-2">
                    <span
                      className="block h-1.5 w-20 overflow-hidden rounded-full bg-muted"
                      aria-hidden
                    >
                      <span
                        className="block h-full rounded-full bg-[var(--ed-ink-2)]"
                        style={{ width: `${r.share * 100}%` }}
                      />
                    </span>
                    <span className="w-6 text-right font-mono text-[11.5px] tabular-nums text-[var(--ed-ink-3)]">
                      {r.val}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* Needs attention + Activity */}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardHead
            title="Needs attention"
            subtitle="Items below reorder point"
            action={
              <Link
                href="/dashboard/inventory?status=low"
                className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-[12px] hover:border-[var(--ed-line-strong)]"
              >
                View all <ChevronRight className="h-3 w-3" />
              </Link>
            }
          />
          {lowStock.length === 0 && summary.itemCount === 0 ? (
            <div className="px-5 pb-6">
              <EmptyState
                icon={Boxes}
                title="No inventory yet"
                description="Add your first item to start tracking stock, locations, and movements."
                action={
                  <Button size="sm" asChild>
                    <Link href="/dashboard/inventory/new">Add your first item</Link>
                  </Button>
                }
              />
            </div>
          ) : lowStock.length === 0 ? (
            <p className="px-5 pb-5 text-[12.5px] text-[var(--ed-ink-3)]">
              Nothing below reorder point. Quiet shift.
            </p>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-border">
                  {['Item', 'On hand', 'Reorder', 'Coverage', '14-day', ''].map((h, i) => (
                    <th
                      key={h || i}
                      className={cn(
                        'h-9 px-3 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]',
                        (i === 1 || i === 2 || i === 4) && 'text-right',
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lowStock.map((row) => {
                  const par = Math.max(row.reorder_point * 4, row.quantity_on_hand * 1.5, 10);
                  const status: 'ok' | 'warn' | 'crit' =
                    row.quantity_on_hand <= 0 ? 'crit' : 'warn';
                  return (
                    <tr key={row.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                      <td className="py-2.5 pl-3 pr-3">
                        <div className="flex items-center gap-2.5">
                          <span
                            aria-hidden
                            className="h-7 w-7 shrink-0 rounded-[5px] border border-border"
                            style={{
                              background:
                                'repeating-linear-gradient(45deg, hsl(var(--border)) 0 1px, transparent 1px 6px), hsl(var(--muted))',
                            }}
                          />
                          <div>
                            <Link
                              href={`/dashboard/inventory/${row.id}`}
                              className="font-medium hover:underline"
                            >
                              {row.name}
                            </Link>
                            <div className="font-mono text-[10.5px] text-[var(--ed-ink-3)]">{row.sku}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 text-right font-mono tabular-nums">{formatNumber(row.quantity_on_hand)}</td>
                      <td className="px-3 text-right font-mono tabular-nums text-[var(--ed-ink-3)]">
                        {formatNumber(row.reorder_point)}
                      </td>
                      <td className="px-3">
                        <StockBar stock={row.quantity_on_hand} par={par} status={status} />
                      </td>
                      <td className="px-3 text-right">
                        <Sparkline
                          data={Array.from({ length: 14 }, (_, i) =>
                            Math.max(0, Math.round(row.quantity_on_hand + Math.sin(i / 2) * 4 - i / 2)),
                          )}
                          width={70}
                          height={20}
                        />
                      </td>
                      <td className="px-3 text-right">
                        <span
                          className={cn(
                            'inline-flex h-5 items-center gap-1 rounded-[4px] px-1.5 text-[11px] font-medium',
                            status === 'crit'
                              ? 'bg-[hsl(var(--destructive)/0.16)] text-[hsl(var(--destructive))]'
                              : 'bg-[hsl(var(--warning)/0.18)] text-[hsl(var(--warning-foreground))]',
                          )}
                        >
                          <span className="h-1 w-1 rounded-full bg-current" />
                          {status === 'crit' ? 'Out' : 'Low'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="lg:col-span-5">
          <CardHead title="Today's activity" subtitle="Live · across all locations" />
          {recentMovements.length === 0 ? (
            <p className="px-5 pb-5 text-[12.5px] text-[var(--ed-ink-3)]">
              No movements yet. Adjust stock from any item to see entries here.
            </p>
          ) : (
            <ul>
              {recentMovements.map((m, i) => {
                const item = m.item;
                const change = Number(m.quantity_change);
                return (
                  <li
                    key={m.id as string}
                    className={cn(
                      'grid items-center gap-3 px-5 py-2.5',
                      i < recentMovements.length - 1 && 'border-b border-border',
                    )}
                    style={{ gridTemplateColumns: '60px 1fr auto' }}
                  >
                    <div className="font-mono text-[10.5px] text-[var(--ed-ink-3)]">
                      {formatRelative(m.created_at as string)
                        .replace(' ago', '')
                        .replace(/seconds?/, 's')
                        .replace(/minutes?/, 'm')
                        .replace(/hours?/, 'h')
                        .replace(/days?/, 'd')}
                    </div>
                    <div>
                      <div className="text-[12.5px]">
                        <span
                          className={cn(
                            'mr-1.5 inline-flex h-[18px] items-center rounded-[4px] px-1.5 text-[10px] font-medium',
                            change > 0
                              ? 'bg-[hsl(var(--accent)/0.18)] text-[hsl(var(--accent-foreground))]'
                              : 'bg-muted text-[var(--ed-ink-3)]',
                          )}
                        >
                          {(m.movement_type as string).replace('_', ' ')}
                        </span>
                        {item?.name ?? 'Unknown'}
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-[var(--ed-ink-3)]">
                        {(m.reason as string | null) ?? '—'}
                      </div>
                    </div>
                    <div
                      className={cn(
                        'font-mono text-[13px] font-medium tabular-nums',
                        change > 0 ? 'text-[hsl(var(--accent-foreground))]' : 'text-[var(--ed-ink-3)]',
                      )}
                    >
                      {change > 0 ? '+' : ''}
                      {formatNumber(change)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-[10px] border border-border bg-card', className)}>
      {children}
    </div>
  );
}

function CardHead({
  title,
  subtitle,
  chips,
  action,
}: {
  title: string;
  subtitle?: string;
  chips?: string[];
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
      <div>
        <div className="font-display text-[14px] font-medium tracking-[-0.01em]">{title}</div>
        {subtitle && <div className="text-[12px] text-[var(--ed-ink-3)]">{subtitle}</div>}
      </div>
      {chips && (
        <div className="flex items-center gap-2">
          {chips.map((c) => (
            <span
              key={c}
              className={cn(
                'inline-flex h-6 items-center rounded-full border px-2.5 text-[11.5px]',
                c.startsWith('+')
                  ? 'border-dashed border-border text-[var(--ed-ink-3)]'
                  : 'border-border bg-background text-[var(--ed-ink-2)]',
              )}
            >
              {c}
            </span>
          ))}
        </div>
      )}
      {action}
    </div>
  );
}
