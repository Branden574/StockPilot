import { redirect } from 'next/navigation';

/**
 * Legacy route. The admin audit console was consolidated onto
 * /dashboard/audit (the ONE grantable audit surface, gated on
 * activity_logs:read instead of the admin layout). `event` and `category`
 * map 1:1 onto the new page; the old client-side `actor` name search has
 * no server-side equivalent there (use the Actor user-id filter), so it is
 * dropped.
 *
 * Note: this file still sits under the /dashboard/admin layout, which
 * hard-gates organization:update — non-admins with old links bounce to
 * /dashboard at the layout, which is exactly where the old page sent them.
 */
export default async function LegacyAdminAuditRedirect({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; category?: string }>;
}) {
  const params = await searchParams;
  const usp = new URLSearchParams();
  if (params.category) usp.set('category', params.category);
  if (params.event) usp.set('event', params.event);
  const qs = usp.toString();
  redirect(qs ? `/dashboard/audit?${qs}` : '/dashboard/audit');
}
