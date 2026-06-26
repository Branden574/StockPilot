import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { ArchiveCleanupPanel } from '@/components/settings/archive-cleanup-panel';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { parseAutoDeleteArchivedSettings } from '@/server/services/archive-cleanup';

import { can } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Archived item cleanup' };

export default async function InventoryCleanupSettingsPage() {
  const ctx = await requireOrgContext();
  // Same gate as Recovery — this configures automatic deletion of inventory.
  if (!can(ctx, 'items:delete')) redirect('/dashboard/settings');

  const supabase = await createClient();

  const { data: mod } = await supabase
    .from('organization_modules')
    .select('settings')
    .eq('organization_id', ctx.organizationId)
    .eq('module_id', 'inventory')
    .maybeSingle();
  const bucket = (mod?.settings as Record<string, unknown> | null | undefined)?.autoDeleteArchived;
  const settings = parseAutoDeleteArchivedSettings(bucket);

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
  const [{ count: archivedCount }, ...windowed] = await Promise.all([
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
  const windowedCounts: Record<number, number> = {};
  dayOptions.forEach((d, i) => {
    windowedCounts[d] = windowed[i]?.count ?? 0;
  });

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Archived item cleanup</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Keep your Items list tidy by automatically removing items that have stayed archived for a
        long time. It&apos;s off by default and only ever soft-deletes — nothing is lost permanently.
      </p>
      <div className="mt-8">
        <ArchiveCleanupPanel
          initial={settings}
          archivedCount={archivedCount ?? 0}
          windowedCounts={windowedCounts}
        />
      </div>
    </div>
  );
}
