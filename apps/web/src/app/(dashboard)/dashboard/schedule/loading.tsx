import { ScheduleSkeleton } from '@/components/schedule/schedule-skeleton';

/**
 * The schedule folder's loading state. It also stands in for the routes under
 * it (an event's page, New event, Edit event), so it draws the shape of the
 * page on the path: the month grid for the calendar, the narrow header and
 * cards for an event or a form (components/schedule/schedule-skeleton.tsx).
 */
export default function ScheduleLoading() {
  return <ScheduleSkeleton />;
}
