'use client';

import { Bell, Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { DetailSection, DetailSectionMeta } from '@/components/patterns/detail-section';
import { StatePanel } from '@/components/patterns/state-panel';
import { Button } from '@/components/ui/button';
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

/** The link guard below, also used to decide whether a title is a link. */
function isInternalPath(link: string | null): link is string {
  return Boolean(link && link.startsWith('/') && !link.startsWith('//'));
}

export function NotificationsList({ notifications }: NotificationsListProps) {
  const router = useRouter();

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
    <DetailSection
      title="Notification history"
      flush
      aside={
        unread.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <DetailSectionMeta>
              {unread.length} unread notification{unread.length === 1 ? '' : 's'}
            </DetailSectionMeta>
            <Button variant="outline" size="sm" onClick={markAll}>
              <Check className="h-3.5 w-3.5" /> Mark all read
            </Button>
          </div>
        ) : undefined
      }
    >
      {notifications.length === 0 ? (
        <StatePanel
          kind="empty"
          surface="plain"
          icon={Bell}
          headingLevel={3}
          title="All caught up"
          description="Low-stock alerts, team activity, and PO updates show up here as they happen."
        />
      ) : (
        <ul>
          {notifications.map((n) => {
            const isUnread = !n.readAt;
            return (
              <li
                key={n.id}
                data-unread={isUnread ? 'true' : undefined}
                className={cn(
                  'border-border flex items-start gap-3 border-b px-[18px] py-3 transition-colors last:border-b-0',
                  isUnread && 'bg-success-wash/60',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-[7px] h-2 w-2 shrink-0 rounded-full',
                    isUnread ? 'bg-accent' : 'bg-transparent',
                  )}
                />
                <div className="min-w-0 flex-1">
                  {/* Defense-in-depth: notifications.link is server-written
                      today (writer triggers + service code), but if a
                      poisoned row ever gets in we don't want
                      `javascript:alert(...)` to render as a clickable
                      link. Restrict to internal relative paths. */}
                  {isInternalPath(n.link) ? (
                    <Link
                      href={n.link}
                      className="hover:text-foreground block rounded-sm underline-offset-2 hover:underline"
                    >
                      <p className="text-foreground text-[13.5px] font-medium leading-5 [overflow-wrap:anywhere]">
                        {n.title}
                      </p>
                    </Link>
                  ) : (
                    <p className="text-foreground text-[13.5px] font-medium leading-5 [overflow-wrap:anywhere]">
                      {n.title}
                    </p>
                  )}
                  {n.body && (
                    <p className="text-muted-foreground mt-0.5 text-[13px] leading-[19.5px] [overflow-wrap:anywhere]">
                      {n.body}
                    </p>
                  )}
                  <p
                    className="text-muted-foreground mt-1 text-[11px] uppercase leading-4 tracking-[0.06em]"
                    suppressHydrationWarning
                  >
                    {n.type.replace('_', ' ')} · {formatRelative(n.createdAt)}
                  </p>
                </div>
                {isUnread && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-ink-2 shrink-0"
                    onClick={() => markRead(n.id)}
                  >
                    Mark read
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </DetailSection>
  );
}
