import type { Metadata } from 'next';
import Link from 'next/link';

import { DeletionPassphraseForm } from '@/components/platform/deletion-passphrase-form';
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

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="font-display text-[22px] font-medium tracking-[-0.02em] tabular-nums">
        {value}
      </div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-[var(--ed-ink-3)]">
        {label}
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Organizations · Platform' };

/** Human label + tone for the resolved billing status shown per org. */
function billingBadge(o: PlatformOrgSummary): { label: string; tone: string } {
  const { effective, billingArrangement } = o;
  const tierName = effective.tier.charAt(0).toUpperCase() + effective.tier.slice(1);
  if (billingArrangement === 'comped') {
    return { label: `${tierName} · Comped`, tone: 'border-emerald-500/40 text-emerald-600' };
  }
  if (effective.source === 'trial' && effective.trialDaysRemaining != null) {
    return {
      label: `${tierName} · Trial — ${effective.trialDaysRemaining}d left`,
      tone: 'border-amber-500/40 text-amber-600',
    };
  }
  if (effective.source === 'stripe') {
    return { label: `${tierName} · Stripe`, tone: 'border-blue-500/40 text-blue-600' };
  }
  if (billingArrangement === 'custom') {
    return { label: `${tierName} · Custom`, tone: 'border-violet-500/40 text-violet-600' };
  }
  return { label: tierName, tone: 'border-border text-[var(--ed-ink-3)]' };
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
      (data as { org_deletion_passphrase_hash: string | null } | null)?.org_deletion_passphrase_hash,
    );
  } catch {
    passphraseConfigured = false;
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] px-6 pb-20 pt-7">
      <div className="mb-6 border-b border-border pb-4">
        <h1 className="font-display text-[26px] font-medium tracking-[-0.025em]">Organizations</h1>
        <p className="mt-1 text-[13px] text-[var(--ed-ink-3)]">
          Every organization on the platform. Click one to view its data, manage billing, or act as
          it.
        </p>
      </div>

      {/* Platform-wide traction metrics (across all orgs). */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <MetricCard label="Organizations" value={NUM.format(metrics.totalOrgs)} />
        <MetricCard label="Users" value={NUM.format(metrics.totalUsers)} />
        <MetricCard label="Items" value={NUM.format(metrics.totalItems)} />
        <MetricCard label="Inventory value" value={USD0.format(metrics.totalInventoryValue)} />
        <MetricCard label="Purchase orders" value={NUM.format(metrics.totalPurchaseOrders)} />
        <MetricCard label="Orders" value={NUM.format(metrics.totalOrders)} />
        <MetricCard label="Movements" value={NUM.format(metrics.totalMovements)} />
      </div>

      <form method="GET" className="mb-4 flex items-center gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search by name or slug…"
          className="h-9 w-full max-w-sm rounded-md border border-border bg-background px-3 text-[13px] outline-none focus:border-[var(--ed-line-strong)]"
        />
        <button
          type="submit"
          className="h-9 rounded-md border border-border bg-card px-3 text-[13px] font-medium hover:border-[var(--ed-line-strong)]"
        >
          Search
        </button>
        {q ? (
          <Link href="/platform" className="text-[12px] text-[var(--ed-ink-4)] hover:text-foreground">
            Clear
          </Link>
        ) : null}
      </form>

      <div className="overflow-hidden rounded-[10px] border border-border">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-card text-left text-[11px] uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
              <th className="px-4 py-2.5 font-medium">Organization</th>
              <th className="px-4 py-2.5 font-medium">Billing</th>
              <th className="px-4 py-2.5 font-medium text-right">Members</th>
              <th className="px-4 py-2.5 font-medium text-right">Items</th>
              <th className="px-4 py-2.5 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {orgs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-[var(--ed-ink-4)]">
                  {q ? `No organizations match “${q}”.` : 'No organizations yet.'}
                </td>
              </tr>
            ) : (
              orgs.map((o) => {
                const badge = billingBadge(o);
                return (
                  <tr key={o.id} className="border-b border-border last:border-0 hover:bg-card">
                    <td className="px-4 py-2.5">
                      <Link href={`/platform/orgs/${o.id}`} className="group block">
                        <div className="font-medium group-hover:underline">{o.name}</div>
                        <div className="text-[11.5px] text-[var(--ed-ink-4)]">
                          {o.slug}
                          {o.industry ? ` · ${o.industry}` : ''}
                        </div>
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.tone}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[var(--ed-ink-3)]">
                      {o.memberCount}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[var(--ed-ink-3)]">
                      {o.itemCount}
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-[var(--ed-ink-4)]">
                      {new Date(o.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {capped ? (
        <p className="mt-3 text-[12px] text-amber-600">
          Showing the first 500 organizations. Narrow with search to find a specific one.
        </p>
      ) : (
        <p className="mt-3 text-[12px] text-[var(--ed-ink-4)]">
          {orgs.length} organization{orgs.length === 1 ? '' : 's'}.
        </p>
      )}

      {/* Global danger-zone control — the passphrase that gates every org delete. */}
      <div className="mt-10 border-t border-border pt-8">
        <DeletionPassphraseForm isConfigured={passphraseConfigured} />
      </div>
    </div>
  );
}
