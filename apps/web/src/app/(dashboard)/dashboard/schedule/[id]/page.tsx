import { ChevronLeft, MapPin, Package, User2 } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ScheduleStatusActions } from '@/components/schedule/schedule-status-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  // Schedule is manager+ only — viewers/staff who land here directly via URL
  // get a 404 rather than a permission error. Mirrors /dashboard/schedule.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'schedule:manage')) notFound();

  const svc = await ScheduleService.forCurrentUser();
  let event;
  try {
    event = await svc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
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
      const all = await whSvc.list();
      bundleWarehouseName = all.find((w) => w.id === event.bundleWarehouseId)?.name ?? null;
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/schedule"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          <ChevronLeft className="mr-1 h-4 w-4" /> Back to calendar
        </Link>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{event.title}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {formatRange(event.startsAt, event.endsAt, event.allDay)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="border-border text-muted-foreground inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px]">
            {STATUS_LABEL[event.status] ?? event.status}
          </span>
          <ScheduleStatusActions eventId={id} currentStatus={event.status} />
          <Button asChild variant="outline" size="sm">
            <Link href={`/dashboard/schedule/${id}/edit`}>Edit</Link>
          </Button>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <MapPin className="h-3.5 w-3.5" /> Location
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
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
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <User2 className="h-3.5 w-3.5" /> Requester
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
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
          </CardContent>
        </Card>
      </div>

      {event.bundleId && (
        <Card className="mt-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Package className="h-3.5 w-3.5" /> Linked bundle
              {event.bundleDistributed ? (
                <Badge variant="success">Distributed</Badge>
              ) : (
                <Badge variant="outline">Pending</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
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
          </CardContent>
        </Card>
      )}

      <Card className="mt-3">
        <CardHeader>
          <CardTitle className="text-sm">Details</CardTitle>
        </CardHeader>
        <CardContent>
          {event.details ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{event.details}</p>
          ) : (
            <p className="text-muted-foreground text-sm">No additional details.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
