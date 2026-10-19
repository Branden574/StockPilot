import type { Metadata } from 'next';

import { DetailSection, DetailSectionMeta } from '@/components/patterns/detail-section';
import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { SupportTicketForm } from '@/components/support/support-ticket-form';
import { Badge } from '@/components/ui/badge';
import { LocalDate } from '@/components/ui/local-date';
import { requireOrgContext } from '@/lib/auth/session';
import { utcDateLabel } from '@/lib/utc-date-label';
import {
  listMyTickets,
  type TicketCategory,
  type TicketStatus,
} from '@/server/services/support-tickets';

export const metadata: Metadata = { title: 'Support & feedback' };

const CATEGORY_LABEL: Record<TicketCategory, string> = {
  bug: 'Problem',
  feature: 'Feature request',
  billing: 'Billing',
  account: 'Account',
  other: 'Other',
};
const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};
const STATUS_BADGE: Record<TicketStatus, 'secondary' | 'warning' | 'success' | 'outline'> = {
  open: 'secondary',
  in_progress: 'warning',
  resolved: 'success',
  closed: 'outline',
};

/**
 * In-app Support & feedback: signed-in members report problems, request
 * features, or ask billing questions without leaving the dashboard. Tickets
 * land in the same platform-admin triage queue as the public /support form
 * (service-role table, mig 0173); "My submissions" below shows this member's
 * own tickets in this workspace so they can see status without emailing.
 */
export default async function DashboardSupportPage() {
  const ctx = await requireOrgContext();
  const tickets = await listMyTickets({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        title="Support & feedback"
        subline="Found a bug, want a feature, or have a billing question? Send it straight to the StockPilot team — screenshots welcome."
      />

      <DetailSection bodyClassName="p-[18px] sm:p-6">
        <SupportTicketForm userId={ctx.userId} />
      </DetailSection>

      <DetailSection
        title="My submissions"
        flush
        className="mt-3"
        aside={
          <DetailSectionMeta>
            Your latest tickets from this workspace and where they stand.
          </DetailSectionMeta>
        }
      >
        {tickets.length === 0 ? (
          <StatePanel
            kind="empty"
            surface="plain"
            icon={null}
            headingLevel={null}
            title="Nothing yet — your submissions will show up here."
          />
        ) : (
          <ul>
            {tickets.map((t) => (
              <li
                key={t.id}
                className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-[18px] py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-foreground truncate text-[13.5px] font-medium leading-5">
                    {t.subject}
                  </div>
                  <div className="text-muted-foreground mt-0.5 text-[12px] leading-[18px]">
                    {/* The viewer's own calendar day: formatted on the
                        server this was the deployment's (UTC) day, a day
                        late for an evening ticket west of Greenwich. */}
                    <LocalDate iso={t.createdAt} fallback={utcDateLabel(t.createdAt)} />
                  </div>
                </div>
                <Badge variant="outline">{CATEGORY_LABEL[t.category]}</Badge>
                <Badge variant={STATUS_BADGE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </div>
  );
}
