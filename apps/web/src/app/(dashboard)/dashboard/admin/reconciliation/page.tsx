import Link from 'next/link';

import { FilterChipLink } from '@/components/patterns/chip';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader } from '@/components/patterns/page-header';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { effectiveNavLabel } from '@/lib/nav-labels';
import { ReconciliationService } from '@/server/services/reconciliation';
import { formatCurrency, formatRelative } from '@/lib/utils';

/**
 * The status label's tone (DESIGN-SPEC 6.10), the same tones the PO pages use
 * for each status. The words stay this page's own (the status with its
 * underscores turned into spaces), so colour is never the only cue.
 */
const STATUS_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  draft: 'outline',
  expected_inbound: 'secondary',
  ordered: 'secondary',
  partially_received: 'warning',
  received: 'success',
  cancelled: 'destructive',
};

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; vendor?: string }>;
}) {
  const params = await searchParams;
  const status = (params.status as 'open' | 'closed' | 'all' | undefined) ?? 'open';

  const svc = await ReconciliationService.forCurrentUser();
  const [data, title] = await Promise.all([
    svc.summary({
      status,
      vendorId: params.vendor || null,
    }),
    // A Settings > Navigation rename of the sidebar entry reaches the heading
    // (no read of its own: the org row is cached for the request).
    effectiveNavLabel('/dashboard/admin/reconciliation', 'Reconciliation'),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        title={title}
        subline="What was ordered vs received vs open, by PO, vendor, and warehouse."
      />

      {/* The status filter stays in the URL (?status=), as before. */}
      <div className="flex flex-wrap gap-2">
        {(['open', 'closed', 'all'] as const).map((s) => (
          <FilterChipLink
            key={s}
            href={`/dashboard/admin/reconciliation?status=${s}`}
            active={status === s}
            aria-current={status === s ? 'page' : undefined}
            size="md"
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </FilterChipLink>
        ))}
      </div>

      {/* Totals over every matching PO (the service reads all of them). */}
      <StatStrip>
        <StatStripItem label="Qty ordered" value={data.totals.qtyOrdered.toLocaleString()} />
        <StatStripItem label="Qty received" value={data.totals.qtyReceived.toLocaleString()} />
        <StatStripItem label="Qty open" value={data.totals.qtyOpen.toLocaleString()} />
      </StatStrip>

      <DetailSection title="Vendor performance" flush>
        <Table className="min-w-[560px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Vendor</TableHead>
              <TableHead className="text-right">POs</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">Fill rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.byVendor.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="text-muted-foreground py-6 text-center">
                  No vendor data yet.
                </TableCell>
              </TableRow>
            ) : (
              data.byVendor.map((v) => (
                <TableRow key={v.supplier_id}>
                  <TableCell className="font-medium">{v.supplier_name ?? '—'}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{v.po_count}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {Number(v.qty_ordered).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {Number(v.qty_received).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {v.fill_rate_pct != null ? `${v.fill_rate_pct}%` : '—'}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </DetailSection>

      <DetailSection title={`Purchase orders (${status})`} flush>
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>PO #</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">Open</TableHead>
              <TableHead className="text-right">Cost ordered</TableHead>
              <TableHead className="text-right">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="text-muted-foreground py-6 text-center">
                  No POs in this filter.
                </TableCell>
              </TableRow>
            ) : (
              data.rows.map((r) => (
                <TableRow key={r.purchase_order_id}>
                  <TableCell>
                    <Link
                      href={`/dashboard/purchase-orders/${r.purchase_order_id}`}
                      className="text-foreground font-mono text-[12.5px] underline-offset-2 hover:underline"
                    >
                      {r.po_number}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>
                      {r.status.replace(/_/g, ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-ink-2">{r.supplier_name ?? '—'}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {Number(r.qty_ordered_total).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {Number(r.qty_received_total).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {Number(r.qty_open_total).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatCurrency(Number(r.cost_ordered_total))}
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-right text-[12.5px]">
                    {formatRelative(r.updated_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </DetailSection>
    </div>
  );
}
