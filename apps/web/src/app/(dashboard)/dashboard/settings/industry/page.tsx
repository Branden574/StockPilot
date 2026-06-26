import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { IndustryPacks } from '@/components/settings/industry-packs';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { can, PACK_PRESET_LIST, type DomainPack } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Industry template — Settings' };

export default async function IndustrySettingsPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'organization:update')) {
    redirect('/dashboard');
  }

  const supabase = await createClient();
  const { data: row } = await supabase
    .from('organizations')
    .select('domain_pack')
    .eq('id', ctx.organizationId)
    .maybeSingle();

  const activePack = ((row as { domain_pack?: string } | null)?.domain_pack ?? null) as
    | DomainPack
    | null;

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Industry template</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Set up StockPilot for your industry in one click. This turns on the modules for
          the template and suggests labels — it never turns off modules you already enabled,
          and it keeps any labels you have already customized.
        </p>
      </div>

      <IndustryPacks presets={[...PACK_PRESET_LIST]} activePack={activePack} />
    </div>
  );
}
