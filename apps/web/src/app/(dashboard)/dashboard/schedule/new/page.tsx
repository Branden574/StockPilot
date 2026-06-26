import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ScheduleEventForm } from '@/components/schedule/schedule-event-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgContext } from '@/lib/auth/session';
import { BundlesService } from '@/server/services/bundles';
import { ScheduleService } from '@/server/services/schedule';
import { WarehousesService } from '@/server/services/warehouses';

import { can } from '@stockpilot/core';

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
    warehousesSvc.list(),
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

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/schedule"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to calendar
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          New event
        </h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Event details</CardTitle>
        </CardHeader>
        <CardContent>
          <ScheduleEventForm
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
            bundles={bundles.map((b) => ({ id: b.id, name: b.name, sku: b.sku }))}
            initialDate={initialDate}
            conflictCandidates={conflictCandidates}
          />
        </CardContent>
      </Card>
    </div>
  );
}
