import { notFound } from 'next/navigation';

import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { ScheduleEventForm } from '@/components/schedule/schedule-event-form';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { reportError } from '@/lib/error-reporter';
import { BundlesService } from '@/server/services/bundles';
import { ServiceError } from '@/server/services/context';
import { ScheduleService } from '@/server/services/schedule';
import { WarehousesService } from '@/server/services/warehouses';

import { can, resolveOrgTimezone } from '@stockpilot/core';

export const metadata = { title: 'Edit event · Schedule' };

export default async function EditScheduleEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Manager+ only. notFound() (not redirect) keeps the surface invisible
  // to lower-role users instead of bouncing them through /dashboard.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'schedule:manage')) notFound();

  // The form's date and time are a wall clock in the ORGANIZATION's zone, as
  // the calendar and the event's page draw them (small fixes slice 8 review):
  // Edit opens on the time the event's page prints. Read as the calendar
  // reads it; a failed read is the default zone, reported.
  const timeZoneRead = getOrgRowForRequest(ctx.organizationId)
    .then((org) => resolveOrgTimezone(org?.timezone))
    .catch((e: unknown) => {
      void reportError(e, { tag: 'schedule.event_form.org_timezone_failed', level: 'warning' });
      return resolveOrgTimezone(null);
    });

  const [scheduleSvc, warehousesSvc, bundlesSvc] = await Promise.all([
    ScheduleService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    BundlesService.forCurrentUser(),
  ]);
  let event;
  try {
    event = await scheduleSvc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }
  const [warehouses, bundles] = await Promise.all([warehousesSvc.listNames(), bundlesSvc.list()]);

  // Pull a window of nearby events so the form can warn about overlaps.
  // Excludes the event being edited so saving an unchanged time isn't
  // flagged as conflicting with itself.
  const anchor = new Date(event.startsAt);
  const conflictFrom = new Date(anchor);
  conflictFrom.setDate(anchor.getDate() - 30);
  const conflictTo = new Date(anchor);
  conflictTo.setDate(anchor.getDate() + 30);
  const nearby = await scheduleSvc.listInRange(conflictFrom, conflictTo);
  const conflictCandidates = nearby
    .filter((e) => e.id !== event.id && e.status !== 'cancelled' && e.status !== 'completed')
    .map((e) => ({
      id: e.id,
      title: e.title,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      warehouseId: e.warehouseId,
      requesterName: e.requesterName,
    }));

  const timeZone = await timeZoneRead;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        back={
          <PageHeaderBackLink href={`/dashboard/schedule/${id}`}>
            ← Back to event
          </PageHeaderBackLink>
        }
        title="Edit event"
      />
      <DetailSection title={event.title}>
        <ScheduleEventForm
          warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
          bundles={bundles.map((b) => ({ id: b.id, name: b.name, sku: b.sku }))}
          conflictCandidates={conflictCandidates}
          timeZone={timeZone}
          defaults={{
            id: event.id,
            title: event.title,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            allDay: event.allDay,
            locationText: event.locationText,
            warehouseId: event.warehouseId,
            requesterName: event.requesterName,
            details: event.details,
            status: event.status,
            bundleId: event.bundleId,
            bundleQuantity: event.bundleQuantity,
            bundleWarehouseId: event.bundleWarehouseId,
            bundleAlreadyDistributed: event.bundleDistributed,
          }}
        />
      </DetailSection>
    </div>
  );
}
