import { notFound } from 'next/navigation';

import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { ScheduleEventForm } from '@/components/schedule/schedule-event-form';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { reportError } from '@/lib/error-reporter';
import { BundlesService } from '@/server/services/bundles';
import { ScheduleService } from '@/server/services/schedule';
import { WarehousesService } from '@/server/services/warehouses';

import { can, resolveOrgTimezone } from '@stockpilot/core';

export const metadata = { title: 'New event · Schedule' };

export default async function NewScheduleEventPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  // Manager+ only. Mirrors the gate on /dashboard/schedule and the
  // detail/edit pages.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'schedule:manage')) notFound();

  const params = await searchParams;
  // Pre-fill the date when the user clicked a day cell on the
  // calendar (?date=YYYY-MM-DD). Validation happens in the schema —
  // bad input falls through to "today" inside the form.
  const initialDate =
    params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : null;

  // The form's date and time are a wall clock in the ORGANIZATION's zone, as
  // the calendar and the event's page draw them (small fixes slice 8 review):
  // a calendar date's "+ Add" lands on that date for every viewer. Read as
  // the calendar reads it; a failed read is the default zone, reported.
  const timeZoneRead = getOrgRowForRequest(ctx.organizationId)
    .then((org) => resolveOrgTimezone(org?.timezone))
    .catch((e: unknown) => {
      void reportError(e, { tag: 'schedule.event_form.org_timezone_failed', level: 'warning' });
      return resolveOrgTimezone(null);
    });

  const [warehousesSvc, bundlesSvc, scheduleSvc] = await Promise.all([
    WarehousesService.forCurrentUser(),
    BundlesService.forCurrentUser(),
    ScheduleService.forCurrentUser(),
  ]);

  // Load a ~60-day window around the prefilled date (or today) so the
  // client form can warn about overlapping events in the same warehouse.
  // Pure UX hint — the service-side check is intentionally not enforcing
  // a hard constraint (sometimes you legitimately stack work).
  const anchor = initialDate ? new Date(`${initialDate}T00:00`) : new Date();
  const conflictFrom = new Date(anchor);
  conflictFrom.setDate(anchor.getDate() - 30);
  const conflictTo = new Date(anchor);
  conflictTo.setDate(anchor.getDate() + 30);

  const [warehouses, bundles, nearbyEvents] = await Promise.all([
    warehousesSvc.listNames(),
    bundlesSvc.list(),
    scheduleSvc.listInRange(conflictFrom, conflictTo),
  ]);

  const conflictCandidates = nearbyEvents
    .filter((e) => e.status !== 'cancelled' && e.status !== 'completed')
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
        back={<PageHeaderBackLink href="/dashboard/schedule">← Back to calendar</PageHeaderBackLink>}
        title="New event"
      />
      <DetailSection title="Event details">
        <ScheduleEventForm
          warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
          bundles={bundles.map((b) => ({ id: b.id, name: b.name, sku: b.sku }))}
          initialDate={initialDate}
          conflictCandidates={conflictCandidates}
          timeZone={timeZone}
        />
      </DetailSection>
    </div>
  );
}
