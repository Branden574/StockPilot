import Link from 'next/link';

import { ScheduleEventForm } from '@/components/schedule/schedule-event-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BundlesService } from '@/server/services/bundles';
import { WarehousesService } from '@/server/services/warehouses';

export const metadata = { title: 'New event · Schedule' };

export default async function NewScheduleEventPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const params = await searchParams;
  // Pre-fill the date when the user clicked a day cell on the
  // calendar (?date=YYYY-MM-DD). Validation happens in the schema —
  // bad input falls through to "today" inside the form.
  const initialDate =
    params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : null;

  const [warehousesSvc, bundlesSvc] = await Promise.all([
    WarehousesService.forCurrentUser(),
    BundlesService.forCurrentUser(),
  ]);
  const [warehouses, bundles] = await Promise.all([
    warehousesSvc.list(),
    bundlesSvc.list(),
  ]);

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
          />
        </CardContent>
      </Card>
    </div>
  );
}
