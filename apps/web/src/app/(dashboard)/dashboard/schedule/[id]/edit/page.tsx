import { notFound } from 'next/navigation';

import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { ScheduleEventForm } from '@/components/schedule/schedule-event-form';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { reportError } from '@/lib/error-reporter';
import { notFoundUnlessUuid } from '@/server/lib/path-id';
import { BundlesService } from '@/server/services/bundles';
import { ServiceError } from '@/server/services/context';
import { ScheduleService } from '@/server/services/schedule';
import { WarehousesService } from '@/server/services/warehouses';

import { can, resolveOrgTimezone } from '@stockpilot/core';

// The Liquid Glass operations composition (stage 4: pages/ops.css, the
// shared frame, and the board's own file where there is one): every rule is
// scoped to this page's [data-glass-page] root and to glass, so Classic never
// matches it (styles/liquid-glass/glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/ops.css';

export const metadata = { title: 'Edit event · Schedule' };

export default async function EditScheduleEventPage({
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
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7"
      data-glass-page="ops"
      data-glass-view="schedule-edit"
      data-glass-width="form"
    >
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
