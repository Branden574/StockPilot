import type { Metadata } from 'next';

import { SupportTriage } from '@/components/admin/support-triage';
import { PageHeader } from '@/components/patterns/page-header';
import { PlatformPage } from '@/components/platform/platform-page';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { createAttachmentSignedUrls, listSupportTickets } from '@/server/services/support-tickets';

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

  // Screenshots live in a PRIVATE bucket with no read policy — mint 1-hour
  // signed URLs server-side (service-role) behind the platform-admin gate,
  // in one batched storage call.
  const paths = tickets.flatMap((t) => (t.attachmentPath ? [t.attachmentPath] : []));
  const urlByPath = await createAttachmentSignedUrls(paths);
  const attachmentUrls: Record<string, string> = {};
  for (const t of tickets) {
    const url = t.attachmentPath ? urlByPath[t.attachmentPath] : undefined;
    if (url) attachmentUrls[t.id] = url;
  }

  return (
    <PlatformPage>
      <PageHeader
        title="Support tickets"
        subline={`${open} open · ${tickets.length} total — submitted from the public support page.`}
      />
      <SupportTriage tickets={tickets} attachmentUrls={attachmentUrls} />
    </PlatformPage>
  );
}
