import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Sage50ImportWizard } from '@/components/settings/sage50-import-wizard';
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
        .in('id', access.writableIds)
        .order('name', { ascending: true })
    : { data: [] };
  const warehouses = ((warehouseRows ?? []) as { id: string; name: string }[]).map((w) => ({
    id: w.id,
    name: w.name,
  }));

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings/integrations"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to integrations
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Migrate from Sage 50</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Bring your items, stock quantities, and vendors over from Sage 50&apos;s built-in CSV
          exports. Three files, one import, nothing overwritten.
        </p>
      </div>
      <Sage50ImportWizard warehouses={warehouses} />
    </div>
  );
}
