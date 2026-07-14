import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { ArchiveCleanupPanel } from '@/components/settings/archive-cleanup-panel';
import { AutoArchivePanel } from '@/components/settings/auto-archive-panel';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { parseAutoDeleteArchivedSettings } from '@/server/services/archive-cleanup';
import { parseAutoArchiveSettings } from '@/server/services/auto-archive';

import { can } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Archived item cleanup' };

export default async function InventoryCleanupSettingsPage() {
  const ctx = await requireOrgContext();
  // items:delete = same gate as Recovery, for the auto-DELETE panel below.
  // items:update = the (lighter) gate for the auto-ARCHIVE panel, which is
  // reversible. Reach the page with either; each panel is shown only to
  // callers who can actually save it (owner/admin have both; manager/staff
  // have items:update only and see just the auto-archive panel).
  const canDelete = can(ctx, 'items:delete');
  const canUpdate = can(ctx, 'items:update');
  if (!canDelete && !canUpdate) redirect('/dashboard/settings');

  const supabase = await createClient();

  const { data: mod } = await supabase
    .from('organization_modules')
    .select('settings')
    .eq('organization_id', ctx.organizationId)
    .eq('module_id', 'inventory')
    .maybeSingle();
  const autoArchiveBucket = (mod?.settings as Record<string, unknown> | null | undefined)
    ?.autoArchiveOnZeroStock;
  const autoArchiveSettings = parseAutoArchiveSettings(autoArchiveBucket);

  let settings: { enabled: boolean; days: number } | null = null;
  let archivedCount = 0;
  const windowedCounts: Record<number, number> = {};

  if (canDelete) {
    const bucket = (mod?.settings as Record<string, unknown> | null | undefined)?.autoDeleteArchived;
    settings = parseAutoDeleteArchivedSettings(bucket);

    // Total currently-archived (context) + a per-window "already past this
    // window, so would be removed on the next run" count for blast-radius
    // visibility. Computed for every selectable day option so the panel can show
    // the real impact live as the dropdown changes. head+count returns no rows.
    const totalArchived = supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .eq('status', 'archived')
      .is('deleted_at', null);

    const dayOptions = Array.from(new Set([30, 60, 90, 180, 365, settings.days]));
    const now = Date.now();
    const [{ count }, ...windowed] = await Promise.all([
      totalArchived,
      ...dayOptions.map((d) =>
        supabase
          .from('inventory_items')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', ctx.organizationId)
          .eq('status', 'archived')
          .is('deleted_at', null)
          .not('archived_at', 'is', null)
          .lte('archived_at', new Date(now - d * 86_400_000).toISOString()),
      ),
    ]);
    archivedCount = count ?? 0;
    dayOptions.forEach((d, i) => {
      windowedCounts[d] = windowed[i]?.count ?? 0;
    });
  }

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Inventory cleanup</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Automate what happens to inactive inventory: archive items that stay out of stock, and (for
        admins) remove items that have been archived for a long time. Archiving is reversible;
        deletion only ever soft-deletes, so nothing is lost permanently.
      </p>
      <div className="mt-8 space-y-6">
        {canDelete && settings ? (
          <ArchiveCleanupPanel
            initial={settings}
            archivedCount={archivedCount}
            windowedCounts={windowedCounts}
          />
        ) : null}
        <AutoArchivePanel initial={autoArchiveSettings} />
      </div>
    </div>
  );
}
