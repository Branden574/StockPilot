import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { SettingsPage } from '@/components/settings/settings-nav';
import { OrderStatusesEditor } from '@/components/settings/order-statuses-editor';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';

import { can } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Order statuses — Settings' };

/**
 * Admin-only editor for per-org ORDER STATUS presentation. Each of the canonical
 * order statuses can be relabeled and recolored — a SOFT override that never
 * touches the status CHECK constraint or the transition state machine. Gated on
 * `organization:update` (owner/admin) — mirrors Modules / Navigation / Custom
 * fields. The resolved labels/colors flow through <OrderStatusBadge> everywhere
 * orders are shown.
 */
export default async function OrderStatusesSettingsPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'organization:update')) {
    redirect('/dashboard');
  }

  // Read the override off the cached org row — zero extra round-trips. The
  // editor resolves it over the canonical defaults itself.
  const orgRow = await getOrgRowForRequest(ctx.organizationId);

  return (
    <SettingsPage>
      <PageHeader
        title="Order statuses"
        subline={
          'Rename and recolor the badges shown on order requests for your whole organization. This changes only how each status is labeled and colored — the underlying order workflow and its steps are unchanged.'
        }
        back={
          <PageHeaderBackLink href="/dashboard/settings">← Back to settings</PageHeaderBackLink>
        }
      />

      <OrderStatusesEditor initialConfig={orgRow?.order_status_config ?? null} />
    </SettingsPage>
  );
}
