import { Boxes, Mail, Phone, Plus, Send, User as UserIcon, Warehouse as WarehouseIcon } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EmptyState } from '@/components/dashboard/empty-state';
import { StatCard } from '@/components/dashboard/stat-card';
import { ShipmentStatusBadge } from '@/components/shipments/shipment-status-badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
import { addressJsonToLines } from '@/lib/pdf/shipment';
import { createClient } from '@/lib/supabase/server';
import { formatNumber, formatRelative } from '@/lib/utils';
import { ChartersService } from '@/server/services/charters';
import { ServiceError } from '@/server/services/context';
import { ShipmentsService } from '@/server/services/shipments';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';
import { WarehousesService } from '@/server/services/warehouses';

const STATUS_VARIANT: Record<
  'active' | 'inactive' | 'archived',
  'success' | 'secondary' | 'outline'
> = {
  active: 'success',
  inactive: 'secondary',
  archived: 'outline',
};

function initials(input: string | null | undefined): string {
  if (!input) return '?';
  const parts = input.trim().split(/\s+/).slice(0, 2);
  if (parts.length === 0) return '?';
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export default async function WarehouseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const warehousesSvc = await WarehousesService.forCurrentUser();
  let warehouse;
  try {
    warehouse = await warehousesSvc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  // Everything else loads in parallel — Supabase client is request-scoped
  // (cached via React.cache in withContext), so each service shares it.
  const [chartersSvc, whChartersSvc, shipmentsSvc, supabase] = await Promise.all([
    ChartersService.forCurrentUser(),
    WarehouseChartersService.forCurrentUser(),
    ShipmentsService.forCurrentUser(),
    createClient(),
  ]);

  const [allCharters, pairs, recentShipments, itemCountResult, pendingOrdersResult, recentShipments30dResult] =
    await Promise.all([
      chartersSvc.list(),
      whChartersSvc.listPairs(),
      shipmentsSvc.list({ sourceWarehouseId: id, limit: 10 }),
      // Items currently at this warehouse (active, non-deleted).
      supabase
        .from('inventory_items')
        .select('id', { count: 'exact', head: true })
        .eq('warehouse_id', id)
        .eq('status', 'active')
        .is('deleted_at', null),
      // Pending order requests targeting this warehouse.
      supabase
        .from('order_requests')
        .select('id', { count: 'exact', head: true })
        .eq('warehouse_id', id)
        .eq('status', 'pending_approval'),
      // Shipments from this warehouse in the last 30 days. Counted separately
      // from `recentShipments` (which is capped at 10) so the stat reflects
      // actual 30-day volume even when more than 10 have shipped.
      supabase
        .from('shipments')
        .select('id', { count: 'exact', head: true })
        .eq('source_warehouse_id', id)
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
    ]);

  const charterIdsForWarehouse = new Set(
    pairs.filter((p) => p.warehouse_id === id).map((p) => p.charter_id),
  );
  const chartersServiced = allCharters
    .filter((c) => charterIdsForWarehouse.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const itemCount = itemCountResult.count ?? 0;
  const pendingOrderCount = pendingOrdersResult.count ?? 0;
  const recentShipments30d = recentShipments30dResult.count ?? 0;

  const addressLines = addressJsonToLines(
    (warehouse.address as Record<string, unknown> | null) ?? null,
  );

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/admin/warehouses"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to warehouses
        </Link>
      </div>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{warehouse.name}</h1>
            <span className="text-muted-foreground bg-muted/40 border-border rounded-md border px-2 py-0.5 font-mono text-xs">
              {warehouse.code}
            </span>
            <Badge variant={STATUS_VARIANT[warehouse.status]} className="capitalize">
              {warehouse.status}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1.5 text-sm">
            Updated {formatRelative(warehouse.updated_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/dashboard/admin/warehouses">Edit</Link>
          </Button>
          <Button asChild>
            <Link href={`/dashboard/shipments/new?source=${warehouse.id}`}>
              <Plus className="h-4 w-4" /> New shipment from here
            </Link>
          </Button>
        </div>
      </div>

      {/* Stats row */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Items on hand"
          value={formatNumber(itemCount)}
          icon={Boxes}
          foot="Active items at this warehouse"
        />
        <StatCard
          label="Charters serviced"
          value={formatNumber(chartersServiced.length)}
          icon={WarehouseIcon}
          foot={chartersServiced.length === 0 ? 'None assigned yet' : undefined}
        />
        <StatCard
          label="Shipments (30d)"
          value={formatNumber(recentShipments30d)}
          icon={Send}
          foot="Outbound from here"
        />
        <StatCard
          label="Pending order requests"
          value={formatNumber(pendingOrderCount)}
          icon={Send}
          foot="Awaiting approval"
        />
      </div>

      {/* Info card */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <section className="bg-card rounded-xl border p-5">
          <h2 className="text-muted-foreground mb-3 text-[10.5px] uppercase tracking-[0.08em]">
            Address &amp; contact
          </h2>
          {addressLines.length === 0 &&
          !warehouse.contact_name &&
          !warehouse.contact_email &&
          !warehouse.contact_phone ? (
            <p className="text-muted-foreground text-sm">
              No address or contact info on file.
            </p>
          ) : (
            <div className="space-y-3 text-sm">
              {addressLines.length > 0 && (
                <div className="space-y-0.5">
                  {addressLines.map((line, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <p key={`addr-${i}`}>{line}</p>
                  ))}
                </div>
              )}
              {(warehouse.contact_name ||
                warehouse.contact_email ||
                warehouse.contact_phone) && (
                <div className="border-border space-y-1 border-t pt-3 text-xs">
                  {warehouse.contact_name && (
                    <p className="flex items-center gap-1.5">
                      <UserIcon className="text-muted-foreground h-3 w-3" />
                      {warehouse.contact_name}
                    </p>
                  )}
                  {warehouse.contact_email && (
                    <p className="flex items-center gap-1.5">
                      <Mail className="text-muted-foreground h-3 w-3" />
                      <a
                        href={`mailto:${warehouse.contact_email}`}
                        className="hover:underline"
                      >
                        {warehouse.contact_email}
                      </a>
                    </p>
                  )}
                  {warehouse.contact_phone && (
                    <p className="flex items-center gap-1.5">
                      <Phone className="text-muted-foreground h-3 w-3" />
                      <a
                        href={`tel:${warehouse.contact_phone}`}
                        className="hover:underline"
                      >
                        {warehouse.contact_phone}
                      </a>
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="bg-card rounded-xl border p-5">
          <h2 className="text-muted-foreground mb-3 text-[10.5px] uppercase tracking-[0.08em]">
            Manager
          </h2>
          {warehouse.manager ? (
            <div className="flex items-start gap-3">
              <Avatar>
                {warehouse.manager.avatar_url && (
                  <AvatarImage
                    src={warehouse.manager.avatar_url}
                    alt={warehouse.manager.full_name ?? warehouse.manager.email ?? 'Manager'}
                  />
                )}
                <AvatarFallback>
                  {initials(warehouse.manager.full_name ?? warehouse.manager.email)}
                </AvatarFallback>
              </Avatar>
              <div className="space-y-0.5 text-sm">
                <p className="font-medium">
                  {warehouse.manager.full_name ?? warehouse.manager.email ?? 'Unnamed'}
                </p>
                {warehouse.manager.email && (
                  <p className="text-muted-foreground text-xs">
                    <a
                      href={`mailto:${warehouse.manager.email}`}
                      className="hover:underline"
                    >
                      {warehouse.manager.email}
                    </a>
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No manager assigned.</p>
          )}
        </section>
      </div>

      {warehouse.notes && (
        <section className="bg-card mt-4 rounded-xl border p-5">
          <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">
            Notes
          </h2>
          <p className="whitespace-pre-wrap text-sm">{warehouse.notes}</p>
        </section>
      )}

      {/* Charters serviced */}
      <section className="bg-card mt-4 rounded-xl border">
        <div className="border-border flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">Charters serviced</h2>
          <span className="text-muted-foreground text-xs tabular-nums">
            {chartersServiced.length}
          </span>
        </div>
        {chartersServiced.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={WarehouseIcon}
              title="No charters yet"
              description="Assign charters to this warehouse from Admin → Warehouses."
            />
          </div>
        ) : (
          <ul className="divide-border divide-y">
            {chartersServiced.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between px-4 py-2.5 text-sm"
              >
                <span className="font-medium">{c.name}</span>
                {c.code && (
                  <span className="text-muted-foreground font-mono text-[11px]">
                    {c.code}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent shipments */}
      <section className="bg-card mt-4 rounded-xl border">
        <div className="border-border flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">Recent shipments</h2>
          <span className="text-muted-foreground text-xs tabular-nums">
            {recentShipments.length === 0 ? '0' : `last ${recentShipments.length}`}
          </span>
        </div>
        {recentShipments.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={Send}
              title="No shipments yet"
              description="When you ship from this warehouse, the most recent ten show up here."
            />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>WO #</TableHead>
                  <TableHead>Ship date</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentShipments.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <Link
                        href={`/dashboard/shipments/${s.id}`}
                        className="font-mono text-sm font-medium hover:underline"
                      >
                        {s.workOrderNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm tabular-nums">
                      {s.shipDate}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {s.destinationCharterName ? (
                        <span className="flex items-center gap-1.5">
                          <span>{s.destinationCharterName}</span>
                          {s.destinationCharterCode ? (
                            <span className="text-muted-foreground/70 font-mono text-[11px]">
                              {s.destinationCharterCode}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>
                      <ShipmentStatusBadge status={s.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="border-border border-t px-4 py-3 text-right text-xs">
              <Link
                href={`/dashboard/shipments?source=${warehouse.id}`}
                className="text-muted-foreground hover:text-foreground"
              >
                See all shipments →
              </Link>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
