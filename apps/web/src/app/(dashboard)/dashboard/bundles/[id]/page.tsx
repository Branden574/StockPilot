import { Edit, Package } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ArchiveBundleButton } from '@/components/bundles/archive-bundle-button';
import { AssembleBundleModal } from '@/components/bundles/assemble-bundle-modal';
import { DistributeBundleModal } from '@/components/bundles/distribute-bundle-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { hasPermission } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { BundlesService } from '@/server/services/bundles';
import { WarehousesService } from '@/server/services/warehouses';
import { formatNumber, formatRelative } from '@/lib/utils';

export default async function BundleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireOrgContext();
  const canManage = hasPermission(ctx.role, 'bundles:manage');
  const canDistribute = hasPermission(ctx.role, 'bundles:distribute');

  const svc = await BundlesService.forCurrentUser();
  let detail;
  try {
    detail = await svc.get(id);
  } catch {
    notFound();
  }

  const [whs, recent, upcomingEvents] = await Promise.all([
    (await WarehousesService.forCurrentUser()).list(),
    svc.recentDistributions({ bundleId: id, limit: 20 }),
    fetchUpcomingEvents(),
  ]);

  const warehouseMap = new Map(whs.map((w) => [w.id, w.name]));

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/bundles"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to bundles
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                {detail.bundle.name}
              </h1>
              {detail.bundle.archived_at ? (
                <Badge variant="outline">Archived</Badge>
              ) : detail.bundle.is_active ? (
                <Badge variant="success">Active</Badge>
              ) : (
                <Badge variant="warning">Inactive</Badge>
              )}
              {detail.bundle.preassembly_enabled && (
                <Badge variant="outline">Pre-assembly</Badge>
              )}
            </div>
            {detail.bundle.sku && (
              <p className="text-muted-foreground mt-1 font-mono text-xs">
                {detail.bundle.sku}
              </p>
            )}
            {detail.bundle.description && (
              <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
                {detail.bundle.description}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <Button asChild variant="outline">
                <Link href={`/dashboard/bundles/${id}/edit`}>
                  <Edit className="h-3.5 w-3.5" />
                  Edit
                </Link>
              </Button>
            )}
            {canManage && !detail.bundle.archived_at && (
              <ArchiveBundleButton bundleId={id} bundleName={detail.bundle.name} />
            )}
            {canDistribute && detail.bundle.is_active && !detail.bundle.archived_at && (
              <DistributeBundleModal
                bundleId={id}
                bundleName={detail.bundle.name}
                warehouses={whs}
                upcomingEvents={upcomingEvents}
              />
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="bg-card rounded-xl border">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-medium">
                Components ({detail.components.length})
              </h2>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Qty / kit</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="text-center">Optional</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.components.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground py-6 text-center text-sm">
                      No components — edit this bundle to add some.
                    </TableCell>
                  </TableRow>
                )}
                {detail.components.map((c) => (
                  <TableRow key={c.itemId}>
                    <TableCell>
                      {c.itemId ? (
                        <Link
                          href={`/dashboard/inventory/${c.itemId}`}
                          className="hover:underline"
                        >
                          <div className="font-medium">{c.itemName}</div>
                          <div className="text-muted-foreground font-mono text-[11px]">
                            {c.itemSku}
                          </div>
                        </Link>
                      ) : (
                        <span className="text-muted-foreground italic">
                          Deleted item
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(c.quantity)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatNumber(c.itemQuantityOnHand)}
                    </TableCell>
                    <TableCell className="text-center">
                      {c.isOptional ? <Badge variant="outline">Optional</Badge> : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <section className="bg-card rounded-xl border">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-medium">Recent distributions</h2>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead>Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground py-6 text-center text-sm">
                      No distributions yet.
                    </TableCell>
                  </TableRow>
                )}
                {recent.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(d.distributed_at)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {warehouseMap.get(d.warehouse_id) ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(Number(d.quantity))}
                    </TableCell>
                    <TableCell className="max-w-[280px] truncate text-xs text-muted-foreground">
                      {d.notes ?? '—'}
                    </TableCell>
                    <TableCell>
                      {d.shortage_recorded && (
                        <Badge variant="destructive">Shortage</Badge>
                      )}
                      {d.schedule_event_id && (
                        <Badge variant="outline" className="ml-1">Event</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </div>

        <aside className="space-y-4">
          {detail.bundle.preassembly_enabled && (
            <section className="bg-card rounded-xl border p-4">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-medium">Pre-assembled stock</h2>
              </div>
              <div className="mt-3">
                <div className="font-mono text-3xl font-semibold tabular-nums">
                  {formatNumber(detail.phantom?.quantityOnHand ?? 0)}
                </div>
                <div className="text-muted-foreground mt-1 text-[11.5px]">
                  kits ready{' '}
                  {detail.phantom?.warehouseId
                    ? `at ${warehouseMap.get(detail.phantom.warehouseId) ?? 'a warehouse'}`
                    : ''}
                </div>
              </div>
              {canManage && (
                <div className="mt-3">
                  <AssembleBundleModal
                    bundleId={id}
                    bundleName={detail.bundle.name}
                    warehouses={whs}
                    lockedWarehouseId={detail.phantom?.warehouseId ?? null}
                  />
                </div>
              )}
            </section>
          )}

          <section className="bg-card rounded-xl border p-4 text-xs">
            <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">
              Audit
            </h2>
            <dl className="space-y-1.5 text-[11.5px]">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Created</dt>
                <dd className="tabular-nums">
                  {formatRelative(detail.bundle.created_at)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Updated</dt>
                <dd className="tabular-nums">
                  {formatRelative(detail.bundle.updated_at)}
                </dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}

async function fetchUpcomingEvents(): Promise<
  Array<{ id: string; title: string; startsAt: string }>
> {
  try {
    const supabase = await createClient();
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const untilIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('schedule_events')
      .select('id, title, starts_at')
      .gte('starts_at', sinceIso)
      .lte('starts_at', untilIso)
      .in('status', ['scheduled', 'in_progress'])
      .order('starts_at', { ascending: true })
      .limit(20);
    return (data ?? []).map((e) => ({
      id: e.id as string,
      title: e.title as string,
      startsAt: e.starts_at as string,
    }));
  } catch {
    return [];
  }
}
