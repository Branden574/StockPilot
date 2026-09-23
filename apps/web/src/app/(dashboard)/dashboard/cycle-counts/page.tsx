import { ClipboardCheck, SearchX } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { CycleCountHistorySearch } from '@/components/cycle-counts/cycle-count-history-search';
import { cycleCountListHref } from '@/components/cycle-counts/cycle-count-list-href';
import { RememberCycleCountListView } from '@/components/cycle-counts/cycle-count-list-memory';
import { EmptyState } from '@/components/ui/empty-state';
import { IntentLink } from '@/components/ui/intent-link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { formatRelative } from '@/lib/utils';

import {
  can,
  CYCLE_COUNT_REFERENCE_UNAVAILABLE,
  CYCLE_COUNT_STATUS_LABELS,
  CYCLE_COUNT_STATUSES,
  cycleCountScopeLabel,
  formatCycleCountNumber,
  formatListFooter,
  formatOrgDateTime,
  parseCycleCountStatusFilter,
  parsePageParam,
  resolveOrgTimezone,
} from '@stockpilot/core';

type ListSearchParams = {
  q?: string | string[];
  page?: string | string[];
  status?: string | string[];
};

const NOUN = { one: 'cycle count', other: 'cycle counts' };

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function CycleCountsPage({
  searchParams,
}: {
  searchParams?: Promise<ListSearchParams>;
}) {
  const moduleAccess = await checkModuleAccess('cycle_counts');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="cycle_counts" canManage={moduleAccess.canManage} />;
  }
  // Visibility gates on cycle_counts:read (staff+ by default, grantable to
  // viewers for read-only audit access). stock:adjust holders keep access
  // even if an org revokes the read perm from a role that can still count.
  // Writing (starting/entering/posting a count) stays gated on stock:adjust.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'cycle_counts:read') && !can(ctx, 'stock:adjust')) {
    redirect('/dashboard');
  }
  const canStart = can(ctx, 'stock:adjust');

  // The URL is the list's state: ?q= (search), ?status= (filter), ?page=.
  const sp = (await searchParams) ?? {};
  const q = (firstParam(sp.q) ?? '').trim();
  const status = parseCycleCountStatusFilter(firstParam(sp.status));
  const requestedPage = parsePageParam(firstParam(sp.page));

  const ccSvc = await CycleCountsService.forCurrentUser();
  const [result, orgRow] = await Promise.all([
    ccSvc.listPage({ q, status, page: requestedPage }),
    getOrgRowForRequest(ctx.organizationId),
  ]);
  const tz = resolveOrgTimezone(orgRow?.timezone);

  // Keep the URL, the page shown and the footer in agreement: a ?page= past
  // the end (a stale link, or a filter that shrank the list) or one that is
  // not a page number at all is replaced by the page actually rendered.
  const shownPageParam = result.page > 1 ? String(result.page) : undefined;
  if (sp.page !== undefined && firstParam(sp.page) !== shownPageParam) {
    redirect(cycleCountListHref({ q, status, page: result.page }));
  }

  const filtered = q !== '' || status !== null;
  const footer = formatListFooter({ ...result, itemCount: result.items.length }, NOUN);

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <RememberCycleCountListView q={q} status={status} page={result.page} />
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cycle counts</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Recount stock against the system. Approving a count posts adjustments
            for every variance and brings inventory in line with what was counted.
          </p>
        </div>
        {canStart && (
          <Button asChild variant="gradient">
            <Link href="/dashboard/cycle-counts/new">+ Start a count</Link>
          </Button>
        )}
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <CycleCountHistorySearch initialQuery={q} status={status} />
        <nav aria-label="Filter by status" className="flex flex-wrap gap-1">
          {[null, ...CYCLE_COUNT_STATUSES].map((s) => {
            const active = s === status;
            return (
              <Link
                key={s ?? 'all'}
                href={cycleCountListHref({ q, status: s, page: 1 })}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'bg-foreground text-background rounded-md px-2.5 py-1.5 text-xs font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted rounded-md px-2.5 py-1.5 text-xs font-medium'
                }
              >
                {s ? CYCLE_COUNT_STATUS_LABELS[s] : 'All statuses'}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="mt-4">
        {result.total === 0 ? (
          filtered ? (
            <EmptyState
              icon={SearchX}
              title="No counts match your search."
              description={
                q
                  ? 'Search looks at every count you can see: its number (CC-000042, CC-42 or 42), warehouse, and notes.'
                  : 'No cycle counts have this status.'
              }
              cta={{ label: 'Clear search and filters', href: cycleCountListHref({}) }}
            />
          ) : (
            <EmptyState
              icon={ClipboardCheck}
              title="No cycle counts yet"
              description="Start a count to snapshot expected quantities, then enter actuals as you walk the warehouse. We post the variance adjustments for you."
              cta={
                canStart
                  ? { label: 'Start your first count', href: '/dashboard/cycle-counts/new' }
                  : undefined
              }
            />
          )
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Count #</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assigned to</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.map((c) => {
                  const reference = formatCycleCountNumber(c.countNumber);
                  const started = formatOrgDateTime(
                    c.startedAt,
                    { dateStyle: 'medium', timeStyle: 'short' },
                    tz,
                  );
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="whitespace-nowrap">
                        <IntentLink
                          href={`/dashboard/cycle-counts/${c.id}`}
                          hoverDwellMs={0}
                          className="font-mono text-sm font-semibold tabular-nums hover:underline"
                        >
                          {reference ?? (
                            <span className="text-muted-foreground font-sans text-xs font-normal">
                              {CYCLE_COUNT_REFERENCE_UNAVAILABLE}
                            </span>
                          )}
                        </IntentLink>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div className="text-sm">{formatRelative(c.startedAt)}</div>
                        <time dateTime={c.startedAt} className="text-muted-foreground text-xs">
                          {started}
                        </time>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {cycleCountScopeLabel(c)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <StatusBadge status={c.status} />
                        {c.status === 'in_progress' && c.lineTotal > 0 ? (
                          <div className="text-muted-foreground mt-1 text-xs tabular-nums">
                            {c.lineCounted.toLocaleString('en-US')} / {c.lineTotal.toLocaleString('en-US')} counted
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {c.assignedTo ? (c.assigneeName ?? '—') : '—'}
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground max-w-[260px] truncate text-xs"
                        title={c.notes ?? undefined}
                      >
                        {c.notes?.trim() ? c.notes : '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs">
                        {c.completedAt ? (
                          <time
                            dateTime={c.completedAt}
                            title={formatOrgDateTime(
                              c.completedAt,
                              { dateStyle: 'medium', timeStyle: 'short' },
                              tz,
                            )}
                          >
                            {formatRelative(c.completedAt)}
                          </time>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <nav
          aria-label="Cycle count pages"
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-muted-foreground text-xs tabular-nums" aria-live="polite">
            {footer}
          </p>
          <div className="flex gap-2">
            {result.hasPrevious ? (
              <Button asChild variant="outline" size="sm">
                <Link
                  href={cycleCountListHref({ q, status, page: result.page - 1 })}
                  prefetch={false}
                  rel="prev"
                >
                  Previous
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Previous
              </Button>
            )}
            {result.hasNext ? (
              <Button asChild variant="outline" size="sm">
                <Link
                  href={cycleCountListHref({ q, status, page: result.page + 1 })}
                  prefetch={false}
                  rel="next"
                >
                  Next
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Next
              </Button>
            )}
          </div>
        </nav>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'in_progress')
    return <Badge variant="warning">In progress</Badge>;
  if (status === 'completed')
    return <Badge variant="success">Completed</Badge>;
  if (status === 'canceled')
    return <Badge variant="destructive">Canceled</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}
