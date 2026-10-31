import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DetailSection } from '@/components/patterns/detail-section';
import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { Tabs } from '@/components/patterns/tabs';
import { ActAsButton } from '@/components/platform/act-as-button';
import { BillingPanel } from '@/components/platform/billing-panel';
import { PlatformPage } from '@/components/platform/platform-page';
import { PlatformTable } from '@/components/platform/platform-table';
import { RemoveOrgDialog } from '@/components/platform/remove-org-dialog';
import { UserActionsMenu } from '@/components/platform/user-actions-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { isPlatformAdmin, requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { requireSession } from '@/lib/auth/session';
import { cn } from '@/lib/utils';
import { formatDayInZone, formatMomentInZone } from '@/lib/platform/dates';
import {
  describeLastActive,
  formatLastActive,
  resolveLastActive,
} from '@/lib/platform/last-active';
import { recordPlatformAudit } from '@/server/services/platform/audit';
import {
  DETAIL_PREVIEW_LIMIT,
  getOrgBillingState,
  getOrgInventory,
  getOrgMembers,
  getOrgMembersOrderItemsAccess,
  getOrgOrders,
  getOrgOverview,
  type PlatformMemberOrderItemsAccess,
  type PlatformOrgMember,
} from '@/server/services/platform/orgs';

import type { OrderItemsAccessTarget } from '@/components/platform/order-items-access-dialog';

import {
  ORDER_ITEMS_ACCESS_DISABLED_COPY,
  ORDER_ITEMS_ACCESS_MODULE_OFF_COPY,
  orderCatalogAccessChipCopy,
  orderCatalogAccessSourceCopy,
  resolveOrgTimezone,
} from '@stockpilot/core';

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

/**
 * Next.js hands a repeated `?key=a&key=b` query param back as `string[]`,
 * not `string` — a shape none of this page's searchParams fields were ever
 * typed for. Same idiom as `firstParam` in app/r/confirm/page.tsx.
 */
function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function PlatformOrgDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    tab?: string | string[];
    q?: string | string[];
    page?: string | string[];
  }>;
}) {
  // In-page gate — see note in (platform)/platform/page.tsx. The layout's
  // requirePlatformAdmin can't stop this page body (it renders in parallel),
  // and this body does cross-org service-role READS *and a WRITE*
  // (recordPlatformAudit). Re-gate before any of it runs so a non-admin
  // hitting /platform/orgs/{anyOrgId} can neither read another tenant's data
  // nor forge a platform-audit row.
  await requirePlatformAdmin();

  const { id } = await params;
  const { tab: tabParam, q, page: pageParam } = await searchParams;
  const tab: Tab = (TABS.find((t) => t.key === firstParam(tabParam))?.key ?? 'overview') as Tab;
  // A repeated `?q=` (a stray double-submit, a hand-edited URL) gives
  // Next.js a string[] here, not a string — the old `q?: string` type was
  // never enforced at runtime and `q?.trim()` throws on an array.
  const qSingle = firstParam(q);
  const search = qSingle?.trim() ? qSingle.trim() : null;
  const usersPage = Number.parseInt(firstParam(pageParam) ?? '1', 10);

  const overview = await getOrgOverview(id);
  if (!overview) notFound();

  // Record the cross-org view on the overview landing, and on the Users tab.
  // (The layout already proved platform-admin; requireSession is cached +
  // cheap.) The Users tab is audited in its own right because it is reachable
  // by deep link without ever passing the overview, and it shows per-person
  // activity (last sign-in, last session, last action) across a tenant
  // boundary — closer to monitoring data than the names and roles it used to
  // be. `detail` is free-form jsonb, so the tab rides there: a NEW action
  // value would need the CHECK constraint dropped and re-added with every
  // existing value restated.
  if (tab === 'overview' || tab === 'users') {
    const session = await requireSession();
    await recordPlatformAudit({
      actorUserId: session.userId,
      actorEmail: session.email,
      action: 'viewed_org',
      targetOrganizationId: id,
      detail: tab === 'users' ? { name: overview.name, tab: 'users' } : { name: overview.name },
    });
  }

  const tierName =
    overview.effective.tier.charAt(0).toUpperCase() + overview.effective.tier.slice(1);

  return (
    <PlatformPage>
      <PageHeader
        variant="item"
        back={<PageHeaderBackLink href="/platform">← Organizations</PageHeaderBackLink>}
        title={overview.name}
        meta={
          <span>
            <span className="font-mono text-[12px]">{overview.slug}</span>
            {overview.industry ? ` · ${overview.industry}` : ''} · owner{' '}
            {overview.ownerEmail ?? '—'}
          </span>
        }
        actions={
          <>
            <div data-slot="org-billing-summary" className="text-left sm:text-right">
              <div className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.08em]">
                Billing
              </div>
              <div className="text-[13.5px] font-medium">
                {tierName}
                {overview.billingArrangement !== 'standard'
                  ? ` · ${overview.billingArrangement}`
                  : ''}
              </div>
              {overview.effective.trialDaysRemaining != null ? (
                <div className="text-warning text-[12px]">
                  Trial — {overview.effective.trialDaysRemaining}d left
                </div>
              ) : null}
            </div>
            {/* A record action, so the secondary (outline) button: it enters a
                mode rather than committing the work in front of you, which
                leaves the Billing tab's Save billing the page's only ink
                primary (DESIGN-SPEC 6.2, PageHeader: at most one). */}
            <ActAsButton organizationId={overview.id} orgName={overview.name} />
          </>
        }
      />

      {/* Tab nav. Every tab is its own URL (?tab=), rendered on the server.
          No prefetch: rendering Overview or Users WRITES a viewed_org audit
          row, so a tab may only render when the operator opens it. */}
      <Tabs
        aria-label="Organization"
        activeId={tab}
        prefetch={false}
        items={TABS.map((t) => ({
          id: t.key,
          label: t.label,
          href: `/platform/orgs/${id}?tab=${t.key}`,
        }))}
      />

      <div className="min-w-0">
        {tab === 'overview' && <OverviewTab overview={overview} />}
        {tab === 'inventory' && (await InventoryTab({ orgId: id }))}
        {tab === 'users' &&
          (await UsersTab({
            orgId: id,
            search,
            page: Number.isFinite(usersPage) ? usersPage : 1,
            timeZone: overview.timezone,
          }))}
        {tab === 'orders' && (await OrdersTab({ orgId: id, timeZone: overview.timezone }))}
        {tab === 'billing' && (await BillingTab({ orgId: id }))}
      </div>

      {/* ── Danger zone ──────────────────────────────────────────────── */}
      <DetailSection
        className="border-destructive/40 mt-6"
        title={<span className="text-destructive">Danger zone</span>}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground max-w-xl text-[13px]">
            Permanently delete this organization and everything in it. Requires a fresh MFA step-up,
            the global deletion passphrase, and retyping the org name. Irreversible.
          </p>
          <RemoveOrgDialog organizationId={overview.id} orgName={overview.name} />
        </div>
      </DetailSection>
    </PlatformPage>
  );
}

function OverviewTab({
  overview,
}: {
  overview: NonNullable<Awaited<ReturnType<typeof getOrgOverview>>>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <StatStrip variant="detail" role="group" aria-label="Organization totals">
        <StatStripItem size="detail" label="Members" value={overview.counts.members} />
        <StatStripItem size="detail" label="Items" value={overview.counts.items} />
        <StatStripItem size="detail" label="Orders" value={overview.counts.orders} />
        <StatStripItem size="detail" label="Warehouses" value={overview.counts.warehouses} />
      </StatStrip>
      <DetailSection flush className="max-w-2xl">
        <KeyValueList>
          <KeyValueRow label="Created">
            {formatDayInZone(overview.createdAt, overview.timezone)}
          </KeyValueRow>
          <KeyValueRow label="Timezone">{overview.timezone ?? '—'}</KeyValueRow>
          <KeyValueRow label="Currency">{overview.currency ?? '—'}</KeyValueRow>
          <KeyValueRow label="Size">{overview.size ?? '—'}</KeyValueRow>
          <KeyValueRow label="Plan source">{overview.effective.source}</KeyValueRow>
        </KeyValueList>
      </DetailSection>
      <Link
        href={`/platform/audit?org=${overview.id}`}
        className="text-accent hover:text-foreground self-start text-[13px] font-medium transition-colors"
      >
        View this org&apos;s platform-admin audit trail →
      </Link>
    </div>
  );
}

async function InventoryTab({ orgId }: { orgId: string }) {
  const items = await getOrgInventory(orgId);
  if (items.length === 0)
    return <StatePanel kind="empty" headingLevel={null} title="No items in this organization." />;
  return (
    <div className="flex flex-col gap-2">
      <PreviewTable
        label="Inventory"
        minWidth={640}
        head={['Item', 'SKU', 'On hand', 'Unit cost', 'Status']}
        numeric={[2, 3]}
        mono={[1, 2, 3]}
        rows={items.map((i) => [
          i.name,
          i.sku ?? '—',
          String(i.quantityOnHand),
          i.unitCost == null ? '—' : `$${i.unitCost.toFixed(2)}`,
          i.status ?? '—',
        ])}
      />
      <CapNote count={items.length} />
    </div>
  );
}

/**
 * The pager recipe (DESIGN-SPEC 6.2): 28 px, the stronger hairline when it
 * goes somewhere, the plain hairline and faint words when it does not. The
 * ends stay plain text, not disabled buttons, as they always were. 44 px on a
 * phone.
 */
const PAGER_BASE =
  'inline-flex h-7 items-center rounded-md border px-2.5 text-[12.5px] transition-colors max-sm:h-11';
const PAGER_ENABLED = cn(PAGER_BASE, 'border-line-strong bg-card text-foreground hover:bg-muted');
const PAGER_DISABLED = cn(PAGER_BASE, 'border-border text-muted-foreground');

/**
 * The Users tab. Unlike its sibling tabs this one is NOT a preview: it is the
 * only place in the product that can disable or re-enable an account, so a
 * member it does not render is a member no operator can act on at all. It
 * therefore pages through the whole org (never a silent slice), offers a
 * server-side search that can reach one member directly in a tenant of any
 * size, and states the exact total on screen so a partial page can never be
 * mistaken for a complete one.
 */
async function UsersTab({
  orgId,
  search,
  page,
  timeZone,
}: {
  orgId: string;
  search: string | null;
  page: number;
  /** The organization's stored zone: its members' dates are printed in it. */
  timeZone: string | null;
}) {
  const result = await getOrgMembers(orgId, { search, page });
  const { members, total, pageSize, pageCount } = result;
  // Order items access (0413) for exactly these members: one batched read,
  // null when it failed (the column then says so; nothing else is affected).
  const orderItemsAccess = await getOrgMembersOrderItemsAccess(orgId, members);
  const first = members.length === 0 ? 0 : (result.page - 1) * pageSize + 1;
  const last = (result.page - 1) * pageSize + members.length;

  const hrefFor = (p: number) => {
    const params = new URLSearchParams({ tab: 'users' });
    if (result.search) params.set('q', result.search);
    if (p > 1) params.set('page', String(p));
    return `/platform/orgs/${orgId}?${params.toString()}`;
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Same GET-form pattern as the org directory. The hidden tab field is
          what keeps a submit on this tab; omitting `page` resets to the first
          page of the new result set, which is the only sane landing. */}
      <form method="GET" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="tab" value="users" />
        <Input
          type="search"
          name="q"
          aria-label="Search members"
          defaultValue={result.search ?? ''}
          placeholder="Search by name or email…"
          className="min-w-0 max-w-sm flex-1 basis-56"
        />
        <Button type="submit" variant="outline" className="max-sm:h-11">
          Search
        </Button>
        {result.search ? (
          <Link
            href={`/platform/orgs/${orgId}?tab=users`}
            className="text-muted-foreground hover:text-foreground inline-flex h-8 items-center px-1 text-[12.5px] transition-colors max-sm:h-11"
          >
            Clear
          </Link>
        ) : null}
      </form>

      {members.length === 0 ? (
        <StatePanel
          kind={result.search ? 'no-match' : 'empty'}
          headingLevel={null}
          title={result.search ? `No members match “${result.search}”.` : 'No members.'}
        />
      ) : (
        <MembersTable
          orgId={orgId}
          members={members}
          activityAvailable={result.activityAvailable !== false}
          orderItemsAccess={orderItemsAccess}
          timeZone={timeZone}
        />
      )}

      {/*
        Rendered OUTSIDE the members.length check, deliberately: getOrgMembers
        clamps a genuinely out-of-range page server-side, but PostgREST
        returns 200/empty (not an error) at exactly offset === total — a
        legitimate empty LAST page (e.g. a search just shrank the result
        set out from under a page the operator was already on). This used
        to live inside the non-empty branch, so an empty page rendered bare
        "No members." with no pager and no Previous link — a dead end with
        no way back to page 1.
      */}
      {total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* The bound, stated. This tab used to render nothing here at all,
              which is what made 50 unreachable accounts invisible. */}
          <p className="text-muted-foreground text-[12.5px]">
            Showing {first}–{last} of {total} member{total === 1 ? '' : 's'}
            {result.search ? ` matching “${result.search}”` : ''} · page {result.page} of{' '}
            {pageCount}
          </p>
          {pageCount > 1 ? (
            <div className="flex items-center gap-2 text-[12.5px]">
              {result.page > 1 ? (
                <Link href={hrefFor(result.page - 1)} className={PAGER_ENABLED}>
                  ← Previous
                </Link>
              ) : (
                <span className={PAGER_DISABLED}>← Previous</span>
              )}
              {result.page < pageCount ? (
                <Link href={hrefFor(result.page + 1)} className={PAGER_ENABLED}>
                  Next →
                </Link>
              ) : (
                <span className={PAGER_DISABLED}>Next →</span>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** "Within the last hour" reads wrong after "Signed in"; ages and dates do not. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * One Last active cell. SYNCHRONOUS and total on purpose: it renders on the
 * only surface that can disable an account, which has no error boundary, so
 * absent keys and unparseable values must come out as "Never", not a throw.
 *
 * The label, the prefix and the tooltip are all derived from ONE resolution of
 * the member's three signals, so they cannot disagree with each other.
 *
 * Renderings that must never look alike:
 *   unavailable  the lookup failed for this page: a dash, and a note above
 *                the table. NOT "Never" — fifty rows of "Never" on this
 *                screen reads as "nobody uses the product".
 *   floor        the sign-in behind the value is no longer open, so use after
 *                it may be missing. Muted, and prefixed with the KIND of
 *                evidence ("Signed in", "Last action") instead of being stated
 *                as activity: a six-week-old sign-in is not six weeks of
 *                absence, and neither is a six-week-old audit row.
 *   measured     an open sign-in stands behind it: a coarse age, plain.
 */
function LastActiveCell({
  member,
  available,
  now,
  timeZone,
}: {
  member: PlatformOrgMember;
  available: boolean;
  now: Date;
  timeZone: string | null;
}) {
  if (!available) {
    return (
      <span className="text-muted-foreground" title="Activity could not be loaded for this page.">
        —
      </span>
    );
  }
  const resolved = resolveLastActive(member);
  const title = describeLastActive(member, timeZone);
  if (resolved.source === 'never') {
    return (
      <span className="text-muted-foreground" title={title}>
        Never
      </span>
    );
  }
  const label = formatLastActive(resolved.at, now, timeZone);
  if (resolved.floor) {
    return (
      <span className="text-muted-foreground" title={title}>
        {resolved.source === 'sign_in' ? 'Signed in' : 'Last action'} {lowerFirst(label)}
      </span>
    );
  }
  return (
    <span className="text-foreground" title={title}>
      {label}
    </span>
  );
}

/**
 * One Order items cell (orders:manage_catalog_visibility, migration 0413): the
 * effective-access chip and where it comes from (Role default, Allowed by
 * StockPilot, Denied by StockPilot), both from the core preview the dialog
 * uses. When an allowed capability cannot be used yet (a disabled account,
 * the Orders module off) the chip says Not allowed and its title says why.
 *
 * Renderings that must never look alike:
 *   unavailable  the read failed for this page: a dash, and a note above the
 *                table. Never "Role default": a deny that is not shown is the
 *                one mistake this column must not make.
 *   unknown      no entry for this member (no user id, a role this build does
 *                not know): a dash, and the row's menu offers no dialog.
 */
function OrderItemsAccessCell({
  access,
  available,
}: {
  access: PlatformMemberOrderItemsAccess | undefined;
  available: boolean;
}) {
  if (!available || !access) {
    return (
      <span
        data-testid="order-items-access-cell"
        className="text-muted-foreground"
        title={available ? undefined : 'Order items access could not be loaded for this page.'}
      >
        —
      </span>
    );
  }
  const { preview } = access;
  const why = preview.capability
    ? preview.blockers.map((b) =>
        b === 'account_disabled'
          ? ORDER_ITEMS_ACCESS_DISABLED_COPY
          : ORDER_ITEMS_ACCESS_MODULE_OFF_COPY,
      )
    : [];
  return (
    <div data-testid="order-items-access-cell" className="flex flex-col items-start gap-0.5">
      <Badge
        variant={preview.effective ? 'success' : 'secondary'}
        title={why.length > 0 ? why.join(' ') : undefined}
      >
        {orderCatalogAccessChipCopy(preview.effective)}
      </Badge>
      <span className="text-muted-foreground text-[12px]">
        {orderCatalogAccessSourceCopy(preview.source)}
      </span>
    </div>
  );
}

/** What a row's Order items access dialog starts from: plain data for the client. */
function orderItemsAccessTarget(
  orgId: string,
  member: PlatformOrgMember,
  access: PlatformMemberOrderItemsAccess | undefined,
): OrderItemsAccessTarget | null {
  if (!access || !member.userId) return null;
  return {
    organizationId: orgId,
    userId: member.userId,
    name: member.fullName ?? member.email ?? 'This member',
    role: access.role,
    disabled: access.disabled,
    exception: access.exception,
    ordersModuleEnabled: access.ordersModuleEnabled,
    canRequestOrders: access.canRequestOrders,
  };
}

/**
 * A date column's header tooltip: whose zone its dates are in. The console's
 * pages render on the server, so a date with no zone named was the server's
 * (UTC) day (B9).
 */
function orgZoneNote(timeZone: string | null): string {
  return `In this organization's time zone (${resolveOrgTimezone(timeZone)}).`;
}

/**
 * The Actions cell stays on screen while the table scrolls sideways (sticky to
 * the card's right edge, on the card's own fill, taking the row hover with
 * it), with a hairline beside it where the table can scroll under it.
 */
const ACTIONS_CELL = 'bg-card sticky right-0 max-lg:border-l max-lg:border-border';

function MembersTable({
  orgId,
  members,
  activityAvailable,
  orderItemsAccess,
  timeZone,
}: {
  orgId: string;
  members: PlatformOrgMember[];
  activityAvailable: boolean;
  /** Per member; null when the read failed for this page. */
  orderItemsAccess: Map<string, PlatformMemberOrderItemsAccess> | null;
  timeZone: string | null;
}) {
  // One clock read per render, so every row on the page ages from the same instant.
  const now = new Date();
  // This page renders on the server, so a bare toLocaleDateString() printed
  // the server's day (UTC) with no zone named, and an evening join in the
  // Pacific read as the next day (B9). Members' dates are the organization's.
  const zoneNote = orgZoneNote(timeZone);
  return (
    <div className="flex flex-col gap-2">
      {!activityAvailable ? (
        <p className="text-warning text-[12.5px]">
          Activity could not be loaded for this page. Members, status and actions are unaffected.
        </p>
      ) : null}
      {orderItemsAccess === null ? (
        <p className="text-warning text-[12.5px]">
          Order items access could not be loaded for this page. Reload to see or change it. Members,
          status and the other actions are unaffected.
        </p>
      ) : null}
      {/* The Actions column is the only way to disable or re-enable an
          account, so it is never clipped: the card scrolls sideways on a
          narrow screen, and the column stays pinned to its right edge. */}
      <PlatformTable label="Members" minWidth={880}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>User</TableHead>
            <TableHead>Role</TableHead>
            <TableHead title={zoneNote}>Joined</TableHead>
            <TableHead
              title={`An estimate: the latest of the app reporting them present here, a sign-in renewal (any device, any organization) and a recorded action in this organization. ${zoneNote}`}
            >
              Last active
            </TableHead>
            <TableHead title="Manage order items: whether they can choose which items and books appear in Place an Order. Change it from the row's actions.">
              Order items
            </TableHead>
            <TableHead className={cn(ACTIONS_CELL, 'text-right')}>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((m, idx) => (
            <TableRow key={m.userId ?? idx} className="group">
              <TableCell>
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0">
                    <div className="text-foreground font-medium">{m.fullName ?? '—'}</div>
                    <div className="text-muted-foreground text-[12px]">{m.email ?? '—'}</div>
                  </div>
                  {m.disabledAt ? (
                    <Badge
                      variant="destructive"
                      title={`Disabled ${formatMomentInZone(m.disabledAt, timeZone)}`}
                    >
                      Disabled
                    </Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="text-ink-2">{m.role}</TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                {formatDayInZone(m.joinedAt, timeZone)}
              </TableCell>
              <TableCell className="text-[12.5px]">
                <LastActiveCell
                  member={m}
                  available={activityAvailable}
                  now={now}
                  timeZone={timeZone}
                />
              </TableCell>
              <TableCell className="text-[12.5px]">
                <OrderItemsAccessCell
                  access={m.userId ? orderItemsAccess?.get(m.userId) : undefined}
                  available={orderItemsAccess !== null}
                />
              </TableCell>
              <TableCell className={cn(ACTIONS_CELL, 'group-hover:bg-muted text-right')}>
                {m.userId ? (
                  <UserActionsMenu
                    userId={m.userId}
                    email={m.email}
                    disabledAt={m.disabledAt}
                    // COSMETIC ONLY — this decides whether the menu item is
                    // drawn, never whether the disable is allowed.
                    //
                    // It reads user_profiles.email, which is NOT the verified
                    // auth email the real gate uses: the service resolves the
                    // target's email from GoTrue (auth.admin.getUserById) and
                    // refuses a protected admin there. Resolving it here too
                    // would cost one GoTrue round-trip per row — up to
                    // DETAIL_PREVIEW_LIMIT (100) per render — and supabase-js
                    // offers no batched id→email lookup, so this tab reads the
                    // column instead and accepts a bounded inaccuracy:
                    //
                    //   * migration 0177 pins user_profiles.email against any
                    //     UPDATE, so a member cannot rewrite it to an
                    //     allowlisted address to make themselves look
                    //     protected — the escalation this guards against;
                    //   * the auth→profile sync (0001_init) is INSERT-only, so
                    //     the two can diverge if an auth email changes later.
                    //     No product flow changes an auth email today, and
                    //     GoTrue refuses to move one onto an address already
                    //     registered, so the reachable divergence is an
                    //     ex-admin whose profile still shows the old address:
                    //     Disable is wrongly HIDDEN, never wrongly permitted.
                    //
                    // The allowlist itself never crosses to the client — only
                    // this boolean does.
                    protectedAdmin={isPlatformAdmin(m.email)}
                    orderItemsAccess={orderItemsAccessTarget(
                      orgId,
                      m,
                      m.userId ? orderItemsAccess?.get(m.userId) : undefined,
                    )}
                  />
                ) : (
                  <span className="text-muted-foreground text-[12px]">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </PlatformTable>
      <p className="text-muted-foreground max-w-[760px] text-[12px] leading-relaxed">
        Last active is an estimate. A plain value is backed by something live: StockPilot reporting
        that the person had it open in this organization, or an open sign-in, which is accurate to
        about an hour and is per person, so it covers every device and every organization they
        belong to. A value prefixed “Signed in” or “Last action” is only the last evidence on
        record, so use after it may be missing. Hover a value for the exact times.
      </p>
    </div>
  );
}

async function OrdersTab({ orgId, timeZone }: { orgId: string; timeZone: string | null }) {
  const orders = await getOrgOrders(orgId);
  if (orders.length === 0)
    return <StatePanel kind="empty" headingLevel={null} title="No orders." />;
  return (
    <div className="flex flex-col gap-2">
      <PreviewTable
        label="Orders"
        minWidth={560}
        head={['Order', 'Status', 'Requester', 'Created']}
        headTitles={{ 3: orgZoneNote(timeZone) }}
        mono={[0]}
        rows={orders.map((o) => [
          o.id.slice(0, 8),
          o.status,
          o.requester ?? '—',
          formatDayInZone(o.createdAt, timeZone),
        ])}
      />
      <CapNote count={orders.length} />
    </div>
  );
}

async function BillingTab({ orgId }: { orgId: string }) {
  const b = await getOrgBillingState(orgId);
  if (!b) return <StatePanel kind="failed" headingLevel={null} title="Org not found." />;
  const tierName = b.effective.tier.charAt(0).toUpperCase() + b.effective.tier.slice(1);
  const effectiveLabel = b.arrangement !== 'standard' ? `${tierName} · ${b.arrangement}` : tierName;
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

/**
 * A read-only preview of one org's rows. `numeric` columns are right-aligned
 * (figures line up), `mono` columns print in the mono face (ids, SKUs,
 * quantities), and `headTitles` gives a column's header a tooltip (a date
 * column says whose zone it is in).
 */
function PreviewTable({
  label,
  minWidth,
  head,
  headTitles = {},
  rows,
  numeric = [],
  mono = [],
}: {
  label: string;
  minWidth: number;
  head: string[];
  headTitles?: Partial<Record<number, string>>;
  rows: string[][];
  numeric?: number[];
  mono?: number[];
}) {
  return (
    <PlatformTable label={label} minWidth={minWidth}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {head.map((h, j) => (
            <TableHead
              key={h}
              title={headTitles[j]}
              className={numeric.includes(j) ? 'text-right' : undefined}
            >
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            {r.map((c, j) => (
              <TableCell
                key={j}
                className={cn(
                  j === 0 ? 'text-foreground' : 'text-ink-2',
                  numeric.includes(j) && 'text-right tabular-nums',
                  mono.includes(j) && 'font-mono text-[12.5px]',
                )}
              >
                {c}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </PlatformTable>
  );
}

function CapNote({ count }: { count: number }) {
  if (count < DETAIL_PREVIEW_LIMIT) return null;
  return (
    <p className="text-muted-foreground text-[12.5px]">
      Showing the first {DETAIL_PREVIEW_LIMIT} (preview). Use &ldquo;Act as this org&rdquo; to see
      everything.
    </p>
  );
}
