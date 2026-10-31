import { ClipboardCheck, SearchX } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { CountProgressBar } from '@/components/cycle-counts/count-progress-bar';
import { CycleCountHistorySearch } from '@/components/cycle-counts/cycle-count-history-search';
import {
  CYCLE_COUNT_LIST_PATH,
  cycleCountListHref,
} from '@/components/cycle-counts/cycle-count-list-href';
import { RememberCycleCountListView } from '@/components/cycle-counts/cycle-count-list-memory';
import { CycleCountStatusBadge } from '@/components/cycle-counts/cycle-count-status-badge';
import { PageHeader } from '@/components/patterns/page-header';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { StatePanel } from '@/components/patterns/state-panel';
import { IntentLink } from '@/components/ui/intent-link';
import { Button } from '@/components/ui/button';
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
import { navLabelFromOverrides } from '@/lib/nav-labels';
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

/** The page area (DESIGN-SPEC 4 and 5.3): max 1320, 28 / 32 / 64 padding, a
 *  16 px gutter on a phone, 16 px between blocks. The same box the shell's
 *  loading skeleton draws. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** The table's edge cells pad 18 (DESIGN-SPEC 6.9, the count tables). */
const EDGE = 'first:pl-[18px] last:pr-[18px]';

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
    return <ModuleUnavailable moduleId="cycle_counts" access={moduleAccess} />;
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
  // Settings > Navigation can rename this destination; the heading follows the
  // sidebar and the crumb. A plain lookup on the org row read just above for
  // the time zone (no new read); without a rename it stays "Cycle counts".
  const heading = navLabelFromOverrides(
    orgRow?.nav_overrides ?? null,
    CYCLE_COUNT_LIST_PATH,
    'Cycle counts',
  );

  // Keep the URL, the page shown and the footer in agreement: a ?page= past
  // the end (a stale link, or a filter that shrank the list) or one that is
  // not a page number at all is replaced by the page actually rendered.
  const shownPageParam = result.page > 1 ? String(result.page) : undefined;
  if (sp.page !== undefined && firstParam(sp.page) !== shownPageParam) {
    redirect(cycleCountListHref({ q, status, page: result.page }));
  }

  const filtered = q !== '' || status !== null;
  const footer = formatListFooter({ ...result, itemCount: result.items.length }, NOUN);

  const pager = (
    <nav
      aria-label="Cycle count pages"
      className="flex flex-col gap-2 px-[18px] py-2.5 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-muted-foreground text-[12.5px] tabular-nums" aria-live="polite">
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
  );

  return (
    <div className={PAGE}>
      <RememberCycleCountListView q={q} status={status} page={result.page} />
      <PageHeader
        title={heading}
        titleId="cycle-counts-title"
        subline={
          // A reading width, so the start button keeps its place on the
          // title's line instead of wrapping under a full-width sentence.
          <span className="block max-w-[640px]">
            Recount stock against the system. Approving a count posts adjustments for every variance
            and brings inventory in line with what was counted.
          </span>
        }
        primaryAction={
          canStart ? (
            <Button asChild variant="gradient">
              <Link href="/dashboard/cycle-counts/new">+ Start a count</Link>
            </Button>
          ) : null
        }
      />

      {/* One wrapping row (DESIGN-SPEC 6.4 / 6.5): the status views on the
          left, the search on the right; on a phone each takes its own line. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <SegmentedTabs
          semantics="nav"
          aria-label="Filter by status"
          activeId={status ?? 'all'}
          items={[null, ...CYCLE_COUNT_STATUSES].map((s) => ({
            id: s ?? 'all',
            label: s ? CYCLE_COUNT_STATUS_LABELS[s] : 'All statuses',
            href: cycleCountListHref({ q, status: s, page: 1 }),
            prefetch: false,
          }))}
        />
        <CycleCountHistorySearch initialQuery={q} status={status} />
      </div>

      {/* One card for the list, whatever it holds: the table, or the empty or
          no-match state in its place, with the honest footer and the pager
          always at its foot. */}
      <div className="border-border bg-card min-w-0 overflow-hidden rounded-lg border">
        {result.total === 0 ? (
          filtered ? (
            <StatePanel
              kind="no-match"
              surface="plain"
              icon={SearchX}
              title="No counts match your search."
              description={
                q
                  ? 'Search looks at every count you can see: its number (CC-000042, CC-42 or 42), warehouse, and notes.'
                  : 'No cycle counts have this status.'
              }
              action={
                <Button asChild variant="outline">
                  <Link href={cycleCountListHref({})}>Clear search and filters</Link>
                </Button>
              }
            />
          ) : (
            <StatePanel
              kind="empty"
              surface="plain"
              icon={ClipboardCheck}
              title="No cycle counts yet"
              description="Start a count to snapshot expected quantities, then enter actuals as you walk the warehouse. We post the variance adjustments for you."
              action={
                canStart ? (
                  <Button asChild variant="gradient">
                    <Link href="/dashboard/cycle-counts/new">Start your first count</Link>
                  </Button>
                ) : undefined
              }
            />
          )
        ) : (
          <Table scrollLabelledBy="cycle-counts-title" className="min-w-[760px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={EDGE}>Count #</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assigned to</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className={`${EDGE} text-right`}>Completed</TableHead>
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
                    <TableCell className={`${EDGE} whitespace-nowrap`}>
                      <IntentLink
                        href={`/dashboard/cycle-counts/${c.id}`}
                        hoverDwellMs={0}
                        className="font-mono text-[13.5px] font-medium tabular-nums hover:underline"
                      >
                        {reference ?? (
                          <span className="text-muted-foreground font-sans text-[12.5px] font-normal">
                            {CYCLE_COUNT_REFERENCE_UNAVAILABLE}
                          </span>
                        )}
                      </IntentLink>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div>{formatRelative(c.startedAt)}</div>
                      <time dateTime={c.startedAt} className="text-muted-foreground text-[12px]">
                        {started}
                      </time>
                    </TableCell>
                    <TableCell className="text-ink-2">{cycleCountScopeLabel(c)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <CycleCountStatusBadge status={c.status} />
                      {c.status === 'in_progress' && c.lineTotal > 0 ? (
                        <div className="mt-1.5 w-[120px]">
                          <div className="text-muted-foreground text-[12px] tabular-nums">
                            {c.lineCounted.toLocaleString('en-US')} /{' '}
                            {c.lineTotal.toLocaleString('en-US')} counted
                          </div>
                          <CountProgressBar
                            counted={c.lineCounted}
                            total={c.lineTotal}
                            className="mt-1"
                          />
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-ink-2">
                      {c.assignedTo ? (c.assigneeName ?? '—') : '—'}
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground max-w-[260px] truncate text-[12.5px]"
                      title={c.notes ?? undefined}
                    >
                      {c.notes?.trim() ? c.notes : '—'}
                    </TableCell>
                    <TableCell
                      className={`${EDGE} text-muted-foreground whitespace-nowrap text-right text-[12.5px]`}
                    >
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
        )}
        <div className="border-border border-t">{pager}</div>
      </div>
    </div>
  );
}
