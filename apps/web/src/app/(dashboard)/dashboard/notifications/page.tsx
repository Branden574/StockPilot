import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';

import { NotificationsList } from '@/components/notifications/notifications-list';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader } from '@/components/patterns/page-header';
import { getDashboardActions, getDashboardSummary } from '@/server/services/movements';
import { NotificationsService } from '@/server/services/notifications';
import { cn, formatNumber } from '@/lib/utils';

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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        title="Notifications"
        subline="Live alerts on top — what needs your attention right now. Below, the history of recorded low-stock and PO events."
      />

      <DetailSection title="Live alerts" flush>
        {liveAlerts.length > 0 ? (
          <ul>
            {liveAlerts.map((a) => (
              <li key={a.key} className="border-border border-b last:border-b-0">
                <Link
                  href={a.href}
                  data-tone={a.tone}
                  className="hover:bg-muted group flex items-start gap-3.5 px-[18px] py-3 transition-colors focus-visible:ring-inset focus-visible:ring-offset-0"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'grid size-8 shrink-0 place-items-center rounded-full',
                      a.tone === 'warn'
                        ? 'bg-warning-wash text-warning'
                        : 'bg-sunk text-foreground border-line-strong border',
                    )}
                  >
                    <a.icon className="h-4 w-4" strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0 flex-1 pt-0.5">
                    <span className="text-foreground block text-[13.5px] font-medium leading-5">
                      {a.title}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-[12.5px] leading-[18.75px]">
                      {a.description}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden
                    className="text-muted-foreground mt-2 h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                    strokeWidth={1.8}
                  />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex items-start gap-3.5 px-[18px] py-3.5">
            <span
              aria-hidden
              className="bg-success-wash text-accent grid size-8 shrink-0 place-items-center rounded-full"
            >
              <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-foreground text-[13.5px] font-medium leading-5">
                All clear right now
              </p>
              <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-[18.75px]">
                No low-stock items, no open POs, no in-progress counts.
              </p>
            </div>
          </div>
        )}
      </DetailSection>

      <NotificationsList notifications={notifications} />
    </div>
  );
}
