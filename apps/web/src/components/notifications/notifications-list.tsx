'use client';

import { Bell, Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { formatRelative, cn } from '@/lib/utils';
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from '@/server/actions/notifications';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationsListProps {
  notifications: Notification[];
}

export function NotificationsList({ notifications }: NotificationsListProps) {
  const router = useRouter();

  if (notifications.length === 0) {
    return (
      <EmptyState
        icon={Bell}
        title="All caught up"
        description="Low-stock alerts, team activity, and PO updates show up here as they happen."
      />
    );
  }

  const unread = notifications.filter((n) => !n.readAt);

  async function markRead(id: string) {
    const res = await markNotificationReadAction(id);
    if (!res.ok) toast.error(res.error.message);
    else router.refresh();
  }

  async function markAll() {
    const res = await markAllNotificationsReadAction();
    if (!res.ok) toast.error(res.error.message);
    else {
      toast.success('All notifications marked as read.');
      router.refresh();
    }
  }

  return (
    <div className="space-y-3">
      {unread.length > 0 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">
            {unread.length} unread notification{unread.length === 1 ? '' : 's'}
          </p>
          <Button variant="outline" size="sm" onClick={markAll}>
            <Check className="h-3.5 w-3.5" /> Mark all read
          </Button>
        </div>
      )}
      <ul className="overflow-x-auto rounded-xl border bg-card divide-y">
        {notifications.map((n) => {
          const isUnread = !n.readAt;
          return (
            <li
              key={n.id}
              className={cn(
                'flex items-start gap-3 px-4 py-3 transition-colors',
                isUnread && 'bg-primary/5',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                  isUnread ? 'bg-primary' : 'bg-transparent',
                )}
              />
              <div className="min-w-0 flex-1">
                {/* Defense-in-depth: notifications.link is server-written
                    today (writer triggers + service code), but if a
                    poisoned row ever gets in we don't want
                    `javascript:alert(...)` to render as a clickable
                    link. Restrict to internal relative paths. */}
                {n.link && n.link.startsWith('/') && !n.link.startsWith('//') ? (
                  <Link href={n.link} className="block hover:underline">
                    <p className="text-sm font-medium">{n.title}</p>
                  </Link>
                ) : (
                  <p className="text-sm font-medium">{n.title}</p>
                )}
                {n.body && <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p>}
                <p
                  className="mt-1 text-xs uppercase tracking-wider text-muted-foreground"
                  suppressHydrationWarning
                >
                  {n.type.replace('_', ' ')} · {formatRelative(n.createdAt)}
                </p>
              </div>
              {isUnread && (
                <Button variant="ghost" size="sm" onClick={() => markRead(n.id)}>
                  Mark read
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
