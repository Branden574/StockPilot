import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { DashboardCustomizer } from '@/components/settings/dashboard-customizer';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';

import { DASHBOARD_WIDGETS, hasPermission, type DashboardLayout } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Dashboard — Settings' };

/**
 * Admin-only editor for the per-org landing dashboard widget layout. We hand
 * the client editor the full widget catalog (DASHBOARD_WIDGETS) plus the org's
 * current saved layout; the editor produces a `DashboardLayout` payload and the
 * server action (`setDashboardLayoutAction`) re-validates it authoritatively.
 *
 * The catalog + the editor's serialization both mirror `resolveDashboardWidgets`
 * (what the dashboard actually renders), so the order/visibility shown here is
 * the order/visibility members see on the dashboard.
 */
export default async function DashboardSettingsPage() {
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'organization:update')) {
    redirect('/dashboard');
  }

  const orgRow = await getOrgRowForRequest(ctx.organizationId);

  // Untrusted jsonb — the client editor + the server action both validate; we
  // only pass v:1 shapes through to seed the form. Anything else → default.
  const raw = orgRow?.dashboard_layout;
  const initialLayout: DashboardLayout | null =
    raw && typeof raw === 'object' && (raw as { v?: unknown }).v === 1
      ? (raw as DashboardLayout)
      : null;

  const widgets = DASHBOARD_WIDGETS.map((w) => ({ id: w.id, title: w.title }));

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Choose which cards appear on the dashboard and in what order, for your whole
          organization. Use the arrows to reorder and the eye toggle to show or hide a card.
        </p>
      </div>

      <DashboardCustomizer widgets={widgets} initialLayout={initialLayout} />
    </div>
  );
}
