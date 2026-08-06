import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { MaintenanceSettingsPanel } from '@/components/maintenance/maintenance-settings-panel';
import { withContext } from '@/server/services/context';

import { can, MAINTENANCE_CATEGORIES } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Maintenance requests' };

interface RawSettings {
  categories?: unknown;
  includeShareLinksInEmail?: unknown;
  notifyAudience?: unknown;
}

/**
 * Owner-only settings for the maintenance-requests module (master brief
 * §5/§6/§26). Gated on `maintenance_requests:configure` — owner-only by
 * design (adjudication C2, filtered out of admin's derived permission set
 * and absent from FULLY_GRANTABLE_PERMISSIONS). An admin without an
 * explicit per-user override cannot even load this page; the write action
 * (updateMaintenanceSettingsAction) re-checks the same gate server-side so
 * this page's redirect is not the only line of defense.
 *
 * Deliberately does NOT gate on the maintenance_requests MODULE being
 * enabled — the owner may configure categories/audience/recipients before
 * (or after) flipping the module on for the org, matching how every other
 * settings-write action in this codebase (auto-archive, auto-delete-
 * archived) gates purely on permission. The organization_modules row for
 * every module id — including a disabled one — is seeded at org creation
 * (migration 0314 §2/§3), so this page and its action never hit a missing
 * row just because the module toggle is off.
 */
export default async function MaintenanceSettingsPage() {
  const ctx = await withContext();
  if (!can(ctx, 'maintenance_requests:configure')) {
    redirect('/dashboard/settings');
  }

  const supabase = ctx.supabase;

  const [{ data: mod }, { data: memberRows }] = await Promise.all([
    supabase
      .from('organization_modules')
      .select('settings')
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'maintenance_requests')
      .maybeSingle(),
    supabase
      .from('organization_members')
      .select('user_id, user:user_id (full_name, email)')
      .eq('organization_id', ctx.organizationId)
      .not('accepted_at', 'is', null),
  ]);

  const settings = ((mod as { settings?: RawSettings } | null)?.settings ?? {}) as RawSettings;

  // Same fallback rule as the /new form's own reader
  // (dashboard/maintenance/new/page.tsx) — an absent/empty/malformed
  // configured list falls back to the brief §7 default twelve.
  const configuredCategories = settings.categories;
  const initialCategories: string[] =
    Array.isArray(configuredCategories) &&
    configuredCategories.length > 0 &&
    configuredCategories.every((c) => typeof c === 'string')
      ? (configuredCategories as string[])
      : [...MAINTENANCE_CATEGORIES];

  // Same "absent means never configured, default ON" rule as
  // shareLinksEnabled() (api/v1/maintenance-requests/[id]/route.ts).
  const initialIncludeShareLinksInEmail = settings.includeShareLinksInEmail !== false;

  const initialNotifyAudience: Record<string, 'all' | 'urgent_only' | 'none'> =
    settings.notifyAudience && typeof settings.notifyAudience === 'object'
      ? (settings.notifyAudience as Record<string, 'all' | 'urgent_only' | 'none'>)
      : {};

  const members = (
    (memberRows ?? []) as Array<{
      user_id: string;
      user: { full_name?: string | null; email?: string | null } | null;
    }>
  ).map((m) => ({
    userId: m.user_id,
    name: m.user?.full_name || m.user?.email || 'Member',
  }));

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Maintenance requests</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Categories, notification audiences, and photo link settings.
      </p>
      <div className="mt-8">
        <MaintenanceSettingsPanel
          initialCategories={initialCategories}
          initialIncludeShareLinksInEmail={initialIncludeShareLinksInEmail}
          initialNotifyAudience={initialNotifyAudience}
          members={members}
        />
      </div>
    </div>
  );
}
