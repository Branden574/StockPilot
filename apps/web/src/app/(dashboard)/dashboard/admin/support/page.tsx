import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SupportTriage } from '@/components/admin/support-triage';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { currentUserIsPlatformAdmin } from '@/lib/auth/platform-admin';
import { listSupportTickets } from '@/server/services/support-tickets';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Support tickets · Admin' };

export default async function AdminSupportPage() {
  // Platform-admin only — support tickets are StockPilot's own inbox, not
  // per-org data. Non-admins bounce to the dashboard. Gated on the VERIFIED
  // auth email, never the user-writable profile column.
  if (!(await currentUserIsPlatformAdmin())) redirect('/dashboard');

  const tickets = await listSupportTickets();
  const open = tickets.filter((t) => t.status === 'open' || t.status === 'in_progress').length;

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/admin">← Admin</PageHeaderBackLink>}
        title="Support tickets"
        subline={`${open} open · ${tickets.length} total — submitted from the public support page.`}
      />

      <SupportTriage tickets={tickets} />
    </div>
  );
}
