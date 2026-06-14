import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { CreateRestorePointButton } from '@/components/settings/create-restore-point-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { withContext } from '@/server/services/context';
import { listSnapshots } from '@/server/services/restore-points';

import { hasPermission, planAllowsRestorePoints, type OrgBillingState } from '@stockpilot/core';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Backups & restore — Settings' };

const KIND_LABEL: Record<string, string> = {
  manual: 'Manual',
  auto: 'Automatic',
  pre_restore: 'Pre-restore (auto)',
};

export default async function RestorePointsPage() {
  const ctx = await withContext();
  // Owner/admin only.
  if (!hasPermission(ctx.role, 'organization:update')) redirect('/dashboard/settings');

  const { data: orgRow } = await ctx.supabase
    .from('organizations')
    .select(
      'plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
    )
    .eq('id', ctx.organizationId)
    .maybeSingle();
  const entitled = planAllowsRestorePoints((orgRow as OrgBillingState | null) ?? { plan: null });

  const snapshots = entitled ? await listSnapshots(ctx) : [];

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Backups &amp; restore</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Point-in-time snapshots of your inventory and stock you can roll back to.
        </p>
      </div>

      {!entitled ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Restore points</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              Restore points are a <span className="font-medium text-foreground">Business</span>{' '}
              feature. Upgrade to Business or above to snapshot and roll back your inventory.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Create a restore point</CardTitle>
              <CardDescription>
                Captures every item, its stock level, and its category/supplier/location now. A
                daily snapshot is also taken automatically.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CreateRestorePointButton />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Snapshots</CardTitle>
              <CardDescription>
                The most recent {snapshots.length} kept (older ones are pruned automatically).
              </CardDescription>
            </CardHeader>
            <CardContent>
              {snapshots.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No restore points yet. Create one above, or wait for tonight&apos;s automatic
                  snapshot.
                </p>
              ) : (
                <div className="overflow-hidden rounded-md border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <th className="px-4 py-2.5 font-medium">When</th>
                        <th className="px-4 py-2.5 font-medium">Type</th>
                        <th className="px-4 py-2.5 font-medium">Label</th>
                        <th className="px-4 py-2.5 font-medium text-right">Items</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshots.map((s) => (
                        <tr key={s.id} className="border-b last:border-0">
                          <td className="px-4 py-2.5">{new Date(s.createdAt).toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">
                            {KIND_LABEL[s.kind] ?? s.kind}
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">{s.label ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                            {s.itemCount}
                            {s.capped ? '+' : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
