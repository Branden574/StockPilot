import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReconciliationService } from '@/server/services/reconciliation';
import { formatCurrency, formatRelative } from '@/lib/utils';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  expected_inbound: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  ordered: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  partially_received:
    'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  received:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  cancelled: 'bg-muted text-muted-foreground',
};

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; vendor?: string }>;
}) {
  const params = await searchParams;
  const status = (params.status as 'open' | 'closed' | 'all' | undefined) ?? 'open';

  const svc = await ReconciliationService.forCurrentUser();
  const data = await svc.summary({
    status,
    vendorId: params.vendor || null,
  });

  return (
    <div className="mx-auto w-full max-w-[1400px] px-8 pb-20 pt-7">
      <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">
        Reconciliation
      </h1>
      <p className="text-muted-foreground mt-1 text-[13.5px]">
        What was ordered vs received vs open, by PO, vendor, and warehouse.
      </p>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {(['open', 'closed', 'all'] as const).map((s) => (
          <Link
            key={s}
            href={`/dashboard/admin/reconciliation?status=${s}`}
            className={
              'rounded-full border px-3 py-1 transition-colors ' +
              (status === s
                ? 'border-primary bg-primary/5'
                : 'border-border bg-card hover:bg-muted/40')
            }
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <SummaryCard label="Qty ordered" value={data.totals.qtyOrdered.toLocaleString()} />
        <SummaryCard
          label="Qty received"
          value={data.totals.qtyReceived.toLocaleString()}
        />
        <SummaryCard label="Qty open" value={data.totals.qtyOpen.toLocaleString()} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Vendor performance</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">POs</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Fill rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.byVendor.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground text-center text-xs">
                    No vendor data yet.
                  </TableCell>
                </TableRow>
              ) : (
                data.byVendor.map((v) => (
                  <TableRow key={v.supplier_id}>
                    <TableCell className="font-medium">{v.supplier_name ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{v.po_count}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(v.qty_ordered).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(v.qty_received).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {v.fill_rate_pct != null ? `${v.fill_rate_pct}%` : '—'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Purchase orders ({status})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
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
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground text-center text-xs">
                    No POs in this filter.
                  </TableCell>
                </TableRow>
              ) : (
                data.rows.map((r) => (
                  <TableRow key={r.purchase_order_id}>
                    <TableCell>
                      <Link
                        href={`/dashboard/purchase-orders/${r.purchase_order_id}`}
                        className="font-mono hover:underline"
                      >
                        {r.po_number}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] ${
                          STATUS_COLORS[r.status] ?? 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {r.status.replace(/_/g, ' ')}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{r.supplier_name ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(r.qty_ordered_total).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(r.qty_received_total).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(r.qty_open_total).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(Number(r.cost_ordered_total))}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatRelative(r.updated_at)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-muted-foreground text-xs uppercase tracking-wider">{label}</p>
        <p className="mt-1 font-display text-2xl font-medium tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
