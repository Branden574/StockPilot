import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { EmailRoutingPanel } from '@/components/settings/email-routing-panel';
import { getOrgEmailRouting } from '@/lib/dashboard/cached-org';
import { withContext } from '@/server/services/context';

import { can } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Email routing' };

/**
 * Per-org compose-email routing (organizations.email_routing, migration
 * 0337): where the delivery-request and maintenance-request email actions
 * address their drafts, configured per organization.
 *
 * Gate: `organization:update` — it matches the RLS floor exactly
 * (organizations_update = admin role), so this page can never show a form
 * its viewer's role could not save. The server action re-gates on the same
 * permission plus the org MFA policy; this redirect is the discoverability
 * gate, not the security boundary.
 *
 * The two features resolve independently (an org may configure one, both,
 * or neither), so the page reads both states and the panel renders a card
 * per feature. The read is the SAME resolver every compose surface uses
 * (getOrgEmailRouting -> core's parseOrgEmailRouting -> the branded
 * factories), so the status shown here can never disagree with what the
 * surfaces actually do.
 */
export default async function EmailRoutingSettingsPage() {
  const ctx = await withContext();
  if (!can(ctx, 'organization:update')) redirect('/dashboard/settings');

  const [deliveryRouting, maintenanceRouting] = await Promise.all([
    getOrgEmailRouting(ctx.organizationId, 'delivery_request'),
    getOrgEmailRouting(ctx.organizationId, 'maintenance_request'),
  ]);

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Email routing</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Where the delivery-request and maintenance-request email actions address their drafts.
        Each feature routes independently: members see the email action only for features with a
        valid To and CC configured here. StockPilot opens drafts in the sender&apos;s own mail
        app — it never sends anything itself.
      </p>
      <div className="mt-8">
        <EmailRoutingPanel
          initialDelivery={deliveryRouting}
          initialMaintenance={maintenanceRouting}
        />
      </div>
    </div>
  );
}
