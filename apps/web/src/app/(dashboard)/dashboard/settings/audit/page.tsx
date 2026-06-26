import { ScrollText } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EmptyState } from '@/components/ui/empty-state';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { formatRelative } from '@/lib/utils';
import { AuditLogService } from '@/server/services/audit-log';
import { ServiceError } from '@/server/services/context';

import { can } from '@stockpilot/core';

const PAGE_SIZE = 50;
const MAX_PAGE = 10_000;

interface SearchParams {
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
  if (params.event) usp.set('event', params.event);
  if (params.userId) usp.set('userId', params.userId);
  if (params.entityType) usp.set('entityType', params.entityType);
  if (params.entityId) usp.set('entityId', params.entityId);
  if (params.since) usp.set('since', params.since);
  if (params.until) usp.set('until', params.until);
  if (nextPage > 1) usp.set('page', String(nextPage));
  const qs = usp.toString();
  return qs ? `/dashboard/settings/audit?${qs}` : '/dashboard/settings/audit';
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
  // Belt-and-suspenders: the service throws a ServiceError too, but
  // returning notFound() at the page level avoids a generic 500 for
  // non-admins who hand-edit the URL.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'activity_logs:read')) {
    notFound();
  }

  const params = await searchParams;
  const page = clampPage(params.page);
  const offset = (page - 1) * PAGE_SIZE;

  const filters = {
    event: trim(params.event),
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
    if (err instanceof ServiceError && err.code === 'forbidden') notFound();
    throw err;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const hasActiveFilters = Boolean(
    filters.event || filters.userId || filters.entityType || filters.since || filters.until,
  );

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every privileged action across the org. Admin-only.
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Filter</CardTitle>
        </CardHeader>
        <CardContent>
          {/* method=GET so filters work without JS. The form re-submits to
              the same route with filters as query params; submitting also
              resets pagination by omitting `page`. */}
          <form
            method="GET"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            <div className="space-y-1">
              <Label htmlFor="event">Event</Label>
              <Input
                id="event"
                name="event"
                placeholder="e.g. inventory.item.created"
                defaultValue={params.event ?? ''}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="userId">Actor (user id)</Label>
              <Input
                id="userId"
                name="userId"
                placeholder="UUID"
                defaultValue={params.userId ?? ''}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="entityType">Entity type</Label>
              <Input
                id="entityType"
                name="entityType"
                placeholder="e.g. inventory_item"
                defaultValue={params.entityType ?? ''}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="since">Since</Label>
              <Input
                id="since"
                name="since"
                type="date"
                defaultValue={params.since ?? ''}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="until">Until</Label>
              <Input
                id="until"
                name="until"
                type="date"
                defaultValue={params.until ?? ''}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button type="submit" size="sm">
                Apply
              </Button>
              <Button asChild type="button" variant="outline" size="sm">
                <Link href="/dashboard/settings/audit">Reset</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground tabular-nums">
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
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
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
                const actorName =
                  row.actor?.fullName ?? row.actor?.email ?? (row.actor ? 'Unknown' : 'System');
                return (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      <time
                        dateTime={row.createdAt}
                        title={new Date(row.createdAt).toLocaleString()}
                      >
                        {formatRelative(row.createdAt)}
                      </time>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar className="h-7 w-7">
                          {row.actor?.avatarUrl ? (
                            <AvatarImage src={row.actor.avatarUrl} alt={actorName} />
                          ) : null}
                          <AvatarFallback>
                            {actorInitials(row.actor?.fullName ?? null, row.actor?.email ?? null)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{actorName}</div>
                          {row.actor?.email && row.actor.fullName ? (
                            <div className="truncate text-[11px] text-muted-foreground">
                              {row.actor.email}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{formatAuditEvent(row.event)}</TableCell>
                    <TableCell className="text-xs">
                      {entityType ? (
                        <div className="space-y-0.5">
                          <div className="font-medium">{formatEntityType(entityType)}</div>
                          {entityId ? (
                            <code
                              className="font-mono text-[11px] text-muted-foreground"
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
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {row.ip ?? '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mt-4 flex items-center justify-end">
        <Pager
          prevHref={hasPrev ? buildPageHref(params, page - 1) : null}
          nextHref={hasNext ? buildPageHref(params, page + 1) : null}
        />
      </div>
    </div>
  );
}

function Pager({
  prevHref,
  nextHref,
}: {
  prevHref: string | null;
  nextHref: string | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button asChild variant="outline" size="sm" disabled={!prevHref}>
        <Link
          href={prevHref ?? '#'}
          aria-disabled={!prevHref}
          className={!prevHref ? 'pointer-events-none opacity-50' : ''}
        >
          ← Newer
        </Link>
      </Button>
      <Button asChild variant="outline" size="sm" disabled={!nextHref}>
        <Link
          href={nextHref ?? '#'}
          aria-disabled={!nextHref}
          className={!nextHref ? 'pointer-events-none opacity-50' : ''}
        >
          Older →
        </Link>
      </Button>
    </div>
  );
}
