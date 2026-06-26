import { redirect } from 'next/navigation';

import { requireOrgContext } from '@/lib/auth/session';

import { can } from '@stockpilot/core';

/**
 * Gates the entire /dashboard/reports/* tree on the reports:read
 * permission. Removed from viewer role on 2026-05-19 — viewers no
 * longer need or see reports. Direct URL access (typing
 * /dashboard/reports or any sub-page) lands here, gets the permission
 * check, and redirects to the dashboard for any role that lacks it.
 *
 * Sibling fix: the Reports nav button in
 * apps/web/src/components/dashboard/nav.ts is already gated on
 * reports:read, so viewers don't see the button either.
 */
export default async function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'reports:read')) {
    redirect('/dashboard');
  }
  return <>{children}</>;
}
