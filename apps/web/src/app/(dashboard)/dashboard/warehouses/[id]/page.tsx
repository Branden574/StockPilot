import { Mail, Phone, Plus, User as UserIcon, Warehouse as WarehouseIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { plainAddressMailtoUrl } from '@stockpilot/core';

import { newOrderFromWarehouseHref, warehouseTelUrl } from '@/components/locations/warehouse-links';
import {
  DetailSection,
  DetailSectionMeta,
} from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { StatePanel } from '@/components/patterns/state-panel';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { formatNumber, formatRelative } from '@/lib/utils';
import { ChartersService } from '@/server/services/charters';
import { ServiceError } from '@/server/services/context';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';
import { WarehousesService } from '@/server/services/warehouses';

// The tab names the page ("Warehouse · StockPilot" through the (dashboard)
// layout's title template); before, it read the group's "Dashboard"
// (CONFLICTS D16). A static title, like Location's: naming the warehouse
// would take a second read in generateMetadata.
export const metadata: Metadata = { title: 'Warehouse' };

/** The page area (DESIGN-SPEC 4 and 5.3), the same box the other pages use. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

const CONTACT_LINK =
  'text-foreground underline-offset-4 hover:underline [overflow-wrap:anywhere]';

const STATUS_VARIANT: Record<
  'active' | 'inactive' | 'archived',
  'success' | 'secondary' | 'outline'
> = {
  active: 'success',
  inactive: 'secondary',
  archived: 'outline',
};

/** Flattens a Postgres jsonb address into the line list rendered in
 *  the FROM block. Missing pieces drop out so we never print "null". */
function formatAddressLines(
  address: Record<string, unknown> | null,
): string[] {
  if (!address) return [];
  const line1 = (address.line1 as string | null) ?? '';
  const line2 = (address.line2 as string | null) ?? '';
  const city = (address.city as string | null) ?? '';
  const region = (address.region as string | null) ?? '';
  const postal = (address.postalCode as string | null) ?? '';
  const country = (address.country as string | null) ?? '';
  const cityLine = [city, region].filter(Boolean).join(', ');
  const cityZip = [cityLine, postal].filter(Boolean).join(' ').trim();
  return [line1, line2, cityZip, country].filter((s) => s.trim().length > 0);
}

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
  const [chartersSvc, whChartersSvc, supabase] = await Promise.all([
    ChartersService.forCurrentUser(),
    WarehouseChartersService.forCurrentUser(),
    createClient(),
  ]);

  const [allCharters, pairs, itemCountResult, pendingOrdersResult, completedOrders30dResult] =
    await Promise.all([
      chartersSvc.list(),
      whChartersSvc.listPairs(),
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
      // Completed order requests from this warehouse in the last 30 days.
      supabase
        .from('order_requests')
        .select('id', { count: 'exact', head: true })
        .eq('warehouse_id', id)
        .eq('status', 'completed')
        .gte('updated_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
    ]);

  const charterIdsForWarehouse = new Set(
    pairs.filter((p) => p.warehouse_id === id).map((p) => p.charter_id),
  );
  const chartersServiced = allCharters
    .filter((c) => charterIdsForWarehouse.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const itemCount = itemCountResult.count ?? 0;
  const pendingOrderCount = pendingOrdersResult.count ?? 0;
  const completedOrders30d = completedOrders30dResult.count ?? 0;

  const addressLines = formatAddressLines(
    (warehouse.address as Record<string, unknown> | null) ?? null,
  );

  const contactTel = warehouseTelUrl(warehouse.contact_phone);
  const contactMailto = plainAddressMailtoUrl(warehouse.contact_email);
  const managerMailto = plainAddressMailtoUrl(warehouse.manager?.email);

  return (
    <div className={PAGE}>
      {/* The record's header (DESIGN-SPEC 6.1): the name is the page's h1 with
          the code chip and the status label beside it, when it was last
          updated under it, and Edit and New order from here on the right,
          wrapping under the title on a narrow screen. */}
      <PageHeader
        back={
          <PageHeaderBackLink href="/dashboard/admin/warehouses">
            ← Back to warehouses
          </PageHeaderBackLink>
        }
        title={warehouse.name}
        titleAside={
          <span className="flex flex-wrap items-center gap-2">
            <span className="border-line-strong bg-sunk text-ink-2 rounded-md border px-2 py-0.5 font-mono text-[12px] leading-[18px]">
              {warehouse.code}
            </span>
            <Badge variant={STATUS_VARIANT[warehouse.status]} className="capitalize">
              {warehouse.status}
            </Badge>
          </span>
        }
        subline={<>Updated {formatRelative(warehouse.updated_at)}</>}
        actions={
          <Button asChild variant="outline">
            <Link href="/dashboard/admin/warehouses">Edit</Link>
          </Button>
        }
        primaryAction={
          // The storefront reads ?warehouseId= (orders/new/page.tsx); the
          // old ?warehouse= was ignored, so the warehouse was never preselected
          // (CONFLICTS D2).
          <Button asChild variant="gradient">
            <Link href={newOrderFromWarehouseHref(warehouse.id)}>
              <Plus className="h-4 w-4" /> New order from here
            </Link>
          </Button>
        }
      />

      {/* The record's stat strip (DESIGN-SPEC 6.8, the item page's KPI strip
          as the matrix names it): the same four figures and foot lines the
          page always had. "Items on hand" counts active records at this
          warehouse, not physical units. */}
      <StatStrip variant="detail">
        <StatStripItem
          size="detail"
          label="Items on hand"
          value={formatNumber(itemCount)}
          sub="Active items at this warehouse"
        />
        <StatStripItem
          size="detail"
          label="Charters serviced"
          value={formatNumber(chartersServiced.length)}
          sub={chartersServiced.length === 0 ? 'None assigned yet' : undefined}
        />
        <StatStripItem
          size="detail"
          label="Completed orders (30d)"
          value={formatNumber(completedOrders30d)}
          sub="Fulfilled out of here"
        />
        <StatStripItem
          size="detail"
          label="Pending order requests"
          value={formatNumber(pendingOrderCount)}
          sub="Awaiting approval"
        />
      </StatStrip>

      {/* Address & contact beside Manager once the content area holds two
          420 px cards (measured on the content, not the window). */}
      <div className="@container min-w-0">
        <div className="@min-[856px]:grid-cols-2 grid items-start gap-4">
          {/* JSX text, as before: the What's New claims test reads the
              heading from this file in this spelling. */}
          <DetailSection title={<>Address &amp; contact</>}>
            {addressLines.length === 0 &&
            !warehouse.contact_name &&
            !warehouse.contact_email &&
            !warehouse.contact_phone ? (
              <p className="text-muted-foreground text-[13.5px]">
                No address or contact info on file.
              </p>
            ) : (
              <div className="space-y-3 text-[13.5px] leading-[20.25px]">
                {addressLines.length > 0 && (
                  <div className="space-y-0.5">
                    {addressLines.map((line, i) => (
                      <p key={`addr-${i}`}>{line}</p>
                    ))}
                  </div>
                )}
                {(warehouse.contact_name ||
                  warehouse.contact_email ||
                  warehouse.contact_phone) && (
                  <div className="border-border text-ink-2 space-y-1.5 border-t pt-3 text-[12.5px]">
                    {warehouse.contact_name && (
                      <p className="flex items-center gap-1.5">
                        <UserIcon aria-hidden className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                        {warehouse.contact_name}
                      </p>
                    )}
                    {warehouse.contact_email && (
                      <p className="flex min-w-0 items-center gap-1.5">
                        <Mail aria-hidden className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                        {/* A link only for one plain address; the stored words
                            either way (warehouse-links). */}
                        {contactMailto ? (
                          <a href={contactMailto} className={CONTACT_LINK}>
                            {warehouse.contact_email}
                          </a>
                        ) : (
                          <span className="[overflow-wrap:anywhere]">{warehouse.contact_email}</span>
                        )}
                      </p>
                    )}
                    {warehouse.contact_phone && (
                      <p className="flex min-w-0 items-center gap-1.5">
                        <Phone aria-hidden className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                        {/* A link only for one plain phone number: letters, an
                            extension, a second number or a service code never
                            reach the dialler. */}
                        {contactTel ? (
                          <a href={contactTel} className={CONTACT_LINK}>
                            {warehouse.contact_phone}
                          </a>
                        ) : (
                          <span className="[overflow-wrap:anywhere]">{warehouse.contact_phone}</span>
                        )}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </DetailSection>

          <DetailSection title="Manager">
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
                <div className="min-w-0 space-y-0.5 text-[13.5px]">
                  <p className="font-medium">
                    {warehouse.manager.full_name ?? warehouse.manager.email ?? 'Unnamed'}
                  </p>
                  {warehouse.manager.email && (
                    <p className="text-muted-foreground text-[12.5px]">
                      {managerMailto ? (
                        <a href={managerMailto} className={CONTACT_LINK}>
                          {warehouse.manager.email}
                        </a>
                      ) : (
                        <span className="[overflow-wrap:anywhere]">{warehouse.manager.email}</span>
                      )}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-[13.5px]">No manager assigned.</p>
            )}
          </DetailSection>
        </div>
      </div>

      {warehouse.notes && (
        <DetailSection title="Notes">
          <p className="whitespace-pre-wrap text-[13.5px] leading-[20.25px]">{warehouse.notes}</p>
        </DetailSection>
      )}

      <DetailSection
        title="Charters serviced"
        aside={<DetailSectionMeta className="tabular-nums">{chartersServiced.length}</DetailSectionMeta>}
        flush
      >
        {chartersServiced.length === 0 ? (
          <StatePanel
            kind="empty"
            surface="plain"
            size="sm"
            headingLevel={3}
            icon={WarehouseIcon}
            title="No charters assigned"
            description={<p>Link charters to this warehouse so the team knows who it serves.</p>}
            action={
              <Button asChild variant="gradient" size="sm">
                <Link href="/dashboard/admin/warehouses">Manage warehouses</Link>
              </Button>
            }
          />
        ) : (
          <ul className="divide-border divide-y">
            {chartersServiced.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-3 px-[18px] py-[11px] text-[13.5px]"
              >
                <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{c.name}</span>
                {c.code && (
                  <span className="text-muted-foreground shrink-0 font-mono text-[12px]">
                    {c.code}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </div>
  );
}
