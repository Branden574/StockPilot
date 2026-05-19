import { redirect } from 'next/navigation';

import { requireOrgContext } from '@/lib/auth/session';

import { hasPermission } from '@stockpilot/core';

/**
 * Gates the entire /dashboard/purchase-orders/imports/* tree on
 * purchase_orders:manage. PO-import actions (create, process, retry)
 * all assert that permission server-side. Without this layout the
 * pages render for viewers/staff and only fail on action — confusing.
 */
export default async function PoImportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'purchase_orders:manage')) {
    redirect('/dashboard');
  }
  return <>{children}</>;
}
