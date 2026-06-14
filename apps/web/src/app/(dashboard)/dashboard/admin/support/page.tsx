import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { SupportTriage } from '@/components/admin/support-triage';
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
    <div className="mx-auto w-full max-w-[1280px] px-8 pb-20 pt-7">
      <div className="mb-6 border-b border-border pb-4">
        <Link
          href="/dashboard/admin"
          className="text-[var(--ed-ink-4)] hover:text-foreground text-[12px]"
        >
          ← Admin
        </Link>
        <h1 className="font-display mt-2 text-[28px] font-medium tracking-[-0.025em]">
          Support tickets
        </h1>
        <p className="mt-1 text-[13.5px] text-[var(--ed-ink-3)]">
          {open} open · {tickets.length} total — submitted from the public support page.
        </p>
      </div>

      <SupportTriage tickets={tickets} />
    </div>
  );
}
