import { Boxes, ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/ui/empty-state';
import { Sparkline } from '@/components/ui/sparkline';
import { StockBar } from '@/components/ui/stock-bar';
import { cn, formatNumber, formatRelative } from '@/lib/utils';

import { Card, CardHead } from './shared';
import type { DashboardWidgetProps } from './types';

/**
 * Recent activity — context, not lead. Low-stock detail table (left 7/12) +
 * today's live movement feed (right 5/12). The hero already surfaced the
 * "act now" version of the low-stock signal; this gives the operator the full
 * table to drill into individual SKUs.
 */
export function RecentActivityWidget({
  lowStock,
  lowStockTrends,
  recentMovements,
  itemCount,
}: DashboardWidgetProps) {
  return (
    <>
      <div className="mt-2 mb-4 flex items-end justify-between gap-3 border-b border-border pb-2">
        <div>
          <h2 className="font-display text-[18px] font-medium tracking-[-0.015em]">
            Recent activity
          </h2>
          <p className="text-[12px] text-[var(--ed-ink-3)]">
            Low-stock detail and the live movement feed.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardHead
            title="Low-stock detail"
            subtitle="Items below reorder point"
            action={
              <Link
                href="/dashboard/inventory?stock=low&type=all"
                className="border-border bg-card inline-flex h-6 items-center gap-1 rounded-md border px-2.5 text-[12px] hover:border-[var(--ed-line-strong)]"
              >
                View all <ChevronRight className="h-3 w-3" />
              </Link>
            }
          />
          {lowStock.length === 0 && itemCount === 0 ? (
            <div className="px-5 pb-6">
              <EmptyState
                icon={Boxes}
                title="No inventory yet"
                description="Add your first item to start tracking stock, locations, and movements."
                cta={{ label: 'Add your first item', href: '/dashboard/inventory/new' }}
                size="sm"
              />
            </div>
          ) : lowStock.length === 0 ? (
            <p className="px-5 pb-5 text-[12.5px] text-[var(--ed-ink-3)]">
              Nothing below reorder point. Quiet shift.
            </p>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-border border-b">
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
                    <tr
                      key={row.id}
                      className="border-border hover:bg-muted/50 border-b last:border-0"
                    >
                      <td className="py-2.5 pl-3 pr-3">
                        <div className="flex items-center gap-2.5">
                          <span
                            aria-hidden
                            className="border-border h-7 w-7 shrink-0 rounded-[5px] border"
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
                            <div className="font-mono text-[10.5px] text-[var(--ed-ink-3)]">
                              {row.sku}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 text-right font-mono tabular-nums">
                        {formatNumber(row.quantity_on_hand)}
                      </td>
                      <td className="px-3 text-right font-mono tabular-nums text-[var(--ed-ink-3)]">
                        {formatNumber(row.reorder_point)}
                      </td>
                      <td className="px-3">
                        <StockBar stock={row.quantity_on_hand} par={par} status={status} />
                      </td>
                      <td className="px-3 text-right">
                        <Sparkline
                          data={
                            lowStockTrends.get(row.id)?.qtySeries ??
                            new Array<number>(14).fill(row.quantity_on_hand)
                          }
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
                // Transfers are net-zero (quantity_change always 0); show the
                // physical qty moved (moved_quantity, mig 0231) neutrally.
                // Pre-0231 transfer rows have none → no number, never "0".
                const isTransfer = m.movement_type === 'transfer';
                const moved = m.moved_quantity == null ? null : Number(m.moved_quantity);
                return (
                  <li
                    key={m.id}
                    className={cn(
                      'grid items-center gap-3 px-5 py-2.5',
                      i < recentMovements.length - 1 && 'border-border border-b',
                    )}
                    style={{ gridTemplateColumns: '60px 1fr auto' }}
                  >
                    <div className="font-mono text-[10.5px] text-[var(--ed-ink-3)]">
                      {formatRelative(m.created_at)
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
                          {m.movement_type.replace('_', ' ')}
                        </span>
                        {item?.name ?? 'Unknown'}
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-[var(--ed-ink-3)]">
                        {m.actor?.fullName ?? m.actor?.email ?? (m.user_id ? 'Unknown' : 'System')}
                        {(m.reason ?? null) && (
                          <>
                            {' · '}
                            {m.reason}
                          </>
                        )}
                      </div>
                    </div>
                    <div
                      className={cn(
                        'font-mono text-[13px] font-medium tabular-nums',
                        !isTransfer && change > 0
                          ? 'text-[hsl(var(--accent-foreground))]'
                          : 'text-[var(--ed-ink-3)]',
                      )}
                    >
                      {isTransfer ? (
                        moved != null ? formatNumber(moved) : ''
                      ) : (
                        <>
                          {change > 0 ? '+' : ''}
                          {formatNumber(change)}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
