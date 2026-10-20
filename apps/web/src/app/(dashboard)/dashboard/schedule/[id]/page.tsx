import { ChevronLeft, MapPin, Package, ShoppingCart, User2 } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { ScheduleStatusActions } from '@/components/schedule/schedule-status-actions';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatOrderNumber } from '@stockpilot/core';
import { createClient } from '@/lib/supabase/server';
import { requireOrgContext } from '@/lib/auth/session';
import { formatOrgDate, formatOrgTime } from '@/lib/timezone';
import { formatNumber } from '@/lib/utils';
import { BundlesService } from '@/server/services/bundles';
import { ServiceError } from '@/server/services/context';
import { ScheduleService } from '@/server/services/schedule';
import { WarehousesService } from '@/server/services/warehouses';

import { can } from '@stockpilot/core';

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

function formatRange(startsAt: string, endsAt: string | null, allDay: boolean) {
  const start = new Date(startsAt);
  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
  };
  if (allDay) {
    return `${formatOrgDate(start, dateOpts)} · All day`;
  }
  if (!endsAt) {
    return `${formatOrgDate(start, dateOpts)} · ${formatOrgTime(start, timeOpts)}`;
  }
  const end = new Date(endsAt);
  // Compare PT calendar days (NOT the JS Date getters, which read the
  // server's local tz) so "same-day" stays true when both timestamps
  // fall on the same Pacific calendar day even if UTC midnight splits
  // them.
  const sameDay = formatOrgDate(start) === formatOrgDate(end);
  if (sameDay) {
    return `${formatOrgDate(start, dateOpts)} · ${formatOrgTime(start, timeOpts)} – ${formatOrgTime(end, timeOpts)}`;
  }
  return `${formatOrgDate(start, dateOpts)} ${formatOrgTime(start, timeOpts)} → ${formatOrgDate(end, dateOpts)} ${formatOrgTime(end, timeOpts)}`;
}

export default async function ScheduleEventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Mirrors /dashboard/schedule: schedule:read (or manage) can VIEW — the
  // calendar's event chips link here, so a read-only grantee must not dead-end
  // on a 404. Status changes + editing stay schedule:manage (the write UI
  // below is hidden and /[id]/edit keeps its own manage gate).
  const ctx = await requireOrgContext();
  if (!can(ctx, 'schedule:read') && !can(ctx, 'schedule:manage')) notFound();
  const canManage = can(ctx, 'schedule:manage');

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
  let linkedBundle: { id: string; name: string; sku: string | null } | null = null;
  let bundleWarehouseName: string | null = null;
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
  if (event.bundleWarehouseId) {
    try {
      const whSvc = await WarehousesService.forCurrentUser();
      const all = await whSvc.listNames();
      bundleWarehouseName = all.find((w) => w.id === event.bundleWarehouseId)?.name ?? null;
    } catch {
      /* ignore */
    }
  }

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
        subline={formatRange(event.startsAt, event.endsAt, event.allDay)}
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
          <p className="text-muted-foreground text-[12px]">
            {event.bundleQuantity != null ? formatNumber(event.bundleQuantity) : '—'}{' '}
            {/* Pluralize on the absolute count — fractional kits read
                as plural to match how every other quantity copy in
                the app behaves (e.g. "0.5 kits", "2.5 kits"). */}
            kit
            {event.bundleQuantity != null && Math.abs(event.bundleQuantity) === 1
              ? ''
              : 's'}{' '}
            will be distributed from {bundleWarehouseName ?? 'a warehouse'}{' '}
            when this event is marked complete.
            {event.bundleDistributed
              ? ' This event already triggered a distribution — re-completing won\'t re-fire.'
              : ''}
          </p>
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
