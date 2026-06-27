import type { Metadata } from 'next';

import { SupportTriage } from '@/components/admin/support-triage';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { listSupportTickets } from '@/server/services/support-tickets';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Support tickets · Platform' };

/**
 * Support-ticket triage, folded into the platform console. Gate is the
 * (platform) layout; the ticket service is service-role behind that gate.
 */
export default async function PlatformSupportPage() {
  // In-page gate — the layout renders in parallel and can't stop this body's
  // service-role read of EVERY tenant's support tickets.
  await requirePlatformAdmin();

  const tickets = await listSupportTickets();
  const open = tickets.filter((t) => t.status === 'open' || t.status === 'in_progress').length;

  return (
    <div className="mx-auto w-full max-w-[1280px] px-6 pb-20 pt-7">
      <div className="mb-6 border-b border-border pb-4">
        <h1 className="font-display text-[26px] font-medium tracking-[-0.025em]">Support tickets</h1>
        <p className="mt-1 text-[13px] text-[var(--ed-ink-3)]">
          {open} open · {tickets.length} total — submitted from the public support page.
        </p>
      </div>
      <SupportTriage tickets={tickets} />
    </div>
  );
}
