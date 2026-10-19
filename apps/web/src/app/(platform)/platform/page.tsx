import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { DeletionPassphraseForm } from '@/components/platform/deletion-passphrase-form';
import { PlatformPage } from '@/components/platform/platform-page';
import { PlatformTable } from '@/components/platform/platform-table';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  getPlatformMetrics,
  listOrgsForPlatform,
  type PlatformOrgSummary,
} from '@/server/services/platform/orgs';

const NUM = new Intl.NumberFormat('en-US');
const USD0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Organizations · Platform' };

/**
 * Human label + tone for the resolved billing status shown per org. The words
 * carry the meaning; the tone (one of the shared status label tones) only
 * repeats it.
 */
function billingBadge(o: PlatformOrgSummary): {
  label: string;
  tone: NonNullable<BadgeProps['variant']>;
} {
  const { effective, billingArrangement } = o;
  const tierName = effective.tier.charAt(0).toUpperCase() + effective.tier.slice(1);
  if (billingArrangement === 'comped') {
    return { label: `${tierName} · Comped`, tone: 'success' };
  }
  if (effective.source === 'trial' && effective.trialDaysRemaining != null) {
    return {
      label: `${tierName} · Trial — ${effective.trialDaysRemaining}d left`,
      tone: 'warning',
    };
  }
  if (effective.source === 'stripe') {
    return { label: `${tierName} · Stripe`, tone: 'secondary' };
  }
  if (billingArrangement === 'custom') {
    return { label: `${tierName} · Custom`, tone: 'secondary' };
  }
  return { label: tierName, tone: 'outline' };
}

export default async function PlatformOrgsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  // In-page gate. The (platform) layout also calls requirePlatformAdmin, but
  // Next renders the layout and this page IN PARALLEL — a layout notFound()
  // can't stop this page body's service-role (RLS-bypassing) reads from
  // executing. Re-gate here so the cross-org fan-out below never runs for a
  // non-admin. (requireSession/getVerifiedEmail are React-cached → ~free.)
  await requirePlatformAdmin();

  const { q } = await searchParams;
  // Platform-wide metrics + the directory in one fan-out.
  const [{ orgs, capped }, metrics] = await Promise.all([
    listOrgsForPlatform(q),
    getPlatformMetrics(),
  ]);

  // Whether a deletion passphrase already exists — drives the "current
  // passphrase" field on rotation. Service-role read of the locked settings row.
  let passphraseConfigured = false;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from('platform_settings')
      .select('org_deletion_passphrase_hash')
      .eq('id', true)
      .maybeSingle();
    passphraseConfigured = Boolean(
      (data as { org_deletion_passphrase_hash: string | null } | null)
        ?.org_deletion_passphrase_hash,
    );
  } catch {
    passphraseConfigured = false;
  }

  return (
    <PlatformPage>
      <PageHeader
        title="Organizations"
        subline="Every organization on the platform. Click one to view its data, manage billing, or act as it."
      />

      {/* Platform-wide traction metrics (across all orgs). Seven figures: the
          150 px tracks keep all seven on one row at a desktop width (the
          180 px ones left Movements alone on a second row). */}
      <StatStrip variant="detail" aria-label="Platform totals">
        <StatStripItem label="Organizations" value={NUM.format(metrics.totalOrgs)} />
        <StatStripItem label="Users" value={NUM.format(metrics.totalUsers)} />
        <StatStripItem label="Items" value={NUM.format(metrics.totalItems)} />
        <StatStripItem label="Inventory value" value={USD0.format(metrics.totalInventoryValue)} />
        <StatStripItem label="Purchase orders" value={NUM.format(metrics.totalPurchaseOrders)} />
        <StatStripItem label="Orders" value={NUM.format(metrics.totalOrders)} />
        <StatStripItem label="Movements" value={NUM.format(metrics.totalMovements)} />
      </StatStrip>

      <form method="GET" className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          name="q"
          aria-label="Search organizations"
          defaultValue={q ?? ''}
          placeholder="Search by name or slug…"
          className="min-w-0 max-w-sm flex-1 basis-56"
        />
        <Button type="submit" variant="outline" className="max-sm:h-11">
          Search
        </Button>
        {q ? (
          <Link
            href="/platform"
            className="text-muted-foreground hover:text-foreground inline-flex h-8 items-center px-1 text-[12.5px] transition-colors max-sm:h-11"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <div className="flex flex-col gap-2">
        <PlatformTable label="Organizations" minWidth={720}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Organization</TableHead>
              <TableHead>Billing</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead className="text-right">Items</TableHead>
              <TableHead className="text-right">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orgs.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0">
                  <StatePanel
                    kind={q ? 'no-match' : 'empty'}
                    surface="plain"
                    headingLevel={null}
                    icon={null}
                    title={q ? `No organizations match “${q}”.` : 'No organizations yet.'}
                  />
                </TableCell>
              </TableRow>
            ) : (
              orgs.map((o) => {
                const badge = billingBadge(o);
                return (
                  <TableRow key={o.id}>
                    <TableCell>
                      {/* No prefetch and no warm-up: opening an org renders its
                          Overview, which WRITES a viewed_org audit row, so only
                          a real click may fetch it. */}
                      <Link
                        href={`/platform/orgs/${o.id}`}
                        prefetch={false}
                        className="group block min-w-0"
                      >
                        <div className="text-foreground font-medium group-hover:underline">
                          {o.name}
                        </div>
                        <div className="text-muted-foreground text-[12px]">
                          <span className="font-mono text-[11.5px]">{o.slug}</span>
                          {o.industry ? ` · ${o.industry}` : ''}
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={badge.tone}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {o.memberCount}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {o.itemCount}
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap text-right text-[12.5px]">
                      {new Date(o.createdAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </PlatformTable>

        {capped ? (
          <p className="text-warning text-[12.5px]">
            Showing the first 500 organizations. Narrow with search to find a specific one.
          </p>
        ) : (
          <p className="text-muted-foreground text-[12.5px]">
            {orgs.length} organization{orgs.length === 1 ? '' : 's'}.
          </p>
        )}
      </div>

      {/* Global danger-zone control — the passphrase that gates every org delete. */}
      <div className="border-border mt-6 border-t pt-6">
        <DeletionPassphraseForm isConfigured={passphraseConfigured} />
      </div>
    </PlatformPage>
  );
}
