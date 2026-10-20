import { Boxes } from 'lucide-react';
import Link from 'next/link';

import {
  DetailSection,
  DetailSectionLink,
  DetailSectionMeta,
} from '@/components/patterns/detail-section';
import { StatePanel } from '@/components/patterns/state-panel';
import { Thumb } from '@/components/patterns/thumb';
import { DeltaText, Timeline, TimelineLabel, TimelineRow } from '@/components/patterns/timeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sparkline } from '@/components/ui/sparkline';
import { StockBar } from '@/components/ui/stock-bar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { movementActorLabel } from '@/lib/movements/actor-label';
import { movementTypeLabel, movementTypeTone } from '@/lib/movements/movement-type';
import { cn, formatNumber, formatRelative } from '@/lib/utils';

import { WidgetHeading } from './shared';
import type { DashboardWidgetProps } from './types';

/** The low-stock table's columns, as before ('' is the status column). */
const LOW_STOCK_COLUMNS = ['Item', 'On hand', 'Reorder', 'Coverage', '14-day', ''] as const;
/** On hand, Reorder and 14-day read right-aligned. */
const RIGHT_ALIGNED = new Set([1, 2, 4]);

/**
 * Recent activity — context, not lead. The reference's bottom row (DESIGN-SPEC
 * 6.16, 7.1): the low-stock detail table beside today's live movement feed.
 * The hero already surfaced the "act now" version of the low-stock signal;
 * this gives the operator the full table to drill into individual SKUs.
 *
 * The table keeps its real columns (no photos are read, no days-left figure:
 * the swatch is the shared missing-photo hatch), and the two cards sit side by
 * side once the widget is wide enough for both (its own width, beside the
 * sidebar), stacked before.
 */
export function RecentActivityWidget({
  lowStock,
  lowStockTrends,
  recentMovements,
  itemCount,
}: DashboardWidgetProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <WidgetHeading
        title="Recent activity"
        description="Low-stock detail and the live movement feed."
      />
      <div className="@container min-w-0">
        <div className="@min-[936px]:grid-cols-12 grid grid-cols-1 gap-4">
          <DetailSection
            headingLevel={3}
            title="Low-stock detail"
            headingId="low-stock-detail-heading"
            className="@min-[936px]:col-span-7"
            aside={
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <DetailSectionMeta>Items below reorder point</DetailSectionMeta>
                <DetailSectionLink href="/dashboard/inventory?stock=low&type=all">
                  View all
                </DetailSectionLink>
              </span>
            }
            flush
          >
            {lowStock.length === 0 && itemCount === 0 ? (
              <StatePanel
                kind="empty"
                surface="plain"
                size="sm"
                headingLevel={3}
                icon={Boxes}
                title="No inventory yet"
                description="Add your first item to start tracking stock, locations, and movements."
                action={
                  <Button asChild variant="gradient" size="sm">
                    <Link href="/dashboard/inventory/new">Add your first item</Link>
                  </Button>
                }
              />
            ) : lowStock.length === 0 ? (
              <StatePanel
                kind="empty"
                surface="plain"
                headingLevel={null}
                icon={null}
                title="Nothing below reorder point. Quiet shift."
              />
            ) : (
              <Table scrollLabelledBy="low-stock-detail-heading" className="min-w-[480px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {LOW_STOCK_COLUMNS.map((h, i) => (
                      <TableHead
                        key={h || i}
                        className={cn('whitespace-nowrap', RIGHT_ALIGNED.has(i) && 'text-right')}
                      >
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lowStock.map((row) => {
                    const par = Math.max(row.reorder_point * 4, row.quantity_on_hand * 1.5, 10);
                    const status: 'ok' | 'warn' | 'crit' =
                      row.quantity_on_hand <= 0 ? 'crit' : 'warn';
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="min-w-[150px]">
                          <div className="flex min-w-0 items-center gap-3">
                            <Thumb size={32} />
                            <div className="min-w-0">
                              <Link
                                href={`/dashboard/inventory/${row.id}`}
                                className="text-foreground font-medium hover:underline"
                              >
                                {row.name}
                              </Link>
                              <div className="text-muted-foreground whitespace-nowrap font-mono text-[11.5px]">
                                {row.sku}
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {formatNumber(row.quantity_on_hand)}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-right font-mono tabular-nums">
                          {formatNumber(row.reorder_point)}
                        </TableCell>
                        <TableCell>
                          <StockBar
                            stock={row.quantity_on_hand}
                            par={par}
                            status={status}
                            width={56}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Sparkline
                            data={
                              lowStockTrends.get(row.id)?.qtySeries ??
                              new Array<number>(14).fill(row.quantity_on_hand)
                            }
                            width={56}
                            height={20}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right">
                          {/* The tone recipes (DESIGN-SPEC 6.10): danger and
                              caution text on their own washes. The old Low
                              pill put the on-fill --warning-foreground on a
                              warning tint (1.48:1 in dark). */}
                          <Badge dot variant={status === 'crit' ? 'destructive' : 'warning'}>
                            {status === 'crit' ? 'Out' : 'Low'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </DetailSection>

          <DetailSection
            headingLevel={3}
            title="Today's activity"
            className="@min-[936px]:col-span-5"
            aside={<DetailSectionMeta>Live · across all locations</DetailSectionMeta>}
            flush
          >
            {recentMovements.length === 0 ? (
              <StatePanel
                kind="empty"
                surface="plain"
                headingLevel={null}
                icon={null}
                title="No movements yet. Adjust stock from any item to see entries here."
              />
            ) : (
              <Timeline variant="rows">
                {recentMovements.map((m) => {
                  const item = m.item;
                  const change = Number(m.quantity_change);
                  // Transfers are net-zero (quantity_change always 0); show the
                  // physical qty moved (moved_quantity, mig 0231) neutrally.
                  // Pre-0231 transfer rows have none → no number, never "0".
                  const isTransfer = m.movement_type === 'transfer';
                  const moved = m.moved_quantity == null ? null : Number(m.moved_quantity);
                  // Units shorten as whole words only ("2 days" reads "2 d"):
                  // a bare /days?/ also matched inside "yesterday" and printed
                  // "yesterd" (FX1). "yesterday", "last week" and "now" print
                  // in full.
                  const when = formatRelative(m.created_at)
                    .replace(' ago', '')
                    .replace(/\bseconds?\b/, 's')
                    .replace(/\bminutes?\b/, 'm')
                    .replace(/\bhours?\b/, 'h')
                    .replace(/\bdays?\b/, 'd');
                  return (
                    <TimelineRow
                      key={m.id}
                      data-movement-type={m.movement_type}
                      title={
                        <>
                          {/* The type in the Movements page's words and tone
                              (DESIGN-SPEC 6.16 and 6.10): Receive PO, not
                              "Receive po", and its colour from the type, not
                              the sign of the change (FX5). */}
                          <TimelineLabel tone={movementTypeTone(m.movement_type)}>
                            {movementTypeLabel(m.movement_type)}
                          </TimelineLabel>
                          {' · '}
                          {item?.name ?? 'Unknown'}
                        </>
                      }
                      meta={
                        <>
                          {movementActorLabel(m)}
                          {(m.reason ?? null) && (
                            <>
                              {' · '}
                              {m.reason}
                            </>
                          )}
                          {' · '}
                          <span>{when}</span>
                        </>
                      }
                      aside={
                        isTransfer ? (
                          moved != null ? (
                            <span className="text-muted-foreground font-mono text-[13px] tabular-nums">
                              {formatNumber(moved)}
                            </span>
                          ) : null
                        ) : (
                          <DeltaText value={change}>
                            {change > 0 ? '+' : ''}
                            {formatNumber(change)}
                          </DeltaText>
                        )
                      }
                    />
                  );
                })}
              </Timeline>
            )}
          </DetailSection>
        </div>
      </div>
    </div>
  );
}
