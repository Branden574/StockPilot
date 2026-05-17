import { Download } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ItemThumb } from '@/components/items/item-thumb';
import { ShipmentsDeprecatedBanner } from '@/components/shipments/shipments-deprecated-banner';
import { ShipmentStatusBadge } from '@/components/shipments/shipment-status-badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { addressJsonToLines } from '@/lib/pdf/shipment';
import { ServiceError } from '@/server/services/context';
import { ShipmentsService } from '@/server/services/shipments';
import { formatNumber, formatRelative } from '@/lib/utils';

export default async function ShipmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const svc = await ShipmentsService.forCurrentUser();
  let detail;
  try {
    detail = await svc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const sourceAddrLines = addressJsonToLines(detail.source?.address ?? null);
  // Destination is a charter — no address field, so no destination address.
  const totalShipped = detail.lines.reduce((s, l) => s + l.qtyShipped, 0);
  const totalBackOrdered = detail.lines.reduce(
    (s, l) => s + l.qtyBackOrdered,
    0,
  );

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <ShipmentsDeprecatedBanner />
      <div className="mt-6 mb-6">
        <Link
          href="/dashboard/shipments"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to shipments
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            {detail.workOrderNumber}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ShipmentStatusBadge status={detail.status} />
            <span className="text-muted-foreground text-sm">
              · ship date {detail.shipDate}
            </span>
            <span className="text-muted-foreground text-sm">
              · created {formatRelative(detail.createdAt)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <a
              href={`/api/shipments/${id}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download className="h-4 w-4" /> Download PDF
            </a>
          </Button>
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <section className="bg-card rounded-xl border lg:col-span-2">
          <div className="border-border flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-medium">
              Lines ({detail.lines.length})
            </h2>
            <p className="text-muted-foreground text-xs tabular-nums">
              Total qty {formatNumber(totalShipped)} · B.O.{' '}
              {formatNumber(totalBackOrdered)}
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead className="w-14">Image</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>ISBN</TableHead>
                <TableHead className="text-right">Qty shipped</TableHead>
                <TableHead className="text-right">B.O.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.lines.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-muted-foreground py-6 text-center text-sm"
                  >
                    No lines on this shipment.
                  </TableCell>
                </TableRow>
              )}
              {detail.lines.map((l, idx) => {
                const isbn = l.item?.barcode ?? l.item?.sku ?? '';
                return (
                  <TableRow key={l.id}>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {idx + 1}
                    </TableCell>
                    <TableCell>
                      <ItemThumb
                        imageUrl={l.imageUrl}
                        alt={l.item?.name ?? 'Item'}
                        size="md"
                        itemId={l.itemId}
                      />
                    </TableCell>
                    <TableCell>
                      {l.item ? (
                        <Link
                          href={`/dashboard/inventory/${l.item.id}`}
                          className="hover:underline"
                        >
                          <div className="font-medium">{l.item.name}</div>
                          <div className="text-muted-foreground font-mono text-[11px]">
                            {l.item.sku}
                          </div>
                        </Link>
                      ) : (
                        <span className="text-muted-foreground italic">
                          Deleted item
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {isbn || '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(l.qtyShipped)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(l.qtyBackOrdered)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </section>

        <aside className="space-y-4">
          <section className="bg-card rounded-xl border p-4">
            <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">
              Ship to
            </h2>
            <p className="font-medium">{detail.destination?.name ?? '—'}</p>
            {detail.destination?.code ? (
              <p className="text-muted-foreground mt-0.5 font-mono text-[11px]">
                {detail.destination.code}
              </p>
            ) : null}
            {detail.attentionToName && (
              <p className="text-muted-foreground mt-2 text-xs">
                Attention: {detail.attentionToName}
              </p>
            )}
          </section>

          <section className="bg-card rounded-xl border p-4">
            <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">
              Ship from
            </h2>
            <p className="font-medium">{detail.source?.name ?? '—'}</p>
            <div className="text-muted-foreground mt-2 space-y-0.5 text-xs">
              {sourceAddrLines.map((l, i) => (
                 
                <p key={`s-${i}`}>{l}</p>
              ))}
              {detail.source?.contactPhone && <p>{detail.source.contactPhone}</p>}
              {detail.source?.contactEmail && <p>{detail.source.contactEmail}</p>}
            </div>
            {detail.source?.manager && (
              <div className="border-border mt-3 border-t pt-3 text-xs">
                <p className="text-muted-foreground">Warehouse manager</p>
                <p className="font-medium">
                  {detail.source.manager.fullName ?? detail.source.manager.email ?? '—'}
                </p>
                {detail.source.manager.role && (
                  <p className="text-muted-foreground capitalize">
                    {detail.source.manager.role}
                  </p>
                )}
              </div>
            )}
          </section>

          {detail.notes && (
            <section className="bg-card rounded-xl border p-4">
              <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">
                Notes
              </h2>
              <p className="whitespace-pre-wrap text-sm">{detail.notes}</p>
            </section>
          )}

          {detail.orderRequestId && (
            <section className="bg-card rounded-xl border p-4 text-xs">
              <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">
                Linked order request
              </h2>
              <Link
                href={`/dashboard/orders/${detail.orderRequestId}`}
                className="hover:underline"
              >
                View source request →
              </Link>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
