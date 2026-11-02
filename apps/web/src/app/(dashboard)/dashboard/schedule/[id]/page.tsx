import { ChevronLeft, MapPin, Package, ShoppingCart, User2 } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { ScheduleStatusActions } from '@/components/schedule/schedule-status-actions';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatOrderNumber } from '@stockpilot/core';
import { createClient } from '@/lib/supabase/server';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { reportError } from '@/lib/error-reporter';
import { formatEventRange } from '@/lib/schedule/event-range';
import { formatNumber } from '@/lib/utils';
import { notFoundUnlessUuid } from '@/server/lib/path-id';
import { BundlesService } from '@/server/services/bundles';
import { ServiceError } from '@/server/services/context';
import { ScheduleService } from '@/server/services/schedule';
import { WarehousesService } from '@/server/services/warehouses';

import { can, resolveOrgTimezone } from '@stockpilot/core';

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** The status pill's tone (DESIGN-SPEC 6.10); the words stay STATUS_LABEL's. */
const STATUS_TONE: Record<string, BadgeProps['variant']> = {
  scheduled: 'secondary',
  in_progress: 'warning',
  completed: 'success',
  cancelled: 'destructive',
};

/**
 * What an event's distribution handed out, from its bundle_distributions row
 * (B103): "1 kit (Starter kit) was distributed from East Warehouse." A kit
 * name that could not be read is left out; a warehouse is "a warehouse", as
 * in the sentence before completion. Plural on the absolute count, as there.
 */
function handedOutLine(
  quantity: number,
  kitName: string | null,
  warehouseName: string | null,
): string {
  const one = Math.abs(quantity) === 1;
  return (
    `${formatNumber(quantity)} ${one ? 'kit' : 'kits'}` +
    (kitName ? ` (${kitName})` : '') +
    ` ${one ? 'was' : 'were'} distributed from ${warehouseName ?? 'a warehouse'}.`
  );
}

export default async function ScheduleEventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // A malformed id (a mistyped or cut-off link) is Page not found before
  // anything is read with it (B63).
  notFoundUnlessUuid(id);
  // Schedule off (a stale link) is the module-off panel, before anything is read:
  // the read below would refuse with module_disabled and reach the error page (B66).
  const moduleAccess = await checkModuleAccess('schedule');
  if (!moduleAccess.enabled) {
    return <ModuleUnavailable moduleId="schedule" access={moduleAccess} />;
  }
  // Mirrors /dashboard/schedule: schedule:read (or manage) can VIEW — the
  // calendar's event chips link here, so a read-only grantee must not dead-end
  // on a 404. Status changes + editing stay schedule:manage (the write UI
  // below is hidden and /[id]/edit keeps its own manage gate).
  const ctx = await requireOrgContext();
  if (!can(ctx, 'schedule:read') && !can(ctx, 'schedule:manage')) notFound();
  const canManage = can(ctx, 'schedule:manage');
  // The event's date and times in the organization's zone, as the calendar
  // draws them (small fixes slice 8); they printed in Pacific whatever the
  // organization's. An unreadable organization row is the documented default
  // zone, reported, never an error page (getOrgRowForRequest throws on a
  // read error).
  const timeZoneRead = getOrgRowForRequest(ctx.organizationId)
    .then((org) => resolveOrgTimezone(org?.timezone))
    .catch((e: unknown) => {
      void reportError(e, { tag: 'schedule.event.org_timezone_failed', level: 'warning' });
      return resolveOrgTimezone(null);
    });

  const svc = await ScheduleService.forCurrentUser();
  let event;
  try {
    event = await svc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  // Linked order chip (auto-created events, mig 0255): resolve the SO number
  // + live status. Cheap single read; RLS-scoped; null-safe on stale links.
  let linkedOrder: { so: string; status: string } | null = null;
  if (event.orderRequestId) {
    const supa = await createClient();
    const { data: ord } = await supa
      .from('order_requests')
      .select('order_number, status')
      .eq('id', event.orderRequestId)
      .maybeSingle();
    if (ord) {
      linkedOrder = {
        so:
          formatOrderNumber((ord.order_number as number | null) ?? null) ??
          event.orderRequestId.slice(0, 8).toUpperCase(),
        status: (ord.status as string) ?? 'unknown',
      };
    }
  }

  // If a bundle is linked, surface its name + the destination warehouse
  // name in a side card. Two extra cheap reads; bail silently on either
  // if RLS or a stale id slips through.
  //
  // Once the event has a distribution, the card says what it handed out
  // (B103), from its bundle_distributions row: a hand-out from a bundle page
  // that named this event may be of another kit, quantity or warehouse than
  // the event's own bundle fields.
  const distribution = event.bundleId ? event.bundleDistribution : null;
  let linkedBundle: { id: string; name: string; sku: string | null } | null = null;
  let distributedBundleName: string | null = null;
  let bundleWarehouseName: string | null = null;
  let distributedWarehouseName: string | null = null;
  if (event.bundleId) {
    try {
      const bundlesSvc = await BundlesService.forCurrentUser();
      const detail = await bundlesSvc.get(event.bundleId);
      linkedBundle = {
        id: detail.bundle.id,
        name: detail.bundle.name,
        sku: detail.bundle.sku,
      };
    } catch {
      /* ignore */
    }
  }
  if (distribution) {
    if (distribution.bundleId === event.bundleId) {
      distributedBundleName = linkedBundle?.name ?? null;
    } else {
      try {
        const bundlesSvc = await BundlesService.forCurrentUser();
        distributedBundleName = (await bundlesSvc.get(distribution.bundleId)).bundle.name;
      } catch {
        /* ignore */
      }
    }
  }
  if (event.bundleWarehouseId || distribution) {
    try {
      const whSvc = await WarehousesService.forCurrentUser();
      const all = await whSvc.listNames();
      const nameOf = (warehouseId: string | null | undefined) =>
        warehouseId ? (all.find((w) => w.id === warehouseId)?.name ?? null) : null;
      bundleWarehouseName = nameOf(event.bundleWarehouseId);
      distributedWarehouseName = nameOf(distribution?.warehouseId);
    } catch {
      /* ignore */
    }
  }

  const timeZone = await timeZoneRead;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        back={
          <PageHeaderBackLink href="/dashboard/schedule">
            <ChevronLeft className="h-4 w-4" /> Back to calendar
          </PageHeaderBackLink>
        }
        title={event.title}
        titleAside={
          <Badge variant={STATUS_TONE[event.status] ?? 'outline'}>
            {STATUS_LABEL[event.status] ?? event.status}
          </Badge>
        }
        subline={formatEventRange(event.startsAt, event.endsAt, event.allDay, timeZone)}
        actions={
          canManage ? (
            // Secondary first, the ink commit button last (DESIGN-SPEC 6.1,
            // PageHeader's order): Edit, Cancel, Start (or Mark complete).
            <>
              <Button asChild variant="outline">
                <Link href={`/dashboard/schedule/${id}/edit`}>Edit</Link>
              </Button>
              <ScheduleStatusActions eventId={id} currentStatus={event.status} />
            </>
          ) : undefined
        }
      />

      {linkedOrder && (
        <div className="border-border bg-card flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-[18px] py-3 text-[13.5px]">
          <ShoppingCart aria-hidden className="text-muted-foreground h-3.5 w-3.5" />
          <span className="text-muted-foreground">Linked order</span>
          <Link
            href={`/dashboard/orders/${event.orderRequestId}`}
            className="font-mono font-medium tabular-nums hover:underline"
          >
            {linkedOrder.so}
          </Link>
          <Badge variant="outline" className="ml-1 capitalize">
            {linkedOrder.status.replace(/_/g, ' ')}
          </Badge>
          <span className="text-muted-foreground text-[12px] sm:ml-auto">
            completes/cancels this event automatically
          </span>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <DetailSection
          title={
            <span className="inline-flex items-center gap-2">
              <MapPin aria-hidden className="text-muted-foreground h-3.5 w-3.5" /> Location
            </span>
          }
          className="text-[13.5px]"
        >
          {event.locationText ? (
            <p>{event.locationText}</p>
          ) : (
            <p className="text-muted-foreground">No location set.</p>
          )}
          {event.warehouseName ? (
            <p className="text-muted-foreground mt-1 text-[12px]">
              Warehouse: {event.warehouseName}
            </p>
          ) : null}
        </DetailSection>
        <DetailSection
          title={
            <span className="inline-flex items-center gap-2">
              <User2 aria-hidden className="text-muted-foreground h-3.5 w-3.5" /> Requester
            </span>
          }
          className="text-[13.5px]"
        >
          {event.requesterName ? (
            <p>{event.requesterName}</p>
          ) : (
            <p className="text-muted-foreground">No requester recorded.</p>
          )}
          {event.createdByName ? (
            <p className="text-muted-foreground mt-1 text-[12px]">
              Created by {event.createdByName}
            </p>
          ) : null}
        </DetailSection>
      </div>

      {event.bundleId && (
        <DetailSection
          title={
            <span className="inline-flex items-center gap-2">
              <Package aria-hidden className="text-muted-foreground h-3.5 w-3.5" /> Linked bundle
            </span>
          }
          aside={
            event.bundleDistributed ? (
              <Badge variant="success">Distributed</Badge>
            ) : (
              <Badge variant="outline">Pending</Badge>
            )
          }
          className="text-[13.5px]"
          bodyClassName="space-y-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/dashboard/bundles/${event.bundleId}`}
              className="font-medium hover:underline"
            >
              {linkedBundle?.name ?? 'Unknown bundle'}
            </Link>
            {linkedBundle?.sku ? (
              <span className="text-muted-foreground font-mono text-[11px]">
                {linkedBundle.sku}
              </span>
            ) : null}
          </div>
          {distribution ? (
            // What the event handed out, and nothing about the future (B103):
            // it kept saying the kit "will be distributed ... when this event
            // is marked complete" after it had been.
            <p className="text-muted-foreground text-[12px]">
              {handedOutLine(
                distribution.quantity,
                distributedBundleName,
                distributedWarehouseName,
              )}
            </p>
          ) : event.status === 'completed' ? null : (
            // Before completion: what completing the event will hand out. A
            // completed event with no distribution (its hand-out was refused,
            // its kit was added after it was completed, or its order closed
            // it) hands nothing out by itself, so it says neither.
            <p className="text-muted-foreground text-[12px]">
              {event.bundleQuantity != null ? formatNumber(event.bundleQuantity) : '—'}{' '}
              {/* Pluralize on the absolute count — fractional kits read
                  as plural to match how every other quantity copy in
                  the app behaves (e.g. "0.5 kits", "2.5 kits"). */}
              kit
              {event.bundleQuantity != null && Math.abs(event.bundleQuantity) === 1 ? '' : 's'} will
              be distributed from {bundleWarehouseName ?? 'a warehouse'} when this event is marked
              complete.
            </p>
          )}
        </DetailSection>
      )}

      <DetailSection title="Details">
        {event.details ? (
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{event.details}</p>
        ) : (
          <p className="text-muted-foreground text-[13.5px]">No additional details.</p>
        )}
      </DetailSection>
    </div>
  );
}
