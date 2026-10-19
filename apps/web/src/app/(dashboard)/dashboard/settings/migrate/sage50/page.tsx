import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { Sage50ImportWizard } from '@/components/settings/sage50-import-wizard';
import { SettingsPage } from '@/components/settings/settings-panel';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

import { can } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Migrate from Sage 50 — Settings' };

// A migration chunk runs hundreds of ledger-correct item creates — give the
// import action (which inherits this segment's config) room beyond the
// default function timeout.
export const maxDuration = 300;

/**
 * "Migrate from Sage 50" — guided CSV onboarding (no API/credentials needed;
 * Sage 50 US has no cloud API, its built-in exports are the migration path).
 * Server-side gate mirrors the import action's permission (items:import).
 */
export default async function Sage50MigratePage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'items:import')) {
    redirect('/dashboard/settings');
  }

  // Imported items must open in a warehouse. Offer only the ones THIS caller
  // can write to (warehouse-scoped roles see just their assignments).
  const access = await getWarehouseAccess(ctx);
  const supabase = await createClient();
  const { data: warehouseRows } = access.writableIds.length
    ? await supabase
        .from('warehouses')
        .select('id, name')
        // in-list-bound: the caller's writable warehouses (an org's handful of sites)
        .in('id', access.writableIds)
        .order('name', { ascending: true })
    : { data: [] };
  const warehouses = ((warehouseRows ?? []) as { id: string; name: string }[]).map((w) => ({
    id: w.id,
    name: w.name,
  }));

  return (
    <SettingsPage>
      <PageHeader
        title="Migrate from Sage 50"
        subline={
          <>
            Bring your items, stock quantities, and vendors over from Sage 50&apos;s built-in CSV
            exports. Three files, one import, nothing overwritten.
          </>
        }
        back={
          <PageHeaderBackLink href="/dashboard/settings/integrations">
            ← Back to integrations
          </PageHeaderBackLink>
        }
      />
      <Sage50ImportWizard warehouses={warehouses} />
    </SettingsPage>
  );
}
