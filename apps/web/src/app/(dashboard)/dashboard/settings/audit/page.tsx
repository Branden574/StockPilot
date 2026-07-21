import { redirect } from 'next/navigation';

/**
 * Legacy route. The audit console was consolidated onto /dashboard/audit
 * (the ONE grantable audit surface, gated on activity_logs:read) — this
 * stub preserves old bookmarks and the Recovery "View history" deep-links
 * minted before the move. Every filter param maps 1:1 onto the new page,
 * so the full query string is forwarded.
 */
export default async function LegacySettingsAuditRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') usp.set(key, value);
    else if (Array.isArray(value)) for (const v of value) usp.append(key, v);
  }
  const qs = usp.toString();
  redirect(qs ? `/dashboard/audit?${qs}` : '/dashboard/audit');
}
