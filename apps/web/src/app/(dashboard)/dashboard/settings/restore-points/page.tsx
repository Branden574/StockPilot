import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { Lock } from 'lucide-react';

import { PageHeader } from '@/components/patterns/page-header';
import { CreateRestorePointButton } from '@/components/settings/create-restore-point-button';
import { RestoreSnapshotButton } from '@/components/settings/restore-snapshot-button';
import { SettingsPage, SettingsPanel } from '@/components/settings/settings-panel';
import { LocalDateTime } from '@/components/ui/local-datetime';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { withContext } from '@/server/services/context';
import { listSnapshots } from '@/server/services/restore-points';

import { can, planAllowsRestorePoints, type OrgBillingState } from '@stockpilot/core';

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
  if (!can(ctx, 'organization:update')) redirect('/dashboard/settings');

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
    <SettingsPage>
      <PageHeader
        title="Backups & restore"
        subline="Point-in-time snapshots of your inventory and stock you can roll back to."
      />

      {!entitled ? (
        <SettingsPanel title="Restore points">
          <div className="bg-sunk text-muted-foreground flex items-start gap-2.5 rounded-md border p-4 text-[13px]">
            <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Restore points are a <span className="text-foreground font-medium">Business</span>{' '}
              feature. Upgrade to Business or above to snapshot and roll back your inventory.
            </p>
          </div>
        </SettingsPanel>
      ) : (
        <>
          <SettingsPanel
            title="Create a restore point"
            description="Captures every item, its stock level, and its category/supplier/location now. A daily snapshot is also taken automatically."
          >
            <CreateRestorePointButton />
          </SettingsPanel>

          <SettingsPanel
            title="Snapshots"
            description={`The most recent ${snapshots.length} kept (older ones are pruned automatically).`}
            flush
          >
            {snapshots.length === 0 ? (
              <p className="text-muted-foreground px-[18px] py-4 text-[13px]">
                No restore points yet. Create one above, or wait for tonight&apos;s automatic
                snapshot.
              </p>
            ) : (
              // The table scrolls inside the card on narrow screens (it was
              // clipped by overflow-hidden before); the page never scrolls
              // sideways.
              <Table className="min-w-[600px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>When</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snapshots.map((s) => (
                    <TableRow key={s.id} className="align-top">
                      <TableCell className="whitespace-nowrap">
                        <LocalDateTime iso={s.createdAt} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {KIND_LABEL[s.kind] ?? s.kind}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{s.label ?? '—'}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {s.itemCount}
                        {s.capped ? '+' : ''}
                      </TableCell>
                      <TableCell className="text-right">
                        <RestoreSnapshotButton id={s.id} createdAt={s.createdAt} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SettingsPanel>
        </>
      )}
    </SettingsPage>
  );
}
