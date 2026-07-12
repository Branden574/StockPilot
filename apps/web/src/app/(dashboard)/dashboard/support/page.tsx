import type { Metadata } from 'next';

import { SupportTicketForm } from '@/components/support/support-ticket-form';
import { Badge } from '@/components/ui/badge';
import { requireOrgContext } from '@/lib/auth/session';
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
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Support &amp; feedback</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Found a bug, want a feature, or have a billing question? Send it straight to the
        StockPilot team — screenshots welcome.
      </p>

      <div className="bg-card mt-6 rounded-xl border p-5 sm:p-6">
        <SupportTicketForm userId={ctx.userId} />
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">My submissions</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Your latest tickets from this workspace and where they stand.
        </p>

        {tickets.length === 0 ? (
          <div className="bg-card text-muted-foreground mt-4 rounded-xl border px-5 py-8 text-center text-sm">
            Nothing yet — your submissions will show up here.
          </div>
        ) : (
          <div className="bg-card mt-4 divide-y rounded-xl border">
            {tickets.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t.subject}</div>
                  <div className="text-muted-foreground mt-0.5 text-xs">
                    {new Date(t.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </div>
                </div>
                <Badge variant="outline">{CATEGORY_LABEL[t.category]}</Badge>
                <Badge variant={STATUS_BADGE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
