import Link from 'next/link';
import { notFound } from 'next/navigation';

import { can } from '@stockpilot/core';

import { PageHeader } from '@/components/patterns/page-header';
import { EmbeddingsBackfillPanel } from '@/components/settings/embeddings-backfill-panel';
import { SettingsPage, SettingsPanel } from '@/components/settings/settings-nav';
import { requireOrgContext } from '@/lib/auth/session';
import { withContext } from '@/server/services/context';

export const dynamic = 'force-dynamic';

export default async function AiSettingsPage() {
  const ctx = await requireOrgContext();
  // Gate on the explicit `ai:manage` permission (admin+) rather than
  // `isAdminRole()`. Same audience today, but routing through the
  // permission matrix keeps role/permission consistency tight and makes
  // future role surgery (e.g. a hypothetical "AI admin" role) a one-line
  // matrix change instead of a hunt for `isAdminRole` calls.
  if (!can(ctx, 'ai:manage')) {
    notFound();
  }
  // Pre-fetch counts so the panel renders meaningful numbers on first
  // paint instead of "loading…" — the action call inside the panel
  // then keeps them fresh as the backfill progresses.
  const svcCtx = await withContext();
  const [remainingRes, totalRes] = await Promise.all([
    svcCtx.supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', svcCtx.organizationId)
      .is('deleted_at', null)
      .is('embedding', null),
    svcCtx.supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', svcCtx.organizationId)
      .is('deleted_at', null),
  ]);
  const initialRemaining = remainingRes.count ?? 0;
  const initialTotal = totalRes.count ?? 0;

  return (
    <SettingsPage>
      <PageHeader
        title="AI"
        subline="Configure the AI assistant's knowledge of your inventory."
        back={
          <div className="text-muted-foreground flex items-center gap-2 text-[12.5px]">
            <Link href="/dashboard/settings" className="hover:text-foreground transition-colors">
              Settings
            </Link>
            <span aria-hidden className="text-ink-4">
              /
            </span>
            <span>AI</span>
          </div>
        }
      />

      <SettingsPanel
        title="Semantic search embeddings"
        description={
          <>
            Embeddings let the assistant find items by meaning (
            <span className="font-medium">&quot;something for cleaning spills&quot;</span>) instead
            of exact keyword. New and edited items embed automatically; run a backfill once to cover
            existing inventory.
          </>
        }
      >
        <EmbeddingsBackfillPanel initialRemaining={initialRemaining} initialTotal={initialTotal} />
      </SettingsPanel>
    </SettingsPage>
  );
}
