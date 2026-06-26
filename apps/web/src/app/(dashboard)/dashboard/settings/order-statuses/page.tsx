import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

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
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Order statuses</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Rename and recolor the badges shown on order requests for your whole organization. This
          changes only how each status is labeled and colored — the underlying order workflow and
          its steps are unchanged.
        </p>
      </div>

      <OrderStatusesEditor initialConfig={orgRow?.order_status_config ?? null} />
    </div>
  );
}
