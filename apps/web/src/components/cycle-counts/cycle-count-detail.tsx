'use client';

import { Loader2, Search, TriangleAlert, UserCircle2, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  CYCLE_COUNT_MANAGER_POSTS_COPY,
  cycleCountCloseGate,
  offlineCaptureLabel,
  variantLabel,
  type Role,
} from '@stockpilot/core';

import { CountProgressBar } from '@/components/cycle-counts/count-progress-bar';
import { CycleCountStatusBadge } from '@/components/cycle-counts/cycle-count-status-badge';
import { HelpTip } from '@/components/onboarding/help-tip';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { StatePanel } from '@/components/patterns/state-panel';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { Button, buttonVariants } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn, formatNumber } from '@/lib/utils';
import {
  assignCycleCountAction,
  cancelCycleCountAction,
  clearCycleCountLineAction,
  postCycleCountAction,
  recordCycleCountLineAction,
} from '@/server/actions/cycle-counts';

import type {
  CycleCountLineFilter,
  CycleCountLineWithItem,
  CycleCountRow,
  CycleCountSummary,
} from '@/server/services/cycle-counts';

interface Member {
  id: string;
  name: string;
  email: string;
}

interface Props {
  header: CycleCountRow;
  /** ONE server-paginated + searched + filtered page of lines. */
  lines: CycleCountLineWithItem[];
  /** Whole-count roll-up (every line) — the stat cards + post dialog read
      this instead of deriving from the page, which only holds pageSize
      lines now. */
  summary: CycleCountSummary;
  /** 1-based page ACTUALLY RENDERED — the server's effective page, which
      getDetailPage clamps to the real last page when the URL's ?page= is
      past the end (e.g. after counting the last `uncounted` line,
      router.refresh() re-requests a now-empty window). Never derive this
      from the URL param. */
  page: number;
  pageSize: number;
  /** Filtered total (matches search + filter) — drives the page controls. */
  total: number;
  /** Current server-side search term (from ?q). */
  search: string;
  /** Current server-side filter (from ?filter). */
  filter: CycleCountLineFilter;
  /** Whether the current user has cycle_counts:assign (manager / admin /
      owner). When false, the AssigneePicker renders read-only. */
  canAssign?: boolean;
  /** Whether the current user holds stock:adjust. When false (a read-only
      grantee of cycle_counts:read), EVERY write affordance disappears —
      count-entry inputs, clear buttons, cancel, and post — and the page is a
      genuinely read-only view of the count. Defaults to false (fail closed);
      the server page passes the real value. */
  canAdjust?: boolean;
  /** Org members eligible for assignment. Only populated when
      `canAssign` is true. */
  members?: Member[];
  /** Display name of the current assignee, resolved server-side so the
      read-only badge has a name to show. */
  assigneeName?: string | null;
  /** Live count of items in scope right now (org-active items in the
      session's warehouse). When this exceeds the snapshot line total, new
      items were added after start() — surfaced as a warning so the counter
      can decide to cancel + restart. */
  itemsInScopeCount?: number;
  /** The organization's IANA timezone, for the offline capture time a line
      shows in review (0369). */
  timeZone?: string;
  /** The reader's role in this org. Post and Cancel follow core
      cycleCountCloseGate (manager or above with stock:adjust; Cancel also
      cycle_counts:assign), the rule ledger.post_cycle_count and the
      cycle_counts UPDATE policy apply. Defaults to viewer (fail closed). */
  role?: Role;
  /** The exceptions a recount linked to this count: the server page streams
      its LinkedExceptionsBlock here (inside its own Suspense), so the count
      never waits for it. Shown in the side rail beside the count. */
  linkedExceptions?: React.ReactNode;
}

/** The count tables' edge cells pad 18 (DESIGN-SPEC 6.9). */
const EDGE = 'first:pl-[18px] last:pr-[18px]';

/** The line filters, in the order they always had. */
const LINE_FILTERS: Array<{ id: CycleCountLineFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'uncounted', label: 'Uncounted' },
  { id: 'variance', label: 'Variance' },
];

/**
 * One cycle count (DESIGN-SPEC 7.7, the reference's count card), laid out as
 * the four whole-count figures, then the count itself beside a rail for who it
 * is assigned to and the exceptions a recount linked to it.
 *
 * ENTRY and POSTING stay two separate steps with different people and gates:
 * a counter records lines here (each one saves on its own), and a manager
 * reviews the variances and posts them, or cancels, only through the
 * confirmations below. Nothing on this page posts stock directly.
 */
export function CycleCountDetail({
  header,
  lines,
  summary,
  page,
  pageSize,
  total,
  search,
  filter,
  canAssign = false,
  canAdjust = false,
  members = [],
  assigneeName = null,
  itemsInScopeCount,
  timeZone,
  role = 'viewer',
  linkedExceptions,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [busyLine, setBusyLine] = React.useState<string | null>(null);
  // Which line's last write FAILED, and why. A toast alone is a silent
  // failure (recurring pattern #20): it renders bottom-right, auto-dismisses
  // in ~4s, and a counter working down 200 rows never sees it — so the row
  // itself has to say so, inline, until the next attempt.
  const [lineError, setLineError] = React.useState<{ id: string; message: string } | null>(null);
  const [postBusy, setPostBusy] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelBusy, setCancelBusy] = React.useState(false);
  // Why the last post or cancel was refused, said INSIDE the open dialog as
  // well as in the toast: the dialog stays open on a refusal, and a toast is
  // gone in seconds (the post refusals carry the instruction to act on, such
  // as "Clear and recount that line"). Cleared on each open and each try.
  const [postError, setPostError] = React.useState<string | null>(null);
  const [cancelError, setCancelError] = React.useState<string | null>(null);

  const completed = header.status === 'completed';
  const canceled = header.status === 'canceled';
  const open = header.status === 'in_progress';
  // WHO MAY POST OR CANCEL (F1-2): the ONE predicate the phone and the
  // service use too. Staff hold stock:adjust and count, but the post and the
  // cancel are manager-only in the database, so offering them the buttons
  // only led to a refusal. They see who does it instead.
  const { canPost, canCancel } = cycleCountCloseGate({ role, canAdjust, canAssign });

  // Search + filter + pagination are ALL server-side now (a >1000-SKU count
  // can't ship every line to the client). Build the target URL for a given
  // {q, filter, page}, preserving the params we're not changing.
  const buildHref = React.useCallback(
    (overrides: { q?: string; filter?: CycleCountLineFilter; page?: number }) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '');
      if ('q' in overrides) {
        if (overrides.q) params.set('q', overrides.q);
        else params.delete('q');
      }
      if ('filter' in overrides) {
        if (overrides.filter && overrides.filter !== 'all') params.set('filter', overrides.filter);
        else params.delete('filter');
      }
      if ('page' in overrides) {
        if (overrides.page && overrides.page > 1) params.set('page', String(overrides.page));
        else params.delete('page');
      }
      const qs = params.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [pathname, searchParams],
  );

  // Debounced search box: local input, pushed to ?q (resetting to page 1)
  // 350ms after the user stops typing. Re-sync to the server value whenever
  // it changes (e.g. after a router.refresh from saving a count).
  const [searchInput, setSearchInput] = React.useState(search);
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resync to server value
    setSearchInput(search);
  }, [search]);
  React.useEffect(() => {
    if (searchInput === search) return;
    const t = setTimeout(() => {
      router.push(buildHref({ q: searchInput, page: 1 }));
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput, search, buildHref, router]);

  function changeFilter(next: CycleCountLineFilter) {
    if (next === filter) return;
    router.push(buildHref({ filter: next, page: 1 }));
  }

  // Whole-count summary (server-computed set-based).
  const uncounted = summary.total - summary.counted;
  const totalDelta = summary.netDelta;
  const signedDelta = `${totalDelta > 0 ? '+' : ''}${formatNumber(totalDelta)}`;

  // New-items-added warning. If the snapshot has fewer lines than the
  // current items-in-scope count, someone added items to inventory
  // after the count was started. They won't be in the snapshot and
  // won't be counted/adjusted by post(). Surface the gap so the
  // counter can decide to cancel + restart.
  const newItemsCount =
    open && typeof itemsInScopeCount === 'number'
      ? Math.max(0, itemsInScopeCount - summary.total)
      : 0;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // `page` is already the server-clamped effective page; this min/max is
  // defense-in-depth only, so Prev/Next hrefs can never leave the range.
  const safePage = Math.min(Math.max(1, page), totalPages);

  // Browser-leave guard for in-progress counts with unsaved input.
  // We can't directly observe Input draft state from here, so we
  // gate on "open + any line still uncounted" — the user came to the
  // page to count and there's still work pending. Closed counts never
  // arm the listener, and read-only visitors (no stock:adjust) can't
  // have unsaved input to lose.
  const hasPendingWork = open && canAdjust && uncounted > 0;
  React.useEffect(() => {
    if (!hasPendingWork) return;
    const handler = (e: BeforeUnloadEvent) => {
      // Standard pattern: setReturnValue + return string. Browsers
      // ignore the message and show their own dialog, but they
      // require one of the two to trigger the dialog at all.
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasPendingWork]);

  // Both line writes return whether the value LANDED. The row owns a draft
  // that resyncs only from `line.counted_quantity`; when a write fails that
  // prop never changes, so the row must be told to put the server's value
  // back — otherwise the box keeps an unsaved number and renders a variance
  // that looks exactly like a saved line while the DB still says uncounted.
  async function saveCount(line: CycleCountLineWithItem, raw: string): Promise<boolean> {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      const message = 'Enter a non-negative number.';
      toast.error(message);
      setLineError({ id: line.id, message });
      return false;
    }
    setLineError((prev) => (prev?.id === line.id ? null : prev));
    setBusyLine(line.id);
    const r = await recordCycleCountLineAction({
      cycleCountId: header.id,
      lineId: line.id,
      countedQuantity: value,
    });
    setBusyLine(null);
    if (!r.ok) {
      toast.error(r.error.message);
      setLineError({ id: line.id, message: r.error.message });
      // Refresh on failure too: the usual cause is that the count moved out
      // from under this session (reassigned to someone else, or cancelled),
      // and re-rendering turns the page read-only instead of letting the
      // counter keep typing into rows the server will never accept.
      router.refresh();
      return false;
    }
    router.refresh();
    return true;
  }

  async function clearLine(line: CycleCountLineWithItem): Promise<boolean> {
    setLineError((prev) => (prev?.id === line.id ? null : prev));
    setBusyLine(line.id);
    const r = await clearCycleCountLineAction({
      cycleCountId: header.id,
      lineId: line.id,
    });
    setBusyLine(null);
    if (!r.ok) {
      toast.error(r.error.message);
      setLineError({ id: line.id, message: r.error.message });
      router.refresh();
      return false;
    }
    router.refresh();
    return true;
  }

  async function confirmCancel() {
    setCancelBusy(true);
    setCancelError(null);
    const r = await cancelCycleCountAction(header.id);
    setCancelBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      setCancelError(r.error.message);
      return;
    }
    setCancelOpen(false);
    toast.success('Cycle count cancelled.');
    router.refresh();
  }

  async function post() {
    setPostBusy(true);
    setPostError(null);
    const r = await postCycleCountAction(header.id);
    setPostBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      setPostError(r.error.message);
      return;
    }
    setConfirmOpen(false);
    toast.success(
      summary.varianceCount === 0
        ? 'Cycle count posted. No adjustments needed.'
        : `Cycle count posted. ${summary.varianceCount} adjustment${summary.varianceCount === 1 ? '' : 's'} applied.`,
    );
    router.refresh();
  }

  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      {/* The four whole-count figures (never the page's), the reference's
          count progress drawn under Counted. */}
      <StatStrip variant="detail">
        <StatStripItem
          size="detail"
          label="Items in scope"
          value={formatNumber(summary.total)}
          data-testid="count-stat-in-scope"
        />
        <StatStripItem
          size="detail"
          label="Counted"
          value={formatNumber(summary.counted)}
          sub={
            <CountProgressBar
              counted={summary.counted}
              total={summary.total}
              className="mb-1 mt-2 max-w-[180px]"
            />
          }
          data-testid="count-stat-counted"
        />
        <StatStripItem
          size="detail"
          label="Uncounted"
          value={formatNumber(uncounted)}
          valueTone={uncounted > 0 ? 'warning' : 'default'}
          data-testid="count-stat-uncounted"
        />
        <StatStripItem
          size="detail"
          label="Net variance"
          value={signedDelta}
          valueTone={totalDelta !== 0 ? 'warning' : 'default'}
          data-testid="count-stat-net-variance"
        />
      </StatStrip>

      {/* The count beside its rail (DESIGN-SPEC 7.7: 1.7fr / minmax(260px,1fr)),
          stacked when the page area is narrower than two 420 px columns. The
          rail comes first in reading order, as the assignee and the linked
          exceptions always came before the lines. */}
      <div className="@min-[856px]:grid-cols-[minmax(0,1.7fr)_minmax(260px,1fr)] grid min-w-0 grid-cols-1 items-start gap-4">
        <div className="@min-[856px]:col-start-2 @min-[856px]:row-start-1 flex min-w-0 flex-col gap-4">
          <AssigneePicker
            cycleCountId={header.id}
            currentAssignedTo={header.assigned_to}
            currentAssigneeName={assigneeName}
            canAssign={canAssign && open}
            members={members}
          />
          {linkedExceptions}
        </div>

        <div className="@min-[856px]:col-start-1 @min-[856px]:row-start-1 flex min-w-0 flex-col gap-4">
          {newItemsCount > 0 && (
            <div className="bg-warning-wash text-warning flex items-start gap-2.5 rounded-lg px-[18px] py-3 text-[13px] leading-5">
              <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                {newItemsCount} new item{newItemsCount === 1 ? '' : 's'} were added to this scope
                after the count started. They are not in this snapshot and will not be adjusted by
                posting. Cancel and restart the count if you&apos;d like to include them.
              </p>
            </div>
          )}

          <div className="border-border bg-card min-w-0 overflow-hidden rounded-lg border">
            {/* Status and who acts next: Cancel and Review & post for a
                manager, the sentence for staff who count but do not post. */}
            <div className="border-border flex min-h-[49px] flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-[18px] py-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                <CycleCountStatusBadge status={header.status} />
                <span className="text-muted-foreground text-[12.5px] tabular-nums">
                  {formatNumber(summary.counted)} of {formatNumber(summary.total)} counted ·{' '}
                  {formatNumber(summary.varianceCount)} with variance
                </span>
              </div>
              {open && (canPost || canCancel) && (
                <div className="flex flex-wrap items-center gap-2">
                  {canCancel && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setCancelError(null);
                        setCancelOpen(true);
                      }}
                      disabled={postBusy}
                    >
                      Cancel count
                    </Button>
                  )}
                  {canPost && (
                    <Button
                      size="sm"
                      onClick={() => {
                        setPostError(null);
                        setConfirmOpen(true);
                      }}
                      disabled={postBusy || summary.counted === 0}
                    >
                      Review & post
                    </Button>
                  )}
                </div>
              )}
              {open && canAdjust && !canPost && (
                <span className="text-muted-foreground text-[12.5px]" data-testid="manager-posts">
                  {CYCLE_COUNT_MANAGER_POSTS_COPY}
                </span>
              )}
            </div>

            {/* Line search and the All / Uncounted / Variance views: both
                server-side, in the URL (?q, ?filter), back to page 1. */}
            <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-[18px] py-2.5">
              <div className="relative w-full sm:w-[280px]">
                <Search
                  aria-hidden
                  className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
                  strokeWidth={1.8}
                />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search by name, SKU, barcode…"
                  className="pl-8"
                />
              </div>
              <SegmentedTabs
                semantics="nav"
                size="sm"
                aria-label="Filter lines"
                activeId={filter}
                items={LINE_FILTERS}
                onSelect={(id) => {
                  const next = LINE_FILTERS.find((f) => f.id === id);
                  if (next) changeFilter(next.id);
                }}
              />
            </div>

            <Table className="min-w-[600px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={EDGE}>Item</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">
                    <span className="inline-flex items-center gap-1.5">
                      Expected
                      <HelpTip label="the Expected quantity">
                        <p>
                          The system quantity when the line was counted (the quantity at session
                          start until then). Variance is counted minus expected, and posting applies
                          that variance on top of the current stock — stock that moved after a line
                          was counted is kept, never counted twice.
                        </p>
                      </HelpTip>
                    </span>
                  </TableHead>
                  <TableHead className="text-right">Counted</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead className={cn(EDGE, 'w-12')} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={6} className="p-0">
                      <StatePanel
                        kind={summary.total === 0 ? 'empty' : 'no-match'}
                        surface="plain"
                        icon={null}
                        headingLevel={null}
                        title={
                          summary.total === 0
                            ? 'No items in this count.'
                            : 'No items match the current search or filter.'
                        }
                      />
                    </TableCell>
                  </TableRow>
                )}
                {lines.map((l) => (
                  <CountRow
                    key={l.id}
                    line={l}
                    disabled={!open || !canAdjust}
                    readOnly={!canAdjust}
                    busy={busyLine === l.id}
                    error={lineError?.id === l.id ? lineError.message : null}
                    onSave={(value) => saveCount(l, value)}
                    onClear={() => clearLine(l)}
                    timeZone={timeZone}
                  />
                ))}
              </TableBody>
            </Table>

            {totalPages > 1 && (
              <div className="border-border text-muted-foreground flex flex-wrap items-center justify-between gap-3 border-t px-[18px] py-2.5 text-[12.5px]">
                <span className="tabular-nums">
                  Showing{' '}
                  <span className="text-foreground font-medium">
                    {formatNumber((safePage - 1) * pageSize + 1)}
                  </span>
                  –
                  <span className="text-foreground font-medium">
                    {formatNumber(Math.min(safePage * pageSize, total))}
                  </span>{' '}
                  of <span className="text-foreground font-medium">{formatNumber(total)}</span>
                </span>
                <div className="flex items-center gap-2">
                  {safePage <= 1 ? (
                    <span
                      aria-disabled
                      className={buttonVariants({
                        variant: 'outline',
                        size: 'sm',
                        className: 'pointer-events-none opacity-50',
                      })}
                    >
                      ← Prev
                    </span>
                  ) : (
                    <Button asChild variant="outline" size="sm">
                      <Link href={buildHref({ page: safePage - 1 })} prefetch={false}>
                        ← Prev
                      </Link>
                    </Button>
                  )}
                  <span className="px-1 text-[12px] tabular-nums">
                    Page {safePage} of {totalPages}
                  </span>
                  {safePage >= totalPages ? (
                    <span
                      aria-disabled
                      className={buttonVariants({
                        variant: 'outline',
                        size: 'sm',
                        className: 'pointer-events-none opacity-50',
                      })}
                    >
                      Next →
                    </span>
                  ) : (
                    <Button asChild variant="outline" size="sm">
                      <Link href={buildHref({ page: safePage + 1 })} prefetch={false}>
                        Next →
                      </Link>
                    </Button>
                  )}
                </div>
              </div>
            )}

            {(completed || canceled) && (
              <p className="border-border text-muted-foreground border-t px-[18px] py-3 text-[12.5px]">
                This count is {completed ? 'completed' : 'canceled'}. Lines are read-only.
              </p>
            )}
            {open && !canAdjust && (
              <p className="border-border text-muted-foreground border-t px-[18px] py-3 text-[12.5px]">
                You have view-only access to this count. Entering quantities and posting adjustments
                require the stock adjustment permission.
              </p>
            )}
          </div>
        </div>
      </div>

      {canCancel && (
        <DestructiveConfirm
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          title="Cancel this cycle count?"
          description="No adjustments will be posted. Any quantities you've entered are kept on the canceled count for the audit trail but stock levels are unchanged."
          confirmLabel="Cancel count"
          cancelLabel="Keep counting"
          pending={cancelBusy}
          error={cancelError}
          onConfirm={confirmCancel}
        />
      )}

      {canPost && (
        <Dialog open={confirmOpen} onOpenChange={(o) => !postBusy && setConfirmOpen(o)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Post this count?</DialogTitle>
              <DialogDescription asChild>
                <div className="text-muted-foreground space-y-3 pt-1 text-[13.5px] leading-[20.25px]">
                  <p>
                    This will post{' '}
                    <strong className="text-foreground font-medium">
                      {formatNumber(summary.varianceCount)}
                    </strong>{' '}
                    adjustment{summary.varianceCount === 1 ? '' : 's'} (net{' '}
                    <strong className="text-foreground font-medium">
                      {totalDelta > 0 ? '+' : ''}
                      {formatNumber(totalDelta)}
                    </strong>{' '}
                    units). Each line moves stock by counted minus the system quantity at the time
                    it was counted; stock that moved after a line was counted is kept.
                  </p>
                  {uncounted > 0 && (
                    <p className="bg-warning-wash text-warning rounded-md px-3 py-2">
                      {formatNumber(uncounted)} item{uncounted === 1 ? '' : 's'} weren&apos;t
                      counted — they&apos;ll be left unchanged.
                    </p>
                  )}
                  <p className="text-[12px] leading-[18px]">
                    Stock movements are recorded as{' '}
                    <code className="bg-sunk rounded px-1 font-mono text-[11.5px]">adjust</code>{' '}
                    with reason &quot;Cycle count adjustment&quot;. This is irreversible — but you
                    can create a corrective adjustment afterwards if needed.
                  </p>
                </div>
              </DialogDescription>
            </DialogHeader>
            {postError ? (
              <p role="alert" className="text-destructive text-[13px]">
                {postError}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={postBusy}>
                Back
              </Button>
              <Button onClick={post} disabled={postBusy}>
                {postBusy ? (
                  <>
                    <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                    <span className="sr-only">Post adjustments</span>
                  </>
                ) : (
                  'Post adjustments'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function CountRow({
  line,
  disabled,
  readOnly = false,
  busy,
  error = null,
  onSave,
  onClear,
  timeZone,
}: {
  line: CycleCountLineWithItem;
  disabled: boolean;
  /** Read-only visitor (no stock:adjust): render the counted quantity as
      plain text instead of a (disabled) entry input — no write affordances
      at all. */
  readOnly?: boolean;
  busy: boolean;
  /** Message from this row's last FAILED write, rendered inline under the
      input. Null once the next attempt starts. */
  error?: string | null;
  /** Resolve TRUE only when the value actually landed in the DB. A false
      result makes the row put the server's value back in the box. */
  onSave: (value: string) => Promise<boolean>;
  onClear: () => Promise<boolean>;
  /** Organization timezone for the offline capture label. */
  timeZone?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [draft, setDraft] = React.useState<string>(
    line.counted_quantity != null ? String(line.counted_quantity) : '',
  );

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived value, not state
    setDraft(line.counted_quantity != null ? String(line.counted_quantity) : '');
  }, [line.counted_quantity]);

  // A FAILED write leaves the box holding a number the DB never accepted —
  // and because the resync effect above is keyed on `line.counted_quantity`,
  // which did NOT change, nothing else will ever put it right. The row would
  // keep showing e.g. "7" with a red "-3" variance, identical to a saved
  // line, while the header stats and post() both treat the line as uncounted.
  // So on failure we snap the box back to the server's value ourselves.
  function revertDraftToServerValue() {
    // …unless the user has already clicked back into this box and started
    // re-typing while the action was in flight — never yank live input.
    if (inputRef.current && document.activeElement === inputRef.current) return;
    setDraft(line.counted_quantity != null ? String(line.counted_quantity) : '');
  }

  // Track the value currently IN the box (the draft), not just the saved
  // count — so an empty box reads as "uncounted" (variance —) instead of
  // showing the stale saved variance after you clear it. A counted 0 still
  // shows its variance because draft is "0", not "".
  const trimmedDraft = draft.trim();
  const draftNum = trimmedDraft === '' ? NaN : Number(trimmedDraft);
  const effectiveCounted = Number.isFinite(draftNum) ? draftNum : null;
  const variance = effectiveCounted != null ? effectiveCounted - line.expected_quantity : null;
  const variantText = variantLabel({
    jerseyNumber: line.item?.jersey_number ?? null,
    size: line.item?.variant_size ?? null,
  });
  // A count queued offline and synced later was measured against the book at
  // the moment it was taken (0369). Whoever reviews and posts sees when.
  const capturedText = line.counted_quantity != null ? offlineCaptureLabel(line, timeZone) : null;

  return (
    <TableRow>
      <TableCell className={cn(EDGE, 'min-w-[160px] max-w-[320px]')}>
        <div className="font-medium [overflow-wrap:anywhere]">{line.item?.name ?? 'Unknown'}</div>
        {/* WHICH VARIANT this row is. Six sizes of one shoe otherwise differ
            only by SKU, and a counter matching hex strings to shoeboxes puts
            the 10s in the 10.5 row. Renders nothing for an ungrouped item, so
            a non-sports count looks exactly as it did before. */}
        {variantText && (
          <div className="text-muted-foreground truncate text-[12px]">{variantText}</div>
        )}
        {line.item?.barcode && (
          <div className="text-muted-foreground truncate font-mono text-[11.5px]">
            {line.item.barcode}
          </div>
        )}
        {capturedText && (
          <div className="text-muted-foreground truncate text-[12px]">{capturedText}</div>
        )}
      </TableCell>
      <TableCell className="text-ink-2 whitespace-nowrap font-mono text-[12.5px]">
        {line.item?.sku ?? '—'}
      </TableCell>
      <TableCell className="text-muted-foreground text-right font-mono text-[13.5px] tabular-nums">
        {formatNumber(line.expected_quantity)}
      </TableCell>
      <TableCell className="text-right">
        {readOnly ? (
          <span className="font-mono text-[13.5px] tabular-nums">
            {line.counted_quantity != null ? formatNumber(line.counted_quantity) : '—'}
          </span>
        ) : (
          <>
            <Input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={async () => {
                if (disabled) return;
                const trimmed = draft.trim();
                const current = line.counted_quantity;
                if (trimmed === '') {
                  // Emptying the box uncounts the line (clears the variance too),
                  // but only when it actually had a saved value to clear.
                  if (current != null && !(await onClear())) revertDraftToServerValue();
                  return;
                }
                const next = Number(trimmed);
                if (Number.isFinite(next) && next !== current) {
                  if (!(await onSave(trimmed))) revertDraftToServerValue();
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              placeholder="—"
              inputMode="decimal"
              disabled={disabled || busy}
              className="bg-sunk ml-auto w-[90px] px-2 text-right font-mono tabular-nums"
            />
            {/* Persistent inline failure notice. The toast is bottom-right and
                gone in 4s; the counter is looking at THIS row. */}
            {error && (
              <p role="alert" className="text-destructive ml-auto mt-1 max-w-[220px] text-[12px]">
                {error}
              </p>
            )}
          </>
        )}
      </TableCell>
      <TableCell
        className={cn(
          'text-right font-mono text-[13.5px] tabular-nums',
          variance == null
            ? 'text-muted-foreground'
            : variance > 0
              ? 'text-success'
              : variance < 0
                ? 'text-destructive'
                : 'text-muted-foreground',
        )}
      >
        {variance == null
          ? '—'
          : variance === 0
            ? '0'
            : `${variance > 0 ? '+' : ''}${formatNumber(variance)}`}
      </TableCell>
      <TableCell className={cn(EDGE, 'w-12')}>
        {!disabled && line.counted_quantity != null && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground h-7 w-7"
            onClick={onClear}
            disabled={busy}
            title="Clear count"
            aria-label="Clear count"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

const UNASSIGNED = '__unassigned__';

/**
 * Who the count is assigned to. Manager+ get a Select to pick a member (or
 * unassign) while the count is open; staff, viewers and a closed count show
 * the current assignee's name.
 */
function AssigneePicker({
  cycleCountId,
  currentAssignedTo,
  currentAssigneeName,
  canAssign,
  members,
}: {
  cycleCountId: string;
  currentAssignedTo: string | null;
  currentAssigneeName: string | null;
  canAssign: boolean;
  members: Member[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const labelId = React.useId();

  async function setAssignee(next: string) {
    const nextId = next === UNASSIGNED ? null : next;
    if (nextId === currentAssignedTo) return;
    setBusy(true);
    const res = await assignCycleCountAction({
      id: cycleCountId,
      assignedTo: nextId,
      // Optimistic-concurrency: the page rendered with the current
      // assignee, so pass it as expected. If a teammate changed it
      // between page load and our click, we'll get a clean error.
      expectedAssignee: currentAssignedTo,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(nextId ? 'Cycle count assigned.' : 'Cycle count unassigned.');
    router.refresh();
  }

  // Read-only display for staff/viewers, or when the count is closed.
  if (!canAssign) {
    return (
      <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border px-[18px] py-3 text-[13px]">
        <UserCircle2 aria-hidden className="text-muted-foreground h-4 w-4" />
        <span className="text-muted-foreground">Assigned to:</span>
        <span className="font-medium">{currentAssigneeName ?? 'Unassigned'}</span>
      </div>
    );
  }

  return (
    <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border px-[18px] py-3 text-[13px]">
      <UserCircle2 aria-hidden className="text-muted-foreground h-4 w-4" />
      <span id={labelId} className="text-muted-foreground">
        Assigned to:
      </span>
      <div className="flex min-w-[180px] flex-1 items-center gap-2">
        <Select value={currentAssignedTo ?? UNASSIGNED} onValueChange={setAssignee} disabled={busy}>
          <SelectTrigger aria-labelledby={labelId}>
            <SelectValue placeholder="Pick a member" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {busy && <Loader2 aria-hidden className="text-muted-foreground h-3.5 w-3.5 animate-spin" />}
      </div>
    </div>
  );
}
