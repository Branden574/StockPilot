import {
  AlertTriangle,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';

import { NotificationsList } from '@/components/notifications/notifications-list';
import {
  getDashboardActions,
  getDashboardSummary,
} from '@/server/services/movements';
import { NotificationsService } from '@/server/services/notifications';
import { formatNumber } from '@/lib/utils';

export const metadata = {
  title: 'Notifications',
};

export default async function NotificationsPage() {
  const [svc, summary, actions] = await Promise.all([
    NotificationsService.forCurrentUser(),
    getDashboardSummary(),
    getDashboardActions(),
  ]);
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

  // Live alerts derived from current state — not from the persisted
  // notifications table. Lets the page surface "what needs attention
  // right now" without depending on a notification-writer pipeline that
  // hasn't been wired up yet.
  const lowStockTotal = summary.lowStockCount + summary.outOfStockCount;
  type Tone = 'warn' | 'info';
  const liveAlerts: Array<{
    key: string;
    icon: LucideIcon;
    title: string;
    description: string;
    href: string;
    tone: Tone;
  }> = [];
  if (lowStockTotal > 0) {
    liveAlerts.push({
      key: 'low-stock',
      icon: AlertTriangle,
      title: `${formatNumber(lowStockTotal)} item${lowStockTotal === 1 ? '' : 's'} need restocking`,
      description: `${formatNumber(summary.outOfStockCount)} out of stock · ${formatNumber(summary.lowStockCount)} below par`,
      href: '/dashboard/inventory?stock=low&type=all',
      tone: 'warn',
    });
  }
  if (actions.openPoCount > 0) {
    liveAlerts.push({
      key: 'open-pos',
      icon: ClipboardList,
      title: `${formatNumber(actions.openPoCount)} purchase order${actions.openPoCount === 1 ? '' : 's'} open`,
      description: 'Receivable POs waiting on stock to land.',
      href: '/dashboard/purchase-orders',
      tone: 'info',
    });
  }
  if (actions.openCycleCount > 0) {
    liveAlerts.push({
      key: 'cycle-counts',
      icon: ClipboardCheck,
      title: `${formatNumber(actions.openCycleCount)} cycle count${actions.openCycleCount === 1 ? '' : 's'} in progress`,
      description: 'Review and post variances when finished.',
      href: '/dashboard/cycle-counts',
      tone: 'info',
    });
  }

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Live alerts on top — what needs your attention right now. Below, the
          history of recorded low-stock and PO events.
        </p>
      </div>

      {liveAlerts.length > 0 ? (
        <section className="mb-8">
          <h2 className="text-muted-foreground mb-3 text-[10.5px] font-semibold uppercase tracking-wider">
            Live alerts
          </h2>
          <div className="space-y-2">
            {liveAlerts.map((a) => (
              <Link
                key={a.key}
                href={a.href}
                className={
                  'group bg-card hover:border-foreground/30 flex items-start gap-3 rounded-lg border p-4 transition-colors ' +
                  (a.tone === 'warn' ? 'border-warning/40' : 'border-border')
                }
              >
                <div
                  className={
                    'rounded-md p-2 ' +
                    (a.tone === 'warn'
                      ? 'bg-warning/10 text-warning'
                      : 'bg-muted text-foreground')
                  }
                >
                  <a.icon className="h-4 w-4" strokeWidth={1.75} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{a.title}</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {a.description}
                  </p>
                </div>
                <ChevronRight className="text-muted-foreground mt-1 h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        </section>
      ) : (
        <section className="border-success/30 bg-success/5 mb-8 rounded-lg border px-4 py-3 text-sm">
          <p className="font-medium">All clear right now</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            No low-stock items, no open POs, no in-progress counts.
          </p>
        </section>
      )}

      <section>
        <h2 className="text-muted-foreground mb-3 text-[10.5px] font-semibold uppercase tracking-wider">
          Notification history
        </h2>
        <NotificationsList notifications={notifications} />
      </section>
    </div>
  );
}
