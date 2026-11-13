import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { SettingsPage } from '@/components/settings/settings-nav';
import { IndustryPacks } from '@/components/settings/industry-packs';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { can, PACK_PRESET_LIST, type DomainPack } from '@stockpilot/core';

// The Liquid Glass settings and administration composition (stage 4:
// pages/admin.css): every rule is scoped to this area's [data-glass-page] root
// and to glass, so Classic never matches it (glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/admin.css';

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

  const activePack = ((row as { domain_pack?: string } | null)?.domain_pack ??
    null) as DomainPack | null;

  return (
    <SettingsPage>
      <PageHeader
        title="Industry template"
        subline={
          'Set up StockPilot for your industry in one click. This turns on the modules for the template and suggests labels — it never turns off modules you already enabled, and it keeps any labels you have already customized.'
        }
        back={
          <PageHeaderBackLink href="/dashboard/settings">← Back to settings</PageHeaderBackLink>
        }
      />

      <IndustryPacks presets={[...PACK_PRESET_LIST]} activePack={activePack} />
    </SettingsPage>
  );
}
