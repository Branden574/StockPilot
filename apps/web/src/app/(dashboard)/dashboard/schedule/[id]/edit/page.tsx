import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ScheduleEventForm } from '@/components/schedule/schedule-event-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ServiceError } from '@/server/services/context';
import { ScheduleService } from '@/server/services/schedule';
import { WarehousesService } from '@/server/services/warehouses';

export const metadata = { title: 'Edit event · Schedule' };

export default async function EditScheduleEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [scheduleSvc, warehousesSvc] = await Promise.all([
    ScheduleService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);
  let event;
  try {
    event = await scheduleSvc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }
  const warehouses = await warehousesSvc.list();

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href={`/dashboard/schedule/${id}`}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to event
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit event</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{event.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <ScheduleEventForm
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
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
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
