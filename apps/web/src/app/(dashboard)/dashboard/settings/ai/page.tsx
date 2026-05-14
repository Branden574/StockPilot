import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isAdminRole } from '@stockpilot/core';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmbeddingsBackfillPanel } from '@/components/settings/embeddings-backfill-panel';
import { requireOrgContext } from '@/lib/auth/session';
import { withContext } from '@/server/services/context';

export const dynamic = 'force-dynamic';

export default async function AiSettingsPage() {
  const ctx = await requireOrgContext();
  if (!isAdminRole(ctx.role)) {
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
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/dashboard/settings" className="hover:text-foreground">
          Settings
        </Link>
        <span>/</span>
        <span>AI</span>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">AI</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Configure the AI assistant&apos;s knowledge of your inventory.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Semantic search embeddings</CardTitle>
          <CardDescription>
            Embeddings let the assistant find items by meaning (
            <span className="font-medium">&quot;something for cleaning spills&quot;</span>
            ) instead of exact keyword. New and edited items embed automatically;
            run a backfill once to cover existing inventory.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmbeddingsBackfillPanel
            initialRemaining={initialRemaining}
            initialTotal={initialTotal}
          />
        </CardContent>
      </Card>
    </div>
  );
}
