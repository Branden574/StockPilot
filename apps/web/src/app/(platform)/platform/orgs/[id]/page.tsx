import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BillingPanel } from '@/components/platform/billing-panel';
import { PasswordResetButton } from '@/components/platform/password-reset-button';
import { requireSession } from '@/lib/auth/session';
import { recordPlatformAudit } from '@/server/services/platform/audit';
import {
  DETAIL_PREVIEW_LIMIT,
  getOrgBillingState,
  getOrgInventory,
  getOrgMembers,
  getOrgOrders,
  getOrgOverview,
} from '@/server/services/platform/orgs';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Organization · Platform' };

type Tab = 'overview' | 'inventory' | 'users' | 'orders' | 'billing';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'users', label: 'Users' },
  { key: 'orders', label: 'Orders' },
  { key: 'billing', label: 'Billing' },
];

export default async function PlatformOrgDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: tabParam } = await searchParams;
  const tab: Tab = (TABS.find((t) => t.key === tabParam)?.key ?? 'overview') as Tab;

  const overview = await getOrgOverview(id);
  if (!overview) notFound();

  // Record the cross-org view once, on the overview landing. (The layout
  // already proved platform-admin; requireSession is cached + cheap.)
  if (tab === 'overview') {
    const session = await requireSession();
    await recordPlatformAudit({
      actorUserId: session.userId,
      actorEmail: session.email,
      action: 'viewed_org',
      targetOrganizationId: id,
      detail: { name: overview.name },
    });
  }

  const tierName =
    overview.effective.tier.charAt(0).toUpperCase() + overview.effective.tier.slice(1);

  return (
    <div className="mx-auto w-full max-w-[1280px] px-6 pb-20 pt-7">
      <Link href="/platform" className="text-[12px] text-[var(--ed-ink-4)] hover:text-foreground">
        ← Organizations
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="font-display text-[26px] font-medium tracking-[-0.025em]">
            {overview.name}
          </h1>
          <p className="mt-1 text-[12.5px] text-[var(--ed-ink-4)]">
            {overview.slug}
            {overview.industry ? ` · ${overview.industry}` : ''} · owner{' '}
            {overview.ownerEmail ?? '—'}
          </p>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
            Billing
          </div>
          <div className="text-[14px] font-medium">
            {tierName}
            {overview.billingArrangement !== 'standard' ? ` · ${overview.billingArrangement}` : ''}
          </div>
          {overview.effective.trialDaysRemaining != null ? (
            <div className="text-[12px] text-amber-600">
              Trial — {overview.effective.trialDaysRemaining}d left
            </div>
          ) : null}
        </div>
      </div>

      {/* Tab nav */}
      <div className="mt-4 flex items-center gap-1 border-b border-border">
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <Link
              key={t.key}
              href={`/platform/orgs/${id}?tab=${t.key}`}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
                active
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-[var(--ed-ink-4)] hover:text-foreground'
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>

      <div className="mt-5">
        {tab === 'overview' && <OverviewTab overview={overview} />}
        {tab === 'inventory' && (await InventoryTab({ orgId: id }))}
        {tab === 'users' && (await UsersTab({ orgId: id }))}
        {tab === 'orders' && (await OrdersTab({ orgId: id }))}
        {tab === 'billing' && (await BillingTab({ orgId: id }))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[10px] border border-border bg-card p-4">
      <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">{label}</div>
      <div className="mt-1 font-mono text-[22px] tabular-nums">{value}</div>
    </div>
  );
}

function OverviewTab({
  overview,
}: {
  overview: NonNullable<Awaited<ReturnType<typeof getOrgOverview>>>;
}) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Members" value={overview.counts.members} />
        <Stat label="Items" value={overview.counts.items} />
        <Stat label="Orders" value={overview.counts.orders} />
        <Stat label="Warehouses" value={overview.counts.warehouses} />
      </div>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-[13px] sm:grid-cols-3">
        <Meta label="Created" value={new Date(overview.createdAt).toLocaleDateString()} />
        <Meta label="Timezone" value={overview.timezone ?? '—'} />
        <Meta label="Currency" value={overview.currency ?? '—'} />
        <Meta label="Size" value={overview.size ?? '—'} />
        <Meta label="Plan source" value={overview.effective.source} />
      </dl>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

async function InventoryTab({ orgId }: { orgId: string }) {
  const items = await getOrgInventory(orgId);
  if (items.length === 0)
    return <p className="text-[13px] text-[var(--ed-ink-4)]">No items in this organization.</p>;
  return (
    <>
      <PreviewTable
        head={['Item', 'SKU', 'On hand', 'Unit cost', 'Status']}
        rows={items.map((i) => [
          i.name,
          i.sku ?? '—',
          String(i.quantityOnHand),
          i.unitCost == null ? '—' : `$${i.unitCost.toFixed(2)}`,
          i.status ?? '—',
        ])}
      />
      <CapNote count={items.length} />
    </>
  );
}

async function UsersTab({ orgId }: { orgId: string }) {
  const members = await getOrgMembers(orgId);
  if (members.length === 0)
    return <p className="text-[13px] text-[var(--ed-ink-4)]">No members.</p>;
  return (
    <div className="overflow-hidden rounded-[10px] border border-border">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border bg-card text-left text-[11px] uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
            <th className="px-4 py-2.5 font-medium">User</th>
            <th className="px-4 py-2.5 font-medium">Role</th>
            <th className="px-4 py-2.5 font-medium">Joined</th>
            <th className="px-4 py-2.5 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m, idx) => (
            <tr key={m.userId ?? idx} className="border-b border-border last:border-0">
              <td className="px-4 py-2.5">
                <div className="font-medium">{m.fullName ?? '—'}</div>
                <div className="text-[11.5px] text-[var(--ed-ink-4)]">{m.email ?? '—'}</div>
              </td>
              <td className="px-4 py-2.5 text-[var(--ed-ink-3)]">{m.role}</td>
              <td className="px-4 py-2.5 text-[12px] text-[var(--ed-ink-4)]">
                {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '—'}
              </td>
              <td className="px-4 py-2.5 text-right">
                {m.userId ? (
                  <PasswordResetButton userId={m.userId} email={m.email} />
                ) : (
                  <span className="text-[11.5px] text-[var(--ed-ink-4)]">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function OrdersTab({ orgId }: { orgId: string }) {
  const orders = await getOrgOrders(orgId);
  if (orders.length === 0)
    return <p className="text-[13px] text-[var(--ed-ink-4)]">No orders.</p>;
  return (
    <>
      <PreviewTable
        head={['Order', 'Status', 'Requester', 'Created']}
        rows={orders.map((o) => [
          o.id.slice(0, 8),
          o.status,
          o.requester ?? '—',
          new Date(o.createdAt).toLocaleDateString(),
        ])}
      />
      <CapNote count={orders.length} />
    </>
  );
}

async function BillingTab({ orgId }: { orgId: string }) {
  const b = await getOrgBillingState(orgId);
  if (!b) return <p className="text-[13px] text-[var(--ed-ink-4)]">Org not found.</p>;
  const tierName = b.effective.tier.charAt(0).toUpperCase() + b.effective.tier.slice(1);
  const effectiveLabel =
    b.arrangement !== 'standard' ? `${tierName} · ${b.arrangement}` : tierName;
  return (
    <BillingPanel
      organizationId={orgId}
      accessTier={b.accessTier}
      arrangement={b.arrangement}
      customPriceCents={b.customPriceCents}
      customPriceInterval={b.customPriceInterval}
      allModulesComp={b.allModulesComp}
      billingNotes={b.billingNotes}
      trialTier={b.trialTier}
      trialEndsAt={b.trialEndsAt}
      hasStripeSubscription={b.hasStripeSubscription}
      effectiveLabel={effectiveLabel}
      trialDaysRemaining={b.effective.trialDaysRemaining}
    />
  );
}

function PreviewTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border bg-card text-left text-[11px] uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {r.map((c, j) => (
                <td key={j} className="px-4 py-2.5 text-[var(--ed-ink-3)]">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CapNote({ count }: { count: number }) {
  if (count < DETAIL_PREVIEW_LIMIT) return null;
  return (
    <p className="mt-2 text-[12px] text-[var(--ed-ink-4)]">
      Showing the first {DETAIL_PREVIEW_LIMIT} (preview). Use &ldquo;Act as this org&rdquo; to see
      everything.
    </p>
  );
}
