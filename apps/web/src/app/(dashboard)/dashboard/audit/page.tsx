import { ScrollText } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Fragment } from 'react';

import { AUDIT_CATEGORIES } from '@/components/admin/audit-categories';
import { AuditTime } from '@/components/admin/audit-time';
import { diffMetadataFields, MetadataDiff } from '@/components/audit/metadata-diff';
import { FilterChipLink } from '@/components/patterns/chip';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader } from '@/components/patterns/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatAuditEvent, formatEntityType, shortId } from '@/lib/audit/format';
import { requireOrgContext } from '@/lib/auth/session';
import { effectiveNavLabel } from '@/lib/nav-labels';
import { auditActorName } from '@/lib/people/deleted-person-labels';
import { AuditLogService } from '@/server/services/audit-log';
import { ServiceError } from '@/server/services/context';

import { can } from '@stockpilot/core';

/**
 * THE org audit console — the ONE grantable audit surface.
 *
 * Consolidates the two previous pages (/dashboard/admin/audit and
 * /dashboard/settings/audit, both of which now redirect here) onto the
 * richer engine: AuditLogService (USER-authed client, so the
 * permission-driven audit_logs RLS from mig 0279 applies), structured
 * server-side filters + real pagination + metadata before/after diffs,
 * plus the category quick-chips the old admin console had.
 *
 * Gated on the EFFECTIVE activity_logs:read — manager+ by default,
 * grantable to viewers (Auditor preset) via the permission matrix.
 */

const PAGE_SIZE = 50;
const MAX_PAGE = 10_000;

interface SearchParams {
  /** Category quick-chip slug (see AUDIT_CATEGORIES) → event-prefix filter. */
  category?: string;
  event?: string;
  userId?: string;
  entityType?: string;
  /**
   * Filter by metadata.entity_id. Set when arriving from the
   * Recovery page's "View history" deep-link so the audit trail for
   * a single restored/archived row surfaces directly.
   */
  entityId?: string;
  since?: string;
  until?: string;
  page?: string;
}

function clampPage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.max(Math.floor(n), 1), MAX_PAGE);
}

function trim(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/** Build a query string preserving existing filters, overriding `page`. */
function buildPageHref(params: SearchParams, nextPage: number): string {
  const usp = new URLSearchParams();
  if (params.category) usp.set('category', params.category);
  if (params.event) usp.set('event', params.event);
  if (params.userId) usp.set('userId', params.userId);
  if (params.entityType) usp.set('entityType', params.entityType);
  if (params.entityId) usp.set('entityId', params.entityId);
  if (params.since) usp.set('since', params.since);
  if (params.until) usp.set('until', params.until);
  if (nextPage > 1) usp.set('page', String(nextPage));
  const qs = usp.toString();
  return qs ? `/dashboard/audit?${qs}` : '/dashboard/audit';
}

/** Href for switching category, preserving every other filter (page resets). */
function buildCategoryHref(params: SearchParams, slug: string): string {
  const usp = new URLSearchParams();
  if (slug !== 'all') usp.set('category', slug);
  if (params.event) usp.set('event', params.event);
  if (params.userId) usp.set('userId', params.userId);
  if (params.entityType) usp.set('entityType', params.entityType);
  if (params.entityId) usp.set('entityId', params.entityId);
  if (params.since) usp.set('since', params.since);
  if (params.until) usp.set('until', params.until);
  const qs = usp.toString();
  return qs ? `/dashboard/audit?${qs}` : '/dashboard/audit';
}

function actorInitials(name: string | null, email: string | null): string {
  const source = (name ?? email ?? '?').trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase() || '?';
  const last = parts[parts.length - 1] ?? '';
  const a = first[0] ?? '';
  const b = last[0] ?? '';
  return (a + b).toUpperCase() || '?';
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // Belt-and-suspenders: the service throws forbidden too, but bouncing at
  // the page level keeps direct-URL visits without the grant on the same
  // path every other read-gated page uses.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'activity_logs:read')) {
    redirect('/dashboard');
  }

  const params = await searchParams;
  // A Settings > Navigation rename of the sidebar entry reaches the heading
  // (no read of its own: the org row is cached for the request).
  const title = await effectiveNavLabel('/dashboard/audit', 'Audit log');
  const page = clampPage(params.page);
  const offset = (page - 1) * PAGE_SIZE;

  const activeCategory =
    AUDIT_CATEGORIES.find((c) => c.slug === (params.category ?? 'all'))?.slug ?? 'all';
  const eventPrefix = AUDIT_CATEGORIES.find((c) => c.slug === activeCategory)?.prefix ?? undefined;

  const filters = {
    event: trim(params.event),
    eventPrefix,
    userId: trim(params.userId),
    entityType: trim(params.entityType),
    entityId: trim(params.entityId),
    since: trim(params.since),
    until: trim(params.until),
    limit: PAGE_SIZE,
    offset,
  };

  let rows: Awaited<ReturnType<AuditLogService['list']>>['rows'] = [];
  let total = 0;
  try {
    const svc = await AuditLogService.forCurrentUser();
    const result = await svc.list(filters);
    rows = result.rows;
    total = result.total;
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'forbidden') redirect('/dashboard');
    throw err;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const hasActiveFilters = Boolean(
    eventPrefix ||
    filters.event ||
    filters.userId ||
    filters.entityType ||
    filters.since ||
    filters.until,
  );

  return (
    // Always a table, never cards, and no Export (the console has none; the
    // reference's Movements Export must not become a placeholder here).
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        title={title}
        titleId="audit-title"
        subline="Read-only record of every privileged action across the org — invites, role changes, stock adjustments, transfers."
      />

      <div className="flex flex-wrap items-center gap-2">
        {AUDIT_CATEGORIES.map((c) => {
          const isActive = c.slug === activeCategory;
          return (
            <FilterChipLink
              key={c.slug}
              href={buildCategoryHref(params, c.slug)}
              active={isActive}
              aria-current={isActive ? 'page' : undefined}
              size="md"
            >
              {c.label}
            </FilterChipLink>
          );
        })}
      </div>

      <DetailSection title="Filter">
        {/* method=GET so filters work without JS. The form re-submits to
            the same route with filters as query params; submitting also
            resets pagination by omitting `page`. The active category is
            carried through the hidden input so chips + fields compose. */}
        <form method="GET" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {activeCategory !== 'all' && (
            <input type="hidden" name="category" value={activeCategory} />
          )}
          <div className="space-y-1.5">
            <Label htmlFor="event">Event</Label>
            <Input
              id="event"
              name="event"
              placeholder="e.g. inventory.item.created"
              defaultValue={params.event ?? ''}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="userId">Actor (user id)</Label>
            <Input
              id="userId"
              name="userId"
              placeholder="UUID"
              defaultValue={params.userId ?? ''}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="entityType">Entity type</Label>
            <Input
              id="entityType"
              name="entityType"
              placeholder="e.g. inventory_item"
              defaultValue={params.entityType ?? ''}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="since">Since</Label>
            <Input id="since" name="since" type="date" defaultValue={params.since ?? ''} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="until">Until</Label>
            <Input id="until" name="until" type="date" defaultValue={params.until ?? ''} />
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" size="sm">
              Apply
            </Button>
            <Button asChild type="button" variant="outline" size="sm">
              <Link href="/dashboard/audit">Reset</Link>
            </Button>
          </div>
        </form>
      </DetailSection>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-[12.5px] tabular-nums">
          {total === 0
            ? 'No events'
            : `${total.toLocaleString()} event${total === 1 ? '' : 's'} · page ${page} of ${totalPages}`}
        </p>
        <Pager
          prevHref={hasPrev ? buildPageHref(params, page - 1) : null}
          nextHref={hasNext ? buildPageHref(params, page + 1) : null}
        />
      </div>

      {rows.length === 0 ? (
        hasActiveFilters ? (
          <EmptyState
            icon={ScrollText}
            title="No events match these filters"
            description="Try widening the date range or clearing filters to see more activity."
          />
        ) : (
          <EmptyState
            icon={ScrollText}
            title="No audit events yet"
            description="Privileged actions like invites, role changes, and stock adjustments get logged here automatically."
          />
        )
      ) : (
        // The ledger table (DESIGN-SPEC 6.9): it scrolls sideways inside its
        // card on a narrow screen instead of widening the page.
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <Table scrollLabelledBy="audit-title" className="min-w-[860px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const meta = row.metadata;
                const entityType = (meta.entity_type as string | null | undefined) ?? null;
                const entityId = (meta.entity_id as string | null | undefined) ?? null;
                const actorName = auditActorName(row);
                // Precomputed (rather than letting <MetadataDiff> decide
                // internally) so we know whether to render the extra diff
                // row at all — an always-rendered empty row would leave
                // stray padding on every event with no before/after or
                // changed_keys (most create-only events).
                const hasDiffContent =
                  diffMetadataFields(meta.before, meta.after).length > 0 ||
                  (Array.isArray(meta.changed_keys) && meta.changed_keys.length > 0);
                return (
                  <Fragment key={row.id}>
                    <TableRow
                      data-audit-row={row.id}
                      className={hasDiffContent ? 'border-b-0' : undefined}
                    >
                      <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                        <AuditTime iso={row.createdAt} />
                      </TableCell>
                      <TableCell className="min-w-[200px]">
                        <div className="flex items-center gap-2.5">
                          <Avatar className="h-7 w-7">
                            {row.actor?.avatarUrl ? (
                              <AvatarImage src={row.actor.avatarUrl} alt={actorName} />
                            ) : null}
                            <AvatarFallback>
                              {actorInitials(row.actor?.fullName ?? null, row.actor?.email ?? null)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="text-foreground truncate font-medium">{actorName}</div>
                            {row.actor?.email && row.actor.fullName ? (
                              <div className="text-muted-foreground truncate text-[12px]">
                                {row.actor.email}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-foreground">
                        {formatAuditEvent(row.event)}
                      </TableCell>
                      <TableCell className="text-[12.5px]">
                        {entityType ? (
                          <div className="space-y-0.5">
                            <div className="text-foreground font-medium">
                              {formatEntityType(entityType)}
                            </div>
                            {entityId ? (
                              <code
                                className="text-muted-foreground font-mono text-[11.5px]"
                                title={entityId}
                              >
                                {shortId(entityId)}
                              </code>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-[12px]">
                        {row.ip ?? '—'}
                      </TableCell>
                    </TableRow>
                    {hasDiffContent && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={5} className="pt-0">
                          <MetadataDiff metadata={meta} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-end">
        <Pager
          prevHref={hasPrev ? buildPageHref(params, page - 1) : null}
          nextHref={hasNext ? buildPageHref(params, page + 1) : null}
        />
      </div>
    </div>
  );
}

const DISABLED_PAGER = 'border-border text-ink-4 pointer-events-none bg-transparent';

function Pager({ prevHref, nextHref }: { prevHref: string | null; nextHref: string | null }) {
  // The pager recipe (DESIGN-SPEC 6.2): 28 px; a disabled end is quiet and
  // takes no clicks (aria-disabled, no pointer events), as before. 8 px apart,
  // the room the 44 px touch targets of two 28 px buttons need.
  return (
    <div className="flex items-center gap-2">
      <Button
        asChild
        variant="outline"
        size="sm"
        disabled={!prevHref}
        className={!prevHref ? DISABLED_PAGER : undefined}
      >
        <Link href={prevHref ?? '#'} aria-disabled={!prevHref}>
          ← Newer
        </Link>
      </Button>
      <Button
        asChild
        variant="outline"
        size="sm"
        disabled={!nextHref}
        className={!nextHref ? DISABLED_PAGER : undefined}
      >
        <Link href={nextHref ?? '#'} aria-disabled={!nextHref}>
          Older →
        </Link>
      </Button>
    </div>
  );
}
