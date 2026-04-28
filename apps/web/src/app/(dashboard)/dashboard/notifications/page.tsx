import { NotificationsList } from '@/components/notifications/notifications-list';
import { NotificationsService } from '@/server/services/notifications';

export const metadata = {
  title: 'Notifications',
};

export default async function NotificationsPage() {
  const svc = await NotificationsService.forCurrentUser();
  const rows = await svc.list({ limit: 100 });

  const notifications = rows.map((n) => ({
    id: n.id as string,
    type: n.type as string,
    title: n.title as string,
    body: (n.body as string | null) ?? null,
    link: (n.link as string | null) ?? null,
    readAt: (n.read_at as string | null) ?? null,
    createdAt: n.created_at as string,
  }));

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Low-stock alerts, team activity, purchase order status, and weekly summaries.
        </p>
      </div>
      <NotificationsList notifications={notifications} />
    </div>
  );
}
